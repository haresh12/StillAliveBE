/**
 * gemini.js
 * Wraps @google/genai SDK for Pro + Flash with response_schema + context caching.
 *
 * Pricing (2026-05): Gemini 2.5 Pro $1.25/$10 per Mtok, Flash $0.30/$2.50 per Mtok.
 */

const { GoogleGenAI } = require('@google/genai');

const PRICING = {
  'gemini-2.5-pro':   { input: 1.25 / 1e6, output: 10.00 / 1e6, cached: 0.31 / 1e6 },
  'gemini-2.5-flash': { input: 0.30 / 1e6, output: 2.50 / 1e6, cached: 0.075 / 1e6 },
};

let _client = null;
function client() {
  if (_client) return _client;
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY env var missing');
  _client = new GoogleGenAI({ apiKey });
  return _client;
}

async function complete({
  model,
  systemPrompt,
  userPrompt,
  maxCompletionTokens,
  timeoutMs,
  responseSchema,
  cachedContent,
}) {
  const c = client();

  const reqConfig = {
    systemInstruction: systemPrompt,
    maxOutputTokens: maxCompletionTokens,
  };
  if (responseSchema) {
    reqConfig.responseMimeType = 'application/json';
    reqConfig.responseSchema = responseSchema;
  }
  if (cachedContent) {
    reqConfig.cachedContent = cachedContent;
  }

  const result = await withTimeout(
    c.models.generateContent({
      model,
      contents: userPrompt,
      config: reqConfig,
    }),
    timeoutMs,
  );

  const text = result.text || '';
  let content = text;
  if (responseSchema) {
    try {
      content = JSON.parse(text);
    } catch (e) {
      throw new Error(`gemini: failed to parse JSON response: ${text.slice(0, 200)}`);
    }
  }

  const um = result.usageMetadata || {};
  const input_tokens = um.promptTokenCount || 0;
  const cached_tokens = um.cachedContentTokenCount || 0;
  const output_tokens = um.candidatesTokenCount || 0;

  const price = PRICING[model] || PRICING['gemini-2.5-pro'];
  const cost_usd =
    (input_tokens - cached_tokens) * price.input +
    cached_tokens * price.cached +
    output_tokens * price.output;

  return {
    content,
    usage: {
      input_tokens,
      output_tokens,
      cached_tokens,
      cost_usd: Math.round(cost_usd * 1e6) / 1e6,
    },
  };
}

function withTimeout(promise, ms) {
  if (!ms) return promise;
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`gemini timeout ${ms}ms`)), ms)),
  ]);
}

module.exports = { complete };
