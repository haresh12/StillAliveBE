/**
 * Mind adapter.
 * Reads from wellness_users/{id}/agents/mind/mind_checkins.
 * Per-checkin fields: mood_score (0..3), anxiety (0..5), emotions[], triggers[], date_str.
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

function avgOf(arr, key) {
  const vals = arr.map((x) => Number(x[key])).filter((v) => Number.isFinite(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

module.exports = buildAdapter({
  agent: 'mind',

  async readSetup(deviceId, { agentData }) {
    const completedAt = agentData.setup_completed_at || agentData.created_at || null;
    const today = _localDateStr();
    const completedDate = dateOf(completedAt);
    return {
      is_complete: !!agentData.setup_complete,
      completed_at: completedAt ? new Date(completedAt._seconds ? completedAt._seconds * 1000 : completedAt).toISOString() : null,
      days_since_setup: completedDate ? Math.max(0, daysBetween(completedDate, today)) : 0,
      config: {
        anchor: agentData.anchor || 'mood',
      },
    };
  },

  scoreDailyLogs(logs) {
    // Mind stores categorical mood mapped to mood_score 0..3 — convert to 0..4 scale
    const mood = avgOf(logs, 'mood_score');
    const anxiety = avgOf(logs, 'anxiety');
    const moodScaled = Number.isFinite(mood) ? (mood / 3) * 4 : null;
    const out = agentScores.computeMindScore({
      avg_mood: moodScaled,
      avg_anxiety: anxiety,
      days_logged: logs.length,
      checkins_today: logs.length,
    });
    return out && Number.isFinite(out.score) ? out.score : null;
  },

  componentsForToday(logs) {
    return {
      mood_score: avgOf(logs, 'mood_score'),
      anxiety: avgOf(logs, 'anxiety'),
      checkins: logs.length,
    };
  },
});
