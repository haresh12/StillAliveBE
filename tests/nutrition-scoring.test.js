/**
 * Nutrition scoring + future-log filter — contract tests (2026-05-26).
 *
 * Locks in the V3 honesty laws for nutrition:
 *   • dropFutureLogs: future-dated logs never inflate analytics.
 *   • maturityRamp: tiered 0.40 (day-1) → 1.00 (day-60+), monotonic non-
 *     decreasing.
 *   • deriveMealQuality / buildDayQualityByDate: per-meal + per-day quality
 *     are deterministic + handle empty input.
 *   • computeBlendedNutritionScore: 5 gates, weighted sum, clamped 0-100,
 *     maturity-ramp applied last.
 *   • computeBlendedNutritionScoreLegacy: backward-compat wrapper still
 *     accepts the pre-V3 inputs.
 *
 * Run: node tests/nutrition-scoring.test.js
 */

'use strict';

const assert = require('assert');
const {
  maturityRamp,
  dropFutureLogs,
  deriveMealQuality,
  buildDayQualityByDate,
  deriveCalorieAdherence,
  deriveProteinAdherence,
  deriveMacroBalance,
  deriveVariety,
  deriveConsistency,
  computeBlendedNutritionScore,
  computeBlendedNutritionScoreLegacy,
} = require('../lib/nutrition-scoring');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function section(title) { console.log(`\n${title}`); }

// ─── maturityRamp ────────────────────────────────────────────────
section('maturityRamp');

test('day 1 returns 0.45 (just above day-0 floor)', () => {
  assert.strictEqual(maturityRamp(1), 0.45);
});
test('day 0 / null returns 0.40 (defensive floor)', () => {
  assert.strictEqual(maturityRamp(0), 0.40);
  assert.strictEqual(maturityRamp(null), 0.40);
});
test('day 4 returns 0.55', () => {
  assert.strictEqual(maturityRamp(4), 0.55);
});
test('day 7 returns 0.70', () => {
  assert.strictEqual(maturityRamp(7), 0.70);
});
test('day 14 returns 0.85', () => {
  assert.strictEqual(maturityRamp(14), 0.85);
});
test('day 30 returns 0.94', () => {
  assert.strictEqual(maturityRamp(30), 0.94);
});
test('day 60 returns 1.00', () => {
  assert.strictEqual(maturityRamp(60), 1.00);
});
test('day 120 returns 1.00', () => {
  assert.strictEqual(maturityRamp(120), 1.00);
});
test('monotonically non-decreasing across full range', () => {
  let prev = -Infinity;
  for (let d = 0; d <= 365; d++) {
    const v = maturityRamp(d);
    assert(v >= prev, `failed at d=${d}: ${v} < ${prev}`);
    prev = v;
  }
});

// ─── dropFutureLogs ──────────────────────────────────────────────
section('dropFutureLogs');

test('drops logs with date > today', () => {
  const today = '2026-05-26';
  const logs = [
    { date: '2026-05-25' }, { date: '2026-05-26' }, { date: '2026-05-27' },
  ];
  const kept = dropFutureLogs(logs, today);
  assert.strictEqual(kept.length, 2);
  assert(kept.every(l => l.date <= today));
});
test('returns a slice (does not mutate)', () => {
  const logs = [{ date: '2026-05-25' }];
  const kept = dropFutureLogs(logs, '2026-05-26');
  assert.notStrictEqual(kept, logs);
});
test('handles missing date field (legacy logs)', () => {
  const logs = [{ name: 'no-date' }, { date: '2026-05-25' }];
  const kept = dropFutureLogs(logs, '2026-05-26');
  assert.strictEqual(kept.length, 2);
});
test('empty / non-array input returns empty array', () => {
  assert.deepStrictEqual(dropFutureLogs(null, '2026-05-26'), []);
  assert.deepStrictEqual(dropFutureLogs(undefined, '2026-05-26'), []);
});

// ─── deriveMealQuality ───────────────────────────────────────────
section('deriveMealQuality');

test('perfect 1-of-3 meal scores ~100', () => {
  // 700 kcal target per meal, ~45g protein per meal (3 meals/day)
  const q = deriveMealQuality({
    calories_kcal: 700, protein_g: 45, carb_g: 80, fat_g: 25,
  }, { dailyCalTarget: 2100, dailyProteinTarget: 135, mealsPerDay: 3 });
  assert(q >= 85, `expected ≥85, got ${q}`);
});
test('low-cal under-protein meal scores < 60', () => {
  const q = deriveMealQuality({
    calories_kcal: 200, protein_g: 5, carb_g: 30, fat_g: 5,
  }, { dailyCalTarget: 2100, dailyProteinTarget: 135, mealsPerDay: 3 });
  assert(q < 60, `expected <60, got ${q}`);
});
test('null input returns null (not 0)', () => {
  assert.strictEqual(deriveMealQuality(null), null);
});

// ─── buildDayQualityByDate ───────────────────────────────────────
section('buildDayQualityByDate');

test('returns null for days with no meals (distinguishes from low quality)', () => {
  const out = buildDayQualityByDate([
    { date: '2026-05-24', calories_kcal: 700, protein_g: 45, carb_g: 70, fat_g: 25 },
  ], { anchorDate: '2026-05-22', todayDate: '2026-05-26', dailyCalTarget: 2100, dailyProteinTarget: 135 });
  assert.strictEqual(out['2026-05-22'], null);
  assert.strictEqual(out['2026-05-23'], null);
  assert(out['2026-05-24'] > 0);
  assert.strictEqual(out['2026-05-25'], null);
});
test('averages meal qualities per day', () => {
  const out = buildDayQualityByDate([
    { date: '2026-05-25', calories_kcal: 700, protein_g: 45 },
    { date: '2026-05-25', calories_kcal: 300, protein_g: 5 },
  ], { anchorDate: '2026-05-25', todayDate: '2026-05-25', dailyCalTarget: 2100, dailyProteinTarget: 135 });
  assert(out['2026-05-25'] >= 0 && out['2026-05-25'] <= 100);
});

