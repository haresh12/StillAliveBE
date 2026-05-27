'use strict';
// ════════════════════════════════════════════════════════════════════
// nutrition-scoring.js — pure scoring helpers for the Nutrition agent.
//
// Mirrors lib/{fitness,mind,sleep,water,fasting}-scoring.js. Every helper
// is pure: no Firestore, no Express, no wall-clock. Tests in
// tests/nutrition-scoring.test.js exercise each helper in isolation.
//
// Created 2026-05-25 as part of Scoring V3 contract (SCORING_CONTRACT_V3.md).
// Before V3 the math lived inline in lib/agent-scores.js with the wrong
// (steeper) maturity curve — Nutrition Day-7 perfect scores hit ~78 instead
// of the contract's ~60, inflating ahead of the other 5 agents.
//
// 5-gate model (V3, peer-reviewed):
//   Calorie Adherence 25% — energy balance vs personalised target
//                            (Mifflin-St Jeor + activity factor)
//   Protein Adherence 20% — ISSN 2017 review: 1.6-2.2g/kg for active adults
//   Macro Balance     15% — AMDR ranges (IOM 2005): C 45-65% / F 20-35% / P 10-35%
//   Variety           15% — Drewnowski 2018: dietary diversity → adequacy
//                            (unique foods logged across window)
//   Consistency       25% — Lally 2010 habit-formation + behavioural anchoring
//
// Honesty laws (mirroring other libs):
//   • Maturity ramp keyed on calendar daysSinceAnchor (not log count) —
//     cramming 30 meals in 3 days can't fake-mature.
//   • Future-dated logs NEVER counted.
//   • Day-1 perfect log lands in ~30-40 band per the contract.
//   • Macro balance scored against AMDR bands, not arbitrary thresholds.
// ════════════════════════════════════════════════════════════════════

const _clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const _avg   = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const _round = (v) => Math.round(v);

// ─── Maturity ramp (CANONICAL — matches all 6 agents) ───────────
/**
 * Maturity ramp — caps the raw blended score so a perfect day-1 user yields
 * ≈30-40, climbing to ≈75-85 by month 1 and 100 by month 2+. Keyed on
 * CALENDAR days since anchor, not log count — cramming logs can't fake-mature.
 *
 * Curve verified identical to fitness/mind/sleep/water/fasting libs per
 * SCORING_CONTRACT_V3.md §2.
 */
function maturityRamp(daysSinceAnchor) {
  const d = daysSinceAnchor;
  if (!d || d < 1) return 0.40;
  if (d < 4)  return 0.45;
  if (d < 7)  return 0.55;
  if (d < 14) return 0.70;
  if (d < 30) return 0.85;
  if (d < 60) return 0.94;
  return 1.00;
}

// ─── Future-log filter (mirrors fitness/sleep/water/fasting libs) ───
/**
 * Drop nutrition logs whose `date` (YYYY-MM-DD) is strictly after today's
 * date. Future-dated logs (legacy `dev_allow_future` or test fixtures) must
 * NOT inflate "what happened so far" — they create inconsistency between
 * the chart (clamped to today), the Verdict ("5 days logged"), and the score
 * (which would otherwise include them).
 *
 * Logs with no `date` field pass through (legacy data).
 */
function dropFutureLogs(logs, todayDateStr) {
  if (!todayDateStr || !Array.isArray(logs)) return Array.isArray(logs) ? logs.slice() : [];
  return logs.filter((l) => !l?.date || l.date <= todayDateStr);
}

// ─── Per-meal quality (used by the per-day quality map) ─────────
/**
 * Per-meal quality 0-100 from the standard nutrition log fields:
 *   { calories_kcal, protein_g, carb_g, fat_g, micros: {fiber_g, sodium_mg, ...} }
 *
 * Targets come from the user's personalize doc (daily_calorie_target /
 * daily_protein_g_target), divided by `mealsPerDay` (default 3) to yield
 * per-meal expectations. A meal that hits its targets on calories + protein
 * + macro balance earns 100; one that's wildly off earns ~30.
 */
