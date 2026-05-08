/**
 * validator.js
 * Step 4: Chain-of-Verification on every numeric claim from the Executor.
 * Fast deterministic check first; falls back to OpenAI (gpt-5.4-nano) if ambiguous —
 * intentional provider diversity from the Gemini executor for independent verification.
 */

const { callLLM } = require('../llm/llm-provider');
const { VALIDATOR_SYSTEM, VALIDATOR_SCHEMA } = require('./prompts');

const NUMERIC_RE = /-?\d+(?:\.\d+)?/g;

function extractNumerics(text) {
  if (!text || typeof text !== 'string') return [];
  return [...text.matchAll(NUMERIC_RE)].map((m) => parseFloat(m[0]));
}

function flatNumericsFromSource(source) {
  const out = new Set();
  const walk = (val) => {
    if (val == null) return;
    if (typeof val === 'number' && Number.isFinite(val)) {
      out.add(round(val));
      out.add(Math.round(val));
      out.add(Math.round(Math.abs(val)));
    } else if (Array.isArray(val)) {
      val.forEach(walk);
    } else if (typeof val === 'object') {
      Object.values(val).forEach(walk);
    }
  };
  walk(source);
  return out;
}

function round(n) {
  return Math.round(n * 10) / 10;
}

function deterministicCheck(claim, sourceNumerics) {
  const nums = extractNumerics(claim);
  if (!nums.length) return { ok: true, reason: 'no_numerics' };
  for (const n of nums) {
    const candidates = [round(n), Math.round(n), Math.round(Math.abs(n)), n];
    const found = candidates.some((c) => sourceNumerics.has(c) || sourceNumerics.has(round(c)));
    if (!found) {
      return { ok: false, reason: `numeric ${n} not in source` };
    }
  }
  return { ok: true };
}

/**
 * Validate a list of text claims against a source data object.
 * Each claim is { id, text }. Returns { ok, rewrites: { id → null|<dropped>}, results }.
 */
async function validateClaims({ claims, source, useLLMFallback = true }) {
  const sourceNumerics = flatNumericsFromSource(source);
  const results = [];

  const ambiguous = [];
  for (const claim of claims) {
    const det = deterministicCheck(claim.text, sourceNumerics);
    if (det.ok) {
      results.push({ claim_id: claim.id, ok: true });
    } else {
      ambiguous.push(claim);
      results.push({ claim_id: claim.id, ok: false, reason: det.reason, _pending_llm: useLLMFallback });
    }
  }

  // Optional LLM second-look (only on those flagged failed)
  if (useLLMFallback && ambiguous.length > 0 && process.env.OPENAI_API_KEY) {
    try {
      const { content } = await callLLM({
        role: 'validator',
        systemPrompt: VALIDATOR_SYSTEM,
        userPrompt: JSON.stringify({
          source_numerics: [...sourceNumerics].slice(0, 200),
          claims: ambiguous.map((c) => ({ id: c.id, text: c.text })),
        }),
        responseSchema: VALIDATOR_SCHEMA,
      });
      const map = new Map(content.results.map((r) => [String(r.claim_id), r]));
      for (const r of results) {
        if (r._pending_llm) {
          const second = map.get(String(r.claim_id));
          if (second && second.ok) {
            r.ok = true;
            delete r.reason;
          }
          delete r._pending_llm;
        }
      }
    } catch (err) {
      console.error('[validator] LLM second-look failed:', err && err.message);
      for (const r of results) delete r._pending_llm;
    }
  }

  const ok = results.every((r) => r.ok);
  return { ok, results };
}

module.exports = { validateClaims, extractNumerics, flatNumericsFromSource };