// ─── Gates ────────────────────────────────────────────────────────
section('Gates');

test('calorie adherence — ±20% band scores 100', () => {
  const keys = ['2026-05-25', '2026-05-26'];
  const dayKcal = { '2026-05-25': 1900, '2026-05-26': 2100 };
  const target = { '2026-05-25': 2000, '2026-05-26': 2000 };
  const s = deriveCalorieAdherence(dayKcal, target, keys);
  assert.strictEqual(s, 100);
});
test('calorie adherence — empty day scores 0', () => {
  const keys = ['2026-05-25'];
  const s = deriveCalorieAdherence({}, { '2026-05-25': 2000 }, keys);
  assert.strictEqual(s, 0);
});
test('protein adherence — hits target = 100', () => {
  const s = deriveProteinAdherence(
    { '2026-05-26': 140 },
    { '2026-05-26': 140 },
    ['2026-05-26'],
  );
  assert.strictEqual(s, 100);
});
test('macro balance — AMDR-in-band day scores 100', () => {
  // 50% C, 25% F, 25% P → all in band
  const s = deriveMacroBalance({
    '2026-05-26': { carb_g: 250, fat_g: 56, protein_g: 125 },  // 1000c+500f+500p = 2000 kcal
  }, ['2026-05-26']);
  assert.strictEqual(s, 100);
});
test('variety — 30 unique foods over 28d → ~100', () => {
  const logs = Array.from({ length: 30 }, (_, i) => ({
    date: '2026-05-26', food_name: `food-${i}`,
  }));
  const s = deriveVariety(logs, ['2026-05-26'], 28);
  assert(s >= 90, `expected ≥90, got ${s}`);
});
test('consistency — every day logged + 14d streak → 100', () => {
  const dayKcal = {};
  const keys = [];
  for (let i = 0; i < 7; i++) {
    const k = `2026-05-${20 + i}`;
    keys.push(k);
    dayKcal[k] = 2000;
  }
  const s = deriveConsistency(dayKcal, keys, 14);
  assert(s >= 95, `expected ≥95, got ${s}`);
});

// ─── computeBlendedNutritionScore ────────────────────────────────
section('computeBlendedNutritionScore');

test('day-1 perfect logger lands in 30-40 band (maturity ramp)', () => {
  const keys = ['2026-05-26'];
  const out = computeBlendedNutritionScore({
    dayKcalByDate: { '2026-05-26': 2000 },
    dayProteinByDate: { '2026-05-26': 140 },
    dayMacrosByDate: { '2026-05-26': { carb_g: 250, fat_g: 56, protein_g: 140 } },
    targetKcalByDate: { '2026-05-26': 2000 },
    targetProteinByDate: { '2026-05-26': 140 },
    logs: [{ date: '2026-05-26', food_name: 'eggs' }, { date: '2026-05-26', food_name: 'oats' }],
    recentKeys: keys,
    daysSinceAnchor: 1,
    streak: 1,
    spanDays: 1,
  });
  assert(out.score >= 30 && out.score <= 45, `day-1 perfect should be 30-45, got ${out.score}`);
  assert(out.raw_score > out.score, 'raw should exceed ramped score on day-1');
});
test('mature (day-60+) perfect logger lands at or near 100', () => {
  const keys = [];
  const dayKcal = {};
  const dayProt = {};
  const dayMacros = {};
  const targetKcal = {};
  const targetProt = {};
  for (let i = 0; i < 7; i++) {
    const k = `2026-05-${20 + i}`;
    keys.push(k);
    dayKcal[k] = 2000;
    dayProt[k] = 140;
    dayMacros[k] = { carb_g: 250, fat_g: 56, protein_g: 140 };
    targetKcal[k] = 2000;
    targetProt[k] = 140;
  }
  const out = computeBlendedNutritionScore({
    dayKcalByDate: dayKcal,
    dayProteinByDate: dayProt,
    dayMacrosByDate: dayMacros,
    targetKcalByDate: targetKcal,
    targetProteinByDate: targetProt,
    logs: Array.from({ length: 30 }, (_, i) => ({ date: keys[i % 7], food_name: `f-${i}` })),
    recentKeys: keys,
    daysSinceAnchor: 90,
    streak: 14,
    spanDays: 7,
  });
  assert(out.score >= 90, `mature perfect should be ≥90, got ${out.score}`);
});
test('returns null for empty window', () => {
  const out = computeBlendedNutritionScore({
    recentKeys: [],
    daysSinceAnchor: 30,
  });
  assert.strictEqual(out, null);
});

// ─── Legacy wrapper ──────────────────────────────────────────────
section('computeBlendedNutritionScoreLegacy');

test('still applies maturity ramp on legacy shape', () => {
  const out = computeBlendedNutritionScoreLegacy({
    calorie_adherence: 100, protein_adherence: 100, streak: 7, macro_balance: 80, days_logged: 1,
  });
  assert(out.score >= 35 && out.score <= 45, `day-1 legacy should be 35-45, got ${out.score}`);
});
test('returns null when no adherence data', () => {
  const out = computeBlendedNutritionScoreLegacy({});
  assert.strictEqual(out, null);
});

// ─── Summary ─────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
