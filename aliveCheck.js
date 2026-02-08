// 🫀 STILL ALIVE - PERSONALIZED ALIVE CHECK FEATURE
// ============================================
// v4.1 — WORLD-CLASS 10/10 BACKEND + MULTILINGUAL SUPPORT
// ============================================
// ✅ 8 QUESTIONS (3 scale, 3 yesno, 2 choice) — richer data
// ✅ AI scores each pillar with full rubric + history
// ✅ True multi-pillar Alive Score (weighted across all 4 pillars)
// ✅ TRANSPARENT BREAKDOWN — users see exactly how score is built
// ✅ INDIVIDUAL TIP per result — actionable RIGHT NOW based on TODAY's answers
// ✅ 3 cross-pillar strategic tips
// ✅ Adaptive questions using previous Q&A context
// ✅ Pride moments (streaks, improvements, milestones)
// ✅ AI-powered analytics summary
// ✅ Deep AI analysis with full scoring criteria
// ✅ Optimized (cache, parallel GPT, pre-computed estimates)
// ✅ MULTILINGUAL SUPPORT — AI responds in user's language (6 languages)
// ✅ All route signatures UNCHANGED — FE safe
// ============================================

const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const { OpenAI } = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const getDb = () => admin.firestore();

// ============================================
// CONSTANTS
// ============================================

const MAX_DAILY_CHECKS = 50;
const MAX_STORED_SUBMISSIONS = 60;
const IST_OFFSET = 5.5 * 60 * 60 * 1000;

const PILLARS = {
  HEALTH:  { id: 'health',  name: 'Health',  emoji: '💪', color: '#FF6B6B',  weight: 0.30 },
  WEALTH:  { id: 'wealth',  name: 'Wealth',  emoji: '💰', color: '#FFD93D',  weight: 0.25 },
  LOVE:    { id: 'love',    name: 'Love',    emoji: '❤️', color: '#FF6B9D',  weight: 0.20 },
  PURPOSE: { id: 'purpose', name: 'Purpose', emoji: '🎯', color: '#A78BFA',  weight: 0.25 }
};

// ============================================
// LANGUAGE HELPER
// ============================================
function getLanguageName(code) {
  const languages = {
    'en': 'English',
    'es': 'Spanish', 
    'ru': 'Russian',
    'pt': 'Portuguese',
    'fr': 'French',
    'de': 'German'
  };
  return languages[code] || 'English';
}

// ============================================
// SCORING RUBRICS — THE BRAIN BEHIND AI SCORING
// ============================================

const SCORING_RUBRICS = {
  health: {
    name: 'Health',
    description: 'Physical and mental wellbeing — how the body and mind are functioning RIGHT NOW.',
    what_matters: [
      'Sleep quality and duration — foundation of everything else',
      'Energy levels throughout the day',
      'Physical activity — did they move their body meaningfully?',
      'Stress and mental state — anxiety, calm, overwhelm',
      'Body comfort — pain, tension, ease',
      'Self-care — are they actually taking care of themselves?',
      'Nutrition and hydration — fueling the body properly',
      'Rest and recovery — giving body time to heal'
    ],
    score_90_100: 'Excellent sleep, high energy, moved their body, feels calm and comfortable, actively taking care of themselves. Everything is working well.',
    score_70_89: 'Mostly good. Maybe one area slightly off (e.g. slightly tired but still functional, minor stress but manageable). Overall positive state.',
    score_50_69: 'Mixed signals. Some things okay, some not. Maybe tired but pushed through, or stressed but still moving. Not thriving but not struggling badly.',
    score_30_49: 'Several things off. Poor sleep OR high stress OR no movement OR body discomfort. Feeling drained or overwhelmed in at least one clear way.',
    score_0_29: 'Multiple serious issues. Very poor sleep AND high stress AND no movement AND feeling terrible physically or mentally. Genuinely struggling.',
    context_rules: [
      'Sleep is THE foundation — poor sleep tanks everything else',
      'High stress overrides other positive signals',
      'Movement matters but context matters — recovering from illness gets credit for small efforts',
      'Mental state (anxiety/calm) should be weighted heavily',
      'Consistency across answers matters — one bad signal in sea of good is okay, multiple bad signals is serious'
    ]
  },
  wealth: {
    name: 'Wealth',
    description: 'Financial security and career fulfillment — how stable and purposeful work and money life feels.',
    what_matters: [
      'Financial confidence — do they feel secure or anxious about money?',
      'Career or work satisfaction — does work feel meaningful or draining?',
      'Progress toward goals — are they moving forward or stuck?',
      'Financial stress — is money actively weighing on them?',
      'Work-life balance — is work consuming everything or balanced?',
      'Professional growth — learning, developing, advancing?',
      'Income security — feeling stable vs. precarious',
      'Financial planning — feeling in control vs. reactive'
    ],
    score_90_100: 'Feels financially secure, work is satisfying and meaningful, making clear progress on goals, minimal money stress, good work-life balance.',
    score_70_89: 'Generally stable. Maybe one worry (small financial stress OR work feeling slightly tedious) but overall in a good place. Moving forward.',
    score_50_69: 'Uncertain territory. Financial stress present OR work feels stagnant OR progress feels slow. Not in crisis but not thriving either.',
    score_30_49: 'Clear stress in this area. Money worries are real OR career feels stuck or unfulfilling OR work-life balance is poor. Weighing on them.',
    score_0_29: 'Serious distress. Major financial anxiety AND career dissatisfaction AND feeling trapped or hopeless about financial or professional future.',
    context_rules: [
      'Financial STRESS is the single biggest signal — it poisons everything else',
      'Work satisfaction can compensate for lower income IF financial stress is manageable',
      'Work-life balance matters enormously — burnout kills this pillar',
      'Progress does not have to be big — small consistent movement counts',
      'Feeling in control of money matters more than absolute amount'
    ]
  },
  love: {
    name: 'Love',
    description: 'Relationships and human connection — how supported, valued, and connected they feel.',
    what_matters: [
      'Connection with loved ones — do they feel close to people?',
      'Feeling supported and valued — does someone have their back?',
      'Quality of interactions — were conversations meaningful?',
      'Communication — are relationships open and honest?',
      'Loneliness — are they feeling isolated or connected?',
      'Appreciation — giving and receiving it?',
      'Relationship quality — nourishing vs. draining',
      'Emotional safety — can they be themselves?'
    ],
    score_90_100: 'Feeling deeply connected, had meaningful interactions, feels valued and supported, relationships are nourishing. Heart is full.',
    score_70_89: 'Good connection overall. Maybe did not have a deep conversation today but feels secure in relationships. Warm and supported.',
    score_50_69: 'Some connection but something feels off. Maybe lonely despite being around people, or a relationship feels strained. Okay but not great.',
    score_30_49: 'Feeling disconnected or unsupported. Loneliness is real OR a key relationship is strained OR feeling unvalued. This pillar needs attention.',
    score_0_29: 'Deep loneliness or relational pain. Feeling truly alone, unsupported, or dealing with relationship conflict that is genuinely hurting.',
    context_rules: [
      'Loneliness is the BIGGEST negative signal — even one meaningful connection can save a score',
      'Quality over quantity — one deep connection beats many shallow ones',
      'Feeling valued by even ONE person matters enormously',
      'Appreciation (giving or receiving) is a strong positive signal',
      'Emotional safety in relationships is critical — being authentic matters'
    ]
  },
  purpose: {
    name: 'Purpose',
    description: 'Meaning, direction, and growth — how aligned life feels with what actually matters to them.',
    what_matters: [
      'Sense of meaning — does life feel meaningful today?',
      'Progress on what matters — working toward real goals?',
      'Personal growth — learning, evolving, becoming?',
      'Values alignment — living in line with what they believe in?',
      'Life direction — clarity on where they are going?',
      'Contribution — feeling like they are making a difference?',
      'Fulfillment — feeling satisfied with choices?',
      'Future optimism — hopeful about what is ahead?'
    ],
    score_90_100: 'Today felt meaningful. Working on something that matters. Growing and learning. Clear sense of direction. Feels like life has purpose.',
    score_70_89: 'Generally on track. Maybe today was routine but the bigger picture feels good. Some growth happening. Direction is clear enough.',
    score_50_69: 'Drifting a bit. Today did not feel very meaningful OR unsure about direction OR not making progress on what matters. Searching.',
    score_30_49: 'Feeling lost or stuck. Life does not feel meaningful, no clear direction, not growing, or deeply misaligned with own values.',
    score_0_29: 'Existential struggle. Feeling truly purposeless, completely lost, no meaning, no growth, deeply misaligned with everything that should matter.',
    context_rules: [
      'Meaning is subjective — routine day can still score high if person feels purpose behind it',
      'Growth does not have to be dramatic — small learning moments count',
      'Values alignment is HUGE — doing something that conflicts with core values tanks this score',
      'Clarity of direction matters more than speed of progress',
      'Feeling of contribution is powerful — even small acts of helping matter'
    ]
  }
};

