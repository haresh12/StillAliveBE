'use strict';
// ════════════════════════════════════════════════════════════════════════
// lib/ai/models.js — CANONICAL model registry (the only place model names
// live). Every LLM/vision call site in the codebase MUST import from here.
//
// Why this file exists:
//   When the user emails "switch everything to {new flagship}" we change
//   ONE constant here, not 74 call sites. When OpenAI/Gemini ship a new
//   model, we benchmark + flip one line. Zero divergence between agents.
//
// Scenarios (pick the constant that matches your CALL TYPE, not the
// model name — model names change, scenarios don't):
//
//   AI.REASONING_PRO   Heavy reasoning. Coach letters, weekly briefings,
//                      cross-agent narratives, deep insight cards.
//                      Default: OpenAI gpt-5.4 ($2.50/$15 per 1M).
//
//   AI.REASONING_FAST  Cheap reasoning. JSON validators, classifiers,
//                      micro-summaries, parse-and-extract.
//                      Default: OpenAI gpt-5.4-nano ($0.20/$1.25 per 1M).
//
//   AI.CHAT_STREAM     Streaming Coach tab chat (token-by-token).
//                      Default: OpenAI gpt-5.4-mini ($0.75/$4.50).
//
//   AI.VISION_PRIMARY  Camera capture → structured JSON (food photos,
//                      water bottles, sleep describe images, nutrition
//                      labels). Multimodal frontier model at Flash price.
//                      Default: Gemini gemini-3-flash.
//
//   AI.VISION_DEEP     Vision where errors are expensive (complex
//                      multi-item meal layouts, label OCR). Slow + costly,
//                      use sparingly. Default: gemini-3.1-pro.
//
//   AI.TRANSCRIBE      Audio → text. Default: gpt-4o-transcribe.
//
//   AI.VALIDATOR       Plan-Execute-Validate output checker.
//                      Default: gpt-5.4-nano.
//
// Rules:
//   • NEVER hard-code a model string outside this file.
//   • NEVER use `temperature:` or `max_tokens:` on OpenAI calls — always
//     `max_completion_tokens:`. (Memory: feedback_openai_params.md.)
//   • Env-var override per scenario lets us A/B without a deploy:
//        AI_REASONING_PRO=gpt-5.5  (etc.)
// ════════════════════════════════════════════════════════════════════════

const _override = (envName, fallback) => {
  const v = process.env[envName];
  return v && String(v).trim().length > 0 ? String(v).trim() : fallback;
};

const AI = Object.freeze({
  REASONING_PRO:  _override('AI_REASONING_PRO',  'gpt-5.4'),
  REASONING_FAST: _override('AI_REASONING_FAST', 'gpt-5.4-nano'),
  CHAT_STREAM:    _override('AI_CHAT_STREAM',    'gpt-5.4-mini'),
  VISION_PRIMARY: _override('AI_VISION_PRIMARY', 'gemini-3-flash'),
  VISION_DEEP:    _override('AI_VISION_DEEP',    'gemini-3.1-pro'),
  TRANSCRIBE:     _override('AI_TRANSCRIBE',     'gpt-4o-transcribe'),
  VALIDATOR:      _override('AI_VALIDATOR',      'gpt-5.4-nano'),
});

// Helper: classify a model string as openai vs gemini. Used by callers
// that proxy to the right SDK without each one duplicating this check.
function providerOf(modelName) {
  if (typeof modelName !== 'string') return 'openai';
  return modelName.toLowerCase().startsWith('gemini') ? 'gemini' : 'openai';
}

// Helper: token-cap defaults per scenario. Each call site may override,
// but these are the sane ceilings — keep them tight to control cost.
const DEFAULT_TOKEN_CAPS = Object.freeze({
  REASONING_PRO:  900,
  REASONING_FAST: 360,
  CHAT_STREAM:    700,
  VISION_PRIMARY: 600,
  VISION_DEEP:    900,
  VALIDATOR:      240,
});

module.exports = {
  AI,
  providerOf,
  DEFAULT_TOKEN_CAPS,
};
