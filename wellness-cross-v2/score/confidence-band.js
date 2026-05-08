/**
 * confidence-band.js
 * Steps 5 + 10 — per-agent confidence and overall confidence.
 */

const config = require('../config');

const W = config.SCORE.CONFIDENCE_WEIGHTS;
const DATA_TARGET = config.SCORE.CONFIDENCE_DATA_TARGET_DAYS;

function clip(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Step 5: per-agent confidence ∈ [0, 1].
 * = setup_active × log_consistency × age_factor
 * log_consistency = days_logged_in_14d / 14 (capped → anti-gaming)
 */
function agentConfidence(snapshot) {
  const setup = snapshot.setup.is_complete ? 1 : 0;
  const days_logged_14d = snapshot.last_14d.filter((p) => p.has_log).length;
  const log_consistency = clip(days_logged_14d / 14, 0, 1);
  const age_factor = clip(snapshot.setup.days_since_setup / 14, 0, 1);
  return clip(setup * log_consistency * age_factor, 0, 1);
}

/**
 * Step 10: overall confidence.
 * = 0.30 setup_factor + 0.50 data_factor + 0.20 consistency_factor
 */
function overallConfidence({ setup_count, total_days_logged, agent_consistencies }) {
  const setup_factor = clip(setup_count / 6, 0, 1);
  const data_factor = clip(total_days_logged / DATA_TARGET, 0, 1);
  const active = agent_consistencies.filter((c) => c > 0);
  const consistency_factor = active.length
    ? active.reduce((a, b) => a + b, 0) / active.length
    : 0;
  return clip(
    W.setup * setup_factor + W.data * data_factor + W.consistency * consistency_factor,
    0,
    1,
  );
}

module.exports = { agentConfidence, overallConfidence };
