// File uploads: multipart POST /upload -> { url } usable in attachments.
import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { UPLOAD_DIR } from '../db.js';
import { authenticate } from '../auth.js';
import { sendError } from '../lib/guards.js';
import { rateLimit } from '../lib/ratelimit.js';

const router = Router();
router.use(authenticate);

const MAX_SIZE = 25 * 1024 * 1024; // 25 MB

// Only extensions that are safe to serve (active-content types like html/svg
// are excluded on purpose — see the /uploads static handler in index.js).
const ALLOWED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif',
  '.mp4', '.webm', '.mov', '.mp3', '.wav', '.ogg', '.m4a',
  '.pdf', '.txt', '.md', '.csv', '.json', '.zip', '.gz',
]);

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 16);
    cb(null, `${Date.now()}-${randomBytes(16).toString('hex')}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE, files: 5 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      const err = new Error('unsupported_type');
      err.code = 'UNSUPPORTED_TYPE';
      return cb(err);
    }
    cb(null, true);
  },
});

const uploadLimiter = rateLimit({ windowMs: 60_000, max: 20, keyFn: req => String(req.user.id) });

router.post('/', uploadLimiter, (req, res) => {
  upload.array('files', 5)(req, res, (err) => {
    if (err) {
      if (err.code === 'UNSUPPORTED_TYPE') return sendError(res, 400, 'unsupported_type');
      if (err instanceof multer.MulterError) return sendError(res, 400, 'upload_limit_exceeded');
      return sendError(res, 400, 'upload_failed');
    }
    const files = (req.files || []).map(f => ({
      url: `/uploads/${f.filename}`,
      name: f.originalname,
      size: f.size,
      mimetype: f.mimetype,
    }));
    res.json({ ok: true, files });
  });
});

export default router;
