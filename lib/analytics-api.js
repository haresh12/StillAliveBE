/**
 * analytics-api.js — internal endpoint for backend-emitted events.
 *
 * Used by:
 *   • Nightly crons (e.g. churn-risk-updated)
 *   • One-off backfills
 *
 * Mounted at: /api/analytics
 *
 * Trust model: requires `x-internal-token` header matching INTERNAL_API_TOKEN.
 * Never expose this to the public — internal call only.
 */
'use strict';

const express = require('express');
const router = express.Router();
const mp = require('./mixpanel');

const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN || '';

router.use((req, res, next) => {
  if (!INTERNAL_TOKEN) {
    return res.status(503).json({ error: 'analytics_api_disabled' });
  }
  if (req.headers['x-internal-token'] !== INTERNAL_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

router.post('/event', async (req, res) => {
  const { event, distinct_id: distinctId, properties } = req.body || {};
  if (!event || !distinctId) {
    return res.status(400).json({ error: 'event_and_distinct_id_required' });
  }
  const ok = await mp.track(event, distinctId, properties || {});
  res.json({ ok });
});

router.post('/people/set', async (req, res) => {
  const { distinct_id: distinctId, properties } = req.body || {};
  if (!distinctId) return res.status(400).json({ error: 'distinct_id_required' });
  const ok = await mp.peopleSet(distinctId, properties || {});
  res.json({ ok });
});

router.post('/gdpr/delete', async (req, res) => {
  const { distinct_id: distinctId } = req.body || {};
  if (!distinctId) return res.status(400).json({ error: 'distinct_id_required' });
  const ok = await mp.gdprDelete(distinctId);
  res.json({ ok });
});

module.exports = router;
