// Tiny in-memory fixed-window rate limiter. Single-process by design —
// document that multi-replica deployments need a shared store.
const buckets = new Map();

export function rateLimit({ windowMs, max, keyFn }) {
  return (req, res, next) => {
    const key = `${req.baseUrl}${req.path}:${keyFn ? keyFn(req) : req.ip}`;
    const nowMs = Date.now();
    let b = buckets.get(key);
    if (!b || nowMs - b.start >= windowMs) {
      b = { start: nowMs, count: 0 };
      buckets.set(key, b);
    }
    if (++b.count > max) {
      res.set('Retry-After', String(Math.ceil((b.start + windowMs - nowMs) / 1000)));
      return res.status(429).json({ ok: false, error: 'rate_limited' });
    }
    next();
  };
}

// Sweep stale buckets so the map doesn't grow unboundedly.
setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [k, b] of buckets) if (b.start < cutoff) buckets.delete(k);
}, 60_000).unref();
