'use strict';
/**
 * hk-insights.js — Did-You-Know facts derived silently from HealthKit
 * rollups for users who have granted wearable / Apple Health access.
 *
 * Hard rules (per the silent-magic law):
 *   1. Never name the data source. No "Apple Health", "watch", "wearable",
 *      "device" copy. The fact reads as if it's the user's own data — which
 *      it is. The aha is the insight, not the source.
 *   2. Returns [] when the user has no HK data. The downstream library
 *      filler keeps the same total card count for manual users.
 *   3. Cheap to compute — pulls last 7-14 days of rolled-up HK stats only.
 *      No native calls, no LLM. Pure derivation from already-stored data.
 *
 * Wired in: wellness-cross-v2/orchestrator/workflow.js, merged in front of
 * buildDidYouKnow output before the TARGET_TOTAL slice.
 */

const admin = require('firebase-admin');

const userDoc = (db, deviceId) => db.collection('wellness_users').doc(deviceId);

// Module-level cache: short-circuit DYK HK insights for manual-only users
// so they don't pay 3 Firestore reads per Home pack build. The cache
// flips to "no HK" only after we've confirmed all three priority coaches
// (sleep, fitness, mind) return zero samples. Self-heals in 5 min.
const NO_HK_DYK_CACHE = new Map(); // deviceId → ts
const NO_HK_DYK_TTL_MS = 5 * 60 * 1000;
function _isCachedNoHKDYK(deviceId) {
  const ts = NO_HK_DYK_CACHE.get(deviceId);
  if (!ts) return false;
  if (Date.now() - ts > NO_HK_DYK_TTL_MS) {
    NO_HK_DYK_CACHE.delete(deviceId);
    return false;
  }
  return true;
}
function _cacheNoHKDYK(deviceId) {
  NO_HK_DYK_CACHE.set(deviceId, Date.now());
  if (NO_HK_DYK_CACHE.size > 5000) NO_HK_DYK_CACHE.delete(NO_HK_DYK_CACHE.keys().next().value);
}

// Round to 1 decimal then back to number — used everywhere we surface a value.
const r1 = (n) => Math.round(n * 10) / 10;

/**
 * Read the most recent 14 days of HK imports for a coach. Returns []
 * gracefully when none exist or anything fails.
 */
async function readRecentHKSamples(db, deviceId, coach, type, days = 14) {
  try {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const snap = await userDoc(db, deviceId)
      .collection('agents').doc(coach)
      .collection('healthkit_imports')
      .where('type', '==', type)
      .where('startDate', '>=', since)
      .orderBy('startDate', 'desc')
      .limit(days * 5)
      .get();
    return snap.docs.map((d) => d.data()).filter((d) => Number.isFinite(d?.value));
  } catch {
    return [];
  }
}

/**
 * Group samples by local-TZ day and aggregate values per day.
 * agg = 'sum' | 'avg' | 'latest'
 */
function aggregateByDay(samples, agg) {
  const byDay = {};
  for (const s of samples) {
    const date = String(s.startDate || '').slice(0, 10);
    if (!date) continue;
    if (!byDay[date]) byDay[date] = { sum: 0, count: 0, last: null };
    byDay[date].sum += s.value;
    byDay[date].count += 1;
    byDay[date].last = s.value;
  }
  const days = Object.keys(byDay).sort();
  return days.map((d) => {
    const b = byDay[d];
    let value;
    if (agg === 'sum') value = b.sum;
    else if (agg === 'avg') value = b.count > 0 ? b.sum / b.count : null;
    else value = b.last;
    return { date: d, value };
  });
}

/** Slice a values series into recent-N vs prior-N for delta comparison. */
function recentVsPrior(series, n = 7) {
  const recent = series.slice(-n).filter((x) => Number.isFinite(x.value));
  const prior = series.slice(-2 * n, -n).filter((x) => Number.isFinite(x.value));
  const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x.value, 0) / arr.length : null);
  return { recent: avg(recent), prior: avg(prior), n_recent: recent.length, n_prior: prior.length };
}

/**
 * Build HK-derived DYK facts (0..3). Silent — no source attribution in copy.
 * Each fact has the same shape as personal-insights.js outputs.
 */
