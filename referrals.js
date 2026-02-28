// ============================================
// 🏆 PULSE — REFERRAL SYSTEM
// v5.0 — Clean pass-through, no transformation
// ============================================
// ✅ endDate/startDate passed directly to FE
// ✅ JSON is source of truth — no stripping
// ✅ Name always from aliveChecks profile
// ✅ Email collected only when user is in top 3
// ✅ Contest config: raw JSON + computed isActive
// ✅ Multilingual rules/legal via language param
// ✅ Apple compliance
// ============================================

const express = require('express');
const router  = express.Router();
const admin   = require('firebase-admin');
const fs      = require('fs');
const path    = require('path');

const getDb = () => admin.firestore();

// ============================================
// CONFIG LOADER
// ============================================
let CONTEST_CONFIG = null;

const loadContestConfig = () => {
  if (!CONTEST_CONFIG) {
    const configPath = path.join(__dirname, 'referral-contest.json');
    CONTEST_CONFIG = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log('✅ Contest config loaded:', configPath);
  }
  return CONTEST_CONFIG;
};

const isContestActive = (config) => {
  if (!config.enabled) return false;
  const now = new Date();
  return now >= new Date(config.startDate) && now <= new Date(config.endDate);
};

// ============================================
// HELPERS
// ============================================

const getCurrentMonth = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

const getMonthLabel = (monthStr, language = 'en') => {
  const [year, month] = monthStr.split('-');
  const date = new Date(parseInt(year), parseInt(month) - 1, 1);
  const locales = { en: 'en-US', ru: 'ru-RU', es: 'es-ES', pt: 'pt-BR', fr: 'fr-FR', de: 'de-DE' };
  return date.toLocaleString(locales[language] || 'en-US', { month: 'long', year: 'numeric' });
};

const isValidEmail = (email) => {
  if (!email || typeof email !== 'string') return false;
  const trimmed = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) && trimmed.length <= 254;
};

const getUserDisplayName = async (deviceId) => {
  const db = getDb();
  try {
    const aliveDoc = await db.collection('aliveChecks').doc(deviceId).get();
    if (aliveDoc.exists && aliveDoc.data().profile?.name) return aliveDoc.data().profile.name;
    const userDoc = await db.collection('users').doc(deviceId).get();
    if (userDoc.exists && userDoc.data().displayName && userDoc.data().displayName !== 'User') return userDoc.data().displayName;
    return null;
  } catch { return null; }
};

const getUserCode = async (deviceId) => {
  const db = getDb();
  try {
    const aliveDoc = await db.collection('aliveChecks').doc(deviceId).get();
    if (aliveDoc.exists && aliveDoc.data().profile?.code) return aliveDoc.data().profile.code;
    const userDoc = await db.collection('users').doc(deviceId).get();
    if (userDoc.exists && userDoc.data().code) return userDoc.data().code;
    return null;
  } catch { return null; }
};

const getAliveProfile = async (deviceId) => {
  const db = getDb();
  try {
    const doc = await db.collection('aliveChecks').doc(deviceId).get();
    if (doc.exists && doc.data().profile?.profileCompleted) return doc.data().profile;
    return null;
  } catch { return null; }
};

const aggregateCounts = (snapshot) => {
  const counts = {};
  snapshot.forEach(doc => {
    const { referrerDeviceId, referrerCode } = doc.data();
    if (!counts[referrerDeviceId]) counts[referrerDeviceId] = { count: 0, code: referrerCode };
    counts[referrerDeviceId].count++;
  });
  return counts;
};

// ============================================
// MIDDLEWARE
// ============================================

const requireDeviceId = (req, res, next) => {
  const deviceId = req.body?.deviceId || req.query?.deviceId;
  if (!deviceId) return res.status(400).json({ success: false, error: 'Device ID required' });
  req.deviceId = deviceId;
  next();
};

// ============================================
// GET /contest-config
// ─────────────────────────────────────────────
// Sends JSON almost as-is. FE gets:
//   - startDate, endDate (raw ISO — FE computes days left)
//   - isActive (computed here)
//   - rules/legal for requested language
//   - everything else from JSON directly
// ============================================
router.get('/contest-config', async (req, res) => {
  try {
    const { language = 'en' } = req.query;
    const config = loadContestConfig();
    const supportedLangs = ['en', 'ru', 'es', 'pt', 'fr', 'de'];
    const lang = supportedLangs.includes(language) ? language : 'en';

    res.set('Cache-Control', 'public, max-age=3600');

    res.json({
      success: true,
      config: {
        enabled:       config.enabled,
        isActive:      isContestActive(config),
        startDate:     config.startDate,   // ✅ raw ISO — FE uses this
        endDate:       config.endDate,     // ✅ raw ISO — FE uses this
        prizePool:     config.prizePool,
        prizes:        config.prizes,
        maxParticipants: config.maxParticipants,
        rules:         config.rules[lang]  || config.rules.en,
        legal:         config.legal[lang]  || config.legal.en,
      },
    });
  } catch (error) {
    console.error('Contest config error:', error);
    res.status(500).json({ success: false, error: 'Failed to load contest config' });
  }
});

