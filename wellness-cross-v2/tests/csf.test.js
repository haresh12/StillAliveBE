/**
 * csf.test.js — Capacity·Strain·Form unit tests.
 *
 * Covers:
 *   - rawStrainForDay maps score → load
 *   - applyCrossAgentBoost: well-rested users feel less strain, under-recovered feel more
 *   - emaSeries math
 *   - formProximityScore sweet-spot
 *   - buildCapacityStrainForm cold-start (returns null when < 7 fitness days)
 *   - buildCapacityStrainForm happy path (returns shape, last day matches latest)
 */

'use strict';

const {
  buildCapacityStrainForm,
  _internal: { rawStrainForDay, applyCrossAgentBoost, emaSeries, formProximityScore },
} = require('../score/capacity-strain-form');

let pass = 0, fail = 0;
function assert(label, cond) {
  if (cond) { console.log('  ✓ ' + label); pass++; }
  else { console.log('  ✗ ' + label); fail++; }
}

// rawStrainForDay
console.log('rawStrainForDay');
assert('no log → 0', rawStrainForDay({ has_log: false, score: null }) === 0);
assert('null score → 0', rawStrainForDay({ has_log: true, score: null }) === 0);
assert('score 60 → ~90 strain', rawStrainForDay({ has_log: true, score: 60 }) === 90);
assert('score 100 → 150 (capped)', rawStrainForDay({ has_log: true, score: 100 }) === 150);
assert('score 200 stays capped at 150', rawStrainForDay({ has_log: true, score: 200 }) === 150);

// applyCrossAgentBoost
console.log('applyCrossAgentBoost (cross-agent moat)');
const baseStrain = 100;
assert('neutral z (0,0) → no change', applyCrossAgentBoost(baseStrain, 0, 0) === 100);
assert('great sleep (z=+1.5) reduces strain', applyCrossAgentBoost(baseStrain, 1.5, 0) < 100);
assert('poor sleep (z=-1.5) amplifies strain', applyCrossAgentBoost(baseStrain, -1.5, 0) > 100);
assert('great fundamentals reduce strain more than just sleep',
  applyCrossAgentBoost(baseStrain, 1.5, 1.5) < applyCrossAgentBoost(baseStrain, 1.5, 0));
assert('factor clamped > 0.5 (sleep z=+5 doesnt produce zero strain)',
  applyCrossAgentBoost(baseStrain, 5, 5) >= baseStrain / 1.7 - 0.01);
assert('zero raw strain stays zero', applyCrossAgentBoost(0, 1.5, 1.5) === 0);

// emaSeries
console.log('emaSeries');
const ema = emaSeries([0, 0, 100, 100, 100], 0.5);
assert('first value passes through', ema[0] === 0);
assert('after 100 spike, ema climbs', ema[2] > ema[1] && ema[2] < 100);
assert('returns same length', ema.length === 5);
assert('empty input returns []', emaSeries([], 0.5).length === 0);

// formProximityScore
console.log('formProximityScore');
assert('form 0 → 1.0 (sweet spot)', formProximityScore(0) === 1);
assert('form 5 → 1.0 (in window)', formProximityScore(5) === 1);
assert('form 10 → 1.0 (boundary)', formProximityScore(10) === 1);
assert('form 30 → near 0 (overshot)', formProximityScore(30) === 0);
assert('form -25 → near 0 (overreached)', formProximityScore(-25) === 0);

// buildCapacityStrainForm
console.log('buildCapacityStrainForm');
assert('null when no inputs', buildCapacityStrainForm({}) === null);
assert('null when no fitness logs', buildCapacityStrainForm({
  fitnessLast90: [], zSeries: [], dates: [],
}) === null);

// Cold start: 5 logged days < 7 threshold
const dates5 = ['2026-04-01','2026-04-02','2026-04-03','2026-04-04','2026-04-05'];
const fit5 = dates5.map((d, i) => ({ date: d, score: 60, has_log: i % 2 === 0 }));
const z5 = dates5.map((_, i) => ({ d: i, sleep: 0, mind: 0, nutrition: 0, fitness: 0, water: 0, fasting: 0 }));
assert('cold start (<7 fitness days) → null',
  buildCapacityStrainForm({ fitnessLast90: fit5, zSeries: z5, dates: dates5 }) === null);

// Happy path: 30 days with mix of workout days
const dates30 = Array.from({ length: 30 }, (_, i) => `2026-04-${String(i + 1).padStart(2, '0')}`);
const fit30 = dates30.map((d, i) => ({
  date: d,
  score: i % 3 === 0 ? 70 : null, // ~10 workouts
  has_log: i % 3 === 0,
}));
const z30 = dates30.map((_, i) => ({ d: i, sleep: 0.5, mind: 0, nutrition: 0.3, fitness: 0, water: 0, fasting: 0 }));
const csf = buildCapacityStrainForm({ fitnessLast90: fit30, zSeries: z30, dates: dates30 });
assert('happy path returns object', csf && typeof csf === 'object');
assert('has capacity number', Number.isFinite(csf.capacity));
assert('has strain number', Number.isFinite(csf.strain));
assert('has form number', Number.isFinite(csf.form));
assert('has days array', Array.isArray(csf.days) && csf.days.length === 30);
assert('each day has {date, capacity, strain, form, score}', csf.days.every(d =>
  d.date && Number.isFinite(d.capacity) && Number.isFinite(d.strain) && Number.isFinite(d.form) && Number.isFinite(d.score)));

// Cross-agent moat: same workouts with great sleep → lower strain than poor sleep
const goodZ = dates30.map((_, i) => ({ d: i, sleep: 1.5, mind: 0, nutrition: 1.0, fitness: 0, water: 0, fasting: 0 }));
const badZ = dates30.map((_, i) => ({ d: i, sleep: -1.5, mind: 0, nutrition: -1.0, fitness: 0, water: 0, fasting: 0 }));
const csfGood = buildCapacityStrainForm({ fitnessLast90: fit30, zSeries: goodZ, dates: dates30 });
const csfBad  = buildCapacityStrainForm({ fitnessLast90: fit30, zSeries: badZ,  dates: dates30 });
assert('great sleep+nutrition → less strain than poor', csfGood.strain < csfBad.strain);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
