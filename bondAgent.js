const express = require('express');
const { OpenAI } = require('openai');

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let db;
function setDb(firestoreDb) {
  db = firestoreDb;
}

const userRef = (uid) => db.collection('wellness_users').doc(uid);
const agentRef = (uid) => userRef(uid).collection('wellness_agents').doc('bond');
const messagesRef = (uid) => agentRef(uid).collection('wellness_messages');
const logsRef = (uid) => agentRef(uid).collection('daily_logs');
const actionsRef = (uid) => userRef(uid).collection('wellness_actions');
const scheduledRef = (uid) => userRef(uid).collection('wellness_scheduled');

const BOND_SETUP_CONFIG = {
  version: 1,
  intro: {
    eyebrow: 'BOND',
    title: 'Let’s set up your relationship agent.',
    body: 'A few sharp choices, then BOND builds the tools, reflections, and rescue flows that fit how your relationships actually get hard.',
  },
  questions: [
    {
      id: 'relationship_context',
      type: 'choice',
      title: 'What is this mostly about right now?',
      options: [
        'A partner',
        'A situationship',
        'An ex or breakup',
        'Someone unclear or mixed-signal',
      ],
    },
    {
      id: 'main_pain',
      type: 'choice',
      title: 'What hurts most?',
      options: [
        'Overthinking texts',
        'Waiting for a reply',
        'Conflict and arguments',
        'Unclear intentions',
        'Boundary problems',
        'Breakup or emotional distance',
      ],
    },
    {
      id: 'hardest_moments',
      type: 'multiselect',
      title: 'Where does it usually go bad?',
      options: [
        'Before I reply',
        'While waiting for a reply',
        'After conflict',
        'Before a hard conversation',
        'When I need to set a boundary',
        'Late at night',
        'When I feel ignored',
        'When I have already said too much',
      ],
    },
    {
      id: 'default_reaction',
      type: 'multiselect',
      title: 'What do you usually do when it hits?',
      options: [
        'Over-explain',
        'Double text or chase reassurance',
        'Shut down',
        'Replay everything privately',
        'Get reactive or angry',
        'Apologize too fast',
        'Say nothing and resent it later',
      ],
    },
    {
      id: 'support_style',
      type: 'choice',
      title: 'How should BOND help when emotions are loud?',
      options: [
        'Calm me down first',
        'Help me phrase things',
        'Tell me the hard truth',
        'Slow me down before I react',
        'Help me protect my self-respect',
      ],
    },
    {
      id: 'pattern_permission',
      type: 'choice',
      title: 'If BOND sees a bad relationship pattern, how direct should it be?',
      options: [
        'Very direct',
        'Direct but gentle',
        'Only when the pattern is clear',
        'Mostly let me lead',
      ],
    },
    {
      id: 'spiral_check_time',
      type: 'time',
      title: 'When should BOND catch late spirals before the night runs away?',
      defaultValue: '10:30 PM',
    },
    {
      id: 'reflection_day',
      type: 'choice',
      title: 'Which day should BOND run your relationship reflection?',
      options: [
        'Sunday',
        'Monday',
        'Friday',
        'Saturday',
      ],
    },
    {
      id: 'reflection_time',
      type: 'time',
      title: 'When should that weekly reflection happen?',
      defaultValue: '9:00 PM',
    },
    {
      id: 'auto_actions',
      type: 'multiselect',
      title: 'Which support systems do you want BOND to set up now?',
      options: [
        'Before Reply',
        'Before Hard Conversation',
        'After Conflict Reset',
        'Waiting Spiral Reset',
        'Boundary Check',
        'Attachment Rescue',
        'Relationship Reflection',
        'Should I Send This?',
      ],
    },
  ],
};

const BOND_IDENTITY = {
  name: 'BOND',
  domain: 'relationships, attachment, texting anxiety, conflict recovery, boundaries, emotional clarity',
  corePrompt: `You are BOND, a premium relationship operator inside Pulse.

WHO YOU ARE:
You help one specific person navigate relational pain, confusion, and pattern loops with clarity, dignity, and emotional intelligence. You are not a generic relationship chatbot. You are warm, perceptive, honest, and excellent in high-stakes moments.

VOICE:
Short. Clear. Intimate. Grounded. No therapy clichés. No manipulative advice. Usually 2 to 4 sentences.

HOW YOU HELP:
You connect what the user is feeling right now to the deeper relationship pattern underneath it. You help before the message is sent, after the hard conversation, during the waiting spiral, and while boundaries are trying to form.

RULES:
- One question max.
- No lists in normal chat.
- If the user is venting, validate first.
- If the user asks what to do, give one clear move.
- If a dynamic looks unhealthy, name it carefully.
- Never default to "just communicate better."
- Never encourage manipulation, testing, or power games.
- Always sound like you actually remember this person.`,
};

const QUICK_REPLIES = {
  normal: ['Need help replying', 'After conflict', 'Waiting on a reply', 'Need clarity'],
  before_reply: ['Review my draft', 'I want to double text', 'Help me slow down', 'Tell me the truth'],
  hard_conversation: ['Help me prepare', 'I need a boundary', 'Keep me calm', 'Give me the words'],
  after_conflict: ['I feel flooded', 'I said too much', 'I shut down', 'What now'],
  waiting_spiral: ['They still have not replied', 'I am spiraling', 'I want to text again', 'Ground me'],
  boundary_check: ['I want to say no', 'Help me be clear', 'Make it softer', 'Make it firm'],
  attachment_rescue: ['I feel abandoned', 'I need reassurance', 'Talk me down', 'Protect my dignity'],
  reflection_checkin: ['Pattern looks better', 'Same loop again', 'Something changed', 'Need insight'],
  action_followup: ['Used it', 'Skipped it', 'Need a better version', 'This helped'],
};

const ACTION_TYPE_META = {
  before_reply: { title: 'Before Reply', bucket: 'Live Tools' },
  hard_conversation_prep: { title: 'Before Hard Conversation', bucket: 'Live Tools' },
  after_conflict_reset: { title: 'After Conflict Reset', bucket: 'Live Tools' },
  waiting_spiral_reset: { title: 'Waiting Spiral Reset', bucket: 'Check-ins' },
  boundary_check: { title: 'Boundary Check', bucket: 'Live Tools' },
  attachment_rescue: { title: 'Attachment Rescue', bucket: 'Live Tools' },
  relationship_reflection: { title: 'Relationship Reflection', bucket: 'Reflections' },
  should_i_send_this: { title: 'Should I Send This?', bucket: 'Live Tools' },
};

const ACTION_TYPE_TO_MODE = {
  before_reply: 'before_reply',
  hard_conversation_prep: 'hard_conversation',
  after_conflict_reset: 'after_conflict',
  waiting_spiral_reset: 'waiting_spiral',
  boundary_check: 'boundary_check',
  attachment_rescue: 'attachment_rescue',
  relationship_reflection: 'reflection_checkin',
  should_i_send_this: 'should_i_send_this',
};

const MODE_TO_ACTION_TYPE = Object.fromEntries(
  Object.entries(ACTION_TYPE_TO_MODE).map(([actionType, mode]) => [mode, actionType])
);

