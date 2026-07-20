// User routes: profile updates, workspace user directory, presence, saved messages.
import { Router } from 'express';
import { get, all, run, now } from '../db.js';
import { authenticate, publicUser } from '../auth.js';
import { sendError, workspaceMember, canReadChannel } from '../lib/guards.js';
import { serializeMessages } from '../lib/messages.js';
import { isOnline, broadcastToWorkspace } from '../realtime.js';

const router = Router();
router.use(authenticate);

const AVATAR_URL_RE = /^(\/uploads\/[A-Za-z0-9.-]+|https?:\/\/)/;

router.patch('/me', (req, res) => {
  const displayName = req.body?.display_name !== undefined
    ? String(req.body.display_name).slice(0, 80) : req.user.display_name;
  const statusText = req.body?.status_text !== undefined
    ? String(req.body.status_text).slice(0, 120) : req.user.status_text;
  const statusEmoji = req.body?.status_emoji !== undefined
    ? String(req.body.status_emoji).slice(0, 8) : req.user.status_emoji;
  let avatarUrl = req.user.avatar_url;
  if (req.body?.avatar_url !== undefined) {
    avatarUrl = String(req.body.avatar_url).slice(0, 500);
    if (avatarUrl && !AVATAR_URL_RE.test(avatarUrl)) {
      return sendError(res, 400, 'invalid_avatar_url');
    }
  }
  const away = req.body?.away !== undefined ? (req.body.away ? 1 : 0) : req.user.away;
  run('UPDATE users SET display_name = ?, status_text = ?, status_emoji = ?, avatar_url = ?, away = ? WHERE id = ?',
    displayName, statusText, statusEmoji, avatarUrl, away, req.user.id);
  const user = publicUser(get('SELECT * FROM users WHERE id = ?', req.user.id));
  const awayChanged = away !== req.user.away;
  for (const { workspace_id } of all('SELECT workspace_id FROM workspace_members WHERE user_id = ?', req.user.id)) {
    broadcastToWorkspace(workspace_id, { type: 'user.updated', user });
    // Away toggles look like presence changes to everyone else.
    if (awayChanged) {
      broadcastToWorkspace(workspace_id, {
        type: 'presence', user_id: req.user.id, online: isOnline(req.user.id), away: !!away,
      });
    }
  }
  res.json({ ok: true, user });
});

// GET /users?workspace_id=N — directory with live presence.
router.get('/', (req, res) => {
  const workspaceId = Number(req.query.workspace_id);
  if (!workspaceId) return sendError(res, 400, 'workspace_id_required');
  if (!get('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?', workspaceId, req.user.id)
      && req.botApp?.workspace_id !== workspaceId) {
    return sendError(res, 403, 'not_a_member');
  }
  const users = all(
    `SELECT u.id, u.username, u.display_name, u.avatar_url, u.status_text, u.status_emoji,
            u.is_bot, u.is_remote, u.remote_url, u.away
     FROM workspace_members wm JOIN users u ON u.id = wm.user_id
     WHERE wm.workspace_id = ? ORDER BY u.display_name`, workspaceId
  ).map(u => ({ ...u, away: !!u.away, online: isOnline(u.id) }));
  res.json({ ok: true, users });
});

// GET /users/me/mentions?workspace_id=N&limit=20 — recent messages by others
// that mention the caller, newest first, limited to channels they can read.
router.get('/me/mentions', (req, res) => {
  const workspaceId = Number(req.query.workspace_id);
  if (!workspaceId) return sendError(res, 400, 'workspace_id_required');
  if (!workspaceMember(req, workspaceId)) return sendError(res, 403, 'not_a_member');
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 20, 50));
  const rows = all(
    `SELECT m.*, c.name AS channel_name, c.is_dm AS channel_is_dm FROM messages m
     JOIN channels c ON c.id = m.channel_id
     WHERE c.workspace_id = ? AND m.deleted = 0 AND m.user_id != ?
       AND (',' || replace(replace(replace(m.mentions, '[', ''), ']', ''), ' ', '') || ',')
           LIKE '%,' || ? || ',%'
       AND (c.is_private = 0 AND c.is_dm = 0
            OR m.channel_id IN (SELECT channel_id FROM channel_members WHERE user_id = ?))
     ORDER BY m.id DESC LIMIT ?`,
    workspaceId, req.user.id, String(req.user.id), req.user.id, limit
  );
  const serialized = serializeMessages(rows, req.user.id);
  res.json({
    ok: true,
    mentions: rows.map((r, i) => ({
      ...serialized[i], channel_name: r.channel_name, channel_is_dm: !!r.channel_is_dm,
    })),
  });
});

// ---- Saved messages ----------------------------------------------------------

// POST /users/me/saved { message_id } — save a message the caller can read.
router.post('/me/saved', (req, res) => {
  const messageId = Number(req.body?.message_id);
  const msg = Number.isFinite(messageId)
    ? get('SELECT * FROM messages WHERE id = ? AND deleted = 0', messageId) : null;
  const channel = msg && get('SELECT * FROM channels WHERE id = ?', msg.channel_id);
  if (!msg || !canReadChannel(req, channel)) return sendError(res, 400, 'message_not_readable');
  run('INSERT OR IGNORE INTO saved_messages (user_id, message_id, created_at) VALUES (?, ?, ?)',
    req.user.id, msg.id, now());
  res.json({ ok: true });
});

// DELETE /users/me/saved/:messageId — unsave.
router.delete('/me/saved/:messageId', (req, res) => {
  run('DELETE FROM saved_messages WHERE user_id = ? AND message_id = ?',
    req.user.id, Number(req.params.messageId) || 0);
  res.json({ ok: true });
});

// GET /users/me/saved?workspace_id=N — saved messages, newest saves first.
router.get('/me/saved', (req, res) => {
  const workspaceId = Number(req.query.workspace_id);
  if (!workspaceId) return sendError(res, 400, 'workspace_id_required');
  if (!workspaceMember(req, workspaceId)) return sendError(res, 403, 'not_a_member');
  const rows = all(
    `SELECT m.*, c.name AS channel_name FROM saved_messages s
     JOIN messages m ON m.id = s.message_id AND m.deleted = 0
     JOIN channels c ON c.id = m.channel_id
     WHERE s.user_id = ? AND c.workspace_id = ?
       AND (c.is_private = 0 AND c.is_dm = 0
            OR m.channel_id IN (SELECT channel_id FROM channel_members WHERE user_id = ?))
     ORDER BY s.created_at DESC LIMIT 200`,
    req.user.id, workspaceId, req.user.id
  );
  const serialized = serializeMessages(rows, req.user.id);
  res.json({
    ok: true,
    saved: rows.map((r, i) => ({ ...serialized[i], channel_name: r.channel_name })),
  });
});

export default router;
