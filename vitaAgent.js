const express = require('express');
const {OpenAI} = require('openai');

const router = express.Router();
const openai = new OpenAI({apiKey: process.env.OPENAI_API_KEY});

let db;
function setDb(firestoreDb) {
  db = firestoreDb;
}

const userRef = uid => db.collection('wellness_users').doc(uid);
const agentRef = uid => userRef(uid).collection('wellness_agents').doc('vita');
const messagesRef = uid => agentRef(uid).collection('wellness_messages');
const logsRef = uid => agentRef(uid).collection('daily_logs');
const actionsRef = uid => userRef(uid).collection('wellness_actions');
const scheduledRef = uid => userRef(uid).collection('wellness_scheduled');

const VITA_SETUP_CONFIG = {
  version: 1,
  intro: {
    eyebrow: 'VITA',
    title: 'Let’s build your body system.',
    body: 'A few sharp choices, then VITA sets up the health actions, check-ins, and reviews that actually fit your goal.',
  },
  questions: [
    {
      id: 'goal_type',
      type: 'choice',
      title: 'What is your main goal right now?',
      options: [
        'Lose fat',
        'Build muscle',
        'Gain weight',
        'Maintain',
        'Feel healthier and more consistent',
      ],
    },
    {
      id: 'priority',
      type: 'choice',
      title: 'What needs the most help first?',
      options: [
        'Nutrition',
        'Workouts',
        'Energy',
        'Consistency',
        'A bit of everything',
      ],
    },
    {
      id: 'biggest_problem',
      type: 'multiselect',
      title: 'Where does it usually break?',
      options: [
        'I overeat when I am off-track',
        'I miss protein',
        'I snack late',
        'I skip workouts',
        'I start strong then fall off',
        'I have no structure',
      ],
    },
    {
      id: 'current_style',
      type: 'choice',
      title: 'What does your movement look like now?',
      options: [
        'Gym regularly',
        'Home workouts',
        'Mostly walking or cardio',
        'I am not training yet',
      ],
    },
    {
      id: 'support_style',
      type: 'choice',
      title: 'How should VITA coach you?',
      options: [
        'Keep me disciplined',
        'Keep it simple',
        'Coach me gently',
        'Adapt the plan for me',
      ],
    },
    {
      id: 'tracking_style',
      type: 'choice',
      title: 'How much tracking can you realistically do?',
      options: [
        'I will log meals',
        'I will log just key meals',
        'I want very light tracking',
      ],
    },
    {
      id: 'weighin_time',
      type: 'time',
      title: 'When should VITA run your morning weigh-in?',
      defaultValue: '7:00 AM',
    },
    {
      id: 'workout_time',
      type: 'time',
      title: 'If you train, when should VITA protect that workout slot?',
      defaultValue: '6:00 PM',
    },
    {
      id: 'closeout_time',
      type: 'time',
      title: 'When should VITA run your evening closeout?',
      defaultValue: '9:30 PM',
    },
    {
      id: 'review_day',
      type: 'choice',
      title: 'Which day should VITA run your weekly body review?',
      options: ['Sunday', 'Monday', 'Friday', 'Saturday'],
    },
    {
      id: 'review_time',
      type: 'time',
      title: 'When should that weekly review happen?',
      defaultValue: '8:30 PM',
    },
    {
      id: 'auto_actions',
      type: 'multiselect',
      title: 'Which VITA systems should be on from day one?',
      options: [
        'Morning Weigh-In',
        'Protein Target Rescue',
        'Craving Reset',
        'Before Meal Check',
        'Workout Lock-In',
        'Missed Workout Recovery',
        'Evening Closeout',
        'Weekly Body Review',
      ],
    },
  ],
};

const VITA_IDENTITY = {
  name: 'VITA',
  domain: 'body goals, fat loss, muscle gain, consistency, cravings, workouts, nutrition, energy',
  corePrompt: `You are VITA, a premium body goal and health consistency operator inside Pulse.

WHO YOU ARE:
You help one person stay consistent with body goals in real life. You are not a calorie app, not a bro-fitness bot, and not a guilt machine. You are precise, practical, emotionally intelligent, and focused on what actually gets the user through today and this week.

VOICE:
Short. Strong. Clean. Usually 2 to 4 sentences. Never preachy. Never shamey.

HOW YOU HELP:
You connect daily behavior to the bigger body trend. You help before the meal, during the craving, before the skipped workout, at day closeout, and during the weekly review where the plan gets adjusted.

RULES:
- One question max.
- No lists in normal chat.
- Give one clear move, not ten.
- Never guilt the user for eating, resting, or missing a session.
- Avoid generic "eat healthy" language.
- Respect the goal: fat loss, gain, maintain, and general health are not the same.
- Always sound like you remember this person's real friction points.`,
};

const QUICK_REPLIES = {
  normal: ['Need a reset', 'Craving hard', 'Help with this meal', 'Skipped the workout'],
  morning_weighin: ['Weight is up', 'Weight is down', 'Feeling heavy', 'I need a simple day'],
  protein_rescue: ['Protein is low', 'I can fix it', 'Need easy options', 'I am off all day'],
  craving_reset: ['I want junk food', 'I am stress eating', 'Need a smaller move', 'Talk me down'],
  before_meal: ['Keep me on track', 'Help with portions', 'Make this better', 'I do not want to overdo it'],
  workout_lock_in: ['I might skip', 'Give me the minimum', 'I am still going', 'Need a backup'],
  missed_workout: ['I skipped it', 'Help me recover', 'Give me a fallback', 'Do not let me spiral'],
  evening_closeout: ['Today was on track', 'Today got messy', 'Need tomorrow tighter', 'Tell me what matters'],
  weekly_review: ['Week felt solid', 'I drifted', 'Adjust the plan', 'Show me the pattern'],
  action_followup: ['Used it', 'Skipped it', 'Need a better version', 'This helped'],
};

const ACTION_TYPE_META = {
  morning_weighin: {title: 'Morning Weigh-In', bucket: 'Daily Rhythm'},
  protein_target_rescue: {title: 'Protein Target Rescue', bucket: 'Daily Rhythm'},
  craving_reset: {title: 'Craving Reset', bucket: 'Live Tools'},
  before_meal_check: {title: 'Before Meal Check', bucket: 'Live Tools'},
  workout_lock_in: {title: 'Workout Lock-In', bucket: 'Daily Rhythm'},
  missed_workout_recovery: {title: 'Missed Workout Recovery', bucket: 'Live Tools'},
  evening_closeout: {title: 'Evening Closeout', bucket: 'Daily Rhythm'},
  weekly_body_review: {title: 'Weekly Body Review', bucket: 'Weekly Review'},
};

const ACTION_TYPE_TO_MODE = {
  morning_weighin: 'morning_weighin',
  protein_target_rescue: 'protein_rescue',
  craving_reset: 'craving_reset',
  before_meal_check: 'before_meal',
  workout_lock_in: 'workout_lock_in',
  missed_workout_recovery: 'missed_workout',
  evening_closeout: 'evening_closeout',
  weekly_body_review: 'weekly_review',
};

const MODE_TO_ACTION_TYPE = Object.fromEntries(
  Object.entries(ACTION_TYPE_TO_MODE).map(([actionType, mode]) => [mode, actionType]),
);

