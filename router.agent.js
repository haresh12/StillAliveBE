"use strict";
// ════════════════════════════════════════════════════════════════════════════
// router.agent.js — THE FIRST DECISION POINT for the multi-agent coach.
//
// One AI classifies every inbound chat message into the ONE agent that owns it
// (+ a coarse intent), so the app dispatches to exactly that agent instead of
// cascading through per-agent guards (which leaks — e.g. a meal description
// falling through to the fitness coach). This is the scalable pattern: to add a
// 4th…15th agent, append ONE entry to AGENTS — the classifier and the FE
// dispatch grow with the registry, no new branching logic in the cascade.
//
// POST /api/route/classify { text } → { domain, intent, confidence, source }
// ════════════════════════════════════════════════════════════════════════════
const express = require("express");
const { OpenAI } = require("openai");
const { MODELS, OPENAI_TIMEOUT_MS, safeJSON } = require("./lib/model-router");

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: OPENAI_TIMEOUT_MS });
const log = globalThis.log || console;

// ── The agent registry — the ONLY thing to edit when a new agent ships. ──────
const AGENTS = [
  { id: "fitness",   blurb: "workouts, training, exercises, sets & reps, weights, lifting, gym, cardio, running, steps, PRs, workout plans/programs, bodyweight check-ins, 'what should I train today'" },
  { id: "nutrition", blurb: "food, meals, eating (ate/had/grabbed/ordered/drank), calories, macros, protein/carbs/fat, diet, snacks, recipes, AND any drink consumed as part of eating (a coffee, a coke/soda, juice with a meal); 'how's my nutrition', logging a meal by text or photo" },
  { id: "sleep",     blurb: "sleep, bedtime, wake time, how long/well they slept, naps, night wakings, sleep quality, restlessness, snoring, grogginess, AND how rested/energetic/tired they feel after sleeping; 'how's my sleep'" },
  { id: "mind",      blurb: "mood, emotions, stress, anxiety, how they feel emotionally ('I feel low/anxious/great'), mental check-ins, journaling — ONLY when they are NOT describing sleep or food" },
  { id: "water",     blurb: "PLAIN water / hydration intake ('a glass of water', '2L today', 'I'm thirsty', 'log water') — NOT a drink that is part of a meal" },
  { id: "fasting",   blurb: "fasting windows, when they started/broke a fast, fasting schedule, 16:8/OMAD, 'how's my fasting'" },
  { id: "general",   blurb: "greetings, small talk, app/account questions, or anything not clearly owned by another agent" },
];
const DOMAIN_IDS = AGENTS.map((a) => a.id);
const INTENTS = ["log", "analysis", "plan", "question", "other"];

// ── Deterministic resilience net — used ONLY if the LLM call fails/parses badly,
//    so a network blip never hangs the composer. NOT the primary router. ───────
function heuristic(text) {
  const t = (text || "").toLowerCase();
  const food = /\b(ate|eaten|eating|had|have|having|drank|drink|grabbed|ordered|snack|snacked|breakfast|lunch|dinner|brunch|meal|calorie|calories|macro|macros|protein|carbs?|fat|food|eat|pizza|burger|sandwich|salad|chicken|rice|egg|eggs|toast|coffee|shake|milkshake|yogh?urt|banana|soda|cola|coke|pepsi|juice|milk|ice ?cream|momos?|cake|cookies?|biscuits?|donuts?|samosa|idli|dosa|paratha|rotis?|naan|dals?|paneer|biryani|sushi|tacos?|burrito|bagel|cereal|pancakes?|bacon|sausages?|nuggets?|fruits?|dessert)\b/;
  const fit = /\b(workout|train|trained|training|gym|bench|squat|deadlift|press|curl|row|rows|run|ran|jog|cardio|set|sets|rep|reps|lift|lifted|plan|program|routine|pr|prs|cycle|swim|swam|steps?|leg day|chest day)\b/;
  const sleep = /\b(sleep|slept|sleeping|asleep|bed|bedtime|woke|wakings?|nap|napped|napping|insomnia|snor(?:e|ing|ed)?|restless|drowsy|groggy|nightmare|went to bed|hours? in bed|rested|energetic|refreshed)\b/;
  const mind = /\bmood\b|\bi feel\b|\bi'?m feeling\b|\b(anxious|anxiety|stressed|overwhelmed|depressed|lonely|sad|down|panic|numb|burnt? ?out)\b|\bcheck ?in\b|\bmentally\b|\bemotionally\b/;
  const water = /\bwater\b|\bhydrat(?:e|ion|ed|ing)\b|\bthirsty\b|\bparched\b|\blog (?:my )?(?:water|hydration|drink)\b/;
  const fasting = /\bfasting\b|\bintermittent fast|\bomad\b|\b(?:16:8|18:6|20:4|14:10)\b|\beating window\b|\b(?:start|end|break|track) (?:a |my |the )?fast\b|\bmy fast\b/;
  const hasFood = food.test(t), hasFit = fit.test(t), hasSleep = sleep.test(t), hasMind = mind.test(t), hasWater = water.test(t), hasFasting = fasting.test(t);
  // Overlap priority: fasting > NUTRITION > SLEEP > MIND > water > fitness. Food beats water (drink logged
  // with the meal); sleep beats mood (post-sleep "feel rested/energetic" is sleep quality).
  let domain = "general";
  if (hasFasting && !hasFood && !hasFit) domain = "fasting";
  else if (hasFood && !hasFit && !hasSleep) domain = "nutrition";
  else if (hasSleep && !hasFood && !hasFit) domain = "sleep";
  else if (hasMind && !hasFood && !hasFit && !hasSleep && !hasFasting) domain = "mind";
  else if (hasWater && !hasFood && !hasFit && !hasSleep && !hasFasting) domain = "water";
  else if (hasFit && !hasFood && !hasSleep) domain = "fitness";
  else if (hasFasting) domain = "fasting";
  else if (hasFood) domain = "nutrition";
  else if (hasSleep) domain = "sleep";
  else if (hasMind) domain = "mind";
  else if (hasWater) domain = "water";
  else if (hasFit) domain = "fitness";
  const intent =
    /\b(how|trend|score|progress|analysis|stats?|doing|lagging|streak|records?|prs?)\b/.test(t) ? "analysis"
    : /\b(plan|program|routine|what should i)\b/.test(t) ? "plan"
    : /\?\s*$/.test(t) ? "question"
    : "log";
  return { domain, intent, confidence: 0.4, source: "heuristic" };
}

