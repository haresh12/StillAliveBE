/**
 * Sleep adapter.
 * Reads from wellness_users/{id}/agents/sleep/sleep_logs.
 */

const { buildAdapter, daysBetween, dateOf, agentScores, clip } = require('./_helpers');

function avgOf(arr, key) {
  const vals = arr.map((x) => Number(x[key])).filter((v) => Number.isFinite(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

module.exports = buildAdapter({
  agent: 'sleep',

  async readSetup(deviceId, { userData, agentData }) {
    const completedAt = agentData.setup_completed_at || agentData.created_at || null;
    const today = new Date().toISOString().slice(0, 10);
    const completedDate = dateOf(completedAt);
    return {
      is_complete: !!agentData.setup_complete,
      completed_at: completedAt ? new Date(completedAt._seconds ? completedAt._seconds * 1000 : completedAt).toISOString() : null,
      days_since_setup: completedDate ? Math.max(0, daysBetween(completedDate, today)) : 0,
      config: {
        target_hours: Number(agentData.target_hours || agentData.sleep_target_hours || 8),
        bedtime_target: agentData.bedtime_target || null,
        wake_target: agentData.wake_target || null,
      },
    };
  },

  scoreDailyLogs(logs, agentData) {
    const target_hours = Number(agentData.target_hours || 8);
    const sleep_quality = avgOf(logs, 'sleep_quality');
    const total_sleep_hours = avgOf(logs, 'total_sleep_hours');
    const sleep_efficiency = avgOf(logs, 'sleep_efficiency');
    const sleep_latency = avgOf(logs, 'sleep_latency');
    const morning_energy = avgOf(logs, 'morning_energy');
    const night_wakings = avgOf(logs, 'night_wakings');

    const out = agentScores.computeSleepScore({
      avg_duration: total_sleep_hours,
      sleep_debt: Math.max(0, target_hours - (total_sleep_hours || 0)),
      avg_latency: sleep_latency,
      avg_efficiency: sleep_efficiency,
      avg_quality: sleep_quality,
      avg_energy: morning_energy,
      avg_wakings: night_wakings,
      days_logged: logs.length,
      target_hours,
    });
    return out && Number.isFinite(out.score) ? out.score : null;
  },

  componentsForToday(logs, agentData) {
    return {
      duration_h: avgOf(logs, 'total_sleep_hours'),
      quality: avgOf(logs, 'sleep_quality'),
      efficiency: avgOf(logs, 'sleep_efficiency'),
      latency: avgOf(logs, 'sleep_latency'),
      energy: avgOf(logs, 'morning_energy'),
    };
  },

  // Expose bedtime + wake_time per log (last 30 days) for chronotype detection.
  // Insights cross-agent engine reads `recent_bedtimes` to compute chronotype.
  extraFields(logs) {
    const out = [];
    for (const l of logs) {
      const date = l.date || (l.logged_at && l.logged_at._seconds ? new Date(l.logged_at._seconds * 1000).toISOString().slice(0, 10) : null);
      if (!date) continue;
      if (l.bedtime || l.wake_time) {
        out.push({
          date,
          bedtime: typeof l.bedtime === 'string' ? l.bedtime : null,
          wake_time: typeof l.wake_time === 'string' ? l.wake_time : null,
        });
      }
    }
    return { recent_bedtimes: out.slice(-30) };
  },
});
