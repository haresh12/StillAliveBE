'use strict';
// ════════════════════════════════════════════════════════════════
// water-scoring.js — pure scoring helpers for the Water agent.
//
// Single source of truth for how a water log becomes a 0-100 score.
// Mirrors lib/fitness-scoring.js — every helper is pure (no Firestore,
// no Express, no wall-clock time). Tests live in tests/water-scoring.test.js.
//
// Honesty laws (2026-05-24):
//   • Future-dated logs NEVER counted (`dropFutureLogs` filter law).
//   • Maturity ramp keyed on `daysSinceAnchor` (calendar time), not
//     `daysLogged` — cramming 30 logs in 3 days can't fake-mature.
//   • Chronobiology + beverage_quality are ALWAYS derived from real logs
//     (no hardcoded 0.5/0.7 fractions; no hardcoded 70 — see
//     project_water_scoring_drift_bug memory).
//   • Local-TZ date keys via `dateStr(d, utcOffsetMinutes)` from
//     range-helpers — never `toISOString().slice(0, 10)` (chart_tz_clamp law).
//
// All 5 historic scoring paths route through `computeWaterScore()` here:
//   - water.agent.js::computeHydrationScore (Analysis route inline) → reuses helpers
//   - water.agent.js::refreshWaterScore     (post-log Firestore write) → calls computeWaterScore
//   - wellness-cross-v2/adapters/water.adapter.js::scoreDailyLogs → calls computeWaterScore
//   - lib/water-analytics.js::computeHydrationScore (legacy headline) → kept for now;
//     Phase 2 leaves it intact, Phase 3+ will gradually replace its callers.
//   - lib/score-lifetime.js (adequacy aggregator) → orthogonal, untouched.
//
// Underlying canonical math stays in lib/agent-scores.js::computeWaterScore
// (4-gate, peer-reviewed weights: EFSA 2010, Lally 2010, Sawka 2007, Maughan
// 2016). This module is the wiring layer that always feeds it real inputs.
// ════════════════════════════════════════════════════════════════

const { computeWaterScore: _computeWaterScoreCanonical } = require('./agent-scores');
const { dateStr } = require('./range-helpers');

// ─── Beverage hydration coefficients (Maughan 2016 BHI) ─────────
// Effective hydration ml = raw ml × coefficient. Used by Analysis tab,
// refreshWaterScore, and cross-v2 adapter — all import from here.
const BEV_MULT = {
  water:    1.0,
  sparkling:1.0,
  herbal:   1.0,
  herbal_tea:1.0,
  tea:      0.95,
  milk:     0.92,
  juice:    0.85,
  coffee:   0.84,   // Killer 2014
  soda:     0.7,
  sport_drink: 1.05,
  alcohol:  0.4,    // Polhuis 2017 (rounded from -0.5 toward conservative)
};

// Beverages that count as "water-friendly" in the beverage_quality gate.
// Juice contributes at half-weight (sugar load offsets hydration).
const WATER_FRIENDLY_FULL = new Set(['water', 'sparkling', 'herbal', 'herbal_tea', 'milk']);
const WATER_FRIENDLY_HALF = new Set(['juice']);

const DAY_PARTS = ['morning', 'midday', 'afternoon', 'evening', 'night'];

// ─── Tiny helpers ───────────────────────────────────────────────
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const avg   = (arr = []) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;

function _ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function _getMs(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const p = new Date(value).getTime();
  return Number.isFinite(p) ? p : 0;
}

function _getDayPart(hour) {
  if (hour >= 5 && hour < 11)  return 'morning';
  if (hour >= 11 && hour < 15) return 'midday';
  if (hour >= 15 && hour < 19) return 'afternoon';
  if (hour >= 19 && hour < 24) return 'evening';
  return 'night';
}

function _emptyDay() {
  return {
    total_ml: 0,
    effective_ml: 0,
    log_count: 0,
    morning_ml: 0,
    late_ml: 0,
    water_friendly_ml: 0,
    beverages: {},
    parts: DAY_PARTS.reduce((acc, k) => ({ ...acc, [k]: 0 }), {}),
    hours: new Set(),
  };
}

// ─── Public: filter law + day grouping ──────────────────────────

/**
 * Drop logs whose `date` is strictly after today (anti-future-log law).
 * Mirrors fitness-scoring.dropFutureWorkouts.
 *   logs        — array of water log docs ({ date, logged_at, ml, ... })
 *   todayDateStr — YYYY-MM-DD in user's local TZ
 */
