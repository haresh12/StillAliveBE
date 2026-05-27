'use strict';
// ════════════════════════════════════════════════════════════════════════
// ai.js — the ONLY surface for LLM calls in the Plans agent.
//
// Why this file exists:
//   v1's goal-plans agent fell straight from OpenAI failure to a
//   hardcoded "lighter day every 7 days" template. Users complained the
//   backend was broken — it wasn't, it just lacked a retry layer.
//
//   This file gives every step the same 2-layer fallback that the
//   fitness agent uses (and which has been the reason fitness "just
//   works" while plans didn't):
//
//      Layer 1 (primary):  OpenAI w/ json_object output
//      Layer 2 (fallback): Gemini w/ responseSchema
//      Layer 3 (honest):   throw LLMUnavailableError → BE returns 503
//
//   On a validation failure within a layer, that layer retries ONCE
//   before escalating. Honest > fake.
//
//   No hardcoded fallback templates anywhere. If both layers fail, the
//   caller surfaces a real retry to the user.
// ════════════════════════════════════════════════════════════════════════

const OpenAI = require('openai');
const log = require('../log');
const geminiClient = require('../../wellness-cross-v2/llm/gemini');
const { tryValidate, PlanSchemaError } = require('./validate');
const { appendLanguageInstruction, normalizeLanguage } = require('../i18n-prompt');

const DEFAULT_TIMEOUT_MS = 30_000;

class LLMUnavailableError extends Error {
  constructor(stepName, layer1Err, layer2Err) {
    super(`LLM unavailable for step "${stepName}" (L1: ${layer1Err?.message || 'unknown'}, L2: ${layer2Err?.message || 'unknown'})`);
    this.name = 'LLMUnavailableError';
    this.stepName = stepName;
    this.layer1Err = layer1Err;
    this.layer2Err = layer2Err;
  }
}

// ─── OpenAI client (lazy singleton) ─────────────────────────────────────
let _openaiClient = null;
function _getOpenAI() {
  if (_openaiClient) return _openaiClient;
  if (!process.env.OPENAI_API_KEY) return null;
  _openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openaiClient;
}

// Test-only: override the OpenAI client and the Gemini complete fn.
let _openaiOverride = null;
let _geminiOverride = null;
function __setTestOverrides({ openai, gemini } = {}) {
  _openaiOverride = openai || null;
  _geminiOverride = gemini || null;
}

// ─── JSON repair ────────────────────────────────────────────────────────
// LLMs sometimes wrap JSON in ```json fences or add prose before/after.
// We try three repairs in order; if all fail, the parse error propagates
// and triggers the in-layer retry.
function repairJson(raw) {
  if (typeof raw !== 'string') throw new Error('repairJson: non-string input');
  let s = raw.trim();

  // 1) strip ```json or ``` fences
  const fenceMatch = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) s = fenceMatch[1].trim();

  // 2) extract first balanced {...} block (handles prose-before-JSON)
  const firstBrace = s.indexOf('{');
  const firstBracket = s.indexOf('[');
  if (firstBrace > 0 || firstBracket > 0) {
    const start = firstBrace === -1
      ? firstBracket
      : firstBracket === -1
        ? firstBrace
        : Math.min(firstBrace, firstBracket);
    if (start > 0) s = s.slice(start);
  }

  // 3) strip trailing prose after the last closing brace/bracket
  const lastBrace   = s.lastIndexOf('}');
  const lastBracket = s.lastIndexOf(']');
  const end = Math.max(lastBrace, lastBracket);
  if (end >= 0 && end < s.length - 1) s = s.slice(0, end + 1);

  return s;
}

function _parseLLMJson(raw) {
  try { return JSON.parse(raw); }
  catch {
    const repaired = repairJson(raw);
    return JSON.parse(repaired); // throws if still broken; caller catches
  }
}

// ─── Prompt augmentation ────────────────────────────────────────────────
// Both providers benefit from having the schema described in the system
// prompt — Gemini will treat responseSchema as authoritative anyway, but
// OpenAI in json_object mode only has the prompt to go on. We append a
// concise schema description.
function _systemPromptWithSchema(systemPrompt, schema, stepName) {
  return `${systemPrompt.trim()}

You must respond with valid JSON ONLY (no prose, no markdown fences). The JSON must match this schema for "${stepName}":

${JSON.stringify(schema)}`;
}

// ─── Timeout wrapper ────────────────────────────────────────────────────
function _withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label || 'op'} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

// ─── Layer 1: OpenAI ────────────────────────────────────────────────────
async function _callOpenAI({ model, max_completion_tokens, systemPrompt, userPrompt, schema, stepName, timeoutMs, language }) {
  const client = _openaiOverride || _getOpenAI();
  if (!client) throw new Error('OPENAI_API_KEY not configured');

  // Wrap with language directive BEFORE schema augmentation so the directive
  // sits at the prompt-tail (cache-friendly): the bulk of the system prompt
  // — which is locale-independent — stays bytewise identical across users.
  const localizedSystem = appendLanguageInstruction(systemPrompt, normalizeLanguage(language));
  const augmentedSystem = _systemPromptWithSchema(localizedSystem, schema, stepName);

  // Only include max_completion_tokens when the caller explicitly set one.
  // Otherwise let the model use its default; the JSON schema + timeout are
  // the real guardrails against runaway output.
  const body = {
    model,
    messages: [
      { role: 'system', content: augmentedSystem },
      { role: 'user',   content: userPrompt },
    ],
    response_format: { type: 'json_object' },
  };
  if (max_completion_tokens && Number.isFinite(max_completion_tokens) && max_completion_tokens > 0) {
    body.max_completion_tokens = max_completion_tokens;
  }
  const completion = await _withTimeout(
    client.chat.completions.create(body),
    timeoutMs || DEFAULT_TIMEOUT_MS,
    `openai/${stepName}`,
  );

  const raw = completion?.choices?.[0]?.message?.content || '';
  if (!raw) throw new Error('openai: empty completion');
  return _parseLLMJson(raw);
}

