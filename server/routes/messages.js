// Message routes: history, post (with slash-command detection), edit, delete,
// reactions, pins, threads, and workspace-wide search.
import { Router } from 'express';
import { get, all, run, now } from '../db.js';
import { authenticate } from '../auth.js';
import { sendError, channelMember, canReadChannel } from '../lib/guards.js';
import { createMessage, serializeMessage, serializeMessages, parseMentions } from '../lib/messages.js';
import { refreshUnfurl } from '../lib/unfurl.js';
import { invokeSlashCommand } from '../apps.js';
import { broadcastToChannel } from '../realtime.js';
import { emit } from '../bus.js';
import { rateLimit } from '../lib/ratelimit.js';

const router = Router();
router.use(authenticate);

const messagePostLimiter = rateLimit({ windowMs: 60_000, max: 60, keyFn: req => String(req.user.id) });
const searchLimiter = rateLimit({ windowMs: 60_000, max: 30, keyFn: req => String(req.user.id) });
const reactionLimiter = rateLimit({ windowMs: 60_000, max: 120, keyFn: req => String(req.user.id) });

const ATTACHMENT_URL_RE = /^(\/uploads\/[A-Za-z0-9.-]+|https?:\/\/)/;

// Keep only well-formed attachment objects, stripped to known fields.
// {type:'link'} attachments are dropped entirely — link unfurls are computed
// server-side, never accepted from clients. File attachments may point at
// /uploads/... or external http(s) URLs; their declared mimetype is kept
// as-is (clients render external files as cards, not inline images).
function cleanAttachments(input) {
  if (!Array.isArray(input)) return { error: 'invalid_attachments' };
  const out = [];
  for (const a of input) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return { error: 'invalid_attachment' };
    if (a.type === 'link') continue;
    const url = String(a.url || '');
    if (!ATTACHMENT_URL_RE.test(url)) return { error: 'invalid_attachment_url' };
    const name = String(a.name || '');
    if (name.length > 200) return { error: 'invalid_attachment_name' };
    out.push({
      url,
      name,
      size: Number.isFinite(a.size) ? a.size : 0,
      mimetype: String(a.mimetype || ''),
    });
  }
  return { attachments: out };
}

