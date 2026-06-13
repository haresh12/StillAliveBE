/**
 * goal-plans.bc.agent.js — the rebuilt goal-plans engine for the big-change app, on the bc namespace.
 *
 * Restores the (deleted) /api/goal-plans contract the legacy Plans FE expects, but writes to
 * wellness_bc_users/{id}/plans — so it NEVER touches existing (legacy) users' data. LLM-driven:
 *   • POST /draft           — goal_text → area + coaches + 4–8 questions + headline_metric  (a "draft")
 *   • POST /draft/finalize  — answers → a personalized plan TEMPLATE (daily/weekly items + phases),
 *                              expanded server-side into the day/item schema the FE renders
 *   • GET  /list            — active plans w/ today_items + completed_item_ids + current_day_index
 *   • GET  /plan/:id        — full plan (days[] expanded, per-day completed_item_ids)
 *   • POST /complete-item   — toggle an item for a date; returns the FULL completed set for that day
 *   • POST /rename · /archive · /delete
 *
 * Registration-anchor law: a plan never starts before signup; "today" is anchor-clamped.
 */
const express = require("express");
const admin = require("firebase-admin");
const { OpenAI } = require("openai");
const { MODELS } = require("./lib/model-router");
const { resolveAnchor } = require("./lib/user-anchor");
const { userDoc: bcUserDoc } = require("./lib/collections");

const router = express.Router();
// Lazy OpenAI clients — so the module loads (and unit-tests) even before OPENAI_API_KEY is set at boot.
let _oa, _oaLong;
const openai = () => (_oa || (_oa = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30_000 })));
const openaiLong = () => (_oaLong || (_oaLong = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 120_000 }))); // plan generation
const ts = () => admin.firestore.FieldValue.serverTimestamp();
const pad = (n) => String(n).padStart(2, "0");
const dateStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (ds, n) => { const [y, m, d] = ds.split("-").map(Number); const dt = new Date(y, m - 1, d + n); return dateStr(dt); };
const dowOf = (ds) => { const [y, m, d] = ds.split("-").map(Number); return new Date(y, m - 1, d).getDay(); };
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 28) || "item";
const plansCol = (id) => bcUserDoc(id).collection("plans");
const draftsCol = (id) => bcUserDoc(id).collection("plan_drafts");
const AREAS = ["weight", "energy", "sleep", "calm", "fasting", "habits"];
const COACHES = ["fitness", "nutrition", "mind", "sleep", "water", "fasting"];
const SECTIONS = ["morning", "evening", "night"];
const err = (res, code, status = 400) => res.status(status).json({ ok: false, error_code: code });

// ── POST /draft — LLM turns a free-text goal into routed coaches + a few good questions ──
const DRAFT_SYS = `You are a wellness planner. Given a user's goal, return STRICT JSON to set up a short, friendly question flow (NOT a long form).
Output: {"area": one of ["weight","energy","sleep","calm","fasting","habits"], "coaches_involved": subset of ["fitness","nutrition","mind","sleep","water","fasting"], "questions": [ {"id": short_snake_key, "kind": "chip_single"|"chip_multi"|"duration"|"text", "q": "the question, friendly, <=70 chars", "coach": one coach id, "choices": ["..."] (3-5 options for chip kinds; omit for text)} ], "headline_metric": {"label": "short", "unit": "optional", "direction": "down"|"up"} }
RULES: 4 to 6 questions, NEVER more. Make them specific to the goal (days/week, level, equipment, constraints, preferences). Exactly one question MUST have kind "duration" with choices ["3","7","14","28"]. NEVER offer a duration longer than 28 days. Plain English. No medical advice.`;

