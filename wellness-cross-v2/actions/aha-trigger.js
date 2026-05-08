/**
 * aha-trigger.js — deterministic event-trigger system for `aha_feed`.
 *
 * Twelve archetypes, evaluated once per pack rebuild. Each trigger returns
 * either `null` (not firing) or an event object:
 *
 *   { id, kind, tier, ts, headline, body, payload }
 *
 * `id` is stable (e.g. `correlation:sleep×mind`, `unlock:7`, `streak:30`)
 * so the persistence layer can de-dupe across runs — an event fires only
 * the first time its id appears.
 *
 * Cross-agent power: triggers READ across all 6 agents via the context the
 * orchestrator passes in (top_correlations, snapshots, baselines, streaks,
 * chronotype). This is the highest-engagement surface in the app — these
 * fire as the "wow" moments.
 *
 * Phase 5 ships deterministic headlines. LLM polish (Gemini Flash) lands in
 * a later sub-phase; the Validator already gates any LLM number claims.
 */

'use strict';

const ARCHETYPES = [
  'unlock',         // day milestones (7/14/30/90/180)
  'correlation',    // first strong cross-agent link
  'streak',         // logging streaks (3/7/14/30/60/90 days)
  'chronotype',     // chronotype label first determined
  'cohort',         // top-X% in user's cohort (placeholder; needs cohort data)
  'wrap',           // weekly recap
  'monthly',        // monthly recap (30/60)
  'quarterly',      // quarterly milestone (90)
  'pattern',        // DOW pattern stabilized
  'mastery',        // 180d milestone
  'descriptive',    // small early-day observations
  'prediction',     // prediction model unlocked at day 60+
];

const UNLOCK_TIERS = [7, 14, 30, 90, 180];
const STREAK_TIERS = [3, 7, 14, 30, 60, 90];

function unlock(ctx) {
  const d = ctx.daysSinceSignup;
  if (!UNLOCK_TIERS.includes(d)) return null;
  const headlineMap = {
    7:   { headline: '7-day streak unlocked',           body: 'You showed up every day. Top 20% of new users at this point.' },
    14:  { headline: 'Baseline complete',               body: 'Your insights are calibrated to YOU now — not a generic average.' },
    30:  { headline: 'Habit phase reached',             body: 'Average wellness lands here. Patterns emerge from this point on.' },
    90:  { headline: 'First quarter is here',           body: 'Three months of data. Trends invisible at 30 days are now visible.' },
    180: { headline: 'Half a year of data',             body: 'Patterns are now resilient to noise. Long arcs become readable.' },
  };
  return {
    id: `unlock:${d}`,
    kind: 'unlock',
    tier: d,
    ts: ctx.today,
    ...headlineMap[d],
  };
}

function correlation(ctx) {
  const top = ctx.topCorrelations && ctx.topCorrelations[0];
  if (!top || Math.abs(top.r) < 0.6 || top.n < 14) return null;
  const [a, b] = top.agents;
  const sign = top.r > 0 ? '↑' : '↓';
  return {
    id: `correlation:${a}×${b}`,
    kind: 'correlation',
    ts: ctx.today,
    headline: `${cap(a)} × ${cap(b)}: r=${top.r > 0 ? '+' : ''}${top.r.toFixed(2)}`,
    body: top.plain_english || `${cap(a)} predicts ${cap(b)} ${sign}.`,
    payload: { correlation_id: top.id, r: top.r, n: top.n, lag: top.lag || 0 },
  };
}

function streak(ctx) {
  const s = ctx.streaks && (ctx.streaks.current_consistent_days || ctx.streaks.consistent_days);
  if (!Number.isFinite(s)) return null;
  if (!STREAK_TIERS.includes(s)) return null;
  return {
    id: `streak:${s}`,
    kind: 'streak',
    tier: s,
    ts: ctx.today,
    headline: `${s}-day logging streak`,
    body: s >= 30 ? 'Discipline phase. Few users reach this.'
        : s >= 14 ? 'Habit forming. Keep going.'
        : 'Consistency unlocks the deepest insights.',
  };
}

function chronotype(ctx) {
  const c = ctx.chronotype;
  if (!c || !c.label || c.kind === 'irregular') return null;
  return {
    id: `chronotype:${c.kind}`,
    kind: 'chronotype',
    ts: ctx.today,
    headline: `You're a ${c.label}`,
    body: `Mean onset ${c.mean_onset}, variance ${c.variance_min} min.`,
    payload: { kind: c.kind, mean_onset: c.mean_onset },
  };
}

function wrap(ctx) {
  // Fire weekly: when daysSinceSignup % 7 === 0 and ≥ 7
  const d = ctx.daysSinceSignup;
  if (d < 7 || d % 7 !== 0) return null;
  if (UNLOCK_TIERS.includes(d)) return null; // unlock takes precedence on milestone weeks
  return {
    id: `wrap:week-${d / 7}`,
    kind: 'wrap',
    ts: ctx.today,
    headline: `Week ${d / 7} wrap`,
    body: 'Your weekly summary is ready.',
  };
}

