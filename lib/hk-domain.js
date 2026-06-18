'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// hk-domain.js — P2: the Apple Health signals RELEVANT TO EACH DOMAIN.
//
// Maps the full hk-signals bundle → just the slice that matters for a given
// domain's analysis/coaching. Fused into the coach's get_analysis tool + the
// briefing deep-dive so every "how am I doing in X" answer reflects real body
// data. Additive + null-safe → manual-only users see nothing change (parity).
// ═══════════════════════════════════════════════════════════════════════════
const { getHealthSignals } = require('./hk-signals');
const { userDoc } = require('./collections');
const { resolveAnchor } = require('./user-anchor');
const { computeAnalysisWindow, enumerateDaysFrom } = require('./range-helpers');
const { attachDomainInsight } = require('./hk-insight');

const PICK = {
  fitness: (s) => ({ recovery: s.recovery, recovery_label: s.recovery_label, steps: s.steps, active_kcal: s.active_kcal_latest, workouts_7d: s.workouts7, resting_hr: s.rhr, vo2max: s.vo2max }),
  sleep: (s) => ({ sleep: s.sleep, recovery: s.recovery, recovery_label: s.recovery_label, resting_hr: s.rhr }),
  mind: (s) => ({ hrv: s.hrv, resting_hr: s.rhr, recovery: s.recovery, recovery_label: s.recovery_label }),
  nutrition: (s) => ({ active_kcal_out: s.active_kcal_latest, weight: s.weight, steps: s.steps }),
  water: (s) => ({ water_ml: s.water_latest_ml, active_kcal: s.active_kcal_latest, steps: s.steps }),
  fasting: (s) => ({ recovery: s.recovery, recovery_label: s.recovery_label, active_kcal: s.active_kcal_latest }),
};

