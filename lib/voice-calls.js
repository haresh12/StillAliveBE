'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// voice-calls.js — persistence + AI summary ("MOM") for the voice-call coach.
//
// Every call becomes an ACTION: when it ends, the worker POSTs the transcript here,
// we generate a title + summary + takeaways + topics (the "minutes of the call"),
// and store it so the Call tab can show the full history of what came out of each
// conversation. Stored per user in the bc namespace:
//     wellness_bc_users/{deviceId}/voice_calls/{callId}
// ═══════════════════════════════════════════════════════════════════════════
const OpenAI = require('openai');
const { userDoc } = require('./collections');
const { resolveAnchor } = require('./user-anchor');
const { computeCost } = require('./voice-cost');

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const SUMMARY_MODEL = process.env.VOICE_SUMMARY_MODEL || 'gpt-5.4-mini';

const callsCol = (deviceId) => userDoc(deviceId).collection('voice_calls');
// Durable cross-call memory: the accumulating set of things we've learned about the user.
const memoryDoc = (deviceId) => userDoc(deviceId).collection('voice_memory').doc('learnings');
const MAX_LEARNINGS = 40;
const pad = (n) => String(n).padStart(2, '0');
const localDate = (ms, offMin = 0) => {
  const t = new Date(ms + offMin * 60000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};

// Build the "minutes of the call" from the transcript. Deterministic fallback if the
// LLM is unavailable so a call is NEVER lost.
async function summarizeTranscript(transcript, opts = {}) {
  const turns = Array.isArray(transcript) ? transcript.filter(t => t && t.text) : [];
  const fallback = {
    title: turns.length ? 'Coaching call' : 'Quick call',
    summary: turns.length ? 'You and your coach talked through how things are going.' : 'Short call — no conversation captured.',
    takeaways: [],
    topics: [],
    impact: '',
    learnings: [],
  };
  if (!openai || !turns.length) return fallback;

  const convo = turns.map(t => `${t.role === 'assistant' ? 'Coach' : 'User'}: ${t.text}`).join('\n').slice(0, 8000);
  const sys = [
    'You are analyzing a short voice coaching call between a health coach and a user.',
    'Return STRICT JSON with keys:',
    '  title: 4-6 word headline of what the call was about',
    '  summary: 2-3 sentence recap in second person ("You talked about…"), warm and specific',
    '  takeaways: array of 0-4 short action items — ONLY health/wellness actions in THIS app\'s domains (fitness, nutrition, sleep, mind, water, fasting). Imperative + specific. Return [] if the call had no relevant in-app action items. NEVER include off-topic items (e.g. "call mom", "buy groceries", work tasks).',
    '  impact: ONE short sentence on the single most useful HEALTH change this call could drive for them (the "so what"), within the app\'s domains. "" if none.',
    '  topics: array of 1-4 one-word domain tags from {fitness,nutrition,sleep,mind,water,fasting,general}',
    '  learnings: array of 0-4 SHORT durable facts you learned about THIS user worth remembering for future calls —',
    '    their needs, preferences, struggles, constraints, or what motivates them (e.g. "Struggles to eat protein at breakfast",',
    '    "Prefers morning workouts", "Motivated by an upcoming wedding"). Only stable facts, NOT one-off events. [] if none.',
    'Be concrete. Never invent facts not in the transcript.',
  ].join('\n');

  try {
    const r = await openai.chat.completions.create({
      model: SUMMARY_MODEL,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: `User name: ${opts.name || 'the user'}\n\nTranscript:\n${convo}` },
      ],
      max_completion_tokens: 500,
      response_format: { type: 'json_object' },
    });
    const parsed = JSON.parse(r.choices?.[0]?.message?.content || '{}');
    return {
      title: String(parsed.title || fallback.title).slice(0, 80),
      summary: String(parsed.summary || fallback.summary).slice(0, 600),
      takeaways: Array.isArray(parsed.takeaways) ? parsed.takeaways.slice(0, 4).map(s => String(s).slice(0, 160)) : [],
      impact: String(parsed.impact || '').slice(0, 200),
      topics: Array.isArray(parsed.topics) ? parsed.topics.slice(0, 4).map(s => String(s).toLowerCase().slice(0, 16)) : [],
      learnings: Array.isArray(parsed.learnings) ? parsed.learnings.slice(0, 4).map(s => String(s).slice(0, 160)).filter(Boolean) : [],
    };
  } catch (e) {
    console.warn('[voice-calls] summarize failed, using fallback:', e.message);
    return fallback;
  }
}

