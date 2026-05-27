'use strict';
// ════════════════════════════════════════════════════════════════════
// lib/sleep-scoring.js — pure scoring helpers for the Sleep agent.
//
// Extracted so the math can be tested in isolation (Node, no Firestore,
// no Express, no wall-clock). Mirrors lib/fitness-scoring.js + lib/
// mind-scoring.js architecture per the "every agent has its own scoring
// lib" canon.
//
// 10/10 honesty law (2026-05-24, aligned with fitness/mind):
//   Maturity ramp is keyed on `daysLogged` (distinct calendar dates a
//   log exists). Curve matches Fitness exactly — 0.40 → 0.45 → 0.55 →
//   0.70 → 0.85 → 0.94 → 1.00 at day 0/1/4/7/14/30/60+.
//
//   The previous shared `maturityFactor` in agent-scores.js was too
//   steep (0.65 by day 4, 0.80 by day 7) which let new users reach
//   "Excellent" sleep scores after just a week of logging. That
//   contradicts the foundational rule from agent-scores.js:7:
//     "Scores earn slowly: Day 1 perfect = ~25, Day 7 = ~55, Day 30 = ~90."
//
//   Sleep now joins fitness + mind on the honest curve.
// ════════════════════════════════════════════════════════════════════

/**
 * Maturity ramp — caps the raw blended score so a "perfect" day-1 night
 * yields ≈30-40, climbing to ≈75-85 by month 1 for sustained nightly
 * loggers. Keyed on distinct calendar dates with a sleep log, NOT on
 * total log count, so a user can't fake-mature by retroactively filling
 * 14 dates in one sitting and then expecting an "Excellent" rating.
 *
 * Curve verified against fitness/mind canon — exact parity.
 */
function maturityRamp(daysLogged) {
  const d = daysLogged;
  if (!d || d < 1) return 0.40;
  if (d < 4)  return 0.45;
  if (d < 7)  return 0.55;
  if (d < 14) return 0.70;
  if (d < 30) return 0.85;
  if (d < 60) return 0.94;
  return 1.00;
}

/**
 * Drop logs whose `date_str` (YYYY-MM-DD) is strictly after today's date.
 * Future-dated logs (allowed in dev via `dev_allow_future`) must NOT
 * inflate "what happened so far" — they create inconsistency between the
 * chart (clamped to today) and the score (which would otherwise include
 * them). Mirrors fitness-scoring.js dropFutureWorkouts.
 *
 * Logs with no `date_str` field pass through (legacy data).
 */
function dropFutureLogs(logs, todayDateStr) {
  if (!todayDateStr || !Array.isArray(logs)) return Array.isArray(logs) ? logs.slice() : [];
  return logs.filter((l) => !l?.date_str || l.date_str <= todayDateStr);
}

/**
 * Pure: "Sleep Bank" credit/debit framing — net of (actual sleep hours -
 * target hours) over a rolling window. AutoSleep canon. Positive = in
 * credit (ahead of target), negative = in debit (behind target).
 *
 * No HK dependency. Works off the same `total_sleep_hours` BE computes.
 * Returns null when there's not enough history to be meaningful.
 */
function deriveSleepBank(logs, targetHours = 7.5, windowNights = 14) {
  if (!Array.isArray(logs) || logs.length === 0) return null;
  const tgt = Math.max(targetHours || 7.5, 5);
  const window = logs.slice(0, windowNights);
  if (window.length < 3) return null; // 3+ nights minimum for an honest read
  const total = window.reduce((s, l) => s + ((+l?.total_sleep_hours || 0) - tgt), 0);
  return {
    credit_hours: Math.round(total * 10) / 10,
    in_credit: total >= 0,
    window_nights: window.length,
    target_hours: tgt,
  };
}

