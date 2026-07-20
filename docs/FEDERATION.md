# Atrium Federation (Slack Connect-style)

Federation connects workspaces across **independent Atrium servers**: shared
channels, external DMs, and message relay between them. No central directory —
two servers pair directly, like Slack Connect.

## Concepts

- **Connection** — links ONE local workspace to ONE remote Atrium server. Both
  sides store a row (`federation_connections`) holding the same secret pair,
  swapped: each side's `token_out` is the other side's `token_in`.
- **Shared channel** — lives on its **origin** server (`is_shared = 1`). The
  other server holds a **mirror**: a normal local channel with
  `fed_origin_url` / `fed_origin_channel_id` pointing at the origin.
- **Shadow user** — a remote person, materialized locally as a user row with
  `is_remote = 1`, keyed by `(remote_url, remote_id)`, username
  `name@remote-host`. Shadow users author relayed messages and can be
  mentioned/listed like anyone, but have no password and **can never log in**
  (`/auth/login` rejects `is_remote`).
- **fed_ref** — a message's cross-server identity: `"<origin server url>#<origin id>"`.
  Relayed copies store it; it's what dedupe, edit relay, and delete relay key on.
- **Channel link** — `federation_channel_links(channel_id, connection_id,
  remote_channel_id)` maps one side's channel to its counterpart. Each side
  has its own link row; the link table is the source of truth for "may this
  connection post into this channel".

## How connecting works

```
  Server A (origin)                        Server B (initiator)
  ─────────────────                        ────────────────────
  owner: POST /api/v1/federation/invites
    → code (single-use, 7 days)
        │  code + A's URL, given out-of-band  │
        ▼                                     ▼
                        owner: POST /api/v1/federation/connect
                          { workspace_id, code, remote_url: A }
                          generates token_we_accept
                    ◄── POST /fed/v1/handshake ──►
                        { code, url: B, workspace_name, token: token_we_accept }
  verify code (404/410), generate token_they_present,
  store connection { token_out: token_we_accept,      (B's token)
                     token_in:  token_they_present }, consume code
        │                ◄── { ok, token: token_they_present, workspace_name }
        │                                      store connection swapped:
        │                                      { token_out: token_they_present,
        ▼                                        token_in: token_we_accept }
  Both sides now hold the same pair, swapped. The invite code is gone.
```

After that, everything is symmetric: either side can share channels, open
external DMs, and relay traffic, all authenticated with the token pair.

## Security model

- **Invite codes** are `randomToken(12)`, single-use (deleted on redemption),
  expire after 7 days. Creating one requires workspace owner/admin.
- **Connection tokens** are `randomToken(24)` per direction. The receiver of a
  `/fed/v1` call must present the token the *callee* issued at handshake.
- **Every `/fed/v1` call is signed**: `X-Atrium-Signature` is
  HMAC-SHA256(token, `"<unix seconds>.<body>"`) and `X-Atrium-Timestamp` must be
  within ±5 minutes (replay window). Timing-safe comparison throughout.
  The receiver verifies the signature over the **raw request bytes** (captured
  before JSON parsing), so a body tampered with in transit can never verify.
- **HTTPS is required by default**: `assertFederationUrl` rejects plaintext
  `http://` remote URLs — bearer tokens must never cross the wire unencrypted.
  `ATRIUM_ALLOW_LOCAL_FEDERATION=1` lifts this for local dev/tests.
- **Rate limits**: `/fed/v1/handshake` is limited to 10/min per IP (invite
  codes are brute-forceable), all other `/fed/v1/*` to 240/min per connection
  token.
- **SSRF guard**: remote URLs are validated with `assertPublicUrl` at connect
  *and* handshake time (the handshake receiver will POST back to the URL it is
  given), and re-resolved on every outbound call (DNS-rebinding defense).
  Redirects are never followed.
  **`ATRIUM_ALLOW_LOCAL_FEDERATION=1` disables the private-address block** —
  needed for local dev and the smoke test. Never set it in production: any
  workspace admin could then point a connection (and its signed POST traffic)
  at loopback/internal services.
- Shadow users get role `member` and no credentials; the unique partial index
  on `(remote_url, remote_id)` makes shadow upserts idempotent.

## Operator guide

- **`ATRIUM_PUBLIC_URL`** (default `http://localhost:$PORT`) must be the
  public base URL remote servers use to reach *this* server — it is sent in
  the handshake and embedded in every `fed_ref`. If it is wrong, mirrors will
  store garbage origin URLs and relay back-traffic will fail.
- **Reverse proxies**: terminate TLS at the proxy and set
  `ATRIUM_PUBLIC_URL=https://chat.example.com` (no trailing slash — all URLs
  are normalized by stripping trailing `/`). WebSocket upgrade must also be
  proxied for realtime, but federation itself is plain request/response.
- Both servers' clocks must be within ~5 minutes (signed timestamps). Use NTP.
- Disconnecting (`DELETE /api/v1/federation/connections/:id`) removes the
  connection and its channel links; mirror channels stay behind with
  ` (disconnected)` appended to their topic and stop receiving traffic.

## API reference

Errors are `{ ok: false, error: 'snake_case' }`.

### Management API — `/api/v1/federation` (user session auth)

