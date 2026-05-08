/**
 * daily-matrix.js
 * Builds date × agent score matrix from snapshots.
 * Output is the canonical input shape for the score engine + correlations.
 */

const { AGENTS } = require('../adapters/_shape');

/**
 * @param {Object<string, AgentSnapshot>} snapshots
 * @param {{ source?: 'last_30d'|'last_90d' }} [opts]
 * @returns {{
 *   dates: string[],
 *   matrix: Array<{ date: string, scores: Object<string, number|null>, has_log: Object<string, boolean> }>
 * }}
 */
function buildDailyMatrix(snapshots, opts = {}) {
  const source = opts.source === 'last_90d' ? 'last_90d' : 'last_30d';
  const sample = snapshots[AGENTS[0]] || snapshots.sleep;
  if (!sample) return { dates: [], matrix: [] };

  const series = sample[source] || sample.last_30d || [];
  const dates = series.map((p) => p.date);

  const matrix = dates.map((date) => {
    const scores = {};
    const has_log = {};
    for (const agent of AGENTS) {
      const snap = snapshots[agent];
      const lookup = snap && (snap[source] || snap.last_30d) ? (snap[source] || snap.last_30d) : null;
      const point = lookup ? lookup.find((p) => p.date === date) : null;
      scores[agent] = point && Number.isFinite(point.score) ? point.score : null;
      has_log[agent] = !!(point && point.has_log);
    }
    return { date, scores, has_log };
  });

  return { dates, matrix };
}

module.exports = { buildDailyMatrix };
