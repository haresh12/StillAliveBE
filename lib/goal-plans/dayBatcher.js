'use strict';
// ════════════════════════════════════════════════════════════════════════
// dayBatcher.js — parallel 7-day-batch composer (Plans v2, P3).
//
// The single biggest correctness change in v2: every day in a plan is
// independently LLM-generated. NO TILING. A 30-day plan = 30 distinct
// days (5 parallel 7-day batches via runWithFallback).
//
// Streaming contract:
//   generateDayStream() launches all batches in parallel but YIELDS them
//   in strict day-index order. Batch 2 finishing early doesn't ship to
//   the FE before batch 1 — the snake/path would paint nodes out of
//   sequence and look broken. We trade a few hundred ms of latency for
//   a clean UX.
//
//   On ANY batch failure (after both LLM layers exhaust retries), the
//   stream throws. The agent route surfaces this as a single error frame
//   and the plan is NOT persisted. Honest > fake (L9).
// ════════════════════════════════════════════════════════════════════════

const { AI } = require('../ai/models');
const { runWithFallback } = require('./ai');
const { COMPOSE_PLAN_BATCH } = require('./schemas');
const { buildComposePlanBatchPrompt } = require('./prompts');

// Smaller batches generate faster (less output per call) and survive
// retries better. A 30-day plan = 6 batches of 5 days instead of 5×7.
// Wall time = max(batch_time), so smaller batches = faster end-to-end
// when parallel concurrency isn't the bottleneck (it isn't — OpenAI's
// soft per-account concurrency comfortably covers 6-7 parallel calls).
const BATCH_SIZE = 5;
const MAX_PARALLEL = 4; // soft cap; we don't enforce strict concurrency
                        // because batches are I/O-bound on the LLM API
// We don't pass max_completion_tokens — schema (maxItems + "EXACTLY N days"
// instruction) bounds the output, and the timeout catches genuine hangs.
// gpt-4.1 NORMALLY generates a 5-day batch in 15-25s, but tails occasionally
// hit 50-70s (rate-limit queueing, server load, network jitter). 90s is
// sized to ABSORB the tail on the FIRST attempt rather than retry 3× and
// waste 135s. "Reliable beats fast."
const PER_BATCH_TIMEOUT_MS = 90_000;

/**
 * Helper: format YYYY-MM-DD date keys by adding N days to a base date.
 * Pure date math — keeps local-TZ keys aligned with `feedback_chart_tz_clamp`.
 */
function _addDaysKey(dateKey, addDays) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + addDays);
  const y2 = dt.getFullYear();
  const m2 = String(dt.getMonth() + 1).padStart(2, '0');
  const d2 = String(dt.getDate()).padStart(2, '0');
  return `${y2}-${m2}-${d2}`;
}

/**
 * Helper: produce a short continuity summary for the LLM. Lets later
 * batches know what content already exists so they don't repeat.
 * Kept under ~200 tokens — schema_drift prevention.
 */
function _continuitySummary(priorDays) {
  if (!priorDays || priorDays.length === 0) return '(none — this is the first batch)';
  const sampleTitles = priorDays
    .flatMap(d => d.items.slice(0, 2).map(it => it.title))
    .slice(0, 12);
  return `Days ${priorDays[0].day_index}-${priorDays[priorDays.length - 1].day_index} already contain items like: ${sampleTitles.join('; ')}. Do NOT repeat these items in your batch.`;
}

/**
 * Generate one 7-day batch via the 2-layer AI fallback.
 *
 * @internal
 */
