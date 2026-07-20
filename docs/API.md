# Atrium API reference

Base URL: `/api/v1`. All requests and responses are JSON. Errors are
`{ "ok": false, "error": "snake_case_code" }` with an appropriate HTTP status.

## Authentication

Send `Authorization: Bearer <token>` with either a **user session token**
(from login/register) or a **bot token** (`xatb-…`, see [APPS.md](APPS.md)).
Bot tokens are scoped to the app's workspace.

### `GET /setup` (unauthenticated)
→ `{ ok, needs_setup }` — `needs_setup` is true until the first human account exists; the client shows the first-run setup wizard.

### `GET /health` (unauthenticated)
→ `{ ok, name: "atrium", version }`

### `POST /auth/register`
`{ username, password, email?, display_name? }` → `{ ok, token, user }`
Username: 2–32 chars `[a-z0-9_.-]`. Password ≥ 8 chars. If the server sets
`ATRIUM_DISABLE_REGISTRATION=1`, registration is closed (`403 registration_closed`)
once the first human account exists (first-run setup always works).

### `POST /auth/login`
`{ username, password }` → `{ ok, token, user }` (`username` may be an email).

### `POST /auth/logout` — invalidates the current token.
### `GET /auth/me` → `{ ok, user }`

### `POST /auth/change-password`
`{ current_password, new_password }` → `{ ok }`
Verifies the current password (`403 invalid_current_password`), requires the new
one to be ≥ 8 chars, and destroys all OTHER sessions for the user (the token used
for the call stays valid). Rate limited to 10/min.

## Workspaces

### `GET /workspaces` → `{ ok, workspaces }` — workspaces you belong to.
### `POST /workspaces` `{ name, icon? }` → `{ ok, workspace }`
Creates the workspace, makes you `owner`, and creates `#general`.

### `GET /workspaces/:id` → `{ ok, workspace, members, my_role }`
### `PATCH /workspaces/:id` `{ name?, icon?, allowed_domains? }` → `{ ok, workspace }` — owner/admin.
`allowed_domains` is a comma-separated domain list (`acme.com, acme.io`): any user
who registers (or logs in) with an email at one of those domains joins the
workspace automatically, landing in its oldest public channel. See the security
note below — there is no email verification, so this trusts the claimed address.

### `GET /workspaces/:id/invites` → `{ ok, invites }` — owner/admin. Each invite: `{ code, url, max_uses, uses, expires_at, created_at }`.
### `POST /workspaces/:id/invites` `{ max_uses?, expires_in_hours? }` → `{ ok, invite: { code, url } }`
`max_uses: 1` = one-time link; `max_uses: 0` (default) = infinite link. Share
`{origin}{url}` — opening it joins the signed-in user (after sign-in if needed).
### `DELETE /workspaces/:id/invites/:code` — revoke (owner/admin).
### `POST /workspaces/join` `{ code }` → `{ ok, workspace }`

Roles: `owner`, `admin`, `member`. Owners/admins can delete any message and manage apps.

### `PATCH /workspaces/:id/members/:userId` `{ role: 'admin' | 'member' }` → `{ ok, member }`
Owner only. You cannot change your own role (`400 cannot_change_own_role`), and the
last remaining owner cannot be demoted (`400 cannot_demote_last_owner`).

### `DELETE /workspaces/:id/members/:userId` → `{ ok }`
Kicks a member (owner/admin; owners can't be kicked, admins can't kick other admins)
or removes yourself (leave). Also removes their channel memberships in this workspace
and broadcasts `workspace.member_left`.

## Users

### `GET /users?workspace_id=N` → `{ ok, users }` — includes live `online` flags.
### `PATCH /users/me` `{ display_name?, status_text?, avatar_url? }` → `{ ok, user }`

## Channels

### `GET /channels?workspace_id=N` → `{ ok, channels }`
Each channel carries client state: `is_member`, `member_count`, `unread_count`,
`mention_count`, `last_read_id`, and for DMs `dm_users`.

### `POST /channels` `{ workspace_id, name, topic?, purpose?, is_private? }` → `{ ok, channel }`
### `GET /channels/:id` → `{ ok, channel }`
### `PATCH /channels/:id` `{ name?, topic?, purpose?, is_archived? }` → `{ ok, channel }`
Requires channel membership or workspace admin for any field. Rename: channel creator or
workspace admin. Archive: admin. Archived channels reject new posts (`400 channel_archived`).
### `POST /channels/:id/join` — public channels only.
### `POST /channels/:id/leave`
### `GET /channels/:id/members` → `{ ok, members }`
### `POST /channels/:id/members` `{ user_id }` — add a member (private: members/admins; public: any workspace member; bots: admin only).
### `DELETE /channels/:id/members/:userId` — remove (self, or admin).
### `POST /channels/:id/read` `{ message_id }` — advances your read marker (clamped to the channel's latest message).
### `GET /channels/:id/pins` → `{ ok, pins }` — full message objects.
### `POST /channels/:id/star` / `POST /channels/:id/mute` → `{ ok, starred }` / `{ ok, muted }` — toggles; muted channels produce no badges or notifications.

### `POST /channels/dm` `{ workspace_id, user_ids: […] }` → `{ ok, channel }`
Opens (or returns) the DM containing exactly you + those users (max 9 total). DMs are
deduplicated server-side. Remote (federated) users are rejected with
`400 use_external_dm` — open those via `POST /federation/dm` instead.

## Messages

