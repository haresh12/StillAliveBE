'use strict';
// ════════════════════════════════════════════════════════════════════
// nutrition-correction-store.js — per-user nutrition correction stream.
//
// Closes Cal AI's biggest user complaint: "you can't teach it" (eesel
// review). Every time a user adjusts a parsed item (kcal, food name,
// macro split, serving multiplier) we persist the {original, corrected}
// pair keyed by user + normalized food name. Future vision/voice
// prompts fetch the most recent 3-5 corrections and inject them as
// few-shot calibration ("this user's 'salad' is typically 320 kcal,
// not 450 — bias lower").
//
// Firestore layout:
//   wellness_users/{deviceId}/nutrition_corrections/{normalizedName}
//   {
//     food_name_canonical: 'greek yogurt',
//     latest: { original: {...}, corrected: {...}, ts: ... },
//     count: 4,
//     source_breakdown: { photo: 2, voice: 1, manual: 1 },
//     first_correction_at: ts,
//     last_correction_at:  ts,
//   }
//
// Eviction: per-user TTL doc-level field `last_correction_at` — we read
// only docs touched in the last 180 days. Docs older than that are
// ignored (cheaper than a periodic cleanup cron).
//
// All exports are pure functions that take a Firestore instance — no
// hardcoded admin SDK, so tests can pass a mock.
// ════════════════════════════════════════════════════════════════════

const CORRECTION_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days
const MAX_FEWSHOT = 5;

function normalizeFoodKey(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Write one correction to the per-user stream. Idempotent on (user,
 * normalized food name) — repeat corrections update the doc instead of
 * stacking new ones.
 *
 * @param {Object} db    — admin.firestore() instance
 * @param {string} deviceId
 * @param {Object} entry — { source, photo_hash?, original, corrected, serving_multiplier? }
 */
async function writeCorrection(db, deviceId, entry) {
  if (!db || !deviceId || !entry?.corrected?.food_name) return;
  const key = normalizeFoodKey(entry.corrected.food_name) || normalizeFoodKey(entry.original?.food_name);
  if (!key) return;
  const ref = db
    .collection('wellness_users').doc(deviceId)
    .collection('nutrition_corrections').doc(key);

  const now = Date.now();
  const sourceField = ['photo', 'voice', 'manual'].includes(entry.source) ? entry.source : 'manual';

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const prior = snap.exists ? snap.data() : null;
      const sourceBreakdown = Object.assign(
        {photo: 0, voice: 0, manual: 0},
        prior?.source_breakdown || {},
      );
      sourceBreakdown[sourceField] = (sourceBreakdown[sourceField] || 0) + 1;

      tx.set(ref, {
        food_name_canonical: (entry.corrected.food_name || '').toString().toLowerCase().trim(),
        latest: {
          original: entry.original || {},
          corrected: entry.corrected || {},
          source: sourceField,
          photo_hash: entry.photo_hash || null,
          serving_multiplier: entry.serving_multiplier || 1,
          ts: now,
        },
        count: (prior?.count || 0) + 1,
        source_breakdown: sourceBreakdown,
        first_correction_at: prior?.first_correction_at || now,
        last_correction_at: now,
      }, {merge: true});
    });
  } catch (e) {
    // Best-effort writes — never block save UX on a correction stream error.
    try {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[nutrition-correction-store] writeCorrection failed', e?.message);
      }
    } catch (_) {}
  }
}

/**
 * Read the most-recent N corrections for a user, filtered to docs touched
 * in the last 180d. Returns an array of `latest` payloads ordered by
 * recency (newest first).
 */
async function readRecentCorrections(db, deviceId, limit = MAX_FEWSHOT) {
  if (!db || !deviceId) return [];
  const cap = Math.max(1, Math.min(limit, 20));
  const cutoff = Date.now() - CORRECTION_TTL_MS;
  try {
    const snaps = await db
      .collection('wellness_users').doc(deviceId)
      .collection('nutrition_corrections')
      .where('last_correction_at', '>=', cutoff)
      .orderBy('last_correction_at', 'desc')
      .limit(cap)
      .get();
    const out = [];
    snaps.forEach((s) => {
      const data = s.data();
      if (data?.latest) out.push(data.latest);
    });
    return out;
  } catch (e) {
    // Composite-index missing on first deploy → silently return [].
    return [];
  }
}

/**
 * Optional read by a specific normalized food name — used when the
 * vision model has already produced an ID and we want a *targeted*
 * correction for THIS food specifically.
 */
async function readCorrectionForFood(db, deviceId, foodName) {
  if (!db || !deviceId || !foodName) return null;
  const key = normalizeFoodKey(foodName);
  if (!key) return null;
  try {
    const ref = db
      .collection('wellness_users').doc(deviceId)
      .collection('nutrition_corrections').doc(key);
    const snap = await ref.get();
    if (!snap.exists) return null;
    const data = snap.data();
    if (!data?.last_correction_at || data.last_correction_at < Date.now() - CORRECTION_TTL_MS) return null;
    return data.latest || null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  writeCorrection,
  readRecentCorrections,
  readCorrectionForFood,
  normalizeFoodKey,
  CORRECTION_TTL_MS,
  MAX_FEWSHOT,
};
