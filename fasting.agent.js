'use strict';

// ================================================================
// FASTING AGENT -- Pulse Backend
// Mounted at /api/fasting in server.js
//
// Science basis:
//   Metabolic switching: Mattson et al. 2018, Nature Rev Neuroscience
//   Autophagy: Alirezaei et al. 2010 (Autophagy), Ohsumi Nobel 2016
//   Insulin sensitivity: Sutton et al. 2018 (Cell Metabolism)
//   Circadian TRE: Panda et al. 2019 (Science), Wilkinson 2020
//   Ghrelin adaptation: Frecka & Mattes 2008 (Am J Physiology)
// ================================================================

const express = require('express');
const router  = express.Router();
const admin   = require('firebase-admin');
const { OpenAI } = require('openai');
const cron    = require('node-cron');
const crypto  = require('crypto');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const db     = () => admin.firestore();

// ----------------------------------------------------------------
// Context cache (5-min TTL, invalidated on write)
// ----------------------------------------------------------------
const _ctxCache = new Map();
const CTX_TTL   = 5 * 60 * 1000;

async function getCachedContext(deviceId) {
  const cached = _ctxCache.get(deviceId);
  if (cached && Date.now() - cached.builtAt < CTX_TTL) return cached.context;
  const context = await buildFastingContext(deviceId);
  _ctxCache.set(deviceId, { context, builtAt: Date.now() });
  return context;
}

function invalidateCtx(deviceId) {
  _ctxCache.delete(deviceId);
}

// ----------------------------------------------------------------
// Chat rate limiter (20 req / 60s per device)
// ----------------------------------------------------------------
const _rateMap = new Map();
function checkChatRate(deviceId) {
  const now   = Date.now();
  const entry = _rateMap.get(deviceId);
  if (!entry || now - entry.t > 60_000) { _rateMap.set(deviceId, { t: now, n: 1 }); return true; }
  if (entry.n >= 20) return false;
  entry.n += 1;
  return true;
}

// ----------------------------------------------------------------
// Firestore paths
// ----------------------------------------------------------------
const userDoc      = (id) => db().collection('wellness_users').doc(id);
const fastingDoc   = (id) => userDoc(id).collection('agents').doc('fasting');
const sessionsCol  = (id) => fastingDoc(id).collection('fasting_sessions');
const chatsCol     = (id) => fastingDoc(id).collection('fasting_chats');
const actionsCol   = (id) => fastingDoc(id).collection('fasting_actions');

// ════════════════════════════════════════════════════════════════
// ACTIONS v2 — shared engine
// ════════════════════════════════════════════════════════════════
const { mountActionRoutes, gradeActions: _gradeActionsShared } = require('./lib/actions-engine');
const { computeFastingCandidates, fastingGraders } = require('./lib/candidates/fasting');
const { assertNoCrossAgent } = require('./lib/sandbox');
const { computeFastingScore: _computeFastingScore } = require('./lib/agent-scores');
const { fetchAgentSnapshot } = require('./lib/cross-agent-context');
assertNoCrossAgent('fasting', computeFastingCandidates);
const _v2Hooks = mountActionRoutes(router, {
  agentName: 'fasting',
  agentDocRef: fastingDoc,
  actionsCol, logsCol: sessionsCol,
  computeCandidates: computeFastingCandidates,
  graders: fastingGraders,
  openai, admin, db,
  config: { LOGS_ORDER_FIELD: 'started_at' }, // fasting sessions use started_at, not logged_at
  crossAgentEnricher: async (deviceId) => {
    const [sleepSnap, mindSnap] = await Promise.all([
      fetchAgentSnapshot(deviceId, 'sleep', 1).catch(() => null),
      fetchAgentSnapshot(deviceId, 'mind', 1).catch(() => null),
    ]);
    const parts = [];
    if (sleepSnap?.logs?.length) {
      const hrs = sleepSnap.logs[0].actual_hours || 7;
      if (hrs < 6) parts.push(`Short sleep last night (${hrs}h) → hunger hormones elevated; extended fast may be harder today.`);
    }
    if (mindSnap?.logs?.length) {
      const stress = mindSnap.logs[0].anxiety_level || 0;
      if (stress >= 4) parts.push(`High stress detected (anxiety ${stress}/5) → emotional hunger risk; plan distraction strategies.`);
    }
    return parts.join(' ');
  },
});
function _onFastingLog(deviceId) {
  fastingDoc(deviceId).update({
    log_count_since_last_batch: admin.firestore.FieldValue.increment(1),
  }).catch(() => {});
  _v2Hooks.queueGeneration(deviceId);
  _gradeActionsShared({
    agentName: 'fasting', deviceId, actionsCol, logsCol: sessionsCol,
    graders: fastingGraders, admin, db,
  }).catch(() => {});
  try { require('./wellness.cross').invalidateWellnessCache?.(deviceId); } catch {}
}
// ════════════════════════════════════════════════════════════════

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------
const STREAK_MILESTONES  = [3, 7, 14, 21, 30, 60, 90];
const MAX_PROACTIVES_PER_DAY = 2;
const ACTION_BATCH_SIZE = 3;
const ACTION_LOOKBACK_DAYS = 30;
const ACTION_GEN_STALE_MS = 90 * 1000;
const _actionGenMap = new Map();

const dateStr = (d = new Date()) => {
  const y  = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${dd}`;
};

const mapDoc = (doc) => ({ id: doc.id, ...doc.data() });

const getMillis = (value) => {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
};

const toIso = (value) => {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const round = (n, dp = 1) => {
  const f = Math.pow(10, dp);
  return Math.round((n || 0) * f) / f;
};

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

const avg = (nums = []) =>
  nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : 0;

const getSessionRecentOrderMillis = (session = {}) =>
  getMillis(
    session.backfilled_at
    || session.ended_at
    || session.created_at
    || session.started_at,
  );

const getActionGenerationCheckpoint = (data = {}) =>
  data.last_action_generation_completed_total
  ?? data.last_regen_session
  ?? 0;

const getCompletedSinceActionBatch = (data = {}) =>
  Math.max(0, (data.total_sessions_completed || 0) - getActionGenerationCheckpoint(data));

const isActionBatchDue = (data = {}) =>
  (data.total_sessions_completed || 0) >= ACTION_BATCH_SIZE
  && getCompletedSinceActionBatch(data) >= ACTION_BATCH_SIZE;

const isActionGenerationPending = (data = {}) =>
  ['queued', 'running'].includes(data.action_generation_status);

const isActionGenerationStale = (data = {}) => {
  const lastTick = getMillis(
    data.action_generation_started_at
    || data.action_generation_requested_at
    || data.last_action_generated_at,
  );
  if (!lastTick) return true;
  return Date.now() - lastTick > ACTION_GEN_STALE_MS;
};

const minsToLabel = (mins) => {
  const h24  = Math.floor(((mins % 1440) + 1440) % 1440 / 60);
  const m    = Math.floor(((mins % 1440) + 1440) % 1440 % 60);
  const ampm = h24 >= 12 ? 'pm' : 'am';
  const h12  = h24 % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
};

// ----------------------------------------------------------------
// Metabolic stage engine (science-backed thresholds)
// ----------------------------------------------------------------
const METABOLIC_STAGES = [
  { id: 'fed',            hours: [0, 4],   label: 'Fed State',        emoji: 'meal',    short: 'Fed' },
  { id: 'post_absorptive',hours: [4, 8],   label: 'Post-Absorptive',  emoji: 'bolt',    short: 'Post-absorb' },
  { id: 'glycogen',       hours: [8, 12],  label: 'Glycogen Burning', emoji: 'fire',    short: 'Glycogen' },
  { id: 'fat_burning',    hours: [12, 16], label: 'Fat Burning',      emoji: 'muscle',  short: 'Fat burn' },
  { id: 'ketosis_entry',  hours: [16, 18], label: 'Ketosis Entry',    emoji: 'dna',     short: 'Ketosis' },
  { id: 'autophagy',      hours: [18, 24], label: 'Autophagy Active', emoji: 'science', short: 'Autophagy' },
  { id: 'deep_fast',      hours: [24, 72], label: 'Deep Fast',        emoji: 'moon',    short: 'Deep fast' },
];

function getStage(fastHours = 0) {
  for (const s of METABOLIC_STAGES) {
    if (fastHours >= s.hours[0] && fastHours < s.hours[1]) return s;
  }
  return METABOLIC_STAGES[METABOLIC_STAGES.length - 1];
}

function getElapsedHours(startTimestamp) {
  if (!startTimestamp) return 0;
  const ms = Date.now() - getMillis(startTimestamp);
  return ms / (1000 * 3600);
}

// ----------------------------------------------------------------
// Protocol calculator: auto-suggest eating window from sleep data
// ----------------------------------------------------------------
function calcEatingWindow(setup) {
  const targetHours = parseInt(setup.target_fast_hours, 10) || 16;
  const eatHours    = 24 - targetHours;
  const eatMinutes  = eatHours * 60;
  const round15 = mins => Math.round(mins / 15) * 15;
  const clampStart = mins => Math.max(0, Math.min(1440 - eatMinutes, round15(mins)));

  // Manual window keeps the chosen protocol exact. Users can move the window,
  // but not silently change 16:8 into 14.5h fasts.
  if (setup.schedule_type === 'manual'
    && (setup.eating_window_start_min != null || setup.eating_window_end_min != null)) {
    const start = setup.eating_window_start_min != null
      ? clampStart(setup.eating_window_start_min)
      : clampStart((setup.eating_window_end_min || eatMinutes) - eatMinutes);
    return {
      windowStart: start,
      windowEnd:   start + eatMinutes,
      eatHours,
      targetHours,
    };
  }

  // Auto: keep the selected protocol exact and place it as late as possible
  // while still aiming for circadian alignment.
  const wake     = setup.wake_time_min ?? 420;
  const bed      = setup.bed_time_min  ?? 1380;
  const earliest = round15(wake + 90);
  const preferredEnd = round15(bed - 120);

  let windowStart = Math.max(earliest, preferredEnd - eatMinutes);
  windowStart = clampStart(windowStart);
  const windowEnd = windowStart + eatMinutes;

  return { windowStart, windowEnd, eatHours, targetHours };
}

// ----------------------------------------------------------------
// Streak + completion rate calculators
// ----------------------------------------------------------------
function computeStreak(sessions = []) {
  if (!sessions.length) return 0;

  const byDate = {};
  for (const s of sessions) {
    const key = s.date || dateStr(new Date(getMillis(s.started_at)));
    if (s.completed) byDate[key] = true;
  }

  let streak = 0;
  const today = dateStr();
  let check   = new Date();

  // allow today to be in-progress (not completed yet)
  while (true) {
    const key = dateStr(check);
    if (byDate[key]) {
      streak++;
      check.setDate(check.getDate() - 1);
    } else if (key === today) {
      check.setDate(check.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

function computeCompletionRate(sessions = [], days = 7) {
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const recent = sessions.filter(s => getMillis(s.started_at) >= cutoff);
  if (!recent.length) return 0;
  const completed = recent.filter(s => s.completed).length;
  return round(completed / recent.length, 2);
}

function computeAvgFastHours(sessions = [], days = 7) {
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const done   = sessions.filter(s => s.completed && getMillis(s.started_at) >= cutoff && s.actual_hours);
  if (!done.length) return 0;
  return round(avg(done.map(s => s.actual_hours)), 1);
}

function buildSessionStats(sessions = [], targetHours = 16, existingLongest = 0) {
  const currentStreak = computeStreak(sessions);
  const computedLongest = computeLongestStreak(sessions);
  const longestStreak = Math.max(existingLongest || 0, computedLongest);
  const completion7 = computeCompletionRate(sessions, 7);
  const avgH7 = computeAvgFastHours(sessions, 7);
  const totalDone = sessions.filter(s => s.completed).length;
  const readyForUpgrade =
    completion7 >= 0.85
    && avgH7 >= (targetHours - 0.5);

  return {
    currentStreak,
    longestStreak,
    completion7,
    avgH7,
    totalDone,
    readyForUpgrade,
  };
}

// ----------------------------------------------------------------
// Context builder
// ----------------------------------------------------------------
async function buildFastingContext(deviceId) {
  try {
    const [fRef, recentSessionsSnap, activeActionsSnap, recentChatsSnap] = await Promise.all([
      fastingDoc(deviceId).get(),
      sessionsCol(deviceId).orderBy('started_at', 'desc').limit(60).get(),
      actionsCol(deviceId).where('status', '==', 'active').get(),
      chatsCol(deviceId).orderBy('created_at', 'desc').limit(6).get(),
    ]);

    if (!fRef.exists) return 'No setup data found.';

    const data     = fRef.data() || {};
    const setup    = data.setup || {};
    const sessions = recentSessionsSnap.docs.map(mapDoc);

    const streak          = computeStreak(sessions);
    const longestStreak   = data.longest_streak || 0;
    const completionRate7 = computeCompletionRate(sessions, 7);
    const avgHours7       = computeAvgFastHours(sessions, 7);
    const totalCompleted  = sessions.filter(s => s.completed).length;
    const protocol        = setup.protocol || '16:8';
    const targetHours     = setup.target_fast_hours || 16;
    const { windowStart, windowEnd } = calcEatingWindow(setup);

    // Active session
    const nowHour = new Date().getHours();
    const nowMin  = new Date().getMinutes();
    const nowTotal = nowHour * 60 + nowMin;
    const activeId = data.active_session_id;
    let activeSessionNote = 'No active fast right now (in eating window or not started).';
    let currentStageNote  = '';
    let elapsedHours      = 0;

    if (activeId) {
      const activeSnap = await sessionsCol(deviceId).doc(activeId).get();
      if (activeSnap.exists) {
        const sess        = activeSnap.data();
        elapsedHours      = getElapsedHours(sess.started_at);
        const sessTarget  = sess.target_hours || targetHours;
        const stage       = getStage(elapsedHours);
        const hoursLeft   = Math.max(0, sessTarget - elapsedHours);
        activeSessionNote = `ACTIVE FAST: ${round(elapsedHours, 1)}h elapsed, ${round(hoursLeft, 1)}h remaining to ${sessTarget}h goal (this session's target).`;
        currentStageNote  = `Current metabolic stage: ${stage.label}. Science: ${
          stage.id === 'fed'            ? 'Insulin elevated, glycogen storing, mTOR active.' :
          stage.id === 'post_absorptive'? 'Insulin falling, glucagon rising, glycogen reserves tapped.' :
          stage.id === 'glycogen'       ? 'Liver glycogen 60-80% depleted, ghrelin peaking, fat mobilizing.' :
          stage.id === 'fat_burning'    ? 'Glycogen exhausted, fat oxidation dominant, ketones 0.3-0.5 mM.' :
          stage.id === 'ketosis_entry'  ? 'Ketones 0.5-1.0 mM, mTOR suppressed, autophagy upregulating.' :
          stage.id === 'autophagy'      ? 'LC3-II elevated 2-3x, cellular cleanup active, BDNF elevated, ketones 1-2 mM.' :
          'Ketones 2-5 mM, growth hormone surge 300-500%, maximum autophagy.'
        }`;
      }
    }

    // Today's history
    const todaySessions = sessions.filter(s => (s.date || '') === dateStr());
    const todayCompleted = todaySessions.some(s => s.completed);

    // Last 10 sessions breakdown including break reasons
    const recentSummary = sessions.slice(0, 10).map(s => {
      const d = s.date || '?';
      if (s.completed) return `${d}: ✓ ${round(s.actual_hours || 0, 1)}h reached ${s.metabolic_stage_reached || '?'}`;
      const reason = s.broken_reason ? ` (reason: ${s.broken_reason})` : '';
      return `${d}: ✗ broke at ${round(s.actual_hours || 0, 1)}h${reason}`;
    }).join('\n');

    // Break pattern analysis
    const brokenSessions = sessions.filter(s => s.broken_early);
    const breakReasonCounts = {};
    for (const s of brokenSessions) {
      const r = s.broken_reason || 'unknown';
      breakReasonCounts[r] = (breakReasonCounts[r] || 0) + 1;
    }
    const breakPatternNote = brokenSessions.length > 0
      ? `Break pattern (${brokenSessions.length} early ends total): ${
          Object.entries(breakReasonCounts)
            .sort(([,a],[,b]) => b - a)
            .map(([r, n]) => `${r} ×${n}`)
            .join(', ')
        }. Avg hours when breaking early: ${round(brokenSessions.reduce((s,x) => s + (x.actual_hours||0), 0) / brokenSessions.length, 1)}h.`
      : 'No early breaks yet.';

    // Active actions
    const activeActions = activeActionsSnap.docs
      .map(mapDoc)
      .sort((a, b) => getMillis(a.generated_at) - getMillis(b.generated_at))
      .slice(0, 3)
      .map(a => `- ${a.title ? `${a.title}: ` : ''}${a.text} [${a.when_to_do || 'anytime'}]`)
      .join('\n') || '- none';

    // Recent proactives
    const recentProactives = recentChatsSnap.docs
      .map(d => d.data())
      .filter(m => m.is_proactive && m.content)
      .slice(0, 2)
      .map(m => `[${m.proactive_type || 'check_in'} at ${toIso(m.created_at)?.slice(11, 16) || '?'}]: ${m.content.slice(0, 100)}`)
      .join('\n');

    // Cross-agent: water
    let waterNote = '';
    try {
      const waterRef = await userDoc(deviceId).collection('agents').doc('water').get();
      const goalMl = waterRef.exists ? (waterRef.data()?.setup?.daily_goal_ml || waterRef.data()?.setup?.recommended_goal_ml || 2500) : 2500;
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const wLogsSnap = await userDoc(deviceId).collection('agents').doc('water')
        .collection('water_logs').where('logged_at', '>=', todayStart).get();
      const todayWater = wLogsSnap.docs.reduce((sum, d) => sum + (d.data().effective_ml || 0), 0);
      if (todayWater > 0 || goalMl > 0) {
        const pct = Math.round(todayWater / Math.max(goalMl, 1) * 100);
        waterNote = `Hydration today: ${todayWater}ml (${pct}% of ${goalMl}ml goal). ${pct < 40 && activeId ? 'CRITICAL: dehydration mimics hunger during fasting.' : ''}`;
      }
    } catch { /* non-fatal */ }

    // Cross-agent: sleep
    let sleepNote = '';
    try {
      const sleepSnap = await userDoc(deviceId).collection('agents').doc('sleep')
        .collection('sleep_logs').orderBy('date', 'desc').limit(2).get();
      if (!sleepSnap.empty) {
        const entries = sleepSnap.docs.map(d => d.data()).filter(d => d.quality_score);
        if (entries.length) {
          const lastScore = entries[0].quality_score;
          sleepNote = `Last sleep: ${lastScore}/100 quality${lastScore < 65 ? '. Poor sleep elevates ghrelin -- fast hunger is amplified today.' : '.'}`;
        }
      }
    } catch { /* non-fatal */ }

    // Cross-agent: mind/mood
    let moodNote = '';
    try {
      const mindSnap = await userDoc(deviceId).collection('agents').doc('mind')
        .collection('mind_checkins').orderBy('created_at', 'desc').limit(1).get();
      if (!mindSnap.empty) {
        const entry = mindSnap.docs[0].data();
        const score = entry.mood_score || entry.current_rating;
        if (score) moodNote = `Mood check-in: ${score}/4. ${score <= 2 ? 'Low mood -- consider lighter fast today.' : ''}`;
      }
    } catch { /* non-fatal */ }

    // Ghrelin adaptation status
    const daysSinceStart = data.setup_completed_at
      ? Math.floor((Date.now() - getMillis(data.setup_completed_at)) / (1000 * 86400))
      : 0;
    const ghrelinNote = daysSinceStart < 7
      ? `Day ${daysSinceStart + 1} of fasting protocol. Ghrelin is actively adapting -- hunger peaks in days 1-14, then drops significantly by day 21.`
      : daysSinceStart < 21
      ? `Day ${daysSinceStart + 1}. Ghrelin adapting -- hunger should start easing soon.`
      : `Day ${daysSinceStart + 1}. Ghrelin fully adapted to schedule. Hunger during fasting is normalized.`;

    // Body metrics
    let bodyNote = '';
    if (setup.weight_kg && setup.height_cm) {
      const bmi = round(setup.weight_kg / ((setup.height_cm / 100) ** 2), 1);
      bodyNote = `Body: ${setup.weight_kg}kg, ${setup.height_cm}cm, BMI ${bmi}.`;
    }

    const timeLabel = nowHour < 6 ? 'night' : nowHour < 12 ? 'morning' : nowHour < 17 ? 'afternoon' : nowHour < 21 ? 'evening' : 'night';

    const protocolHistory = (data.protocol_history || []).slice(-3);
    const protocolHistoryNote = protocolHistory.length > 1
      ? `Protocol history: ${protocolHistory.map(p => `${p.protocol} (since ${p.started_at})`).join(' → ')}.`
      : '';

    return [
      `Current time: ${minsToLabel(nowTotal)} (${timeLabel}).`,
      `Protocol: ${protocol} -- target fast ${targetHours}h, eating window ${minsToLabel(windowStart)}-${minsToLabel(windowEnd)}.`,
      protocolHistoryNote,
      `User goals: ${Array.isArray(setup.goal) ? setup.goal.join(', ') : (setup.goal || 'general_health')}. Experience: ${setup.experience_level || 'beginner'}.`,
      activeSessionNote,
      currentStageNote,
      `Today completed: ${todayCompleted ? 'Yes' : 'No'}.`,
      `Streak: ${streak} days. Longest: ${longestStreak} days. 7-day completion: ${Math.round(completionRate7 * 100)}%. Avg fast: ${avgHours7}h. Total sessions: ${totalCompleted}.`,
      `Recent history (most recent first):\n${recentSummary || 'none yet'}`,
      breakPatternNote,
      ghrelinNote,
      bodyNote,
      waterNote,
      sleepNote,
      moodNote,
      `Active coach priorities:\n${activeActions}`,
      recentProactives ? `Recent coach messages:\n${recentProactives}` : '',
    ].filter(Boolean).join('\n');
  } catch (e) {
    console.error('[fasting] buildFastingContext:', e);
    return 'Context unavailable.';
  }
}