// ════════════════════════════════════════════════════════════════════
// SLEEP SCORING V2 (2026-05-25) — 7 contributors, backwards-compatible.
//
// Per SCORING_CONTRACT_V3.md §3, Sleep gets deeper than the 5-component V1
// to match Oura/WHOOP-level depth while staying free + on-device. V1 keys
// (duration / efficiency / restoration / continuity / consistency) are
// preserved in `components_v1` for backward compat. V3 adds explicit
// `timing` (chronotype-adjusted bedtime variance) and splits `continuity`
// into `latency` + `debt` so each gets its own weighted contribution.
//
// Weights (sum = 1.00):
//   Duration     20% — Van Dongen 2003 + NIH meta (PMC2864873)
//   Efficiency   25% — CBT-I gold standard (Spielman 1987); AASM <65% flag
//   Restoration  15% — PSQI C1 + morning energy + HK HR-dip when present
//   Timing       10% — Chronotype-adjusted bedtime variance (Roenneberg MEQ)
//   Latency      10% — Borbely two-process; 10-20 min = optimal
//   Consistency  15% — Bedtime variance vs 14-day rolling avg
//   Debt          5% — Cumulative sleep debt vs target (banker view)
//
// HARD CAPS (preserved from V1):
//   avg_duration < 6h  → final score capped at 55
//   avg_duration < 6.5h→ final score capped at 72
//   avg_efficiency<65% → clinical_flag = true
// ════════════════════════════════════════════════════════════════════

const _clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const _round = (v) => Math.round(v);

/**
 * computeRestoration — uses HK HR-dip when present, else self-report.
 *   hkSignals?.hrv_overnight_ms  → higher = better recovery (40-80 ms band)
 *   hkSignals?.resting_hr_drop_pct → larger = better (10-25% overnight drop)
 *   Fallback: avg_quality (1-5) + avg_energy (1-5) → 0-100
 */
function computeRestoration({ avg_quality, avg_energy, hkSignals = null }) {
  if (hkSignals && (Number.isFinite(hkSignals.hrv_overnight_ms) || Number.isFinite(hkSignals.resting_hr_drop_pct))) {
    let hrvScore = 50;
    let hrScore  = 50;
    if (Number.isFinite(hkSignals.hrv_overnight_ms)) {
      // 30 ms = 30 pts, 80 ms = 100 pts, capped
      hrvScore = _clamp(((hkSignals.hrv_overnight_ms - 20) / 60) * 100, 0, 100);
    }
    if (Number.isFinite(hkSignals.resting_hr_drop_pct)) {
      // 5% drop = 30, 25% drop = 100
      hrScore = _clamp(((hkSignals.resting_hr_drop_pct - 5) / 20) * 100, 0, 100);
    }
    // Blend HK + self-report when both available
    const hkScore = (hrvScore + hrScore) / 2;
    const q = Number.isFinite(avg_quality) ? avg_quality : 3;
    const e = Number.isFinite(avg_energy)  ? avg_energy  : 3;
    const selfScore = ((q - 1) / 4) * 50 + ((e - 1) / 4) * 50;  // each 0-50
    return _round(hkScore * 0.65 + selfScore * 0.35);
  }
  // Self-report only (V1 behavior)
  const q = Number.isFinite(avg_quality) ? avg_quality : 3;
  const e = Number.isFinite(avg_energy)  ? avg_energy  : 3;
  return _round(((q - 1) / 4) * 50 + ((e - 1) / 4) * 50);
}

/**
 * computeTimingScore — chronotype-adjusted bedtime variance.
 *   bedtime_target_hour  — user's setup target (e.g. 22.5 = 10:30 PM)
 *   bedtime_variance_std — std dev of actual bedtime hours over last 14d
 *
 * Lower variance = higher score (anchor your circadian rhythm).
 * <30 min std = 100; 90 min = 50; >120 min = 20. Caller passes neutral 70
 * when not enough data (< 7 nights logged).
 */
function computeTimingScore({ bedtime_target_hour, bedtime_variance_std_hours, has_min_data = true } = {}) {
  if (!has_min_data || !Number.isFinite(bedtime_variance_std_hours)) return 70;
  const std = bedtime_variance_std_hours;
  if (std <= 0.5)      return 100;   // <30 min variance — anchored
  if (std <= 1.0)      return 80;    // 30-60 min — strong
  if (std <= 1.5)      return 60;    // 60-90 min — drifting
  if (std <= 2.0)      return 40;    // 90-120 min — irregular
  return _clamp(40 - (std - 2) * 10, 0, 40);
}

