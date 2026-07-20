// Channel routes: list (with unread state), create, join/leave, rename/archive,
// members, read markers, pins, star/mute, and DMs.
import { Router } from 'express';
import { get, all, run, now } from '../db.js';
import { authenticate } from '../auth.js';
import { sendError, workspaceMember, channelMember, canReadChannel } from '../lib/guards.js';
import { serializeMessages } from '../lib/messages.js';
import { broadcastToChannel, sendToUser, isOnline } from '../realtime.js';
import { emit } from '../bus.js';

const router = Router();
router.use(authenticate);

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/i;

// Channel JSON with viewer-specific state (membership, unread, star/mute).
// Unread and mention counts come from ONE scan of the channel's newer
// messages; mentions are matched inside the stored JSON array textually.
function channelWithState(userId, channel) {
  const member = get(
    'SELECT * FROM channel_members WHERE channel_id = ? AND user_id = ?',
    channel.id, userId
  );
  const lastRead = member?.last_read_id || 0;
  const counts = get(
    `SELECT COUNT(*) AS unread,
            COALESCE(SUM(
              (',' || replace(replace(replace(m.mentions, '[', ''), ']', ''), ' ', '') || ',')
              LIKE '%,' || ? || ',%'
            ), 0) AS mentions
     FROM messages m
     WHERE m.channel_id = ? AND m.thread_id IS NULL AND m.deleted = 0 AND m.id > ? AND m.user_id != ?`,
    String(userId), channel.id, lastRead, userId
  );
  const memberCount = get('SELECT COUNT(*) AS c FROM channel_members WHERE channel_id = ?', channel.id).c;
  const { dm_key, ...rest } = channel;
  return {
    ...rest,
    is_member: !!member,
    starred: !!member?.starred,
    muted: !!member?.muted,
    member_count: memberCount,
    last_read_id: lastRead,
    unread_count: counts.unread,
    mention_count: counts.mentions,
    dm_users: channel.is_dm
      ? all(
        `SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_remote, u.remote_url
         FROM channel_members cm
         JOIN users u ON u.id = cm.user_id WHERE cm.channel_id = ? AND u.id != ?`,
        channel.id, userId
      )
      : undefined,
  };
}

// WS fan-out for a new channel: each member gets the channel serialized for
// THEM (unread/dm_users differ per viewer). Private channels and DMs go to
// members only; public channels go workspace-wide.
function announceChannel(channel, memberIds) {
  if (channel.is_private || channel.is_dm) {
    for (const id of memberIds) {
      sendToUser(id, { type: 'channel.created', channel: channelWithState(id, channel) });
    }
  } else {
    const members = all('SELECT user_id FROM workspace_members WHERE workspace_id = ?', channel.workspace_id);
    for (const m of members) {
      sendToUser(m.user_id, { type: 'channel.created', channel: channelWithState(m.user_id, channel) });
    }
  }
}

// WS fan-out for channel updates: private channels must not leak metadata
// to non-members, so members only; public channels workspace-wide.
function announceChannelUpdate(channel) {
  if (channel.is_private || channel.is_dm) {
    const members = all('SELECT user_id FROM channel_members WHERE channel_id = ?', channel.id);
    for (const m of members) {
      sendToUser(m.user_id, { type: 'channel.updated', channel: channelWithState(m.user_id, channel) });
    }
  } else {
    const members = all('SELECT user_id FROM workspace_members WHERE workspace_id = ?', channel.workspace_id);
    for (const m of members) {
      sendToUser(m.user_id, { type: 'channel.updated', channel: channelWithState(m.user_id, channel) });
    }
  }
}

function isWorkspaceAdmin(req, workspaceId) {
  const member = get(
    'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
    workspaceId, req.user.id
  );
  return ['owner', 'admin'].includes(member?.role);
}

// GET /channels?workspace_id=N[&include_archived=1] — everything the user can
// see: public channels + own private channels + own DMs.
router.get('/', (req, res) => {
  const workspaceId = Number(req.query.workspace_id);
  if (!workspaceMember(req, workspaceId)) return sendError(res, 403, 'not_a_member');
  const channels = all(
    `SELECT * FROM channels
     WHERE workspace_id = ? AND (? = 1 OR is_archived = 0) AND (
       (is_private = 0 AND is_dm = 0)
       OR id IN (SELECT channel_id FROM channel_members WHERE user_id = ?)
     ) ORDER BY is_dm, name`,
    workspaceId, req.query.include_archived === '1' ? 1 : 0, req.user.id
  );
  res.json({ ok: true, channels: channels.map(c => channelWithState(req.user.id, c)) });
});

