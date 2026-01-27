// 🫀 STILL ALIVE - ALIVE CHECK FEATURE
// World's Best Wellness Tracking API
// ============================================

const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const { OpenAI } = require('openai');
const { getRandomQuestionSet, getTotalSets, getTotalQuestions } = require('./questionBank');

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Get Firestore (lazy - avoids init race condition)
const getDb = () => admin.firestore();

// ============================================
// CONSTANTS
// ============================================

const MAX_DAILY_CHECKS = 5;
const MAX_STORED_SUBMISSIONS = 45;
const IST_OFFSET = 5.5 * 60 * 60 * 1000;

// ============================================
// HELPER FUNCTIONS
// ============================================

const getCurrentDateIST = () => {
  const now = new Date();
  const istTime = new Date(now.getTime() + IST_OFFSET);
  return istTime.toISOString().split('T')[0];
};

const getMidnightISTTimestamp = () => {
  const now = new Date();
  const istTime = new Date(now.getTime() + IST_OFFSET);
  istTime.setHours(0, 0, 0, 0);
  return istTime.getTime() - IST_OFFSET;
};

const getNextMidnightIST = () => {
  const midnight = getMidnightISTTimestamp();
  return midnight + (24 * 60 * 60 * 1000);
};

const formatTimeUntilReset = (resetTime) => {
  const now = Date.now();
  const remaining = resetTime - now;

  if (remaining <= 0) return 'now';

  const hours = Math.floor(remaining / (1000 * 60 * 60));
  const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));

  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

const calculateFallbackScore = (answers) => {
  let score = 50;

  answers.forEach(answer => {
    const val = answer.answer;

    if (val === 'yes' || val === 'Good' || val === 'Amazing' || val === 'Thriving') {
      score += 8;
    } else if (val === 'Okay' || val === 'Neutral' || val === 'Getting by') {
      score += 3;
    } else if (typeof val === 'number') {
      score += (val - 3) * 5;
    }
  });

  return Math.min(100, Math.max(0, score));
};

const getVibeFromScore = (score) => {
  if (score >= 80) return { vibe: 'THRIVING', emoji: '🔥' };
  if (score >= 60) return { vibe: 'LIVING', emoji: '⚡' };
  if (score >= 40) return { vibe: 'SURVIVING', emoji: '💪' };
  return { vibe: 'STRUGGLING', emoji: '🌱' };
};

// ============================================
// CHATGPT INTEGRATION - WORLD-CLASS PROMPTING
// ============================================

