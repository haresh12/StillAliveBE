"use strict";
// ════════════════════════════════════════════════════════════════════════════
// water.bc.agent.js — BIG-CHANGE Water backend (chat-first). Mirrors fasting.bc.
//   • bc namespace: wellness_bc_users/{id}/agents/water/{water_logs, containers}
//   • P0 drift fix: ONE field `drink_type`, ONE table DRINK_MULTIPLIER (water-analytics),
//     ONE score `computeHydrationScore` used by BOTH /today and /analysis → they never disagree.
//     (Legacy stored `beverage_type`+BEV_MULT for /log but read `drink_type`+DRINK_MULTIPLIER for
//      /analysis → drink breakdown silently always saw "water". Fixed here.)
//   • Registration-anchor law on every read/write (resolveAnchor → computeAnalysisWindow →
//     computeStandardOutputs) + log-guard on writes. Per-agent sandbox (reads only agents/water/*).
//   • Mounted at /api/water BEFORE the legacy router → bc owns log/today/analysis/goal/containers;
//     legacy falls through for /setup, /chat, /actions, /log/from-photo (camera lands in P2).
// ════════════════════════════════════════════════════════════════════════════
const express = require("express");
const admin = require("firebase-admin");
const { OpenAI } = require("openai");
const { OPENAI_TIMEOUT_MS, MODELS, openaiStrict } = require("./lib/model-router");
const { resolveAnchor } = require("./lib/user-anchor");
const { computeAnalysisWindow } = require("./lib/range-helpers");
const { computeStandardOutputs } = require("./lib/score-lifetime");
const wa = require("./lib/water-analytics");
const { userDoc: bcUserDoc } = require("./lib/collections");
const { callGeminiVision, hashImages } = require("./lib/vision-router");
const { domainHealth, domainHealthView, domainHealthQualityByDate } = require("./lib/hk-domain"); // Apple Health hydration/activity (null if no HK)

const router = express.Router();
const db = () => admin.firestore();
const ts = () => admin.firestore.FieldValue.serverTimestamp();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: OPENAI_TIMEOUT_MS });
const log = globalThis.log || console;

// ── bc collection helpers ─────────────────────────────────────────────────────
const waterDoc = (id) => bcUserDoc(id).collection("agents").doc("water");
const logsCol = (id) => waterDoc(id).collection("water_logs");
const containersCol = (id) => waterDoc(id).collection("containers");

// ── helpers ───────────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, "0");
const dateStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const round = (n, dp = 0) => { const p = Math.pow(10, dp); return Math.round((Number(n) || 0) * p) / p; };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const getMillis = (t) => (t && typeof t.toMillis === "function" ? t.toMillis() : typeof t === "number" ? t : t ? new Date(t).getTime() : 0);
const toIso = (t) => { const ms = getMillis(t); return ms ? new Date(ms).toISOString() : null; };
const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : s);

// THE one beverage table (water-analytics). drink_type keys: water/sparkling/tea/coffee/herbal_tea/
// milk/juice/sport_drink/soda/alcohol. effective_ml = raw ml × multiplier (alcohol is dehydrating).
const MULT = wa.DRINK_MULTIPLIER || {};
const ALLOWED_DRINKS = Object.keys(MULT);
const safeDrink = (d) => (ALLOWED_DRINKS.includes(d) ? d : "water");
const effectiveOf = (ml, drink) => Math.round(num(ml) * (MULT[safeDrink(drink)] ?? 1));

const getGoal = (data) => num(data?.setup?.daily_goal_ml ?? data?.daily_goal_ml, 2500);
// Display unit the user picked ('ml' metric | 'oz' US). Canonical storage stays ML; this only changes
// how the FE shows/enters volumes and how the voice coach speaks them. Default metric.
const getUnit = (data) => (data?.setup?.volume_unit === "oz" ? "oz" : "ml");
const mapLog = (d) => { const s = d.data() || {}; return { id: d.id, ml: num(s.ml), effective_ml: s.effective_ml != null ? num(s.effective_ml) : effectiveOf(s.ml, s.drink_type), drink_type: safeDrink(s.drink_type), date: s.date || dateStr(new Date(getMillis(s.logged_at))), logged_at: toIso(s.logged_at) }; };

