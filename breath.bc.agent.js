"use strict";
// ════════════════════════════════════════════════════════════════════════════
// breath.bc.agent.js — BIG-CHANGE Breath backend (7th agent, chat-first). Mirrors mind.bc / sleep.bc.
//   • bc namespace: wellness_bc_users/{id}/agents/breath/{breath_sessions}
//   • Moment-first model: the user picks a FEELING (sos/stress/focus/sleep/…), each moment maps to an
//     evidence-graded protocol (physiological sigh = hero, per Balban 2023 RCT). See BREATH_MINI_APP_PLAN.md.
//   • HONEST score (no fake physiology): consistency 40% + dose 25% (5-min/day evidence target, capped)
//     + moment-fit 15% + depth 20%. Feel-shift (before→after 1-tap delta) is our proof-of-effect — a real
//     self-report, never an HRV/"coherence = health" claim.
//   • Registration-anchor on every read/write (resolveAnchor → computeAnalysisWindow → standard outputs)
//     + log-guard. Per-agent sandbox: reads ONLY agents/breath/* (cross-agent lives in wellness-combined).
//   • Grace streak: a day is "kept" by practice OR by ≤2 grace days per rolling week (Sharif & Shu
//     emergency-reserves research — rigid broken chains demotivate).
// ════════════════════════════════════════════════════════════════════════════
const express = require("express");
const admin = require("firebase-admin");
const { OpenAI } = require("openai");
const { OPENAI_TIMEOUT_MS } = require("./lib/model-router");
const { resolveAnchor } = require("./lib/user-anchor");
const { computeAnalysisWindow, dateStr: tzDateStr } = require("./lib/range-helpers");
const { computeStandardOutputs } = require("./lib/score-lifetime");
const { userDoc: bcUserDoc } = require("./lib/collections");
const { resolveLanguage, appendLanguageInstruction } = require("./lib/i18n-prompt");
const { domainHealthView } = require("./lib/hk-domain"); // Apple Health (null if no HK — parity-safe)

const router = express.Router();
const ts = () => admin.firestore.FieldValue.serverTimestamp();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: OPENAI_TIMEOUT_MS });
const log = globalThis.log || console;

// ── bc collection helpers ─────────────────────────────────────────────────────
const breathDoc = (id) => bcUserDoc(id).collection("agents").doc("breath");
const sessionsCol = (id) => breathDoc(id).collection("breath_sessions");
const holdsCol = (id) => breathDoc(id).collection("breath_holds"); // breath-hold challenge attempts (records track)

// ── helpers ──────────────────────────────────────────────────────────────────
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const round = (n, dp = 0) => { const p = Math.pow(10, dp); return Math.round((Number(n) || 0) * p) / p; };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const getMillis = (t) => (t && typeof t.toMillis === "function" ? t.toMillis() : typeof t === "number" ? t : t ? new Date(t).getTime() : 0);
const toIso = (t) => { const ms = getMillis(t); return ms ? new Date(ms).toISOString() : null; };
const timeOfDayLabel = (hour) => (hour < 12 ? "morning" : hour < 17 ? "afternoon" : hour < 21 ? "evening" : "night");

// The moment→protocol canon (FE mirror lives in src/bigchange/breath/protocols.ts — keep keys in sync).
const MOMENTS = ["sos", "stress", "pre_moment", "anger", "focus", "steady", "sleep", "craving", "wake", "custom"];
const PROTOCOLS = ["sigh", "cyclic_sigh", "sigh_then_slow", "extended_exhale", "box", "coherent", "four78", "slow_nasal", "energize", "custom"];
const safeMoment = (m) => (MOMENTS.includes(m) ? m : "steady");
const safeProtocol = (p) => (PROTOCOLS.includes(p) ? p : "coherent");

const DAILY_TARGET_MIN = 5;   // Balban 2023: 5 min/day is the evidence-based dose
const WEEKLY_DAY_TARGET = 4;  // frequency > duration: 4–7 d/wk = 2.3× retention (Cearns & Clark)