// ============================================
// IN-MEMORY CACHE (TTL-based, per deviceId)
// ============================================

const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 min

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data) {
  cache.set(key, { data, ts: Date.now() });
}
function cacheInvalidate(deviceId) {
  for (const key of cache.keys()) {
    if (key.startsWith(deviceId)) cache.delete(key);
  }
}

// ============================================
// HELPERS
// ============================================

const getCurrentDateIST = () => {
  const now = new Date();
  return new Date(now.getTime() + IST_OFFSET).toISOString().split('T')[0];
};

const getMidnightISTTimestamp = () => {
  const now = new Date();
  const ist = new Date(now.getTime() + IST_OFFSET);
  ist.setHours(0, 0, 0, 0);
  return ist.getTime() - IST_OFFSET;
};

const getNextMidnightIST = () => getMidnightISTTimestamp() + 86400000;

const formatTimeUntilReset = (resetTime) => {
  const rem = resetTime - Date.now();
  if (rem <= 0) return 'now';
  const h = Math.floor(rem / 3600000);
  const m = Math.floor((rem % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

const getVibeFromScore = (score) => {
  if (score >= 80) return { vibe: 'THRIVING', emoji: '🔥' };
  if (score >= 60) return { vibe: 'LIVING',   emoji: '⚡' };
  if (score >= 40) return { vibe: 'SURVIVING',emoji: '💪' };
  return { vibe: 'STRUGGLING', emoji: '🌱' };
};

const getAgeGroupLabel = (ag) => ({
  '18-24':'Young Adult','25-34':'Adult','35-44':'Mid Adult',
  '45-54':'Mature Adult','55-64':'Senior Adult','65+':'Elder'
}[ag] || 'Adult');

// ============================================
// 🧠 AI PILLAR SCORING ENGINE
// Now with 8 questions for richer data + MULTILINGUAL
// ============================================

async function aiScorePillar(profile, pillar, questions, answers, submissions) {
  const { name, ageGroup, gender, language } = profile;
  const userLanguage = language || 'en'; // ✅ Default to English if not set
  const displayAge = ageGroup ? getAgeGroupLabel(ageGroup) : 'Adult';
  const rubric = SCORING_RUBRICS[pillar];
  const pillarMeta = PILLARS[pillar.toUpperCase()];

  // Format Q&A clearly for GPT
  const qaFormatted = questions.map((q, i) => {
    const raw = answers[i]?.answer !== undefined ? answers[i].answer : answers[i];
    const answerValue = typeof raw === 'object' && raw !== null ? (raw.answer ?? JSON.stringify(raw)) : raw;
    return `  Q${i + 1}: ${q.text}\n  A${i + 1}: ${answerValue}`;
  }).join('\n\n');

  // Get last 3 scores on THIS pillar for trend context
  const prevSamePillar = submissions
    .filter(s => s.pillar === pillar)
    .slice(0, 3);

  const previousScoresContext = prevSamePillar.length > 0
    ? prevSamePillar.map(s => `  ${s.date}: ${s.pillarScores?.[pillar] ?? s.score}/100`).join('\n')
    : '  No previous checks on this pillar';

  // Get previous Q&A on same pillar for pattern context
  const prevQAContext = prevSamePillar.length > 0
    ? prevSamePillar.map(s => {
        const qa = (s.questions || []).map((q, idx) => {
          const a = s.answers?.[idx]?.answer?.answer ?? s.answers?.[idx]?.answer ?? '—';
          return `${q.text} → ${a}`;
        }).join('; ');
        return `  [${s.date}] ${qa}`;
      }).join('\n')
    : '  No previous Q&A on this pillar';

  const prompt = `IMPORTANT: Your justification MUST be in ${getLanguageName(userLanguage)} language.
Respond ONLY with valid JSON. The "justification" field must be in ${getLanguageName(userLanguage)}.

You are scoring ${name}'s ${rubric.name} wellness pillar. You have 8 detailed answers. Give an accurate, fair score based on the rubric.

═══════════════════════════════════════════
👤 PERSON: ${name} | ${displayAge} | ${gender}
═══════════════════════════════════════════

═══════════════════════════════════════════
📝 TODAY'S ANSWERS (${pillarMeta?.emoji} ${rubric.name}) — 8 QUESTIONS:
${qaFormatted}
═══════════════════════════════════════════

═══════════════════════════════════════════
📊 THEIR PREVIOUS ${rubric.name.toUpperCase()} SCORES (for trend awareness):
${previousScoresContext}
═══════════════════════════════════════════

═══════════════════════════════════════════
📝 THEIR PREVIOUS ${rubric.name.toUpperCase()} ANSWERS (for pattern awareness):
${prevQAContext}
═══════════════════════════════════════════

═══════════════════════════════════════════
📖 ${rubric.name.toUpperCase()} PILLAR DEFINITION:
${rubric.description}

What matters in this pillar:
${rubric.what_matters.map(w => `  • ${w}`).join('\n')}
═══════════════════════════════════════════

═══════════════════════════════════════════
📊 SCORING RUBRIC — USE THIS TO DECIDE THE SCORE:

🟢 90-100: ${rubric.score_90_100}
🟡 70-89:  ${rubric.score_70_89}
🟠 50-69:  ${rubric.score_50_69}
🔴 30-49:  ${rubric.score_30_49}
🔵 0-29:   ${rubric.score_0_29}
═══════════════════════════════════════════

═══════════════════════════════════════════
⚡ CONTEXT RULES — THESE OVERRIDE SIMPLE AVERAGES:
${rubric.context_rules.map(r => `  • ${r}`).join('\n')}
═══════════════════════════════════════════

═══════════════════════════════════════════
🎯 YOUR JOB:
1. Read all 8 answers carefully — more data = more accuracy
2. Match their answers to the rubric above
3. Apply the context rules (some signals matter more)
4. Give ONE score (0-100) that honestly reflects where they are
5. Write a 1-sentence justification (max 20 words) in ${getLanguageName(userLanguage)} explaining WHY

IMPORTANT:
- Do NOT just average numbers. Read the MEANING of their answers.
- Use the context rules — they exist because some signals matter more
- Be honest. Not harsh, but accurate. The user needs to trust this score.
- Consider their previous scores for consistency
- With 8 questions, you have rich data — use ALL of it

Respond ONLY with valid JSON:
{
  "score": <number 0-100>,
  "justification": "<1 sentence in ${getLanguageName(userLanguage)}, max 20 words, why this score>"
}`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are an accurate wellness scorer. Follow the rubric precisely. Respond ONLY with valid JSON. No markdown.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 150,
    });

    let txt = completion.choices[0].message.content.trim().replace(/```json\n?/g, '').replace(/```\n?/g, '');
    const parsed = JSON.parse(txt);

    if (typeof parsed.score === 'number' && parsed.score >= 0 && parsed.score <= 100) {
      return {
        score: Math.round(parsed.score),
        justification: parsed.justification || ''
      };
    }
    throw new Error('Invalid score value');

  } catch (error) {
    console.error(`AI scoring error for ${pillar}:`, error.message);
    return { score: 55, justification: 'Score estimated due to a temporary issue.' };
  }
}

// ============================================
// MULTI-PILLAR ALIVE SCORE + TRANSPARENT BREAKDOWN
// ============================================

function buildPillarHistory(submissions) {
  const history = { health: [], wealth: [], love: [], purpose: [] };
  for (const sub of submissions) {
    const p = sub.pillar;
    if (history[p] && sub.pillarScores && sub.pillarScores[p] !== undefined) {
      if (history[p].length < 5) history[p].push(sub.pillarScores[p]);
    }
  }
  return history;
}

function getEstimatedPillarScore(pillarHistory, pillarId) {
  const scores = pillarHistory[pillarId];
  if (scores && scores.length > 0) {
    let weightSum = 0, valSum = 0;
    scores.forEach((s, i) => {
      const w = scores.length - i;
      valSum += s * w;
      weightSum += w;
    });
    return Math.round(valSum / weightSum);
  }
  return 55;
}

