/**
 * tests/correlations.test.js
 */

const assert = require('assert');
const { pearson, spearman, benjaminiHochberg } = require('../correlations/stats');
const { computeCorrelations, selectTop } = require('../correlations/correlation-engine');
const { translate } = require('../correlations/plain-english-translator');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`✓ ${name}`); }
  catch (e) { fail++; console.error(`✗ ${name}\n  ${e.message}`); }
}

t('pearson perfect positive', () => {
  const r = pearson([1, 2, 3, 4, 5], [10, 20, 30, 40, 50]);
  assert.ok(Math.abs(r.r - 1) < 0.01, `r=${r.r}`);
});

t('pearson perfect negative', () => {
  const r = pearson([1, 2, 3, 4, 5], [50, 40, 30, 20, 10]);
  assert.ok(Math.abs(r.r + 1) < 0.01);
});

t('pearson zero correlation', () => {
  const r = pearson([1, 2, 3, 4, 5], [3, 1, 4, 1, 5]);
  assert.ok(Math.abs(r.r) < 0.5);
});

t('spearman handles ties', () => {
  const r = spearman([1, 1, 2, 3, 3], [10, 11, 20, 30, 31]);
  assert.ok(r.r > 0.8);
});

t('benjaminiHochberg flags only true positives', () => {
  const items = [
    { p: 0.001 }, { p: 0.01 }, { p: 0.04 }, { p: 0.5 }, { p: 0.9 },
  ];
  const flagged = benjaminiHochberg(items, 0.05);
  assert.strictEqual(flagged[0].bh_significant, true);
  assert.strictEqual(flagged[3].bh_significant, false);
});

t('computeCorrelations on synthetic positive sleep×mind', () => {
  const matrix = [];
  for (let i = 0; i < 30; i++) {
    const sleepScore = 50 + (i % 10) * 4;
    const mindScore = sleepScore + 5;
    const date = `2026-04-${String(i + 1).padStart(2, '0')}`;
    matrix.push({
      date,
      scores: { sleep: sleepScore, mind: mindScore, nutrition: 60, fitness: 60, water: 60, fasting: 60 },
      has_log: { sleep: true, mind: true, nutrition: true, fitness: true, water: true, fasting: true },
    });
  }
  const all = computeCorrelations(matrix);
  const sleepMind = all.find((c) => c.pair === 'sleep×mind' && c.window_days === 30 && c.lag === 0);
  assert.ok(sleepMind, 'sleep×mind should compute');
  assert.ok(sleepMind.r > 0.8, `r should be high, got ${sleepMind.r}`);
});

t('selectTop returns ≤K results, dedups by pair', () => {
  const matrix = [];
  for (let i = 0; i < 30; i++) {
    matrix.push({
      date: `2026-04-${String(i + 1).padStart(2, '0')}`,
      scores: { sleep: 50 + i, mind: 50 + i, nutrition: 80, fitness: 70, water: 60, fasting: 65 },
      has_log: { sleep: true, mind: true, nutrition: true, fitness: true, water: true, fasting: true },
    });
  }
  const all = computeCorrelations(matrix);
  const top = selectTop(all, 3);
  assert.ok(top.length <= 3);
  const pairs = new Set(top.map((c) => c.pair));
  assert.strictEqual(pairs.size, top.length, 'pairs deduped');
});

t('translate produces plain English for known pair', () => {
  const text = translate({
    agents: ['sleep', 'mind'], r: 0.6, n: 25, lag: 0, direction: 'positive',
  });
  assert.ok(typeof text === 'string' && text.length > 5);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