// ── Breath-hold challenge (the "records" track — deliberately SEPARATE from the daily practice score) ──
// A calm, honest static-apnea timer: inhale → hold → release. We store personal bests, never fold hold
// length into breath_score (showing up is what's scored; capacity is celebrated, not punishing). Tiers
// are the belts users chase. 600s hard cap = anti-garbage + a safety ceiling (we never coach beyond it).
const HOLD_TIERS = [60, 90, 120]; // seconds — 1:00 · 1:30 · 2:00
const HOLD_MAX = 600;
const HOLD_REASONS = ["manual", "target", "cap", "bailed"]; // why the hold ended
const highestTier = (secs) => { let t = 0; for (const s of HOLD_TIERS) if (secs >= s) t = s; return t; };
const nextTier = (secs) => HOLD_TIERS.find((s) => s > secs) || null;
const mapHold = (d) => {
  const h = d.data() || {};
  return {
    id: d.id,
    seconds: clamp(num(h.seconds), 0, HOLD_MAX),
    released_reason: HOLD_REASONS.includes(h.released_reason) ? h.released_reason : "manual",
    target_seconds: h.target_seconds == null ? null : clamp(num(h.target_seconds), 0, HOLD_MAX),
    date_str: h.date_str || (getMillis(h.logged_at) ? new Date(getMillis(h.logged_at)).toISOString().slice(0, 10) : ""),
    logged_at: toIso(h.logged_at),
  };
};

const mapSession = (d) => {
  const s = d.data() || {};
  return {
    id: d.id,
    moment: safeMoment(s.moment),
    protocol: safeProtocol(s.protocol),
    seconds: clamp(num(s.seconds), 0, 36000),
    cycles: clamp(num(s.cycles), 0, 500),
    completed: s.completed !== false,
    feel_before: s.feel_before == null ? null : clamp(num(s.feel_before), 1, 5),
    feel_after: s.feel_after == null ? null : clamp(num(s.feel_after), 1, 5),
    time_of_day: s.time_of_day || timeOfDayLabel(num(s.hour, 12)),
    hour: num(s.hour, 12),
    date_str: s.date_str || (getMillis(s.logged_at) ? new Date(getMillis(s.logged_at)).toISOString().slice(0, 10) : ""),
    logged_at: toIso(s.logged_at),
  };
};

// Strict consecutive-day streak (ending today or yesterday), plus a GRACE streak that lets ≤2 misses
// per rolling 7 days survive — the streak users keep, so one bad day never nukes motivation.
function breathStreaks(daySet, todayKey, addDaysFn) {
  let strict = 0;
  let cur = todayKey;
  if (!daySet.has(cur)) cur = addDaysFn(cur, -1);
  while (daySet.has(cur)) { strict += 1; cur = addDaysFn(cur, -1); }

  let grace = 0; let misses = [];
  cur = todayKey;
  if (!daySet.has(cur)) cur = addDaysFn(cur, -1); // today still open — don't count it as a miss
  for (let guard = 0; guard < 730; guard++) {
    if (daySet.has(cur)) {
      grace += 1;
    } else {
      misses.push(cur);
      // prune misses older than 7 days from the day being examined
      misses = misses.filter((m) => m > addDaysFn(cur, -7));
      if (misses.length > 2) break; // 3rd miss inside a week ends the graced run
      grace += 1; // graced day still extends the run
    }
    cur = addDaysFn(cur, -1);
  }
  return { strict, grace };
}

const addDaysStr = (ds, n) => {
  const [y, m, d] = ds.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
};

// ── POST /log — log a completed (or bailed) session ─────────────────────────────
// Sessions are always "now" from the app player; date_str still goes through log-guard so a clock-skewed
// client can never write pre-anchor or future days.
router.post("/log", async (req, res) => {
  const b = req.body || {};
  const { deviceId } = b;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const anchor = await resolveAnchor(deviceId);
    const tzOff = num(anchor.utcOffsetMinutes);
    const localNow = new Date(Date.now() + tzOff * 60000);
    const localHour = localNow.getUTCHours();
    let date;
    try { date = require("./lib/log-guard").assertLoggableDate(b.date_str || null, anchor); }
    catch (e) { return require("./lib/log-guard").sendLogGuardError(res, e); }

    const doc = {
      moment: safeMoment(b.moment),
      protocol: safeProtocol(b.protocol),
      seconds: clamp(num(b.seconds), 0, 36000),
      cycles: clamp(num(b.cycles), 0, 500),
      completed: b.completed !== false,
      feel_before: b.feel_before == null ? null : clamp(num(b.feel_before), 1, 5),
      feel_after: b.feel_after == null ? null : clamp(num(b.feel_after), 1, 5),
      time_of_day: timeOfDayLabel(localHour), hour: localHour,
      date_str: date,
      logged_at: admin.firestore.Timestamp.now(),
      created_at: ts(),
    };
    const ref = await sessionsCol(deviceId).add(doc);
    await breathDoc(deviceId).set({
      last_session_date: date,
      last_moment: doc.moment,
      session_count: admin.firestore.FieldValue.increment(1),
      updated_at: ts(),
    }, { merge: true });
    return res.json({ success: true, id: ref.id, date });
  } catch (e) {
    log.error("[breath.bc] /log:", e?.message || e);
    return res.status(500).json({ error: "server error" });
  }
});

