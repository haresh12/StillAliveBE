"use strict";
// ════════════════════════════════════════════════════════════════════════════
// mind.bc.agent.js — BIG-CHANGE Mind/Mood backend (chat-first). Mirrors water.bc / sleep.bc.
//   • bc namespace: wellness_bc_users/{id}/agents/mind/{mind_checkins}
//   • Reuses the legacy brain (lib/mind-analytics PURE primitives + lib/agent-scores.computeMindScore),
//     reimplemented on bc checkins so we NEVER touch the shared lib or do cross-agent reads
//     (loadAnalysisV2 reads the sleep subcollection → forbidden by the per-agent sandbox law).
//     sleep_correlation is hard null here; cross-agent lives only in wellness-cross-v2.
//   • ONE field convention: mood + mood_score + anxiety + emotions[] + triggers[] + note + time_of_day
//     + hour + date_str + logged_at. Readers use c.mood_score||c.mood and c.anxiety_level||c.anxiety.
//   • Registration-anchor on every read/write (resolveAnchor → computeAnalysisWindow → standard outputs)
//     + log-guard. Crisis safety is load-bearing (lib/safety). Mounted BEFORE legacy /api/mind.
// ════════════════════════════════════════════════════════════════════════════
const express = require("express");
const admin = require("firebase-admin");
const { OpenAI } = require("openai");
const { OPENAI_TIMEOUT_MS } = require("./lib/model-router");
const { resolveAnchor } = require("./lib/user-anchor");
const { computeAnalysisWindow } = require("./lib/range-helpers");
const { computeStandardOutputs } = require("./lib/score-lifetime");
const { computeMindScore } = require("./lib/agent-scores");
const ma = require("./lib/mind-analytics");
const { userDoc: bcUserDoc } = require("./lib/collections");
const { resolveLanguage, appendLanguageInstruction } = require("./lib/i18n-prompt");
const { domainHealth, domainHealthView } = require("./lib/hk-domain"); // Apple Health HRV/recovery (null if no HK)
let safety = {}; try { safety = require("./lib/safety"); } catch { safety = {}; }

const router = express.Router();
const db = () => admin.firestore();
const ts = () => admin.firestore.FieldValue.serverTimestamp();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: OPENAI_TIMEOUT_MS });
const log = globalThis.log || console;

// ── bc collection helpers ─────────────────────────────────────────────────────
const mindDoc = (id) => bcUserDoc(id).collection("agents").doc("mind");
const checkinsCol = (id) => mindDoc(id).collection("mind_checkins");
const breathingCol = (id) => mindDoc(id).collection("mind_breathing");

// ── helpers + taxonomy ─────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, "0");
const dateStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const round = (n, dp = 0) => { const p = Math.pow(10, dp); return Math.round((Number(n) || 0) * p) / p; };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const getMillis = (t) => (t && typeof t.toMillis === "function" ? t.toMillis() : typeof t === "number" ? t : t ? new Date(t).getTime() : 0);
const toIso = (t) => { const ms = getMillis(t); return ms ? new Date(ms).toISOString() : null; };

const MOOD_SCORE = { low: 1, okay: 2, good: 3, great: 4 };
const MOODS = ["low", "okay", "good", "great"];
const safeMood = (m) => (MOODS.includes(m) ? m : "okay");
const timeOfDayLabel = (hour) => (hour < 12 ? "morning" : hour < 17 ? "afternoon" : hour < 21 ? "evening" : "night");
const EMOTIONS = ["Anxious", "Overwhelmed", "Sad", "Angry", "Lonely", "Numb", "Stressed", "Drained", "Foggy", "Hopeless", "Restless", "Bored", "Worried", "Calm", "Content", "Hopeful", "Grateful", "Focused", "Energized", "Happy", "Relaxed", "Motivated", "Excited", "Proud", "Inspired", "Joyful"];
const TRIGGERS = ["Work", "Relationships", "Money", "Family", "Health", "Sleep", "Loneliness", "Body image", "Social situation", "Can't name it"];

