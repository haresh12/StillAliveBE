"use strict";

// ================================================================
// FITNESS AGENT -- Pulse Backend
// Mounted at /api/fitness in server.js
//
// Science basis:
//   Volume landmarks: Israetel et al. 2019, Renaissance Periodization
//   Progressive overload: Schoenfeld 2010 (J Strength Cond Res)
//   Recovery: Kellmann & Kallus 2001, Meeusen et al. 2013 (self-report only)
//   Pure fitness data — NO cross-agent reads. All signals computed from
//   logged workouts (workoutsCol) and self-reported check-ins only.
// ================================================================

const express = require("express");
const router = express.Router();
const admin = require("firebase-admin");
const { OpenAI } = require("openai");
const cron = require("node-cron");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const db = () => admin.firestore();

// ----------------------------------------------------------------
// Context cache (5-min TTL)
// ----------------------------------------------------------------
const _ctxCache = new Map();
const CTX_TTL = 5 * 60 * 1000;

// ----------------------------------------------------------------
// Analysis response cache (60s TTL with stampede protection)
// ----------------------------------------------------------------
const _analysisCache = new Map();   // key: `${deviceId}:${range}` → {body, builtAt}
const _analysisLocks = new Map();   // key → Promise (in-flight)
const ANALYSIS_TTL = 60 * 1000;
function invalidateAnalysisCache(deviceId) {
  for (const k of [..._analysisCache.keys()]) if (k.startsWith(`${deviceId}:`)) _analysisCache.delete(k);
}

function invalidateCtx(deviceId) {
  _ctxCache.delete(deviceId);
}

async function getCachedContext(deviceId) {
  const cached = _ctxCache.get(deviceId);
  if (cached && Date.now() - cached.builtAt < CTX_TTL) return cached.context;
  const context = await buildFitnessContext(deviceId);
  _ctxCache.set(deviceId, { context, builtAt: Date.now() });
  return context;
}

// ----------------------------------------------------------------
// Chat rate limiter (20 req / 60s per device)
// ----------------------------------------------------------------
const _rateMap = new Map();
function checkChatRate(deviceId) {
  const now = Date.now();
  const entry = _rateMap.get(deviceId);
  if (!entry || now - entry.t > 60_000) {
    _rateMap.set(deviceId, { t: now, n: 1 });
    return true;
  }
  if (entry.n >= 20) return false;
  entry.n += 1;
  return true;
}

// ----------------------------------------------------------------
// Action generation queue (prevent concurrent generation)
// ----------------------------------------------------------------
const _actionGenMap = new Map();
const ACTION_GEN_STALE_MS = 90 * 1000;
const ACTION_BATCH_SIZE = 3;
const ACTION_LOOKBACK_DAYS = 30;

// ----------------------------------------------------------------
// Firestore paths
// ----------------------------------------------------------------
const userDoc = (id) => db().collection("wellness_users").doc(id);
const fitnessDoc = (id) => userDoc(id).collection("agents").doc("fitness");
const workoutsCol = (id) => fitnessDoc(id).collection("fitness_workouts");
const actionsCol = (id) => fitnessDoc(id).collection("fitness_actions");
const chatsCol = (id) => fitnessDoc(id).collection("fitness_chats");

// ════════════════════════════════════════════════════════════════
// ACTIONS v2 — shared engine. Mounts BEFORE legacy routes.
// ════════════════════════════════════════════════════════════════
const { mountActionRoutes, gradeActions: _gradeActionsShared } = require('./lib/actions-engine');
const { computeFitnessCandidates, fitnessGraders } = require('./lib/candidates/fitness');
const { assertNoCrossAgent } = require('./lib/sandbox');
assertNoCrossAgent('fitness', computeFitnessCandidates);
const _v2Hooks = mountActionRoutes(router, {
  agentName: 'fitness',
  agentDocRef: fitnessDoc,
  actionsCol, logsCol: workoutsCol,
  computeCandidates: computeFitnessCandidates,
  graders: fitnessGraders,
  openai, admin, db,
});
function _onFitnessLog(deviceId) {
  fitnessDoc(deviceId).update({
    log_count_since_last_batch: admin.firestore.FieldValue.increment(1),
  }).catch(() => {});
  _v2Hooks.queueGeneration(deviceId);
  _gradeActionsShared({
    agentName: 'fitness', deviceId, actionsCol, logsCol: workoutsCol,
    graders: fitnessGraders, admin, db,
  }).catch(() => {});
  try { require('./wellness.cross').invalidateWellnessCache?.(deviceId); } catch {}
}
// ════════════════════════════════════════════════════════════════

// ----------------------------------------------------------------
// MEV / MAV / MRV landmarks (sets per week)
// Source: Renaissance Periodization by Dr. Mike Israetel
// ----------------------------------------------------------------
const VOLUME_LANDMARKS = {
  chest: { MEV: 8, MAV: [12, 16], MRV: 20 },
  back: { MEV: 10, MAV: [14, 22], MRV: 25 },
  shoulders: { MEV: 8, MAV: [16, 22], MRV: 26 },
  quads: { MEV: 8, MAV: [12, 18], MRV: 20 },
  hamstrings: { MEV: 6, MAV: [10, 16], MRV: 20 },
  glutes: { MEV: 4, MAV: [12, 16], MRV: 20 },
  biceps: { MEV: 8, MAV: [14, 20], MRV: 26 },
  triceps: { MEV: 8, MAV: [14, 20], MRV: 26 },
  calves: { MEV: 8, MAV: [12, 16], MRV: 20 },
  abs: { MEV: 0, MAV: [16, 20], MRV: 25 },
};

// ----------------------------------------------------------------
// Exercise → muscle group mapping
// ----------------------------------------------------------------
const MUSCLE_MAP_RULES = [
  {
    keys: [
      "bench press",
      "push up",
      "pushup",
      "chest fly",
      "dip",
      "cable fly",
      "pec",
    ],
    muscle: "chest",
  },
  {
    keys: [
      "squat",
      "leg press",
      "lunge",
      "front squat",
      "hack squat",
      "step up",
      "leg extension",
    ],
    muscle: "quads",
  },
  {
    keys: [
      "deadlift",
      "rdl",
      "romanian",
      "leg curl",
      "hamstring",
      "good morning",
    ],
    muscle: "hamstrings",
  },
  {
    keys: ["hip thrust", "glute bridge", "cable kickback", "glute"],
    muscle: "glutes",
  },
  {
    keys: [
      "row",
      "pull up",
      "pullup",
      "pulldown",
      "lat pulldown",
      "deadlift",
      "shrug",
      "back",
    ],
    muscle: "back",
  },
  {
    keys: [
      "overhead press",
      "ohp",
      "military press",
      "lateral raise",
      "front raise",
      "arnold",
      "shoulder",
    ],
    muscle: "shoulders",
  },
  { keys: ["curl", "bicep", "hammer curl", "preacher"], muscle: "biceps" },
  {
    keys: [
      "tricep",
      "skull crusher",
      "close grip",
      "pushdown",
      "overhead extension",
    ],
    muscle: "triceps",
  },
  { keys: ["calf raise", "calf", "standing calf"], muscle: "calves" },
  {
    keys: [
      "crunch",
      "plank",
      "ab rollout",
      "cable crunch",
      "sit up",
      "leg raise",
      "abs",
      "core",
    ],
    muscle: "abs",
  },
];

function detectMuscleGroup(exerciseName) {
  const lower = (exerciseName || "").toLowerCase();
  for (const rule of MUSCLE_MAP_RULES) {
    if (rule.keys.some((k) => lower.includes(k))) return rule.muscle;
  }
  return "other";
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------
const dateStr = (d = new Date()) => {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${dd}`;
};

const mapDoc = (doc) => ({ id: doc.id, ...doc.data() });

const getMillis = (value) => {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  const p = new Date(value).getTime();
  return Number.isNaN(p) ? 0 : p;
};

const toIso = (value) => {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  const p = new Date(value);
  return Number.isNaN(p.getTime()) ? null : p.toISOString();
};

const round = (n, dp = 1) => {
  const f = Math.pow(10, dp);
  return Math.round((n || 0) * f) / f;
};

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const avg = (arr) =>
  arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;

function computeStreak(workouts) {
  if (!workouts.length) return 0;
  const sorted = [...workouts].sort((a, b) =>
    (b.date || "").localeCompare(a.date || ""),
  );
  const today = dateStr();
  const dates = new Set(sorted.map((w) => w.date));
  let streak = 0;
  let cur = today;
  const prevDay = (d) => {
    const dt = new Date(d);
    dt.setDate(dt.getDate() - 1);
    return dateStr(dt);
  };
  if (!dates.has(cur)) cur = prevDay(cur);
  while (dates.has(cur)) {
    streak++;
    cur = prevDay(cur);
  }
  return streak;
}

// ----------------------------------------------------------------
// Volume landmark calculation (sets/week for last 7 days)
// ----------------------------------------------------------------
function calcVolumeByMuscle(workouts) {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  const recent = workouts.filter((w) => getMillis(w.logged_at) >= cutoff);
  const setCounts = {};
  for (const w of recent) {
    for (const ex of w.exercises || []) {
      const muscle = ex.muscle_group || "other";
      if (muscle === "other" || muscle === "cardio") continue;
      setCounts[muscle] = (setCounts[muscle] || 0) + (ex.sets?.length || 0);
    }
  }
  return setCounts;
}

// ----------------------------------------------------------------
// Personal records detection — single Firestore query for all exercises
// ----------------------------------------------------------------
async function detectPRs(deviceId, exercises) {
  const withWeight = exercises.filter(
    (ex) => ex.name && ex.sets?.some((s) => s.weight_kg > 0),
  );
  if (!withWeight.length) return [];
  try {
    // One query for all exercises instead of N queries
    const prevSnap = await workoutsCol(deviceId)
      .orderBy("logged_at", "desc")
      .limit(50)
      .get();
    const prevWorkouts = prevSnap.docs.map((d) => d.data());

    const prs = [];
    for (const ex of withWeight) {
      const maxWeight = Math.max(...ex.sets.map((s) => s.weight_kg || 0));
      if (!maxWeight) continue;
      const prevMax = prevWorkouts
        .flatMap((w) => w.exercises || [])
        .filter((e) => (e.name || "").toLowerCase() === ex.name.toLowerCase())
        .flatMap((e) => e.sets || [])
        .reduce((max, s) => Math.max(max, s.weight_kg || 0), 0);
      if (maxWeight > prevMax) prs.push(ex.name);
    }
    return prs;
  } catch {
    return [];
  }
}

// ----------------------------------------------------------------
// Build AI context for chat
// ----------------------------------------------------------------
async function buildFitnessContext(deviceId) {
  try {
    const fSnap = await fitnessDoc(deviceId).get();
    if (!fSnap.exists) return "No setup data.";

    const data = fSnap.data() || {};
    const setup = data.setup || {};

    const wSnap = await workoutsCol(deviceId)
      .orderBy("logged_at", "desc")
      .limit(90)
      .get();
    const workouts = wSnap.docs.map(mapDoc);

    const totalWorkouts = workouts.length;
    const streak = computeStreak(workouts);
    const recentWorkouts = workouts.slice(0, 10);
    const muscleVol = calcVolumeByMuscle(workouts);

    const recentLog = recentWorkouts
      .slice(0, 5)
      .map((w) => {
        const exNames = (w.exercises || [])
          .map((e) => `${e.name}(${e.sets?.length || 0}s)`)
          .join(", ");
        const prs = (w.personal_records || []).join(", ");
        return `${w.date}: ${exNames}${prs ? ` [PR: ${prs}]` : ""} vol=${Math.round(w.total_volume_kg || 0)}kg`;
      })
      .join("\n");

    const volLines = Object.entries(muscleVol)
      .map(([m, sets]) => {
        const lm = VOLUME_LANDMARKS[m];
        if (!lm) return `${m}: ${sets} sets`;
        const status =
          sets < lm.MEV
            ? "below MEV"
            : sets <= lm.MAV[1]
              ? "in MAV"
              : sets <= lm.MRV
                ? "above MAV"
                : "above MRV";
        return `${m}: ${sets} sets/wk (${status}, MAV=${lm.MAV[0]}-${lm.MAV[1]}, MRV=${lm.MRV})`;
      })
      .join("\n");

    const cachedInsight = data.analysis_cache?.insight || "";

    const trainingDays =
      Array.isArray(setup.training_days) && setup.training_days.length > 0
        ? setup.training_days.join(", ")
        : `${setup.days_per_week || 3} days/week`;
    const supplements =
      Array.isArray(setup.supplements) &&
      setup.supplements.length > 0 &&
      !setup.supplements.includes("none")
        ? setup.supplements.join(", ")
        : "none";
    const split =
      setup.preferred_split && setup.preferred_split !== "none"
        ? setup.preferred_split
        : "unstructured";
    const baselines = setup.baseline_lifts
      ? `bench ${setup.baseline_lifts.bench_press || "?"}kg, squat ${setup.baseline_lifts.squat || "?"}kg, deadlift ${setup.baseline_lifts.deadlift || "?"}kg`
      : "not set";

    return [
      `Goal: ${setup.primary_goal || "general"}. Level: ${setup.training_level || "beginner"}. Split: ${split}.`,
      `Equipment: ${setup.equipment || "full_gym"}. Injuries/notes: ${setup.injury_notes || "none"}.`,
      `Training schedule: ${trainingDays}. Gym time: ${setup.gym_time || "07:00"}.`,
      `Supplements: ${supplements}.`,
      `Baseline lifts: ${baselines}.`,
      `Total workouts logged: ${totalWorkouts}. Current streak: ${streak}d.`,
      `Volume landmarks this week (sets):\n${volLines || "No workouts this week."}`,
      `Recent workout log:\n${recentLog || "No workouts yet."}`,
      cachedInsight ? `Latest coach insight: ${cachedInsight}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  } catch (e) {
    console.error("[fitness] buildFitnessContext:", e);
    return "Context unavailable.";
  }
}

// ----------------------------------------------------------------
// Action context (for action generation — reads last 30d pattern)
// ----------------------------------------------------------------
async function buildActionContext(deviceId) {
  try {
    const fSnap = await fitnessDoc(deviceId).get();
    if (!fSnap.exists) return "No setup data.";
    const data = fSnap.data() || {};
    const setup = data.setup || {};

    const cutoffMs = Date.now() - ACTION_LOOKBACK_DAYS * 24 * 3600 * 1000;
    const wSnap = await workoutsCol(deviceId)
      .orderBy("logged_at", "desc")
      .limit(150)
      .get();
    const all = wSnap.docs.map(mapDoc);
    const recent = all.filter((w) => getMillis(w.logged_at) >= cutoffMs);
    const window = recent.length ? recent : all.slice(0, 30);
    const latest3 = all.slice(0, 3);

    const streak = computeStreak(all);
    const muscleVol = calcVolumeByMuscle(all);

    const prExercises = all.flatMap((w) => w.personal_records || []);
    const prCounts = {};
    for (const ex of prExercises) prCounts[ex] = (prCounts[ex] || 0) + 1;
    const topPRs = Object.entries(prCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([ex]) => ex)
      .join(", ");

    const volStatus = Object.entries(muscleVol)
      .map(([m, sets]) => {
        const lm = VOLUME_LANDMARKS[m];
        if (!lm) return null;
        const status =
          sets < lm.MEV
            ? "below_MEV"
            : sets <= lm.MAV[1]
              ? "in_MAV"
              : sets <= lm.MRV
                ? "above_MAV"
                : "above_MRV";
        return `${m}:${sets}sets(${status})`;
      })
      .filter(Boolean)
      .join(", ");

    const sessionLog = window
      .slice(0, 10)
      .map((w) => {
        const ex = (w.exercises || []).map((e) => e.name).join(", ");
        const prs = (w.personal_records || []).join(", ");
        return `${w.date}: ${ex}${prs ? ` [PR:${prs}]` : ""}`;
      })
      .join("\n");

    const latest3Lines = latest3
      .map((w) => {
        const vol = Math.round(w.total_volume_kg || 0);
        const prs = (w.personal_records || []).join(", ");
        return `${w.date}: vol=${vol}kg${prs ? ` PR=${prs}` : ""}`;
      })
      .join("\n");

    const cachedInsight = data.analysis_cache?.insight || "";

    const splitLabel =
      setup.preferred_split && setup.preferred_split !== "none"
        ? setup.preferred_split
        : "unstructured";
    const trainingDays =
      Array.isArray(setup.training_days) && setup.training_days.length > 0
        ? setup.training_days.join(", ")
        : `${setup.days_per_week || 3} days/week`;
    const baselines = setup.baseline_lifts
      ? `bench ${setup.baseline_lifts.bench_press || "?"}kg, squat ${setup.baseline_lifts.squat || "?"}kg, deadlift ${setup.baseline_lifts.deadlift || "?"}kg`
      : "not set";

    return [
      `Goal: ${setup.primary_goal}. Level: ${setup.training_level}. Split: ${splitLabel}. Equipment: ${setup.equipment}. Injuries: ${setup.injury_notes}.`,
      `Training days: ${trainingDays}. Gym time: ${setup.gym_time || setup.reminder_time || "07:00"}.`,
      `Baseline lifts: ${baselines}.`,
      `Last ${ACTION_LOOKBACK_DAYS} days: ${window.length} workouts, streak ${streak}d.`,
      volStatus
        ? `Weekly muscle volume status: ${volStatus}`
        : "No volume data yet.",
      topPRs ? `Recent PRs: ${topPRs}` : "",
      `Latest 3 workouts:\n${latest3Lines || "none"}`,
      cachedInsight ? `Latest insight: ${cachedInsight}` : "",
      `Extended log:\n${sessionLog || "none yet"}`,
    ]
      .filter(Boolean)
      .join("\n");
  } catch (e) {
    console.error("[fitness] buildActionContext:", e);
    return "Context unavailable.";
  }
}

