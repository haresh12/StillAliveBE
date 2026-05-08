/**
 * quarterly-aggregator.js — produces pack.quarterly_story.
 *
 * Fires at day 90+ when the user has ≥75% logging density. Compares the
 * first week (days 0-6) to the most recent week (days 84-90) per agent
 * and pretty-prints the delta in each agent's natural unit (or score points
 * when no specific unit is wired).
 *
 * Output (matches FE pack shape):
 *   {
 *     unlocked: boolean,
 *     items: [{ agent, label, before, after, delta }]
 *   }
 *
 * The 'before' / 'after' / 'delta' are strings in the agent's vocabulary
 * (e.g. '6h 48m' → '7h 32m', delta '+44 min'). The cross-agent narrative
 * (which delta most explains the user's wellness rise) lives in the AHA
 * 'quarterly' event headline.
 */

'use strict';

const AGENTS = ['sleep', 'mind', 'nutrition', 'fitness', 'water', 'fasting'];

const MIN_DAYS = 90;
const MIN_DENSITY = 0.75;        // ≥ 75% logging density
const FIRST_WEEK_DAYS = 7;
const LAST_WEEK_DAYS = 7;
const TOP_N_DELTAS = 3;          // highlight the 3 biggest changes

const AGENT_LABEL = {
  sleep: 'Sleep',
  mind: 'Mood',
  nutrition: 'Nutrition',
  fitness: 'Fitness',
  water: 'Water',
  fasting: 'Fasting',
};

function avgScores(snapshotPoints) {
  const arr = (snapshotPoints || []).map((p) => p && p.score).filter(Number.isFinite);
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}

function buildQuarterlyStory({ snapshots, daysSinceSignup, logCountsTotal }) {
  if (!Number.isFinite(daysSinceSignup) || daysSinceSignup < MIN_DAYS) {
    return { unlocked: false, items: [] };
  }

  // Density gate: total log count across all 6 agents over 90d ≥ 90 * 0.75 = 68 (a couple per day)
  const requiredLogs = Math.round(MIN_DAYS * MIN_DENSITY);
  if (!Number.isFinite(logCountsTotal) || logCountsTotal < requiredLogs) {
    return { unlocked: false, items: [] };
  }

  const items = [];
  for (const a of AGENTS) {
    const snap = snapshots[a];
    if (!snap || !Array.isArray(snap.last_90d) || snap.last_90d.length < MIN_DAYS) continue;

    const first = snap.last_90d.slice(0, FIRST_WEEK_DAYS);
    const last = snap.last_90d.slice(-LAST_WEEK_DAYS);
    const before = avgScores(first);
    const after = avgScores(last);
    if (before == null || after == null) continue;

    const delta = after - before;
    if (Math.abs(delta) < 1) continue; // skip noise

    items.push({
      agent: a,
      label: AGENT_LABEL[a],
      before: `${Math.round(before)}`,
      after: `${Math.round(after)}`,
      delta: `${delta > 0 ? '+' : ''}${Math.round(delta)} pts`,
      _delta_num: delta, // for sorting only
    });
  }

  // Surface the top-N most positive (or most-negative if mostly down).
  // Strategy: rank by absolute delta, take top 3.
  items.sort((x, y) => Math.abs(y._delta_num) - Math.abs(x._delta_num));
  const top = items.slice(0, TOP_N_DELTAS).map(({ _delta_num, ...rest }) => rest);

  return {
    unlocked: top.length > 0,
    items: top,
  };
}

module.exports = { buildQuarterlyStory };
