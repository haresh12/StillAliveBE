// ============================================
// 🏆 STILL ALIVE — REFERRAL SYSTEM
// ============================================
// v4.0 — Dynamic Contest Config + Apple Compliance
// ============================================
// ✅ Profile REQUIRED from aliveChecks before joining contest
// ✅ Name always comes from aliveChecks profile
// ✅ Leaderboard shows real names always
// ✅ Email collected only when user is in top 3
// ✅ Email stored in aliveChecks profile (same collection)
// ✅ Contest config loaded from local JSON file
// ✅ Multilingual support (6 languages)
// ✅ Apple compliance disclaimer
// ✅ Date-based contest enable/disable
// ✅ No breaking changes
// ============================================

const express = require('express');
const router  = express.Router();
const admin   = require('firebase-admin');
const fs      = require('fs');
const path    = require('path');

const getDb = () => admin.firestore();

// ============================================
// 🏆 CONTEST CONFIG — Load from local JSON
// ============================================
let CONTEST_CONFIG = null;

const loadContestConfig = () => {
  if (!CONTEST_CONFIG) {
    // ✅ FIXED PATH: referral-contest.json is in same directory as referrals.js
    const configPath = path.join(__dirname, 'referral-contest.json');
    CONTEST_CONFIG = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log('✅ Referral contest config loaded from:', configPath);
  }
  return CONTEST_CONFIG;
};

const isContestActive = (config) => {
  if (!config.enabled) return false;
  const now = new Date();
  const start = new Date(config.startDate);
  const end = new Date(config.endDate);
  return now >= start && now <= end;
};

// ============================================
// HELPERS
// ============================================

const getCurrentMonth = () => {
  const now = new Date();
  const y   = now.getFullYear();
  const m   = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
};

const getMonthLabel = (monthStr, language = 'en') => {
  const [year, month] = monthStr.split('-');
  const date = new Date(parseInt(year), parseInt(month) - 1, 1);
  
  const locales = {
    en: 'en-US',
    ru: 'ru-RU',
    es: 'es-ES',
    pt: 'pt-BR',
    fr: 'fr-FR',
    de: 'de-DE'
  };
  
  return date.toLocaleString(locales[language] || 'en-US', { month: 'long', year: 'numeric' });
};

// ✅ Email validation helper
const isValidEmail = (email) => {
  if (!email || typeof email !== 'string') return false;
  const trimmed = email.trim().toLowerCase();
  // RFC 5322 simplified — covers 99.9% of real emails
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(trimmed) && trimmed.length <= 254;
};

// ✅ Single source of truth: name always from aliveChecks first
const getUserDisplayName = async (deviceId) => {
  const db = getDb();
  try {
    const aliveDoc = await db.collection('aliveChecks').doc(deviceId).get();
    if (aliveDoc.exists && aliveDoc.data().profile?.name) {
      return aliveDoc.data().profile.name;
    }
    const userDoc = await db.collection('users').doc(deviceId).get();
    if (userDoc.exists && userDoc.data().displayName && userDoc.data().displayName !== 'User') {
      return userDoc.data().displayName;
    }
    return null;
  } catch (e) {
    return null;
  }
};

// ✅ Get user referral code — aliveChecks first, then users
const getUserCode = async (deviceId) => {
  const db = getDb();
  try {
    const aliveDoc = await db.collection('aliveChecks').doc(deviceId).get();
    if (aliveDoc.exists && aliveDoc.data().profile?.code) {
      return aliveDoc.data().profile.code;
    }
    const userDoc = await db.collection('users').doc(deviceId).get();
    if (userDoc.exists && userDoc.data().code) {
      return userDoc.data().code;
    }
    return null;
  } catch (e) {
    return null;
  }
};

// ✅ Get full aliveChecks profile — gate check
const getAliveProfile = async (deviceId) => {
  const db = getDb();
  try {
    const aliveDoc = await db.collection('aliveChecks').doc(deviceId).get();
    if (aliveDoc.exists && aliveDoc.data().profile?.profileCompleted) {
      return aliveDoc.data().profile;
    }
    return null;
  } catch (e) {
    return null;
  }
};