const getAliveScoreFromGPT = async (questions, answers) => {
  try {
    const qaContext = questions.map((q, index) => {
      const answer = answers[index];
      return `Q: ${q.text}\nA: ${answer.answer}`;
    }).join('\n\n');

    const prompt = `You are Alex, an empathetic wellness coach who deeply understands human emotions and wellbeing. Someone just completed their daily check-in, and you need to give them meaningful feedback.

📊 THEIR RESPONSES:
${qaContext}

🎯 YOUR MISSION:
Analyze their responses holistically and provide personalized feedback that genuinely resonates with their current state.

📈 SCORING GUIDELINES (0-100):
- 85-100: THRIVING - Excellent sleep (7-9h), high energy, positive mood, strong social connections, feeling accomplished
- 70-84: LIVING WELL - Good overall with 1-2 minor areas to improve (e.g., slightly tired but happy)
- 55-69: DOING OKAY - Mixed bag, some good areas but struggling in others (e.g., good mood but poor sleep)
- 40-54: SURVIVING - Multiple challenging areas, low energy, stressed, but still functioning
- 20-39: STRUGGLING - Significant difficulties across most areas, very low mood/energy/sleep
- 0-19: CRISIS MODE - Severe issues, needs immediate support

🎨 QUOTE REQUIREMENTS (CRITICAL):
- EXACTLY 4-8 words, NO MORE
- Must feel personal to their specific situation
- Avoid generic platitudes like "stay positive" or "you got this"
- Match their emotional state authentically
- Examples for different states:
  * Thriving: "Your energy is absolutely contagious" (5 words)
  * Living: "You're building something beautiful here" (5 words)  
  * Surviving: "Still standing counts as winning" (5 words)
  * Struggling: "Tomorrow brings new possibilities, friend" (5 words)

💬 MESSAGE REQUIREMENTS (CRITICAL):
- EXACTLY 1-2 sentences, MAX 25 words total
- Reference something SPECIFIC from their answers
- Be warm, human, and genuine (like texting a friend)
- Acknowledge their reality without toxic positivity
- Examples:
  * "That 8-hour sleep really shows in your energy! Keep protecting that rest time."
  * "You showed up today despite feeling drained. That takes real strength."
  * "Your mood's been up and down, but you're still here checking in. That matters."

⚠️ CRITICAL RULES:
- Score must reflect ALL dimensions (sleep, energy, mood, connections, stress)
- Poor sleep (<6h) caps score at 65 maximum
- High stress + low mood caps score at 55 maximum
- Be realistic but compassionate
- NO quotation marks in the quote itself
- Quality > Length. Brevity is power.

Respond ONLY with valid JSON:
{
  "score": 75,
  "quote": "Your exact quote here",
  "message": "Your brief specific message here."
}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { 
          role: 'system', 
          content: 'You are Alex, a warm and insightful wellness coach. You speak like a supportive friend who truly gets it. Always respond with valid JSON only. Never use markdown code blocks. Be concise, specific, and genuine.' 
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.8,
      max_tokens: 200,
    });

    let responseText = completion.choices[0].message.content.trim();

    if (responseText.startsWith('```json')) {
      responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    } else if (responseText.startsWith('```')) {
      responseText = responseText.replace(/```\n?/g, '');
    }

    responseText = responseText.trim();

    const parsed = JSON.parse(responseText);

    if (!parsed.score || !parsed.quote || !parsed.message) {
      throw new Error('Invalid GPT response structure');
    }

    const quoteWords = parsed.quote.split(' ').length;
    if (quoteWords > 10) {
      console.warn(`⚠️ Quote too long (${quoteWords} words), using fallback`);
      throw new Error('Quote too long');
    }

    const messageWords = parsed.message.split(' ').length;
    if (messageWords > 30) {
      console.warn(`⚠️ Message too long (${messageWords} words), using fallback`);
      throw new Error('Message too long');
    }

    const { vibe, emoji } = getVibeFromScore(parsed.score);

    console.log(`✅ GPT Response - Score: ${parsed.score}, Quote: ${quoteWords} words, Message: ${messageWords} words`);

    return {
      score: Math.min(100, Math.max(0, parsed.score)),
      quote: parsed.quote,
      message: parsed.message,
      emoji,
      vibe,
      source: 'gpt'
    };

  } catch (error) {
    console.error('ChatGPT error:', error.message);

    const fallbackScore = calculateFallbackScore(answers);
    const { vibe, emoji } = getVibeFromScore(fallbackScore);

    const fallbackQuotes = {
      THRIVING: "You're absolutely crushing it today",
      LIVING: "Keep that momentum going strong",
      SURVIVING: "Still showing up counts",
      STRUGGLING: "One step at a time"
    };

    const fallbackMessages = {
      THRIVING: "Your energy is incredible today. Keep riding this wave!",
      LIVING: "You're doing well overall. Small wins add up.",
      SURVIVING: "You're here, and that matters. Be gentle with yourself.",
      STRUGGLING: "Tough moments pass. You've got this, one breath at a time."
    };

    console.log(`⚠️ Using fallback response for ${vibe}`);

    return {
      score: fallbackScore,
      quote: fallbackQuotes[vibe],
      message: fallbackMessages[vibe],
      emoji,
      vibe,
      source: 'fallback'
    };
  }
};

const getAIAnalysis = async (submissions) => {
  try {
    if (submissions.length === 0) {
      return {
        success: false,
        message: 'Not enough data for analysis. Complete at least 3 checks to unlock AI insights.'
      };
    }

    const last30 = submissions.slice(0, 30).reverse();
    const last7 = submissions.slice(0, 7);

    const scoreData = last30.map(s => `${s.date}: Score ${s.score}/100 [${s.vibe}] - ${s.emoji}`).join('\n');

    const avgScore = Math.round(last7.reduce((sum, s) => sum + s.score, 0) / last7.length);
    const overallAvg = Math.round(submissions.reduce((sum, s) => sum + s.score, 0) / submissions.length);

    const scores = last30.map(s => s.score);
    const highestScore = Math.max(...scores);
    const lowestScore = Math.min(...scores);

    const scoreTrend = scores.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
    const olderTrend = scores.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const trendDirection = scoreTrend > olderTrend + 3 ? 'improving' : scoreTrend < olderTrend - 3 ? 'declining' : 'stable';

    const prompt = `You are Dr. Maya Chen, a renowned wellness psychologist with 15 years of experience in behavioral health patterns. You're analyzing someone's wellness journey to provide deeply insightful, actionable guidance.

📊 WELLNESS DATA (Last 30 Days):
${scoreData}

📈 KEY METRICS:
- Last 7 days average: ${avgScore}/100
- Overall average: ${overallAvg}/100
- Best day: ${highestScore}/100
- Toughest day: ${lowestScore}/100
- Trend: ${trendDirection}
- Total check-ins: ${submissions.length}

🎯 YOUR MISSION:
Analyze this person's wellness patterns like a detective looking for clues. Find the story in their data. What's really happening beneath the surface?

📝 REQUIRED OUTPUT STRUCTURE:

1️⃣ OBSERVATIONS (15-20 words, 1 sentence):
- Identify the MOST SIGNIFICANT pattern or trend
- Be specific with numbers when relevant
- Focus on what's actually happening, not why
- Examples:
  * "Your scores dropped 20 points mid-week consistently, then recovered on weekends."
  * "You've maintained 70+ scores for 9 straight days—your best streak yet."
  * "Scores fluctuate wildly between 45-85 with no clear pattern emerging."

2️⃣ INSIGHTS (15-20 words, 1 sentence):  
- Explain WHAT THIS MEANS for their wellbeing
- Connect the pattern to likely causes
- Be thoughtful but not preachy
- Examples:
  * "This suggests work stress builds up through the week but you recover well with rest."
  * "Consistency like this means you've found a rhythm that truly works for you."
  * "This volatility indicates external factors are heavily impacting your daily experience."

3️⃣ RECOMMENDATIONS (3 items, EACH 8-12 words):
- Give SPECIFIC, ACTIONABLE steps they can take THIS WEEK
- Tailor advice to their exact patterns
- Make it practical and achievable
- Each recommendation should be DIFFERENT (don't repeat the same idea)
- Focus on: 
  * One immediate action (today/tomorrow)
  * One habit to build (this week)
  * One thing to track or notice
- Examples for someone with midweek crashes:
  * "Schedule a 15-minute walk outside every Wednesday at lunch"
  * "Block 30 minutes Tuesday evening for something you enjoy"
  * "Track what you eat on low-score days vs high-score days"

⚠️ CRITICAL RULES:
- NO generic advice like "drink water" or "exercise more"
- NO vague suggestions like "practice self-care" or "be mindful"  
- Every recommendation must be SPECIFIC and MEASURABLE
- Tie recommendations directly to patterns you observed
- Write like you're coaching a friend, not writing a textbook
- Be encouraging but realistic—no toxic positivity

Respond ONLY with valid JSON:
{
  "observations": "Your specific observation here",
  "insights": "Your specific insight here",
  "recommendations": [
    "Specific action 1 here",
    "Specific action 2 here", 
    "Specific action 3 here"
  ]
}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { 
          role: 'system', 
          content: 'You are Dr. Maya Chen, an expert wellness psychologist. You analyze patterns deeply and give practical, specific advice. Always respond with valid JSON only. Never use markdown code blocks. Be concise, insightful, and genuinely helpful.' 
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 400,
    });

    let responseText = completion.choices[0].message.content.trim();

    if (responseText.startsWith('```json')) {
      responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    } else if (responseText.startsWith('```')) {
      responseText = responseText.replace(/```\n?/g, '');
    }

    responseText = responseText.trim();

    const parsed = JSON.parse(responseText);

    console.log(`✅ AI Analysis generated successfully`);

    return {
      success: true,
      analysis: {
        observations: parsed.observations,
        insights: parsed.insights,
        recommendations: parsed.recommendations,
        averageScore: avgScore,
        totalChecks: submissions.length,
        dateRange: {
          from: submissions[submissions.length - 1].date,
          to: submissions[0].date
        }
      }
    };

  } catch (error) {
    console.error('AI Analysis error:', error.message);

    return {
      success: false,
      error: 'Unable to generate AI insights right now. Please try again later.'
    };
  }
};

// ============================================
// MIDDLEWARE
// ============================================

const checkDailyLimit = async (req, res, next) => {
  try {
    const deviceId = req.deviceId || req.body.deviceId || req.query.deviceId;

    if (!deviceId) {
      return res.status(400).json({
        success: false,
        error: 'Device ID required'
      });
    }

    const today = getCurrentDateIST();
    const docRef = getDb().collection('aliveChecks').doc(deviceId);
    const doc = await docRef.get();

    if (!doc.exists) {
      req.isFirstCheck = true;
      return next();
    }

    const data = doc.data();
    const lastCheckDate = data.lastCheckDate || '';
    const todayCount = lastCheckDate === today ? (data.todayCount || 0) : 0;

    if (todayCount >= MAX_DAILY_CHECKS) {
      const resetTime = getNextMidnightIST();
      const timeUntil = formatTimeUntilReset(resetTime);

      return res.status(429).json({
        success: false,
        error: 'daily_limit_reached',
        message: `You've completed your 5 wellness checks for today! 💚 Come back in ${timeUntil} to track your vibe again.`,
        limit: MAX_DAILY_CHECKS,
        used: todayCount,
        resetIn: timeUntil,
        resetTime: new Date(resetTime).toISOString()
      });
    }

    req.currentDayCount = todayCount;
    req.today = today;
    next();

  } catch (error) {
    console.error('Rate limit check error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check rate limit'
    });
  }
};

