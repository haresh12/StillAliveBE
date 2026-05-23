/**
 * Fitness scoring + future-log filter — contract tests.
 *
 * Locks in the 2026-05-23 honesty laws:
 *   • dropFutureWorkouts: future-dated logs (dev_allow_future) never
 *     inflate analytics; verdict/chart/calendar agree on the same set.
 *   • deriveSessionQuality: ignores deprecated session_quality field,
 *     blends volume/RPE/sets/PR into 0-100.
 *   • computeBlendedScore: components floored at 0, no negative intensity.
 *   • maturityRamp: tiered from 0.40 (day-1) to 1.00 (day-60+), monotonic.
 *
 * Run: node tests/fitness-scoring.test.js
 */

'use strict';

const assert = require('assert');
const {
  deriveSessionQuality,
  maturityRamp,
  computeBlendedScore,
  dropFutureWorkouts,
} = require('../lib/fitness-scoring');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function section(title) { console.log(`\n${title}`); }

// ────────────────────────────────────────────────────────────────
section('dropFutureWorkouts');

test('drops workouts with date > today', () => {
  const out = dropFutureWorkouts([
    { date: '2026-05-20' },
    { date: '2026-05-23' },  // today
    { date: '2026-05-24' },  // future
    { date: '2026-06-01' },  // future
  ], '2026-05-23');
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out.map(w => w.date), ['2026-05-20', '2026-05-23']);
});

test('keeps workouts with no date field (legacy)', () => {
  const out = dropFutureWorkouts([
    { date: '2026-05-20', total_volume_kg: 100 },
    { total_volume_kg: 50 },  // legacy doc without date
  ], '2026-05-23');
  assert.strictEqual(out.length, 2);
});

test('returns all when today not provided', () => {
  const out = dropFutureWorkouts([{ date: '2099-01-01' }], null);
  assert.strictEqual(out.length, 1);
});

test('boundary: same-day kept (date === today)', () => {
  const out = dropFutureWorkouts(
    [{ date: '2026-05-23' }, { date: '2026-05-24' }],
    '2026-05-23',
  );
  assert.deepStrictEqual(out.map(w => w.date), ['2026-05-23']);
});

// ────────────────────────────────────────────────────────────────
section('deriveSessionQuality');

const stdTarget = { weeklyVolTarget: 4500, weeklySetsTarget: 14 };

test('zero workout → 0 + neutral RPE 60 + 0 sets', () => {
  // vol=0 (0%), sets=0 (0%), rpe=null → 60, no PRs.
  // raw = 0*0.4 + 60*0.3 + 0*0.2 + 0 = 18
  const q = deriveSessionQuality({}, stdTarget);
  assert.strictEqual(q, 18);
});

test('full-target session with RPE 8 + 1 PR → 80-100', () => {
  // vol=1125 (per-session target = 4500/4), sets=3.5→100%, rpe=8 → 100, 1 PR → +10
  // raw = 100*0.4 + 100*0.3 + 100*0.2 + 10 = 100, capped at 100
  const q = deriveSessionQuality({
    total_volume_kg: 1125,
    total_sets: 4,
    rpe_avg: 8,
    personal_records: ['Bench 100kg'],
  }, stdTarget);
  assert.ok(q >= 90 && q <= 100, `expected 90-100, got ${q}`);
});

test('ignores legacy session_quality field', () => {
  // Even if session_quality:60 is present, we never read it — derive from real signals.
  const withLegacy = deriveSessionQuality({
    total_volume_kg: 1125, total_sets: 4, rpe_avg: 8, session_quality: 0,
  }, stdTarget);
  const withoutLegacy = deriveSessionQuality({
    total_volume_kg: 1125, total_sets: 4, rpe_avg: 8,
  }, stdTarget);
  assert.strictEqual(withLegacy, withoutLegacy);
});

test('RPE 10 (overreach) penalized vs RPE 8', () => {
  const optimal = deriveSessionQuality({ total_volume_kg: 1125, total_sets: 4, rpe_avg: 8 }, stdTarget);
  const overreach = deriveSessionQuality({ total_volume_kg: 1125, total_sets: 4, rpe_avg: 10 }, stdTarget);
  assert.ok(overreach < optimal, `RPE 10 (${overreach}) should be < RPE 8 (${optimal})`);
});

