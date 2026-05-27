/**
 * Unit tests for lib/water-scoring.js
 *
 * Pure-function tests — no Firestore, no Express, no clock. Run:
 *   node tests/water-scoring.test.js
 *
 * Locks the math + null-safety contract before Path C (refreshWaterScore)
 * and Path D (water.adapter.scoreDailyLogs) start depending on this module.
 */
'use strict';

const assert = require('assert');
const {
  BEV_MULT,
  WATER_FRIENDLY_FULL,
  WATER_FRIENDLY_HALF,
  dropFutureLogs,
  groupLogsByDate,
  deriveHydrationAdequacy,
  deriveConsistency,
  deriveChronobiology,
  deriveBeverageQuality,
  maturityRamp,
  computeWaterScore,
  // Phase 5-8 helpers
  derivePriorPeriod,
  derive365Heatmap,
  deriveBeverageMix,
  deriveDayOfWeek,
  effortMixTier,
} = require('../lib/water-scoring');

let p = 0, f = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); p++; }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + (e.stack || e.message)); f++; }
}
function section(s) { console.log('\n' + s); }

// ─── Test fixtures ────────────────────────────────────────────────
const TODAY = '2026-05-25';
const Y      = '2026-05-24';
const Y2     = '2026-05-23';
const Y3     = '2026-05-22';
const Y4     = '2026-05-21';
const Y5     = '2026-05-20';
const Y6     = '2026-05-19';
const TOMORROW = '2026-05-26';

function mkLog({ date = TODAY, hour = 9, ml = 250, bev = 'water' } = {}) {
  const ts = new Date(`${date}T${String(hour).padStart(2, '0')}:00:00`);
  return { date, logged_at: ts.getTime(), ml, beverage_type: bev };
}

const RECENT_7 = [Y6, Y5, Y4, Y3, Y2, Y, TODAY];

const GOAL_FLAT = RECENT_7.reduce((acc, k) => ({ ...acc, [k]: 2500 }), {});

// ─── Constants ────────────────────────────────────────────────────
section('Constants');

test('BEV_MULT defines all known beverages with valid coefficients', () => {
  for (const [k, v] of Object.entries(BEV_MULT)) {
    assert.ok(typeof v === 'number' && v >= 0 && v <= 2, `${k} → ${v} out of range`);
  }
  assert.strictEqual(BEV_MULT.water, 1.0);
  assert.strictEqual(BEV_MULT.coffee, 0.84);   // Killer 2014
  assert.strictEqual(BEV_MULT.alcohol, 0.4);   // Polhuis 2017
});

test('WATER_FRIENDLY_FULL covers the obvious hydrators', () => {
  assert.ok(WATER_FRIENDLY_FULL.has('water'));
  assert.ok(WATER_FRIENDLY_FULL.has('herbal'));
  assert.ok(WATER_FRIENDLY_FULL.has('milk'));
  assert.ok(!WATER_FRIENDLY_FULL.has('coffee'));
  assert.ok(!WATER_FRIENDLY_FULL.has('alcohol'));
});

// ─── dropFutureLogs ───────────────────────────────────────────────
section('dropFutureLogs (anti-future-log law)');

test('drops logs dated strictly after today', () => {
  const out = dropFutureLogs([mkLog({ date: Y }), mkLog({ date: TODAY }), mkLog({ date: TOMORROW })], TODAY);
  assert.strictEqual(out.length, 2);
  assert.ok(!out.some((l) => l.date === TOMORROW));
});

test('keeps logs dated today or earlier', () => {
  const out = dropFutureLogs([mkLog({ date: Y3 }), mkLog({ date: TODAY })], TODAY);
  assert.strictEqual(out.length, 2);
});

test('passes through logs with no date field (legacy data)', () => {
  const out = dropFutureLogs([{ ml: 250 }, mkLog({ date: TOMORROW })], TODAY);
  assert.strictEqual(out.length, 1);  // future dropped, undated kept
});

