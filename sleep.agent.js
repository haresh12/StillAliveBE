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
const router  = express.Router();
const admin   = require('firebase-admin');
const { OpenAI } = require('openai');
const cron    = require('node-cron');

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

    res.json({ success: true, actions: firstActions });
  } catch (err) {
    console.error('[sleep] /setup error:', err);
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
    console.error('[sleep] /setup-status error:', err);
    res.status(500).json({ error: 'Status check failed' });
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

    const today = logDate || dateStr();

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

    const logRef = await logsCol(deviceId).add(logData);

    // Read state BEFORE incrementing
    const sleepSnapBefore  = await sleepDoc(deviceId).get();
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
    let newActions = null;
    if (sinceLast >= 3) {
      const [recentLogsSnap, recentChatSnap, profileSnap] = await Promise.all([
        logsCol(deviceId).orderBy('logged_at', 'desc').limit(10).get(),
        chatsCol(deviceId).orderBy('created_at', 'desc').limit(10).get(),
        userDoc(deviceId).get(),
      ]);

      const recentLogs     = recentLogsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const recentChat     = recentChatSnap.docs.reverse().map(d => d.data());
      const profile        = profileSnap.exists ? profileSnap.data() : {};
      const recentlySkipped = (sleepDataBefore.skip_history || []).slice(-8);

      newActions = await generateActions({
        profile,
        setup:     sleepDataBefore,
        recentLogs,
        recentChat,
        recentlySkipped,
        isFirstGen: false,
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
    }

    // ── Poor quality proactive (1–2/5, max once per day) ──
    const lastPoorSleepDate = sleepDataBefore.last_poor_sleep_date;
    if ((sleep_quality || 3) <= 2 && lastPoorSleepDate !== today) {
      try {
        const [profileSnap, recentLogsSnap] = await Promise.all([
          userDoc(deviceId).get(),
          logsCol(deviceId).orderBy('logged_at', 'desc').limit(6).get(),
        ]);
        const pName    = profileSnap.exists ? (profileSnap.data().name || '') : '';
        const recent   = recentLogsSnap.docs.map(d => d.data());
        const poorMsg  = await buildPoorSleepProactive(
          pName, sleep_quality, disruptors || [], note || '', recent, sleepDataBefore
        );
        await chatsCol(deviceId).add({
          role:                  'assistant',
          content:               poorMsg,
          is_proactive:          true,
          proactive_type:        'poor_sleep',
          is_read:               false,
          triggered_by_log:      logRef.id,
          created_at:            admin.firestore.FieldValue.serverTimestamp(),
        });
        await sleepDoc(deviceId).update({ last_poor_sleep_date: today });
      } catch (err) {
        console.error('[sleep] poor sleep proactive error:', err.message);
      }
    }

    // ── Sleep debt alert (≥ 4 hours debt, not alerted today) ──
    try {
      const allLogsSnap = await logsCol(deviceId).orderBy('logged_at', 'desc').limit(7).get();
      const allLogs     = allLogsSnap.docs.map(d => d.data());
      const targetHours = sleepDataBefore.target_hours || 7.5;
      const debt        = calcSleepDebt(allLogs.reverse(), targetHours);
      const lastDebtAlert = sleepDataBefore.last_debt_alert_date;

      if (debt >= 2 && lastDebtAlert !== today) {
        const profileSnap = await userDoc(deviceId).get();
        const pName = profileSnap.exists ? (profileSnap.data().name || '') : '';
        const severity = debt >= 4 ? 'urgent' : 'mild';
        const debtMsg = await buildDebtProactive(pName, debt, targetHours, allLogs, sleepDataBefore, severity);
        await chatsCol(deviceId).add({
          role:           'assistant',
          content:        debtMsg,
          is_proactive:   true,
          proactive_type: 'sleep_debt',
          is_read:        false,
          created_at:     admin.firestore.FieldValue.serverTimestamp(),
        });
        await sleepDoc(deviceId).update({ last_debt_alert_date: today });
      }
    } catch (err) {
      console.error('[sleep] debt alert error:', err.message);
    }

    // ── Streak milestone proactive (3, 7, 14, 30 nights) ──
    const STREAK_MILESTONES = [3, 7, 14, 30];
    const logsForStreakSnap = await logsCol(deviceId)
      .orderBy('logged_at', 'desc').limit(40).get();
    const uniqueDates = [...new Set(logsForStreakSnap.docs.map(d => d.data().date_str))];
    let streakCount = 0;
    for (let i = 0; i < uniqueDates.length; i++) {
      const expected = dateStr(new Date(Date.now() - i * 86400000));
      if (uniqueDates[i] === expected) streakCount++;
      else break;
    }
    if (STREAK_MILESTONES.includes(streakCount) && sleepDataBefore.last_streak_celebrated !== streakCount) {
      const pSnap   = await userDoc(deviceId).get();
      const pName   = pSnap.exists ? (pSnap.data().name || '') : '';
      const streakMsg = await buildStreakProactive(pName, streakCount, sleepDataBefore);
      await chatsCol(deviceId).add({
        role:           'assistant',
        content:        streakMsg,
        is_proactive:   true,
        proactive_type: 'streak_milestone',
        is_read:        false,
        created_at:     admin.firestore.FieldValue.serverTimestamp(),
      });
      await sleepDoc(deviceId).update({ last_streak_celebrated: streakCount });
    }

    // Invalidate context cache — new log changes metrics the coach uses
    invalidateContextCache(deviceId);

    res.json({
      success:        true,
      id:             logRef.id,
      metrics: {
        time_in_bed:       parseFloat(timeInBed.toFixed(2)),
        total_sleep_hours: parseFloat(totalSleep.toFixed(2)),
        sleep_efficiency:  efficiency,
      },
      action_refresh: sinceLast >= 3,
      new_actions:    newActions,
    });
  } catch (err) {
    console.error('[sleep] /log error:', err);
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
    console.error('[sleep] /logs/dates error:', err);
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
    console.error('[sleep] /logs error:', err);
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
    console.error('[sleep] PATCH /log error:', err);
    res.status(500).json({ error: 'Update failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /actions
// ═══════════════════════════════════════════════════════════════
router.get('/actions', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const [activeSnap, recentSnap, sleepSnap] = await Promise.all([
      actionsCol(deviceId).where('status', '==', 'active').get(),
      actionsCol(deviceId).orderBy('generated_at', 'desc').limit(20).get(),
      sleepDoc(deviceId).get(),
    ]);

    const format = (action) => ({
      ...action,
      generated_at: toIsoString(action.generated_at),
      completed_at: toIsoString(action.completed_at),
    });

    const sleepData      = sleepSnap.data() || {};
    const totalLogs      = sleepData.log_count || 0;
    const lastGenAt      = sleepData.last_action_gen_at_log || 0;
    const sinceLast      = totalLogs - lastGenAt;
    const untilRefresh   = Math.max(0, 3 - sinceLast);

    const active = sortByTimestampField(
      activeSnap.docs.map(mapSnapDoc).filter(a => a.source !== 'user_intention'),
      'generated_at', 'asc'
    ).map(format);

    const currentGenIndex = active.length > 0
      ? Math.max(...active.map(a => a.gen_index || 0))
      : lastGenAt;

    const recent = recentSnap.docs.map(mapSnapDoc).map(format);

    const completed = recent.filter(a =>
      a.source !== 'user_intention' &&
      ['done', 'skipped'].includes(a.status) &&
      (a.gen_index || 0) === currentGenIndex
    );

    const prevGenIndex = currentGenIndex > 0
      ? Math.max(0, ...recent
          .filter(a => a.source !== 'user_intention' && a.status === 'past')
          .map(a => a.gen_index || 0))
      : 0;
    const past = prevGenIndex > 0
      ? recent.filter(a => a.status === 'past' && (a.gen_index || 0) === prevGenIndex)
      : [];

    res.json({ active, completed, past, until_refresh: untilRefresh, total_logs: totalLogs });
  } catch (err) {
    console.error('[sleep] /actions error:', err);
    res.status(500).json({ error: 'Failed to get actions' });
  }
});

// ─── Action complete / skip ───────────────────────────────────
router.post('/action/:id/complete', async (req, res) => {
  try {
    const { deviceId } = req.body;
    const { id }       = req.params;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    await actionsCol(deviceId).doc(id).update({
      status:       'done',
      completed_at: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[sleep] complete action error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

router.post('/action/:id/skip', async (req, res) => {
  try {
    const { deviceId } = req.body;
    const { id }       = req.params;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const actionSnap = await actionsCol(deviceId).doc(id).get();
    const actionText = actionSnap.exists ? actionSnap.data().text : null;

    await actionsCol(deviceId).doc(id).update({ status: 'skipped' });

    if (actionText) {
      const snap    = await sleepDoc(deviceId).get();
      const existing = (snap.data()?.skip_history || []);
      const updated  = [...existing, actionText].slice(-20);
      await sleepDoc(deviceId).update({ skip_history: updated });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[sleep] skip action error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /analysis
// Full sleep stats + progressive AI insight. Cached by log count.
// ═══════════════════════════════════════════════════════════════
router.get('/analysis', async (req, res) => {
  try {
    const { deviceId, range = 'all' } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const RANGE_DAYS = { '7': 7, '30': 30, '90': 90, '365': 365 };
    const days = RANGE_DAYS[range] || 0; // 0 = all time

    const [sleepSnap, logsSnap] = await Promise.all([
      sleepDoc(deviceId).get(),
      logsCol(deviceId).orderBy('logged_at', 'asc').limit(500).get(),
    ]);

    if (!sleepSnap.exists) return res.json({ stage: 0, stats: null });

    const sleepData = sleepSnap.data();
    let allLogs = logsSnap.docs.map(d => ({
      id:        d.id,
      ...d.data(),
      logged_at: d.data().logged_at?.toDate?.() || new Date(),
    }));

    if (days > 0) {
      // Filter by sleep DATE (date_str), not log creation time — matches how apps count "last N days"
      const cutoff     = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      const cutoffStr  = dateStr(cutoff); // "YYYY-MM-DD" of the cutoff day (inclusive boundary)
      allLogs = allLogs.filter(l => l.date_str >= cutoffStr);
    }

    if (allLogs.length === 0) {
      return res.json({ stage: 0, stats: { total_logs: 0 }, setup: sleepData });
    }

    const stats           = computeStats(allLogs, sleepData);
    const stage           = determineStage(stats);
    const signal_points   = buildSignalPoints(allLogs, range);
    const recent_timeline = buildRecentTimeline(allLogs);
    const observations    = buildObservations(sleepData, stats, signal_points);
    const correlations    = buildCorrelationBars(sleepData, stats, allLogs);
    const deep_remaining  = Math.max(0, 5 - stats.days_logged);
    const sleep_score     = computeSleepScore(stats);
    const tonight         = buildTonightRecommendation(sleepData, stats);

    // AI insight only for all-time range — needs full history and is LLM-cached by total count
    let ai_insight       = null;
    let personal_formula = null;

    if (range === 'all' && stats.total_logs >= 5) {
      const cacheKey = `${stats.total_logs}_${stats.days_logged}`;
      const cached   = sleepData.analysis_cache;
      if (cached && cached.key === cacheKey) {
        ai_insight       = cached.insight;
        personal_formula = cached.formula;
      } else {
        const result = await generateAnalysisInsight(sleepData, stats, stage, allLogs);
        ai_insight       = result.insight;
        personal_formula = result.formula;
        await sleepDoc(deviceId).update({
          analysis_cache: {
            key:          cacheKey,
            insight:      ai_insight,
            formula:      personal_formula,
            generated_at: new Date().toISOString(),
          },
        });
      }
    }

    res.json({
      stage, stats, ai_insight, personal_formula,
      sleep_score, tonight,
      signal_points, recent_timeline, observations, correlations,
      deep_remaining, setup: sleepData,
    });
  } catch (err) {
    console.error('[sleep] /analysis error:', err);
    res.status(500).json({ error: 'Analysis failed' });
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

    await chatsCol(deviceId).add({
      role:           'user',
      content:        message,
      is_proactive:   false,
      proactive_type: null,
      is_read:        true,
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

    const historySnap = await chatsCol(deviceId)
      .orderBy('created_at', 'desc').limit(16).get();
    const history = historySnap.docs.reverse()
      .filter(d => !d.data().is_proactive)
      .map(d => {
        const msg = d.data();
        return { role: msg.role === 'user' ? 'user' : 'assistant', content: msg.content };
      });

    const completion = await openai.chat.completions.create({
      model:       'gpt-4o',
      temperature:  0.60,
      max_tokens:   500,
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
      is_read:        true,
      created_at:     admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, reply, message_id: msgRef.id });
  } catch (err) {
    console.error('[sleep] /chat error:', err);
    res.status(500).json({ error: 'Chat failed' });
  }
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
    console.error('[sleep] GET /chat error:', err);
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
    console.error('[sleep] /chat/unread error:', err);
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
    console.error('[sleep] /chat/read error:', err);
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
async function generateActions({ profile, setup, recentLogs, recentChat, isFirstGen, recentlySkipped = [] }) {
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
      model:       'gpt-4o',
      temperature:  0.35,
      max_tokens:   800,
      messages:    [{ role: 'user', content: prompt }],
    });

    const raw     = completion.choices[0].message.content.trim();
    const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    const parsed  = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed.slice(0, 3);
    if (parsed.actions && Array.isArray(parsed.actions)) return parsed.actions.slice(0, 3);
    return fallbackActions(problem);
  } catch (err) {
    console.error('[sleep] action gen parse error:', err.message);
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

async function buildPoorSleepProactive(name, quality, disruptors, note, recentLogs, setupData) {
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
      model: 'gpt-4o', temperature: 0.7, max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });
    // Store msg type for next rotation (fire-and-forget)
    sleepDoc(setupData._deviceId || '').update({ last_poor_sleep_msg_type: msgType }).catch(()=>{});
    return completion.choices[0].message.content.trim();
  } catch (err) {
    console.error('[sleep.agent] buildPoorSleepProactive LLM:', err.message);
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
      model: 'gpt-4o', temperature: 0.55, max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });
    return completion.choices[0].message.content.trim();
  } catch (err) {
    console.error('[sleep.agent] buildDebtProactive LLM:', err.message);
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
      model: 'gpt-4o', temperature: 0.7, max_tokens: 120,
      messages: [{ role: 'user', content: prompt }],
    });
    return completion.choices[0].message.content.trim();
  } catch (err) {
    console.error('[sleep.agent] buildStreakProactive LLM:', err.message);
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
      model: 'gpt-4o', temperature: 0.6, max_tokens: 80,
      messages: [{ role: 'user', content: prompt }],
    });
    return completion.choices[0].message.content.trim();
  } catch (err) {
    console.error('[sleep.agent] buildBedtimePrepNotification LLM:', err.message);
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
      model: 'gpt-4o', temperature: 0.6, max_tokens: 80,
      messages: [{ role: 'user', content: prompt }],
    });
    return completion.choices[0].message.content.trim();
  } catch (err) {
    console.error('[sleep.agent] buildMorningLogPrompt LLM:', err.message);
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
    return {
      date_str:          ds,
      label:             d.toLocaleDateString('en', { month: 'short', day: 'numeric' }),
      sleep_quality:     avg('sleep_quality', 3),
      total_sleep_hours: avg('total_sleep_hours', 0),
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
      model: 'gpt-4o', temperature: 0.5, max_tokens: 280,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw     = completion.choices[0].message.content.trim();
    const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('[sleep] analysis insight error:', err.message);
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
cron.schedule('*/10 * * * *', async () => {
  try {
    const now    = new Date();
    const hour   = now.getHours();
    const minute = now.getMinutes();
    const today  = dateStr();

    const usersSnap = await db().collection('wellness_users')
      .where('sleep_setup_complete', '==', true).get();

    for (const userSnap of usersSnap.docs) {
      try {
        const deviceId  = userSnap.id;
        const uData     = userSnap.data();
        const pName     = uData.name || '';

        const [sleepSnap, profileSnap] = await Promise.all([
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

        // Compute current-hour window in local time (server assumed same TZ as users, or use stored TZ)
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
        console.error('[sleep] cron user error:', err.message);
      }
    }
  } catch (err) {
    console.error('[sleep] cron error:', err);
  }
});

module.exports = router;
