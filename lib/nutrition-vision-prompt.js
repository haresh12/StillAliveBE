'use strict';
// ════════════════════════════════════════════════════════════════════
// nutrition-vision-prompt.js — V2 prompt builder for photo → nutrition.
//
// Three improvements over the inline V1 prompt:
//
//   1. Reference-object enumeration. We explicitly tell the VLM what to
//      look for as size references (hand outline, iPhone footprint
//      ~147×72mm, credit card 85.6×54mm, plate edge) and how to use them
//      for portion estimation. Backed by Purdue 3D-scaling paper
//      arXiv 2404.12257 + canonical hand-portion sizing
//      (palm ≈ 3oz protein, fist ≈ 1 cup, thumb ≈ 1 tbsp).
//
//   2. Step-wise reasoning. Detect ref → infer plate dimensions →
//      infer food volume → density lookup → kcal/macros. Reasoning is
//      written into a `reasoning_notes` field on the response so we can
//      audit drift over time.
//
//   3. Per-user few-shot. We pull the user's last 3 photo corrections
//      from lib/nutrition-correction-store.js and inject them as
//      examples ("for this user, 'salad' typically means 320 kcal, not
//      450 kcal — adjust downward when no reference object is present").
//      Closes Cal AI's "you can't teach it" complaint.
//
// Pure builder — no Firestore, no Gemini call, no Express. Tests cover
// each branch in isolation.
// ════════════════════════════════════════════════════════════════════

const SYSTEM_BASE = `You are a precise nutrition vision model. Identify foods in the image, estimate portion sizes, and return per-item nutrition.

CORE PRINCIPLES:
- Be specific. "Greek yogurt with berries" beats "yogurt + fruit".
- When uncertain about portion, BIAS LOW. A user can adjust upward; over-counts cause more harm than under-counts in adherence research (PMC8485346).
- Recognize restaurant chains from logos, packaging, plating style. Tag is_restaurant: true when a chain is identifiable.
- Never invent items. If the photo shows only a label (no food), return empty items[] with empty_reason: "label_only_no_food".
- Never include hidden fat unless visibly present (butter pat, oil sheen, cream). Don't guess at cooking method when not visible.

OUTPUT a single JSON object matching the schema EXACTLY. No prose outside the JSON.`;

const REFERENCE_OBJECT_BLOCK = `REFERENCE OBJECTS (for portion estimation):
Look explicitly for any of the following in the frame:
- HAND / palm: palm without fingers ≈ 3 oz protein; fist ≈ 1 cup volume; thumb ≈ 1 tbsp; thumb-tip ≈ 1 tsp (NIH portion control canon)
- iPhone: footprint ≈ 147 × 72 mm (iPhone 15/16 standard)
- Credit card: 85.6 × 54 mm (ISO/IEC 7810 ID-1)
- Coin: US quarter = 24.26 mm diameter
- Plate / bowl edge: most dinner plates are 25–28 cm diameter, bowls 14–18 cm

If ANY reference object is visible, set scale_used to the most specific one and ANCHOR your portion estimate to it. If NONE is visible, set scale_used: "plate_inference" and estimate plate diameter from common defaults (≈ 26 cm dinner plate, ≈ 22 cm lunch plate, ≈ 15 cm side plate).

STEPWISE PROCESS for each item:
1. Identify the food (most specific common name).
2. Estimate visible portion volume using the reference object or plate inference.
3. Apply density lookup (e.g. cooked rice ≈ 175 g/cup, grilled chicken breast ≈ 140 g/cup, leafy greens ≈ 30 g/cup).
4. Compute kcal and macros from USDA reference values for that food.
5. Score confidence 0.0–1.0 based on (a) clarity of the food ID and (b) precision of the portion estimate.`;

const SCHEMA_BLOCK = `RESPONSE SCHEMA (strict):
{
  "items": [
    {
      "food_name": string,           // most specific common name
      "kcal": number,
      "protein_g": number,
      "carb_g": number,
      "fat_g": number,
      "fiber_g": number,             // 0 if not estimable
      "qty": number,                 // estimated quantity
      "unit": string,                // "g" | "cup" | "piece" | "slice" | "serving"
      "confidence": number,          // 0.0-1.0
      "reasoning_note": string       // 1 short sentence on how portion was estimated
    }
  ],
  "meal_name": string,               // e.g. "Chicken stir fry with rice"
  "meal_type": "breakfast"|"lunch"|"dinner"|"snack",
  "scale_used": "hand"|"phone"|"card"|"coin"|"plate_edge"|"plate_inference",
  "is_restaurant": boolean,
  "hidden_fat_estimated": boolean,
  "empty_reason": null | "label_only_no_food" | "no_food_detected" | "low_light",
  "overall_confidence": number       // 0.0-1.0 across all items
}`;