// ── POST /log/feel — attach the after-feel delta to an existing session ─────────
// The 1-tap "how do you feel now?" fires AFTER the auto-log (never blocks the calm ending).
router.post("/log/feel", async (req, res) => {
  const b = req.body || {};
  const { deviceId, id } = b;
  if (!deviceId || !id) return res.status(400).json({ error: "deviceId + id required" });
  try {
    const patch = { updated_at: ts() };
    if (b.feel_before != null) patch.feel_before = clamp(num(b.feel_before), 1, 5);
    if (b.feel_after != null) patch.feel_after = clamp(num(b.feel_after), 1, 5);
    await sessionsCol(deviceId).doc(String(id)).set(patch, { merge: true });
    return res.json({ success: true });
  } catch (e) {
    log.error("[breath.bc] /log/feel:", e?.message || e);
    return res.status(500).json({ error: "server error" });
  }
});

// ── DELETE /log/:id — undo ───────────────────────────────────────────────────────
router.delete("/log/:id", async (req, res) => {
  const { deviceId } = req.query; const { id } = req.params;
  if (!deviceId || !id) return res.status(400).json({ error: "deviceId + id required" });
  try { await sessionsCol(deviceId).doc(id).delete(); return res.json({ success: true }); }
  catch (e) { log.error("[breath.bc] DELETE /log:", e?.message || e); return res.status(500).json({ error: "server error" }); }
});

// ── GET /today — drives the Breath home header + chat TodayBreath block ─────────
router.get("/today", async (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const [bSnap, recentSnap, anchor] = await Promise.all([
      breathDoc(deviceId).get(),
      sessionsCol(deviceId).orderBy("logged_at", "desc").limit(300).get(),
      resolveAnchor(deviceId),
    ]);
    const data = bSnap.exists ? bSnap.data() : {};
    const todayKey = tzDateStr(new Date(), num(anchor.utcOffsetMinutes));
    const recent = recentSnap.docs.map(mapSession).filter((s) => !anchor.anchorDateStr || s.date_str >= anchor.anchorDateStr);
    const todays = recent.filter((s) => s.date_str === todayKey);
    const weekAgoMs = Date.now() - 7 * 864e5;
    const week = recent.filter((s) => getMillis(new Date(s.logged_at)) >= weekAgoMs);
    const weekDays = new Set(week.map((s) => s.date_str));
    const daySet = new Set(recent.map((s) => s.date_str));
    const streaks = breathStreaks(daySet, todayKey, addDaysStr);
    return res.json({
      health_view: await domainHealthView(deviceId, "breath", 7).catch(() => null),
      date: todayKey,
      logged_today: todays.length > 0,
      today: {
        sessions: todays.length,
        minutes: round(todays.reduce((a, s) => a + s.seconds, 0) / 60, 1),
        target_minutes: DAILY_TARGET_MIN,
      },
      last_session: recent[0] ? { moment: recent[0].moment, protocol: recent[0].protocol, seconds: recent[0].seconds, time_of_day: recent[0].time_of_day, date_str: recent[0].date_str } : null,
      last_moment: data.last_moment || null,
      current_streak: streaks.grace,
      strict_streak: streaks.strict,
      week: { days: weekDays.size, day_target: WEEKLY_DAY_TARGET, sessions: week.length, minutes: round(week.reduce((a, s) => a + s.seconds, 0) / 60) },
      session_count: num(data.session_count, recent.length),
      // Breath-hold records track (separate from the practice score) — drives the "Challenge" entry state.
      hold: { best_seconds: clamp(num(data.best_hold_seconds), 0, HOLD_MAX), worst_seconds: clamp(num(data.worst_hold_seconds), 0, HOLD_MAX), attempts: num(data.hold_count, 0), tier_reached: highestTier(clamp(num(data.best_hold_seconds), 0, HOLD_MAX)), next_tier: nextTier(clamp(num(data.best_hold_seconds), 0, HOLD_MAX)), target_tiers: HOLD_TIERS },
    });
  } catch (e) {
    log.error("[breath.bc] /today:", e?.message || e);
    return res.status(500).json({ error: "server error" });
  }
});