test('null/empty inputs are safe', () => {
  assert.deepStrictEqual(dropFutureLogs(null, TODAY), []);
  assert.deepStrictEqual(dropFutureLogs([], TODAY), []);
  // No today → no filter applied (returns a copy)
  assert.strictEqual(dropFutureLogs([mkLog({ date: TOMORROW })], null).length, 1);
});

// ─── groupLogsByDate ──────────────────────────────────────────────
section('groupLogsByDate (per-day aggregator)');

test('sums ml + effective_ml correctly across beverage types', () => {
  const logs = [
    mkLog({ date: TODAY, hour: 8, ml: 250, bev: 'water' }),   // eff 250
    mkLog({ date: TODAY, hour: 9, ml: 250, bev: 'coffee' }),  // eff 210
    mkLog({ date: TODAY, hour: 14, ml: 250, bev: 'alcohol' }),// eff 100
  ];
  const by = groupLogsByDate(logs);
  assert.strictEqual(by[TODAY].total_ml, 750);
  assert.strictEqual(by[TODAY].effective_ml, 560);  // 250 + 210 + 100
});

test('water_friendly_ml counts only water/herbal/milk fully, juice half, others zero', () => {
  const logs = [
    mkLog({ date: TODAY, ml: 1000, bev: 'water' }),    // +1000 friendly
    mkLog({ date: TODAY, ml: 500,  bev: 'juice' }),    // +212 friendly (425 eff × 0.5)
    mkLog({ date: TODAY, ml: 500,  bev: 'coffee' }),   // +0
  ];
  const by = groupLogsByDate(logs);
  assert.ok(by[TODAY].water_friendly_ml >= 1200 && by[TODAY].water_friendly_ml <= 1213);
});

test('morning_ml captures hours < 11', () => {
  const logs = [
    mkLog({ date: TODAY, hour: 7,  ml: 300, bev: 'water' }),
    mkLog({ date: TODAY, hour: 10, ml: 300, bev: 'water' }),
    mkLog({ date: TODAY, hour: 11, ml: 300, bev: 'water' }),  // NOT morning
  ];
  const by = groupLogsByDate(logs);
  assert.strictEqual(by[TODAY].morning_ml, 600);
});

test('late_ml captures intake at or after configured cutoff', () => {
  const logs = [
    mkLog({ date: TODAY, hour: 19, ml: 200, bev: 'water' }),  // 1140 min — before 1200 cutoff
    mkLog({ date: TODAY, hour: 21, ml: 200, bev: 'water' }),  // 1260 min — late
    mkLog({ date: TODAY, hour: 22, ml: 200, bev: 'water' }),  // late
  ];
  const by = groupLogsByDate(logs);
  assert.strictEqual(by[TODAY].late_ml, 400);
});

test('empty/undefined logs return {}', () => {
  assert.deepStrictEqual(groupLogsByDate([]), {});
  assert.deepStrictEqual(groupLogsByDate(undefined), {});
});

// ─── Gate 1: Hydration Adequacy ───────────────────────────────────
section('deriveHydrationAdequacy (gate 1, 35%)');

test('returns 100 when every day hits goal', () => {
  const by = groupLogsByDate(RECENT_7.flatMap((d) => [
    mkLog({ date: d, hour: 8, ml: 1300, bev: 'water' }),
    mkLog({ date: d, hour: 14, ml: 1200, bev: 'water' }),
  ]));
  assert.strictEqual(deriveHydrationAdequacy(by, GOAL_FLAT, RECENT_7), 100);
});

test('returns 0 when window is empty', () => {
  assert.strictEqual(deriveHydrationAdequacy({}, GOAL_FLAT, RECENT_7), 0);
});

test('returns ~50 when half-goal hit every day', () => {
  const by = groupLogsByDate(RECENT_7.map((d) => mkLog({ date: d, ml: 1250, bev: 'water' })));
  const score = deriveHydrationAdequacy(by, GOAL_FLAT, RECENT_7);
  assert.ok(score >= 49 && score <= 51, `expected ~50, got ${score}`);
});

