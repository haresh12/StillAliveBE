'use strict';
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// reachout.bc.js — the ONE place the big-change coach reads ACROSS agents to reach out.
//
// Sandbox law (CLAUDE.md): individual agents read only their OWN agents/{coach}/* subcollection; the
// only place cross-agent reads are allowed is the wellness-cross zone — which is here. So the fitness
// proactive path does NOT query sibling collections itself; it asks THIS module "is there one cross-
// domain thing worth saying?" and gets back an OPAQUE insight it can voice (in the user's chosen coach
// persona) and surface in the coach chat.
//
// What it does: reads the user's OWN bc logs for today / last night across all six agents (verified bc
// field names — see each recentByDate call), then runs a SMALL set of HIGH-PRECISION "a real coach
// connected the dots" rules. It returns the single most valuable insight as {type, situation, fallback}
// or null. Silence is the default — it only speaks when the data genuinely warrants it, so the coach
// never feels noisy. It NEVER fabricates: every rule is grounded in real logged values, and because it
// only reads actual logs (which cannot predate registration) it is inherently registration-anchor safe
// — it never references a day the user didn't log or that predates their account.
//
// Cost: a handful of small single-field reads, run at most on the proactive path (≤1/user/day, already
// gated upstream by proactive_today + the FE's once-per-day / daytime window). No composite indexes
// (project law): every query is a single-field orderBy + in-memory date filter.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

const { userDoc } = require('../lib/collections'); // bc namespace → wellness_bc_users

const agentCol = (id, agent, col) => userDoc(id).collection('agents').doc(agent).collection(col);
const agentDoc = (id, agent) => userDoc(id).collection('agents').doc(agent);
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

// Recent docs for one agent, newest-first, then filtered in memory to a small date set (today / last
// night). Single-field orderBy only — no composite index. `created_at` is written on every bc log doc,
// so it is a safe, uniform sort key across all six agents. Fails soft to [] (agent unused → no data).
async function recentByDate(id, agent, col, dateField, dateSet, limit = 40) {
  try {
    const snap = await agentCol(id, agent, col).orderBy('created_at', 'desc').limit(limit).get();
    return snap.docs.map((d) => d.data()).filter((x) => x && dateSet.has(x[dateField]));
  } catch {
    return [];
  }
}

async function setupData(id, agent) {
  try {
    const s = await agentDoc(id, agent).get();
    return (s && s.exists ? s.data() : {}) || {};
  } catch {
    return {};
  }
}

/**
 * The cross-agent reach-out decision. Returns ONE insight or null.
 * @param {string} deviceId
 * @param {{ todayStr:string, yesterdayStr?:string, localHour?:number|null }} opts
 *   todayStr / yesterdayStr are the user's LOCAL dates (bc logs store user-local dates), so "today" and
 *   "last night" line up with what the user actually did. localHour gates time-sensitive rules.
 * @returns {Promise<{type:string, situation:string, fallback:string}|null>}
 */
async function getCrossReachout(deviceId, opts = {}) {
  const { todayStr, yesterdayStr = null, localHour = null } = opts;
  if (!deviceId || !todayStr) return null;

  const todaySet = new Set([todayStr]);
  const nightSet = new Set([todayStr, yesterdayStr].filter(Boolean)); // last night's sleep / recent mood

  let fit, nut, sleep, mind, water, nutSetup, waterSetup;
  try {
    [fit, nut, sleep, mind, water, nutSetup, waterSetup] = await Promise.all([
      recentByDate(deviceId, 'fitness', 'fitness_workouts', 'date', todaySet),
      recentByDate(deviceId, 'nutrition', 'food_logs', 'date_str', todaySet),
      recentByDate(deviceId, 'sleep', 'sleep_logs', 'date_str', nightSet),
      recentByDate(deviceId, 'mind', 'mind_checkins', 'date_str', nightSet),
      recentByDate(deviceId, 'water', 'water_logs', 'date', todaySet),
      setupData(deviceId, 'nutrition'),
      setupData(deviceId, 'water'),
    ]);
  } catch {
    return null; // never let a cross read break the proactive path
  }

  // ── Signals (all from real logs; null when the agent has no fresh data → rules needing it skip) ──
  const trainedToday = fit.some((w) => Array.isArray(w.exercises) && w.exercises.length > 0);
  const sleepLast = sleep.length ? num(sleep[0].sleep_quality, null) : null; // 1–5 (last night)
  const moodLast = mind.length ? num(mind[0].mood_score, null) : null;       // 1–4 (most recent)

  const waterMl = water.reduce((s, d) => s + num(d.effective_ml != null ? d.effective_ml : d.ml, 0), 0);
  const waterGoal = num((waterSetup.setup && waterSetup.setup.daily_goal_ml) != null
    ? waterSetup.setup.daily_goal_ml : waterSetup.daily_goal_ml, 2500);
  const waterPct = water.length ? waterMl / Math.max(1, waterGoal) : null;

  const proteinToday = nut.reduce((s, d) => s + num(d.protein, 0), 0);
  const proteinTarget = num((nutSetup.protein_target != null ? nutSetup.protein_target
    : (nutSetup.setup && nutSetup.setup.protein_target)), 140);
  const proteinPct = nut.length ? proteinToday / Math.max(1, proteinTarget) : null;

  return decideReachout({ trainedToday, sleepLast, moodLast, waterPct, proteinToday, proteinTarget, proteinPct, localHour });
}

