'use strict';

// ═══════════════════════════════════════════════════════════════
// coins.agent.js — Android coin ledger API.
// Mounted at /api/android/coins in server.js.
//
// Routes:
//   POST /earn      { deviceId, source, meta? }           → credit coins
//   POST /spend     { deviceId, featureId, intentId? }    → debit coins
//   GET  /balance?deviceId=...                            → current balance
//   GET  /ledger?deviceId=...&limit=50                    → recent transactions
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();

const { earn, spend, getBalance, getLedger } = require('./lib/coinLedger');
const { EARN_SOURCES, SPEND_FEATURES } = require('./lib/coinRates');
const { isSoftLocked, recordEarnForVelocity, checkRateLimit } = require('./lib/antiAbuse');
const { markRefereeFirstLog } = require('./lib/referralEngine');
const { scoreGenuineness, ceilingFor } = require('./lib/genuineness');
const admin = require('firebase-admin');

// ── Earn ───────────────────────────────────────────────────────
router.post('/earn', async (req, res) => {
  const { deviceId, source, meta } = req.body || {};
  if (!deviceId || !source) {
    return res.status(400).json({ ok: false, reason: 'INVALID_INPUT' });
  }
  if (!Object.values(EARN_SOURCES).includes(source)) {
    return res.status(400).json({ ok: false, reason: 'UNKNOWN_SOURCE' });
  }

  // CRITICAL: rewarded-video earn must NEVER come via this endpoint.
  // That MUST come via /api/android/ads/rewarded-callback (SSV verified).
  if (source === EARN_SOURCES.REWARDED_VIDEO_WATCHED || source === EARN_SOURCES.REWARDED_INT_WATCHED) {
    return res.status(403).json({ ok: false, reason: 'REWARDED_VIA_SSV_ONLY' });
  }

  // Soft-lock check
  const lock = await isSoftLocked(deviceId);
  if (lock.locked) {
    return res.status(403).json({ ok: false, reason: 'SOFT_LOCKED', until: lock.until });
  }

  // Rate limit: max 200 earn requests/hour per device
  const rl = await checkRateLimit({ deviceId, bucket: 'earn', maxPerHour: 200 });
  if (!rl.ok) {
    return res.status(429).json({ ok: false, reason: 'RATE_LIMITED', reset_at: rl.resetAt });
  }

  const result = await earn({ deviceId, source, meta: meta || {} });

  if (result.ok && !result.idempotent) {
    // Track velocity (may trigger soft-lock)
    await recordEarnForVelocity({ deviceId, amount: result.amount });

    // If this was the first log for a referred user, stamp it so the 24h
    // delay clock starts.
    if (source === EARN_SOURCES.MANUAL_LOG) {
      markRefereeFirstLog(deviceId).catch(() => {});
    }
  }

  return res.json(result);
});

// ── Spend ──────────────────────────────────────────────────────
router.post('/spend', async (req, res) => {
  const { deviceId, featureId, intentId, meta } = req.body || {};
  if (!deviceId || !featureId) {
    return res.status(400).json({ ok: false, reason: 'INVALID_INPUT' });
  }
  if (!Object.values(SPEND_FEATURES).includes(featureId)) {
    return res.status(400).json({ ok: false, reason: 'UNKNOWN_FEATURE' });
  }

  const lock = await isSoftLocked(deviceId);
  if (lock.locked) {
    return res.status(403).json({ ok: false, reason: 'SOFT_LOCKED', until: lock.until });
  }

  // Rate limit: max 300 spend requests/hour per device
  const rl = await checkRateLimit({ deviceId, bucket: 'spend', maxPerHour: 300 });
  if (!rl.ok) {
    return res.status(429).json({ ok: false, reason: 'RATE_LIMITED', reset_at: rl.resetAt });
  }

  const result = await spend({ deviceId, featureId, intentId, meta: meta || {} });
  return res.json(result);
});

// ── Balance ────────────────────────────────────────────────────
router.get('/balance', async (req, res) => {
  const deviceId = req.query.deviceId;
  if (!deviceId) return res.status(400).json({ ok: false, reason: 'INVALID_INPUT' });
  const data = await getBalance(deviceId);
  return res.json({ ok: true, ...data });
});

