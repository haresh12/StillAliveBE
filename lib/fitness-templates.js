"use strict";
// ================================================================
// FITNESS TEMPLATES — saved workouts the user can re-log in one tap.
//
// A template stores STRUCTURE only (exercises + default sets/reps), NEVER weights. Weights are
// resolved at log-time from the user's most recent performance of each exercise, so a template
// stays "alive" and reflects current strength instead of going stale.
//
//   POST /api/fitness/templates          save {name, day_of_week?, exercises:[{name,sets,reps,entry_type?}]}
//   GET  /api/fitness/templates          list (sorted by recency)
//   POST /api/fitness/templates/delete   {id}
//   GET  /api/fitness/templates/resolve  ?id=  → exercises with weights filled from history
//
// bc-namespaced (wellness_bc_users) — live data untouched.
// ================================================================
const admin = require("firebase-admin");
const { userDoc } = require("./collections");

const fitnessDoc = (id) => userDoc(id).collection("agents").doc("fitness");
const templatesCol = (id) => fitnessDoc(id).collection("fitness_templates");
const workoutsCol = (id) => fitnessDoc(id).collection("fitness_workouts");
const ts = () => admin.firestore.FieldValue.serverTimestamp();
const toIso = (v) => {
  try { return v && v.toDate ? v.toDate().toISOString() : null; } catch (_) { return null; }
};
const intOr = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

const VALID_TYPES = ["WEIGHT_REPS", "BODYWEIGHT_REPS", "DISTANCE_TIME", "TIME_ONLY", "INTERVAL", "WEIGHT_DISTANCE"];

async function saveTemplate(req, res) {
  const { deviceId, name, day_of_week, exercises } = req.body || {};
  if (!deviceId || !Array.isArray(exercises) || !exercises.length) {
    return res.status(400).json({ error: "deviceId + exercises required" });
  }
  const clean = exercises.slice(0, 30).map((e) => ({
    name: String(e?.name || "Exercise").slice(0, 60),
    sets: Math.max(1, Math.min(20, intOr(e?.sets, 3))),
    reps: Math.max(0, Math.min(100, intOr(e?.reps, 10))),
    entry_type: VALID_TYPES.includes(e?.entry_type) ? e.entry_type : "WEIGHT_REPS",
  }));
  const dow = day_of_week == null ? null : Math.max(0, Math.min(6, intOr(day_of_week, 0)));
  try {
    const ref = await templatesCol(deviceId).add({
      name: String(name || "My Workout").slice(0, 50),
      day_of_week: dow,
      exercises: clean,
      created_at: ts(),
      last_used_at: null,
      use_count: 0,
    });
    return res.json({ success: true, id: ref.id });
  } catch (e) {
    (globalThis.log?.error || console.error)("[templates] save", e);
    return res.status(500).json({ error: "save failed" });
  }
}

async function listTemplates(req, res) {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const snap = await templatesCol(deviceId).get();
    const templates = snap.docs.map((d) => {
      const t = d.data();
      return {
        id: d.id,
        name: t.name || "My Workout",
        day_of_week: t.day_of_week ?? null,
        exercise_count: (t.exercises || []).length,
        exercises: t.exercises || [],
        use_count: t.use_count || 0,
        last_used_at: toIso(t.last_used_at),
        created_at: toIso(t.created_at),
      };
    });
    // Most-recently-used first (then newest). In-memory sort — no composite index.
    templates.sort((a, b) => (b.last_used_at || b.created_at || "").localeCompare(a.last_used_at || a.created_at || ""));
    return res.json({ templates });
  } catch (e) {
    (globalThis.log?.error || console.error)("[templates] list", e);
    return res.status(500).json({ error: "list failed" });
  }
}

async function deleteTemplate(req, res) {
  const { deviceId, id } = req.body || {};
  if (!deviceId || !id) return res.status(400).json({ error: "deviceId + id required" });
  try {
    await templatesCol(deviceId).doc(id).delete();
    return res.json({ success: true });
  } catch (e) {
    (globalThis.log?.error || console.error)("[templates] delete", e);
    return res.status(500).json({ error: "delete failed" });
  }
}

