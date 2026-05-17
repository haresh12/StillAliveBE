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
const { AI } = require('./lib/ai/models');
const router = express.Router();
const admin = require("firebase-admin");
const { OpenAI } = require("openai");
const cron = require("node-cron");
const { fetchAgentSnapshot } = require("./lib/cross-agent-context");
const { callGeminiVision, hashImages } = require("./lib/vision-router");
const { resolveLanguage, appendLanguageInstruction } = require("./lib/i18n-prompt");
const { withCron, shouldRunCron } = require("./lib/cron-helper");
const { getUserNotifContext } = require("./lib/cron-user-context");
const { resolveAnchor } = require("./lib/user-anchor");
const { assertLoggableDate, sendLogGuardError } = require("./lib/log-guard");
const crypto = require("crypto");
const { computeFitnessScore: _computeFitnessScore } = require('./lib/agent-scores');

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
  // Wrap the candidate function to inject cross-agent signals from today_signals.
  // Sandbox-safe: we read from cross_agent/today_signals (the only legal cross-read),
  // not from sibling agent collections directly.
  computeCandidates: async (logs, setup, ctx) => {
    let crossSignals = {};
    try {
      const deviceId = ctx?.deviceId || ctx?.setup?.deviceId;
      if (deviceId) {
        const xSnap = await userDoc(deviceId).collection('cross_agent').doc('today_signals').get();
        if (xSnap.exists) crossSignals = xSnap.data() || {};
      }
    } catch { /* non-fatal */ }
    return computeFitnessCandidates(logs, setup, crossSignals);
  },
  graders: fitnessGraders,
  openai, admin, db,
  crossAgentEnricher: async (deviceId) => {
    // Cross-agent law: read ONLY from cross_agent/today_signals.
    // wellness.cross.js (the only place allowed to read across agents) writes
    // pre-computed signals there. We never call fetchAgentSnapshot for siblings.
    try {
      const xSnap = await userDoc(deviceId).collection('cross_agent').doc('today_signals').get();
      if (!xSnap.exists) return '';
      const x = xSnap.data() || {};
      const parts = [];

      // Sleep summary
      const sleepEntries = x.recent_sleep_summary?.entries || [];
      if (sleepEntries.length) {
        const avgQ = sleepEntries.reduce((a, e) => a + (e.quality_score || 50), 0) / sleepEntries.length;
        parts.push(`Sleep ${sleepEntries.length} nights avg quality ${Math.round(avgQ)}/100.`);
        if (avgQ < 60) parts.push('Poor sleep → reduce workout intensity, prioritise recovery.');
      }

      // Mind anxiety / mood
      if (x.mind_anxiety_level != null) {
        parts.push(`Mind anxiety level ${x.mind_anxiety_level}/5.`);
        if (x.mind_anxiety_level >= 4) parts.push('High anxiety → mobility/restorative session preferred over heavy lifts.');
      }

      // Nutrition protein context
      if (x.nutrition_protein_target_pct != null) {
        const pct = x.nutrition_protein_target_pct;
        if (pct < 60) parts.push(`Protein only ${pct}% of target — MPS will be compromised; eat first.`);
        else if (pct >= 100) parts.push(`Protein target hit (${pct}%) — recovery conditions are good.`);
      }
      if (x.nutrition_calorie_deficit && x.nutrition_calorie_deficit < -600) {
        parts.push(`Large deficit (${x.nutrition_calorie_deficit} kcal) — performance + recovery impaired today.`);
      }

      // Hydration
      if (x.water_intake_pct != null && x.water_intake_pct < 40) {
        parts.push(`Hydration only ${x.water_intake_pct}% — drink before training.`);
      }

      // Fasting state
      if (x.fasting_active_hours && x.fasting_active_hours >= 14) {
        parts.push(`Currently ${Math.round(x.fasting_active_hours)}h into fast — light session only.`);
      }

      return parts.join(' ');
    } catch {
      return '';
    }
  },
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
    log.error("[fitness] buildFitnessContext:", e);
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
    log.error("[fitness] buildActionContext:", e);
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
    log.error("[fitness] gradeRecentActions:", e);
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
      model: AI.CHAT_STREAM,
      max_completion_tokens: 900,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: prompt }],
    });
    const parsed = JSON.parse(aiRes.choices[0].message.content);
    aiActions = Array.isArray(parsed.actions) ? parsed.actions : [];
    weeklyFocus = parsed.weekly_focus || "";
  } catch (e) {
    log.error("[fitness] action copy AI:", e);
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
      log.error("[fitness] queueActionBatchGeneration error:", err);
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
    log.error("[fitness] setup-status:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /chat-prompts  — returns 6 prompts personalised from setup + logs
// ═══════════════════════════════════════════════════════════════
router.get("/chat-prompts", async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: "deviceId required" });

    const snap  = await fitnessDoc(deviceId).get();
    const setup = snap.exists ? (snap.data().setup || {}) : {};
    const goal    = setup.primary_goal    || "general";
    const level   = setup.training_level  || "beginner";
    const split   = setup.preferred_split || "";
    const days    = Array.isArray(setup.training_days) ? setup.training_days : [];
    const equip   = setup.equipment       || "full_gym";

    const lastSnap = await fitnessDoc(deviceId).collection("fitness_logs").orderBy("logged_at", "desc").limit(1).get();
    const lastLog  = lastSnap.empty ? null : lastSnap.docs[0].data();

    const hour = new Date().getHours();
    const isMorning = hour >= 5 && hour < 12;

    const pool = [];

    if (goal === "strength") {
      pool.push({ emoji: "💪", text: "How can I break through my strength plateau?" });
      pool.push({ emoji: "📊", text: "Show me my strength progress this month." });
    } else if (goal === "muscle" || goal === "hypertrophy") {
      pool.push({ emoji: "🏋️", text: "Am I doing enough volume to build muscle?" });
      pool.push({ emoji: "😴", text: "How does my recovery affect muscle growth?" });
    } else if (goal === "weight_loss" || goal === "fat_loss") {
      pool.push({ emoji: "🔥", text: "What workouts burn the most fat for my level?" });
      pool.push({ emoji: "📉", text: "Is my training helping with weight loss?" });
    } else if (goal === "endurance") {
      pool.push({ emoji: "🏃", text: "How do I build endurance without overtraining?" });
      pool.push({ emoji: "❤️", text: "What's a good cardio strategy for this week?" });
    } else {
      pool.push({ emoji: "🎯", text: "What should my workout focus be this week?" });
      pool.push({ emoji: "📊", text: "How is my fitness improving over time?" });
    }

    if (level === "beginner") {
      pool.push({ emoji: "🌱", text: "As a beginner, how fast should I progress?" });
    } else if (level === "advanced") {
      pool.push({ emoji: "🚀", text: "Design an advanced progressive overload plan for me." });
    } else {
      pool.push({ emoji: "📈", text: "How do I apply progressive overload to my workouts?" });
    }

    if (lastLog && lastLog.muscle_groups) {
      const muscles = Array.isArray(lastLog.muscle_groups) ? lastLog.muscle_groups.join(", ") : lastLog.muscle_groups;
      pool.unshift({ emoji: "🔄", text: `I just trained ${muscles} — what should I do next?` });
    } else if (isMorning) {
      pool.push({ emoji: "🌅", text: "What's the best workout for this morning?" });
    }

    if (equip === "home" || equip === "minimal") {
      pool.push({ emoji: "🏠", text: "Give me an effective home workout for today." });
    } else {
      pool.push({ emoji: "💡", text: "What gym exercises give the best ROI for my goal?" });
    }

    pool.push({ emoji: "🔄", text: "How does my sleep and stress affect my performance?" });
    pool.push({ emoji: "🩹", text: "I'm feeling sore — should I train or rest?" });

    res.json({ prompts: pool.slice(0, 6) });
  } catch (err) {
    log.error("[fitness] /chat-prompts error:", err);
    res.status(500).json({ error: "Failed" });
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
      model: AI.CHAT_STREAM,
      messages: [
        { role: "system", content: context },
        { role: "user", content: userMsg },
      ],
      max_completion_tokens: 110,
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
    log.error("[fitness] setup:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// ── refreshFitnessScore — lightweight score cache written after every log ──
// Non-blocking: callers do refreshFitnessScore(deviceId).catch(() => {})
async function refreshFitnessScore(deviceId) {
  const [workoutsSnap, fSnap] = await Promise.all([
    workoutsCol(deviceId).orderBy('logged_at', 'desc').limit(60).get(),
    fitnessDoc(deviceId).get(),
  ]);

  const workouts = workoutsSnap.docs.map(d => d.data());
  const data     = fSnap.data() || {};
  const setup    = data.setup   || {};

  const now28     = Date.now() - 28 * 86400000;
  const now30     = Date.now() - 30 * 86400000;
  const days_logged = workouts.length;

  // ── (1) Consistency: workouts in last 28 days vs. expected ──
  const plannedPerWeek = setup.days_per_week || 3;
  const recentCount    = workouts.filter(w => {
    const ms = w.logged_at && w.logged_at.toMillis ? w.logged_at.toMillis() : (w.logged_at || 0);
    return ms >= now28;
  }).length;
  const expectedIn28 = plannedPerWeek * 4;
  const consistency  = Math.min(100, Math.round((recentCount / Math.max(1, expectedIn28)) * 100));

  // ── (2) Volume: linear slope of total_volume_kg over last 4 weeks ──
  // Split workouts into 4 weekly buckets; slope normalized 0-100
  const volume = (() => {
    const weekMs = 7 * 86400000;
    const buckets = [0, 0, 0, 0]; // index 0 = oldest, 3 = most recent
    const counts  = [0, 0, 0, 0];
    const cutoff4w = Date.now() - 4 * weekMs;
    for (const w of workouts) {
      const ms = w.logged_at && w.logged_at.toMillis ? w.logged_at.toMillis() : 0;
      if (ms < cutoff4w) continue;
      const weekIdx = Math.min(3, Math.floor((Date.now() - ms) / weekMs));
      const bucket  = 3 - weekIdx; // flip so 0=oldest
      buckets[bucket] += w.total_volume_kg || 0;
      counts[bucket]++;
    }
    const avgs = buckets.map((v, i) => counts[i] ? v / counts[i] : null);
    const filled = avgs.filter(v => v !== null);
    if (filled.length < 2) return 50; // not enough data → neutral
    const first = filled[0], last = filled[filled.length - 1];
    // slope: % improvement per period, clamped 0-100
    // +20% per week = 100, flat = 50, declining = <50
    const pctChange = first > 0 ? ((last - first) / first) * 100 : 0;
    return Math.min(100, Math.max(0, Math.round(50 + pctChange * 2.5)));
  })();

  // ── (3) Progression: PRs in last 30 days (0 PRs=0, 5+ PRs=100) ──
  const recentPRs = workouts.reduce((sum, w) => {
    const ms = w.logged_at && w.logged_at.toMillis ? w.logged_at.toMillis() : 0;
    if (ms < now30) return sum;
    return sum + ((w.personal_records || []).length);
  }, 0);
  const progression = Math.min(100, Math.round((recentPRs / 5) * 100));

  // ── (4) Intensity: avg sets per session (target 15–25 = 100) ──
  const recentWorkouts = workouts.slice(0, Math.min(workouts.length, 28));
  const avgSets = recentWorkouts.length
    ? recentWorkouts.reduce((s, w) => s + (w.total_sets || 0), 0) / recentWorkouts.length
    : 0;
  const intensity = (() => {
    if (avgSets === 0) return 0;
    if (avgSets >= 15 && avgSets <= 25) return 100;
    if (avgSets < 15) return Math.round((avgSets / 15) * 100);
    // above 25 — gentle penalty
    return Math.max(60, Math.round(100 - (avgSets - 25) * 2));
  })();

  const result = _computeFitnessScore({ consistency, volume, progression, intensity, days_logged });
  if (!result) return;

  await fitnessDoc(deviceId).update({
    current_score:    result.score,
    score_label:      result.label,
    score_components: result.components,
    score_updated_at: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// POST /log — log a workout session
router.post("/log", async (req, res) => {
  const { deviceId, exercises, date } = req.body;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  if (!Array.isArray(exercises) || exercises.length === 0) {
    return res.status(400).json({ error: "exercises array required" });
  }
  try {
    const anchor = await resolveAnchor(deviceId);
    let workoutDate;
    try {
      workoutDate = assertLoggableDate(date, anchor);
    } catch (e) { return sendLogGuardError(res, e); }

    // Enrich exercises with muscle groups + e1RM
    const enriched = exercises.map((ex) => ({
      name: ex.name || "Unknown",
      muscle_group: detectMuscleGroup(ex.name),
      sets: (ex.sets || []).map((s) => {
        const reps = parseInt(s.reps, 10) || 0;
        const weight_kg = parseFloat(s.weight_kg) || 0;
        const rpe = s.rpe != null ? Math.max(1, Math.min(10, parseFloat(s.rpe))) : null;
        // Epley formula: weight * (1 + 0.0333 * reps)
        const e1rm = weight_kg > 0 && reps > 0
          ? Math.round(weight_kg * (1 + 0.0333 * reps) * 10) / 10
          : null;
        return { reps, weight_kg, ...(rpe != null ? { rpe } : {}), ...(e1rm != null ? { e1rm } : {}) };
      }),
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
        const setup = data.setup || {};

        const bgBatch = [];

        // Update workout doc with detected PRs
        if (prs.length > 0) {
          bgBatch.push(workoutRef.update({ personal_records: prs }));
        }

        // ── Cross-agent fitness snapshot (readable by Home + Insights) ──
        const muscleGroupsToday = [...new Set(enriched.map(e => e.muscle_group).filter(m => m && m !== 'other'))];
        bgBatch.push(
          fitnessDoc(deviceId).update({
            workout_count_since_last_batch: shouldGenerate ? 0 : count,
            fitness_snapshot: {
              last_workout_date: workoutDate,
              last_workout_sets: totalSets,
              last_workout_volume_kg: round(totalVolume, 1),
              last_workout_muscles: muscleGroupsToday,
              had_pr: prs.length > 0,
              streak: newStreak,
              weekly_sets: streakSnap.docs
                .map(mapDoc)
                .filter(w => getMillis(w.logged_at) >= Date.now() - 7 * 86400000)
                .reduce((s, w) => s + (w.total_sets || 0), 0),
              goal: setup.primary_goal || 'general',
              training_level: setup.training_level || 'intermediate',
              snapshot_at: new Date().toISOString(),
            },
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

        refreshFitnessScore(deviceId).catch(() => {});

      } catch (bgErr) {
        log.error("[fitness] log background:", bgErr);
      }
    });
  } catch (e) {
    log.error("[fitness] log:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// ─── Session model (Phase 2A) ─────────────────────────────────
// Race-safe transactional workout sessions. Mirrors Fasting's pattern.
// Lifecycle:
//   POST /session/start  → returns session_id, locks user to one concurrent session
//   POST /session/log    → log exercises/sets under session_id
//   POST /session/end    → finalizes, writes cross-agent signals
//
// Cross-agent signals written on /session/end:
//   - fitness_post_workout_mood_boost: { expected, score }
//   - fitness_protein_demand_urgent:    { delta_g, reason }
//   - fitness_water_intake_boost:        { delta_ml, reason }
//   - fitness_sleep_quality_needed:      { priority, reason }
//   - fitness_cardiovascular_load:       { score, recovery_hours }

const sessionsCol = (id) => fitnessDoc(id).collection("sessions");

router.post("/session/start", async (req, res) => {
  try {
    const { deviceId, planned_exercises = [] } = req.body || {};
    if (!deviceId) return res.status(400).json({ error: "deviceId required" });

    const fitRef = fitnessDoc(deviceId);
    const result = await admin.firestore().runTransaction(async (tx) => {
      const fitSnap = await tx.get(fitRef);
      const data = fitSnap.exists ? fitSnap.data() : {};
      // Mutex: refuse if an active session already exists.
      if (data.active_session_id) {
        const existing = await tx.get(sessionsCol(deviceId).doc(data.active_session_id));
        if (existing.exists && existing.data().status === "active") {
          throw new Error("active_session_exists");
        }
      }
      const newRef = sessionsCol(deviceId).doc();
      tx.set(newRef, {
        status:             "active",
        started_at:         admin.firestore.FieldValue.serverTimestamp(),
        planned_exercises:  planned_exercises.slice(0, 30),
        exercises:          [],
        total_sets:         0,
        total_volume_kg:    0,
        rpe_avg:            null,
      });
      tx.set(fitRef, {
        active_session_id: newRef.id,
        active_session_started_at: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return { session_id: newRef.id };
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    if (e.message === "active_session_exists") {
      return res.status(409).json({ error: "active_session_exists" });
    }
    log.error("[fitness] /session/start:", e);
    res.status(500).json({ error: e.message });
  }
});

router.post("/session/end", async (req, res) => {
  try {
    const { deviceId, session_id, rpe_avg, notes } = req.body || {};
    if (!deviceId || !session_id) return res.status(400).json({ error: "deviceId + session_id required" });

    const fitRef = fitnessDoc(deviceId);
    const sessionRef = sessionsCol(deviceId).doc(session_id);

    const sessionData = await admin.firestore().runTransaction(async (tx) => {
      const sSnap = await tx.get(sessionRef);
      if (!sSnap.exists) throw new Error("session_not_found");
      const s = sSnap.data();
      if (s.status === "ended") return s; // idempotent

      // Aggregate from logged exercises
      const exercises = s.exercises || [];
      const totalSets = exercises.reduce((acc, ex) => acc + (ex.sets?.length || 0), 0);
      const totalVolume = exercises.reduce((acc, ex) =>
        acc + (ex.sets || []).reduce((s2, st) => s2 + (st.reps || 0) * (st.weight_kg || 0), 0), 0);
      const avgRpe = rpe_avg != null
        ? Math.max(1, Math.min(10, +rpe_avg))
        : (() => {
            const rpes = [];
            exercises.forEach(ex => (ex.sets || []).forEach(st => { if (st.rpe) rpes.push(st.rpe); }));
            return rpes.length ? rpes.reduce((a, b) => a + b, 0) / rpes.length : null;
          })();

      // Session quality score 0-100 (50 volume + 50 effort)
      // Volume: vs user's 7d avg (capped). Effort: RPE 1-10 → 0-50.
      const recentSessions = await sessionsCol(deviceId)
        .where("status", "==", "ended")
        .orderBy("ended_at", "desc")
        .limit(7)
        .get()
        .catch(() => ({ docs: [] }));
      const past = recentSessions.docs.map(d => d.data());
      const avgPastVol = past.length
        ? past.reduce((a, p) => a + (p.total_volume_kg || 0), 0) / past.length
        : Math.max(totalVolume * 0.8, 1);
      const volScore   = Math.min(50, Math.round((totalVolume / Math.max(avgPastVol, 1)) * 30));
      const effortScore = avgRpe != null ? Math.round((avgRpe - 1) * (50 / 9)) : 25;
      const session_quality = Math.max(0, Math.min(100, volScore + effortScore));

      const update = {
        status:           "ended",
        ended_at:         admin.firestore.FieldValue.serverTimestamp(),
        total_sets:       totalSets,
        total_volume_kg:  Math.round(totalVolume * 10) / 10,
        rpe_avg:          avgRpe,
        session_quality,
        notes:            (notes || "").slice(0, 280),
      };
      tx.set(sessionRef, update, { merge: true });
      tx.set(fitRef, {
        active_session_id: admin.firestore.FieldValue.delete(),
        active_session_started_at: admin.firestore.FieldValue.delete(),
        last_session_id: session_id,
        last_session_at: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return { ...s, ...update };
    });

    // ── Write cross-agent signals (fire-and-forget, non-blocking) ──
    writeFitnessCrossAgentSignals(deviceId, sessionData).catch(e =>
      log.error("[fitness] cross-agent write:", e?.message));

    // Trigger action regeneration after session ends
    _onFitnessLog(deviceId);

    res.json({
      ok: true,
      session_id,
      total_sets: sessionData.total_sets,
      total_volume_kg: sessionData.total_volume_kg,
      session_quality: sessionData.session_quality,
    });
  } catch (e) {
    if (e.message === "session_not_found") return res.status(404).json({ error: "session_not_found" });
    log.error("[fitness] /session/end:", e);
    res.status(500).json({ error: e.message });
  }
});

// Append exercises/sets to an active session.
router.post("/session/log", async (req, res) => {
  try {
    const { deviceId, session_id, exercise_name, sets } = req.body || {};
    if (!deviceId || !session_id || !exercise_name || !Array.isArray(sets)) {
      return res.status(400).json({ error: "deviceId, session_id, exercise_name, sets required" });
    }
    const muscle = detectMuscleGroup(exercise_name);
    const enrichedSets = sets.map(s => {
      const reps = parseInt(s.reps, 10) || 0;
      const weight_kg = parseFloat(s.weight_kg) || 0;
      const rpe = s.rpe != null ? Math.max(1, Math.min(10, parseFloat(s.rpe))) : null;
      const rir = s.rir != null ? Math.max(0, Math.min(10, parseInt(s.rir, 10))) : null;
      const e1rm = weight_kg > 0 && reps > 0
        ? Math.round(weight_kg * (1 + 0.0333 * reps) * 10) / 10
        : null;
      return {
        reps, weight_kg,
        ...(rpe != null ? { rpe } : {}),
        ...(rir != null ? { rir } : {}),
        ...(e1rm != null ? { e1rm } : {}),
        logged_at: new Date().toISOString(),
      };
    });
    await sessionsCol(deviceId).doc(session_id).update({
      exercises: admin.firestore.FieldValue.arrayUnion({
        name: exercise_name,
        muscle_group: muscle,
        sets: enrichedSets,
      }),
    });
    res.json({ ok: true, sets_logged: enrichedSets.length });
  } catch (e) {
    log.error("[fitness] /session/log:", e);
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /reflection ──────────────────────────────────────────
// One-line post-workout reflection (text). Stored on the user's
// most recent workout doc + mirrored to cross_agent/today_signals
// so Insights V4 timeline can surface it the same day.
router.post('/reflection', async (req, res) => {
  try {
    const { deviceId, text, date } = req.body || {};
    if (!deviceId || !text) return res.status(400).json({ error: 'deviceId and text required' });
    const trimmed = String(text).slice(0, 200);
    const anchor = await resolveAnchor(deviceId);
    let target;
    try { target = assertLoggableDate(date, anchor); }
    catch (e) { return sendLogGuardError(res, e); }

    // Attach to latest matching workout doc (best effort)
    const snap = await workoutsCol(deviceId)
      .where('date', '==', target)
      .orderBy('logged_at', 'desc')
      .limit(1)
      .get()
      .catch(() => ({ empty: true, docs: [] }));
    if (!snap.empty) {
      await snap.docs[0].ref.update({
        reflection: trimmed,
        reflection_at: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    // Cross-agent: write to today_signals (sandbox-safe single doc)
    await userDoc(deviceId).collection('cross_agent').doc('today_signals').set({
      fitness_reflection: {
        text: trimmed,
        date: target,
        recorded_at: admin.firestore.FieldValue.serverTimestamp(),
      },
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    res.json({ ok: true });
  } catch (e) {
    log.error('[fitness] /reflection:', e);
    res.status(500).json({ error: 'server error' });
  }
});

// ─── POST /describe ────────────────────────────────────────────
// User speaks ("3x10 squats at 100kg, RIR 2") → ASR text on client →
// posted here → Gemini parses to structured set log.
router.post("/describe", async (req, res) => {
  try {
    const { deviceId, transcript } = req.body || {};
    if (!deviceId)               return res.status(400).json({ error: "deviceId required" });
    if (!transcript || typeof transcript !== "string") {
      return res.status(400).json({ error: "transcript required" });
    }
    const text = transcript.trim().slice(0, 600);
    if (!text) return res.status(400).json({ error: "empty_transcript" });

    // ── Replay intent shortcut ──
    // If the user said something like "same as last Monday" / "repeat
    // Tuesday's workout" / "do last Friday again", we skip the Gemini
    // parse entirely and look up that day-of-week's most recent workout
    // (last 42 days). Faster, cheaper, more accurate than asking the
    // model to invent exercise names from a vague utterance.
    const replayMatch = text.toLowerCase().match(
      /(?:same as|repeat|do|replay)\s+(?:last\s+|the\s+last\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|last week|yesterday)(?:'?s)?(?:\s+workout|\s+session)?/,
    );
    if (replayMatch) {
      try {
        const dowMap = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };
        const tok = replayMatch[1];
        const todayDate = new Date();
        let targetDow;
        if (tok === 'yesterday') {
          const y = new Date(); y.setDate(y.getDate() - 1); targetDow = y.getDay();
        } else if (tok === 'last week') {
          targetDow = todayDate.getDay();
        } else {
          targetDow = dowMap[tok];
        }
        const cutoff42 = new Date(); cutoff42.setDate(cutoff42.getDate() - 41);
        const dowSnap = await workoutsCol(deviceId)
          .where('date', '>=', dateStr(cutoff42)).get();
        const todayStr = dateStr();
        const dowOf = (ds) => {
          if (!ds) return -1;
          const [y, m, d] = ds.split('-').map(Number);
          return new Date(y, m - 1, d, 12, 0, 0).getDay();
        };
        const matched = dowSnap.docs
          .map(d => d.data())
          // Past-only: don't replay future-dated test logs
          .filter(w => w.date && w.date < todayStr && dowOf(w.date) === targetDow)
          .sort((a, b) => (a.date < b.date ? 1 : -1));
        if (matched.length > 0) {
          const src = matched[0];
          const exercises = (src.exercises || []).map(ex => ({
            exercise:     String(ex.name || '').slice(0, 60),
            muscle_group: ex.muscle_group || null,
            sets: (ex.sets || []).map(s => ({
              reps:      Math.max(0, parseInt(s.reps, 10) || 0),
              weight_kg: Math.max(0, parseFloat(s.weight_kg) || 0),
              ...(Number.isFinite(parseInt(s.rir, 10)) ? { rir: parseInt(s.rir, 10) } : {}),
            })),
            missing: [],
          })).filter(ex => ex.exercise && ex.sets.length > 0);
          if (exercises.length > 0) {
            return res.json({
              ok: true,
              exercises,
              session_notes: `Replayed from ${src.date}`,
              confidence: 100,
              ambiguous_fields: [],
              replay_source_date: src.date,
              latency_ms: Date.now() - 0,  // negligible — no LLM call
              model: 'replay',
            });
          }
        }
        // No matching workout — fall through to normal parse path so
        // user gets a helpful "we couldn't find that day's workout" UX.
      } catch (e) {
        log.warn('[fitness] replay lookup fail:', e?.message);
      }
    }

    const systemPrompt = [
      'TASK: Parse a spoken workout description into structured JSON.',
      'The user is describing what they JUST did in plain English. They may',
      'describe MULTIPLE exercises in one utterance ("I did bench press 4 by 8',
      'at 80, then squats 5 by 5 at 120, then shoulder press 3 by 10 at 22.5").',
      'Always return an array of exercises, even if there is only one.',
      '',
      'TRANSCRIPT IS FROM ON-DEVICE SPEECH RECOGNITION — IT WILL HAVE ERRORS.',
      'Common ASR misspellings to silently correct (without changing the',
      'user\'s intent or wording style):',
      '- "ate" → "8" when used as a number ("ate raps" → "8 reps")',
      '- "for" / "fore" → "4" when used as a number',
      '- "to" / "too" → "2" when used as a number',
      '- "are I are" / "rear" / "are pee" → "RIR" / "RPE"',
      '- "am rap" → "AMRAP"',
      '- "raps" → "reps"',
      '- "bench priest" / "bench breast" → "bench press"',
      '- "dead lift" / "deadlift" → "deadlift"',
      '- "twenty two five" / "22 5" → "22.5" (decimal weights)',
      '- Decimal kilos in fitness contexts: 1.25, 2.5, 7.5, 22.5, 27.5, etc.',
      'KEEP user wording intact in `session_notes`; correct only inside the',
      'structured fields. Never invent numbers or exercises that were not said.',
      '',
      'RULES:',
      '- Numbers can be spelled ("three sets") or digits ("3 sets") — handle both.',
      '- Weight unit defaults to kg unless user says "lbs" or "pounds".',
      '- If user says "felt heavy" / "barely got the last rep" → rir: 0',
      '- "Could have done 2-3 more" → rir: 2 (mid-point)',
      '- "Easy" → rir: 4',
      '- If multiple sets at same weight, expand into individual sets.',
      '- If user says "AMRAP" / "to failure" / "as many reps as possible" → rir: 0',
      '- For each exercise, classify into ONE muscle_group (lowercase) from this list:',
      '  "chest", "back", "legs", "shoulders", "arms", "core", "cardio", "full_body".',
      '  Examples: bench press → chest; squat / deadlift / leg press → legs;',
      '  pull-up / row → back; OHP / lateral raise → shoulders; curl / pushdown → arms;',
      '  plank / crunch → core; treadmill / rower → cardio; clean / burpee → full_body.',
      '',
      'OUTPUT (strict JSON):',
      '{',
      '  "exercises": [',
      '    {',
      '      "exercise": canonical name (e.g. "Back Squat", "Bench Press"),',
      '      "muscle_group": one of the muscle group ids listed above,',
      '      "sets": [{ "reps": int, "weight_kg": number, "rir": int|null, "notes": string|null }],',
      '      "missing": []  // see PER-FIELD CONFIDENCE below',
      '    },',
      '    ...',
      '  ],',
      '  "session_notes": string|null,',
      '  "confidence": integer 0-100,',
      '  "ambiguous_fields": array',
      '}',
      '',
      'PER-FIELD CONFIDENCE (Sleep-style, REQUIRED):',
      'For EACH exercise, populate `missing` with any fields the user did NOT',
      'explicitly say. Allowed values: "exercise", "muscle_group", "sets_count",',
      '"reps", "weight". This drives the UI: confident fields render normally,',
      'fields in `missing` show a "tap to fill" picker.',
      '',
      'Examples:',
      '- User says "I did bench press" → exercise: "Bench Press", muscle_group:',
      '  "chest", sets: [{reps:0, weight_kg:0}], missing: ["sets_count","reps","weight"]',
      '- User says "bench, 4 sets" → sets: [4 placeholder sets with reps:0, weight_kg:0],',
      '  missing: ["reps","weight"]',
      '- User says "bench, 4 sets of 8" → sets: [4 sets with reps:8, weight_kg:0],',
      '  missing: ["weight"]',
      '- User says "bench 4 sets of 8 at 80" → sets fully filled, missing: []',
      '- Bodyweight exercises (pull-ups, dips, push-ups, planks): weight_kg=0 is',
      '  CORRECT — DO NOT add "weight" to missing. They\'re bodyweight by design.',
      '',
      'If you cannot parse confidently, set confidence ≤60 and list every uncertain field.',
    ].join('\n');

    const responseSchema = {
      type: 'object',
      properties: {
        exercises: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              exercise:     { type: 'string' },
              muscle_group: { type: 'string' },
              sets: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    reps:      { type: 'integer' },
                    weight_kg: { type: 'number' },
                    rir:       { type: 'integer', nullable: true },
                    notes:     { type: 'string', nullable: true },
                  },
                  required: ['reps', 'weight_kg'],
                },
              },
              missing: { type: 'array', items: { type: 'string' } },
            },
            required: ['exercise', 'sets'],
          },
        },
        session_notes:    { type: 'string', nullable: true },
        confidence:       { type: 'integer' },
        ambiguous_fields: { type: 'array', items: { type: 'string' } },
      },
      required: ['exercises', 'confidence'],
    };

    const t0 = Date.now();
    let parsed = null;
    let usedModel = 'unknown';

    // Gemini Flash primary
    parsed = await callGeminiVision({
      systemPrompt,
      userText: `User said: "${text}"`,
      images: [],
      responseSchema,
      maxOutputTokens: 500,
      model: AI.VISION_PRIMARY,
      label: 'fitness-describe',
    });
    if (parsed) usedModel = 'gemini-2.5-flash';

    // No images here, so vision-router degrades. Try OpenAI direct as fallback.
    if (!parsed) {
      try {
        const completion = await openai.chat.completions.create({
          model: AI.CHAT_STREAM,
          max_completion_tokens: 500,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `User said: "${text}"` },
          ],
          response_format: { type: "json_object" },
        });
        const raw = completion.choices?.[0]?.message?.content?.trim() || "{}";
        parsed = JSON.parse(raw);
        usedModel = "gpt-4.1-mini";
      } catch (e) {
        log.error("[fitness] /describe parse fail:", e?.message);
        return res.status(502).json({ error: "AI response unparseable" });
      }
    }

    // ── Sanitize ── normalize legacy shape (single `exercise` + `sets`) into
    // the new `exercises[]` array so downstream code only handles one shape.
    const VALID_MUSCLE_GROUPS = new Set([
      'chest', 'back', 'legs', 'shoulders', 'arms', 'core', 'cardio', 'full_body',
    ]);
    const sanitizeSets = (raw) => (Array.isArray(raw) ? raw.slice(0, 20) : [])
      .map(s => ({
        reps:      Math.max(0, Math.min(100, parseInt(s.reps, 10) || 0)),
        weight_kg: Math.max(0, Math.min(500, parseFloat(s.weight_kg) || 0)),
        ...(Number.isFinite(parseInt(s.rir, 10)) ? { rir: Math.max(0, Math.min(10, parseInt(s.rir, 10))) } : {}),
        ...(s.notes ? { notes: String(s.notes).slice(0, 100) } : {}),
      }));
    // Note: NO filter here. Placeholder sets (reps=0, weight=0) are kept
    // when the exercise has "reps"/"weight"/"sets_count" in `missing` so
    // the FE can render "tap to fill" pickers. canSave on FE blocks the
    // save button until reps > 0 on every set.

    const VALID_MISSING = new Set([
      'exercise', 'muscle_group', 'sets_count', 'reps', 'weight',
    ]);
    const sanitizeMissing = (raw) => (Array.isArray(raw) ? raw : [])
      .map(s => String(s || '').toLowerCase().trim())
      .filter(s => VALID_MISSING.has(s));

    let exercisesRaw = Array.isArray(parsed.exercises) ? parsed.exercises : null;
    if (!exercisesRaw && parsed.exercise) {
      // Legacy single-shape fallback
      exercisesRaw = [{ exercise: parsed.exercise, muscle_group: parsed.muscle_group, sets: parsed.sets }];
    }
    exercisesRaw = exercisesRaw || [];

    const buildExercises = (rawList) => (rawList || []).slice(0, 10).map(ex => {
      const name = String(ex.exercise || '').slice(0, 60);
      const mg = String(ex.muscle_group || '').toLowerCase();
      return {
        exercise:     name,
        muscle_group: VALID_MUSCLE_GROUPS.has(mg) ? mg : null,
        sets:         sanitizeSets(ex.sets),
        missing:      sanitizeMissing(ex.missing),
      };
    }).filter(ex => ex.exercise && ex.sets.length > 0);

    let exercises = buildExercises(exercisesRaw);
    let cleanedTranscript = text;
    let confidence = Math.max(0, Math.min(100, parseInt(parsed.confidence, 10) || 60));
    const ambiguous = Array.isArray(parsed.ambiguous_fields) ? parsed.ambiguous_fields.slice(0, 5) : [];

    // ── Cleanup-then-reparse fallback ──
    // If the first parse produced 0 exercises, the transcript was probably
    // mangled by ASR (e.g. "got 1210 nine and seven" instead of "got 12, 10,
    // 9, and 7"). Run a focused cleanup LLM pass that ONLY fixes obvious
    // ASR errors and returns a cleaner sentence — then re-parse that.
    if (exercises.length === 0) {
      try {
        const cleanupSystem = [
          'You are cleaning up a transcript from on-device speech recognition (iOS Speech / Android SpeechRecognizer) before it is sent to a workout-parser AI.',
          '',
          'CONTEXT: User just spoke a workout log. The raw transcript HAS errors:',
          '- Numbers smashed together: "1210" → "12, 10"; "987" → "9, 8, 7" (when context = list of rep counts)',
          '- Word-as-number: "ate" → "8", "for"/"fore" → "4", "to"/"too" → "2"',
          '- Missing punctuation: "got 1210 nine and seven" → "got 12, 10, 9, and 7"',
          '- Misspelled fitness terms: "raps"→"reps", "are I are"→"RIR", "are pee"→"RPE", "am rap"→"AMRAP", "bench priest"→"bench press"',
          '- Filler swaps: "did pull-ups of failure" → "did pull-ups to failure"',
          '',
          'TASK: Return the user\'s most likely original sentence. Keep their voice and intent.',
          'If a multi-digit number is OBVIOUSLY a list of rep counts (e.g., "1210" right before "nine and seven"), split it. Be conservative — don\'t invent numbers that weren\'t there.',
          '',
          'OUTPUT: ONLY the cleaned sentence as plain text. No JSON, no quotes, no preamble.',
        ].join('\n');

        const cleanup = await openai.chat.completions.create({
          model: AI.REASONING_FAST,
          max_completion_tokens: 200,
          messages: [
            { role: 'system', content: cleanupSystem },
            { role: 'user', content: text },
          ],
        });
        const candidate = (cleanup.choices?.[0]?.message?.content || '').trim();
        if (candidate && candidate !== text) {
          cleanedTranscript = candidate.slice(0, 600);
          // Re-parse with the cleaned text
          const reParsed = await callGeminiVision({
            systemPrompt,
            userText: `User said: "${cleanedTranscript}"`,
            images: [],
            responseSchema,
            maxOutputTokens: 500,
            model: AI.VISION_PRIMARY,
            label: 'fitness-describe-cleanup',
          });
          if (reParsed) {
            const reExercises = Array.isArray(reParsed.exercises)
              ? reParsed.exercises
              : (reParsed.exercise ? [{ exercise: reParsed.exercise, muscle_group: reParsed.muscle_group, sets: reParsed.sets }] : []);
            const built = buildExercises(reExercises);
            if (built.length > 0) {
              exercises = built;
              confidence = Math.max(0, Math.min(100, parseInt(reParsed.confidence, 10) || confidence));
              usedModel = `${usedModel}+cleanup-gpt-4o-mini`;
            }
          }
        }
      } catch (e) {
        log.warn('[fitness] cleanup-reparse fail:', e?.message);
      }
    }

    // ── Never-fail response ──
    // Whether or not we parsed anything, return ok:true with a clear shape.
    // The FE always opens the confirm sheet; a blank starter row appears if
    // exercises is empty, so the user can fill manually instead of seeing
    // a red error.
    res.json({
      ok: true,
      exercises,
      session_notes:    parsed.session_notes ? String(parsed.session_notes).slice(0, 280) : null,
      confidence:       exercises.length === 0 ? Math.max(20, confidence) : confidence,
      ambiguous_fields: ambiguous,
      empty_reason:     exercises.length === 0
        ? "Couldn't pick up exercises — fill in below."
        : undefined,
      latency_ms:       Date.now() - t0,
      model:            usedModel,
    });
  } catch (e) {
    log.error("[fitness] /describe:", e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Per-exercise calibration (Phase 7C) ──────────────────────
// Tracks user's reps↔weight correlations per exercise so we can refine
// 1RM estimates and tighten the auto-progression suggestion ranges.
router.post("/calibration", async (req, res) => {
  try {
    const { deviceId, exercise, ai_weight_kg, user_weight_kg, reps_completed } = req.body || {};
    if (!deviceId || !exercise) return res.status(400).json({ error: "deviceId + exercise required" });
    const a = Number(ai_weight_kg), u = Number(user_weight_kg);
    if (!Number.isFinite(a) || !Number.isFinite(u) || a < 1 || u < 1) {
      return res.status(400).json({ error: "invalid weights" });
    }
    const newRatio = u / a;
    if (newRatio < 0.3 || newRatio > 3.0) return res.json({ ok: true, skipped: "ratio_out_of_range" });

    const docId = exercise.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 60);
    const ref = fitnessDoc(deviceId).collection("calibration").doc(docId);
    await admin.firestore().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const existing = snap.exists ? snap.data() : null;
      const oldRatio = existing?.ratio ?? 1.0;
      const oldN     = Math.min(existing?.sample_count ?? 0, 20);
      const newN     = oldN + 1;
      const blendedRatio = (oldRatio * oldN + newRatio) / newN;
      tx.set(ref, {
        exercise,
        ratio:        +blendedRatio.toFixed(3),
        sample_count: newN,
        last_ai_kg:   Math.round(a * 10) / 10,
        last_user_kg: Math.round(u * 10) / 10,
        last_reps:    Number.isFinite(parseInt(reps_completed, 10)) ? parseInt(reps_completed, 10) : null,
        updated_at:   admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    res.json({ ok: true });
  } catch (e) {
    log.error("[fitness] /calibration:", e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Cross-agent signals writer (Phase 6) ─────────────────────
// After every session end, write 5 derived signals to cross_agent/today_signals.
// Sibling agents (Mind, Nutrition, Water, Sleep) read these in their own
// crossAgentEnricher functions to surface coordinated next-step actions.
async function writeFitnessCrossAgentSignals(deviceId, session) {
  const totalSets = session.total_sets || 0;
  const totalVol  = session.total_volume_kg || 0;
  const rpe       = session.rpe_avg || 5;
  const quality   = session.session_quality || 0;

  const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000);
  const out = {
    fitness_post_workout_mood_boost: quality >= 60 ? {
      expected: true,
      score:    Math.min(100, Math.round(quality * 1.1)),
      reason:   `Session quality ${quality}/100`,
      expires_at: expiresAt,
    } : null,
    fitness_protein_demand_urgent: totalSets >= 16 ? {
      delta_g: Math.min(40, Math.round(totalSets * 1.5)),
      reason:  `${totalSets} sets logged — prioritize +protein meal next 90min`,
      expires_at: expiresAt,
    } : null,
    fitness_water_intake_boost: rpe >= 7 ? {
      delta_ml: Math.min(800, Math.round(rpe * 80)),
      reason:   `RPE ${rpe.toFixed(1)} session — bump hydration`,
      expires_at: expiresAt,
    } : null,
    fitness_sleep_quality_needed: (totalVol >= 5000 || rpe >= 8) ? {
      priority: "high",
      reason:   "Heavy session — prioritize 8h+ sleep tonight",
      expires_at: expiresAt,
    } : null,
    fitness_cardiovascular_load: rpe >= 6 ? {
      score:           Math.min(100, Math.round(rpe * 10 + totalVol / 200)),
      recovery_hours:  rpe >= 8 ? 48 : 24,
      expires_at:      expiresAt,
    } : null,
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  };

  // Strip nulls so we only write meaningful keys.
  const filtered = {};
  for (const [k, v] of Object.entries(out)) {
    if (v !== null) filtered[k] = v;
  }

  await userDoc(deviceId).collection("cross_agent").doc("today_signals")
    .set(filtered, { merge: true });
}

// GET /today
router.get("/today", async (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const today = dateStr();
    const cutoff29 = new Date();
    cutoff29.setDate(cutoff29.getDate() - 29);
    // Widen to 42 days so the same-day-last-week suggestion has 5-6 prior
    // occurrences of today's day-of-week to compute frequency from.
    const cutoff42 = new Date();
    cutoff42.setDate(cutoff42.getDate() - 41);

    // Parallel — all Firestore reads fire simultaneously (no sequential round trips)
    const [todaySnap, calSnap, dowSnap, lastSnap, fDoc, wHistSnap, crossAgentResults] = await Promise.all([
      workoutsCol(deviceId).where("date", "==", today).get(),
      workoutsCol(deviceId).where("date", ">=", dateStr(cutoff29)).get(),
      // Wider pull just for the same-day-last-week feature
      workoutsCol(deviceId).where("date", ">=", dateStr(cutoff42)).get().catch(() => ({ docs: [] })),
      workoutsCol(deviceId).orderBy("logged_at", "desc").limit(5).get(),
      fitnessDoc(deviceId).get(),
      workoutsCol(deviceId).orderBy('logged_at', 'desc').limit(20).get().catch(() => ({ docs: [] })),
      // Cross-agent law: read pre-computed signals from cross_agent/today_signals
      // (single sandbox-safe collection). wellness.cross.js writes the data there.
      userDoc(deviceId).collection('cross_agent').doc('today_signals').get().catch(() => null),
    ]);
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
    const calDates = {};
    for (const d of calSnap.docs) {
      const w = d.data();
      if (!calDates[w.date]) calDates[w.date] = { has_pr: false };
      if ((w.personal_records || []).length > 0) calDates[w.date].has_pr = true;
    }
    // Registration Anchor Law: never iterate past anchor.
    const calendarDays = [];
    {
      const _anchor = await resolveAnchor(deviceId);
      const { enumerateDaysFrom: _enum } = require('./lib/range-helpers');
      const _todayKey = dateStr();
      const _dt = new Date(); _dt.setDate(_dt.getDate() - 29);
      const _candidate = dateStr(_dt);
      const _start = _anchor.anchorDateStr && _candidate < _anchor.anchorDateStr ? _anchor.anchorDateStr : _candidate;
      for (const ds of _enum(_start, _todayKey)) {
        calendarDays.push({
          date: ds,
          has_workout: !!calDates[ds],
          has_pr: calDates[ds]?.has_pr || false,
        });
      }
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

    // ── Readiness Score (40% sleep + 25% hydration + 20% mind + 15% training load) ──
    // Cross-agent law: scores are derived from cross_agent/today_signals which
    // wellness.cross.js writes after reading sibling agents (the only place
    // allowed to read across). We never read agents/{sibling} from here.
    let readiness_score = null;
    try {
      const xData = (crossAgentResults && crossAgentResults.exists)
        ? (crossAgentResults.data() || {})
        : {};

      // Sleep component: avg quality from recent_sleep_summary (0-100 scale)
      const sleepEntries = xData.recent_sleep_summary?.entries || [];
      const sleepScore = sleepEntries.length
        ? Math.round(sleepEntries.reduce((s, e) => s + (e.quality_score || 50), 0) / sleepEntries.length)
        : 60;

      // Hydration component: water_intake_pct (already 0-100)
      const hydrationScore = xData.water_intake_pct != null
        ? Math.min(100, Math.max(0, xData.water_intake_pct))
        : 50;

      // Mind component: mind_recent_mood_score (0-100, default 60)
      const mindScore = xData.mind_recent_mood_pct != null
        ? Math.min(100, Math.max(0, xData.mind_recent_mood_pct))
        : 60;

      // Training load (ATL) component: more recent volume = more fatigue → lower readiness
      // Use last 7d sets vs 14d sets. High recent load = lower score.
      const cutoff7d  = Date.now() - 7  * 86400000;
      const cutoff14d = Date.now() - 14 * 86400000;
      const sets7d  = calWorkouts.filter(w => getMillis(w.logged_at) >= cutoff7d).reduce((s, w) => s + (w.total_sets || 0), 0);
      const sets14d = calWorkouts.filter(w => getMillis(w.logged_at) >= cutoff14d && getMillis(w.logged_at) < cutoff7d).reduce((s, w) => s + (w.total_sets || 0), 0);
      const loadRatio = sets14d > 0 ? sets7d / sets14d : (sets7d > 0 ? 1.2 : 1);
      // loadRatio > 1.2 = high fatigue → low score; < 0.8 = fresh → high score
      const loadScore = Math.min(100, Math.max(0, Math.round((1.5 - loadRatio) / 0.7 * 100)));

      readiness_score = {
        total: Math.round(sleepScore * 0.40 + hydrationScore * 0.25 + mindScore * 0.20 + loadScore * 0.15),
        components: { sleep: sleepScore, hydration: hydrationScore, mind: mindScore, load: loadScore },
      };
    } catch { /* readiness is non-fatal */ }

    // ── Progression suggestions (RPE-based) for top exercises ──
    let progression_suggestions = null;
    try {
      const wHist = wHistSnap.docs.map(mapDoc);
      const exMap = {};
      for (const w of wHist) {
        for (const ex of w.exercises || []) {
          if (!exMap[ex.name]) exMap[ex.name] = [];
          exMap[ex.name].push({ date: w.date, sets: ex.sets || [] });
        }
      }
      const suggestions = {};
      for (const [name, history] of Object.entries(exMap)) {
        if (history.length < 2) continue;
        const last2 = history.slice(0, 2);
        const avgRpe0 = last2[0].sets.reduce((s, st) => s + (st.rpe || 0), 0) / (last2[0].sets.filter(s => s.rpe).length || 1);
        const avgRpe1 = last2[1].sets.reduce((s, st) => s + (st.rpe || 0), 0) / (last2[1].sets.filter(s => s.rpe).length || 1);
        const hasBothRpe = last2[0].sets.some(s => s.rpe) && last2[1].sets.some(s => s.rpe);
        const maxWeight = Math.max(...last2[0].sets.map(s => s.weight_kg || 0));
        if (!hasBothRpe || !maxWeight) continue;
        // RPE ≤ 7 twice → progress (+2.5kg); RPE ≥ 9 → hold; 3x increase needed → deload
        if (avgRpe0 <= 7 && avgRpe1 <= 7) {
          suggestions[name] = { action: 'increase', amount: 2.5, msg: `+2.5kg — RPE ${Math.round(avgRpe0)}/10, ready to progress` };
        } else if (avgRpe0 >= 9) {
          suggestions[name] = { action: 'hold', msg: `Hold — RPE ${Math.round(avgRpe0)}/10, consolidate before adding load` };
        }
      }
      if (Object.keys(suggestions).length > 0) progression_suggestions = suggestions;
    } catch { /* non-fatal */ }

    // ── Same-day-last-week suggestion ──
    // Aha-moment feature: most lifters train the same split on the same day
    // each week. If today is Monday and the user trained chest last Monday,
    // the Track tab surfaces a "Typical Monday — Push Day" pre-fill card.
    //
    // Logic:
    //   1. Compute today's DOW (0=Sun..6=Sat).
    //   2. From last 42 days of workouts, find docs whose DOW matches.
    //   3. Skip if user has already logged anything today.
    //   4. Pick the most recent matching session (≤ 35 days_ago).
    //   5. Compute frequency: how many of last 5 same-DOW occurrences
    //      had any workout, and how many matched the latest's pattern.
    //   6. Derive a session label from the dominant muscle groups.
    //   7. Optionally attach a progression hint per exercise (RPE-aware).
    //
    // Sandbox-safe: pure fitness data, no sibling-agent reads.
    let same_day_suggestion = null;
    try {
      const todayDow = new Date().getDay();
      const alreadyLoggedToday = todayDocs.length > 0;

      // Helper: parse 'YYYY-MM-DD' → DOW. Use noon to dodge DST drift.
      const dowOf = (ds) => {
        if (!ds || typeof ds !== 'string') return -1;
        const [y, m, d] = ds.split('-').map(Number);
        if (!y || !m || !d) return -1;
        return new Date(y, m - 1, d, 12, 0, 0).getDay();
      };
      const daysBetween = (a, b) => {
        // a, b = 'YYYY-MM-DD' — exact integer day delta.
        const [ay, am, ad] = a.split('-').map(Number);
        const [by, bm, bd] = b.split('-').map(Number);
        const aMs = new Date(ay, am - 1, ad, 12, 0, 0).getTime();
        const bMs = new Date(by, bm - 1, bd, 12, 0, 0).getTime();
        return Math.round((aMs - bMs) / 86400000);
      };

      if (!alreadyLoggedToday && isTrainingDay) {
        // Build same-DOW workout pool from the 42-day window
        // PAST same-DOW only. Strictly `data.date < today` so any
        // accidentally-future-dated docs cannot produce negative days_ago.
        const dowDocs = (dowSnap.docs || [])
          .map(d => ({ data: d.data() }))
          .filter(({ data }) => data.date && data.date < today && dowOf(data.date) === todayDow)
          .sort((a, b) => (a.data.date < b.data.date ? 1 : -1)); // newest first

        if (dowDocs.length > 0) {
          // Pick the most recent same-DOW doc — but only if within 35 days.
          // Anything older than 5 weeks feels like stale memory and should not
          // be surfaced as "your routine".
          const latest = dowDocs[0].data;
          const days_ago = daysBetween(today, latest.date);
          if (days_ago <= 35) {
            // Frequency: how many of last 5 same-DOW slots had ANY workout
            const fiveSlots = [];
            for (let k = 1; k <= 5; k++) {
              const dt = new Date();
              dt.setDate(dt.getDate() - 7 * k);
              fiveSlots.push(dateStr(dt));
            }
            const slotHits = fiveSlots.filter(s => dowDocs.some(({ data }) => data.date === s)).length;

            // Pattern match: does each of last 5 same-DOW workouts share
            // ≥50% of muscle groups with the latest? Higher = more typical.
            const latestMG = new Set(
              (latest.exercises || []).map(e => e.muscle_group).filter(Boolean),
            );
            const sameDowList = dowDocs.slice(0, 5).map(d => d.data);
            const patternMatches = sameDowList.filter(d => {
              const dMg = new Set((d.exercises || []).map(e => e.muscle_group).filter(Boolean));
              if (latestMG.size === 0 || dMg.size === 0) return false;
              const common = [...latestMG].filter(x => dMg.has(x)).length;
              return common / latestMG.size >= 0.5;
            }).length;

            // Confidence label
            let confidence, label;
            const dowName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][todayDow];
            if (days_ago > 14) {
              confidence = 'stale';
              const wks = Math.round(days_ago / 7);
              label = `${wks} week${wks === 1 ? '' : 's'} ago — ${dowName}`;
            } else if (patternMatches >= 3) {
              confidence = 'high';
              label = `Typical ${dowName}`;
            } else if (patternMatches === 2) {
              confidence = 'mid';
              label = `Last 2 ${dowName}s`;
            } else {
              confidence = 'low';
              label = `Last ${dowName}`;
            }

            // Session label — heuristic from muscle group set
            const mgs = [...latestMG];
            const has = (g) => mgs.includes(g);
            let session_label = 'Workout';
            if ((has('chest') || has('shoulders')) && (has('arms') || mgs.length === 2)) session_label = 'Push Day';
            else if (has('back') && (has('arms') || mgs.length <= 2)) session_label = 'Pull Day';
            else if (has('legs') || has('core')) session_label = 'Leg Day';
            else if (mgs.length >= 3) session_label = 'Full Body';
            else if (has('chest')) session_label = 'Chest Day';
            else if (has('back')) session_label = 'Back Day';
            else if (has('shoulders')) session_label = 'Shoulder Day';
            else if (has('arms')) session_label = 'Arm Day';
            else if (has('cardio')) session_label = 'Cardio';

            // Progression hints per exercise (reuse RPE-based logic)
            const progression_hint = {};
            for (const ex of (latest.exercises || [])) {
              const name = ex.name;
              if (!name) continue;
              const sets = ex.sets || [];
              const rpeSets = sets.filter(s => Number.isFinite(s.rpe));
              if (rpeSets.length === 0) continue;
              const avgRpe = rpeSets.reduce((s, x) => s + x.rpe, 0) / rpeSets.length;
              if (avgRpe <= 7) {
                progression_hint[name] = { suggest: '+2.5kg', reason: `Last ${dowName}: RPE ${Math.round(avgRpe)} — ready` };
              } else if (avgRpe >= 9) {
                progression_hint[name] = { suggest: 'hold', reason: `Last ${dowName}: RPE ${Math.round(avgRpe)} — consolidate` };
              }
            }

            // Total stats
            const total_sets = (latest.exercises || []).reduce((a, e) => a + (e.sets || []).length, 0);
            const total_volume_kg = (latest.exercises || []).reduce(
              (a, e) => a + (e.sets || []).reduce((s, st) => s + (st.reps || 0) * (st.weight_kg || 0), 0),
              0,
            );

            same_day_suggestion = {
              source_date: latest.date,
              source_dow: todayDow,
              days_ago,
              session_label,
              frequency: {
                same_dow_count: slotHits,
                same_pattern_count: patternMatches,
                label,
                confidence,
              },
              exercises: (latest.exercises || []).map(e => ({
                name: e.name,
                muscle_group: e.muscle_group || null,
                sets: (e.sets || []).map(s => ({
                  reps: s.reps || 0,
                  weight_kg: s.weight_kg || 0,
                  rpe:  Number.isFinite(s.rpe) ? s.rpe : null,
                })),
              })),
              total_sets,
              total_volume_kg: Math.round(total_volume_kg),
              progression_hint: Object.keys(progression_hint).length ? progression_hint : null,
            };
          }
        }
      }
    } catch (e) {
      log.warn('[fitness] same_day_suggestion fail:', e?.message);
    }

    return res.json({
      today_workout: todayWorkout,
      calendar_days: calendarDays,
      streak,
      this_week_count: thisWeekCount,
      last_session: lastSession,
      is_training_day: isTrainingDay,
      preferred_split: setup.preferred_split || null,
      readiness_score,
      progression_suggestions,
      same_day_suggestion,
    });
  } catch (e) {
    log.error("[fitness] today:", e);
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
    log.error("[fitness] workout-dates:", e);
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
    log.error("[fitness] day:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// GET /last-session — returns last workout for auto-fill + split rotation.
// Includes `muscle_group` so the FE TodayPlanBanner can compute the next
// split (push → pull → legs) without a second round trip.
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
          // Stored field on the workout doc (set at /log time via
          // detectMuscleGroup). Falls back to a name-based guess if the
          // doc was written before that field existed.
          muscle_group: ex.muscle_group || detectMuscleGroup(ex.name),
          sets: (ex.sets || []).map((s) => ({
            reps:      s.reps,
            weight_kg: s.weight_kg,
            ...(Number.isFinite(s.rpe) ? { rpe: s.rpe } : {}),
          })),
        })),
      },
    });
  } catch (e) {
    log.error("[fitness] last-session:", e);
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
    log.error("[fitness] check-in:", e);
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
// ─── GET /analysis — V4 frontend tab payload ────────────────
// Matches the contract emitted by Water + Nutrition V4 endpoints:
// fitness_score, score_grade, signal_points, daily_logs,
// top_exercises, bottom_exercises, ai_reads, aha_moments,
// hero_insight, stats, vol_target, sets_target, etc.
//
// For day-1 / cold-start users, returns the schema with empty arrays
// + a hero_insight prompting them to log their first session.

// ─── Helpers for new analysis sections (muscle/skip/PRs/strength) ──

const _VOLUME_LANDMARKS = {
  chest:      { mev: 10, mav: [12, 16], mrv: 20 },
  back:       { mev: 10, mav: [14, 22], mrv: 25 },
  shoulders:  { mev: 8,  mav: [16, 22], mrv: 26 },
  legs:       { mev: 8,  mav: [12, 18], mrv: 20 },
  biceps:     { mev: 8,  mav: [14, 20], mrv: 26 },
  triceps:    { mev: 8,  mav: [14, 20], mrv: 26 },
  calves:     { mev: 8,  mav: [12, 16], mrv: 20 },
};

function computeMuscleVolume(workouts, rangeDays) {
  if (!workouts.length) return [];
  const weeks = Math.max(1, rangeDays / 7);
  const totalSets = {};
  workouts.forEach((w) => {
    (w.exercises || []).forEach((ex) => {
      const m = ex.muscle_group;
      if (!m || !_VOLUME_LANDMARKS[m]) return;
      totalSets[m] = (totalSets[m] || 0) + (ex.sets?.length || 0);
    });
  });
  return Object.keys(_VOLUME_LANDMARKS).map((muscle) => {
    const total = totalSets[muscle] || 0;
    const weekly = Math.round(total / weeks);
    const lm = _VOLUME_LANDMARKS[muscle];
    let status = 'in_mav';
    let label  = 'In MAV';
    if (weekly < lm.mev)         { status = 'below_mev'; label = 'Below MEV'; }
    else if (weekly < lm.mav[0]) { status = 'mev_to_mav'; label = 'Building'; }
    else if (weekly > lm.mrv)    { status = 'over_mrv'; label = 'Over MRV'; }
    else if (weekly > lm.mav[1]) { status = 'mav_to_mrv'; label = 'Pushing limit'; }
    return {
      muscle,
      weekly_sets: weekly,
      total_sets:  total,
      mev: lm.mev,
      mav_low: lm.mav[0],
      mav_high: lm.mav[1],
      mrv: lm.mrv,
      status,
      status_label: label,
    };
  }).sort((a, b) => b.weekly_sets - a.weekly_sets);
}

function computeSkipPattern(workouts, rangeDays) {
  // Best-effort skip detection: assume planned days from setup.training_days.
  // We only have logged dates; "skipped" = day-of-week pattern with logs <
  // expected occurrences in the range.
  const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (!workouts.length) return { days: [], insight: '' };
  const loggedByDow = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  workouts.forEach((w) => {
    if (!w.date) return;
    const d = new Date(w.date + 'T12:00:00');
    loggedByDow[d.getDay()]++;
  });
  const occurrencesByDow = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (let i = 0; i < rangeDays; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    occurrencesByDow[d.getDay()]++;
  }
  const days = [];
  for (let dow = 1; dow <= 6; dow++) {
    const planned = occurrencesByDow[dow];
    const logged  = loggedByDow[dow];
    const skipped = Math.max(0, planned - logged);
    days.push({
      dow,
      label: DOW_LABELS[dow],
      planned,
      skipped,
      skip_pct: planned ? Math.round((skipped / planned) * 100) : 0,
    });
  }
  days.sort((a, b) => b.skip_pct - a.skip_pct);
  const top = days[0];
  const insight = top && top.skip_pct >= 25
    ? `${top.label}s slip the most (${top.skip_pct}%). Lock it in for one week to break the cycle.`
    : '';
  return { days, most_skipped_dow: top?.label || null, insight };
}

function computePRReel(workouts) {
  // Find each exercise's max e1RM in the period. PRs = those that beat the prior period.
  const today = Date.now();
  const map = {};
  [...workouts].reverse().forEach((w) => {
    (w.exercises || []).forEach((ex) => {
      (ex.sets || []).forEach((st) => {
        if (!st.e1rm || !ex.name) return;
        if (!map[ex.name] || map[ex.name].e1rm < st.e1rm) {
          map[ex.name] = {
            exercise: ex.name,
            weight_kg: st.weight_kg || 0,
            reps:      st.reps || 0,
            e1rm:      st.e1rm,
            date:      w.date,
            days_ago:  Math.floor((today - new Date(w.date + 'T12:00:00').getTime()) / 86400000),
            emoji:     '🏆',
          };
        }
      });
    });
  });
  return Object.values(map)
    .sort((a, b) => a.days_ago - b.days_ago)
    .slice(0, 6);
}

function computeStrengthTrend(workouts, rangeDays) {
  // For each top exercise, sample top weight across 4 evenly-spaced windows.
  if (workouts.length < 2) return [];
  const exTopByDate = {};
  workouts.forEach((w) => {
    (w.exercises || []).forEach((ex) => {
      if (!ex.name) return;
      const top = (ex.sets || []).reduce((m, s) => Math.max(m, s.weight_kg || 0), 0);
      if (!exTopByDate[ex.name]) exTopByDate[ex.name] = {};
      const cur = exTopByDate[ex.name][w.date] || 0;
      exTopByDate[ex.name][w.date] = Math.max(cur, top);
    });
  });
  // Pick top 3 by max-weight overall
  const ranked = Object.entries(exTopByDate)
    .map(([name, byDate]) => ({ name, max: Math.max(...Object.values(byDate)) }))
    .sort((a, b) => b.max - a.max)
    .slice(0, 3);
  const buckets = Math.min(4, Math.max(2, Math.floor(rangeDays / 7)));
  return ranked.map((r) => {
    const dates = Object.keys(exTopByDate[r.name]).sort();
    if (dates.length < 2) return null;
    const points = [];
    const chunkSize = Math.max(1, Math.floor(dates.length / buckets));
    for (let i = 0; i < buckets; i++) {
      const slice = dates.slice(i * chunkSize, (i + 1) * chunkSize);
      if (!slice.length) continue;
      const maxInWindow = Math.max(...slice.map((d) => exTopByDate[r.name][d]));
      points.push(maxInWindow);
    }
    if (points.length < 2) return null;
    const delta = ((points[points.length - 1] - points[0]) / Math.max(points[0], 1)) * 100;
    return {
      exercise:  r.name,
      unit:      'kg',
      points,
      delta_pct: +delta.toFixed(1),
    };
  }).filter(Boolean);
}

// ─── LLM-driven insights for /analysis ─────────────────────
// Caches per (deviceId, range) for 10 minutes so tab switches don't burn
// LLM tokens. Cross-agent context (sleep, mind, water, protein) read only
// from cross_agent/today_signals (sandbox-safe — no sibling reads).
const _v2InsightCache = new Map();
const _V2_CACHE_TTL = 10 * 60 * 1000;

function _v2CacheGet(deviceId, range) {
  const key = `${deviceId}:${range}`;
  const v = _v2InsightCache.get(key);
  if (!v) return null;
  if (Date.now() - v.t > _V2_CACHE_TTL) { _v2InsightCache.delete(key); return null; }
  return v.data;
}
function _v2CacheSet(deviceId, range, data) {
  _v2InsightCache.set(`${deviceId}:${range}`, { t: Date.now(), data });
  if (_v2InsightCache.size > 500) _v2InsightCache.delete(_v2InsightCache.keys().next().value);
}

async function _generateFitnessV2Insights(deviceId, range, ctx) {
  const cached = _v2CacheGet(deviceId, range);
  if (cached) return cached;

  // Pull cross-agent signals (sandbox-safe — only reads cross_agent/today_signals)
  let crossCtx = '';
  try {
    const xSnap = await userDoc(deviceId).collection('cross_agent').doc('today_signals').get();
    if (xSnap.exists) {
      const x = xSnap.data() || {};
      const bits = [];
      const sleepEntries = x.recent_sleep_summary?.entries || [];
      if (sleepEntries.length) {
        const avgQ = Math.round(sleepEntries.reduce((s, e) => s + (e.quality_score || 50), 0) / sleepEntries.length);
        bits.push(`Recent sleep avg quality ${avgQ}/100 over ${sleepEntries.length} nights.`);
      }
      if (x.mind_anxiety_level != null) bits.push(`Mind anxiety ${x.mind_anxiety_level}/5.`);
      if (x.nutrition_protein_target_pct != null) bits.push(`Protein hit ${x.nutrition_protein_target_pct}% of target.`);
      if (x.water_intake_pct != null) bits.push(`Hydration ${x.water_intake_pct}% of goal.`);
      crossCtx = bits.join(' ');
    }
  } catch { /* non-fatal */ }

  const muscleSnapshot = (ctx.muscle_volume || []).slice(0, 5)
    .map(m => `${m.muscle}: ${m.weekly_sets}sets/wk (${m.status_label}, MEV ${m.mev}/MAV ${m.mav_low}-${m.mav_high}/MRV ${m.mrv})`)
    .join(' · ');
  const strengthDelta = (ctx.strength_trend || [])
    .map(t => `${t.exercise} ${t.delta_pct >= 0 ? '+' : ''}${t.delta_pct}%`)
    .join(', ');
  const skipTop = ctx.skip_pattern?.days?.[0];
  const skipNote = skipTop && skipTop.skip_pct >= 20
    ? `Most-skipped: ${skipTop.label} ${skipTop.skip_pct}%.`
    : 'No major skip pattern.';

  const systemPrompt = [
    'You are a sharp fitness coach generating analysis insights for the user.',
    'Output STRICT JSON only. No prose, no markdown.',
    '',
    'You will receive aggregated training data + cross-agent context (sleep, mind, nutrition, water).',
    'Generate exactly 3 ai_reads + 3 aha_moments + 1 hero_headline.',
    '',
    'AI READS (one each, exactly these kinds):',
    '  - { kind: "champion", title, body, action }     — biggest signal of working',
    '  - { kind: "drag",     title, body, action }     — biggest gap / bottleneck',
    '  - { kind: "pattern",  title, body, action }     — behavioral or cross-agent pattern',
    '  Title = ≤9 words. Body = ≤40 words, cite real numbers from the data. Action = ≤14 words, imperative.',
    '',
    'AHA MOMENTS (3 observations):',
    '  - { kpi, body }',
    '  KPI = short headline ("Volume +18% in 30 days"). Body = ≤30 words explaining.',
    '',
    'HERO HEADLINE: One short factual sentence. ≤22 words. Cite real numbers.',
    '',
    'RULES:',
    '- Use ONLY numbers from the provided data. Never invent values.',
    '- If muscle is below MEV, that is the most likely "drag".',
    '- If a strength trend is +5% or more, that is a strong "champion".',
    '- If sleep < 60/100 avg, that is a top "pattern" candidate (recovery → wobble).',
    '- If skip_pct ≥ 20% on a specific day, surface as a pattern.',
    '- Tone: brutal-honest performance coach. No praise filler. No emojis.',
  ].join('\n');

  const userPrompt = [
    `RANGE: last ${ctx.rangeDays} days.`,
    `SCORE: ${ctx.score}/100 (${ctx.grade}).`,
    `STATS: ${ctx.days_logged} sessions, ${(ctx.total_volume_kg / 1000).toFixed(1)}T volume, avg ${ctx.avg_sets} sets/session, avg RPE ${ctx.avg_rpe}, avg quality ${ctx.avg_quality}/100, streak ${ctx.streak} days, volatility ${ctx.volatility_pct}%.`,
    `MUSCLE COVERAGE: ${muscleSnapshot}`,
    `STRENGTH DELTAS: ${strengthDelta || 'insufficient data'}`,
    `PRS THIS PERIOD: ${(ctx.prs_period || []).length}`,
    `BEST DAY: ${ctx.best_day ? `${ctx.best_day.label} — ${ctx.best_day.total_volume_kg}kg / ${ctx.best_day.session_quality}/100` : 'none'}.`,
    `WORST DAY: ${ctx.worst_day ? `${ctx.worst_day.label} — ${ctx.worst_day.total_volume_kg}kg / ${ctx.worst_day.session_quality}/100` : 'none'}.`,
    `${skipNote}`,
    crossCtx ? `CROSS-AGENT: ${crossCtx}` : '',
  ].filter(Boolean).join('\n');

  // Try Gemini first (deterministic), fall back to OpenAI
  const responseSchema = {
    type: 'object',
    properties: {
      ai_reads: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind:   { type: 'string', enum: ['champion','drag','pattern'] },
            title:  { type: 'string' },
            body:   { type: 'string' },
            action: { type: 'string' },
          },
          required: ['kind','title','body','action'],
        },
      },
      aha_moments: {
        type: 'array',
        items: {
          type: 'object',
          properties: { kpi: { type: 'string' }, body: { type: 'string' } },
          required: ['kpi','body'],
        },
      },
      hero_headline: { type: 'string' },
    },
    required: ['ai_reads','aha_moments','hero_headline'],
  };

  let parsed = null;
  try {
    parsed = await callGeminiVision({
      systemPrompt,
      userText: userPrompt,
      images: [],
      responseSchema,
      maxOutputTokens: 800,
      model: AI.VISION_PRIMARY,
      label: 'fitness-analysis-v2',
    });
  } catch { /* fall through */ }

  if (!parsed) {
    try {
      const completion = await openai.chat.completions.create({
        model: AI.CHAT_STREAM,
        max_completion_tokens: 800,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt },
        ],
        response_format: { type: 'json_object' },
      });
      const raw = completion.choices?.[0]?.message?.content?.trim() || '{}';
      parsed = JSON.parse(raw);
    } catch (e) {
      log.warn('[fitness] V2 LLM both paths failed:', e?.message);
      return null;
    }
  }

  // Sanitize
  const ALLOWED_KINDS = ['champion','drag','pattern'];
  const safe = {
    ai_reads: Array.isArray(parsed.ai_reads)
      ? parsed.ai_reads.filter(r => r && ALLOWED_KINDS.includes(r.kind)).slice(0, 3).map(r => ({
          kind:   r.kind,
          title:  String(r.title || '').slice(0, 80),
          body:   String(r.body || '').slice(0, 220),
          action: String(r.action || '').slice(0, 80),
        }))
      : [],
    aha_moments: Array.isArray(parsed.aha_moments)
      ? parsed.aha_moments.slice(0, 3).map(a => ({
          kpi:  String(a.kpi || '').slice(0, 60),
          body: String(a.body || '').slice(0, 180),
        }))
      : [],
    hero_headline: String(parsed.hero_headline || '').slice(0, 200),
  };

  _v2CacheSet(deviceId, range, safe);
  return safe;
}

// ─── Fallbacks when LLM is unavailable / no key ─────────────
function _fallbackAiReads(ctx) {
  const out = [];
  // Champion: muscle in MAV with most sets
  const champMuscle = (ctx.muscle_volume || []).find(m => m.status === 'in_mav' || m.status === 'mav_to_mrv');
  if (champMuscle) {
    out.push({
      kind: 'champion',
      title: `${champMuscle.muscle.charAt(0).toUpperCase() + champMuscle.muscle.slice(1)} is your strongest signal`,
      body:  `${champMuscle.weekly_sets} sets/wk in MAV range. Sustained volume here drives most of your hypertrophy gains.`,
      action: `Keep ${champMuscle.muscle} sessions locked in.`,
    });
  }
  // Drag: muscle below MEV
  const dragMuscle = (ctx.muscle_volume || []).find(m => m.status === 'below_mev' || m.status === 'mev_to_mav');
  if (dragMuscle) {
    out.push({
      kind: 'drag',
      title: `${dragMuscle.muscle.charAt(0).toUpperCase() + dragMuscle.muscle.slice(1)} volume is your bottleneck`,
      body:  `Only ${dragMuscle.weekly_sets} sets/wk — below MEV (${dragMuscle.mev}). Imbalance compounds over weeks.`,
      action: `Add 4 sets to a ${dragMuscle.muscle} day.`,
    });
  }
  // Pattern: skip
  const skipTop = ctx.skip_pattern?.days?.[0];
  if (skipTop && skipTop.skip_pct >= 20) {
    out.push({
      kind: 'pattern',
      title: `${skipTop.label}s are your most-skipped day`,
      body:  `${skipTop.skip_pct}% miss rate over the period. Pattern compounds — one missed session a week = ~50 fewer sets per quarter.`,
      action: `Block ${skipTop.label}s on the calendar this week.`,
    });
  }
  return out;
}

function _fallbackAhaMoments(ctx) {
  const out = [];
  if (ctx.prs_period?.length >= 1) {
    out.push({
      kpi:  `${ctx.prs_period.length} PR${ctx.prs_period.length > 1 ? 's' : ''} in ${ctx.rangeDays} days`,
      body: `Recent personal records show progressive overload is intact. Top: ${ctx.prs_period[0].exercise} at ${ctx.prs_period[0].weight_kg}kg × ${ctx.prs_period[0].reps}.`,
    });
  }
  if (ctx.streak >= 7) {
    out.push({
      kpi:  `${ctx.streak}-day training streak`,
      body: `Past 14 days = automaticity threshold (Lally 2010). Habit cost drops; you train without deciding.`,
    });
  }
  if (ctx.strength_trend?.[0]?.delta_pct > 3) {
    const t = ctx.strength_trend[0];
    out.push({
      kpi:  `${t.exercise} ${t.delta_pct > 0 ? '+' : ''}${t.delta_pct}% in ${ctx.rangeDays}d`,
      body: `Linear progression intact. Helms 2019 MASS — ${t.delta_pct >= 1 ? '1%+/wk = elite' : 'closer to plateau'}.`,
    });
  }
  return out;
}

function _fallbackHeadline(ctx) {
  const tons = (ctx.total_volume_kg / 1000).toFixed(1);
  const prs = ctx.prs_period?.length || 0;
  const dragMuscle = (ctx.muscle_volume || []).find(m => m.status === 'below_mev');
  const champMuscle = (ctx.muscle_volume || []).find(m => m.status === 'in_mav' || m.status === 'mav_to_mrv');
  const parts = [];
  if (prs > 0) parts.push(`${prs} PR${prs > 1 ? 's' : ''}`);
  parts.push(`${ctx.days_logged} sessions`);
  parts.push(`${tons}T volume`);
  let tail = '';
  if (champMuscle) tail = `${champMuscle.muscle.charAt(0).toUpperCase() + champMuscle.muscle.slice(1)} firing.`;
  if (dragMuscle) tail += ` ${dragMuscle.muscle.charAt(0).toUpperCase() + dragMuscle.muscle.slice(1)} is the bottleneck.`;
  return `${parts.join(' · ')}. ${tail}`.trim();
}

router.get("/analysis", async (req, res) => {
  try {
    const { deviceId, range = "30" } = req.query;
    if (!deviceId) return res.status(400).json({ error: "deviceId required" });

    const nowMs = Date.now();
    const anchor = await resolveAnchor(deviceId);
    const { computeAnalysisWindow } = require("./lib/range-helpers");
    const win = computeAnalysisWindow(range, anchor.anchorMs, nowMs, anchor.utcOffsetMinutes);
    const rangeDays = win.effectiveDays;
    const cutoffMs = win.cutoffMs;
    const effectiveDays = win.effectiveDays;
    const effectiveStartDate = win.effectiveStartDate;

    // Fetch wide enough to cover anchor → today for lifetime calc,
    // then filter to the requested window for the chart payload.
    const lifetimeFetchLimit = Math.min(Math.max(win.daysSinceAnchor * 3, rangeDays * 3, 200), 2000);
    const [fSnap, wSnap] = await Promise.all([
      fitnessDoc(deviceId).get(),
      workoutsCol(deviceId)
        .orderBy("logged_at", "desc")
        .limit(lifetimeFetchLimit)
        .get()
        .catch(() => ({ docs: [] })),
    ]);

    if (!fSnap.exists || !fSnap.data()?.setup_completed) {
      return res.json({ setup_completed: false });
    }

    const setup = fSnap.data();
    const allWorkouts = wSnap.docs.map((d) => d.data());
    // Lifetime set = all workouts since anchor (used only for score_lifetime).
    const anchorMsLocal = anchor.anchorMs || 0;
    const lifetimeWorkouts = anchorMsLocal > 0
      ? allWorkouts.filter((w) => getMillis(w.logged_at) >= anchorMsLocal)
      : allWorkouts;
    // Window set = filtered to the requested range (used for chart + window score).
    const workouts = allWorkouts.filter((w) => getMillis(w.logged_at) >= cutoffMs);

    if (workouts.length === 0) {
      return res.json({
        setup_completed: true,
        range,
        effective_start_date: effectiveStartDate,
        effective_days: effectiveDays,
        days_since_anchor: win.daysSinceAnchor,
        anchor_date: anchor.anchorDateStr,
        is_clamped: win.isClamped,
        score_today: null,
        score_lifetime: null,
        missed_days: 0,
        fitness_score: { score: null, label: "Begin", components: { volume: 0, intensity: 0, consistency: 0, recovery: 0 } },
        score_grade:    { letter: "—" },
        signal_points:  [],
        daily_logs:     {},
        top_exercises:  [],
        bottom_exercises: [],
        peak_hour: null,
        evening_session_pct: 0,
        streak: 0,
        volatility_pct: 0,
        best_day: null,
        worst_day: null,
        ai_reads: [],
        aha_moments: [],
        // Empty arrays for these keys so FE `.length > 0` guards never
        // hit `undefined.length` on Day 0. (Keeps Day 0 response parallel
        // to non-zero days for safer FE consumption.)
        muscle_volume: [],
        skip_pattern:  [],
        prs_period:    [],
        strength_trend: [],
        peak_hour_session_count: 0,
        hero_insight: { headline: "Log your first session — your score, signal, and AI reads come alive." },
        stats: {
          days_logged: 0, total_logs: 0, total_volume_kg: 0, total_sets: 0,
          avg_volume_kg: 0, avg_sets: 0, avg_quality: 0, avg_rpe: 0,
          vol_hit_days: 0, sets_hit_days: 0,
        },
        vol_target: 4500,
        sets_target: 14,
      });
    }

    // ── Aggregate signals ─────────────────────────────────────
    const signal_points = workouts
      .slice()
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""))
      .map((w) => ({
        date:           w.date,
        label:          new Date(w.date + "T12:00:00").toLocaleDateString("en", { month: "short", day: "numeric" }),
        volume_kg:      w.total_volume_kg || 0,
        sets:           w.total_sets || 0,
        session_quality:w.session_quality || 60,
        rpe_avg:        w.rpe_avg || 7,
      }));

    const total_volume_kg = workouts.reduce((a, w) => a + (w.total_volume_kg || 0), 0);
    const total_sets      = workouts.reduce((a, w) => a + (w.total_sets || 0), 0);
    const days_logged     = workouts.length;
    const avg_volume_kg   = Math.round(total_volume_kg / Math.max(days_logged, 1));
    const avg_sets        = Math.round(total_sets / Math.max(days_logged, 1));
    const avg_quality     = Math.round(workouts.reduce((a, w) => a + (w.session_quality || 60), 0) / Math.max(days_logged, 1));
    const avg_rpe         = +(workouts.reduce((a, w) => a + (w.rpe_avg || 7), 0) / Math.max(days_logged, 1)).toFixed(1);

    // Daily logs map (last 35 days for calendar)
    const daily_logs = {};
    workouts.forEach((w) => {
      if (!w.date) return;
      const q = (w.session_quality || 60) >= 75 ? "good" : (w.session_quality || 60) >= 55 ? "ok" : "poor";
      daily_logs[w.date] = {
        has_log:         true,
        quality:         q,
        total_volume_kg: w.total_volume_kg || 0,
        total_sets:      w.total_sets || 0,
        session_quality: w.session_quality || 60,
      };
    });

    const sortedByQ = workouts.slice().sort((a, b) => (b.session_quality || 0) - (a.session_quality || 0));
    const best_day = sortedByQ[0] ? {
      date: sortedByQ[0].date,
      label: new Date(sortedByQ[0].date + "T12:00:00").toLocaleDateString("en", { weekday: "long", month: "short", day: "numeric" }),
      total_volume_kg: sortedByQ[0].total_volume_kg || 0,
      total_sets: sortedByQ[0].total_sets || 0,
      session_quality: sortedByQ[0].session_quality || 0,
    } : null;
    const worst_day = sortedByQ.length >= 3 && sortedByQ[sortedByQ.length - 1] ? {
      date: sortedByQ[sortedByQ.length - 1].date,
      label: new Date(sortedByQ[sortedByQ.length - 1].date + "T12:00:00").toLocaleDateString("en", { weekday: "long", month: "short", day: "numeric" }),
      total_volume_kg: sortedByQ[sortedByQ.length - 1].total_volume_kg || 0,
      total_sets: sortedByQ[sortedByQ.length - 1].total_sets || 0,
      session_quality: sortedByQ[sortedByQ.length - 1].session_quality || 0,
    } : null;

    // Volatility
    let volatility_pct = 0;
    if (workouts.length > 2) {
      const mean = avg_volume_kg;
      const variance = workouts.reduce((a, w) => a + Math.pow((w.total_volume_kg || 0) - mean, 2), 0) / workouts.length;
      volatility_pct = Math.round((Math.sqrt(variance) / Math.max(mean, 1)) * 100);
    }

    // Top / bottom exercises across the period
    const exMap = {};
    workouts.forEach((w) => {
      (w.exercises || []).forEach((ex) => {
        if (!ex.name) return;
        const k = ex.name;
        if (!exMap[k]) exMap[k] = { name: k, count: 0, total_weight: 0, top_weight: 0, top_e1rm: 0, last_used: w.date, muscle: ex.muscle_group || "other" };
        exMap[k].count += (ex.sets?.length || 1);
        (ex.sets || []).forEach((st) => {
          const wt = +st.weight_kg || 0;
          exMap[k].total_weight += wt;
          if (wt > exMap[k].top_weight) exMap[k].top_weight = wt;
          if ((st.e1rm || 0) > exMap[k].top_e1rm) exMap[k].top_e1rm = st.e1rm || 0;
        });
        if (w.date > exMap[k].last_used) exMap[k].last_used = w.date;
      });
    });
    // Resolve PR counts per exercise for the period (e1RM that beats prior period max)
    const prsByExercise = {};
    const priorCutoff = Date.now() - rangeDays * 2 * 86400000;
    const exPriorMax = {};
    // Build prior-period max e1RM (the period before this one)
    const priorWorkouts = wSnap.docs
      .map((d) => d.data())
      .filter((w) => {
        const ms = getMillis(w.logged_at);
        return ms >= priorCutoff && ms < cutoffMs;
      });
    priorWorkouts.forEach((w) => {
      (w.exercises || []).forEach((ex) => {
        if (!ex.name) return;
        const max = (ex.sets || []).reduce((m, s) => Math.max(m, s.e1rm || 0), 0);
        if (max > (exPriorMax[ex.name] || 0)) exPriorMax[ex.name] = max;
      });
    });
    workouts.forEach((w) => {
      (w.exercises || []).forEach((ex) => {
        if (!ex.name) return;
        const max = (ex.sets || []).reduce((m, s) => Math.max(m, s.e1rm || 0), 0);
        const prior = exPriorMax[ex.name] || 0;
        if (max > prior && max > 0) {
          prsByExercise[ex.name] = (prsByExercise[ex.name] || 0) + 1;
        }
      });
    });

    const exList = Object.values(exMap)
      .map((x) => ({
        name: x.name,
        count: x.count,
        avg_weight_kg: x.count ? Math.round(x.total_weight / x.count) : 0,
        top_weight_kg: x.top_weight,
        top_e1rm:      Math.round(x.top_e1rm),
        last_used:     x.last_used,
        muscle:        x.muscle,
        prs_period:    prsByExercise[x.name] || 0,
        bodyweight:    x.top_weight === 0 && x.count > 0 ? true : undefined,
      }))
      .sort((a, b) => b.count - a.count);
    const top_exercises    = exList.slice(0, 6);
    const bottom_exercises = exList
      .filter((x) => x.count <= Math.max(2, Math.round(days_logged * 0.15)))
      .slice(0, 5)
      .map((x) => {
        const muscleLabel = x.muscle && x.muscle !== 'other' ? x.muscle : 'this lift';
        const why = x.muscle === 'back' ? 'Back volume below MEV'
                  : x.muscle === 'shoulders' ? 'Shoulder frequency low'
                  : `Under-used vs ${muscleLabel} antagonist`;
        return {
          ...x,
          frequency: x.count < 5 ? "rarely" : "sometimes",
          why,
          target_count: Math.max(x.count + 6, 12),
        };
      });

    // ─── Peak hour & evening % from session timestamps ───────────
    let peak_hour = null;
    let peak_hour_session_count = 0;
    let evening_session_pct = 0;
    if (workouts.length > 0) {
      const hourCounts = {};
      let eveningCount = 0;
      workouts.forEach((w) => {
        const ms = getMillis(w.logged_at);
        if (!ms) return;
        const h = new Date(ms).getHours();
        hourCounts[h] = (hourCounts[h] || 0) + 1;
        if (h >= 19) eveningCount++;
      });
      const sorted = Object.entries(hourCounts).sort(([, a], [, b]) => b - a);
      if (sorted[0]) {
        peak_hour = parseInt(sorted[0][0], 10);
        peak_hour_session_count = sorted[0][1];
      }
      evening_session_pct = Math.round((eveningCount / workouts.length) * 100);
    }

    // Streak from workout dates
    const dates = new Set(workouts.map((w) => w.date));
    let streak = 0;
    let cur = dateStr();
    if (!dates.has(cur)) {
      const y = new Date(); y.setDate(y.getDate() - 1); cur = dateStr(y);
    }
    while (dates.has(cur)) {
      streak++;
      const d = new Date(cur); d.setDate(d.getDate() - 1); cur = dateStr(d);
    }

    // Score: weighted blend
    const VOL_TARGET = setup.weekly_volume_target_kg || 4500;
    const SETS_TARGET = setup.weekly_sets_target || 14;
    const volPctOfTarget = Math.min(100, Math.round((avg_volume_kg / VOL_TARGET) * 100));
    const intensityScore = Math.min(100, Math.round(((avg_rpe - 5) / 4) * 100));
    const consistencyScore = Math.min(100, Math.round((days_logged / Math.max(rangeDays / 2.3, 1)) * 100));
    const recoveryScore = avg_quality;
    const score = Math.round(volPctOfTarget * 0.30 + intensityScore * 0.25 + consistencyScore * 0.25 + recoveryScore * 0.20);
    const grade = score >= 90 ? "A" : score >= 80 ? "B+" : score >= 70 ? "B" : score >= 60 ? "C+" : score >= 50 ? "C" : "D";

    // ── Compute the rich V4 fields ──
    const muscle_volume  = computeMuscleVolume(workouts, rangeDays);
    const skip_pattern   = computeSkipPattern(workouts, rangeDays);
    const prs_period     = computePRReel(workouts);
    const strength_trend = computeStrengthTrend(workouts, rangeDays);

    // ── LLM-driven insights (cached, cross-agent aware) ──
    const insightContext = {
      score, grade, days_logged, rangeDays,
      avg_volume_kg, avg_sets, avg_rpe, avg_quality,
      total_volume_kg, total_sets, streak, volatility_pct,
      muscle_volume, skip_pattern, prs_period, strength_trend,
      best_day, worst_day,
      top_exercises: top_exercises.slice(0, 4),
      bottom_exercises: bottom_exercises.slice(0, 2),
    };
    let llmOutput = null;
    try {
      llmOutput = await _generateFitnessV2Insights(deviceId, range, insightContext);
    } catch (e) {
      log.warn("[fitness] V2 insights generation failed:", e?.message);
    }
    const ai_reads    = llmOutput?.ai_reads    || _fallbackAiReads(insightContext);
    const aha_moments = llmOutput?.aha_moments || _fallbackAhaMoments(insightContext);
    const headline    = llmOutput?.hero_headline || _fallbackHeadline(insightContext);

    // Standard outputs: score_today / score_7d_smoothed / score_lifetime / missed_days
    // Per-day quality = mean of session_quality across that day's workouts.
    // Computed over LIFETIME workouts (anchor → today) so score_lifetime is
    // independent of the requested range.
    const dayQualityByDate = (() => {
      const acc = {};
      for (const w of lifetimeWorkouts) {
        if (!w.date) continue;
        if (!acc[w.date]) acc[w.date] = [];
        acc[w.date].push(w.session_quality || 60);
      }
      const out = {};
      for (const [k, arr] of Object.entries(acc)) {
        out[k] = arr.reduce((a, b) => a + b, 0) / arr.length;
      }
      return out;
    })();
    const { computeStandardOutputs } = require('./lib/score-lifetime');

    // HK blend: Apple Watch workouts / steps / active calories fill no-log days.
    // Manual workout days untouched.
    const { blendQualityByDate } = require('./lib/healthkit/blend');
    const { merged: dayQualityByDateBlended } = await blendQualityByDate({
      coach: 'fitness',
      manualQualityByDate: dayQualityByDate,
      deviceId,
      anchorDateStr: anchor.anchorDateStr,
      todayDateStr: win.todayDate,
      db: admin.firestore(),
      utcOffsetMinutes: anchor.utcOffsetMinutes || 0,
    });

    const std = computeStandardOutputs({
      qualityByDate: dayQualityByDateBlended,
      todayDate: win.todayDate,
      anchorDate: anchor.anchorDateStr,
      daysSinceAnchor: win.daysSinceAnchor,
    });
    const score_today = std.score_today;
    const score_lifetime = std.score_lifetime;
    const missed_days = std.missed_days;
    const score_7d_smoothed = std.score_7d_smoothed;

    res.json({
      setup_completed: true,
      range,
      effective_start_date: effectiveStartDate,
      effective_days: effectiveDays,
      days_since_anchor: win.daysSinceAnchor,
      anchor_date: anchor.anchorDateStr,
      is_clamped: win.isClamped,
      score_today,
      score_7d_smoothed,
      score_lifetime,
      missed_days,
      fitness_score: {
        score,
        label: score >= 80 ? "Strong block" : score >= 70 ? "On track" : score >= 60 ? "Building" : "Begin",
        components: { volume: volPctOfTarget, intensity: intensityScore, consistency: consistencyScore, recovery: recoveryScore },
      },
      score_grade: { letter: grade },
      signal_points,
      daily_logs,
      top_exercises,
      bottom_exercises,
      muscle_volume,
      skip_pattern,
      prs_period,
      strength_trend,
      peak_hour,
      peak_hour_session_count,
      evening_session_pct,
      streak,
      volatility_pct,
      best_day,
      worst_day,
      ai_reads,
      aha_moments: await (async () => {
        try {
          const { buildHKAhaCards } = require('./lib/healthkit/aha-cards');
          const hkCards = await buildHKAhaCards({ coach: 'fitness', deviceId, db: admin.firestore() });
          return hkCards.length ? [...hkCards, ...(aha_moments || [])] : aha_moments;
        } catch { return aha_moments; }
      })(),
      hero_insight: { headline },
      stats: {
        days_logged, total_logs: days_logged, total_volume_kg, total_sets,
        avg_volume_kg, avg_sets, avg_quality, avg_rpe,
        vol_hit_days:  workouts.filter((w) => (w.total_volume_kg || 0) >= VOL_TARGET).length,
        sets_hit_days: workouts.filter((w) => (w.total_sets || 0) >= SETS_TARGET).length,
      },
      vol_target:  VOL_TARGET,
      sets_target: SETS_TARGET,
    });
  } catch (e) {
    log.error("[fitness] /analysis:", e);
    res.status(500).json({ error: "server error" });
  }
});

// ════════════════════════════════════════════════════════════════
// GET /actions — Actions tab payload (Nutrition/Mind canon shape)
// Cadence is **session-based** for fitness (every 3 sessions or 3 days).
// Cross-agent signals from cross_agent/today_signals only (sandbox law).
// ════════════════════════════════════════════════════════════════
router.get("/actions", async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: "deviceId required" });

    const [actSnap, fSnap, recentWorkSnap] = await Promise.all([
      actionsCol(deviceId).orderBy('generated_at', 'desc').limit(20).get(),
      fitnessDoc(deviceId).get(),
      workoutsCol(deviceId).orderBy('logged_at', 'desc').limit(20).get(),
    ]);

    const allActions     = actSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const fitnessData    = fSnap.exists ? fSnap.data() : {};
    const recentWorkouts = recentWorkSnap.docs.map(d => d.data());

    // ── Cadence: every 3 sessions OR 3 days ──
    const lastBatchAt = allActions[0]?.generated_at;
    const lastBatchMs = lastBatchAt?._seconds
      ? lastBatchAt._seconds * 1000
      : (lastBatchAt ? new Date(lastBatchAt).getTime() : null);
    const sessionsSinceBatch = lastBatchMs
      ? recentWorkouts.filter(w => getMillis(w.logged_at) > lastBatchMs).length
      : recentWorkouts.length;
    const sessionsUntilNext = Math.max(0, 3 - sessionsSinceBatch);
    const nextReviewMs = lastBatchMs ? lastBatchMs + 3 * 86400000 : Date.now() + 3 * 86400000;
    const daysUntilNext = Math.max(0, Math.ceil((nextReviewMs - Date.now()) / 86400000));
    const cadence = lastBatchMs ? {
      status: 'live',
      last_review_at:    new Date(lastBatchMs).toISOString(),
      next_review_at:    new Date(nextReviewMs).toISOString(),
      next_review_label: new Date(nextReviewMs).toLocaleDateString('en-US', { weekday: 'short' }),
      days_until_next:    daysUntilNext,
      sessions_so_far:    recentWorkouts.length,
      sessions_until_next: sessionsUntilNext,
    } : {
      status: 'pending',
      sessions_so_far:    recentWorkouts.length,
      sessions_until_next: Math.max(0, 3 - recentWorkouts.length),
    };

    // ── Prescription (latest diagnosis if engine wrote one) ──
    const latestPrescriptionDoc = allActions.find(a =>
      a.kind === 'prescription' || a.diagnosis || a.summary
    );
    const prescription = (latestPrescriptionDoc?.diagnosis || latestPrescriptionDoc?.summary)
      ? {
          diagnosis: latestPrescriptionDoc.diagnosis || latestPrescriptionDoc.summary,
          generated_at:    lastBatchMs ? new Date(lastBatchMs).toISOString() : null,
          generated_label: lastBatchMs
            ? new Date(lastBatchMs).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })
            : null,
          evidence: latestPrescriptionDoc.evidence || [],
        }
      : null;

    // ── Active actions ──
    const proofString = (a) => {
      if (typeof a.proof_body === 'string' && a.proof_body) return a.proof_body;
      if (typeof a.proof === 'string' && a.proof) return a.proof;
      if (a.proof && typeof a.proof === 'object' && a.proof.citation) return `Tap ✓ when done — tracked vs ${a.proof.citation}.`;
      return 'Tap ✓ when done — your coach tracks the hit-rate.';
    };
    const active = allActions.filter(a =>
      a.kind !== 'prescription' &&
      a.source !== 'user_intention' &&
      (!a.status || a.status === 'active' || a.status === 'pending')
    );
    const actions = active.slice(0, 3).map(a => ({
      id: a.id,
      title: (typeof a.title === 'string' && a.title) || a.text || 'Action',
      why:   (typeof a.why === 'string' && a.why) || a.evidence_text || a.reasoning || 'Cited from your recent training logs.',
      how:   (typeof a.how === 'string' && a.how) || a.micro_step || a.action_text || 'Tap below to see the suggested step.',
      when:  a.when || a.cadence_text || 'Next session',
      proof: proofString(a),
      archetype:    typeof a.archetype === 'string' ? a.archetype : null,
      muscle:       a.muscle || a.muscle_group || null,
      status:       'active',
      hit_rate:     a.hit_count || a.completed_count || 0,
      target_count: a.target_count || 1,
      created_at:   a.generated_at || null,
    }));

    // ── History ──
    const isCancelled = (a) => a.status === 'cancelled' || a.status === 'skipped';
    const history = allActions
      .filter(a => a.status === 'completed' || a.status === 'done' || isCancelled(a))
      .slice(0, 12)
      .map(a => {
        const ts = a.completed_at || a.cancelled_at || a.skipped_at;
        const ms = ts?._seconds ? ts._seconds * 1000 : (ts ? new Date(ts).getTime() : null);
        const cancelled = isCancelled(a);
        return {
          id: a.id,
          title:        a.title || a.text || 'Action',
          date_label:   ms ? new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—',
          completed_at: ms ? new Date(ms).toISOString() : null,
          outcome:      a.outcome_text || (cancelled ? 'Cancelled' : `${a.hit_count || 0}/${a.target_count || 1} hit`),
          status:       cancelled ? 'cancelled' : 'completed',
          outcome_grade:  a.outcome_grade  || (cancelled ? 'abandoned' : 'kept'),
          outcome_reason: a.outcome_reason || null,
          outcome_source: a.outcome_source || null,
        };
      });

    // ── Stats ──
    const completed_total = allActions.filter(a => a.status === 'completed' || a.status === 'done').length;
    const skipped_total   = allActions.filter(isCancelled).length;
    const decided = completed_total + skipped_total;
    const stats = {
      active_count:       active.length,
      completed_total,
      skipped_total,
      cancelled_total:    skipped_total,
      follow_through_pct: decided ? Math.round((completed_total / decided) * 100) : 0,
    };

    return res.json({ cadence, prescription, actions, history, stats });
  } catch (err) {
    log.error('[fitness] /actions error:', err);
    return res.status(500).json({ error: 'server error' });
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
    log.error("[fitness] muscle-trends:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// POST /chat
// ─────────────────────────────────────────────────────────────────
// Cross-agent enricher for chat — sandbox-safe (reads only
// cross_agent/today_signals, never sibling collections).
// Returns a multi-line string ready to splice into the system prompt.
// Includes: sleep, mind anxiety, nutrition protein/deficit, hydration,
// active fasting state. Empty string if no signals available.
// ─────────────────────────────────────────────────────────────────
async function _readChatCrossAgent(deviceId) {
  try {
    const xSnap = await userDoc(deviceId).collection('cross_agent').doc('today_signals').get();
    if (!xSnap.exists) return "";
    const x = xSnap.data() || {};
    const lines = [];

    const entries = x.recent_sleep_summary?.entries || [];
    if (entries.length > 0) {
      const avgQ = (entries.reduce((s, e) => s + (e.quality_score || 50), 0) / entries.length).toFixed(0);
      const last = entries[0];
      lines.push(`Sleep: avg ${avgQ}/100 over ${entries.length}n; last night ${last.quality_score}/100${last.duration_hours ? ` (${last.duration_hours}h)` : ''}.`);
      if (avgQ < 60) lines.push(`Recovery flag: 2+ low-quality nights → recommend deload / lower intensity.`);
    }

    if (x.mind_anxiety_level != null) {
      lines.push(`Mind: anxiety ${x.mind_anxiety_level}/5.`);
      if (x.mind_anxiety_level >= 4) lines.push(`High anxiety → mobility/restorative session preferred over heavy lifts.`);
    }
    if (x.mind_mood_score != null) lines.push(`Mood: ${x.mind_mood_score}/4.`);

    if (x.nutrition_protein_target_pct != null) {
      const pct = x.nutrition_protein_target_pct;
      if (pct < 60) lines.push(`Protein: ${pct}% of target — MPS compromised, eat first.`);
      else if (pct >= 100) lines.push(`Protein: ${pct}% of target — recovery conditions good.`);
      else lines.push(`Protein: ${pct}% of target.`);
    }
    if (x.nutrition_calorie_deficit && x.nutrition_calorie_deficit < -600) {
      lines.push(`Large kcal deficit (${x.nutrition_calorie_deficit}) — performance + recovery impaired today.`);
    }

    if (x.water_intake_pct != null) {
      if (x.water_intake_pct < 40) lines.push(`Hydration: only ${x.water_intake_pct}% — drink before training.`);
      else lines.push(`Hydration: ${x.water_intake_pct}%.`);
    }

    if (x.fasting_active_hours && x.fasting_active_hours >= 14) {
      lines.push(`Currently ${Math.round(x.fasting_active_hours)}h into fast — light session only.`);
    }

    if (lines.length === 0) return "";
    return `\n\nCROSS-AGENT CONTEXT (live signals):\n- ${lines.join('\n- ')}`;
  } catch (_e) {
    return "";
  }
}

const _GOAL_HUMAN = {
  strength:    'build strength',
  muscle:      'build muscle',
  fat_loss:    'lose fat',
  weight_loss: 'lose fat',
  endurance:   'improve endurance',
  general:     'general fitness',
};
const _LEVEL_HUMAN = {
  beginner:     'beginner',
  intermediate: 'intermediate',
  advanced:     'advanced',
};
const _SPLIT_HUMAN = {
  push_pull_legs: 'push/pull/legs',
  upper_lower:    'upper/lower',
  full_body:      'full body',
  bro_split:      'bro split',
  none:           'flexible',
};
const _EQUIP_HUMAN = {
  full_gym:   'full gym',
  home:       'home setup',
  minimal:    'minimal equipment',
  bodyweight: 'bodyweight only',
};
const _humanGoal  = (g) => _GOAL_HUMAN[g]  || 'general fitness';
const _humanLevel = (l) => _LEVEL_HUMAN[l] || 'intermediate';
const _humanSplit = (s) => _SPLIT_HUMAN[s] || (s && String(s).replace(/_/g, ' ')) || 'flexible';
const _humanEquip = (e) => _EQUIP_HUMAN[e] || (e && String(e).replace(/_/g, ' ')) || 'full gym';

// ═══════════════════════════════════════════════════════════════
// GET /chat-state — Coach tab header (last workout + streak)
// Mirrors canonical Mind/Sleep /chat-state shape.
// ═══════════════════════════════════════════════════════════════
router.get('/chat-state', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const [snap, fSnap] = await Promise.all([
      workoutsCol(deviceId).orderBy('logged_at', 'desc').limit(1).get(),
      fitnessDoc(deviceId).get(),
    ]);

    if (snap.empty) return res.json({ last_workout: null, streak: 0 });

    const w = snap.docs[0].data();
    const at = getMillis(w.logged_at);
    const ago = Math.max(0, Math.round((Date.now() - at) / 60000));

    // Pick top exercise by e1RM as the headline lift
    const exercises = Array.isArray(w.exercises) ? w.exercises : [];
    let topLift = null;
    let topE1rm = 0;
    let muscleSet = new Set();
    for (const ex of exercises) {
      if (ex.muscle_group) muscleSet.add(ex.muscle_group);
      const sets = Array.isArray(ex.sets) ? ex.sets : [];
      for (const s of sets) {
        const e1 = Number(s.e1rm || 0);
        if (e1 > topE1rm) {
          topE1rm = e1;
          topLift = {
            name: ex.name,
            weight_kg: Number(s.weight_kg || 0),
            reps: Number(s.reps || 0),
          };
        }
      }
    }

    // Session-type label from muscle groups
    const muscles = Array.from(muscleSet);
    const isPush = muscles.some(m => ['chest','shoulders','triceps'].includes(m));
    const isPull = muscles.some(m => ['back','biceps'].includes(m));
    const isLeg  = muscles.some(m => ['quads','hamstrings','glutes','calves'].includes(m));
    let sessionType =
      muscles.length === 0 ? 'Workout' :
      isPush && isPull && isLeg ? 'Full Body' :
      isPush && !isPull && !isLeg ? 'Push' :
      isPull && !isPush && !isLeg ? 'Pull' :
      isLeg && !isPush && !isPull ? 'Legs' :
      isPush && isPull ? 'Upper' :
      isLeg ? 'Lower' :
      'Workout';

    return res.json({
      last_workout: {
        ago_minutes:     ago,
        date_str:        w.date,
        session_type:    sessionType,
        muscle_groups:   muscles,
        total_volume_kg: Number(w.total_volume_kg || 0),
        total_sets:      Number(w.total_sets || 0),
        rpe_avg:         Number(w.rpe_avg || 0),
        session_quality: Number(w.session_quality || 0),
        top_lift:        topLift,
      },
      streak: fSnap.data()?.streak || 0,
    });
  } catch (err) {
    log.error('[fitness] /chat-state error:', err);
    res.status(500).json({ error: 'state failed' });
  }
});

router.post("/chat", async (req, res) => {
  const { deviceId, message, proactive_context } = req.body;
  if (!deviceId || !message)
    return res.status(400).json({ error: "deviceId and message required" });
  if (!checkChatRate(deviceId))
    return res.status(429).json({ error: "Too many messages. Wait a moment." });

  const language = resolveLanguage(req);

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

    const crossContext = await _readChatCrossAgent(deviceId);

    let systemPrompt = appendLanguageInstruction([
      `You are an expert fitness coach inside a premium app. You have access to this user's complete training history AND live signals from sleep, mind, nutrition, water, and fasting.`,
      `User profile: goal=${_humanGoal(setup.primary_goal)}, level=${_humanLevel(setup.training_level)}, split=${_humanSplit(splitLabel === 'unstructured' ? 'none' : splitLabel)}, equipment=${_humanEquip(setup.equipment)}, injuries=${setup.injury_notes || "none"}.`,
      `Training schedule: ${trainingDaysStr}. Gym time: ${setup.gym_time || "07:00"}. Supplements: ${supplements}.`,
      `Baseline lifts: ${baselines}.`,
      `Context:\n${context}${proactiveHint}${crossContext}`,
      `Rules: Be specific and data-driven. Reference exact exercise names, weights, volumes, and dates from their data. When cross-agent signals are present (poor sleep, high anxiety, low protein, dehydration, active fast), weight them — don't just acknowledge them.`,
      `Use MEV/MAV/MRV landmarks when discussing volume. Reference progressive overload, periodization, deload needs when relevant.`,
      `Keep replies concise (2-4 sentences max, or a numbered list when steps are needed). No generic advice. No filler.`,
    ].join("\n"), language);

    // Silent HK enrichment — steps, active energy, RHR when granted.
    try {
      const { buildHKContext, appendHKContext } = require('./lib/healthkit/context-builder');
      const hkBlock = await buildHKContext({ db: admin.firestore(), deviceId, coach: 'fitness', days: 7 });
      systemPrompt = appendHKContext(systemPrompt, hkBlock);
    } catch { /* best-effort */ }

    const messages = [
      { role: "system", content: systemPrompt },
      ...history.slice(-12),
      { role: "user", content: message },
    ];

    const aiRes = await openai.chat.completions.create({
      model: AI.CHAT_STREAM,
      max_completion_tokens: 400,
      messages,
    });

    const reply = aiRes.choices[0].message.content.trim();

    const [userRef, aiRef] = await Promise.all([
      chatsCol(deviceId).add({
        role: "user",
        content: message,
        is_proactive: false,
        is_read: true, language,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
      }),
      chatsCol(deviceId).add({
        role: "assistant",
        content: reply,
        is_proactive: false,
        is_read: true, language,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
      }),
    ]);

    return res.json({ reply, message_id: aiRef.id });
  } catch (e) {
    log.error("[fitness] chat:", e);
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

    const crossContext = await _readChatCrossAgent(deviceId);

    const systemPrompt = [
      `You are an expert fitness coach inside a premium app. You have access to this user's complete training history AND live signals from sleep, mind, nutrition, water, and fasting.`,
      `User profile: goal=${_humanGoal(setup.primary_goal)}, level=${_humanLevel(setup.training_level)}, split=${_humanSplit(splitLabel === 'unstructured' ? 'none' : splitLabel)}, equipment=${_humanEquip(setup.equipment)}, injuries=${setup.injury_notes || "none"}.`,
      `Training schedule: ${trainingDaysStr}. Gym time: ${setup.gym_time || "07:00"}. Supplements: ${supplements}.`,
      `Baseline lifts: ${baselines}.`,
      `Context:\n${context}${proactiveHint}${crossContext}`,
      `Rules: Be specific and data-driven. Reference exact exercise names, weights, volumes, and dates from their data. When cross-agent signals are present (poor sleep, high anxiety, low protein, dehydration, active fast), weight them — don't just acknowledge them.`,
      `Use MEV/MAV/MRV landmarks when discussing volume. Reference progressive overload, periodization, deload needs when relevant.`,
      `Keep replies concise (2-4 sentences max, or a numbered list when steps are needed). No generic advice. No filler.`,
    ].join("\n");

    // Silent HK enrichment for streaming chat too.
    let enriched = systemPrompt;
    try {
      const { buildHKContext, appendHKContext } = require('./lib/healthkit/context-builder');
      const hkBlock = await buildHKContext({ db: admin.firestore(), deviceId, coach: 'fitness', days: 7 });
      enriched = appendHKContext(systemPrompt, hkBlock);
    } catch { /* best-effort */ }

    return { systemPrompt: enriched, history };
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
    log.error("[fitness] chat GET:", e);
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
    log.error("[fitness] chat/unread:", e);
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
    log.error("[fitness] chat/read:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// ----------------------------------------------------------------
// Hourly proactive cron
// ----------------------------------------------------------------
const _fitnessCronTick = async () => {
    const snap = await db().collection("wellness_users").limit(200).get();
    for (const userDoc2 of snap.docs) {
      const deviceId = userDoc2.id;
      try {
        const fSnap = await fitnessDoc(deviceId).get();
        if (!fSnap.exists || !fSnap.data()?.setup?.primary_goal) continue;

        // notif_enabled + DND + user-local time gate.
        const notifCtx = await getUserNotifContext(db(), deviceId);
        if (!notifCtx.allowsProactive) continue;
        const hour = notifCtx.localHour;
        if (hour < 6 || hour > 22) continue;

        const setup = fSnap.data().setup || {};
        const reminderHour = parseInt(
          (setup.gym_time || setup.reminder_time || "07:00").split(":")[0],
          10,
        );
        const proactiveToday = fSnap.data().proactive_today || "";
        const today = notifCtx.localDateStr;

        if (proactiveToday === today) continue;

        const allSnap = await workoutsCol(deviceId)
          .orderBy("logged_at", "desc")
          .limit(10)
          .get();
        const workouts = allSnap.docs.map(mapDoc);
        const streak = computeStreak(workouts);

        // Streak milestone — respect global daily budget (1/day max).
        // Compares user-LOCAL hour to setup.reminder_hour so reminders land
        // at the user's actual chosen time, not server UTC.
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
            language: notifCtx.language,
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
};
if (shouldRunCron()) {
  cron.schedule("0 * * * *", withCron('fitness:hourly-milestones', _fitnessCronTick, {
    ttlMs: 25 * 60_000,
  }), { timezone: 'UTC' });
}

// ─── GET /wearable-insights ─────────────────────────────────────────────
router.get('/wearable-insights', async (req, res) => {
  const deviceId = (req.query.deviceId || '').toString();
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  try {
    const { buildWearableInsights } = require('./lib/healthkit/wearable-insights');
    const days = Math.min(parseInt(req.query.days || '30', 10) || 30, 90);
    const payload = await buildWearableInsights({
      db: admin.firestore(), deviceId, coach: 'fitness', days,
    });
    res.json(payload);
  } catch (err) {
    res.json({ has_data: false, cards: [] });
  }
});

module.exports = router;