### `GET /channels/:id/messages?before=<id>&after=<id>&around=<id>&limit=<n>` → `{ ok, messages, has_more }`
Top-level messages (no thread replies), ascending within the page, max 100.
Page backwards with `before = <oldest id you have>`, catch up with `after = <newest id you have>`,
or center a page on a specific message with `around = <id>` (returns `has_more_before`/`has_more_after`).

### `POST /channels/:id/messages` `{ text, thread_id?, attachments? }` → `{ ok, message }`
Posting to a public channel auto-joins you. If `text` starts with a registered
`/slash-command`, it's routed to the app platform instead of being posted.

Mentions: `@username` resolves against workspace members (federated shadow users
included, e.g. `@name@remote-host`). Broadcast mentions widen the reach:
`@channel` / `@everyone` mention every channel member, `@here` only the members
currently online. A message's `mentions` array is the union of all of these.

Attachments: `[{ url, name, size, mimetype }]` — upload files first via `POST /upload`.
`url` may also be an external `http(s)` link (kept with its declared mimetype;
clients render external files as cards, not inline images). `{ type: 'link' }`
attachments are never accepted from clients — link unfurls are added by the server.

### `GET /messages/:id/thread` → `{ ok, parent, messages }`
### `PATCH /messages/:id` `{ text }` — author only.
### `DELETE /messages/:id` — author, or workspace owner/admin.
### `POST /messages/:id/reactions` `{ emoji }` — toggles your reaction.
### `POST /messages/:id/pin` — toggles pin in the message's channel.

Message shape:

```json
{
  "id": 42, "channel_id": 3,
  "user": { "id": 1, "username": "ada", "display_name": "Ada", "avatar_url": null, "is_bot": 0 },
  "text": "hello **world**", "thread_id": null, "reply_count": 2,
  "attachments": [], "mentions": [2],
  "reactions": [{ "emoji": "👍", "count": 1, "users": [2], "reacted": false }],
  "pinned": false, "edited_at": null, "created_at": 1784405406075
}
```

## Search

### `GET /search?workspace_id=N&q=text` → `{ ok, results }`
Full-text search (SQLite FTS5) over messages you can see, newest first, 50 max.
Supports filters: `from:username`, `in:channel-name`. Each result includes
`channel_name` and a `snippet` with `<mark>`-highlighted matches (safe HTML).
Jump to a hit with `GET /channels/:id/messages?around=<message_id>`.

## Saved messages & emoji

### `POST /users/me/saved` `{ message_id }` / `DELETE /users/me/saved/:messageId`
### `GET /users/me/saved?workspace_id=N` → `{ ok, saved }` — messages with `channel_name`.

### `GET /workspaces/:id/emoji` → `{ ok, emoji: [{ name, url }] }`
### `POST /workspaces/:id/emoji` `{ name, url }` — name `[a-z0-9_+-]{1,32}`, url must be an `/uploads/` path (upload an image first).
### `DELETE /workspaces/:id/emoji/:name` — uploader or workspace admin.

## Uploads

### `POST /upload` — `multipart/form-data`, field `files` (≤ 5, ≤ 25 MB each)
→ `{ ok, files: [{ url, name, size, mimetype }] }`

## Realtime (WebSocket)

Connect: `ws(s)://<host>/ws?token=<token>` (user session or bot token).

First frame: `{ "type": "hello", "user_id", "server_time" }`.
Send `{ "type": "typing", "channel_id" }` to broadcast typing.

Events pushed to relevant channel/workspace members:

| Type                  | Payload                                   |
| --------------------- | ----------------------------------------- |
| `message.new`         | `{ workspace_id, message }`               |
| `message.updated`     | `{ workspace_id, message }` (edits, reactions, pins) |
| `message.deleted`     | `{ id, channel_id }`                      |
| `message.ephemeral`   | `{ channel_id, text, app_id }` (you only) |
| `typing`              | `{ channel_id, user_id, display_name }`   |
| `presence`            | `{ user_id, online }`                     |
| `channel.created`     | `{ channel }` (personalized to you)       |
| `channel.updated`     | `{ channel }`                             |
| `channel.member_joined` / `channel.member_left` | `{ channel_id, user_id }` |
| `workspace.member_joined` | `{ workspace_id, user }`              |
| `workspace.member_left` | `{ workspace_id, user_id }`             |
| `user.updated`        | `{ user }` (profile changes)              |

## Federation

Server-to-server federation (shared channels, external DMs) lives under
`/api/v1/federation` (management) and `/fed/v1` (signed server-to-server
receiver). Full protocol and setup guide: [FEDERATION.md](FEDERATION.md).

## App management

All under `/apps` — see [APPS.md](APPS.md) for the full guide.

| Method & path                          | Purpose                          |
| -------------------------------------- | -------------------------------- |
| `GET/POST /apps`                       | list / create (admin)            |
| `PATCH/DELETE /apps/:id`               | update / delete (bot deactivated)|
| `POST /apps/:id/rotate-token`          | new bot token                    |
| `POST /apps/:id/rotate-secret`         | new signing secret               |
| `GET/POST/DELETE /apps/:id/webhooks…`  | incoming webhooks                |
| `GET/POST/DELETE /apps/:id/commands…`  | slash commands                   |
| `GET/POST/DELETE /apps/:id/subscriptions…` | events API subscriptions     |
| `POST /hooks/:token`                   | **public** webhook receiver      |

Event names for subscriptions: `message.channels`, `message.im`,
`message.updated`, `message.deleted`, `reaction.added`, `reaction.removed`,
`channel.created`, `app_mention`. Message events — and `app_mention` — only
deliver for channels where the app's bot is a member. Slash commands are
unique per workspace: registering one another app already owns fails with
`409 command_taken`.
