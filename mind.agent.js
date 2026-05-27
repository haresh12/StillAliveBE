'use strict';

// ═══════════════════════════════════════════════════════════════
// MIND AGENT — Pulse Backend
// All routes, AI logic, action generation, chat, proactive cron.
// Mounted at /api/mind in server.js
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { AI } = require('./lib/ai/models');
const router  = express.Router();
const admin   = require('firebase-admin');
const { OpenAI } = require('openai');
const cron    = require('node-cron');
// fetchAgentSnapshot import removed 2026-05-23: violated per-agent sandbox law.
// Mind now reads cross-agent context exclusively via cross_agent/today_signals.
const { resolveLanguage, appendLanguageInstruction } = require('./lib/i18n-prompt');
const { withCron, shouldRunCron } = require('./lib/cron-helper');
const { resolveAnchor } = require('./lib/user-anchor');
const { assertLoggableDate, sendLogGuardError } = require('./lib/log-guard');
const { computeMindScore: _computeMindScore } = require('./lib/agent-scores');
const mindAnalytics = require('./lib/mind-analytics');
const { detectCrisis, crisisEnvelope } = require('./lib/safety');

const openai  = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const db      = () => admin.firestore();

// ─── Firestore path helpers ───────────────────────────────────
const userDoc  = (id) => db().collection('wellness_users').doc(id);
const mindDoc  = (id) => userDoc(id).collection('agents').doc('mind');
const checkinsCol = (id) => mindDoc(id).collection('mind_checkins');
const actionsCol  = (id) => mindDoc(id).collection('mind_actions');
const chatsCol    = (id) => mindDoc(id).collection('mind_chats');

// ════════════════════════════════════════════════════════════════
// ACTIONS v2 — shared engine. MUST be mounted BEFORE legacy routes
// (Express first-match wins). Legacy /actions code below is dead.
// ════════════════════════════════════════════════════════════════
const { mountActionRoutes, gradeActions: _gradeActionsShared } = require('./lib/actions-engine');
const { computeMindCandidates, mindGraders } = require('./lib/candidates/mind');
const { assertNoCrossAgent } = require('./lib/sandbox');
assertNoCrossAgent('mind', computeMindCandidates);
const _v2Hooks = mountActionRoutes(router, {
  agentName: 'mind',
  agentDocRef: mindDoc,
  actionsCol,
  logsCol: checkinsCol,
  computeCandidates: computeMindCandidates,
  graders: mindGraders,
  openai,
  admin,
  db,
});
function _onMindLog(deviceId) {
  // Increment log counter; when it reaches BATCH_SIZE the engine cooldown
  // gates regeneration. Also grades any active actions in case criterion is met.
  mindDoc(deviceId).update({
    log_count_since_last_batch: admin.firestore.FieldValue.increment(1),
  }).catch(() => {});
  _v2Hooks.queueGeneration(deviceId);
  _gradeActionsShared({
    agentName: 'mind', deviceId, actionsCol, logsCol: checkinsCol,
    graders: mindGraders, admin, db,
  }).catch(() => {});
  try { require('./wellness.cross').invalidateWellnessCache?.(deviceId); } catch {}
}
// ════════════════════════════════════════════════════════════════

// ─── Constants ────────────────────────────────────────────────
const MOOD_SCORE     = { low: 1, okay: 2, good: 3, great: 4 };

