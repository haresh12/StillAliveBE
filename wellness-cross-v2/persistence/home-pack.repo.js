/**
 * home-pack.repo.js
 * Read/write the cached Home pack.
 */

const { v2HomePack, Timestamp } = require('./_firestore');

async function readHomePack(deviceId) {
  const snap = await v2HomePack(deviceId).get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (!data || !data.meta) return null;
  // Compute stale_for_seconds based on _server_at if present
  const at = data._server_at && data._server_at.toDate ? data._server_at.toDate() : new Date(data.meta.computed_at);
  const stale = Math.max(0, Math.floor((Date.now() - at.getTime()) / 1000));
  return { ...data, meta: { ...data.meta, stale_for_seconds: stale } };
}

async function writeHomePack(deviceId, pack) {
  await v2HomePack(deviceId).set({ ...pack, _server_at: Timestamp.now() }, { merge: true });
}

module.exports = { readHomePack, writeHomePack };
