/**
 * mind-scoring — contract tests for lib/mind-scoring.js (2026-05-23 uplift).
 *
 * Locks the math behind the new Mind 10/10 surfaces:
 *   computeCalmReadiness        — Banister-adapted, band thresholds, sleep penalty
 *   derivePriorPeriodMind       — delta math, null safety
 *   deriveEmotionGranularity    — Kashdan stagnation gate
 *   deriveCheckinDepth          — % deep vs basic vs mood-only
 *   deriveContributionMapMind   — always 365 cells, pre-anchor tag
 *   derivePlateauAnxiety        — stalled-high detection
 *   deriveCorrelationGrid       — Bearable killer; n>=3 per side + |delta|>=5
 *   deriveTopTrigger            — DOW peak, dominant gate
 *   computeBlendedMindScore     — 5-component blend in [0, 100]
 *   maturityRamp                — monotonic non-decreasing, slower honest curve
 *   dropFutureCheckins          — future-dated filter
 *
 * Run: node tests/mind-scoring.test.js
 */
'use strict';
const assert = require('assert');
const M = require('../lib/mind-scoring');

let p = 0, f = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); p++; }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); f++; }
}
function section(s) { console.log('\n' + s); }

// ────────────────────────────────────────────────────────────────
section('dropFutureCheckins');

test('drops checkins with date_str > today', () => {
  const out = M.dropFutureCheckins([
    { date_str: '2026-05-20' },
    { date_str: '2026-05-23' },  // today
    { date_str: '2026-05-24' },  // future
    { date_str: '2026-06-01' },  // future
  ], '2026-05-23');
  assert.strictEqual(out.length, 2);
});

test('keeps checkins with no date_str (legacy)', () => {
  const out = M.dropFutureCheckins([
    { date_str: '2026-05-20' },
    { mood: 3 },
  ], '2026-05-23');
  assert.strictEqual(out.length, 2);
});

// ────────────────────────────────────────────────────────────────
section('maturityRamp (slower honest curve, mind=fitness aligned)');

test('monotonic non-decreasing across calendar days', () => {
  let prev = -Infinity;
  for (let d = 0; d <= 120; d++) {
    const r = M.maturityRamp(d);
    assert.ok(r >= prev, `ramp dropped at day ${d}`);
    prev = r;
  }
});

test('day-0/1/4 — slow honest growth (NOT the old steep curve)', () => {
  assert.strictEqual(M.maturityRamp(0), 0.40);
  assert.strictEqual(M.maturityRamp(1), 0.45);
  assert.strictEqual(M.maturityRamp(4), 0.55);  // NOT 0.65 from the old shared maturityFactor
});

test('day-60+ reaches 1.00', () => {
  assert.strictEqual(M.maturityRamp(60), 1.00);
  assert.strictEqual(M.maturityRamp(365), 1.00);
});

// ────────────────────────────────────────────────────────────────
section('deriveCheckinQuality');

test('mood 3+ saturates top + anxiety 1 → 100 (good day)', () => {
  // mood scale is 1..4 (low/okay/good/great); 3 and 4 both saturate the top
  const q = M.deriveCheckinQuality({ mood_score: 4, anxiety_level: 1 });
  assert.strictEqual(q, 100);
});

test('mood 2 (okay) + anxiety 3 (moderate) → mid-quality day (~50)', () => {
  const q = M.deriveCheckinQuality({ mood_score: 2, anxiety_level: 3 });
  // mood part = 50, anxiety part = 50, weighted 60/40 = 50
  assert.ok(q >= 45 && q <= 55, 'expected 45-55, got ' + q);
});

test('mood 1 + anxiety 5 → near zero', () => {
  const q = M.deriveCheckinQuality({ mood_score: 1, anxiety_level: 5 });
  assert.strictEqual(q, 0);
});

test('handles missing fields with safe defaults', () => {
  const q = M.deriveCheckinQuality({});
  assert.ok(q >= 0 && q <= 100);
});

