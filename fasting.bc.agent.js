"use strict";
// ════════════════════════════════════════════════════════════════════════════
// fasting.bc.agent.js — BIG-CHANGE Fasting backend (chat-first). Mirrors sleep.bc / nutrition.bc.
//   • bc namespace: wellness_bc_users/{id}/agents/fasting/{fasting_sessions}
//   • The ONLY bc agent with a LIVE in-progress session: start → running timer → end (with reason).
//     Routes: /session/start, /session/end, /session/backfill (log a past fast), /today, /analysis.
//   • REUSES lib/agent-scores.computeFastingScore + lib/fasting-analytics.* (namespace-agnostic, operate
//     on plain session arrays) so bc numbers match the legacy brain.
//   • Registration-anchor law (resolveAnchor → computeAnalysisWindow → computeStandardOutputs) on
//     /analysis + /session/backfill. Per-agent sandbox (reads only its own agents/fasting/*).
//   • Mounted at /api/fasting BEFORE the legacy router → bc owns session/today/analysis; legacy falls
//     through for /describe, /chat, /setup, /actions.
// ════════════════════════════════════════════════════════════════════════════
const express = require("express");
const admin = require("firebase-admin");
const { OpenAI } = require("openai");
const { OPENAI_TIMEOUT_MS } = require("./lib/model-router");
const { resolveAnchor } = require("./lib/user-anchor");
const { computeAnalysisWindow } = require("./lib/range-helpers");
const { computeStandardOutputs } = require("./lib/score-lifetime");
const { computeFastingScore } = require("./lib/agent-scores");
const fa = require("./lib/fasting-analytics");
const { userDoc: bcUserDoc } = require("./lib/collections");
const { domainHealth, domainHealthView } = require("./lib/hk-domain"); // Apple Health recovery/activity (null if no HK)
const { maybeFinalizeStale, HARD_MAX_H } = require("./lib/fasting-lifecycle"); // auto-close a forgotten fast (kills the "64h" bug)

const router = express.Router();
const db = () => admin.firestore();
const ts = () => admin.firestore.FieldValue.serverTimestamp();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: OPENAI_TIMEOUT_MS });
const log = globalThis.log || console;

// ── bc collection helpers ─────────────────────────────────────────────────────
const fastingDoc = (id) => bcUserDoc(id).collection("agents").doc("fasting");
const sessionsCol = (id) => fastingDoc(id).collection("fasting_sessions");

// ── helpers ──────────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, "0");
const dateStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const round = (n, dp = 1) => { const p = Math.pow(10, dp); return Math.round((Number(n) || 0) * p) / p; };
const getMillis = (t) => (t && typeof t.toMillis === "function" ? t.toMillis() : typeof t === "number" ? t : t ? new Date(t).getTime() : 0);
const getElapsedHours = (start) => (start ? (Date.now() - getMillis(start)) / 3.6e6 : 0);
const toIso = (t) => { const ms = getMillis(t); return ms ? new Date(ms).toISOString() : null; };

// Metabolic stages (ported from legacy fastingTheme — the science table the timer/Live Activity show).
const METABOLIC_STAGES = [
  { id: "fed", hours: [0, 4], label: "Fed", short: "Fed" },
  { id: "post_absorptive", hours: [4, 8], label: "Post-Absorptive", short: "Post-absorb" },
  { id: "glycogen", hours: [8, 12], label: "Glycogen Burning", short: "Glycogen" },
  { id: "fat_burning", hours: [12, 16], label: "Fat Burning", short: "Fat burn" },
  { id: "ketosis_entry", hours: [16, 18], label: "Ketosis Entry", short: "Ketosis" },
  { id: "autophagy", hours: [18, 24], label: "Autophagy", short: "Autophagy" },
  { id: "deep_fast", hours: [24, 72], label: "Deep Fast", short: "Deep fast" },
];
const getStage = (h = 0) => METABOLIC_STAGES.find((s) => h >= s.hours[0] && h < s.hours[1]) || METABOLIC_STAGES[METABOLIC_STAGES.length - 1];

const mapSession = (d) => { const s = d.data() || {}; return { id: d.id, ...s, started_at_ms: getMillis(s.started_at), ended_at_ms: getMillis(s.ended_at) }; };
const getTarget = (data) => num(data?.setup?.target_fast_hours ?? data?.target_fast_hours, 16);

// Add days to a YYYY-MM-DD string (local, no TZ math needed — dates only).
const addDays = (ds, n) => { const [y, m, d] = ds.split("-").map(Number); const dt = new Date(y, m - 1, d + n); return dateStr(dt); };
const clampInt = (v, lo, hi, d) => { const n = Math.round(num(v, d)); return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : d)); };
// Shape a stored plan for the client. Returns null when there's no active/in-range plan.
function mapPlan(p, todayKey) {
  if (!p || !p.active) return null;
  if (p.end_date && todayKey > p.end_date) return null; // plan has elapsed — treat as inactive
  const sh = clampInt(p.start_hh, 0, 23, 20), sm = clampInt(p.start_mm, 0, 59, 0);
  const th = num(p.target_hours, 16);
  // Eating window opens start_time + target_hours (wraps past midnight).
  const openTotal = (sh * 60 + sm + Math.round(th * 60)) % (24 * 60);
  return {
    active: true,
    protocol: p.protocol || "16:8",
    target_hours: th,
    start_hh: sh, start_mm: sm,
    eat_open_hh: Math.floor(openTotal / 60), eat_open_mm: openTotal % 60,
    duration_days: num(p.duration_days, 30),
    cadence: p.cadence || "daily",
    days: Array.isArray(p.days) && p.days.length ? p.days : [0, 1, 2, 3, 4, 5, 6],
    start_date: p.start_date || null,
    end_date: p.end_date || null,
    days_left: p.end_date ? Math.max(0, (new Date(p.end_date) - new Date(todayKey)) / 864e5) : null,
  };
}