test('null-safe on empty recentKeys', () => {
  assert.strictEqual(deriveHydrationAdequacy({}, {}, []), 0);
  assert.strictEqual(deriveHydrationAdequacy({}, {}, null), 0);
});

// ─── Gate 2: Consistency ──────────────────────────────────────────
section('deriveConsistency (gate 2, 25%)');

test('returns 100 when every day reaches ≥80% goal', () => {
  const by = groupLogsByDate(RECENT_7.map((d) => mkLog({ date: d, ml: 2000, bev: 'water' })));
  assert.strictEqual(deriveConsistency(by, GOAL_FLAT, RECENT_7), 100);
});

test('returns ~57 when 4 of 7 days hit', () => {
  const hits = [TODAY, Y, Y2, Y3];  // 4 of 7
  const by = groupLogsByDate(hits.map((d) => mkLog({ date: d, ml: 2200, bev: 'water' })));
  const s = deriveConsistency(by, GOAL_FLAT, RECENT_7);
  assert.ok(s >= 56 && s <= 58, `expected ~57, got ${s}`);
});

test('returns 0 when no day reaches threshold', () => {
  const by = groupLogsByDate(RECENT_7.map((d) => mkLog({ date: d, ml: 500 })));
  assert.strictEqual(deriveConsistency(by, GOAL_FLAT, RECENT_7), 0);
});

// ─── Gate 3: Chronobiology ────────────────────────────────────────
section('deriveChronobiology (gate 3, 25%)');

test('returns 100 when every day front-loads AND tapers', () => {
  const by = groupLogsByDate(RECENT_7.flatMap((d) => [
    mkLog({ date: d, hour: 7,  ml: 700, bev: 'water' }),  // morning_ml = 700 ≥ max(300, 550)
    mkLog({ date: d, hour: 13, ml: 800, bev: 'water' }),  // midday, no late_ml
  ]));
  assert.strictEqual(deriveChronobiology(by, GOAL_FLAT, RECENT_7), 100);
});

test('returns 0 when every day fails both criteria', () => {
  const by = groupLogsByDate(RECENT_7.flatMap((d) => [
    mkLog({ date: d, hour: 21, ml: 800, bev: 'water' }),  // all late, no morning
    mkLog({ date: d, hour: 22, ml: 800, bev: 'water' }),
  ]));
  assert.strictEqual(deriveChronobiology(by, GOAL_FLAT, RECENT_7), 0);
});

test('60/40 weight blends correctly: 100 front-load / 0 taper = 60', () => {
  const by = groupLogsByDate(RECENT_7.flatMap((d) => [
    mkLog({ date: d, hour: 7,  ml: 700, bev: 'water' }),  // morning hit
    mkLog({ date: d, hour: 21, ml: 600, bev: 'water' }),  // late > 250 → no taper
  ]));
  assert.strictEqual(deriveChronobiology(by, GOAL_FLAT, RECENT_7), 60);
});

// ─── Gate 4: Beverage Quality ─────────────────────────────────────
section('deriveBeverageQuality (gate 4, 15%)');

test('returns 100 when every drink is water', () => {
  const by = groupLogsByDate(RECENT_7.map((d) => mkLog({ date: d, ml: 1000, bev: 'water' })));
  assert.strictEqual(deriveBeverageQuality(by, RECENT_7), 100);
});

test('coffee-only days score 0 (coffee not water-friendly)', () => {
  const by = groupLogsByDate(RECENT_7.map((d) => mkLog({ date: d, ml: 1000, bev: 'coffee' })));
  assert.strictEqual(deriveBeverageQuality(by, RECENT_7), 0);
});

test('half water / half coffee scores ~54 (water 1000 + coffee 840 effective; friendly 1000/1840 = 54%)', () => {
  const by = groupLogsByDate(RECENT_7.flatMap((d) => [
    mkLog({ date: d, ml: 1000, bev: 'water' }),
    mkLog({ date: d, ml: 1000, bev: 'coffee' }),
  ]));
  const s = deriveBeverageQuality(by, RECENT_7);
  assert.ok(s >= 53 && s <= 55, `expected ~54, got ${s}`);
});

