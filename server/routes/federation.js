// Federation routes.
// federationRouter: authenticated management API under /api/v1/federation.
// fedRouter: server-to-server receiver under /fed/v1 (token + HMAC authed).
// The engine (signing, shadow users, relay fan-out) lives in ../federation.js.
import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { get, all, run, now, transaction } from '../db.js';
import { authenticate, randomToken, signPayload } from '../auth.js';
import { sendError, workspaceMember, ah } from '../lib/guards.js';
import { broadcastToChannel, broadcastToWorkspace } from '../realtime.js';
import { createMessage, serializeMessage } from '../lib/messages.js';
import { rateLimit } from '../lib/ratelimit.js';
import {
  myPublicUrl, normalizeUrl, assertFederationUrl, fedCall, upsertShadowUser,
} from '../federation.js';

export const federationRouter = Router();
export const fedRouter = Router();

const INVITE_TTL_MS = 7 * 24 * 3600_000; // 7 days
const FED_SKEW_MS = 5 * 60 * 1000;       // timestamp window for signed calls

function requireWorkspaceRole(req, res, workspaceId, roles) {
  const member = workspaceMember(req, workspaceId);
  if (!member) { sendError(res, 403, 'not_a_member'); return null; }
  if (roles && !roles.includes(member.role)) { sendError(res, 403, 'not_allowed'); return null; }
  return member;
}

const publicConnection = (c) => ({
  id: c.id,
  remote_url: c.remote_url,
  remote_workspace_name: c.remote_workspace_name,
  status: c.status,
  created_at: c.created_at,
});

