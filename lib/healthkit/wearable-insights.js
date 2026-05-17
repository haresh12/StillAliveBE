'use strict';
/**
 * wearable-insights.js — builds the "Wearable Insights" section payload
 * for a coach's Analysis tab. Separate from manual-log surfaces.
 *
 * ARCHITECTURE LAWS (10/10 + backward-compatible):
 *
 *   1. ADDITIVE LAYER ONLY — this module never touches manual logs.
 *      Each per-coach /wearable-insights endpoint pulls HK imports for
 *      the user, derives a small set of cards/stats, and returns them.
 *      The Analysis tab shows the section ONLY when this payload is
 *      non-empty. Manual users / "Maybe later" users / users with no
 *      grants get `{ has_data: false, cards: [] }` and the FE section
 *      auto-hides. Zero visual change for them.
 *
 *   2. SILENT MAGIC — copy NEVER says "Apple Health" / "Apple Watch" /
 *      "wearable" / "device". The section is labeled "Wearable Insights"
 *      at the FE level (i18n string) but the card content reads as if
 *      it's simply the user's data.
 *
 *   3. FAIL CLOSED — any Firestore error returns `{ has_data: false }`.
 *      The Analysis tab continues to render its manual sections fine.
 *
 *   4. CHEAP — single Firestore query per coach (90-day cap, limit 3000
 *      samples). 5-minute in-memory cache so repeated /analysis pulls
 *      within a tab session are free.
 *
 *   5. PER-COACH RELEVANT — only 4 coaches have meaningful HK signal
 *      (sleep / fitness / nutrition / mind). Water has signal but
 *      typically sparse; we still expose it as a graceful no-op. Fasting
 *      is intent-driven; HK is not relevant. Endpoint exists for all 6
 *      so the FE is uniform.
 */

const ONE_DAY_MS = 24 * 3600 * 1000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE = new Map(); // `${deviceId}:${coach}:${days}` → { ts, payload }