function calculateAliveScore(todayPillar, todayScore, submissions) {
  const pillarHistory = buildPillarHistory(submissions);

  const scores = {};
  for (const key of Object.keys(PILLARS)) {
    const pid = PILLARS[key].id;
    scores[pid] = pid === todayPillar ? todayScore : getEstimatedPillarScore(pillarHistory, pid);
  }

  let alive = 0;
  for (const key of Object.keys(PILLARS)) {
    alive += scores[PILLARS[key].id] * PILLARS[key].weight;
  }

  // Build transparent explanation
  const breakdown = Object.keys(PILLARS).map(k => {
    const p = PILLARS[k];
    const isTodayPillar = p.id === todayPillar;
    return {
      pillar: p.id,
      name: p.name,
      emoji: p.emoji,
      score: scores[p.id],
      weight: p.weight,
      contribution: Math.round(scores[p.id] * p.weight),
      isToday: isTodayPillar,
      source: isTodayPillar ? 'scored_today' : 'estimated_from_history'
    };
  }).sort((a, b) => b.score - a.score);

  const strongest = breakdown[0];
  const weakest = breakdown[breakdown.length - 1];

  const scoringExplanation = `Your ${strongest.name} (${strongest.score}) is strongest. ${weakest.name} (${weakest.score}) needs attention. Today's ${PILLARS[todayPillar.toUpperCase()]?.name} check (${todayScore}) ${todayScore >= 75 ? 'boosted' : todayScore >= 55 ? 'maintained' : 'lowered'} your overall score.`;

  return { 
    aliveScore: Math.round(alive), 
    pillarScores: scores,
    breakdown,
    scoringExplanation,
    strongest: strongest.pillar,
    weakest: weakest.pillar
  };
}

// ============================================
// PRIDE MOMENT DETECTOR
// ============================================

function detectPrideMoment(todayPillar, todayPillarScore, aliveScore, submissions) {
  const moments = [];

  const prevScoresThisPillar = submissions
    .filter(s => s.pillar === todayPillar && s.pillarScores && s.pillarScores[todayPillar] !== undefined)
    .map(s => s.pillarScores[todayPillar]);

  if (prevScoresThisPillar.length > 0) {
    const prevBest = Math.max(...prevScoresThisPillar);
    if (todayPillarScore > prevBest) {
      moments.push({
        type: 'personal_best',
        text: `🏆 Personal best on ${PILLARS[todayPillar.toUpperCase()]?.name || todayPillar}! Up from ${prevBest} → ${todayPillarScore}`,
      });
    }
  }

  if (prevScoresThisPillar.length >= 2) {
    const last2 = prevScoresThisPillar.slice(0, 2);
    if (todayPillarScore > last2[0] && last2[0] > last2[1]) {
      moments.push({
        type: 'improvement_streak',
        text: `📈 3 checks in a row improving on ${PILLARS[todayPillar.toUpperCase()]?.name || todayPillar}! Keep it up!`,
      });
    }
  }

  if (submissions.length >= 1) {
    const today = getCurrentDateIST();
    let streak = 1;
    let lastDate = today;
    const uniqueDates = [...new Set(submissions.map(s => s.date))];
    for (const d of uniqueDates) {
      const diff = (new Date(lastDate) - new Date(d)) / 86400000;
      if (Math.round(diff) === 1) { streak++; lastDate = d; }
      else break;
    }
    if (streak >= 3 && streak % 3 === 0) {
      moments.push({
        type: 'check_streak',
        text: `🔥 ${streak}-day check-in streak! You're building a real habit.`,
      });
    }
  }

  if (submissions.length > 0) {
    const lastAlive = submissions[0].score;
    const tierOf = (s) => s >= 80 ? 3 : s >= 60 ? 2 : s >= 40 ? 1 : 0;
    if (tierOf(aliveScore) > tierOf(lastAlive)) {
      const tierNames = ['Struggling', 'Surviving', 'Living', 'Thriving'];
      moments.push({
        type: 'tier_upgrade',
        text: `✨ You just leveled up to ${tierNames[tierOf(aliveScore)]}! That's real progress.`,
      });
    }
  }

  return moments;
}

// ============================================
// 🔥 INDIVIDUAL TIP GENERATOR + MULTILINGUAL
// Generates ONE specific, actionable tip based on
// TODAY's answers. This is the immediate takeaway.
// ============================================

async function generateIndividualTip(profile, pillar, questions, answers, todayPillarScore) {
  const { name, language } = profile;
  const userLanguage = language || 'en'; // ✅ Default to English
  const pillarMeta = PILLARS[pillar.toUpperCase()];

  const qaContext = questions.map((q, i) => {
    const raw = answers[i]?.answer !== undefined ? answers[i].answer : answers[i];
    const answerValue = typeof raw === 'object' && raw !== null ? (raw.answer ?? JSON.stringify(raw)) : raw;
    return `Q: ${q.text}\nA: ${answerValue}`;
  }).join('\n\n');

  const prompt = `IMPORTANT: The tip MUST be in ${getLanguageName(userLanguage)} language.
Respond ONLY with valid JSON. The "tip" field must be in ${getLanguageName(userLanguage)}.

You are Dr. Sarah giving ${name} ONE immediate action based on their ${pillarMeta?.name} check.

📝 TODAY'S ANSWERS:
${qaContext}

📊 Their ${pillarMeta?.name} score: ${todayPillarScore}/100

🎯 Give ${name} ONE specific tip they can act on TODAY or TOMORROW.

Rules:
- Must be SPECIFIC to their actual answers (reference what they said)
- Actionable within 24-48 hours
- 1 sentence, max 20 words
- Warm, encouraging tone
- Use ${name} if it flows naturally (max once)
- MUST be in ${getLanguageName(userLanguage)} language

Examples (in English, but you must respond in ${getLanguageName(userLanguage)}):
- "Your good sleep is your superpower right now — protect it tonight too, ${name}."
- "That 3/5 energy tells me you need a 20-minute walk today to reset."
- "You mentioned no meaningful conversation — text one person right now and ask how they are."

Respond ONLY with valid JSON:
{"tip": "your specific tip in ${getLanguageName(userLanguage)}"}`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Respond ONLY with valid JSON. No markdown.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.75,
      max_tokens: 80,
    });

    let txt = completion.choices[0].message.content.trim().replace(/```json\n?/g, '').replace(/```\n?/g, '');
    const parsed = JSON.parse(txt);
    return parsed.tip || 'Take one small step forward today.';
  } catch (error) {
    console.error('Individual tip error:', error.message);
    return 'Small actions today create big changes tomorrow.';
  }
}

// ============================================
// PARALLEL GPT CALLS — Quote + Strategic Tips + MULTILINGUAL
// ============================================

