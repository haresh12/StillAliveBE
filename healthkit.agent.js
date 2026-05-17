/**
 * healthkit.agent.js — HealthKit sync endpoints.
 *
 * Mounted at /api/v2/healthkit
 *
 * Endpoints:
 *   POST /sync            Incremental batch ingestion
 *   POST /backfill        90-day history pull
 *   GET  /status          User's HealthKit sync state
 *   DELETE /data          Wipe HK-sourced data (Apple compliance)
 *
 * Storage shape:
 *   wellness_users/{deviceId}/agents/{coach}/healthkit_imports/{importId}
 *   wellness_users/{deviceId}/healthkit_meta/status
 */

const express = require('express');
const admin = require('firebase-admin');
const router = express.Router();

const log = require('./lib/log');

// ─── Helpers ──────────────────────────────────────────────────────────────

const getDeviceId = (req) => {
  const id =
    (req.body && req.body.deviceId) ||
    req.headers['x-device-id'] ||
    req.query.deviceId;
  if (!id || String(id).trim().length < 4) return null;
  return String(id).trim();
};

// HKObjectTypeIdentifier → agent it belongs to.
// Keep this MAP as the single source of routing truth.
const TYPE_TO_AGENT = {
  HKCategoryTypeIdentifierSleepAnalysis: 'sleep',
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: 'mind', // primary HRV consumer
  HKQuantityTypeIdentifierRespiratoryRate: 'sleep',
  HKQuantityTypeIdentifierHeartRate: 'fitness',
  HKQuantityTypeIdentifierRestingHeartRate: 'fitness',
  HKQuantityTypeIdentifierStepCount: 'fitness',
  HKQuantityTypeIdentifierActiveEnergyBurned: 'fitness',
  HKQuantityTypeIdentifierVO2Max: 'fitness',
  HKQuantityTypeIdentifierAppleExerciseTime: 'fitness',
  HKWorkoutTypeIdentifier: 'fitness',
  HKQuantityTypeIdentifierBodyMass: 'nutrition',
  HKQuantityTypeIdentifierBodyFatPercentage: 'nutrition',
  HKQuantityTypeIdentifierHeight: 'nutrition',
  HKQuantityTypeIdentifierDietaryEnergyConsumed: 'nutrition',
  HKQuantityTypeIdentifierDietaryProtein: 'nutrition',
  HKQuantityTypeIdentifierDietaryCarbohydrates: 'nutrition',
  HKQuantityTypeIdentifierDietaryFatTotal: 'nutrition',
  HKQuantityTypeIdentifierDietaryWater: 'water',
  HKQuantityTypeIdentifierBloodGlucose: 'fasting',
  HKCategoryTypeIdentifierMindfulSession: 'mind',
};

const agentFor = (hkType) => TYPE_TO_AGENT[hkType] || null;

// ─── POST /api/v2/healthkit/sync ──────────────────────────────────────────

