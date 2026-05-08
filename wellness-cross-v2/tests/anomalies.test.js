/**
 * tests/anomalies.test.js
 */

const assert = require('assert');
const { detectAnomalies } = require('../anomalies/anomaly-detector');
const { attributeCause } = require('../anomalies/cross-attribution');
const { emptyAgentSnapshot, AGENTS } = require('../adapters/_shape');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`✓ ${name}`); }
  catch (e) { fail++; console.error(`✗ ${name}\n  ${e.message}`); }
}

function mkSnap(agent, today, todayScore, hist = []) {
  const s = emptyAgentSnapshot(agent, today);
  s.setup.is_complete = true;
  s.today.has_log = todayScore !== null;
  s.today.score = todayScore;
  // Fill last_14d from hist (most-recent last)
  for (let i = 0; i < hist.length && i < 14; i++) {
    const idx = 14 - 1 - i;
    s.last_14d[idx] = { ...s.last_14d[idx], score: hist[i], has_log: hist[i] !== null };
  }
  return s;
}

t('detectAnomalies skips agents below MIN_HISTORY', () => {
  const snap = mkSnap('sleep', '2026-05-08', 30, [60, 60]);
  const out = detectAnomalies({
    snapshots: { sleep: snap },
    baselines: { sleep: { mean: 60, std: 5, sample_size: 2 } }, // < 7
  });
  assert.strictEqual(out.length, 0);
});

t('detectAnomalies catches a high-severity dip', () => {
  const snap = mkSnap('sleep', '2026-05-08', 30, [65, 64, 66, 65, 67, 65, 64, 66]);
  const out = detectAnomalies({
    snapshots: { sleep: snap },
    baselines: { sleep: { mean: 65, std: 2, sample_size: 8 } },
  });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].agent, 'sleep');
  assert.strictEqual(out[0].direction, 'dip');
  assert.strictEqual(out[0].severity, 'high'); // |z| = 17.5 > 3
});

t('detectAnomalies surfaces a spike', () => {
  const snap = mkSnap('mind', '2026-05-08', 88, [55, 56, 55, 57, 56, 55, 56, 57]);
  const out = detectAnomalies({
    snapshots: { mind: snap },
    baselines: { mind: { mean: 56, std: 5, sample_size: 8 } },
  });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].direction, 'spike');
});

t('detectAnomalies sorts by severity then |z|', () => {
  const snaps = {};
  const baselines = {};
  for (const a of AGENTS) snaps[a] = emptyAgentSnapshot(a, '2026-05-08');
  // sleep: high severity dip
  snaps.sleep = mkSnap('sleep', '2026-05-08', 30, [65, 65, 65, 65, 65, 65, 65, 65]);
  baselines.sleep = { mean: 65, std: 5, sample_size: 8 };
  // mind: medium severity spike
  snaps.mind = mkSnap('mind', '2026-05-08', 75, [60, 61, 60, 59, 60, 60, 61, 60]);
  baselines.mind = { mean: 60, std: 5, sample_size: 8 };
  const out = detectAnomalies({ snapshots: snaps, baselines });
  assert.strictEqual(out[0].agent, 'sleep'); // high before med
});

t('attributeCause picks correlated agent with right sign', () => {
  const today = '2026-05-08';
  // mkSnap puts hist[i] at last_14d[13-i]. Yesterday (idx 12) = hist[1].
  // Yesterday sleep = 25 (low) explains today's mind dip via positive correlation.
  const sleepSnap = mkSnap('sleep', today, 30, [70, 25, 70, 70, 70, 70, 70, 70]);
  const mindSnap = mkSnap('mind', today, 35, [65, 65, 65, 65, 65, 65, 65, 65]);
  const anomaly = {
    agent: 'mind',
    today_score: 35,
    baseline_mean: 65,
  };
  const correlations = [{
    id: 'abc',
    agents: ['sleep', 'mind'],
    pair: 'sleep×mind',
    r: 0.7,
    n: 28,
  }];
  const out = attributeCause(anomaly, { sleep: sleepSnap, mind: mindSnap }, correlations);
  assert.strictEqual(out.likely_cause_agent, 'sleep');
  assert.strictEqual(out.drill_correlation_id, 'abc');
});

t('attributeCause returns null when no relevant correlation', () => {
  const today = '2026-05-08';
  const anomaly = { agent: 'mind', today_score: 30, baseline_mean: 60 };
  const out = attributeCause(anomaly, {}, []);
  assert.strictEqual(out.likely_cause_agent, null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