async function generateQuoteAndStrategicTips(profile, todayPillar, questions, answers, pillarScores, aliveScore, scoringJustification, submissions) {
  const { name, ageGroup, gender, language } = profile;
  const userLanguage = language || 'en'; // ✅ Default to English
  const displayAge = ageGroup ? getAgeGroupLabel(ageGroup) : 'Adult';
  const pillarMeta = PILLARS[todayPillar.toUpperCase()];

  const qaContext = questions.map((q, i) => {
    const raw = answers[i]?.answer !== undefined ? answers[i].answer : answers[i];
    const answerValue = typeof raw === 'object' && raw !== null ? (raw.answer ?? JSON.stringify(raw)) : raw;
    return `Q: ${q.text}\nA: ${answerValue}`;
  }).join('\n\n');

  const pillarSummary = Object.keys(PILLARS).map(k => {
    const p = PILLARS[k];
    return `${p.emoji} ${p.name}: ${pillarScores[p.id] || '—'}/100`;
  }).join(' | ');

  const sorted = Object.entries(pillarScores).sort((a, b) => a[1] - b[1]);
  const weakest = sorted[0];
  const strongest = sorted[sorted.length - 1];

  const recentTrend = submissions.slice(0, 5).map(s =>
    `${s.date}: Alive=${s.score}/100 [${s.vibe}] | ${s.pillar}=${s.pillarScores?.[s.pillar] ?? s.score}/100`
  ).join('\n');

  // --- PROMPT 1: Quote + Message ---
  const quotePrompt = `IMPORTANT: Quote and message MUST be in ${getLanguageName(userLanguage)} language.
Respond ONLY with valid JSON. Both "quote" and "message" fields must be in ${getLanguageName(userLanguage)}.

You are Dr. Sarah, a warm wellness coach.

User: ${name}, Age: ${displayAge}, Gender: ${gender}
Today's check: ${pillarMeta?.emoji} ${pillarMeta?.name}
Their ${pillarMeta?.name} score: ${pillarScores[todayPillar]}/100
Scoring reason: ${scoringJustification}
Overall Alive Score: ${aliveScore}/100

Their answers:
${qaContext}

Write:
1. A QUOTE (5-8 words, warm, personal). Use ${name} max once.
2. A MESSAGE (1 sentence, max 20 words). Reference something SPECIFIC from their answers. Be honest and caring.

Both must be in ${getLanguageName(userLanguage)} language.

Respond ONLY with valid JSON:
{"quote": "... in ${getLanguageName(userLanguage)}", "message": "... in ${getLanguageName(userLanguage)}"}`;

  // --- PROMPT 2: Strategic Tips (3 cross-pillar tips) ---
  const tipsPrompt = `IMPORTANT: All tips MUST be in ${getLanguageName(userLanguage)} language.
Respond ONLY with valid JSON. All fields must be in ${getLanguageName(userLanguage)}.

You are Dr. Maya, a wellness strategist for ${name}.

👤 ${name} | ${displayAge} | ${gender}

📊 ALL PILLAR SCORES RIGHT NOW:
${pillarSummary}
💪 Strongest: ${PILLARS[strongest[0]?.toUpperCase()]?.name || strongest[0]} (${strongest[1]}/100)
⚠️ Weakest: ${PILLARS[weakest[0]?.toUpperCase()]?.name || weakest[0]} (${weakest[1]}/100)
Overall Alive Score: ${aliveScore}/100

📝 Today's ${pillarMeta?.name} check answers:
${qaContext}

📈 Recent trend (last 5 checks):
${recentTrend || 'First check-in'}

🎯 Generate 3 STRATEGIC TIPS (these are different from the immediate tip they already got):

Rules:
- At least 1 tip MUST connect two pillars (e.g., "Your strong Love can help boost your Health this week")
- Tips should be STRATEGIC — not what to do today, but what to focus on THIS WEEK
- Each tip: 1 sentence, max 22 words
- Specific to their actual scores and patterns — not generic wellness advice
- Warm and empowering tone
- Use ${name} in max 1 tip
- ALL tips must be in ${getLanguageName(userLanguage)} language

Also identify the weakest pillar and give it a specific weekly boost suggestion (max 25 words) in ${getLanguageName(userLanguage)}.

Respond ONLY with valid JSON:
{
  "tips": ["tip1 in ${getLanguageName(userLanguage)}", "tip2 in ${getLanguageName(userLanguage)}", "tip3 in ${getLanguageName(userLanguage)}"],
  "weakestPillar": "pillar_id",
  "weakestBoost": "specific weekly suggestion in ${getLanguageName(userLanguage)}"
}`;

  const [quoteRes, tipsRes] = await Promise.allSettled([
    openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Respond ONLY with valid JSON. No markdown.' },
        { role: 'user', content: quotePrompt }
      ],
      temperature: 0.72,
      max_tokens: 150,
    }),
    openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Respond ONLY with valid JSON. No markdown.' },
        { role: 'user', content: tipsPrompt }
      ],
      temperature: 0.68,
      max_tokens: 300,
    }),
  ]);

  let quote = 'You showed up today';
  let message = 'Every check-in is a step forward.';
  if (quoteRes.status === 'fulfilled') {
    try {
      let txt = quoteRes.value.choices[0].message.content.trim().replace(/```json\n?/g, '').replace(/```\n?/g, '');
      const parsed = JSON.parse(txt);
      if (parsed.quote) quote = parsed.quote;
      if (parsed.message) message = parsed.message;
    } catch (e) { console.error('Quote parse err:', e.message); }
  }

  let strategicTips = [];
  let weakestPillar = null;
  let weakestBoost = null;
  if (tipsRes.status === 'fulfilled') {
    try {
      let txt = tipsRes.value.choices[0].message.content.trim().replace(/```json\n?/g, '').replace(/```\n?/g, '');
      const parsed = JSON.parse(txt);
      if (Array.isArray(parsed.tips)) strategicTips = parsed.tips.slice(0, 3);
      if (parsed.weakestPillar) weakestPillar = parsed.weakestPillar;
      if (parsed.weakestBoost) weakestBoost = parsed.weakestBoost;
    } catch (e) { console.error('Tips parse err:', e.message); }
  }

  if (strategicTips.length === 0) {
    const weakMeta = PILLARS[weakest[0]?.toUpperCase()];
    const strongMeta = PILLARS[strongest[0]?.toUpperCase()];
    strategicTips = [
      `Your ${strongMeta?.name?.toLowerCase() || 'strongest area'} is strong — let that energy carry you this week.`,
      `Small consistent steps on ${weakMeta?.name?.toLowerCase() || 'your weakest area'} add up over time.`,
      `Use your ${strongMeta?.name?.toLowerCase() || 'strength'} to support your ${weakMeta?.name?.toLowerCase() || 'growth'} this week.`
    ];
  }

  return { quote, message, strategicTips, weakestPillar, weakestBoost };
}

// ============================================
// ADAPTIVE QUESTION GENERATION — NOW 8 QUESTIONS + MULTILINGUAL
// 3 scale, 3 yesno, 2 choice
// ============================================

