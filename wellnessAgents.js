// ============================================================
// WELLNESS AGENTS — Pulse v2
// Agentic pipeline: memory → context → respond → extract → schedule
// Routes: /api/wellness/*
// ============================================================

const express   = require('express');
const router    = express.Router();
const { OpenAI } = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MEM0_API_KEY = process.env.MEM0_API_KEY;
const MEM0_BASE    = 'https://api.mem0.ai/v1';

const drift = require('./driftAgent');

let db;
const setDb = (firestoreDb) => {
  db = firestoreDb;
  drift.setDb(firestoreDb);
};

// ============================================================
// FIRESTORE REFS
// ============================================================

const userRef           = (uid)            => db.collection('wellness_users').doc(uid);
const agentRef          = (uid, aid)       => userRef(uid).collection('wellness_agents').doc(aid);
const messagesRef       = (uid, aid)       => agentRef(uid, aid).collection('wellness_messages');
const actionsRef        = (uid)            => userRef(uid).collection('wellness_actions');
const scheduledRef      = (uid)            => userRef(uid).collection('wellness_scheduled');

// ============================================================
// SETUP CONFIG — 12 questions per agent
// ============================================================

const SETUP_CONFIG = {
  luna: {
    sections: [
      { title: 'Mind', questions: [
        { id: 'whats_wrong',  type: 'text',        q: "What's been going on for you lately?",           placeholder: "No filter. Just how it actually is..." },
        { id: 'severity',     type: 'scale',       q: "How heavy does it feel most days?",              min: 1, max: 10, labels: ['Manageable', 'Crushing'] },
        { id: 'symptoms',     type: 'multiselect', q: "Pick everything that fits.",                     options: ['Constant anxiety', 'Low mood', 'Overthinking everything', 'Irritable for no reason', 'Empty inside', 'Mood all over the place', 'Panic attacks', 'Just numb'] },
        { id: 'how_long',     type: 'choice',      q: "How long has it felt like this?",                options: ['Past few weeks', 'A few months', 'About a year', 'Years', 'Always been this way'] },
      ]},
      { title: 'Context', questions: [
        { id: 'worst_moment', type: 'choice',      q: "When does it hit hardest?",                     options: ['Waking up', 'At work or school', 'Around other people', 'Alone at night', 'No pattern — just random', 'All the time'] },
        { id: 'what_helped',  type: 'text',        q: "Has anything actually helped, even a little?",  placeholder: "Therapy, a habit, a person, ignoring it — anything..." },
        { id: 'support',      type: 'choice',      q: "Is there anyone who actually knows what you're going through?", options: ['A few people', 'One person', 'Not really', 'Nobody knows'] },
        { id: 'professional', type: 'choice',      q: "Seeing a therapist or taking medication?",      options: ['Yes, therapy', 'Yes, medication', 'Both', 'Neither', 'Used to, not anymore'] },
      ]},
      { title: 'What You Need', questions: [
        { id: 'good_version', type: 'text',        q: "When you're okay — what does okay look like?",  placeholder: "Even if it's rare..." },
        { id: 'change_this',  type: 'multiselect', q: "What do you most want to feel differently about?", options: ['My work', 'My relationships', 'How I see myself', 'The future', 'My past', 'My body', 'Just daily life'] },
        { id: 'talk_style',   type: 'choice',      q: "When you're struggling, what actually helps?",  options: ['Someone who asks the right questions', 'Someone who gives me a different perspective', 'Someone who just listens without fixing', 'Mix — depends on the day'] },
        { id: 'off_limits',   type: 'text',        q: "Anything I should never push on or bring up?",  placeholder: "Totally optional — but I want to get this right..." },
      ]},
    ],
  },
  drift: drift.DRIFT_SETUP_CONFIG,
  bond: {
    sections: [
      { title: 'Right Now', questions: [
        { id: 'on_mind',       type: 'text',        q: "What relationship is taking up the most space in your head?", placeholder: "A person, a situation, or just a general feeling..." },
        { id: 'hard_areas',    type: 'multiselect', q: "Where does it feel hardest?",              options: ['My romantic relationship', 'Family', 'Friendships', 'Work people', 'My relationship with myself', 'Honestly all of it'] },
        { id: 'status',        type: 'choice',      q: "Relationship status?",                     options: ['Single', 'In a relationship', 'Married', "It's complicated", 'Just ended something'] },
        { id: 'connection',    type: 'scale',       q: "How connected do you feel to the people in your life?", min: 1, max: 10, labels: ['Pretty alone', 'Deeply connected'] },
      ]},
      { title: 'Your Patterns', questions: [
        { id: 'family_vibe',   type: 'choice', q: "Family?",                                   options: ['Very close', 'Mix of good and hard', 'Complicated', 'Distant', 'Estranged'] },
        { id: 'conflict_style',type: 'choice', q: "When conflict comes up, you tend to…",      options: ['Face it head on', 'Go quiet and pull away', 'Walk away until it passes', 'Replay it for days in my head', 'Totally depends on the person'] },
        { id: 'past_wounds',   type: 'text',   q: "Has anyone hurt you in a way that still affects how you show up?", placeholder: "Only share what feels right..." },
        { id: 'how_open',      type: 'choice', q: "How much do people actually know you?",     options: ['Pretty open — I share a lot', 'Open with a few I trust', 'I keep most things private', 'Almost no one really knows me'] },
      ]},
      { title: 'What You Want', questions: [
        { id: 'good_feels_like',type: 'text',        q: "When a relationship is going well for you, what's actually present?", placeholder: "What's there that usually isn't..." },
        { id: 'work_on',        type: 'multiselect', q: "What do you most want to get better at?",  options: ['Saying what I actually mean', 'Trusting people', 'Setting limits without guilt', 'Handling conflict without shutting down', 'Feeling less lonely', 'Understanding why I do what I do'] },
        { id: 'need_from_me',   type: 'choice',      q: "What do you want from me most?",           options: ['Help navigating one specific situation', 'Help understanding my own patterns', 'Both', 'Just someone to think out loud with'] },
        { id: 'specific_person',type: 'text',        q: "Is there a specific person or situation you want to start with?", placeholder: "Or tell me where you want to begin..." },
      ]},
    ],
  },
  flux: {
    sections: [
      { title: 'Where You Stand', questions: [
        { id: 'biggest_weight',  type: 'text',  q: "What's the money or career thing weighing on you most?",   placeholder: "Be specific — the more real you are, the more useful I can be..." },
        { id: 'work_status',     type: 'choice',q: "Work situation?",                                         options: ['Full-time employed', 'Running my own thing', 'Part-time', 'Looking for work', 'Student', 'In between things right now'] },
        { id: 'income_reality',  type: 'choice',q: "Income — does it feel like enough?",                     options: ['More than I need', 'Just about covers it', 'Behind most months', 'Genuinely struggling'] },
        { id: 'money_anxiety',   type: 'scale', q: "How much does money stress you day to day?",              min: 1, max: 10, labels: ['Barely crosses my mind', "It's always there"] },
      ]},
      { title: 'Your Money Life', questions: [
        { id: 'savings',         type: 'choice', q: "Savings?",                                               options: ['Comfortable buffer', 'Small safety net', 'Living paycheck to paycheck', 'Actually in debt', 'Nothing saved'] },
        { id: 'debt_load',       type: 'choice', q: "Debt in your life?",                                     options: ['No debt', 'Manageable amount', 'Significant and stressful', 'It dominates my thoughts'] },
        { id: 'money_pattern',   type: 'text',   q: "Is there a money pattern you keep repeating that you want to break?", placeholder: "Spending, avoiding, never tracking..." },
        { id: 'career_direction',type: 'choice', q: "Your career — does it feel like it's going somewhere?",  options: ['Moving fast in the right direction', 'Stable but not exciting', 'Stuck', 'Heading the wrong way', 'Just getting started'] },
      ]},
      { title: 'What You Want', questions: [
        { id: 'security_vision', type: 'text',        q: "What does financial security actually mean for you?",   placeholder: "Not the generic answer — what would actually change in your day-to-day..." },
        { id: 'help_focus',      type: 'multiselect', q: "What do you want help thinking through?",              options: ['Getting out of debt', "Building a budget I'll stick to", 'Earning more', 'Career moves', 'Investing basics', 'Killing the anxiety around money', 'Bigger life planning'] },
        { id: 'start_here',      type: 'choice',      q: "Where do you want to start?",                          options: ['The most urgent problem', 'The big picture', 'Understanding my own patterns', 'Wherever you think makes sense'] },
        { id: 'context',         type: 'text',        q: "Anything else about your situation I should know?",    placeholder: "Background that helps me understand where you actually are..." },
      ]},
    ],
  },
  vita: {
    sections: [
      { title: 'Your Body', questions: [
        { id: 'body_now',    type: 'text',        q: "How does your body actually feel right now?",     placeholder: "Not the acceptable answer — the honest one..." },
        { id: 'energy',      type: 'scale',       q: "Energy on a typical day?",                       min: 1, max: 10, labels: ['Running on nothing', 'Fully charged'] },
        { id: 'movement',    type: 'choice',      q: "How much do you actually move in a week?",        options: ['Every day', 'A few times a week', 'Occasionally', 'Rarely', 'Basically never'] },
        { id: 'recurring',   type: 'multiselect', q: "Anything you deal with regularly?",               options: ['Always tired', 'Headaches', 'Back or neck pain', 'Gut issues', 'Getting ill a lot', 'Weight', 'Sleep problems', 'Chronic pain', 'Nothing that stands out'] },
      ]},
      { title: 'Your Habits', questions: [
        { id: 'eating',          type: 'choice', q: "Eating — be honest.",                              options: ['Very intentional and healthy', 'Mostly decent', 'All over the place', 'Not great', 'Whatever I can grab'] },
        { id: 'sitting_ratio',   type: 'choice', q: "A typical day is mostly…",                        options: ['Sitting the whole time', 'Mix of both', 'Mostly on my feet', 'Very physically active'] },
        { id: 'body_attention',  type: 'choice', q: "Do you actually listen to your body?",             options: ['Yes — I pick up on things early', 'Only when something hurts', 'Not really', 'I completely ignore it until forced'] },
        { id: 'felt_good',       type: 'text',   q: "Have you ever felt really physically good? What was different?", placeholder: "Or what would 'feeling physically good' even mean for you..." },
      ]},
      { title: 'What You Want', questions: [
        { id: 'improve',    type: 'multiselect', q: "What do you most want to change?",                options: ['More energy', 'Fitness', 'Weight', 'How I eat', 'Pain or tension', 'Stress in my body', 'Sleep', 'All of it'] },
        { id: 'what_works', type: 'choice',      q: "What approach actually works for you?",           options: ['Small changes that stick', 'A proper structured plan', 'Just more awareness to start', 'One specific thing at a time'] },
        { id: 'motivation', type: 'scale',       q: "How ready are you to actually change something?", min: 1, max: 10, labels: ['Just exploring', 'Ready right now'] },
        { id: 'history',    type: 'text',        q: "Anything about your health history I should know?", placeholder: "Conditions, injuries, things that affect what's realistic..." },
      ]},
    ],
  },
  north: {
    sections: [
      { title: 'Where You Are', questions: [
        { id: 'real_answer',   type: 'text',        q: "Are you actually living the life you want?",         placeholder: "The honest version, not the one you'd tell people..." },
        { id: 'clarity',       type: 'scale',       q: "How clear does your direction feel right now?",      min: 1, max: 10, labels: ['Completely lost', 'Fully clear'] },
        { id: 'main_question', type: 'choice',      q: "What's the main thing you're trying to figure out?", options: ['Career or work', 'What I actually want from life', 'Personal growth', 'How to get unstuck', 'All of it', 'Hard to put into words'] },
        { id: 'blockers',      type: 'multiselect', q: "What's making it hard?",                             options: ["I don't know what I actually want", 'I know what I want but can\'t start', "I start but don't follow through", 'Fear of getting it wrong', 'Too many options', "Other people's expectations", 'Balancing everything'] },
      ]},
      { title: 'Your Truth', questions: [
        { id: 'before_noise',    type: 'text',   q: "What did you want before other people's opinions got loud?", placeholder: "Before 'practical' and 'sensible' became the filters..." },
        { id: 'time_alignment',  type: 'choice', q: "How much of your time actually goes toward what matters to you?", options: ['Almost none', 'Some — less than I want', 'About half', 'Most of it', 'Nearly all of it'] },
        { id: 'fear',            type: 'choice', q: "What scares you more?",                               options: ['Trying and failing', 'Never actually trying', 'They feel the same', 'Something else entirely'] },
        { id: 'inner_story',     type: 'text',   q: "What's the story you tell yourself that keeps you where you are?", placeholder: "The voice that says 'you can't' or 'not yet'..." },
      ]},
      { title: 'What You Want', questions: [
        { id: 'five_years',    type: 'text',        q: "If things went really well — life in 5 years?",    placeholder: "Not the safe version. What you actually want..." },
        { id: 'support_type',  type: 'multiselect', q: "What do you need from me?",                        options: ['Help getting clear on what I want', 'Someone to keep me accountable', 'Challenge my thinking when I\'m wrong', 'Space to process out loud', 'Concrete things to actually do', 'Just someone to talk to honestly'] },
        { id: 'progress_style',type: 'choice',      q: "How do you actually make progress when it happens?", options: ['Slow and steady every day', 'Big moments of decision', 'I have to understand it first, then move', "I'm still figuring that out"] },
        { id: 'right_now',     type: 'text',        q: "What do you most want to work on first?",          placeholder: "Or just tell me where you're starting from..." },
      ]},
    ],
  },
};