const requireDeviceId = (req, res, next) => {
  const deviceId = req.body.deviceId || req.query.deviceId;

  if (!deviceId) {
    return res.status(400).json({
      success: false,
      error: 'Device ID required'
    });
  }

  req.deviceId = deviceId;
  next();
};

// ============================================
// ROUTES
// ============================================

router.get('/questions', requireDeviceId, async (req, res) => {
  try {
    const deviceId = req.deviceId;

    const docRef = getDb().collection('aliveChecks').doc(deviceId);
    const doc = await docRef.get();

    const lastSetIndex = doc.exists ? doc.data().lastSetIndex : null;
    const { setIndex, questions } = getRandomQuestionSet(lastSetIndex);

    res.json({
      success: true,
      questions,
      setIndex,
      meta: {
        totalSets: getTotalSets(),
        totalQuestions: getTotalQuestions()
      }
    });

  } catch (error) {
    console.error('Get questions error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get questions'
    });
  }
});

router.post('/submit', requireDeviceId, checkDailyLimit, async (req, res) => {
  try {
    const { deviceId } = req;
    const { questions, answers, setIndex } = req.body;

    if (!questions || !answers || questions.length !== 5 || answers.length !== 5) {
      return res.status(400).json({
        success: false,
        error: 'Invalid submission. 5 questions and 5 answers required.'
      });
    }

    console.log(`🤖 Getting AI score for ${deviceId}...`);
    const gptResponse = await getAliveScoreFromGPT(questions, answers);

    const today = getCurrentDateIST();
    const docRef = getDb().collection('aliveChecks').doc(deviceId);
    const doc = await docRef.get();

    const nowTimestamp = new Date().toISOString();
    const nowFirestore = admin.firestore.FieldValue.serverTimestamp();
    const submissionId = `check_${Date.now()}`;

    const newSubmission = {
      id: submissionId,
      timestamp: nowTimestamp,
      date: today,
      questions,
      answers,
      score: gptResponse.score,
      quote: gptResponse.quote,
      message: gptResponse.message,
      emoji: gptResponse.emoji,
      vibe: gptResponse.vibe,
      setIndex,
      source: gptResponse.source
    };

    if (!doc.exists) {
      await docRef.set({
        deviceId,
        totalLifetimeChecks: 1,
        lastSetIndex: setIndex,
        todayCount: 1,
        lastCheckDate: today,
        submissions: [newSubmission],
        createdAt: nowFirestore,
        updatedAt: nowFirestore
      });
    } else {
      const data = doc.data();
      let submissions = data.submissions || [];

      submissions.unshift(newSubmission);

      if (submissions.length > MAX_STORED_SUBMISSIONS) {
        submissions = submissions.slice(0, MAX_STORED_SUBMISSIONS);
      }

      const lastCheckDate = data.lastCheckDate || '';
      const todayCount = lastCheckDate === today ? (data.todayCount || 0) + 1 : 1;

      await docRef.update({
        submissions,
        totalLifetimeChecks: admin.firestore.FieldValue.increment(1),
        lastSetIndex: setIndex,
        todayCount,
        lastCheckDate: today,
        updatedAt: nowFirestore
      });
    }

    console.log(`✅ Check submitted: ${deviceId} → Score: ${gptResponse.score} (${gptResponse.source})`);

    res.json({
      success: true,
      submission: {
        id: submissionId,
        score: gptResponse.score,
        quote: gptResponse.quote,
        message: gptResponse.message,
        emoji: gptResponse.emoji,
        vibe: gptResponse.vibe,
        date: today,
        timestamp: nowTimestamp
      },
      remaining: MAX_DAILY_CHECKS - (req.currentDayCount || 0) - 1
    });

  } catch (error) {
    console.error('Submit check error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to submit check. Please try again.'
    });
  }
});

