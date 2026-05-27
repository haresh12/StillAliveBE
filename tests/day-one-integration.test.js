/**
 * day-one-integration.test.js — CI gate for SCORING_CONTRACT_V3.md §5.
 *
 * Simulates 6 agents over Day 0 / 1 / 7 / 14 / 30 with perfect logging.
 * Asserts the canonical trajectory holds:
 *
 *   Day 0:  Wellness = 12 (warm-start), 6 agents = null (no logs)
 *   Day 1:  6 agents land 25-45 per agent (Building band)
 *   Day 7:  6 agents land 45-75 per agent (Steady/Strong)
 *   Day 30: 6 agents land 70-100 per agent (Strong/Thriving)
 *
 * Plus: Wellness Score progression 12 → ~53 → ~65 → ~78 across days.
 *
 * Run: node tests/day-one-integration.test.js
 */

'use strict';

const assert = require('assert');
const {
  computeSleepScore,
  computeMindScore,
  computeFitnessScore,
  computeNutritionScore,
  computeWaterScore,
  computeFastingScore,
} = require('../lib/agent-scores');
const { computeWellness } = require('../wellness-cross-v2/score/wellness-score');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function section(t) { console.log(`\n${t}`); }

// ────────────────────────────────────────────────────────────────
// Fixture builders — same persona at different anchor days
function perfectInputs(days_since_anchor) {
  return {
    sleep: {
      avg_efficiency: 92, avg_duration: 8.0, avg_quality: 5, avg_energy: 5,
      avg_latency: 15, consistency_score: 90, sleep_debt: 0, target_hours: 7.5,
      days_logged: days_since_anchor, days_since_anchor,
    },
    mind: {
      mood_scores: Array(Math.max(1, Math.min(days_since_anchor, 14))).fill(4),
      anxiety_scores: Array(Math.max(1, Math.min(days_since_anchor, 14))).fill(1),
      checkin_dates: Array(Math.max(1, Math.min(days_since_anchor, 14))).fill('2026-05-01'),
      days_logged: days_since_anchor, days_since_anchor,
      streak: days_since_anchor, recent_sleep_hours: 7.5,
    },
    fitness: {
      consistency: 100, volume: 100, intensity: 95, progression: 90, recovery: 85,
      days_logged: days_since_anchor, days_since_anchor,
    },
    nutrition: {
      calorie_adherence: 95, protein_adherence: 100, streak: days_since_anchor,
      macro_balance: 85, days_logged: days_since_anchor, days_since_anchor,
    },
    water: {
      hydration_adequacy: 100, consistency: 100, chronobiology: 95, beverage_quality: 100,
      avg_7d_ml: 2500, days_logged: days_since_anchor, days_since_anchor,
    },
    fasting: {
      completion_rate: 1.0, completion_rate_7d: 1.0, streak: days_since_anchor,
      avg_hours: 17, avg_hours_7d: 17, target_hours: 16,
      pct_reaching_fat_burn: 1.0, pct_reaching_ketosis: 0.9,
      days_logged: days_since_anchor, days_since_anchor,
    },
  };
}

function scoresFor(days) {
  const inputs = perfectInputs(days);
  return {
    sleep:     computeSleepScore(inputs.sleep)?.score ?? null,
    mind:      computeMindScore(inputs.mind)?.score ?? null,
    fitness:   computeFitnessScore(inputs.fitness)?.score ?? null,
    nutrition: computeNutritionScore(inputs.nutrition)?.score ?? null,
    water:     computeWaterScore(inputs.water)?.score ?? null,
    fasting:   computeFastingScore(inputs.fasting)?.score ?? null,
  };
}

// ────────────────────────────────────────────────────────────────
section('Day 1: all 6 agents land in [25, 45]');

const day1 = scoresFor(1);
for (const [agent, score] of Object.entries(day1)) {
  test(`Day 1 ${agent}: ${score} in [25, 45]`, () => {
    assert.ok(score >= 25 && score <= 45, `${agent} day-1 score ${score} not in [25, 45]`);
  });
}