// ── GET /analysis — the centerpiece (BreathAnalysis.tsx renders this 1:1) ────────
router.get("/analysis", async (req, res) => {
  const { deviceId, range } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  const days = (() => { const n = parseInt(range, 10); return Number.isFinite(n) && n > 0 && n <= 730 ? n : 30; })();
  try {
    const anchor = await resolveAnchor(deviceId);
    const win = computeAnalysisWindow(days, anchor.anchorMs, Date.now(), anchor.utcOffsetMinutes);
    const effectiveDays = win.effectiveDays;
    const startKey = win.effectiveStartDate;
    const tzOff = num(anchor.utcOffsetMinutes);
    const localKey = (ms) => new Date(ms + tzOff * 60000).toISOString().slice(0, 10);

    const allSnap = await sessionsCol(deviceId).orderBy("logged_at", "desc").limit(2000).get();
    // Anchor-clamped lifetime set (P1 LAW) + the selected window slice.
    const all = allSnap.docs.map(mapSession).filter((s) => s.date_str && (!anchor.anchorDateStr || s.date_str >= anchor.anchorDateStr) && s.date_str <= win.todayDate);
    const win_s = all.filter((s) => !startKey || s.date_str >= startKey);

    // Breath-hold records (lifetime, anchor-clamped) — surfaced alongside practice but never scored into it.
    const holdsSnap = await holdsCol(deviceId).orderBy("logged_at", "desc").limit(300).get();
    const holds = holdsSnap.docs.map(mapHold).filter((h) => h.date_str && (!anchor.anchorDateStr || h.date_str >= anchor.anchorDateStr) && h.date_str <= win.todayDate);
    const bestHold = holds.reduce((m, h) => Math.max(m, h.seconds), 0);
    const validHolds = holds.filter((h) => h.seconds > 0);
    const worstHold = validHolds.length ? validHolds.reduce((m, h) => Math.min(m, h.seconds), Infinity) : 0;
    const records = {
      best_seconds: bestHold, worst_seconds: worstHold, attempts: holds.length,
      tier_reached: highestTier(bestHold), next_tier: nextTier(bestHold), target_tiers: HOLD_TIERS,
      tiers: HOLD_TIERS.map((s) => ({ seconds: s, unlocked: bestHold >= s })),
      trend: holds.slice(0, 12).reverse().map((h) => h.seconds),
    };

    const hkViewP = domainHealthView(deviceId, "breath", win.requestedDays).catch(() => null);

    if (!win_s.length) {
      return res.json({
        stage: 0, range: days, period_days: effectiveDays,
        total_sessions: 0, breath_score: null, score_grade: null,
        daily_logs: {}, sparkline_30d: Array(30).fill(0),
        moment_balance: [], protocol_balance: [], feel_shift: null, ai_reads: [],
        records,
        effective_start_date: win.effectiveStartDate, effective_days: effectiveDays,
        days_since_anchor: win.daysSinceAnchor, anchor_date: anchor.anchorDateStr, is_clamped: win.isClamped,
        score_today: null, score_7d_smoothed: null, score_lifetime: null, missed_days: (effectiveDays <= 1 ? 0 : effectiveDays),
        health_view: await hkViewP,
      });
    }

    // ── per-day rollups (window) ────────────────────────────────────────────────
    const byDay = {};
    for (const s of win_s) {
      const d = (byDay[s.date_str] = byDay[s.date_str] || { minutes: 0, sessions: 0, completed: 0, feel_deltas: [], moments: new Set(), protocols: new Set() });
      d.minutes += s.seconds / 60; d.sessions += 1; if (s.completed) d.completed += 1;
      if (s.feel_before != null && s.feel_after != null) d.feel_deltas.push(s.feel_after - s.feel_before);
      d.moments.add(s.moment); d.protocols.add(s.protocol);
    }
    const dayKeys = Object.keys(byDay).sort();
    const daysWith = dayKeys.length;
    const totalMin = win_s.reduce((a, s) => a + s.seconds / 60, 0);

    // ── HONEST practice score (0-100): consistency 40 + dose 25 + moment-fit 15 + depth 20 ──
    const consistency = clamp(daysWith / Math.max(1, Math.min(effectiveDays, days)), 0, 1);
    const dose = clamp(totalMin / (Math.max(1, Math.min(effectiveDays, days)) * DAILY_TARGET_MIN), 0, 1);
    const momentFit = win_s.length ? win_s.filter((s) => s.moment !== "steady" || s.protocol === "coherent").length / win_s.length : 0;
    const distinctMoments = new Set(win_s.map((s) => s.moment)).size;
    const completionRate = win_s.length ? win_s.filter((s) => s.completed).length / win_s.length : 0;
    const depth = clamp((Math.min(distinctMoments, 4) / 4) * 0.5 + completionRate * 0.5, 0, 1);
    const breath_score = Math.round(consistency * 40 + dose * 25 + momentFit * 15 + depth * 20);
    const grade = breath_score >= 85 ? "A" : breath_score >= 70 ? "B" : breath_score >= 50 ? "C" : breath_score >= 30 ? "D" : "E";
    const band = breath_score >= 85 ? "Mastering" : breath_score >= 70 ? "Steady practice" : breath_score >= 50 ? "Building" : "Starting out";

    // ── balances + rhythms ──────────────────────────────────────────────────────
    const countBy = (fn) => { const m = {}; win_s.forEach((s) => { const k = fn(s); if (k) m[k] = (m[k] || 0) + 1; }); return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count })); };
    const moment_balance = countBy((s) => s.moment);
    const protocol_balance = countBy((s) => s.protocol);
    const tod_balance = countBy((s) => s.time_of_day);
    const best_time_of_day = tod_balance[0] ? tod_balance[0].key : null;

    // ── feel shift: our proof-of-effect (self-report, never fake physiology) ─────
    const deltas = win_s.filter((s) => s.feel_before != null && s.feel_after != null).map((s) => s.feel_after - s.feel_before);
    const feel_shift = deltas.length ? {
      sessions_rated: deltas.length,
      avg_delta: round(deltas.reduce((a, b) => a + b, 0) / deltas.length, 2),
      improved_pct: Math.round((deltas.filter((d) => d > 0).length / deltas.length) * 100),
    } : null;

    // ── weeks + streaks + sparkline + calendar ──────────────────────────────────
    const weekAgoMs = Date.now() - 7 * 864e5; const priorWeekMs = weekAgoMs - 7 * 864e5;
    const msOf = (s) => getMillis(new Date(s.logged_at));
    const sessions_week = all.filter((s) => msOf(s) >= weekAgoMs).length;
    const sessions_prior_week = all.filter((s) => { const ms = msOf(s); return ms >= priorWeekMs && ms < weekAgoMs; }).length;
    const daySetAll = new Set(all.map((s) => s.date_str));
    const streaks = breathStreaks(daySetAll, win.todayDate, addDaysStr);
    const sparkline_30d = (() => {
      const buckets = {}; for (let i = 29; i >= 0; i--) buckets[localKey(Date.now() - i * 864e5)] = 0;
      all.forEach((s) => { if (s.date_str in buckets) buckets[s.date_str] += Math.round(s.seconds / 60); });
      return Object.keys(buckets).sort().map((k) => buckets[k]);
    })();
    const daily_logs = {};
    for (const k of dayKeys) {
      const d = byDay[k];
      daily_logs[k] = { minutes: round(d.minutes, 1), sessions: d.sessions, met_dose: d.minutes >= DAILY_TARGET_MIN };
    }

    // ── lifetime standard outputs (P1 LAW) ──────────────────────────────────────
    // Per-day quality: dose vs 5-min target (60) + any completed session (20) + felt-better (20; neutral 10).
    const qualityByDate = {};
    const byDayAll = {};
    for (const s of all) {
      const d = (byDayAll[s.date_str] = byDayAll[s.date_str] || { minutes: 0, completed: 0, deltas: [] });
      d.minutes += s.seconds / 60; if (s.completed) d.completed += 1;
      if (s.feel_before != null && s.feel_after != null) d.deltas.push(s.feel_after - s.feel_before);
    }
    for (const k of Object.keys(byDayAll)) {
      const d = byDayAll[k];
      const dosePart = clamp(d.minutes / DAILY_TARGET_MIN, 0, 1) * 60;
      const donePart = d.completed > 0 ? 20 : 0;
      const feltPart = d.deltas.length ? (d.deltas.some((x) => x > 0) ? 20 : 10) : 10;
      qualityByDate[k] = Math.round(clamp(dosePart + donePart + feltPart, 0, 100));
    }
    const std = computeStandardOutputs({ qualityByDate, todayDate: win.todayDate, anchorDate: anchor.anchorDateStr, daysSinceAnchor: win.daysSinceAnchor });

    // ── AI reads (best-effort; registration-age-aware so it never overclaims history) ──
    let ai_reads = [];
    if (daysWith >= 3) {
      try {
        const sys = [
          "You are a calm, evidence-honest breathwork coach. You get a JSON summary of a user's real breathing practice.",
          "Write 2-3 short 'reads' — specific observations grounded ONLY in the data (their moments, times, streak, feel-shift).",
          "Never invent history. `days_since_registration` is how long they've been here — never reference longer periods.",
          "If breath_hold_best_seconds is present, you MAY note their breath-hold best warmly as CO2-tolerance practice (e.g. 'you held 1:32') — never as a health metric, never push them to hold longer for its own sake.",
          "Never make medical claims. 'supports calm', never 'treats anxiety'. Warm, direct, second person, ≤160 chars each.",
          'Output STRICT JSON: {"reads":[{"title":"...","body":"..."}]}',
        ].join("\n");
        const payload = {
          days_since_registration: win.daysSinceAnchor,
          days_practiced: daysWith, total_minutes: Math.round(totalMin),
          sessions_week, sessions_prior_week, grace_streak: streaks.grace,
          moment_balance: moment_balance.slice(0, 4), best_time_of_day, feel_shift,
          breath_hold_best_seconds: bestHold || null, breath_hold_attempts: holds.length,
        };
        const rc = await openai.chat.completions.create({
          model: "gpt-4o-mini", response_format: { type: "json_object" }, max_completion_tokens: 400,
          messages: [{ role: "system", content: appendLanguageInstruction(sys, resolveLanguage(req)) }, { role: "user", content: JSON.stringify(payload) }],
        });
        const reads = JSON.parse(rc.choices?.[0]?.message?.content || "{}").reads;
        ai_reads = Array.isArray(reads) ? reads.slice(0, 3) : [];
      } catch (e) { log.error("[breath.bc] ai:", e?.message || e); }
    }

    res.set("Cache-Control", "private, max-age=60");
    return res.json({
      stage: daysWith >= 30 ? 3 : daysWith >= 7 ? 2 : 1,
      range: days, period_days: effectiveDays,
      breath_score, score_grade: { letter: grade, band },
      score_parts: { consistency: Math.round(consistency * 100), dose: Math.round(dose * 100), moment_fit: Math.round(momentFit * 100), depth: Math.round(depth * 100) },
      total_sessions: win_s.length, total_minutes: Math.round(totalMin), days_practiced: daysWith,
      avg_session_minutes: win_s.length ? round(totalMin / win_s.length, 1) : 0,
      sessions_week, sessions_prior_week, week_delta: sessions_week - sessions_prior_week,
      current_streak: streaks.grace, strict_streak: streaks.strict, week_day_target: WEEKLY_DAY_TARGET,
      daily_target_minutes: DAILY_TARGET_MIN,
      moment_balance, protocol_balance, tod_balance, best_time_of_day,
      feel_shift, sparkline_30d, daily_logs,
      records,
      ai_reads,
      effective_start_date: win.effectiveStartDate, effective_days: effectiveDays,
      days_since_anchor: win.daysSinceAnchor, anchor_date: anchor.anchorDateStr, is_clamped: win.isClamped,
      score_today: std.score_today, score_7d_smoothed: std.score_7d_smoothed, score_lifetime: std.score_lifetime, missed_days: std.missed_days,
      health_view: await hkViewP,
    });
  } catch (e) {
    log.error("[breath.bc] /analysis:", e?.message || e);
    return res.status(500).json({ error: "analysis_failed", message: e?.message });
  }
});

