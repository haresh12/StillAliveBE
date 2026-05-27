'use strict';
/**
 * user-weight-tilt.js — V3 user personalization of Wellness Score weights.
 *
 * Per SCORING_CONTRACT_V3.md §3: user can tilt up-to-±15% per agent.
 * Tilts are renormalized so weights still sum to 1.00.
 *
 * Input:
 *   baseWeights: { sleep: 0.25, fitness: 0.20, ... } from config.SCORE.BASE_WEIGHTS
 *   userTilts:   { sleep: 0.1, fasting: -0.05 } — partial overrides, range ±0.15
 *
 * Output:
 *   adjusted weights summing to 1.00, capped per agent at base ± 0.15.
 *
 * Pure: no I/O, no clock.
 */

const TILT_CAP = 0.15;

function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Apply per-agent tilts to base weights.
 *
 * Example:
 *   base = { sleep: 0.25, fitness: 0.20, mind: 0.20, nutrition: 0.15, water: 0.10, fasting: 0.10 }
 *   tilt = { sleep: +0.10 } → boost sleep importance by 10pts
 *   result: sleep weight ≈ 0.275 (after renormalize), others scaled down proportionally.
 *
 * If `userTilts` is null/empty, returns base weights unchanged.
 */
function applyUserWeightTilt(baseWeights, userTilts = null) {
  if (!baseWeights || typeof baseWeights !== 'object') return baseWeights;
  if (!userTilts || typeof userTilts !== 'object') return { ...baseWeights };

  const tiltedRaw = {};
  for (const [agent, base] of Object.entries(baseWeights)) {
    const tilt = Number.isFinite(userTilts[agent]) ? _clamp(userTilts[agent], -TILT_CAP, TILT_CAP) : 0;
    // Apply tilt as additive shift, floor at 0 so an agent can't go negative.
    tiltedRaw[agent] = Math.max(0, base + tilt);
  }

  // Renormalize so weights still sum to 1.00
  const total = Object.values(tiltedRaw).reduce((s, w) => s + w, 0);
  if (total <= 0) return { ...baseWeights };
  const out = {};
  for (const [agent, w] of Object.entries(tiltedRaw)) {
    out[agent] = w / total;
  }
  return out;
}

/**
 * Validate that user tilts are within the allowed range.
 * Returns { valid: bool, errors: string[] }.
 */
function validateUserTilts(userTilts) {
  if (!userTilts || typeof userTilts !== 'object') return { valid: true, errors: [] };
  const errors = [];
  for (const [agent, tilt] of Object.entries(userTilts)) {
    if (!Number.isFinite(tilt)) {
      errors.push(`${agent}: tilt is not a number (${tilt})`);
      continue;
    }
    if (Math.abs(tilt) > TILT_CAP) {
      errors.push(`${agent}: tilt ${tilt} exceeds cap of ±${TILT_CAP}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  TILT_CAP,
  applyUserWeightTilt,
  validateUserTilts,
};