// Resolve a template into a ready-to-log workout: weights filled from the user's latest
// performance of each exercise (the "smart weight resolution" that keeps templates alive).
async function resolveTemplate(req, res) {
  const { deviceId, id } = req.query;
  if (!deviceId || !id) return res.status(400).json({ error: "deviceId + id required" });
  try {
    const doc = await templatesCol(deviceId).doc(id).get();
    if (!doc.exists) return res.status(404).json({ error: "template not found" });
    const t = doc.data();

    // Latest weight/reps per exercise name from recent history. Order by logged_at — the canonical
    // recency field every other workout query in the app uses (don't drift to created_at).
    const wsnap = await workoutsCol(deviceId).orderBy("logged_at", "desc").limit(60).get();
    const lastByEx = {};
    wsnap.docs.forEach((w) => {
      (w.data().exercises || []).forEach((ex) => {
        const k = String(ex?.name || "").toLowerCase();
        if (k && !lastByEx[k]) {
          const sets = ex.sets || [];
          const s = sets[sets.length - 1] || sets[0];
          if (s) lastByEx[k] = { weight_kg: s.weight_kg || 0, reps: s.reps || 0 };
        }
      });
    });

    const exercises = (t.exercises || []).map((e) => {
      const k = String(e?.name || "").toLowerCase();
      const last = lastByEx[k];
      const setCount = Math.max(1, intOr(e?.sets, 3));
      const reps = last?.reps || intOr(e?.reps, 10);
      const weight_kg = last ? last.weight_kg : 0;
      return {
        name: e?.name || "Exercise",
        entry_type: e?.entry_type || "WEIGHT_REPS",
        sets: Array.from({ length: setCount }, () => ({ reps, weight_kg })),
      };
    });

    // Bump usage (fire-and-forget).
    templatesCol(deviceId).doc(id).update({ last_used_at: ts(), use_count: (t.use_count || 0) + 1 }).catch(() => {});

    return res.json({ id, name: t.name || "My Workout", exercises });
  } catch (e) {
    (globalThis.log?.error || console.error)("[templates] resolve", e);
    return res.status(500).json({ error: "resolve failed" });
  }
}

const DAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Merge today's just-logged exercises into an accumulating day session. Same exercise name → ADD its
// sets to what's already there (bench 4 sets, then bench 4 more = 8 sets — both logs counted, never
// one silently overwriting the other); new exercise → append. So multiple logs on the same Friday
// build ONE Friday workout that reflects EVERYTHING done that day.
function mergeExercises(existing, incoming) {
  const out = Array.isArray(existing) ? existing.map((e) => ({ ...e })) : [];
  for (const inc of incoming) {
    const idx = out.findIndex((e) => String(e.name || "").toLowerCase() === String(inc.name || "").toLowerCase());
    if (idx >= 0) {
      const prevSets = intOr(out[idx].sets, 0) || 0;
      const incSets = intOr(inc.sets, 0) || 0;
      out[idx] = { ...inc, sets: Math.max(1, Math.min(40, prevSets + incSets)) }; // accumulate sets, keep latest reps/type
    } else {
      out.push(inc);
    }
  }
  return out.slice(0, 40);
}

const sameExerciseSet = (a, b) => {
  const na = new Set((a || []).map((e) => String(e.name || "").toLowerCase()));
  const nb = new Set((b || []).map((e) => String(e.name || "").toLowerCase()));
  if (na.size !== nb.size) return false;
  for (const x of na) if (!nb.has(x)) return false;
  return true;
};
const cleanForTemplate = (enriched) =>
  (enriched || []).slice(0, 30).map((e) => {
    const sets = Array.isArray(e?.sets) ? e.sets : [];
    return {
      name: String(e?.name || "Exercise").slice(0, 60),
      sets: Math.max(1, Math.min(20, sets.length || intOr(e?.sets, 3) || 3)),
      reps: Math.max(0, Math.min(100, intOr(sets[0]?.reps, intOr(e?.reps, 10)))),
      entry_type: VALID_TYPES.includes(e?.entry_type) ? e.entry_type : "WEIGHT_REPS",
    };
  });