router.get('/history', requireDeviceId, async (req, res) => {
  try {
    const { deviceId } = req;
    const { limit } = req.query;

    const docRef = getDb().collection('aliveChecks').doc(deviceId);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.json({
        success: true,
        history: [],
        total: 0
      });
    }

    const data = doc.data();
    let submissions = data.submissions || [];

    if (limit) {
      const limitNum = parseInt(limit);
      if (!isNaN(limitNum) && limitNum > 0) {
        submissions = submissions.slice(0, limitNum);
      }
    }

    res.json({
      success: true,
      history: submissions,
      total: data.totalLifetimeChecks || submissions.length,
      storedCount: submissions.length
    });

  } catch (error) {
    console.error('Get history error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get history'
    });
  }
});

router.get('/analytics', requireDeviceId, async (req, res) => {
  try {
    const { deviceId } = req;
    const { range } = req.query;

    const docRef = getDb().collection('aliveChecks').doc(deviceId);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.json({
        success: true,
        analytics: null,
        message: 'No data yet. Complete your first check to unlock analytics!'
      });
    }

    const data = doc.data();
    const allSubmissions = data.submissions || [];

    if (allSubmissions.length === 0) {
      return res.json({
        success: true,
        analytics: null,
        message: 'No submissions yet'
      });
    }

    let submissions = allSubmissions;
    const now = new Date();

    if (range === 'week') {
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      submissions = allSubmissions.filter(s => new Date(s.date) >= weekAgo);
    } else if (range === 'month') {
      const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      submissions = allSubmissions.filter(s => new Date(s.date) >= monthAgo);
    }

    const scores = submissions.map(s => s.score);
    const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    const maxScore = Math.max(...scores);
    const minScore = Math.min(...scores);

    const midpoint = Math.floor(submissions.length / 2);
    const recentAvg = submissions.slice(0, midpoint).reduce((a, b) => a + b.score, 0) / midpoint;
    const olderAvg = submissions.slice(midpoint).reduce((a, b) => a + b.score, 0) / (submissions.length - midpoint);

    let trend = 'stable';
    if (recentAvg > olderAvg + 5) trend = 'improving';
    if (recentAvg < olderAvg - 5) trend = 'declining';

    const chartData = submissions.reverse().map(s => ({
      date: s.date,
      score: s.score,
      vibe: s.vibe,
      emoji: s.emoji
    }));

    res.json({
      success: true,
      analytics: {
        summary: {
          average: avgScore,
          highest: maxScore,
          lowest: minScore,
          total: submissions.length,
          trend
        },
        chartData,
        range: range || 'all',
        dateRange: {
          from: submissions[0].date,
          to: submissions[submissions.length - 1].date
        }
      }
    });

  } catch (error) {
    console.error('Get analytics error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get analytics'
    });
  }
});

