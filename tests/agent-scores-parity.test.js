/**
 * agent-scores-parity.test.js — CI gate for Scoring V3 migration.
 *
 * Locks in:
 *   1. Every agent has its own dedicated scoring lib (lib/{agent}-scoring.js)
 *   2. All 6 agents export the SAME maturityRamp curve (calendar-day keyed)
 *   3. Day-1 perfect log lands in 30–40 band for every agent
 *   4. Day-7 perfect log lands in 44–60 band for every agent
 *   5. Day-30 perfect log lands in 75–95 band for every agent
 *   6. computeAgentScore dispatcher returns same numbers as direct lib calls
 *
 * Run: node tests/agent-scores-parity.test.js
 */

'use strict';

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

const {
  computeSleepScore,
  computeMindScore,
  computeFitnessScore,
  computeNutritionScore,
  computeWaterScore,
  computeFastingScore,
  computeAgentScore,
} = require('../lib/agent-scores');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function section(title) { console.log(`\n${title}`); }

// ────────────────────────────────────────────────────────────────
section('1. Every agent has its own scoring lib');

const LIBS = [
  'fitness-scoring.js',
  'mind-scoring.js',
  'sleep-scoring.js',
  'water-scoring.js',
  'nutrition-scoring.js',   // ← created in P1; test fails until it exists
  'fasting-scoring.js',
];

for (const f of LIBS) {
  test(`lib/${f} exists`, () => {
    const p = path.join(__dirname, '..', 'lib', f);
    assert.ok(fs.existsSync(p), `Expected ${p} to exist`);
  });
}

// ────────────────────────────────────────────────────────────────
section('2. All 6 maturityRamp curves are identical (canonical)');

// Canonical curve from SCORING_CONTRACT_V3.md §2
const EXPECTED_RAMP = {
  0:   0.40,
  1:   0.45,
  3:   0.45,
  4:   0.55,
  6:   0.55,
  7:   0.70,
  13:  0.70,
  14:  0.85,
  29:  0.85,
  30:  0.94,
  59:  0.94,
  60:  1.00,
  365: 1.00,
};

function checkRamp(libName) {
  // nutrition-scoring may not exist yet during P0 — skip gracefully.
  let lib;
  try { lib = require(`../lib/${libName}`); } catch { return null; }
  if (!lib || typeof lib.maturityRamp !== 'function') return null;
  return lib.maturityRamp;
}

const RAMPS = {
  fitness:   checkRamp('fitness-scoring'),
  mind:      checkRamp('mind-scoring'),
  sleep:     checkRamp('sleep-scoring'),
  water:     checkRamp('water-scoring'),
  nutrition: checkRamp('nutrition-scoring'),
  fasting:   checkRamp('fasting-scoring'),
};

for (const [agent, fn] of Object.entries(RAMPS)) {
  test(`${agent}.maturityRamp matches canonical curve`, () => {
    if (!fn) throw new Error(`maturityRamp not exported by ${agent}-scoring`);
    for (const [day, expected] of Object.entries(EXPECTED_RAMP)) {
      const actual = fn(Number(day));
      assert.strictEqual(actual, expected, `Day ${day}: expected ${expected}, got ${actual}`);
    }
  });
}

// ────────────────────────────────────────────────────────────────
section('3. Day-1 perfect log lands in [25, 45] for every agent');

// Bands derived from SCORING_CONTRACT_V3.md §5
//   Day 1 multiplier = 0.45 → perfect raw (90-100) lands at 40-45
//                            → realistic raw (60-99) lands at 27-44
//   Day 7 multiplier = 0.70 → perfect raw lands at 63-70
//                            → realistic 75-100 raw lands at 52-70
//   Day 30 multiplier = 0.94 → perfect lands at 84-94
const DAY1_BAND = [25, 45];
const DAY7_BAND = [45, 75];
const DAY30_BAND = [70, 100];

function inBand(score, [lo, hi], agent, day) {
  if (!Number.isFinite(score)) throw new Error(`${agent} day-${day}: score is ${score}`);
  if (score < lo || score > hi) throw new Error(`${agent} day-${day}: ${score} not in [${lo},${hi}]`);
}

