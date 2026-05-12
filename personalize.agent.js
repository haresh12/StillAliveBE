'use strict';
// ═══════════════════════════════════════════════════════════════
// PERSONALIZE AGENT — unified Pulse personalization endpoint
//
// Mounted at /api/personalize. Replaces 6 individual /setup endpoints
// (one per agent) with a single atomic save that:
//   • Validates payload
//   • Runs the derive layer (populates ~33 fields engines depend on)
//   • Atomic batch write to all 6 per-agent setup docs (dual-write)
//   • Writes unified personalize_v1 doc (source of truth)
//   • Sets setup_complete flags on user doc
//   • Computes Wellness Score baseline
//   • Returns 3 personalized insights for the reveal screen
//
// Critical safety: never lets engine read undefined for any field
// they were built reading. Pre-existing /api/{coach}/setup endpoints
// remain functional through this dual-write window.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const router  = express.Router();
const admin   = require('firebase-admin');

const {
  derive,
  computeWellnessScoreBaseline,
  generateInsights,
  minToHHMM,
} = require('./lib/personalize-derive');

const db = () => admin.firestore();
const userDoc        = (id) => db().collection('wellness_users').doc(id);
const personalizeDoc = (id) => userDoc(id).collection('personalize').doc('v1');
const agentDoc       = (id, key) => userDoc(id).collection('agents').doc(key);

// ─── Validation ────────────────────────────────────────────────
const VALID_COACHES = ['sleep', 'mind', 'nutrition', 'fitness', 'water', 'fasting'];

function validatePayload(body) {
  const { deviceId, active_coaches, shared } = body;
  if (!deviceId || typeof deviceId !== 'string') return 'deviceId required';
  if (!Array.isArray(active_coaches) || active_coaches.length === 0) return 'active_coaches required (non-empty array)';
  if (active_coaches.some((c) => !VALID_COACHES.includes(c))) return `active_coaches must contain only: ${VALID_COACHES.join(', ')}`;
  if (!shared || typeof shared !== 'object') return 'shared required';
  if (!Number.isFinite(shared.wake_time_min) || !Number.isFinite(shared.bed_time_min)) return 'shared.wake_time_min and bed_time_min required';
  if (shared.wake_time_min < 0 || shared.wake_time_min >= 1440) return 'wake_time_min out of range';
  if (shared.bed_time_min  < 0 || shared.bed_time_min  >= 1440) return 'bed_time_min out of range';
  return null;
}

// ─── Build per-agent legacy setup payloads (dual-write) ────────
// Maps unified payload → shape each existing engine expects.
function buildLegacyPayloads({ payload, derived, profile }) {
  const { active_coaches, shared, sleep, mind, nutrition, fitness, water, fasting } = payload;
  const ts = admin.firestore.FieldValue.serverTimestamp();
  const out = {};

  if (active_coaches.includes('sleep')) {
    out.sleep = {
      setup_complete:         true,
      setup_completed:        true,
      setup_completed_at:     ts,
      primary_problem:        derived.sleep.primary_problem,
      target_bedtime:         minToHHMM(shared.bed_time_min),
      target_wake_time:       minToHHMM(shared.wake_time_min),
      target_hours:           sleep.target_hours,
      disruptors:             sleep.disruptors || [],
      chronotype:             derived.sleep.chronotype,
      past_attempts:          derived.sleep.past_attempts,
      daily_reminder_time:    derived.sleep.daily_reminder_time,
    };
  }

  if (active_coaches.includes('mind')) {
    out.mind = {
      setup_complete:             true,
      setup_completed:            true,
      setup_completed_at:         ts,
      primary_challenge:          derived.mind.primary_challenge,
      current_rating:             derived.mind.current_rating,
      worst_time:                 derived.mind.worst_time,
      triggers:                   mind.triggers || [],
      past_attempts:              derived.mind.past_attempts,
      social_context:             derived.mind.social_context,
      goals:                      derived.mind.goals,
      discussion_topics:          derived.mind.discussion_topics,
      daily_reflection_time:      derived.mind.daily_reflection_time,
      checkin_count:              0,
      last_action_gen_at_checkin: 0,
      last_checkin_date:          null,
      last_proactive_date:        null,
      proactive_topic_index:      0,
      analysis_cache:             null,
    };
  }

  if (active_coaches.includes('water')) {
    out.water = {
      setup_complete:     true,
      setup_completed:    true,
      setup_completed_at: ts,
      goal:               derived.water.goals,
      activity_level:     shared.activity_level || 'moderate',
      climate:            derived.water.climate,
      reminders:          derived.water.reminders,
      weight_kg:          shared.weight_kg,
      wake_time:          derived.water.wake_time,
      bed_time:           derived.water.bed_time,
      pregnancy_status:   shared.pregnancy ? 'pregnant' : 'no',
      daily_goal_ml:      derived.water.daily_goal_ml,
    };
  }

  if (active_coaches.includes('nutrition')) {
    out.nutrition = {
      setup_complete:     true,
      setup_completed:    true,
      setup_completed_at: ts,
      goal:               nutrition.goal,
      activity_level:     shared.activity_level || 'moderate',
      dietary_style:      nutrition.dietary_style || [],
      allergies:          nutrition.allergies || [],
      weight_kg:          shared.weight_kg,
      height_cm:          shared.height_cm,
      eating_pattern:     derived.nutrition.eating_pattern,
      calorie_target:     derived.nutrition.calorie_target,
    };
  }

  if (active_coaches.includes('fitness')) {
    out.fitness = {
      setup_complete:     true,
      setup_completed:    true,
      setup_completed_at: ts,
      primary_goal:       fitness.goal,
      training_level:     fitness.training_level,
      preferred_split:    derived.fitness.preferred_split,
      training_days:      fitness.training_days || [],
      gym_time:           derived.fitness.gym_time,
      reminder_time:      derived.fitness.reminder_time,
      supplements:        derived.fitness.supplements,
      baseline_lifts:     derived.fitness.baseline_lifts,
      equipment:          fitness.equipment,
      injury_notes:       derived.fitness.injury_notes,
    };
  }

  if (active_coaches.includes('fasting')) {
    out.fasting = {
      setup_complete:     true,
      setup_completed:    true,
      setup_completed_at: ts,
      protocol:           fasting.protocol,
      goal:               'general_health',
      experience_level:   derived.fasting.experience_level,
      caffeine_habit:     derived.fasting.caffeine_habit,
      medical:            derived.fasting.medical,
      schedule_type:      derived.fasting.schedule_type,
      wake_time:          derived.water.wake_time,
      bed_time:           derived.water.bed_time,
      weight_kg:          shared.weight_kg,
      height_cm:          shared.height_cm,
      fasting_window:     derived.fasting.fasting_window,
    };
  }

  return out;
}

