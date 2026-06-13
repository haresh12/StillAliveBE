/**
 * plans.bc.agent.js — the unified PLAN + daily-TASK store for the big-change app. This is the engine
 * behind the "Plans" tab's daily driver: a plan is a goal + a weekly task template; opening "today"
 * resolves the concrete tasks for the day across every active plan; ticking a task is the product.
 *
 * Why it exists: the old plans got negative reviews because creation was a long questionnaire and the
 * result wasn't useful day to day. Here, creation is one tap (the coach's TEMPLATES are its knowledge),
 * and the value is the daily "what do I do today + am I on track" loop.
 *
 *   • bc namespace:  wellness_bc_users/{id}/plans/{planId}   (user-scoped, cross-domain — not an agent)
 *   • Registration-anchor law: a plan can't start before signup; adherence counts only days on plan.
 *   • Mounted at /api/bc-plans.
 *   • Routes: POST /create · GET /today · POST /task/toggle · GET /list · POST /cancel
 */
const express = require("express");
const admin = require("firebase-admin");
const { resolveAnchor } = require("./lib/user-anchor");
const { userDoc: bcUserDoc } = require("./lib/collections");

const router = express.Router();
const ts = () => admin.firestore.FieldValue.serverTimestamp();
const pad = (n) => String(n).padStart(2, "0");
const dateStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (ds, n) => { const [y, m, d] = ds.split("-").map(Number); const dt = new Date(y, m - 1, d + n); return dateStr(dt); };
const dowOf = (ds) => { const [y, m, d] = ds.split("-").map(Number); return new Date(y, m - 1, d).getDay(); };
const plansCol = (id) => bcUserDoc(id).collection("plans");

// ── The coach's plan library. Each goal → a weekly template + daily tasks. Tasks carry STABLE ids so
//    completion tracks across days. A "training-day" is ONE task (a session), so "today" stays scannable.
const T = (id, title, domain, note) => ({ id, title, domain, ...(note ? { note } : {}) });
const TEMPLATES = {
  strength: {
    title: "Get stronger", emoji: "💪", domains: ["fitness", "nutrition"],
    daily: [T("nut_protein", "Hit your protein target", "nutrition")],
    weekly: {
      1: [T("fit_push", "Push workout", "fitness", "Bench 4×5 · Overhead press 3×8 · Triceps 3×12")],
      2: [T("fit_pull", "Pull workout", "fitness", "Rows 4×8 · Pull-ups 3×max · Curls 3×12")],
      4: [T("fit_legs", "Leg workout", "fitness", "Squat 4×5 · RDL 3×8 · Calves 4×15")],
      6: [T("fit_upper", "Upper workout", "fitness", "Incline press 4×8 · Lat pulldown 3×10 · Lateral raise 3×15")],
    },
  },
  fat_loss: {
    title: "Lose fat", emoji: "🔥", domains: ["nutrition", "fitness"],
    daily: [T("nut_cal", "Stay under your calorie target", "nutrition"), T("nut_protein", "Hit 150g protein", "nutrition"), T("fit_steps", "Get 10,000 steps", "fitness")],
    weekly: { 1: [T("fit_train", "30-min training", "fitness")], 3: [T("fit_train", "30-min training", "fitness")], 5: [T("fit_train", "30-min training", "fitness")] },
  },
  cardio: {
    title: "Build cardio", emoji: "🏃", domains: ["fitness"],
    daily: [],
    weekly: {
      1: [T("fit_easy", "Easy run · 25 min", "fitness")],
      3: [T("fit_intervals", "Intervals · 6×1 min hard", "fitness")],
      5: [T("fit_long", "Long run · 35 min", "fitness")],
      0: [T("fit_recovery", "Recovery walk · 30 min", "fitness")],
    },
  },
  sleep: {
    title: "Sleep deeper", emoji: "😴", domains: ["sleep"],
    daily: [T("slp_bed", "In bed by 11:00 pm", "sleep"), T("slp_screens", "No screens 30 min before bed", "sleep"), T("slp_wake", "Wake at the same time", "sleep")],
    weekly: {},
  },
  calm: {
    title: "Calmer mind", emoji: "🧠", domains: ["mind"],
    daily: [T("mnd_morning", "Morning mood check-in", "mind"), T("mnd_breath", "3-min breathing reset", "mind"), T("mnd_evening", "Evening reflection", "mind")],
    weekly: {},
  },
  fasting: {
    title: "Start fasting", emoji: "⏳", domains: ["fasting"],
    daily: [T("fst_window", "Fast 16 hours", "fasting"), T("fst_open", "Open eating window at noon", "fasting"), T("fst_close", "Close the kitchen by 8 pm", "fasting")],
    weekly: {},
  },
  hydration: {
    title: "Hydrate better", emoji: "💧", domains: ["water"],
    daily: [T("wtr_target", "Drink 2.5 L of water", "water"), T("wtr_first", "A glass first thing", "water"), T("wtr_bottle", "Keep a bottle on your desk", "water")],
    weekly: {},
  },
};

