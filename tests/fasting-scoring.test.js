/**
 * Fasting scoring + future-log filter + maturity ramp — contract tests.
 *
 * Locks the 2026-05-23 honesty laws (mirrors fitness-scoring tests):
 *   • dropFutureSessions: future-dated logs never inflate analytics.
 *   • deriveFastQuality: blends completion / depth / cleanness / refeed.
 *   • maturityRamp: identical curve to fitness (0.40 → 1.00).
 *   • metabolicStageAtHour: research-cited stage table, no hallucinated
 *     hour anchors (no "BHB peaks at 18h" claim).
 *
 * Run: node tests/fasting-scoring.test.js
 */

'use strict';

const assert = require('assert');
const {
  TARGET_DEPTH_HOURS,
  METABOLIC_STAGES,
  metabolicStageAtHour,
  sessionDeepestStage,
  deriveFastQuality,
  maturityRamp,
  dropFutureSessions,
  buildDayQualityByDate,
} = require('../lib/fasting-scoring');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function section(title) { console.log(`\n${title}`); }

// ────────────────────────────────────────────────────────────────
section('METABOLIC_STAGES + metabolicStageAtHour');

test('METABOLIC_STAGES is frozen + has 6 stages', () => {
  assert.strictEqual(METABOLIC_STAGES.length, 6);
  assert.throws(() => { METABOLIC_STAGES.push({}); });
});

test('TARGET_DEPTH_HOURS is 16 (Anton 2018 fat-burn anchor)', () => {
  assert.strictEqual(TARGET_DEPTH_HOURS, 16);
});

test('every stage has key + label + citation field', () => {
  for (const s of METABOLIC_STAGES) {
    assert.ok(typeof s.key === 'string' && s.key.length > 0);
    assert.ok(typeof s.label === 'string' && s.label.length > 0);
    assert.ok('citation' in s);  // null is allowed for "fed"
  }
});

test('returns null for negative hours', () => {
  assert.strictEqual(metabolicStageAtHour(-1), null);
  assert.strictEqual(metabolicStageAtHour(-0.1), null);
});

test('hour 0 → fed stage', () => {
  assert.strictEqual(metabolicStageAtHour(0).key, 'fed');
});

test('hour 12 boundary → fat_mobilizing (inclusive on `from`)', () => {
  assert.strictEqual(metabolicStageAtHour(11.99).key, 'glycogen_depleting');
  assert.strictEqual(metabolicStageAtHour(12).key, 'fat_mobilizing');
});

test('hour 16 boundary → ketogenesis ramp', () => {
  assert.strictEqual(metabolicStageAtHour(15.99).key, 'fat_mobilizing');
  assert.strictEqual(metabolicStageAtHour(16).key, 'ketogenesis');
});

test('hour 24 boundary → switch_complete', () => {
  assert.strictEqual(metabolicStageAtHour(24).key, 'switch_complete');
});

test('hour 36 boundary → gh_surge', () => {
  assert.strictEqual(metabolicStageAtHour(36).key, 'gh_surge');
});

test('hour 100 (silly) → gh_surge (open-ended)', () => {
  assert.strictEqual(metabolicStageAtHour(100).key, 'gh_surge');
});

test('NaN / undefined → null', () => {
  assert.strictEqual(metabolicStageAtHour(NaN), null);
  assert.strictEqual(metabolicStageAtHour(undefined), null);
});

test('every stage with citation cites a primary source (no popular-press claims)', () => {
  const allowed = new Set([
    null,
    'de Cabo & Mattson 2019',
    'Anton 2018',
    'Anton 2018 (12-36h band)',
    'Hartman & Veldhuis 1992',
  ]);
  for (const s of METABOLIC_STAGES) {
    assert.ok(allowed.has(s.citation), `unexpected citation: ${s.citation}`);
  }
});

// ────────────────────────────────────────────────────────────────
section('sessionDeepestStage');

test('null on missing session / no actual_hours', () => {
  assert.strictEqual(sessionDeepestStage(null), null);
  assert.strictEqual(sessionDeepestStage({}), null);
  assert.strictEqual(sessionDeepestStage({ actual_hours: null }), null);
});

test('17h fast → ketogenesis ramp', () => {
  assert.strictEqual(sessionDeepestStage({ actual_hours: 17 }).key, 'ketogenesis');
});

// ────────────────────────────────────────────────────────────────
section('dropFutureSessions');

test('drops sessions with date > today', () => {
  const out = dropFutureSessions([
    { date: '2026-05-20' },
    { date: '2026-05-23' },  // today
    { date: '2026-05-24' },  // future
    { date: '2026-06-01' },  // future
  ], '2026-05-23');
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out.map(s => s.date), ['2026-05-20', '2026-05-23']);
});

test('keeps sessions with no date field (legacy)', () => {
  const out = dropFutureSessions([
    { date: '2026-05-20', actual_hours: 16 },
    { actual_hours: 14 },
  ], '2026-05-23');
  assert.strictEqual(out.length, 2);
});

test('returns all when today not provided', () => {
  const out = dropFutureSessions([{ date: '2099-01-01' }], null);
  assert.strictEqual(out.length, 1);
});

test('handles null/undefined input', () => {
  assert.deepStrictEqual(dropFutureSessions(null, '2026-05-23'), []);
  assert.deepStrictEqual(dropFutureSessions(undefined, '2026-05-23'), []);
});

// ────────────────────────────────────────────────────────────────
section('deriveFastQuality');

test('returns null when actual_hours missing', () => {
  assert.strictEqual(deriveFastQuality(null), null);
  assert.strictEqual(deriveFastQuality({}), null);
  assert.strictEqual(deriveFastQuality({ actual_hours: null }), null);
});