| Endpoint | Role | Description |
|---|---|---|
| `POST /invites` `{ workspace_id }` | owner/admin | → `{ ok, code, server_url }`; single-use, 7-day expiry |
| `POST /connect` `{ workspace_id, code, remote_url }` | owner/admin | Redeem a remote invite. → `{ ok, connection }`. Errors: `invalid_remote_url`, `cannot_connect_to_self`, `already_connected` (409), `invalid_code` (404), `invite_expired` (410), `remote_unreachable` / `handshake_failed` (502) |
| `GET /connections?workspace_id=N` | member | → `{ ok, connections: [{ id, remote_url, remote_workspace_name, status, created_at }] }` (tokens never exposed) |
| `DELETE /connections/:id` | owner/admin | Removes connection + links; mirrors marked ` (disconnected)`; channels with no remaining links drop `is_shared` |
| `POST /share` `{ connection_id, channel_id }` | owner/admin | Shares a local public, non-DM channel. → `{ ok, remote_channel_id }`. Errors: `cannot_share_dm`, `private_channels_cannot_be_shared`, `cannot_share_mirror`, `already_shared` (409), `mirror_failed` (502) |
| `POST /dm` `{ connection_id, remote_username }` | member | Opens an external DM. → `{ ok, channel }` (same shape as `POST /channels/dm`). Errors: `user_not_found` (404), `dm_failed` / `remote_unreachable` (502) |

### Server-to-server receiver — `/fed/v1` (Bearer token + HMAC headers)

All require `Authorization: Bearer <token>`, `X-Atrium-Timestamp`,
`X-Atrium-Signature` — except `/handshake`, where the invite code is the
credential.

| Endpoint | Description |
|---|---|
| `POST /handshake` `{ code, url, workspace_name, token }` | Consumes an invite code, stores the connection, → `{ ok, token, workspace_name }`. Errors: `invalid_code` (404), `invite_expired` (410), `invalid_url` (400) |
| `POST /channels/mirror` `{ channel: {id,name,topic,purpose,is_private}, members: [...] }` | Upserts shadow users, creates the mirror channel (`-ext` suffix on name clash), links it. Idempotent. → `{ ok, channel_id }` |
| `POST /dm` `{ from_user, to_username, channel_id }` | Creates our half of an external DM. → `{ ok, channel_id, user }`. Errors: `user_not_found` (404) |
| `POST /messages` `{ channel_id, message: { fed_ref, user, text, created_at, thread_fed_ref? } }` | Receives a relayed message. → `{ ok }` or `{ ok, deduped: true }` on fed_ref conflict. Unknown parent thread ⇒ posted top-level |
| `POST /messages/update` `{ fed_ref, text, edited_at }` | Updates our copy + WS broadcast. Unknown fed_ref ⇒ `{ ok }` no-op; fed_ref in a channel this connection isn't linked to ⇒ `403 not_allowed` |
| `POST /messages/delete` `{ fed_ref }` | Soft-deletes our copy + WS broadcast. Unknown fed_ref ⇒ `{ ok }` no-op; unlinked ⇒ `403 not_allowed` |

Receiver auth failures are all 401: `missing_token`, `invalid_token`,
`stale_timestamp`, `invalid_signature`.

## Multi-party relay

Mirrors only ever talk to their origin — two mirrors of the same channel are
not connected to each other. So when a channel is shared to **more than one**
server and the **origin** receives a relayed message (or edit/delete) from one
peer, the origin forwards it to every *other* connection sharing that channel,
excluding the source. Loop safety is unchanged: forwarded copies carry
`fed_ref`, so receivers dedupe and the bus relay listener never re-relays
them. A three-server fan-out therefore delivers exactly one copy everywhere.

## How relay works (developer notes)

- `registerFederation()` (called at startup) subscribes to the bus:
  `message.new` / `message.updated` / `message.deleted`.
- Each listener re-reads the message row (the serialized bus payload omits
  `fed_ref`). **A row with `fed_ref` set is a relayed copy and is never
  re-relayed** — that, plus the link-table scoping ("only relay into channels
  the message actually came from"), is the loop safety.
- Fan-out is fire-and-forget with a 5s timeout per connection; failures are
  logged, never retried (the receiver side is idempotent, so a retry by the
  caller is always safe).
- Incoming messages are written with `createMessage({ ..., fedRef, createdAt })`,
  so they keep the origin timestamp, dedupe via the unique `fed_ref` index,
  and flow through the normal WS broadcast + app-platform bus events.
- Edits and deletes key off `fed_ref`, so they work regardless of each side's
  local ids.

## Current limitations

- No relay of presence, typing indicators, reactions, pins, read markers, or
  attachments (text only; link unfurls are recomputed locally per server).
- Mirrors cannot be re-shared onward (no transitive federation), and a channel
  shared to a connection can't be shared again to the same one.
- Deleting a connection does not delete history on either side — mirrors go
  stale (` (disconnected)` topic) but keep their copy of the traffic.
- Relay is best-effort: if the remote is down when a message is posted, that
  message is lost to the mirror (no backfill/sync-on-reconnect yet).
- Membership changes after sharing don't sync the mirror's member list (new
  remote authors are added as channel members when their first message
  arrives, and their shadow is created on demand).
- Deleting a thread parent relays the deletion of the parent AND each reply
  (one delete event per message id).

## Testing

`node scripts/smoke-federation.mjs` spins up two servers (ports 3321/3322,
throwaway data dirs under `/tmp`, `ATRIUM_ALLOW_LOCAL_FEDERATION=1`) and
exercises the whole flow end-to-end: handshake (incl. single-use/expired
codes), sharing, mirrors, shadow users, bidirectional relay, threads, dedupe,
edit/delete relay, external DMs, isolation, and receiver auth rejection.