// Same shape routes/channels.js returns for DMs (channelWithState).
function dmChannelPayload(viewerId, channel) {
  const { dm_key, ...rest } = channel;
  return {
    ...rest,
    is_member: true,
    starred: false,
    muted: false,
    member_count: get('SELECT COUNT(*) AS c FROM channel_members WHERE channel_id = ?', channel.id).c,
    last_read_id: 0,
    unread_count: 0,
    mention_count: 0,
    dm_users: all(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_remote, u.remote_url
       FROM channel_members cm
       JOIN users u ON u.id = cm.user_id WHERE cm.channel_id = ? AND u.id != ?`,
      channel.id, viewerId
    ),
  };
}

// Sanitized channel JSON for WS fan-out of a locally-created mirror: no
// dm_key ever crosses the wire, and mirrors are public in their workspace so
// a single non-personalized payload is enough.
function mirrorChannelPayload(channel) {
  const { dm_key, ...rest } = channel;
  return {
    ...rest,
    is_member: false,
    member_count: get('SELECT COUNT(*) AS c FROM channel_members WHERE channel_id = ?', channel.id).c,
  };
}

// ---- management API (/api/v1/federation) ------------------------------------

federationRouter.use(authenticate);

// POST /invites { workspace_id } — create a single-use connect code (7 days).
federationRouter.post('/invites', (req, res) => {
  const workspaceId = Number(req.body?.workspace_id);
  if (!requireWorkspaceRole(req, res, workspaceId, ['owner', 'admin'])) return;
  const code = randomToken(12);
  run(
    'INSERT INTO federation_invites (code, workspace_id, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    code, workspaceId, req.user.id, now() + INVITE_TTL_MS, now()
  );
  res.json({ ok: true, code, server_url: myPublicUrl() });
});

// POST /connect { workspace_id, code, remote_url } — redeem another server's
// invite code. Performs the handshake and stores the connection on our side.
federationRouter.post('/connect', ah(async (req, res) => {
  const workspaceId = Number(req.body?.workspace_id);
  const code = String(req.body?.code || '').trim();
  const remoteUrl = normalizeUrl(req.body?.remote_url);
  if (!workspaceId || !code || !remoteUrl) return sendError(res, 400, 'missing_fields');
  if (!requireWorkspaceRole(req, res, workspaceId, ['owner', 'admin'])) return;

  try {
    await assertFederationUrl(remoteUrl);
  } catch {
    return sendError(res, 400, 'invalid_remote_url');
  }
  if (remoteUrl === myPublicUrl()) return sendError(res, 400, 'cannot_connect_to_self');
  if (get('SELECT 1 FROM federation_connections WHERE workspace_id = ? AND remote_url = ?', workspaceId, remoteUrl)) {
    return sendError(res, 409, 'already_connected');
  }

  const workspace = get('SELECT * FROM workspaces WHERE id = ?', workspaceId);
  const tokenWeAccept = randomToken(24);
  let result;
  try {
    const body = JSON.stringify({
      code, url: myPublicUrl(), workspace_name: workspace.name, token: tokenWeAccept,
    });
    const resp = await fetch(`${remoteUrl}/fed/v1/handshake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
    result = { status: resp.status, data: await resp.json().catch(() => ({})) };
  } catch {
    return sendError(res, 502, 'remote_unreachable');
  }
  if (result.status === 404) return sendError(res, 404, 'invalid_code');
  if (result.status === 410) return sendError(res, 410, 'invite_expired');
  if (!result.data?.ok || !result.data?.token) return sendError(res, 502, 'handshake_failed');

  try {
    run(
      `INSERT INTO federation_connections (workspace_id, remote_url, remote_workspace_name, token_out, token_in, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
      workspaceId, remoteUrl, String(result.data.workspace_name || ''),
      String(result.data.token), tokenWeAccept, now()
    );
  } catch {
    return sendError(res, 409, 'already_connected'); // unique (workspace_id, remote_url)
  }
  const conn = get(
    'SELECT * FROM federation_connections WHERE workspace_id = ? AND remote_url = ?',
    workspaceId, remoteUrl
  );
  res.json({ ok: true, connection: publicConnection(conn) });
}));

// GET /connections?workspace_id=N — any workspace member.
federationRouter.get('/connections', (req, res) => {
  const workspaceId = Number(req.query.workspace_id);
  if (!requireWorkspaceRole(req, res, workspaceId, null)) return;
  const connections = all(
    'SELECT * FROM federation_connections WHERE workspace_id = ? ORDER BY created_at', workspaceId
  );
  res.json({ ok: true, connections: connections.map(publicConnection) });
});

// DELETE /connections/:id — owner/admin. Links die via ON DELETE CASCADE;
// mirror channels stay behind, marked stale in their topic. Channels left
// with no links at all stop counting as shared.
federationRouter.delete('/connections/:id', (req, res) => {
  const conn = get('SELECT * FROM federation_connections WHERE id = ?', req.params.id);
  if (!conn) return sendError(res, 404, 'connection_not_found');
  if (!requireWorkspaceRole(req, res, conn.workspace_id, ['owner', 'admin'])) return;
  transaction(() => {
    run(
      `UPDATE channels SET topic = topic || ' (disconnected)'
       WHERE workspace_id = ? AND fed_origin_url = ? AND instr(topic, '(disconnected)') = 0`,
      conn.workspace_id, conn.remote_url
    );
    const linked = all(
      'SELECT channel_id FROM federation_channel_links WHERE connection_id = ?', conn.id
    ).map(r => r.channel_id);
    run('DELETE FROM federation_connections WHERE id = ?', conn.id);
    for (const channelId of linked) {
      run(
        `UPDATE channels SET is_shared = 0
         WHERE id = ? AND NOT EXISTS (SELECT 1 FROM federation_channel_links WHERE channel_id = ?)`,
        channelId, channelId
      );
    }
  });
  res.json({ ok: true });
});

// POST /share { connection_id, channel_id } — share a local channel into the
// remote workspace (they create a mirror). Owner/admin only.
federationRouter.post('/share', ah(async (req, res) => {
  const conn = get('SELECT * FROM federation_connections WHERE id = ?', Number(req.body?.connection_id));
  if (!conn) return sendError(res, 404, 'connection_not_found');
  if (conn.status !== 'active') return sendError(res, 409, 'connection_inactive');
  if (!requireWorkspaceRole(req, res, conn.workspace_id, ['owner', 'admin'])) return;

  const channel = get('SELECT * FROM channels WHERE id = ?', Number(req.body?.channel_id));
  if (!channel || channel.workspace_id !== conn.workspace_id) return sendError(res, 404, 'channel_not_found');
  if (channel.is_dm) return sendError(res, 400, 'cannot_share_dm');
  // Private channels stay private: a mirror would be public on the remote.
  if (channel.is_private) return sendError(res, 400, 'private_channels_cannot_be_shared');
  if (channel.fed_origin_url) return sendError(res, 400, 'cannot_share_mirror');
  if (get('SELECT 1 FROM federation_channel_links WHERE channel_id = ? AND connection_id = ?', channel.id, conn.id)) {
    return sendError(res, 409, 'already_shared');
  }

  const members = all(
    `SELECT u.id, u.username, u.display_name, u.avatar_url
     FROM channel_members cm JOIN users u ON u.id = cm.user_id
     WHERE cm.channel_id = ? AND u.is_remote = 0`, channel.id
  );
  let result;
  try {
    result = await fedCall(conn, '/fed/v1/channels/mirror', {
      channel: {
        id: channel.id, name: channel.name, topic: channel.topic,
        purpose: channel.purpose, is_private: !!channel.is_private,
      },
      members,
    });
  } catch {
    return sendError(res, 502, 'remote_unreachable');
  }
  if (!result.data?.ok || result.data?.channel_id == null) {
    return sendError(res, 502, 'mirror_failed');
  }

  transaction(() => {
    run('UPDATE channels SET is_shared = 1 WHERE id = ?', channel.id);
    run(
      'INSERT INTO federation_channel_links (channel_id, connection_id, remote_channel_id) VALUES (?, ?, ?)',
      channel.id, conn.id, Number(result.data.channel_id)
    );
  });
  res.json({ ok: true, remote_channel_id: Number(result.data.channel_id) });
}));

// POST /dm { connection_id, remote_username } — open an external DM. Any
// workspace member. Creates the local half first, then asks the remote to
// create its half; the two are linked like a shared channel.
federationRouter.post('/dm', ah(async (req, res) => {
  const conn = get('SELECT * FROM federation_connections WHERE id = ?', Number(req.body?.connection_id));
  if (!conn) return sendError(res, 404, 'connection_not_found');
  if (conn.status !== 'active') return sendError(res, 409, 'connection_inactive');
  if (!requireWorkspaceRole(req, res, conn.workspace_id, null)) return;

  const remoteUsername = String(req.body?.remote_username || '').trim();
  if (!remoteUsername) return sendError(res, 400, 'username_required');

  const created = run(
    `INSERT INTO channels (workspace_id, name, is_private, is_dm, dm_key, created_by, created_at)
     VALUES (?, 'dm', 1, 1, NULL, ?, ?)`,
    conn.workspace_id, req.user.id, now()
  );
  const localId = Number(created.lastInsertRowid);

  let result = null;
  try {
    result = await fedCall(conn, '/fed/v1/dm', {
      from_user: {
        id: req.user.id, username: req.user.username,
        display_name: req.user.display_name, avatar_url: req.user.avatar_url,
      },
      to_username: remoteUsername,
      channel_id: localId,
    });
  } catch { /* treated as unreachable below */ }
  if (!result?.data?.ok || result.data.channel_id == null || !result.data.user) {
    run('DELETE FROM channels WHERE id = ?', localId); // don't orphan the local half
    if (result?.data?.error === 'user_not_found') return sendError(res, 404, 'user_not_found');
    return sendError(res, 502, result ? 'dm_failed' : 'remote_unreachable');
  }

  transaction(() => {
    const shadow = upsertShadowUser(conn, result.data.user);
    run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)', localId, req.user.id, now());
    run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)', localId, shadow.id, now());
    run(
      'INSERT INTO federation_channel_links (channel_id, connection_id, remote_channel_id) VALUES (?, ?, ?)',
      localId, conn.id, Number(result.data.channel_id)
    );
  });
  const channel = get('SELECT * FROM channels WHERE id = ?', localId);
  broadcastToChannel(localId, { type: 'channel.created', channel: dmChannelPayload(req.user.id, channel) });
  res.json({ ok: true, channel: dmChannelPayload(req.user.id, channel) });
}));

// ---- server-to-server receiver (/fed/v1) -------------------------------------

// Handshakes are brute-forceable (the invite code is the only credential), so
// they're rate-limited per IP; authenticated federation traffic is limited
// per connection token.
const handshakeLimiter = rateLimit({ windowMs: 60_000, max: 10 });
const fedTrafficLimiter = rateLimit({
  windowMs: 60_000,
  max: 240,
  keyFn: req => (req.headers.authorization || '').replace(/^Bearer /, ''),
});

// The invite code is the credential for the handshake itself — this route
// runs before fedAuth. Everything below it requires a live connection.
// The code is checked BEFORE any URL parsing/DNS: an attacker probing codes
// must not get SSRF validation work out of us.
fedRouter.post('/handshake', handshakeLimiter, ah(async (req, res) => {
  const { code, url, workspace_name, token } = req.body || {};
  if (!code || !url || !token) return sendError(res, 400, 'missing_fields');
  const invite = get('SELECT * FROM federation_invites WHERE code = ?', String(code));
  if (!invite) return sendError(res, 404, 'invalid_code');
  if (invite.expires_at && invite.expires_at < now()) return sendError(res, 410, 'invite_expired');

  const remoteUrl = normalizeUrl(url);
  try {
    await assertFederationUrl(remoteUrl); // we will POST back to this URL later
  } catch {
    return sendError(res, 400, 'invalid_url');
  }
  if (remoteUrl === myPublicUrl()) return sendError(res, 400, 'cannot_connect_to_self');

  const tokenTheyPresent = randomToken(24);
  const workspace = get('SELECT * FROM workspaces WHERE id = ?', invite.workspace_id);
  transaction(() => {
    // Re-handshaking replaces any stale connection to the same server.
    run('DELETE FROM federation_connections WHERE workspace_id = ? AND remote_url = ?', invite.workspace_id, remoteUrl);
    run(
      `INSERT INTO federation_connections (workspace_id, remote_url, remote_workspace_name, token_out, token_in, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
      invite.workspace_id, remoteUrl, String(workspace_name || '').slice(0, 80),
      String(token), tokenTheyPresent, now()
    );
    run('DELETE FROM federation_invites WHERE code = ?', String(code)); // single use
  });
  res.json({ ok: true, token: tokenTheyPresent, workspace_name: workspace.name });
}));

