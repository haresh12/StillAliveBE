'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// voice-cost.js — turn a Realtime call's token usage into a dollar cost.
//
// The app accumulates the `usage` object from every `response.done` event during
// the call (audio/text, input/output, cached vs uncached) and sends the summed
// totals here on hangup. We price it with the per-model rate table below.
// Update RATES if OpenAI changes pricing — one place.
// ═══════════════════════════════════════════════════════════════════════════

// USD per 1M tokens. (OpenAI Realtime pricing.)
const RATES = {
  'gpt-realtime-mini': { audioIn: 10, audioCached: 0.30, audioOut: 20, textIn: 0.60, textCached: 0.06, textOut: 2.40 },
  'gpt-realtime':      { audioIn: 32, audioCached: 0.40, audioOut: 64, textIn: 4.00, textCached: 0.40, textOut: 16.00 },
  'gpt-realtime-2':    { audioIn: 32, audioCached: 0.40, audioOut: 64, textIn: 4.00, textCached: 0.40, textOut: 24.00 },
};
const DEFAULT_MODEL = 'gpt-realtime-mini';

// gpt-4o-mini-transcribe (user-speech transcription) isn't in the realtime usage events; estimate it
// from the user's TALK time at ~$0.003/min. user-talk ≈ call duration − coach talk (coach audio out ≈
// 1 token/50ms → 1200 tok/min). Falls back to input-audio tokens if duration is unknown.
const TRANSCRIBE_PER_MIN = 0.003;
const COACH_TOK_PER_MIN = 1200; // assistant audio
const AUDIO_TOK_PER_MIN = 600; // user audio (fallback only)

const r6 = (n) => Math.round(n * 1e6) / 1e6;

/**
 * @param {object} usage summed totals: { input_audio_tokens, input_text_tokens, cached_audio_tokens,
 *                 cached_text_tokens, output_audio_tokens, output_text_tokens }
 * @param {string} model e.g. 'gpt-realtime-mini'
 * @returns {{cost_usd, model_cost_usd, transcribe_cost_usd, total_tokens, cached_tokens, ...}}
 */
function computeCost(usage, model, durationSec = 0) {
  const r = RATES[model] || RATES[DEFAULT_MODEL];
  const u = usage || {};
  const inAudio = Math.max(0, Number(u.input_audio_tokens) || 0);
  const inText = Math.max(0, Number(u.input_text_tokens) || 0);
  const cachedAudio = Math.min(inAudio, Math.max(0, Number(u.cached_audio_tokens) || 0));
  const cachedText = Math.min(inText, Math.max(0, Number(u.cached_text_tokens) || 0));
  const outAudio = Math.max(0, Number(u.output_audio_tokens) || 0);
  const outText = Math.max(0, Number(u.output_text_tokens) || 0);

  const modelCost = (
    (inAudio - cachedAudio) * r.audioIn +
    cachedAudio * r.audioCached +
    (inText - cachedText) * r.textIn +
    cachedText * r.textCached +
    outAudio * r.audioOut +
    outText * r.textOut
  ) / 1e6;
  // User talk-time ≈ call duration − coach talk-time (much better than the re-billed input-audio sum).
  const callMin = (Number(durationSec) || 0) / 60;
  const coachMin = outAudio / COACH_TOK_PER_MIN;
  const userMin = callMin > 0 ? Math.max(0, callMin - coachMin) : inAudio / AUDIO_TOK_PER_MIN;
  const transcribeCost = userMin * TRANSCRIBE_PER_MIN;

  return {
    cost_usd: r6(modelCost + transcribeCost),
    model_cost_usd: r6(modelCost),
    transcribe_cost_usd: r6(transcribeCost),
    total_tokens: inAudio + inText + outAudio + outText,
    cached_tokens: cachedAudio + cachedText,
    input_audio_tokens: inAudio,
    input_text_tokens: inText,
    output_audio_tokens: outAudio,
    output_text_tokens: outText,
    model: model || DEFAULT_MODEL,
  };
}

module.exports = { computeCost, RATES };
