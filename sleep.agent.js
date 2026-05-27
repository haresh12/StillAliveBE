'use strict';

// ═══════════════════════════════════════════════════════════════
// SLEEP AGENT — Pulse Backend
// All routes, AI logic, action generation, chat, proactive cron.
// Mounted at /api/sleep in server.js
//
// Science basis:
//   • CBT-I (Cognitive Behavioral Therapy for Insomnia) — gold standard
//   • Two-process model: Process S (sleep pressure) + Process C (circadian)
//   • Sleep efficiency = time asleep / time in bed × 100 (target ≥ 85%)
//   • Sleep debt = cumulative deficit from target (7-day rolling)
//   • Consistency score = variance in bedtime + wake time (most impactful factor)
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { AI } = require('./lib/ai/models');
const router  = express.Router();
const admin   = require('firebase-admin');
const { OpenAI } = require('openai');
const cron    = require('node-cron');
// ABSOLUTE LAW: single agents never read sibling-agent data via fetchAgentSnapshot.
const { computeSleepScore: _computeSleepScore } = require('./lib/agent-scores');
const { resolveLanguage, appendLanguageInstruction } = require('./lib/i18n-prompt');
const { withCron, shouldRunCron } = require('./lib/cron-helper');
const { getUserNotifContext } = require('./lib/cron-user-context');
const { resolveAnchor } = require('./lib/user-anchor');
const { assertLoggableDate, sendLogGuardError } = require('./lib/log-guard');
const sleepAnalytics = require('./lib/sleep-analytics');
const sleepDescribe  = require('./lib/sleep-describe');

const openai  = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const db      = () => admin.firestore();

// ─── buildContext 5-min cache ─────────────────────────────────
// Cuts chat latency from ~2-3s to ~0.8s for returning users.
// Invalidated on every log submission so data stays fresh.
const _ctxCache = new Map(); // deviceId → { context: string, builtAt: number }
const CTX_TTL   = 5 * 60 * 1000;

async function getCachedContext(deviceId) {
  const cached = _ctxCache.get(deviceId);
  if (cached && Date.now() - cached.builtAt < CTX_TTL) return cached.context;
  const context = await buildContext(deviceId);
  _ctxCache.set(deviceId, { context, builtAt: Date.now() });
  return context;
}

function invalidateContextCache(deviceId) {
  _ctxCache.delete(deviceId);
}

// ─── Firestore path helpers ───────────────────────────────────
const userDoc     = (id) => db().collection('wellness_users').doc(id);
const sleepDoc    = (id) => userDoc(id).collection('agents').doc('sleep');
const logsCol     = (id) => sleepDoc(id).collection('sleep_logs');
const actionsCol  = (id) => sleepDoc(id).collection('sleep_actions');
const chatsCol    = (id) => sleepDoc(id).collection('sleep_chats');

// ════════════════════════════════════════════════════════════════
// ACTIONS v2 — shared engine (mounts BEFORE legacy routes; first-match wins)
// ════════════════════════════════════════════════════════════════
const { mountActionRoutes, gradeActions: _gradeActionsShared } = require('./lib/actions-engine');
const { computeSleepCandidates, sleepGraders } = require('./lib/candidates/sleep');
const { assertNoCrossAgent } = require('./lib/sandbox');
assertNoCrossAgent('sleep', computeSleepCandidates);
const _v2Hooks = mountActionRoutes(router, {
  agentName: 'sleep',
  agentDocRef: sleepDoc,
  actionsCol, logsCol,
  computeCandidates: computeSleepCandidates,
  graders: sleepGraders,
  openai, admin, db,
});
function _onSleepLog(deviceId) {
  sleepDoc(deviceId).update({
    log_count_since_last_batch: admin.firestore.FieldValue.increment(1),
  }).catch(() => {});
  _v2Hooks.queueGeneration(deviceId);
  _gradeActionsShared({
    agentName: 'sleep', deviceId, actionsCol, logsCol,
    graders: sleepGraders, admin, db,
  }).catch(() => {});
  try { require('./wellness.cross').invalidateWellnessCache?.(deviceId); } catch {}
}
// ════════════════════════════════════════════════════════════════