router.post('/sync', async (req, res) => {
  const deviceId = getDeviceId(req);
  if (!deviceId) {
    log.warn('[hk-sync] rejected — missing deviceId');
    return res.status(400).json({ ok: false, error: 'deviceId required' });
  }

  const { since, batches } = req.body || {};
  if (!Array.isArray(batches)) {
    log.warn(`[hk-sync] rejected device=${deviceId.slice(0, 8)} — batches not array`);
    return res.status(400).json({ ok: false, error: 'batches must be an array' });
  }

  const t0 = Date.now();
  const totalSamples = batches.reduce((n, b) => n + (Array.isArray(b.samples) ? b.samples.length : 0), 0);
  log.info(`[hk-sync] start device=${deviceId.slice(0, 8)} batches=${batches.length} samples=${totalSamples} since=${since || 'none'}`);
  // Per-batch breakdown so we can see WHICH HK types are flowing in
  for (const b of batches) {
    const c = Array.isArray(b.samples) ? b.samples.length : 0;
    const agent = (TYPE_TO_AGENT[b.type] || 'UNROUTED');
    log.info(`[hk-sync]   batch type=${b.type} → coach=${agent} samples=${c}`);
  }

  const db = admin.firestore();
  let imported = 0;
  let deduped = 0;
  const errors = [];

  // Batched writes — Firestore allows up to 500 ops per WriteBatch. We split
  // into chunks of 450 to leave headroom for the meta-doc write below.
  // Previous code awaited each .set() sequentially: ~1s round-trip per sample
  // → ~9s for 9 samples. WriteBatch sends them in one HTTP round-trip → ~300ms
  // regardless of count.
  const BATCH_LIMIT = 450;
  let writeBatch = db.batch();
  let opsInBatch = 0;
  const flush = async () => {
    if (opsInBatch === 0) return;
    await writeBatch.commit();
    writeBatch = db.batch();
    opsInBatch = 0;
  };

  // Each batch: { type: 'HK...Identifier', samples: [{ uuid, startDate, endDate, value, source, ... }] }
  for (const batch of batches) {
    const agent = agentFor(batch.type);
    if (!agent) continue; // Unknown type — skip silently

    const importsRef = db
      .collection('wellness_users')
      .doc(deviceId)
      .collection('agents')
      .doc(agent)
      .collection('healthkit_imports');

    for (const sample of batch.samples || []) {
      try {
        const importId = sample.uuid || hashKey(deviceId, batch.type, sample.startDate);
        writeBatch.set(
          importsRef.doc(importId),
          {
            hk_type: batch.type,
            start_date: sample.startDate,
            end_date: sample.endDate,
            value: sample.value ?? null,
            stage: sample.stage || null,
            workout_type: sample.workoutType || null,
            duration: sample.duration ?? null,
            total_energy: sample.totalEnergyBurned ?? null,
            total_distance: sample.totalDistance ?? null,
            unit: sample.unit || null,
            source: sample.source || 'Unknown',
            source_bundle_id: sample.sourceBundleId || null,
            imported_at: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        opsInBatch++;
        imported++;
        if (opsInBatch >= BATCH_LIMIT) {
          await flush();
        }
      } catch (err) {
        errors.push({ uuid: sample.uuid, error: err.message });
      }
    }
  }
  // Flush any remaining ops
  await flush();

  // Update healthkit_meta with last sync timestamp
  try {
    await db
      .collection('wellness_users')
      .doc(deviceId)
      .collection('healthkit_meta')
      .doc('status')
      .set(
        {
          last_sync_at: admin.firestore.FieldValue.serverTimestamp(),
          last_sync_imported: imported,
        },
        { merge: true }
      );
  } catch (err) {
    log.warn('[healthkit/sync] meta update failed:', err.message);
  }

  // Print the FIRST stored sample shape so you can see exactly what's in
  // Firestore. One log line per /sync regardless of how many samples — keeps
  // the noise bounded. Useful for diagnosing "is my data really there?".
  try {
    const firstBatch = batches.find((b) => Array.isArray(b.samples) && b.samples.length > 0);
    const firstSample = firstBatch?.samples?.[0];
    if (firstSample) {
      const agent = agentFor(firstBatch.type);
      const stored = {
        path: `wellness_users/${deviceId.slice(0,8)}…/agents/${agent}/healthkit_imports/${(firstSample.uuid || '...').slice(0,8)}…`,
        hk_type: firstBatch.type,
        start_date: firstSample.startDate,
        end_date: firstSample.endDate,
        value: firstSample.value ?? null,
        stage: firstSample.stage || null,
        workout_type: firstSample.workoutType || null,
        duration: firstSample.duration ?? null,
        total_energy: firstSample.totalEnergyBurned ?? null,
        source: firstSample.source || 'Unknown',
      };
      log.info(`[hk-sync] sample stored: ${JSON.stringify(stored)}`);
    }
  } catch { /* log-only — never fail the response */ }

  // Bust HK negative caches so the user's next chat / Home / wearable-insights
  // read sees their freshly-imported samples instead of hitting a stale "no data" short-circuit.
  if (imported > 0) {
    try {
      const { invalidateHKCache } = require('./lib/healthkit/context-builder');
      invalidateHKCache(deviceId);
    } catch { /* non-fatal */ }
    try {
      const { invalidateHKDYKCache } = require('./wellness-cross-v2/did-you-know/hk-insights');
      invalidateHKDYKCache(deviceId);
    } catch { /* non-fatal */ }
    try {
      const { invalidateWearableInsightsCache } = require('./lib/healthkit/wearable-insights');
      invalidateWearableInsightsCache(deviceId);
    } catch { /* non-fatal */ }
  }

  log.info(`[hk-sync] done  device=${deviceId.slice(0, 8)} imported=${imported} errors=${errors.length} took=${Date.now() - t0}ms`);
  res.json({ ok: true, imported, deduped, errors });
});

// ─── POST /api/v2/healthkit/backfill ──────────────────────────────────────

router.post('/backfill', async (req, res) => {
  const deviceId = getDeviceId(req);
  if (!deviceId) {
    log.warn('[hk-backfill] rejected — missing deviceId');
    return res.status(400).json({ ok: false, error: 'deviceId required' });
  }

  const { days = 90, types = [] } = req.body || {};
  log.info(`[hk-backfill] intent device=${deviceId.slice(0, 8)} days=${days} types=${types.length}`);
  const db = admin.firestore();

  // We just record the user's intent + permitted types. The actual ingestion
  // is driven by the FE's batched syncs (same /sync endpoint). This endpoint
  // exists so the FE can flip the "backfill done" UI state and so we have
  // an auditable record of when the user first granted permission.
  try {
    await db
      .collection('wellness_users')
      .doc(deviceId)
      .collection('healthkit_meta')
      .doc('status')
      .set(
        {
          backfill_requested_at: admin.firestore.FieldValue.serverTimestamp(),
          backfill_days: days,
          granted_types: types,
        },
        { merge: true }
      );

    res.json({
      ok: true,
      queued: true,
      estimated_seconds: Math.ceil(days * 0.15),
    });
  } catch (err) {
    log.error('[healthkit/backfill] error:', err.message);
    res.status(500).json({ ok: false, error: 'backfill_record_failed' });
  }
});

// ─── GET /api/v2/healthkit/status ─────────────────────────────────────────

router.get('/status', async (req, res) => {
  const deviceId = getDeviceId(req);
  if (!deviceId) {
    log.warn('[hk-status] rejected — missing deviceId');
    return res.status(400).json({ ok: false, error: 'deviceId required' });
  }
  log.info(`[hk-status] device=${deviceId.slice(0, 8)}`);
  try {
    const db = admin.firestore();
    const snap = await db
      .collection('wellness_users')
      .doc(deviceId)
      .collection('healthkit_meta')
      .doc('status')
      .get();

    if (!snap.exists) {
      return res.json({
        last_sync_at: null,
        granted_types: [],
        denied_types: [],
        backfill_complete: false,
      });
    }

    const data = snap.data();
    const lastSyncIso = data.last_sync_at?.toDate?.()?.toISOString() ?? null;
    // Per-coach last-sample timestamp helps the FE confirm WHICH coaches
    // are actually receiving fresh data. Cheap: 1 doc per coach, 6 reads.
    const coaches = ['sleep', 'mind', 'nutrition', 'fitness', 'water', 'fasting'];
    const perCoach = {};
    await Promise.all(coaches.map(async (c) => {
      try {
        const last = await db
          .collection('wellness_users').doc(deviceId)
          .collection('agents').doc(c)
          .collection('healthkit_imports')
          .orderBy('start_date', 'desc')
          .limit(1).get();
        const top = last.docs[0]?.data();
        perCoach[c] = {
          last_sample_start: top?.start_date || null,
          last_sample_type: top?.hk_type || null,
          last_imported_at: top?.imported_at?.toDate?.()?.toISOString() ?? null,
        };
      } catch {
        perCoach[c] = { last_sample_start: null, last_sample_type: null, last_imported_at: null };
      }
    }));
    // Sync-health hint for the FE: did the user's data flow stop? Used to
    // gate the silent "Reconnect Apple Health" banner. A user is healthy
    // when at least one coach has any sample in the last 14 days.
    const FOURTEEN_DAYS_MS = 14 * 24 * 3600 * 1000;
    const now = Date.now();
    const isFlowing = Object.values(perCoach).some((c) => {
      const t = c.last_sample_start ? Date.parse(c.last_sample_start) : NaN;
      return Number.isFinite(t) && (now - t) < FOURTEEN_DAYS_MS;
    });
    res.json({
      last_sync_at: lastSyncIso,
      granted_types: data.granted_types || [],
      denied_types: data.denied_types || [],
      backfill_complete: !!data.backfill_requested_at,
      last_sync_imported: data.last_sync_imported || 0,
      per_coach: perCoach,
      is_flowing: isFlowing,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'status_read_failed' });
  }
});

// ─── GET /api/v2/healthkit/debug ──────────────────────────────────────────
//
// Debug-only inspector: lists per-agent / per-type stored sample counts and
// a small head/tail slice of the actual stored docs. Lets us verify in one
// curl exactly what HK data made it into Firestore for this user.
//
// Usage:
//   GET /api/v2/healthkit/debug?deviceId=XXXX
//   GET /api/v2/healthkit/debug?deviceId=XXXX&agent=fitness     (one agent)
//   GET /api/v2/healthkit/debug?deviceId=XXXX&full=1            (all samples)

router.get('/debug', async (req, res) => {
  const deviceId = getDeviceId(req);
  if (!deviceId) return res.status(400).json({ ok: false, error: 'deviceId required' });
  const onlyAgent = req.query.agent || null;
  const wantFull = req.query.full === '1';
  const agents = onlyAgent
    ? [String(onlyAgent)]
    : ['sleep', 'mind', 'nutrition', 'fitness', 'water', 'fasting'];

  try {
    const db = admin.firestore();
    const out = {};
    for (const agent of agents) {
      const col = db
        .collection('wellness_users')
        .doc(deviceId)
        .collection('agents')
        .doc(agent)
        .collection('healthkit_imports');
      const snap = await col.orderBy('start_date', 'asc').get();
      const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const byType = {};
      for (const s of all) {
        const t = s.hk_type || 'unknown';
        if (!byType[t]) byType[t] = { count: 0, head: [], tail: [], first_date: null, last_date: null };
        byType[t].count++;
        if (!byType[t].first_date || s.start_date < byType[t].first_date) byType[t].first_date = s.start_date;
        if (!byType[t].last_date || s.start_date > byType[t].last_date) byType[t].last_date = s.start_date;
      }
      for (const t of Object.keys(byType)) {
        const subset = all.filter((s) => s.hk_type === t);
        byType[t].head = subset.slice(0, 3);
        byType[t].tail = subset.length > 3 ? subset.slice(-2) : [];
        if (wantFull) byType[t].all = subset;
      }
      out[agent] = { total: all.length, by_type: byType };
    }
    res.json({ ok: true, deviceId: deviceId.slice(0, 8) + '...', summary: out });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── DELETE /api/v2/healthkit/data ────────────────────────────────────────
//
// Apple compliance: user must be able to wipe HK-sourced data without
// nuking their account. We delete every `healthkit_imports` subcollection
// across all 6 agents, plus the healthkit_meta doc.

router.delete('/data', async (req, res) => {
  const deviceId = getDeviceId(req);
  if (!deviceId) {
    return res.status(400).json({ ok: false, error: 'deviceId required' });
  }
  try {
    const db = admin.firestore();
    const agents = ['sleep', 'mind', 'fitness', 'nutrition', 'water', 'fasting'];
    let deleted = 0;
    for (const agent of agents) {
      const importsRef = db
        .collection('wellness_users')
        .doc(deviceId)
        .collection('agents')
        .doc(agent)
        .collection('healthkit_imports');
      const batch = await importsRef.get();
      for (const doc of batch.docs) {
        await doc.ref.delete();
        deleted++;
      }
    }
    // Clear meta doc
    await db
      .collection('wellness_users')
      .doc(deviceId)
      .collection('healthkit_meta')
      .doc('status')
      .set(
        {
          last_sync_at: null,
          granted_types: [],
          backfill_requested_at: null,
          purged_at: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    res.json({ ok: true, deleted_count: deleted });
  } catch (err) {
    log.error('[healthkit/data DELETE] error:', err.message);
    res.status(500).json({ ok: false, error: 'delete_failed' });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function hashKey(deviceId, hkType, startDate) {
  return `${deviceId}-${hkType}-${startDate}`.replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 200);
}

module.exports = router;
