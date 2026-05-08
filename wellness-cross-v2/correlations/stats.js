/**
 * stats.js — Pearson, Spearman, Benjamini-Hochberg.
 * Pure functions, no deps.
 */

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function pearson(xs, ys) {
  if (xs.length !== ys.length || xs.length < 3) return { r: null, p: null, n: xs.length };
  const n = xs.length;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  if (den === 0) return { r: 0, p: 1, n };
  const r = num / den;
  // t-statistic for Pearson r
  const t = r * Math.sqrt(Math.max(1, n - 2) / Math.max(1e-9, 1 - r * r));
  const p = 2 * (1 - studentTcdf(Math.abs(t), n - 2));
  return { r: round(r, 4), p: round(p, 4), n };
}

function rank(arr) {
  const indexed = arr.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(arr.length);
  for (let i = 0; i < indexed.length; i++) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].v === indexed[i].v) j++;
    const avgRank = (i + j + 2) / 2; // 1-indexed average
    for (let k = i; k <= j; k++) ranks[indexed[k].i] = avgRank;
    i = j;
  }
  return ranks;
}

function spearman(xs, ys) {
  if (xs.length !== ys.length || xs.length < 3) return { r: null, p: null, n: xs.length };
  return pearson(rank(xs), rank(ys));
}

/**
 * Benjamini-Hochberg FDR correction.
 * Input: array of {p, ...rest}. Returns same array tagged with `bh_significant`.
 */
function benjaminiHochberg(items, alpha = 0.05) {
  const sorted = [...items]
    .map((item, idx) => ({ idx, p: item.p, item }))
    .filter((x) => Number.isFinite(x.p))
    .sort((a, b) => a.p - b.p);
  const m = sorted.length;
  let kStar = 0;
  for (let i = 0; i < m; i++) {
    const threshold = ((i + 1) / m) * alpha;
    if (sorted[i].p <= threshold) kStar = i + 1;
  }
  const significantSet = new Set(sorted.slice(0, kStar).map((x) => x.idx));
  return items.map((item, idx) => ({ ...item, bh_significant: significantSet.has(idx) }));
}

/**
 * Approximation of Student's t-distribution CDF.
 * Uses Hill's algorithm — accurate for df ≥ 1.
 */
function studentTcdf(t, df) {
  if (df < 1) return 0.5;
  if (!Number.isFinite(t)) return 1;
  const x = df / (df + t * t);
  return 1 - 0.5 * incompleteBeta(x, df / 2, 0.5);
}

function incompleteBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;
  return front * cf(x, a, b);
}

function cf(x, a, b) {
  const MAX = 100;
  const EPS = 1e-9;
  let f = 1;
  let c = 1;
  let d = 0;
  for (let i = 0; i <= MAX; i++) {
    const m = i / 2;
    let numerator;
    if (i === 0) numerator = 1;
    else if (i % 2 === 0) numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    else numerator = -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + numerator * d;
    if (Math.abs(d) < EPS) d = EPS;
    d = 1 / d;
    c = 1 + numerator / c;
    if (Math.abs(c) < EPS) c = EPS;
    const delta = c * d;
    f *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  return f - 1;
}

function lnGamma(x) {
  const c = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function round(n, digits = 2) {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

module.exports = { pearson, spearman, benjaminiHochberg, mean };
