'use strict';
// ════════════════════════════════════════════════════════════════════
// cross-agent-llm.js — 5 LLM jobs that power the intelligence layer.
// All calls: structured output, safety-prefixed, cost-capped, cached.
// Uses existing OPENAI_API_KEY via the shared OpenAI client.
// ════════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');
const { OpenAI } = require('openai');
const { SYSTEM_SAFETY_PREFIX, scanContextForCrisis, scanOutput, CRISIS_RESPONSE } = require('./cross-agent-safety');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const db        = () => admin.firestore();
const userDoc   = (id) => db().collection('wellness_users').doc(id);
const costsDoc  = (id, ym) => userDoc(id).collection('llm_costs').doc(ym);
const briefDoc  = (id) => userDoc(id).collection('wellness_meta').doc('briefing');
const journalCol= (id) => userDoc(id).collection('wellness_journal');
const setupDoc  = (id) => userDoc(id).collection('wellness_meta').doc('setup_suggestion');
const skipDoc   = (id) => userDoc(id).collection('wellness_meta').doc('skip_interpretation');
const coachDoc  = (id) => userDoc(id).collection('wellness_meta').doc('coach');

// Hard monthly ceilings per user
const COST_CEILING = {
  briefing:    31,   // 1/day
  journal:     31,   // 1/day
  weekly:      5,    // 1/week
  setup:       8,    // ~2/week
  skip:        12,   // 3/week
};

