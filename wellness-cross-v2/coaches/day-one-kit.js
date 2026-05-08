/**
 * day-one-kit.js — guaranteed Insights value from log #1.
 *
 * Day-1 LAW: a user who just signed up MUST see substantive content. No
 * walls, no "wait 7 days" copy. The kit fills the gap that personal data
 * leaves behind for the first ~14 days, with research-backed claims that
 * are clearly labeled as cohort/educational (not personal).
 *
 * Returned fields:
 *   - welcome:                     warm onboarding copy (always shown)
 *   - roadmap:                     per-day unlock schedule with status
 *   - goals_preview:               per-agent target + cited norm (from setup config)
 *   - educational_correlations:    cross-agent research previews of what we'll
 *                                   measure when the user has data (top-2 by relevance)
 *   - shown:                       boolean — FE renders the kit only while true
 *
 * Lifecycle: shown=true while daysSinceSignup < 14 (i.e. before personal
 * baseline lands). At day 14+ the personal data takes over and the kit hides.
 */

'use strict';

// Cited research correlations — used for educational previews.
// Keep in sync with did-you-know/library.js sources.
const CITED_CORRELATIONS = [
  { a: 'sleep',     b: 'mind',      expected_r: '+0.5 to +0.7', headline: 'Better sleep predicts sharper mood',                  source: 'Bearable · 2024 (n=120K)' },
  { a: 'fitness',   b: 'sleep',     expected_r: '+0.3 to +0.6', headline: 'Workout days nudge that night\'s sleep up',           source: 'Kredlow 2015, J Behav Med' },
  { a: 'water',     b: 'mind',      expected_r: '+0.2 to +0.4', headline: 'Hydration today, sharper mood tomorrow',              source: 'Pross 2017, Front Hum Neurosci' },
  { a: 'fitness',   b: 'mind',      expected_r: '+0.2 to +0.5', headline: 'A 20-min walk lifts mood for hours',                  source: 'Harvard Med 2024' },
  { a: 'nutrition', b: 'fasting',   expected_r: '−0.2 to +0.2', headline: 'Eating windows shift your nutrition score in real time', source: 'Sutton 2018, Cell Metab' },
];

// Per-agent goal templates — pulled when no user-set target is found.
const GOAL_DEFAULTS = {
  sleep:     { target: '7-9 hours', citation: 'CDC + AASM · 2024' },
  mind:      { target: 'Daily check-in',          citation: 'Lieberman 2007, Psych Sci' },
  nutrition: { target: '25g+ fiber, balanced macros', citation: 'Reynolds 2019, Lancet' },
  fitness:   { target: '150 min/week',            citation: 'WHO 2020 guidelines' },
  water:     { target: '2.7-3.7L/day',            citation: 'CDC 2024' },
  fasting:   { target: '14h+ for autophagy',      citation: 'de Cabo & Mattson, NEJM 2019' },
};

const ROADMAP = [
  { day: 1,   unlock: 'First insight + cohort context' },
  { day: 7,   unlock: 'Weekly wrap + day-of-week pattern' },
  { day: 14,  unlock: 'Personal correlations (your Sleep × Mood etc.)' },
  { day: 30,  unlock: 'Monthly trends + week-over-week deltas' },
  { day: 60,  unlock: 'Recovery prediction (next-day forecast)' },
  { day: 90,  unlock: 'Quarterly story (before/after deltas per coach)' },
  { day: 180, unlock: 'Long-arc mastery view' },
];

const HIDE_AFTER_DAYS = 14;

const AGENT_LABEL = {
  sleep: 'Sleep', mind: 'Mind', nutrition: 'Nutrition',
  fitness: 'Fitness', water: 'Water', fasting: 'Fasting',
};

/**
 * Build the day-one kit. Always returns an object — never null.
 *
 * @param {Object} args
 * @param {number} args.daysSinceSignup
 * @param {Object} args.setupState                    e.g. { sleep: true, mind: true, ... }
 * @param {Object} [args.snapshots]                    used to read per-agent setup config
 * @returns {Object}
 */
function buildDayOneKit({ daysSinceSignup, setupState, snapshots }) {
  const days = Number.isFinite(daysSinceSignup) ? daysSinceSignup : 0;
  const setup = setupState || {};
  const snaps = snapshots || {};
  const shown = days < HIDE_AFTER_DAYS;

  // ── welcome ──
  const welcome = days === 0
    ? {
        headline: 'Your insights start now',
        body: 'Every log you make sharpens what we show. The first cross-coach link unlocks at day 14.',
      }
    : days < 7
      ? {
          headline: `Day ${days} — patterns are forming`,
          body: 'Below 14 days you see cohort context. Past 14 days, your own personal correlations take over.',
        }
      : {
          headline: `Day ${days} — almost there`,
          body: `Personal correlations land at day 14. ${HIDE_AFTER_DAYS - days} day${HIDE_AFTER_DAYS - days === 1 ? '' : 's'} to go.`,
        };

  // ── roadmap with per-stage status ──
  const roadmap = ROADMAP.map((step) => ({
    ...step,
    status: days >= step.day ? 'unlocked' : 'upcoming',
    countdown_days: days >= step.day ? 0 : (step.day - days),
  }));

  // ── goals preview — only for agents user has actually set up ──
  const goals_preview = [];
  for (const a of Object.keys(GOAL_DEFAULTS)) {
    if (!setup[a]) continue;
    const userTarget = readUserTarget(snaps[a], a);
    goals_preview.push({
      agent: a,
      label: AGENT_LABEL[a],
      target: userTarget || GOAL_DEFAULTS[a].target,
      citation: GOAL_DEFAULTS[a].citation,
      from_user_setup: !!userTarget,
    });
  }

  // ── educational correlations — only pairs where BOTH agents are set up ──
  const educational_correlations = CITED_CORRELATIONS
    .filter((c) => setup[c.a] && setup[c.b])
    .slice(0, 2)
    .map((c) => ({
      a: c.a,
      b: c.b,
      label: `${AGENT_LABEL[c.a]} × ${AGENT_LABEL[c.b]}`,
      expected_r: c.expected_r,
      headline: c.headline,
      source: c.source,
      is_preview: true,                 // FE shows a "preview" pill, not "your data"
      personal_unlock_at_day: 14,
    }));

  return {
    shown,
    welcome,
    roadmap,
    goals_preview,
    educational_correlations,
  };
}

function readUserTarget(snap, agent) {
  if (!snap || !snap.setup || !snap.setup.config) return null;
  const cfg = snap.setup.config;
  switch (agent) {
    case 'sleep':     return cfg.target_hours ? `${cfg.target_hours}h` : null;
    case 'water':     return cfg.daily_goal_ml ? `${cfg.daily_goal_ml} ml` : null;
    case 'fitness':   return cfg.weekly_session_target ? `${cfg.weekly_session_target}× per week` : null;
    case 'fasting':   return cfg.target_hours ? `${cfg.target_hours}h` : null;
    case 'nutrition': return cfg.daily_kcal_target ? `${cfg.daily_kcal_target} kcal` : null;
    case 'mind':      return cfg.daily_checkin_target ? `${cfg.daily_checkin_target}× per day` : null;
    default: return null;
  }
}

module.exports = {
  buildDayOneKit,
  HIDE_AFTER_DAYS,
  CITED_CORRELATIONS,
  ROADMAP,
};
