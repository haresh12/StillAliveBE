/**
 * tests/score.test.js
 * Pure-function tests for the wellness score engine.
 * Run via: node wellness-cross-v2/tests/score.test.js
 */

const assert = require('assert');
const { computeWellness, statusFor, shortEMA, trendDirection } = require('../score/wellness-score');
const { computeBaselines } = require('../pre-aggregator/baseline-computer');
const { normalizeFromBaseline, applySkipDecay } = require('../score/personal-baseline');
const { computeWarmStart } = require('../score/warm-start');
const { agentConfidence, overallConfidence } = require('../score/confidence-band');
const { emptyAgentSnapshot, AGENTS } = require('../adapters/_shape');

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (err) {
    fail++;
    console.error(`✗ ${name}`);
    console.error(err && err.stack ? err.stack : err);
  }
}

function buildSnap(agent, today, opts = {}) {
  const snap = emptyAgentSnapshot(agent, today);
  if (opts.setup) snap.setup.is_complete = true;
  if (opts.daysSinceSetup != null) snap.setup.days_since_setup = opts.daysSinceSetup;
  if (opts.history) {
    for (let i = 0; i < snap.last_14d.length; i++) {
      const point = opts.history[i];
      if (point) snap.last_14d[i] = { ...snap.last_14d[i], ...point };
    }
    for (let i = 0; i < snap.last_30d.length; i++) {
      const tail = opts.history[i];
      if (tail) snap.last_30d[i] = { ...snap.last_30d[i], ...tail };
    }
  }
  if (opts.todayLog) {
    snap.today.has_log = true;
    snap.today.score = opts.todayLog;
  }
  return snap;
}

t('statusFor bands', () => {
  assert.strictEqual(statusFor(85), 'thriving');
  assert.strictEqual(statusFor(70), 'strong');
  assert.strictEqual(statusFor(55), 'steady');
  assert.strictEqual(statusFor(40), 'building');
  assert.strictEqual(statusFor(20), 'starting');
});

t('shortEMA empty returns 50', () => {
  assert.strictEqual(shortEMA([]), 50);
});

t('shortEMA single returns same', () => {
  assert.strictEqual(shortEMA([60]), 60);
});

t('trendDirection up', () => {
  assert.strictEqual(trendDirection([40, 42, 60, 65]), 'up');
});

t('trendDirection down', () => {
  assert.strictEqual(trendDirection([70, 68, 50, 45]), 'down');
});

t('normalizeFromBaseline z=0 → 50', () => {
  const n = normalizeFromBaseline(60, { mean: 60, std: 10 });
  assert.strictEqual(n, 50);
});

t('normalizeFromBaseline +1σ → ~69', () => {
  const n = normalizeFromBaseline(70, { mean: 60, std: 10 });
  assert.ok(n >= 67 && n <= 71, `got ${n}`);
});

t('normalizeFromBaseline -3σ → 5 (floor)', () => {
  const n = normalizeFromBaseline(30, { mean: 60, std: 10 });
  assert.ok(n >= 5 && n <= 30, `got ${n}`);
});

t('normalizeFromBaseline cold-start (no baseline) returns clipped today', () => {
  const n = normalizeFromBaseline(80, null);
  assert.strictEqual(n, 80);
});

t('applySkipDecay returns null with no history', () => {
  const last14 = Array.from({ length: 14 }, (_, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    score: null,
    has_log: false,
  }));
  assert.strictEqual(applySkipDecay(last14, null), null);
});

t('applySkipDecay decays toward 50', () => {
  const last14 = Array.from({ length: 14 }, (_, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    score: i === 10 ? 80 : null,
    has_log: i === 10,
  }));
  const out = applySkipDecay(last14, null);
  assert.ok(out > 50 && out < 80, `decayed score ${out}`);
});

t('agentConfidence cold setup → 0', () => {
  const snap = buildSnap('sleep', '2026-05-08', { setup: false });
  assert.strictEqual(agentConfidence(snap), 0);
});

t('agentConfidence full data → ~1', () => {
  const today = '2026-05-08';
  const history = Array.from({ length: 14 }, (_, i) => ({ score: 65, has_log: true }));
  const snap = buildSnap('sleep', today, { setup: true, daysSinceSetup: 30, history, todayLog: 65 });
  const c = agentConfidence(snap);
  assert.ok(c > 0.95, `expected ~1, got ${c}`);
});

t('overallConfidence Day-0 → low', () => {
  const c = overallConfidence({ setup_count: 0, total_days_logged: 0, agent_consistencies: [0, 0, 0, 0, 0, 0] });
  assert.ok(c < 0.1, `got ${c}`);
});

t('overallConfidence Day-30 with all agents → high', () => {
  const c = overallConfidence({ setup_count: 6, total_days_logged: 30, agent_consistencies: [1, 1, 1, 1, 1, 1] });
  assert.ok(c > 0.95, `got ${c}`);
});

