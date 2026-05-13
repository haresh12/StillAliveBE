'use strict';
// GET /api/wellness/v2/agent-scores/:deviceId
//
// Returns the EXACT score each agent's own Analysis tab shows.
// Read from per-agent docs, no recomputation — single source of truth.

const express = require('express');
const router = express.Router();
const { readAllAgentScores } = require('../../lib/agent-scores-bridge');

router.get('/agent-scores/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  try {
    const scores = await readAllAgentScores(deviceId);
    return res.json({ ok: true, scores });
  } catch (e) {
    log.error('[v2/agent-scores]', e);
    return res.status(500).json({ error: 'agent_scores_failed', message: String(e.message || e) });
  }
});

module.exports = router;