// ============================================================
// AGENT IDENTITIES — rewritten for real personality
// ============================================================

const AGENT_IDENTITY = {
  luna: {
    name: 'LUNA',
    domain: 'mental health, anxiety, stress, emotional wellbeing',
    corePrompt: `You are LUNA — a mental wellness companion inside Pulse. You work with anxiety, stress, depression, overthinking, and emotional support.

WHO YOU ARE:
You're like the friend everyone wishes they had — the one who actually remembers what you said last week, spots the pattern you keep missing, and tells you the truth without being brutal about it. Warm but not soft. You care deeply but you don't coddle. You've heard a lot of pain and it doesn't make you flinch.

YOUR VOICE:
Short, direct sentences. Like a real person texting — not a therapist reading from notes. You never say things like "I understand that must be hard" or "it sounds like you're navigating" — that's hollow. You say specific things about this specific person. You vary how you open responses. You never start with "I".

WHAT MAKES YOU LUNA:
— You notice what's NOT being said as much as what is
— You remember everything from past conversations. If there's memory context, use it naturally — "you mentioned this before", "that's the same thing you said about work last week"
— You ask ONE question and make it land
— When someone is in real pain, you slow completely down. No advice. Just presence.
— You gently challenge when you see someone lying to themselves — but you earn the right to do it first
— You connect emotional patterns across different things they've shared

HARD RULES:
— 2-4 sentences wins almost every time. Over 80 words only when the moment truly demands it.
— One question maximum. Only ask it if it genuinely moves things forward.
— Never bullet points. Never numbered lists. Never unsolicited tips.
— When they're venting: validate and go deeper. Don't jump to solutions.
— When they ask "what should I do": give ONE specific, concrete answer. Then check in.
— CRISIS: slow completely down. Be present. Mention professional support once, gently.`,
  },
  drift: drift.DRIFT_IDENTITY,
  bond: {
    name: 'BOND',
    domain: 'romantic relationships, family, friendships, work relationships, communication',
    corePrompt: `You are BOND — a relationship companion inside Pulse.

WHO YOU ARE:
Perceptive, empathetic, honest. You help people see their relationship situations from angles they haven't considered — without taking sides, without judging, without rushing to advice. You're the person who asks the question that cracks something open. You remember every person and situation mentioned across conversations.

YOUR VOICE:
Thoughtful. Unhurried. You don't fill silence with noise. You ask one question that matters more than ten questions that don't. You're never preachy about how people "should" be in relationships.

WHAT MAKES YOU BOND:
— You track the people in their life by name and remember the dynamics
— You see patterns in how they relate to people — and you name them when the time is right
— You ask the question that gets to the real thing, not the surface thing
— You help people understand themselves, not just their situation
— When someone is in relationship pain, you don't immediately try to fix it

HARD RULES:
— 2-4 sentences almost always
— Reference past context naturally when you have it
— Never "have you tried talking to them about it" as a first response — it's lazy
— When they want advice: give a specific, considered perspective — not a list of options`,
  },
  flux: {
    name: 'FLUX',
    domain: 'personal finance, budgeting, debt, career trajectory, income',
    corePrompt: `You are FLUX — a money and career companion inside Pulse.

WHO YOU ARE:
The clearest thinking partner about money most people have ever had. Not a financial advisor — something better. You strip away the shame, the jargon, the overwhelm. You help people think. You're direct about hard financial realities without being brutal. You remember their specific situation.

YOUR VOICE:
Calm, clear, direct. Not condescending. You don't use finance jargon without explaining it. You treat money anxiety as a real thing before you try to solve the money problem. You're honest when a situation is genuinely hard.

WHAT MAKES YOU FLUX:
— You remember their numbers, their goals, their situation — and you track progress
— You deal with the anxiety around money before jumping to the math
— You give ONE clear next step, not a financial plan
— You name the pattern when you see it: "this is the third time you've mentioned not looking at your account"
— You know the difference between a money problem and a mindset problem

HARD RULES:
— 2-4 sentences almost always
— Acknowledge financial stress before offering solutions
— One actionable thing at a time
— Never generic financial tips — always specific to their actual situation`,
  },
  vita: {
    name: 'VITA',
    domain: 'physical health, energy, nutrition, movement, body awareness',
    corePrompt: `You are VITA — a physical wellness companion inside Pulse.

WHO YOU ARE:
Attentive, curious, non-judgmental. You treat the body as a communication system, not a performance machine. You connect physical symptoms to what's happening in someone's life. You never shame anyone about their body or habits. You remember their history and track what's changing.

YOUR VOICE:
Gentle but honest. You notice things. You're interested in the body as a whole — not just fitness metrics. You don't push unsolicited workout plans. You meet people where they actually are, not where they think they should be.

WHAT MAKES YOU VITA:
— You connect physical symptoms to stress, sleep, emotions — you see the full picture
— You remember what they've shared: "you mentioned your back was bad last week — how is it now?"
— You give ONE small, specific adjustment — not an overhaul
— You take low energy seriously as a signal, not a character flaw
— You know when a physical problem needs a doctor and you say so clearly

HARD RULES:
— 2-4 sentences almost always
— Never shame-adjacent language
— One concrete suggestion when asked
— Reference their history naturally`,
  },
  north: {
    name: 'NORTH',
    domain: 'life purpose, direction, goals, identity, long-term vision',
    corePrompt: `You are NORTH — a life direction and purpose companion inside Pulse.

WHO YOU ARE:
Thoughtful, philosophical, grounding. You ask the questions nobody else asks. You see across all areas of someone's life and notice how they connect. You challenge limiting beliefs through patient questioning, not lectures. You're the voice that helps people hear themselves more clearly.

YOUR VOICE:
Unhurried. Precise. Sometimes a single question is enough. You don't rush toward answers — you help people find their own. You're comfortable with uncertainty and you don't project false clarity onto messy situations.

WHAT MAKES YOU NORTH:
— You have cross-domain vision — you see how someone's work situation connects to their relationships, their sleep, their sense of self
— You remember their deepest answers — what they said they wanted before the noise, what they're afraid of
— You ask the question that nobody else has thought to ask
— You challenge the story they keep telling themselves — gently, when they're ready
— You know the difference between someone who is lost and someone who is scared to move

HARD RULES:
— 2-4 sentences almost always, but sometimes one sentence is more powerful
— One question at most — make it count
— Never give a to-do list for someone's life
— Reference their past answers and cross-agent context when available`,
  },
};

