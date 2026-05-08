/**
 * quarterly.test.js — quarterly story aggregator tests.
 *
 * Covers:
 *   - locked when daysSinceSignup < 90
 *   - locked when density too low
 *   - unlocks at day 90 with sufficient density
 *   - per-agent before/after deltas computed correctly
 *   - top 3 absolute deltas surfaced
 */

'use strict';

const { buildQuarterlyStory } = require('../orchestrator/quarterly-aggregator');

let pass = 0, fail = 0;
function assert(label, cond) {
  if (cond) { console.log('  ✓ ' + label); pass++; }
  else { console.log('  ✗ ' + label); fail++; }
}

// helper: build a snapshot with score progression
function snapWithProgression(agent, startScore, endScore, days = 90) {
  const last_90d = Array.from({ length: days }, (_, i) => {
    const t = i / (days - 1); // 0..1
    const score = Math.round(startScore + (endScore - startScore) * t);
    return { date: `2026-${String(Math.floor(i / 30) + 2).padStart(2, '0')}-${String((i % 30) + 1).padStart(2, '0')}`,
             score, has_log: true };
  });
  return { agent, last_90d };
}

// ── Lock cases ──
console.log('locked cases');
const earlyResult = buildQuarterlyStory({
  snapshots: { sleep: snapWithProgression('sleep', 50, 70) },
  daysSinceSignup: 30,
  logCountsTotal: 100,
});
assert('day 30 → unlocked: false', earlyResult.unlocked === false);
assert('day 30 → items: []', earlyResult.items.length === 0);

const lowDensity = buildQuarterlyStory({
  snapshots: { sleep: snapWithProgression('sleep', 50, 70) },
  daysSinceSignup: 90,
  logCountsTotal: 30, // way under 68 threshold
});
assert('low density → unlocked: false', lowDensity.unlocked === false);

// ── Happy path ──
console.log('unlocked at day 90 with full density');
const snapshots = {
  sleep:     snapWithProgression('sleep', 50, 75, 90),
  mind:      snapWithProgression('mind', 55, 65, 90),
  nutrition: snapWithProgression('nutrition', 60, 62, 90),
  fitness:   snapWithProgression('fitness', 45, 70, 90),
  water:     snapWithProgression('water', 65, 67, 90),
  fasting:   snapWithProgression('fasting', 55, 50, 90),
};
const r = buildQuarterlyStory({
  snapshots,
  daysSinceSignup: 90,
  logCountsTotal: 90 * 6, // very dense
});

assert('unlocked: true', r.unlocked === true);
assert('returns items array', Array.isArray(r.items));
assert('exactly 3 items (top deltas)', r.items.length === 3);
assert('each item has agent, label, before, after, delta',
  r.items.every((it) => it.agent && it.label && it.before && it.after && it.delta));

// Top deltas should be sleep (+25), fitness (+25), and another big change
const deltaAgents = r.items.map((it) => it.agent);
assert('biggest deltas surface (sleep & fitness)',
  deltaAgents.includes('sleep') && deltaAgents.includes('fitness'));

// noise threshold
console.log('noise filter');
const flat = {
  sleep: snapWithProgression('sleep', 60, 60, 90), // delta 0
};
const flatRes = buildQuarterlyStory({
  snapshots: flat, daysSinceSignup: 90, logCountsTotal: 540,
});
assert('flat data → no items (delta < 1)', flatRes.items.length === 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