// Streak/stats from the most-recent-first mapped session list. Walks days in the user's LOCAL timezone
// (session `date` is user-local) — bare UTC would break the streak at the day boundary off-UTC.
function computeStats(sessions, tz = 0) {
  const { dateStr: tzDateStr } = require("./lib/range-helpers");
  const ended = sessions.filter((s) => s.ended_at_ms);
  const completedDates = new Set(ended.filter((s) => s.completed).map((s) => s.date || tzDateStr(new Date(s.started_at_ms), tz)));
  // current streak: consecutive days (ending today or yesterday) with a completed fast.
  let streak = 0;
  const d = new Date();
  if (!completedDates.has(tzDateStr(d, tz))) d.setDate(d.getDate() - 1); // allow streak to end yesterday
  while (completedDates.has(tzDateStr(d, tz))) { streak += 1; d.setDate(d.getDate() - 1); }
  const weekAgo = Date.now() - 7 * 864e5;
  const last7 = ended.filter((s) => s.started_at_ms >= weekAgo);
  const done7 = last7.filter((s) => s.completed);
  return {
    current_streak: streak,
    completion_rate_7d: last7.length ? Math.round((done7.length / last7.length) * 100) : 0,
    avg_fast_hours_7d: last7.length ? round(last7.reduce((a, s) => a + num(s.actual_hours), 0) / last7.length, 1) : 0,
    total_completed: ended.filter((s) => s.completed).length,
  };
}

// ── POST /session/start — begin a fast ────────────────────────────────────────
router.post("/session/start", async (req, res) => {
  const b = req.body || {};
  const { deviceId } = b;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const [fSnap, anchor] = await Promise.all([fastingDoc(deviceId).get(), resolveAnchor(deviceId)]);
    const tzOff = anchor.utcOffsetMinutes || 0;
    const data = fSnap.exists ? fSnap.data() : {};
    // Per-fast goal override (protocol picker). Falls back to the onboarding default.
    // Clamp to a sane fasting range so a bad client can't write a 0h or 500h "fast".
    const reqHours = num(b.target_hours, 0);
    const target = reqHours >= 4 && reqHours <= 72 ? round(reqHours, 1) : getTarget(data);
    const protocol = typeof b.protocol === "string" && b.protocol.length <= 12 ? b.protocol : data.protocol || "16:8";

    // Close any stale active session first (so there's never two running).
    if (data.active_session_id) {
      const staleRef = sessionsCol(deviceId).doc(data.active_session_id);
      const stale = await staleRef.get();
      if (stale.exists && stale.data().ended_at == null) {
        const elapsed = getElapsedHours(stale.data().started_at);
        const t = num(stale.data().target_hours, target);
        await staleRef.update({ ended_at: ts(), actual_hours: round(elapsed, 2), completed: elapsed >= t, broken_early: elapsed < t, broken_reason: "new_session", metabolic_stage_reached: getStage(elapsed).id });
      }
    }

    // Optional backdated start (≤ 23h, not future). Use a CONCRETE server-clock Timestamp (not the
    // serverTimestamp() sentinel) so the response can return a real ISO start time — a sentinel has no
    // .toMillis(), so toIso() would return null and the FE could never render the running timer.
    let startedAt = admin.firestore.Timestamp.now();
    if (b.started_at) {
      const ms = new Date(b.started_at).getTime();
      if (!Number.isFinite(ms)) return res.status(400).json({ error: "invalid started_at" });
      const now = Date.now();
      if (ms > now + 60000) return res.status(400).json({ error: "started_at cannot be in the future" });
      if (now - ms > 23 * 3.6e6) return res.status(400).json({ error: "started_at too far in the past" });
      startedAt = admin.firestore.Timestamp.fromMillis(ms);
    }

    const ref = sessionsCol(deviceId).doc();
    const session = {
      started_at: startedAt,
      ended_at: null,
      target_hours: target,
      actual_hours: null,
      completed: false,
      broken_early: false,
      broken_reason: null,
      metabolic_stage_reached: "fed",
      protocol,
      notes: typeof b.notes === "string" ? b.notes.slice(0, 300) : "",
      // Session date = the user-LOCAL day the fast started, clamped to the registration anchor (never
      // before signup, never future) so streak/lifetime math can't be poisoned by a pre-anchor date.
      date: (() => {
        const dStr = require("./lib/range-helpers").dateStr(startedAt.toDate(), tzOff);
        return anchor.anchorDateStr && dStr < anchor.anchorDateStr ? anchor.anchorDateStr : dStr;
      })(),
      created_at: ts(),
    };
    const batch = db().batch();
    batch.set(ref, session);
    batch.set(fastingDoc(deviceId), { active_session_id: ref.id, active_last_seen_ms: Date.now(), protocol, target_fast_hours: target, updated_at: ts() }, { merge: true });
    await batch.commit();

    return res.json({ success: true, session_id: ref.id, started_at: toIso(startedAt), target_hours: target, protocol });
  } catch (e) {
    log.error("[fasting.bc] /session/start:", e?.message || e);
    return res.status(500).json({ error: "server error" });
  }
});

