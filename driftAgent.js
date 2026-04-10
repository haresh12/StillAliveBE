const express = require('express');
const { OpenAI } = require('openai');

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let db;
function setDb(firestoreDb) {
  db = firestoreDb;
}

const userRef = (uid) => db.collection('wellness_users').doc(uid);
const agentRef = (uid) => userRef(uid).collection('wellness_agents').doc('drift');
const messagesRef = (uid) => agentRef(uid).collection('wellness_messages');
const logsRef = (uid) => agentRef(uid).collection('daily_logs');
const actionsRef = (uid) => userRef(uid).collection('wellness_actions');
const scheduledRef = (uid) => userRef(uid).collection('wellness_scheduled');

const DRIFT_SETUP_CONFIG = {
  version: 1,
  intro: {
    eyebrow: 'DRIFT',
    title: 'Let’s set up your sleep assistant.',
    body: 'A few quick choices, then DRIFT sets your bedtime reminders and morning check-in.',
  },
  questions: [
    {
      id: 'main_issue',
      type: 'choice',
      title: 'What feels most off with your sleep?',
      options: [
        'Falling asleep',
        'Waking up during the night',
        'Waking too early',
        'Sleeping enough but still exhausted',
        'My schedule is a mess',
        'A bit of everything',
      ],
    },
    {
      id: 'sleep_blockers',
      type: 'multiselect',
      title: 'What usually gets in the way at night?',
      options: [
        'Phone',
        'Late work',
        'Stress or overthinking',
        'No routine',
        'Noise or other people',
        "I don't really know",
      ],
    },
    {
      id: 'bad_night_pattern',
      type: 'choice',
      title: 'When does it usually go wrong?',
      options: [
        'Work nights',
        'Stress nights',
        'Weekend nights',
        'Most nights',
        'Random nights',
      ],
    },
    {
      id: 'target_sleep_time',
      type: 'time',
      title: 'What time do you want to be asleep?',
      defaultValue: '11:00 PM',
    },
    {
      id: 'target_wake_time',
      type: 'time',
      title: 'What time do you usually wake up?',
      defaultValue: '7:00 AM',
    },
    {
      id: 'morning_state',
      type: 'choice',
      title: 'How do mornings usually feel?',
      options: ['Dead', 'Heavy and slow', 'Functional but tired', 'Mostly okay', 'Good'],
    },
    {
      id: 'primary_goal',
      type: 'choice',
      title: 'What do you want DRIFT to improve first?',
      options: [
        'Fall asleep faster',
        'Wake less during the night',
        'Feel rested in the morning',
        'Fix my sleep schedule',
        'Stop revenge bedtime',
        "Figure out what's actually wrong",
      ],
    },
    {
      id: 'drift_style',
      type: 'choice',
      title: 'How should DRIFT sound?',
      options: ['Gentle', 'Direct', 'Practical', 'Short and simple'],
    },
    {
      id: 'auto_actions',
      type: 'multiselect',
      title: 'Which actions do you want DRIFT to run for you?',
      options: [
        'Get ready for bed reminder',
        'Phone down reminder',
        'Good night reminder',
        'Morning sleep check-in',
      ],
    },
  ],
};

const DRIFT_IDENTITY = {
  name: 'DRIFT',
  domain: 'sleep, recovery, nightly routines, circadian rhythm, wake quality',
  corePrompt: `You are DRIFT, a premium sleep operator inside Pulse.

WHO YOU ARE:
You help one specific person sleep better by noticing patterns, setting better actions, and following through. You are not a generic sleep bot. You are sharp, calm, and specific.

VOICE:
Short. Grounded. Direct. No fluff. No therapist cliches. No generic sleep hygiene lectures. Usually 2 to 4 sentences.

HOW YOU HELP:
You connect what the user says tonight to what has been happening lately. You use their setup, active actions, timing, and recent sleep reports. You make sleep feel manageable without sounding soft or robotic.

RULES:
- One question max.
- No lists in normal chat.
- If the user is venting, validate first.
- If the user asks what to do, give one clear move.
- If the moment is urgent, be more directive.
- Always sound like you actually remember this person.`,
};

const QUICK_REPLIES = {
  normal: ['Mind racing', 'Still working', 'Sleep was bad', 'Need a plan'],
  evening_checkin: ['Still working', 'Mind racing', 'On my phone', 'Ready for bed'],
  morning_checkin: ['Sleep 8/10', 'Woke up twice', 'Still tired', 'Fell asleep fast'],
  rescue: ["Can't sleep", 'Woke up again', 'Anxious', 'Need help tonight'],
  action_followup: ['Did it', 'Skipped it', 'Wrong timing', 'Too hard'],
};

const ACTION_TYPE_META = {
  wind_down: { title: 'Get Ready for Bed', bucket: 'Before Bed' },
  morning_checkin: { title: 'Morning Check-In', bucket: 'After You Wake' },
  good_night: { title: 'Good Night', bucket: 'At Bedtime' },
  phone_off: { title: 'Phone Down', bucket: 'Before Bed' },
  work_cutoff: { title: 'Work Cutoff', bucket: 'Before Bed' },
  brain_dump: { title: 'Brain Dump', bucket: 'Before Bed' },
  weekend_sleep_guard: { title: 'Weekend Sleep Guard', bucket: 'Always On' },
  recovery_mode: { title: 'Recovery Mode', bucket: 'Always On' },
  sleep_experiment: { title: 'Sleep Experiment', bucket: 'Experiments' },
  user_commitment: { title: 'Commitment', bucket: 'Always On' },
  tonight_rescue: { title: 'Tonight Rescue', bucket: 'Tonight' },
};
const DRIFT_SLEEP_CYCLE_OFFSETS = {
  wind_down: -45,
  phone_off: -30,
  good_night: 0,
};

function nowIso() {
  return new Date().toISOString();
}

function parseTimeToDate(timeStr, baseDate = new Date()) {
  try {
    if (!timeStr) return null;
    const [time, meridiem] = timeStr.trim().split(' ');
    const [hourRaw, minuteRaw] = time.split(':');
    let hour = parseInt(hourRaw, 10);
    const minute = parseInt(minuteRaw, 10);
    if (meridiem === 'PM' && hour !== 12) hour += 12;
    if (meridiem === 'AM' && hour === 12) hour = 0;
    const d = new Date(baseDate);
    d.setHours(hour, minute, 0, 0);
    return d;
  } catch {
    return null;
  }
}

function formatTime(date) {
  const h = date.getHours();
  const m = date.getMinutes();
  const meridiem = h >= 12 ? 'PM' : 'AM';
  const displayH = h % 12 === 0 ? 12 : h % 12;
  return `${displayH}:${String(m).padStart(2, '0')} ${meridiem}`;
}

function addMinutes(timeStr, minutes) {
  const base = parseTimeToDate(timeStr);
  if (!base) return timeStr;
  base.setMinutes(base.getMinutes() + minutes);
  return formatTime(base);
}

function subtractMinutes(timeStr, minutes) {
  return addMinutes(timeStr, -minutes);
}

function getNextTriggerAt(schedule) {
  if (!schedule) return null;
  const now = new Date();

  if (schedule.kind === 'daily' && schedule.time) {
    const d = parseTimeToDate(schedule.time, now);
    if (!d) return null;
    if (d <= now) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }

  if (schedule.kind === 'weekly' && schedule.time) {
    const targetDays = {
      sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
    };
    const allowed = (schedule.days || []).map((day) => targetDays[day]).filter((n) => n !== undefined);
    if (allowed.length === 0) return null;
    let best = null;
    for (let i = 0; i < 8; i += 1) {
      const d = new Date(now);
      d.setDate(now.getDate() + i);
      if (!allowed.includes(d.getDay())) continue;
      const at = parseTimeToDate(schedule.time, d);
      if (at && at > now && (!best || at < best)) best = at;
    }
    if (!best) {
      const d = new Date(now);
      d.setDate(now.getDate() + 7);
      best = parseTimeToDate(schedule.time, d);
    }
    return best ? best.toISOString() : null;
  }

  if (schedule.kind === 'one_time' && schedule.time) {
    const d = parseTimeToDate(schedule.time, now);
    if (!d) return null;
    if (d <= now) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }

  return null;
}