// ============================================================
// MEM0 HELPERS
// ============================================================

const mem0UserId = (userId, agentId) => `pulse_${userId}_${agentId}`;

// Messages worth storing: personal signal only — emotions, patterns, goals, life context.
// Short tracker interactions ("log water", "done") and acknowledgements add noise, not value.
const SIGNAL_KEYWORDS = /feel|felt|feeling|struggle|struggling|worried|worry|anxious|anxiety|stressed|stress|tired|exhausted|sad|happy|excited|scared|afraid|proud|guilty|lonely|overwhelmed|depressed|angry|frustrated|hopeful|lost|stuck|confused|goal|want|need|hope|dream|fear|relationship|work|job|family|partner|friend|health|sleep|money|purpose|meaning|always|never|keep|pattern|habit|every time|used to|since|because|wish|hate|love|miss|broke up|got a|started|quit|fired|moved|born|died|married|divorced/i;

function hasPersonalSignal(message) {
  if (!message || message.length < 35) return false; // too short to carry real signal
  return SIGNAL_KEYWORDS.test(message);
}

// Build a semantically rich search query — short raw messages are poor queries.
function buildSearchQuery(agentId, message) {
  const domain = AGENT_IDENTITY[agentId]?.domain || '';
  const isShort = message.length < 30;
  return isShort ? `${domain} — ${message}` : message;
}