// GET /channels/:id/messages?before=<id>&after=<id>&around=<id>&limit=50 —
// top-level messages, ascending within the page. Default (`before`) pages
// backwards with `has_more`; `after` returns the newest page with id > after;
// `around` returns 25 before + target + 25 after with has_more_before/after.
router.get('/channels/:id/messages', (req, res) => {
  const channel = get('SELECT * FROM channels WHERE id = ?', req.params.id);
  if (!canReadChannel(req, channel)) return sendError(res, 404, 'channel_not_found');
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const base = 'SELECT * FROM messages WHERE channel_id = ? AND thread_id IS NULL AND deleted = 0';

  if (req.query.around !== undefined) {
    const around = Number(req.query.around);
    if (!Number.isFinite(around)) return sendError(res, 400, 'invalid_around');
    const half = Math.max(1, Math.floor(limit / 2));
    const beforeRows = all(`${base} AND id < ? ORDER BY id DESC LIMIT ?`, channel.id, around, half + 1);
    const hasMoreBefore = beforeRows.length > half;
    const afterRows = all(`${base} AND id > ? ORDER BY id ASC LIMIT ?`, channel.id, around, half + 1);
    const hasMoreAfter = afterRows.length > half;
    const target = all(`${base} AND id = ?`, channel.id, around);
    const page = [
      ...beforeRows.slice(0, half).reverse(),
      ...target,
      ...afterRows.slice(0, half),
    ];
    return res.json({
      ok: true,
      messages: serializeMessages(page, req.user.id),
      has_more_before: hasMoreBefore,
      has_more_after: hasMoreAfter,
    });
  }

  if (req.query.after !== undefined) {
    const after = Number(req.query.after);
    if (!Number.isFinite(after)) return sendError(res, 400, 'invalid_after');
    const rows = all(`${base} AND id > ? ORDER BY id DESC LIMIT ?`, channel.id, after, limit);
    return res.json({ ok: true, messages: serializeMessages(rows.reverse(), req.user.id) });
  }

  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const rows = all(`${base} AND id < ? ORDER BY id DESC LIMIT ?`, channel.id, before, limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  res.json({ ok: true, messages: serializeMessages(page, req.user.id), has_more: hasMore });
});

// GET /messages/:id/thread — replies to a parent message.
router.get('/messages/:id/thread', (req, res) => {
  const parent = get('SELECT * FROM messages WHERE id = ? AND deleted = 0', req.params.id);
  if (!parent) return sendError(res, 404, 'message_not_found');
  const channel = get('SELECT * FROM channels WHERE id = ?', parent.channel_id);
  if (!canReadChannel(req, channel)) return sendError(res, 404, 'message_not_found');
  const rows = all(
    'SELECT * FROM messages WHERE thread_id = ? AND deleted = 0 ORDER BY id LIMIT 500', parent.id
  );
  res.json({
    ok: true,
    parent: serializeMessage(parent, req.user.id),
    messages: serializeMessages(rows, req.user.id),
  });
});

// POST /channels/:id/messages { text, thread_id?, attachments? }
// Texts starting with `/command ...` are routed to the app platform instead
// of being posted, when a matching slash command exists in this workspace.
router.post('/channels/:id/messages', messagePostLimiter, (req, res) => {
  const { channel, member } = channelMember(req, req.params.id);
  if (!channel || !canReadChannel(req, channel)) return sendError(res, 404, 'channel_not_found');
  if (channel.is_archived) return sendError(res, 400, 'channel_archived');
  if (!member) {
    // Posting requires membership; public channels auto-join the poster.
    if (channel.is_private || channel.is_dm) return sendError(res, 403, 'not_in_channel');
    run('INSERT INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)',
      channel.id, req.user.id, now());
  }
  const text = String(req.body?.text ?? '').slice(0, 40000);
  const cleaned = cleanAttachments(req.body?.attachments ?? []);
  if (cleaned.error) return sendError(res, 400, cleaned.error);
  if (!text && !cleaned.attachments.length) return sendError(res, 400, 'text_required');

  const slash = text.match(/^\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i);
  if (slash) {
    const result = invokeSlashCommand({
      command: slash[1].toLowerCase(), args: slash[2] || '', user: req.user, channel,
    });
    if (result.handled) return res.json({ ok: true, command: slash[1].toLowerCase() });
    // Unknown command: fall through and post as a normal message.
  }

  let threadId = req.body?.thread_id ? Number(req.body.thread_id) : null;
  if (threadId) {
    const parent = get('SELECT * FROM messages WHERE id = ? AND channel_id = ? AND deleted = 0', threadId, channel.id);
    if (!parent) return sendError(res, 404, 'thread_not_found');
    if (parent.thread_id) threadId = parent.thread_id; // threads are one level deep
  }
  const message = createMessage({
    channelId: channel.id, userId: req.user.id, text, threadId, attachments: cleaned.attachments,
  });
  res.json({ ok: true, message });
});

router.patch('/messages/:id', (req, res) => {
  const msg = get('SELECT * FROM messages WHERE id = ? AND deleted = 0', req.params.id);
  if (!msg) return sendError(res, 404, 'message_not_found');
  const channel = get('SELECT * FROM channels WHERE id = ?', msg.channel_id);
  // Leaving a private channel must revoke edit rights.
  if (!canReadChannel(req, channel)) return sendError(res, 404, 'message_not_found');
  if (msg.user_id !== req.user.id) return sendError(res, 403, 'not_your_message');
  const text = String(req.body?.text ?? '').slice(0, 40000);
  if (!text) return sendError(res, 400, 'text_required');
  const mentions = parseMentions(text, channel.workspace_id, channel.id);
  run('UPDATE messages SET text = ?, mentions = ?, edited_at = ? WHERE id = ?',
    text, JSON.stringify(mentions), now(), msg.id);
  // Strip/carry link attachments before serializing; re-unfurl is async.
  refreshUnfurl(msg, text);
  const fresh = get('SELECT * FROM messages WHERE id = ?', msg.id);
  // Broadcasts go out without a viewer id (clients compute `reacted`);
  // the REST response keeps the caller as viewer.
  broadcastToChannel(msg.channel_id, {
    type: 'message.updated', workspace_id: channel.workspace_id, message: serializeMessage(fresh),
  });
  const updated = serializeMessage(fresh, req.user.id);
  emit('message.updated', { message: updated, channel, workspace_id: channel.workspace_id });
  res.json({ ok: true, message: updated });
});

router.delete('/messages/:id', (req, res) => {
  const msg = get('SELECT * FROM messages WHERE id = ? AND deleted = 0', req.params.id);
  if (!msg) return sendError(res, 404, 'message_not_found');
  const channel = get('SELECT * FROM channels WHERE id = ?', msg.channel_id);
  if (!canReadChannel(req, channel)) return sendError(res, 404, 'message_not_found');
  const isOwner = msg.user_id === req.user.id;
  const wsRole = get(
    'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
    channel.workspace_id, req.user.id
  );
  if (!isOwner && !['owner', 'admin'].includes(wsRole?.role)) {
    return sendError(res, 403, 'not_allowed');
  }
  // Soft-deleting a thread parent takes its replies with it; each reply id
  // gets its own delete event so clients and federation can drop them too.
  const replyIds = all('SELECT id FROM messages WHERE thread_id = ? AND deleted = 0', msg.id)
    .map(r => r.id);
  run('UPDATE messages SET deleted = 1 WHERE id = ? OR thread_id = ?', msg.id, msg.id);
  broadcastToChannel(msg.channel_id, { type: 'message.deleted', id: msg.id, channel_id: msg.channel_id });
  emit('message.deleted', {
    message: { id: msg.id, channel_id: msg.channel_id },
    channel, workspace_id: channel.workspace_id,
  });
  for (const id of replyIds) {
    broadcastToChannel(msg.channel_id, { type: 'message.deleted', id, channel_id: msg.channel_id });
    emit('message.deleted', {
      message: { id, channel_id: msg.channel_id },
      channel, workspace_id: channel.workspace_id,
    });
  }
  res.json({ ok: true });
});

// POST /messages/:id/reactions { emoji } — toggles the caller's reaction.
router.post('/messages/:id/reactions', reactionLimiter, (req, res) => {
  const msg = get('SELECT * FROM messages WHERE id = ? AND deleted = 0', req.params.id);
  if (!msg) return sendError(res, 404, 'message_not_found');
  const channel = get('SELECT * FROM channels WHERE id = ?', msg.channel_id);
  if (!canReadChannel(req, channel)) return sendError(res, 404, 'message_not_found');
  const emoji = String(req.body?.emoji || '').slice(0, 32);
  if (!emoji) return sendError(res, 400, 'emoji_required');

  const existing = get('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
    msg.id, req.user.id, emoji);
  if (existing) {
    run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', msg.id, req.user.id, emoji);
  } else {
    run('INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)',
      msg.id, req.user.id, emoji, now());
  }
  const fresh = get('SELECT * FROM messages WHERE id = ?', msg.id);
  broadcastToChannel(msg.channel_id, {
    type: 'message.updated', workspace_id: channel.workspace_id, message: serializeMessage(fresh),
  });
  const updated = serializeMessage(fresh, req.user.id);
  const busPayload = {
    reaction: { emoji, user_id: req.user.id },
    message: updated, channel, workspace_id: channel.workspace_id,
  };
  // Emit only the transition that actually happened.
  emit(existing ? 'reaction.removed' : 'reaction.added', busPayload);
  res.json({ ok: true, message: updated });
});

// POST /messages/:id/pin — toggles the pin state in the message's channel.
router.post('/messages/:id/pin', (req, res) => {
  const msg = get('SELECT * FROM messages WHERE id = ? AND deleted = 0', req.params.id);
  if (!msg) return sendError(res, 404, 'message_not_found');
  const { channel, member } = channelMember(req, msg.channel_id);
  if (!member) return sendError(res, 403, 'not_in_channel');
  const existing = get('SELECT 1 FROM pins WHERE channel_id = ? AND message_id = ?', msg.channel_id, msg.id);
  if (existing) {
    run('DELETE FROM pins WHERE channel_id = ? AND message_id = ?', msg.channel_id, msg.id);
  } else {
    run('INSERT INTO pins (channel_id, message_id, pinned_by, created_at) VALUES (?, ?, ?, ?)',
      msg.channel_id, msg.id, req.user.id, now());
  }
  const fresh = get('SELECT * FROM messages WHERE id = ?', msg.id);
  broadcastToChannel(msg.channel_id, {
    type: 'message.updated', workspace_id: channel.workspace_id, message: serializeMessage(fresh),
  });
  const updated = serializeMessage(fresh, req.user.id);
  res.json({ ok: true, pinned: !existing, message: updated });
});

// GET /search?workspace_id=N&q=text — FTS5 search, newest first.
// Supports `from:username` and `in:channel-name` filters; free-text tokens
// are quote-escaped and ANDed. Returns serialized messages with a snippet.
router.get('/search', searchLimiter, (req, res) => {
  const workspaceId = Number(req.query.workspace_id);
  const raw = String(req.query.q || '').trim();
  if (!workspaceId || !raw) return sendError(res, 400, 'query_required');
  if (!get('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?', workspaceId, req.user.id)) {
    return sendError(res, 403, 'not_a_member');
  }

  let fromUser = null;
  let inChannel = null;
  const terms = [];
  for (const token of raw.split(/\s+/).filter(Boolean)) {
    let m;
    if ((m = token.match(/^from:(\S+)$/i))) fromUser = m[1].replace(/^@/, '').toLowerCase();
    else if ((m = token.match(/^in:(\S+)$/i))) inChannel = m[1].replace(/^#/, '').toLowerCase();
    else terms.push(token);
  }

  // Reject empty and wildcard/punctuation-only queries — they can never match.
  if (!terms.length || !terms.some(t => /[\p{L}\p{N}]/u.test(t))) {
    return sendError(res, 400, 'query_required');
  }
  // Quote each token so FTS5 metacharacters can't inject syntax.
  const match = terms
    .map(t => `"${t.replace(/"/g, '""')}"`)
    .join(' AND ');

  const params = [match, workspaceId, req.user.id];
  let sql = `
    SELECT m.*, c.name AS channel_name,
           snippet(messages_fts, 0, '<mark>', '</mark>', '…', 32) AS snippet
    FROM messages_fts
    JOIN messages m ON m.id = messages_fts.rowid
    JOIN channels c ON c.id = m.channel_id
    WHERE messages_fts MATCH ?
      AND c.workspace_id = ? AND m.deleted = 0
      AND (c.is_private = 0 AND c.is_dm = 0
           OR m.channel_id IN (SELECT channel_id FROM channel_members WHERE user_id = ?))`;
  if (fromUser) {
    sql += ' AND m.user_id IN (SELECT id FROM users WHERE username = ?)';
    params.push(fromUser);
  }
  if (inChannel) {
    sql += " AND c.name = ? AND c.is_dm = 0";
    params.push(inChannel);
  }
  sql += ' ORDER BY m.id DESC LIMIT 50';

  let rows;
  try {
    rows = all(sql, ...params);
  } catch {
    return sendError(res, 400, 'invalid_query');
  }
  const serialized = serializeMessages(rows, req.user.id);
  res.json({
    ok: true,
    query: raw,
    results: rows.map((r, i) => ({
      ...serialized[i], channel_name: r.channel_name, snippet: r.snippet,
    })),
  });
});

export default router;
