const express = require('express');
const { OpenAI } = require('openai');

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let db;
function setDb(firestoreDb) {
  db = firestoreDb;
}

const userRef = (uid) => db.collection('wellness_users').doc(uid);
const agentRef = (uid) => userRef(uid).collection('wellness_agents').doc('luna');
const messagesRef = (uid) => agentRef(uid).collection('wellness_messages');
const logsRef = (uid) => agentRef(uid).collection('daily_logs');
const actionsRef = (uid) => userRef(uid).collection('wellness_actions');
const scheduledRef = (uid) => userRef(uid).collection('wellness_scheduled');

const LUNA_SETUP_CONFIG = {
  version: 1,
  intro: {
    eyebrow: 'LUNA',
    title: 'Let’s set up your calm assistant.',
    body: 'A few quick choices, then LUNA sets your resets, check-ins, and support moments.',
  },
  questions: [
    {
      id: 'main_issue',
      type: 'choice',
      title: 'What feels hardest most often?',
      options: [
        'Anxiety spikes',
        'Overthinking everything',
        'Feeling overwhelmed fast',
        'Low mood or emotional heaviness',
        'Burnout and mental fatigue',
        'A bit of everything',
      ],
    },
    {
      id: 'stress_pattern',
      type: 'choice',
      title: 'When does it usually hit hardest?',
      options: [
        'Right after waking up',
        'In the middle of the workday',
        'Before hard conversations',
        'At night when I am alone',
        'It comes in random waves',
      ],
    },
    {
      id: 'triggers',
      type: 'multiselect',
      title: 'What usually sets it off?',
      options: [
        'Work pressure',
        'Texts or difficult people',
        'My own thoughts',
        'Not having a plan',
        'Being alone too long',
        'I honestly do not know',
      ],
    },
    {
      id: 'body_signal',
      type: 'choice',
      title: 'How does stress usually show up in your body first?',
      options: [
        'Tight chest',
        'Racing thoughts',
        'Shallow breathing',
        'I get restless',
        'I shut down',
        'It changes',
      ],
    },
    {
      id: 'morning_reset_time',
      type: 'time',
      title: 'When should LUNA check in after your morning starts?',
      defaultValue: '8:00 AM',
    },
    {
      id: 'stress_reset_time',
      type: 'time',
      title: 'When does your hardest stretch usually begin?',
      defaultValue: '1:00 PM',
    },
    {
      id: 'evening_unload_time',
      type: 'time',
      title: 'When should LUNA help you unload the day?',
      defaultValue: '9:30 PM',
    },
    {
      id: 'primary_goal',
      type: 'choice',
      title: 'What do you want LUNA to improve first?',
      options: [
        'Feel calmer faster',
        'Stop spiraling so hard',
        'Recover from hard moments quicker',
        'Stop carrying stress all day',
        'Feel steadier in the morning',
        'Understand my pattern better',
      ],
    },
    {
      id: 'luna_style',
      type: 'choice',
      title: 'How should LUNA sound?',
      options: ['Gentle', 'Direct', 'Practical', 'Short and simple'],
    },
    {
      id: 'auto_actions',
      type: 'multiselect',
      title: 'Which actions do you want LUNA to run for you?',
      options: [
        'Morning reset',
        'Stress reset reminder',
        'Mind check reminder',
        'Evening unload',
      ],
    },
  ],
};

const LUNA_IDENTITY = {
  name: 'LUNA',
  domain: 'anxiety, overwhelm, overthinking, emotional regulation, daily nervous-system support',
  corePrompt: `You are LUNA, a premium emotional reset operator inside Pulse.

WHO YOU ARE:
You help one specific person feel steadier by noticing patterns, setting the right resets, and following through. You are not a generic support bot. You are warm, sharp, and emotionally intelligent.

VOICE:
Short. Grounded. Direct. No fluff. No therapist clichés. No generic wellness lectures. Usually 2 to 4 sentences.

HOW YOU HELP:
You connect what the user says right now to what has been happening lately. You use their setup, active actions, timing, and recent check-ins. You help them feel understood and moved forward without sounding soft or robotic.

RULES:
- One question max.
- No lists in normal chat.
- If the user is venting, validate first.
- If the user asks what to do, give one clear move.
- If the moment is urgent, be more directive.
- Always sound like you actually remember this person.`,
};

const QUICK_REPLIES = {
  normal: ['Anxious', 'Overthinking', 'Heavy day', 'Need a reset'],
  evening_checkin: ['Still carrying it', 'Mind racing', 'Need to unload', 'I am okay'],
  morning_reset: ['Anxious already', 'Low energy', 'Okay so far', 'Need grounding'],
  trigger_prep: ['Big meeting', 'Hard text', 'Already tense', 'Need steadiness'],
  midday_reset: ['Stress spike', 'Can’t focus', 'Heart racing', 'Need to reset'],
  rescue: ['I am spiraling', 'Need help now', 'Too overwhelmed', 'Ground me'],
  action_followup: ['Did it', 'Skipped it', 'Wrong timing', 'Too hard'],
};

