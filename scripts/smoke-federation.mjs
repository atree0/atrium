// Federation smoke test: spins up THREE Atrium servers and exercises the full
// Slack Connect flow — invite/handshake, shared channels + mirrors, shadow
// users, message/edit/delete relay in both directions, fed_ref dedupe,
// external DMs, multi-party origin fan-out, private-channel share rejection,
// cross-peer mutation rejection, shadow reuse across workspaces, disconnect
// housekeeping, and receiver auth (incl. raw-body signature verification).
// Run: node scripts/smoke-federation.mjs   (ports 3321/3322/3323 must be free)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT_A = 3321, PORT_B = 3322, PORT_C = 3323;
const BASE_A = `http://localhost:${PORT_A}`;
const BASE_B = `http://localhost:${PORT_B}`;
const BASE_C = `http://localhost:${PORT_C}`;
const DIR_A = `/tmp/atrium-fed-a-${Date.now()}`;
const DIR_B = `/tmp/atrium-fed-b-${Date.now()}`;
const DIR_C = `/tmp/atrium-fed-c-${Date.now()}`;
const DB_A = path.join(DIR_A, 'atrium.db');
const DB_B = path.join(DIR_B, 'atrium.db');
const DB_C = path.join(DIR_C, 'atrium.db');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name} ${extra}`); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function api(base, method, p, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ...data };
}

// Signed call to a /fed/v1 receiver, for probing dedupe + auth directly.
// `rawBody` overrides the wire bytes (defaults to JSON.stringify(body)) so
// tests can desynchronize the signed payload from what is actually sent.
async function fedPost(base, p, { token, body, timestamp, signature, rawBody }) {
  const raw = rawBody ?? JSON.stringify(body ?? {});
  const ts = timestamp || String(Math.floor(Date.now() / 1000));
  const sig = signature ?? createHmac('sha256', token).update(`${ts}.${raw}`).digest('hex');
  const res = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Atrium-Timestamp': ts,
      'X-Atrium-Signature': sig,
    },
    body: raw,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ...data };
}

// Direct db access for things the API deliberately hides (fed_ref, tokens).
function dbAll(dbPath, sql, ...params) {
  const db = new DatabaseSync(dbPath);
  try { return db.prepare(sql).all(...params); } finally { db.close(); }
}
function dbRun(dbPath, sql, ...params) {
  const db = new DatabaseSync(dbPath);
  try { return db.prepare(sql).run(...params); } finally { db.close(); }
}

// --- start both servers ------------------------------------------------------
function startServer(port, dataDir) {
  const proc = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      ATRIUM_DATA_DIR: dataDir,
      ATRIUM_PUBLIC_URL: `http://localhost:${port}`,
      ATRIUM_ALLOW_LOCAL_FEDERATION: '1',
      ATRIUM_ALLOW_LOCAL_CALLBACKS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', d => process.stderr.write(`[server:${port}] ${d}`));
  return proc;
}

