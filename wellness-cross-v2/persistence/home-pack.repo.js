/**
 * home-pack.repo.js
 * Read/write the cached Home pack.
 */

const { v2HomePack, Timestamp } = require('./_firestore');

// Last-defense invariant for the Home headline (2026-05-22).
//
// Even after fixing the score_lifetime calc, users have reported seeing
// stale Firestore packs from before the fix shipped (e.g. score_lifetime=1
// while wellness.score=12). The pack served to the FE here is the single
// source of truth for the gauge — if we don't patch on read, the bad value
// persists for up to STALE_HOURS (4hr) before background refresh kicks in.
//
// Rule: score_lifetime must never be less than wellness.score. Logging
// can only LIFT the headline, never lower it.
function applyLifetimeInvariant(pack) {
  if (!pack || !pack.wellness) return pack;
  const w = pack.wellness;
  if (!Number.isFinite(w.score)) return pack;
  if (!Number.isFinite(w.score_lifetime) || w.score_lifetime < w.score) {
    return { ...pack, wellness: { ...w, score_lifetime: w.score } };
  }
  return pack;
}

async function readHomePack(deviceId) {
  const snap = await v2HomePack(deviceId).get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (!data || !data.meta) return null;
  // Compute stale_for_seconds based on _server_at if present
  const at = data._server_at && data._server_at.toDate ? data._server_at.toDate() : new Date(data.meta.computed_at);
  const stale = Math.max(0, Math.floor((Date.now() - at.getTime()) / 1000));
  const out = { ...data, meta: { ...data.meta, stale_for_seconds: stale } };
  return applyLifetimeInvariant(out);
}

async function writeHomePack(deviceId, pack) {
  // Apply invariant on write too, so the persisted pack is always self-consistent
  // regardless of which code path produced it (recompute, background, fallback).
  const safe = applyLifetimeInvariant(pack);
  await v2HomePack(deviceId).set({ ...safe, _server_at: Timestamp.now() }, { merge: true });
}

module.exports = { readHomePack, writeHomePack, applyLifetimeInvariant };
