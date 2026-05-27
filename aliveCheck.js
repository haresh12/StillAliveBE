// ════════════════════════════════════════════════════════════════════
// aliveCheck.js — user profile endpoint (legacy filename).
//
// HISTORICAL: this file used to host the entire "Alive Check" feature
// (pillar scoring, daily check-ins, viral quotes, leaderboard, private
// circles, deep AI analysis, analytics — ~3,200 LOC of LLM-driven
// wellness scoring). All of that was deprecated during the Wellness OS
// rebrand (2026-05-27) — replaced by the 6 dedicated agents
// (Fitness/Nutrition/Mind/Sleep/Water/Fasting) plus the cross-agent
// engine. The only surviving consumer was /profile.
//
// CURRENT: this file only exposes /profile (GET + POST). The file name
// + mount path (/api/alive-check/profile) + Firestore collection
// (`aliveChecks`) are intentionally kept to avoid a destructive rename
// pre-launch — UserContext, SettingsScreen, LanguageSheet, referrals.js,
// server.js code-uniqueness checks, and lib/i18n-prompt.js's cron-side
// resolveUserLanguage() all read from this collection.
//
// If/when we rename, the migration must dual-write to the new collection
// for a full week before flipping reads, then backfill old docs. Not a
// pre-launch task.
// ════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

const getDb = () => admin.firestore();

// ════════════════════════════════════════════════════════════════════
// LANGUAGE NAME (for success message — keeps prior FE-facing string
// shape so the toast text in SettingsScreen doesn't visibly regress)
// ════════════════════════════════════════════════════════════════════
function getLanguageName(code) {
  const languages = {
    en: 'English', es: 'Spanish', ru: 'Russian',
    pt: 'Portuguese', fr: 'French', de: 'German',
  };
  return languages[code] || 'English';
}

// ════════════════════════════════════════════════════════════════════
// 6-CHARACTER REFERRAL CODE — used by referrals.js + Settings code copy
// (chars exclude I/O/0/1 to avoid look-alikes in shared codes)
// ════════════════════════════════════════════════════════════════════
function generateUniqueCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

async function ensureCodeExists(deviceId) {
  try {
    const db = getDb();

    // Reuse an existing code on wellness_users first — that doc is the
    // canonical source for the rest of the app.
    const userDoc = await db.collection('wellness_users').doc(deviceId).get();
    if (userDoc.exists && userDoc.data().code) return userDoc.data().code;

    // Generate a unique 6-char code; retry up to 10 collisions across
    // both collections (vanishingly rare with 32^6 = 1B keyspace).
    let code = generateUniqueCode();
    let attempts = 0;
    while (attempts < 10) {
      const [aliveCheckQuery, userQuery] = await Promise.all([
        db.collection('aliveChecks').where('profile.code', '==', code).limit(1).get(),
        db.collection('wellness_users').where('code', '==', code).limit(1).get(),
      ]);
      if (aliveCheckQuery.empty && userQuery.empty) break;
      code = generateUniqueCode();
      attempts++;
    }

    // Mirror onto wellness_users when that doc already exists — keeps the
    // two collections in lockstep without forcing a new doc.
    if (userDoc.exists) {
      await db.collection('wellness_users').doc(deviceId).update({ code });
    }
    return code;
  } catch (error) {
    log.error('Code generation error:', error);
    return generateUniqueCode(); // best-effort fallback
  }
}

// ════════════════════════════════════════════════════════════════════
// MIDDLEWARE
// ════════════════════════════════════════════════════════════════════
const requireDeviceId = (req, res, next) => {
  const deviceId = req.body?.deviceId || req.query?.deviceId;
  if (!deviceId) return res.status(400).json({ success: false, error: 'Device ID required' });
  req.deviceId = deviceId;
  next();
};

