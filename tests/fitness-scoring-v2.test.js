/**
 * fitness-scoring v2 — contract tests for the 10 surfaces added 2026-05-23.
 *
 * Covers:
 *   computeBanister      — rest-day decay, pre-warm, band thresholds
 *   derivePriorPeriod    — delta math, null safety
 *   deriveEffortMix      — RPE bands, zero-RPE filter, totals
 *   derivePushPullLegs   — categorization, warn flag, span gate
 *   deriveMuscleFrequency— per-week math
 *   deriveExerciseVariety— stagnation gate
 *   deriveHourGrid       — DOW × hour bucketing, TZ shift
 *   deriveContributionMap— always 365, pre-anchor tag
 *   derivePlateau        — stalled detection
 *   deriveDurationDensity— null when no timer data
 *
 * Run: node tests/fitness-scoring-v2.test.js
 */
'use strict';

const assert = require('assert');
const F = require('../lib/fitness-scoring');

let p = 0, f = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); p++; }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); f++; }
}
function section(s) { console.log('\n' + s); }

// ────────────────────────────────────────────────────────────────
section('computeBanister');

test('empty inputs → neutral defaults (no crash)', () => {
  const r = F.computeBanister({ sessions: [], priorSessions: [], startDateStr: '2026-05-01', todayDateStr: '2026-05-23' });
  assert.strictEqual(r.ctl, 0);
  assert.strictEqual(r.atl, 0);
  assert.strictEqual(r.band, 'steady');
});

test('rest-day decay: 1 session 6 days ago → ATL near zero', () => {
  const r = F.computeBanister({
    sessions: [{ date: '2026-05-17', total_volume_kg: 5000, rpe_avg: 7 }],
    priorSessions: [],
    startDateStr: '2026-05-17',
    todayDateStr: '2026-05-23',
  });
  // ATL decays toward 0 over 7-day τ; after 6 rest days it should be << initial impulse
  assert.ok(r.atl < 5000, 'ATL should decay across rest days, got ' + r.atl);
});

test('pre-warm raises CTL so band isn’t cold-start overreached', () => {
  const prior = [];
  for (let i = 0; i < 28; i++) {
    if (i % 2 === 0) prior.push({ date: `2026-04-${String(i+1).padStart(2,'0')}`, total_volume_kg: 4000, rpe_avg: 7.5 });
  }
  const r = F.computeBanister({
    sessions: [{ date: '2026-05-23', total_volume_kg: 4000, rpe_avg: 7.5 }],
    priorSessions: prior,
    startDateStr: '2026-04-01',
    todayDateStr: '2026-05-23',
  });
  // With pre-warm, ratio shouldn't slam to overreached
  assert.ok(['peaked','fresh','steady','building'].includes(r.band), 'unexpected band ' + r.band);
});

test('bad date inputs degrade gracefully', () => {
  const r = F.computeBanister({ sessions: [], priorSessions: [], startDateStr: null, todayDateStr: null });
  assert.strictEqual(r.band, 'steady');
});

test('explain text always present for known bands', () => {
  const r = F.computeBanister({
    sessions: [{ date: '2026-05-23', total_volume_kg: 100, rpe_avg: 7 }],
    priorSessions: [], startDateStr: '2026-04-01', todayDateStr: '2026-05-23',
  });
  assert.ok(typeof r.explain === 'string' && r.explain.length > 0);
});

// ────────────────────────────────────────────────────────────────
section('derivePriorPeriod');

test('null when no prior data', () => {
  assert.strictEqual(F.derivePriorPeriod({ priorWorkouts: [], currentTotalVolKg: 100, currentTotalSets: 10, currentDaysLogged: 1, currentPRs: 0 }), null);
});

test('positive delta when current > prior', () => {
  const r = F.derivePriorPeriod({
    priorWorkouts: [{ total_volume_kg: 1000, total_sets: 10, personal_records: [] }],
    currentTotalVolKg: 1500, currentTotalSets: 15, currentDaysLogged: 2, currentPRs: 1,
  });
  assert.strictEqual(r.delta_vol_pct, 50);
  assert.strictEqual(r.delta_sets_pct, 50);
  assert.strictEqual(r.delta_prs_abs, 1);
});

test('negative delta when current < prior', () => {
  const r = F.derivePriorPeriod({
    priorWorkouts: [
      { total_volume_kg: 2000, total_sets: 20, personal_records: ['x'] },
      { total_volume_kg: 1000, total_sets: 10, personal_records: [] },
    ],
    currentTotalVolKg: 1500, currentTotalSets: 15, currentDaysLogged: 1, currentPRs: 0,
  });
  assert.strictEqual(r.delta_vol_pct, -50);
  assert.strictEqual(r.delta_sets_pct, -50);
  assert.strictEqual(r.delta_prs_abs, -1);
});

test('zero prior volume guarded (no div by 0)', () => {
  const r = F.derivePriorPeriod({
    priorWorkouts: [{ total_volume_kg: 0, total_sets: 0, personal_records: [] }],
    currentTotalVolKg: 100, currentTotalSets: 10, currentDaysLogged: 1, currentPRs: 0,
  });
  assert.strictEqual(r.delta_vol_pct, null);
  assert.strictEqual(r.delta_sets_pct, null);
});

