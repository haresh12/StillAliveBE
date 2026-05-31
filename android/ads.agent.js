'use strict';

// ═══════════════════════════════════════════════════════════════
// ads.agent.js — AdMob Server-Side Verification (SSV) callback.
// Mounted at /api/android/ads in server.js.
//
// Routes:
//   GET  /rewarded-callback?...   Google calls this with ed25519-signed payload
//                                 We verify, idempotency-check, then credit coins.
//
// Configure in AdMob Console:
//   Per rewarded ad unit → Settings → Server-side verification
//     callback URL = https://wellness-os-api.fly.dev/api/android/ads/rewarded-callback
//
// `user_id` field in the SSV URL = our device_id (set client-side via
// setSSVOptions on the RewardedAd before show()).
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();

const { verifySsv, recordEventIfNew } = require('./lib/adVerifier');
const { earn } = require('./lib/coinLedger');
const { recordEarnForVelocity, applySoftLock } = require('./lib/antiAbuse');
const { EARN_SOURCES } = require('./lib/coinRates');
const { AD_UNIT_IDS_KNOWN } = (() => {
  // Map ad-unit IDs to earn sources. Cross-checked vs StillAlive/src/android/ads/adUnitIds.ts.
  const PROD_REWARDED       = 'ca-app-pub-2489550221470309/7607075580';
  const PROD_REWARDED_INT   = 'ca-app-pub-2489550221470309/4977042812';
  // Google test IDs (used in __DEV__ on client; SSV still hits this in QA)
  const TEST_REWARDED       = 'ca-app-pub-3940256099942544/5224354917';
  const TEST_REWARDED_INT   = 'ca-app-pub-3940256099942544/5354046379';
  return {
    AD_UNIT_IDS_KNOWN: {
      [PROD_REWARDED]:     EARN_SOURCES.REWARDED_VIDEO_WATCHED,
      [PROD_REWARDED_INT]: EARN_SOURCES.REWARDED_INT_WATCHED,
      [TEST_REWARDED]:     EARN_SOURCES.REWARDED_VIDEO_WATCHED,
      [TEST_REWARDED_INT]: EARN_SOURCES.REWARDED_INT_WATCHED,
    },
  };
})();

router.get('/rewarded-callback', async (req, res) => {
  // Reconstruct the full query string EXACTLY as Google sent it.
  // Express's req.url includes the path + ?query, we want everything after `?`.
  const qIdx = req.originalUrl.indexOf('?');
  if (qIdx < 0) return res.status(400).send('no_query');
  const fullQuery = req.originalUrl.slice(qIdx + 1);

  // 1. Verify ed25519 signature
  const v = await verifySsv(fullQuery);
  if (!v.ok) {
    console.warn('[ads.ssv] verification failed:', v.reason);
    return res.status(403).send(v.reason);
  }

  const { eventId, rewardAmount, rewardItem, userId, adUnitId } = v;

  // 2. user_id must be present (we set it client-side as deviceId)
  if (!userId) {
    return res.status(400).send('no_user_id');
  }

  // 3. Idempotency — first seen?
  const isNew = await recordEventIfNew({
    eventId,
    deviceId: userId,
    adUnitId,
    rewardAmount,
  });
  if (!isNew) {
    // Replay attempt — silently accept (200) so Google doesn't retry forever.
    return res.status(200).send('replay');
  }

  // 4. Determine earn source from ad unit
  const source = AD_UNIT_IDS_KNOWN[adUnitId];
  if (!source) {
    // Unknown ad unit — possible misconfiguration. Don't credit, but ack so
    // Google stops retrying.
    console.warn('[ads.ssv] unknown ad_unit_id:', adUnitId);
    return res.status(200).send('unknown_ad_unit');
  }

  // 5. Credit coins (atomic via coinLedger; respects cooldown + daily caps).
  // Use eventId as txn ID for perfect idempotency at the ledger layer too.
  const result = await earn({
    deviceId: userId,
    source,
    meta: { ad_unit: adUnitId, ssv_event_id: eventId, reward_item: rewardItem },
    explicitTxnId: `ssv_${eventId}`,
  });

  if (!result.ok) {
    // Capped or rate-limited — ack but don't credit (Google retried, or
    // user already hit daily cap).
    console.warn('[ads.ssv] earn refused:', result.reason);
    return res.status(200).send(result.reason);
  }

  // 6. Velocity check — may trigger soft-lock
  await recordEarnForVelocity({ deviceId: userId, amount: result.amount });

  return res.status(200).send('ok');
});

// Health probe (for monitoring)
router.get('/_health', (req, res) => res.json({ ok: true, service: 'android-ads-ssv' }));

module.exports = router;
