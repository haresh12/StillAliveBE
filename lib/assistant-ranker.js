'use strict';
// ════════════════════════════════════════════════════════════════════
// assistant-ranker.js — Bayesian-bandit feedback weighting.
// 👍 / 👎 reweights detector priorities for THIS user, persisted across days.
// Floor at 50% original priority; require ≥5 events before any change.
// ════════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');

const userDoc  = (id) => admin.firestore().collection('wellness_users').doc(id);
const wDoc     = (id) => userDoc(id).collection('wellness_meta').doc('feedback_weights');

const MIN_EVENTS = 5;
const FLOOR_RATIO = 0.5;
const CEILING_RATIO = 1.5;

async function recordFeedback(deviceId, { msg_id, category, useful }) {
  if (!deviceId || !msg_id) return;
  const detectorKey = msg_id.split('_').slice(0, 2).join('_'); // approximate detector id
  const upd = useful ? 1 : -1;
  await wDoc(deviceId).set({
    [`detectors.${detectorKey}.score`]: admin.firestore.FieldValue.increment(upd),
    [`detectors.${detectorKey}.events`]: admin.firestore.FieldValue.increment(1),
    [`categories.${category}.score`]: admin.firestore.FieldValue.increment(upd),
    [`categories.${category}.events`]: admin.firestore.FieldValue.increment(1),
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

async function rerankByFeedback(deviceId, candidates) {
  if (!candidates?.length) return candidates;
  const snap = await wDoc(deviceId).get();
  if (!snap.exists) return candidates;
  const data = snap.data() || {};
  const detectors = data.detectors || {};
  const categories = data.categories || {};

  return candidates.map(c => {
    const detKey = c.id.split('_').slice(0, 2).join('_');
    const det = detectors[detKey];
    const cat = categories[c.category];
    let multiplier = 1;
    if (det?.events >= MIN_EVENTS && det.events > 0) {
      const r = det.score / det.events;     // -1..1
      multiplier *= 1 + r * 0.4;            // ±40%
    }
    if (cat?.events >= MIN_EVENTS && cat.events > 0) {
      const r = cat.score / cat.events;
      multiplier *= 1 + r * 0.2;            // ±20% additional
    }
    multiplier = Math.max(FLOOR_RATIO, Math.min(CEILING_RATIO, multiplier));
    return { ...c, priority: Math.round((c.priority || 50) * multiplier) };
  }).sort((a, b) => b.priority - a.priority);
}

module.exports = { recordFeedback, rerankByFeedback };