// Persist a finished call (transcript + generated MOM) AND fold its learnings into durable memory.
// `usage` = the call's summed Realtime token totals (from the app); we price it → exact per-call cost.
async function saveCall(deviceId, { mode, startedAtMs, endedAtMs, transcript, name, usage, model }) {
  const mom = await summarizeTranscript(transcript, { name });
  const ref = callsCol(deviceId).doc();
  const turns = Array.isArray(transcript) ? transcript.filter(t => t && t.text) : [];
  // Exact cost from the tokens the call actually spent (audio/text, cached vs not). Duration sharpens
  // the small transcription estimate (user talk-time = call − coach talk).
  const durationSec = Math.max(0, Math.round(((endedAtMs || Date.now()) - (startedAtMs || Date.now())) / 1000));
  const cost = usage ? computeCost(usage, model || process.env.VOICE_REALTIME_MODEL || 'gpt-realtime-mini', durationSec) : null;
  if (cost) {
    console.log(`💵 [voice-calls] call cost=$${cost.cost_usd.toFixed(4)} tokens=${cost.total_tokens} (cached ${cost.cached_tokens}) model=${cost.model} device=${deviceId}`);
  }
  const doc = {
    id: ref.id,
    mode: mode === 'ai' ? 'ai' : 'user',
    started_at: startedAtMs || Date.now(),
    ended_at: endedAtMs || Date.now(),
    duration_sec: Math.max(0, Math.round(((endedAtMs || Date.now()) - (startedAtMs || Date.now())) / 1000)),
    turn_count: turns.length,
    title: mom.title,
    summary: mom.summary,
    takeaways: mom.takeaways,
    impact: mom.impact || '',
    topics: mom.topics,
    learnings: mom.learnings || [],
    transcript: turns.map(t => ({ role: t.role === 'assistant' ? 'assistant' : 'user', text: String(t.text).slice(0, 2000) })),
    // [TESTING] per-call cost + token usage (remove the UI later; keep or drop these fields as you like).
    cost_usd: cost ? cost.cost_usd : null,
    total_tokens: cost ? cost.total_tokens : null,
    cost_breakdown: cost || null,
    created_at: Date.now(),
  };
  await ref.set(doc);
  // Grow the coach's memory of this user (best-effort; never block the call record on it).
  if (mom.learnings && mom.learnings.length) {
    await mergeLearnings(deviceId, mom.learnings, ref.id).catch(e => console.warn('[voice-calls] mergeLearnings failed:', e.message));
  }
  return doc;
}

// Append new, non-duplicate learnings to the durable memory doc (most-recent-kept, capped).
async function mergeLearnings(deviceId, learnings, callId) {
  const snap = await memoryDoc(deviceId).get().catch(() => null);
  const existing = (snap && snap.exists && Array.isArray(snap.data().items)) ? snap.data().items : [];
  const seen = new Set(existing.map(i => String(i.text || '').trim().toLowerCase()));
  let added = 0;
  for (const raw of learnings) {
    const text = String(raw || '').trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    existing.push({ text, ts: Date.now(), call_id: callId || null });
    added++;
  }
  if (!added) return;
  // Keep the most recent MAX_LEARNINGS.
  const items = existing.slice(-MAX_LEARNINGS);
  await memoryDoc(deviceId).set({ items, updated_at: Date.now() }, { merge: true });
}

// Recent call recaps (most recent first) — fed into the briefing so the coach REMEMBERS what it has
// already discussed and builds on it instead of repeating. Compact (no transcript) to stay cheap.
async function getRecentCallContext(deviceId, n = 3) {
  const calls = await listCalls(deviceId, n).catch(() => []);
  return calls.slice(0, n).map(c => ({
    started_at: c.started_at,
    title: c.title,
    summary: c.summary,
    takeaways: Array.isArray(c.takeaways) ? c.takeaways : [],
    topics: Array.isArray(c.topics) ? c.topics : [],
  }));
}

