// 🫀 STILL ALIVE - PERSONALIZED ALIVE CHECK FEATURE
// ============================================
// v6.0 — LEADERBOARD + PRIVATE CIRCLES + CODE SYSTEM
// ============================================
// ✅ ENFORCED TOPIC DIVERSITY - Never boring, always fresh
// ✅ GEN Z VIRAL QUOTES - Screenshot-worthy every time
// ✅ HYPER-PERSONAL TIPS - Life-changing, not generic
// ✅ INTELLIGENT VARIED SCORING - Never repetitive
// ✅ 50+ Question Topics Bank per pillar
// ✅ MULTILINGUAL SUPPORT (6 languages)
// ✅ GLOBAL LEADERBOARD - Top 10 worldwide
// ✅ PRIVATE CIRCLES - Add family/friends (one-way)
// ✅ UNIFIED CODE SYSTEM - One code for everything
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
const MAX_CIRCLE_SIZE = 15; // ✅ NEW
const PILLAR_DECAY_START_DAYS = 7;   // decay kicks in after 7 days no check
const MAX_DECAY_PENALTY = 25;         // max 25pt deducted from stale pillar
const REQUIRED_PILLARS_FOR_COMPLETE_ALIVE = 4;

const PILLARS = {
  HEALTH: { id: 'health', name: 'Health', emoji: '💪', color: '#FF6B6B', weight: 0.30 },
  WEALTH: { id: 'wealth', name: 'Wealth', emoji: '💰', color: '#FFD93D', weight: 0.25 },
  LOVE: { id: 'love', name: 'Love', emoji: '❤️', color: '#FF6B9D', weight: 0.20 },
  PURPOSE: { id: 'purpose', name: 'Purpose', emoji: '🎯', color: '#A78BFA', weight: 0.25 }
};