const dateStr = (d = new Date()) => {
  const y  = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${dd}`;
};

const timeOfDayLabel = (hour) => {
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  if (hour < 21) return 'evening';
  return 'night';
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

// ═══════════════════════════════════════════════════════════════
// POST /setup
// Saves all 7-screen setup answers, generates first 3 actions,
// writes opening chat message.
// ═══════════════════════════════════════════════════════════════
router.post('/setup', async (req, res) => {
  try {
    const {
      deviceId,
      primary_challenge,
      current_rating,
      worst_time,
      triggers,
      past_attempts,
      social_context,
      goals,
      discussion_topics,
      daily_reflection_time,
    } = req.body;

    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const setupData = {
      setup_completed:            true,
      primary_challenge:          primary_challenge   || '',
      current_rating:             current_rating      || 5,
      worst_time:                 worst_time          || '',
      triggers:                   triggers            || [],
      past_attempts:              past_attempts       || [],
      social_context:             social_context      || '',
      goals:                      goals               || [],
      discussion_topics:          discussion_topics   || [],
      daily_reflection_time:      daily_reflection_time || '21:00',
      created_at:                 admin.firestore.FieldValue.serverTimestamp(),
      checkin_count:              0,
      last_action_gen_at_checkin: 0,
      last_checkin_date:          null,   // MUST reset so isNewDay fires correctly on first checkin
      last_proactive_date:        null,
      proactive_topic_index:      0,      // rotates through discussion_topics
      analysis_cache:             null,
    };

    // Save mind setup doc
    await mindDoc(deviceId).set(setupData, { merge: true });

    // Flag on the user doc so proactive cron can query it efficiently
    await userDoc(deviceId).set(
      {
        mind_setup_complete: true,
        mind_setup_at: admin.firestore.FieldValue.serverTimestamp(),
        mind_reminder_time: daily_reflection_time || '21:00',
      },
      { merge: true }
    );

    // Fetch user profile for personalisation
    const profileSnap = await userDoc(deviceId).get();
    const profile = profileSnap.exists ? profileSnap.data() : {};

    // Generate first 3 actions from setup data only (no tracking yet)
    const firstActions = await generateActions({
      profile,
      setup: setupData,
      recentCheckins: [],
      recentChat:     [],
      isFirstGen:     true,
    });

    // Write actions to Firestore
    const today = dateStr();
    const batch = db().batch();
    firstActions.forEach((action) => {
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

    // Write opening chat message
    const name = profile.name || '';
    const openingMsg = buildOpeningMessage(name, primary_challenge, triggers);
    await chatsCol(deviceId).add({
      role:           'assistant',
      content:        openingMsg,
      is_proactive:   false,
      proactive_type: null,
      is_read:        true,
      created_at:     admin.firestore.FieldValue.serverTimestamp(),
    });

    // Queue v2 welcome action batch (shared engine — fires asynchronously)
    try { _v2Hooks.queueGeneration(deviceId, { generationKind: 'setup' }); } catch {}

    res.json({ success: true, actions: firstActions });
  } catch (err) {
    log.error('[mind] /setup error:', err);
    res.status(500).json({ error: 'Setup failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /setup-status
// Fast check — used on every agent open (AsyncStorage is primary
// cache; this is the server truth fallback).
// ═══════════════════════════════════════════════════════════════
router.get('/setup-status', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const snap = await mindDoc(deviceId).get();
    if (!snap.exists) return res.json({ setup_completed: false });

    const data = snap.data();
    res.json({ setup_completed: !!data.setup_completed, setup: data });
  } catch (err) {
    log.error('[mind] /setup-status error:', err);
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

    const snap = await mindDoc(deviceId).get();
    const setup = snap.exists ? snap.data() : {};
    const challenge = setup.primary_challenge || '';
    const worstTime = setup.worst_time || '';
    const triggers  = Array.isArray(setup.triggers) ? setup.triggers : [];

    // Fetch last checkin for mood/stress context
    const lastSnap = await checkinsCol(deviceId).orderBy('logged_at', 'desc').limit(1).get();
    const lastLog  = lastSnap.empty ? null : lastSnap.docs[0].data();

    const hour = new Date().getHours();
    const isMorning = hour >= 5 && hour < 12;
    const isEvening = hour >= 17;

    const pool = [];

    // Challenge-specific prompts
    if (challenge === 'anxiety') {
      pool.push({ emoji: '😰', text: "I'm feeling anxious right now — help me calm down." });
      pool.push({ emoji: '🌬️', text: 'Walk me through a breathing exercise.' });
    } else if (challenge === 'stress') {
      pool.push({ emoji: '😤', text: "Work stress is overwhelming me today." });
      pool.push({ emoji: '🧘', text: 'Give me a 2-minute stress release.' });
    } else if (challenge === 'focus') {
      pool.push({ emoji: '🎯', text: "I can't focus — what should I try?" });
      pool.push({ emoji: '⏱️', text: 'Help me design a deep-work block.' });
    } else if (challenge === 'mood') {
      pool.push({ emoji: '📉', text: "My mood has been low. What patterns do you see?" });
      pool.push({ emoji: '✨', text: 'Give me one quick mood boost.' });
    } else {
      pool.push({ emoji: '😰', text: "I'm feeling overwhelmed right now." });
      pool.push({ emoji: '🧘', text: 'Give me a 60-second grounding exercise.' });
    }

    // Time-specific
    if (isMorning) {
      pool.push({ emoji: '🌅', text: 'How can I start my morning with less anxiety?' });
    } else if (isEvening || worstTime === 'evening' || worstTime === 'night') {
      pool.push({ emoji: '🌙', text: 'How do I stop the racing thoughts at night?' });
    } else {
      pool.push({ emoji: '🌅', text: 'How can I build a calmer morning routine?' });
    }

    // Trigger-based
    if (triggers.includes('work')) {
      pool.push({ emoji: '💼', text: "Work is triggering me again — how do I handle it?" });
    } else if (triggers.includes('relationships')) {
      pool.push({ emoji: '💬', text: "A relationship situation is stressing me out." });
    } else {
      pool.push({ emoji: '💭', text: 'Help me reframe a negative thought right now.' });
    }

    // Recent log context
    if (lastLog && lastLog.anxiety_level >= 4) {
      pool.unshift({ emoji: '🚨', text: "I logged high anxiety recently — what should I do?" });
    }
    if (lastLog && lastLog.mood_score <= 2) {
      pool.unshift({ emoji: '📊', text: "My mood has been rough — what does my data show?" });
    }

    // Always include data and pattern prompts
    pool.push({ emoji: '📊', text: "What's my mood pattern this week?" });
    pool.push({ emoji: '🔄', text: 'What cross-agent patterns have you noticed about me?' });

    res.json({ prompts: pool.slice(0, 6) });
  } catch (err) {
    log.error('[mind] /chat-prompts error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

async function refreshMindScore(deviceId) {
  try {
    const sleepLogsRef = userDoc(deviceId).collection('agents').doc('sleep').collection('sleep_logs');
    const [checkinsSnap, mindSnap, sleepSnap] = await Promise.all([
      checkinsCol(deviceId).orderBy('logged_at', 'desc').limit(14).get(),
      mindDoc(deviceId).get(),
      sleepLogsRef.orderBy('logged_at', 'desc').limit(3).get(), // cross-agent signal
    ]);
    const setup    = mindSnap.data() || {};
    const checkins = checkinsSnap.docs.map(d => d.data());
    if (!checkins.length) return;

    const moodScores    = checkins.map(c => c.mood_score || c.mood || 3);
    const anxietyScores = checkins.map(c => c.anxiety_level || c.anxiety || 2);
    const checkinDates  = [...new Set(checkins.map(c => c.date_str))];
    const daysLogged    = checkinDates.length;
    const streak        = setup.checkin_streak || 0;

    // Cross-agent: recent sleep hours (Palmer 2023 — sleep deprivation → mood impairment)
    const sleepLogs       = sleepSnap.docs.map(d => d.data());
    const recentSleepHours = sleepLogs.length
      ? sleepLogs.reduce((s, l) => s + (l.total_sleep_hours || 0), 0) / sleepLogs.length
      : null;

    const result = _computeMindScore({
      mood_scores:         moodScores,
      anxiety_scores:      anxietyScores,
      checkin_dates:       checkinDates,
      days_logged:         daysLogged,
      streak,
      recent_sleep_hours:  recentSleepHours,
    });
    if (!result) return;

    await mindDoc(deviceId).update({
      current_score:    result.score,
      score_label:      result.label,
      score_components: result.components,
      score_updated_at: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    log.error('[mind] refreshScore:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// POST /checkin
// Saves a mood log. Triggers action regeneration every 3 checkins.
// Fires instant proactive message on high anxiety (4-5).
// ═══════════════════════════════════════════════════════════════
router.post('/checkin', async (req, res) => {
  try {
    const { deviceId, mood, emotions, triggers, anxiety, note, override_date } = req.body;
    if (!deviceId || !mood) return res.status(400).json({ error: 'deviceId and mood required' });

    // Support past-date logging (override_date = 'YYYY-MM-DD'), clamped to anchor.
    const anchor = await resolveAnchor(deviceId);
    let candidateDate;
    try { candidateDate = assertLoggableDate(override_date, anchor); }
    catch (e) { return sendLogGuardError(res, e); }

    let now, hour, today;
    if (override_date && /^\d{4}-\d{2}-\d{2}$/.test(override_date)) {
      now   = new Date(candidateDate + 'T12:00:00');
      hour  = 12;
      today = candidateDate;
    } else {
      now   = new Date();
      hour  = now.getHours();
      today = candidateDate;
    }

    // actionDate is ALWAYS the real current date — actions must be for today
    // even if the check-in itself was logged for a past date
    const actionDate = dateStr();

    const checkinData = {
      mood,
      mood_score:  MOOD_SCORE[mood] || 2,
      emotions:    emotions  || [],
      triggers:    triggers  || [],
      anxiety:     anxiety   || 1,
      note:        note      || '',
      time_of_day: timeOfDayLabel(hour),
      hour,
      date_str:    today,
      logged_at:   admin.firestore.Timestamp.fromDate(now),
    };

    // ── Parallelize: checkin write + previous-state read are independent ──
    // ~120ms saved on the median checkin.
    const [checkinRef, mindSnapBefore] = await Promise.all([
      checkinsCol(deviceId).add(checkinData),
      mindDoc(deviceId).get(),
    ]);

    const mindDataBefore  = mindSnapBefore.data() || {};
    const prevCount       = mindDataBefore.checkin_count || 0;
    const lastGenAt       = mindDataBefore.last_action_gen_at_checkin || 0;

    // Atomically increment checkin count
    await mindDoc(deviceId).update({
      checkin_count:     admin.firestore.FieldValue.increment(1),
      last_checkin_date: actionDate,
    });

    // v2 Actions hook — fires regeneration + grading (cooldown-gated)
    _onMindLog(deviceId);

    const totalCount    = prevCount + 1;
    const mindData      = mindDataBefore;
    const sinceLast     = totalCount - lastGenAt;
    const shouldRegenActions = sinceLast >= 3;

    // ── DEFERRED: heavy AI work runs AFTER res.json() returns. ──────────
    // Previously `await`-ed action regeneration (5-15s OpenAI) + proactive
    // gen (5-15s OpenAI) inline → FE timeout at 10s clipped real successes.
    // Now: schedule via setImmediate so the response returns in <500ms.
    // The new actions/proactive messages show up on next /actions or /chat
    // poll (FE polls on tab open / pull-to-refresh).
    const runDeferredAIWork = async () => {
      try {
        // ── Action regeneration (every 3 checkins) ─────────────────────
        if (shouldRegenActions) {
          const [recentCheckinsSnap, recentChatSnap, profileSnap, crossSnap] = await Promise.all([
            checkinsCol(deviceId).orderBy('logged_at', 'desc').limit(10).get(),
            chatsCol(deviceId).orderBy('created_at', 'desc').limit(10).get(),
            userDoc(deviceId).get(),
            userDoc(deviceId).collection('cross_agent').doc('today_signals').get().catch(() => null),
          ]);

          const recentCheckins  = recentCheckinsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
          const recentChat      = recentChatSnap.docs.reverse().map(d => d.data());
          const profile         = profileSnap.exists ? profileSnap.data() : {};
          const recentlySkipped = (mindData.skip_history || []).slice(-8);

          let crossAgentCtx = '';
          const crossSig = crossSnap?.exists ? crossSnap.data() : null;
          if (crossSig) {
            const sleepEntries = crossSig.recent_sleep_summary?.entries || [];
            if (sleepEntries.length) {
              const avgQ = (sleepEntries.reduce((s, e) => s + (e.quality_score || 50), 0) / sleepEntries.length).toFixed(0);
              crossAgentCtx += `Sleep last ${sleepEntries.length} nights: avg quality ${avgQ}/100. `;
            }
            if (Number.isFinite(crossSig.water_intake_pct)) {
              crossAgentCtx += `Hydration today: ${crossSig.water_intake_pct}% of goal. `;
            }
          }

          const newActions = await generateActions({
            profile,
            setup:          mindData,
            recentCheckins,
            recentChat,
            recentlySkipped,
            timeOfDay:      hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening',
            isFirstGen:     false,
            crossAgentCtx,
          });

          // Move current active batch → 'past', then write fresh batch.
          const activeSnap = await actionsCol(deviceId).where('status', '==', 'active').get();
          const batch = db().batch();
          activeSnap.docs
            .filter(d => d.data().source !== 'user_intention')
            .forEach(d => batch.update(d.ref, { status: 'past' }));
          newActions.forEach(action => {
            const ref = actionsCol(deviceId).doc();
            batch.set(ref, {
              ...action,
              status:       'active',
              date_str:     actionDate,
              gen_index:    totalCount,
              generated_at: admin.firestore.FieldValue.serverTimestamp(),
              completed_at: null,
            });
          });
          await batch.commit();
          await mindDoc(deviceId).update({ last_action_gen_at_checkin: totalCount });
        }

        // ── Proactive message gate (max 1/day) ─────────────────────────
        if (mindDataBefore.last_proactive_date !== today) {
          const STREAK_MILESTONES = [3, 7, 14, 30];
          let proactiveType = null;
          let proactiveMsg  = null;
          const extraUpdate = {};

          // P1: High anxiety during waking hours
          if (anxiety >= 4 && hour >= 8 && hour < 22) {
            try {
              const [profileSnap, recentCheckinsSnap] = await Promise.all([
                userDoc(deviceId).get(),
                checkinsCol(deviceId).orderBy('logged_at', 'desc').limit(6).get(),
              ]);
              const pName  = profileSnap.exists ? (profileSnap.data().name || '') : '';
              const recent = recentCheckinsSnap.docs.map(d => d.data());
              proactiveMsg  = await buildAnxietyProactive(
                pName, anxiety, emotions || [], triggers || [], note || '', recent, mindDataBefore
              );
              proactiveType = 'anxiety_spike';
            } catch (err) {
              log.error('[mind] anxiety proactive gen error:', err.message);
            }
          }

          // P2: Streak milestone (only if anxiety didn't fire)
          if (!proactiveType) {
            const checkinDatesSnap = await checkinsCol(deviceId)
              .orderBy('logged_at', 'desc').limit(40).get();
            const uniqueDates = [...new Set(checkinDatesSnap.docs.map(d => d.data().date_str))];
            let streakCount = 0;
            for (let i = 0; i < uniqueDates.length; i++) {
              const expected = dateStr(new Date(Date.now() - i * 86400000));
              if (uniqueDates[i] === expected) streakCount++;
              else break;
            }
            if (STREAK_MILESTONES.includes(streakCount) && mindDataBefore.last_streak_celebrated !== streakCount) {
              const pSnap = await userDoc(deviceId).get();
              const pName = pSnap.exists ? (pSnap.data().name || '') : '';
              proactiveMsg  = await buildStreakProactive(pName, streakCount, mindDataBefore);
              proactiveType = 'streak_milestone';
              extraUpdate.last_streak_celebrated = streakCount;
            }
          }

          if (proactiveMsg && proactiveType) {
            await chatsCol(deviceId).add({
              role:                 'assistant',
              content:              proactiveMsg,
              is_proactive:         true,
              proactive_type:       proactiveType,
              is_read:              false,
              triggered_by_checkin: checkinRef.id,
              created_at:           admin.firestore.FieldValue.serverTimestamp(),
            });
            await mindDoc(deviceId).update({ last_proactive_date: today, ...extraUpdate });
          }
        }
      } catch (err) {
        log.error('[mind] deferred AI work failed (non-fatal):', err?.message);
      }
    };

    // Refresh score cache (non-blocking)
    refreshMindScore(deviceId).catch(() => {});

    // ── post_checkin_summary DROPPED (2026-05-23) ──────────────────────
    // Previously derived anxiety/streak/plateau/trigger snapshot to feed
    // a post-save analytics popup. User law: same analytics every save is
    // not useful per-checkin. Killed the popup → killed the derive. Saves
    // a Firestore read + ~100-300ms wall time. Insights tab is where this
    // kind of analysis belongs. Save now needs to be FAST and silent.

    res.json({
      success:        true,
      id:             checkinRef.id,
      action_refresh: shouldRegenActions,
      // new_actions intentionally omitted — generated AFTER response via
      // setImmediate. FE re-polls /actions on tab open / pull-to-refresh.
    });

    // Fire deferred OpenAI work AFTER response is sent. Response is fast
    // (<500ms typical); deferred work takes 5-30s and never blocks the user.
    setImmediate(() => { runDeferredAIWork(); });
  } catch (err) {
    log.error('[mind] /checkin error:', err);
    res.status(500).json({ error: 'Checkin failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /checkins
// Returns all checkins for a given date (defaults to today).
// ═══════════════════════════════════════════════════════════════
// Returns date → count map for last N days (for 90-day calendar)
router.get('/checkins/dates', async (req, res) => {
  try {
    const { deviceId, days = 90 } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - parseInt(days));

    const snap = await checkinsCol(deviceId)
      .orderBy('logged_at', 'desc')
      .limit(500)
      .get();

    const dateCounts = {};
    snap.docs.forEach(d => {
      const ds = d.data().date_str;
      if (ds) dateCounts[ds] = (dateCounts[ds] || 0) + 1;
    });

    res.json({ date_counts: dateCounts });
  } catch (err) {
    log.error('[mind] /checkins/dates error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

router.get('/checkins', async (req, res) => {
  try {
    const { deviceId, date } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const targetDate = date || dateStr();
    const snap = await checkinsCol(deviceId)
      .where('date_str', '==', targetDate)
      .get();

    const result = sortByTimestampField(
      snap.docs.map(mapSnapDoc),
      'logged_at',
      'asc'
    ).map(checkin => ({
      ...checkin,
      logged_at: toIsoString(checkin.logged_at),
    }));

    res.json({ checkins: result });
  } catch (err) {
    log.error('[mind] /checkins error:', err);
    res.status(500).json({ error: 'Failed to get checkins' });
  }
});

// ═══════════════════════════════════════════════════════════════
// PATCH /checkin/:id
// Edit a past checkin — mood, emotions, triggers, anxiety, note.
// Retroactive date creation is NOT allowed (checked client-side).
// ═══════════════════════════════════════════════════════════════
router.patch('/checkin/:id', async (req, res) => {
  try {
    const { deviceId, mood, emotions, triggers, anxiety, note } = req.body;
    const { id } = req.params;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const updates = {};
    if (mood      !== undefined) { updates.mood = mood; updates.mood_score = MOOD_SCORE[mood] || 2; }
    if (emotions  !== undefined) updates.emotions  = emotions;
    if (triggers  !== undefined) updates.triggers  = triggers;
    if (anxiety   !== undefined) updates.anxiety   = anxiety;
    if (note      !== undefined) updates.note      = note;

    await checkinsCol(deviceId).doc(id).update(updates);
    res.json({ success: true });
  } catch (err) {
    log.error('[mind] PATCH /checkin error:', err);
    res.status(500).json({ error: 'Update failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// (legacy /actions removed — superseded by actions-engine v2 mounted
//  at top of file. v2 owns /actions, /action/:id/{complete,skip,
//  snooze,feedback}.)
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// POST /intention
// User adds their own intention (not AI-generated).
// ═══════════════════════════════════════════════════════════════
router.post('/intention', async (req, res) => {
  try {
    const { deviceId, text, when_to_do } = req.body;
    if (!deviceId || !text) return res.status(400).json({ error: 'deviceId and text required' });

    const ref = await actionsCol(deviceId).add({
      text,
      why:          'Your own intention for today.',
      when_to_do:   when_to_do || 'Today',
      source:       'user_intention',
      status:       'active',
      date_str:     dateStr(),
      generated_at: admin.firestore.FieldValue.serverTimestamp(),
      completed_at: null,
    });

    res.json({ success: true, id: ref.id });
  } catch (err) {
    log.error('[mind] /intention error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});


// ═══════════════════════════════════════════════════════════════
// GET /analysis — full Insights tab payload (10/10 reference)
// Range: 7|30|90|365 days. Returns 7 aha cards + AI reads + score.
// ═══════════════════════════════════════════════════════════════
router.get('/analysis', async (req, res) => {
  try {
    const { deviceId, range } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const daysNum = (() => {
      const n = parseInt(range, 10);
      if (Number.isFinite(n) && n > 0 && n <= 730) return n;
      return null; // all-time
    })();

    // Registration Anchor: clamp window to signup date in user's local TZ.
    const nowMs = Date.now();
    const anchor = await resolveAnchor(deviceId);
    const { computeAnalysisWindow } = require('./lib/range-helpers');
    const win = computeAnalysisWindow(daysNum || 30, anchor.anchorMs, nowMs, anchor.utcOffsetMinutes);
    const effectiveDays = daysNum ? win.effectiveDays : null;

    const language = resolveLanguage(req);
    const payload = await mindAnalytics.loadAnalysisV2(deviceId, effectiveDays, { openai, language });
    const body = payload || { stats: null, signal_points: [], aha_moments: [] };

    // Lifetime fetch: pull checkins since anchor → quality map independent of request window.
    const lifetimeQualityByDate = await (async () => {
      const out = {};
      if (!anchor.anchorMs) return out;
      try {
        const snap = await checkinsCol(deviceId)
          .orderBy('logged_at', 'desc')
          .limit(Math.min(win.daysSinceAnchor * 5, 3000))
          .get();
        const byDate = {};
        for (const d of snap.docs) {
          const c = d.data();
          const ds = c.date_str;
          if (!ds || typeof ds !== 'string') continue;
          if (anchor.anchorDateStr && ds < anchor.anchorDateStr) continue;
          if (!byDate[ds]) byDate[ds] = { moods: [], anxs: [] };
          byDate[ds].moods.push(Number(c.mood_score || c.mood || 2));
          byDate[ds].anxs.push(Number(c.anxiety_level || c.anxiety || 3));
        }
        for (const [ds, b] of Object.entries(byDate)) {
          const mood = b.moods.reduce((a, x) => a + x, 0) / b.moods.length;
          const anx  = b.anxs.reduce((a, x) => a + x, 0) / b.anxs.length;
          const moodPart = Math.max(0, Math.min(100, ((mood - 1) / 2) * 100));
          const anxPart  = Math.max(0, Math.min(100, ((5 - anx) / 4) * 100));
          out[ds] = Math.round(moodPart * 0.6 + anxPart * 0.4);
        }
      } catch { /* fall back to empty */ }
      return out;
    })();

    const { computeStandardOutputs } = require('./lib/score-lifetime');

    // HK blend: a mindful session in Apple Health counts the same as a manual
    // mood log on a no-log day. Manual mood logs still win where present.
    const { blendQualityByDate } = require('./lib/healthkit/blend');
    const { merged: blendedQualityByDate } = await blendQualityByDate({
      coach: 'mind',
      manualQualityByDate: lifetimeQualityByDate,
      deviceId,
      anchorDateStr: anchor.anchorDateStr,
      todayDateStr: win.todayDate,
      db: admin.firestore(),
      utcOffsetMinutes: anchor.utcOffsetMinutes || 0,
    });

    const std = computeStandardOutputs({
      qualityByDate: blendedQualityByDate,
      todayDate: win.todayDate,
      anchorDate: anchor.anchorDateStr,
      daysSinceAnchor: win.daysSinceAnchor,
    });

    let aha_moments = Array.isArray(body.aha_moments) ? body.aha_moments : [];
    try {
      const { buildHKAhaCards } = require('./lib/healthkit/aha-cards');
      const hkCards = await buildHKAhaCards({ coach: 'mind', deviceId, db: admin.firestore() });
      if (hkCards.length) aha_moments = [...hkCards, ...aha_moments];
    } catch { /* best-effort */ }

    // ════════════════════════════════════════════════════════════════
    // 2026-05-23 — 6 NEW SURFACES (mind 10/10 uplift)
    // All derived from a single 60d-window checkin fetch + the lifetime
    // quality map already computed above. No extra Firestore reads
    // unless cross_agent doc is missing (then a single conditional read).
    // ════════════════════════════════════════════════════════════════
    const MS = require('./lib/mind-scoring');
    let extras = null;
    try {
      // Pull a single 60d window of checkins (covers vs-prior + readiness + plateau).
      const cutoffMs60 = nowMs - 60 * 86_400_000;
      const recentSnap = await checkinsCol(deviceId)
        .orderBy('logged_at', 'desc')
        .limit(180)
        .get();
      const allRecent = recentSnap.docs.map((d) => d.data());
      // Filter future + clamp to anchor
      const cleaned = MS.dropFutureCheckins(allRecent, win.todayDate)
        .filter((c) => !anchor.anchorDateStr || (c.date_str && c.date_str >= anchor.anchorDateStr));

      const last30Cutoff = nowMs - 30 * 86_400_000;
      const last30 = cleaned.filter((c) => {
        const ms = c.logged_at?._seconds ? c.logged_at._seconds * 1000
                 : (typeof c.logged_at?.toMillis === 'function' ? c.logged_at.toMillis()
                 : (c.logged_at ? new Date(c.logged_at).getTime() : 0));
        return ms >= last30Cutoff;
      });
      const prior30 = cleaned.filter((c) => {
        const ms = c.logged_at?._seconds ? c.logged_at._seconds * 1000
                 : (typeof c.logged_at?.toMillis === 'function' ? c.logged_at.toMillis()
                 : (c.logged_at ? new Date(c.logged_at).getTime() : 0));
        return ms >= cutoffMs60 && ms < last30Cutoff;
      });

      // Last-3-nights sleep hours from cross_agent doc (sandbox-clean)
      let recentSleepH = null;
      try {
        const crossSnap = await userDoc(deviceId).collection('cross_agent').doc('today_signals').get();
        const xs = crossSnap.exists ? crossSnap.data() : null;
        const entries = xs?.recent_sleep_summary?.entries || [];
        if (entries.length) {
          const sumH = entries.reduce((s, e) => s + (Number(e.duration_hours) || 0), 0);
          const n = entries.filter((e) => Number.isFinite(e.duration_hours)).length;
          if (n > 0) recentSleepH = sumH / n;
        }
      } catch { /* non-fatal */ }

      // 1. CALM READINESS
      const anxiety_scores_recent = cleaned.slice(0, 30).map((c) => Number(c.anxiety_level || c.anxiety || 3));
      const mood_scores_recent    = cleaned.slice(0, 30).map((c) => Number(c.mood_score    || c.mood    || 2));
      const calm_readiness = MS.computeCalmReadiness({
        anxiety_scores: anxiety_scores_recent,
        mood_scores: mood_scores_recent,
        recent_sleep_hours: recentSleepH,
      });

      // 2. vs PRIOR PERIOD
      const last30MoodAvg = last30.length
        ? last30.reduce((s, c) => s + Number(c.mood_score || c.mood || 2), 0) / last30.length
        : null;
      const last30AnxAvg = last30.length
        ? last30.reduce((s, c) => s + Number(c.anxiety_level || c.anxiety || 3), 0) / last30.length
        : null;
      const last30Days = new Set(last30.map((c) => c.date_str).filter(Boolean)).size;
      const last30Reframes = last30.reduce((s, c) => s + (c.reframe_used ? 1 : 0), 0);
      const prior = MS.derivePriorPeriodMind({
        priorCheckins: prior30,
        currentMoodAvg: last30MoodAvg,
        currentAnxAvg: last30AnxAvg,
        currentDaysLogged: last30Days,
        currentReframes: last30Reframes,
      });

      // 3. EMOTION GRANULARITY
      const emotion_granularity = MS.deriveEmotionGranularity(last30, 30);

      // 4. CHECK-IN DEPTH
      const checkin_depth = MS.deriveCheckinDepth(last30);

      // 5. CONTRIBUTION MAP (always 365 cells, anchor-aware)
      const contrib = MS.deriveContributionMapMind({
        dayQualityByDate: blendedQualityByDate,
        anchorDate: anchor.anchorDateStr,
        todayDate: win.todayDate,
        spanDays: 365,
      });

      // 6. CROSS-AGENT CORRELATION GRID (Bearable killer — uses real continuous
      // cross-agent data, not self-reported factors). Reads cross_agent
      // signals + own daily quality map; needs ≥6 paired days per factor.
      let correlation_grid = {};
      try {
        const crossSnap2 = await userDoc(deviceId).collection('cross_agent').doc('history').get().catch(() => null);
        if (crossSnap2?.exists) {
          const hist = crossSnap2.data() || {};
          // Cross-agent history may store per-day signals — pull what's available.
          // Falls back gracefully when no history exists.
          const factors = {};
          for (const k of ['sleep_hours_by_date', 'water_pct_by_date', 'fitness_volume_by_date', 'fasting_hours_by_date']) {
            if (hist[k] && typeof hist[k] === 'object') {
              factors[k.replace('_by_date', '')] = hist[k];
            }
          }
          if (Object.keys(factors).length > 0) {
            correlation_grid = MS.deriveCorrelationGrid({
              factors,
              mindQualityByDate: blendedQualityByDate,
            });
          }
        }
      } catch { /* non-fatal */ }

      // 7. PLATEAU (anxiety stuck high)
      const sortedByDateDesc = cleaned.slice().sort((a, b) => (b.date_str || '').localeCompare(a.date_str || ''));
      const plateau_anxiety = MS.derivePlateauAnxiety({
        anxiety_scores: sortedByDateDesc.map((c) => Number(c.anxiety_level || c.anxiety || 3)),
        dates: sortedByDateDesc.map((c) => c.date_str),
      });

      // 8. TOP TRIGGER (×DOW, dominance flag)
      const top_trigger = MS.deriveTopTrigger(last30, 30);

      // 9. REFRAMES TOTAL — last 30d count, surfaced as a Numbers cell.
      const reframes_total = last30Reframes;

      extras = {
        calm_readiness,
        prior,
        emotion_granularity,
        checkin_depth,
        contribution_map: contrib.cells,
        contribution_summary: contrib.summary,
        correlation_grid,
        plateau_anxiety,
        top_trigger,
        reframes_total,
      };
    } catch (e) {
      log.warn('[mind] extras derivation failed (non-fatal):', e?.message);
      // Always emit safe defaults so FE never crashes on missing keys.
      extras = {
        calm_readiness: null, prior: null,
        emotion_granularity: { unique: 0, total_uses: 0, stagnant: false },
        checkin_depth: { deep_pct: 0, basic_pct: 0, mood_only_pct: 0, deep_n: 0, total_n: 0 },
        contribution_map: [], contribution_summary: { logged_days: 0, missed_days: 0, span_days: 0, total_cells: 0 },
        correlation_grid: {},
        plateau_anxiety: { stalled: false, weeks_stalled: 0, level: null },
        top_trigger: null,
        reframes_total: 0,
      };
    }

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
      // ── NEW 2026-05-23 surfaces ──
      ...extras,
    });
  } catch (err) {
    log.error('[mind] /analysis error:', err);
    res.status(500).json({ error: 'Analysis V2 failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /reframe — single CBT reframe of a thought (Track tab inline)
// Body: { deviceId, thought, region? }. Crisis-routed.
// ═══════════════════════════════════════════════════════════════
router.post('/reframe', async (req, res) => {
  try {
    const { deviceId, thought, region } = req.body;
    if (!deviceId || !thought) return res.status(400).json({ error: 'deviceId and thought required' });

    const crisis = detectCrisis(thought);
    if (crisis) return res.json(crisisEnvelope(region));

    const completion = await openai.chat.completions.create({
      model: AI.REASONING_FAST,
      response_format: { type: 'json_object' },
      max_completion_tokens: 220,
      messages: [
        { role: 'system', content: mindAnalytics.MIND_REFRAME_SYSTEM },
        { role: 'user',   content: thought },
      ],
    });
    const parsed = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
    res.json({ is_crisis: false, reframe: parsed?.reframe || null });
  } catch (err) {
    log.error('[mind] /reframe error:', err);
    res.status(500).json({ error: 'Reframe failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /describe — voice/text → structured check-in fields
// Body: { deviceId, text }. Returns parsed { mood, anxiety, emotions,
// triggers, note } or crisis envelope when crisis keywords present.
// Frontend opens MindConfirmSheet with this result for user edits.
// ═══════════════════════════════════════════════════════════════
const MIND_DESCRIBE_MOODS    = new Set(['low', 'okay', 'good', 'great']);
const MIND_DESCRIBE_EMOTIONS = new Set([
  'Anxious','Overwhelmed','Sad','Angry','Lonely','Numb','Stressed','Drained','Foggy','Hopeless',
  'Restless','Bored','Worried','Calm','Hopeful','Content','Grateful','Focused','Energized',
  'Happy','Relaxed','Motivated','Excited','Proud','Inspired','Joyful',
]);
const MIND_DESCRIBE_TRIGGERS = new Set([
  'Work','Relationships','Money','Family','Health','Sleep',
  'Loneliness','Body image','Social situation',"Can't name it",
]);

router.post('/describe', async (req, res) => {
  try {
    const { deviceId, text } = req.body;
    if (!deviceId || !text) return res.status(400).json({ error: 'deviceId and text required' });

    const crisis = detectCrisis(text);
    if (crisis) return res.json({ is_crisis: true, ...crisisEnvelope() });

    const completion = await openai.chat.completions.create({
      model: AI.REASONING_FAST,
      response_format: { type: 'json_object' },
      max_completion_tokens: 600,
      messages: [
        { role: 'system', content: mindAnalytics.MIND_DESCRIBE_SYSTEM },
        { role: 'user',   content: String(text).slice(0, 1500) },
      ],
    });
    const raw = JSON.parse(completion.choices?.[0]?.message?.content || '{}');

    // Strict whitelist filter: drop anything that isn't in canon.
    const mood     = MIND_DESCRIBE_MOODS.has(raw.mood) ? raw.mood : null;
    const anxiety  = Number.isFinite(raw.anxiety) ? Math.max(1, Math.min(5, Math.round(raw.anxiety))) : null;
    const emotions = Array.isArray(raw.emotions)
      ? raw.emotions.filter((e) => MIND_DESCRIBE_EMOTIONS.has(e)).slice(0, 5)
      : [];
    const triggers = Array.isArray(raw.triggers)
      ? raw.triggers.filter((t) => MIND_DESCRIBE_TRIGGERS.has(t)).slice(0, 3)
      : [];
    const note = typeof raw.note === 'string' ? raw.note.slice(0, 280) : '';

    res.json({ is_crisis: false, mood, anxiety, emotions, triggers, note });
  } catch (err) {
    log.error('[mind] /describe error:', err);
    res.status(500).json({ error: 'Describe failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /track-context — single-shot Track tab payload
// Returns today's logs, summary, smart defaults, contextual nudge,
// streak (with grace), and 28-day calendar dots.
// ═══════════════════════════════════════════════════════════════
router.get('/track-context', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const payload = await mindAnalytics.loadTrackContext(deviceId);
    res.json(payload || { today_logs: [], smart_defaults: null, streak: 0 });
  } catch (err) {
    log.error('[mind] /track-context error:', err);
    res.status(500).json({ error: 'track context failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /actions — 10/10 Actions tab payload (mind-native)
// Wraps the actions-engine collection + adds cadence + history shape.
// ═══════════════════════════════════════════════════════════════
router.get('/actions', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const [actSnap, mindSnap, recentCheckSnap] = await Promise.all([
      actionsCol(deviceId).orderBy('generated_at', 'desc').limit(20).get(),
      mindDoc(deviceId).get(),
      checkinsCol(deviceId).orderBy('logged_at', 'desc').limit(20).get(),
    ]);

    const allActions = actSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const mindData   = mindSnap.exists ? mindSnap.data() : {};
    const recentCheckins = recentCheckSnap.docs.map(d => d.data());

    // Cadence: 3 check-ins per refresh (mind cadence is checkin-count, not days)
    const totalCheckins = mindData.checkin_count || recentCheckins.length || 0;
    const lastGenAt     = mindData.last_action_gen_at_checkin || 0;
    const sinceLast     = Math.max(0, totalCheckins - lastGenAt);
    const untilRefresh  = Math.max(0, 3 - sinceLast);

    // Active list — actions-engine writes status: 'active' | 'completed' | 'skipped' | 'cancelled' | 'past'
    const active = allActions.filter(a =>
      a.kind !== 'prescription' &&
      a.source !== 'user_intention' &&
      (!a.status || a.status === 'active' || a.status === 'pending')
    );
    // Engine writes a.proof as an OBJECT {metric, value, threshold, citation};
    // a.proof_body / a.why / a.text hold the rendered strings. Always coerce.
    const proofString = (a) => {
      if (typeof a.proof_body === 'string' && a.proof_body) return a.proof_body;
      if (typeof a.proof === 'string' && a.proof) return a.proof;
      if (a.proof && typeof a.proof === 'object' && a.proof.citation) return `Tap ✓ when done — tracked vs ${a.proof.citation}.`;
      return 'Tap ✓ when done — your coach tracks the hit-rate.';
    };
    const actions = active.slice(0, 3).map(a => ({
      id: a.id,
      title: (typeof a.title === 'string' && a.title) || a.text || a.surprise_hook || 'Action',
      why:   (typeof a.why === 'string' && a.why) || a.proof_body || 'Cited from your recent check-ins.',
      how:   (typeof a.how === 'string' && a.how) || a.micro_step || a.surprise_hook || 'Tap below to see the step.',
      when:  a.when || a.when_to_do || 'Today',
      proof: proofString(a),
      archetype: typeof a.archetype === 'string' ? a.archetype : null,
      status: 'active',
      hit_rate:     a.hit_count || a.completed_count || 0,
      target_count: a.target_count || 1,
      created_at:   a.generated_at || null,
    }));

    // History
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

    return res.json({
      cadence: {
        status: lastGenAt > 0 ? 'live' : 'pending',
        checkins_so_far:  totalCheckins,
        until_refresh:    untilRefresh,
        last_gen_checkin: lastGenAt,
      },
      actions,
      history,
      stats: {
        active_count:     active.length,
        total_checkins:   totalCheckins,
        completed_total,
        skipped_total,
        cancelled_total:  skipped_total,
        follow_through_pct: (completed_total + skipped_total) > 0
          ? Math.round((completed_total / (completed_total + skipped_total)) * 100)
          : 0,
      },
    });
  } catch (err) {
    log.error('[mind] /actions error:', err);
    return res.status(500).json({ error: 'server error' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /chat-state — last 24h state for the Coach tab header
// Returns { last_checkin: {ago_minutes, mood, anxiety, emotions, triggers}, streak }
// ═══════════════════════════════════════════════════════════════
router.get('/chat-state', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    // Single fetch pulls last-1 (for header) + last-60 (for prompt_signals).
    const [snap60, mindSnap] = await Promise.all([
      checkinsCol(deviceId).orderBy('logged_at', 'desc').limit(60).get(),
      mindDoc(deviceId).get(),
    ]);
    const mind = mindSnap.exists ? mindSnap.data() : {};
    if (snap60.empty) return res.json({ last_checkin: null, streak: 0, prompt_signals: null });

    const docs = snap60.docs.map((d) => d.data());
    const latest = docs[0];
    const at = latest.logged_at?.toMillis?.() || new Date(latest.logged_at || 0).getTime();
    const ago = Math.max(0, Math.round((Date.now() - at) / 60000));

    // ── prompt_signals for smart Chat quick-prompts (2026-05-23) ───
    // Cheap derive from already-loaded 60d window. The FE picks 1-2
    // data-aware chips ("Should I rest today? readiness 38") and falls
    // back to defaults if no actionable signal exists.
    let prompt_signals = null;
    try {
      const MS = require('./lib/mind-scoring');
      const anchor = await resolveAnchor(deviceId);
      const todayDate = (() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      })();
      const cleaned = MS.dropFutureCheckins(docs, todayDate)
        .filter((c) => !anchor.anchorDateStr || (c.date_str && c.date_str >= anchor.anchorDateStr));

      // Calm readiness (last 30 / sleep cross-impact)
      let recentSleepH = null;
      try {
        const crossSnap = await userDoc(deviceId).collection('cross_agent').doc('today_signals').get();
        const xs = crossSnap.exists ? crossSnap.data() : null;
        const entries = xs?.recent_sleep_summary?.entries || [];
        if (entries.length) {
          const n = entries.filter((e) => Number.isFinite(e.duration_hours)).length;
          if (n > 0) {
            recentSleepH = entries.reduce((s, e) => s + (Number(e.duration_hours) || 0), 0) / n;
          }
        }
      } catch { /* non-fatal */ }
      const readiness = MS.computeCalmReadiness({
        anxiety_scores: cleaned.slice(0, 30).map((c) => Number(c.anxiety_level || c.anxiety || 3)),
        mood_scores:    cleaned.slice(0, 30).map((c) => Number(c.mood_score || c.mood || 2)),
        recent_sleep_hours: recentSleepH,
      });

      // Top trigger (last 30d, only flagged when dominant)
      const last30Cutoff = Date.now() - 30 * 86_400_000;
      const last30 = cleaned.filter((c) => {
        const ms = c.logged_at?._seconds ? c.logged_at._seconds * 1000
                 : (typeof c.logged_at?.toMillis === 'function' ? c.logged_at.toMillis()
                 : (c.logged_at ? new Date(c.logged_at).getTime() : 0));
        return ms >= last30Cutoff;
      });
      const topTrigger = MS.deriveTopTrigger(last30, 30);

      // Plateau anxiety
      const sortedDesc = cleaned.slice().sort((a, b) => (b.date_str || '').localeCompare(a.date_str || ''));
      const plateau = MS.derivePlateauAnxiety({
        anxiety_scores: sortedDesc.map((c) => Number(c.anxiety_level || c.anxiety || 3)),
        dates: sortedDesc.map((c) => c.date_str),
      });

      // Granularity stagnation
      const gran = MS.deriveEmotionGranularity(last30, 30);

      prompt_signals = {
        readiness: readiness.readiness,
        band: readiness.band,
        top_trigger: topTrigger?.is_dominant ? topTrigger.name : null,
        plateau_weeks: plateau.stalled ? plateau.weeks_stalled : 0,
        granularity_stagnant: !!gran.stagnant,
      };
    } catch { /* prompts gracefully fall back to defaults */ }

    res.json({
      last_checkin: {
        ago_minutes: ago,
        mood:        Number(latest.mood_score || 2),
        mood_label:  latest.mood,
        anxiety:     Number(latest.anxiety || 1),
        emotions:    (latest.emotions || []).slice(0, 3),
        triggers:    (latest.triggers || []).slice(0, 2),
      },
      streak: mind.streak || 0,
      prompt_signals,
    });
  } catch (err) {
    log.error('[mind] /chat-state error:', err);
    res.status(500).json({ error: 'state failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /chat
// Builds full context pipeline, sends to GPT-4o, saves both
// sides of the conversation.
// ═══════════════════════════════════════════════════════════════
router.post('/chat', async (req, res) => {
  try {
    const { deviceId, message, region } = req.body;
    if (!deviceId || !message) return res.status(400).json({ error: 'deviceId and message required' });

    const language = resolveLanguage(req);

    // Save user message first so it appears immediately client-side
    await chatsCol(deviceId).add({
      role:           'user',
      content:        message,
      is_proactive:   false,
      proactive_type: null,
      is_read:        true, language,
      created_at:     admin.firestore.FieldValue.serverTimestamp(),
    });

    // ── CRISIS ROUTING ──────────────────────────────────────────
    // Never call OpenAI for crisis content — return the warm template.
    // Crisis envelope is already localized via the crisisEnvelope(region)
    // path; language directive is intentionally NOT applied here.
    const crisis = detectCrisis(message);
    if (crisis) {
      const env = crisisEnvelope(region);
      const msgRef = await chatsCol(deviceId).add({
        role:           'assistant',
        content:        env.reply,
        is_proactive:   false,
        proactive_type: 'crisis_safe',
        is_crisis:      true,
        is_read:        true, language,
        created_at:     admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.json({ success: true, reply: env.reply, message_id: msgRef.id, ...env });
    }

    // Build personalised system context, then append language directive
    let systemContext = appendLanguageInstruction(await buildContext(deviceId), language);

    // Silent HK enrichment — objective signals (HRV, sleep) when granted.
    try {
      const { buildHKContext, appendHKContext } = require('./lib/healthkit/context-builder');
      const hkBlock = await buildHKContext({ db: admin.firestore(), deviceId, coach: 'mind', days: 7 });
      systemContext = appendHKContext(systemContext, hkBlock);
    } catch { /* best-effort */ }

    // Fetch chat history for conversation continuity (last 14 messages)
    const historySnap = await chatsCol(deviceId)
      .orderBy('created_at', 'desc')
      .limit(14)
      .get();
    const history = historySnap.docs.reverse().map(d => ({
      role:    d.data().role,
      content: d.data().content,
    }));

    const completion = await openai.chat.completions.create({
      model: AI.REASONING_PRO,
      max_completion_tokens: 1000,
      messages: [
        { role: 'system', content: systemContext },
        ...history,
      ],
    });

    const reply = completion.choices[0].message.content.trim();

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
    log.error('[mind] /chat error:', err);
    res.status(500).json({ error: 'Chat failed' });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /chat/stream — SSE streaming
// ─────────────────────────────────────────────────────────────────
const { mountChatStream: _mountChatStreamMind } = require('./lib/chat-stream');
_mountChatStreamMind(router, {
  agentName: 'mind',
  openai, admin, chatsCol,
  model: AI.REASONING_PRO,
  maxTokens: 650,
  buildPrompt: async (deviceId /* , message */) => {
    const systemPrompt = await buildContext(deviceId);
    const historySnap = await chatsCol(deviceId).orderBy('created_at', 'desc').limit(14).get();
    const history = historySnap.docs.reverse()
      .map(d => d.data())
      .filter(m => (m.role === 'assistant' || m.role === 'user') && m.content && m.content.trim())
      .map(m => ({ role: m.role, content: m.content }));
    return { systemPrompt, history };
  },
});

// ═══════════════════════════════════════════════════════════════
// GET /chat  — full message history (last 80, oldest first)
// ═══════════════════════════════════════════════════════════════
router.get('/chat', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const snap = await chatsCol(deviceId)
      .orderBy('created_at', 'asc')
      .limit(80)
      .get();

    const messages = snap.docs.map(d => ({
      id:         d.id,
      ...d.data(),
      created_at: d.data().created_at?.toDate?.()?.toISOString() || null,
    }));

    res.json({ messages });
  } catch (err) {
    log.error('[mind] GET /chat error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /chat/unread
// Returns unread proactive messages so the app can fire a local
// notifee notification when foregrounded.
// ═══════════════════════════════════════════════════════════════
router.get('/chat/unread', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const snap = await chatsCol(deviceId)
      .where('is_read', '==', false)
      .limit(20)
      .get();

    const messages = sortByTimestampField(
      snap.docs
        .map(mapSnapDoc)
        .filter(message => message.is_proactive),
      'created_at',
      'desc'
    )
      .slice(0, 5)
      .map(message => ({
        ...message,
        created_at: toIsoString(message.created_at),
      }));

    res.json({ messages });
  } catch (err) {
    log.error('[mind] /chat/unread error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /chat/read — mark all unread proactive messages as read
// ═══════════════════════════════════════════════════════════════
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
    log.error('[mind] /chat/read error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// ─── ACTION GENERATOR ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

async function generateActions({ profile, setup, recentCheckins, recentChat, isFirstGen, isBonus = false, timeOfDay = 'morning', recentlySkipped = [], crossAgentCtx = '' }) {
  const name      = profile.name              || 'the user';
  const challenge = setup.primary_challenge   || 'mental wellness';
  const triggers  = setup.triggers            || [];
  const goals     = setup.goals               || [];
  const worstTime = setup.worst_time          || 'unknown';
  const rating    = setup.current_rating      || 5;
  const pastTried = setup.past_attempts       || [];

  let dataSection = '';

  if (isFirstGen) {
    dataSection = `FIRST SESSION — no tracking data yet. Base every action on their setup answers.
Primary challenge: ${challenge}
Starting mood rating: ${rating}/10
Worst time of day: ${worstTime}
Main triggers: ${triggers.join(', ') || 'not yet identified'}
What they've tried: ${pastTried.join(', ') || 'nothing yet'}
Goals: ${goals.join(', ')}`;
  } else {
    const checkSummary = recentCheckins.slice(0, 6).map(c =>
      `${c.date_str} ${c.time_of_day}: mood=${c.mood}(${c.mood_score}/4) anxiety=${c.anxiety}/5` +
      (c.triggers?.length ? ` triggers=[${c.triggers.join(',')}]` : '') +
      (c.emotions?.length ? ` emotions=[${c.emotions.join(',')}]` : '') +
      (c.note ? ` note="${c.note}"` : '')
    ).join('\n');

    const chatSnippet = recentChat
      .filter(m => m.role === 'user')
      .slice(-3)
      .map(m => `"${m.content}"`)
      .join('; ');

    dataSection = `RECENT CHECK-INS (newest first):
${checkSummary || 'none yet'}

WHAT THEY SAID IN CHAT RECENTLY:
${chatSnippet || 'nothing yet'}`;
  }

  const skipSection = recentlySkipped.length
    ? `\nACTIONS THIS USER HAS BEEN SKIPPING — avoid suggesting similar things:\n${recentlySkipped.map(s => `- "${s}"`).join('\n')}`
    : '';

  const timeContext = {
    morning:   'It is morning. Prioritise actions that set up the day — energising, proactive, momentum-building.',
    afternoon: 'It is afternoon. Focus on actions that can interrupt a stress build-up or reset mid-day energy.',
    evening:   'It is evening. Prioritise actions that wind down, reflect, and prepare for sleep.',
  }[timeOfDay] || '';

  const bonusContext = isBonus
    ? `\nBONUS ROUND: This user already completed their full daily plan. Generate 2 lighter, optional stretch actions — something they can do in under 10 minutes that goes slightly deeper than the basics. Treat it as a reward, not more work.`
    : '';

  const count = isBonus ? '2' : '2-3';
  const crossSection = crossAgentCtx ? `\n━━━ CROSS-AGENT CONTEXT ━━━\n${crossAgentCtx}\nUse this data to make at least one action directly address a cross-agent pattern.\n` : '';

  // ── PRIORITY_SIGNALS (2026-05-23) — pre-computed pattern flags ───
  // If any signal fires, gently steer the AI toward the matching archetype
  // (calm_reset / granularity_growth / reframe_practice / trigger_awareness).
  let prioritySignalsSection = '';
  try {
    if (!isFirstGen && Array.isArray(recentCheckins) && recentCheckins.length >= 3) {
      const MS = require('./lib/mind-scoring');
      const anxiety_scores = recentCheckins.slice(0, 30).map((c) => Number(c.anxiety_level || c.anxiety || 3));
      const mood_scores    = recentCheckins.slice(0, 30).map((c) => Number(c.mood_score || c.mood || 2));
      const readiness = MS.computeCalmReadiness({ anxiety_scores, mood_scores });
      const gran = MS.deriveEmotionGranularity(recentCheckins.slice(0, 30), 30);
      const sortedDesc = recentCheckins.slice().sort((a, b) => (b.date_str || '').localeCompare(a.date_str || ''));
      const plateau = MS.derivePlateauAnxiety({
        anxiety_scores: sortedDesc.map((c) => Number(c.anxiety_level || c.anxiety || 3)),
        dates: sortedDesc.map((c) => c.date_str),
      });
      const topTrigger = MS.deriveTopTrigger(recentCheckins.slice(0, 30), 30);
      const reframesRecent = recentCheckins.slice(0, 14).reduce((s, c) => s + (c.reframe_used ? 1 : 0), 0);
      const negativeNoteRecent = recentCheckins.slice(0, 7).some((c) =>
        typeof c.note === 'string' && c.note.trim().length > 0 && Number(c.anxiety_level || c.anxiety || 0) >= 3,
      );

      const signals = [];
      if (readiness.band === 'stressed' || readiness.band === 'overwhelmed') {
        signals.push(`• calm_reset (readiness ${readiness.readiness}/100, ${readiness.band})`);
      }
      if (gran.stagnant) {
        signals.push(`• granularity_growth (only ${gran.unique} unique feelings in 30d)`);
      }
      if (negativeNoteRecent && reframesRecent === 0) {
        signals.push(`• reframe_practice (anxious note in last 7d + zero reframes in 14d)`);
      }
      if (topTrigger?.is_dominant) {
        signals.push(`• trigger_awareness (${topTrigger.name} in ${topTrigger.pct_of_checkins}% of last-30d checkins)`);
      }
      if (plateau.stalled && plateau.weeks_stalled >= 3) {
        signals.push(`• reframe_practice (anxiety stuck ≥${plateau.weeks_stalled} weeks — try cognitive distortion ID)`);
      }
      if (signals.length) {
        prioritySignalsSection = `\n━━━ PRIORITY_SIGNALS (firm guidance) ━━━\nAt least ONE of the actions you generate should match a signal below if any are present:\n${signals.join('\n')}\n`;
      }
    }
  } catch { /* non-fatal */ }

  const prompt = `Generate ${count} daily actions for ${name}'s Mind Coach in the Pulse wellness app.

USER PROFILE:
Name: ${name}
Primary challenge: ${challenge}
Main triggers: ${triggers.join(', ') || 'not specified'}
Goals: ${goals.join(', ') || 'general wellbeing'}
Worst time of day: ${worstTime}

${dataSection}
${skipSection}
${crossSection}
${prioritySignalsSection}
${timeContext}
${bonusContext}

RULES — non-negotiable:
1. Every action must be SPECIFIC to this person. No generic wellness advice.
2. The "why" field MUST reference their actual data, challenge, or something they said in chat. Quote their numbers if available.
3. Actions must be immediately actionable today — not "start meditating" but "spend 5 minutes sitting quietly before your next task because your last 3 check-ins show anxiety at 3+"
4. Mix timing: at least one action is for "right now" and one is for later today.
5. Tone: direct, warm, like a coach who has been watching this person. Not preachy or generic.
6. If they mentioned something specific in chat (like a meeting, a conflict, bad sleep), address it directly in an action.
7. Keep "text" clean and compact: ideally 6-14 words, one clear instruction.
8. Keep "why" short: ideally 8-18 words, one clear reason.
9. No long paragraphs, no therapy clichés, no filler language.

Return ONLY valid JSON — an array of ${count} objects. No markdown, no explanation:
[
  {
    "text": "the specific action to take",
    "why": "why this action, referencing their actual data or words",
    "when_to_do": "Right now | This morning | Before bed | Tonight | Today | In the next hour",
    "source": "tracking"
  }
]`;

  try {
    const completion = await openai.chat.completions.create({
      model: AI.REASONING_PRO,
      max_completion_tokens: 700,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = completion.choices[0].message.content.trim();
    // Strip any accidental markdown
    const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    const parsed  = JSON.parse(cleaned);

    if (Array.isArray(parsed)) return parsed.slice(0, 3);

    // Handle object with an "actions" key
    if (parsed.actions && Array.isArray(parsed.actions)) return parsed.actions.slice(0, 3);

    return fallbackActions(challenge, worstTime);
  } catch (err) {
    log.error('[mind] action gen parse error:', err.message);
    return fallbackActions(challenge, worstTime);
  }
}

function fallbackActions(challenge, worstTime) {
  return [
    {
      text:        'Sit quietly for 4 minutes with no phone or task.',
      why:         'This gives your coach a clean baseline and lowers immediate mental noise.',
      when_to_do:  'Right now',
      source:      'tracking',
    },
    {
      text:        'Write one honest sentence about how you actually feel.',
      why:         'Honest language gives the coach something real to work with today.',
      when_to_do:  'Today',
      source:      'tracking',
    },
  ];
}

// ═══════════════════════════════════════════════════════════════
// ─── CONTEXT BUILDER — full user context for chat AI ──────────
// ═══════════════════════════════════════════════════════════════

async function buildContext(deviceId) {
  const [mindSnap, profileSnap, recentCheckinsSnap, recentActionsSnap] = await Promise.all([
    mindDoc(deviceId).get(),
    userDoc(deviceId).get(),
    checkinsCol(deviceId).orderBy('logged_at', 'desc').limit(30).get(),
    actionsCol(deviceId).where('status', '==', 'active').get(),
  ]);

  const setup      = mindSnap.exists ? mindSnap.data() : {};
  const profile    = profileSnap.exists ? profileSnap.data() : {};
  const checkins   = recentCheckinsSnap.docs.map(d => d.data()).reverse(); // oldest→newest
  const allActions = recentActionsSnap.docs.map(d => d.data());

  const name       = profile.name || 'there';
  const daysLogged = new Set(checkins.map(c => c.date_str)).size;
  const totalCount = setup.checkin_count || 0;

  // ── 1. Emotion & trigger frequencies with percentages ──────────
  const emotionCounts = {};
  const triggerCounts = {};
  checkins.forEach(c => {
    (c.emotions || []).forEach(e => { emotionCounts[e] = (emotionCounts[e] || 0) + 1; });
    (c.triggers || []).forEach(t => { triggerCounts[t] = (triggerCounts[t] || 0) + 1; });
  });
  const n = checkins.length || 1;
  const topEmotions = Object.entries(emotionCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([k, v]) => `${k} (${v}/${n} check-ins, ${Math.round(v/n*100)}%)`);
  const topTriggers = Object.entries(triggerCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([k, v]) => `${k} (${v}/${n} check-ins, ${Math.round(v/n*100)}%)`);

  // ── 2. Mood trajectory — last 5 scores, direction ──────────────
  const last5 = checkins.slice(-5);
  const last5Scores = last5.map(c => c.mood_score || 2);
  let trajectory = 'insufficient data';
  if (last5Scores.length >= 3) {
    const first = last5Scores.slice(0, Math.floor(last5Scores.length / 2));
    const second = last5Scores.slice(Math.ceil(last5Scores.length / 2));
    const firstAvg = first.reduce((s, v) => s + v, 0) / first.length;
    const secondAvg = second.reduce((s, v) => s + v, 0) / second.length;
    const diff = secondAvg - firstAvg;
    if (diff > 0.3) trajectory = `IMPROVING (+${diff.toFixed(1)} avg over last 5 logs)`;
    else if (diff < -0.3) trajectory = `DECLINING (${diff.toFixed(1)} avg over last 5 logs)`;
    else trajectory = `STABLE (flat over last 5 logs)`;
  }
  const last5Str = last5.map(c =>
    `  ${c.date_str} ${c.time_of_day}: mood=${c.mood}(${c.mood_score}/4) anxiety=${c.anxiety}/5 emotions=[${(c.emotions||[]).join(', ')}] triggers=[${(c.triggers||[]).join(', ')}]${c.note ? ` note="${c.note}"` : ''}`
  ).join('\n');

  // ── 3. Anxiety trend (week over week) ─────────────────────────
  const now      = new Date();
  const msPerDay = 86400000;
  const week1    = checkins.filter(c => {
    const d = new Date(c.logged_at);
    return (now - d) <= 7 * msPerDay;
  });
  const week2    = checkins.filter(c => {
    const d = new Date(c.logged_at);
    return (now - d) > 7 * msPerDay && (now - d) <= 14 * msPerDay;
  });
  const w1Anxiety = week1.length ? (week1.reduce((s, c) => s + (c.anxiety || 0), 0) / week1.length).toFixed(1) : null;
  const w2Anxiety = week2.length ? (week2.reduce((s, c) => s + (c.anxiety || 0), 0) / week2.length).toFixed(1) : null;
  let anxietyTrend = 'not enough data yet';
  if (w1Anxiety && w2Anxiety) {
    const delta = parseFloat(w1Anxiety) - parseFloat(w2Anxiety);
    if (delta < -0.3) anxietyTrend = `IMPROVING — anxiety dropped from ${w2Anxiety} last week to ${w1Anxiety} this week`;
    else if (delta > 0.3) anxietyTrend = `WORSENING — anxiety rose from ${w2Anxiety} last week to ${w1Anxiety} this week`;
    else anxietyTrend = `STABLE — anxiety ~${w1Anxiety}/5 consistent week over week`;
  } else if (w1Anxiety) {
    anxietyTrend = `This week avg: ${w1Anxiety}/5`;
  }

  // ── 4. Time-of-day patterns ────────────────────────────────────
  const timeSlotMoods = { morning: [], afternoon: [], evening: [], night: [] };
  checkins.forEach(c => {
    const slot = c.time_of_day;
    if (timeSlotMoods[slot]) timeSlotMoods[slot].push(c.mood_score || 2);
  });
  const timePatterns = Object.entries(timeSlotMoods)
    .filter(([, v]) => v.length >= 2)
    .map(([slot, scores]) => {
      const avg = (scores.reduce((s, v) => s + v, 0) / scores.length).toFixed(1);
      return `${slot}: avg mood ${avg}/4 (${scores.length} logs)`;
    });

  // ── 5. Day-of-week pattern ─────────────────────────────────────
  const dowMoods = {};
  checkins.forEach(c => {
    if (!c.date_str) return;
    const d = new Date(c.date_str);
    const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
    if (!dowMoods[dow]) dowMoods[dow] = [];
    dowMoods[dow].push(c.mood_score || 2);
  });
  const dowAvgs = Object.entries(dowMoods)
    .filter(([, v]) => v.length >= 2)
    .map(([day, scores]) => ({ day, avg: scores.reduce((s, v) => s + v, 0) / scores.length }))
    .sort((a, b) => a.avg - b.avg);
  const worstDay  = dowAvgs.length ? `${dowAvgs[0].day} (avg ${dowAvgs[0].avg.toFixed(1)}/4)` : null;
  const bestDay   = dowAvgs.length ? `${dowAvgs[dowAvgs.length-1].day} (avg ${dowAvgs[dowAvgs.length-1].avg.toFixed(1)}/4)` : null;

  // ── 6. Actions completion rate ─────────────────────────────────
  const doneActs    = allActions.filter(a => a.status === 'done').length;
  const skippedActs = allActions.filter(a => a.status === 'skipped').length;
  const totalActsTracked = doneActs + skippedActs;
  const completionRate = totalActsTracked > 0
    ? `${doneActs}/${totalActsTracked} actions completed (${Math.round(doneActs/totalActsTracked*100)}%)`
    : 'not enough action history yet';
  const activeActs = allActions.filter(a => a.status === 'active');
  const activeActsStr = activeActs.length
    ? activeActs.map(a => `  • ${a.text} [${a.when_to_do || 'anytime'}]`).join('\n')
    : '  none currently active';

  // ── 7. Today's full picture ────────────────────────────────────
  const today = dateStr();
  const todayCheckins = checkins.filter(c => c.date_str === today);
  const dayName   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getDay()];
  const timeLabel = timeOfDayLabel(now.getHours());
  const todayStr = todayCheckins.length
    ? todayCheckins.map(c =>
        `  ${c.time_of_day}: mood=${c.mood}(${c.mood_score}/4) anxiety=${c.anxiety}/5 emotions=[${(c.emotions||[]).join(', ')}] triggers=[${(c.triggers||[]).join(', ')}]${c.note ? ` | note: "${c.note}"` : ''}`
      ).join('\n')
    : '  no check-ins yet today';

  // ── 8. Yesterday vs today delta ───────────────────────────────
  const yesterdayStr_date = dateStr(new Date(now - msPerDay));
  const ydayCheckins = checkins.filter(c => c.date_str === yesterdayStr_date);
  let yesterdayVsToday = '';
  if (ydayCheckins.length && todayCheckins.length) {
    const ydayAvg = ydayCheckins.reduce((s, c) => s + (c.mood_score || 2), 0) / ydayCheckins.length;
    const todayAvg = todayCheckins.reduce((s, c) => s + (c.mood_score || 2), 0) / todayCheckins.length;
    const delta = todayAvg - ydayAvg;
    yesterdayVsToday = delta > 0.3
      ? `TODAY IS BETTER than yesterday (+${delta.toFixed(1)} mood)`
      : delta < -0.3
      ? `TODAY IS WORSE than yesterday (${delta.toFixed(1)} mood)`
      : `TODAY IS SIMILAR to yesterday`;
  }

  // ── 9. Notable notes (surface personal context gold) ──────────
  const notesWithContext = checkins
    .filter(c => c.note && c.note.trim().length > 5)
    .slice(-6)
    .map(c => `  [${c.date_str} ${c.time_of_day}] "${c.note}"`)
    .join('\n');

  // ── 10. Pre-computed insight statements ───────────────────────
  const insights = [];
  // Dominant trigger
  const triggerEntries = Object.entries(triggerCounts).sort((a, b) => b[1] - a[1]);
  if (triggerEntries.length && triggerEntries[0][1] / n >= 0.4) {
    insights.push(`"${triggerEntries[0][0]}" is their #1 trigger, appearing in ${Math.round(triggerEntries[0][1]/n*100)}% of all check-ins.`);
  }
  // Anxiety spike times
  const highAnxietyByTime = {};
  checkins.filter(c => c.anxiety >= 4).forEach(c => {
    highAnxietyByTime[c.time_of_day] = (highAnxietyByTime[c.time_of_day] || 0) + 1;
  });
  const anxietyPeakTime = Object.entries(highAnxietyByTime).sort((a, b) => b[1] - a[1])[0];
  if (anxietyPeakTime && anxietyPeakTime[1] >= 2) {
    insights.push(`High anxiety (4-5/5) hits most often in the ${anxietyPeakTime[0]} (${anxietyPeakTime[1]} times).`);
  }
  // Mood vs trigger correlation
  const trigMoodMap = {};
  checkins.forEach(c => {
    (c.triggers || []).forEach(t => {
      if (!trigMoodMap[t]) trigMoodMap[t] = [];
      trigMoodMap[t].push(c.mood_score || 2);
    });
  });
  const worstTrigger = Object.entries(trigMoodMap)
    .filter(([, v]) => v.length >= 2)
    .map(([t, scores]) => ({ t, avg: scores.reduce((s, v) => s + v, 0) / scores.length }))
    .sort((a, b) => a.avg - b.avg)[0];
  if (worstTrigger) {
    insights.push(`When "${worstTrigger.t}" is present, their avg mood drops to ${worstTrigger.avg.toFixed(1)}/4 — their lowest trigger-correlated mood.`);
  }
  // High anxiety note pattern
  const highAnxietyWithNotes = checkins.filter(c => c.anxiety >= 4 && c.note && c.note.trim().length > 5);
  if (highAnxietyWithNotes.length >= 2) {
    insights.push(`They tend to write notes during high-anxiety moments (${highAnxietyWithNotes.length} times) — these notes reveal what's really going on.`);
  }

  // ── SANDBOX-CLEAN cross-agent context (2026-05-23) ─────────────
  // Reads ONLY `cross_agent/today_signals` — the contract written by
  // wellness-cross-v2 + each agent's snapshot writer. No direct sibling
  // agent collection reads (sandbox law).
  let crossAgentBlock = '';
  try {
    const crossSnap = await userDoc(deviceId).collection('cross_agent').doc('today_signals').get();
    const crossSig  = crossSnap.exists ? crossSnap.data() : null;
    if (crossSig) {
      const sleepEntries = crossSig.recent_sleep_summary?.entries || [];
      const sleepPart = sleepEntries.length
        ? sleepEntries.slice(0, 3).map(e => {
            const d = e.date_str || e.date || 'recent';
            const dur = Number.isFinite(e.duration_hours) ? `${e.duration_hours}h` : '?h';
            const q   = Number.isFinite(e.quality_score) ? `${e.quality_score}/100` : '?/100';
            return `${d}: ${dur}, quality ${q}`;
          }).join(' | ')
        : 'No sleep logged';

      const waterPart = Number.isFinite(crossSig.water_intake_pct)
        ? `${crossSig.water_intake_pct}% of goal`
        : 'Not logged today';

      crossAgentBlock = `\n\n━━━ CROSS-AGENT CONTEXT ━━━\nRecent sleep (last 3 nights): ${sleepPart}\nToday's hydration: ${waterPart}\nNote: Mood tracks sleep with 1-day lag. Dehydration correlates with anxiety elevation.`;
    }
  } catch (_e) { /* non-fatal — skip cross-agent block */ }
  // ──────────────────────────────────────────────────────────────

  // ── LIVE ANALYSIS SIGNALS (2026-05-23) — same vocabulary user sees on Analysis tab ─
  // Coach answers with matching numbers, never contradicts the tab.
  let analysisSignalsBlock = '';
  try {
    const MS = require('./lib/mind-scoring');
    const anxiety_scores = (recentCheckins || []).slice(0, 30).map((c) => Number(c.anxiety_level || c.anxiety || 3));
    const mood_scores    = (recentCheckins || []).slice(0, 30).map((c) => Number(c.mood_score || c.mood || 2));
    // recent_sleep_hours pulled from cross_agent doc above (crossSig in scope here? no — re-read for safety)
    let recentSleepH = null;
    try {
      const xs2 = await userDoc(deviceId).collection('cross_agent').doc('today_signals').get();
      const xsd = xs2.exists ? xs2.data() : null;
      const ents = xsd?.recent_sleep_summary?.entries || [];
      if (ents.length) {
        const n = ents.filter((e) => Number.isFinite(e.duration_hours)).length;
        if (n > 0) recentSleepH = ents.reduce((s, e) => s + (Number(e.duration_hours) || 0), 0) / n;
      }
    } catch { /* non-fatal */ }
    const readiness = MS.computeCalmReadiness({ anxiety_scores, mood_scores, recent_sleep_hours: recentSleepH });
    const gran = MS.deriveEmotionGranularity((recentCheckins || []).slice(0, 30), 30);
    const depth = MS.deriveCheckinDepth((recentCheckins || []).slice(0, 30));
    const sortedDesc = (recentCheckins || []).slice().sort((a, b) => (b.date_str || '').localeCompare(a.date_str || ''));
    const plateau = MS.derivePlateauAnxiety({
      anxiety_scores: sortedDesc.map((c) => Number(c.anxiety_level || c.anxiety || 3)),
      dates: sortedDesc.map((c) => c.date_str),
    });
    const lines = [
      `Calm readiness ${readiness.readiness}/100, band=${readiness.band}.`,
      `Emotion granularity: ${gran.unique} unique feelings named${gran.stagnant ? ' (stagnant 30+ days)' : ''}.`,
      `Check-in depth: ${depth.deep_pct}% deep, ${depth.basic_pct}% basic, ${depth.mood_only_pct}% mood-only.`,
      plateau.stalled ? `Anxiety plateau: stuck at ${plateau.level}/5 for ${plateau.weeks_stalled} weeks.` : '',
    ].filter(Boolean);
    analysisSignalsBlock = lines.join('\n');
  } catch (_e) { /* non-fatal — coach falls back to other context */ }

  return `You are the Mind Coach in Pulse — a deeply personal AI mental health coach. You are NOT a generic AI assistant. You are not ChatGPT. You have been privately observing ${name} for ${daysLogged > 0 ? `${daysLogged} days` : 'the start of their journey'} across ${totalCount} total check-ins. You know them in ways no generic AI ever could.

Your rule: if you say something a stranger could have said, you have failed. Every sentence must reflect their specific data, their specific words, their specific patterns.

━━━ WHO THEY ARE ━━━
Name: ${name}
Age group: ${profile.age_group || 'not specified'}
Gender: ${profile.gender || 'not specified'}

━━━ WHAT THEY TOLD YOU AT SETUP ━━━
Primary challenge: ${setup.primary_challenge || 'general mental wellness'}
Starting baseline: ${setup.current_rating || '?'}/10 mood when they first arrived
Worst time of day (self-reported): ${setup.worst_time || 'varies'}
Triggers they identified at start: ${(setup.triggers || []).join(', ') || 'not set'}
What they've tried before: ${(setup.past_attempts || []).join(', ') || 'nothing specified'}
Social context: ${setup.social_context || 'not shared'}
Goals: ${(setup.goals || []).join(', ') || 'general wellbeing'}
Topics they want to discuss with you: ${(setup.discussion_topics || []).join(', ') || 'not specified'} — weave these into conversations naturally when relevant.

━━━ MOOD TRAJECTORY ━━━
Overall direction (last 5 logs): ${trajectory}
${yesterdayVsToday ? `Yesterday vs today: ${yesterdayVsToday}` : ''}

━━━ LAST 5 CHECK-INS (VERBATIM — reference these directly) ━━━
${last5Str || '  no check-ins yet'}

━━━ TODAY — ${dayName} ${timeLabel} ━━━
${todayStr}

━━━ ANXIETY ━━━
Trend: ${anxietyTrend}

━━━ PATTERNS ACROSS ALL ${totalCount} CHECK-INS ━━━
Top emotions (with frequency):
  ${topEmotions.join('\n  ') || 'not enough data'}
Top triggers (with frequency):
  ${topTriggers.join('\n  ') || 'not enough data'}
${timePatterns.length ? `Mood by time of day:\n  ${timePatterns.join('\n  ')}` : ''}
${worstDay ? `Worst day of week: ${worstDay}` : ''}
${bestDay ? `Best day of week: ${bestDay}` : ''}

━━━ LIVE ANALYSIS SIGNALS (same numbers user sees on Analysis tab) ━━━
${analysisSignalsBlock || 'Not enough check-ins yet for live signals.'}

━━━ WHAT THE DATA IS TELLING YOU (PRE-COMPUTED INSIGHTS) ━━━
${insights.length ? insights.map(i => `• ${i}`).join('\n') : '• Not enough data for pattern insights yet — keep observing.'}
${crossAgentBlock}

━━━ THEIR WORDS (recent notes they wrote) ━━━
${notesWithContext || '  no personal notes yet'}

━━━ ACTIONS ━━━
Completion rate: ${completionRate}
Currently active:
${activeActsStr}

━━━ INTENT DETECTION — read the message and respond accordingly ━━━
• VENTING / EMOTIONAL RELEASE ("I'm so stressed", "today was awful", "I can't handle this"):
  → Validate FIRST. Do not jump to advice or solutions. Reflect back what you heard using their words. One gentle question at the end — "what's the hardest part right now?"
• QUESTION / CURIOSITY ("why do I feel X", "what does this pattern mean", "is this normal"):
  → Answer it directly and specifically using their data. Don't be vague. Show them the numbers.
• ACTION REQUEST ("what should I do", "give me a plan", "how do I deal with X"):
  → Give 2–3 concrete, specific steps. Not "try meditation." Specific to their triggers, timing, and what's worked before.
• CASUAL / CHECKING IN ("how am I doing", "any updates"):
  → Lead with one sharp data observation they might not have noticed. Make it feel like their coach did their homework overnight.
• CRISIS SIGNAL ("I can't cope", "I don't want to", "everything is hopeless"):
  → Full presence. No advice. Acknowledge the weight of it. Ask one open question. Gently mention that talking to someone trained in this matters — without deflecting.

━━━ YOUR COACHING RULES ━━━
1. EVERY response must reference their actual data. Quote their note text. Cite their numbers. Name their specific triggers. A stranger could never say what you say.
2. Be warm, direct, human. Not clinical. Not fake-cheerful. Match their emotional register exactly.
3. Length: match the moment. Venting → shorter, warmer. Analysis question → longer, data-driven. End with ONE question unless they just need to feel heard.
4. Trajectory is your superpower. Declining → acknowledge it without drama. Improving → celebrate it with their specific numbers. Stable → help them find the next ceiling to break.
5. Pattern-spotting is your magic. "I've noticed every time [specific trigger] appears in your logs, your mood drops to [exact number] — usually in the [time slot]. Is that what it felt like this time?" These moments make this feel real.
6. High anxiety context (avg 3.5+, trending worse): be more present, more careful. Shorter sentences. More questions, less prescriptions.
7. Never fabricate patterns. If you need more data, say: "I'm starting to see something here — I want a couple more data points before I name it. What's been going on this week?"
8. You remember everything from past conversations. Reference previous threads naturally — not "as you mentioned before" but just by knowing.
9. Their discussion topics: ${(setup.discussion_topics || []).join(', ') || 'general wellbeing'} — when the conversation is open, steer toward these naturally.
10. Current moment: ${dayName} ${timeLabel}.`;
}

