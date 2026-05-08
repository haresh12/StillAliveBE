/**
 * llm-provider.js
 * Abstract interface. Routes to gemini.js or claude.js implementations.
 * One file change to swap vendors.
 */

const gemini = require('./gemini');
const openai = require('./openai');
const { withRetry } = require('./retry');
const telemetry = require('./telemetry');
const config = require('../config');

const PROVIDERS = { gemini, openai };

/**
 * @param {Object} args
 * @param {string} args.role - 'planner'|'executor'|'validator'
 * @param {string} args.systemPrompt
 * @param {string} args.userPrompt
 * @param {Object} [args.responseSchema] - JSON schema for structured output
 * @param {string} [args.cacheKey] - opaque cache key for the stable prefix
 * @param {string} [args.cachedContent] - the stable prefix to cache (Gemini only for now)
 * @param {Function} [args.providerOverride] - test injection
 * @returns {Promise<{ content: any, usage: { input_tokens, output_tokens, cached_tokens, cost_usd, latency_ms } }>}
 */
async function callLLM(args) {
  const cfg = config.LLM[args.role.toUpperCase()];
  if (!cfg) throw new Error(`Unknown LLM role: ${args.role}`);
  const provider = args.providerOverride || PROVIDERS[cfg.provider];
  if (!provider) throw new Error(`Unknown provider: ${cfg.provider}`);

  const start = Date.now();
  const result = await withRetry(() =>
    provider.complete({
      model: cfg.model,
      systemPrompt: args.systemPrompt,
      userPrompt: args.userPrompt,
      maxCompletionTokens: cfg.max_completion_tokens,
      timeoutMs: cfg.timeout_ms,
      responseSchema: args.responseSchema,
      cacheKey: args.cacheKey,
      cachedContent: args.cachedContent,
    }),
  );
  const latency_ms = Date.now() - start;

  const usage = {
    ...result.usage,
    latency_ms,
  };

  telemetry.record({
    role: args.role,
    provider: cfg.provider,
    model: cfg.model,
    ...usage,
  });

  return { content: result.content, usage };
}

module.exports = { callLLM };
