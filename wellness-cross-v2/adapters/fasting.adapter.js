/**
 * Fasting adapter.
 * Reads from wellness_users/{id}/agents/fasting/fasting_sessions.
 * Per-session: started_at, ended_at, actual_hours, target_hours, completed, broken_early.
 * Sessions are ordered by started_at (not logged_at) — adapter helper handles both.
 */

const { buildAdapter, daysBetween, dateOf, agentScores } = require('./_helpers');

// Local-TZ date key helper — never _localDateStr(use) which
// returns UTC and silently maps near-midnight logs to the wrong day in
// negative-UTC offsets (Americas). See feedback_chart_tz_clamp law.
function _localDateStr(d) {
  const dt = d instanceof Date ? d : (d ? new Date(d) : new Date());
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function maxOf(arr, key) {
  const vals = arr.map((x) => Number(x[key])).filter(Number.isFinite);
  return vals.length ? Math.max(...vals) : null;
}

module.exports = buildAdapter({
  agent: 'fasting',

  async readSetup(deviceId, { agentData }) {
    const completedAt = agentData.setup_completed_at || agentData.created_at || null;
    const today = _localDateStr();
    const completedDate = dateOf(completedAt);
    return {
      is_complete: !!agentData.setup_complete,
      completed_at: completedAt ? new Date(completedAt._seconds ? completedAt._seconds * 1000 : completedAt).toISOString() : null,
      days_since_setup: completedDate ? Math.max(0, daysBetween(completedDate, today)) : 0,
      config: {
        target_hours: Number(agentData.target_hours || 16),
        protocol: agentData.protocol || '16:8',
      },
    };
  },

  scoreDailyLogs(logs, agentData) {
    const target = Number(agentData.target_hours || 16);
    // Use the longest completed fast that day (actual_hours from session/end)
    const actualHours = maxOf(logs, 'actual_hours') || 0;
    const completion = target > 0 ? Math.min(1.2, actualHours / target) : 0;
    // Penalize broken_early but don't zero out
    const anyBrokenEarly = logs.some((l) => l.broken_early === true);
    const out = agentScores.computeFastingScore({
      avg_duration: actualHours,
      target_hours: target,
      completion_rate: anyBrokenEarly ? completion * 0.85 : completion,
      streak: 0,
      consistency: Math.min(1, logs.length),
      days_logged: logs.length,
    });
    return out && Number.isFinite(out.score) ? out.score : null;
  },

  componentsForToday(logs, agentData) {
    return {
      actual_hours: maxOf(logs, 'actual_hours') || 0,
      target_hours: Number(agentData.target_hours || 16),
      completed: logs.some((l) => l.completed === true),
      broken_early: logs.some((l) => l.broken_early === true),
    };
  },
});