// ════════════════════════════════════════════════════════════════
// ACTIONS v2 — deterministic candidate engine + outcome loop
// ════════════════════════════════════════════════════════════════
// Pipeline:
//   1. computeActionCandidates() — pure JS scoring on workout data
//      Produces ranked candidates with proof + success_criterion
//   2. applyActionFilters() — recency + recovery + diversity guard
//   3. AI writes copy in strict JSON for the top 4 candidates only
//   4. gradeRecentActions() — runs after each /log to grade outcomes
//
// Research basis stored on each action (proof.citation):
//   • Israetel RP 2019         — MEV/MAV/MRV volume landmarks
//   • Schoenfeld 2017 meta     — 10+ sets/muscle/week min
//   • Helms 2019 (MASS)        — 1%/wk strength gain = elite
//   • Mujika & Padilla 2010    — detraining at 10+ days
//   • Schoenfeld 2010 JSCR     — progressive overload primary driver
//   • Zatsiorsky CWX           — planned deload supercompensation
// ════════════════════════════════════════════════════════════════

const TARGET_MUSCLES = ["chest","back","quads","hamstrings","shoulders","biceps","triceps","glutes","calves","abs"];

// ────────────────────────────────────────────────────────────────
// Compute deterministic candidates from raw workout data.
// Returns array of scored candidates: each has archetype, score,
// proof, target, and pre-baked surprise_hook.
// ────────────────────────────────────────────────────────────────
function computeActionCandidates(workouts, setup) {
  const now = Date.now();
  const today = new Date(); today.setHours(0,0,0,0);
  const candidates = [];

  if (!workouts.length) return candidates;

  // Helper: weeks of data we have
  const firstMs = getMillis(workouts[workouts.length - 1].logged_at);
  const weeksSpan = Math.max(1, (now - firstMs) / (7 * 86400000));

  // Per-muscle: total sets, sessions, last_trained, weekly avg
  const lastTrained = {};
  const muscleSets = {};
  const muscleSessions = {};
  for (const w of [...workouts].sort((a,b) => (b.date||"").localeCompare(a.date||""))) {
    const seen = new Set();
    for (const ex of w.exercises || []) {
      const m = ex.muscle_group;
      if (!m || m === "other" || m === "cardio") continue;
      if (!lastTrained[m]) lastTrained[m] = w.date;
      muscleSets[m] = (muscleSets[m] || 0) + (ex.sets?.length || 0);
      seen.add(m);
    }
    for (const m of seen) muscleSessions[m] = (muscleSessions[m] || 0) + 1;
  }

  // Last-7d muscle volume for MEV/MAV/MRV check
  const cutoff7 = now - 7 * 86400000;
  const muscleVol7d = {};
  for (const w of workouts) {
    if (getMillis(w.logged_at) < cutoff7) continue;
    for (const ex of w.exercises || []) {
      const m = ex.muscle_group;
      if (!m || m === "other" || m === "cardio") continue;
      muscleVol7d[m] = (muscleVol7d[m] || 0) + (ex.sets?.length || 0);
    }
  }

  // Last-2-weeks-prior muscle volume (for MRV consecutive check)
  const cutoff14 = now - 14 * 86400000;
  const muscleVolPrev7 = {};
  for (const w of workouts) {
    const ms = getMillis(w.logged_at);
    if (ms < cutoff14 || ms >= cutoff7) continue;
    for (const ex of w.exercises || []) {
      const m = ex.muscle_group;
      if (!m || m === "other" || m === "cardio") continue;
      muscleVolPrev7[m] = (muscleVolPrev7[m] || 0) + (ex.sets?.length || 0);
    }
  }

  // ── (A) WIN_BACK — muscles untrained for ≥7 days ──
  // Source: Mujika & Padilla 2010 — strength loss begins ~10 days
  for (const m of TARGET_MUSCLES) {
    const lastDate = lastTrained[m];
    if (!lastDate) {
      candidates.push({
        archetype: "win_back",
        score: 95,
        category: "strength",
        proof: {
          metric: `${m}_never_trained`,
          value: 0,
          delta: 0,
          threshold: 1,
          citation: "Israetel RP 2019",
        },
        proof_text: `${m} has never been logged. Untrained muscles reach detraining threshold instantly.`,
        surprise_hook: `${m.charAt(0).toUpperCase()+m.slice(1)} is your biggest gap — zero sets logged ever.`,
        target: { muscle: m, sets: 4 },
        success_type: "train_muscle",
        when_to_do: "next_session",
        impact: 3,
      });
      continue;
    }
    const days = Math.floor((today - new Date(lastDate + "T12:00:00")) / 86400000);
    if (days >= 7) {
      const score = Math.min(95, days * 8);
      candidates.push({
        archetype: "win_back",
        score,
        category: "strength",
        proof: {
          metric: `days_since_${m}`,
          value: days,
          delta: 0,
          threshold: 10,
          citation: "Mujika & Padilla 2010",
        },
        proof_text: `${m} not trained in ${days} days. Detraining begins at 10 days (Mujika 2010).`,
        surprise_hook: `Your ${m} hasn't moved in ${days} days — strength decay starts at day 10.`,
        target: { muscle: m, sets: 4 },
        success_type: "train_muscle",
        when_to_do: "next_session",
        impact: days >= 14 ? 3 : 2,
      });
    }
  }

  // ── (B) PREVENT — muscles above MRV (overtraining risk) ──
  // Source: Israetel RP — sustained MRV+ load → injury, plateau
  for (const m of TARGET_MUSCLES) {
    const lm = VOLUME_LANDMARKS[m];
    if (!lm) continue;
    const cur = muscleVol7d[m] || 0;
    if (cur > lm.MRV) {
      const prev = muscleVolPrev7[m] || 0;
      const consecutive = prev > lm.MRV;
      const score = Math.min(95, (cur - lm.MRV) * 10 + (consecutive ? 30 : 0));
      candidates.push({
        archetype: "prevent",
        score,
        category: "recovery",
        proof: {
          metric: `${m}_weekly_sets`,
          value: cur,
          delta: cur - lm.MRV,
          threshold: lm.MRV,
          citation: "Israetel RP 2019",
        },
        proof_text: `${m} at ${cur} sets/wk vs MRV ${lm.MRV} (Israetel RP). ${consecutive ? "2nd consecutive week — deload now." : "Pull back this week."}`,
        surprise_hook: `${m} is ${cur - lm.MRV} sets above your max recoverable volume.`,
        target: { muscle: m, sets: lm.MAV[1] },
        success_type: "reduce_volume",
        when_to_do: "this_week",
        impact: 3,
      });
    }
  }

  // ── (C) BREAKTHROUGH — top lift slope below elite (1kg/wk) ──
  // Source: Helms 2019 (MASS) — 1%/wk strength = elite ceiling for naturals
  const exSeries = {};
  for (const w of workouts) {
    if (!w.date) continue;
    const dayMs = new Date(w.date + "T12:00:00").getTime();
    for (const ex of w.exercises || []) {
      if (!ex.name) continue;
      const k = ex.name.toLowerCase();
      const maxW = Math.max(...(ex.sets || []).map(s => s.weight_kg || 0));
      if (maxW <= 0) continue;
      if (!exSeries[k]) exSeries[k] = { name: ex.name, points: [] };
      exSeries[k].points.push({ t: dayMs, kg: maxW });
    }
  }
  const seriesList = Object.values(exSeries).filter(e => e.points.length >= 3);
  seriesList.sort((a,b) => b.points.length - a.points.length);
  for (const s of seriesList.slice(0, 3)) {
    const pts = s.points.sort((a,b) => a.t - b.t);
    const t0 = pts[0].t;
    const xs = pts.map(p => (p.t - t0) / (7 * 86400000));
    const ys = pts.map(p => p.kg);
    const n = pts.length;
    const meanX = xs.reduce((a,b) => a+b, 0) / n;
    const meanY = ys.reduce((a,b) => a+b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i]-meanX)*(ys[i]-meanY); den += (xs[i]-meanX)**2; }
    const slope = den > 0 ? num / den : 0;
    const baseKg = ys[0];
    const pctPerWk = baseKg > 0 ? (slope / baseKg) * 100 : 0;
    if (pctPerWk < 1.0 && pctPerWk > -2) {
      const lastKg = ys[ys.length - 1];
      const nextTarget = Math.round((lastKg + 2.5) * 2) / 2;
      const score = Math.min(85, Math.round((1.0 - Math.max(0, pctPerWk)) * 80));
      candidates.push({
        archetype: "breakthrough",
        score,
        category: "strength",
        proof: {
          metric: `${s.name}_slope_pct_per_wk`,
          value: round(pctPerWk, 2),
          delta: round(slope, 2),
          threshold: 1.0,
          citation: "Helms 2019 MASS",
        },
        proof_text: `${s.name} progressing ${round(pctPerWk, 2)}%/wk vs elite 1.0%/wk (Helms 2019). Add small weight jumps.`,
        surprise_hook: `${s.name} has been stuck at ${lastKg}kg — push to ${nextTarget}kg next session.`,
        target: { exercise: s.name, weight_kg: nextTarget },
        success_type: "hit_weight",
        when_to_do: "next_session",
        impact: 3,
      });
    }
  }

  // ── (D) PROGRESS — muscle just hit MAV, ready for more ──
  // Source: Schoenfeld 2010 — progressive overload = #1 hypertrophy driver
  for (const m of TARGET_MUSCLES) {
    const lm = VOLUME_LANDMARKS[m];
    if (!lm) continue;
    const cur = muscleVol7d[m] || 0;
    const prev = muscleVolPrev7[m] || 0;
    if (cur >= lm.MAV[0] && cur <= lm.MAV[1] && prev > 0 && cur > prev) {
      const score = 60 + Math.min(20, cur - prev);
      const target = Math.min(lm.MRV - 1, cur + 2);
      candidates.push({
        archetype: "progress",
        score,
        category: "strength",
        proof: {
          metric: `${m}_weekly_sets`,
          value: cur,
          delta: cur - prev,
          threshold: lm.MAV[1],
          citation: "Schoenfeld 2010 JSCR",
        },
        proof_text: `${m} climbed ${prev}→${cur} sets/wk. Add 2 more to push toward MAV ceiling (${lm.MAV[1]}).`,
        surprise_hook: `${m} jumped ${cur - prev} sets last week — ride the momentum.`,
        target: { muscle: m, sets: target },
        success_type: "add_sets",
        when_to_do: "this_week",
        impact: 2,
      });
    }
  }

  // ── (E) RECOVER — 3+ hard days in a row ──
  // Source: Zatsiorsky CWX — planned deload after 4-6 wk hard cycle
  const recentSorted = [...workouts].sort((a,b) => (b.date||"").localeCompare(a.date||"")).slice(0, 5);
  let hardStreak = 0;
  for (const w of recentSorted) {
    if ((w.total_sets || 0) >= 18) hardStreak++;
    else break;
  }
  if (hardStreak >= 3) {
    candidates.push({
      archetype: "recover",
      score: 60 + hardStreak * 10,
      category: "recovery",
      proof: {
        metric: "consecutive_hard_days",
        value: hardStreak,
        delta: 0,
        threshold: 3,
        citation: "Zatsiorsky CWX",
      },
      proof_text: `${hardStreak} consecutive hard sessions (${recentSorted[0]?.total_sets} sets). Schedule a deload day to supercompensate.`,
      surprise_hook: `${hardStreak} hard days back-to-back — your CNS needs a deload.`,
      target: { sets: 0 },
      success_type: "log_session",
      when_to_do: "rest_day",
      impact: 2,
    });
  }

  // ── (F) EXPLORE — many muscles below 5 sets ──
  // Source: Schoenfeld 2017 meta — 10+ sets/wk threshold
  const underTrained = TARGET_MUSCLES.filter(m => (muscleVol7d[m] || 0) < 5).length;
  if (underTrained >= 4) {
    candidates.push({
      archetype: "explore",
      score: 50 + underTrained * 5,
      category: "strength",
      proof: {
        metric: "muscles_below_5_sets",
        value: underTrained,
        delta: 0,
        threshold: 4,
        citation: "Schoenfeld 2017 meta",
      },
      proof_text: `${underTrained} muscle groups under 5 sets/wk — broaden your split for balanced strength.`,
      surprise_hook: `${underTrained} muscles barely touched — your strength is narrow, not deep.`,
      target: { sets: 4 },
      success_type: "train_muscle",
      when_to_do: "this_week",
      impact: 2,
    });
  }

  // ── (G) MICRO actions — quick-wins / habit primers ──
  candidates.push({
    archetype: "micro",
    score: 40,
    category: "technique",
    proof: { metric: "log_warmup_sets", value: 0, delta: 0, threshold: 1, citation: "Strong/Hevy norms" },
    proof_text: "Logging warm-up sets gives the coach better PR projections and recovery estimates.",
    surprise_hook: "Most lifters skip warm-up logs — yours are missing too.",
    target: { sets: 1 },
    success_type: "log_session",
    when_to_do: "next_session",
    impact: 1,
  });

  // Sort by score desc
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

// ────────────────────────────────────────────────────────────────
// Filter candidates: recency, recovery guard, diversity, slot allocation
// Returns: { spotlight, secondaries[2], micro }
// ────────────────────────────────────────────────────────────────
function applyActionFilters(candidates, recentlyHandled, lastTrainedMap) {
  // Recency: skip if same metric proposed in last 21 days
  const recentMetrics = new Set(
    recentlyHandled
      .filter(a => a.generated_at && Date.now() - getMillis(a.generated_at) < 21 * 86400000)
      .map(a => a.proof?.metric)
      .filter(Boolean),
  );
  const filtered = candidates.filter(c => {
    // Recency
    if (recentMetrics.has(c.proof.metric)) return false;
    // Recovery guard — don't suggest training a muscle hit in last 48h
    // (UNLESS it's a recovery action that wants to reduce volume)
    if (c.archetype !== "recover" && c.archetype !== "prevent" && c.target?.muscle) {
      const last = lastTrainedMap[c.target.muscle];
      if (last) {
        const hours = (Date.now() - new Date(last + "T12:00:00").getTime()) / 3600000;
        if (hours < 48 && c.success_type === "train_muscle") return false;
      }
    }
    return true;
  });

  // Diversity: max 1 per archetype in spotlight + secondaries
  const seenArchetype = new Set();
  const slots = [];
  let micro = null;
  for (const c of filtered) {
    if (c.archetype === "micro") { if (!micro) micro = c; continue; }
    if (seenArchetype.has(c.archetype)) continue;
    if (slots.length >= 3) continue;
    seenArchetype.add(c.archetype);
    slots.push(c);
  }
  // Fallback micro if engine didn't produce one
  if (!micro) {
    micro = filtered.find(c => c.archetype === "micro") || candidates.find(c => c.archetype === "micro");
  }
  return {
    spotlight: slots[0] || null,
    secondaries: slots.slice(1, 3),
    micro,
  };
}