// ─── Layer 2: Gemini ────────────────────────────────────────────────────
async function _callGemini({ model, maxCompletionTokens, systemPrompt, userPrompt, schema, stepName, timeoutMs, language }) {
  const fn = _geminiOverride || geminiClient.complete;
  const localizedSystem = appendLanguageInstruction(systemPrompt, normalizeLanguage(language));
  const result = await fn({
    model,
    systemPrompt: localizedSystem,
    userPrompt,
    maxCompletionTokens,
    timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
    responseSchema: schema,
  });

  // Gemini client returns { content } already JSON.parsed when responseSchema is given.
  // But we defensively re-parse if a string slipped through.
  let parsed = result?.content;
  if (typeof parsed === 'string') parsed = _parseLLMJson(parsed);
  if (!parsed) throw new Error('gemini: empty content');
  return parsed;
}

// ─── Public: runWithFallback ────────────────────────────────────────────
/**
 * Run an AI step with OpenAI → Gemini → 503 fallback.
 *
 * On parse-fail OR validation-fail within a layer, that layer retries
 * once before escalating to the next layer. If both layers exhaust
 * their retries, LLMUnavailableError is thrown — caller should return
 * 503 LLM_UNAVAILABLE to the user with a retry CTA (NEVER a fake plan).
 *
 * @param {object} opts
 * @param {string} opts.stepName            telemetry label
 * @param {object} opts.schema              JSON schema (from schemas.js)
 * @param {string} opts.systemPrompt
 * @param {string} opts.userPrompt
 * @param {object} opts.openai              { model, max_completion_tokens, timeoutMs? }
 * @param {object} opts.gemini              { model, maxCompletionTokens, timeoutMs? }
 * @param {object} [opts.telemetry]         { track(eventName, props) }
 * @returns {Promise<object>}               validated parsed object
 * @throws  {LLMUnavailableError}           when both layers fail
 */
// Is the Gemini layer wired up? When GEMINI_API_KEY is missing, we skip
// L2 entirely instead of burning two retries on the same env error — and
// we hand L1 an extra attempt to compensate. Same null-guard pattern as
// `lib/vision-router.js:72`.
function _geminiConfigured() {
  if (_geminiOverride) return true;
  return !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
}

async function runWithFallback(opts) {
  const { stepName, schema, systemPrompt, userPrompt, openai, gemini, telemetry, language } = opts;
  if (!stepName || !schema) throw new Error('runWithFallback: stepName and schema required');

  const track = (ev, props) => {
    try { telemetry?.track?.(ev, { step: stepName, ...(props || {}) }); } catch {}
  };

  // L1 gets 2 attempts max regardless of L2 availability. The previous
  // "3 attempts when no L2" rule compounded timeouts catastrophically:
  // a slow ~50s call would burn 3 × 50s = 150s before failing. With a
  // generous per-attempt timeout, one retry is the right safety net —
  // more retries just compound bad luck.
  const l2Available  = _geminiConfigured();
  const l1MaxAttempts = 2;

  // ── Layer 1: OpenAI, with retries on parse/validate fail.
  let layer1Err = null;
  for (let attempt = 0; attempt < l1MaxAttempts; attempt++) {
    try {
      track(attempt === 0 ? 'GOAL_PLAN_LLM_L1_START' : 'GOAL_PLAN_LLM_L1_RETRY');
      const parsed = await _callOpenAI({ ...openai, systemPrompt, userPrompt, schema, stepName, language });
      const v = tryValidate(parsed, schema);
      if (!v.ok) throw v.error;
      track('GOAL_PLAN_LLM_L1_OK', { attempt });
      return v.value;
    } catch (e) {
      layer1Err = e;
      log.warn(`[goal-plans/ai] L1 attempt ${attempt + 1} fail for ${stepName}:`, e?.message);
    }
  }
  track('GOAL_PLAN_LLM_L1_FAIL', { error: (layer1Err?.message || '').slice(0, 200) });

  // ── Layer 2: Gemini — only attempted when key is present.
  let layer2Err = null;
  if (l2Available) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        track(attempt === 0 ? 'GOAL_PLAN_LLM_L2_START' : 'GOAL_PLAN_LLM_L2_RETRY');
        const parsed = await _callGemini({ ...gemini, systemPrompt, userPrompt, schema, stepName, language });
        const v = tryValidate(parsed, schema);
        if (!v.ok) throw v.error;
        track('GOAL_PLAN_LLM_L2_OK', { attempt });
        return v.value;
      } catch (e) {
        layer2Err = e;
        log.warn(`[goal-plans/ai] L2 attempt ${attempt + 1} fail for ${stepName}:`, e?.message);
      }
    }
    track('GOAL_PLAN_LLM_L2_FAIL', { error: (layer2Err?.message || '').slice(0, 200) });
  } else {
    track('GOAL_PLAN_LLM_L2_SKIPPED', { reason: 'no_gemini_key' });
  }

  // ── Layer 3: honest 503.
  track('GOAL_PLAN_LLM_BOTH_FAIL');
  throw new LLMUnavailableError(stepName, layer1Err, layer2Err);
}

module.exports = {
  runWithFallback,
  LLMUnavailableError,
  // Test surface — never call from production code.
  __setTestOverrides,
  __repairJson: repairJson,
};