// ONE score path — both /today and /analysis call this on the same logs, so numbers never disagree.
function scoreLogs(logs, target_ml, days) {
  try { return wa.computeHydrationScore({ logs, target_ml, days }); }
  catch { return { score: 0, label: "Begin", components: { volume: 0, timing: 0, consistency: 0, electrolytes: 0 }, days_logged: 0 }; }
}

// Per-day raw-ml totals (what the user drank — "4.5L today"), keyed by date.
function dailyTotals(logs) {
  const byDate = {};
  for (const l of logs) { byDate[l.date] = (byDate[l.date] || 0) + num(l.ml); }
  return byDate;
}
// Averaged hourly hydration curve across the window (typical day) vs a steady optimal ramp — the moat.
function avgCurve(logs, target_ml, utcOffsetMin = 0) {
  const days = new Set(logs.map((l) => l.date)).size || 1;
  const byHour = new Array(24).fill(0);
  for (const l of logs) { const ms = getMillis(l.logged_at); if (!ms) continue; const h = new Date(ms - utcOffsetMin * 60000).getHours(); byHour[h] += num(l.effective_ml); }
  let cum = 0; const out = [];
  for (let h = 0; h < 24; h++) {
    cum += byHour[h] / days;
    out.push({ hour: h, actual_pct: target_ml ? Math.round((cum / target_ml) * 100) : 0, optimal_pct: h < 7 ? 0 : h > 22 ? 100 : Math.round(((h - 7) / 15) * 100), intake_ml: Math.round(byHour[h] / days) });
  }
  return out;
}
// Consecutive-day streak (goal hit), ending today or yesterday. Walks days in the user's LOCAL timezone
// (byDate keys are user-local dates) — bare UTC would break the count at the day boundary off-UTC.
const { dateStr: tzDateStr } = require("./lib/range-helpers");
function currentStreak(byDate, goal, tz = 0) {
  let streak = 0; const d = new Date();
  if (!(byDate[tzDateStr(d, tz)] >= goal)) d.setDate(d.getDate() - 1);
  while (byDate[tzDateStr(d, tz)] >= goal) { streak += 1; d.setDate(d.getDate() - 1); }
  return streak;
}

// ── POST /log — log a drink (raw ml + drink_type → effective_ml via the ONE table) ───────────────
router.post("/log", async (req, res) => {
  const b = req.body || {};
  const { deviceId } = b;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  const ml = num(b.ml);
  if (!(ml >= 1 && ml <= 5000)) return res.status(400).json({ error: "ml must be 1–5000" });
  try {
    const drink_type = safeDrink(b.drink_type);
    const anchor = await resolveAnchor(deviceId);
    let date;
    try { date = require("./lib/log-guard").assertLoggableDate(b.date, anchor); }
    catch (e) { return require("./lib/log-guard").sendLogGuardError(res, e); }

    const ref = await logsCol(deviceId).add({
      ml: round(ml), effective_ml: effectiveOf(ml, drink_type), drink_type,
      date, logged_at: ts(), created_at: ts(),
    });
    await waterDoc(deviceId).set({ last_log_date: date, updated_at: ts() }, { merge: true });

    // Today total for an instant confirmation. Use the guarded user-LOCAL `date` (the row we just wrote),
    // never bare UTC dateStr() — off-UTC the UTC day differs from the user's day, so the total read 0/wrong.
    const todaySnap = await logsCol(deviceId).where("date", "==", date).get();
    const todayMl = todaySnap.docs.reduce((a, d) => a + num(d.data().ml), 0);
    const fSnap = await waterDoc(deviceId).get();
    const goal = getGoal(fSnap.exists ? fSnap.data() : {});
    return res.json({ success: true, id: ref.id, ml: round(ml), drink_type, logged_ml: round(todayMl), goal_ml: goal, remaining_ml: Math.max(0, goal - todayMl) });
  } catch (e) {
    log.error("[water.bc] /log:", e?.message || e);
    return res.status(500).json({ error: "server error" });
  }
});

// ── DELETE /log/:id ─────────────────────────────────────────────────────────────
router.delete("/log/:id", async (req, res) => {
  const { deviceId } = req.query;
  const { id } = req.params;
  if (!deviceId || !id) return res.status(400).json({ error: "deviceId + id required" });
  try { await logsCol(deviceId).doc(id).delete(); return res.json({ success: true }); }
  catch (e) { log.error("[water.bc] DELETE /log:", e?.message || e); return res.status(500).json({ error: "server error" }); }
});

