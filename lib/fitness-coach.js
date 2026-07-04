"use strict";
// ================================================================
// FITNESS COACH ORCHESTRATOR  —  POST /api/fitness/coach
//
// The smart brain of the chat-first fitness agent. An LLM (gpt-5.4-mini — see model: below) routes intent,
// calls the EXISTING /api/fitness/* endpoints as tools (internal HTTP, deviceId injected
// server-side), and emits the FE Block contract. It NEVER invents numbers — every number
// comes from a tool result this turn. Persists turns to fitness_chats (bc namespace).
//
// Built from BIG_CHANGE_CHAT/FITNESS plan + research brief (wth9va22e).
// ================================================================

const admin = require("firebase-admin");
const { OpenAI } = require("openai");
const { userDoc, onboardingDoc } = require("./collections"); // bc-namespaced (wellness_bc_*)
const { resolveLanguage, appendLanguageInstruction } = require("./i18n-prompt");
const { timeContextBlock } = require("./time-context");
const { getCoach, personaDirective } = require("./coach-roster"); // speak in the user's CHOSEN coach persona
const { retrieveMemories, addMemories } = require("./fitness-memory");
const { healthSignalsText } = require("./hk-signals"); // Apple Health → the coach speaks from real body data

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const fitnessDoc = (id) => userDoc(id).collection("agents").doc("fitness");
const chatsCol = (id) => fitnessDoc(id).collection("fitness_chats");
const ts = () => admin.firestore.FieldValue.serverTimestamp();
const INTERNAL = () => `http://127.0.0.1:${process.env.PORT || 5001}/api/fitness`;

// ── Rate limit (20 / 60s / device) ──────────────────────────────────────────
const _rate = new Map();
function rateOk(id) {
  const now = Date.now();
  const e = _rate.get(id);
  if (!e || now - e.t > 60000) { _rate.set(id, { t: now, n: 1 }); return true; }
  if (e.n >= 20) return false;
  e.n += 1; return true;
}

// ── Tool → existing endpoint map ─────────────────────────────────────────────
const ROUTES = {
  log_workout:         { method: "POST", path: "/log" },
  parse_voice_workout: { method: "POST", path: "/describe" },
  get_today:           { method: "GET",  path: "/today" },
  get_analysis:        { method: "GET",  path: "/analysis" },
  get_muscle_trends:   { method: "GET",  path: "/muscle-trends" },
  get_actions:         { method: "GET",  path: "/actions" },
  check_in:            { method: "POST", path: "/check-in" },
  save_setup:          { method: "POST", path: "/setup" },
  get_templates:       { method: "GET",  path: "/templates" },
  save_template:       { method: "POST", path: "/templates" },
  log_bodyweight:      { method: "POST", path: "/bodyweight" },
  get_bodyweight_trend:{ method: "GET",  path: "/bodyweight" },
  set_goal:            { method: "POST", path: "/goal" },
  get_goal:            { method: "GET",  path: "/goal" },
};