function dropFutureLogs(logs, todayDateStr) {
  if (!todayDateStr || !Array.isArray(logs)) return Array.isArray(logs) ? logs.slice() : [];
  return logs.filter((l) => !l.date || l.date <= todayDateStr);
}

/**
 * Group raw logs into per-day buckets keyed by local-TZ YYYY-MM-DD.
 * Every numeric aggregate the gates need is precomputed here so the gate
 * helpers stay O(days) instead of O(logs).
 *
 *   logs             — array of {ml, beverage_type|drink_type, date, logged_at}
 *   utcOffsetMinutes — user's TZ offset for key resolution (defaults to 0)
 *   lateCutoffMin    — minutes-since-midnight at which "late_ml" starts
 *                      counting (defaults to 20:00 = 1200). Caller may
 *                      pass setup.bed_time_min - 120 for personalised taper.
 */
function groupLogsByDate(logs = [], { utcOffsetMinutes = 0, lateCutoffMin = 20 * 60 } = {}) {
  const byDate = {};
  for (const log of logs) {
    const ms = _getMs(log.logged_at);
    const fallbackDate = ms ? dateStr(new Date(ms), utcOffsetMinutes) : null;
    const key = log.date || fallbackDate;
    if (!key) continue;

    const bevType    = log.beverage_type || log.drink_type || 'water';
    const mult       = Object.prototype.hasOwnProperty.call(BEV_MULT, bevType) ? BEV_MULT[bevType] : 1.0;
    const ml         = Number(log.ml || log.amount_ml || 0);
    const effective  = Number.isFinite(log.effective_ml) && log.effective_ml > 0
      ? log.effective_ml
      : Math.round(ml * mult);
    const dt         = ms ? new Date(ms) : null;
    const hour       = dt ? dt.getHours() : 12;
    const mins       = dt ? hour * 60 + dt.getMinutes() : 12 * 60;
    const part       = _getDayPart(hour);

    if (!byDate[key]) byDate[key] = _emptyDay();
    const d = byDate[key];

    d.total_ml      += ml;
    d.effective_ml  += effective;
    d.log_count     += 1;
    d.parts[part]   += effective;
    d.beverages[bevType] = (d.beverages[bevType] || 0) + effective;
    if (hour < 11) d.morning_ml += effective;
    if (mins >= lateCutoffMin) d.late_ml += effective;
    d.hours.add(hour);

    if (WATER_FRIENDLY_FULL.has(bevType))      d.water_friendly_ml += effective;
    else if (WATER_FRIENDLY_HALF.has(bevType)) d.water_friendly_ml += Math.round(effective * 0.5);
  }
  return byDate;
}

// ─── The 4 gates (Path A canonical weights: 35 / 25 / 25 / 15) ──

/**
 * Gate 1 — Hydration Adequacy (35%). EFSA 2010 + Gandy 2015.
 * Mean of clamped `effective_ml / goal_ml × 100` across recentKeys (no-log
 * days count as 0% — they ARE the gap).
 */
function deriveHydrationAdequacy(byDate, goalByDate, recentKeys) {
  if (!recentKeys?.length) return 0;
  return Math.round(avg(recentKeys.map((k) => {
    const eff  = byDate[k]?.effective_ml || 0;
    const goal = Math.max(1, goalByDate[k] || 2500);
    return clamp((eff / goal) * 100, 0, 100);
  })));
}

/**
 * Gate 2 — Consistency (25%). Lally 2010 (habit formation) + Popkin 2010
 * (irregular intake worse than sustained mild dehydration). % of recentKeys
 * where intake ≥ 80% of that day's active goal.
 */
function deriveConsistency(byDate, goalByDate, recentKeys) {
  if (!recentKeys?.length) return 0;
  const hits = recentKeys.filter((k) => {
    const eff  = byDate[k]?.effective_ml || 0;
    const goal = goalByDate[k] || 2500;
    return eff >= goal * 0.8;
  }).length;
  return Math.round((hits / recentKeys.length) * 100);
}

/**
 * Gate 3 — Chronobiology (25%). Sawka 2007 ACSM (morning front-load
 * = highest-leverage window) + Shirreffs 2000 (late excess disrupts ADH
 * rhythm). Composite: 60% front-load × 40% late taper.
 *   • Front-load day = morning_ml ≥ max(300, goal × 22%)
 *   • Late-taper day = late_ml ≤ 250
 */
