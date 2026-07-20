// Auth: async scrypt password hashing, bearer-token sessions, request middleware.
import { randomBytes, scrypt, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { get, run, now } from './db.js';

const scryptAsync = promisify(scrypt);

const SESSION_TTL = 1000 * 60 * 60 * 24 * 30; // 30 days
export const MAX_PASSWORD_LENGTH = 128;

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scryptAsync(password, salt, 64)).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export async function verifyPassword(password, stored) {
  try {
    if (!stored) return false;
    const [, salt, hash] = stored.split(':');
    if (!salt || !hash) return false;
    const candidate = await scryptAsync(String(password).slice(0, MAX_PASSWORD_LENGTH), salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  } catch {
    return false; // fail closed on corrupted hashes
  }
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('hex');

export function createSession(userId) {
  const token = randomToken();
  run(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    token, userId, now(), now() + SESSION_TTL
  );
  return token;
}

export function destroySession(token) {
  run('DELETE FROM sessions WHERE token = ?', token);
}

// Expired sessions are filtered at read time and purged periodically.
const purge = () => run('DELETE FROM sessions WHERE expires_at < ?', now());
purge();
setInterval(purge, 3600_000).unref();

export function publicUser(u) {
  if (!u) return null;
  const { password_hash, email, ...rest } = u;
  return rest;
}

// Resolves `Authorization: Bearer <token>` to a user. Bot tokens are accepted
// too: they map to the app's bot user and stamp req.botApp for scoping.
export function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ ok: false, error: 'missing_token' });

  const session = get(
    'SELECT * FROM sessions WHERE token = ? AND expires_at > ?', token, now()
  );
  if (session) {
    const user = get('SELECT * FROM users WHERE id = ? AND is_deactivated = 0', session.user_id);
    if (!user) return res.status(401).json({ ok: false, error: 'invalid_token' });
    req.user = user;
    req.token = token;
    return next();
  }

  const app = get('SELECT * FROM apps WHERE bot_token = ?', token);
  if (app) {
    const botUser = get('SELECT * FROM users WHERE id = ?', app.bot_user_id);
    if (!botUser) return res.status(401).json({ ok: false, error: 'invalid_token' });
    req.user = botUser;
    req.botApp = app; // bot calls are scoped to app.workspace_id
    req.token = token;
    return next();
  }

  return res.status(401).json({ ok: false, error: 'invalid_token' });
}

// HMAC-SHA256 request signing for outgoing app callbacks (events, slash commands).
// Receivers verify: HMAC(secret, `${timestamp}.${body}`) === signature.
export function signPayload(secret, timestamp, body) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}
