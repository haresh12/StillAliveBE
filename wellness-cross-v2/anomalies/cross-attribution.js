/**
 * cross-attribution.js
 * Given today's anomalous agent X, find the strongest correlated drop in another agent
 * using yesterday's signals + the known correlation matrix.
 */

function attributeCause(anomaly, snapshots, correlations) {
  const targetAgent = anomaly.agent;
  // candidate cross-agent drops yesterday
  const yesterdaySignals = {};
  for (const [agent, snap] of Object.entries(snapshots)) {
    if (agent === targetAgent) continue;
    const last = snap.last_14d[snap.last_14d.length - 2]; // yesterday
    if (!last || !last.has_log || !Number.isFinite(last.score)) continue;
    yesterdaySignals[agent] = last.score;
  }
  if (!Object.keys(yesterdaySignals).length) {
    return { likely_cause_agent: null, confidence: 0, drill_correlation_id: null };
  }

  const relevant = correlations.filter((c) =>
    c.agents.includes(targetAgent) && Math.abs(c.r) >= 0.3 && c.n >= 14,
  );
  if (!relevant.length) {
    return { likely_cause_agent: null, confidence: 0, drill_correlation_id: null };
  }

  let best = null;
  for (const c of relevant) {
    const otherAgent = c.agents[0] === targetAgent ? c.agents[1] : c.agents[0];
    const otherScore = yesterdaySignals[otherAgent];
    if (!Number.isFinite(otherScore)) continue;

    // For a positive correlation: low other-agent score yesterday explains low target-agent today.
    const otherDelta = otherScore - 50; // crude delta vs neutral
    const expectedSign = c.r >= 0 ? Math.sign(otherDelta) : -Math.sign(otherDelta);
    const actualSign = Math.sign(anomaly.today_score - anomaly.baseline_mean);

    if (expectedSign === actualSign && expectedSign !== 0) {
      const score = Math.abs(c.r) * Math.min(1, Math.abs(otherDelta) / 25);
      if (!best || score > best.score) {
        best = {
          score,
          likely_cause_agent: otherAgent,
          drill_correlation_id: c.id,
          r: c.r,
          confidence: Math.round(score * 100) / 100,
        };
      }
    }
  }

  if (!best) return { likely_cause_agent: null, confidence: 0, drill_correlation_id: null };

  return {
    likely_cause_agent: best.likely_cause_agent,
    drill_correlation_id: best.drill_correlation_id,
    confidence: best.confidence,
  };
}

module.exports = { attributeCause };
