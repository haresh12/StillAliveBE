/**
 * Nutrition /analysis BE↔FE contract parity (2026-05-26).
 *
 * Drift between BE response and FE normalize.js is THE most expensive
 * class of bug: it ships clean (no syntax error, no test failure) but
 * makes a screen show `undefined` in production. Per Fitness 10/10 §15.
 *
 * This test scans the BE /analysis route in nutrition.agent.js and the
 * FE normalize.js, asserting every contract key the FE reads exists in
 * the BE populated response shape.
 *
 * Run: node tests/nutrition-analysis-parity.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function section(title) { console.log(`\n${title}`); }

const BE_PATH = path.join(__dirname, '..', 'nutrition.agent.js');
const FE_NORMALIZE_PATH = path.join(__dirname, '..', '..', 'StillAlive', 'src', 'lib', 'normalize.js');

const beSrc = fs.readFileSync(BE_PATH, 'utf8');
const feSrc = fs.readFileSync(FE_NORMALIZE_PATH, 'utf8');

// Required contract keys (added 2026-05-26 as part of Nutrition 10/10).
// These MUST be in the populated /analysis response shape — failure means
// the FE will see undefined and silently fail.
const REQUIRED_KEYS = [
  'effective_start_date',
  'effective_days',
  'days_since_anchor',
  'anchor_date',
  'is_clamped',
  'score_today',
  'score_7d_smoothed',
  'score_lifetime',
  'missed_days',
  // Nutrition 10/10 additions (2026-05-26)
  'journey',
];

const TODAY_REQUIRED_KEYS = [
  'entries',
  'totals',
  'targets',
  'streak',
  'weekly',
  'same_day_suggestion',
  'score_smoothed_7d',
];

const FE_NORMALIZE_KEYS = [
  'effective_start_date',
  'effective_days',
  'days_since_anchor',
  'anchor_date',
  'is_clamped',
  'score_today',
  'score_7d_smoothed',
  'score_lifetime',
  'missed_days',
  'journey',
  'top_foods',
  'bottom_foods',
];

// ─── /analysis populated response ─────────────────────────────────
section('/analysis populated response — BE shape');

// Find the /analysis route block in nutrition.agent.js.
const analysisRouteIdx = beSrc.indexOf(`router.get('/analysis'`);
assert(analysisRouteIdx > 0, '/analysis route not found in nutrition.agent.js');
// Slice from /analysis to the next route (router.) or end-of-file.
const afterAnalysis = beSrc.slice(analysisRouteIdx);
const nextRouteIdx = afterAnalysis.indexOf('router.', 100);
const analysisBlock = afterAnalysis.slice(0, nextRouteIdx > 0 ? nextRouteIdx : 5000);

for (const key of REQUIRED_KEYS) {
  test(`populated path emits "${key}"`, () => {
    // Accept "key:" (shorthand or explicit). Both valid JS.
    // Accept BOTH shorthand (`entries,`) and explicit (`entries:`) emit syntax.
    const re = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\\\]\\\\]/g, '\\\\$&')}\\s*[:,}]`);
    assert(re.test(analysisBlock), `key "${key}" missing in /analysis res.json(...)`);
  });
}

// ─── /today response ─────────────────────────────────────────────
section('/today response — BE shape');

const todayRouteIdx = beSrc.indexOf(`router.get('/today'`);
assert(todayRouteIdx > 0, '/today route not found in nutrition.agent.js');
const afterToday = beSrc.slice(todayRouteIdx);
const nextTodayRouteIdx = afterToday.indexOf('router.', 100);
const todayBlock = afterToday.slice(0, nextTodayRouteIdx > 0 ? nextTodayRouteIdx : 3000);

for (const key of TODAY_REQUIRED_KEYS) {
  test(`/today emits "${key}"`, () => {
    // Accept BOTH shorthand (`entries,`) and explicit (`entries:`) emit syntax.
    const re = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\\\]\\\\]/g, '\\\\$&')}\\s*[:,}]`);
    assert(re.test(todayBlock), `key "${key}" missing in /today res.json(...)`);
  });
}

// ─── FE normalize.js accepts every key ───────────────────────────
section('FE normalize.js — accepts every contract key');

for (const key of FE_NORMALIZE_KEYS) {
  test(`normalize exposes "${key}"`, () => {
    // Accept BOTH shorthand (`entries,`) and explicit (`entries:`) emit syntax.
    const re = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\\\]\\\\]/g, '\\\\$&')}\\s*[:,}]`);
    assert(re.test(feSrc), `key "${key}" not handled in normalize.js`);
  });
}

// ─── Forbidden patterns (per CLAUDE.md laws) ──────────────────────
section('Forbidden patterns');

test('no max_tokens: in nutrition.agent.js (OpenAI canon)', () => {
  // Allow `max_completion_tokens` (the correct one).
  const matches = beSrc.match(/\bmax_tokens\b\s*:/g) || [];
  assert.strictEqual(matches.length, 0, `found ${matches.length} max_tokens: usages`);
});

test('no temperature: in nutrition.agent.js (deterministic only)', () => {
  const matches = beSrc.match(/\btemperature\b\s*:/g) || [];
  assert.strictEqual(matches.length, 0, `found ${matches.length} temperature: usages`);
});

test('no toISOString().slice(0,10) date keys in TrackTab', () => {
  const trackTab = fs.readFileSync(
    path.join(__dirname, '..', '..', 'StillAlive', 'src', 'screens', 'wellness', 'nutrition', 'NutritionTrackTab.js'),
    'utf8',
  );
  const matches = trackTab.match(/toISOString\(\)\.slice\(0,\s*10\)/g) || [];
  assert.strictEqual(matches.length, 0, `found ${matches.length} TZ-unsafe date key in TrackTab`);
});

test('no /v2 or /v3 route suffixes in nutrition.agent.js', () => {
  // Match `router.<verb>(...'/foo/v2/...'`) — false matches on /v2/ inside
  // strings of analytics paths are minimal; tighten if needed.
  const matches = beSrc.match(/router\.\w+\(\s*['"`]\/[^'"\\]*\/v[23]\b/g) || [];
  assert.strictEqual(matches.length, 0, `found ${matches.length} versioned route suffixes`);
});

// ─── Summary ──────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
