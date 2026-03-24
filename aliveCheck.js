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
// 📚 90-DAY SESSION JOURNEY — Progressive arc, session by session
// Each entry defines WHAT THIS SESSION IS FOR, not just what topics to cover.
// The AI uses this arc + past session summaries to generate fully fresh questions every time.
// Age group and gender are injected into the prompt at generation time.
// ============================================
const SESSION_JOURNEY = {
  health: [
    {
      range: [1, 1], phase: 'First Look',
      arc: 'Very first health session. Wide-lens baseline — sleep, energy, stress, movement, nutrition, mood, body comfort. Keep it welcoming but get a real picture. Make them feel seen from question 1.',
      themes: ['sleep quality & duration', 'energy levels today', 'stress & anxiety state', 'physical activity', 'nutrition quality', 'hydration', 'mood & mental state', 'overall body comfort & tension'],
      q9: 'Ask what one thing about their health they wish someone would actually ask about — that nobody ever does.',
    },
    {
      range: [2, 2], phase: 'Root Causes',
      arc: 'Session 2. They gave you a baseline. Now go one level deeper into WHY. If sleep was poor last time, what disrupts it? If energy is low, when does it crash? Move from surface status to underlying causes.',
      themes: ['sleep disruption patterns', 'energy drain triggers & peaks', 'stress sources (work/relationships/life)', 'exercise barriers & motivation', 'emotional eating patterns', 'afternoon slump reality', 'mental chatter & overthinking', 'specific body tension locations'],
      q9: 'Ask when they last felt genuinely good in their body and what was different about that time.',
    },
    {
      range: [3, 3], phase: 'Habits & Routines',
      arc: 'Session 3. Explore the habits and routines behind their health. Morning routine, sleep consistency, exercise regularity, meal planning, screen time. What keeps falling apart despite good intentions?',
      themes: ['morning routine quality', 'sleep schedule consistency', 'exercise habit vs intention gap', 'meal timing & planning reality', 'screen time before bed', 'caffeine & alcohol impact', 'stress-release techniques used', 'recovery habits between efforts'],
      q9: 'Ask what one health habit they keep starting and failing at — and what gets in the way every single time.',
    },
    {
      range: [4, 5], phase: 'Mind-Body',
      arc: 'Sessions 4-5. The mind-body connection. Stress manifesting physically, emotions affecting health, anxiety patterns, mental health as physical health. Deeper territory — they\'re comfortable enough now.',
      themes: ['anxiety & worry levels now', 'physical stress manifestations (tension/headaches/gut)', 'emotional vs physical energy', 'sleep quality vs sleep quantity distinction', 'body image relationship', 'chronic tension patterns', 'mental recovery & stillness', 'breath quality & nervous system regulation'],
      q9: 'Ask how stress shows up in their body and whether they actually know how to release it when it hits.',
    },
    {
      range: [6, 8], phase: 'Weekly Patterns',
      arc: 'Sessions 6-8. Look for weekly cycles. When are they at their best? When do things fall apart? Work week vs weekend patterns. Recurring situations that wreck or support their health.',
      themes: ['weekday vs weekend energy differences', 'social energy impact on health', 'work schedule physical effects', 'weekend recovery quality', 'consistent weekly health wins', 'consistent weekly health failures', 'circadian rhythm & natural sleep timing', 'environmental health triggers'],
      q9: 'Ask which day of the week they feel worst and best — and whether they understand why.',
    },
    {
      range: [9, 12], phase: 'Body Systems',
      arc: 'Sessions 9-12. Deep dive into body systems. Immune function, digestion, hormonal patterns, chronic issues, recovery capacity. Questions should feel like a knowledgeable friend who remembers everything they\'ve said.',
      themes: ['immune function & illness frequency', 'digestive health & gut signals', 'hormonal or cycle-related patterns', 'chronic pain or recurring discomfort', 'physical tension & posture patterns', 'breathing quality awareness', 'recovery speed after illness or exertion', 'body signals being ignored'],
      q9: 'Ask what their body is trying to tell them that they keep ignoring.',
    },
    {
      range: [13, 20], phase: 'Health Identity',
      arc: 'Sessions 13-20. Identity-level questions. Are they becoming a healthy person or just doing healthy things occasionally? How they relate to health when life gets busy. The gap between who they are vs who they want to be physically.',
      themes: ['health as identity vs occasional habit', 'health priority rank when life gets busy', 'prevention vs reaction relationship with health', 'medical care & doctor relationship', 'body acceptance vs body improvement tension', 'health knowledge & curiosity', 'health in social & peer contexts', 'health role models in their life'],
      q9: 'Ask whether they genuinely see themselves as a healthy person — and what that actually means to them at this point.',
    },
    {
      range: [21, 35], phase: 'Optimization',
      arc: 'Sessions 21-35. We know them well now. Fine-tuning. What does their best health ever look like? What conditions created it? What specific habits separate their best periods from worst?',
      themes: ['personal peak performance conditions', 'optimal sleep amount for their specific body', 'their specific stress triggers vs remedies', 'nutrition that energizes vs drains them specifically', 'exercise type that fits their body best', 'longevity habits worth starting now', 'health metric tracking usefulness', 'what thriving health means personally — not generically'],
      q9: 'Ask what they would change about their daily health habits if they had 30 extra minutes every single day.',
    },
    {
      range: [36, 90], phase: 'Mastery',
      arc: 'Sessions 36-90. Long game thinking. Somatic awareness, advanced recovery, longevity investment, health as lifelong identity. Reference what you know about them from their history. Challenge them to think at a deeper level than before.',
      themes: ['somatic awareness & body intelligence', 'longevity investment for future self', 'health in 10-year horizon', 'advanced recovery & resilience practices', 'mental performance & physical connection', 'health as competitive advantage in life', 'modelling health for people around them', 'health legacy & what they\'re building'],
      q9: 'Ask what their health will look like in 10 years if they continue exactly as they are — and whether they\'re happy with that answer.',
    },
  ],

  wealth: [
    {
      range: [1, 1], phase: 'First Look',
      arc: 'First wealth session. How do they feel about money — anxious, confident, stuck? Income situation, financial control, spending awareness. Don\'t ask about specific numbers — ask about feelings, control, confidence.',
      themes: ['financial confidence vs anxiety level', 'income satisfaction right now', 'spending awareness & control sense', 'financial security feeling', 'primary money stress source', 'career/work satisfaction today', 'savings habit existence', 'financial future optimism'],
      q9: 'Ask what their biggest financial worry is — and how often they actually think about it.',
    },
    {
      range: [2, 2], phase: 'Money Roots',
      arc: 'Session 2. The WHY behind their financial state. Money beliefs, relationship with earning/spending/saving, patterns they\'re aware of. From status to story.',
      themes: ['money mindset & inherited beliefs', 'spending triggers (emotional vs habitual)', 'earning comfort & ceiling sense', 'salary negotiation history & comfort', 'financial risk tolerance', 'debt relationship & emotional weight', 'financial comparison to peers', 'money conversations comfort level'],
      q9: 'Ask what money means to them beyond bills — what would actually change if they had significantly more of it.',
    },
    {
      range: [3, 3], phase: 'Income & Career',
      arc: 'Session 3. Career trajectory and income growth. Growing, stagnant, or stuck? Do they see a path forward? Exploring the common tension between career satisfaction and financial dissatisfaction.',
      themes: ['career growth trajectory clarity', 'income growth in last 12 months', 'professional skill development pace', 'job security feeling right now', 'career pivot or switch consideration', 'salary vs market awareness', 'side income or entrepreneurship thinking', 'work-life balance financial impact'],
      q9: 'Ask where they want to be financially in 3 years — and what\'s actually standing between them and that.',
    },
    {
      range: [4, 5], phase: 'Financial Habits',
      arc: 'Sessions 4-5. Habits and systems. Do they track expenses? Save automatically? Have a plan or wing it? Impulse spending, subscription drain, the difference between people who get ahead financially is habits.',
      themes: ['expense tracking habit reality', 'automatic savings existence', 'financial planning quality vs hoping', 'impulse purchase frequency & triggers', 'subscription & recurring cost awareness', 'emergency fund status', 'investment action if any', 'financial goal clarity & specificity'],
      q9: 'Ask if they know exactly where their money goes each month — and what they\'d see if they looked honestly.',
    },
    {
      range: [6, 8], phase: 'Wealth Building',
      arc: 'Sessions 6-8. Building wealth, not just managing money. Savings rate, investments, passive income concepts, financial independence awareness. Are they thinking this month or this decade?',
      themes: ['savings rate awareness & satisfaction', 'investment knowledge & actual action', 'financial independence concept (know it? want it?)', 'passive income ideas or reality', 'net worth awareness & tracking', 'debt paydown strategy if applicable', 'insurance & financial protection', 'financial education investment'],
      q9: 'Ask if they feel like they\'re getting ahead or just keeping up — and what would have to change to actually accelerate.',
    },
    {
      range: [9, 12], phase: 'Career Strategy',
      arc: 'Sessions 9-12. Career as wealth engine. Strategic moves, skill investments, professional network, reputation. The difference between a 3% annual raise and 30% income growth is strategy.',
      themes: ['career intentionality vs just showing up', 'professional network strength & investment', 'skill development for future income value', 'industry reputation & personal brand', 'mentorship (receiving or giving)', 'leadership development investment', 'differentiation in field or role', 'strategic job moves vs loyalty tradeoffs'],
      q9: 'Ask what their biggest career regret is so far — and what they\'d do differently if they could.',
    },
    {
      range: [13, 25], phase: 'Financial Freedom',
      arc: 'Sessions 13-25. What does financial freedom actually mean to them specifically? Not generic millions — their version. Money as identity. Are they becoming a wealthy person or hoping to get lucky?',
      themes: ['financial freedom personal definition', 'money as tool for specific life vision', 'time-money tradeoff awareness & choices', 'lifestyle design & cost clarity', 'wealth accumulation pace satisfaction', 'financial role models & their lessons', 'generosity & giving capacity', 'financial success definition evolving or fixed'],
      q9: 'Ask what they\'d do with their time if money were no longer a constraint — and whether anything would actually change.',
    },
    {
      range: [26, 90], phase: 'Mastery & Legacy',
      arc: 'Sessions 26-90. Advanced wealth thinking. Legacy, impact, business ownership, multi-generational thinking. What is the wealth FOR? They\'ve done enough sessions to reveal their real financial patterns. Go deep.',
      themes: ['wealth as legacy building intention', 'impact investing or giving capacity', 'business ownership or entrepreneurship path', 'wealth & identity (who they\'re becoming)', 'financial wisdom to pass forward', 'money & true freedom relationship', 'philanthropy or community investment', 'wealth & values alignment check'],
      q9: 'Ask what financial legacy they want to leave — and whether their current actions are actually building that.',
    },
  ],

  love: [
    {
      range: [1, 1], phase: 'First Look',
      arc: 'First love session. Full picture of connection in their life right now. Romantic, family, friendships. Where do they feel most supported? Where do they feel most alone? Don\'t assume relationship status — keep questions inclusive.',
      themes: ['current close relationship quality', 'feeling of being supported', 'social engagement level this week', 'loneliness vs connection feeling', 'family bond quality', 'close friendship depth', 'emotional support access', 'feeling valued by at least one person'],
      q9: 'Ask who in their life makes them feel most understood — and what makes that person different from others.',
    },
    {
      range: [2, 2], phase: 'Depth & Knowing',
      arc: 'Session 2. Depth of connections. Are relationships surface-level or genuinely deep? Can they be vulnerable? Do they feel truly known? Quality of connection, not quantity of people.',
      themes: ['ability to be fully vulnerable', 'feeling truly known by someone', 'depth vs breadth of current friendships', 'emotional safety in closest relationships', 'ability to actually ask for help', 'conflict comfort & avoidance', 'authentic expression vs performance in relationships', 'fear of rejection or judgment'],
      q9: 'Ask whether they have someone they can tell absolutely anything to — and if not, what that costs them.',
    },
    {
      range: [3, 3], phase: 'Relationship Patterns',
      arc: 'Session 3. Patterns in how they connect and disconnect. Do they pull away when stressed? Over-give? Struggle to receive? What keeps showing up in their relationships regardless of who the person is?',
      themes: ['stress response in relationships (withdraw vs cling)', 'over-giving vs under-giving tendency', 'ability to receive care without discomfort', 'communication under pressure quality', 'conflict resolution approach', 'trust development speed', 'past relationship impact on present behavior', 'relationship energy balance (who gives more?)'],
      q9: 'Ask what pattern keeps showing up in their relationships that they wish they could change — and whether they\'ve tried.',
    },
    {
      range: [4, 5], phase: 'Active Investment',
      arc: 'Sessions 4-5. Are they actively investing in relationships or just maintaining? Intentional time, appreciation expressed, showing up. The best relationships are built, not found.',
      themes: ['intentional time with loved ones this week', 'appreciation expressed recently (to whom?)', 'new meaningful conversations had', 'social initiative taking vs waiting', 'showing up for others when needed', 'relationship maintenance habits', 'romantic investment quality if applicable', 'friendship deepening vs broadening effort'],
      q9: 'Ask when they last did something intentional to deepen a relationship — and what stopped them from doing it more.',
    },
    {
      range: [6, 10], phase: 'Intimacy & Trust',
      arc: 'Sessions 6-10. Intimacy territory. Emotional and physical intimacy. Trust. Being completely known and still feeling safe. Deeper relational healing or growth questions.',
      themes: ['emotional intimacy depth in closest relationships', 'physical affection comfort & presence', 'trust level and how it was built or broken', 'ability to forgive and move forward', 'past wounds active impact on present relationships', 'romantic or partnership satisfaction if applicable', 'security in closest attachment', 'ability to be weak in front of someone'],
      q9: 'Ask what scares them most about letting someone fully in — and whether that fear is protecting or limiting them.',
    },
    {
      range: [11, 25], phase: 'Relationship Identity',
      arc: 'Sessions 11-25. Who are they in their relationships? What kind of partner, friend, family member are they honestly versus who they want to be? The gap between desired and actual relational self.',
      themes: ['how they show up vs how they want to show up', 'type of friend/partner/family they actually are', 'relationship growth since 5 years ago', 'love language awareness & expression', 'emotional intelligence in real moments', 'relationship repair & apology quality', 'relationship standards (settling vs realistic)', 'relationships as mirror of inner self'],
      q9: 'Ask what the people closest to them would honestly say is their biggest blindspot as a partner, friend, or family member.',
    },
    {
      range: [26, 90], phase: 'Love as Legacy',
      arc: 'Sessions 26-90. What kind of relationships in 10 years? Relational legacy. Community, mentorship, deep lasting bonds. Love as a daily practice and choice.',
      themes: ['long-term relationship vision clarity', 'community belonging & investment', 'mentorship & intergenerational connection', 'romantic partnership long game if applicable', 'family legacy creation', 'unconditional love as practiced skill', 'social contribution & generosity', 'love & spiritual practice intersection'],
      q9: 'Ask what love means to them now versus what it meant 5 years ago — and what changed them.',
    },
  ],

  purpose: [
    {
      range: [1, 1], phase: 'First Look',
      arc: 'First purpose session. Do they feel like life has direction? What drives them? Where do they feel most alive? Wide lens — capture current sense of meaning, direction, fulfillment, growth. Meet them exactly where they are.',
      themes: ['sense of life meaning right now', 'direction & life clarity level', 'values alignment today', 'motivation level & its source', 'personal growth feeling', 'contribution & impact sense', 'daily fulfillment', 'future optimism'],
      q9: 'Ask what they would do with their life if they weren\'t afraid of anything — and whether they\'re doing any of it.',
    },
    {
      range: [2, 2], phase: 'What Actually Matters',
      arc: 'Session 2. Values and authentic priorities. Not what should matter or sounds good — what genuinely drives them. What would they regret not doing? What lights them up vs drains them?',
      themes: ['top 3 real values in life', 'flow state activities & frequency', 'what they\'d regret not doing on deathbed', 'energy drains (purpose-blocking things)', 'energy sources (purpose-aligned things)', 'work meaning vs income necessity', 'who they\'re becoming vs who they currently are', 'comparison to others\' life paths'],
      q9: 'Ask what they would do differently if they knew they had exactly 5 years left to live.',
    },
    {
      range: [3, 3], phase: 'Direction & Goals',
      arc: 'Session 3. Where are they going — do they actually know? Goals, gap between now and desired, plan vs hope. Is the distance to where they want to be growing or shrinking?',
      themes: ['1-3 year goal clarity', 'gap between current and desired life (shrinking or growing?)', 'plan vs hope distinction', 'skill development toward actual goals', 'progress measurement habit', 'obstacles to clarity or direction', 'daily decisions alignment with stated goals', 'next concrete step they know but haven\'t taken'],
      q9: 'Ask what they want their life to look like in 3 years — and what\'s genuinely standing between them and that person.',
    },
    {
      range: [4, 5], phase: 'Action & Execution',
      arc: 'Sessions 4-5. Purpose without action is fantasy. How much are they actually doing toward what matters? Procrastination, execution gaps, fear-driven avoidance. Are they moving or waiting?',
      themes: ['procrastination triggers & patterns', 'action vs planning ratio', 'fear-driven vs strategic waiting distinction', 'progress this week on what actually matters', 'accountability structure (self or external)', 'momentum vs standstill feeling', 'resource allocation toward goals', '"I want to" vs "I do" gap'],
      q9: 'Ask what they keep meaning to start — and what excuse they give themselves every time they don\'t.',
    },
    {
      range: [6, 10], phase: 'Purpose & Work',
      arc: 'Sessions 6-10. Purpose and work intersection. Is work aligned with purpose or separate? Do they need work to be purposeful? Relationship between career, calling, and meaning.',
      themes: ['work as purpose vs income tool distinction', 'calling vs career clarity', 'meaning sources outside of work', 'creative expression outlet existence', 'professional contribution sense', 'learning & mastery motivation', 'ikigai intersection (love+good at+paid for+world needs)', 'work-purpose integration possibility & cost'],
      q9: 'Ask whether they feel like their work matters — and if not, where they find meaning instead.',
    },
    {
      range: [11, 20], phase: 'Identity & Becoming',
      arc: 'Sessions 11-20. Purpose at identity level. Who are they becoming? Is daily life shaping them into the person they want to be? Character, growth, integrity, authenticity.',
      themes: ['identity evolution direction', 'character traits actively being developed', 'authenticity vs performance in daily life', 'growth edge (what\'s expanding right now)', 'integrity (actions matching values) daily check', 'role models & mentors impact', 'legacy consciousness developing', 'spiritual or philosophical grounding'],
      q9: 'Ask who they\'re becoming through how they live — and whether they genuinely like that person.',
    },
    {
      range: [21, 40], phase: 'Impact & Legacy',
      arc: 'Sessions 21-40. Impact beyond self. Who do they want to affect? What change? How does personal purpose connect to something larger? Purpose scaling from individual to meaningful contribution.',
      themes: ['impact beyond immediate circle intention', 'unique contribution they\'re uniquely positioned to make', 'systemic or community change interest', 'teaching or mentoring others', 'creative legacy being built', 'cause alignment & social change', 'platform, influence, or voice development', 'life as a meaningful narrative they\'re writing'],
      q9: 'Ask what the world would lose if they never fully became who they\'re capable of being.',
    },
    {
      range: [41, 90], phase: 'Mastery & Transcendence',
      arc: 'Sessions 41-90. The deepest questions. Life satisfaction as a whole. Meaning found in difficulty. Wisdom from experience. They\'ve been on this long enough to handle real depth. Go there.',
      themes: ['life satisfaction as an integrated whole', 'meaning found in difficulty & suffering', 'gratitude depth & active practice', 'wisdom accumulated from experience', 'purpose beyond ego & self', 'spiritual or philosophical evolution', 'death awareness & legacy clarity', 'integration of all life areas into cohesive identity'],
      q9: 'Ask what their life has taught them about what actually matters — and whether they\'re living that truth now.',
    },
  ],
};

