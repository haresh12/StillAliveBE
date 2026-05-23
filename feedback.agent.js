'use strict';
// ════════════════════════════════════════════════════════════════
// FEEDBACK AGENT — Home-tab "send feedback" capture.
//
// Captures free-text feedback submitted from the Home tab's feedback
// sheet. Lands in Firestore `wellness_feedback` collection with full
// device context so the team can triage + reply later.
//
// Endpoint: POST /api/feedback/submit
//   Body: { deviceId, text, app_version?, locale?, screen? }
//   Returns: { ok: true, id }
//
// Stored shape (wellness_feedback/{auto-id}):
//   {
//     device_id, text, app_version, locale, screen,
//     created_at,         // server timestamp
//     status: 'new',      // 'new' | 'triaged' | 'replied' | 'closed'
//   }
//
// Privacy:
//   - device_id only (no IDFA, no email, no name)
//   - text is whatever the user typed — we trim + hard-cap to 2000 chars
//   - Nothing is sent to third parties; lives in Firestore until the team
//     manually exports / replies
// ════════════════════════════════════════════════════════════════

const express = require('express');
const router  = express.Router();
const admin   = require('firebase-admin');

const MAX_TEXT_LEN = 2000;
const MIN_TEXT_LEN = 2;   // Block accidental empty/single-char submits

router.post('/submit', async (req, res) => {
  try {
    const { deviceId, text, app_version, locale, screen } = req.body || {};

    if (!deviceId || typeof deviceId !== 'string' || deviceId.length < 6) {
      return res.status(400).json({ ok: false, error: 'deviceId_required' });
    }
    const cleanText = typeof text === 'string' ? text.trim() : '';
    if (cleanText.length < MIN_TEXT_LEN) {
      return res.status(400).json({ ok: false, error: 'text_too_short' });
    }

    const db = admin.firestore();
    const doc = await db.collection('wellness_feedback').add({
      device_id:   deviceId,
      text:        cleanText.slice(0, MAX_TEXT_LEN),
      app_version: typeof app_version === 'string' ? app_version.slice(0, 40) : '',
      locale:      typeof locale === 'string' ? locale.slice(0, 8) : '',
      screen:      typeof screen === 'string' ? screen.slice(0, 60) : 'home',
      status:      'new',
      created_at:  admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ ok: true, id: doc.id });
  } catch (e) {
    try { log.error('[feedback/submit]', e?.message || e); } catch {}
    return res.status(500).json({ ok: false, error: 'submit_failed' });
  }
});

module.exports = router;
