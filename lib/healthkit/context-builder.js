'use strict';
/**
 * context-builder.js — turns HealthKit imports into a compact prompt block.
 *
 * SHARED by chat-stream, coach-letter, actions-engine, and anywhere else
 * we need the LLM to be aware of HK signals. Returns a SHORT (≤ 400 char)
 * string the prompt template can interpolate, or '' when the user has no
 * HK data — so callers can always do `systemPrompt + hkBlock` safely.
 *
 * Per-coach summary picks the 1-2 metrics that actually move that coach's
 * decisions:
 *
 *   sleep      Last-night duration + efficiency from HKSleepAnalysis
 *   mind       HRV today vs 7d median (stress proxy)
 *   fitness    Today's steps + last workout (type/duration)
 *   nutrition  Today's HK-logged calories (e.g. MyFitnessPal write-through)
 *   water      Today's HK water ml total
 *   fasting    Most recent blood glucose if present, else last meal time
 *
 * Caching: per-call only (no shared cache here). Reading 7 days of one
 * collection is cheap (< 100 docs in 99% of cases), and the prompt itself
 * isn't cached on the OpenAI side anyway when HK numbers change daily.
 *
 * Failure mode: returns '' on ANY error so chat/letter/actions never
 * crash when HK is unavailable.
 */

const log = require('../log');

const ONE_DAY_MS = 24 * 3600 * 1000;

