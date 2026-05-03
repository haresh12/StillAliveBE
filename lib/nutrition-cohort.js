'use strict';
// ════════════════════════════════════════════════════════════════════
// nutrition-cohort.js — anonymized cohort percentile service.
//
// Purpose: tell the user "you're in the top 27% for protein consistency"
// — Day 1 social-proof signal that pushes the Analysis tab from solid to
// 10/10 even without 14 days of personal data.
//
// PRIVACY MODEL:
//   - Aggregates are stored at wellness_aggregates/{cohort_key}.
//   - cohort_key = `${age_group}_${gender}` (e.g. "25-34_male")
//   - We NEVER store individual deviceIds in aggregates.
//   - k-anonymity threshold: cohort with <10 users is suppressed
//     and falls back to population priors.
//
// METRICS TRACKED (7-day rolling):
//   - avg_kcal: average daily calories
//   - avg_protein: average daily protein (g)
//   - protein_hit_pct: % of logged days that hit ≥90% of protein target
//   - cal_hit_pct:    % of logged days that landed in ±10% of cal target
//   - food_quality_avg: avg score (0–100)
//   - streak: current logging streak
//
// FRESHNESS: hourly cron rebuilds aggregates. In-memory cache 30min.
// ════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');

const db        = () => admin.firestore();
const userDoc   = (id) => db().collection('wellness_users').doc(id);
const aggDoc    = (key) => db().collection('wellness_aggregates').doc(key);

const K_ANON_THRESHOLD = 10;       // min users in a cohort to publish
const COHORT_TTL_MS    = 30 * 60 * 1000;  // 30-min in-memory cache

const TRACKED_METRICS = ['avg_kcal', 'avg_protein', 'protein_hit_pct', 'cal_hit_pct', 'food_quality_avg', 'streak'];

// ─── In-memory cache ────────────────────────────────────────────────
const _cache = new Map();
function _cacheGet(key) {
  const e = _cache.get(key);
  if (!e || Date.now() - e.t > COHORT_TTL_MS) return null;
  return e.v;
}
function _cacheSet(key, value) { _cache.set(key, { t: Date.now(), v: value }); }

// ─── Helpers ────────────────────────────────────────────────────────
function cohortKey(ageGroup, gender) {
  const ag = String(ageGroup || 'unknown').toLowerCase().replace(/[^a-z0-9-]/g, '');
  const g  = String(gender || 'unknown').toLowerCase().replace(/[^a-z]/g, '');
  return `${ag}_${g}`;
}

function percentile(sortedValues, value) {
  if (!sortedValues.length) return null;
  // Find rank of `value` in sorted ascending array
  let rank = 0;
  for (const v of sortedValues) {
    if (v <= value) rank += 1;
    else break;
  }
  return Math.round((rank / sortedValues.length) * 100);
}

function topPercent(percentileValue) {
  // Convert "you scored at the 73rd percentile" → "you're in the top 27%"
  if (percentileValue == null) return null;
  return Math.max(1, 100 - percentileValue);
}

