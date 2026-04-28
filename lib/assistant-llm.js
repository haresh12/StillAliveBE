'use strict';
// ════════════════════════════════════════════════════════════════════
// assistant-llm.js — single LLM pass that humanizes candidate messages
// from the brain. Enforces conversational voice, 8th-grade reading,
// no jargon. Output passes through stripJargon() before display.
// ════════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');
const { OpenAI } = require('openai');
const { SYSTEM_SAFETY_PREFIX } = require('./cross-agent-safety');
const { stripJargon, containsJargon } = require('./translate-insight');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const db        = () => admin.firestore();
const userDoc   = (id) => db().collection('wellness_users').doc(id);
const cacheDoc  = (id, key) => userDoc(id).collection('assistant_cache').doc(key);
const costsDoc  = (id, ym) => userDoc(id).collection('llm_costs').doc(ym);

const MONTHLY_CAP = 35;

const SYSTEM_PROMPT = `You rewrite wellness messages in a warm, direct, personal voice — like a smart friend who knows the user.

Hard rules:
- Each message: max 2 sentences, ≤200 characters total.
- Speak in second person. Use the user's actual numbers from the input.
- Plain English, 8th-grade reading level.
- NEVER write: "r=", "n=", "p=", "Cohen's d", "correlation", "statistically significant", "Pearson", "Bonferroni", "confidence interval", "regression", "p-value".
- NO emojis in the message body. NO "amazing", "great job", "you got this", "keep it up", "awesome".
- Lead with the observation, end with the action implied. Do not be preachy.
- Reuse the user's exact numbers (hours, percentages, counts) — don't change them.

Output strict JSON: { "messages": [ { "id": <id>, "text": "<rewritten>" } ] }
Match each "id" exactly to the input. Same length array.`;

async function bumpCost(deviceId, kind = 'assistant') {
  const ym = new Date().toISOString().slice(0, 7);
  await costsDoc(deviceId, ym).set({
    [kind]: admin.firestore.FieldValue.increment(1),
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}
async function checkBudget(deviceId, kind = 'assistant') {
  const ym = new Date().toISOString().slice(0, 7);
  const snap = await costsDoc(deviceId, ym).get();
  const used = snap.exists ? (snap.data()[kind] || 0) : 0;
  return used < MONTHLY_CAP;
}

function cacheKey(candidates) {
  // Order-independent hash: sort by id, join
  const ids = candidates.map(c => c.id).sort().join('|');
  return Buffer.from(ids).toString('base64').slice(0, 80).replace(/[^A-Za-z0-9]/g, '_');
}

// MAIN
async function humanizeMessages(deviceId, candidates) {
  if (!candidates?.length) return [];

  const key = cacheKey(candidates);
  // Cache lookup: if we've humanized this exact set in last 6h, reuse
  try {
    const cached = await cacheDoc(deviceId, key).get();
    if (cached.exists) {
      const ageH = (Date.now() - cached.data().t) / 3600000;
      if (ageH < 6) {
        return mergeBack(candidates, cached.data().messages);
      }
    }
  } catch {}

  if (!(await checkBudget(deviceId))) {
    // Fallback: return candidates with raw_text scrubbed for jargon
    return candidates.map(c => ({ ...c, text: stripJargon(c.raw_text) }));
  }

  const userPayload = candidates.map(c => ({
    id: c.id,
    category: c.category,
    raw: c.raw_text,
  }));

  let parsed = null;
  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      temperature: 0.4,
      max_tokens: 600,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `${SYSTEM_SAFETY_PREFIX}\n\n${SYSTEM_PROMPT}` },
        { role: 'user',   content: `Rewrite these in conversational voice:\n${JSON.stringify(userPayload)}` },
      ],
    });
    parsed = JSON.parse(resp.choices[0].message.content);
    await bumpCost(deviceId);
  } catch (e) {
    console.warn('[assistant-llm]', e.message);
    return candidates.map(c => ({ ...c, text: stripJargon(c.raw_text) }));
  }

  // Sanitize: scrub any jargon that slipped through
  const cleaned = (parsed.messages || []).map(m => ({
    id: m.id,
    text: stripJargon(m.text || ''),
  })).filter(m => m.text && !containsJargon(m.text));

  // Persist to cache
  try {
    await cacheDoc(deviceId, key).set({ t: Date.now(), messages: cleaned });
  } catch {}

  return mergeBack(candidates, cleaned);
}

function mergeBack(candidates, messages) {
  const map = Object.fromEntries(messages.map(m => [m.id, m.text]));
  return candidates.map(c => ({
    ...c,
    text: map[c.id] || stripJargon(c.raw_text),
  })).filter(c => c.text);
}

module.exports = { humanizeMessages };
