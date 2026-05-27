'use strict';
/**
 * fitness-entry-types.js — BE mirror of the FE entry_type model.
 *
 * Source of truth lives on the FE at
 * [fitnessExerciseTypes.js](../../StillAlive/src/screens/wellness/fitness/fitnessExerciseTypes.js).
 * Keep these two files in sync — they MUST agree on the override table and
 * the muscle-group fallback rules.
 *
 * Why a mirror not a shared package: the FE bundle is React Native and can't
 * import this BE file; this BE file can't import RN. Cost of mirror = small.
 * Risk of mirror drifting = handled by treating the FE as source-of-truth
 * and keeping the override table sorted in the same order in both files.
 */

const ENTRY_TYPES = Object.freeze({
  WEIGHT_REPS:     'WEIGHT_REPS',
  BODYWEIGHT_REPS: 'BODYWEIGHT_REPS',
  DISTANCE_TIME:   'DISTANCE_TIME',
  TIME_ONLY:       'TIME_ONLY',
  INTERVAL:        'INTERVAL',
  WEIGHT_DISTANCE: 'WEIGHT_DISTANCE',
});

const RAW_OVERRIDES = {
  // Bodyweight
  'Push-Up':              ENTRY_TYPES.BODYWEIGHT_REPS,
  'Wide Push-Up':         ENTRY_TYPES.BODYWEIGHT_REPS,
  'Diamond Push-Up':      ENTRY_TYPES.BODYWEIGHT_REPS,
  'Decline Push-Up':      ENTRY_TYPES.BODYWEIGHT_REPS,
  'Archer Push-Up':       ENTRY_TYPES.BODYWEIGHT_REPS,
  'Plyo Push-Up':         ENTRY_TYPES.BODYWEIGHT_REPS,
  'Pike Push-Up':         ENTRY_TYPES.BODYWEIGHT_REPS,
  'Handstand Push-Up':    ENTRY_TYPES.BODYWEIGHT_REPS,
  'Pull-Up':              ENTRY_TYPES.BODYWEIGHT_REPS,
  'Chin-Up':              ENTRY_TYPES.BODYWEIGHT_REPS,
  'Neutral Grip Pull-Up': ENTRY_TYPES.BODYWEIGHT_REPS,
  'Assisted Pull-Up':     ENTRY_TYPES.BODYWEIGHT_REPS,
  'L-Sit Pull-Up':        ENTRY_TYPES.BODYWEIGHT_REPS,
  'Weighted Pull-Up':     ENTRY_TYPES.BODYWEIGHT_REPS,
  'Inverted Row':         ENTRY_TYPES.BODYWEIGHT_REPS,
  'Muscle-Up':            ENTRY_TYPES.BODYWEIGHT_REPS,
  'Chest Dips':           ENTRY_TYPES.BODYWEIGHT_REPS,
  'Tricep Dips':          ENTRY_TYPES.BODYWEIGHT_REPS,
  'Bench Dip':            ENTRY_TYPES.BODYWEIGHT_REPS,
  'Bear Crawl':           ENTRY_TYPES.BODYWEIGHT_REPS,
  'Burpee':               ENTRY_TYPES.BODYWEIGHT_REPS,
  'Pistol Squat':         ENTRY_TYPES.BODYWEIGHT_REPS,
  'Nordic Curl':          ENTRY_TYPES.BODYWEIGHT_REPS,
  // Time-only
  'Plank':                ENTRY_TYPES.TIME_ONLY,
  'Side Plank':           ENTRY_TYPES.TIME_ONLY,
  'Copenhagen Plank':     ENTRY_TYPES.TIME_ONLY,
  'Hollow Hold':          ENTRY_TYPES.TIME_ONLY,
  'L-Sit':                ENTRY_TYPES.TIME_ONLY,
  'Dragon Flag':          ENTRY_TYPES.TIME_ONLY,
  'Dead Bug':             ENTRY_TYPES.TIME_ONLY,
  'Cable Pallof Hold':    ENTRY_TYPES.TIME_ONLY,
  'Wall Sit':             ENTRY_TYPES.TIME_ONLY,
  'Mountain Climber':     ENTRY_TYPES.TIME_ONLY,
  'Battle Ropes':         ENTRY_TYPES.TIME_ONLY,
  'Battle Rope Waves':    ENTRY_TYPES.TIME_ONLY,
  'Jump Rope':            ENTRY_TYPES.TIME_ONLY,
  // Interval
  'HIIT Sprint':          ENTRY_TYPES.INTERVAL,
  'Sprint Intervals':     ENTRY_TYPES.INTERVAL,
  'Tabata':               ENTRY_TYPES.INTERVAL,
  // Weight × distance (loaded carries)
  "Farmer's Walk":        ENTRY_TYPES.WEIGHT_DISTANCE,
  'Suitcase Carry':       ENTRY_TYPES.WEIGHT_DISTANCE,
  'Yoke Walk':            ENTRY_TYPES.WEIGHT_DISTANCE,
  'Sandbag Carry':        ENTRY_TYPES.WEIGHT_DISTANCE,
  'Kettlebell Goblet Carry': ENTRY_TYPES.WEIGHT_DISTANCE,
  'Sled Push':            ENTRY_TYPES.WEIGHT_DISTANCE,
  'Sled Pull':            ENTRY_TYPES.WEIGHT_DISTANCE,
  // Distance + time (cardio)
  'Treadmill Run':         ENTRY_TYPES.DISTANCE_TIME,
  'Cycling':               ENTRY_TYPES.DISTANCE_TIME,
  'Rowing Machine':        ENTRY_TYPES.DISTANCE_TIME,
  'Elliptical':            ENTRY_TYPES.DISTANCE_TIME,
  'Stairmaster':           ENTRY_TYPES.DISTANCE_TIME,
  'Stair Climbing':        ENTRY_TYPES.DISTANCE_TIME,
  'Spin Bike':             ENTRY_TYPES.DISTANCE_TIME,
  'Incline Treadmill Walk':ENTRY_TYPES.DISTANCE_TIME,
  'Outdoor Run':           ENTRY_TYPES.DISTANCE_TIME,
  'Assault Bike':          ENTRY_TYPES.DISTANCE_TIME,
  'SkiErg':                ENTRY_TYPES.DISTANCE_TIME,
  'Box Jump':              ENTRY_TYPES.TIME_ONLY,
  'Swimming':              ENTRY_TYPES.DISTANCE_TIME,
  'Versa Climber':         ENTRY_TYPES.DISTANCE_TIME,
  'Walking':               ENTRY_TYPES.DISTANCE_TIME,
  'Hiking':                ENTRY_TYPES.DISTANCE_TIME,
  'Trail Run':             ENTRY_TYPES.DISTANCE_TIME,
  'Zone 2 Cycling':        ENTRY_TYPES.DISTANCE_TIME,
  'Long Run':              ENTRY_TYPES.DISTANCE_TIME,
  'Tempo Run':             ENTRY_TYPES.DISTANCE_TIME,
  'Bike Tour':             ENTRY_TYPES.DISTANCE_TIME,
  'Indoor Cycling':        ENTRY_TYPES.DISTANCE_TIME,
  'Speed Skating':         ENTRY_TYPES.DISTANCE_TIME,
  // Voice-parser aliases (mirror of FE)
  'Rower':                 ENTRY_TYPES.DISTANCE_TIME,
  'Row Machine':           ENTRY_TYPES.DISTANCE_TIME,
  'Bike':                  ENTRY_TYPES.DISTANCE_TIME,
  'Stationary Bike':       ENTRY_TYPES.DISTANCE_TIME,
  'Run':                   ENTRY_TYPES.DISTANCE_TIME,
  'Running':               ENTRY_TYPES.DISTANCE_TIME,
  'Treadmill':             ENTRY_TYPES.DISTANCE_TIME,
  'Swim':                  ENTRY_TYPES.DISTANCE_TIME,
  'Walk':                  ENTRY_TYPES.DISTANCE_TIME,
  'Stairs':                ENTRY_TYPES.DISTANCE_TIME,
  'HIIT':                  ENTRY_TYPES.INTERVAL,
};