// ================================================================
// POST /setup
// ================================================================
router.post('/setup', async (req, res) => {
  try {
    const {
      deviceId,
      protocol,
      goal,
      experience_level,
      medical_clearance,
      conditions,
      caffeine_habit,
      schedule_type,
      wake_time_min,
      bed_time_min,
      gender,
    } = req.body;

    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const targetHours = protocol === '12:12' ? 12
      : protocol === '14:10' ? 14
      : protocol === '18:6'  ? 18
      : protocol === '20:4'  ? 20
      : protocol === 'omad'  ? 23
      : protocol === '5:2'   ? 16  // 5:2 is calorie-based, not TRE — default to 16h window
      : 16;

    const setup = {
      protocol:         protocol || '16:8',
      target_fast_hours:targetHours,
      goal:             goal || 'general_health',
      experience_level: experience_level || 'beginner',
      medical_clearance:medical_clearance ?? false,
      conditions:       conditions || [],
      caffeine_habit:   caffeine_habit || 'black',
      schedule_type:    schedule_type || 'fixed',
      wake_time_min:    wake_time_min ?? 420,
      bed_time_min:     bed_time_min  ?? 1380,
      gender:           gender || null,
      weight_kg:        req.body.weight_kg || null,
      height_cm:        req.body.height_cm || null,
    };

    const { windowStart, windowEnd } = calcEatingWindow(setup);
    setup.eating_window_start_min = windowStart;
    setup.eating_window_end_min   = windowEnd;

    const fRef  = fastingDoc(deviceId);
    const fSnap = await fRef.get();
    const isFirstSetup = !fSnap.exists || !fSnap.data()?.setup_completed;

    await fRef.set({
      setup,
      setup_completed:    true,
      setup_completed_at: admin.firestore.FieldValue.serverTimestamp(),
      current_streak:     0,
      longest_streak:     0,
      total_sessions_completed: 0,
      total_sessions_started:   0,
      avg_fast_hours_7d:  0,
      completion_rate_7d: 0,
      active_session_id:  null,
      last_proactive_date:    null,
      proactive_count_today:  0,
      unread_proactive_count: 0,
      last_milestone_streak:  0,
      ready_for_upgrade:  false,
      analysis_cache:     null,
      last_action_generation_completed_total: 0,
      last_regen_session: 0,
      last_action_batch_key: null,
      last_action_batch_kind: 'setup',
      last_action_generated_at: null,
      action_generation_status: 'idle',
      action_generation_requested_at: null,
      action_generation_started_at: null,
      action_generation_finished_at: null,
      action_generation_error: null,
      protocol_history:   [{ protocol: setup.protocol, started_at: dateStr() }],
    }, { merge: true });

    // Generate first 3 actions
    try {
      const context = await buildFastingContext(deviceId);
      const batchKey = `${dateStr()}_${Date.now()}`;
      const actRes  = await openai.chat.completions.create({
        model: 'gpt-4.1-mini',
        max_tokens: 420,
        temperature: 0.4,
        messages: [{
          role: 'system',
          content: [
            'Generate exactly 3 first-day fasting actions for this new user. Return JSON array only.',
            'Each action must be: { "title": string max 30 chars, "text": string max 72 chars, "why": string max 110 chars, "when_to_do": "morning"|"afternoon"|"evening"|"anytime", "category": "hydration"|"timing"|"nutrition"|"mindset"|"education"|"safety", "priority": "now"|"today"|"next", "impact": 1|2|3 }',
            'Base actions on protocol, goal, experience level, schedule type, and caffeine habit.',
            'Action 1: first-day friction reducer. Action 2: eating-window or timing setup. Action 3: hunger/science coaching.',
            'Use concrete numbers or times when possible. No fluff. No markdown.',
          ].join(' '),
        }, {
          role: 'user',
          content: context,
        }],
      });

      let actions = [];
      try {
        const raw = actRes.choices[0].message.content.trim().replace(/```json|```/g, '');
        actions = JSON.parse(raw);
      } catch { actions = []; }

      const batch = db().batch();
      for (const a of actions.slice(0, 3)) {
        const ref = actionsCol(deviceId).doc();
        batch.set(ref, {
          title:        a.title || '',
          text:         a.text || '',
          why:          a.why || '',
          when_to_do:   a.when_to_do || 'anytime',
          category:     a.category || 'education',
          priority:     a.priority || 'today',
          impact:       clamp(parseInt(a.impact, 10) || 2, 1, 3),
          status:       'active',
          batch_key:    batchKey,
          generated_at: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      // Opening chat message
      const chatRef = chatsCol(deviceId).doc();
      batch.set(chatRef, {
        role:        'assistant',
        content:     `${protocol || '16:8'} protocol set. Your eating window is ${minsToLabel(windowStart)}-${minsToLabel(windowEnd)} -- that is ${24 - targetHours}h to eat, ${targetHours}h to fast. First ${targetHours < 16 ? '7 days' : '14 days'} will feel harder than the long term -- ghrelin adapts and hunger drops significantly by week 3. Start your first fast tonight.`,
        is_proactive:  false,
        created_at:    admin.firestore.FieldValue.serverTimestamp(),
        is_first_message: true,
      });

      batch.set(fRef, {
        last_action_batch_key: batchKey,
        last_action_batch_kind: 'setup',
        last_action_generated_at: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      await batch.commit();
      invalidateCtx(deviceId);
    } catch (e) {
      console.error('[fasting] setup actions gen:', e);
    }

    // Queue v2 welcome action batch (shared engine — runs in addition to legacy)
    try { _v2Hooks.queueGeneration(deviceId, { generationKind: 'setup' }); } catch {}

    return res.json({ success: true, setup, windowStart, windowEnd });
  } catch (e) {
    console.error('[fasting] setup:', e);
    return res.status(500).json({ error: 'Setup failed' });
  }
});

// ================================================================
// GET /setup-status
// ================================================================
router.get('/setup-status', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const snap = await fastingDoc(deviceId).get();
    if (!snap.exists || !snap.data()?.setup_completed) {
      return res.json({ setup_completed: false });
    }

    const data  = snap.data();
    const setup = data.setup || {};
    const { windowStart, windowEnd } = calcEatingWindow(setup);

    return res.json({
      setup_completed:    true,
      setup,
      window_start_min:   windowStart,
      window_end_min:     windowEnd,
      current_streak:     data.current_streak || 0,
      longest_streak:     data.longest_streak || 0,
      active_session_id:  data.active_session_id || null,
      completion_rate_7d: data.completion_rate_7d || 0,
      avg_fast_hours_7d:  data.avg_fast_hours_7d  || 0,
      ready_for_upgrade:  data.ready_for_upgrade  || false,
    });
  } catch (e) {
    console.error('[fasting] setup-status:', e);
    return res.status(500).json({ error: 'Failed' });
  }
});

// ================================================================
// PATCH /setup -- update protocol or schedule without full re-setup
// ═══════════════════════════════════════════════════════════════
// GET /chat-prompts  — returns 6 prompts personalised from setup + logs
// ═══════════════════════════════════════════════════════════════
router.get('/chat-prompts', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const snap  = await fastingDoc(deviceId).get();
    const data  = snap.exists ? snap.data() : {};
    const setup = data.setup || {};
    const protocol  = setup.protocol          || '16:8';
    const goal      = setup.goal              || 'general_health';
    const level     = setup.experience_level  || 'beginner';
    const caffeine  = setup.caffeine_habit    || 'black';
    const conditions = Array.isArray(setup.conditions) ? setup.conditions : [];

    const hour = new Date().getHours();
    const isMorning = hour >= 5 && hour < 12;
    const isEvening = hour >= 18;

    const pool = [];

    if (protocol === 'omad' || protocol === '20:4') {
      pool.push({ emoji: '⚡', text: `I'm doing ${protocol} — how do I make it sustainable?` });
      pool.push({ emoji: '🍽️', text: `What should I eat in my ${protocol === 'omad' ? 'one meal' : '4-hour window'} for best results?` });
    } else if (protocol === '18:6') {
      pool.push({ emoji: '⏱️', text: "18:6 is tough some days — tips for the last 2 hours?" });
      pool.push({ emoji: '🍽️', text: "What are the best foods to break my 18:6 fast?" });
    } else {
      pool.push({ emoji: '⏱️', text: "I'm doing 16:8 — how do I maximise results?" });
      pool.push({ emoji: '🍽️', text: "What should I eat to break my fast properly?" });
    }

    if (goal === 'weight_loss') {
      pool.push({ emoji: '📉', text: "Is fasting actually helping me lose weight?" });
    } else if (goal === 'metabolic_health') {
      pool.push({ emoji: '🧬', text: "How does fasting improve my metabolic health?" });
    } else if (goal === 'longevity') {
      pool.push({ emoji: '🌿', text: "What does the science say about fasting and longevity?" });
    } else {
      pool.push({ emoji: '💡', text: "What are the main benefits I should expect from fasting?" });
    }

    if (level === 'beginner') {
      pool.push({ emoji: '🌱', text: "I'm new to fasting — what should I expect this week?" });
    } else if (level === 'advanced') {
      pool.push({ emoji: '🚀', text: "How do I take my fasting practice to the next level?" });
    }

    if (caffeine === 'none') {
      pool.push({ emoji: '💧', text: "Caffeine-free fasting — what helps with hunger?" });
    } else {
      pool.push({ emoji: '☕', text: "Does my coffee or tea break my fast?" });
    }

    if (isMorning) pool.push({ emoji: '🌅', text: "Good morning — how do I power through the rest of my fast?" });
    else if (isEvening) pool.push({ emoji: '🌙', text: "My eating window is closing — any tips for tonight?" });

    pool.push({ emoji: '📊', text: "What does my fasting streak and completion data show?" });
    pool.push({ emoji: '🔄', text: "How does fasting interact with my sleep and energy?" });

    res.json({ prompts: pool.slice(0, 6) });
  } catch (err) {
    console.error('[fasting] /chat-prompts error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// ================================================================
router.patch('/setup', async (req, res) => {
  try {
    const { deviceId, protocol, goal, wake_time_min, bed_time_min, caffeine_habit, eating_window_start_min } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const fSnap = await fastingDoc(deviceId).get();
    if (!fSnap.exists || !fSnap.data()?.setup_completed) {
      return res.status(400).json({ error: 'Setup not completed' });
    }

    const existing = fSnap.data()?.setup || {};
    const updates  = {};

    if (protocol !== undefined) {
      const targetHours = protocol === '12:12' ? 12 : protocol === '14:10' ? 14
        : protocol === '18:6' ? 18 : protocol === '20:4' ? 20 : 16;
      updates['setup.protocol']          = protocol;
      updates['setup.target_fast_hours'] = targetHours;

      // Track protocol history
      const history = fSnap.data()?.protocol_history || [];
      history.push({ protocol, started_at: dateStr() });
      updates.protocol_history = history;
      updates.ready_for_upgrade = false;
      updates.analysis_cache = null;
    }
    if (goal                    !== undefined) updates['setup.goal']                    = goal;
    if (wake_time_min           !== undefined) updates['setup.wake_time_min']           = wake_time_min;
    if (bed_time_min            !== undefined) updates['setup.bed_time_min']            = bed_time_min;
    if (caffeine_habit          !== undefined) updates['setup.caffeine_habit']          = caffeine_habit;
    if (eating_window_start_min !== undefined) {
      updates['setup.eating_window_start_min'] = eating_window_start_min;
      updates['setup.schedule_type']           = 'manual';
    }

    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No fields to update' });

    await fastingDoc(deviceId).update(updates);
    invalidateCtx(deviceId);

    const newSetup = { ...existing, ...Object.fromEntries(
      Object.entries(updates)
        .filter(([k]) => k.startsWith('setup.'))
        .map(([k, v]) => [k.replace('setup.', ''), v])
    )};
    const { windowStart, windowEnd } = calcEatingWindow(newSetup);
    const activeSessionId = fSnap.data()?.active_session_id || null;

    return res.json({
      success:                 true,
      windowStart,
      windowEnd,
      window_end_min:          windowEnd,
      new_target_hours:        newSetup.target_fast_hours,
      new_protocol:            newSetup.protocol,
      active_session_preserved: !!activeSessionId,
    });
  } catch (e) {
    console.error('[fasting] patch/setup:', e);
    return res.status(500).json({ error: 'Failed' });
  }
});

// ================================================================
// POST /session/start -- begin a fast
// ================================================================
router.post('/session/start', async (req, res) => {
  try {
    const { deviceId, notes, started_at: customStartedAt } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const fSnap = await fastingDoc(deviceId).get();
    if (!fSnap.exists) return res.status(400).json({ error: 'Setup not completed' });

    const data   = fSnap.data() || {};
    const setup  = data.setup || {};

    // Block if user already broke a session today — one session per day rule
    const todayKey    = dateStr();
    const todaySnap   = await sessionsCol(deviceId).where('date', '==', todayKey).limit(5).get();
    const alreadyBrokenToday = todaySnap.docs.some(d => d.data().broken_early === true);
    if (alreadyBrokenToday) {
      return res.status(409).json({
        error:   'already_broken_today',
        message: 'You already ended a fast early today. Come back tomorrow for a fresh start.',
      });
    }

    // End any stale active session first
    if (data.active_session_id) {
      const staleSnap = await sessionsCol(deviceId).doc(data.active_session_id).get();
      if (staleSnap.exists) {
        const stale       = staleSnap.data();
        const elapsed     = getElapsedHours(stale.started_at);
        const staleTarget = stale.target_hours || setup.target_fast_hours || 16;
        await sessionsCol(deviceId).doc(data.active_session_id).update({
          ended_at:     admin.firestore.FieldValue.serverTimestamp(),
          actual_hours: round(elapsed, 2),
          completed:    elapsed >= staleTarget,
          broken_early: elapsed < staleTarget,
          broken_reason:'new_session',
        });
      }
    }

    // Validate optional custom start time (allow up to 23h backdating, not future)
    let firestoreStartedAt;
    let startDate;
    if (customStartedAt) {
      const customMs = new Date(customStartedAt).getTime();
      if (isNaN(customMs)) return res.status(400).json({ error: 'invalid started_at' });
      const now = Date.now();
      if (customMs > now + 60000)              return res.status(400).json({ error: 'started_at cannot be in the future' });
      if (customMs < now - 23 * 3600 * 1000)  return res.status(400).json({ error: 'started_at too far in the past' });
      firestoreStartedAt = admin.firestore.Timestamp.fromMillis(customMs);
      startDate = dateStr(new Date(customMs));
    } else {
      firestoreStartedAt = admin.firestore.FieldValue.serverTimestamp();
      startDate = dateStr();
    }

    // Capture cross-agent mood at start
    let moodAtStart = null;
    try {
      const mindSnap = await userDoc(deviceId).collection('agents').doc('mind')
        .collection('mind_checkins').orderBy('created_at', 'desc').limit(1).get();
      if (!mindSnap.empty) moodAtStart = mindSnap.docs[0].data().mood_score || null;
    } catch { /* non-fatal */ }

    const sessionRef = sessionsCol(deviceId).doc();

    await db().runTransaction(async (tx) => {
      tx.set(sessionRef, {
        created_at:      admin.firestore.FieldValue.serverTimestamp(),
        started_at:      firestoreStartedAt,
        ended_at:        null,
        target_hours:    setup.target_fast_hours || 16,
        actual_hours:    null,
        completed:       false,
        broken_early:    false,
        broken_reason:   null,
        metabolic_stage_reached: 'fed',
        notes:           notes || '',
        mood_at_start:   moodAtStart,
        mood_at_end:     null,
        sleep_quality_prior: null,
        water_ml_during_fast: 0,
        date:            startDate,
      });

      tx.update(fastingDoc(deviceId), {
        active_session_id:       sessionRef.id,
        total_sessions_started:  admin.firestore.FieldValue.increment(1),
        analysis_cache:          null,
      });
    });

    invalidateCtx(deviceId);

    return res.json({ success: true, session_id: sessionRef.id, started_at: customStartedAt || new Date().toISOString() });
  } catch (e) {
    console.error('[fasting] session/start:', e);
    return res.status(500).json({ error: 'Failed to start session' });
  }
});

async function refreshFastingScore(deviceId) {
  try {
    const cutoff7d = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

    const [sessSnap, fastSnap] = await Promise.all([
      sessionsCol(deviceId).orderBy('started_at', 'desc').limit(60).get(),
      fastingDoc(deviceId).get(),
    ]);
    const setup  = (fastSnap.data() || {}).setup || {};
    const targetH = setup.target_fast_hours || 16;

    const sessions = sessSnap.docs.map(d => d.data());
    if (!sessions.length) return;

    const completed  = sessions.filter(s => s.completed);
    const streak     = fastSnap.data()?.streak || 0;
    const daysLogged = new Set(sessions.map(s => s.date || '')).size;

    // All-time completion rate
    const completionRate = sessions.length > 0 ? completed.length / sessions.length : 0;

    // 7-day cohort
    const sessions7d  = sessions.filter(s => (s.date || '') >= cutoff7d);
    const completed7d = sessions7d.filter(s => s.completed);
    const completionRate7d = sessions7d.length > 0 ? completed7d.length / sessions7d.length : completionRate;

    // Average duration (all-time and 7d)
    const avgHours   = completed.length
      ? completed.reduce((s, x) => s + (x.actual_hours || 0), 0) / completed.length : 0;
    const avgHours7d = completed7d.length
      ? completed7d.reduce((s, x) => s + (x.actual_hours || 0), 0) / completed7d.length : avgHours;

    // Metabolic stage penetration rates (completed sessions with actual_hours)
    const withHours = completed.filter(s => s.actual_hours > 0);
    const pctFatBurn  = withHours.length
      ? withHours.filter(s => s.actual_hours >= 12).length / withHours.length : 0;
    const pctKetosis  = withHours.length
      ? withHours.filter(s => s.actual_hours >= 16).length / withHours.length : 0;

    const result = _computeFastingScore({
      completion_rate:       completionRate,
      completion_rate_7d:    completionRate7d,
      streak,
      avg_hours:             avgHours,
      avg_hours_7d:          avgHours7d,
      target_hours:          targetH,
      pct_reaching_fat_burn: pctFatBurn,
      pct_reaching_ketosis:  pctKetosis,
      days_logged:           daysLogged,
    });
    if (!result) return;

    await fastingDoc(deviceId).update({
      current_score:      result.score,
      score_label:        result.label,
      score_components:   result.components,
      score_clinical_flag: result.clinical_flag,
      score_updated_at:   admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('[fasting] refreshScore:', err.message);
  }
}

// ================================================================
// POST /session/end -- complete or break fast
// ================================================================
router.post('/session/end', async (req, res) => {
  try {
    const { deviceId, broken_reason, notes } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const fSnap = await fastingDoc(deviceId).get();
    if (!fSnap.exists) return res.status(400).json({ error: 'No setup' });

    const data   = fSnap.data() || {};
    const setup  = data.setup || {};
    const sessId = data.active_session_id;
    if (!sessId) return res.status(400).json({ error: 'No active session' });

    const sessSnap = await sessionsCol(deviceId).doc(sessId).get();
    if (!sessSnap.exists) return res.status(400).json({ error: 'Session not found' });

    const sess         = sessSnap.data();
    const elapsed      = getElapsedHours(sess.started_at);
    const target       = sess.target_hours || setup.target_fast_hours || 16;
    const completed    = !broken_reason && elapsed >= target;
    const stage        = getStage(elapsed);

    // Cross-agent: get water ml during fast window
    let waterMl = 0;
    try {
      const startMs = getMillis(sess.started_at);
      const waterLogsSnap = await userDoc(deviceId).collection('agents').doc('water')
        .collection('water_logs')
        .where('logged_at', '>=', new Date(startMs))
        .get();
      waterMl = waterLogsSnap.docs.reduce((sum, d) => { const w = d.data(); return sum + (w.effective_ml || w.ml || 0); }, 0);
    } catch { /* non-fatal */ }

    // Mood at end
    let moodAtEnd = null;
    try {
      const mindSnap = await userDoc(deviceId).collection('agents').doc('mind')
        .collection('mind_checkins').orderBy('created_at', 'desc').limit(1).get();
      if (!mindSnap.empty) moodAtEnd = mindSnap.docs[0].data().mood_score || null;
    } catch { /* non-fatal */ }

    await sessionsCol(deviceId).doc(sessId).update({
      ended_at:             admin.firestore.FieldValue.serverTimestamp(),
      actual_hours:         round(elapsed, 2),
      completed,
      broken_early:         !completed,
      broken_reason:        broken_reason || null,
      metabolic_stage_reached: stage.id,
      water_ml_during_fast: waterMl,
      mood_at_end:          moodAtEnd,
      notes:                notes || sess.notes || '',
    });

    // Recompute stats
    const allSessions = (await sessionsCol(deviceId).orderBy('started_at', 'desc').limit(100).get())
      .docs.map(mapDoc);

    // v2 Actions hook (fires on every session end)
    _onFastingLog(deviceId);

    const {
      currentStreak,
      longestStreak,
      completion7,
      avgH7,
      totalDone,
      readyForUpgrade,
    } = buildSessionStats(allSessions, target, data.longest_streak || 0);
    const readyForUpgradeNow = !!data.ready_for_upgrade || readyForUpgrade;
    const newlyReadyForUpgrade = readyForUpgrade && !data.ready_for_upgrade;

    await fastingDoc(deviceId).update({
      active_session_id:        null,
      current_streak:           currentStreak,
      longest_streak:           longestStreak,
      total_sessions_completed: totalDone,
      completion_rate_7d:       completion7,
      avg_fast_hours_7d:        avgH7,
      ready_for_upgrade:        readyForUpgradeNow,
      last_session_date:        dateStr(),
      analysis_cache:           null,
    });

    invalidateCtx(deviceId);

    const nextActionState = {
      ...data,
      total_sessions_completed: totalDone,
    };
    if (isActionBatchDue(nextActionState)) {
      queueActionBatchGeneration(deviceId, {
        generationKind: 'pattern',
        completedTotalAtGeneration: totalDone,
      }).catch(err => {
        console.error('[fasting] session/end action queue:', err);
      });
    }

    refreshFastingScore(deviceId).catch(() => {});
    return res.json({
      success:         true,
      completed,
      actual_hours:    round(elapsed, 2),
      stage_reached:   stage.id,
      stage_label:     stage.label,
      new_streak:      currentStreak,
      longest_streak:    longestStreak,
      ready_for_upgrade: newlyReadyForUpgrade,
    });
  } catch (e) {
    console.error('[fasting] session/end:', e);
    return res.status(500).json({ error: 'Failed to end session' });
  }
});

// ================================================================
// POST /session/backfill -- log any past fast
// ================================================================
router.post('/session/backfill', async (req, res) => {
  try {
    const { deviceId, date, started_at, ended_at, notes } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    if (!date) return res.status(400).json({ error: 'date required' });
    if (!started_at || !ended_at) {
      return res.status(400).json({ error: 'started_at and ended_at required' });
    }

    const fSnap = await fastingDoc(deviceId).get();
    if (!fSnap.exists || !fSnap.data()?.setup_completed) {
      return res.status(400).json({ error: 'Setup not completed' });
    }

    const today = dateStr();
    if (date >= today) {
      return res.status(400).json({ error: 'Backfill is only for past days' });
    }

    const dateMs = new Date(`${date}T12:00:00`).getTime();
    if (Number.isNaN(dateMs)) return res.status(400).json({ error: 'invalid date' });
    if (dateMs < Date.now() - 120 * 24 * 3600 * 1000) {
      return res.status(400).json({ error: 'date too far in the past' });
    }

    const startMs = new Date(started_at).getTime();
    const endMs = new Date(ended_at).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
      return res.status(400).json({ error: 'invalid timestamps' });
    }
    if (startMs >= endMs) {
      return res.status(400).json({ error: 'ended_at must be after started_at' });
    }
    if (endMs > Date.now() + 60000) {
      return res.status(400).json({ error: 'ended_at cannot be in the future' });
    }

    const durationHours = round((endMs - startMs) / 3600000, 2);
    if (durationHours > 36) {
      return res.status(400).json({ error: 'fast is too long for quick backfill' });
    }

    const duplicateSnap = await sessionsCol(deviceId)
      .where('date', '==', date)
      .limit(1)
      .get();
    if (!duplicateSnap.empty) {
      return res.status(409).json({ error: 'A fast is already logged for this day' });
    }

    const data = fSnap.data() || {};
    const setup = data.setup || {};
    const target = setup.target_fast_hours || 16;
    const completed = durationHours >= target;
    const stage = getStage(durationHours);

    let waterMl = 0;
    try {
      const waterLogsSnap = await userDoc(deviceId).collection('agents').doc('water')
        .collection('water_logs')
        .where('logged_at', '>=', new Date(startMs))
        .where('logged_at', '<=', new Date(endMs))
        .get();
      waterMl = waterLogsSnap.docs.reduce((sum, d) => { const w = d.data(); return sum + (w.effective_ml || w.ml || 0); }, 0);
    } catch { /* non-fatal */ }

    const sessionRef = sessionsCol(deviceId).doc();
    await sessionRef.set({
      created_at: admin.firestore.FieldValue.serverTimestamp(),
      started_at: admin.firestore.Timestamp.fromMillis(startMs),
      ended_at: admin.firestore.Timestamp.fromMillis(endMs),
      target_hours: target,
      actual_hours: durationHours,
      completed,
      broken_early: !completed,
      broken_reason: completed ? null : 'historical_backfill',
      metabolic_stage_reached: stage.id,
      notes: notes || '',
      mood_at_start: null,
      mood_at_end: null,
      sleep_quality_prior: null,
      water_ml_during_fast: waterMl,
      date,
      backfilled: true,
      backfilled_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    const allSessions = (await sessionsCol(deviceId).orderBy('started_at', 'desc').limit(200).get())
      .docs.map(mapDoc);
    const {
      currentStreak,
      longestStreak,
      completion7,
      avgH7,
      totalDone,
      readyForUpgrade,
    } = buildSessionStats(allSessions, target, data.longest_streak || 0);
    const readyForUpgradeNow = !!data.ready_for_upgrade || readyForUpgrade;

    await fastingDoc(deviceId).update({
      current_streak: currentStreak,
      longest_streak: longestStreak,
      total_sessions_started: admin.firestore.FieldValue.increment(1),
      total_sessions_completed: totalDone,
      completion_rate_7d: completion7,
      avg_fast_hours_7d: avgH7,
      ready_for_upgrade: readyForUpgradeNow,
      last_session_date: (data.last_session_date && data.last_session_date > date)
        ? data.last_session_date
        : date,
      analysis_cache: null,
    });

    invalidateCtx(deviceId);

    const nextActionState = {
      ...data,
      total_sessions_completed: totalDone,
    };
    if (isActionBatchDue(nextActionState)) {
      queueActionBatchGeneration(deviceId, {
        generationKind: 'pattern',
        completedTotalAtGeneration: totalDone,
      }).catch(err => {
        console.error('[fasting] session/backfill action queue:', err);
      });
    }

    return res.json({
      success: true,
      session_id: sessionRef.id,
      date,
      completed,
      actual_hours: durationHours,
      stage_reached: stage.id,
      stage_label: stage.label,
      current_streak: currentStreak,
    });
  } catch (e) {
    console.error('[fasting] session/backfill:', e);
    return res.status(500).json({ error: 'Failed to save past fast' });
  }
});

// ================================================================
// GET /today -- current session status + stage
// ================================================================
router.get('/today', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const fSnap = await fastingDoc(deviceId).get();
    if (!fSnap.exists || !fSnap.data()?.setup_completed) {
      return res.json({ setup_completed: false });
    }

    const data   = fSnap.data() || {};
    const setup  = data.setup || {};
    const { windowStart, windowEnd } = calcEatingWindow(setup);

    let activeSession = null;
    if (data.active_session_id) {
      const sessSnap = await sessionsCol(deviceId).doc(data.active_session_id).get();
      if (sessSnap.exists) {
        const sess         = sessSnap.data();
        const elapsed      = getElapsedHours(sess.started_at);
        const target       = sess.target_hours || setup.target_fast_hours || 16;
        const stage        = getStage(elapsed);
        const pct          = clamp(elapsed / target, 0, 1);

        activeSession = {
          id:            data.active_session_id,
          started_at:    toIso(sess.started_at),
          target_hours:  target,
          elapsed_hours: round(elapsed, 2),
          hours_left:    round(Math.max(0, target - elapsed), 2),
          pct:           round(pct, 3),
          stage:         stage.id,
          stage_label:   stage.label,
          completed_goal: elapsed >= target,
        };
      }
    }

    // Today's sessions (no orderBy to avoid composite index requirement)
    const today = dateStr();
    const todaySnap = await sessionsCol(deviceId)
      .where('date', '==', today)
      .limit(5)
      .get();
    const todaySessions  = todaySnap.docs.map(mapDoc);
    const todayCompleted = todaySessions.some(s => s.completed);
    const brokenSession  = !activeSession && todaySessions.find(s => s.broken_early);
    const todayBroken    = !!brokenSession;

    // 28-day calendar for streak strip
    const calCutoff = Date.now() - 28 * 24 * 3600 * 1000;
    const calSnap   = await sessionsCol(deviceId).orderBy('started_at', 'desc').limit(80).get();
    const date_logs = {};
    for (const doc of calSnap.docs) {
      const s   = doc.data();
      const sMs = getMillis(s.started_at);
      if (sMs < calCutoff) break;
      const key = s.date || dateStr(new Date(sMs));
      const ex  = date_logs[key];
      const better = !ex || (s.completed && !ex.completed) || (!ex.completed && (s.actual_hours || 0) > (ex.hours || 0));
      if (better) date_logs[key] = { completed: s.completed || false, hours: round(s.actual_hours || 0, 1) };
    }

    return res.json({
      setup_completed:    true,
      setup,
      window_start_min:   windowStart,
      window_end_min:     windowEnd,
      active_session:     activeSession,
      today_completed:    todayCompleted,
      today_broken:         todayBroken,
      today_broken_reason:  brokenSession?.broken_reason || null,
      today_broken_note:    brokenSession?.notes || null,
      today_broken_hours:   brokenSession ? round(brokenSession.actual_hours || 0, 1) : null,
      today_broken_stage:   brokenSession?.metabolic_stage_reached || null,
      today_sessions:       todaySessions.map(s => ({
        id:            s.id,
        started_at:    toIso(s.started_at),
        ended_at:      toIso(s.ended_at),
        actual_hours:  s.actual_hours,
        completed:     s.completed,
        stage_reached: s.metabolic_stage_reached,
        broken_reason: s.broken_reason || null,
        notes:         s.notes || null,
      })),
      date_logs,
      current_streak:     data.current_streak || 0,
      longest_streak:     data.longest_streak || 0,
      completion_rate_7d: data.completion_rate_7d || 0,
      avg_fast_hours_7d:  data.avg_fast_hours_7d  || 0,
      ready_for_upgrade:  data.ready_for_upgrade  || false,
      total_completed:    data.total_sessions_completed || 0,
    });
  } catch (e) {
    console.error('[fasting] today:', e);
    return res.status(500).json({ error: 'Failed' });
  }
});

// ================================================================
// GET /history -- past sessions
// ================================================================
router.get('/history', async (req, res) => {
  try {
    const { deviceId, limit: lim = 30 } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const snap = await sessionsCol(deviceId)
      .orderBy('started_at', 'desc')
      .limit(parseInt(lim, 10) || 30)
      .get();

    const sessions = snap.docs.map(d => {
      const s = d.data();
      return {
        id:           d.id,
        date:         s.date,
        started_at:   toIso(s.started_at),
        ended_at:     toIso(s.ended_at),
        actual_hours: s.actual_hours,
        target_hours: s.target_hours,
        completed:    s.completed,
        broken_early: s.broken_early,
        broken_reason:s.broken_reason,
        stage_reached:s.metabolic_stage_reached,
      };
    });

    return res.json({ sessions });
  } catch (e) {
    console.error('[fasting] history:', e);
    return res.status(500).json({ error: 'Failed' });
  }
});

// ================================================================
// GET /calendar -- 90-day date_logs map for calendar strip
// ================================================================
router.get('/calendar', async (req, res) => {
  try {
    const { deviceId, days: daysParam = '90' } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const days   = Math.min(parseInt(daysParam, 10) || 90, 365);
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
    cutoff.setHours(0, 0, 0, 0);

    const snap = await sessionsCol(deviceId)
      .orderBy('started_at', 'desc')
      .limit(days + 10)
      .get();

    const date_logs = {};
    for (const doc of snap.docs) {
      const s = doc.data();
      const d = s.date || dateStr(new Date(getMillis(s.started_at)));
      if (!d) continue;
      // Keep the best session per day (completed > partial > broke early)
      const existing = date_logs[d];
      const better = !existing
        || (s.completed && !existing.completed)
        || (!s.completed && !existing.completed && (s.actual_hours || 0) > (existing.actual_hours || 0));
      if (better) {
        date_logs[d] = {
          completed:    s.completed || false,
          actual_hours: round(s.actual_hours || 0, 1),
          target_hours: s.target_hours || null,
          stage_reached:s.metabolic_stage_reached || null,
          broken_early: s.broken_early || false,
        };
      }
    }

    return res.json({ date_logs });
  } catch (e) {
    console.error('[fasting] calendar:', e);
    return res.status(500).json({ error: 'Failed' });
  }
});

// ================================================================
// GET /analysis -- AI insight + stats
// ================================================================
// ── Analysis helpers ──────────────────────────────────────────────

function computeLongestStreak(sessions = []) {
  const completedDates = new Set();
  for (const s of sessions) {
    if (s.completed) completedDates.add(s.date || dateStr(new Date(getMillis(s.started_at))));
  }
  const sorted = [...completedDates].sort();
  let longest = 0, current = 0, prevDate = null;
  for (const ds of sorted) {
    if (prevDate) {
      const diff = Math.round((new Date(ds + 'T12:00:00') - new Date(prevDate + 'T12:00:00')) / 86400000);
      current = diff === 1 ? current + 1 : 1;
    } else {
      current = 1;
    }
    longest = Math.max(longest, current);
    prevDate = ds;
  }
  return longest;
}


function getSessionDateKey(session = {}) {
  return session.date || dateStr(new Date(getMillis(session.started_at)));
}

function parseDayKey(dayKey) {
  return new Date(`${dayKey}T12:00:00`);
}

function shiftDayKey(dayKey, deltaDays) {
  const d = parseDayKey(dayKey);
  d.setDate(d.getDate() + deltaDays);
  return dateStr(d);
}

function formatDayKey(dayKey) {
  if (!dayKey) return '';
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function computeCompletionFromSessions(sessions = []) {
  if (!sessions.length) return 0;
  return round(
    sessions.filter(s => s.completed).length / sessions.length,
    2,
  );
}

function computeAvgHoursFromSessions(sessions = []) {
  const done = sessions.filter(s => s.completed && s.actual_hours);
  if (!done.length) return 0;
  return round(avg(done.map(s => s.actual_hours || 0)), 1);
}

function buildRangeMeta(range, allSessions = []) {
  const todayKey = dateStr();
  if (range === 'all') {
    const allKeys = allSessions
      .map(getSessionDateKey)
      .filter(Boolean)
      .sort();
    const startKey = allKeys[0] || todayKey;
    const endKey = todayKey;
    const spanDays = Math.max(
      1,
      Math.round((parseDayKey(endKey) - parseDayKey(startKey)) / 86400000) + 1,
    );
    return {
      key: 'all',
      isAllTime: true,
      days: spanDays,
      startKey,
      endKey,
      label: 'All time',
      summary: `${formatDayKey(startKey)} - ${formatDayKey(endKey)} · all logged history`,
      shortSummary: `${formatDayKey(startKey)} - ${formatDayKey(endKey)}`,
    };
  }

  const days = Math.max(1, parseInt(range, 10) || 30);
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  const startKey = dateStr(start);
  const endKey = dateStr(end);
  return {
    key: String(days),
    isAllTime: false,
    days,
    startKey,
    endKey,
    label: `${days} days`,
    summary: `${formatDayKey(startKey)} - ${formatDayKey(endKey)} · ${days} calendar days`,
    shortSummary: `${formatDayKey(startKey)} - ${formatDayKey(endKey)}`,
  };
}

function filterSessionsToRange(allSessions = [], rangeMeta) {
  return allSessions.filter(session => {
    const key = getSessionDateKey(session);
    return key && key >= rangeMeta.startKey && key <= rangeMeta.endKey;
  });
}

function buildDayKeysInRange(startKey, endKey) {
  const keys = [];
  let current = startKey;
  while (current <= endKey) {
    keys.push(current);
    current = shiftDayKey(current, 1);
  }
  return keys;
}

function buildAnalysisContext({
  setup = {},
  targetHours = 16,
  rangeMeta,
  selectedSessions = [],
  previousSessions = [],
  allSessions = [],
  selectedCompletion = 0,
  selectedAvgHours = 0,
  selectedBestFast = 0,
}) {
  const protocol = setup.protocol || '16:8';
  const selectedCompleted = selectedSessions.filter(s => s.completed);
  const currentStreak = computeStreak(allSessions);
  const longestStreak = computeLongestStreak(allSessions);

  const breakReasonCounts = {};
  for (const s of selectedSessions.filter(s => s.broken_early)) {
    const reason = s.broken_reason || 'unknown';
    breakReasonCounts[reason] = (breakReasonCounts[reason] || 0) + 1;
  }
  const topBreakReasons = Object.entries(breakReasonCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([reason, count]) => `${reason}×${count}`)
    .join(', ');

  const previousCompletion = computeCompletionFromSessions(previousSessions);
  const previousAvgHours = computeAvgHoursFromSessions(previousSessions);
  const completionDelta = Math.round(
    (selectedCompletion - previousCompletion) * 100,
  );
  const avgDelta = round(selectedAvgHours - previousAvgHours, 1);

  const selectedLogLines = selectedSessions
    .slice()
    .sort((a, b) => getMillis(b.started_at) - getMillis(a.started_at))
    .slice(0, 18)
    .map(session => {
      const key = getSessionDateKey(session);
      if (session.completed) {
        return `${key}: completed ${round(session.actual_hours || 0, 1)}h, reached ${session.metabolic_stage_reached || getStage(session.actual_hours || 0).id}`;
      }
      return `${key}: partial ${round(session.actual_hours || 0, 1)}h${session.broken_reason ? `, broke for ${session.broken_reason}` : ''}`;
    })
    .join('\n');

  return [
    `Selected analysis window: ${rangeMeta.summary}.`,
    `Protocol: ${protocol}. Target: ${targetHours}h.`,
    `In this window: ${selectedSessions.length} logs, ${selectedCompleted.length} completed, completion ${Math.round(selectedCompletion * 100)}%, avg completed fast ${selectedAvgHours}h, best fast ${round(selectedBestFast, 1)}h.`,
    previousSessions.length
      ? `Previous matching window: completion ${Math.round(previousCompletion * 100)}% (${completionDelta >= 0 ? '+' : ''}${completionDelta} pts), avg fast ${previousAvgHours}h (${avgDelta >= 0 ? '+' : ''}${avgDelta}h).`
      : 'No previous comparison window available yet.',
    topBreakReasons ? `Top break reasons in this window: ${topBreakReasons}.` : 'No early-break pattern in this window.',
    `All-time context: current streak ${currentStreak}d, longest streak ${longestStreak}d, completed fasts ${allSessions.filter(s => s.completed).length}.`,
    `Recent logs inside this window (newest first):\n${selectedLogLines || 'none yet'}`,
  ]
    .filter(Boolean)
    .join('\n');
}

router.get('/analysis', async (req, res) => {
  try {
    const { deviceId, range = '30' } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const fSnap = await fastingDoc(deviceId).get();
    if (!fSnap.exists) return res.json({ setup_completed: false });

    const data  = fSnap.data() || {};
    const setup = data.setup  || {};
    const sessSnap = await sessionsCol(deviceId).orderBy('started_at', 'desc').limit(400).get();
    const allSessions = sessSnap.docs.map(mapDoc);
    const rangeMeta = buildRangeMeta(range, allSessions);
    const sessions = filterSessionsToRange(allSessions, rangeMeta);
    const previousRangeMeta = rangeMeta.isAllTime
      ? null
      : {
          ...rangeMeta,
          startKey: shiftDayKey(rangeMeta.startKey, -rangeMeta.days),
          endKey: shiftDayKey(rangeMeta.startKey, -1),
        };
    const previousSessions = previousRangeMeta
      ? filterSessionsToRange(allSessions, previousRangeMeta)
      : [];

    const streak        = computeStreak(allSessions);
    const longestStreak = computeLongestStreak(allSessions);
    const completion    = computeCompletionFromSessions(sessions);
    const avgH          = computeAvgHoursFromSessions(sessions);
    const targetHours   = setup.target_fast_hours || 16;

    const completedSessions = sessions.filter(s => s.completed && s.actual_hours);
    const totalFastH    = completedSessions.reduce((sum, s) => sum + (s.actual_hours || 0), 0);
    const bestFastH     = completedSessions.reduce((max, s) => Math.max(max, s.actual_hours || 0), 0);

    // Daily map
    const byDate = {};
    for (const s of sessions) {
      const key = s.date || dateStr(new Date(getMillis(s.started_at)));
      if (!byDate[key]) byDate[key] = { hours: 0, completed: false, stage: null, broken_early: false };
      if ((s.actual_hours || 0) >= (byDate[key].hours || 0)) {
        byDate[key].hours       = s.actual_hours || 0;
        byDate[key].completed   = s.completed || false;
        byDate[key].stage       = s.metabolic_stage_reached || getStage(s.actual_hours || 0).id;
        byDate[key].broken_early = !s.completed;
      }
    }

    // Signal points: full selected calendar range, not just logged days.
    const rangeKeys = buildDayKeysInRange(rangeMeta.startKey, rangeMeta.endKey);
    const hasAnyLogsInRange = rangeKeys.some(key => byDate[key]?.hours > 0);
    const signal_points = hasAnyLogsInRange
      ? rangeKeys.map(key => {
          const [y, m, d] = key.split('-').map(Number);
          const dayLog = byDate[key] || null;
          const label = new Date(y, m - 1, d).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
          });
          return {
            value: round(dayLog?.hours || 0, 1),
            completed: !!dayLog?.completed,
            skipped: !dayLog,
            date: key,
            label,
          };
        })
      : [];

    // 28-day heatmap
    const daily_logs = {};
    for (let i = 27; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const key = dateStr(d);
      if (byDate[key]) daily_logs[key] = byDate[key];
    }

    // Stage breakdown (all-time, for pattern analysis)
    const stageCounts = {};
    for (const s of allSessions.filter(s => s.completed && s.actual_hours)) {
      const id = s.metabolic_stage_reached || getStage(s.actual_hours).id;
      stageCounts[id] = (stageCounts[id] || 0) + 1;
    }
    const totalComp = allSessions.filter(s => s.completed).length;
    const STAGE_META = {
      fed:            { label: 'Fed State',        emoji: '🍽️', color: '#6B7280' },
      post_absorptive:{ label: 'Post-Absorptive',  emoji: '⚡', color: '#FBBF24' },
      glycogen:       { label: 'Glycogen Burning', emoji: '🔥', color: '#F97316' },
      fat_burning:    { label: 'Fat Burning',      emoji: '💪', color: '#EA580C' },
      ketosis_entry:  { label: 'Ketosis Entry',    emoji: '🧬', color: '#DC2626' },
      autophagy:      { label: 'Autophagy Active', emoji: '🔬', color: '#B91C1C' },
      deep_fast:      { label: 'Deep Fast',        emoji: '🌙', color: '#7F1D1D' },
    };
    const stage_breakdown = Object.entries(stageCounts)
      .map(([id, count]) => ({
        id, count,
        label: STAGE_META[id]?.label || id,
        emoji: STAGE_META[id]?.emoji || '⚡',
        color: STAGE_META[id]?.color || '#F97316',
        pct: totalComp > 0 ? Math.round(count / totalComp * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count);

    // Recent timeline — order by when the user added/logged the entry, not by fast date.
    const recent_timeline = sessions
      .filter(s => s.ended_at)
      .sort((a, b) => getSessionRecentOrderMillis(b) - getSessionRecentOrderMillis(a))
      .slice(0, 10)
      .map(s => ({
        date_str:      s.date || dateStr(new Date(getMillis(s.started_at))),
        actual_hours:  round(s.actual_hours || 0, 1),
        target_hours:  s.target_hours || targetHours,
        completed:     s.completed || false,
        broken_early:  !s.completed,
        broken_reason: s.broken_reason || null,
        stage_reached: s.metabolic_stage_reached || getStage(s.actual_hours || 0).id,
      }));

    // Programmatic observations
    const observations = [];
    if (completion >= 0.8) {
      observations.push({ title: `${Math.round(completion * 100)}% completion — elite consistency`, body: 'At 80%+ consistency, metabolic flexibility is actively building. Fat oxidation is becoming your default fuel system.', accent: 'green' });
    } else if (completion < 0.5 && sessions.length >= 3) {
      observations.push({ title: `${Math.round(completion * 100)}% completion — room to build`, body: 'Most early breaks happen in the 8–12h glycogen window. Push through that window once and the next fast gets measurably easier.', accent: 'red' });
    }
    if (streak >= 7) {
      observations.push({ title: `${streak}-day streak — ghrelin is adapting`, body: 'After 7 consecutive fasts, ghrelin pulse timing shifts. You will notice hunger cues becoming predictable and weaker at fast times.', accent: 'purple' });
    }
    if (avgH > 0 && avgH < targetHours * 0.85) {
      observations.push({ title: `Avg ${avgH}h vs ${targetHours}h target — closing the gap`, body: `You're ${round(targetHours - avgH, 1)}h short of your protocol target on average. The fat-burning switch flips at 12h — push 2 more hours beyond your usual stopping point.`, accent: 'yellow' });
    }
    if (bestFastH >= 20) {
      observations.push({ title: `Personal best: ${round(bestFastH, 1)}h fast recorded`, body: 'A 20h+ fast reaches deep autophagy territory. That cellular repair event is now in your biological history.', accent: 'purple' });
    }

    // Fasting score — 5-gate algorithm for cross-screen consistency
    const _fastingDaysLogged = Object.keys(byDate).length;
    const _cutoff7d = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const _sessions7d   = allSessions.filter(s => (s.date || '') >= _cutoff7d);
    const _completed7d  = _sessions7d.filter(s => s.completed);
    const _cr7d  = _sessions7d.length > 0 ? _completed7d.length / _sessions7d.length : completion;
    const _avgH7 = _completed7d.length
      ? _completed7d.reduce((s, x) => s + (x.actual_hours || 0), 0) / _completed7d.length : avgH;
    const _withH = completedSessions.filter(s => s.actual_hours > 0);
    const _pctFB = _withH.length ? _withH.filter(s => s.actual_hours >= 12).length / _withH.length : 0;
    const _pctKT = _withH.length ? _withH.filter(s => s.actual_hours >= 16).length / _withH.length : 0;
    const fasting_score = _computeFastingScore({
      completion_rate:       completion,
      completion_rate_7d:    _cr7d,
      streak,
      avg_hours:             avgH,
      avg_hours_7d:          _avgH7,
      target_hours:          targetHours,
      pct_reaching_fat_burn: _pctFB,
      pct_reaching_ketosis:  _pctKT,
      days_logged:           _fastingDaysLogged,
    });

    // AI insight
    let ai_insight = null, personal_formula = null;
    try {
      const latestMarker = allSessions[0]
        ? (allSessions[0].date || toIso(allSessions[0].started_at) || 'latest')
        : 'none';
      const cacheKey = [
        rangeMeta.key,
        rangeMeta.startKey,
        rangeMeta.endKey,
        targetHours,
        streak,
        longestStreak,
        Math.round(completion * 100),
        avgH,
        round(bestFastH, 1),
        round(totalFastH, 1),
        sessions.length,
        latestMarker,
      ].join('|');
      const cacheId = crypto.createHash('sha1').update(cacheKey).digest('hex');
      const cached = data.analysis_cache;
      const cachedEntry = cached?.entries?.[cacheId];

      if (cachedEntry?.key === cacheKey) {
        ai_insight = cachedEntry.insight || null;
        personal_formula = cachedEntry.formula || null;
      } else {
        const context = buildAnalysisContext({
          setup,
          targetHours,
          rangeMeta,
          selectedSessions: sessions,
          previousSessions,
          allSessions,
          selectedCompletion: completion,
          selectedAvgHours: avgH,
          selectedBestFast: bestFastH,
        });
        const insightPrompt = [
          'You are the fasting intelligence analyst inside a premium fasting app.',
          'Return ONLY valid JSON. No markdown. No code fences.',
          'JSON schema: { "insight": string, "formula": string }',
          `Analyze ONLY the selected window: ${rangeMeta.summary}.`,
          'You may reference all-time context only when explicitly labeled as all-time.',
          'The insight must be exactly 2 short sentences, sharp and data-driven, using exact numbers from the selected window.',
          'The formula must be 1 short action line for the next cycle, concrete and immediately usable.',
          'If there is a meaningful change vs the previous matching window, name it directly.',
          'Do not mention data outside the selected window as if it happened inside the window.',
          'No filler, no hype, no generic fasting advice.',
        ].join(' ');
        const aiRes = await openai.chat.completions.create({
          model: 'gpt-4.1-mini', max_tokens: 180, temperature: 0.25,
          messages: [
            { role: 'system', content: insightPrompt },
            { role: 'user',   content: context },
          ],
        });
        const parsed = JSON.parse(aiRes.choices[0].message.content.trim().replace(/```json|```/g, ''));
        ai_insight       = parsed.insight      || null;
        personal_formula = parsed.formula      || null;

        if (ai_insight || personal_formula) {
          const existingEntries = data.analysis_cache?.entries || {};
          const generatedAt = new Date().toISOString();
          fastingDoc(deviceId).update({
            analysis_cache: {
              key: cacheKey,
              cache_id: cacheId,
              insight: ai_insight,
              formula: personal_formula,
              generated_at: generatedAt,
              entries: {
                ...existingEntries,
                [cacheId]: {
                  key: cacheKey,
                  range: rangeMeta.key,
                  start_key: rangeMeta.startKey,
                  end_key: rangeMeta.endKey,
                  insight: ai_insight,
                  formula: personal_formula,
                  generated_at: generatedAt,
                },
              },
            },
          }).catch(() => {});
        }
      }
    } catch (e) {
      console.error('[fasting] analysis insight:', e);
    }

    return res.json({
      setup_completed: true,
      range,
      range_meta: {
        key: rangeMeta.key,
        is_all_time: rangeMeta.isAllTime,
        days: rangeMeta.days,
        start_date: rangeMeta.startKey,
        end_date: rangeMeta.endKey,
        summary: rangeMeta.summary,
        short_summary: rangeMeta.shortSummary,
      },
      fasting_score,
      stats: {
        current_streak:   streak,
        longest_streak:   longestStreak,
        completion_rate:  completion,
        avg_fast_hours:   avgH,
        total_fasts:      sessions.length,
        completed_fasts:  completedSessions.length,
        best_fast_hours:  round(bestFastH, 1),
        total_fast_hours: round(totalFastH, 1),
        days_logged:      Object.keys(byDate).length,
        target_hours:     targetHours,
      },
      signal_points,
      daily_logs,
      stage_breakdown,
      recent_timeline,
      observations,
      ai_insight,
      personal_formula,
      ready_for_upgrade: _cr7d >= 0.85 && _avgH7 >= (targetHours - 0.5),
      avg_hours_7d:      round(_avgH7, 1),
      completion_rate_7d: Math.round(_cr7d * 100),
      cross_agent_snapshot: await (async () => {
        try {
          const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
          const [sleepRes, waterRes, mindRes] = await Promise.allSettled([
            userDoc(deviceId).collection('agents').doc('sleep')
              .collection('sleep_logs').orderBy('date', 'desc').limit(1).get(),
            (async () => {
              const wRef = await userDoc(deviceId).collection('agents').doc('water').get();
              const goalMl = wRef.exists ? (wRef.data()?.setup?.daily_goal_ml || wRef.data()?.setup?.recommended_goal_ml || 2500) : 2500;
              const wSnap = await userDoc(deviceId).collection('agents').doc('water')
                .collection('water_logs').where('logged_at', '>=', todayStart).get();
              const todayMl = wSnap.docs.reduce((s, d) => s + (d.data().effective_ml || 0), 0);
              return { todayMl, goalMl, pct: Math.min(1, todayMl / Math.max(goalMl, 1)) };
            })(),
            userDoc(deviceId).collection('agents').doc('mind')
              .collection('mind_checkins').orderBy('created_at', 'desc').limit(1).get(),
          ]);
          const sleepDoc   = sleepRes.status === 'fulfilled' && !sleepRes.value?.empty ? sleepRes.value.docs[0].data() : null;
          const waterData  = waterRes.status === 'fulfilled' ? waterRes.value : null;
          const mindDoc    = mindRes.status === 'fulfilled'  && !mindRes.value?.empty  ? mindRes.value.docs[0].data()  : null;
          const rawMind    = mindDoc ? (mindDoc.mood_score || mindDoc.current_rating || null) : null;
          return {
            sleep_quality:    sleepDoc?.quality_score ?? null,
            sleep_hrs:        sleepDoc?.total_hours_in_bed ?? sleepDoc?.duration_hours ?? null,
            water_today_pct:  waterData ? Math.round(waterData.pct * 100) : null,
            water_today_ml:   waterData?.todayMl ?? null,
            water_goal_ml:    waterData?.goalMl ?? null,
            mind_score:       rawMind != null ? Math.min(100, Math.round((rawMind / 4) * 100)) : null,
          };
        } catch { return null; }
      })(),
    });
  } catch (e) {
    console.error('[fasting] analysis:', e);
    return res.status(500).json({ error: 'Failed' });
  }
});

// ================================================================
// Actions: helpers
// ================================================================

const formatAction = a => ({
  id:                  a.id,
  title:               a.title || '',
  text:                a.text,
  why:                 a.why || '',
  trigger_reason:      a.trigger_reason || null,
  when_to_do:          a.when_to_do,
  category:            a.category,
  priority:            a.priority || 'today',
  impact:              clamp(parseInt(a.impact, 10) || 2, 1, 3),
  status:              a.status,
  batch_key:           a.batch_key || null,
  generated_at:        toIso(a.generated_at),
  generated_at_stage:  a.generated_at_stage || null,
  expires_at:          toIso(a.expires_at),
  completed_at:        toIso(a.completed_at),
  skipped_at:          toIso(a.skipped_at),
});

async function getCurrentFastingStage(deviceId, data = {}) {
  if (!data.active_session_id) {
    return { currentStage: null, elapsedHours: 0 };
  }

  try {
    const sessSnap = await sessionsCol(deviceId).doc(data.active_session_id).get();
    if (!sessSnap.exists) {
      return { currentStage: null, elapsedHours: 0 };
    }
    const elapsedHours = getElapsedHours(sessSnap.data().started_at);
    return {
      currentStage: getStage(elapsedHours),
      elapsedHours: round(elapsedHours, 1),
    };
  } catch {
    return { currentStage: null, elapsedHours: 0 };
  }
}

// ── Fasting-only context for action generation ───────────────────
async function buildActionContext(deviceId) {
  try {
    const fSnap = await fastingDoc(deviceId).get();
    if (!fSnap.exists) return 'No setup data found.';

    const data  = fSnap.data() || {};
    const setup = data.setup || {};
    const targetH = setup.target_fast_hours || 16;
    const protocol = setup.protocol || '16:8';
    const { windowStart, windowEnd } = calcEatingWindow(setup);

    const allSnap = await sessionsCol(deviceId)
      .orderBy('started_at', 'desc')
      .limit(180)
      .get();

    const allEnded = allSnap.docs.map(mapDoc).filter(s => s.ended_at);
    const cutoffMs = Date.now() - ACTION_LOOKBACK_DAYS * 24 * 3600 * 1000;
    const recentWindow = allEnded.filter(
      s => getMillis(s.started_at) >= cutoffMs,
    );
    const sessions = recentWindow.length ? recentWindow : allEnded.slice(0, 30);
    const completed = sessions.filter(s => s.completed);
    const broken = sessions.filter(s => s.broken_early);
    const latestThreeCompleted = allEnded.filter(s => s.completed).slice(0, 3);
    const streak = computeStreak(allEnded);
    const completionPct = sessions.length
      ? Math.round((completed.length / sessions.length) * 100)
      : 0;
    const avgCompletedH = completed.length
      ? round(avg(completed.map(s => s.actual_hours || 0)), 1)
      : 0;

    const breakReasonCounts = {};
    for (const s of broken) {
      const reason = s.broken_reason || 'unknown';
      breakReasonCounts[reason] = (breakReasonCounts[reason] || 0) + 1;
    }
    const topBreakReasons = Object.entries(breakReasonCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([reason, count]) => `${reason}×${count}`)
      .join(', ');

    const stageCounts = {};
    for (const s of completed) {
      const stageId = s.metabolic_stage_reached || 'unknown';
      stageCounts[stageId] = (stageCounts[stageId] || 0) + 1;
    }
    const topStages = Object.entries(stageCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([stageId, count]) => `${stageId.replace(/_/g, ' ')}×${count}`)
      .join(', ');

    const latestThreeLines = latestThreeCompleted.length
      ? latestThreeCompleted
          .map(
            s =>
              `${s.date || '?'}: ${round(s.actual_hours || 0, 1)}h, reached ${s.metabolic_stage_reached || 'unknown'}`,
          )
          .join('\n')
      : 'none yet';

    const sessionLog = sessions
      .slice(0, 24)
      .map(s => {
        const d = s.date || '?';
        if (s.completed) {
          return `${d}: ✓ ${round(s.actual_hours || 0, 1)}h → ${s.metabolic_stage_reached || '?'}`;
        }
        return `${d}: ✗ ${round(s.actual_hours || 0, 1)}h${s.broken_reason ? ` [${s.broken_reason}]` : ''}`;
      })
      .join('\n');

    const cachedInsight = data.analysis_cache?.insight || '';
    const cachedFormula = data.analysis_cache?.formula || '';

    return [
      `Protocol: ${protocol}. Target: ${targetH}h. Eating window: ${minsToLabel(windowStart)}-${minsToLabel(windowEnd)}.`,
      `Use the latest 3 completed fasts as the first priority signal. Use the full last ${ACTION_LOOKBACK_DAYS} days for pattern detection.`,
      `Last ${ACTION_LOOKBACK_DAYS} days: ${sessions.length} logged fasts, ${completed.length} completed (${completionPct}%), avg completed fast ${avgCompletedH}h, streak ${streak}d.`,
      topBreakReasons ? `Top break reasons: ${topBreakReasons}.` : 'No major break pattern yet.',
      topStages ? `Most reached stages: ${topStages}.` : '',
      `Latest 3 completed fasts:\n${latestThreeLines}`,
      cachedInsight ? `Latest analysis insight: ${cachedInsight}` : '',
      cachedFormula ? `Latest analysis formula: ${cachedFormula}` : '',
      `Recent fasting log (newest first):\n${sessionLog || 'none yet'}`,
    ]
      .filter(Boolean)
      .join('\n');
  } catch (e) {
    console.error('[fasting] buildActionContext:', e);
    return 'Context unavailable.';
  }
}

// Core generation: only used for setup batch or each 3-completed-fast cycle.
async function generateActionBatch(
  deviceId,
  { generationKind = 'pattern', completedTotalAtGeneration = null } = {},
) {
  const fSnap = await fastingDoc(deviceId).get();
  if (!fSnap.exists) return [];

  const data = fSnap.data() || {};
  const recentActionSnap = await actionsCol(deviceId)
    .orderBy('generated_at', 'desc')
    .limit(30)
    .get();

  const recentHandledNotes = recentActionSnap.docs
    .map(mapDoc)
    .filter(a => ['completed', 'skipped'].includes(a.status))
    .slice(0, 9)
    .map(a => `${a.status}: ${a.title || a.text}`)
    .join(' | ');

  const context = await buildActionContext(deviceId);
  const batchKey = `${dateStr()}_${Date.now()}`;

  const systemPrompt = [
    'You are the fasting actions engine for a premium fasting app.',
    'Generate exactly 3 short, high-value actions.',
    'Return JSON array ONLY.',
    'Schema: { "title": string <=24 chars, "text": string <=68 chars, "why": string <=88 chars, "trigger_reason": string <=44 chars, "when_to_do": "morning"|"afternoon"|"evening"|"anytime", "category": "hydration"|"timing"|"nutrition"|"mindset"|"education"|"safety", "priority": "today"|"next", "impact": 1|2|3 }',
    generationKind === 'setup'
      ? 'This is the setup batch. Make the first 3 actions reduce friction and make day one easy.'
      : `This is a pattern batch triggered after ${ACTION_BATCH_SIZE} new completed fasts.`,
    `Use the latest ${ACTION_BATCH_SIZE} completed fasts as the first priority signal.`,
    `Use the full last ${ACTION_LOOKBACK_DAYS} days to detect patterns and reinforce trends.`,
    'Action 1: biggest signal from the latest 3 completed fasts.',
    'Action 2: strongest recurring 30-day pattern.',
    'Action 3: the next best adjustment for the upcoming cycle.',
    'Every action must be concrete, personal, and short.',
    'No generic fasting advice. No filler. No hype. No repeated ideas.',
    recentHandledNotes
      ? `Avoid repeating these recent actions: ${recentHandledNotes}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const actRes = await openai.chat.completions.create({
    model: 'gpt-4.1-mini',
    max_tokens: 650,
    temperature: 0.28,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: context },
    ],
  });

  let newActions = [];
  try {
    const raw = actRes.choices[0].message.content
      .trim()
      .replace(/```json|```/g, '');
    newActions = JSON.parse(raw);
  } catch {
    newActions = [];
  }

  if (!Array.isArray(newActions) || newActions.length < ACTION_BATCH_SIZE) {
    throw new Error('action_generation_empty');
  }

  const oldActiveSnap = await actionsCol(deviceId)
    .where('status', '==', 'active')
    .limit(10)
    .get();

  const newBatch = db().batch();
  for (const d of oldActiveSnap.docs) {
    newBatch.update(d.ref, { status: 'archived' });
  }
  for (const a of newActions.slice(0, ACTION_BATCH_SIZE)) {
    const ref = actionsCol(deviceId).doc();
    newBatch.set(ref, {
      title: a.title || '',
      text: a.text || '',
      why: a.why || '',
      trigger_reason: a.trigger_reason || '',
      when_to_do: a.when_to_do || 'anytime',
      category: a.category || 'education',
      priority: a.priority || 'today',
      impact: clamp(parseInt(a.impact, 10) || 2, 1, 3),
      status: 'active',
      batch_key: batchKey,
      batch_kind: generationKind,
      generated_at: admin.firestore.FieldValue.serverTimestamp(),
      generated_at_stage: null,
      expires_at: null,
    });
  }

  newBatch.set(
    fastingDoc(deviceId),
    {
      last_action_batch_key: batchKey,
      last_action_batch_kind: generationKind,
      last_action_generated_at: admin.firestore.FieldValue.serverTimestamp(),
      ...(completedTotalAtGeneration != null
        ? {
            last_action_generation_completed_total: completedTotalAtGeneration,
            last_regen_session: completedTotalAtGeneration,
          }
        : {}),
      action_generation_status: 'idle',
      action_generation_finished_at: admin.firestore.FieldValue.serverTimestamp(),
      action_generation_error: null,
    },
    { merge: true },
  );

  await newBatch.commit();
  invalidateCtx(deviceId);

  const freshSnap = await actionsCol(deviceId)
    .where('status', '==', 'active')
    .limit(10)
    .get();
  return freshSnap.docs
    .map(mapDoc)
    .sort((a, b) => getMillis(a.generated_at) - getMillis(b.generated_at));
}

function queueActionBatchGeneration(
  deviceId,
  { generationKind = 'pattern', completedTotalAtGeneration = null } = {},
) {
  if (_actionGenMap.has(deviceId)) {
    return _actionGenMap.get(deviceId);
  }

  const task = (async () => {
    await fastingDoc(deviceId).set(
      {
        action_generation_status: 'queued',
        action_generation_requested_at:
          admin.firestore.FieldValue.serverTimestamp(),
        action_generation_error: null,
      },
      { merge: true },
    );

    try {
      await fastingDoc(deviceId).set(
        {
          action_generation_status: 'running',
          action_generation_started_at:
            admin.firestore.FieldValue.serverTimestamp(),
          action_generation_error: null,
        },
        { merge: true },
      );

      return await generateActionBatch(deviceId, {
        generationKind,
        completedTotalAtGeneration,
      });
    } catch (e) {
      await fastingDoc(deviceId).set(
        {
          action_generation_status: 'error',
          action_generation_finished_at:
            admin.firestore.FieldValue.serverTimestamp(),
          action_generation_error: String(e?.message || 'generation_failed')
            .slice(0, 180),
        },
        { merge: true },
      );
      throw e;
    } finally {
      _actionGenMap.delete(deviceId);
    }
  })();

  _actionGenMap.set(deviceId, task);
  return task;
}

async function buildActionsPayload(deviceId, { allowGeneration = true } = {}) {
  let fSnap = await fastingDoc(deviceId).get();
  if (!fSnap.exists) {
    return { setup_completed: false };
  }

  let data = fSnap.data() || {};
  const totalCompleted = data.total_sessions_completed || 0;
  const completedSinceBatch = getCompletedSinceActionBatch(data);
  const cycleDue = isActionBatchDue(data);
  let pendingGeneration = isActionGenerationPending(data);

  if (
    allowGeneration
    && cycleDue
    && (!pendingGeneration || isActionGenerationStale(data) || !_actionGenMap.has(deviceId))
  ) {
    pendingGeneration = true;
    queueActionBatchGeneration(deviceId, {
      generationKind: 'pattern',
      completedTotalAtGeneration: totalCompleted,
    }).catch(e => {
      console.error('[fasting] actions cycle queue:', e);
    });
  }

  const { currentStage, elapsedHours } = await getCurrentFastingStage(
    deviceId,
    data,
  );

  const [activeSnap, recentActionSnap] = await Promise.all([
    actionsCol(deviceId).where('status', '==', 'active').limit(10).get(),
    actionsCol(deviceId).orderBy('generated_at', 'desc').limit(24).get(),
  ]);

  const rawActions = activeSnap.docs
    .map(mapDoc)
    .sort((a, b) => getMillis(a.generated_at) - getMillis(b.generated_at));
  const latestRawBatchKey = rawActions.find(a => a.batch_key)?.batch_key || null;
  const hasFreshBatch =
    latestRawBatchKey
    && data.last_action_batch_key
    && latestRawBatchKey !== data.last_action_batch_key;
  if (hasFreshBatch) {
    pendingGeneration = false;
  }
  const hideActivePack = cycleDue && pendingGeneration && !hasFreshBatch;
  const actions = hideActivePack ? [] : rawActions;
  const recent = recentActionSnap.docs.map(mapDoc);
  const currentBatchKey =
    latestRawBatchKey ||
    data.last_action_batch_key ||
    recent.find(a => a.batch_key && a.status !== 'archived')?.batch_key ||
    null;

  const completed = recent
    .filter(
      a =>
        ['completed', 'skipped'].includes(a.status)
        && currentBatchKey
        && a.batch_key === currentBatchKey,
    )
    .sort(
      (a, b) =>
        getMillis(a.completed_at || a.skipped_at || a.generated_at)
        - getMillis(b.completed_at || b.skipped_at || b.generated_at),
    );

  const batchKind = data.last_action_batch_kind || 'setup';
  const progressToNextBatch = Math.min(
    getCompletedSinceActionBatch(data),
    ACTION_BATCH_SIZE,
  );
  const generationState = pendingGeneration
    ? (_actionGenMap.has(deviceId) ? 'running' : 'queued')
    : data.action_generation_status || 'idle';

  return {
    setup_completed: true,
    actions: actions.slice(0, ACTION_BATCH_SIZE).map(formatAction),
    completed: completed.map(formatAction),
    active_session_id: data.active_session_id || null,
    ready_for_upgrade: data.ready_for_upgrade || false,
    current_batch_key: currentBatchKey,
    current_stage: currentStage
      ? { id: currentStage.id, label: currentStage.label }
      : null,
    elapsed_hours: elapsedHours,
    generated_at: (rawActions[0] ? toIso(rawActions[0].generated_at) : null)
      || toIso(data.last_action_generated_at),
    batch_kind: batchKind,
    progress_to_next_batch: progressToNextBatch,
    cycle_size: ACTION_BATCH_SIZE,
    completed_since_batch: getCompletedSinceActionBatch(data),
    pending_generation: pendingGeneration,
    generation_state: generationState,
    generation_started_at: toIso(data.action_generation_started_at),
    generation_requested_at: toIso(data.action_generation_requested_at),
    plan_basis:
      batchKind === 'setup'
        ? 'Starter actions from your setup.'
        : `Built from your latest ${ACTION_BATCH_SIZE} completed fasts and the last ${ACTION_LOOKBACK_DAYS} days.`,
    generation_note: cycleDue
      ? `You unlocked a new pack. We are reading your latest ${ACTION_BATCH_SIZE} completed fasts and your last ${ACTION_LOOKBACK_DAYS} days now.`
      : null,
  };
}

// ================================================================
// GET /actions -- setup batch, then only every 3 completed fasts
// ================================================================
router.get('/_legacy/actions', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const payload = await buildActionsPayload(deviceId, {
      allowGeneration: true,
    });
    return res.json(payload);
  } catch (e) {
    console.error('[fasting] actions:', e);
    return res.status(500).json({ error: 'Failed' });
  }
});

// ================================================================
// POST /actions/refresh -- reload only, no forced generation
// ================================================================
router.post('/_legacy/actions/refresh', async (req, res) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const payload = await buildActionsPayload(deviceId, {
      allowGeneration: true,
    });
    return res.json({ success: true, ...payload });
  } catch (e) {
    console.error('[fasting] actions/refresh:', e);
    return res.status(500).json({ error: 'Failed' });
  }
});

// ================================================================
// POST /action/:id/complete
// ================================================================
router.post('/_legacy/action/:id/complete', async (req, res) => {
  try {
    const { deviceId } = req.body;
    const { id }       = req.params;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    await actionsCol(deviceId).doc(id).update({
      status:       'completed',
      completed_at: admin.firestore.FieldValue.serverTimestamp(),
    });
    return res.json({ success: true });
  } catch (e) {
    console.error('[fasting] action/complete:', e);
    return res.status(500).json({ error: 'Failed' });
  }
});

// ================================================================
// POST /action/:id/skip
// ================================================================
router.post('/_legacy/action/:id/skip', async (req, res) => {
  try {
    const { deviceId } = req.body;
    const { id }       = req.params;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    await actionsCol(deviceId).doc(id).update({
      status:    'skipped',
      skipped_at:admin.firestore.FieldValue.serverTimestamp(),
    });
    return res.json({ success: true });
  } catch (e) {
    console.error('[fasting] action/skip:', e);
    return res.status(500).json({ error: 'Failed' });
  }
});

// ================================================================
// POST /chat
// ================================================================
router.post('/chat', async (req, res) => {
  try {
    const { deviceId, message, proactive_context } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    if (!message?.trim()) return res.status(400).json({ error: 'message required' });
    if (!checkChatRate(deviceId)) return res.status(429).json({ error: 'Rate limit' });

    const context = await getCachedContext(deviceId);

    const threadNotes = {
      fast_started:       'User just started their fast. Acknowledge briefly, preview first 8h.',
      halfway_mark:       'User is halfway through their fast. Validate progress, name current stage.',
      almost_there:       'User is 90min from goal. Strong motivational moment -- be specific.',
      goal_reached:       'Fast complete. Celebrate once, pivot immediately to eating window strategy.',
      new_record:         'User set their longest fast ever. Name the exact record. Explain what it means.',
      streak_milestone:   'User hit a streak milestone. Name the number, explain the biological compounding.',
      behind_schedule:    'User has not fasted today and window is closing. Non-judgmental nudge.',
      first_meal_reminder:'Eating window just opened. Optimal break-fast strategy.',
      window_closing:     'Eating window closes in 60min. Last call to eat if they have not.',
      hydration_warning:  'Water critically low during active fast. This is priority 1.',
      stage_transition:   'User just entered a new metabolic stage. Explain what is happening now.',
      hunger_support:     'User reporting hunger. Days 1-14 = ghrelin science. Days 14+ = check water first.',
      protocol_upgrade:   'User has been 14+ days consistent. Suggest stepping up their protocol.',
      broken_fast:        'User broke their fast early. Non-judgmental. Normalize. Re-set tomorrow.',
    };

    const systemPrompt = [
      'You are the Pulse Fasting Coach — a precision metabolic health coach inside a science-backed wellness app.',
      '',
      'SCIENCE BASE (cite only when directly relevant, never gratuitously):',
      '- Metabolic switching: Mattson et al. 2018 (Cell Metabolism) — 12-16h fasting switches fuel from glucose to fat/ketones.',
      '- Autophagy: Ohsumi 2016 Nobel Prize — fasting triggers cellular self-cleaning via LC3-II pathway.',
      '- Circadian eating: Panda et al. 2019 (Cell Metabolism) — time-restricted eating aligned to light cycle improves metabolic markers.',
      '- Ghrelin adaptation: Frecka & Mattes 2008 — hunger hormone adapts to meal schedule within 14-21 days.',
      '- Sleep-hunger link: Spiegel et al. 2004 — one bad night raises ghrelin ~15%, amplifying perceived hunger.',
      '',
      'USER CONTEXT is injected above. You have their EXACT numbers — use them. Never invent data.',
      '',
      'RESPONSE RULES:',
      '- Max 140 words. Tight, precise, no filler.',
      '- Sound like a premium coach: sharp, calm, human. Never robotic.',
      '- Reference SPECIFIC numbers from context: exact hours elapsed, exact streak, exact water %, exact sleep score.',
      '- If fasting is active: always acknowledge current stage and how long left to goal.',
      '- If they\'re hungry: name it as biology first (ghrelin/glycogen depletion), then give one tactical fix.',
      '- If water < 40% of goal during active fast: lead with hydration — dehydration mimics hunger.',
      '- If sleep score < 65 last night: acknowledge "ghrelin is elevated today" — normalize amplified hunger.',
      '- If streak > 0: mention it once in a way that reinforces identity ("Day X of your protocol").',
      '- Never open with: "Great", "Absolutely", "Of course", "Happy to help", "Certainly", "Sure", "I".',
      '- No passive voice. Active, direct sentences.',
      '- Answer the actual question in the first sentence whenever possible.',
      '- Use at most 2 short paragraphs. Use bullets only if the user explicitly asks for steps.',
      '- Never congratulate before verifying context shows a completed fast.',
      '',
      'HOUR-BY-HOUR COACHING:',
      '- 0-4h: Insulin still falling. Normal. Body processing last meal.',
      '- 4-8h: Glycogen burning. Hunger is real — this is ghrelin, not true need. Water + salt.',
      '- 8-12h: Hardest window. Liver glycogen 60-80% gone. Ghrelin peaks here. "Name it to tame it."',
      '- 12-14h: Fat oxidation dominant. Ketones 0.3-0.5mM. Norepinephrine up — focus sharpens.',
      '- 14-16h: BDNF elevated. Cognitive peak. Best window for deep work.',
      '- 16-18h: Ketosis entry. mTOR suppressed. Cellular repair beginning.',
      '- 18h+: Autophagy active. Nobel-level biology happening. Every extra minute compounds.',
      '- 24h+: Growth hormone surge 300-500%. Medical supervision recommended.',
      '',
      'GOAL-SPECIFIC COACHING:',
      '- weight_loss: Lead with insulin sensitivity, fat oxidation, caloric timing.',
      '- longevity: Lead with autophagy, mTOR suppression, BDNF.',
      '- mental_clarity: Lead with ketones, BDNF, norepinephrine — cognitive performance angle.',
      '- metabolic_health: Lead with blood glucose, insulin resistance reversal.',
      '- gut_reset: Lead with microbiome rest, migrating motor complex, gut healing.',
      '',
      'SAFETY (non-negotiable):',
      '- Dizziness, chest pain, extreme weakness → break fast immediately. Medical advice if persists.',
      '- 24h+ fasts → always recommend medical supervision.',
      '- Conditions include eating disorder → never mention weight, BMI, or willpower. Frame around energy and cellular health only.',
      '',
      proactive_context
        ? `COACHING THREAD: ${threadNotes[proactive_context] || 'User replying to a coach message. Be responsive and direct.'}`
        : '',
    ].filter(Boolean).join('\n');

    // Recent message history
    const histSnap = await chatsCol(deviceId)
      .orderBy('created_at', 'desc')
      .limit(12)
      .get();
    const history = histSnap.docs
      .map(d => d.data())
      .reverse()
      .filter(m => m.content && m.content.trim())
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

    const messages = [
      { role: 'system', content: `CONTEXT:\n${context}\n\n${systemPrompt}` },
      ...history.slice(-10),
      { role: 'user', content: message },
    ];

    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1',
      max_tokens: 220,
      temperature: 0.35,
      messages,
    });

    const reply = completion.choices[0].message.content.trim();

    const batch = db().batch();
    const userMsgRef = chatsCol(deviceId).doc();
    batch.set(userMsgRef, {
      role: 'user', content: message,
      is_proactive: false,
      proactive_context: proactive_context || null,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });
    const aiMsgRef = chatsCol(deviceId).doc();
    batch.set(aiMsgRef, {
      role: 'assistant', content: reply,
      is_proactive: false,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });
    await batch.commit();
    invalidateCtx(deviceId);

    return res.json({ reply, message_id: aiMsgRef.id });
  } catch (e) {
    console.error('[fasting] chat:', e);
    return res.status(500).json({ error: 'Chat failed' });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /chat/stream — SSE streaming
// ─────────────────────────────────────────────────────────────────
const { mountChatStream: _mountChatStreamFasting } = require('./lib/chat-stream');
_mountChatStreamFasting(router, {
  agentName: 'fasting',
  openai, admin, chatsCol,
  rateLimitCheck: checkChatRate,
  model: 'gpt-4.1', maxTokens: 220, temperature: 0.35,
  buildPrompt: async (deviceId, message, { proactive_context } = {}) => {
    const context = await getCachedContext(deviceId);
    let systemPrompt = `CONTEXT:\n${context}\n\nYou are the Pulse Fasting Coach. Tight, precise, max 140 words. Reference exact hours/streak/water/sleep numbers. Sound human, never robotic.`;
    if (proactive_context) {
      systemPrompt += `\n\n[THREAD CONTEXT] User is following up on a coach message of type: ${proactive_context}. Acknowledge briefly then focus on what they asked.`;
    }
    const histSnap = await chatsCol(deviceId).orderBy('created_at', 'desc').limit(12).get();
    const history = histSnap.docs
      .map(d => d.data()).reverse()
      .filter(m => (m.role === 'assistant' || m.role === 'user') && m.content && m.content.trim())
      .map(m => ({ role: m.role, content: m.content }))
      .slice(-10);
    return { systemPrompt, history };
  },
});

// ================================================================
// GET /chat/messages
// ================================================================
router.get('/chat/messages', async (req, res) => {
  try {
    const { deviceId, limit: lim = 40, before } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    let query = chatsCol(deviceId).orderBy('created_at', 'desc').limit(parseInt(lim, 10) || 40);
    if (before) {
      const pivot = await chatsCol(deviceId).doc(before).get();
      if (pivot.exists) query = query.startAfter(pivot);
    }

    const snap     = await query.get();
    const messages = snap.docs.map(d => {
      const m = d.data();
      return {
        id:             d.id,
        role:           m.role,
        content:        m.content,
        is_proactive:   m.is_proactive || false,
        proactive_type: m.proactive_type || null,
        created_at:     toIso(m.created_at),
        is_first_message: m.is_first_message || false,
      };
    }).reverse();

    const oldest  = snap.docs[snap.docs.length - 1];
    const hasMore = snap.docs.length === (parseInt(lim, 10) || 40);

    return res.json({ messages, has_more: hasMore, oldest_id: oldest?.id || null });
  } catch (e) {
    console.error('[fasting] chat/messages:', e);
    return res.status(500).json({ error: 'Failed' });
  }
});

// ================================================================
// GET /chat/unread
// ================================================================
router.get('/chat/unread', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    // Stored counter — no compound query, no composite index needed
    const fSnap = await fastingDoc(deviceId).get();
    const unread = fSnap.exists ? (fSnap.data()?.unread_proactive_count || 0) : 0;
    return res.json({ unread });
  } catch (e) {
    console.error('[fasting] chat/unread:', e);
    return res.json({ unread: 0 });
  }
});

// ================================================================
// POST /chat/read
// ================================================================
router.post('/chat/read', async (req, res) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    await fastingDoc(deviceId).update({
      last_chat_read_at:      admin.firestore.FieldValue.serverTimestamp(),
      unread_proactive_count: 0,
    });
    return res.json({ success: true });
  } catch (e) {
    console.error('[fasting] chat/read:', e);
    return res.status(500).json({ error: 'Failed' });
  }
});

// ================================================================
// PROACTIVE CRON -- every hour
// Fires personalized messages based on fast state + thresholds
// ================================================================
cron.schedule('0 * * * *', async () => {
  try {
    const usersSnap = await db().collection('wellness_users').limit(300).get();

    for (const userSnap of usersSnap.docs) {
      const deviceId = userSnap.id;
      try {
        const fSnap = await fastingDoc(deviceId).get();
        if (!fSnap.exists || !fSnap.data()?.setup_completed) continue;

        const data  = fSnap.data() || {};
        const setup = data.setup || {};

        const today     = dateStr();
        const hour      = new Date().getHours();
        const minute    = new Date().getMinutes();
        const nowMin    = hour * 60 + minute;
        const storedDate = data.last_proactive_date || '';
        const storedCount= storedDate === today ? (data.proactive_count_today || 0) : 0;

        if (storedCount >= MAX_PROACTIVES_PER_DAY) continue;

        const targetHours = setup.target_fast_hours || 16;
        const { windowStart, windowEnd } = calcEatingWindow(setup);

        // Recent messages — single orderBy only, filter in-memory (no composite index)
        const recentSnap = await chatsCol(deviceId)
          .orderBy('created_at', 'desc')
          .limit(20)
          .get();
        const recentMessages = recentSnap.docs.map(d => d.data())
          .filter(m => m.is_proactive);

        // Get active session
        const activeId = data.active_session_id;
        let elapsedHours = 0;
        let sessData     = null;
        if (activeId) {
          const sessSnap = await sessionsCol(deviceId).doc(activeId).get();
          if (sessSnap.exists) {
            sessData     = sessSnap.data();
            elapsedHours = getElapsedHours(sessData.started_at);
          }
        }

        // Today's completed fast
        const todaySessionsSnap = await sessionsCol(deviceId)
          .where('date', '==', today)
          .get();
        const todaySessions    = todaySessionsSnap.docs.map(d => d.data());
        const todayCompleted   = todaySessions.some(s => s.completed);

        // All sessions for streak
        const allSessSnap = await sessionsCol(deviceId).orderBy('started_at', 'desc').limit(100).get();
        const allSessions = allSessSnap.docs.map(mapDoc);
        const currentStreak = computeStreak(allSessions);

        // Hydration status
        let waterMl = 0;
        let fastingWaterGoal = 1800;
        try {
          const wRef = await userDoc(deviceId).collection('agents').doc('water').get();
          if (wRef.exists) {
            const wData = wRef.data() || {};
            fastingWaterGoal = (wData.setup?.daily_goal_ml || 2500) + 300;
          }
          const todayStart = new Date();
          todayStart.setHours(0, 0, 0, 0);
          const wLogsSnap = await userDoc(deviceId).collection('agents').doc('water')
            .collection('water_logs').where('logged_at', '>=', todayStart).get();
          waterMl = wLogsSnap.docs.reduce((sum, d) => sum + (d.data().effective_ml || 0), 0);
        } catch { /* non-fatal */ }

        let proactiveType = null;
        let content       = null;
        const updates     = {};

        const alreadyFiredToday = (type) =>
          recentMessages.some(m => {
            const mDate = m.created_at?.toDate ? dateStr(m.created_at.toDate()) : '';
            return mDate === today && m.proactive_type === type;
          });

        const minsSinceLastProactive = (() => {
          const last = recentMessages[0];
          if (!last?.created_at) return 9999;
          return (Date.now() - getMillis(last.created_at)) / 60000;
        })();
        const hasUnreadProactive = (data.unread_proactive_count || 0) > 0;

        if (minsSinceLastProactive < 90) continue; // min 90min between messages
        if (hasUnreadProactive && minsSinceLastProactive < 360) continue;

        // 1. HALFWAY MARK
        if (activeId && elapsedHours >= targetHours / 2 && elapsedHours < targetHours / 2 + 0.6 && !alreadyFiredToday('halfway_mark')) {
          const stage = getStage(elapsedHours);
          proactiveType = 'halfway_mark';
          content = `Halfway. ${round(elapsedHours, 1)}h done, ${round(targetHours - elapsedHours, 1)}h left. Entering ${stage.label.toLowerCase()} -- ${
            stage.id === 'fat_burning' ? 'glycogen is nearly gone, fat burning starting' :
            stage.id === 'glycogen'    ? 'still burning glycogen, hardest window ahead' :
            'metabolic switch approaching'
          }.`;
        }

        // 2. ALMOST THERE (90min before goal)
        else if (activeId && (targetHours - elapsedHours) <= 1.6 && (targetHours - elapsedHours) > 0.8 && !alreadyFiredToday('almost_there')) {
          proactiveType = 'almost_there';
          content = `${round(targetHours - elapsedHours, 1)}h left. ${round(elapsedHours, 1)}h already in. Ketones rising -- this is the window you trained for. Finish it.`;
        }

        // 3. GOAL REACHED
        else if (activeId && elapsedHours >= targetHours && !alreadyFiredToday('goal_reached') && !todayCompleted) {
          proactiveType = 'goal_reached';
          content = `${targetHours}h done. Metabolic switch complete${elapsedHours >= 18 ? ', autophagy active' : ''}. Break your fast with protein + fat first -- not carbs alone. Eating window closes at ${minsToLabel(windowEnd)}.`;
          updates.last_goal_reached_date = today;
        }

        // 4. HYDRATION WARNING (critical)
        else if (activeId && waterMl < fastingWaterGoal * 0.4 && hour >= 9 && !alreadyFiredToday('hydration_warning')) {
          proactiveType = 'hydration_warning';
          content = `${fastingWaterGoal - waterMl}ml behind on water during your fast. Dehydration mimics hunger -- this is why you may feel off right now. Drink 500ml, then reassess.`;
        }

        // 5. STAGE TRANSITION (entering fat burning)
        else if (activeId && elapsedHours >= 12 && elapsedHours < 12.6 && !alreadyFiredToday('stage_transition')) {
          proactiveType = 'stage_transition';
          content = `12 hours. Glycogen is gone -- your body just switched to fat as primary fuel. Ketones beginning to rise. The next 4 hours determine how deep this fast goes.`;
        }

        // 6. STREAK MILESTONE
        else if (!proactiveType && STREAK_MILESTONES.includes(currentStreak) && (data.last_milestone_streak || 0) !== currentStreak && todayCompleted) {
          proactiveType = 'streak_milestone';
          content = currentStreak === 7
            ? `7-day streak. Your ghrelin is actively retraining right now -- most people report hunger dropping noticeably in the next 7-10 days.`
            : currentStreak === 14
            ? `14-day streak. Ghrelin fully adapted. Insulin sensitivity has measurably improved over these 2 weeks.`
            : currentStreak === 30
            ? `30-day streak. This is not a diet -- it is a metabolic identity. Autophagy, insulin sensitivity, and BDNF have all shifted in your favor.`
            : `${currentStreak}-day streak. Consistency is the variable that separates real results from attempts.`;
          updates.last_milestone_streak = currentStreak;
        }

        // 7. BEHIND SCHEDULE (no fast, window closing)
        else if (!activeId && !todayCompleted && hour >= 21 && !alreadyFiredToday('behind_schedule')) {
          proactiveType = 'behind_schedule';
          content = `No fast logged today. Still worth starting -- even 12h overnight counts. Start now and your eating window opens at ${minsToLabel(windowStart)} tomorrow.`;
        }

        // 8. FIRST MEAL REMINDER (eating window just opened)
        else if (!activeId && todayCompleted && nowMin >= windowStart && nowMin < windowStart + 35 && !alreadyFiredToday('first_meal_reminder')) {
          proactiveType = 'first_meal_reminder';
          content = `Eating window open. Break your fast with protein and healthy fat first -- eggs, nuts, avocado. This blunts the insulin spike and keeps you fuller. Eating window runs until ${minsToLabel(windowEnd)}.`;
        }

        // 9. PROTOCOL UPGRADE
        else if (!proactiveType && data.ready_for_upgrade && !alreadyFiredToday('protocol_upgrade')) {
          const nextProtocol = setup.protocol === '16:8' ? '18:6' : setup.protocol === '14:10' ? '16:8' : null;
          if (nextProtocol) {
            proactiveType = 'protocol_upgrade';
            content = `14 days consistent at ${setup.protocol} with ${Math.round(computeCompletionRate(allSessions, 14) * 100)}% completion. Your metabolic machinery has adapted. Consider stepping to ${nextProtocol} -- one additional hour in the fat-burning zone daily.`;
          }
        }

        if (!proactiveType || !content) continue;

        // Local notifications already cover these moments better than chat cards.
        if (['halfway_mark', 'almost_there', 'goal_reached', 'first_meal_reminder'].includes(proactiveType)) continue;

        // Dedup check
        const alreadyExists = recentMessages.some(m => {
          const mDate = m.created_at?.toDate ? dateStr(m.created_at.toDate()) : '';
          return mDate === today && m.proactive_type === proactiveType;
        });
        if (alreadyExists) continue;

        const chatRef = chatsCol(deviceId).doc();
        await db().runTransaction(async (tx) => {
          tx.set(chatRef, {
            role:          'assistant',
            content,
            is_proactive:  true,
            proactive_type:proactiveType,
            is_unread:     true,
            created_at:    admin.firestore.FieldValue.serverTimestamp(),
          });
          tx.update(fastingDoc(deviceId), {
            last_proactive_date:    today,
            proactive_count_today:  storedCount + 1,
            unread_proactive_count: admin.firestore.FieldValue.increment(1),
            ...updates,
          });
        });

        invalidateCtx(deviceId);
      } catch (e) {
        console.error(`[fasting] cron error for ${deviceId}:`, e);
      }
    }
  } catch (e) {
    console.error('[fasting] cron fatal:', e);
  }
});

console.log('[fasting] agent loaded -- metabolic stages, cross-agent synergy, proactive cron active');

module.exports = router;