// ────────────────────────────────────────────────────────────────
section('deriveEffortMix');

test('empty → all zeros (no crash)', () => {
  const r = F.deriveEffortMix([]);
  assert.deepStrictEqual(r, { easy_pct: 0, working_pct: 0, max_pct: 0, working_n: 0, total_n: 0 });
});

test('zero-RPE sets ignored', () => {
  const r = F.deriveEffortMix([{ exercises: [{ sets: [{ rpe: 0 }, { rpe: null }, { rpe: 8 }] }] }]);
  assert.strictEqual(r.total_n, 1);
  assert.strictEqual(r.working_n, 1);
  assert.strictEqual(r.working_pct, 100);
});

test('three bands correctly partitioned', () => {
  const r = F.deriveEffortMix([{ exercises: [{ sets: [
    { rpe: 5 },   // easy
    { rpe: 7 },   // working
    { rpe: 8 },   // working
    { rpe: 9.5 }, // max
  ] }] }]);
  assert.strictEqual(r.easy_pct, 25);
  assert.strictEqual(r.working_pct, 50);
  assert.strictEqual(r.max_pct, 25);
  assert.strictEqual(r.total_n, 4);
});

test('percentages always sum near 100 (rounding-safe)', () => {
  const r = F.deriveEffortMix([{ exercises: [{ sets: [{ rpe: 6 }, { rpe: 7 }, { rpe: 8 }] }] }]);
  const sum = r.easy_pct + r.working_pct + r.max_pct;
  assert.ok(Math.abs(sum - 100) <= 1, 'sum ' + sum + ' should be near 100');
});

// ────────────────────────────────────────────────────────────────
section('derivePushPullLegs');

test('categorizes muscle groups correctly', () => {
  const r = F.derivePushPullLegs([
    { exercises: [{ muscle_group: 'chest', sets: [{},{}] }] },        // push 2
    { exercises: [{ muscle_group: 'back', sets: [{},{},{}] }] },      // pull 3
    { exercises: [{ muscle_group: 'legs', sets: [{}] }] },            // legs 1
  ]);
  assert.strictEqual(r.push_sets, 2);
  assert.strictEqual(r.pull_sets, 3);
  assert.strictEqual(r.legs_sets, 1);
});

test('warn only kicks in at ≥28d span', () => {
  const lopsided = [
    { exercises: [{ muscle_group: 'chest', sets: [{},{},{},{},{},{},{},{},{}] }] }, // 9 push
    { exercises: [{ muscle_group: 'legs', sets: [{}] }] },                          // 1 legs (10% < 20%)
  ];
  assert.strictEqual(F.derivePushPullLegs(lopsided, 7).warn, false);
  assert.strictEqual(F.derivePushPullLegs(lopsided, 30).warn, true);
});

test('unknown muscle groups ignored', () => {
  const r = F.derivePushPullLegs([{ exercises: [{ muscle_group: 'mystery', sets: [{}] }] }]);
  assert.strictEqual(r.push_sets + r.pull_sets + r.legs_sets, 0);
});

// ────────────────────────────────────────────────────────────────
section('deriveMuscleFrequency');

test('one session counts once per muscle (not per exercise)', () => {
  const r = F.deriveMuscleFrequency([
    { exercises: [
      { muscle_group: 'chest', sets: [{}] },
      { muscle_group: 'chest', sets: [{}] },  // same muscle twice in one session
      { muscle_group: 'back',  sets: [{}] },
    ] },
  ], 7);
  const chest = r.find((m) => m.muscle === 'chest');
  assert.strictEqual(chest.sessions_total, 1);
  assert.strictEqual(chest.per_week, 1.0);
});

test('sorted high → low', () => {
  const r = F.deriveMuscleFrequency([
    { exercises: [{ muscle_group: 'back', sets: [{}] }] },
    { exercises: [{ muscle_group: 'back', sets: [{}] }] },
    { exercises: [{ muscle_group: 'chest', sets: [{}] }] },
  ], 7);
  assert.strictEqual(r[0].muscle, 'back');
});

// ────────────────────────────────────────────────────────────────
section('deriveExerciseVariety');

test('unique count + stagnation gate', () => {
  const workouts = [{ exercises: [{ name: 'Bench' }, { name: 'Squat' }] }];
  assert.deepStrictEqual(F.deriveExerciseVariety(workouts, 7), { unique: 2, stagnant: false });
  assert.deepStrictEqual(F.deriveExerciseVariety(workouts, 30), { unique: 2, stagnant: true });
});

// ────────────────────────────────────────────────────────────────
section('deriveHourGrid');

test('returns 7×24 zero grid for empty', () => {
  const g = F.deriveHourGrid([]);
  assert.strictEqual(g.length, 7);
  assert.strictEqual(g[0].length, 24);
  assert.strictEqual(g[0][0], 0);
});

test('buckets sessions by local DOW + hour', () => {
  // Friday May 22, 2026 19:00 UTC
  const ts = new Date('2026-05-22T19:00:00Z').getTime();
  const g = F.deriveHourGrid([{ logged_at: ts }], 0);
  assert.strictEqual(g[5][19], 1);
});