router.post('/ai-analysis', requireDeviceId, async (req, res) => {
  try {
    const { deviceId } = req;

    const docRef = getDb().collection('aliveChecks').doc(deviceId);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({
        success: false,
        error: 'No data found. Complete at least 3 checks to unlock AI insights.'
      });
    }

    const data = doc.data();
    const submissions = data.submissions || [];

    if (submissions.length < 3) {
      return res.status(400).json({
        success: false,
        error: `You need at least 3 checks for AI insights. You have ${submissions.length}. Keep going!`
      });
    }

    console.log(`🤖 Generating AI analysis for ${deviceId} (${submissions.length} checks)...`);

    const analysisResult = await getAIAnalysis(submissions);

    if (!analysisResult.success) {
      return res.status(500).json(analysisResult);
    }

    console.log(`✅ AI analysis generated for ${deviceId}`);

    res.json({
      success: true,
      ...analysisResult
    });

  } catch (error) {
    console.error('AI analysis error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate AI insights. Please try again.'
    });
  }
});

router.get('/today-count', requireDeviceId, async (req, res) => {
  try {
    const { deviceId } = req;
    const today = getCurrentDateIST();

    const docRef = getDb().collection('aliveChecks').doc(deviceId);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.json({
        success: true,
        count: 0,
        remaining: MAX_DAILY_CHECKS,
        limit: MAX_DAILY_CHECKS,
        canCheck: true
      });
    }

    const data = doc.data();
    const lastCheckDate = data.lastCheckDate || '';
    const todayCount = lastCheckDate === today ? (data.todayCount || 0) : 0;
    const remaining = Math.max(0, MAX_DAILY_CHECKS - todayCount);

    const resetTime = getNextMidnightIST();

    res.json({
      success: true,
      count: todayCount,
      remaining,
      limit: MAX_DAILY_CHECKS,
      canCheck: todayCount < MAX_DAILY_CHECKS,
      resetIn: formatTimeUntilReset(resetTime),
      resetTime: new Date(resetTime).toISOString()
    });

  } catch (error) {
    console.error('Get today count error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get count'
    });
  }
});

router.delete('/history', requireDeviceId, async (req, res) => {
  try {
    const { deviceId } = req;

    const docRef = getDb().collection('aliveChecks').doc(deviceId);
    await docRef.delete();

    console.log(`🗑️ History deleted for ${deviceId}`);

    res.json({
      success: true,
      message: 'All check history deleted successfully'
    });

  } catch (error) {
    console.error('Delete history error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete history'
    });
  }
});

module.exports = router;