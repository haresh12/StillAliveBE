"use strict";
// ================================================================
// FITNESS BODY — bodyweight tracking (with a 7-day MOVING AVERAGE, never raw daily points —
// daily noise causes panic + churn) and a simple goal with progress. bc-namespaced.
//
//   POST /api/fitness/bodyweight        {deviceId, weight_kg, date?}
//   GET  /api/fitness/bodyweight        ?deviceId=&unit=kg|lb  → {series, ma_points, latest, change}
//   POST /api/fitness/goal              {deviceId, goal_type, target_kg?, target_date?, start_kg?}
//   GET  /api/fitness/goal              ?deviceId=&unit=        → {goal, progress}
// ================================================================
const admin = require("firebase-admin");
const { userDoc } = require("./collections");

const fitnessDoc = (id) => userDoc(id).collection("agents").doc("fitness");
const bodyCol = (id) => fitnessDoc(id).collection("fitness_bodyweight");
const ts = () => admin.firestore.FieldValue.serverTimestamp();

const KG_PER_LB = 0.45359237;
const toDisplay = (kg, unit) => (unit === "lb" ? Math.round((kg / KG_PER_LB) * 10) / 10 : Math.round(kg * 10) / 10);
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const today = () => new Date().toISOString().slice(0, 10);

async function logBodyweight(req, res) {
  const { deviceId, weight_kg, date } = req.body || {};
  const w = num(weight_kg);
  if (!deviceId || w == null || w <= 0) return res.status(400).json({ error: "deviceId + weight_kg required" });
  try {
    await bodyCol(deviceId).add({ weight_kg: Math.round(w * 10) / 10, date: date || today(), created_at: ts() });
    return res.json({ success: true });
  } catch (e) {
    (globalThis.log?.error || console.error)("[body] log", e);
    return res.status(500).json({ error: "log failed" });
  }
}

async function getBodyweightTrend(req, res) {
  const { deviceId, unit } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  const u = unit === "lb" ? "lb" : "kg";
  try {
    const snap = await bodyCol(deviceId).orderBy("created_at", "desc").limit(180).get();
    // one entry per date (latest wins), oldest→newest
    const byDate = new Map();
    snap.docs.forEach((d) => { const m = d.data(); if (m.date && !byDate.has(m.date)) byDate.set(m.date, m.weight_kg); });
    const entries = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])); // date asc
    if (!entries.length) return res.json({ series: [], ma_points: [], latest: null, change: null });

    // 7-entry trailing moving average to smooth daily noise.
    const series = entries.map(([d, kg], i) => {
      const from = Math.max(0, i - 6);
      const window = entries.slice(from, i + 1).map(([, k]) => k);
      const ma = window.reduce((s, k) => s + k, 0) / window.length;
      return { date: d, weight: toDisplay(kg, u), ma: toDisplay(ma, u) };
    });
    const ma_points = series.map((s) => s.ma);
    const latest = series[series.length - 1].ma;
    const first = series[0].ma;
    const change = Math.round((latest - first) * 10) / 10;
    return res.json({ series, ma_points, latest, change, unit: u });
  } catch (e) {
    (globalThis.log?.error || console.error)("[body] trend", e);
    return res.status(500).json({ error: "trend failed" });
  }
}

async function setGoal(req, res) {
  const { deviceId, goal_type, target_kg, target_date, start_kg } = req.body || {};
  if (!deviceId || !goal_type) return res.status(400).json({ error: "deviceId + goal_type required" });
  try {
    const goal = {
      goal_type: String(goal_type).slice(0, 40),
      target_kg: num(target_kg),
      target_date: target_date || null,
      start_kg: num(start_kg),
      set_at: new Date().toISOString(),
    };
    await fitnessDoc(deviceId).set({ goal }, { merge: true });
    return res.json({ success: true, goal });
  } catch (e) {
    (globalThis.log?.error || console.error)("[body] setGoal", e);
    return res.status(500).json({ error: "goal failed" });
  }
}

async function getGoal(req, res) {
  const { deviceId, unit } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  const u = unit === "lb" ? "lb" : "kg";
  try {
    const [fSnap, bSnap] = await Promise.all([
      fitnessDoc(deviceId).get(),
      bodyCol(deviceId).orderBy("created_at", "desc").limit(1).get(),
    ]);
    const goal = fSnap.data()?.goal || null;
    const currentKg = bSnap.empty ? null : bSnap.docs[0].data().weight_kg;
    let progress = null;
    if (goal && goal.target_kg != null && goal.start_kg != null && currentKg != null) {
      const total = goal.start_kg - goal.target_kg; // positive for weight loss
      const done = goal.start_kg - currentKg;
      const pct = total !== 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0;
      progress = {
        start: toDisplay(goal.start_kg, u),
        current: toDisplay(currentKg, u),
        target: toDisplay(goal.target_kg, u),
        pct,
        unit: u,
      };
    }
    return res.json({ goal, progress });
  } catch (e) {
    (globalThis.log?.error || console.error)("[body] getGoal", e);
    return res.status(500).json({ error: "goal read failed" });
  }
}

module.exports = { logBodyweight, getBodyweightTrend, setGoal, getGoal };