// ✅ Aggregate referral counts from snapshot
const aggregateCounts = (snapshot) => {
  const counts = {};
  snapshot.forEach(doc => {
    const data = doc.data();
    const rid  = data.referrerDeviceId;
    if (!counts[rid]) counts[rid] = { count: 0, code: data.referrerCode };
    counts[rid].count++;
  });
  return counts;
};

// ============================================
// MIDDLEWARE
// ============================================

const requireDeviceId = (req, res, next) => {
  const deviceId = req.body?.deviceId || req.query?.deviceId;
  if (!deviceId) {
    return res.status(400).json({ success: false, error: 'Device ID required' });
  }
  req.deviceId = deviceId;
  next();
};

// ============================================
// ROUTES
// ============================================

// ============================================
// 🆕 GET /contest-config
// Returns dynamic contest configuration
// Supports multilingual content
// Cached for 1 hour client-side
// ============================================
router.get('/contest-config', async (req, res) => {
  try {
    const { language = 'en' } = req.query;
    const config = loadContestConfig();
    const currentMonth = getCurrentMonth();
    
    // Validate language, fallback to English
    const supportedLangs = ['en', 'ru', 'es', 'pt', 'fr', 'de'];
    const lang = supportedLangs.includes(language) ? language : 'en';
    
    // Get month label in user's language
    const monthLabel = getMonthLabel(currentMonth, lang);
    
    // Check if contest is active (within date range)
    const active = isContestActive(config);
    
    // Set cache headers — 1 hour client-side cache
    res.set('Cache-Control', 'public, max-age=3600');
    
    res.json({
      success: true,
      config: {
        enabled: config.enabled,
        isActive: active,
        currentMonth: monthLabel,
        prizePool: config.prizePool,
        prizes: config.prizes,
        topWinners: Object.keys(config.prizes).length,
        rules: config.rules[lang] || config.rules.en,
        legal: config.legal[lang] || config.legal.en,
        maxParticipants: config.maxParticipants,
      }
    });
  } catch (error) {
    console.error('Contest config error:', error);
    res.status(500).json({ success: false, error: 'Failed to load contest config' });
  }
});

// ============================================
// GET /profile-status
// FE calls this first to decide gate vs full UI
// No profile required — this IS the check
// ============================================
router.get('/profile-status', requireDeviceId, async (req, res) => {
  try {
    const { deviceId } = req;
    const profile = await getAliveProfile(deviceId);
    const code    = profile?.code || await getUserCode(deviceId);

    res.json({
      success:         true,
      hasProfile:      !!profile,
      profileRequired: !profile,
      profile: profile ? {
        name: profile.name,
        code: profile.code || code,
      } : null,
      message: profile
        ? 'Profile found. You can join the contest!'
        : 'Set up your profile to join the referral contest.',
    });
  } catch (error) {
    console.error('Profile status error:', error);
    res.status(500).json({ success: false, error: 'Failed to check profile status' });
  }
});

// ============================================
// POST /validate-code
// Check if a referral code exists + get referrer name
// No profile required — called during onboarding
// ============================================
router.post('/validate-code', async (req, res) => {
  try {
    const { code } = req.body;

    if (!code || typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ success: false, error: 'Code is required' });
    }

    const trimmedCode = code.trim().toUpperCase();

    if (trimmedCode.length !== 6) {
      return res.status(400).json({ success: false, error: 'Code must be 6 characters' });
    }

    const db = getDb();

    const [usersQuery, aliveQuery] = await Promise.all([
      db.collection('users').where('code', '==', trimmedCode).limit(1).get(),
      db.collection('aliveChecks').where('profile.code', '==', trimmedCode).limit(1).get(),
    ]);

    if (usersQuery.empty && aliveQuery.empty) {
      return res.json({ success: true, valid: false, message: 'Code not found' });
    }

    let referrerName     = 'a friend';
    let referrerDeviceId = null;

    if (!aliveQuery.empty) {
      referrerDeviceId = aliveQuery.docs[0].id;
      referrerName     = aliveQuery.docs[0].data().profile?.name || 'a friend';
    } else if (!usersQuery.empty) {
      referrerDeviceId = usersQuery.docs[0].id;
      const nameFromAlive = await getUserDisplayName(referrerDeviceId);
      referrerName = nameFromAlive || usersQuery.docs[0].data().displayName || 'a friend';
    }

    return res.json({
      success:      true,
      valid:        true,
      referrerName,
      message:      `Code valid! You were invited by ${referrerName} 🎉`,
    });
  } catch (error) {
    console.error('Validate referral code error:', error);
    res.status(500).json({ success: false, error: 'Failed to validate code' });
  }
});

