"use strict";
// ════════════════════════════════════════════════════════════════════════════
// sleep.bc.agent.js — BIG-CHANGE Sleep backend. Mirrors nutrition.bc.agent.js:
//   • bc namespace: wellness_bc_users/{id}/agents/sleep/* (sleep_logs)
//   • /analysis REUSES lib/sleep-analytics.loadAnalysisV2 via opts.sleepDocRef + clampStartDate,
//     producing the SAME payload shape as legacy (so the FE port is 1:1). Legacy file untouched.
//   • Registration-anchor clamp (resolveAnchor → computeAnalysisWindow → computeStandardOutputs),
//     log-guard on /log, per-agent sandbox (reads only its own agents/sleep/*).
//   • Mounted at /api/sleep BEFORE the legacy router → bc owns log/today/analysis; legacy falls
//     through for describe/logs/setup/chat.
// ════════════════════════════════════════════════════════════════════════════
const express = require("express");
const admin = require("firebase-admin");
const { OpenAI } = require("openai");
const { OPENAI_TIMEOUT_MS } = require("./lib/model-router");
const { resolveAnchor } = require("./lib/user-anchor");
const { computeAnalysisWindow } = require("./lib/range-helpers");
const { computeStandardOutputs } = require("./lib/score-lifetime");
const _sleepAnalytics = require("./lib/sleep-analytics");
const { userDoc: bcUserDoc } = require("./lib/collections");
const { domainHealth, domainHealthView, domainHealthQualityByDate } = require("./lib/hk-domain"); // Apple Health sleep + recovery (null if no HK)

const router = express.Router();
const db = () => admin.firestore();
const ts = () => admin.firestore.FieldValue.serverTimestamp();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: OPENAI_TIMEOUT_MS });
const log = globalThis.log || console;

// ── bc collection helpers (mirror nutrition.bc.agent.js) ─────────────────────
const sleepDoc = (id) => bcUserDoc(id).collection("agents").doc("sleep"); // → wellness_bc_users/{id}/agents/sleep
const logsCol = (id) => sleepDoc(id).collection("sleep_logs"); // SAME subcol name the analytics lib reads

// ── helpers ──────────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, "0");
const dateStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const getMillis = (t) => (t && typeof t.toMillis === "function" ? t.toMillis() : typeof t === "number" ? t : 0);

