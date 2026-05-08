/**
 * Water adapter.
 * Reads from wellness_users/{id}/agents/water/water_logs.
 * Per-log fields: ml, effective_ml, beverage_type, date, logged_at.
 */

const { buildAdapter, daysBetween, dateOf, agentScores } = require('./_helpers');

function sumOf(arr, key) {
  return arr.map((x) => Number(x[key])).filter(Number.isFinite).reduce((a, b) => a + b, 0);
}

module.exports = buildAdapter({
  agent: 'water',

  async readSetup(deviceId, { agentData }) {
    const completedAt = agentData.setup_completed_at || agentData.created_at || null;
    const today = new Date().toISOString().slice(0, 10);
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

  scoreDailyLogs(logs, agentData) {
    const goal = Number(agentData.daily_goal_ml || 2500);
    // Use effective_ml when present (caffeine/alcohol-adjusted by water agent), else raw ml.
    const ml = sumOf(logs, 'effective_ml') || sumOf(logs, 'ml');
    const hydration_adequacy = goal > 0 ? Math.min(1, ml / goal) : 0;
    const out = agentScores.computeWaterScore({
      hydration_adequacy,
      consistency: Math.min(1, logs.length / 4),
      chronobiology: 0.5,
      beverage_quality: 0.7,
      avg_7d_ml: ml,
      days_logged: logs.length,
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