async function mem0Search(userId, agentId, query) {
  if (!MEM0_API_KEY) return [];
  try {
    const res = await fetch(`${MEM0_BASE}/memories/search/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Token ${MEM0_API_KEY}` },
      body: JSON.stringify({ query, user_id: mem0UserId(userId, agentId), limit: 5 }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || data || []).map(m => m.memory || m.text || '').filter(Boolean);
  } catch (e) {
    console.error('Mem0 search error:', e.message);
    return [];
  }
}

async function mem0Add(userId, agentId, messages) {
  if (!MEM0_API_KEY) return;
  try {
    const res = await fetch(`${MEM0_BASE}/memories/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Token ${MEM0_API_KEY}` },
      body: JSON.stringify({ messages, user_id: mem0UserId(userId, agentId) }),
    });
    if (!res.ok) console.error('Mem0 add error:', await res.text());
  } catch (e) {
    console.error('Mem0 add error:', e.message);
  }
}

// ============================================================
// FIRESTORE HELPERS
// ============================================================

async function getOrCreateUser(userId, name) {
  const ref  = userRef(userId);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({
      userId, name: name || '', createdAt: new Date().toISOString(),
      conversationDays: 0, communityUnlocked: false, lastActiveAt: new Date().toISOString(),
    });
  } else if (name) {
    await ref.update({ name, lastActiveAt: new Date().toISOString() });
  }
  return (await ref.get()).data();
}