/**
 * Render a 1-line user-specific bias example from a correction stream entry.
 * Pure, no I/O.
 */
function renderCorrectionExample(c) {
  if (!c?.original || !c?.corrected) return null;
  const name = (c.corrected.food_name || c.original.food_name || 'unknown').trim();
  const ok = Number.isFinite(c.original.kcal);
  const ck = Number.isFinite(c.corrected.kcal);
  if (!ok || !ck) return null;
  const diff = Math.round(c.corrected.kcal - c.original.kcal);
  if (Math.abs(diff) < 30) return null; // ignore micro-tweaks
  const direction = diff < 0 ? 'lower' : 'higher';
  return `- For this user, "${name}" → ~${Math.round(c.corrected.kcal)} kcal (was ${Math.round(c.original.kcal)}). Bias ${direction}.`;
}

/**
 * Build the few-shot block from a list of recent correction documents.
 * Returns '' (empty) when there's nothing useful to inject.
 */
function buildFewShotBlock(corrections) {
  if (!Array.isArray(corrections) || corrections.length === 0) return '';
  const lines = corrections
    .map(renderCorrectionExample)
    .filter(Boolean)
    .slice(0, 5);
  if (lines.length === 0) return '';
  return `\nUSER-SPECIFIC CALIBRATION (from this user's past corrections):\n${lines.join('\n')}\n`;
}

/**
 * Build the user-context block from a setup snapshot. Keeps the prompt
 * grounded in the user's diet/goal so identification is more relevant
 * (e.g. vegan user → don't guess "chicken" for a tofu-shaped item).
 */
function buildUserContextBlock(setup) {
  if (!setup) return '';
  const parts = [];
  if (setup.dietary_style && setup.dietary_style !== 'no_restrictions') {
    parts.push(`Diet: ${setup.dietary_style}.`);
  }
  if (setup.goal) parts.push(`Goal: ${setup.goal}.`);
  if (Array.isArray(setup.allergies) && setup.allergies.length > 0) {
    parts.push(`Allergies/avoid: ${setup.allergies.join(', ')}.`);
  }
  if (parts.length === 0) return '';
  return `\nUSER CONTEXT: ${parts.join(' ')}\n`;
}

/**
 * Top-level builder.
 *
 * @param {Object} opts
 * @param {Object} opts.setup       — user setup snapshot (diet, goal, allergies)
 * @param {Array}  opts.corrections — recent {original, corrected} pairs
 * @returns {string} the assembled system prompt
 */
function buildVisionSystemPrompt({setup, corrections} = {}) {
  return [
    SYSTEM_BASE,
    REFERENCE_OBJECT_BLOCK,
    buildUserContextBlock(setup),
    buildFewShotBlock(corrections),
    SCHEMA_BLOCK,
  ].filter(Boolean).join('\n\n');
}

/**
 * Companion user-message builder. Caller can either: (a) pass the photo
 * inline as a multimodal part (Gemini), or (b) use this string as the
 * text prompt with the image attached separately. Either way returns
 * the consistent "do the task" line.
 */
function buildVisionUserMessage({mealHintHour} = {}) {
  const hour = Number.isFinite(mealHintHour) ? mealHintHour : null;
  const mealHint =
    hour == null ? '' :
    hour >= 5 && hour < 11 ? ' (this was likely breakfast)' :
    hour >= 11 && hour < 15 ? ' (this was likely lunch)' :
    hour >= 17 && hour < 22 ? ' (this was likely dinner)' :
    ' (this may be a snack)';
  return `Identify each food item in this photo and estimate portions${mealHint}. Use the visible reference object (or plate inference) to size your estimates. Return JSON only.`;
}

module.exports = {
  buildVisionSystemPrompt,
  buildVisionUserMessage,
  buildFewShotBlock,        // exported for testing
  buildUserContextBlock,    // exported for testing
  renderCorrectionExample,  // exported for testing
};