// ── POST /session/adjust-start — fix the start time of the RUNNING fast ────────
// The #1 missing feature in rival apps: "I forgot to hit start 2h ago." Lets the user nudge the
// active fast's start earlier/later. Clamped: not future, not > 47h ago (deep-fast ceiling).
router.post("/session/adjust-start", async (req, res) => {
  const b = req.body || {};
  const { deviceId } = b;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const fSnap = await fastingDoc(deviceId).get();
    const data = fSnap.exists ? fSnap.data() : {};
    if (!data.active_session_id) return res.status(409).json({ error: "no active fast" });
    const ms = new Date(b.started_at).getTime();
    if (!Number.isFinite(ms)) return res.status(400).json({ error: "invalid started_at" });
    const now = Date.now();
    if (ms > now + 60000) return res.status(400).json({ error: "started_at cannot be in the future" });
    if (now - ms > 47 * 3.6e6) return res.status(400).json({ error: "started_at too far in the past" });
    const ref = sessionsCol(deviceId).doc(data.active_session_id);
    const snap = await ref.get();
    if (!snap.exists || snap.data().ended_at != null) return res.status(409).json({ error: "no active fast" });
    await ref.update({ started_at: admin.firestore.Timestamp.fromMillis(ms), date: dateStr(new Date(ms)), updated_at: ts() });
    return res.json({ success: true, started_at: new Date(ms).toISOString(), target_hours: num(snap.data().target_hours, getTarget(data)) });
  } catch (e) {
    log.error("[fasting.bc] /session/adjust-start:", e?.message || e);
    return res.status(500).json({ error: "server error" });
  }
});

// ── POST /session/water — log a glass of water during the RUNNING fast ─────────
// Hydration is the #1 thing to nail during a fast (rivals nag about it). This is the fasting agent's
// OWN counter on the active session — NOT the Water agent (per-agent sandbox holds).
router.post("/session/water", async (req, res) => {
  const b = req.body || {};
  const { deviceId } = b;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const fSnap = await fastingDoc(deviceId).get();
    const data = fSnap.exists ? fSnap.data() : {};
    if (!data.active_session_id) return res.status(409).json({ error: "no active fast" });
    const ref = sessionsCol(deviceId).doc(data.active_session_id);
    const snap = await ref.get();
    if (!snap.exists || snap.data().ended_at != null) return res.status(409).json({ error: "no active fast" });
    const cur = num(snap.data().water_glasses, 0);
    const next = Math.max(0, Math.min(40, cur + clampInt(b.delta, -1, 1, 1)));
    await ref.update({ water_glasses: next, updated_at: ts() });
    return res.json({ success: true, water_glasses: next });
  } catch (e) {
    log.error("[fasting.bc] /session/water:", e?.message || e);
    return res.status(500).json({ error: "server error" });
  }
});

// ── POST /plan/set — create/update a recurring fasting plan (the schedule) ─────
// A plan = "fast Xh daily, starting HH:MM, for N days." It drives the default goal the timer/chat
// pre-fill and the local reminders the client schedules (prep / start / eating-window-open). The
// user can update it anytime (new hours, new time) — that's just another /plan/set. Cap 90 days.
router.post("/plan/set", async (req, res) => {
  const b = req.body || {};
  const { deviceId } = b;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const target_hours = (() => { const n = num(b.target_hours, 16); return n >= 4 && n <= 48 ? round(n, 1) : 16; })();
    const start_hh = clampInt(b.start_hh, 0, 23, 20);
    const start_mm = clampInt(b.start_mm, 0, 59, 0);
    const duration_days = clampInt(b.duration_days, 1, 90, 30); // cap at 3 months
    const protocol = typeof b.protocol === "string" && b.protocol.length <= 12 ? b.protocol : "16:8";
    // Cadence — which weekdays the plan runs (0=Sun..6=Sat). Drives which days get reminders.
    const cadence = ["daily", "weekdays", "weekends", "custom"].includes(b.cadence) ? b.cadence : "daily";
    const days = cadence === "weekdays" ? [1, 2, 3, 4, 5]
      : cadence === "weekends" ? [0, 6]
      : cadence === "custom" && Array.isArray(b.days) && b.days.length ? [...new Set(b.days.map(Number).filter((d) => d >= 0 && d <= 6))]
      : [0, 1, 2, 3, 4, 5, 6];
    const start_date = dateStr();
    const end_date = addDays(start_date, duration_days - 1);
    const plan = { active: true, protocol, target_hours, start_hh, start_mm, duration_days, cadence, days, start_date, end_date, updated_at: ts() };
    await fastingDoc(deviceId).set({ plan, target_fast_hours: target_hours, protocol, updated_at: ts() }, { merge: true });
    return res.json({ success: true, plan: mapPlan(plan, start_date) });
  } catch (e) {
    log.error("[fasting.bc] /plan/set:", e?.message || e);
    return res.status(500).json({ error: "server error" });
  }
});