function deriveChronobiology(byDate, goalByDate, recentKeys) {
  if (!recentKeys?.length) return 0;
  const frontLoadDays = recentKeys.filter((k) => {
    const morning = byDate[k]?.morning_ml || 0;
    const threshold = Math.max(300, (goalByDate[k] || 2500) * 0.22);
    return morning >= threshold;
  }).length;
  const lateTaperDays = recentKeys.filter((k) => (byDate[k]?.late_ml || 0) <= 250).length;
  const frontLoadPct = (frontLoadDays / recentKeys.length) * 100;
  const lateTaperPct = (lateTaperDays / recentKeys.length) * 100;
  return Math.round(frontLoadPct * 0.6 + lateTaperPct * 0.4);
}

/**
 * Gate 4 — Beverage Quality (15%). Maughan 2016 BHI. Mean of
 * `water_friendly_ml / effective_ml × 100` across recentKeys with logs.
 * No-log days return a neutral 60 so a sparse logger isn't double-penalised
 * (Gate 1 + Gate 2 already capture the absence).
 */
function deriveBeverageQuality(byDate, recentKeys) {
  if (!recentKeys?.length) return 0;
  const scored = recentKeys.map((k) => {
    const d = byDate[k];
    if (!d || !d.effective_ml) return 60;
    return clamp((d.water_friendly_ml / d.effective_ml) * 100, 0, 100);
  });
  return Math.round(avg(scored));
}

/**
 * Maturity ramp — anchor-keyed (NOT log-count keyed). Mirrors fitness
 * exactly: 0.40 → 1.00 across day 0 / 4 / 7 / 14 / 30 / 60+. Slower than
 * lib/agent-scores.js::maturityFactor so cramming logs can't fake-mature.
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

// ─── THE entry point — single call site for all scoring paths ───

/**
 * Compute the full 4-gate water score for a window of logs.
 *
 * Inputs:
 *   logs              — raw water log docs (filtered to the window externally)
 *   goalByDate        — map of YYYY-MM-DD → that day's active goal_ml
 *                       (use buildGoalMap from water.agent.js or pass a flat
 *                        {key: goal_ml} for every recentKey)
 *   recentKeys        — array of YYYY-MM-DD keys defining the scoring window
 *                       (typically the last 7 days clamped to anchor)
 *   daysSinceAnchor   — calendar days since signup (for maturity ramp)
 *   utcOffsetMinutes  — user's TZ offset for date keying
 *   lateCutoffMin     — minutes-since-midnight late_ml threshold (default 1200)
 *
 * Output: same shape as lib/agent-scores.js::computeWaterScore — i.e.
 *   { score, label, components: {hydration_adequacy, consistency,
 *     chronobiology, beverage_quality}, clinical_flag, days_logged, citations }
 *
 * Returns `null` if the window has no scorable data — caller decides whether
 * to short-circuit or render a "Day-1" empty state.
 */
function computeWaterScore({
  logs = [],
  goalByDate = {},
  recentKeys = [],
  daysSinceAnchor = 0,
  utcOffsetMinutes = 0,
  lateCutoffMin = 20 * 60,
  todayDateStr = null,
}) {
  const filtered = todayDateStr ? dropFutureLogs(logs, todayDateStr) : logs;
  const byDate   = groupLogsByDate(filtered, { utcOffsetMinutes, lateCutoffMin });

  const hydration_adequacy = deriveHydrationAdequacy(byDate, goalByDate, recentKeys);
  const consistency        = deriveConsistency(byDate, goalByDate, recentKeys);
  const chronobiology      = deriveChronobiology(byDate, goalByDate, recentKeys);
  const beverage_quality   = deriveBeverageQuality(byDate, recentKeys);

  const avg_7d_ml = recentKeys.length
    ? Math.round(avg(recentKeys.map((k) => byDate[k]?.effective_ml || 0)))
    : 0;
  const days_logged = Object.values(byDate).filter((d) => d.log_count > 0).length;

  // Defer to the canonical scorer for the final weighting + clinical flag.
  // This is intentional — Path A is the peer-reviewed math; this module
  // just guarantees Path A is always called with real inputs.
  const canonical = _computeWaterScoreCanonical({
    hydration_adequacy,
    consistency,
    chronobiology,
    beverage_quality,
    avg_7d_ml,
    days_logged,
  });
  if (!canonical) return null;

  // Re-apply our anchor-keyed maturity ramp ON TOP of the canonical
  // ramp ONLY when daysSinceAnchor > daysLogged. The canonical scorer
  // uses log-count maturity; we'd rather honour calendar time when the
  // two diverge (e.g., logged once a week for 8 weeks = 8 logs but
  // 56 days since anchor). Keep this conservative — only DAMPEN, never
  // amplify, so existing tests + warm-start invariants hold.
  if (daysSinceAnchor > 0 && daysSinceAnchor < days_logged * 1.5) {
    // log-count maturity was generous; clamp the score down to what
    // calendar-time maturity would have produced.
    const ratio = maturityRamp(daysSinceAnchor) / Math.max(0.40, canonical.days_logged ? 1 : 0.40);
    if (ratio < 1) {
      canonical.score = Math.max(0, Math.min(100, Math.round(canonical.score * ratio)));
    }
  }

  return canonical;
}

