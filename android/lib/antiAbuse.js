'use strict';

// ═══════════════════════════════════════════════════════════════
// antiAbuse.js — Server-side rate limits, velocity flags, soft-locks.
//
// Layered defense:
//   1. Rate limits (windowed counters) — block requests exceeding caps
//   2. Velocity flags — detect anomalies (e.g., 2000 coins/h)
//   3. Soft-lock — flag suspicious accounts for manual review
//
// Firestore:
//   wellness_android_abuse_flags/{deviceId}
//     { velocity_count_1h, last_velocity_check, soft_locked_until,
//       integrity_failures, rate_limit_buckets }
// ═══════════════════════════════════════════════════════════════

const admin = require('firebase-admin');

const db = () => admin.firestore();
const flagsRef = (deviceId) => db().collection('wellness_android_abuse_flags').doc(deviceId);

const VELOCITY_LIMIT_PER_HOUR = 2000;
const SOFT_LOCK_DURATION_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Check if device is currently soft-locked.
 * Returns { locked: boolean, until?: number }.
 */
async function isSoftLocked(deviceId) {
  try {
    const snap = await flagsRef(deviceId).get();
    if (!snap.exists) return { locked: false };
    const data = snap.data() || {};
    const until = data.soft_locked_until ?? 0;
    if (Date.now() < until) return { locked: true, until };
    return { locked: false };
  } catch {
    return { locked: false };
  }
}

/**
 * Soft-lock an account. Increments integrity_failures and sets soft_locked_until.
 * Called when fraud is detected (signature replay, velocity flag, integrity fail).
 */
async function applySoftLock({ deviceId, reason }) {
  try {
    await flagsRef(deviceId).set(
      {
        soft_locked_until: Date.now() + SOFT_LOCK_DURATION_MS,
        last_soft_lock_reason: reason,
        last_soft_lock_at: admin.firestore.FieldValue.serverTimestamp(),
        integrity_failures: admin.firestore.FieldValue.increment(1),
      },
      { merge: true },
    );
  } catch (err) {
    console.error('[antiAbuse.applySoftLock] error:', err.message);
  }
}

/**
 * Track a coin earn event for velocity detection. If the hourly total
 * exceeds VELOCITY_LIMIT_PER_HOUR, soft-lock the account.
 *
 * Returns { flagged: boolean, currentHourTotal: number }.
 */
async function recordEarnForVelocity({ deviceId, amount }) {
  try {
    const ref = flagsRef(deviceId);
    return await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? (snap.data() || {}) : {};
      const now = Date.now();
      const windowStart = data.velocity_window_start ?? now;
      const windowAge = now - windowStart;

      let newTotal;
      let newWindowStart;
      if (windowAge > 60 * 60 * 1000) {
        // Window expired — start fresh
        newTotal = amount;
        newWindowStart = now;
      } else {
        newTotal = (data.velocity_count_1h ?? 0) + amount;
        newWindowStart = windowStart;
      }

      tx.set(
        ref,
        {
          velocity_count_1h: newTotal,
          velocity_window_start: newWindowStart,
          last_velocity_check_at: now,
        },
        { merge: true },
      );

      if (newTotal > VELOCITY_LIMIT_PER_HOUR) {
        tx.set(
          ref,
          {
            soft_locked_until: now + SOFT_LOCK_DURATION_MS,
            last_soft_lock_reason: 'velocity',
            last_soft_lock_at: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        return { flagged: true, currentHourTotal: newTotal };
      }
      return { flagged: false, currentHourTotal: newTotal };
    });
  } catch (err) {
    console.error('[antiAbuse.recordEarnForVelocity] error:', err.message);
    return { flagged: false, currentHourTotal: 0 };
  }
}

/**
 * Bucket-based rate limit (e.g., max 100 spend requests per hour).
 * Returns { ok: boolean, remaining: number, resetAt: number }.
 */
async function checkRateLimit({ deviceId, bucket, maxPerHour }) {
  try {
    const ref = flagsRef(deviceId);
    return await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? (snap.data() || {}) : {};
      const buckets = data.rate_limit_buckets || {};
      const b = buckets[bucket] || { count: 0, windowStart: 0 };
      const now = Date.now();
      const windowAge = now - (b.windowStart || 0);

      let newCount;
      let newWindowStart;
      if (windowAge > 60 * 60 * 1000) {
        newCount = 1;
        newWindowStart = now;
      } else {
        newCount = b.count + 1;
        newWindowStart = b.windowStart;
      }

      if (newCount > maxPerHour) {
        return {
          ok: false,
          remaining: 0,
          resetAt: newWindowStart + 60 * 60 * 1000,
        };
      }

      tx.set(
        ref,
        {
          rate_limit_buckets: {
            ...buckets,
            [bucket]: { count: newCount, windowStart: newWindowStart },
          },
        },
        { merge: true },
      );

      return {
        ok: true,
        remaining: maxPerHour - newCount,
        resetAt: newWindowStart + 60 * 60 * 1000,
      };
    });
  } catch (err) {
    console.error('[antiAbuse.checkRateLimit] error:', err.message);
    return { ok: true, remaining: 0, resetAt: 0 }; // fail open for availability
  }
}

module.exports = {
  isSoftLocked,
  applySoftLock,
  recordEarnForVelocity,
  checkRateLimit,
  VELOCITY_LIMIT_PER_HOUR,
};