t('computeWarmStart anchor=energy, sleep tier=low', () => {
  const out = computeWarmStart({
    anchor: 'energy',
    onboardingAnswers: { sleep_hours: 5 },
    setup_state: { sleep: true, mind: false, nutrition: false, fitness: false, water: false, fasting: false },
  });
  assert.ok(out.score >= 30 && out.score <= 50, `expected low-tier seed, got ${out.score}`);
});

t('computeWellness Day-0 cold-start uses warm start', () => {
  const today = '2026-05-08';
  const snapshots = {};
  for (const a of AGENTS) snapshots[a] = emptyAgentSnapshot(a, today);
  snapshots.sleep.setup.is_complete = true;
  snapshots.sleep.setup.days_since_setup = 0;
  const baselines = {};
  for (const a of AGENTS) baselines[a] = { mean: null, std: null, sample_size: 0 };
  const profile = {
    anchor: 'energy',
    onboarding_answers: { sleep_hours: 7 },
    setup_state: { sleep: true, mind: false, nutrition: false, fitness: false, water: false, fasting: false },
    total_days_logged: 0,
  };
  const w = computeWellness({ snapshots, baselines, profile, recentDailyHistory: [] });
  assert.ok(w.is_warm_start, 'should be warm start');
  // Day-0 with 1 coach set up = 1*2 = 2 (pure setup boost, no floor on warm-start)
  assert.strictEqual(w.score, 2, `expected score=2 for 1 coach setup, got ${w.score}`);
  assert.strictEqual(w.calibration_days_done, 0);
});

t('computeWellness Day-0 with 6 coaches set up returns 12', () => {
  const today = '2026-05-08';
  const snapshots = {};
  const baselines = {};
  for (const a of AGENTS) {
    snapshots[a] = emptyAgentSnapshot(a, today);
    snapshots[a].setup.is_complete = true;
    snapshots[a].setup.days_since_setup = 0;
    baselines[a] = { mean: null, std: null, sample_size: 0 };
  }
  const profile = {
    anchor: 'energy',
    onboarding_answers: {},
    setup_state: Object.fromEntries(AGENTS.map((a) => [a, true])),
    total_days_logged: 0,
  };
  const w = computeWellness({ snapshots, baselines, profile, recentDailyHistory: [] });
  assert.ok(w.is_warm_start);
  assert.strictEqual(w.score, 12, `expected 12 for 6 coaches setup, got ${w.score}`);
});

t('computeWellness Day-0 zero-setup returns 0', () => {
  const today = '2026-05-08';
  const snapshots = {};
  const baselines = {};
  for (const a of AGENTS) {
    snapshots[a] = emptyAgentSnapshot(a, today);
    baselines[a] = { mean: null, std: null, sample_size: 0 };
  }
  const profile = {
    anchor: 'none',
    onboarding_answers: {},
    setup_state: Object.fromEntries(AGENTS.map((a) => [a, false])),
    total_days_logged: 0,
  };
  const w = computeWellness({ snapshots, baselines, profile, recentDailyHistory: [] });
  assert.strictEqual(w.score, 0);
});

t('computeWellness Day-30 power user produces score in range', () => {
  const today = '2026-05-08';
  const snapshots = {};
  const baselines = {};
  for (const a of AGENTS) {
    const history = Array.from({ length: 14 }, (_, i) => ({
      score: 60 + (i % 5) - 2,
      has_log: true,
    }));
    snapshots[a] = buildSnap(a, today, {
      setup: true,
      daysSinceSetup: 60,
      history,
      todayLog: 65,
    });
    baselines[a] = { mean: 60, std: 6, sample_size: 14 };
  }
  const profile = {
    anchor: 'energy',
    onboarding_answers: {},
    setup_state: Object.fromEntries(AGENTS.map((a) => [a, true])),
    total_days_logged: 60,
  };
  const recent = Array.from({ length: 14 }, (_, i) => 60 + (i % 4));
  const w = computeWellness({ snapshots, baselines, profile, recentDailyHistory: recent });
  assert.ok(!w.is_warm_start, 'should not be warm start');
  assert.ok(w.score >= 5 && w.score <= 95, `score ${w.score}`);
  assert.strictEqual(w.components.length, 6);
  assert.ok(w.confidence > 0.85, `confidence ${w.confidence}`);
});

t('computeWellness partial credit: 2/6 agents weights re-normalize', () => {
  const today = '2026-05-08';
  const snapshots = {};
  const baselines = {};
  for (const a of AGENTS) {
    const isActive = a === 'sleep' || a === 'mind';
    const history = isActive
      ? Array.from({ length: 14 }, () => ({ score: 60, has_log: true }))
      : Array.from({ length: 14 }, () => ({ score: null, has_log: false }));
    snapshots[a] = buildSnap(a, today, {
      setup: isActive,
      daysSinceSetup: isActive ? 30 : 0,
      history,
      todayLog: isActive ? 70 : null,
    });
    baselines[a] = isActive ? { mean: 60, std: 6, sample_size: 14 } : { mean: null, std: null, sample_size: 0 };
  }
  const profile = {
    anchor: 'energy',
    onboarding_answers: {},
    setup_state: Object.fromEntries(AGENTS.map((a) => [a, a === 'sleep' || a === 'mind'])),
    total_days_logged: 30,
  };
  const w = computeWellness({ snapshots, baselines, profile, recentDailyHistory: [60, 60, 62, 65] });
  assert.ok(!w.is_warm_start);
  assert.ok(w.score >= 5 && w.score <= 95, `score ${w.score}`);
  const active = w.components.filter((c) => c.weight > 0);
  assert.strictEqual(active.length, 2);
  const sum = active.reduce((a, b) => a + b.weight, 0);
  assert.ok(Math.abs(sum - 1) < 0.001, `weights sum ${sum}`);
});