async function executeTool(name, args, deviceId, unit = "kg") {
  const r = ROUTES[name];
  if (!r) return { error: `unknown tool ${name}` };
  try {
    const base = INTERNAL();
    if (r.method === "GET") {
      // inject the user's unit so trend/goal come back in kg or lb
      const q = new URLSearchParams({ deviceId, unit, ...stringifyVals(args) }).toString();
      const res = await fetch(`${base}${r.path}?${q}`);
      return await res.json();
    }
    // Inject the user's unit on POST too — /describe needs it to read a bare weight
    // ("bench 185" with no unit word) in the user's unit before converting to kg.
    const res = await fetch(`${base}${r.path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, unit, ...args }),
    });
    return await res.json();
  } catch (e) {
    return { error: `tool ${name} failed: ${String(e && e.message || e)}` };
  }
}
const stringifyVals = (o) => {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) out[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
  return out;
};

// ── OpenAI tool schemas ──────────────────────────────────────────────────────
const TOOLS = [
  { type: "function", function: { name: "log_workout", description: "Save a COMPLETED strength workout. Use only when the workout is structured and confirmed.", parameters: { type: "object", properties: { exercises: { type: "array", items: { type: "object", properties: { name: { type: "string" }, sets: { type: "array", items: { type: "object", properties: { reps: { type: "number" }, weight_kg: { type: "number" }, rpe: { type: "number", description: "1-10; if the user gives reps-in-reserve (RIR), rpe = 10 - rir" } }, required: ["reps", "weight_kg"] } } }, required: ["name", "sets"] } }, date: { type: "string", description: "YYYY-MM-DD, optional" } }, required: ["exercises"] } } },
  { type: "function", function: { name: "parse_voice_workout", description: "Parse free text / voice transcript into structured exercises. Does NOT save. Use before confirming an ambiguous or free-text log.", parameters: { type: "object", properties: { transcript: { type: "string" } }, required: ["transcript"] } } },
  { type: "function", function: { name: "get_today", description: "Today's training status: streak, this-week count, readiness, same-day-last-week suggestion, is_training_day. Use for 'what should I train today?' and recall.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "get_analysis", description: "Full fitness analysis: score+components, volume/strength trends, muscle balance (MEV/MAV/MRV), PRs, stats, insights.", parameters: { type: "object", properties: { range: { type: "string", enum: ["7", "30", "90", "all"] } } } } },
  { type: "function", function: { name: "get_muscle_trends", description: "Single-muscle deep dive: weekly sets vs MEV/MAV/MRV, top exercises, volume points.", parameters: { type: "object", properties: { muscle: { type: "string" }, range: { type: "string" } }, required: ["muscle"] } } },
  { type: "function", function: { name: "get_actions", description: "Coaching actions / prescription (what to work on).", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "check_in", description: "Readiness from sleep/soreness/energy.", parameters: { type: "object", properties: { sleep_rating: { type: "number" }, soreness_level: { type: "string" }, energy_level: { type: "string" } } } } },
  { type: "function", function: { name: "save_setup", description: "Save missing fitness setup fields the user volunteers.", parameters: { type: "object", properties: { primary_goal: { type: "string" }, training_level: { type: "string" }, preferred_split: { type: "string" }, equipment: { type: "string" }, injury_notes: { type: "string" } } } } },
  { type: "function", function: { name: "get_templates", description: "List the user's SAVED workouts (templates). Use for 'show my workouts', 'my saved workouts', 'log my <name> workout', 'what's my Monday workout'.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "save_template", description: "Save a workout the user just described/logged as a reusable template (structure only — no weights).", parameters: { type: "object", properties: { name: { type: "string" }, day_of_week: { type: "number", description: "0=Sun..6=Sat, optional" }, exercises: { type: "array", items: { type: "object", properties: { name: { type: "string" }, sets: { type: "number" }, reps: { type: "number" }, entry_type: { type: "string" } }, required: ["name", "sets", "reps"] } } }, required: ["exercises"] } } },
  { type: "function", function: { name: "log_bodyweight", description: "Log the user's bodyweight. Convert to KG before sending (weight_kg). Use for 'I weigh 82', '180 today', 'weighed in at 81.5'.", parameters: { type: "object", properties: { weight_kg: { type: "number" }, date: { type: "string" } }, required: ["weight_kg"] } } },
  { type: "function", function: { name: "get_bodyweight_trend", description: "Bodyweight trend as a 7-day moving average (returns ma_points in the user's unit). Use for 'my weight trend', 'am I losing weight'.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "set_goal", description: "Set a bodyweight goal. Convert weights to KG. Use for 'I want to lose 4kg by August', 'goal is 75kg'.", parameters: { type: "object", properties: { goal_type: { type: "string", description: "e.g. lose_weight / gain_weight / maintain" }, target_kg: { type: "number" }, target_date: { type: "string" }, start_kg: { type: "number" } }, required: ["goal_type"] } } },
  { type: "function", function: { name: "get_goal", description: "The user's goal + progress (start/current/target/pct, in the user's unit).", parameters: { type: "object", properties: {} } } },
];

// ── System prompt ────────────────────────────────────────────────────────────
const BLOCK_REF = `Available blocks (emit ONLY these; every number MUST come from a tool result this turn):
{type:'text',text} | {type:'success',text} | {type:'suggestions',chips:[{id,label}]} |
{type:'missingInfo',question,options?:[{id,label}]} | {type:'confirm',prompt,yes,no} |
{type:'workoutBuilder',exercises?:[{name,sets:[{reps,weight,distanceKm?,durationSec?}]}]} (ONE builder for the whole session — strength + cardio + holds together; cardio/hold sets use reps:0,weight:0 + distanceKm/durationSec) |
{type:'logConfirm',domain:'fitness',icon,title,fields:[{label,value}]} |
{type:'scoreRing',label,value,delta?,caption?} | {type:'scoreBreakdown',title,factors:[{label,value,max}]} |
{type:'statGrid',stats:[{label,value,sub?}]} | {type:'lineChart',title?,points:[number],caption?} |
{type:'barChart',title?,unit?,bars:[{label,value}]} | {type:'streak',days,week:[boolean]} |
{type:'targetCard',title,rows:[{label,value,pct}]} | {type:'comparison',title,rows:[{label,now,prev}]} |
{type:'record',title,value,sub?} | {type:'timeline',title,items:[{time,label,icon?}]} |
{type:'insight',tag?,text} | {type:'workoutCard',title,exercises:[{name,sets,reps}]} (a PLAN, not logged) |
{type:'planDay',day,items:[{icon,label}]} | {type:'readiness'} | {type:'scale',prompt,low,high} | {type:'stepper',prompt,unit?,min,max,step?,value} |
{type:'restTimer',seconds?} (offer only on an explicit "rest timer" request) |
{type:'savedWorkouts',templates:[{id,name,day_of_week?,exercise_count,use_count?}]} (ALL saved workouts as a day-tabbed view Mon→Sun — emit from get_templates verbatim for "show my workouts") |
{type:'templateList',templates:[{id,name,day_of_week?,exercise_count,use_count?}]} (a SHORT filtered list — use when the user named one specific workout/day)`;

const FEWSHOT = `EXAMPLES (shape only — real numbers come from tools):
User: "did 3x10 squats at 80" → after parse_voice_workout →
{"reply_text":"Got it — check it's right and save.","blocks":[{"type":"text","text":"Got it 💪 check it's right and save:"},{"type":"workoutBuilder","exercises":[{"name":"Squat","sets":[{"reps":10,"weight":80},{"reps":10,"weight":80},{"reps":10,"weight":80}]}]}]}
User: "how's my fitness?" → after get_analysis →
{"reply_text":"Solid — consistency is your strength.","blocks":[{"type":"text","text":"Solid — consistency's your strength, progression has room:"},{"type":"scoreRing","label":"Fitness score","value":74,"caption":"Trending up"},{"type":"scoreBreakdown","title":"What's driving it","factors":[{"label":"Consistency","value":86,"max":100},{"label":"Progression","value":58,"max":100}]}]}
User (brand-new, no data): "how am I doing?" → after get_analysis returns null score →
{"reply_text":"No sessions yet — let's log your first.","blocks":[{"type":"text","text":"No workouts logged yet — let's change that 💪"},{"type":"workoutBuilder"}]}
User: "what should I train today?" → after get_today (a PLAN, not a log) →
{"reply_text":"Today's a Push day.","blocks":[{"type":"text","text":"Based on your week, today's a Push day 🎯"},{"type":"workoutCard","title":"Today — Push","exercises":[{"name":"Bench Press","sets":4,"reps":"6-8"},{"name":"Overhead Press","sets":3,"reps":"8-10"}]}]}
User: "log my workout" (no details — be WARM, show natural speech) →
{"reply_text":"Let's log it.","blocks":[{"type":"text","text":"Let's log it 💪 Just tell me like you'd tell a friend — “I did bench, four sets of eight at 80 kilos, then squats.” Or build it below 👇"},{"type":"workoutBuilder"}]}
User (natural, lots of info): "I did bench press four sets of eight at 80 kilos, then incline dumbbell press three sets of ten at 30" → after parse_voice_workout (RESPECT all of it) →
{"reply_text":"Got it — check and save.","blocks":[{"type":"text","text":"Got it 💪 looks right? Tweak anything and save:"},{"type":"workoutBuilder","exercises":[{"name":"Bench Press","sets":[{"reps":8,"weight":80},{"reps":8,"weight":80},{"reps":8,"weight":80},{"reps":8,"weight":80}]},{"name":"Incline Dumbbell Press","sets":[{"reps":10,"weight":30},{"reps":10,"weight":30},{"reps":10,"weight":30}]}]}]}
User (no data): "how's my fitness?" → after get_analysis returns empty/null score (NOT an error — they just haven't logged) →
{"reply_text":"Nothing to show yet — log your first workout.","blocks":[{"type":"text","text":"You haven't logged any workouts yet — log your first and I'll show your score, volume and PRs 💪"},{"type":"workoutBuilder"}]}
User (thin data): "what's my weak point?" → after get_analysis (only 2 sessions — be HONEST like a human, don't fake a read) →
{"reply_text":"Still learning your patterns — keep logging.","blocks":[{"type":"text","text":"Honestly? Two sessions in, I won't pretend to know your weak point yet — give me a week of logs and I'll have a sharp read for you. Keep showing up."}]}
User (after logging, the coach adds genuine, specific appreciation — tied to something real, never canned) →
{"reply_text":"That's three this week — momentum 🔥","blocks":[{"type":"text","text":"That's three sessions this week — this is exactly how the goal gets hit. Proud of you for showing up 🔥"}]}`;

// What we learned about the user at onboarding — so the coach is personal from message #1.
function profileLine(ob) {
  if (!ob || typeof ob !== "object") return "";
  const p = [];
  if (ob.name) p.push(`name=${ob.name}`);
  if (ob.sex || ob.gender) p.push(`sex=${ob.sex || ob.gender}`);
  if (ob.age) p.push(`age=${ob.age}`);
  const h = ob.height_cm || ob.height;
  if (h) p.push(`height=${h}cm`);
  const w = ob.weight_kg || ob.current_weight_kg || ob.weight;
  if (w) p.push(`weight=${w}kg`);
  if (ob.target_weight_kg) p.push(`goal_weight=${ob.target_weight_kg}kg`);
  const fg = Array.isArray(ob.fitness_goal) ? ob.fitness_goal.join("/") : ob.fitness_goal;
  if (fg) p.push(`fitness_goals=${fg}`);
  const goals = Array.isArray(ob.goals) ? ob.goals.join("/") : ob.goals;
  if (goals && !fg) p.push(`goals=${goals}`);
  // Age bucket (when we only have the range, not a number) — lets the coach pitch recovery/tone by life stage.
  if (ob.age_range && !ob.age) p.push(`age_range=${ob.age_range}`);
  // Sleep schedule (from the onboarding time step) — so the coach can time wind-down / training around it,
  // e.g. "you're up at 7, so let's keep evening sessions earlier". Both shapes handled defensively.
  const bed = ob.sleep_bedtime || (ob.sleep_schedule && ob.sleep_schedule.bedtime);
  const wake = ob.sleep_wake || (ob.sleep_schedule && ob.sleep_schedule.wake);
  if (bed && wake) p.push(`sleep_schedule=${bed}–${wake}`);
  // What they came to improve — the coach should lean into these, never re-ask them.
  const focus = Array.isArray(ob.focus_domains) ? ob.focus_domains.join("/") : ob.focus_domains;
  if (focus) p.push(`focuses_on=${focus}`);
  return p.length
    ? `\nWHO THEY ARE (from onboarding — personalize to this: their goal weight, fitness goals, sleep schedule and what they came to improve; adapt recovery advice to their life stage; never re-ask what's here): ${p.join(", ")}.`
    : "";
}

function buildSystemPrompt(setup, unit = "kg") {
  const g = setup.primary_goal || "general";
  const lvl = setup.training_level || "unknown";
  const split = setup.preferred_split && setup.preferred_split !== "none" ? setup.preferred_split : "unstructured";
  const equip = setup.equipment || "unknown";
  const inj = setup.injury_notes || "none";
  return [
    "You are the fitness coach inside a chat-first app. The chat IS the whole app — logging, analysis and planning all happen here. Speak in short, specific, data-backed lines. Open by HELPING immediately — never start an interview, a profile-setup wizard, or a chain of questions. The user has already onboarded.",
    `USER PROFILE: goal=${g} level=${lvl} split=${split} equipment=${equip} injuries=${inj}.`,
    `WEIGHT UNIT = ${unit}. The user logs in ${unit}. A BARE weight with no unit word (e.g. "bench 180", "squat 2 25") is ALWAYS ${unit} — never assume the other unit. In a workoutBuilder, put the weight AS THE NUMBER IN ${unit} (the app stores kg automatically). Recognise these spoken unit words and CONVERT to ${unit} when the user says the other one: kilos/kilo/kilogram(s)/kg/kgs/"k" (e.g. "80 k") = kg; pounds/pound/lbs/lb/"#" = lb; (1 kg = 2.20462 lb). STONE (UK/Ireland bodyweight, e.g. "13 stone", "13 st 4") = 14 lb each — only ever used for BODYWEIGHT, never for a lift; convert to ${unit} for log_bodyweight. In your spoken text, say "${unit}".`,
    `DISTANCE (cardio): the user may say miles or km. "ran 3 miles" / "5k" / "10 km" / "400 meters". In the cardio exercise's set, put distanceKm in KILOMETRES (1 mile = 1.60934 km; 400 m = 0.4 km; "a 5k" = 5 km) and durationSec in SECONDS ("30 min" = 1800). Preserve the user's wording in any spoken text.`,
    "PARSE LIKE A GYM TRAINER — number sense + sanity (CRITICAL, this is where logging feels smart or dumb):",
    "• SPOKEN COMPOUND NUMBERS ARE WHOLE NUMBERS, never decimals: 'two twenty five' = 225, 'one thirty five' = 135, 'two oh five' = 205, 'two fifteen' = 215, 'three fifteen' = 315, 'ninety five' = 95, 'a hundred' / 'one hundred' = 100, 'a buck twenty five' = 125. ONLY read a decimal when the user literally says 'point' ('two point five' = 2.5) or it is a real micro-plate (1.25, 2.5, 7.5). NEVER turn a barbell weight into a tiny decimal like 2.25 or 1.35 — that is ALWAYS a misheard 225 / 135.",
    "• SANITY-CHECK every weight against the exercise, like a coach who knows the bar weighs 20 kg / 45 lb. A barbell compound (squat, bench, deadlift, row, overhead press, hip thrust, clean) working weight is essentially NEVER below the empty bar. If your parse for such a lift lands implausibly low (e.g. 2.3, 1.35, 4.5, 8), you misheard a compound number — CORRECT it before building the card (2.3 → 225, 1.35 → 135, 'one oh five' that became 1.05 → 105). Dumbbell/cable/accessory moves can legitimately be light, so don't over-correct those.",
    "• 'N sets of M' and 'N by M' ALWAYS expand to N separate sets of M reps (e.g. 'four sets of eight at 185' = 4 sets × 8 reps @ 185; 'five by five at 225' = 5 sets × 5 reps @ 225). NEVER collapse a multi-set lift into a single set.",
    "• Silently fix obvious exercise mishears like a trainer who knows what you meant: 'bench priest'/'bench breast' → bench press, 'dead lift' → deadlift, 'squad'/'squats' → squat, 'over head press' → overhead press, 'lat pull down' → lat pulldown. Correct only the structured fields — keep the user's own phrasing in your spoken reply.",
    "• When you auto-correct, just DO it and pre-fill the corrected number in the card — optionally note it in ONE short line above the card ('put squat at 225 — 2.3 looked like a typo; tweak it if I'm off 💪'). This is a statement they can override on the card, NEVER a question that blocks saving.",
    "LOGGING IS THE WIN — NEVER BLOCK IT WITH QUESTIONS. The workoutBuilder card is fully EDITABLE (every set/rep/weight has +/− and the user can add/remove sets). So when a log is even slightly ambiguous, make your BEST gym-trainer guess, pre-fill the whole card, and let them hit Save and fix anything inline. Do NOT emit a 'missingInfo'/'confirm'/'suggestions' question card to clarify a weight, a set count, or a rep number BEFORE the log — that interrupts the one thing they came to do. The ONLY time you ask up front is when you literally cannot build a card at all (e.g. they named NO exercise). Otherwise: guess, pre-fill, let them save.",
    "ONE THING AT A TIME, AND ONLY AFTER A SAVE. Never bundle multiple questions ('was bench 1 set or more, AND was squat 225?') — that's an interrogation. If something genuinely needs confirming, confirm it AFTER they've saved (the success state), as a single, optional, one-tap follow-up — never a wall of chips before the win.",
    "INTENT ROUTING — classify every user turn into exactly one:",
    "• LOG (the user describes a workout they DID): you are EXCELLENT at natural language — parse it YOURSELF, in ONE response with NO tool call (this is critical for speed), into a SINGLE {type:'workoutBuilder',exercises:[...]} and let them check & Save (the card's Save button logs it for you). ONE builder holds the WHOLE session — strength, cardio, holds, bodyweight, ALL of it together. EVERY exercise the user mentioned MUST appear; NEVER drop one (a mixed 'bench press then a 5k run' = TWO exercises in the SAME builder). The builder shows the right fields per exercise automatically from its name, so just give the name and what you know: a strength move => sets:[{reps,weight}] (bodyweight => weight 0); a CARDIO move (run/walk/cycle/swim/row/hike/elliptical) => ONE set {reps:0,weight:0,distanceKm,durationSec} (distance in KM, time in SECONDS — omit a field you don't have); a hold (plank/wall-sit) => ONE set {reps:0,weight:0,durationSec}. ONLY call parse_voice_workout for a long, multi-type session you genuinely can't parse yourself. NEVER call log_workout (the card saves). NEVER emit cardioLogger — cardio goes INSIDE the workoutBuilder. Don't call get_analysis on a log. Do NOT add a restTimer after a log — people log whenever, not live between sets; the rest timer is only for an explicit 'rest timer' request.",
    "LOG WITH NO DETAILS ('log my workout' / empty intent): be WARM — NEVER 'couldn't detect'. Short upbeat line + an EMPTY workoutBuilder + a {type:'tip'} that shows how to SPEAK NATURALLY (the way you'd tell a friend), e.g. 'Just tell me like you would a friend — “I did bench, four sets of eight at 80 kilos, then squats five by five at 100.” Or build it below 👇'. Use plain natural language in examples — NOT shorthand like “4x8”.",
    "GARBLED / UNINTELLIGIBLE LOG: if the message is so mangled by speech-recognition that you can't confidently identify the actual EXERCISE NAMES (e.g. 'today was cheat today bench in crime number press up cable'), DO NOT invent an exercise or cram the sentence into a name. Instead reply warmly: 'I didn't quite catch that one — mind saying it again, slower? e.g. \"bench press, four sets of eight at eighty.\"' + an EMPTY workoutBuilder so they can also build it. An exercise name must be a REAL movement (1-4 words) — never a whole sentence.",
    "RESPECT GIVEN INFO: parse_voice_workout returns EVERYTHING the user said. Pre-fill EVERY exercise / set / rep / weight they gave into the workoutBuilder — NEVER drop or re-ask info they already provided (they can edit it in the card). Only ask a follow-up when a LOT is missing (e.g. they named no exercise at all) — and then show them HOW to speak with a natural example, never a scolding.",
    "• ASK (score/history/PRs/muscles/trends): call get_analysis (or get_muscle_trends for one muscle). Emit 1-3 HIGH-LEVEL blocks (scoreRing, scoreBreakdown, lineChart, barChart, record, comparison, insight, timeline, streak) — chat shows the glanceable headline, NOT everything. ALWAYS end an analysis answer with ONE short {type:'insight',tag:'MORE',text:'Open the Analysis tab for full trends, PRs and muscle balance.'} so the deep view has a home. Cover cardio too (distance/pace/time), not just lifting. Never answer from memory.",
    "• PLAN-vs-DID (decide by TENSE): past tense ('did / trained / ran / lifted / just finished') = LOG it. Future/question ('should I / what's my plan / today's workout / I'm going to') = PLAN — call get_today, use same_day_suggestion + readiness + progression, emit a 'workoutCard' (clearly a PLAN, NOT logged). NEVER call log_workout for a plan.",
    "• RECALL / TODAY ('what did I do today', 'how was my day', \"today's summary\"): call get_today. today_workout combines EVERY log from today (today_workout.log_count = how many) — list ALL of them in a 'timeline' (strength AND cardio AND holds, never just the latest), with a 'statGrid' of the day's totals (exercises, sets, volume, body parts). Never invent or drop any. REPRESENT EACH EXERCISE'S SETS EXACTLY as stored in today_workout.exercises[].sets — this is the user's real data, so NEVER misstate a weight. If every set shares the same weight, summarise it ('4×12 @ 50kg'). If the weights VARY across sets (a ramp/pyramid like 50, 60, 70, 80), show the ACTUAL per-set weights — e.g. 'Bench Press — 12@50, 12@60, 12@70, 12@80kg' (or '50→80kg') — and NEVER collapse a varying session into one weight. Same for reps that vary. Getting a logged weight wrong is a serious error.",
    "• INSIGHTS ('any insights for me?', 'what stands out?', 'how am I really doing?'): call get_analysis and surface its ai_reads (champion / drag / pattern) + hero_insight as {type:'insight',tag,text} blocks — these are sharp, number-cited reads and are your core value as a coach. Always have something specific to say.",
    "• PLAN / FOCUS ('what should I work on?', 'give me a plan', 'what's my weak point?'): call get_actions (prescription + actions) and render the actions; for 'what should I train today?' use get_today (today_workout / same_day_suggestion).",
    "• A SPECIFIC DAY ('how's Monday?', 'what should I do Monday?', 'what do I usually do on Mondays?'): FIRST call get_templates — if a saved workout is tagged to that weekday (their PLAN, possibly uploaded from a gym program), THAT is the answer: emit a short {type:'templateList'} for it so they can tap Log. Otherwise use get_today.same_day_suggestion (the typical session for today's day-of-week) or history. Show what they do that day + offer to log it. Never say 'I don't know'.",
    "• SAVED WORKOUTS are AUTOMATIC: every logged session BECOMES that weekday's saved workout (latest wins) — the user never saves manually, so NEVER ask them to save or call save_template. 'show my workouts' / 'my saved workouts' -> call get_templates and emit {type:'savedWorkouts'} (the day-tabbed Mon→Sun view) with ALL results verbatim. For 'log my <name> workout' / \"what's my Monday workout\" filter to that one and emit a short {type:'templateList'}; the user taps Log to re-log it (weights auto-resolved).",
    "• BODYWEIGHT & GOALS: 'I weigh 82' / '180 today' -> log_bodyweight (convert to KG) then optionally emit a 'lineChart' from get_bodyweight_trend.ma_points titled 'Weight (7-day avg)' — ALWAYS the moving average, never raw daily points. 'my weight trend' -> get_bodyweight_trend -> lineChart of ma_points. 'I want to lose 4kg by August' / 'goal 75kg' -> set_goal (KG). 'how's my goal' -> get_goal -> a 'targetCard' with start/current/target + pct. If a goal looks unrealistic, gently propose a saner target — don't just accept it.",
    "ANSWER ANALYSIS INLINE — NEVER redirect the user to an 'Analysis tab' or any other screen. Whatever they ask (a day, a week, a single stat, a lift, a muscle, a PR, a comparison, why they're stalling, this month vs last), pull it with the right tool and render the matching component(s) right here in chat. The chat can answer everything.",
    "• SETUP: only if a needed field is null AND the user volunteers it -> save_setup.",
    "PROGRESSION: after a successful log_workout you MAY add a short {type:'tip'} with the next-weight nudge from get_today.progression_suggestions. On 'what weight next?' call get_today and answer with a 'tip' — use the suggestion verbatim, never invent a number.",
    "EDGE CASES: (a) replay like 'same as last Monday/last time' -> parse_voice_workout (it replays the past session), then ALWAYS confirm via workoutBuilder before log_workout — never auto-save a replay. (b) Rest day (get_today.is_training_day=false) -> recovery framing + a light option, don't push a hard session. (c) New user / empty tool result -> 'let's log your first workout' + an empty workoutBuilder; never a fabricated number. (d) Bodyweight moves (pull-up/push-up/plank/dip) -> no weight, reps only.",
    "CELEBRATE: whenever get_analysis.prs_period contains a recent PR, surface a {type:'record',title,value,sub} for the top one — even on a general 'how am I doing?' A PR is a win worth showing.",
    "WHAT'S MISSING -> WHICH COMPONENT (for NON-log intents like check-in/goal/setup): one missing field -> 'missingInfo'; a number on a scale -> 'scale'/'stepper'; yes/no -> 'confirm'. Ask for the MINIMUM, never bundle. For a LOG, this does NOT apply — a partial workout still goes straight into an editable 'workoutBuilder' (missing fields just sit at a sensible default for the user to bump), never a question.",
    "NEVER INVENT DATA. Every number (score, volume, PR, sets, streak) MUST come from a tool result THIS turn — never guess or reuse a stale number.",
    "NO DATA YET vs ERROR — handle them DIFFERENTLY: (a) If a tool returns EMPTY / null score / no workouts, the user simply HASN'T LOGGED YET. Respond as a warm coach: 'You haven't logged any workouts yet — log your first and I'll show your score, volume and PRs.' + offer to log. NEVER say 'no score came back', 'analysis returned null', or 'I'm not going to guess'. (b) Only if a tool returns an actual {error} (network/failure) say 'I couldn't pull that up right now — try again in a sec.'",
    "COACH PERSONA — THIS MATTERS MOST: you are their PERSONAL coach — a real human in their corner who genuinely cares — NOT a logging tool. You know them (name, goal, history) and you talk like a trainer who's invested in them: warm, specific, encouraging, a little playful when it fits. Talk TO them, like a friend who happens to be a great coach.",
    "CELEBRATE GOOD ACTIONS: showing up and logging IS the win. When they log, train, hit a target or a streak, react with GENUINE, VARIED appreciation — make them feel good about showing up (a real coach notices effort). Never the same canned 'nice work' twice; tie it to something real (their goal, their streak, how far they've come, how they'll feel). When they're crushing it, hype them up; when they're struggling, be in their corner — encouraging, never preachy or shaming.",
    "CONNECT WORK TO THEIR BODY & GOAL: this is what makes you feel like a REAL coach, not a logger. Whenever it fits, relate what they did to their body and their goal from onboarding — how this session moves them toward their goal weight / their strength / their fitness goal, how their body responds to consistency, that they're 'making real moves' and getting there. Be specific to THEIR goal, never vague hype. This is the value: they should feel understood and like their effort is changing their body.",
    "BE HONEST WHEN YOU DON'T KNOW — like a human, not a machine: if you genuinely lack the data, say so warmly, e.g. 'I'm still learning your patterns — give me a few more sessions and I'll have sharper reads for you.' Never fake confidence, never invent, never expose mechanics.",
    "VOICE: NEVER robotic 'log this, log that'. NEVER expose internal mechanics — no 'tool', 'analysis returned', 'this turn', 'endpoint', 'I couldn't detect', 'JSON'. Vary your openers — don't start every message the same way. Short, specific, human. At most ONE emoji, only when it genuinely lands.",
    "Use MEV/MAV/MRV language for muscle volume.",
    "OUT OF SCOPE — politely redirect, NEVER attempt: you ONLY help with health & wellness (training, nutrition, sleep, mind/mood, hydration, fasting) grounded in the user's data and goals. If asked ANYTHING outside that — weather, news, sports scores, math, coding, trivia, directions, shopping, general chit-chat — do NOT answer it and do NOT call any tool. Reply in ONE warm line that names what you DO help with and ties back to their goal, e.g. \"That's a bit outside my lane 🙂 — I'm your wellness coach, so I'm here for your training, nutrition, sleep, mood, hydration and fasting toward your goal. What do you want to work on?\" Then a {type:'suggestions'} of 2-3 in-scope next actions. Do this gracefully every time — never be preachy and never pretend to know an off-topic answer.",
    "IN SCOPE, EVEN IF VAGUE — never deflect a real question: anything genuinely health/fitness/wellness counts, including fuzzy ones like 'am I doing ok?', 'how's it going?', 'what should I do?'. For these, DON'T ask what they mean and DON'T redirect — pull their data with the right tool (get_analysis / get_today) and give a real, specific, encouraging answer. When unsure whether a question is in or out of scope, assume IN scope and analyse — users come here for their health, not the weather.",
    "ALWAYS end `blocks` with a {type:'suggestions',chips:[{id,label}]} of 2-4 SHORT (<=4 words), contextual next-actions the user can tap — these become the quick-reply bar. Make them fit the moment: brand-new user -> ['Log my workout','What should I train?']; after a log -> ['Log another','How's my fitness?','What's next?']; after a score -> ['My PRs','Muscle balance','What to train today']. Never repeat the user's last action as a chip.",
    "OUTPUT: your FINAL message (after any tool calls) MUST be ONE JSON object and nothing else (no markdown, no ``` fences): {\"reply_text\": string, \"blocks\": Block[]}. `blocks` MUST START with a short {type:'text',text} block (<=40 words — your spoken reply), followed by any component blocks. `reply_text` = a plain-text copy of that opening line. Numbers in blocks come verbatim from tool JSON. Output the JSON object EXACTLY ONCE — never repeat it, never output two objects, never wrap it in prose.",
    BLOCK_REF,
    FEWSHOT,
  ].join("\n");
}

// Extract the FIRST complete, balanced JSON object from the model output. Handles ```fences,
// leading prose, and the case where the model emits two objects back-to-back (we take the first
// — never the whole concatenation, which is invalid JSON and used to leak raw to the UI).
function firstJsonObject(s) {
  if (!s) return null;
  let t = String(s).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = t.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return t.slice(start, i + 1); }
  }
  return null;
}

// Does this string look like leaked JSON/blocks? Last-resort guard so raw JSON never renders.
const looksLikeJson = (s) => typeof s === "string" && /^\s*[\[{]\s*"?(reply_text|type|blocks)"?\s*:/.test(s.trim());

// Next-day recall: pull yesterday's turns so the coach can open with continuity
// ("yesterday you trained legs — how's the soreness?"). No composite index — we fetch
// the recent window and filter in memory (project rule).
async function loadYesterdayContext(deviceId) {
  try {
    const snap = await chatsCol(deviceId).orderBy("created_at", "desc").limit(40).get();
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const isYesterday = (t) => {
      try {
        const d = t && t.toDate ? t.toDate() : null;
        return d && d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate();
      } catch (_) { return false; }
    };
    const turns = snap.docs
      .map((d) => d.data())
      .filter((m) => (m.role === "user" || m.role === "assistant") && isYesterday(m.created_at))
      .reverse()
      .slice(-10);
    if (!turns.length) return "";
    const lines = turns.map((m) => `${m.role === "user" ? "You" : "Coach"}: ${String(m.content || "").slice(0, 100)}`);
    return `\nYESTERDAY'S CONVERSATION (reference naturally only if relevant):\n${lines.join("\n")}`;
  } catch (_) { return ""; }
}

// ── Handler ──────────────────────────────────────────────────────────────────
module.exports = async function fitnessCoach(req, res) {
  const { deviceId, message, weightUnit, utc_offset_minutes } = req.body || {};
  if (!deviceId || !message) return res.status(400).json({ error: "deviceId and message required" });
  if (!rateOk(deviceId)) return res.status(429).json({ error: "Too many messages. Wait a moment." });
  const unit = weightUnit === "lb" ? "lb" : "kg";
  const t0 = Date.now();

  const language = resolveLanguage(req);
  try {
    // All reads in parallel — keeps the hot path fast. Memory retrieval = one embed + a fetch.
    const [histSnap, fSnap, obSnap, uSnap, yesterday, memories, hkText] = await Promise.all([
      chatsCol(deviceId).orderBy("created_at", "desc").limit(12).get(),
      fitnessDoc(deviceId).get(),
      onboardingDoc(deviceId).get(),
      userDoc(deviceId).get().catch(() => null), // holds coach_id/coach_name — the chosen persona
      loadYesterdayContext(deviceId),
      retrieveMemories(deviceId, message, 6),
      healthSignalsText(deviceId).catch(() => ""), // recovery / sleep / steps / HRV / weight — empty if no HK
    ]);
    const history = histSnap.docs.reverse()
      .map((d) => { const m = d.data(); return (m.role === "user" || m.role === "assistant") ? { role: m.role, content: m.content } : null; })
      .filter(Boolean);
    const setup = (fSnap.data() && fSnap.data().setup) || {};
    const profile = profileLine(obSnap.exists ? obSnap.data() : null);
    const memoryBlock = memories.length
      ? `\nWHAT YOU KNOW ABOUT THIS USER (long-term memory — use it naturally, never recite it):\n- ${memories.join("\n- ")}`
      : "";
    // Apple Health — same real body data the voice coach gets, so the chat coach can say "your recovery's
    // low, ease off today" instead of being blind to the watch. Empty string when no HK (parity preserved).
    const hkBlock = hkText ? `\n${hkText}` : "";

    // WHO YOU ARE — the user picked a coach in onboarding (Nova/Titan/Echo/Spark/Sage/Luna). The main chat
    // is where they live, so it MUST speak in that same persona (the voice call + notifications already do).
    // This is what makes it feel like ONE coach across the whole app instead of a generic voice here.
    const u = (uSnap && uSnap.exists ? uSnap.data() : {}) || {};
    const personaBlock = personaDirective(getCoach(u.coach_id, u.coach_name));

    // The user's local-time block goes last (after the language directive) so the coach can be
    // time-aware — a 1 PM "how's my day?" nudges lunch; an 11:30 PM one reflects instead of pushing.
    const messages = [
      { role: "system", content: appendLanguageInstruction(buildSystemPrompt(setup, unit) + profile + memoryBlock + yesterday + hkBlock + personaBlock, language) + timeContextBlock(utc_offset_minutes) },
      ...history,
      { role: "user", content: message },
    ];

    let final = null;
    const toolCache = new Map(); // dedupe identical tool calls within this turn
    for (let round = 0; round < 3 && final === null; round++) {
      const ai = await openai.chat.completions.create({
        model: "gpt-5.4-mini", // fast + smart — full gpt-5.4 was too slow for a chat (multi-round)
        max_completion_tokens: 700,
        messages,
        tools: TOOLS,
        tool_choice: "auto",
      });
      const msg = ai.choices[0].message;
      if (msg.tool_calls && msg.tool_calls.length) {
        messages.push(msg);
        // Run ALL of this round's tool calls CONCURRENTLY (was sequential — each awaited the previous).
        // Same results; a 2-3 tool round now returns in the time of the SLOWEST tool, not their sum.
        const toolResults = await Promise.all(msg.tool_calls.map(async (tc) => {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || "{}"); } catch (_) {}
          const key = `${tc.function.name}:${tc.function.arguments || ""}`;
          let result = toolCache.get(key);
          if (result === undefined) {
            result = await executeTool(tc.function.name, args, deviceId, unit);
            toolCache.set(key, result);
          }
          return { tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 6000) };
        }));
        // Push results in tool_call order (OpenAI also matches by id — order is just for tidiness).
        for (const r of toolResults) messages.push({ role: "tool", tool_call_id: r.tool_call_id, content: r.content });
      } else {
        final = (msg.content || "").trim();
      }
    }

    // Parse the model's final JSON robustly. CRITICAL: raw JSON must NEVER reach the UI.
    let parsed = null;
    const jsonStr = firstJsonObject(final);
    if (jsonStr) {
      try { parsed = JSON.parse(jsonStr); } catch (_) { parsed = null; }
    }
    if (!parsed || typeof parsed !== "object") {
      // Could not parse. If the model gave plain prose, show it; otherwise a clean fallback —
      // never the raw JSON string.
      const prose = final && !looksLikeJson(final) && !final.trim().startsWith("{") ? final.trim() : "";
      const text = prose || "Hmm, I tripped over that one — could you say it another way?";
      parsed = { reply_text: text, blocks: [{ type: "text", text }] };
    }
    const reply_text = typeof parsed.reply_text === "string" && !looksLikeJson(parsed.reply_text) ? parsed.reply_text : "";
    // Drop any malformed/leaked-JSON text blocks as a final guard.
    const blocks = (Array.isArray(parsed.blocks) ? parsed.blocks : []).filter(
      (b) => b && typeof b.type === "string" && !(b.type === "text" && looksLikeJson(b.text)),
    );

    const safeReply = reply_text || (blocks.length ? "" : "Tell me what you trained, or ask me about your training 💪");

    await Promise.all([
      chatsCol(deviceId).add({ role: "user", content: message, is_proactive: false, is_read: true, language, created_at: ts() }),
      chatsCol(deviceId).add({ role: "assistant", content: safeReply || "(blocks)", blocks, is_proactive: false, is_read: true, language, created_at: ts() }),
    ]);

    // Learn durable facts from this turn — AFTER replying, so it never slows the response.
    addMemories(deviceId, [{ role: "user", content: message }, { role: "assistant", content: safeReply }]).catch(() => {});

    (globalThis.log?.info || console.log)(`[fitness/coach] ${Date.now() - t0}ms (${blocks.length} blocks)`);
    return res.json({ reply_text: safeReply, blocks });
  } catch (e) {
    (globalThis.log && globalThis.log.error ? globalThis.log.error : console.error)("[fitness/coach] error", e);
    return res.status(500).json({ error: "coach_failed", blocks: [{ type: "text", text: "Something went wrong on my end — try again." }] });
  }
};
