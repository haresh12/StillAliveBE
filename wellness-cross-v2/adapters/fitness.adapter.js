/**
 * Fitness adapter.
 * Reads from wellness_users/{id}/agents/fitness/fitness_workouts.
 * Per-workout doc fields: name, exercises[], total_sets, total_volume_kg, date, logged_at.
 * One doc per workout (a day can have multiple workouts).
 */

const { buildAdapter, daysBetween, dateOf, agentScores } = require('./_helpers');

function sumOf(arr, key) {
  return arr.map((x) => Number(x[key])).filter(Number.isFinite).reduce((a, b) => a + b, 0);
}

function avgOf(arr, key) {
  const vals = arr.map((x) => Number(x[key])).filter(Number.isFinite);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

module.exports = buildAdapter({
  agent: 'fitness',

  async readSetup(deviceId, { agentData }) {
    const completedAt = agentData.setup_completed_at || agentData.created_at || null;
    const today = new Date().toISOString().slice(0, 10);
    const completedDate = dateOf(completedAt);
    return {
      is_complete: !!agentData.setup_complete,
      completed_at: completedAt ? new Date(completedAt._seconds ? completedAt._seconds * 1000 : completedAt).toISOString() : null,
      days_since_setup: completedDate ? Math.max(0, daysBetween(completedDate, today)) : 0,
      config: {
        weekly_session_target: Number(agentData.weekly_session_target || 4),
      },
    };
  },

  scoreDailyLogs(logs) {
    // Aggregate across multiple workouts on one day
    const totalSets = sumOf(logs, 'total_sets');
    const totalVolume = sumOf(logs, 'total_volume_kg');
    const consistency = Math.min(1, logs.length);
    const volume = Math.min(1, totalSets / 20);
    const intensity = Math.min(1, totalVolume / 5000); // 5000kg ≈ a solid session
    const out = agentScores.computeFitnessScore({
      consistency,
      volume,
      progression: 0.5,
      intensity,
      days_logged: logs.length,
    });
    return out && Number.isFinite(out.score) ? out.score : null;
  },

  componentsForToday(logs) {
    return {
      sets: sumOf(logs, 'total_sets'),
      volume_kg: sumOf(logs, 'total_volume_kg'),
      sessions: logs.length,
    };
  },
});