router.post('/', (req, res) => {
  const workspaceId = Number(req.body?.workspace_id);
  if (!workspaceMember(req, workspaceId)) return sendError(res, 403, 'not_a_member');
  const name = String(req.body?.name || '').trim().replace(/^#/, '').toLowerCase();
  if (!NAME_RE.test(name)) return sendError(res, 400, 'invalid_channel_name');
  if (get('SELECT 1 FROM channels WHERE workspace_id = ? AND name = ? AND is_dm = 0', workspaceId, name)) {
    return sendError(res, 409, 'channel_name_taken');
  }
  const result = run(
    `INSERT INTO channels (workspace_id, name, topic, purpose, is_private, is_dm, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    workspaceId, name, String(req.body?.topic || '').slice(0, 250),
    String(req.body?.purpose || '').slice(0, 250),
    req.body?.is_private ? 1 : 0, req.user.id, now()
  );
  const channel = get('SELECT * FROM channels WHERE id = ?', Number(result.lastInsertRowid));
  run('INSERT INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)',
    channel.id, req.user.id, now());
  announceChannel(channel, [req.user.id]);
  emit('channel.created', { channel, workspace_id: workspaceId });
  res.json({ ok: true, channel: channelWithState(req.user.id, channel) });
});

// POST /channels/dm — open (or fetch) a DM with one or more users.
router.post('/dm', (req, res) => {
  const workspaceId = Number(req.body?.workspace_id);
  if (!workspaceMember(req, workspaceId)) return sendError(res, 403, 'not_a_member');
  if (!Array.isArray(req.body?.user_ids)
      || !req.body.user_ids.every(id => Number.isFinite(Number(id)))) {
    return sendError(res, 400, 'invalid_user_ids');
  }
  const others = [...new Set(req.body.user_ids.map(Number))].filter(id => id !== req.user.id);
  if (others.length + 1 > 9) return sendError(res, 400, 'too_many_participants');
  const userIds = [req.user.id, ...others].sort((a, b) => a - b);
  for (const id of userIds) {
    if (!get('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?', workspaceId, id)) {
      return sendError(res, 400, 'user_not_in_workspace');
    }
    // Remote shadow users live on another server — DMs with them must go
    // through federation (POST /federation/dm), not a dead local DM.
    if (get('SELECT 1 FROM users WHERE id = ? AND is_remote = 1', id)) {
      return sendError(res, 400, 'use_external_dm');
    }
  }
  const dmKey = userIds.join(',');
  let channel = get('SELECT * FROM channels WHERE workspace_id = ? AND dm_key = ? AND is_dm = 1', workspaceId, dmKey);
  if (!channel) {
    const names = userIds.map(id => get('SELECT username FROM users WHERE id = ?', id)?.username || 'user');
    const result = run(
      `INSERT INTO channels (workspace_id, name, is_private, is_dm, dm_key, created_by, created_at)
       VALUES (?, ?, 1, 1, ?, ?, ?)`,
      workspaceId, names.join(','), dmKey, req.user.id, now()
    );
    channel = get('SELECT * FROM channels WHERE id = ?', Number(result.lastInsertRowid));
    for (const id of userIds) {
      run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)',
        channel.id, id, now());
    }
    announceChannel(channel, userIds);
  }
  res.json({ ok: true, channel: channelWithState(req.user.id, channel) });
});

router.get('/:id', (req, res) => {
  const channel = get('SELECT * FROM channels WHERE id = ?', req.params.id);
  if (!canReadChannel(req, channel)) return sendError(res, 403, 'channel_not_found');
  res.json({ ok: true, channel: channelWithState(req.user.id, channel) });
});

// PATCH /channels/:id { name?, topic?, purpose?, is_archived? }
// Every field requires channel membership (or workspace admin). Rename also
// accepts the channel creator; archive is admin-only.
router.patch('/:id', (req, res) => {
  const { channel, member } = channelMember(req, req.params.id);
  if (!channel || !canReadChannel(req, channel)) return sendError(res, 404, 'channel_not_found');
  if (channel.is_dm) return sendError(res, 400, 'cannot_edit_dm');
  const admin = isWorkspaceAdmin(req, channel.workspace_id);
  if (!member && !admin) return sendError(res, 403, 'not_allowed');

  const updates = { topic: channel.topic, purpose: channel.purpose, name: channel.name, is_archived: channel.is_archived };
  if (req.body?.topic !== undefined) updates.topic = String(req.body.topic).slice(0, 250);
  if (req.body?.purpose !== undefined) updates.purpose = String(req.body.purpose).slice(0, 250);
  if (req.body?.name !== undefined) {
    if (channel.created_by !== req.user.id && !admin) return sendError(res, 403, 'not_allowed');
    const name = String(req.body.name).trim().replace(/^#/, '').toLowerCase();
    if (!NAME_RE.test(name)) return sendError(res, 400, 'invalid_channel_name');
    if (get('SELECT 1 FROM channels WHERE workspace_id = ? AND name = ? AND is_dm = 0 AND id != ?',
      channel.workspace_id, name, channel.id)) {
      return sendError(res, 409, 'channel_name_taken');
    }
    updates.name = name;
  }
  if (req.body?.is_archived !== undefined) {
    if (!admin) return sendError(res, 403, 'admin_required');
    updates.is_archived = req.body.is_archived ? 1 : 0;
  }
  run('UPDATE channels SET name = ?, topic = ?, purpose = ?, is_archived = ? WHERE id = ?',
    updates.name, updates.topic, updates.purpose, updates.is_archived, channel.id);
  const updated = get('SELECT * FROM channels WHERE id = ?', channel.id);
  announceChannelUpdate(updated);
  res.json({ ok: true, channel: channelWithState(req.user.id, updated) });
});

router.post('/:id/join', (req, res) => {
  const channel = get('SELECT * FROM channels WHERE id = ?', req.params.id);
  if (!channel || !workspaceMember(req, channel.workspace_id)) return sendError(res, 404, 'channel_not_found');
  if (channel.is_private || channel.is_dm) return sendError(res, 403, 'channel_is_private');
  const result = run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)',
    channel.id, req.user.id, now());
  if (result.changes > 0) {
    broadcastToChannel(channel.id, {
      type: 'channel.member_joined', channel_id: channel.id, user_id: req.user.id,
    });
  }
  res.json({ ok: true, channel: channelWithState(req.user.id, channel) });
});

router.post('/:id/leave', (req, res) => {
  const { channel, member } = channelMember(req, req.params.id);
  if (!channel || !member) return sendError(res, 404, 'channel_not_found');
  if (channel.is_dm) return sendError(res, 400, 'cannot_leave_dm');
  run('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?', channel.id, req.user.id);
  broadcastToChannel(channel.id, {
    type: 'channel.member_left', channel_id: channel.id, user_id: req.user.id,
  });
  res.json({ ok: true });
});

router.get('/:id/members', (req, res) => {
  const channel = get('SELECT * FROM channels WHERE id = ?', req.params.id);
  if (!canReadChannel(req, channel)) return sendError(res, 404, 'channel_not_found');
  const members = all(
    `SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_bot, u.is_remote,
            u.status_text, u.status_emoji, u.away, wm.role, cm.joined_at
     FROM channel_members cm
     JOIN users u ON u.id = cm.user_id
     LEFT JOIN workspace_members wm ON wm.user_id = u.id AND wm.workspace_id = ?
     WHERE cm.channel_id = ? ORDER BY u.display_name`, channel.workspace_id, channel.id
  ).map(m => ({ ...m, away: !!m.away, online: isOnline(m.id) }));
  res.json({ ok: true, members });
});

// GET /channels/:id/files — every attachment on non-deleted messages in the
// channel, newest first. Link unfurls are excluded: they are previews, not
// files anyone shared.
router.get('/:id/files', (req, res) => {
  const channel = get('SELECT * FROM channels WHERE id = ?', req.params.id);
  if (!canReadChannel(req, channel)) return sendError(res, 404, 'channel_not_found');
  const rows = all(
    `SELECT m.id AS message_id, m.attachments, m.created_at,
            u.id AS uploader_id, u.username, u.display_name
     FROM messages m JOIN users u ON u.id = m.user_id
     WHERE m.channel_id = ? AND m.deleted = 0 AND m.attachments != '[]'
     ORDER BY m.id DESC LIMIT 500`, channel.id
  );
  const files = [];
  for (const r of rows) {
    let attachments = [];
    try { attachments = JSON.parse(r.attachments); } catch { /* corrupt row — skip */ }
    for (const a of attachments) {
      if (a.type === 'link' || !a.url) continue;
      files.push({
        url: a.url,
        name: a.name || 'file',
        size: a.size || 0,
        mimetype: a.mimetype || '',
        message_id: r.message_id,
        uploader: { id: r.uploader_id, username: r.username, display_name: r.display_name },
        created_at: r.created_at,
      });
    }
  }
  res.json({ ok: true, files });
});

// POST /channels/:id/members { user_id } — add a member. Private channels:
// existing members and workspace admins; public: any workspace member.
// Only workspace admins can add bots.
router.post('/:id/members', (req, res) => {
  const { channel, member } = channelMember(req, req.params.id);
  if (!channel || channel.is_dm) return sendError(res, 404, 'channel_not_found');
  if (!workspaceMember(req, channel.workspace_id)) return sendError(res, 403, 'not_a_member');
  const admin = isWorkspaceAdmin(req, channel.workspace_id);
  if (channel.is_private && !member && !admin) return sendError(res, 403, 'not_allowed');

  const userId = Number(req.body?.user_id);
  if (!Number.isFinite(userId)) return sendError(res, 400, 'invalid_user_id');
  const target = get('SELECT * FROM users WHERE id = ?', userId);
  if (!target) return sendError(res, 404, 'user_not_found');
  if (target.is_bot && !admin) return sendError(res, 403, 'admin_required');
  if (!get('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?', channel.workspace_id, userId)) {
    return sendError(res, 400, 'user_not_in_workspace');
  }
  const result = run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)',
    channel.id, userId, now());
  if (result.changes > 0) {
    sendToUser(userId, { type: 'channel.created', channel: channelWithState(userId, channel) });
    broadcastToChannel(channel.id, {
      type: 'channel.member_joined', channel_id: channel.id, user_id: userId,
    });
  }
  res.json({ ok: true, channel: channelWithState(req.user.id, channel) });
});

// DELETE /channels/:id/members/:userId — self-removal is leaving; removing
// others requires workspace admin.
router.delete('/:id/members/:userId', (req, res) => {
  const { channel } = channelMember(req, req.params.id);
  if (!channel || channel.is_dm) return sendError(res, 404, 'channel_not_found');
  const userId = Number(req.params.userId);
  const isSelf = userId === req.user.id;
  if (!isSelf && !isWorkspaceAdmin(req, channel.workspace_id)) {
    return sendError(res, 403, 'admin_required');
  }
  const target = get('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?', channel.id, userId);
  if (!target) return sendError(res, 404, 'not_in_channel');
  run('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?', channel.id, userId);
  broadcastToChannel(channel.id, {
    type: 'channel.member_left', channel_id: channel.id, user_id: userId,
  });
  res.json({ ok: true });
});

// POST /channels/:id/star — toggle the caller's star on the channel.
router.post('/:id/star', (req, res) => {
  const { channel, member } = channelMember(req, req.params.id);
  if (!channel || !member) return sendError(res, 404, 'channel_not_found');
  const starred = member.starred ? 0 : 1;
  run('UPDATE channel_members SET starred = ? WHERE channel_id = ? AND user_id = ?',
    starred, channel.id, req.user.id);
  res.json({ ok: true, starred: !!starred });
});

// POST /channels/:id/mute — toggle the caller's mute on the channel.
router.post('/:id/mute', (req, res) => {
  const { channel, member } = channelMember(req, req.params.id);
  if (!channel || !member) return sendError(res, 404, 'channel_not_found');
  const muted = member.muted ? 0 : 1;
  run('UPDATE channel_members SET muted = ? WHERE channel_id = ? AND user_id = ?',
    muted, channel.id, req.user.id);
  res.json({ ok: true, muted: !!muted });
});

// POST /channels/:id/read { message_id } — advance the read marker. The id
// must reference a visible message in this channel; larger ids are clamped
// to the channel's newest visible message so absurd ids can't break unreads.
router.post('/:id/read', (req, res) => {
  const { channel, member } = channelMember(req, req.params.id);
  if (!channel || !member) return sendError(res, 404, 'channel_not_found');
  const messageId = Number(req.body?.message_id) || 0;
  const maxVisible = get(
    'SELECT MAX(id) AS m FROM messages WHERE channel_id = ? AND deleted = 0', channel.id
  ).m || 0;
  const target = Math.min(messageId, maxVisible);
  if (messageId > 0 && messageId <= maxVisible
      && !get('SELECT 1 FROM messages WHERE id = ? AND channel_id = ? AND deleted = 0', messageId, channel.id)) {
    return sendError(res, 404, 'message_not_found');
  }
  if (target > member.last_read_id) {
    run('UPDATE channel_members SET last_read_id = ? WHERE channel_id = ? AND user_id = ?',
      target, channel.id, req.user.id);
  }
  res.json({ ok: true });
});

router.get('/:id/pins', (req, res) => {
  const channel = get('SELECT * FROM channels WHERE id = ?', req.params.id);
  if (!canReadChannel(req, channel)) return sendError(res, 404, 'channel_not_found');
  const pins = all(
    `SELECT m.* FROM pins p JOIN messages m ON m.id = p.message_id
     WHERE p.channel_id = ? AND m.deleted = 0 ORDER BY p.created_at DESC`, channel.id
  );
  res.json({ ok: true, pins: serializeMessages(pins, req.user.id) });
});

export default router;