// ────────────────────────────────────────────────────────────────
section('buildDailyQualityMap');

test('means qualities per day when multiple checkins land', () => {
  const map = M.buildDailyQualityMap([
    { date_str: '2026-05-20', mood_score: 4, anxiety_level: 1 },  // high
    { date_str: '2026-05-20', mood_score: 2, anxiety_level: 4 },  // low
    { date_str: '2026-05-21', mood_score: 3, anxiety_level: 2 },
  ]);
  assert.ok(Object.keys(map).length === 2);
  // 20th should be between the two
  assert.ok(map['2026-05-20'] > 20 && map['2026-05-20'] < 80);
});

test('empty input returns empty map (no crash)', () => {
  assert.deepStrictEqual(M.buildDailyQualityMap([]), {});
});

// ────────────────────────────────────────────────────────────────
section('computeCalmReadiness');

test('empty anxiety → neutral default (no crash)', () => {
  const r = M.computeCalmReadiness({ anxiety_scores: [], mood_scores: [] });
  assert.strictEqual(r.band, 'steady');
  assert.strictEqual(r.readiness, 50);
});

test('low anxiety (1-2) → calm/peaceful band', () => {
  const r = M.computeCalmReadiness({
    anxiety_scores: [1, 1, 2, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1],
    mood_scores: [4, 4, 4, 4, 4, 4, 4],
  });
  assert.ok(['peaceful', 'calm'].includes(r.band), 'expected peaceful/calm got ' + r.band);
  assert.ok(r.readiness >= 70);
});

test('high anxiety (4-5) → stressed/overwhelmed band', () => {
  const r = M.computeCalmReadiness({
    anxiety_scores: [5, 5, 4, 5, 5, 4, 5, 4, 5, 5, 4, 4, 5, 5],
    mood_scores: [1, 2, 1, 2, 1, 2, 1],
  });
  assert.ok(['stressed', 'overwhelmed'].includes(r.band), 'expected stressed/overwhelmed got ' + r.band);
  assert.ok(r.readiness < 40);
});

test('sleep penalty: <6h pulls readiness down', () => {
  const noSleep = M.computeCalmReadiness({
    anxiety_scores: [2, 2, 2], mood_scores: [4, 4, 4],
  });
  const badSleep = M.computeCalmReadiness({
    anxiety_scores: [2, 2, 2], mood_scores: [4, 4, 4],
    recent_sleep_hours: 5.0,
  });
  assert.ok(badSleep.readiness < noSleep.readiness, 'sleep<6h should drop readiness');
});

test('every band has an explainer string', () => {
  for (const anx of [[1,1,1],[2,2,2],[3,3,3],[4,4,4],[5,5,5]]) {
    const r = M.computeCalmReadiness({ anxiety_scores: anx, mood_scores: [3,3,3] });
    assert.ok(typeof r.explain === 'string' && r.explain.length > 0);
  }
});

// ────────────────────────────────────────────────────────────────
section('derivePriorPeriodMind');

test('null when no prior data', () => {
  assert.strictEqual(M.derivePriorPeriodMind({
    priorCheckins: [], currentMoodAvg: 3, currentAnxAvg: 2, currentDaysLogged: 5, currentReframes: 1,
  }), null);
});

test('mood improving → positive delta_mood_pts', () => {
  const r = M.derivePriorPeriodMind({
    priorCheckins: [
      { date_str: '2026-04-10', mood_score: 2, anxiety_level: 4 },
      { date_str: '2026-04-12', mood_score: 2, anxiety_level: 4 },
    ],
    currentMoodAvg: 3.5,
    currentAnxAvg: 2,
    currentDaysLogged: 5,
    currentReframes: 2,
  });
  assert.ok(r.delta_mood_pts > 0);
  assert.ok(r.delta_anx_pts > 0);  // anxiety down = positive
});

// ────────────────────────────────────────────────────────────────
section('deriveEmotionGranularity (Kashdan 2015)');