async function waitForHealth(base, proc, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`server on ${base} exited early (${proc.exitCode})`);
    try {
      const res = await fetch(`${base}/api/v1/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`server on ${base} did not become healthy`);
}

// Poll a channel's history until pred(messages) holds (relay is async).
async function waitForMessages(base, token, channelId, pred, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let texts = [];
  while (Date.now() < deadline) {
    const res = await api(base, 'GET', `/channels/${channelId}/messages?limit=100`, { token });
    if (res.ok) {
      texts = res.messages.map(m => m.text);
      if (pred(res.messages)) return res.messages;
    }
    await sleep(150);
  }
  throw new Error(`timeout; last history: ${JSON.stringify(texts)}`);
}

// check() wrapper for polling assertions: a timeout fails the check instead
// of aborting the whole run, so all relay problems surface in one pass.
async function pollCheck(name, fn) {
  try { await fn(); check(name, true); }
  catch (err) { check(name, false, err.message); }
}

async function stopServer(proc) {
  if (proc.exitCode !== null) return;
  proc.kill();
  await Promise.race([new Promise(r => proc.once('exit', r)), sleep(3000)]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
}

const serverA = startServer(PORT_A, DIR_A);
const serverB = startServer(PORT_B, DIR_B);
const serverC = startServer(PORT_C, DIR_C);

try {
  await waitForHealth(BASE_A, serverA);
  await waitForHealth(BASE_B, serverB);
  await waitForHealth(BASE_C, serverC);

  console.log('\n— users + workspaces —');
  const ada = await api(BASE_A, 'POST', '/auth/register', { body: { username: 'ada', password: 'password123', display_name: 'Ada Lovelace' } });
  check('A: register ada', ada.ok && ada.token);
  const eve = await api(BASE_A, 'POST', '/auth/register', { body: { username: 'eve', password: 'password123' } });
  check('A: register eve', eve.ok);
  const bob = await api(BASE_B, 'POST', '/auth/register', { body: { username: 'bob', password: 'password123', display_name: 'Bob' } });
  check('B: register bob', bob.ok && bob.token);
  const wsA = (await api(BASE_A, 'POST', '/workspaces', { token: ada.token, body: { name: 'Acme Corp' } })).workspace;
  check('A: workspace', !!wsA?.id);
  const wsA2 = (await api(BASE_A, 'POST', '/workspaces', { token: ada.token, body: { name: 'Acme Two' } })).workspace;
  const wsB = (await api(BASE_B, 'POST', '/workspaces', { token: bob.token, body: { name: 'Beta Co' } })).workspace;
  check('B: workspace', !!wsB?.id);
  const wsB2 = (await api(BASE_B, 'POST', '/workspaces', { token: bob.token, body: { name: 'Beta Two' } })).workspace;
  const carol = await api(BASE_C, 'POST', '/auth/register', { body: { username: 'carol', password: 'password123', display_name: 'Carol' } });
  check('C: register carol', carol.ok && carol.token);
  const wsC = (await api(BASE_C, 'POST', '/workspaces', { token: carol.token, body: { name: 'Gamma Inc' } })).workspace;
  check('C: workspace', !!wsC?.id);

  console.log('\n— handshake —');
  const noPerm = await api(BASE_A, 'POST', '/federation/invites', { token: eve.token, body: { workspace_id: wsA.id } });
  check('invite requires workspace membership', noPerm.status === 403);
  const invite = await api(BASE_A, 'POST', '/federation/invites', { token: ada.token, body: { workspace_id: wsA.id } });
  check('A: create federation invite', invite.ok && invite.code && invite.server_url === BASE_A, JSON.stringify(invite));
  const connect = await api(BASE_B, 'POST', '/federation/connect', { token: bob.token, body: { workspace_id: wsB.id, code: invite.code, remote_url: `${BASE_A}/` } });
  check('B: connect with invite code (trailing slash normalized)', connect.ok && connect.connection.remote_url === BASE_A, JSON.stringify(connect));
  check('B: learns remote workspace name', connect.connection?.remote_workspace_name === 'Acme Corp');
  const connsA = await api(BASE_A, 'GET', `/federation/connections?workspace_id=${wsA.id}`, { token: ada.token });
  check('A: connection stored with remote name', connsA.ok && connsA.connections.length === 1 && connsA.connections[0].remote_workspace_name === 'Beta Co');
  const connA = connsA.connections?.[0];
  const connB = connect.connection;
  const dup = await api(BASE_B, 'POST', '/federation/connect', { token: bob.token, body: { workspace_id: wsB.id, code: invite.code, remote_url: BASE_A } });
  check('duplicate connect → 409 already_connected', dup.status === 409 && dup.error === 'already_connected');
  const reuse = await api(BASE_B, 'POST', '/federation/connect', { token: bob.token, body: { workspace_id: wsB2.id, code: invite.code, remote_url: BASE_A } });
  check('invite code is single-use → 404 invalid_code', reuse.status === 404 && reuse.error === 'invalid_code');
  // Expiry is 7 days out, so write an already-expired invite straight in.
  dbRun(DB_A, 'INSERT INTO federation_invites (code, workspace_id, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    'expiredcode', wsA2.id, ada.user.id, Date.now() - 1000, Date.now());
  const expired = await api(BASE_B, 'POST', '/federation/connect', { token: bob.token, body: { workspace_id: wsB2.id, code: 'expiredcode', remote_url: BASE_A } });
  check('expired invite → 410 invite_expired', expired.status === 410 && expired.error === 'invite_expired');
  // The shared secret pair is stored swapped on the two sides.
  const [rowA] = dbAll(DB_A, 'SELECT token_out, token_in FROM federation_connections WHERE workspace_id = ?', wsA.id);
  const [rowB] = dbAll(DB_B, 'SELECT token_out, token_in FROM federation_connections WHERE workspace_id = ?', wsB.id);
  check('token pair stored swapped across servers',
    !!rowA && !!rowB && rowA.token_out === rowB.token_in && rowA.token_in === rowB.token_out);

  console.log('\n— share channel —');
  const eng = await api(BASE_A, 'POST', '/channels', { token: ada.token, body: { workspace_id: wsA.id, name: 'eng', topic: 'Engineering' } });
  check('A: create #eng', eng.ok && eng.channel.id);
  const engA = eng.channel.id;
  const pre = await api(BASE_A, 'POST', `/channels/${engA}/messages`, { token: ada.token, body: { text: 'pre-share message' } });
  check('A: post before sharing', pre.ok);
  const share = await api(BASE_A, 'POST', '/federation/share', { token: ada.token, body: { connection_id: connA.id, channel_id: engA } });
  check('A: share #eng to B', share.ok && typeof share.remote_channel_id === 'number', JSON.stringify(share));
  const mirrorId = share.remote_channel_id;
  const engAfter = await api(BASE_A, 'GET', `/channels/${engA}`, { token: ada.token });
  check('A: #eng marked is_shared', engAfter.channel?.is_shared === 1);
  const bChans = await api(BASE_B, 'GET', `/channels?workspace_id=${wsB.id}`, { token: bob.token });
  const mirror = bChans.channels?.find(c => c.id === mirrorId);
  check('B: mirror exists with origin pointers', !!mirror && mirror.name === 'eng' && mirror.topic === 'Engineering'
    && mirror.fed_origin_url === BASE_A && mirror.fed_origin_channel_id === engA);
  const members = await api(BASE_B, 'GET', `/channels/${mirrorId}/members`, { token: bob.token });
  check('B: shadow user is a mirror member', members.ok
    && members.members.some(m => m.username === 'ada@localhost:3321' && m.display_name === 'Ada Lovelace'));
  const mirrorHist = await api(BASE_B, 'GET', `/channels/${mirrorId}/messages`, { token: bob.token });
  check('B: pre-share message NOT relayed', mirrorHist.ok && mirrorHist.messages.length === 0);

  const privA = await api(BASE_A, 'POST', '/channels', { token: ada.token, body: { workspace_id: wsA.id, name: 'a-private', is_private: true } });
  const sharePriv = await api(BASE_A, 'POST', '/federation/share', { token: ada.token, body: { connection_id: connA.id, channel_id: privA.channel.id } });
  check('sharing a private channel → 400', sharePriv.status === 400
    && sharePriv.error === 'private_channels_cannot_be_shared', JSON.stringify(sharePriv));

  console.log('\n— message relay —');
  const hello = await api(BASE_A, 'POST', `/channels/${engA}/messages`, { token: ada.token, body: { text: 'hello from A' } });
  check('A: post hello', hello.ok);
  let helloCopyB = null;
  await pollCheck('B: receives relay from shadow author', async () => {
    const msgs = await waitForMessages(BASE_B, bob.token, mirrorId, ms => ms.some(m => m.text === 'hello from A'));
    helloCopyB = msgs.find(m => m.text === 'hello from A');
    if (helloCopyB.user?.username !== 'ada@localhost:3321') throw new Error(`author: ${helloCopyB.user?.username}`);
  });
  const [fedRow] = helloCopyB ? dbAll(DB_B, 'SELECT fed_ref, created_at FROM messages WHERE id = ?', helloCopyB.id) : [];
  check('B: copy carries fed_ref + origin created_at',
    !!fedRow && fedRow.fed_ref === `${BASE_A}#${hello.message.id}` && fedRow.created_at === hello.message.created_at);

  await pollCheck('B: thread reply lands in the mirrored thread', async () => {
    const reply = await api(BASE_A, 'POST', `/channels/${engA}/messages`, { token: ada.token, body: { text: 'nested from A', thread_id: hello.message.id } });
    if (!reply.ok) throw new Error(`post failed: ${JSON.stringify(reply)}`);
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const th = await api(BASE_B, 'GET', `/messages/${helloCopyB.id}/thread`, { token: bob.token });
      if (th.ok && th.messages.some(m => m.text === 'nested from A')) return;
      await sleep(150);
    }
    throw new Error('timeout waiting for thread relay');
  });

  const fromB = await api(BASE_B, 'POST', `/channels/${mirrorId}/messages`, { token: bob.token, body: { text: 'reply from B' } });
  check('B: post in mirror', fromB.ok);
  let replyCopyA = null;
  await pollCheck('A: receives mirror post from shadow author', async () => {
    const msgs = await waitForMessages(BASE_A, ada.token, engA, ms => ms.some(m => m.text === 'reply from B'));
    replyCopyA = msgs.find(m => m.text === 'reply from B');
    if (replyCopyA.user?.username !== 'bob@localhost:3322') throw new Error(`author: ${replyCopyA.user?.username}`);
  });

  await sleep(400); // settle: anything looping would show up now
  const histA = await api(BASE_A, 'GET', `/channels/${engA}/messages?limit=100`, { token: ada.token });
  check('A: exact history (no loops/dups)',
    histA.messages.map(m => m.text).join('|') === 'pre-share message|hello from A|reply from B',
    JSON.stringify(histA.messages.map(m => m.text)));
  const histB = await api(BASE_B, 'GET', `/channels/${mirrorId}/messages?limit=100`, { token: bob.token });
  check('B: exact history (no loops/dups)',
    histB.messages.map(m => m.text).join('|') === 'hello from A|reply from B',
    JSON.stringify(histB.messages.map(m => m.text)));

  console.log('\n— dedupe —');
  const redelivery = await fedPost(BASE_B, '/fed/v1/messages', {
    token: rowA.token_out,
    body: {
      channel_id: mirrorId,
      message: {
        fed_ref: `${BASE_A}#${hello.message.id}`,
        user: { id: ada.user.id, username: 'ada', display_name: 'Ada', avatar_url: null },
        text: 'hello from A',
        created_at: hello.message.created_at,
      },
    },
  });
  check('redelivered fed_ref deduped', redelivery.ok && redelivery.deduped === true, JSON.stringify(redelivery));
  const histB2 = await api(BASE_B, 'GET', `/channels/${mirrorId}/messages?limit=100`, { token: bob.token });
  check('B: dedupe wrote nothing', histB2.messages.length === 2);

  console.log('\n— edit + delete relay —');
  const edit = await api(BASE_A, 'PATCH', `/messages/${hello.message.id}`, { token: ada.token, body: { text: 'hello from A (edited)' } });
  check('A: edit message', edit.ok && edit.message.edited_at);
  await pollCheck('B: edit relays', async () => {
    await waitForMessages(BASE_B, bob.token, mirrorId, ms => ms.some(m => m.text === 'hello from A (edited)' && m.edited_at));
  });
  const del = await api(BASE_B, 'DELETE', `/messages/${fromB.message?.id}`, { token: bob.token });
  check('B: delete own message', del.ok);
  await pollCheck('A: delete relays', async () => {
    await waitForMessages(BASE_A, ada.token, engA, ms => !ms.some(m => m.text === 'reply from B'));
  });

  console.log('\n— external DM —');
  const dm = await api(BASE_A, 'POST', '/federation/dm', { token: ada.token, body: { connection_id: connA.id, remote_username: 'bob' } });
  check('A: open external DM', dm.ok && dm.channel?.is_dm === 1 && dm.channel?.name === 'dm'
    && dm.channel?.dm_users?.[0]?.username === 'bob@localhost:3322', JSON.stringify(dm));
  const dmA = dm.channel?.id;
  let dmB = null;
  if (dmA) {
    await api(BASE_A, 'POST', `/channels/${dmA}/messages`, { token: ada.token, body: { text: 'dm hello from A' } });
    await pollCheck('B: DM appears + receives message', async () => {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const chans = await api(BASE_B, 'GET', `/channels?workspace_id=${wsB.id}`, { token: bob.token });
        dmB = chans.channels?.find(c => c.is_dm === 1) || dmB;
        if (dmB) {
          const msgs = await api(BASE_B, 'GET', `/channels/${dmB.id}/messages`, { token: bob.token });
          if (msgs.ok && msgs.messages.some(m => m.text === 'dm hello from A' && m.user?.username === 'ada@localhost:3321')) return;
        }
        await sleep(150);
      }
      throw new Error('timeout waiting for DM relay');
    });
    check('B: DM channel points at A', dmB?.fed_origin_url === BASE_A && dmB?.fed_origin_channel_id === dmA);
    if (dmB) {
      await api(BASE_B, 'POST', `/channels/${dmB.id}/messages`, { token: bob.token, body: { text: 'dm reply from B' } });
      await pollCheck('A: DM reply relays back', async () => {
        await waitForMessages(BASE_A, ada.token, dmA, ms => ms.some(m => m.text === 'dm reply from B' && m.user?.username === 'bob@localhost:3322'));
      });
    } else {
      check('A: DM reply relays back', false, 'no DM channel on B');
    }
  } else {
    check('B: DM appears + receives message', false, 'no DM channel on A');
  }
  const ghost = await api(BASE_A, 'POST', '/federation/dm', { token: ada.token, body: { connection_id: connA.id, remote_username: 'nosuchuser' } });
  check('DM to unknown remote user → 404 user_not_found', ghost.status === 404 && ghost.error === 'user_not_found');

  console.log('\n— isolation —');
  const internal = await api(BASE_A, 'POST', '/channels', { token: ada.token, body: { workspace_id: wsA.id, name: 'internal' } });
  await api(BASE_A, 'POST', `/channels/${internal.channel.id}/messages`, { token: ada.token, body: { text: 'a-only chatter' } });
  const secret = await api(BASE_B, 'POST', '/channels', { token: bob.token, body: { workspace_id: wsB.id, name: 'secret' } });
  await api(BASE_B, 'POST', `/channels/${secret.channel.id}/messages`, { token: bob.token, body: { text: 'b-only chatter' } });
  await sleep(500);
  const bChans2 = await api(BASE_B, 'GET', `/channels?workspace_id=${wsB.id}`, { token: bob.token });
  check('B: #internal never appeared', !bChans2.channels.some(c => c.name === 'internal'));
  const aChans2 = await api(BASE_A, 'GET', `/channels?workspace_id=${wsA.id}`, { token: ada.token });
  check('A: #secret never appeared', !aChans2.channels.some(c => c.name === 'secret'));
  const histB3 = await api(BASE_B, 'GET', `/channels/${mirrorId}/messages?limit=100`, { token: bob.token });
  check('B: federated channel untouched by other traffic', histB3.messages.length === 1);

  console.log('\n— receiver auth —');
  const badTok = await fedPost(BASE_B, '/fed/v1/messages', {
    token: 'deadbeef',
    body: { channel_id: mirrorId, message: { fed_ref: 'x#1', user: { id: 1, username: 'x' }, text: 'x' } },
  });
  check('invalid token → 401', badTok.status === 401 && badTok.error === 'invalid_token', JSON.stringify(badTok));
  const badSig = await fedPost(BASE_B, '/fed/v1/messages', {
    token: rowA.token_out,
    signature: 'f'.repeat(64),
    body: { channel_id: mirrorId, message: { fed_ref: 'x#2', user: { id: 1, username: 'x' }, text: 'x' } },
  });
  check('tampered signature → 401', badSig.status === 401 && badSig.error === 'invalid_signature', JSON.stringify(badSig));
  // Sign the compact serialization but send different bytes: verification is
  // over the raw body, so this must fail even though the parsed object
  // matches what was signed.
  const tamperedObj = { channel_id: mirrorId, message: { fed_ref: 'x#tampered', user: { id: 1, username: 'x' }, text: 'x' } };
  const tsTampered = String(Math.floor(Date.now() / 1000));
  const sigTampered = createHmac('sha256', rowA.token_out).update(`${tsTampered}.${JSON.stringify(tamperedObj)}`).digest('hex');
  const modifiedBody = await fedPost(BASE_B, '/fed/v1/messages', {
    token: rowA.token_out, timestamp: tsTampered, signature: sigTampered,
    rawBody: JSON.stringify(tamperedObj, null, 2),
  });
  check('modified body with signature over original → 401', modifiedBody.status === 401
    && modifiedBody.error === 'invalid_signature', JSON.stringify(modifiedBody));
  const stale = await fedPost(BASE_B, '/fed/v1/messages', {
    token: rowA.token_out,
    timestamp: String(Math.floor(Date.now() / 1000) - 600),
    body: { channel_id: mirrorId, message: { fed_ref: 'x#3', user: { id: 1, username: 'x' }, text: 'x' } },
  });
  check('stale timestamp → 401', stale.status === 401 && stale.error === 'stale_timestamp', JSON.stringify(stale));
  const noAuth = await fetch(`${BASE_B}/fed/v1/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  check('missing token → 401', noAuth.status === 401);
  const histB4 = await api(BASE_B, 'GET', `/channels/${mirrorId}/messages?limit=100`, { token: bob.token });
  check('rejected calls wrote nothing', histB4.messages.length === 1);

  console.log('\n— three-server relay (origin fan-out) —');
  // Connect C to A and share #eng to C as well: B and C each only talk to A.
  const inviteC = await api(BASE_A, 'POST', '/federation/invites', { token: ada.token, body: { workspace_id: wsA.id } });
  const connectC = await api(BASE_C, 'POST', '/federation/connect', { token: carol.token, body: { workspace_id: wsC.id, code: inviteC.code, remote_url: BASE_A } });
  check('C: connect to A', connectC.ok, JSON.stringify(connectC));
  const connsA2 = await api(BASE_A, 'GET', `/federation/connections?workspace_id=${wsA.id}`, { token: ada.token });
  const connAC = connsA2.connections.find(c => c.remote_url === BASE_C);
  check('A: connection to C stored', !!connAC);
  const shareC = await api(BASE_A, 'POST', '/federation/share', { token: ada.token, body: { connection_id: connAC.id, channel_id: engA } });
  check('A: share #eng to C', shareC.ok && typeof shareC.remote_channel_id === 'number', JSON.stringify(shareC));
  const mirrorC = shareC.remote_channel_id;

  const fromB2 = await api(BASE_B, 'POST', `/channels/${mirrorId}/messages`, { token: bob.token, body: { text: 'three-way from B' } });
  check('B: post into shared channel', fromB2.ok);
  await pollCheck('A: origin receives from B', async () => {
    await waitForMessages(BASE_A, ada.token, engA, ms => ms.some(m => m.text === 'three-way from B' && m.user?.username === 'bob@localhost:3322'));
  });
  await pollCheck('C: forwarded copy arrives (multi-party relay)', async () => {
    await waitForMessages(BASE_C, carol.token, mirrorC, ms => ms.some(m => m.text === 'three-way from B'));
  });
  await sleep(400); // settle: an echo back to B would show up as a duplicate
  const histB5 = await api(BASE_B, 'GET', `/channels/${mirrorId}/messages?limit=100`, { token: bob.token });
  check('B: no echo duplicate from origin fan-out',
    histB5.messages.filter(m => m.text === 'three-way from B').length === 1,
    JSON.stringify(histB5.messages.map(m => m.text)));

  const editB2 = await api(BASE_B, 'PATCH', `/messages/${fromB2.message.id}`, { token: bob.token, body: { text: 'three-way from B (edited)' } });
  check('B: edit the message', editB2.ok);
  await pollCheck('A: forwarded edit applied', async () => {
    await waitForMessages(BASE_A, ada.token, engA, ms => ms.some(m => m.text === 'three-way from B (edited)'));
  });
  await pollCheck('C: forwarded edit applied', async () => {
    await waitForMessages(BASE_C, carol.token, mirrorC, ms => ms.some(m => m.text === 'three-way from B (edited)'));
  });
  const delB2 = await api(BASE_B, 'DELETE', `/messages/${fromB2.message.id}`, { token: bob.token });
  check('B: delete the message', delB2.ok);
  await pollCheck('A: forwarded delete applied', async () => {
    await waitForMessages(BASE_A, ada.token, engA, ms => !ms.some(m => m.text.startsWith('three-way from B')));
  });
  await pollCheck('C: forwarded delete applied', async () => {
    await waitForMessages(BASE_C, carol.token, mirrorC, ms => !ms.some(m => m.text.startsWith('three-way from B')));
  });

  console.log('\n— cross-peer mutation rejected —');
  // The A↔B external DM holds a message relayed from B. C's connection to A
  // has no link to that DM channel, so C must not be able to mutate it.
  const [dmFedRow] = dbAll(DB_A, 'SELECT fed_ref FROM messages WHERE channel_id = ? AND fed_ref IS NOT NULL LIMIT 1', dmA);
  check('A: DM holds a relayed message from B', !!dmFedRow?.fed_ref, JSON.stringify(dmFedRow));
  const [rowC] = dbAll(DB_C, 'SELECT token_out FROM federation_connections WHERE workspace_id = ? AND remote_url = ?', wsC.id, BASE_A);
  const hijackUpd = await fedPost(BASE_A, '/fed/v1/messages/update', {
    token: rowC.token_out,
    body: { fed_ref: dmFedRow.fed_ref, text: 'hijacked by C', edited_at: Date.now() },
  });
  check('unlinked peer cannot update another peers message → 403', hijackUpd.status === 403, JSON.stringify(hijackUpd));
  const hijackDel = await fedPost(BASE_A, '/fed/v1/messages/delete', {
    token: rowC.token_out,
    body: { fed_ref: dmFedRow.fed_ref },
  });
  check('unlinked peer cannot delete another peers message → 403', hijackDel.status === 403, JSON.stringify(hijackDel));
  const legitUpd = await fedPost(BASE_A, '/fed/v1/messages/update', {
    token: rowB.token_out,
    body: { fed_ref: dmFedRow.fed_ref, text: 'dm reply from B (edited)', edited_at: Date.now() },
  });
  check('linked peer CAN update its own relayed message', legitUpd.ok, JSON.stringify(legitUpd));

  console.log('\n— shadow user reused across local workspaces —');
  // bob's shadow already exists on A (member of wsA via #eng relay). Sharing
  // a channel from B's second workspace to A's second workspace must add the
  // SAME shadow user to wsA2 — not create a duplicate.
  const inviteB2 = await api(BASE_B, 'POST', '/federation/invites', { token: bob.token, body: { workspace_id: wsB2.id } });
  const connectA2 = await api(BASE_A, 'POST', '/federation/connect', { token: ada.token, body: { workspace_id: wsA2.id, code: inviteB2.code, remote_url: BASE_B } });
  check('A2: connect to B2', connectA2.ok, JSON.stringify(connectA2));
  const betaCh = await api(BASE_B, 'POST', '/channels', { token: bob.token, body: { workspace_id: wsB2.id, name: 'beta-shared' } });
  const connsB2 = await api(BASE_B, 'GET', `/federation/connections?workspace_id=${wsB2.id}`, { token: bob.token });
  const shareB2 = await api(BASE_B, 'POST', '/federation/share', { token: bob.token, body: { connection_id: connsB2.connections[0].id, channel_id: betaCh.channel.id } });
  check('B2: share #beta-shared to A2', shareB2.ok, JSON.stringify(shareB2));
  const shadowWs = new Set(dbAll(DB_A,
    `SELECT wm.workspace_id FROM users u
     JOIN workspace_members wm ON wm.user_id = u.id
     WHERE u.is_remote = 1 AND u.remote_url = ? AND u.remote_id = ?`, BASE_B, bob.user.id
  ).map(r => r.workspace_id));
  check('shadow user is a member of BOTH local workspaces', shadowWs.has(wsA.id) && shadowWs.has(wsA2.id),
    JSON.stringify([...shadowWs]));
  const shadowCount = dbAll(DB_A,
    'SELECT id FROM users WHERE is_remote = 1 AND remote_url = ? AND remote_id = ?', BASE_B, bob.user.id
  ).length;
  check('no duplicate shadow user created', shadowCount === 1, String(shadowCount));

  console.log('\n— disconnect housekeeping —');
  const temp = await api(BASE_A, 'POST', '/channels', { token: ada.token, body: { workspace_id: wsA.id, name: 'temp-share' } });
  const shareTemp = await api(BASE_A, 'POST', '/federation/share', { token: ada.token, body: { connection_id: connAC.id, channel_id: temp.channel.id } });
  check('A: share #temp-share to C only', shareTemp.ok, JSON.stringify(shareTemp));
  const tempShared = await api(BASE_A, 'GET', `/channels/${temp.channel.id}`, { token: ada.token });
  check('#temp-share marked is_shared', tempShared.channel?.is_shared === 1);
  const delConnC = await api(BASE_A, 'DELETE', `/federation/connections/${connAC.id}`, { token: ada.token });
  check('A: delete connection to C', delConnC.ok, JSON.stringify(delConnC));
  const tempAfter = await api(BASE_A, 'GET', `/channels/${temp.channel.id}`, { token: ada.token });
  check('is_shared cleared when last link is gone', tempAfter.channel?.is_shared === 0,
    `is_shared=${tempAfter.channel?.is_shared}`);
  const engStill = await api(BASE_A, 'GET', `/channels/${engA}`, { token: ada.token });
  check('#eng still is_shared (link to B remains)', engStill.channel?.is_shared === 1);
} catch (err) {
  failed++;
  console.error('SMOKE CRASH:', err);
} finally {
  await stopServer(serverA);
  await stopServer(serverB);
  await stopServer(serverC);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
