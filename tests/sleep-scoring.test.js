/**
 * sleep-scoring — contract tests for lib/sleep-scoring.js (2026-05-24).
 *
 * Locks the math:
 *   maturityRamp   — exact curve parity with fitness + mind
 *   dropFutureLogs — future-dated filter
 *   deriveSleepBank — credit/debit framing
 *
 * AND the critical integration: agent-scores.computeSleepScore must use
 * the slow honest curve (Day 7 perfect ≈ 55, NOT 80).
 *
 * Run: node tests/sleep-scoring.test.js
 */
'use strict';
const assert = require('assert');
const S = require('../lib/sleep-scoring');
const { computeSleepScore } = require('../lib/agent-scores');

let p = 0, f = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); p++; }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); f++; }
}
function section(s) { console.log('\n' + s); }

// ────────────────────────────────────────────────────────────────
section('maturityRamp — curve parity with fitness + mind');

test('day 0 (null) returns 0.40 seed', () => {
  assert.strictEqual(S.maturityRamp(0), 0.40);
  assert.strictEqual(S.maturityRamp(null), 0.40);
  assert.strictEqual(S.maturityRamp(undefined), 0.40);
});

test('day 1 returns 0.45 (slow growth)', () => {
  assert.strictEqual(S.maturityRamp(1), 0.45);
  assert.strictEqual(S.maturityRamp(2), 0.45);
  assert.strictEqual(S.maturityRamp(3), 0.45);
});

test('day 4-6 returns 0.55 (early signal)', () => {
  assert.strictEqual(S.maturityRamp(4), 0.55);
  assert.strictEqual(S.maturityRamp(6), 0.55);
});

test('day 7-13 returns 0.70 (patterns forming) — NOT 0.80', () => {
  assert.strictEqual(S.maturityRamp(7), 0.70);
  assert.strictEqual(S.maturityRamp(13), 0.70);
  // Was the bug — old shared maturityFactor returned 0.80 at day 7.
  assert.notStrictEqual(S.maturityRamp(7), 0.80);
});

test('day 14-29 returns 0.85 (habit solidifying)', () => {
  assert.strictEqual(S.maturityRamp(14), 0.85);
  assert.strictEqual(S.maturityRamp(29), 0.85);
});

test('day 30-59 returns 0.94 (confirmed lifestyle)', () => {
  assert.strictEqual(S.maturityRamp(30), 0.94);
  assert.strictEqual(S.maturityRamp(59), 0.94);
});

test('day 60+ returns 1.00 (established)', () => {
  assert.strictEqual(S.maturityRamp(60), 1.00);
  assert.strictEqual(S.maturityRamp(365), 1.00);
});

test('curve is monotonic non-decreasing across days 0-100', () => {
  let prev = 0;
  for (let d = 0; d <= 100; d++) {
    const v = S.maturityRamp(d);
    assert.ok(v >= prev, `regression at day ${d}: ${v} < ${prev}`);
    prev = v;
  }
});

// ────────────────────────────────────────────────────────────────
section('dropFutureLogs');

test('drops logs with date_str > today', () => {
  const out = S.dropFutureLogs(
    [
      { date_str: '2026-05-20' },
      { date_str: '2026-05-24' }, // today
      { date_str: '2026-05-25' }, // future
      { date_str: '2026-06-01' }, // future
    ],
    '2026-05-24',
  );
  assert.strictEqual(out.length, 2);
});

test('keeps logs without date_str (legacy)', () => {
  const out = S.dropFutureLogs([{ id: 'legacy', no_date: true }], '2026-05-24');
  assert.strictEqual(out.length, 1);
});

test('handles null/undefined input gracefully', () => {
  assert.deepStrictEqual(S.dropFutureLogs(null, '2026-05-24'), []);
  assert.deepStrictEqual(S.dropFutureLogs(undefined, '2026-05-24'), []);
});

// ────────────────────────────────────────────────────────────────
section('deriveSleepBank');

