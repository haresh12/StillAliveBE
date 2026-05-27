/**
 * Water adapter.
 * Reads from wellness_users/{id}/agents/water/water_logs.
 * Per-log fields: ml, effective_ml, beverage_type, date, logged_at.
 */

const { buildAdapter, daysBetween, dateOf } = require('./_helpers');
const waterScoring = require('../../lib/water-scoring');

// Local-TZ date key helper — see feedback_chart_tz_clamp law (no UTC keys).
function _localDateStr(d) {
  const dt = d instanceof Date ? d : (d ? new Date(d) : new Date());
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function sumOf(arr, key) {
  return arr.map((x) => Number(x[key])).filter(Number.isFinite).reduce((a, b) => a + b, 0);
}

module.exports = buildAdapter({
  agent: 'water',

  async readSetup(deviceId, { agentData }) {
    const completedAt = agentData.setup_completed_at || agentData.created_at || null;
    const today = _localDateStr();
    const completedDate = dateOf(completedAt);
    return {
      is_complete: !!agentData.setup_complete,
      completed_at: completedAt ? new Date(completedAt._seconds ? completedAt._seconds * 1000 : completedAt).toISOString() : null,
      days_since_setup: completedDate ? Math.max(0, daysBetween(completedDate, today)) : 0,
      config: {
        daily_goal_ml: Number(agentData.daily_goal_ml || 2500),
      },
    };
  },

  // Score ONE day's logs. Routes through lib/water-scoring.js — same lib
  // used by water.agent.js::refreshWaterScore and ::computeHydrationScore so
  // Home + Analysis + Cross-V2 cannot drift (see project_water_scoring_drift_bug).
  //
  // Gate computations adapted to a single-day window:
  //   • hydration_adequacy — % of that day's goal met (capped at 100)
  //   • consistency        — 100 if day hits 80% goal else 0 (binary at single-day)
  //   • chronobiology      — REAL morning/late-taper from this day's logs
  //   • beverage_quality   — REAL water_friendly/effective ratio from this day's logs
  //
  // V3: `daysSinceAnchor` is now resolved by buildAdapter and threaded
  // through — slow canonical maturity ramp applied calendar-keyed, so Home +
  // Analysis return identical numbers for the same day.
  scoreDailyLogs(logs, agentData, daysSinceAnchor = 0) {
    if (!Array.isArray(logs) || logs.length === 0) return null;
    const goal = Number(agentData.daily_goal_ml || 2500);

    // Resolve the day's key from the first log (all logs in this batch share a date).
    const firstDate = logs[0]?.date || (logs[0]?.logged_at ? _localDateStr(new Date(logs[0].logged_at?._seconds ? logs[0].logged_at._seconds * 1000 : logs[0].logged_at)) : _localDateStr());
    const recentKeys = [firstDate];
    const goalByDate = { [firstDate]: goal };

    // Normalize log shape — adapter receives whatever doc shape Firestore returns.
    const normalized = logs.map((l) => ({
      ml: l.ml || l.amount_ml || 0,
      effective_ml: l.effective_ml,
      beverage_type: l.beverage_type || l.drink_type || 'water',
      date: l.date || firstDate,
      logged_at: l.logged_at,
    }));

    const out = waterScoring.computeWaterScore({
      logs: normalized,
      goalByDate,
      recentKeys,
      daysSinceAnchor,
    });
    return out && Number.isFinite(out.score) ? out.score : null;
  },

  componentsForToday(logs, agentData) {
    return {
      total_ml: sumOf(logs, 'ml'),
      effective_ml: sumOf(logs, 'effective_ml') || sumOf(logs, 'ml'),
      goal_ml: Number(agentData.daily_goal_ml || 2500),
      logs: logs.length,
    };
  },
});