// ── POST /plan/cancel — stop the recurring plan (keeps history + setup default) ─
router.post("/plan/cancel", async (req, res) => {
  const b = req.body || {};
  const { deviceId } = b;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    await fastingDoc(deviceId).set({ plan: { active: false, updated_at: ts() }, updated_at: ts() }, { merge: true });
    return res.json({ success: true });
  } catch (e) {
    log.error("[fasting.bc] /plan/cancel:", e?.message || e);
    return res.status(500).json({ error: "server error" });
  }
});

// ── POST /session/end — complete or break the active fast (with reason) ───────
router.post("/session/end", async (req, res) => {
  const b = req.body || {};
  const { deviceId, broken_reason } = b;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const [fSnap, anchor] = await Promise.all([fastingDoc(deviceId).get(), resolveAnchor(deviceId)]);
    const tzOff = anchor.utcOffsetMinutes || 0;
    const data = fSnap.exists ? fSnap.data() : {};
    const target = getTarget(data);
    const sessId = b.session_id || data.active_session_id;
    if (!sessId) return res.status(400).json({ error: "no_active_session" });

    const ref = sessionsCol(deviceId).doc(sessId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "session_not_found" });
    const sess = snap.data();
    if (sess.ended_at != null) {
      return res.json({ success: true, already_ended: true, current_streak: num(data.current_streak), actual_hours: num(sess.actual_hours), stage_reached: sess.metabolic_stage_reached });
    }

    const rawElapsed = getElapsedHours(sess.started_at);
    const t = num(sess.target_hours, target);
    // Trust a present user's manual end — EXCEPT a clearly-forgotten runaway fast (elapsed far
    // past target, or over the absolute ceiling). Recording 64h would poison streaks/averages,
    // so credit the target and end it at the target time instead.
    const isRunaway = rawElapsed > t + 24 || rawElapsed >= HARD_MAX_H;
    const elapsed = isRunaway ? t : rawElapsed;
    const completed = isRunaway ? true : !broken_reason && elapsed >= t;
    const stage = getStage(elapsed);

    await ref.update({
      ended_at: isRunaway ? admin.firestore.Timestamp.fromMillis(Math.round(getMillis(sess.started_at) + t * 3.6e6)) : ts(),
      actual_hours: round(elapsed, 2),
      completed,
      broken_early: !completed,
      broken_reason: isRunaway ? null : broken_reason || null,
      metabolic_stage_reached: stage.id,
      notes: typeof b.notes === "string" ? b.notes.slice(0, 300) : sess.notes || "",
      ...(isRunaway ? { auto_closed: true } : {}),
    });

    // Recompute stats from the recent sessions.
    const recent = (await sessionsCol(deviceId).orderBy("started_at", "desc").limit(120).get()).docs.map(mapSession);
    const stats = computeStats(recent, tzOff);
    const longest = Math.max(num(data.longest_streak), stats.current_streak);
    // Milestones (motivation): a new longest-ever fast, or a new best streak.
    const prevLongestFast = num(data.longest_fast, 0);
    const isPersonalBest = elapsed > prevLongestFast && elapsed >= 1;
    const newLongestFast = Math.max(prevLongestFast, round(elapsed, 2));
    const newStreakRecord = stats.current_streak > num(data.longest_streak, 0) && stats.current_streak >= 2;
    await fastingDoc(deviceId).update({
      active_session_id: null,
      current_streak: stats.current_streak,
      longest_streak: longest,
      longest_fast: newLongestFast,
      total_sessions_completed: stats.total_completed,
      completion_rate_7d: stats.completion_rate_7d,
      avg_fast_hours_7d: stats.avg_fast_hours_7d,
      last_session_date: require("./lib/range-helpers").dateStr(new Date(), tzOff),
      updated_at: ts(),
    });

    return res.json({
      success: true,
      completed,
      actual_hours: round(elapsed, 2),
      target_hours: t,
      stage_reached: stage.id,
      stage_label: stage.label,
      current_streak: stats.current_streak,
      broken_early: !completed,
      is_personal_best: isPersonalBest,
      longest_fast: newLongestFast,
      new_streak_record: newStreakRecord,
    });
  } catch (e) {
    log.error("[fasting.bc] /session/end:", e?.message || e);
    return res.status(500).json({ error: "server error" });
  }
});

