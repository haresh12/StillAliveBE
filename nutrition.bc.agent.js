"use strict";
// ════════════════════════════════════════════════════════════════════════════
// nutrition.bc.agent.js — BIG-CHANGE Nutrition backend. Mirrors fitness.agent.js:
//   • bc namespace: wellness_bc_users/{id}/agents/nutrition/* (food_logs, nutrition_chats)
//   • targets read from the bc onboarding-seeded nutrition doc (top-level calorie_target etc.)
//   • /analysis REUSES the shared lib/nutrition-analytics.js via opts.nutDocRef + opts.cacheNs,
//     producing the SAME payload shape as legacy (so the FE port is 1:1). Legacy file untouched.
//   • Mounted at /api/nutrition BEFORE the legacy router → bc owns log/today/analysis; the legacy
//     router falls through for vision/describe compute (which just returns items). Per-agent
//     sandbox law: reads only its own agents/nutrition/*.
// ════════════════════════════════════════════════════════════════════════════
const express = require("express");
const admin = require("firebase-admin");
const { OpenAI } = require("openai");
const { MODELS, OPENAI_TIMEOUT_MS } = require("./lib/model-router");
const { resolveAnchor } = require("./lib/user-anchor");
const { computeAnalysisWindow } = require("./lib/range-helpers");
const { computeStandardOutputs } = require("./lib/score-lifetime");
const { assertLoggableDate, sendLogGuardError } = require("./lib/log-guard");
const _nutritionAnalytics = require("./lib/nutrition-analytics");
const { userDoc: bcUserDoc } = require("./lib/collections");
const { domainHealth, domainHealthView } = require("./lib/hk-domain"); // Apple Health activity/weight (null if no HK)

const router = express.Router();
const db = () => admin.firestore();
const ts = () => admin.firestore.FieldValue.serverTimestamp();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: OPENAI_TIMEOUT_MS });
const log = globalThis.log || console;

// ── bc collection helpers (mirror fitness.agent.js) ──────────────────────────
const userDoc = (id) => bcUserDoc(id); // → wellness_bc_users/{id}
const nutritionDoc = (id) => userDoc(id).collection("agents").doc("nutrition");
const foodLogsCol = (id) => nutritionDoc(id).collection("food_logs"); // SAME subcol name the analytics lib reads
const chatsCol = (id) => nutritionDoc(id).collection("nutrition_chats");

// ── helpers ──────────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, "0");
const dateStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const getMillis = (t) => (t && typeof t.toMillis === "function" ? t.toMillis() : typeof t === "number" ? t : 0);
const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"];
const SOURCES = ["manual", "vision", "voice", "saved", "barcode"];

// Food-quality score (0-100) — copied from the legacy agent so bc day-quality matches exactly.
function _computeFoodQuality({ calories = 0, protein = 0, carbs = 0, fat = 0, food_name = "" }) {
  if (calories < 5) return 50;
  const totalMacroCal = protein * 4 + carbs * 4 + fat * 9;
  if (totalMacroCal < 5) return 50;
  const pDensity = (protein * 100) / Math.max(calories, 1);
  const pScore = pDensity >= 8 ? 100 : pDensity >= 5 ? 80 : pDensity >= 3 ? 60 : pDensity >= 1.5 ? 40 : 20;
  const pCal = protein * 4, cCal = carbs * 4, fCal = fat * 9;
  const balanceRatio = Math.min(pCal, cCal, fCal) / totalMacroCal;
  const bScore = balanceRatio >= 0.2 ? 100 : balanceRatio >= 0.12 ? 75 : balanceRatio >= 0.05 ? 50 : 30;
  const name = (food_name || "").toLowerCase();
  const junk = /\b(soda|coke|pepsi|sprite|candy|chip|crisp|donut|doughnut|cookie|cake|pastry|fries|burger king|mcdonald|kfc|cheeto|dorito|pop ?tart|ice cream|gummy|sugar|syrup|sweetened)\b/;
  const whole = /\b(salmon|chicken breast|tuna|cod|tilapia|egg|broccoli|spinach|kale|quinoa|oats|oatmeal|lentil|bean|chickpea|tofu|tempeh|sweet potato|brown rice|avocado|berries|blueberr|strawberr|nuts|almond|walnut|greek yogurt|cottage cheese|sardine)\b/;
  let nScore = 60;
  if (junk.test(name)) nScore = 25;
  if (whole.test(name)) nScore = 95;
  return Math.max(0, Math.min(100, Math.round(pScore * 0.5 + bScore * 0.25 + nScore * 0.25)));
}
const invalidate = (deviceId) => { try { _nutritionAnalytics.lruInvalidatePrefix(`bc${deviceId}::`); } catch { /* non-fatal */ } };

