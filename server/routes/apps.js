// App management routes + the public incoming-webhook receiver.
// Authenticated management lives under /api/v1/apps; the unauthenticated
// webhook receiver is mounted separately at /hooks (see server/index.js).
import { Router } from 'express';
import { get, all, run, now, transaction } from '../db.js';
import { authenticate, randomToken, hashPassword } from '../auth.js';
import { sendError, ah } from '../lib/guards.js';
import { assertPublicUrl } from '../lib/netguard.js';
import { rateLimit } from '../lib/ratelimit.js';
import { deliverWebhook, createWebhookToken } from '../apps.js';

export const hooksRouter = Router();

const hookLimiter = rateLimit({ windowMs: 60_000, max: 120, keyFn: req => req.params.token });

hooksRouter.post('/:token', hookLimiter, (req, res) => {
  const result = deliverWebhook(req.params.token, req.body || {});
  if (!result.ok) return sendError(res, 404, result.error);
  res.json({ ok: true, message: { id: result.message.id } });
});

// ---- Management API --------------------------------------------------------

export const appsRouter = Router();
appsRouter.use(authenticate);

const VALID_EVENTS = [
  'message.channels', 'message.im', 'message.updated', 'message.deleted',
  'reaction.added', 'reaction.removed', 'channel.created', 'app_mention',
];

// Callback URLs must be public http(s) addresses (SSRF guard); localhost is
// allowed only when ATRIUM_ALLOW_LOCAL_CALLBACKS=1 (dev/tests).
async function callbackUrlError(url, { required = false } = {}) {
  if (!url) return required ? 'invalid_url' : null;
  if (process.env.ATRIUM_ALLOW_LOCAL_CALLBACKS === '1') {
    try {
      const u = new URL(url);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
      return null;
    } catch { return 'invalid_url'; }
  }
  try {
    await assertPublicUrl(url);
    return null;
  } catch { return 'invalid_url'; }
}

function canManageApp(req, app) {
  if (!app) return false;
  if (app.created_by === req.user.id) return true;
  const member = get('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
    app.workspace_id, req.user.id);
  return ['owner', 'admin'].includes(member?.role);
}

function appJson(app, { revealSecrets = false } = {}) {
  const bot = get('SELECT username FROM users WHERE id = ?', app.bot_user_id);
  const base = {
    id: app.id,
    workspace_id: app.workspace_id,
    name: app.name,
    description: app.description,
    request_url: app.request_url,
    bot_username: bot?.username,
    created_by: app.created_by,
    created_at: app.created_at,
  };
  if (revealSecrets) {
    base.bot_token = app.bot_token;
    base.signing_secret = app.signing_secret;
  }
  return base;
}

appsRouter.get('/', (req, res) => {
  const workspaceId = Number(req.query.workspace_id);
  const member = get('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
    workspaceId, req.user.id);
  if (!member) return sendError(res, 403, 'not_a_member');
  const apps = all('SELECT * FROM apps WHERE workspace_id = ? ORDER BY created_at', workspaceId);
  const privileged = ['owner', 'admin'].includes(member.role);
  res.json({
    ok: true,
    apps: apps.map(a => appJson(a, { revealSecrets: privileged || a.created_by === req.user.id })),
  });
});

