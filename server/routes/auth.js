// Auth routes: register, login, logout, current user, change password.
import { Router } from 'express';
import { get, run, now } from '../db.js';
import {
  hashPassword, verifyPassword, createSession, destroySession,
  publicUser, authenticate, MAX_PASSWORD_LENGTH,
} from '../auth.js';
import { sendError, ah } from '../lib/guards.js';
import { rateLimit } from '../lib/ratelimit.js';
import { applyDomainJoins } from '../lib/domainjoin.js';

const router = Router();

const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{1,31}$/i;

const authLimiter = rateLimit({ windowMs: 60_000, max: 20 });
const passwordLimiter = rateLimit({ windowMs: 60_000, max: 10 });

router.post('/register', authLimiter, ah(async (req, res) => {
  const { username, email, password, display_name } = req.body || {};
  // Registration can be closed once the first human account exists — the
  // first-run setup wizard must always be able to create that account.
  if (process.env.ATRIUM_DISABLE_REGISTRATION === '1'
      && get('SELECT 1 FROM users WHERE is_bot = 0 AND is_remote = 0 LIMIT 1')) {
    return sendError(res, 403, 'registration_closed');
  }
  if (!username || !USERNAME_RE.test(username)) {
    return res.status(400).json({ ok: false, error: 'invalid_username' });
  }
  if (!password || String(password).length < 8) {
    return res.status(400).json({ ok: false, error: 'password_too_short' });
  }
  if (String(password).length > MAX_PASSWORD_LENGTH) {
    return res.status(400).json({ ok: false, error: 'password_too_long' });
  }
  if (get('SELECT 1 FROM users WHERE username = ?', username)) {
    return res.status(409).json({ ok: false, error: 'username_taken' });
  }
  if (email && get('SELECT 1 FROM users WHERE email = ?', email)) {
    return res.status(409).json({ ok: false, error: 'email_taken' });
  }
  const result = run(
    'INSERT INTO users (username, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)',
    username, email || null, await hashPassword(String(password)),
    String(display_name || username).slice(0, 80), now()
  );
  const user = get('SELECT * FROM users WHERE id = ?', Number(result.lastInsertRowid));
  // Workspaces that allow this email domain get the new user automatically.
  applyDomainJoins(user);
  res.json({ ok: true, token: createSession(user.id), user: publicUser(user) });
}));

router.post('/login', authLimiter, ah(async (req, res) => {
  const { username, password } = req.body || {};
  const user = get('SELECT * FROM users WHERE username = ? OR email = ?', username || '', username || '');
  if (!user || user.is_bot || user.is_remote || user.is_deactivated
      || !(await verifyPassword(String(password || ''), user.password_hash))) {
    return res.status(401).json({ ok: false, error: 'invalid_credentials' });
  }
  // Catch up on workspaces whose allowed domains were set since last login.
  applyDomainJoins(user);
  res.json({ ok: true, token: createSession(user.id), user: publicUser(user) });
}));

// Change password: verifies the current one, revokes every OTHER session.
router.post('/change-password', authenticate, passwordLimiter, ah(async (req, res) => {
  if (req.botApp) return sendError(res, 403, 'bots_cannot_change_password');
  const { current_password, new_password } = req.body || {};
  if (!(await verifyPassword(String(current_password || ''), req.user.password_hash))) {
    return sendError(res, 403, 'invalid_current_password');
  }
  if (!new_password || String(new_password).length < 8) {
    return sendError(res, 400, 'password_too_short');
  }
  if (String(new_password).length > MAX_PASSWORD_LENGTH) {
    return sendError(res, 400, 'password_too_long');
  }
  run('UPDATE users SET password_hash = ? WHERE id = ?',
    await hashPassword(String(new_password)), req.user.id);
  run('DELETE FROM sessions WHERE user_id = ? AND token != ?', req.user.id, req.token);
  res.json({ ok: true });
}));

router.post('/logout', authenticate, (req, res) => {
  destroySession(req.token);
  res.json({ ok: true });
});

router.get('/me', authenticate, (req, res) => {
  res.json({ ok: true, user: publicUser(req.user) });
});

export default router;
