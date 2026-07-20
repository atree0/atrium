// Workspace routes: create/list/get, membership, invite links, custom emoji.
import { Router } from 'express';
import { get, all, run, now, transaction } from '../db.js';
import { authenticate, randomToken, publicUser } from '../auth.js';
import { sendError, workspaceMember } from '../lib/guards.js';
import { broadcastToWorkspace } from '../realtime.js';
import { normalizeDomains } from '../lib/domainjoin.js';

const router = Router();
router.use(authenticate);

const EMOJI_NAME_RE = /^[a-z0-9_+-]{1,32}$/;

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'workspace';
}

router.get('/', (req, res) => {
  const rows = req.botApp
    ? all('SELECT * FROM workspaces WHERE id = ?', req.botApp.workspace_id)
    : all(
      `SELECT w.* FROM workspaces w
       JOIN workspace_members wm ON wm.workspace_id = w.id
       WHERE wm.user_id = ? ORDER BY w.created_at`, req.user.id
    );
  res.json({ ok: true, workspaces: rows });
});

router.post('/', (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return sendError(res, 400, 'name_required');
  if (req.botApp) return sendError(res, 403, 'bots_cannot_create_workspaces');

  let slug = slugify(name);
  let n = 2;
  while (get('SELECT 1 FROM workspaces WHERE slug = ?', slug)) slug = `${slugify(name)}-${n++}`;

  const result = run(
    'INSERT INTO workspaces (name, slug, icon, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
    name, slug, String(req.body?.icon || ''), req.user.id, now()
  );
  const workspaceId = Number(result.lastInsertRowid);
  run(
    'INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
    workspaceId, req.user.id, 'owner', now()
  );
  // Every workspace gets a #general channel.
  const channel = run(
    `INSERT INTO channels (workspace_id, name, topic, purpose, is_private, is_dm, created_by, created_at)
     VALUES (?, 'general', 'Workspace-wide announcements', '', 0, 0, ?, ?)`,
    workspaceId, req.user.id, now()
  );
  run(
    'INSERT INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)',
    Number(channel.lastInsertRowid), req.user.id, now()
  );
  res.json({ ok: true, workspace: get('SELECT * FROM workspaces WHERE id = ?', workspaceId) });
});

router.get('/:id', (req, res) => {
  const member = workspaceMember(req, req.params.id);
  if (!member) return sendError(res, 403, 'not_a_member');
  const workspace = get('SELECT * FROM workspaces WHERE id = ?', req.params.id);
  if (!workspace) return sendError(res, 404, 'workspace_not_found');
  const members = all(
    `SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_bot, wm.role, wm.joined_at
     FROM workspace_members wm JOIN users u ON u.id = wm.user_id
     WHERE wm.workspace_id = ? ORDER BY wm.joined_at`, workspace.id
  );
  res.json({ ok: true, workspace, members, my_role: member.role });
});

// PATCH /workspaces/:id { name?, icon?, allowed_domains? } — owner/admin.
router.patch('/:id', (req, res) => {
  const member = workspaceMember(req, req.params.id);
  if (!member || !['owner', 'admin'].includes(member.role)) {
    return sendError(res, 403, 'admin_required');
  }
  const ws = get('SELECT * FROM workspaces WHERE id = ?', req.params.id);
  if (!ws) return sendError(res, 404, 'workspace_not_found');

  const name = req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 80) : ws.name;
  if (!name) return sendError(res, 400, 'name_required');
  const icon = req.body?.icon !== undefined ? String(req.body.icon).slice(0, 500) : ws.icon;
  let domains = ws.allowed_domains;
  if (req.body?.allowed_domains !== undefined) {
    try {
      domains = normalizeDomains(req.body.allowed_domains);
    } catch {
      return sendError(res, 400, 'invalid_domain');
    }
  }
  run('UPDATE workspaces SET name = ?, icon = ?, allowed_domains = ? WHERE id = ?',
    name, icon, domains, ws.id);
  res.json({ ok: true, workspace: get('SELECT * FROM workspaces WHERE id = ?', ws.id) });
});

