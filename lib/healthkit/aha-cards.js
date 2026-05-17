'use strict';
/**
 * aha-cards.js — turn HealthKit imports into per-coach AHA cards.
 *
 * Each coach's /analysis endpoint calls `buildHKAhaCards({coach, deviceId})`
 * and appends the returned cards to its existing `aha_moments` array. The
 * cards show up on the Analysis tab without any FE changes — same shape as
 * AI-generated aha cards (`{ kpi, body }`).
 *
 * Why this exists:
 *   The score blender already mixes HK + manual into the daily score, but
 *   the AI-generated insight narratives only see manual logs. Users who
 *   grant HK get a higher score with no visible reason. These cards close
 *   that loop — they explicitly tell the user "your HRV is 18% below
 *   baseline this week" so they FEEL the value of having granted HK.
 *
 * Returns []  on any error or no data. Callers always concat safely.
 */

const log = require('../log');

const ONE_DAY_MS = 24 * 3600 * 1000;

async function readImports(db, deviceId, coach, lookbackDays = 14) {
  if (!db || !deviceId || !coach) return [];
  try {
    const sinceMs = Date.now() - lookbackDays * ONE_DAY_MS;
    const snap = await db
      .collection('wellness_users')
      .doc(deviceId)
      .collection('agents')
      .doc(coach)
      .collection('healthkit_imports')
      .limit(3000)
      .get();
    const out = [];
    for (const d of snap.docs) {
      const data = d.data();
      const ts = Date.parse(data.start_date);
      if (!Number.isFinite(ts) || ts < sinceMs) continue;
      out.push({ ...data, _ts: ts });
    }
    return out;
  } catch (err) {
    log.warn(`[hk-aha/${coach}] read failed:`, err.message);
    return [];
  }
}