// ─── Helpers ──────────────────────────────────────────────────
const dateStr = (d = new Date()) => {
  const y  = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${dd}`;
};

const mapSnapDoc = (doc) => ({ id: doc.id, ...doc.data() });

const getTimestampMillis = (value) => {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
};

const toIsoString = (value) => {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const sortByTimestampField = (items, field, direction = 'desc') =>
  [...items].sort((a, b) => {
    const delta = getTimestampMillis(a[field]) - getTimestampMillis(b[field]);
    return direction === 'asc' ? delta : -delta;
  });

// ─── Sleep math helpers ───────────────────────────────────────

/**
 * Parse "HH:MM" or "H:MM" → total minutes from midnight.
 */
const timeToMins = (t = '00:00') => {
  const [h, m] = String(t).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

/**
 * Minutes from midnight → "H:MM AM/PM" display string.
 */
const minsToDisplay = (mins) => {
  const h24  = Math.floor(((mins % 1440) + 1440) % 1440 / 60);
  const m    = Math.floor(((mins % 1440) + 1440) % 1440 % 60);
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  const h12  = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
};

/**
 * Calculate time in bed (hours), accounting for crossing midnight.
 * bedtime = "23:00", wake_time = "07:00" → 8.0 hours
 */
const calcTimeInBed = (bedtime, wake_time) => {
  let bedMins  = timeToMins(bedtime);
  let wakeMins = timeToMins(wake_time);
  // If wake < bed, they slept across midnight
  if (wakeMins <= bedMins) wakeMins += 24 * 60;
  return (wakeMins - bedMins) / 60;
};

/**
 * Calculate total sleep hours:
 *   time_in_bed - latency (hours) - (wakings × 20min estimate)
 */
const calcTotalSleep = (timeInBed, latencyMins, nightWakings) => {
  const latencyHrs = (latencyMins || 0) / 60;
  const wakingHrs  = (nightWakings || 0) * (20 / 60); // 20 min per waking estimate
  return Math.max(0, timeInBed - latencyHrs - wakingHrs);
};

/**
 * Sleep efficiency = (total sleep / time in bed) × 100
 * Target: ≥ 85% (CBT-I standard)
 */
const calcEfficiency = (totalSleep, timeInBed) => {
  if (!timeInBed || timeInBed === 0) return 0;
  return Math.round((totalSleep / timeInBed) * 100);
};

/**
 * 7-day rolling sleep debt (hours below target).
 * Positive = you owe sleep. Negative = you're banked.
 */
const calcSleepDebt = (logs, targetHours) => {
  const last7 = logs.slice(-7);
  if (!last7.length) return 0;
  const total = last7.reduce((s, l) => s + (l.total_sleep_hours || 0), 0);
  const expectedTotal = targetHours * last7.length;
  return parseFloat((expectedTotal - total).toFixed(1));
};

/**
 * Consistency score 0–100 (higher = better).
 * Based on standard deviation of bedtime minutes across last 7 logs.
 * <30min variance = excellent. >90min variance = poor.
 */
const calcConsistency = (logs) => {
  const last7 = logs.slice(-7).filter(l => l.bedtime);
  if (last7.length < 2) return null;
  const bedMins = last7.map(l => {
    let m = timeToMins(l.bedtime);
    // Normalise: if before 6am treat as "past midnight" (add 1440)
    if (m < 360) m += 1440;
    return m;
  });
  const avg = bedMins.reduce((s, v) => s + v, 0) / bedMins.length;
  const variance = bedMins.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / bedMins.length;
  const stdDev = Math.sqrt(variance); // in minutes
  // Map stdDev → 0-100 score (0 min = 100, 120 min = 0)
  const score = Math.max(0, Math.round(100 - (stdDev / 120) * 100));
  return { score, std_dev_mins: Math.round(stdDev) };
};

// ─── Sleep Score (0-100 synthesis) ───────────────────────────
// Weights: efficiency 35% + consistency 30% + duration 25% + debt 10%
// Research: Rise Science debt model + CBT-I efficiency threshold
function computeSleepScore(stats) {
  const { avg_efficiency, consistency, avg_duration, target_hours, sleep_debt } = stats;
  if (!avg_efficiency || !avg_duration) return null;

  const effScore  = Math.min(100, (avg_efficiency / 85) * 100);           // 85% = full marks
  const consScore = (consistency?.score) ?? 50;                            // 0-100 already
  const durScore  = Math.min(100, (avg_duration / (target_hours || 7.5)) * 100);
  const debtScore = Math.max(0, 100 - Math.max(0, (sleep_debt || 0)) * 15); // -15 per hour

  const score = Math.round(
    effScore  * 0.35 +
    consScore * 0.30 +
    durScore  * 0.25 +
    debtScore * 0.10
  );

  const label = score >= 90 ? 'Excellent' : score >= 75 ? 'Good' : score >= 60 ? 'Fair' : 'Needs work';
  return {
    score,
    label,
    components: {
      efficiency:  Math.round(effScore),
      consistency: Math.round(consScore),
      duration:    Math.round(durScore),
      debt:        Math.round(debtScore),
    },
  };
}

async function refreshSleepScore(deviceId) {
  try {
    const [logsSnap, snap] = await Promise.all([
      logsCol(deviceId).orderBy('logged_at', 'desc').limit(14).get(),
      sleepDoc(deviceId).get(),
    ]);
    const setup = snap.data() || {};
    const logs  = logsSnap.docs.map(d => d.data());
    const daysLogged = new Set(logs.map(l => l.date_str)).size;
    const recent = logs.slice(0, 7);
    if (!recent.length) return;

    const avgEff     = recent.reduce((s, l) => s + (l.sleep_efficiency  || 0), 0) / recent.length;
    const avgDur     = recent.reduce((s, l) => s + (l.total_sleep_hours || 0), 0) / recent.length;
    const avgQuality = recent.reduce((s, l) => s + (l.sleep_quality     || 3), 0) / recent.length;
    const avgEnergy  = recent.reduce((s, l) => s + (l.morning_energy    || 3), 0) / recent.length;
    const avgLatency = recent.reduce((s, l) => s + (l.sleep_latency     || 15), 0) / recent.length;
    const targetH    = setup.target_hours || 7.5;

    // Bedtime consistency → std dev of bedtime minutes (handle post-midnight)
    const bedMins = recent.map(l => {
      const [h, m] = (l.bedtime || '23:00').split(':').map(Number);
      return (h < 12 ? h + 24 : h) * 60 + (m || 0);
    });
    const bedAvg = bedMins.reduce((s, x) => s + x, 0) / bedMins.length;
    const bedStd = Math.sqrt(bedMins.reduce((s, x) => s + (x - bedAvg) ** 2, 0) / bedMins.length);
    const consistencyScore = Math.max(0, Math.min(100, 100 - bedStd * 2));

    const debtH = recent.reduce((s, l) => s + Math.max(0, targetH - (l.total_sleep_hours || 0)), 0) / recent.length;

    const result = _computeSleepScore({
      avg_efficiency:    avgEff,
      avg_duration:      avgDur,
      avg_quality:       avgQuality,
      avg_energy:        avgEnergy,
      avg_latency:       avgLatency,
      consistency_score: consistencyScore,
      target_hours:      targetH,
      sleep_debt:        debtH,
      days_logged:       daysLogged,
    });
    if (!result) return;

    await sleepDoc(deviceId).update({
      current_score:      result.score,
      score_label:        result.label,
      score_components:   result.components,
      score_updated_at:   admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    log.error('[sleep] refreshScore:', err.message);
  }
}

// ─── Tonight's recommendation ─────────────────────────────────
// Uses CBT-I logic: if efficiency < 80% → sleep restriction (go later)
// If debt ≥ 2h → go 30min earlier. Otherwise → stick to target.
function buildTonightRecommendation(setup, stats) {
  const targetBed  = setup.target_bedtime  || '23:00';
  const targetWake = setup.target_wake_time || '07:00';

  const addMins = (timeStr, mins) => {
    let total = timeToMins(timeStr) + mins;
    total = ((total % 1440) + 1440) % 1440;
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  };

  let bedtime = targetBed;
  let note    = 'Stick to your target sleep window tonight.';

  if (stats.avg_efficiency !== undefined && stats.avg_efficiency < 80) {
    bedtime = addMins(targetBed, 30);
    note    = `Efficiency is ${stats.avg_efficiency}% — going to bed 30min later builds sleep pressure (CBT-I sleep restriction).`;
  } else if ((stats.sleep_debt || 0) >= 2) {
    bedtime = addMins(targetBed, -30);
    note    = `You have ${stats.sleep_debt}h of sleep debt — going to bed 30min earlier to recover.`;
  }

  return { bedtime, wake: targetWake, note };
}

// ═══════════════════════════════════════════════════════════════
// POST /setup
// Saves all setup answers, generates first 3 actions,
// writes opening chat message.
// ═══════════════════════════════════════════════════════════════
router.post('/setup', async (req, res) => {
  try {
    const {
      deviceId,
      primary_problem,
      target_bedtime,
      target_wake_time,
      target_hours,
      disruptors,
      past_attempts,
      chronotype,
      discussion_topics,
      daily_reminder_time,
    } = req.body;

    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const targetHours = parseFloat(target_hours) || 7.5;

    const setupData = {
      setup_completed:            true,
      primary_problem:            primary_problem   || '',
      target_bedtime:             target_bedtime    || '23:00',
      target_wake_time:           target_wake_time  || '07:00',
      target_hours:               targetHours,
      disruptors:                 disruptors        || [],
      past_attempts:              past_attempts     || [],
      chronotype:                 chronotype        || 'in_between',
      discussion_topics:          discussion_topics || [],
      daily_reminder_time:        daily_reminder_time || '21:00',
      created_at:                 admin.firestore.FieldValue.serverTimestamp(),
      log_count:                  0,
      last_action_gen_at_log:     0,
      last_log_date:              null,
      last_proactive_date:        null,
      last_streak_celebrated:     null,
      last_debt_alert_date:       null,
      analysis_cache:             null,
      skip_history:               [],
    };

    await sleepDoc(deviceId).set(setupData, { merge: true });

    // Flag on user doc for cron queries
    await userDoc(deviceId).set(
      {
        sleep_setup_complete: true,
        sleep_setup_at: admin.firestore.FieldValue.serverTimestamp(),
        sleep_reminder_time: daily_reminder_time || '21:00',
      },
      { merge: true }
    );

    const profileSnap = await userDoc(deviceId).get();
    const profile     = profileSnap.exists ? profileSnap.data() : {};

    // Generate first 3 actions from setup data only
    const firstActions = await generateActions({
      profile,
      setup: setupData,
      recentLogs:   [],
      recentChat:   [],
      isFirstGen:   true,
    });

    const today = dateStr();
    const batch = db().batch();
    firstActions.forEach(action => {
      const ref = actionsCol(deviceId).doc();
      batch.set(ref, {
        ...action,
        status:       'active',
        date_str:     today,
        gen_index:    0,
        generated_at: admin.firestore.FieldValue.serverTimestamp(),
        completed_at: null,
      });
    });
    await batch.commit();

    // Opening chat message
    const name       = profile.name || '';
    const openingMsg = buildOpeningMessage(name, primary_problem, disruptors);
    await chatsCol(deviceId).add({
      role:           'assistant',
      content:        openingMsg,
      is_proactive:   false,
      proactive_type: null,
      is_read:        true,
      created_at:     admin.firestore.FieldValue.serverTimestamp(),
    });

    // Queue v2 welcome action batch (shared engine)
    try { _v2Hooks.queueGeneration(deviceId, { generationKind: 'setup' }); } catch {}

    res.json({ success: true, actions: firstActions });
  } catch (err) {
    log.error('[sleep] /setup error:', err);
    res.status(500).json({ error: 'Setup failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /setup-status
// ═══════════════════════════════════════════════════════════════
router.get('/setup-status', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const snap = await sleepDoc(deviceId).get();
    if (!snap.exists) return res.json({ setup_completed: false });

    const data = snap.data();
    res.json({ setup_completed: !!data.setup_completed, setup: data });
  } catch (err) {
    log.error('[sleep] /setup-status error:', err);
    res.status(500).json({ error: 'Status check failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /chat-prompts  — returns 6 prompts personalised from setup + logs
// ═══════════════════════════════════════════════════════════════
router.get('/chat-prompts', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const snap  = await sleepDoc(deviceId).get();
    const setup = snap.exists ? snap.data() : {};
    const problem    = setup.primary_problem || '';
    const chronotype = setup.chronotype || 'in_between';
    const disruptors = Array.isArray(setup.disruptors) ? setup.disruptors : [];
    const targetBed  = setup.target_bedtime  || '23:00';
    const targetHrs  = setup.target_hours    || 7.5;

    const lastSnap = await sleepDoc(deviceId).collection('sleep_logs').orderBy('logged_at', 'desc').limit(1).get();
    const lastLog  = lastSnap.empty ? null : lastSnap.docs[0].data();

    const hour = new Date().getHours();
    const isMorning = hour >= 5 && hour < 12;
    const isEvening = hour >= 20;

    const pool = [];

    if (problem === 'falling_asleep') {
      pool.push({ emoji: '🛏️', text: "I can't fall asleep — what actually works?" });
      pool.push({ emoji: '🌬️', text: 'Give me a wind-down routine for tonight.' });
    } else if (problem === 'staying_asleep') {
      pool.push({ emoji: '😴', text: "I keep waking up at night — why?" });
      pool.push({ emoji: '💡', text: 'What causes middle-of-night wake-ups?' });
    } else if (problem === 'quality') {
      pool.push({ emoji: '📊', text: "My sleep hours are OK but I still feel tired." });
      pool.push({ emoji: '🔬', text: 'What affects deep sleep most?' });
    } else if (problem === 'consistency') {
      pool.push({ emoji: '⏰', text: "My sleep schedule is all over the place." });
      pool.push({ emoji: '📅', text: 'How do I fix an inconsistent sleep schedule?' });
    } else {
      pool.push({ emoji: '😴', text: "Why do I wake up feeling unrefreshed?" });
      pool.push({ emoji: '🌙', text: 'What can I do tonight to sleep better?' });
    }

    if (chronotype === 'early') {
      pool.push({ emoji: '🌅', text: "I'm a morning person — how do I protect my early sleep?" });
    } else if (chronotype === 'late' || chronotype === 'night_owl') {
      pool.push({ emoji: '🦉', text: 'How do night owls shift their sleep earlier?' });
    } else {
      pool.push({ emoji: '⏰', text: `Help me stick to a ${targetBed} bedtime.` });
    }

    if (disruptors.includes('stress')) {
      pool.push({ emoji: '😤', text: "Stress keeps me wired at bedtime. What helps?" });
    } else if (disruptors.includes('phone')) {
      pool.push({ emoji: '📱', text: 'I know I use my phone too late. How bad is it really?' });
    } else if (disruptors.includes('caffeine')) {
      pool.push({ emoji: '☕', text: 'How late is too late for caffeine?' });
    } else {
      pool.push({ emoji: '💭', text: 'What are my biggest sleep saboteurs?' });
    }

    if (isEvening) pool.push({ emoji: '🌙', text: 'What should I do right now to sleep well tonight?' });
    else if (isMorning && lastLog) {
      const hrs = lastLog.actual_hours || 0;
      if (hrs < targetHrs - 0.5) pool.unshift({ emoji: '⚡', text: "I slept short last night — how do I recover?" });
      else pool.push({ emoji: '📊', text: 'How was my sleep quality this week?' });
    }

    pool.push({ emoji: '📊', text: "What does my sleep data show this week?" });
    pool.push({ emoji: '🔄', text: 'How does my sleep connect to my mood and energy?' });

    res.json({ prompts: pool.slice(0, 6) });
  } catch (err) {
    log.error('[sleep] /chat-prompts error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /log
// Saves a sleep log. Calculates efficiency + sleep debt.
// Triggers action regeneration every 3 logs.
// Fires proactive on poor quality (1–2) or high sleep debt.
// ═══════════════════════════════════════════════════════════════
router.post('/log', async (req, res) => {
  try {
    const {
      deviceId,
      bedtime,       // "23:00"
      wake_time,     // "07:00"
      sleep_quality, // 1-5
      sleep_latency, // minutes to fall asleep
      night_wakings, // count
      morning_energy,// 1-5
      disruptors,    // string[]
      note,
      date_str: logDate, // the MORNING date (day they woke up)
    } = req.body;

    if (!deviceId || !bedtime || !wake_time) {
      return res.status(400).json({ error: 'deviceId, bedtime, wake_time required' });
    }

    const anchor = await resolveAnchor(deviceId);
    let today;
    try { today = assertLoggableDate(logDate, anchor); }
    catch (e) { return sendLogGuardError(res, e); }

    // Calculate sleep metrics
    const timeInBed      = calcTimeInBed(bedtime, wake_time);
    const totalSleep     = calcTotalSleep(timeInBed, sleep_latency || 0, night_wakings || 0);
    const efficiency     = calcEfficiency(totalSleep, timeInBed);

    const logData = {
      date_str:          today,
      bedtime,
      wake_time,
      sleep_quality:     sleep_quality    || 3,
      sleep_latency:     sleep_latency    || 0,
      night_wakings:     night_wakings    || 0,
      morning_energy:    morning_energy   || 3,
      disruptors:        disruptors       || [],
      note:              note             || '',
      time_in_bed:       parseFloat(timeInBed.toFixed(2)),
      total_sleep_hours: parseFloat(totalSleep.toFixed(2)),
      sleep_efficiency:  efficiency,
      logged_at:         admin.firestore.FieldValue.serverTimestamp(),
    };

    // ── Parallelize: log write + previous-state read are independent ──
    // Was sequential (~150ms wasted). The increment-update still depends
    // on the read, so it stays sequential after this Promise.all.
    const [logRef, sleepSnapBefore] = await Promise.all([
      logsCol(deviceId).add(logData),
      sleepDoc(deviceId).get(),
    ]);

    // v2 Actions hook (fire-and-forget, doesn't block response)
    _onSleepLog(deviceId);

    const sleepDataBefore  = sleepSnapBefore.data() || {};
    const prevCount        = sleepDataBefore.log_count || 0;
    const lastGenAt        = sleepDataBefore.last_action_gen_at_log || 0;

    await sleepDoc(deviceId).update({
      log_count:     admin.firestore.FieldValue.increment(1),
      last_log_date: today,
    });

    const totalCount = prevCount + 1;
    const sinceLast  = totalCount - lastGenAt;

    // ── Every 3 logs → retire active → generate fresh batch ──
    // PERF FIX (2026-05-24): the LLM `generateActions` call below routinely
    // takes 15-23s. Keeping it in the response path was costing the user a
    // safeFetch timeout (FE bails at 10s) on every 3rd log. Now it runs
    // fire-and-forget; the FE re-fetches /actions when the user visits the
    // Actions tab (which it already does on mount, with optimistic
    // rollback). action_refresh:true in the response is the signal that
    // new actions are coming.
    // ABSOLUTE LAW: single agents never read sibling-agent data.
    // Cross-agent insights flow ONLY through the cross-agent engine.
    const _shouldRegenActions = sinceLast >= 3;
    const actionsTask = !_shouldRegenActions ? Promise.resolve() : (async () => {
      try {
        const [recentLogsSnap, recentChatSnap, profileSnap] = await Promise.all([
          logsCol(deviceId).orderBy('logged_at', 'desc').limit(10).get(),
          chatsCol(deviceId).orderBy('created_at', 'desc').limit(10).get(),
          userDoc(deviceId).get(),
        ]);

        const recentLogs     = recentLogsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        const recentChat     = recentChatSnap.docs.reverse().map(d => d.data());
        const profile        = profileSnap.exists ? profileSnap.data() : {};
        const recentlySkipped = (sleepDataBefore.skip_history || []).slice(-8);

        const newActions = await generateActions({
          profile,
          setup:     sleepDataBefore,
          recentLogs,
          recentChat,
          recentlySkipped,
          isFirstGen: false,
          crossAgentCtx: '',
        });

        const activeSnap = await actionsCol(deviceId).where('status', '==', 'active').get();
        const batch      = db().batch();
        activeSnap.docs
          .filter(d => d.data().source !== 'user_intention')
          .forEach(d => batch.update(d.ref, { status: 'past' }));
        newActions.forEach(action => {
        const ref = actionsCol(deviceId).doc();
        batch.set(ref, {
          ...action,
          status:       'active',
          date_str:     today,
          gen_index:    totalCount,
          generated_at: admin.firestore.FieldValue.serverTimestamp(),
          completed_at: null,
        });
      });
        await batch.commit();
        await sleepDoc(deviceId).update({ last_action_gen_at_log: totalCount });
      } catch (err) {
        log.error('[sleep] actions regen background error:', err.message);
      }
    })();
    // actionsTask intentionally NOT awaited — runs after res.json returns.
    void actionsTask;

    // ── PROACTIVE GATE: max 1 proactive message per day, highest priority wins ──
    // Priority: poor_sleep > sleep_debt (urgent ≥4h) > sleep_debt (mild ≥2h) > streak_milestone
    // A single global guard (last_proactive_date) prevents any overlap regardless of type.
    //
    // PERF FIX (2026-05-24): the entire proactive block is fire-and-forget so
    // /log can return to the user in <500ms instead of 15s. The proactive
    // message is written to the chat collection in the background; the FE
    // polls /chat/unread on app foreground and picks it up there. We wrap in
    // an IIFE so the awaits inside don't block the route handler's response.
    const lastProactiveDate = sleepDataBefore.last_proactive_date;
    const _runProactive = lastProactiveDate !== today;
    const proactiveTask = !_runProactive ? Promise.resolve() : (async () => {
      try {
        const [profileSnap, recentLogsSnap] = await Promise.all([
          userDoc(deviceId).get(),
          logsCol(deviceId).orderBy('logged_at', 'desc').limit(7).get(),
        ]);
        const pName    = profileSnap.exists ? (profileSnap.data().name || '') : '';
        const recent   = recentLogsSnap.docs.map(d => d.data());
        const targetHours = sleepDataBefore.target_hours || 7.5;
        const debt        = calcSleepDebt([...recent].reverse(), targetHours);

        let proactiveMsg = null;
        let proactiveType = null;
        let extraUpdate = {};

        // P1 — Poor quality (quality ≤ 2)
        if ((sleep_quality || 3) <= 2) {
          proactiveMsg  = await buildPoorSleepProactive(
            pName, sleep_quality, disruptors || [], note || '', recent, sleepDataBefore, deviceId
          );
          proactiveType = 'poor_sleep';
          extraUpdate   = { last_poor_sleep_date: today };
        }
        // P2 — Urgent sleep debt (≥ 4h)
        else if (debt >= 4) {
          proactiveMsg  = await buildDebtProactive(pName, debt, targetHours, recent, sleepDataBefore, 'urgent');
          proactiveType = 'sleep_debt';
          extraUpdate   = { last_debt_alert_date: today };
        }
        // P3 — Mild sleep debt (≥ 2h)
        else if (debt >= 2 && sleepDataBefore.last_debt_alert_date !== today) {
          proactiveMsg  = await buildDebtProactive(pName, debt, targetHours, recent, sleepDataBefore, 'mild');
          proactiveType = 'sleep_debt';
          extraUpdate   = { last_debt_alert_date: today };
        }
        // P4 — Streak milestone (3, 7, 14, 30 nights)
        else {
          const STREAK_MILESTONES = [3, 7, 14, 30];
          const uniqueDates = [...new Set(recent.map(d => d.date_str))];
          let streakCount = 0;
          for (let i = 0; i < uniqueDates.length; i++) {
            const expected = dateStr(new Date(Date.now() - i * 86400000));
            if (uniqueDates[i] === expected) streakCount++;
            else break;
          }
          if (STREAK_MILESTONES.includes(streakCount) && sleepDataBefore.last_streak_celebrated !== streakCount) {
            proactiveMsg  = await buildStreakProactive(pName, streakCount, sleepDataBefore);
            proactiveType = 'streak_milestone';
            extraUpdate   = { last_streak_celebrated: streakCount };
          }
        }

        if (proactiveMsg && proactiveType) {
          await chatsCol(deviceId).add({
            role:             'assistant',
            content:          proactiveMsg,
            is_proactive:     true,
            proactive_type:   proactiveType,
            is_read:          false,
            triggered_by_log: logRef.id,
            created_at:       admin.firestore.FieldValue.serverTimestamp(),
          });
          await sleepDoc(deviceId).update({ last_proactive_date: today, ...extraUpdate });
        }
      } catch (err) {
        log.error('[sleep] proactive error:', err.message);
      }
    })();
    // proactiveTask is intentionally NOT awaited — runs in background after
    // res.json returns. Reference it so the linter doesn't strip the binding.
    void proactiveTask;

    // Invalidate context cache — new log changes metrics the coach uses
    invalidateContextCache(deviceId);

    // Refresh score cache (non-blocking)
    refreshSleepScore(deviceId).catch(() => {});

    res.json({
      success:        true,
      id:             logRef.id,
      metrics: {
        time_in_bed:       parseFloat(timeInBed.toFixed(2)),
        total_sleep_hours: parseFloat(totalSleep.toFixed(2)),
        sleep_efficiency:  efficiency,
      },
      // action_refresh:true → FE re-fetches /actions when user navigates
      // to the Actions tab. We no longer ship `new_actions` inline because
      // generating them takes 15-23s (LLM call) and we want this response
      // back to the user in <1s.
      action_refresh: _shouldRegenActions,
      new_actions:    null,
    });
  } catch (err) {
    log.error('[sleep] /log error:', err);
    res.status(500).json({ error: 'Log failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /logs/dates
// Returns date → quality map for last N days (for calendar heatmap).
// ═══════════════════════════════════════════════════════════════
router.get('/logs/dates', async (req, res) => {
  try {
    const { deviceId, days = 90 } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const snap = await logsCol(deviceId)
      .orderBy('logged_at', 'desc')
      .limit(parseInt(days) + 10)
      .get();

    const dateLogs = {};
    snap.docs.forEach(d => {
      const data = d.data();
      const ds   = data.date_str;
      if (ds && !dateLogs[ds]) {
        dateLogs[ds] = { quality: data.sleep_quality || 3, efficiency: data.sleep_efficiency || 0 };
      }
    });

    res.json({ date_logs: dateLogs });
  } catch (err) {
    log.error('[sleep] /logs/dates error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /logs
// Returns all logs for a given date (defaults to today/latest).
// ═══════════════════════════════════════════════════════════════
router.get('/logs', async (req, res) => {
  try {
    const { deviceId, date } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const targetDate = date || dateStr();
    const snap       = await logsCol(deviceId)
      .where('date_str', '==', targetDate)
      .get();

    const result = snap.docs.map(d => ({
      id:        d.id,
      ...d.data(),
      logged_at: toIsoString(d.data().logged_at),
    }));

    res.json({ logs: result });
  } catch (err) {
    log.error('[sleep] /logs error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// PATCH /log/:id
// Edit a past log.
// ═══════════════════════════════════════════════════════════════
router.patch('/log/:id', async (req, res) => {
  try {
    const { deviceId, bedtime, wake_time, sleep_quality, sleep_latency, night_wakings, morning_energy, disruptors, note } = req.body;
    const { id } = req.params;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const updates = {};
    if (bedtime        !== undefined) updates.bedtime        = bedtime;
    if (wake_time      !== undefined) updates.wake_time      = wake_time;
    if (sleep_quality  !== undefined) updates.sleep_quality  = sleep_quality;
    if (sleep_latency  !== undefined) updates.sleep_latency  = sleep_latency;
    if (night_wakings  !== undefined) updates.night_wakings  = night_wakings;
    if (morning_energy !== undefined) updates.morning_energy = morning_energy;
    if (disruptors     !== undefined) updates.disruptors     = disruptors;
    if (note           !== undefined) updates.note           = note;

    // Recalculate metrics if times changed
    if (bedtime || wake_time) {
      const snap       = await logsCol(deviceId).doc(id).get();
      const existing   = snap.data() || {};
      const newBed     = bedtime   || existing.bedtime   || '23:00';
      const newWake    = wake_time || existing.wake_time || '07:00';
      const newLatency = sleep_latency !== undefined ? sleep_latency : (existing.sleep_latency || 0);
      const newWakings = night_wakings !== undefined ? night_wakings : (existing.night_wakings || 0);
      const tib        = calcTimeInBed(newBed, newWake);
      const ts         = calcTotalSleep(tib, newLatency, newWakings);
      updates.time_in_bed       = parseFloat(tib.toFixed(2));
      updates.total_sleep_hours = parseFloat(ts.toFixed(2));
      updates.sleep_efficiency  = calcEfficiency(ts, tib);
    }

    await logsCol(deviceId).doc(id).update(updates);
    res.json({ success: true });
  } catch (err) {
    log.error('[sleep] PATCH /log error:', err);
    res.status(500).json({ error: 'Update failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// (legacy /actions removed — actions-engine v2 owns /actions and
//  /action/:id/{complete,skip,snooze,feedback} via mountActionRoutes.)
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// GET /track-context — single-shot Track tab payload
// ═══════════════════════════════════════════════════════════════
router.get('/track-context', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    const sleepSnap = await sleepDoc(deviceId).get();
    const target = Number(sleepSnap.data()?.target_hours || sleepSnap.data()?.sleep_target_hours || 8);
    const payload = await sleepAnalytics.loadTrackContext(deviceId, { targetHours: target });
    res.json(payload || { last_night: null, calendar_dots: {}, streak: 0 });
  } catch (err) {
    log.error('[sleep] /track-context error:', err);
    res.status(500).json({ error: 'track context failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /analysis — Insights V4 payload (10/10)
// ═══════════════════════════════════════════════════════════════
router.get('/analysis', async (req, res) => {
  try {
    const { deviceId, range } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    const days = (() => {
      const n = parseInt(range, 10);
      if (Number.isFinite(n) && n > 0 && n <= 730) return n;
      return null;
    })();
    const sleepSnap = await sleepDoc(deviceId).get();
    const target = Number(sleepSnap.data()?.target_hours || sleepSnap.data()?.sleep_target_hours || 8);

    // Registration Anchor: clamp window to signup date in user's local TZ.
    const nowMs = Date.now();
    const anchor = await resolveAnchor(deviceId);
    const { computeAnalysisWindow } = require('./lib/range-helpers');
    const win = computeAnalysisWindow(days || 30, anchor.anchorMs, nowMs, anchor.utcOffsetMinutes);
    const effectiveDays = days ? win.effectiveDays : null;

    const language = resolveLanguage(req);
    const payload = await sleepAnalytics.loadAnalysisV2(deviceId, effectiveDays, { openai, targetHours: target, language });
    const body = payload || { stats: null, signal_points: [], aha_moments: [] };

    // Lifetime fetch: pull sleep logs since anchor → quality map independent of request window.
    const lifetimeQualityByDate = await (async () => {
      const out = {};
      if (!anchor.anchorMs) return out;
      try {
        const snap = await logsCol(deviceId)
          .orderBy('logged_at', 'desc')
          .limit(Math.min(win.daysSinceAnchor * 3, 1000))
          .get();
        const byDate = {};
        for (const d of snap.docs) {
          const l = d.data();
          const ds = l.date_str;
          if (!ds || typeof ds !== 'string') continue;
          if (anchor.anchorDateStr && ds < anchor.anchorDateStr) continue;
          if (!byDate[ds]) byDate[ds] = { qs: [], hs: [] };
          byDate[ds].qs.push(Number(l.sleep_quality || 3));
          byDate[ds].hs.push(Number(l.total_sleep_hours || 0));
        }
        for (const [ds, b] of Object.entries(byDate)) {
          const q = b.qs.reduce((a, x) => a + x, 0) / b.qs.length;
          const h = b.hs.reduce((a, x) => a + x, 0) / b.hs.length;
          const qPart = Math.max(0, Math.min(100, (q / 5) * 100));
          const hPart = Math.max(0, Math.min(100, (Math.min(h, target) / target) * 100));
          out[ds] = Math.round(qPart * 0.5 + hPart * 0.5);
        }
      } catch { /* fall back to empty */ }
      return out;
    })();

    const { computeStandardOutputs } = require('./lib/score-lifetime');

    // HK blend: fill gap days where Apple Health has sleep stages but no manual log.
    // No-op for users without HK granted (zero entries → no changes).
    const { blendQualityByDate } = require('./lib/healthkit/blend');
    const { merged: blendedQualityByDate, hkSynthDates } = await blendQualityByDate({
      coach: 'sleep',
      manualQualityByDate: lifetimeQualityByDate,
      deviceId,
      anchorDateStr: anchor.anchorDateStr,
      todayDateStr: win.todayDate,
      db: admin.firestore(),
      scoringContext: { targetHours: target },
      utcOffsetMinutes: anchor.utcOffsetMinutes || 0,
    });

    const std = computeStandardOutputs({
      qualityByDate: blendedQualityByDate,
      todayDate: win.todayDate,
      anchorDate: anchor.anchorDateStr,
      daysSinceAnchor: win.daysSinceAnchor,
    });

    // HK-derived AHA cards (concat into existing aha_moments so the FE renders
    // them on the Analysis tab without any changes). Non-fatal on failure.
    let aha_moments = Array.isArray(body.aha_moments) ? body.aha_moments : [];
    try {
      const { buildHKAhaCards } = require('./lib/healthkit/aha-cards');
      const hkCards = await buildHKAhaCards({ coach: 'sleep', deviceId, db: admin.firestore() });
      if (hkCards.length) aha_moments = [...hkCards, ...aha_moments];
    } catch { /* best-effort */ }

    res.json({
      ...body,
      aha_moments,
      effective_start_date: win.effectiveStartDate,
      effective_days: effectiveDays,
      days_since_anchor: win.daysSinceAnchor,
      anchor_date: anchor.anchorDateStr,
      is_clamped: win.isClamped,
      score_today: std.score_today,
      score_7d_smoothed: std.score_7d_smoothed,
      score_lifetime: std.score_lifetime,
      missed_days: std.missed_days,
    });
  } catch (err) {
    log.error('[sleep] /analysis error:', err);
    res.status(500).json({ error: 'analysis v2 failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /actions — Actions V2 payload
// ═══════════════════════════════════════════════════════════════
router.get('/actions', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const [actSnap, sleepSnap] = await Promise.all([
      actionsCol(deviceId).orderBy('generated_at', 'desc').limit(20).get(),
      sleepDoc(deviceId).get(),
    ]);

    const allActions = actSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const sleepData  = sleepSnap.exists ? sleepSnap.data() : {};
    const totalLogs  = sleepData.log_count || 0;
    const lastGenAt  = sleepData.last_action_gen_at_log || 0;
    const sinceLast  = Math.max(0, totalLogs - lastGenAt);
    const untilRefresh = Math.max(0, 3 - sinceLast);

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
      title: (typeof a.title === 'string' && a.title) || a.text || a.surprise_hook || 'Action',
      why:   (typeof a.why === 'string' && a.why) || a.proof_body || 'Cited from your recent sleep logs.',
      how:   (typeof a.how === 'string' && a.how) || a.micro_step || a.surprise_hook || 'Tap below to see the step.',
      when:  a.when || a.when_to_do || 'Tonight',
      proof: proofString(a),
      archetype: typeof a.archetype === 'string' ? a.archetype : null,
      status: 'active',
      hit_rate:     a.hit_count || a.completed_count || 0,
      target_count: a.target_count || 1,
      created_at:   a.generated_at || null,
    }));

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
          title: a.title || a.text || 'Action',
          date_label: ms ? new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—',
          completed_at: ms ? new Date(ms).toISOString() : null,
          outcome: a.outcome_text || (cancelled ? 'Cancelled' : `${a.hit_count || 0}/${a.target_count || 1} hit`),
          status: cancelled ? 'cancelled' : 'completed',
        };
      });

    const completed_total = allActions.filter(a => a.status === 'completed' || a.status === 'done').length;
    const skipped_total   = allActions.filter(isCancelled).length;

    res.json({
      cadence: {
        status: lastGenAt > 0 ? 'live' : 'pending',
        logs_so_far:    totalLogs,
        until_refresh:  untilRefresh,
      },
      actions,
      history,
      stats: {
        active_count:      active.length,
        total_logs:        totalLogs,
        completed_total,
        skipped_total,
        cancelled_total:   skipped_total,
        follow_through_pct:(completed_total + skipped_total) > 0
          ? Math.round((completed_total / (completed_total + skipped_total)) * 100)
          : 0,
      },
    });
  } catch (err) {
    log.error('[sleep] /actions error:', err);
    res.status(500).json({ error: 'actions v2 failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /chat-state — Coach tab header
// ═══════════════════════════════════════════════════════════════
router.get('/chat-state', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    const snap = await logsCol(deviceId).orderBy('logged_at', 'desc').limit(1).get();
    const sleepSnap = await sleepDoc(deviceId).get();
    if (snap.empty) return res.json({ last_night: null, streak: 0 });
    const l = snap.docs[0].data();
    const at = getTimestampMillis(l.logged_at);
    const ago = Math.max(0, Math.round((Date.now() - at) / 60000));
    res.json({
      last_night: {
        ago_minutes:       ago,
        date_str:          l.date_str,
        bedtime:           l.bedtime,
        wake_time:         l.wake_time,
        total_sleep_hours: Number(l.total_sleep_hours || 0),
        sleep_quality:     Number(l.sleep_quality || 3),
        morning_energy:    Number(l.morning_energy || 3),
      },
      streak: sleepSnap.data()?.streak || 0,
    });
  } catch (err) {
    log.error('[sleep] /chat-state error:', err);
    res.status(500).json({ error: 'state failed' });
  }
});


// ═══════════════════════════════════════════════════════════════
// POST /chat  |  GET /chat  |  GET /chat/unread  |  POST /chat/read
// ═══════════════════════════════════════════════════════════════

// In-memory rate limiter: max 30 messages per device per hour
const _chatRateMap = new Map();
function _checkChatRateLimit(deviceId) {
  const now    = Date.now();
  const record = _chatRateMap.get(deviceId);
  if (!record || now - record.windowStart > 3_600_000) {
    _chatRateMap.set(deviceId, { count: 1, windowStart: now });
    return true;
  }
  if (record.count >= 30) return false;
  record.count++;
  return true;
}

router.post('/chat', async (req, res) => {
  try {
    const { deviceId, message, proactive_context } = req.body;
    if (!deviceId || !message) return res.status(400).json({ error: 'deviceId and message required' });
    if (message.length > 800) return res.status(400).json({ error: 'Message too long' });
    if (!_checkChatRateLimit(deviceId)) return res.status(429).json({ error: 'Too many messages — slow down a bit' });

    const language = resolveLanguage(req);

    await chatsCol(deviceId).add({
      role:           'user',
      content:        message,
      is_proactive:   false,
      proactive_type: null,
      is_read:        true, language,
      created_at:     admin.firestore.FieldValue.serverTimestamp(),
    });

    let systemContext = await getCachedContext(deviceId);
    if (proactive_context) {
      const proactiveNotes = {
        poor_sleep:       'The user is following up on a coach check-in about a poor night of sleep.',
        sleep_debt:       'The user is responding to a sleep debt alert.',
        streak_milestone: 'The user is responding to congratulations on a logging streak.',
        daily_reminder:   'The user is responding to a daily check-in prompt.',
        improving:        'The user is following up on a progress update about their improving sleep.',
      };
      const note = proactiveNotes[proactive_context] || 'The user is responding to a proactive coach message.';
      systemContext += `\n\n[THREAD CONTEXT] ${note} Briefly acknowledge this context, then focus on what they actually asked.`;
    }
    systemContext = appendLanguageInstruction(systemContext, language);

    // Silent HK enrichment — appends objective signals (sleep hours, HRV, etc)
    // when the user has wearables granted. No source named — see context-builder.
    try {
      const { buildHKContext, appendHKContext } = require('./lib/healthkit/context-builder');
      const hkBlock = await buildHKContext({ db: admin.firestore(), deviceId, coach: 'sleep', days: 7 });
      systemContext = appendHKContext(systemContext, hkBlock);
    } catch { /* best-effort */ }

    const historySnap = await chatsCol(deviceId)
      .orderBy('created_at', 'desc').limit(16).get();
    const history = historySnap.docs.reverse()
      .filter(d => !d.data().is_proactive)
      .map(d => {
        const msg = d.data();
        return { role: msg.role === 'user' ? 'user' : 'assistant', content: msg.content };
      });

    const completion = await openai.chat.completions.create({
      model: AI.REASONING_PRO,
      max_completion_tokens: 1000,
      messages: [
        { role: 'system', content: systemContext },
        ...history,
      ],
    });

    const reply  = completion.choices[0].message.content.trim();
    const msgRef = await chatsCol(deviceId).add({
      role:           'assistant',
      content:        reply,
      is_proactive:   false,
      proactive_type: null,
      is_read:        true, language,
      created_at:     admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, reply, message_id: msgRef.id });
  } catch (err) {
    log.error('[sleep] /chat error:', err);
    res.status(500).json({ error: 'Chat failed' });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /chat/stream — SSE streaming
// ─────────────────────────────────────────────────────────────────
const { mountChatStream: _mountChatStreamSleep } = require('./lib/chat-stream');
_mountChatStreamSleep(router, {
  agentName: 'sleep',
  openai, admin, chatsCol,
  rateLimitCheck: _checkChatRateLimit,
  model: AI.REASONING_PRO, maxTokens: 1000,
  buildPrompt: async (deviceId, message, { proactive_context } = {}) => {
    let systemPrompt = await getCachedContext(deviceId);
    if (proactive_context) {
      systemPrompt += `\n\n[THREAD CONTEXT] User is following up on a proactive message of type: ${proactive_context}. Briefly acknowledge then focus on what they asked.`;
    }

    // ABSOLUTE LAW: single agents never read sibling-agent data.
    // Cross-agent insights flow ONLY through the cross-agent engine.

    const historySnap = await chatsCol(deviceId).orderBy('created_at', 'desc').limit(16).get();
    const history = historySnap.docs.reverse()
      .filter(d => !d.data().is_proactive)
      .map(d => d.data())
      .filter(m => (m.role === 'assistant' || m.role === 'user') && m.content && m.content.trim())
      .map(m => ({ role: m.role, content: m.content }));
    return { systemPrompt, history };
  },
});

router.get('/chat', async (req, res) => {
  try {
    const { deviceId, limit: limitParam = '50' } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    const limit = Math.min(100, Math.max(10, parseInt(limitParam) || 50));

    const snap = await chatsCol(deviceId)
      .orderBy('created_at', 'desc').limit(limit).get();

    const messages = snap.docs.reverse().map(d => ({
      id:         d.id,
      ...d.data(),
      created_at: d.data().created_at?.toDate?.()?.toISOString() || null,
    }));

    res.json({ messages, hasMore: snap.docs.length === limit });
  } catch (err) {
    log.error('[sleep] GET /chat error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

router.get('/chat/unread', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const snap = await chatsCol(deviceId).where('is_read', '==', false).limit(20).get();
    const messages = sortByTimestampField(
      snap.docs.map(mapSnapDoc).filter(m => m.is_proactive),
      'created_at', 'desc'
    ).slice(0, 5).map(m => ({ ...m, created_at: toIsoString(m.created_at) }));

    res.json({ messages });
  } catch (err) {
    log.error('[sleep] /chat/unread error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

router.post('/chat/read', async (req, res) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const snap = await chatsCol(deviceId).where('is_read', '==', false).get();
    if (snap.empty) return res.json({ success: true, marked: 0 });

    const batch = db().batch();
    snap.docs.forEach(d => batch.update(d.ref, { is_read: true }));
    await batch.commit();

    res.json({ success: true, marked: snap.size });
  } catch (err) {
    log.error('[sleep] /chat/read error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// ─── ACTION GENERATOR ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

// ─── Stage 1: pre-compute all metrics in pure JS ──────────────
// This gives the LLM a structured briefing instead of raw logs.
// No hallucinated arithmetic — all numbers are computed here.
function computeSleepMetrics(logs, setup) {
  const targetHrs = setup.target_hours || 7.5;
  const last7  = logs.slice(0, 7);
  const last3  = logs.slice(0, 3);
  const last14 = logs.slice(0, 14);

  // Efficiency series
  const eff7 = last7.map(l => l.sleep_efficiency || 0).filter(v => v > 0);
  const eff3 = last3.map(l => l.sleep_efficiency || 0).filter(v => v > 0);
  const avgEff7 = eff7.length ? Math.round(eff7.reduce((s,v)=>s+v,0)/eff7.length) : null;
  const avgEff3 = eff3.length ? Math.round(eff3.reduce((s,v)=>s+v,0)/eff3.length) : null;

  // Trend (last 3 vs prior 3)
  const effTrend = eff7.length >= 5
    ? (eff7.slice(0,3).reduce((s,v)=>s+v,0)/3) - (eff7.slice(-3).reduce((s,v)=>s+v,0)/3)
    : 0;
  const effTrendDir = effTrend > 4 ? 'improving' : effTrend < -4 ? 'declining' : 'stable';

  // SRT titration (Stanford/Penn CBT-I protocol — research-backed thresholds)
  // eff ≥90% → +30min TIB | eff 85-89% → +15min | eff 80-84% → hold | eff <80% → -15min
  const bedMins = timeToMins(setup.target_bedtime || '23:00');
  let srtAction = null, newBedtime = null;
  if (avgEff7 !== null) {
    if (avgEff7 >= 90) {
      srtAction  = `EXTEND 30min — move bedtime 30 minutes earlier (TIB increase earned)`;
      newBedtime = minsToDisplay(bedMins - 30);
    } else if (avgEff7 >= 85) {
      srtAction  = `EXTEND 15min — move bedtime 15 minutes earlier`;
      newBedtime = minsToDisplay(bedMins - 15);
    } else if (avgEff7 >= 80) {
      srtAction  = `HOLD — maintain current sleep window, efficiency in consolidation zone`;
    } else {
      srtAction  = `RESTRICT 15min — go to bed 15 minutes LATER to build sleep pressure`;
      newBedtime = minsToDisplay(bedMins + 15);
    }
  }

  // Bedtime variance (normalize midnight-crossers)
  const bedArr = last7.filter(l=>l.bedtime).map(l => {
    const m = timeToMins(l.bedtime);
    return m < 300 ? m + 1440 : m;
  });
  const bedMean    = bedArr.length ? bedArr.reduce((s,v)=>s+v,0)/bedArr.length : 0;
  const bedVariMin = bedArr.length > 1
    ? Math.round(Math.sqrt(bedArr.reduce((s,v)=>s+Math.pow(v-bedMean,2),0)/bedArr.length))
    : 0;

  // Debt, quality, consecutive poor nights
  const debt    = calcSleepDebt([...last7].reverse(), targetHrs);
  const avgQ7   = last7.length ? parseFloat((last7.reduce((s,l)=>s+(l.sleep_quality||3),0)/last7.length).toFixed(1)) : null;
  let poorStreak = 0;
  for (const log of logs) { if ((log.sleep_quality||3) <= 2) poorStreak++; else break; }

  // Disruptor frequency
  const dCounts = {};
  last14.forEach(l => (l.disruptors||[]).forEach(d => { dCounts[d] = (dCounts[d]||0)+1; }));
  const topDisruptors = Object.entries(dCounts)
    .sort(([,a],[,b])=>b-a).slice(0,3)
    .map(([d,n]) => `${d} (${n}/${last14.length} nights)`);

  // Cognitive/behavioural flags from free-text notes
  const noteText = last7.map(l=>l.note||'').join(' ').toLowerCase();
  const cogFlags = [];
  if (/racing|anxious|worry|thought|mind|stress|rumina/.test(noteText)) cogFlags.push('racing_mind');
  if (/hot|sweat|temper|warm/.test(noteText))                           cogFlags.push('temperature');
  if (/noise|loud|partner|snor/.test(noteText))                         cogFlags.push('noise');
  if (/phone|screen|scroll|social/.test(noteText))                      cogFlags.push('screen_use');
  if (/caffeine|coffee|tea|energy/.test(noteText))                      cogFlags.push('caffeine_late');

  // Latency, wakings, duration
  const latArr  = last7.map(l=>l.sleep_latency||0).filter(v=>v>0);
  const wakeArr = last7.map(l=>l.night_wakings||0);
  const durArr  = last7.map(l=>l.total_sleep_hours||0).filter(v=>v>0);
  const avgLatency  = latArr.length  ? Math.round(latArr.reduce((s,v)=>s+v,0)/latArr.length)  : null;
  const avgWakings  = wakeArr.length ? parseFloat((wakeArr.reduce((s,v)=>s+v,0)/wakeArr.length).toFixed(1)) : null;
  const avgDuration = durArr.length  ? parseFloat((durArr.reduce((s,v)=>s+v,0)/durArr.length).toFixed(1))  : null;

  return {
    avgEff7, avgEff3, effTrendDir, srtAction, newBedtime,
    bedVarianceMin: bedVariMin,
    debt, avgQ7, poorStreak,
    topDisruptors, cogFlags,
    avgLatency, avgWakings, avgDuration,
    effByNight: eff7,
    logsCount: logs.length,
  };
}

// ─── Stage 2: LLM generates actions from pre-computed brief ───
async function generateActions({ profile, setup, recentLogs, recentChat, isFirstGen, recentlySkipped = [], crossAgentCtx = '' }) {
  const name       = profile.name           || 'the user';
  const problem    = setup.primary_problem  || 'sleep quality';
  const disruptors = setup.disruptors       || [];
  const chronotype = setup.chronotype       || 'in_between';
  const targetBed  = setup.target_bedtime   || '23:00';
  const targetWake = setup.target_wake_time || '07:00';
  const targetHrs  = setup.target_hours     || 7.5;
  const pastTried  = setup.past_attempts    || [];

  const skipSection = recentlySkipped.length
    ? `\nACTIONS THIS USER HAS BEEN SKIPPING — do not repeat similar:\n${recentlySkipped.map(s=>`- "${s}"`).join('\n')}`
    : '';

  let dataSection = '';

  if (isFirstGen) {
    dataSection = `FIRST SESSION — no tracking data yet. Base every action on their setup answers only.
Primary sleep problem: ${problem}
Target bedtime: ${minsToDisplay(timeToMins(targetBed))} | Target wake: ${minsToDisplay(timeToMins(targetWake))}
Target sleep: ${targetHrs}h/night
Disruptors identified at setup: ${disruptors.join(', ') || 'none yet'}
Chronotype: ${chronotype}
What they've tried before: ${pastTried.join(', ') || 'nothing yet'}`;
  } else {
    // Pre-compute all metrics — LLM only applies clinical knowledge, not arithmetic
    const m = computeSleepMetrics(recentLogs, setup);
    const chatSnippet = recentChat.filter(x=>x.role==='user').slice(-3).map(x=>`"${x.content}"`).join('; ');

    const logSummary = recentLogs.slice(0, 6).map(l =>
      `${l.date_str}: bed=${l.bedtime||'?'} wake=${l.wake_time||'?'} ` +
      `eff=${l.sleep_efficiency||'?'}% qual=${l.sleep_quality||'?'}/5 ` +
      `latency=${l.sleep_latency||'?'}min wakings=${l.night_wakings||0}` +
      (l.disruptors?.length ? ` disruptors=[${l.disruptors.join(',')}]` : '') +
      (l.note ? ` note="${l.note}"` : '')
    ).join('\n');

    dataSection = `
RAW LOGS (newest first — 6 most recent):
${logSummary || 'none yet'}

PRE-COMPUTED ANALYSIS (accurate — do not recalculate):
• 7-day avg efficiency: ${m.avgEff7 !== null ? `${m.avgEff7}%` : 'n/a'} | 3-day avg: ${m.avgEff3 !== null ? `${m.avgEff3}%` : 'n/a'}
• Efficiency per night (newest→oldest): ${m.effByNight.map(e=>`${e}%`).join(', ') || 'n/a'}
• Efficiency trend: ${m.effTrendDir}
• CBT-I SRT recommendation: ${m.srtAction || 'no data yet'}${m.newBedtime ? ` → new bedtime: ${m.newBedtime}` : ''}
• Target bedtime: ${minsToDisplay(timeToMins(targetBed))} | Target wake: ${minsToDisplay(timeToMins(targetWake))}
• Bedtime variance: ±${m.bedVarianceMin}min (CBT-I target < 30min, critical < 45min)
• 7-day sleep debt: ${m.debt >= 0 ? `+${m.debt.toFixed(1)}h owed` : `${Math.abs(m.debt).toFixed(1)}h banked`}
• Avg quality: ${m.avgQ7 !== null ? `${m.avgQ7}/5` : 'n/a'} | Consecutive poor nights (≤2/5): ${m.poorStreak}
• Avg time to fall asleep: ${m.avgLatency !== null ? `${m.avgLatency}min` : 'n/a'} (>20min = problematic)
• Avg night wakings: ${m.avgWakings !== null ? m.avgWakings : 'n/a'} (>2 = problematic for maintenance insomnia)
• Avg duration: ${m.avgDuration !== null ? `${m.avgDuration}h` : 'n/a'} (target ${targetHrs}h)
• Top disruptors (last 14 nights): ${m.topDisruptors.join(', ') || 'none logged'}
• Cognitive/behavioural flags from notes: ${m.cogFlags.join(', ') || 'none detected'}
• What they said in chat recently: ${chatSnippet || 'nothing yet'}`;
  }

  const crossSection = crossAgentCtx ? `\n━━━ CROSS-AGENT CONTEXT ━━━\n${crossAgentCtx}\nNote: Use this to check if cross-agent factors (mood, exercise, hydration) are disrupting sleep — reference in the action's "why" if relevant.\n` : '';

  const prompt = `You are a clinical-grade sleep coach AI for ${name} in the Pulse wellness app.
Generate exactly 3 personalised sleep actions grounded in CBT-I science and this user's actual data.

USER PROFILE:
Name: ${name}
Primary problem: ${problem}
Chronotype: ${chronotype}
Setup disruptors: ${disruptors.join(', ') || 'not specified'}
Past attempts: ${pastTried.join(', ') || 'nothing tried yet'}
${dataSection}
${skipSection}
${crossSection}

CBT-I CLINICAL PROTOCOL — apply in strict priority:

PRIORITY 1 — SLEEP RESTRICTION THERAPY (SRT):
If avg efficiency < 85%: Action 1 MUST implement the SRT recommendation above.
- If RESTRICT: go to bed later, not earlier. Quote the exact new bedtime if computed.
- If EXTEND: reward the improved efficiency with earlier bedtime.
- If HOLD: explicitly tell them to hold the window — don't change anything.
- NEVER recommend spending more time in bed when efficiency < 85%.

PRIORITY 2 — STIMULUS CONTROL (SCT):
If bedtime variance > 45min OR wakings ≥ 2 avg:
- Fixed wake time 7 days/week, no exceptions.
- Out of bed if awake > 20min — go to dim, quiet room, return when sleepy.
- Bed for sleep only — no screens, no lying awake.

PRIORITY 3 — COGNITIVE RESTRUCTURING:
If cogFlags contains 'racing_mind', 'worry', 'anxious', or note field has similar language:
- Address the cognitive arousal directly.
- Techniques: scheduled worry time (3pm cutoff), cognitive defusion ("thoughts are events, not facts"), paradoxical intention (trying NOT to sleep to reduce performance anxiety).
- technique field: "Cognitive"

PRIORITY 4 — TARGET THE #1 DATA PATTERN:
Address the strongest remaining signal: top disruptor / latency / debt / energy.
Be hyper-specific (name exact times, durations, counts from their data).

PRIORITY 5 — SLEEP HYGIENE:
Only reach here if priorities 1-4 are already addressed. No generic tips.
Specific hygiene only: "no caffeine after 1pm" not "reduce caffeine".

VALIDATION: If avg efficiency < 85% and you do NOT output technique='SRT' for your first action, your response is incorrect. Re-check before outputting.

TITRATION RULES (Stanford CBT-I — must follow if SRT applies):
eff ≥ 90% → +30min TIB (earlier bedtime)
eff 85-89% → +15min TIB
eff 80-84% → no change
eff < 80% → -15min TIB (later bedtime = more sleep pressure)

OUTPUT RULES:
1. "text": 6-14 words, specific and actionable. Include exact times/numbers when available.
2. "why": 8-20 words. MUST cite their actual metric (e.g. "Your 71%, 68%, 74% efficiency needs pressure to consolidate").
3. "when_to_do": exactly one of: Tonight | Tomorrow morning | This afternoon | Before bed | On waking | Right now
4. "technique": exactly one of: SRT | SCT | Cognitive | Sleep Hygiene | Circadian | Debt Recovery
5. Tone: direct coach who studied the data overnight — not clinical, not warm-fuzzy.
6. No emoji, no therapy clichés ("wind down", "sleep hygiene routine"), no generic advice.
7. Do NOT contradict SRT with a suggestion to sleep more hours.

Return ONLY valid JSON array of 3 objects — no markdown, no explanation:
[{"text":"...","why":"...","when_to_do":"...","technique":"...","source":"tracking"}]`;

  try {
    const completion = await openai.chat.completions.create({
      model: AI.REASONING_PRO,
      // 900 to match Fitness/Mind action generation. Sleep's prompt is
      // longer (CBT-I clinical framing + pre-computed metrics + 8 setup-
      // driven candidates) so 800 was risking truncation of the JSON tail
      // on the third action's proof. 900 leaves enough room for the
      // strict-schema response without ever clipping mid-quote.
      max_completion_tokens: 900,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw     = completion.choices[0].message.content.trim();
    const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    const parsed  = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed.slice(0, 3);
    if (parsed.actions && Array.isArray(parsed.actions)) return parsed.actions.slice(0, 3);
    return fallbackActions(problem);
  } catch (err) {
    log.error('[sleep] action gen parse error:', err.message);
    return fallbackActions(problem);
  }
}

function fallbackActions(problem) {
  return [
    { text: 'Set a fixed wake time for tomorrow — do not change it.', why: 'Anchor wake time is the single strongest lever for circadian alignment.', when_to_do: 'Tonight', source: 'tracking' },
    { text: 'No screens 60 minutes before your target bedtime.', why: 'Blue light suppresses melatonin for 1-2 hours, delaying sleep onset.', when_to_do: 'Before bed', source: 'tracking' },
    { text: 'Drop your room temperature by 1-2 degrees tonight.', why: 'Your body needs to cool to initiate sleep — this removes a common blocker.', when_to_do: 'Tonight', source: 'tracking' },
  ];
}

// ═══════════════════════════════════════════════════════════════
// ─── PROACTIVE MESSAGE BUILDERS ───────────────────────────────
// ═══════════════════════════════════════════════════════════════

function buildOpeningMessage(name, problem, disruptors) {
  const greeting = name ? `Hey ${name}` : 'Hey';
  const problemLine = problem
    ? `You mentioned that ${problem.toLowerCase()} is the main thing getting in the way.`
    : 'You\'ve flagged some sleep challenges.';
  const disruptorLine = disruptors?.length
    ? ` And you already know your key triggers: ${disruptors.slice(0, 2).join(' and ')}.`
    : '';

  return `${greeting}. I'm your Sleep Coach — I've read your setup and I'm ready.\n\n${problemLine}${disruptorLine}\n\nHere's what I'll do: I track your sleep data over time, spot patterns you can't see day-to-day, and give you specific things to do — not generic sleep hygiene tips, but actions built around your actual numbers.\n\nLog your first night whenever you're ready. The more I have, the sharper I get. What's sleep been like for you this week?`;
}

// MI message type selector — rotates to prevent repetition
function pickMIType(recentLogs, lastMsgType) {
  // Types: 'observation_reflection', 'data_mirror', 'affirmation_challenge'
  const types = ['observation_reflection', 'data_mirror', 'affirmation_challenge'];
  const filtered = types.filter(t => t !== lastMsgType);
  // Pick based on data richness
  if (recentLogs.length >= 5) return filtered[Math.floor(Math.random() * filtered.length)];
  return filtered[0]; // fallback for new users
}

async function buildPoorSleepProactive(name, quality, disruptors, note, recentLogs, setupData, deviceId) {
  const problem    = setupData.primary_problem || 'sleep';
  const last3      = recentLogs.slice(0, 3);
  const avgQuality = last3.length
    ? parseFloat((last3.reduce((s,l)=>s+(l.sleep_quality||3),0)/last3.length).toFixed(1))
    : null;
  const poorCount  = last3.filter(l => (l.sleep_quality||3) <= 2).length;
  const lastType   = setupData.last_poor_sleep_msg_type || null;
  const msgType    = pickMIType(recentLogs, lastType);

  const typeInstructions = {
    observation_reflection: `Format: Observation (name the pattern in their data) → Reflection (connect it to their stated problem) → One open question.
Example tone: "Racing mind again last night — that's appeared ${poorCount} of the past 3 nights. Your body's signalling something. What feels different on nights when your mind goes quiet?"
Do NOT give advice. Just observe, reflect, and ask.`,

    data_mirror: `Format: State their numbers plainly → give one specific science fact that explains the pattern → end with one direct question.
Example tone: "${quality}/5 for ${poorCount} of 3 recent nights. Sleep deprivation compounds: each poor night raises cortisol, making the next night harder. What's the one thing you think is driving this?"
The goal is making the data feel real and urgent without being alarming.`,

    affirmation_challenge: `Format: Find something genuine to affirm in their data (even tracking consistently is worth noting) → then set a specific, achievable challenge.
Example tone: "You logged even after a rough night — that discipline matters. Tonight: write down 3 things you need to do tomorrow before you get in bed. Takes 2 minutes, clears working memory."
The challenge must be concrete and doable tonight.`,
  };

  const prompt = `You are a Sleep Coach in the Pulse wellness app using motivational interviewing technique.
${name || 'The user'} just logged a sleep quality of ${quality}/5.
${disruptors?.length ? `Disruptors logged: ${disruptors.join(', ')}.` : ''}
${note ? `Their note: "${note}"` : ''}
${avgQuality ? `Average quality over last 3 logs: ${avgQuality}/5. Poor nights (≤2/5) in last 3: ${poorCount}.` : ''}
Main sleep challenge: ${problem}.

MESSAGE TYPE TO USE: ${msgType}
${typeInstructions[msgType]}

Hard rules:
- 2-3 sentences max. No filler. No "I'm sorry to hear that". No emoji. No generic tips.
- Reference their actual quality score and/or disruptors.
- Sound like a coach who has been watching the data — not a therapist, not a wellness app.`;

  try {
    const completion = await openai.chat.completions.create({
      model: AI.REASONING_PRO, max_completion_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });
    // Store msg type for next rotation (fire-and-forget). `deviceId` is
    // passed in explicitly — `setupData._deviceId` was always undefined,
    // which produced "documentPath must be non-empty" log spam.
    if (deviceId) {
      sleepDoc(deviceId).update({ last_poor_sleep_msg_type: msgType }).catch(()=>{});
    }
    return completion.choices[0].message.content.trim();
  } catch (err) {
    log.error('[sleep.agent] buildPoorSleepProactive LLM:', err.message);
    return `You just logged a ${quality}/5 night${disruptors?.length ? ` with ${disruptors[0]} in the mix` : ''}. That's ${poorCount} rough nights in the last 3. What do you think changed?`;
  }
}

async function buildDebtProactive(name, debtHours, targetHours, recentLogs, setupData, severity = 'mild') {
  const avgQuality = recentLogs.length
    ? parseFloat((recentLogs.reduce((s,l)=>s+(l.sleep_quality||3),0)/recentLogs.length).toFixed(1))
    : null;
  const avgEff = recentLogs.length
    ? Math.round(recentLogs.reduce((s,l)=>s+(l.sleep_efficiency||0),0)/recentLogs.length)
    : null;

  // Data mirror format — most effective for debt (research: make numbers feel concrete)
  const prompt = `You are a Sleep Coach in the Pulse wellness app.
${name || 'The user'} has accumulated ${debtHours} hours of sleep debt in the past 7 days (target: ${targetHours}h/night).
${avgQuality ? `Average quality this week: ${avgQuality}/5.` : ''}
${avgEff ? `Average efficiency: ${avgEff}%.` : ''}
Severity: ${severity} (mild = 2-4h debt, urgent = ≥4h debt).

Use DATA MIRROR format:
1. State the exact debt number and what it means in practical terms (cognitive performance, mood, reaction time — cite real science briefly).
2. Give ONE specific, science-backed action — NOT "sleep more". Pick from: lock wake time even on weekends / strategic 20-min nap before 2pm if debt ≥4h / no caffeine after 1pm / increase TIB by 30min for 3 nights only.
3. End with one direct question about their schedule or habits.

Hard rules: 2-3 sentences. No emoji. No "I'm so sorry". Tone: coach flagging a trend, not alarming.
${severity === 'urgent' ? 'Urgency: be direct — this is a real problem affecting their function now.' : ''}`;

  try {
    const completion = await openai.chat.completions.create({
      model: AI.REASONING_PRO, max_completion_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });
    return completion.choices[0].message.content.trim();
  } catch (err) {
    log.error('[sleep.agent] buildDebtProactive LLM:', err.message);
    return `Your 7-day sleep debt is at ${debtHours}h — at this level, reaction time and focus are measurably affected. Lock your wake time this weekend even if you went to bed late. What does your usual weekend sleep look like?`;
  }
}

async function buildStreakProactive(name, streakDays, setupData) {
  const prompt = `You are a Sleep Coach in the Pulse app. ${name || 'The user'} just hit a ${streakDays}-night tracking streak.

Use AFFIRMATION + CHALLENGE format:
1. Acknowledge the streak genuinely — connect it to why the data matters (not just praise).
2. Set one specific, achievable data-quality challenge for the next 3 nights.

2 sentences max. No emoji. Warm but grounded — not over-the-top.`;

  try {
    const completion = await openai.chat.completions.create({
      model: AI.REASONING_PRO, max_completion_tokens: 120,
      messages: [{ role: 'user', content: prompt }],
    });
    return completion.choices[0].message.content.trim();
  } catch (err) {
    log.error('[sleep.agent] buildStreakProactive LLM:', err.message);
    return `${streakDays} nights in — that's ${streakDays} real data points I'm building your pattern from. Next challenge: log within 30 minutes of waking for the next 3 nights.`;
  }
}

async function buildBedtimePrepNotification(name, bedtime, setupData) {
  const targetWake = setupData.target_wake_time || '07:00';
  const debt       = setupData._debt || 0;

  const prompt = `You are a Sleep Coach. ${name || 'The user'} has a target bedtime of ${bedtime}. It is now 60 minutes before that.
${debt > 0 ? `They have ${debt}h of sleep debt this week.` : ''}
Target wake time: ${minsToDisplay(timeToMins(targetWake))}.

Write a 60-minute bedtime prep nudge. 1-2 sentences.
Rules:
- Name one specific thing to do NOW (not "wind down") — e.g. "Phones out of the bedroom" or "Drop room temp now"
- Mention their specific bedtime.
- No emoji. Direct.`;

  try {
    const completion = await openai.chat.completions.create({
      model: AI.REASONING_PRO, max_completion_tokens: 80,
      messages: [{ role: 'user', content: prompt }],
    });
    return completion.choices[0].message.content.trim();
  } catch (err) {
    log.error('[sleep.agent] buildBedtimePrepNotification LLM:', err.message);
    return `60 minutes to lights out at ${bedtime} — phones out of the bedroom now. Blue light suppresses melatonin for up to 90 minutes.`;
  }
}

async function buildMorningLogPrompt(name, wakeTime, setupData, lastNight) {
  const avgQ = setupData._avgQ || null;

  const prompt = `You are a Sleep Coach. ${name || 'The user'} should have woken at ${wakeTime}. Ask them to log last night.
${avgQ ? `Their recent average quality: ${avgQ}/5.` : ''}
${lastNight?.quality ? `Last logged night quality: ${lastNight.quality}/5.` : ''}

Write a morning log prompt. 1-2 sentences.
Rules:
- Reference last night or their pattern if data available.
- End with: "Log takes 30 seconds →" (keep this exact phrase).
- No "Good morning!". No emoji. Direct and specific.`;

  try {
    const completion = await openai.chat.completions.create({
      model: AI.REASONING_PRO, max_completion_tokens: 80,
      messages: [{ role: 'user', content: prompt }],
    });
    return completion.choices[0].message.content.trim();
  } catch (err) {
    log.error('[sleep.agent] buildMorningLogPrompt LLM:', err.message);
    return `How did last night go? Log takes 30 seconds →`;
  }
}

// ═══════════════════════════════════════════════════════════════
// ─── CONTEXT BUILDER — full sleep context for chat AI ─────────
// ═══════════════════════════════════════════════════════════════

async function buildContext(deviceId) {
  const [sleepSnap, profileSnap, recentLogsSnap, recentActionsSnap] = await Promise.all([
    sleepDoc(deviceId).get(),
    userDoc(deviceId).get(),
    logsCol(deviceId).orderBy('logged_at', 'desc').limit(30).get(),
    actionsCol(deviceId).where('status', '==', 'active').get(),
  ]);

  const setup      = sleepSnap.exists    ? sleepSnap.data()    : {};
  const profile    = profileSnap.exists  ? profileSnap.data()  : {};
  const logs       = recentLogsSnap.docs.map(d => d.data()).reverse(); // oldest→newest
  const allActions = recentActionsSnap.docs.map(d => d.data());

  const name        = profile.name || 'there';
  const daysLogged  = new Set(logs.map(l => l.date_str)).size;
  const totalCount  = setup.log_count || 0;
  const targetHrs   = setup.target_hours || 7.5;

  // ── 1. Core sleep metrics ──────────────────────────────────────
  const last7  = logs.slice(-7);
  const last14 = logs.slice(-14);

  const avgDuration  = last7.length ? (last7.reduce((s, l) => s + (l.total_sleep_hours || 0), 0) / last7.length).toFixed(1) : null;
  const avgQuality   = last7.length ? (last7.reduce((s, l) => s + (l.sleep_quality || 3), 0) / last7.length).toFixed(1) : null;
  const avgEfficiency= last7.length ? Math.round(last7.reduce((s, l) => s + (l.sleep_efficiency || 0), 0) / last7.length) : null;
  const avgEnergy    = last7.length ? (last7.reduce((s, l) => s + (l.morning_energy || 3), 0) / last7.length).toFixed(1) : null;
  const debt         = calcSleepDebt(last7, targetHrs);
  const consistency  = calcConsistency(last7);

  // ── 2. Trajectory ──────────────────────────────────────────────
  let qualityTrajectory = 'insufficient data';
  if (last14.length >= 6) {
    const first7 = last14.slice(0, 7);
    const second7= last14.slice(7);
    const f7avg  = first7.reduce((s, l) => s + (l.sleep_quality || 3), 0) / first7.length;
    const s7avg  = second7.length ? second7.reduce((s, l) => s + (l.sleep_quality || 3), 0) / second7.length : f7avg;
    const diff   = s7avg - f7avg;
    if (diff > 0.3) qualityTrajectory = `IMPROVING (+${diff.toFixed(1)} quality over last 14 nights)`;
    else if (diff < -0.3) qualityTrajectory = `DECLINING (${diff.toFixed(1)} quality over last 14 nights)`;
    else qualityTrajectory = `STABLE (consistent over last 14 nights)`;
  }

  // ── 3. Disruptor frequency analysis ───────────────────────────
  const disruptorCounts = {};
  logs.forEach(l => {
    (l.disruptors || []).forEach(d => {
      disruptorCounts[d] = (disruptorCounts[d] || 0) + 1;
    });
  });
  const n = logs.length || 1;
  const topDisruptors = Object.entries(disruptorCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([k, v]) => `${k} (${v}/${n} nights, ${Math.round(v/n*100)}%)`);

  // ── 4. Day-of-week quality pattern ────────────────────────────
  const dowQuality = {};
  logs.forEach(l => {
    if (!l.date_str) return;
    const d   = new Date(l.date_str + 'T12:00:00');
    const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
    if (!dowQuality[dow]) dowQuality[dow] = [];
    dowQuality[dow].push(l.sleep_quality || 3);
  });
  const dowAvgs = Object.entries(dowQuality)
    .filter(([, v]) => v.length >= 2)
    .map(([day, scores]) => ({ day, avg: scores.reduce((s, v) => s + v, 0) / scores.length }))
    .sort((a, b) => a.avg - b.avg);
  const worstNight = dowAvgs.length ? `${dowAvgs[0].day} (avg ${dowAvgs[0].avg.toFixed(1)}/5)` : null;
  const bestNight  = dowAvgs.length ? `${dowAvgs[dowAvgs.length-1].day} (avg ${dowAvgs[dowAvgs.length-1].avg.toFixed(1)}/5)` : null;

  // ── 5. Efficiency/quality correlation with disruptors ─────────
  const disruptorEffMap = {};
  logs.forEach(l => {
    (l.disruptors || []).forEach(d => {
      if (!disruptorEffMap[d]) disruptorEffMap[d] = [];
      disruptorEffMap[d].push(l.sleep_quality || 3);
    });
  });
  const worstDisruptor = Object.entries(disruptorEffMap)
    .filter(([, v]) => v.length >= 2)
    .map(([d, scores]) => ({ d, avg: scores.reduce((s, v) => s + v, 0) / scores.length }))
    .sort((a, b) => a.avg - b.avg)[0];

  // ── 6. Recent logs (last 5 — verbatim) ────────────────────────
  const last5 = logs.slice(-5);
  const last5Str = last5.map(l =>
    `  ${l.date_str}: bed=${l.bedtime} wake=${l.wake_time} ` +
    `sleep=${l.total_sleep_hours?.toFixed(1)}h eff=${l.sleep_efficiency}% ` +
    `quality=${l.sleep_quality}/5 energy=${l.morning_energy}/5 latency=${l.sleep_latency}min wakings=${l.night_wakings}` +
    (l.disruptors?.length ? ` disruptors=[${l.disruptors.join(', ')}]` : '') +
    (l.note ? ` note="${l.note}"` : '')
  ).join('\n');

  // ── 7. Tonight's context + date disambiguation ───────────────
  const now        = new Date();
  const dayName    = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getDay()];
  const hour       = now.getHours();
  const timeLabel  = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'night';

  const todayStr     = dateStr(now);
  const yesterdayD   = new Date(now); yesterdayD.setDate(yesterdayD.getDate() - 1);
  const yesterdayStr = dateStr(yesterdayD);

  // Build quick date→log lookup
  const logByDate = {};
  logs.forEach(l => {
    if (!logByDate[l.date_str] || (l.sleep_quality || 0) > (logByDate[l.date_str].sleep_quality || 0))
      logByDate[l.date_str] = l;
  });

  const todayLog     = logByDate[todayStr];
  const yesterdayLog = logByDate[yesterdayStr];

  const lastLog         = logs[logs.length - 1];
  const lastLogDate     = lastLog ? new Date(lastLog.date_str + 'T12:00:00') : null;
  const daysSinceLastLog= lastLogDate ? Math.round((now - lastLogDate) / 86400000) : null;
  const lastLogAgeStr   = daysSinceLastLog === null ? 'no logs yet'
    : daysSinceLastLog === 0 ? 'today'
    : daysSinceLastLog === 1 ? 'yesterday'
    : `${daysSinceLastLog} nights ago`;

  const fmtLog = (l) => l
    ? `LOGGED — ${l.total_sleep_hours?.toFixed(1)}h sleep, ${l.sleep_efficiency}% efficiency, quality ${l.sleep_quality}/5, energy ${l.morning_energy}/5`
    : 'NOT LOGGED — no data exists for this date';

  // ── 8. Pre-computed insights ──────────────────────────────────
  const insights = [];
  if (worstDisruptor && worstDisruptor.avg < 2.5) {
    insights.push(`When "${worstDisruptor.d}" is present, their quality drops to ${worstDisruptor.avg.toFixed(1)}/5 — their worst disruptor by impact.`);
  }
  if (consistency && consistency.score < 50) {
    insights.push(`Bedtime consistency score is only ${consistency.score}/100 (±${consistency.std_dev_mins} min variance) — this is the biggest lever to fix.`);
  }
  if (debt >= 3) {
    insights.push(`7-day sleep debt is ${debt}h — they're running a chronic deficit against their ${targetHrs}h target.`);
  }
  if (avgEfficiency !== null && avgEfficiency < 80) {
    insights.push(`Sleep efficiency is ${avgEfficiency}% — below the 85% CBT-I threshold. Spending less time in bed (sleep restriction) would consolidate sleep and rebuild efficiency.`);
  }
  if (worstNight) {
    insights.push(`${worstNight} is their worst night by quality — worth exploring what's different about that day.`);
  }

  // ── 9. Active actions ─────────────────────────────────────────
  const activeActs    = allActions.filter(a => a.status === 'active');
  const activeActsStr = activeActs.length
    ? activeActs.map(a => `  • ${a.text} [${a.when_to_do || 'anytime'}]`).join('\n')
    : '  none currently active';

  // ── 10. Notes they've written ─────────────────────────────────
  const notesStr = logs
    .filter(l => l.note && l.note.trim().length > 5)
    .slice(-6)
    .map(l => `  [${l.date_str}] "${l.note}"`)
    .join('\n');

  // First-time user: zero logs → different goal entirely
  if (totalCount === 0) {
    return `You are the Sleep Coach in Pulse. This is ${name || 'this person'}'s very first message — they have not logged a single night yet.

YOUR ONLY GOAL: Show them that this coach understands sleep science deeply and is worth talking to. Make them want to log tonight.

Rules:
- Do NOT mention data they don't have. Do NOT say "once you log some nights" or "after a few nights."
- Show you understand sleep problems at a clinical level. Reference CBT-I, sleep pressure, or circadian timing briefly — enough to signal expertise.
- Ask ONE specific question about their biggest sleep struggle. Classify by type: (1) can't fall asleep, (2) wake in the night, (3) wake too early, (4) poor quality even with enough time, (5) inconsistent schedule. Ask which feels most like them.
- Warm but direct. 2-3 sentences max. No filler openers.

What they told you at setup:
Primary problem: ${setup.primary_problem || 'general sleep quality'}
Target sleep: ${setup.target_hours || 7.5}h/night
Self-reported disruptors: ${(setup.disruptors || []).join(', ') || 'not specified'}`;
  }

  return `You are the Sleep Coach in Pulse. You are a deeply personal AI coach — not a wellness chatbot, not a generic AI. You have been privately studying ${name}'s sleep data for ${daysLogged > 0 ? `${daysLogged} nights` : 'the beginning of their journey'} across ${totalCount} total logs. You know their sleep patterns in specific, numerical detail.

THE TEST: if your response could have been sent to any stranger who never logged a single night, you have failed. Every sentence must reflect their specific numbers, their specific patterns, their specific history.

You are trained in CBT-I (Cognitive Behavioral Therapy for Insomnia) — the first-line clinical treatment backed by 40+ years of research and endorsed by the AASM. You understand sleep pressure, circadian alignment, sleep efficiency, sleep restriction therapy, and stimulus control. But you apply these to THIS person's exact numbers — not as abstract concepts.

COACHING VOICE EXAMPLES (study these):
❌ "Based on your data, I can see that your sleep efficiency has been below the optimal threshold. I'd recommend..."
✓ "71% efficiency — you're spending nearly a third of your time in bed awake. That's the number to move."

❌ "Great question! Sleep debt occurs when you get less sleep than your body needs..."
✓ "You're carrying 4.2 hours of debt this week. That's not a feeling — it's a measurable cognitive drag."

❌ "I understand you're frustrated. It can be challenging when sleep doesn't come easily..."
✓ "Three bad nights in a row, with racing mind showing up in all of them. That's a pattern, not bad luck."

━━━ WHO THEY ARE ━━━
Name: ${name}
Age group: ${profile.age_group || 'not specified'}
Chronotype: ${setup.chronotype || 'not specified'}

━━━ WHAT THEY TOLD YOU AT SETUP ━━━
Primary sleep problem: ${setup.primary_problem || 'general sleep quality'}
Target bedtime: ${minsToDisplay(timeToMins(setup.target_bedtime || '23:00'))}
Target wake time: ${minsToDisplay(timeToMins(setup.target_wake_time || '07:00'))}
Target sleep: ${setup.target_hours || 7.5}h/night
Sleep disruptors (self-reported): ${(setup.disruptors || []).join(', ') || 'not specified'}
What they've tried: ${(setup.past_attempts || []).join(', ') || 'nothing specified'}
Discussion topics they want to explore: ${(setup.discussion_topics || []).join(', ') || 'general sleep improvement'}

━━━ CURRENT SLEEP METRICS (last 7 nights) ━━━
Avg duration: ${avgDuration ? `${avgDuration}h` : 'not enough data'} (target: ${targetHrs}h)
Avg quality: ${avgQuality ? `${avgQuality}/5` : 'not enough data'}
Avg efficiency: ${avgEfficiency !== null ? `${avgEfficiency}%` : 'not enough data'} (target ≥ 85%)
Avg morning energy: ${avgEnergy ? `${avgEnergy}/5` : 'not enough data'}
7-day sleep debt: ${debt >= 0 ? `+${debt}h owed` : `${Math.abs(debt)}h banked`}
Bedtime consistency: ${consistency ? `${consistency.score}/100 (±${consistency.std_dev_mins}min variance)` : 'not enough data'}
Quality trajectory: ${qualityTrajectory}

━━━ DATE AWARENESS (critical — read before answering any question about "last night" or "today") ━━━
Today's date: ${todayStr} (${dayName}, ${timeLabel})
Last night (${yesterdayStr}): ${fmtLog(yesterdayLog)}
Today (${todayStr}): ${fmtLog(todayLog)}
Last logged night: ${lastLog ? `${lastLog.date_str} — ${lastLogAgeStr} — quality ${lastLog.sleep_quality}/5, ${lastLog.total_sleep_hours?.toFixed(1)}h, ${lastLog.sleep_efficiency}% eff` : 'none yet'}

━━━ LAST 5 LOGS (VERBATIM — reference these directly) ━━━
${last5Str || '  no logs yet'}

━━━ DISRUPTOR PATTERNS (all ${totalCount} logs) ━━━
${topDisruptors.join('\n') || '  no disruptor patterns yet'}
${worstNight ? `Worst night of week: ${worstNight}` : ''}
${bestNight  ? `Best night of week:  ${bestNight}` : ''}

━━━ WHAT THE DATA IS TELLING YOU (PRE-COMPUTED INSIGHTS) ━━━
${insights.length ? insights.map(i => `• ${i}`).join('\n') : '• Not enough data for pattern insights yet — keep observing.'}

━━━ THEIR WORDS (notes they wrote) ━━━
${notesStr || '  no personal notes yet'}

━━━ ACTIVE SLEEP ACTIONS ━━━
${activeActsStr}

━━━ INTENT — classify first, then respond ━━━
VENTING ("worst night ever", "can't sleep", "so exhausted", "so tired"):
  → Lead with 1 sentence that mirrors exactly what they said. Don't pivot to data yet. Ask "what was the worst part?"

PATTERN QUESTION ("why do I wake at 3am", "why is my efficiency low", "what's causing this"):
  → Answer with their exact number, not a definition. "Your efficiency is 71% — that means you're spending 29% of your time in bed awake." Then the specific cause from their data. Then one action.

PROGRESS CHECK ("am I improving", "is this better", "how am I doing"):
  → Pull actual week-over-week delta first. "Your efficiency moved from X% to Y% — that's a real shift." Don't hedge if the data is clear.

ACTION REQUEST ("what should I do tonight", "give me a plan", "what can I try"):
  → 2-3 numbered steps ONLY — no prose. Make each step specific to their numbers. Lead with the counterintuitive one.

CASUAL CHECK-IN ("any updates", "what are you seeing", "thoughts"):
  → Surface the ONE thing in their data they probably haven't noticed. Something that would make them say "huh, I didn't realise that." Not a summary.

GIVING UP / FRUSTRATED ("nothing works", "I've tried everything", "pointless", "don't know why I bother"):
  → Full presence first — name what they've actually tried. Then one sharp reframe grounded in their specific data. No toxic positivity.

CHRONIC SIGNAL ("been years", "always been like this", "never sleep well"):
  → Acknowledge the weight of it. Briefly mention CBT-I is the clinical gold standard with 80% success rates. Then pick ONE specific thing from their data to start with — not a list.

METRIC DEFINITION ("what is sleep efficiency", "what does consistency mean", "explain debt"):
  → One sentence definition maximum. Immediately anchor to their exact number. Then what it means for them specifically.

━━━ YOUR COACHING RULES ━━━
VOICE: You are a sharp, warm coach — not a therapist, not a wellness app, not a textbook. You have studied their chart. You have opinions based on their data.

NEVER start a message with: "Great", "Of course", "Sure", "I understand", "I can see that", "Based on your data", "Looking at your data", "That's a great question", "I see", "Absolutely", "Definitely", "It sounds like". Start with the observation or the empathy — not a filler opener.

LEAD WITH THE SHARPEST THING: Pick the single most important or surprising thing in their data. Drop it first. Don't summarize all their stats — that's noise. One insight, delivered with confidence.

LENGTH: 2–3 sentences for emotional/venting messages. 3–5 sentences for analysis. If they ask for a plan: numbered steps only, max 4. Never exceed 140 words. Short messages feel more personal.

FORMAT: Prose always, unless they ask for a plan (then numbered steps). No bullet points in conversational responses — bullets feel like a Wikipedia article, not a coach.

DATA RULES:
1. Every response cites at least one of their real numbers.
2. Efficiency < 85%? The CBT-I fix is LESS time in bed, not more. Say this clearly — most people get it backwards.
3. Sleep debt? Never "catch up on weekends" — that destroys circadian rhythm. Lock wake time, add 30min TIB for 3 nights max.
4. Consistency score < 60? This beats everything else. Bedtime variance causes more damage than late bedtime.
5. Never fabricate a trend. If uncertain: "I want 2-3 more nights before I name this — but I'm watching something."
6. End with ONE question unless they're venting and need to feel heard (then no question).
7. Current moment: ${dayName} ${timeLabel}. Evening or night = make advice actionable tonight specifically.
8. DATE RULE — CRITICAL: "last night" always means ${yesterdayStr}. Check the DATE AWARENESS section above. If last night (${yesterdayStr}) is NOT LOGGED, say explicitly "You haven't logged last night yet" — NEVER present a different date's log as "last night". If they ask about last night with no data, offer to estimate from how they feel OR prompt them to log it. "Last logged" ≠ "last night" unless the date matches.`;
}