const OVERRIDES = new Map(
  Object.entries(RAW_OVERRIDES).map(([k, v]) => [k.toLowerCase().trim(), v]),
);

function muscleFallback(muscleGroup) {
  if (muscleGroup === 'cardio') return ENTRY_TYPES.DISTANCE_TIME;
  return ENTRY_TYPES.WEIGHT_REPS;
}

function entryTypeFor(exerciseName, muscleGroup) {
  if (!exerciseName) return muscleFallback(muscleGroup);
  const hit = OVERRIDES.get(String(exerciseName).toLowerCase().trim());
  if (hit) return hit;
  return muscleFallback(muscleGroup);
}

/**
 * validateSet(set, entryType) — throws an Error with .status=400 if the
 * set is missing a field required by its entry_type. Returns a sanitized
 * set object with only the fields relevant to its type (so downstream
 * scoring never has to guess).
 */
function validateSet(rawSet, entryType, ctx) {
  const label = ctx?.label || 'set';
  const s = rawSet || {};
  const numOrNull = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const reps = numOrNull(s.reps);
  const weight_kg = numOrNull(s.weight_kg);
  const duration_sec = numOrNull(s.duration_sec);
  const distance_m = numOrNull(s.distance_m);
  const rounds = numOrNull(s.rounds);
  const work_sec = numOrNull(s.work_sec);
  const rest_sec = numOrNull(s.rest_sec);
  const rpe = numOrNull(s.rpe);
  const rpeClamped = rpe != null ? Math.max(1, Math.min(10, rpe)) : null;

  const out = { entry_type: entryType };
  if (rpeClamped != null) out.rpe = rpeClamped;

  const need = (field, cond, msg) => {
    if (!cond) {
      throw Object.assign(new Error(`${label}: ${msg}`), { status: 400 });
    }
  };

  switch (entryType) {
    case ENTRY_TYPES.WEIGHT_REPS:
      need('reps', reps != null && reps > 0, 'reps required');
      need('weight_kg', weight_kg != null && weight_kg >= 0, 'weight required');
      out.reps = Math.round(reps);
      out.weight_kg = Math.round(weight_kg * 10) / 10;
      if (weight_kg > 0) {
        out.e1rm = Math.round(weight_kg * (1 + 0.0333 * reps) * 10) / 10;
      }
      return out;
    case ENTRY_TYPES.BODYWEIGHT_REPS:
      // Weight required to match FE rule. User types 0 for pure bodyweight,
      // or actual added load. Mirrors the WEIGHT_REPS contract so the CTA
      // can never go green with an empty weight field.
      need('reps', reps != null && reps > 0, 'reps required');
      need('weight_kg', weight_kg != null && weight_kg >= 0, 'weight required (use 0 for bodyweight)');
      out.reps = Math.round(reps);
      out.weight_kg = Math.round(weight_kg * 10) / 10;
      return out;
    case ENTRY_TYPES.DISTANCE_TIME:
      // Either distance OR duration must be present.
      need('distance_or_duration',
        (distance_m != null && distance_m > 0) || (duration_sec != null && duration_sec > 0),
        'distance or duration required');
      if (distance_m != null && distance_m > 0) out.distance_m = Math.round(distance_m);
      if (duration_sec != null && duration_sec > 0) out.duration_sec = Math.round(duration_sec);
      return out;
    case ENTRY_TYPES.TIME_ONLY:
      need('duration_sec', duration_sec != null && duration_sec > 0, 'duration required');
      out.duration_sec = Math.round(duration_sec);
      return out;
    case ENTRY_TYPES.INTERVAL:
      need('rounds', rounds != null && rounds > 0, 'rounds required');
      need('work_sec', work_sec != null && work_sec > 0, 'work time required');
      out.rounds = Math.round(rounds);
      out.work_sec = Math.round(work_sec);
      if (rest_sec != null && rest_sec >= 0) out.rest_sec = Math.round(rest_sec);
      return out;
    case ENTRY_TYPES.WEIGHT_DISTANCE:
      need('distance_m', distance_m != null && distance_m > 0, 'distance required');
      out.distance_m = Math.round(distance_m);
      if (weight_kg != null && weight_kg >= 0) out.weight_kg = Math.round(weight_kg * 10) / 10;
      return out;
    default:
      // Unknown type — degrade safely to WEIGHT_REPS contract so existing
      // clients keep working.
      need('reps', reps != null && reps > 0, 'reps required');
      need('weight_kg', weight_kg != null && weight_kg >= 0, 'weight required');
      out.entry_type = ENTRY_TYPES.WEIGHT_REPS;
      out.reps = Math.round(reps);
      out.weight_kg = Math.round(weight_kg * 10) / 10;
      return out;
  }
}

module.exports = {
  ENTRY_TYPES,
  entryTypeFor,
  validateSet,
};
