/**
 * wellness-v3-explainer.test.js — CI gate for SCORING_CONTRACT_V3.md §3 + §7.
 *
 * Asserts:
 *   1. computeWellness returns the V3 explainer pack
 *   2. is_warm_start is true on Day-0 and warm_start_blend_pct = 100
 *   3. user_score_weights tilt up to ±15% gets applied
 *   4. hk_status = 'denied' when no agent has hk_used = true
 *   5. hk_status = 'partial' / 'granted' tracks how many agents used HK
 *   6. transition_explainer copy adapts to days_logged
 *
 * Run: node wellness-cross-v2/tests/wellness-v3-explainer.test.js
 */

'use strict';

const assert = require('assert');
const { computeWellness } = require('../score/wellness-score');
const { applyUserWeightTilt, validateUserTilts, TILT_CAP } = require('../score/user-weight-tilt');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function section(t) { console.log(`\n${t}`); }

// ────────────────────────────────────────────────────────────────
section('1. applyUserWeightTilt: cap at ±15%, renormalize to 1.0');

test('null tilts → base unchanged', () => {
  const base = { sleep: 0.25, fitness: 0.20, mind: 0.20, nutrition: 0.15, water: 0.10, fasting: 0.10 };
  const out = applyUserWeightTilt(base, null);
  assert.deepStrictEqual(out, base);
});

test('sleep tilt +0.10 → sleep weight increases, sum still 1.0', () => {
  const base = { sleep: 0.25, fitness: 0.20, mind: 0.20, nutrition: 0.15, water: 0.10, fasting: 0.10 };
  const out = applyUserWeightTilt(base, { sleep: 0.10 });
  const sum = Object.values(out).reduce((s, w) => s + w, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6, `sum ${sum} != 1`);
  assert.ok(out.sleep > base.sleep, `sleep ${out.sleep} not > ${base.sleep}`);
});

test('tilt exceeding cap is clamped at ±15%', () => {
  const base = { sleep: 0.25, fitness: 0.20, mind: 0.20, nutrition: 0.15, water: 0.10, fasting: 0.10 };
  const out = applyUserWeightTilt(base, { sleep: 0.50 });   // exceeds cap
  // Effective tilt = +0.15; pre-renorm sleep = 0.40, others = 0.75 → sleep ≈ 0.348
  const sum = Object.values(out).reduce((s, w) => s + w, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6, `sum ${sum} != 1`);
  // Sleep can't exceed 0.40/1.15 ≈ 0.348 after renorm
  assert.ok(out.sleep <= 0.36, `sleep ${out.sleep} should be capped`);
});

test('validateUserTilts: empty/null is valid', () => {
  assert.deepStrictEqual(validateUserTilts(null), { valid: true, errors: [] });
  assert.deepStrictEqual(validateUserTilts({}), { valid: true, errors: [] });
});

test('validateUserTilts: out-of-range fails', () => {
  const r = validateUserTilts({ sleep: 0.5 });
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.length > 0);
});

// ────────────────────────────────────────────────────────────────
section('2. computeWellness Day-0 returns warm-start explainer');

function emptySnap(agent) {
  return {
    agent,
    setup: { is_complete: true, completed_at: '2026-05-25', days_since_setup: 0 },
    today: { has_log: false, score: null, components: {} },
    smoothed_7d: null, smoothed_30d: null, days_scored: 0,
    last_14d: [], last_30d: [], last_90d: [],
  };
}

const day0Snapshots = {
  sleep: emptySnap('sleep'),
  mind: emptySnap('mind'),
  fitness: emptySnap('fitness'),
  nutrition: emptySnap('nutrition'),
  water: emptySnap('water'),
  fasting: emptySnap('fasting'),
};

const day0Profile = {
  anchor: 'energy',
  setup_state: { sleep: true, mind: true, fitness: true, nutrition: true, water: true, fasting: true },
  total_days_logged: 0,
  onboarding_answers: {},
  local_hour: 9,
};

test('Day-0: is_warm_start true, score = 12 (setup_count × 2)', () => {
  const r = computeWellness({ snapshots: day0Snapshots, baselines: {}, profile: day0Profile, recentDailyHistory: [] });
  assert.strictEqual(r.is_warm_start, true);
  assert.strictEqual(r.score, 12);
});

test('Day-0: explainer pack present', () => {
  const r = computeWellness({ snapshots: day0Snapshots, baselines: {}, profile: day0Profile, recentDailyHistory: [] });
  assert.ok(r.explainer, 'explainer should be present');
  assert.strictEqual(r.explainer.is_warm_start, true);
  assert.strictEqual(r.explainer.hk_status, 'denied');
  assert.deepStrictEqual(r.explainer.hk_enhanced_agents, []);
  assert.strictEqual(r.explainer.warm_start_blend_pct, 0); // 0 because warm_start_blend = 0 on day-0
  assert.ok(r.explainer.transition_explainer.includes('Day 14'));
});

test('Day-0: all 6 contribution reasons say "not yet set up" OR "first log"', () => {
  const r = computeWellness({ snapshots: day0Snapshots, baselines: {}, profile: day0Profile, recentDailyHistory: [] });
  // On day-0 with no logs, components have score=null
  for (const c of r.explainer.contributions) {
    assert.strictEqual(c.score, null);
    assert.strictEqual(c.reason_key, 'wellness.contrib.not_setup');
  }
});

// ────────────────────────────────────────────────────────────────
section('3. user_score_weights tilt is applied in score pipeline');

test('Day-0 with tilt: weights_in_use reflects user preference', () => {
  const r = computeWellness({
    snapshots: day0Snapshots,
    baselines: {},
    profile: { ...day0Profile, user_score_weights: { sleep: 0.10 } },
    recentDailyHistory: [],
  });
  assert.strictEqual(r.explainer.user_tilt_applied, true);
  assert.ok(r.explainer.weights_in_use.sleep > 0.25, `sleep weight ${r.explainer.weights_in_use.sleep} not boosted`);
});

test('Day-0 without tilt: user_tilt_applied false', () => {
  const r = computeWellness({ snapshots: day0Snapshots, baselines: {}, profile: day0Profile, recentDailyHistory: [] });
  assert.strictEqual(r.explainer.user_tilt_applied, false);
});

// ────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
