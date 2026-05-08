/**
 * library.js
 * Curated science-backed facts (citations included).
 * Used as fallback when personal facts < 4.
 */

const LIBRARY = [
  { eyebrow: 'SLEEP × MOOD', body: 'Under 6 hours of sleep doubles next-day anxiety risk.', source: 'Walker, Why We Sleep' },
  { eyebrow: 'SLEEP', body: 'Most adults need 7-9 hours. Below 6h, cognitive performance drops measurably within 2 days.', source: 'Belenky 2003, J Sleep Res' },
  { eyebrow: 'NUTRITION', body: 'Protein in the first hour after waking improves satiety for 9 hours.', source: 'Leidy 2013, Am J Clin Nutr' },
  { eyebrow: 'NUTRITION', body: 'Fiber > 25g/day correlates with 12% lower all-cause mortality.', source: 'Reynolds 2019, Lancet' },
  { eyebrow: 'WATER', body: '1% dehydration drops mood and short-term memory within an hour.', source: 'Pross 2017, Front Hum Neurosci' },
  { eyebrow: 'WATER', body: 'Most "hunger" between meals is dehydration. Drink first, then reassess.', source: 'McKiernan 2009, Physiol Behav' },
  { eyebrow: 'FITNESS', body: 'A single 20-min walk lifts mood for 12 hours.', source: 'Harvard Med 2024' },
  { eyebrow: 'FITNESS', body: 'Strength training 2x/week reduces all-cause mortality by ~17%.', source: 'Saeidifard 2019, BJSM' },
  { eyebrow: 'MIND', body: 'Naming an emotion reduces its intensity by ~50%.', source: 'Lieberman 2007, Psych Sci' },
  { eyebrow: 'MIND', body: '5 minutes of deep breathing drops cortisol by ~15%.', source: 'Ma 2017, Front Psychol' },
  { eyebrow: 'FASTING', body: 'Most autophagy benefits begin around 14h fasting — not 16.', source: 'Mizushima 2008, Nature' },
  { eyebrow: 'FASTING', body: 'Time-restricted eating (≥12h) improves insulin sensitivity within 2 weeks.', source: 'Sutton 2018, Cell Metab' },
  { eyebrow: 'COGNITION', body: 'Caffeine after 2pm reduces deep sleep by 24% even if you fall asleep fine.', source: 'Drake 2013, J Clin Sleep Med' },
  { eyebrow: 'RECOVERY', body: 'Sunlight in the first hour of waking sets your circadian rhythm for the day.', source: 'Wams 2017, Sleep' },
];

function shuffleByDay(arr) {
  const seed = new Date().getDate();
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = (seed * (i + 1)) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function getLibraryFacts(count = 4) {
  return shuffleByDay(LIBRARY).slice(0, count);
}

module.exports = { getLibraryFacts, LIBRARY };