function monthly(ctx) {
  const d = ctx.daysSinceSignup;
  if (![60].includes(d)) return null; // 30 + 90 already covered by 'unlock'
  return {
    id: `monthly:${d}`,
    kind: 'monthly',
    ts: ctx.today,
    headline: `Month ${d / 30} wrap`,
    body: 'Monthly trends are unlocked.',
  };
}

function quarterly(ctx) {
  // Fires every 90d after the first quarterly unlock at day 90
  const d = ctx.daysSinceSignup;
  if (d < 180 || d % 90 !== 0) return null;
  if (d === 180) return null; // 'mastery' covers this
  return {
    id: `quarterly:${d}`,
    kind: 'quarterly',
    ts: ctx.today,
    headline: `Quarter ${d / 90} story`,
    body: 'Long-arc deltas refreshed.',
  };
}

function pattern(ctx) {
  const wp = ctx.weekPattern;
  if (!wp || wp.worst == null || wp.best == null) return null;
  // Only fire once worst-day pattern stabilizes (≥14 days of data)
  if (ctx.daysSinceSignup < 14) return null;
  const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  return {
    id: `pattern:dow-${days[wp.worst]}-${days[wp.best]}`,
    kind: 'pattern',
    ts: ctx.today,
    headline: `Your ${days[wp.worst]}s drag, ${days[wp.best]}s shine`,
    body: wp.headline || 'Your day-of-week pattern stabilized.',
  };
}

function mastery(ctx) {
  if (ctx.daysSinceSignup < 180) return null;
  if (ctx.daysSinceSignup % 180 !== 0) return null;
  return {
    id: `mastery:${ctx.daysSinceSignup}`,
    kind: 'mastery',
    ts: ctx.today,
    headline: 'Half-year mastery',
    body: 'Your patterns are now resilient to noise.',
  };
}

function descriptive(ctx) {
  // Day-1 LAW: every new user gets a welcome AHA on day 0, log or not.
  // Logged-today gets the warmer "first-log" variant; otherwise a welcome.
  if (ctx.daysSinceSignup === 0) {
    if (ctx.totalLogsToday > 0) {
      return { id: 'descriptive:first-log', kind: 'descriptive', ts: ctx.today,
        headline: 'First log in!',
        body: 'Logging is the unlock. The first cross-coach link arrives at day 14.' };
    }
    return { id: 'descriptive:welcome', kind: 'descriptive', ts: ctx.today,
      headline: 'Welcome — your insights start now',
      body: 'Log any coach to begin. Each entry sharpens what we can show you.' };
  }
  // Day 1: first momentum nudge
  if (ctx.daysSinceSignup === 1) {
    return { id: 'descriptive:day-1', kind: 'descriptive', ts: ctx.today,
      headline: 'You showed up again',
      body: 'Two days in a row puts you ahead of 60% of new users.' };
  }
  if (ctx.daysSinceSignup === 3) {
    return { id: 'descriptive:day-3', kind: 'descriptive', ts: ctx.today,
      headline: 'Three days in',
      body: 'Habit formation is consistency, not intensity. Ten more days to your baseline.' };
  }
  if (ctx.daysSinceSignup === 5) {
    return { id: 'descriptive:day-5', kind: 'descriptive', ts: ctx.today,
      headline: 'Halfway to your weekly wrap',
      body: 'Day 7 unlocks your first day-of-week pattern.' };
  }
  return null;
}

function prediction(ctx) {
  if (ctx.daysSinceSignup !== 60) return null;
  return {
    id: 'prediction:unlocked',
    kind: 'prediction',
    ts: ctx.today,
    headline: 'Recovery prediction live',
    body: 'After 60d of data we can forecast your next-day score within ±10 pts.',
  };
}

function cohort(_ctx) {
  // Placeholder until cohort comparison data is wired (P10).
  return null;
}

const TRIGGERS = {
  unlock, correlation, streak, chronotype, wrap, monthly, quarterly,
  pattern, mastery, descriptive, prediction, cohort,
};

/**
 * Evaluate all triggers against the given context, return ordered candidate
 * events. Caller handles persistence/dedupe and feeds back already-fired ids.
 *
 * @param {Object} ctx
 * @param {string} ctx.today                  YYYY-MM-DD
 * @param {number} ctx.daysSinceSignup
 * @param {number} ctx.totalLogsToday
 * @param {Array}  ctx.topCorrelations
 * @param {Object} ctx.streaks
 * @param {Object} ctx.chronotype
 * @param {Object} ctx.weekPattern
 * @returns {Array} candidate events sorted by archetype priority
 */
function evaluateTriggers(ctx) {
  const out = [];
  for (const k of ARCHETYPES) {
    try {
      const ev = TRIGGERS[k](ctx);
      if (ev) out.push(ev);
    } catch (_) { /* a single trigger fail must not poison the pack */ }
  }
  return out;
}

/**
 * Filter to events not already fired (by id). Caller passes the set of
 * already-stored event ids.
 */
function newEvents(candidates, alreadyFiredIds) {
  const fired = alreadyFiredIds instanceof Set ? alreadyFiredIds : new Set(alreadyFiredIds || []);
  return candidates.filter((e) => !fired.has(e.id));
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

module.exports = {
  evaluateTriggers,
  newEvents,
  ARCHETYPES,
  _internal: { TRIGGERS },
};