// ── GET /logs?date= — a day's logs ──────────────────────────────────────────────
router.get("/logs", async (req, res) => {
  const { deviceId, date } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const day = date || dateStr();
    const snap = await logsCol(deviceId).where("date", "==", day).get();
    const logs = snap.docs.map(mapLog).sort((a, b) => (b.logged_at || "").localeCompare(a.logged_at || ""));
    return res.json({ date: day, logs });
  } catch (e) { log.error("[water.bc] /logs:", e?.message || e); return res.status(500).json({ error: "server error" }); }
});

// ── POST /goal — set the daily goal (manual override) ───────────────────────────
router.post("/goal", async (req, res) => {
  const b = req.body || {};
  const { deviceId } = b;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const goal = clamp(Math.round(num(b.daily_goal_ml, 2500) / 50) * 50, 1000, 6000);
    // Optional display-unit preference (canonical store stays ML). Only persist when explicitly sent.
    const setup = { daily_goal_ml: goal, manual_goal_ml: goal };
    if (b.volume_unit === "ml" || b.volume_unit === "oz") setup.volume_unit = b.volume_unit;
    await waterDoc(deviceId).set({ setup, daily_goal_ml: goal, updated_at: ts() }, { merge: true });
    return res.json({ success: true, daily_goal_ml: goal, volume_unit: setup.volume_unit || undefined });
  } catch (e) { log.error("[water.bc] /goal:", e?.message || e); return res.status(500).json({ error: "server error" }); }
});

// ── Containers (quick-log presets) ──────────────────────────────────────────────
router.get("/containers", async (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const snap = await containersCol(deviceId).orderBy("use_count", "desc").limit(20).get();
    return res.json({ containers: snap.docs.map((d) => ({ id: d.id, ...d.data(), last_used_at: toIso(d.data().last_used_at) })) });
  } catch (e) { log.error("[water.bc] GET /containers:", e?.message || e); return res.status(500).json({ error: "server error" }); }
});
router.post("/containers", async (req, res) => {
  const b = req.body || {};
  const { deviceId } = b;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const c = { name: String(b.name || "Cup").slice(0, 24), drink_type: safeDrink(b.drink_type), ml: clamp(num(b.ml, 250), 1, 5000), emoji: typeof b.emoji === "string" ? b.emoji.slice(0, 4) : "", use_count: 0, created_at: ts(), last_used_at: ts() };
    const ref = await containersCol(deviceId).add(c);
    return res.json({ success: true, id: ref.id, container: { id: ref.id, ...c, created_at: null, last_used_at: null } });
  } catch (e) { log.error("[water.bc] POST /containers:", e?.message || e); return res.status(500).json({ error: "server error" }); }
});
router.post("/containers/:id/use", async (req, res) => {
  const { deviceId } = req.body || {};
  const { id } = req.params;
  if (!deviceId || !id) return res.status(400).json({ error: "deviceId + id required" });
  try { await containersCol(deviceId).doc(id).set({ use_count: admin.firestore.FieldValue.increment(1), last_used_at: ts() }, { merge: true }); return res.json({ success: true }); }
  catch (e) { log.error("[water.bc] POST /containers/use:", e?.message || e); return res.status(500).json({ error: "server error" }); }
});
router.delete("/containers/:id", async (req, res) => {
  const { deviceId } = req.query;
  const { id } = req.params;
  if (!deviceId || !id) return res.status(400).json({ error: "deviceId + id required" });
  try { await containersCol(deviceId).doc(id).delete(); return res.json({ success: true }); }
  catch (e) { log.error("[water.bc] DELETE /containers:", e?.message || e); return res.status(500).json({ error: "server error" }); }
});