const generatePersonalizedQuestions = async (profile, selectedPillar, previousSubmissions = []) => {
  const { name, ageGroup, gender, language } = profile;
  const userLanguage = language || 'en'; // ✅ Default to English
  const displayAge = ageGroup ? getAgeGroupLabel(ageGroup) : 'Adult';
  const pillarMeta = PILLARS[selectedPillar.toUpperCase()];
  const rubric = SCORING_RUBRICS[selectedPillar];

  const samePillarHistory = previousSubmissions
    .filter(s => s.pillar === selectedPillar)
    .slice(0, 3);

  const adaptiveContext = samePillarHistory.length > 0
    ? samePillarHistory.map(s => {
        const prevQA = (s.questions || []).map((q, i) => {
          const a = s.answers?.[i]?.answer?.answer || s.answers?.[i]?.answer || '—';
          return `${q.text} → ${a}`;
        }).join('; ');
        return `${s.date} (score ${s.pillarScores?.[selectedPillar] || s.score}/100): ${prevQA}`;
      }).join('\n')
    : null;

  const pillarHistory = buildPillarHistory(previousSubmissions);
  const pillarContext = Object.keys(PILLARS).map(k => {
    const p = PILLARS[k];
    const scores = pillarHistory[p.id];
    const avg = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
    return `${p.name}: ${avg !== null ? avg + '/100' : 'no data'}`;
  }).join(', ');

  const prompt = `IMPORTANT: Generate ALL questions in ${getLanguageName(userLanguage)} language.
Questions text, options, labels - EVERYTHING must be in ${getLanguageName(userLanguage)}.
Respond ONLY with valid JSON. No markdown.

You are Dr. Sarah creating 8 adaptive wellness questions.

👤 USER:
- Name: ${name}
- Age: ${displayAge}
- Gender: ${gender}
- Language: ${getLanguageName(userLanguage)}
- Today's focus: ${pillarMeta?.emoji} ${pillarMeta?.name}
- Other pillar context: ${pillarContext}

${adaptiveContext ? `📝 PREVIOUS ${pillarMeta?.name.toUpperCase()} CHECK-INS:\n${adaptiveContext}` : `📝 First time checking ${pillarMeta?.name} — keep it welcoming.`}

📖 WHAT ${pillarMeta?.name.toUpperCase()} SCORING CARES ABOUT:
${rubric.what_matters.map(w => `  • ${w}`).join('\n')}

⚡ CRITICAL SIGNALS (questions should uncover these):
${rubric.context_rules.map(r => `  • ${r}`).join('\n')}

🎯 CREATE 8 QUESTIONS about ${pillarMeta?.emoji} ${pillarMeta?.name}:

CRITICAL RULES:
- EXACTLY: 3 scale (1-5), 3 yesno, 2 choice
- If user previously answered poorly on something, FOLLOW UP on it
- If user previously scored high, dig DEEPER
- NEVER repeat an exact question from history
- Use ${name} in ONLY 1-2 questions max
- Conversational tone, not clinical
- Age-appropriate for ${displayAge}
- Choice questions MUST have 4-5 options ordered from worst to best
- Questions should reveal the signals the scoring rubric cares about
- 8 questions = richer data = better scoring accuracy
- ALL questions, labels, options MUST be in ${getLanguageName(userLanguage)} language

RESPOND with valid JSON only (NO MARKDOWN):
{
  "questions": [
    {"id":"q1","pillar":"${selectedPillar}","text":"... in ${getLanguageName(userLanguage)}","type":"scale","min":1,"max":5,"labels":["Low in ${getLanguageName(userLanguage)}","High in ${getLanguageName(userLanguage)}"]},
    {"id":"q2","pillar":"${selectedPillar}","text":"... in ${getLanguageName(userLanguage)}","type":"yesno"},
    {"id":"q3","pillar":"${selectedPillar}","text":"... in ${getLanguageName(userLanguage)}","type":"choice","options":["Worst in ${getLanguageName(userLanguage)}","Bad in ${getLanguageName(userLanguage)}","Okay in ${getLanguageName(userLanguage)}","Good in ${getLanguageName(userLanguage)}","Great in ${getLanguageName(userLanguage)}"]},
    {"id":"q4","pillar":"${selectedPillar}","text":"... in ${getLanguageName(userLanguage)}","type":"scale","min":1,"max":5,"labels":["Low in ${getLanguageName(userLanguage)}","High in ${getLanguageName(userLanguage)}"]},
    {"id":"q5","pillar":"${selectedPillar}","text":"... in ${getLanguageName(userLanguage)}","type":"yesno"},
    {"id":"q6","pillar":"${selectedPillar}","text":"... in ${getLanguageName(userLanguage)}","type":"scale","min":1,"max":5,"labels":["Low in ${getLanguageName(userLanguage)}","High in ${getLanguageName(userLanguage)}"]},
    {"id":"q7","pillar":"${selectedPillar}","text":"... in ${getLanguageName(userLanguage)}","type":"yesno"},
    {"id":"q8","pillar":"${selectedPillar}","text":"... in ${getLanguageName(userLanguage)}","type":"choice","options":["Terrible in ${getLanguageName(userLanguage)}","Poor in ${getLanguageName(userLanguage)}","Okay in ${getLanguageName(userLanguage)}","Good in ${getLanguageName(userLanguage)}","Excellent in ${getLanguageName(userLanguage)}"]}
  ]
}`;

  try {
    console.log(`🤖 Generating 8 adaptive ${pillarMeta?.name} questions for ${name} in ${getLanguageName(userLanguage)}...`);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are Dr. Sarah. Respond ONLY with valid JSON, no markdown.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.8,
      max_tokens: 800,
    });

    let txt = completion.choices[0].message.content.trim().replace(/```json\n?/g, '').replace(/```\n?/g, '');
    const parsed = JSON.parse(txt);

    if (!parsed.questions || parsed.questions.length !== 8) throw new Error('Bad question count');

    parsed.questions.forEach(q => {
      if (q.type === 'choice' && (!Array.isArray(q.options) || q.options.length < 4)) {
        q.options = ['Very Bad', 'Bad', 'Okay', 'Good', 'Great'];
      }
    });

    console.log(`✅ Generated 8 adaptive ${pillarMeta?.name} questions for ${name} in ${getLanguageName(userLanguage)}`);
    return { success: true, questions: parsed.questions };

  } catch (error) {
    console.error('Question generation error:', error.message);

    const fallbacks = {
      health: [
        { id:'q1', pillar:'health', text:'How energized do you feel right now?', type:'scale', min:1, max:5, labels:['Drained','Energized'] },
        { id:'q2', pillar:'health', text:'Did you get enough sleep last night?', type:'yesno' },
        { id:'q3', pillar:'health', text:'How would you describe your physical state today?', type:'choice', options:['Terrible','Poor','Okay','Good','Great'] },
        { id:'q4', pillar:'health', text:'How stressed do you feel right now?', type:'scale', min:1, max:5, labels:['Very Stressed','Calm'] },
        { id:'q5', pillar:'health', text:'Did you move your body meaningfully today?', type:'yesno' },
        { id:'q6', pillar:'health', text:'How clear is your mind right now?', type:'scale', min:1, max:5, labels:['Very Foggy','Crystal Clear'] },
        { id:'q7', pillar:'health', text:'Did you eat nourishing food today?', type:'yesno' },
        { id:'q8', pillar:'health', text:'How comfortable does your body feel?', type:'choice', options:['Very Uncomfortable','Uncomfortable','Neutral','Comfortable','Very Comfortable'] },
      ],
      wealth: [
        { id:'q1', pillar:'wealth', text:'How confident do you feel about your finances?', type:'scale', min:1, max:5, labels:['Very Unsure','Very Confident'] },
        { id:'q2', pillar:'wealth', text:'Did you make progress on a money or career goal today?', type:'yesno' },
        { id:'q3', pillar:'wealth', text:'How would you rate your work-life balance?', type:'choice', options:['Terrible','Poor','Okay','Good','Excellent'] },
        { id:'q4', pillar:'wealth', text:'How stressed does money make you feel?', type:'scale', min:1, max:5, labels:['Very Stressed','No Stress'] },
        { id:'q5', pillar:'wealth', text:'Did you do something today that moves you forward professionally?', type:'yesno' },
        { id:'q6', pillar:'wealth', text:'How satisfied are you with your career right now?', type:'scale', min:1, max:5, labels:['Very Unsatisfied','Very Satisfied'] },
        { id:'q7', pillar:'wealth', text:'Do you feel in control of your financial situation?', type:'yesno' },
        { id:'q8', pillar:'wealth', text:'How secure do you feel about your income?', type:'choice', options:['Very Insecure','Insecure','Neutral','Secure','Very Secure'] },
      ],
      love: [
        { id:'q1', pillar:'love', text:'How connected do you feel to the people you care about?', type:'scale', min:1, max:5, labels:['Very Alone','Deeply Connected'] },
        { id:'q2', pillar:'love', text:'Did you have a meaningful conversation today?', type:'yesno' },
        { id:'q3', pillar:'love', text:'How would you describe your relationships right now?', type:'choice', options:['Struggling','Strained','Okay','Good','Thriving'] },
        { id:'q4', pillar:'love', text:'How loved and supported do you feel?', type:'scale', min:1, max:5, labels:['Not At All','Completely'] },
        { id:'q5', pillar:'love', text:'Did you express appreciation to someone today?', type:'yesno' },
        { id:'q6', pillar:'love', text:'How emotionally safe do you feel in your relationships?', type:'scale', min:1, max:5, labels:['Very Unsafe','Very Safe'] },
        { id:'q7', pillar:'love', text:'Do you feel valued by the people close to you?', type:'yesno' },
        { id:'q8', pillar:'love', text:'How would you rate the quality of your social connections?', type:'choice', options:['Very Poor','Poor','Okay','Good','Excellent'] },
      ],
      purpose: [
        { id:'q1', pillar:'purpose', text:'How meaningful did today feel?', type:'scale', min:1, max:5, labels:['Empty','Very Meaningful'] },
        { id:'q2', pillar:'purpose', text:'Did you work on something that matters to you?', type:'yesno' },
        { id:'q3', pillar:'purpose', text:'How aligned do you feel with your life direction?', type:'choice', options:['Lost','Unsure','Finding Way','Aligned','Thriving'] },
        { id:'q4', pillar:'purpose', text:'How clear are you on what you want?', type:'scale', min:1, max:5, labels:['Very Unclear','Crystal Clear'] },
        { id:'q5', pillar:'purpose', text:'Did you learn or grow in some way today?', type:'yesno' },
        { id:'q6', pillar:'purpose', text:'How much does your life feel aligned with your values?', type:'scale', min:1, max:5, labels:['Not At All','Completely'] },
        { id:'q7', pillar:'purpose', text:'Do you feel like you made a difference today?', type:'yesno' },
        { id:'q8', pillar:'purpose', text:'How optimistic do you feel about your future?', type:'choice', options:['Very Pessimistic','Pessimistic','Neutral','Optimistic','Very Optimistic'] },
      ],
    };

    return { success: true, questions: fallbacks[selectedPillar] || fallbacks.health };
  }
};

// ============================================
// AI ANALYSIS — DEEP, FULL-CRITERIA DRIVEN + MULTILINGUAL
// ============================================

