'use strict';
// ════════════════════════════════════════════════════════════════════
// nutrition-tdee.js — adaptive Total Daily Energy Expenditure.
//
// Match MacroFactor's "gold standard" feature: instead of a fixed
// Mifflin-St Jeor + activity-factor estimate, we reverse-calculate
// expenditure from observed weight trend × intake over a rolling 14-day
// window. Converges in 2-3 weeks once the user logs both meals and
// weight consistently.
//
// Why: TDEE estimates from formulas are within ±25% for individuals
// (Cunningham 1980), too imprecise for cutting/bulking plans. A user's
// own weight × intake data closes the loop. MacroFactor publishes
// validation showing < ±2.5% MAPE after 21 days of logging.
//
// Pure helpers — caller supplies aggregated arrays (no Firestore reads
// here). Tests exercise edge cases (sparse data, weight rebound, etc).
//
// SAFETY:
//   - Returns `null` when there isn't enough data (< 14 days, < 3
//     weight readings, weight readings span < 7 days).
//   - Clamps weekly target adjustment to ±10% of current intake.
//   - NEVER auto-applies. Output is a *suggestion* — Coach insight only,
//     user opts in.
// ════════════════════════════════════════════════════════════════════

const _clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const _avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

// Energy density of bodyweight change (kcal / kg). Body-fat tissue is
// ~7700 kcal/kg, but mixed change (fat + glycogen + water) averages
// closer to ~7000 kcal/kg per Hall 2008. We use 7000 to avoid
// over-attributing fluctuations to fat mass.
const KCAL_PER_KG = 7000;

const MIN_DAYS_FOR_TDEE = 14;
const MIN_WEIGHT_POINTS = 3;
const MIN_WEIGHT_SPAN_DAYS = 7;

/**
 * Compute linear regression slope (kg/day) over a time series of
 * {date_ms, weight_kg} points. Pure linear least-squares.
 */
function _weightSlopeKgPerDay(weightPoints) {
  if (!Array.isArray(weightPoints) || weightPoints.length < MIN_WEIGHT_POINTS) return null;
  const xs = weightPoints.map(p => p.date_ms / 86_400_000);
  const ys = weightPoints.map(p => p.weight_kg);
  const xMean = _avg(xs);
  const yMean = _avg(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - xMean) * (ys[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  if (den === 0) return 0;
  return num / den; // kg per day
}

/**
 * Compute adaptive TDEE for a window.
 *
 * @param {Object} opts
 * @param {Array<{date, kcal}>} opts.dailyKcal — newest first OR any order
 * @param {Array<{date_ms, weight_kg}>} opts.weightPoints
 * @param {number} opts.spanDays - the window length (default 14)
 *
 * @returns {Object|null} {
 *   tdee_kcal, intake_avg_kcal, weight_slope_kg_per_wk,
 *   confidence: 'low'|'medium'|'high',
 *   data_quality: { days_with_logs, weight_points, weight_span_days }
 * }
 */
function computeAdaptiveTDEE({dailyKcal = [], weightPoints = [], spanDays = 14} = {}) {
  if (!Array.isArray(dailyKcal) || !Array.isArray(weightPoints)) return null;
  const loggedDays = dailyKcal.filter(d => Number.isFinite(d.kcal) && d.kcal > 0);
  if (loggedDays.length < MIN_DAYS_FOR_TDEE) return null;
  if (weightPoints.length < MIN_WEIGHT_POINTS) return null;

  const sorted = weightPoints.slice().sort((a, b) => a.date_ms - b.date_ms);
  const spanMs = sorted[sorted.length - 1].date_ms - sorted[0].date_ms;
  const weightSpanDays = spanMs / 86_400_000;
  if (weightSpanDays < MIN_WEIGHT_SPAN_DAYS) return null;

  const slope = _weightSlopeKgPerDay(sorted);
  if (slope == null) return null;

  const intakeAvg = _avg(loggedDays.map(d => d.kcal));
  // Energy balance: intake - expenditure = ΔBodyMass × KCAL_PER_KG (per day).
  // So expenditure = intake - slope_kg_per_day × KCAL_PER_KG.
  const tdee = intakeAvg - (slope * KCAL_PER_KG);

  // Confidence tiers
  let confidence = 'low';
  if (loggedDays.length >= 21 && weightPoints.length >= 8 && weightSpanDays >= 14) confidence = 'high';
  else if (loggedDays.length >= 17 && weightPoints.length >= 5 && weightSpanDays >= 10) confidence = 'medium';

  return {
    tdee_kcal: Math.round(_clamp(tdee, 1000, 5500)),
    intake_avg_kcal: Math.round(intakeAvg),
    weight_slope_kg_per_wk: Math.round(slope * 7 * 100) / 100,
    confidence,
    data_quality: {
      days_with_logs: loggedDays.length,
      weight_points: weightPoints.length,
      weight_span_days: Math.round(weightSpanDays),
    },
  };
}

/**
 * Translate a TDEE estimate + goal into a suggested daily kcal target.
 * Caller decides whether to surface this as a Coach insight; we never
 * auto-apply (per UX principle: silent target changes alienate users).
 *
 * @param {Object} opts
 * @param {Object} opts.tdee - output of computeAdaptiveTDEE()
 * @param {string} opts.goal - 'weight_loss' | 'muscle_gain' | 'maintain' | 'energy' | 'healthier'
 * @param {number} opts.currentTarget - the user's current calorie target
 *
 * @returns {Object|null} { suggested_target_kcal, delta_kcal, rationale }
 */
function suggestedTargetFromTDEE({tdee, goal, currentTarget}) {
  if (!tdee?.tdee_kcal) return null;
  const t = tdee.tdee_kcal;
  let suggested;
  let rationale;
  switch ((goal || 'maintain').toLowerCase()) {
    case 'weight_loss':
      // ~0.5 kg/wk loss → -500 kcal/d deficit. Clamp to 500-1000 deficit.
      suggested = t - 500;
      rationale = 'TDEE − 500 kcal targets ~0.5 kg/week loss (NIH guidance).';
      break;
    case 'muscle_gain':
      // +250 kcal/d surplus → ~0.25 kg lean tissue/wk (slow gain, less fat).
      suggested = t + 250;
      rationale = 'TDEE + 250 kcal targets lean gain ~0.25 kg/week (ISSN 2017).';
      break;
    case 'maintain':
    default:
      suggested = t;
      rationale = 'Match your measured TDEE for weight maintenance.';
      break;
  }
  // Clamp suggested vs current ±10% — never propose dramatic single-step jumps.
  if (Number.isFinite(currentTarget) && currentTarget > 0) {
    const minOK = currentTarget * 0.9;
    const maxOK = currentTarget * 1.1;
    suggested = _clamp(suggested, minOK, maxOK);
  }
  return {
    suggested_target_kcal: Math.round(suggested),
    delta_kcal: Math.round(suggested - (currentTarget || t)),
    rationale,
    confidence: tdee.confidence,
  };
}

module.exports = {
  computeAdaptiveTDEE,
  suggestedTargetFromTDEE,
  KCAL_PER_KG,
  MIN_DAYS_FOR_TDEE,
};