function getSessionPhase(pillar, sessionN) {
  const journey = SESSION_JOURNEY[pillar] || [];
  for (const phase of journey) {
    if (sessionN >= phase.range[0] && sessionN <= phase.range[1]) return phase;
  }
  return journey[journey.length - 1] || {
    phase: 'Mastery', arc: 'Deep exploration of this pillar.',
    themes: QUESTION_TOPICS[pillar]?.slice(0, 8) || [],
    q9: 'What matters most to you in this area of your life right now?',
  };
}

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
  const { name, ageGroup, gender, language, vision, pillarBaselines, goalTimeline } = profile;
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
    const isText = q.type === 'text';
    return `  Q${i + 1}${isText ? ' [REFLECTION — weight heavily]' : ''}: ${q.text}\n  A${i + 1}: ${answerValue}`;
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
${vision ? `\n🎯 THEIR VISION: "${vision}"` : ''}
${pillarBaselines ? `📊 THEIR STARTING BASELINE for ${pillar}: ${pillarBaselines[pillar] ?? 'unknown'}/100` : ''}
${goalTimeline ? `⏱️ COMMITTED CHALLENGE: ${goalTimeline} days` : ''}
═══════════════════════════════════════════

═══════════════════════════════════════════
📝 TODAY'S ANSWERS (${pillarMeta?.emoji} ${rubric.name}):
${qaFormatted}

