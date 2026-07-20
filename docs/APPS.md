# Building apps on Atrium

Atrium's app platform mirrors the Slack model: an **app** belongs to one
workspace and gets a **bot user**, a **bot token**, and a **signing secret**.
With those you can receive events, answer slash commands, and post messages.

Create an app in the UI (*workspace menu → Apps & integrations*) or via
`POST /api/v1/apps`. Only workspace owners/admins can create apps.

## Credentials

| Credential       | Looks like   | Used for                                             |
| ---------------- | ------------ | ---------------------------------------------------- |
| Bot token        | `xatb-…`     | `Authorization: Bearer` on any `/api/v1` endpoint    |
| Signing secret   | hex string   | Verifying `X-Atrium-Signature` on callbacks to you    |
| Webhook URL      | `/hooks/…`   | Posting messages without any auth                    |

Keep the bot token and signing secret server-side only.

## Verifying requests from Atrium

Every callback Atrium sends (events, slash commands) carries:

- `X-Atrium-Timestamp` — unix seconds
- `X-Atrium-Signature` — hex HMAC-SHA256 of `` `${timestamp}.${rawBody}` `` keyed with your signing secret

Verify before trusting the payload, and reject timestamps older than ~5 minutes:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret, req, rawBody) {
  const ts = req.headers['x-atrium-timestamp'];
  const sig = req.headers['x-atrium-signature'];
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(String(sig)));
}
```

## Incoming webhooks (easiest)

One-way posting into a channel — no auth beyond the URL itself:

```bash
curl -X POST http://localhost:3000/hooks/<token> \
  -H 'Content-Type: application/json' \
  -d '{"text": "Deploy to production finished ✅"}'
```

Create via UI (Apps → Manage → Incoming webhook) or
`POST /api/v1/apps/:id/webhooks { channel_id }`.

## Slash commands

Register `/mycommand` → your `url`. Commands are unique per workspace: if a
different app already owns the name, registration fails with `409 command_taken`
(re-registering your own updates it). When someone types `/mycommand deploy now`,
Atrium POSTs (signed):

```json
{
  "type": "slash_command", "command": "/mycommand", "text": "deploy now",
  "user_id": 1, "user_name": "ada", "channel_id": 3, "channel_name": "eng",
  "workspace_id": 1, "timestamp": 1784405406075
}
```

Respond **within 3 seconds** with JSON:

```json
{ "text": "Deploy queued 🚀", "response_type": "in_channel" }
```

- `in_channel` (default) — posted to the channel as your bot.
- `ephemeral` — delivered over the socket to the invoking user only, not persisted.

For delayed work (CI status, long jobs), answer immediately and post later with
the bot token: `POST /api/v1/channels/:id/messages`.

## Events API

Set the app's **request URL** and subscribe to events. Atrium POSTs (signed):

```json
{
  "type": "event", "event": "message.channels", "workspace_id": 1,
  "data": { "message": { … }, "channel": { … } }, "timestamp": 1784405406075
}
```

| Event              | Fires when                                            |
| ------------------ | ----------------------------------------------------- |
| `message.channels` | A message is posted in a channel your bot is in       |
| `message.im`       | A message is posted in a DM your bot is part of       |
| `message.updated`  | A message is edited (bot's channels)                  |
| `message.deleted`  | A message is deleted (bot's channels)                 |
| `reaction.added`   | A reaction is added                                   |
| `reaction.removed` | A reaction is removed                                 |
| `channel.created`  | A channel is created (private channels: bot must be in)|
| `app_mention`      | Someone @-mentions your bot's username                |

Message events are scoped to channels your bot is a member of — apps can never
eavesdrop on conversations they haven't joined. Add your bot to channels from
the channel's ⋯ menu (or `POST /channels/:id/members` as an admin).

Respond `200` quickly. Failed deliveries (network errors, timeouts) are
retried twice with backoff; 4xx/5xx responses are not retried.

## Bots calling the REST API

The bot token works anywhere a user token does, scoped to its workspace:

```bash
curl -X POST http://localhost:3000/api/v1/channels/3/messages \
  -H 'Authorization: Bearer xatb-…' \
  -H 'Content-Type: application/json' \
  -d '{"text": "bot speaking"}'
```

Bots can also open a realtime socket at `/ws?token=xatb-…` and receive the
same events users do — handy for bridging.

## Full example

[`examples/echo-bot.js`](../examples/echo-bot.js) implements:

- a `/echo` slash command (verifies the signature, echoes the text back)
- an `app_mention` handler that replies when you @ the bot
- posting via bot token

```bash
cd examples
ATRIUM_URL=http://localhost:3000 \
BOT_TOKEN=xatb-… \
SIGNING_SECRET=… \
node echo-bot.js
```

Then register its commands against the bot's URL, e.g.
`POST /api/v1/apps/:id/commands { "command": "echo", "url": "http://localhost:4000/atrium" }`.

## Guidelines for app authors

- Always verify signatures — callback URLs are otherwise unauthenticated.
- Answer slash commands fast; defer heavy work.
- Bots are auto-joined to any channel where their webhook or slash-command
  response posts. For other channels, have the bot `POST /channels/:id/join`
  (public channels) or ask a human to invite it (private).
- Rotate the bot token with `POST /apps/:id/rotate-token` if it leaks.