// ============================================
// POST /track
// Record a referral when new user signs up with code
// Apple compliant: only referrer tracked/rewarded
// No profile required for new user (they're signing up)
// ============================================
router.post('/track', requireDeviceId, async (req, res) => {
  try {
    const { deviceId }    = req;
    const { referralCode } = req.body;

    if (!referralCode || typeof referralCode !== 'string' || !referralCode.trim()) {
      return res.status(400).json({ success: false, error: 'Referral code is required' });
    }

    const trimmedCode = referralCode.trim().toUpperCase();

    if (trimmedCode.length !== 6) {
      return res.status(400).json({ success: false, error: 'Code must be 6 characters' });
    }

    const db = getDb();

    // ── Check duplicate: has this device already used a referral?
    const existingReferral = await db
      .collection('referrals')
      .where('newUserDeviceId', '==', deviceId)
      .limit(1)
      .get();

    if (!existingReferral.empty) {
      return res.status(400).json({
        success: false,
        error:   'Referral already recorded for this device',
      });
    }

    // ── Find referrer by code
    const [usersQuery, aliveQuery] = await Promise.all([
      db.collection('users').where('code', '==', trimmedCode).limit(1).get(),
      db.collection('aliveChecks').where('profile.code', '==', trimmedCode).limit(1).get(),
    ]);

    if (usersQuery.empty && aliveQuery.empty) {
      return res.status(404).json({
        success: false,
        error:   'Invalid referral code. Code not found.',
      });
    }

    let referrerDeviceId = null;
    if (!aliveQuery.empty)      referrerDeviceId = aliveQuery.docs[0].id;
    else if (!usersQuery.empty) referrerDeviceId = usersQuery.docs[0].id;

    // ── Prevent self-referral
    if (referrerDeviceId === deviceId) {
      return res.status(400).json({
        success: false,
        error:   'You cannot use your own referral code',
      });
    }

    // ── Save referral record
    const currentMonth = getCurrentMonth();

    await db.collection('referrals').add({
      referrerDeviceId,
      referrerCode:    trimmedCode,
      newUserDeviceId: deviceId,
      month:           currentMonth,
      createdAt:       admin.firestore.FieldValue.serverTimestamp(),
      createdAtISO:    new Date().toISOString(),
    });

    console.log(`✅ Referral tracked: ${referrerDeviceId} → ${deviceId} [${currentMonth}]`);

    const referrerName = await getUserDisplayName(referrerDeviceId) || 'a friend';

    res.json({
      success:    true,
      message:    `Referral recorded! You joined through ${referrerName}'s invite 🎉`,
      month:      currentMonth,
      monthLabel: getMonthLabel(currentMonth),
    });
  } catch (error) {
    console.error('Track referral error:', error);
    res.status(500).json({ success: false, error: 'Failed to track referral' });
  }
});

