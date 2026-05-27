'use strict';
// ════════════════════════════════════════════════════════════════════════
// schemas.js — JSON Schema contracts for Plans v3 (time-grouped redesign).
//
// v3 ships a clean, scannable day view. The item shape stays the same
// 3-bullet (title / when_label / impact), but now every item also carries
// a `time_section` so the FE can group MORNING / EVENING / NIGHT.
//
// Added in this version:
//   • item.time_section enum (morning|evening|night)
//   • plan.headline_metric { type, baseline, target, unit, label }
//   • day.theme is now formula-derived FE-side (Foundation/Build/Peak) — no
//     LLM field added, no migration required.
//
// Removed in this version:
//   • full_description generation — clean UI, no big narrative block.
//   • spotlight per-day generation — same reason.
//
// Existing fields kept optional in STORED_PLAN so a v2 doc validating
// against STORED_PLAN doesn't error on read; the /list route filters by
// schema_version anyway.
// ════════════════════════════════════════════════════════════════════════

const COACHES = ['fitness', 'nutrition', 'mind', 'sleep', 'water', 'fasting'];
const ITEM_KINDS = ['cap', 'do', 'hit', 'skip', 'time'];
const QUESTION_KINDS = ['chip_single', 'chip_multi', 'duration', 'text'];
const TIME_SECTIONS = ['morning', 'evening', 'night'];

// ─── 1. ROUTE_GOAL ──────────────────────────────────────────────────────
const ROUTE_GOAL = {
  type: 'object',
  required: ['coaches', 'why'],
  properties: {
    coaches: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: { type: 'string', enum: COACHES },
    },
    detected_goal_key: { type: 'string' },
    why: { type: 'string', minLength: 5 },
  },
};

// ─── 2. COMPOSE_QUESTIONS ───────────────────────────────────────────────
const COMPOSE_QUESTIONS = {
  type: 'object',
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      minItems: 6,
      maxItems: 15,
      items: {
        type: 'object',
        required: ['id', 'q', 'kind', 'coach'],
        properties: {
          id:    { type: 'string', minLength: 1 },
          q:     { type: 'string', minLength: 6 },
          kind:  { type: 'string', enum: QUESTION_KINDS },
          coach: { type: 'string', enum: COACHES },
          choices: {
            type: 'array',
            maxItems: 8,
            items: { type: 'string', minLength: 1 },
          },
        },
      },
    },
  },
};

// ─── 3. PROPOSE_PLAN_FRAMEWORK (v3 — compact, no narrative dump) ────────
// Generates: plan title + daily anchors (with time_section) + headline_metric.
// full_description REMOVED — the day-by-day UI is the plan, no big paragraph
// block needed. Saves ~1500 tokens and ~3s of finalize latency per plan.
const PROPOSE_NAME = {
  type: 'object',
  required: ['title', 'daily_anchors', 'headline_metric'],
  properties: {
    title: { type: 'string', minLength: 3, maxLength: 120 },

    // Optional research anchor (one citation, only if real).
    research_anchor: { type: 'string' },

    // headline_metric: the big number that lives in the day-screen header.
    // The LLM extracts this from the user's goal_text. It MUST be goal-specific
    // — no static defaults. For "lose 3kg in 30 days": { type:'kg_lost',
    // baseline:0, target:3, unit:'kg', label:'kg to go' }. For "sleep 8h":
    // { type:'hours_per_night', baseline:6, target:8, unit:'h', label:'hours' }.
    // For non-numeric goals (e.g. "calm my mind"): type:'plan_pct' falls back
    // to % complete and the FE handles the label.
    headline_metric: {
      type: 'object',
      required: ['type', 'label'],
      properties: {
        type:     { type: 'string', minLength: 2, maxLength: 40 },  // free-form key
        baseline: { type: 'number' },
        target:   { type: 'number' },
        unit:     { type: 'string', maxLength: 12 },
        label:    { type: 'string', minLength: 2, maxLength: 40 },  // e.g. "kg to go"
        direction:{ type: 'string', enum: ['up', 'down'] },
      },
    },

    // Daily anchors: 2-5 non-negotiables that the FE will INLINE into each
    // day's items at finalize time, tagged with time_section.
    daily_anchors: {
      type: 'array',
      minItems: 2,
      maxItems: 6,
      items: {
        type: 'object',
        required: ['title', 'when_label', 'impact', 'coach', 'kind', 'time_section'],
        properties: {
          title:        { type: 'string', minLength: 3, maxLength: 60 },
          when_label:   { type: 'string', minLength: 3, maxLength: 30 },
          impact:       { type: 'string', minLength: 6, maxLength: 140 },
          coach:        { type: 'string', enum: COACHES },
          kind:         { type: 'string', enum: ITEM_KINDS },
          // NEW in v3: which section of the day this anchor lives in.
          time_section: { type: 'string', enum: TIME_SECTIONS },
          target:       { type: 'number' },
          unit:         { type: 'string' },
          time_anchor_local: { type: 'string' },
        },
      },
    },
  },
};

