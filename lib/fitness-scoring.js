'use strict';
// ════════════════════════════════════════════════════════════════
// fitness-scoring.js — pure scoring helpers used by /analysis.
//
// Extracted so the math can be exercised in isolation (tests live in
// tests/fitness-scoring.test.js). Anything depending on Firestore,
// Express, or wall-clock time stays in the route handler.
//
// Honesty laws (2026-05-23):
//   • No `session_quality` from the deprecated session-timer flow.
//   • Per-session quality derived from volume / RPE / sets / PRs.
//   • Maturity ramp keyed on daysSinceAnchor (calendar time), not
//     days_logged — cramming 30 sessions in 3 days can't fake-mature.
//   • Future-dated workouts NEVER counted in "what happened".
// ════════════════════════════════════════════════════════════════

const SESS_PER_WK = 4;

/**
 * Per-session quality 0-100. Inputs are whatever a single workout doc has:
 *   { total_volume_kg, total_sets, rpe_avg, personal_records: string[] }
 *
 * Targets come from the user's setup (weekly_volume_target_kg / weekly_sets_target),
 * divided by `sessPerWk` (default 4) to yield per-session expectations.
 */
function deriveSessionQuality(workout, { weeklyVolTarget, weeklySetsTarget, sessPerWk = SESS_PER_WK } = {}) {
  const volPerSessionTarget  = (weeklyVolTarget  || 4500) / sessPerWk;
  const setsPerSessionTarget = (weeklySetsTarget || 14)   / sessPerWk;
  const vol  = workout?.total_volume_kg || 0;
  const sets = workout?.total_sets || 0;
  const rpe  = workout?.rpe_avg || 0;
  const prs  = Array.isArray(workout?.personal_records) ? workout.personal_records.length : 0;

  const volPct  = Math.max(0, Math.min(100, (vol  / Math.max(volPerSessionTarget,  1)) * 100));
  const setsPct = Math.max(0, Math.min(100, (sets / Math.max(setsPerSessionTarget, 1)) * 100));
  // RPE: 7-9 = perfect (100). Drops off below 6 (under-loading) and above
  // 9.5 (junk volume / form risk). No RPE → neutral 60.
  let rpeScore;
  if (!rpe || rpe <= 0)        rpeScore = 60;
  else if (rpe >= 7 && rpe <= 9) rpeScore = 100;
  else if (rpe < 7)             rpeScore = Math.max(0, Math.min(100, ((rpe - 4) / 3) * 100));
  else                          rpeScore = Math.max(0, Math.min(100, 100 - ((rpe - 9) * 40)));
  // PR bonus: each PR = +10 raw, capped at +30 (3+ PRs = max).
  const prBonus = Math.min(30, prs * 10);

  const raw = volPct * 0.40 + rpeScore * 0.30 + setsPct * 0.20 + prBonus;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/**
 * Maturity ramp — caps the raw blended score so a "perfect" day-1 session
 * yields ≈30-40, climbing to ≈75-85 by month 1 for sustained 4-sess/wk users.
 * Driven by calendar days since anchor (not session count) so cramming
 * can't fake-mature the user.
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

/**
 * Blended fitness score (0-100). The user-facing headline number.
 *   volume:      0.38   (weekly actual / weekly target)
 *   intensity:   0.31   (avg RPE → 5-9 range mapped 0-100)
 *   consistency: 0.31   (unique sessions this week / 4)
 *
 * Each component is floored at 0 — RPE < 5 used to make intensity
 * negative, silently dragging the blend down.
 */
function computeBlendedScore({ weeklyVolKg, volTarget, avgRpe, sessionsThisWeek, sessTargetPerWk = SESS_PER_WK }) {
  const volPctOfTarget = Math.max(0, Math.min(100, Math.round((weeklyVolKg / Math.max(volTarget || 1, 1)) * 100)));
  const intensityScore = Math.max(0, Math.min(100, Math.round((((avgRpe || 0) - 5) / 4) * 100)));
  const consistencyScore = Math.max(0, Math.min(100, Math.round((sessionsThisWeek / Math.max(sessTargetPerWk, 1)) * 100)));
  const raw = volPctOfTarget * 0.38 + intensityScore * 0.31 + consistencyScore * 0.31;
  return { raw, volPctOfTarget, intensityScore, consistencyScore };
}

/**
 * Drop workouts whose `date` (YYYY-MM-DD) is strictly after today's date.
 * Future-dated logs (allowed in dev via `dev_allow_future`) must NOT inflate
 * "what happened so far" — they create inconsistency between the chart
 * (clamped to today) and stats / Verdict / score (which would otherwise
 * include them).
 *
 * Workouts with no `date` field pass through (legacy data).
 */
function dropFutureWorkouts(workouts, todayDateStr) {
  if (!todayDateStr) return workouts.slice();
  return workouts.filter((w) => !w.date || w.date <= todayDateStr);
}

// ════════════════════════════════════════════════════════════════
// New surfaces (2026-05-23) — all derived from existing workout docs.
// Every helper is pure; no Firestore, no clock. The /analysis route
// is the only caller; tests exercise these directly.
// ════════════════════════════════════════════════════════════════

const PUSH_MUSCLES = new Set(['chest', 'shoulders', 'triceps']);
const PULL_MUSCLES = new Set(['back', 'biceps', 'rear_delts']);
const LEGS_MUSCLES = new Set(['legs', 'quads', 'hamstrings', 'glutes', 'calves']);

// Heaviest single set across all exercises in the session.
function sessionTopKg(w) {
  let top = 0;
  for (const ex of (w?.exercises || [])) {
    for (const s of (ex?.sets || [])) {
      const kg = +s.weight_kg || 0;
      if (kg > top) top = kg;
    }
  }
  return top;
}

// Local-TZ YYYY-MM-DD from a Date (no UTC drift). Required by all
// per-day aggregators so keys match what `dateStr()` produces in
// range-helpers (the BE's canonical date format).
function _ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// Session duration (min) — derives from started_at/ended_at if both exist
// on the workout doc (session-flow), else null (direct /log flow doesn't
// track time). Bounds: [10, 240] to reject corrupted timestamps.
function sessionDurationMin(w) {
  const start = w?.started_at;
  const end   = w?.ended_at;
  const toMs = (v) => {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    if (typeof v?.toMillis === 'function') return v.toMillis();
    if (typeof v?.toDate === 'function') return v.toDate().getTime();
    const p = new Date(v).getTime();
    return Number.isFinite(p) ? p : null;
  };
  const a = toMs(start), b = toMs(end);
  if (a == null || b == null || b <= a) return null;
  const min = Math.round((b - a) / 60000);
  if (min < 10 || min > 240) return null;
  return min;
}

/**
 * Banister-lite EMA over every CALENDAR day in [startDateStr … todayDateStr],
 * not just session days — so EMAs decay naturally on rest days (otherwise
 * ATL stays inflated and short windows always read "overreached").
 *
 * Inputs:
 *   sessions       — array of workouts with { date: 'YYYY-MM-DD', total_volume_kg, rpe_avg }
 *   priorSessions  — same shape, used to pre-warm CTL across its 28-day τ.
 *                    Pass ALL workouts since (today − 56d) for best results.
 *   startDateStr   — YYYY-MM-DD where the walk begins (typically anchor or today-56d)
 *   todayDateStr   — YYYY-MM-DD of "today"
 *
 * Output: { ctl, atl, tsb, ratio, readiness, band, explain }
 *   readiness: 0-100 (100 = fresh, 0 = overreached)
 *   band: one of peaked|fresh|steady|building|overload|overreached
 */
function computeBanister({ sessions = [], priorSessions = [], startDateStr, todayDateStr }) {
  const impByDate = {};
  for (const s of [...priorSessions, ...sessions]) {
    if (!s?.date) continue;
    const imp = (s.total_volume_kg || 0) * (1 + 0.025 * (10 - (s.rpe_avg || 7)));
    // If two sessions land on the same day, sum their impulses (rare but valid).
    impByDate[s.date] = (impByDate[s.date] || 0) + imp;
  }
  let ctl = 0, atl = 0;
  // Walk every calendar day inclusive. Bail safely if dates are bad.
  if (!startDateStr || !todayDateStr || startDateStr > todayDateStr) {
    return { ctl: 0, atl: 0, tsb: 0, ratio: 1, readiness: 50, band: 'steady', explain: '' };
  }
  const [sy, sm, sd] = startDateStr.split('-').map(Number);
  const [ey, em, ed] = todayDateStr.split('-').map(Number);
  let cur = Date.UTC(sy, sm - 1, sd);
  const endMs = Date.UTC(ey, em - 1, ed);
  while (cur <= endMs) {
    const dt = new Date(cur);
    const ds = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
    const imp = impByDate[ds] || 0;
    ctl = ctl + (imp - ctl) / 28;
    atl = atl + (imp - atl) / 7;
    cur += 86_400_000;
  }
  const tsb = ctl - atl;
  const ratio = ctl > 0 ? atl / ctl : 1;
  const readiness = Math.max(0, Math.min(100, Math.round(100 - (ratio - 0.7) * 100)));
  const band =
    ratio < 0.70 ? 'peaked'      :
    ratio < 0.90 ? 'fresh'       :
    ratio < 1.05 ? 'steady'      :
    ratio < 1.20 ? 'building'    :
    ratio < 1.40 ? 'overload'    :
                   'overreached';
  const explain =
    band === 'peaked'      ? 'Long taper — body fully recovered. Hit a max attempt.'    :
    band === 'fresh'       ? 'Recovered. Today is good for top sets.'                   :
    band === 'steady'      ? 'Even load. Maintain current intensity.'                   :
    band === 'building'    ? 'Accumulating fatigue — normal in a hard block.'           :
    band === 'overload'    ? 'Fatigue is climbing. Pull back one session, then resume.' :
                             'Heavy fatigue. Take 2–3 days light. Sleep + protein.';
  return {
    ctl: Math.round(ctl), atl: Math.round(atl), tsb: Math.round(tsb),
    ratio: +ratio.toFixed(3), readiness, band, explain,
  };
}

/**
 * vs-prior-period delta. Compares the requested window to the equal-length
 * window immediately before it. Returns null when there's no prior data
 * (don't lie about a zero baseline).
 */
function derivePriorPeriod({ priorWorkouts, currentTotalVolKg, currentTotalSets, currentDaysLogged, currentPRs }) {
  if (!priorWorkouts?.length) return null;
  const priorVol  = priorWorkouts.reduce((a, w) => a + (w.total_volume_kg || 0), 0);
  const priorSets = priorWorkouts.reduce((a, w) => a + (w.total_sets || 0), 0);
  const priorPRs  = priorWorkouts.reduce((a, w) => a + ((w.personal_records || []).length), 0);
  const priorDays = priorWorkouts.length;
  const pct = (curr, prev) => prev > 0 ? Math.round(((curr - prev) / prev) * 100) : null;
  return {
    days_logged:    priorDays,
    total_volume_kg: Math.round(priorVol * 10) / 10,
    total_sets:     priorSets,
    prs:            priorPRs,
    delta_vol_pct:  pct(currentTotalVolKg, priorVol),
    delta_sets_pct: pct(currentTotalSets, priorSets),
    delta_days_pct: pct(currentDaysLogged, priorDays),
    delta_prs_abs:  (currentPRs || 0) - priorPRs,
  };
}

/**
 * Effort mix — distribution of working sets across RPE bands.
 *   easy: RPE < 7   (warmup / under-loaded)
 *   working: RPE 7-9 (hypertrophy zone — the productive band)
 *   max: RPE ≥ 9.5 (all-out / failure-adjacent)
 * Sets with no RPE field don't count toward any bucket.
 */
function deriveEffortMix(workouts) {
  let easyN = 0, workN = 0, maxN = 0;
  for (const w of (workouts || [])) {
    for (const ex of (w.exercises || [])) {
      for (const s of (ex.sets || [])) {
        const r = +s.rpe || 0;
        if (r <= 0) continue;
        if (r >= 9.5)      maxN++;
        else if (r >= 7)   workN++;
        else               easyN++;
      }
    }
  }
  const total_n = easyN + workN + maxN;
  if (total_n === 0) {
    return { easy_pct: 0, working_pct: 0, max_pct: 0, working_n: 0, total_n: 0 };
  }
  return {
    easy_pct:    Math.round(easyN / total_n * 100),
    working_pct: Math.round(workN / total_n * 100),
    max_pct:     Math.round(maxN / total_n * 100),
    working_n:   workN,
    total_n,
  };
}

/**
 * Push / Pull / Legs balance — categorize each set by muscle group.
 * Single source of truth for the categorization (PUSH/PULL/LEGS_MUSCLES).
 * `warn` = true if any category has <20% AND the window is ≥28 days (so
 * a 7-day cherry-pick doesn't false-alarm).
 */
function derivePushPullLegs(workouts, spanDays = 0) {
  let pushSets = 0, pullSets = 0, legsSets = 0;
  for (const w of (workouts || [])) {
    for (const ex of (w.exercises || [])) {
      const m = ex.muscle_group;
      const n = (ex.sets || []).length;
      if (PUSH_MUSCLES.has(m))      pushSets += n;
      else if (PULL_MUSCLES.has(m)) pullSets += n;
      else if (LEGS_MUSCLES.has(m)) legsSets += n;
    }
  }
  const total = pushSets + pullSets + legsSets;
  if (total === 0) {
    return { push_sets: 0, pull_sets: 0, legs_sets: 0, push_pct: 0, pull_pct: 0, legs_pct: 0, warn: false };
  }
  const push_pct = Math.round(pushSets / total * 100);
  const pull_pct = Math.round(pullSets / total * 100);
  const legs_pct = Math.round(legsSets / total * 100);
  const warn = spanDays >= 28 && (Math.min(pushSets, pullSets, legsSets) / total) < 0.20;
  return { push_sets: pushSets, pull_sets: pullSets, legs_sets: legsSets, push_pct, pull_pct, legs_pct, warn };
}

/**
 * Frequency per muscle group, expressed as sessions/week. Distinct from
 * volume — research shows frequency is an independent driver of hypertrophy
 * (Schoenfeld 2019). Sorted high → low.
 */
function deriveMuscleFrequency(workouts, spanDays = 1) {
  const weeks = Math.max(1, spanDays / 7);
  const counts = {};
  for (const w of (workouts || [])) {
    const hit = new Set();
    for (const ex of (w.exercises || [])) {
      if (ex.muscle_group && ex.muscle_group !== 'other') hit.add(ex.muscle_group);
    }
    hit.forEach((m) => { counts[m] = (counts[m] || 0) + 1; });
  }
  return Object.entries(counts)
    .map(([muscle, n]) => ({
      muscle,
      sessions_total: n,
      per_week: Math.round((n / weeks) * 10) / 10,
    }))
    .sort((a, b) => b.per_week - a.per_week);
}

/**
 * Exercise variety — unique lift count over the window. `stagnant` flags
 * monotony risk: <6 unique lifts across a ≥30-day window (movement adaptation
 * benefits from rotation per RP / Israetel).
 */
function deriveExerciseVariety(workouts, spanDays = 0) {
  const names = new Set();
  for (const w of (workouts || [])) {
    for (const ex of (w.exercises || [])) {
      if (ex.name) names.add(ex.name);
    }
  }
  return { unique: names.size, stagnant: spanDays >= 30 && names.size < 6 };
}

/**
 * Hour-of-day heatmap. 7×24 grid (DOW × hour) of session counts.
 * `hour` derived from `logged_at` in user's local TZ (utcOffsetMinutes).
 */
function deriveHourGrid(workouts, utcOffsetMinutes = 0) {
  const out = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const off = Number.isFinite(utcOffsetMinutes) ? utcOffsetMinutes : 0;
  for (const w of (workouts || [])) {
    const v = w.logged_at;
    let ms = null;
    if (v == null) continue;
    if (typeof v === 'number') ms = v;
    else if (typeof v?.toMillis === 'function') ms = v.toMillis();
    else if (typeof v?.toDate === 'function')  ms = v.toDate().getTime();
    else { const p = new Date(v).getTime(); ms = Number.isFinite(p) ? p : null; }
    if (ms == null) continue;
    const local = new Date(ms + off * 60_000);
    const dow = local.getUTCDay();
    const hour = local.getUTCHours();
    if (dow >= 0 && dow < 7 && hour >= 0 && hour < 24) {
      out[dow][hour] = (out[dow][hour] || 0) + 1;
    }
  }
  return out;
}

/**
 * Contribution map — GitHub-style 365-day grid spanning anchor → anchor+364
 * (the user's first year since signup). Each entry: { date, level, future }.
 * Cells after today are tagged `future` (haven't happened yet).
 *
 * Falls back to "last 365 days ending today" when no anchorDate is supplied.
 *
 * level: 0 (rest) | 1 (poor) | 2 (ok) | 3 (good)
 *   Derived from a `dayQualityByDate` map (e.g. _derived_quality already
 *   used by per-day score). Buckets match the FE Calendar.
 */
function deriveContributionMap({ dayQualityByDate = {}, anchorDate, todayDate, spanDays = 365 }) {
  const cells = [];
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

  let cur = startMs;
  while (cur <= endMs) {
    const dt = new Date(cur);
    const ds = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
    const q = dayQualityByDate[ds];
    let level = 0;
    if (Number.isFinite(q)) level = q >= 75 ? 3 : q >= 55 ? 2 : 1;
    const future = ds > todayDate;
    // Keep `pre_anchor` as `false` for back-compat with any FE check, but
    // the grid no longer includes pre-anchor days.
    cells.push({ date: ds, level, pre_anchor: false, future });
    cur += 86_400_000;
  }
  const loggedDays  = cells.filter((c) => c.level > 0).length;
  const activeCells = cells.filter((c) => !c.future).length;
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

/**
 * Plateau detection per strength-trend entry. Walks the e1RM points back
 * from the latest; counts weeks until a higher point is found. ≥3 weeks
 * stalled + delta_pct in [-1.5, +1.5] = stalled. Else not stalled.
 *
 * Input: { exercise, points: number[], dates: string[] }
 *   `dates` parallel to points; if absent, falls back to "weeks ago" by
 *   spacing points one week apart.
 */
function derivePlateau({ points, dates }) {
  if (!Array.isArray(points) || points.length < 2) {
    return { stalled: false, weeks_stalled: 0 };
  }
  const last = points[points.length - 1];
  let weeksStalled = 0;
  const lastDateMs = dates?.length
    ? new Date((dates[dates.length - 1] || '') + 'T12:00:00').getTime()
    : Date.now();
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i] > last) {
      if (dates?.[i]) {
        const ageMs = lastDateMs - new Date(dates[i] + 'T12:00:00').getTime();
        weeksStalled = Math.max(0, Math.floor(ageMs / (7 * 86_400_000)));
      } else {
        weeksStalled = (points.length - 1) - i;
      }
      break;
    }
  }
  const first = points[0];
  const deltaPct = first > 0 ? ((last - first) / first) * 100 : 0;
  const stalled = weeksStalled >= 3 && Math.abs(deltaPct) < 1.5;
  return { stalled, weeks_stalled: weeksStalled };
}

