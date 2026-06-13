'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// healthkit.bc.agent.js — P0: the Apple Health / Health Connect INGEST + STORE.
//
// THE UNBLOCK: the app already syncs HK data (src/lib/healthkit/sync.ts) to
// POST /api/v2/healthkit/sync — but that route never existed, so every sync
// 404'd into the void. This builds it. Synced data now LANDS in:
//     wellness_bc_users/{deviceId}/health_samples/{key}
//        quantity → { days: { "YYYY-MM-DD": value }, unit, updated_at }
//        sleep    → { days: { "YYYY-MM-DD": { asleep_min, awake_min, efficiency } } }
//        workout  → { days: { "YYYY-MM-DD": [ { workout_type, minutes, kcal, distance_m } ] } }
//
// Per-type daily rows (no raw PII, no composite indexes — fetch the small doc,
// compute in memory). Capped to ~120 days. P1+ (lib/hk-signals.js, scoring,
// coach, notifications) read from here. See APPLE_HEALTH_BIGCHANGE_PLAN.md.
// ═══════════════════════════════════════════════════════════════════════════
const express = require('express');
const { userDoc } = require('./lib/collections');
const { getHealthSignals } = require('./lib/hk-signals');
const { domainHealth } = require('./lib/hk-domain');

const router = express.Router();

// GET /api/v2/healthkit/signals?deviceId[&domain]  — derived signals (recovery, sleep, HRV…) for the
// Analysis tab / any surface. domain= scopes to that domain's relevant slice. null when no HK data.
router.get('/signals', async (req, res) => {
  const deviceId = req.query.deviceId || req.query.device_id;
  const domain = (req.query.domain || '').toString().trim();
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  try {
    const data = domain ? await domainHealth(String(deviceId), domain) : await getHealthSignals(String(deviceId));
    res.json({ ok: true, health: data || null });
  } catch (e) {
    console.error('[healthkit] /signals error:', e.message);
    res.json({ ok: true, health: null });
  }
});

const MAX_DAYS = 120; // keep ~4 months of daily rows per type

// Apple HKObjectTypeIdentifier → our internal key (reverse of sync.ts hkTypeIdentifier()).
const KEY_BY_IDENTIFIER = {
  HKQuantityTypeIdentifierBodyMass: 'weight',
  HKQuantityTypeIdentifierBodyFatPercentage: 'bodyFat',
  HKQuantityTypeIdentifierHeight: 'height',
  HKQuantityTypeIdentifierHeartRate: 'heartRate',
  HKQuantityTypeIdentifierRestingHeartRate: 'restingHeartRate',
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: 'hrv',
  HKQuantityTypeIdentifierRespiratoryRate: 'respiratoryRate',
  HKQuantityTypeIdentifierStepCount: 'steps',
  HKQuantityTypeIdentifierActiveEnergyBurned: 'activeEnergy',
  HKQuantityTypeIdentifierVO2Max: 'vo2Max',
  HKQuantityTypeIdentifierAppleExerciseTime: 'exerciseTime',
  HKCategoryTypeIdentifierAppleStandHour: 'standHours',
  HKCategoryTypeIdentifierSleepAnalysis: 'sleep',
  HKCategoryTypeIdentifierMindfulSession: 'mindfulSession',
  HKQuantityTypeIdentifierDietaryEnergyConsumed: 'dietaryEnergy',
  HKQuantityTypeIdentifierDietaryProtein: 'protein',
  HKQuantityTypeIdentifierDietaryCarbohydrates: 'carbs',
  HKQuantityTypeIdentifierDietaryFatTotal: 'fat',
  HKQuantityTypeIdentifierDietaryWater: 'water',
  HKQuantityTypeIdentifierBloodGlucose: 'bloodGlucose',
  HKWorkoutTypeIdentifier: 'workout',
};
const UNIT = { steps: 'count', activeEnergy: 'kcal', dietaryEnergy: 'kcal', heartRate: 'bpm', restingHeartRate: 'bpm', respiratoryRate: 'bpm', hrv: 'ms', weight: 'kg', bodyFat: '%', vo2Max: 'ml/kg/min', protein: 'g', carbs: 'g', fat: 'g', water: 'ml', bloodGlucose: 'mg/dL' };

const col = (deviceId) => userDoc(deviceId).collection('health_samples');
const day = (iso) => String(iso || '').slice(0, 10);

// Read-merge-trim-write one per-type doc (small; no index needed). Returns rows written.
async function upsertDays(deviceId, key, newDays, extra) {
  if (!newDays || !Object.keys(newDays).length) return 0;
  const ref = col(deviceId).doc(key);
  const snap = await ref.get().catch(() => null);
  const cur = (snap && snap.exists && snap.data().days) || {};
  const merged = { ...cur, ...newDays }; // latest sync wins per date
  const dates = Object.keys(merged).sort();
  const trimmed = {};
  for (const d of dates.slice(-MAX_DAYS)) trimmed[d] = merged[d];
  await ref.set({ key, days: trimmed, updated_at: Date.now(), ...(extra || {}) }); // replace (so trim sticks)
  return Object.keys(newDays).length;
}

