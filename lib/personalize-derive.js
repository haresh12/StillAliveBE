'use strict';
// ═══════════════════════════════════════════════════════════════
// personalize-derive.js — server-side derive layer.
//
// The unified /api/personalize/save endpoint asks the user only 14
// questions. But the 6 agent engines were built reading ~33 fields
// per coach. This module bridges that gap: every "downgraded" field
// gets a sensible derived value here so engines never read undefined.
//
// MUST stay in sync with StillAlive/src/lib/personalize/localDerive.js
// (client-side mirror used as offline fallback).
// ═══════════════════════════════════════════════════════════════

const BASELINE_BY_LEVEL = {
  beginner:     { bench_press: 30, squat: 50, deadlift: 60 },
  intermediate: { bench_press: 60, squat: 80, deadlift: 100 },
  advanced:     { bench_press: 90, squat: 120, deadlift: 140 },
};

const FULL_TOPIC_SET = [
  'daily_mood', 'sleep_connection', 'work_stress', 'relationships',
  'mindfulness', 'gratitude', 'goal_progress', 'breathing',
  'thought_patterns', 'energy_levels', 'self_compassion', 'boundaries',
];

const ACTIVITY_MULT = { sedentary: 1.2, light: 1.375, moderate: 1.55, very_active: 1.725 };
const CLIMATE_BUMP_ML = { cool: -200, mild: 0, hot: 700, very_hot: 1100 };
const GOAL_MULT = { lose_weight: 0.85, maintain: 1.0, gain_muscle: 1.1, recomp: 0.95 };