// Apply a just-logged session to the weekday's saved workout, returning what happened so the FE can
// ASK on a conflict. Rules:
//   • same day            → APPEND/merge (the whole day builds up).               → {conflict:false}
//   • new day, no saved   → create.                                              → {conflict:false}
//   • new day, SAME set   → refresh (re-logging the routine).                    → {conflict:false}
//   • new day, DIFFERENT  → DON'T touch the saved workout; let the user decide.  → {conflict:true, ...}
async function applyDayLog(deviceId, dow, enriched, workoutDate) {
  if (!deviceId || dow == null || !Array.isArray(enriched) || !enriched.length) return { conflict: false };
  const clean = cleanForTemplate(enriched);
  const name = `${DAY_FULL[dow] || "My"} Workout`;
  try {
    const snap = await templatesCol(deviceId).get();
    const existing = snap.docs.find((d) => (d.data().day_of_week ?? null) === dow);
    if (!existing) {
      // Fire-and-forget write — the conflict status (what the FE needs) is known from the read alone.
      templatesCol(deviceId).add({ name, day_of_week: dow, exercises: clean, session_date: workoutDate || null, created_at: ts(), last_used_at: ts(), use_count: 0 }).catch(() => {});
      return { conflict: false };
    }
    const data = existing.data();
    const saved = data.exercises || [];
    if (workoutDate && data.session_date === workoutDate) {
      existing.ref.update({ name, exercises: mergeExercises(saved, clean), session_date: workoutDate, last_used_at: ts() }).catch(() => {});
      return { conflict: false };
    }
    if (sameExerciseSet(saved, clean)) {
      existing.ref.update({ exercises: clean, session_date: workoutDate || data.session_date || null, last_used_at: ts() }).catch(() => {});
      return { conflict: false };
    }
    // New occurrence of this weekday with a DIFFERENT workout → AUTO-APPEND the exercises that aren't
    // already in the day's plan (the user did something extra). We do NOT bump sets on existing lifts or
    // prompt — the plan just grows to reflect what they actually do. We report `added` so the FE can show
    // "Added X to your Friday 💪 (undo)". Undo removes those exact names (POST /day-workout/remove).
    const savedNames = new Set(saved.map((e) => String(e.name || "").toLowerCase()));
    const newOnes = clean.filter((e) => !savedNames.has(String(e.name || "").toLowerCase()));
    if (!newOnes.length) return { conflict: false }; // logged a subset of the plan → nothing to add
    // Stamp session_date so a SECOND log on this same day takes the same-day merge path above (sets
    // accumulate) instead of re-entering this append branch every time.
    existing.ref.update({ exercises: [...saved, ...newOnes], session_date: workoutDate || data.session_date || null, last_used_at: ts() }).catch(() => {});
    return { conflict: false, appended: true, dow, day_name: DAY_FULL[dow] || null, added: newOnes.map((e) => e.name) };
  } catch (e) {
    (globalThis.log?.error || console.error)("[templates] applyDayLog", e);
    return { conflict: false };
  }
}

// Remove specific exercises (by name) from a weekday's plan — powers "undo" after an auto-append.
async function removeDayExercises(deviceId, dow, names) {
  if (!deviceId || dow == null || !Array.isArray(names) || !names.length) return false;
  const drop = new Set(names.map((n) => String(n || "").toLowerCase()));
  try {
    const snap = await templatesCol(deviceId).get();
    const existing = snap.docs.find((d) => (d.data().day_of_week ?? null) === dow);
    if (!existing) return false;
    const kept = (existing.data().exercises || []).filter((e) => !drop.has(String(e.name || "").toLowerCase()));
    await existing.ref.update({ exercises: kept, last_used_at: ts() });
    return true;
  } catch (e) {
    (globalThis.log?.error || console.error)("[templates] removeDayExercises", e);
    return false;
  }
}

// REPLACE the WHOLE plan: delete every existing weekday template, then write the new plan's days. This
// is what makes "one plan that gets overridden" true — create/upload/AI all call this on confirm, so no
// stale day from a previous plan ever lingers. days = [{dow, exercises:[{name,sets,reps}]}].
async function replaceAllPlan(deviceId, days) {
  if (!deviceId) return 0;
  const list = Array.isArray(days) ? days : [];
  try {
    // Build the valid day-docs FIRST. Guard: a non-empty payload that yields zero valid days is almost
    // certainly malformed — refuse to wipe the existing plan over garbage. An explicitly empty list IS
    // allowed to clear the plan (the user removed everything).
    const toCreate = [];
    for (const d of list) {
      const dow = parseInt(d?.dow, 10);
      const clean = cleanForTemplate(Array.isArray(d?.exercises) ? d.exercises : []);
      if (!Number.isInteger(dow) || dow < 0 || dow > 6 || !clean.length) continue;
      toCreate.push({ dow, clean });
    }
    if (list.length && !toCreate.length) return 0; // don't nuke a real plan on a bad payload

    const snap = await templatesCol(deviceId).get();
    const batch = admin.firestore().batch();
    snap.docs.forEach((d) => batch.delete(d.ref)); // clear the old plan entirely
    for (const { dow, clean } of toCreate) {
      const ref = templatesCol(deviceId).doc();
      batch.set(ref, { name: `${DAY_FULL[dow] || "My"} Workout`, day_of_week: dow, exercises: clean, created_at: ts(), last_used_at: ts(), use_count: 0 });
    }
    await batch.commit();
    return toCreate.length;
  } catch (e) {
    (globalThis.log?.error || console.error)("[templates] replaceAllPlan", e);
    return 0;
  }
}


module.exports = { saveTemplate, listTemplates, deleteTemplate, resolveTemplate, applyDayLog, replaceAllPlan, removeDayExercises };