// Sleep: the app sends raw per-stage segments → aggregate per night (mirrors sync.ts logic).
function aggregateSleep(samples) {
  const byDate = {};
  for (const s of samples || []) {
    const d = day(s.startDate);
    if (!d) continue;
    const dur = Date.parse(s.endDate) - Date.parse(s.startDate);
    if (!Number.isFinite(dur) || dur <= 0) continue;
    if (!byDate[d]) byDate[d] = { asleepMs: 0, awakeMs: 0 };
    if (s.stage === 'awake') byDate[d].awakeMs += dur;
    else if (s.stage && s.stage !== 'inBed') byDate[d].asleepMs += dur;
  }
  const out = {};
  for (const [d, n] of Object.entries(byDate)) {
    if (n.asleepMs <= 0) continue;
    const inBed = n.asleepMs + n.awakeMs;
    out[d] = {
      asleep_min: Math.round(n.asleepMs / 60000),
      awake_min: Math.round(n.awakeMs / 60000),
      efficiency: inBed > 0 ? Math.round((n.asleepMs / inBed) * 100) : null,
    };
  }
  return out;
}

// Workouts: events → per-date arrays of compact summaries.
function aggregateWorkouts(samples) {
  const byDate = {};
  for (const w of samples || []) {
    const d = day(w.startDate);
    if (!d) continue;
    (byDate[d] = byDate[d] || []).push({
      workout_type: w.workoutType || w.activityType || 'workout',
      minutes: Math.round((Number(w.duration) || 0) / 60),
      kcal: Math.round(Number(w.totalEnergyBurned) || 0),
      distance_m: Math.round(Number(w.totalDistance || w.distance) || 0),
      start: w.startDate || null,
    });
  }
  return byDate;
}

// Quantity types: the app already daily-bucketed → one sample per day with a numeric value.
function aggregateQuantity(samples) {
  const out = {};
  for (const s of samples || []) {
    const d = day(s.startDate);
    if (!d) continue;
    const v = typeof s.value === 'number' ? s.value : null;
    if (v == null) continue;
    out[d] = v; // one row per day; latest wins
  }
  return out;
}

// ═══ POST /api/v2/healthkit/sync — the ingest (incremental + backfill share this) ═══
router.post('/sync', async (req, res) => {
  try {
    const deviceId = String((req.body && (req.body.deviceId || req.body.device_id)) || '').trim();
    const batches = (req.body && Array.isArray(req.body.batches)) ? req.body.batches : [];
    if (!deviceId) return res.status(400).json({ ok: false, error: 'deviceId required', imported: 0 });

    let imported = 0;
    for (const b of batches) {
      const key = KEY_BY_IDENTIFIER[b && b.type] || (b && b.type);
      const samples = (b && Array.isArray(b.samples)) ? b.samples : [];
      if (!key || !samples.length) continue;
      try {
        if (key === 'sleep') imported += await upsertDays(deviceId, 'sleep', aggregateSleep(samples));
        else if (key === 'workout') imported += await upsertDays(deviceId, 'workout', aggregateWorkouts(samples));
        else imported += await upsertDays(deviceId, key, aggregateQuantity(samples), { unit: UNIT[key] || null });
      } catch (e) {
        console.warn(`[healthkit] upsert ${key} failed:`, e.message); // per-type failure shouldn't kill the batch
      }
    }
    console.log(`🍎 [healthkit] /sync device=${deviceId.slice(0, 8)} batches=${batches.length} imported=${imported} rows`);
    return res.json({ ok: true, imported });
  } catch (e) {
    console.error('[healthkit] /sync error:', e.message);
    return res.status(500).json({ ok: false, error: 'sync_failed', imported: 0 });
  }
});

// POST /api/v2/healthkit/backfill — intent metadata (audit trail; the real data comes via /sync).
router.post('/backfill', async (req, res) => {
  try {
    const deviceId = String((req.body && (req.body.deviceId || req.body.device_id)) || '').trim();
    if (!deviceId) return res.status(400).json({ ok: false });
    await userDoc(deviceId).set(
      { hk_backfill: { requested_at: Date.now(), days: Number(req.body.days) || null, types: Array.isArray(req.body.types) ? req.body.types.slice(0, 40) : [] } },
      { merge: true },
    ).catch(() => {});
    return res.json({ ok: true });
  } catch {
    return res.json({ ok: true }); // best-effort, non-critical
  }
});

// DELETE /api/v2/healthkit/data — privacy wipe (sign-out / account delete).
router.delete('/data', async (req, res) => {
  try {
    const deviceId = String((req.query.deviceId || req.query.device_id || (req.body && req.body.deviceId)) || '').trim();
    if (!deviceId) return res.status(400).json({ ok: false, error: 'deviceId required' });
    const snap = await col(deviceId).get().catch(() => ({ docs: [] }));
    await Promise.all(snap.docs.map((d) => d.ref.delete().catch(() => {})));
    console.log(`🍎 [healthkit] /data WIPED device=${deviceId.slice(0, 8)} docs=${snap.docs.length}`);
    return res.json({ ok: true, deleted: snap.docs.length });
  } catch (e) {
    console.error('[healthkit] /data delete error:', e.message);
    return res.status(500).json({ ok: false });
  }
});

module.exports = router;
