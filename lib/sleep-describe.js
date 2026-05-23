'use strict';
const { AI } = require('./ai/models');
const { appendLanguageInstruction } = require('./i18n-prompt');
// ════════════════════════════════════════════════════════════════════
// sleep-describe.js — voice-first sleep logging.
//
// Pipeline: audio → transcript → parsed sleep object with confidence per
// field. Frontend then opens confirmation modal, user fills gaps, saves
// via existing /api/sleep/log. Zero downstream impact.
//
// Reuses nutrition's proven gpt-4o-transcribe + parse pattern. Single
// agents law: this lib reads ONLY sleep data; cross-agent insight stays
// in the cross-agent engine.
//
// Cost: ~$0.007 per log ($0.006 transcribe + ~$0.0008 parse).
// Latency: P50 ≤2.5s from audio release → confirmation modal.
//
// OpenAI compliance: max_completion_tokens only, never temperature.
// ════════════════════════════════════════════════════════════════════

const { OpenAI } = require('openai');

// ─── Sleep schema constants ─────────────────────────────────────────
const QUALITY_WORDS = {
  great: 5, excellent: 5, amazing: 5, perfect: 5, awesome: 5, fantastic: 5,
  good: 4, solid: 4, decent: 4, fine: 4, alright: 4, okay: 3, ok: 3, average: 3, meh: 3,
  poor: 2, bad: 2, rough: 2, restless: 2, broken: 2,
  terrible: 1, awful: 1, horrible: 1, brutal: 1, 'no sleep': 1, garbage: 1,
};

// Must match SleepTrackTab.DISRUPTORS exactly so manual + voice logs share buckets.
const DISRUPTOR_CANON = [
  'Caffeine late', 'Alcohol', 'Late exercise', 'Heavy meal',
  'Screens in bed', 'Racing mind', 'Stress', 'Noise', 'Light',
  'Temperature', 'Partner / kids', 'Pain', 'Bathroom trips',
];

