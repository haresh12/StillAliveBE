'use strict';

// ─── Model routing — single source of truth ──────────────────────
// FAST:           gpt-5.4-nano  — text tasks: chat, voice parse, insights, proactive
// VISION:         gpt-5.4-mini  — legacy chat-with-image (low-stakes vision)
// VISION_PRO:     gpt-5.4       — legacy /vision/analyze fallback shape
// CAMERA_PRIMARY: gpt-4o        — canonical model for ALL photo→JSON flows.
//                                 Backed by January AI 2025 benchmark
//                                 (arxiv 2508.09966): 23.5% wMAPE on real
//                                 food images vs Gemini 2.5 Pro 28.5%.
//                                 Used by nutrition `_multiShotVision`,
//                                 nutrition `scanNutritionLabel`, water
//                                 `/log/from-photo`. Single string here →
//                                 swap once when GPT-5 (or anything better)
//                                 wins a future benchmark.
//
// Change here once → propagates everywhere.

const MODELS = {
  fast:           'gpt-5.4-nano',   // default: text reasoning, structured outputs (fast + cheap)
  vision:         'gpt-5.4-mini',   // legacy: low-stakes chat-with-image
  visionPro:      'gpt-5.4',        // legacy: kept for fallback paths only
  cameraPrimary:  'gpt-4o',         // CANONICAL — every photo→JSON call uses this
};

// Max image payload (bytes) before we reject — prevents OOM & slow vision calls
const MAX_IMAGE_BYTES = 12 * 1024 * 1024; // 12 MB base64 (~9MB raw)

// OpenAI request timeout (ms)
const OPENAI_TIMEOUT_MS = 25_000;

// Safe JSON parser — strips markdown fences, never throws
function safeJSON(raw, fallback = null) {
  try {
    const cleaned = (raw || '').trim()
      .replace(/^```(?:json)?\n?/i, '')
      .replace(/\n?```$/i, '')
      .trim();
    return JSON.parse(cleaned);
  } catch {
    return fallback;
  }
}

// Validate base64 image size before sending to OpenAI
function assertImageSize(base64) {
  const bytes = Buffer.byteLength(base64, 'base64');
  if (bytes > MAX_IMAGE_BYTES) {
    throw Object.assign(new Error('Image too large'), { statusCode: 413 });
  }
}

// ─── openaiStrict — convert Gemini-style schema to OpenAI strict mode ───
// OpenAI's `response_format: { type: 'json_schema', strict: true }` enforces
// shape at the API level, but it requires a stricter JSON-schema dialect
// than Gemini's `responseSchema`:
//   • `nullable: true`        → must become `type: ["string", "null"]`
//   • every object MUST have `additionalProperties: false`
//   • `required` MUST list ALL property keys (no partial-required objects)
//
// This converter walks any schema and produces an OpenAI-strict-compliant
// equivalent so callers can write the schema once (Gemini-style) and get
// shape enforcement on BOTH providers. Pure / non-mutating.
function openaiStrict(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(openaiStrict);

  const out = { ...schema };

  // nullable: true → union with "null"
  if (out.nullable === true && out.type && !Array.isArray(out.type) && out.type !== 'null') {
    out.type = [out.type, 'null'];
  }
  delete out.nullable;

  if (out.type === 'object' || (Array.isArray(out.type) && out.type.includes('object')) || out.properties) {
    if (out.properties) {
      const newProps = {};
      for (const [k, v] of Object.entries(out.properties)) newProps[k] = openaiStrict(v);
      out.properties = newProps;
      // strict mode requires every property to be in `required`
      out.required = Object.keys(newProps);
    }
    out.additionalProperties = false;
  }

  if (out.items) out.items = openaiStrict(out.items);

  return out;
}

module.exports = { MODELS, MAX_IMAGE_BYTES, OPENAI_TIMEOUT_MS, safeJSON, assertImageSize, openaiStrict };
