/**
 * wellness-combined.bc.agent.js — the Combined (cross-agent) analysis engine for the big-change app.
 *
 * This is the ONLY place allowed to read across agents (cross-agent law). It does NOT produce a score —
 * its job is to show how the user's habits affect EACH OTHER, dynamically, for whichever agents they use.
 * Reads each agent's own bc collection (wellness_bc_users/{id}/agents/*), reduces to a per-day series,
 * then derives: active agents, per-agent consistency, Pearson correlations (gated), momentum, vs-prior,
 * and plain-language connection text. Registration-anchor clamped. Never touches legacy users.
 *
 *   GET /api/wellness-combined?deviceId&range
 */
const express = require("express");
const { resolveAnchor } = require("./lib/user-anchor");
const { computeAnalysisWindow } = require("./lib/range-helpers");
const { userDoc: bcUserDoc } = require("./lib/collections");

const router = express.Router();
const pad = (n) => String(n).padStart(2, "0");
const dateStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (ds, n) => { const [y, m, d] = ds.split("-").map(Number); const dt = new Date(y, m - 1, d + n); return dateStr(dt); };
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

const AGENT_DOC = (id, a) => bcUserDoc(id).collection("agents").doc(a);
const AGENTS = [
  { id: "fitness", label: "Training", emoji: "🏋️", col: "fitness_workouts", date: (d) => d.date_str, value: (d) => clamp(num(d.total_sets || d.sets) * 5 || (num(d.total_volume_kg) ? 60 : 50), 20, 100) },
  { id: "nutrition", label: "Nutrition", emoji: "🥗", col: "food_logs", date: (d) => d.date_str, value: (d, ctx) => clamp(Math.round((num(d.protein || d.p) / (num(ctx && ctx.proteinTarget) || 150)) * 100) || 50, 10, 100) },
  { id: "sleep", label: "Sleep", emoji: "😴", col: "sleep_logs", date: (d) => d.date_str, value: (d) => clamp(Math.round((num(d.sleep_quality || 3) / 5) * 100), 10, 100) },
  { id: "mind", label: "Mood", emoji: "🧠", col: "mind_checkins", date: (d) => d.date_str, value: (d) => clamp(Math.round((num(d.mood_score || 3) / 5) * 100), 10, 100) },
  { id: "water", label: "Hydration", emoji: "💧", col: "water_logs", date: (d) => d.date_str, value: (d) => clamp(Math.round((num(d.ml) / 2500) * 100), 5, 100) },
  // Only ENDED fasts carry a real actual_hours; an in-progress fast has actual_hours=null → skip it so it
  // can't contribute a misleading near-zero value to the day's correlation.
  { id: "fasting", label: "Fasting", emoji: "⏳", col: "fasting_sessions", date: (d) => d.date || (d.started_at_ms ? dateStr(new Date(d.started_at_ms)) : null), skip: (d) => d.actual_hours == null, value: (d) => clamp(Math.round((num(d.actual_hours) / 16) * 100), 5, 100) },
];

// Per-agent { date: {value, logged} } — water/nutrition aggregate multiple logs per day (avg value, logged once).
async function seriesFor(deviceId, agent, startDate, ctx) {
  const out = {};
  try {
    const snap = await AGENT_DOC(deviceId, agent.id).collection(agent.col).orderBy("logged_at", "desc").limit(400).get().catch(() => ({ docs: [] }));
    const buckets = {};
    for (const doc of snap.docs) {
      const d = doc.data(); const ds = agent.date(d);
      if (!ds || ds < startDate) continue;
      if (agent.skip && agent.skip(d)) continue; // e.g. in-progress fasts have no real value yet
      (buckets[ds] = buckets[ds] || []).push(agent.value(d, ctx));
    }
    for (const ds of Object.keys(buckets)) out[ds] = { value: Math.round(mean(buckets[ds])), logged: true };
  } catch { /* agent has no data — fine */ }
  return out;
}

function pearson(xs, ys) {
  const n = xs.length; if (n < 2) return 0;
  const mx = mean(xs), my = mean(ys);
  let num2 = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; num2 += a * b; dx += a * a; dy += b * b; }
  const den = Math.sqrt(dx * dy); return den ? clamp(num2 / den, -1, 1) : 0;
}

// Plain-language connection text (deterministic — explainable, no LLM needed).
function connectionText(A, B, r) {
  const strong = Math.abs(r) >= 0.6;
  const verb = strong ? "strongly" : "tends to";
  if (r > 0) return `On your better ${A.label.toLowerCase()} days, your ${B.label.toLowerCase()} ${strong ? "is clearly better too" : "is usually better too"}.`;
  return `When your ${A.label.toLowerCase()} dips, your ${B.label.toLowerCase()} ${verb} ${strong ? "drop with it" : "slip too"}.`;
}

