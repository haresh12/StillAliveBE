/**
 * personal-baseline.js
 * Steps 2-4 of the algorithm: z-score with tanh sigmoid + cold-start + skipped-day decay.
 */

const config = require('../config');

const FLOOR = config.SCORE.SCORE_FLOOR;
const CEIL = config.SCORE.SCORE_CEIL;
const NEUTRAL = config.SCORE.BASELINE_NEUTRAL;
const SKIP_HALF_LIFE = config.SCORE.SKIP_DECAY_HALF_LIFE_DAYS;

function clip(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Step 2: z-score with tanh sigmoid
 *   z = (today - mean) / std
 *   normalized = clip(50 + 25*tanh(z), 5, 95)
 */
function normalizeFromBaseline(todayScore, baseline) {
  if (!Number.isFinite(todayScore)) return null;
  if (!baseline || !Number.isFinite(baseline.mean) || !Number.isFinite(baseline.std)) {
    return clip(Math.round(todayScore), FLOOR, CEIL); // step 3 cold-start
  }
  const z = (todayScore - baseline.mean) / baseline.std;
  const raw = NEUTRAL + 25 * Math.tanh(z);
  return Math.round(clip(raw, FLOOR, CEIL));
}

/**
 * Step 4: skipped-day decay toward neutral.
 * If user did not log today, blend last available normalized score toward 50.
 *
 * @param {DailyPoint[]} last14d - oldest→newest, length 14
 * @param {number|null} todayNormalized - the just-computed normalized today (null if no log)
 * @returns {number|null}
 */
function applySkipDecay(last14d, todayNormalized) {
  if (Number.isFinite(todayNormalized)) return todayNormalized;
  // find most recent has_log
  let lastIdx = -1;
  for (let i = last14d.length - 1; i >= 0; i--) {
    if (last14d[i].has_log && Number.isFinite(last14d[i].score)) {
      lastIdx = i;
      break;
    }
  }
  if (lastIdx < 0) return null;
  const daysSince = last14d.length - 1 - lastIdx;
  const decay = Math.exp(-daysSince / SKIP_HALF_LIFE);
  const prev = last14d[lastIdx].score;
  return Math.round(NEUTRAL + (prev - NEUTRAL) * decay);
}

module.exports = { normalizeFromBaseline, applySkipDecay, clip };
