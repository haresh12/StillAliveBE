/**
 * api/recompute.routes.js
 */

const express = require('express');
const router = express.Router();

const { requireDeviceId, rateLimit, RATE } = require('./_middleware');
const { runForUserSafe } = require('../orchestrator/workflow');

router.post('/recompute/:deviceId', requireDeviceId, rateLimit(RATE.RECOMPUTE_PER_MIN), async (req, res) => {
  try {
    const reason = (req.body && req.body.reason) || 'manual';
    console.log(`[recompute] deviceId=${req.deviceId} reason=${reason}`);
    const result = await runForUserSafe(req.deviceId);
    res.json({
      ok: true,
      home_pack: result.home_pack,
      telemetry: result.telemetry,
    });
  } catch (err) {
    console.error('[recompute] error:', err);
    res.status(500).json({ error: 'recompute_failed', message: err && err.message });
  }
});

module.exports = router;
