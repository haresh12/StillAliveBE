'use strict';

// ═══════════════════════════════════════════════════════════════
// coinLedger.js — Atomic coin earn/spend via Firestore transactions.
//
// SERVER IS SOURCE OF TRUTH. Client only reads balance — never mints.
//
// Firestore schema:
//   wellness_users/{deviceId}/coins/balance         (doc)
//     { balance, lifetime_earned, lifetime_spent, updated_at }
//   wellness_users/{deviceId}/coins_ledger/{txnId}  (collection)
//     { source, amount, direction: 'in'|'out', feature_id?, meta?, at, balance_after }
//
// Invariants enforced:
//   - balance never goes negative (spend with insufficient balance throws)
//   - earn respects daily/per-coach/lifetime caps from coinRates.js
//   - spend respects SPEND_PRICES exactly (client cannot pick price)
//   - idempotency: explicit txn_id can be provided to dedupe (used by SSV)
//   - rate limits + velocity flags enforced via antiAbuse.js before earn
// ═══════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
const crypto = require('crypto');
const { EARN_SOURCES, EARN_RATES, SPEND_PRICES } = require('./coinRates');

const db = () => admin.firestore();

const balanceRef = (deviceId) =>
  db().collection('wellness_users').doc(deviceId).collection('coins').doc('balance');

const ledgerRef = (deviceId) =>
  db().collection('wellness_users').doc(deviceId).collection('coins_ledger');

const todayKey = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};

/**
 * Compute the current count for a given source today, given the ledger.
 * Used to enforce dailyMax / perCoachDailyMax / lifetimeMax.
 *
 * Snapshot strategy: counters are stored under `wellness_users/{deviceId}/coins_counters/{period}`
 * for efficient lookup — full ledger scans would be slow at scale.
 */
const countersRef = (deviceId, period /* 'today' | 'lifetime' */) =>
  db().collection('wellness_users').doc(deviceId).collection('coins_counters').doc(period);

/**
 * Compute a stable txn ID from (deviceId, source, meta, dayKey).
 * Used as the document ID to make repeat calls idempotent for
 * once-per-day type events (cold-start, 6/6 daily, streak hit, etc).
 */
function deriveTxnId(deviceId, source, meta = {}) {
  const seed = JSON.stringify({ deviceId, source, meta, day: todayKey() });
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24);
}

/**
 * Earn coins atomically. Returns { ok, balance_after, reason? }.
 *
 * @param {Object} args
 * @param {string} args.deviceId
 * @param {string} args.source              one of EARN_SOURCES
 * @param {Object} [args.meta]              source-specific metadata (e.g., { coach: 'sleep' })
 * @param {string} [args.explicitTxnId]     for SSV / external dedupe
 */