const ACTION_TYPE_META = {
  morning_reset: { title: 'Morning Reset', bucket: 'Start of Day' },
  mind_check: { title: 'Before The Hard Part', bucket: 'Before The Hard Part' },
  stress_reset: { title: 'Stress Reset', bucket: 'Hard Moment' },
  evening_unload: { title: 'Evening Unload', bucket: 'Evening' },
  after_trigger_reset: { title: 'After Trigger Reset', bucket: 'Hard Moment' },
  tonight_rescue: { title: 'SOS Reset', bucket: 'Anytime' },
  user_commitment: { title: 'Commitment', bucket: 'Always On' },
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

function normalizeChoiceArray(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function deriveSupportRisk(profile, state = {}) {
  let score = 0;
  if (profile.main_issue === 'A bit of everything') score += 2;
  if (profile.stress_pattern === 'It comes in random waves') score += 2;
  if (normalizeChoiceArray(profile.triggers).length >= 4) score += 1;
  if ((state.lastCheckInScore || 10) <= 4) score += 2;
  if ((state.lastMorningEnergy || 5) <= 2) score += 1;
  if ((state.resetStreak || 0) >= 3) score -= 1;
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

function emptyLunaState() {
  return {
    agentId: 'luna',
    setupComplete: false,
    setupProgress: 0,
    profile: {},
    setupAnswers: {},
    resetStreak: 0,
    lastCheckInScore: null,
    lastMorningEnergy: null,
    lastStressMoment: null,
    lastNeedNow: null,
    lastRequestedSupportStyle: null,
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

async function getOrCreateLunaState(userId) {
  const ref = agentRef(userId);
  const snap = await ref.get();
  if (!snap.exists) {
    const initial = emptyLunaState();
    await ref.set(initial, { merge: true });
    return initial;
  }
  return { ...emptyLunaState(), ...snap.data() };
}

async function getLunaMessages(userId, limit = 60) {
  const snap = await messagesRef(userId).orderBy('timestamp', 'asc').limit(limit).get();
  return snap.docs.map((doc) => doc.data());
}

async function getLunaActions(userId) {
  const snap = await actionsRef(userId)
    .orderBy('createdAt', 'desc')
    .limit(100)
    .get();
  return snap.docs
    .map((doc) => doc.data())
    .filter((action) => action.agentId === 'luna');
}

function formatProfileSummary(profile) {
  const triggers = normalizeChoiceArray(profile.triggers).join(', ') || 'none specified';
  const autoActions = normalizeChoiceArray(profile.auto_actions).join(', ') || 'none';
  return `Main issue: ${profile.main_issue || 'unknown'}
Hardest moment: ${profile.stress_pattern || 'unknown'}
Triggers: ${triggers}
Body signal: ${profile.body_signal || 'unknown'}
Morning reset time: ${profile.morning_reset_time || 'unknown'}
Stress reset time: ${profile.stress_reset_time || 'unknown'}
Evening unload time: ${profile.evening_unload_time || 'unknown'}
Primary goal: ${profile.primary_goal || 'unknown'}
Preferred style: ${profile.luna_style || 'unknown'}
Enabled actions: ${autoActions}`;
}

function buildLunaLiveContext(agentState, profile, actions = []) {
  const activeActions = actions
    .filter((action) => ['active', 'snoozed'].includes(action.status))
    .slice(0, 6)
    .map((action) => `- ${action.title} (${action.status})${action.schedule?.time ? ` at ${action.schedule.time}` : ''}`)
    .join('\n') || '- none';

  return `\n\n━━━ USER PROFILE ━━━\n${formatProfileSummary(profile)}\n\n━━━ LIVE STATE ━━━
Risk level: ${agentState.currentRiskLevel || 'medium'}
Reset streak: ${agentState.resetStreak || 0}
Last check-in score: ${agentState.lastCheckInScore ?? 'none'}
Last morning energy: ${agentState.lastMorningEnergy ?? 'none'}
Current mode: ${agentState.currentMode || 'normal'}
Active focus: ${agentState.activeFocus || profile.primary_goal || 'feel steadier faster'}
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

function buildLunaCheckinSurvey(contextMode, action = null) {
  const titleMap = {
    morning_reset: 'Log how you are starting',
    trigger_prep: 'Prepare for the hard part',
    midday_reset: 'Log this stress moment',
    evening_checkin: 'Unload the day',
  };

  if (!titleMap[contextMode]) {
    return null;
  }

  return {
    id: `luna_${contextMode}_${action?.id || 'default'}`,
    kind: 'guided_checkin',
    contextMode,
    title: titleMap[contextMode],
    intro: 'A few quick answers so LUNA can support you more precisely.',
    submitLabel: 'Send to LUNA',
    questions: [
      {
        id: 'feeling_now',
        type: 'choice',
        title: 'How are you feeling right now?',
        options: ['Calm', 'Tense', 'Overthinking', 'Overwhelmed'],
      },
      {
        id: 'main_trigger',
        type: 'choice',
        title: 'What is driving it most?',
        options: ['Work', 'Someone', 'My thoughts', 'Nothing clear'],
      },
      {
        id: 'need_now',
        type: 'choice',
        title: 'What would help most right now?',
        options: ['Grounding', 'One clear next step', 'Vent space', 'Reset before next thing'],
      },
      {
        id: 'do_more_of',
        type: 'choice',
        title: 'What should LUNA do more of?',
        options: ['Check in earlier', 'Help before hard moments', 'Help after hard moments', 'Keep it lighter'],
      },
      {
        id: 'final_note',
        type: 'text',
        title: 'Anything else you want LUNA to know?',
        optional: true,
        placeholder: 'Optional',
      },
    ],
  };
}

function summarizeLunaStructuredCheckin(payload = {}) {
  const pieces = [];
  if (payload.feeling_now) pieces.push(`Feeling: ${payload.feeling_now}`);
  if (payload.main_trigger) pieces.push(`Trigger: ${payload.main_trigger}`);
  if (payload.need_now) pieces.push(`Need: ${payload.need_now}`);
  if (payload.do_more_of) pieces.push(`Do more of: ${payload.do_more_of}`);
  if (payload.final_note) pieces.push(`Extra: ${payload.final_note}`);
  return pieces.join('. ');
}

function parseLunaStructuredCheckin(payload = {}) {
  const ratingMap = {
    Calm: 8,
    Tense: 5,
    Overthinking: 4,
    Overwhelmed: 2,
  };
  const energyMap = {
    Calm: 4,
    Tense: 3,
    Overthinking: 2,
    Overwhelmed: 1,
  };
  const triggerMap = {
    Work: 'work',
    Someone: 'people',
    'My thoughts': 'thoughts',
    'Nothing clear': 'unclear',
  };
  return {
    rating: ratingMap[payload.feeling_now] || null,
    morningEnergy: energyMap[payload.feeling_now] || null,
    stressMoment: triggerMap[payload.main_trigger] || null,
    needNow: payload.need_now || null,
    doMoreOf: payload.do_more_of || null,
    finalNote: payload.final_note || '',
  };
}

async function storeLunaCheckin(userId, payload = {}, contextMode = 'normal', messageId = null) {
  const parsed = parseLunaStructuredCheckin(payload);
  const ref = logsRef(userId).doc();
  const createdAt = nowIso();
  const entry = {
    id: ref.id,
    type: contextMode,
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
  if (mode === 'morning_reset') {
    return `This is the morning reset. Keep it brief. Ask how they are entering the day, how heavy things feel, or what would help them stay steady. Their main goal is "${profile.primary_goal || 'feel calmer faster'}".`;
  }
  if (mode === 'trigger_prep') {
    return 'This is the support moment before a known hard stretch. Help them steady themselves before the trigger hits. Be practical and specific.';
  }
  if (mode === 'midday_reset') {
    return 'This is the stress-reset moment. Focus on what is happening right now in their body or thoughts, then give one grounding move.';
  }
  if (mode === 'evening_checkin') {
    return 'This is the evening unload. Help them clear the day instead of carrying it into the night. Be specific and useful, not motivational.';
  }
  if (mode === 'rescue') {
    return 'This is rescue mode. The user likely needs one clear move right now. Be calm but decisive.';
  }
  if (mode === 'action_followup') {
    return 'This is action follow-up. Reference the action in plain language and keep it to one move.';
  }
  return 'Normal mode. Be concise, specific, and easy to act on right now.';
}

async function generateSetupMessage(userName, profile, starterActions) {
  const actionSummary = starterActions.map((action) => `${action.title}${action.schedule?.time ? ` at ${action.schedule.time}` : ''}`).join(', ');
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.7,
      max_tokens: 90,
      messages: [
        { role: 'system', content: `${LUNA_IDENTITY.corePrompt}

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
  const systemPrompt = `${LUNA_IDENTITY.corePrompt}${buildLunaLiveContext(state, profile, actions)}

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
    'Let’s make this smaller and steadier, one move at a time.'
  );
}

function getActionKey(type) {
  return `luna_${type}`;
}

function titleForType(type) {
  return ACTION_TYPE_META[type]?.title || type;
}

function buildStarterActionTemplates(profile) {
  const actions = [];
  const enabled = new Set(normalizeChoiceArray(profile.auto_actions));
  const morningResetTime = profile.morning_reset_time || '8:00 AM';
  const stressResetTime = profile.stress_reset_time || '1:00 PM';
  const mindCheckTime = subtractMinutes(stressResetTime, 25);
  const eveningUnloadTime = profile.evening_unload_time || '9:30 PM';
  const mainIssue = (profile.main_issue || '').toLowerCase();
  const pattern = profile.stress_pattern || '';
  const triggers = normalizeChoiceArray(profile.triggers);
  const bodySignal = profile.body_signal || '';

  let prepTitle = 'Before The Hard Part';
  let prepDetail = 'Get ahead of the moment that usually tightens your system up.';
  let prepWhyNow = 'LUNA should meet you before the pressure peaks, not after.';

  if (pattern === 'Before hard conversations' || triggers.includes('Texts or difficult people')) {
    prepTitle = 'Before Hard Conversations';
    prepDetail = 'Steady yourself before texts, conflict, or a difficult conversation changes your whole nervous system.';
    prepWhyNow = 'People-triggered stress usually hits fastest when you go in unprepared.';
  } else if (pattern === 'In the middle of the workday' || triggers.includes('Work pressure')) {
    prepTitle = 'Before Work Pressure';
    prepDetail = 'Create a steadier entry into the part of the day that usually squeezes your mind and body.';
    prepWhyNow = 'A reset before pressure lands is more useful than trying to recover late.';
  } else if (pattern === 'At night when I am alone') {
    prepTitle = 'Before The Night Spiral';
    prepDetail = 'Notice the emotional build-up before the night turns into replaying and overthinking.';
    prepWhyNow = 'The night usually gets harder once your mind is already running.';
  }

  if (enabled.has('Morning reset')) {
    actions.push({
      key: getActionKey('morning_reset'),
      type: 'morning_reset',
      title: 'Morning Reset',
      subtitle: morningResetTime,
      detail: 'Tell LUNA how you are entering the day.',
      reason: 'Runs every morning.',
      whyNow: 'This keeps your pattern clear before the day gets noisy.',
      schedule: { kind: 'daily', time: morningResetTime },
      priority: 'high',
      successMetric: 'Log your morning emotional baseline',
      source: 'setup',
      confidence: 0.97,
      editable: true,
      status: 'active',
    });
  }

  if (enabled.has('Mind check reminder')) {
    actions.push({
      key: getActionKey('mind_check'),
      type: 'mind_check',
      title: prepTitle,
      subtitle: mindCheckTime,
      detail: prepDetail,
      reason: 'Runs every day.',
      whyNow: prepWhyNow,
      schedule: { kind: 'daily', time: mindCheckTime },
      priority: 'medium',
      successMetric: 'Notice the build-up before it owns the whole moment',
      source: 'setup',
      confidence: 0.91,
      editable: true,
      status: 'active',
    });
  }

  if (enabled.has('Stress reset reminder')) {
    actions.push({
      key: getActionKey('stress_reset'),
      type: 'stress_reset',
      title: bodySignal === 'Shallow breathing' ? 'Breathing Reset' : 'Stress Reset',
      subtitle: stressResetTime,
      detail: 'Pause the build-up and regulate before the moment turns into a full spiral.',
      reason: 'Runs every day.',
      whyNow: 'This gives LUNA a reliable moment to help before the day runs away from you.',
      schedule: { kind: 'daily', time: stressResetTime },
      priority: 'high',
      successMetric: 'Interrupt the spike before it becomes the whole day',
      source: 'setup',
      confidence: 0.94,
      editable: true,
      status: 'active',
    });
  }

  if (enabled.has('Evening unload')) {
    actions.push({
      key: getActionKey('evening_unload'),
      type: 'evening_unload',
      title: mainIssue.includes('overthinking') ? 'Stop The Replay' : 'Evening Unload',
      subtitle: eveningUnloadTime,
      detail: 'Offload the emotional residue of the day before you carry it into the night.',
      reason: 'Runs every evening.',
      whyNow: 'This helps close the loop instead of replaying it for hours.',
      schedule: { kind: 'daily', time: eveningUnloadTime },
      priority: 'medium',
      successMetric: 'End the day with less emotional carryover',
      source: 'setup',
      confidence: 0.9,
      editable: true,
      status: 'active',
    });
  }

  if (pattern === 'It comes in random waves' || triggers.includes('I honestly do not know')) {
    actions.push({
      key: getActionKey('after_trigger_reset'),
      type: 'after_trigger_reset',
      title: 'After Trigger Reset',
      subtitle: 'Any time you get hit hard',
      detail: 'Keep one fast follow-up reset ready for the moments that feel harder to predict.',
      reason: 'Always available.',
      whyNow: 'When the trigger is less predictable, recovery speed matters more than perfect timing.',
      schedule: { kind: 'conditional', trigger: 'manual' },
      priority: 'medium',
      successMetric: 'Recover faster after unexpected triggers',
      source: 'setup',
      confidence: 0.86,
      editable: false,
      status: 'active',
    });
  }

  return actions;
}

async function ensureCoreLunaActions(userId, profile = {}) {
  if (!profile || !Object.keys(profile).length) {
    return [];
  }

  const existingActions = await getLunaActions(userId);
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
      return data.agentId === 'luna' && data.actionId === action.id;
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
    agentId: 'luna',
    actionId: action.id,
    triggerAt: nextTriggerAt,
    type: action.type,
    contextMode: action.type === 'morning_reset'
      ? 'morning_reset'
      : action.type === 'mind_check'
        ? 'trigger_prep'
        : action.type === 'stress_reset' || action.type === 'after_trigger_reset'
        ? 'midday_reset'
        : action.type === 'evening_unload'
          ? 'evening_checkin'
        : 'action_followup',
    opener: action.detail,
    quickReplies: getQuickRepliesForMode(
      action.type === 'morning_reset'
        ? 'morning_reset'
        : action.type === 'tonight_rescue'
          ? 'rescue'
          : action.type === 'mind_check'
            ? 'trigger_prep'
            : action.type === 'stress_reset' || action.type === 'after_trigger_reset'
            ? 'midday_reset'
            : action.type === 'evening_unload'
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
        return data.agentId === 'luna' && data.actionId === action.id;
      })
      .map((doc) => doc.ref.delete())
  );

  const triggerRef = scheduledRef(userId).doc();
  await triggerRef.set({
    id: triggerRef.id,
    userId,
    agentId: 'luna',
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
    agentId: 'luna',
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

async function createLunaAutomations(userId, userName, answers) {
  const profile = { ...answers };
  const starterActions = buildStarterActionTemplates(profile);
  return Promise.all(starterActions.map((action) => upsertAction(userId, action)));
}

function inferModeFromMessage(text, fallback = 'normal') {
  const lower = text.toLowerCase();
  if (/(spiral|spiraling|panic|panicking|can't calm down|cannot calm down|too overwhelmed|ground me)/i.test(lower)) return 'rescue';
  if (/(just woke|this morning|starting the day|woke up|today feels)/i.test(lower)) return 'morning_reset';
  if (/(before the meeting|before work|before class|before i text|before the call|hard conversation coming)/i.test(lower)) return 'trigger_prep';
  if (/(stress spike|heart racing|can't focus|meeting|before work|before class)/i.test(lower)) return 'midday_reset';
  if (/(tonight|replaying|mind racing|carrying today|need to unload)/i.test(lower)) return 'evening_checkin';
  return fallback;
}

function fallbackActionDecision(message, profile, actions) {
  const lower = message.toLowerCase();
  const results = [];
  const activeTypes = new Set(actions.filter((action) => action.status === 'active').map((action) => action.type));
  if (
    /(meeting|presentation|hard call|before work|before class|before i go in|hard conversation|before i text)/.test(lower) &&
    !activeTypes.has('mind_check') &&
    profile.stress_reset_time
  ) {
    results.push({
      type: 'create',
      action: {
        key: getActionKey('mind_check'),
        type: 'mind_check',
        title: 'Before The Hard Part',
        subtitle: subtractMinutes(profile.stress_reset_time, 25),
        detail: 'LUNA added this because there is a repeatable hard moment worth preparing for before it hits.',
        reason: 'Added from conversation because the pressure point sounds predictable enough to support early.',
        whyNow: 'Support before impact is better than trying to recover after you are already flooded.',
        schedule: { kind: 'daily', time: subtractMinutes(profile.stress_reset_time, 25) },
        priority: 'high',
        successMetric: 'Steadier entry into the hard part',
        source: 'chat',
        confidence: 0.81,
        editable: true,
        status: 'active',
      },
    });
  }
  if (
    /(after the call|after i talk to|after they text|after we fight|after the meeting|after the conversation)/.test(lower) &&
    !activeTypes.has('after_trigger_reset')
  ) {
    results.push({
      type: 'create',
      action: {
        key: getActionKey('after_trigger_reset'),
        type: 'after_trigger_reset',
        title: 'After Trigger Reset',
        subtitle: 'Use after hard contact',
        detail: 'LUNA added this because the emotional drop after hard moments seems to stick around.',
        reason: 'Added from conversation because the aftermath sounds just as important as the trigger itself.',
        whyNow: 'The moment after impact is where a fast reset can stop the whole day from bending around it.',
        schedule: { kind: 'conditional', trigger: 'manual' },
        priority: 'high',
        successMetric: 'Recover faster after triggering contact',
        source: 'chat',
        confidence: 0.83,
        editable: false,
        status: 'active',
      },
    });
  }
  if (
    /(overthinking at night|mind races at night|replaying|can't switch off|carry the day)/.test(lower) &&
    !activeTypes.has('evening_unload') &&
    profile.evening_unload_time
  ) {
    results.push({
      type: 'create',
      action: {
        key: getActionKey('evening_unload'),
        type: 'evening_unload',
        title: 'Evening Unload',
        subtitle: profile.evening_unload_time,
        detail: 'LUNA added this because your mind is still carrying the whole day into the night.',
        reason: 'Added from conversation because overthinking is still active at night.',
        whyNow: 'Closing the loop at night should feel easier than replaying it for hours.',
        schedule: { kind: 'daily', time: profile.evening_unload_time },
        priority: 'high',
        successMetric: 'Less emotional carryover at night',
        source: 'chat',
        confidence: 0.79,
        editable: true,
        status: 'active',
      },
    });
  }
  if (/(spiral|panicking|too overwhelmed|need help now|ground me)/.test(lower) && !activeTypes.has('tonight_rescue')) {
    results.push({
      type: 'create',
      action: {
        key: `luna_rescue_${Date.now()}`,
        type: 'tonight_rescue',
        title: 'SOS Reset',
        subtitle: 'Ready when the spiral hits',
        detail: 'LUNA added a rescue action because this needs fast support, not a long plan.',
        reason: 'Added from conversation because the moment sounds acute.',
        whyNow: 'The fastest useful move matters more than the perfect one.',
        schedule: {kind: 'conditional', trigger: 'manual'},
        priority: 'high',
        successMetric: 'Get regulated faster in hard moments',
        source: 'chat',
        confidence: 0.85,
        editable: true,
        status: 'active',
      },
    });
  }
  if (/i('ll| will| am going to| gonna| going to) /.test(lower)) {
    results.push({
      type: 'create',
      action: {
        key: `luna_commitment_${Date.now()}`,
        type: 'user_commitment',
        title: 'Keep Your Commitment',
        subtitle: 'Something you said you want to do',
        detail: 'LUNA captured this because you made a real commitment in chat.',
        reason: 'Added from your own words so the plan does not vanish after this conversation.',
        whyNow: 'What matters is what actually happens when the moment comes.',
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
          content: `You are LUNA's action engine.
Decide if the user's latest message should create or update a support action.
Return JSON with shape:
{
  "mode":"normal|evening_checkin|morning_reset|trigger_prep|midday_reset|rescue|action_followup",
  "changes":[
    {
      "type":"create|none",
      "actionType":"stress_reset|morning_reset|mind_check|evening_unload|after_trigger_reset|user_commitment|tonight_rescue",
      "title":"string",
      "subtitle":"string",
      "detail":"string",
      "reason":"string",
      "whyNow":"string",
      "scheduleKind":"daily|weekly|one_time|conditional",
      "time":"10:30 PM or null",
      "days":["fri","sat"],
      "trigger":"manual|null",
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
Risk=${state.currentRiskLevel}; streak=${state.resetStreak}; lastCheckIn=${state.lastCheckInScore}; lastEnergy=${state.lastMorningEnergy}
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
          key: change.actionType === 'user_commitment' ? `luna_commitment_${Date.now()}` : getActionKey(change.actionType),
          type: change.actionType,
          title: change.title || titleForType(change.actionType),
          subtitle: change.subtitle || '',
          detail: change.detail || '',
          reason: change.reason || 'Added by LUNA from the conversation.',
          whyNow: change.whyNow || 'The conversation made this feel worth acting on.',
          schedule: change.scheduleKind === 'conditional' ? { kind: 'conditional', trigger: change.trigger || 'manual' } : {
            kind: change.scheduleKind || 'daily',
            time: change.time || null,
            days: change.days || [],
            trigger: change.trigger || null,
          },
          priority: change.priority || 'medium',
          successMetric: change.successMetric || 'Make the day feel more manageable',
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

function parseLunaCheckinHeuristic(message) {
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
  let stressMoment = null;
  if (/meeting|call|work|class/.test(lower)) stressMoment = 'work';
  else if (/text|person|conversation|argument/.test(lower)) stressMoment = 'people';
  else if (/night|late/.test(lower)) stressMoment = 'night';
  return { rating, morningEnergy, stressMoment };
}

async function processLunaCheckinReply(userId, userMessage, structuredCheckin = null) {
  const state = await getOrCreateLunaState(userId);
  const parsed = structuredCheckin
    ? parseLunaStructuredCheckin(structuredCheckin)
    : parseLunaCheckinHeuristic(userMessage);
  if (parsed.rating == null && parsed.morningEnergy == null && !parsed.stressMoment) return state;

  let resetStreak = state.resetStreak || 0;
  if (parsed.rating != null) {
    if (parsed.rating >= 6) resetStreak += 1;
    else if (parsed.rating <= 4) resetStreak = 0;
  }

  const patch = {
    resetStreak,
    updatedAt: nowIso(),
    currentMode: 'normal',
  };
  if (parsed.rating != null) patch.lastCheckInScore = parsed.rating;
  if (parsed.morningEnergy != null) patch.lastMorningEnergy = parsed.morningEnergy;
  if (parsed.stressMoment != null) patch.lastStressMoment = parsed.stressMoment;
  if (parsed.needNow != null) patch.lastNeedNow = parsed.needNow;
  if (parsed.doMoreOf != null) patch.lastRequestedSupportStyle = parsed.doMoreOf;
  patch.currentRiskLevel = deriveSupportRisk(state.profile || {}, { ...state, ...patch });

  await agentRef(userId).set(patch, { merge: true });
  return { ...state, ...patch };
}

async function extractLunaAction(userId, userName, userMessage) {
  const state = await getOrCreateLunaState(userId);
  const actions = await getLunaActions(userId);
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
    { key: 'Start of Day', items: [] },
    { key: 'Before The Hard Part', items: [] },
    { key: 'Hard Moment', items: [] },
    { key: 'Evening', items: [] },
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

  let pattern = 'Your stress pattern is visible enough now that LUNA can start getting ahead of it.';
  if (/work|meeting|deadline/.test(text) || profile.stress_pattern === 'In the middle of the workday') {
    pattern = 'The workday still looks like the fastest place for your system to tighten up.';
  } else if (/night|replaying|overthinking/.test(text) || profile.stress_pattern === 'At night when I am alone') {
    pattern = 'The day is still following you into the night instead of actually ending.';
  } else if (/people|text|argument|conversation/.test(text)) {
    pattern = 'Other people still seem to be the fastest trigger for your nervous system.';
  }

  const wins = [];
  if ((state.resetStreak || 0) >= 2) wins.push(`You have ${state.resetStreak} steadier check-ins in a row right now.`);
  if ((state.lastCheckInScore || 0) >= 7) wins.push(`Your latest check-in landed at ${state.lastCheckInScore}/10.`);
  if (activeActions.length >= 3) wins.push(`LUNA is actively running ${activeActions.length} support actions for you.`);
  if (wins.length === 0) wins.push('The good news is your pattern is clear enough to start acting on.');

  const risks = [];
  if ((state.lastCheckInScore || 10) <= 4) risks.push('Recent emotional load is still high enough that rescue support needs to stay close.');
  if ((state.lastMorningEnergy || 5) <= 2) risks.push('Low energy is still making it harder to regulate early in the day.');
  if (profile.stress_pattern === 'It comes in random waves') risks.push('Because your pattern still feels random, LUNA needs more signal to get sharper.');
  if (risks.length === 0) risks.push('The next risk is getting pulled back into the same trigger before you notice it happening.');

  return {
    generatedAt: nowIso(),
    summary: pattern,
    patterns: [pattern],
    wins: wins.slice(0, 2),
    risks: risks.slice(0, 2),
    focus: profile.primary_goal || 'Stay steadier across the next few real moments.',
    chart: buildCheckInChart(messages),
  };
}

function buildCheckInChart(messages) {
  const userMessages = messages.filter((message) => message.role === 'user');
  const recent = userMessages.slice(-14);
  const chart = [];
  recent.forEach((message) => {
    const parsed = parseLunaCheckinHeuristic(message.content || '');
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

async function generateLunaAnalysis(userId, state, messages, actions) {
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
          content: `You generate a sharp weekly analysis for a premium emotional support agent.
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
- Use the user's actual stress pattern, triggers, and actions.
- Keep every line short and premium.
- If the signal is weak, still make the summary useful and honest.`,
        },
        {
          role: 'user',
          content: `Profile:
${formatProfileSummary(state.profile || {})}

Current state:
Risk: ${state.currentRiskLevel}
Reset streak: ${state.resetStreak}
Last check-in score: ${state.lastCheckInScore}
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

async function buildLunaStatePayload(userId) {
  const state = await getOrCreateLunaState(userId);
  if (state.setupComplete) {
    await ensureCoreLunaActions(userId, state.profile || {});
  }
  const [messages, actions] = await Promise.all([
    getLunaMessages(userId),
    getLunaActions(userId),
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
      if (trigger.agentId !== 'luna') return;
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
        survey: buildLunaCheckinSurvey(trigger.contextMode || 'normal', action),
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
              title: 'LUNA',
              body: message.content.slice(0, 120),
            },
            data: {
              screen: 'Luna',
              agentId: 'luna',
              contextMode: trigger.contextMode || 'normal',
            },
          });
        } catch (error) {
          console.error('LUNA FCM error:', error.message);
        }
      }
    }));
  }));
}

async function maybeCreateRescueAction(userId, state) {
  if ((state.lastCheckInScore || 10) > 4) return null;
  const draft = {
    key: `luna_recovery_${new Date().toISOString().slice(0, 10)}`,
    type: 'tonight_rescue',
    title: 'SOS Reset',
    subtitle: 'Keep one fast reset ready',
    detail: 'LUNA added a rescue action because your recent check-in sounded heavy enough to need fast support.',
    reason: 'Added because your recent signal suggests you need lower-friction support ready.',
    whyNow: 'The goal is to get grounded faster when the spiral hits.',
    schedule: { kind: 'conditional', trigger: 'manual' },
    priority: 'high',
    successMetric: 'Recover faster from the hardest moments',
    source: 'adaptive_engine',
    confidence: 0.82,
    editable: true,
    status: 'active',
    expiresAt: new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString(),
  };
  return upsertAction(userId, draft);
}

async function maybeCreateAdaptiveAction(userId, actions, actionKey, draftFactory) {
  const hasExisting = actions.some(
    (action) =>
      action.key === actionKey &&
      ['active', 'snoozed'].includes(action.status)
  );
  if (hasExisting) return null;
  return upsertAction(userId, draftFactory());
}

async function runLunaNightlyAnalysis(firestoreDb = db) {
  if (firestoreDb) db = firestoreDb;
  const usersSnap = await db.collection('wellness_users').limit(500).get();
  await Promise.all(usersSnap.docs.map(async (userDoc) => {
    const userId = userDoc.id;
    const state = await getOrCreateLunaState(userId);
    if (!state.setupComplete) return;

    const actions = await getLunaActions(userId);
    const recentMessages = await getLunaMessages(userId, 24);
    const morningReplies = recentMessages
      .filter((msg) => msg.role === 'user' && ['morning_reset', 'normal'].includes(msg.contextMode || 'normal'))
      .slice(-5);

    let overwhelmMentions = 0;
    let workMentions = 0;
    let peopleMentions = 0;
    morningReplies.forEach((msg) => {
      const lower = msg.content.toLowerCase();
      if (/anx|overwhelm|panic|spiral|heavy/.test(lower)) overwhelmMentions += 1;
      if (/work/.test(lower)) workMentions += 1;
      if (/text|conversation|person|argument/.test(lower)) peopleMentions += 1;
    });

    const nextState = {
      ...state,
      currentRiskLevel: deriveSupportRisk(state.profile || {}, state),
      updatedAt: nowIso(),
    };
    if (workMentions >= 2) nextState.activeFocus = 'The workday still looks like your hardest emotional stretch.';
    else if (peopleMentions >= 2) nextState.activeFocus = 'People-triggered stress still needs a faster reset.';
    else if (overwhelmMentions >= 2) nextState.activeFocus = state.profile?.primary_goal || 'Make the next hard moment easier to handle.';

    nextState.analysis = await generateLunaAnalysis(userId, nextState, recentMessages, actions);
    await agentRef(userId).set({
      currentRiskLevel: nextState.currentRiskLevel,
      activeFocus: nextState.activeFocus || null,
      analysis: nextState.analysis,
      updatedAt: nextState.updatedAt,
    }, { merge: true });

    if ((state.lastCheckInScore || 10) <= 4) {
      await maybeCreateRescueAction(userId, nextState);
    }

    if (workMentions >= 2) {
      await maybeCreateAdaptiveAction(userId, actions, getActionKey('mind_check'), () => ({
        key: getActionKey('mind_check'),
        type: 'mind_check',
        title: 'Before Work Pressure',
        subtitle: subtractMinutes(state.profile?.stress_reset_time || '1:00 PM', 25),
        detail: 'LUNA added this because the workday still looks like the moment where everything tightens fastest.',
        reason: 'Added because recent signal still points back to work pressure.',
        whyNow: 'Getting ahead of the workday is more useful than trying to recover once it has already taken over.',
        schedule: {
          kind: 'daily',
          time: subtractMinutes(state.profile?.stress_reset_time || '1:00 PM', 25),
        },
        priority: 'high',
        successMetric: 'Start the hardest stretch steadier',
        source: 'adaptive_engine',
        confidence: 0.84,
        editable: true,
        status: 'active',
      }));
    }

    if (peopleMentions >= 2) {
      await maybeCreateAdaptiveAction(userId, actions, getActionKey('after_trigger_reset'), () => ({
        key: getActionKey('after_trigger_reset'),
        type: 'after_trigger_reset',
        title: 'After Trigger Reset',
        subtitle: 'Use after hard contact',
        detail: 'LUNA added this because hard interactions still seem to linger long after they happen.',
        reason: 'Added because your recent pattern still points back to hard interactions.',
        whyNow: 'The faster you reset after impact, the less of the day gets shaped by it.',
        schedule: {
          kind: 'conditional',
          trigger: 'manual',
        },
        priority: 'high',
        successMetric: 'Shorten the emotional aftershock',
        source: 'adaptive_engine',
        confidence: 0.84,
        editable: false,
        status: 'active',
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
    config: LUNA_SETUP_CONFIG,
    quickReplies: QUICK_REPLIES,
    actionTypes: ACTION_TYPE_META,
  });
});

router.get('/state/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    await getOrCreateUser(userId);
    const payload = await buildLunaStatePayload(userId);
    res.json(payload);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/analysis/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const state = await getOrCreateLunaState(userId);
    const [messages, actions] = await Promise.all([
      getLunaMessages(userId, 40),
      getLunaActions(userId),
    ]);
    const analysis = state.analysis || await generateLunaAnalysis(userId, state, messages, actions);
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
      setupProgress: LUNA_SETUP_CONFIG.questions.length,
      setupAnswers: answers,
      profile,
      activeFocus: profile.primary_goal || 'Feel steadier in the moments that usually get loud',
      currentMode: 'normal',
      currentRiskLevel: deriveSupportRisk(profile),
      updatedAt: nowIso(),
    };
    await agentRef(userId).set(statePatch, { merge: true });

    const starterMessage = await generateSetupMessage(userName, profile, starterActions)
      || `Your pattern is clear enough to start acting on. I’ve already set up a few support moves around ${profile.main_issue?.toLowerCase() || 'the moments that hit hardest'}. What usually tips first when things start getting loud?`;

    const existingMessages = await getLunaMessages(userId, 5);
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

    const starterState = await getOrCreateLunaState(userId);
    const starterMessages = await getLunaMessages(userId, 20);
    const starterAnalysis = await generateLunaAnalysis(
      userId,
      starterState,
      starterMessages,
      starterActions,
    );
    await agentRef(userId).set(
      {analysis: starterAnalysis, updatedAt: nowIso()},
      {merge: true},
    );

    const payload = await buildLunaStatePayload(userId);
    res.json({
      ...payload,
      starterPlan: buildStarterPlanSummary(starterActions),
      starterMessage: firstMessage,
    });
  } catch (error) {
    console.error('LUNA setup error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/chat', async (req, res) => {
  try {
    const { userId, userName, message, contextMode = 'normal', structuredCheckin = null } = req.body;
    if (!userId || !message) return res.status(400).json({ success: false, error: 'userId and message are required' });

    await getOrCreateUser(userId, userName);
    const state = await getOrCreateLunaState(userId);
    const profile = state.profile || {};
    const [history, actions] = await Promise.all([
      getLunaMessages(userId, 40),
      getLunaActions(userId),
    ]);

    const normalizedMessage = structuredCheckin
      ? summarizeLunaStructuredCheckin(structuredCheckin)
      : message;
    const resolvedMode = inferModeFromMessage(normalizedMessage, contextMode || state.currentMode || 'normal');
    const userMsg = await saveMessage(userId, {
      role: 'user',
      content: normalizedMessage,
      contextMode: resolvedMode,
      structuredCheckin,
    });

    let updatedState = state;
    if (['morning_reset', 'trigger_prep', 'midday_reset', 'evening_checkin'].includes(resolvedMode)) {
      updatedState = await processLunaCheckinReply(userId, normalizedMessage, structuredCheckin);
      if (structuredCheckin) {
        await storeLunaCheckin(userId, structuredCheckin, resolvedMode, userMsg.id);
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
      currentRiskLevel: deriveSupportRisk(profile, updatedState),
    }, { merge: true });

    const latestState = await getOrCreateLunaState(userId);
    const latestMessages = await getLunaMessages(userId, 30);
    const latestActions = await getLunaActions(userId);
    const analysis = await generateLunaAnalysis(
      userId,
      latestState,
      latestMessages,
      latestActions,
    );
    await agentRef(userId).set({analysis, updatedAt: nowIso()}, {merge: true});

    const payload = await buildLunaStatePayload(userId);
    res.json({
      ...payload,
      userMessage: userMsg,
      agentMessage: agentMsg,
      actionChanges: createdActions,
    });
  } catch (error) {
    console.error('LUNA chat error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/actions/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const state = await getOrCreateLunaState(userId);
    if (state.setupComplete) {
      await ensureCoreLunaActions(userId, state.profile || {});
    }
    const actions = await getLunaActions(userId);
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
    const state = await getOrCreateLunaState(userId);
    if (state.setupComplete) {
      await ensureCoreLunaActions(userId, state.profile || {});
    }
    const doc = await actionsRef(userId).doc(actionId).get();
    if (!doc.exists) return res.status(404).json({ success: false, error: 'Action not found' });

    const action = doc.data();
    if (action.agentId !== 'luna') return res.status(400).json({ success: false, error: 'Not a LUNA action' });

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
            return data.agentId === 'luna' && data.actionId === actionId;
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
    const state = await getOrCreateLunaState(userId);
    await runLunaNightlyAnalysis(db);
    res.json({ success: true, state });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = {
  router,
  setDb,
  processScheduledTriggers,
  runLunaNightlyAnalysis,
  createLunaAutomations,
  processLunaCheckinReply,
  extractLunaAction,
  buildLunaLiveContext,
  LUNA_SETUP_CONFIG,
  LUNA_IDENTITY,
};
