'use strict';
/**
 * range-helpers.test.js — Registration Anchor primitives.
 *
 * Run:  node wellness-cross-v2/tests/range-helpers.test.js
 *
 * Covers:
 *   - dateStr local-TZ correctness across timezones
 *   - floorToLocalDay / DST boundaries / leap day
 *   - daysSinceAnchor inclusivity
 *   - computeAnalysisWindow clamping
 *   - enumerateDaysFrom edge cases
 *   - log-guard PRE_ANCHOR / FUTURE_DATE / INVALID_DATE
 */

const path = require('path');
const {
  dateStr,
  floorToLocalDay,
  daysSinceAnchor,
  computeAnalysisWindow,
  enumerateDaysFrom,
} = require(path.join(__dirname, '..', '..', 'lib', 'range-helpers'));

const { assertLoggableDate, LogGuardError } = require(
  path.join(__dirname, '..', '..', 'lib', 'log-guard'),
);

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { console.log('  ✓ ' + label); pass++; }
  else { console.log('  ✗ ' + label); fail++; }
}
function eq(label, a, b) { ok(`${label} (got ${JSON.stringify(a)})`, a === b); }

const TZ = {
  UTC: 0,
  PST: -8 * 60,
  IST: 5.5 * 60,
  TONGA: 13 * 60,
  SAMOA: -11 * 60,
};

// ────────────────────────────────────────────────────────────────
console.log('\n=== dateStr() ===');
// 23:30 UTC on 2026-05-13 → still 2026-05-13 in PST (15:30), but
// is 2026-05-14 in Tonga (12:30 next day).
const lateUtc = new Date('2026-05-13T23:30:00Z').getTime();
eq('UTC at 23:30 → 2026-05-13', dateStr(new Date(lateUtc), TZ.UTC), '2026-05-13');
eq('PST at 15:30 → 2026-05-13', dateStr(new Date(lateUtc), TZ.PST), '2026-05-13');
eq('IST at 05:00 next → 2026-05-14', dateStr(new Date(lateUtc), TZ.IST), '2026-05-14');
eq('Tonga at 12:30 next → 2026-05-14', dateStr(new Date(lateUtc), TZ.TONGA), '2026-05-14');
eq('Samoa at 12:30 prev → 2026-05-13', dateStr(new Date(lateUtc), TZ.SAMOA), '2026-05-13');

// Midnight UTC on 2026-01-01 → still 2025-12-31 in PST
const newYearUtc = new Date('2026-01-01T00:00:00Z').getTime();
eq('Year-roll UTC → 2026-01-01', dateStr(new Date(newYearUtc), TZ.UTC), '2026-01-01');
eq('Year-roll PST → 2025-12-31', dateStr(new Date(newYearUtc), TZ.PST), '2025-12-31');

// Leap day
const leap = new Date('2024-02-29T12:00:00Z').getTime();
eq('Leap day UTC', dateStr(new Date(leap), TZ.UTC), '2024-02-29');
eq('Leap day IST', dateStr(new Date(leap), TZ.IST), '2024-02-29');

// ────────────────────────────────────────────────────────────────
console.log('\n=== floorToLocalDay() ===');
const noon = new Date('2026-05-13T12:00:00Z').getTime();
const floorUtc = floorToLocalDay(noon, TZ.UTC);
eq('UTC midnight key', dateStr(new Date(floorUtc), TZ.UTC), '2026-05-13');
const floorPst = floorToLocalDay(noon, TZ.PST);
// 12:00 UTC is 04:00 PST → PST midnight that day = 08:00 UTC
eq('PST midnight key', dateStr(new Date(floorPst), TZ.PST), '2026-05-13');
ok('PST midnight ms == 08:00 UTC', floorPst === new Date('2026-05-13T08:00:00Z').getTime());