const mapCheckin = (d) => { const s = d.data() || {}; return { id: d.id, mood: s.mood || "okay", mood_score: num(s.mood_score, MOOD_SCORE[s.mood] || 2), anxiety: num(s.anxiety_level ?? s.anxiety, 1), anxiety_level: num(s.anxiety_level ?? s.anxiety, 1), emotions: Array.isArray(s.emotions) ? s.emotions : [], triggers: Array.isArray(s.triggers) ? s.triggers : [], note: s.note || "", time_of_day: s.time_of_day || "", hour: num(s.hour, new Date(getMillis(s.logged_at)).getHours()), date_str: s.date_str || dateStr(new Date(getMillis(s.logged_at))), logged_at: toIso(s.logged_at) }; };

// Consecutive-day streak (any check-in), ending today or yesterday.
function checkinStreak(dates) {
  const set = new Set(dates); let streak = 0; const d = new Date();
  if (!set.has(dateStr(d))) d.setDate(d.getDate() - 1);
  while (set.has(dateStr(d))) { streak += 1; d.setDate(d.getDate() - 1); }
  return streak;
}

// Smart, context-aware check-in prompt. EMA best practice = lower friction + time-of-day relevance, so
// the coach's opener changes with the hour, whether they've already logged today, and their streak.
function mindGreeting({ tod, loggedToday, streak, isNew }) {
  if (isNew) return { greeting: "Let's capture your first check-in 🧠", sub: "Tap how you feel — I'll start finding your patterns." };
  if (loggedToday) return { greeting: "Want to capture another moment? 💬", sub: "Mood shifts through the day — log this one too." };
  const base = {
    morning: ["Good morning ☀️", "How are you waking up?"],
    afternoon: ["Midday check 🌤", "How's the day landing so far?"],
    evening: ["Winding down 🌆", "How did today feel?"],
    night: ["Late one 🌙", "How are you ending the day?"],
  }[tod] || ["Hey 👋", "How are you, right now?"];
  let sub = base[1];
  if (streak >= 3) sub = `🔥 ${streak}-day streak — ${base[1].charAt(0).toLowerCase()}${base[1].slice(1)}`;
  return { greeting: base[0], sub };
}

// ── POST /log — log a mood check-in (the core entry) ────────────────────────────
router.post("/log", async (req, res) => {
  const b = req.body || {};
  const { deviceId } = b;
  if (!deviceId || !b.mood) return res.status(400).json({ error: "deviceId + mood required" });
  try {
    const mood = safeMood(b.mood);
    const anchor = await resolveAnchor(deviceId);
    const tzOff = anchor.utcOffsetMinutes || 0;
    let now = new Date(); let date;
    if (b.override_date && /^\d{4}-\d{2}-\d{2}$/.test(b.override_date)) now = new Date(`${b.override_date}T12:00:00Z`);
    try { date = require("./lib/log-guard").assertLoggableDate(b.override_date, anchor); }
    catch (e) { return require("./lib/log-guard").sendLogGuardError(res, e); }
    // user-LOCAL hour drives the morning/afternoon/evening bucket (the server runs UTC on Fly).
    const hour = b.override_date ? 12 : new Date(Date.now() + tzOff * 60000).getUTCHours();

    const doc = {
      mood, mood_score: MOOD_SCORE[mood] || 2,
      emotions: Array.isArray(b.emotions) ? b.emotions.slice(0, 6) : [],
      triggers: Array.isArray(b.triggers) ? b.triggers.slice(0, 3) : [],
      anxiety: clamp(num(b.anxiety, 1), 1, 5),
      note: typeof b.note === "string" ? b.note.slice(0, 1000) : "",
      time_of_day: timeOfDayLabel(hour), hour,
      date_str: date,
      logged_at: admin.firestore.Timestamp.fromDate(now),
      created_at: ts(),
    };
    const ref = await checkinsCol(deviceId).add(doc);
    await mindDoc(deviceId).set({ last_checkin_date: date, checkin_count: admin.firestore.FieldValue.increment(1), updated_at: ts() }, { merge: true });
    return res.json({ success: true, id: ref.id, mood, mood_score: doc.mood_score, anxiety: doc.anxiety });
  } catch (e) {
    log.error("[mind.bc] /log:", e?.message || e);
    return res.status(500).json({ error: "server error" });
  }
});

