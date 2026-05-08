/**
 * warm-start-library.js
 * Hand-tuned 5 anchors × 6 agents × 3 tiers = 90 seed scores.
 * Each value is a starting point in 0..100 for a Day-1 user
 * who declared `anchor` and answered onboarding such that we infer `tier`.
 *
 * Tier inference happens in warm-start.js based on onboarding answers.
 */

const ANCHORS = ['energy', 'sleep', 'mood', 'weight', 'fitness', 'none'];
const TIERS = ['low', 'mid', 'high'];

const SEEDS = {
  // anchor → agent → tier → seed
  energy: {
    sleep:     { low: 35, mid: 55, high: 70 },
    mind:      { low: 45, mid: 60, high: 70 },
    nutrition: { low: 40, mid: 55, high: 65 },
    fitness:   { low: 35, mid: 55, high: 70 },
    water:     { low: 40, mid: 55, high: 65 },
    fasting:   { low: 50, mid: 60, high: 70 },
  },
  sleep: {
    sleep:     { low: 30, mid: 50, high: 70 },
    mind:      { low: 45, mid: 55, high: 65 },
    nutrition: { low: 45, mid: 55, high: 60 },
    fitness:   { low: 45, mid: 55, high: 60 },
    water:     { low: 50, mid: 55, high: 60 },
    fasting:   { low: 50, mid: 55, high: 60 },
  },
  mood: {
    sleep:     { low: 40, mid: 55, high: 65 },
    mind:      { low: 30, mid: 50, high: 70 },
    nutrition: { low: 45, mid: 55, high: 60 },
    fitness:   { low: 40, mid: 55, high: 65 },
    water:     { low: 50, mid: 55, high: 60 },
    fasting:   { low: 50, mid: 55, high: 60 },
  },
  weight: {
    sleep:     { low: 45, mid: 55, high: 60 },
    mind:      { low: 50, mid: 55, high: 60 },
    nutrition: { low: 35, mid: 55, high: 70 },
    fitness:   { low: 35, mid: 55, high: 70 },
    water:     { low: 45, mid: 55, high: 65 },
    fasting:   { low: 40, mid: 60, high: 70 },
  },
  fitness: {
    sleep:     { low: 45, mid: 55, high: 65 },
    mind:      { low: 50, mid: 55, high: 65 },
    nutrition: { low: 45, mid: 55, high: 65 },
    fitness:   { low: 30, mid: 55, high: 75 },
    water:     { low: 45, mid: 55, high: 65 },
    fasting:   { low: 50, mid: 55, high: 60 },
  },
  none: {
    sleep:     { low: 50, mid: 50, high: 50 },
    mind:      { low: 50, mid: 50, high: 50 },
    nutrition: { low: 50, mid: 50, high: 50 },
    fitness:   { low: 50, mid: 50, high: 50 },
    water:     { low: 50, mid: 50, high: 50 },
    fasting:   { low: 50, mid: 50, high: 50 },
  },
};

function lookup(anchor, agent, tier) {
  const a = ANCHORS.includes(anchor) ? anchor : 'none';
  const t = TIERS.includes(tier) ? tier : 'mid';
  return SEEDS[a][agent][t];
}

module.exports = { SEEDS, ANCHORS, TIERS, lookup };