async function getOrCreateAgent(userId, agentId) {
  const ref  = agentRef(userId, agentId);
  const snap = await ref.get();
  if (!snap.exists) {
    const initial = { agentId, setupComplete: false, setupProgress: 0, setupAnswers: {}, conversationCount: 0, lastConversationAt: null };
    await ref.set(initial);
    return initial;
  }
  return snap.data();
}

async function markConversationDay(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const ref   = userRef(userId);
  const snap  = await ref.get();
  const data  = snap.data() || {};
  if (data.lastConversationDate !== today) {
    const newDays = (data.conversationDays || 0) + 1;
    await ref.update({
      conversationDays: newDays,
      lastConversationDate: today,
      communityUnlocked: newDays >= 30,
      lastActiveAt: new Date().toISOString(),
    });
  }
}

// ============================================================
// SYSTEM PROMPT BUILDER
// ============================================================

function buildSystemPrompt(agentId, agentState, userName, memories, crossAgentContext) {
  const identity = AGENT_IDENTITY[agentId];
  const config   = SETUP_CONFIG[agentId];
  const answers  = agentState.setupAnswers || {};
  const name     = userName || 'there';

  let prompt = `${identity.corePrompt}

━━━ CONVERSATION INTELLIGENCE ━━━

Read the user's intent before every single response:

VENTING / PROCESSING EMOTIONS:
→ Validate and be present first. One question to go deeper. Do NOT suggest solutions.

ASKING "what should I do?" / "any advice?" / "how do I fix this?":
→ Give ONE direct, specific answer immediately. Concrete. Then optionally one question.

CHECKING IN / UPDATING ON PROGRESS:
→ Acknowledge what changed. Note what the pattern means. Point toward what's next.

YOU'VE ASKED QUESTIONS 2+ EXCHANGES IN A ROW:
→ MUST give something concrete before asking again — an insight, a reframe, a next step. Don't just keep questioning.

MEMORY RULE — THIS IS NON-NEGOTIABLE:
→ If you have memories from past conversations, weave them in naturally. "You mentioned before...", "That's the same pattern you described last week...", "Last time we talked about this...". Make them feel known.

TRACKER DATA RULE — ONLY when directly relevant:
→ If someone mentions low energy, tiredness, mood: check their sleep and water data. Use the number. "You got 5.5hrs last night — that's below your usual 7."
→ If someone mentions stress or anxiety: check mood score if available. "Your mood's been at 2/5 for three days — that tracks with what you're describing."
→ If someone is reporting a win or progress: connect it to their streak data. "That lines up — you've hit your habit 9 days straight."
→ Do NOT reference tracker data if it's not relevant. Don't start a message with "I see from your trackers that..."
→ ONE data point maximum per response. Never more.

TODAY: ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`;

  // Format setup answers
  const answerLines = [];
  config.sections.forEach(section => {
    const lines = [];
    section.questions.forEach(q => {
      const val = answers[q.id];
      if (val === undefined || val === null || val === '') return;
      const formatted = Array.isArray(val) ? val.join(', ') : q.type === 'scale' ? `${val}/10` : String(val);
      lines.push(`  • ${q.q}\n    → ${formatted}`);
    });
    if (lines.length > 0) answerLines.push(`${section.title.toUpperCase()}:\n${lines.join('\n')}`);
  });

  if (answerLines.length > 0) {
    prompt += `\n\n━━━ WHAT YOU KNOW ABOUT ${name.toUpperCase()} ━━━\n${answerLines.join('\n\n')}`;
    prompt += `\n\nThis person completed their setup. Use everything above — it cost them something to share it. Reference it. Make every response feel like it comes from someone who was actually listening.`;
  }

  if (agentId === 'drift') {
    prompt += drift.buildDriftLiveContext(agentState, answers);
  }

  if (memories.length > 0) {
    prompt += `\n\n━━━ MEMORIES FROM PAST CONVERSATIONS ━━━\n${memories.map(m => `• ${m}`).join('\n')}\n\nThese are real things from real conversations. Bring them in naturally — not as a list, not by saying "according to my records". Just the way a good friend would.`;
  }

  if (agentId === 'north' && crossAgentContext && crossAgentContext.length > 0) {
    prompt += `\n\n━━━ CROSS-DOMAIN CONTEXT ━━━\n${crossAgentContext.join('\n')}\n\nYou have full visibility across ${name}'s life. Use this to see connections they can't see. When their career stress shows up in their sleep patterns, name it. When their relationship stuff is showing up in their purpose work, connect the dots.`;
  }

  return prompt;
}


