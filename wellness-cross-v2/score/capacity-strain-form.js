/**
 * capacity-strain-form.js
 *
 * Cross-agent training-load model in the Banister/Gabbett tradition, scaled 0-100:
 *
 *   raw_strain[d]    = volume_factor × consistency_factor × 100   (per-day fitness load 0..~200)
 *   effective_strain[d] = raw_strain[d] / (1 + 0.30·sleep_z[d] + 0.15·nutrition_z[d])
 *                        (the **cross-agent moat**: good sleep/nutrition reduces felt load;
 *                         poor sleep/under-eating amplifies load → recovery slows)
 *   acute[d]         = EMA_7(effective_strain)         "strain"  in pack
 *   chronic[d]       = EMA_28(effective_strain)        "capacity" in pack
 *   form[d]          = chronic[d] − acute[d]            (Banister Fitness/Form: positive = primed)
 *   score[d]         = 0.6·capacity + 0.4·(form_proximity_to_sweet_spot · 100)
 *
 * Sweet spot: form ∈ [-5, +10] (Gabbett 0.8-1.3 A:C ratio when normalized).
 *
 * Returns the pack field shape expected by the FE:
 *   { capacity, strain, form, days: [{ date, capacity, strain, form, score }] }
 *
 * Cold start (no fitness logs ever): returns null. The pack always renders;
 * FE handles null gracefully (CapacityStrainBand shows "—").
 */

'use strict';

const config = require('../config');

const ACUTE_WINDOW = 7;
const CHRONIC_WINDOW = 28;
const ALPHA_ACUTE = 2 / (ACUTE_WINDOW + 1);   // ~0.25
const ALPHA_CHRONIC = 2 / (CHRONIC_WINDOW + 1); // ~0.069

const SLEEP_RECOVERY_COEF = 0.30;
const NUTRITION_RECOVERY_COEF = 0.15;

const MIN_FITNESS_DAYS_TO_REPORT = 7; // need at least 1 week of data

/**
 * Compute per-day raw strain from a fitness daily point.
 * Uses adapter-derived score as proxy when raw set/volume not available.
 */
function rawStrainForDay(fitnessPoint) {
  if (!fitnessPoint || !fitnessPoint.has_log) return 0;
  const score = Number.isFinite(fitnessPoint.score) ? fitnessPoint.score : null;
  if (score == null) return 0;
  // Map 0-100 score to 0-150 strain (training day intensity).
  // A typical workout (~score 60) → strain 90.
  return Math.max(0, Math.min(150, score * 1.5));
}

/**
 * Apply cross-agent recovery boost: well-rested + well-fed users feel less strain
 * for the same workout. Under-recovered users feel more.
 *
 * recovery_factor = 1 + 0.30·sleep_z + 0.15·nutrition_z, clamped [0.5, 1.7]
 *   → effective_strain = raw_strain / recovery_factor
 */
function applyCrossAgentBoost(rawStrain, sleepZ, nutritionZ) {
  if (rawStrain <= 0) return 0;
  const sZ = Number.isFinite(sleepZ) ? sleepZ : 0;
  const nZ = Number.isFinite(nutritionZ) ? nutritionZ : 0;
  let factor = 1 + SLEEP_RECOVERY_COEF * sZ + NUTRITION_RECOVERY_COEF * nZ;
  factor = Math.max(0.5, Math.min(1.7, factor));
  return rawStrain / factor;
}

/**
 * Exponential moving average from oldest→newest, with α as the weight on the new value.
 * Returns the running EMA for each day (same length as input).
 */
function emaSeries(values, alpha) {
  if (!values.length) return [];
  const out = [];
  let ema = values[0];
  out.push(ema);
  for (let i = 1; i < values.length; i++) {
    ema = alpha * values[i] + (1 - alpha) * ema;
    out.push(ema);
  }
  return out;
}

/**
 * Map form value to a sweet-spot proximity score 0..1 (1 = on the sweet spot).
 * Sweet spot is form ∈ [-5, +10]; outside that, score decays linearly.
 */
function formProximityScore(form) {
  if (!Number.isFinite(form)) return 0.5;
  if (form >= -5 && form <= 10) return 1;
  if (form > 10) return Math.max(0, 1 - (form - 10) / 20);
  return Math.max(0, 1 - (-5 - form) / 20);
}

/**
 * Build the pack.capacity_strain_form field.
 *
 * @param {Object} args
 * @param {Array} args.fitnessLast90 - daily points last 90d for fitness
 * @param {Array} args.zSeries - z_series rows from buildInsightsResponse helpers
 *                                (each row has date alignment via index, agent z-scores)
 * @param {Array<string>} args.dates - aligned date list (matrix rows .date) for last 90d
 * @returns {Object|null} { capacity, strain, form, days: [...] } or null if cold-start
 */
function buildCapacityStrainForm({ fitnessLast90, zSeries, dates }) {
  if (!Array.isArray(fitnessLast90) || !Array.isArray(zSeries) || !Array.isArray(dates)) return null;
  if (fitnessLast90.length === 0) return null;

  // Are there enough fitness logs to be meaningful?
  const fitnessLoggedDays = fitnessLast90.filter((p) => p && p.has_log).length;
  if (fitnessLoggedDays < MIN_FITNESS_DAYS_TO_REPORT) return null;

  // Build z-lookups by date (zSeries is index-aligned to dates)
  const zByDate = {};
  for (let i = 0; i < dates.length && i < zSeries.length; i++) {
    zByDate[dates[i]] = zSeries[i];
  }
  const fitByDate = {};
  for (const p of fitnessLast90) fitByDate[p.date] = p;

  // Per-day effective strain (cross-agent boosted)
  const effective = dates.map((date) => {
    const raw = rawStrainForDay(fitByDate[date]);
    if (raw <= 0) return 0;
    const z = zByDate[date] || {};
    return applyCrossAgentBoost(raw, z.sleep, z.nutrition);
  });

  // EMA series
  const acute = emaSeries(effective, ALPHA_ACUTE);
  const chronic = emaSeries(effective, ALPHA_CHRONIC);

  // Per-day output rows (last 30 for FE sparkline)
  const days = dates.map((date, i) => {
    const cap = chronic[i];
    const str = acute[i];
    const f = cap - str;
    const proximity = formProximityScore(f);
    return {
      date,
      capacity: Math.round(cap * 10) / 10,
      strain:   Math.round(str * 10) / 10,
      form:     Math.round(f * 10) / 10,
      score:    Math.round((0.6 * cap + 0.4 * proximity * 100) * 10) / 10,
    };
  }).slice(-30);

  // Today's headline numbers
  const last = days[days.length - 1] || { capacity: 0, strain: 0, form: 0 };
  return {
    capacity: Math.round(last.capacity),
    strain:   Math.round(last.strain),
    form:     Math.round(last.form),
    days,
  };
}

module.exports = {
  buildCapacityStrainForm,
  // exposed for tests
  _internal: { rawStrainForDay, applyCrossAgentBoost, emaSeries, formProximityScore },
};