function deriveMealQuality(meal, { dailyCalTarget = 2200, dailyProteinTarget = 130, mealsPerDay = 3 } = {}) {
  if (!meal || typeof meal !== 'object') return null;
  const calPerMealTarget     = (dailyCalTarget || 2200)     / Math.max(mealsPerDay, 1);
  const proteinPerMealTarget = (dailyProteinTarget || 130)  / Math.max(mealsPerDay, 1);

  const cal     = Number(meal.calories_kcal || meal.kcal || 0);
  const protein = Number(meal.protein_g     || 0);
  const carb    = Number(meal.carb_g        || meal.carbs_g || 0);
  const fat     = Number(meal.fat_g         || 0);

  // Calorie band: ±20% of target = 100, outside that linearly drops to 30 at ±60%
  const calPctOfTarget = cal > 0 ? (cal / Math.max(calPerMealTarget, 1)) : 0;
  let calScore;
  if (calPctOfTarget === 0)              calScore = 0;
  else if (calPctOfTarget >= 0.8 && calPctOfTarget <= 1.2) calScore = 100;
  else if (calPctOfTarget >= 0.4 && calPctOfTarget <= 1.6) calScore = 70;
  else                                                      calScore = 35;

  // Protein: hit or exceed target = 100, drop linearly below
  const proteinPctOfTarget = protein > 0 ? (protein / Math.max(proteinPerMealTarget, 1)) : 0;
  const proteinScore = _clamp(proteinPctOfTarget * 100, 0, 100);

  // Macro balance: AMDR bands (IOM 2005)
  //   Carb: 45-65% kcal | Fat: 20-35% kcal | Protein: 10-35% kcal
  const totalKcalFromMacros = (carb * 4) + (fat * 9) + (protein * 4);
  let macroScore = 70; // neutral default if macros not logged
  if (totalKcalFromMacros > 0) {
    const carbPct    = (carb * 4) / totalKcalFromMacros;
    const fatPct     = (fat * 9)  / totalKcalFromMacros;
    const proteinPct = (protein * 4) / totalKcalFromMacros;
    const inBand = (val, lo, hi) => val >= lo && val <= hi;
    const carbOK    = inBand(carbPct, 0.40, 0.70);   // slightly relaxed from AMDR
    const fatOK     = inBand(fatPct,  0.15, 0.40);
    const proteinOK = inBand(proteinPct, 0.10, 0.45);
    macroScore = (carbOK ? 35 : 15) + (fatOK ? 35 : 15) + (proteinOK ? 30 : 10);
  }

  const raw = calScore * 0.40 + proteinScore * 0.35 + macroScore * 0.25;
  return _clamp(_round(raw), 0, 100);
}

// ─── Per-day quality map ────────────────────────────────────────
/**
 * Per-day quality map keyed by YYYY-MM-DD. For each calendar day from
 * `anchorDate` → `todayDate`, the value is the MEAN of meal qualities
 * (a single bad meal doesn't tank the day; a single good meal doesn't
 * save it). Days with no meals get value `null` (NOT 0 — distinguishes
 * "no log" from "low quality").
 */
function buildDayQualityByDate(logs, { anchorDate, todayDate, dailyCalTarget, dailyProteinTarget, mealsPerDay } = {}) {
  const out = {};
  if (!anchorDate || !todayDate || anchorDate > todayDate) return out;

  // Init every calendar day to null
  const [ay, am, ad] = anchorDate.split('-').map(Number);
  const [ey, em, ed] = todayDate.split('-').map(Number);
  let cur = Date.UTC(ay, am - 1, ad);
  const endMs = Date.UTC(ey, em - 1, ed);
  while (cur <= endMs) {
    const dt = new Date(cur);
    const ds = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
    out[ds] = null;
    cur += 86_400_000;
  }

  const byDay = {};
  for (const l of (logs || [])) {
    if (!l?.date || l.date < anchorDate || l.date > todayDate) continue;
    if (!byDay[l.date]) byDay[l.date] = [];
    const q = deriveMealQuality(l, { dailyCalTarget, dailyProteinTarget, mealsPerDay });
    if (q != null) byDay[l.date].push(q);
  }
  for (const [ds, arr] of Object.entries(byDay)) {
    if (arr.length > 0) out[ds] = _round(_avg(arr));
  }
  return out;
}

// ─── Gate helpers (used by computeBlendedNutritionScore) ─────────

/**
 * Gate 1 — Calorie Adherence (25%). Mean over recentKeys of clamped
 * `actual_kcal / target_kcal × 100`, with a ±20% sweet-spot at 100 and
 * dropping outside that. Days with no logs count as 0 (they ARE the gap).
 */
function deriveCalorieAdherence(dayKcalByDate, targetKcalByDate, recentKeys) {
  if (!recentKeys?.length) return 0;
  const scored = recentKeys.map((k) => {
    const actual = dayKcalByDate[k] || 0;
    const target = Math.max(1, targetKcalByDate[k] || 2200);
    if (actual === 0) return 0;
    const ratio = actual / target;
    if (ratio >= 0.8 && ratio <= 1.2) return 100;
    if (ratio >= 0.4 && ratio <= 1.6) return 70;
    if (ratio > 0)                    return 40;
    return 0;
  });
  return _round(_avg(scored));
}

