/**
 * api/insights.routes.js
 *
 * THREE PATHS — chosen for sub-second response at 0-1000 MAU (no cron needed):
 *
 *   1. FRESH cache (<12h)   → return immediately (~50-150ms)
 *   2. STALE cache (≥12h)   → return stale + queue async LLM-polish refresh
 *   3. COLD (no cache)      → run DETERMINISTIC fast path (~500-700ms even
 *                              for users with months of data), return,
 *                              then fire `runForUserEnrich` async so the
 *                              user gets LLM-polished prose on their NEXT
 *                              open. User never waits for an LLM call.
 *
 * Net: every API hit returns under 1s, day-1 users included. Cron is
 * optional — the on-demand path keeps everyone's pack ≤12h fresh just
 * by them opening the app.
 */

const express = require('express');
const router = express.Router();

const { requireDeviceId, rateLimit, RATE } = require('./_middleware');
const { readInsightsPack, readCorrelations } = require('../persistence/insights-pack.repo');
const { runForUserSafe, runForUserFastSafe, runForUserEnrich } = require('../orchestrator/workflow');
const config = require('../config');

const STALE_HOURS = config.CACHE.INSIGHTS_PACK_STALE_THRESHOLD_HOURS;

router.get('/insights/:deviceId', requireDeviceId, rateLimit(RATE.INSIGHTS_GET_PER_MIN), async (req, res) => {
  try {
    // Strict range validation: only the 4 canonical periods (1W/1M/3M/1Y).
    // Invalid range = 400 instead of silent coercion (helps catch FE drift).
    if (req.query.range != null) {
      const n = parseInt(req.query.range, 10);
      if (!(n === 7 || n === 30 || n === 90 || n === 365)) {
        return res.status(400).json({
          error: 'invalid_range',
          message: 'range must be one of 7, 30, 90, 365',
          received: req.query.range,
        });
      }
    }
    const range = parseRange(req.query.range);
    let cached = await readInsightsPack(req.deviceId, range);
    const stale = cached
      ? cached.meta.stale_for_seconds > STALE_HOURS * 3600
      : true;

    // Path 1: fresh cache hit
    if (cached && !stale) {
      return res.json(cached);
    }

    // Path 2: stale — return immediately, refresh async with LLM polish
    if (cached && stale) {
      res.json(cached);
      runForUserSafe(req.deviceId).catch((err) =>
        console.error('[insights] async refresh failed:', err && err.message));
      return;
    }

    // Path 3: COLD — deterministic fast path keeps the user under 1s,
    // then fire LLM enrich in the background so prose lands by next open.
    const result = await runForUserFastSafe(req.deviceId);
    const fresh = result.insights_packs.find((ip) => ip.range === range);
    res.json(fresh && fresh.pack ? fresh.pack : (result.insights_packs[0] && result.insights_packs[0].pack) || {});

    // Async LLM upgrade — never blocks the response. enrichment_context is
    // populated by runForUserFast; runForUserEnrich is null-safe.
    if (result.enrichment_context) {
      runForUserEnrich(req.deviceId, result.enrichment_context).catch((err) =>
        console.error('[insights] async enrich failed:', err && err.message));
    }
  } catch (err) {
    console.error('[insights] error:', err);
    res.status(500).json({ error: 'insights_failed', message: err && err.message });
  }
});

router.get('/correlations/:deviceId/:correlationId', requireDeviceId, async (req, res) => {
  try {
    const all = await readCorrelations(req.deviceId);
    if (!all || !Array.isArray(all.results)) {
      return res.status(404).json({ error: 'no_correlations' });
    }
    const found = all.results.find((c) => c.id === req.params.correlationId);
    if (!found) return res.status(404).json({ error: 'correlation_not_found' });

    res.json({
      id: found.id,
      pair: found.pair,
      agents: found.agents,
      r: found.r,
      p: found.p,
      n: found.n,
      window_days: found.window_days,
      lag: found.lag,
      direction: found.direction,
      plain_english: found.plain_english,
      caveat: 'Correlation, not causation. More data tightens this estimate.',
      bh_significant: !!found.bh_significant,
      confidence_label: found.confidence_label,
      evidence: found.evidence,
    });
  } catch (err) {
    console.error('[correlations] error:', err);
    res.status(500).json({ error: 'correlation_failed' });
  }
});

function parseRange(v) {
  const n = parseInt(v, 10);
  if (n === 7 || n === 30 || n === 90 || n === 365) return n;
  return 30;
}

module.exports = router;