// 04:00 UTC = 23:00 PST previous day, so PST floor should be previous day's midnight
const earlyMorn = new Date('2026-05-13T04:00:00Z').getTime();
eq('PST floor of 04:00 UTC → 2026-05-12 local', dateStr(new Date(floorToLocalDay(earlyMorn, TZ.PST)), TZ.PST), '2026-05-12');

// ────────────────────────────────────────────────────────────────
console.log('\n=== daysSinceAnchor() ===');
const now = new Date('2026-05-13T15:00:00Z').getTime();
const anchorToday = floorToLocalDay(now, TZ.UTC);
eq('anchor=today → 1', daysSinceAnchor(now, anchorToday, TZ.UTC), 1);

const anchorYesterday = anchorToday - 86_400_000;
eq('anchor=yesterday → 2', daysSinceAnchor(now, anchorYesterday, TZ.UTC), 2);

const anchorWeekAgo = anchorToday - 7 * 86_400_000;
eq('anchor=7 days ago → 8', daysSinceAnchor(now, anchorWeekAgo, TZ.UTC), 8);

eq('anchor=null → 0', daysSinceAnchor(now, 0, TZ.UTC), 0);
eq('anchor=future → 1 (clamped)', daysSinceAnchor(now, anchorToday + 86_400_000, TZ.UTC), 1);

// DST: 2026-03-08 is US spring-forward.
const beforeDst = new Date('2026-03-07T12:00:00Z').getTime();
const afterDst  = new Date('2026-03-10T12:00:00Z').getTime();
eq('DST spring-forward 3 days', daysSinceAnchor(afterDst, beforeDst, TZ.PST), 4);

// ────────────────────────────────────────────────────────────────
console.log('\n=== computeAnalysisWindow() ===');
const anchor3DaysAgo = floorToLocalDay(now - 2 * 86_400_000, TZ.UTC);

const w1y = computeAnalysisWindow(365, anchor3DaysAgo, now, TZ.UTC);
eq('day-3 user picks 1Y → 3 days', w1y.effectiveDays, 3);
ok('day-3 user picks 1Y → clamped', w1y.isClamped === true);
eq('day-3 user picks 1Y → start = anchor', w1y.effectiveStartDate, dateStr(new Date(anchor3DaysAgo), TZ.UTC));

const w7 = computeAnalysisWindow(7, anchor3DaysAgo, now, TZ.UTC);
eq('day-3 user picks 1W → 3 days', w7.effectiveDays, 3);
ok('day-3 user picks 1W → clamped', w7.isClamped === true);

const matureAnchor = floorToLocalDay(now - 100 * 86_400_000, TZ.UTC);
const w30 = computeAnalysisWindow(30, matureAnchor, now, TZ.UTC);
eq('day-100 user picks 1M → 30 days', w30.effectiveDays, 30);
ok('day-100 user picks 1M → NOT clamped', w30.isClamped === false);

const wNoAnchor = computeAnalysisWindow(30, 0, now, TZ.UTC);
eq('no anchor picks 1M → 30 days', wNoAnchor.effectiveDays, 30);
ok('no anchor → NOT clamped', wNoAnchor.isClamped === false);

const wDay0 = computeAnalysisWindow(7, anchorToday, now, TZ.UTC);
eq('day-0 user picks 1W → 1 day', wDay0.effectiveDays, 1);
eq('day-0 user picks 1W → today = start', wDay0.effectiveStartDate, wDay0.todayDate);

// invalid input
const wBad = computeAnalysisWindow('garbage', 0, now, TZ.UTC);
eq('garbage input → default 30 days', wBad.effectiveDays, 30);
eq('garbage input → requestedDays = 30', wBad.requestedDays, 30);

// ────────────────────────────────────────────────────────────────
console.log('\n=== enumerateDaysFrom() ===');
const days = enumerateDaysFrom('2026-05-10', '2026-05-13');
eq('enumerate 4 days length', days.length, 4);
eq('enumerate first', days[0], '2026-05-10');
eq('enumerate last', days[3], '2026-05-13');