router.post("/draft", async (req, res) => {
  const { device_id, goal_text } = req.body || {};
  if (!device_id) return err(res, "MISSING_DEVICE_ID");
  if (!goal_text || String(goal_text).trim().length < 2) return err(res, "INVALID_GOAL");
  try {
    let parsed = null;
    try {
      const c = await openai().chat.completions.create({
        model: MODELS?.mini || "gpt-4o-mini", response_format: { type: "json_object" }, max_completion_tokens: 900,
        messages: [{ role: "system", content: DRAFT_SYS }, { role: "user", content: String(goal_text).slice(0, 400) }],
      });
      parsed = JSON.parse(c.choices?.[0]?.message?.content || "{}");
    } catch { return err(res, "LLM_UNAVAILABLE", 503); }

    const area = AREAS.includes(parsed.area) ? parsed.area : "habits";
    const coaches = Array.isArray(parsed.coaches_involved) ? parsed.coaches_involved.filter((c) => COACHES.includes(c)).slice(0, 4) : [];
    let questions = (Array.isArray(parsed.questions) ? parsed.questions : []).slice(0, 6).map((q, i) => ({
      id: slug(q.id || `q${i}`), kind: ["chip_single", "chip_multi", "duration", "text"].includes(q.kind) ? q.kind : "chip_single",
      q: String(q.q || "").slice(0, 90), coach: COACHES.includes(q.coach) ? q.coach : (coaches[0] || "fitness"),
      ...(Array.isArray(q.choices) && q.choices.length ? { choices: q.choices.slice(0, 5).map((x) => String(x).slice(0, 40)) } : {}),
    })).filter((q) => q.q);
    if (!questions.some((q) => q.kind === "duration")) questions.push({ id: "duration_days", kind: "duration", q: "How long should this run?", coach: coaches[0] || "fitness", choices: ["3", "7", "14", "28"] });
    if (questions.length < 4) return err(res, "PLAN_SCHEMA_DRIFT", 502);

    const ref = draftsCol(device_id).doc();
    await ref.set({ id: ref.id, goal_text: String(goal_text).slice(0, 400), area, coaches_involved: coaches, questions, headline_metric: parsed.headline_metric || null, created_at: ts() });
    return res.json({ ok: true, draft_id: ref.id, questions, coaches_involved: coaches, area, duration_days: 7 });
  } catch (e) { return err(res, "INTERNAL", 500); }
});

// ── POST /draft/finalize — answers → a personalized, PHASED plan template, expanded into days ──
// Grounded in behavior-change science (implementation intentions: specific action + exact time/cue +
// method) and progressive overload. Every task names WHAT (+ measurable amount), WHEN (exact time/cue),
// and HOW (a one-line method). Days are NOT identical — phases ramp the targets up over time.
const FINAL_SYS = `You are an elite wellness coach building a CONCRETE, day-by-day plan from a user's goal + answers. Return STRICT JSON.

EVERY task is an implementation intention — a SPECIFIC action, a MEASURABLE amount, an EXACT time/cue (the "when"), a one-line method (the "how"), and — when the task spreads across the day or has parts — a short STEPS breakdown so the user knows EXACTLY what to do.
BAD:  "Drink more water"   "Exercise"   "Sleep better"
GOOD: title "Drink 2L water"  when_label "Across the day"  detail "Keep a 500ml bottle on you; refill it"  steps ["500ml on waking (7 AM)","500ml before lunch (12 PM)","500ml mid-afternoon (4 PM)","500ml with dinner (7 PM)"]  impact "Steady hydration beats chugging 2L at once"

OUTPUT JSON:
{
 "title": "<=42 chars, specific + motivating",
 "headline_metric": {"label":"short","unit":"optional","direction":"down"|"up"},
 "phases": [
   {
     "theme": "FOUNDATION"|"BUILD"|"PEAK"|"LOCK-IN",
     "label": "<=40 chars — what this stretch focuses on",
     "day_start": <1-based day this phase begins; first phase = 1; increasing; within plan length>,
     "daily_items": [ {"title":"action + amount, <=52 chars","coach":"fitness|nutrition|mind|sleep|water|fasting","time_section":"morning|evening|night","when_label":"exact time/cue, <=26 chars","detail":"the HOW — one concrete cue or method, <=72 chars","steps":["2-4 concrete sub-points with exact times/amounts, each <=46 chars"],"impact":"the WHY — short benefit, <=58 chars"} ],
     "weekly_items": { "1":[item], "4":[item] }   // OPTIONAL — dow 0-6 keys, for session/training days that aren't daily
   }
 ]
}
STEPS: include 2-4 steps when a task breaks into parts (water across the day, meals, a multi-set workout, a wind-down routine). Atomic tasks ("Screens off by 10 PM", "Caffeine cutoff 2 PM") need NO steps — omit the field.

PROGRESSION (critical — days must NOT be identical):
- 3-day plan → 1 phase. 7-day → 2 phases. 14 or 28-day → 3 phases.
- Phase 1 starts EASY to build the habit; later phases RAMP targets up (more volume / longer / tighter / fuller routine). e.g. water 1.5L→2L→2.5L · walk 15→25→35 min · fast 12h→14h→16h · wind-down 1 step→full routine.

USE REAL PROTOCOLS, by coach:
- water: ml targets; front-load ≥500ml within 30 min of waking; 250ml 15 min before each meal; stop heavy intake by 9 PM.
- sleep: same wake time daily; screens off 60 min before bed; caffeine cutoff 2 PM; bedroom 65-68°F; 5-min slow breathing or 3-min brain-dump at lights-out.
- fitness: name the movement + sets×reps or minutes; progressive overload (+1-2 sets or small load each week); ≥3 sessions/week; mobility/rest on off days.
- nutrition: protein ~1.6-2.2 g/kg; 25-35g fiber; a protein source at each meal; 250ml water pre-meal; log meals.
- fasting: protocols 12:12 → 14:10 → 16:8; give the eating-window clock (e.g. 12-8 PM); window ends 2h before bed; water/black coffee allowed while fasting.
- mind: box breathing 5 min for anxiety; 3-min brain-dump for a racing mind; one-line gratitude at night; a morning mood check.

RULES: 2-4 daily_items per phase (quality over quantity). Use weekly_items for training/session days, respecting the user's days-per-week answer. Realistic, specific, plain English. NO medical claims.`;