// Tasks scheduled for a given date under a plan (daily + that weekday's weekly tasks).
function tasksForDate(plan, ds) {
  const daily = Array.isArray(plan.daily) ? plan.daily : [];
  const weekly = (plan.weekly && plan.weekly[String(dowOf(ds))]) || [];
  return [...daily, ...weekly];
}

// ── Personalization — turn a goal + the user's answers into a TAILORED weekly split + daily tasks.
//    No two users get the same plan: training days, split, fasting window, bedtime all come from answers.
const FIT_SPLIT = {
  2: [[1, 'Upper body', 'Bench · Rows · Overhead press · Curls'], [4, 'Lower body', 'Squat · RDL · Lunges · Calves']],
  3: [[1, 'Push', 'Bench · Overhead press · Triceps'], [3, 'Pull', 'Rows · Pull-ups · Curls'], [5, 'Legs', 'Squat · RDL · Calves']],
  4: [[1, 'Push', 'Bench · Overhead press · Triceps'], [2, 'Pull', 'Rows · Pull-ups · Curls'], [4, 'Legs', 'Squat · RDL · Calves'], [6, 'Upper', 'Incline press · Lat pulldown · Lateral raise']],
  5: [[1, 'Push', 'Bench · Overhead press · Triceps'], [2, 'Pull', 'Rows · Pull-ups · Curls'], [3, 'Legs', 'Squat · RDL · Calves'], [5, 'Upper', 'Incline · Lat pulldown · Lateral raise'], [6, 'Arms & core', 'Curls · Pushdowns · Planks']],
};
const CARDIO_PLAN = {
  2: [[1, 'Easy run · 25 min'], [4, 'Intervals · 6×1 min hard']],
  3: [[1, 'Easy run · 25 min'], [3, 'Intervals · 6×1 min hard'], [5, 'Long run · 35 min']],
  4: [[1, 'Easy run · 25 min'], [3, 'Intervals · 6×1 min hard'], [5, 'Long run · 35 min'], [0, 'Recovery walk · 30 min']],
  5: [[1, 'Easy run'], [2, 'Tempo · 20 min'], [3, 'Intervals · 6×1 min'], [5, 'Long run · 40 min'], [0, 'Recovery walk']],
};
function clampDays(n) { n = Number(n); return [2, 3, 4, 5].includes(n) ? n : 3; }

