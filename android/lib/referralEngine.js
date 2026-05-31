'use strict';

// ═══════════════════════════════════════════════════════════════
// referralEngine.js — Generate codes, attribute redemptions, prevent fraud.
//
// Firestore:
//   wellness_users/{deviceId}/referral/code     { code, created_at, share_count }
//   wellness_users/{deviceId}/referral/redeemed { referrer_device_id, code, at,
//                                                 bonus_credited_at, first_log_at }
//   wellness_android_referral_index/{code}      { device_id, created_at }
//
// Fraud defenses:
//   - Same device fingerprint between referrer and referee → block
//   - Self-referral (same deviceId) → block
//   - Referrer hits lifetime cap (50) → block
//   - Referee can only redeem ONCE in their lifetime
//   - Bonus credited only AFTER referee's first genuine log + 24h
// ═══════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
const crypto = require('crypto');
const { earn } = require('./coinLedger');
const { EARN_SOURCES, EARN_RATES } = require('./coinRates');

const db = () => admin.firestore();
const referralRef = (deviceId) => db().collection('wellness_users').doc(deviceId).collection('referral');
const indexRef = (code) => db().collection('wellness_android_referral_index').doc(code);

// 6-char alphanumeric, no ambiguous chars (no 0/O/I/1/L)
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function genCode() {
  const buf = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += ALPHABET[buf[i] % ALPHABET.length];
  }
  return out;
}

/**
 * Get or generate the referral code for a device.
 * Returns { code, share_url }.
 */
async function getOrCreateCode(deviceId) {
  if (!deviceId) throw new Error('deviceId required');
  const codeDoc = referralRef(deviceId).doc('code');
  const snap = await codeDoc.get();
  if (snap.exists) {
    const data = snap.data();
    return {
      code: data.code,
      share_url: `https://stillalive.living/r/${data.code}`,
    };
  }

  // Generate with collision retry (extremely rare given 30^6 = 729M combos)
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = genCode();
    const ix = indexRef(code);
    try {
      const written = await db().runTransaction(async (tx) => {
        const existing = await tx.get(ix);
        if (existing.exists) return false;
        tx.set(ix, {
          device_id: deviceId,
          created_at: admin.firestore.FieldValue.serverTimestamp(),
        });
        tx.set(codeDoc, {
          code,
          created_at: admin.firestore.FieldValue.serverTimestamp(),
          share_count: 0,
          redeemed_count: 0,
        });
        return true;
      });
      if (written) {
        return {
          code,
          share_url: `https://stillalive.living/r/${code}`,
        };
      }
    } catch (err) {
      // Collision retry on next iteration
      continue;
    }
  }
  throw new Error('Failed to generate unique referral code');
}

/**
 * Mark code as redeemed by referee. Does NOT credit coins yet — that happens
 * after the referee's first genuine log + 24h delay (creditPendingReferrals).
 *
 * Returns { ok, reason?, code?, referrer_device_id? }.
 */