// Normalize one incoming food item → the legacy-shaped stored doc the analytics reads.
function cleanItem(it, meal_type, source, date) {
  const calories = Math.max(0, Math.round(num(it.calories)));
  const protein = Math.max(0, Math.round(num(it.protein) * 10) / 10);
  const carbs = Math.max(0, Math.round(num(it.carbs) * 10) / 10);
  const fat = Math.max(0, Math.round(num(it.fat) * 10) / 10);
  const food_name = String(it.food_name || it.name || "Food").slice(0, 120);
  return {
    food_name,
    emoji: typeof it.emoji === "string" && it.emoji ? it.emoji.slice(0, 4) : "🍽️",
    calories, protein, carbs, fat,
    quantity: num(it.quantity, 1),
    unit: String(it.unit || "serving").slice(0, 16),
    meal_type, source, date_str: date,
    food_quality_score: _computeFoodQuality({ calories, protein, carbs, fat, food_name }),
    logged_at: ts(),
    created_at: ts(),
  };
}

// ── POST /log — log one OR many food items (manual / vision / voice / saved) ──
router.post("/log", async (req, res) => {
  const b = req.body || {};
  const { deviceId } = b;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    // 🚨 ANCHOR GUARD (parity with bc fitness + legacy nutrition /log): never store a log dated BEFORE
    // registration or in the FUTURE — an unclamped write silently poisons lifetime/streak/score math.
    const anchor = await resolveAnchor(deviceId);
    let date;
    try { date = assertLoggableDate(b.date_str || b.date || dateStr(), anchor); }
    catch (e) { return sendLogGuardError(res, e); }
    const meal_type = MEAL_TYPES.includes(b.meal_type) ? b.meal_type : "snack";
    const source = SOURCES.includes(b.source) ? b.source : "manual";
    const items = Array.isArray(b.items) && b.items.length ? b.items : [b];

    // Streak (parity with legacy nutrition /log): advance on a contiguous day, hold on same-day, reset
    // otherwise. Read BEFORE the batch so we can write the new value alongside last_log_date.
    const nutSnap = await nutritionDoc(deviceId).get();
    const nut = nutSnap.exists ? nutSnap.data() : {};
    const lastLog = nut.last_log_date;
    // "Yesterday" in the user's LOCAL timezone — last_log_date/date are user-local, so a UTC yesterday
    // would wrongly reset the streak at the day boundary off-UTC.
    const yesterday = require("./lib/range-helpers").dateStr(new Date(Date.now() - 86400000), anchor.utcOffsetMinutes || 0);
    const newStreak = (lastLog === yesterday || lastLog === date)
      ? (lastLog === date ? (num(nut.streak, 1)) : num(nut.streak, 0) + 1)
      : 1;

    const batch = db().batch();
    const ids = [];
    items.forEach((it) => {
      const ref = foodLogsCol(deviceId).doc();
      ids.push(ref.id);
      batch.set(ref, cleanItem(it, meal_type, source, date));
    });
    batch.set(nutritionDoc(deviceId), { last_log_date: date, streak: newStreak, updated_at: ts() }, { merge: true });
    await batch.commit();
    invalidate(deviceId);
    return res.json({ success: true, ids, streak: newStreak });
  } catch (e) {
    log.error("[nutrition.bc] /log:", e?.message || e);
    return res.status(500).json({ error: "server error" });
  }
});