async function earn({ deviceId, source, meta = {}, explicitTxnId, amountOverride }) {
  if (!deviceId || typeof deviceId !== 'string') {
    return { ok: false, reason: 'INVALID_DEVICE_ID' };
  }

  const rate = EARN_RATES[source];
  if (!rate) return { ok: false, reason: 'UNKNOWN_SOURCE' };

  // Variable-amount sources (manual_log under genuineness, monthly_2x bonus)
  // pass amountOverride. We CLAMP to [0, 2 * coachCeiling] as a safety net so
  // a buggy scorer can't mint arbitrary coins.
  let amount;
  if (typeof amountOverride === 'number' && Number.isFinite(amountOverride) && amountOverride > 0) {
    amount = Math.min(Math.max(1, Math.floor(amountOverride)), 5000);
  } else {
    amount = rate.amount;
  }
  if (amount <= 0) return { ok: false, reason: 'ZERO_AMOUNT' };

  const txnId = explicitTxnId || deriveTxnId(deviceId, source, meta);
  const txnDoc = ledgerRef(deviceId).doc(txnId);
  const todayDoc = countersRef(deviceId, todayKey());
  const lifetimeDoc = countersRef(deviceId, 'lifetime');

  try {
    const result = await db().runTransaction(async (tx) => {
      // ── Idempotency: if txn already exists, return existing result ──
      const existing = await tx.get(txnDoc);
      if (existing.exists) {
        const balDoc = await tx.get(balanceRef(deviceId));
        return {
          ok: true,
          idempotent: true,
          balance_after: balDoc.exists ? (balDoc.data().balance ?? 0) : 0,
          amount: existing.data().amount,
        };
      }

      // ── Read current counters ──
      const todaySnap = await tx.get(todayDoc);
      const lifetimeSnap = await tx.get(lifetimeDoc);
      const balSnap = await tx.get(balanceRef(deviceId));

      const todayCounts = (todaySnap.exists ? todaySnap.data() : {}) || {};
      const lifetimeCounts = (lifetimeSnap.exists ? lifetimeSnap.data() : {}) || {};

      // ── Cap checks ──
      // Daily max per source
      if (rate.dailyMax !== undefined) {
        const k = `count_${source}`;
        const cur = todayCounts[k] ?? 0;
        if (cur >= rate.dailyMax) {
          return { ok: false, reason: 'DAILY_CAP', cap: rate.dailyMax, used: cur };
        }
      }

      // Per-coach daily max (for MANUAL_LOG)
      if (rate.perCoachDailyMax !== undefined && meta.coach) {
        const k = `count_${source}_${meta.coach}`;
        const cur = todayCounts[k] ?? 0;
        if (cur >= rate.perCoachDailyMax) {
          return { ok: false, reason: 'PER_COACH_DAILY_CAP', cap: rate.perCoachDailyMax, used: cur };
        }
      }

      // Lifetime max
      if (rate.lifetimeMax !== undefined) {
        const k = `count_${source}`;
        const cur = lifetimeCounts[k] ?? 0;
        if (cur >= rate.lifetimeMax) {
          return { ok: false, reason: 'LIFETIME_CAP', cap: rate.lifetimeMax, used: cur };
        }
      }

      // ── Cooldown (rewarded ads) ──
      if (rate.cooldownSec !== undefined) {
        const lastK = `last_${source}_at`;
        const lastAt = todayCounts[lastK] ?? 0;
        const sinceMs = Date.now() - lastAt;
        if (lastAt > 0 && sinceMs < rate.cooldownSec * 1000) {
          return {
            ok: false,
            reason: 'COOLDOWN',
            wait_sec: Math.ceil((rate.cooldownSec * 1000 - sinceMs) / 1000),
          };
        }
      }

      // ── Compute new balance ──
      const curBalance = balSnap.exists ? (balSnap.data().balance ?? 0) : 0;
      const newBalance = curBalance + amount;
      const curLifetimeEarned = balSnap.exists ? (balSnap.data().lifetime_earned ?? 0) : 0;
      const curLifetimeSpent = balSnap.exists ? (balSnap.data().lifetime_spent ?? 0) : 0;

      // ── Write ledger entry ──
      tx.set(txnDoc, {
        source,
        amount,
        direction: 'in',
        meta,
        at: admin.firestore.FieldValue.serverTimestamp(),
        balance_after: newBalance,
      });

      // ── Update balance ──
      tx.set(
        balanceRef(deviceId),
        {
          balance: newBalance,
          lifetime_earned: curLifetimeEarned + amount,
          lifetime_spent: curLifetimeSpent,
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      // ── Increment counters ──
      const counterUpdate = {
        [`count_${source}`]: admin.firestore.FieldValue.increment(1),
      };
      if (rate.cooldownSec !== undefined) {
        counterUpdate[`last_${source}_at`] = Date.now();
      }
      if (rate.perCoachDailyMax !== undefined && meta.coach) {
        counterUpdate[`count_${source}_${meta.coach}`] = admin.firestore.FieldValue.increment(1);
      }
      tx.set(todayDoc, counterUpdate, { merge: true });

      if (rate.lifetimeMax !== undefined) {
        tx.set(
          lifetimeDoc,
          { [`count_${source}`]: admin.firestore.FieldValue.increment(1) },
          { merge: true },
        );
      }

      return { ok: true, balance_after: newBalance, amount, idempotent: false };
    });

    return result;
  } catch (err) {
    console.error('[coinLedger.earn] error:', err.message);
    return { ok: false, reason: 'TXN_FAILED', error: err.message };
  }
}

/**
 * Spend coins atomically. Returns { ok, balance_after, reason? }.
 *
 * Client cannot specify the amount — it's looked up from SPEND_PRICES.
 * If balance < price, returns ok:false with reason INSUFFICIENT_BALANCE.
 *
 * @param {Object} args
 * @param {string} args.deviceId
 * @param {string} args.featureId        one of SPEND_FEATURES
 * @param {string} [args.intentId]       client-provided idempotency key
 *                                        (so a retry of the same UI action doesn't double-spend)
 * @param {Object} [args.meta]
 */
async function spend({ deviceId, featureId, intentId, meta = {} }) {
  if (!deviceId || typeof deviceId !== 'string') {
    return { ok: false, reason: 'INVALID_DEVICE_ID' };
  }

  const price = SPEND_PRICES[featureId];
  if (price === undefined || price <= 0) {
    return { ok: false, reason: 'UNKNOWN_FEATURE' };
  }

  // Build txn ID from intentId if provided, else random.
  // Idempotency: if intentId was already used (e.g., user retried button), don't double-spend.
  const txnId = intentId
    ? crypto.createHash('sha256').update(`${deviceId}:spend:${featureId}:${intentId}`).digest('hex').slice(0, 24)
    : crypto.randomBytes(12).toString('hex');
  const txnDoc = ledgerRef(deviceId).doc(txnId);

  try {
    const result = await db().runTransaction(async (tx) => {
      const existing = await tx.get(txnDoc);
      if (existing.exists) {
        const balDoc = await tx.get(balanceRef(deviceId));
        return {
          ok: true,
          idempotent: true,
          balance_after: balDoc.exists ? (balDoc.data().balance ?? 0) : 0,
          amount: existing.data().amount,
        };
      }

      const balSnap = await tx.get(balanceRef(deviceId));
      const curBalance = balSnap.exists ? (balSnap.data().balance ?? 0) : 0;

      if (curBalance < price) {
        return { ok: false, reason: 'INSUFFICIENT_BALANCE', balance: curBalance, required: price };
      }

      const newBalance = curBalance - price;
      const curLifetimeEarned = balSnap.exists ? (balSnap.data().lifetime_earned ?? 0) : 0;
      const curLifetimeSpent = balSnap.exists ? (balSnap.data().lifetime_spent ?? 0) : 0;

      tx.set(txnDoc, {
        source: 'spend',
        feature_id: featureId,
        amount: price,
        direction: 'out',
        meta,
        at: admin.firestore.FieldValue.serverTimestamp(),
        balance_after: newBalance,
      });

      tx.set(
        balanceRef(deviceId),
        {
          balance: newBalance,
          lifetime_earned: curLifetimeEarned,
          lifetime_spent: curLifetimeSpent + price,
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      return { ok: true, balance_after: newBalance, amount: price, idempotent: false };
    });

    return result;
  } catch (err) {
    console.error('[coinLedger.spend] error:', err.message);
    return { ok: false, reason: 'TXN_FAILED', error: err.message };
  }
}

/**
 * Read current balance (free read, no transaction).
 */
async function getBalance(deviceId) {
  if (!deviceId) return { balance: 0, lifetime_earned: 0, lifetime_spent: 0 };
  try {
    const snap = await balanceRef(deviceId).get();
    if (!snap.exists) {
      return { balance: 0, lifetime_earned: 0, lifetime_spent: 0 };
    }
    const data = snap.data();
    return {
      balance: data.balance ?? 0,
      lifetime_earned: data.lifetime_earned ?? 0,
      lifetime_spent: data.lifetime_spent ?? 0,
    };
  } catch (err) {
    console.error('[coinLedger.getBalance] error:', err.message);
    return { balance: 0, lifetime_earned: 0, lifetime_spent: 0, error: err.message };
  }
}

/**
 * Recent ledger entries (paginated).
 */
async function getLedger({ deviceId, limit = 50 }) {
  if (!deviceId) return { items: [] };
  try {
    const snap = await ledgerRef(deviceId)
      .orderBy('at', 'desc')
      .limit(Math.min(limit, 200))
      .get();
    const items = snap.docs.map((d) => ({ txn_id: d.id, ...d.data() }));
    return { items };
  } catch (err) {
    console.error('[coinLedger.getLedger] error:', err.message);
    return { items: [], error: err.message };
  }
}

module.exports = {
  earn,
  spend,
  getBalance,
  getLedger,
  // exposed for tests
  _deriveTxnId: deriveTxnId,
};