const VITA_ACTION_FLOWS = {
  morning_weighin: {
    eyebrow: 'DAILY',
    contextMode: 'morning_weighin',
    title: 'Morning Weigh-In',
    intro: 'A fast body check so VITA can coach the day with better signal, not guesses.',
    submitLabel: 'Send to VITA',
    questions: [
      {id: 'weight_value', type: 'text', title: 'What is your weight this morning?', placeholder: 'Optional if you skipped the scale'},
      {
        id: 'energy',
        type: 'choice',
        title: 'How does your body feel?',
        options: ['Light and ready', 'Normal', 'Heavy or flat', 'Drained'],
      },
      {
        id: 'readiness',
        type: 'choice',
        title: 'How ready do you feel for today?',
        options: ['Locked in', 'Pretty good', 'Could slip', 'Messy already'],
      },
      {
        id: 'today_risk',
        type: 'choice',
        title: 'What could throw today off first?',
        options: ['Hunger', 'Cravings', 'No structure', 'Workout resistance'],
      },
      {
        id: 'final_note',
        type: 'text',
        title: 'Anything else about this morning?',
        optional: true,
        placeholder: 'Optional',
      },
    ],
  },
  protein_target_rescue: {
    eyebrow: 'CHECK-IN',
    contextMode: 'protein_rescue',
    title: 'Protein Target Rescue',
    intro: 'A fast rescue when the day is drifting and protein is about to get missed.',
    submitLabel: 'Rescue with VITA',
    questions: [
      {
        id: 'protein_status',
        type: 'choice',
        title: 'How is protein tracking so far?',
        options: ['On track', 'A little behind', 'Way behind', 'I have not thought about it'],
      },
      {
        id: 'meal_window',
        type: 'choice',
        title: 'Where are you in the day?',
        options: ['Breakfast window', 'Lunch window', 'Afternoon', 'Evening'],
      },
      {
        id: 'support_need',
        type: 'choice',
        title: 'What would help most?',
        options: ['One easy food idea', 'A lighter fix', 'A bigger meal plan', 'A simple target only'],
      },
      {
        id: 'today_risk',
        type: 'choice',
        title: 'What is making it harder?',
        options: ['Busy day', 'No prep', 'Eating out', 'Low appetite'],
      },
      {
        id: 'final_note',
        type: 'text',
        title: 'Anything else about food today?',
        optional: true,
        placeholder: 'Optional',
      },
    ],
  },
  craving_reset: {
    eyebrow: 'OPEN NOW',
    contextMode: 'craving_reset',
    title: 'Craving Reset',
    intro: 'Use this when a craving starts taking control and you want a better move than all-or-nothing.',
    submitLabel: 'Reset with VITA',
    questions: [
      {
        id: 'trigger_type',
        type: 'choice',
        title: 'What triggered the craving?',
        options: ['Stress', 'Boredom', 'Hunger', 'Seeing the food'],
      },
      {
        id: 'craving_item',
        type: 'choice',
        title: 'What are you craving most?',
        options: ['Sweet food', 'Salty food', 'Fast food', 'Just anything right now'],
      },
      {
        id: 'craving_intensity',
        type: 'choice',
        title: 'How strong is it?',
        options: ['Mild', 'Noticeable', 'Strong', 'I am about to cave'],
      },
      {
        id: 'support_need',
        type: 'choice',
        title: 'What would help most right now?',
        options: ['Give me a smarter version', 'Help me pause', 'Keep the damage small', 'Tell me the best move'],
      },
      {
        id: 'final_note',
        type: 'text',
        title: 'Anything else behind this craving?',
        optional: true,
        placeholder: 'Optional',
      },
    ],
  },
  before_meal_check: {
    eyebrow: 'OPEN NOW',
    contextMode: 'before_meal',
    title: 'Before Meal Check',
    intro: 'Use this before eating when you want the meal to support the goal instead of just reacting in the moment.',
    submitLabel: 'Check with VITA',
    questions: [
      {
        id: 'meal_type',
        type: 'choice',
        title: 'What are you about to eat?',
        options: ['Main meal', 'Snack', 'Takeout', 'I am not sure yet'],
      },
      {
        id: 'meal_goal',
        type: 'choice',
        title: 'What matters most for this meal?',
        options: ['Stay on goal', 'Get more protein', 'Avoid overeating', 'Keep it simple'],
      },
      {
        id: 'risk_level',
        type: 'choice',
        title: 'What is the risk here?',
        options: ['Big portions', 'Low protein', 'Mindless eating', 'Nothing major'],
      },
      {
        id: 'support_need',
        type: 'choice',
        title: 'What should VITA help you do?',
        options: ['Build a better plate', 'Choose a smaller version', 'Add protein fast', 'Keep it realistic'],
      },
      {
        id: 'final_note',
        type: 'text',
        title: 'Anything else about this meal?',
        optional: true,
        placeholder: 'Optional',
      },
    ],
  },
  workout_lock_in: {
    eyebrow: 'DAILY',
    contextMode: 'workout_lock_in',
    title: 'Workout Lock-In',
    intro: 'A fast lock-in before the workout slot disappears into excuses or a long day.',
    submitLabel: 'Lock it in',
    questions: [
      {
        id: 'workout_status',
        type: 'choice',
        title: 'Are you still doing the session?',
        options: ['Yes, full session', 'Maybe, but reduced', 'I might skip', 'Already skipped'],
      },
      {
        id: 'workout_type',
        type: 'choice',
        title: 'What kind of session is it?',
        options: ['Strength', 'Cardio', 'Walk or easy movement', 'Just trying to move'],
      },
      {
        id: 'today_risk',
        type: 'choice',
        title: 'What makes skipping likely?',
        options: ['Low energy', 'No time', 'No motivation', 'I feel behind already'],
      },
      {
        id: 'support_need',
        type: 'choice',
        title: 'What do you need from VITA?',
        options: ['Give me the minimum win', 'Push me a bit', 'Keep it lighter', 'Help me salvage the day'],
      },
      {
        id: 'final_note',
        type: 'text',
        title: 'Anything else about today’s session?',
        optional: true,
        placeholder: 'Optional',
      },
    ],
  },
  missed_workout_recovery: {
    eyebrow: 'OPEN NOW',
    contextMode: 'missed_workout',
    title: 'Missed Workout Recovery',
    intro: 'Use this when you skipped it so the miss stays one miss instead of becoming the whole week.',
    submitLabel: 'Recover with VITA',
    questions: [
      {
        id: 'miss_reason',
        type: 'choice',
        title: 'Why did the workout miss happen?',
        options: ['No time', 'Low energy', 'No motivation', 'The day got chaotic'],
      },
      {
        id: 'emotion',
        type: 'choice',
        title: 'How do you feel about it?',
        options: ['Fine, just need a backup', 'Annoyed', 'Guilty', 'Like I am slipping'],
      },
      {
        id: 'desired_outcome',
        type: 'choice',
        title: 'What would save the day most?',
        options: ['A smaller session', 'A walk instead', 'Tighter food choices', 'Reset tomorrow cleanly'],
      },
      {
        id: 'support_need',
        type: 'choice',
        title: 'What should VITA do now?',
        options: ['Give me a fallback', 'Stop the guilt spiral', 'Tell me the next best move', 'Keep me honest'],
      },
      {
        id: 'final_note',
        type: 'text',
        title: 'Anything else behind the miss?',
        optional: true,
        placeholder: 'Optional',
      },
    ],
  },
  evening_closeout: {
    eyebrow: 'DAILY',
    contextMode: 'evening_closeout',
    title: 'Evening Closeout',
    intro: 'A short closeout so VITA can learn what actually shaped the day and what tomorrow needs.',
    submitLabel: 'Close out with VITA',
    questions: [
      {
        id: 'on_track_score',
        type: 'choice',
        title: 'How on-track did today feel?',
        options: ['Very on-track', 'Mostly solid', 'Messy in places', 'Off-track'],
      },
      {
        id: 'best_win',
        type: 'choice',
        title: 'What went best?',
        options: ['Meals', 'Protein', 'Workout or movement', 'Just staying consistent'],
      },
      {
        id: 'biggest_break',
        type: 'choice',
        title: 'What broke most?',
        options: ['Cravings', 'Overeating', 'Low protein', 'Skipped movement'],
      },
      {
        id: 'tomorrow_shift',
        type: 'choice',
        title: 'What should change tomorrow?',
        options: ['Simpler meals', 'More protein earlier', 'Protect the workout', 'Keep the same plan'],
      },
      {
        id: 'final_note',
        type: 'text',
        title: 'Anything else about today that we missed?',
        optional: true,
        placeholder: 'Optional',
      },
    ],
  },
  weekly_body_review: {
    eyebrow: 'WEEKLY',
    contextMode: 'weekly_review',
    title: 'Weekly Body Review',
    intro: 'This is where VITA turns the week into a sharper plan instead of more guessing.',
    submitLabel: 'Review with VITA',
    questions: [
      {
        id: 'week_result',
        type: 'choice',
        title: 'Did the week move toward your goal?',
        options: ['Clearly yes', 'A little', 'Not really', 'It drifted hard'],
      },
      {
        id: 'repeat_pattern',
        type: 'choice',
        title: 'What repeated most?',
        options: ['Cravings', 'Late eating', 'Low protein', 'Skipped workouts'],
      },
      {
        id: 'best_signal',
        type: 'choice',
        title: 'What felt easiest?',
        options: ['Morning rhythm', 'Meals', 'Protein', 'Training'],
      },
      {
        id: 'next_adjustment',
        type: 'choice',
        title: 'What should change next week?',
        options: ['Tighten structure', 'Simplify more', 'Push harder', 'Recover better'],
      },
      {
        id: 'final_note',
        type: 'text',
        title: 'Anything else from the week we missed?',
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
    const targetDays = {sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6};
    const allowed = (schedule.days || []).map(day => targetDays[day]).filter(n => n !== undefined);
    if (!allowed.length) return null;
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
  return questions.map(question => ({...question}));
}

function getVitaActionFlow(actionType) {
  const flow = VITA_ACTION_FLOWS[actionType];
  if (!flow) return null;
  return {...flow, questions: cloneFlowQuestions(flow.questions)};
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
  logs.forEach(entry => {
    const value = entry?.[field];
    if (!value) return;
    counts.set(value, (counts.get(value) || 0) + 1);
  });
  if (!counts.size) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function deriveSupportRisk(profile = {}, state = {}) {
  let score = 0;
  const problems = normalizeChoiceArray(profile.biggest_problem);
  if (profile.priority === 'Consistency') score += 2;
  if (problems.includes('I start strong then fall off')) score += 2;
  if (problems.includes('I skip workouts')) score += 1;
  if (problems.includes('I overeat when I am off-track')) score += 1;
  if ((state.lastCheckInScore || 10) <= 4) score += 2;
  if ((state.consistencyStreak || 0) >= 3) score -= 1;
  if (score >= 5) return 'high';
  if (score >= 3) return 'medium';
  return 'low';
}

async function getOrCreateUser(userId, userName = '') {
  const ref = userRef(userId);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set(
      {
        userId,
        name: userName || '',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        conversationDays: 0,
      },
      {merge: true},
    );
  } else if (userName && snap.data().name !== userName) {
    await ref.set({name: userName, updatedAt: nowIso()}, {merge: true});
  }
  return (await ref.get()).data();
}

function emptyVitaState() {
  return {
    agentId: 'vita',
    setupComplete: false,
    setupProgress: 0,
    profile: {},
    setupAnswers: {},
    consistencyStreak: 0,
    lastCheckInScore: null,
    lastWeight: null,
    lastEnergy: null,
    lastTriggerType: null,
    lastWorkoutStatus: null,
    latestActionResults: {},
    repeatingTriggerSummary: null,
    repeatingUrgeSummary: null,
    currentMode: 'normal',
    activeFocus: null,
    currentRiskLevel: 'medium',
    analysis: null,
    conversationCount: 0,
    lastInteractionAt: null,
    lastProactiveAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

async function getOrCreateVitaState(userId) {
  const ref = agentRef(userId);
  const snap = await ref.get();
  if (!snap.exists) {
    const initial = emptyVitaState();
    await ref.set(initial, {merge: true});
    return initial;
  }
  return {...emptyVitaState(), ...snap.data()};
}

async function getVitaMessages(userId, limit = 60) {
  const snap = await messagesRef(userId).orderBy('timestamp', 'asc').limit(limit).get();
  return snap.docs.map(doc => doc.data());
}

async function getVitaActions(userId) {
  const snap = await actionsRef(userId).orderBy('createdAt', 'desc').limit(100).get();
  return snap.docs.map(doc => doc.data()).filter(action => action.agentId === 'vita');
}

async function getVitaLogs(userId, limit = 60) {
  const snap = await logsRef(userId).orderBy('createdAt', 'desc').limit(limit).get();
  return snap.docs.map(doc => doc.data());
}

function formatProfileSummary(profile) {
  const problems = normalizeChoiceArray(profile.biggest_problem).join(', ') || 'none specified';
  const actions = normalizeChoiceArray(profile.auto_actions).join(', ') || 'none';
  return `Goal: ${profile.goal_type || 'unknown'}
Priority: ${profile.priority || 'unknown'}
Biggest problems: ${problems}
Current style: ${profile.current_style || 'unknown'}
Support style: ${profile.support_style || 'unknown'}
Tracking style: ${profile.tracking_style || 'unknown'}
Weigh-in time: ${profile.weighin_time || 'unknown'}
Workout time: ${profile.workout_time || 'unknown'}
Closeout time: ${profile.closeout_time || 'unknown'}
Review day: ${profile.review_day || 'unknown'}
Review time: ${profile.review_time || 'unknown'}
Enabled actions: ${actions}`;
}

function buildVitaLiveContext(agentState, profile, actions = []) {
  const activeActions =
    actions
      .filter(action => ['active', 'snoozed'].includes(action.status))
      .slice(0, 8)
      .map(
        action =>
          `- ${action.title} (${action.status})${action.schedule?.time ? ` at ${action.schedule.time}` : ''}`,
      )
      .join('\n') || '- none';

  return `\n\n━━━ USER PROFILE ━━━\n${formatProfileSummary(profile)}\n\n━━━ LIVE STATE ━━━
Risk level: ${agentState.currentRiskLevel || 'medium'}
Consistency streak: ${agentState.consistencyStreak || 0}
Last check-in score: ${agentState.lastCheckInScore ?? 'none'}
Last weight: ${agentState.lastWeight ?? 'none'}
Last energy: ${agentState.lastEnergy ?? 'none'}
Last workout status: ${agentState.lastWorkoutStatus ?? 'none'}
Current mode: ${agentState.currentMode || 'normal'}
Active focus: ${agentState.activeFocus || profile.priority || 'execute the next best health move'}
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

function buildVitaCheckinSurvey(contextMode, action = null) {
  const actionType = action?.type || MODE_TO_ACTION_TYPE[contextMode];
  const flow = getVitaActionFlow(actionType);
  if (!flow) return null;
  return {
    id: `vita_${actionType}_${action?.id || 'default'}`,
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

function titleForType(type) {
  return ACTION_TYPE_META[type]?.title || type;
}

function summarizeVitaStructuredCheckin(payload = {}) {
  const pieces = [];
  const actionType = payload.actionType || payload.action_type;
  if (actionType) pieces.push(`Tool: ${titleForType(actionType)}`);
  const weight = pickFirst(payload, ['weight_value']);
  const energy = pickFirst(payload, ['energy']);
  const trigger = pickFirst(payload, ['trigger_type', 'today_risk', 'biggest_break', 'repeat_pattern', 'miss_reason']);
  const urge = pickFirst(payload, ['craving_item', 'craving_intensity']);
  const need = pickFirst(payload, ['support_need']);
  const outcome = pickFirst(payload, ['desired_outcome', 'tomorrow_shift', 'next_adjustment', 'meal_goal']);
  if (weight) pieces.push(`Weight: ${weight}`);
  if (energy) pieces.push(`Energy: ${energy}`);
  if (trigger) pieces.push(`Trigger: ${trigger}`);
  if (urge) pieces.push(`Urge: ${urge}`);
  if (need) pieces.push(`Need: ${need}`);
  if (outcome) pieces.push(`Focus: ${outcome}`);
  if (payload.final_note) pieces.push(`Extra: ${payload.final_note}`);
  return pieces.join('. ');
}

function parseVitaStructuredCheckin(payload = {}, contextMode = 'normal') {
  const ratingMap = {
    'Locked in': 9,
    'Pretty good': 7,
    'Could slip': 5,
    'Messy already': 3,
    'Very on-track': 9,
    'Mostly solid': 7,
    'Messy in places': 5,
    'Off-track': 3,
    'Clearly yes': 8,
    'A little': 6,
    'Not really': 4,
    'It drifted hard': 2,
  };
  const weightRaw = pickFirst(payload, ['weight_value']);
  const weight = weightRaw && !Number.isNaN(Number(weightRaw)) ? Number(weightRaw) : null;
  const energy = pickFirst(payload, ['energy']);
  const workoutStatus = pickFirst(payload, ['workout_status']);
  const triggerType = pickFirst(payload, ['trigger_type', 'today_risk', 'biggest_break', 'repeat_pattern', 'miss_reason']);
  const urge = pickFirst(payload, ['craving_item', 'craving_intensity', 'risk_level']);
  const desiredOutcome = pickFirst(payload, ['desired_outcome', 'tomorrow_shift', 'next_adjustment', 'meal_goal']);
  const supportNeed = pickFirst(payload, ['support_need']);
  const userChoice = pickFirst(payload, ['readiness', 'on_track_score', 'week_result', 'protein_status', 'meal_type', 'best_win']);
  const actionType = payload.actionType || payload.action_type || MODE_TO_ACTION_TYPE[contextMode] || null;
  const scoreSource = pickFirst(payload, ['readiness', 'on_track_score', 'week_result']);
  return {
    rating: ratingMap[scoreSource] || null,
    weight,
    energy: energy || null,
    workoutStatus: workoutStatus || null,
    triggerType: triggerType || null,
    urge: urge || null,
    desiredOutcome: desiredOutcome || null,
    supportNeed: supportNeed || null,
    userChoice: userChoice || null,
    actionType,
    finalNote: payload.final_note || '',
  };
}

async function storeVitaCheckin(userId, payload = {}, contextMode = 'normal', messageId = null, profile = {}) {
  const parsed = parseVitaStructuredCheckin(payload, contextMode);
  const currentState = await getOrCreateVitaState(userId);
  const ref = logsRef(userId).doc();
  const createdAt = nowIso();
  const entry = {
    id: ref.id,
    agentId: 'vita',
    type: contextMode,
    actionType: parsed.actionType,
    actionId: payload.actionId || null,
    goalType: profile.goal_type || null,
    dateKey: dateKeyFromIso(createdAt),
    createdAt,
    messageId,
    triggerType: parsed.triggerType,
    energy: parsed.energy,
    urge: parsed.urge,
    desiredOutcome: parsed.desiredOutcome,
    supportNeed: parsed.supportNeed,
    userChoice: parsed.userChoice,
    workoutStatus: parsed.workoutStatus,
    weight: parsed.weight,
    recommendedMove: null,
    freeTextNote: parsed.finalNote,
    answers: payload,
    parsed,
  };
  await ref.set(entry);

  const recentLogs = [entry, ...(await getVitaLogs(userId, 18)).filter(log => log.id !== entry.id)];
  await agentRef(userId).set(
    {
      latestActionResults: parsed.actionType
        ? {
            ...(currentState.latestActionResults || {}),
            [parsed.actionType]: {
              at: createdAt,
              energy: parsed.energy || null,
              triggerType: parsed.triggerType || null,
              desiredOutcome: parsed.desiredOutcome || null,
              supportNeed: parsed.supportNeed || null,
            },
          }
        : currentState.latestActionResults || {},
      repeatingTriggerSummary: summarizeRecentField(recentLogs, 'triggerType'),
      repeatingUrgeSummary: summarizeRecentField(recentLogs, 'urge'),
      updatedAt: nowIso(),
    },
    {merge: true},
  );
  return entry;
}

function messageToChatRole(message) {
  return {
    role: message.role === 'user' ? 'user' : 'assistant',
    content: message.content,
  };
}

function getModeGuide(mode) {
  if (mode === 'morning_weighin') {
    return 'This is the morning weigh-in. Make the day simpler, tighter, and calmer based on the signal.';
  }
  if (mode === 'protein_rescue') {
    return 'This is protein rescue. Give one practical correction, not a lecture.';
  }
  if (mode === 'craving_reset') {
    return 'This is a craving moment. Reduce damage, reduce shame, and give the next best move.';
  }
  if (mode === 'before_meal') {
    return 'This is before a meal. Help them make the plate or choice better without making it complicated.';
  }
  if (mode === 'workout_lock_in') {
    return 'This is workout lock-in. Protect momentum and lower the chance of skipping.';
  }
  if (mode === 'missed_workout') {
    return 'This is missed-workout recovery. Stop all-or-nothing thinking and give the best fallback.';
  }
  if (mode === 'evening_closeout') {
    return 'This is evening closeout. Pull out the one thing that mattered today and one shift for tomorrow.';
  }
  if (mode === 'weekly_review') {
    return 'This is weekly body review. Find the pattern and adjust the plan without overreacting.';
  }
  if (mode === 'action_followup') {
    return 'This is action follow-up. Reference the action in plain language and keep it to one clean move.';
  }
  return 'Normal mode. Be practical, brief, and directly useful right now.';
}

async function generateSetupMessage(userName, profile, starterActions) {
  const actionSummary = starterActions
    .map(action => `${action.title}${action.schedule?.time ? ` at ${action.schedule.time}` : ''}`)
    .join(', ');
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.7,
      max_tokens: 90,
      messages: [
        {
          role: 'system',
          content: `${VITA_IDENTITY.corePrompt}

You are writing the very first message after setup.
Hard rules:
- one short paragraph
- under 55 words
- never sound like onboarding copy
- pick the sharpest friction point and one concrete starting move
- one question max
- do not mention "setup" or "starter actions"`,
        },
        {
          role: 'user',
          content: `User name: ${userName || 'there'}\nProfile:\n${formatProfileSummary(profile)}\nStarter actions: ${actionSummary}`,
        },
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

async function generateChatReply({profile, state, actions, history, message, contextMode}) {
  const systemPrompt = `${VITA_IDENTITY.corePrompt}${buildVitaLiveContext(
    state,
    profile,
    actions,
  )}

━━━ MODE GUIDE ━━━
${getModeGuide(contextMode)}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.65,
    max_tokens: 90,
    messages: [
      {role: 'system', content: systemPrompt},
      ...history.slice(-18).map(messageToChatRole),
      {role: 'user', content: message},
    ],
  });

  return cleanAssistantReply(
    completion.choices[0]?.message?.content,
    'Let’s keep this simple and make the next move cleaner, not perfect.',
  );
}

function getActionKey(type) {
  return `vita_${type}`;
}

function buildStarterActionTemplates(profile) {
  const actions = [];
  const enabled = new Set(normalizeChoiceArray(profile.auto_actions));
  const problems = normalizeChoiceArray(profile.biggest_problem);
  const goalType = profile.goal_type || '';
  const currentStyle = profile.current_style || '';
  const weighinTime = profile.weighin_time || '7:00 AM';
  const workoutTime = profile.workout_time || '6:00 PM';
  const closeoutTime = profile.closeout_time || '9:30 PM';
  const reviewTime = profile.review_time || '8:30 PM';
  const reviewDayMap = {
    Sunday: ['sun'],
    Monday: ['mon'],
    Friday: ['fri'],
    Saturday: ['sat'],
  };
  const reviewDays = reviewDayMap[profile.review_day] || ['sun'];

  actions.push({
    key: getActionKey('morning_weighin'),
    type: 'morning_weighin',
    title: 'Morning Weigh-In',
    subtitle: weighinTime,
    detail: 'Track the morning signal so VITA can coach the day from reality, not mood.',
    reason: 'Runs every morning.',
    whyNow: 'Morning signal helps VITA tighten the day before it drifts.',
    schedule: {kind: 'daily', time: weighinTime},
    priority: 'high',
    successMetric: 'Start the day with better signal',
    source: 'setup',
    confidence: 0.95,
    editable: true,
    status: 'active',
  });

  if (enabled.has('Protein Target Rescue') || problems.includes('I miss protein') || profile.priority === 'Nutrition') {
    actions.push({
      key: getActionKey('protein_target_rescue'),
      type: 'protein_target_rescue',
      title: 'Protein Target Rescue',
      subtitle: '1:00 PM',
      detail: 'Catch protein drift early enough to fix the day with one smart food move.',
      reason: 'Runs midday.',
      whyNow: 'Protein misses tend to compound when they go unnoticed till night.',
      schedule: {kind: 'daily', time: '1:00 PM'},
      priority: 'medium',
      successMetric: 'Recover protein earlier in the day',
      source: 'setup',
      confidence: 0.89,
      editable: true,
      status: 'active',
    });
  }

  if (enabled.has('Craving Reset') || problems.includes('I overeat when I am off-track') || problems.includes('I snack late')) {
    actions.push({
      key: getActionKey('craving_reset'),
      type: 'craving_reset',
      title: 'Craving Reset',
      subtitle: 'Open when cravings hit',
      detail: 'Use this when the urge to eat off-plan starts getting louder than the goal.',
      reason: 'Always available.',
      whyNow: 'This is the moment where the day often turns if there is no interrupt.',
      schedule: {kind: 'conditional', trigger: 'manual'},
      priority: 'high',
      successMetric: 'Break the craving loop earlier',
      source: 'setup',
      confidence: 0.93,
      editable: false,
      status: 'active',
    });
  }

  if (enabled.has('Before Meal Check') || profile.tracking_style === 'I want very light tracking') {
    actions.push({
      key: getActionKey('before_meal_check'),
      type: 'before_meal_check',
      title: 'Before Meal Check',
      subtitle: 'Open before you eat',
      detail: 'Use this when you want a better meal choice without having to overthink the whole day.',
      reason: 'Always available.',
      whyNow: 'Small meal decisions are easier to improve before the bite, not after.',
      schedule: {kind: 'conditional', trigger: 'manual'},
      priority: 'medium',
      successMetric: 'Make more meals support the goal',
      source: 'setup',
      confidence: 0.9,
      editable: false,
      status: 'active',
    });
  }

  if (
    enabled.has('Workout Lock-In') ||
    problems.includes('I skip workouts') ||
    profile.priority === 'Workouts' ||
    currentStyle !== 'I am not training yet'
  ) {
    actions.push({
      key: getActionKey('workout_lock_in'),
      type: 'workout_lock_in',
      title: 'Workout Lock-In',
      subtitle: workoutTime,
      detail: 'Protect the workout slot before the day talks you out of it.',
      reason: 'Runs every training day.',
      whyNow: 'The most useful training support often happens right before the excuse lands.',
      schedule: {kind: 'daily', time: workoutTime},
      priority: 'medium',
      successMetric: 'Skip fewer planned sessions',
      source: 'setup',
      confidence: 0.88,
      editable: true,
      status: 'active',
    });
  }

  if (enabled.has('Missed Workout Recovery') || problems.includes('I skip workouts') || problems.includes('I start strong then fall off')) {
    actions.push({
      key: getActionKey('missed_workout_recovery'),
      type: 'missed_workout_recovery',
      title: 'Missed Workout Recovery',
      subtitle: 'Open after a miss',
      detail: 'Use this when the workout slips so one miss does not become a whole bad run.',
      reason: 'Always available.',
      whyNow: 'Recovery from the miss matters almost more than the miss itself.',
      schedule: {kind: 'conditional', trigger: 'manual'},
      priority: 'medium',
      successMetric: 'Turn misses into cleaner recoveries',
      source: 'setup',
      confidence: 0.9,
      editable: false,
      status: 'active',
    });
  }

  actions.push({
    key: getActionKey('evening_closeout'),
    type: 'evening_closeout',
    title: 'Evening Closeout',
    subtitle: closeoutTime,
    detail: 'Close the day with signal about food, movement, cravings, and what tomorrow needs.',
    reason: 'Runs every evening.',
    whyNow: 'This is how VITA learns what really shaped the day.',
    schedule: {kind: 'daily', time: closeoutTime},
    priority: 'high',
    successMetric: 'End the day with better learning',
    source: 'setup',
    confidence: 0.95,
    editable: true,
    status: 'active',
  });

  actions.push({
    key: getActionKey('weekly_body_review'),
    type: 'weekly_body_review',
    title: 'Weekly Body Review',
    subtitle: `${profile.review_day || 'Sunday'} · ${reviewTime}`,
    detail: 'Review the week so VITA can adjust structure, pressure, and focus based on real trend.',
    reason: 'Runs every week.',
    whyNow: 'Weekly reviews stop random overcorrection and show the true pattern.',
    schedule: {kind: 'weekly', time: reviewTime, days: reviewDays},
    priority: 'medium',
    successMetric: 'Adjust the plan with better signal',
    source: 'setup',
    confidence: 0.9,
    editable: true,
    status: 'active',
  });

  if (goalType === 'Feel healthier and more consistent' && !actions.find(action => action.type === 'before_meal_check')) {
    actions.push({
      key: getActionKey('before_meal_check'),
      type: 'before_meal_check',
      title: 'Before Meal Check',
      subtitle: 'Open before you eat',
      detail: 'Use this before meals when you want one smarter health move without tracking every detail.',
      reason: 'Always available.',
      whyNow: 'Consistency comes from better repeated choices, not perfect days.',
      schedule: {kind: 'conditional', trigger: 'manual'},
      priority: 'medium',
      successMetric: 'Make cleaner meal choices faster',
      source: 'setup',
      confidence: 0.84,
      editable: false,
      status: 'active',
    });
  }

  return actions;
}

async function ensureCoreVitaActions(userId, profile = {}) {
  if (!profile || !Object.keys(profile).length) return [];
  const existingActions = await getVitaActions(userId);
  const existingByKey = new Map(existingActions.map(action => [action.key, action]));
  const created = [];
  for (const draft of buildStarterActionTemplates(profile)) {
    const existing = existingByKey.get(draft.key);
    const normalizedDraft =
      existing?.schedule?.time && draft.schedule?.time
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
  const pendingSnap = await scheduledRef(userId).where('status', '==', 'pending').get();
  const deletions = pendingSnap.docs
    .filter(doc => {
      const data = doc.data();
      return data.agentId === 'vita' && data.actionId === action.id;
    })
    .map(doc => doc.ref.delete());
  await Promise.all(deletions);

  if (action.status !== 'active') return;
  if (!action.schedule || !['daily', 'weekly', 'one_time'].includes(action.schedule.kind)) return;

  const nextTriggerAt = getNextTriggerAt(action.schedule);
  if (!nextTriggerAt) return;

  const triggerRef = scheduledRef(userId).doc();
  await triggerRef.set({
    id: triggerRef.id,
    userId,
    agentId: 'vita',
    actionId: action.id,
    triggerAt: nextTriggerAt,
    type: action.type,
    contextMode: ACTION_TYPE_TO_MODE[action.type] || 'action_followup',
    opener: action.detail,
    quickReplies: getQuickRepliesForMode(ACTION_TYPE_TO_MODE[action.type] || 'normal'),
    recurring: action.schedule.kind !== 'one_time',
    status: 'pending',
    createdAt: nowIso(),
  });
}

async function scheduleSnoozedTrigger(userId, action, delayMinutes = 20) {
  const pendingSnap = await scheduledRef(userId).where('status', '==', 'pending').get();
  await Promise.all(
    pendingSnap.docs
      .filter(doc => {
        const data = doc.data();
        return data.agentId === 'vita' && data.actionId === action.id;
      })
      .map(doc => doc.ref.delete()),
  );

  const triggerRef = scheduledRef(userId).doc();
  await triggerRef.set({
    id: triggerRef.id,
    userId,
    agentId: 'vita',
    actionId: action.id,
    triggerAt: new Date(Date.now() + delayMinutes * 60 * 1000).toISOString(),
    type: action.type,
    contextMode: 'action_followup',
    opener: `Quick nudge: ${action.title} still matters today. ${action.whyNow || action.detail}`,
    quickReplies: getQuickRepliesForMode('action_followup'),
    recurring: false,
    resumeStatus: 'active',
    status: 'pending',
    createdAt: nowIso(),
  });
}

async function upsertAction(userId, draft) {
  const existingSnap = await actionsRef(userId).where('key', '==', draft.key).limit(1).get();
  const timestamp = nowIso();
  const payload = {
    ...draft,
    agentId: 'vita',
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
    await doc.ref.set({...payload, id}, {merge: true});
  } else {
    const ref = actionsRef(userId).doc();
    id = ref.id;
    await ref.set({...payload, id});
  }

  const finalAction = {...payload, id};
  await syncActionSchedule(userId, finalAction);
  return finalAction;
}

function inferModeFromMessage(text, fallback = 'normal') {
  const lower = text.toLowerCase();
  if (/(craving|want sweets|junk food|stress eating|binge)/i.test(lower)) return 'craving_reset';
  if (/(meal|snack|eat this|takeout|restaurant|portion)/i.test(lower)) return 'before_meal';
  if (/(workout|gym|training|session|skip)/i.test(lower)) return 'workout_lock_in';
  if (/(weigh in|scale|weight today|weight is up|weight is down)/i.test(lower)) return 'morning_weighin';
  if (/(protein|low protein|missed protein)/i.test(lower)) return 'protein_rescue';
  if (/(evening closeout|today was on track|off-track today)/i.test(lower)) return 'evening_closeout';
  if (/(weekly review|this week|body review)/i.test(lower)) return 'weekly_review';
  return fallback;
}

function fallbackActionDecision(message, profile, actions) {
  const lower = message.toLowerCase();
  const results = [];
  const activeTypes = new Set(actions.filter(action => action.status === 'active').map(action => action.type));
  if (/(craving|stress eating|junk food|binge)/.test(lower) && !activeTypes.has('craving_reset')) {
    results.push({
      type: 'create',
      action: {
        key: getActionKey('craving_reset'),
        type: 'craving_reset',
        title: 'Craving Reset',
        subtitle: 'Open when cravings hit',
        detail: 'VITA added a craving interrupt because the urge pattern is clearly one of the places your day gets hijacked.',
        reason: 'Added from conversation because cravings keep showing up as a real trigger.',
        whyNow: 'This is where a small interrupt can save the whole day.',
        schedule: {kind: 'conditional', trigger: 'manual'},
        priority: 'high',
        successMetric: 'Break the craving loop earlier',
        source: 'chat',
        confidence: 0.84,
        editable: false,
        status: 'active',
      },
    });
  }
  if (/(skip|skipped|missed the workout|didn't train)/.test(lower) && !activeTypes.has('missed_workout_recovery')) {
    results.push({
      type: 'create',
      action: {
        key: getActionKey('missed_workout_recovery'),
        type: 'missed_workout_recovery',
        title: 'Missed Workout Recovery',
        subtitle: 'Open after a miss',
        detail: 'VITA added this because one missed session is starting to turn into a momentum problem.',
        reason: 'Added from conversation because workout misses need a fast recovery path.',
        whyNow: 'The recovery after the miss matters more than replaying it.',
        schedule: {kind: 'conditional', trigger: 'manual'},
        priority: 'medium',
        successMetric: 'Recover faster after skipped sessions',
        source: 'chat',
        confidence: 0.82,
        editable: false,
        status: 'active',
      },
    });
  }
  if (/(meal|portion|takeout|restaurant|what should i eat)/.test(lower) && !activeTypes.has('before_meal_check')) {
    results.push({
      type: 'create',
      action: {
        key: getActionKey('before_meal_check'),
        type: 'before_meal_check',
        title: 'Before Meal Check',
        subtitle: 'Open before you eat',
        detail: 'VITA added this because your food decisions need a cleaner pause before they happen.',
        reason: 'Added from conversation because meal moments need a fast decision tool.',
        whyNow: 'Small plate changes are easier before the meal than after it.',
        schedule: {kind: 'conditional', trigger: 'manual'},
        priority: 'medium',
        successMetric: 'Make better meal calls faster',
        source: 'chat',
        confidence: 0.8,
        editable: false,
        status: 'active',
      },
    });
  }
  if (
    /(protein|under ate protein|need protein)/.test(lower) &&
    !activeTypes.has('protein_target_rescue') &&
    profile.priority === 'Nutrition'
  ) {
    results.push({
      type: 'create',
      action: {
        key: getActionKey('protein_target_rescue'),
        type: 'protein_target_rescue',
        title: 'Protein Target Rescue',
        subtitle: '1:00 PM',
        detail: 'VITA added a midday rescue because protein is one of the things that keeps slipping.',
        reason: 'Added from conversation because protein misses look repeated.',
        whyNow: 'Protein drift is easier to fix midday than at night.',
        schedule: {kind: 'daily', time: '1:00 PM'},
        priority: 'medium',
        successMetric: 'Recover protein earlier',
        source: 'chat',
        confidence: 0.79,
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
      response_format: {type: 'json_object'},
      messages: [
        {
          role: 'system',
          content: `You are VITA's action engine.
Decide if the user's latest message should create a health support action.
Return JSON with shape:
{
  "mode":"normal|morning_weighin|protein_rescue|craving_reset|before_meal|workout_lock_in|missed_workout|evening_closeout|weekly_review|action_followup",
  "changes":[
    {
      "type":"create|none",
      "actionType":"morning_weighin|protein_target_rescue|craving_reset|before_meal_check|workout_lock_in|missed_workout_recovery|evening_closeout|weekly_body_review",
      "title":"string",
      "subtitle":"string",
      "detail":"string",
      "reason":"string",
      "whyNow":"string",
      "scheduleKind":"daily|weekly|one_time|conditional",
      "time":"9:30 PM or null",
      "days":["sun"],
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
- Avoid duplicates.
- Use conditional actions for craving, meal, or recovery tools.
- Use timed actions only when they clearly improve daily execution.
- If the user is just venting, return no changes.`,
        },
        {
          role: 'user',
          content: `Context mode: ${contextMode}
Profile:
${formatProfileSummary(profile)}
Current state:
Risk=${state.currentRiskLevel}; streak=${state.consistencyStreak}; lastCheckIn=${state.lastCheckInScore}; lastWeight=${state.lastWeight}
Existing actions:
${actions.map(action => `- ${action.type} (${action.status})`).join('\n') || '- none'}

Latest user message:
${message}`,
        },
      ],
    });

    const parsed = JSON.parse(completion.choices[0]?.message?.content || '{}');
    const activeTypes = new Set(actions.filter(action => action.status === 'active').map(action => action.type));
    const changes = (parsed.changes || [])
      .filter(change => change.type === 'create' && change.actionType && !activeTypes.has(change.actionType))
      .map(change => ({
        type: 'create',
        action: {
          key: getActionKey(change.actionType),
          type: change.actionType,
          title: change.title || titleForType(change.actionType),
          subtitle: change.subtitle || '',
          detail: change.detail || '',
          reason: change.reason || 'Added by VITA from the conversation.',
          whyNow: change.whyNow || 'The conversation made this worth turning into support.',
          schedule:
            change.scheduleKind === 'conditional'
              ? {kind: 'conditional', trigger: change.trigger || 'manual'}
              : {
                  kind: change.scheduleKind || 'daily',
                  time: change.time || null,
                  days: change.days || [],
                  trigger: change.trigger || null,
                },
          priority: change.priority || 'medium',
          successMetric: change.successMetric || 'Make the next move cleaner',
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

function parseVitaCheckinHeuristic(message) {
  const lower = message.toLowerCase();
  const ratingMatch = message.match(/(\d{1,2})\s*\/\s*10/);
  const rating = ratingMatch ? Math.max(1, Math.min(10, parseInt(ratingMatch[1], 10))) : null;
  let triggerType = null;
  if (/craving|junk|stress eating|snack/.test(lower)) triggerType = 'Craving pressure';
  else if (/workout|gym|skip/.test(lower)) triggerType = 'Workout resistance';
  else if (/protein|meal|overeating|portion/.test(lower)) triggerType = 'Food execution';
  return {rating, triggerType};
}

async function processVitaCheckinReply(userId, userMessage, structuredCheckin = null) {
  const state = await getOrCreateVitaState(userId);
  const parsed = structuredCheckin
    ? parseVitaStructuredCheckin(structuredCheckin, structuredCheckin.contextMode || state.currentMode || 'normal')
    : parseVitaCheckinHeuristic(userMessage);
  if (
    parsed.rating == null &&
    !parsed.triggerType &&
    !parsed.energy &&
    parsed.weight == null &&
    !parsed.workoutStatus
  ) {
    return state;
  }

  let consistencyStreak = state.consistencyStreak || 0;
  if (parsed.rating != null) {
    if (parsed.rating >= 6) consistencyStreak += 1;
    else if (parsed.rating <= 4) consistencyStreak = 0;
  }

  const patch = {
    consistencyStreak,
    updatedAt: nowIso(),
    currentMode: 'normal',
  };
  if (parsed.rating != null) patch.lastCheckInScore = parsed.rating;
  if (parsed.energy != null) patch.lastEnergy = parsed.energy;
  if (parsed.triggerType != null) patch.lastTriggerType = parsed.triggerType;
  if (parsed.workoutStatus != null) patch.lastWorkoutStatus = parsed.workoutStatus;
  if (parsed.weight != null) patch.lastWeight = parsed.weight;
  patch.currentRiskLevel = deriveSupportRisk(state.profile || {}, {...state, ...patch});

  await agentRef(userId).set(patch, {merge: true});
  return {...state, ...patch};
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
  return actions.slice(0, 4).map(action => ({
    id: action.id,
    title: action.title,
    subtitle: action.subtitle,
    reason: action.reason,
  }));
}

function groupActions(actions) {
  const sections = [
    {key: 'Daily Rhythm', items: []},
    {key: 'Live Tools', items: []},
    {key: 'Weekly Review', items: []},
  ];
  const byKey = Object.fromEntries(sections.map(section => [section.key, section]));
  actions.forEach(action => {
    const key = ACTION_TYPE_META[action.type]?.bucket || 'Live Tools';
    byKey[key]?.items.push(action);
  });
  return sections.filter(section => section.items.length > 0);
}

function buildVitaChart(logs = []) {
  const recent = logs.slice().reverse().slice(-7);
  return recent.map(entry => ({
    label: new Date(entry.createdAt || Date.now())
      .toLocaleDateString('en-US', {weekday: 'short'})
      .slice(0, 3),
    value: entry.weight || entry.parsed?.rating || entry.rating || 5,
  }));
}

function buildFallbackAnalysis(state, messages, actions, logs = []) {
  const profile = state.profile || {};
  const recentUserMessages = messages.filter(message => message.role === 'user').slice(-8);
  const text = recentUserMessages.map(message => message.content.toLowerCase()).join(' ');
  const activeActions = actions.filter(action => action.status === 'active');
  const topTrigger = summarizeRecentField(logs, 'triggerType');
  const topUrge = summarizeRecentField(logs, 'urge');

  let pattern = 'Your body pattern is clear enough now that VITA can start getting ahead of it instead of just reacting after the day goes sideways.';
  if (topTrigger === 'Craving pressure' || /craving|snack|junk|binge/.test(text)) {
    pattern = 'Craving pressure still looks like the fastest place for your day to turn.';
  } else if (topTrigger === 'Workout resistance' || /skip|workout|gym|training/.test(text)) {
    pattern = 'Workout resistance still looks like the moment where consistency drops fastest.';
  } else if (topTrigger === 'Food execution' || /protein|meal|portion|overeat/.test(text)) {
    pattern = 'Food execution still looks like the main point where the goal gets lost in the day.';
  }

  const wins = [];
  if ((state.consistencyStreak || 0) >= 2) wins.push(`You have ${state.consistencyStreak} steadier check-ins in a row.`);
  if ((state.lastCheckInScore || 0) >= 7) wins.push(`Your latest health check-in landed at ${state.lastCheckInScore}/10.`);
  if (activeActions.length >= 4) wins.push(`VITA is actively running ${activeActions.length} systems for you right now.`);
  if (!wins.length) wins.push('The good news is your friction points are clear enough to coach now.');

  const risks = [];
  if ((state.lastCheckInScore || 10) <= 4) risks.push('Recent signal still suggests the day is getting away too early.');
  if (profile.priority === 'Consistency') risks.push('Consistency still looks more fragile than motivation.');
  if (topUrge === 'I am about to cave' || topUrge === 'Big portions') risks.push('Off-plan eating still looks like the easiest place for one rough moment to turn into a rough day.');
  if (!risks.length) risks.push('The next risk is drifting back into the same friction point without noticing it early.');

  return {
    generatedAt: nowIso(),
    summary: pattern,
    patterns: [pattern],
    wins: wins.slice(0, 2),
    risks: risks.slice(0, 2),
    focus: profile.priority || 'Make the next few days easier to execute cleanly.',
    chart: buildVitaChart(logs),
  };
}

function summarizeVitaLogsForPrompt(logs = []) {
  if (!logs.length) return '- no structured VITA logs yet';
  return logs
    .slice(0, 8)
    .map(
      entry =>
        `- ${entry.actionType || entry.type}: trigger=${entry.triggerType || 'unknown'}, energy=${entry.energy || 'unknown'}, urge=${entry.urge || 'unknown'}, outcome=${entry.desiredOutcome || 'unknown'}, weight=${entry.weight || 'n/a'}`,
    )
    .join('\n');
}

async function generateVitaAnalysis(userId, state, messages, actions, logs = []) {
  const fallback = buildFallbackAnalysis(state, messages, actions, logs);
  try {
    const recentUserMessages =
      messages
        .filter(message => message.role === 'user')
        .slice(-10)
        .map(message => `- ${message.content}`)
        .join('\n') || '- no recent user messages';
    const actionSummary =
      actions
        .filter(action => ['active', 'snoozed', 'completed'].includes(action.status))
        .slice(0, 8)
        .map(action => `- ${action.title} (${action.status})${action.schedule?.time ? ` at ${action.schedule.time}` : ''}`)
        .join('\n') || '- no actions';

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 320,
      response_format: {type: 'json_object'},
      messages: [
        {
          role: 'system',
          content: `You generate a sharp weekly analysis for a premium health and body-goal agent.
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
- Use the user's actual health friction, actions, and trend.
- Keep every line short and premium.
- If the signal is weak, still make the summary useful and honest.`,
        },
        {
          role: 'user',
          content: `Profile:
${formatProfileSummary(state.profile || {})}

Current state:
Risk: ${state.currentRiskLevel}
Consistency streak: ${state.consistencyStreak}
Last check-in score: ${state.lastCheckInScore}
Last weight: ${state.lastWeight}
Last energy: ${state.lastEnergy}
Repeating trigger: ${state.repeatingTriggerSummary || 'none'}
Repeating urge: ${state.repeatingUrgeSummary || 'none'}

Recent user messages:
${recentUserMessages}

Structured VITA logs:
${summarizeVitaLogsForPrompt(logs)}

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

async function buildVitaStatePayload(userId) {
  const state = await getOrCreateVitaState(userId);
  if (state.setupComplete) {
    await ensureCoreVitaActions(userId, state.profile || {});
  }
  const [messages, actions, logs] = await Promise.all([
    getVitaMessages(userId),
    getVitaActions(userId),
    getVitaLogs(userId, 24),
  ]);
  const analysis = state.analysis || buildFallbackAnalysis(state, messages, actions, logs);
  return {
    success: true,
    setupComplete: !!state.setupComplete,
    state: {...state, analysis},
    messages,
    actions,
    actionGroups: groupActions(actions.filter(action => action.status !== 'deleted' && action.status !== 'expired')),
    quickReplies: getQuickRepliesForMode(state.currentMode || 'normal'),
    analysis,
  };
}

async function processScheduledTriggers(firestoreDb = db) {
  if (firestoreDb) db = firestoreDb;
  const usersSnap = await db.collection('wellness_users').limit(500).get();
  const now = nowIso();

  await Promise.all(
    usersSnap.docs.map(async userDoc => {
      const userId = userDoc.id;
      const user = userDoc.data() || {};
      const dueSnap = await scheduledRef(userId)
        .where('status', '==', 'pending')
        .where('triggerAt', '<=', now)
        .orderBy('triggerAt', 'asc')
        .limit(10)
        .get();

      await Promise.all(
        dueSnap.docs.map(async triggerDoc => {
          const trigger = triggerDoc.data();
          if (trigger.agentId !== 'vita') return;
          const actionDoc = trigger.actionId ? await actionsRef(userId).doc(trigger.actionId).get() : null;
          const action = actionDoc?.exists ? actionDoc.data() : null;
          if (action && action.status !== 'active') {
            await triggerDoc.ref.update({status: 'skipped', skippedAt: nowIso()});
            return;
          }

          const mode = trigger.contextMode || 'action_followup';
          const message = await saveMessage(userId, {
            role: 'agent',
            content: trigger.opener || action?.detail || `Hey ${user.name || 'there'} — quick VITA check-in.`,
            isProactive: true,
            contextMode: mode,
            triggerType: trigger.type,
            actionId: trigger.actionId || null,
            quickReplies: trigger.quickReplies || getQuickRepliesForMode(mode),
            survey: buildVitaCheckinSurvey(mode, action),
          });

          await triggerDoc.ref.update({status: 'sent', sentAt: nowIso(), messageId: message.id});
          await agentRef(userId).set(
            {
              currentMode: mode,
              lastProactiveAt: nowIso(),
              updatedAt: nowIso(),
            },
            {merge: true},
          );

          if (action) {
            await actionsRef(userId).doc(action.id).set(
              {
                lastTriggeredAt: nowIso(),
                status: trigger.resumeStatus || action.status,
                updatedAt: nowIso(),
              },
              {merge: true},
            );
            if (action.schedule?.kind === 'daily' || action.schedule?.kind === 'weekly') {
              await syncActionSchedule(userId, {...action, status: trigger.resumeStatus || action.status});
            }
          }

          if (user.fcmToken) {
            try {
              const admin = require('firebase-admin');
              await admin.messaging().send({
                token: user.fcmToken,
                notification: {
                  title: 'VITA',
                  body: message.content.slice(0, 120),
                },
                data: {
                  screen: 'Vita',
                  agentId: 'vita',
                  actionId: trigger.actionId || '',
                  actionType: trigger.type || '',
                  contextMode: mode,
                },
              });
            } catch (error) {
              console.error('VITA FCM error:', error.message);
            }
          }
        }),
      );
    }),
  );
}

async function maybeCreateAdaptiveAction(userId, actions, actionKey, draftFactory) {
  const hasExisting = actions.some(
    action => action.key === actionKey && ['active', 'snoozed'].includes(action.status),
  );
  if (hasExisting) return null;
  return upsertAction(userId, draftFactory());
}

async function runVitaNightlyAnalysis(firestoreDb = db) {
  if (firestoreDb) db = firestoreDb;
  const usersSnap = await db.collection('wellness_users').limit(500).get();
  await Promise.all(
    usersSnap.docs.map(async userDoc => {
      const userId = userDoc.id;
      const state = await getOrCreateVitaState(userId);
      if (!state.setupComplete) return;

      const actions = await getVitaActions(userId);
      const recentMessages = await getVitaMessages(userId, 24);
      const recentLogs = await getVitaLogs(userId, 30);
      const healthReplies = recentMessages
        .filter(msg => msg.role === 'user')
        .slice(-6);

      let cravingMentions = 0;
      let workoutMentions = 0;
      let mealMentions = 0;
      healthReplies.forEach(msg => {
        const lower = msg.content.toLowerCase();
        if (/craving|junk|stress eating|snack|binge/.test(lower)) cravingMentions += 1;
        if (/workout|gym|training|skip|session/.test(lower)) workoutMentions += 1;
        if (/protein|meal|overeating|portion|takeout/.test(lower)) mealMentions += 1;
      });

      const nextState = {
        ...state,
        currentRiskLevel: deriveSupportRisk(state.profile || {}, state),
        updatedAt: nowIso(),
      };
      if (cravingMentions >= 2) nextState.activeFocus = 'Craving moments still need an earlier interrupt.';
      else if (workoutMentions >= 2) nextState.activeFocus = 'Workout follow-through still needs better protection before the excuse lands.';
      else if (mealMentions >= 2) nextState.activeFocus = 'Food execution still needs simpler decisions earlier in the day.';

      nextState.analysis = await generateVitaAnalysis(userId, nextState, recentMessages, actions, recentLogs);
      await agentRef(userId).set(
        {
          currentRiskLevel: nextState.currentRiskLevel,
          activeFocus: nextState.activeFocus || null,
          analysis: nextState.analysis,
          updatedAt: nextState.updatedAt,
        },
        {merge: true},
      );

      if (cravingMentions >= 2) {
        await maybeCreateAdaptiveAction(userId, actions, getActionKey('craving_reset'), () => ({
          key: getActionKey('craving_reset'),
          type: 'craving_reset',
          title: 'Craving Reset',
          subtitle: 'Open when cravings hit',
          detail: 'VITA added this because cravings still look like the fastest way the day goes off-plan.',
          reason: 'Added because recent signal still points back to cravings.',
          whyNow: 'Interrupting the urge earlier matters more than recovering after the overeating.',
          schedule: {kind: 'conditional', trigger: 'manual'},
          priority: 'high',
          successMetric: 'Break the craving loop earlier',
          source: 'adaptive_engine',
          confidence: 0.84,
          editable: false,
          status: 'active',
        }));
      }

      if (workoutMentions >= 2) {
        await maybeCreateAdaptiveAction(userId, actions, getActionKey('missed_workout_recovery'), () => ({
          key: getActionKey('missed_workout_recovery'),
          type: 'missed_workout_recovery',
          title: 'Missed Workout Recovery',
          subtitle: 'Open after a miss',
          detail: 'VITA added this because skipped sessions are starting to drag momentum more than they should.',
          reason: 'Added because recent signal still points back to missed training recovery.',
          whyNow: 'One miss becomes a pattern only if the recovery is weak.',
          schedule: {kind: 'conditional', trigger: 'manual'},
          priority: 'medium',
          successMetric: 'Recover faster after missed sessions',
          source: 'adaptive_engine',
          confidence: 0.82,
          editable: false,
          status: 'active',
        }));
      }
    }),
  );
}

router.get('/config', async (_req, res) => {
  res.json({
    success: true,
    config: VITA_SETUP_CONFIG,
    quickReplies: QUICK_REPLIES,
    actionTypes: ACTION_TYPE_META,
    actionFlows: VITA_ACTION_FLOWS,
  });
});

router.get('/state/:userId', async (req, res) => {
  try {
    const {userId} = req.params;
    await getOrCreateUser(userId);
    const payload = await buildVitaStatePayload(userId);
    res.json(payload);
  } catch (error) {
    res.status(500).json({success: false, error: error.message});
  }
});

router.get('/analysis/:userId', async (req, res) => {
  try {
    const {userId} = req.params;
    const state = await getOrCreateVitaState(userId);
    const [messages, actions, logs] = await Promise.all([
      getVitaMessages(userId, 40),
      getVitaActions(userId),
      getVitaLogs(userId, 40),
    ]);
    const analysis = state.analysis || (await generateVitaAnalysis(userId, state, messages, actions, logs));
    if (!state.analysis) {
      await agentRef(userId).set({analysis, updatedAt: nowIso()}, {merge: true});
    }
    res.json({success: true, analysis});
  } catch (error) {
    res.status(500).json({success: false, error: error.message});
  }
});

router.post('/setup', async (req, res) => {
  try {
    const {userId, userName, answers} = req.body;
    if (!userId || !answers) {
      return res.status(400).json({success: false, error: 'userId and answers are required'});
    }

    await getOrCreateUser(userId, userName);
    const profile = {...answers};
    const starterActions = [];
    for (const draft of buildStarterActionTemplates(profile)) {
      starterActions.push(await upsertAction(userId, draft));
    }

    const statePatch = {
      setupComplete: true,
      setupProgress: VITA_SETUP_CONFIG.questions.length,
      setupAnswers: answers,
      profile,
      activeFocus: profile.priority || 'Execute the next best health move consistently',
      currentMode: 'normal',
      currentRiskLevel: deriveSupportRisk(profile),
      updatedAt: nowIso(),
    };
    await agentRef(userId).set(statePatch, {merge: true});

    const starterMessage =
      (await generateSetupMessage(userName, profile, starterActions)) ||
      `Your pattern is clear enough to start acting on. I already built a few VITA systems around ${profile.goal_type?.toLowerCase() || 'your health goal'}. Where does your day usually drift first?`;

    const existingMessages = await getVitaMessages(userId, 5);
    let firstMessage = existingMessages.find(msg => msg.isFirstMessage);
    if (!firstMessage) {
      firstMessage = await saveMessage(userId, {
        role: 'agent',
        content: starterMessage,
        isFirstMessage: true,
        contextMode: 'normal',
        quickReplies: getQuickRepliesForMode('normal'),
      });
    }

    const starterState = await getOrCreateVitaState(userId);
    const [starterMessages, starterLogs] = await Promise.all([
      getVitaMessages(userId, 20),
      getVitaLogs(userId, 20),
    ]);
    const starterAnalysis = await generateVitaAnalysis(userId, starterState, starterMessages, starterActions, starterLogs);
    await agentRef(userId).set({analysis: starterAnalysis, updatedAt: nowIso()}, {merge: true});

    const payload = await buildVitaStatePayload(userId);
    res.json({
      ...payload,
      starterPlan: buildStarterPlanSummary(starterActions),
      starterMessage: firstMessage,
    });
  } catch (error) {
    console.error('VITA setup error:', error);
    res.status(500).json({success: false, error: error.message});
  }
});

router.post('/chat', async (req, res) => {
  try {
    const {userId, userName, message, contextMode = 'normal', structuredCheckin = null} = req.body;
    if (!userId || !message) {
      return res.status(400).json({success: false, error: 'userId and message are required'});
    }

    await getOrCreateUser(userId, userName);
    const state = await getOrCreateVitaState(userId);
    const profile = state.profile || {};
    const [history, actions] = await Promise.all([getVitaMessages(userId, 40), getVitaActions(userId)]);

    const normalizedMessage = structuredCheckin ? summarizeVitaStructuredCheckin(structuredCheckin) : message;
    const resolvedMode = inferModeFromMessage(normalizedMessage, contextMode || state.currentMode || 'normal');
    const userMsg = await saveMessage(userId, {
      role: 'user',
      content: normalizedMessage,
      contextMode: resolvedMode,
      structuredCheckin,
    });

    let updatedState = state;
    let storedCheckin = null;
    if (
      [
        'morning_weighin',
        'protein_rescue',
        'craving_reset',
        'before_meal',
        'workout_lock_in',
        'missed_workout',
        'evening_closeout',
        'weekly_review',
      ].includes(resolvedMode)
    ) {
      updatedState = await processVitaCheckinReply(userId, normalizedMessage, structuredCheckin);
      if (structuredCheckin) {
        storedCheckin = await storeVitaCheckin(
          userId,
          {...structuredCheckin, contextMode: resolvedMode},
          resolvedMode,
          userMsg.id,
          profile,
        );
      }
    }

    const actionDecision = await decideActionChanges(normalizedMessage, profile, updatedState, actions, resolvedMode);
    const createdActions = [];
    for (const change of actionDecision.changes) {
      if (change.type === 'create') {
        createdActions.push(await upsertAction(userId, change.action));
      }
    }

    const reply = await generateChatReply({
      profile,
      state: {...updatedState, currentMode: actionDecision.mode || resolvedMode},
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
        {merge: true},
      );
      if (structuredCheckin?.actionId) {
        await actionsRef(userId).doc(structuredCheckin.actionId).set(
          {
            lastUsedAt: nowIso(),
            lastLogId: storedCheckin.id,
            lastUserResponse:
              structuredCheckin.userChoice ||
              structuredCheckin.desired_outcome ||
              structuredCheckin.support_need ||
              'used',
            updatedAt: nowIso(),
          },
          {merge: true},
        );
      }
    }

    await agentRef(userId).set(
      {
        conversationCount: (state.conversationCount || 0) + 1,
        currentMode: 'normal',
        lastInteractionAt: nowIso(),
        updatedAt: nowIso(),
        currentRiskLevel: deriveSupportRisk(profile, updatedState),
      },
      {merge: true},
    );

    const latestState = await getOrCreateVitaState(userId);
    const [latestMessages, latestActions, latestLogs] = await Promise.all([
      getVitaMessages(userId, 30),
      getVitaActions(userId),
      getVitaLogs(userId, 30),
    ]);
    const analysis = await generateVitaAnalysis(userId, latestState, latestMessages, latestActions, latestLogs);
    await agentRef(userId).set({analysis, updatedAt: nowIso()}, {merge: true});

    const payload = await buildVitaStatePayload(userId);
    res.json({
      ...payload,
      userMessage: userMsg,
      agentMessage: agentMsg,
      actionChanges: createdActions,
    });
  } catch (error) {
    console.error('VITA chat error:', error);
    res.status(500).json({success: false, error: error.message});
  }
});

router.get('/actions/:userId', async (req, res) => {
  try {
    const {userId} = req.params;
    const state = await getOrCreateVitaState(userId);
    if (state.setupComplete) {
      await ensureCoreVitaActions(userId, state.profile || {});
    }
    const actions = await getVitaActions(userId);
    res.json({
      success: true,
      actions,
      actionGroups: groupActions(actions.filter(action => action.status !== 'deleted' && action.status !== 'expired')),
    });
  } catch (error) {
    res.status(500).json({success: false, error: error.message});
  }
});

router.patch('/actions/:userId/:actionId', async (req, res) => {
  try {
    const {userId, actionId} = req.params;
    const {operation, time} = req.body;
    const state = await getOrCreateVitaState(userId);
    if (state.setupComplete) {
      await ensureCoreVitaActions(userId, state.profile || {});
    }
    const doc = await actionsRef(userId).doc(actionId).get();
    if (!doc.exists) return res.status(404).json({success: false, error: 'Action not found'});

    const action = doc.data();
    if (action.agentId !== 'vita') {
      return res.status(400).json({success: false, error: 'Not a VITA action'});
    }

    const patch = {updatedAt: nowIso()};
    if (operation === 'pause') patch.status = 'paused';
    else if (operation === 'resume') patch.status = 'active';
    else if (operation === 'complete') {
      patch.completedAt = nowIso();
      patch.lastCompletedAt = nowIso();
      patch.lastUserResponse = 'completed_today';
      patch.status = action.schedule && ['daily', 'weekly'].includes(action.schedule.kind) ? 'active' : 'completed';
    } else if (operation === 'delete') {
      patch.status = 'deleted';
    } else if (operation === 'snooze') {
      patch.status = 'active';
      patch.snoozeCount = (action.snoozeCount || 0) + 1;
      patch.lastUserResponse = 'snoozed_today';
    } else if (operation === 'edit_time') {
      if (!time) return res.status(400).json({success: false, error: 'time required for edit_time'});
      patch.schedule = {...(action.schedule || {}), time};
      patch.status = 'active';
      patch.lastUserResponse = `time_edited:${time}`;
      patch.subtitle = action.schedule?.kind === 'weekly' ? `${state.profile?.review_day || 'Sunday'} · ${time}` : time;
    } else {
      return res.status(400).json({success: false, error: 'Unsupported operation'});
    }

    const next = {...action, ...patch};
    await doc.ref.set(next, {merge: true});

    if (operation === 'snooze') {
      await scheduleSnoozedTrigger(userId, next, 20);
    } else if (operation === 'complete' && action.schedule && ['daily', 'weekly'].includes(action.schedule.kind)) {
      await syncActionSchedule(userId, next);
    } else if (['pause', 'complete', 'delete'].includes(operation)) {
      const pendingSnap = await scheduledRef(userId).where('status', '==', 'pending').get();
      await Promise.all(
        pendingSnap.docs
          .filter(scheduledDoc => {
            const data = scheduledDoc.data();
            return data.agentId === 'vita' && data.actionId === actionId;
          })
          .map(scheduledDoc => scheduledDoc.ref.delete()),
      );
    } else {
      await syncActionSchedule(userId, next);
    }

    res.json({success: true, action: next});
  } catch (error) {
    res.status(500).json({success: false, error: error.message});
  }
});

router.post('/process-scheduled', async (_req, res) => {
  try {
    await processScheduledTriggers(db);
    res.json({success: true});
  } catch (error) {
    res.status(500).json({success: false, error: error.message});
  }
});

router.post('/run-daily/:userId', async (req, res) => {
  try {
    const {userId} = req.params;
    const state = await getOrCreateVitaState(userId);
    await runVitaNightlyAnalysis(db);
    res.json({success: true, state});
  } catch (error) {
    res.status(500).json({success: false, error: error.message});
  }
});

module.exports = {
  router,
  setDb,
  processScheduledTriggers,
  runVitaNightlyAnalysis,
  buildVitaLiveContext,
  processVitaCheckinReply,
  VITA_SETUP_CONFIG,
  VITA_IDENTITY,
};