test('returns positive credit when nightly total exceeds target', () => {
  const logs = Array.from({ length: 7 }, () => ({ total_sleep_hours: 8.0 }));
  const bank = S.deriveSleepBank(logs, 7.5);
  assert.ok(bank && bank.in_credit === true);
  assert.ok(bank.credit_hours >= 3.4 && bank.credit_hours <= 3.6); // 7 × 0.5 = 3.5
});

test('returns negative debit when nightly total falls short of target', () => {
  const logs = Array.from({ length: 7 }, () => ({ total_sleep_hours: 6.5 }));
  const bank = S.deriveSleepBank(logs, 7.5);
  assert.ok(bank && bank.in_credit === false);
  assert.ok(bank.credit_hours <= -6.9 && bank.credit_hours >= -7.1); // 7 × -1.0 = -7
});

test('returns null with fewer than 3 nights (honest minimum)', () => {
  assert.strictEqual(S.deriveSleepBank([{ total_sleep_hours: 8 }], 7.5), null);
  assert.strictEqual(S.deriveSleepBank([], 7.5), null);
});

// ════════════════════════════════════════════════════════════════
// INTEGRATION — the real test: does computeSleepScore use the slow curve?
// ════════════════════════════════════════════════════════════════
section('computeSleepScore — slow curve integration (CRITICAL)');

const perfectInputs = {
  avg_efficiency: 92,
  avg_duration: 8.0,
  avg_quality: 5,
  avg_energy: 5,
  avg_latency: 12,
  consistency_score: 95,
  sleep_debt: 0,
  target_hours: 7.5,
};

test('day 1 perfect night caps near 45 (not 65)', () => {
  const r = computeSleepScore({ ...perfectInputs, days_logged: 1 });
  assert.ok(r && r.score <= 50,
    `day 1 perfect score should be ≤50 (0.45 × 100), got ${r?.score}`);
  assert.ok(r.score >= 35,
    `day 1 perfect score should still be ≥35 (visible to user), got ${r?.score}`);
});

test('day 7 perfect week caps near 70 (NOT 80 — the bug we fixed)', () => {
  const r = computeSleepScore({ ...perfectInputs, days_logged: 7 });
  assert.ok(r && r.score <= 75,
    `day 7 perfect score should be ≤75 (0.70 × 100), got ${r?.score}`);
  assert.ok(r.score >= 60,
    `day 7 perfect score should still be ≥60 (rewarding), got ${r?.score}`);
});

test('day 14 perfect fortnight caps near 85', () => {
  const r = computeSleepScore({ ...perfectInputs, days_logged: 14 });
  assert.ok(r && r.score <= 88, `day 14 perfect should be ≤88, got ${r?.score}`);
  assert.ok(r.score >= 78, `day 14 perfect should be ≥78, got ${r?.score}`);
});

test('day 30 perfect month caps near 94', () => {
  const r = computeSleepScore({ ...perfectInputs, days_logged: 30 });
  assert.ok(r && r.score <= 96, `day 30 perfect should be ≤96, got ${r?.score}`);
});

test('day 60+ perfect can hit 100', () => {
  const r = computeSleepScore({ ...perfectInputs, days_logged: 90 });
  assert.ok(r && r.score >= 95, `day 60+ perfect should be ≥95, got ${r?.score}`);
});

test('clinical floor still respected — 4h sleep cannot exceed cap', () => {
  const r = computeSleepScore({ ...perfectInputs, avg_duration: 4.0, days_logged: 60 });
  // durationCap at <6h is 55. Maturity 1.00 × min(raw, 55) ≤ 55.
  assert.ok(r && r.score <= 55, `4h sleep should cap ≤55, got ${r?.score}`);
});

test('returns null when no data', () => {
  const r = computeSleepScore({ avg_efficiency: null, avg_duration: null, days_logged: 1 });
  assert.strictEqual(r, null);
});

// ────────────────────────────────────────────────────────────────
console.log(`\n${p} passed, ${f} failed`);
process.exit(f > 0 ? 1 : 0);
