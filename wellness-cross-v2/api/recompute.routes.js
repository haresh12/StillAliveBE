/**
 * api/recompute.routes.js
 */

const express = require('express');
const router = express.Router();

const { requireDeviceId, rateLimit, RATE } = require('./_middleware');
const { runForUserSafe } = require('../orchestrator/workflow');
const { resolveLanguage } = require('../../lib/i18n-prompt');

router.post('/recompute/:deviceId', requireDeviceId, rateLimit(RATE.RECOMPUTE_PER_MIN), async (req, res) => {
  try {
    const reason = (req.body && req.body.reason) || 'manual';
    const language = resolveLanguage(req);
    const result = await runForUserSafe(req.deviceId, { language });
    res.json({
      ok: true,
      home_pack: result.home_pack,
      telemetry: result.telemetry,
    });
  } catch (err) {
    log.error('[recompute] error:', err);
    res.status(500).json({ error: 'recompute_failed', message: err && err.message });
  }
});

module.exports = router;
