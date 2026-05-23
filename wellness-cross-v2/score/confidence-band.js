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
 *
 * Day-1 fix (2026-05-22): the previous formula multiplied three factors —
 * setup × log_consistency × age_factor — which zeroed out confidence on
 * the very first day (days_since_setup = 0 → age_factor = 0 → conf = 0).
 * That zeroed `totalRaw` in computeWellness, forcing every fresh user
 * into the warm-start path even when they had real logs in front of them.
 * User-visible bug: log a great fitness session on signup day, wellness
 * score stays stuck at the 12 setup-only number.
 *
 * Fix: every logged day immediately contributes positive confidence.
 * - setup_active gates everything (no setup → 0).
 * - At least one log today/in last 14d → floor at 0.25 (so totalRaw > MIN_TOTAL_W)
 *   so the real-engine path runs and log quality flows into score.
 * - log_consistency still scales upward (more logs in 14d → higher conf)
 * - age_factor is now ADDITIVE (small bonus, max 0.25) instead of
 *   multiplicative, so an older account ramps up faster but a brand-new
 *   logger doesn't get zeroed.
 */
function agentConfidence(snapshot) {
  const setup = snapshot.setup.is_complete ? 1 : 0;
  if (!setup) return 0;
  const days_logged_14d = snapshot.last_14d.filter((p) => p.has_log).length;
  const log_consistency = clip(days_logged_14d / 14, 0, 1);
  const age_factor = clip(snapshot.setup.days_since_setup / 14, 0, 1);
  // Logged at all → minimum 0.25 floor. Scales up via log_consistency
  // and a small additive age_factor bonus.
  if (days_logged_14d > 0) {
    return clip(0.25 + 0.50 * log_consistency + 0.25 * age_factor, 0.25, 1);
  }
  // No logs in 14d — confidence stays low (just setup credit).
  return clip(0.10 * age_factor, 0, 0.10);
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