/**
 * computeLatencyScore — Borbely two-process model.
 *   Sweet spot: 10-20 min. Very fast (<5 min) may signal sleep deprivation.
 *   Slow (>45 min) signals insomnia-spectrum issues.
 */
function computeLatencyScore(avg_latency_min) {
  const lat = Number.isFinite(avg_latency_min) ? avg_latency_min : 15;
  if (lat <= 5)        return 60;   // suspiciously fast
  if (lat <= 20)       return 100;  // optimal
  if (lat <= 30)       return 75;
  if (lat <= 45)       return 50;
  if (lat <= 60)       return 30;
  return _clamp(30 - (lat - 60), 0, 30);
}

/**
 * computeDurationScore — Van Dongen 2003 + AASM 7h floor.
 *   target = user's setup (max 7.0h floor).
 *   ≥target → 100; ≥7h → 75-100 linear; ≥6h → 30-75; <6h → 0-30.
 */
function computeDurationScore({ avg_duration, target_hours }) {
  const dur = Number.isFinite(avg_duration) ? avg_duration : 0;
  const tgt = Math.max(target_hours || 7.5, 7.0);
  if (dur >= tgt)       return 100;
  if (dur >= 7.0)       return _round(75 + 25 * (dur - 7.0) / (tgt - 7.0));
  if (dur >= 6.0)       return _round(30 + 45 * (dur - 6.0));
  if (dur >= 4.0)       return _round(10 + 20 * (dur - 4.0) / 2);
  return _clamp(_round(dur / 4 * 10), 0, 10);
}

/**
 * computeDebtScore — cumulative sleep debt over rolling window.
 *   debt_hours: total hours below target across last 7 nights (positive number).
 *   0h → 100; 2h → 60; 4h → 30; 7h+ → 0.
 */
function computeDebtScore(debt_hours) {
  const debt = Math.max(0, debt_hours || 0);
  if (debt <= 0.5)     return 100;
  if (debt <= 1.5)     return _round(80 - (debt - 0.5) * 20);
  if (debt <= 4.0)     return _round(60 - (debt - 1.5) * 12);
  return _clamp(30 - (debt - 4) * 8, 0, 30);
}

/**
 * computeEfficiencyScore — CBT-I gold standard.
 *   ≥90% → 100; ≥85% → 85; ≥75% → 60; ≥65% → 35; <65% → flag.
 */
function computeEfficiencyScore(avg_efficiency, hkEfficiency = null) {
  // HK trumps self-report when available (real measurement vs estimate)
  const eff = Number.isFinite(hkEfficiency) ? hkEfficiency : (Number.isFinite(avg_efficiency) ? avg_efficiency : 0);
  if (eff >= 90)       return 100;
  if (eff >= 85)       return _round(85 + (eff - 85) * 3);
  if (eff >= 75)       return _round(60 + (eff - 75) * 2.5);
  if (eff >= 65)       return _round(35 + (eff - 65) * 2.5);
  return _clamp(35 * eff / 65, 0, 35);
}

/**
 * computeConsistencyScore — bedtime variance vs 14-day rolling avg.
 *   Input already normalized to 0-100 by caller (Apple Sleep Score model).
 */
function computeConsistencyScore(consistency_0_100) {
  return _clamp(Number.isFinite(consistency_0_100) ? consistency_0_100 : 50, 0, 100);
}

/**
 * Headline V2 blender. Same input shape as V1 + optional hkSignals + timing inputs.
 *
 * Returns:
 *   {
 *     score, raw_score, maturity_mult, band,
 *     components: { duration, efficiency, restoration, timing, latency, consistency, debt },
 *     components_v1: { duration, efficiency, restoration, continuity, consistency },  // back-compat
 *     hk_used: bool,
 *     clinical_flag, clinical_note,
 *     days_logged, days_since_anchor,
 *   }
 */
