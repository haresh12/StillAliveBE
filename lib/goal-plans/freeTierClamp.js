'use strict';
// ════════════════════════════════════════════════════════════════════════
// goal-plans/freeTierClamp.js — per-tier plan duration policy.
//
// v4 (2026-05-28): plans are free-form. The user can ask for any integer
// day count from MIN_DURATION_DAYS (3) up to MAX_DURATION_DAYS (90). We
// honor the exact number they asked for — 5-day reset, 10-day kickstart,
// 21-day challenge — and only clamp at the per-tier CEILING:
//
//   • Free:    ceiling = 14 days   ("3-day cleanse" still generates 3 days)
//   • Premium: ceiling = 60 days
//
// If a user (free or premium) types or speaks something above their
// ceiling, we clamp down and set wasClamped=true so the FE can show the
// "Built as X days (you asked for Y)" banner.
//
// Detection is intentionally simple regex — we'd rather over-clamp than
// burn an LLM call to extract intent.
// ════════════════════════════════════════════════════════════════════════

const FREE_MAX_DAYS    = 14;
const PREMIUM_MAX_DAYS = 60;
const HARD_MIN_DAYS    = 3;
const HARD_MAX_DAYS    = 90;

const NUMBER_WORDS = {
  three: 3, five: 5, seven: 7, ten: 10, fourteen: 14, twenty: 20,
  thirty: 30, sixty: 60, ninety: 90,
};

// Detect a duration intent in the goal text. Returns null if none found,
// or the user-requested days. Caller is responsible for clamping.
function detectDurationIntent(goalText) {
  if (!goalText) return null;
  const t = String(goalText).toLowerCase();

  // Number-word path: "five-day", "ten day", "twenty-one days"
  for (const [word, n] of Object.entries(NUMBER_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(t)) return Math.min(Math.max(n, 1), HARD_MAX_DAYS);
  }

  // Numeric path: "60-day", "30 days", "in 90 days", "12 weeks"
  const m = t.match(/(\d{1,3})\s*[-\s]?\s*(day|days|week|weeks|month|months)\b/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  if (!Number.isFinite(n)) return null;
  if (unit.startsWith('day'))   return Math.min(Math.max(n,    1), HARD_MAX_DAYS);
  if (unit.startsWith('week'))  return Math.min(Math.max(n*7,  1), HARD_MAX_DAYS);
  if (unit.startsWith('month')) return Math.min(Math.max(n*30, 1), HARD_MAX_DAYS);
  return null;
}

/**
 * Apply the per-tier duration clamp.
 *
 * Resolution order for the "intended" day count:
 *   1. Text intent ("in 7 days", "ten-day kickstart") — wins because it's
 *      the user's own words.
 *   2. Explicit FE-passed `requestedDays`.
 *   3. Tier-appropriate default (14 free, 30 premium).
 *
 * @param {object}  args
 * @param {number}  args.requestedDays   duration_days from the FE (or null)
 * @param {string}  args.goalText        the user's stated goal
 * @param {boolean} args.isPremium      from wellness_users/{id}.subscription.isPremium
 *
 * Returns:
 *   {
 *     durationDays:           number   the duration to actually generate
 *     wasClamped:             boolean  true if we cut the user's ask
 *     requestedDurationDays:  number   the original intent (for telemetry + FE banner)
 *   }
 */
function applyFreeTierClamp({ requestedDays, goalText, isPremium }) {
  const textIntent = detectDurationIntent(goalText);
  const defaultAsk = isPremium ? 30 : 14;

  let intended = textIntent != null
    ? textIntent
    : (Number.isInteger(requestedDays) && requestedDays > 0 ? requestedDays : defaultAsk);

  // Floor: never generate fewer than 3 days (a "1-day plan" is just a task,
  // not a plan). If the user asks for 1-2, round up to 3.
  intended = Math.max(intended, HARD_MIN_DAYS);
  intended = Math.min(intended, HARD_MAX_DAYS);

  const ceiling = isPremium ? PREMIUM_MAX_DAYS : FREE_MAX_DAYS;
  const durationDays = Math.min(intended, ceiling);
  const wasClamped = intended > ceiling;

  return {
    durationDays,
    wasClamped,
    requestedDurationDays: intended,
  };
}

module.exports = {
  applyFreeTierClamp,
  detectDurationIntent,
  FREE_MAX_DAYS,
  PREMIUM_MAX_DAYS,
  HARD_MIN_DAYS,
  HARD_MAX_DAYS,
};