// Metric derivation — COPIED verbatim from legacy sleep.agent.js so bc numbers match exactly.
const timeToMins = (hm) => { const [h, m] = String(hm || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const calcTimeInBed = (bedtime, wake_time) => {
  let bedMins = timeToMins(bedtime);
  let wakeMins = timeToMins(wake_time);
  if (wakeMins <= bedMins) wakeMins += 24 * 60; // crossed midnight
  return (wakeMins - bedMins) / 60;
};
const calcTotalSleep = (timeInBed, latencyMins, nightWakings) => {
  const latencyHrs = (latencyMins || 0) / 60;
  const wakingHrs = (nightWakings || 0) * (20 / 60); // 20-min-per-waking estimate
  return Math.max(0, timeInBed - latencyHrs - wakingHrs);
};
const calcEfficiency = (totalSleep, timeInBed) => (!timeInBed ? 0 : Math.round((totalSleep / timeInBed) * 100));

// Sanitize the optional phone-sensed payload (Phase 3 native sensing) into a bounded, safe shape.
// Returns null for any non-object input so manual logs simply carry no `sensed`.
const clampNum = (v, lo, hi, d = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
function sanitizeSensed(s) {
  if (!s || typeof s !== "object") return null;
  const out = {
    snore_minutes: clampNum(s.snore_minutes, 0, 1440, 0),
    snore_events: Math.round(clampNum(s.snore_events, 0, 100000, 0)),
    movement_index: Math.round(clampNum(s.movement_index, 0, 100, 0)),
    ambient_db_avg: clampNum(s.ambient_db_avg, -160, 40, -160),
    ambient_db_peak: clampNum(s.ambient_db_peak, -160, 40, -160),
    estimated_sleep_min: Math.round(clampNum(s.estimated_sleep_min, 0, 1440, 0)),
    restless_epochs: Math.round(clampNum(s.restless_epochs, 0, 100000, 0)),
    total_epochs: Math.round(clampNum(s.total_epochs, 0, 100000, 0)),
    duration_min: Math.round(clampNum(s.duration_min, 0, 1440, 0)),
  };
  // Rich extras (hypnogram + snore graph + clips) — bounded so a bad payload can't bloat the doc.
  if (s.stage_minutes && typeof s.stage_minutes === "object") {
    out.stage_minutes = {
      awake: Math.round(clampNum(s.stage_minutes.awake, 0, 1440, 0)),
      light: Math.round(clampNum(s.stage_minutes.light, 0, 1440, 0)),
      deep: Math.round(clampNum(s.stage_minutes.deep, 0, 1440, 0)),
      rem: Math.round(clampNum(s.stage_minutes.rem, 0, 1440, 0)),
    };
  }
  out.cycles = Math.round(clampNum(s.cycles, 0, 30, 0));
  if (Array.isArray(s.timeline)) {
    out.timeline = s.timeline.slice(0, 200).map((e) => ({
      moving: !!(e && e.moving),
      mvi: Math.round(clampNum(e && e.mvi, 0, 100, 0)),
      snoreSec: clampNum(e && e.snoreSec, 0, 60, 0),
      db: clampNum(e && e.db, -160, 40, -160),
    }));
  }
  if (Array.isArray(s.clips)) {
    out.clips = s.clips.slice(0, 24).map((c) => ({
      path: typeof c?.path === "string" ? c.path.slice(0, 400) : "",
      atISO: typeof c?.atISO === "string" ? c.atISO.slice(0, 40) : "",
      peakDb: clampNum(c?.peakDb, -160, 40, -160),
      durationSec: clampNum(c?.durationSec, 0, 120, 0),
      kind: c?.kind === "noise" ? "noise" : "snore",
    })).filter((c) => c.path);
  }
  // De-duplicated snore EPISODES (single source of truth — snore_events === episodes.length). Bounded.
  const INTENSITIES = ["quiet", "light", "loud", "epic"];
  if (Array.isArray(s.snore_episodes)) {
    out.snore_episodes = s.snore_episodes.slice(0, 250).map((e) => ({
      startMs: Math.round(clampNum(e?.startMs, 0, 9e12, 0)),
      durationMs: Math.round(clampNum(e?.durationMs, 0, 600000, 0)),
      peakDb: clampNum(e?.peakDb, -160, 40, -160),
      intensity: INTENSITIES.includes(e?.intensity) ? e.intensity : "light",
    }));
  }
  if (s.snore_intensity && typeof s.snore_intensity === "object") {
    out.snore_intensity = {
      quiet: Math.round(clampNum(s.snore_intensity.quiet, 0, 100000, 0)),
      light: Math.round(clampNum(s.snore_intensity.light, 0, 100000, 0)),
      loud: Math.round(clampNum(s.snore_intensity.loud, 0, 100000, 0)),
      epic: Math.round(clampNum(s.snore_intensity.epic, 0, 100000, 0)),
    };
  }
  if (s.snore_runs != null) out.snore_runs = Math.round(clampNum(s.snore_runs, 0, 100000, 0));
  return out;
}

// ── POST /log — log a night's sleep (manual / voice). bc-namespaced. ──────────
router.post("/log", async (req, res) => {
  const b = req.body || {};
  const { deviceId, bedtime, wake_time } = b;
  if (!deviceId || !bedtime || !wake_time) return res.status(400).json({ error: "deviceId, bedtime, wake_time required" });
  try {
    // 🚨 ANCHOR GUARD: never store a night dated before registration or in the future.
    const anchor = await resolveAnchor(deviceId);
    let date;
    try {
      // A night is dated by its bedtime; a brand-new user logging "last night" may pass a date one day
      // before signup — clamp it to the registration day rather than rejecting (still never before signup).
      let req = b.date_str || b.date || dateStr();
      if (anchor.anchorDateStr && typeof req === "string" && req < anchor.anchorDateStr) req = anchor.anchorDateStr;
      date = require("./lib/log-guard").assertLoggableDate(req, anchor);
    } catch (e) { return require("./lib/log-guard").sendLogGuardError(res, e); }

    // For SENSOR logs the phone measured the real elapsed time → use it directly. The bedtime→wake
    // clock math (with its "crossed midnight" +24h rule) is only correct for overnight MANUAL logs; a
    // short sensor session whose start/end land in the same minute would otherwise wrap to ~24h.
    const sensedDurMin = b.source === "sensor" && b.sensed ? num(b.sensed.duration_min) : 0;
    let timeInBed, totalSleep;
    if (sensedDurMin > 0) {
      timeInBed = sensedDurMin / 60;
      const sensedSleepMin = num(b.sensed.estimated_sleep_min);
      totalSleep = sensedSleepMin > 0 ? sensedSleepMin / 60 : calcTotalSleep(timeInBed, num(b.sleep_latency), num(b.night_wakings));
    } else {
      timeInBed = calcTimeInBed(bedtime, wake_time);
      totalSleep = calcTotalSleep(timeInBed, num(b.sleep_latency), num(b.night_wakings));
    }
    const efficiency = calcEfficiency(totalSleep, timeInBed);

    const logData = {
      date_str: date,
      bedtime, wake_time,
      sleep_quality: Math.max(1, Math.min(5, num(b.sleep_quality, 3))),
      sleep_latency: Math.max(0, num(b.sleep_latency)),
      night_wakings: Math.max(0, num(b.night_wakings)),
      morning_energy: Math.max(1, Math.min(5, num(b.morning_energy, 3))),
      disruptors: Array.isArray(b.disruptors) ? b.disruptors.filter((d) => d && d !== "None").slice(0, 14) : [],
      note: typeof b.note === "string" ? b.note.slice(0, 500) : "",
      time_in_bed: parseFloat(timeInBed.toFixed(2)),
      total_sleep_hours: parseFloat(totalSleep.toFixed(2)),
      sleep_efficiency: efficiency,
      source: ["manual", "voice", "healthkit", "sensor"].includes(b.source) ? b.source : "manual",
      // Phone-sensed metrics (Phase 3 native sensing). Optional — manual logs omit it. Stored as a
      // bounded, sanitized object so a bad client payload can never poison the doc.
      sensed: sanitizeSensed(b.sensed),
      logged_at: ts(),
      created_at: ts(),
    };

    // Streak (parity with nutrition.bc /log): advance on a contiguous day, hold same-day, else reset.
    const nutSnap = await sleepDoc(deviceId).get();
    const nut = nutSnap.exists ? nutSnap.data() : {};
    // "Yesterday" in the user's LOCAL timezone (last_log_date/date are user-local) — UTC would mis-reset.
    const yesterday = require("./lib/range-helpers").dateStr(new Date(Date.now() - 86400000), anchor.utcOffsetMinutes || 0);
    const newStreak = (nut.last_log_date === yesterday || nut.last_log_date === date)
      ? (nut.last_log_date === date ? num(nut.streak, 1) : num(nut.streak, 0) + 1)
      : 1;

    const ref = logsCol(deviceId).doc();
    const batch = db().batch();
    batch.set(ref, logData);
    batch.set(sleepDoc(deviceId), { last_log_date: date, streak: newStreak, updated_at: ts() }, { merge: true });
    await batch.commit();

    return res.json({
      success: true,
      id: ref.id,
      streak: newStreak,
      metrics: { time_in_bed: logData.time_in_bed, total_sleep_hours: logData.total_sleep_hours, sleep_efficiency: efficiency },
    });
  } catch (e) {
    log.error("[sleep.bc] /log:", e?.message || e);
    return res.status(500).json({ error: "server error" });
  }
});

// ── GET /today — most recent night + targets + a quick 7-night summary ────────
router.get("/today", async (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const [recentSnap, sleepSnap] = await Promise.all([
      logsCol(deviceId).orderBy("logged_at", "desc").limit(7).get().catch(() => ({ docs: [] })),
      sleepDoc(deviceId).get(),
    ]);
    const s = sleepSnap.exists ? sleepSnap.data() : {};
    const nights = recentSnap.docs.map((d) => {
      const m = d.data();
      return {
        id: d.id, date_str: m.date_str, bedtime: m.bedtime, wake_time: m.wake_time,
        sleep_quality: num(m.sleep_quality), morning_energy: num(m.morning_energy),
        total_sleep_hours: num(m.total_sleep_hours), sleep_efficiency: num(m.sleep_efficiency),
        night_wakings: num(m.night_wakings), sleep_latency: num(m.sleep_latency),
        disruptors: Array.isArray(m.disruptors) ? m.disruptors : [],
        source: m.source || "manual", sensed: m.sensed || null,
      };
    });
    const last = nights[0] || null;
    const avg = (arr) => (arr.length ? arr.reduce((a, x) => a + x, 0) / arr.length : 0);
    return res.json({
      health_view: await domainHealthView(deviceId, 'sleep', 7).catch(() => null), // Apple Health Body Signals (today tiles)
      date: dateStr(),
      last_night: last,
      week: {
        nights_logged: nights.length,
        avg_hours: +avg(nights.map((n) => n.total_sleep_hours)).toFixed(1),
        avg_efficiency: Math.round(avg(nights.map((n) => n.sleep_efficiency))),
      },
      targets: {
        target_sleep_hours: num(s.target_sleep_hours ?? s.setup?.target_hours ?? s.target_hours, 8),
        target_bedtime: s.target_bedtime || s.setup?.target_bedtime || "23:00",
      },
      streak: num(s.streak),
    });
  } catch (e) {
    log.error("[sleep.bc] /today:", e?.message || e);
    return res.status(500).json({ error: "server error" });
  }
});

// ── POST /log/delete — undo a logged night ───────────────────────────────────
router.post("/log/delete", async (req, res) => {
  const { deviceId, id } = req.body || {};
  if (!deviceId || !id) return res.status(400).json({ error: "deviceId + id required" });
  try {
    await logsCol(deviceId).doc(String(id)).delete();
    return res.json({ success: true });
  } catch (e) {
    log.error("[sleep.bc] /log/delete:", e?.message || e);
    return res.status(500).json({ error: "server error" });
  }
});

// ── GET /analysis — FULL Insights payload (SAME shape as legacy) ──────────────
// Reuses lib/sleep-analytics.loadAnalysisV2 pointed at the bc namespace via sleepDocRef + clampStartDate,
// plus the registration-anchor window clamp + lifetime score outputs (mirrors legacy sleep /analysis).
router.get("/analysis", async (req, res) => {
  try {
    const { deviceId, range } = req.query;
    if (!deviceId) return res.status(400).json({ error: "deviceId required" });
    const days = (() => { const n = parseInt(range, 10); return Number.isFinite(n) && n > 0 && n <= 730 ? n : null; })();

    const sleepSnap = await sleepDoc(deviceId).get();
    const sdata = sleepSnap.exists ? sleepSnap.data() : {};
    const target = num(sdata.target_sleep_hours ?? sdata.setup?.target_hours ?? sdata.target_hours, 8);

    const nowMs = Date.now();
    const anchor = await resolveAnchor(deviceId);
    const win = computeAnalysisWindow(days || 30, anchor.anchorMs, nowMs, anchor.utcOffsetMinutes);
    // Always a NUMBER (default 30-day window) so the FE's period_days math never hits null — matches the
    // other agents. (Was null when the range param was omitted.)
    const effectiveDays = win.effectiveDays;

    const payload = await _sleepAnalytics.loadAnalysisV2(deviceId, effectiveDays, {
      openai, targetHours: target,
      sleepDocRef: sleepDoc(deviceId), // bc namespace
      clampStartDate: win.effectiveStartDate, // never count pre-registration nights
    });
    const body = payload || { stats: null, signal_points: [], aha_moments: [] };

    // Lifetime per-night quality map (for score_lifetime), clamped to the anchor — bc namespace.
    const lifetimeQualityByDate = await (async () => {
      const out = {};
      if (!anchor.anchorMs) return out;
      try {
        const snap = await logsCol(deviceId).orderBy("logged_at", "desc").limit(Math.min(win.daysSinceAnchor * 3, 1000)).get();
        const byDate = {};
        for (const d of snap.docs) {
          const l = d.data();
          const ds = l.date_str;
          if (!ds || typeof ds !== "string") continue;
          if (anchor.anchorDateStr && ds < anchor.anchorDateStr) continue;
          if (!byDate[ds]) byDate[ds] = { qs: [], hs: [] };
          byDate[ds].qs.push(num(l.sleep_quality, 3));
          byDate[ds].hs.push(num(l.total_sleep_hours));
        }
        for (const [ds, bd] of Object.entries(byDate)) {
          const q = bd.qs.reduce((a, x) => a + x, 0) / bd.qs.length;
          const h = bd.hs.reduce((a, x) => a + x, 0) / bd.hs.length;
          const qPart = Math.max(0, Math.min(100, (q / 5) * 100));
          const hPart = Math.max(0, Math.min(100, (Math.min(h, target) / target) * 100));
          out[ds] = Math.round(qPart * 0.5 + hPart * 0.5);
        }
      } catch { /* empty */ }
      return out;
    })();

    // Apple Health: device-measured sleep counts toward the score even on nights the user didn't log (MAX → never lowers a logged night; no HK → no change).
    try {
      const hkQ = await domainHealthQualityByDate(deviceId, 'sleep', anchor.anchorDateStr, win.todayDate);
      for (const [d, q] of Object.entries(hkQ)) { if (lifetimeQualityByDate[d] == null || q > lifetimeQualityByDate[d]) lifetimeQualityByDate[d] = q; }
    } catch { /* no HK — parity */ }

    const std = computeStandardOutputs({
      qualityByDate: lifetimeQualityByDate,
      todayDate: win.todayDate,
      anchorDate: anchor.anchorDateStr,
      daysSinceAnchor: win.daysSinceAnchor,
    });

    // ── Snoring/movement trends from phone-SENSED nights (Phase-3) — clamped to the anchor. This is how
    // the multi-night analysis actually USES the sensor data, not just the single-night card. ──
    const snoring = await (async () => {
      try {
        const snap = await logsCol(deviceId).orderBy("logged_at", "desc").limit(Math.min((win.daysSinceAnchor || 30) * 2, 400)).get();
        const points = [];
        let nightsSensed = 0, nightsSnored = 0, totalSnoreMin = 0, peakSnoreMin = 0, totalMoveIdx = 0;
        for (const d of snap.docs) {
          const l = d.data();
          const ds = l.date_str;
          if (!ds || (anchor.anchorDateStr && ds < anchor.anchorDateStr)) continue;
          const s = l.sensed;
          if (!s || typeof s !== "object") continue;
          nightsSensed++;
          const sm = num(s.snore_minutes), se = num(s.snore_events);
          if (sm >= 1 || se > 0) nightsSnored++;
          totalSnoreMin += sm;
          peakSnoreMin = Math.max(peakSnoreMin, sm);
          totalMoveIdx += num(s.movement_index);
          points.push({ date: ds, snore_min: Math.round(sm * 10) / 10, snore_events: Math.round(se) });
        }
        if (!nightsSensed) return null;
        points.sort((a, b) => (a.date < b.date ? -1 : 1));
        const avg = (arr) => (arr.length ? arr.reduce((a, x) => a + x, 0) / arr.length : 0);
        const recent = avg(points.slice(-3).map((p) => p.snore_min));
        const prior = avg(points.slice(-6, -3).map((p) => p.snore_min));
        const trend = points.length < 4 ? "flat" : recent > prior + 2 ? "up" : recent < prior - 2 ? "down" : "flat";
        return {
          nights_sensed: nightsSensed,
          nights_snored: nightsSnored,
          avg_snore_min: Math.round((totalSnoreMin / nightsSensed) * 10) / 10,
          total_snore_min: Math.round(totalSnoreMin),
          peak_snore_min: Math.round(peakSnoreMin),
          avg_movement: Math.round(totalMoveIdx / nightsSensed),
          points: points.slice(-30),
          trend,
        };
      } catch { return null; }
    })();

    res.set("Cache-Control", "private, max-age=60");
    // Fire both Apple Health reads concurrently (kicked off before either await) — halves HK latency.
    const _hkP = domainHealth(deviceId, 'sleep').catch(() => null);
    const _hkViewP = domainHealthView(deviceId, 'sleep', win.requestedDays).catch(() => null);
    return res.json({
      ...body,
      effective_start_date: win.effectiveStartDate,
      effective_days: effectiveDays,
      days_since_anchor: win.daysSinceAnchor,
      anchor_date: anchor.anchorDateStr,
      is_clamped: win.isClamped,
      score_today: std.score_today,
      score_7d_smoothed: std.score_7d_smoothed,
      score_lifetime: std.score_lifetime,
      missed_days: std.missed_days,
      snoring, // phone-sensed snoring/movement trends across nights (null until sensor logs exist)
      health: await _hkP,
      health_view: await _hkViewP, // Apple Health sleep + recovery
    });
  } catch (e) {
    log.error("[sleep.bc] /analysis:", e?.message || e);
    return res.status(500).json({ error: "analysis_failed", message: e?.message });
  }
});

// REMAINING (later): /coach, /chat, /encourage. /describe falls through to the legacy router.
module.exports = router;
