'use strict';
// ════════════════════════════════════════════════════════════════
// cron-helper.js — single hardening layer for every backend cron.
//
// Wraps a cron callback so that we get, with zero per-cron boilerplate:
//   1. ENABLE_CRON env gate — set ENABLE_CRON=false on non-primary
//      instances to silently no-op all crons (prevents N-replica double-fire)
//   2. Distributed Firestore lock — transactional acquire so multi-instance
//      deployments still single-fire even if ENABLE_CRON is left default-on
//   3. Overlap prevention — if previous run still holds the lock, skip
//   4. Top-level try/catch — a single thrown error never kills the cron
//   5. Telemetry — every run writes { name, started_at, finished_at,
//      duration_ms, status, error_message? } to cron_runs/{YYYY-MM-DD}
//   6. Structured logging — one line per start, one per end (with timing)
//   7. Per-process holder id — so leaked locks identify their owner
//   8. Defensive lock release — even if cron throws, lock is released
//
// Usage:
//   const { withCron } = require('./lib/cron-helper');
//   cron.schedule('*/10 * * * *', withCron('sleep:notifications', async () => {
//     // ... existing cron body ...
//   }, { ttlMs: 9 * 60_000 }));
//
// Lock semantics:
//   - lockTtlMs defaults to 10× the cron interval (capped at 30min) to give
//     room for slow runs without ever blocking a future tick
//   - If a run holds the lock and crashes without releasing (uncaughtException),
//     the TTL expires naturally and the next tick re-acquires
//
// Telemetry semantics:
//   - One doc per run under cron_runs/{date}_{name}/runs/{run_id}
//   - Aggregated daily doc at cron_runs/{date}_{name} with counts
//   - Best-effort writes — telemetry failure never blocks cron
// ════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
const crypto = require('crypto');

const HOLDER_ID = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const DEFAULT_TTL_MS = 10 * 60_000;     // 10min — long enough for any cron
const MAX_TTL_MS    = 30 * 60_000;
const TELEMETRY_COL = 'cron_runs';

function isCronEnabled() {
  // Default: enabled. Explicit "false"/"0"/"off" disables.
  // Set ENABLE_CRON=false on non-primary replicas to prevent double-fire.
  const v = String(process.env.ENABLE_CRON ?? 'true').toLowerCase().trim();
  return !['false', '0', 'off', 'no', 'disabled'].includes(v);
}

function todayUtcDateStr() {
  return new Date().toISOString().slice(0, 10);
}

// ─── Distributed lock via Firestore transaction ─────────────────
// Lock doc path: cron_locks/{name}
//   { holder, acquired_at, expires_at }
// Transactional read-then-set so only one process wins per tick.
async function acquireLock(name, ttlMs) {
  const db = admin.firestore();
  const ref = db.collection('cron_locks').doc(name);
  const now = Date.now();
  const expiresAt = now + ttlMs;
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        const data = snap.data() || {};
        if (typeof data.expires_at === 'number' && data.expires_at > now) {
          // Active lock — abort
          const err = new Error('lock_held');
          err.code = 'LOCK_HELD';
          err.holder = data.holder;
          err.expires_at = data.expires_at;
          throw err;
        }
      }
      tx.set(ref, {
        holder: HOLDER_ID,
        acquired_at: now,
        expires_at: expiresAt,
        cron_name: name,
      });
    });
    return true;
  } catch (e) {
    if (e && e.code === 'LOCK_HELD') return false;
    // Any other failure → don't block the cron; just skip lock and log.
    // Better to risk a double-fire than to silently never run.
    log.warn(`[cron-helper] lock acquire failed (${name}, fallback to no-lock):`, e?.message || e);
    return true;
  }
}

async function releaseLock(name) {
  try {
    const db = admin.firestore();
    const ref = db.collection('cron_locks').doc(name);
    // Only delete if WE still hold it (don't yank someone else's lock).
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const data = snap.data() || {};
      if (data.holder === HOLDER_ID) tx.delete(ref);
    });
  } catch (e) {
    // Non-fatal — lock will TTL out naturally.
    log.warn(`[cron-helper] lock release failed (${name}):`, e?.message || e);
  }
}

// ─── Telemetry writer ──────────────────────────────────────────
async function writeRunTelemetry(name, run) {
  try {
    const date = todayUtcDateStr();
    const dailyRef = admin.firestore().collection(TELEMETRY_COL).doc(`${date}_${name}`);
    const runId = `${run.started_at}_${HOLDER_ID}`;
    const runRef = dailyRef.collection('runs').doc(runId);

    const batch = admin.firestore().batch();
    batch.set(runRef, {
      ...run,
      holder: HOLDER_ID,
      cron_name: name,
    }, { merge: true });
    batch.set(dailyRef, {
      cron_name: name,
      date,
      [`count_${run.status}`]: admin.firestore.FieldValue.increment(1),
      last_run_at: admin.firestore.FieldValue.serverTimestamp(),
      last_status: run.status,
      last_duration_ms: run.duration_ms,
    }, { merge: true });
    await batch.commit();
  } catch (e) {
    // Telemetry must never block the cron.
    log.warn(`[cron-helper] telemetry failed (${name}):`, e?.message || e);
  }
}

// ─── Public wrapper ────────────────────────────────────────────
// Returns a callback you can hand directly to cron.schedule().
function withCron(name, fn, opts = {}) {
  if (typeof name !== 'string' || !name) {
    throw new Error('[cron-helper] withCron requires a non-empty name');
  }
  if (typeof fn !== 'function') {
    throw new Error(`[cron-helper] withCron(${name}) requires a function`);
  }
  const ttlMs = Math.min(Math.max(opts.ttlMs ?? DEFAULT_TTL_MS, 60_000), MAX_TTL_MS);
  const skipLock = opts.skipLock === true;

  return async function cronWrapper() {
    if (!isCronEnabled()) {
      // Silent: don't even log. ENABLE_CRON=false instances should be noise-free.
      return;
    }

    const startedAt = Date.now();
    let lockAcquired = false;

    try {
      if (!skipLock) {
        lockAcquired = await acquireLock(name, ttlMs);
        if (!lockAcquired) {
          // Another instance is running this same cron right now. Skip silently.
          // (We log at debug level only — too noisy at info.)
          return;
        }
      }

      log.info(`[cron] ▶ ${name} started`);
      await fn();
      const durationMs = Date.now() - startedAt;
      log.info(`[cron] ✓ ${name} completed in ${durationMs}ms`);

      // Telemetry — fire and forget
      writeRunTelemetry(name, {
        started_at: startedAt,
        finished_at: Date.now(),
        duration_ms: durationMs,
        status: 'success',
      }).catch(() => {});
    } catch (e) {
      const durationMs = Date.now() - startedAt;
      const errMsg = e?.message || String(e);
      log.error(`[cron] ✗ ${name} failed after ${durationMs}ms:`, errMsg);
      writeRunTelemetry(name, {
        started_at: startedAt,
        finished_at: Date.now(),
        duration_ms: durationMs,
        status: 'error',
        error_message: errMsg.slice(0, 500),
      }).catch(() => {});
    } finally {
      if (lockAcquired) await releaseLock(name);
    }
  };
}

// ─── Public: check helper for callers who want to gate manually ────
function shouldRunCron() {
  return isCronEnabled();
}

module.exports = {
  withCron,
  shouldRunCron,
  isCronEnabled,
  // Exposed for tests:
  _acquireLock: acquireLock,
  _releaseLock: releaseLock,
  _HOLDER_ID: HOLDER_ID,
};
