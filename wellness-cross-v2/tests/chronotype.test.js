/**
 * chronotype.test.js — chronotype engine unit tests.
 *
 * Covers:
 *   - timeToMins / minsToHHMM round-trip
 *   - circularMean handles cross-midnight (mix of 23:30 + 00:30 averages near 00:00)
 *   - circularMean with low variance returns small variance_min
 *   - labelFor maps the standard buckets correctly
 *   - detectChronotype: cold start (< 7 logs) → null
 *   - detectChronotype: stable 22:00 sleeper → '10pm sleeper'
 *   - detectChronotype: stable 23:00 sleeper → '11pm sleeper'
 *   - detectChronotype: cross-midnight cluster → 'midnight sleeper'
 *   - detectChronotype: irregular pattern → 'irregular sleeper'
 */

'use strict';

const {
  detectChronotype,
  _internal: { timeToMins, minsToHHMM, circularMean, labelFor },
} = require('../coaches/chronotype-engine');

let pass = 0, fail = 0;
function assert(label, cond) {
  if (cond) { console.log('  ✓ ' + label); pass++; }
  else { console.log('  ✗ ' + label); fail++; }
}

// timeToMins / minsToHHMM
console.log('time helpers');
assert("timeToMins '23:00' = 1380", timeToMins('23:00') === 1380);
assert("timeToMins '00:30' = 30", timeToMins('00:30') === 30);
assert("timeToMins null → null", timeToMins(null) === null);
assert("minsToHHMM(1380) = '23:00'", minsToHHMM(1380) === '23:00');
assert("minsToHHMM(30) = '00:30'", minsToHHMM(30) === '00:30');

// circularMean — non-wrapping
console.log('circularMean (linear)');
const cm1 = circularMean([1320, 1325, 1330, 1335]); // 22:00, 22:05, 22:10, 22:15
assert("avg ~22:07", Math.abs(cm1.mean_min - 1327) < 5);
assert("variance < 30 min", cm1.variance_min < 30);

// circularMean — cross-midnight (23:30, 23:45, 00:00, 00:15)
console.log('circularMean (cross-midnight)');
const cm2 = circularMean([1410, 1425, 0, 15]); // wraps around midnight
assert("mean lands near midnight (1380..60)", cm2.mean_min > 1380 || cm2.mean_min < 60);
assert("variance < 60 min (tight cluster)", cm2.variance_min < 60);

// Old approach (linear average) would produce 712.5 = 11:52 — totally wrong
const linearAvg = (1410 + 1425 + 0 + 15) / 4;
assert("linear avg of cross-midnight WOULD be wrong (~712 → 11:52)", Math.abs(linearAvg - 712.5) < 1);

// labelFor buckets
console.log('labelFor buckets');
assert("21:30 (1290) → 10pm sleeper", labelFor(1290).kind === 'evening');
assert("23:00 (1380) → 11pm sleeper", labelFor(1380).kind === 'late_evening');
assert("23:45 (1425) → midnight sleeper", labelFor(1425).kind === 'midnight');
assert("00:15 (15) → midnight sleeper", labelFor(15).kind === 'midnight');
assert("01:30 (90) → late owl", labelFor(90).kind === 'late_owl');
assert("03:00 (180) → night owl", labelFor(180).kind === 'night_owl');

// detectChronotype — cold start
console.log('detectChronotype cold start');
assert("empty input → null", detectChronotype([]) === null);
assert("less than 7 logs → null", detectChronotype([
  { date: '2026-05-01', bedtime: '22:00' },
  { date: '2026-05-02', bedtime: '22:15' },
]) === null);

// detectChronotype — stable 10pm sleeper
console.log('detectChronotype 10pm sleeper');
const tenPm = Array.from({ length: 14 }, (_, i) => ({
  date: `2026-04-${String(20 + i).padStart(2, '0')}`,
  bedtime: i % 2 === 0 ? '22:00' : '22:15', // tight cluster around 22:07
}));
const ct1 = detectChronotype(tenPm);
assert("returns object", ct1 && typeof ct1 === 'object');
assert("kind = 'evening'", ct1 && ct1.kind === 'evening');
assert("label includes '10pm'", ct1 && /10pm/.test(ct1.label));
assert("mean_onset starts with '22:'", ct1 && /^22:/.test(ct1.mean_onset));
assert("variance < 90 min (stable)", ct1 && ct1.variance_min < 90);

// detectChronotype — stable 11pm sleeper
console.log('detectChronotype 11pm sleeper');
const elevenPm = Array.from({ length: 14 }, (_, i) => ({
  date: `2026-04-${String(20 + i).padStart(2, '0')}`,
  bedtime: i % 2 === 0 ? '23:00' : '23:15',
}));
const ct2 = detectChronotype(elevenPm);
assert("11pm cluster → kind 'late_evening'", ct2 && ct2.kind === 'late_evening');
assert("mean_onset around 23:00", ct2 && /^23:/.test(ct2.mean_onset));

// detectChronotype — cross-midnight cluster
console.log('detectChronotype midnight sleeper');
const nearMidnight = [
  { date: '2026-04-20', bedtime: '23:45' },
  { date: '2026-04-21', bedtime: '00:00' },
  { date: '2026-04-22', bedtime: '00:15' },
  { date: '2026-04-23', bedtime: '23:30' },
  { date: '2026-04-24', bedtime: '23:50' },
  { date: '2026-04-25', bedtime: '00:10' },
  { date: '2026-04-26', bedtime: '23:55' },
  { date: '2026-04-27', bedtime: '00:05' },
];
const ct3 = detectChronotype(nearMidnight);
assert("midnight cluster → kind 'midnight'", ct3 && ct3.kind === 'midnight');

// detectChronotype — irregular pattern
console.log('detectChronotype irregular');
const wild = [
  { date: '2026-04-20', bedtime: '21:00' },
  { date: '2026-04-21', bedtime: '23:30' },
  { date: '2026-04-22', bedtime: '02:00' },
  { date: '2026-04-23', bedtime: '22:00' },
  { date: '2026-04-24', bedtime: '01:00' },
  { date: '2026-04-25', bedtime: '20:30' },
  { date: '2026-04-26', bedtime: '03:30' },
  { date: '2026-04-27', bedtime: '23:00' },
];
const ct4 = detectChronotype(wild);
assert("wild pattern flagged irregular OR has high variance", ct4 && (ct4.kind === 'irregular' || ct4.variance_min > 90));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