// ── Ledger (recent transactions) ───────────────────────────────
router.get('/ledger', async (req, res) => {
  const deviceId = req.query.deviceId;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  if (!deviceId) return res.status(400).json({ ok: false, reason: 'INVALID_INPUT' });
  const data = await getLedger({ deviceId, limit });
  return res.json({ ok: true, ...data });
});

// ── Today's coach-log signals (for Home earn cards) ─────────────
// GET /signals-today?deviceId=...
// Returns { ok, logged_coaches: ['sleep', ...] } — coaches the user logged today.
router.get('/signals-today', async (req, res) => {
  const deviceId = req.query.deviceId;
  if (!deviceId) return res.status(400).json({ ok: false, reason: 'INVALID_INPUT' });
  try {
    const db = admin.firestore();
    const snap = await db.collection('wellness_users').doc(deviceId)
      .collection('coins_signals').get();

    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const todayMs = today.getTime();

    const logged_coaches = [];
    snap.forEach((doc) => {
      const d = doc.data() || {};
      if (typeof d.lastLogAtMs === 'number' && d.lastLogAtMs >= todayMs) {
        logged_coaches.push(doc.id);
      }
    });

    return res.json({ ok: true, logged_coaches });
  } catch (err) {
    return res.status(500).json({ ok: false, reason: 'TXN_FAILED', error: err.message });
  }
});

// ── Earn for a log (variable amount via genuineness) ───────────
// POST /earn-log { deviceId, coach, payload }
// Returns { ok, amount, ceiling, score, reasons, balance_after }
router.post('/earn-log', async (req, res) => {
  const { deviceId, coach, payload } = req.body || {};
  if (!deviceId || !coach) return res.status(400).json({ ok: false, reason: 'INVALID_INPUT' });

  const lock = await isSoftLocked(deviceId);
  if (lock.locked) return res.status(403).json({ ok: false, reason: 'SOFT_LOCKED', until: lock.until });

  const rl = await checkRateLimit({ deviceId, bucket: 'earn-log', maxPerHour: 60 });
  if (!rl.ok) return res.status(429).json({ ok: false, reason: 'RATE_LIMITED', reset_at: rl.resetAt });

  // Pull recent signals (cheap, denormalized) — best-effort, don't hard-fail
  let recentSignals = {};
  try {
    const db = admin.firestore();
    const sig = await db.collection('wellness_users').doc(deviceId)
      .collection('coins_signals').doc(coach).get();
    if (sig.exists) recentSignals = sig.data() || {};
  } catch { /* ignore */ }

  // ── FIRST-LOG-OF-DAY RULE (2026-06-01, founder direction): ──
  // Only the FIRST log of each coach per day earns coins + triggers an ad.
  // Subsequent logs same-coach-same-day return { ok: true, amount: 0,
  // is_first_today: false } so the client can skip both the coin credit AND
  // the post-log interstitial. This prevents farming + caps daily ad load at
  // a sane ~6 interstitials/user (one per coach max). Honest users get the
  // same reward as before; spammers can't multiply credits/ads.
  const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
  const lastLogAtMs = Number(recentSignals.lastLogAtMs || 0);
  const isFirstToday = lastLogAtMs < todayStart.getTime();

  if (!isFirstToday) {
    return res.json({
      ok: true,
      amount: 0,
      balance_after: undefined, // client should re-fetch only if needed
      is_first_today: false,
      reason: 'ALREADY_LOGGED_TODAY',
    });
  }

  const { amount, ceiling, score, reasons } = scoreGenuineness({ coach, payload: payload || {}, recentSignals });

  const result = await earn({
    deviceId,
    source: EARN_SOURCES.MANUAL_LOG,
    meta: { coach, genuineness_score: score, ceiling, is_first_today: true },
    amountOverride: amount,
  });

  // Update signals (best-effort) so next call has fresh state
  if (result.ok && !result.idempotent) {
    try {
      const db = admin.firestore();
      await db.collection('wellness_users').doc(deviceId)
        .collection('coins_signals').doc(coach).set({
          lastLogAtMs: Date.now(),
          todayLogCount: (recentSignals.todayLogCount || 0) + 1,
          weeklyConsistencyDays: recentSignals.weeklyConsistencyDays || 0,
        }, { merge: true });
    } catch { /* ignore */ }

    await recordEarnForVelocity({ deviceId, amount: result.amount });
    markRefereeFirstLog(deviceId).catch(() => {});
  }

  return res.json({ ...result, ceiling, score, reasons, is_first_today: true });
});

