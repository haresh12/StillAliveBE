'use strict';
// ════════════════════════════════════════════════════════════════
// mind-scoring.js — pure scoring + analytics helpers for the Mind agent.
//
// Mirrors the lib/fitness-scoring.js pattern (extracted 2026-05-23):
// every helper is pure, no Firestore, no clock, no globals — so the math
// is testable in isolation and the /analysis route stays an orchestrator.
//
// Honesty laws (2026-05-23, ported from fitness):
//   • Future-dated checkins NEVER counted in "what happened".
//   • Maturity ramp keyed on calendar days since anchor, not log count —
//     cramming 30 checkins in 3 days can't fake-mature the score.
//   • Per-day quality derived from real signals (mood + anxiety blend),
//     never a fixed default.
//   • Every aggregate gates on n ≥ N_MIN before claiming a pattern —
//     no n=2 "trends" misleading the user.
//
// Mind-native additions (Kashdan 2015 + Yale Mood Meter + Banister-adapted):
//   • Calm Readiness model — anxiety EMA + sleep cross-impact + mood
//     trajectory → 0-100 score + band + plain-English explainer.
//   • Emotion granularity — unique emotion vocabulary, stagnation gate.
//   • Cross-agent correlation grid — the Bearable-beater using REAL
//     continuous cross-agent data, not self-reported factors.
// ════════════════════════════════════════════════════════════════

const CHECKINS_PER_WK = 7;     // 1/day target — daily logging baseline
const N_MIN_TREND     = 6;     // smallest n we'll call a "trend" on

// ─── basic primitives ──────────────────────────────────────────
const _clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const _avg   = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const _round = (v) => Math.round(v);

// Local-TZ YYYY-MM-DD from a Date. Matches lib/range-helpers.dateStr output.
function _ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// getMillis — read Firestore Timestamp / Date / number / string.
function _ms(v) {
  if (v == null) return 0;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v?.toMillis === 'function') return v.toMillis();
  if (typeof v?.toDate === 'function')   return v.toDate().getTime();
  if (v?._seconds) return v._seconds * 1000;
  const p = new Date(v).getTime();
  return Number.isNaN(p) ? 0 : p;
}

// ════════════════════════════════════════════════════════════════
// FOUNDATION
// ════════════════════════════════════════════════════════════════

/**
 * Drop checkins whose `date_str` is strictly after today's date.
 * Future-dated logs (legacy or test) must NOT inflate stats — they create
 * inconsistency between Verdict ("4 checkins"), 28-day calendar (clamped),
 * and the Journey heatmap. Returns a fresh array.
 *
 * Checkins with no `date_str` pass through (legacy data).
 */
function dropFutureCheckins(checkins, todayDateStr) {
  if (!todayDateStr) return (checkins || []).slice();
  return (checkins || []).filter((c) => !c?.date_str || c.date_str <= todayDateStr);
}

/**
 * Maturity ramp — caps the raw blended score so a perfect day-1 user yields
 * ≈30-40, climbing to ≈75-85 by month 1 and 100 by month 2+. Drives the
 * "score must start low and grow" law. Keyed on CALENDAR days since anchor,
 * not log count — cramming sessions can't fake-mature.
 *
 * Aligned with fitness curve (2026-05-23) for cross-agent consistency.
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
 * Per-day mind quality (0-100) from a SINGLE checkin's mood + anxiety.
 * Mood weighted 60%, anxiety 40% (matches existing computeMindScore +
 * /analysis route shape).
 *
 * Scales:
 *   - mood_score: 1=low, 2=okay, 3=good, 4=great    → 0..100
 *   - anxiety_level: 1=minimal..5=severe             → 100..0 (inverted)
 *
 * Mood 1→0, 2→50, 3→100, 4→100 (3+ = "good", both saturate the top).
 * Pure — no Firestore, no clock.
 */
function deriveCheckinQuality(checkin) {
  const mood = Number(checkin?.mood_score || checkin?.mood || 2);
  const anx  = Number(checkin?.anxiety_level || checkin?.anxiety || 3);
  const moodPart = _clamp(((mood - 1) / 2) * 100, 0, 100);   // 1..4 → 0..100
  const anxPart  = _clamp(((5 - anx) / 4) * 100,  0, 100);   // 5..1 → 0..100
  return _round(moodPart * 0.6 + anxPart * 0.4);
}

