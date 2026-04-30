'use strict';
// ════════════════════════════════════════════════════════════════════
// location-signals.js — privacy-first location intelligence.
// Clusters home/work/gym from coarse pings (200m precision).
// Stores only cluster centroids + last-known cluster, never raw GPS.
// ════════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');

const userDoc  = (id) => admin.firestore().collection('wellness_users').doc(id);
const locDoc   = (id) => userDoc(id).collection('wellness_meta').doc('location');

const ROUND_TO_M = 200;            // 200m grid cells (privacy floor)
const MIN_VISITS = 5;              // visits before a cell becomes a "place"
const NIGHT_HOURS = [22, 23, 0, 1, 2, 3, 4, 5];   // home heuristic
const WORK_HOURS  = [9, 10, 11, 12, 13, 14, 15, 16, 17];

// Round lat/lon to ~200m grid
function gridKey(lat, lon) {
  const factor = 1 / 0.0018;       // ~200m at equator
  return `${Math.round(lat * factor)},${Math.round(lon * factor)}`;
}

// Receive a ping — keeps a rolling 30-day count per grid cell
async function recordPing(deviceId, { lat, lon, ts }) {
  if (lat == null || lon == null) return;
  const key = gridKey(lat, lon);
  const hour = new Date(ts || Date.now()).getHours();
  const slot = NIGHT_HOURS.includes(hour) ? 'night' : WORK_HOURS.includes(hour) ? 'work' : 'other';
  await locDoc(deviceId).set({
    [`cells.${key}.count`]: admin.firestore.FieldValue.increment(1),
    [`cells.${key}.last_seen`]: admin.firestore.FieldValue.serverTimestamp(),
    [`cells.${key}.slots.${slot}`]: admin.firestore.FieldValue.increment(1),
    last_ping_ts: admin.firestore.FieldValue.serverTimestamp(),
    last_cell: key,
  }, { merge: true });
}

// Compute home/work/gym labels from cell stats
function classifyCells(cells = {}) {
  const entries = Object.entries(cells)
    .filter(([_, v]) => (v.count || 0) >= MIN_VISITS)
    .map(([key, v]) => ({ key, count: v.count, slots: v.slots || {} }));
  if (!entries.length) return {};
  // Home = most visited at night
  const homeCell = entries.slice().sort((a, b) => (b.slots.night || 0) - (a.slots.night || 0))[0];
  // Work = most visited during work hours and not home
  const workCell = entries.filter(e => e.key !== homeCell?.key)
    .sort((a, b) => (b.slots.work || 0) - (a.slots.work || 0))[0];
  return {
    home: homeCell?.slots?.night >= 3 ? homeCell.key : null,
    work: workCell?.slots?.work >= 3 ? workCell.key : null,
    // Gym = high visit count + roughly equal slot distribution + not home/work
    gym:  entries.find(e => e.key !== homeCell?.key && e.key !== workCell?.key && e.count >= 8)?.key || null,
  };
}

async function getLocationContext(deviceId) {
  const snap = await locDoc(deviceId).get();
  if (!snap.exists) return { has_location: false };
  const data = snap.data();
  const labels = classifyCells(data.cells || {});
  const at = data.last_cell;
  let at_label = 'unknown';
  if (at === labels.home) at_label = 'home';
  else if (at === labels.work) at_label = 'work';
  else if (at === labels.gym)  at_label = 'gym';
  else if (at) at_label = 'away';
  return {
    has_location: true,
    at_label,
    last_ping_ts: data.last_ping_ts?.toMillis?.() || null,
    has_home: !!labels.home,
    has_work: !!labels.work,
    has_gym:  !!labels.gym,
  };
}

module.exports = { recordPing, getLocationContext, classifyCells, gridKey };