// ═══════════════════════════════════════════════════════════════
// ─── STATS COMPUTATION ────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

function computeStats(allCheckins) {
  const total = allCheckins.length;
  if (!total) return { total_checkins: 0, days_with_logs: 0 };

  // Group by date
  const byDate = {};
  allCheckins.forEach(c => {
    const d = c.date_str || dateStr(new Date(c.logged_at));
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(c);
  });
  const sortedDates = Object.keys(byDate).sort();
  const daysWithLogs = sortedDates.length;

  // Current streak (counting backwards from today)
  let streak = 0;
  const checkDate = new Date();
  for (let i = 0; i < 90; i++) {
    const ds = dateStr(checkDate);
    if (byDate[ds]) {
      streak++;
    } else if (i === 0) {
      // today not logged yet — check yesterday
      checkDate.setDate(checkDate.getDate() - 1);
      const ys = dateStr(checkDate);
      if (byDate[ys]) { streak++; } else break;
    } else {
      break;
    }
    checkDate.setDate(checkDate.getDate() - 1);
  }

  // Longest streak
  let longest = 1, run = 1;
  for (let i = 1; i < sortedDates.length; i++) {
    const diff = (new Date(sortedDates[i]) - new Date(sortedDates[i - 1])) / 86400000;
    run = diff === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  longest = Math.max(longest, streak);

  // Daily logs — last 30 days for bar chart
  const daily_logs = [];
  for (let i = 29; i >= 0; i--) {
    const d  = new Date(); d.setDate(d.getDate() - i);
    const ds = dateStr(d);
    const day = byDate[ds] || [];
    const avg = day.length
      ? parseFloat((day.reduce((s, c) => s + c.mood_score, 0) / day.length).toFixed(2))
      : null;
    daily_logs.push({ date: ds, avg_score: avg, count: day.length });
  }

  // Time-of-day breakdown
  const slots = { morning: [], afternoon: [], evening: [], night: [] };
  allCheckins.forEach(c => {
    const s = c.time_of_day || 'afternoon';
    if (slots[s]) slots[s].push(c.mood_score);
  });
  const time_breakdown = {};
  Object.entries(slots).forEach(([k, arr]) => {
    time_breakdown[k] = arr.length
      ? parseFloat((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2))
      : null;
  });

  // Emotion + trigger frequency
  const emotionMap = {}, triggerMap = {};
  allCheckins.forEach(c => {
    (c.emotions || []).forEach(e => { emotionMap[e] = (emotionMap[e] || 0) + 1; });
    (c.triggers || []).forEach(t => { triggerMap[t]  = (triggerMap[t]  || 0) + 1; });
  });
  const emotion_freq = Object.entries(emotionMap).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  const trigger_freq = Object.entries(triggerMap).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));

  // Anxiety trend — last 14 days
  const anxiety_trend = [];
  for (let i = 13; i >= 0; i--) {
    const d  = new Date(); d.setDate(d.getDate() - i);
    const ds = dateStr(d);
    const day = byDate[ds] || [];
    const avg = day.length
      ? parseFloat((day.reduce((s, c) => s + (c.anxiety || 1), 0) / day.length).toFixed(2))
      : null;
    anxiety_trend.push({ date: ds, avg_anxiety: avg });
  }

  const overall_anxiety = parseFloat(
    (
      allCheckins.reduce((sum, checkin) => sum + (checkin.anxiety || 1), 0) / total
    ).toFixed(2)
  );

  const anxietyByTime = { morning: [], afternoon: [], evening: [], night: [] };
  allCheckins.forEach(c => {
    const slot = c.time_of_day || 'afternoon';
    if (anxietyByTime[slot]) anxietyByTime[slot].push(c.anxiety || 1);
  });
  const anxiety_peak_time = Object.entries(anxietyByTime)
    .filter(([, values]) => values.length > 0)
    .map(([slot, values]) => ({
      slot,
      avg: values.reduce((sum, value) => sum + value, 0) / values.length,
    }))
    .sort((a, b) => b.avg - a.avg)[0]?.slot || null;

  // Week-on-week comparison
  const now = Date.now();
  const week1 = allCheckins.filter(c => { const a = (now - new Date(c.logged_at).getTime()) / 86400000; return a >= 7 && a < 14; });
  const week2 = allCheckins.filter(c => { const a = (now - new Date(c.logged_at).getTime()) / 86400000; return a < 7; });
  const week1_avg = week1.length ? parseFloat((week1.reduce((s, c) => s + c.mood_score, 0) / week1.length).toFixed(2)) : null;
  const week2_avg = week2.length ? parseFloat((week2.reduce((s, c) => s + c.mood_score, 0) / week2.length).toFixed(2)) : null;

  // Day-of-week averages (Sun=0 … Sat=6)
  const dowMap = {};
  allCheckins.forEach(c => {
    const dow = new Date(c.logged_at).getDay();
    if (!dowMap[dow]) dowMap[dow] = [];
    dowMap[dow].push(c.mood_score);
  });
  const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dow_avgs = Object.entries(dowMap)
    .map(([dow, scores]) => ({
      day: DOW_NAMES[+dow],
      avg: parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)),
      count: scores.length,
    }))
    .sort((a, b) => a.avg - b.avg); // sorted ascending: [0]=worst, [last]=best

  const overall_avg = parseFloat((allCheckins.reduce((s, c) => s + c.mood_score, 0) / total).toFixed(2));

  return {
    total_checkins:  total,
    days_with_logs:  daysWithLogs,
    streak,
    longest_streak:  longest,
    daily_logs,
    time_breakdown,
    emotion_freq,
    trigger_freq,
    anxiety_trend,
    overall_anxiety,
    anxiety_peak_time,
    week1_avg,
    week2_avg,
    overall_avg,
    dow_avgs,
  };
}

