/**
 * correlation-engine.js
 * 15 pairwise agent combos × 3 windows × 3 lags.
 * Filters by min_n, min_abs_r, BH FDR.
 */

const crypto = require('crypto');
const config = require('../config');
const { pearson, spearman, benjaminiHochberg } = require('./stats');

const AGENTS = config.CORRELATIONS.AGENTS;
const WINDOWS = config.CORRELATIONS.WINDOWS_DAYS;
const LAGS = config.CORRELATIONS.LAGS;
const MIN_N = config.CORRELATIONS.MIN_N;
const MIN_ABS_R = config.CORRELATIONS.MIN_ABS_R;
const ALPHA = config.CORRELATIONS.BH_FDR_ALPHA;

function pairs() {
  const out = [];
  for (let i = 0; i < AGENTS.length; i++) {
    for (let j = i + 1; j < AGENTS.length; j++) {
      out.push([AGENTS[i], AGENTS[j]]);
    }
  }
  return out;
}

function makeId(a, b, window, lag) {
  const h = crypto.createHash('sha1').update(`${a}-${b}-${window}-${lag}`).digest('hex');
  return h.slice(0, 12);
}

/**
 * Pull aligned (x, y) pairs for two agents over a window with a given lag.
 * lag=0 → same-day; lag=-1 → A on day d-1 vs B on day d; lag=+1 → A on day d vs B on day d+1.
 */
function alignedPairs(matrix, agentA, agentB, window, lag) {
  const window_data = matrix.slice(-window);
  const xs = [];
  const ys = [];
  const dates = [];
  for (let i = 0; i < window_data.length; i++) {
    const partnerIdx = i - lag;
    if (partnerIdx < 0 || partnerIdx >= window_data.length) continue;
    const xRow = window_data[partnerIdx];
    const yRow = window_data[i];
    if (!xRow || !yRow) continue;
    const x = xRow.scores[agentA];
    const y = yRow.scores[agentB];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    xs.push(x);
    ys.push(y);
    dates.push(yRow.date);
  }
  return { xs, ys, dates };
}

/**
 * Quartile evidence: top-quartile of A → mean B, bottom-quartile of A → mean B.
 */
function quartileEvidence(xs, ys, dates) {
  const indexed = xs.map((x, i) => ({ x, y: ys[i], date: dates[i] }));
  indexed.sort((a, b) => a.x - b.x);
  const q = Math.floor(indexed.length / 4);
  const low = indexed.slice(0, Math.max(1, q));
  const high = indexed.slice(-Math.max(1, q));
  const meanLow = low.reduce((s, p) => s + p.y, 0) / low.length;
  const meanHigh = high.reduce((s, p) => s + p.y, 0) / high.length;
  // 5 example dates spaced through indexed
  const step = Math.max(1, Math.floor(indexed.length / 5));
  const examples = [];
  for (let i = 0; i < indexed.length && examples.length < 5; i += step) {
    examples.push(indexed[i].date);
  }
  return {
    high_days_avg: Math.round(meanHigh * 10) / 10,
    low_days_avg: Math.round(meanLow * 10) / 10,
    example_dates: examples,
  };
}

function confidenceLabel(absR, n) {
  if (n < MIN_N) return 'weak';
  if (absR >= 0.5 && n >= 28) return 'strong';
  if (absR >= 0.4 || (absR >= 0.3 && n >= 30)) return 'moderate';
  return 'weak';
}

/**
 * @param {Array} matrix - daily-matrix rows (oldest → newest)
 * @returns {Array} all candidate correlations with BH significance + filtering metadata
 */
function computeCorrelations(matrix) {
  const candidates = [];
  for (const [a, b] of pairs()) {
    for (const window of WINDOWS) {
      for (const lag of LAGS) {
        const { xs, ys, dates } = alignedPairs(matrix, a, b, window, lag);
        if (xs.length < 3) continue;

        const pear = pearson(xs, ys);
        const spear = spearman(xs, ys);
        const r = pear.r;
        const p = pear.p;
        if (r == null || !Number.isFinite(r)) continue;

        const evidence = quartileEvidence(xs, ys, dates);

        candidates.push({
          id: makeId(a, b, window, lag),
          pair: `${a}×${b}`,
          agents: [a, b],
          window_days: window,
          lag,
          r,
          p,
          spearman_r: spear.r,
          n: xs.length,
          direction: r >= 0 ? 'positive' : 'negative',
          plain_english: null, // filled by translator
          evidence,
          confidence_label: confidenceLabel(Math.abs(r), xs.length),
        });
      }
    }
  }

  const flagged = benjaminiHochberg(candidates, ALPHA);
  return flagged;
}

/**
 * Pick top-K visible correlations.
 * Filter: n ≥ MIN_N, |r| ≥ MIN_ABS_R, prefer BH-significant.
 */
function selectTop(correlations, k = config.CORRELATIONS.TOP_K) {
  const eligible = correlations.filter(
    (c) => c.n >= MIN_N && Math.abs(c.r) >= MIN_ABS_R,
  );
  eligible.sort((a, b) => {
    if (a.bh_significant !== b.bh_significant) return a.bh_significant ? -1 : 1;
    return Math.abs(b.r) - Math.abs(a.r);
  });
  // de-dup pairs (keep best window/lag per pair)
  const seen = new Set();
  const out = [];
  for (const c of eligible) {
    if (seen.has(c.pair)) continue;
    seen.add(c.pair);
    out.push(c);
    if (out.length >= k) break;
  }
  return out;
}

module.exports = { computeCorrelations, selectTop };
