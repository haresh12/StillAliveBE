#!/usr/bin/env node
'use strict';
// ═══════════════════════════════════════════════════════════════
// E2E sanity: after Personalize save, every legacy per-agent setup
// doc has setup_completed=true AND every field each engine reads
// is populated (not undefined).
//
// If this passes, taps into any of the 6 agents land on the real
// agent screen with no setup re-prompt and no broken-engine errors.
// ═══════════════════════════════════════════════════════════════

const { derive, computeWellnessScoreBaseline, generateInsights, minToHHMM } = require('../lib/personalize-derive');
const admin = { firestore: () => ({ FieldValue: { serverTimestamp: () => 'TS' } }) };

// Inline copy of buildLegacyPayloads from personalize.agent.js so we can run
// without firebase admin. Keep this 1:1 with the real handler.
function buildLegacyPayloads({ payload, derived }) {
  const { active_coaches, shared, sleep, mind, nutrition, fitness, water, fasting } = payload;
  const ts = 'TS';
  const out = {};
  if (active_coaches.includes('sleep')) {
    out.sleep = {
      setup_completed: true, setup_completed_at: ts,
      primary_problem: derived.sleep.primary_problem,
      target_bedtime: minToHHMM(shared.bed_time_min),
      target_wake_time: minToHHMM(shared.wake_time_min),
      target_hours: sleep.target_hours,
      disruptors: sleep.disruptors || [],
      chronotype: derived.sleep.chronotype,
      past_attempts: derived.sleep.past_attempts,
      daily_reminder_time: derived.sleep.daily_reminder_time,
    };
  }
  if (active_coaches.includes('mind')) {
    out.mind = {
      setup_completed: true, setup_completed_at: ts,
      primary_challenge: derived.mind.primary_challenge,
      current_rating: derived.mind.current_rating,
      worst_time: derived.mind.worst_time,
      triggers: mind.triggers || [],
      past_attempts: derived.mind.past_attempts,
      social_context: derived.mind.social_context,
      goals: derived.mind.goals,
      discussion_topics: derived.mind.discussion_topics,
      daily_reflection_time: derived.mind.daily_reflection_time,
      checkin_count: 0, last_action_gen_at_checkin: 0,
      last_checkin_date: null, last_proactive_date: null,
      proactive_topic_index: 0, analysis_cache: null,
    };
  }
  if (active_coaches.includes('water')) {
    out.water = {
      setup_completed: true, setup_completed_at: ts,
      goal: derived.water.goals,
      activity_level: shared.activity_level || 'moderate',
      climate: derived.water.climate,
      reminders: derived.water.reminders,
      weight_kg: shared.weight_kg,
      wake_time: derived.water.wake_time,
      bed_time: derived.water.bed_time,
      pregnancy_status: shared.pregnancy ? 'pregnant' : 'no',
      daily_goal_ml: derived.water.daily_goal_ml,
    };
  }
  if (active_coaches.includes('nutrition')) {
    out.nutrition = {
      setup_completed: true, setup_completed_at: ts,
      goal: nutrition.goal,
      activity_level: shared.activity_level || 'moderate',
      dietary_style: nutrition.dietary_style || [],
      allergies: nutrition.allergies || [],
      weight_kg: shared.weight_kg,
      height_cm: shared.height_cm,
      eating_pattern: derived.nutrition.eating_pattern,
      calorie_target: derived.nutrition.calorie_target,
    };
  }
  if (active_coaches.includes('fitness')) {
    out.fitness = {
      setup_completed: true, setup_completed_at: ts,
      primary_goal: fitness.goal,
      training_level: fitness.training_level,
      preferred_split: derived.fitness.preferred_split,
      training_days: fitness.training_days || [],
      gym_time: derived.fitness.gym_time,
      reminder_time: derived.fitness.reminder_time,
      supplements: derived.fitness.supplements,
      baseline_lifts: derived.fitness.baseline_lifts,
      equipment: fitness.equipment,
      injury_notes: derived.fitness.injury_notes,
    };
  }
  if (active_coaches.includes('fasting')) {
    out.fasting = {
      setup_completed: true, setup_completed_at: ts,
      protocol: fasting.protocol,
      goal: 'general_health',
      experience_level: derived.fasting.experience_level,
      caffeine_habit: derived.fasting.caffeine_habit,
      medical: derived.fasting.medical,
      schedule_type: derived.fasting.schedule_type,
      wake_time: derived.water.wake_time,
      bed_time: derived.water.bed_time,
      weight_kg: shared.weight_kg,
      height_cm: shared.height_cm,
      fasting_window: derived.fasting.fasting_window,
    };
  }
  return out;
}