function median(arr) {
  if (!arr || arr.length === 0) return null;
  const a = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// ─── Per-coach builders ───────────────────────────────────────────────────

function sleepAhaCards(samples) {
  const stages = samples.filter((s) => s.hk_type === 'HKCategoryTypeIdentifierSleepAnalysis');
  if (stages.length === 0) return [];

  // Bucket per night and compute totals
  const byDate = {};
  for (const s of stages) {
    const date = String(s.start_date || '').slice(0, 10);
    if (!date) continue;
    if (!byDate[date]) byDate[date] = { asleepMs: 0, awakeMs: 0 };
    const dur = Date.parse(s.end_date) - Date.parse(s.start_date);
    if (!Number.isFinite(dur) || dur <= 0) continue;
    if (s.stage === 'awake') byDate[date].awakeMs += dur;
    else if (s.stage && s.stage !== 'inBed') byDate[date].asleepMs += dur;
  }
  const nights = Object.values(byDate).filter((n) => n.asleepMs > 0);
  if (nights.length < 3) return [];

  const hours = nights.map((n) => n.asleepMs / 3_600_000);
  const avgH = hours.reduce((a, b) => a + b, 0) / hours.length;
  const med = median(hours);
  const cards = [];
  cards.push({
    kpi: `${avgH.toFixed(1)}h avg sleep`,
    body: `Across ${nights.length} measured nights. ${med >= 7 ? 'Right in the recovery zone.' : med >= 6 ? 'Slightly under — small tweaks compound.' : 'Below the floor. Your Mind/Fitness coaches will adjust.'}`,
  });
  return cards;
}

function mindAhaCards(samples) {
  const hrv = samples
    .filter((s) => s.hk_type === 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN' && Number.isFinite(Number(s.value)))
    .sort((a, b) => a._ts - b._ts);
  if (hrv.length < 5) return [];

  const todayStart = Date.now() - 2 * ONE_DAY_MS;
  const recent = hrv.filter((s) => s._ts >= todayStart).map((s) => Number(s.value));
  const baseline = hrv.filter((s) => s._ts < todayStart).map((s) => Number(s.value));
  if (recent.length === 0 || baseline.length === 0) return [];

  const recentMean = Math.round(recent.reduce((a, b) => a + b, 0) / recent.length);
  const baselineMed = Math.round(median(baseline));
  if (!Number.isFinite(recentMean) || !Number.isFinite(baselineMed) || baselineMed === 0) return [];

  const deltaPct = Math.round(((recentMean - baselineMed) / baselineMed) * 100);
  const cards = [];
  if (deltaPct <= -10) {
    cards.push({
      kpi: `HRV down ${Math.abs(deltaPct)}% vs your baseline`,
      body: `${recentMean}ms vs ${baselineMed}ms baseline. Real stress signal — slower pace today.`,
    });
  } else if (deltaPct >= 10) {
    cards.push({
      kpi: `HRV up ${deltaPct}% vs baseline`,
      body: `${recentMean}ms vs ${baselineMed}ms. Recovered well — green light for harder effort.`,
    });
  } else {
    cards.push({
      kpi: `HRV holding at ${recentMean}ms`,
      body: `Within ${Math.abs(deltaPct)}% of your ${baselineMed}ms baseline. Steady recovery.`,
    });
  }
  return cards;
}

function fitnessAhaCards(samples) {
  const workouts = samples.filter((s) => s.hk_type === 'HKWorkoutTypeIdentifier');
  const steps = samples.filter((s) => s.hk_type === 'HKQuantityTypeIdentifierStepCount');
  const cards = [];

  if (workouts.length >= 1) {
    const lastWeek = workouts.filter((w) => Date.now() - w._ts < 7 * ONE_DAY_MS);
    const totalMin = Math.round(lastWeek.reduce((sum, w) => sum + (Number(w.duration) || 0), 0) / 60);
    if (totalMin > 0) {
      cards.push({
        kpi: `${lastWeek.length} workouts · ${totalMin} min this week`,
        body: `${totalMin >= 150 ? 'Above the 150-min weekly threshold — solid.' : 'Climb gently — even one more session helps.'}`,
      });
    }
  }

  if (steps.length >= 5) {
    const byDate = {};
    for (const s of steps) {
      const d = String(s.start_date || '').slice(0, 10);
      byDate[d] = (byDate[d] || 0) + (Number(s.value) || 0);
    }
    const days = Object.values(byDate);
    if (days.length >= 3) {
      const med = Math.round(median(days));
      cards.push({
        kpi: `${med.toLocaleString()} typical daily steps`,
        body: med >= 8000
          ? `Median across ${days.length} days. You hit the daily floor most days.`
          : `Median across ${days.length} days. The 7-8k range is where mortality risk drops most.`,
      });
    }
  }
  return cards.slice(0, 2);
}

function nutritionAhaCards(samples) {
  const cards = [];

  // ── Weight trend card (need ≥2 readings) ──────────────────────────────
  const weights = samples
    .filter((s) => s.hk_type === 'HKQuantityTypeIdentifierBodyMass' && Number.isFinite(Number(s.value)))
    .sort((a, b) => a._ts - b._ts);
  if (weights.length >= 2) {
    const oldest = Number(weights[0].value);
    const latest = Number(weights[weights.length - 1].value);
    const deltaKg = latest - oldest;
    const absDelta = Math.abs(deltaKg);
    if (absDelta < 0.3) {
      cards.push({
        kpi: `Weight stable: ${latest.toFixed(1)} kg`,
        body: `Across ${weights.length} readings. Stability is a signal of energy balance.`,
      });
    } else {
      cards.push({
        kpi: `${deltaKg > 0 ? '+' : ''}${deltaKg.toFixed(1)} kg over ${weights.length} readings`,
        body: `From ${oldest.toFixed(1)} → ${latest.toFixed(1)} kg. ${deltaKg < 0 ? 'Trending down.' : 'Trending up.'} Your nutrition coach is reading this.`,
      });
    }
  } else if (weights.length === 1) {
    // Single weigh-in: surface it as a baseline card so a brand-new user
    // who weighed in once still sees their data acknowledged.
    cards.push({
      kpi: `Baseline weight: ${Number(weights[0].value).toFixed(1)} kg`,
      body: `One reading so far — log a few more days to see the trend.`,
    });
  }

  // ── Macro intake card (any day with macros) ───────────────────────────
  const byDate = {};
  for (const s of samples) {
    const date = String(s.start_date || '').slice(0, 10);
    if (!date) continue;
    if (s.hk_type === 'HKQuantityTypeIdentifierDietaryEnergyConsumed') {
      if (!byDate[date]) byDate[date] = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
      byDate[date].kcal += Number(s.value) || 0;
    } else if (s.hk_type === 'HKQuantityTypeIdentifierDietaryProtein') {
      if (!byDate[date]) byDate[date] = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
      byDate[date].protein += Number(s.value) || 0;
    } else if (s.hk_type === 'HKQuantityTypeIdentifierDietaryCarbohydrates') {
      if (!byDate[date]) byDate[date] = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
      byDate[date].carbs += Number(s.value) || 0;
    } else if (s.hk_type === 'HKQuantityTypeIdentifierDietaryFatTotal') {
      if (!byDate[date]) byDate[date] = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
      byDate[date].fat += Number(s.value) || 0;
    }
  }
  const macroDays = Object.entries(byDate).filter(([, d]) => (d.kcal + d.protein + d.carbs + d.fat) > 0);
  if (macroDays.length > 0) {
    // Derive kcal from macros if not directly recorded.
    const totalKcal = macroDays.reduce((s, [, d]) => s + (d.kcal > 0 ? d.kcal : d.protein * 4 + d.carbs * 4 + d.fat * 9), 0);
    const totalProtein = macroDays.reduce((s, [, d]) => s + d.protein, 0);
    const avgKcal = Math.round(totalKcal / macroDays.length);
    const avgProtein = Math.round(totalProtein / macroDays.length);
    cards.push({
      kpi: `${avgKcal} kcal · ${avgProtein}g protein avg`,
      body: `Across ${macroDays.length} day${macroDays.length === 1 ? '' : 's'} of intake. Your nutrition coach uses these numbers automatically.`,
    });
  }

  return cards;
}

function waterAhaCards(samples) {
  const water = samples.filter((s) => s.hk_type === 'HKQuantityTypeIdentifierDietaryWater');
  if (water.length < 3) return [];
  const byDate = {};
  for (const s of water) {
    const d = String(s.start_date || '').slice(0, 10);
    byDate[d] = (byDate[d] || 0) + (Number(s.value) || 0);
  }
  const days = Object.values(byDate);
  if (days.length < 3) return [];
  const avgMl = Math.round(days.reduce((a, b) => a + b, 0) / days.length);
  return [{
    kpi: `${avgMl} ml/day average`,
    body: `${days.length} days tracked. ${avgMl < 1500 ? 'Below comfort line — set a noon checkpoint.' : avgMl < 2200 ? 'Solid baseline — stay there on travel days.' : 'Strong hydration. Protect it.'}`,
  }];
}

function fastingAhaCards(samples) {
  // No direct HK signal for fasting (it's explicit user intent). Glucose
  // readings are too domain-specific to interpret without a clinical lens.
  // Return empty — fasting coach gets cross-agent HK context via prompts.
  return [];
}

const BUILDERS = {
  sleep: sleepAhaCards,
  mind: mindAhaCards,
  fitness: fitnessAhaCards,
  nutrition: nutritionAhaCards,
  water: waterAhaCards,
  fasting: fastingAhaCards,
};

/**
 * Build HK-derived AHA cards for a coach.
 *
 * @param {object} args
 * @param {string} args.coach
 * @param {string} args.deviceId
 * @param {object} args.db                firestore
 * @param {number} [args.lookbackDays=14] window for HK reads
 * @returns {Promise<Array<{kpi: string, body: string}>>}
 */
async function buildHKAhaCards({ coach, deviceId, db, lookbackDays = 14 }) {
  const builder = BUILDERS[coach];
  if (!builder || !deviceId || !db) {
    log.info(`[hk-aha/${coach}] skip — no builder or no deviceId/db`);
    return [];
  }
  try {
    const samples = await readImports(db, deviceId, coach, lookbackDays);
    if (samples.length === 0) {
      log.info(`[hk-aha/${coach}] no HK samples in last ${lookbackDays}d device=${deviceId.slice(0, 8)}`);
      return [];
    }
    const cards = builder(samples) || [];
    log.info(`[hk-aha/${coach}] produced=${cards.length} cards from samples=${samples.length} device=${deviceId.slice(0, 8)}`);
    return cards.map((c) => ({
      ...c,
      kpi: String(c.kpi || '').slice(0, 80),
      body: String(c.body || '').slice(0, 220),
      source: 'healthkit',
    }));
  } catch (err) {
    log.warn(`[hk-aha/${coach}] failed:`, err.message);
    return [];
  }
}

module.exports = { buildHKAhaCards };