router.post("/classify", async (req, res) => {
  const text = String(req.body?.text || "").slice(0, 500).trim();
  if (!text) return res.json({ domain: "general", intent: "other", confidence: 0, source: "empty" });

  const prompt = `You are the ROUTER for a multi-agent health & fitness app. Decide which ONE agent owns the user's message, plus a coarse intent.

Agents:
${AGENTS.map((a) => `- ${a.id}: ${a.blurb}`).join("\n")}

Intents: ${INTENTS.join(", ")}
  log = recording something they did or ate · analysis = asking about their own stats/trends/score · plan = asking for a plan or what to do · question = a general question · other = none of these.

Decision rules:
- OVERLAP PRIORITY (a message that touches two agents): nutrition BEATS water, and sleep BEATS mind.
- A meal/food description is ALWAYS nutrition, even with no logging verb AND even when it includes a drink: "2 eggs and toast", "we ordered pizza", "I had 8 momos, a coke and ice cream", "burger and a sprite", "just a coffee" → nutrition / log. The drink is logged WITH the meal — do NOT send it to water.
- water ONLY when it is plain hydration with NO food: "a glass of water", "drank 2L today", "I'm thirsty", "log water" → water / log. A bare volume like "200ml" attached to a meal is nutrition, not water.
- sleep OWNS post-sleep feelings: "I slept 11 to 7 and feel great / more energy / rested", "went to bed at 11 woke at 6", "slept badly, woke twice", "I napped", "how's my sleep" → sleep (log, or analysis if a question). Feeling energetic/rested after sleeping is SLEEP, not mind.
- mind ONLY for emotions with NO sleep/food context: "I feel anxious", "my mood is low", "feeling overwhelmed today", "mood check-in" → mind / log.
- fasting: "started my fast", "broke my fast at 2pm", "16:8 today", "how's my fasting" → fasting.
- "bench 4x8", "ran 5k", "log my workout", "leg day", "did 20 pushups" → fitness / log.
- "how's my nutrition/protein/calories" → nutrition / analysis. "how's my fitness/PRs" → fitness / analysis. "how's my mood" → mind / analysis. "how's my water" → water / analysis.
- "what should I eat" → nutrition / plan. "what should I train" → fitness / plan.
- Greetings / unclear → general.

Return ONLY JSON: {"domain": one of [${DOMAIN_IDS.join(", ")}], "intent": one of [${INTENTS.join(", ")}]}.

Message: ${JSON.stringify(text)}`;

  try {
    const r = await openai.chat.completions.create({
      model: MODELS.fast,
      max_completion_tokens: 40,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: prompt }],
    });
    const parsed = safeJSON(r.choices?.[0]?.message?.content, null);
    const domain = parsed?.domain;
    let intent = parsed?.intent;
    if (!DOMAIN_IDS.includes(domain)) return res.json({ ...heuristic(text), source: "fallback_domain" });
    if (!INTENTS.includes(intent)) intent = "other";
    return res.json({ domain, intent, confidence: 0.9, source: "llm" });
  } catch (e) {
    log.error("[router] classify:", e?.message || e);
    return res.json(heuristic(text));
  }
});

module.exports = router;
