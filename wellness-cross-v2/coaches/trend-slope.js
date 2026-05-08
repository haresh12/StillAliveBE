/**
 * trend-slope.js
 * Linear regression on last-N normalized scores → slope (pts/day).
 * Negative = downtrend, 0 = flat, positive = uptrend.
 */

function trendSlope(points) {
  const valid = (points || []).filter((p) => Number.isFinite(p.value));
  const n = valid.length;
  if (n < 3) return 0;

  // x = day index 0..n-1, y = score
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    const x = i;
    const y = valid[i].value;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return 0;
  const slope = (n * sumXY - sumX * sumY) / denom;
  return Math.round(slope * 100) / 100; // pts per day, 2 decimals
}

module.exports = { trendSlope };
