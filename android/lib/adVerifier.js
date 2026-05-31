'use strict';

// ═══════════════════════════════════════════════════════════════
// adVerifier.js — Verify AdMob Server-Side Verification (SSV) callbacks.
//
// AdMob signs every rewarded ad callback with ed25519. The signature is
// included as `signature` query param; the rest of the query string forms
// the signed message. Public keys live at:
//   https://www.gstatic.com/admob/reward/verifier-keys.json
//
// We:
//   1. Cache keys for 24h (Google rotates ~yearly, plenty of margin)
//   2. Pick the right key by `key_id` query param
//   3. Verify ed25519 signature over the canonical message
//   4. Idempotency check (eventId in wellness_android_rewarded_callbacks)
//
// Reference: https://developers.google.com/admob/android/ssv
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');
const https = require('https');
const admin = require('firebase-admin');

const KEY_URL = 'https://www.gstatic.com/admob/reward/verifier-keys.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let keyCache = { keys: null, fetchedAt: 0 };

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

async function getVerifierKeys() {
  const now = Date.now();
  if (keyCache.keys && now - keyCache.fetchedAt < CACHE_TTL_MS) {
    return keyCache.keys;
  }
  const json = await fetchJson(KEY_URL);
  // Expected shape: { keys: [{ keyId, pem, base64 }] }
  keyCache = { keys: json.keys || [], fetchedAt: now };
  return keyCache.keys;
}

/**
 * Verify the SSV callback. Returns { ok, reason?, eventId?, rewardAmount?, rewardItem?, userId? }.
 *
 * @param {string} fullQueryString  the raw query string from the request URL
 *                                  (everything after `?`, including ALL params)
 */
async function verifySsv(fullQueryString) {
  if (typeof fullQueryString !== 'string' || fullQueryString.length === 0) {
    return { ok: false, reason: 'EMPTY_QUERY' };
  }

  // Per AdMob docs, signature + key_id are the LAST two params on the URL.
  // The signed message is the query string with those two trimmed off (and
  // the leading `?` not included).
  // Example: ad_network=...&ad_unit=...&...&signature=...&key_id=...
  const sigIdx = fullQueryString.lastIndexOf('&signature=');
  if (sigIdx < 0) return { ok: false, reason: 'NO_SIGNATURE' };

  const signedMessage = fullQueryString.slice(0, sigIdx);
  const trailer = fullQueryString.slice(sigIdx + 1); // "signature=...&key_id=..."

  const params = new URLSearchParams(trailer);
  const sigB64 = params.get('signature');
  const keyId = params.get('key_id');
  if (!sigB64 || !keyId) return { ok: false, reason: 'MISSING_SIG_OR_KEY_ID' };

  // Lookup key
  const keys = await getVerifierKeys();
  const key = keys.find((k) => String(k.keyId) === String(keyId));
  if (!key) return { ok: false, reason: 'UNKNOWN_KEY_ID' };

  // ed25519 verification
  try {
    const signature = Buffer.from(sigB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const publicKey = crypto.createPublicKey({
      key: key.pem,
      format: 'pem',
    });
    const verified = crypto.verify(
      null, // ed25519 has no hash
      Buffer.from(signedMessage, 'utf-8'),
      publicKey,
      signature,
    );
    if (!verified) return { ok: false, reason: 'SIGNATURE_INVALID' };
  } catch (err) {
    return { ok: false, reason: 'VERIFY_ERROR', error: err.message };
  }

  // Extract reward fields from the message (now trusted)
  const allParams = new URLSearchParams(fullQueryString);
  const result = {
    ok: true,
    eventId: allParams.get('transaction_id') || allParams.get('event_id'),
    rewardAmount: Number(allParams.get('reward_amount') || 0),
    rewardItem: allParams.get('reward_item') || 'coins',
    userId: allParams.get('user_id') || null,
    adUnitId: allParams.get('ad_unit') || null,
    adNetwork: allParams.get('ad_network') || null,
    customData: allParams.get('custom_data') || null,
  };
  if (!result.eventId) {
    return { ok: false, reason: 'NO_EVENT_ID' };
  }
  return result;
}

/**
 * Idempotency: persist eventId to wellness_android_rewarded_callbacks/{eventId}.
 * Returns true if this eventId is NEW (proceed with reward), false if it's
 * a replay (do NOT credit again).
 */
async function recordEventIfNew({ eventId, deviceId, adUnitId, rewardAmount }) {
  const db = admin.firestore();
  const ref = db.collection('wellness_android_rewarded_callbacks').doc(eventId);
  try {
    return await db.runTransaction(async (tx) => {
      const existing = await tx.get(ref);
      if (existing.exists) return false; // replay
      tx.set(ref, {
        device_id: deviceId,
        ad_unit_id: adUnitId,
        reward_amount: rewardAmount,
        processed_at: admin.firestore.FieldValue.serverTimestamp(),
      });
      return true;
    });
  } catch (err) {
    console.error('[adVerifier.recordEventIfNew] error:', err.message);
    return false; // fail closed — don't double-credit on db errors
  }
}

module.exports = {
  verifySsv,
  recordEventIfNew,
  // exposed for tests
  _resetCache: () => { keyCache = { keys: null, fetchedAt: 0 }; },
};