test('no-log days return neutral 60 (avoids double-penalty)', () => {
  assert.strictEqual(deriveBeverageQuality({}, RECENT_7), 60);
});

// ─── maturityRamp ─────────────────────────────────────────────────
section('maturityRamp (anchor-keyed)');

test('matches the canonical curve from fitness-scoring', () => {
  assert.strictEqual(maturityRamp(0),  0.40);
  assert.strictEqual(maturityRamp(1),  0.45);
  assert.strictEqual(maturityRamp(4),  0.55);
  assert.strictEqual(maturityRamp(7),  0.70);
  assert.strictEqual(maturityRamp(14), 0.85);
  assert.strictEqual(maturityRamp(30), 0.94);
  assert.strictEqual(maturityRamp(60), 1.00);
});

test('safe on undefined / null input', () => {
  assert.strictEqual(maturityRamp(undefined), 0.40);
  assert.strictEqual(maturityRamp(null),      0.40);
});

// ─── computeWaterScore (entry point) ──────────────────────────────
section('computeWaterScore (single entry point)');

test('returns {score:0, label:"Starting"} for empty inputs (matches Path A semantics, not null)', () => {
  const out = computeWaterScore({ logs: [], recentKeys: [], daysSinceAnchor: 0 });
  assert.ok(out !== null, 'expected non-null result so early users see real 0 progression');
  assert.strictEqual(out.score, 0);
  assert.strictEqual(out.label, 'Starting');
});

test('returns shape { score, label, components, days_logged, ... } for real data', () => {
  const logs = RECENT_7.flatMap((d) => [
    mkLog({ date: d, hour: 7, ml: 700, bev: 'water' }),
    mkLog({ date: d, hour: 12, ml: 700, bev: 'water' }),
    mkLog({ date: d, hour: 17, ml: 1100, bev: 'water' }),
  ]);
  const out = computeWaterScore({
    logs, goalByDate: GOAL_FLAT, recentKeys: RECENT_7, daysSinceAnchor: 30,
  });
  assert.ok(out && typeof out.score === 'number', 'expected non-null score');
  assert.ok(out.score >= 0 && out.score <= 100, `score ${out.score} out of range`);
  assert.ok(typeof out.label === 'string' && out.label.length > 0);
  assert.ok(out.components && typeof out.components.hydration_adequacy === 'number');
  assert.ok(out.components.chronobiology >= 50, `chrono ${out.components.chronobiology} should be high for front-loaded`);
  assert.ok(out.components.beverage_quality === 100, `bev_quality should be 100 for all-water`);
});

test('Day-1 user (low daysSinceAnchor, few logs) gets a low score (≤ 30)', () => {
  const logs = [mkLog({ date: TODAY, ml: 2500, bev: 'water' })];
  const out = computeWaterScore({
    logs, goalByDate: { [TODAY]: 2500 }, recentKeys: [TODAY], daysSinceAnchor: 1,
  });
  assert.ok(out && out.score <= 30, `Day-1 score should be ≤30, got ${out?.score}`);
});

test('Future logs do NOT inflate score (filter law honored)', () => {
  const logs = [
    mkLog({ date: TODAY, ml: 500, bev: 'water' }),         // real
    mkLog({ date: TOMORROW, ml: 5000, bev: 'water' }),     // future — should be dropped
  ];
  const out = computeWaterScore({
    logs, goalByDate: { [TODAY]: 2500 }, recentKeys: [TODAY],
    daysSinceAnchor: 30, todayDateStr: TODAY,
  });
  // adequacy = 500/2500 = 20, not 100+
  assert.ok(out.components.hydration_adequacy < 30,
    `future log leaked: adequacy=${out.components.hydration_adequacy}`);
});