test('clean 16h fast on 16h target → high score (≥85)', () => {
  const q = deriveFastQuality(
    { actual_hours: 16, target_hours: 16, completed: true, broken_early: false },
    { protocol_target_hours: 16 }
  );
  assert.ok(q >= 85, `expected ≥85, got ${q}`);
});

test('broken 4h fast → low score (≤40)', () => {
  const q = deriveFastQuality(
    { actual_hours: 4, target_hours: 16, completed: false, broken_early: true },
    { protocol_target_hours: 16 }
  );
  assert.ok(q <= 40, `expected ≤40, got ${q}`);
});

test('clean 24h fast → very high (≥95)', () => {
  const q = deriveFastQuality(
    { actual_hours: 24, target_hours: 18, completed: true, broken_early: false },
    { protocol_target_hours: 18 }
  );
  assert.ok(q >= 95, `expected ≥95, got ${q}`);
});

test('long fast with poor refeed pulls score down', () => {
  const good = deriveFastQuality(
    { actual_hours: 26, target_hours: 24, completed: true, refeed_quality: 'good' },
    { protocol_target_hours: 24 }
  );
  const poor = deriveFastQuality(
    { actual_hours: 26, target_hours: 24, completed: true, refeed_quality: 'poor' },
    { protocol_target_hours: 24 }
  );
  assert.ok(good > poor, `good (${good}) should beat poor (${poor})`);
});

test('result always bounded [0, 100]', () => {
  const inputs = [
    { actual_hours: 0, target_hours: 16 },
    { actual_hours: 16, target_hours: 16, completed: true },
    { actual_hours: 100, target_hours: 16, completed: true },
  ];
  for (const s of inputs) {
    const q = deriveFastQuality(s, { protocol_target_hours: s.target_hours });
    assert.ok(q >= 0 && q <= 100, `out of bounds: ${q}`);
  }
});

// ────────────────────────────────────────────────────────────────
section('maturityRamp');

test('day 0 / missing → 0.40 floor', () => {
  assert.strictEqual(maturityRamp(0), 0.40);
  assert.strictEqual(maturityRamp(null), 0.40);
  assert.strictEqual(maturityRamp(undefined), 0.40);
});

test('day 3 → 0.45', () => {
  assert.strictEqual(maturityRamp(3), 0.45);
});

test('day 6 → 0.55, day 7 → 0.70 (boundary)', () => {
  assert.strictEqual(maturityRamp(6), 0.55);
  assert.strictEqual(maturityRamp(7), 0.70);
});

test('day 13 → 0.70, day 14 → 0.85 (boundary)', () => {
  assert.strictEqual(maturityRamp(13), 0.70);
  assert.strictEqual(maturityRamp(14), 0.85);
});

test('day 29 → 0.85, day 30 → 0.94 (boundary)', () => {
  assert.strictEqual(maturityRamp(29), 0.85);
  assert.strictEqual(maturityRamp(30), 0.94);
});

test('day 60+ → 1.00', () => {
  assert.strictEqual(maturityRamp(60), 1.00);
  assert.strictEqual(maturityRamp(365), 1.00);
});

test('monotonically non-decreasing', () => {
  let prev = -1;
  for (let d = 0; d <= 100; d++) {
    const r = maturityRamp(d);
    assert.ok(r >= prev, `day ${d}: ${r} < prev ${prev}`);
    prev = r;
  }
});

test('matches fitness curve exactly (philosophy parity)', () => {
  const fit = require('../lib/fitness-scoring').maturityRamp;
  for (const d of [0, 1, 3, 4, 6, 7, 13, 14, 29, 30, 59, 60, 100]) {
    assert.strictEqual(maturityRamp(d), fit(d), `mismatch at day ${d}`);
  }
});

// ────────────────────────────────────────────────────────────────
section('buildDayQualityByDate');

test('empty sessions → all days null between anchor and today', () => {
  const map = buildDayQualityByDate([], '2026-05-20', '2026-05-22');
  assert.strictEqual(Object.keys(map).length, 3);
  assert.strictEqual(map['2026-05-20'], null);
  assert.strictEqual(map['2026-05-22'], null);
});

test('logged days get quality 0-100, unlogged stay null', () => {
  const map = buildDayQualityByDate(
    [{ date: '2026-05-21', actual_hours: 16, target_hours: 16, completed: true }],
    '2026-05-20', '2026-05-22'
  );
  assert.strictEqual(map['2026-05-20'], null);
  assert.ok(Number.isFinite(map['2026-05-21']));
  assert.strictEqual(map['2026-05-22'], null);
});

test('multiple sessions same day → max quality wins', () => {
  const map = buildDayQualityByDate([
    { date: '2026-05-21', actual_hours: 4, target_hours: 16, broken_early: true },
    { date: '2026-05-21', actual_hours: 18, target_hours: 16, completed: true },
  ], '2026-05-21', '2026-05-21');
  // Should be the clean 18h, not the broken 4h
  assert.ok(map['2026-05-21'] >= 80);
});

test('sessions outside anchor → today range ignored', () => {
  const map = buildDayQualityByDate(
    [{ date: '2026-01-01', actual_hours: 18, completed: true }],
    '2026-05-20', '2026-05-22'
  );
  assert.strictEqual(map['2026-01-01'], undefined);
});

test('anchor > today returns empty map (defensive)', () => {
  const map = buildDayQualityByDate([], '2026-05-25', '2026-05-20');
  assert.deepStrictEqual(map, {});
});

// ────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
