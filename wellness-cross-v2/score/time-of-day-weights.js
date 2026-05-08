/**
 * time-of-day-weights.js
 * 4-bucket weighting that compensates for "haven't logged this yet" bias.
 *
 * Buckets (local hour):
 *   morning  (5-11)  : sleep up, water/fitness/nutrition down (haven't logged yet)
 *   midday   (11-17) : nutrition + water peak
 *   evening  (17-22) : balanced
 *   night    (22-5)  : yesterday-pattern carries forward (use yesterday's weights)
 *
 * Returns multiplier map. Caller applies to base or interaction-adjusted weights.
 */

const BUCKET_RULES = {
  morning: {
    sleep: 1.15,
    mind: 1.05,
    water: 0.85,
    nutrition: 0.85,
    fitness: 0.85,
    fasting: 1.0,
  },
  midday: {
    sleep: 1.0,
    mind: 1.0,
    water: 1.10,
    nutrition: 1.10,
    fitness: 1.0,
    fasting: 1.0,
  },
  evening: {
    sleep: 1.0,
    mind: 1.0,
    water: 1.0,
    nutrition: 1.0,
    fitness: 1.0,
    fasting: 1.0,
  },
  night: {
    sleep: 1.0,
    mind: 1.0,
    water: 1.0,
    nutrition: 1.0,
    fitness: 1.0,
    fasting: 1.0,
  },
};

function bucketFor(hour) {
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 17) return 'midday';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

function applyTimeOfDay(weights, hour) {
  const bucket = bucketFor(hour);
  const rules = BUCKET_RULES[bucket];
  const out = {};
  for (const coach of Object.keys(weights)) {
    out[coach] = weights[coach] * (rules[coach] || 1);
  }
  return { weights: out, bucket };
}

module.exports = { applyTimeOfDay, bucketFor, BUCKET_RULES };