// Invite management: list (admin) and revoke (admin). Anyone can create.
router.get('/:id/invites', (req, res) => {
  const member = workspaceMember(req, req.params.id);
  if (!member || !['owner', 'admin'].includes(member.role)) {
    return sendError(res, 403, 'admin_required');
  }
  const invites = all(
    `SELECT code, max_uses, uses, expires_at, created_at FROM invites
     WHERE workspace_id = ? ORDER BY created_at DESC`, req.params.id
  ).map(i => ({ ...i, url: `/join/${i.code}` }));
  res.json({ ok: true, invites });
});

router.delete('/:id/invites/:code', (req, res) => {
  const member = workspaceMember(req, req.params.id);
  if (!member || !['owner', 'admin'].includes(member.role)) {
    return sendError(res, 403, 'admin_required');
  }
  run('DELETE FROM invites WHERE code = ? AND workspace_id = ?', req.params.code, req.params.id);
  res.json({ ok: true });
});

router.post('/:id/invites', (req, res) => {
  if (req.botApp) return sendError(res, 403, 'bots_cannot_create_invites');
  const member = workspaceMember(req, req.params.id);
  if (!member) return sendError(res, 403, 'not_a_member');
  const code = randomToken(12);
  const maxUses = Math.max(0, Number(req.body?.max_uses) || 0);
  const expiresInHours = Number(req.body?.expires_in_hours) || 0;
  run(
    'INSERT INTO invites (code, workspace_id, created_by, max_uses, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    code, req.params.id, req.user.id, maxUses,
    expiresInHours > 0 ? now() + expiresInHours * 3600_000 : null, now()
  );
  res.json({ ok: true, invite: { code, url: `/join/${code}` } });
});

router.post('/join', (req, res) => {
  const code = String(req.body?.code || '');
  const invite = get('SELECT * FROM invites WHERE code = ?', code);
  if (!invite) return sendError(res, 404, 'invite_not_found');
  if (invite.expires_at && invite.expires_at < now()) return sendError(res, 410, 'invite_expired');
  if (invite.max_uses > 0 && invite.uses >= invite.max_uses) return sendError(res, 410, 'invite_exhausted');
  if (req.botApp) return sendError(res, 403, 'bots_cannot_join_via_invite');

  const joined = run(
    'INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
    invite.workspace_id, req.user.id, 'member', now()
  );
  if (joined.changes > 0) {
    run('UPDATE invites SET uses = uses + 1 WHERE code = ?', code);

    // New members land in all public channels? No — just #general-equivalent
    // (the oldest public channel), mirroring Slack's default-channel behavior.
    const general = get(
      'SELECT * FROM channels WHERE workspace_id = ? AND is_dm = 0 AND is_private = 0 ORDER BY id LIMIT 1',
      invite.workspace_id
    );
    if (general) {
      run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)',
        general.id, req.user.id, now());
    }
    broadcastToWorkspace(invite.workspace_id, {
      type: 'workspace.member_joined',
      workspace_id: invite.workspace_id,
      user: publicUser(req.user),
    });
  }
  const workspace = get('SELECT * FROM workspaces WHERE id = ?', invite.workspace_id);
  res.json({ ok: true, workspace });
});

// PATCH /workspaces/:id/members/:userId { role: 'admin'|'member' } — owner
// only; never your own role; the last remaining owner can't be demoted.
router.patch('/:id/members/:userId', (req, res) => {
  const me = workspaceMember(req, req.params.id);
  if (!me) return sendError(res, 403, 'not_a_member');
  const role = String(req.body?.role || '');
  if (!['admin', 'member'].includes(role)) return sendError(res, 400, 'invalid_role');
  if (me.role !== 'owner') return sendError(res, 403, 'owner_required');
  const userId = Number(req.params.userId);
  if (userId === req.user.id) return sendError(res, 400, 'cannot_change_own_role');
  const target = get(
    'SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
    req.params.id, userId
  );
  if (!target) return sendError(res, 404, 'not_a_member');
  if (target.role === 'owner') {
    const owners = get(
      "SELECT COUNT(*) AS c FROM workspace_members WHERE workspace_id = ? AND role = 'owner'",
      req.params.id
    ).c;
    if (owners <= 1) return sendError(res, 400, 'cannot_demote_last_owner');
  }
  run('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?',
    role, req.params.id, userId);
  res.json({ ok: true, member: { user_id: userId, role } });
});