// ── POST /session/backfill — log a PAST fast (anchor-clamped) ─────────────────
router.post("/session/backfill", async (req, res) => {
  const b = req.body || {};
  const { deviceId, started_at, ended_at } = b;
  if (!deviceId || !started_at || !ended_at) return res.status(400).json({ error: "deviceId, started_at, ended_at required" });
  try {
    const startMs = new Date(started_at).getTime();
    const endMs = new Date(ended_at).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return res.status(400).json({ error: "invalid times" });
    const hours = (endMs - startMs) / 3.6e6;
    if (hours > 48) return res.status(400).json({ error: "fast too long (max 48h)" });

    const anchor = await resolveAnchor(deviceId);
    let date = dateStr(new Date(startMs));
    if (anchor.anchorDateStr && date < anchor.anchorDateStr) date = anchor.anchorDateStr; // never before signup
    try { date = require("./lib/log-guard").assertLoggableDate(date, anchor); }
    catch (e) { return require("./lib/log-guard").sendLogGuardError(res, e); }

    const fSnap = await fastingDoc(deviceId).get();
    const target = getTarget(fSnap.exists ? fSnap.data() : {});
    const completed = !b.broken_reason && hours >= target;
    const stage = getStage(hours);

    const ref = sessionsCol(deviceId).doc();
    await ref.set({
      started_at: admin.firestore.Timestamp.fromMillis(startMs),
      ended_at: admin.firestore.Timestamp.fromMillis(endMs),
      target_hours: target,
      actual_hours: round(hours, 2),
      completed,
      broken_early: !completed,
      broken_reason: b.broken_reason || null,
      metabolic_stage_reached: stage.id,
      notes: typeof b.notes === "string" ? b.notes.slice(0, 300) : "",
      date,
      created_at: ts(),
      backfilled: true,
    });

    const recent = (await sessionsCol(deviceId).orderBy("started_at", "desc").limit(120).get()).docs.map(mapSession);
    const stats = computeStats(recent, anchor.utcOffsetMinutes || 0);
    await fastingDoc(deviceId).set({ current_streak: stats.current_streak, longest_streak: Math.max(num((fSnap.data() || {}).longest_streak), stats.current_streak), total_sessions_completed: stats.total_completed, completion_rate_7d: stats.completion_rate_7d, avg_fast_hours_7d: stats.avg_fast_hours_7d, updated_at: ts() }, { merge: true });

    return res.json({ success: true, id: ref.id, actual_hours: round(hours, 2), completed, stage_reached: stage.id });
  } catch (e) {
    log.error("[fasting.bc] /session/backfill:", e?.message || e);
    return res.status(500).json({ error: "server error" });
  }
});

// ── POST /session/adjust-hours — correct the recorded length of a FINISHED fast ─
// The "modify option" for an auto-closed (forgotten) fast: we credited the target, but the
// user may have actually fasted longer (or broken earlier). Lets them set the true hours;
// we recompute ended_at, stage, completed + rollups. Clamped 0–72h. Only for ended sessions.
router.post("/session/adjust-hours", async (req, res) => {
  const b = req.body || {};
  const { deviceId } = b;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const [fSnap, anchor] = await Promise.all([fastingDoc(deviceId).get(), resolveAnchor(deviceId)]);
    const tzOff = anchor.utcOffsetMinutes || 0;
    const data = fSnap.exists ? fSnap.data() : {};
    const sessId = b.session_id;
    if (!sessId) return res.status(400).json({ error: "session_id required" });
    const hours = num(b.actual_hours, NaN);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 72) return res.status(400).json({ error: "actual_hours must be 0–72" });

    const ref = sessionsCol(deviceId).doc(sessId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "session_not_found" });
    const sess = snap.data();
    if (sess.ended_at == null) return res.status(409).json({ error: "session_still_running" });

    const startMs = getMillis(sess.started_at);
    const t = num(sess.target_hours, getTarget(data));
    const completed = hours >= t;
    const stage = getStage(hours);
    await ref.update({
      actual_hours: round(hours, 2),
      ended_at: admin.firestore.Timestamp.fromMillis(Math.round(startMs + hours * 3.6e6)),
      completed,
      broken_early: !completed,
      broken_reason: completed ? null : sess.broken_reason || "adjusted",
      metabolic_stage_reached: stage.id,
      auto_closed: false, // the user has confirmed the real length — it's no longer an unverified auto-close
      hours_adjusted: true,
      updated_at: ts(),
    });

    const recent = (await sessionsCol(deviceId).orderBy("started_at", "desc").limit(120).get()).docs.map(mapSession);
    const stats = computeStats(recent, tzOff);
    await fastingDoc(deviceId).update({
      current_streak: stats.current_streak,
      longest_streak: Math.max(num(data.longest_streak), stats.current_streak),
      longest_fast: Math.max(num(data.longest_fast, 0), round(hours, 2)),
      total_sessions_completed: stats.total_completed,
      completion_rate_7d: stats.completion_rate_7d,
      avg_fast_hours_7d: stats.avg_fast_hours_7d,
      updated_at: ts(),
    });

    return res.json({ success: true, actual_hours: round(hours, 2), completed, stage_reached: stage.id, stage_label: stage.label, current_streak: stats.current_streak });
  } catch (e) {
    log.error("[fasting.bc] /session/adjust-hours:", e?.message || e);
    return res.status(500).json({ error: "server error" });
  }
});