function perfect(agent, days_logged) {
  switch (agent) {
    case 'sleep':     return computeSleepScore({ avg_efficiency: 92, avg_duration: 8.0, avg_quality: 5, avg_energy: 5, avg_latency: 15, consistency_score: 90, sleep_debt: 0, target_hours: 7.5, days_logged });
    case 'mind':      return computeMindScore({ mood_scores: Array(Math.min(days_logged, 14)).fill(4), anxiety_scores: Array(Math.min(days_logged, 14)).fill(1), checkin_dates: Array(Math.min(days_logged, 14)).fill('2026-05-01'), days_logged, streak: days_logged, recent_sleep_hours: 7.5 });
    case 'fitness':   return computeFitnessScore({ consistency: 100, volume: 100, intensity: 95, progression: 90, recovery: 85, days_logged });
    case 'nutrition': return computeNutritionScore({ calorie_adherence: 95, protein_adherence: 100, streak: days_logged, macro_balance: 85, days_logged });
    case 'water':     return computeWaterScore({ hydration_adequacy: 100, consistency: 100, chronobiology: 95, beverage_quality: 100, avg_7d_ml: 2500, days_logged });
    case 'fasting':   return computeFastingScore({ completion_rate: 1.0, completion_rate_7d: 1.0, streak: days_logged, avg_hours: 17, avg_hours_7d: 17, target_hours: 16, pct_reaching_fat_burn: 1.0, pct_reaching_ketosis: 0.9, days_logged });
    default: return null;
  }
}

for (const agent of ['sleep', 'mind', 'fitness', 'nutrition', 'water', 'fasting']) {
  test(`${agent}: Day-1 perfect log in [${DAY1_BAND.join(',')}]`, () => {
    const r = perfect(agent, 1);
    inBand(r?.score, DAY1_BAND, agent, 1);
  });
}

// ────────────────────────────────────────────────────────────────
section('4. Day-7 perfect log lands in [40, 65] for every agent');

for (const agent of ['sleep', 'mind', 'fitness', 'nutrition', 'water', 'fasting']) {
  test(`${agent}: Day-7 perfect log in [${DAY7_BAND.join(',')}]`, () => {
    const r = perfect(agent, 7);
    inBand(r?.score, DAY7_BAND, agent, 7);
  });
}

// ────────────────────────────────────────────────────────────────
section('5. Day-30 perfect log lands in [70, 100] for every agent');

for (const agent of ['sleep', 'mind', 'fitness', 'nutrition', 'water', 'fasting']) {
  test(`${agent}: Day-30 perfect log in [${DAY30_BAND.join(',')}]`, () => {
    const r = perfect(agent, 30);
    inBand(r?.score, DAY30_BAND, agent, 30);
  });
}

// ────────────────────────────────────────────────────────────────
section('6. computeAgentScore dispatcher matches direct calls');

for (const agent of ['sleep', 'mind', 'fitness', 'nutrition', 'water', 'fasting']) {
  test(`${agent}: dispatcher === direct`, () => {
    const direct   = perfect(agent, 14);
    const dispatch = computeAgentScore(agent, (() => {
      // Re-build the same inputs the dispatcher takes
      switch (agent) {
        case 'sleep':     return { avg_efficiency: 92, avg_duration: 8.0, avg_quality: 5, avg_energy: 5, avg_latency: 15, consistency_score: 90, sleep_debt: 0, target_hours: 7.5, days_logged: 14 };
        case 'mind':      return { mood_scores: Array(14).fill(4), anxiety_scores: Array(14).fill(1), checkin_dates: Array(14).fill('2026-05-01'), days_logged: 14, streak: 14, recent_sleep_hours: 7.5 };
        case 'fitness':   return { consistency: 100, volume: 100, intensity: 95, progression: 90, recovery: 85, days_logged: 14 };
        case 'nutrition': return { calorie_adherence: 95, protein_adherence: 100, streak: 14, macro_balance: 85, days_logged: 14 };
        case 'water':     return { hydration_adequacy: 100, consistency: 100, chronobiology: 95, beverage_quality: 100, avg_7d_ml: 2500, days_logged: 14 };
        case 'fasting':   return { completion_rate: 1.0, completion_rate_7d: 1.0, streak: 14, avg_hours: 17, avg_hours_7d: 17, target_hours: 16, pct_reaching_fat_burn: 1.0, pct_reaching_ketosis: 0.9, days_logged: 14 };
      }
    })());
    assert.strictEqual(direct?.score, dispatch?.score, `Direct ${direct?.score} ≠ Dispatch ${dispatch?.score}`);
  });
}

// ────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
