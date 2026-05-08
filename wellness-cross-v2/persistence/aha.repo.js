/**
 * aha.repo.js — read/write the user's AHA event history with idempotency.
 *
 * Each event is stored under wellness_users/{deviceId}/cross_v2_aha/{stable_id}.
 * The stable id encodes the archetype + payload (e.g. 'correlation:sleep×mind',
 * 'unlock:14') so re-evaluating the same context never produces duplicates.
 *
 * APIs:
 *   - readAhaIds(deviceId) → Set<string>     (already-fired ids)
 *   - readAhaFeed(deviceId, limit=12) → Array<event>  (newest first)
 *   - persistNewAha(deviceId, events) → Promise<void> (idempotent — set with merge)
 */

'use strict';

const { v2AhaCol, Timestamp } = require('./_firestore');

async function readAhaIds(deviceId) {
  const out = new Set();
  try {
    const snap = await v2AhaCol(deviceId).select().get();
    snap.forEach((d) => out.add(d.id));
  } catch (_) { /* missing collection → empty set */ }
  return out;
}

async function readAhaFeed(deviceId, limit = 12) {
  try {
    const snap = await v2AhaCol(deviceId)
      .orderBy('ts', 'desc')
      .limit(Math.max(1, Math.min(50, limit)))
      .get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (_) {
    return [];
  }
}

async function persistNewAha(deviceId, events) {
  if (!Array.isArray(events) || events.length === 0) return;
  const writes = events.map((e) => {
    if (!e || !e.id) return null;
    return v2AhaCol(deviceId).doc(e.id).set({
      kind: e.kind,
      tier: e.tier || null,
      ts: e.ts,
      headline: e.headline,
      body: e.body || null,
      payload: e.payload || null,
      _server_at: Timestamp.now(),
    }, { merge: true });
  }).filter(Boolean);
  await Promise.allSettled(writes);
}

module.exports = { readAhaIds, readAhaFeed, persistNewAha };