// Pick the phase covering a given 1-based day (phases carry their OWN items, so targets ramp over time).
function phaseForDay(phases, dayNum) {
  const sorted = [...phases].sort((a, b) => (a.day_start || 1) - (b.day_start || 1));
  let chosen = sorted[0];
  for (const ph of sorted) { if ((ph.day_start || 1) <= dayNum) chosen = ph; else break; }
  return chosen;
}
function expandDays(plan, today) {
  const out = [];
  const start = plan.start_date;
  const comp = plan.completions || {};
  // New shape: phases[] each carry daily_items/weekly_items. Legacy fallback: top-level daily/weekly.
  const phases = Array.isArray(plan.phases) && plan.phases.length && plan.phases.some((p) => Array.isArray(p.daily_items))
    ? plan.phases
    : [{ theme: plan.phases?.[0]?.theme || null, label: "", day_start: 1, daily_items: plan.daily_items || [], weekly_items: plan.weekly_items || {} }];
  for (let i = 0; i < plan.duration_days; i++) {
    const dk = addDays(start, i);
    const ph = phaseForDay(phases, i + 1) || phases[0];
    const daily = Array.isArray(ph.daily_items) ? ph.daily_items : [];
    const weekly = (ph.weekly_items && ph.weekly_items[String(dowOf(dk))]) || [];
    const items = [...daily, ...weekly];
    out.push({ day_index: i + 1, date_key: dk, theme: ph.theme || null, items, completed_item_ids: comp[dk] || [] });
  }
  return out;
}
function currentDayIndex(plan, today) { const i = Math.round((new Date(today) - new Date(plan.start_date)) / 864e5) + 1; return Math.max(1, Math.min(plan.duration_days, i)); }