// Connection auth: Bearer token_in + fresh timestamp + HMAC signature over the
// raw request bytes (captured by the express.json verify hook for /fed/*), so
// a body tampered with in transit can never verify. JSON.stringify(parsed
// body) is only a fallback for bodies that arrived without the raw capture.
fedRouter.use(fedTrafficLimiter);
fedRouter.use((req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return sendError(res, 401, 'missing_token');
  const conn = get(
    "SELECT * FROM federation_connections WHERE token_in = ? AND status = 'active'", token
  );
  if (!conn) return sendError(res, 401, 'invalid_token');

  const tsHeader = String(req.headers['x-atrium-timestamp'] || '');
  const ts = Number(tsHeader);
  if (!tsHeader || !Number.isFinite(ts) || Math.abs(now() - ts * 1000) > FED_SKEW_MS) {
    return sendError(res, 401, 'stale_timestamp');
  }
  const signed = typeof req.rawBody === 'string' ? req.rawBody : JSON.stringify(req.body ?? {});
  const signature = Buffer.from(String(req.headers['x-atrium-signature'] || ''), 'utf8');
  const expected = Buffer.from(signPayload(token, tsHeader, signed), 'utf8');
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
    return sendError(res, 401, 'invalid_signature');
  }
  req.fedConnection = conn;
  next();
});