// ─── 4. COMPOSE_PLAN_BATCH (v3 — time_section, no spotlight) ────────────
// Per batch (5 days). Each day has summary + items (each tagged with a
// time_section). Spotlight removed — the day's structure IS the briefing.
const COMPOSE_PLAN_BATCH = {
  type: 'object',
  required: ['days'],
  properties: {
    days: {
      type: 'array',
      minItems: 1,
      maxItems: 7,
      items: {
        type: 'object',
        required: ['day_index', 'summary', 'items'],
        properties: {
          day_index: { type: 'integer', minimum: 1, maximum: 90 },
          // 1-3 word label. "Foundation", "Push Day", "Refeed", "Retest"
          summary:   { type: 'string', minLength: 2, maxLength: 60 },
          rest_day:  { type: 'boolean' },
          items: {
            type: 'array',
            minItems: 2,
            maxItems: 6,
            items: {
              type: 'object',
              required: ['title', 'when_label', 'impact', 'coach', 'kind', 'time_section'],
              properties: {
                // WHAT — the action. ≤6 words, concrete.
                title:        { type: 'string', minLength: 3, maxLength: 60 },
                // WHEN — single window label. 1-3 words. "Anytime",
                // "Pre-workout", "Bedtime", "After lunch", etc.
                when_label:   { type: 'string', minLength: 3, maxLength: 30 },
                // IMPACT — one sentence, body/goal effect with a stat.
                impact:       { type: 'string', minLength: 6, maxLength: 140 },
                coach:        { type: 'string', enum: COACHES },
                kind:         { type: 'string', enum: ITEM_KINDS },
                // NEW in v3: time_section drives FE grouping. "morning" =
                // wake → ~noon, "evening" = ~noon → ~9pm, "night" = wind-down
                // through sleep prep. LLM picks based on item nature.
                time_section: { type: 'string', enum: TIME_SECTIONS },
                target:       { type: 'number' },
                unit:         { type: 'string' },
                time_anchor_local: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
};

// ─── 5. STORED_PLAN ─────────────────────────────────────────────────────
// Persisted shape. Includes everything: framework + days + Q&A trail.
const STORED_PLAN = {
  type: 'object',
  required: [
    'id', 'device_id', 'title', 'goal_text', 'coaches_involved',
    'duration_days', 'start_date', 'end_date', 'status', 'locale',
    'generated_by', 'generated_at_ms', 'days',
  ],
  properties: {
    id:               { type: 'string', minLength: 6 },
    device_id:        { type: 'string', minLength: 4 },
    title:            { type: 'string', minLength: 3, maxLength: 120 },
    goal_text:        { type: 'string', minLength: 3 },
    coaches_involved: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: { type: 'string', enum: COACHES },
    },
    duration_days:    { type: 'integer', enum: [7, 30, 90] },
    start_date:       { type: 'string', minLength: 10, maxLength: 10 },
    end_date:         { type: 'string', minLength: 10, maxLength: 10 },
    status:           { type: 'string', enum: ['active', 'archived'] },
    locale:           { type: 'string', minLength: 2, maxLength: 2 },
    generated_by:     { type: 'string' },
    generated_at_ms:  { type: 'integer', minimum: 0 },
    research_anchor:  { type: 'string' },

    // headline_metric: the big number rendered in the day-screen header.
    // Goal-extracted, never static. Optional only because legacy v2 plans
    // exist; v3 plans always carry it.
    headline_metric: {
      type: 'object',
      properties: {
        type:      { type: 'string' },
        baseline:  { type: 'number' },
        target:    { type: 'number' },
        unit:      { type: 'string' },
        label:     { type: 'string' },
        direction: { type: 'string' },
      },
    },

    // Daily anchors — kept on the plan for reference / lookups, but the FE
    // now reads them inlined into each day's items (BE inlines at finalize).
    daily_anchors:    {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          id:           { type: 'string' },
          title:        { type: 'string' },
          when_label:   { type: 'string' },
          impact:       { type: 'string' },
          coach:        { type: 'string', enum: COACHES },
          kind:         { type: 'string', enum: ITEM_KINDS },
          time_section: { type: 'string', enum: TIME_SECTIONS },
          target:       { type: 'number' },
          unit:         { type: 'string' },
          time_anchor_local: { type: 'string' },
        },
      },
    },

    // Q&A trail — every question we asked + the user's answer.
    // Stored so the user can revisit "what did I tell the AI about myself?"
    questions_answered: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id:    { type: 'string' },
          q:     { type: 'string' },
          kind:  { type: 'string' },
          coach: { type: 'string' },
          choices: { type: 'array', items: { type: 'string' } },
          value: {}, // can be string or array; loose by design
        },
      },
    },

    days: {
      type: 'array',
      minItems: 1,
      maxItems: 90,
      items: {
        type: 'object',
        required: ['day_index', 'date_key', 'items'],
        properties: {
          day_index: { type: 'integer', minimum: 1, maximum: 90 },
          date_key:  { type: 'string', minLength: 10, maxLength: 10 },
          // 1-3 word label for the day itself ("Foundation", "Push Day").
          summary:   { type: 'string', maxLength: 60 },
          // Theme drives the eyebrow above the day title: "DAY 01 · FOUNDATION".
          // Derived BE-side at finalize from day_index/duration ratios.
          theme:     { type: 'string', maxLength: 24 },
          rest_day:  { type: 'boolean' },
          items: {
            type: 'array',
            minItems: 1,
            maxItems: 12,            // raised — anchors get inlined per day
            items: {
              type: 'object',
              required: ['id', 'title', 'coach', 'kind'],
              properties: {
                id:           { type: 'string', minLength: 4 },
                title:        { type: 'string', minLength: 3 },
                when_label:   { type: 'string' },
                impact:       { type: 'string' },
                coach:        { type: 'string', enum: COACHES },
                kind:         { type: 'string', enum: ITEM_KINDS },
                // NEW in v3: time_section. Required for v3 items but loose at
                // STORED_PLAN level so legacy v2 docs don't error on read.
                time_section: { type: 'string', enum: TIME_SECTIONS },
                // Marks items inlined from daily_anchors so FE can style/sort.
                from_anchor:  { type: 'boolean' },
                target:       { type: 'number' },
                unit:         { type: 'string' },
                time_anchor_local: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
};

module.exports = {
  ROUTE_GOAL,
  COMPOSE_QUESTIONS,
  PROPOSE_NAME,
  COMPOSE_PLAN_BATCH,
  STORED_PLAN,
  COACHES,
  ITEM_KINDS,
  QUESTION_KINDS,
  TIME_SECTIONS,
};