/**
 * PURE decision over already-gathered signals — split out so every rule is unit-testable without
 * Firestore. Returns the single most valuable insight, most-valuable first, or null. High precision on
 * purpose: each rule needs the relevant agents to have fresh data (null signal → rule skips), so the
 * coach never guesses or preaches.
 */
function decideReachout(sig) {
  const { trainedToday, sleepLast, moodLast, waterPct, proteinToday, proteinTarget, proteinPct, localHour } = sig;

  // 1) Poor sleep + low mood — the flagship "these are linked" moment.
  if (sleepLast != null && sleepLast <= 2 && moodLast != null && moodLast <= 2) {
    return {
      type: 'cross_sleep_mood',
      situation:
        `Across their whole day you can see it: recent sleep has been poor (last night rated ${sleepLast}/5) ` +
        `and their mood is low with it (${moodLast}/4). These two feed each other. As their coach, gently ` +
        `connect the dots — no lecture — and give ONE concrete lever for tonight (protect wind-down / an ` +
        `earlier bedtime). Warm and human, not clinical.`,
      fallback: `Rough sleep and a low mood tend to travel together — let's protect tonight's wind-down and see how tomorrow feels.`,
    };
  }

  // 2) Trained today on poor sleep — recovery risk (the no-wearable version of low-recovery).
  if (trainedToday && sleepLast != null && sleepLast <= 2) {
    return {
      type: 'cross_train_low_sleep',
      situation:
        `They trained today but on poor recent sleep (last night ${sleepLast}/5) — so recovery is the ` +
        `bottleneck, not effort. Acknowledge the work, then steer them toward recovery tonight (sleep, ` +
        `hydration) rather than stacking another hard day. Encouraging, never alarmist.`,
      fallback: `You put the work in today — but on low sleep, recovery is where it sticks. Make tonight's rest the priority.`,
    };
  }

  // 3) Trained today but well under protein by afternoon+ — fuel the recovery.
  if (trainedToday && proteinPct != null && proteinPct < 0.5 && (localHour == null || localHour >= 14)) {
    return {
      type: 'cross_train_underfueled',
      situation:
        `They trained today but protein is well under target so far (${Math.round(proteinToday)}g of ` +
        `${proteinTarget}g). Muscle repairs on protein. Nudge ONE protein-forward meal or snack, tied to ` +
        `the session they just did. Specific and supportive, not a macro lecture.`,
      fallback: `Solid session today — now back it up with protein. You're under target, and that's where recovery happens.`,
    };
  }

  // 4) Low hydration + low mood by afternoon — even mild dehydration dents mood/focus.
  if (waterPct != null && waterPct < 0.4 && moodLast != null && moodLast <= 2 && (localHour == null || localHour >= 13)) {
    return {
      type: 'cross_dehydration_mood',
      situation:
        `Hydration is low today (about ${Math.round(waterPct * 100)}% of their goal) and their mood is ` +
        `down (${moodLast}/4). Even mild dehydration dents focus and mood — they're connected. Nudge a ` +
        `glass or two now, framed around how they'll FEEL, not a rule.`,
      fallback: `You're low on water today and feeling flat — they're linked. A glass or two now can lift the fog.`,
    };
  }

  // 5) Strong sleep + a good/active day — reinforce the system working (positive is coaching too).
  if (sleepLast != null && sleepLast >= 4 && (trainedToday || (moodLast != null && moodLast >= 3))) {
    return {
      type: 'cross_good_sleep_good_day',
      situation:
        `They slept well (last night ${sleepLast}/5) and it showed up today — ${trainedToday ? 'they trained' : 'their mood is good'}. ` +
        `Name the LINK so they see the system working: good sleep bought them the energy for a good day. ` +
        `Celebratory but specific, so it reinforces the habit.`,
      fallback: `Good sleep, good day — that's not a coincidence. Your body paid back the rest with energy today.`,
    };
  }

  return null;
}

module.exports = { getCrossReachout, decideReachout };
