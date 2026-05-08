/**
 * day-one-kit.test.js — guaranteed-day-1-value contract.
 *
 * Covers:
 *   - kit always returns an object (never null)
 *   - shown=true while < 14 days, false at 14+
 *   - welcome variants per day-bucket
 *   - roadmap stages have correct unlocked/upcoming based on days
 *   - goals_preview only includes set-up agents
 *   - educational_correlations only fire for pairs where both agents are set up
 *   - educational_correlations marked is_preview=true (not personal data)
 */

'use strict';

const { buildDayOneKit, HIDE_AFTER_DAYS, ROADMAP } = require('../coaches/day-one-kit');

let pass = 0, fail = 0;
function assert(label, cond) {
  if (cond) { console.log('  ✓ ' + label); pass++; }
  else { console.log('  ✗ ' + label); fail++; }
}

const allSetup = { sleep: true, mind: true, nutrition: true, fitness: true, water: true, fasting: true };
const minimalSetup = { sleep: true, mind: true };

// ── always returns an object ──
console.log('always present');
assert('day 0 returns object', !!buildDayOneKit({ daysSinceSignup: 0, setupState: {} }));
assert('day 100 returns object', !!buildDayOneKit({ daysSinceSignup: 100, setupState: {} }));
assert('null inputs still return object',
  !!buildDayOneKit({ daysSinceSignup: null, setupState: null }));

// ── shown lifecycle ──
console.log('shown lifecycle');
assert('day 0 shown=true', buildDayOneKit({ daysSinceSignup: 0, setupState: allSetup }).shown === true);
assert('day 7 shown=true', buildDayOneKit({ daysSinceSignup: 7, setupState: allSetup }).shown === true);
assert('day 13 shown=true', buildDayOneKit({ daysSinceSignup: 13, setupState: allSetup }).shown === true);
assert('day 14 shown=false (kit hides at HIDE_AFTER_DAYS)',
  buildDayOneKit({ daysSinceSignup: HIDE_AFTER_DAYS, setupState: allSetup }).shown === false);
assert('day 30 shown=false',
  buildDayOneKit({ daysSinceSignup: 30, setupState: allSetup }).shown === false);

// ── welcome variants ──
console.log('welcome copy');
const day0 = buildDayOneKit({ daysSinceSignup: 0, setupState: allSetup });
assert('day 0 welcome.headline mentions "now"', /now/i.test(day0.welcome.headline));
const day3 = buildDayOneKit({ daysSinceSignup: 3, setupState: allSetup });
assert('day 3 welcome.headline mentions day or pattern',
  /day 3|pattern/i.test(day3.welcome.headline));
const day10 = buildDayOneKit({ daysSinceSignup: 10, setupState: allSetup });
assert('day 10 welcome counts down to 14',
  /day 10|almost/i.test(day10.welcome.headline));

// ── roadmap ──
console.log('roadmap');
const r = buildDayOneKit({ daysSinceSignup: 8, setupState: allSetup }).roadmap;
assert('roadmap returned', Array.isArray(r) && r.length === ROADMAP.length);
assert('day-7 unlock marked unlocked at day 8',
  r.find((s) => s.day === 7).status === 'unlocked');
assert('day-14 unlock marked upcoming at day 8',
  r.find((s) => s.day === 14).status === 'upcoming');
assert('countdown_days correct for day 14 at day 8',
  r.find((s) => s.day === 14).countdown_days === 6);

// ── goals_preview ──
console.log('goals_preview');
const goalsAll = buildDayOneKit({ daysSinceSignup: 0, setupState: allSetup }).goals_preview;
assert('all 6 goals when all 6 setup', goalsAll.length === 6);
const goalsMin = buildDayOneKit({ daysSinceSignup: 0, setupState: minimalSetup }).goals_preview;
assert('only 2 goals when only 2 setup', goalsMin.length === 2);
assert('goals contain sleep + mind only',
  goalsMin.every((g) => g.agent === 'sleep' || g.agent === 'mind'));
assert('every goal has target + citation',
  goalsAll.every((g) => g.target && g.citation));

// user-set target overrides default
const userTarget = buildDayOneKit({
  daysSinceSignup: 0,
  setupState: { sleep: true },
  snapshots: { sleep: { setup: { config: { target_hours: 8.5 } } } },
});
assert('user-set target appears in goals_preview',
  userTarget.goals_preview[0].target === '8.5h');
assert('user-set target marked from_user_setup=true',
  userTarget.goals_preview[0].from_user_setup === true);

// ── educational_correlations ──
console.log('educational_correlations');
const eduAll = buildDayOneKit({ daysSinceSignup: 0, setupState: allSetup }).educational_correlations;
assert('top-2 educational correlations returned for full setup',
  eduAll.length === 2);
assert('all educational correlations marked is_preview=true',
  eduAll.every((e) => e.is_preview === true));
assert('all educational correlations have a, b, label, expected_r, source',
  eduAll.every((e) => e.a && e.b && e.label && e.expected_r && e.source));

const eduOnlySleep = buildDayOneKit({ daysSinceSignup: 0, setupState: { sleep: true } }).educational_correlations;
assert('zero pairs when only one agent set up', eduOnlySleep.length === 0);

const eduSleepMind = buildDayOneKit({ daysSinceSignup: 0, setupState: { sleep: true, mind: true } }).educational_correlations;
assert('sleep+mind setup → sleep×mind preview shows',
  eduSleepMind.some((e) => e.a === 'sleep' && e.b === 'mind'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