// ── POST /hold — log a breath-hold challenge attempt (records track, never scored) ──────────────
// Body: { deviceId, seconds, released_reason?, target_seconds?, date_str? }. Returns PR + tier context so
// the app can celebrate honestly ("new best — you held 1:32"). Date runs through log-guard like every write.
router.post("/hold", async (req, res) => {
  const b = req.body || {};
  const { deviceId } = b;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const anchor = await resolveAnchor(deviceId);
    let date;
    try { date = require("./lib/log-guard").assertLoggableDate(b.date_str || null, anchor); }
    catch (e) { return require("./lib/log-guard").sendLogGuardError(res, e); }

    const seconds = clamp(num(b.seconds), 0, HOLD_MAX);
    const bSnap = await breathDoc(deviceId).get();
    const prevBest = bSnap.exists ? clamp(num(bSnap.data().best_hold_seconds), 0, HOLD_MAX) : 0;
    const prevWorst = bSnap.exists ? clamp(num(bSnap.data().worst_hold_seconds), 0, HOLD_MAX) : 0;
    const is_pr = seconds > prevBest;
    // Worst = shortest valid hold ever; only real holds (>0) count, so a mis-tap never sets "worst".
    const newWorst = seconds > 0 ? (prevWorst > 0 ? Math.min(prevWorst, seconds) : seconds) : prevWorst;

    const doc = {
      seconds,
      released_reason: HOLD_REASONS.includes(b.released_reason) ? b.released_reason : "manual",
      target_seconds: b.target_seconds == null ? null : clamp(num(b.target_seconds), 0, HOLD_MAX),
      tier_reached: highestTier(seconds),
      date_str: date,
      logged_at: admin.firestore.Timestamp.now(),
      created_at: ts(),
    };
    const ref = await holdsCol(deviceId).add(doc);
    await breathDoc(deviceId).set({
      best_hold_seconds: Math.max(prevBest, seconds),
      worst_hold_seconds: newWorst,
      hold_count: admin.firestore.FieldValue.increment(1),
      last_hold_date: date,
      updated_at: ts(),
    }, { merge: true });

    return res.json({
      success: true, id: ref.id, date, seconds,
      is_pr, best_seconds: Math.max(prevBest, seconds), worst_seconds: newWorst, prev_best_seconds: prevBest,
      tier_reached: doc.tier_reached, next_tier: nextTier(seconds), target_tiers: HOLD_TIERS,
    });
  } catch (e) {
    log.error("[breath.bc] /hold:", e?.message || e);
    return res.status(500).json({ error: "server error" });
  }
});