// ── POST /breathing — log a guided breathing session (Mind sandbox only) ──────────
// Always "now" (no backdating), so it's registration-anchor-safe by construction. Stays entirely inside
// agents/mind — never reads or writes another agent's data (per-agent sandbox law).
router.post("/breathing", async (req, res) => {
  const b = req.body || {};
  const { deviceId } = b;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const anchor = await resolveAnchor(deviceId);
    const tzOff = anchor.utcOffsetMinutes || 0;
    const now = new Date();
    const localHour = new Date(Date.now() + tzOff * 60000).getUTCHours();
    const dateStr = new Date(Date.now() + tzOff * 60000).toISOString().slice(0, 10);
    const doc = {
      preset: typeof b.preset === "string" ? b.preset.slice(0, 24) : "box",
      breaths: clamp(num(b.breaths, 0), 0, 500),
      rounds: clamp(num(b.rounds, 0), 0, 500),
      seconds: clamp(num(b.seconds, 0), 0, 36000),
      time_of_day: timeOfDayLabel(localHour), hour: localHour,
      date_str: dateStr,
      logged_at: admin.firestore.Timestamp.fromDate(now),
      created_at: ts(),
    };
    const ref = await breathingCol(deviceId).add(doc);
    await mindDoc(deviceId).set({ last_breathing_date: dateStr, breathing_count: admin.firestore.FieldValue.increment(1), updated_at: ts() }, { merge: true });
    return res.json({ success: true, id: ref.id });
  } catch (e) {
    log.error("[mind.bc] /breathing:", e?.message || e);
    return res.status(500).json({ error: "server error" });
  }
});

// ── DELETE /log/:id ─────────────────────────────────────────────────────────────
router.delete("/log/:id", async (req, res) => {
  const { deviceId } = req.query; const { id } = req.params;
  if (!deviceId || !id) return res.status(400).json({ error: "deviceId + id required" });
  try { await checkinsCol(deviceId).doc(id).delete(); return res.json({ success: true }); }
  catch (e) { log.error("[mind.bc] DELETE /log:", e?.message || e); return res.status(500).json({ error: "server error" }); }
});

// ── POST /describe — parse free text → structured mood (chat-first logging) ──────
router.post("/describe", async (req, res) => {
  const b = req.body || {};
  const { deviceId } = b; const text = String(b.text || "").slice(0, 1200);
  if (!deviceId || !text) return res.status(400).json({ error: "deviceId + text required" });
  try {
    // Crisis first — never parse, route to help.
    if (safety.detectCrisis && safety.detectCrisis(text)) {
      const env = safety.crisisEnvelope ? safety.crisisEnvelope(b.region) : { is_crisis: true };
      return res.json({ ...env, is_crisis: true });
    }
    const sys = [
      "You parse a person's free-text mood note into structured fields for a mood tracker. Output STRICT JSON only.",
      "Fields:",
      "  mood: one of low | okay | good | great (their overall state).",
      "  anxiety: integer 1-5 (1=calm, 3=noticeable, 5=intense).",
      `  emotions: array (max 4) chosen ONLY from: ${EMOTIONS.join(", ")}.`,
      `  triggers: array (max 2) chosen ONLY from: ${TRIGGERS.join(", ")}.`,
      "  note: a short, warm one-line paraphrase of what they said (≤120 chars), first person.",
      "If the text says little about feelings, default mood='okay', anxiety=2. Be decisive.",
      'Output: {"mood":"...","anxiety":N,"emotions":[],"triggers":[],"note":"..."}',
    ].join("\n");
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini", response_format: { type: "json_object" }, max_completion_tokens: 300,
      messages: [{ role: "system", content: appendLanguageInstruction(sys, resolveLanguage(req)) }, { role: "user", content: text }],
    });
    const p = JSON.parse(completion.choices?.[0]?.message?.content || "{}");
    return res.json({
      is_crisis: false,
      mood: safeMood(p.mood),
      anxiety: clamp(num(p.anxiety, 2), 1, 5),
      emotions: Array.isArray(p.emotions) ? p.emotions.filter((e) => EMOTIONS.includes(e)).slice(0, 4) : [],
      triggers: Array.isArray(p.triggers) ? p.triggers.filter((t) => TRIGGERS.includes(t)).slice(0, 2) : [],
      note: String(p.note || "").slice(0, 200),
    });
  } catch (e) {
    log.error("[mind.bc] /describe:", e?.message || e);
    return res.json({ is_crisis: false, mood: "okay", anxiety: 2, emotions: [], triggers: [], note: text.slice(0, 160) });
  }
});