function median(arr) {
  if (!arr || arr.length === 0) return null;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function r1(n) { return Math.round(n * 10) / 10; }

async function readImports(db, deviceId, coach, lookbackDays) {
  if (!db || !deviceId || !coach) return [];
  const sinceMs = Date.now() - lookbackDays * ONE_DAY_MS;
  try {
    const snap = await db
      .collection('wellness_users').doc(deviceId)
      .collection('agents').doc(coach)
      .collection('healthkit_imports')
      .limit(3000).get();
    const out = [];
    for (const d of snap.docs) {
      const data = d.data();
      const ts = Date.parse(data.start_date);
      if (!Number.isFinite(ts) || ts < sinceMs) continue;
      out.push({ ...data, _ts: ts });
    }
    return out;
  } catch { return []; }
}

// ─── Per-coach builders ────────────────────────────────────────────────────

function buildSleepInsights(samples) {
  const stages = samples.filter((s) => s.hk_type === 'HKCategoryTypeIdentifierSleepAnalysis');
  if (stages.length === 0) return [];
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
  if (nights.length === 0) return [];
  const hours = nights.map((n) => n.asleepMs / 3_600_000);
  const avgH = r1(hours.reduce((a, b) => a + b, 0) / hours.length);
  const medH = r1(median(hours));
  const cards = [];
  cards.push({
    kind: 'avg_sleep',
    eyebrow: 'AVERAGE NIGHT',
    value: `${avgH} hr`,
    body: `Across ${nights.length} measured night${nights.length === 1 ? '' : 's'}. ${medH >= 7 ? 'Right in the recovery zone.' : medH >= 6 ? 'Slightly under — small tweaks compound.' : 'Below the floor — your other coaches will adjust accordingly.'}`,
  });
  // Efficiency card if enough nights
  const effs = nights.map((n) => n.asleepMs / (n.asleepMs + n.awakeMs)).filter(Number.isFinite);
  if (effs.length >= 3) {
    const avgE = Math.round((effs.reduce((a, b) => a + b, 0) / effs.length) * 100);
    cards.push({
      kind: 'efficiency',
      eyebrow: 'SLEEP QUALITY',
      value: `${avgE}%`,
      body: `Time asleep vs time in bed. ${avgE >= 90 ? 'Restorative.' : avgE >= 80 ? 'Healthy.' : 'Room to improve — limit screens or caffeine after 6pm.'}`,
    });
  }
  return cards;
}

function buildMindInsights(samples) {
  const hrv = samples
    .filter((s) => s.hk_type === 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN' && Number.isFinite(Number(s.value)))
    .sort((a, b) => a._ts - b._ts);
  const rhr = samples
    .filter((s) => s.hk_type === 'HKQuantityTypeIdentifierRestingHeartRate' && Number.isFinite(Number(s.value)));
  const cards = [];
  if (hrv.length >= 3) {
    const todayStart = Date.now() - 2 * ONE_DAY_MS;
    const recent = hrv.filter((s) => s._ts >= todayStart).map((s) => Number(s.value));
    const baseline = hrv.filter((s) => s._ts < todayStart).map((s) => Number(s.value));
    if (recent.length && baseline.length) {
      const recentMean = Math.round(recent.reduce((a, b) => a + b, 0) / recent.length);
      const baselineMed = Math.round(median(baseline));
      const deltaPct = baselineMed ? Math.round(((recentMean - baselineMed) / baselineMed) * 100) : 0;
      cards.push({
        kind: 'hrv_trend',
        eyebrow: 'HRV TODAY',
        value: `${recentMean} ms`,
        body: deltaPct === 0
          ? `Your baseline is ${baselineMed} ms. Steady recovery.`
          : `${Math.abs(deltaPct)}% ${deltaPct > 0 ? 'above' : 'below'} your ${baselineMed} ms baseline. ${deltaPct < -10 ? 'Stress signal — go easier today.' : deltaPct > 10 ? 'Recovered — green light for harder work.' : 'Within normal swing.'}`,
      });
    } else if (hrv.length >= 1) {
      const med = Math.round(median(hrv.map((s) => Number(s.value))));
      cards.push({
        kind: 'hrv_baseline',
        eyebrow: 'HRV BASELINE',
        value: `${med} ms`,
        body: `Across ${hrv.length} reading${hrv.length === 1 ? '' : 's'}. Builds your stress / recovery baseline.`,
      });
    }
  }
  if (rhr.length >= 3) {
    const med = Math.round(median(rhr.map((s) => Number(s.value))));
    cards.push({
      kind: 'rhr',
      eyebrow: 'RESTING HR',
      value: `${med} bpm`,
      body: `Across ${rhr.length} readings. ${med < 60 ? 'Strong cardiovascular fitness.' : med < 70 ? 'Healthy resting rate.' : 'Slightly elevated — sleep + cardio compound here.'}`,
    });
  }
  return cards;
}

function buildFitnessInsights(samples) {
  const workouts = samples.filter((s) => s.hk_type === 'HKWorkoutTypeIdentifier');
  const steps = samples.filter((s) => s.hk_type === 'HKQuantityTypeIdentifierStepCount');
  const vo2 = samples.filter((s) => s.hk_type === 'HKQuantityTypeIdentifierVO2Max' && Number.isFinite(Number(s.value)));
  const cards = [];

  if (workouts.length >= 1) {
    const lastWeek = workouts.filter((w) => Date.now() - w._ts < 7 * ONE_DAY_MS);
    if (lastWeek.length > 0) {
      const totalMin = Math.round(lastWeek.reduce((sum, w) => sum + (Number(w.duration) || 0), 0) / 60);
      cards.push({
        kind: 'workouts_week',
        eyebrow: 'THIS WEEK',
        value: `${lastWeek.length} workout${lastWeek.length === 1 ? '' : 's'}`,
        body: `${totalMin} min total. ${totalMin >= 150 ? 'Above the 150-min weekly threshold — solid base.' : 'Climb gently — even one more session compounds.'}`,
      });
    }
  }

  if (steps.length >= 5) {
    const byDate = {};
    for (const s of steps) {
      const d = String(s.start_date || '').slice(0, 10);
      byDate[d] = (byDate[d] || 0) + (Number(s.value) || 0);
    }
    const days = Object.values(byDate).filter((v) => v > 0);
    if (days.length >= 3) {
      const med = Math.round(median(days));
      cards.push({
        kind: 'steps_median',
        eyebrow: 'TYPICAL DAY',
        value: `${med.toLocaleString()} steps`,
        body: med >= 8000
          ? `Median across ${days.length} days. You hit the daily floor most days.`
          : `Median across ${days.length} days. The 7–8k range is where mortality risk drops most.`,
      });
    }
  }

  if (vo2.length >= 1) {
    const latest = Number(vo2.sort((a, b) => b._ts - a._ts)[0].value);
    cards.push({
      kind: 'vo2max',
      eyebrow: 'AEROBIC FITNESS',
      value: `${r1(latest)}`,
      body: `Your VO₂ Max. Higher = better aerobic capacity. Trend matters more than the raw number.`,
    });
  }
  return cards;
}

function buildNutritionInsights(samples) {
  const cards = [];

  // Weight trend
  const weights = samples
    .filter((s) => s.hk_type === 'HKQuantityTypeIdentifierBodyMass' && Number.isFinite(Number(s.value)))
    .sort((a, b) => a._ts - b._ts);
  if (weights.length >= 2) {
    const oldest = Number(weights[0].value);
    const latest = Number(weights[weights.length - 1].value);
    const deltaKg = r1(latest - oldest);
    cards.push({
      kind: 'weight_trend',
      eyebrow: 'WEIGHT TREND',
      value: deltaKg === 0 ? `${r1(latest)} kg` : `${deltaKg > 0 ? '+' : ''}${deltaKg} kg`,
      body: Math.abs(deltaKg) < 0.3
        ? `Stable across ${weights.length} readings. Stability = energy balance.`
        : `From ${r1(oldest)} → ${r1(latest)} kg over ${weights.length} readings. ${deltaKg < 0 ? 'Trending down.' : 'Trending up.'}`,
    });
  } else if (weights.length === 1) {
    cards.push({
      kind: 'weight_baseline',
      eyebrow: 'BASELINE WEIGHT',
      value: `${r1(Number(weights[0].value))} kg`,
      body: `One reading so far — a few more days unlocks the trend.`,
    });
  }

  // Macro intake — aggregate per day from HK macros (Atwater fallback)
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
  const macroDays = Object.values(byDate).filter((d) => (d.kcal + d.protein + d.carbs + d.fat) > 0);
  if (macroDays.length > 0) {
    const totalKcal = macroDays.reduce((s, d) => s + (d.kcal > 0 ? d.kcal : d.protein * 4 + d.carbs * 4 + d.fat * 9), 0);
    const totalProtein = macroDays.reduce((s, d) => s + d.protein, 0);
    const avgKcal = Math.round(totalKcal / macroDays.length);
    const avgProtein = Math.round(totalProtein / macroDays.length);
    cards.push({
      kind: 'macro_intake',
      eyebrow: macroDays.length === 1 ? 'TODAY' : 'DAILY AVERAGE',
      value: `${avgKcal} kcal`,
      body: `${avgProtein}g protein avg across ${macroDays.length} day${macroDays.length === 1 ? '' : 's'}. Your nutrition coach uses these numbers in scoring + suggestions.`,
    });
  }
  return cards;
}

function buildWaterInsights(samples) {
  const water = samples.filter((s) => s.hk_type === 'HKQuantityTypeIdentifierDietaryWater');
  if (water.length < 1) return [];
  const byDate = {};
  for (const s of water) {
    const d = String(s.start_date || '').slice(0, 10);
    const v = Number(s.value) || 0;
    // HK water is stored in liters; some sources write ml directly. Normalize.
    const ml = v < 50 ? v * 1000 : v;
    byDate[d] = (byDate[d] || 0) + ml;
  }
  const days = Object.values(byDate).filter((v) => v > 0);
  if (days.length === 0) return [];
  const avg = Math.round(days.reduce((a, b) => a + b, 0) / days.length);
  return [{
    kind: 'water_avg',
    eyebrow: 'DAILY AVERAGE',
    value: `${avg} ml`,
    body: `Across ${days.length} day${days.length === 1 ? '' : 's'}. ${avg < 1500 ? 'Below comfort line — set a noon checkpoint.' : avg < 2200 ? 'Solid baseline — protect on travel days.' : 'Strong hydration.'}`,
  }];
}

const BUILDERS = {
  sleep: buildSleepInsights,
  mind: buildMindInsights,
  fitness: buildFitnessInsights,
  nutrition: buildNutritionInsights,
  water: buildWaterInsights,
  fasting: () => [],
};

/**
 * Top-level: returns { has_data, cards, days_covered, last_sample_at }.
 * Caller can render `cards` directly. Empty cards array → FE auto-hides
 * the entire section.
 */
async function buildWearableInsights({ db, deviceId, coach, days = 30 }) {
  if (!coach || !BUILDERS[coach]) return { has_data: false, cards: [] };

  const cacheKey = `${deviceId}:${coach}:${days}`;
  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.payload;

  const samples = await readImports(db, deviceId, coach, days);
  if (samples.length === 0) {
    const payload = { has_data: false, cards: [] };
    CACHE.set(cacheKey, { ts: Date.now(), payload });
    return payload;
  }

  const cards = BUILDERS[coach](samples);
  const lastSampleAt = samples
    .map((s) => Date.parse(s.start_date))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0] || null;

  const payload = {
    has_data: cards.length > 0,
    cards,
    days_covered: days,
    last_sample_at: lastSampleAt ? new Date(lastSampleAt).toISOString() : null,
    sample_count: samples.length,
  };
  CACHE.set(cacheKey, { ts: Date.now(), payload });
  if (CACHE.size > 5000) CACHE.delete(CACHE.keys().next().value);
  return payload;
}

function invalidateWearableInsightsCache(deviceId, coach) {
  if (coach) {
    for (const k of CACHE.keys()) if (k.startsWith(`${deviceId}:${coach}:`)) CACHE.delete(k);
  } else {
    for (const k of CACHE.keys()) if (k.startsWith(`${deviceId}:`)) CACHE.delete(k);
  }
}

module.exports = {
  buildWearableInsights,
  invalidateWearableInsightsCache,
};