// DELETE /workspaces/:id/members/:userId — kick (owner/admin; owners can't be
// kicked; admins can't kick other admins) or self-removal (leave). Also drops
// the user's channel memberships inside this workspace.
router.delete('/:id/members/:userId', (req, res) => {
  const me = workspaceMember(req, req.params.id);
  if (!me) return sendError(res, 403, 'not_a_member');
  const userId = Number(req.params.userId);
  const isSelf = userId === req.user.id;
  const target = get(
    'SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
    req.params.id, userId
  );
  if (!target) return sendError(res, 404, 'not_a_member');
  if (!isSelf) {
    if (!['owner', 'admin'].includes(me.role)) return sendError(res, 403, 'admin_required');
    if (target.role === 'owner') return sendError(res, 403, 'cannot_kick_owner');
    if (me.role === 'admin' && target.role === 'admin') return sendError(res, 403, 'cannot_kick_admin');
  }
  const workspaceId = Number(req.params.id);
  transaction(() => {
    run('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?', workspaceId, userId);
    run(
      `DELETE FROM channel_members
       WHERE user_id = ? AND channel_id IN (SELECT id FROM channels WHERE workspace_id = ?)`,
      userId, workspaceId
    );
  });
  broadcastToWorkspace(workspaceId, { type: 'workspace.member_left', workspace_id: workspaceId, user_id: userId });
  res.json({ ok: true });
});

// ---- Custom emoji ------------------------------------------------------------

// GET /workspaces/:id/emoji — every member can list.
router.get('/:id/emoji', (req, res) => {
  if (!workspaceMember(req, req.params.id)) return sendError(res, 403, 'not_a_member');
  const emoji = all(
    'SELECT name, url FROM custom_emoji WHERE workspace_id = ? ORDER BY name', req.params.id
  );
  res.json({ ok: true, emoji });
});

// POST /workspaces/:id/emoji { name, url } — members can add; the URL must
// point at a local upload.
router.post('/:id/emoji', (req, res) => {
  const member = workspaceMember(req, req.params.id);
  if (!member) return sendError(res, 403, 'not_a_member');
  const name = String(req.body?.name || '').toLowerCase();
  const url = String(req.body?.url || '');
  if (!EMOJI_NAME_RE.test(name)) return sendError(res, 400, 'invalid_emoji_name');
  if (!url.startsWith('/uploads/')) return sendError(res, 400, 'invalid_emoji_url');
  if (get('SELECT 1 FROM custom_emoji WHERE workspace_id = ? AND name = ?', req.params.id, name)) {
    return sendError(res, 409, 'emoji_name_taken');
  }
  run('INSERT INTO custom_emoji (workspace_id, name, url, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
    req.params.id, name, url, req.user.id, now());
  res.json({ ok: true, emoji: { name, url } });
});

// DELETE /workspaces/:id/emoji/:name — the uploader or a workspace admin.
router.delete('/:id/emoji/:name', (req, res) => {
  const member = workspaceMember(req, req.params.id);
  if (!member) return sendError(res, 403, 'not_a_member');
  const emoji = get('SELECT * FROM custom_emoji WHERE workspace_id = ? AND name = ?',
    req.params.id, req.params.name);
  if (!emoji) return sendError(res, 404, 'emoji_not_found');
  if (emoji.created_by !== req.user.id && !['owner', 'admin'].includes(member.role)) {
    return sendError(res, 403, 'not_allowed');
  }
  run('DELETE FROM custom_emoji WHERE id = ?', emoji.id);
  res.json({ ok: true });
});

export default router;