// The durable learnings as plain strings (most recent first) — used by the briefing.
async function getLearnings(deviceId, limit = 12) {
  const snap = await memoryDoc(deviceId).get().catch(() => null);
  const items = (snap && snap.exists && Array.isArray(snap.data().items)) ? snap.data().items : [];
  return items.slice(-limit).reverse().map(i => String(i.text || '')).filter(Boolean);
}

// List recent calls (no composite index — fetch then sort/trim in memory, per data law).
async function listCalls(deviceId, limit = 30) {
  const snap = await callsCol(deviceId).get().catch(() => ({ docs: [] }));
  const all = snap.docs.map(d => d.data());
  all.sort((a, b) => (b.started_at || 0) - (a.started_at || 0));
  return all.slice(0, limit).map(({ transcript, ...rest }) => ({ ...rest, has_transcript: Array.isArray(transcript) && transcript.length > 0 }));
}

async function getCall(deviceId, id) {
  const d = await callsCol(deviceId).doc(String(id)).get().catch(() => null);
  return d && d.exists ? d.data() : null;
}

// Daily call gate. Set to 1 for launch (one coach call/day); kept generous now so testing isn't blocked.
const DAILY_CALL_LIMIT = Number(process.env.VOICE_DAILY_LIMIT || 20);
// ── THE limit (single source of truth): a MONTHLY minute budget, premium-aware. ──────────────────
// Free = 5 min/mo, Premium = 50 min/mo. This is the WHOLE month's allowance — NOT a per-day or
// per-call number. A user can spend it in one call or across many; once the month's total is gone,
// calls are blocked until the calendar month rolls over. The per-call length (voice-realtime.js)
// is derived from the REMAINING budget, so a single call can never exceed what's left this month.
// These are the main COST levers — tune per plan economics via env.
const FREE_MONTHLY_SEC = Number(process.env.VOICE_FREE_MONTHLY_SEC) || 300;      // 5 min/mo (free)
const PREMIUM_MONTHLY_SEC = Number(process.env.VOICE_PREMIUM_MONTHLY_SEC) || 3000; // 50 min/mo (premium)

// Single source of truth for "is this account premium?" — reads the account-level subscription
// (synced to wellness_users; billing isn't agent-sandboxed). Reused by the call-length cap too.
async function isPremium(deviceId) {
  try {
    const admin = require('firebase-admin');
    const ss = await admin.firestore().collection('wellness_users').doc(String(deviceId)).get();
    const sub = ss.exists ? (ss.data().subscription || {}) : {};
    return !!(sub.isPremium || sub.isTrial);
  } catch { return false; }
}

async function dailyStatus(deviceId) {
  const [anchor, premium] = await Promise.all([
    resolveAnchor(deviceId).catch(() => ({ utcOffsetMinutes: 0 })),
    isPremium(deviceId),
  ]);
  const off = anchor.utcOffsetMinutes || 0;
  const today = localDate(Date.now(), off);
  const month = today.slice(0, 7); // YYYY-MM
  const snap = await callsCol(deviceId).get().catch(() => ({ docs: [] }));
  let lastMs = 0;
  let countToday = 0;
  let monthlySec = 0;
  for (const d of snap.docs) {
    const c = d.data();
    if ((c.started_at || 0) > lastMs) lastMs = c.started_at || 0;
    const ld = localDate(c.started_at || 0, off);
    if (ld === today) countToday++;
    if (ld.slice(0, 7) === month) monthlySec += Number(c.duration_sec) || 0;
  }
  const monthlyLimit = premium ? PREMIUM_MONTHLY_SEC : FREE_MONTHLY_SEC;
  const monthlyRemaining = Math.max(0, monthlyLimit - monthlySec);
  const dailyAllowed = countToday < DAILY_CALL_LIMIT;
  const monthlyAllowed = monthlyRemaining > 0;
  const allowed = dailyAllowed && monthlyAllowed;
  return {
    allowed,
    used_today: !dailyAllowed,
    count_today: countToday,
    daily_call_limit: DAILY_CALL_LIMIT,
    monthly_used_sec: monthlySec,
    monthly_limit_sec: monthlyLimit,
    monthly_remaining_sec: monthlyRemaining, // what's left this month — drives the per-call cap + UI
    monthly_allowed: monthlyAllowed,
    is_premium: premium,
    last_call_at: lastMs || null,
    today,
  };
}

module.exports = { summarizeTranscript, saveCall, listCalls, getCall, dailyStatus, isPremium, getLearnings, getRecentCallContext };
