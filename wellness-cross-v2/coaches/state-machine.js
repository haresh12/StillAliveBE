/**
 * state-machine.js
 * Per-coach explicit state for Home rendering.
 * Output is added to home_pack.coach_states[].
 */

const { AGENTS } = require('../adapters/_shape');
const { smoothPoints } = require('./sparkline-smoother');
const { trendSlope } = require('./trend-slope');

/**
 * @param {Object<string, AgentSnapshot>} snapshots
 * @returns {Array<{
 *   agent: string,
 *   state: 'no_setup'|'no_log_today'|'logged_today',
 *   score_today: number|null,
 *   score_smoothed_7d: number|null,
 *   delta_vs_7d_prior: number,
 *   trend_slope_per_day: number,
 *   primary_metric: { label, value, unit } | null,
 *   streak_days: number,
 *   last_log_date: string|null
 * }>}
 */
function buildCoachStates(snapshots) {
  return AGENTS.map((agent) => {
    const snap = snapshots[agent];
    if (!snap) return null;

    const isSetup = !!snap.setup.is_complete;
    const todayScore = snap.today.has_log ? snap.today.score : null;
    const points = snap.last_14d || [];

    // Smooth display points (kept here — caller can swap raw or smoothed)
    const smoothed = smoothPoints(points);

    // 7-day rolling average for "score_smoothed_7d"
    const last7 = smoothed.slice(-7).filter((p) => Number.isFinite(p.value));
    const smoothed7d = last7.length
      ? Math.round(last7.reduce((a, b) => a + b.value, 0) / last7.length)
      : null;

    // Delta: avg(last 7) − avg(prior 7)
    const prior7 = smoothed.slice(-14, -7).filter((p) => Number.isFinite(p.value));
    const deltaVs7d = (smoothed7d != null && prior7.length)
      ? Math.round(smoothed7d - (prior7.reduce((a, b) => a + b.value, 0) / prior7.length))
      : 0;

    // Trend slope (pts/day) over last 14
    const slope = trendSlope(smoothed);

    // Primary metric preview from today's components
    const primary = primaryMetric(agent, snap);

    let state = 'no_setup';
    if (isSetup && Number.isFinite(todayScore)) state = 'logged_today';
    else if (isSetup) state = 'no_log_today';

    // Status band — same mapping the main Wellness Score uses, so coach cards
    // and the central dial share visual language. Critical for "every score
    // means the same thing across surfaces".
    const status_band = statusBandForScore(smoothed7d);

    return {
      agent,
      state,
      score_today: Number.isFinite(todayScore) ? Math.round(todayScore) : null,
      score_smoothed_7d: smoothed7d,
      status_band,
      delta_vs_7d_prior: deltaVs7d,
      trend_slope_per_day: slope,
      primary_metric: primary,
      streak_days: 0, // filled by streaks engine
      last_log_date: lastLogDate(points),
    };
  }).filter(Boolean);
}

// Canonical mapping. ALSO used by Home Wellness Score Gauge (FE mirrors this).
// Keep in lockstep with statusFor() in WellnessScoreGauge.js.
function statusBandForScore(score) {
  if (!Number.isFinite(score)) return 'idle';
  if (score >= 80) return 'thriving';
  if (score >= 65) return 'strong';
  if (score >= 50) return 'steady';
  if (score >= 30) return 'building';
  if (score >= 1)  return 'starting';
  return 'idle';
}

function primaryMetric(agent, snap) {
  const c = snap.today.components || {};
  switch (agent) {
    case 'sleep':
      return Number.isFinite(c.duration_h)
        ? { label: 'Slept', value: round1(c.duration_h), unit: 'h' }
        : null;
    case 'mind':
      return Number.isFinite(c.mood_score)
        ? { label: 'Mood', value: round1(c.mood_score), unit: '/3' }
        : null;
    case 'nutrition':
      return Number.isFinite(c.protein)
        ? { label: 'Protein', value: Math.round(c.protein), unit: 'g' }
        : Number.isFinite(c.calories)
          ? { label: 'Cal', value: Math.round(c.calories), unit: '' }
          : null;
    case 'fitness':
      return Number.isFinite(c.sets)
        ? { label: 'Sets', value: Math.round(c.sets), unit: '' }
        : null;
    case 'water':
      return Number.isFinite(c.total_ml)
        ? { label: 'Water', value: Math.round(c.total_ml / 100) / 10, unit: 'L' }
        : null;
    case 'fasting':
      return Number.isFinite(c.actual_hours)
        ? { label: 'Fast', value: round1(c.actual_hours), unit: 'h' }
        : null;
    default:
      return null;
  }
}

function round1(v) { return Math.round(v * 10) / 10; }

function lastLogDate(points) {
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].has_log) return points[i].date;
  }
  return null;
}

module.exports = { buildCoachStates };