const single = enumerateDaysFrom('2026-05-13', '2026-05-13');
eq('enumerate single day', single.length, 1);

const backwards = enumerateDaysFrom('2026-05-13', '2026-05-10');
eq('enumerate backwards = empty', backwards.length, 0);

const empty = enumerateDaysFrom('', '2026-05-13');
eq('enumerate empty start = empty', empty.length, 0);

// month boundary
const monthEnd = enumerateDaysFrom('2026-04-29', '2026-05-02');
eq('month boundary length', monthEnd.length, 4);
eq('month boundary last = 2026-05-02', monthEnd[3], '2026-05-02');

// leap-feb
const feb = enumerateDaysFrom('2024-02-28', '2024-03-01');
eq('leap-feb length', feb.length, 3);
eq('leap-feb has 02-29', feb[1], '2024-02-29');

// year boundary
const yr = enumerateDaysFrom('2025-12-30', '2026-01-02');
eq('year boundary length', yr.length, 4);
eq('year boundary last', yr[3], '2026-01-02');

// ────────────────────────────────────────────────────────────────
console.log('\n=== assertLoggableDate() / log-guard ===');
const anchor = {
  anchorDateStr: '2026-05-10',
  utcOffsetMinutes: 0,
  isResolved: true,
};
const nowMs = new Date('2026-05-13T15:00:00Z').getTime();

eq('today is accepted', assertLoggableDate('2026-05-13', anchor, nowMs), '2026-05-13');
eq('anchor day is accepted', assertLoggableDate('2026-05-10', anchor, nowMs), '2026-05-10');
eq('backfill is accepted', assertLoggableDate('2026-05-12', anchor, nowMs), '2026-05-12');

function throws(label, fn, code) {
  try { fn(); ok(label + ' (expected throw)', false); }
  catch (e) {
    ok(label, e instanceof LogGuardError && e.code === code && e.status === 400);
  }
}
throws('pre-anchor rejected', () => assertLoggableDate('2026-05-09', anchor, nowMs), 'PRE_ANCHOR');
throws('future date rejected', () => assertLoggableDate('2026-05-14', anchor, nowMs), 'FUTURE_DATE');
throws('garbage rejected', () => assertLoggableDate('not-a-date', anchor, nowMs), 'INVALID_DATE');
throws('iso slice rejected (UTC bug)', () => assertLoggableDate('2026-05-13T15:00:00Z', anchor, nowMs), 'INVALID_DATE');

// Unresolved anchor — pass through (legacy users)
const unresolved = { anchorDateStr: null, utcOffsetMinutes: 0, isResolved: false };
eq('unresolved anchor lets pre-anchor pass', assertLoggableDate('2020-01-01', unresolved, nowMs), '2020-01-01');

// Default date = today
eq('no date arg → today', assertLoggableDate(undefined, anchor, nowMs), '2026-05-13');

// TZ-aware: PST user at 15:00 UTC == 07:00 PST same day
const pstAnchor = { anchorDateStr: '2026-05-13', utcOffsetMinutes: -480, isResolved: true };
eq('PST today log accepted', assertLoggableDate('2026-05-13', pstAnchor, nowMs), '2026-05-13');

// At 04:00 UTC, PST user is at 20:00 the previous day
const pstEarly = new Date('2026-05-13T04:00:00Z').getTime();
const pstAnchorEarly = { anchorDateStr: '2026-05-12', utcOffsetMinutes: -480, isResolved: true };
eq('PST 20:00 prev day log accepted', assertLoggableDate('2026-05-12', pstAnchorEarly, pstEarly), '2026-05-12');
throws('PST cannot log "tomorrow" UTC date when locally still yesterday',
  () => assertLoggableDate('2026-05-13', pstAnchorEarly, pstEarly), 'FUTURE_DATE');

// ────────────────────────────────────────────────────────────────
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
