/**
 * insights-pack.repo.js
 */

const { v2InsightsPack, v2Correlations, Timestamp } = require('./_firestore');

async function readInsightsPack(deviceId, range) {
  const snap = await v2InsightsPack(deviceId, range).get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (!data || !data.meta) return null;
  const at = data._server_at && data._server_at.toDate ? data._server_at.toDate() : new Date(data.meta.computed_at);
  const stale = Math.max(0, Math.floor((Date.now() - at.getTime()) / 1000));
  return { ...data, meta: { ...data.meta, stale_for_seconds: stale } };
}

async function readCorrelations(deviceId) {
  const snap = await v2Correlations(deviceId).get();
  if (!snap.exists) return null;
  return snap.data();
}

module.exports = { readInsightsPack, readCorrelations };
