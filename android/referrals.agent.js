'use strict';

// ═══════════════════════════════════════════════════════════════
// referrals.agent.js — Android referral API.
// Mounted at /api/android/referrals in server.js.
//
// Routes:
//   GET  /code?deviceId=...                        → fetch or create code
//   POST /redeem        { refereeDeviceId, code }  → redeem during onboarding
//   POST /share         { deviceId, channel }      → analytics ping
//   POST /first-log     { deviceId }               → mark first log (cron trigger)
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();

const {
  getOrCreateCode,
  redeemCode,
  markRefereeFirstLog,
} = require('./lib/referralEngine');
const { isSoftLocked } = require('./lib/antiAbuse');

router.get('/code', async (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ ok: false, reason: 'INVALID_INPUT' });
  try {
    const data = await getOrCreateCode(deviceId);
    return res.json({ ok: true, ...data });
  } catch (err) {
    return res.status(500).json({ ok: false, reason: 'CODE_GEN_FAILED', error: err.message });
  }
});

router.post('/redeem', async (req, res) => {
  const { refereeDeviceId, code } = req.body || {};
  if (!refereeDeviceId || !code) {
    return res.status(400).json({ ok: false, reason: 'INVALID_INPUT' });
  }

  const lock = await isSoftLocked(refereeDeviceId);
  if (lock.locked) {
    return res.status(403).json({ ok: false, reason: 'SOFT_LOCKED' });
  }

  const result = await redeemCode({ refereeDeviceId, code });
  return res.json(result);
});

router.post('/share', async (req, res) => {
  // Pure analytics ping — bumps share_count.
  // Server doesn't need to gate this; client also fires Mixpanel.
  const { deviceId } = req.body || {};
  if (!deviceId) return res.status(400).json({ ok: false, reason: 'INVALID_INPUT' });
  try {
    const admin = require('firebase-admin');
    const ref = admin.firestore()
      .collection('wellness_users').doc(deviceId)
      .collection('referral').doc('code');
    await ref.set(
      { share_count: admin.firestore.FieldValue.increment(1) },
      { merge: true },
    );
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/first-log', async (req, res) => {
  // Backend cron / explicit trigger after referee logs first activity.
  const { deviceId } = req.body || {};
  if (!deviceId) return res.status(400).json({ ok: false, reason: 'INVALID_INPUT' });
  const result = await markRefereeFirstLog(deviceId);
  return res.json(result);
});

module.exports = router;
