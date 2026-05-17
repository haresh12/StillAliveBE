'use strict';
/**
 * Per-coach HealthKit blender for the scoring pipeline.
 *
 * Design law: manual logs ALWAYS win on days where they exist. HK only fills
 * gaps. This guarantees zero regression for users without HK granted — the
 * blender is a no-op on a day that already has a manual entry.
 *
 * Each blender:
 *   1. Reads `healthkit_imports` for the coach in the lifetime window
 *   2. Buckets samples by local-TZ date (using startDate, sourced from HK)
 *   3. For each date that has HK data but no manual entry, synthesizes a
 *      per-day quality 0–100 and adds it to a CLONE of the input map.
 *   4. Returns the merged map.
 *
 * If no HK data exists (the common case until users grant), this is a no-op
 * that returns the input map unchanged — same shape, same scores.
 */

const log = require('../log');

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Apple HKType strings expected per coach (mirrors healthkit.agent.js TYPE_TO_AGENT). */
const COACH_HK_TYPES = {
  sleep: ['HKCategoryTypeIdentifierSleepAnalysis', 'HKQuantityTypeIdentifierRespiratoryRate'],
  mind: ['HKQuantityTypeIdentifierHeartRateVariabilitySDNN', 'HKCategoryTypeIdentifierMindfulSession'],
  fitness: [
    'HKWorkoutTypeIdentifier',
    'HKQuantityTypeIdentifierStepCount',
    'HKQuantityTypeIdentifierActiveEnergyBurned',
    'HKQuantityTypeIdentifierAppleExerciseTime',
  ],
  nutrition: [
    'HKQuantityTypeIdentifierDietaryEnergyConsumed',
    'HKQuantityTypeIdentifierBodyMass',
    'HKQuantityTypeIdentifierBodyFatPercentage',
  ],
  water: ['HKQuantityTypeIdentifierDietaryWater'],
  fasting: ['HKQuantityTypeIdentifierBloodGlucose', 'HKQuantityTypeIdentifierDietaryEnergyConsumed'],
};

/**
 * Turn an ISO string into a local-TZ date string YYYY-MM-DD. HK samples are
 * timestamped in UTC; per the Registration Anchor Law, all scoring buckets use
 * the user's local TZ — but on the BE we don't have per-user TZ at every call
 * site. We approximate with the sample's offset (UTC) which is correct for
 * users in UTC or near it. For other TZs the worst-case skew is ~half a day at
 * the date boundary — acceptable for v1 since the daily bucket is just a
 * "did anything happen this day?" signal.
 */