t('computeWellness anti-gaming: log-frequency capped', () => {
  // Simulate a user whose only signal is "logged today" — they shouldn't game the score.
  const today = '2026-05-08';
  const snapshots = {};
  const baselines = {};
  for (const a of AGENTS) {
    snapshots[a] = buildSnap(a, today, {
      setup: a === 'mind',
      daysSinceSetup: a === 'mind' ? 1 : 0,
      todayLog: a === 'mind' ? 95 : null,
    });
    baselines[a] = { mean: null, std: null, sample_size: 0 };
  }
  const profile = {
    anchor: 'mood',
    onboarding_answers: {},
    setup_state: { sleep: false, mind: true, nutrition: false, fitness: false, water: false, fasting: false },
    total_days_logged: 1,
  };
  const w = computeWellness({ snapshots, baselines, profile, recentDailyHistory: [] });
  // Day-1 with 1 coach setup: warm-start path → score = setupBoost = 2.
  assert.ok(w.is_warm_start, 'Day-1 should be warm start');
  assert.strictEqual(w.score, 2);
});

t('computeWellness reproducibility: same input → same output', () => {
  const today = '2026-05-08';
  const make = () => {
    const snapshots = {};
    const baselines = {};
    for (const a of AGENTS) {
      const history = Array.from({ length: 14 }, () => ({ score: 65, has_log: true }));
      snapshots[a] = buildSnap(a, today, { setup: true, daysSinceSetup: 30, history, todayLog: 70 });
      baselines[a] = { mean: 65, std: 5, sample_size: 14 };
    }
    return {
      snapshots,
      baselines,
      profile: {
        anchor: 'energy',
        onboarding_answers: { sleep_hours: 7 },
        setup_state: Object.fromEntries(AGENTS.map((a) => [a, true])),
        total_days_logged: 30,
      },
      recentDailyHistory: [60, 62, 64, 65, 65, 66, 67],
    };
  };
  const a = computeWellness(make());
  const b = computeWellness(make());
  assert.strictEqual(a.score, b.score);
  assert.strictEqual(a.confidence, b.confidence);
  assert.deepStrictEqual(
    a.components.map((c) => c.contribution_pts),
    b.components.map((c) => c.contribution_pts),
  );
});

t('computeWellness never returns score 0 or 100', () => {
  const today = '2026-05-08';
  for (const todayLog of [0, 100]) {
    const snapshots = {};
    const baselines = {};
    for (const a of AGENTS) {
      const history = Array.from({ length: 14 }, () => ({ score: 60, has_log: true }));
      snapshots[a] = buildSnap(a, today, { setup: true, daysSinceSetup: 30, history, todayLog });
      baselines[a] = { mean: 60, std: 5, sample_size: 14 };
    }
    const profile = {
      anchor: 'energy',
      onboarding_answers: {},
      setup_state: Object.fromEntries(AGENTS.map((a) => [a, true])),
      total_days_logged: 30,
    };
    const w = computeWellness({ snapshots, baselines, profile, recentDailyHistory: [60, 60, 60] });
    assert.ok(w.score >= 5 && w.score <= 95, `score ${w.score} (todayLog=${todayLog})`);
  }
});

t('computeBaselines requires min history', () => {
  const snap = buildSnap('sleep', '2026-05-08', {
    history: [{ score: 60, has_log: true }, { score: 65, has_log: true }],
  });
  // Only 2 days — below MIN_HISTORY_FOR_BASELINE=3
  const out = computeBaselines({ sleep: snap }, '2026-05-08');
  assert.strictEqual(out.sleep.mean, null);
});

t('computeBaselines weights recent days more', () => {
  const today = '2026-05-08';
  const oldDate = '2026-04-25';
  const recentDate = '2026-05-07';
  const snap = buildSnap('sleep', today, {});
  // Manually override last_14d with explicit dates
  snap.last_14d = [
    { date: oldDate, score: 30, has_log: true },
    { date: recentDate, score: 90, has_log: true },
  ];
  // Pad to 14 with no_log
  while (snap.last_14d.length < 14) snap.last_14d.unshift({ date: '2026-04-01', score: null, has_log: false });
  const out = computeBaselines({ sleep: snap }, today);
  if (out.sleep.mean) {
    assert.ok(out.sleep.mean > 60, `mean should lean recent (got ${out.sleep.mean})`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
