// Minimal in-memory sliding-window rate limiter — no new dependency needed
// for a single-process app. Not suitable for a multi-instance deployment.
function rateLimit({ windowMs, max, keyFn }) {
  const hits = new Map(); // key -> timestamps[]
  const getKey = keyFn || (req => req.ip);

  return (req, res, next) => {
    const key = getKey(req);
    const now = Date.now();
    const recent = (hits.get(key) || []).filter(ts => now - ts < windowMs);

    if (recent.length >= max) {
      return res.status(429).json({ message: 'Too many attempts. Please wait a moment and try again.' });
    }

    recent.push(now);
    hits.set(key, recent);
    next();
  };
}

module.exports = { rateLimit };
