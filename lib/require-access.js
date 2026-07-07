'use strict';
// ═══════════════════════════════════════════════════════════════
// require-access.js — server-side entitlement gate for expensive LLM-generation
// endpoints (coach replies, plan generation, meal/sleep describe, vision).
//
// WHY: the app's paywall is a HARD paywall — the FE blocks a locked (non-premium,
// non-trial) user from sending any chat or running any value-creating action. But
// that gate is client-only; a client that bypasses it could hit the OpenAI-backed
// routes directly and get unlimited coaching. This middleware mirrors the FE gate
// server-side (defense-in-depth on the main cost center).
//
// Access model matches lib/voice-calls.js subFlags(): access = isPremium OR isTrial,
// read from the LIVE wellness_users/{deviceId}.subscription (billing is account-level,
// not agent-sandboxed — same source the voice gate uses, so the two stay consistent).
//
// FAILS OPEN: returns 402 ONLY when we positively determined "no active entitlement".
// On ANY lookup error we call next() — a transient Firestore hiccup must NEVER block a
// paying user. (subFlags() swallows errors into hasAccess:false, which would fail
// CLOSED, so we read directly here to control the error path.)
// ═══════════════════════════════════════════════════════════════

module.exports = async function requireAccess(req, res, next) {
  const deviceId =
    (req.body && req.body.deviceId) ||
    (req.query && req.query.deviceId) ||
    req.headers['x-device-id'];

  // No id to check → let the handler decide (matches how these routes already
  // treat a missing deviceId). Never hard-fail here.
  if (!deviceId) return next();

  // ENFORCE iOS ONLY. Android v1 ships 100% free (no Play Billing / RevenueCat key
  // yet), so its users never have a `subscription` written and would ALL be 402'd —
  // mirror the FE's ALL_FEATURES_FREE_ON_ANDROID policy. Anything that is not
  // positively iOS (Android, web, an old client that doesn't send X-Platform, a
  // legacy screen) FAILS OPEN — the gate is defense-in-depth for the iOS paywall,
  // not a hard security boundary. Phase 2 (Play Billing) can widen this to Android.
  const platform = String(
    req.headers['x-platform'] || (req.body && req.body.platform) || ''
  ).toLowerCase();
  if (platform !== 'ios') return next();

  let sub;
  try {
    const admin = require('firebase-admin');
    const snap = await admin
      .firestore()
      .collection('wellness_users')
      .doc(String(deviceId))
      .get();
    sub = snap.exists ? (snap.data().subscription || {}) : {};
  } catch (e) {
    // Fail OPEN — do not block on a lookup error.
    return next();
  }

  const hasAccess = !!(sub.isPremium || sub.isTrial);
  if (hasAccess) return next();

  return res.status(402).json({
    error: 'premium_required',
    message: 'This feature requires an active subscription.',
  });
};