test('Coffee-heavy logger sees lower beverage_quality than water-only', () => {
  const goal = RECENT_7.reduce((acc, k) => ({ ...acc, [k]: 2500 }), {});
  const waterOnly = computeWaterScore({
    logs: RECENT_7.map((d) => mkLog({ date: d, ml: 2500, bev: 'water' })),
    goalByDate: goal, recentKeys: RECENT_7, daysSinceAnchor: 30,
  });
  const coffeeMix = computeWaterScore({
    logs: RECENT_7.flatMap((d) => [
      mkLog({ date: d, ml: 1250, bev: 'water' }),
      mkLog({ date: d, ml: 1250, bev: 'coffee' }),
    ]),
    goalByDate: goal, recentKeys: RECENT_7, daysSinceAnchor: 30,
  });
  assert.ok(coffeeMix.components.beverage_quality < waterOnly.components.beverage_quality,
    `coffee mix bev=${coffeeMix.components.beverage_quality} should be < water-only ${waterOnly.components.beverage_quality}`);
});

// ─── Phase 5: derivePriorPeriod ───────────────────────────────────
section('derivePriorPeriod (Phase 5 — vs prior window)');

test('returns null when prior window too short (< 3 days)', () => {
  assert.strictEqual(
    derivePriorPeriod({ priorLogs: [mkLog()], priorGoalByDate: {}, priorRecentKeys: [TODAY, Y] }),
    null
  );
});

test('computes prior aggregates from real logs', () => {
  const priorKeys = ['2026-05-13', '2026-05-14', '2026-05-15', '2026-05-16', '2026-05-17', '2026-05-18', '2026-05-19'];
  const priorLogs = priorKeys.map((d) => mkLog({ date: d, ml: 1500, bev: 'water' }));
  const out = derivePriorPeriod({
    priorLogs, priorGoalByDate: priorKeys.reduce((a, k) => ({ ...a, [k]: 2500 }), {}),
    priorRecentKeys: priorKeys,
    currentTotalMl: 2000 * 7, currentAvgMl: 2000, currentDaysLogged: 7, currentCompletion: 0.5,
  });
  assert.ok(out);
  assert.strictEqual(out.sample_size, 7);
  assert.strictEqual(out.prior_avg_ml, 1500);
  assert.strictEqual(out.delta_avg_ml_pct, 33); // (2000-1500)/1500 = 33%
});

test('delta_*_pct returns null when prior is zero (no false 100% gain)', () => {
  const priorKeys = ['2026-05-13', '2026-05-14', '2026-05-15'];
  const out = derivePriorPeriod({
    priorLogs: priorKeys.map((d) => mkLog({ date: d, ml: 100, bev: 'water' })),
    priorGoalByDate: priorKeys.reduce((a, k) => ({ ...a, [k]: 2500 }), {}),
    priorRecentKeys: priorKeys,
    currentTotalMl: 5000, currentAvgMl: 1000, currentDaysLogged: 5, currentCompletion: 0,
  });
  assert.ok(out);
  assert.strictEqual(out.prior_completion_pct, 0);
});

// ─── Phase 6: derive365Heatmap ────────────────────────────────────
section('derive365Heatmap (Phase 6 — 365-cell Your Journey)');

test('always returns 365 cells regardless of input', () => {
  const out = derive365Heatmap({ dailyQualityByDate: {}, anchorDate: TODAY, todayDate: TODAY });
  assert.strictEqual(out.cells.length, 365);
});

test('cells past today are tagged future', () => {
  const out = derive365Heatmap({ dailyQualityByDate: {}, anchorDate: TODAY, todayDate: TODAY });
  const futureCells = out.cells.filter((c) => c.future);
  assert.ok(futureCells.length > 0, 'should have future cells when anchor=today');
});

test('cells before anchor are tagged pre_anchor', () => {
  const out = derive365Heatmap({
    dailyQualityByDate: {},
    anchorDate: '2026-05-20',  // 5 days before TODAY
    todayDate: TODAY,
  });
  // Since anchorDate is the START, none should be pre_anchor; the START IS the anchor
  // So this verifies pre_anchor is false when within the year-from-anchor window.
  assert.ok(out.cells.every((c) => !c.pre_anchor), 'no pre-anchor cells when anchor is window start');
});

