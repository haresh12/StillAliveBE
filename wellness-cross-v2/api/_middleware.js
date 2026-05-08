/**
 * api/_middleware.js
 * Auth / rate-limiting / deviceId resolution.
 */

const config = require('../config');

function requireDeviceId(req, res, next) {
  const id = (req.params.deviceId || req.query.deviceId || '').toString().trim();
  if (!id) return res.status(400).json({ error: 'deviceId required' });
  req.deviceId = id;
  next();
}

const buckets = new Map();

function rateLimit(perMinute) {
  const limit = perMinute || 60;
  return function (req, res, next) {
    const key = `${req.deviceId}:${req.path.split('/')[1] || 'root'}`;
    const now = Date.now();
    const minuteWindow = 60_000;
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.start > minuteWindow) {
      bucket = { start: now, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > limit) {
      const retry_after = Math.ceil((bucket.start + minuteWindow - now) / 1000);
      return res.status(429).json({ error: 'rate_limited', retry_after_seconds: retry_after });
    }
    next();
  };
}

module.exports = { requireDeviceId, rateLimit, RATE: config.RATE_LIMITS };
