'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// workout-plan-parser.js — turn an uploaded workout-plan PHOTO into usable TEXT.
//
// The onboarding "Got a workout plan?" step stores the image, but an image is
// useless to the agents on its own. This runs vision on it once, extracts a
// clean weekly plan (days · exercises · sets×reps), and renders it to readable
// text — that text is what the voice coach / Plans / fitness coach reference.
//
// IMPORTANT: this uses the SAME proven Gemini vision path as the in-app chat
// "Upload my plan" flow (fitness.agent.js → /plan/upload). The old OpenAI
// `gpt-5.4-mini` path silently failed on every photo ("Couldn't read it"), so
// onboarding now mirrors the path we KNOW works.
// ═══════════════════════════════════════════════════════════════════════════
const { callGeminiVision } = require('./vision-router');

// Same shape the chat upload uses, so both flows extract identically.
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    days: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          day: { type: 'string' },
          exercises: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                sets: { type: 'number' },
                reps: { type: 'number' },
              },
              required: ['name'],
            },
          },
        },
        required: ['day', 'exercises'],
      },
    },
  },
  required: ['days'],
};

const SYSTEM_PROMPT = [
  'You are an expert strength coach reading a gym WORKOUT PLAN / training program from a photo (printout, whiteboard, app screenshot, or handwritten sheet).',
  'Goal: return a COMPLETE, ready-to-use weekly plan — for EACH training day, its label and 4–6 exercises with sets and reps.',
  'RULES:',
  "- 'day' = the weekday if shown (Monday, Tuesday, …). If the plan uses split names instead (Push, Pull, Legs, Upper, Lower, Full Body, Chest, Back, Arms) or 'Day 1/Day 2', put THAT label in 'day'.",
  "- Normalize exercise names to standard form (e.g. 'BB Bench'→'Bench Press', 'RDL'→'Romanian Deadlift', 'OHP'→'Overhead Press').",
  "- 'sets' = working sets (integer). 'reps' = target reps; for a range '8-12' use the lower end (8); for AMRAP/failure use 10.",
  '- BE SMART — COMPLETE PARTIAL PLANS. Most photos are incomplete. Keep EXACTLY what the user wrote, then intelligently FILL THE GAPS so every training day is usable:',
  "    • If a day shows only a focus/split label (e.g. 'Monday — Chest', 'Push', 'Legs') with NO exercises, ADD 4–6 appropriate exercises for that focus (compound lifts first, then accessories).",
  '    • If a day lists fewer than 4 exercises, ADD complementary ones to reach 4–6 (don’t duplicate what’s there).',
  '    • If sets/reps are missing, use sensible defaults: compounds 4×6–8, accessories 3×10–12.',
  '  Use the user’s exact exercises/numbers wherever shown; only invent what’s missing.',
  '- Skip warmup rows, cardio-only notes, and rest days.',
  '- If the image is genuinely NOT a workout plan (blurry, unrelated, blank), return an empty days array — do NOT fabricate a plan from nothing.',
  'Return ONLY JSON matching the schema.',
].join('\n');

const clampInt = (v, d, lo, hi) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};
const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : s);

// Render the structured days into the clean, editable plain text the onboarding
// review screen shows (and that the agents consume).
function renderText(days) {
  const lines = [];
  for (const d of days) {
    const label = cap(String(d.day || '').trim()) || 'Workout';
    const exercises = (Array.isArray(d.exercises) ? d.exercises : [])
      .slice(0, 30)
      .map((e) => {
        const name = String(e?.name || '').trim().slice(0, 60);
        if (!name) return null;
        const sets = clampInt(e?.sets, 3, 1, 20);
        const reps = clampInt(e?.reps, 10, 0, 100);
        return `  • ${name} — ${sets}×${reps}`;
      })
      .filter(Boolean);
    if (!exercises.length) continue;
    lines.push(label, ...exercises, '');
  }
  return lines.join('\n').trim();
}

/**
 * Parse a workout-plan image → { text, days } (or null if it isn't a plan / parsing fails).
 * @param {string} b64  base64 image bytes (with or without data: prefix)
 * @param {string} mime e.g. 'image/jpeg' (unused — vision-router sniffs the bytes)
 */
async function parsePlanImage(b64 /* , mime */) {
  if (!b64) return null;
  const parsed = await callGeminiVision({
    systemPrompt: SYSTEM_PROMPT,
    userText: 'Extract the weekly workout plan from this image.',
    images: [String(b64)],
    responseSchema: RESPONSE_SCHEMA,
    maxOutputTokens: 8192,
    model: 'gemini-2.5-flash',
    label: 'onboarding-workout-plan',
  });
  const days = parsed && Array.isArray(parsed.days)
    ? parsed.days.filter((d) => Array.isArray(d.exercises) && d.exercises.length)
    : [];
  if (!days.length) return null;
  const text = renderText(days);
  if (!text) return null;
  return { text: text.slice(0, 2000), days };
}

module.exports = { parsePlanImage };