function localDateStr(d = new Date(), utcOffsetMinutes = 0) {
  const ms = d.getTime() + utcOffsetMinutes * 60_000;
  const x = new Date(ms);
  const y = x.getUTCFullYear();
  const m = String(x.getUTCMonth() + 1).padStart(2, '0');
  const day = String(x.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function median(arr) {
  if (!arr || arr.length === 0) return null;
  const a = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

async function readImports(db, deviceId, coach, sinceMs) {
  if (!db || !deviceId || !coach) return [];
  try {
    const snap = await db
      .collection('wellness_users')
      .doc(deviceId)
      .collection('agents')
      .doc(coach)
      .collection('healthkit_imports')
      .limit(2000)
      .get();
    const out = [];
    for (const d of snap.docs) {
      const data = d.data();
      const ts = Date.parse(data.start_date);
      if (!Number.isFinite(ts)) continue;
      if (sinceMs && ts < sinceMs) continue;
      out.push({ ...data, _ts: ts });
    }
    return out;
  } catch (err) {
    log.warn(`[hk-context/${coach}] read failed:`, err.message);
    return [];
  }
}

// ─── Per-coach summary builders ───────────────────────────────────────────

function summarizeSleep(samples) {
  // Group last-night sleep stages: take samples from past 24h.
  const last24 = samples.filter((s) => Date.now() - s._ts < ONE_DAY_MS);
  const stages = last24.filter((s) => s.hk_type === 'HKCategoryTypeIdentifierSleepAnalysis');
  if (stages.length === 0) return '';
  let asleepMs = 0;
  let awakeMs = 0;
  for (const s of stages) {
    const dur = Date.parse(s.end_date) - Date.parse(s.start_date);
    if (!Number.isFinite(dur) || dur <= 0) continue;
    if (s.stage === 'awake') awakeMs += dur;
    else if (s.stage && s.stage !== 'inBed') asleepMs += dur;
  }
  if (asleepMs === 0) return '';
  const hrs = (asleepMs / 3_600_000).toFixed(1);
  const inBedMs = asleepMs + awakeMs;
  const eff = inBedMs > 0 ? Math.round((asleepMs / inBedMs) * 100) : null;
  const effStr = eff != null ? `, ${eff}% efficiency` : '';
  return `[HK] Last night: ${hrs}h asleep${effStr}.`;
}

function summarizeMind(samples) {
  const hrvSamples = samples
    .filter((s) => s.hk_type === 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN' && Number.isFinite(Number(s.value)))
    .sort((a, b) => a._ts - b._ts);
  if (hrvSamples.length < 2) return '';

  const todayStart = Date.now() - ONE_DAY_MS;
  const todayVals = hrvSamples.filter((s) => s._ts >= todayStart).map((s) => Number(s.value));
  const baselineVals = hrvSamples.filter((s) => s._ts < todayStart).map((s) => Number(s.value));
  if (todayVals.length === 0 || baselineVals.length === 0) return '';

  const todayMean = Math.round(todayVals.reduce((a, b) => a + b, 0) / todayVals.length);
  const baselineMed = Math.round(median(baselineVals));
  if (!Number.isFinite(todayMean) || !Number.isFinite(baselineMed) || baselineMed === 0) return '';

  const deltaPct = Math.round(((todayMean - baselineMed) / baselineMed) * 100);
  const direction = deltaPct < -10 ? 'BELOW' : deltaPct > 10 ? 'ABOVE' : 'near';
  return `[HK] HRV today ${todayMean}ms, ${direction} 7d baseline ${baselineMed}ms (${deltaPct >= 0 ? '+' : ''}${deltaPct}%).`;
}

function summarizeFitness(samples) {
  const todayStart = Date.now() - ONE_DAY_MS;
  const steps = samples
    .filter((s) => s.hk_type === 'HKQuantityTypeIdentifierStepCount' && s._ts >= todayStart)
    .reduce((sum, s) => sum + (Number(s.value) || 0), 0);
  const workouts = samples
    .filter((s) => s.hk_type === 'HKWorkoutTypeIdentifier')
    .sort((a, b) => b._ts - a._ts);
  const parts = [];
  if (steps > 0) parts.push(`${steps.toLocaleString()} steps today`);
  if (workouts.length > 0) {
    const last = workouts[0];
    const ageH = Math.round((Date.now() - last._ts) / 3_600_000);
    const durMin = Math.round((Number(last.duration) || 0) / 60);
    const wt = last.workout_type || 'workout';
    parts.push(`last ${wt} ${durMin}min, ${ageH}h ago`);
  }
  if (parts.length === 0) return '';
  return `[HK] ${parts.join('; ')}.`;
}

function summarizeNutrition(samples) {
  const todayStart = Date.now() - ONE_DAY_MS;
  const kcal = samples
    .filter((s) => s.hk_type === 'HKQuantityTypeIdentifierDietaryEnergyConsumed' && s._ts >= todayStart)
    .reduce((sum, s) => sum + (Number(s.value) || 0), 0);
  const weights = samples
    .filter((s) => s.hk_type === 'HKQuantityTypeIdentifierBodyMass')
    .sort((a, b) => b._ts - a._ts);
  const parts = [];
  if (kcal > 0) parts.push(`${Math.round(kcal)} kcal logged via Apple Health today`);
  if (weights.length > 0) {
    const v = Number(weights[0].value);
    if (Number.isFinite(v)) parts.push(`weight ${v.toFixed(1)} on file`);
  }
  if (parts.length === 0) return '';
  return `[HK] ${parts.join('; ')}.`;
}

function summarizeWater(samples) {
  const todayStart = Date.now() - ONE_DAY_MS;
  const totalMl = samples
    .filter((s) => s.hk_type === 'HKQuantityTypeIdentifierDietaryWater' && s._ts >= todayStart)
    .reduce((sum, s) => sum + (Number(s.value) || 0), 0);
  if (totalMl <= 0) return '';
  return `[HK] ${Math.round(totalMl)}ml logged today via Apple Health.`;
}

function summarizeFasting(samples) {
  const glucose = samples
    .filter((s) => s.hk_type === 'HKQuantityTypeIdentifierBloodGlucose' && Number.isFinite(Number(s.value)))
    .sort((a, b) => b._ts - a._ts);
  if (glucose.length === 0) return '';
  const last = glucose[0];
  const ageH = Math.round((Date.now() - last._ts) / 3_600_000);
  const v = Number(last.value).toFixed(0);
  return `[HK] Last blood glucose ${v} (${ageH}h ago).`;
}

const SUMMARIZERS = {
  sleep: summarizeSleep,
  mind: summarizeMind,
  fitness: summarizeFitness,
  nutrition: summarizeNutrition,
  water: summarizeWater,
  fasting: summarizeFasting,
};

// ─── Public API ────────────────────────────────────────────────────────────

// "No HK data" short-circuit cache. Manual-only users would otherwise pay
// ~50-150ms per chat call doing a Firestore query that returns 0 rows.
// We cache the "this user has no samples for this coach" verdict for 5 min;
// the cache self-heals on every successful sync (or after TTL).
//
// Hard rule: the cache is FAIL-OPEN. Any error reading skips caching so
// genuine HK users never get stuck with a stale negative.
const NO_HK_CACHE = new Map(); // key: `${deviceId}:${coach}` → { ts: ms }
const NO_HK_TTL_MS = 5 * 60 * 1000;

function _cacheKey(deviceId, coach) { return `${deviceId}:${coach}`; }
function _isCachedNoHK(deviceId, coach) {
  const v = NO_HK_CACHE.get(_cacheKey(deviceId, coach));
  if (!v) return false;
  if (Date.now() - v.ts > NO_HK_TTL_MS) {
    NO_HK_CACHE.delete(_cacheKey(deviceId, coach));
    return false;
  }
  return true;
}
function _cacheNoHK(deviceId, coach) {
  NO_HK_CACHE.set(_cacheKey(deviceId, coach), { ts: Date.now() });
  // Bound the cache so it can't grow unbounded.
  if (NO_HK_CACHE.size > 5000) NO_HK_CACHE.delete(NO_HK_CACHE.keys().next().value);
}
/** Call this after a successful HK import so the cache invalidates immediately. */
function invalidateHKCache(deviceId, coach) {
  if (coach) NO_HK_CACHE.delete(_cacheKey(deviceId, coach));
  else for (const k of NO_HK_CACHE.keys()) if (k.startsWith(`${deviceId}:`)) NO_HK_CACHE.delete(k);
}

/**
 * Build an HK summary block for a coach. Returns '' on any error / no data.
 *
 * @param {object} args
 * @param {object} args.db          firestore instance
 * @param {string} args.deviceId
 * @param {string} args.coach       sleep|mind|fitness|nutrition|water|fasting
 * @param {number} [args.days=7]    lookback window in days
 * @returns {Promise<string>}
 */
async function buildHKContext({ db, deviceId, coach, days = 7 }) {
  const summarize = SUMMARIZERS[coach];
  if (!summarize || !deviceId || !db) return '';
  // Short-circuit: manual-only user we've already confirmed has no samples
  // for this coach. Skip the Firestore round trip entirely.
  if (_isCachedNoHK(deviceId, coach)) return '';
  try {
    const sinceMs = Date.now() - days * ONE_DAY_MS;
    const samples = await readImports(db, deviceId, coach, sinceMs);
    if (samples.length === 0) {
      _cacheNoHK(deviceId, coach);
      return '';
    }
    return summarize(samples) || '';
  } catch (err) {
    log.warn(`[hk-context/${coach}] failed:`, err.message);
    return '';
  }
}

/**
 * Append the HK block to a system prompt with a clear delimiter. If the
 * block is empty, returns the original prompt unchanged.
 *
 * Silent-magic rule (per [[feedback_hk_silent_magic]]): the LLM treats
 * these as the user's own data and NEVER names the source. No "Apple
 * Health", no "your watch", no "wearable" — just "your 6.4h asleep" or
 * "your steps were ...". The aha is the precision, not the source.
 */
function appendHKContext(systemPrompt, hkBlock) {
  if (!hkBlock || !hkBlock.trim()) return systemPrompt;
  return `${systemPrompt}\n\n# Objective signals for this user (factual — treat as the user's own data)\n${hkBlock}\nCite these numbers verbatim when relevant. NEVER name the data source ("Apple Health", "your watch", "wearable", "device") — speak as if they're simply the user's data. If they contradict the user's manual log for today, ASK rather than assume.`;
}

module.exports = {
  buildHKContext,
  appendHKContext,
  invalidateHKCache,
  // Exposed for testing
  _internals: {
    summarizeSleep,
    summarizeMind,
    summarizeFitness,
    summarizeNutrition,
    summarizeWater,
    summarizeFasting,
    localDateStr,
  },
};
