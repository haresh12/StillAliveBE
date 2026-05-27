'use strict';
// ════════════════════════════════════════════════════════════════
// fasting-scoring.js — pure scoring helpers used by /analysis.
//
// Mirrors lib/fitness-scoring.js structure (the 10/10 canon). Nothing
// here depends on Firestore, Express, or wall-clock time — tests in
// tests/fasting-scoring*.js exercise every helper in isolation.
//
// Honesty laws (2026-05-23):
//   • Per-session quality derived from completion / depth / cleanness /
//     refeed quality — never assumes "60 default" for unknown values.
//   • Maturity ramp keyed on `daysSinceAnchor` (calendar time), not
//     fast_count — cramming 30 fasts in 3 days can't fake-mature.
//   • Future-dated sessions NEVER counted in "what happened".
//   • Metabolic stage anchors cite primary sources only (de Cabo &
//     Mattson NEJM 2019; Anton 2018 Obesity; Hartman & Veldhuis JCEM
//     1992). NO claims like "BHB peaks at hour 18" — popular-press
//     extrapolation, not in the papers.
// ════════════════════════════════════════════════════════════════

const TARGET_DEPTH_HOURS = 16;  // start of fat-burn zone (Anton 2018)

// ─── METABOLIC STAGE TABLE (single source of truth, BE + FE) ─────
// `from` inclusive, `to` exclusive. Citations verified web-side 2026-05-23.
// Where claims would exceed what the primary sources actually say, the
// citation is left null (e.g. "fed" stage has no IF-specific citation).
const METABOLIC_STAGES = Object.freeze([
  { from: 0,  to: 4,        key: 'fed',                label: 'Fed',                citation: null },
  { from: 4,  to: 12,       key: 'glycogen_depleting', label: 'Glycogen depleting', citation: 'de Cabo & Mattson 2019' },
  { from: 12, to: 16,       key: 'fat_mobilizing',     label: 'Fat mobilizing',     citation: 'de Cabo & Mattson 2019' },
  { from: 16, to: 24,       key: 'ketogenesis',        label: 'Ketogenesis ramp',   citation: 'Anton 2018' },
  { from: 24, to: 36,       key: 'switch_complete',    label: 'Metabolic switch',   citation: 'Anton 2018 (12-36h band)' },
  { from: 36, to: Infinity, key: 'gh_surge',           label: 'GH surge zone',      citation: 'Hartman & Veldhuis 1992' },
]);

/**
 * Returns the stage object for a given elapsed-hours value. Returns null
 * for negative input. Inclusive on `from`, exclusive on `to`.
 */
function metabolicStageAtHour(hours) {
  if (!Number.isFinite(hours) || hours < 0) return null;
  for (const s of METABOLIC_STAGES) {
    if (hours >= s.from && hours < s.to) return s;
  }
  return METABOLIC_STAGES[METABOLIC_STAGES.length - 1];
}

/**
 * Stage that this session ENDED in (deepest stage reached). Returns null
 * if the session has no `actual_hours` (incomplete data).
 */
function sessionDeepestStage(session) {
  if (!session || !Number.isFinite(session.actual_hours)) return null;
  return metabolicStageAtHour(session.actual_hours);
}

/**
 * Per-session quality 0-100. Mirrors fitness deriveSessionQuality.
 *
 *   completion (40%):  actual / target, capped at 100
 *   depth      (30%):  actual_hours / depth_target_hours (16h default),
 *                      capped at 100 (going past 16h is good but doesn't
 *                      get rewarded forever — diminishing returns)
 *   cleanness  (20%):  100 if completed and not broken_early; 0 if broken
 *   refeed     (10%):  100 unless the session is ≥24h AND we have evidence
 *                      that refeed was poor (broken_reason='ate_too_fast'
 *                      or session.refeed_quality === 'poor'); falls back
 *                      to 80 if neutral / unknown
 *
 * Sessions with no `actual_hours` return null (can't score what we don't have).
 */
