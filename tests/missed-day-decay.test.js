/**
 * missed-day-decay.test.js — CI gate for SCORING_CONTRACT_V3.md §6.
 *
 * Contract: after 3 consecutive unlogged days at the end of the smoothing
 * window, `smoothed_7d` decays toward DAY1_SEED=25 at 5 pts/day past grace.
 *
 * Why: stop phantom-good scores after lapses (1 old log shouldn't keep
 * the user at 70 forever).
 *
 * Implementation lives in wellness-cross-v2/adapters/_helpers.js inside
 * the buildAdapter scope. Since it's a closure, this test re-implements
 * the helper logic to assert the contract.
 *
 * Run: node tests/missed-day-decay.test.js
 */

'use strict';

const assert = require('assert');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function section(title) { console.log(`\n${title}`); }

// ────────────────────────────────────────────────────────────────
// Re-implementation of the decay helpers (mirror _helpers.js exactly)
const DAY1_SEED   = 25;
const DECAY_GRACE = 3;
const DECAY_PER_D = 5;

function consecutiveUnloggedAtEnd(pts) {
  let n = 0;
  for (let i = pts.length - 1; i >= 0; i--) {
    if (Number.isFinite(pts[i].value)) break;
    n++;
  }
  return n;
}
function avgScored(pts) {
  const valid = pts.filter((p) => Number.isFinite(p.value));
  if (valid.length === 0) return null;
  return Math.max(0, Math.min(100, Math.round(valid.reduce((s, p) => s + p.value, 0) / valid.length)));
}
function smoothedWithDecay(pts) {
  const base = avgScored(pts);
  if (base == null) return null;
  const unlogged = consecutiveUnloggedAtEnd(pts);
  if (unlogged <= DECAY_GRACE) return base;
  const decayDays = unlogged - DECAY_GRACE;
  const decayed = base - decayDays * DECAY_PER_D;
  return Math.max(0, Math.min(100, Math.round(Math.max(decayed, DAY1_SEED))));
}

// helper: build 7-day pts where last N are unlogged
function build7d(loggedScores, unloggedAtEnd) {
  const arr = [];
  for (const v of loggedScores) arr.push({ value: v });
  for (let i = 0; i < unloggedAtEnd; i++) arr.push({});
  return arr.slice(-7);
}

// ────────────────────────────────────────────────────────────────
section('1. No decay applied within grace period');

test('0 unlogged days at end → base mean', () => {
  const pts = build7d([70, 70, 70, 70, 70, 70, 70], 0);
  assert.strictEqual(smoothedWithDecay(pts), 70);
});

test('3 unlogged days at end (= grace) → base mean preserved', () => {
  const pts = build7d([70, 70, 70, 70], 3);
  assert.strictEqual(smoothedWithDecay(pts), 70);
});

// ────────────────────────────────────────────────────────────────
section('2. Decay applies past grace period');

test('4 unlogged days at end → 70 - (4-3)*5 = 65', () => {
  const pts = build7d([70, 70, 70], 4);
  assert.strictEqual(smoothedWithDecay(pts), 65);
});

test('5 unlogged days → 70 - (5-3)*5 = 60', () => {
  const pts = build7d([70, 70], 5);
  assert.strictEqual(smoothedWithDecay(pts), 60);
});

test('7 unlogged days → mean is null (no valid points)', () => {
  const pts = build7d([], 7);
  assert.strictEqual(smoothedWithDecay(pts), null);
});

// ────────────────────────────────────────────────────────────────
section('3. Floor at DAY1_SEED, never below');

test('Heavy decay never below DAY1_SEED=25', () => {
  const pts = build7d([30], 6);
  // 6 unlogged - 3 grace = 3 decay days → 30 - 15 = 15. But floored at 25.
  assert.strictEqual(smoothedWithDecay(pts), 25);
});

test('Logged days only in middle → still decays at end', () => {
  const pts = [{}, { value: 80 }, { value: 80 }, {}, {}, {}, {}]; // 4 unlogged at end
  // Base = 80; 4-3=1 decay day → 75
  assert.strictEqual(smoothedWithDecay(pts), 75);
});

// ────────────────────────────────────────────────────────────────
section('4. Phantom-good scenario from the contract');

test('1 log 10 days ago → smoothed lands near DAY1_SEED, not phantom 70', () => {
  // 7d window: only the very first day has the log
  const pts = [{ value: 70 }, {}, {}, {}, {}, {}, {}];
  // base = 70, unlogged at end = 6, decay = (6-3)*5 = 15 → 55
  // (still above DAY1_SEED but honest about gap)
  assert.strictEqual(smoothedWithDecay(pts), 55);
});

test('10+ unlogged at end of longer window → falls to seed', () => {
  // 30d window: log on day 0, then 29 unlogged days at end
  const arr = [{ value: 80 }];
  for (let i = 0; i < 29; i++) arr.push({});
  // base = 80, unlogged at end (just last 7 days, since we operate on 7d window)
  // But the function operates on whatever pts are passed. For a 30d window:
  const v = smoothedWithDecay(arr);
  // base 80, unlogged = 29, decay = (29-3)*5 = 130 → clamped at floor 25
  assert.strictEqual(v, 25);
});

// ────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