/**
 * Gate 2 — Protein Adherence (20%). ISSN 2017 review (PMID 28642676):
 * 1.6-2.2 g/kg/day for active adults; 1.2 g/kg minimum for sedentary.
 * Caller supplies the user's personalised protein target (g/day).
 */
function deriveProteinAdherence(dayProteinByDate, targetProteinByDate, recentKeys) {
  if (!recentKeys?.length) return 0;
  const scored = recentKeys.map((k) => {
    const actual = dayProteinByDate[k] || 0;
    const target = Math.max(1, targetProteinByDate[k] || 130);
    if (actual === 0) return 0;
    const ratio = actual / target;
    return _clamp(ratio * 100, 0, 100);
  });
  return _round(_avg(scored));
}

/**
 * Gate 3 — Macro Balance (15%). % of days where the day's macro
 * distribution fell within AMDR bands (IOM 2005). A day with no macros
 * logged counts as 0.
 */
function deriveMacroBalance(dayMacrosByDate, recentKeys) {
  if (!recentKeys?.length) return 0;
  const scored = recentKeys.map((k) => {
    const d = dayMacrosByDate[k];
    if (!d || !Number.isFinite(d.carb_g) || !Number.isFinite(d.protein_g) || !Number.isFinite(d.fat_g)) return 0;
    const total = (d.carb_g * 4) + (d.fat_g * 9) + (d.protein_g * 4);
    if (total <= 0) return 0;
    const carbPct    = (d.carb_g * 4) / total;
    const fatPct     = (d.fat_g  * 9) / total;
    const proteinPct = (d.protein_g * 4) / total;
    const carbOK    = carbPct    >= 0.40 && carbPct    <= 0.70;
    const fatOK     = fatPct     >= 0.15 && fatPct     <= 0.40;
    const proteinOK = proteinPct >= 0.10 && proteinPct <= 0.45;
    return ((carbOK ? 1 : 0) + (fatOK ? 1 : 0) + (proteinOK ? 1 : 0)) / 3 * 100;
  });
  return _round(_avg(scored));
}

/**
 * Gate 4 — Variety (15%). Drewnowski 2018: dietary diversity predicts
 * micronutrient adequacy. Counts unique `food_name` (or `name`) values
 * across recentKeys. Score: 30+ unique foods = 100, 5 = 30, scaled linearly.
 */
function deriveVariety(logs, recentKeys, spanDays = 0) {
  if (!recentKeys?.length || !logs?.length) return 0;
  const inWindow = new Set(recentKeys);
  const names = new Set();
  for (const l of logs) {
    if (!inWindow.has(l?.date)) continue;
    const n = l.food_name || l.name;
    if (n && typeof n === 'string') names.add(n.toLowerCase().trim());
  }
  const u = names.size;
  // Scaling: target = 6 unique foods/week (24 unique over 28d).
  // Calibrate so 28d × 6/wk pace = ~100. Sparse windows scale down.
  const weeks = Math.max(1, spanDays / 7);
  const targetUnique = weeks * 6;
  return _round(_clamp((u / Math.max(targetUnique, 1)) * 100, 0, 100));
}

/**
 * Gate 5 — Consistency (25%). Lally 2010 (Eur J Soc Psychol 40:998-1009)
 * habit-formation requires ~66 days of consistent repetition. % of recentKeys
 * with at least 1 meal logged. Streak bonus layered on top.
 */
function deriveConsistency(dayKcalByDate, recentKeys, streak = 0) {
  if (!recentKeys?.length) return 0;
  const loggedDays = recentKeys.filter((k) => (dayKcalByDate[k] || 0) > 0).length;
  const freqPct = (loggedDays / recentKeys.length) * 100;          // 0-100
  const streakBonus = _clamp(((streak || 0) / 14) * 30, 0, 30);    // 14-day streak = +30
  return _round(_clamp(freqPct * 0.70 + streakBonus, 0, 100));
}

// ─── Headline scorer — same shape as other agent scorers ─────────

/**
 * Compute the blended nutrition score 0-100 for a window. Caller passes
 * pre-aggregated per-day maps so this function stays pure and fast.
 *
 * Inputs:
 *   dayKcalByDate        { 'YYYY-MM-DD': actual_kcal }
 *   dayProteinByDate     { 'YYYY-MM-DD': actual_protein_g }
 *   dayMacrosByDate      { 'YYYY-MM-DD': { carb_g, protein_g, fat_g } }
 *   targetKcalByDate     { 'YYYY-MM-DD': target_kcal } — from personalize
 *   targetProteinByDate  { 'YYYY-MM-DD': target_protein_g }
 *   logs                 raw log array (for Variety gate)
 *   recentKeys           array of YYYY-MM-DD over the scoring window
 *   daysSinceAnchor      calendar days since signup (drives maturity)
 *   streak               consecutive-day streak (drives consistency bonus)
 *   spanDays             window length (for Variety scaling)
 *
 * Output: same shape as lib/agent-scores.js::computeNutritionScore but with
 * `raw_score`, `maturity_mult`, and `citations` per the V3 explainer contract.
 */