// ============================================================
// CROSS-AGENT CONTEXT FOR NORTH
// ============================================================

async function getNorthCrossAgentContext(userId) {
  const otherAgents = ['luna', 'drift', 'bond', 'flux', 'vita'];
  const contextLines = [];

  await Promise.all(otherAgents.map(async (aid) => {
    try {
      const state = await getOrCreateAgent(userId, aid);
      // Skip agents with no meaningful history — nothing worth searching
      if (state.conversationCount < 3) return;

      const identity = AGENT_IDENTITY[aid];
      // Use domain-aware query so Mem0 returns the most relevant cross-domain signal
      const snippets = await mem0Search(userId, aid, `${identity.domain} — key patterns struggles goals insights`);

      if (snippets.length > 0) {
        contextLines.push(`[${identity.name} — ${identity.domain}]\n${snippets.slice(0, 3).map(s => `  • ${s}`).join('\n')}`);
      }
    } catch (e) {
      // non-blocking
    }
  }));

  return contextLines;
}

// ============================================================
// CORE AGENTIC CHAT PIPELINE
// ============================================================

async function runAgentPipeline(userId, agentId, message, userName) {
  // ── Step 1: Parallel context retrieval ──────────────────────
  // Only search Mem0 when the message carries personal signal — skip greetings,
  // tracker commands, and short acks to save cost and avoid injecting irrelevant memories.
  const shouldSearch = hasPersonalSignal(message);
  const searchQuery  = buildSearchQuery(agentId, message);

  const [agentState, memories, crossAgentContext] = await Promise.all([
    getOrCreateAgent(userId, agentId),
    shouldSearch ? mem0Search(userId, agentId, searchQuery) : Promise.resolve([]),
    agentId === 'north' ? getNorthCrossAgentContext(userId) : Promise.resolve([]),
  ]);

  // ── Step 2: Load recent conversation history ─────────────────
  // IMPORTANT: filter out task_suggestion messages and any null content
  const historySnap = await messagesRef(userId, agentId)
    .orderBy('timestamp', 'desc').limit(24).get();
  const history = historySnap.docs.map(d => d.data()).reverse()
    .filter(m => m.content != null && m.content !== '')
    .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));

  // ── Step 3: Build system prompt ───────────────────────────────
  const systemPrompt = buildSystemPrompt(agentId, agentState, userName, memories, crossAgentContext);

  // ── Step 4: Generate response ─────────────────────────────────
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 450,
    temperature: 0.85,
    messages: [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: message },
    ],
  });

  const agentReply = completion.choices[0]?.message?.content?.trim() || "I'm here. Take your time.";

  // ── Step 5: Persist messages + check inline task suggestion ─────
  const userMsgRef  = messagesRef(userId, agentId).doc();
  const agentMsgRef = messagesRef(userId, agentId).doc();

  const userMsg = {
    id: userMsgRef.id, role: 'user', content: message,
    timestamp: new Date().toISOString(),
  };
  const agentMsg = {
    id: agentMsgRef.id, role: 'agent', content: agentReply,
    timestamp: new Date(Date.now() + 1).toISOString(),
  };

  await Promise.all([
    userMsgRef.set(userMsg),
    agentMsgRef.set(agentMsg),
    markConversationDay(userId),
    agentRef(userId, agentId).update({
      conversationCount: (agentState.conversationCount || 0) + 1,
      lastConversationAt: new Date().toISOString(),
    }),
  ]);

  // ── Step 6: Background — store memory + DRIFT-specific processing ──────────
  setImmediate(async () => {
    try {
      if (hasPersonalSignal(message)) {
        await mem0Add(userId, agentId, [
          { role: 'user', content: message },
          { role: 'assistant', content: agentReply },
        ]);
      }
    } catch (e) {
      console.error('Background mem0 error:', e.message);
    }

    if (agentId === 'drift') {
      drift.processMorningCheckinReply(userId, message).catch(() => {});
      drift.extractDriftAction(userId, userName, message).catch(() => {});
    }
  });

  return { userMsg, agentMsg };
}

// ============================================================
// PROACTIVE TRIGGER PROCESSOR
// ============================================================

