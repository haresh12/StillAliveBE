"use strict";
// ════════════════════════════════════════════════════════════════════════════
// fasting-lifecycle.js — the ONE source of truth for auto-closing a forgotten fast.
//
//   THE BUG THIS KILLS: a user starts a 16h fast, forgets to end it, and days later
//   the timer reads "64h fasting". Nothing ever closed it. This module detects an
//   ABANDONED fast and finalizes it — crediting the TARGET (never the raw 64h), ending
//   it at the moment the target was reached, so streaks/averages are never poisoned.
//
//   "Abandoned" ≠ "intentionally fasting long". We tell them apart with a HEARTBEAT:
//   every time the app polls /today with a running fast, we stamp `active_last_seen_ms`.
//   A fast is only auto-closed when it is (a) past its target AND (b) has had NO
//   heartbeat for STALE_H hours — i.e. the app hasn't been opened while it "ran".
//   An absolute HARD_MAX_H ceiling is a last-resort backstop so a timer can never,
//   under any state, display an absurd multi-day number.
//
//   Shared by fasting.bc.agent.js (lazy check on /today — catches it the instant the
//   user re-opens the app) and fasting.agent.js hourly cron (catches it even if the
//   app is never opened, and lets the coach reach out). Collection is bc-namespaced:
//   wellness_bc_users/{id}/agents/fasting/{fasting_sessions}.
// ════════════════════════════════════════════════════════════════════════════
const admin = require("firebase-admin");
const db = () => admin.firestore();
const { userDoc } = require("./collections");
const { dateStr: tzDateStr } = require("./range-helpers");

// ── tunables ──────────────────────────────────────────────────────────────────
// No app heartbeat for this long while a fast sits PAST its target ⇒ it was forgotten.
// 12h comfortably clears an overnight sleep window (a fast is legitimately mid-run then,
// and usually still under target) while still catching a "forgot for a day+" fast the
// instant the user re-opens the app.
const AUTO_CLOSE_STALE_H = 12;
// Absolute backstop: no fast in this app legitimately runs this long (backfill caps at
// 48h, the deepest metabolic stage tops out around here). Past this we always finalize,
// heartbeat or not, so the timer can never show a multi-day number.
const HARD_MAX_H = 48;

const HOUR_MS = 3.6e6;

// ── tiny pure helpers (kept local so this module has no cross-agent coupling) ──
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const round = (n, dp = 1) => { const p = Math.pow(10, dp); return Math.round((Number(n) || 0) * p) / p; };
const getMillis = (t) => (t && typeof t.toMillis === "function" ? t.toMillis() : typeof t === "number" ? t : t ? new Date(t).getTime() : 0);

// Metabolic-stage table — mirrors fasting.bc.agent.js METABOLIC_STAGES (the science the
// timer/Live Activity render). Kept in sync by hand; both are the same 7 rows.
const METABOLIC_STAGES = [
  { id: "fed", hours: [0, 4], label: "Fed" },
  { id: "post_absorptive", hours: [4, 8], label: "Post-Absorptive" },
  { id: "glycogen", hours: [8, 12], label: "Glycogen Burning" },
  { id: "fat_burning", hours: [12, 16], label: "Fat Burning" },
  { id: "ketosis_entry", hours: [16, 18], label: "Ketosis Entry" },
  { id: "autophagy", hours: [18, 24], label: "Autophagy" },
  { id: "deep_fast", hours: [24, 72], label: "Deep Fast" },
];
const getStage = (h = 0) => METABOLIC_STAGES.find((s) => h >= s.hours[0] && h < s.hours[1]) || METABOLIC_STAGES[METABOLIC_STAGES.length - 1];

const fastingDoc = (id) => userDoc(id).collection("agents").doc("fasting");
const sessionsCol = (id) => fastingDoc(id).collection("fasting_sessions");
const mapSession = (d) => { const s = d.data() || {}; return { id: d.id, ...s, started_at_ms: getMillis(s.started_at), ended_at_ms: getMillis(s.ended_at) }; };

