'use strict';
/**
 * analytics-helper.js — single helper every per-coach analytics module calls
 * to enrich its LLM prompts with the user's HealthKit signals.
 *
 * Usage inside any analytics module (sleep-analytics, mind-analytics, etc.):
 *
 *   const { withHKEnrichment, HK_PROMPT_RULE } = require('./healthkit/analytics-helper');
 *
 *   // 1. Add HK_PROMPT_RULE to your system prompt (one line, cached-friendly)
 *   const SYSTEM = `...your existing prompt...\n\n${HK_PROMPT_RULE}`;
 *
 *   // 2. Wrap your existing payload before sending to the LLM
 *   const userMessage = await withHKEnrichment({ deviceId, coach: 'sleep', payload: statsPayload });
 *
 * Output of `withHKEnrichment` is a JSON string with your original payload
 * + a `healthkit` field (only when HK data exists). The system prompt rule
 * tells the LLM to cite those values verbatim and never invent.
 *
 * Cache-friendly: if HK is empty, the output is identical to a plain
 * JSON.stringify of the payload (existing hash-based caches continue to hit).
 */

const { buildHKContext } = require('./context-builder');

const HK_PROMPT_RULE =
  'If the payload contains a `healthkit` field, those are objective signals for this user (factual — treat as their own data). Cite the numbers verbatim ("your 4.0h asleep last night", "HRV 18% below baseline"). NEVER name the data source ("Apple Health", "your watch", "wearable", "device") — speak as if they\'re simply the user\'s data. NEVER invent HK numbers. If the field is absent, do not reference HK at all.';

/**
 * Build the user-message JSON for an analytics LLM call, enriched with HK
 * context when available. Returns a string ready to pass as `role: 'user'`.
 */
async function withHKEnrichment({ deviceId, coach, payload, days = 7, admin }) {
  let healthkit = null;
  try {
    const fb = admin || require('firebase-admin');
    const hkBlock = await buildHKContext({
      db: fb.firestore(),
      deviceId,
      coach,
      days,
    });
    if (hkBlock && hkBlock.trim()) {
      healthkit = hkBlock.replace(/^\[HK\]\s*/, '');
    }
  } catch { /* best-effort — analytics never blocks on HK */ }

  const enriched = healthkit
    ? { ...(payload || {}), healthkit }
    : (payload || {});
  return JSON.stringify(enriched);
}

/**
 * Cache-key contribution from HK — append to your existing hash input so
 * the cache invalidates when the HK rollup changes meaningfully. Pass
 * the same `coach` + `deviceId` and we'll add a deterministic hint.
 */
async function hkCacheToken({ deviceId, coach, days = 7, admin }) {
  try {
    const fb = admin || require('firebase-admin');
    const hkBlock = await buildHKContext({
      db: fb.firestore(),
      deviceId,
      coach,
      days,
    });
    return (hkBlock || '').trim();
  } catch {
    return '';
  }
}

/**
 * Cross-coach variant — for weekly / monthly reports and cross-agent DYK
 * where the LLM is reasoning over multiple coaches at once. Returns a
 * stringified payload with `healthkit: { sleep: "...", mind: "...", ... }`
 * keyed by coach (only coaches with data appear; if NO coach has HK data
 * the `healthkit` field is omitted entirely so caches still hit).
 */
async function withHKEnrichmentCrossCoach({ deviceId, payload, coaches, days = 7, admin }) {
  const out = {};
  try {
    const fb = admin || require('firebase-admin');
    const db = fb.firestore();
    const wanted = Array.isArray(coaches) && coaches.length
      ? coaches
      : ['sleep', 'mind', 'nutrition', 'fitness', 'water', 'fasting'];
    const blocks = await Promise.all(
      wanted.map(async (c) => {
        try {
          const b = await buildHKContext({ db, deviceId, coach: c, days });
          return [c, b ? b.replace(/^\[HK\]\s*/, '').trim() : ''];
        } catch { return [c, '']; }
      }),
    );
    for (const [c, b] of blocks) if (b) out[c] = b;
  } catch { /* best-effort */ }

  const enriched = Object.keys(out).length
    ? { ...(payload || {}), healthkit: out }
    : (payload || {});
  return JSON.stringify(enriched);
}

module.exports = {
  HK_PROMPT_RULE,
  withHKEnrichment,
  withHKEnrichmentCrossCoach,
  hkCacheToken,
};
