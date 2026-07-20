// Atrium server — Express app, REST API, static SPA, WebSocket hub.
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import db, { get, UPLOAD_DIR } from './db.js';
import { attachRealtime } from './realtime.js';
import { registerAppEngine } from './apps.js';
import { registerFederation } from './federation.js';
import authRoutes from './routes/auth.js';
import workspaceRoutes from './routes/workspaces.js';
import channelRoutes from './routes/channels.js';
import messageRoutes from './routes/messages.js';
import userRoutes from './routes/users.js';
import uploadRoutes from './routes/uploads.js';
import { appsRouter, hooksRouter } from './routes/apps.js';
import { federationRouter, fedRouter } from './routes/federation.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 3000);

const app = express();
app.disable('x-powered-by');
// Trust proxy is opt-in: enabling it lets clients spoof req.ip via
// X-Forwarded-For (defeats rate limits) unless a real proxy strips it.
// ATRIUM_TRUST_PROXY: 'true' | 'false' (default) | hop count | subnet string.
const tpEnv = process.env.ATRIUM_TRUST_PROXY ?? 'false';
app.set('trust proxy',
  tpEnv === 'true' ? true
  : tpEnv === 'false' ? false
  : Number.isNaN(Number(tpEnv)) ? tpEnv
  : Number(tpEnv));
// Raw bodies are captured for /fed/* so federation HMAC is verified over the
// exact bytes received, not a re-serialization.
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buf) => {
    if (req.url.startsWith('/fed/')) req.rawBody = buf.toString();
  },
}));

// Security headers. CSP allows inline styles (the SPA uses style attributes)
// and external images (link-unfurl previews) but locks scripts to same-origin.
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "media-src 'self'",
      "connect-src 'self' ws: wss:",
      "font-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  });
  next();
});

// REST API
app.get('/api/v1/health', (_req, res) => res.json({ ok: true, name: 'atrium', version: '1.0.0' }));
// First-run detection: the client shows the setup wizard until an account exists.
app.get('/api/v1/setup', (_req, res) => {
  const { c } = get('SELECT COUNT(*) AS c FROM users WHERE is_bot = 0 AND is_remote = 0');
  res.json({ ok: true, needs_setup: c === 0 });
});
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/workspaces', workspaceRoutes);
app.use('/api/v1/channels', channelRoutes);
app.use('/api/v1', messageRoutes); // /channels/:id/messages, /messages/:id..., /search
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/upload', uploadRoutes);
app.use('/api/v1/apps', appsRouter);
app.use('/api/v1/federation', federationRouter);

// Public receivers (the URL token is the credential).
app.use('/hooks', hooksRouter);
app.use('/fed/v1', fedRouter);

// JSON 404 for unknown API routes — never fall through to the SPA.
app.use('/api', (_req, res) => res.status(404).json({ ok: false, error: 'not_found' }));
app.use('/hooks', (_req, res) => res.status(404).json({ ok: false, error: 'not_found' }));
app.use('/fed', (_req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

// User uploads. Extensions that can execute as active content (html, svg, …)
// are forced to download; known media types display inline. Filenames are
// random 128-bit tokens, so unauthenticated serving is a deliberate tradeoff —
// see README "Security notes".
const INLINE_UPLOADS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif',
  '.mp4', '.webm', '.mov', '.mp3', '.wav', '.ogg', '.m4a', '.pdf',
]);
app.use('/uploads', express.static(UPLOAD_DIR, {
  maxAge: '7d',
  immutable: true,
  setHeaders(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    res.set('X-Content-Type-Options', 'nosniff');
    if (!INLINE_UPLOADS.has(ext)) {
      res.set('Content-Disposition', 'attachment');
      res.set('Content-Type', 'application/octet-stream');
    }
  },
}));

// SPA static assets.
app.use(express.static(path.join(root, 'public'), { maxAge: '1h' }));
app.get('*', (_req, res) => res.sendFile(path.join(root, 'public', 'index.html')));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: 'internal_error' });
});

registerAppEngine();
registerFederation();

const server = http.createServer(app);
attachRealtime(server);

server.listen(PORT, () => {
  console.log(`\n  Atrium is running at http://localhost:${PORT}\n`);
});

// Graceful shutdown: stop accepting, close sockets, checkpoint the WAL.
function shutdown(signal) {
  console.log(`\n${signal} received — shutting down`);
  server.close(() => {
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.close();
    } catch { /* best effort */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
