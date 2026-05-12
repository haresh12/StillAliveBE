/**
 * api/home.routes.js
 *
 * Speed contract: user sees data < 2s.
 * Strategy:
 *   - Cache hit (fresh): serve cached pack instantly (~150ms).
 *   - Cache hit (stale): serve cached pack instantly + fire async refresh.
 *   - Cache miss: runForUserFastSafe (deterministic only, ~500ms-1s) + fire LLM enrichment async.
 *
 * Never wait for the LLM in the read path.
 */

const express = require('express');
const router = express.Router();

const { requireDeviceId, rateLimit, RATE } = require('./_middleware');
const { readHomePack } = require('../persistence/home-pack.repo');
const { runForUserFastSafe, runForUserEnrich, runForUserSafe } = require('../orchestrator/workflow');
const { resolveLanguage } = require('../../lib/i18n-prompt');
const config = require('../config');

const STALE_HOURS = config.CACHE.HOME_PACK_STALE_THRESHOLD_HOURS;

// Fire-and-forget background refresh — never await.
function backgroundRefresh(deviceId, language) {
  setImmediate(() => {
    runForUserSafe(deviceId, { language }).catch((err) =>
      log.warn(`[home] background refresh ${deviceId} failed:`, err && err.message),
    );
  });
}

// Fire-and-forget LLM enrichment after a fast path returns.
function backgroundEnrich(deviceId, ctx, language) {
  if (!ctx) return;
  setImmediate(() => {
    runForUserEnrich(deviceId, ctx, { language }).catch((err) =>
      log.warn(`[home] background enrich ${deviceId} failed:`, err && err.message),
    );
  });
}

router.get('/home/:deviceId', requireDeviceId, rateLimit(RATE.HOME_GET_PER_MIN), async (req, res) => {
  try {
    const language = resolveLanguage(req);
    const cached = await readHomePack(req.deviceId).catch(() => null);

    // Cache key is just the deviceId today, but cached content was generated
    // in some prior language. If it doesn't match the user's CURRENT language,
    // treat as stale so the background refresh re-generates copy in the new lang.
    const cachedLang = (cached && cached._lang) || (cached && cached.meta && cached.meta._lang) || 'en';
    const langChanged = cached && cachedLang !== language;
    const stale = cached
      ? (cached.meta.stale_for_seconds > STALE_HOURS * 3600) || langChanged
      : true;

    // 1. Fresh cache (and same language): serve instantly.
    if (cached && !stale) {
      return res.json(cached);
    }

    // 2. Stale cache: serve immediately, refresh in background.
    if (cached && stale) {
      res.json(cached);
      backgroundRefresh(req.deviceId, language);
      return;
    }

    // 3. Cold miss: deterministic fast path (<1s), then background LLM enrichment.
    const result = await runForUserFastSafe(req.deviceId, { language });
    res.json(result.home_pack);
    backgroundEnrich(req.deviceId, result.enrichment_context, language);
  } catch (err) {
    log.error('[home] uncaught error:', err && err.stack ? err.stack : err);
    res.status(500).json({
      error: 'home_failed',
      message: err && err.message,
    });
  }
});

module.exports = router;
