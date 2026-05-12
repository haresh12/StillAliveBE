'use strict';
// ════════════════════════════════════════════════════════════════
// score-lifetime.js — unified per-agent score outputs.
//
// Every agent's /analysis returns the same 4 outputs, computed
// from a per-day quality map keyed by local-TZ YYYY-MM-DD:
//
//   score_today        — quality of today only (null if no log)
//   score_7d_smoothed  — mean of last 7 logged days
//   score_lifetime     — mean of ALL logged days since anchor
//   missed_days        — daysSinceAnchor - days_logged
//
// "Logged day" = a day with at least one entry; days with no entry
// do NOT contribute zero — they are surfaced as missed_days. This
// is the Registration Anchor Law: missed and "scored low" are
// distinct things.
// ════════════════════════════════════════════════════════════════

const { enumerateDaysFrom } = require('./range-helpers');

/**
 * Compute the four standard score outputs.
 *
 * @param {object} args
 * @param {Object<string, number>} args.qualityByDate
 *   Map of YYYY-MM-DD → per-day score (0-100). Only days the user
 *   actually logged should appear. Days with zero logs MUST be absent.
 * @param {string} args.todayDate         YYYY-MM-DD in user's TZ
 * @param {string|null} args.anchorDate   YYYY-MM-DD signup date (null = legacy)
 * @param {number} args.daysSinceAnchor   precomputed inclusive day count
 *
 * @returns {{ score_today: number|null, score_7d_smoothed: number|null,
 *            score_lifetime: number|null, missed_days: number, days_logged: number }}
 */
function computeStandardOutputs({ qualityByDate = {}, todayDate, anchorDate, daysSinceAnchor }) {
  const loggedDates = Object.keys(qualityByDate).sort();
  const days_logged = loggedDates.length;

  // score_today
  const todayQ = qualityByDate[todayDate];
  const score_today = Number.isFinite(todayQ) ? Math.round(todayQ) : null;

  // score_lifetime — mean of all logged days bounded to [anchor, today]
  let lifetimeSum = 0;
  let lifetimeN = 0;
  for (const d of loggedDates) {
    if (anchorDate && d < anchorDate) continue;
    if (d > todayDate) continue;
    const q = qualityByDate[d];
    if (Number.isFinite(q)) { lifetimeSum += q; lifetimeN++; }
  }
  const score_lifetime = lifetimeN ? Math.round(lifetimeSum / lifetimeN) : null;

  // score_7d_smoothed — mean of last 7 logged days (anchored window)
  const last7 = loggedDates
    .filter((d) => (!anchorDate || d >= anchorDate) && d <= todayDate)
    .slice(-7)
    .map((d) => qualityByDate[d])
    .filter((q) => Number.isFinite(q));
  const score_7d_smoothed = last7.length
    ? Math.round(last7.reduce((a, b) => a + b, 0) / last7.length)
    : null;

  // missed_days = days where anchor <= d <= today and no log
  let missed_days = 0;
  if (anchorDate && daysSinceAnchor > 0) {
    const expected = enumerateDaysFrom(anchorDate, todayDate);
    for (const d of expected) {
      if (!(d in qualityByDate)) missed_days++;
    }
  }

  return {
    score_today,
    score_7d_smoothed,
    score_lifetime,
    missed_days,
    days_logged,
  };
}

module.exports = { computeStandardOutputs };
