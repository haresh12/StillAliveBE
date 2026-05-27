'use strict';
// ════════════════════════════════════════════════════════════════════════
// goal-plans/userContext.js — lightweight user-context loader for prompts.
//
// What this reads (sandbox-safe — only the top-level user doc, never any
// per-agent subcollection):
//   • wellness_users/{deviceId}        ← global profile + active_coaches
//   • wellness_users/{deviceId}/wellness_meta/cold_start_anchor (one doc)
//
// The point: tell the LLM what we already know so it can ask sharper
// questions and weave the plan around the user's real life — instead of
// re-asking "How active are you?" to a user whose fitness coach has been
// set up for 30 days.
// ════════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
const log = require('../log');

function db() { return admin.firestore(); }

const SUPPORTED_COACHES = ['fitness', 'nutrition', 'mind', 'sleep', 'water', 'fasting'];

function safe(promise, fallback) {
  return promise.then((v) => v).catch(() => fallback);
}

/**
 * Loads a compact user-context bundle for the goal-plans prompts.
 * Always returns an object — never throws — so callers can spread it
 * unconditionally into the prompt builder.
 *
 * Returned shape:
 *   {
 *     name:            string|null
 *     gender:          'male'|'female'|'nonbinary'|'other'|null
 *     age_group:       '18-24'|'25-34'|...|null
 *     active_coaches:  string[]                       (which 6 are set up)
 *     primary_coach:   string|null
 *     primary_goal:    string|null
 *     days_since_join: number|null
 *     cold_start_anchor: string|null
 *     locale:          string                          (echoed for prompt convenience)
 *   }
 */
async function loadUserContext(deviceId, locale = 'en') {
  const empty = {
    name: null,
    gender: null,
    age_group: null,
    active_coaches: [],
    primary_coach: null,
    primary_goal: null,
    days_since_join: null,
    cold_start_anchor: null,
    locale,
  };
  if (!deviceId) return empty;

  try {
    const userRef = db().collection('wellness_users').doc(deviceId);
    const [userSnap, anchorSnap] = await Promise.all([
      safe(userRef.get(), null),
      safe(userRef.collection('wellness_meta').doc('cold_start_anchor').get(), null),
    ]);
    const p = userSnap?.exists ? userSnap.data() : {};

    // active_coaches lives on the user doc (written by personalize.agent + onboarding).
    const activeRaw = Array.isArray(p.active_coaches) ? p.active_coaches : [];
    const active_coaches = activeRaw.filter((c) => SUPPORTED_COACHES.includes(c));

    const joinedMs =
      (p.created_at && typeof p.created_at.toMillis === 'function') ? p.created_at.toMillis()
      : (typeof p.created_at_ms === 'number') ? p.created_at_ms
      : (p.created_at instanceof Date) ? p.created_at.getTime()
      : null;
    const days_since_join = joinedMs ? Math.max(0, Math.floor((Date.now() - joinedMs) / 86400000)) : null;

    return {
      name:              p.name || null,
      gender:            p.gender || null,
      age_group:         p.ageGroup || p.age_group || null,
      active_coaches,
      primary_coach:     p.primaryCoach || p.primary_coach || null,
      primary_goal:      p.primaryGoal || p.primary_goal || null,
      days_since_join,
      cold_start_anchor: anchorSnap?.exists ? (anchorSnap.data().value || null) : null,
      locale,
    };
  } catch (e) {
    log.warn('[goal-plans/userContext] load fail:', e?.message);
    return empty;
  }
}

/**
 * Renders the context as a short prompt block the LLM can read directly.
 * Returns an empty string when we have nothing useful — so the prompt
 * doesn't get padded with "(unknown / unknown / unknown)" noise.
 */
function renderContextBlock(ctx) {
  if (!ctx) return '';
  const lines = [];
  if (ctx.name) lines.push(`Name: ${ctx.name}`);
  if (ctx.age_group) lines.push(`Age group: ${ctx.age_group}`);
  if (ctx.gender) lines.push(`Gender: ${ctx.gender}`);
  if (ctx.active_coaches?.length) lines.push(`Active coaches already set up: ${ctx.active_coaches.join(', ')}`);
  if (ctx.primary_coach) lines.push(`Primary coach: ${ctx.primary_coach}`);
  if (ctx.primary_goal) lines.push(`Stated primary goal: ${ctx.primary_goal}`);
  if (typeof ctx.days_since_join === 'number') lines.push(`Days since join: ${ctx.days_since_join}`);
  if (ctx.cold_start_anchor) lines.push(`Cold-start anchor: ${ctx.cold_start_anchor}`);
  if (!lines.length) return '';
  return `USER CONTEXT (use this — do not re-ask anything we already know):\n${lines.map((l) => '  ' + l).join('\n')}\n`;
}

module.exports = { loadUserContext, renderContextBlock };