// ────────────────────────────────────────────────────────────────
// Outcome grading — runs after each /log
// Marks active actions (status='active') with outcome_grade if their
// success_criterion is met (kept), partially met (partial), or expired
// without progress (abandoned).
// ────────────────────────────────────────────────────────────────
async function gradeRecentActions(deviceId) {
  try {
    const snap = await actionsCol(deviceId)
      .where("status", "in", ["active", "completed"])
      .limit(20)
      .get();
    if (snap.empty) return;

    // Pull last 30 days of workouts for grading
    const wSnap = await workoutsCol(deviceId)
      .orderBy("logged_at", "desc")
      .limit(30)
      .get();
    const workouts = wSnap.docs.map(mapDoc);

    const batch = db().batch();
    const now = Date.now();
    let touched = 0;

    for (const doc of snap.docs) {
      const a = doc.data();
      if (a.outcome_grade) continue; // already graded
      const sc = a.success_criterion;
      if (!sc) continue;
      const generatedMs = getMillis(a.generated_at);
      const expiresMs = getMillis(a.expires_at) || generatedMs + 7 * 86400000;

      // Workouts logged AFTER the action was generated
      const subsequent = workouts.filter(w => getMillis(w.logged_at) > generatedMs);

      let met = false;
      let partial = false;
      let actualValue = 0;

      if (sc.type === "train_muscle" && sc.target?.muscle) {
        for (const w of subsequent) {
          const sets = (w.exercises || [])
            .filter(e => e.muscle_group === sc.target.muscle)
            .reduce((s, e) => s + (e.sets?.length || 0), 0);
          actualValue += sets;
        }
        const required = sc.target.sets || 1;
        met = actualValue >= required;
        partial = !met && actualValue > 0;
      } else if (sc.type === "hit_weight" && sc.target?.exercise) {
        for (const w of subsequent) {
          for (const ex of w.exercises || []) {
            if ((ex.name || "").toLowerCase() === sc.target.exercise.toLowerCase()) {
              const maxW = Math.max(...(ex.sets || []).map(s => s.weight_kg || 0));
              if (maxW > actualValue) actualValue = maxW;
            }
          }
        }
        met = actualValue >= (sc.target.weight_kg || 0);
        partial = !met && actualValue > 0;
      } else if (sc.type === "add_sets" && sc.target?.muscle) {
        for (const w of subsequent) {
          const sets = (w.exercises || [])
            .filter(e => e.muscle_group === sc.target.muscle)
            .reduce((s, e) => s + (e.sets?.length || 0), 0);
          actualValue += sets;
        }
        met = actualValue >= (sc.target.sets || 1);
        partial = !met && actualValue > 0;
      } else if (sc.type === "log_session") {
        met = subsequent.length > 0;
      } else if (sc.type === "reduce_volume" && sc.target?.muscle) {
        // Last 7d after action gen
        const cutoff = generatedMs;
        const setsAfter = subsequent
          .filter(w => getMillis(w.logged_at) >= cutoff)
          .flatMap(w => w.exercises || [])
          .filter(e => e.muscle_group === sc.target.muscle)
          .reduce((s, e) => s + (e.sets?.length || 0), 0);
        actualValue = setsAfter;
        met = setsAfter <= (sc.target.sets || 999);
        partial = !met;
      }

      const expired = now >= expiresMs;
      if (met) {
        batch.update(doc.ref, {
          outcome_grade: "kept",
          outcome_value: actualValue,
          graded_at: admin.firestore.FieldValue.serverTimestamp(),
        });
        touched++;
      } else if (expired && partial) {
        batch.update(doc.ref, {
          outcome_grade: "partial",
          outcome_value: actualValue,
          graded_at: admin.firestore.FieldValue.serverTimestamp(),
        });
        touched++;
      } else if (expired) {
        batch.update(doc.ref, {
          outcome_grade: "abandoned",
          outcome_value: 0,
          graded_at: admin.firestore.FieldValue.serverTimestamp(),
        });
        touched++;
      }
    }
    if (touched > 0) await batch.commit();
  } catch (e) {
    console.error("[fitness] gradeRecentActions:", e);
  }
}

// ----------------------------------------------------------------
// Action generation v2 — candidates → AI for copy → write
// ----------------------------------------------------------------
async function generateActionBatch(
  deviceId,
  { generationKind = "pattern", completedTotalAtGeneration = null } = {},
) {
  const fSnap = await fitnessDoc(deviceId).get();
  if (!fSnap.exists) return [];
  const setup = fSnap.data().setup || {};

  // Pull last 60d of workouts for candidate engine
  const wSnap = await workoutsCol(deviceId)
    .orderBy("logged_at", "desc")
    .limit(150)
    .get();
  const workouts = wSnap.docs.map(mapDoc);

  // last-trained-by-muscle map
  const lastTrainedMap = {};
  for (const w of [...workouts].sort((a,b) => (b.date||"").localeCompare(a.date||""))) {
    for (const ex of w.exercises || []) {
      const m = ex.muscle_group;
      if (m && !lastTrainedMap[m] && m !== "other" && m !== "cardio") lastTrainedMap[m] = w.date;
    }
  }

  // Recently handled actions (last 30 days)
  const recentSnap = await actionsCol(deviceId)
    .orderBy("generated_at", "desc")
    .limit(40)
    .get();
  const recentActions = recentSnap.docs.map(mapDoc);

  // Compute candidates
  const candidates = computeActionCandidates(workouts, setup);
  const slotted = applyActionFilters(candidates, recentActions, lastTrainedMap);

  // ── Build outcome card from most recent graded action ──
  const lastGraded = recentActions.find(a => a.outcome_grade && !a.outcome_surfaced);
  let outcome_card = null;
  if (lastGraded) {
    outcome_card = {
      action_id: lastGraded.id,
      grade: lastGraded.outcome_grade,
      title: lastGraded.title || "",
      promised: lastGraded.success_criterion,
      delivered_value: lastGraded.outcome_value || 0,
      original_proof: lastGraded.proof,
    };
  }

  const batchKey = `${dateStr()}_${Date.now()}`;
  const slots = [slotted.spotlight, ...slotted.secondaries, slotted.micro].filter(Boolean);
  if (slots.length === 0) {
    // No worthwhile actions — write a minimal "you're on track" placeholder
    const noopBatch = db().batch();
    const oldActiveSnap = await actionsCol(deviceId)
      .where("status", "==", "active")
      .limit(20)
      .get();
    for (const d of oldActiveSnap.docs) noopBatch.update(d.ref, { status: "archived" });
    noopBatch.update(fitnessDoc(deviceId), {
      last_action_batch_key: batchKey,
      last_action_batch_generated: admin.firestore.FieldValue.serverTimestamp(),
      pending_action_generation: false,
      no_actions_reason: "All systems green — keep current cadence.",
    });
    await noopBatch.commit();
    invalidateCtx(deviceId);
    return [];
  }

  // ── AI: write copy for each slotted candidate (strict JSON) ──
  const candidateSummary = slots.map((c, i) => {
    const role = i === 0 ? "SPOTLIGHT" : i === slots.length - 1 && c.archetype === "micro" ? "MICRO" : `SECONDARY_${i}`;
    return `[${role}] archetype=${c.archetype}, score=${c.score}, category=${c.category}\n` +
           `  proof_metric=${c.proof.metric}=${c.proof.value} (threshold=${c.proof.threshold}, citation=${c.proof.citation})\n` +
           `  pre_baked_proof=${c.proof_text}\n` +
           `  pre_baked_hook=${c.surprise_hook}\n` +
           `  target=${JSON.stringify(c.target)}, success_type=${c.success_type}, when=${c.when_to_do}`;
  }).join("\n\n");

  const recentlyHandledStr = recentActions
    .filter(a => ["completed","skipped","kept","partial","abandoned"].includes(a.status) || a.outcome_grade)
    .slice(0, 8)
    .map(a => `${a.outcome_grade || a.status}: ${a.title}`)
    .join(" | ");

  const prompt = [
    "You are an elite fitness coach. Write copy for action cards based on PRE-COMPUTED candidates.",
    "DO NOT invent metrics. DO NOT change targets. DO NOT contradict the proof.",
    "Your job: write punchy human copy that hits the AHA moment using the exact data given.",
    "",
    "Output strict JSON:",
    `{ "actions": [`,
    `   { "title": "<≤32 chars verb-first>",`,
    `     "surprise_hook": "<≤80 chars — one surprising stat>",`,
    `     "text": "<≤96 chars — what to do, when, where>",`,
    `     "proof_body": "<≤140 chars — cite exact numbers + research source>",`,
    `     "success_criterion_text": "<≤80 chars — how user knows it's done>",`,
    `     "follow_up": "<≤60 chars — when coach checks in>",`,
    `     "expires_in_days": 3|7|14`,
    `   }, ...`,
    `  ],`,
    `  "weekly_focus": "<≤60 chars — one-line theme tying actions together>"`,
    `}`,
    "",
    "Rules:",
    "• ONE action per slot, in the SAME order as the slots provided below.",
    "• Every proof_body must cite the exact metric value + threshold + citation given.",
    "• Every surprise_hook must be a non-obvious data point.",
    "• No motivational fluff. No generic advice. No cross-agent talk (no sleep/water/mood).",
    `• Avoid repeating phrasing from recently handled: ${recentlyHandledStr || "none"}`,
    "",
    "USER SETUP:",
    `goal=${setup.primary_goal || "general"}, level=${setup.training_level || "beginner"}, split=${setup.preferred_split || "none"}, equipment=${setup.equipment || "full_gym"}, injuries=${setup.injury_notes || "none"}`,
    "",
    "CANDIDATES:",
    candidateSummary,
  ].join("\n");

  let aiActions = [];
  let weeklyFocus = "";
  try {
    const aiRes = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      max_tokens: 900,
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: prompt }],
    });
    const parsed = JSON.parse(aiRes.choices[0].message.content);
    aiActions = Array.isArray(parsed.actions) ? parsed.actions : [];
    weeklyFocus = parsed.weekly_focus || "";
  } catch (e) {
    console.error("[fitness] action copy AI:", e);
    // Fallback: use pre-baked text
    aiActions = slots.map(c => ({
      title: c.surprise_hook.slice(0, 32),
      surprise_hook: c.surprise_hook,
      text: `${c.success_type === "train_muscle" ? `Train ${c.target.muscle}` : c.success_type === "hit_weight" ? `Hit ${c.target.weight_kg}kg on ${c.target.exercise}` : "Take action"} ${c.when_to_do.replace("_", " ")}.`,
      proof_body: c.proof_text,
      success_criterion_text: `Met when criterion satisfied`,
      follow_up: "Coach checks back in 7 days",
      expires_in_days: 7,
    }));
  }

  // ── Persist v2 actions ──
  const writeBatch = db().batch();
  // Archive old active
  const oldActiveSnap = await actionsCol(deviceId)
    .where("status", "==", "active")
    .limit(20)
    .get();
  for (const d of oldActiveSnap.docs) writeBatch.update(d.ref, { status: "archived" });
  // Mark surfaced outcome card so it's not shown twice
  if (outcome_card) {
    const outcomeRef = actionsCol(deviceId).doc(outcome_card.action_id);
    writeBatch.update(outcomeRef, { outcome_surfaced: true });
  }

  for (let i = 0; i < slots.length; i++) {
    const c = slots[i];
    const ai = aiActions[i] || {};
    const role = i === 0 ? "spotlight" : c.archetype === "micro" ? "micro" : "secondary";
    const expiresInDays = ai.expires_in_days || (role === "micro" ? 14 : 7);
    const expiresMs = Date.now() + expiresInDays * 86400000;
    const ref = actionsCol(deviceId).doc();
    writeBatch.set(ref, {
      // legacy fields (for backwards compat with existing UI bits)
      title: (ai.title || c.surprise_hook).slice(0, 32),
      text: (ai.text || "").slice(0, 96),
      why: (ai.proof_body || c.proof_text).slice(0, 140),
      trigger_reason: c.proof.metric,
      when_to_do: c.when_to_do,
      category: c.category,
      priority: i === 0 ? "today" : "next",
      impact: c.impact || 2,
      status: "active",
      batch_key: batchKey,
      batch_kind: generationKind,
      generated_at: admin.firestore.FieldValue.serverTimestamp(),
      completed_total_at_generation: completedTotalAtGeneration,

      // v2 fields
      role,
      archetype: c.archetype,
      score: c.score,
      surprise_hook: ai.surprise_hook || c.surprise_hook,
      proof_body: ai.proof_body || c.proof_text,
      proof: c.proof,
      success_criterion: { type: c.success_type, target: c.target },
      success_criterion_text: ai.success_criterion_text || "",
      follow_up: ai.follow_up || "",
      expires_at: admin.firestore.Timestamp.fromMillis(expiresMs),
      snooze_count: 0,
      outcome_grade: null,
      outcome_value: null,
      outcome_surfaced: false,
    });
  }

  writeBatch.update(fitnessDoc(deviceId), {
    last_action_batch_key: batchKey,
    last_action_batch_generated: admin.firestore.FieldValue.serverTimestamp(),
    last_weekly_focus: weeklyFocus,
    pending_action_generation: false,
    no_actions_reason: null,
  });

  await writeBatch.commit();
  invalidateCtx(deviceId);
  return slots;
}

// ----------------------------------------------------------------
// Queue action batch (fire and forget with duplicate guard)
// ----------------------------------------------------------------
function queueActionBatchGeneration(deviceId, opts = {}) {
  const existing = _actionGenMap.get(deviceId);
  if (existing && Date.now() - existing.startedAt < ACTION_GEN_STALE_MS) return;

  const entry = { startedAt: Date.now() };
  _actionGenMap.set(deviceId, entry);

  fitnessDoc(deviceId)
    .update({ pending_action_generation: true })
    .catch(() => {});

  generateActionBatch(deviceId, opts)
    .then(() => {
      _actionGenMap.delete(deviceId);
      invalidateCtx(deviceId);
    invalidateAnalysisCache(deviceId);
    })
    .catch((err) => {
      console.error("[fitness] queueActionBatchGeneration error:", err);
      _actionGenMap.delete(deviceId);
      fitnessDoc(deviceId)
        .update({ pending_action_generation: false })
        .catch(() => {});
    });
}

// ----------------------------------------------------------------
// Muscle balance (push / pull / legs / core buckets) — last 7d
// ----------------------------------------------------------------
const PUSH_MUSCLES = ["chest", "shoulders", "triceps"];
const PULL_MUSCLES = ["back", "biceps"];
const LEG_MUSCLES  = ["quads", "hamstrings", "glutes", "calves"];
const CORE_MUSCLES = ["abs"];

function calcMuscleBalance(workouts) {
  const sets = { push: 0, pull: 0, legs: 0, core: 0 };
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  const recent = workouts.filter((w) => getMillis(w.logged_at) >= cutoff);
  for (const w of recent) {
    for (const ex of w.exercises || []) {
      const m = ex.muscle_group || "";
      const n = ex.sets?.length || 0;
      if (PUSH_MUSCLES.includes(m)) sets.push += n;
      else if (PULL_MUSCLES.includes(m)) sets.pull += n;
      else if (LEG_MUSCLES.includes(m)) sets.legs += n;
      else if (CORE_MUSCLES.includes(m)) sets.core += n;
    }
  }
  const pushPullRatio = sets.pull > 0 ? round(sets.push / sets.pull, 1) : null;
  const upperLower    = sets.legs > 0  ? round((sets.push + sets.pull) / sets.legs, 1) : null;
  return { sets, push_pull_ratio: pushPullRatio, upper_lower_ratio: upperLower };
}

// ----------------------------------------------------------------
// Observations generator (rule-based, no AI)
// ----------------------------------------------------------------
const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

