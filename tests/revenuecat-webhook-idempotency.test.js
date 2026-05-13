/**
 * RevenueCat webhook idempotency — contract test.
 *
 * RC retries webhooks on 5xx and uses at-least-once delivery, so the same
 * event.id can arrive multiple times. Our handler dedupes via
 * `webhook_events/{eventId}.create()` — Firestore's `create()` is atomic and
 * throws code 6 (ALREADY_EXISTS) if the doc already exists.
 *
 * This test simulates the contract using a tiny in-memory stand-in for
 * Firestore. The real implementation lives in server.js; we test the
 * BEHAVIOR rather than the exact handler so this test is fast (no admin
 * SDK boot, no network, no auth).
 *
 * Run: node tests/revenuecat-webhook-idempotency.test.js
 */

'use strict';

const assert = require('assert');

// ── Fake Firestore that mimics .create() throwing on duplicate ──────────────
function makeFakeDb() {
  const store = new Map();
  return {
    collection() {
      return {
        doc(id) {
          return {
            async create(payload) {
              if (store.has(id)) {
                const err = new Error('Document already exists.');
                err.code = 6; // ALREADY_EXISTS in Google's gRPC code map
                throw err;
              }
              store.set(id, payload);
              return { writeTime: Date.now() };
            },
            async get() { return { exists: store.has(id), data: () => store.get(id) }; },
          };
        },
      };
    },
    _size() { return store.size; },
  };
}

// ── Function under test: idempotency wrapper that mirrors the server.js logic
async function checkIdempotency(db, eventId, type) {
  if (!eventId) return { allow: true };
  try {
    await db.collection('webhook_events').doc(String(eventId)).create({
      source: 'revenuecat',
      type,
      receivedAt: Date.now(),
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });
    return { allow: true };
  } catch (e) {
    if (e?.code === 6 || /already exists/i.test(e?.message || '')) {
      return { allow: false, reason: 'duplicate_event_ignored' };
    }
    // Any other error — let it through so a Firestore hiccup doesn't
    // permanently block downstream processing (matches server.js policy).
    return { allow: true, reason: 'idempotency_check_errored' };
  }
}

let pass = 0;
let fail = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`✓ ${name}`); })
    .catch((e) => { fail++; console.error(`✗ ${name}\n   ${e.message}`); });
}

(async () => {
  await t('first arrival of an event is allowed', async () => {
    const db = makeFakeDb();
    const r = await checkIdempotency(db, 'evt_abc123', 'INITIAL_PURCHASE');
    assert.deepStrictEqual(r, { allow: true });
    assert.strictEqual(db._size(), 1, 'event id should be recorded');
  });

  await t('duplicate arrival of the same event is blocked', async () => {
    const db = makeFakeDb();
    await checkIdempotency(db, 'evt_abc123', 'INITIAL_PURCHASE');
    const second = await checkIdempotency(db, 'evt_abc123', 'INITIAL_PURCHASE');
    assert.strictEqual(second.allow, false, 'duplicate must be blocked');
    assert.strictEqual(second.reason, 'duplicate_event_ignored');
    assert.strictEqual(db._size(), 1, 'no second doc should be created');
  });

  await t('different event ids are independent', async () => {
    const db = makeFakeDb();
    const a = await checkIdempotency(db, 'evt_a', 'INITIAL_PURCHASE');
    const b = await checkIdempotency(db, 'evt_b', 'RENEWAL');
    assert.strictEqual(a.allow, true);
    assert.strictEqual(b.allow, true);
    assert.strictEqual(db._size(), 2);
  });

  await t('missing event id is allowed (back-compat for older RC payloads)', async () => {
    const db = makeFakeDb();
    const r = await checkIdempotency(db, null, 'INITIAL_PURCHASE');
    assert.strictEqual(r.allow, true);
    assert.strictEqual(db._size(), 0, 'no marker is written for missing id');
  });

  await t('concurrent duplicate writes — only ONE wins (atomic create())', async () => {
    const db = makeFakeDb();
    // Fire 5 simultaneous attempts at the same eventId. Exactly one should
    // succeed; the other four should be blocked. This proves create() is
    // truly atomic in our stub (and is the contract Firestore guarantees).
    const results = await Promise.all([
      checkIdempotency(db, 'evt_race', 'TRIAL_STARTED'),
      checkIdempotency(db, 'evt_race', 'TRIAL_STARTED'),
      checkIdempotency(db, 'evt_race', 'TRIAL_STARTED'),
      checkIdempotency(db, 'evt_race', 'TRIAL_STARTED'),
      checkIdempotency(db, 'evt_race', 'TRIAL_STARTED'),
    ]);
    const allowed = results.filter((r) => r.allow).length;
    const blocked = results.filter((r) => !r.allow).length;
    assert.strictEqual(allowed, 1, `exactly 1 attempt should win, got ${allowed}`);
    assert.strictEqual(blocked, 4, `4 duplicates should be blocked, got ${blocked}`);
  });

  await t('refund event ids dedupe just like any other type', async () => {
    const db = makeFakeDb();
    const first = await checkIdempotency(db, 'evt_refund', 'CANCELLATION');
    const dupe = await checkIdempotency(db, 'evt_refund', 'CANCELLATION');
    assert.strictEqual(first.allow, true);
    assert.strictEqual(dupe.allow, false);
  });

  console.log('');
  console.log(`${pass}/${pass + fail} passed`);
  process.exit(fail === 0 ? 0 : 1);
})();