// ─── Build cohort aggregates (cron) ──────────────────────────────────
// Scans all wellness_users with food_logs in the last 7 days, computes
// per-user 7-day averages, groups by cohort, writes percentiles.
async function rebuildCohortAggregates() {
  const t0 = Date.now();
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 7 * 86400000);

  // Collect deviceIds with recent food logs (collectionGroup query)
  const recentLogs = await db().collectionGroup('food_logs')
    .where('logged_at', '>=', cutoff)
    .select('date_str', 'calories', 'protein', 'food_quality_score')
    .limit(10000)
    .get();

  // Group logs by deviceId
  const userLogs = new Map();
  for (const doc of recentLogs.docs) {
    const m = doc.ref.path.match(/wellness_users\/([^/]+)/);
    if (!m) continue;
    const deviceId = m[1];
    if (!userLogs.has(deviceId)) userLogs.set(deviceId, []);
    userLogs.get(deviceId).push(doc.data());
  }

  // For each user: compute their 7-day metrics
  const userMetrics = [];
  for (const [deviceId, logs] of userLogs.entries()) {
    if (logs.length < 3) continue;  // need minimum data

    // Pull profile + setup in parallel
    const [profileSnap, setupSnap] = await Promise.all([
      userDoc(deviceId).get().catch(() => null),
      userDoc(deviceId).collection('agents').doc('nutrition').get().catch(() => null),
    ]);
    const profile = profileSnap?.exists ? profileSnap.data() : {};
    const setup   = setupSnap?.exists  ? setupSnap.data()   : {};
    const ageGroup = profile.ageGroup || profile.age_group || 'unknown';
    const gender   = profile.gender || 'unknown';
    const calTarget  = setup.calorie_target  || 2000;
    const protTarget = setup.protein_target  || 140;
    const streak     = setup.streak          || 0;

    // Group by date
    const byDate = {};
    for (const log of logs) {
      const date = log.date_str;
      if (!date) continue;
      if (!byDate[date]) byDate[date] = { kcal: 0, p: 0, qualities: [] };
      byDate[date].kcal += +log.calories || 0;
      byDate[date].p += +log.protein || 0;
      if (log.food_quality_score != null) byDate[date].qualities.push(+log.food_quality_score);
    }
    const days = Object.values(byDate);
    if (days.length < 3) continue;

    const totalK = days.reduce((s, d) => s + d.kcal, 0);
    const totalP = days.reduce((s, d) => s + d.p, 0);
    const avg_kcal = Math.round(totalK / days.length);
    const avg_protein = +(totalP / days.length).toFixed(1);
    const protein_hit_pct = Math.round((days.filter(d => d.p >= protTarget * 0.9).length / days.length) * 100);
    const cal_hit_pct = Math.round((days.filter(d => d.kcal >= calTarget * 0.9 && d.kcal <= calTarget * 1.1).length / days.length) * 100);
    const allQualities = days.flatMap(d => d.qualities);
    const food_quality_avg = allQualities.length ? Math.round(allQualities.reduce((s, x) => s + x, 0) / allQualities.length) : null;

    userMetrics.push({
      cohort: cohortKey(ageGroup, gender),
      avg_kcal, avg_protein, protein_hit_pct, cal_hit_pct, food_quality_avg, streak,
    });
  }

  // Group by cohort_key
  const cohortGroups = {};
  for (const u of userMetrics) {
    if (!cohortGroups[u.cohort]) cohortGroups[u.cohort] = { users: 0, samples: {} };
    cohortGroups[u.cohort].users += 1;
    for (const m of TRACKED_METRICS) {
      if (u[m] == null) continue;
      if (!cohortGroups[u.cohort].samples[m]) cohortGroups[u.cohort].samples[m] = [];
      cohortGroups[u.cohort].samples[m].push(u[m]);
    }
  }

  // Write aggregates only when k-anonymity satisfied
  let written = 0, suppressed = 0;
  const writes = [];
  for (const [cohort, group] of Object.entries(cohortGroups)) {
    if (group.users < K_ANON_THRESHOLD) {
      suppressed += 1;
      continue;
    }
    const distributions = {};
    for (const [metric, values] of Object.entries(group.samples)) {
      const sorted = [...values].sort((a, b) => a - b);
      distributions[metric] = {
        n: sorted.length,
        p10: sorted[Math.floor(sorted.length * 0.1)] || sorted[0],
        p25: sorted[Math.floor(sorted.length * 0.25)] || sorted[0],
        p50: sorted[Math.floor(sorted.length * 0.5)] || sorted[0],
        p75: sorted[Math.floor(sorted.length * 0.75)] || sorted[sorted.length - 1],
        p90: sorted[Math.floor(sorted.length * 0.9)] || sorted[sorted.length - 1],
        // Store the full sorted array (capped at 1000) so we can compute exact percentile of new users
        sorted: sorted.slice(0, 1000),
      };
    }
    writes.push(aggDoc(cohort).set({
      cohort, user_count: group.users,
      distributions,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    }));
    written += 1;
  }
  await Promise.all(writes);
  // Invalidate in-memory cache
  _cache.clear();
  console.log(`[cohort] rebuilt aggregates: ${written} cohorts written, ${suppressed} suppressed (k-anon), elapsed=${Date.now() - t0}ms`);
  return { written, suppressed, total_users: userMetrics.length };
}

// ─── Read API: get user's percentile in their cohort ────────────────
// Returns { metric: { user_value, percentile, top_pct, n_users, k_anon_met } }
async function getUserCohortPercentiles(deviceId, userMetrics, profile) {
  const ag = profile?.ageGroup || profile?.age_group || 'unknown';
  const g  = profile?.gender || 'unknown';
  const key = cohortKey(ag, g);

  // Cache hit?
  let dist = _cacheGet(key);
  if (!dist) {
    try {
      const snap = await aggDoc(key).get();
      if (!snap.exists) {
        _cacheSet(key, { _missing: true });
        return null;
      }
      dist = snap.data();
      _cacheSet(key, dist);
    } catch (err) {
      console.warn('[cohort] read failed:', err.message);
      return null;
    }
  }
  if (dist._missing || !dist.distributions) return null;

  const out = { cohort: key, user_count: dist.user_count, metrics: {} };
  for (const m of TRACKED_METRICS) {
    const v = userMetrics[m];
    const d = dist.distributions[m];
    if (v == null || !d || !d.sorted) continue;
    const pct = percentile(d.sorted, v);
    out.metrics[m] = {
      user_value: v,
      percentile: pct,
      top_pct: topPercent(pct),
      n: d.n,
    };
  }
  return out;
}

// ─── Pick the most "shareable" cohort comparison for hero insight ──
// Returns ONE crisp finding for the LLM's narrative input, or null.
// Priority: protein_hit_pct > cal_hit_pct > food_quality_avg > avg_protein > streak
function pickHeroCohortFinding(cohortPctData) {
  if (!cohortPctData?.metrics) return null;
  const PRIORITY = ['protein_hit_pct', 'cal_hit_pct', 'food_quality_avg', 'avg_protein', 'streak'];
  const LABELS = {
    protein_hit_pct: 'protein consistency',
    cal_hit_pct: 'calorie target consistency',
    food_quality_avg: 'food quality',
    avg_protein: 'daily protein',
    streak: 'logging streak',
  };
  for (const m of PRIORITY) {
    const e = cohortPctData.metrics[m];
    if (!e || e.percentile == null) continue;
    if (e.percentile >= 70 || e.percentile <= 30) {
      // Only surface clear wins or notable drags; ignore middling.
      return {
        metric: m,
        label: LABELS[m],
        percentile: e.percentile,
        top_pct: e.top_pct,
        user_value: e.user_value,
        n: e.n,
        framing: e.percentile >= 70 ? 'top' : 'low',
        cohort_size: cohortPctData.user_count,
      };
    }
  }
  return null;
}

module.exports = {
  rebuildCohortAggregates,
  getUserCohortPercentiles,
  pickHeroCohortFinding,
  cohortKey,
  K_ANON_THRESHOLD,
};