const BOND_ACTION_FLOWS = {
  before_reply: {
    eyebrow: 'OPEN NOW',
    contextMode: 'before_reply',
    title: 'Before Reply',
    intro: 'Use this before you reply so fear does not decide the tone for you.',
    submitLabel: 'Get BOND’s take',
    questions: [
      {
        id: 'what_happened',
        type: 'choice',
        title: 'What happened?',
        options: ['They texted me', 'They ignored me', 'They said something confusing', 'I want to follow up'],
      },
      {
        id: 'emotion',
        type: 'choice',
        title: 'What are you feeling most?',
        options: ['Anxious', 'Hurt', 'Angry', 'Hopeful'],
      },
      {
        id: 'urge',
        type: 'choice',
        title: 'What are you tempted to do?',
        options: ['Reply right now', 'Over-explain', 'Double text', 'Say nothing and stew'],
      },
      {
        id: 'desired_outcome',
        type: 'choice',
        title: 'What outcome do you actually want?',
        options: ['Clarity', 'Connection', 'Self-respect', 'Calm'],
      },
      {
        id: 'final_note',
        type: 'text',
        title: 'Anything else about this reply?',
        optional: true,
        placeholder: 'Optional',
      },
    ],
  },
  should_i_send_this: {
    eyebrow: 'OPEN NOW',
    contextMode: 'should_i_send_this',
    title: 'Should I Send This?',
    intro: 'Paste the draft or summarize it. BOND will help you decide what protects both truth and self-respect.',
    submitLabel: 'Review with BOND',
    questions: [
      {
        id: 'draft_text',
        type: 'text',
        title: 'What are you thinking of sending?',
        placeholder: 'Paste the draft or describe it',
      },
      {
        id: 'desired_outcome',
        type: 'choice',
        title: 'What are you trying to achieve?',
        options: ['Clarity', 'Reassurance', 'Repair', 'To be understood'],
      },
      {
        id: 'tone_goal',
        type: 'choice',
        title: 'What tone do you want?',
        options: ['Soft', 'Clear', 'Firm', 'Warm'],
      },
      {
        id: 'send_decision',
        type: 'choice',
        title: 'What are you leaning toward?',
        options: ['Send as is', 'Rewrite first', 'Wait a little', 'Do not send this'],
      },
      {
        id: 'final_note',
        type: 'text',
        title: 'Anything else BOND should know before deciding?',
        optional: true,
        placeholder: 'Optional',
      },
    ],
  },
  hard_conversation_prep: {
    eyebrow: 'OPEN NOW',
    contextMode: 'hard_conversation',
    title: 'Before Hard Conversation',
    intro: 'Use this before the talk so emotion does not replace clarity.',
    submitLabel: 'Prepare with BOND',
    questions: [
      {
        id: 'what_happened',
        type: 'choice',
        title: 'What kind of conversation is this?',
        options: ['We need clarity', 'I need to say I am hurt', 'I need to set a boundary', 'I need to make a decision'],
      },
      {
        id: 'desired_outcome',
        type: 'choice',
        title: 'What matters most?',
        options: ['Be understood', 'Stay calm', 'Protect self-respect', 'Get clear truth'],
      },
      {
        id: 'boundary_need',
        type: 'choice',
        title: 'What needs protection?',
        options: ['My time', 'My emotional energy', 'My expectations', 'My dignity'],
      },
      {
        id: 'tone_goal',
        type: 'choice',
        title: 'How should BOND help you say it?',
        options: ['Soft', 'Clear', 'Firm', 'Direct but kind'],
      },
      {
        id: 'final_note',
        type: 'text',
        title: 'Anything important about this conversation?',
        optional: true,
        placeholder: 'Optional',
      },
    ],
  },
  after_conflict_reset: {
    eyebrow: 'OPEN NOW',
    contextMode: 'after_conflict',
    title: 'After Conflict Reset',
    intro: 'Use this after the argument or hard interaction so the aftershock does not take the rest of the day.',
    submitLabel: 'Reset with BOND',
    questions: [
      {
        id: 'what_happened',
        type: 'choice',
        title: 'What happened?',
        options: ['We argued', 'I shut down', 'They shut down', 'It left me unsettled'],
      },
      {
        id: 'emotion',
        type: 'choice',
        title: 'What hurts most right now?',
        options: ['I feel hurt', 'I feel angry', 'I feel ashamed', 'I feel confused'],
      },
      {
        id: 'support_need',
        type: 'choice',
        title: 'What do you need most?',
        options: ['Calm down first', 'Figure out what matters', 'Know what to say next', 'Protect my dignity'],
      },
      {
        id: 'next_step',
        type: 'choice',
        title: 'What should happen next?',
        options: ['Wait for now', 'Send something short', 'Have a real talk later', 'Do not chase this'],
      },
      {
        id: 'final_note',
        type: 'text',
        title: 'Anything else about the conflict?',
        optional: true,
        placeholder: 'Optional',
      },
    ],
  },
  boundary_check: {
    eyebrow: 'OPEN NOW',
    contextMode: 'boundary_check',
    title: 'Boundary Check',
    intro: 'Use this before saying yes when what you want is actually no, later, or not like this.',
    submitLabel: 'Protect it with BOND',
    questions: [
      {
        id: 'what_happened',
        type: 'choice',
        title: 'What are they asking for?',
        options: ['My time', 'My attention', 'More than I can give', 'Something I do not want'],
      },
      {
        id: 'desired_outcome',
        type: 'choice',
        title: 'What do you actually want?',
        options: ['Say no', 'Say not now', 'Say yes with limits', 'Get clearer first'],
      },
      {
        id: 'support_need',
        type: 'choice',
        title: 'What makes this hard?',
        options: ['I do not want to disappoint them', 'I fear conflict', 'I over-explain', 'I doubt myself'],
      },
      {
        id: 'boundary_style',
        type: 'choice',
        title: 'How should the boundary sound?',
        options: ['Soft', 'Clear', 'Firm', 'Warm but final'],
      },
      {
        id: 'final_note',
        type: 'text',
        title: 'Anything else about the boundary?',
        optional: true,
        placeholder: 'Optional',
      },
    ],
  },
  attachment_rescue: {
    eyebrow: 'OPEN NOW',
    contextMode: 'attachment_rescue',
    title: 'Attachment Rescue',
    intro: 'Use this when fear is pushing you toward reassurance, over-contact, or panic.',
    submitLabel: 'Ground with BOND',
    questions: [
      {
        id: 'trigger_type',
        type: 'choice',
        title: 'What triggered this spike?',
        options: ['They pulled back', 'They have not replied', 'Something felt off', 'My thoughts took over'],
      },
      {
        id: 'emotion',
        type: 'choice',
        title: 'How intense is it?',
        options: ['Uneasy', 'Activated', 'Flooded', 'Panicking'],
      },
      {
        id: 'urge',
        type: 'choice',
        title: 'What are you tempted to do?',
        options: ['Text again', 'Ask for reassurance', 'Overthink everything', 'Disappear completely'],
      },
      {
        id: 'support_need',
        type: 'choice',
        title: 'What do you need most?',
        options: ['Ground me', 'Tell me the truth', 'Help me do nothing for now', 'Protect my dignity'],
      },
      {
        id: 'final_note',
        type: 'text',
        title: 'Anything else about what got triggered?',
        optional: true,
        placeholder: 'Optional',
      },
    ],
  },
  waiting_spiral_reset: {
    eyebrow: 'CHECK-IN',
    contextMode: 'waiting_spiral',
    title: 'Waiting Spiral Reset',
    intro: 'A short check-in so BOND can catch the story before it runs the whole night.',
    submitLabel: 'Send to BOND',
    questions: [
      {
        id: 'emotion',
        type: 'choice',
        title: 'How loud is the spiral right now?',
        options: ['Calm', 'Uneasy', 'Spiraling', 'Consumed'],
      },
      {
        id: 'trigger_type',
        type: 'choice',
        title: 'What story is driving this most?',
        options: ['They are losing interest', 'I said too much', 'I need to fix it', 'I honestly do not know'],
      },
      {
        id: 'urge',
        type: 'choice',
        title: 'What are you most tempted to do?',
        options: ['Text again', 'Check everything', 'Replay the conversation', 'Pretend I do not care'],
      },
      {
        id: 'support_need',
        type: 'choice',
        title: 'What would actually help?',
        options: ['Ground me', 'Keep me from chasing', 'Tell me what is true', 'Give me one move for tonight'],
      },
      {
        id: 'final_note',
        type: 'text',
        title: 'Anything else about the spiral?',
        optional: true,
        placeholder: 'Optional',
      },
    ],
  },
  relationship_reflection: {
    eyebrow: 'WEEKLY',
    contextMode: 'reflection_checkin',
    title: 'Relationship Reflection',
    intro: 'This is where BOND learns the pattern underneath the week, not just the loudest moment.',
    submitLabel: 'Reflect with BOND',
    questions: [
      {
        id: 'what_improved',
        type: 'choice',
        title: 'What improved this week?',
        options: ['I reacted less', 'I got clearer', 'I protected my self-respect', 'Not much improved'],
      },
      {
        id: 'trigger_type',
        type: 'choice',
        title: 'What repeated most?',
        options: ['Reply anxiety', 'Mixed signals', 'Conflict', 'Boundary stress'],
      },
      {
        id: 'self_respect_signal',
        type: 'choice',
        title: 'Where did you lose yourself most?',
        options: ['In what I sent', 'In what I tolerated', 'In what I imagined', 'I protected myself better'],
      },
      {
        id: 'desired_outcome',
        type: 'choice',
        title: 'What should change next?',
        options: ['Reply slower', 'Set a clearer boundary', 'Stop chasing clarity', 'Have the hard conversation'],
      },
      {
        id: 'final_note',
        type: 'text',
        title: 'Anything else from the week that we missed?',
        optional: true,
        placeholder: 'Optional',
      },
    ],
  },
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

function cloneFlowQuestions(questions = []) {
  return questions.map((question) => ({ ...question }));
}

function getBondActionFlow(actionType) {
  const flow = BOND_ACTION_FLOWS[actionType];
  if (!flow) return null;
  return {
    ...flow,
    questions: cloneFlowQuestions(flow.questions),
  };
}

function pickFirst(payload = {}, keys = []) {
  for (const key of keys) {
    const value = payload[key];
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return null;
}

function summarizeRecentField(logs = [], field) {
  const counts = new Map();
  logs.forEach((entry) => {
    const value = entry?.[field];
    if (!value) return;
    counts.set(value, (counts.get(value) || 0) + 1);
  });
  if (!counts.size) return null;
  const [topValue] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return topValue;
}

function deriveSupportRisk(profile, state = {}) {
  let score = 0;
  if (profile.main_pain === 'Waiting for a reply') score += 2;
  if (profile.main_pain === 'Breakup or emotional distance') score += 2;
  if (normalizeChoiceArray(profile.hardest_moments).length >= 4) score += 1;
  if (normalizeChoiceArray(profile.default_reaction).includes('Double text or chase reassurance')) score += 1;
  if ((state.lastCheckInScore || 10) <= 4) score += 2;
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

function emptyBondState() {
  return {
    agentId: 'bond',
    setupComplete: false,
    setupProgress: 0,
    profile: {},
    setupAnswers: {},
    resetStreak: 0,
    lastCheckInScore: null,
    lastEmotionalSignal: null,
    lastTriggerType: null,
    lastSupportNeed: null,
    lastUrge: null,
    latestActionResults: {},
    repeatingTriggerSummary: null,
    repeatingUrgeSummary: null,
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

async function getOrCreateBondState(userId) {
  const ref = agentRef(userId);
  const snap = await ref.get();
  if (!snap.exists) {
    const initial = emptyBondState();
    await ref.set(initial, { merge: true });
    return initial;
  }
  return { ...emptyBondState(), ...snap.data() };
}

async function getBondMessages(userId, limit = 60) {
  const snap = await messagesRef(userId).orderBy('timestamp', 'asc').limit(limit).get();
  return snap.docs.map((doc) => doc.data());
}

async function getBondActions(userId) {
  const snap = await actionsRef(userId)
    .orderBy('createdAt', 'desc')
    .limit(100)
    .get();
  return snap.docs
    .map((doc) => doc.data())
    .filter((action) => action.agentId === 'bond');
}

async function getBondLogs(userId, limit = 60) {
  const snap = await logsRef(userId)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  return snap.docs.map((doc) => doc.data());
}

function formatProfileSummary(profile) {
  const hardestMoments = normalizeChoiceArray(profile.hardest_moments).join(', ') || 'none specified';
  const defaultReaction = normalizeChoiceArray(profile.default_reaction).join(', ') || 'none specified';
  const autoActions = normalizeChoiceArray(profile.auto_actions).join(', ') || 'none';
  return `Relationship context: ${profile.relationship_context || 'unknown'}
Main pain: ${profile.main_pain || 'unknown'}
Hardest moments: ${hardestMoments}
Default reaction: ${defaultReaction}
Support style: ${profile.support_style || 'unknown'}
Pattern permission: ${profile.pattern_permission || 'unknown'}
Spiral check time: ${profile.spiral_check_time || 'unknown'}
Reflection day: ${profile.reflection_day || 'unknown'}
Reflection time: ${profile.reflection_time || 'unknown'}
Enabled actions: ${autoActions}`;
}

function buildBondLiveContext(agentState, profile, actions = []) {
  const activeActions = actions
    .filter((action) => ['active', 'snoozed'].includes(action.status))
    .slice(0, 6)
    .map((action) => `- ${action.title} (${action.status})${action.schedule?.time ? ` at ${action.schedule.time}` : ''}`)
    .join('\n') || '- none';

  return `\n\n━━━ USER PROFILE ━━━\n${formatProfileSummary(profile)}\n\n━━━ LIVE STATE ━━━
Risk level: ${agentState.currentRiskLevel || 'medium'}
Reset streak: ${agentState.resetStreak || 0}
Last check-in score: ${agentState.lastCheckInScore ?? 'none'}
Last emotional signal: ${agentState.lastEmotionalSignal ?? 'none'}
Current mode: ${agentState.currentMode || 'normal'}
Active focus: ${agentState.activeFocus || profile.main_pain || 'protect clarity before the next relationship moment'}
Current experiment: ${agentState.currentExperiment || 'none'}
Repeating trigger: ${agentState.repeatingTriggerSummary || 'none yet'}
Repeating urge: ${agentState.repeatingUrgeSummary || 'none yet'}

━━━ ACTIVE ACTIONS ━━━
${activeActions}`;
}

function getQuickRepliesForMode(mode = 'normal') {
  return QUICK_REPLIES[mode] || QUICK_REPLIES.normal;
}

function dateKeyFromIso(iso = nowIso()) {
  return new Date(iso).toISOString().slice(0, 10);
}

function buildBondCheckinSurvey(contextMode, action = null) {
  const actionType = action?.type || MODE_TO_ACTION_TYPE[contextMode];
  const flow = getBondActionFlow(actionType);
  if (!flow) {
    return null;
  }

  return {
    id: `bond_${actionType}_${action?.id || 'default'}`,
    kind: 'guided_checkin',
    actionType,
    contextMode: flow.contextMode,
    eyebrow: flow.eyebrow,
    title: flow.title,
    intro: flow.intro,
    submitLabel: flow.submitLabel,
    questions: cloneFlowQuestions(flow.questions),
  };
}

function summarizeBondStructuredCheckin(payload = {}) {
  const pieces = [];
  const actionType = payload.actionType || payload.action_type;
  if (actionType) pieces.push(`Tool: ${titleForType(actionType)}`);
  const emotion = pickFirst(payload, ['emotion', 'moment_feel']);
  const triggerType = pickFirst(payload, ['trigger_type', 'what_happened']);
  const urge = pickFirst(payload, ['urge', 'urge_now']);
  const need = pickFirst(payload, ['support_need', 'need_now']);
  const outcome = pickFirst(payload, ['desired_outcome', 'next_step']);
  const draftText = pickFirst(payload, ['draft_text']);
  if (emotion) pieces.push(`Feeling: ${emotion}`);
  if (triggerType) pieces.push(`Trigger: ${triggerType}`);
  if (urge) pieces.push(`Urge: ${urge}`);
  if (need) pieces.push(`Need: ${need}`);
  if (outcome) pieces.push(`Outcome: ${outcome}`);
  if (draftText) pieces.push(`Draft: ${draftText}`);
  if (payload.final_note) pieces.push(`Extra: ${payload.final_note}`);
  return pieces.join('. ');
}

function parseBondStructuredCheckin(payload = {}, contextMode = 'normal') {
  const ratingMap = {
    Calm: 8,
    calm: 8,
    Uneasy: 6,
    uneasy: 6,
    Tense: 5,
    tense: 5,
    Hurt: 4,
    hurt: 4,
    Spiraling: 2,
    spiraling: 2,
    Consumed: 2,
    consumed: 2,
    Activated: 4,
    activated: 4,
    Flooded: 3,
    flooded: 3,
    Panicking: 2,
    panicking: 2,
    Angry: 4,
    angry: 4,
    Hopeful: 7,
    hopeful: 7,
  };
  const emotion = pickFirst(payload, ['emotion', 'moment_feel']);
  const triggerType = pickFirst(payload, ['trigger_type', 'what_happened']);
  const urge = pickFirst(payload, ['urge', 'urge_now']);
  const desiredOutcome = pickFirst(payload, ['desired_outcome', 'next_step']);
  const supportNeed = pickFirst(payload, ['support_need', 'need_now']);
  const userChoice = pickFirst(payload, ['send_decision', 'boundary_style', 'tone_goal', 'what_improved', 'self_respect_signal']);
  const actionType = payload.actionType || payload.action_type || MODE_TO_ACTION_TYPE[contextMode] || null;
  return {
    rating: ratingMap[emotion] || null,
    emotion: emotion || null,
    triggerType: triggerType || null,
    urge: urge || null,
    desiredOutcome: desiredOutcome || null,
    supportNeed: supportNeed || null,
    userChoice: userChoice || null,
    actionType,
    personContext: payload.person_context || null,
    finalNote: payload.final_note || '',
  };
}

async function storeBondCheckin(userId, payload = {}, contextMode = 'normal', messageId = null, profile = {}) {
  const parsed = parseBondStructuredCheckin(payload, contextMode);
  const currentState = await getOrCreateBondState(userId);
  const ref = logsRef(userId).doc();
  const createdAt = nowIso();
  const entry = {
    id: ref.id,
    agentId: 'bond',
    type: contextMode,
    actionType: parsed.actionType,
    actionId: payload.actionId || null,
    personContext: parsed.personContext || profile.relationship_context || null,
    dateKey: dateKeyFromIso(createdAt),
    createdAt,
    messageId,
    triggerType: parsed.triggerType,
    emotion: parsed.emotion,
    urge: parsed.urge,
    desiredOutcome: parsed.desiredOutcome,
    supportNeed: parsed.supportNeed,
    userChoice: parsed.userChoice,
    recommendedMove: null,
    freeTextNote: parsed.finalNote,
    answers: payload,
    parsed,
  };
  await ref.set(entry);
  const recentLogs = [entry, ...(await getBondLogs(userId, 18)).filter((log) => log.id !== entry.id)];
  await agentRef(userId).set({
    latestActionResults: parsed.actionType
      ? {
          ...(currentState.latestActionResults || {}),
          [parsed.actionType]: {
            at: createdAt,
            emotion: parsed.emotion || null,
            triggerType: parsed.triggerType || null,
            desiredOutcome: parsed.desiredOutcome || null,
            supportNeed: parsed.supportNeed || null,
          },
        }
      : currentState.latestActionResults || {},
    repeatingTriggerSummary: summarizeRecentField(recentLogs, 'triggerType'),
    repeatingUrgeSummary: summarizeRecentField(recentLogs, 'urge'),
    updatedAt: nowIso(),
  }, { merge: true });
  return entry;
}

function messageToChatRole(message) {
  return {
    role: message.role === 'user' ? 'user' : 'assistant',
    content: message.content,
  };
}

function getModeGuide(mode, profile) {
  if (mode === 'before_reply') {
    return 'This is the before-reply moment. Slow them down, identify the real need, and help them avoid sending from fear.';
  }
  if (mode === 'should_i_send_this') {
    return 'This is draft review. Help them protect tone, clarity, and self-respect before anything gets sent.';
  }
  if (mode === 'hard_conversation') {
    return 'This is prep before a hard conversation. Help them get clear on what they need to say, how to say it, and what boundary matters.';
  }
  if (mode === 'after_conflict') {
    return 'This is the aftermath of conflict. Help them regulate first, then clarify what matters next.';
  }
  if (mode === 'waiting_spiral') {
    return 'This is the waiting spiral. Name the story they are telling themselves, reduce the urge to chase, and protect dignity.';
  }
  if (mode === 'boundary_check') {
    return 'This is boundary support. Help them say what is true without over-explaining or abandoning themselves.';
  }
  if (mode === 'attachment_rescue') {
    return 'This is attachment rescue. The user needs grounding, truth, and dignity before reassurance-seeking becomes action.';
  }
  if (mode === 'reflection_checkin') {
    return 'This is weekly relationship reflection. Pull out the repeating pattern, what improved, and what should change next.';
  }
  if (mode === 'action_followup') {
    return 'This is action follow-up. Reference the action in plain language and keep it to one clean move.';
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
        { role: 'system', content: `${BOND_IDENTITY.corePrompt}

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
  const systemPrompt = `${BOND_IDENTITY.corePrompt}${buildBondLiveContext(state, profile, actions)}

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
  return `bond_${type}`;
}

function titleForType(type) {
  return ACTION_TYPE_META[type]?.title || type;
}

function buildStarterActionTemplates(profile) {
  const actions = [];
  const enabled = new Set(normalizeChoiceArray(profile.auto_actions));
  const spiralCheckTime = profile.spiral_check_time || '10:30 PM';
  const reflectionTime = profile.reflection_time || '9:00 PM';
  const reflectionDayMap = {
    Sunday: ['sun'],
    Monday: ['mon'],
    Friday: ['fri'],
    Saturday: ['sat'],
  };
  const reflectionDays = reflectionDayMap[profile.reflection_day] || ['sun'];
  const mainPain = profile.main_pain || '';
  const hardestMoments = normalizeChoiceArray(profile.hardest_moments);
  const reactions = normalizeChoiceArray(profile.default_reaction);

  if (enabled.has('Before Reply') || hardestMoments.includes('Before I reply')) {
    actions.push({
      key: getActionKey('before_reply'),
      type: 'before_reply',
      title: 'Before Reply',
      subtitle: 'Open before you text back',
      detail: 'Slow the reaction down before you send something fear writes for you.',
      reason: 'Always available.',
      whyNow: 'Reply pressure is one of your repeat pain points.',
      schedule: {kind: 'conditional', trigger: 'manual'},
      priority: 'high',
      successMetric: 'Protect clarity before you reply',
      source: 'setup',
      confidence: 0.96,
      editable: false,
      status: 'active',
    });
  }

  if (enabled.has('Before Hard Conversation') || hardestMoments.includes('Before a hard conversation')) {
    actions.push({
      key: getActionKey('hard_conversation_prep'),
      type: 'hard_conversation_prep',
      title: 'Before Hard Conversation',
      subtitle: 'Open before the talk',
      detail: 'Map what you need to say before emotion or fear takes the wheel.',
      reason: 'Always available.',
      whyNow: 'You need more support before hard conversations, not only after.',
      schedule: {kind: 'conditional', trigger: 'manual'},
      priority: 'medium',
      successMetric: 'Enter hard talks clearer and steadier',
      source: 'setup',
      confidence: 0.93,
      editable: false,
      status: 'active',
    });
  }

  if (enabled.has('After Conflict Reset') || hardestMoments.includes('After conflict')) {
    actions.push({
      key: getActionKey('after_conflict_reset'),
      type: 'after_conflict_reset',
      title: 'After Conflict Reset',
      subtitle: 'Open after the hit',
      detail: 'Use this after arguments, tension, or emotional impact so the aftershock does not own the rest of the day.',
      reason: 'Always available.',
      whyNow: 'Conflict recovery matters just as much as the conflict itself.',
      schedule: {kind: 'conditional', trigger: 'manual'},
      priority: 'high',
      successMetric: 'Shorten the emotional aftershock',
      source: 'setup',
      confidence: 0.95,
      editable: false,
      status: 'active',
    });
  }

  if (enabled.has('Waiting Spiral Reset') || hardestMoments.includes('While waiting for a reply') || hardestMoments.includes('Late at night')) {
    actions.push({
      key: getActionKey('waiting_spiral_reset'),
      type: 'waiting_spiral_reset',
      title: 'Waiting Spiral Reset',
      subtitle: spiralCheckTime,
      detail: 'Catch reassurance spirals, mixed-signal stories, and late-night texting loops before they get louder.',
      reason: 'Runs every evening.',
      whyNow: 'Waiting and late-night loops are one of your pressure points.',
      schedule: {kind: 'daily', time: spiralCheckTime},
      priority: 'medium',
      successMetric: 'Interrupt the waiting spiral earlier',
      source: 'setup',
      confidence: 0.91,
      editable: true,
      status: 'active',
    });
  }

  if (enabled.has('Boundary Check') || mainPain === 'Boundary problems' || hardestMoments.includes('When I need to set a boundary')) {
    actions.push({
      key: getActionKey('boundary_check'),
      type: 'boundary_check',
      title: 'Boundary Check',
      subtitle: 'Open before you say yes',
      detail: 'Use this before agreeing, over-giving, or ignoring what you actually want.',
      reason: 'Always available.',
      whyNow: 'Boundary stress needs clarity before resentment shows up.',
      schedule: {kind: 'conditional', trigger: 'manual'},
      priority: 'medium',
      successMetric: 'Protect your self-respect sooner',
      source: 'setup',
      confidence: 0.92,
      editable: false,
      status: 'active',
    });
  }

  if (enabled.has('Attachment Rescue') || reactions.includes('Double text or chase reassurance')) {
    actions.push({
      key: getActionKey('attachment_rescue'),
      type: 'attachment_rescue',
      title: 'Attachment Rescue',
      subtitle: 'Open when fear spikes',
      detail: 'Use this when abandonment fear, reassurance seeking, or emotional flooding starts taking over.',
      reason: 'Always available.',
      whyNow: 'Your reassurance loop needs a fast interrupt before it turns into action.',
      schedule: {kind: 'conditional', trigger: 'manual'},
      priority: 'high',
      successMetric: 'Regulate attachment spikes faster',
      source: 'setup',
      confidence: 0.9,
      editable: false,
      status: 'active',
    });
  }

  if (enabled.has('Relationship Reflection')) {
    actions.push({
      key: getActionKey('relationship_reflection'),
      type: 'relationship_reflection',
      title: 'Relationship Reflection',
      subtitle: `${profile.reflection_day || 'Sunday'} · ${reflectionTime}`,
      detail: 'Run a structured weekly reflection so BOND can see patterns, not just moments.',
      reason: 'Runs every week.',
      whyNow: 'This is where the long-term pattern becomes visible.',
      schedule: {kind: 'weekly', time: reflectionTime, days: reflectionDays},
      priority: 'medium',
      successMetric: 'Notice repeated patterns sooner',
      source: 'setup',
      confidence: 0.88,
      editable: true,
      status: 'active',
    });
  }

  if (enabled.has('Should I Send This?')) {
    actions.push({
      key: getActionKey('should_i_send_this'),
      type: 'should_i_send_this',
      title: 'Should I Send This?',
      subtitle: 'Pinned in BOND',
      detail: 'Bring drafts, messages, or anything you are about to send here first.',
      reason: 'Always available.',
      whyNow: 'You want help with language before the message leaves your hands.',
      schedule: {kind: 'conditional', trigger: 'manual'},
      priority: 'high',
      successMetric: 'Send fewer fear-driven messages',
      source: 'setup',
      confidence: 0.94,
      editable: false,
      status: 'active',
    });
  }

  return actions;
}

async function ensureCoreBondActions(userId, profile = {}) {
  if (!profile || !Object.keys(profile).length) {
    return [];
  }

  const existingActions = await getBondActions(userId);
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
      return data.agentId === 'bond' && data.actionId === action.id;
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
    agentId: 'bond',
    actionId: action.id,
    triggerAt: nextTriggerAt,
    type: action.type,
    contextMode:
      action.type === 'waiting_spiral_reset'
        ? 'waiting_spiral'
        : action.type === 'relationship_reflection'
        ? 'reflection_checkin'
        : 'action_followup',
    opener: action.detail,
    quickReplies: getQuickRepliesForMode(
      action.type === 'waiting_spiral_reset'
        ? 'waiting_spiral'
        : action.type === 'relationship_reflection'
        ? 'reflection_checkin'
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
        return data.agentId === 'bond' && data.actionId === action.id;
      })
      .map((doc) => doc.ref.delete())
  );

  const triggerRef = scheduledRef(userId).doc();
  await triggerRef.set({
    id: triggerRef.id,
    userId,
    agentId: 'bond',
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
    agentId: 'bond',
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

async function createBondAutomations(userId, userName, answers) {
  const profile = { ...answers };
  const starterActions = buildStarterActionTemplates(profile);
  return Promise.all(starterActions.map((action) => upsertAction(userId, action)));
}

function inferModeFromMessage(text, fallback = 'normal') {
  const lower = text.toLowerCase();
  if (/(spiral|spiraling|waiting for a reply|ghost|ghosted|they still haven't|double text|mixed signals)/i.test(lower)) return 'waiting_spiral';
  if (/(before i reply|before i text|what should i send|should i send|rewrite this|draft this)/i.test(lower)) return 'before_reply';
  if (/(before we talk|hard conversation|need to say this|need a boundary|before seeing them)/i.test(lower)) return 'hard_conversation';
  if (/(after we fought|after conflict|after the argument|after they texted|after that call)/i.test(lower)) return 'after_conflict';
  if (/(boundary|say no|need to be clear|need to set a limit)/i.test(lower)) return 'boundary_check';
  if (/(abandoned|attachment|need reassurance|clingy|too attached)/i.test(lower)) return 'attachment_rescue';
  return fallback;
}

function fallbackActionDecision(message, profile, actions) {
  const lower = message.toLowerCase();
  const results = [];
  const activeTypes = new Set(actions.filter((action) => action.status === 'active').map((action) => action.type));
  if (
    /(before i reply|before i text|what should i send|rewrite this|draft this)/.test(lower) &&
    !activeTypes.has('before_reply')
  ) {
    results.push({
      type: 'create',
      action: {
        key: getActionKey('before_reply'),
        type: 'before_reply',
        title: 'Before Reply',
        subtitle: 'Open before you send it',
        detail: 'BOND added a pause-before-send tool because texting is one of the moments most likely to go sideways.',
        reason: 'Added from conversation because this looks like a repeated reply-pressure moment.',
        whyNow: 'Slowing down before the message is sent matters more than repairing it after.',
        schedule: { kind: 'conditional', trigger: 'manual' },
        priority: 'high',
        successMetric: 'Send fewer fear-driven replies',
        source: 'chat',
        confidence: 0.81,
        editable: false,
        status: 'active',
      },
    });
  }
  if (
    /(after we fought|after conflict|after the argument|after that call|after they texted)/.test(lower) &&
    !activeTypes.has('after_conflict_reset')
  ) {
    results.push({
      type: 'create',
      action: {
        key: getActionKey('after_conflict_reset'),
        type: 'after_conflict_reset',
        title: 'After Conflict Reset',
        subtitle: 'Open after the hit',
        detail: 'BOND added this because the emotional aftermath is lingering longer than the moment itself.',
        reason: 'Added from conversation because conflict recovery clearly needs more structure.',
        whyNow: 'The aftershock is where the rest of the day often gets lost.',
        schedule: { kind: 'conditional', trigger: 'manual' },
        priority: 'high',
        successMetric: 'Recover faster after conflict',
        source: 'chat',
        confidence: 0.83,
        editable: false,
        status: 'active',
      },
    });
  }
  if (
    /(waiting for a reply|still has not replied|ghost|ghosted|spiral at night|late night spiral|mixed signals)/.test(lower) &&
    !activeTypes.has('waiting_spiral_reset') &&
    profile.spiral_check_time
  ) {
    results.push({
      type: 'create',
      action: {
        key: getActionKey('waiting_spiral_reset'),
        type: 'waiting_spiral_reset',
        title: 'Waiting Spiral Reset',
        subtitle: profile.spiral_check_time,
        detail: 'BOND added this because reply anxiety is still the point where your thoughts speed up fastest.',
        reason: 'Added from conversation because waiting is clearly a repeating trigger.',
        whyNow: 'It is easier to interrupt the spiral before the night gets fully shaped by it.',
        schedule: { kind: 'daily', time: profile.spiral_check_time },
        priority: 'high',
        successMetric: 'Interrupt late spirals earlier',
        source: 'chat',
        confidence: 0.79,
        editable: true,
        status: 'active',
      },
    });
  }
  if (/(need reassurance|abandoned|attachment|clingy|too attached)/.test(lower) && !activeTypes.has('attachment_rescue')) {
    results.push({
      type: 'create',
      action: {
        key: getActionKey('attachment_rescue'),
        type: 'attachment_rescue',
        title: 'Attachment Rescue',
        subtitle: 'Open when fear spikes',
        detail: 'BOND added a rescue tool because reassurance loops are turning into real distress quickly.',
        reason: 'Added from conversation because the attachment spike sounds immediate.',
        whyNow: 'The first few minutes matter most when reassurance fear takes over.',
        schedule: {kind: 'conditional', trigger: 'manual'},
        priority: 'high',
        successMetric: 'Regulate faster when attachment fear spikes',
        source: 'chat',
        confidence: 0.85,
        editable: false,
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
          content: `You are BOND's action engine.
Decide if the user's latest message should create a relationship support action.
Return JSON with shape:
{
  "mode":"normal|before_reply|hard_conversation|after_conflict|waiting_spiral|boundary_check|attachment_rescue|reflection_checkin|action_followup",
  "changes":[
    {
      "type":"create|none",
      "actionType":"before_reply|hard_conversation_prep|after_conflict_reset|waiting_spiral_reset|boundary_check|attachment_rescue|relationship_reflection|should_i_send_this",
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
- If the user needs help with a draft, before_reply or should_i_send_this are best.
- If they are just venting, return no changes.
- Do not invent time-based actions unless they make sense.`,
        },
        {
          role: 'user',
          content: `Context mode: ${contextMode}
Profile:
${formatProfileSummary(profile)}
Current state:
Risk=${state.currentRiskLevel}; streak=${state.resetStreak}; lastCheckIn=${state.lastCheckInScore}; lastEmotion=${state.lastEmotionalSignal}
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
          key: getActionKey(change.actionType),
          type: change.actionType,
          title: change.title || titleForType(change.actionType),
          subtitle: change.subtitle || '',
          detail: change.detail || '',
          reason: change.reason || 'Added by BOND from the conversation.',
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

function parseBondCheckinHeuristic(message) {
  const lower = message.toLowerCase();
  const ratingMatch = message.match(/(\d{1,2})\s*\/\s*10/);
  const rating = ratingMatch ? Math.max(1, Math.min(10, parseInt(ratingMatch[1], 10))) : null;
  let triggerType = null;
  if (/text|reply|message|ghost/.test(lower)) triggerType = 'Reply anxiety';
  else if (/argument|fight|conflict|conversation|boundary/.test(lower)) triggerType = 'Conflict';
  else if (/night|late/.test(lower)) triggerType = 'Late-night spiral';
  return { rating, triggerType };
}

async function processBondCheckinReply(userId, userMessage, structuredCheckin = null) {
  const state = await getOrCreateBondState(userId);
  const parsed = structuredCheckin
    ? parseBondStructuredCheckin(
        structuredCheckin,
        structuredCheckin.contextMode || state.currentMode || 'normal'
      )
    : parseBondCheckinHeuristic(userMessage);
  if (parsed.rating == null && !parsed.triggerType && !parsed.emotion) return state;

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
  if (parsed.emotion != null) patch.lastEmotionalSignal = parsed.emotion;
  if (parsed.triggerType != null) patch.lastTriggerType = parsed.triggerType;
  if (parsed.supportNeed != null) patch.lastSupportNeed = parsed.supportNeed;
  if (parsed.urge != null) patch.lastUrge = parsed.urge;
  patch.currentRiskLevel = deriveSupportRisk(state.profile || {}, { ...state, ...patch });

  await agentRef(userId).set(patch, { merge: true });
  return { ...state, ...patch };
}

async function extractBondAction(userId, userName, userMessage) {
  const state = await getOrCreateBondState(userId);
  const actions = await getBondActions(userId);
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
    { key: 'Live Tools', items: [] },
    { key: 'Check-ins', items: [] },
    { key: 'Reflections', items: [] },
  ];
  const byKey = Object.fromEntries(sections.map((section) => [section.key, section]));
  actions.forEach((action) => {
    const key = ACTION_TYPE_META[action.type]?.bucket || 'Live Tools';
    byKey[key]?.items.push(action);
  });
  return sections.filter((section) => section.items.length > 0);
}

function buildBondChart(logs = []) {
  return logs
    .slice()
    .reverse()
    .slice(-7)
    .map((entry) => ({
      label: new Date(entry.createdAt || Date.now())
        .toLocaleDateString('en-US', { weekday: 'short' })
        .slice(0, 3),
      value: entry.parsed?.rating || entry.rating || 5,
      energy: null,
    }));
}

function buildFallbackAnalysis(state, messages, actions, logs = []) {
  const profile = state.profile || {};
  const recentUserMessages = messages.filter((message) => message.role === 'user').slice(-8);
  const text = recentUserMessages.map((message) => message.content.toLowerCase()).join(' ');
  const activeActions = actions.filter((action) => action.status === 'active');
  const topTrigger = summarizeRecentField(logs, 'triggerType');
  const topUrge = summarizeRecentField(logs, 'urge');

  let pattern = 'Your relationship pattern is visible enough now that BOND can start getting ahead of it.';
  if (topTrigger === 'Reply anxiety' || /text|reply|message|double text/.test(text) || profile.main_pain === 'Overthinking texts') {
    pattern = 'Reply pressure still looks like the fastest place for your anxiety to take over.';
  } else if (topTrigger === 'Mixed signals' || /wait|waiting|ghost|mixed signals/.test(text) || profile.main_pain === 'Waiting for a reply') {
    pattern = 'Waiting for clarity still seems to pull you into the same story loop fastest.';
  } else if (topTrigger === 'Conflict' || /argument|conflict|fight|boundary/.test(text)) {
    pattern = 'Conflict and boundary moments still seem to leave the biggest emotional aftershock.';
  }

  const wins = [];
  if ((state.resetStreak || 0) >= 2) wins.push(`You have ${state.resetStreak} steadier check-ins in a row right now.`);
  if ((state.lastCheckInScore || 0) >= 7) wins.push(`Your latest relationship check-in landed at ${state.lastCheckInScore}/10.`);
  if (activeActions.length >= 3) wins.push(`BOND is actively running ${activeActions.length} tools for you right now.`);
  if (wins.length === 0) wins.push('The good news is your pattern is clear enough to start acting on.');

  const risks = [];
  if ((state.lastCheckInScore || 10) <= 4) risks.push('Recent emotional load is still high enough that rescue support needs to stay close.');
  if (profile.main_pain === 'Unclear intentions') risks.push('Ambiguity still seems to be creating more story than signal.');
  if (profile.main_pain === 'Boundary problems') risks.push('Boundary pressure still looks likely to turn into resentment if it stays unspoken.');
  if (topUrge === 'Double text' || topUrge === 'Text again') risks.push('The urge to reach again still looks stronger than the signal you are actually getting.');
  if (risks.length === 0) risks.push('The next risk is getting pulled back into the same trigger before you notice it happening.');

  return {
    generatedAt: nowIso(),
    summary: pattern,
    patterns: [pattern],
    wins: wins.slice(0, 2),
    risks: risks.slice(0, 2),
    focus: profile.support_style || 'Stay steadier across the next few relationship moments.',
    chart: buildBondChart(logs),
  };
}

function summarizeBondLogsForPrompt(logs = []) {
  if (!logs.length) {
    return '- no structured BOND logs yet';
  }
  return logs
    .slice(0, 8)
    .map(
      (entry) =>
        `- ${entry.actionType || entry.type}: trigger=${entry.triggerType || 'unknown'}, emotion=${entry.emotion || 'unknown'}, urge=${entry.urge || 'unknown'}, outcome=${entry.desiredOutcome || 'unknown'}`
    )
    .join('\n');
}

async function generateBondAnalysis(userId, state, messages, actions, logs = []) {
  const fallback = buildFallbackAnalysis(state, messages, actions, logs);
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
Last emotional signal: ${state.lastEmotionalSignal}
Repeating trigger: ${state.repeatingTriggerSummary || 'none'}
Repeating urge: ${state.repeatingUrgeSummary || 'none'}

Recent user messages:
${recentUserMessages}

Structured BOND logs:
${summarizeBondLogsForPrompt(logs)}

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

async function buildBondStatePayload(userId) {
  const state = await getOrCreateBondState(userId);
  if (state.setupComplete) {
    await ensureCoreBondActions(userId, state.profile || {});
  }
  const [messages, actions, logs] = await Promise.all([
    getBondMessages(userId),
    getBondActions(userId),
    getBondLogs(userId, 24),
  ]);
  const analysis = state.analysis || buildFallbackAnalysis(state, messages, actions, logs);
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
      if (trigger.agentId !== 'bond') return;
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
        survey: buildBondCheckinSurvey(trigger.contextMode || 'normal', action),
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
              title: 'BOND',
              body: message.content.slice(0, 120),
            },
            data: {
              screen: 'Bond',
              agentId: 'bond',
              actionId: trigger.actionId || '',
              actionType: trigger.type || '',
              contextMode: trigger.contextMode || 'normal',
            },
          });
        } catch (error) {
          console.error('BOND FCM error:', error.message);
        }
      }
    }));
  }));
}

async function maybeCreateRescueAction(userId, state) {
  if ((state.lastCheckInScore || 10) > 4) return null;
  const draft = {
    key: `bond_recovery_${new Date().toISOString().slice(0, 10)}`,
    type: 'attachment_rescue',
    title: 'Attachment Rescue',
    subtitle: 'Keep one fast rescue ready',
    detail: 'BOND added a rescue action because your recent relationship signal sounded heavy enough to need fast support.',
    reason: 'Added because your recent signal suggests you need lower-friction support ready.',
    whyNow: 'The goal is to get grounded faster before reassurance fear starts driving your next move.',
    schedule: { kind: 'conditional', trigger: 'manual' },
    priority: 'high',
    successMetric: 'Recover faster from the hardest relationship moments',
    source: 'adaptive_engine',
    confidence: 0.82,
    editable: false,
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

async function runBondNightlyAnalysis(firestoreDb = db) {
  if (firestoreDb) db = firestoreDb;
  const usersSnap = await db.collection('wellness_users').limit(500).get();
  await Promise.all(usersSnap.docs.map(async (userDoc) => {
    const userId = userDoc.id;
    const state = await getOrCreateBondState(userId);
    if (!state.setupComplete) return;

    const actions = await getBondActions(userId);
    const recentMessages = await getBondMessages(userId, 24);
    const relationshipReplies = recentMessages
      .filter((msg) => msg.role === 'user' && ['waiting_spiral', 'reflection_checkin', 'after_conflict', 'before_reply', 'normal'].includes(msg.contextMode || 'normal'))
      .slice(-5);

    let spiralMentions = 0;
    let textMentions = 0;
    let conflictMentions = 0;
    relationshipReplies.forEach((msg) => {
      const lower = msg.content.toLowerCase();
      if (/spiral|waiting|ghost|double text|mixed signals/.test(lower)) spiralMentions += 1;
      if (/text|reply|message/.test(lower)) textMentions += 1;
      if (/fight|argument|conflict|conversation|boundary/.test(lower)) conflictMentions += 1;
    });

    const nextState = {
      ...state,
      currentRiskLevel: deriveSupportRisk(state.profile || {}, state),
      updatedAt: nowIso(),
    };
    if (textMentions >= 2) nextState.activeFocus = 'Reply pressure still looks like the fastest place for fear to take over.';
    else if (conflictMentions >= 2) nextState.activeFocus = 'Conflict recovery still needs more structure after the hit.';
    else if (spiralMentions >= 2) nextState.activeFocus = 'The waiting spiral still needs to get interrupted earlier.';

    const recentLogs = await getBondLogs(userId, 30);
    nextState.analysis = await generateBondAnalysis(userId, nextState, recentMessages, actions, recentLogs);
    await agentRef(userId).set({
      currentRiskLevel: nextState.currentRiskLevel,
      activeFocus: nextState.activeFocus || null,
      analysis: nextState.analysis,
      updatedAt: nextState.updatedAt,
    }, { merge: true });

    if ((state.lastCheckInScore || 10) <= 4) {
      await maybeCreateRescueAction(userId, nextState);
    }

    if (spiralMentions >= 2) {
      await maybeCreateAdaptiveAction(userId, actions, getActionKey('waiting_spiral_reset'), () => ({
        key: getActionKey('waiting_spiral_reset'),
        type: 'waiting_spiral_reset',
        title: 'Waiting Spiral Reset',
        subtitle: state.profile?.spiral_check_time || '10:30 PM',
        detail: 'BOND added this because reply anxiety still looks like a repeating late trigger.',
        reason: 'Added because recent signal still points back to waiting spirals.',
        whyNow: 'Catching the spiral earlier matters more than recovering after it peaks.',
        schedule: {
          kind: 'daily',
          time: state.profile?.spiral_check_time || '10:30 PM',
        },
        priority: 'high',
        successMetric: 'Interrupt reply spirals earlier',
        source: 'adaptive_engine',
        confidence: 0.84,
        editable: true,
        status: 'active',
      }));
    }

    if (conflictMentions >= 2) {
      await maybeCreateAdaptiveAction(userId, actions, getActionKey('after_conflict_reset'), () => ({
        key: getActionKey('after_conflict_reset'),
        type: 'after_conflict_reset',
        title: 'After Conflict Reset',
        subtitle: 'Use after the hit',
        detail: 'BOND added this because conflict aftermath still seems to linger long after the moment itself.',
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
    config: BOND_SETUP_CONFIG,
    quickReplies: QUICK_REPLIES,
    actionTypes: ACTION_TYPE_META,
    actionFlows: BOND_ACTION_FLOWS,
  });
});

router.get('/state/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    await getOrCreateUser(userId);
    const payload = await buildBondStatePayload(userId);
    res.json(payload);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/analysis/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const state = await getOrCreateBondState(userId);
    const [messages, actions, logs] = await Promise.all([
      getBondMessages(userId, 40),
      getBondActions(userId),
      getBondLogs(userId, 40),
    ]);
    const analysis = state.analysis || await generateBondAnalysis(userId, state, messages, actions, logs);
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
      setupProgress: BOND_SETUP_CONFIG.questions.length,
      setupAnswers: answers,
      profile,
      activeFocus: profile.main_pain || 'Feel steadier in the moments that usually get loud',
      currentMode: 'normal',
      currentRiskLevel: deriveSupportRisk(profile),
      updatedAt: nowIso(),
    };
    await agentRef(userId).set(statePatch, { merge: true });

    const starterMessage = await generateSetupMessage(userName, profile, starterActions)
      || `Your pattern is clear enough to start acting on. I’ve already set up a few support moves around ${profile.main_pain?.toLowerCase() || 'the moments that hit hardest'}. What usually goes wrong first when a relationship moment starts getting loud?`;

    const existingMessages = await getBondMessages(userId, 5);
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

    const starterState = await getOrCreateBondState(userId);
    const [starterMessages, starterLogs] = await Promise.all([
      getBondMessages(userId, 20),
      getBondLogs(userId, 20),
    ]);
    const starterAnalysis = await generateBondAnalysis(
      userId,
      starterState,
      starterMessages,
      starterActions,
      starterLogs,
    );
    await agentRef(userId).set(
      {analysis: starterAnalysis, updatedAt: nowIso()},
      {merge: true},
    );

    const payload = await buildBondStatePayload(userId);
    res.json({
      ...payload,
      starterPlan: buildStarterPlanSummary(starterActions),
      starterMessage: firstMessage,
    });
  } catch (error) {
    console.error('BOND setup error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/chat', async (req, res) => {
  try {
    const { userId, userName, message, contextMode = 'normal', structuredCheckin = null } = req.body;
    if (!userId || !message) return res.status(400).json({ success: false, error: 'userId and message are required' });

    await getOrCreateUser(userId, userName);
    const state = await getOrCreateBondState(userId);
    const profile = state.profile || {};
    const [history, actions] = await Promise.all([
      getBondMessages(userId, 40),
      getBondActions(userId),
    ]);

    const normalizedMessage = structuredCheckin
      ? summarizeBondStructuredCheckin(structuredCheckin)
      : message;
    const resolvedMode = inferModeFromMessage(normalizedMessage, contextMode || state.currentMode || 'normal');
    const userMsg = await saveMessage(userId, {
      role: 'user',
      content: normalizedMessage,
      contextMode: resolvedMode,
      structuredCheckin,
    });

    let updatedState = state;
    let storedCheckin = null;
    if ([
      'before_reply',
      'should_i_send_this',
      'hard_conversation',
      'after_conflict',
      'boundary_check',
      'attachment_rescue',
      'waiting_spiral',
      'reflection_checkin',
    ].includes(resolvedMode)) {
      updatedState = await processBondCheckinReply(userId, normalizedMessage, structuredCheckin);
      if (structuredCheckin) {
        storedCheckin = await storeBondCheckin(
          userId,
          { ...structuredCheckin, contextMode: resolvedMode },
          resolvedMode,
          userMsg.id,
          profile,
        );
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

    if (storedCheckin) {
      await logsRef(userId).doc(storedCheckin.id).set(
        {
          recommendedMove: reply,
          updatedAt: nowIso(),
        },
        { merge: true }
      );
      if (structuredCheckin?.actionId) {
        await actionsRef(userId).doc(structuredCheckin.actionId).set(
          {
            lastUsedAt: nowIso(),
            lastLogId: storedCheckin.id,
            lastUserResponse: structuredCheckin.userChoice || structuredCheckin.desired_outcome || structuredCheckin.support_need || 'used',
            updatedAt: nowIso(),
          },
          { merge: true }
        );
      }
    }

    await agentRef(userId).set({
      conversationCount: (state.conversationCount || 0) + 1,
      currentMode: 'normal',
      lastInteractionAt: nowIso(),
      updatedAt: nowIso(),
      currentRiskLevel: deriveSupportRisk(profile, updatedState),
    }, { merge: true });

    const latestState = await getOrCreateBondState(userId);
    const [latestMessages, latestActions, latestLogs] = await Promise.all([
      getBondMessages(userId, 30),
      getBondActions(userId),
      getBondLogs(userId, 30),
    ]);
    const analysis = await generateBondAnalysis(
      userId,
      latestState,
      latestMessages,
      latestActions,
      latestLogs,
    );
    await agentRef(userId).set({analysis, updatedAt: nowIso()}, {merge: true});

    const payload = await buildBondStatePayload(userId);
    res.json({
      ...payload,
      userMessage: userMsg,
      agentMessage: agentMsg,
      actionChanges: createdActions,
    });
  } catch (error) {
    console.error('BOND chat error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/actions/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const state = await getOrCreateBondState(userId);
    if (state.setupComplete) {
      await ensureCoreBondActions(userId, state.profile || {});
    }
    const actions = await getBondActions(userId);
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
    const state = await getOrCreateBondState(userId);
    if (state.setupComplete) {
      await ensureCoreBondActions(userId, state.profile || {});
    }
    const doc = await actionsRef(userId).doc(actionId).get();
    if (!doc.exists) return res.status(404).json({ success: false, error: 'Action not found' });

    const action = doc.data();
    if (action.agentId !== 'bond') return res.status(400).json({ success: false, error: 'Not a BOND action' });

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
            return data.agentId === 'bond' && data.actionId === actionId;
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
    const state = await getOrCreateBondState(userId);
    await runBondNightlyAnalysis(db);
    res.json({ success: true, state });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DEEP WORK TOOLS — People tracking + 10 tool engine
// ─────────────────────────────────────────────────────────────────────────────

const peopleRef   = (uid) => agentRef(uid).collection('bond_people');
const ritualsRef  = (uid) => agentRef(uid).collection('bond_rituals');
const toolResultsRef = (uid) => agentRef(uid).collection('bond_tool_results');

// ── People helpers ────────────────────────────────────────────────────────────

function slugifyName(name = '') {
  return name.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

async function upsertPerson(userId, name, updates = {}) {
  if (!name) return null;
  const id = slugifyName(name);
  const ref = peopleRef(userId).doc(id);
  const snap = await ref.get();
  const now = nowIso();
  if (!snap.exists) {
    const person = {
      id,
      name,
      relationshipType: updates.relationshipType || 'unknown',
      firstMentioned: now,
      lastMentioned: now,
      mentionCount: 1,
      healthStatus: 'unknown',
      bondObservation: null,
      toolResults: [],
      ...updates,
      createdAt: now,
      updatedAt: now,
    };
    await ref.set(person);
    return person;
  }
  const existing = snap.data();
  const { toolResult, ...restUpdates } = updates;
  const merged = {
    lastMentioned: now,
    mentionCount: (existing.mentionCount || 0) + 1,
    updatedAt: now,
    ...restUpdates,
    toolResults: toolResult
      ? [{ ...toolResult, at: now }, ...(existing.toolResults || []).slice(0, 19)]
      : existing.toolResults || [],
  };
  await ref.set(merged, { merge: true });
  return { ...existing, ...merged };
}

async function getPeople(userId) {
  const snap = await peopleRef(userId).orderBy('lastMentioned', 'desc').limit(30).get();
  return snap.docs.map((d) => d.data());
}

async function getPersonContext(userId, name) {
  if (!name) return '';
  const id = slugifyName(name);
  const snap = await peopleRef(userId).doc(id).get();
  if (snap.exists) {
    const p = snap.data();
    return `Name: ${p.name}. Type: ${p.relationshipType}. Observation: ${p.bondObservation || 'none'}. Mentions: ${p.mentionCount}.`;
  }
  // fall back to scanning messages for this name
  const messages = await getBondMessages(userId, 60);
  const namePattern = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const relevant = messages.filter((m) => namePattern.test(m.content)).slice(-5);
  return relevant.map((m) => `${m.role === 'user' ? 'User' : 'Bond'}: ${m.content}`).join('\n') || 'No prior context found.';
}

async function saveToolResult(userId, toolType, result, chatMessage) {
  const ref = toolResultsRef(userId).doc();
  const entry = {
    id: ref.id,
    toolType,
    result,
    chatMessageId: chatMessage?.id || null,
    createdAt: nowIso(),
  };
  await ref.set(entry);
  return entry;
}

// ── Tool runner functions ─────────────────────────────────────────────────────

async function runOtherSide(userId, payload) {
  const { personName, situation } = payload;
  const [profile, personContext, history] = await Promise.all([
    getOrCreateBondState(userId).then((s) => s.profile || {}),
    getPersonContext(userId, personName),
    getBondMessages(userId, 20),
  ]);
  const recentContext = history.filter((m) => m.role === 'user').slice(-5).map((m) => m.content).join(' | ');
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.7,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'system',
      content: `You are BOND, a relationship intelligence engine. Reconstruct BOTH sides of a relational moment with precision and empathy.
User profile: ${formatProfileSummary(profile)}
What Bond knows about ${personName || 'this person'}: ${personContext}
Recent conversation context: ${recentContext}

Return JSON with this exact shape:
{
  "yourPerspective": { "feelings": "2-3 emotions the user was experiencing", "needs": "what the user needed in that moment", "interpretation": "how the user likely read the situation" },
  "theirPerspective": { "feelings": "2-3 emotions the other person was likely experiencing", "needs": "what they likely needed", "interpretation": "how they likely experienced the user's actions/words" },
  "shiftMoment": "the specific moment the dynamic changed — one sentence",
  "gapObservation": "the single biggest gap between what each person needed — one sentence",
  "bondSummary": "Bond's grounded one-sentence takeaway about what this reveals"
}
Be specific, not generic. Do not use therapy jargon. Sound like you actually know these people.`,
    }, {
      role: 'user',
      content: `Situation: ${situation}\nOther person: ${personName || 'them'}`,
    }],
  });
  const result = JSON.parse(completion.choices[0].message.content);
  if (personName) {
    await upsertPerson(userId, personName, {
      bondObservation: result.theirPerspective?.feelings,
      toolResult: { toolType: 'other_side', summary: result.gapObservation },
    });
  }
  return result;
}

async function runFightLoopMap(userId, payload) {
  const { personName } = payload;
  const [state, history] = await Promise.all([
    getOrCreateBondState(userId),
    getBondMessages(userId, 60),
  ]);
  const profile = state.profile || {};
  const relevantMessages = personName
    ? history.filter((m) => new RegExp(personName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(m.content))
    : history;
  const transcript = relevantMessages.slice(-30).map((m) => `${m.role === 'user' ? 'User' : 'Bond'}: ${m.content}`).join('\n');
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'system',
      content: `You are BOND. Analyze this user's conversation history and identify if there is a recurring fight/conflict pattern with ${personName || 'someone'}.
User profile: ${formatProfileSummary(profile)}

Return JSON:
{
  "loopFound": boolean,
  "personName": "${personName || 'unknown'}",
  "trigger": "what starts the pattern — 1 sentence",
  "yourReaction": "what the user typically does — 1 sentence",
  "theirReaction": "how the other person typically responds — 1 sentence",
  "outcome": "how it usually ends — 1 sentence",
  "breakPoint": { "node": "trigger|yourReaction|theirReaction|outcome", "suggestion": "the one concrete change that would break this loop — 1 sentence" },
  "historicalExamples": ["quote or paraphrase from history showing the pattern (up to 3)"],
  "bondRead": "Bond's honest 1-sentence read on what's really driving this loop",
  "occurrenceCount": number
}
If no clear pattern exists, set loopFound to false and return minimal data.`,
    }, {
      role: 'user',
      content: transcript || 'No conversation history yet.',
    }],
  });
  const result = JSON.parse(completion.choices[0].message.content);
  if (personName && result.loopFound) {
    await upsertPerson(userId, personName, {
      bondObservation: result.bondRead,
      toolResult: { toolType: 'fight_loop_map', summary: result.breakPoint?.suggestion },
    });
  }
  return result;
}

async function runWordsFinder(userId, payload) {
  const { personName, what, normalRelationship, fearIfWrong, wantThemToFeel } = payload;
  const [state, personContext] = await Promise.all([
    getOrCreateBondState(userId),
    getPersonContext(userId, personName),
  ]);
  const profile = state.profile || {};
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.75,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'system',
      content: `You are BOND. Write personalized words for the user — not templates, not generic phrases. Based on who THEY are and who THEIR person is.
User profile: ${formatProfileSummary(profile)}
What Bond knows about ${personName || 'this person'}: ${personContext}

They need to say: "${what}"
Their relationship with ${personName}: ${normalRelationship || 'not specified'}
Their fear if they say it wrong: ${fearIfWrong || 'not specified'}
What they want ${personName} to feel after: ${wantThemToFeel || 'not specified'}

Return JSON:
{
  "direct": "A direct version — clear, no fluff, says exactly what needs to be said in 1-3 sentences",
  "warm": "A warm version — emotionally open, connected, vulnerable in 1-3 sentences",
  "brief": "A brief version — minimal words, maximum dignity, 1-2 sentences",
  "bondNote": "Bond's one-sentence note about which version fits this relationship and why"
}
These must sound like THEY wrote them, not a therapist. Use their specific situation. No placeholders like [name] or [feeling].`,
    }, {
      role: 'user',
      content: `I need to tell ${personName || 'them'}: ${what}`,
    }],
  });
  const result = JSON.parse(completion.choices[0].message.content);
  if (personName) {
    await upsertPerson(userId, personName, {
      toolResult: { toolType: 'words_finder', summary: `Helped find words for: ${what}` },
    });
  }
  return result;
}

async function runDriftDetector(userId) {
  const [history, existingPeople] = await Promise.all([
    getBondMessages(userId, 100),
    getPeople(userId),
  ]);
  // Build name frequency map from conversation history
  const userMessages = history.filter((m) => m.role === 'user');
  const nameFrequency = {};
  const nameTimeline = {};
  userMessages.forEach((msg, idx) => {
    // Extract capitalized words as potential names (heuristic)
    const matches = msg.content.match(/\b[A-Z][a-z]{2,}\b/g) || [];
    matches.forEach((name) => {
      if (['Bond', 'I', 'It', 'The', 'My', 'He', 'She', 'We', 'They', 'You', 'Him', 'Her'].includes(name)) return;
      nameFrequency[name] = (nameFrequency[name] || 0) + 1;
      if (!nameTimeline[name]) nameTimeline[name] = [];
      nameTimeline[name].push(idx);
    });
  });
  // Also include tracked people
  existingPeople.forEach((p) => {
    if (!nameFrequency[p.name]) nameFrequency[p.name] = p.mentionCount || 1;
  });
  const candidates = Object.entries(nameFrequency)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name]) => name);

  if (candidates.length === 0) {
    return { drifting: [], bondNote: 'Bond needs more conversation history to detect drift. Keep talking.' };
  }

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.4,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'system',
      content: `You are BOND. Analyze this conversation history and identify people the user may be drifting from.
Names mentioned multiple times: ${candidates.join(', ')}
Total messages analyzed: ${userMessages.length}

For each person who appears frequently early in the history but NOT recently, they may be drifting.

Return JSON:
{
  "drifting": [
    {
      "name": "person's name",
      "lastMentionedDays": estimated days since last mention (1-30),
      "lastContext": "last thing user said about them — 1 sentence",
      "driftReason": "likely reason for drift based on conversation context — 1 sentence",
      "reEntryMessage": "an exact message the user could send right now to reconnect — make it natural, personal, not generic",
      "urgency": "low|medium|high"
    }
  ],
  "bondNote": "Bond's one-sentence observation about the drift pattern overall"
}
Only include people where drift is genuinely visible. Max 4 people. Order by urgency.`,
    }, {
      role: 'user',
      content: userMessages.slice(-80).map((m, i) => `[${i}] ${m.content}`).join('\n'),
    }],
  });
  return JSON.parse(completion.choices[0].message.content);
}

async function runEnergyAudit(userId, payload) {
  const { people } = payload; // [{ name, answers: {} }]
  const state = await getOrCreateBondState(userId);
  const profile = state.profile || {};
  const contextParts = await Promise.all(
    people.map(async (p) => {
      const ctx = await getPersonContext(userId, p.name);
      return `${p.name}: ${ctx}${p.answers ? ` | User says: ${JSON.stringify(p.answers)}` : ''}`;
    })
  );
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.6,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'system',
      content: `You are BOND. Perform an honest relationship energy audit for this user.
User profile: ${formatProfileSummary(profile)}
Relationship context provided:
${contextParts.join('\n')}

Return JSON:
{
  "people": [
    {
      "name": "name",
      "energy": "positive|negative|mixed",
      "level": 1-10 (10 = massive energy giver, 1 = massive drain),
      "bondRead": "Bond's honest 1-sentence read on this relationship's energy dynamic",
      "why": "specific reason based on what was shared"
    }
  ],
  "portfolioInsight": "Bond's overall read on the user's relationship portfolio — 2 sentences max",
  "investMore": "the one relationship that deserves more energy — and why",
  "scaleBack": "the one relationship where the user is over-investing — and why",
  "bondNote": "one honest, grounded observation the user might not want to hear but needs to"
}
Be honest. Not harsh, but not gentle to the point of useless. Sound like Bond knows this person.`,
    }, {
      role: 'user',
      content: `Audit these ${people.length} relationships: ${people.map((p) => p.name).join(', ')}`,
    }],
  });
  const result = JSON.parse(completion.choices[0].message.content);
  // Update health status for each person
  await Promise.all(
    (result.people || []).map((p) =>
      upsertPerson(userId, p.name, {
        healthStatus: p.energy === 'positive' ? 'green' : p.energy === 'negative' ? 'red' : 'amber',
        bondObservation: p.bondRead,
        toolResult: { toolType: 'energy_audit', summary: p.bondRead },
      })
    )
  );
  return result;
}

async function runUnsentLetter(userId, payload) {
  const { personName, letter } = payload;
  const [state, personContext] = await Promise.all([
    getOrCreateBondState(userId),
    getPersonContext(userId, personName),
  ]);
  const profile = state.profile || {};
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.7,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'system',
      content: `You are BOND. Process this unsent letter with three distinct lenses.
User profile: ${formatProfileSummary(profile)}
What Bond knows about ${personName || 'this person'}: ${personContext}

Return JSON:
{
  "forYourself": "What the user needed to say FOR THEMSELVES — the emotional core they needed to express, regardless of the other person. 2-3 sentences. Quote specific language from their letter where relevant.",
  "forThem": "What the other person actually needs to hear — what would land, what matters to THEM. Might be very different from what was written. 2-3 sentences.",
  "cleanVersion": "A clean, sendable version that serves the relationship — honest but not harmful, clear but not cruel. 3-5 sentences. Only include if it would genuinely help.",
  "shouldSend": boolean,
  "bondNote": "Bond's honest 1-sentence read on what this letter reveals about what the user needs right now"
}
Process with care. This is private. Be honest about what's in the letter.`,
    }, {
      role: 'user',
      content: `To ${personName || 'them'}:\n\n${letter}`,
    }],
  });
  const result = JSON.parse(completion.choices[0].message.content);
  if (personName) {
    await upsertPerson(userId, personName, {
      toolResult: { toolType: 'unsent_letter', summary: result.bondNote },
    });
  }
  return result;
}

async function runRelationshipReplay(userId, payload) {
  const { transcript } = payload; // [{ speaker: 'you'|'them', text }]
  const state = await getOrCreateBondState(userId);
  const profile = state.profile || {};
  const formatted = transcript.map((line, i) => `[${i}] ${line.speaker === 'you' ? 'User' : 'Them'}: ${line.text}`).join('\n');
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.5,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'system',
      content: `You are BOND. Annotate this conversation transcript and identify where and why things went wrong.
User profile: ${formatProfileSummary(profile)}

Transcript lines are indexed [0], [1], [2]...

Return JSON:
{
  "lines": [
    {
      "idx": 0,
      "annotation": "positive|ambiguous|escalating",
      "icon": "✓|?|🔥",
      "tip": "short note on this line — why it lands, why it's ambiguous, or what made it escalate. 1 sentence."
    }
  ],
  "shiftMoment": {
    "idx": number,
    "what": "what happened at this line that changed the dynamic — 1 sentence",
    "underneath": "what was really happening emotionally beneath this line — 1 sentence"
  },
  "reEntryLine": "if the user wants to re-open this conversation, the exact first sentence they should say — specific and personal",
  "bondRead": "Bond's honest 1-sentence read on the core dynamic that drove this conversation off track"
}`,
    }, {
      role: 'user',
      content: formatted,
    }],
  });
  return JSON.parse(completion.choices[0].message.content);
}

async function runPreEventBrief(userId, payload) {
  const { eventType, whoWillBeThere, context } = payload;
  const [state, personContext] = await Promise.all([
    getOrCreateBondState(userId),
    getPersonContext(userId, whoWillBeThere),
  ]);
  const profile = state.profile || {};
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.65,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'system',
      content: `You are BOND. Give this user a precise, personal brief for an upcoming event or interaction.
User profile: ${formatProfileSummary(profile)}
What Bond knows about ${whoWillBeThere || 'the people involved'}: ${personContext}

Return JSON:
{
  "watchFor": "the ONE dynamic or behavior to be alert to — specific to this person/situation, 1-2 sentences",
  "holdOnto": "the ONE thing to remember when it gets hard or uncomfortable — a grounding truth, 1-2 sentences",
  "exitLine": "exact words the user can say if they need to leave a conversation or de-escalate — natural, not dramatic",
  "bondNote": "Bond's one-sentence read on what this event will likely test for this user"
}
Make this specific to their profile and who they're dealing with. Not generic event prep.`,
    }, {
      role: 'user',
      content: `Event: ${eventType}. With: ${whoWillBeThere || 'not specified'}. Context: ${context || 'not specified'}`,
    }],
  });
  return JSON.parse(completion.choices[0].message.content);
}

async function runConnectionRitual(userId, payload) {
  const { personName, relationshipType, caresMostAbout, usualConnectTime } = payload;
  const [state, personContext] = await Promise.all([
    getOrCreateBondState(userId),
    getPersonContext(userId, personName),
  ]);
  const profile = state.profile || {};
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.8,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'system',
      content: `You are BOND. Design a micro-ritual for this specific relationship — something small, specific, and sustainable that will compound over time.
User profile: ${formatProfileSummary(profile)}
What Bond knows about ${personName}: ${personContext}

Return JSON:
{
  "ritual": {
    "action": "the specific action — not 'call more' but exact: 'Send one voice note on Sunday mornings'",
    "frequency": "daily|weekly|biweekly|monthly|when_triggered",
    "trigger": "when to do it — time, event, or cue",
    "duration": "how long it takes (e.g. '30 seconds', '5 minutes')",
    "why": "why THIS ritual for THIS person — specific to what Bond knows about them"
  },
  "personName": "${personName}",
  "relationshipType": "${relationshipType || 'unknown'}",
  "compoundEffect": "what this ritual will feel like in 3 months if they do it consistently — 1 sentence",
  "bondNote": "Bond's honest note on why this relationship is worth this investment"
}
Think small. Small is sustainable. Sustainable compounds. Not 'spend more time together.' Find the specific gesture that fits this specific bond.`,
    }, {
      role: 'user',
      content: `Person: ${personName}. Type: ${relationshipType || 'friend'}. Cares about: ${caresMostAbout || 'not specified'}. When we usually connect: ${usualConnectTime || 'not specified'}`,
    }],
  });
  const result = JSON.parse(completion.choices[0].message.content);
  // Save ritual to Firestore
  const ref = ritualsRef(userId).doc();
  const now = nowIso();
  const ritual = {
    id: ref.id,
    ...result,
    status: 'active',
    streak: 0,
    lastCompletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await ref.set(ritual);
  if (personName) {
    await upsertPerson(userId, personName, {
      relationshipType: relationshipType || 'unknown',
      toolResult: { toolType: 'connection_ritual', summary: result.ritual?.action },
    });
  }
  return { ...result, ritualId: ref.id };
}

