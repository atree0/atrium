// Shared message creation + serialization, used by REST routes, webhooks,
// slash-command responses, and bots. Emits bus events for realtime fan-out
// and the app platform.
import { get, all, run, now } from '../db.js';
import { emit } from '../bus.js';
import { broadcastToChannel, isOnline } from '../realtime.js';

// Mention syntax: @user (shadow users included, name@host), plus the broadcast
// mentions @channel/@everyone (all channel members) and @here (online ones).
export function parseMentions(text, workspaceId, channelId = null) {
  if (!text) return [];
  const names = [...text.matchAll(/@([A-Za-z0-9_.-]+(?:@[A-Za-z0-9_.-]+)?)/g)].map(m => m[1].toLowerCase());
  if (!names.length) return [];
  const ids = new Set();
  const lookup = [];
  let memberIds = null;
  const channelMembers = () =>
    memberIds ??= all('SELECT user_id FROM channel_members WHERE channel_id = ?', channelId).map(r => r.user_id);
  for (const n of names) {
    if (n === 'channel' || n === 'everyone') {
      if (channelId) for (const id of channelMembers()) ids.add(id);
    } else if (n === 'here') {
      if (channelId) for (const id of channelMembers()) if (isOnline(id)) ids.add(id);
    } else {
      lookup.push(n);
    }
  }
  if (lookup.length) {
    const rows = all(
      `SELECT u.id, u.username FROM users u
       JOIN workspace_members wm ON wm.user_id = u.id
       WHERE wm.workspace_id = ?`, workspaceId
    );
    const byName = new Map(rows.map(r => [r.username.toLowerCase(), r.id]));
    for (const n of lookup) {
      const id = byName.get(n);
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

export function serializeMessage(msg, viewerId = null) {
  return serializeMessages([msg], viewerId)[0];
}

// Batch serializer: one IN() query each for users, reactions, reply counts,
// and pins, instead of four queries per message.
export function serializeMessages(rows, viewerId = null) {
  if (!rows.length) return [];
  const ids = rows.map(m => m.id);
  const ph = ids.map(() => '?').join(',');

  const usersById = new Map(
    all(`SELECT id, username, display_name, avatar_url, is_bot, is_remote, remote_url FROM users
         WHERE id IN (SELECT DISTINCT user_id FROM messages WHERE id IN (${ph}))`, ...ids)
      .map(u => [u.id, u])
  );

  const reactionsByMsg = new Map();
  for (const r of all(
    `SELECT message_id, emoji, COUNT(*) AS count, GROUP_CONCAT(user_id) AS users
     FROM reactions WHERE message_id IN (${ph}) GROUP BY message_id, emoji
     ORDER BY message_id, created_at`, ...ids
  )) {
    if (!reactionsByMsg.has(r.message_id)) reactionsByMsg.set(r.message_id, []);
    const users = String(r.users).split(',').map(Number);
    reactionsByMsg.get(r.message_id).push({
      emoji: r.emoji,
      count: r.count,
      users,
      reacted: viewerId ? users.includes(viewerId) : false,
    });
  }

  const parentIds = rows.filter(m => m.thread_id == null).map(m => m.id);
  const replyCounts = new Map();
  if (parentIds.length) {
    const pph = parentIds.map(() => '?').join(',');
    for (const r of all(
      `SELECT thread_id, COUNT(*) AS c FROM messages
       WHERE thread_id IN (${pph}) AND deleted = 0 GROUP BY thread_id`, ...parentIds
    )) replyCounts.set(r.thread_id, r.c);
  }

  const pinned = new Set(
    all(`SELECT message_id FROM pins WHERE message_id IN (${ph})`, ...ids).map(r => r.message_id)
  );

  return rows.map(msg => ({
    id: msg.id,
    channel_id: msg.channel_id,
    user: usersById.get(msg.user_id),
    text: msg.text,
    thread_id: msg.thread_id ?? null,
    reply_count: msg.thread_id == null ? (replyCounts.get(msg.id) || 0) : 0,
    attachments: JSON.parse(msg.attachments || '[]'),
    mentions: JSON.parse(msg.mentions || '[]'),
    reactions: reactionsByMsg.get(msg.id) || [],
    pinned: pinned.has(msg.id),
    edited_at: msg.edited_at ?? null,
    created_at: msg.created_at,
  }));
}

// Creates a message, broadcasts `message.new` to channel members, and emits
// bus events consumed by the app platform. `fedRef`/`createdAt` support
// federation relay copies. Returns the serialized message.
export function createMessage({ channelId, userId, text, threadId = null, attachments = [], fedRef = null, createdAt = null }) {
  const channel = get('SELECT * FROM channels WHERE id = ?', channelId);
  if (!channel) throw Object.assign(new Error('channel_not_found'), { code: 'channel_not_found' });

  const mentions = parseMentions(text, channel.workspace_id, channel.id);
  const result = run(
    `INSERT INTO messages (channel_id, user_id, text, thread_id, attachments, mentions, fed_ref, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    channelId, userId, text ?? '', threadId, JSON.stringify(attachments),
    JSON.stringify(mentions), fedRef, createdAt ?? now()
  );
  const msg = get('SELECT * FROM messages WHERE id = ?', Number(result.lastInsertRowid));
  const serialized = serializeMessage(msg);

  broadcastToChannel(channelId, { type: 'message.new', workspace_id: channel.workspace_id, message: serialized });

  const busPayload = { message: serialized, channel, workspace_id: channel.workspace_id };
  emit('message.new', busPayload);
  emit(channel.is_dm ? 'message.im' : 'message.channels', busPayload);
  if (mentions.length) emit('app_mention', busPayload);

  // Link unfurling is async — never block the response on it.
  import('./unfurl.js').then(({ unfurlMessage }) => {
    unfurlMessage(msg, text ?? '');
  }).catch(() => { /* unfurling is best-effort */ });

  return serialized;
}
