/**
 * cross-coach-interactions.js
 * Adjustment matrix that re-weights coaches based on other coaches' state.
 *
 * Rules (each capped to ±15% of base weight, no compounding above ±30% total):
 *   - Sleep < 50  → mood/mind weight ×1.20  (mood matters more when sleep is bad)
 *   - Hydration < 40 → fitness weight ×0.90 (fitness reading unreliable when dehydrated)
 *   - Fasting active → nutrition weight ×0.85 (don't penalize for low-cal day)
 *   - Sleep > 75  → fitness weight ×1.10  (well-rested → fitness is a fairer signal)
 *   - Mind > 75   → nutrition weight ×1.05 (calm minds eat better)
 *
 * Pure function. Returns adjusted weight map. Each base_weight × multiplier is
 * clamped between 0.6× and 1.4× of the original (hard ceiling).
 */

const BASE = require('../config').SCORE.BASE_WEIGHTS;

const HARD_FLOOR = 0.6;
const HARD_CEIL = 1.4;

function clip(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * @param {Object<string, number>} normalized - per-coach normalized score (0..100), null if unknown
 * @param {Object<string, AgentSnapshot>} snapshots - to detect fasting_active
 * @returns {Object<string, number>} adjusted weights (raw — caller normalizes to sum=1)
 */
function computeAdjustedWeights(normalized, snapshots) {
  const out = { ...BASE };
  const mult = { sleep: 1, mind: 1, nutrition: 1, fitness: 1, water: 1, fasting: 1 };

  const sleep = normalized.sleep;
  const water = normalized.water;
  const mind = normalized.mind;
  const fastingActive = !!(snapshots && snapshots.fasting && snapshots.fasting.today &&
    snapshots.fasting.today.has_log && snapshots.fasting.today.score >= 60);

  if (Number.isFinite(sleep) && sleep < 50) {
    mult.mind *= 1.20;
  }
  if (Number.isFinite(sleep) && sleep > 75) {
    mult.fitness *= 1.10;
  }
  if (Number.isFinite(water) && water < 40) {
    mult.fitness *= 0.90;
  }
  if (fastingActive) {
    mult.nutrition *= 0.85;
  }
  if (Number.isFinite(mind) && mind > 75) {
    mult.nutrition *= 1.05;
  }

  for (const coach of Object.keys(out)) {
    const m = clip(mult[coach], HARD_FLOOR, HARD_CEIL);
    out[coach] = out[coach] * m;
  }

  return out;
}

module.exports = { computeAdjustedWeights, HARD_FLOOR, HARD_CEIL };