// ── GET /today — active session + today + week + streak + targets ─────────────
router.get("/today", async (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const [fSnap, anchor] = await Promise.all([
      fastingDoc(deviceId).get(),
      resolveAnchor(deviceId),
    ]);
    const data = fSnap.exists ? fSnap.data() : {};
    const off0 = anchor?.utcOffsetMinutes || 0;

    // Kill the "64h fast" the instant the app re-opens: if the running fast was abandoned
    // (past target + no heartbeat for hours), finalize it at the target BEFORE building the
    // payload. The FE reads `just_auto_closed` and shows a completion summary + "adjust
    // hours" instead of a runaway timer. maybeFinalizeStale reads the OLD heartbeat, so the
    // decision is made before we stamp a fresh one below.
    let just_auto_closed = null;
    try {
      just_auto_closed = await maybeFinalizeStale(deviceId, { tzOff: off0, agentData: data });
      if (just_auto_closed) data.active_session_id = null; // no longer running
    } catch (e) { log.error("[fasting.bc] /today auto-close:", e?.message || e); }

    const recentSnap = await sessionsCol(deviceId).orderBy("started_at", "desc").limit(40).get().catch(() => ({ docs: [] }));
    const target = getTarget(data);
    const recent = recentSnap.docs.map(mapSession);

    let active_session = null;
    if (data.active_session_id) {
      const a = recent.find((s) => s.id === data.active_session_id && s.ended_at_ms === 0);
      if (a) {
        const elapsed = getElapsedHours(a.started_at);
        const tgt = num(a.target_hours, target);
        active_session = { id: a.id, started_at: toIso(a.started_at), started_at_ms: a.started_at_ms, target_hours: tgt, elapsed_hours: round(elapsed, 2), over_target: elapsed >= tgt, overtime_hours: round(Math.max(0, elapsed - tgt), 2), stage: getStage(elapsed).id, stage_label: getStage(elapsed).label, water_glasses: num(a.water_glasses, 0) };
        // Heartbeat: mark that the app is watching this fast RIGHT NOW so it can't be
        // mistaken for abandoned by the next stale-check (lazy or cron). Fire-and-forget.
        fastingDoc(deviceId).set({ active_last_seen_ms: Date.now(), updated_at: ts() }, { merge: true }).catch(() => {});
      }
    }

    // "Today" in the user's LOCAL day (sessions store the user-local `date`) — bare UTC dateStr()
    // showed the wrong day off-UTC.
    const { dateStr: tzDateStr } = require("./lib/range-helpers");
    const off = anchor?.utcOffsetMinutes || 0;
    const todayKey = tzDateStr(new Date(), off);
    const todays = recent.filter((s) => (s.date || tzDateStr(new Date(s.started_at_ms), off)) === todayKey);
    const todayCompleted = todays.some((s) => s.completed);
    const stats = computeStats(recent, off);
    const ended = recent.filter((s) => s.ended_at_ms);
    const weekAgo = Date.now() - 7 * 864e5;
    const week = ended.filter((s) => s.started_at_ms >= weekAgo);

    // 28-day strip for the Today calendar.
    const date_logs = {};
    for (const s of recent) {
      if (!s.ended_at_ms) continue;
      const key = s.date || dateStr(new Date(s.started_at_ms));
      const ex = date_logs[key];
      if (!ex || (s.completed && !ex.completed) || num(s.actual_hours) > ex.hours) date_logs[key] = { completed: !!s.completed, hours: round(num(s.actual_hours), 1) };
    }

    const plan = mapPlan(data.plan, todayKey);
    // An active plan drives the default goal + protocol the timer/chat pre-fill.
    const planTarget = plan ? plan.target_hours : target;
    const planProtocol = plan ? plan.protocol : data?.setup?.protocol || "16:8";

    // Today's session status — so the UI can say "in progress" / "completed" / "ended early" instead of
    // showing a misleading bare duration (or wrongly "no fast yet" after a fast was ended early today).
    const todayCompletedSession = todays.find((s) => s.completed) || null;
    const todayEndedSession = todays
      .filter((s) => s.ended_at_ms)
      .sort((a, b) => num(b.ended_at_ms) - num(a.ended_at_ms))[0] || null;
    const today_session = active_session
      ? { status: "ongoing", hours: active_session.elapsed_hours, target_hours: active_session.target_hours }
      : todayCompletedSession
      ? { status: "completed", hours: round(num(todayCompletedSession.actual_hours), 1), target_hours: num(todayCompletedSession.target_hours, planTarget) }
      : todayEndedSession
      ? { status: "ended_early", hours: round(num(todayEndedSession.actual_hours), 1), target_hours: num(todayEndedSession.target_hours, planTarget) }
      : { status: "none" };

    return res.json({
      health_view: await domainHealthView(deviceId, 'fasting', 7).catch(() => null), // Apple Health Body Signals (today tiles)
      date: todayKey,
      active_session,
      just_auto_closed, // set when /today auto-finalized a forgotten fast this call (FE shows summary + "adjust hours")
      today_session,
      today_completed: todayCompleted,
      week: { fasts: week.length, completed: week.filter((s) => s.completed).length, avg_hours: week.length ? round(week.reduce((a, s) => a + num(s.actual_hours), 0) / week.length, 1) : 0 },
      date_logs,
      current_streak: stats.current_streak,
      longest_streak: num(data.longest_streak),
      plan,
      targets: { target_fast_hours: planTarget, protocol: planProtocol },
    });
  } catch (e) {
    log.error("[fasting.bc] /today:", e?.message || e);
    return res.status(500).json({ error: "server error" });
  }
});