function isoToLocalDate(iso, utcOffsetMinutes = 0) {
  if (!iso) return null;
  const ms = Date.parse(iso) + utcOffsetMinutes * 60_000;
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Read all HK import docs for a coach in the lifetime window.
 * Returns Map<YYYY-MM-DD, Array<{hk_type, start_date, end_date, value, stage, ...}>>.
 */
async function readHKImports({ db, deviceId, coach, anchorDateStr, todayDateStr, utcOffsetMinutes = 0 }) {
  const out = {};
  if (!db || !deviceId || !coach) return out;
  try {
    const snap = await db
      .collection('wellness_users')
      .doc(deviceId)
      .collection('agents')
      .doc(coach)
      .collection('healthkit_imports')
      .limit(5000) // hard cap — 5k samples covers ~3 years of daily HK syncs
      .get();
    for (const doc of snap.docs) {
      const d = doc.data();
      const date = isoToLocalDate(d.start_date, utcOffsetMinutes);
      if (!date) continue;
      if (anchorDateStr && date < anchorDateStr) continue;
      if (todayDateStr && date > todayDateStr) continue;
      if (!out[date]) out[date] = [];
      out[date].push(d);
    }
  } catch (err) {
    log.warn(`[hk-blend/${coach}] read failed:`, err.message);
  }
  return out;
}

// ─── Per-coach quality synth ──────────────────────────────────────────────
// Each returns 0–100, or null if HK data is too thin to score.

function synthSleepQuality(samples, { targetHours = 8 } = {}) {
  // Group all SleepAnalysis stage segments into one "night" total.
  const stages = samples.filter((s) => s.hk_type === 'HKCategoryTypeIdentifierSleepAnalysis');
  if (stages.length === 0) return null;
  let totalAsleepMs = 0;
  let totalAwakeMs = 0;
  for (const s of stages) {
    const dur = Date.parse(s.end_date) - Date.parse(s.start_date);
    if (!Number.isFinite(dur) || dur <= 0) continue;
    if (s.stage === 'awake' || s.stage === 'HKCategoryValueSleepAnalysisAwake') {
      totalAwakeMs += dur;
    } else if (s.stage && s.stage !== 'inBed' && s.stage !== 'HKCategoryValueSleepAnalysisInBed') {
      totalAsleepMs += dur;
    }
  }
  const totalSleepHours = totalAsleepMs / 3_600_000;
  const totalInBedMs = totalAsleepMs + totalAwakeMs;
  if (totalInBedMs <= 0) return null;
  const efficiency = totalAsleepMs / totalInBedMs;
  const durationPart = Math.max(0, Math.min(100, (Math.min(totalSleepHours, targetHours) / targetHours) * 100));
  const efficiencyPart = Math.max(0, Math.min(100, efficiency * 100));
  // 50/50 duration vs efficiency — mirrors the manual sleep scoring weights.
  return Math.round(durationPart * 0.5 + efficiencyPart * 0.5);
}

function synthFitnessQuality(samples) {
  // Workout presence → high baseline. Add steps/active-energy for non-workout days.
  const workouts = samples.filter((s) => s.hk_type === 'HKWorkoutTypeIdentifier');
  const steps = samples
    .filter((s) => s.hk_type === 'HKQuantityTypeIdentifierStepCount')
    .reduce((sum, s) => sum + (Number(s.value) || 0), 0);
  const activeKcal = samples
    .filter((s) => s.hk_type === 'HKQuantityTypeIdentifierActiveEnergyBurned')
    .reduce((sum, s) => sum + (Number(s.value) || 0), 0);

  if (workouts.length === 0 && steps === 0 && activeKcal === 0) return null;

  // Workout(s) day → start at 80, push higher with duration/energy.
  if (workouts.length > 0) {
    const longest = workouts.reduce((mx, w) => Math.max(mx, Number(w.duration) || 0), 0);
    const durMin = longest / 60;
    const durBoost = Math.min(20, durMin * 0.3); // 30 min ≈ +9, 60 min ≈ +18
    return Math.round(80 + durBoost);
  }

  // No workout — derive from steps + active energy (movement-only day).
  const stepPart = Math.max(0, Math.min(100, (steps / 10_000) * 100));
  const kcalPart = Math.max(0, Math.min(100, (activeKcal / 500) * 100));
  return Math.round(stepPart * 0.6 + kcalPart * 0.4);
}

function synthNutritionQuality(samples, { calorieTarget = 2000 } = {}) {
  // Primary path: kcal logged directly via HK (e.g. MyFitnessPal write-through).
  let kcal = samples
    .filter((s) => s.hk_type === 'HKQuantityTypeIdentifierDietaryEnergyConsumed')
    .reduce((sum, s) => sum + (Number(s.value) || 0), 0);

  // Fallback: derive kcal from logged macros. Many users (or apps) write
  // only protein/carbs/fat to HK without an explicit calorie record.
  // Atwater factors: protein 4 kcal/g · carbs 4 · fat 9.
  if (kcal <= 0) {
    const protein = samples
      .filter((s) => s.hk_type === 'HKQuantityTypeIdentifierDietaryProtein')
      .reduce((sum, s) => sum + (Number(s.value) || 0), 0);
    const carbs = samples
      .filter((s) => s.hk_type === 'HKQuantityTypeIdentifierDietaryCarbohydrates')
      .reduce((sum, s) => sum + (Number(s.value) || 0), 0);
    const fat = samples
      .filter((s) => s.hk_type === 'HKQuantityTypeIdentifierDietaryFatTotal')
      .reduce((sum, s) => sum + (Number(s.value) || 0), 0);
    kcal = protein * 4 + carbs * 4 + fat * 9;
  }

  if (kcal <= 0) return null;
  // Quality = closeness to target, clamped — over by 30%+ or under by 30%+ → 50.
  const ratio = kcal / calorieTarget;
  const dist = Math.abs(1 - ratio);
  const quality = Math.max(50, Math.min(100, 100 - dist * 100));
  return Math.round(quality);
}

function synthWaterQuality(samples, { goalMl = 2000 } = {}) {
  const totalMl = samples
    .filter((s) => s.hk_type === 'HKQuantityTypeIdentifierDietaryWater')
    .reduce((sum, s) => sum + (Number(s.value) || 0), 0);
  if (totalMl <= 0) return null;
  return Math.round(Math.max(0, Math.min(100, (totalMl / goalMl) * 100)));
}

function synthMindQuality(samples) {
  // Mind doesn't really have a "score from HK" — HRV/RHR are indicators, not
  // a quality. But presence of mindful-session minutes is a positive signal.
  const minutes = samples
    .filter((s) => s.hk_type === 'HKCategoryTypeIdentifierMindfulSession')
    .reduce((sum, s) => {
      const dur = Date.parse(s.end_date) - Date.parse(s.start_date);
      return sum + (Number.isFinite(dur) ? dur / 60_000 : 0);
    }, 0);
  if (minutes <= 0) return null;
  // 10 min = 60, 20 min = 80, 30+ = 90
  return Math.round(Math.min(90, 50 + minutes * 1.5));
}

function synthFastingQuality(samples) {
  // No direct signal — glucose/calorie patterns can hint, but fasting is
  // explicit intent. Don't synth — return null and let manual-only path stand.
  return null;
}

// ─── Public API ────────────────────────────────────────────────────────────

const SYNTH = {
  sleep: synthSleepQuality,
  fitness: synthFitnessQuality,
  nutrition: synthNutritionQuality,
  water: synthWaterQuality,
  mind: synthMindQuality,
  fasting: synthFastingQuality,
};

/**
 * Blend HK-synthesized quality into a manual `qualityByDate` map.
 *
 * @param {object} args
 * @param {string} args.coach           One of 'sleep'|'mind'|'fitness'|'nutrition'|'water'|'fasting'
 * @param {object} args.manualQualityByDate  YYYY-MM-DD → 0-100 from manual logs
 * @param {string} args.deviceId
 * @param {string|null} args.anchorDateStr  YYYY-MM-DD; null for legacy users
 * @param {string} args.todayDateStr        YYYY-MM-DD in user's local TZ
 * @param {object} args.db                  firestore instance
 * @param {object} [args.scoringContext]    Per-coach extras (targetHours, goalMl, calorieTarget)
 * @param {number} [args.utcOffsetMinutes]  user's offset
 * @returns {Promise<{merged: object, hkSynthDates: string[]}>}
 */
async function blendQualityByDate({
  coach,
  manualQualityByDate,
  deviceId,
  anchorDateStr,
  todayDateStr,
  db,
  scoringContext = {},
  utcOffsetMinutes = 0,
}) {
  const synth = SYNTH[coach];
  if (!synth) {
    return { merged: { ...manualQualityByDate }, hkSynthDates: [] };
  }
  const importsByDay = await readHKImports({
    db,
    deviceId,
    coach,
    anchorDateStr,
    todayDateStr,
    utcOffsetMinutes,
  });
  const merged = { ...manualQualityByDate };
  const hkSynthDates = [];
  for (const [date, samples] of Object.entries(importsByDay)) {
    if (merged[date] !== undefined) continue; // manual wins
    const q = synth(samples, scoringContext);
    if (q !== null && Number.isFinite(q)) {
      merged[date] = q;
      hkSynthDates.push(date);
    }
  }
  const manualDays = Object.keys(manualQualityByDate).length;
  const hkDays = hkSynthDates.length;
  log.info(`[hk-blend/${coach}] manual=${manualDays}d hk_filled=${hkDays}d total=${manualDays + hkDays}d device=${deviceId ? deviceId.slice(0, 8) : 'none'}`);
  return { merged, hkSynthDates };
}

module.exports = {
  blendQualityByDate,
  // Exposed for testing only
  _internals: {
    isoToLocalDate,
    readHKImports,
    synthSleepQuality,
    synthFitnessQuality,
    synthNutritionQuality,
    synthWaterQuality,
    synthMindQuality,
    synthFastingQuality,
    COACH_HK_TYPES,
  },
};