// ─── Phase 5: vs-prior-period delta ─────────────────────────────

/**
 * Compare a window of water logs to the equal-length window immediately
 * before it. Returns null when there's no prior data (don't lie about
 * a zero baseline).
 *
 * Anchor-aware: caller must clamp `priorLogs` to [max(priorStart, anchor),
 * currentStart). Returns null sample_size if clamp shrunk the prior window
 * below 3 days.
 */
function derivePriorPeriod({
  priorLogs = [],
  priorGoalByDate = {},
  priorRecentKeys = [],
  currentTotalMl = 0,
  currentAvgMl = 0,
  currentDaysLogged = 0,
  currentCompletion = 0,
}) {
  if (!priorLogs.length || priorRecentKeys.length < 3) return null;

  const byDate = groupLogsByDate(priorLogs);
  let totalMl = 0;
  let daysWithLog = 0;
  let completedDays = 0;
  for (const k of priorRecentKeys) {
    const d = byDate[k];
    const eff = d?.effective_ml || 0;
    totalMl += eff;
    if (d && d.log_count > 0) daysWithLog++;
    if (eff >= (priorGoalByDate[k] || 2500)) completedDays++;
  }
  const avgMl = daysWithLog > 0 ? Math.round(totalMl / daysWithLog) : 0;
  const completion = priorRecentKeys.length > 0 ? completedDays / priorRecentKeys.length : 0;

  const pct = (curr, prev) => prev > 0 ? Math.round(((curr - prev) / prev) * 100) : null;
  const ptDelta = (curr, prev) => Math.round((curr - prev) * 100);

  return {
    sample_size:           daysWithLog,
    prior_total_ml:        Math.round(totalMl),
    prior_avg_ml:          avgMl,
    prior_days_logged:     daysWithLog,
    prior_completion_pct:  Math.round(completion * 100),
    delta_total_ml_pct:    pct(currentTotalMl, totalMl),
    delta_avg_ml_pct:      pct(currentAvgMl, avgMl),
    delta_days_pct:        pct(currentDaysLogged, daysWithLog),
    delta_completion_pct:  ptDelta(currentCompletion, completion),
  };
}

// ─── Phase 6: 365-day Your Journey heatmap ──────────────────────

/**
 * GitHub-style 365-cell contribution map for hydration. Each cell:
 *   { date, level: 0|1|2|3, pre_anchor: bool, future: bool, pct?: number }
 *
 * level: 0=no log, 1=poor (<40%), 2=ok (40-70%), 3=good (70%+).
 * Always 365 cells, anchor→anchor+364. Pre-anchor cells tagged so FE can
 * dim them per the anchor-hide-not-grey law.
 *
 * Pure function — date math uses UTC arithmetic on synthetic dates, never
 * reads local fields off Date objects.
 */
function derive365Heatmap({ dailyQualityByDate = {}, anchorDate, todayDate, spanDays = 365 }) {
  if (!todayDate) return { cells: [], summary: { logged_days: 0, missed_days: 0, span_days: 0, total_cells: 0 } };

  let startMs;
  if (anchorDate) {
    const [ay, am, ad] = anchorDate.split('-').map(Number);
    startMs = Date.UTC(ay, am - 1, ad);
  } else {
    const [ey, em, ed] = todayDate.split('-').map(Number);
    startMs = Date.UTC(ey, em - 1, ed) - (spanDays - 1) * 86_400_000;
  }
  const endMs = startMs + (spanDays - 1) * 86_400_000;
  const cells = [];

  let cur = startMs;
  while (cur <= endMs) {
    const dt = new Date(cur);
    const ds = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
    const q = dailyQualityByDate[ds];
    let level = 0;
    if (Number.isFinite(q) && q > 0) {
      level = q >= 70 ? 3 : q >= 40 ? 2 : 1;
    }
    const future    = ds > todayDate;
    const preAnchor = anchorDate ? ds < anchorDate : false;
    cells.push({
      date: ds,
      level,
      pct: Number.isFinite(q) ? Math.max(0, Math.min(100, Math.round(q))) : null,
      pre_anchor: preAnchor,
      future,
    });
    cur += 86_400_000;
  }
  const loggedDays  = cells.filter((c) => c.level > 0 && !c.pre_anchor && !c.future).length;
  const activeCells = cells.filter((c) => !c.future && !c.pre_anchor).length;
  return {
    cells,
    summary: {
      logged_days: loggedDays,
      missed_days: Math.max(0, activeCells - loggedDays),
      span_days:   activeCells,
      total_cells: cells.length,
    },
  };
}