async function runHealthCheck(userId, payload) {
  const { personName } = payload;
  const [state, personContext, history] = await Promise.all([
    getOrCreateBondState(userId),
    getPersonContext(userId, personName),
    getBondMessages(userId, 60),
  ]);
  const profile = state.profile || {};
  const relevant = history
    .filter((m) => new RegExp(personName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(m.content))
    .slice(-20)
    .map((m) => `${m.role === 'user' ? 'User' : 'Bond'}: ${m.content}`)
    .join('\n');
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'system',
      content: `You are BOND. Give an honest relationship health assessment. No sugarcoating. No unnecessary harshness.
User profile: ${formatProfileSummary(profile)}
What Bond knows about ${personName}: ${personContext}
Recent conversation context about ${personName}:
${relevant || 'No specific context available.'}

Return JSON:
{
  "personName": "${personName}",
  "healthScore": 1-10,
  "whatWorking": ["up to 3 specific positive signals in this relationship"],
  "warningSigns": ["up to 3 specific concerning patterns or dynamics"],
  "yourContribution": {
    "positive": ["1-2 things the user is doing well in this relationship"],
    "needsWork": ["1-2 honest things the user could change — not blame, just reality"]
  },
  "bondRead": "Bond's honest 1-2 sentence assessment — the thing the user might not want to hear but needs to",
  "recommendation": "one specific action Bond recommends based on this assessment"
}
Be the friend who tells the truth. Not the one who makes them feel good.`,
    }, {
      role: 'user',
      content: `Health check for: ${personName}`,
    }],
  });
  const result = JSON.parse(completion.choices[0].message.content);
  await upsertPerson(userId, personName, {
    healthStatus: result.healthScore >= 7 ? 'green' : result.healthScore >= 4 ? 'amber' : 'red',
    bondObservation: result.bondRead,
    toolResult: { toolType: 'health_check', summary: result.bondRead },
  });
  return result;
}

