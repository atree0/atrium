// End-to-end smoke test: exercises auth, workspaces, channels, messages,
// threads, reactions, pins, FTS search, DMs, realtime, saved messages,
// star/mute, custom emoji, members, and the full app platform (bot token,
// incoming webhook, slash command, events API with HMAC verify).
// Run: npm run smoke   (server must NOT already be running on PORT)
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import WebSocket from 'ws';

const PORT = 3210;
const BASE = `http://localhost:${PORT}`;
const RECEIVER_PORT = 3999;

let passed = 0, failed = 0;
let wsClient = null;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name} ${extra}`); }
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- start server -----------------------------------------------------------
process.env.PORT = String(PORT);
process.env.ATRIUM_DATA_DIR = `/tmp/atrium-smoke-${Date.now()}`;
const server = spawn(process.execPath, ['server/index.js'], {
  env: {
    ...process.env,
    ATRIUM_ALLOW_LOCAL_CALLBACKS: '1',
    ATRIUM_ALLOW_LOCAL_UNFURL: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', d => process.stderr.write(`[server] ${d}`));
await sleep(1200);

// --- receiver for slash commands + events ------------------------------------
const received = [];
let signingSecret = null;
const receiver = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const ts = req.headers['x-atrium-timestamp'];
    const sig = req.headers['x-atrium-signature'];
    let verified = false;
    if (signingSecret && ts && sig) {
      const expected = createHmac('sha256', signingSecret).update(`${ts}.${body}`).digest('hex');
      verified = expected === sig;
    }
    const payload = JSON.parse(body || '{}');
    received.push({ payload, verified, path: req.url });
    if (payload.type === 'slash_command') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: `echo: ${payload.text}` }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    }
  });
});
await new Promise(r => receiver.listen(RECEIVER_PORT, r));

try {
  console.log('\n— auth —');
  const ada = await api('POST', '/auth/register', { body: { username: 'ada', password: 'password123', display_name: 'Ada' } });
  check('register ada', ada.ok && ada.token);
  const grace = await api('POST', '/auth/register', { body: { username: 'grace', password: 'password123' } });
  check('register grace', grace.ok);
  const badLogin = await api('POST', '/auth/login', { body: { username: 'ada', password: 'wrong-password' } });
  check('rejects bad password', badLogin.status === 401);
  const login = await api('POST', '/auth/login', { body: { username: 'ada', password: 'password123' } });
  check('login', login.ok && login.token);
  const me = await api('GET', '/auth/me', { token: ada.token });
  check('auth/me', me.ok && me.user.username === 'ada');
  const noToken = await api('GET', '/auth/me');
  check('requires token', noToken.status === 401);

  console.log('\n— workspaces —');
  const wsRes = await api('POST', '/workspaces', { token: ada.token, body: { name: 'Acme HQ' } });
  check('create workspace', wsRes.ok && wsRes.workspace.slug === 'acme-hq');
  const wsId = wsRes.workspace.id;
  const invite = await api('POST', `/workspaces/${wsId}/invites`, { token: ada.token, body: {} });
  check('create invite', invite.ok && invite.invite.code);
  const join = await api('POST', '/workspaces/join', { token: grace.token, body: { code: invite.invite.code } });
  check('grace joins via invite', join.ok && join.workspace.id === wsId);
  const detail = await api('GET', `/workspaces/${wsId}`, { token: grace.token });
  check('workspace detail has 2 members', detail.ok && detail.members.length === 2);
  const outsider = await api('GET', `/workspaces/${wsId}`);
  check('workspace requires auth', outsider.status === 401);
  const mallory = await api('POST', '/auth/register', { body: { username: 'mallory', password: 'password123' } });
  check('register mallory', mallory.ok);
  const nonMember = await api('GET', `/workspaces/${wsId}`, { token: mallory.token });
  check('workspace requires membership', nonMember.status === 403);

  // Re-joining via the same invite must not burn a second use: with
  // max_uses=2, mallory joining twice leaves room for one more joiner.
  const invite2 = await api('POST', `/workspaces/${wsId}/invites`, { token: ada.token, body: { max_uses: 2 } });
  check('create limited invite', invite2.ok);
  const mJoin1 = await api('POST', '/workspaces/join', { token: mallory.token, body: { code: invite2.invite.code } });
  check('mallory joins via limited invite', mJoin1.ok);
  const mJoin2 = await api('POST', '/workspaces/join', { token: mallory.token, body: { code: invite2.invite.code } });
  check('re-join is accepted', mJoin2.ok);
  const henry = await api('POST', '/auth/register', { body: { username: 'henry', password: 'password123' } });
  const hJoin = await api('POST', '/workspaces/join', { token: henry.token, body: { code: invite2.invite.code } });
  check('re-join did not burn a use', hJoin.ok, JSON.stringify(hJoin));

  console.log('\n— channels —');
  const ch = await api('POST', '/channels', { token: ada.token, body: { workspace_id: wsId, name: 'eng', topic: 'Engineering' } });
  check('create channel', ch.ok && ch.channel.name === 'eng');
  const chId = ch.channel.id;
  const dup = await api('POST', '/channels', { token: ada.token, body: { workspace_id: wsId, name: 'eng' } });
  check('duplicate name rejected', dup.status === 409);
  const graceJoin = await api('POST', `/channels/${chId}/join`, { token: grace.token });
  check('grace joins channel', graceJoin.ok && graceJoin.channel.is_member);
  const chanList = await api('GET', `/channels?workspace_id=${wsId}`, { token: grace.token });
  check('channel list', chanList.ok && chanList.channels.length >= 2);
  const general = chanList.channels.find(c => c.name === 'general');
  check('general auto-created', !!general && general.is_member);
  // mallory is a workspace member but not a member of #eng.
  const nonMemberPatch = await api('PATCH', `/channels/${chId}`, { token: mallory.token, body: { topic: 'hijacked' } });
  check('non-member cannot edit topic', nonMemberPatch.status === 403, JSON.stringify(nonMemberPatch));
  const memberPatch = await api('PATCH', `/channels/${chId}`, { token: grace.token, body: { topic: 'Engineering!' } });
  check('member can edit topic', memberPatch.ok && memberPatch.channel.topic === 'Engineering!');

  console.log('\n— private channels —');
  const priv = await api('POST', '/channels', { token: ada.token, body: { workspace_id: wsId, name: 'secret', is_private: true } });
  check('create private channel', priv.ok && priv.channel.is_private === 1);
  const privId = priv.channel.id;
  const graceList1 = await api('GET', `/channels?workspace_id=${wsId}`, { token: grace.token });
  check('private channel hidden from non-member', !graceList1.channels.some(c => c.id === privId));
  const addMember = await api('POST', `/channels/${privId}/members`, { token: ada.token, body: { user_id: grace.user.id } });
  check('add member to private channel', addMember.ok);
  const gracePriv = await api('GET', `/channels/${privId}/messages`, { token: grace.token });
  check('added member can read private channel', gracePriv.ok);
  const graceList2 = await api('GET', `/channels?workspace_id=${wsId}`, { token: grace.token });
  check('private channel listed after add', graceList2.channels.some(c => c.id === privId));

  console.log('\n— messages —');
  const m1 = await api('POST', `/channels/${chId}/messages`, { token: ada.token, body: { text: 'hello **world** @grace' } });
  check('post message', m1.ok && m1.message.text.includes('@grace'));
  check('mention parsed', m1.message.mentions.includes(grace.user.id));
  const m2 = await api('POST', `/channels/${chId}/messages`, { token: grace.token, body: { text: 'hi ada' } });
  check('grace posts', m2.ok);
  const reply = await api('POST', `/channels/${chId}/messages`, { token: ada.token, body: { text: 'thread reply', thread_id: m1.message.id } });
  check('thread reply', reply.ok && reply.message.thread_id === m1.message.id);
  const thread = await api('GET', `/messages/${m1.message.id}/thread`, { token: grace.token });
  check('thread fetch', thread.ok && thread.messages.length === 1 && thread.parent.reply_count === 1);
  const edited = await api('PATCH', `/messages/${m2.message.id}`, { token: grace.token, body: { text: 'hi ada (edited)' } });
  check('edit own message', edited.ok && edited.message.edited_at);
  const editOther = await api('PATCH', `/messages/${m2.message.id}`, { token: ada.token, body: { text: 'hijack' } });
  check('cannot edit others message', editOther.status === 403);
  const react = await api('POST', `/messages/${m1.message.id}/reactions`, { token: grace.token, body: { emoji: '👍' } });
  check('reaction add', react.ok && react.message.reactions[0].emoji === '👍');
  const react2 = await api('POST', `/messages/${m1.message.id}/reactions`, { token: grace.token, body: { emoji: '👍' } });
  check('reaction toggles off', react2.ok && react2.message.reactions.length === 0);
  const pin = await api('POST', `/messages/${m1.message.id}/pin`, { token: ada.token });
  check('pin', pin.ok && pin.pinned);
  const pins = await api('GET', `/channels/${chId}/pins`, { token: grace.token });
  check('pins list', pins.ok && pins.pins.length === 1);
  const search = await api('GET', `/search?workspace_id=${wsId}&q=edited`, { token: ada.token });
  check('search finds edited message', search.ok && search.results.length === 1);
  const searchFrom = await api('GET', `/search?workspace_id=${wsId}&q=${encodeURIComponent('hello from:ada')}`, { token: grace.token });
  check('search with from: filter', searchFrom.ok && searchFrom.results.length === 1
    && searchFrom.results[0].id === m1.message.id && searchFrom.results[0].snippet.includes('<mark>'),
    JSON.stringify(searchFrom).slice(0, 200));
  const history = await api('GET', `/channels/${chId}/messages?limit=10`, { token: grace.token });
  check('history excludes thread replies', history.ok && history.messages.length === 2);
  const around = await api('GET', `/channels/${chId}/messages?around=${m2.message.id}`, { token: grace.token });
  check('around returns target message', around.ok && around.messages.some(m => m.id === m2.message.id)
    && 'has_more_before' in around && 'has_more_after' in around);
  const after = await api('GET', `/channels/${chId}/messages?after=${m1.message.id}`, { token: grace.token });
  check('after returns only newer', after.ok && after.messages.length > 0
    && after.messages.every((m, i, a) => m.id > m1.message.id && (i === 0 || a[i - 1].id < m.id)));
  const read = await api('POST', `/channels/${chId}/read`, { token: grace.token, body: { message_id: m2.message.id } });
  check('read marker', read.ok);
  const afterRead = await api('GET', `/channels?workspace_id=${wsId}`, { token: grace.token });
  check('unread clears after read', afterRead.channels.find(c => c.id === chId).unread_count === 0);
  const clampRead = await api('POST', `/channels/${chId}/read`, { token: grace.token, body: { message_id: 1e15 } });
  check('read marker clamps absurd id', clampRead.ok);
  await api('POST', `/channels/${chId}/messages`, { token: ada.token, body: { text: 'one more' } });
  const afterClamp = await api('GET', `/channels?workspace_id=${wsId}`, { token: grace.token });
  check('unread still counts newer messages', afterClamp.channels.find(c => c.id === chId).unread_count === 1);

  const mBroadcast = await api('POST', `/channels/${chId}/messages`, { token: ada.token, body: { text: '@channel heads up' } });
  check('@channel mentions every channel member', mBroadcast.ok
    && mBroadcast.message.mentions.includes(ada.user.id) && mBroadcast.message.mentions.includes(grace.user.id),
    JSON.stringify(mBroadcast.message?.mentions));
  const graceMentions = await api('GET', `/channels?workspace_id=${wsId}`, { token: grace.token });
  check('mention_count reflects unread mentions', graceMentions.channels.find(c => c.id === chId).mention_count >= 1);

  console.log('\n— archived channels —');
  const old = await api('POST', '/channels', { token: ada.token, body: { workspace_id: wsId, name: 'old-stuff' } });
  check('create channel to archive', old.ok);
  const archived = await api('PATCH', `/channels/${old.channel.id}`, { token: ada.token, body: { is_archived: true } });
  check('archive channel', archived.ok && archived.channel.is_archived === 1);
  const postArchived = await api('POST', `/channels/${old.channel.id}/messages`, { token: ada.token, body: { text: 'bump' } });
  check('posting to archived channel rejected', postArchived.status === 400 && postArchived.error === 'channel_archived');

  console.log('\n— saved messages —');
  const save = await api('POST', '/users/me/saved', { token: ada.token, body: { message_id: m1.message.id } });
  check('save message', save.ok);
  const savedList = await api('GET', `/users/me/saved?workspace_id=${wsId}`, { token: ada.token });
  check('list saved', savedList.ok && savedList.saved.length === 1
    && savedList.saved[0].id === m1.message.id && savedList.saved[0].channel_name === 'eng');
  const unsave = await api('DELETE', `/users/me/saved/${m1.message.id}`, { token: ada.token });
  check('unsave message', unsave.ok);
  const savedList2 = await api('GET', `/users/me/saved?workspace_id=${wsId}`, { token: ada.token });
  check('saved list empty after unsave', savedList2.ok && savedList2.saved.length === 0);

  console.log('\n— star/mute + emoji —');
  const star = await api('POST', `/channels/${chId}/star`, { token: grace.token });
  const mute = await api('POST', `/channels/${chId}/mute`, { token: grace.token });
  check('star + mute toggles', star.ok && star.starred === true && mute.ok && mute.muted === true);
  const graceList3 = await api('GET', `/channels?workspace_id=${wsId}`, { token: grace.token });
  const engState = graceList3.channels.find(c => c.id === chId);
  check('star + mute persist in channel list', engState.starred === true && engState.muted === true);
  const emoji = await api('POST', `/workspaces/${wsId}/emoji`, { token: ada.token, body: { name: 'party_parrot', url: '/uploads/fake.png' } });
  check('add custom emoji', emoji.ok);
  const emojiList = await api('GET', `/workspaces/${wsId}/emoji`, { token: grace.token });
  check('list custom emoji', emojiList.ok && emojiList.emoji.some(e => e.name === 'party_parrot' && e.url === '/uploads/fake.png'));

  console.log('\n— DMs —');
  const dm = await api('POST', '/channels/dm', { token: ada.token, body: { workspace_id: wsId, user_ids: [grace.user.id] } });
  check('open dm', dm.ok && dm.channel.is_dm === 1);
  const dmAgain = await api('POST', '/channels/dm', { token: grace.token, body: { workspace_id: wsId, user_ids: [ada.user.id] } });
  check('dm dedupes', dmAgain.ok && dmAgain.channel.id === dm.channel.id);
  const dmMsg = await api('POST', `/channels/${dm.channel.id}/messages`, { token: ada.token, body: { text: 'secret hi' } });
  check('dm message', dmMsg.ok);
  const selfDm = await api('POST', '/channels/dm', { token: ada.token, body: { workspace_id: wsId, user_ids: [] } });
  check('self-DM opens', selfDm.ok && selfDm.channel.is_dm === 1 && (selfDm.channel.dm_users || []).length === 0,
    JSON.stringify(selfDm).slice(0, 200));
  const selfDm2 = await api('POST', '/channels/dm', { token: ada.token, body: { workspace_id: wsId, user_ids: [] } });
  check('self-DM dedupes', selfDm2.ok && selfDm2.channel.id === selfDm.channel.id);

  console.log('\n— realtime —');
  wsClient = new WebSocket(`ws://localhost:${PORT}/ws?token=${grace.token}`);
  const wsEvents = [];
  wsClient.on('message', (raw) => wsEvents.push(JSON.parse(raw)));
  await new Promise(r => wsClient.on('open', r));
  const adaWs = new WebSocket(`ws://localhost:${PORT}/ws?token=${ada.token}`);
  await new Promise(r => adaWs.on('open', r));
  await api('POST', `/channels/${chId}/messages`, { token: ada.token, body: { text: 'realtime test' } });
  adaWs.send(JSON.stringify({ type: 'typing', channel_id: chId }));
  await sleep(400);
  check('ws hello', wsEvents.some(e => e.type === 'hello'));
  check('ws message.new received', wsEvents.some(e => e.type === 'message.new' && e.message.text === 'realtime test'));
  check('ws typing received', wsEvents.some(e => e.type === 'typing' && e.user_id === ada.user.id));
  adaWs.close();

  console.log('\n— uploads + attachment validation —');
  const form = new FormData();
  form.append('files', new Blob(['<html><body>x</body></html>'], { type: 'text/html' }), 'evil.html');
  const upBad = await fetch(`${BASE}/api/v1/upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${ada.token}` }, body: form,
  }).then(r => r.json());
  check('html upload rejected', upBad.ok === false && upBad.error === 'unsupported_type', JSON.stringify(upBad));
  const jsAttach = await api('POST', `/channels/${chId}/messages`, {
    token: ada.token, body: { attachments: [{ url: 'javascript:alert(1)', name: 'evil' }] },
  });
  check('javascript: attachment rejected', jsAttach.status === 400, JSON.stringify(jsAttach));
  const forgedLink = await api('POST', `/channels/${chId}/messages`, {
    token: ada.token,
    body: { text: 'with forged link', attachments: [{ type: 'link', url: 'https://evil.example', title: 'fake unfurl' }] },
  });
  check('client-forged link attachment stripped', forgedLink.ok
    && !forgedLink.message.attachments.some(a => a.type === 'link'), JSON.stringify(forgedLink.message?.attachments));
  const extFile = await api('POST', `/channels/${chId}/messages`, {
    token: ada.token,
    body: { text: 'external file', attachments: [{ url: 'https://cdn.example.com/report.pdf', name: 'report.pdf', size: 10, mimetype: 'application/pdf' }] },
  });
  check('external file attachment keeps mimetype', extFile.ok
    && extFile.message.attachments[0]?.mimetype === 'application/pdf'
    && extFile.message.attachments[0]?.url === 'https://cdn.example.com/report.pdf', JSON.stringify(extFile));

  console.log('\n— channel files —');
  const filesRes = await api('GET', `/channels/${chId}/files`, { token: grace.token });
  check('files endpoint lists shared file', filesRes.ok && filesRes.files.some(f =>
    f.name === 'report.pdf' && f.mimetype === 'application/pdf'
    && f.uploader?.username === 'ada' && f.message_id && f.created_at),
    JSON.stringify(filesRes).slice(0, 220));
  check('files exclude link unfurls', filesRes.ok && filesRes.files.every(f => f.url && f.name));
  const filesPriv = await api('GET', `/channels/${privId}/files`, { token: mallory.token });
  check('files endpoint is read-permission-gated', filesPriv.status === 404);

  console.log('\n— mentions feed —');
  const mentionsRes = await api('GET', `/users/me/mentions?workspace_id=${wsId}&limit=20`, { token: grace.token });
  check('mentions feed lists my mentions', mentionsRes.ok
    && mentionsRes.mentions.some(m => m.id === m1.message.id && m.channel_name === 'eng'),
    JSON.stringify(mentionsRes).slice(0, 220));
  check('mentions exclude my own messages', mentionsRes.ok
    && mentionsRes.mentions.every(m => m.user.id !== grace.user.id));
  check('mentions newest first', mentionsRes.ok
    && mentionsRes.mentions.every((m, i, a) => i === 0 || a[i - 1].id >= m.id));
  const noWsMentions = await api('GET', '/users/me/mentions', { token: grace.token });
  check('mentions require workspace_id', noWsMentions.status === 400);

  console.log('\n— away presence —');
  // grace's websocket is still connected, so she reads as online until she
  // sets herself away; isOnline() must respect the flag.
  const dirBefore = await api('GET', `/users?workspace_id=${wsId}`, { token: ada.token });
  check('grace online before away', dirBefore.users.find(u => u.username === 'grace')?.online === true);
  const goAway = await api('PATCH', '/users/me', { token: grace.token, body: { away: true } });
  check('set away', goAway.ok && goAway.user.away === 1, JSON.stringify(goAway).slice(0, 160));
  const dirAway = await api('GET', `/users?workspace_id=${wsId}`, { token: ada.token });
  const gAway = dirAway.users.find(u => u.username === 'grace');
  check('away user reads offline + away in directory', gAway?.away === true && gAway?.online === false);
  await sleep(200);
  check('away toggle broadcasts presence', wsEvents.some(e =>
    e.type === 'presence' && e.user_id === grace.user.id && e.away === true && e.online === false));
  const goBack = await api('PATCH', '/users/me', { token: grace.token, body: { away: false } });
  check('unset away', goBack.ok && goBack.user.away === 0);
  const dirBack = await api('GET', `/users?workspace_id=${wsId}`, { token: ada.token });
  check('back online after clearing away', dirBack.users.find(u => u.username === 'grace')?.online === true);

  console.log('\n— app platform —');
  const appRes = await api('POST', '/apps', { token: ada.token, body: { workspace_id: wsId, name: 'Deploybot', request_url: `http://localhost:${RECEIVER_PORT}/events` } });
  check('create app', appRes.ok && appRes.app.bot_token.startsWith('xatb-'), JSON.stringify(appRes));
  const appId = appRes.app.id;
  signingSecret = appRes.app.signing_secret;
  const appDenied = await api('POST', '/apps', { token: grace.token, body: { name: 'Nope' } });
  check('non-admin cannot create app', appDenied.status === 403);

  const hook = await api('POST', `/apps/${appId}/webhooks`, { token: ada.token, body: { channel_id: chId } });
  check('create webhook', hook.ok && hook.webhook.url);
  const hookPost = await fetch(`${BASE}${hook.webhook.url}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'deploy finished ✅' }),
  });
  check('webhook posts message', hookPost.ok);
  await sleep(200);
  const afterHook = await api('GET', `/channels/${chId}/messages?limit=5`, { token: ada.token });
  const hookMsg = afterHook.messages.find(m => m.text === 'deploy finished ✅');
  check('webhook message in history', !!hookMsg && hookMsg.user.is_bot === 1);

  const cmd = await api('POST', `/apps/${appId}/commands`, { token: ada.token, body: { command: 'echo', url: `http://localhost:${RECEIVER_PORT}/cmd`, description: 'Echo' } });
  check('register slash command', cmd.ok);
  const sub = await api('POST', `/apps/${appId}/subscriptions`, { token: ada.token, body: { event: 'message.channels' } });
  check('subscribe to event', sub.ok && sub.subscriptions.includes('message.channels'));

  // Second app: slash commands are unique per workspace, and app_mention
  // must not leak channels the bot isn't a member of.
  const app2Res = await api('POST', '/apps', { token: ada.token, body: { workspace_id: wsId, name: 'Mentionbot', request_url: `http://localhost:${RECEIVER_PORT}/events` } });
  check('create second app', app2Res.ok, JSON.stringify(app2Res));
  const app2 = app2Res.app;
  const cmdTaken = await api('POST', `/apps/${app2.id}/commands`, { token: ada.token, body: { command: 'echo', url: `http://localhost:${RECEIVER_PORT}/cmd2` } });
  check('same command on another app → 409 command_taken', cmdTaken.status === 409 && cmdTaken.error === 'command_taken', JSON.stringify(cmdTaken));
  const cmdSelf = await api('POST', `/apps/${appId}/commands`, { token: ada.token, body: { command: 'echo', url: `http://localhost:${RECEIVER_PORT}/cmd` } });
  check('re-register own command is allowed', cmdSelf.ok);

  const subMention = await api('POST', `/apps/${app2.id}/subscriptions`, { token: ada.token, body: { event: 'app_mention' } });
  check('subscribe app_mention', subMention.ok && subMention.subscriptions.includes('app_mention'));
  const mentionChan = await api('POST', '/channels', { token: ada.token, body: { workspace_id: wsId, name: 'mention-test', is_private: true } });
  check('create private channel for mention test', mentionChan.ok);
  const directory = await api('GET', `/users?workspace_id=${wsId}`, { token: ada.token });
  const bot2 = directory.users.find(u => u.username === app2.bot_username);
  check('bot listed in user directory', !!bot2 && bot2.is_bot === 1);

  received.length = 0;
  await api('POST', `/channels/${mentionChan.channel.id}/messages`, { token: ada.token, body: { text: `@${app2.bot_username} hello` } });
  await sleep(500);
  check('app_mention NOT delivered when bot is outside the channel', !received.some(r => r.payload.event === 'app_mention'));
  const addBot = await api('POST', `/channels/${mentionChan.channel.id}/members`, { token: ada.token, body: { user_id: bot2.id } });
  check('add bot to channel', addBot.ok, JSON.stringify(addBot));
  received.length = 0;
  await api('POST', `/channels/${mentionChan.channel.id}/messages`, { token: ada.token, body: { text: `@${app2.bot_username} hello again` } });
  await sleep(500);
  const mentionEvt = received.find(r => r.payload.type === 'event' && r.payload.event === 'app_mention');
  check('app_mention delivered once bot is a member', !!mentionEvt && mentionEvt.payload.data.message.text.includes('hello again'));

  received.length = 0;
  const slash = await api('POST', `/channels/${chId}/messages`, { token: ada.token, body: { text: '/echo hello there' } });
  check('slash command accepted', slash.ok && slash.command === 'echo');
  await sleep(600);
  const cmdCall = received.find(r => r.payload.type === 'slash_command');
  check('slash command dispatched', !!cmdCall && cmdCall.payload.text === 'hello there');
  check('slash signature verified', cmdCall?.verified === true);
  await sleep(300);
  const echoPosted = (await api('GET', `/channels/${chId}/messages?limit=5`, { token: ada.token }))
    .messages.find(m => m.text === 'echo: hello there');
  check('slash response posted as bot', !!echoPosted);

  received.length = 0;
  await api('POST', `/channels/${chId}/messages`, { token: ada.token, body: { text: 'event test' } });
  await sleep(500);
  const evt = received.find(r => r.payload.type === 'event' && r.payload.event === 'message.channels');
  check('events api dispatch', !!evt && evt.payload.data.message.text === 'event test');
  check('event signature verified', evt?.verified === true);

  const botCall = await api('POST', `/channels/${chId}/messages`, { token: appRes.app.bot_token, body: { text: 'bot via token' } });
  check('bot token can post', botCall.ok && botCall.message.user.is_bot === 1);
  const botScoped = await api('GET', '/workspaces', { token: appRes.app.bot_token });
  check('bot sees only its workspace', botScoped.ok && botScoped.workspaces.length === 1);

  const subReact = await api('POST', `/apps/${appId}/subscriptions`, { token: ada.token, body: { event: 'reaction.removed' } });
  check('subscribe reaction.removed', subReact.ok && subReact.subscriptions.includes('reaction.removed'));
  received.length = 0;
  await api('POST', `/messages/${m1.message.id}/reactions`, { token: grace.token, body: { emoji: '🎉' } });
  await api('POST', `/messages/${m1.message.id}/reactions`, { token: grace.token, body: { emoji: '🎉' } });
  await sleep(500);
  const reactEvt = received.find(r => r.payload.type === 'event' && r.payload.event === 'reaction.removed');
  check('reaction.removed dispatched', !!reactEvt && reactEvt.payload.data.reaction.emoji === '🎉');

  const unsub = await api('DELETE', `/apps/${appId}/subscriptions/message.channels`, { token: ada.token });
  check('unsubscribe works', unsub.ok && !unsub.subscriptions.includes('message.channels'));

  const delApp = await api('DELETE', `/apps/${appId}`, { token: ada.token });
  check('app delete succeeds after bot posted', delApp.ok, JSON.stringify(delApp));
  const botAfter = await api('GET', '/auth/me', { token: appRes.app.bot_token });
  check('deleted app bot token rejected', botAfter.status === 401);
  const histAfterDelete = await api('GET', `/channels/${chId}/messages?limit=5`, { token: ada.token });
  check('bot messages keep valid author', histAfterDelete.ok
    && histAfterDelete.messages.some(m => m.text === 'deploy finished ✅' && m.user?.username));

  console.log('\n— change password —');
  const grace2 = await api('POST', '/auth/login', { body: { username: 'grace', password: 'password123' } });
  check('second session for grace', grace2.ok);
  const wrongCurrent = await api('POST', '/auth/change-password', { token: grace.token, body: { current_password: 'nope-nope', new_password: 'newpassword456' } });
  check('change-password rejects wrong current', wrongCurrent.status === 403 && wrongCurrent.error === 'invalid_current_password');
  const shortNew = await api('POST', '/auth/change-password', { token: grace.token, body: { current_password: 'password123', new_password: 'short' } });
  check('change-password requires 8+ chars', shortNew.status === 400 && shortNew.error === 'password_too_short');
  const changed = await api('POST', '/auth/change-password', { token: grace.token, body: { current_password: 'password123', new_password: 'newpassword456' } });
  check('change-password works', changed.ok, JSON.stringify(changed));
  const oldLogin = await api('POST', '/auth/login', { body: { username: 'grace', password: 'password123' } });
  check('old password no longer works', oldLogin.status === 401);
  const newLogin = await api('POST', '/auth/login', { body: { username: 'grace', password: 'newpassword456' } });
  check('new password works', newLogin.ok && newLogin.token);
  const otherSession = await api('GET', '/auth/me', { token: grace2.token });
  check('other sessions destroyed on change', otherSession.status === 401);
  const currentSession = await api('GET', '/auth/me', { token: grace.token });
  check('current session survives change', currentSession.ok);

  console.log('\n— workspace roles —');
  const promote = await api('PATCH', `/workspaces/${wsId}/members/${grace.user.id}`, { token: ada.token, body: { role: 'admin' } });
  check('owner promotes grace to admin', promote.ok && promote.member.role === 'admin', JSON.stringify(promote));
  const selfRole = await api('PATCH', `/workspaces/${wsId}/members/${ada.user.id}`, { token: ada.token, body: { role: 'member' } });
  check('cannot change own role', selfRole.status === 400 && selfRole.error === 'cannot_change_own_role');
  const nonOwnerPatch = await api('PATCH', `/workspaces/${wsId}/members/${ada.user.id}`, { token: grace.token, body: { role: 'member' } });
  check('admin cannot manage roles', nonOwnerPatch.status === 403 && nonOwnerPatch.error === 'owner_required');
  const badRole = await api('PATCH', `/workspaces/${wsId}/members/${grace.user.id}`, { token: ada.token, body: { role: 'superadmin' } });
  check('invalid role rejected', badRole.status === 400 && badRole.error === 'invalid_role');
  const demote = await api('PATCH', `/workspaces/${wsId}/members/${grace.user.id}`, { token: ada.token, body: { role: 'member' } });
  check('owner demotes grace back to member', demote.ok && demote.member.role === 'member');
  const malloryKick = await api('DELETE', `/workspaces/${wsId}/members/${grace.user.id}`, { token: mallory.token });
  check('member cannot kick', malloryKick.status === 403 && malloryKick.error === 'admin_required');
  const kickHenry = await api('DELETE', `/workspaces/${wsId}/members/${henry.user.id}`, { token: ada.token });
  check('owner kicks henry', kickHenry.ok, JSON.stringify(kickHenry));
  const henryAfter = await api('GET', `/workspaces/${wsId}`, { token: henry.token });
  check('kicked user loses workspace access', henryAfter.status === 403);
  const henryChans = await api('GET', `/channels?workspace_id=${wsId}`, { token: henry.token });
  check('kicked user loses channel memberships', henryChans.status === 403);
  const detailAfterKick = await api('GET', `/workspaces/${wsId}`, { token: ada.token });
  check('member list no longer includes henry', detailAfterKick.ok && !detailAfterKick.members.some(m => m.id === henry.user.id));

  console.log('\n— invites & domain auto-join —');
  const badPatch = await api('PATCH', `/workspaces/${wsId}`, { token: grace.token, body: { allowed_domains: 'graceco.com' } });
  check('member cannot set allowed domains', badPatch.status === 403);
  const badDomain = await api('PATCH', `/workspaces/${wsId}`, { token: ada.token, body: { allowed_domains: 'not a domain' } });
  check('invalid domain rejected', badDomain.status === 400 && badDomain.error === 'invalid_domain');
  const patchDomains = await api('PATCH', `/workspaces/${wsId}`, { token: ada.token, body: { allowed_domains: '@Acme.com, acme.io' } });
  check('allowed domains saved (normalized)', patchDomains.ok && patchDomains.workspace.allowed_domains === 'acme.com,acme.io');

  const ivy = await api('POST', '/auth/register', { body: { username: 'ivy', email: 'ivy@acme.com', password: 'password123' } });
  check('register ivy@acme.com', ivy.ok);
  const ivyWs = await api('GET', '/workspaces', { token: ivy.token });
  check('matching domain auto-joins at register', ivyWs.ok && ivyWs.workspaces.some(w => w.id === wsId));
  const ivyChans = await api('GET', `/channels?workspace_id=${wsId}`, { token: ivy.token });
  check('domain join lands in general', ivyChans.ok && ivyChans.channels.some(c => c.name === 'general' && c.is_member));

  const noah = await api('POST', '/auth/register', { body: { username: 'noah', email: 'noah@other.com', password: 'password123' } });
  const noahWs = await api('GET', '/workspaces', { token: noah.token });
  check('non-matching domain does not auto-join', noahWs.ok && noahWs.workspaces.length === 0);

  // Login catch-up: domain added after the account exists.
  await api('PATCH', `/workspaces/${wsId}`, { token: ada.token, body: { allowed_domains: 'other.com' } });
  const noahLogin = await api('POST', '/auth/login', { body: { username: 'noah', password: 'password123' } });
  check('login works', noahLogin.ok);
  const noahWs2 = await api('GET', '/workspaces', { token: noah.token });
  check('login catches up on domain joins', noahWs2.ok && noahWs2.workspaces.some(w => w.id === wsId));
  await api('PATCH', `/workspaces/${wsId}`, { token: ada.token, body: { allowed_domains: '' } });

  const inviteList = await api('GET', `/workspaces/${wsId}/invites`, { token: ada.token });
  check('admin lists invites', inviteList.ok && inviteList.invites.length >= 1);
  const memberList = await api('GET', `/workspaces/${wsId}/invites`, { token: grace.token });
  check('member cannot list invites', memberList.status === 403);

  const oneTime = await api('POST', `/workspaces/${wsId}/invites`, { token: ada.token, body: { max_uses: 1 } });
  check('create one-time invite', oneTime.ok);
  const rachel = await api('POST', '/auth/register', { body: { username: 'rachel', password: 'password123' } });
  const ot1 = await api('POST', '/workspaces/join', { token: rachel.token, body: { code: oneTime.invite.code } });
  check('first one-time join works', ot1.ok);
  const peter = await api('POST', '/auth/register', { body: { username: 'peter', password: 'password123' } });
  const ot2 = await api('POST', '/workspaces/join', { token: peter.token, body: { code: oneTime.invite.code } });
  check('one-time invite exhausts', ot2.status === 410 && ot2.error === 'invite_exhausted', `got ${ot2.status} ${ot2.error}`);

  const infinite = await api('POST', `/workspaces/${wsId}/invites`, { token: ada.token, body: {} });
  const inf1 = await api('POST', '/workspaces/join', { token: peter.token, body: { code: infinite.invite.code } });
  check('infinite invite works', inf1.ok);
  const revoke = await api('DELETE', `/workspaces/${wsId}/invites/${infinite.invite.code}`, { token: ada.token });
  check('revoke invite', revoke.ok);
  const quinn = await api('POST', '/auth/register', { body: { username: 'quinn', password: 'password123' } });
  const inf2 = await api('POST', '/workspaces/join', { token: quinn.token, body: { code: infinite.invite.code } });
  check('revoked invite rejected', inf2.status === 404);
} catch (err) {
  failed++;
  console.error('SMOKE CRASH:', err);
} finally {
  wsClient?.close?.();
  server.kill();
  receiver.close();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
