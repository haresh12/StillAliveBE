/**
 * plain-english-translator.js
 * Deterministic plain-English headline for a correlation.
 * (LLM upgrade is layered later inside the orchestrator if needed; this fallback ships always.)
 */

const VERBS = {
  sleep_mind:      ['Better sleep', 'sharper mood'],
  mind_sleep:      ['Calmer days', 'better sleep'],
  sleep_fitness:   ['Solid sleep', 'stronger workouts'],
  fitness_sleep:   ['Workout days', 'deeper sleep'],
  sleep_water:     ['Solid sleep', 'better hydration habits'],
  water_sleep:     ['Hydrated days', 'better sleep'],
  sleep_nutrition: ['Solid sleep', 'cleaner eating'],
  nutrition_sleep: ['Cleaner eating', 'better sleep'],
  sleep_fasting:   ['Solid sleep', 'longer fasts'],
  fasting_sleep:   ['Longer fasts', 'better sleep'],
  mind_fitness:    ['Calmer mind', 'stronger workouts'],
  fitness_mind:    ['Workout days', 'sharper mood'],
  mind_water:      ['Calmer mind', 'better hydration'],
  water_mind:      ['Hydrated days', 'sharper mood'],
  mind_nutrition:  ['Calmer mind', 'cleaner eating'],
  nutrition_mind:  ['Cleaner eating', 'sharper mood'],
  mind_fasting:    ['Calmer mind', 'longer fasts'],
  fasting_mind:    ['Longer fasts', 'sharper mood'],
  fitness_water:   ['Workout days', 'better hydration'],
  water_fitness:   ['Hydrated days', 'stronger workouts'],
  fitness_nutrition: ['Workout days', 'cleaner eating'],
  nutrition_fitness: ['Cleaner eating', 'stronger workouts'],
  fitness_fasting: ['Workout days', 'longer fasts'],
  fasting_fitness: ['Longer fasts', 'stronger workouts'],
  nutrition_water: ['Cleaner eating', 'better hydration'],
  water_nutrition: ['Hydrated days', 'cleaner eating'],
  nutrition_fasting: ['Cleaner eating', 'longer fasts'],
  fasting_nutrition: ['Longer fasts', 'cleaner eating'],
  water_fasting:   ['Hydrated days', 'longer fasts'],
  fasting_water:   ['Longer fasts', 'better hydration'],
};

function lagSuffix(lag) {
  if (lag === -1) return ' (next day)';
  if (lag === 1) return ' (next day)';
  return '';
}

function translate(corr) {
  const [a, b] = corr.agents;
  const key = corr.r >= 0 ? `${a}_${b}` : `${a}_${b}`;
  const phrase = VERBS[key];
  if (!phrase) return `${a} and ${b} appear linked (n=${corr.n})`;
  const arrow = corr.direction === 'positive' ? '→' : '↔';
  return `${phrase[0]} ${arrow} ${phrase[1]}${lagSuffix(corr.lag)}`;
}

module.exports = { translate };