router.post("/draft/finalize", async (req, res) => {
  const { device_id, draft_id, answers } = req.body || {};
  if (!device_id) return err(res, "MISSING_DEVICE_ID");
  if (!draft_id) return err(res, "DRAFT_NOT_FOUND");
  try {
    const dsnap = await draftsCol(device_id).doc(draft_id).get();
    if (!dsnap.exists) return err(res, "DRAFT_NOT_FOUND", 404);
    const draft = dsnap.data();
    const ans = Array.isArray(answers) ? answers : [];
    const durAns = ans.find((a) => a.id === "duration_days" || a.id === "duration");
    // Duration is user-selectable: 3 / 7 / 14 / 28 days. HARD CAP at 28 — no plan may run longer.
    let dur = [3, 7, 14, 28].includes(Number(durAns?.value)) ? Number(durAns.value) : 7;
    dur = Math.min(28, Math.max(3, dur));
    const ctx = `GOAL: ${draft.goal_text}\nANSWERS:\n${ans.map((a) => `- ${a.id}: ${Array.isArray(a.value) ? a.value.join(", ") : a.value}`).join("\n")}\nDURATION: ${dur} days`;

    let p = null;
    try {
      const c = await openaiLong().chat.completions.create({
        model: MODELS?.mini || "gpt-4o-mini", response_format: { type: "json_object" }, max_completion_tokens: 1400,
        messages: [{ role: "system", content: FINAL_SYS }, { role: "user", content: ctx.slice(0, 1600) }],
      });
      p = JSON.parse(c.choices?.[0]?.message?.content || "{}");
    } catch { return err(res, "LLM_UNAVAILABLE", 503); }

    let counter = 0;
    const norm = (it) => ({
      id: `${slug(it.coach)}_${slug(it.title)}_${counter++}`.slice(0, 44), title: String(it.title || "").slice(0, 64),
      coach: COACHES.includes(it.coach) ? it.coach : "fitness", time_section: SECTIONS.includes(it.time_section) ? it.time_section : "morning",
      when_label: String(it.when_label || "").slice(0, 28) || "All day", detail: String(it.detail || "").slice(0, 80),
      steps: (Array.isArray(it.steps) ? it.steps : []).slice(0, 4).map((sx) => String(sx).slice(0, 48)).filter(Boolean),
      impact: String(it.impact || "").slice(0, 70), kind: "do",
    });
    const mkWeekly = (raw) => {
      const w = {};
      if (raw && typeof raw === "object") for (const k of Object.keys(raw)) { const d = Number(k); if (d >= 0 && d <= 6 && Array.isArray(raw[k])) w[d] = raw[k].slice(0, 2).map(norm).filter((x) => x.title); }
      return w;
    };
    // New shape: phases[] each carry their own (ramping) items. Legacy fallback: a single phase from top-level daily/weekly.
    const rawPhases = Array.isArray(p.phases) && p.phases.length
      ? p.phases
      : [{ theme: "PLAN", label: "", day_start: 1, daily_items: p.daily_items, weekly_items: p.weekly_items }];
    const phases = rawPhases.slice(0, 3).map((ph, pi) => ({
      theme: String(ph.theme || "PLAN").toUpperCase().slice(0, 12), label: String(ph.label || "").slice(0, 40),
      day_start: Math.max(1, Math.min(dur, Number(ph.day_start) || (pi === 0 ? 1 : pi * Math.ceil(dur / rawPhases.length) + 1))),
      daily_items: (Array.isArray(ph.daily_items) ? ph.daily_items : []).slice(0, 4).map(norm).filter((x) => x.title),
      weekly_items: mkWeekly(ph.weekly_items),
    })).sort((a, b) => a.day_start - b.day_start);
    if (phases.length) phases[0].day_start = 1;
    if (!phases.some((ph) => ph.daily_items.length || Object.keys(ph.weekly_items).length)) return err(res, "PLAN_SCHEMA_DRIFT", 502);

    // Plan cap — max 10 active (matches legacy LIMITS.MAX_ACTIVE_PLANS_PER_USER). No index: filter in memory.
    const existing = await plansCol(device_id).get().catch(() => ({ docs: [] }));
    if (existing.docs.map((d) => d.data()).filter((p) => p.status === "active").length >= 10) return err(res, "TOO_MANY_PLANS", 409);

    const anchor = await resolveAnchor(device_id);
    const today = dateStr();
    const start = anchor.anchorDateStr && anchor.anchorDateStr > today ? anchor.anchorDateStr : today;
    const ref = plansCol(device_id).doc();
    const plan = {
      id: ref.id, title: String(p.title || draft.goal_text).slice(0, 60), area: draft.area || "habits", status: "active",
      duration_days: dur, start_date: start, phases,
      headline_metric: p.headline_metric || draft.headline_metric || null, coaches_involved: draft.coaches_involved || [],
      completions: {}, created_at: ts(), updated_at: ts(),
    };
    await ref.set(plan);
    draftsCol(device_id).doc(draft_id).delete().catch(() => {});
    return res.json({ ok: true, plan: { ...plan, days: expandDays(plan, today), current_day_index: 1, created_at: null, updated_at: null } });
  } catch (e) { return err(res, "INTERNAL", 500); }
});

