// Federation engine — Slack Connect-style server-to-server links.
// Owns outbound signed calls (fedCall), shadow users, and the bus
// subscriptions that fan local channel traffic out to remote servers.
// The HTTP endpoints live in routes/federation.js.
import { get, all, run, now } from './db.js';
import { signPayload } from './auth.js';
import { on } from './bus.js';
import { assertPublicUrl } from './lib/netguard.js';

const FED_TIMEOUT_MS = 5000;

// Local/private federation targets are blocked by default (SSRF guard);
// ATRIUM_ALLOW_LOCAL_FEDERATION=1 opts out for local dev and tests.
export const allowLocalFederation = () => process.env.ATRIUM_ALLOW_LOCAL_FEDERATION === '1';

// This server's own base URL, as remote servers should reach it.
export function myPublicUrl() {
  return normalizeUrl(process.env.ATRIUM_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`);
}

export function normalizeUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

// Rejects non-http(s) URLs and — unless local federation is allowed —
// loopback/private/link-local/metadata targets and plaintext http (bearer
// tokens must never cross the wire unencrypted). Throws on rejection.
export async function assertFederationUrl(url) {
  const parsed = new URL(url); // throws TypeError on unparseable input
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid_url_scheme');
  if (!allowLocalFederation()) {
    if (parsed.protocol !== 'https:') throw new Error('https_required');
    await assertPublicUrl(url);
  }
}

// Signed server-to-server POST. Headers carry the connection's outbound
// token plus an HMAC-SHA256 signature over `${timestamp}.${body}`; the
// remote verifies with its copy of the same token (its token_in).
// Returns { status, data }.
export async function fedCall(conn, path, payload) {
  await assertFederationUrl(conn.remote_url); // re-resolve: DNS could have been rebound
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(now() / 1000));
  const res = await fetch(`${conn.remote_url}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${conn.token_out}`,
      'X-Atrium-Timestamp': timestamp,
      'X-Atrium-Signature': signPayload(conn.token_out, timestamp, body),
    },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(FED_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// A remote person appears locally as a shadow user: is_remote=1, keyed by
// (remote_url, remote_id), username suffixed with the remote host. Shadow
// users have no password and can never log in (auth/login rejects is_remote).
export function upsertShadowUser(conn, remote) {
  const remoteId = Number(remote.id);
  const existing = get(
    'SELECT * FROM users WHERE is_remote = 1 AND remote_url = ? AND remote_id = ?',
    conn.remote_url, remoteId
  );
  if (existing) {
    // A shadow can outlive the membership that created it (e.g. a second
    // local workspace federating with the same remote) — re-affirm it, and
    // pick up profile changes from the home server.
    run(
      'INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
      conn.workspace_id, existing.id, 'member', now()
    );
    const displayName = String(remote.display_name || remote.username || '').slice(0, 80);
    const avatarUrl = remote.avatar_url || null;
    if (existing.display_name !== displayName || existing.avatar_url !== avatarUrl) {
      run('UPDATE users SET display_name = ?, avatar_url = ? WHERE id = ?',
        displayName, avatarUrl, existing.id);
      return get('SELECT * FROM users WHERE id = ?', existing.id);
    }
    return existing;
  }

  const host = new URL(conn.remote_url).host;
  const base = `${String(remote.username || 'user').slice(0, 24)}@${host}`;
  let username = base;
  for (let n = 2; get('SELECT 1 FROM users WHERE username = ?', username); n++) {
    username = `${base}-${n}`;
  }
  const result = run(
    `INSERT INTO users (username, display_name, avatar_url, is_remote, remote_url, remote_id, created_at)
     VALUES (?, ?, ?, 1, ?, ?, ?)`,
    username, String(remote.display_name || remote.username || '').slice(0, 80),
    remote.avatar_url || null, conn.remote_url, remoteId, now()
  );
  const user = get('SELECT * FROM users WHERE id = ?', Number(result.lastInsertRowid));
  run(
    'INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
    conn.workspace_id, user.id, 'member', now()
  );
  return user;
}

// ---- outbound relay ---------------------------------------------------------

function linksForChannel(channelId) {
  return all(
    `SELECT l.remote_channel_id, c.remote_url, c.token_out
     FROM federation_channel_links l
     JOIN federation_connections c ON c.id = l.connection_id
     WHERE l.channel_id = ? AND c.status = 'active'`, channelId
  );
}

// Fire-and-forget fan-out to every active connection linked to the channel.
function relayFanout(row, path, buildPayload) {
  for (const link of linksForChannel(row.channel_id)) {
    fedCall({ remote_url: link.remote_url, token_out: link.token_out }, path, buildPayload(link))
      .then(({ status, data }) => {
        if (status >= 400) {
          console.warn(`federation relay to ${link.remote_url}${path} failed: ${status} ${data?.error || ''}`);
        }
      })
      .catch(err => console.warn(`federation relay to ${link.remote_url}${path} failed: ${err.message}`));
  }
}

// fed_ref identifies a message across servers: "<origin url>#<origin id>".
// Relayed copies store it locally; originals derive it from their own id.
function localFedRef(id) {
  return `${myPublicUrl()}#${id}`;
}

export function registerFederation() {
  // The serialized bus payload omits fed_ref, so each listener re-reads the
  // message row: a row with fed_ref set is a relayed copy and must never
  // be relayed again (loop safety).
  on('message.new', ({ message }) => {
    const row = get('SELECT * FROM messages WHERE id = ?', message.id);
    if (!row || row.fed_ref) return;
    const author = get('SELECT id, username, display_name, avatar_url FROM users WHERE id = ?', row.user_id);
    relayFanout(row, '/fed/v1/messages', (link) => {
      let threadFedRef = null;
      if (row.thread_id) {
        const parent = get('SELECT id, fed_ref FROM messages WHERE id = ?', row.thread_id);
        if (parent) threadFedRef = parent.fed_ref || localFedRef(parent.id);
      }
      return {
        channel_id: link.remote_channel_id,
        message: {
          fed_ref: localFedRef(row.id),
          user: author,
          text: row.text,
          created_at: row.created_at,
          thread_fed_ref: threadFedRef,
        },
      };
    });
  });

  on('message.updated', ({ message }) => {
    const row = get('SELECT * FROM messages WHERE id = ?', message.id);
    if (!row || row.fed_ref || row.deleted) return;
    relayFanout(row, '/fed/v1/messages/update', () => ({
      fed_ref: localFedRef(row.id),
      text: row.text,
      edited_at: row.edited_at,
    }));
  });

  on('message.deleted', ({ message }) => {
    const row = get('SELECT * FROM messages WHERE id = ?', message.id);
    if (!row || row.fed_ref) return;
    relayFanout(row, '/fed/v1/messages/delete', () => ({
      fed_ref: localFedRef(row.id),
      deleted: true,
    }));
  });
}