// Streak/stats from a most-recent-first mapped session list. Mirrors computeStats in
// fasting.bc.agent.js so the rollups this module writes match what /session/end writes.
function computeStats(sessions, tz = 0) {
  const ended = sessions.filter((s) => s.ended_at_ms);
  const completedDates = new Set(ended.filter((s) => s.completed).map((s) => s.date || tzDateStr(new Date(s.started_at_ms), tz)));
  let streak = 0;
  const d = new Date();
  if (!completedDates.has(tzDateStr(d, tz))) d.setDate(d.getDate() - 1);
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

// Decide whether an active session is abandoned. Pure — no I/O — so it's unit-testable and
// both the lazy path and the cron use identical logic. `lastSeenMs` is the last heartbeat
// (falls back to the session's own updated_at / started_at when never stamped).
function isAbandoned({ startedMs, targetHours, lastSeenMs, nowMs = Date.now(), staleH = AUTO_CLOSE_STALE_H }) {
  if (!startedMs) return false;
  const elapsed = (nowMs - startedMs) / HOUR_MS;
  if (elapsed >= HARD_MAX_H) return true;                       // absolute backstop
  const staleFor = (nowMs - (lastSeenMs || startedMs)) / HOUR_MS;
  return elapsed >= targetHours && staleFor >= staleH;          // past goal + gone quiet
}

// Finalize the given active session, crediting the target (never the raw runaway elapsed).
// Writes the session close + recomputes the agent rollups (streak/total/etc) so the FE's
// "you've completed N fasts" and streak are correct immediately. Returns a summary object.
async function finalizeAbandoned(deviceId, ref, sess, agentData, { nowMs = Date.now(), tzOff = 0 } = {}) {
  const startedMs = getMillis(sess.started_at);
  const target = num(sess.target_hours, 16);
  const elapsed = (nowMs - startedMs) / HOUR_MS;
  // Credit the goal they provably passed — but never more hours than actually elapsed
  // (guards the pathological target>elapsed case), and never an end time in the future.
  const creditedHours = Math.min(target, elapsed);
  const endMs = startedMs + creditedHours * HOUR_MS;
  const completed = elapsed >= target;
  const stage = getStage(creditedHours);

  // ATOMIC close — re-check ended_at inside a transaction so a concurrent lazy /today + cron (or two
  // /today calls) can't both finalize the same session (which would double-post the coach message and
  // double-bump rollups). Only the caller that actually flips ended_at proceeds; the loser returns null.
  const didClose = await db().runTransaction(async (tx) => {
    const fresh = await tx.get(ref);
    if (!fresh.exists || fresh.data().ended_at != null) return false; // already closed by someone else
    tx.update(ref, {
      ended_at: admin.firestore.Timestamp.fromMillis(Math.round(endMs)),
      actual_hours: round(creditedHours, 2),
      completed,
      broken_early: !completed,
      broken_reason: completed ? null : "abandoned",
      auto_closed: true,           // FE reads this → shows the completion summary + "adjust hours"
      metabolic_stage_reached: stage.id,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    });
    return true;
  });
  if (!didClose) return null; // lost the race — don't double-post / double-recompute

  // Recompute rollups from recent sessions (mirrors /session/end).
  const recent = (await sessionsCol(deviceId).orderBy("started_at", "desc").limit(120).get()).docs.map(mapSession);
  const stats = computeStats(recent, tzOff);
  const prevLongestFast = num(agentData.longest_fast, 0);
  const newLongestFast = Math.max(prevLongestFast, round(creditedHours, 2));
  await fastingDoc(deviceId).update({
    active_session_id: null,
    active_last_seen_ms: admin.firestore.FieldValue.delete(),
    current_streak: stats.current_streak,
    longest_streak: Math.max(num(agentData.longest_streak), stats.current_streak),
    longest_fast: newLongestFast,
    total_sessions_completed: stats.total_completed,
    completion_rate_7d: stats.completion_rate_7d,
    avg_fast_hours_7d: stats.avg_fast_hours_7d,
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    finalized: true,
    session_id: ref.id,
    actual_hours: round(creditedHours, 2),
    target_hours: target,
    completed,
    auto_closed: true,
    stage_reached: stage.id,
    stage_label: stage.label,
    started_at_ms: startedMs,
    ended_at_ms: Math.round(endMs),
    current_streak: stats.current_streak,
    total_completed: stats.total_completed,
    longest_fast: newLongestFast,
  };
}

// Convenience for callers holding a deviceId: load the active session, and if it's
// abandoned, finalize it. Returns the summary (with `finalized:true`) or null.
// `agentData` may be passed to avoid a re-read (the caller usually already has it).
async function maybeFinalizeStale(deviceId, { nowMs = Date.now(), tzOff = 0, staleH = AUTO_CLOSE_STALE_H, agentData = null } = {}) {
  const data = agentData || (await fastingDoc(deviceId).get().then((s) => (s.exists ? s.data() : {})));
  const activeId = data.active_session_id;
  if (!activeId) return null;
  const ref = sessionsCol(deviceId).doc(activeId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const sess = snap.data();
  if (sess.ended_at != null) return null; // already closed
  // Effective heartbeat = the most recent sign of life: the /today ping (active_last_seen_ms) OR any
  // write to the session itself (water log, adjust-start all bump updated_at) OR, as a floor, the start.
  // Taking the MAX means interacting with the fast in ANY way keeps it from being wrongly auto-closed.
  const lastSeenMs = Math.max(num(data.active_last_seen_ms, 0), getMillis(sess.updated_at), getMillis(sess.started_at));
  if (!isAbandoned({ startedMs: getMillis(sess.started_at), targetHours: num(sess.target_hours, 16), lastSeenMs, nowMs, staleH })) return null;
  return finalizeAbandoned(deviceId, ref, sess, data, { nowMs, tzOff });
}

module.exports = {
  AUTO_CLOSE_STALE_H,
  HARD_MAX_H,
  METABOLIC_STAGES,
  getStage,
  isAbandoned,
  finalizeAbandoned,
  maybeFinalizeStale,
  computeStats,
};
