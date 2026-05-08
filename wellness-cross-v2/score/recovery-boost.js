/**
 * recovery-boost.js
 * Lets a user "earn back" momentum after a bad day.
 *
 * Rule: if today's score >= 70 AND yesterday's was < 50, today's display gets +5%.
 * Capped at +5pts. Symmetric not applied (we don't penalize good→bad swings the same way).
 */

const MAX_BOOST_PTS = 5;

function applyRecoveryBoost(displayedScore, recentDailyHistory) {
  if (!Number.isFinite(displayedScore)) return { score: displayedScore, applied: false, boost: 0 };
  if (!Array.isArray(recentDailyHistory) || recentDailyHistory.length < 1) {
    return { score: displayedScore, applied: false, boost: 0 };
  }
  const yesterday = recentDailyHistory[recentDailyHistory.length - 1];
  if (!Number.isFinite(yesterday)) return { score: displayedScore, applied: false, boost: 0 };

  if (displayedScore >= 70 && yesterday < 50) {
    const boost = Math.min(MAX_BOOST_PTS, Math.round(displayedScore * 0.05));
    return { score: displayedScore + boost, applied: true, boost };
  }
  return { score: displayedScore, applied: false, boost: 0 };
}

module.exports = { applyRecoveryBoost, MAX_BOOST_PTS };