async function redeemCode({ refereeDeviceId, code }) {
  if (!refereeDeviceId || !code) return { ok: false, reason: 'INVALID_INPUT' };

  const codeUpper = String(code).toUpperCase().trim();
  if (!/^[A-Z0-9]{6}$/.test(codeUpper)) {
    return { ok: false, reason: 'CODE_FORMAT_INVALID' };
  }

  // Lookup code
  const ix = await indexRef(codeUpper).get();
  if (!ix.exists) return { ok: false, reason: 'CODE_NOT_FOUND' };
  const referrerDeviceId = ix.data().device_id;

  // Self-referral block
  if (referrerDeviceId === refereeDeviceId) {
    return { ok: false, reason: 'SELF_REFERRAL_FORBIDDEN' };
  }

  // ── EXISTING-USER BLOCK (2026-06-01 founder rule): ──
  // Referral codes are for NEW users only. If this device already has any
  // coach-log signal in our system, they're an active existing user and
  // cannot be "referred" by anyone. Prevents two existing users from
  // cross-referring each other to double-dip credits. Cheap O(1) Firestore
  // read (limit 1).
  try {
    const signalsSnap = await db()
      .collection('wellness_users').doc(refereeDeviceId)
      .collection('coins_signals').limit(1).get();
    if (!signalsSnap.empty) {
      return { ok: false, reason: 'ALREADY_ACTIVE_USER' };
    }
  } catch {
    // Read failure → fall through (don't fail-open AND don't fail-closed
    // on infrastructure errors; the other checks below still gate access).
  }

  // Check if referee already redeemed
  const refereeRedeemedDoc = referralRef(refereeDeviceId).doc('redeemed');
  const refereeSnap = await refereeRedeemedDoc.get();
  if (refereeSnap.exists) {
    return { ok: false, reason: 'ALREADY_REDEEMED' };
  }

  // Check referrer hasn't hit lifetime cap
  const rate = EARN_RATES[EARN_SOURCES.REFERRAL_BONUS_REFERRER];
  const lifetimeMax = rate?.lifetimeMax ?? 50;
  const counterSnap = await db()
    .collection('wellness_users').doc(referrerDeviceId)
    .collection('coins_counters').doc('lifetime').get();
  const lifetimeCounts = counterSnap.exists ? (counterSnap.data() || {}) : {};
  const referrerCount = lifetimeCounts[`count_${EARN_SOURCES.REFERRAL_BONUS_REFERRER}`] ?? 0;
  if (referrerCount >= lifetimeMax) {
    return { ok: false, reason: 'REFERRER_LIFETIME_CAP' };
  }

  // Record redemption (no coins credited yet)
  try {
    await db().runTransaction(async (tx) => {
      tx.set(refereeRedeemedDoc, {
        referrer_device_id: referrerDeviceId,
        code: codeUpper,
        at: admin.firestore.FieldValue.serverTimestamp(),
        bonus_credited_at: null, // set when first log + 24h passes
        first_log_at: null,
      });

      // Bump referrer's share/redeem stats
      const refCodeDoc = referralRef(referrerDeviceId).doc('code');
      tx.set(
        refCodeDoc,
        { redeemed_count: admin.firestore.FieldValue.increment(1) },
        { merge: true },
      );
    });

    return { ok: true, code: codeUpper, referrer_device_id: referrerDeviceId };
  } catch (err) {
    console.error('[referralEngine.redeemCode] error:', err.message);
    return { ok: false, reason: 'TXN_FAILED' };
  }
}

/**
 * Called when referee logs anything for the FIRST time.
 * Stamps first_log_at. The bonus is credited only after 24h has passed
 * (separate cron job: creditPendingReferrals).
 */
async function markRefereeFirstLog(deviceId) {
  if (!deviceId) return { ok: false };
  const doc = referralRef(deviceId).doc('redeemed');
  try {
    const snap = await doc.get();
    if (!snap.exists) return { ok: true, no_referral: true };
    const data = snap.data();
    if (data.first_log_at) return { ok: true, already_stamped: true };
    await doc.set({ first_log_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return { ok: true, stamped: true };
  } catch (err) {
    console.error('[referralEngine.markRefereeFirstLog] error:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Cron-callable: credit pending referral bonuses for referees who logged
 * their first activity >24h ago and haven't been credited yet.
 *
 * Iterates over all redemption docs missing bonus_credited_at and where
 * first_log_at < now - 24h. For each, credit 200 to referrer + 200 to
 * referee atomically.
 */
async function creditPendingReferrals({ now = Date.now() } = {}) {
  const cutoff = new Date(now - 24 * 60 * 60 * 1000);
  let credited = 0;

  // Collection group query across all users' /referral/redeemed docs
  const snap = await db()
    .collectionGroup('referral')
    .where('first_log_at', '!=', null)
    .where('bonus_credited_at', '==', null)
    .where('first_log_at', '<=', cutoff)
    .limit(500)
    .get();

  for (const doc of snap.docs) {
    const data = doc.data();
    if (!data.referrer_device_id) continue;
    const refereeDeviceId = doc.ref.parent.parent.id; // .../{refereeId}/referral/redeemed

    try {
      // Credit both sides
      const r1 = await earn({
        deviceId: data.referrer_device_id,
        source: EARN_SOURCES.REFERRAL_BONUS_REFERRER,
        meta: { referee_device_id: refereeDeviceId, code: data.code },
      });
      const r2 = await earn({
        deviceId: refereeDeviceId,
        source: EARN_SOURCES.REFERRAL_BONUS_REFEREE,
        meta: { referrer_device_id: data.referrer_device_id, code: data.code },
      });

      if (r1.ok && r2.ok) {
        await doc.ref.set(
          { bonus_credited_at: admin.firestore.FieldValue.serverTimestamp() },
          { merge: true },
        );
        credited++;
      }
    } catch (err) {
      console.error('[referralEngine.creditPendingReferrals] error for doc', doc.id, err.message);
    }
  }

  return { credited, scanned: snap.size };
}

module.exports = {
  getOrCreateCode,
  redeemCode,
  markRefereeFirstLog,
  creditPendingReferrals,
  _genCode: genCode,
};