// ── GET /holds — the records payload (best, tiers, recent, trend) ────────────────────────────────
router.get("/holds", async (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const anchor = await resolveAnchor(deviceId);
    const hSnap = await holdsCol(deviceId).orderBy("logged_at", "desc").limit(400).get();
    const all = hSnap.docs.map(mapHold).filter((h) => h.date_str && (!anchor.anchorDateStr || h.date_str >= anchor.anchorDateStr));
    const best = all.reduce((m, h) => Math.max(m, h.seconds), 0);
    // Worst = shortest *valid* hold (ignore 0s so a mis-tap never becomes a "worst"). null when none.
    const valid = all.filter((h) => h.seconds > 0);
    const worst = valid.length ? valid.reduce((m, h) => Math.min(m, h.seconds), Infinity) : 0;
    const todayKey = tzDateStr(new Date(), num(anchor.utcOffsetMinutes));
    const todays = all.filter((h) => h.date_str === todayKey);
    const today_best = todays.reduce((m, h) => Math.max(m, h.seconds), 0);
    const todaysValid = todays.filter((h) => h.seconds > 0);
    const today_worst = todaysValid.length ? todaysValid.reduce((m, h) => Math.min(m, h.seconds), Infinity) : 0;
    return res.json({
      best_seconds: best, worst_seconds: worst, attempts: all.length,
      today_best, today_worst, today_attempts: todays.length,
      tier_reached: highestTier(best), next_tier: nextTier(best), target_tiers: HOLD_TIERS,
      tiers: HOLD_TIERS.map((s) => ({ seconds: s, unlocked: best >= s })),
      recent: all.slice(0, 20).map((h) => ({ seconds: h.seconds, date_str: h.date_str, reason: h.released_reason })),
      trend: all.slice(0, 12).reverse().map((h) => h.seconds), // oldest→newest mini sparkline
    });
  } catch (e) {
    log.error("[breath.bc] /holds:", e?.message || e);
    return res.status(500).json({ error: "server error" });
  }
});

module.exports = router;
