/**
 * warm-start.js
 * Step 8 + 11: Day-1 seed score from onboarding + library blend.
 */

const config = require('../config');
const { lookup } = require('./warm-start-library');
const { AGENTS } = require('../adapters/_shape');

const BASE = config.SCORE.BASE_WEIGHTS;

/**
 * Infer tier (low/mid/high) for a given (agent, onboarding answers).
 * Onboarding answer keys are app-specific; we accept several plausible shapes.
 */
function inferTier(agent, answers) {
  if (!answers || typeof answers !== 'object') return 'mid';

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

  if (agent === 'sleep') {
    const h = num(answers.sleep_hours) || num(answers.avg_sleep_hours) || num(answers.sleep_h);
    if (h === null) return 'mid';
    if (h < 6) return 'low';
    if (h < 7.5) return 'mid';
    return 'high';
  }
  if (agent === 'mind') {
    const stress = num(answers.stress_level);
    const mood = num(answers.mood_self_rating);
    const v = stress != null ? 5 - stress : (mood != null ? mood : null);
    if (v === null) return 'mid';
    if (v < 2.5) return 'low';
    if (v < 4) return 'mid';
    return 'high';
  }
  if (agent === 'nutrition') {
    const meals = num(answers.eats_well_self_rating);
    if (meals === null) return 'mid';
    if (meals < 3) return 'low';
    if (meals < 4) return 'mid';
    return 'high';
  }
  if (agent === 'fitness') {
    const sessions = num(answers.weekly_workouts) || num(answers.workouts_per_week);
    if (sessions === null) return 'mid';
    if (sessions < 1) return 'low';
    if (sessions < 4) return 'mid';
    return 'high';
  }
  if (agent === 'water') {
    const ml = num(answers.daily_water_ml) || (num(answers.daily_water_l) ? num(answers.daily_water_l) * 1000 : null);
    if (ml === null) return 'mid';
    if (ml < 1500) return 'low';
    if (ml < 2200) return 'mid';
    return 'high';
  }
  if (agent === 'fasting') {
    const tried = !!answers.has_fasted_before;
    return tried ? 'high' : 'mid';
  }
  return 'mid';
}

/**
 * Compute the warm-start seed wellness score for a Day-1 user.
 *
 * @param {Object} args
 * @param {string} args.anchor             - 'energy'|'sleep'|...
 * @param {Object} args.onboardingAnswers
 * @param {Object<string, boolean>} args.setup_state
 * @returns {{ score: number, per_agent: Object<string, number> }}
 */
function computeWarmStart({ anchor, onboardingAnswers, setup_state }) {
  const per_agent = {};
  let totalWeight = 0;
  let weightedSum = 0;
  for (const agent of AGENTS) {
    if (!setup_state[agent]) {
      per_agent[agent] = null;
      continue;
    }
    const tier = inferTier(agent, onboardingAnswers || {});
    const seed = lookup(anchor, agent, tier);
    per_agent[agent] = seed;
    const w = BASE[agent];
    weightedSum += seed * w;
    totalWeight += w;
  }
  const score = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 50;
  return { score, per_agent };
}

module.exports = { computeWarmStart, inferTier };
