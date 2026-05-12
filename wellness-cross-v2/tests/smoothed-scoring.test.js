'use strict';
// Tests for the unified scoring infrastructure shipped 2026-05-13.
// Covers: smoothed_7d math, status_band mapping, Day-1 fallback, no-NaN guarantee.

// Inline the canonical band function — must stay identical to:
//   state-machine.js:statusBandForScore()
//   CoachGrid.js:statusBandKey()
//   WellnessScoreGauge.js:statusFor() (returns label, but bands match)
function statusBandForScore(score) {
  if (!Number.isFinite(score)) return 'idle';
  if (score >= 80) return 'thriving';
  if (score >= 65) return 'strong';
  if (score >= 50) return 'steady';
  if (score >= 30) return 'building';
  if (score >= 1)  return 'starting';
  return 'idle';
}

// Inline the smoothed-7d math — must stay identical to _helpers.js
function avgScored(pts) {
  const valid = pts.filter((p) => Number.isFinite(p.value));
  if (valid.length === 0) return null;
  return Math.max(0, Math.min(100, Math.round(valid.reduce((s, p) => s + p.value, 0) / valid.length)));
}

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.error('  ✗ ' + name + '  expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

console.log('\n=== Status band mapping ===');
eq('NaN → idle',           statusBandForScore(NaN),       'idle');
eq('null → idle',          statusBandForScore(null),      'idle');
eq('undefined → idle',     statusBandForScore(undefined), 'idle');
eq('0 → idle',             statusBandForScore(0),         'idle');
eq('1 → starting',         statusBandForScore(1),         'starting');
eq('12 → starting',        statusBandForScore(12),        'starting');
eq('29 → starting',        statusBandForScore(29),        'starting');
eq('30 → building',        statusBandForScore(30),        'building');
eq('49 → building',        statusBandForScore(49),        'building');
eq('50 → steady',          statusBandForScore(50),        'steady');
eq('64 → steady',          statusBandForScore(64),        'steady');
eq('65 → strong',          statusBandForScore(65),        'strong');
eq('79 → strong',          statusBandForScore(79),        'strong');
eq('80 → thriving',        statusBandForScore(80),        'thriving');
eq('100 → thriving',       statusBandForScore(100),       'thriving');
eq('120 → thriving (cap)', statusBandForScore(120),       'thriving');

console.log('\n=== smoothed_7d math ===');
eq('empty array → null',          avgScored([]),                                                           null);
eq('all NaN → null',              avgScored([{value: NaN}, {value: null}, {value: undefined}]),            null);
eq('1 valid score → that score',  avgScored([{value: 50}]),                                                 50);
eq('3 valid scores → rounded avg',avgScored([{value: 60}, {value: 70}, {value: 80}]),                       70);
eq('mixed valid + null',          avgScored([{value: 60}, {value: null}, {value: 80}]),                     70);
eq('clamps below 0',              avgScored([{value: -50}, {value: -100}]),                                 0);
eq('clamps above 100',            avgScored([{value: 150}, {value: 200}]),                                  100);
eq('decimal rounds',              avgScored([{value: 50.4}, {value: 50.6}]),                                51);

console.log('\n=== Day-1 fallback (coach card) ===');
function day1Fallback(setupCount) {
  return setupCount > 0 ? setupCount * 2 : 0;
}
eq('0 coaches → 0',  day1Fallback(0), 0);
eq('1 coach → 2',    day1Fallback(1), 2);
eq('2 coaches → 4',  day1Fallback(2), 4);
eq('4 coaches → 8',  day1Fallback(4), 8);
eq('6 coaches → 12', day1Fallback(6), 12);

console.log('\n=== Day-1 fallback matches Wellness Score warm-start ===');
// Both formulas must produce the same number on Day-1
function wellnessWarmStart(setupCount) { return setupCount * 2; }
for (const n of [1, 2, 3, 4, 5, 6]) {
  eq(`${n} coaches: card === Wellness`, day1Fallback(n), wellnessWarmStart(n));
}

console.log('\n=== No-NaN guarantee ===');
// Verify that displayScore in CoachGrid is never NaN for any input combination
function deriveDisplayScore({ smoothed7d, todayScore, isSetup, setupCount }) {
  if (Number.isFinite(smoothed7d)) return smoothed7d;
  if (Number.isFinite(todayScore)) return todayScore;
  if (isSetup) return setupCount * 2;
  return null;
}
const cases = [
  { name: 'all null + not setup',          input: { smoothed7d: null, todayScore: null, isSetup: false, setupCount: 0 }, expect: null },
  { name: 'all null + setup, 6 coaches',   input: { smoothed7d: null, todayScore: null, isSetup: true,  setupCount: 6 }, expect: 12 },
  { name: 'today only',                    input: { smoothed7d: null, todayScore: 45,   isSetup: true,  setupCount: 6 }, expect: 45 },
  { name: 'smoothed wins over today',      input: { smoothed7d: 60,   todayScore: 45,   isSetup: true,  setupCount: 6 }, expect: 60 },
  { name: 'NaN inputs are safe',           input: { smoothed7d: NaN,  todayScore: NaN,  isSetup: true,  setupCount: 6 }, expect: 12 },
];
for (const c of cases) {
  eq(c.name, deriveDisplayScore(c.input), c.expect);
}

console.log(`\nResult: ${pass}/${pass + fail} tests passed.`);
process.exit(fail > 0 ? 1 : 0);