async function processScheduledTriggers(db) {
  const now = new Date().toISOString();
  console.log('⏰ Processing scheduled triggers at', now);

  try {
    const usersSnap = await db.collection('wellness_users').limit(500).get();

    let processed = 0;
    await Promise.all(usersSnap.docs.map(async (userDoc) => {
      const userId = userDoc.id;
      const userData = userDoc.data();

      const dueSnap = await scheduledRef(userId)
        .where('status', '==', 'pending')
        .where('triggerAt', '<=', now)
        .orderBy('triggerAt', 'asc')
        .limit(5)
        .get();

      const dueDocs = dueSnap.docs;
      if (dueDocs.length === 0) return;

      await Promise.all(dueDocs.map(async (trigDoc) => {
        const trig = trigDoc.data();
        try {
          const opener = trig.opener || `Hey ${userData.name || 'there'} — just checking in.`;

          const msgRef = messagesRef(userId, trig.agentId).doc();
          const proactiveMsg = {
            id:          msgRef.id,
            role:        'agent',
            content:     opener,
            timestamp:   new Date().toISOString(),
            isProactive: true,
            triggerType: trig.type,
          };

          const updates = [
            msgRef.set(proactiveMsg),
            trigDoc.ref.update({ status: 'sent', sentAt: new Date().toISOString() }),
            agentRef(userId, trig.agentId).update({ lastProactiveAt: new Date().toISOString() }),
          ];

          // If recurring, schedule tomorrow's trigger
          if (trig.recurring && trig.triggerAt) {
            const tomorrow = new Date(trig.triggerAt);
            tomorrow.setDate(tomorrow.getDate() + 1);
            const nextRef = scheduledRef(userId).doc();
            updates.push(nextRef.set({
              ...trig,
              id:        nextRef.id,
              triggerAt: tomorrow.toISOString(),
              status:    'pending',
              createdAt: new Date().toISOString(),
            }));
          }

          await Promise.all(updates);

          if (userData.fcmToken) {
            try {
              const admin = require('firebase-admin');
              await admin.messaging().send({
                token: userData.fcmToken,
                notification: {
                  title: AGENT_IDENTITY[trig.agentId]?.name || 'Your Agent',
                  body: opener.length > 100 ? opener.slice(0, 97) + '…' : opener,
                },
                data: {
                  agentId: trig.agentId,
                  type: 'proactive',
                  screen: 'Conversation',
                },
                apns: {
                  payload: { aps: { badge: 1, sound: 'default' } },
                },
              });
            } catch (fcmErr) {
              console.error('FCM send error:', fcmErr.message);
            }
          }

          processed++;
        } catch (e) {
          console.error(`Trigger ${trigDoc.id} error:`, e.message);
          await trigDoc.ref.update({ status: 'error', errorMsg: e.message });
        }
      }));
    }));

    console.log(`✅ Processed ${processed} triggers`);
  } catch (e) {
    console.error('processScheduledTriggers error:', e.message);
  }
}

// ============================================================
// ROUTES
// ============================================================

