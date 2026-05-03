'use strict';

// ─── Model routing — single source of truth ──────────────────────
// FAST:    gpt-4.1-mini — text tasks: chat, voice parse, insights, proactive
// VISION:  gpt-4.1      — any call that includes an image_url content block
//
// Change here once → propagates everywhere.

const MODELS = {
  fast:        'gpt-5.4-nano',   // default: text reasoning, structured outputs (fast + cheap)
  vision:      'gpt-5.4-mini',   // vision: food photos, nutrition labels, chat w/ image
  visionPro:   'gpt-5.4',        // best-in-class vision for /vision/analyze (10.24M-pixel detail, multi-image cross-ref)
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

module.exports = { MODELS, MAX_IMAGE_BYTES, OPENAI_TIMEOUT_MS, safeJSON, assertImageSize };