test('handles Firestore Timestamp-like .toMillis()', () => {
  const g = F.deriveHourGrid([{ logged_at: { toMillis: () => new Date('2026-05-22T08:00:00Z').getTime() } }], 0);
  assert.strictEqual(g[5][8], 1);
});

// ────────────────────────────────────────────────────────────────
section('deriveContributionMap');

test('always emits 365 cells regardless of input size', () => {
  const r = F.deriveContributionMap({ dayQualityByDate: {}, anchorDate: '2026-05-23', todayDate: '2026-05-23' });
  assert.strictEqual(r.cells.length, 365);
  assert.strictEqual(r.summary.total_cells, 365);
});

test('grid spans anchor → anchor+364 (first dot is registration day)', () => {
  const r = F.deriveContributionMap({ dayQualityByDate: {}, anchorDate: '2026-05-23', todayDate: '2026-05-23' });
  // First cell IS the anchor; last cell is anchor + 364 days.
  assert.strictEqual(r.cells[0].date, '2026-05-23');
  assert.strictEqual(r.cells[364].date, '2027-05-22');
  // No pre-anchor cells in the new model.
  assert.strictEqual(r.cells.filter(c => c.pre_anchor).length, 0);
  // Cells beyond today are tagged `future` and don't count toward span_days.
  assert.strictEqual(r.cells.filter(c => c.future).length, 364);
  assert.strictEqual(r.summary.span_days, 1);
});

test('quality → level buckets (75/55 thresholds)', () => {
  const r = F.deriveContributionMap({
    dayQualityByDate: { '2025-01-01': 80, '2025-01-02': 60, '2025-01-03': 30 },
    anchorDate: '2025-01-01', todayDate: '2026-05-23',
  });
  const m = Object.fromEntries(r.cells.map(c => [c.date, c.level]));
  assert.strictEqual(m['2025-01-01'], 3);
  assert.strictEqual(m['2025-01-02'], 2);
  assert.strictEqual(m['2025-01-03'], 1);
});

test('missing todayDate degrades gracefully', () => {
  const r = F.deriveContributionMap({ dayQualityByDate: {}, anchorDate: null, todayDate: null });
  assert.deepStrictEqual(r.cells, []);
});

// ────────────────────────────────────────────────────────────────
section('derivePlateau');

test('stalled when flat for 3+ weeks (true plateau, not regression)', () => {
  // Slight wobble around 100kg, 3 weeks since the last new high.
  const pts = [100, 102, 100, 100];
  const dates = ['2026-04-25','2026-05-02','2026-05-09','2026-05-23'];
  const r = F.derivePlateau({ points: pts, dates });
  assert.ok(r.stalled, 'should be stalled — got ' + JSON.stringify(r));
  assert.ok(r.weeks_stalled >= 3);
});

test('regression (sharp drop) is NOT a plateau — call it out separately', () => {
  // Sharp drop = injury / illness / deload, not a stagnant lift.
  const r = F.derivePlateau({
    points: [110, 105, 100, 95],
    dates:  ['2026-04-25','2026-05-02','2026-05-09','2026-05-23'],
  });
  assert.strictEqual(r.stalled, false, 'regression should not be flagged as plateau');
});

test('not stalled when ascending', () => {
  const r = F.derivePlateau({ points: [100, 105, 110], dates: ['2026-05-09','2026-05-16','2026-05-23'] });
  assert.strictEqual(r.stalled, false);
});

test('empty / single-point inputs safe', () => {
  assert.deepStrictEqual(F.derivePlateau({ points: [] }), { stalled: false, weeks_stalled: 0 });
  assert.deepStrictEqual(F.derivePlateau({ points: [100] }), { stalled: false, weeks_stalled: 0 });
});

// ────────────────────────────────────────────────────────────────
section('deriveDurationDensity');

test('null when no timer data', () => {
  const r = F.deriveDurationDensity([{ total_sets: 10 }]);
  assert.strictEqual(r.avg_duration_min, null);
  assert.strictEqual(r.set_density, null);
});

test('computes from started_at / ended_at', () => {
  const start = new Date('2026-05-23T10:00:00Z').getTime();
  const end   = new Date('2026-05-23T10:50:00Z').getTime();
  const r = F.deriveDurationDensity([{ started_at: start, ended_at: end, total_sets: 15 }]);
  assert.strictEqual(r.avg_duration_min, 50);
  assert.ok(r.set_density > 0);
});

test('rejects corrupt timestamps (>240 min or negative)', () => {
  const a = new Date('2026-05-23T10:00:00Z').getTime();
  const tooLong = new Date('2026-05-24T10:00:00Z').getTime();
  const r = F.deriveDurationDensity([{ started_at: a, ended_at: tooLong, total_sets: 15 }]);
  assert.strictEqual(r.avg_duration_min, null);
});

// ────────────────────────────────────────────────────────────────
console.log('\n' + p + ' passed, ' + f + ' failed');
process.exit(f === 0 ? 0 : 1);
