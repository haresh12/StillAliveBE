'use strict';
/**
 * vision-router.js — shared Gemini-first vision pipeline
 *
 * Gemini 2.5 Pro is the primary model for image → structured-JSON tasks
 * (food / drink identification). It's significantly more deterministic
 * than gpt-* at temperature 0 with response schemas, and stays consistent
 * across re-shoots of the same scene — which is the bug Water was hitting.
 *
 * Path:
 *   1. If GEMINI_API_KEY set → call Gemini 2.5 Pro with temperature 0,
 *      topP 0.1, JSON-mode + optional schema. Return parsed JSON.
 *   2. Otherwise (or on error) → caller's OpenAI fallback handles it.
 *
 * The router never throws — it returns null on any failure so callers
 * can degrade to their existing OpenAI codepath.
 */

const crypto = require('crypto');

let _gemini = null;
function getGemini() {
  if (_gemini) return _gemini;
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    const { GoogleGenAI } = require('@google/genai');
    _gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    return _gemini;
  } catch (e) {
    console.warn('[vision-router] @google/genai unavailable:', e?.message);
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
 * @param {Object} [opts.responseSchema] — optional Gemini JSON schema (recommended)
 * @param {number} [opts.maxOutputTokens=600]
 * @param {string} [opts.model='gemini-2.5-pro']
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
    model = 'gemini-2.5-pro',
    label = 'vision',
  } = opts;

  if (!images.length) {
    console.warn(`[vision-router/${label}] no images supplied`);
    return null;
  }

  const t0 = Date.now();
  try {
    const parts = [
      ...images.map(b64 => ({ inlineData: { mimeType: 'image/jpeg', data: b64 } })),
      { text: `${systemPrompt}\n\n${userText}`.trim() },
    ];

    const config = {
      temperature: 0,
      topP: 0.1,
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
      console.warn(`[vision-router/${label}] empty response after ${Date.now() - t0}ms`);
      return null;
    }

    const parsed = JSON.parse(raw);
    console.log(`[vision-router/${label}] gemini ok ${Date.now() - t0}ms`);
    return parsed;
  } catch (e) {
    console.warn(`[vision-router/${label}] gemini failed (${Date.now() - t0}ms): ${e?.message}`);
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
  getGemini,
  isGeminiAvailable,
  callGeminiVision,
  hashImages,
};