function personalize(goalKey, answers = {}) {
  const a = answers || {};
  if (goalKey === 'strength') {
    const days = clampDays(a.days_per_week);
    const weekly = {};
    for (const [dow, name, note] of FIT_SPLIT[days]) weekly[dow] = [T(`fit_${name.toLowerCase().replace(/[^a-z]/g, '')}`, `${name} workout`, 'fitness', note)];
    return { daily: [T('nut_protein', 'Hit your protein target', 'nutrition')], weekly };
  }
  if (goalKey === 'cardio') {
    const days = clampDays(a.days_per_week);
    const weekly = {};
    CARDIO_PLAN[days].forEach(([dow, label], i) => { weekly[dow] = [T(`fit_run${i}`, label, 'fitness')]; });
    return { daily: [], weekly };
  }
  if (goalKey === 'fat_loss') {
    const days = clampDays(a.days_per_week);
    const weekly = {};
    FIT_SPLIT[days].forEach(([dow]) => { weekly[dow] = [T('fit_train', '30-min training', 'fitness')]; });
    return { daily: [T('nut_cal', 'Stay under your calorie target', 'nutrition'), T('nut_protein', 'Hit 150g protein', 'nutrition'), T('fit_steps', 'Get 10,000 steps', 'fitness')], weekly };
  }
  if (goalKey === 'fasting') {
    const win = a.window === '18:6' ? [18, 'noon'] : a.window === '14:10' ? [14, '10am'] : [16, 'noon'];
    return { daily: [T('fst_window', `Fast ${win[0]} hours`, 'fasting'), T('fst_open', `Open eating window at ${win[1]}`, 'fasting'), T('fst_close', 'Close the kitchen by 8 pm', 'fasting')], weekly: {} };
  }
  if (goalKey === 'sleep') {
    const bed = a.bedtime || '11:00 pm';
    return { daily: [T('slp_bed', `In bed by ${bed}`, 'sleep'), T('slp_screens', 'No screens 30 min before bed', 'sleep'), T('slp_wake', 'Wake at the same time', 'sleep')], weekly: {} };
  }
  // calm, hydration — use the template defaults
  const tpl = TEMPLATES[goalKey];
  return { daily: tpl.daily, weekly: tpl.weekly };
}

// ── POST /create — the coach builds a plan from its template library (one tap, no questionnaire) ──
router.post("/create", async (req, res) => {
  const { deviceId, goal_key, duration_days, answers } = req.body || {};
  if (!deviceId || !goal_key || !TEMPLATES[goal_key]) return res.status(400).json({ error: "deviceId + valid goal_key required" });
  try {
    const anchor = await resolveAnchor(deviceId);
    const today = dateStr();
    const start = anchor.anchorDateStr && anchor.anchorDateStr > today ? anchor.anchorDateStr : today; // never before signup
    const dur = [3, 7, 30].includes(Number(duration_days)) ? Number(duration_days) : 7; // 3-day / weekly / monthly only
    const tpl = TEMPLATES[goal_key];
    const tailored = personalize(goal_key, answers); // personalized from the user's answers — not one-size-fits-all
    const ref = plansCol(deviceId).doc();
    const plan = {
      id: ref.id, goal_key, title: tpl.title, emoji: tpl.emoji, domains: tpl.domains,
      daily: tailored.daily, weekly: tailored.weekly, answers: answers || {},
      status: "active", start_date: start, end_date: addDays(start, dur - 1), duration_days: dur,
      completions: {}, created_at: ts(), updated_at: ts(),
    };
    await ref.set(plan);
    return res.json({ success: true, plan: { ...plan, created_at: null, updated_at: null } });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "create failed" });
  }
});

// Progress across a plan: today done/total, last-7-day adherence, streak, days on plan.
function planProgress(plan, today) {
  const start = plan.start_date || today;
  const completions = plan.completions || {};
  const daysOnPlan = Math.max(1, Math.round((new Date(today) - new Date(start)) / 864e5) + 1);
  // Adherence over the last min(7, daysOnPlan) days (excluding today-in-progress for the rate).
  let done = 0, total = 0, winDays = 0, windowDays = 0;
  for (let i = 1; i <= Math.min(7, daysOnPlan); i++) {
    const ds = addDays(today, -i);
    if (ds < start) break;
    const sched = tasksForDate(plan, ds);
    if (!sched.length) continue;
    const doneSet = new Set(completions[ds] || []);
    const d = sched.filter((t) => doneSet.has(t.id)).length;
    done += d; total += sched.length; windowDays++;
    if (d / sched.length >= 0.6) winDays++;
  }
  const week_pct = total ? Math.round((done / total) * 100) : 0;
  // Streak: consecutive "win" days ending yesterday (today counts only once complete).
  let streak = 0;
  for (let i = 1; i <= daysOnPlan; i++) {
    const ds = addDays(today, -i);
    if (ds < start) break;
    const sched = tasksForDate(plan, ds);
    if (!sched.length) continue; // rest day doesn't break the streak
    const doneSet = new Set(completions[ds] || []);
    if (sched.filter((t) => doneSet.has(t.id)).length / sched.length >= 0.6) streak++; else break;
  }
  // include today if already a win
  const tSched = tasksForDate(plan, today);
  const tDone = new Set(completions[today] || []);
  if (tSched.length && tSched.filter((t) => tDone.has(t.id)).length / tSched.length >= 0.6) streak++;
  return { week_pct, streak, days_on_plan: daysOnPlan, win_days: winDays, window_days: windowDays };
}