// ── Tool dispatcher ───────────────────────────────────────────────────────────

const TOOL_RUNNERS = {
  other_side:          runOtherSide,
  fight_loop_map:      runFightLoopMap,
  words_finder:        runWordsFinder,
  drift_detector:      (userId) => runDriftDetector(userId),
  energy_audit:        runEnergyAudit,
  unsent_letter:       runUnsentLetter,
  relationship_replay: runRelationshipReplay,
  pre_event_brief:     runPreEventBrief,
  connection_ritual:   runConnectionRitual,
  health_check:        runHealthCheck,
};

const TOOL_META = {
  other_side:          { title: 'Other Side',            emoji: '🪞', chatSummaryKey: 'gapObservation' },
  fight_loop_map:      { title: 'Fight Loop Map',        emoji: '🔁', chatSummaryKey: 'bondRead' },
  words_finder:        { title: 'Words I Can\'t Find',   emoji: '💬', chatSummaryKey: 'bondNote' },
  drift_detector:      { title: 'Drift Detector',        emoji: '📡', chatSummaryKey: 'bondNote' },
  energy_audit:        { title: 'Energy Audit',          emoji: '⚡', chatSummaryKey: 'portfolioInsight' },
  unsent_letter:       { title: 'Unsent Letter',         emoji: '✉️', chatSummaryKey: 'bondNote' },
  relationship_replay: { title: 'Relationship Replay',   emoji: '🎬', chatSummaryKey: 'bondRead' },
  pre_event_brief:     { title: 'Pre-Event Brief',       emoji: '🧠', chatSummaryKey: 'bondNote' },
  connection_ritual:   { title: 'Connection Ritual',     emoji: '🕯️', chatSummaryKey: 'compoundEffect' },
  health_check:        { title: 'Relationship Health',   emoji: '❤️', chatSummaryKey: 'bondRead' },
};