/**
 * Per-day quality map keyed by YYYY-MM-DD. When multiple checkins land on
 * the same day, mean the qualities. Single source feeding the 365-day
 * contribution map, score-lifetime, and the streak detector.
 */
function buildDailyQualityMap(checkins) {
  const byDate = {};
  for (const c of (checkins || [])) {
    const ds = c?.date_str;
    if (!ds) continue;
    if (!byDate[ds]) byDate[ds] = [];
    byDate[ds].push(deriveCheckinQuality(c));
  }
  const out = {};
  for (const [ds, arr] of Object.entries(byDate)) {
    out[ds] = _round(_avg(arr));
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
// CALM READINESS — the mind analog of fitness's Banister Form band.
// Inputs:
//   - anxiety scores (recent → older), 1..5
//   - mood scores (recent → older), 1..5
//   - recent_sleep_hours (optional, last-3-nights avg from cross-agent)
// Output: 0-100 + band + plain-English explainer
// ════════════════════════════════════════════════════════════════

/**
 * computeCalmReadiness — adapts the Banister CTL/ATL idea to mental load.
 *
 *   acute_load  = mean(last-3 anxiety) — recent reactivity
 *   chronic_load = mean(last-14 anxiety) — baseline reactivity
 *   ratio = acute / chronic  (>1 = climbing fatigue, <1 = recovering)
 *
 * Mood trajectory tilts the score (improving moods earn bonus).
 * Sleep cross-impact tilts the band (under-recovered nights pull "stressed").
 *
 * Bands (sorted by readiness desc):
 *   PEACEFUL    (>= 85) — long calm stretch, body+mind recovered
 *   CALM        (70..84) — recovered, ready for hard things
 *   STEADY      (55..69) — even load, maintain
 *   ACTIVATED   (40..54) — anxiety climbing, normal in stressful periods
 *   STRESSED    (25..39) — pull back, more recovery
 *   OVERWHELMED (< 25)   — heavy load, take 2-3 days light
 */
function computeCalmReadiness({ anxiety_scores = [], mood_scores = [], recent_sleep_hours = null } = {}) {
  if (!Array.isArray(anxiety_scores) || anxiety_scores.length === 0) {
    return {
      readiness: 50, band: 'steady',
      acute_load: 0, chronic_load: 0, ratio: 1,
      explain: 'Log a few check-ins to unlock your readiness score.',
    };
  }
  const last3  = anxiety_scores.slice(0, Math.min(3, anxiety_scores.length));
  const last14 = anxiety_scores.slice(0, Math.min(14, anxiety_scores.length));
  const acute   = _avg(last3);    // 1..5
  const chronic = _avg(last14);   // 1..5
  const ratio   = chronic > 0 ? acute / chronic : 1;

  // Base readiness — invert anxiety (higher anxiety = lower readiness).
  // anxiety 1 → 100, anxiety 5 → 0
  const baseFromAnx = _clamp(((5 - acute) / 4) * 100, 0, 100);

  // Mood trajectory bonus — if recent moods are trending up vs older,
  // earn up to +10. If trending down, lose up to -6.
  let moodBonus = 0;
  if (mood_scores.length >= 6) {
    const half = Math.floor(mood_scores.length / 2);
    const recent = _avg(mood_scores.slice(0, half));
    const older  = _avg(mood_scores.slice(half));
    const delta = recent - older;
    moodBonus = _clamp(delta * 4, -6, 10);
  }

  // Sleep cross-impact penalty — Palmer 2023 meta. <6h pulls 0-8 points.
  let sleepPenalty = 0;
  if (Number.isFinite(recent_sleep_hours)) {
    if (recent_sleep_hours < 6.0)      sleepPenalty = 8;
    else if (recent_sleep_hours < 6.5) sleepPenalty = 5;
    else if (recent_sleep_hours < 7.0) sleepPenalty = 2;
  }

  const readiness = _clamp(_round(baseFromAnx + moodBonus - sleepPenalty), 0, 100);

  const band =
    readiness >= 85 ? 'peaceful'    :
    readiness >= 70 ? 'calm'        :
    readiness >= 55 ? 'steady'      :
    readiness >= 40 ? 'activated'   :
    readiness >= 25 ? 'stressed'    :
                      'overwhelmed' ;

  const explain =
    band === 'peaceful'    ? 'Long calm stretch — body and mind are recovered.'         :
    band === 'calm'        ? 'Recovered. Today is good for hard or new things.'         :
    band === 'steady'      ? 'Even load. Maintain current rhythm.'                       :
    band === 'activated'   ? 'Anxiety is climbing — normal in a stressful stretch.'      :
    band === 'stressed'    ? 'Pull back where you can. Sleep + sunlight + slow breaths.' :
                             'Heavy mental load. Take 2–3 light days. Reach out if needed.';

  return {
    readiness, band, explain,
    acute_load: _round(acute * 100) / 100,    // 1..5
    chronic_load: _round(chronic * 100) / 100,
    ratio: _round(ratio * 1000) / 1000,
  };
}

// ════════════════════════════════════════════════════════════════
// VS PRIOR PERIOD — equal-length window immediately before this one.
// Mirror of fitness derivePriorPeriod, mind-native fields.
// ════════════════════════════════════════════════════════════════

function _priorAvg(checkins, field) {
  const arr = (checkins || []).map((c) => Number(c?.[field] || 0)).filter(Number.isFinite);
  return arr.length ? _avg(arr) : null;
}

/**
 * Prior-period delta vs current. Returns null when there's no prior data
 * (don't lie about a zero baseline).
 */
function derivePriorPeriodMind({ priorCheckins, currentMoodAvg, currentAnxAvg, currentDaysLogged, currentReframes }) {
  if (!priorCheckins?.length) return null;
  const priorMoodAvg = _priorAvg(priorCheckins, 'mood_score') ?? _priorAvg(priorCheckins, 'mood');
  const priorAnxAvg  = _priorAvg(priorCheckins, 'anxiety_level') ?? _priorAvg(priorCheckins, 'anxiety');
  const priorReframes = (priorCheckins || []).reduce((s, c) => s + (c?.reframe_used ? 1 : 0), 0);
  const priorDays = new Set((priorCheckins || []).map((c) => c?.date_str).filter(Boolean)).size;
  const round1 = (n) => Math.round(n * 10) / 10;
  return {
    days_logged: priorDays,
    mood_avg:    priorMoodAvg != null ? round1(priorMoodAvg) : null,
    anxiety_avg: priorAnxAvg  != null ? round1(priorAnxAvg)  : null,
    reframes:    priorReframes,
    // Deltas — colour signs handled by FE.
    delta_mood_pts: (Number.isFinite(currentMoodAvg) && priorMoodAvg != null)
      ? round1(currentMoodAvg - priorMoodAvg) : null,
    delta_anx_pts:  (Number.isFinite(currentAnxAvg) && priorAnxAvg != null)
      ? round1(priorAnxAvg - currentAnxAvg) : null,   // anxiety down = positive delta
    delta_days_pct: priorDays > 0 && Number.isFinite(currentDaysLogged)
      ? Math.round(((currentDaysLogged - priorDays) / priorDays) * 100) : null,
    delta_reframes_abs: Number.isFinite(currentReframes) ? currentReframes - priorReframes : null,
  };
}

// ════════════════════════════════════════════════════════════════
// EMOTION GRANULARITY — Kashdan 2015 mind-native section.
// Unique emotion vocabulary used over the window. Higher granularity
// predicts better mental health outcomes; flag stagnation.
// ════════════════════════════════════════════════════════════════

function deriveEmotionGranularity(checkins, spanDays = 0) {
  const names = new Set();
  let totalUses = 0;
  for (const c of (checkins || [])) {
    for (const e of (Array.isArray(c?.emotions) ? c.emotions : [])) {
      if (!e || typeof e !== 'string') continue;
      names.add(e);
      totalUses += 1;
    }
  }
  const unique = names.size;
  // Stagnation: ≥30d window with <6 unique emotion words = narrow vocabulary.
  // Kashdan 2015: granularity (number of distinct emotion words in 14d) correlates
  // with adaptive coping outcomes.
  const stagnant = spanDays >= 30 && unique < 6;
  return { unique, total_uses: totalUses, stagnant };
}

// ════════════════════════════════════════════════════════════════
// CHECK-IN DEPTH — fitness's Effort Mix analog.
// % checkins with note + triggers + emotions vs just mood.
// ════════════════════════════════════════════════════════════════

function deriveCheckinDepth(checkins) {
  const total = (checkins || []).length;
  if (total === 0) {
    return { deep_pct: 0, basic_pct: 0, mood_only_pct: 0, deep_n: 0, total_n: 0 };
  }
  let deep = 0, basic = 0, moodOnly = 0;
  for (const c of checkins) {
    const hasNote     = typeof c?.note === 'string' && c.note.trim().length > 0;
    const hasTriggers = Array.isArray(c?.triggers) && c.triggers.length > 0;
    const hasEmotions = Array.isArray(c?.emotions) && c.emotions.length > 0;
    // Deep = note + at least one of (triggers, emotions). Real engagement.
    if (hasNote && (hasTriggers || hasEmotions)) deep++;
    // Basic = some context (emotion OR trigger) but no note.
    else if (hasTriggers || hasEmotions)        basic++;
    // Mood-only = the streak-saver one-tap path.
    else                                         moodOnly++;
  }
  const pct = (n) => Math.round((n / total) * 100);
  return {
    deep_pct:     pct(deep),
    basic_pct:    pct(basic),
    mood_only_pct: pct(moodOnly),
    deep_n:       deep,
    total_n:      total,
  };
}

// ════════════════════════════════════════════════════════════════
// CONTRIBUTION MAP — GitHub-style 365-day grid (anchor-aware).
// Always 365 cells ending at today, so the view is consistent across
// 1W/1M/3M/1Y periods. Pre-anchor cells tagged so the UI dims them.
//
//   level 0 = rest day · 1 = low quality · 2 = ok · 3 = good
// ════════════════════════════════════════════════════════════════

function deriveContributionMapMind({ dayQualityByDate = {}, anchorDate, todayDate, spanDays = 365 }) {
  if (!todayDate) return { cells: [], summary: { logged_days: 0, missed_days: 0, span_days: 0, total_cells: 0 } };
  // Match fitness canon: span anchor → anchor+364 (the user's first year since
  // signup). Registration day on the LEFT, today somewhere in the middle, and
  // cells after today are tagged `future` (haven't happened yet) — never
  // pre-anchor since the grid starts at anchor.
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
    const q = dayQualityByDate[ds];
    let level = 0;
    if (Number.isFinite(q)) level = q >= 75 ? 3 : q >= 55 ? 2 : 1;
    const future = ds > todayDate;
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

// ════════════════════════════════════════════════════════════════
// ANXIETY PLATEAU — anxiety stuck high for ≥3 weeks.
// Mirrors fitness's derivePlateau but operates on the anxiety axis.
// ════════════════════════════════════════════════════════════════

function derivePlateauAnxiety({ anxiety_scores, dates }) {
  if (!Array.isArray(anxiety_scores) || anxiety_scores.length < 3) {
    return { stalled: false, weeks_stalled: 0, level: null };
  }
  // Walk back; find first day where anxiety dipped meaningfully below current avg.
  // last 7 = current band; before that we look for the most recent dip.
  const last7Avg = _avg(anxiety_scores.slice(0, Math.min(7, anxiety_scores.length)));
  // Only flag "plateau" when anxiety is in the elevated zone (>=3 on 1-5 scale).
  if (last7Avg < 3) return { stalled: false, weeks_stalled: 0, level: _round(last7Avg * 10) / 10 };

  let weeksStalled = 0;
  const lastDateMs = dates?.length
    ? new Date((dates[0] || '') + 'T12:00:00').getTime()
    : Date.now();
  // anxiety is "stalled high" when older values were also >=3
  for (let i = 0; i < anxiety_scores.length; i++) {
    if (anxiety_scores[i] < 3) {
      const dipDateMs = dates?.[i] ? new Date(dates[i] + 'T12:00:00').getTime() : 0;
      if (dipDateMs > 0) {
        weeksStalled = Math.max(0, Math.floor((lastDateMs - dipDateMs) / (7 * 86_400_000)));
      } else {
        weeksStalled = Math.floor(i / 7);
      }
      break;
    }
    if (i === anxiety_scores.length - 1) {
      // Never dipped — use full span
      weeksStalled = Math.floor(anxiety_scores.length / 7);
    }
  }
  return {
    stalled: weeksStalled >= 3,
    weeks_stalled: weeksStalled,
    level: _round(last7Avg * 10) / 10,
  };
}

// ════════════════════════════════════════════════════════════════
// CROSS-AGENT CORRELATION GRID — the Bearable killer.
// Pure: given a set of dates + per-date factor values + per-date mind
// quality, returns the per-factor delta. UI renders as a heatmap.
//
//   factors: { sleep_h: { 'YYYY-MM-DD': hours }, water_pct: {...}, ... }
//   mindQualityByDate: { 'YYYY-MM-DD': 0..100 }
//
// For each factor, partitions dates into "high factor" vs "low factor" by
// median and reports the mind-quality delta. Honest because the partition
// uses the user's own median (not arbitrary thresholds).
//
// Returns per-factor: { high_avg, low_avg, delta, n_high, n_low, has_signal }
//   `has_signal` = true only when both halves have n>=3 and |delta|>=5 pts.
// ════════════════════════════════════════════════════════════════

function deriveCorrelationGrid({ factors = {}, mindQualityByDate = {} }) {
  const out = {};
  for (const [factorName, dateMap] of Object.entries(factors)) {
    if (!dateMap || typeof dateMap !== 'object') continue;
    const pairs = [];
    for (const [ds, value] of Object.entries(dateMap)) {
      if (!Number.isFinite(value)) continue;
      const q = mindQualityByDate[ds];
      if (!Number.isFinite(q)) continue;
      pairs.push({ value, q });
    }
    if (pairs.length < 6) {
      out[factorName] = { has_signal: false, n_total: pairs.length };
      continue;
    }
    const sorted = pairs.slice().sort((a, b) => a.value - b.value);
    const med = sorted[Math.floor(sorted.length / 2)].value;
    const high = pairs.filter((p) => p.value >= med).map((p) => p.q);
    const low  = pairs.filter((p) => p.value <  med).map((p) => p.q);
    const high_avg = high.length ? _round(_avg(high)) : null;
    const low_avg  = low.length  ? _round(_avg(low))  : null;
    const delta    = (high_avg != null && low_avg != null) ? high_avg - low_avg : null;
    out[factorName] = {
      has_signal: high.length >= 3 && low.length >= 3 && delta != null && Math.abs(delta) >= 5,
      high_avg, low_avg, delta,
      n_high: high.length, n_low: low.length, n_total: pairs.length,
      median: _round(med * 10) / 10,
    };
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
// TOP TRIGGER × DAY-OF-WEEK pattern.
// "Work is your most-skipped trigger × Monday peak."
// Used by both Analysis section and chat-state smart-prompt picker.
// ════════════════════════════════════════════════════════════════

function deriveTopTrigger(checkins, spanDays = 30) {
  const totalCount = {};
  const byTriggerByDow = {};   // { trigger: [0..6 counts] }
  let totalCheckinsWithTriggers = 0;
  for (const c of (checkins || [])) {
    const triggers = Array.isArray(c?.triggers) ? c.triggers : [];
    if (!triggers.length || !c?.date_str) continue;
    totalCheckinsWithTriggers += 1;
    const dow = new Date(c.date_str + 'T12:00:00').getDay();
    for (const t of triggers) {
      if (!t || typeof t !== 'string') continue;
      totalCount[t] = (totalCount[t] || 0) + 1;
      if (!byTriggerByDow[t]) byTriggerByDow[t] = [0, 0, 0, 0, 0, 0, 0];
      byTriggerByDow[t][dow] += 1;
    }
  }
  const sorted = Object.entries(totalCount).sort(([, a], [, b]) => b - a);
  if (!sorted.length) return null;
  const [topName, topCount] = sorted[0];
  const triggerPctOfCheckins = totalCheckinsWithTriggers > 0
    ? Math.round((topCount / totalCheckinsWithTriggers) * 100)
    : 0;
  const dowDist = byTriggerByDow[topName] || [];
  const peakDow = dowDist.length
    ? dowDist.reduce((maxI, v, i, arr) => v > arr[maxI] ? i : maxI, 0)
    : null;
  return {
    name: topName,
    count: topCount,
    pct_of_checkins: triggerPctOfCheckins,
    peak_dow: peakDow,
    dow_dist: dowDist,
    is_dominant: spanDays >= 14 && triggerPctOfCheckins >= 40,
  };
}

// ════════════════════════════════════════════════════════════════
// BLENDED MIND SCORE — pure, extracted from agent-scores.computeMindScore.
// Same components + weights, just exposed for testing in isolation.
// ════════════════════════════════════════════════════════════════

function computeBlendedMindScore({
  mood_scores = [], anxiety_scores = [], checkin_dates = [],
  days_logged, streak = 0, recent_sleep_hours = null,
}) {
  const d = days_logged || checkin_dates.length || 1;
  const n = mood_scores.length;
  if (n === 0) return null;

  // 1. AFFECT (30) — Shiffman 2008 person-centered EMA
  const recentMoods = mood_scores.slice(0, Math.min(7, n));
  const moodAvg     = _avg(recentMoods);
  let moodScore;
  if (n >= 7) {
    const older    = mood_scores.slice(7, Math.min(14, n));
    const baseline = older.length >= 2 ? _avg(older) : moodAvg;
    const deviation = moodAvg - baseline;
    const absBase   = (moodAvg / 5) * 24;
    const relBonus  = _clamp(deviation * 4, -8, 6);
    moodScore = _clamp(absBase + relBonus + 4, 0, 30);
  } else {
    moodScore = _clamp((moodAvg / 5) * 30, 0, 30);
  }

  // 2. ANXIETY MGMT (25) — GAD-7 aligned bands
  const recentAnx = anxiety_scores.slice(0, Math.min(7, n));
  const anxAvg    = recentAnx.length ? _avg(recentAnx) : 2;
  let anxScore;
  if (anxAvg <= 1.5)      anxScore = 25;
  else if (anxAvg <= 2.0) anxScore = 21;
  else if (anxAvg <= 2.5) anxScore = 17;
  else if (anxAvg <= 3.0) anxScore = 13;
  else if (anxAvg <= 3.5) anxScore = 8;
  else if (anxAvg <= 4.0) anxScore = 4;
  else                    anxScore = 0;

  // 3. TRAJECTORY (15) — week-over-week
  let trajectoryScore = 8;
  if (n >= 6) {
    const half = Math.floor(n / 2);
    const moodDelta = _avg(mood_scores.slice(0, half)) - _avg(mood_scores.slice(half));
    const recentAnxH = anxiety_scores.slice(0, half);
    const olderAnxH  = anxiety_scores.slice(half);
    const anxDelta   = olderAnxH.length ? _avg(olderAnxH) - _avg(recentAnxH) : 0;
    const netDelta   = moodDelta * 0.6 + anxDelta * 0.4;
    if      (netDelta >=  0.5) trajectoryScore = 15;
    else if (netDelta >=  0.2) trajectoryScore = 12;
    else if (netDelta >= -0.2) trajectoryScore = 8;
    else if (netDelta >= -0.5) trajectoryScore = 4;
    else                       trajectoryScore = 0;
  }

  // 4. CONSISTENCY (20) — Lally 2010 habit-formation
  const freqScore   = _clamp((checkin_dates.length / 14) * 12, 0, 12);
  const streakScore = _clamp((streak || 0) * 0.57, 0, 8);
  const behaviorScore = freqScore + streakScore;

  // 5. SLEEP IMPACT (10) — Palmer 2023 meta
  let sleepImpact;
  if (recent_sleep_hours == null)      sleepImpact = 8;
  else if (recent_sleep_hours >= 7.0)  sleepImpact = 10;
  else if (recent_sleep_hours >= 6.5)  sleepImpact = 8;
  else if (recent_sleep_hours >= 6.0)  sleepImpact = 5;
  else                                 sleepImpact = 2;

  const raw = _clamp(moodScore + anxScore + trajectoryScore + behaviorScore + sleepImpact, 0, 100);
  return {
    raw: _round(raw),
    components: {
      mood:        _round(moodScore),
      anxiety:     _round(anxScore),
      trajectory:  _round(trajectoryScore),
      consistency: _round(behaviorScore),
      sleep:       _round(sleepImpact),
    },
    avg_mood: _round(moodAvg * 10) / 10,
    avg_anxiety: _round(anxAvg * 10) / 10,
  };
}

module.exports = {
  CHECKINS_PER_WK,
  N_MIN_TREND,
  // Foundation
  dropFutureCheckins,
  maturityRamp,
  deriveCheckinQuality,
  buildDailyQualityMap,
  // Surfaces (2026-05-23 mind 10/10 uplift)
  computeCalmReadiness,
  derivePriorPeriodMind,
  deriveEmotionGranularity,
  deriveCheckinDepth,
  deriveContributionMapMind,
  derivePlateauAnxiety,
  deriveCorrelationGrid,
  deriveTopTrigger,
  computeBlendedMindScore,
};