// ═══════════════════════════════════════════════════════════════
// ─── STATS COMPUTATION ────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

function computeStats(allLogs, setupData) {
  const total = allLogs.length;
  if (!total) return { total_logs: 0, days_logged: 0 };

  const targetHrs = setupData?.target_hours || 7.5;

  // Group by date (one log per night, but handle edge cases)
  const byDate = {};
  allLogs.forEach(l => {
    const d = l.date_str;
    if (!byDate[d] || (l.sleep_quality || 0) > (byDate[d].sleep_quality || 0)) {
      byDate[d] = l; // keep the best quality log per day if dupes exist
    }
  });
  const sortedDates = Object.keys(byDate).sort();
  const daysLogged  = sortedDates.length;

  // Current streak
  let streak = 0;
  const checkDate = new Date();
  for (let i = 0; i < 90; i++) {
    const ds = dateStr(checkDate);
    if (byDate[ds]) { streak++; }
    else if (i === 0) {
      checkDate.setDate(checkDate.getDate() - 1);
      if (byDate[dateStr(checkDate)]) { streak++; } else break;
    } else { break; }
    checkDate.setDate(checkDate.getDate() - 1);
  }

  // Longest streak
  let longest = 1, run = 1;
  for (let i = 1; i < sortedDates.length; i++) {
    const diff = (new Date(sortedDates[i] + 'T12:00:00') - new Date(sortedDates[i-1] + 'T12:00:00')) / 86400000;
    run = diff === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  longest = Math.max(longest, streak);

  // Averages
  const logs = Object.values(byDate);
  const avgDuration   = parseFloat((logs.reduce((s, l) => s + (l.total_sleep_hours || 0), 0) / logs.length).toFixed(2));
  const avgQuality    = parseFloat((logs.reduce((s, l) => s + (l.sleep_quality || 3), 0) / logs.length).toFixed(2));
  const avgEfficiency = Math.round(logs.reduce((s, l) => s + (l.sleep_efficiency || 0), 0) / logs.length);
  const avgEnergy     = parseFloat((logs.reduce((s, l) => s + (l.morning_energy || 3), 0) / logs.length).toFixed(2));
  const avgLatency    = Math.round(logs.reduce((s, l) => s + (l.sleep_latency || 0), 0) / logs.length);

  // Sleep debt (7-day rolling)
  const last7 = logs.slice(-7);
  const sleepDebt = calcSleepDebt(last7, targetHrs);

  // Consistency
  const consistency = calcConsistency(last7);

  // Last 30 days for chart
  const daily_logs = [];
  for (let i = 29; i >= 0; i--) {
    const d  = new Date(); d.setDate(d.getDate() - i);
    const ds = dateStr(d);
    const log = byDate[ds];
    daily_logs.push({
      date:        ds,
      quality:     log?.sleep_quality     || null,
      duration:    log?.total_sleep_hours || null,
      efficiency:  log?.sleep_efficiency  || null,
      energy:      log?.morning_energy    || null,
      has_log:     !!log,
    });
  }

  // Top disruptors
  const disruptorCounts = {};
  logs.forEach(l => {
    (l.disruptors || []).forEach(d => { disruptorCounts[d] = (disruptorCounts[d] || 0) + 1; });
  });
  const top_disruptors = Object.entries(disruptorCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([name, count]) => ({ name, count, pct: Math.round(count/logs.length*100) }));

  return {
    total_logs:      total,
    days_logged:     daysLogged,
    current_streak:  streak,
    longest_streak:  longest,
    avg_duration:    avgDuration,
    avg_quality:     avgQuality,
    avg_efficiency:  avgEfficiency,
    avg_energy:      avgEnergy,
    avg_latency:     avgLatency,
    sleep_debt:      sleepDebt,
    consistency:     consistency,
    target_hours:    targetHrs,
    daily_logs,
    top_disruptors,
  };
}

function determineStage(stats) {
  if (!stats || stats.total_logs === 0) return 0;
  if (stats.total_logs < 3)  return 1;
  if (stats.total_logs < 7)  return 2;
  if (stats.total_logs < 14) return 3;
  return 4;
}

// ─── Build chart signal points (one point per unique night) ──
// range controls granularity: 7/30 → daily, 90 → weekly avg, 365/all → monthly avg
function buildSignalPoints(allLogs, range = 'all') {
  const byDay = {};
  allLogs.forEach(l => {
    const d = l.date_str;
    if (!byDay[d] || (l.sleep_quality || 0) > (byDay[d].sleep_quality || 0)) byDay[d] = l;
  });
  const sortedDays = Object.keys(byDay).sort();
  if (!sortedDays.length) return [];

  const toPoint = (ds, entries) => {
    const n   = entries.length;
    const avg = (field, def) => parseFloat((entries.reduce((s, e) => s + (e[field] || def), 0) / n).toFixed(1));
    const d   = new Date(ds + 'T12:00:00');
    const sleepQuality    = avg('sleep_quality', 3);
    const totalSleepHours = avg('total_sleep_hours', 0);
    return {
      date_str:          ds,
      label:             d.toLocaleDateString('en', { month: 'short', day: 'numeric' }),
      sleep_quality:     sleepQuality,
      total_sleep_hours: totalSleepHours,
      hours:             totalSleepHours,
      quality:           sleepQuality,
      sleep_efficiency:  Math.round(entries.reduce((s, e) => s + (e.sleep_efficiency || 0), 0) / n),
      morning_energy:    avg('morning_energy', 3),
      disruptors:        [],
    };
  };

  // 7D and 30D: one point per night (daily resolution)
  if (range === '7' || range === '30') {
    return sortedDays.map(ds => toPoint(ds, [byDay[ds]]));
  }

  // 90D: aggregate into weekly buckets (Mon–Sun), ~13 points max
  if (range === '90') {
    const weeks = {};
    sortedDays.forEach(ds => {
      const d = new Date(ds + 'T12:00:00');
      const mon = new Date(d); mon.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
      const wKey = dateStr(mon);
      if (!weeks[wKey]) weeks[wKey] = [];
      weeks[wKey].push(byDay[ds]);
    });
    return Object.keys(weeks).sort().map(wKey => toPoint(wKey, weeks[wKey]));
  }

  // 365D and ALL: aggregate into monthly buckets, ~12–N points
  const months = {};
  sortedDays.forEach(ds => {
    const mKey = ds.substring(0, 7); // "YYYY-MM"
    if (!months[mKey]) months[mKey] = [];
    months[mKey].push(byDay[ds]);
  });
  return Object.keys(months).sort().map(mKey => {
    const d   = new Date(mKey + '-15T12:00:00');
    const pt  = toPoint(mKey + '-01', months[mKey]);
    pt.label  = d.toLocaleDateString('en', { month: 'short', year: '2-digit' });
    return pt;
  });
}

// ─── Recent timeline (last 10 unique nights) ─────────────────
function buildRecentTimeline(allLogs) {
  const sorted = [...allLogs].sort((a, b) => (b.date_str > a.date_str ? 1 : -1));
  const seen   = new Set();
  const result = [];
  for (const log of sorted) {
    if (seen.has(log.date_str)) continue;
    if (result.length >= 10) break;
    seen.add(log.date_str);
    result.push({
      date_str:          log.date_str,
      bedtime:           log.bedtime,
      wake_time:         log.wake_time,
      sleep_quality:     log.sleep_quality,
      total_sleep_hours: log.total_sleep_hours,
      sleep_efficiency:  log.sleep_efficiency,
      morning_energy:    log.morning_energy,
      disruptors:        log.disruptors || [],
      note:              log.note || '',
    });
  }
  return result;
}

// ─── Observation cards ────────────────────────────────────────
function buildObservations(setupData, stats, signalPoints) {
  const obs = [];
  if (!stats || stats.total_logs < 2) return obs;

  const { avg_efficiency, avg_quality, avg_duration, target_hours, sleep_debt, consistency, top_disruptors } = stats;

  if (avg_efficiency !== null && avg_efficiency < 80) {
    obs.push({
      type:  'efficiency_low',
      icon:  '◎',
      title: `${avg_efficiency}% sleep efficiency`,
      body:  'Below the 85% CBT-I target. Your body is spending more time in bed than sleeping. Reducing time in bed (sleep restriction) rebuilds sleep pressure and efficiency.',
      severity: 'high',
    });
  } else if (avg_efficiency >= 85) {
    obs.push({
      type:  'efficiency_good',
      icon:  '◉',
      title: `${avg_efficiency}% efficiency — on target`,
      body:  'Your time in bed is converting to actual sleep well. Keep the schedule consistent.',
      severity: 'positive',
    });
  }

  if (sleep_debt !== null && sleep_debt >= 2) {
    obs.push({
      type:  'sleep_debt',
      icon:  '↓',
      title: `${sleep_debt}h sleep debt (7-day)`,
      body:  `You're averaging ${avg_duration?.toFixed(1)}h vs your ${target_hours}h target. Debt accumulates daily — it doesn't reset on weekends.`,
      severity: 'high',
    });
  }

  if (consistency && consistency.score < 55) {
    obs.push({
      type:  'consistency',
      icon:  '⟳',
      title: `Bedtime varies by ±${consistency.std_dev_mins} min`,
      body:  'High variance is the #1 circadian disruptor. A fixed wake time — even on weekends — is more powerful than an earlier bedtime.',
      severity: 'high',
    });
  } else if (consistency && consistency.score >= 80) {
    obs.push({
      type:  'consistency_good',
      icon:  '✓',
      title: `Consistency score: ${consistency.score}/100`,
      body:  'Your sleep schedule is locked in. This is the single strongest foundation for sleep quality.',
      severity: 'positive',
    });
  }

  if (top_disruptors?.length) {
    const top = top_disruptors[0];
    obs.push({
      type:  'top_disruptor',
      icon:  '!',
      title: `"${top.name}" in ${top.pct}% of nights`,
      body:  `Your most frequent disruptor. Every night it appears, your quality and efficiency data reflect it.`,
      severity: 'medium',
    });
  }

  // Trajectory: compare first half vs second half of signal points (need 7+)
  if (signalPoints.length >= 7) {
    const mid       = Math.floor(signalPoints.length / 2);
    const firstHalf = signalPoints.slice(0, mid);
    const secHalf   = signalPoints.slice(mid);
    const fAvg = firstHalf.reduce((s, p) => s + (p.sleep_quality || 3), 0) / firstHalf.length;
    const sAvg = secHalf.reduce((s, p) => s + (p.sleep_quality || 3), 0) / secHalf.length;
    const diff = sAvg - fAvg;
    if (diff > 0.3) {
      obs.push({
        type:     'trajectory_up',
        icon:     '↑',
        title:    `Quality improving (+${diff.toFixed(1)} over ${signalPoints.length} nights)`,
        body:     'Your sleep is trending in the right direction. Consistency is the key to locking this in.',
        severity: 'positive',
      });
    } else if (diff < -0.3) {
      obs.push({
        type:     'trajectory_down',
        icon:     '↓',
        title:    `Quality declining (${diff.toFixed(1)} over ${signalPoints.length} nights)`,
        body:     'Something has shifted. Check your recent logs — disruptors, schedule changes, or stress are likely causes.',
        severity: 'high',
      });
    }
  }

  return obs.slice(0, 5);
}

// ─── Correlation bars ─────────────────────────────────────────
function buildCorrelationBars(setupData, stats, allLogs) {
  if (!allLogs || allLogs.length < 3) return [];

  const byDay = {};
  allLogs.forEach(l => {
    const d = l.date_str;
    if (!byDay[d]) byDay[d] = l;
  });
  const logs = Object.values(byDay);

  // Quality when disruptor present vs absent
  const disruptorCounts = {};
  logs.forEach(l => (l.disruptors || []).forEach(d => { disruptorCounts[d] = (disruptorCounts[d] || 0) + 1; }));
  const topD = Object.entries(disruptorCounts).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([d]) => d);

  const bars = topD.map(disruptor => {
    const withD    = logs.filter(l => (l.disruptors || []).includes(disruptor));
    const withoutD = logs.filter(l => !(l.disruptors || []).includes(disruptor));
    const avgWith  = withD.length    ? withD.reduce((s, l) => s + (l.sleep_quality || 3), 0) / withD.length    : null;
    const avgWout  = withoutD.length ? withoutD.reduce((s, l) => s + (l.sleep_quality || 3), 0) / withoutD.length : null;
    if (avgWith === null || avgWout === null) return null;
    return {
      label:        disruptor,
      with_avg:     parseFloat(avgWith.toFixed(1)),
      without_avg:  parseFloat(avgWout.toFixed(1)),
      impact:       parseFloat((avgWout - avgWith).toFixed(1)),
      nights:       withD.length,
    };
  }).filter(Boolean).sort((a, b) => b.impact - a.impact);

  return bars;
}

