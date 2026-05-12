'use strict';
/**
 * score-lifetime.test.js — unified per-agent score outputs.
 */
const path = require('path');
const { computeStandardOutputs } = require(
  path.join(__dirname, '..', '..', 'lib', 'score-lifetime'),
);

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { console.log('  ✓ ' + label); pass++; }
  else { console.log('  ✗ ' + label); fail++; }
}
function eq(label, a, b) { ok(`${label} (got ${JSON.stringify(a)})`, a === b); }

console.log('\n=== computeStandardOutputs ===');

// Day-0 user with no logs
const day0 = computeStandardOutputs({
  qualityByDate: {},
  todayDate: '2026-05-13',
  anchorDate: '2026-05-13',
  daysSinceAnchor: 1,
});
eq('day-0 score_today = null', day0.score_today, null);
eq('day-0 score_lifetime = null', day0.score_lifetime, null);
eq('day-0 score_7d = null', day0.score_7d_smoothed, null);
eq('day-0 missed_days = 1', day0.missed_days, 1);
eq('day-0 days_logged = 0', day0.days_logged, 0);

// Day-0 user, logged today
const day0logged = computeStandardOutputs({
  qualityByDate: { '2026-05-13': 75 },
  todayDate: '2026-05-13',
  anchorDate: '2026-05-13',
  daysSinceAnchor: 1,
});
eq('day-0 logged → score_today=75', day0logged.score_today, 75);
eq('day-0 logged → score_lifetime=75', day0logged.score_lifetime, 75);
eq('day-0 logged → score_7d=75', day0logged.score_7d_smoothed, 75);
eq('day-0 logged → missed_days=0', day0logged.missed_days, 0);

// Day-3 user, logged 2 of 3 days
const day3 = computeStandardOutputs({
  qualityByDate: { '2026-05-11': 60, '2026-05-13': 80 },
  todayDate: '2026-05-13',
  anchorDate: '2026-05-11',
  daysSinceAnchor: 3,
});
eq('day-3 score_today (logged)', day3.score_today, 80);
eq('day-3 lifetime = mean(60,80) = 70', day3.score_lifetime, 70);
eq('day-3 score_7d = 70', day3.score_7d_smoothed, 70);
eq('day-3 missed_days = 1 (May 12)', day3.missed_days, 1);
eq('day-3 days_logged = 2', day3.days_logged, 2);

// Day-3 user, did NOT log today
const day3unlogged = computeStandardOutputs({
  qualityByDate: { '2026-05-11': 60, '2026-05-12': 80 },
  todayDate: '2026-05-13',
  anchorDate: '2026-05-11',
  daysSinceAnchor: 3,
});
eq('day-3 unlogged today → score_today=null', day3unlogged.score_today, null);
eq('day-3 unlogged today → lifetime still 70', day3unlogged.score_lifetime, 70);
eq('day-3 unlogged today → missed = 1', day3unlogged.missed_days, 1);

// Day-15 user — 7d window only takes last 7 logged days
const dates15 = {};
for (let i = 0; i < 15; i++) {
  const d = new Date(2026, 4, 13 - i);
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), dd = String(d.getDate()).padStart(2,'0');
  dates15[`${y}-${m}-${dd}`] = 50 + i; // 50..64
}
const day15 = computeStandardOutputs({
  qualityByDate: dates15,
  todayDate: '2026-05-13',
  anchorDate: '2026-04-29', // 15 days ago
  daysSinceAnchor: 15,
});
eq('day-15 days_logged = 15', day15.days_logged, 15);
eq('day-15 lifetime = mean(50..64) = 57', day15.score_lifetime, 57);
// Last 7 = dates 2026-05-07..2026-05-13 (scores 50..56 going backwards from today)
// Actually: today=2026-05-13 has score 50, yesterday=2026-05-12 has 51, etc.
// Last 7 logged days sorted asc = 2026-05-07..2026-05-13 = scores 56,55,54,53,52,51,50 → mean=53
eq('day-15 score_7d = 53', day15.score_7d_smoothed, 53);
eq('day-15 missed_days = 0 (all logged)', day15.missed_days, 0);

// Pre-anchor logs should be ignored
const stale = computeStandardOutputs({
  qualityByDate: { '2024-01-01': 99, '2026-05-13': 80 }, // 99 is pre-anchor
  todayDate: '2026-05-13',
  anchorDate: '2026-05-13',
  daysSinceAnchor: 1,
});
eq('pre-anchor log ignored in lifetime', stale.score_lifetime, 80);

// Anchor null (legacy) — should NOT compute missed_days
const legacy = computeStandardOutputs({
  qualityByDate: { '2026-05-13': 60 },
  todayDate: '2026-05-13',
  anchorDate: null,
  daysSinceAnchor: 0,
});
eq('legacy anchor=null → missed=0', legacy.missed_days, 0);
eq('legacy anchor=null → lifetime=60', legacy.score_lifetime, 60);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