/**
 * Duration + density aggregates over a list of workouts. Returns nulls
 * when no workouts carry duration info (direct-log flow without timers).
 */
function deriveDurationDensity(workouts) {
  let durTotal = 0, durCount = 0, totalSets = 0;
  for (const w of (workouts || [])) {
    const d = sessionDurationMin(w);
    if (d != null) { durTotal += d; durCount += 1; }
    totalSets += w.total_sets || 0;
  }
  const avg_duration_min = durCount > 0 ? Math.round(durTotal / durCount) : null;
  const set_density = durTotal > 0 ? Math.round((totalSets / durTotal) * 10 * 100) / 100 : null; // sets per 10 min
  return { avg_duration_min, set_density };
}

module.exports = {
  SESS_PER_WK,
  PUSH_MUSCLES, PULL_MUSCLES, LEGS_MUSCLES,
  deriveSessionQuality,
  maturityRamp,
  computeBlendedScore,
  dropFutureWorkouts,
  // New (2026-05-23)
  sessionTopKg,
  sessionDurationMin,
  computeBanister,
  derivePriorPeriod,
  deriveEffortMix,
  derivePushPullLegs,
  deriveMuscleFrequency,
  deriveExerciseVariety,
  deriveHourGrid,
  deriveContributionMap,
  derivePlateau,
  deriveDurationDensity,
};