⭐ NOTE: Any answer marked [REFLECTION] is a free-text response — treat it as the highest-signal data point. Weight it heavily in your scoring.
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

STEP 1: Read ALL answers carefully. If there's a free-text [REFLECTION] answer, read it first — it's the most revealing.
STEP 2: Identify the STRONGEST positive signal (what's working best?)
STEP 3: Identify the BIGGEST red flag (what's most concerning?)
STEP 4: Apply context rules — do any override your initial assessment?
STEP 5: Compare to their history — is this a pattern or an anomaly?
STEP 6: Match to the rubric bands — where do they truly fit?
STEP 7: Assign ONE honest score (0-100) that captures their current state
STEP 8: Write a UNIQUE justification that references SPECIFIC answers — especially the reflection if given (avoid phrases you've used before)

CRITICAL RULES FOR VARIETY:
- Use DIFFERENT reasoning each time — vary your analytical lens
- Reference DIFFERENT answer details each check — don't repeat patterns
- Vary your justification structure — sometimes start with strength, sometimes weakness, sometimes context
- Use diverse vocabulary — avoid repetitive phrases like "overall good" or "some concerns"

Respond ONLY with valid JSON:
{
  "score": <number 0-100>,
  "justification": "<2-3 sentences in ${getLanguageName(userLanguage)}, written like a caring friend who genuinely sees them — warm, specific, NO clinical language. Reference their actual answers by name. Never use: 'indicates', 'levels', 'metrics', 'overall', 'it appears', 'based on your responses'. Speak directly to them using 'you'. 50-80 words.>"
}`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: `You are scoring ${name}'s wellness but writing about it like a sharp, caring friend — not a clinical report. Be warm, be real, be specific to what they actually said. No wellness-speak. No bullet points. Write in ${getLanguageName(userLanguage)}. VARY your approach each time. Respond ONLY with valid JSON. No markdown.` },
        { role: 'user', content: prompt }
      ],
      temperature: 0.5,
      max_tokens: 300,
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
  const { name, language, ageGroup, vision, pillarBaselines, goalTimeline } = profile;
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
${pillarBaselines ? `They started at ${pillarBaselines[pillar] ?? '—'}/100 in ${pillarMeta?.name} — they've ${todayPillarScore > (pillarBaselines[pillar] ?? 50) ? 'improved since they started' : 'not moved much yet — dig into why'}.` : ''}
${vision ? `🎯 THEIR 1-YEAR VISION: "${vision}" — make the tip feel like it moves them toward this` : ''}
${goalTimeline ? `⏱️ They committed to a ${goalTimeline}-day challenge. Acknowledge the commitment if relevant.` : ''}

🚫 RECENT TIPS (DO NOT REPEAT THESE PATTERNS):
${recentTips || 'First tip'}

🎯 GENERATE ONE TIP THAT:
✅ References their ACTUAL answers — quote something specific they said (e.g. "you mentioned your sleep is 3/5...")
✅ Is actionable within 24-48 hours, name the exact action
✅ Sounds like a caring friend texting them, not a wellness coach presenting advice
✅ Addresses their BIGGEST gap from today's answers
✅ Is honest but warm — don't sugarcoat, don't lecture
✅ Is 25-40 words (enough to feel real, short enough to land)
✅ Is DIFFERENT from recent tips in approach and wording
✅ Matches the ${tipStyle} style
✅ Is in ${getLanguageName(userLanguage)} language
✅ NO phrases like: "make sure to", "try to", "it's important to", "remember to"

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
        { role: 'system', content: `You are ${name}'s sharp, caring best friend who just read all their answers. You text them advice the way a real friend does — specific, warm, no fluff, no coach-speak. VARY your tips each time. Respond ONLY with valid JSON. No markdown.` },
        { role: 'user', content: prompt }
      ],
      temperature: 0.85,
      max_tokens: 150,
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
// 📝 SESSION SUMMARY — stored per submission, used for deep analysis
// ============================================
// Runs in parallel with other AI calls during submit.
// Produces a 2-3 sentence paragraph that captures:
//   • What the user revealed about themselves in this session
//   • Patterns or concerns the AI noticed
//   • What needs attention vs what's working
// Never shown to user — purely internal data for deep analysis.
// ============================================

async function generateSessionSummary(profile, pillar, questions, answers, todayPillarScore, scoringJustification) {
  const { name, ageGroup, gender, vision, pillarBaselines, goalTimeline } = profile;
  const displayAge = ageGroup ? getAgeGroupLabel(ageGroup) : 'Adult';
  const pillarMeta = PILLARS[pillar.toUpperCase()];

  const qaBlock = questions.map((q, i) => {
    const raw = answers[i]?.answer !== undefined ? answers[i].answer : answers[i];
    const a = typeof raw === 'object' && raw !== null ? (raw.answer ?? JSON.stringify(raw)) : raw;
    return `Q: ${q.text}\nA: ${a ?? '—'}`;
  }).join('\n\n');

  const prompt = `You are an analyst who has just reviewed a wellness check-in. Write a concise 2-3 sentence internal note summarising what this person revealed, what patterns or red flags you noticed, and what their score reflects about their current state. This note will be read by AI in future analysis sessions — be specific, honest, and data-rich.

Person: ${name} | ${displayAge} | ${gender}
Pillar checked: ${pillarMeta?.name} (${pillar})
Score today: ${todayPillarScore}/100
AI scoring note: ${scoringJustification || 'N/A'}
${pillarBaselines ? `Baseline when they started: ${pillarMeta?.name}=${pillarBaselines[pillar] ?? '—'}/100 — note any movement.` : ''}
${vision ? `Their declared vision: "${vision}"` : ''}
${goalTimeline ? `Committed to a ${goalTimeline}-day challenge.` : ''}

Their answers:
${qaBlock}

Write 2-3 sentences max. Be specific — mention actual answers. No bullet points. No generic observations. Output only the paragraph, nothing else.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You write sharp, specific internal analyst notes about wellness check-ins. No fluff. Output only the summary paragraph.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.4,
      max_tokens: 200,
    });
    const summary = completion.choices[0].message.content.trim();
    console.log(`📝 Session summary generated for ${name} (${pillar} ${todayPillarScore}/100)`);
    return summary;
  } catch (error) {
    console.error('Session summary error:', error.message);
    // Fallback: build a basic summary from raw data
    return `${name} completed a ${pillarMeta?.name} check-in scoring ${todayPillarScore}/100. ${scoringJustification || 'No additional context.'}`;
  }
}

// ============================================
// 💬 QUOTE + STRATEGIC TIPS — GEN Z VIRAL 10/10
// ============================================

async function generateQuoteAndStrategicTips(profile, todayPillar, questions, answers, pillarScores, aliveScore, scoringJustification, submissions) {
  const { name, ageGroup, gender, language, vision, goalTimeline } = profile;
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
${vision ? `Their 1-year vision: "${vision}" — quote/message can nod to this without being cheesy` : ''}
${goalTimeline ? `They committed to a ${goalTimeline}-day challenge — they're someone who makes real commitments` : ''}

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

async function generatePersonalizedQuestions(profile, selectedPillar, previousSubmissions, sessionNumber, storedSessionSummaries) {
  const { name, ageGroup, gender, language, vision, pillarBaselines, goalTimeline } = profile;
  const userLanguage = language || 'en';
  const displayAge = ageGroup ? getAgeGroupLabel(ageGroup) : 'Adult';
  const pillarMeta = PILLARS[selectedPillar.toUpperCase()];
  const rubric = SCORING_RUBRICS[selectedPillar];

  // Get the session arc for this session number
  const phase = getSessionPhase(selectedPillar, sessionNumber);

  // Build past session context — use stored summaries for efficiency, fall back to inline
  const samePillarSummaries = (storedSessionSummaries || [])
    .filter(s => s.pillar === selectedPillar)
    .slice(0, 8); // last 8 sessions of this pillar

  const pastSessionContext = samePillarSummaries.length > 0
    ? samePillarSummaries.map((s, i) =>
        `Session ${sessionNumber - 1 - i} [${s.date}] — Score: ${s.score}/100\n${s.summary}`
      ).join('\n\n')
    : previousSubmissions
        .filter(s => s.pillar === selectedPillar)
        .slice(0, 4)
        .map(s => {
          const score = s.pillarScores?.[selectedPillar] ?? s.todayPillarScore ?? s.score;
          const qa = (s.questions || []).map((q, i) => {
            const a = s.answers?.[i]?.answer?.answer ?? s.answers?.[i]?.answer ?? '—';
            return `Q: ${q.text} → A: ${a}`;
          }).join(' | ');
          return `[${s.date}] Score: ${score}/100\n${qa}`;
        }).join('\n\n');

  // All previously asked question texts across all sessions of this pillar — hard dedup
  const allPreviousQuestionTexts = previousSubmissions
    .filter(s => s.pillar === selectedPillar)
    .flatMap(s => (s.questions || []).map(q => q.text))
    .filter(Boolean);

  // Other pillars context
  const pillarHistory = buildPillarHistory(previousSubmissions);
  const pillarContext = Object.keys(PILLARS).map(k => {
    const p = PILLARS[k];
    const scores = pillarHistory[p.id];
    const avg = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
    return `${p.name}: ${avg !== null ? avg + '/100' : 'not checked yet'}`;
  }).join(' | ');

  // Age/gender framing for question style
  const ageGenderContext = (() => {
    const ageFraming = {
      '18-24': 'Young adult (18-24). Questions should feel peer-to-peer, not parental. Relevant to career starts, social pressure, identity formation, FOMO, relationships just starting.',
      '25-34': 'Building years (25-34). Career climbing, relationship deepening, financial pressure, balancing ambition with real life. Real stakes now.',
      '35-44': 'Prime but pressured (35-44). Often juggling career peak, family responsibilities, health wake-up calls. Questions can be more direct about trade-offs and priorities.',
      '45-54': 'Mid-life reckoning (45-54). Legacy thinking, health investment, meaning deepening. More willing to go deep. Questions can challenge their assumptions.',
      '55-64': 'Mature perspective (55-64). Wisdom earned, real stakes around health, relationships, legacy, and time. Honor their experience while still challenging them.',
      '65+':   'Elder wisdom (65+). Long view on what matters, health as central, legacy as lived reality. Deep questions about meaning, contribution, and what they want to leave behind.',
    };
    return ageFraming[ageGroup] || 'Adult. Keep questions grounded in real daily life challenges.';
  })();

  const lang = getLanguageName(userLanguage);

  const prompt = `You are creating a personalized ${pillarMeta?.name} check-in for ${name}. Everything must be in ${lang}. Respond ONLY with valid JSON. No markdown.

━━━ WHO THIS IS ━━━
${name} | ${displayAge} | ${gender}
${ageGenderContext}
Their other pillars: ${pillarContext}

${(vision || pillarBaselines || goalTimeline) ? `━━━ PERSONAL CONTEXT (use this to make questions deeply relevant) ━━━
${vision ? `Their vision — what they wrote about who they want to be in 1 year: "${vision}"` : ''}
${pillarBaselines ? `Their self-assessed starting point: Health=${pillarBaselines.health}/100, Wealth=${pillarBaselines.wealth}/100, Love=${pillarBaselines.love}/100, Purpose=${pillarBaselines.purpose}/100. Use this as context for where they started vs where they are now.` : ''}
${goalTimeline ? `Their committed challenge: ${goalTimeline} days. They made a commitment — questions can acknowledge this.` : ''}` : ''}

━━━ SESSION ${sessionNumber} — ${phase.phase.toUpperCase()} ━━━
${phase.arc}

${pastSessionContext
  ? `━━━ WHAT YOU KNOW ABOUT THEM FROM PAST SESSIONS ━━━\n${pastSessionContext}\n\nUSE THIS: Build on what they've revealed. Reference it in question framing. Go deeper than last time.`
  : `━━━ FIRST SESSION ━━━\nThis is ${name}'s first time checking ${pillarMeta?.name}. Make the first question feel like the right first question.`
}

━━━ NEVER ASK THESE AGAIN (already asked in previous sessions) ━━━
${allPreviousQuestionTexts.length > 0 ? allPreviousQuestionTexts.join('\n') : 'None yet — first session.'}

━━━ THIS SESSION'S FOCUS THEMES ━━━
${phase.themes.map((t, i) => `Q${i + 1}: ${t}`).join('\n')}
Q9 (reflection): ${phase.q9}

━━━ SCORING CONTEXT ━━━
${rubric.what_matters.map(w => `• ${w}`).join('\n')}

━━━ QUESTION TYPE STRATEGY ━━━
Types: scale (1-5), yesno, choice (pick one from options), multiselect (pick multiple), text (free write)

MOMENTUM RULE — Question order determines completion rate:
• Q1-Q3: Always start FAST (scale/yesno/choice). Never start with text or multiselect.
• Q4-Q7: Place heavier types here (text, multiselect) — user has momentum now.
• Q8: End Q8 fast (scale or yesno).
• Q9: Always text — the reflection closer. Already defined above, you generate it.

If first session: scale → choice → yesno → scale → yesno → choice → scale → yesno (all fast, build foundation)
If trending down: quick → quick → quick → text → multiselect → text → quick → quick (get depth but ease in)
If returning user with context: mix scale/choice for quick pulse, then text/multiselect to go deeper

━━━ QUESTION QUALITY RULES ━━━
✅ Reference their past answers in question framing when you have them ("last time you mentioned X, how is that now?")
✅ Each question covers ONE theme from the list above
✅ Questions feel like a perceptive friend asking, not a clinical intake form
✅ Specific enough that the answer actually reveals something ("How many hours exactly?" not "Did you sleep enough?")
✅ Q9 must be the deepest question of the session — something they'll actually think about
✅ NEVER repeat any question from the previous sessions list above
✅ ALL text in ${lang} — questions, options, labels, everything

━━━ OUTPUT FORMAT ━━━
Return exactly this JSON structure:
{
  "questions": [
    {"id":"q1","pillar":"${selectedPillar}","text":"question in ${lang}","type":"scale","min":1,"max":5,"labels":["low label","high label"]},
    {"id":"q2","pillar":"${selectedPillar}","text":"question in ${lang}","type":"yesno"},
    {"id":"q3","pillar":"${selectedPillar}","text":"question in ${lang}","type":"choice","options":["opt1","opt2","opt3","opt4","opt5"]},
    {"id":"q4","pillar":"${selectedPillar}","text":"question in ${lang}","type":"multiselect","options":["opt1","opt2","opt3","opt4","opt5"]},
    {"id":"q5","pillar":"${selectedPillar}","text":"question in ${lang}","type":"yesno"},
    {"id":"q6","pillar":"${selectedPillar}","text":"question in ${lang}","type":"text","placeholder":"thoughtful placeholder in ${lang}"},
    {"id":"q7","pillar":"${selectedPillar}","text":"question in ${lang}","type":"choice","options":["opt1","opt2","opt3","opt4","opt5"]},
    {"id":"q8","pillar":"${selectedPillar}","text":"question in ${lang}","type":"scale","min":1,"max":5,"labels":["low label","high label"]},
    {"id":"q9","pillar":"${selectedPillar}","text":"the reflection question in ${lang} — generated from the Q9 intent above","type":"text","placeholder":"thoughtful placeholder in ${lang}"}
  ]
}`;

  try {
    console.log(`🤖 Generating session ${sessionNumber} (${phase.phase}) ${pillarMeta?.name} questions for ${name} in ${lang}...`);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You create deeply personalized wellness check-in questions. You remember what users said in past sessions and build on it. Every question feels like it was written specifically for this person at this point in their journey. Never generic. Never repeated. Always in ${lang}. JSON only, no markdown.`
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.88,
      max_tokens: 1600,
    });

    let txt = completion.choices[0].message.content.trim().replace(/```json\n?/g, '').replace(/```\n?/g, '');
    const parsed = JSON.parse(txt);

    if (!parsed.questions || parsed.questions.length < 9) throw new Error(`Bad question count: ${parsed.questions?.length}`);

    // Validate and fix question structure
    parsed.questions.forEach((q) => {
      if ((q.type === 'choice' || q.type === 'multiselect') && (!Array.isArray(q.options) || q.options.length < 4)) {
        q.options = q.type === 'multiselect'
          ? ['Option 1', 'Option 2', 'Option 3', 'Option 4']
          : ['Very Low', 'Low', 'Okay', 'Good', 'Very Good'];
      }
      if (q.type === 'scale' && (!q.min || !q.max)) { q.min = 1; q.max = 5; }
      if (q.type === 'text' && !q.placeholder) { q.placeholder = '...'; }
    });

    // topicsUsed: record the themes for this session (for sessionSummaries field)
    const topicsUsed = phase.themes;

    console.log(`✅ Generated 9 ${phase.phase} ${pillarMeta?.name} questions for ${name} (session ${sessionNumber}) in ${lang}`);
    return { success: true, questions: parsed.questions.slice(0, 9), sessionNumber, phase: phase.phase, topicsUsed };

  } catch (error) {
    console.error('Question generation error:', error.message);

    // Fallback: generate basic questions covering the phase themes
    const fallbackQ = phase.themes.slice(0, 8).map((theme, i) => ({
      id: `q${i + 1}`,
      pillar: selectedPillar,
      text: `How are you doing with ${theme}?`,
      type: i % 3 === 0 ? 'scale' : i % 3 === 1 ? 'yesno' : 'choice',
      ...(i % 3 === 0 ? { min: 1, max: 5, labels: ['Not well', 'Very well'] } : {}),
      ...(i % 3 === 2 ? { options: ['Very Bad', 'Bad', 'Okay', 'Good', 'Great'] } : {}),
    }));
    const fallbackQ9 = {
      id: 'q9', pillar: selectedPillar, type: 'text',
      text: phase.q9.replace(/^Ask /, '').replace(/^ask /, ''),
      placeholder: '...',
    };

    return { success: true, questions: [...fallbackQ, fallbackQ9], sessionNumber, phase: phase.phase, topicsUsed: phase.themes };
  }
}