test('counts unique emotion vocab', () => {
  const g = M.deriveEmotionGranularity([
    { emotions: ['Calm', 'Hopeful'] },
    { emotions: ['Anxious'] },
    { emotions: ['Calm', 'Anxious'] },  // duplicates don't inflate
  ]);
  assert.strictEqual(g.unique, 3);
});

test('stagnant flag fires only at ≥30d span with <6 unique words', () => {
  const few = M.deriveEmotionGranularity([{ emotions: ['Calm', 'Hopeful'] }], 7);
  assert.strictEqual(few.stagnant, false);
  const stagnant = M.deriveEmotionGranularity([{ emotions: ['Calm', 'Hopeful'] }], 30);
  assert.strictEqual(stagnant.stagnant, true);
});

// ────────────────────────────────────────────────────────────────
section('deriveCheckinDepth');

test('empty → all zeros (no crash)', () => {
  const d = M.deriveCheckinDepth([]);
  assert.strictEqual(d.total_n, 0);
  assert.strictEqual(d.deep_pct, 0);
});

test('partitions deep / basic / mood-only', () => {
  const d = M.deriveCheckinDepth([
    { note: 'work was rough', triggers: ['work'], emotions: ['Stressed'] },  // deep
    { triggers: ['family'] },                                                // basic
    { mood: 3 },                                                             // mood-only
    { mood: 2 },                                                             // mood-only
  ]);
  assert.strictEqual(d.total_n, 4);
  assert.strictEqual(d.deep_n, 1);
  assert.strictEqual(d.deep_pct, 25);
  assert.strictEqual(d.basic_pct, 25);
  assert.strictEqual(d.mood_only_pct, 50);
});

// ────────────────────────────────────────────────────────────────
section('deriveContributionMapMind');

test('always 365 cells regardless of input', () => {
  const r = M.deriveContributionMapMind({ dayQualityByDate: {}, anchorDate: '2026-05-23', todayDate: '2026-05-23' });
  assert.strictEqual(r.cells.length, 365);
});

test('pre-anchor cells tagged', () => {
  const r = M.deriveContributionMapMind({ dayQualityByDate: {}, anchorDate: '2026-05-23', todayDate: '2026-05-23' });
  const pre = r.cells.filter(c => c.pre_anchor).length;
  assert.strictEqual(pre, 364);  // 365 days back, only today is post-anchor
});

test('quality buckets (75/55 thresholds)', () => {
  const r = M.deriveContributionMapMind({
    dayQualityByDate: { '2026-05-23': 80, '2026-05-22': 60, '2026-05-21': 30 },
    anchorDate: '2025-01-01', todayDate: '2026-05-23',
  });
  const m = Object.fromEntries(r.cells.map(c => [c.date, c.level]));
  assert.strictEqual(m['2026-05-23'], 3);
  assert.strictEqual(m['2026-05-22'], 2);
  assert.strictEqual(m['2026-05-21'], 1);
});

// ────────────────────────────────────────────────────────────────
section('derivePlateauAnxiety');

test('flagged when anxiety stuck ≥3 for 3+ weeks', () => {
  const anxiety_scores = [3, 4, 3, 3, 4, 3, 3, 4, 3, 3, 4, 3, 3, 4, 3, 3, 4, 3, 3, 4, 3];  // 21 days >=3
  const dates = Array.from({ length: 21 }, (_, i) => {
    const d = new Date(2026, 4, 23 - i);
    return d.toISOString().slice(0, 10);
  });
  const r = M.derivePlateauAnxiety({ anxiety_scores, dates });
  assert.ok(r.stalled, 'should be stalled, got ' + JSON.stringify(r));
});

test('not flagged when last 7 average <3 (calm)', () => {
  const r = M.derivePlateauAnxiety({
    anxiety_scores: [1, 2, 2, 1, 1, 2, 2, 4, 4, 4, 4],
    dates: ['2026-05-23','2026-05-22','2026-05-21','2026-05-20','2026-05-19','2026-05-18','2026-05-17','2026-05-16','2026-05-15','2026-05-14','2026-05-13'],
  });
  assert.strictEqual(r.stalled, false);
});