// ── GET /today — gauge data: today's logs + totals + streak + week + date heatmap ───────────────
router.get("/today", async (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const [wSnap, recentSnap, anchor] = await Promise.all([
      waterDoc(deviceId).get(),
      logsCol(deviceId).orderBy("logged_at", "desc").limit(400).get(),
      resolveAnchor(deviceId),
    ]);
    // "Today" in the user's LOCAL day (logs are written with the user-local date) — bare UTC dateStr()
    // showed the wrong day off-UTC.
    const { dateStr: tzDateStr } = require("./lib/range-helpers");
    const todayKey = tzDateStr(new Date(), anchor?.utcOffsetMinutes || 0);
    const data = wSnap.exists ? wSnap.data() : {};
    const goal = getGoal(data);
    // Anchor-clamp (P1 law): never count days before registration in streak/week/heatmap.
    const recent = recentSnap.docs.map(mapLog).filter((l) => !anchor.anchorDateStr || l.date >= anchor.anchorDateStr);
    const todays = recent.filter((l) => l.date === todayKey).sort((a, b) => (b.logged_at || "").localeCompare(a.logged_at || ""));
    const loggedMl = todays.reduce((a, l) => a + num(l.ml), 0);

    const byDate = dailyTotals(recent);
    const streak = currentStreak(byDate, goal, anchor?.utcOffsetMinutes || 0);
    // last-7 summary
    const weekAgo = Date.now() - 7 * 864e5;
    const week = recent.filter((l) => getMillis(l.logged_at) >= weekAgo);
    const weekDays = new Set(week.map((l) => l.date));
    const weekHit = [...weekDays].filter((d) => byDate[d] >= goal).length;
    const weekAvg = weekDays.size ? Math.round([...weekDays].reduce((a, d) => a + (byDate[d] || 0), 0) / weekDays.size) : 0;
    // 28-day heatmap
    const date_logs = {};
    for (const d of Object.keys(byDate)) date_logs[d] = { ml: round(byDate[d]), completed: byDate[d] >= goal, pct: goal ? round((byDate[d] / goal) * 100) : 0 };

    return res.json({
      health_view: await domainHealthView(deviceId, 'water', 7).catch(() => null), // Apple Health Body Signals (today tiles)
      date: todayKey,
      logs: todays,
      logged_ml: round(loggedMl),
      goal_ml: goal,
      remaining_ml: Math.max(0, goal - loggedMl),
      pct: goal ? round((loggedMl / goal) * 100) : 0,
      today_completed: loggedMl >= goal,
      current_streak: streak,
      longest_streak: Math.max(num(data.longest_streak), streak),
      week: { days: weekDays.size, completed: weekHit, avg_ml: weekAvg },
      date_logs,
      targets: { daily_goal_ml: goal },
      volume_unit: getUnit(data), // user's display unit (ml|oz) — FE + coach speak in it
    });
  } catch (e) {
    log.error("[water.bc] /today:", e?.message || e);
    return res.status(500).json({ error: "server error" });
  }
});