async function generateToolFollowUp(_userId, toolType, result, _profile) {
  const meta = TOOL_META[toolType];
  const summaryKey = meta?.chatSummaryKey;
  const summary = summaryKey ? result[summaryKey] : JSON.stringify(result).slice(0, 120);
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.65,
      max_tokens: 80,
      messages: [{
        role: 'system',
        content: `${BOND_IDENTITY.corePrompt}
The user just completed the "${meta?.title}" tool. Here is the key insight generated:
"${summary}"

Write a short follow-up message (2-3 sentences max). Acknowledge what was revealed. Leave them with one grounding thought or question. Do not summarize the tool output — they can see it. Connect it to something deeper.`,
      }, {
        role: 'user',
        content: `I just did the ${meta?.title} tool.`,
      }],
    });
    return completion.choices[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

// ── New Routes ────────────────────────────────────────────────────────────────

router.post('/tool', async (req, res) => {
  try {
    const { userId, userName, toolType, payload = {} } = req.body;
    if (!userId || !toolType) {
      return res.status(400).json({ success: false, error: 'userId and toolType required' });
    }
    const runner = TOOL_RUNNERS[toolType];
    if (!runner) {
      return res.status(400).json({ success: false, error: `Unknown toolType: ${toolType}` });
    }

    await getOrCreateUser(userId, userName);
    const state = await getOrCreateBondState(userId);
    const profile = state.profile || {};

    // Run the tool
    const result = await runner(userId, payload);

    // Generate Bond's follow-up chat message
    const followUpText = await generateToolFollowUp(userId, toolType, result, profile);
    const meta = TOOL_META[toolType];

    // Save tool result to history as a special message type
    const chatMessage = await saveMessage(userId, {
      role: 'agent',
      content: followUpText || `${meta?.emoji || ''} ${meta?.title || toolType} complete.`,
      messageType: 'tool_result',
      toolType,
      toolResult: result,
      toolMeta: {
        title: meta?.title,
        emoji: meta?.emoji,
        summary: result[meta?.chatSummaryKey] || '',
      },
    });

    // Save to tool results collection for analytics
    await saveToolResult(userId, toolType, result, chatMessage);

    // Update agent state with last tool usage (analytics)
    await agentRef(userId).set({
      lastToolUsedAt: nowIso(),
      lastToolType: toolType,
      toolUsageCount: (state.toolUsageCount || 0) + 1,
      updatedAt: nowIso(),
    }, { merge: true });

    res.json({
      success: true,
      toolType,
      result,
      chatMessage,
      meta,
    });
  } catch (error) {
    console.error('[Bond /tool]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/people/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const people = await getPeople(userId);
    res.json({ success: true, people });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/rituals/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const snap = await ritualsRef(userId).orderBy('createdAt', 'desc').get();
    const rituals = snap.docs.map((d) => d.data());
    res.json({ success: true, rituals });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.patch('/rituals/:userId/:ritualId', async (req, res) => {
  try {
    const { userId, ritualId } = req.params;
    const updates = req.body;
    await ritualsRef(userId).doc(ritualId).set({ ...updates, updatedAt: nowIso() }, { merge: true });
    const snap = await ritualsRef(userId).doc(ritualId).get();
    res.json({ success: true, ritual: snap.data() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/rituals/:userId/:ritualId/complete', async (req, res) => {
  try {
    const { userId, ritualId } = req.params;
    const ref = ritualsRef(userId).doc(ritualId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ success: false, error: 'Ritual not found' });
    const ritual = snap.data();
    const newStreak = (ritual.streak || 0) + 1;
    await ref.set({ streak: newStreak, lastCompletedAt: nowIso(), updatedAt: nowIso() }, { merge: true });
    res.json({ success: true, streak: newStreak });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = {
  router,
  setDb,
  processScheduledTriggers,
  runBondNightlyAnalysis,
  createBondAutomations,
  processBondCheckinReply,
  extractBondAction,
  buildBondLiveContext,
  BOND_SETUP_CONFIG,
  BOND_IDENTITY,
};