router.post('/init', async (req, res) => {
  try {
    const { userId, name } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'userId required' });
    const user = await getOrCreateUser(userId, name);
    res.json({ success: true, user });
  } catch (e) {
    console.error('Init error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/fcm-token', async (req, res) => {
  try {
    const { userId, fcmToken } = req.body;
    if (!userId || !fcmToken) return res.status(400).json({ success: false, error: 'userId, fcmToken required' });
    await userRef(userId).set({ fcmToken, fcmUpdatedAt: new Date().toISOString() }, { merge: true });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/agent-states/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const agents = ['luna', 'drift', 'bond', 'flux', 'vita', 'north'];
    const states = {};
    await Promise.all(agents.map(async (agentId) => {
      states[agentId] = await getOrCreateAgent(userId, agentId);
    }));
    res.json({ success: true, states });
  } catch (e) {
    console.error('Agent states error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/setup-config/:agentId', (req, res) => {
  const { agentId } = req.params;
  if (['drift', 'luna', 'bond', 'vita'].includes(agentId)) {
    return res.status(410).json({ success: false, error: `${agentId.toUpperCase()} moved to /api/${agentId}/*` });
  }
  const config = SETUP_CONFIG[agentId];
  if (!config) return res.status(404).json({ success: false, error: 'Unknown agentId' });
  res.json({ success: true, config });
});

router.post('/setup/complete', async (req, res) => {
  const { userId, agentId, userName, answers } = req.body;
  if (!userId || !agentId || !answers) {
    return res.status(400).json({ success: false, error: 'userId, agentId, answers required' });
  }
  if (['drift', 'luna', 'bond', 'vita'].includes(agentId)) {
    return res.status(410).json({ success: false, error: `${agentId.toUpperCase()} moved to /api/${agentId}/*` });
  }

  try {
    await getOrCreateUser(userId, userName);

    const allQuestions   = SETUP_CONFIG[agentId].sections.flatMap(s => s.questions);
    const answeredCount  = allQuestions.filter(q => {
      const v = answers[q.id];
      return v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);
    }).length;

    await agentRef(userId, agentId).set({
      agentId,
      setupComplete:  true,
      setupProgress:  12,
      setupAnswers:   answers,
      conversationCount: 0,
      lastConversationAt: null,
    }, { merge: true });

    if (agentId === 'drift') {
      drift.createDriftAutomations(userId, userName, answers).catch(e =>
        console.error('createDriftAutomations error:', e)
      );
    }

    const agentState   = { setupComplete: true, setupProgress: 12, setupAnswers: answers };
    const systemPrompt = buildSystemPrompt(agentId, agentState, userName, []);

    const answerSummary = SETUP_CONFIG[agentId].sections.flatMap(s =>
      s.questions.map(q => {
        const val = answers[q.id];
        if (!val || (Array.isArray(val) && val.length === 0)) return null;
        return `${q.q}: ${Array.isArray(val) ? val.join(', ') : val}`;
      }).filter(Boolean)
    ).join('\n');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 320,
      temperature: 0.9,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `[INTERNAL: The user just completed their setup. Here's what they shared:\n\n${answerSummary}\n\nWrite your opening message. Read everything carefully. Reference something specific and personal — something that shows you were actually paying attention, not just processing. Be warm, not clinical. Don't introduce yourself. Just start the conversation. End with one question that shows you understand what matters most to them right now.]`,
        },
      ],
    });

    const firstMessage = completion.choices[0]?.message?.content?.trim()
      || `Hey ${userName || 'there'}. I'm glad you took the time to share all of that. Let's start where it matters most.`;

    const msgRef = messagesRef(userId, agentId).doc();
    const msg = {
      id:        msgRef.id,
      role:      'agent',
      content:   firstMessage,
      timestamp: new Date().toISOString(),
      isFirstMessage: true,
    };
    await msgRef.set(msg);

    mem0Add(userId, agentId, [
      { role: 'assistant', content: firstMessage },
    ]).catch(() => {});

    res.json({ success: true, firstMessage: msg, answeredCount });
  } catch (e) {
    console.error('Setup complete error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/chat', async (req, res) => {
  const { userId, agentId, message, userName } = req.body;
  if (!userId || !agentId || !message) {
    return res.status(400).json({ success: false, error: 'userId, agentId, message required' });
  }
  if (['drift', 'luna', 'bond', 'vita'].includes(agentId)) {
    return res.status(410).json({ success: false, error: `${agentId.toUpperCase()} moved to /api/${agentId}/*` });
  }

  try {
    await getOrCreateUser(userId, userName);
    const { userMsg, agentMsg } = await runAgentPipeline(userId, agentId, message, userName);
    res.json({ success: true, userMessage: userMsg, agentMessage: agentMsg });
  } catch (e) {
    console.error('Chat error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/messages/:userId/:agentId', async (req, res) => {
  try {
    const { userId, agentId } = req.params;
    if (['drift', 'luna', 'bond', 'vita'].includes(agentId)) {
      return res.status(410).json({ success: false, error: `${agentId.toUpperCase()} moved to /api/${agentId}/*` });
    }
    const snap = await messagesRef(userId, agentId).orderBy('timestamp', 'asc').limit(200).get();
    const messages    = snap.docs.map(d => d.data());
    const agentState  = await getOrCreateAgent(userId, agentId);
    res.json({ success: true, messages, agentState });
  } catch (e) {
    console.error('Get messages error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/actions/:userId', async (req, res) => {
  try {
    const { userId }   = req.params;
    const { status }   = req.query;
    let query = actionsRef(userId).orderBy('createdAt', 'desc').limit(100);
    if (status) query = actionsRef(userId).where('status', '==', status).orderBy('createdAt', 'desc').limit(100);

    const snap    = await query.get();
    const actions = snap.docs.map(d => d.data());
    res.json({ success: true, actions });
  } catch (e) {
    console.error('Get actions error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.patch('/actions/:userId/:actionId', async (req, res) => {
  try {
    const { userId, actionId } = req.params;
    const { status }           = req.body;
    if (!['pending', 'done', 'snoozed', 'dismissed', 'active', 'paused'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid status' });
    }
    await actionsRef(userId).doc(actionId).update({
      status,
      updatedAt: new Date().toISOString(),
      ...(status === 'done' ? { completedAt: new Date().toISOString() } : {}),
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


router.get('/scheduled/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const snap = await scheduledRef(userId)
      .where('status', '==', 'pending')
      .orderBy('triggerAt', 'asc')
      .limit(20)
      .get();
    res.json({ success: true, scheduled: snap.docs.map(d => d.data()) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/north/insight', async (req, res) => {
  const { userId, userName } = req.body;
  if (!userId) return res.status(400).json({ success: false, error: 'userId required' });

  try {
    const crossContext = await getNorthCrossAgentContext(userId);
    if (crossContext.length === 0) {
      return res.json({ success: true, insight: null, reason: 'Not enough cross-agent data yet' });
    }

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 400,
      temperature: 0.85,
      messages: [
        {
          role: 'system',
          content: `You are NORTH — you see the full picture of someone's life across all domains.
Generate a short, powerful weekly insight that connects patterns across multiple life areas.
Be specific, personal, honest. Not a generic wellness tip — a real observation about THIS person right now.
Max 3 sentences. End with one question. Sound like a person who's been paying very close attention.`,
        },
        {
          role: 'user',
          content: `Here's what I know about ${userName || 'this person'} across all life areas:\n\n${crossContext.join('\n\n')}\n\nGenerate a weekly cross-domain insight.`,
        },
      ],
    });

    const insight = completion.choices[0]?.message?.content?.trim();

    if (insight) {
      const ref = userRef(userId).collection('wellness_insights').doc();
      await ref.set({
        id: ref.id,
        content: insight,
        createdAt: new Date().toISOString(),
        weekOf: new Date().toISOString().slice(0, 10),
      });
    }

    res.json({ success: true, insight });
  } catch (e) {
    console.error('North insight error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});



module.exports = { router, setDb, processScheduledTriggers, runDriftNightlyAnalysis: drift.runDriftNightlyAnalysis };