async function buildHKInsights({ deviceId, admin: adminLib }) {
  const out = [];
  if (!deviceId) return out;
  // Short-circuit for manual users — skip 3 wasted Firestore reads per Home build.
  if (_isCachedNoHKDYK(deviceId)) return out;
  const fb = adminLib || admin;
  const db = fb.firestore();
  let foundAny = false;

  // 1. Sleep trend — 7-day avg hours vs prior 7
  try {
    const samples = await readRecentHKSamples(db, deviceId, 'sleep', 'sleep', 14);
    if (samples.length > 0) foundAny = true;
    if (samples.length >= 5) {
      // Aggregate asleep minutes per night (skip awake / inBed stages)
      const byNight = {};
      for (const s of samples) {
        if (!s.stage || s.stage === 'awake' || s.stage === 'inBed') continue;
        const date = String(s.startDate || '').slice(0, 10);
        if (!date) continue;
        const dur = (Date.parse(s.endDate) - Date.parse(s.startDate)) / 3_600_000;
        if (!Number.isFinite(dur) || dur <= 0) continue;
        byNight[date] = (byNight[date] || 0) + dur;
      }
      const series = Object.keys(byNight).sort().map((d) => ({ date: d, value: byNight[d] }));
      const { recent, prior, n_recent } = recentVsPrior(series, 7);
      if (Number.isFinite(recent) && Number.isFinite(prior) && n_recent >= 3) {
        const delta = recent - prior;
        if (Math.abs(delta) >= 0.4) {
          const dir = delta > 0 ? 'up' : 'down';
          out.push({
            eyebrow: 'YOUR SLEEP',
            body: `You're averaging ${r1(recent)} hr a night this week — ${dir} ${Math.abs(r1(delta))} hr from last.`,
            source: '7-day trend',
            kind: 'hk_sleep_trend',
            evidence_field: 'hk.sleep.recent_avg',
            confidence: 'strong',
          });
        }
      }
    }
  } catch { /* swallow */ }

  // 2. Steps — 7d daily avg vs prior 7d (only if non-trivial)
  try {
    const samples = await readRecentHKSamples(db, deviceId, 'fitness', 'steps', 14);
    if (samples.length > 0) foundAny = true;
    if (samples.length >= 3) {
      const series = aggregateByDay(samples, 'sum');
      const { recent, prior, n_recent } = recentVsPrior(series, 7);
      if (Number.isFinite(recent) && Number.isFinite(prior) && n_recent >= 3) {
        const delta = recent - prior;
        const recentRounded = Math.round(recent);
        if (Math.abs(delta) >= 800 && recentRounded > 0) {
          const dir = delta > 0 ? 'up' : 'down';
          out.push({
            eyebrow: 'YOUR MOVEMENT',
            body: `Daily step average ${recentRounded.toLocaleString()} — ${dir} ${Math.abs(Math.round(delta)).toLocaleString()} vs last week.`,
            source: '7-day trend',
            kind: 'hk_steps_trend',
            evidence_field: 'hk.steps.recent_avg',
            confidence: 'strong',
          });
        }
      }
    }
  } catch { /* swallow */ }

  // 3. HRV — 7d avg vs prior 7d. Increase = better recovery.
  try {
    const samples = await readRecentHKSamples(db, deviceId, 'mind', 'hrv', 14);
    if (samples.length > 0) foundAny = true;
    if (samples.length >= 4) {
      const series = aggregateByDay(samples, 'avg');
      const { recent, prior, n_recent } = recentVsPrior(series, 7);
      if (Number.isFinite(recent) && Number.isFinite(prior) && n_recent >= 3) {
        const delta = recent - prior;
        const pctChange = (Math.abs(delta) / prior) * 100;
        if (pctChange >= 8) {
          const better = delta > 0;
          out.push({
            eyebrow: 'YOUR RECOVERY',
            body: better
              ? `Recovery signal trending stronger — ${r1(recent)} ms, up ${Math.round(pctChange)}% from last week.`
              : `Recovery signal softer this week — ${r1(recent)} ms, down ${Math.round(pctChange)}%. Easier days may pay off.`,
            source: '7-day trend',
            kind: 'hk_hrv_trend',
            evidence_field: 'hk.hrv.recent_avg',
            confidence: 'moderate',
          });
        }
      }
    }
  } catch { /* swallow */ }

  // If all three priority coaches returned zero samples, cache the negative
  // so the next Home build short-circuits before doing 3 wasted reads.
  if (!foundAny) _cacheNoHKDYK(deviceId);

  return out;
}

/** Call after a successful HK import so the cache invalidates immediately. */
function invalidateHKDYKCache(deviceId) {
  NO_HK_DYK_CACHE.delete(deviceId);
}

module.exports = { buildHKInsights, invalidateHKDYKCache };