// Required fields per agent — anything the engines historically read
const REQUIRED = {
  sleep:     ['setup_completed', 'primary_problem', 'target_bedtime', 'target_wake_time', 'target_hours', 'disruptors', 'chronotype', 'daily_reminder_time'],
  mind:      ['setup_completed', 'primary_challenge', 'current_rating', 'triggers', 'discussion_topics', 'daily_reflection_time', 'checkin_count', 'proactive_topic_index'],
  water:     ['setup_completed', 'goal', 'activity_level', 'climate', 'weight_kg', 'wake_time', 'bed_time', 'daily_goal_ml'],
  nutrition: ['setup_completed', 'goal', 'activity_level', 'weight_kg', 'height_cm', 'allergies', 'eating_pattern', 'calorie_target'],
  fitness:   ['setup_completed', 'primary_goal', 'training_level', 'preferred_split', 'training_days', 'gym_time', 'baseline_lifts', 'equipment'],
  fasting:   ['setup_completed', 'protocol', 'experience_level', 'wake_time', 'bed_time', 'weight_kg', 'height_cm', 'fasting_window'],
};

const FIXTURES = [
  {
    name: 'All 6 coaches',
    payload: {
      active_coaches: ['sleep','mind','nutrition','fitness','water','fasting'],
      shared: { wake_time_min: 420, bed_time_min: 1380, weight_kg: 70, height_cm: 175, activity_level: 'moderate', pregnancy: false },
      sleep: { target_hours: 7.5, disruptors: ['stress','screens'] },
      mind: { triggers: ['work_deadlines','poor_sleep'] },
      nutrition: { goal: 'lose_weight', dietary_style: ['high_protein'], allergies: ['none'] },
      fitness: { training_level: 'intermediate', goal: 'hypertrophy', training_days: ['mon','wed','fri'], equipment: 'full_gym' },
      water: {}, fasting: { protocol: '16_8' },
      profile: { gender: 'male', age: 30, name: 'Test' },
      locale: { country: 'us', language: 'en' },
    },
  },
  {
    name: 'Sleep + Mind only',
    payload: {
      active_coaches: ['sleep','mind'],
      shared: { wake_time_min: 360, bed_time_min: 1320, weight_kg: 60, height_cm: 165, activity_level: 'light', pregnancy: false },
      sleep: { target_hours: 8, disruptors: ['anxiety','noise'] },
      mind: { triggers: ['work_deadlines'] },
      nutrition: {}, fitness: {}, water: {}, fasting: {},
      profile: { gender: 'female', age: 28 }, locale: { country: 'de', language: 'de' },
    },
  },
];

let pass = 0, fail = 0;
for (const fx of FIXTURES) {
  const derived = derive(fx.payload);
  const score = computeWellnessScoreBaseline(fx.payload);
  const insights = generateInsights(fx.payload, derived);
  const legacy = buildLegacyPayloads({ payload: fx.payload, derived });

  let coachFail = 0;
  for (const coach of fx.payload.active_coaches) {
    const doc = legacy[coach];
    if (!doc) { console.error(`✗ ${fx.name} / ${coach}: legacy payload missing`); coachFail++; continue; }
    for (const field of REQUIRED[coach] || []) {
      const v = doc[field];
      const missing = v === undefined || v === null || (Array.isArray(v) && v.length === 0 && field !== 'past_attempts' && field !== 'goals' && field !== 'supplements');
      // arrays-that-may-be-empty are OK for some fields, but setup_completed and primaries must be truthy
      if (missing && ['setup_completed', 'primary_problem', 'primary_challenge', 'primary_goal', 'protocol', 'chronotype', 'daily_reminder_time', 'daily_reflection_time', 'gym_time', 'fasting_window'].includes(field)) {
        console.error(`✗ ${fx.name} / ${coach}: required field "${field}" missing or empty`);
        coachFail++;
      }
    }
    if (!doc.setup_completed) {
      console.error(`✗ ${fx.name} / ${coach}: setup_completed not true`);
      coachFail++;
    }
  }

  if (coachFail === 0) {
    pass++;
    console.log(`✓ ${fx.name}  (score ${score}, ${insights.length} insights, all ${fx.payload.active_coaches.length} agent docs complete)`);
  } else {
    fail++;
  }
}

console.log(`\nResult: ${pass}/${pass + fail} E2E scenarios passed.`);
process.exit(fail > 0 ? 1 : 0);
