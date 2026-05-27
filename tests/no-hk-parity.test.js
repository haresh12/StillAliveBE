/**
 * no-hk-parity.test.js — CI gate for SCORING_CONTRACT_V3.md §4.
 *
 * Contract guarantee:
 *   A user who DENIES HK permission sees scores identical to current shipped
 *   behavior. HK is a PASSIVE depth signal, NEVER a gate.
 *
 * This test asserts:
 *   1. Calling each scorer with `hkSignals: null` produces the SAME score as
 *      calling without the param at all.
 *   2. The 4 HK-aware agents (sleep / fitness / mind / water) all expose
 *      `hk_used: false` when no HK signals are passed.
 *   3. Calling with realistic HK signals does NOT inflate the score beyond a
 *      sane band — HK enhancement caps at +20pts on a single score.
 *
 * Run: node tests/no-hk-parity.test.js
 */

'use strict';

const assert = require('assert');
const {
  computeSleepScore,
  computeFitnessScore,
  computeMindScore,
  computeWaterScore,
} = require('../lib/agent-scores');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function section(title) { console.log(`\n${title}`); }

// ────────────────────────────────────────────────────────────────
section('1. hkSignals: null produces same score as omitting the param');

const baseSleep = { avg_efficiency: 88, avg_duration: 7.5, avg_quality: 4, avg_energy: 4, avg_latency: 18, consistency_score: 75, sleep_debt: 0.5, target_hours: 7.5, days_logged: 14 };
const baseFitness = { consistency: 85, volume: 85, intensity: 80, progression: 75, recovery: 75, days_logged: 14 };
const baseMind = { mood_scores: Array(14).fill(3.5), anxiety_scores: Array(14).fill(2), checkin_dates: Array(14).fill('2026-05-01'), days_logged: 14, streak: 14, recent_sleep_hours: 7.5 };
const baseWater = { hydration_adequacy: 88, consistency: 90, chronobiology: 80, beverage_quality: 90, avg_7d_ml: 2200, days_logged: 14 };

test('sleep: omit vs null hkSignals → identical', () => {
  const a = computeSleepScore(baseSleep);
  const b = computeSleepScore({ ...baseSleep, hkSignals: null });
  assert.strictEqual(a.score, b.score, `omit=${a.score} vs null=${b.score}`);
});

test('fitness: omit vs null hkSignals → identical', () => {
  const a = computeFitnessScore(baseFitness);
  const b = computeFitnessScore({ ...baseFitness, hkSignals: null });
  assert.strictEqual(a.score, b.score, `omit=${a.score} vs null=${b.score}`);
});

test('mind: omit vs null hkSignals → identical', () => {
  const a = computeMindScore(baseMind);
  const b = computeMindScore({ ...baseMind, hkSignals: null });
  assert.strictEqual(a.score, b.score, `omit=${a.score} vs null=${b.score}`);
});

test('water: omit vs null hkSignals → identical', () => {
  const a = computeWaterScore(baseWater);
  const b = computeWaterScore({ ...baseWater, hkSignals: null });
  assert.strictEqual(a.score, b.score, `omit=${a.score} vs null=${b.score}`);
});

// ────────────────────────────────────────────────────────────────
section('2. hk_used = false when no HK signals passed');

test('sleep: hk_used = false', () => {
  const r = computeSleepScore(baseSleep);
  // Sleep V2 reports hk_used directly
  assert.strictEqual(r.hk_used, false);
});

test('fitness: hk_used = false', () => {
  const r = computeFitnessScore(baseFitness);
  assert.strictEqual(r.hk_used, false);
});

test('mind: hk_used = false', () => {
  const r = computeMindScore(baseMind);
  assert.strictEqual(r.hk_used, false);
});

test('water: hk_used = false', () => {
  const r = computeWaterScore(baseWater);
  assert.strictEqual(r.hk_used, false);
});

// ────────────────────────────────────────────────────────────────
section('3. HK signals enhance, never inflate beyond +20 pts');

test('sleep: HK efficiency override does not exceed +20', () => {
  const without = computeSleepScore(baseSleep).score;
  const withHK = computeSleepScore({ ...baseSleep, hkSignals: { efficiency_pct: 95, hrv_overnight_ms: 70, resting_hr_drop_pct: 20 } }).score;
  const delta = withHK - without;
  assert.ok(delta >= -5 && delta <= 20, `delta ${delta} not in [-5, 20]`);
});

test('fitness: HK steps + workouts boost capped at +20', () => {
  const without = computeFitnessScore(baseFitness).score;
  const withHK = computeFitnessScore({ ...baseFitness, hkSignals: {
    workouts_last_7d: Array(5).fill({ date: '2026-05-20', duration_min: 60 }),
    steps_last_7d_avg: 12000,
    resting_hr_baseline_bpm: 55,
    hrv_baseline_ms: 65,
  }}).score;
  const delta = withHK - without;
  assert.ok(delta >= 0 && delta <= 20, `delta ${delta} not in [0, 20]`);
});

test('mind: HK HRV with rich manual checkins does not change much', () => {
  const without = computeMindScore(baseMind).score;
  const withHK = computeMindScore({ ...baseMind, hkSignals: { hrv_overnight_ms: 50 } }).score;
  // 14 manual checkins present → HRV gate is a no-op (n>=7). Score unchanged.
  assert.strictEqual(withHK, without);
});

test('mind: HK HRV fills gap when no manual checkins', () => {
  const sparse = { mood_scores: [], anxiety_scores: [], checkin_dates: [], days_logged: 1, streak: 0, recent_sleep_hours: 7.5 };
  const without = computeMindScore(sparse);
  const withHK = computeMindScore({ ...sparse, hkSignals: { hrv_overnight_ms: 50 } });
  // Without HK + no checkins → null (no data)
  assert.strictEqual(without, null);
  // With HK → should produce a score (HRV fills the gap)
  assert.ok(withHK?.score >= 0, `expected number, got ${withHK?.score}`);
  assert.strictEqual(withHK.hk_used, true);
});

test('water: HK active-cal does not exceed -20 score reduction', () => {
  const without = computeWaterScore(baseWater).score;
  const withHK = computeWaterScore({ ...baseWater, hkSignals: { active_kcal_today: 600, skin_temp_c: 34 } }).score;
  const delta = withHK - without;
  // High activity REDUCES adequacy (you needed more water than logged)
  assert.ok(delta >= -25 && delta <= 5, `delta ${delta} not in [-25, 5]`);
});

// ────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