test('RPE 4 (under-load) penalized vs RPE 8', () => {
  const optimal = deriveSessionQuality({ total_volume_kg: 1125, total_sets: 4, rpe_avg: 8 }, stdTarget);
  const under = deriveSessionQuality({ total_volume_kg: 1125, total_sets: 4, rpe_avg: 4 }, stdTarget);
  assert.ok(under < optimal, `RPE 4 (${under}) should be < RPE 8 (${optimal})`);
});

test('PR bonus capped at +30', () => {
  const fivePRs = deriveSessionQuality({
    total_volume_kg: 0, total_sets: 0, rpe_avg: 0,
    personal_records: ['a', 'b', 'c', 'd', 'e'],
  }, stdTarget);
  const threePRs = deriveSessionQuality({
    total_volume_kg: 0, total_sets: 0, rpe_avg: 0,
    personal_records: ['a', 'b', 'c'],
  }, stdTarget);
  // Both should be capped at the +30 PR ceiling: vol=0 sets=0 rpe=60→18, +30 cap = 48
  assert.strictEqual(fivePRs, threePRs);
  assert.strictEqual(fivePRs, 48);
});

test('result always in [0, 100]', () => {
  const cases = [
    { total_volume_kg: 999999, total_sets: 999, rpe_avg: 8, personal_records: ['a','b','c','d','e'] },
    { total_volume_kg: -100, total_sets: -5, rpe_avg: -2 },
    {},
  ];
  for (const w of cases) {
    const q = deriveSessionQuality(w, stdTarget);
    assert.ok(q >= 0 && q <= 100, `expected 0-100, got ${q} for ${JSON.stringify(w)}`);
  }
});

// ────────────────────────────────────────────────────────────────
section('computeBlendedScore');

test('intensityScore floored at 0 for RPE < 5 (no negative drag)', () => {
  // Before the fix: RPE=2 → ((2-5)/4)*100 = -75, silently lowered the blend.
  const b = computeBlendedScore({ weeklyVolKg: 0, volTarget: 4500, avgRpe: 2, sessionsThisWeek: 0 });
  assert.strictEqual(b.intensityScore, 0);
  assert.ok(b.raw >= 0, `raw must be ≥ 0, got ${b.raw}`);
});

test('all components capped at 100', () => {
  const b = computeBlendedScore({ weeklyVolKg: 99999, volTarget: 4500, avgRpe: 9, sessionsThisWeek: 99 });
  assert.strictEqual(b.volPctOfTarget, 100);
  assert.strictEqual(b.intensityScore, 100);
  assert.strictEqual(b.consistencyScore, 100);
});

test('weights sum to 1.00 (vol .38 + int .31 + cons .31)', () => {
  const b = computeBlendedScore({ weeklyVolKg: 4500, volTarget: 4500, avgRpe: 9, sessionsThisWeek: 4 });
  // All 100 → raw should be 100
  assert.strictEqual(Math.round(b.raw), 100);
});

test('zero target guarded (no /0)', () => {
  const b = computeBlendedScore({ weeklyVolKg: 1000, volTarget: 0, avgRpe: 7, sessionsThisWeek: 2 });
  assert.ok(Number.isFinite(b.raw));
  assert.strictEqual(b.volPctOfTarget, 100);  // 1000/1 capped at 100
});

// ────────────────────────────────────────────────────────────────
section('maturityRamp');

test('monotonic non-decreasing across calendar days', () => {
  let prev = -Infinity;
  for (let d = 0; d <= 120; d++) {
    const r = maturityRamp(d);
    assert.ok(r >= prev, `ramp dropped at day ${d} (${r} < ${prev})`);
    prev = r;
  }
});

test('day-1 ≈ 0.40 (no fake maturity from a single cram session)', () => {
  assert.strictEqual(maturityRamp(1), 0.45);  // day-1 falls in d<4 bucket
  assert.strictEqual(maturityRamp(0), 0.40);
});

test('day-60+ reaches full ramp (1.00)', () => {
  assert.strictEqual(maturityRamp(60), 1.00);
  assert.strictEqual(maturityRamp(365), 1.00);
});

test('null/undefined → 0.40 (treated as day-0)', () => {
  assert.strictEqual(maturityRamp(null), 0.40);
  assert.strictEqual(maturityRamp(undefined), 0.40);
});

// ────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