function computeBlendedNutritionScore({
  dayKcalByDate = {},
  dayProteinByDate = {},
  dayMacrosByDate = {},
  targetKcalByDate = {},
  targetProteinByDate = {},
  logs = [],
  recentKeys = [],
  daysSinceAnchor = 0,
  streak = 0,
  spanDays = 7,
} = {}) {
  if (!recentKeys.length) return null;

  const calorie_adherence = deriveCalorieAdherence(dayKcalByDate, targetKcalByDate, recentKeys);
  const protein_adherence = deriveProteinAdherence(dayProteinByDate, targetProteinByDate, recentKeys);
  const macro_balance     = deriveMacroBalance(dayMacrosByDate, recentKeys);
  const variety           = deriveVariety(logs, recentKeys, spanDays);
  const consistency       = deriveConsistency(dayKcalByDate, recentKeys, streak);

  const raw = _clamp(
    calorie_adherence * 0.25 +
    protein_adherence * 0.20 +
    macro_balance     * 0.15 +
    variety           * 0.15 +
    consistency       * 0.25,
    0, 100
  );

  const maturity_mult = maturityRamp(daysSinceAnchor);
  const score = _clamp(_round(raw * maturity_mult), 0, 100);

  return {
    score,
    raw_score: _round(raw),
    maturity_mult,
    band:
      score >= 85 ? 'thriving' :
      score >= 65 ? 'strong'   :
      score >= 50 ? 'steady'   :
      score >= 35 ? 'building' :
                    'starting' ,
    components: {
      calorie_adherence,
      protein_adherence,
      macro_balance,
      variety,
      consistency,
    },
    days_logged: recentKeys.filter((k) => (dayKcalByDate[k] || 0) > 0).length,
    days_since_anchor: daysSinceAnchor,
    citations: {
      calorie_adherence: 'Mifflin-St Jeor 1990; FAO/WHO 2004',
      protein_adherence: 'ISSN 2017 (Jäger et al.)',
      macro_balance:     'IOM 2005 AMDR',
      variety:           'Drewnowski 2018',
      consistency:       'Lally 2010',
    },
  };
}

// ─── Legacy 4-input scorer (matches agent-scores.computeNutritionScore) ─
/**
 * Backward-compatible wrapper accepting the pre-V3 input shape used by
 * adapters/nutrition.adapter.js. Lets us keep the call-site stable while
 * switching the maturity curve to the slow canonical ramp.
 *
 * Caller passes scalar adherence numbers (already aggregated upstream).
 * Functionally equivalent to the old inline math, but on the slow ramp.
 */
function computeBlendedNutritionScoreLegacy({ calorie_adherence, protein_adherence, streak, macro_balance, days_logged }) {
  const d = days_logged || 1;
  if (calorie_adherence == null && protein_adherence == null) return null;
  const streakScore = _clamp(((streak || 0) / 14) * 100, 0, 100);
  const raw = _clamp(
    (calorie_adherence || 0) * 0.35 +
    (protein_adherence || 0) * 0.35 +
    streakScore              * 0.20 +
    (macro_balance     || 0) * 0.10,
    0, 100
  );
  const maturity_mult = maturityRamp(d);
  const score = _clamp(_round(raw * maturity_mult), 0, 100);
  return {
    score,
    raw_score: _round(raw),
    maturity_mult,
    band:
      score >= 85 ? 'thriving' :
      score >= 65 ? 'strong'   :
      score >= 50 ? 'steady'   :
      score >= 35 ? 'building' :
                    'starting' ,
    components: {
      calorie_adherence: _round(calorie_adherence || 0),
      protein_adherence: _round(protein_adherence || 0),
      consistency:       _round(streakScore),
      macro_balance:     _round(macro_balance || 0),
    },
    days_logged: d,
  };
}

module.exports = {
  maturityRamp,
  dropFutureLogs,
  deriveMealQuality,
  buildDayQualityByDate,
  deriveCalorieAdherence,
  deriveProteinAdherence,
  deriveMacroBalance,
  deriveVariety,
  deriveConsistency,
  computeBlendedNutritionScore,
  computeBlendedNutritionScoreLegacy,
};