// ── GET /today — today's meals + running totals + the user's targets ─────────
router.get("/today", async (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    // "Today" in the user's LOCAL day — /log writes the user-local date_str, so a bare UTC dateStr()
    // showed the wrong/empty day off-UTC. Mirror the write path.
    const anchor = await resolveAnchor(deviceId);
    const { dateStr: tzDateStr } = require("./lib/range-helpers");
    const today = tzDateStr(new Date(), anchor?.utcOffsetMinutes || 0);
    const [mealsSnap, nutSnap] = await Promise.all([
      foodLogsCol(deviceId).where("date_str", "==", today).get().catch(() => ({ docs: [] })),
      nutritionDoc(deviceId).get(),
    ]);
    const nut = nutSnap.exists ? nutSnap.data() : {};
    const meals = mealsSnap.docs
      .map((d) => {
        const m = d.data();
        return {
          id: d.id, food_name: m.food_name, emoji: m.emoji, meal_type: m.meal_type,
          calories: num(m.calories), protein: num(m.protein), carbs: num(m.carbs), fat: num(m.fat),
          quantity: num(m.quantity, 1), unit: m.unit, logged_at_ms: getMillis(m.logged_at),
        };
      })
      .sort((a, b) => a.logged_at_ms - b.logged_at_ms);
    const totals = meals.reduce(
      (t, m) => ({ calories: t.calories + m.calories, protein: t.protein + m.protein, carbs: t.carbs + m.carbs, fat: t.fat + m.fat }),
      { calories: 0, protein: 0, carbs: 0, fat: 0 },
    );
    return res.json({
      health_view: await domainHealthView(deviceId, 'nutrition', 7).catch(() => null), // Apple Health Body Signals (today tiles)
      date: today,
      meals,
      totals: { calories: Math.round(totals.calories), protein: Math.round(totals.protein), carbs: Math.round(totals.carbs), fat: Math.round(totals.fat) },
      targets: {
        calorie_target: num(nut.calorie_target, 2000),
        protein_target: num(nut.protein_target, 140),
        carb_target: num(nut.carb_target, 250),
        fat_target: num(nut.fat_target, 65),
        water_target_cups: num(nut.water_target_cups, 8),
      },
    });
  } catch (e) {
    log.error("[nutrition.bc] /today:", e?.message || e);
    return res.status(500).json({ error: "server error" });
  }
});

// ── POST /log/delete — undo a logged item ────────────────────────────────────
router.post("/log/delete", async (req, res) => {
  const { deviceId, id } = req.body || {};
  if (!deviceId || !id) return res.status(400).json({ error: "deviceId + id required" });
  try {
    await foodLogsCol(deviceId).doc(String(id)).delete();
    invalidate(deviceId);
    return res.json({ success: true });
  } catch (e) {
    log.error("[nutrition.bc] /log/delete:", e?.message || e);
    return res.status(500).json({ error: "server error" });
  }
});

