'use strict';
/**
 * vision-router.js — shared two-tier vision pipeline
 *
 * SINGLE SOURCE OF TRUTH for any image → structured-JSON task in the app
 * (nutrition meal photos, nutrition labels, water-drink photos, future
 * vision flows). All callers MUST go through this router so model choice,
 * decoding params, and JSON-mode stay identical across agents.
 *
 * MODEL POLICY (research-backed, May 2026):
 *   PRIMARY  = GPT-4o          (CAMERA_MODEL_PRIMARY)
 *   FALLBACK = Gemini 2.5 Pro  (CAMERA_MODEL_FALLBACK)
 *
 * Why GPT-4o is primary:
 *   • January AI 2025 benchmark (arxiv 2508.09966) — 1,000 real food
 *     images, wMAPE: GPT-4o 23.5% vs Gemini 2.5 Pro 28.5%. ~5pp better.
 *   • PMC12513282 (n=52 standardized photos) — GPT-4o 35.8% MAPE on
 *     calories vs Gemini 1.5 Pro 64.2%. Gemini was substantially worse.
 *   • For nutrition-label OCR: GPT-5/4o has the lowest edit distance on
 *     OmniDocBench among general LLMs.
 *
 * Why Gemini 2.5 Pro is the fallback (not dropped entirely):
 *   • Native JSON-schema enforcement is the strongest available — when
 *     OpenAI's JSON-mode drifts, Gemini's schema enforcement saves us.
 *   • Independent provider — survives OpenAI outages.
 *   • topK=1 + responseSchema gives byte-identical JSON for the same
 *     image, useful when accuracy ties.
 *
 * Decoding lock for the Gemini path (max determinism):
 *   temperature: 0   — no sampling
 *   topP:        0.1 — nucleus collapsed to the top sliver
 *   topK:        1   — pure greedy (only the single most-likely next token)
 *   responseMimeType: 'application/json' — JSON-mode
 *   responseSchema:  caller-provided (recommended for every call)
 *
 * Path:
 *   1. Caller invokes OpenAI GPT-4o (their existing wired call).
 *   2. If that returns null/empty/unparseable → caller invokes
 *      callGeminiVision() as the fallback.
 *
 * The router never throws — it returns null on any failure so callers
 * can degrade gracefully. No silent retries.
 */

const crypto = require('crypto');
const { AI } = require('./ai/models');

// ─── Canonical model names ───────────────────────────────────────
// Every photo-detection caller MUST use these constants, not hard-coded
// strings. Change here once → propagates everywhere. Model identity is
// owned by lib/ai/models.js — this file just consumes the named scenarios.
//
// 2026-05-16 model policy refresh (Gemini 3.1 / GPT-5.4 era):
//   PRIMARY  = Gemini 3 Flash  (AI.VISION_PRIMARY)
//     • Frontier-class multimodal vision at Flash pricing
//     • Native JSON-schema enforcement (most reliable for structured output)
//     • topK=1 + responseSchema gives byte-identical JSON for same image
//   DEEP     = Gemini 3.1 Pro  (AI.VISION_DEEP)
//     • Used only when accuracy gates fail (complex meal layouts, OCR)
//
// Why we ditched the previous "GPT-4o primary, Gemini fallback" stance:
// the cited 2025 nutrition benchmarks measured GPT-4o vs Gemini 2.5 Pro.
// Gemini 3 Flash is a generational jump on vision; the gap that justified
// GPT-4o primary closed.
const CAMERA_MODEL_PRIMARY  = AI.VISION_PRIMARY;
const CAMERA_MODEL_FALLBACK = AI.VISION_DEEP;
const VISION_MODEL_PRIMARY  = AI.VISION_PRIMARY;

let _gemini = null;
function getGemini() {
  if (_gemini) return _gemini;
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    const { GoogleGenAI } = require('@google/genai');
    _gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    return _gemini;
  } catch (e) {
    log.warn('[vision-router] @google/genai unavailable:', e?.message);
    return null;
  }
}

function isGeminiAvailable() {
  return !!getGemini();
}

/**
 * Run a vision call. Returns parsed JSON on success, null on any failure.
 *
 * @param {Object} opts
 * @param {string} opts.systemPrompt   — instructions / rules / anchors
 * @param {string} opts.userText       — short per-call context (NOT the system rules)
 * @param {string[]} opts.images       — array of base64 JPEG strings
 * @param {Object} [opts.responseSchema] — Gemini JSON schema (STRONGLY recommended — locks output shape)
 * @param {number} [opts.maxOutputTokens=600]
 * @param {string} [opts.model=VISION_MODEL_PRIMARY] — defaults to canonical 'gemini-2.5-pro'
 * @param {string} [opts.label='vision'] — for logs
 */
async function callGeminiVision(opts) {
  const ai = getGemini();
  if (!ai) return null;
  const {
    systemPrompt,
    userText = '',
    images = [],
    responseSchema = null,
    maxOutputTokens = 600,
    model = VISION_MODEL_PRIMARY,
    label = 'vision',
    allowTextOnly = false,  // 2026-05-22: voice/text callers (e.g. /describe
                            // fallback) need to use Gemini WITHOUT an image.
                            // Without this flag the function used to early-
                            // return null on empty images[], silently breaking
                            // every text-only fallback. Default false keeps
                            // the original camera-only guard for vision routes.
  } = opts;

  if (!images.length && !allowTextOnly) {
    log.warn(`[vision-router/${label}] no images supplied`);
    return null;
  }

  const t0 = Date.now();
  try {
    const parts = [
      ...images.map(b64 => ({ inlineData: { mimeType: 'image/jpeg', data: b64 } })),
      { text: `${systemPrompt}\n\n${userText}`.trim() },
    ];

    // Decoding lock — same params for every photo call across the app.
    // temperature 0 + topP 0.1 + topK 1 = pure greedy decoding. The model
    // emits the single most-likely next token at every step, so identical
    // (image, prompt, schema) inputs return byte-identical JSON output.
    const config = {
      temperature: 0,
      topP: 0.1,
      topK: 1,
      maxOutputTokens,
      responseMimeType: 'application/json',
    };
    if (responseSchema) config.responseSchema = responseSchema;

    const result = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts }],
      config,
    });

    // The new SDK exposes `result.text`; older versions used `response.text()`.
    const raw = (result?.text
      ?? (typeof result?.response?.text === 'function' ? result.response.text() : null)
      ?? '').trim();

    if (!raw) {
      log.warn(`[vision-router/${label}] empty response after ${Date.now() - t0}ms`);
      return null;
    }

    const parsed = JSON.parse(raw);
    return parsed;
  } catch (e) {
    log.warn(`[vision-router/${label}] gemini failed (${Date.now() - t0}ms): ${e?.message}`);
    return null;
  }
}

// ─── Image-hash cache helpers (callers wire their own Map) ───────────
function hashImages(salt, images) {
  const h = crypto.createHash('sha1');
  if (salt) h.update(String(salt));
  for (const b of images) h.update(b);
  return h.digest('hex');
}

module.exports = {
  CAMERA_MODEL_PRIMARY,
  CAMERA_MODEL_FALLBACK,
  VISION_MODEL_PRIMARY, // back-compat alias → Gemini
  getGemini,
  isGeminiAvailable,
  callGeminiVision,
  hashImages,
};
