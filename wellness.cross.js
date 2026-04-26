'use strict';
// ════════════════════════════════════════════════════════════════════
// wellness.cross.js — Express router for /api/wellness/*
// Exposes cross-agent Home + Insights endpoints.
// All routes 60s timeout, structured errors, in-memory short cache.
// ════════════════════════════════════════════════════════════════════
const express = require('express');
const router  = express.Router();
const cron    = require('node-cron');
const admin   = require('firebase-admin');
const {
  buildHomePayload,
  buildInsightsPayload,
  persistDailySnapshot,
  AGENTS,
} = require('./lib/cross-agent-engine');

// In-memory result cache (5-min TTL) — protects against rapid pull-to-refresh
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() - v.t > CACHE_TTL) { cache.delete(key); return null; }
  return v.data;
}
function cacheSet(key, data) {
  cache.set(key, { t: Date.now(), data });
  if (cache.size > 1000) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
}

const handle = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    console.error('[wellness.cross]', req.path, e.message, e.stack);
    res.status(500).json({ error: e.message || 'internal error' });
  }
};

// ─── GET /api/wellness/home/:deviceId ───────────────────────────────
router.get('/home/:deviceId', handle(async (req, res) => {
  const { deviceId } = req.params;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  const force = req.query.force === '1';
  const key = `home:${deviceId}`;
  if (!force) {
    const cached = cacheGet(key);
    if (cached) return res.json({ ...cached, _cached: true });
  }
  const payload = await buildHomePayload(deviceId);
  cacheSet(key, payload);
  res.json(payload);
}));

// ─── GET /api/wellness/insights/:deviceId ───────────────────────────
router.get('/insights/:deviceId', handle(async (req, res) => {
  const { deviceId } = req.params;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  const force = req.query.force === '1';
  const key = `insights:${deviceId}`;
  if (!force) {
    const cached = cacheGet(key);
    if (cached) return res.json({ ...cached, _cached: true });
  }
  const payload = await buildInsightsPayload(deviceId);
  cacheSet(key, payload);
  res.json(payload);
}));

// ─── POST /api/wellness/recompute/:deviceId ─────────────────────────
router.post('/recompute/:deviceId', handle(async (req, res) => {
  const { deviceId } = req.params;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  cache.delete(`home:${deviceId}`);
  cache.delete(`insights:${deviceId}`);
  const ws = await persistDailySnapshot(deviceId);
  res.json({ ok: true, score: ws.score });
}));

// ─── POST /api/wellness/cache/invalidate/:deviceId ──────────────────
// Called from agent log handlers so next fetch is fresh
router.post('/cache/invalidate/:deviceId', handle(async (req, res) => {
  const { deviceId } = req.params;
  cache.delete(`home:${deviceId}`);
  cache.delete(`insights:${deviceId}`);
  res.json({ ok: true });
}));

// ─── DAILY CRON (3 AM UTC) — snapshots + correlation refresh ────────
cron.schedule('0 3 * * *', async () => {
  try {
    const usersSnap = await admin.firestore().collection('wellness_users').limit(2000).get();
    let ok = 0, fail = 0;
    for (const doc of usersSnap.docs) {
      try {
        await persistDailySnapshot(doc.id);
        ok++;
      } catch (e) {
        fail++;
        console.warn('[cross-cron]', doc.id, e.message);
      }
    }
    console.log(`[cross-cron] daily snapshots ok=${ok} fail=${fail}`);
  } catch (e) {
    console.error('[cross-cron] fatal:', e.message);
  }
}, { timezone: 'UTC' });

// Public helper for agent files: call after a log save to drop cached payload
function invalidateWellnessCache(deviceId) {
  if (!deviceId) return;
  cache.delete(`home:${deviceId}`);
  cache.delete(`insights:${deviceId}`);
}

module.exports = router;
module.exports.invalidateWellnessCache = invalidateWellnessCache;