appsRouter.post('/', ah(async (req, res) => {
  const workspaceId = Number(req.body?.workspace_id);
  const member = get('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
    workspaceId, req.user.id);
  if (!member || !['owner', 'admin'].includes(member.role)) {
    return sendError(res, 403, 'admin_required');
  }
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return sendError(res, 400, 'name_required');
  const requestUrl = String(req.body?.request_url || '').slice(0, 500);
  const urlError = await callbackUrlError(requestUrl);
  if (urlError) return sendError(res, 400, urlError);

  // Every app gets a bot user it acts as.
  let botName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '-bot';
  let n = 2;
  while (get('SELECT 1 FROM users WHERE username = ?', botName)) botName = `${botName}-${n++}`;
  const bot = run(
    'INSERT INTO users (username, password_hash, display_name, is_bot, created_at) VALUES (?, ?, ?, 1, ?)',
    botName, await hashPassword(randomToken(16)), name, now()
  );
  const botUserId = Number(bot.lastInsertRowid);
  run('INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
    workspaceId, botUserId, 'member', now());

  const result = run(
    `INSERT INTO apps (workspace_id, name, description, bot_user_id, bot_token, signing_secret, request_url, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    workspaceId, name, String(req.body?.description || '').slice(0, 500),
    botUserId, `xatb-${randomToken(24)}`, randomToken(32),
    requestUrl, req.user.id, now()
  );
  const app = get('SELECT * FROM apps WHERE id = ?', Number(result.lastInsertRowid));
  res.json({ ok: true, app: appJson(app, { revealSecrets: true }) });
}));

appsRouter.patch('/:id', ah(async (req, res) => {
  const app = get('SELECT * FROM apps WHERE id = ?', req.params.id);
  if (!canManageApp(req, app)) return sendError(res, 403, 'not_allowed');
  const requestUrl = req.body?.request_url !== undefined
    ? String(req.body.request_url).slice(0, 500) : app.request_url;
  if (req.body?.request_url !== undefined) {
    const urlError = await callbackUrlError(requestUrl);
    if (urlError) return sendError(res, 400, urlError);
  }
  run('UPDATE apps SET name = ?, description = ?, request_url = ? WHERE id = ?',
    req.body?.name !== undefined ? String(req.body.name).slice(0, 80) : app.name,
    req.body?.description !== undefined ? String(req.body.description).slice(0, 500) : app.description,
    requestUrl,
    app.id);
  res.json({ ok: true, app: appJson(get('SELECT * FROM apps WHERE id = ?', app.id), { revealSecrets: true }) });
}));

// Deleting an app must not fail on FK constraints once its bot has posted:
// drop the app (cascades subscriptions/commands/webhooks) and deactivate the
// bot user, keeping the row so old messages keep a valid author.
appsRouter.delete('/:id', (req, res) => {
  const app = get('SELECT * FROM apps WHERE id = ?', req.params.id);
  if (!canManageApp(req, app)) return sendError(res, 403, 'not_allowed');
  transaction(() => {
    run('DELETE FROM apps WHERE id = ?', app.id);
    run('UPDATE users SET is_deactivated = 1, password_hash = NULL WHERE id = ?', app.bot_user_id);
  });
  res.json({ ok: true });
});

appsRouter.post('/:id/rotate-token', (req, res) => {
  const app = get('SELECT * FROM apps WHERE id = ?', req.params.id);
  if (!canManageApp(req, app)) return sendError(res, 403, 'not_allowed');
  run('UPDATE apps SET bot_token = ? WHERE id = ?', `xatb-${randomToken(24)}`, app.id);
  res.json({ ok: true, app: appJson(get('SELECT * FROM apps WHERE id = ?', app.id), { revealSecrets: true }) });
});

appsRouter.post('/:id/rotate-secret', (req, res) => {
  const app = get('SELECT * FROM apps WHERE id = ?', req.params.id);
  if (!canManageApp(req, app)) return sendError(res, 403, 'not_allowed');
  run('UPDATE apps SET signing_secret = ? WHERE id = ?', randomToken(32), app.id);
  res.json({ ok: true, app: appJson(get('SELECT * FROM apps WHERE id = ?', app.id), { revealSecrets: true }) });
});

// ---- Webhook endpoints -----------------------------------------------------

appsRouter.get('/:id/webhooks', (req, res) => {
  const app = get('SELECT * FROM apps WHERE id = ?', req.params.id);
  if (!canManageApp(req, app)) return sendError(res, 403, 'not_allowed');
  const hooks = all(
    `SELECT w.id, w.token, w.channel_id, c.name AS channel_name, w.created_at
     FROM webhooks w JOIN channels c ON c.id = w.channel_id WHERE w.app_id = ?`, app.id
  ).map(h => ({ ...h, url: `/hooks/${h.token}` }));
  res.json({ ok: true, webhooks: hooks });
});

appsRouter.post('/:id/webhooks', (req, res) => {
  const app = get('SELECT * FROM apps WHERE id = ?', req.params.id);
  if (!canManageApp(req, app)) return sendError(res, 403, 'not_allowed');
  const channelId = Number(req.body?.channel_id);
  const channel = get('SELECT * FROM channels WHERE id = ? AND workspace_id = ? AND is_dm = 0',
    channelId, app.workspace_id);
  if (!channel) return sendError(res, 404, 'channel_not_found');
  const token = createWebhookToken();
  const result = run('INSERT INTO webhooks (app_id, channel_id, token, created_at) VALUES (?, ?, ?, ?)',
    app.id, channelId, token, now());
  res.json({ ok: true, webhook: { id: Number(result.lastInsertRowid), token, url: `/hooks/${token}`, channel_id: channelId } });
});

appsRouter.delete('/:id/webhooks/:webhookId', (req, res) => {
  const app = get('SELECT * FROM apps WHERE id = ?', req.params.id);
  if (!canManageApp(req, app)) return sendError(res, 403, 'not_allowed');
  run('DELETE FROM webhooks WHERE id = ? AND app_id = ?', req.params.webhookId, app.id);
  res.json({ ok: true });
});

// ---- Slash commands --------------------------------------------------------

appsRouter.get('/:id/commands', (req, res) => {
  const app = get('SELECT * FROM apps WHERE id = ?', req.params.id);
  if (!canManageApp(req, app)) return sendError(res, 403, 'not_allowed');
  res.json({ ok: true, commands: all('SELECT * FROM slash_commands WHERE app_id = ?', app.id) });
});

appsRouter.post('/:id/commands', ah(async (req, res) => {
  const app = get('SELECT * FROM apps WHERE id = ?', req.params.id);
  if (!canManageApp(req, app)) return sendError(res, 403, 'not_allowed');
  const command = String(req.body?.command || '').replace(/^\//, '').toLowerCase();
  const url = String(req.body?.url || '').slice(0, 500);
  if (!/^[a-z0-9_-]{1,32}$/.test(command)) return sendError(res, 400, 'invalid_command');
  const urlError = await callbackUrlError(url, { required: true });
  if (urlError) return sendError(res, 400, urlError);
  // Commands dispatch workspace-wide, so two apps can't own the same one.
  const taken = get(
    `SELECT sc.id FROM slash_commands sc JOIN apps a ON a.id = sc.app_id
     WHERE a.workspace_id = ? AND sc.command = ? AND sc.app_id != ?`,
    app.workspace_id, command, app.id
  );
  if (taken) return sendError(res, 409, 'command_taken');
  run('INSERT INTO slash_commands (app_id, command, url, description) VALUES (?, ?, ?, ?) ON CONFLICT (app_id, command) DO UPDATE SET url = excluded.url, description = excluded.description',
    app.id, command, url, String(req.body?.description || '').slice(0, 200));
  res.json({ ok: true, command: get('SELECT * FROM slash_commands WHERE app_id = ? AND command = ?', app.id, command) });
}));

appsRouter.delete('/:id/commands/:commandId', (req, res) => {
  const app = get('SELECT * FROM apps WHERE id = ?', req.params.id);
  if (!canManageApp(req, app)) return sendError(res, 403, 'not_allowed');
  run('DELETE FROM slash_commands WHERE id = ? AND app_id = ?', req.params.commandId, app.id);
  res.json({ ok: true });
});

// ---- Event subscriptions ---------------------------------------------------

appsRouter.get('/:id/subscriptions', (req, res) => {
  const app = get('SELECT * FROM apps WHERE id = ?', req.params.id);
  if (!canManageApp(req, app)) return sendError(res, 403, 'not_allowed');
  res.json({ ok: true, subscriptions: all('SELECT event FROM app_subscriptions WHERE app_id = ?', app.id).map(r => r.event) });
});

appsRouter.post('/:id/subscriptions', (req, res) => {
  const app = get('SELECT * FROM apps WHERE id = ?', req.params.id);
  if (!canManageApp(req, app)) return sendError(res, 403, 'not_allowed');
  const event = String(req.body?.event || '');
  if (!VALID_EVENTS.includes(event)) return sendError(res, 400, 'invalid_event');
  run('INSERT OR IGNORE INTO app_subscriptions (app_id, event) VALUES (?, ?)', app.id, event);
  res.json({ ok: true, subscriptions: all('SELECT event FROM app_subscriptions WHERE app_id = ?', app.id).map(r => r.event) });
});

appsRouter.delete('/:id/subscriptions/:event', (req, res) => {
  const app = get('SELECT * FROM apps WHERE id = ?', req.params.id);
  if (!canManageApp(req, app)) return sendError(res, 403, 'not_allowed');
  run('DELETE FROM app_subscriptions WHERE app_id = ? AND event = ?', app.id, req.params.event);
  res.json({ ok: true, subscriptions: all('SELECT event FROM app_subscriptions WHERE app_id = ?', app.id).map(r => r.event) });
});