// ============================================
// GET /my-stats
// Current user's referral stats + rank
// ✅ Now uses dynamic config for prizes
// ✅ Includes claimEmail + emailSubmitted
// ✅ Includes prize info if in top 3
// ============================================
router.get('/my-stats', requireDeviceId, async (req, res) => {
  try {
    const { deviceId } = req;
    const { month }    = req.query;
    const targetMonth  = month || getCurrentMonth();
    const db           = getDb();

    // Load contest config
    const config = loadContestConfig();
    const PRIZE_POOL = config.prizePool;
    const TOP_WINNERS = Object.keys(config.prizes).length;
    const PRIZE_DISTRIBUTION = config.prizes;

    // ── Get profile
    const profile = await getAliveProfile(deviceId);
    const myName  = profile?.name || await getUserDisplayName(deviceId) || null;
    const myCode  = profile?.code || await getUserCode(deviceId);

    // ── My referrals this month
    const myReferralsSnap = await db
      .collection('referrals')
      .where('referrerDeviceId', '==', deviceId)
      .where('month', '==', targetMonth)
      .get();

    const myCount = myReferralsSnap.size;

    // ── All referrals this month (for rank calculation)
    const allReferralsSnap = await db
      .collection('referrals')
      .where('month', '==', targetMonth)
      .get();

    const counts = aggregateCounts(allReferralsSnap);
    const sorted = Object.entries(counts).sort((a, b) => b[1].count - a[1].count);

    const myRankIndex    = sorted.findIndex(([id]) => id === deviceId);
    const myRank         = myRankIndex >= 0 ? myRankIndex + 1 : null;
    const totalParticipants = sorted.length;

    // ── All-time count
    const allTimeSnap = await db
      .collection('referrals')
      .where('referrerDeviceId', '==', deviceId)
      .get();

    const allTimeCount = allTimeSnap.size;

    // ── Prize info
    const isInTop3    = myRank !== null && myRank <= TOP_WINNERS && myCount > 0;
    const prizeAmount = isInTop3 ? PRIZE_DISTRIBUTION[myRank] : null;

    // ✅ Email claim state — from aliveChecks profile
    const claimEmail     = profile?.claimEmail     || null;
    const emailSubmitted = !!profile?.claimEmail;

    res.json({
      success:         true,
      hasProfile:      !!profile,
      profileRequired: !profile,
      stats: {
        deviceId,
        name:               myName,
        code:               myCode,
        month:              targetMonth,
        monthLabel:         getMonthLabel(targetMonth),
        monthlyReferrals:   myCount,
        allTimeReferrals:   allTimeCount,
        rank:               myCount > 0 ? myRank : null,
        totalParticipants,
        prizePool:          PRIZE_POOL,
        prizeAmount,
        isInTop3,
        topWinners:         TOP_WINNERS,
        prizeDistribution:  PRIZE_DISTRIBUTION,
        // ✅ Email claim fields
        claimEmail,
        emailSubmitted,
      },
    });
  } catch (error) {
    console.error('My referral stats error:', error);
    res.status(500).json({ success: false, error: 'Failed to get stats' });
  }
});

// ============================================
// GET /leaderboard
// Public — no profile required to VIEW
// Only shows users with aliveChecks profiles (real names)
// ✅ Now uses dynamic config for prizes
// ============================================
router.get('/leaderboard', async (req, res) => {
  try {
    const { month }   = req.query;
    const targetMonth = month || getCurrentMonth();
    const db          = getDb();

    // Load contest config
    const config = loadContestConfig();
    const PRIZE_POOL = config.prizePool;
    const TOP_WINNERS = Object.keys(config.prizes).length;
    const PRIZE_DISTRIBUTION = config.prizes;

    const referralsSnap = await db
      .collection('referrals')
      .where('month', '==', targetMonth)
      .get();

    if (referralsSnap.empty) {
      return res.json({
        success:          true,
        leaderboard:      [],
        month:            targetMonth,
        monthLabel:       getMonthLabel(targetMonth),
        prizePool:        PRIZE_POOL,
        prizeDistribution: PRIZE_DISTRIBUTION,
        totalReferrals:   0,
        totalParticipants: 0,
        lastUpdated:      new Date().toISOString(),
      });
    }

    const counts = aggregateCounts(referralsSnap);
    const sorted = Object.entries(counts)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10);

    // ✅ Fetch names — only include users with aliveChecks profiles
    const leaderboardRaw = await Promise.all(
      sorted.map(async ([deviceId, data], index) => {
        const rank    = index + 1;
        const profile = await getAliveProfile(deviceId);
        const name    = profile?.name || await getUserDisplayName(deviceId);

        return {
          rank,
          name:        name || null,
          hasProfile:  !!profile,
          referrals:   data.count,
          code:        data.code,
          prizeAmount: PRIZE_DISTRIBUTION[rank] || null,
          isWinner:    rank <= TOP_WINNERS,
        };
      })
    );

    // ✅ Filter to only named users, re-rank
    const leaderboard = leaderboardRaw
      .filter(entry => entry.name !== null)
      .map((entry, index) => ({ ...entry, rank: index + 1 }));

    res.json({
      success:           true,
      leaderboard,
      month:             targetMonth,
      monthLabel:        getMonthLabel(targetMonth),
      prizePool:         PRIZE_POOL,
      prizeDistribution: PRIZE_DISTRIBUTION,
      totalReferrals:    referralsSnap.size,
      totalParticipants: leaderboard.length,
      lastUpdated:       new Date().toISOString(),
    });
  } catch (error) {
    console.error('Referral leaderboard error:', error);
    res.status(500).json({ success: false, error: 'Failed to get leaderboard' });
  }
});