const getPersonalizedAnalysis = async (profile, submissions) => {
  if (submissions.length < 3) {
    return { success: false, message: `You need at least 3 check-ins for AI insights. You have ${submissions.length}. Keep going!` };
  }

  const { name, ageGroup, gender, language } = profile;
  const userLanguage = language || 'en'; // ✅ Default to English
  const displayAge = ageGroup ? getAgeGroupLabel(ageGroup) : 'Adult';
  const last30 = submissions.slice(0, 30);

  const pillarTrends = {};
  for (const key of Object.keys(PILLARS)) {
    const pid = PILLARS[key].id;
    const pillarSubs = last30.filter(s => s.pillar === pid);
    if (pillarSubs.length >= 1) {
      const scores = pillarSubs.map(s => s.pillarScores?.[pid] || s.score);
      const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
      let trend = 'stable';
      if (scores.length >= 2) {
        const recent = scores.slice(0, Math.ceil(scores.length / 2));
        const older = scores.slice(Math.ceil(scores.length / 2));
        const rA = recent.reduce((a, b) => a + b, 0) / recent.length;
        const oA = older.reduce((a, b) => a + b, 0) / older.length;
        trend = rA > oA + 5 ? 'improving' : rA < oA - 5 ? 'declining' : 'stable';
      }
      pillarTrends[pid] = {
        trend, average: avg, latest: scores[0],
        highest: Math.max(...scores), lowest: Math.min(...scores),
        checks: pillarSubs.length
      };
    }
  }

  const historyContext = last30.map((s, i) => {
    const base = `${s.date}: Alive=${s.score}/100 [${s.vibe}] | ${s.pillar}=${s.pillarScores?.[s.pillar] ?? s.score}/100`;
    if (i < 10 && s.questions) {
      const qa = s.questions.slice(0, 5).map((q, idx) => {
        const a = s.answers?.[idx]?.answer?.answer ?? s.answers?.[idx]?.answer ?? '—';
        return `${q.text} → ${a}`;
      }).join(' | ');
      return `${base} | Q&A: ${qa}`;
    }
    return base;
  }).join('\n');

  const rubricSummary = Object.keys(SCORING_RUBRICS).map(key => {
    const r = SCORING_RUBRICS[key];
    return `${r.name}: ${r.description} Key signals: ${r.what_matters.slice(0, 3).join(', ')}`;
  }).join('\n');

  const prompt = `IMPORTANT: Respond in ${getLanguageName(userLanguage)} language.
Observations, insights, recommendations, notes - ALL must be in ${getLanguageName(userLanguage)}.
Respond ONLY with valid JSON. No markdown.

You are Dr. Maya, ${name}'s personal wellness psychologist. Give them genuinely useful, personalized insights.

═══════════════════════════════════════════
👤 ${name} | ${displayAge} | ${gender} | Language: ${getLanguageName(userLanguage)}
═══════════════════════════════════════════

═══════════════════════════════════════════
📊 FULL JOURNEY (${last30.length} checks):
${historyContext}
═══════════════════════════════════════════

═══════════════════════════════════════════
📈 PER-PILLAR BREAKDOWN:
${Object.entries(pillarTrends).map(([pid, data]) =>
  `  ${PILLARS[pid.toUpperCase()]?.emoji} ${PILLARS[pid.toUpperCase()]?.name}: avg=${data.average}/100 | latest=${data.latest}/100 | trend=${data.trend} | range=${data.lowest}-${data.highest} | ${data.checks} checks`
).join('\n')}
═══════════════════════════════════════════

═══════════════════════════════════════════
📖 WHAT EACH PILLAR MEASURES:
${rubricSummary}
═══════════════════════════════════════════

🎯 YOUR JOB — Give ${name} a REAL analysis:

OBSERVATIONS (max 30 words in ${getLanguageName(userLanguage)}):
The single most important pattern across ALL their data. Be specific — reference actual scores, dates, or answers.

INSIGHTS (max 30 words in ${getLanguageName(userLanguage)}):
What this pattern MEANS for ${name}'s life. Connect pillars if you see connections.

RECOMMENDATIONS (3 specific actions, each 18-22 words in ${getLanguageName(userLanguage)}):
- Actionable THIS WEEK
- At least 1 MUST connect two pillars
- Personal to ${name} — reference their actual patterns
- Empowering tone

PILLAR CALLOUTS:
- strongest: which pillar they are best at (and why, 1 sentence in ${getLanguageName(userLanguage)})
- needsAttention: which pillar needs love (specific, kind note in ${getLanguageName(userLanguage)})

Respond ONLY with valid JSON:
{
  "observations": "... in ${getLanguageName(userLanguage)}",
  "insights": "... in ${getLanguageName(userLanguage)}",
  "recommendations": ["... in ${getLanguageName(userLanguage)}", "... in ${getLanguageName(userLanguage)}", "... in ${getLanguageName(userLanguage)}"],
  "pillarCallouts": {
    "strongest": "pillar_id",
    "needsAttention": "pillar_id",
    "strongestNote": "1 sentence in ${getLanguageName(userLanguage)}",
    "attentionNote": "1 sentence in ${getLanguageName(userLanguage)}"
  }
}`;

  try {
    console.log(`🤖 Deep analysis for ${name} in ${getLanguageName(userLanguage)}...`);
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: `You are Dr. Maya, ${name}'s wellness psychologist. Be specific, connect patterns, warm. JSON only.` },
        { role: 'user', content: prompt }
      ],
      temperature: 0.68,
      max_tokens: 500,
    });

    let txt = completion.choices[0].message.content.trim().replace(/```json\n?/g, '').replace(/```\n?/g, '');
    const parsed = JSON.parse(txt);

    console.log(`✅ Analysis done for ${name} in ${getLanguageName(userLanguage)}`);
    return {
      success: true,
      analysis: {
        observations: parsed.observations,
        insights: parsed.insights,
        recommendations: parsed.recommendations,
        pillarCallouts: parsed.pillarCallouts || null,
        totalChecks: submissions.length,
        pillarTrends
      }
    };
  } catch (error) {
    console.error('Analysis error:', error.message);
    return { success: false, error: 'Unable to generate insights. Try again later.' };
  }
};

// ============================================
// AI ANALYTICS SUMMARY + MULTILINGUAL
// ============================================

async function generateAnalyticsSummary(profile, analyticsData, submissions) {
  try {
    const { name, ageGroup, language } = profile;
    const userLanguage = language || 'en'; // ✅ Default to English
    const displayAge = ageGroup ? getAgeGroupLabel(ageGroup) : 'Adult';
    const { summary, perPillar } = analyticsData;

    const perPillarText = Object.entries(perPillar).map(([pid, data]) =>
      `  ${PILLARS[pid.toUpperCase()]?.emoji} ${PILLARS[pid.toUpperCase()]?.name}: avg=${data.average}/100 | trend=${data.trend} | ${data.checks} checks | range ${data.lowest}-${data.highest}`
    ).join('\n');

    const recentQA = submissions.slice(0, 8).map(s => {
      if (!s.questions) return `${s.date}: ${s.pillar} → ${s.score}/100`;
      const qa = s.questions.slice(0, 4).map((q, i) => {
        const a = s.answers?.[i]?.answer?.answer ?? s.answers?.[i]?.answer ?? '—';
        return `${q.text} → ${a}`;
      }).join(' | ');
      return `${s.date} [${s.pillar}] score=${s.score}/100: ${qa}`;
    }).join('\n');

    const prompt = `IMPORTANT: Summary MUST be in ${getLanguageName(userLanguage)} language.
Respond ONLY with valid JSON. The "summary" field must be in ${getLanguageName(userLanguage)}.

You are Dr. Maya summarizing ${name}'s wellness analytics.

👤 ${name} | ${displayAge} | Language: ${getLanguageName(userLanguage)}

📊 OVERALL:
- Average Alive Score: ${summary.average}/100
- Highest: ${summary.highest}/100 | Lowest: ${summary.lowest}/100
- Overall Trend: ${summary.trend}
- Total checks: ${summary.total}

📊 PER PILLAR:
${perPillarText}

📝 RECENT CHECK-INS:
${recentQA}

Write a SHORT summary (2-3 sentences max) in ${getLanguageName(userLanguage)}. Tell ${name}:
1. Where they stand overall
2. What is working (strongest trend or pillar)
3. One thing to watch or improve

Be warm, specific, encouraging. Reference actual numbers.

Respond ONLY with valid JSON:
{"summary": "2-3 sentence summary in ${getLanguageName(userLanguage)}"}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Respond ONLY with valid JSON. No markdown.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.65,
      max_tokens: 200,
    });

    let txt = completion.choices[0].message.content.trim().replace(/```json\n?/g, '').replace(/```\n?/g, '');
    const parsed = JSON.parse(txt);
    return parsed.summary || null;
  } catch (error) {
    console.error('Analytics summary error:', error.message);
    return null;
  }
}

// ============================================
// MIDDLEWARE
// ============================================

const requireDeviceId = (req, res, next) => {
  const deviceId = req.body?.deviceId || req.query?.deviceId;
  if (!deviceId) return res.status(400).json({ success: false, error: 'Device ID required' });
  req.deviceId = deviceId;
  next();
};

const checkDailyLimit = async (req, res, next) => {
  try {
    const { deviceId } = req;
    const today = getCurrentDateIST();
    const docRef = getDb().collection('aliveChecks').doc(deviceId);
    const doc = await docRef.get();

    if (!doc.exists) { req.isFirstCheck = true; return next(); }

    const data = doc.data();
    const todayCount = data.lastCheckDate === today ? (data.todayCount || 0) : 0;

    if (todayCount >= MAX_DAILY_CHECKS) {
      const resetTime = getNextMidnightIST();
      return res.status(429).json({
        success: false,
        error: 'daily_limit_reached',
        message: `You've completed your 5 wellness checks for today! 💚 Come back in ${formatTimeUntilReset(resetTime)}.`,
        limit: MAX_DAILY_CHECKS,
        used: todayCount,
        resetIn: formatTimeUntilReset(resetTime),
        resetTime: new Date(resetTime).toISOString()
      });
    }

    req.currentDayCount = todayCount;
    req.today = today;
    next();
  } catch (error) {
    console.error('Rate limit check error:', error);
    res.status(500).json({ success: false, error: 'Failed to check rate limit' });
  }
};