// ============================================
// GET /profile-status
// ============================================
router.get('/profile-status', requireDeviceId, async (req, res) => {
  try {
    const { deviceId } = req;
    const profile = await getAliveProfile(deviceId);
    const code    = profile?.code || await getUserCode(deviceId);

    res.json({
      success:    true,
      hasProfile: !!profile,
      profile: profile ? { name: profile.name, code } : null,
    });
  } catch (error) {
    console.error('Profile status error:', error);
    res.status(500).json({ success: false, error: 'Failed to check profile status' });
  }
});

// ============================================
// POST /validate-code
// ============================================
router.post('/validate-code', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code || typeof code !== 'string' || !code.trim()) return res.status(400).json({ success: false, error: 'Code is required' });

    const trimmedCode = code.trim().toUpperCase();
    if (trimmedCode.length !== 6) return res.status(400).json({ success: false, error: 'Code must be 6 characters' });

    const db = getDb();
    const [usersQuery, aliveQuery] = await Promise.all([
      db.collection('users').where('code', '==', trimmedCode).limit(1).get(),
      db.collection('aliveChecks').where('profile.code', '==', trimmedCode).limit(1).get(),
    ]);

    if (usersQuery.empty && aliveQuery.empty) return res.json({ success: true, valid: false });

    let referrerName = 'a friend';
    let referrerDeviceId = null;

    if (!aliveQuery.empty) {
      referrerDeviceId = aliveQuery.docs[0].id;
      referrerName     = aliveQuery.docs[0].data().profile?.name || 'a friend';
    } else {
      referrerDeviceId = usersQuery.docs[0].id;
      referrerName     = await getUserDisplayName(referrerDeviceId) || usersQuery.docs[0].data().displayName || 'a friend';
    }

    return res.json({ success: true, valid: true, referrerName });
  } catch (error) {
    console.error('Validate code error:', error);
    res.status(500).json({ success: false, error: 'Failed to validate code' });
  }
});

// ============================================
// POST /track
// ============================================
router.post('/track', requireDeviceId, async (req, res) => {
  try {
    const { deviceId }     = req;
    const { referralCode } = req.body;

    if (!referralCode || typeof referralCode !== 'string' || !referralCode.trim()) return res.status(400).json({ success: false, error: 'Referral code is required' });

    const trimmedCode = referralCode.trim().toUpperCase();
    if (trimmedCode.length !== 6) return res.status(400).json({ success: false, error: 'Code must be 6 characters' });

    const db = getDb();

    const existing = await db.collection('referrals').where('newUserDeviceId', '==', deviceId).limit(1).get();
    if (!existing.empty) return res.status(400).json({ success: false, error: 'Referral already recorded for this device' });

    const [usersQuery, aliveQuery] = await Promise.all([
      db.collection('users').where('code', '==', trimmedCode).limit(1).get(),
      db.collection('aliveChecks').where('profile.code', '==', trimmedCode).limit(1).get(),
    ]);

    if (usersQuery.empty && aliveQuery.empty) return res.status(404).json({ success: false, error: 'Invalid referral code' });

    let referrerDeviceId = !aliveQuery.empty ? aliveQuery.docs[0].id : usersQuery.docs[0].id;

    if (referrerDeviceId === deviceId) return res.status(400).json({ success: false, error: 'You cannot use your own referral code' });

    const currentMonth = getCurrentMonth();
    await db.collection('referrals').add({
      referrerDeviceId,
      referrerCode:    trimmedCode,
      newUserDeviceId: deviceId,
      month:           currentMonth,
      createdAt:       admin.firestore.FieldValue.serverTimestamp(),
      createdAtISO:    new Date().toISOString(),
    });

    console.log(`✅ Referral: ${referrerDeviceId} → ${deviceId} [${currentMonth}]`);
    res.json({ success: true, message: 'Referral recorded!' });
  } catch (error) {
    console.error('Track referral error:', error);
    res.status(500).json({ success: false, error: 'Failed to track referral' });
  }
});