// ── GET /today — the daily driver: every active plan's tasks for today + overall progress ──
router.get("/today", async (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const today = dateStr();
    // No Firestore index — fetch the (small) user-scoped collection and filter active in memory.
    const snap = await plansCol(deviceId).get().catch(() => ({ docs: [] }));
    const plans = snap.docs.map((d) => d.data()).filter((p) => p.status === "active");
    const today_tasks = [];
    let weekSum = 0, streakMax = 0, planCount = 0;
    for (const p of plans) {
      if ((p.start_date || today) > today) continue; // not started yet
      const doneSet = new Set((p.completions || {})[today] || []);
      for (const tk of tasksForDate(p, today)) {
        today_tasks.push({ plan_id: p.id, plan_title: p.title, plan_emoji: p.emoji, id: tk.id, title: tk.title, domain: tk.domain, note: tk.note || null, done: doneSet.has(tk.id) });
      }
      const pr = planProgress(p, today);
      weekSum += pr.week_pct; streakMax = Math.max(streakMax, pr.streak); planCount++;
    }
    const today_done = today_tasks.filter((t) => t.done).length;
    return res.json({
      date: today, has_plan: plans.length > 0,
      plans: plans.map((p) => ({ id: p.id, title: p.title, emoji: p.emoji, goal_key: p.goal_key, domains: p.domains, start_date: p.start_date })),
      today_tasks,
      progress: { today_done, today_total: today_tasks.length, week_pct: planCount ? Math.round(weekSum / planCount) : 0, streak: streakMax },
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "today failed" });
  }
});

// ── POST /task/toggle — tick / untick a task for a date (the product moment) ──
router.post("/task/toggle", async (req, res) => {
  const { deviceId, plan_id, task_id, date, done } = req.body || {};
  if (!deviceId || !plan_id || !task_id) return res.status(400).json({ error: "deviceId + plan_id + task_id required" });
  try {
    const ref = plansCol(deviceId).doc(plan_id);
    const ds = date || dateStr();
    await admin.firestore().runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) throw new Error("plan not found");
      const p = doc.data();
      const completions = p.completions || {};
      const arr = new Set(completions[ds] || []);
      if (done) arr.add(task_id); else arr.delete(task_id);
      completions[ds] = [...arr];
      tx.update(ref, { completions, updated_at: ts() });
    });
    const fresh = (await ref.get()).data();
    return res.json({ success: true, progress: planProgress(fresh, dateStr()) });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "toggle failed" });
  }
});

// ── GET /list — all plans with light progress (for a "your plans" view) ──
router.get("/list", async (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const snap = await plansCol(deviceId).get().catch(() => ({ docs: [] }));
    const today = dateStr();
    const plans = snap.docs.map((d) => d.data()).map((p) => ({
      id: p.id, title: p.title, emoji: p.emoji, goal_key: p.goal_key, domains: p.domains,
      status: p.status, start_date: p.start_date, progress: planProgress(p, today),
    }));
    return res.json({ plans });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "list failed" });
  }
});

// ── POST /cancel — archive a plan ──
router.post("/cancel", async (req, res) => {
  const { deviceId, plan_id } = req.body || {};
  if (!deviceId || !plan_id) return res.status(400).json({ error: "deviceId + plan_id required" });
  try {
    await plansCol(deviceId).doc(plan_id).update({ status: "archived", updated_at: ts() });
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "cancel failed" });
  }
});

// Expose the goal catalog so the FE/coach share one source of truth.
router.get("/catalog", (_req, res) => {
  res.json({ goals: Object.entries(TEMPLATES).map(([key, v]) => ({ goal_key: key, title: v.title, emoji: v.emoji, domains: v.domains })) });
});

module.exports = router;
module.exports.TEMPLATES = TEMPLATES;
module.exports._test = { tasksForDate, planProgress, personalize, TEMPLATES }; // pure helpers for unit tests