function computeBlendedSleepScore({
  avg_efficiency,
  avg_duration,
  avg_quality,
  avg_energy,
  avg_latency,
  consistency_score,
  sleep_debt,
  target_hours,
  bedtime_target_hour,
  bedtime_variance_std_hours,
  days_logged,
  days_since_anchor,
  hkSignals = null,
} = {}) {
  if (!avg_efficiency && !avg_duration && !hkSignals) return null;
  const d = Number.isFinite(days_since_anchor) ? days_since_anchor : (days_logged || 1);

  // Each contributor returns 0-100 in its own space; we multiply by weight.
  const cDuration    = computeDurationScore({ avg_duration, target_hours });
  const cEfficiency  = computeEfficiencyScore(avg_efficiency, hkSignals?.efficiency_pct);
  const cRestoration = computeRestoration({ avg_quality, avg_energy, hkSignals });
  const cTiming      = computeTimingScore({
    bedtime_target_hour,
    bedtime_variance_std_hours,
    has_min_data: Number.isFinite(bedtime_variance_std_hours) && (days_logged || 0) >= 7,
  });
  const cLatency     = computeLatencyScore(avg_latency);
  const cConsistency = computeConsistencyScore(consistency_score);
  const cDebt        = computeDebtScore(sleep_debt);

  // V3 weights (sum = 1.00)
  const raw =
    cDuration    * 0.20 +
    cEfficiency  * 0.25 +
    cRestoration * 0.15 +
    cTiming      * 0.10 +
    cLatency     * 0.10 +
    cConsistency * 0.15 +
    cDebt        * 0.05 ;

  // Hard caps based on duration (clinical reality — unchanged from V1)
  const dur = avg_duration || 0;
  const durationCap = dur < 4.0 ? 30 : dur < 6.0 ? 55 : dur < 6.5 ? 72 : 100;
  const cappedRaw = Math.min(raw, durationCap);

  const maturity_mult = maturityRamp(d);
  const score = _clamp(_round(cappedRaw * maturity_mult), 0, 100);

  // Clinical flag — V1 trigger preserved
  const effForFlag = Number.isFinite(hkSignals?.efficiency_pct) ? hkSignals.efficiency_pct : (avg_efficiency || 0);
  const clinical_flag = dur < 6 || effForFlag < 65;

  return {
    score,
    raw_score: _round(cappedRaw),
    maturity_mult,
    band:
      score >= 85 ? 'thriving' :
      score >= 65 ? 'strong'   :
      score >= 50 ? 'steady'   :
      score >= 35 ? 'building' :
                    'starting' ,
    // V3 7-contributor breakdown
    components: {
      duration:    _round(cDuration    * 0.20),
      efficiency:  _round(cEfficiency  * 0.25),
      restoration: _round(cRestoration * 0.15),
      timing:      _round(cTiming      * 0.10),
      latency:     _round(cLatency     * 0.10),
      consistency: _round(cConsistency * 0.15),
      debt:        _round(cDebt        * 0.05),
    },
    // V1 keys preserved so existing FE keeps working
    components_v1: {
      duration:    _round(cDuration    * 0.30),   // V1 was 30%
      efficiency:  _round(cEfficiency  * 0.20),   // V1 was 20%
      restoration: _round(cRestoration * 0.20),   // V1 was 20%
      continuity:  _round((cLatency + cDebt) / 2 * 0.15),   // V1 lumped both
      consistency: _round(cConsistency * 0.15),
    },
    hk_used: !!hkSignals,
    days_logged: days_logged || 1,
    days_since_anchor: d,
    clinical_flag,
    clinical_note: clinical_flag
      ? (dur < 6 ? 'Duration below 6h — score capped regardless of efficiency' : 'Efficiency below 65% — CBT-I clinical concern')
      : null,
    citations: {
      duration:    'Van Dongen 2003; NIH PMC2864873',
      efficiency:  'Spielman 1987 (CBT-I); AASM',
      restoration: 'Buysse 1989 PSQI; Palmer 2023 meta',
      timing:      'Roenneberg MEQ',
      latency:     'Borbely two-process model',
      consistency: 'Apple Sleep Score; circadian literature',
      debt:        'AutoSleep canon',
    },
  };
}

module.exports = {
  maturityRamp,
  dropFutureLogs,
  deriveSleepBank,
  // V2 (2026-05-25)
  computeRestoration,
  computeTimingScore,
  computeLatencyScore,
  computeDurationScore,
  computeDebtScore,
  computeEfficiencyScore,
  computeConsistencyScore,
  computeBlendedSleepScore,
};
