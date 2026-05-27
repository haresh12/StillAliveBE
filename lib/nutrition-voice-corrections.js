'use strict';
// ════════════════════════════════════════════════════════════════════
// nutrition-voice-corrections.js — BE mirror of
// StillAlive/src/screens/wellness/nutrition/NutritionVoiceLexicon.js
//
// Purpose: keep transcripts that hit /describe via server-side paths
// (audio upload through `audio_base64`, Siri intent, future Deepgram
// streaming) corrected to the same canonical food vocabulary the FE
// pre-corrects. Closes the gap where Siri-spoken "tee bee spoon" or
// "chick filet" would otherwise be passed to the parser raw.
//
// DETERMINISTIC + PURE — no Firestore, no network, no clock.
// Test with: node tests/nutrition-voice-corrections.test.js (TBD).
//
// IMPORTANT: this list MUST match
// StillAlive/src/screens/wellness/nutrition/NutritionVoiceLexicon.js
// CORRECTIONS array exactly. If you edit one, edit both.
// ════════════════════════════════════════════════════════════════════

const CORRECTIONS = [
  // Units / portions
  ['kal',          'kcal'],
  ['k cal',        'kcal'],
  ['calorie\\.',   'calories.'],
  ['gram',         'grams'],
  ['graham',       'gram'],
  ['tee bee spoon', 'tablespoon'],
  ['tee spoon',    'teaspoon'],
  ['tbs spoon',    'tablespoon'],
  ['tee bee s p',  'tbsp'],
  ['t s p',        'tsp'],
  ['milli litres', 'ml'],
  ['mil grams',    'mg'],
  ['ounce\\.',     'oz.'],
  ['fluid ounce',  'fl oz'],
  // Macros
  ['Macron',       'macro'],
  ['macron s',     'macros'],
  ['carve',        'carb'],
  ['carbs y',      'carbs'],
  ['proteen',      'protein'],
  ['fibre',        'fiber'],
  ['sat fats',     'saturated fat'],
  ['poly fats',    'polyunsaturated fat'],
  ['mono fats',    'monounsaturated fat'],
  // Foods
  ['greek yo got', 'Greek yogurt'],
  ['greek you got', 'Greek yogurt'],
  ['greek your got', 'Greek yogurt'],
  ['quin wa',      'quinoa'],
  ['keen wa',      'quinoa'],
  ['cosh you',     'cashew'],
  ['cou cous',     'couscous'],
  ['edam may',     'edamame'],
  ['so bay',       'soba'],
  ['nutri grain',  'Nutri-Grain'],
  ['mac n cheese', 'mac and cheese'],
  // Restaurants
  ['chick filet',     'Chick-fil-A'],
  ['chick fila',      'Chick-fil-A'],
  ['chick file',      'Chick-fil-A'],
  ['shake shock',     'Shake Shack'],
  ['five guy',        'Five Guys'],
  ['chipote lay',     'Chipotle'],
  ['chee pot lay',    'Chipotle'],
  ['starbuck s',      'Starbucks'],
  ['mc donald',       "McDonald's"],
  ['mc donalds',      "McDonald's"],
  // Drinks
  ['e spresso',    'espresso'],
  ['camp pa china', 'cappuccino'],
  ['cap o chino',  'cappuccino'],
  ['lat tay',      'latte'],
  ['kombu cha',    'kombucha'],
];

const COMPILED = CORRECTIONS.map(([pat, repl]) => ({
  re:  new RegExp(`\\b${pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'),
  repl,
}));

/**
 * Apply all corrections in order. Idempotent.
 * @param {string} raw transcript
 * @returns {string} corrected, or raw on null/empty input
 */
function applyNutritionCorrections(raw) {
  if (!raw || typeof raw !== 'string') return raw || '';
  let s = raw;
  for (const { re, repl } of COMPILED) {
    s = s.replace(re, repl);
  }
  return s.replace(/\s{2,}/g, ' ').trim();
}

module.exports = { applyNutritionCorrections };