function generateObservations(allWorkouts, streak, muscleBalance, muscleVol) {
  const obs = [];

  // 1. Muscle group gap (legs / back / chest not trained in 7+ days)
  const lastTrained = {};
  for (const w of [...allWorkouts].sort((a,b)=>(b.date||"").localeCompare(a.date||""))) {
    for (const ex of w.exercises || []) {
      const m = ex.muscle_group;
      if (m && !lastTrained[m]) lastTrained[m] = w.date;
    }
  }
  const checkGaps = [
    { key: ["quads","hamstrings"], label: "legs" },
    { key: ["back"],               label: "back" },
    { key: ["chest"],              label: "chest" },
  ];
  for (const g of checkGaps) {
    const lastDate = g.key.map(k => lastTrained[k]).filter(Boolean).sort().reverse()[0];
    if (!lastDate) continue;
    const days = Math.floor((Date.now() - new Date(lastDate + "T12:00:00").getTime()) / 86400000);
    if (days >= 8) {
      obs.push({ title: `${g.label.charAt(0).toUpperCase()+g.label.slice(1)} day overdue`, body: `You haven't trained ${g.label} in ${days} days. Even 1 session this week will maintain your gains.`, severity: "high" });
      break;
    }
  }

  // 2. Push:pull imbalance
  const pp = muscleBalance.push_pull_ratio;
  if (pp !== null && pp > 1.7) {
    obs.push({ title: "Push:Pull imbalance", body: `Your push volume is ${pp}× your pull this week. Add rows and face pulls to protect your shoulder health long-term.`, severity: "high" });
  } else if (pp !== null && muscleBalance.sets.pull > muscleBalance.sets.push * 1.7) {
    obs.push({ title: "Pull-dominant week", body: `Your pulling volume is outpacing push. Balance with bench, overhead press, or chest flies this week.`, severity: "warning" });
  }

  // 3. Trending exercise (gaining weight session-to-session)
  const exHistory = {};
  for (const w of allWorkouts.slice(0, 20)) {
    for (const ex of w.exercises || []) {
      if (!ex.name || !ex.sets?.length) continue;
      const maxW = Math.max(...ex.sets.map(s => s.weight_kg || 0));
      if (maxW > 0) {
        if (!exHistory[ex.name]) exHistory[ex.name] = [];
        exHistory[ex.name].push({ date: w.date, max: maxW });
      }
    }
  }
  let foundTrend = false;
  for (const [name, sessions] of Object.entries(exHistory)) {
    if (sessions.length < 3 || foundTrend) continue;
    const sorted = sessions.slice().sort((a,b)=>(a.date||"").localeCompare(b.date||"")).slice(-4);
    const gains  = sorted.slice(1).map((s,i) => s.max - sorted[i].max);
    const avgG   = gains.reduce((a,b)=>a+b,0) / gains.length;
    if (avgG >= 2.0) {
      obs.push({ title: `${name} trending 🔥`, body: `You're gaining ${round(avgG,1)}kg/session on ${name}. Keep adding weight every session — this momentum is rare.`, severity: "positive" });
      foundTrend = true;
    }
  }

  // 4. Streak milestone
  if (streak >= 5) {
    obs.push({ title: `${streak}-day streak`, body: `${streak} days in a row. Research shows habits lock in at 66 days — you're building something real.`, severity: "positive" });
  }

  // 5. Below MEV muscle group
  const belowMEV = Object.entries(VOLUME_LANDMARKS)
    .filter(([m, lm]) => (muscleVol[m] || 0) > 0 && (muscleVol[m] || 0) < lm.MEV)
    .sort(([,a],[,b]) => (muscleVol[a.muscle]||0) - (muscleVol[b.muscle]||0))
    .slice(0, 1);
  if (belowMEV.length) {
    const [m, lm] = belowMEV[0];
    const curr = muscleVol[m] || 0;
    obs.push({ title: `${m.charAt(0).toUpperCase()+m.slice(1)} below MEV`, body: `Only ${curr} set${curr!==1?"s":""} this week vs. the ${lm.MEV}-set minimum to stimulate growth. Add ${lm.MEV - curr} set${lm.MEV-curr!==1?"s":""} to cross the threshold.`, severity: "warning" });
  }

  // 6. Best training days
  if (allWorkouts.length >= 6) {
    const freq = {};
    for (const w of allWorkouts) {
      if (!w.date) continue;
      const d = new Date(w.date + "T12:00:00").getDay();
      freq[d] = (freq[d] || 0) + 1;
    }
    const top = Object.entries(freq).sort(([,a],[,b])=>b-a).slice(0,2).map(([d])=>DAY_NAMES[+d]);
    if (top.length >= 2) {
      obs.push({ title: `You train best on ${top[0]}s`, body: `${top[0]} and ${top[1]} are your most consistent training days. Schedule your hardest sessions then for maximum adherence.`, severity: "positive" });
    }
  }

  return obs.slice(0, 5);
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /setup-status
router.get("/setup-status", async (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const snap = await fitnessDoc(deviceId).get();
    if (!snap.exists || !snap.data()?.setup?.primary_goal) {
      return res.json({ setup_completed: false });
    }
    return res.json({ setup_completed: true, setup: snap.data().setup });
  } catch (e) {
    console.error("[fitness] setup-status:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// ----------------------------------------------------------------
// Post-workout debrief (fire-and-forget after /log)
// ----------------------------------------------------------------
// ══════════════════════════════════════════════════════════════
// PROACTIVE CHAT POLICY (strict anti-spam)
// ──────────────────────────────────────────────────────────────
// Rules (all enforced):
//   1. WORKOUT DEBRIEF: NEVER pushed to chat. Generated and stored
//      on the workout doc only — user sees it in Analysis.
//   2. PR celebration: at most 1/day. Only on real PRs.
//   3. Streak milestone: at most 1/day. Only on day 7/14/30/60/100.
//   4. Hard daily cap of 1 proactive chat message across PR + streak.
//   5. Min 12-hour gap between any two proactive messages.
//   6. Race-safe: synchronous in-memory reservation BEFORE any DB
//      write so 3 rapid /log calls can't all slip through.
// ══════════════════════════════════════════════════════════════
const PROACTIVE_DAILY_CAP = 1;
const PROACTIVE_MIN_GAP_MS = 12 * 3600 * 1000;

// In-memory reservation per device — prevents race when several
// /log requests come in back-to-back before Firestore has indexed
// the previous proactive write.
const _proactiveReservations = new Map(); // deviceId → { count, latestMs, day }

function _todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// Try to reserve a proactive slot. Returns true if granted.
// Updates the in-memory ledger atomically (single-threaded JS).
function tryReserveProactiveSlot(deviceId) {
  const day = _todayKey();
  let entry = _proactiveReservations.get(deviceId);
  if (!entry || entry.day !== day) {
    entry = { count: 0, latestMs: 0, day };
    _proactiveReservations.set(deviceId, entry);
  }
  if (entry.count >= PROACTIVE_DAILY_CAP) return false;
  if (entry.latestMs && Date.now() - entry.latestMs < PROACTIVE_MIN_GAP_MS) return false;
  entry.count += 1;
  entry.latestMs = Date.now();
  return true;
}

// Optional double-check against Firestore (for cron processes that
// span server restarts and lose in-memory state).
async function checkProactiveBudgetFromDB(deviceId) {
  try {
    const sinceMs = Date.now() - 24 * 3600 * 1000;
    const snap = await chatsCol(deviceId)
      .where("is_proactive", "==", true)
      .orderBy("created_at", "desc")
      .limit(5)
      .get();
    let todayCount = 0;
    let latestMs = 0;
    for (const doc of snap.docs) {
      const ms = getMillis(doc.data().created_at);
      if (ms >= sinceMs) todayCount++;
      if (ms > latestMs) latestMs = ms;
    }
    const allowed =
      todayCount < PROACTIVE_DAILY_CAP &&
      (latestMs === 0 || Date.now() - latestMs >= PROACTIVE_MIN_GAP_MS);
    return { allowed, todayCount, latestMs };
  } catch {
    return { allowed: true, todayCount: 0, latestMs: 0 };
  }
}

async function generateWorkoutDebrief(deviceId, workoutId, workout) {
  // Generates the AI debrief text and attaches it to the workout doc.
  // NEVER pushes to chat — user sees the debrief inline in Analysis.
  try {
    const context = await buildFitnessContext(deviceId);
    const exerciseNames = (workout.exercises || []).map((e) => e.name).join(", ");
    const prs = workout.personal_records || [];
    const vol = round(workout.total_volume_kg || 0, 0);
    const userMsg = `Just finished: ${exerciseNames}. Volume: ${vol}kg.${prs.length ? ` New PRs: ${prs.join(", ")}.` : ""} Give a 1-2 sentence post-workout insight from my data. Be specific, no filler.`;
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: context },
        { role: "user", content: userMsg },
      ],
      max_tokens: 110,
      temperature: 0.35,
    });
    const debrief = completion.choices[0]?.message?.content?.trim() || "";
    if (!debrief) return;
    await workoutsCol(deviceId).doc(workoutId).update({ debrief });
  } catch {
    /* non-fatal */
  }
}