// POST /channels/mirror — create our mirror of their shared channel.
// Idempotent: a retried share returns the existing mirror.
fedRouter.post('/channels/mirror', (req, res) => {
  const conn = req.fedConnection;
  const ch = req.body?.channel;
  if (!ch || ch.id == null || !ch.name) return sendError(res, 400, 'missing_fields');

  const existing = get(
    'SELECT * FROM channels WHERE fed_origin_url = ? AND fed_origin_channel_id = ?',
    conn.remote_url, Number(ch.id)
  );
  if (existing) return res.json({ ok: true, channel_id: existing.id });

  const nameTaken = (name) => get(
    'SELECT 1 FROM channels WHERE workspace_id = ? AND name = ? AND is_dm = 0', conn.workspace_id, name
  );
  const base = String(ch.name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 76) || 'external';
  let name = nameTaken(base) ? `${base}-ext` : base;
  for (let n = 2; nameTaken(name); n++) name = `${base}-ext-${n}`;

  const owner = get('SELECT created_by FROM workspaces WHERE id = ?', conn.workspace_id);
  const members = Array.isArray(req.body?.members) ? req.body.members : [];
  const mirrorId = transaction(() => {
    const result = run(
      `INSERT INTO channels (workspace_id, name, topic, purpose, is_private, is_dm, created_by, fed_origin_url, fed_origin_channel_id, created_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
      conn.workspace_id, name, String(ch.topic || '').slice(0, 250),
      String(ch.purpose || '').slice(0, 250), owner.created_by, conn.remote_url, Number(ch.id), now()
    );
    const id = Number(result.lastInsertRowid);
    for (const m of members) {
      if (!m || m.id == null || !m.username) continue;
      const shadow = upsertShadowUser(conn, m);
      run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)', id, shadow.id, now());
    }
    run(
      'INSERT INTO federation_channel_links (channel_id, connection_id, remote_channel_id) VALUES (?, ?, ?)',
      id, conn.id, Number(ch.id)
    );
    return id;
  });

  broadcastToWorkspace(conn.workspace_id, {
    type: 'channel.created',
    channel: mirrorChannelPayload(get('SELECT * FROM channels WHERE id = ?', mirrorId)),
  });
  res.json({ ok: true, channel_id: mirrorId });
});

// POST /dm — their user opened an external DM with one of our users.
fedRouter.post('/dm', (req, res) => {
  const conn = req.fedConnection;
  const fromUser = req.body?.from_user;
  const toUsername = String(req.body?.to_username || '');
  const remoteChannelId = Number(req.body?.channel_id);
  if (!fromUser?.username || fromUser.id == null || !toUsername || !remoteChannelId) {
    return sendError(res, 400, 'missing_fields');
  }

  const localUser = get(
    'SELECT * FROM users WHERE username = ? AND is_remote = 0 AND is_deactivated = 0', toUsername
  );
  if (!localUser || !get(
    'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?', conn.workspace_id, localUser.id
  )) {
    return sendError(res, 404, 'user_not_found');
  }
  const localUserPayload = {
    id: localUser.id, username: localUser.username,
    display_name: localUser.display_name, avatar_url: localUser.avatar_url,
  };

  const existing = get(
    'SELECT * FROM channels WHERE fed_origin_url = ? AND fed_origin_channel_id = ?',
    conn.remote_url, remoteChannelId
  );
  if (existing) return res.json({ ok: true, channel_id: existing.id, user: localUserPayload });

  const dmId = transaction(() => {
    const shadow = upsertShadowUser(conn, fromUser);
    const result = run(
      `INSERT INTO channels (workspace_id, name, is_private, is_dm, dm_key, created_by, fed_origin_url, fed_origin_channel_id, created_at)
       VALUES (?, 'dm', 1, 1, NULL, ?, ?, ?, ?)`,
      conn.workspace_id, localUser.id, conn.remote_url, remoteChannelId, now()
    );
    const id = Number(result.lastInsertRowid);
    run('INSERT INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)', id, localUser.id, now());
    run('INSERT INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)', id, shadow.id, now());
    run(
      'INSERT INTO federation_channel_links (channel_id, connection_id, remote_channel_id) VALUES (?, ?, ?)',
      id, conn.id, remoteChannelId
    );
    return id;
  });

  broadcastToChannel(dmId, {
    type: 'channel.created',
    channel: dmChannelPayload(localUser.id, get('SELECT * FROM channels WHERE id = ?', dmId)),
  });
  res.json({ ok: true, channel_id: dmId, user: localUserPayload });
});

// The channel a remote posts into must be one this connection is linked to —
// the link table is the source of truth for both directions (our origin ↔
// their mirror, their origin ↔ our mirror, and both halves of external DMs).
function linkedChannel(conn, channelId) {
  return get(
    `SELECT c.* FROM channels c
     JOIN federation_channel_links l ON l.channel_id = c.id AND l.connection_id = ?
     WHERE c.id = ? AND c.workspace_id = ?`,
    conn.id, channelId, conn.workspace_id
  );
}

// Multi-party relay: when this server is the channel's ORIGIN (shared out,
// no origin pointer of its own), traffic arriving from one linked peer must
// be forwarded to the OTHER peers — mirrors aren't connected to each other.
// Loop safety: forwarded copies carry fed_ref, so receivers dedupe and the
// bus relay listener never re-relays them.
function forwardToOtherPeers(conn, channel, path, buildPayload) {
  if (channel.fed_origin_url || !channel.is_shared) return;
  const links = all(
    `SELECT l.remote_channel_id, c.remote_url, c.token_out
     FROM federation_channel_links l
     JOIN federation_connections c ON c.id = l.connection_id
     WHERE l.channel_id = ? AND c.status = 'active' AND l.connection_id != ?`,
    channel.id, conn.id
  );
  for (const link of links) {
    fedCall({ remote_url: link.remote_url, token_out: link.token_out }, path, buildPayload(link))
      .catch(err => console.warn(`federation forward to ${link.remote_url}${path} failed: ${err.message}`));
  }
}

// POST /messages — receive a relayed message.
fedRouter.post('/messages', (req, res) => {
  const conn = req.fedConnection;
  const m = req.body?.message;
  const channelId = Number(req.body?.channel_id);
  if (!m?.fed_ref || !m.user?.username || m.user.id == null || !channelId) {
    return sendError(res, 400, 'missing_fields');
  }
  if (get('SELECT 1 FROM messages WHERE fed_ref = ?', String(m.fed_ref))) {
    return res.json({ ok: true, deduped: true });
  }
  const channel = linkedChannel(conn, channelId);
  if (!channel) return sendError(res, 404, 'channel_not_found');

  const author = upsertShadowUser(conn, m.user);
  // Joined-after-share authors may not be channel members yet.
  run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)', channel.id, author.id, now());

  let threadId = null;
  if (m.thread_fed_ref) {
    // Parent not relayed (yet)? Post top-level rather than dropping.
    threadId = get('SELECT id FROM messages WHERE fed_ref = ?', String(m.thread_fed_ref))?.id ?? null;
  }
  // createMessage broadcasts + emits bus events; the relay listener skips
  // re-relaying because fed_ref is set (loop safety).
  createMessage({
    channelId: channel.id,
    userId: author.id,
    text: String(m.text ?? '').slice(0, 40000),
    threadId,
    fedRef: String(m.fed_ref),
    createdAt: Number(m.created_at) || null,
  });
  // Origin fan-out: pass the same payload on to the other peers, each
  // addressed to their own mirror of this channel.
  forwardToOtherPeers(conn, channel, '/fed/v1/messages', (link) => ({
    channel_id: link.remote_channel_id,
    message: {
      fed_ref: String(m.fed_ref),
      user: m.user,
      text: String(m.text ?? '').slice(0, 40000),
      created_at: Number(m.created_at) || null,
      thread_fed_ref: m.thread_fed_ref ?? null,
    },
  }));
  res.json({ ok: true });
});

// POST /messages/update { fed_ref, text, edited_at }
fedRouter.post('/messages/update', (req, res) => {
  const conn = req.fedConnection;
  const fedRef = String(req.body?.fed_ref || '');
  if (!fedRef) return sendError(res, 400, 'missing_fields');
  const msg = get('SELECT * FROM messages WHERE fed_ref = ?', fedRef);
  if (!msg) return res.json({ ok: true }); // never relayed here — nothing to do
  // A peer may only mutate copies that live in a channel THIS connection is
  // linked to — never another peer's relayed traffic.
  if (!get('SELECT 1 FROM federation_channel_links WHERE channel_id = ? AND connection_id = ?', msg.channel_id, conn.id)) {
    return sendError(res, 403, 'not_allowed');
  }

  const text = String(req.body?.text ?? '').slice(0, 40000);
  const editedAt = Number(req.body?.edited_at) || now();
  run('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?', text, editedAt, msg.id);
  const updated = serializeMessage(get('SELECT * FROM messages WHERE id = ?', msg.id));
  const channel = get('SELECT * FROM channels WHERE id = ?', msg.channel_id);
  broadcastToChannel(msg.channel_id, {
    type: 'message.updated', workspace_id: channel.workspace_id, message: updated,
  });
  forwardToOtherPeers(conn, channel, '/fed/v1/messages/update', () => ({
    fed_ref: fedRef, text, edited_at: editedAt,
  }));
  res.json({ ok: true });
});

// POST /messages/delete { fed_ref }
fedRouter.post('/messages/delete', (req, res) => {
  const conn = req.fedConnection;
  const fedRef = String(req.body?.fed_ref || '');
  if (!fedRef) return sendError(res, 400, 'missing_fields');
  const msg = get('SELECT * FROM messages WHERE fed_ref = ? AND deleted = 0', fedRef);
  if (!msg) return res.json({ ok: true });
  if (!get('SELECT 1 FROM federation_channel_links WHERE channel_id = ? AND connection_id = ?', msg.channel_id, conn.id)) {
    return sendError(res, 403, 'not_allowed');
  }

  run('UPDATE messages SET deleted = 1 WHERE id = ?', msg.id);
  broadcastToChannel(msg.channel_id, { type: 'message.deleted', id: msg.id, channel_id: msg.channel_id });
  const channel = get('SELECT * FROM channels WHERE id = ?', msg.channel_id);
  forwardToOtherPeers(conn, channel, '/fed/v1/messages/delete', () => ({
    fed_ref: fedRef, deleted: true,
  }));
  res.json({ ok: true });
});