// ── GET /analysis — full Insights payload (reuses score + fasting-analytics) ──
router.get("/analysis", async (req, res) => {
  try {
    const { deviceId, range } = req.query;
    if (!deviceId) return res.status(400).json({ error: "deviceId required" });
    const days = (() => { const n = parseInt(range, 10); return Number.isFinite(n) && n > 0 && n <= 730 ? n : null; })();

    const fSnap = await fastingDoc(deviceId).get();
    const data = fSnap.exists ? fSnap.data() : {};
    const setup = data.setup || {};
    const target = getTarget(data);

    const anchor = await resolveAnchor(deviceId);
    const win = computeAnalysisWindow(days || 30, anchor.anchorMs, Date.now(), anchor.utcOffsetMinutes);
    // Always a NUMBER (default 30-day window) so effective_days / elapsed_days never falls to null —
    // matches the other agents. (Was null when the range param was omitted, which pushed the score onto
    // the legacy d/14 denominator for day-1 users.)
    const effectiveDays = win.effectiveDays;

    const allSnap = await sessionsCol(deviceId).orderBy("started_at", "desc").limit(400).get();
    let all = allSnap.docs.map(mapSession).filter((s) => s.ended_at_ms); // only finished fasts count
    // clamp to the registration-anchor window (never count pre-registration nights)
    const startKey = win.effectiveStartDate;
    const sessions = all.filter((s) => {
      const ds = s.date || dateStr(new Date(s.started_at_ms));
      return (!startKey || ds >= startKey) && (!anchor.anchorDateStr || ds >= anchor.anchorDateStr);
    });

    const completedSess = sessions.filter((s) => s.completed);
    const daysLogged = new Set(sessions.map((s) => s.date || dateStr(new Date(s.started_at_ms)))).size;
    const completionRate = sessions.length ? completedSess.length / sessions.length : null;
    const avgHours = sessions.length ? sessions.reduce((a, s) => a + num(s.actual_hours), 0) / sessions.length : 0;
    const pctFatBurn = sessions.length ? sessions.filter((s) => num(s.actual_hours) >= 12).length / sessions.length : 0;
    const pctKetosis = sessions.length ? sessions.filter((s) => num(s.actual_hours) >= 16).length / sessions.length : 0;
    const stats7 = computeStats(all, anchor.utcOffsetMinutes || 0);

    const fastingScore = computeFastingScore({
      completion_rate: completionRate,
      completion_rate_7d: stats7.completion_rate_7d / 100,
      streak: stats7.current_streak,
      avg_hours: avgHours,
      avg_hours_7d: stats7.avg_fast_hours_7d,
      target_hours: target,
      pct_reaching_fat_burn: pctFatBurn,
      pct_reaching_ketosis: pctKetosis,
      days_logged: daysLogged,
      elapsed_days: effectiveDays,
    }) || { score: 0, label: "Begin", components: {} };

    // Reused analytics (pure functions on session arrays). LLM reads are best-effort.
    const efh = (() => { try { return fa.computeEFH(sessions); } catch { return null; } })();
    const circadian = (() => { try { return fa.computeCircadian(sessions); } catch { return null; } })();
    const dow = (() => { try { return fa.computeDayOfWeek(sessions); } catch { return null; } })();
    // computeAhaMoments returns {type, title, body}. The FE reads `label` (category) + optional `kpi`.
    // Map type→label here so the "What stands out" sheet shows the real category, not a fallback.
    const aha_moments = (() => {
      try {
        return (fa.computeAhaMoments(sessions, setup, fastingScore) || []).map((m) => ({
          ...m,
          label: m.label || (m.type ? m.type.charAt(0).toUpperCase() + m.type.slice(1) : "Pattern"),
        }));
      } catch { return []; }
    })();
    const score_grade = (() => {
      try {
        const letter = fa.scoreGrade(num(fastingScore.score));
        const sc = num(fastingScore.score);
        const band = sc >= 82 ? "Dialed in" : sc >= 67 ? "Consistent" : sc >= 50 ? "Building" : sc >= 40 ? "Getting started" : "Just begun";
        return { letter, band };
      } catch { return { letter: "—", band: "" }; }
    })();
    // generateAiReads returns {champion, drag, pattern} (each {title, body} | null). The FE expects a
    // FLAT array of {kind, title, body}. Transform it here so the contract matches (was crashing the FE).
    let ai_reads = [];
    try {
      const aiObj = (await fa.generateAiReads(sessions, setup, { days: effectiveDays }, fastingScore, openai)) || {};
      ai_reads = [
        aiObj.champion ? { kind: "champion", ...aiObj.champion } : null,
        aiObj.drag ? { kind: "drag", ...aiObj.drag } : null,
        aiObj.pattern ? { kind: "pattern", ...aiObj.pattern } : null,
      ].filter(Boolean);
    } catch { ai_reads = []; }

    // Per-fast signal + daily heatmap.
    const signal_points = sessions.slice().sort((a, b) => a.started_at_ms - b.started_at_ms).map((s) => ({ date: s.date || dateStr(new Date(s.started_at_ms)), hours: round(num(s.actual_hours), 1), completed: !!s.completed, stage: s.metabolic_stage_reached || getStage(num(s.actual_hours)).id }));
    const daily_logs = {};
    for (const s of sessions) { const ds = s.date || dateStr(new Date(s.started_at_ms)); const ex = daily_logs[ds]; if (!ex || (s.completed && !ex.completed) || num(s.actual_hours) > ex.hours) daily_logs[ds] = { has_log: true, completed: !!s.completed, hours: round(num(s.actual_hours), 1) }; }
    const stage_breakdown = METABOLIC_STAGES.map((st) => ({ stage: st.id, label: st.label, count: sessions.filter((s) => num(s.actual_hours) >= st.hours[0] && num(s.actual_hours) < st.hours[1]).length }));
    const bestFast = sessions.reduce((b, s) => (num(s.actual_hours) > num(b?.actual_hours) ? s : b), null);
    // Completion split + WHY fasts broke early (the user wants this front-and-center).
    const completedCount = sessions.filter((s) => s.completed).length;
    const brokeSessions = sessions.filter((s) => s.ended_at_ms && !s.completed);
    const breakCounts = {};
    for (const s of brokeSessions) { const r = s.broken_reason || "other"; if (r === "new_session") continue; breakCounts[r] = (breakCounts[r] || 0) + 1; }
    const break_reasons = Object.entries(breakCounts).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
    const deepest_stage = bestFast ? getStage(num(bestFast.actual_hours)) : null;

    // Lifetime score outputs (anchor-clamped), keyed by completion quality per day.
    const qualityByDate = {};
    for (const s of all) { const ds = s.date || dateStr(new Date(s.started_at_ms)); if (anchor.anchorDateStr && ds < anchor.anchorDateStr) continue; const q = s.completed ? 100 : Math.round(Math.min(100, (num(s.actual_hours) / Math.max(1, target)) * 100)); if (!qualityByDate[ds] || q > qualityByDate[ds]) qualityByDate[ds] = q; }
    const std = computeStandardOutputs({ qualityByDate, todayDate: win.todayDate, anchorDate: anchor.anchorDateStr, daysSinceAnchor: win.daysSinceAnchor });

    res.set("Cache-Control", "private, max-age=60");
    // Fire both Apple Health reads concurrently (kicked off before either await) — halves HK latency.
    const _hkP = domainHealth(deviceId, 'fasting').catch(() => null);
    const _hkViewP = domainHealthView(deviceId, 'fasting', win.requestedDays).catch(() => null);
    return res.json({
      health: await _hkP,
      health_view: await _hkViewP, // Apple Health recovery/activity
      range: days || 30,
      period_days: effectiveDays,
      target_hours: target,
      protocol: setup.protocol || "16:8",
      fasting_score: fastingScore,
      score_grade,
      hero_insight: aha_moments[0] ? { headline: aha_moments[0].body || aha_moments[0].label } : null,
      stats: {
        fasts_logged: sessions.length,
        completed: completedSess.length,
        completion_rate: Math.round((completionRate || 0) * 100),
        avg_hours: round(avgHours, 1),
        longest_fast: round(num(bestFast?.actual_hours), 1),
        total_fast_hours: round(sessions.reduce((a, s) => a + num(s.actual_hours), 0), 0),
        current_streak: stats7.current_streak,
        longest_streak: Math.max(num(data.longest_streak), stats7.current_streak),
        days_logged: daysLogged,
        pct_fat_burn: Math.round(pctFatBurn * 100),
        pct_ketosis: Math.round(pctKetosis * 100),
      },
      completed_count: completedCount,
      broke_count: brokeSessions.length,
      break_reasons,
      deepest_stage: deepest_stage ? { id: deepest_stage.id, label: deepest_stage.label, hours: round(num(bestFast?.actual_hours), 1) } : null,
      signal_points,
      daily_logs,
      stage_breakdown,
      efh,
      circadian,
      day_of_week: dow,
      best_fast: bestFast ? { date: bestFast.date, hours: round(num(bestFast.actual_hours), 1) } : null,
      ai_reads,
      aha_moments,
      effective_start_date: win.effectiveStartDate,
      effective_days: effectiveDays,
      days_since_anchor: win.daysSinceAnchor,
      anchor_date: anchor.anchorDateStr,
      is_clamped: win.isClamped,
      score_today: std.score_today,
      score_7d_smoothed: std.score_7d_smoothed,
      score_lifetime: std.score_lifetime,
      missed_days: std.missed_days,
    });
  } catch (e) {
    log.error("[fasting.bc] /analysis:", e?.message || e);
    return res.status(500).json({ error: "analysis_failed", message: e?.message });
  }
});

module.exports = router;