// ── POST /reframe — CBT reframe of a heavy thought (crisis-routed) ──────────────
router.post("/reframe", async (req, res) => {
  const b = req.body || {};
  const { deviceId } = b; const thought = String(b.thought || "").slice(0, 600);
  if (!deviceId || !thought) return res.status(400).json({ error: "deviceId + thought required" });
  try {
    if (safety.detectCrisis && safety.detectCrisis(thought)) {
      return res.json(safety.crisisEnvelope ? safety.crisisEnvelope(b.region) : { is_crisis: true, reframe: null });
    }
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini", response_format: { type: "json_object" }, max_completion_tokens: 220,
      messages: [{ role: "system", content: appendLanguageInstruction(ma.MIND_REFRAME_SYSTEM, resolveLanguage(req)) }, { role: "user", content: thought }],
    });
    const p = JSON.parse(completion.choices?.[0]?.message?.content || "{}");
    return res.json({ is_crisis: false, reframe: p?.reframe || null });
  } catch (e) {
    log.error("[mind.bc] /reframe:", e?.message || e);
    return res.status(500).json({ error: "server error" });
  }
});

// ── GET /today — latest mood + streak + week (drives TodayMind gauge) ────────────
router.get("/today", async (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const [mSnap, recentSnap, anchor] = await Promise.all([
      mindDoc(deviceId).get(),
      checkinsCol(deviceId).orderBy("logged_at", "desc").limit(200).get(),
      resolveAnchor(deviceId),
    ]);
    // "Today" in the user's LOCAL day (check-ins written with user-local date_str) — bare UTC dateStr()
    // showed the wrong day off-UTC.
    const { dateStr: tzDateStr } = require("./lib/range-helpers");
    const todayKey = tzDateStr(new Date(), anchor?.utcOffsetMinutes || 0);
    const data = mSnap.exists ? mSnap.data() : {};
    const recent = recentSnap.docs.map(mapCheckin).filter((c) => !anchor.anchorDateStr || c.date_str >= anchor.anchorDateStr);
    const todays = recent.filter((c) => c.date_str === todayKey);
    const latest = recent[0] || null;
    const dates = [...new Set(recent.map((c) => c.date_str))];
    const streak = checkinStreak(dates);
    const weekAgo = Date.now() - 7 * 864e5;
    const week = recent.filter((c) => getMillis(c.logged_at) >= weekAgo);
    const wDays = new Set(week.map((c) => c.date_str));
    const avgMood = week.length ? round(week.reduce((a, c) => a + c.mood_score, 0) / week.length, 1) : 0;
    const avgAnx = week.length ? round(week.reduce((a, c) => a + c.anxiety, 0) / week.length, 1) : 0;
    const date_logs = {};
    for (const c of recent) { if (!date_logs[c.date_str]) date_logs[c.date_str] = { has_log: true, mood: c.mood_score, anxiety: c.anxiety, quadrant: ma.quadrantFor(c.mood_score, c.anxiety) }; }
    return res.json({
      health_view: await domainHealthView(deviceId, 'mind', 7).catch(() => null), // Apple Health Body Signals (today tiles)
      date: todayKey,
      logged_today: todays.length > 0,
      count_today: todays.length,
      latest: latest ? { mood: latest.mood, mood_score: latest.mood_score, anxiety: latest.anxiety, emotions: latest.emotions, time_of_day: latest.time_of_day } : null,
      current_streak: streak,
      longest_streak: Math.max(num(data.longest_streak), streak),
      week: { days: wDays.size, avg_mood: avgMood, avg_anxiety: avgAnx },
      date_logs,
      targets: { mood_levels: 4 },
    });
  } catch (e) {
    log.error("[mind.bc] /today:", e?.message || e);
    return res.status(500).json({ error: "server error" });
  }
});

