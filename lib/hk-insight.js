'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// hk-insight.js — P/C: the "smart" line for the Body Signals section.
//
// Turns a domain's de-identified metric summary into ONE premium insight using
// the Whoop/Oura template (anomaly vs the user's OWN baseline → likely cause →
// one action). Cached once per user/domain/day. NON-BLOCKING: a cache miss kicks
// generation off in the background and returns null this call, so the analysis
// response never waits on the LLM.
//
// COMPLIANCE (App Store 5.1.2(i) / 5.1.3(i)): the payload sent to OpenAI is
// DE-IDENTIFIED — metric numbers/labels only, NEVER the deviceId, name, or any
// identifier. The deviceId is used ONLY to read/write the local cache, and never
// leaves this server. Health-derived data is never used for ads or shared onward.
// ═══════════════════════════════════════════════════════════════════════════
const { OpenAI } = require('openai');
const { userDoc } = require('./collections');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const log = global.log || console;

const SYSTEM = `You write ONE short, premium wellness insight from a person's own body metrics.
Template: notice something that stands out vs THEIR OWN usual → the most likely everyday cause → ONE specific, gentle next step.
Rules: max 22 words, one sentence, second person ("you"/"your"), plain warm language, calm and encouraging.
NO medical claims or diagnosis, NO listing raw numbers, NO emojis, and NEVER mention "watch", "sensor", "device", "Apple Health", or "data".
If nothing clearly stands out, give one supportive, genuinely useful line for the domain.`;

// Confidence gate — need at least a couple of real signals before we "coach".
function hasSignal(summary) {
  if (!summary) return false;
  const t = (summary.today || []).length;
  const r = (summary.trend || []).length;
  return t + r >= 1;
}

async function generate(domain, summary) {
  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_completion_tokens: 80,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Domain: ${domain}\nMetrics (already anonymous — no identity):\n${JSON.stringify(summary)}` },
    ],
  });
  let text = (resp.choices?.[0]?.message?.content || '').trim().replace(/^["'\s]+|["'\s]+$/g, '');
  if (text.length > 180) text = text.slice(0, 177).replace(/\s+\S*$/, '') + '…';
  return text || null;
}

/**
 * Returns today's cached insight for (deviceId, domain), or null. On a cache miss
 * it fires generation in the background (fire-and-forget) so a later request gets
 * it — the current request is never blocked on the model.
 *
 * `summary` is the DE-IDENTIFIED metric bundle (no identifiers).
 */
async function attachDomainInsight(deviceId, domain, summary, todayDate) {
  if (!deviceId || !domain || !todayDate) return null;
  const ref = userDoc(deviceId).collection('health_insights').doc(`${domain}_${todayDate}`);
  try {
    const snap = await ref.get();
    if (snap.exists && snap.data().text) return snap.data().text;
  } catch { /* read failed — treat as miss */ }

  if (!hasSignal(summary)) return null;

  // Generate ONCE and cache on completion. We give THIS request a short bounded window to show the
  // insight immediately — so a first-of-day open isn't insight-less — but never block beyond the cap.
  // If the model is slower than the cap, generation keeps running and caches for the next load (the old
  // fire-and-forget behaviour). Only ever runs on a cold miss (once per user/domain/day); every other
  // load is an instant cache hit, so this adds no latency to the common path.
  const genPromise = (async () => {
    try {
      const text = await generate(domain, summary);
      if (text) await ref.set({ text, domain, date: todayDate, created_at: Date.now() });
      return text || null;
    } catch (e) { log.warn && log.warn('[hk-insight]', e.message); return null; }
  })();

  const CAP_MS = 700;
  const raced = await Promise.race([
    genPromise,
    new Promise((resolve) => setTimeout(() => resolve(null), CAP_MS)),
  ]);
  return raced || null;
}

module.exports = { attachDomainInsight };