// ✅ NEW - Relationship Types for Circles
const RELATIONSHIP_TYPES = {
  FAMILY: { id: 'family', emoji: '👨‍👩‍👧‍👦', label: 'Family' },
  FRIEND: { id: 'friend', emoji: '👥', label: 'Friend' },
  PARTNER: { id: 'partner', emoji: '❤️', label: 'Partner' },
  OTHER: { id: 'other', emoji: '🤝', label: 'Other' }
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
// 🔑 CODE GENERATION HELPER
// ============================================
function generateUniqueCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No confusing chars
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

async function ensureCodeExists(deviceId) {
  try {
    const db = getDb();

    // Check Still Alive users collection first
    const userDoc = await db.collection('users').doc(deviceId).get();
    if (userDoc.exists && userDoc.data().code) {
      return userDoc.data().code;
    }

    // Generate new code
    let code = generateUniqueCode();
    let attempts = 0;

    // Ensure uniqueness across both collections
    while (attempts < 10) {
      const [aliveCheckQuery, userQuery] = await Promise.all([
        db.collection('aliveChecks').where('profile.code', '==', code).limit(1).get(),
        db.collection('users').where('code', '==', code).limit(1).get()
      ]);

      if (aliveCheckQuery.empty && userQuery.empty) {
        break;
      }

      code = generateUniqueCode();
      attempts++;
    }

    // Save to users collection for consistency
    if (userDoc.exists) {
      await db.collection('users').doc(deviceId).update({ code });
    }

    return code;
  } catch (error) {
    console.error('Code generation error:', error);
    return generateUniqueCode(); // Fallback
  }
}

// ============================================
// 🎯 ENHANCED QUESTION TOPIC BANKS (60+ per pillar)
// ============================================

const QUESTION_TOPICS = {
  health: [
    // Sleep cluster
    'sleep_quality', 'sleep_duration', 'sleep_schedule', 'morning_feeling', 'naps', 'dreams_quality',
    // Energy cluster
    'energy_levels', 'vitality', 'physical_joy', 'aliveness_body', 'afternoon_slump', 'morning_energy',
    // Mental health cluster
    'stress_level', 'anxiety_state', 'mental_clarity', 'focus_ability', 'mood_stability', 'overwhelm', 'emotional_state',
    // Movement cluster
    'physical_movement', 'exercise_intensity', 'workout_consistency', 'flexibility', 'strength_feeling', 'endurance', 'movement_freedom',
    // Body comfort cluster
    'body_comfort', 'pain_level', 'muscle_tension', 'headaches', 'eye_strain', 'posture', 'breathing_ease',
    // Nutrition cluster
    'nutrition_quality', 'hydration', 'meal_satisfaction', 'eating_patterns', 'digestion', 'gut_feeling', 'hunger_cues',
    // Recovery cluster
    'rest_recovery', 'relaxation', 'breathing', 'tension_areas', 'recovery_quality', 'self_care_actions',
    // Lifestyle cluster
    'screen_time', 'outdoor_time', 'social_energy', 'alone_time', 'nature_connection', 'sunlight_exposure',
    // Self-perception cluster
    'body_image', 'physical_confidence', 'self_compassion', 'acceptance',
    // Prevention cluster
    'illness_prevention', 'immune_feeling', 'caffeine_intake', 'substance_use', 'medication_adherence'
  ],

  wealth: [
    // Financial security cluster
    'financial_confidence', 'money_anxiety', 'income_security', 'financial_stability', 'debt_stress', 'emergency_fund',
    // Spending/saving cluster
    'spending_control', 'saving_progress', 'budgeting', 'financial_planning', 'impulse_spending', 'financial_goals',
    // Career satisfaction cluster
    'career_satisfaction', 'work_meaning', 'job_fulfillment', 'purpose_at_work', 'impact_visibility', 'contribution_value',
    // Growth cluster
    'professional_growth', 'skill_development', 'learning_opportunities', 'industry_relevance', 'career_direction', 'advancement_opportunities',
    // Work environment cluster
    'work_life_balance', 'workload_management', 'time_freedom', 'schedule_control', 'remote_flexibility', 'commute_stress',
    // Recognition cluster
    'recognition', 'appreciation_at_work', 'compensation_satisfaction', 'benefits_adequacy', 'fair_treatment',
    // Relationships at work cluster
    'workplace_relationships', 'team_dynamics', 'leadership_quality', 'office_politics', 'collaboration_quality',
    // Autonomy cluster
    'creative_freedom', 'autonomy', 'decision_power', 'trust_from_leadership', 'micromanagement',
    // Stress/burnout cluster
    'job_stress', 'burnout_level', 'work_pressure', 'boundaries', 'after_hours_work', 'vacation_quality',
    // Future cluster
    'retirement_confidence', 'wealth_building', 'investment_confidence', 'passive_income', 'side_income', 'financial_freedom',
    // Network cluster
    'network_building', 'mentorship', 'professional_relationships', 'industry_connections'
  ],

  love: [
    // Connection depth cluster
    'relationship_quality', 'emotional_connection', 'emotional_intimacy', 'vulnerability', 'authentic_self', 'being_heard',
    // Feeling valued cluster
    'feeling_valued', 'feeling_supported', 'appreciation_received', 'recognition_from_loved_ones', 'being_there',
    // Communication cluster
    'meaningful_conversations', 'communication_quality', 'emotional_expression', 'active_listening', 'quality_conversations',
    // Conflict cluster
    'conflict_resolution', 'conflict_frequency', 'forgiveness', 'resentment', 'repair_after_conflict',
    // Safety cluster
    'relationship_safety', 'trust_level', 'emotional_safety', 'psychological_safety', 'acceptance',
    // Loneliness cluster
    'loneliness_level', 'social_connection', 'community_belonging', 'isolation_feeling', 'social_fulfillment',
    // Friendship cluster
    'friendship_quality', 'friend_support', 'meaningful_friendships', 'social_circle_satisfaction', 'friend_frequency',
    // Romantic cluster
    'romantic_satisfaction', 'physical_intimacy', 'romantic_connection', 'date_quality', 'affection',
    // Giving/receiving cluster
    'appreciation_given', 'acts_of_service', 'quality_time', 'giving_love', 'receiving_love', 'love_languages',
    // Family cluster
    'family_relationships', 'parent_child_bond', 'sibling_connection', 'extended_family', 'family_harmony',
    // Social energy cluster
    'social_energy', 'group_comfort', 'one_on_one_preference', 'social_battery', 'introvert_needs', 'extrovert_needs',
    // Growth cluster
    'relationship_growth', 'deepening_bonds', 'new_connections', 'maintaining_friendships', 'letting_go',
    // Communication modes cluster
    'digital_connection', 'in_person_time', 'phone_calls', 'texting_quality', 'video_calls',
    // Support cluster
    'asking_for_help', 'offering_help', 'mutual_support', 'showing_up', 'forgiveness_self'
  ],

  purpose: [
    // Meaning cluster
    'life_meaning', 'daily_meaning', 'work_purpose', 'existential_satisfaction', 'meaning_in_routine',
    // Contribution cluster
    'contribution_feeling', 'impact_on_others', 'helping_actions', 'service_mindset', 'legacy_thoughts', 'world_impact', 'local_impact',
    // Goals cluster
    'goal_progress', 'goal_clarity', 'direction_confidence', 'future_vision', 'milestone_achievement', 'priority_clarity',
    // Growth cluster
    'personal_growth', 'learning_today', 'skill_building', 'self_improvement', 'evolution', 'transformation',
    // Values cluster
    'values_alignment', 'authenticity', 'integrity', 'moral_compass', 'living_values', 'ethical_consistency',
    // Passion cluster
    'creative_expression', 'passion_pursuit', 'interests_exploration', 'curiosity', 'creative_flow', 'artistic_expression',
    // Satisfaction cluster
    'life_satisfaction', 'fulfillment', 'contentment', 'gratitude', 'appreciation', 'joy',
    // Future outlook cluster
    'future_optimism', 'hope_level', 'excitement', 'anticipation', 'dreams', 'aspirations',
    // Spiritual cluster
    'spiritual_connection', 'meditation_practice', 'mindfulness', 'presence', 'transcendence', 'inner_peace',
    // Self-knowledge cluster
    'identity_clarity', 'self_knowledge', 'strengths_awareness', 'weaknesses_acceptance', 'self_understanding',
    // Resilience cluster
    'challenge_embrace', 'growth_mindset', 'resilience', 'adaptability', 'overcoming_obstacles', 'perseverance',
    // Intentionality cluster
    'purposeful_actions', 'intentional_living', 'time_alignment', 'conscious_choices', 'deliberate_life',
    // Wisdom cluster
    'mentorship_giving', 'mentorship_receiving', 'wisdom_sharing', 'learning_from_others', 'teaching',
    // Impact cluster
    'contribution_size', 'ripple_effect', 'making_difference', 'positive_influence'
  ]
};

// ============================================
// 🎨 GEN Z VIRAL QUOTE TEMPLATES (diversity seeds)
// ============================================

const QUOTE_STYLES = [
  'raw_honest', 'poetic_short', 'confident_flex', 'vulnerable_real',
  'growth_moment', 'self_aware', 'motivational_edge', 'philosophical_simple',
  'relatable_struggle', 'victory_lap', 'boundary_setting', 'self_love'
];

const QUOTE_EXAMPLES = {
  thriving: [
    '"still becoming, still growing"',
    '"watched myself choose better today"',
    '"this is what alignment feels like"',
    '"not perfect but fully present"',
    '"leveling up in real time"'
  ],
  living: [
    '"doing the work, seeing results"',
    '"not where I was, proud of that"',
    '"showing up counts"',
    '"progress over perfection always"',
    '"building something real here"'
  ],
  surviving: [
    '"still here, still trying"',
    '"messy but moving forward"',
    '"giving myself credit today"',
    '"not my best but I showed up"',
    '"surviving is valid too"'
  ],
  struggling: [
    '"learning to be gentle with myself"',
    '"hard days don\'t define me"',
    '"starting again, that\'s brave"',
    '"growth isn\'t always visible"',
    '"tomorrow is a new chance"'
  ]
};

// ============================================
// SCORING RUBRICS — ENHANCED
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
    score_90_100: 'Excellent sleep (7-9hrs), high energy all day, moved their body joyfully, feels calm and comfortable, actively taking care of themselves. Everything working harmoniously.',
    score_70_89: 'Mostly good. Maybe one area slightly off (e.g., slightly tired but still functional, minor stress but manageable, or skipped exercise but still feel okay). Overall positive state.',
    score_50_69: 'Mixed signals. Some things okay, some not. Maybe tired but pushed through, or stressed but still moving, or good energy but poor sleep. Not thriving but not struggling badly.',
    score_30_49: 'Several things off. Poor sleep (less than 6hrs) OR high stress OR no movement OR body discomfort OR poor nutrition. Feeling drained or overwhelmed in at least one clear way.',
    score_0_29: 'Multiple serious issues. Very poor sleep (less than 4hrs) AND high stress AND no movement AND feeling terrible physically or mentally. Genuinely struggling to function.',
    context_rules: [
      'Sleep is THE foundation — poor sleep (less than 6 hours) automatically caps score at 60 maximum',
      'High stress/anxiety overrides other positive signals — severe anxiety caps at 50',
      'Movement matters but context matters — recovering from illness gets credit for any effort',
      'Mental state (anxiety/calm/overwhelm) should be weighted as heavily as physical state',
      'Consistency across answers matters — one bad signal in sea of good = 75+, multiple bad signals = 45 or below',
      'Energy level is a KEY integrator — if energy is very low despite good sleep, investigate stress/nutrition/movement'
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
    score_90_100: 'Feels financially secure and confident, work is satisfying and meaningful, making clear progress on financial/career goals, minimal money stress, excellent work-life balance, growing professionally.',
    score_70_89: 'Generally stable. Maybe one concern (small financial stress OR work feeling slightly tedious OR slow progress) but overall in a good place. Moving forward steadily.',
    score_50_69: 'Uncertain territory. Financial stress is present OR work feels stagnant OR progress feels slow OR work-life balance is suffering. Not in crisis but not thriving either.',
    score_30_49: 'Clear stress in this area. Money worries are real and constant OR career feels stuck or unfulfilling OR work-life balance is poor OR burnout is approaching. Weighing heavily on them.',
    score_0_29: 'Serious financial/career distress. Major financial anxiety with no clear path forward AND career dissatisfaction AND feeling trapped or hopeless about financial or professional future.',
    context_rules: [
      'Financial STRESS is the single biggest signal — severe money anxiety caps score at 40 regardless of income level',
      'Work satisfaction can compensate for lower income IF financial stress is manageable',
      'Work-life balance matters enormously — signs of burnout cap score at 50',
      'Progress does not have to be big — small consistent movement toward goals counts heavily',
      'Feeling in control of money matters MORE than absolute amount — someone with less money but a plan can score higher than wealthy but anxious'
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
    score_90_100: 'Feeling deeply connected to loved ones, had meaningful interactions today, feels valued and supported by multiple people, relationships are nourishing, can be authentic. Heart is full.',
    score_70_89: 'Good connection overall. Maybe did not have a deep conversation today but feels secure in relationships. Feels warm and supported. No major relationship stress.',
    score_50_69: 'Some connection but something feels off. Maybe lonely despite being around people, or a relationship feels strained, or missing deep connection. Okay but not great.',
    score_30_49: 'Feeling disconnected or unsupported. Loneliness is real OR a key relationship is strained/conflict OR feeling unvalued OR can\'t be authentic. This pillar needs attention.',
    score_0_29: 'Deep loneliness or relational pain. Feeling truly alone and unsupported, OR dealing with serious relationship conflict, OR feeling fundamentally misunderstood or rejected.',
    context_rules: [
      'Loneliness is the BIGGEST negative signal — but even ONE meaningful connection can significantly boost score',
      'Quality over quantity ALWAYS — one deep connection beats ten shallow ones',
      'Feeling valued by even ONE person matters enormously — can lift score from 40 to 65+',
      'Appreciation (giving or receiving) is a strong positive signal — shows active relationship engagement',
      'Emotional safety is critical — if they can\'t be themselves, cap score at 55 even if other factors are good',
      'Recent meaningful conversation is huge — having one today can boost score by 15-20 points'
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
    score_90_100: 'Today felt deeply meaningful. Working on something that truly matters. Growing and learning actively. Crystal clear sense of direction. Life feels purposeful and aligned. Optimistic about future.',
    score_70_89: 'Generally on track. Maybe today was routine but the bigger picture feels good. Some growth happening. Direction is clear enough. Feel okay about where life is headed.',
    score_50_69: 'Drifting a bit. Today did not feel very meaningful OR unsure about direction OR not making progress on what matters OR questioning current path. Searching for clarity.',
    score_30_49: 'Feeling lost or stuck. Life does not feel meaningful, no clear direction, not growing, OR deeply misaligned with own values. Existential questions without answers.',
    score_0_29: 'Existential crisis. Feeling truly purposeless, completely lost, no meaning in daily life, no growth, deeply misaligned with everything that should matter. Questioning everything.',
    context_rules: [
      'Meaning is subjective — routine day can still score high if person feels purpose behind it',
      'Growth does not have to be dramatic — small learning moments or insights count significantly',
      'Values alignment is HUGE — doing something that conflicts with core values tanks this score below 40',
      'Clarity of direction matters more than speed of progress — clear slow > fast unclear',
      'Feeling of contribution is powerful — even small acts of helping or creating can boost score 10-15 points',
      'Future optimism is a key indicator — if hopeless about future, cap at 45 even if present feels okay'
    ]
  }
};

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
  if (score >= 71) return { vibe: 'THRIVING', emoji: '🔥' };
  if (score >= 51) return { vibe: 'LIVING', emoji: '⚡' };
  return { vibe: 'SURVIVING', emoji: '🌱' };
};

const getAgeGroupLabel = (ag) => ({
  '18-24': 'Young Adult', '25-34': 'Adult', '35-44': 'Mid Adult',
  '45-54': 'Mature Adult', '55-64': 'Senior Adult', '65+': 'Elder'
}[ag] || 'Adult');

// ============================================
// 🎲 DIVERSITY SEED GENERATOR
// ============================================
function getDiversitySeed(deviceId, checkCount, pillar) {
  const timestamp = Date.now();
  const hash = (deviceId + checkCount + pillar + timestamp).split('').reduce((a, b) => {
    a = ((a << 5) - a) + b.charCodeAt(0);
    return a & a;
  }, 0);
  return Math.abs(hash) % 1000;
}

// ============================================
// 🧠 AI PILLAR SCORING ENGINE — ENHANCED WITH VARIETY
// ============================================

async function aiScorePillar(profile, pillar, questions, answers, submissions) {
  const { name, ageGroup, gender, language } = profile;
  const userLanguage = language || 'en';
  const displayAge = ageGroup ? getAgeGroupLabel(ageGroup) : 'Adult';
  const rubric = SCORING_RUBRICS[pillar];
  const pillarMeta = PILLARS[pillar.toUpperCase()];

  const diversitySeed = getDiversitySeed(profile.name, submissions.length, pillar);
  const scoringStyle = diversitySeed % 3 === 0 ? 'analytical_precise' :
    diversitySeed % 3 === 1 ? 'contextual_nuanced' : 'pattern_based';

  const qaFormatted = questions.map((q, i) => {
    const raw = answers[i]?.answer !== undefined ? answers[i].answer : answers[i];
    const answerValue = typeof raw === 'object' && raw !== null ? (raw.answer ?? JSON.stringify(raw)) : raw;
    return `  Q${i + 1}: ${q.text}\n  A${i + 1}: ${answerValue}`;
  }).join('\n\n');

  const prevSamePillar = submissions
    .filter(s => s.pillar === pillar)
    .slice(0, 5);

  const previousScoresContext = prevSamePillar.length > 0
    ? prevSamePillar.map(s => `  ${s.date}: ${s.pillarScores?.[pillar] ?? s.score}/100`).join('\n')
    : '  No previous checks on this pillar';

  const prevQAContext = prevSamePillar.length > 0
    ? prevSamePillar.map(s => {
      const qa = (s.questions || []).map((q, idx) => {
        const a = s.answers?.[idx]?.answer?.answer ?? s.answers?.[idx]?.answer ?? '—';
        return `${q.text} → ${a}`;
      }).join('; ');
      return `  [${s.date}] ${qa}`;
    }).join('\n')
    : '  No previous Q&A on this pillar';

  const scoringApproachInstructions = {
    analytical_precise: `Use a methodical approach: Score each answer 1-10, identify the 2 strongest and 2 weakest signals, apply context rules strictly, calculate weighted average with emphasis on critical factors.`,
    contextual_nuanced: `Consider the bigger picture: How do answers relate to each other? Are there contradictions? What's the underlying pattern? Let context override individual signals when appropriate.`,
    pattern_based: `Compare to their history: Is this better/worse than usual? What changed? Focus on trends and deviations from their personal baseline.`
  };

  const prompt = `CRITICAL INSTRUCTIONS - READ CAREFULLY:

Your justification MUST be in ${getLanguageName(userLanguage)} language.
Respond ONLY with valid JSON. The "justification" field must be in ${getLanguageName(userLanguage)}.

You are an expert wellness psychologist scoring ${name}'s ${rubric.name} pillar. This score will impact their life decisions, so THINK DEEPLY and be PRECISE.

🎯 SCORING APPROACH FOR THIS CHECK: ${scoringStyle.toUpperCase()}
${scoringApproachInstructions[scoringStyle]}

═══════════════════════════════════════════
👤 PERSON: ${name} | ${displayAge} | ${gender}
═══════════════════════════════════════════

═══════════════════════════════════════════
📝 TODAY'S ANSWERS (${pillarMeta?.emoji} ${rubric.name}) — 8 DEEP QUESTIONS:
${qaFormatted}
═══════════════════════════════════════════

═══════════════════════════════════════════
📊 THEIR ${rubric.name.toUpperCase()} SCORE HISTORY (look for patterns):
${previousScoresContext}
═══════════════════════════════════════════

═══════════════════════════════════════════
📝 THEIR PREVIOUS ${rubric.name.toUpperCase()} ANSWERS (spot changes):
${prevQAContext}
═══════════════════════════════════════════

═══════════════════════════════════════════
📖 ${rubric.name.toUpperCase()} PILLAR DEFINITION:
${rubric.description}

What REALLY matters in this pillar (prioritize these):
${rubric.what_matters.map(w => `  • ${w}`).join('\n')}
═══════════════════════════════════════════

═══════════════════════════════════════════
📊 SCORING RUBRIC — MATCH THEIR REALITY TO THESE BANDS:

🟢 90-100 (EXCEPTIONAL): ${rubric.score_90_100}
🟡 70-89 (SOLID):  ${rubric.score_70_89}
🟠 50-69 (MIXED):  ${rubric.score_50_69}
🔴 30-49 (STRUGGLING):  ${rubric.score_30_49}
🔵 0-29 (CRISIS):   ${rubric.score_0_29}
═══════════════════════════════════════════

═══════════════════════════════════════════
⚡ CRITICAL CONTEXT RULES — THESE ARE NON-NEGOTIABLE:
${rubric.context_rules.map(r => `  • ${r}`).join('\n')}
═══════════════════════════════════════════

🎯 YOUR SCORING PROCESS (take your time):

STEP 1: Read ALL 8 answers carefully. Notice specifics, not just numbers.
STEP 2: Identify the STRONGEST positive signal (what's working best?)
STEP 3: Identify the BIGGEST red flag (what's most concerning?)
STEP 4: Apply context rules — do any override your initial assessment?
STEP 5: Compare to their history — is this a pattern or an anomaly?
STEP 6: Match to the rubric bands — where do they truly fit?
STEP 7: Assign ONE honest score (0-100) that captures their current state
STEP 8: Write a UNIQUE justification that references SPECIFIC answers (avoid phrases you've used before)

CRITICAL RULES FOR VARIETY:
- Use DIFFERENT reasoning each time — vary your analytical lens
- Reference DIFFERENT answer details each check — don't repeat patterns
- Vary your justification structure — sometimes start with strength, sometimes weakness, sometimes context
- Use diverse vocabulary — avoid repetitive phrases like "overall good" or "some concerns"

Respond ONLY with valid JSON:
{
  "score": <number 0-100>,
  "justification": "<1 unique sentence in ${getLanguageName(userLanguage)}, max 25 words, reference SPECIFIC answer with fresh perspective>"
}`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are an expert wellness psychologist. Score accurately based on rubrics. Think deeply before scoring. VARY your approach each time. Respond ONLY with valid JSON. No markdown.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 200,
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
// ============================================
// V7 ALIVE SCORE — REAL DATA ONLY + DECAY
// ============================================

function getDaysSince(isoTimestamp) {
  if (!isoTimestamp) return 999;
  const diff = Date.now() - new Date(isoTimestamp).getTime();
  return Math.floor(diff / 86400000);
}

function applyDecayPenalty(score, daysSinceLastCheck) {
  if (daysSinceLastCheck <= 7) return score; // No decay within 7 days
  const extraDays = daysSinceLastCheck - 7;
  const penalty = Math.min(25, Math.floor(extraDays * 1.5)); // Max 25pt penalty
  return Math.max(0, score - penalty);
}

function calculateAliveScore(todayPillar, todayPillarScore, submissions) {
  // Build real pillar data from history — NO DEFAULTS
  const pillarData = {};

  for (const key of Object.keys(PILLARS)) {
    const pid = PILLARS[key].id;
    const pillarSubs = submissions.filter(
      s => s.pillar === pid && s.pillarScores && s.pillarScores[pid] !== undefined
    );

    if (pid === todayPillar) {
      // Today's fresh score — no decay
      pillarData[pid] = {
        score: todayPillarScore,
        hasRealData: true,
        daysSinceLastCheck: 0,
        source: 'scored_today'
      };
    } else if (pillarSubs.length > 0) {
      // Real historical data exists — apply weighted avg + decay
      const scores = pillarSubs.map(s => s.pillarScores[pid]);
      const timestamps = pillarSubs.map(s => s.timestamp);

      // Weighted average — most recent counts more
      let weightSum = 0, valSum = 0;
      scores.forEach((s, i) => {
        const w = scores.length - i;
        valSum += s * w;
        weightSum += w;
      });
      const rawScore = Math.round(valSum / weightSum);
      const daysSince = getDaysSince(timestamps[0]);
      const decayedScore = applyDecayPenalty(rawScore, daysSince);

      pillarData[pid] = {
        score: decayedScore,
        rawScore,
        hasRealData: true,
        daysSinceLastCheck: daysSince,
        source: 'historical_with_decay'
      };
    } else {
      // NO real data — exclude from alive score calculation
      pillarData[pid] = {
        score: null,
        hasRealData: false,
        daysSinceLastCheck: null,
        source: 'no_data'
      };
    }
  }

  // Only calculate alive score using pillars with real data
  const pillarsWithData = Object.keys(PILLARS).filter(
    k => pillarData[PILLARS[k].id].hasRealData
  );

  const aliveScoreComplete = pillarsWithData.length === REQUIRED_PILLARS_FOR_COMPLETE_ALIVE;

  // Normalise weights for pillars we actually have data for
  let totalWeight = pillarsWithData.reduce((sum, k) => sum + PILLARS[k].weight, 0);
  let aliveScore = 0;
  for (const key of pillarsWithData) {
    const pid = PILLARS[key].id;
    const normalisedWeight = PILLARS[key].weight / totalWeight;
    aliveScore += pillarData[pid].score * normalisedWeight;
  }
  aliveScore = Math.round(aliveScore);

  // Build pillarScores map — null for pillars with no data
  const pillarScores = {};
  for (const key of Object.keys(PILLARS)) {
    const pid = PILLARS[key].id;
    pillarScores[pid] = pillarData[pid].hasRealData ? pillarData[pid].score : null;
  }

  const breakdown = Object.keys(PILLARS).map(k => {
    const p = PILLARS[k];
    const pd = pillarData[p.id];
    return {
      pillar: p.id,
      name: p.name,
      emoji: p.emoji,
      score: pd.score,
      rawScore: pd.rawScore || pd.score,
      weight: p.weight,
      contribution: pd.hasRealData ? Math.round(pd.score * p.weight) : null,
      isToday: p.id === todayPillar,
      hasRealData: pd.hasRealData,
      daysSinceLastCheck: pd.daysSinceLastCheck,
      source: pd.source
    };
  }).sort((a, b) => (b.score || 0) - (a.score || 0));

  const pillarsWithRealData = breakdown.filter(b => b.hasRealData);
  const strongest = pillarsWithRealData[0] || null;
  const weakest = pillarsWithRealData[pillarsWithRealData.length - 1] || null;
  const missingPillars = breakdown.filter(b => !b.hasRealData).map(b => b.name);

  return {
    aliveScore,
    aliveScoreComplete,           // ← FE uses this to gate alive score display
    pillarsCheckedCount: pillarsWithData.length,
    missingPillars,               // ← FE shows "check X to unlock Alive Score"
    pillarScores,
    breakdown,
    strongest: strongest?.pillar || null,
    weakest: weakest?.pillar || null,
    scoringExplanation: aliveScoreComplete
      ? `Your ${strongest?.name} (${strongest?.score}) is strongest. ${weakest?.name} (${weakest?.score}) needs attention.`
      : `Complete ${missingPillars.join(', ')} checks to unlock your full Alive Score.`
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
// 🔥 INDIVIDUAL TIP GENERATOR — HYPER-PERSONAL 10/10
// ============================================

async function generateIndividualTip(profile, pillar, questions, answers, todayPillarScore, submissions) {
  const { name, language, ageGroup } = profile;
  const userLanguage = language || 'en';
  const pillarMeta = PILLARS[pillar.toUpperCase()];

  const diversitySeed = getDiversitySeed(name, submissions.length, pillar);
  const tipStyle = diversitySeed % 4 === 0 ? 'immediate_action' :
    diversitySeed % 4 === 1 ? 'reframe_perspective' :
      diversitySeed % 4 === 2 ? 'habit_building' : 'self_compassion';

  const qaContext = questions.map((q, i) => {
    const raw = answers[i]?.answer !== undefined ? answers[i].answer : answers[i];
    const answerValue = typeof raw === 'object' && raw !== null ? (raw.answer ?? JSON.stringify(raw)) : raw;
    return `Q: ${q.text}\nA: ${answerValue}`;
  }).join('\n\n');

  const recentTips = submissions
    .filter(s => s.individualTip)
    .slice(0, 3)
    .map(s => s.individualTip)
    .join(' | ');

  const tipStyleInstructions = {
    immediate_action: 'Give a SPECIFIC action they can do in the next 2 hours. Be concrete.',
    reframe_perspective: 'Offer a new way to view their situation that empowers them.',
    habit_building: 'Suggest a micro-habit they can start TODAY that compounds over time.',
    self_compassion: 'Remind them to be kind to themselves while taking one small step.'
  };

  const prompt = `CRITICAL: This tip will be read by ${name}. Make it HYPER-PERSONAL and IMMEDIATELY ACTIONABLE.

The tip MUST be in ${getLanguageName(userLanguage)} language.
Respond ONLY with valid JSON. The "tip" field must be in ${getLanguageName(userLanguage)}.

You are Dr. Sarah, ${name}'s personal wellness coach. Give them ONE specific action that will make a REAL difference in the next 24-48 hours.

🎯 TIP STYLE FOR THIS CHECK: ${tipStyle.toUpperCase()}
${tipStyleInstructions[tipStyle]}

📝 ${name}'S ANSWERS TODAY:
${qaContext}

📊 Their ${pillarMeta?.name} score: ${todayPillarScore}/100

🚫 RECENT TIPS (DO NOT REPEAT THESE PATTERNS):
${recentTips || 'First tip'}

🎯 GENERATE ONE TIP THAT:
✅ References their ACTUAL answers (quote something specific they said)
✅ Is actionable within 24-48 hours (not vague like "take care of yourself")
✅ Feels personal to ${name} (use their name ONLY if it flows naturally)
✅ Addresses their BIGGEST opportunity based on their answers
✅ Is encouraging but honest (no toxic positivity)
✅ Is 15-25 words (short and punchy)
✅ Is DIFFERENT from recent tips in approach and wording
✅ Matches the ${tipStyle} style
✅ Is in ${getLanguageName(userLanguage)} language

BAD TIP EXAMPLES (too generic):
❌ "Make sure to get enough rest tonight"
❌ "Try to reduce stress levels"
❌ "Focus on your wellbeing"
❌ "Take time for self-care"

GREAT TIP EXAMPLES (specific and actionable):
✅ "Your 3/5 sleep tells me bedtime is slipping — set a 10pm alarm tonight and honor it"
✅ "You said no meaningful conversation today — text your best friend right now and ask one real question"
✅ "That 2/5 energy with good sleep means movement is missing — 15-minute walk after this, no excuses"
✅ "You're being too hard on yourself about that setback — write down one thing you did right today"

Now generate THE perfect tip for ${name} based on their answers:

Respond ONLY with valid JSON:
{"tip": "your hyper-specific tip in ${getLanguageName(userLanguage)}"}`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are Dr. Sarah, a direct and caring wellness coach. Be specific, not generic. VARY your tips each time. Respond ONLY with valid JSON. No markdown.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.85,
      max_tokens: 100,
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
// 💬 QUOTE + STRATEGIC TIPS — GEN Z VIRAL 10/10
// ============================================

async function generateQuoteAndStrategicTips(profile, todayPillar, questions, answers, pillarScores, aliveScore, scoringJustification, submissions) {
  const { name, ageGroup, gender, language } = profile;
  const userLanguage = language || 'en';
  const displayAge = ageGroup ? getAgeGroupLabel(ageGroup) : 'Adult';
  const pillarMeta = PILLARS[todayPillar.toUpperCase()];

  const diversitySeed = getDiversitySeed(name, submissions.length, todayPillar);
  const quoteStyle = QUOTE_STYLES[diversitySeed % QUOTE_STYLES.length];
  const { vibe } = getVibeFromScore(aliveScore);
  const vibeKey = vibe.toLowerCase();
  const exampleQuotes = QUOTE_EXAMPLES[vibeKey] || QUOTE_EXAMPLES.living;

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

  const recentQuotes = submissions
    .filter(s => s.quote)
    .slice(0, 5)
    .map(s => s.quote)
    .join(' | ');

  const recentStrategicTips = submissions
    .filter(s => s.strategicTips && s.strategicTips.length > 0)
    .slice(0, 2)
    .flatMap(s => s.strategicTips)
    .join(' | ');

  const quotePrompt = `CRITICAL: This quote will be SHARED on social media. Make it VIRAL-WORTHY and AUTHENTIC to Gen Z.

Quote and message MUST be in ${getLanguageName(userLanguage)} language.
Respond ONLY with valid JSON. Both fields must be in ${getLanguageName(userLanguage)}.

${name} is a ${displayAge} who just scored ${aliveScore}/100 on their aliveness.
Their vibe: ${vibe}
Their ${pillarMeta?.name} score: ${pillarScores[todayPillar]}/100
Scoring reason: ${scoringJustification}

Their answers today:
${qaContext}

🎨 QUOTE STYLE FOR THIS CHECK: ${quoteStyle.toUpperCase()}
Use this style to inform your tone and approach.

📱 EXAMPLE VIRAL QUOTES FOR ${vibe} VIBE:
${exampleQuotes.join('\n')}

🚫 RECENT QUOTES (DO NOT REPEAT THESE):
${recentQuotes || 'First quote'}

🎯 CREATE A QUOTE THAT:
✅ Is 4-7 words (short and punchy)
✅ Feels like something ${name} would actually say
✅ Is shareable (Gen Z would screenshot this)
✅ Captures their VIBE today (not fake motivation)
✅ Uses lowercase (Gen Z authentic style)
✅ NO emoji in the quote itself
✅ Is COMPLETELY DIFFERENT from recent quotes
✅ Matches the ${quoteStyle} style
✅ Is in ${getLanguageName(userLanguage)} language

BAD QUOTE EXAMPLES (too generic/cringe):
❌ "Keep pushing forward, ${name}!"
❌ "You are worthy of love"
❌ "Believe in yourself always"
❌ "Stay positive!"

GREAT QUOTE EXAMPLES (authentic/shareable):
✅ "still becoming, still growing"
✅ "watched myself choose me today"
✅ "this is what growth feels like"
✅ "not perfect but present"
✅ "doing the work, seeing results"

Also write a MESSAGE (1 sentence, max 20 words) that references something SPECIFIC from their answers.

Respond ONLY with valid JSON:
{"quote": "viral-worthy quote in ${getLanguageName(userLanguage)}", "message": "specific message in ${getLanguageName(userLanguage)}"}`;

  const tipsPrompt = `CRITICAL: These tips will guide ${name}'s next week. Make them STRATEGIC and ACTIONABLE.

All tips MUST be in ${getLanguageName(userLanguage)} language.
Respond ONLY with valid JSON. All fields must be in ${getLanguageName(userLanguage)}.

${name} | ${displayAge} | ${gender}

📊 CURRENT STATE:
${pillarSummary}
💪 Strongest: ${PILLARS[strongest[0]?.toUpperCase()]?.name || strongest[0]} (${strongest[1]}/100)
⚠️ Weakest: ${PILLARS[weakest[0]?.toUpperCase()]?.name || weakest[0]} (${weakest[1]}/100)
Overall Alive Score: ${aliveScore}/100

📝 Today's ${pillarMeta?.name} answers:
${qaContext}

📈 Recent trend:
${recentTrend || 'First check-in'}

🚫 RECENT STRATEGIC TIPS (DO NOT REPEAT THESE PATTERNS):
${recentStrategicTips || 'First tips'}

🎯 GENERATE 3 STRATEGIC TIPS:

RULES:
✅ At least 1 tip MUST connect TWO pillars (e.g., "Your strong Love can fuel your Purpose this week")
✅ Tips are STRATEGIC — what to focus on THIS WEEK, not just today
✅ Each tip: 1 sentence, 18-25 words
✅ Reference their actual scores/patterns (not generic advice)
✅ Warm but direct tone (no fluff)
✅ Use ${name} in maximum 1 tip, ONLY if it flows naturally
✅ VARY from recent tips — use different angles and wording
✅ Be SPECIFIC about actions, not vague encouragement
✅ ALL tips in ${getLanguageName(userLanguage)} language

BAD TIP EXAMPLES (too generic):
❌ "Try to eat healthier this week"
❌ "Make time for yourself"
❌ "Stay positive"
❌ "Focus on your goals"

GREAT TIP EXAMPLES (strategic and specific):
✅ "Your Health (85) is your foundation — use that energy to tackle your Wealth goals (58) this week"
✅ "Schedule one 30-min money review this Sunday to reduce that financial anxiety you mentioned"
✅ "Your Love connections (72) are solid — invite someone to that workout you've been skipping"
✅ "That Purpose clarity you found needs action — pick one goal and take the smallest step this week"

Also identify the weakest pillar and give ONE specific weekly boost action (max 25 words) in ${getLanguageName(userLanguage)}.

Respond ONLY with valid JSON:
{
  "tips": ["tip1 in ${getLanguageName(userLanguage)}", "tip2 in ${getLanguageName(userLanguage)}", "tip3 in ${getLanguageName(userLanguage)}"],
  "weakestPillar": "pillar_id",
  "weakestBoost": "specific weekly action in ${getLanguageName(userLanguage)}"
}`;

  const [quoteRes, tipsRes] = await Promise.allSettled([
    openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You write viral Gen Z quotes. Be authentic, not cringe. VARY every quote. Respond ONLY with valid JSON. No markdown.' },
        { role: 'user', content: quotePrompt }
      ],
      temperature: 0.9,
      max_tokens: 150,
    }),
    openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are Dr. Maya, a strategic wellness coach. Be specific, not generic. VARY your tips. Respond ONLY with valid JSON. No markdown.' },
        { role: 'user', content: tipsPrompt }
      ],
      temperature: 0.8,
      max_tokens: 350,
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
// 📝 ADAPTIVE QUESTION GENERATION — ENFORCED DIVERSITY 10/10
// ============================================

const generatePersonalizedQuestions = async (profile, selectedPillar, previousSubmissions = []) => {
  const { name, ageGroup, gender, language } = profile;
  const userLanguage = language || 'en';
  const displayAge = ageGroup ? getAgeGroupLabel(ageGroup) : 'Adult';
  const pillarMeta = PILLARS[selectedPillar.toUpperCase()];
  const rubric = SCORING_RUBRICS[selectedPillar];
  const topicsBank = QUESTION_TOPICS[selectedPillar] || [];

  const samePillarHistory = previousSubmissions
    .filter(s => s.pillar === selectedPillar)
    .slice(0, 3);

  const previouslyAskedQuestions = samePillarHistory
    .flatMap(s => (s.questions || []).map(q => q.text))
    .join('; ');

  const previousTopicsUsed = samePillarHistory
    .flatMap(s => (s.questions || []).map(q => {
      return topicsBank.find(topic => q.text.toLowerCase().includes(topic.replace(/_/g, ' ')));
    }))
    .filter(Boolean);

  const diversitySeed = getDiversitySeed(name, previousSubmissions.length, selectedPillar);
  const shuffledTopics = [...topicsBank].sort(() => 0.5 - Math.random());

  const availableTopics = shuffledTopics.filter(t => !previousTopicsUsed.includes(t));
  const selectedTopics = availableTopics.slice(0, 8);

  if (selectedTopics.length < 8) {
    const remaining = shuffledTopics.filter(t => !selectedTopics.includes(t));
    selectedTopics.push(...remaining.slice(0, 8 - selectedTopics.length));
  }

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

  const prompt = `CRITICAL: Generate DIVERSE, DEEP questions that feel personal to ${name}.

ALL questions MUST be in ${getLanguageName(userLanguage)} language.
Questions text, options, labels - EVERYTHING must be in ${getLanguageName(userLanguage)}.
Respond ONLY with valid JSON. No markdown.

You are Dr. Sarah creating 8 wellness questions for ${name}.

👤 USER PROFILE:
- Name: ${name}
- Age: ${displayAge}
- Gender: ${gender}
- Language: ${getLanguageName(userLanguage)}
- Today's focus: ${pillarMeta?.emoji} ${pillarMeta?.name}
- Other pillars: ${pillarContext}

${adaptiveContext ? `📝 PREVIOUS ${pillarMeta?.name.toUpperCase()} CHECK-INS:\n${adaptiveContext}` : `📝 First time checking ${pillarMeta?.name} — make it welcoming but deep.`}

🚫 PREVIOUSLY ASKED QUESTIONS (NEVER repeat these):
${previouslyAskedQuestions || 'None yet'}

🚫 PREVIOUSLY USED TOPICS (avoid these):
${previousTopicsUsed.join(', ') || 'None yet'}

🎯 REQUIRED TOPICS FOR THIS CHECK (use EXACTLY these 8 topics, one per question):
${selectedTopics.map((t, i) => `Q${i + 1}: ${t}`).join('\n')}

📖 ${pillarMeta?.name.toUpperCase()} MEASUREMENT PRIORITIES:
${rubric.what_matters.map(w => `  • ${w}`).join('\n')}

⚡ KEY SIGNALS TO UNCOVER:
${rubric.context_rules.map(r => `  • ${r}`).join('\n')}

🎯 CREATE 8 QUESTIONS THAT:

CRITICAL REQUIREMENTS:
✅ EXACTLY: 3 scale (1-5), 3 yesno, 2 choice
✅ Each question MUST address ONE of the required topics above (in order: Q1 = topic 1, Q2 = topic 2, etc.)
✅ NEVER repeat questions from their history
✅ If they scored low before, dig into WHY with different angle
✅ If they scored high before, explore DEPTH (what's working specifically?)
✅ Use ${name} in only 1-2 questions max (feels personal, not robotic)
✅ Conversational, age-appropriate for ${displayAge}
✅ Choice questions: 4-5 options, ordered worst to best
✅ Questions reveal the KEY SIGNALS from context rules
✅ Mix of concrete (sleep hours) and emotional (how do you feel)
✅ ALL text in ${getLanguageName(userLanguage)} language

TOPIC-TO-QUESTION MAPPING EXAMPLES:
- sleep_quality → "How would you rate the quality of your sleep last night?"
- financial_confidence → "When you think about your finances, how confident do you feel?"
- emotional_connection → "How emotionally connected did you feel to loved ones today?"
- life_meaning → "How meaningful did today feel to you?"

QUESTION QUALITY STANDARDS:
🟢 GREAT: "How many hours of sleep did you actually get last night?" (specific, measurable)
🟢 GREAT: "When you think about money right now, what's the first feeling that comes up?" (emotional depth)
🟢 GREAT: "Did you have a conversation today that made you feel truly understood?" (relationship quality)
🔴 BAD: "How is your health?" (too vague)
🔴 BAD: "Are you stressed?" (too simple, already asked before probably)
🔴 BAD: "Do you feel good?" (meaningless)

Respond with valid JSON (NO MARKDOWN):
{
  "questions": [
    {"id":"q1","pillar":"${selectedPillar}","text":"question about ${selectedTopics[0]} in ${getLanguageName(userLanguage)}","type":"scale","min":1,"max":5,"labels":["Low label","High label"]},
    {"id":"q2","pillar":"${selectedPillar}","text":"question about ${selectedTopics[1]} in ${getLanguageName(userLanguage)}","type":"yesno"},
    {"id":"q3","pillar":"${selectedPillar}","text":"question about ${selectedTopics[2]} in ${getLanguageName(userLanguage)}","type":"choice","options":["Worst","Bad","Okay","Good","Best"]},
    {"id":"q4","pillar":"${selectedPillar}","text":"question about ${selectedTopics[3]} in ${getLanguageName(userLanguage)}","type":"scale","min":1,"max":5,"labels":["Low label","High label"]},
    {"id":"q5","pillar":"${selectedPillar}","text":"question about ${selectedTopics[4]} in ${getLanguageName(userLanguage)}","type":"yesno"},
    {"id":"q6","pillar":"${selectedPillar}","text":"question about ${selectedTopics[5]} in ${getLanguageName(userLanguage)}","type":"scale","min":1,"max":5,"labels":["Low label","High label"]},
    {"id":"q7","pillar":"${selectedPillar}","text":"question about ${selectedTopics[6]} in ${getLanguageName(userLanguage)}","type":"yesno"},
    {"id":"q8","pillar":"${selectedPillar}","text":"question about ${selectedTopics[7]} in ${getLanguageName(userLanguage)}","type":"choice","options":["Worst","Bad","Okay","Good","Best"]}
  ]
}`;

  try {
    console.log(`🤖 Generating 8 diverse ${pillarMeta?.name} questions for ${name} in ${getLanguageName(userLanguage)}...`);
    console.log(`🎯 Selected topics: ${selectedTopics.join(', ')}`);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are Dr. Sarah, expert at creating diverse, deep wellness questions. Follow topic requirements strictly. Avoid repetition. Be specific. Respond ONLY with valid JSON, no markdown.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.85,
      max_tokens: 1200,
    });

    let txt = completion.choices[0].message.content.trim().replace(/```json\n?/g, '').replace(/```\n?/g, '');
    const parsed = JSON.parse(txt);

    if (!parsed.questions || parsed.questions.length !== 8) throw new Error('Bad question count');

    parsed.questions.forEach(q => {
      if (q.type === 'choice' && (!Array.isArray(q.options) || q.options.length < 4)) {
        q.options = ['Very Bad', 'Bad', 'Okay', 'Good', 'Great'];
      }
    });

    console.log(`✅ Generated 8 diverse ${pillarMeta?.name} questions for ${name} in ${getLanguageName(userLanguage)}`);
    return { success: true, questions: parsed.questions };

  } catch (error) {
    console.error('Question generation error:', error.message);

    const fallbacks = {
      health: [
        { id: 'q1', pillar: 'health', text: 'How many hours of sleep did you get last night?', type: 'scale', min: 1, max: 5, labels: ['Less than 4hrs', '8+ hours'] },
        { id: 'q2', pillar: 'health', text: 'Did you move your body for at least 20 minutes today?', type: 'yesno' },
        { id: 'q3', pillar: 'health', text: 'How would you describe your energy level right now?', type: 'choice', options: ['Completely drained', 'Low energy', 'Okay', 'Good energy', 'Fully energized'] },
        { id: 'q4', pillar: 'health', text: 'How stressed or anxious are you feeling?', type: 'scale', min: 1, max: 5, labels: ['Very stressed', 'Completely calm'] },
        { id: 'q5', pillar: 'health', text: 'Did you eat at least one nourishing meal today?', type: 'yesno' },
        { id: 'q6', pillar: 'health', text: 'How clear and focused is your mind?', type: 'scale', min: 1, max: 5, labels: ['Very foggy', 'Crystal clear'] },
        { id: 'q7', pillar: 'health', text: 'Are you experiencing any physical pain or discomfort?', type: 'yesno' },
        { id: 'q8', pillar: 'health', text: 'Overall, how does your body feel right now?', type: 'choice', options: ['Terrible', 'Uncomfortable', 'Neutral', 'Good', 'Amazing'] },
      ],
      wealth: [
        { id: 'q1', pillar: 'wealth', text: 'How confident do you feel about your finances right now?', type: 'scale', min: 1, max: 5, labels: ['Very anxious', 'Very confident'] },
        { id: 'q2', pillar: 'wealth', text: 'Did you make any progress on a career or money goal today?', type: 'yesno' },
        { id: 'q3', pillar: 'wealth', text: 'How satisfied are you with your work-life balance?', type: 'choice', options: ['Terrible', 'Poor', 'Okay', 'Good', 'Excellent'] },
        { id: 'q4', pillar: 'wealth', text: 'How much is money stressing you out?', type: 'scale', min: 1, max: 5, labels: ['Extreme stress', 'No stress'] },
        { id: 'q5', pillar: 'wealth', text: 'Do you feel in control of your financial situation?', type: 'yesno' },
        { id: 'q6', pillar: 'wealth', text: 'How meaningful does your work feel?', type: 'scale', min: 1, max: 5, labels: ['Meaningless', 'Very meaningful'] },
        { id: 'q7', pillar: 'wealth', text: 'Are you learning and growing professionally?', type: 'yesno' },
        { id: 'q8', pillar: 'wealth', text: 'How secure do you feel about your income?', type: 'choice', options: ['Very insecure', 'Insecure', 'Neutral', 'Secure', 'Very secure'] },
      ],
      love: [
        { id: 'q1', pillar: 'love', text: 'How connected do you feel to the people you care about?', type: 'scale', min: 1, max: 5, labels: ['Very alone', 'Deeply connected'] },
        { id: 'q2', pillar: 'love', text: 'Did you have a meaningful conversation with someone today?', type: 'yesno' },
        { id: 'q3', pillar: 'love', text: 'How would you describe your relationships right now?', type: 'choice', options: ['Struggling badly', 'Strained', 'Okay', 'Good', 'Thriving'] },
        { id: 'q4', pillar: 'love', text: 'How supported and valued do you feel?', type: 'scale', min: 1, max: 5, labels: ['Not at all', 'Completely'] },
        { id: 'q5', pillar: 'love', text: 'Did you express appreciation to someone today?', type: 'yesno' },
        { id: 'q6', pillar: 'love', text: 'How emotionally safe do you feel in your closest relationships?', type: 'scale', min: 1, max: 5, labels: ['Very unsafe', 'Very safe'] },
        { id: 'q7', pillar: 'love', text: 'Can you be your authentic self with the people close to you?', type: 'yesno' },
        { id: 'q8', pillar: 'love', text: 'Overall, how is your social and emotional life?', type: 'choice', options: ['Very poor', 'Poor', 'Okay', 'Good', 'Excellent'] },
      ],
      purpose: [
        { id: 'q1', pillar: 'purpose', text: 'How meaningful did today feel?', type: 'scale', min: 1, max: 5, labels: ['Empty', 'Very meaningful'] },
        { id: 'q2', pillar: 'purpose', text: 'Did you work on something that truly matters to you?', type: 'yesno' },
        { id: 'q3', pillar: 'purpose', text: 'How aligned do you feel with your life direction?', type: 'choice', options: ['Completely lost', 'Unsure', 'Finding my way', 'Aligned', 'Thriving'] },
        { id: 'q4', pillar: 'purpose', text: 'How clear are you on what you want in life?', type: 'scale', min: 1, max: 5, labels: ['Very unclear', 'Crystal clear'] },
        { id: 'q5', pillar: 'purpose', text: 'Did you learn or grow in some way today?', type: 'yesno' },
        { id: 'q6', pillar: 'purpose', text: 'How much does your life align with your core values?', type: 'scale', min: 1, max: 5, labels: ['Not at all', 'Completely'] },
        { id: 'q7', pillar: 'purpose', text: 'Do you feel like you made a positive difference today?', type: 'yesno' },
        { id: 'q8', pillar: 'purpose', text: 'How optimistic are you about your future?', type: 'choice', options: ['Very pessimistic', 'Pessimistic', 'Neutral', 'Optimistic', 'Very optimistic'] },
      ],
    };

    return { success: true, questions: fallbacks[selectedPillar] || fallbacks.health };
  }
};

// ============================================
// AI ANALYSIS — DEEP INSIGHTS 10/10
// ============================================

const getPersonalizedAnalysis = async (profile, submissions) => {
  if (submissions.length < 3) {
    return { success: false, message: `You need at least 3 check-ins for AI insights. You have ${submissions.length}. Keep going!` };
  }

  const { name, ageGroup, gender, language } = profile;
  const userLanguage = language || 'en';
  const displayAge = ageGroup ? getAgeGroupLabel(ageGroup) : 'Adult';
  const last30 = submissions.slice(0, 30);

  const diversitySeed = getDiversitySeed(name, submissions.length, 'analysis');
  const analysisStyle = diversitySeed % 3 === 0 ? 'pattern_detective' :
    diversitySeed % 3 === 1 ? 'strength_based' : 'growth_oriented';

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

  const analysisStyleInstructions = {
    pattern_detective: 'Focus on CONNECTIONS between pillars. What patterns emerge? How do pillars influence each other?',
    strength_based: 'Lead with what IS working. Build recommendations from their strengths.',
    growth_oriented: 'Identify the BIGGEST opportunity for growth. What one change would cascade positively?'
  };

  const prompt = `CRITICAL: ${name} is trusting you with their wellness data. Give them REAL, ACTIONABLE insights.

ALL output MUST be in ${getLanguageName(userLanguage)} language.
Respond ONLY with valid JSON. No markdown.

You are Dr. Maya, ${name}'s personal wellness psychologist with ${last30.length} check-ins of data.

🎯 ANALYSIS STYLE FOR THIS CHECK: ${analysisStyle.toUpperCase()}
${analysisStyleInstructions[analysisStyle]}

═══════════════════════════════════════════
👤 ${name} | ${displayAge} | ${gender} | Language: ${getLanguageName(userLanguage)}
═══════════════════════════════════════════

═══════════════════════════════════════════
📊 FULL JOURNEY (${last30.length} checks):
${historyContext}
═══════════════════════════════════════════

═══════════════════════════════════════════
📈 PILLAR BREAKDOWN:
${Object.entries(pillarTrends).map(([pid, data]) =>
    `  ${PILLARS[pid.toUpperCase()]?.emoji} ${PILLARS[pid.toUpperCase()]?.name}: avg=${data.average}/100 | latest=${data.latest}/100 | trend=${data.trend} | range=${data.lowest}-${data.highest} | ${data.checks} checks`
  ).join('\n')}
═══════════════════════════════════════════

═══════════════════════════════════════════
📖 MEASUREMENT FRAMEWORK:
${rubricSummary}
═══════════════════════════════════════════

🎯 GENERATE ANALYSIS THAT IS:
✅ SPECIFIC — reference actual dates, scores, answers (not "you seem stressed" but "your 3 Health checks averaged 45 with recurring poor sleep")
✅ INSIGHTFUL — connect patterns across pillars using ${analysisStyle} approach
✅ ACTIONABLE — give recommendations they can actually do THIS WEEK
✅ HONEST — if something is concerning, say it (with care)
✅ ENCOURAGING — focus on what's working too
✅ FRESH — use different angles than typical analysis
✅ In ${getLanguageName(userLanguage)} language

STRUCTURE:

OBSERVATIONS (25-35 words in ${getLanguageName(userLanguage)}):
The SINGLE most important pattern using ${analysisStyle} lens. Be specific. Reference dates/scores.

INSIGHTS (25-35 words in ${getLanguageName(userLanguage)}):
What this pattern MEANS for their life. Connect pillars if you see it. Use ${analysisStyle} approach.

RECOMMENDATIONS (3 actions, each 20-28 words in ${getLanguageName(userLanguage)}):
- Actionable THIS WEEK
- At least 1 MUST connect two pillars
- Reference their specific patterns
- Empowering but direct
- Aligned with ${analysisStyle} approach

PILLAR CALLOUTS:
- strongest: which pillar + why (1 sentence in ${getLanguageName(userLanguage)})
- needsAttention: which pillar + kind specific note (1 sentence in ${getLanguageName(userLanguage)})

Respond ONLY with valid JSON:
{
  "observations": "specific pattern with dates/scores in ${getLanguageName(userLanguage)}",
  "insights": "what it means in ${getLanguageName(userLanguage)}",
  "recommendations": ["action 1 in ${getLanguageName(userLanguage)}", "action 2 in ${getLanguageName(userLanguage)}", "action 3 in ${getLanguageName(userLanguage)}"],
  "pillarCallouts": {
    "strongest": "pillar_id",
    "needsAttention": "pillar_id",
    "strongestNote": "why it's working in ${getLanguageName(userLanguage)}",
    "attentionNote": "kind specific note in ${getLanguageName(userLanguage)}"
  }
}`;

  try {
    console.log(`🤖 Deep analysis for ${name} in ${getLanguageName(userLanguage)} using ${analysisStyle} approach...`);
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: `You are Dr. Maya, ${name}'s wellness psychologist. Be specific, connect patterns, kind but honest. Use ${analysisStyle} approach. JSON only.` },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 600,
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
// AI ANALYTICS SUMMARY
// ============================================

async function generateAnalyticsSummary(profile, analyticsData, submissions) {
  try {
    const { name, ageGroup, language } = profile;
    const userLanguage = language || 'en';
    const displayAge = ageGroup ? getAgeGroupLabel(ageGroup) : 'Adult';
    const { summary, perPillar } = analyticsData;

    const diversitySeed = getDiversitySeed(name, submissions.length, 'summary');
    const summaryStyle = diversitySeed % 2 === 0 ? 'celebrate_wins' : 'identify_opportunity';

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

    const styleInstructions = {
      celebrate_wins: 'Lead with what\'s working. Acknowledge progress first.',
      identify_opportunity: 'Lead with the biggest opportunity for improvement.'
    };

    const prompt = `CRITICAL: Summary MUST be in ${getLanguageName(userLanguage)} language.
Respond ONLY with valid JSON.

You are summarizing ${name}'s wellness for a quick overview.

🎯 SUMMARY STYLE: ${summaryStyle.toUpperCase()}
${styleInstructions[summaryStyle]}

👤 ${name} | ${displayAge} | Language: ${getLanguageName(userLanguage)}

📊 STATS:
- Average Alive: ${summary.average}/100
- Range: ${summary.lowest}-${summary.highest}
- Trend: ${summary.trend}
- Total: ${summary.total} checks

📊 PER PILLAR:
${perPillarText}

📝 RECENT:
${recentQA}

Write 2-3 sentences (max 50 words total) in ${getLanguageName(userLanguage)} that tell ${name}:
1. Where they stand overall (using ${summaryStyle} approach)
2. What's strongest
3. What needs attention

Be specific. Reference numbers. Be encouraging but honest. Use ${summaryStyle} style.

Respond ONLY with valid JSON:
{"summary": "2-3 sentences in ${getLanguageName(userLanguage)}"}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Respond ONLY with valid JSON. No markdown.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.75,
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
// EXISTING ROUTES (UNCHANGED) ✅
// ============================================

router.post('/profile', requireDeviceId, async (req, res) => {
  try {
    const { deviceId } = req;
    const { name, ageGroup, gender, language, leaderboardConsent } = req.body;

    const docRef = getDb().collection('aliveChecks').doc(deviceId);
    const doc = await docRef.get();

    if (doc.exists) {
      // ============================================
      // EXISTING PROFILE - UPDATE
      // ============================================
      const updateData = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

      if (name) updateData['profile.name'] = name.trim();
      if (ageGroup) updateData['profile.ageGroup'] = ageGroup;
      if (gender) updateData['profile.gender'] = gender;
      if (language) updateData['profile.language'] = language;
      if (typeof leaderboardConsent === 'boolean') updateData['profile.leaderboardConsent'] = leaderboardConsent;

      await docRef.update(updateData);

      const updatedDoc = await docRef.get();
      const updatedProfile = updatedDoc.data().profile;
      console.log(`✅ Profile updated: ${updatedProfile.name}${language ? ` | Language: ${language}` : ''}`);

      return res.json({
        success: true,
        profile: updatedProfile,
        message: language
          ? `Language updated to ${getLanguageName(language)} successfully`
          : `Welcome back, ${updatedProfile.name}!`
      });

    } else {
      // ============================================
      // NEW PROFILE - CREATE WITH AUTO-CODE
      // ============================================
      if (!name || !name.trim()) return res.status(400).json({ success: false, error: 'Name is required' });
      if (!gender || !['male', 'female', 'other', 'prefernottosay'].includes(gender))
        return res.status(400).json({ success: false, error: 'Valid gender is required' });
      if (!ageGroup) return res.status(400).json({ success: false, error: 'Age group is required' });

      // ✅ AUTO-GENERATE: Code generation happens automatically
      const code = await ensureCodeExists(deviceId);
      console.log(`🔑 Code auto-generated for Alive Check profile: ${deviceId} → ${code}`);

      // ✅ CROSS-SYNC: Sync code to users collection if it exists
      try {
        const userRef = getDb().collection('users').doc(deviceId);
        const userDoc = await userRef.get();

        if (userDoc.exists) {
          const userData = userDoc.data();

          if (!userData.code) {
            // User exists but has no code - sync it
            await userRef.update({
              code,
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`✅ Code synced to users collection: ${deviceId} → ${code}`);
          } else if (userData.code !== code) {
            // User has different code - use existing one (shouldn't happen, but safety check)
            console.log(`⚠️ Code mismatch detected, using existing code: ${userData.code}`);
          }
        }
      } catch (syncError) {
        // Non-critical error - log but don't fail profile creation
        console.error('⚠️ Code sync to users collection failed (non-critical):', syncError.message);
      }

      const profile = {
        name: name.trim(),
        ageGroup,
        gender,
        language: language || 'en',
        code, // ✅ AUTO-GENERATED CODE
        leaderboardConsent: typeof leaderboardConsent === 'boolean' ? leaderboardConsent : true, // ✅ Default ON
        profileCompleted: true,
        profileCompletedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      await docRef.set({
        deviceId,
        profile,
        totalLifetimeChecks: 0,
        todayCount: 0,
        lastCheckDate: null,
        submissions: [],
        circles: [], // ✅ For private circles
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Wait for Firestore write to complete
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Verify the profile was actually saved
      const savedDoc = await docRef.get();
      if (!savedDoc.exists) {
        console.error('❌ Profile save failed - document not found after write');
        throw new Error('Profile save failed - please try again');
      }

      const savedProfile = savedDoc.data().profile;
      console.log(`✅ Profile created: ${savedProfile.name} | Code: ${savedProfile.code} | Language: ${savedProfile.language}`);

      return res.json({
        success: true,
        profile: savedProfile,
        message: `Welcome, ${savedProfile.name}! Your personalized wellness journey starts now. 🚀`
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

    const doc = await getDb().collection('aliveChecks').doc(deviceId).get();

    if (!doc.exists) {
      return res.json({
        success: true,
        profile: null,
        hasProfile: false
      });
    }

    const data = doc.data();
    let profile = data.profile || null;

    // ✅ NEW: Ensure code exists (migration for existing users)
    if (profile && !profile.code) {
      const code = await ensureCodeExists(deviceId);
      await doc.ref.update({ 'profile.code': code });
      profile.code = code;
      console.log(`✅ Code migrated for existing user: ${deviceId} → ${code}`);
    }

    // ✅ NEW: Set leaderboardConsent default if missing
    if (profile && profile.leaderboardConsent === undefined) {
      await doc.ref.update({ 'profile.leaderboardConsent': true });
      profile.leaderboardConsent = true;
    }

    return res.json({
      success: true,
      profile,
      hasProfile: !!profile?.profileCompleted
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get profile'
    });
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

    console.log(`🤖 Processing ${profile.name}'s ${pillar} check-in in ${getLanguageName(profile.language || 'en')}...`);

    // STEP 1: AI scores the pillar
    const { score: todayPillarScore, justification: scoringJustification } = await aiScorePillar(
      profile, pillar, questions, answers, submissions
    );
    console.log(`📊 AI ${pillar} score: ${todayPillarScore}/100`);

    // STEP 2: Calculate Alive Score
    const aliveResult = calculateAliveScore(pillar, todayPillarScore, submissions);
    const {
      aliveScore,
      aliveScoreComplete,
      pillarsCheckedCount,
      missingPillars,
      pillarScores,
      breakdown,
      scoringExplanation,
      strongest,
      weakest
    } = aliveResult;

    // STEP 3: Vibe based on todayPillarScore
    const { vibe, emoji } = getVibeFromScore(todayPillarScore);

    console.log(`🎯 Pillar: ${todayPillarScore} | Alive: ${aliveScore} (${aliveScoreComplete ? 'complete' : `${pillarsCheckedCount}/4`}) | ${vibe}`);

    // STEP 4: Pride moments
    const prideMoments = detectPrideMoment(pillar, todayPillarScore, aliveScore, submissions);

    // STEP 5: Generate content
    const [individualTipResult, quoteAndTipsResult] = await Promise.allSettled([
      generateIndividualTip(profile, pillar, questions, answers, todayPillarScore, submissions),
      generateQuoteAndStrategicTips(profile, pillar, questions, answers, pillarScores, aliveScore, scoringJustification, submissions)
    ]);

    const individualTip = individualTipResult.status === 'fulfilled'
      ? individualTipResult.value
      : 'Small actions today create big changes tomorrow.';

    const { quote, message, strategicTips, weakestPillar, weakestBoost } = quoteAndTipsResult.status === 'fulfilled'
      ? quoteAndTipsResult.value
      : { quote: 'You showed up today', message: 'Every check-in is a step forward.', strategicTips: [], weakestPillar: weakest, weakestBoost: null };

    const today = getCurrentDateIST();
    const nowTimestamp = new Date().toISOString();
    const submissionId = `check_${Date.now()}`;

    // ✅ SINGLE SOURCE OF TRUTH
    // score = aliveScore (for backward compat with old FE reading .score)
    // aliveScore = same value, explicit field
    // todayPillarScore = this specific pillar check score
    // community + leaderboard MUST read aliveScore, never todayPillarScore
    const newSubmission = {
      id: submissionId,
      timestamp: nowTimestamp,
      date: today,
      pillar: pillar.toLowerCase(),
      questions,
      answers,

      todayPillarScore,           // this pillar's score today
      scoringJustification,

      score: aliveScore,          // backward compat — old FE reads this
      aliveScore,                 // ✅ EXPLICIT — community + leaderboard read THIS
      aliveScoreComplete,         // true = all 4 pillars checked at least once
      pillarsCheckedCount,
      missingPillars,

      pillarScores,               // { health: 78, wealth: null, love: null, purpose: 65 }
      breakdown,
      scoringExplanation,

      quote,
      message,
      emoji,
      vibe,
      individualTip,
      strategicTips,
      weakestPillar,
      weakestBoost,
      prideMoments,
      source: 'ai_scored_v7_1'    // bumped version
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

    console.log(`✅ ${profile.name} → Pillar=${todayPillarScore} | Alive=${aliveScore} (${aliveScoreComplete ? 'complete' : 'partial'}) | ${pillar} | ${vibe}`);

    res.json({
      success: true,
      submission: {
        id: submissionId,
        todayPillarScore,
        pillar: pillar.toLowerCase(),
        scoringJustification,

        score: aliveScore,
        aliveScore,
        aliveScoreComplete,
        pillarsCheckedCount,
        missingPillars,

        pillarScores,
        breakdown,
        scoringExplanation,
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
        timestamp: nowTimestamp
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

    res.json({
      success: true,
      history: submissions,
      total: data.totalLifetimeChecks || submissions.length,
      storedCount: submissions.length,
      profile: data.profile || null
    });
  } catch (error) {
    console.error('Get history error:', error);
    res.status(500).json({ success: false, error: 'Failed to get history' });
  }
});

router.get('/analytics', requireDeviceId, async (req, res) => {
  try {
    const { deviceId } = req;
    const { range } = req.query;

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

    // ✅ Check if user has ever completed all 4 pillars (across ALL time, ignore range)
    const allCheckedPillars = new Set(allSubmissions.map(s => s.pillar).filter(Boolean));
    const allPillarIds = Object.values(PILLARS).map(p => p.id);
    const missingPillarIds = allPillarIds.filter(pid => !allCheckedPillars.has(pid));
    const missingPillarNames = missingPillarIds.map(pid => PILLARS[pid.toUpperCase()]?.name || pid);
    const pillarsCheckedCount = allPillarIds.length - missingPillarIds.length;
    const aliveScoreComplete = pillarsCheckedCount === REQUIRED_PILLARS_FOR_COMPLETE_ALIVE;

    // ✅ Apply range filter to submissions
    let rangeSubmissions = allSubmissions;
    const now = new Date();
    if (range === 'week') {
      const cutoff = new Date(now.getTime() - 7 * 86400000);
      rangeSubmissions = allSubmissions.filter(s => new Date(s.date) >= cutoff);
    } else if (range === 'month') {
      const cutoff = new Date(now.getTime() - 30 * 86400000);
      rangeSubmissions = allSubmissions.filter(s => new Date(s.date) >= cutoff);
    }

    if (rangeSubmissions.length === 0) {
      return res.json({ success: true, analytics: null, message: 'No data in this range', profile });
    }

    // ✅ ALIVE SCORE HISTORY — only submissions where aliveScoreComplete = true
    // Backward compat: old submissions without aliveScoreComplete field
    // treat as complete if they have a score and pillarScores for all 4 pillars
    const getAliveScore = (s) => {
      // New submissions: use aliveScore field directly
      if (s.aliveScore !== undefined) return s.aliveScore;
      // Old submissions: fall back to score field
      return s.score;
    };

    const isComplete = (s) => {
      // New submissions: use aliveScoreComplete flag
      if (s.aliveScoreComplete !== undefined) return s.aliveScoreComplete;
      // Old submissions: assume complete if they have pillarScores for all 4
      if (s.pillarScores) {
        return allPillarIds.every(pid => s.pillarScores[pid] != null);
      }
      // Oldest submissions: assume complete (they were calculated that way)
      return true;
    };

    // ✅ ALIVE SCORE SUBMISSIONS — for stats cards (avg/peak/low)
    // Only count submissions where alive score is valid
    const completeSubmissions = rangeSubmissions.filter(s => isComplete(s));

    // ✅ CHART DATA — show todayPillarScore per check (individual check performance)
    // This is what makes the chart interesting — shows each check's score
    const chartData = [...rangeSubmissions].reverse().map(s => ({
      date: s.date,
      todayPillarScore: s.todayPillarScore ?? s.score,
      aliveScore: getAliveScore(s),
      aliveScoreComplete: isComplete(s),
      vibe: s.vibe,
      emoji: s.emoji,
      pillar: s.pillar || 'health'
    }));

    // ✅ STATS — from alive score history only (when complete)
    let summary;
    if (aliveScoreComplete && completeSubmissions.length > 0) {
      const aliveScores = completeSubmissions.map(s => getAliveScore(s));
      const avgScore = Math.round(aliveScores.reduce((a, b) => a + b, 0) / aliveScores.length);
      const maxScore = Math.max(...aliveScores);
      const minScore = Math.min(...aliveScores);

      // Trend: compare recent half vs older half
      const mid = Math.max(1, Math.floor(aliveScores.length / 2));
      const recentAvg = aliveScores.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
      const olderAvg = aliveScores.slice(mid).reduce((a, b) => a + b, 0) / (aliveScores.length - mid);
      let trend = 'stable';
      if (recentAvg > olderAvg + 5) trend = 'improving';
      if (recentAvg < olderAvg - 5) trend = 'declining';

      summary = {
        average: avgScore,
        highest: maxScore,
        lowest: minScore,
        total: rangeSubmissions.length,         // total checks in range (all pillars)
        aliveChecksCount: completeSubmissions.length, // checks where alive score was valid
        trend,
        basedOn: 'alive_score'                  // FE knows these are alive scores not pillar scores
      };
    } else {
      // Not complete yet — show placeholder stats, FE will gate display
      summary = {
        average: null,
        highest: null,
        lowest: null,
        total: rangeSubmissions.length,
        aliveChecksCount: 0,
        trend: 'stable',
        basedOn: 'incomplete'
      };
    }

    // ✅ PER PILLAR — average of todayPillarScore for that pillar's submissions
    const perPillar = {};
    for (const key of Object.keys(PILLARS)) {
      const pid = PILLARS[key].id;
      const pillarSubs = rangeSubmissions.filter(s => s.pillar === pid);
      if (pillarSubs.length > 0) {
        const pScores = pillarSubs.map(s => s.todayPillarScore ?? s.score);
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

    // ✅ CURRENT ALIVE SCORE — recalculated fresh from latest real data + decay
    const latestSub = allSubmissions[0];
    const {
      aliveScore: currentAliveScore,
      pillarScores: currentPillarScores,
      breakdown: currentBreakdown,
    } = calculateAliveScore(
      latestSub?.pillar || 'health',
      latestSub?.todayPillarScore ?? latestSub?.score ?? 55,
      allSubmissions.slice(1)
    );

    const analyticsData = {
      summary,
      perPillar,
      chartData,
      range: range || 'all',
      dateRange: {
        from: rangeSubmissions[rangeSubmissions.length - 1]?.date,
        to: rangeSubmissions[0]?.date
      }
    };

    const aliveScoreMeta = {
      aliveScoreComplete,
      pillarsCheckedCount,
      missingPillars: missingPillarNames,
      currentAliveScore: aliveScoreComplete ? currentAliveScore : null,
      currentPillarScores,
      currentBreakdown,
    };

    let aiSummary = null;
    if (profile?.profileCompleted && rangeSubmissions.length >= 3) {
      aiSummary = await generateAnalyticsSummary(profile, analyticsData, rangeSubmissions);
    }

    res.json({
      success: true,
      analytics: {
        ...analyticsData,
        ...aliveScoreMeta,
        aiSummary
      },
      profile
    });

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

    const doc = await getDb().collection('aliveChecks').doc(deviceId).get();
    if (!doc.exists) {
      return res.json({
        success: true,
        count: 0,
        remaining: MAX_DAILY_CHECKS,
        limit: MAX_DAILY_CHECKS,
        canCheck: true,
        profile: null,
        date: today
      });
    }

    const data = doc.data();
    const todayCount = data.lastCheckDate === today ? (data.todayCount || 0) : 0;
    const remaining = Math.max(0, MAX_DAILY_CHECKS - todayCount);
    const resetTime = getNextMidnightIST();

    res.json({
      success: true,
      count: todayCount,
      remaining,
      limit: MAX_DAILY_CHECKS,
      canCheck: todayCount < MAX_DAILY_CHECKS,
      resetIn: formatTimeUntilReset(resetTime),
      resetTime: new Date(resetTime).toISOString(),
      profile: data.profile || null,
      date: today
    });
  } catch (error) {
    console.error('Get today count error:', error);
    res.status(500).json({ success: false, error: 'Failed to get count' });
  }
});

router.delete('/history', requireDeviceId, async (req, res) => {
  try {
    const { deviceId } = req;
    await getDb().collection('aliveChecks').doc(deviceId).delete();
    console.log(`🗑️ All data deleted for ${deviceId}`);
    res.json({ success: true, message: 'All data deleted successfully' });
  } catch (error) {
    console.error('Delete history error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete history' });
  }
});

// ============================================
// ✅ NEW ROUTES - LEADERBOARD + CIRCLES
// ============================================
router.get('/leaderboard', async (req, res) => {
  try {
    const db = getDb();
    const snapshot = await db.collection('aliveChecks').get();

    if (snapshot.empty) {
      return res.json({ success: true, leaderboard: [], total: 0 });
    }

    const leaderboard = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      const allSubmissions = data.submissions || [];

      if (allSubmissions.length === 0) return;
      if (!data.profile?.leaderboardConsent) return; // respect opt-out

      // ✅ Check if this user has completed all 4 pillars ever
      const checkedPillars = new Set(allSubmissions.map(s => s.pillar).filter(Boolean));
      const allPillarIds = Object.values(PILLARS).map(p => p.id);
      const hasAllPillars = allPillarIds.every(pid => checkedPillars.has(pid));

      // ✅ ONLY show on leaderboard if all 4 pillars completed
      // No penalties, no partial scores — clean rule
      if (!hasAllPillars) return;

      // ✅ Get their current alive score from most recent complete submission
      // Backward compat: check aliveScore field first, fall back to score
      const latestComplete = allSubmissions.find(s =>
        s.aliveScoreComplete === true ||
        (s.aliveScoreComplete === undefined && allPillarIds.every(pid => s.pillarScores?.[pid] != null))
      );

      if (!latestComplete) return;

      const displayAliveScore = latestComplete.aliveScore ?? latestComplete.score;
      if (displayAliveScore == null) return;

      // ✅ Per pillar most recent scores for display
      const pillarBests = {};
      for (const pid of allPillarIds) {
        const pillarSubs = allSubmissions.filter(
          s => s.pillar === pid && (s.todayPillarScore ?? s.score) != null
        );
        pillarBests[pid] = pillarSubs.length > 0
          ? (pillarSubs[0].todayPillarScore ?? pillarSubs[0].score)
          : null;
      }

      leaderboard.push({
        name: data.profile?.name || 'Anonymous',
        aliveScore: displayAliveScore,  // ✅ SINGLE FIELD — no score/aliveScore confusion
        vibe: latestComplete.vibe,
        emoji: latestComplete.emoji,
        lastUpdated: latestComplete.timestamp,
        pillarBests,
        aliveScoreComplete: true,       // guaranteed by filter above
        pillarsCheckedCount: 4,
      });
    });

    // ✅ Sort by aliveScore — clean, no bullshit penalties
    leaderboard.sort((a, b) => b.aliveScore - a.aliveScore);

    const top10 = leaderboard.slice(0, 10).map((entry, index) => ({
      ...entry,
      rank: index + 1,
    }));

    console.log(`🏆 Leaderboard: ${top10.length} complete users from ${leaderboard.length} eligible`);

    res.json({
      success: true,
      leaderboard: top10,
      total: top10.length,
      totalEligible: leaderboard.length,
      lastUpdated: new Date().toISOString()
    });

  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch leaderboard' });
  }
});

// 👥 ADD TO CIRCLE (One-Way) - FINAL VERSION
// 👥 ADD TO CIRCLE (One-Way) - PRODUCTION VERSION
// 👥 ADD TO CIRCLE (One-Way) - PRODUCTION VERSION - FIXED
router.post('/circles/add', requireDeviceId, async (req, res) => {
  try {
    const { deviceId } = req;
    const { code, customName, relationshipType } = req.body;

    // ============================================
    // VALIDATION
    // ============================================

    if (!code || typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Code is required'
      });
    }

    const trimmedCode = code.trim().toUpperCase();

    if (trimmedCode.length !== 6) {
      return res.status(400).json({
        success: false,
        error: 'Code must be exactly 6 characters'
      });
    }

    // Validate relationship type
    const validTypes = Object.keys(RELATIONSHIP_TYPES).map(k => RELATIONSHIP_TYPES[k].id);
    const finalType = relationshipType && validTypes.includes(relationshipType)
      ? relationshipType
      : 'other';

    // ============================================
    // GET MY DATA
    // ============================================

    const db = getDb();
    const myDocRef = db.collection('aliveChecks').doc(deviceId);
    const myDoc = await myDocRef.get();

    if (!myDoc.exists || !myDoc.data().profile?.profileCompleted) {
      return res.status(400).json({
        success: false,
        error: 'Profile not completed. Please complete your profile first.',
        needsProfile: true
      });
    }

    const myData = myDoc.data();
    const myCircles = myData.circles || [];

    // ============================================
    // CHECK: CIRCLE SIZE LIMIT
    // ============================================

    if (myCircles.length >= MAX_CIRCLE_SIZE) {
      return res.status(400).json({
        success: false,
        error: `Circle is full. Maximum ${MAX_CIRCLE_SIZE} friends allowed.`,
        limit: MAX_CIRCLE_SIZE,
        current: myCircles.length
      });
    }

    // ============================================
    // CHECK: ALREADY IN CIRCLE (by code)
    // ============================================

    if (myCircles.find(c => c.targetCode === trimmedCode)) {
      return res.status(400).json({
        success: false,
        error: 'This friend is already in your circle'
      });
    }

    // ============================================
    // FIND TARGET USER BY CODE
    // ============================================

    const targetQuery = await db.collection('aliveChecks')
      .where('profile.code', '==', trimmedCode)
      .limit(1)
      .get();

    if (targetQuery.empty) {
      return res.status(404).json({
        success: false,
        error: 'Code not found. Please check the code and try again.'
      });
    }

    // ============================================
    // EXTRACT TARGET DATA
    // ============================================

    const targetDoc = targetQuery.docs[0];
    const targetDeviceId = targetDoc.id;
    const targetData = targetDoc.data();

    // Validate target has profile
    if (!targetData.profile || !targetData.profile.name) {
      return res.status(400).json({
        success: false,
        error: 'This user has not completed their profile yet.'
      });
    }

    // ============================================
    // CHECK: ALREADY IN CIRCLE (by deviceId - double safety)
    // ============================================

    if (myCircles.find(c => c.targetDeviceId === targetDeviceId)) {
      return res.status(400).json({
        success: false,
        error: 'This friend is already in your circle'
      });
    }

    // ============================================
    // GET LATEST SUBMISSION DATA
    // ============================================

    const latestSubmission = targetData.submissions?.[0];

    // ============================================
    // CREATE CONNECTION OBJECT
    // ✅ FIX: Use Date.now() instead of serverTimestamp()
    // ============================================

    const now = Date.now(); // ✅ FIXED

    const newConnection = {
      id: `circle_${now}_${Math.random().toString(36).substr(2, 9)}`,
      targetDeviceId,
      targetCode: trimmedCode,
      targetName: customName && customName.trim()
        ? customName.trim()
        : targetData.profile.name,
      relationshipType: finalType,
      relationshipEmoji: RELATIONSHIP_TYPES[finalType.toUpperCase()]?.emoji || '🤝',
      addedAt: now, // ✅ FIXED - Use timestamp number
      latestScore: latestSubmission?.score || null,
      latestVibe: latestSubmission?.vibe || null,
      latestPillarScores: latestSubmission?.pillarScores || null,
      lastUpdated: latestSubmission?.timestamp || null
    };

    // ============================================
    // SAVE TO FIRESTORE
    // ✅ FIX: Update updatedAt separately
    // ============================================

    await myDocRef.update({
      circles: admin.firestore.FieldValue.arrayUnion(newConnection),
      updatedAt: admin.firestore.FieldValue.serverTimestamp() // ✅ This is fine outside array
    });

    // ============================================
    // RETURN SUCCESS
    // ============================================

    res.json({
      success: true,
      connection: newConnection,
      message: `${newConnection.targetName} added to your circle!`
    });

  } catch (error) {
    console.error('Add to circle error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to add friend. Please try again.'
    });
  }
});

// 👁️ GET MY CIRCLE
// 👁️ GET MY CIRCLE - BULLETPROOF VERSION
router.get('/circles/list', requireDeviceId, async (req, res) => {
  try {
    const { deviceId } = req;
    const db = getDb();

    const doc = await db.collection('aliveChecks').doc(deviceId).get();

    if (!doc.exists) {
      return res.json({ success: true, circles: [], total: 0, limit: MAX_CIRCLE_SIZE, remaining: MAX_CIRCLE_SIZE });
    }

    const data = doc.data();
    const circles = data.circles || [];

    const validCircles = circles.filter(c => {
      return c.targetDeviceId && typeof c.targetDeviceId === 'string' && c.targetDeviceId.trim().length > 0;
    });

    const updatedCircles = await Promise.all(
      validCircles.map(async (connection) => {
        try {
          const targetDoc = await db.collection('aliveChecks').doc(connection.targetDeviceId).get();

          if (!targetDoc.exists) {
            return { ...connection, status: 'user_not_found', latestAliveScore: null, latestVibe: null, latestPillarScores: null, lastUpdated: null, aliveScoreComplete: false };
          }

          const targetData = targetDoc.data();
          const allSubs = targetData.submissions || [];
          const latestSub = allSubs[0];

          if (!latestSub) {
            return { ...connection, status: 'no_checks', latestAliveScore: null, latestVibe: null, latestPillarScores: null, lastUpdated: null, aliveScoreComplete: false };
          }

          // ✅ ALWAYS use aliveScore field — backward compat fallback to score
          const latestAliveScore = latestSub.aliveScore ?? latestSub.score ?? null;

          // ✅ Check if this user has all 4 pillars completed
          const checkedPillars = new Set(allSubs.map(s => s.pillar).filter(Boolean));
          const allPillarIds = Object.values(PILLARS).map(p => p.id);
          const aliveScoreComplete = allPillarIds.every(pid => checkedPillars.has(pid));

          // ✅ Per pillar latest scores
          const latestPillarScores = {};
          for (const pid of allPillarIds) {
            const pillarSubs = allSubs.filter(s => s.pillar === pid);
            latestPillarScores[pid] = pillarSubs.length > 0
              ? (pillarSubs[0].todayPillarScore ?? pillarSubs[0].score)
              : null;
          }

          return {
            ...connection,
            latestAliveScore,           // ✅ renamed from latestScore — explicit
            latestVibe: latestSub.vibe || null,
            latestPillarScores,
            lastUpdated: latestSub.timestamp || null,
            targetProfileName: targetData.profile?.name || connection.targetName,
            aliveScoreComplete,
            status: 'active'
          };
        } catch (error) {
          console.error(`Error fetching circle member:`, error);
          return { ...connection, status: 'error', latestAliveScore: null, aliveScoreComplete: false };
        }
      })
    );

    res.json({
      success: true,
      circles: updatedCircles,
      total: updatedCircles.length,
      limit: MAX_CIRCLE_SIZE,
      remaining: Math.max(0, MAX_CIRCLE_SIZE - updatedCircles.length)
    });

  } catch (error) {
    console.error('Get circle error:', error);
    res.status(500).json({ success: false, error: 'Failed to get circle' });
  }
});

// 🗑️ REMOVE FROM CIRCLE
router.delete('/circles/:connectionId', requireDeviceId, async (req, res) => {
  try {
    const { deviceId } = req;
    const { connectionId } = req.params;

    const db = getDb();
    const docRef = db.collection('aliveChecks').doc(deviceId);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const data = doc.data();
    const circles = data.circles || [];

    const connectionToRemove = circles.find(c => c.id === connectionId);

    if (!connectionToRemove) {
      return res.status(404).json({ success: false, error: 'Connection not found' });
    }

    await docRef.update({
      circles: admin.firestore.FieldValue.arrayRemove(connectionToRemove),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`🗑️ ${data.profile.name} removed ${connectionToRemove.targetName} from circle`);

    res.json({
      success: true,
      message: `${connectionToRemove.targetName} removed from your circle`
    });

  } catch (error) {
    console.error('Remove from circle error:', error);
    res.status(500).json({ success: false, error: 'Failed to remove from circle' });
  }
});

module.exports = router;