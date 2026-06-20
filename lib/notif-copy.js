'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// notif-copy.js — Tier-1 coach-voice notification copy (the "feels like a real person" layer).
//
// The FE notification engine ships deterministic coach-name templates by default (always available,
// $0, offline). For HIGH-VALUE moments (aha / re-engage / streak-save / recap / offers) it batches them
// to POST /api/notifications/copy → here, and we compose title+body in the user's CHOSEN coach persona
// (the same persona that powers the voice call), in the user's language, grounded in the real numbers.
//
// COST DISCIPLINE: ONE batched call per reconcile (all moments together); the STABLE persona system
// prefix is per-coach (6 personas) so OpenAI prompt-caches it across users; results cached in-memory by
// (coach, lang, moments) for 6h. If OpenAI is missing/slow/errors → return null → the FE keeps its
// template copy. A notification is therefore NEVER blocked on this.
// ═══════════════════════════════════════════════════════════════════════════
const OpenAI = require('openai');
const { getCoach } = require('./coach-roster');
const { userDoc } = require('./collections');

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const MODEL = process.env.NOTIF_COPY_MODEL || 'gpt-5.4-mini';
const TTL_MS = 6 * 3600 * 1000;
const _cache = new Map(); // key → { value, exp }

// STABLE per-coach system prefix (prompt-cached). Never interpolate per-user data here — keep it byte-
// identical across users with the same coach so the cache hits.
function systemPrompt(coach, lang) {
  return [
    `You are ${coach.name}, a personal wellness coach. Your personality: ${coach.persona}.`,
    `Write SHORT mobile push notifications in YOUR voice — like you're texting someone you coach and genuinely care about.`,
    `RULES:`,
    `• Title ≤ 8 words. Body ≤ 140 characters (one sentence, or two short ones).`,
    `• Second person ("you"). Warm and human — never corporate, never robotic, never a generic reminder.`,
    `• NEVER use the word "app". You're their coach, not a piece of software.`,
    `• At most ONE emoji, only if it adds warmth. Usually none.`,
    `• Ground every claim in the numbers provided. NEVER invent a number. One clear, gentle nudge.`,
    `• Match your personality above — your tone, energy and word choice.`,
    lang && lang !== 'en' ? `• Write in the user's language: ${lang}.` : '',
    `Return STRICT JSON: {"items":[{"id":"<same id>","title":"...","body":"..."}]} — exactly one per input moment.`,
  ].filter(Boolean).join('\n');
}

// One compact line per moment for the model. `vars` carries the real numbers (streak, days, target…).
function describeMoments(moments) {
  return moments
    .map(m => `- id=${m.id} | moment=${m.kind}${m.agent ? ` | area=${m.agent}` : ''} | facts=${safeJson(m.vars)}`)
    .join('\n');
}
function safeJson(o) {
  try {
    return o ? JSON.stringify(o) : '{}';
  } catch {
    return '{}';
  }
}

/**
 * Compose coach-voice copy for a batch of moments.
 * @param {string} deviceId
 * @param {Array<{id:string, kind:string, agent?:string, vars?:object}>} moments
 * @param {string} [lang]
 * @returns {Promise<Array<{id,title,body}>|null>} null on any failure (FE falls back to templates).
 */
async function composeCopy(deviceId, moments, lang) {
  if (!openai || !Array.isArray(moments) || !moments.length) return null;

  let coach = getCoach(null, null);
  try {
    const snap = await userDoc(deviceId).get();
    const u = (snap && snap.exists ? snap.data() : {}) || {};
    coach = getCoach(u.coach_id, u.coach_name);
  } catch { /* default coach */ }

  const key = `${coach.name}|${lang || 'en'}|${safeJson(moments.map(m => [m.kind, m.agent || '', m.vars || {}]))}`;
  const hit = _cache.get(key);
  if (hit && Date.now() < hit.exp) return hit.value;

  try {
    const r = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt(coach, lang) },
        { role: 'user', content: describeMoments(moments) },
      ],
      max_completion_tokens: Math.min(900, 70 * moments.length + 120),
      response_format: { type: 'json_object' },
    });
    const parsed = JSON.parse(r.choices?.[0]?.message?.content || '{}');
    const items = (Array.isArray(parsed.items) ? parsed.items : [])
      .filter(i => i && i.id && (i.title || i.body))
      .map(i => ({ id: String(i.id), title: String(i.title || '').slice(0, 80), body: String(i.body || '').slice(0, 180) }));
    if (!items.length) return null;
    _cache.set(key, { value: items, exp: Date.now() + TTL_MS });
    if (_cache.size > 1000) _cache.delete(_cache.keys().next().value);
    return items;
  } catch (e) {
    console.warn('[notif-copy] compose failed, FE falls back to templates:', e.message);
    return null;
  }
}

module.exports = { composeCopy };