// ════════════════════════════════════════════════════════════════════
// POST /profile — upsert user profile.
//
// On EXISTING doc: partial update (only fields present in body). Returns
// a humanized success message — special-cased for `language` so the
// LanguageSheet toast confirms which language was set.
//
// On NEW doc: validates required fields (name, gender, ageGroup),
// auto-generates a 6-char code, and writes a complete profile shell.
// Cross-syncs the code to wellness_users so the rest of the app can
// reference one canonical code per device.
// ════════════════════════════════════════════════════════════════════
router.post('/profile', requireDeviceId, async (req, res) => {
  try {
    const { deviceId } = req;
    const { name, ageGroup, gender, language, leaderboardConsent, pillarBaselines, vision, goalTimeline } = req.body;

    const docRef = getDb().collection('aliveChecks').doc(deviceId);
    const doc = await docRef.get();

    if (doc.exists) {
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

      return res.json({
        success: true,
        profile: updatedProfile,
        message: language
          ? `Language updated to ${getLanguageName(language)} successfully`
          : `Welcome back, ${updatedProfile.name}!`,
      });
    }

    // NEW PROFILE
    if (!name || !name.trim()) return res.status(400).json({ success: false, error: 'Name is required' });
    if (!gender || !['male', 'female', 'other', 'prefernottosay'].includes(gender)) {
      return res.status(400).json({ success: false, error: 'Valid gender is required' });
    }
    if (!ageGroup) return res.status(400).json({ success: false, error: 'Age group is required' });

    const code = await ensureCodeExists(deviceId);

    // Sync the new code to wellness_users (the canonical user doc) when it
    // already exists — keeps the two collections aligned. Non-fatal on error.
    try {
      const userRef = getDb().collection('wellness_users').doc(deviceId);
      const userDoc = await userRef.get();
      if (userDoc.exists && !userDoc.data().code) {
        await userRef.update({
          code,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    } catch (syncError) {
      log.error('⚠️ Code sync to wellness_users failed (non-critical):', syncError.message);
    }

    const profile = {
      name: name.trim(),
      ageGroup,
      gender,
      language: language || 'en',
      code,
      leaderboardConsent: typeof leaderboardConsent === 'boolean' ? leaderboardConsent : true,
      ...(pillarBaselines && typeof pillarBaselines === 'object' ? { pillarBaselines } : {}),
      ...(vision ? { vision: vision.trim() } : {}),
      ...(goalTimeline ? { goalTimeline } : {}),
      profileCompleted: true,
      profileCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await docRef.set({
      deviceId,
      profile,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Read-after-write sanity: tiny pause lets Firestore propagate before
    // we re-read so the FE never receives a "saved but not yet visible"
    // response that breaks the welcome flow.
    await new Promise(resolve => setTimeout(resolve, 1000));
    const savedDoc = await docRef.get();
    if (!savedDoc.exists) {
      log.error('❌ Profile save failed — document not found after write');
      throw new Error('Profile save failed — please try again');
    }
    const savedProfile = savedDoc.data().profile;

    return res.json({
      success: true,
      profile: savedProfile,
      message: `Welcome, ${savedProfile.name}! Your personalized wellness journey starts now. 🚀`,
    });
  } catch (error) {
    log.error('Save profile error:', error);
    res.status(500).json({ success: false, error: 'Failed to save profile' });
  }
});

// ════════════════════════════════════════════════════════════════════
// GET /profile — read profile. Returns { profile: null, hasProfile: false }
// when the doc doesn't exist (first-time users) instead of 404, so the
// FE flow is one code path. Auto-heals two legacy gaps:
//   - missing `code` → generate + persist
//   - missing `leaderboardConsent` → default true + persist
// ════════════════════════════════════════════════════════════════════
router.get('/profile', requireDeviceId, async (req, res) => {
  try {
    const { deviceId } = req;
    const doc = await getDb().collection('aliveChecks').doc(deviceId).get();

    if (!doc.exists) {
      return res.json({ success: true, profile: null, hasProfile: false });
    }

    const data = doc.data();
    let profile = data.profile || null;

    if (profile && !profile.code) {
      const code = await ensureCodeExists(deviceId);
      await doc.ref.update({ 'profile.code': code });
      profile.code = code;
    }

    if (profile && profile.leaderboardConsent === undefined) {
      await doc.ref.update({ 'profile.leaderboardConsent': true });
      profile.leaderboardConsent = true;
    }

    return res.json({
      success: true,
      profile,
      hasProfile: !!profile?.profileCompleted,
    });
  } catch (error) {
    log.error('Get profile error:', error);
    res.status(500).json({ success: false, error: 'Failed to get profile' });
  }
});

module.exports = router;