// ────────────────────────────────────────────────────────────────
section('deriveCorrelationGrid (Bearable killer)');

test('null inputs → empty out', () => {
  const r = M.deriveCorrelationGrid({});
  assert.deepStrictEqual(r, {});
});

test('detects positive signal when high-factor days have higher mind quality', () => {
  const factors = {
    sleep_h: {
      '2026-05-23': 8, '2026-05-22': 8, '2026-05-21': 7.5,  // high-sleep
      '2026-05-20': 5, '2026-05-19': 5, '2026-05-18': 5.5,  // low-sleep
    },
  };
  const mindQualityByDate = {
    '2026-05-23': 80, '2026-05-22': 78, '2026-05-21': 75,
    '2026-05-20': 40, '2026-05-19': 35, '2026-05-18': 45,
  };
  const r = M.deriveCorrelationGrid({ factors, mindQualityByDate });
  assert.ok(r.sleep_h.has_signal, 'should detect signal');
  assert.ok(r.sleep_h.delta > 0, 'sleep delta should be positive');
});

test('no signal when both sides similar or n<3', () => {
  const r = M.deriveCorrelationGrid({
    factors: { water_pct: { '2026-05-23': 100, '2026-05-22': 100 } },
    mindQualityByDate: { '2026-05-23': 70, '2026-05-22': 60 },
  });
  assert.strictEqual(r.water_pct.has_signal, false);  // n too small
});

// ────────────────────────────────────────────────────────────────
section('deriveTopTrigger');

test('returns null when no triggers', () => {
  assert.strictEqual(M.deriveTopTrigger([{ mood: 3 }]), null);
});

test('finds most-frequent trigger + peak DOW', () => {
  const r = M.deriveTopTrigger([
    { date_str: '2026-05-18', triggers: ['work', 'sleep'] },  // Mon
    { date_str: '2026-05-19', triggers: ['work'] },           // Tue
    { date_str: '2026-05-20', triggers: ['family'] },         // Wed
    { date_str: '2026-05-25', triggers: ['work'] },           // Mon
  ], 14);
  assert.strictEqual(r.name, 'work');
  assert.strictEqual(r.count, 3);
});

// ────────────────────────────────────────────────────────────────
section('computeBlendedMindScore');

test('null when no mood data', () => {
  assert.strictEqual(M.computeBlendedMindScore({ mood_scores: [], anxiety_scores: [] }), null);
});

test('raw score always in [0, 100]', () => {
  const cases = [
    { mood_scores: [1], anxiety_scores: [5], days_logged: 1 },
    { mood_scores: [5,5,5,5,5,5,5,5,5,5], anxiety_scores: [1,1,1,1,1,1,1,1,1,1], days_logged: 10 },
    { mood_scores: [3], anxiety_scores: [3], days_logged: 1, recent_sleep_hours: 8 },
  ];
  for (const c of cases) {
    const r = M.computeBlendedMindScore(c);
    if (r === null) continue;
    assert.ok(r.raw >= 0 && r.raw <= 100, 'raw out of bounds: ' + r.raw);
  }
});

test('reports 5 components', () => {
  const r = M.computeBlendedMindScore({
    mood_scores: [4, 3, 4, 3, 4, 3, 4], anxiety_scores: [2, 2, 2, 2, 2, 2, 2],
    checkin_dates: ['2026-05-23','2026-05-22','2026-05-21','2026-05-20','2026-05-19','2026-05-18','2026-05-17'],
    days_logged: 7, streak: 7,
  });
  assert.ok(r.components.mood >= 0);
  assert.ok(r.components.anxiety >= 0);
  assert.ok(r.components.trajectory >= 0);
  assert.ok(r.components.consistency >= 0);
  assert.ok(r.components.sleep >= 0);
});

// ────────────────────────────────────────────────────────────────
console.log('\n' + p + ' passed, ' + f + ' failed');
process.exit(f === 0 ? 0 : 1);