router.get("/", async (req, res) => {
  const deviceId = req.query.deviceId || req.query.device_id;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  const range = String(req.query.range || "30");
  try {
    const anchor = await resolveAnchor(deviceId);
    const win = computeAnalysisWindow(range, anchor.anchorMs, Date.now(), anchor.utcOffsetMinutes);
    const start = win.effectiveStartDate;
    const today = win.todayDate || dateStr();
    const elapsed = Math.max(1, win.effectiveDays);

    // The nutrition cross-value scales protein against the user's real target (not a hardcoded 150).
    const nutDoc = await AGENT_DOC(deviceId, "nutrition").get().catch(() => null);
    const ctx = { proteinTarget: (nutDoc && nutDoc.exists && num(nutDoc.data().protein_target)) || 150 };
    // Build every agent's series, then keep only ACTIVE agents (≥3 logged days).
    const series = {};
    for (const a of AGENTS) series[a.id] = await seriesFor(deviceId, a, start, ctx);
    const active = AGENTS.filter((a) => Object.keys(series[a.id]).length >= 3);

    if (active.length === 0) {
      return res.json({ ok: true, range, effective_days: elapsed, has_data: false, active_agents: [], days: [], connections: [], momentum: null, balance: [], vs_prior: [], coach_read: [], hero: "Log a few areas and this is where they connect." });
    }

    // Consistency per active agent.
    const active_agents = active.map((a) => {
      const logged = Object.keys(series[a.id]).filter((d) => d >= start && d <= today).length;
      return { id: a.id, label: a.label, emoji: a.emoji, logged_days: logged, consistency: clamp(Math.round((logged / elapsed) * 100), 0, 100) };
    });

    // Calendar: last min(elapsed, 28) days × active agents.
    const span = Math.min(elapsed, 28);
    const days = [];
    for (let i = span - 1; i >= 0; i--) {
      const ds = addDays(today, -i);
      if (ds < start) continue;
      const row = { date: ds, agents: {} };
      for (const a of active) { const e = series[a.id][ds]; row.agents[a.id] = e ? { logged: true, value: e.value } : { logged: false, value: 0 }; }
      days.push(row);
    }

    // Correlations between every active pair (overlapping logged days, n≥7, |r|≥0.3).
    const conns = [];
    for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
      const A = active[i], B = active[j];
      const xs = [], ys = [];
      for (const ds of Object.keys(series[A.id])) { const eb = series[B.id][ds]; if (eb) { xs.push(series[A.id][ds].value); ys.push(eb.value); } }
      if (xs.length < 7) continue;
      const r = pearson(xs, ys);
      if (Math.abs(r) < 0.3) continue;
      conns.push({ a: A.id, b: B.id, a_label: A.label, b_label: B.label, r: Math.round(r * 100) / 100, n: xs.length, strength: Math.abs(r) >= 0.6 ? "strong" : "moderate", text: connectionText(A, B, r) });
    }
    conns.sort((p, q) => Math.abs(q.r) * q.n - Math.abs(p.r) * p.n);
    const strongest = conns[0] || null;
    const connections = conns.slice(1, 4);

    // Momentum — best/worst active agent by recent (last 7) avg value.
    const recentAvg = (a) => { const vals = Object.entries(series[a.id]).filter(([d]) => d > addDays(today, -7)).map(([, e]) => e.value); return vals.length ? mean(vals) : null; };
    const scored = active.map((a) => ({ a, v: recentAvg(a) })).filter((x) => x.v != null).sort((p, q) => q.v - p.v);
    const momentum = scored.length ? {
      best: { id: scored[0].a.id, label: scored[0].a.label, emoji: scored[0].a.emoji, text: `${scored[0].a.label} is your engine right now — the habit carrying the rest.` },
      worst: scored.length > 1 ? { id: scored[scored.length - 1].a.id, label: scored[scored.length - 1].a.label, emoji: scored[scored.length - 1].a.emoji, text: `${scored[scored.length - 1].a.label} is the one slipping — small wins here lift everything.` } : null,
    } : null;

    // Balance — logging consistency per active agent (spot the neglected one).
    const balance = active_agents.map((a) => ({ id: a.id, label: a.label, emoji: a.emoji, pct: a.consistency }));

    // Vs prior week — direction per agent.
    const winAvg = (a, from, to) => { const vals = Object.entries(series[a.id]).filter(([d]) => d > from && d <= to).map(([, e]) => e.value); return vals.length ? mean(vals) : null; };
    const vs_prior = active.map((a) => {
      const cur = winAvg(a, addDays(today, -7), today), prev = winAvg(a, addDays(today, -14), addDays(today, -7));
      if (cur == null || prev == null) return null;
      const delta = Math.round(cur - prev);
      return { id: a.id, label: a.label, emoji: a.emoji, dir: delta > 3 ? "up" : delta < -3 ? "down" : "flat", delta_pct: delta };
    }).filter(Boolean);

    // Coach read — cross-cutting WORKING / FOCUS.
    const coach_read = [];
    if (momentum?.best) coach_read.push({ kind: "champion", text: momentum.best.text });
    if (strongest && strongest.r > 0) coach_read.push({ kind: "champion", text: `Your ${strongest.a_label.toLowerCase()} and ${strongest.b_label.toLowerCase()} are feeding each other — keep both going.` });
    if (momentum?.worst) coach_read.push({ kind: "drag", text: momentum.worst.text });

    // Hero — one plain sentence, no number.
    const upCount = vs_prior.filter((v) => v.dir === "up").length;
    const hero = strongest
      ? `${active.length} areas active. ${strongest.a_label} and ${strongest.b_label} are your strongest link this ${range === "7" ? "week" : "period"}.`
      : `${active.length} areas active — keep logging to surface how they connect.`;

    return res.json({ ok: true, range, effective_days: elapsed, has_data: true, active_agents, days, strongest, connections, momentum, balance, vs_prior, coach_read, hero });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "combined failed" });
  }
});

module.exports = router;
module.exports._test = { pearson, connectionText };