const dateStr = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
function isoWeek(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

async function bumpCost(deviceId, kind) {
  const ym = new Date().toISOString().slice(0, 7);
  await costsDoc(deviceId, ym).set({
    [kind]: admin.firestore.FieldValue.increment(1),
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}
async function checkBudget(deviceId, kind) {
  const ym = new Date().toISOString().slice(0, 7);
  const snap = await costsDoc(deviceId, ym).get();
  const used = snap.exists ? (snap.data()[kind] || 0) : 0;
  return used < (COST_CEILING[kind] || 0);
}

// ─── SHARED CALL HELPER ────────────────────────────────────────────
async function callLLM({ model, systemPrompt, userPrompt, json = true, max_tokens = 350, temperature = 0.4 }) {
  try {
    const messages = [
      { role: 'system', content: `${SYSTEM_SAFETY_PREFIX}\n\n${systemPrompt}` },
      { role: 'user',   content: userPrompt },
    ];
    const params = { model, temperature, max_tokens, messages };
    if (json) params.response_format = { type: 'json_object' };
    const resp = await openai.chat.completions.create(params);
    const raw = (resp.choices?.[0]?.message?.content || '').trim();
    if (!json) return { raw };
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { return { raw, parsed: null, error: 'json_parse_failed' }; }
    return { raw, parsed };
  } catch (e) {
    return { raw: '', parsed: null, error: e.message };
  }
}

// Trim arrays inside the context to keep prompts short and cost down
function trimContextForPrompt(ctx, opts = {}) {
  const logCap   = opts.logCap   || 7;
  const chatCap  = opts.chatCap  || 4;
  const actCap   = opts.actCap   || 5;
  const out = {
    profile: ctx.profile,
    today: ctx.today,
    setup_state: ctx.setup_state,
    setup_count: ctx.setup_count,
    days_with_any_log: ctx.days_with_any_log,
    total_logs: ctx.total_logs,
    skip_reasons: ctx.skip_reasons,
    action_completion_rate: ctx.action_completion_rate,
    themes: ctx.themes?.dominant?.slice(0, 6) || [],
    hypotheses: (ctx.hypotheses || []).slice(0, 5).map(h => ({
      a: h.a, b: h.b, direction: h.direction, status: h.status,
      n: h.last_n, r: h.last_r,
    })),
    priors: ctx.priors,
    recent_logs: {},
    recent_actions: {},
    recent_chats: {},
  };
  for (const a of Object.keys(ctx.recent_logs || {})) {
    out.recent_logs[a]    = (ctx.recent_logs[a] || []).slice(0, logCap);
    out.recent_actions[a] = (ctx.recent_actions[a] || []).slice(0, actCap);
    out.recent_chats[a]   = (ctx.recent_chats[a] || []).slice(-chatCap);
  }
  return out;
}

// ─── JOB 1: TODAY'S BRIEFING ───────────────────────────────────────
const BRIEFING_SYSTEM = `You write a "today's briefing" — like a doctor's morning note, but for wellness.
Output strict JSON:
{
  "briefing": "2-3 sentences max, ≤55 words. Cite ONE specific number from the user's data. End with one concrete action OR clarifying question.",
  "tone": "neutral" | "encouraging" | "concerned" | "celebrating",
  "evidence": { "log_ids": ["..."], "agents_used": ["sleep","mind"], "confidence": 0.0-1.0 },
  "action": { "agent": "sleep|fitness|...", "title": "specific action ≤8 words", "rationale": "1 sentence" } | null,
  "question": "single short question to ask user" | null
}
If data is too thin to say something specific, set briefing to a kind acknowledgment that day-1 baselines are still being set, plus one suggested action. Confidence 0.3 if n_logs<3, 0.6 if 3-9, 0.85 if 10+.`;

async function generateBriefing(deviceId, ctx) {
  const today = ctx.today;
  const cached = (await briefDoc(deviceId).get()).data();
  if (cached?.date === today && cached.payload) {
    return { ...cached.payload, _cached: true };
  }
  const crisis = scanContextForCrisis(ctx);
  if (!crisis.safe) {
    return { briefing: CRISIS_RESPONSE.text, tone: 'concerned', evidence: { log_ids: [], agents_used: [], confidence: 1 }, action: null, question: null, safety: 'crisis', _crisis: true };
  }
  if (!(await checkBudget(deviceId, 'briefing'))) {
    return cached?.payload || { briefing: 'Daily limit reached. Back tomorrow.', evidence: { confidence: 0 }, _capped: true };
  }
  const trimmed = trimContextForPrompt(ctx, { logCap: 7, chatCap: 3, actCap: 4 });
  const userPrompt = `Today is ${today}. User context (JSON):\n${JSON.stringify(trimmed)}\n\nWrite today's briefing.`;
  const r = await callLLM({ model: 'gpt-4.1-mini', systemPrompt: BRIEFING_SYSTEM, userPrompt, max_tokens: 320 });
  if (!r.parsed) return { briefing: 'Could not generate briefing. Try refreshing in a minute.', evidence: { confidence: 0 }, _error: r.error };
  const safe = scanOutput(r.parsed.briefing);
  if (!safe.safe) r.parsed.briefing = safe.text;
  await bumpCost(deviceId, 'briefing');
  await briefDoc(deviceId).set({
    date: today,
    payload: r.parsed,
    generated_at: admin.firestore.FieldValue.serverTimestamp(),
  });
  return r.parsed;
}

// ─── JOB 2: DAILY JOURNAL ENTRY ────────────────────────────────────
const JOURNAL_SYSTEM = `You write the user's wellness journal — a 2-3 sentence narrative of their day, in observer voice ("you slept...", "your mood logged..."). Cite at least one number.
Output JSON:
{
  "date": "YYYY-MM-DD",
  "summary": "2-3 sentences, ≤60 words",
  "highlights": ["short note", "..."],
  "concerns":  ["short note"] | [],
  "evidence":  { "log_ids":[...], "agents_used":[...], "confidence":0.0-1.0 }
}`;

async function generateJournalEntry(deviceId, ctx, dateOverride) {
  const date = dateOverride || ctx.today;
  const existing = await journalCol(deviceId).doc(date).get();
  if (existing.exists) return { ...existing.data().payload, _cached: true };
  const crisis = scanContextForCrisis(ctx);
  if (!crisis.safe) return null;
  if (!(await checkBudget(deviceId, 'journal'))) return null;
  // Filter logs to just this date
  const trimmed = trimContextForPrompt(ctx);
  for (const a of Object.keys(trimmed.recent_logs)) {
    trimmed.recent_logs[a] = (trimmed.recent_logs[a] || []).filter(l => l.date === date);
  }
  const userPrompt = `Write the journal entry for ${date}. Context:\n${JSON.stringify(trimmed)}`;
  const r = await callLLM({ model: 'gpt-4.1-mini', systemPrompt: JOURNAL_SYSTEM, userPrompt, max_tokens: 280 });
  if (!r.parsed) return null;
  const safe = scanOutput(r.parsed.summary || '');
  if (!safe.safe) r.parsed.summary = safe.text;
  await bumpCost(deviceId, 'journal');
  await journalCol(deviceId).doc(date).set({
    payload: r.parsed,
    generated_at: admin.firestore.FieldValue.serverTimestamp(),
  });
  return r.parsed;
}

// ─── JOB 3: WEEKLY COACH NOTE (gpt-4o, deeper reasoning) ───────────
const WEEKLY_SYSTEM = `You are the user's wellness coach writing a Sunday weekly note. 3-4 sentences, ≤90 words. Cite multiple specific numbers. End with ONE testable change for next week.
Output JSON:
{
  "summary": "the note (≤90 words)",
  "tested_hypothesis": "the one experiment they should try next week, ≤14 words",
  "evidence": { "log_ids":[...], "agents_used":[...], "confidence":0.0-1.0 }
}`;

async function generateWeeklyNote(deviceId, ctx) {
  const week = isoWeek();
  const cached = (await coachDoc(deviceId).get()).data();
  if (cached?.week === week && cached.payload) return { ...cached.payload, _cached: true };
  if (!(await checkBudget(deviceId, 'weekly'))) return cached?.payload || null;
  const trimmed = trimContextForPrompt(ctx, { logCap: 14, chatCap: 5, actCap: 8 });
  const userPrompt = `It's the start of a new week (${week}). Write the weekly note. Context:\n${JSON.stringify(trimmed)}`;
  const r = await callLLM({ model: 'gpt-4.1', systemPrompt: WEEKLY_SYSTEM, userPrompt, temperature: 0.5, max_tokens: 380 });
  if (!r.parsed) return null;
  const safe = scanOutput(r.parsed.summary || '');
  if (!safe.safe) r.parsed.summary = safe.text;
  await bumpCost(deviceId, 'weekly');
  await coachDoc(deviceId).set({
    week,
    payload: r.parsed,
    generated_at: admin.firestore.FieldValue.serverTimestamp(),
  });
  return r.parsed;
}

// ─── JOB 4: SETUP SUGGESTION (which agent to enable next) ──────────
const SETUP_SUGGESTION_SYSTEM = `Given the user's existing data + which agents are unset, recommend ONE additional agent to set up. Cite a specific signal in their data that the new agent would clarify.
Output JSON:
{
  "recommend": "fitness|sleep|mind|nutrition|water|fasting" | null,
  "reason": "≤30 words, specific signal cited",
  "evidence": { "agents_used":[...], "confidence":0.0-1.0 }
}
If all agents are set up or there is no clear signal, return { "recommend": null, "reason": "..." }.`;

async function generateSetupSuggestion(deviceId, ctx) {
  const cached = (await setupDoc(deviceId).get()).data();
  const cacheAgeH = cached?.generated_at ? (Date.now() - cached.generated_at.toMillis()) / 3600000 : 999;
  if (cached && cacheAgeH < 48) return { ...cached.payload, _cached: true };
  if (!(await checkBudget(deviceId, 'setup'))) return cached?.payload || null;
  const trimmed = trimContextForPrompt(ctx, { logCap: 5, chatCap: 2, actCap: 0 });
  const userPrompt = `Recommend the next agent to set up. Context:\n${JSON.stringify(trimmed)}`;
  const r = await callLLM({ model: 'gpt-4.1-mini', systemPrompt: SETUP_SUGGESTION_SYSTEM, userPrompt, max_tokens: 200 });
  if (!r.parsed) return null;
  await bumpCost(deviceId, 'setup');
  await setupDoc(deviceId).set({ payload: r.parsed, generated_at: admin.firestore.FieldValue.serverTimestamp() });
  return r.parsed;
}

// ─── JOB 5: SKIP-REASON INTERPRETATION ─────────────────────────────
const SKIP_SYSTEM = `Given the user's pattern of skipped actions, identify WHY they're skipping and what to change.
Output JSON:
{
  "interpretation": "≤25 words, specific",
  "intervention":   "what we should do differently, ≤20 words",
  "evidence": { "agents_used":[...], "skip_count": N, "confidence":0.0-1.0 }
}`;

async function generateSkipInterpretation(deviceId, ctx) {
  const totalSkips = Object.values(ctx.skip_reasons || {}).reduce((s, v) => s + v, 0);
  if (totalSkips < 3) return null;
  const cached = (await skipDoc(deviceId).get()).data();
  const week = isoWeek();
  if (cached?.week === week) return { ...cached.payload, _cached: true };
  if (!(await checkBudget(deviceId, 'skip'))) return cached?.payload || null;
  const trimmed = trimContextForPrompt(ctx, { logCap: 4, chatCap: 0, actCap: 8 });
  const userPrompt = `User has skipped ${totalSkips} actions recently. Interpret why and recommend an intervention. Context:\n${JSON.stringify(trimmed)}`;
  const r = await callLLM({ model: 'gpt-4.1-mini', systemPrompt: SKIP_SYSTEM, userPrompt, max_tokens: 180 });
  if (!r.parsed) return null;
  await bumpCost(deviceId, 'skip');
  await skipDoc(deviceId).set({ week, payload: r.parsed, generated_at: admin.firestore.FieldValue.serverTimestamp() });
  return r.parsed;
}

module.exports = {
  generateBriefing,
  generateJournalEntry,
  generateWeeklyNote,
  generateSetupSuggestion,
  generateSkipInterpretation,
  callLLM,
  trimContextForPrompt,
  isoWeek, dateStr,
};
