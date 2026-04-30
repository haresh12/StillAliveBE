'use strict';
// ════════════════════════════════════════════════════════════════════
// notif-engagement.js — tracks delivered/opened/dismissed/acted per push.
// Drives notification timing personalization + fatigue detection.
// ════════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');

const userDoc  = (id) => admin.firestore().collection('wellness_users').doc(id);
const notifDoc = (id) => userDoc(id).collection('wellness_meta').doc('notif_engagement');
const eventCol = (id) => userDoc(id).collection('notif_events');

const FATIGUE_THRESHOLD = 5;   // 5+ ignored in last 14 days = fatigue (Mehrotra 2016)

async function recordEvent(deviceId, { kind, push_id, agent, ts }) {
  if (!['delivered', 'opened', 'dismissed', 'acted'].includes(kind)) return;
  const time = new Date(ts || Date.now());
  const hour = time.getHours();
  await eventCol(deviceId).add({
    kind, push_id: push_id || null, agent: agent || null, hour,
    ts: admin.firestore.Timestamp.fromMillis(time.getTime()),
  });
  // Update aggregate counters
  await notifDoc(deviceId).set({
    [`counts.${kind}`]: admin.firestore.FieldValue.increment(1),
    [`hourly.${hour}.${kind}`]: admin.firestore.FieldValue.increment(1),
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

async function getEngagementContext(deviceId) {
  const snap = await notifDoc(deviceId).get();
  if (!snap.exists) return { has_engagement: false };
  const data = snap.data();
  const counts = data.counts || {};
  const delivered = counts.delivered || 0;
  const opened    = counts.opened    || 0;
  const dismissed = counts.dismissed || 0;
  const acted     = counts.acted     || 0;
  const open_rate = delivered > 0 ? opened / delivered : 0;
  const act_rate  = delivered > 0 ? acted / delivered : 0;

  // Best-engagement hour: hour with the highest open count
  const hourly = data.hourly || {};
  let bestHour = null, bestOpens = 0;
  for (const h in hourly) {
    const o = (hourly[h]?.opened || 0);
    if (o > bestOpens) { bestOpens = o; bestHour = parseInt(h, 10); }
  }

  // Recent fatigue: count dismissals in last 14 days
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 14 * 86400000);
  let recent_dismissals = 0;
  try {
    const recent = await eventCol(deviceId)
      .where('ts', '>=', cutoff).where('kind', '==', 'dismissed')
      .limit(20).get();
    recent_dismissals = recent.size;
  } catch {}

  return {
    has_engagement: true,
    delivered, opened, dismissed, acted,
    open_rate: Math.round(open_rate * 100) / 100,
    act_rate:  Math.round(act_rate * 100) / 100,
    best_hour: bestHour,
    fatigue: recent_dismissals >= FATIGUE_THRESHOLD,
    recent_dismissals,
  };
}

module.exports = { recordEvent, getEngagementContext, FATIGUE_THRESHOLD };