// ─── POST /api/personalize/save ────────────────────────────────
router.post('/save', async (req, res) => {
  try {
    const err = validatePayload(req.body);
    if (err) return res.status(400).json({ error: err });

    const { deviceId, active_coaches, shared, sleep, mind, nutrition, fitness, water, fasting } = req.body;

    // Profile / locale hydration
    const userSnap = await userDoc(deviceId).get();
    const userData = userSnap.exists ? userSnap.data() : {};
    const profile = {
      name:   userData.name   || userData.profile?.name   || '',
      age:    userData.age    || userData.profile?.age    || 30,
      gender: userData.gender || userData.profile?.gender || '',
    };
    const locale = userData.locale || { country: '', language: 'en' };

    const payload = {
      deviceId, active_coaches,
      shared, sleep, mind, nutrition, fitness, water, fasting,
      profile, locale,
    };

    const derived = derive(payload);
    const wellnessScore = computeWellnessScoreBaseline(payload);
    const insights = generateInsights(payload, derived);
    const legacyPayloads = buildLegacyPayloads({ payload, derived, profile });

    // ─── Atomic batch write ─────────────────────────────────────
    const batch = db().batch();

    // Unified personalize_v1 doc (source of truth)
    batch.set(personalizeDoc(deviceId), {
      schema_version: 1,
      active_coaches,
      shared,
      user_input: { sleep, mind, nutrition, fitness, water, fasting },
      derived,
      wellness_score_baseline: wellnessScore,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    // Dual-write per-agent legacy docs
    for (const coach of active_coaches) {
      if (!legacyPayloads[coach]) continue;
      batch.set(agentDoc(deviceId, coach), legacyPayloads[coach], { merge: true });
    }

    // User doc flags
    const userFlags = {
      personalize_v1_complete:  true,
      personalize_completed_at: admin.firestore.FieldValue.serverTimestamp(),
    };
    for (const coach of active_coaches) {
      userFlags[`${coach}_setup_complete`] = true;
    }
    if (active_coaches.includes('sleep'))   userFlags.sleep_reminder_time   = derived.sleep.daily_reminder_time;
    if (active_coaches.includes('mind'))    userFlags.mind_reminder_time    = derived.mind.daily_reflection_time;
    if (active_coaches.includes('fitness')) userFlags.fitness_reminder_time = derived.fitness.gym_time;
    batch.set(userDoc(deviceId), userFlags, { merge: true });

    await batch.commit();

    return res.json({
      ok: true,
      wellness_score:  wellnessScore,
      wellness_label:  'Starting baseline',
      insights,
      derived: {
        chronotype:           derived.sleep.chronotype,
        water_target_ml:      derived.water.daily_goal_ml,
        calorie_target:       derived.nutrition.calorie_target,
        fitness_split:        derived.fitness.preferred_split,
        fasting_window:       derived.fasting.fasting_window,
        gym_time:             derived.fitness.gym_time,
        mind_reflection_time: derived.mind.daily_reflection_time,
        sleep_reminder_time:  derived.sleep.daily_reminder_time,
      },
    });
  } catch (e) {
    log.error('[personalize/save]', e);
    return res.status(500).json({ error: 'save_failed', message: String(e && e.message ? e.message : e) });
  }
});

// ─── GET /api/personalize/status ───────────────────────────────
// Lets the client check whether the unified flow already ran.
// Used for migration: returning users with personalize_v1_complete
// skip the new flow entirely.
router.get('/status/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    const snap = await personalizeDoc(deviceId).get();
    if (!snap.exists) return res.json({ completed: false });
    const data = snap.data();
    return res.json({
      completed: true,
      active_coaches:        data.active_coaches || [],
      wellness_score_baseline: data.wellness_score_baseline || null,
      completed_at:          data.created_at || null,
    });
  } catch (e) {
    log.error('[personalize/status]', e);
    return res.status(500).json({ error: 'status_failed' });
  }
});

module.exports = router;
