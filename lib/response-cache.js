'use strict';
/**
 * response-cache.js — tiny in-memory response cache for hot read endpoints.
 *
 * Why this exists:
 *   Endpoints like /analysis and /actions do real compute every request
 *   (Firestore reads, score blending, LLM cache lookups) even when the
 *   underlying data hasn't changed. With Express's default ETag, the BE
 *   STILL pays the full compute cost and only saves the wire transfer
 *   via 304. That's why our logs show "1500ms ... 304" — the user is
 *   confused thinking 304 means slow when it really means "you already
 *   have a fresh copy". This module short-circuits the compute itself.
 *
 * How it works:
 *   - Endpoint calls `cached(req, () => doExpensiveCompute())`.
 *   - Cache key = method + path + sorted query params.
 *   - First request: runs the fn, caches the payload, returns it.
 *   - Subsequent within TTL: returns cached payload immediately (<5ms).
 *
 * Hard rules:
 *   1. Per-deviceId scoping is automatic (deviceId is in the query string).
 *   2. TTL configurable per endpoint; default 60s.
 *   3. Bounded at 5000 entries to prevent memory bloat.
 *   4. Never caches errors — only successful responses.
 *   5. Manual invalidate API for write-paths that should bust the cache
 *      (e.g. POST /log invalidates GET /analysis for the same deviceId).
 */

const CACHE = new Map();
const MAX_ENTRIES = 5000;
const DEFAULT_TTL_MS = 60 * 1000;

function _key(req) {
  const params = Object.entries(req.query || {})
    .sort(([a], [b]) => a < b ? -1 : 1)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return `${req.method}:${req.baseUrl || ''}${req.path}?${params}`;
}

/**
 * Wraps an async compute fn with cache. Returns the cached payload if
 * fresh, otherwise runs the fn and caches the result.
 *
 * Usage:
 *   router.get('/analysis', async (req, res) => {
 *     const payload = await cached(req, () => buildAnalysis(...), { ttlMs: 60_000 });
 *     res.json(payload);
 *   });
 */
async function cached(req, fn, { ttlMs = DEFAULT_TTL_MS } = {}) {
  const key = _key(req);
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) {
    return hit.payload;
  }
  const payload = await fn();
  CACHE.set(key, { ts: Date.now(), payload });
  if (CACHE.size > MAX_ENTRIES) {
    // LRU-ish: drop oldest first key
    CACHE.delete(CACHE.keys().next().value);
  }
  return payload;
}

/**
 * Invalidate any cached responses for this deviceId. Call from write
 * paths (POST /log etc) so the next GET reflects fresh data.
 */
function invalidateForDevice(deviceId) {
  if (!deviceId) return;
  const needle = `deviceId=${deviceId}`;
  for (const k of CACHE.keys()) {
    if (k.includes(needle)) CACHE.delete(k);
  }
}

/** Invalidate all caches matching path prefix (e.g. /api/water). */
function invalidatePathPrefix(prefix) {
  if (!prefix) return;
  for (const k of CACHE.keys()) {
    if (k.includes(`:${prefix}`)) CACHE.delete(k);
  }
}

module.exports = { cached, invalidateForDevice, invalidatePathPrefix };