function minToHHMM(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function deriveChronotype(wake_min) {
  if (wake_min <= 390) return 'early';
  if (wake_min <= 510) return 'intermediate';
  return 'evening';
}

function deriveExperienceFromProtocol(p) {
  if (p === '12_12' || p === '14_10') return 'beginner';
  if (p === '16_8') return 'intermediate';
  return 'advanced';
}

function deriveSplitFromLevel(l) {
  if (l === 'beginner') return 'fullbody';
  return 'PPL';
}

function deriveClimateFromLocale(localeCountry) {
  const hot = ['ae', 'sg', 'in', 'my', 'th', 'id', 'sa', 'eg', 'mx', 'br', 'au'];
  const cool = ['no', 'se', 'fi', 'is', 'dk', 'ca', 'ru'];
  const cc = (localeCountry || '').toLowerCase();
  if (hot.includes(cc)) return 'hot';
  if (cool.includes(cc)) return 'cool';
  return 'mild';
}

function mapTriggerToChallenge(trigger) {
  const map = {
    work_deadlines: 'stress',
    difficult_convos: 'emotional_regulation',
    poor_sleep: 'fatigue',
    skipped_meals: 'fatigue',
    social: 'anxiety',
    money: 'anxiety',
    health: 'anxiety',
    isolation: 'low_mood',
    social_media: 'focus',
    news: 'anxiety',
    overcommit: 'stress',
    uncertainty: 'anxiety',
  };
  return map[trigger] || 'stress';
}

function computeWaterTarget({ weight_kg, activity, climate, pregnancy, sex }) {
  let ml = (weight_kg || 70) * 35;
  ml *= (ACTIVITY_MULT[activity] || 1.4) / 1.4;
  ml += CLIMATE_BUMP_ML[climate] || 0;
  if (pregnancy) ml += 500;
  return Math.round(ml / 50) * 50;
}

// Onboarding sends age as a STRING age-group ("25-34"). Resolve to midpoint
// integer here so the BMR math never produces NaN. Belt-and-suspenders: FE
// already converts before sending, but BE must not trust client input.
const AGE_GROUP_MIDPOINT = {
  '18-24': 21, '25-34': 30, '35-44': 40, '45-54': 50, '55-64': 60, '65+': 68,
};
function resolveAge(age) {
  if (typeof age === 'number' && Number.isFinite(age)) return age;
  if (typeof age === 'string') {
    if (AGE_GROUP_MIDPOINT[age] != null) return AGE_GROUP_MIDPOINT[age];
    const parsed = parseInt(age, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 30;   // sensible default for adults
}

function computeCalories({ weight_kg, height_cm, activity, goal, sex, age }) {
  const w = Number(weight_kg) || 70;
  const h = Number(height_cm) || 170;
  const a = resolveAge(age);
  const sexAdj = sex === 'female' ? -161 : 5;
  const bmr = (10 * w) + (6.25 * h) - (5 * a) + sexAdj;
  const tdee = bmr * (ACTIVITY_MULT[activity] || 1.55);
  const target = tdee * (GOAL_MULT[goal] || 1.0);
  return Math.round(target / 10) * 10;
}

function computeEatingWindow(wake_min, bed_min, protocol) {
  const fastHours = parseInt(String(protocol).split('_')[0], 10) || 14;
  const eatEnd = (bed_min - 120 + 1440) % 1440;
  const start = (eatEnd - (24 - fastHours) * 60 + 1440) % 1440;
  return `${minToHHMM(start)}-${minToHHMM(eatEnd)}`;
}

// ─── Master derive: returns per-coach derived values ───────────
function derive(payload) {
  const { shared = {}, sleep = {}, mind = {}, nutrition = {}, fitness = {}, fasting = {}, profile = {}, locale } = payload;
  const wake = Number.isFinite(shared.wake_time_min) ? shared.wake_time_min : 420;
  const bed  = Number.isFinite(shared.bed_time_min)  ? shared.bed_time_min  : 1380;
  const sex  = profile.gender;

  const out = {};

  out.sleep = {
    chronotype:          deriveChronotype(wake),
    daily_reminder_time: minToHHMM(wake + 30),
    past_attempts:       [],
    primary_problem:     (sleep.disruptors && sleep.disruptors[0]) || 'stress',
  };

  out.mind = {
    daily_reflection_time: minToHHMM(bed - 60),
    primary_challenge:     mapTriggerToChallenge((mind.triggers || [])[0]),
    current_rating:        5,
    worst_time:            '',
    past_attempts:         [],
    social_context:        '',
    goals:                 [],
    discussion_topics:     FULL_TOPIC_SET,
  };

  const climate = deriveClimateFromLocale(locale && locale.country);
  const water_target_ml = computeWaterTarget({
    weight_kg: shared.weight_kg,
    activity:  shared.activity_level,
    climate,
    pregnancy: shared.pregnancy,
    sex,
  });
  out.water = {
    climate,
    goals:        ['health'],
    reminders:    ['smart'],
    daily_goal_ml: water_target_ml,
    wake_time:    minToHHMM(wake),
    bed_time:     minToHHMM(bed),
  };

  const calorie_target = computeCalories({
    weight_kg: shared.weight_kg,
    height_cm: shared.height_cm,
    activity:  shared.activity_level,
    goal:      nutrition.goal,
    sex,
    age:       profile.age,
  });
  out.nutrition = { calorie_target, eating_pattern: '3_meals' };

  const level = fitness.training_level || 'beginner';
  out.fitness = {
    preferred_split: deriveSplitFromLevel(level),
    gym_time:        minToHHMM(wake + 120),
    reminder_time:   minToHHMM(wake + 120),
    baseline_lifts:  BASELINE_BY_LEVEL[level] || BASELINE_BY_LEVEL.beginner,
    supplements:     [],
    injury_notes:    '',
  };

  const protocol = fasting.protocol || '14_10';
  out.fasting = {
    experience_level: deriveExperienceFromProtocol(protocol),
    caffeine_habit:   'moderate',
    medical:          [],
    fasting_window:   computeEatingWindow(wake, bed, protocol),
    schedule_type:    'auto',
  };

  return out;
}

// Home wellness-score on Day-1 (no logs yet) = setup_count × 2 per
// wellness-cross-v2/score/wellness-score.js. We MUST match that exactly,
// otherwise the reveal lies and the user loses trust on first Home visit.
//   6 coaches → 12 · 4 → 8 · 2 → 4
// Logs build the rest toward 100.
function computeWellnessScoreBaseline(payload) {
  const n = (payload.active_coaches || []).length;
  return n * 2;
}

function generateInsights(payload, derived) {
  const out = [];
  const coaches = payload.active_coaches || [];

  if (coaches.includes('sleep') && (payload.sleep?.disruptors || []).length) {
    out.push({
      coach: 'sleep',
      i18n_key: 'personalize.insight.sleep.disruptor',
      vars: { target: payload.sleep.target_hours, top_disruptor: payload.sleep.disruptors[0] },
    });
  }
  if (coaches.includes('water')) {
    out.push({
      coach: 'water',
      i18n_key: 'personalize.insight.water.target',
      vars: { target_ml: derived.water.daily_goal_ml, weight_kg: payload.shared.weight_kg },
    });
  }
  if (coaches.includes('mind') && (payload.mind?.triggers || []).length) {
    out.push({
      coach: 'mind',
      i18n_key: 'personalize.insight.mind.trigger',
      vars: { primary_trigger: payload.mind.triggers[0] },
    });
  }
  if (coaches.includes('nutrition')) {
    out.push({
      coach: 'nutrition',
      i18n_key: 'personalize.insight.nutrition.calories',
      vars: { calories: derived.nutrition.calorie_target, goal: payload.nutrition.goal },
    });
  }
  if (coaches.includes('fitness')) {
    out.push({
      coach: 'fitness',
      i18n_key: 'personalize.insight.fitness.split',
      vars: { split: derived.fitness.preferred_split, days: (payload.fitness.training_days || []).length },
    });
  }
  if (coaches.includes('fasting')) {
    out.push({
      coach: 'fasting',
      i18n_key: 'personalize.insight.fasting.window',
      vars: { window: derived.fasting.fasting_window, protocol: payload.fasting.protocol },
    });
  }

  return out.slice(0, 3);
}

module.exports = {
  derive,
  computeWellnessScoreBaseline,
  generateInsights,
  minToHHMM,
  deriveChronotype,
  deriveExperienceFromProtocol,
  deriveSplitFromLevel,
  deriveClimateFromLocale,
  mapTriggerToChallenge,
  computeWaterTarget,
  computeCalories,
  computeEatingWindow,
  BASELINE_BY_LEVEL,
  FULL_TOPIC_SET,
};