// ─── Cached system prompt (>1024 token stable prefix → ~80% cache hit) ─
const SLEEP_DESCRIBE_SYSTEM = `You parse a user's casual description of last night's sleep into structured fields.

OUTPUT JSON ONLY. Schema:
{
  "extracted": {
    "bedtime":        { "value": "HH:MM" | null, "confidence": 0-1 },
    "wake_time":      { "value": "HH:MM" | null, "confidence": 0-1 },
    "sleep_quality":  { "value": 1|2|3|4|5 | null, "confidence": 0-1 },
    "sleep_latency":  { "value": <0-180>  | null, "confidence": 0-1 },
    "night_wakings":  { "value": <0-10>   | null, "confidence": 0-1 },
    "morning_energy": { "value": 1|2|3|4|5 | null, "confidence": 0-1 },
    "disruptors":     { "value": [<from canonical list>], "confidence": 0-1 }
  },
  "missing": [<field names that are null OR confidence < 0.5>],
  "summary": "<one-sentence plain-English recap, ≤90 chars>"
}

CANONICAL DISRUPTORS (the only allowed values for disruptors[], case-sensitive):
"Caffeine late", "Alcohol", "Late exercise", "Heavy meal",
"Screens in bed", "Racing mind", "Stress", "Noise", "Light",
"Temperature", "Partner / kids", "Pain", "Bathroom trips"

TIME PARSING:
- "Midnight" → "00:00". "Noon" → "12:00".
- "11pm" / "11 PM" / "around 11" → "23:00" (confidence 0.7 for "around")
- "Half past 10" → "22:30"
- Bedtime is the time they got into bed for sleep, NOT when they got home.
- Wake time is when they got out of bed, NOT first eye-open if they specify.

QUALITY MAPPING (1-5 scale):
- great/excellent/amazing/perfect/fantastic = 5
- good/solid/decent/fine/alright = 4
- okay/ok/average/meh = 3
- poor/bad/rough/restless/broken = 2
- terrible/awful/horrible/brutal = 1
- "Slept like a baby" = 5. "Garbage night" = 1.

LATENCY (minutes to fall asleep):
- Explicit minutes ("20 min", "half an hour" → 30) = confidence 0.9+
- "Quick" / "fast" → 5, confidence 0.7
- "Took a while" / "slow" without minutes → 30, confidence 0.5
- "Couldn't sleep for ages" → 60, confidence 0.6
- Don't infer if not mentioned at all.

WAKINGS (count of times they woke up):
- "Woke up twice" → 2. "Slept through" → 0. "Up a few times" → 3.
- "Don't remember" → null.

DISRUPTORS:
- ONLY use values from the canonical list above (case-sensitive).
- Match common phrases:
  - "had coffee late" / "espresso after dinner" → "Caffeine late"
  - "wine" / "drinks" / "alcohol" → "Alcohol"
  - "worked out late" / "evening run" → "Late exercise"
  - "big dinner" / "ate too much" / "late meal" → "Heavy meal"
  - "phone in bed" / "scrolling" / "tv" → "Screens in bed"
  - "couldn't stop thinking" / "mind racing" → "Racing mind"
  - "stressed" / "anxious" / "worried" → "Stress"
  - "noisy" / "loud" / "neighbours" → "Noise"
  - "light bleeding" / "too bright" → "Light"
  - "hot room" / "cold" / "temperature" → "Temperature"
  - "kid was up" / "baby" / "partner snoring" → "Partner / kids"
  - "back hurt" / "headache" / "uncomfortable" → "Pain"
  - "up to pee" / "bathroom" → "Bathroom trips"
- If user explicitly says "nothing disturbed me" or similar → return [], confidence 0.95.
- If no info at all about disruptors → return [], confidence 0.4.

CONFIDENCE TIERS:
- 0.85+ when value is explicit and unambiguous.
- 0.5-0.85 when inferred from soft language ("around", "a while").
- <0.5 or null when not mentioned or ambiguous.

NEVER FABRICATE. When in doubt, leave null and add to "missing".

EXAMPLES:

Input: "I slept from midnight to 8am, sleep was good, took 20 minutes to fall asleep, nothing disturbed me"
Output:
{
  "extracted": {
    "bedtime":        { "value": "00:00", "confidence": 0.95 },
    "wake_time":      { "value": "08:00", "confidence": 0.97 },
    "sleep_quality":  { "value": 4,       "confidence": 0.9 },
    "sleep_latency":  { "value": 20,      "confidence": 0.95 },
    "night_wakings":  { "value": null,    "confidence": 0 },
    "morning_energy": { "value": null,    "confidence": 0 },
    "disruptors":     { "value": [],      "confidence": 0.95 }
  },
  "missing": ["night_wakings", "morning_energy"],
  "summary": "8 hours of sleep, quality 4/5, fell asleep in 20 minutes."
}

Input: "Pretty rough, kid was up a lot, maybe 5 hours total"
Output:
{
  "extracted": {
    "bedtime":        { "value": null, "confidence": 0 },
    "wake_time":      { "value": null, "confidence": 0 },
    "sleep_quality":  { "value": 2,    "confidence": 0.85 },
    "sleep_latency":  { "value": null, "confidence": 0 },
    "night_wakings":  { "value": 3,    "confidence": 0.6 },
    "morning_energy": { "value": null, "confidence": 0 },
    "disruptors":     { "value": ["Partner / kids"], "confidence": 0.9 }
  },
  "missing": ["bedtime", "wake_time", "sleep_latency", "morning_energy"],
  "summary": "Rough night with multiple wakings, kids disrupted sleep."
}

Input: "Slept great. Probably 7 and a half hours."
Output:
{
  "extracted": {
    "bedtime":        { "value": null, "confidence": 0 },
    "wake_time":      { "value": null, "confidence": 0 },
    "sleep_quality":  { "value": 5,    "confidence": 0.95 },
    "sleep_latency":  { "value": null, "confidence": 0 },
    "night_wakings":  { "value": null, "confidence": 0 },
    "morning_energy": { "value": null, "confidence": 0 },
    "disruptors":     { "value": [],   "confidence": 0.5 }
  },
  "missing": ["bedtime", "wake_time", "sleep_latency", "night_wakings", "morning_energy"],
  "summary": "Great night, around 7.5 hours total."
}`;