// ── GET /prompt — the SMART quick-log seed (drives the "+" launcher & bare "log mood") ──
// Personalizes the check-in card from the user's own history: time-of-day-aware greeting, their most-
// used feelings/triggers surfaced first, and a one-tap "repeat last". Anchor-clamped (P1 LAW).
router.get("/prompt", async (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const [recentSnap, anchor] = await Promise.all([
      checkinsCol(deviceId).orderBy("logged_at", "desc").limit(300).get(),
      resolveAnchor(deviceId),
    ]);
    const recent = recentSnap.docs.map(mapCheckin).filter((c) => !anchor.anchorDateStr || c.date_str >= anchor.anchorDateStr);
    // User's LOCAL hour (Fly runs UTC) → correct greeting for their timezone.
    const localMs = Date.now() + num(anchor.utcOffsetMinutes) * 60000;
    const hour = new Date(localMs).getUTCHours();
    const tod = timeOfDayLabel(hour);
    // "Today" in the user's LOCAL timezone — check-in date_str is user-local, so UTC would mis-detect.
    const todayKey = require("./lib/range-helpers").dateStr(new Date(), num(anchor.utcOffsetMinutes));
    const loggedToday = recent.some((c) => c.date_str === todayKey);
    const streak = checkinStreak([...new Set(recent.map((c) => c.date_str))]);
    const latest = recent[0] || null;
    const { greeting, sub } = mindGreeting({ tod, loggedToday, streak, isNew: recent.length === 0 });
    return res.json({
      time_of_day: tod, hour, greeting, sub,
      streak, logged_today: loggedToday,
      frequent_emotions: ma.topEmotions(recent).slice(0, 8).map((e) => e.emotion),
      frequent_triggers: ma.topTriggers(recent).slice(0, 6).map((t) => t.trigger),
      last: latest ? { mood: latest.mood, anxiety: latest.anxiety, emotions: latest.emotions || [], triggers: latest.triggers || [] } : null,
    });
  } catch (e) {
    log.error("[mind.bc] /prompt:", e?.message || e);
    return res.status(500).json({ error: "server error" });
  }
});