function deriveFastQuality(session, { protocol_target_hours, depth_target_hours = TARGET_DEPTH_HOURS } = {}) {
  if (!session || !Number.isFinite(session.actual_hours)) return null;

  const actual = Math.max(0, session.actual_hours);
  const target = Math.max(1, protocol_target_hours || session.target_hours || 16);

  const completionPct = Math.max(0, Math.min(100, (actual / target) * 100));
  const depthPct      = Math.max(0, Math.min(100, (actual / Math.max(depth_target_hours, 1)) * 100));
  const clean         = session.broken_early ? 0 : (session.completed ? 100 : 50);
  let refeed = 80;  // neutral default
  if (actual >= 24) {
    if (session.refeed_quality === 'poor' || session.broken_reason === 'ate_too_fast') refeed = 20;
    else if (session.refeed_quality === 'good') refeed = 100;
  } else {
    refeed = 100;  // refeed coaching only matters on long fasts
  }

  const raw = completionPct * 0.40 + depthPct * 0.30 + clean * 0.20 + refeed * 0.10;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/**
 * Maturity ramp — IDENTICAL curve to fitness. Calendar-day keyed.
 * Day-1 caps at 0.40; full maturity at day 60.
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
 * Drop sessions whose `date` (YYYY-MM-DD) is strictly after today's date.
 * Sessions with no `date` field pass through (legacy data).
 */
function dropFutureSessions(sessions, todayDateStr) {
  if (!todayDateStr) return (sessions || []).slice();
  return (sessions || []).filter((s) => !s?.date || s.date <= todayDateStr);
}

/**
 * Per-day quality map keyed by YYYY-MM-DD. For each calendar day from
 * `anchorDate` → `todayDate`, the value is the MAX quality of any
 * session ending that day (a clean 18h fast wins over a broken 4h fast
 * on the same day). Days with no completed session get value `null`
 * (NOT 0 — distinguishes "rest day" from "no log").
 */
function buildDayQualityByDate(sessions, anchorDate, todayDate) {
  const out = {};
  if (!anchorDate || !todayDate || anchorDate > todayDate) return out;

  // Initialize every calendar day to null
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

  for (const s of (sessions || [])) {
    if (!s?.date) continue;
    if (s.date < anchorDate || s.date > todayDate) continue;
    const q = deriveFastQuality(s, { protocol_target_hours: s.target_hours });
    if (q == null) continue;
    if (out[s.date] == null || q > out[s.date]) out[s.date] = q;
  }
  return out;
}

/**
 * Banister-equivalent FastingForm. Walks every CALENDAR day in
 * [startDateStr … todayDateStr], EMA-ing daily impulse so rest days
 * naturally decay both CTL and ATL.
 *
 * Daily impulse = `actual_hours` of any session that ENDED that day,
 * minus a depth bonus (longer fasts have proportionally larger stress
 * load on the body — same principle as RPE-weighting in fitness).
 *
 * Band ramp tuned for FASTING magnitudes (not fitness volumes):
 *   ratio < 0.65 → undermatured (just starting / very light)
 *   ratio < 0.85 → building
 *   ratio < 1.05 → consistent
 *   ratio < 1.25 → aggressive (lots of long fasts recently)
 *   ratio ≥ 1.25 → overreaching (rest)
 *
 * Output mirrors fitness.computeBanister shape:
 *   { ctl_hours, atl_hours, tsb, ratio, readiness, band, explain }
 */
function computeFastingForm({ sessions = [], priorSessions = [], startDateStr, todayDateStr }) {
  if (!startDateStr || !todayDateStr || startDateStr > todayDateStr) {
    return { ctl_hours: 0, atl_hours: 0, tsb: 0, ratio: 1, readiness: 50, band: 'consistent', explain: '' };
  }

  const impByDate = {};
  for (const s of [...(priorSessions || []), ...(sessions || [])]) {
    if (!s?.date || !Number.isFinite(s.actual_hours)) continue;
    // Depth load: a 20h fast loads more than two 10h fasts (1.5× weight above 12h)
    const base = Math.max(0, s.actual_hours);
    const depthBoost = Math.max(0, s.actual_hours - 12) * 0.5;
    const imp = base + depthBoost;
    impByDate[s.date] = (impByDate[s.date] || 0) + imp;
  }

  let ctl = 0, atl = 0;
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
  // Readiness: 100 = fresh, 0 = overreached. Same shape as fitness.
  const readiness = Math.max(0, Math.min(100, Math.round(100 - (ratio - 0.7) * 100)));
  const band =
    ratio < 0.65 ? 'undermatured' :
    ratio < 0.85 ? 'building'     :
    ratio < 1.05 ? 'consistent'   :
    ratio < 1.25 ? 'aggressive'   :
                   'overreaching';
  const explain =
    band === 'undermatured' ? 'Just starting out. Build the habit — a few easy fasts before pushing.' :
    band === 'building'     ? 'You\'re ramping up. Solid base forming.'                                :
    band === 'consistent'   ? 'Sustainable rhythm. This is the productive zone.'                       :
    band === 'aggressive'   ? 'Pushing hard. One easier day this week keeps you here.'                 :
                              'Heavy load recently. Take 2–3 lighter days. Hydrate, sleep, refeed well.';

  return {
    ctl_hours: +ctl.toFixed(1),
    atl_hours: +atl.toFixed(1),
    tsb: +tsb.toFixed(1),
    ratio: +ratio.toFixed(3),
    readiness,
    band,
    explain,
  };
}

/**
 * vs-prior-period delta. Compares current window aggregates to the
 * equal-length prior window. Returns null when no prior data exists
 * (don't lie about a zero baseline).
 */
function derivePriorPeriod({ priorSessions, currentTotalHours, currentDaysLogged, currentDepthCount, currentBrokenCount }) {
  if (!priorSessions?.length) return null;
  const pHours = priorSessions.reduce((a, s) => a + (Number.isFinite(s.actual_hours) ? s.actual_hours : 0), 0);
  const pDays = new Set(priorSessions.map(s => s.date).filter(Boolean)).size;
  const pDepth = priorSessions.filter(s => (s.actual_hours || 0) >= TARGET_DEPTH_HOURS).length;
  const pBroken = priorSessions.filter(s => s.broken_early).length;
  const pct = (curr, prev) => prev > 0 ? Math.round(((curr - prev) / prev) * 100) : null;
  // Completion %: completed / total, expressed as percentage points delta
  const priorCompletionPct = priorSessions.length > 0
    ? (priorSessions.filter(s => s.completed).length / priorSessions.length) * 100
    : 0;
  return {
    days_logged: pDays,
    total_hours: Math.round(pHours * 10) / 10,
    depth_hits: pDepth,
    broken_count: pBroken,
    prior_completion_pct: Math.round(priorCompletionPct),
    delta_hours_pct: pct(currentTotalHours, pHours),
    delta_completion_pct: null,  // caller can fill once they know current completion %
    delta_depth_abs: (currentDepthCount || 0) - pDepth,
    delta_broken_abs: (currentBrokenCount || 0) - pBroken,
  };
}

/**
 * Metabolic-tier mix — distribution of completed sessions across the
 * deepest stage they reached. Fitness analog: deriveEffortMix.
 *   `working` = sessions reaching ≥ fat_mobilizing (16h+)
 */
function deriveDepthMix(sessions) {
  const buckets = { fed: 0, glycogen: 0, fat: 0, ketone: 0, deep: 0 };
  const completed = (sessions || []).filter(s => Number.isFinite(s.actual_hours) && s.actual_hours > 0);

  for (const s of completed) {
    const h = s.actual_hours;
    if (h < 4)       buckets.fed++;
    else if (h < 12) buckets.glycogen++;
    else if (h < 16) buckets.fat++;
    else if (h < 24) buckets.ketone++;
    else             buckets.deep++;
  }

  const total_n = completed.length;
  if (total_n === 0) {
    return { fed_pct: 0, glycogen_pct: 0, fat_pct: 0, ketone_pct: 0, deep_pct: 0, working_n: 0, total_n: 0 };
  }
  const pct = (n) => Math.round((n / total_n) * 100);
  return {
    fed_pct:      pct(buckets.fed),
    glycogen_pct: pct(buckets.glycogen),
    fat_pct:      pct(buckets.fat),
    ketone_pct:   pct(buckets.ketone),
    deep_pct:     pct(buckets.deep),
    working_n:    buckets.fat + buckets.ketone + buckets.deep,
    total_n,
  };
}

// ─── Hour helpers ────────────────────────────────────────────────
function _getMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v?.toMillis === 'function') return v.toMillis();
  if (typeof v?.toDate === 'function') return v.toDate().getTime();
  const p = new Date(v).getTime();
  return Number.isFinite(p) ? p : null;
}