function isDriftSleepCycleType(type) {
  return Object.prototype.hasOwnProperty.call(DRIFT_SLEEP_CYCLE_OFFSETS, type);
}

function getBedtimeAnchorFromAction(type, time) {
  return addMinutes(time, Math.abs(DRIFT_SLEEP_CYCLE_OFFSETS[type] || 0));
}

function buildSleepCycleTimesFromBedtime(bedtimeTime) {
  return Object.fromEntries(
    Object.entries(DRIFT_SLEEP_CYCLE_OFFSETS).map(([type, offset]) => [
      type,
      addMinutes(bedtimeTime, offset),
    ])
  );
}

function normalizeChoiceArray(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function deriveSleepRisk(profile, state = {}) {
  let score = 0;
  if (profile.severity === 'Barely functioning') score += 3;
  if (profile.severity === 'Rough but manageable') score += 2;
  if (profile.bad_night_pattern === 'Most nights') score += 2;
  if (profile.main_issue === 'All of it honestly') score += 1;
  if ((state.lastSleepRating || 10) <= 4) score += 2;
  if ((state.lastMorningEnergy || 5) <= 2) score += 1;
  if ((state.sleepStreak || 0) >= 3) score -= 1;
  if (score >= 5) return 'high';
  if (score >= 3) return 'medium';
  return 'low';
}

async function getOrCreateUser(userId, userName = '') {
  const ref = userRef(userId);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({
      userId,
      name: userName || '',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      conversationDays: 0,
    }, { merge: true });
  } else if (userName && snap.data().name !== userName) {
    await ref.set({ name: userName, updatedAt: nowIso() }, { merge: true });
  }
  return (await ref.get()).data();
}

function emptyDriftState() {
  return {
    agentId: 'drift',
    setupComplete: false,
    setupProgress: 0,
    profile: {},
    setupAnswers: {},
    sleepStreak: 0,
    lastSleepRating: null,
    lastMorningEnergy: null,
    lastReportedWakeups: null,
    lastSleepIssue: null,
    lastSleepCause: null,
    lastRequestedSleepChange: null,
    currentMode: 'normal',
    activeFocus: null,
    currentExperiment: null,
    currentRiskLevel: 'medium',
    analysis: null,
    conversationCount: 0,
    lastInteractionAt: null,
    lastProactiveAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

async function getOrCreateDriftState(userId) {
  const ref = agentRef(userId);
  const snap = await ref.get();
  if (!snap.exists) {
    const initial = emptyDriftState();
    await ref.set(initial, { merge: true });
    return initial;
  }
  return { ...emptyDriftState(), ...snap.data() };
}

async function getDriftMessages(userId, limit = 60) {
  const snap = await messagesRef(userId).orderBy('timestamp', 'asc').limit(limit).get();
  return snap.docs.map((doc) => doc.data());
}

async function getDriftActions(userId) {
  const snap = await actionsRef(userId)
    .orderBy('createdAt', 'desc')
    .limit(100)
    .get();
  return snap.docs
    .map((doc) => doc.data())
    .filter((action) => action.agentId === 'drift');
}

function formatProfileSummary(profile) {
  const blockers = normalizeChoiceArray(profile.sleep_blockers).join(', ') || 'none specified';
  const autoActions = normalizeChoiceArray(profile.auto_actions).join(', ') || 'none';
  return `Main issue: ${profile.main_issue || 'unknown'}
Bad nights: ${profile.bad_night_pattern || 'unknown'}
Blockers: ${blockers}
Target sleep: ${profile.target_sleep_time || 'unknown'}
Target wake: ${profile.target_wake_time || 'unknown'}
Morning state: ${profile.morning_state || 'unknown'}
Primary goal: ${profile.primary_goal || 'unknown'}
Preferred style: ${profile.drift_style || 'unknown'}
Enabled actions: ${autoActions}`;
}

function buildDriftLiveContext(agentState, profile, actions = []) {
  const activeActions = actions
    .filter((action) => ['active', 'snoozed'].includes(action.status))
    .slice(0, 6)
    .map((action) => `- ${action.title} (${action.status})${action.schedule?.time ? ` at ${action.schedule.time}` : ''}`)
    .join('\n') || '- none';

  return `\n\n━━━ USER PROFILE ━━━\n${formatProfileSummary(profile)}\n\n━━━ LIVE STATE ━━━
Risk level: ${agentState.currentRiskLevel || 'medium'}
Sleep streak: ${agentState.sleepStreak || 0}
Last sleep rating: ${agentState.lastSleepRating ?? 'none'}
Last morning energy: ${agentState.lastMorningEnergy ?? 'none'}
Current mode: ${agentState.currentMode || 'normal'}
Active focus: ${agentState.activeFocus || profile.primary_goal || 'stabilize sleep'}
Current experiment: ${agentState.currentExperiment || 'none'}

━━━ ACTIVE ACTIONS ━━━
${activeActions}`;
}

function getQuickRepliesForMode(mode = 'normal') {
  return QUICK_REPLIES[mode] || QUICK_REPLIES.normal;
}

function dateKeyFromIso(iso = nowIso()) {
  return new Date(iso).toISOString().slice(0, 10);
}

function buildDriftCheckinSurvey(contextMode, action = null) {
  if (contextMode !== 'morning_checkin') {
    return null;
  }

  return {
    id: `drift_morning_checkin_${action?.id || 'default'}`,
    kind: 'guided_checkin',
    contextMode: 'morning_checkin',
    title: 'Log last night',
    intro: 'A few quick answers so DRIFT can adjust tonight.',
    submitLabel: 'Send to DRIFT',
    questions: [
      {
        id: 'sleep_rating',
        type: 'choice',
        title: 'How did sleep feel overall?',
        options: ['Great', 'Okay', 'Rough', 'Bad'],
      },
      {
        id: 'main_issue',
        type: 'choice',
        title: 'What felt most off?',
        options: [
          'Took too long to fall asleep',
          'Woke up during the night',
          'Woke too early',
          'Slept enough but still tired',
        ],
      },
      {
        id: 'likely_cause',
        type: 'choice',
        title: 'What probably threw it off?',
        options: ['Phone', 'Work', 'Stress', 'Racing mind', 'Random / not sure'],
      },
      {
        id: 'change_tonight',
        type: 'choice',
        title: 'What should we change tonight?',
        options: [
          'Earlier phone down',
          'Earlier bed routine',
          'Less work late',
          'Mind dump before bed',
          'Keep it the same',
        ],
      },
      {
        id: 'final_note',
        type: 'text',
        title: 'Anything else about last night?',
        optional: true,
        placeholder: 'Optional',
      },
    ],
  };
}

function summarizeDriftStructuredCheckin(payload = {}) {
  const ratingMap = {
    Great: 'Sleep 8/10',
    Okay: 'Sleep 6/10',
    Rough: 'Sleep 4/10',
    Bad: 'Sleep 2/10',
  };
  const pieces = [];
  if (payload.sleep_rating) pieces.push(ratingMap[payload.sleep_rating] || payload.sleep_rating);
  if (payload.main_issue) pieces.push(`Main issue: ${payload.main_issue}`);
  if (payload.likely_cause) pieces.push(`Likely cause: ${payload.likely_cause}`);
  if (payload.change_tonight) pieces.push(`Change tonight: ${payload.change_tonight}`);
  if (payload.final_note) pieces.push(`Extra: ${payload.final_note}`);
  return pieces.join('. ');
}

function parseDriftStructuredCheckin(payload = {}) {
  const ratingMap = {
    Great: 8,
    Okay: 6,
    Rough: 4,
    Bad: 2,
  };
  const energyMap = {
    Great: 5,
    Okay: 3,
    Rough: 2,
    Bad: 1,
  };
  let wakeups = null;
  if (payload.main_issue === 'Woke up during the night') wakeups = 'multiple';
  if (payload.main_issue === 'Woke too early') wakeups = 'early';
  if (payload.main_issue === 'Took too long to fall asleep') wakeups = 'none';
  return {
    rating: ratingMap[payload.sleep_rating] || null,
    morningEnergy: energyMap[payload.sleep_rating] || null,
    wakeups,
    mainIssue: payload.main_issue || null,
    likelyCause: payload.likely_cause || null,
    changeTonight: payload.change_tonight || null,
    finalNote: payload.final_note || '',
  };
}

async function storeDriftCheckin(userId, payload = {}, messageId = null) {
  const parsed = parseDriftStructuredCheckin(payload);
  const ref = logsRef(userId).doc();
  const createdAt = nowIso();
  const entry = {
    id: ref.id,
    type: 'morning_checkin',
    dateKey: dateKeyFromIso(createdAt),
    createdAt,
    messageId,
    answers: payload,
    parsed,
  };
  await ref.set(entry);
  return entry;
}

function messageToChatRole(message) {
  return {
    role: message.role === 'user' ? 'user' : 'assistant',
    content: message.content,
  };
}

function getModeGuide(mode, profile) {
  if (mode === 'morning_checkin') {
    return `This is the morning check-in. Keep it brief. Ask about sleep quality, wake time, or how rested they feel. Their main goal is "${profile.primary_goal || 'better sleep'}".`;
  }
  if (mode === 'evening_checkin') {
    return 'This is the evening check-in. Focus on the next hour. Be specific and useful, not motivational.';
  }
  if (mode === 'rescue') {
    return 'This is rescue mode. The user likely needs one clear move right now. Be calm but decisive.';
  }
  if (mode === 'action_followup') {
    return 'This is action follow-up. Reference the action in plain language and keep it to one move.';
  }
  return 'Normal mode. Be concise, specific, and easy to act on tonight.';
}

async function generateSetupMessage(userName, profile, starterActions) {
  const actionSummary = starterActions.map((action) => `${action.title}${action.schedule?.time ? ` at ${action.schedule.time}` : ''}`).join(', ');
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.7,
      max_tokens: 90,
      messages: [
        { role: 'system', content: `${DRIFT_IDENTITY.corePrompt}

You are writing the very first message after setup.
This must feel premium, human, and immediately useful.
Hard rules:
- one short paragraph
- under 55 words
- never sound like onboarding copy
- never list multiple actions mechanically
- pick the sharpest pattern and one concrete starting point
- one question max
- do not mention "setup" or "starter actions"` },
        { role: 'user', content: `User name: ${userName || 'there'}\nProfile:\n${formatProfileSummary(profile)}\nStarter actions: ${actionSummary}` },
      ],
    });
    return completion.choices[0]?.message?.content?.trim();
  } catch {
    return null;
  }
}

