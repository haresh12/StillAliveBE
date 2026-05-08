/**
 * sparkline-smoother.js
 * Cleans up raw daily-score arrays for display:
 *   - 1-day gap in middle: average of neighbors
 *   - 2+ consecutive gaps: leave null (real gap)
 *   - Single-day spikes (|diff| > 25 vs both neighbors): smooth to median(prev, next)
 */

function smoothPoints(points) {
  if (!Array.isArray(points) || points.length === 0) return points;
  const out = points.map((p) => ({ ...p }));

  for (let i = 1; i < out.length - 1; i++) {
    const prev = out[i - 1];
    const cur = out[i];
    const next = out[i + 1];

    // 1-day gap: impute from neighbors
    if (!cur.has_data && prev.has_data && next.has_data) {
      const avg = Math.round((prev.value + next.value) / 2);
      out[i] = { ...cur, value: avg, has_data: true, _imputed: true };
      continue;
    }

    // Single-day spike: clip to neighbor median
    if (cur.has_data && prev.has_data && next.has_data) {
      const dPrev = Math.abs(cur.value - prev.value);
      const dNext = Math.abs(cur.value - next.value);
      if (dPrev > 25 && dNext > 25 && Math.abs(prev.value - next.value) < 15) {
        const median = Math.round((prev.value + next.value) / 2);
        out[i] = { ...cur, value: median, _smoothed: true };
      }
    }
  }

  return out;
}

module.exports = { smoothPoints };