// ─── Validators / coercion ──────────────────────────────────────────
function clampInt(n, lo, hi) {
  const x = Math.round(Number(n));
  if (Number.isFinite(x)) return Math.max(lo, Math.min(hi, x));
  return null;
}
function timeStr(v) {
  if (!v || typeof v !== 'string') return null;
  const m = v.match(/^([0-2]?\d):([0-5]\d)$/);
  if (!m) return null;
  const h = clampInt(m[1], 0, 23);
  const min = clampInt(m[2], 0, 59);
  if (h == null || min == null) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
function clampField(field, raw) {
  // Disruptors are always an array — empty [] is a valid signal ("nothing disturbed me").
  if (field === 'disruptors') {
    if (raw == null || !Array.isArray(raw.value)) return { value: [], confidence: 0 };
    const conf = Math.max(0, Math.min(1, Number(raw.confidence) || 0));
    const filtered = raw.value
      .filter(d => DISRUPTOR_CANON.includes(d))
      .slice(0, 8);
    return { value: filtered, confidence: conf };
  }
  if (raw == null || raw.value == null) return { value: null, confidence: 0 };
  const conf = Math.max(0, Math.min(1, Number(raw.confidence) || 0));
  if (field === 'bedtime' || field === 'wake_time') {
    const v = timeStr(raw.value);
    return v ? { value: v, confidence: conf } : { value: null, confidence: 0 };
  }
  if (field === 'sleep_quality' || field === 'morning_energy') {
    const v = clampInt(raw.value, 1, 5);
    return v == null ? { value: null, confidence: 0 } : { value: v, confidence: conf };
  }
  if (field === 'sleep_latency') {
    const v = clampInt(raw.value, 0, 180);
    return v == null ? { value: null, confidence: 0 } : { value: v, confidence: conf };
  }
  if (field === 'night_wakings') {
    const v = clampInt(raw.value, 0, 10);
    return v == null ? { value: null, confidence: 0 } : { value: v, confidence: conf };
  }
  return { value: null, confidence: 0 };
}

function validateExtraction(parsed) {
  const fields = ['bedtime', 'wake_time', 'sleep_quality', 'sleep_latency', 'night_wakings', 'morning_energy', 'disruptors'];
  const extracted = {};
  for (const f of fields) {
    extracted[f] = clampField(f, parsed?.extracted?.[f]);
  }
  // Recompute missing — anything null OR confidence < 0.5 (except disruptors which has [] as a valid empty)
  const missing = fields.filter(f => {
    if (f === 'disruptors') return extracted[f].confidence < 0.5;
    return extracted[f].value == null || extracted[f].confidence < 0.5;
  });
  const summary = (typeof parsed?.summary === 'string' && parsed.summary)
    ? parsed.summary.slice(0, 140)
    : '';
  return { extracted, missing, summary };
}

// ─── Transcribe (audio → text) ──────────────────────────────────────
async function transcribeAudio(openai, audioBase64, audioMime = 'audio/wav') {
  if (!audioBase64) throw new Error('audio_base64 required');
  const buffer = Buffer.from(audioBase64, 'base64');
  const ext = (audioMime || 'audio/wav').split('/').pop().replace('mpeg', 'mp3');
  const file = await OpenAI.toFile(buffer, `audio.${ext}`);
  const result = await openai.audio.transcriptions.create({
    file,
    model: AI.TRANSCRIBE,
    language: 'en',
    response_format: 'json',
  });
  return (result.text || '').trim();
}

// ─── Parse (text → structured) ──────────────────────────────────────
async function parseSleepText(openai, transcript, language = 'en') {
  if (!transcript) throw new Error('transcript required');
  const completion = await openai.chat.completions.create({
    model: AI.REASONING_FAST,
    response_format: { type: 'json_object' },
    max_completion_tokens: 600,
    messages: [
      { role: 'system', content: appendLanguageInstruction(SLEEP_DESCRIBE_SYSTEM, language) },
      { role: 'user',   content: transcript },
    ],
  });
  const raw = completion.choices?.[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    parsed = { extracted: {}, missing: [], summary: '' };
  }
  return validateExtraction(parsed);
}

// ─── Preflight (no LLM) — instant text inspection ───────────────────
function preflight(text) {
  const t = String(text || '').trim();
  const word_count = t ? t.split(/\s+/).length : 0;
  // Light hint extraction so FE can show "1 time, 2 quality words detected"
  const hasTime = /\b\d{1,2}(:\d{2})?\s*(am|pm)?\b/i.test(t) || /midnight|noon/i.test(t);
  const qualityHits = Object.keys(QUALITY_WORDS).filter(w => new RegExp(`\\b${w}\\b`, 'i').test(t));
  const disruptorHints = [];
  if (/coffee|caffeine|espresso/i.test(t)) disruptorHints.push('Caffeine late');
  if (/alcohol|wine|beer|whisky|whiskey/i.test(t)) disruptorHints.push('Alcohol');
  if (/screen|phone|tv|tablet|scroll/i.test(t)) disruptorHints.push('Screens in bed');
  if (/racing mind|couldn'?t stop thinking|overthinking/i.test(t)) disruptorHints.push('Racing mind');
  if (/stress|anxious|worry|worried/i.test(t)) disruptorHints.push('Stress');
  if (/kid|baby|partner|snor/i.test(t)) disruptorHints.push('Partner / kids');
  if (/hot|cold|temperature|warm/i.test(t)) disruptorHints.push('Temperature');
  if (/noise|noisy|loud/i.test(t)) disruptorHints.push('Noise');
  if (/late workout|evening run|gym late|worked out late/i.test(t)) disruptorHints.push('Late exercise');
  if (/heavy meal|big dinner|ate too much|late dinner/i.test(t)) disruptorHints.push('Heavy meal');
  if (/back hurt|headache|sore|uncomfortable|in pain/i.test(t)) disruptorHints.push('Pain');
  if (/bathroom|up to pee|toilet|wc/i.test(t)) disruptorHints.push('Bathroom trips');
  if (/light bleeding|too bright|street ?light/i.test(t)) disruptorHints.push('Light');
  return {
    word_count,
    has_time_phrase: hasTime,
    quality_hits: qualityHits.slice(0, 3),
    disruptor_hints: disruptorHints,
    long_enough: word_count >= 4,
  };
}

module.exports = {
  SLEEP_DESCRIBE_SYSTEM,
  DISRUPTOR_CANON,
  transcribeAudio,
  parseSleepText,
  validateExtraction,
  preflight,
};