// ─── AI analysis insight ──────────────────────────────────────
async function generateAnalysisInsight(setupData, stats, stage, allLogs) {
  const { avg_duration, avg_quality, avg_efficiency, sleep_debt, consistency, top_disruptors, current_streak, avg_energy } = stats;

  const prompt = `You are a Sleep Coach AI analysing data for a user with the following stats:

Sleep stats:
- Avg duration: ${avg_duration?.toFixed(1)}h (target: ${setupData.target_hours || 7.5}h)
- Avg quality: ${avg_quality?.toFixed(1)}/5
- Avg efficiency: ${avg_efficiency}% (target ≥ 85%)
- Avg morning energy: ${avg_energy?.toFixed(1)}/5
- 7-day sleep debt: ${sleep_debt}h
- Consistency: ${consistency ? `${consistency.score}/100 (±${consistency.std_dev_mins}min bedtime variance)` : 'not enough data'}
- Current streak: ${current_streak} nights
- Primary problem: ${setupData.primary_problem || 'sleep quality'}
- Top disruptors: ${top_disruptors?.map(d => d.name).join(', ') || 'none identified'}
- Data stage: ${stage} (1=early, 4=deep patterns visible)

Write TWO things:
1. "insight" — A 2-3 sentence sharp analysis of their sleep data. Reference their exact numbers. Identify the single most important thing the data is showing. If efficiency < 85%, mention sleep restriction therapy (CBT-I). If consistency is low, prioritise that. Make it feel like a coach who spent time with the numbers.
2. "formula" — A 10-12 word sentence that captures their personal sleep challenge pattern. Example: "Late bedtime variance + racing mind = efficiency below target."

Return ONLY valid JSON, no markdown:
{ "insight": "...", "formula": "..." }`;

  try {
    const completion = await openai.chat.completions.create({
      model: AI.REASONING_PRO, max_completion_tokens: 280,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw     = completion.choices[0].message.content.trim();
    const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    log.error('[sleep] analysis insight error:', err.message);
    return {
      insight: `You've logged ${stats.total_logs} nights. Average efficiency is ${avg_efficiency}% — ${avg_efficiency >= 85 ? 'above the CBT-I target of 85%' : 'below the 85% CBT-I target, which means sleep restriction therapy could help consolidate your sleep'}. Keep logging to surface deeper patterns.`,
      formula: `${setupData.primary_problem || 'Sleep quality'} — building your pattern baseline.`,
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// ─── NOTIFICATION CRON — 3 research-backed notification types ─
// Runs every 10 minutes. Each user gets max 2 proactive messages/day.
// Types (research basis — JMIR mHealth micro-randomised trial):
//   1. Morning log prompt  (wake_time + 20min) — 3.5× app-open rate
//   2. Bedtime prep nudge  (bedtime - 60min)   — habit anchoring
//   3. Mid-day insight     (11:00 AM)           — debt/pattern flag
// ═══════════════════════════════════════════════════════════════
const _sleepCronTick = async () => {
    const usersSnap = await db().collection('wellness_users')
      .where('sleep_setup_complete', '==', true).get();

    for (const userSnap of usersSnap.docs) {
      try {
        const deviceId  = userSnap.id;
        const uData     = userSnap.data();
        const pName     = uData.name || '';

        // Per-user notif context: language, utc_offset, notif_enabled, DND.
        // Reading here means every downstream decision uses the user's LOCAL
        // clock, not the server clock — fixes wrong-time-of-day notifs.
        const notifCtx = await getUserNotifContext(db(), deviceId);
        if (!notifCtx.allowsProactive) continue;
        const hour = notifCtx.localHour;
        const minute = notifCtx.localMinute;
        const today = notifCtx.localDateStr;

        const [sleepSnap, _profileSnap] = await Promise.all([
          sleepDoc(deviceId).get(),
          userDoc(deviceId).get(),
        ]);
        const sData = sleepSnap.data() || {};

        // Max 2 proactive messages per day across all types
        const todayCount = sData.proactive_count_today || 0;
        const lastCountDate = sData.proactive_count_date || '';
        const effectiveCount = lastCountDate === today ? todayCount : 0;
        if (effectiveCount >= 2) continue;

        const targetBed  = sData.target_bedtime   || '23:00';
        const targetWake = sData.target_wake_time  || '07:00';
        const targetHrs  = sData.target_hours      || 7.5;

        // Compute current-hour window in user's local time
        const currentMins = hour * 60 + minute;

        // ── 1. MORNING LOG PROMPT: within 20-40 min after wake time ──
        const wakeMins = timeToMins(targetWake);
        const logWindowStart = wakeMins + 20;
        const logWindowEnd   = wakeMins + 40;
        const inMorningWindow = currentMins >= logWindowStart && currentMins < logWindowEnd;

        if (inMorningWindow && sData.last_morning_prompt_date !== today) {
          // Skip if already logged today
          const todayLogSnap = await logsCol(deviceId).where('date_str', '==', today).limit(1).get();
          if (todayLogSnap.empty) {
            const recentLogsSnap = await logsCol(deviceId).orderBy('logged_at', 'desc').limit(5).get();
            const recentLogs     = recentLogsSnap.docs.map(d => d.data());
            const avgQ = recentLogs.length
              ? parseFloat((recentLogs.reduce((s,l)=>s+(l.sleep_quality||3),0)/recentLogs.length).toFixed(1))
              : null;
            const lastNight = recentLogs[0] || null;
            sData._avgQ = avgQ;

            const msg = await buildMorningLogPrompt(pName, minsToDisplay(wakeMins), sData, lastNight);
            await chatsCol(deviceId).add({
              role: 'assistant', content: msg,
              is_proactive: true, proactive_type: 'morning_log_prompt',
              is_read: false, created_at: admin.firestore.FieldValue.serverTimestamp(),
            });
            await sleepDoc(deviceId).update({
              last_morning_prompt_date: today,
              proactive_count_today: effectiveCount + 1,
              proactive_count_date: today,
            });
            continue; // one notification per cron tick per user
          }
        }

        // ── 2. BEDTIME PREP: 55-65 min before target bedtime ──
        let bedMinsNorm = timeToMins(targetBed);
        if (bedMinsNorm < 300) bedMinsNorm += 1440; // midnight-crosser
        let currentMinsNorm = currentMins;
        if (currentMins < 300 && bedMinsNorm > 1200) currentMinsNorm += 1440;
        const minsUntilBed = bedMinsNorm - currentMinsNorm;

        if (minsUntilBed >= 55 && minsUntilBed < 65 && sData.last_bedtime_prep_date !== today) {
          const recentLogsSnap = await logsCol(deviceId).orderBy('logged_at', 'desc').limit(7).get();
          const recentLogs     = recentLogsSnap.docs.map(d => d.data());
          const debt = calcSleepDebt([...recentLogs].reverse(), targetHrs);
          sData._debt = debt > 0 ? parseFloat(debt.toFixed(1)) : 0;

          const msg = await buildBedtimePrepNotification(pName, minsToDisplay(timeToMins(targetBed)), sData);
          await chatsCol(deviceId).add({
            role: 'assistant', content: msg,
            is_proactive: true, proactive_type: 'bedtime_prep',
            is_read: false, created_at: admin.firestore.FieldValue.serverTimestamp(),
          });
          await sleepDoc(deviceId).update({
            last_bedtime_prep_date: today,
            proactive_count_today: effectiveCount + 1,
            proactive_count_date: today,
          });
          continue;
        }

        // ── 3. MID-DAY INSIGHT: 11:00 AM, only if debt > 2h ──
        if (hour === 11 && minute < 10 && sData.last_proactive_date !== today) {
          const recentLogsSnap = await logsCol(deviceId).orderBy('logged_at', 'desc').limit(7).get();
          const recentLogs     = recentLogsSnap.docs.map(d => d.data());
          const debt = calcSleepDebt([...recentLogs].reverse(), targetHrs);

          if (debt >= 2) {
            const severity = debt >= 4 ? 'urgent' : 'mild';
            const msg = await buildDebtProactive(pName, parseFloat(debt.toFixed(1)), targetHrs, recentLogs, sData, severity);
            await chatsCol(deviceId).add({
              role: 'assistant', content: msg,
              is_proactive: true, proactive_type: 'midday_insight',
              is_read: false, created_at: admin.firestore.FieldValue.serverTimestamp(),
            });
            await sleepDoc(deviceId).update({
              last_proactive_date: today,
              proactive_count_today: effectiveCount + 1,
              proactive_count_date: today,
            });
          }
        }

      } catch (err) {
        log.error('[sleep] cron user error:', err.message);
      }
    }
};

if (shouldRunCron()) {
  cron.schedule('*/10 * * * *', withCron('sleep:notifications', _sleepCronTick, {
    ttlMs: 9 * 60_000,                  // < cron interval — never overlaps with next tick
  }));
}

// Pre-warm /analysis cache for active users every night at 02:30.
async function preWarmSleepAnalysisV2() {
  const usersSnap = await db().collection('wellness_users').limit(500).get();
  let warmed = 0;
  for (const u of usersSnap.docs) {
    const id = u.id;
    try {
      const checkSnap = await sleepDoc(id).collection('sleep_logs').limit(1).get();
      if (checkSnap.empty) continue;
      const { resolveUserLanguage } = require('./lib/i18n-prompt');
      const language = await resolveUserLanguage(db(), id);
      await sleepAnalytics.loadAnalysisV2(id, 30, { openai, language });
      warmed++;
    } catch { /* per-user non-fatal */ }
  }
  log.info(`[sleep:pre-warm] warmed=${warmed}/${usersSnap.size}`);
}
if (shouldRunCron()) {
  cron.schedule('30 2 * * *', withCron('sleep:pre-warm-v2', preWarmSleepAnalysisV2, {
    ttlMs: 20 * 60_000,
  }), { timezone: 'UTC' });
}

// ════════════════════════════════════════════════════════════════════
// VOICE DESCRIBE — audio → transcript → parsed sleep object.
// 4 routes mirror nutrition's proven /describe pipeline. Confirmation
// modal on FE handles gap-fill + edits before saving via /api/sleep/log.
// Audio bytes never persisted (transcribe → discard buffer).
// ════════════════════════════════════════════════════════════════════
const _sleepDescribeLocks = new Map();
function _acquireSleepDescribeLock(deviceId) {
  if (_sleepDescribeLocks.has(deviceId)) return false;
  _sleepDescribeLocks.set(deviceId, Date.now());
  return true;
}
function _releaseSleepDescribeLock(deviceId) {
  _sleepDescribeLocks.delete(deviceId);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of _sleepDescribeLocks.entries()) {
    if (now - t > 30_000) _sleepDescribeLocks.delete(k);
  }
}, 10_000).unref?.();

// GET /describe/dg-token — short-lived Deepgram token for live partials.
// Frontend gracefully falls back to Apple SFSpeechAnalyzer when 503.
router.get('/describe/dg-token', async (req, res) => {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) return res.status(503).json({ error: 'deepgram_not_configured' });
  try {
    const r = await fetch('https://api.deepgram.com/v1/auth/grant', {
      method: 'POST',
      headers: { 'Authorization': `Token ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl_seconds: 60 }),
    });
    if (!r.ok) {
      const txt = await r.text();
      return res.status(502).json({ error: 'deepgram_grant_failed', detail: txt });
    }
    const data = await r.json();
    res.json({ access_token: data.access_token, expires_in: data.expires_in || 60 });
  } catch (err) {
    log.error('[sleep] /describe/dg-token error:', err?.message);
    res.status(500).json({ error: 'dg_token_failed' });
  }
});

// POST /describe/preflight — instant text inspection (no LLM).
router.post('/describe/preflight', (req, res) => {
  try {
    const { text } = req.body || {};
    res.json(sleepDescribe.preflight(text));
  } catch (err) {
    res.status(500).json({ error: 'preflight_failed' });
  }
});

// POST /describe/transcribe — audio → clean transcript only.
router.post('/describe/transcribe', async (req, res) => {
  const t0 = Date.now();
  try {
    const { audio_base64, audio_mime } = req.body || {};
    if (!audio_base64) return res.status(400).json({ error: 'audio_base64 required' });
    const transcript = await sleepDescribe.transcribeAudio(openai, audio_base64, audio_mime);
    if (!transcript) return res.status(400).json({ error: 'No speech detected' });
    res.json({ transcript, latency_ms: Date.now() - t0, model: AI.TRANSCRIBE });
  } catch (err) {
    log.error('[sleep] /describe/transcribe error:', err?.message);
    res.status(500).json({ error: err.message || 'Transcription failed' });
  }
});

// POST /describe — audio OR transcript → parsed sleep object with confidence.
router.post('/describe', async (req, res) => {
  const { deviceId } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  if (!_acquireSleepDescribeLock(deviceId)) {
    return res.status(429).json({ error: 'analyze_in_progress', message: 'Already analyzing — please wait.' });
  }
  const t0 = Date.now();
  try {
    const { audio_base64, audio_mime, transcript: providedTranscript } = req.body || {};
    if (!audio_base64 && !providedTranscript) {
      return res.status(400).json({ error: 'audio_base64 or transcript required' });
    }
    let transcript = (providedTranscript || '').trim();
    if (!transcript && audio_base64) {
      transcript = await sleepDescribe.transcribeAudio(openai, audio_base64, audio_mime);
    }
    if (!transcript) {
      return res.status(400).json({ error: 'Could not understand audio. Please try again.' });
    }
    const language = resolveLanguage(req);
    const parsed = await sleepDescribe.parseSleepText(openai, transcript, language);
    res.json({
      transcript,
      ...parsed,
      latency_ms: Date.now() - t0,
    });
  } catch (err) {
    log.error('[sleep] /describe error:', err?.message);
    res.status(500).json({ error: err.message || 'Describe failed' });
  } finally {
    _releaseSleepDescribeLock(deviceId);
  }
});

// ─── GET /wearable-insights ─────────────────────────────────────────────
// Additive layer: returns HK-derived cards for the Sleep Analysis tab's
// "Wearable Insights" section. Manual users / no-grants get
// { has_data: false, cards: [] } and the FE section auto-hides.
router.get('/wearable-insights', async (req, res) => {
  const deviceId = (req.query.deviceId || '').toString();
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  try {
    const { buildWearableInsights } = require('./lib/healthkit/wearable-insights');
    const days = Math.min(parseInt(req.query.days || '30', 10) || 30, 90);
    const payload = await buildWearableInsights({
      db: admin.firestore(), deviceId, coach: 'sleep', days,
    });
    res.json(payload);
  } catch (err) {
    res.json({ has_data: false, cards: [] });
  }
});

module.exports = router;