// ── GET /analysis — the centerpiece. Reuses water-analytics + anchor infra ──────────────────────
router.get("/analysis", async (req, res) => {
  const { deviceId, range } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  const days = (() => { const n = parseInt(range, 10); return Number.isFinite(n) && n > 0 && n <= 730 ? n : 30; })();
  try {
    const wSnap = await waterDoc(deviceId).get();
    const data = wSnap.exists ? wSnap.data() : {};
    const target_ml = getGoal(data);

    const anchor = await resolveAnchor(deviceId);
    const win = computeAnalysisWindow(days, anchor.anchorMs, Date.now(), anchor.utcOffsetMinutes);
    const effectiveDays = win.effectiveDays;
    const startKey = win.effectiveStartDate;

    const allSnap = await logsCol(deviceId).orderBy("logged_at", "desc").limit(1500).get();
    const all = allSnap.docs.map(mapLog);
    const logs = all.filter((l) => (!startKey || l.date >= startKey) && (!anchor.anchorDateStr || l.date >= anchor.anchorDateStr));

    const todayKey = win.todayDate;
    const hydrationScore = scoreLogs(logs, target_ml, effectiveDays || 30);
    const score = num(hydrationScore.score);
    const grade = (() => { try { return wa.scoreGrade(score); } catch { return "—"; } })();
    const band = score >= 85 ? "Dialed in" : score >= 70 ? "Strong" : score >= 55 ? "Good" : score >= 35 ? "Building" : "Just begun";

    const drink_breakdown = (() => { try { return wa.computeDrinkBreakdown(logs); } catch { return []; } })();
    const daily_curve = (() => { try { return avgCurve(logs, target_ml, anchor.utcOffsetMinutes); } catch { return []; } })();
    const dow = (() => { try { return wa.computeDayOfWeek(logs, target_ml); } catch { return { best_day: null, worst_day: null }; } })();
    const circadian = (() => { try { return wa.computeCircadian(logs, target_ml); } catch { return null; } })();
    const personal_formula = (() => { try { return wa.computePersonalFormula({ logs, target_ml, score, dayCount: effectiveDays }); } catch { return null; } })();
    // aha_moments {type,title,body,proof} → add label (category) for the FE.
    const aha_moments = (() => { try { return (wa.computeAhaMoments(logs, hydrationScore, target_ml) || []).map((m) => ({ ...m, label: m.label || (m.type ? cap(m.type) : "Pattern") })); } catch { return []; } })();
    // generateAiReads → {champion,drag,pattern} → FLAT array [{kind,title,body}] (FE contract).
    let ai_reads = [];
    try {
      const r = (await wa.generateAiReads(logs, target_ml, hydrationScore, openai)) || {};
      ai_reads = [
        r.champion ? { kind: "champion", ...r.champion } : null,
        r.drag ? { kind: "drag", ...r.drag } : null,
        r.pattern ? { kind: "pattern", ...r.pattern } : null,
      ].filter(Boolean);
    } catch { ai_reads = []; }

    // Per-day series (raw ml drunk vs goal) — what the user wants to SEE ("4.5L this day").
    const byDate = dailyTotals(logs);
    const dateKeys = Object.keys(byDate).sort();
    const signal_points = dateKeys.map((d) => ({ date: d, ml: round(byDate[d]), pct: target_ml ? round((byDate[d] / target_ml) * 100) : 0, completed: byDate[d] >= target_ml }));
    const daily_logs = {};
    for (const d of dateKeys) daily_logs[d] = { has_log: true, ml: round(byDate[d]), completed: byDate[d] >= target_ml, pct: target_ml ? round((byDate[d] / target_ml) * 100) : 0 };

    // Stats (health-impact framing happens on the FE; here we ship the numbers).
    const daysLogged = dateKeys.length;
    const totalMl = dateKeys.reduce((a, d) => a + byDate[d], 0);
    const avgMl = daysLogged ? Math.round(totalMl / daysLogged) : 0;
    const bestDayMl = daysLogged ? Math.max(...dateKeys.map((d) => byDate[d])) : 0;
    const completedDays = dateKeys.filter((d) => byDate[d] >= target_ml).length;
    const completion = daysLogged ? Math.round((completedDays / daysLogged) * 100) : 0;
    const streak = currentStreak(byDate, target_ml, anchor?.utcOffsetMinutes || 0);

    // ── Per-weekday completion — "which days do I hit / miss my target most?" (a top user ask) ──
    // For each weekday across the window: how many days logged, how many hit the target, the hit-rate, and
    // the average intake. Surfaces the best/worst weekday by HIT-RATE (not just raw ml), so the coach can say
    // "you nail it on Sundays (4/4) but Mondays slip (1/4)". Pure from byDate — deterministic, no extra reads.
    const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dowAgg = Array.from({ length: 7 }, () => ({ logged: 0, hit: 0, ml: 0 }));
    for (const d of dateKeys) {
      const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
      if (wd < 0 || wd > 6) continue;
      dowAgg[wd].logged += 1;
      dowAgg[wd].ml += byDate[d];
      if (byDate[d] >= target_ml) dowAgg[wd].hit += 1;
    }
    const day_of_week = dowAgg
      .map((v, i) => ({ dow: DOW_NAMES[i], logged_days: v.logged, hit_days: v.hit, completion_pct: v.logged ? Math.round((v.hit / v.logged) * 100) : 0, avg_ml: v.logged ? Math.round(v.ml / v.logged) : 0 }))
      .filter((x) => x.logged_days > 0);
    const dowRanked = [...day_of_week].sort((a, b) => b.completion_pct - a.completion_pct || b.avg_ml - a.avg_ml);
    const best_dow = dowRanked[0] || null;
    const worst_dow = dowRanked.length > 1 ? dowRanked[dowRanked.length - 1] : null;

    // Lifetime/standard outputs (anchor-clamped) — quality per day = pct of goal (capped 100).
    const qualityByDate = {};
    for (const d of Object.keys(byDate)) { if (anchor.anchorDateStr && d < anchor.anchorDateStr) continue; qualityByDate[d] = Math.round(clamp((byDate[d] / Math.max(1, target_ml)) * 100, 0, 100)); }
    // Apple Health: water logged in Apple Health counts on days not logged in-app (MAX → never lowers; no HK → no change).
    try {
      const hkQ = await domainHealthQualityByDate(deviceId, 'water', anchor.anchorDateStr, win.todayDate);
      for (const [d, q] of Object.entries(hkQ)) { if (qualityByDate[d] == null || q > qualityByDate[d]) qualityByDate[d] = q; }
    } catch { /* no HK — parity */ }
    const std = computeStandardOutputs({ qualityByDate, todayDate: win.todayDate, anchorDate: anchor.anchorDateStr, daysSinceAnchor: win.daysSinceAnchor });

    res.set("Cache-Control", "private, max-age=60");
    // Fire both Apple Health reads concurrently (kicked off before either await) — halves HK latency.
    const _hkP = domainHealth(deviceId, 'water').catch(() => null);
    const _hkViewP = domainHealthView(deviceId, 'water', win.requestedDays).catch(() => null);
    return res.json({
      health: await _hkP,
      health_view: await _hkViewP, // Apple Health activity/weight
      range: days,
      period_days: effectiveDays,
      target_ml,
      volume_unit: getUnit(data), // user's display unit (ml|oz) — FE renders + coach speaks in it
      water_score: { score, label: hydrationScore.label, components: hydrationScore.components || {} },
      score_grade: { letter: grade, band },
      hero_insight: aha_moments[0] ? { headline: aha_moments[0].body || aha_moments[0].title } : null,
      stats: {
        days_logged: daysLogged, avg_ml: avgMl, best_day_ml: round(bestDayMl), total_ml: round(totalMl),
        completed_days: completedDays, completion, current_streak: streak,
        longest_streak: Math.max(num(data.longest_streak), streak), goal_ml: target_ml,
      },
      signal_points, daily_logs, daily_curve, drink_breakdown, circadian,
      best_day: dow.best_day, worst_day: dow.worst_day,
      day_of_week, best_dow, worst_dow,
      personal_formula, ai_reads, aha_moments,
      clinical_flag: hydrationScore.clinical_flag || null, clinical_note: hydrationScore.clinical_note || null,
      effective_start_date: win.effectiveStartDate, effective_days: effectiveDays,
      days_since_anchor: win.daysSinceAnchor, anchor_date: anchor.anchorDateStr, is_clamped: win.isClamped,
      score_today: std.score_today, score_7d_smoothed: std.score_7d_smoothed, score_lifetime: std.score_lifetime, missed_days: std.missed_days,
    });
  } catch (e) {
    log.error("[water.bc] /analysis:", e?.message || e);
    return res.status(500).json({ error: "analysis_failed", message: e?.message });
  }
});