function formatHourLabel(dateObj) {
  return new Date(dateObj).toLocaleTimeString('en', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatAxisLabel(dateObj, sameDay) {
  if (sameDay) {
    return new Date(dateObj).toLocaleTimeString('en', {
      hour: 'numeric',
      minute: undefined,
    }).replace(' ', '');
  }

  return new Date(dateObj).toLocaleDateString('en', {
    month: 'short',
    day: 'numeric',
  });
}

function buildRecentSignalPoints(allCheckins) {
  // Group by date_str → daily averages → one point per unique day (up to 14 days)
  // Fixes: past-date entries excluded by .slice(-8), duplicate SVG key per same-day label
  const byDay = {};
  allCheckins.forEach(c => {
    const d = c.date_str || dateStr(c.logged_at instanceof Date ? c.logged_at : new Date(c.logged_at));
    if (!byDay[d]) byDay[d] = { anxiety: [], mood: [], emotions: [], triggers: [] };
    byDay[d].anxiety.push(c.anxiety || 1);
    byDay[d].mood.push(c.mood_score || 1);
    (c.emotions || []).forEach(e => byDay[d].emotions.push(e));
    (c.triggers || []).forEach(t => byDay[d].triggers.push(t));
  });

  const days = Object.keys(byDay).sort(); // ASC date order
  return days.slice(-14).map(ds => {
    const day = byDay[ds];
    const avg_anxiety = parseFloat((day.anxiety.reduce((a, b) => a + b, 0) / day.anxiety.length).toFixed(1));
    const avg_mood    = parseFloat((day.mood.reduce((a, b) => a + b, 0) / day.mood.length).toFixed(1));
    const d = new Date(ds + 'T12:00:00');
    const label = d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
    return {
      date_str:  ds,
      label,
      anxiety:    avg_anxiety,
      mood_score: avg_mood,
      emotions:   day.emotions,
      triggers:   day.triggers,
    };
  });
}

function buildRecentTimeline(allCheckins) {
  // Cap at 2 entries per day (max 10 total), most recent first
  // Fixes: when today has 10+ logs, past-date entries were never surfaced
  const sorted = [...allCheckins].sort((a, b) => new Date(b.logged_at) - new Date(a.logged_at));
  const dayCount = {};
  const result = [];

  for (const checkin of sorted) {
    const d = checkin.date_str || '';
    if (!dayCount[d]) dayCount[d] = 0;
    if (dayCount[d] >= 2) continue;
    if (result.length >= 10) break;
    dayCount[d]++;
    result.push(checkin);
  }

  return result.map(checkin => {
    const primaryEmotion = checkin.emotions?.[0] || checkin.mood || 'Logged';
    const noteLine = checkin.note ? checkin.note.split(/[.!?]/)[0].trim() : '';

    return {
      id:          checkin.id,
      mood:        checkin.mood || 'okay',
      mood_score:  checkin.mood_score || 0,
      anxiety:     checkin.anxiety || 1,
      emotions:    checkin.emotions  || [],
      triggers:    checkin.triggers  || [],
      note:        noteLine,
      time_of_day: checkin.time_of_day || 'afternoon',
      date_str:    checkin.date_str || dateStr(),
      time:        formatHourLabel(checkin.logged_at),
      emotion:     primaryEmotion,
      logged_at:   checkin.logged_at instanceof Date
        ? checkin.logged_at.toISOString()
        : new Date(checkin.logged_at).toISOString(),
    };
  });
}

function buildAnalysisObservations(setup, stats, signalPoints) {
  const observations = [];
  const topTrigger = stats.trigger_freq?.[0];
  const topEmotion = stats.emotion_freq?.[0];
  const peakTime = stats.anxiety_peak_time;

  if (peakTime) {
    observations.push({
      title: `Consistent ${peakTime[0].toUpperCase()}${peakTime.slice(1)} Peaks`,
      body: `Your anxiety runs highest in the ${peakTime}, which is where the coach should protect you first.`,
      accent: 'red',
    });
  }

  if (topTrigger?.name) {
    observations.push({
      title: `${topTrigger.name} Correlation`,
      body: `${topTrigger.name} appears in ${topTrigger.count} check-ins, making it your strongest repeat pressure point right now.`,
      accent: 'purple',
    });
  }

  if (topEmotion?.name && observations.length < 2) {
    observations.push({
      title: `${topEmotion.name} Keeps Repeating`,
      body: `${topEmotion.name} is showing up most often, so the goal is breaking the pattern before it hardens into your default state.`,
      accent: 'lavender',
    });
  }

  if (observations.length < 2 && signalPoints.length >= 2) {
    const first = signalPoints[0];
    const last = signalPoints[signalPoints.length - 1];
    const anxietyShift = (last.anxiety || 0) - (first.anxiety || 0);
    observations.push({
      title: anxietyShift > 0 ? 'Activation Is Climbing' : 'You Do Recover',
      body: anxietyShift > 0
        ? 'Your recent sessions are ending with higher anxiety than they start, which points to an unfinished stress loop.'
        : 'Your more recent sessions drop below your early ones, which means your system can settle when the right conditions show up.',
      accent: anxietyShift > 0 ? 'red' : 'green',
    });
  }

  return observations.slice(0, 2);
}

function buildCorrelationBars(setup, stats) {
  const topTriggers = (stats.trigger_freq || []).slice(0, 3);
  if (!topTriggers.length) {
    const fallback = (setup?.triggers || []).slice(0, 3);
    return fallback.map((label, index) => ({
      label,
      percent: [72, 54, 38][index] || 30,
      accent: index === 0 ? 'purple' : index === 1 ? 'red' : 'lavender',
    }));
  }

  const maxCount = topTriggers[0]?.count || 1;
  return topTriggers.map((item, index) => ({
    label: item.name,
    percent: Math.max(18, Math.min(92, Math.round((item.count / maxCount) * 100))),
    accent: index === 0 ? 'purple' : index === 1 ? 'red' : 'lavender',
  }));
}

function determineStage(stats) {
  const { total_checkins, days_with_logs, streak } = stats;
  if (days_with_logs >= 30)              return 5;
  if (days_with_logs >= 20)              return 4;
  if (days_with_logs >= 10)              return 3;
  if (days_with_logs >= 5 || streak >= 5) return 2;
  if (total_checkins >= 1)               return 1; // Show basic data from the very first check-in
  return 0;
}

function buildEarlyMindInsight(stats) {
  const topTrigger = stats.trigger_freq?.[0]?.name;
  const topEmotion = stats.emotion_freq?.[0]?.name;
  const avgMood = stats.overall_avg ? `${stats.overall_avg.toFixed(1)}/4` : '—';
  const avgAnxiety = stats.overall_anxiety ? `${stats.overall_anxiety.toFixed(1)}/5` : '—';
  const peakTime = stats.anxiety_peak_time ? ` Anxiety is hitting hardest in the ${stats.anxiety_peak_time}.` : '';
  const triggerLine = topTrigger ? ` ${topTrigger} is the trigger showing up most.` : '';
  const emotionLine = topEmotion ? ` ${topEmotion} is the feeling appearing most often.` : '';

  return `You already have a real signal: mood is averaging ${avgMood} while anxiety is averaging ${avgAnxiety}.${triggerLine}${emotionLine}${peakTime} This is enough to start tracking your anxiety pattern instead of treating every hard moment like a random one.`;
}

// ═══════════════════════════════════════════════════════════════
// ─── ANALYSIS INSIGHT GENERATOR ───────────────────────────────
// ═══════════════════════════════════════════════════════════════

async function generateAnalysisInsight(setup, stats) {
  const {
    emotion_freq     = [],
    trigger_freq     = [],
    time_breakdown   = {},
    dow_avgs         = [],
    week1_avg,
    week2_avg,
    overall_avg,
    overall_anxiety,
    anxiety_peak_time,
    streak,
    total_checkins,
    days_with_logs,
  } = stats;

  const topEmotion = emotion_freq[0]?.name || 'mixed';
  const topTrigger = trigger_freq[0]?.name;
  const worstDay   = dow_avgs[0];
  const bestDay    = dow_avgs[dow_avgs.length - 1];

  const bestTime  = Object.entries(time_breakdown).filter(([, v]) => v !== null).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const worstTime = Object.entries(time_breakdown).filter(([, v]) => v !== null).sort((a, b) => a[1] - b[1])[0]?.[0] || null;

  // Setup context for personalization
  const primaryChallenge = setup.primary_challenge || 'general mental wellness';
  const setupTriggers    = (setup.triggers || []).join(', ') || null;
  const setupGoals       = (setup.goals || []).join(', ') || null;
  const worstSetupTime   = setup.worst_time || null;

  // Task calibrated by check-in volume — not stage
  let taskLine;
  if (total_checkins >= 15) {
    taskLine = `Generate a PERSONAL FORMULA: their conditions for anxiety regulation. Synthesize which time of day they feel safest (best: ${bestTime || 'unclear'}), which triggers to protect against, and what the current mood trajectory means for the coming week. Be direct — "your pattern is: [X] + [Y] → anxiety stays below [N]." Note if week-over-week trend is improving or declining${week1_avg != null && week2_avg != null ? ` (last week avg ${week2_avg}/4, this week avg ${week1_avg}/4)` : ''}.`;
  } else if (total_checkins >= 8) {
    const direction = (week1_avg != null && week2_avg != null)
      ? (week1_avg < week2_avg ? 'improving' : week1_avg > week2_avg ? 'declining' : 'stable')
      : 'building';
    taskLine = `Full pattern insight. Week-over-week mood trend: ${direction}${week1_avg != null ? ` (last week ${week2_avg ?? '?'}/4 → this week ${week1_avg ?? '?'}/4)` : ''}. Worst day: ${worstDay ? `${worstDay.day} (${worstDay.avg}/4)` : 'unclear'}. Best day: ${bestDay ? `${bestDay.day} (${bestDay.avg}/4)` : 'unclear'}. Best time of day: ${bestTime || 'unclear'}. Anxiety peak: ${anxiety_peak_time || 'unclear'}. Write a pattern insight that connects the anxiety loop to the specific trigger and timing — name the loop, not just the numbers.`;
  } else if (total_checkins >= 4) {
    const topTrigText = topTrigger ? `"${topTrigger}" in ${trigger_freq[0]?.count} of ${total_checkins} check-ins` : 'no clear trigger yet';
    taskLine = `First real pattern observation — ${total_checkins} check-ins in. Worst day: ${worstDay ? `${worstDay.day} (${worstDay.avg}/4)` : 'unknown'}. Best time: ${bestTime || 'unclear'}. Worst time: ${worstTime || 'unclear'}. Anxiety peak: ${anxiety_peak_time || 'unclear'}. Top trigger: ${topTrigText}. Name the emerging anxiety cycle specifically — connect two dots the user hasn't connected themselves.`;
  } else {
    taskLine = `Early signal — only ${total_checkins} check-in${total_checkins === 1 ? '' : 's'}. Most common emotion: ${topEmotion}${topTrigger ? `. First trigger appearing: "${topTrigger}"` : ''}. Mood avg: ${overall_avg != null ? `${overall_avg.toFixed(1)}/4` : '—'}. Anxiety avg: ${overall_anxiety != null ? `${overall_anxiety.toFixed(1)}/5` : '—'}${anxiety_peak_time ? `. Anxiety hitting hardest in the ${anxiety_peak_time}` : ''}. Write 2 sharp sentences: what's already visible in the data, and what pattern to watch for next. Reference their stated challenge if it matches.`;
  }

  const prompt = `You are the Mind Coach insight engine for Pulse — a premium mental health tracking app.

User profile:
- Primary challenge: ${primaryChallenge}
- Triggers they identified at setup: ${setupTriggers || 'not specified'}
- Goals: ${setupGoals || 'general wellbeing'}
- Worst time of day (self-reported at setup): ${worstSetupTime || 'varies'}

Check-in data so far:
- Total check-ins: ${total_checkins} across ${days_with_logs} day${days_with_logs === 1 ? '' : 's'}
- Current streak: ${streak} day${streak === 1 ? '' : 's'}
- Mood average: ${overall_avg != null ? `${overall_avg.toFixed(1)}/4` : '—'} (1=low, 2=okay, 3=good, 4=great)
- Anxiety average: ${overall_anxiety != null ? `${overall_anxiety.toFixed(1)}/5` : '—'}
- Peak anxiety time: ${anxiety_peak_time || 'unclear'}
- Top emotions: ${emotion_freq.slice(0, 4).map(e => `${e.name}×${e.count}`).join(', ') || 'none yet'}
- Top triggers: ${trigger_freq.slice(0, 3).map(t => `${t.name}×${t.count}`).join(', ') || 'none yet'}
- Mood by time of day: ${['morning','afternoon','evening','night'].map(s => `${s} ${time_breakdown[s] != null ? time_breakdown[s].toFixed(1) : '—'}/4`).join(', ')}

TASK: ${taskLine}

RULES:
- Reference real numbers — never say "you seem to" when you have data
- Cross-reference what they said at setup against what the data actually shows (e.g. setup trigger matches logged trigger → name it)
- Sound like a sharp, warm therapist-coach who did their homework overnight — not an app notification
- 2–4 sentences (tighter is better)
- Zero empty encouragement ("great job", "keep it up", "amazing", "well done")
- Return valid JSON only: { "insight": "...", "formula": null }
  (formula field: only include a non-null value if 15+ check-ins and a formula was explicitly generated)`;

  try {
    const completion = await openai.chat.completions.create({
      model: AI.REASONING_PRO,
      max_completion_tokens: 420,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw     = completion.choices[0].message.content.trim();
    const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    const parsed  = JSON.parse(cleaned);
    return { insight: parsed.insight || null, formula: parsed.formula || null };
  } catch (err) {
    log.error('[mind] insight gen error:', err.message);
    return { insight: buildEarlyMindInsight(stats), formula: null };
  }
}

// ═══════════════════════════════════════════════════════════════
// ─── OPENING CHAT MESSAGE ─────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

function buildOpeningMessage(name, primary_challenge, triggers) {
  const firstName = name ? name.trim().split(' ')[0] : '';
  const greeting  = firstName ? `Hey ${firstName}.` : 'Hey.';
  const challenge = primary_challenge ? primary_challenge.toLowerCase() : 'your mental wellness';
  const triggerLine = triggers && triggers.length > 0
    ? `, and ${triggers[0].toLowerCase()} is showing up as a key factor`
    : '';

  return `${greeting} Your Mind Coach is set up. I've read through your answers — ${challenge} is your main focus right now${triggerLine}. I'm here whenever you need me. No appointments. No judgment. What's on your mind?`;
}

// ═══════════════════════════════════════════════════════════════
// ─── PROACTIVE MESSAGE LOGIC ──────────────────────────────────
// Runs at 10am and 8pm. Max 1 proactive message per user per day
// (anxiety spike is handled inline in /checkin and bypasses this).
// ═══════════════════════════════════════════════════════════════

async function runProactiveChecks() {
  try {
    const usersSnap = await db()
      .collection('wellness_users')
      .where('mind_setup_complete', '==', true)
      .get();

    if (usersSnap.empty) return;

    const today = dateStr();
    const hour  = new Date().getHours();

    for (const uDoc of usersSnap.docs) {
      const deviceId = uDoc.id;
      const userData = uDoc.data();

      if (userData.last_mind_proactive_date === today) continue;

      try {
        const mindSnap = await mindDoc(deviceId).get();
        if (!mindSnap.exists || !mindSnap.data().setup_completed) continue;

        const recentSnap = await checkinsCol(deviceId)
          .orderBy('logged_at', 'desc')
          .limit(25)
          .get();

        const recent = recentSnap.docs.map(d => ({
          ...d.data(),
          logged_at: d.data().logged_at?.toDate?.() || new Date(),
        }));

        const todayLogs  = recent.filter(c => c.date_str === today);
        const streakCount = computeStreakFast(recent);

        let msg  = null;
        let type = null;

        // ── Mood drop: last 3 all Low, was better before ──
        const last3 = recent.slice(0, 3);
        if (
          last3.length === 3 &&
          last3.every(c => c.mood === 'low') &&
          recent[3] && ['okay', 'good', 'great'].includes(recent[3].mood)
        ) {
          msg  = "I've noticed you've been feeling low for a few check-ins in a row. That's hard to sit with. What's been going on?";
          type = 'mood_drop';
        }

        // ── Positive progress: this week measurably better ──
        if (!msg) {
          const thisWeek = recent.filter(c => (Date.now() - new Date(c.logged_at).getTime()) < 7 * 86400000);
          const lastWeek = recent.filter(c => {
            const a = (Date.now() - new Date(c.logged_at).getTime()) / 86400000;
            return a >= 7 && a < 14;
          });
          if (thisWeek.length >= 5 && lastWeek.length >= 5) {
            const tw = thisWeek.reduce((s, c) => s + c.mood_score, 0) / thisWeek.length;
            const lw = lastWeek.reduce((s, c) => s + c.mood_score, 0) / lastWeek.length;
            if (tw - lw >= 0.5) {
              msg  = `Something worth noting — your mood average this week is measurably higher than last week. What do you think made the difference?`;
              type = 'positive_progress';
            }
          }
        }

        // ── Sunday evening weekly summary ──
        if (!msg && new Date().getDay() === 0 && hour >= 19) {
          const weekLogs = recent.filter(c => (Date.now() - new Date(c.logged_at).getTime()) < 7 * 86400000);
          if (weekLogs.length >= 3) {
            const avgMood    = (weekLogs.reduce((s, c) => s + c.mood_score, 0) / weekLogs.length).toFixed(1);
            const topEmotion = mostCommon(weekLogs.flatMap(c => c.emotions || []));
            const topTrigger = mostCommon(weekLogs.flatMap(c => c.triggers || []));
            msg = `Your week: ${weekLogs.length} check-ins, average mood ${avgMood}/4.${topEmotion ? ` ${topEmotion} was your most felt emotion.` : ''}${topTrigger ? ` ${topTrigger} showed up most as a trigger.` : ''} What's one thing you want to do differently next week?`;
            type = 'weekly_summary';
          }
        }

        // ── Discussion topic (fallback) ──
        // Suppressed if user already checked in today (they're engaged).
        // Capped at 3x per week to avoid topic fatigue.
        if (!msg && todayLogs.length === 0) {
          const mindData    = mindSnap.data() || {};
          const topics      = mindData.discussion_topics || [];
          const topicIndex  = mindData.proactive_topic_index || 0;
          const firstName   = (userData.name || '').split(' ')[0] || '';

          if (topics.length > 0) {
            const weekKey   = getWeekKey();
            const sameWeek  = mindData.proactive_topic_week === weekKey;
            const weekCount = sameWeek ? (mindData.proactive_topic_week_count || 0) : 0;

            if (weekCount < 3) {
              const topic = topics[topicIndex % topics.length];
              msg  = await buildTopicProactive(topic, firstName, recent, mindData);
              type = 'discussion_topic';

              await mindDoc(deviceId).update({
                proactive_topic_index:      (topicIndex + 1) % topics.length,
                proactive_topic_week:       weekKey,
                proactive_topic_week_count: weekCount + 1,
              });
            }
          }
        }

        if (msg) {
          await chatsCol(deviceId).add({
            role:           'assistant',
            content:        msg,
            is_proactive:   true,
            proactive_type: type,
            is_read:        false,
            created_at:     admin.firestore.FieldValue.serverTimestamp(),
          });
          await db().collection('wellness_users').doc(deviceId).update({
            last_mind_proactive_date: today,
          });
        }
      } catch (uErr) {
        log.error(`[mind] proactive failed for ${deviceId}:`, uErr.message);
      }
    }
  } catch (err) {
    log.error('[mind] proactive checks error:', err);
  }
}

// ─── Anxiety spike proactive — GPT-generated, personal ────────

async function buildAnxietyProactive(name, anxiety, emotions, triggers, note, recentCheckins, mindData) {
  const greeting   = name ? `${name}, ` : '';
  const challenge  = mindData.primary_challenge || 'mental wellness';
  const last3      = recentCheckins.slice(0, 3);
  const recentStr  = last3.map(c =>
    `${c.date_str} ${c.time_of_day}: anxiety=${c.anxiety}/5 mood=${c.mood}` +
    (c.triggers?.length ? ` triggers=[${c.triggers.join(',')}]` : '') +
    (c.note ? ` note="${c.note}"` : '')
  ).join('\n');

  const prompt = `You are a personal Mind Coach in the Pulse wellness app. ${name} just logged anxiety ${anxiety}/5 — that's high. Reach out right now.

WHAT THEY JUST LOGGED:
Anxiety: ${anxiety}/5
Emotions: ${emotions.join(', ') || 'not specified'}
Triggers: ${triggers.join(', ') || 'not specified'}
Note: ${note || 'none'}

THEIR RECENT PATTERN:
${recentStr || 'first few logs'}

Primary challenge they're working on: ${challenge}

Write ONE short message (2-3 sentences max). Rules:
- Acknowledge specifically what they just logged — name the triggers or emotions if they logged them, or the anxiety level
- Don't give a lecture. Be present, not prescriptive.
- Offer ONE specific thing: either a quick grounding technique tied to their pattern, or simply invite them to talk
- Sound like a caring human who's been watching their data, not a bot
- No generic wellness speak. No "I'm here for you" without context.
- End with a question or an open invitation to respond.`;

  try {
    const completion = await openai.chat.completions.create({
      model: AI.REASONING_PRO,
      max_completion_tokens: 160,
      messages: [{ role: 'user', content: prompt }],
    });
    return completion.choices[0].message.content.trim();
  } catch {
    return `${greeting}you just logged anxiety at ${anxiety}/5 — that's one of your higher readings. What's going on right now?`;
  }
}

// ─── Streak milestone proactive ───────────────────────────────

async function buildStreakProactive(name, streakDays, mindData) {
  const greeting  = name ? `${name}, ` : '';
  const challenge = mindData.primary_challenge || 'mental wellness';
  const prompt = `You are a personal Mind Coach in the Pulse wellness app. ${name} just hit a ${streakDays}-day logging streak — that's a real milestone worth acknowledging.

Primary challenge they're working on: ${challenge}

Write ONE short message (2-3 sentences max). Rules:
- Acknowledge the streak number specifically
- Connect it to the fact that data consistency is what lets you coach them properly — make it feel meaningful, not like a gamification badge
- Be warm but not sycophantic. Don't say "amazing!" or "great job!"
- End with one forward-looking observation or question.`;

  try {
    const completion = await openai.chat.completions.create({
      model: AI.REASONING_PRO,
      max_completion_tokens: 130,
      messages: [{ role: 'user', content: prompt }],
    });
    return completion.choices[0].message.content.trim();
  } catch {
    return `${greeting}${streakDays} days of logging — that consistency is exactly what gives me something real to work with. How are you feeling about the progress so far?`;
  }
}

// ─── Topic-specific proactive message ────────────────────────
// GPT-4o generates a short, personal check-in around the user's
// chosen discussion topic, woven with their actual recent data.
async function buildTopicProactive(topic, firstName, recentCheckins, mindData) {
  const greeting   = firstName ? `${firstName}, ` : '';
  const challenge  = mindData.primary_challenge || 'mental wellness';
  const last3      = recentCheckins.slice(0, 3);
  const avgAnxiety = last3.length
    ? (last3.reduce((s, c) => s + (c.anxiety || 1), 0) / last3.length).toFixed(1)
    : null;
  const topEmotion = last3.length ? (last3[0].emotions?.[0] || null) : null;

  const contextLine = avgAnxiety
    ? `Recent anxiety average: ${avgAnxiety}/5.${topEmotion ? ` Most felt emotion lately: ${topEmotion}.` : ''}`
    : 'No recent check-ins yet.';

  const prompt = `You are a direct, warm mental wellness coach reaching out proactively in a chat app.

Write ONE short message (2-4 sentences max) to check in with this user about their chosen topic.

User's first name: ${firstName || 'not given'}
Their primary challenge: ${challenge}
Today's discussion topic: ${topic}
${contextLine}

Rules:
- Start with the topic naturally, not "Hey I wanted to check in about..."
- Reference their actual data if available (anxiety level, emotion) — not generic platitudes
- End with ONE specific question that invites them to respond
- Tone: direct and warm, like a coach who actually knows them
- Do NOT use emojis
- Do NOT mention that this is a scheduled message
- Keep it under 60 words

Return only the message text, no quotes, no explanation.`;

  try {
    const completion = await openai.chat.completions.create({
      model: AI.REASONING_PRO,
      max_completion_tokens: 120,
      messages: [{ role: 'user', content: prompt }],
    });
    return completion.choices[0].message.content.trim();
  } catch {
    // Fallback template
    return `${greeting}you flagged ${topic.toLowerCase()} as something you want to work on. Given where your head has been lately — what's one thing about that you'd want to talk through today?`;
  }
}

function computeStreakFast(recentCheckins) {
  const dates = [...new Set(recentCheckins.map(c => c.date_str).filter(Boolean))].sort().reverse();
  if (!dates.length) return 0;
  let streak = 0;
  const cursor = new Date();
  for (let i = 0; i < dates.length; i++) {
    const expected = dateStr(cursor);
    if (dates[i] === expected) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else if (i === 0 && dates[0] === dateStr(new Date(Date.now() - 86400000))) {
      streak++;
      cursor.setDate(cursor.getDate() - 2);
    } else {
      break;
    }
  }
  return streak;
}

function mostCommon(arr) {
  if (!arr.length) return null;
  const counts = {};
  arr.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

// Returns the Monday date string of the current week (week boundary key)
function getWeekKey(d = new Date()) {
  const diff = (d.getDay() + 6) % 7; // days since Monday (Mon=0)
  const mon = new Date(d);
  mon.setDate(d.getDate() - diff);
  return dateStr(mon);
}

// ═══════════════════════════════════════════════════════════════
// ─── EVENING STREAK REMINDERS — runs at 8pm ───────────────────
// Separate from morning checks so a morning topic push doesn't
// block the more valuable behaviour-triggered streak reminder.
// ═══════════════════════════════════════════════════════════════
async function runStreakReminders() {
  try {
    const usersSnap = await db()
      .collection('wellness_users')
      .where('mind_setup_complete', '==', true)
      .get();

    if (usersSnap.empty) return;

    const today = dateStr();

    for (const uDoc of usersSnap.docs) {
      const deviceId = uDoc.id;
      const userData = uDoc.data();

      if (userData.last_streak_reminder_date === today) continue;

      try {
        const mindSnap = await mindDoc(deviceId).get();
        if (!mindSnap.exists || !mindSnap.data().setup_completed) continue;

        const recentSnap = await checkinsCol(deviceId)
          .orderBy('logged_at', 'desc')
          .limit(25)
          .get();

        const recent = recentSnap.docs.map(d => ({
          ...d.data(),
          logged_at: d.data().logged_at?.toDate?.() || new Date(),
        }));

        const todayLogs   = recent.filter(c => c.date_str === today);
        const streakCount = computeStreakFast(recent);

        if (todayLogs.length === 0 && streakCount >= 3) {
          const firstName = (userData.name || '').split(' ')[0];
          const msg = `Hey${firstName ? ' ' + firstName : ''} — you haven't logged today yet. Your ${streakCount}-day streak is worth protecting. Even one quick check-in. How are you doing right now?`;

          await chatsCol(deviceId).add({
            role:           'assistant',
            content:        msg,
            is_proactive:   true,
            proactive_type: 'streak_at_risk',
            is_read:        false,
            created_at:     admin.firestore.FieldValue.serverTimestamp(),
          });
          await db().collection('wellness_users').doc(deviceId).update({
            last_streak_reminder_date: today,
          });
        }
      } catch (uErr) {
        log.error(`[mind] streak reminder failed for ${deviceId}:`, uErr.message);
      }
    }
  } catch (err) {
    log.error('[mind] streak reminders error:', err);
  }
}

// ═══════════════════════════════════════════════════════════════
// ─── CRON ─────────────────────────────────────────────────────
// Morning: full proactive suite (mood drop, progress, topic)
// Evening: streak-at-risk only (behaviour-triggered, highest value)
// ═══════════════════════════════════════════════════════════════
if (shouldRunCron()) {
  cron.schedule('0 10 * * *', withCron('mind:morning-proactive', async () => {
    await runProactiveChecks();
  }, { ttlMs: 20 * 60_000 }), { timezone: 'UTC' });
  cron.schedule('0 20 * * *', withCron('mind:evening-streak', async () => {
    await runStreakReminders();
  }, { ttlMs: 20 * 60_000 }), { timezone: 'UTC' });
}

// Pre-warm /analysis cache for active users every night at 02:30.
// Skips users with 0 check-ins. Best-effort, never blocks startup.
async function preWarmAnalysisV2() {
  const usersSnap = await db().collection('wellness_users').limit(500).get();
  let warmed = 0;
  for (const u of usersSnap.docs) {
    const id = u.id;
    try {
      const checkSnap = await mindDoc(id).collection('mind_checkins').limit(1).get();
      if (checkSnap.empty) continue;
      const { resolveUserLanguage } = require('./lib/i18n-prompt');
      const language = await resolveUserLanguage(db(), id);
      await mindAnalytics.loadAnalysisV2(id, 30, { openai, language });
      warmed++;
    } catch { /* per-user non-fatal */ }
  }
  log.info(`[mind:pre-warm] warmed=${warmed}/${usersSnap.size}`);
}
if (shouldRunCron()) {
  cron.schedule('30 2 * * *', withCron('mind:pre-warm-v2', preWarmAnalysisV2, {
    ttlMs: 20 * 60_000,
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
      db: admin.firestore(), deviceId, coach: 'mind', days,
    });
    res.json(payload);
  } catch (err) {
    res.json({ has_data: false, cards: [] });
  }
});

module.exports = router;
