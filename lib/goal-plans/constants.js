'use strict';
// ════════════════════════════════════════════════════════════════════════
// goal-plans/constants.js — THE BE↔FE CONTRACT FILE (v2).
//
// Single source of truth for every key, enum, and bound used by Plans v2.
// Both BE (goal-plans.agent.js) and FE (StillAlive/.../plans/contracts.js)
// reference these names verbatim. Anything that travels the wire MUST be
// declared here first.
//
// Naming law: snake_case fields, kebab-case routes, CAPS_CASE enums.
// ════════════════════════════════════════════════════════════════════════

// ─── Areas (the 6 user-facing goal areas) ───────────────────────────────
const AREAS = Object.freeze(['weight', 'energy', 'sleep', 'calm', 'fasting', 'habits']);

// ─── Plan status (v2: simplified — pause/complete removed) ──────────────
const STATUSES = Object.freeze(['active', 'archived']);

// ─── Duration options (days). v2 adds 90. ───────────────────────────────
const DURATIONS = Object.freeze([7, 30, 90]);

// ─── Item kinds ─────────────────────────────────────────────────────────
// `cap`  = upper bound (≤ X kcal, ≤ X min screen time)
// `do`   = action to perform (30-min walk, 4-7-8 breathing)
// `hit`  = floor target (≥ X g protein, ≥ X glasses water)
// `skip` = absence (no caffeine after 2pm)
// `time` = anchor at clock time (lights out by 11pm)
const ITEM_KINDS = Object.freeze(['cap', 'do', 'hit', 'skip', 'time']);

// ─── Coaches (matches lib/goal-plans/schemas.js COACHES) ────────────────
const COACHES = Object.freeze(['fitness', 'nutrition', 'mind', 'sleep', 'water', 'fasting']);

// ─── Draft question kinds ───────────────────────────────────────────────
const QUESTION_KINDS = Object.freeze(['chip_single', 'chip_multi', 'duration', 'text']);

// ─── Caps & bounds ──────────────────────────────────────────────────────
const LIMITS = Object.freeze({
  MAX_ACTIVE_PLANS_PER_USER: 10,
  MAX_ITEMS_PER_DAY:         8,
  MAX_TODAY_ITEMS_ON_CARD:   5, // library card shows 5; overflow goes to "+N more today"
  MAX_DRAFTS_PER_DAY:        20,
  MAX_GENERATES_PER_DAY:     5,
  MAX_REMINDERS_PER_PLAN:    3, // notif fatigue guardrail
});

// ─── Locales ────────────────────────────────────────────────────────────
const LOCALES = Object.freeze(['en', 'es', 'fr', 'de', 'pt', 'ru']);

// ─── Server error codes ─────────────────────────────────────────────────
const ERROR_CODES = Object.freeze({
  INVALID_GOAL:        'INVALID_GOAL',
  INVALID_TITLE:       'INVALID_TITLE',
  INVALID_DATE:        'INVALID_DATE',
  UNSUPPORTED_DURATION:'UNSUPPORTED_DURATION',
  MISSING_DEVICE_ID:   'MISSING_DEVICE_ID',
  PLAN_NOT_FOUND:      'PLAN_NOT_FOUND',
  DRAFT_NOT_FOUND:     'DRAFT_NOT_FOUND',
  TOO_MANY_PLANS:      'TOO_MANY_PLANS',
  RATE_LIMIT:          'RATE_LIMIT',
  LLM_UNAVAILABLE:     'LLM_UNAVAILABLE',
  PLAN_SCHEMA_DRIFT:   'PLAN_SCHEMA_DRIFT',
  NOT_IMPLEMENTED:     'NOT_IMPLEMENTED',
  INTERNAL:            'INTERNAL',
});

// ─── Firestore paths (single source of truth) ───────────────────────────
// IMPORTANT: log doc uses double-underscore separator (__) because plan IDs
// can contain single underscores — never use slashes (would create a
// subcollection unintentionally).
const PATHS = Object.freeze({
  userDoc:    (deviceId) => `wellness_users/${deviceId}`,
  plansCol:   (deviceId) => `wellness_users/${deviceId}/goal_plans`,
  planDoc:    (deviceId, planId) => `wellness_users/${deviceId}/goal_plans/${planId}`,
  logsCol:    (deviceId) => `wellness_users/${deviceId}/goal_plan_logs`,
  logDoc:     (deviceId, planId, dateKey) => `wellness_users/${deviceId}/goal_plan_logs/${planId}__${dateKey}`,
  draftsCol:  (deviceId) => `wellness_users/${deviceId}/goal_plan_drafts`,
  draftDoc:   (deviceId, draftId) => `wellness_users/${deviceId}/goal_plan_drafts/${draftId}`,
});

// ─── Route paths (v2: 7 only — no /today, /generate, etc.) ──────────────
const ROUTES = Object.freeze({
  LIST:           '/list',
  DRAFT:          '/draft',
  DRAFT_FINALIZE: '/draft/finalize',
  PLAN:           '/plan/:id',
  COMPLETE_ITEM:  '/complete-item',
  RENAME:         '/rename',
  ARCHIVE:        '/archive',
  DELETE:         '/delete',
});

// ─── Mixpanel events (v2 — frozen registry mirrored in FE analyticsEvents) ─
const EVENT_NAMES = Object.freeze({
  TAB_OPEN:          'Goal Plan Tab Opened',
  GENERATE_START:    'Goal Plan Generate Started',
  GENERATE_OK:       'Goal Plan Generate Succeeded',
  GENERATE_FAIL:     'Goal Plan Generate Failed',
  PLAN_VIEWED:       'Goal Plan Viewed',
  ITEM_DONE:         'Goal Plan Item Marked Done',
  PLAN_ARCHIVED:     'Goal Plan Archived',
  PLAN_RENAMED:      'Goal Plan Renamed',
  LLM_L1_FAIL:       'Goal Plan LLM L1 Failed',
  LLM_L2_FAIL:       'Goal Plan LLM L2 Failed',
  LLM_BOTH_FAIL:     'Goal Plan LLM Both Failed',
  SCHEMA_DRIFT:      'Goal Plan Schema Drift Detected',
});

module.exports = Object.freeze({
  AREAS,
  COACHES,
  STATUSES,
  DURATIONS,
  ITEM_KINDS,
  QUESTION_KINDS,
  LIMITS,
  LOCALES,
  EVENT_NAMES,
  ERROR_CODES,
  PATHS,
  ROUTES,
});