// ============================================
// ROUTES
// ============================================

router.post('/profile', requireDeviceId, async (req, res) => {
  try {
    const { deviceId } = req;
    const { name, ageGroup, gender, language } = req.body;

    const docRef = getDb().collection('aliveChecks').doc(deviceId);
    const doc = await docRef.get();

    if (doc.exists) {
      // ✅ UPDATE EXISTING PROFILE (allows partial updates like language-only)
      const updateData = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
      
      if (name) updateData['profile.name'] = name.trim();
      if (ageGroup) updateData['profile.ageGroup'] = ageGroup;
      if (gender) updateData['profile.gender'] = gender;
      if (language) updateData['profile.language'] = language; // ✅ LANGUAGE UPDATE
      
      await docRef.update(updateData);
      
      const updatedDoc = await docRef.get();
      const updatedProfile = updatedDoc.data().profile;
      
      cacheInvalidate(deviceId);
      console.log(`✅ Profile updated: ${updatedProfile.name}${language ? ` | Language: ${language}` : ''}`);
      
      return res.json({
        success: true,
        profile: updatedProfile,
        message: language 
          ? `Language updated to ${getLanguageName(language)} successfully` 
          : `Welcome back, ${updatedProfile.name}!`
      });
    } else {
      // ✅ CREATE NEW PROFILE
      if (!name || !name.trim()) return res.status(400).json({ success: false, error: 'Name is required' });
      if (!gender || !['male', 'female', 'other', 'prefernottosay'].includes(gender))
        return res.status(400).json({ success: false, error: 'Valid gender is required' });
      if (!ageGroup) return res.status(400).json({ success: false, error: 'Age group is required' });

      const profile = {
        name: name.trim(),
        ageGroup,
        gender,
        language: language || 'en', // ✅ DEFAULT TO ENGLISH
        profileCompleted: true,
        profileCompletedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      await docRef.set({
        deviceId, profile,
        totalLifetimeChecks: 0, todayCount: 0, lastCheckDate: null,
        submissions: [],
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      cacheInvalidate(deviceId);
      console.log(`✅ Profile created: ${profile.name} | Language: ${profile.language}`);

      return res.json({
        success: true,
        profile,
        message: `Welcome, ${profile.name}! Your personalized wellness journey starts now. 🚀`
      });
    }
  } catch (error) {
    console.error('Save profile error:', error);
    res.status(500).json({ success: false, error: 'Failed to save profile' });
  }
});

router.get('/profile', requireDeviceId, async (req, res) => {
  try {
    const { deviceId } = req;

    const cached = cacheGet(`${deviceId}:profile`);
    if (cached) return res.json(cached);

    const doc = await getDb().collection('aliveChecks').doc(deviceId).get();
    if (!doc.exists) {
      const resp = { success: true, profile: null, hasProfile: false };
      cacheSet(`${deviceId}:profile`, resp);
      return res.json(resp);
    }
    const data = doc.data();
    const resp = { success: true, profile: data.profile || null, hasProfile: !!data.profile?.profileCompleted };
    cacheSet(`${deviceId}:profile`, resp);
    res.json(resp);
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ success: false, error: 'Failed to get profile' });
  }
});

router.get('/questions', requireDeviceId, async (req, res) => {
  try {
    const { deviceId } = req;
    const { pillar } = req.query;

    if (!pillar) return res.status(400).json({ success: false, error: 'Pillar is required' });

    const validPillars = Object.keys(PILLARS).map(k => k.toLowerCase());
    if (!validPillars.includes(pillar.toLowerCase()))
      return res.status(400).json({ success: false, error: 'Invalid pillar' });

    const doc = await getDb().collection('aliveChecks').doc(deviceId).get();
    if (!doc.exists || !doc.data().profile?.profileCompleted)
      return res.status(400).json({ success: false, error: 'Profile not completed. Please complete your profile first.', needsProfile: true });

    const data = doc.data();
    const result = await generatePersonalizedQuestions(data.profile, pillar.toLowerCase(), data.submissions || []);

    if (!result.success) throw new Error('Question generation failed');

    res.json({
      success: true,
      questions: result.questions,
      profile: { name: data.profile.name },
      pillar: pillar.toLowerCase()
    });
  } catch (error) {
    console.error('Get questions error:', error);
    res.status(500).json({ success: false, error: 'Failed to generate questions. Please try again.' });
  }
});

// POST /submit — THE MAIN EVENT (NOW WITH 8 QUESTIONS + INDIVIDUAL TIP + TRANSPARENT BREAKDOWN + MULTILINGUAL)
router.post('/submit', requireDeviceId, checkDailyLimit, async (req, res) => {
  try {
    const { deviceId } = req;
    const { questions, answers, pillar } = req.body;

    if (!questions || !answers || questions.length !== 8 || answers.length !== 8)
      return res.status(400).json({ success: false, error: 'Invalid submission. 8 questions and 8 answers required.' });
    if (!pillar)
      return res.status(400).json({ success: false, error: 'Pillar is required' });

    const docRef = getDb().collection('aliveChecks').doc(deviceId);
    const doc = await docRef.get();

    if (!doc.exists || !doc.data().profile?.profileCompleted)
      return res.status(400).json({ success: false, error: 'Profile not completed', needsProfile: true });

    const data = doc.data();
    const profile = data.profile;
    const submissions = data.submissions || [];

    console.log(`🤖 Processing ${profile.name}'s ${pillar} check-in (8 questions) in ${getLanguageName(profile.language || 'en')}...`);

    // ── STEP 1: AI scores this pillar ──
    const { score: todayPillarScore, justification: scoringJustification } = await aiScorePillar(
      profile, pillar, questions, answers, submissions
    );
    console.log(`📊 AI ${pillar} score: ${todayPillarScore}/100 | Reason: ${scoringJustification}`);

    // ── STEP 2: Calculate multi-pillar Alive Score + TRANSPARENT BREAKDOWN ──
    const { aliveScore, pillarScores, breakdown, scoringExplanation, strongest, weakest } = calculateAliveScore(
      pillar, todayPillarScore, submissions
    );
    const { vibe, emoji } = getVibeFromScore(aliveScore);
    console.log(`🎯 Alive Score: ${aliveScore}/100 | Breakdown: ${JSON.stringify(pillarScores)}`);

    // ── STEP 3: Pride moments ──
    const prideMoments = detectPrideMoment(pillar, todayPillarScore, aliveScore, submissions);

    // ── STEP 4: Generate INDIVIDUAL TIP + Quote + Strategic Tips in parallel ──
    console.log(`🤖 Generating individual tip + quote + strategic tips in ${getLanguageName(profile.language || 'en')}...`);
    const [individualTipResult, quoteAndTipsResult] = await Promise.allSettled([
      generateIndividualTip(profile, pillar, questions, answers, todayPillarScore),
      generateQuoteAndStrategicTips(profile, pillar, questions, answers, pillarScores, aliveScore, scoringJustification, submissions)
    ]);

    const individualTip = individualTipResult.status === 'fulfilled' 
      ? individualTipResult.value 
      : 'Small actions today create big changes tomorrow.';

    const { quote, message, strategicTips, weakestPillar, weakestBoost } = quoteAndTipsResult.status === 'fulfilled'
      ? quoteAndTipsResult.value
      : {
          quote: 'You showed up today',
          message: 'Every check-in is a step forward.',
          strategicTips: [],
          weakestPillar: weakest,
          weakestBoost: null
        };

    // ── STEP 5: Persist ──
    const today = getCurrentDateIST();
    const nowTimestamp = new Date().toISOString();
    const submissionId = `check_${Date.now()}`;

    const newSubmission = {
      id: submissionId,
      timestamp: nowTimestamp,
      date: today,
      pillar: pillar.toLowerCase(),
      questions,
      answers,
      score: aliveScore,
      pillarScores,
      breakdown,
      scoringExplanation,
      todayPillarScore,
      scoringJustification,
      quote,
      message,
      emoji,
      vibe,
      individualTip,
      strategicTips,
      weakestPillar,
      weakestBoost,
      prideMoments,
      source: 'ai_scored_v4_multilingual'
    };

    let updatedSubmissions = [newSubmission, ...submissions];
    if (updatedSubmissions.length > MAX_STORED_SUBMISSIONS) {
      updatedSubmissions = updatedSubmissions.slice(0, MAX_STORED_SUBMISSIONS);
    }

    const lastCheckDate = data.lastCheckDate || '';
    const todayCount = lastCheckDate === today ? (data.todayCount || 0) + 1 : 1;

    await docRef.update({
      submissions: updatedSubmissions,
      totalLifetimeChecks: admin.firestore.FieldValue.increment(1),
      todayCount,
      lastCheckDate: today,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    cacheInvalidate(deviceId);
    console.log(`✅ ${profile.name} → Alive=${aliveScore} | ${pillar}=${todayPillarScore} | ${vibe} | Lang=${getLanguageName(profile.language || 'en')}`);

    res.json({
      success: true,
      submission: {
        id: submissionId,
        score: aliveScore,
        pillarScores,
        breakdown,
        scoringExplanation,
        todayPillarScore,
        scoringJustification,
        quote,
        message,
        emoji,
        vibe,
        individualTip,
        strategicTips,
        weakestPillar,
        weakestBoost,
        prideMoments,
        date: today,
        timestamp: nowTimestamp,
        pillar: pillar.toLowerCase()
      },
      remaining: MAX_DAILY_CHECKS - todayCount,
      profile: { name: profile.name }
    });

  } catch (error) {
    console.error('Submit check error:', error);
    res.status(500).json({ success: false, error: 'Failed to submit check. Please try again.' });
  }
});

router.get('/history', requireDeviceId, async (req, res) => {
  try {
    const { deviceId } = req;
    const { limit } = req.query;

    const cached = cacheGet(`${deviceId}:history`);
    if (cached && !limit) return res.json(cached);

    const doc = await getDb().collection('aliveChecks').doc(deviceId).get();
    if (!doc.exists) {
      return res.json({ success: true, history: [], total: 0, profile: null });
    }

    const data = doc.data();
    let submissions = data.submissions || [];
    if (limit) {
      const n = parseInt(limit, 10);
      if (!isNaN(n) && n > 0) submissions = submissions.slice(0, n);
    }

    const resp = {
      success: true,
      history: submissions,
      total: data.totalLifetimeChecks || submissions.length,
      storedCount: submissions.length,
      profile: data.profile || null
    };

    if (!limit) cacheSet(`${deviceId}:history`, resp);
    res.json(resp);
  } catch (error) {
    console.error('Get history error:', error);
    res.status(500).json({ success: false, error: 'Failed to get history' });
  }
});

router.get('/analytics', requireDeviceId, async (req, res) => {
  try {
    const { deviceId } = req;
    const { range } = req.query;

    const cacheKey = `${deviceId}:analytics:${range || 'all'}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const doc = await getDb().collection('aliveChecks').doc(deviceId).get();
    if (!doc.exists) {
      return res.json({ success: true, analytics: null, message: 'No data yet. Complete your first check!' });
    }

    const data = doc.data();
    const allSubmissions = data.submissions || [];
    const profile = data.profile || null;

    if (allSubmissions.length === 0) {
      return res.json({ success: true, analytics: null, message: 'No submissions yet', profile });
    }

    let submissions = allSubmissions;
    const now = new Date();
    if (range === 'week') {
      const cutoff = new Date(now.getTime() - 7 * 86400000);
      submissions = allSubmissions.filter(s => new Date(s.date) >= cutoff);
    } else if (range === 'month') {
      const cutoff = new Date(now.getTime() - 30 * 86400000);
      submissions = allSubmissions.filter(s => new Date(s.date) >= cutoff);
    }

    if (submissions.length === 0) {
      return res.json({ success: true, analytics: null, message: 'No data in this range', profile });
    }

    const scores = submissions.map(s => s.score);
    const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    const maxScore = Math.max(...scores);
    const minScore = Math.min(...scores);

    const mid = Math.max(1, Math.floor(submissions.length / 2));
    const recentAvg = submissions.slice(0, mid).reduce((a, b) => a + b.score, 0) / mid;
    const olderAvg = submissions.slice(mid).reduce((a, b) => a + b.score, 0) / (submissions.length - mid);

    let trend = 'stable';
    if (recentAvg > olderAvg + 5) trend = 'improving';
    if (recentAvg < olderAvg - 5) trend = 'declining';

    const perPillar = {};
    for (const key of Object.keys(PILLARS)) {
      const pid = PILLARS[key].id;
      const pillarSubs = submissions.filter(s => s.pillar === pid);
      if (pillarSubs.length > 0) {
        const pScores = pillarSubs.map(s => s.pillarScores?.[pid] || s.score);
        perPillar[pid] = {
          average: Math.round(pScores.reduce((a, b) => a + b, 0) / pScores.length),
          highest: Math.max(...pScores),
          lowest: Math.min(...pScores),
          checks: pillarSubs.length,
          trend: (() => {
            if (pScores.length < 2) return 'stable';
            const half = Math.max(1, Math.floor(pScores.length / 2));
            const rA = pScores.slice(0, half).reduce((a, b) => a + b, 0) / half;
            const oA = pScores.slice(half).reduce((a, b) => a + b, 0) / (pScores.length - half);
            if (rA > oA + 5) return 'improving';
            if (rA < oA - 5) return 'declining';
            return 'stable';
          })()
        };
      }
    }

    const chartData = [...submissions].reverse().map(s => ({
      date: s.date,
      score: s.score,
      vibe: s.vibe,
      emoji: s.emoji,
      pillar: s.pillar || 'health'
    }));

    const analyticsData = {
      summary: { average: avgScore, highest: maxScore, lowest: minScore, total: submissions.length, trend },
      perPillar,
      chartData,
      range: range || 'all',
      dateRange: {
        from: submissions[submissions.length - 1].date,
        to: submissions[0].date
      }
    };

    let aiSummary = null;
    if (profile?.profileCompleted && submissions.length >= 3) {
      aiSummary = await generateAnalyticsSummary(profile, analyticsData, submissions);
    }

    const resp = {
      success: true,
      analytics: {
        ...analyticsData,
        aiSummary
      },
      profile
    };

    cacheSet(cacheKey, resp);
    res.json(resp);
  } catch (error) {
    console.error('Get analytics error:', error);
    res.status(500).json({ success: false, error: 'Failed to get analytics' });
  }
});

router.post('/ai-analysis', requireDeviceId, async (req, res) => {
  try {
    const { deviceId } = req;
    const doc = await getDb().collection('aliveChecks').doc(deviceId).get();

    if (!doc.exists) return res.status(404).json({ success: false, error: 'No data found. Complete at least 3 checks.' });

    const data = doc.data();
    const profile = data.profile;
    const submissions = data.submissions || [];

    if (!profile?.profileCompleted)
      return res.status(400).json({ success: false, error: 'Profile not completed', needsProfile: true });
    if (submissions.length < 3)
      return res.status(400).json({ success: false, error: `You need at least 3 checks for AI insights. You have ${submissions.length}. Keep going!` });

    const analysisResult = await getPersonalizedAnalysis(profile, submissions);
    if (!analysisResult.success) return res.status(500).json(analysisResult);

    res.json({ success: true, ...analysisResult, profile: { name: profile.name } });
  } catch (error) {
    console.error('AI analysis error:', error);
    res.status(500).json({ success: false, error: 'Failed to generate AI insights. Please try again.' });
  }
});

router.get('/today-count', requireDeviceId, async (req, res) => {
  try {
    const { deviceId } = req;
    const today = getCurrentDateIST();

    const cached = cacheGet(`${deviceId}:todayCount`);
    if (cached && cached.date === today) return res.json(cached);

    const doc = await getDb().collection('aliveChecks').doc(deviceId).get();
    if (!doc.exists) {
      const resp = { success: true, count: 0, remaining: MAX_DAILY_CHECKS, limit: MAX_DAILY_CHECKS, canCheck: true, profile: null, date: today };
      cacheSet(`${deviceId}:todayCount`, resp);
      return res.json(resp);
    }

    const data = doc.data();
    const todayCount = data.lastCheckDate === today ? (data.todayCount || 0) : 0;
    const remaining = Math.max(0, MAX_DAILY_CHECKS - todayCount);
    const resetTime = getNextMidnightIST();

    const resp = {
      success: true,
      count: todayCount,
      remaining,
      limit: MAX_DAILY_CHECKS,
      canCheck: todayCount < MAX_DAILY_CHECKS,
      resetIn: formatTimeUntilReset(resetTime),
      resetTime: new Date(resetTime).toISOString(),
      profile: data.profile || null,
      date: today
    };

    cacheSet(`${deviceId}:todayCount`, resp);
    res.json(resp);
  } catch (error) {
    console.error('Get today count error:', error);
    res.status(500).json({ success: false, error: 'Failed to get count' });
  }
});

router.delete('/history', requireDeviceId, async (req, res) => {
  try {
    const { deviceId } = req;
    await getDb().collection('aliveChecks').doc(deviceId).delete();
    cacheInvalidate(deviceId);
    console.log(`🗑️ All data deleted for ${deviceId}`);
    res.json({ success: true, message: 'All data deleted successfully' });
  } catch (error) {
    console.error('Delete history error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete history' });
  }
});

module.exports = router;