// ── GET /analysis — the FULL analytics payload (SAME shape as legacy) ─────────
// Reuses lib/nutrition-analytics.buildAnalysisPayload pointed at the bc namespace via nutDocRef,
// plus the registration-anchor window clamp + lifetime score outputs (mirrors legacy /analysis).
router.get("/analysis", async (req, res) => {
  const t0 = Date.now();
  try {
    const { deviceId, range = "7" } = req.query;
    if (!deviceId) return res.status(400).json({ error: "deviceId required" });
    if (!["7", "30", "90", "365"].includes(range)) {
      return res.status(400).json({ error: "range must be one of: 7, 30, 90, 365" });
    }
    const nowMs = Date.now();
    const anchor = await resolveAnchor(deviceId);
    const win = computeAnalysisWindow(range, anchor.anchorMs, nowMs, anchor.utcOffsetMinutes);

    const payload = await _nutritionAnalytics.buildAnalysisPayload(deviceId, range, openai, MODELS, {
      clampStartDate: win.effectiveStartDate,
      effectiveDays: win.effectiveDays,
      nutDocRef: nutritionDoc(deviceId), // bc namespace
      cacheNs: "bc",
      utcOffsetMinutes: anchor.utcOffsetMinutes || 0, // peak_hour/evening% in the user's local time
    });

    // Lifetime per-day quality map (for score_today/lifetime). Blends calorie adherence WITH protein
    // adherence so score_* reflects the same calorie+protein emphasis as the headline nutrition_score
    // (was calorie-only, which let the two diverge). bc namespace.
    const _nutData = (await nutritionDoc(deviceId).get()).data() || {};
    const calTargetLifetime = num(_nutData.calorie_target, 2000) || 2000;
    const protTargetLifetime = num(_nutData.protein_target, 140) || 140;
    const lifetimeQualityByDate = await (async () => {
      const out = {};
      if (!anchor.anchorMs) return out;
      try {
        const snap = await foodLogsCol(deviceId).orderBy("logged_at", "desc").limit(Math.min(win.daysSinceAnchor * 10, 5000)).get();
        const byDate = {};
        for (const d of snap.docs) {
          const x = d.data();
          const ds = x.date_str;
          if (!ds || typeof ds !== "string") continue;
          if (anchor.anchorDateStr && ds < anchor.anchorDateStr) continue;
          const e = (byDate[ds] = byDate[ds] || { kcal: 0, protein: 0 });
          e.kcal += num(x.calories);
          e.protein += num(x.protein);
        }
        for (const [ds, e] of Object.entries(byDate)) {
          const ratio = e.kcal / calTargetLifetime;
          const calQ = ratio >= 0.9 && ratio <= 1.1 ? 85 : ratio > 1.1 ? 60 : ratio >= 0.6 ? 70 : 40;
          const protPct = Math.min(1, e.protein / Math.max(protTargetLifetime, 1));
          const protQ = protPct >= 0.9 ? 95 : protPct >= 0.7 ? 80 : protPct >= 0.5 ? 65 : 45;
          out[ds] = Math.round(calQ * 0.6 + protQ * 0.4); // calorie + protein, mirroring nutrition_score
        }
      } catch { /* empty */ }
      return out;
    })();

    const std = computeStandardOutputs({
      qualityByDate: lifetimeQualityByDate,
      todayDate: win.todayDate,
      anchorDate: anchor.anchorDateStr,
      daysSinceAnchor: win.daysSinceAnchor,
    });

    res.set("Cache-Control", "private, max-age=60");
    // Fire both Apple Health reads concurrently (kicked off before either await) — halves HK latency.
    const _hkP = domainHealth(deviceId, 'nutrition').catch(() => null);
    const _hkViewP = domainHealthView(deviceId, 'nutrition', win.requestedDays).catch(() => null);
    return res.json({
      ...payload,
      health: await _hkP,
      health_view: await _hkViewP, // Apple Health activity/weight
      effective_start_date: win.effectiveStartDate,
      effective_days: win.effectiveDays,
      days_since_anchor: win.daysSinceAnchor,
      anchor_date: anchor.anchorDateStr,
      is_clamped: win.isClamped,
      score_today: std.score_today,
      score_7d_smoothed: std.score_7d_smoothed,
      score_lifetime: std.score_lifetime,
      missed_days: std.missed_days,
      latency_ms: Date.now() - t0,
    });
  } catch (e) {
    log.error("[nutrition.bc] /analysis:", e?.message || e);
    return res.status(500).json({ error: "analysis_failed", message: e?.message });
  }
});

// REMAINING (see NUTRITION_BC_BUILD_PLAN.md): /coach, /chat, /encourage, saved-meals.
// /describe + /vision/analyze fall through to the legacy router (compute-only, returns items).

module.exports = router;