// ── Earn the daily check-in bonus (must come with verified ad watch) ──
// POST /earn-daily-checkin-ad { deviceId, adRequestId }
// The ad layer pre-validates the rewarded ad watch and POSTs adRequestId
// after CLOSED. If the user didn't watch, the client doesn't call this.
router.post('/earn-daily-checkin-ad', async (req, res) => {
  const { deviceId, adRequestId } = req.body || {};
  if (!deviceId || !adRequestId) return res.status(400).json({ ok: false, reason: 'INVALID_INPUT' });

  const lock = await isSoftLocked(deviceId);
  if (lock.locked) return res.status(403).json({ ok: false, reason: 'SOFT_LOCKED', until: lock.until });

  const rl = await checkRateLimit({ deviceId, bucket: 'checkin-ad', maxPerHour: 5 });
  if (!rl.ok) return res.status(429).json({ ok: false, reason: 'RATE_LIMITED', reset_at: rl.resetAt });

  // Use adRequestId as the explicit txnId for hard idempotency — replays of
  // the same ad credit nothing the second time.
  const crypto = require('crypto');
  const explicitTxnId = crypto.createHash('sha256').update(`checkin-ad:${deviceId}:${adRequestId}`).digest('hex').slice(0, 24);

  const result = await earn({
    deviceId,
    source: EARN_SOURCES.DAILY_CHECKIN_AD,
    meta: { ad_request_id: adRequestId },
    explicitTxnId,
  });

  if (result.ok && !result.idempotent) {
    await recordEarnForVelocity({ deviceId, amount: result.amount });
  }

  return res.json(result);
});

// ── Grant a bonus plan slot for watching a rewarded ad ─────────
// POST /grant-plan-slot { deviceId, adRequestId }
// Increments wellness_users/{deviceId}.androidBonusPlanSlots by 1.
// Idempotent on adRequestId via a one-shot doc under coins_redeemed_slots.
router.post('/grant-plan-slot', async (req, res) => {
  const { deviceId, adRequestId } = req.body || {};
  if (!deviceId || !adRequestId) return res.status(400).json({ ok: false, reason: 'INVALID_INPUT' });

  const lock = await isSoftLocked(deviceId);
  if (lock.locked) return res.status(403).json({ ok: false, reason: 'SOFT_LOCKED', until: lock.until });

  const rl = await checkRateLimit({ deviceId, bucket: 'grant-slot', maxPerHour: 8 });
  if (!rl.ok) return res.status(429).json({ ok: false, reason: 'RATE_LIMITED', reset_at: rl.resetAt });

  try {
    const db = admin.firestore();
    const userRef = db.collection('wellness_users').doc(deviceId);
    const dedupeRef = userRef.collection('coins_redeemed_slots').doc(adRequestId);

    const result = await db.runTransaction(async (tx) => {
      const dedupeSnap = await tx.get(dedupeRef);
      if (dedupeSnap.exists) {
        return { ok: true, idempotent: true };
      }
      const userSnap = await tx.get(userRef);
      const current = Number(userSnap?.data()?.androidBonusPlanSlots || 0);
      const next = current + 1;
      // Hard ceiling — never grant more than 10 bonus slots stacked (anti-abuse).
      if (next > 10) {
        return { ok: false, reason: 'MAX_BONUS_SLOTS' };
      }
      tx.set(userRef, { androidBonusPlanSlots: next }, { merge: true });
      tx.set(dedupeRef, { at: admin.firestore.FieldValue.serverTimestamp(), source: 'rewarded_ad' });
      return { ok: true, bonus_slots: next, idempotent: false };
    });

    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, reason: 'TXN_FAILED', error: err.message });
  }
});

module.exports = router;
