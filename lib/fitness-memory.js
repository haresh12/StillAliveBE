"use strict";
// ================================================================
// FITNESS MEMORY — native semantic long-term memory (mem0-style, on our own stack).
//
// Durable facts about the user (injuries, goals, day-of-week routines, PRs, preferences) are
// extracted by an LLM, embedded (OpenAI text-embedding-3-small), and stored in Firestore. Each
// coach turn retrieves the most relevant memories by cosine similarity and injects them, so the
// coach speaks like it's known the user for years — and the proactive engine personalises off it.
//
// Private (data stays in our Firebase), no vector-DB infra, low latency:
//   • retrieve = ONE embed call (parallel with the doc fetch) — on the hot path.
//   • add      = runs AFTER the reply (fire-and-forget) so it never slows a response.
//
// bc-namespaced: wellness_bc_users/{id}/agents/fitness/fitness_memory.
// ================================================================
const admin = require("firebase-admin");
const { OpenAI } = require("openai");
const { userDoc } = require("./collections");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const fitnessDoc = (id) => userDoc(id).collection("agents").doc("fitness");
const memCol = (id) => fitnessDoc(id).collection("fitness_memory");
const ts = () => admin.firestore.FieldValue.serverTimestamp();

const EMBED_MODEL = "text-embedding-3-small";
const KINDS = ["injury", "goal", "routine", "pr", "preference", "fact"];
const MAX_MEMORIES = 300; // soft cap on how many we scan per turn

async function embed(text) {
  const r = await openai.embeddings.create({ model: EMBED_MODEL, input: String(text || "").slice(0, 2000) });
  return r.data[0].embedding;
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function extractJson(s) {
  if (!s) return "{}";
  const t = String(s).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  return a >= 0 && b > a ? t.slice(a, b + 1) : t;
}

// Extract durable facts from recent turns → embed → store (semantic-deduped). Fire-and-forget.
async function addMemories(deviceId, turns) {
  try {
    const convo = (turns || [])
      .map((t) => `${t.role === "user" ? "User" : "Coach"}: ${String(t.content || "").slice(0, 600)}`)
      .join("\n")
      .slice(0, 3000);
    if (!convo.trim()) return;

    const res = await openai.chat.completions.create({
      model: "gpt-5.4-mini",
      max_completion_tokens: 300,
      messages: [
        {
          role: "system",
          content:
            'Extract DURABLE facts about the user worth remembering long-term for a fitness coach: injuries, goals, routines (day-of-week habits), notable PRs, equipment, preferences, constraints, relevant life context. Return STRICT JSON {"memories":[{"text":string,"kind":"injury|goal|routine|pr|preference|fact"}]}. ONLY stable facts — never one-off set numbers, transient mood, or pleasantries. Empty array if nothing durable. Each text = a short third-person statement, e.g. "Has a left knee niggle; avoid deep squats." or "Trains chest every Monday."',
        },
        { role: "user", content: convo },
      ],
    });

    let parsed;
    try { parsed = JSON.parse(extractJson(res.choices[0].message.content)); } catch (_) { return; }
    const memories = Array.isArray(parsed?.memories) ? parsed.memories.slice(0, 6) : [];
    if (!memories.length) return;

    const existing = await memCol(deviceId).limit(MAX_MEMORIES).get();
    const existingEmb = existing.docs.map((d) => d.data().embedding).filter(Array.isArray);

    for (const m of memories) {
      const text = String(m?.text || "").trim();
      if (text.length < 4) continue;
      const kind = KINDS.includes(m?.kind) ? m.kind : "fact";
      const v = await embed(text);
      // semantic dedupe — skip if we already know essentially the same thing
      if (existingEmb.some((e) => cosine(v, e) > 0.92)) continue;
      await memCol(deviceId).add({ text, kind, embedding: v, created_at: ts() });
      existingEmb.push(v);
    }
  } catch (e) {
    (globalThis.log?.error || console.error)("[fitness-memory] add:", e?.message || e);
  }
}

// Retrieve the top-k most relevant memories for a query. One embed call, parallel with the fetch.
async function retrieveMemories(deviceId, query, k = 6) {
  try {
    const [snap, qv] = await Promise.all([
      memCol(deviceId).limit(MAX_MEMORIES).get(),
      embed(query),
    ]);
    if (snap.empty) return [];
    const scored = snap.docs
      .map((d) => { const m = d.data(); return { text: m.text, kind: m.kind, score: cosine(qv, m.embedding) }; })
      .filter((s) => s.text && s.score > 0.15);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k).map((s) => s.text);
  } catch (e) {
    (globalThis.log?.error || console.error)("[fitness-memory] retrieve:", e?.message || e);
    return [];
  }
}

module.exports = { addMemories, retrieveMemories };
