'use strict';
// ════════════════════════════════════════════════════════════════════════
// goal-plans/freeTierClamp.js — free-tier plan duration policy.
//
// Free users get plans up to 30 days. Premium users can request up to 90.
// If a free user asks for 60/90 (either via duration_days param or via
// natural-language intent in the goal_text), we clamp to 30 and surface
// the original ask back to the FE so it can show an upgrade-nudge banner.
//
// Detection is intentionally simple regex — we'd rather over-clamp than
// risk asking the LLM a yes/no question to extend by 60 days.
// ════════════════════════════════════════════════════════════════════════

const FREE_MAX_DAYS = 30;

const NUMBER_WORDS = {
  thirty: 30, sixty: 60, ninety: 90,
  'sixty-day': 60, 'ninety-day': 90,
};

// Detect a duration intent in the goal text. Returns null if none found,
// or the user-requested days (capped at 365 so a stray "1000 day" doesn't
// poison telemetry).
function detectDurationIntent(goalText) {
  if (!goalText) return null;
  const t = String(goalText).toLowerCase();

  // Number-word path: "sixty day plan", "ninety-day plan"
  for (const [word, n] of Object.entries(NUMBER_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(t)) return Math.min(n, 365);
  }

  // Numeric path: "60-day", "30 days", "in 90 days", "12 weeks"
  const m = t.match(/(\d{1,3})\s*[-\s]?\s*(day|days|week|weeks|month|months)\b/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  if (!Number.isFinite(n)) return null;
  if (unit.startsWith('day'))   return Math.min(n, 365);
  if (unit.startsWith('week'))  return Math.min(n * 7, 365);
  if (unit.startsWith('month')) return Math.min(n * 30, 365);
  return null;
}

/**
 * Apply the free-tier clamp.
 *
 * @param {object} args
 * @param {number} args.requestedDays   duration_days from the FE
 * @param {string} args.goalText        the user's stated goal
 * @param {boolean} args.isPremium      from wellness_users/{id}.subscription.isPremium
 *
 * Returns:
 *   {
 *     durationDays:        number   the duration to actually generate (≤30 for free)
 *     wasClamped:          boolean  true if we cut user's ask
 *     requestedDurationDays: number  the original intent (for telemetry + FE banner)
 *   }
 */
function applyFreeTierClamp({ requestedDays, goalText, isPremium }) {
  // Highest-fidelity ask: explicit param wins, then text intent.
  const textIntent = detectDurationIntent(goalText);
  const intended = Math.max(Number(requestedDays) || 30, textIntent || 0);

  if (isPremium) {
    // Premium users get whatever they asked for, capped at 90 (BE schema cap).
    const clamped = Math.min(intended, 90);
    return {
      durationDays: [7, 30, 90].includes(clamped) ? clamped : 30,
      wasClamped: false,
      requestedDurationDays: intended,
    };
  }

  // Free path: clamp at 30.
  const clamped = Math.min(intended, FREE_MAX_DAYS);
  const durationDays = clamped <= 7 ? 7 : 30;
  return {
    durationDays,
    wasClamped: intended > FREE_MAX_DAYS,
    requestedDurationDays: intended,
  };
}

module.exports = { applyFreeTierClamp, detectDurationIntent, FREE_MAX_DAYS };