// ============================================
// GET /my-stats
// ============================================
router.get('/my-stats', requireDeviceId, async (req, res) => {
  try {
    const { deviceId } = req;
    const { month }    = req.query;
    const targetMonth  = month || getCurrentMonth();
    const db           = getDb();

    const config             = loadContestConfig();
    const PRIZES             = config.prizes;
    const TOP_WINNERS        = Object.keys(PRIZES).length;

    const profile = await getAliveProfile(deviceId);
    const myName  = profile?.name || await getUserDisplayName(deviceId) || null;
    const myCode  = profile?.code || await getUserCode(deviceId);

    const [myReferralsSnap, allReferralsSnap, allTimeSnap] = await Promise.all([
      db.collection('referrals').where('referrerDeviceId', '==', deviceId).where('month', '==', targetMonth).get(),
      db.collection('referrals').where('month', '==', targetMonth).get(),
      db.collection('referrals').where('referrerDeviceId', '==', deviceId).get(),
    ]);

    const myCount  = myReferralsSnap.size;
    const counts   = aggregateCounts(allReferralsSnap);
    const sorted   = Object.entries(counts).sort((a, b) => b[1].count - a[1].count);
    const myRankIdx = sorted.findIndex(([id]) => id === deviceId);
    const myRank   = myRankIdx >= 0 ? myRankIdx + 1 : null;

    const isInTop3    = myRank !== null && myRank <= TOP_WINNERS && myCount > 0;
    const claimEmail  = profile?.claimEmail || null;

    res.json({
      success: true,
      stats: {
        name:             myName,
        code:             myCode,
        monthlyReferrals: myCount,
        allTimeReferrals: allTimeSnap.size,
        rank:             myCount > 0 ? myRank : null,
        isInTop3,
        claimEmail,
        emailSubmitted:   !!claimEmail,
      },
    });
  } catch (error) {
    console.error('My stats error:', error);
    res.status(500).json({ success: false, error: 'Failed to get stats' });
  }
});

// ============================================
// GET /leaderboard
// ============================================
router.get('/leaderboard', async (req, res) => {
  try {
    const { month, language = 'en' } = req.query;
    const targetMonth = month || getCurrentMonth();
    const db          = getDb();

    const config   = loadContestConfig();
    const PRIZES   = config.prizes;
    const TOP_WINNERS = Object.keys(PRIZES).length;

    const referralsSnap = await db.collection('referrals').where('month', '==', targetMonth).get();

    if (referralsSnap.empty) {
      return res.json({
        success:     true,
        leaderboard: [],
        month:       targetMonth,
        monthLabel:  getMonthLabel(targetMonth, language),
      });
    }

    const counts = aggregateCounts(referralsSnap);
    const sorted = Object.entries(counts)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10);

    const leaderboardRaw = await Promise.all(
      sorted.map(async ([deviceId, data], index) => {
        const rank    = index + 1;
        const profile = await getAliveProfile(deviceId);
        const name    = profile?.name || await getUserDisplayName(deviceId);
        return { rank, name: name || null, referrals: data.count, code: data.code };
      })
    );

    // Only show named users, re-rank
    const leaderboard = leaderboardRaw
      .filter(e => e.name !== null)
      .map((e, i) => ({ ...e, rank: i + 1 }));

    res.json({
      success:     true,
      leaderboard,
      month:       targetMonth,
      monthLabel:  getMonthLabel(targetMonth, language),
    });
  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({ success: false, error: 'Failed to get leaderboard' });
  }
});

// ============================================
// GET /my-code
// ============================================
router.get('/my-code', requireDeviceId, async (req, res) => {
  try {
    const { deviceId } = req;
    const profile = await getAliveProfile(deviceId);
    if (!profile) return res.status(403).json({ success: false, error: 'profile_required' });

    const code = profile.code || await getUserCode(deviceId);
    if (!code) return res.status(404).json({ success: false, error: 'No referral code found' });

    res.json({ success: true, code, name: profile.name });
  } catch (error) {
    console.error('My code error:', error);
    res.status(500).json({ success: false, error: 'Failed to get code' });
  }
});

// ============================================
// PATCH /claim-email
// ============================================
router.patch('/claim-email', requireDeviceId, async (req, res) => {
  try {
    const { deviceId }     = req;
    const { email, force } = req.body;

    if (!email) return res.status(400).json({ success: false, error: 'Email is required' });

    const trimmedEmail = email.trim().toLowerCase();
    if (!isValidEmail(trimmedEmail)) return res.status(400).json({ success: false, error: 'Please enter a valid email address' });

    const db      = getDb();
    const profile = await getAliveProfile(deviceId);
    if (!profile) return res.status(403).json({ success: false, error: 'profile_required' });

    if (profile.claimEmail && !force) {
      return res.json({ success: true, alreadySaved: true, email: profile.claimEmail });
    }

    const now        = new Date().toISOString();
    const updateData = { 'profile.claimEmail': trimmedEmail, 'profile.claimEmailUpdatedAt': now };
    if (!profile.claimEmail) updateData['profile.claimEmailAddedAt'] = now;

    await db.collection('aliveChecks').doc(deviceId).update(updateData);
    console.log(`✅ Claim email: ${deviceId} → ${trimmedEmail}`);

    res.json({ success: true, alreadySaved: false, email: trimmedEmail });
  } catch (error) {
    console.error('Claim email error:', error);
    res.status(500).json({ success: false, error: 'Failed to save email' });
  }
});

module.exports = router;