async function _generateBatch(opts, batchIndex, priorDays) {
  const {
    duration_days, goal_text, coaches_involved, answers, locale, telemetry,
    daily_anchors_summary, user_context,
  } = opts;
  const batch_start_index = batchIndex * BATCH_SIZE + 1;
  const batch_end_index   = Math.min(batch_start_index + BATCH_SIZE - 1, duration_days);
  const days_in_batch     = batch_end_index - batch_start_index + 1;

  const { systemPrompt, userPrompt } = buildComposePlanBatchPrompt({
    goalText: goal_text,
    coachesInvolved: coaches_involved,
    answers,
    durationDays: duration_days,
    batchStartIndex: batch_start_index,
    batchEndIndex: batch_end_index,
    locale,
    continuitySummary: _continuitySummary(priorDays),
    dailyAnchorsSummary: daily_anchors_summary,
    userContext: user_context,
  });

  // Single call — runWithFallback handles parse/validate retries internally.
  // Wrong-count is rare with gpt-4.1 + strong prompt; if it happens, surface
  // it cleanly rather than retrying (which compounds timeouts on bad days).
  const parsed = await runWithFallback({
    stepName: `composePlanBatch_${batchIndex}`,
    schema: COMPOSE_PLAN_BATCH,
    systemPrompt,
    userPrompt,
    openai: {
      model: AI.STRUCTURED_HEAVY,
      timeoutMs: PER_BATCH_TIMEOUT_MS,
    },
    gemini: {
      model: AI.VISION_PRIMARY,
      timeoutMs: PER_BATCH_TIMEOUT_MS,
    },
    telemetry,
    language: locale,
  });

  const days = Array.isArray(parsed.days) ? parsed.days : [];
  if (days.length !== days_in_batch) {
    throw new Error(`batch ${batchIndex}: expected ${days_in_batch} days, got ${days.length}`);
  }
  // Reassign day_index to be 100% correct regardless of LLM drift.
  return days.map((d, i) => ({ ...d, day_index: batch_start_index + i }));
}

/**
 * Stream day batches. Launches all batches in parallel, yields in order.
 *
 * @yields { type: 'batch', batch_index, days: [...] }
 * @yields { type: 'done' }
 * @throws on first batch failure (after LLM layers exhausted)
 */
async function* generateDayStream(opts) {
  const { duration_days, start_date } = opts;
  // Free-form: any integer in [3, 90]. The clamp upstream guarantees the
  // tier ceiling — this is just a sanity floor/ceiling on the batcher itself.
  if (!Number.isInteger(duration_days) || duration_days < 3 || duration_days > 90) {
    throw new Error(`generateDayStream: invalid duration_days ${duration_days}`);
  }
  if (!start_date || start_date.length !== 10) {
    throw new Error('generateDayStream: invalid start_date (must be YYYY-MM-DD)');
  }

  const numBatches = Math.ceil(duration_days / BATCH_SIZE);

  // Launch ALL batches in TRUE parallel. The previous chain-via-.then
  // approach silently serialized every LLM call (each batch awaited the
  // prior batch's _generateBatch resolving in full), making a 30-day plan
  // take 90-150s wall time. Now every batch fires immediately; we still
  // yield them in day_index order below.
  //
  // We pass priorDays = [] (no continuity hint). Anti-duplication still
  // works because (a) the framework prompt feeds every batch the same
  // anchors/phases/rhythm, and (b) the BE prompt explicitly says "vary
  // each day". Minor cross-batch repetition is acceptable given the
  // ~5× wall-time win.
  const batches = [];
  for (let i = 0; i < numBatches; i++) {
    batches.push(_generateBatch(opts, i, []));
  }

  // Yield in strict order. If a batch throws, propagate.
  for (let i = 0; i < numBatches; i++) {
    const days = await batches[i];
    // Server-side: tag date_key from start_date so the FE has stable keys.
    const tagged = days.map(d => ({
      ...d,
      date_key: _addDaysKey(start_date, d.day_index - 1),
    }));
    yield { type: 'batch', batch_index: i, days: tagged };
  }

  yield { type: 'done' };
}

/**
 * Buffer-everything wrapper for non-streaming callers (tests, internals).
 *
 * @returns {Promise<Array>} merged days[] in order
 * @throws  same as generateDayStream
 */
async function generateAllDays(opts) {
  const days = [];
  for await (const frame of generateDayStream(opts)) {
    if (frame.type === 'batch') days.push(...frame.days);
  }
  return days;
}

module.exports = {
  generateDayStream,
  generateAllDays,
  BATCH_SIZE,
  MAX_PARALLEL,
  // Test-only exports
  __addDaysKey: _addDaysKey,
  __continuitySummary: _continuitySummary,
};
