'use strict';
// ════════════════════════════════════════════════════════════════
// user-anchor.js — resolve the user's registration anchor.
//
// The anchor is the immutable, local-TZ-midnight timestamp of the
// day a user completed onboarding. It is THE single source of truth
// for every "missed day", "since X days", and "chart start" question.
//
// Resolution order (first non-null wins):
//   1. wellness_users/{deviceId}.created_at      ← canonical
//   2. aliveChecks/{deviceId}.profile.personalize_completed_at
//   3. min(created_at across the 6 agent docs)
//
// TZ: aliveChecks/{deviceId}.profile.utc_offset_minutes (default 0).
//
// Cached per-deviceId for 5 minutes — anchor is immutable so cache
// invalidation is irrelevant, but the TTL protects against bad reads.
// ════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
const { floorToLocalDay, dateStr, getMillis } = require('./range-helpers');

const CACHE_TTL_MS = 5 * 60_000;
const _cache = new Map();

function _getDb() {
  return admin.firestore();
}

const AGENT_DOCS = [
  { col: 'wellness_fitness', key: 'fitness' },
  { col: 'wellness_nutrition', key: 'nutrition' },
  { col: 'wellness_mind', key: 'mind' },
  { col: 'wellness_sleep', key: 'sleep' },
  { col: 'wellness_water', key: 'water' },
  { col: 'wellness_fasting', key: 'fasting' },
];

async function _readAnchorRaw(deviceId) {
  const db = _getDb();

  // Read primary + profile + 6 agent docs in parallel.
  const [primarySnap, aliveSnap, ...agentSnaps] = await Promise.all([
    db.collection('wellness_users').doc(deviceId).get(),
    db.collection('aliveChecks').doc(deviceId).get(),
    ...AGENT_DOCS.map(({ col }) => db.collection(col).doc(deviceId).get()),
  ]);

  const profile = aliveSnap.exists ? (aliveSnap.data()?.profile || {}) : {};
  const userData = primarySnap.exists ? primarySnap.data() : null;

  // TZ: prefer the offset stamped at signup, fall back to profile, then UTC.
  const utcOffsetMinutes = Number.isFinite(userData?.registration_tz_offset)
    ? userData.registration_tz_offset
    : (Number.isFinite(profile.utc_offset_minutes) ? profile.utc_offset_minutes : 0);

  // FAST PATH: registration_date stamped at signup is the canonical anchor.
  // No floor math, no fallback chain, no race conditions. Just read it.
  if (userData?.registration_date && /^\d{4}-\d{2}-\d{2}$/.test(userData.registration_date)) {
    const [y, m, d] = userData.registration_date.split('-').map(Number);
    // Reconstruct anchorMs as that local-midnight in UTC ms.
    const shifted = Date.UTC(y, m - 1, d);
    const anchorMs = shifted - utcOffsetMinutes * 60_000;
    return {
      anchorMs,
      anchorDateStr: userData.registration_date,
      utcOffsetMinutes,
      source: 'registration_date',
      isResolved: true,
    };
  }

  // SLOW PATH (legacy users): derive from timestamps.
  let rawMs = 0;
  let source = 'none';

  if (userData) {
    rawMs = getMillis(userData.created_at) || getMillis(userData.createdAt);
    if (rawMs > 0) source = 'wellness_users.created_at';
  }
  if (rawMs <= 0 && aliveSnap.exists) {
    rawMs = getMillis(profile?.personalize_completed_at);
    if (rawMs > 0) source = 'personalize_completed_at';
  }
  if (rawMs <= 0) {
    const candidates = agentSnaps
      .map((s) => getMillis(s.exists ? s.data()?.created_at : null))
      .filter((ms) => ms > 0);
    if (candidates.length) {
      rawMs = Math.min(...candidates);
      source = 'min_agent_created_at';
    }
  }

  if (rawMs <= 0) {
    return {
      anchorMs: 0,
      anchorDateStr: null,
      utcOffsetMinutes,
      source: 'none',
      isResolved: false,
    };
  }

  const anchorMs = floorToLocalDay(rawMs, utcOffsetMinutes);
  const anchorDateStr = dateStr(new Date(anchorMs), utcOffsetMinutes);

  return {
    anchorMs,
    anchorDateStr,
    utcOffsetMinutes,
    source,
    isResolved: true,
  };
}

/**
 * Resolve registration anchor for a deviceId. 5-minute cache.
 * Always returns an object — `isResolved: false` if anchor missing.
 */
async function resolveAnchor(deviceId) {
  if (!deviceId) {
    return { anchorMs: 0, anchorDateStr: null, utcOffsetMinutes: 0, source: 'none', isResolved: false };
  }
  const cached = _cache.get(deviceId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const value = await _readAnchorRaw(deviceId);
  _cache.set(deviceId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/**
 * Force-evict the cache for a deviceId. Call after onboarding completion
 * or anchor migration so the next read picks up the new value.
 */
function invalidateAnchor(deviceId) {
  if (deviceId) _cache.delete(deviceId);
}

/**
 * For tests only. Resets cache state.
 */
function _resetCacheForTests() {
  _cache.clear();
}

module.exports = {
  resolveAnchor,
  invalidateAnchor,
  _resetCacheForTests,
};