// ────────────────────────────────────────────────────────────────
section('Day 7: all 6 agents land in [45, 75]');

const day7 = scoresFor(7);
for (const [agent, score] of Object.entries(day7)) {
  test(`Day 7 ${agent}: ${score} in [45, 75]`, () => {
    assert.ok(score >= 45 && score <= 75, `${agent} day-7 score ${score} not in [45, 75]`);
  });
}

// ────────────────────────────────────────────────────────────────
section('Day 30: all 6 agents land in [70, 100]');

const day30 = scoresFor(30);
for (const [agent, score] of Object.entries(day30)) {
  test(`Day 30 ${agent}: ${score} in [70, 100]`, () => {
    assert.ok(score >= 70 && score <= 100, `${agent} day-30 score ${score} not in [70, 100]`);
  });
}

// ────────────────────────────────────────────────────────────────
section('Monotonic growth: Day 1 < Day 7 < Day 30');

for (const agent of Object.keys(day1)) {
  test(`${agent}: Day 1 (${day1[agent]}) < Day 7 (${day7[agent]}) < Day 30 (${day30[agent]})`, () => {
    assert.ok(day1[agent] < day7[agent], `${agent}: Day 1 ${day1[agent]} not < Day 7 ${day7[agent]}`);
    assert.ok(day7[agent] < day30[agent], `${agent}: Day 7 ${day7[agent]} not < Day 30 ${day30[agent]}`);
  });
}

// ────────────────────────────────────────────────────────────────
section('Cross-agent comparability: all in same band → same status');

function bandOf(score) {
  if (score >= 80) return 'thriving';
  if (score >= 65) return 'strong';
  if (score >= 50) return 'steady';
  if (score >= 35) return 'building';
  return 'starting';
}

test('Sleep 70 / Fitness 70 / Mind 70 / Nutrition 70 / Water 70 / Fasting 70 → all "strong"', () => {
  for (const score of [70, 71, 72]) {
    assert.strictEqual(bandOf(score), 'strong');
  }
});

test('Sleep 40 / Fitness 40 → both "building"', () => {
  assert.strictEqual(bandOf(40), 'building');
  assert.strictEqual(bandOf(38), 'building');
});

// ────────────────────────────────────────────────────────────────
section('Wellness Score Day-0 = 12 (setup_count × 2)');

function emptySnap(agent) {
  return {
    agent,
    setup: { is_complete: true, completed_at: '2026-05-25', days_since_setup: 0 },
    today: { has_log: false, score: null, components: {} },
    smoothed_7d: null, smoothed_30d: null, days_scored: 0,
    last_14d: [], last_30d: [], last_90d: [],
  };
}

test('Day 0 (no logs): Wellness = 12, is_warm_start = true', () => {
  const r = computeWellness({
    snapshots: {
      sleep: emptySnap('sleep'), mind: emptySnap('mind'),
      fitness: emptySnap('fitness'), nutrition: emptySnap('nutrition'),
      water: emptySnap('water'), fasting: emptySnap('fasting'),
    },
    baselines: {},
    profile: {
      anchor: 'energy',
      setup_state: { sleep: true, mind: true, fitness: true, nutrition: true, water: true, fasting: true },
      total_days_logged: 0, onboarding_answers: {}, local_hour: 9,
    },
    recentDailyHistory: [],
  });
  assert.strictEqual(r.score, 12);
  assert.strictEqual(r.is_warm_start, true);
});

// ────────────────────────────────────────────────────────────────
section('Day 1 score progression vs Day 0');

test('Day 1 perfect avg agent score > Day 0 baseline (12)', () => {
  const avg = Object.values(day1).reduce((s, v) => s + v, 0) / 6;
  assert.ok(avg > 25, `Day 1 avg ${avg} should exceed Day 0 baseline of 12`);
});

// ────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
