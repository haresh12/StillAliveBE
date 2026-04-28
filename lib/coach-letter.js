'use strict';
// ════════════════════════════════════════════════════════════════════
// coach-letter.js — single weekly LLM call (gpt-4o) producing the
// 150-300 word personal letter for the Coach tab.
//
// Persona spec (locked):
//   "Pulse — your wellness coach. Direct, warm, data-grounded.
//    Speaks to you, not at you."
//
// Voice rules (Whoop discipline):
//   - 150-300 words
//   - Second-person, present-tense
//   - 3+ specific numeric citations from user data
//   - One concrete action at the end (not a checklist)
//   - No "amazing" / "great job" / generic encouragement
//   - No clinical jargon
// ════════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');
const { OpenAI } = require('openai');
const { SYSTEM_SAFETY_PREFIX } = require('./cross-agent-safety');
const { stripJargon } = require('./translate-insight');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const userDoc  = (id) => admin.firestore().collection('wellness_users').doc(id);
const letterDoc = (id) => userDoc(id).collection('wellness_meta').doc('coach_letter');
const costsDoc = (id, ym) => userDoc(id).collection('llm_costs').doc(ym);

const MONTHLY_CAP = 5;

const SYSTEM_PROMPT = `You are Pulse — the user's wellness coach inside the StillAlive app.

Voice:
- Direct, warm, data-grounded. You speak to the user, not at them.
- Second person, present tense.
- Never preachy. Never generic ("great job", "amazing"). Never clinical.
- 150-300 words exactly. Cite at least THREE specific numbers from the user's data.

Structure:
- Paragraph 1: One observation about the week. Use a number.
- Paragraph 2: What's working. Use a number.
- Paragraph 3: What deserves attention (frame as opportunity, not failure).
- Paragraph 4: ONE concrete experiment to try this week (one sentence).

NEVER use: r=, n=, p=, "correlation", "statistically significant", "Cohen's d", "amazing", "great job", "you got this", "keep it up", "incredible".

Output JSON: { "letter": "<the 4 paragraphs joined with \\n\\n>", "signoff": "— Pulse" }`;

function isoWeek(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const w = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(w).padStart(2, '0')}`;
}

async function bumpCost(deviceId) {
  const ym = new Date().toISOString().slice(0, 7);
  await costsDoc(deviceId, ym).set({
    coach_letter: admin.firestore.FieldValue.increment(1),
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}
async function checkBudget(deviceId) {
  const ym = new Date().toISOString().slice(0, 7);
  const snap = await costsDoc(deviceId, ym).get();
  return !snap.exists || (snap.data()?.coach_letter || 0) < MONTHLY_CAP;
}

async function getOrGenerateLetter(deviceId, ctx, harvest, scoreImpact) {
  const week = isoWeek();
  const cached = (await letterDoc(deviceId).get()).data();
  if (cached?.week === week && cached.payload) {
    return { ...cached.payload, _cached: true };
  }
  // Need at least some data to write a meaningful letter
  if ((harvest?.counts?.logs || 0) < 3) {
    return null;
  }
  if (!(await checkBudget(deviceId))) {
    return cached?.payload || null;
  }

  // Compact context for the prompt
  const promptInput = {
    name: ctx.profile?.name || null,
    setup_count: harvest?.counts?.setup_count || 0,
    total_logs: harvest?.counts?.logs || 0,
    overall_completion: harvest?.overall_completion,
    contributors: (harvest?.contributors || [])
      .filter(c => c.setup)
      .map(c => ({
        agent: c.agent,
        score: c.score,
        recent_value: c.recent_value_label,
        baseline_value: c.baseline_label,
        delta: c.delta_vs_baseline,
        status: c.status,
      })),
    wins: (scoreImpact?.wins || []).slice(0, 3).map(w => ({ kind: w.kind, title: w.title })),
    costs: (scoreImpact?.costs || []).slice(0, 3).map(c => ({ kind: c.kind, title: c.title, cost: c.cost })),
    hypotheses: (ctx.hypotheses || []).filter(h => h.status === 'confirmed' || h.status === 'tracking').slice(0, 2).map(h => ({
      a: h.a, b: h.b, status: h.status, n: h.last_n,
    })),
  };

  let parsed;
  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4.1',
      temperature: 0.55,
      max_tokens: 600,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `${SYSTEM_SAFETY_PREFIX}\n\n${SYSTEM_PROMPT}` },
        { role: 'user',   content: `Write this week's letter. User context (JSON):\n${JSON.stringify(promptInput)}` },
      ],
    });
    parsed = JSON.parse(resp.choices[0].message.content);
    parsed.letter = stripJargon(parsed.letter || '');
    parsed.signoff = parsed.signoff || '— Pulse';
    await bumpCost(deviceId);
  } catch (e) {
    console.warn('[coach-letter]', e.message);
    return cached?.payload || null;
  }

  await letterDoc(deviceId).set({
    week,
    payload: parsed,
    generated_at: admin.firestore.FieldValue.serverTimestamp(),
  });
  return parsed;
}

module.exports = { getOrGenerateLetter };