// Strip null/empty so the payload only carries real signal.
function prune(o) {
  if (!o || typeof o !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (v == null) continue;
    if (typeof v === 'object') { const p = prune(v); if (p && Object.keys(p).length) out[k] = p; }
    else out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** The HK signals relevant to a domain, or null if no HK data / unknown domain. */
async function domainHealth(deviceId, domain) {
  const pick = PICK[domain];
  if (!pick) return null;
  const s = await getHealthSignals(deviceId).catch(() => null);
  if (!s) return null;
  return prune(pick(s));
}

// ═══════════════════════════════════════════════════════════════════════════
// domainHealthView — P2 redesign: the structured "Body Signals" payload for the
// per-coach Analysis section. Unlike domainHealth (a flat latest-slice for the
// coach text), this returns TODAY tiles framed vs the user's own baseline + a
// TREND series + "vs prior" — all clamped to the registration anchor, built from
// the daily rows we already store. Null when there's no data (no-wearable parity).
// ═══════════════════════════════════════════════════════════════════════════

const numEx = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const round = (v, d) => { const m = 10 ** d; return Math.round(v * m) / m; };

// Per-metric descriptor. `src` = health_samples doc key; `ex` = extract a number
// from a day's stored value; `better` steers the "vs your usual" framing (FE stays
// monochrome — it reads `good`/`better`, never colour). `cumulative` metrics only
// count as "today" when today itself has a value (no stale carry-over).
const M = {
  steps:            { label: 'Steps',         src: 'steps',             unit: '',        dec: 0, better: 'high',    cumulative: true,  ex: numEx },
  active_kcal:      { label: 'Active energy',  src: 'activeEnergy',      unit: 'kcal',    dec: 0, better: 'high',    cumulative: true,  ex: numEx },
  exercise_min:     { label: 'Exercise',       src: 'exerciseTime',      unit: 'min',     dec: 0, better: 'high',    cumulative: true,  ex: numEx },
  resting_hr:       { label: 'Resting HR',     src: 'restingHeartRate',  unit: 'bpm',     dec: 0, better: 'low',     cumulative: false, ex: numEx },
  hrv:              { label: 'HRV',            src: 'hrv',               unit: 'ms',      dec: 0, better: 'high',    cumulative: false, ex: numEx },
  respiratory:      { label: 'Respiratory',    src: 'respiratoryRate',   unit: 'br/min',  dec: 1, better: 'neutral', cumulative: false, ex: numEx },
  vo2max:           { label: 'VO₂ max',        src: 'vo2Max',            unit: '',        dec: 1, better: 'high',    cumulative: false, ex: numEx },
  weight:           { label: 'Weight',         src: 'weight',            unit: 'kg',      dec: 1, better: 'neutral', cumulative: false, ex: numEx },
  water:            { label: 'Water',          src: 'water',             unit: 'ml',      dec: 0, better: 'high',    cumulative: true,  ex: numEx },
  dietary_energy:   { label: 'Energy in',      src: 'dietaryEnergy',     unit: 'kcal',    dec: 0, better: 'neutral', cumulative: true,  ex: numEx },
  glucose:          { label: 'Glucose',        src: 'bloodGlucose',      unit: 'mg/dL',   dec: 0, better: 'neutral', cumulative: false, ex: numEx },
  sleep_hours:      { label: 'Time asleep',    src: 'sleep',             unit: 'h',       dec: 1, better: 'high',    cumulative: false, ex: (v) => (v && v.asleep_min ? v.asleep_min / 60 : null) },
  sleep_efficiency: { label: 'Efficiency',     src: 'sleep',             unit: '%',       dec: 0, better: 'high',    cumulative: false, ex: (v) => (v && v.efficiency != null ? v.efficiency : null) },
  workouts:         { label: 'Workouts',       src: 'workout',           unit: '',        dec: 0, better: 'high',    cumulative: true,  ex: (v) => (Array.isArray(v) ? v.length : null) },
};

// Ordered metric set per domain (sandbox-clean: each domain reads only its own slice).
const DOMAIN_METRICS = {
  fitness:   ['steps', 'active_kcal', 'exercise_min', 'workouts', 'resting_hr', 'vo2max'],
  sleep:     ['sleep_hours', 'sleep_efficiency', 'resting_hr'],
  mind:      ['hrv', 'resting_hr', 'respiratory'],
  nutrition: ['dietary_energy', 'active_kcal', 'weight'],
  water:     ['water', 'active_kcal'],
  fasting:   ['glucose', 'active_kcal'],
};

function extractSeries(dayMap, m, dates) {
  return dates.map((d) => {
    const raw = dayMap[d];
    const v = raw == null ? null : m.ex(raw);
    return typeof v === 'number' && isFinite(v) ? round(v, m.dec) : null;
  });
}

/**
 * Structured Body-Signals view for one domain. requestedDays drives the trend
 * window; the baseline always looks back ~30d (both anchor-clamped). Returns null
 * when the user has no relevant Apple Health / Health Connect data.
 */
async function domainHealthView(deviceId, domain, requestedDays) {
  const keys = DOMAIN_METRICS[domain];
  if (!keys) return null;

  const anchor = await resolveAnchor(deviceId).catch(() => null);
  const anchorMs = (anchor && anchor.anchorMs) || 0;
  const tz = (anchor && anchor.utcOffsetMinutes) || 0;
  const now = Date.now();
  const win = computeAnalysisWindow(requestedDays || 30, anchorMs, now, tz);
  const baseWin = computeAnalysisWindow(30, anchorMs, now, tz);

  // Read each distinct source doc once (several metrics can share a doc, e.g. sleep).
  const srcs = [...new Set(keys.map((k) => M[k].src))];
  const col = userDoc(deviceId).collection('health_samples');
  const dayMaps = {};
  await Promise.all(
    srcs.map(async (s) => {
      try { const snap = await col.doc(s).get(); dayMaps[s] = (snap.exists && snap.data().days) || {}; }
      catch { dayMaps[s] = {}; }
    }),
  );

  const windowDates = enumerateDaysFrom(win.effectiveStartDate, win.todayDate);
  const baseDates = enumerateDaysFrom(baseWin.effectiveStartDate, baseWin.todayDate).filter((d) => d !== win.todayDate);
  // Prior equal-length window (immediately before the requested one) for "vs prior".
  const priorWin = computeAnalysisWindow(win.effectiveDays, anchorMs, win.cutoffMs - 86_400_000, tz);
  const priorDates = enumerateDaysFrom(priorWin.effectiveStartDate, priorWin.todayDate);

  const today = [];
  const trend = [];

  for (const key of keys) {
    const m = M[key];
    const days = dayMaps[m.src] || {};
    const series = extractSeries(days, m, windowDates);
    const present = series.filter((v) => v != null);

    // ── Baseline ("your usual") over up to 30 prior days ──
    const baseVals = extractSeries(days, m, baseDates).filter((v) => v != null);
    const baseline = baseVals.length >= 3 ? round(avg(baseVals), m.dec) : null;

    // ── Today value ──
    const todayRaw = days[win.todayDate];
    const todayEx = todayRaw == null ? null : m.ex(todayRaw);
    let todayVal = typeof todayEx === 'number' && isFinite(todayEx) ? round(todayEx, m.dec) : null;
    if (todayVal == null && !m.cumulative) {
      for (let i = series.length - 1; i >= 0; i--) { if (series[i] != null) { todayVal = series[i]; break; } }
    }

    if (todayVal != null) {
      let good = null;
      let delta_label = null;
      if (baseline != null) {
        const eps = Math.abs(baseline) * 0.05;
        if (Math.abs(todayVal - baseline) <= eps) {
          delta_label = m.better === 'neutral' ? 'steady' : 'on par';
        } else {
          const higher = todayVal > baseline;
          if (m.better === 'neutral') delta_label = higher ? 'up' : 'down';
          else { good = m.better === 'high' ? higher : !higher; delta_label = higher ? 'above your usual' : 'below your usual'; }
        }
      }
      today.push({ key, label: m.label, value: todayVal, unit: m.unit, decimals: m.dec, baseline, good, delta_label, better: m.better });
    }

    // ── Trend (needs ≥2 points in the window) ──
    if (present.length >= 2) {
      const a = round(avg(present), m.dec);
      const priorVals = extractSeries(days, m, priorDates).filter((v) => v != null);
      const prior_avg = priorVals.length >= 2 ? round(avg(priorVals), m.dec) : null;
      let vs_prior_pct = null;
      let vs_prior_label = null;
      if (prior_avg != null && prior_avg !== 0) {
        vs_prior_pct = Math.round(((a - prior_avg) / Math.abs(prior_avg)) * 100);
        if (Math.abs(vs_prior_pct) < 2) vs_prior_label = 'about the same';
        else vs_prior_label = `${Math.abs(vs_prior_pct)}% ${a > prior_avg ? 'higher' : 'lower'} than before`;
      }
      trend.push({ key, label: m.label, unit: m.unit, decimals: m.dec, better: m.better, series, avg: a, prior_avg, vs_prior_pct, vs_prior_label });
    }
  }

  if (!today.length && !trend.length) return null;

  // De-identified summary → cached daily insight (NEVER sends deviceId/name to the LLM).
  let insight = null;
  const summary = {
    today: today.map((t) => ({ metric: t.label, value: t.value, unit: t.unit, baseline: t.baseline, vs_usual: t.delta_label })),
    trend: trend.map((t) => ({ metric: t.label, avg: t.avg, unit: t.unit, vs_prior: t.vs_prior_label })),
  };
  try { insight = await attachDomainInsight(deviceId, domain, summary, win.todayDate); } catch { insight = null; }

  return {
    today,
    trend,
    insight,
    meta: {
      effective_days: win.effectiveDays,
      effective_start_date: win.effectiveStartDate,
      today_date: win.todayDate,
      anchor_date: (anchor && anchor.anchorDateStr) || null,
      is_clamped: win.isClamped,
      requested_days: win.requestedDays,
    },
  };
}

// ── Coach-facing natural-language block (deterministic, no LLM → zero hot-path latency cost beyond
//    the Firestore reads). Domain-scoped + anomaly-framed so the chat/voice coach can weave real body
//    data in naturally. Empty string for no-wearable users (parity). ──
function unitTxt(v, dec, unit) {
  const n = v.toLocaleString(undefined, { maximumFractionDigits: dec });
  if (unit === '%') return `${n}%`;
  if (unit === 'h') return `${n}h`;
  if (unit === '') return n;
  return `${n} ${unit}`;
}

async function domainHealthText(deviceId, domain) {
  const v = await domainHealthView(deviceId, domain, 7).catch(() => null);
  if (!v) return '';
  const L = [];
  for (const t of v.today) {
    let line = `${t.label} ${unitTxt(t.value, t.decimals, t.unit)}`;
    if (t.delta_label && t.baseline != null) line += ` — ${t.delta_label} (~${unitTxt(t.baseline, t.decimals, t.unit)})`;
    L.push(line);
  }
  const tr = v.trend.find((x) => x.vs_prior_label && x.vs_prior_label !== 'about the same');
  if (tr) L.push(`${tr.label} this week is ${tr.vs_prior_label}.`);
  if (!L.length) return '';
  return `\nAPPLE HEALTH (their own measured body data — weave in naturally, never say "from your watch" or "Apple Health"):\n  ${L.slice(0, 5).join('\n  ')}`;
}

// ── Scoring fusion: a per-day 0–100 quality map derived from Apple Health, so an active or
//    measured day COUNTS toward the score even when the user logged nothing manually. Merged into the
//    agent's qualityByDate with MAX (a logged day is never lowered). Anchor-clamped. Empty map for
//    no-wearable users → byte-identical scores (parity). Conservative by design: HK-only days lift but
//    don't max out (a logged/intentional day stays "better"). Only fitness + sleep — the metrics that
//    map cleanly to a daily quality; HRV/active-energy don't belong in mood/intake scores. ──
async function domainHealthQualityByDate(deviceId, domain, anchorDateStr, todayDate) {
  const col = userDoc(deviceId).collection('health_samples');
  const read = async (k) => { try { const s = await col.doc(k).get(); return (s.exists && s.data().days) || {}; } catch { return {}; } };
  const inWin = (d) => (!anchorDateStr || d >= anchorDateStr) && (!todayDate || d <= todayDate);
  const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const out = {};

  if (domain === 'fitness') {
    const [steps, active, workout] = await Promise.all([read('steps'), read('activeEnergy'), read('workout')]);
    const dates = new Set([...Object.keys(steps), ...Object.keys(active), ...Object.keys(workout)]);
    for (const d of dates) {
      if (!inWin(d)) continue;
      let q = 0;
      if (typeof steps[d] === 'number') q = Math.max(q, clampN(steps[d] / 8000, 0, 1) * 70);
      if (typeof active[d] === 'number') q = Math.max(q, clampN(active[d] / 500, 0, 1) * 70);
      if (Array.isArray(workout[d]) && workout[d].length) {
        const mins = workout[d].reduce((a, w) => a + (Number(w && w.minutes) || 0), 0);
        q = Math.max(q, 75 + clampN(mins / 60, 0, 1) * 15);
      }
      if (q > 0) out[d] = Math.round(q);
    }
  } else if (domain === 'sleep') {
    const sleep = await read('sleep');
    for (const [d, v] of Object.entries(sleep)) {
      if (!inWin(d) || !v || !v.asleep_min) continue;
      const durNorm = clampN((v.asleep_min / 60 - 4) / (7.5 - 4), 0, 1);
      const q = v.efficiency != null
        ? (0.6 * durNorm + 0.4 * clampN((v.efficiency - 70) / (95 - 70), 0, 1)) * 100
        : durNorm * 100;
      out[d] = Math.round(clampN(q, 0, 100));
    }
  } else if (domain === 'water') {
    // HK water = hydration (the same thing the water score measures). Default target since the user's
    // personal target lives in the agent; conservative cap so an HK-only day lifts but doesn't max.
    const water = await read('water');
    const TARGET_ML = 2000;
    for (const [d, ml] of Object.entries(water)) {
      if (!inWin(d) || typeof ml !== 'number' || ml <= 0) continue;
      out[d] = Math.round(clampN(ml / TARGET_ML, 0, 1) * 85);
    }
  }
  return out;
}

module.exports = { domainHealth, domainHealthView, domainHealthText, domainHealthQualityByDate };
