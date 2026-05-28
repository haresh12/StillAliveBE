'use strict';
// ════════════════════════════════════════════════════════════════════════
// goal-plans/userContext.js — rich user-context loader for prompts.
//
// v4 (2026-05-28): now reads the personalize_v1 doc on top of the user
// doc, so the LLM has the user's stats (weight/height/age/gender), their
// rhythm (wake/bed/chronotype), and per-coach setup (equipment, training
// level, disruptors, triggers, dietary style, allergies, fasting protocol,
// targets). The point: ask SHARPER questions, never re-ask anything the
// user already told us during onboarding.
//
// What this reads (sandbox-safe — only user-owned docs, never any
// per-agent subcollection's logs/state):
//   • wellness_users/{deviceId}                              ← profile + flags
//   • wellness_users/{deviceId}/personalize/v1               ← rich shared + per-coach inputs
//   • wellness_users/{deviceId}/wellness_meta/cold_start_anchor  ← anchor
// ════════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
const log = require('../log');

function db() { return admin.firestore(); }

const SUPPORTED_COACHES = ['fitness', 'nutrition', 'mind', 'sleep', 'water', 'fasting'];

function safe(promise, fallback) {
  return promise.then((v) => v).catch(() => fallback);
}

function minToHHMM(min) {
  if (!Number.isFinite(min)) return null;
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Loads a rich user-context bundle for the goal-plans prompts.
 * Always returns an object — never throws — so callers can spread it
 * unconditionally into the prompt builder. Missing fields are null /
 * empty arrays so render functions can guard simply.
 *
 * Returned shape (every field optional, may be null/empty):
 *   {
 *     // Profile
 *     name, gender, age_group, locale,
 *     // Stats
 *     weight_kg, height_cm, units,
 *     activity_level, pregnancy,
 *     // Rhythm
 *     wake_time, bed_time, chronotype,
 *     // Coverage
 *     active_coaches[], primary_coach, primary_goal,
 *     days_since_join, cold_start_anchor,
 *     // Per-coach (only present if active)
 *     sleep:     { target_hours, disruptors[], chronotype, ... }
 *     mind:      { triggers[], primary_challenge, goals[] }
 *     nutrition: { goal, dietary_style[], allergies[], calorie_target }
 *     fitness:   { goal, training_level, equipment[], training_days[], injury_notes }
 *     water:     { daily_goal_ml, climate, activity_level }
 *     fasting:   { protocol, experience_level, fasting_window }
 *   }
 */
async function loadUserContext(deviceId, locale = 'en') {
  const empty = {
    name: null, gender: null, age_group: null, locale,
    weight_kg: null, height_cm: null, units: null,
    activity_level: null, pregnancy: null,
    wake_time: null, bed_time: null, chronotype: null,
    active_coaches: [], primary_coach: null, primary_goal: null,
    days_since_join: null, cold_start_anchor: null,
    sleep: null, mind: null, nutrition: null, fitness: null, water: null, fasting: null,
  };
  if (!deviceId) return empty;

  try {
    const userRef = db().collection('wellness_users').doc(deviceId);
    const [userSnap, anchorSnap, personalizeSnap] = await Promise.all([
      safe(userRef.get(), null),
      safe(userRef.collection('wellness_meta').doc('cold_start_anchor').get(), null),
      safe(userRef.collection('personalize').doc('v1').get(), null),
    ]);
    const p = userSnap?.exists ? userSnap.data() : {};
    const pz = personalizeSnap?.exists ? personalizeSnap.data() : {};
    const shared = pz.shared || {};
    const ui = pz.user_input || {};
    const derived = pz.derived || {};

    const activeRaw = Array.isArray(p.active_coaches) ? p.active_coaches
      : (Array.isArray(pz.active_coaches) ? pz.active_coaches : []);
    const active_coaches = activeRaw.filter((c) => SUPPORTED_COACHES.includes(c));

    const joinedMs =
      (p.created_at && typeof p.created_at.toMillis === 'function') ? p.created_at.toMillis()
      : (typeof p.created_at_ms === 'number') ? p.created_at_ms
      : (p.created_at instanceof Date) ? p.created_at.getTime()
      : null;
    const days_since_join = joinedMs ? Math.max(0, Math.floor((Date.now() - joinedMs) / 86400000)) : null;

    // Per-coach blocks — keep them compact, only what an LLM needs to ask
    // sharper questions (not the whole per-agent record).
    const out = {
      name:              p.name || null,
      gender:            p.gender || shared.gender || null,
      age_group:         p.ageGroup || p.age_group || null,
      locale,
      weight_kg:         shared.weight_kg || null,
      height_cm:         shared.height_cm || null,
      units:             shared.units || p.units || null,
      activity_level:    shared.activity_level || null,
      pregnancy:         !!shared.pregnancy,
      wake_time:         minToHHMM(shared.wake_time_min),
      bed_time:          minToHHMM(shared.bed_time_min),
      chronotype:        derived.sleep?.chronotype || null,
      active_coaches,
      primary_coach:     p.primaryCoach || p.primary_coach || null,
      primary_goal:      p.primaryGoal || p.primary_goal || null,
      days_since_join,
      cold_start_anchor: anchorSnap?.exists ? (anchorSnap.data().value || null) : null,
      sleep:     null, mind: null, nutrition: null,
      fitness:   null, water: null, fasting: null,
    };

    if (active_coaches.includes('sleep') && ui.sleep) {
      out.sleep = {
        target_hours:     ui.sleep.target_hours || null,
        disruptors:       Array.isArray(ui.sleep.disruptors) ? ui.sleep.disruptors : [],
        primary_problem:  derived.sleep?.primary_problem || null,
      };
    }
    if (active_coaches.includes('mind') && ui.mind) {
      out.mind = {
        triggers:           Array.isArray(ui.mind.triggers) ? ui.mind.triggers : [],
        primary_challenge:  derived.mind?.primary_challenge || null,
        goals:              Array.isArray(ui.mind.goals) ? ui.mind.goals : [],
      };
    }
    if (active_coaches.includes('nutrition') && ui.nutrition) {
      out.nutrition = {
        goal:           ui.nutrition.goal || null,
        dietary_style:  Array.isArray(ui.nutrition.dietary_style) ? ui.nutrition.dietary_style : [],
        allergies:      Array.isArray(ui.nutrition.allergies) ? ui.nutrition.allergies : [],
        calorie_target: derived.nutrition?.calorie_target || null,
      };
    }
    if (active_coaches.includes('fitness') && ui.fitness) {
      out.fitness = {
        goal:           ui.fitness.goal || null,
        training_level: ui.fitness.training_level || null,
        equipment:      Array.isArray(ui.fitness.equipment) ? ui.fitness.equipment : [],
        training_days:  Array.isArray(ui.fitness.training_days) ? ui.fitness.training_days : [],
        injury_notes:   derived.fitness?.injury_notes || null,
      };
    }
    if (active_coaches.includes('water') && ui.water) {
      out.water = {
        daily_goal_ml:  derived.water?.daily_goal_ml || null,
        climate:        derived.water?.climate || null,
      };
    }
    if (active_coaches.includes('fasting') && ui.fasting) {
      out.fasting = {
        protocol:         ui.fasting.protocol || null,
        experience_level: derived.fasting?.experience_level || null,
        fasting_window:   derived.fasting?.fasting_window || null,
      };
    }

    return out;
  } catch (e) {
    log.warn('[goal-plans/userContext] load fail:', e?.message);
    return empty;
  }
}

/**
 * Renders the context as a structured prompt block. Returns an empty string
 * when nothing is known — so the prompt doesn't get padded with "unknown".
 *
 * The block is intentionally line-oriented so the LLM can grep for specific
 * fields ("Equipment: bands, dumbbells") rather than parsing prose.
 */
function renderContextBlock(ctx) {
  if (!ctx) return '';
  const profile = [];
  if (ctx.name) profile.push(`Name: ${ctx.name}`);
  if (ctx.age_group) profile.push(`Age: ${ctx.age_group}`);
  if (ctx.gender) profile.push(`Gender: ${ctx.gender}`);
  if (ctx.weight_kg) profile.push(`Weight: ${ctx.weight_kg} kg`);
  if (ctx.height_cm) profile.push(`Height: ${ctx.height_cm} cm`);
  if (ctx.activity_level) profile.push(`Activity level: ${ctx.activity_level}`);
  if (ctx.pregnancy) profile.push(`Pregnant: yes`);
  if (ctx.wake_time) profile.push(`Wakes at: ${ctx.wake_time}`);
  if (ctx.bed_time)  profile.push(`Goes to bed at: ${ctx.bed_time}`);
  if (ctx.chronotype) profile.push(`Chronotype: ${ctx.chronotype}`);
  if (ctx.primary_goal) profile.push(`Stated primary goal: ${ctx.primary_goal}`);

  const coverage = [];
  if (ctx.active_coaches?.length) coverage.push(`Active coaches already set up: ${ctx.active_coaches.join(', ')}`);
  if (ctx.primary_coach) coverage.push(`Primary coach: ${ctx.primary_coach}`);
  if (typeof ctx.days_since_join === 'number') coverage.push(`Days since join: ${ctx.days_since_join}`);
  if (ctx.cold_start_anchor) coverage.push(`Cold-start anchor: ${ctx.cold_start_anchor}`);

  const perCoach = [];
  if (ctx.fitness) {
    const f = ctx.fitness;
    const bits = [];
    if (f.goal) bits.push(`goal=${f.goal}`);
    if (f.training_level) bits.push(`level=${f.training_level}`);
    if (f.equipment?.length) bits.push(`equipment=[${f.equipment.join(', ')}]`);
    if (f.training_days?.length) bits.push(`training_days=[${f.training_days.join(', ')}]`);
    if (f.injury_notes) bits.push(`injury_notes="${f.injury_notes}"`);
    if (bits.length) perCoach.push(`  fitness: ${bits.join(' · ')}`);
  }
  if (ctx.nutrition) {
    const n = ctx.nutrition;
    const bits = [];
    if (n.goal) bits.push(`goal=${n.goal}`);
    if (n.dietary_style?.length) bits.push(`diet=[${n.dietary_style.join(', ')}]`);
    if (n.allergies?.length) bits.push(`allergies=[${n.allergies.join(', ')}]`);
    if (n.calorie_target) bits.push(`calorie_target≈${n.calorie_target}`);
    if (bits.length) perCoach.push(`  nutrition: ${bits.join(' · ')}`);
  }
  if (ctx.sleep) {
    const s = ctx.sleep;
    const bits = [];
    if (s.target_hours) bits.push(`target_hours=${s.target_hours}`);
    if (s.disruptors?.length) bits.push(`disruptors=[${s.disruptors.join(', ')}]`);
    if (s.primary_problem) bits.push(`primary_problem=${s.primary_problem}`);
    if (bits.length) perCoach.push(`  sleep: ${bits.join(' · ')}`);
  }
  if (ctx.mind) {
    const m = ctx.mind;
    const bits = [];
    if (m.triggers?.length) bits.push(`triggers=[${m.triggers.join(', ')}]`);
    if (m.primary_challenge) bits.push(`primary_challenge=${m.primary_challenge}`);
    if (m.goals?.length) bits.push(`goals=[${m.goals.join(', ')}]`);
    if (bits.length) perCoach.push(`  mind: ${bits.join(' · ')}`);
  }
  if (ctx.water) {
    const w = ctx.water;
    const bits = [];
    if (w.daily_goal_ml) bits.push(`daily_goal_ml=${w.daily_goal_ml}`);
    if (w.climate) bits.push(`climate=${w.climate}`);
    if (bits.length) perCoach.push(`  water: ${bits.join(' · ')}`);
  }
  if (ctx.fasting) {
    const f = ctx.fasting;
    const bits = [];
    if (f.protocol) bits.push(`protocol=${f.protocol}`);
    if (f.experience_level) bits.push(`experience=${f.experience_level}`);
    if (f.fasting_window) bits.push(`window=${f.fasting_window}`);
    if (bits.length) perCoach.push(`  fasting: ${bits.join(' · ')}`);
  }

  if (!profile.length && !coverage.length && !perCoach.length) return '';

  const sections = [];
  sections.push('USER CONTEXT (already known — do NOT re-ask any of these):');
  if (profile.length)   sections.push(profile.map((l) => '  ' + l).join('\n'));
  if (coverage.length)  sections.push(coverage.map((l) => '  ' + l).join('\n'));
  if (perCoach.length) {
    sections.push('  Per-coach setup:');
    sections.push(perCoach.join('\n'));
  }
  return sections.join('\n') + '\n';
}

module.exports = { loadUserContext, renderContextBlock };