// ============================================
// GET /my-code
// Returns user's referral code
// Requires aliveChecks profile
// ============================================
router.get('/my-code', requireDeviceId, async (req, res) => {
  try {
    const { deviceId } = req;
    const profile      = await getAliveProfile(deviceId);

    if (!profile) {
      return res.status(403).json({
        success:         false,
        error:           'profile_required',
        profileRequired: true,
        message:         'Set up your profile first to get your referral code.',
      });
    }

    const code = profile.code || await getUserCode(deviceId);
    const name = profile.name;

    if (!code) {
      return res.status(404).json({
        success: false,
        error:   'No referral code found. Please complete your profile setup.',
      });
    }

    res.json({
      success:      true,
      code,
      name,
      hasProfile:   true,
      shareMessage: `Join me on Pulse! Use my code ${code} when you sign up 🫀`,
    });
  } catch (error) {
    console.error('Get my code error:', error);
    res.status(500).json({ success: false, error: 'Failed to get referral code' });
  }
});

// ============================================
// PATCH /claim-email
// ✅ Save email for prize payout
// Only meaningful when user is in top 3
// But we accept it regardless of rank (future-proof)
// Stored in aliveChecks profile — same collection
//
// Edge cases handled:
// ✅ Profile must exist
// ✅ Email validated (format + length)
// ✅ Email already submitted → returns existing email, no overwrite
//    unless force=true is passed (for update flow)
// ✅ Saves claimEmail + claimEmailAddedAt + claimEmailUpdatedAt
// ✅ Never stores empty or invalid email
// ============================================
router.patch('/claim-email', requireDeviceId, async (req, res) => {
  try {
    const { deviceId }    = req;
    const { email, force } = req.body;

    // ── Validate email presence
    if (!email) {
      return res.status(400).json({
        success: false,
        error:   'Email is required',
      });
    }

    const trimmedEmail = email.trim().toLowerCase();

    // ── Validate email format
    if (!isValidEmail(trimmedEmail)) {
      return res.status(400).json({
        success: false,
        error:   'Please enter a valid email address',
      });
    }

    const db = getDb();

    // ── Profile must exist to claim prize
    const profile = await getAliveProfile(deviceId);
    if (!profile) {
      return res.status(403).json({
        success:         false,
        error:           'profile_required',
        profileRequired: true,
        message:         'Set up your profile first.',
      });
    }

    const now = new Date().toISOString();

    // ── Email already submitted — don't overwrite unless force=true
    if (profile.claimEmail && !force) {
      return res.json({
        success:       true,
        alreadySaved:  true,
        email:         profile.claimEmail,
        message:       'Email already saved for prize claim.',
      });
    }

    // ── Save to aliveChecks profile
    const docRef     = db.collection('aliveChecks').doc(deviceId);
    const updateData = {
      'profile.claimEmail':          trimmedEmail,
      'profile.claimEmailUpdatedAt': now,
    };

    // Only set AddedAt on first save
    if (!profile.claimEmail) {
      updateData['profile.claimEmailAddedAt'] = now;
    }

    await docRef.update(updateData);

    console.log(`✅ Claim email saved: ${deviceId} → ${trimmedEmail}`);

    res.json({
      success:      true,
      alreadySaved: false,
      email:        trimmedEmail,
      message:      'Email saved! We\'ll contact you if you win a prize 🏆',
    });
  } catch (error) {
    console.error('Claim email error:', error);
    res.status(500).json({ success: false, error: 'Failed to save email' });
  }
});

module.exports = router;