function cleanAssistantReply(text, fallback) {
  const trimmed = text?.trim();
  return trimmed || fallback;
}

async function generateChatReply({ profile, state, actions, history, message, contextMode }) {
  const systemPrompt = `${DRIFT_IDENTITY.corePrompt}${buildDriftLiveContext(state, profile, actions)}

━━━ MODE GUIDE ━━━
${getModeGuide(contextMode, profile)}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.65,
    max_tokens: 90,
    messages: [
      { role: 'system', content: systemPrompt },
      ...history.slice(-18).map(messageToChatRole),
      { role: 'user', content: message },
    ],
  });

  return cleanAssistantReply(
    completion.choices[0]?.message?.content,
    "Let’s keep tonight simple and protect the next move."
  );
}

function getActionKey(type) {
  return `drift_${type}`;
}

function titleForType(type) {
  return ACTION_TYPE_META[type]?.title || type;
}

function buildStarterActionTemplates(profile) {
  const actions = [];
  const targetSleepTime = profile.target_sleep_time || '11:00 PM';
  const targetWakeTime = profile.target_wake_time || '7:00 AM';
  const readyForBedTime = subtractMinutes(targetSleepTime, 45);
  const phoneDownTime = subtractMinutes(targetSleepTime, 30);
  const morningCheckinTime = addMinutes(targetWakeTime, 30);

  actions.push({
    key: getActionKey('wind_down'),
    type: 'wind_down',
    title: 'Get Ready for Bed',
    subtitle: readyForBedTime,
    detail: 'Start slowing down for the night.',
    reason: 'Runs every night.',
    whyNow: 'This gives your night a clean starting point.',
    schedule: { kind: 'daily', time: readyForBedTime },
    priority: 'high',
    successMetric: 'Start bedtime on time',
    source: 'setup',
    confidence: 0.94,
    editable: true,
    status: 'active',
  });

  actions.push({
    key: getActionKey('phone_off'),
    type: 'phone_off',
    title: 'Phone Down',
    subtitle: phoneDownTime,
    detail: 'Put your phone away before bed.',
    reason: 'Runs every night.',
    whyNow: 'This protects the last quiet stretch before bed.',
    schedule: { kind: 'daily', time: phoneDownTime },
    priority: 'high',
    successMetric: 'Less phone time before bed',
    source: 'setup',
    confidence: 0.92,
    editable: true,
    status: 'active',
  });

  actions.push({
    key: getActionKey('good_night'),
    type: 'good_night',
    title: 'Good Night',
    subtitle: targetSleepTime,
    detail: 'Final bedtime reminder.',
    reason: 'Runs every night.',
    whyNow: 'This is the moment to be in bed and off notifications.',
    schedule: { kind: 'daily', time: targetSleepTime },
    priority: 'medium',
    successMetric: 'Be in bed by your target time',
    source: 'setup',
    confidence: 0.9,
    editable: true,
    status: 'active',
  });

  actions.push({
    key: getActionKey('morning_checkin'),
    type: 'morning_checkin',
    title: 'Morning Check-In',
    subtitle: morningCheckinTime,
    detail: 'Tell DRIFT how you slept.',
    reason: 'Runs every morning.',
    whyNow: 'This keeps your sleep pattern clear.',
    schedule: { kind: 'daily', time: morningCheckinTime },
    priority: 'high',
    successMetric: 'Log your morning sleep signal',
    source: 'setup',
    confidence: 0.97,
    editable: true,
    status: 'active',
  });

  return actions;
}

async function ensureCoreDriftActions(userId, profile = {}) {
  if (!profile || !Object.keys(profile).length) {
    return [];
  }

  const existingActions = await getDriftActions(userId);
  const existingByKey = new Map(
    existingActions.map((action) => [action.key, action])
  );

  const created = [];
  for (const draft of buildStarterActionTemplates(profile)) {
    const existing = existingByKey.get(draft.key);
    const normalizedDraft = existing?.schedule?.time
      ? {
        ...draft,
        subtitle: existing.schedule.time,
        schedule: {...(draft.schedule || {}), time: existing.schedule.time},
      }
      : draft;

    if (!existing || !['active', 'snoozed'].includes(existing.status)) {
      created.push(await upsertAction(userId, normalizedDraft));
    }
  }
  return created;
}

async function syncActionSchedule(userId, action) {
  const pendingSnap = await scheduledRef(userId)
    .where('status', '==', 'pending')
    .get();

  const deletions = pendingSnap.docs
    .filter((doc) => {
      const data = doc.data();
      return data.agentId === 'drift' && data.actionId === action.id;
    })
    .map((doc) => doc.ref.delete());
  await Promise.all(deletions);

  if (action.status !== 'active') return;
  if (!action.schedule || !['daily', 'weekly', 'one_time'].includes(action.schedule.kind)) return;

  const nextTriggerAt = getNextTriggerAt(action.schedule);
  if (!nextTriggerAt) return;

  const triggerRef = scheduledRef(userId).doc();
  await triggerRef.set({
    id: triggerRef.id,
    userId,
    agentId: 'drift',
    actionId: action.id,
    triggerAt: nextTriggerAt,
    type: action.type,
    contextMode: action.type === 'morning_checkin'
      ? 'morning_checkin'
      : action.type === 'wind_down' || action.type === 'good_night' || action.type === 'phone_off'
        ? 'evening_checkin'
        : 'action_followup',
    opener: action.detail,
    quickReplies: getQuickRepliesForMode(
      action.type === 'morning_checkin'
        ? 'morning_checkin'
        : action.type === 'tonight_rescue'
          ? 'rescue'
          : action.type === 'wind_down' || action.type === 'good_night' || action.type === 'phone_off'
            ? 'evening_checkin'
            : 'action_followup'
    ),
    recurring: action.schedule.kind !== 'one_time',
    status: 'pending',
    createdAt: nowIso(),
  });
}

async function scheduleSnoozedTrigger(userId, action, delayMinutes = 20) {
  const pendingSnap = await scheduledRef(userId)
    .where('status', '==', 'pending')
    .get();

  await Promise.all(
    pendingSnap.docs
      .filter((doc) => {
        const data = doc.data();
        return data.agentId === 'drift' && data.actionId === action.id;
      })
      .map((doc) => doc.ref.delete())
  );

  const triggerRef = scheduledRef(userId).doc();
  await triggerRef.set({
    id: triggerRef.id,
    userId,
    agentId: 'drift',
    actionId: action.id,
    triggerAt: new Date(Date.now() + delayMinutes * 60 * 1000).toISOString(),
    type: action.type,
    contextMode: 'action_followup',
    opener: `Quick nudge: ${action.title} still matters tonight. ${action.whyNow || action.detail}`,
    quickReplies: getQuickRepliesForMode('action_followup'),
    recurring: false,
    resumeStatus: 'active',
    status: 'pending',
    createdAt: nowIso(),
  });
}

async function upsertAction(userId, draft) {
  const existingSnap = await actionsRef(userId)
    .where('key', '==', draft.key)
    .limit(1)
    .get();

  const timestamp = nowIso();
  const payload = {
    ...draft,
    agentId: 'drift',
    updatedAt: timestamp,
    createdAt: draft.createdAt || timestamp,
    lastTriggeredAt: draft.lastTriggeredAt || null,
    lastUserResponse: draft.lastUserResponse || null,
    expiresAt: draft.expiresAt || null,
  };

  let id;
  if (!existingSnap.empty) {
    const doc = existingSnap.docs[0];
    id = doc.id;
    await doc.ref.set({ ...payload, id }, { merge: true });
  } else {
    const ref = actionsRef(userId).doc();
    id = ref.id;
    await ref.set({ ...payload, id });
  }

  const finalAction = { ...payload, id };
  await syncActionSchedule(userId, finalAction);
  return finalAction;
}

async function applyDriftSleepCycleEdit(userId, sourceAction, time) {
  const bedtimeTime = getBedtimeAnchorFromAction(sourceAction.type, time);
  const cycleTimes = buildSleepCycleTimesFromBedtime(bedtimeTime);
  const existingActions = await getDriftActions(userId);
  const timestamp = nowIso();
  const updatedActions = [];

  for (const action of existingActions) {
    if (
      !isDriftSleepCycleType(action.type) ||
      ['deleted', 'expired'].includes(action.status)
    ) {
      continue;
    }

    const nextTime = cycleTimes[action.type];
    const next = {
      ...action,
      subtitle: nextTime,
      schedule: {...(action.schedule || {}), time: nextTime},
      status: 'active',
      updatedAt: timestamp,
      lastUserResponse:
        action.id === sourceAction.id
          ? `time_edited:${time}`
          : `cycle_aligned:${bedtimeTime}`,
    };

    await actionsRef(userId).doc(action.id).set(next, {merge: true});
    await syncActionSchedule(userId, next);
    updatedActions.push(next);
  }

  return updatedActions;
}

async function createDriftAutomations(userId, userName, answers) {
  const profile = { ...answers };
  const starterActions = buildStarterActionTemplates(profile);
  return Promise.all(starterActions.map((action) => upsertAction(userId, action)));
}

function inferModeFromMessage(text, fallback = 'normal') {
  const lower = text.toLowerCase();
  if (/(can't sleep|cannot sleep|wide awake|woke up again|still awake)/i.test(lower)) return 'rescue';
  if (/(slept|sleep \d|woke up|still tired|energy)/i.test(lower)) return 'morning_checkin';
  if (/(still working|phone|bedtime|ready for bed|mind racing tonight)/i.test(lower)) return 'evening_checkin';
  return fallback;
}

function fallbackActionDecision(message, profile, actions) {
  const lower = message.toLowerCase();
  const results = [];
  const activeTypes = new Set(actions.filter((action) => action.status === 'active').map((action) => action.type));
  if (/still working|working late|stuck on work|finishing work/.test(lower) && !activeTypes.has('work_cutoff') && profile.target_sleep_time) {
    results.push({
      type: 'create',
      action: {
        key: getActionKey('work_cutoff'),
        type: 'work_cutoff',
        title: 'Work Cutoff',
        subtitle: `Stop work by ${subtractMinutes(profile.target_sleep_time, 90)}`,
        detail: 'DRIFT added this because work keeps spilling into your sleep window.',
        reason: 'Added from conversation because late work keeps showing up.',
        whyNow: 'You keep reaching bedtime with work still switched on.',
        schedule: { kind: 'daily', time: subtractMinutes(profile.target_sleep_time, 90) },
        priority: 'high',
        successMetric: 'More space between work and bed',
        source: 'chat',
        confidence: 0.81,
        editable: true,
        status: 'active',
      },
    });
  }
  if (/phone|doomscroll|scrolling/.test(lower) && !activeTypes.has('phone_off') && profile.target_sleep_time) {
    results.push({
      type: 'create',
      action: {
        key: getActionKey('phone_off'),
        type: 'phone_off',
        title: 'Phone Off',
        subtitle: `Phone down at ${subtractMinutes(profile.target_sleep_time, 30)}`,
        detail: 'DRIFT added this because your phone keeps showing up in the final stretch before bed.',
        reason: 'Added from conversation because phone use is still active at night.',
        whyNow: 'This is the cleanest way to protect your sleep window.',
        schedule: { kind: 'daily', time: subtractMinutes(profile.target_sleep_time, 30) },
        priority: 'high',
        successMetric: 'Less late-night phone time',
        source: 'chat',
        confidence: 0.79,
        editable: true,
        status: 'active',
      },
    });
  }
  if (/i('ll| will| am going to| gonna| going to) /.test(lower)) {
    results.push({
      type: 'create',
      action: {
        key: `drift_commitment_${Date.now()}`,
        type: 'user_commitment',
        title: 'Keep Your Commitment',
        subtitle: 'Something you said you want to do',
        detail: 'DRIFT captured this because you made a real commitment in chat.',
        reason: 'Added from your own words so the plan does not vanish after this conversation.',
        whyNow: 'What matters is what actually happens tonight.',
        schedule: { kind: 'conditional', trigger: 'manual' },
        priority: 'medium',
        successMetric: 'Follow through on what you said',
        source: 'chat',
        confidence: 0.7,
        editable: true,
        status: 'active',
      },
    });
  }
  return results;
}

async function decideActionChanges(message, profile, state, actions, contextMode) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 350,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are DRIFT's action engine.
Decide if the user's latest message should create or update a sleep action.
Return JSON with shape:
{
  "mode":"normal|evening_checkin|morning_checkin|rescue|action_followup",
  "changes":[
    {
      "type":"create|none",
      "actionType":"wind_down|morning_checkin|work_cutoff|phone_off|brain_dump|weekend_sleep_guard|recovery_mode|sleep_experiment|user_commitment|tonight_rescue",
      "title":"string",
      "subtitle":"string",
      "detail":"string",
      "reason":"string",
      "whyNow":"string",
      "scheduleKind":"daily|weekly|one_time|conditional",
      "time":"10:30 PM or null",
      "days":["fri","sat"],
      "trigger":"after_bad_sleep|manual|null",
      "priority":"high|medium|low",
      "successMetric":"string",
      "confidence":0.0,
      "editable":true
    }
  ]
}
Rules:
- Only create actions if confidence is genuinely high.
- Avoid duplicate actions that already exist.
- If the user needs immediate help tonight, prefer tonight_rescue.
- If they are just venting, return no changes.
- If the user makes a clear promise, user_commitment is allowed.`,
        },
        {
          role: 'user',
          content: `Context mode: ${contextMode}
Profile:
${formatProfileSummary(profile)}
Current state:
Risk=${state.currentRiskLevel}; streak=${state.sleepStreak}; lastSleep=${state.lastSleepRating}; lastEnergy=${state.lastMorningEnergy}
Existing actions:
${actions.map((action) => `- ${action.type} (${action.status})`).join('\n') || '- none'}

Latest user message:
${message}`,
        },
      ],
    });

    const parsed = JSON.parse(completion.choices[0]?.message?.content || '{}');
    const activeTypes = new Set(actions.filter((action) => action.status === 'active').map((action) => action.type));
    const changes = (parsed.changes || [])
      .filter((change) => change.type === 'create' && change.actionType && !activeTypes.has(change.actionType))
      .map((change) => ({
        type: 'create',
        action: {
          key: change.actionType === 'user_commitment' ? `drift_commitment_${Date.now()}` : getActionKey(change.actionType),
          type: change.actionType,
          title: change.title || titleForType(change.actionType),
          subtitle: change.subtitle || '',
          detail: change.detail || '',
          reason: change.reason || 'Added by DRIFT from the conversation.',
          whyNow: change.whyNow || 'The conversation made this feel worth acting on.',
          schedule: change.scheduleKind === 'conditional' ? { kind: 'conditional', trigger: change.trigger || 'manual' } : {
            kind: change.scheduleKind || 'daily',
            time: change.time || null,
            days: change.days || [],
            trigger: change.trigger || null,
          },
          priority: change.priority || 'medium',
          successMetric: change.successMetric || 'Make sleep feel more stable',
          source: 'chat',
          confidence: Number(change.confidence || 0.75),
          editable: change.editable !== false,
          status: 'active',
        },
      }));

    return {
      mode: parsed.mode || inferModeFromMessage(message, contextMode),
      changes,
    };
  } catch {
    return {
      mode: inferModeFromMessage(message, contextMode),
      changes: fallbackActionDecision(message, profile, actions),
    };
  }
}