function _localHour(ms, utcOffsetMinutes) {
  if (ms == null) return null;
  const off = Number.isFinite(utcOffsetMinutes) ? utcOffsetMinutes : 0;
  const local = new Date(ms + off * 60_000);
  return local.getUTCHours() + local.getUTCMinutes() / 60;
}

/**
 * Eating-window stability over a list of sessions. Looks at:
 *   median_start_hour — when fasts begin (the FE typically = "end of
 *                       eating window" = bed time / last meal)
 *   median_end_hour   — when fasts end (= morning eating window start)
 *   std_*             — standard deviation in hours
 *   drift_flag        — true if either std > 1.5h (90 min)
 *
 * TZ-aware: requires utcOffsetMinutes from anchor doc.
 */
function deriveWindowStability(sessions, spanDays = 0, utcOffsetMinutes = 0) {
  const starts = [], ends = [];
  for (const s of (sessions || [])) {
    const sm = _getMs(s.started_at);
    const em = _getMs(s.ended_at);
    const sh = _localHour(sm, utcOffsetMinutes);
    const eh = _localHour(em, utcOffsetMinutes);
    if (sh != null) starts.push(sh);
    if (eh != null) ends.push(eh);
  }
  if (starts.length < 3 || ends.length < 3) {
    return {
      median_start_hour: null,
      median_end_hour: null,
      std_start_hours: null,
      std_end_hours: null,
      drift_flag: false,
      sample_n: Math.min(starts.length, ends.length),
    };
  }
  const median = (arr) => {
    const s = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  const std = (arr) => {
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    const v = arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length;
    return Math.sqrt(v);
  };
  const stdStart = std(starts);
  const stdEnd   = std(ends);
  return {
    median_start_hour: +median(starts).toFixed(2),
    median_end_hour:   +median(ends).toFixed(2),
    std_start_hours:   +stdStart.toFixed(2),
    std_end_hours:     +stdEnd.toFixed(2),
    drift_flag:        stdStart > 1.5 || stdEnd > 1.5,
    sample_n:          Math.min(starts.length, ends.length),
  };
}

/**
 * Protocol variety — counts unique protocols used, and flags
 * `stagnant` when the dominant protocol covers ≥90% of completed
 * fasts AND the window is ≥28 days (so a 7-day cherry pick doesn't
 * false-alarm). Closest user-visible cousin: BodyFast's "habituation"
 * framing — but ours fires on real data, not a calendar.
 */
function deriveProtocolVariety(sessions, spanDays = 0) {
  const completed = (sessions || []).filter(s => s.completed);
  const counts = {};
  for (const s of completed) {
    const p = s.protocol || 'unknown';
    counts[p] = (counts[p] || 0) + 1;
  }
  const total = completed.length;
  if (total === 0) {
    return { unique_protocols: 0, dominant_protocol: null, dominant_pct: 0, stagnant: false };
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const dominant = sorted[0];
  const dominant_pct = Math.round((dominant[1] / total) * 100);
  return {
    unique_protocols: sorted.length,
    dominant_protocol: dominant[0],
    dominant_pct,
    stagnant: spanDays >= 28 && dominant_pct >= 90,
  };
}

/**
 * 7×24 grid (DOW × hour) of fast STARTS. TZ-corrected via utcOffsetMinutes.
 * Mirrors fitness deriveHourGrid.
 */
function deriveStartHourGrid(sessions, utcOffsetMinutes = 0) {
  const out = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const off = Number.isFinite(utcOffsetMinutes) ? utcOffsetMinutes : 0;
  for (const s of (sessions || [])) {
    const ms = _getMs(s.started_at);
    if (ms == null) continue;
    const local = new Date(ms + off * 60_000);
    const dow = local.getUTCDay();
    const hour = local.getUTCHours();
    if (dow >= 0 && dow < 7 && hour >= 0 && hour < 24) {
      out[dow][hour] += 1;
    }
  }
  return out;
}

/**
 * GitHub-style contribution map — 365 cells spanning anchor → anchor+364.
 *
 *   level 0 — no fast logged
 *   level 1 — broken / <10h
 *   level 2 — 10-16h completed
 *   level 3 — ≥16h clean (fat-burn zone reached)
 *
 * MOAT (P5, 2026-05-24): when `dayDeepestHoursByDate` is provided, each
 * cell ALSO carries `deepest_stage_level` 0–6 encoding the deepest
 * metabolic stage the user reached that day. No other IF app ships this.
 *   stage 0 — no fast
 *   stage 1 — fed       (>0h, <4h)
 *   stage 2 — glycogen  (4–12h)
 *   stage 3 — fat-burn  (12–16h)
 *   stage 4 — ketones   (16–18h)
 *   stage 5 — autophagy (18–24h)
 *   stage 6 — deep      (24h+)
 */
function _stageLevelForHours(h) {
  if (!Number.isFinite(h) || h <= 0) return 0;
  if (h < 4)  return 1;
  if (h < 12) return 2;
  if (h < 16) return 3;
  if (h < 18) return 4;
  if (h < 24) return 5;
  return 6;
}

function deriveContributionMap({
  dayQualityByDate = {},
  dayDeepestHoursByDate = null,
  anchorDate,
  todayDate,
  spanDays = 365,
}) {
  const cells = [];
  if (!todayDate) {
    return { cells: [], summary: { logged_days: 0, missed_days: 0, span_days: 0, total_cells: 0 } };
  }

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
    if (Number.isFinite(q)) {
      if (q >= 75)      level = 3;
      else if (q >= 55) level = 2;
      else              level = 1;
    }
    const future = ds > todayDate;
    const cell = { date: ds, level, pre_anchor: false, future };
    if (dayDeepestHoursByDate) {
      cell.deepest_hours = Number.isFinite(dayDeepestHoursByDate[ds]) ? dayDeepestHoursByDate[ds] : 0;
      cell.deepest_stage_level = _stageLevelForHours(cell.deepest_hours);
    }
    cells.push(cell);
    cur += 86_400_000;
  }

  const logged_days  = cells.filter(c => c.level > 0).length;
  const active_cells = cells.filter(c => !c.future).length;
  return {
    cells,
    summary: {
      logged_days,
      missed_days: Math.max(0, active_cells - logged_days),
      span_days: active_cells,
      total_cells: cells.length,
    },
  };
}

/**
 * Habituation detector — walks back from the latest week; ≥3 weeks of
 * flat avg-fast-hours (delta_pct in [-2, +2]) = stalled. Input is a
 * parallel pair: `avgFastHoursByWeek` (newest last) over `weeks` window.
 */
function deriveHabituation({ avgFastHoursByWeek, weeks = 12 }) {
  if (!Array.isArray(avgFastHoursByWeek) || avgFastHoursByWeek.length < 4) {
    return { stalled: false, weeks_stalled: 0 };
  }
  const arr = avgFastHoursByWeek.slice(-weeks);
  const last = arr[arr.length - 1];
  let weeksStalled = 0;
  for (let i = arr.length - 2; i >= 0; i--) {
    const prev = arr[i];
    if (!Number.isFinite(prev) || prev <= 0) break;
    const deltaPct = ((last - prev) / prev) * 100;
    if (Math.abs(deltaPct) <= 2) {
      weeksStalled += 1;
    } else {
      break;
    }
  }
  return { stalled: weeksStalled >= 3, weeks_stalled: weeksStalled };
}

/**
 * Cleanness metrics over the window.
 *   avg_hours          — mean actual_hours across completed sessions
 *   broken_pct         — % of started fasts that broke early
 *   {reason}_break_pct — % of broken fasts by reason
 * Returns zeros for empty input (never null).
 */
function deriveCleanness(sessions) {
  const all = sessions || [];
  if (all.length === 0) {
    return {
      avg_hours: 0, broken_pct: 0,
      hunger_break_pct: 0, social_break_pct: 0, mood_break_pct: 0, energy_break_pct: 0,
    };
  }
  const completed = all.filter(s => Number.isFinite(s.actual_hours) && s.actual_hours > 0);
  const avg_hours = completed.length
    ? +(completed.reduce((a, s) => a + s.actual_hours, 0) / completed.length).toFixed(1)
    : 0;
  const broken = all.filter(s => s.broken_early);
  const broken_pct = Math.round((broken.length / all.length) * 100);
  const reasonPct = (key) => {
    const n = broken.filter(s => s.broken_reason === key).length;
    return broken.length ? Math.round((n / broken.length) * 100) : 0;
  };
  return {
    avg_hours,
    broken_pct,
    hunger_break_pct: reasonPct('hunger'),
    social_break_pct: reasonPct('social'),
    mood_break_pct:   reasonPct('mood'),
    energy_break_pct: reasonPct('energy'),
  };
}

/**
 * Hunger-wave detector — THE AHA enabler. Of broken fasts where the
 * user gave reason='hunger', what's the median hour they broke at?
 * Returns null when sample_n < 3 (don't surface noise as insight).
 */
function deriveHungerWaveHour(sessions) {
  const hungerBreaks = (sessions || [])
    .filter(s => s.broken_early && s.broken_reason === 'hunger' && Number.isFinite(s.actual_hours))
    .map(s => s.actual_hours)
    .sort((a, b) => a - b);
  if (hungerBreaks.length < 3) {
    return { wave_hour: null, sample_n: hungerBreaks.length };
  }
  const mid = Math.floor(hungerBreaks.length / 2);
  const wave_hour = hungerBreaks.length % 2
    ? hungerBreaks[mid]
    : (hungerBreaks[mid - 1] + hungerBreaks[mid]) / 2;
  return { wave_hour: +wave_hour.toFixed(1), sample_n: hungerBreaks.length };
}

module.exports = {
  // Constants
  TARGET_DEPTH_HOURS,
  METABOLIC_STAGES,

  // Single-session
  metabolicStageAtHour,
  sessionDeepestStage,
  deriveFastQuality,

  // Maturity + cleanup
  maturityRamp,
  dropFutureSessions,

  // Day-by-day
  buildDayQualityByDate,

  // Banister-equivalent
  computeFastingForm,

  // Period comparison
  derivePriorPeriod,

  // Mix + variety
  deriveDepthMix,
  deriveProtocolVariety,
  deriveWindowStability,

  // Grids + heatmaps
  deriveStartHourGrid,
  deriveContributionMap,

  // Trend
  deriveHabituation,

  // Cleanness + ahas
  deriveCleanness,
  deriveHungerWaveHour,
};