// ── GET /list ──
router.get("/list", async (req, res) => {
  const device_id = req.query.device_id || req.query.deviceId;
  if (!device_id) return err(res, "MISSING_DEVICE_ID");
  try {
    const today = dateStr();
    const snap = await plansCol(device_id).get().catch(() => ({ docs: [] }));
    const plans = snap.docs.map((d) => d.data()).filter((p) => p.status !== "archived").map((p) => {
      const days = expandDays(p, today);
      const todayDay = days.find((d) => d.date_key === today) || { items: [], completed_item_ids: [] };
      const done = new Set(todayDay.completed_item_ids);
      const today_items = todayDay.items.slice(0, 5).map((it) => ({ ...it, completed: done.has(it.id) }));
      return {
        id: p.id, title: p.title, area: p.area || "habits", status: p.status, duration_days: p.duration_days,
        current_day_index: currentDayIndex(p, today), today_date_key: today,
        today_ratio: `${[...done].filter((id) => todayDay.items.some((it) => it.id === id)).length}/${todayDay.items.length}`,
        today_items, today_overflow: Math.max(0, todayDay.items.length - 5), completed_item_ids: todayDay.completed_item_ids,
      };
    });
    return res.json({ ok: true, plans });
  } catch (e) { return err(res, "INTERNAL", 500); }
});

// ── GET /plan/:id ──
router.get("/plan/:id", async (req, res) => {
  const device_id = req.query.device_id || req.query.deviceId;
  if (!device_id) return err(res, "MISSING_DEVICE_ID");
  try {
    const snap = await plansCol(device_id).doc(req.params.id).get();
    if (!snap.exists) return err(res, "PLAN_NOT_FOUND", 404);
    const p = snap.data();
    const today = dateStr();
    return res.json({ ok: true, plan: { ...p, days: expandDays(p, today), current_day_index: currentDayIndex(p, today), completions: undefined, created_at: null, updated_at: null } });
  } catch (e) { return err(res, "INTERNAL", 500); }
});

// ── POST /complete-item — toggle, return the FULL set for that day ──
router.post("/complete-item", async (req, res) => {
  const { device_id, plan_id, date_key, item_id, completed } = req.body || {};
  if (!device_id) return err(res, "MISSING_DEVICE_ID");
  if (!plan_id || !item_id || !date_key) return err(res, "INVALID_DATE");
  try {
    const ref = plansCol(device_id).doc(plan_id);
    let setArr = [];
    await admin.firestore().runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) throw new Error("PLAN_NOT_FOUND");
      const p = doc.data(); const comp = p.completions || {};
      const s = new Set(comp[date_key] || []);
      if (completed) s.add(item_id); else s.delete(item_id);
      comp[date_key] = [...s]; setArr = comp[date_key];
      tx.update(ref, { completions: comp, updated_at: ts() });
    });
    return res.json({ ok: true, completed_item_ids: setArr });
  } catch (e) { return err(res, e?.message === "PLAN_NOT_FOUND" ? "PLAN_NOT_FOUND" : "INTERNAL", e?.message === "PLAN_NOT_FOUND" ? 404 : 500); }
});

// ── POST /rename · /archive · /delete ──
router.post("/rename", async (req, res) => {
  const { device_id, plan_id, title } = req.body || {};
  if (!device_id) return err(res, "MISSING_DEVICE_ID");
  const t = String(title || "").trim();
  if (t.length < 3 || t.length > 60) return err(res, "INVALID_TITLE");
  try { await plansCol(device_id).doc(plan_id).update({ title: t, updated_at: ts() }); return res.json({ ok: true }); }
  catch { return err(res, "PLAN_NOT_FOUND", 404); }
});
router.post("/archive", async (req, res) => {
  const { device_id, plan_id } = req.body || {};
  if (!device_id) return err(res, "MISSING_DEVICE_ID");
  try { await plansCol(device_id).doc(plan_id).update({ status: "archived", updated_at: ts() }); return res.json({ ok: true }); }
  catch { return err(res, "PLAN_NOT_FOUND", 404); }
});
router.post("/delete", async (req, res) => {
  const { device_id, plan_id } = req.body || {};
  if (!device_id) return err(res, "MISSING_DEVICE_ID");
  try { await plansCol(device_id).doc(plan_id).delete(); return res.json({ ok: true }); }
  catch { return err(res, "INTERNAL", 500); }
});

module.exports = router;
module.exports._test = { expandDays, currentDayIndex };