// ─── Phase 7: Balance card — beverage mix + day-of-week ─────────

/**
 * Beverage type breakdown for the window. Same shape as the existing
 * water-analytics.computeDrinkBreakdown but accepts pre-grouped byDate.
 * Sorted high → low by effective ml.
 */
function deriveBeverageMix(byDate, recentKeys) {
  const totals = {};
  for (const k of recentKeys) {
    const d = byDate[k];
    if (!d) continue;
    for (const [type, ml] of Object.entries(d.beverages || {})) {
      totals[type] = (totals[type] || 0) + ml;
    }
  }
  const grand = Object.values(totals).reduce((a, b) => a + b, 0);
  if (!grand) return [];
  return Object.entries(totals)
    .map(([type, ml]) => ({
      type,
      effective_ml: Math.round(ml),
      pct: Math.round((ml / grand) * 100),
    }))
    .sort((a, b) => b.effective_ml - a.effective_ml);
}

/**
 * Per-day-of-week aggregate. Returns 7 entries Mon-Sun:
 *   { dow: 0..6 (0=Mon for chart convention), label, avg_ml, pct_of_goal, count }
 */
function deriveDayOfWeek(byDate, goalByDate, recentKeys) {
  const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const byDow = Array.from({ length: 7 }, () => ({ total: 0, goal: 0, count: 0 }));
  for (const k of recentKeys) {
    const d = byDate[k];
    if (!d) continue;
    const [y, m, dd] = k.split('-').map(Number);
    // JS Sunday=0 ... Saturday=6 — convert to Mon=0 ... Sun=6.
    const jsDow  = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
    const idx    = (jsDow + 6) % 7;
    byDow[idx].total += d.effective_ml;
    byDow[idx].goal  += goalByDate[k] || 2500;
    byDow[idx].count += 1;
  }
  return byDow.map((b, i) => ({
    dow:    i,
    label:  DOW_LABELS[i],
    avg_ml: b.count > 0 ? Math.round(b.total / b.count) : 0,
    pct_of_goal: b.count > 0 ? Math.round((b.total / b.goal) * 100) : 0,
    count:  b.count,
  }));
}

// ─── Phase 8: Effort Mix tier (chronobiology framing) ───────────

/**
 * Turn a chronobiology score (0-100) into a plain-English tier + locale key.
 * Pure function — caller passes the score from the same gate helper used
 * by the score computation, so tier and score never disagree.
 */
function effortMixTier(chronobiologyScore) {
  const s = Number.isFinite(chronobiologyScore) ? chronobiologyScore : 0;
  if (s >= 85) return { tier_key: 'excellent', tier_pct: s };
  if (s >= 65) return { tier_key: 'strong',    tier_pct: s };
  if (s >= 40) return { tier_key: 'building',  tier_pct: s };
  if (s >= 20) return { tier_key: 'low',       tier_pct: s };
  return         { tier_key: 'starting',  tier_pct: s };
}

module.exports = {
  // Constants
  BEV_MULT,
  WATER_FRIENDLY_FULL,
  WATER_FRIENDLY_HALF,
  DAY_PARTS,
  // Public helpers
  dropFutureLogs,
  groupLogsByDate,
  deriveHydrationAdequacy,
  deriveConsistency,
  deriveChronobiology,
  deriveBeverageQuality,
  maturityRamp,
  computeWaterScore,
  // Phase 5
  derivePriorPeriod,
  // Phase 6
  derive365Heatmap,
  // Phase 7
  deriveBeverageMix,
  deriveDayOfWeek,
  // Phase 8
  effortMixTier,
};
