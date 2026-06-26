/**
 * CheckWriter support inbox — a single write-only endpoint.
 *
 * CheckWriter is a separate, fully on-device app with NO backend of its own. It
 * reuses this backend for exactly ONE thing: letting a user send a bug report or
 * feature request from inside the app. Tickets land in the `checkwriter_support`
 * Firestore collection so the founder can read + reply.
 *
 * Deliberately isolated from every wellness route: no auth, no reads, no cross
 * traffic. It only ever CREATES a support document. Admin credentials stay here
 * on the server — the client never sees a Firebase key.
 */
const express = require('express');
const admin = require('firebase-admin');

const router = express.Router();

const KINDS = ['bug', 'feature', 'question'];
const PLATFORMS = ['ios', 'android'];

router.post('/', async (req, res) => {
  try {
    const {message, kind, appVersion, platform, deviceId} = req.body || {};
    const text = String(message || '').trim();
    if (text.length < 3) {
      return res.status(400).json({ok: false, error: 'Message is too short.'});
    }
    await admin
      .firestore()
      .collection('checkwriter_support')
      .add({
        message: text.slice(0, 4000),
        kind: KINDS.includes(kind) ? kind : 'question',
        appVersion: String(appVersion || '').slice(0, 20),
        platform: PLATFORMS.includes(platform) ? platform : 'unknown',
        deviceId: String(deviceId || '').slice(0, 80),
        status: 'open',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    return res.json({ok: true});
  } catch (err) {
    console.error('[checkwriter-support] failed to save ticket', err);
    return res
      .status(500)
      .json({ok: false, error: 'Could not submit. Please try again.'});
  }
});

module.exports = router;