// POST /setup
router.post("/setup", async (req, res) => {
  const {
    deviceId,
    primary_goal,
    training_level,
    preferred_split,
    training_days,
    gym_time,
    supplements,
    baseline_lifts,
    equipment,
    injury_notes,
    // legacy field kept for backwards compat
    reminder_time,
    days_per_week,
  } = req.body;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const setup = {
      primary_goal: primary_goal || "general",
      training_level: training_level || "beginner",
      preferred_split: preferred_split || "none",
      training_days: Array.isArray(training_days) ? training_days : [],
      gym_time: gym_time || reminder_time || "07:00",
      supplements: Array.isArray(supplements) ? supplements : [],
      baseline_lifts: baseline_lifts || {
        bench_press: 60,
        squat: 80,
        deadlift: 100,
      },
      equipment: equipment || "full_gym",
      injury_notes: injury_notes || "none",
      // keep days_per_week derived from training_days length for legacy reads
      days_per_week:
        Array.isArray(training_days) && training_days.length > 0
          ? training_days.length
          : days_per_week || 3,
    };
    await fitnessDoc(deviceId).set(
      { setup, created_at: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true },
    );
    invalidateCtx(deviceId);
    invalidateAnalysisCache(deviceId);
    queueActionBatchGeneration(deviceId, { generationKind: "setup" });
    return res.json({ success: true });
  } catch (e) {
    console.error("[fitness] setup:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// POST /log — log a workout session
router.post("/log", async (req, res) => {
  const { deviceId, exercises, date } = req.body;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  if (!Array.isArray(exercises) || exercises.length === 0) {
    return res.status(400).json({ error: "exercises array required" });
  }
  try {
    const workoutDate = date || dateStr();

    // Enrich exercises with muscle groups
    const enriched = exercises.map((ex) => ({
      name: ex.name || "Unknown",
      muscle_group: detectMuscleGroup(ex.name),
      sets: (ex.sets || []).map((s) => ({
        reps: parseInt(s.reps, 10) || 0,
        weight_kg: parseFloat(s.weight_kg) || 0,
      })),
    }));

    // Compute total volume
    const totalVolume = enriched.reduce(
      (sum, ex) =>
        sum + ex.sets.reduce((s2, st) => s2 + st.reps * st.weight_kg, 0),
      0,
    );
    const totalSets = enriched.reduce((sum, ex) => sum + ex.sets.length, 0);

    const workoutRef = workoutsCol(deviceId).doc();

    // ONE write — this is the only thing blocking the response
    await workoutRef.set({
      date: workoutDate,
      exercises: enriched,
      total_sets: totalSets,
      total_volume_kg: round(totalVolume, 1),
      personal_records: [],          // filled in by background job
      logged_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Respond immediately — client gets confirmation in ~300ms
    res.json({
      success: true,
      workout_id: workoutRef.id,
      total_volume_kg: round(totalVolume, 1),
    });

    // ── Background work (does NOT block the response) ──────────
    invalidateCtx(deviceId);
    invalidateAnalysisCache(deviceId);
    setImmediate(async () => {
      try {
        const [prs, fSnap, streakSnap] = await Promise.all([
          detectPRs(deviceId, enriched),
          fitnessDoc(deviceId).get(),
          workoutsCol(deviceId).orderBy("logged_at", "desc").limit(60).get(),
        ]);

        const newStreak = computeStreak(streakSnap.docs.map(mapDoc));
        const data = fSnap.data() || {};
        const count = (data.workout_count_since_last_batch || 0) + 1;
        const shouldGenerate = count >= ACTION_BATCH_SIZE;

        const bgBatch = [];

        // Update workout doc with detected PRs
        if (prs.length > 0) {
          bgBatch.push(workoutRef.update({ personal_records: prs }));
        }

        // Update batch counter
        bgBatch.push(
          fitnessDoc(deviceId).update({
            workout_count_since_last_batch: shouldGenerate ? 0 : count,
          }),
        );

        // ── PROACTIVE GATE — at most ONE chat ping per workout ──
        // Priority: PR > streak milestone. Workout debriefs NEVER push.
        const STREAK_MILESTONES = new Set([7, 14, 30, 50, 100]);
        const isStreakMilestone = STREAK_MILESTONES.has(newStreak);
        const hasNoteworthyEvent = prs.length > 0 || isStreakMilestone;

        let chatMessage = null;
        if (hasNoteworthyEvent) {
          // Synchronous reservation — race-safe across rapid /log bursts.
          // Also double-check Firestore in case server restarted.
          const reserved = tryReserveProactiveSlot(deviceId);
          if (reserved) {
            const dbBudget = await checkProactiveBudgetFromDB(deviceId);
            if (dbBudget.allowed) {
              if (prs.length > 0) {
                chatMessage = {
                  content:
                    prs.length === 1
                      ? `🏆 New PR on ${prs[0]}!`
                      : `🏆 New PRs: ${prs.join(", ")}.`,
                  type: "pr_celebration",
                };
              } else {
                chatMessage = {
                  content:
                    newStreak >= 30
                      ? `🏆 ${newStreak}-day streak. Elite consistency.`
                      : `🔥 ${newStreak}-day streak — locked in.`,
                  type: "streak_milestone",
                };
              }
            }
          }
        }

        if (chatMessage) {
          bgBatch.push(
            chatsCol(deviceId).add({
              role: "assistant",
              content: chatMessage.content,
              is_proactive: true,
              proactive_type: chatMessage.type,
              is_read: false,
              created_at: admin.firestore.FieldValue.serverTimestamp(),
            }),
          );
        }

        await Promise.all(bgBatch);

        // Trigger action batch generation if needed (already non-blocking)
        if (shouldGenerate) {
          workoutsCol(deviceId).count().get().then((snap) => {
            queueActionBatchGeneration(deviceId, {
              generationKind: "pattern",
              completedTotalAtGeneration: snap.data().count,
            });
          }).catch(() => {});
        }

        // Grade any active actions whose success_criterion is now met
        // (or whose expires_at has passed). Pure DB-only, no AI call.
        gradeRecentActions(deviceId).catch(() => {});
        // v2 shared engine hook (also grades + queues regeneration)
        _onFitnessLog(deviceId);

        // Workout debrief: text only (attached to workout doc).
        // The function NEVER pushes to chat — user sees it in Analysis tab.
        generateWorkoutDebrief(deviceId, workoutRef.id, {
          exercises: enriched,
          personal_records: prs,
          total_volume_kg: round(totalVolume, 1),
        }).catch(() => {});

      } catch (bgErr) {
        console.error("[fitness] log background:", bgErr);
      }
    });
  } catch (e) {
    console.error("[fitness] log:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// GET /today
router.get("/today", async (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const today = dateStr();

    // Today's workout — no composite index: fetch by date, sort in memory
    const todaySnap = await workoutsCol(deviceId)
      .where("date", "==", today)
      .get();
    const todayDocs = todaySnap.docs.slice().sort((a, b) => {
      const ta = getMillis(a.data().logged_at);
      const tb = getMillis(b.data().logged_at);
      return tb - ta;
    });
    const todayWorkout =
      todayDocs.length === 0
        ? null
        : (() => {
            const d = todayDocs[0].data();
            return {
              exercises: d.exercises || [],
              total_sets: d.total_sets || 0,
              total_volume_kg: d.total_volume_kg || 0,
              personal_records: d.personal_records || [],
            };
          })();

    // Last 30 days calendar
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 29);
    const calSnap = await workoutsCol(deviceId)
      .where("date", ">=", dateStr(cutoff))
      .get();
    const calDates = {};
    for (const d of calSnap.docs) {
      const w = d.data();
      if (!calDates[w.date]) calDates[w.date] = { has_pr: false };
      if ((w.personal_records || []).length > 0) calDates[w.date].has_pr = true;
    }
    const calendarDays = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const ds = dateStr(d);
      calendarDays.push({
        date: ds,
        has_workout: !!calDates[ds],
        has_pr: calDates[ds]?.has_pr || false,
      });
    }

    // Streak + this-week count from 30-day data
    const calWorkouts = calSnap.docs.map(mapDoc);
    const streak = computeStreak(calWorkouts);
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const thisWeekCount = new Set(
      calWorkouts
        .filter((w) => w.date >= dateStr(weekStart))
        .map((w) => w.date),
    ).size;

    // Last session (most recent workout before today)
    const lastSnap = await workoutsCol(deviceId)
      .orderBy("logged_at", "desc")
      .limit(5)
      .get();
    const lastDoc = lastSnap.docs.find((d) => d.data().date !== today);
    const lastSession = lastDoc
      ? (() => {
          const d = lastDoc.data();
          const exs = d.exercises || [];
          return {
            date: d.date,
            muscle_groups: [
              ...new Set(exs.map((e) => e.muscle_group).filter(Boolean)),
            ],
            exercise_count: exs.length,
            total_sets: d.total_sets || 0,
            top_exercise: exs[0]?.name || null,
          };
        })()
      : null;

    // Setup for today's plan hint
    const fDoc = await fitnessDoc(deviceId).get();
    const setup = fDoc.exists ? fDoc.data() : {};
    const todayName = [
      "sunday",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
    ][new Date().getDay()];
    const trainingDays = setup.training_days || [];
    const isTrainingDay =
      trainingDays.length === 0 || trainingDays.includes(todayName);

    return res.json({
      today_workout: todayWorkout,
      calendar_days: calendarDays,
      streak,
      this_week_count: thisWeekCount,
      last_session: lastSession,
      is_training_day: isTrainingDay,
      preferred_split: setup.preferred_split || null,
    });
  } catch (e) {
    console.error("[fitness] today:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// GET /workout-dates — 90-day calendar for the track tab strip
router.get("/workout-dates", async (req, res) => {
  const { deviceId, days = 90 } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const daysN = Math.min(parseInt(days, 10) || 90, 180);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (daysN - 1));
    const snap = await workoutsCol(deviceId)
      .where("date", ">=", dateStr(cutoff))
      .get();
    const dates = {};
    for (const doc of snap.docs) {
      const w = doc.data();
      if (!w.date) continue;
      dates[w.date] = (dates[w.date] || 0) + 1;
    }
    return res.json({ dates });
  } catch (e) {
    console.error("[fitness] workout-dates:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// GET /day — workout data for a specific date (for logging past days)
router.get("/day", async (req, res) => {
  const { deviceId, date } = req.query;
  if (!deviceId || !date)
    return res.status(400).json({ error: "deviceId and date required" });
  try {
    const snap = await workoutsCol(deviceId).where("date", "==", date).get();
    if (snap.empty) return res.json({ workout: null });
    const docs = snap.docs
      .slice()
      .sort(
        (a, b) => getMillis(b.data().logged_at) - getMillis(a.data().logged_at),
      );
    const d = docs[0].data();
    return res.json({
      workout: {
        exercises: d.exercises || [],
        total_sets: d.total_sets || 0,
        total_volume_kg: d.total_volume_kg || 0,
        personal_records: d.personal_records || [],
      },
    });
  } catch (e) {
    console.error("[fitness] day:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// GET /last-session — returns last workout for auto-fill
router.get("/last-session", async (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const snap = await workoutsCol(deviceId)
      .orderBy("logged_at", "desc")
      .limit(1)
      .get();
    if (snap.empty) return res.json({ workout: null });
    const d = snap.docs[0].data();
    return res.json({
      workout: {
        date: d.date,
        exercises: (d.exercises || []).map((ex) => ({
          name: ex.name,
          sets: (ex.sets || []).map((s) => ({
            reps: s.reps,
            weight_kg: s.weight_kg,
          })),
        })),
      },
    });
  } catch (e) {
    console.error("[fitness] last-session:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// POST /check-in — daily readiness self-report (sleep/soreness/energy)
router.post("/check-in", async (req, res) => {
  const { deviceId, sleep_rating, soreness_level, energy_level } = req.body;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const sleepScore = Math.round(((sleep_rating || 3) / 5) * 100);
    const sorenessScore =
      { none: 100, mild: 72, sore: 40, very_sore: 15 }[soreness_level] || 70;
    const energyScore = { low: 25, medium: 65, high: 100 }[energy_level] || 65;
    const combined = Math.round(
      sleepScore * 0.35 + sorenessScore * 0.35 + energyScore * 0.3,
    );
    const recommendation =
      combined >= 80
        ? "You're primed. Go after heavy compounds and PR attempts today."
        : combined >= 65
          ? "Good to train. Moderate intensity, keep form tight."
          : combined >= 45
            ? "Train lighter or accessory work. Honour what your body is saying."
            : "Recovery day. Light movement, mobility, or full rest.";
    const intensity =
      combined >= 80
        ? "hard"
        : combined >= 65
          ? "moderate"
          : combined >= 45
            ? "light"
            : "rest";
    await fitnessDoc(deviceId).update({
      [`check_ins.${dateStr()}`]: {
        sleep_rating,
        soreness_level,
        energy_level,
        score: combined,
        recommendation,
        intensity,
        logged_at: admin.firestore.FieldValue.serverTimestamp(),
      },
    });
    return res.json({ score: combined, recommendation, intensity });
  } catch (e) {
    console.error("[fitness] check-in:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// GET /analysis
//
// Response shape (matches fasting/sleep/mind premium pattern):
//   fitness_score:         { score, label, components: { consistency, volume, progression, intensity } }
//   stats:                 { total_workouts, current_streak, longest_streak, total_sets, total_volume_kg,
//                            avg_weekly_sets, days_logged, prs_count, top_exercise, range_label }
//   signal_points_volume:  [{ date, label, value (sets), volume_kg, had_pr, completed }] — ONE per logged day
//   signal_points_strength:[{ exercise, points: [{ date, label, value (max_kg), sets_count, session_vol }] }]
//   strong_points:         [{ muscle, sets, sessions, label, body, accent, pct_of_total }]
//   weak_points:           [{ muscle, days_since, severity, body }]
//   recent_timeline:       [{ date_str, intensity, muscle_groups, total_sets, total_volume_kg,
//                            had_pr, top_exercise, top_lift_kg, exercises[] }]
//   correlations:          [{ label, percent, accent }]
//   observations:          [{ title, body, accent }]
//   insight, personal_formula, insight_cached_at, range_meta
router.get("/analysis", async (req, res) => {
  const { deviceId, range = "30" } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });

  // Range parsing — supports 7, 30, 90, "all"
  const rangeKey = String(range).toLowerCase();
  const isAll = rangeKey === "all";
  const rangeN = isAll ? 9999 : parseInt(rangeKey, 10) || 30;
  const rangeLabel = isAll ? "ALL" : `${rangeN}D`;

  // 60s response cache + in-flight stampede protection
  const cacheKey = `${deviceId}:${rangeKey}`;
  const cached = _analysisCache.get(cacheKey);
  if (cached && Date.now() - cached.builtAt < ANALYSIS_TTL) {
    return res.json(cached.body);
  }
  const inflight = _analysisLocks.get(cacheKey);
  if (inflight) {
    try { return res.json(await inflight); } catch { /* fall through */ }
  }

  let resolveLock, rejectLock;
  const lockPromise = new Promise((resolve, reject) => { resolveLock = resolve; rejectLock = reject; });
  _analysisLocks.set(cacheKey, lockPromise);

  try {
    const [fSnap, allSnap] = await Promise.all([
      fitnessDoc(deviceId).get(),
      workoutsCol(deviceId).orderBy("logged_at", "desc").limit(500).get(),
    ]);
    const data = fSnap.data() || {};

    const allWorkouts = allSnap.docs.map(mapDoc);
    const cutoffMs = isAll ? 0 : Date.now() - rangeN * 24 * 3600 * 1000;
    const inRange = isAll
      ? allWorkouts.slice()
      : allWorkouts.filter((w) => getMillis(w.logged_at) >= cutoffMs);

    if (allWorkouts.length === 0) {
      return res.json({
        fitness_score: { score: 0, label: "Start", components: { consistency: 0, volume: 0, progression: 0, intensity: 0 } },
        stats: { total_workouts: 0, current_streak: 0, longest_streak: 0, total_sets: 0,
          total_volume_kg: 0, avg_weekly_sets: 0, days_logged: 0, prs_count: 0,
          top_exercise: null, range_label: rangeLabel },
        signal_points_volume: [],
        signal_points_strength: [],
        strong_points: [],
        weak_points: [],
        recent_timeline: [],
        correlations: [],
        observations: [],
        insight: "",
        personal_formula: "",
        insight_cached_at: null,
        range_meta: { label: rangeLabel, days: isAll ? null : rangeN, summary: "Log your first workout" },
      });
    }

    // ── Streaks ──────────────────────────────────────────────
    const currentStreak = computeStreak(allWorkouts);
    const longestStreak = (() => {
      const dates = [...new Set(allWorkouts.map((w) => w.date).filter(Boolean))].sort();
      if (!dates.length) return 0;
      let best = 1, cur = 1;
      for (let i = 1; i < dates.length; i++) {
        const prev = new Date(dates[i - 1]);
        const curD = new Date(dates[i]);
        const diff = Math.round((curD - prev) / 86400000);
        if (diff === 1) { cur++; if (cur > best) best = cur; }
        else cur = 1;
      }
      return best;
    })();

    // ── Stats ────────────────────────────────────────────────
    const uniqueDays = new Set(inRange.map((w) => w.date).filter(Boolean));
    const daysLogged = uniqueDays.size;
    const totalSets = inRange.reduce((s, w) => s + (w.total_sets || 0), 0);
    const totalVolume = inRange.reduce((s, w) => s + (w.total_volume_kg || 0), 0);
    const prsCount = inRange.reduce((s, w) => s + (w.personal_records || []).length, 0);
    const effectiveDays = isAll
      ? Math.max(7, Math.ceil(((Date.now() - getMillis(allWorkouts[allWorkouts.length - 1].logged_at)) / 86400000)))
      : rangeN;
    const avgWeeklySets = effectiveDays >= 7 ? round(totalSets / (effectiveDays / 7), 0) : totalSets;

    // Top exercise (by frequency in range)
    const exCount = {};
    for (const w of inRange) {
      for (const ex of w.exercises || []) {
        if (!ex.name) continue;
        const key = ex.name.toLowerCase();
        exCount[key] = (exCount[key] || 0) + 1;
      }
    }
    const topExerciseEntry = Object.entries(exCount).sort(([, a], [, b]) => b - a)[0];
    const topExercise = topExerciseEntry
      ? (inRange.flatMap((w) => w.exercises || []).find((e) => e.name?.toLowerCase() === topExerciseEntry[0])?.name || null)
      : null;

    // ════════════════════════════════════════════════════════════
    // FITNESS SCORE — 4 research-backed components (0-100 each)
    // ════════════════════════════════════════════════════════════

    // Sorted ASC dates for gap math
    const sortedDates = [...uniqueDays].sort();
    const targetDaysPerWeek = (data.setup?.training_days?.length) || (data.setup?.days_per_week) || 3;
    const expectedDays = Math.max(1, Math.round((effectiveDays / 7) * targetDaysPerWeek));
    const targetGapDays = 7 / targetDaysPerWeek;

    // ── (1) CONSISTENCY (35%) — adherence × gap-distribution penalty ──
    // Source: Mujika & Padilla 2010 "Detraining" — gap variance > mean kills adherence.
    // Formula: adherence × (1 - clamp(CV, 0, 1)) where CV = stdDev(gaps)/mean(gaps).
    // A user logging Mon/Wed/Fri scores 100. Same total spread chaotically scores 30.
    const consistencyScore = (() => {
      if (sortedDates.length === 0) return 0;
      const adherence = Math.min(1, daysLogged / expectedDays); // 0..1
      if (sortedDates.length < 2) return Math.round(adherence * 100);
      const gaps = [];
      for (let i = 1; i < sortedDates.length; i++) {
        const a = new Date(sortedDates[i - 1] + "T12:00:00");
        const b = new Date(sortedDates[i] + "T12:00:00");
        gaps.push(Math.max(1, Math.round((b - a) / 86400000)));
      }
      const meanGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
      const variance = gaps.reduce((s, g) => s + (g - meanGap) ** 2, 0) / gaps.length;
      const stdGap = Math.sqrt(variance);
      const cv = meanGap > 0 ? stdGap / meanGap : 1;
      // Reward gaps near target; penalize chaos
      const gapDistributionFactor = Math.max(0, 1 - Math.min(1, cv));
      // Penalize avg gap drift from target (e.g. target 2.3 days, actual 6 = bad)
      const gapTargetFactor = Math.max(0, 1 - Math.min(1, Math.abs(meanGap - targetGapDays) / Math.max(targetGapDays, 1)));
      const blended = (gapDistributionFactor * 0.6 + gapTargetFactor * 0.4);
      return Math.round(adherence * blended * 100);
    })();

    // ── (2) VOLUME (25%) — % of muscle-groups in MAV band (Renaissance Periodization) ──
    // Source: Israetel et al. 2019. MEV = minimum effective volume, MAV = optimal range, MRV = max recoverable.
    // Each muscle scores: 0 below MEV, 100 at MAV midpoint, ramps down past MRV.
    const volumeScore = (() => {
      // Compute weekly volume per muscle averaged over (effectiveDays / 7) weeks
      const weeks = Math.max(1, effectiveDays / 7);
      const muscleVolPerWeek = {};
      for (const w of inRange) {
        for (const ex of w.exercises || []) {
          const m = ex.muscle_group;
          if (!m || m === "other" || m === "cardio") continue;
          muscleVolPerWeek[m] = (muscleVolPerWeek[m] || 0) + (ex.sets?.length || 0);
        }
      }
      const muscleScores = [];
      for (const [m, lm] of Object.entries(VOLUME_LANDMARKS)) {
        const wkSets = (muscleVolPerWeek[m] || 0) / weeks;
        if (wkSets === 0) continue;
        const mavMid = (lm.MAV[0] + lm.MAV[1]) / 2;
        let score;
        if (wkSets < lm.MEV) {
          score = (wkSets / lm.MEV) * 50; // 0..50 below MEV
        } else if (wkSets <= lm.MAV[1]) {
          // ramp from 50 (at MEV) → 100 (at MAV mid) → 90 (at MAV high)
          if (wkSets <= mavMid) score = 50 + ((wkSets - lm.MEV) / (mavMid - lm.MEV)) * 50;
          else score = 100 - ((wkSets - mavMid) / (lm.MAV[1] - mavMid)) * 10;
        } else if (wkSets <= lm.MRV) {
          score = 90 - ((wkSets - lm.MAV[1]) / (lm.MRV - lm.MAV[1])) * 30; // 90→60
        } else {
          score = Math.max(20, 60 - (wkSets - lm.MRV) * 4); // overtraining penalty
        }
        muscleScores.push(score);
      }
      if (!muscleScores.length) return 0;
      // Penalize narrow training: untrained muscles drag score down
      const trainedCount = muscleScores.length;
      const muscleAvg = muscleScores.reduce((a, b) => a + b, 0) / trainedCount;
      const breadthBonus = Math.min(1, trainedCount / 6); // 6 muscle groups = full credit
      return Math.round(muscleAvg * breadthBonus);
    })();

    // ── (3) PROGRESSION (25%) — linear regression slope on top 3 lifts ──
    // Source: Schoenfeld 2010 J Strength Cond Res — slope is the only honest metric (PRs are gameable).
    // We fit kg-per-week slope on each top lift's max-weight series and average.
    const progressionScore = (() => {
      if (inRange.length < 3) return Math.min(40, inRange.length * 12);
      // Build per-exercise time series (date → max kg)
      const exSeries = {};
      for (const w of inRange) {
        if (!w.date) continue;
        const dayMs = new Date(w.date + "T12:00:00").getTime();
        for (const ex of w.exercises || []) {
          if (!ex.name) continue;
          const key = ex.name.toLowerCase();
          const maxW = Math.max(...(ex.sets || []).map((s) => s.weight_kg || 0));
          if (maxW <= 0) continue;
          if (!exSeries[key]) exSeries[key] = { name: ex.name, points: [] };
          exSeries[key].points.push({ t: dayMs, kg: maxW });
        }
      }
      const series = Object.values(exSeries).filter((s) => s.points.length >= 3);
      if (!series.length) return 20;
      series.sort((a, b) => b.points.length - a.points.length);
      const top = series.slice(0, 3);
      let totalKgPerWeek = 0;
      let validLifts = 0;
      for (const s of top) {
        const pts = s.points.sort((a, b) => a.t - b.t);
        // Simple linear regression y = mx + b (x in weeks since first point)
        const t0 = pts[0].t;
        const xs = pts.map((p) => (p.t - t0) / (7 * 86400000));
        const ys = pts.map((p) => p.kg);
        const n = pts.length;
        const meanX = xs.reduce((a, b) => a + b, 0) / n;
        const meanY = ys.reduce((a, b) => a + b, 0) / n;
        let num = 0, den = 0;
        for (let i = 0; i < n; i++) { num += (xs[i] - meanX) * (ys[i] - meanY); den += (xs[i] - meanX) ** 2; }
        const slope = den > 0 ? num / den : 0; // kg per week
        // Normalize against starting weight: 1% per week = 100, 0% = 50, negative = below 50
        const baseKg = ys[0] || 1;
        const pctPerWk = (slope / baseKg) * 100;
        // 1% / week = elite progression for natural lifters (Helms 2019)
        const liftScore = clamp(50 + pctPerWk * 50, 0, 100);
        totalKgPerWeek += liftScore;
        validLifts++;
      }
      return validLifts ? Math.round(totalKgPerWeek / validLifts) : 30;
    })();

    // ── (4) INTENSITY (15%) — weekly stimulus vs hypertrophy threshold ──
    // Source: Schoenfeld meta 2017 — 10+ sets/muscle/week minimum for hypertrophy.
    // Score = (avgWeeklyTotalSets / 36) where 36 = 6 muscles × 6 sets minimum baseline.
    const intensityScore = (() => {
      if (effectiveDays < 1) return 0;
      const wkSets = totalSets / Math.max(1, effectiveDays / 7);
      if (wkSets === 0) return 0;
      // Sweet spot: 30-60 sets/week. Below = under-stimulus. Above = overtraining.
      if (wkSets >= 30 && wkSets <= 60) return 100;
      if (wkSets < 30) return Math.round((wkSets / 30) * 100);
      // Above 60 = penalty (recovery limits per Israetel)
      return Math.max(40, Math.round(100 - (wkSets - 60) * 1.5));
    })();

    const fitness_score_value = Math.round(
      consistencyScore * 0.35 + volumeScore * 0.25 + progressionScore * 0.25 + intensityScore * 0.15
    );
    const scoreLabel =
      fitness_score_value >= 85 ? "Elite" :
      fitness_score_value >= 70 ? "Strong" :
      fitness_score_value >= 50 ? "Building" :
      fitness_score_value >= 25 ? "Starting" : "Begin";

    const fitness_score = {
      score: fitness_score_value,
      label: scoreLabel,
      components: {
        consistency: consistencyScore,
        volume: volumeScore,
        progression: progressionScore,
        intensity: intensityScore,
      },
    };

    // ── Signal Points Volume — one point per CALENDAR DAY in range ──
    // Logged days: { value: sets, completed: true, ...gap-aware metadata }
    // Rest/missed days: { value: 0, completed: false } — rendered as dim dot
    // For ALL range, we cap window so chart stays sane: from first log → today
    const dayMap = {};
    for (const w of inRange) {
      if (!w.date) continue;
      const e = dayMap[w.date] || { date: w.date, sets: 0, volume: 0, had_pr: false, muscles: new Set() };
      e.sets += w.total_sets || 0;
      e.volume += w.total_volume_kg || 0;
      e.had_pr = e.had_pr || (w.personal_records || []).length > 0;
      for (const ex of w.exercises || []) if (ex.muscle_group) e.muscles.add(ex.muscle_group);
      dayMap[w.date] = e;
    }

    // Median sets across LOGGED days — used to classify lag vs spike
    const loggedSetsValues = Object.values(dayMap).map((d) => d.sets).sort((a, b) => a - b);
    const median = loggedSetsValues.length
      ? loggedSetsValues.length % 2
        ? loggedSetsValues[(loggedSetsValues.length - 1) / 2]
        : (loggedSetsValues[loggedSetsValues.length / 2 - 1] + loggedSetsValues[loggedSetsValues.length / 2]) / 2
      : 0;

    const DOW_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

    // Build calendar window
    const todayMid = new Date(); todayMid.setHours(12, 0, 0, 0);
    let windowStart;
    if (isAll) {
      // ALL: from first ever log → today (capped at 180 days for chart sanity)
      const firstLogged = Object.keys(dayMap).sort()[0];
      windowStart = firstLogged ? new Date(firstLogged + "T12:00:00") : todayMid;
      const daysSpan = Math.ceil((todayMid - windowStart) / 86400000) + 1;
      if (daysSpan > 180) {
        windowStart = new Date(todayMid.getTime() - 179 * 86400000);
      }
    } else {
      windowStart = new Date(todayMid.getTime() - (rangeN - 1) * 86400000);
    }

    const totalDays = Math.max(1, Math.ceil((todayMid - windowStart) / 86400000) + 1);
    let lastLoggedDate = null;
    const signal_points_volume_full = [];
    for (let i = 0; i < totalDays; i++) {
      const dt = new Date(windowStart.getTime() + i * 86400000);
      const dKey = dt.toISOString().slice(0, 10);
      const monthShort = dt.toLocaleDateString("en", { month: "short" });
      const logged = dayMap[dKey];
      const gapDays = lastLoggedDate
        ? Math.max(1, Math.round((dt - new Date(lastLoggedDate + "T12:00:00")) / 86400000))
        : 0;
      if (logged) {
        let band = "normal";
        if (median > 0) {
          if (logged.sets >= median * 1.5) band = "spike";
          else if (logged.sets <= median * 0.5) band = "lag";
        }
        signal_points_volume_full.push({
          date: dKey,
          label: `${monthShort} ${dt.getDate()}`,
          value: logged.sets,
          volume_kg: round(logged.volume, 0),
          had_pr: logged.had_pr,
          completed: true,
          gap_before_days: gapDays,
          is_after_long_gap: gapDays >= 7,
          day_of_week: DOW_NAMES[dt.getDay()],
          intensity_band: band,
          muscle_groups: [...logged.muscles],
        });
        lastLoggedDate = dKey;
      } else {
        signal_points_volume_full.push({
          date: dKey,
          label: `${monthShort} ${dt.getDate()}`,
          value: 0,
          volume_kg: 0,
          had_pr: false,
          completed: false,
          gap_before_days: 0,
          is_after_long_gap: false,
          day_of_week: DOW_NAMES[dt.getDay()],
          intensity_band: "rest",
          muscle_groups: [],
        });
      }
    }

    // Downsample if too many points (keeps the chart readable + fast)
    const MAX_POINTS = 90;
    let signal_points_volume;
    if (signal_points_volume_full.length <= MAX_POINTS) {
      signal_points_volume = signal_points_volume_full;
    } else {
      // Bucket-merge consecutive days; preserve completed days inside each bucket
      const bucketSize = Math.ceil(signal_points_volume_full.length / MAX_POINTS);
      signal_points_volume = [];
      for (let i = 0; i < signal_points_volume_full.length; i += bucketSize) {
        const slice = signal_points_volume_full.slice(i, i + bucketSize);
        const trained = slice.filter((p) => p.completed);
        if (trained.length === 0) {
          // pure rest bucket — represent as one rest day
          const mid = slice[Math.floor(slice.length / 2)];
          signal_points_volume.push({ ...mid, label: mid.label });
        } else {
          // merge logged days (sum sets/volume)
          const sets = trained.reduce((s, p) => s + p.value, 0);
          const vol = trained.reduce((s, p) => s + p.volume_kg, 0);
          const muscles = [...new Set(trained.flatMap((p) => p.muscle_groups))];
          const had_pr = trained.some((p) => p.had_pr);
          const last = trained[trained.length - 1];
          signal_points_volume.push({
            ...last,
            value: sets,
            volume_kg: vol,
            muscle_groups: muscles,
            had_pr,
          });
        }
      }
    }

    const median_sets = median;

    // ── Signal Points Strength — top 3 exercises with weight progression ──
    const exFreq = {};
    for (const w of inRange) {
      for (const ex of w.exercises || []) {
        if (!ex.name) continue;
        const key = ex.name.toLowerCase();
        if (!exFreq[key]) exFreq[key] = { name: ex.name, count: 0, sessions: [] };
        exFreq[key].count++;
        const maxW = Math.max(...(ex.sets || []).map((s) => s.weight_kg || 0));
        if (maxW > 0) {
          exFreq[key].sessions.push({
            date: w.date,
            max: maxW,
            sets_count: (ex.sets || []).length,
            session_vol: Math.round((ex.sets || []).reduce((a, s) => a + (s.weight_kg || 0) * (s.reps || 0), 0)),
          });
        }
      }
    }
    const topStrengthExs = Object.values(exFreq)
      .filter((e) => e.sessions.length >= 2)
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
    const signal_points_strength = topStrengthExs.map((ex) => {
      const sorted = [...ex.sessions].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      return {
        exercise: ex.name,
        points: sorted.map((s) => {
          const dt = new Date(s.date);
          const monthShort = dt.toLocaleDateString("en", { month: "short" });
          return {
            date: s.date,
            label: `${monthShort} ${dt.getDate()}`,
            value: round(s.max, 1),
            sets_count: s.sets_count,
            session_vol: s.session_vol,
          };
        }),
      };
    });

    // ── Strong Points — top 3 muscle groups by sets in range ──
    const muscleSetsInRange = {};
    const muscleSessionsInRange = {};
    for (const w of inRange) {
      const muscleSet = new Set();
      for (const ex of w.exercises || []) {
        const m = ex.muscle_group;
        if (!m || m === "other" || m === "cardio") continue;
        muscleSetsInRange[m] = (muscleSetsInRange[m] || 0) + (ex.sets?.length || 0);
        muscleSet.add(m);
      }
      for (const m of muscleSet) {
        muscleSessionsInRange[m] = (muscleSessionsInRange[m] || 0) + 1;
      }
    }
    const totalMuscleSets = Object.values(muscleSetsInRange).reduce((a, b) => a + b, 0) || 1;
    const muscleEntries = Object.entries(muscleSetsInRange)
      .map(([muscle, sets]) => ({
        muscle,
        sets,
        sessions: muscleSessionsInRange[muscle] || 0,
        pct_of_total: Math.round((sets / totalMuscleSets) * 100),
      }))
      .sort((a, b) => b.sets - a.sets);

    const strong_points = muscleEntries.slice(0, 3).map((e, i) => {
      const accent = i === 0 ? "green" : i === 1 ? "blue" : "purple";
      const label = i === 0 ? "DOMINANT" : i === 1 ? "STRONG" : "ACTIVE";
      const body = `${e.sets} sets across ${e.sessions} session${e.sessions !== 1 ? "s" : ""} — ${e.pct_of_total}% of your total volume.`;
      return { muscle: e.muscle, sets: e.sets, sessions: e.sessions, label, body, accent, pct_of_total: e.pct_of_total };
    });

    // ── Weak Points — muscles not trained in 7+ days OR below MEV ──
    const lastTrainedMap = {};
    for (const w of [...allWorkouts].sort((a, b) => (b.date || "").localeCompare(a.date || ""))) {
      for (const ex of w.exercises || []) {
        const m = ex.muscle_group;
        if (m && !lastTrainedMap[m] && m !== "other" && m !== "cardio") lastTrainedMap[m] = w.date;
      }
    }
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const importantMuscles = ["chest", "back", "quads", "hamstrings", "shoulders", "biceps", "triceps", "glutes", "calves", "abs"];
    const weak_points = importantMuscles
      .map((m) => {
        const lastDate = lastTrainedMap[m];
        if (!lastDate) {
          return {
            muscle: m,
            days_since: 999,
            severity: "high",
            body: `Never logged. Add ${m} work to build a complete physique.`,
          };
        }
        const lastDt = new Date(lastDate + "T12:00:00");
        const days = Math.floor((today - lastDt) / 86400000);
        if (days < 7) return null;
        const severity = days >= 14 ? "high" : "warning";
        return {
          muscle: m,
          days_since: days,
          severity,
          body: `Not trained in ${days} days. ${days >= 14 ? "Major loss in stimulus — research shows muscle protein synthesis drops after 10 days." : "One session this week locks in your current gains."}`,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.days_since - a.days_since)
      .slice(0, 3);

    // ── Muscle Grid — 8-tile drill-down summary ──
    // Each tile: muscle, sets in range, sessions, % change vs prior period,
    // last_trained, status vs MEV/MAV/MRV. Tap tile → opens MuscleDetailSheet.
    const muscle_grid = (() => {
      const TARGET = ["chest", "back", "quads", "hamstrings", "shoulders", "biceps", "triceps", "glutes"];
      // Prior period — same length immediately before current range
      const priorEnd   = isAll ? 0 : Date.now() - rangeN * 24 * 3600 * 1000;
      const priorStart = isAll ? 0 : Date.now() - rangeN * 2 * 24 * 3600 * 1000;
      const priorWindow = isAll ? [] : allWorkouts.filter((w) => {
        const t = getMillis(w.logged_at);
        return t >= priorStart && t < priorEnd;
      });
      const setsForWindow = (window) => {
        const out = {};
        for (const w of window) {
          for (const ex of w.exercises || []) {
            const m = ex.muscle_group;
            if (!m || m === "other" || m === "cardio") continue;
            out[m] = (out[m] || 0) + (ex.sets?.length || 0);
          }
        }
        return out;
      };
      const cur = setsForWindow(inRange);
      const prev = setsForWindow(priorWindow);
      const weeks = Math.max(1, effectiveDays / 7);
      return TARGET.map((m) => {
        const sets = cur[m] || 0;
        const prevSets = prev[m] || 0;
        const sessions = (() => {
          let n = 0;
          for (const w of inRange) {
            if ((w.exercises || []).some((e) => e.muscle_group === m)) n++;
          }
          return n;
        })();
        const wkSets = sets / weeks;
        const lm = VOLUME_LANDMARKS[m];
        let status = "untrained";
        if (sets > 0) {
          if (!lm) status = "active";
          else if (wkSets < lm.MEV) status = "below_mev";
          else if (wkSets <= lm.MAV[1]) status = "in_mav";
          else if (wkSets <= lm.MRV) status = "above_mav";
          else status = "above_mrv";
        }
        const deltaPct = prevSets > 0
          ? Math.round(((sets - prevSets) / prevSets) * 100)
          : sets > 0 && !isAll ? 100 : null;
        const lastDate = lastTrainedMap[m] || null;
        const daysSince = lastDate
          ? Math.floor((today - new Date(lastDate + "T12:00:00")) / 86400000)
          : null;
        return {
          muscle: m,
          sets,
          sessions,
          weekly_sets: round(wkSets, 1),
          status,
          delta_pct: deltaPct,
          last_trained: lastDate,
          days_since: daysSince,
        };
      });
    })();

    // ── Recent Timeline (last 10 sessions) ──
    const recent_timeline = allWorkouts.slice(0, 10).map((w) => {
      const sets = w.total_sets || 0;
      const intensity = sets >= 20 ? "hard" : sets >= 10 ? "moderate" : "light";
      const muscleGroups = [...new Set((w.exercises || []).map((e) => e.muscle_group).filter(Boolean))];
      const exs = (w.exercises || []).slice(0, 6).map((e) => ({
        name: e.name,
        sets: e.sets?.length || 0,
        max_weight_kg: Math.max(0, ...(e.sets || []).map((s) => s.weight_kg || 0)),
      }));
      const topEx = exs.reduce((best, e) => (e.max_weight_kg > (best?.max_weight_kg || 0) ? e : best), null);
      return {
        date_str: w.date,
        intensity,
        muscle_groups: muscleGroups,
        total_sets: sets,
        total_volume_kg: round(w.total_volume_kg || 0, 0),
        had_pr: (w.personal_records || []).length > 0,
        top_exercise: topEx?.name || null,
        top_lift_kg: topEx?.max_weight_kg || 0,
        exercises: exs,
      };
    });

    // ── Correlations — what drives your PRs (premium pattern insights) ──
    const correlations = (() => {
      const out = [];
      // 1. Best day of week
      if (allWorkouts.length >= 6) {
        const dayMap2 = {};
        const dayPRs = {};
        for (const w of allWorkouts) {
          if (!w.date) continue;
          const dow = new Date(w.date + "T12:00:00").getDay();
          dayMap2[dow] = (dayMap2[dow] || 0) + 1;
          if ((w.personal_records || []).length > 0) dayPRs[dow] = (dayPRs[dow] || 0) + 1;
        }
        const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const bestDow = Object.entries(dayMap2).sort(([, a], [, b]) => b - a)[0];
        if (bestDow) {
          const dow = +bestDow[0];
          const pct = Math.round((bestDow[1] / allWorkouts.length) * 100);
          out.push({
            label: `${dayNames[dow]} sessions`,
            percent: pct,
            accent: "amber",
            detail: `${bestDow[1]} workouts — your most consistent day`,
          });
        }
      }

      // 2. Top exercise PR rate
      if (topStrengthExs.length > 0) {
        const top = topStrengthExs[0];
        const sessions = top.sessions.length;
        const gains = top.sessions.length >= 2
          ? top.sessions[top.sessions.length - 1].max - top.sessions[0].max
          : 0;
        if (gains > 0) {
          const pct = Math.min(100, Math.round((gains / Math.max(top.sessions[0].max, 1)) * 100));
          out.push({
            label: `${top.name} growth`,
            percent: pct,
            accent: "green",
            detail: `+${round(gains, 1)}kg over ${sessions} sessions`,
          });
        }
      }

      // 3. Set density (avg sets/session as % of optimal 12)
      if (inRange.length > 0) {
        const avgSetsPerWorkout = totalSets / inRange.length;
        const setDensity = Math.min(100, Math.round((avgSetsPerWorkout / 12) * 100));
        out.push({
          label: "Set density",
          percent: setDensity,
          accent: setDensity >= 80 ? "green" : setDensity >= 50 ? "amber" : "red",
          detail: `${round(avgSetsPerWorkout, 1)} sets/session avg`,
        });
      }

      // 4. Muscle balance — how spread your training is
      if (muscleEntries.length > 0) {
        const top3 = muscleEntries.slice(0, 3).reduce((s, e) => s + e.sets, 0);
        const balance = totalMuscleSets > 0 ? Math.round(((totalMuscleSets - top3) / totalMuscleSets) * 100 + 30) : 0;
        out.push({
          label: "Training spread",
          percent: clamp(balance, 0, 100),
          accent: balance >= 50 ? "green" : "amber",
          detail: `${muscleEntries.length} muscles trained`,
        });
      }

      // 5. PR frequency
      if (inRange.length >= 3) {
        const prRate = Math.round((prsCount / inRange.length) * 100);
        out.push({
          label: "PR frequency",
          percent: Math.min(100, prRate * 3),
          accent: prRate >= 20 ? "green" : prRate >= 10 ? "amber" : "purple",
          detail: `${prsCount} PR${prsCount !== 1 ? "s" : ""} in ${inRange.length} workouts`,
        });
      }

      return out.slice(0, 5);
    })();

    // ── Observations ────────────────────────────────────────
    const muscleVol7d = calcVolumeByMuscle(allWorkouts);
    const muscleBalance = calcMuscleBalance(allWorkouts);
    const observations = generateObservations(allWorkouts, currentStreak, muscleBalance, muscleVol7d);

    // ── AI Insight (24h cache) — STRUCTURED 5-CARD OUTPUT ──────
    // Schema:
    //   insights[]: { type, icon, title, body }
    //     types: 'win' | 'gap' | 'pattern' | 'risk' | 'pr'
    //   next_session: { recommendation, reason, target_sets }
    //   formula: <one-sentence personal rule>
    let insight = "";
    let formula = "";
    let insightCachedAt = null;
    let insight_cards = [];
    let next_session = null;
    try {
      const cachedInsight = data.analysis_cache;
      const cachedMs = getMillis(cachedInsight?.cached_at);
      const cacheValid = cachedInsight?.insight && (Date.now() - cachedMs) < 24 * 3600 * 1000;
      if (cacheValid) {
        insight = cachedInsight.insight || "";
        formula = cachedInsight.formula || "";
        insight_cards = cachedInsight.insight_cards || [];
        next_session = cachedInsight.next_session || null;
        insightCachedAt = cachedMs ? new Date(cachedMs).toISOString() : null;
      } else if (inRange.length >= 2) {
        // Build a richer context with actual gap data + per-muscle status
        const ctx = await buildActionContext(deviceId);
        const gapStats = (() => {
          if (sortedDates.length < 2) return "no gaps yet";
          const gaps = [];
          for (let i = 1; i < sortedDates.length; i++) {
            const a = new Date(sortedDates[i - 1] + "T12:00:00");
            const b = new Date(sortedDates[i] + "T12:00:00");
            gaps.push(Math.round((b - a) / 86400000));
          }
          const longGaps = gaps.filter((g) => g >= 7);
          return `gaps days=[${gaps.join(",")}], longest=${Math.max(...gaps)}d, ${longGaps.length} gap(s) ≥7 days`;
        })();
        const muscleSummary = muscle_grid
          .filter((m) => m.sets > 0)
          .map((m) => `${m.muscle}:${m.sets}sets/${m.sessions}sess(${m.weekly_sets}wk,${m.status}${m.delta_pct !== null ? `,${m.delta_pct >= 0 ? "+" : ""}${m.delta_pct}%vs.prior` : ""})`)
          .join(", ");
        const scoreDetail = `score=${fitness_score_value}/100 (consistency=${consistencyScore}, volume=${volumeScore}, progression=${progressionScore}, intensity=${intensityScore})`;

        const enrichedCtx = `${ctx}\n\nRange=${rangeLabel}, ${inRange.length} workouts, ${daysLogged} unique days.\n${scoreDetail}\nGap analysis: ${gapStats}\nMuscle grid: ${muscleSummary || "none"}`;

        const aiRes = await openai.chat.completions.create({
          model: "gpt-4.1-mini",
          max_tokens: 700,
          temperature: 0.35,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "You are an elite, blunt, data-driven strength coach writing for a PREMIUM app. " +
                "Output STRICT JSON — no prose. Every field cites exact numbers from the user's data.\n\n" +
                "Schema:\n" +
                "{\n" +
                '  "insights": [\n' +
                '    { "type": "win"|"gap"|"pattern"|"risk"|"pr", "icon": "<emoji>", "title": "<≤40 chars>", "body": "<1 sentence with exact numbers>" }\n' +
                "  ],\n" +
                '  "next_session": { "recommendation": "<≤30 chars>", "reason": "<1 sentence with numbers>", "target_sets": <int> },\n' +
                '  "formula": "<1 sentence personal rule, must reference at least one specific exercise/muscle/day>"\n' +
                "}\n\n" +
                "Rules:\n" +
                "• Generate EXACTLY 5 insights, one of each type when possible (win, gap, pattern, risk, pr). If no gap exists, use 'pattern'. If no PR, use 'pattern'.\n" +
                "• Every body MUST cite an exact number from the data (kg, sets, days, %, count).\n" +
                "• 'gap' type = call out specific date ranges where they missed days (e.g. 'You skipped Feb 5–Mar 1, 24 days off').\n" +
                "• 'win' type = highest impact strength gain or adherence stat.\n" +
                "• 'pattern' type = day-of-week / muscle-group cadence with numbers.\n" +
                "• 'risk' type = MEV undertrained or MRV overtrained muscles, cite the threshold.\n" +
                "• 'pr' type = exact lift, weight delta, sessions count.\n" +
                "• next_session MUST be specific (e.g. 'Pull day' not 'do something').\n" +
                "• formula MUST be specific (e.g. 'Your squat peaks Tuesdays after a Friday rest').\n" +
                "• NO motivational fluff. NO generic advice. NO cross-agent talk (no sleep/water/mood). Strictly fitness data.",
            },
            { role: "user", content: enrichedCtx },
          ],
        });
        const raw = aiRes.choices[0].message.content.trim();
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = {}; }
        insight_cards = Array.isArray(parsed.insights) ? parsed.insights.slice(0, 5) : [];
        next_session = parsed.next_session || null;
        formula = parsed.formula || "";
        // Backwards-compat plain insight (joined cards)
        insight = insight_cards.map((c) => `${c.icon || ""} ${c.body || ""}`).join(" ");
        insightCachedAt = new Date().toISOString();
        fitnessDoc(deviceId).update({
          analysis_cache: {
            insight, formula, insight_cards, next_session,
            cached_at: admin.firestore.FieldValue.serverTimestamp(),
          },
        }).catch(() => {});
      }
    } catch (e) {
      console.error("[fitness] insight gen:", e);
    }

    const responseBody = {
      fitness_score,
      stats: {
        total_workouts: inRange.length,
        current_streak: currentStreak,
        longest_streak: longestStreak,
        total_sets: totalSets,
        total_volume_kg: round(totalVolume, 0),
        avg_weekly_sets: avgWeeklySets,
        days_logged: daysLogged,
        prs_count: prsCount,
        top_exercise: topExercise,
        range_label: rangeLabel,
      },
      signal_points_volume,
      signal_points_strength,
      median_sets,
      strong_points,
      weak_points,
      muscle_grid,
      recent_timeline,
      correlations,
      observations,
      insight,
      insight_cards,
      next_session,
      personal_formula: formula,
      insight_cached_at: insightCachedAt,
      range_meta: (() => {
        // Compute date window text
        const fmtD = (d) => d.toLocaleDateString("en", { month: "short", day: "numeric" });
        let summary, dateRange;
        if (isAll && allWorkouts.length) {
          const first = new Date(
            (allWorkouts[allWorkouts.length - 1].date || dateStr()) + "T12:00:00"
          );
          const last = new Date();
          dateRange = `${fmtD(first)} – ${fmtD(last)}`;
          summary = `${dateRange} · ${allWorkouts.length} workouts`;
        } else {
          const start = new Date(); start.setDate(start.getDate() - rangeN + 1);
          const end = new Date();
          dateRange = `${fmtD(start)} – ${fmtD(end)}`;
          summary = `${dateRange} · ${inRange.length} workouts`;
        }
        return {
          label: rangeLabel,
          days: isAll ? null : rangeN,
          summary,
          date_range: dateRange,
        };
      })(),
    };

    _analysisCache.set(cacheKey, { body: responseBody, builtAt: Date.now() });
    _analysisLocks.delete(cacheKey);
    resolveLock(responseBody);
    return res.json(responseBody);
  } catch (e) {
    console.error("[fitness] analysis:", e);
    _analysisLocks.delete(cacheKey);
    rejectLock(e);
    return res.status(500).json({ error: "server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /muscle-trends — drill-down for a single muscle group across a range
//   Query: deviceId, muscle (chest|back|...), range (7|30|90|all)
//   Returns: top exercises (with bezier weight series), weekly volume series,
//            vs MEV/MAV/MRV, last session, total sets, status
// ─────────────────────────────────────────────────────────────────────────────
router.get("/muscle-trends", async (req, res) => {
  const { deviceId, muscle, range = "30" } = req.query;
  if (!deviceId || !muscle) return res.status(400).json({ error: "deviceId and muscle required" });
  const rangeKey = String(range).toLowerCase();
  const isAll = rangeKey === "all";
  const rangeN = isAll ? 9999 : parseInt(rangeKey, 10) || 30;
  const rangeLabel = isAll ? "ALL" : `${rangeN}D`;

  try {
    const wSnap = await workoutsCol(deviceId).orderBy("logged_at", "desc").limit(500).get();
    const allWorkouts = wSnap.docs.map(mapDoc);
    const cutoffMs = isAll ? 0 : Date.now() - rangeN * 24 * 3600 * 1000;
    const inRange = isAll
      ? allWorkouts.slice()
      : allWorkouts.filter((w) => getMillis(w.logged_at) >= cutoffMs);

    // Filter exercises to this muscle group
    const muscleSessions = []; // sessions where this muscle was trained
    for (const w of inRange) {
      const exs = (w.exercises || []).filter((e) => e.muscle_group === muscle);
      if (!exs.length) continue;
      muscleSessions.push({
        date: w.date,
        exercises: exs,
        total_sets: exs.reduce((s, e) => s + (e.sets?.length || 0), 0),
        total_volume_kg: round(
          exs.reduce(
            (s, e) => s + (e.sets || []).reduce((a, st) => a + (st.weight_kg || 0) * (st.reps || 0), 0),
            0,
          ),
          0,
        ),
      });
    }

    // ── Per-exercise weight series ──
    const exMap = {};
    for (const ms of muscleSessions) {
      for (const ex of ms.exercises) {
        if (!ex.name) continue;
        const key = ex.name.toLowerCase();
        const maxW = Math.max(...(ex.sets || []).map((s) => s.weight_kg || 0));
        if (!exMap[key]) exMap[key] = { name: ex.name, count: 0, sessions: [] };
        exMap[key].count++;
        if (maxW > 0) {
          exMap[key].sessions.push({
            date: ms.date,
            max: maxW,
            sets: ex.sets?.length || 0,
            volume: round(
              (ex.sets || []).reduce((a, s) => a + (s.weight_kg || 0) * (s.reps || 0), 0),
              0,
            ),
          });
        }
      }
    }
    const top_exercises = Object.values(exMap)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map((ex) => {
        const sorted = [...ex.sessions].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
        const points = sorted.map((s) => {
          const dt = new Date(s.date + "T12:00:00");
          return {
            date: s.date,
            label: `${dt.toLocaleDateString("en", { month: "short" })} ${dt.getDate()}`,
            value: round(s.max, 1),
            sets_count: s.sets,
            session_vol: s.volume,
          };
        });
        const first = points[0]?.value || 0;
        const last = points[points.length - 1]?.value || 0;
        return {
          name: ex.name,
          sessions: ex.count,
          max_kg: Math.max(0, ...sorted.map((s) => s.max)),
          delta_kg: round(last - first, 1),
          delta_pct: first > 0 ? Math.round(((last - first) / first) * 100) : 0,
          points,
        };
      });

    // ── Weekly volume series (sets per week for this muscle) ──
    const weekMap = {};
    for (const ms of muscleSessions) {
      if (!ms.date) continue;
      const dt = new Date(ms.date + "T12:00:00");
      // ISO-week-ish bucket: Monday start
      const monday = new Date(dt);
      monday.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
      const key = monday.toISOString().slice(0, 10);
      if (!weekMap[key]) weekMap[key] = { weekStart: key, sets: 0, volume: 0 };
      weekMap[key].sets += ms.total_sets;
      weekMap[key].volume += ms.total_volume_kg;
    }
    const volume_points = Object.values(weekMap)
      .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
      .map((wk) => {
        const dt = new Date(wk.weekStart + "T12:00:00");
        return {
          date: wk.weekStart,
          label: `${dt.toLocaleDateString("en", { month: "short" })} ${dt.getDate()}`,
          value: wk.sets,
          volume_kg: round(wk.volume, 0),
        };
      });

    // ── Status vs MEV/MAV/MRV ──
    const totalSets = muscleSessions.reduce((s, m) => s + m.total_sets, 0);
    const effectiveDays = isAll
      ? Math.max(7, Math.ceil(((Date.now() - getMillis(allWorkouts[allWorkouts.length - 1]?.logged_at || Date.now())) / 86400000)))
      : rangeN;
    const weeks = Math.max(1, effectiveDays / 7);
    const wkSets = totalSets / weeks;
    const lm = VOLUME_LANDMARKS[muscle];
    let status = "untrained";
    let status_label = "Not trained yet";
    let status_accent = "muted";
    if (totalSets > 0 && lm) {
      if (wkSets < lm.MEV) { status = "below_mev"; status_label = `Below MEV (${lm.MEV} sets/wk)`; status_accent = "red"; }
      else if (wkSets <= lm.MAV[1]) { status = "in_mav"; status_label = `In MAV (${lm.MAV[0]}-${lm.MAV[1]} sets/wk)`; status_accent = "green"; }
      else if (wkSets <= lm.MRV) { status = "above_mav"; status_label = `Above MAV`; status_accent = "amber"; }
      else { status = "above_mrv"; status_label = `Above MRV (overtraining risk)`; status_accent = "red"; }
    } else if (totalSets > 0) {
      status = "active"; status_label = `${totalSets} sets`; status_accent = "amber";
    }

    // ── Last session ──
    const lastDate = muscleSessions.length
      ? [...muscleSessions].sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0].date
      : null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days_since = lastDate
      ? Math.floor((today - new Date(lastDate + "T12:00:00")) / 86400000)
      : null;

    return res.json({
      muscle,
      range_label: rangeLabel,
      total_sets: totalSets,
      total_sessions: muscleSessions.length,
      weekly_sets: round(wkSets, 1),
      status,
      status_label,
      status_accent,
      mev: lm?.MEV ?? null,
      mav_low: lm?.MAV?.[0] ?? null,
      mav_high: lm?.MAV?.[1] ?? null,
      mrv: lm?.MRV ?? null,
      last_trained: lastDate,
      days_since,
      top_exercises,
      volume_points,
    });
  } catch (e) {
    console.error("[fitness] muscle-trends:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /actions — v2 response shape:
//   {
//     spotlight:   <action|null>,    // role==='spotlight'
//     secondaries: [<action>...],    // role==='secondary'
//     micro:       <action|null>,    // role==='micro'
//     outcome_card:<{...}|null>,     // most recent graded action awaiting surface
//     weekly_focus:<string>,
//     meta:        {...}
//   }
//   Backwards-compat: also returns active/completed/skipped arrays.
// ─────────────────────────────────────────────────────────────────
router.get("/_legacy/actions", async (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const fSnap = await fitnessDoc(deviceId).get();
    const fData = fSnap.data() || {};
    const pending = fData.pending_action_generation || false;
    const weeklyFocus = fData.last_weekly_focus || "";
    const noActionsReason = fData.no_actions_reason || null;

    const workoutCount = fData.workout_count_since_last_batch || 0;
    const progressToNext = workoutCount % ACTION_BATCH_SIZE;

    const snap = await actionsCol(deviceId)
      .where("status", "in", ["active", "completed", "skipped"])
      .limit(80)
      .get();
    snap.docs.sort(
      (a, b) => getMillis(b.data().generated_at) - getMillis(a.data().generated_at),
    );
    const all = snap.docs.map(mapDoc);
    const batchKey =
      all.find((a) => a.status === "active")?.batch_key || all[0]?.batch_key;
    const inBatch = batchKey
      ? all.filter((a) => a.batch_key === batchKey)
      : all.slice(0, 4);

    const serialize = (d) => ({
      ...d,
      generated_at: toIso(d.generated_at),
      expires_at: toIso(d.expires_at),
      completed_at: toIso(d.completed_at),
      skipped_at: toIso(d.skipped_at),
      graded_at: toIso(d.graded_at),
    });

    const inBatchSerialized = inBatch.map(serialize);
    const active    = inBatchSerialized.filter((a) => a.status === "active");
    const completed = inBatchSerialized.filter((a) => a.status === "completed");
    const skipped   = inBatchSerialized.filter((a) => a.status === "skipped");

    // v2 slots — pull by role from active set
    const spotlight   = active.find((a) => a.role === "spotlight") || null;
    const secondaries = active.filter((a) => a.role === "secondary");
    const micro       = active.find((a) => a.role === "micro") || null;

    // Outcome card: most recent graded action that hasn't been shown yet
    const allRecent = all.map(serialize);
    const ungrasped = allRecent.find((a) => a.outcome_grade && !a.outcome_surfaced);
    const outcome_card = ungrasped ? {
      action_id: ungrasped.id,
      grade: ungrasped.outcome_grade,
      title: ungrasped.title,
      surprise_hook: ungrasped.surprise_hook || "",
      promised: ungrasped.success_criterion,
      delivered_value: ungrasped.outcome_value || 0,
      proof: ungrasped.proof,
      archetype: ungrasped.archetype,
      category: ungrasped.category,
    } : null;

    // First-batch detection
    let sessionsUntilFirst = 0;
    if (!batchKey && !pending) {
      const wCount = (await workoutsCol(deviceId).count().get()).data().count;
      sessionsUntilFirst = Math.max(0, ACTION_BATCH_SIZE - wCount);
    }
    const sessionsUntilNext =
      active.length === 0 && completed.length > 0
        ? ACTION_BATCH_SIZE - progressToNext
        : 0;

    // Track-record summary (last 30 days)
    const trackCutoff = Date.now() - 30 * 86400000;
    const recent30 = allRecent.filter((a) => {
      const ms = a.generated_at ? new Date(a.generated_at).getTime() : 0;
      return ms >= trackCutoff;
    });
    const graded30 = recent30.filter((a) => a.outcome_grade);
    const kept30   = recent30.filter((a) => a.outcome_grade === "kept").length;
    const trackRecord = {
      total: graded30.length,
      kept: kept30,
      kept_rate: graded30.length ? Math.round((kept30 / graded30.length) * 100) : 0,
    };

    return res.json({
      // v2 shape
      spotlight,
      secondaries,
      micro,
      outcome_card,
      weekly_focus: weeklyFocus,
      track_record: trackRecord,
      // backwards-compat
      active,
      completed,
      skipped,
      meta: {
        batch_kind: inBatch[0]?.batch_kind || "pattern",
        generated_at: toIso(inBatch[0]?.generated_at),
        pending_generation: pending,
        progress_to_next_batch: progressToNext,
        sessions_until_first_batch: sessionsUntilFirst,
        sessions_until_next: sessionsUntilNext,
        no_actions_reason: noActionsReason,
      },
    });
  } catch (e) {
    console.error("[fitness] actions:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// GET /actions/history — full history with outcome grades
router.get("/_legacy/actions/history", async (req, res) => {
  const { deviceId, range = "30" } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  const rangeN = parseInt(range, 10) || 30;
  try {
    const cutoffMs = Date.now() - rangeN * 86400000;
    const snap = await actionsCol(deviceId)
      .orderBy("generated_at", "desc")
      .limit(150)
      .get();
    const all = snap.docs.map(mapDoc).filter((a) => {
      const ms = getMillis(a.generated_at);
      return ms >= cutoffMs;
    });

    const serialize = (d) => ({
      ...d,
      generated_at: toIso(d.generated_at),
      expires_at: toIso(d.expires_at),
      completed_at: toIso(d.completed_at),
      skipped_at: toIso(d.skipped_at),
      graded_at: toIso(d.graded_at),
    });

    const items = all.map(serialize);
    const graded = items.filter((a) => a.outcome_grade);
    const kept = graded.filter((a) => a.outcome_grade === "kept").length;
    const partial = graded.filter((a) => a.outcome_grade === "partial").length;
    const abandoned = graded.filter((a) => a.outcome_grade === "abandoned").length;

    // Most-kept category
    const catCounts = {};
    for (const a of graded.filter((g) => g.outcome_grade === "kept")) {
      const c = a.category || "science";
      catCounts[c] = (catCounts[c] || 0) + 1;
    }
    const mostKeptCategory = Object.entries(catCounts).sort(([, a], [, b]) => b - a)[0]?.[0] || null;

    return res.json({
      range_days: rangeN,
      total: items.length,
      graded: graded.length,
      kept, partial, abandoned,
      kept_rate: graded.length ? Math.round((kept / graded.length) * 100) : 0,
      most_kept_category: mostKeptCategory,
      items,
    });
  } catch (e) {
    console.error("[fitness] actions history:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// POST /action/:id/complete — user committed, will be graded later
router.post("/_legacy/action/:id/complete", async (req, res) => {
  const { id } = req.params;
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    await actionsCol(deviceId).doc(id).update({
      status: "completed",
      completed_at: admin.firestore.FieldValue.serverTimestamp(),
    });
    // Trigger grading immediately in case the criterion is already met
    gradeRecentActions(deviceId).catch(() => {});
    return res.json({ success: true });
  } catch (e) {
    console.error("[fitness] action complete:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// POST /action/:id/skip
router.post("/_legacy/action/:id/skip", async (req, res) => {
  const { id } = req.params;
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    await actionsCol(deviceId).doc(id).update({
      status: "skipped",
      skipped_at: admin.firestore.FieldValue.serverTimestamp(),
      outcome_grade: "abandoned",
    });
    return res.json({ success: true });
  } catch (e) {
    console.error("[fitness] action skip:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// POST /action/:id/snooze — push expires_at +3d, max 2 snoozes
router.post("/_legacy/action/:id/snooze", async (req, res) => {
  const { id } = req.params;
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const ref = actionsCol(deviceId).doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "not found" });
    const data = snap.data();
    const snoozes = data.snooze_count || 0;
    if (snoozes >= 2) {
      return res.status(400).json({ error: "max snoozes reached" });
    }
    const currentExpires = getMillis(data.expires_at) || Date.now() + 7 * 86400000;
    const newExpires = Math.max(currentExpires, Date.now()) + 3 * 86400000;
    await ref.update({
      expires_at: admin.firestore.Timestamp.fromMillis(newExpires),
      snooze_count: snoozes + 1,
      snoozed_at: admin.firestore.FieldValue.serverTimestamp(),
    });
    return res.json({ success: true, new_expires_at: new Date(newExpires).toISOString() });
  } catch (e) {
    console.error("[fitness] action snooze:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// POST /action/:id/feedback — { helpful: true|false, note? }
// Stored on the action; surfaces to AI for future batches.
router.post("/_legacy/action/:id/feedback", async (req, res) => {
  const { id } = req.params;
  const { deviceId, helpful, note } = req.body;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    await actionsCol(deviceId).doc(id).update({
      feedback_helpful: helpful === true || helpful === false ? helpful : null,
      feedback_note: note ? String(note).slice(0, 200) : null,
      feedback_at: admin.firestore.FieldValue.serverTimestamp(),
    });
    return res.json({ success: true });
  } catch (e) {
    console.error("[fitness] action feedback:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// POST /chat
router.post("/chat", async (req, res) => {
  const { deviceId, message, proactive_context } = req.body;
  if (!deviceId || !message)
    return res.status(400).json({ error: "deviceId and message required" });
  if (!checkChatRate(deviceId))
    return res.status(429).json({ error: "Too many messages. Wait a moment." });

  try {
    const context = await getCachedContext(deviceId);
    const histSnap = await chatsCol(deviceId)
      .orderBy("created_at", "desc")
      .limit(16)
      .get();
    const history = histSnap.docs
      .reverse()
      .map((d) => {
        const m = d.data();
        if (m.role === "assistant" || m.role === "user") {
          return { role: m.role, content: m.content };
        }
        return null;
      })
      .filter(Boolean);

    const fSnap = await fitnessDoc(deviceId).get();
    const setup = fSnap.data()?.setup || {};
    const proactiveHint = proactive_context
      ? `\nUser is following up on a proactive message of type: ${proactive_context}.`
      : "";

    const splitLabel =
      setup.preferred_split && setup.preferred_split !== "none"
        ? setup.preferred_split
        : "unstructured";
    const trainingDaysStr =
      Array.isArray(setup.training_days) && setup.training_days.length > 0
        ? setup.training_days.join(", ")
        : "not set";
    const baselines = setup.baseline_lifts
      ? `bench ${setup.baseline_lifts.bench_press || "?"}kg, squat ${setup.baseline_lifts.squat || "?"}kg, deadlift ${setup.baseline_lifts.deadlift || "?"}kg`
      : "not set";
    const supplements =
      Array.isArray(setup.supplements) &&
      !setup.supplements.includes("none") &&
      setup.supplements.length > 0
        ? setup.supplements.join(", ")
        : "none";

    const systemPrompt = [
      `You are an expert fitness coach inside a premium app. You have access to this user's complete training history.`,
      `User profile: goal=${setup.primary_goal}, level=${setup.training_level}, split=${splitLabel}, equipment=${setup.equipment}, injuries=${setup.injury_notes || "none"}.`,
      `Training schedule: ${trainingDaysStr}. Gym time: ${setup.gym_time || "07:00"}. Supplements: ${supplements}.`,
      `Baseline lifts: ${baselines}.`,
      `Context:\n${context}${proactiveHint}`,
      `Rules: Be specific and data-driven. Reference exact exercise names, weights, volumes, and dates from their data.`,
      `Use MEV/MAV/MRV landmarks when discussing volume. Reference progressive overload, periodization, deload needs when relevant.`,
      `Keep replies concise (2-4 sentences max, or a numbered list when steps are needed). No generic advice. No filler.`,
    ].join("\n");

    const messages = [
      { role: "system", content: systemPrompt },
      ...history.slice(-12),
      { role: "user", content: message },
    ];

    const aiRes = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      max_tokens: 400,
      temperature: 0.55,
      messages,
    });

    const reply = aiRes.choices[0].message.content.trim();

    const [userRef, aiRef] = await Promise.all([
      chatsCol(deviceId).add({
        role: "user",
        content: message,
        is_proactive: false,
        is_read: true,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
      }),
      chatsCol(deviceId).add({
        role: "assistant",
        content: reply,
        is_proactive: false,
        is_read: true,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
      }),
    ]);

    return res.json({ reply, message_id: aiRef.id });
  } catch (e) {
    console.error("[fitness] chat:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /chat/stream — Server-Sent Events streaming response
// ─────────────────────────────────────────────────────────────────
const { mountChatStream: _mountChatStreamFitness } = require("./lib/chat-stream");
_mountChatStreamFitness(router, {
  agentName: "fitness",
  openai, admin,
  chatsCol,
  rateLimitCheck: checkChatRate,
  buildPrompt: async (deviceId, message, { proactive_context } = {}) => {
    const context = await getCachedContext(deviceId);
    const histSnap = await chatsCol(deviceId).orderBy("created_at", "desc").limit(16).get();
    const history = histSnap.docs.reverse()
      .map(d => d.data())
      .filter(m => m.role === "assistant" || m.role === "user")
      .map(m => ({ role: m.role, content: m.content }))
      .slice(-12);
    const fSnap = await fitnessDoc(deviceId).get();
    const setup = fSnap.data()?.setup || {};
    const proactiveHint = proactive_context
      ? `\nUser is following up on a proactive message of type: ${proactive_context}.`
      : "";
    const splitLabel = setup.preferred_split && setup.preferred_split !== "none" ? setup.preferred_split : "unstructured";
    const trainingDaysStr = Array.isArray(setup.training_days) && setup.training_days.length > 0 ? setup.training_days.join(", ") : "not set";
    const baselines = setup.baseline_lifts
      ? `bench ${setup.baseline_lifts.bench_press || "?"}kg, squat ${setup.baseline_lifts.squat || "?"}kg, deadlift ${setup.baseline_lifts.deadlift || "?"}kg`
      : "not set";
    const supplements = Array.isArray(setup.supplements) && !setup.supplements.includes("none") && setup.supplements.length > 0 ? setup.supplements.join(", ") : "none";
    const systemPrompt = [
      `You are an expert fitness coach inside a premium app. You have access to this user's complete training history.`,
      `User profile: goal=${setup.primary_goal}, level=${setup.training_level}, split=${splitLabel}, equipment=${setup.equipment}, injuries=${setup.injury_notes || "none"}.`,
      `Training schedule: ${trainingDaysStr}. Gym time: ${setup.gym_time || "07:00"}. Supplements: ${supplements}.`,
      `Baseline lifts: ${baselines}.`,
      `Context:\n${context}${proactiveHint}`,
      `Rules: Be specific and data-driven. Reference exact exercise names, weights, volumes, and dates from their data.`,
      `Use MEV/MAV/MRV landmarks when discussing volume. Reference progressive overload, periodization, deload needs when relevant.`,
      `Keep replies concise (2-4 sentences max, or a numbered list when steps are needed). No generic advice. No filler.`,
    ].join("\n");
    return { systemPrompt, history };
  },
});

// GET /chat (message history)
router.get("/chat", async (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const snap = await chatsCol(deviceId)
      .orderBy("created_at", "asc")
      .limit(100)
      .get();
    const messages = snap.docs.map((d) => ({
      id: d.id,
      ...d.data(),
      created_at: toIso(d.data().created_at),
    }));
    return res.json({ messages });
  } catch (e) {
    console.error("[fitness] chat GET:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// GET /chat/unread
router.get("/chat/unread", async (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const snap = await chatsCol(deviceId)
      .where("is_proactive", "==", true)
      .where("is_read", "==", false)
      .limit(30)
      .get();
    snap.docs.sort(
      (a, b) => getMillis(b.data().created_at) - getMillis(a.data().created_at),
    );
    const messages = snap.docs.map((d) => ({
      id: d.id,
      ...d.data(),
      created_at: toIso(d.data().created_at),
    }));
    return res.json({ messages });
  } catch (e) {
    console.error("[fitness] chat/unread:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// POST /chat/read
router.post("/chat/read", async (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const snap = await chatsCol(deviceId)
      .where("is_read", "==", false)
      .limit(50)
      .get();
    if (!snap.empty) {
      const batch = db().batch();
      snap.docs.forEach((d) => batch.update(d.ref, { is_read: true }));
      await batch.commit();
    }
    return res.json({ success: true });
  } catch (e) {
    console.error("[fitness] chat/read:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// ----------------------------------------------------------------
// Hourly proactive cron
// ----------------------------------------------------------------
cron.schedule("0 * * * *", async () => {
  try {
    const now = new Date();
    const hour = now.getHours();
    if (hour < 6 || hour > 22) return;

    const snap = await db().collection("wellness_users").limit(200).get();
    for (const userDoc2 of snap.docs) {
      const deviceId = userDoc2.id;
      try {
        const fSnap = await fitnessDoc(deviceId).get();
        if (!fSnap.exists || !fSnap.data()?.setup?.primary_goal) continue;

        const setup = fSnap.data().setup || {};
        const reminderHour = parseInt(
          (setup.gym_time || setup.reminder_time || "07:00").split(":")[0],
          10,
        );
        const proactiveToday = fSnap.data().proactive_today || "";
        const today = dateStr();

        if (proactiveToday === today) continue;

        const allSnap = await workoutsCol(deviceId)
          .orderBy("logged_at", "desc")
          .limit(10)
          .get();
        const workouts = allSnap.docs.map(mapDoc);
        const streak = computeStreak(workouts);

        // Streak milestone — respect global daily budget (1/day max)
        if (
          [7, 14, 30, 60, 90].includes(streak) &&
          hour === reminderHour
        ) {
          const dbBudget = await checkProactiveBudgetFromDB(deviceId);
          if (!dbBudget.allowed || !tryReserveProactiveSlot(deviceId)) {
            await fitnessDoc(deviceId).update({ proactive_today: today });
            continue;
          }
          const msg = `🔥 ${streak}-day training streak. Locked in.`;
          await chatsCol(deviceId).add({
            role: "assistant",
            content: msg,
            is_proactive: true,
            proactive_type: "streak_milestone",
            is_read: false,
            created_at: admin.firestore.FieldValue.serverTimestamp(),
          });
          await fitnessDoc(deviceId).update({ proactive_today: today });
          continue;
        }
      } catch {
        /* non-fatal per user */
      }
    }
  } catch (e) {
    console.error("[fitness] cron:", e);
  }
});

module.exports = router;