// ── GET /analysis — the centerpiece. Reuses the pure primitives + anchor infra ──
router.get("/analysis", async (req, res) => {
  const { deviceId, range } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  const days = (() => { const n = parseInt(range, 10); return Number.isFinite(n) && n > 0 && n <= 730 ? n : 30; })();
  try {
    const anchor = await resolveAnchor(deviceId);
    const win = computeAnalysisWindow(days, anchor.anchorMs, Date.now(), anchor.utcOffsetMinutes);
    const effectiveDays = win.effectiveDays;
    const startKey = win.effectiveStartDate;

    const [mSnap, allSnap, bSnap] = await Promise.all([mindDoc(deviceId).get(), checkinsCol(deviceId).orderBy("logged_at", "desc").limit(2000).get(), breathingCol(deviceId).orderBy("logged_at", "desc").limit(2000).get()]);
    const data = mSnap.exists ? mSnap.data() : {};
    const all = allSnap.docs.map(mapCheckin);
    // Breathing sessions (Mind sandbox) — anchor-clamped lifetime totals + last-7-days count. Pure
    // in-memory reduce over a single-field ordered read (no composite index).
    const bAll = bSnap.docs.map((d) => d.data()).filter((b) => !anchor.anchorDateStr || (b.date_str || "") >= anchor.anchorDateStr);
    const _weekAgoMs = Date.now() - 7 * 864e5;
    const _priorWeekAgoMs = _weekAgoMs - 7 * 864e5;
    const _msOf = (b) => (b.logged_at && b.logged_at.toMillis ? b.logged_at.toMillis() : 0);
    const _bTz = num(anchor.utcOffsetMinutes);
    const _localKey = (ms) => new Date(ms + _bTz * 60000).toISOString().slice(0, 10);
    const _bWeek = bAll.filter((b) => _msOf(b) >= _weekAgoMs).length;
    const _bPrev = bAll.filter((b) => { const ms = _msOf(b); return ms >= _priorWeekAgoMs && ms < _weekAgoMs; }).length;
    const _bSecs = bAll.reduce((s, b) => s + num(b.seconds), 0);
    // Current streak = consecutive LOCAL days (ending today or yesterday) with >=1 session.
    const _bDays = new Set(bAll.map((b) => b.date_str || (_msOf(b) ? _localKey(_msOf(b)) : "")).filter(Boolean));
    const _bStreak = (() => {
      let streak = 0; const cur = new Date(Date.now() + _bTz * 60000); const k = (d) => d.toISOString().slice(0, 10);
      if (!_bDays.has(k(cur))) cur.setUTCDate(cur.getUTCDate() - 1);
      while (_bDays.has(k(cur))) { streak += 1; cur.setUTCDate(cur.getUTCDate() - 1); }
      return streak;
    })();
    const _bTop = (fn) => { const m = {}; bAll.forEach((b) => { const key = fn(b); if (key) m[key] = (m[key] || 0) + 1; }); const t = Object.entries(m).sort((a, c) => c[1] - a[1])[0]; return t ? { key: t[0], count: t[1] } : null; };
    const _bPreset = _bTop((b) => b.preset || "box");
    const _bTod = _bTop((b) => b.time_of_day || timeOfDayLabel(num(b.hour, 12)));
    const _bSpark = (() => {
      const buckets = {}; for (let i = 29; i >= 0; i--) buckets[_localKey(Date.now() - i * 864e5)] = 0;
      bAll.forEach((b) => { const key = b.date_str || (_msOf(b) ? _localKey(_msOf(b)) : ""); if (key in buckets) buckets[key] += Math.round(num(b.seconds) / 60); });
      return Object.keys(buckets).sort().map((k) => buckets[k]);
    })();
    const breathing = {
      breathing_sessions_week: _bWeek,
      breathing_sessions_prior_week: _bPrev,
      breathing_week_delta: _bWeek - _bPrev,
      breathing_breaths_total: bAll.reduce((s, b) => s + num(b.breaths), 0),
      breathing_minutes_total: Math.round(_bSecs / 60),
      breathing_sessions_lifetime: bAll.length,
      breathing_current_streak: _bStreak,
      breathing_avg_session_minutes: bAll.length ? Math.round((_bSecs / bAll.length / 60) * 10) / 10 : 0,
      breathing_most_used_preset: _bPreset,
      breathing_best_time_of_day: _bTod ? _bTod.key : null,
      breathing_sparkline_30d: _bSpark,
    };
    // Anchor-clamped lifetime set (P1 LAW): granularity + calm-drought look back further than the
    // selected range, but NEVER before registration day. Never feed raw `all` to a window primitive.
    const all_anchored = all.filter((c) => !anchor.anchorDateStr || c.date_str >= anchor.anchorDateStr);
    const win_c = all.filter((c) => (!startKey || c.date_str >= startKey) && (!anchor.anchorDateStr || c.date_str >= anchor.anchorDateStr));

    if (!win_c.length) {
      const _hkP = domainHealth(deviceId, 'mind').catch(() => null);
      const _hkViewP = domainHealthView(deviceId, 'mind', win.requestedDays).catch(() => null);
      return res.json({ stage: 0, range: days, period_days: effectiveDays, total_checkins: 0, mind_score: null, score_grade: null, signal_points: [], daily_logs: {}, top_triggers: [], top_emotions: [], aha_moments: [], ai_reads: [], ...breathing, effective_start_date: win.effectiveStartDate, effective_days: effectiveDays, anchor_date: anchor.anchorDateStr, is_clamped: win.isClamped, score_today: null, score_7d_smoothed: null, score_lifetime: null, missed_days: (effectiveDays <= 1 ? 0 : effectiveDays), health: await _hkP, health_view: await _hkViewP });
    }

    // Pure primitives (each operates on the checkin array — no Firestore, no cross-agent reads).
    const stats = ma.computeStats(win_c);
    const signal = ma.buildSignalPoints(win_c);
    const daily_logs = ma.buildDailyLogs(win_c);
    const hourHeat = ma.computeHourHeat(win_c);
    const peak = ma.peakHour(hourHeat, stats.avg_anxiety);
    const granularity = ma.computeGranularity(all_anchored);
    const recovery = ma.computeRecoveryDays(win_c);
    const triggerDow = ma.computeTriggerByDow(win_c);
    const calmDrought = ma.computeCalmDrought(all_anchored);
    const top_emotions = ma.topEmotions(win_c);
    const top_triggers = ma.topTriggers(win_c);
    const bestD = ma.bestDay(signal);
    const worstD = ma.worstDay(signal);
    const volatility_pct = ma.volatilityPct(signal);
    const aha_moments = (() => { try { return ma.buildAhaMoments({ stats, hourHeat, granularity, recovery, triggerDow, sleepCorr: null, calmDrought, bestD, worstD, signal }) || []; } catch { return []; } })();

    // Score (anchor-clamped maturity). mood_score 1-4, anxiety 1-5 — most-recent-first.
    const mood_scores = win_c.map((c) => c.mood_score);
    const anxiety_scores = win_c.map((c) => c.anxiety);
    const checkin_dates = [...new Set(win_c.map((c) => c.date_str))];
    const mind_score = computeMindScore({ mood_scores, anxiety_scores, checkin_dates, days_logged: stats.days_with_logs, streak: stats.streak, elapsed_days: effectiveDays, recent_sleep_hours: null });
    const score = num(mind_score?.score);
    const grade = score >= 85 ? "A" : score >= 70 ? "B" : score >= 50 ? "C" : score >= 30 ? "D" : "E";
    const band = score >= 85 ? "Thriving" : score >= 70 ? "Good" : score >= 50 ? "Steady" : "Building";

    // AI (inline — uses the exported prompts, no legacy-namespace cache). Best-effort, skip if thin.
    let hero_insight = null; let ai_reads = [];
    if (stats.days_with_logs >= 3) {
      try {
        const heroPayload = { total_checkins: stats.total_checkins, days_with_logs: stats.days_with_logs, avg_mood: stats.avg_mood, avg_anxiety: stats.avg_anxiety, streak: stats.streak };
        const hc = await openai.chat.completions.create({ model: "gpt-4o-mini", response_format: { type: "json_object" }, max_completion_tokens: 220, messages: [{ role: "system", content: appendLanguageInstruction(ma.MIND_HERO_SYSTEM, resolveLanguage(req)) }, { role: "user", content: JSON.stringify(heroPayload) }] });
        hero_insight = { headline: JSON.parse(hc.choices?.[0]?.message?.content || "{}").headline || null };
        // Free-text "what happened" notes — the richest signal for WHY a mood moved. Feed the most recent
        // few (with mood/anxiety context) so the reads can reference real events, not just counts.
        const recent_notes = win_c
          .filter((c) => c.note && c.note.length > 4)
          .slice(0, 8)
          .map((c) => ({ date: c.date_str, mood: c.mood, anxiety: c.anxiety, note: String(c.note).slice(0, 200) }));
        const readsPayload = { ...heroPayload, top_triggers, top_emotions, granularity_30d_ago: granularity?.prior, recovery_days: recovery, trigger_dow: triggerDow, sleep_correlation: null, calm_drought: calmDrought, best_day: bestD, worst_day: worstD, recent_notes };
        const rc = await openai.chat.completions.create({ model: "gpt-4o-mini", response_format: { type: "json_object" }, max_completion_tokens: 700, messages: [{ role: "system", content: appendLanguageInstruction(ma.MIND_AI_READS_SYSTEM, resolveLanguage(req)) }, { role: "user", content: JSON.stringify(readsPayload) }] });
        const reads = JSON.parse(rc.choices?.[0]?.message?.content || "{}").reads;
        ai_reads = Array.isArray(reads) ? reads : [];
      } catch (e) { log.error("[mind.bc] ai:", e?.message || e); }
    }

    // Lifetime outputs (anchor-clamped). Per-day quality = mood*0.6 + anxiety-inverted*0.4.
    const qualityByDate = {};
    for (const c of all) { if (anchor.anchorDateStr && c.date_str < anchor.anchorDateStr) continue; const moodPart = ((c.mood_score - 1) / 2) * 100; const anxPart = ((5 - c.anxiety) / 4) * 100; const q = Math.round(clamp(moodPart * 0.6 + anxPart * 0.4, 0, 100)); if (qualityByDate[c.date_str] == null || q > qualityByDate[c.date_str]) qualityByDate[c.date_str] = q; }
    const std = computeStandardOutputs({ qualityByDate, todayDate: win.todayDate, anchorDate: anchor.anchorDateStr, daysSinceAnchor: win.daysSinceAnchor });

    res.set("Cache-Control", "private, max-age=60");
    // Fire both Apple Health reads concurrently (kicked off before either await) — halves HK latency.
    const _hkP = domainHealth(deviceId, 'mind').catch(() => null);
    const _hkViewP = domainHealthView(deviceId, 'mind', win.requestedDays).catch(() => null);
    return res.json({
      health: await _hkP,
      health_view: await _hkViewP, // Apple Health HRV/recovery
      stage: stats.days_with_logs >= 30 ? 3 : stats.days_with_logs >= 7 ? 2 : 1,
      range: days, period_days: effectiveDays,
      mind_score, score_grade: { letter: grade, band },
      hero_insight,
      stats: { ...stats, longest_streak: Math.max(num(data.longest_streak), num(stats.longest_streak), num(stats.streak)) },
      signal_points: signal, daily_logs,
      hour_heat: hourHeat, peak_hour: peak,
      granularity_now: granularity?.now, granularity_30d_ago: granularity?.prior, granularity_delta: granularity?.delta,
      recovery_days_avg: recovery, trigger_dow_pattern: triggerDow, sleep_correlation: null, calm_drought: calmDrought,
      top_triggers, top_emotions, best_day: bestD, worst_day: worstD, volatility_pct,
      ...breathing,
      ai_reads, aha_moments,
      effective_start_date: win.effectiveStartDate, effective_days: effectiveDays,
      days_since_anchor: win.daysSinceAnchor, anchor_date: anchor.anchorDateStr, is_clamped: win.isClamped,
      score_today: std.score_today, score_7d_smoothed: std.score_7d_smoothed, score_lifetime: std.score_lifetime, missed_days: std.missed_days,
    });
  } catch (e) {
    log.error("[mind.bc] /analysis:", e?.message || e);
    return res.status(500).json({ error: "analysis_failed", message: e?.message });
  }
});

module.exports = router;