function parseMorningReplyHeuristic(message) {
  const lower = message.toLowerCase();
  const ratingMatch = message.match(/(\d{1,2})\s*\/\s*10/);
  const energyMatch = message.match(/energy[: ]+(\d)\s*\/\s*5/i);
  const rating = ratingMatch ? Math.max(1, Math.min(10, parseInt(ratingMatch[1], 10))) : null;
  let morningEnergy = energyMatch ? Math.max(1, Math.min(5, parseInt(energyMatch[1], 10))) : null;
  if (morningEnergy == null) {
    if (/dead|exhausted/.test(lower)) morningEnergy = 1;
    else if (/tired/.test(lower)) morningEnergy = 2;
    else if (/okay|fine/.test(lower)) morningEnergy = 3;
    else if (/good|decent/.test(lower)) morningEnergy = 4;
    else if (/great|energized/.test(lower)) morningEnergy = 5;
  }
  let wakeups = null;
  if (/woke up twice|two times|twice/.test(lower)) wakeups = 'twice';
  else if (/woke up once|once/.test(lower)) wakeups = 'once';
  else if (/woke up a lot|multiple|kept waking/.test(lower)) wakeups = 'multiple';
  else if (/slept through|didn't wake/.test(lower)) wakeups = 'none';
  return { rating, morningEnergy, wakeups };
}

async function processMorningCheckinReply(userId, userMessage, structuredCheckin = null) {
  const state = await getOrCreateDriftState(userId);
  const parsed = structuredCheckin
    ? parseDriftStructuredCheckin(structuredCheckin)
    : parseMorningReplyHeuristic(userMessage);
  if (parsed.rating == null && parsed.morningEnergy == null && !parsed.wakeups) return state;

  let sleepStreak = state.sleepStreak || 0;
  if (parsed.rating != null) {
    if (parsed.rating >= 6) sleepStreak += 1;
    else if (parsed.rating <= 4) sleepStreak = 0;
  }

  const patch = {
    sleepStreak,
    updatedAt: nowIso(),
    currentMode: 'normal',
  };
  if (parsed.rating != null) patch.lastSleepRating = parsed.rating;
  if (parsed.morningEnergy != null) patch.lastMorningEnergy = parsed.morningEnergy;
  if (parsed.wakeups != null) patch.lastReportedWakeups = parsed.wakeups;
  if (parsed.mainIssue != null) patch.lastSleepIssue = parsed.mainIssue;
  if (parsed.likelyCause != null) patch.lastSleepCause = parsed.likelyCause;
  if (parsed.changeTonight != null) patch.lastRequestedSleepChange = parsed.changeTonight;
  patch.currentRiskLevel = deriveSleepRisk(state.profile || {}, { ...state, ...patch });

  await agentRef(userId).set(patch, { merge: true });
  return { ...state, ...patch };
}

async function extractDriftAction(userId, userName, userMessage) {
  const state = await getOrCreateDriftState(userId);
  const actions = await getDriftActions(userId);
  const result = await decideActionChanges(userMessage, state.profile || {}, state, actions, 'normal');
  const created = [];
  for (const change of result.changes) {
    if (change.type === 'create') created.push(await upsertAction(userId, change.action));
  }
  return created;
}

async function saveMessage(userId, payload) {
  const ref = messagesRef(userId).doc();
  const message = {
    id: ref.id,
    ...payload,
    timestamp: payload.timestamp || nowIso(),
  };
  await ref.set(message);
  return message;
}

function buildStarterPlanSummary(actions) {
  return actions.slice(0, 4).map((action) => ({
    id: action.id,
    title: action.title,
    subtitle: action.subtitle,
    reason: action.reason,
  }));
}

function groupActions(actions) {
  const sections = [
    { key: 'Before Bed', items: [] },
    { key: 'At Bedtime', items: [] },
    { key: 'After You Wake', items: [] },
    { key: 'Always On', items: [] },
  ];
  const byKey = Object.fromEntries(sections.map((section) => [section.key, section]));
  actions.forEach((action) => {
    let key = ACTION_TYPE_META[action.type]?.bucket || 'Always On';
    if (action.schedule?.kind === 'conditional') key = 'Always On';
    byKey[key]?.items.push(action);
  });
  return sections.filter((section) => section.items.length > 0);
}

function buildFallbackAnalysis(state, messages, actions) {
  const profile = state.profile || {};
  const recentUserMessages = messages.filter((message) => message.role === 'user').slice(-8);
  const text = recentUserMessages.map((message) => message.content.toLowerCase()).join(' ');
  const activeActions = actions.filter((action) => action.status === 'active');

  let pattern = 'Your sleep still needs a cleaner nightly pattern.';
  if (/work/.test(text) || normalizeChoiceArray(profile.sleep_blockers).includes('Still working late')) {
    pattern = 'Late work still looks like one of the fastest ways your night gets pushed off course.';
  } else if (/phone|scroll/.test(text) || normalizeChoiceArray(profile.sleep_blockers).includes('Phone in bed')) {
    pattern = 'The phone still looks like the easiest place for your sleep window to drift.';
  } else if (/anx|mind racing|worry|thought/.test(text) || normalizeChoiceArray(profile.sleep_blockers).includes('Mind racing')) {
    pattern = 'Your problem still looks more like nighttime activation than simple lack of tiredness.';
  }

  const wins = [];
  if ((state.sleepStreak || 0) >= 2) wins.push(`You have ${state.sleepStreak} better nights in a row right now.`);
  if ((state.lastSleepRating || 0) >= 7) wins.push(`Your latest sleep report came in at ${state.lastSleepRating}/10.`);
  if (activeActions.length >= 3) wins.push(`DRIFT is actively running ${activeActions.length} sleep actions for you.`);
  if (wins.length === 0) wins.push('The good news is your pattern is clear enough to act on now.');

  const risks = [];
  if ((state.lastSleepRating || 10) <= 4) risks.push('Recent sleep quality is still low enough that recovery needs to stay the priority.');
  if ((state.lastMorningEnergy || 5) <= 2) risks.push('Morning energy is still lagging, which means the problem is not fully solved even after a decent night.');
  if (profile.bad_night_pattern === 'Weekend nights') risks.push('Weekends still look like the easiest place for your rhythm to break.');
  if (risks.length === 0) risks.push('The next risk is slipping back into the same blocker that usually hits your worst nights.');

  return {
    generatedAt: nowIso(),
    summary: pattern,
    patterns: [pattern],
    wins: wins.slice(0, 2),
    risks: risks.slice(0, 2),
    focus: profile.primary_goal || 'Protect the next few nights and keep learning from the mornings.',
    chart: buildSleepChart(messages),
  };
}

function buildSleepChart(messages) {
  const userMessages = messages.filter((message) => message.role === 'user');
  const recent = userMessages.slice(-14);
  const chart = [];
  recent.forEach((message) => {
    const parsed = parseMorningReplyHeuristic(message.content || '');
    if (parsed.rating == null) return;
    const stamp = new Date(message.timestamp || Date.now());
    chart.push({
      label: stamp.toLocaleDateString('en-US', {weekday: 'short'}).slice(0, 3),
      value: parsed.rating,
      energy: parsed.morningEnergy,
    });
  });
  return chart.slice(-7);
}

async function generateDriftAnalysis(userId, state, messages, actions) {
  const fallback = buildFallbackAnalysis(state, messages, actions);
  try {
    const recentUserMessages = messages
      .filter((message) => message.role === 'user')
      .slice(-10)
      .map((message) => `- ${message.content}`)
      .join('\n') || '- no recent user messages';
    const actionSummary = actions
      .filter((action) => ['active', 'snoozed', 'completed'].includes(action.status))
      .slice(0, 8)
      .map((action) => `- ${action.title} (${action.status})${action.schedule?.time ? ` at ${action.schedule.time}` : ''}`)
      .join('\n') || '- no actions';

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 320,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You generate a sharp weekly analysis for a premium sleep agent.
Return JSON:
{
  "summary":"one short paragraph",
  "patterns":["pattern 1","pattern 2"],
  "wins":["win 1","win 2"],
  "risks":["risk 1","risk 2"],
  "focus":"one sentence next focus"
}
Rules:
- Be specific, never generic.
- Use the user's actual sleep pattern, blockers, and actions.
- Keep every line short and premium.
- If the signal is weak, still make the summary useful and honest.`,
        },
        {
          role: 'user',
          content: `Profile:
${formatProfileSummary(state.profile || {})}

Current state:
Risk: ${state.currentRiskLevel}
Sleep streak: ${state.sleepStreak}
Last sleep rating: ${state.lastSleepRating}
Last morning energy: ${state.lastMorningEnergy}

Recent user messages:
${recentUserMessages}

Actions:
${actionSummary}`,
        },
      ],
    });

    const parsed = JSON.parse(completion.choices[0]?.message?.content || '{}');
    return {
      generatedAt: nowIso(),
      summary: parsed.summary || fallback.summary,
      patterns: Array.isArray(parsed.patterns) && parsed.patterns.length ? parsed.patterns.slice(0, 2) : fallback.patterns,
      wins: Array.isArray(parsed.wins) && parsed.wins.length ? parsed.wins.slice(0, 2) : fallback.wins,
      risks: Array.isArray(parsed.risks) && parsed.risks.length ? parsed.risks.slice(0, 2) : fallback.risks,
      focus: parsed.focus || fallback.focus,
      chart: fallback.chart,
    };
  } catch {
    return fallback;
  }
}

async function buildDriftStatePayload(userId) {
  const state = await getOrCreateDriftState(userId);
  if (state.setupComplete) {
    await ensureCoreDriftActions(userId, state.profile || {});
  }
  const [messages, actions] = await Promise.all([
    getDriftMessages(userId),
    getDriftActions(userId),
  ]);
  const analysis = state.analysis || buildFallbackAnalysis(state, messages, actions);
  return {
    success: true,
    setupComplete: !!state.setupComplete,
    state: { ...state, analysis },
    messages,
    actions,
    actionGroups: groupActions(actions.filter((action) => action.status !== 'deleted' && action.status !== 'expired')),
    quickReplies: getQuickRepliesForMode(state.currentMode || 'normal'),
    analysis,
  };
}

async function processScheduledTriggers(firestoreDb = db) {
  if (firestoreDb) db = firestoreDb;
  const usersSnap = await db.collection('wellness_users').limit(500).get();
  const now = nowIso();

  await Promise.all(usersSnap.docs.map(async (userDoc) => {
    const userId = userDoc.id;
    const user = userDoc.data() || {};
    const dueSnap = await scheduledRef(userId)
      .where('status', '==', 'pending')
      .where('triggerAt', '<=', now)
      .orderBy('triggerAt', 'asc')
      .limit(10)
      .get();

    await Promise.all(dueSnap.docs.map(async (triggerDoc) => {
      const trigger = triggerDoc.data();
      if (trigger.agentId !== 'drift') return;
      const actionDoc = trigger.actionId ? await actionsRef(userId).doc(trigger.actionId).get() : null;
      const action = actionDoc?.exists ? actionDoc.data() : null;
      if (action && action.status !== 'active') {
        await triggerDoc.ref.update({ status: 'skipped', skippedAt: nowIso() });
        return;
      }

      const message = await saveMessage(userId, {
        role: 'agent',
        content: trigger.opener || action?.detail || `Hey ${user.name || 'there'} — checking in.`,
        isProactive: true,
        contextMode: trigger.contextMode || 'action_followup',
        triggerType: trigger.type,
        actionId: trigger.actionId || null,
        quickReplies: trigger.quickReplies || getQuickRepliesForMode(trigger.contextMode || 'normal'),
        survey: buildDriftCheckinSurvey(trigger.contextMode || 'normal', action),
      });

      await triggerDoc.ref.update({ status: 'sent', sentAt: nowIso(), messageId: message.id });
      await agentRef(userId).set({
        currentMode: trigger.contextMode || 'normal',
        lastProactiveAt: nowIso(),
        updatedAt: nowIso(),
      }, { merge: true });

      if (action) {
        await actionsRef(userId).doc(action.id).set({
          lastTriggeredAt: nowIso(),
          status: trigger.resumeStatus || action.status,
          updatedAt: nowIso(),
        }, { merge: true });
        if (action.schedule?.kind === 'daily' || action.schedule?.kind === 'weekly') {
          await syncActionSchedule(userId, { ...action, status: trigger.resumeStatus || action.status });
        }
      }

      if (user.fcmToken) {
        try {
          const admin = require('firebase-admin');
          await admin.messaging().send({
            token: user.fcmToken,
            notification: {
              title: 'DRIFT',
              body: message.content.slice(0, 120),
            },
            data: {
              screen: 'Drift',
              agentId: 'drift',
              contextMode: trigger.contextMode || 'normal',
            },
          });
        } catch (error) {
          console.error('DRIFT FCM error:', error.message);
        }
      }
    }));
  }));
}

async function maybeCreateRecoveryAction(userId, state) {
  if ((state.lastSleepRating || 10) > 4) return null;
  const draft = {
    key: `drift_recovery_${new Date().toISOString().slice(0, 10)}`,
    type: 'tonight_rescue',
    title: 'Tonight Rescue',
    subtitle: 'Protect tonight after a rough sleep',
    detail: 'DRIFT added a one-night rescue because your recent sleep report looked rough.',
    reason: 'Added because your recent sleep report suggests you need a lower-friction recovery night.',
    whyNow: 'The goal tonight is recovery, not perfection.',
    schedule: { kind: 'one_time', time: subtractMinutes(state.profile?.target_sleep_time || '11:00 PM', 20) },
    priority: 'high',
    successMetric: 'Avoid compounding a bad stretch',
    source: 'adaptive_engine',
    confidence: 0.82,
    editable: true,
    status: 'active',
    expiresAt: new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString(),
  };
  return upsertAction(userId, draft);
}

async function maybeCreateExperiment(userId, actions, experimentKey, draftFactory) {
  const hasExisting = actions.some(
    (action) =>
      action.type === 'sleep_experiment' &&
      action.key === experimentKey &&
      ['active', 'snoozed'].includes(action.status)
  );
  if (hasExisting) return null;
  return upsertAction(userId, draftFactory());
}

async function runDriftNightlyAnalysis(firestoreDb = db) {
  if (firestoreDb) db = firestoreDb;
  const usersSnap = await db.collection('wellness_users').limit(500).get();
  await Promise.all(usersSnap.docs.map(async (userDoc) => {
    const userId = userDoc.id;
    const state = await getOrCreateDriftState(userId);
    if (!state.setupComplete) return;

    const actions = await getDriftActions(userId);
    const recentMessages = await getDriftMessages(userId, 24);
    const morningReplies = recentMessages
      .filter((msg) => msg.role === 'user' && ['morning_checkin', 'normal'].includes(msg.contextMode || 'normal'))
      .slice(-5);

    let sleepMentions = 0;
    let workMentions = 0;
    let phoneMentions = 0;
    morningReplies.forEach((msg) => {
      const lower = msg.content.toLowerCase();
      if (/sleep|tired|woke|energy/.test(lower)) sleepMentions += 1;
      if (/work/.test(lower)) workMentions += 1;
      if (/phone|scroll/.test(lower)) phoneMentions += 1;
    });

    const nextState = {
      ...state,
      currentRiskLevel: deriveSleepRisk(state.profile || {}, state),
      updatedAt: nowIso(),
    };
    if (workMentions >= 2) nextState.activeFocus = 'Late work is still bleeding into sleep.';
    else if (phoneMentions >= 2) nextState.activeFocus = 'The phone is still stealing your final sleep window.';
    else if (sleepMentions >= 2) nextState.activeFocus = state.profile?.primary_goal || 'Protect tonight and learn from the mornings.';

    nextState.analysis = await generateDriftAnalysis(userId, nextState, recentMessages, actions);
    await agentRef(userId).set({
      currentRiskLevel: nextState.currentRiskLevel,
      activeFocus: nextState.activeFocus || null,
      analysis: nextState.analysis,
      updatedAt: nextState.updatedAt,
    }, { merge: true });

    if ((state.lastSleepRating || 10) <= 4) {
      await maybeCreateRecoveryAction(userId, nextState);
    }

    if (workMentions >= 2) {
      await maybeCreateExperiment(userId, actions, 'drift_experiment_work_shutdown', () => ({
        key: 'drift_experiment_work_shutdown',
        type: 'sleep_experiment',
        title: '3-Night Work Shutdown',
        subtitle: 'Test a cleaner cutoff before bed',
        detail: 'DRIFT created a short experiment because late work keeps showing up around your bad nights.',
        reason: 'Added because recent sleep signal still points back to late work.',
        whyNow: 'A short test is faster than guessing for another week.',
        schedule: {
          kind: 'daily',
          time: subtractMinutes(state.profile?.target_sleep_time || '11:00 PM', 90),
        },
        priority: 'high',
        successMetric: 'See whether earlier work shutdown changes sleep quality',
        source: 'adaptive_engine',
        confidence: 0.84,
        editable: true,
        status: 'active',
        expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      }));
    }

    if (phoneMentions >= 2) {
      await maybeCreateExperiment(userId, actions, 'drift_experiment_phone_free', () => ({
        key: 'drift_experiment_phone_free',
        type: 'sleep_experiment',
        title: '5-Night Phone-Free Test',
        subtitle: 'Protect the last 30 minutes',
        detail: 'DRIFT created a short experiment because the phone still looks like a high-leverage blocker.',
        reason: 'Added because your recent pattern still points back to the phone at night.',
        whyNow: 'This is the fastest way to test whether late stimulation is still the real issue.',
        schedule: {
          kind: 'daily',
          time: subtractMinutes(state.profile?.target_sleep_time || '11:00 PM', 30),
        },
        priority: 'high',
        successMetric: 'See whether removing the phone improves sleep quality',
        source: 'adaptive_engine',
        confidence: 0.84,
        editable: true,
        status: 'active',
        expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
      }));
    }

    const expirable = actions.filter((action) => action.expiresAt && new Date(action.expiresAt) <= new Date() && ['active', 'snoozed'].includes(action.status));
    await Promise.all(expirable.map((action) => actionsRef(userId).doc(action.id).set({
      status: 'expired',
      updatedAt: nowIso(),
    }, { merge: true })));
  }));
}

router.get('/config', async (_req, res) => {
  res.json({
    success: true,
    config: DRIFT_SETUP_CONFIG,
    quickReplies: QUICK_REPLIES,
    actionTypes: ACTION_TYPE_META,
  });
});

router.get('/state/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    await getOrCreateUser(userId);
    const payload = await buildDriftStatePayload(userId);
    res.json(payload);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/analysis/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const state = await getOrCreateDriftState(userId);
    const [messages, actions] = await Promise.all([
      getDriftMessages(userId, 40),
      getDriftActions(userId),
    ]);
    const analysis = state.analysis || await generateDriftAnalysis(userId, state, messages, actions);
    if (!state.analysis) {
      await agentRef(userId).set({ analysis, updatedAt: nowIso() }, { merge: true });
    }
    res.json({ success: true, analysis });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/setup', async (req, res) => {
  try {
    const { userId, userName, answers } = req.body;
    if (!userId || !answers) return res.status(400).json({ success: false, error: 'userId and answers are required' });

    await getOrCreateUser(userId, userName);
    const profile = { ...answers };
    const starterActions = [];
    for (const draft of buildStarterActionTemplates(profile)) {
      starterActions.push(await upsertAction(userId, draft));
    }

    const statePatch = {
      setupComplete: true,
      setupProgress: DRIFT_SETUP_CONFIG.questions.length,
      setupAnswers: answers,
      profile,
      activeFocus: profile.primary_goal || 'Protect the next few nights',
      currentMode: 'normal',
      currentRiskLevel: deriveSleepRisk(profile),
      updatedAt: nowIso(),
    };
    await agentRef(userId).set(statePatch, { merge: true });

    const starterMessage = await generateSetupMessage(userName, profile, starterActions)
      || `Your sleep pattern is clear enough to start acting on. I’ve already set up a few things around ${profile.main_issue?.toLowerCase() || 'sleep'} and tonight matters more than trying to fix everything at once. What feels most fragile about tonight?`;

    const existingMessages = await getDriftMessages(userId, 5);
    let firstMessage = existingMessages.find((msg) => msg.isFirstMessage);
    if (!firstMessage) {
      firstMessage = await saveMessage(userId, {
        role: 'agent',
        content: starterMessage,
        isFirstMessage: true,
        contextMode: 'normal',
        quickReplies: getQuickRepliesForMode('normal'),
      });
    }

    const starterState = await getOrCreateDriftState(userId);
    const starterMessages = await getDriftMessages(userId, 20);
    const starterAnalysis = await generateDriftAnalysis(
      userId,
      starterState,
      starterMessages,
      starterActions,
    );
    await agentRef(userId).set(
      {analysis: starterAnalysis, updatedAt: nowIso()},
      {merge: true},
    );

    const payload = await buildDriftStatePayload(userId);
    res.json({
      ...payload,
      starterPlan: buildStarterPlanSummary(starterActions),
      starterMessage: firstMessage,
    });
  } catch (error) {
    console.error('DRIFT setup error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/chat', async (req, res) => {
  try {
    const { userId, userName, message, contextMode = 'normal', structuredCheckin = null } = req.body;
    if (!userId || !message) return res.status(400).json({ success: false, error: 'userId and message are required' });

    await getOrCreateUser(userId, userName);
    const state = await getOrCreateDriftState(userId);
    const profile = state.profile || {};
    const [history, actions] = await Promise.all([
      getDriftMessages(userId, 40),
      getDriftActions(userId),
    ]);

    const normalizedMessage = structuredCheckin
      ? summarizeDriftStructuredCheckin(structuredCheckin)
      : message;
    const resolvedMode = inferModeFromMessage(normalizedMessage, contextMode || state.currentMode || 'normal');
    const userMsg = await saveMessage(userId, {
      role: 'user',
      content: normalizedMessage,
      contextMode: resolvedMode,
      structuredCheckin,
    });

    let updatedState = state;
    if (resolvedMode === 'morning_checkin') {
      updatedState = await processMorningCheckinReply(userId, normalizedMessage, structuredCheckin);
      if (structuredCheckin) {
        await storeDriftCheckin(userId, structuredCheckin, userMsg.id);
      }
    }

    const actionDecision = await decideActionChanges(normalizedMessage, profile, updatedState, actions, resolvedMode);
    const createdActions = [];
    for (const change of actionDecision.changes) {
      if (change.type === 'create') createdActions.push(await upsertAction(userId, change.action));
    }

    const reply = await generateChatReply({
      profile,
      state: { ...updatedState, currentMode: actionDecision.mode || resolvedMode },
      actions: [...actions, ...createdActions],
      history: [...history, userMsg],
      message: normalizedMessage,
      contextMode: actionDecision.mode || resolvedMode,
    });

    const agentMsg = await saveMessage(userId, {
      role: 'agent',
      content: reply,
      contextMode: actionDecision.mode || resolvedMode,
      quickReplies: getQuickRepliesForMode(actionDecision.mode || resolvedMode),
    });

    await agentRef(userId).set({
      conversationCount: (state.conversationCount || 0) + 1,
      currentMode: 'normal',
      lastInteractionAt: nowIso(),
      updatedAt: nowIso(),
      currentRiskLevel: deriveSleepRisk(profile, updatedState),
    }, { merge: true });

    const latestState = await getOrCreateDriftState(userId);
    const latestMessages = await getDriftMessages(userId, 30);
    const latestActions = await getDriftActions(userId);
    const analysis = await generateDriftAnalysis(
      userId,
      latestState,
      latestMessages,
      latestActions,
    );
    await agentRef(userId).set({analysis, updatedAt: nowIso()}, {merge: true});

    const payload = await buildDriftStatePayload(userId);
    res.json({
      ...payload,
      userMessage: userMsg,
      agentMessage: agentMsg,
      actionChanges: createdActions,
    });
  } catch (error) {
    console.error('DRIFT chat error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/actions/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const state = await getOrCreateDriftState(userId);
    if (state.setupComplete) {
      await ensureCoreDriftActions(userId, state.profile || {});
    }
    const actions = await getDriftActions(userId);
    res.json({
      success: true,
      actions,
      actionGroups: groupActions(actions.filter((action) => action.status !== 'deleted' && action.status !== 'expired')),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.patch('/actions/:userId/:actionId', async (req, res) => {
  try {
    const { userId, actionId } = req.params;
    const { operation, time } = req.body;
    const state = await getOrCreateDriftState(userId);
    if (state.setupComplete) {
      await ensureCoreDriftActions(userId, state.profile || {});
    }
    const doc = await actionsRef(userId).doc(actionId).get();
    if (!doc.exists) return res.status(404).json({ success: false, error: 'Action not found' });

    const action = doc.data();
    if (action.agentId !== 'drift') return res.status(400).json({ success: false, error: 'Not a DRIFT action' });

    const patch = { updatedAt: nowIso() };
    if (operation === 'pause') patch.status = 'paused';
    else if (operation === 'resume') patch.status = 'active';
    else if (operation === 'complete') {
      patch.completedAt = nowIso();
      patch.lastCompletedAt = nowIso();
      patch.lastUserResponse = 'completed_today';
      patch.status =
        action.schedule && ['daily', 'weekly'].includes(action.schedule.kind)
          ? 'active'
          : 'completed';
    }
    else if (operation === 'delete') patch.status = 'deleted';
    else if (operation === 'snooze') {
      patch.status = 'active';
      patch.snoozeCount = (action.snoozeCount || 0) + 1;
      patch.lastUserResponse = 'snoozed_today';
    }
    else if (operation === 'edit_time') {
      if (!time) return res.status(400).json({ success: false, error: 'time required for edit_time' });
      if (isDriftSleepCycleType(action.type)) {
        const updatedActions = await applyDriftSleepCycleEdit(userId, action, time);
        const updatedAction = updatedActions.find((item) => item.id === actionId) || action;
        return res.json({ success: true, action: updatedAction, actions: updatedActions });
      }
      patch.schedule = { ...(action.schedule || {}), time };
      patch.status = 'active';
      patch.lastUserResponse = `time_edited:${time}`;
    } else {
      return res.status(400).json({ success: false, error: 'Unsupported operation' });
    }

    const next = { ...action, ...patch };
    await doc.ref.set(next, { merge: true });

    if (operation === 'snooze') {
      await scheduleSnoozedTrigger(userId, next, 20);
    } else if (operation === 'complete' && action.schedule && ['daily', 'weekly'].includes(action.schedule.kind)) {
      await syncActionSchedule(userId, next);
    } else if (['pause', 'complete', 'delete'].includes(operation)) {
      const pendingSnap = await scheduledRef(userId)
        .where('status', '==', 'pending')
        .get();
      await Promise.all(
        pendingSnap.docs
          .filter((scheduledDoc) => {
            const data = scheduledDoc.data();
            return data.agentId === 'drift' && data.actionId === actionId;
          })
          .map((scheduledDoc) => scheduledDoc.ref.delete())
      );
    } else {
      await syncActionSchedule(userId, next);
    }

    res.json({ success: true, action: next });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/process-scheduled', async (_req, res) => {
  try {
    await processScheduledTriggers(db);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/run-daily/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const state = await getOrCreateDriftState(userId);
    await runDriftNightlyAnalysis(db);
    res.json({ success: true, state });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = {
  router,
  setDb,
  processScheduledTriggers,
  runDriftNightlyAnalysis,
  createDriftAutomations,
  processMorningCheckinReply,
  extractDriftAction,
  buildDriftLiveContext,
  DRIFT_SETUP_CONFIG,
  DRIFT_IDENTITY,
};
