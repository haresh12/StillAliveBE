/**
 * openai.js
 * OpenAI Chat Completions wrapper.
 * Used as the numeric Chain-of-Verification validator (provider diversity vs Gemini executor).
 *
 * HARD RULES (per feedback_openai_params.md):
 *   - Always use `max_completion_tokens` (never `max_tokens`).
 *   - Never set `temperature:` — newer models reject it.
 */

const { OpenAI } = require('openai');

// Pricing per 1M tokens (estimates — refined as needed).
// gpt-5.4-nano is the project's "fast" tier per lib/model-router.js.
const PRICING = {
  'gpt-5.4-nano': { input: 0.10 / 1e6, output: 0.40 / 1e6, cached: 0.025 / 1e6 },
  'gpt-4.1-mini': { input: 0.40 / 1e6, output: 1.60 / 1e6, cached: 0.10 / 1e6 },
  'gpt-5-mini':   { input: 0.25 / 1e6, output: 2.00 / 1e6, cached: 0.0625 / 1e6 },
};

let _client = null;
function client() {
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY env var missing');
  _client = new OpenAI({ apiKey });
  return _client;
}

async function complete({
  model,
  systemPrompt,
  userPrompt,
  maxCompletionTokens,
  timeoutMs,
  responseSchema,
}) {
  const c = client();

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const req = {
    model,
    messages,
    max_completion_tokens: maxCompletionTokens || 256,
  };

  if (responseSchema) {
    req.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'response',
        schema: responseSchema,
        strict: false,
      },
    };
  }

  const resp = await withTimeout(c.chat.completions.create(req), timeoutMs);

  const choice = resp.choices && resp.choices[0];
  const text = (choice && choice.message && choice.message.content) || '';

  let content = text;
  if (responseSchema) {
    try {
      content = JSON.parse(text);
    } catch (e) {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try { content = JSON.parse(m[0]); } catch (_) {
          throw new Error(`openai: failed to parse JSON: ${text.slice(0, 200)}`);
        }
      } else {
        throw new Error(`openai: failed to parse JSON: ${text.slice(0, 200)}`);
      }
    }
  }

  const u = resp.usage || {};
  const input_tokens = u.prompt_tokens || 0;
  const cached_tokens = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
  const output_tokens = u.completion_tokens || 0;

  const price = PRICING[model] || PRICING['gpt-5.4-nano'];
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
    new Promise((_, reject) => setTimeout(() => reject(new Error(`openai timeout ${ms}ms`)), ms)),
  ]);
}

module.exports = { complete };