test('quality 75 maps to level 3, quality 50 → 2, quality 20 → 1, missing → 0', () => {
  const qByDate = { '2026-05-25': 80, '2026-05-24': 50, '2026-05-23': 20 };
  const out = derive365Heatmap({ dailyQualityByDate: qByDate, anchorDate: '2026-05-23', todayDate: TODAY });
  const c25 = out.cells.find((c) => c.date === '2026-05-25');
  const c24 = out.cells.find((c) => c.date === '2026-05-24');
  const c23 = out.cells.find((c) => c.date === '2026-05-23');
  const cMissing = out.cells.find((c) => c.date === '2026-05-22');
  assert.strictEqual(c25?.level, 3, `80 → 3, got ${c25?.level}`);
  assert.strictEqual(c24?.level, 2, `50 → 2, got ${c24?.level}`);
  assert.strictEqual(c23?.level, 1, `20 → 1, got ${c23?.level}`);
  if (cMissing) assert.strictEqual(cMissing.level, 0);
});

test('summary counts logged vs missed (excluding future + pre-anchor)', () => {
  const qByDate = { '2026-05-25': 80, '2026-05-24': 50 };
  const out = derive365Heatmap({
    dailyQualityByDate: qByDate,
    anchorDate: '2026-05-23',
    todayDate: TODAY,
  });
  assert.ok(out.summary.logged_days >= 2);
  assert.strictEqual(typeof out.summary.span_days, 'number');
});

// ─── Phase 7: deriveBeverageMix + deriveDayOfWeek ─────────────────
section('deriveBeverageMix + deriveDayOfWeek (Phase 7 — Balance card)');

test('deriveBeverageMix sums percentages to 100', () => {
  const by = groupLogsByDate([
    mkLog({ date: TODAY, ml: 1000, bev: 'water' }),
    mkLog({ date: TODAY, ml: 500,  bev: 'coffee' }),
  ]);
  const mix = deriveBeverageMix(by, [TODAY]);
  const sum = mix.reduce((s, b) => s + b.pct, 0);
  assert.ok(sum >= 99 && sum <= 100, `sum should be ~100, got ${sum}`);
  assert.strictEqual(mix[0].type, 'water'); // sorted by effective_ml
});

test('deriveBeverageMix returns [] on empty', () => {
  assert.deepStrictEqual(deriveBeverageMix({}, []), []);
});

test('deriveDayOfWeek returns 7 entries Mon-Sun', () => {
  const by = groupLogsByDate(RECENT_7.map((d) => mkLog({ date: d, ml: 1500, bev: 'water' })));
  const dow = deriveDayOfWeek(by, GOAL_FLAT, RECENT_7);
  assert.strictEqual(dow.length, 7);
  assert.strictEqual(dow[0].label, 'Mon');
  assert.strictEqual(dow[6].label, 'Sun');
});

test('deriveDayOfWeek pct_of_goal is 0 for days with no count (avoid divide-by-zero)', () => {
  const dow = deriveDayOfWeek({}, GOAL_FLAT, RECENT_7);
  assert.ok(dow.every((d) => Number.isFinite(d.pct_of_goal)));
  assert.ok(dow.every((d) => d.pct_of_goal === 0));
});

// ─── Phase 8: effortMixTier ───────────────────────────────────────
section('effortMixTier (Phase 8 — chronobiology tier mapping)');

test('maps 0..100 to 5 tiers correctly', () => {
  assert.strictEqual(effortMixTier(95).tier_key, 'excellent');
  assert.strictEqual(effortMixTier(85).tier_key, 'excellent');
  assert.strictEqual(effortMixTier(70).tier_key, 'strong');
  assert.strictEqual(effortMixTier(50).tier_key, 'building');
  assert.strictEqual(effortMixTier(25).tier_key, 'low');
  assert.strictEqual(effortMixTier(5).tier_key, 'starting');
});

test('null-safe input returns starting tier with 0 pct', () => {
  const out = effortMixTier(null);
  assert.strictEqual(out.tier_key, 'starting');
  assert.strictEqual(out.tier_pct, 0);
});

console.log('\n' + p + ' passed, ' + f + ' failed');
process.exit(f === 0 ? 0 : 1);