// ── POST /log/from-photo — premium camera: estimate the drink + volume from one photo (analysis-only) ──
// Ported from the proven legacy vision prompt (7-step reasoning, same-photo→same-number determinism).
// Returns an estimate + adjustable volume buckets; the client confirms then calls /log. Never writes here.
const PHOTO_DRINKS = ["water", "sparkling", "herbal_tea", "tea", "milk", "juice", "coffee", "sport_drink", "soda", "alcohol", "other"];
// Same-photo determinism cache (mirrors the proven legacy water path): identical photo bytes ALWAYS
// return the identical answer with no re-call — kills the "same glass, 5 different numbers" bug.
const _photoCache = new Map(); // key → { value, exp }
const PHOTO_CACHE_TTL = 60 * 60 * 1000;
const photoCacheGet = (k) => { const e = _photoCache.get(k); if (!e) return null; if (Date.now() > e.exp) { _photoCache.delete(k); return null; } return e.value; };
const photoCacheSet = (k, v) => { _photoCache.set(k, { value: v, exp: Date.now() + PHOTO_CACHE_TTL }); if (_photoCache.size > 500) _photoCache.delete(_photoCache.keys().next().value); };
const round10 = (n) => Math.round(num(n) / 10) * 10;
const round50 = (n) => Math.round(num(n) / 50) * 50;
const WATER_VISION_PROMPT = [
  "ROLE: You are a precise volumetric vision system for hydration logging.",
  "TASK: Estimate the volume of LIQUID currently in the container in ONE photo (what they'll drink — the liquid, not the empty glass). Return STRICT JSON only.",
  "NOT-A-DRINK GUARD (do this FIRST): decide whether the photo actually shows a DRINK/BEVERAGE in a drinkable container. If it shows FOOD (a plate/bowl of food, a meal, snacks), a person, a room/scene, packaging, or an empty/dry vessel with no liquid → set is_drink=false, drink_type='water', estimated_ml=0, fill_percent=0, confidence=0, and STOP (do not invent a beverage or a volume for non-drinks). Only when a real drink is present set is_drink=true and do the volume chain below. NEVER label food as a drink.",
  "CORE PRINCIPLE: SAME PHOTO ⇒ SAME NUMBERS. Be a measurement instrument, not probabilistic.",
  "REASONING CHAIN (only when is_drink=true; do internally):",
  "1) SCALE ANCHOR: prefer a printed brand label with volume (Evian 500ml, Coke 330ml, Starbucks size = confidence 95+); else a hand in frame (adult finger ≈ 2cm); else standard objects (plate 26cm, card 8.5cm, phone 15cm); else typical-capacity table.",
  "2) VESSEL CLARITY: transparent (see the liquid surface) vs opaque (cannot).",
  "3) GEOMETRY: cylinder / frustum (wider top) / bottle-with-neck / wine glass / mug / can.",
  "4) CAPACITY of a FULL vessel: brand label > scale+shape math > typical table: espresso 60 · shot 45 · wine 180-250 · drinking glass 250 · mug 300 · large mug 400 · soda can 330 · tumbler 400 · paper cup 240/350/470 · pint 500 · water bottle 500 · sports bottle 700 · 1L 1000 · 1.5L 1500. Round to nearest 10.",
  "5) FILL %: transparent → measure the meniscus height (frustum/wine glass hold MORE liquid per cm near the top: bottom-half ≈ 25-35%, midpoint ≈ 40-50%, top-half ≈ 65-80%, rim ≈ 95-100%); opaque → steam=70-90%, rim=95-100%, no cue → 90%; empty/residue → 0-10%.",
  "6) DRINK TYPE by color+container: crystal clear→water · clear+bubbles→sparkling · pale amber→tea/herbal_tea · dark brown→coffee · cloudy white→milk · orange/red/purple→juice · caramel+fizz→soda · neon→sport_drink · foam head or red in wine glass→alcohol. Be decisive; if unsure coffee vs tea pick coffee + add 'drink_type' to unsure_about.",
  "7) SELF-CHECK: estimated_ml ≈ capacity × fill/100 (recompute if off by >15%); plausible for the vessel; ≤ brand_label.ml if a label is set.",
  "OUTPUT KEYS (all required): is_drink(bool — false for food/non-beverage photos), drink_type, container_type, vessel_clarity, container_capacity_ml(int), fill_percent(0-100), estimated_ml(int = round10(capacity×fill/100)), confidence(0-100), brand_label(null|{name,ml}), unsure_about(subset of [drink_type,capacity,fill]), reasoning(≤24 words). Return the JSON object only.",
].join("\n");
const WATER_VISION_SCHEMA = {
  type: "object",
  properties: {
    is_drink: { type: "boolean" },
    drink_type: { type: "string", enum: PHOTO_DRINKS },
    container_type: { type: "string", enum: ["glass", "bottle", "mug", "can", "sports_bottle", "wine_glass", "paper_cup", "tumbler", "other"] },
    vessel_clarity: { type: "string", enum: ["transparent", "opaque"] },
    container_capacity_ml: { type: "integer" },
    fill_percent: { type: "integer" },
    estimated_ml: { type: "integer" },
    confidence: { type: "integer" },
    brand_label: { type: "object", nullable: true, properties: { name: { type: "string" }, ml: { type: "integer" } } },
    unsure_about: { type: "array", items: { type: "string", enum: ["drink_type", "capacity", "fill"] } },
    reasoning: { type: "string" },
  },
  required: ["is_drink", "drink_type", "container_type", "vessel_clarity", "container_capacity_ml", "fill_percent", "estimated_ml", "confidence", "unsure_about", "reasoning"],
};
router.post("/log/from-photo", async (req, res) => {
  const b = req.body || {};
  const { deviceId, shot_b64 } = b;
  if (!deviceId || !shot_b64) return res.status(400).json({ error: "deviceId + shot_b64 required" });
  try {
    // Same photo → same answer (determinism cache).
    const cacheKey = hashImages(deviceId, [shot_b64]);
    const hit = photoCacheGet(cacheKey);
    if (hit) return res.json({ ...hit, cached: true });

    // Gemini 2.5 Pro PRIMARY — greedy-decoded (temp 0 / topK 1) so re-shoots of the SAME glass return the
    // SAME volume; the legacy water agent proved it's the most accurate + deterministic for liquids. Falls
    // back to OpenAI gpt-4o when there's no GEMINI_API_KEY or Gemini errors. Post-processing below clamps &
    // self-checks every field regardless of which model answered, so a slightly-off shape can't slip through.
    let p = await callGeminiVision({
      systemPrompt: WATER_VISION_PROMPT,
      userText: "Analyze this drink photo. Work the 7-step chain internally, then emit the JSON.",
      images: [shot_b64],
      maxOutputTokens: 600,
      label: "water-photo",
    });
    if (!p || typeof p !== "object") {
      const completion = await openai.chat.completions.create({
        model: (MODELS && MODELS.cameraPrimary) || "gpt-4o",
        max_completion_tokens: 600,
        messages: [
          { role: "system", content: WATER_VISION_PROMPT },
          { role: "user", content: [
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${shot_b64}`, detail: "high" } },
            { type: "text", text: "Analyze this drink photo. Work the 7-step chain internally, then emit the JSON." },
          ] },
        ],
        response_format: { type: "json_schema", json_schema: { name: "water_drink_log", strict: true, schema: openaiStrict ? openaiStrict(WATER_VISION_SCHEMA) : WATER_VISION_SCHEMA } },
      });
      const raw = (completion.choices[0].message.content || "{}").trim().replace(/```json|```/g, "");
      p = JSON.parse(raw);
    }
    // NOT A DRINK (e.g. they pointed the drink scanner at food): never fabricate "10ml of tea" — tell the
    // FE so it can say "that's not a drink" and offer the manual amount picker instead.
    if (p.is_drink === false || (num(p.estimated_ml) <= 0 && num(p.fill_percent) <= 0)) {
      const nd = { no_drink: true };
      photoCacheSet(cacheKey, nd);
      return res.json(nd);
    }
    const drink_type = safeDrink(PHOTO_DRINKS.includes(p.drink_type) ? p.drink_type : "water");
    const capacity = clamp(round10(p.container_capacity_ml), 30, 2000);
    const fill = clamp(num(p.fill_percent), 0, 100);
    let estimated_ml = round10(p.estimated_ml);
    const computed = round10((capacity * fill) / 100);
    if (Math.abs(estimated_ml - computed) > Math.max(20, computed * 0.15)) estimated_ml = computed;
    estimated_ml = clamp(estimated_ml, 10, 2000);
    // 3 adjustable buckets around the estimate for the confirm card.
    const buckets = [...new Set([round50(estimated_ml * 0.8), round50(estimated_ml), round50(estimated_ml * 1.2)].filter((x) => x >= 50 && x <= 2000))].sort((a, c) => a - c);
    const result = {
      drink_type, container_type: p.container_type || "glass", estimated_ml,
      container_capacity_ml: capacity, fill_percent: fill,
      volume_buckets: buckets, range_low_ml: buckets[0], range_high_ml: buckets[buckets.length - 1],
      confidence: clamp(num(p.confidence, 60), 0, 100),
      brand_label: p.brand_label && p.brand_label.ml ? { name: String(p.brand_label.name || "").slice(0, 40), ml: round10(p.brand_label.ml) } : null,
      unsure_about: Array.isArray(p.unsure_about) ? p.unsure_about.filter((x) => ["drink_type", "capacity", "fill"].includes(x)) : [],
      reasoning: String(p.reasoning || "").slice(0, 140),
    };
    photoCacheSet(cacheKey, result);
    return res.json(result);
  } catch (e) {
    log.error("[water.bc] /log/from-photo:", e?.message || e);
    return res.status(500).json({ error: "vision_failed" });
  }
});

module.exports = router;