// ============================================
// AI ANALYSIS — DEEP INSIGHTS 10/10
// ============================================

const getPersonalizedAnalysis = async (profile, submissions, lastAnalysis, stats, storedSessionSummaries) => {
  if (submissions.length < 3) {
    return { success: false, message: `You need at least 3 check-ins for AI insights. You have ${submissions.length}. Keep going!` };
  }

  const { name, ageGroup, gender, language, vision, pillarBaselines, goalTimeline } = profile;
  const userLanguage = language || 'en';
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

  // Full context — use EVERY data point we have
  const historyContext = last30.map((s, i) => {
    const pillarScore = s.pillarScores?.[s.pillar] ?? s.todayPillarScore ?? s.score;
    const allPillarScores = s.pillarScores
      ? Object.entries(s.pillarScores).map(([p, v]) => `${p}=${v}`).join(' ')
      : '';

    const lines = [`[${s.date}] Alive=${s.score}/100 | ${s.vibe} | Pillar checked: ${s.pillar}=${pillarScore}/100`];
    if (allPillarScores) lines.push(`  All pillars: ${allPillarScores}`);

    // Every Q&A answer — this is gold
    if (s.questions?.length) {
      const qa = s.questions.map((q, idx) => {
        const raw = s.answers?.[idx];
        const a = raw?.answer?.answer ?? raw?.answer ?? raw ?? '—';
        return `  Q: ${q.text}\n  A: ${a}`;
      }).join('\n');
      lines.push(`  Answers:\n${qa}`);
    }

    // AI tip given after this test
    if (s.individualTip) lines.push(`  AI tip given: "${s.individualTip}"`);

    // Scoring explanation
    if (s.scoringJustification) lines.push(`  Why this score: ${s.scoringJustification}`);

    // Breakdown details
    if (s.breakdown) {
      const bk = typeof s.breakdown === 'string' ? s.breakdown : JSON.stringify(s.breakdown);
      lines.push(`  Breakdown: ${bk.slice(0, 200)}`);
    }

    // Pride moments and weakest
    if (s.prideMoments?.length) lines.push(`  Pride: ${s.prideMoments.join(', ')}`);
    if (s.weakestPillar) lines.push(`  Weakest: ${s.weakestPillar}${s.weakestBoost ? ` — boost: ${s.weakestBoost}` : ''}`);

    return lines.join('\n');
  }).join('\n\n');

  const pillarEntries = Object.entries(pillarTrends).sort((a, b) => a[1].average - b[1].average);
  const pillarBlock = pillarEntries.map(([pid, d]) =>
    `${PILLARS[pid.toUpperCase()]?.name} (${pid}): latest=${d.latest} avg=${d.average} trend=${d.trend} range=${d.lowest}–${d.highest} checks=${d.checks}`
  ).join('\n');

  // Pull out EVERY free-text reflection answer — these are the most revealing data points
  const reflections = last30
    .flatMap(s => (s.questions || []).map((q, idx) => {
      if (q.type !== 'text') return null;
      const raw = s.answers?.[idx];
      const a = raw?.answer?.answer ?? raw?.answer ?? raw ?? '';
      if (!a || a === '—' || String(a).trim().length < 5) return null;
      return `[${s.date}] ${q.text}\n→ "${a}"`;
    }))
    .filter(Boolean)
    .join('\n\n');

  // Pre-digested session summaries — prefer the dedicated top-level field (fastest, most complete),
  // fall back to inline sessionSummary on submissions, then scoringJustification for old data.
  const summarySource = (storedSessionSummaries && storedSessionSummaries.length > 0)
    ? storedSessionSummaries.map(s =>
        `[${s.date}] ${s.pillar?.toUpperCase()} ${s.score}/100 (alive ${s.aliveScore}/100)\n${s.summary}`
      ).join('\n\n')
    : last30
        .filter(s => s.sessionSummary || s.scoringJustification)
        .map((s) => {
          const pillarScore = s.pillarScores?.[s.pillar] ?? s.todayPillarScore ?? s.score;
          const header = `[${s.date}] ${s.pillar?.toUpperCase()} ${pillarScore}/100`;
          const body = s.sessionSummary || `Score: ${pillarScore}/100. ${s.scoringJustification || ''}`;
          return `${header}\n${body}`;
        })
        .join('\n\n');
  const sessionSummaries = summarySource;

  // Previous analysis context — so we never repeat the same things
  const prevAnalysisContext = lastAnalysis?.data
    ? `WHAT YOU TOLD THEM LAST TIME (do NOT repeat these angles):
Headline: ${lastAnalysis.data.headline || '—'}
Week focus: ${lastAnalysis.data.weekFocus || '—'}
Climb plays: ${(lastAnalysis.data.climbPlays || []).map(p => p.play).join(' | ')}
Generated: ${lastAnalysis.generatedAt || '—'}`
    : 'This is their first analysis.';

  // User stats for extra context
  const statsContext = stats
    ? `Check-in streak: ${stats.dayStreak || 0} days | Longest streak: ${stats.longestStreak || 0} days | Total check-ins ever: ${stats.totalCheckIns || last30.length}`
    : `Total check-ins shown: ${last30.length}`;

  // Build "what changed since last analysis" block — makes each analysis feel progressive
  const changesSinceLastAnalysis = lastAnalysis?.data
    ? (() => {
        const newChecks = submissions.length - (lastAnalysis.submissionsCountAtGeneration || 0);
        const recentNew = submissions.slice(0, newChecks);
        if (recentNew.length === 0) return '';
        const newScores = recentNew.map(s => {
          const ps = s.pillarScores?.[s.pillar] ?? s.todayPillarScore ?? s.score;
          return `${s.date} ${s.pillar} ${ps}/100${s.sessionSummary ? ': ' + s.sessionSummary : ''}`;
        }).join('\n');
        return `WHAT HAPPENED SINCE YOUR LAST ANALYSIS (${newChecks} new check-in${newChecks !== 1 ? 's' : ''}):\n${newScores}`;
      })()
    : '';

  const lang = getLanguageName(userLanguage);

  const prompt = `EVERYTHING must be written in ${lang}. JSON only — no markdown, no extra keys.

You have been watching ${name} (${displayAge}, ${gender}) do their check-ins. You've read everything. Now you're going to tell them what you actually think.

${statsContext}
${vision ? `━━━ WHO THEY SAID THEY WANT TO BE (written on day 1) ━━━\n"${vision}"\nAre they moving toward this? Be honest. Name the gap or the progress.` : ''}
${pillarBaselines ? `━━━ WHERE THEY STARTED (their own baseline) ━━━\nHealth=${pillarBaselines.health}/100  Wealth=${pillarBaselines.wealth}/100  Love=${pillarBaselines.love}/100  Purpose=${pillarBaselines.purpose}/100\nCompare to current scores. Has anything actually changed since day 1?` : ''}
${goalTimeline ? `━━━ THEIR COMMITMENT ━━━\nThey committed to a ${goalTimeline}-day challenge on day 1. Reference their progress toward it.` : ''}

━━━ THEIR DATA ━━━

PILLAR SCORES RIGHT NOW:
${pillarBlock}

SESSION-BY-SESSION STORY (most recent first — read all of it):
${sessionSummaries || historyContext}

WHAT THEY WROTE IN THEIR OWN WORDS (reflections):
${reflections || 'None yet — work from scored answers.'}

RAW HISTORY (scores + Q&A for cross-reference):
${historyContext}

${changesSinceLastAnalysis}

${prevAnalysisContext}

━━━ HOW TO WRITE THIS ━━━

You are NOT a wellness app. You are NOT a coach. You are the one person who has read every single thing ${name} wrote and actually paid attention.

WHAT MAKES THIS FEEL REAL:
— Name specific things from their answers. Not "you seem stressed" but "you rated your sleep 2/5 three times in a row."
— Connect dots they haven't connected. "Your wealth score tanks every time your energy is low — that's not random."
— Say the thing a friend would say but a coach wouldn't. "You keep answering this question the same way. Something's not shifting."
— Use short punchy sentences where it counts. Long where nuance matters.
— If you see something repeating across sessions, name it directly. "This is the fourth time you've mentioned X."
— If scores improved, acknowledge it specifically. "You went from 45 to 72 on health — what changed?"
— If something is clearly not working, say so. With warmth, not a lecture.

WHAT KILLS THE ANALYSIS (automatic reject):
— Any of these words/phrases: "journey", "mindful", "holistic", "self-care", "well-being", "wellness", "It looks like", "Based on your data", "Based on your responses", "It appears", "Great work", "keep it up", "you're doing great", "make sure to", "it's important to", "remember to", "leverage", "actionable", "empower", "optimize", "I noticed that", "I can see that"
— Starting any sentence with "It" followed by a passive observation
— Bullet points inside text fields
— Generic advice that could apply to anyone
— Repeating anything from the previous analysis

━━━ OUTPUT FORMAT ━━━

WRITING RULES:
— Specific to ${name}'s actual data. If it fits anyone, delete it.
— Short. Punchy. People scan. Every word earns its place.
— Name actual numbers. "4hrs sleep, 3 sessions in a row" not "sleep seems low."
— BANNED: prioritize, focus on, well-being, holistic, journey, mindful, self-care, leverage, actionable, empower, optimize, it appears, based on your data, great work.

━━━━━━━━━━━━━━━━━━━━

hook: 8-12 words. The one honest thing ${name} needs to hear. A thought a real person texts them. Specific data only. In ${lang}.

bullets: Exactly 3 items. Each = one short punchy insight from their actual data.
  Format: "[specific fact]. [what it means — 4-6 words]."
  RIGHT tone examples:
    "Sleep under 5hrs in 4 of 6 sessions. Energy scores confirm it."
    "Wealth confidence 8/10. Savings plan: none. That gap is real."
    "Love score most consistent pillar. Holding everything up."
  MAX 18 words per bullet. Zero fluff. Real data every time. In ${lang}.

move: Under 15 words. One specific action tied to something ${name} actually said or scored.
  NOT: "set a goal", "drink water", "journal", "go for a walk".
  YES: names their actual data point, targets the root cause. In ${lang}.

bright: Under 15 words. Their real strength. One specific number or pattern. No generic praise. In ${lang}.

summary: 3-5 sentences. The full picture in plain language — like a smart friend texting a voice note.
  Cover: the main pattern, what's connected, what needs to shift and why, what's genuinely working.
  Specific numbers and dates. Short punchy sentences mixed with a couple longer ones where depth is needed.
  This is the only place you can go deeper — but still no fluff, no AI slop. In ${lang}.

nextReveal: Under 20 words. What the next sessions will show that they literally cannot see yet. Make them curious. In ${lang}.

{
  "hook": "...",
  "bullets": ["bullet 1", "bullet 2", "bullet 3"],
  "move": "...",
  "bright": "...",
  "summary": "...",
  "nextReveal": "..."
}`;

  try {
    console.log(`🤖 Deep analysis for ${name} in ${lang} | ${submissions.length} sessions | ${storedSessionSummaries?.length || 0} summaries stored`);
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are ${name}'s most perceptive friend. You've read every check-in. You write short, punchy, specific — like someone who actually paid attention and has real things to say.

Rules:
1. Specific to ${name}'s data. If it fits anyone else, cut it.
2. Short sentences. People scan. Make every word count.
3. Name actual numbers and patterns — not vague impressions.
4. If something's wrong, say it directly. Warmth without hedging.
5. Connect pillars when the data shows it — name it explicitly.
6. NEVER: prioritize, focus on, well-being, holistic, self-care, mindful, journey, leverage, actionable, empower, optimize, it appears, based on your data, great work, keep it up, lay a foundation.

JSON only. No markdown. Write in ${lang}.`
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 2600,
    });

    let txt = completion.choices[0].message.content.trim().replace(/```json\n?/g, '').replace(/```\n?/g, '');
    const parsed = JSON.parse(txt);

    console.log(`✅ Analysis done for ${name} in ${getLanguageName(userLanguage)}`);
    return {
      success: true,
      analysis: {
        hook:        parsed.hook                                    || null,
        bullets:     Array.isArray(parsed.bullets) ? parsed.bullets : [],
        move:        parsed.move        || null,
        bright:      parsed.bright      || null,
        summary:     parsed.summary     || null,
        nextReveal:  parsed.nextReveal  || null,
        totalChecks: submissions.length,
        pillarTrends,
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
    const { name, ageGroup, gender, language, leaderboardConsent, pillarBaselines, vision, goalTimeline } = req.body;

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
      if (pillarBaselines && typeof pillarBaselines === 'object') updateData['profile.pillarBaselines'] = pillarBaselines;
      if (vision) updateData['profile.vision'] = vision.trim();
      if (goalTimeline) updateData['profile.goalTimeline'] = goalTimeline;

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
        ...(pillarBaselines && typeof pillarBaselines === 'object' ? { pillarBaselines } : {}),
        ...(vision ? { vision: vision.trim() } : {}),
        ...(goalTimeline ? { goalTimeline } : {}),
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
    // Session N = number of times they've already checked this pillar + 1 (next session)
    const pillarSessions = data.profile.pillarSessions || {};
    const sessionNumber = (pillarSessions[pillar.toLowerCase()] || 0) + 1;

    const result = await generatePersonalizedQuestions(data.profile, pillar.toLowerCase(), data.submissions || [], sessionNumber, data.sessionSummaries || []);

    if (!result.success) throw new Error('Question generation failed');

    res.json({
      success: true,
      questions: result.questions,
      profile: { name: data.profile.name },
      pillar: pillar.toLowerCase(),
      sessionNumber,
      phase: result.phase || 'Foundation',
      topicsUsed: result.topicsUsed || [],
    });
  } catch (error) {
    console.error('Get questions error:', error);
    res.status(500).json({ success: false, error: 'Failed to generate questions. Please try again.' });
  }
});

router.post('/submit', requireDeviceId, checkDailyLimit, async (req, res) => {
  try {
    const { deviceId } = req;
    const { questions, answers, pillar, topicsUsed } = req.body;

    if (!questions || !answers || questions.length < 8 || answers.length < 8 || questions.length > 9 || answers.length > 9)
      return res.status(400).json({ success: false, error: 'Invalid submission. 8 or 9 questions and answers required.' });
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

    // STEP 5: Generate content (all in parallel — no extra latency)
    const [individualTipResult, quoteAndTipsResult, sessionSummaryResult] = await Promise.allSettled([
      generateIndividualTip(profile, pillar, questions, answers, todayPillarScore, submissions),
      generateQuoteAndStrategicTips(profile, pillar, questions, answers, pillarScores, aliveScore, scoringJustification, submissions),
      generateSessionSummary(profile, pillar, questions, answers, todayPillarScore, scoringJustification),
    ]);

    const individualTip = individualTipResult.status === 'fulfilled'
      ? individualTipResult.value
      : 'Small actions today create big changes tomorrow.';

    const { quote, message, strategicTips, weakestPillar, weakestBoost } = quoteAndTipsResult.status === 'fulfilled'
      ? quoteAndTipsResult.value
      : { quote: 'You showed up today', message: 'Every check-in is a step forward.', strategicTips: [], weakestPillar: weakest, weakestBoost: null };

    const sessionSummary = sessionSummaryResult.status === 'fulfilled'
      ? sessionSummaryResult.value
      : `${profile.name} completed a ${pillar} check-in scoring ${todayPillarScore}/100.`;

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
      topicsUsed: Array.isArray(topicsUsed) ? topicsUsed : [],
      sessionSummary,            // AI digest of this session — used for deep analysis

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

    // Increment session counter for this pillar
    const currentPillarSessions = data.profile.pillarSessions || {};
    const newSessionNumber = (currentPillarSessions[pillar.toLowerCase()] || 0) + 1;
    const updatedPillarSessions = { ...currentPillarSessions, [pillar.toLowerCase()]: newSessionNumber };

    // ── SESSION SUMMARIES — separate top-level field for fast analysis reads ──
    // Stores a compact digest of every session without loading full Q&A arrays.
    // Capped at 60 entries (same as MAX_STORED_SUBMISSIONS), newest first.
    const existingSummaries = data.sessionSummaries || [];
    const newSummaryEntry = {
      id: submissionId,
      date: today,
      pillar: pillar.toLowerCase(),
      score: todayPillarScore,
      aliveScore,
      summary: sessionSummary,
      topicsUsed: Array.isArray(topicsUsed) ? topicsUsed : [],
    };
    const updatedSummaries = [newSummaryEntry, ...existingSummaries].slice(0, MAX_STORED_SUBMISSIONS);

    await docRef.update({
      submissions: updatedSubmissions,
      sessionSummaries: updatedSummaries,
      'profile.pillarSessions': updatedPillarSessions,
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
        timestamp: nowTimestamp,
        sessionNumber: newSessionNumber,
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

// GET — load cached analysis (no gate, no AI call)
router.get('/ai-analysis', requireDeviceId, async (req, res) => {
  try {
    const { deviceId } = req;
    const doc = await getDb().collection('aliveChecks').doc(deviceId).get();
    if (!doc.exists) return res.json({ success: true, analysis: null, canGenerate: true, checksUntilGenerate: 0, totalChecks: 0 });

    const data = doc.data();
    const submissions = data.submissions || [];
    const last = data.lastAnalysis || null;

    const newSince = last ? submissions.length - (last.submissionsCountAtGeneration || 0) : submissions.length;
    const canGenerate = !last || newSince >= 4;
    const checksUntilGenerate = canGenerate ? 0 : Math.max(0, 4 - newSince);

    return res.json({
      success: true,
      analysis: last?.data || null,
      generatedAt: last?.generatedAt || null,
      canGenerate,
      checksUntilGenerate,
      totalChecks: submissions.length,
    });
  } catch (error) {
    console.error('Get AI analysis error:', error);
    res.status(500).json({ success: false, error: 'Failed to load analysis.' });
  }
});

// POST — generate fresh analysis (gated)
router.post('/ai-analysis', requireDeviceId, async (req, res) => {
  try {
    const { deviceId } = req;
    const doc = await getDb().collection('aliveChecks').doc(deviceId).get();

    if (!doc.exists) return res.status(404).json({ success: false, error: 'No data found. Complete some checks first.' });

    const data = doc.data();
    const profile = data.profile;
    const submissions = data.submissions || [];

    if (!profile?.profileCompleted)
      return res.status(400).json({ success: false, error: 'Profile not completed', needsProfile: true });

    if (submissions.length < 1)
      return res.status(400).json({ success: false, error: 'Complete at least one check-in first.' });

    const lastAnalysis = data.lastAnalysis || null;
    if (lastAnalysis) {
      const newSince = submissions.length - (lastAnalysis.submissionsCountAtGeneration || 0);
      if (newSince < 4)
        return res.status(400).json({ success: false, error: `Complete ${4 - newSince} more check-in${4 - newSince !== 1 ? 's' : ''} to unlock a fresh analysis.`, checksNeeded: 4 - newSince });
    }

    const stats = data.stats || null;
    const storedSessionSummaries = data.sessionSummaries || [];
    const analysisResult = await getPersonalizedAnalysis(profile, submissions, lastAnalysis, stats, storedSessionSummaries);
    if (!analysisResult.success) return res.status(500).json(analysisResult);

    // Persist to Firestore
    await getDb().collection('aliveChecks').doc(deviceId).update({
      lastAnalysis: {
        data: analysisResult.analysis,
        generatedAt: new Date().toISOString(),
        submissionsCountAtGeneration: submissions.length,
      },
    });

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

// ── GET /stats — combined total check-ins + day streak (Alive + Mirror) ──────
router.get('/stats', requireDeviceId, async (req, res) => {
  try {
    const { deviceId } = req;
    const db = getDb();

    // 1. Fetch both sources in parallel
    const [aliveDoc, mirrorSnap] = await Promise.all([
      db.collection('aliveChecks').doc(deviceId).get(),
      db.collection('mirrorCheckins').where('deviceId', '==', deviceId).get(),
    ]);

    const aliveSubmissions = aliveDoc.exists ? (aliveDoc.data().submissions || []) : [];
    const totalCheckIns = aliveSubmissions.length + mirrorSnap.size;

    // 2. Build set of all active dates (YYYY-MM-DD)
    const activeDates = new Set();
    aliveSubmissions.forEach(s => { if (s.date) activeDates.add(s.date.slice(0, 10)); });
    mirrorSnap.docs.forEach(d => { const dt = d.data().date; if (dt) activeDates.add(dt.slice(0, 10)); });

    const sortedAsc = [...activeDates].sort(); // oldest first

    // 3. Longest streak
    let longestStreak = sortedAsc.length > 0 ? 1 : 0;
    let tempStreak = 1;
    for (let i = 1; i < sortedAsc.length; i++) {
      const diff = (new Date(sortedAsc[i]) - new Date(sortedAsc[i - 1])) / 86400000;
      if (Math.round(diff) === 1) { tempStreak++; longestStreak = Math.max(longestStreak, tempStreak); }
      else tempStreak = 1;
    }

    // 4. Current day streak (consecutive days ending today or yesterday — streak still alive)
    let dayStreak = 0;
    if (sortedAsc.length > 0) {
      const todayStr = new Date().toISOString().slice(0, 10);
      const lastDate = sortedAsc[sortedAsc.length - 1];
      const diffFromToday = Math.round((new Date(todayStr) - new Date(lastDate)) / 86400000);

      if (diffFromToday <= 1) { // last activity was today or yesterday
        dayStreak = 1;
        for (let i = sortedAsc.length - 2; i >= 0; i--) {
          const diff = Math.round((new Date(sortedAsc[i + 1]) - new Date(sortedAsc[i])) / 86400000);
          if (diff === 1) dayStreak++;
          else break;
        }
      }
    }

    // 5. Persist computed stats to Firestore so they survive across sessions
    if (aliveDoc.exists) {
      await db.collection('aliveChecks').doc(deviceId).update({
        'stats.dayStreak': dayStreak,
        'stats.longestStreak': longestStreak,
        'stats.totalCheckIns': totalCheckIns,
        'stats.updatedAt': new Date().toISOString(),
      });
    }

    res.json({ success: true, dayStreak, longestStreak, totalCheckIns });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ success: false, error: 'Failed to load stats' });
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