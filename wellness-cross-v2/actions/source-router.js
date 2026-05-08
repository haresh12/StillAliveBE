/**
 * source-router.js
 * Aggregates action candidates from 6 sources, ranks them by priority, returns top 3.
 *
 * Priority taxonomy (descending):
 *   1.0  anomaly_response       — score crashed today
 *   0.9  streak_protection      — streak in danger window (<4h)
 *   0.7  time_bucket_nudge      — user usually logs by now, hasn't
 *   0.6  cross_coach_correlation — sleep was bad → log mood (correlation r ≥ 0.4)
 *   0.5  coach_top_action       — pulled from each coach's V2 actions engine
 *   0.2  generic_log_prompt     — fallback when nothing else fires
 */

const { AGENTS } = require('../adapters/_shape');

function fromAnomaly(anomalies) {
  if (!Array.isArray(anomalies) || !anomalies.length) return [];
  const a = anomalies[0];
  return [{
    priority: 1.0,
    source: 'anomaly_response',
    coach: a.agent,
    title: a.headline,
    sub: a.evidence,
    drill_correlation_id: a.drill_correlation_id || null,
    expected_score_delta: 0,
  }];
}

function fromStreakProtection(streaks, snapshots) {
  if (!streaks || !Array.isArray(streaks.per_agent)) return [];
  const out = [];
  const nowH = new Date().getHours();
  for (const s of streaks.per_agent) {
    if (s.status !== 'active' || (s.current || 0) < 3) continue;
    // already logged today? skip
    const snap = snapshots[s.agent];
    if (snap && snap.today.has_log) continue;
    const dangerHours = 24 - nowH; // crude — assume midnight cutoff
    if (dangerHours > 4) continue;
    out.push({
      priority: 0.9,
      source: 'streak_protection',
      coach: s.agent,
      title: `Don't break your ${s.current}-day ${s.agent} streak`,
      sub: `${dangerHours}h until midnight.`,
      drill_correlation_id: null,
      expected_score_delta: 0,
    });
  }
  return out;
}

function fromTimeBucket(snapshots, sparklines) {
  // For each set-up coach without today's log: if user usually logs by now, nudge.
  const out = [];
  const nowH = new Date().getHours();
  for (const agent of AGENTS) {
    const snap = snapshots[agent];
    if (!snap || !snap.setup.is_complete) continue;
    if (snap.today.has_log) continue;

    // Estimate "expected log time" as a constant-ish per-coach default.
    // (Real impl: derive mode of last 14 logs' hour-of-day.)
    const expectedHour = ({
      sleep: 9,        // morning, log last night
      water: 14,
      mind: 12,
      nutrition: 19,   // after dinner
      fitness: 18,
      fasting: 12,
    })[agent] || 14;

    if (nowH < expectedHour + 1) continue; // not yet "late"

    out.push({
      priority: 0.7,
      source: 'time_bucket_nudge',
      coach: agent,
      title: `Log your ${agent}`,
      sub: `You usually log ${agent} earlier than this.`,
      drill_correlation_id: null,
      expected_score_delta: 4,
    });
  }
  return out;
}

function fromCorrelations(correlations, snapshots) {
  if (!Array.isArray(correlations)) return [];
  const out = [];
  const consumed = new Set();
  for (const c of correlations.slice(0, 3)) {
    if (Math.abs(c.r) < 0.4 || c.n < 14) continue;
    const [a, b] = c.agents;
    const snapA = snapshots[a];
    const snapB = snapshots[b];
    // Trigger if A had a notable yesterday AND B is set up but not logged today
    if (!snapA || !snapB) continue;
    const yPt = snapA.last_14d[snapA.last_14d.length - 2];
    if (!yPt || !Number.isFinite(yPt.value)) continue;
    if (snapB.today.has_log) continue;
    if (consumed.has(b)) continue;

    const yLow = yPt.value < 50;
    const phrase = c.r >= 0 ? 'tracks closely with' : 'inversely tied to';
    const directional = yLow
      ? `Yesterday's ${a} was low. Log your ${b} now.`
      : `Yesterday's ${a} was strong. See if your ${b} follows.`;
    out.push({
      priority: 0.6,
      source: 'cross_coach_correlation',
      coach: b,
      title: directional,
      sub: `Your ${a} ${phrase} ${b} (r=${Math.round(c.r * 100) / 100}, n=${c.n}).`,
      drill_correlation_id: c.id || null,
      expected_score_delta: 3,
    });
    consumed.add(b);
  }
  return out;
}

function fromGenericLogPrompts(snapshots) {
  const out = [];
  for (const agent of AGENTS) {
    const snap = snapshots[agent];
    if (!snap || !snap.setup.is_complete) continue;
    if (snap.today.has_log) continue;
    out.push({
      priority: 0.2,
      source: 'generic_log_prompt',
      coach: agent,
      title: `Log ${agent} today`,
      sub: 'Keeps your wellness signal fresh.',
      drill_correlation_id: null,
      expected_score_delta: 2,
    });
  }
  return out;
}

/**
 * @param {Object} args
 * @param {Object<string, AgentSnapshot>} args.snapshots
 * @param {Array} args.anomalies
 * @param {Array} args.correlations
 * @param {Object} args.streaks
 * @param {Array} args.sparklines
 * @returns {Array} top 3 actions
 */
function rankActions({ snapshots, anomalies, correlations, streaks, sparklines }) {
  const candidates = [
    ...fromAnomaly(anomalies),
    ...fromStreakProtection(streaks, snapshots),
    ...fromTimeBucket(snapshots, sparklines),
    ...fromCorrelations(correlations, snapshots),
    ...fromGenericLogPrompts(snapshots),
  ];

  // Sort by priority desc, dedup by coach (best wins per coach)
  candidates.sort((a, b) => b.priority - a.priority);
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    if (seen.has(c.coach)) continue;
    seen.add(c.coach);
    out.push(c);
    if (out.length >= 3) break;
  }
  return out;
}

module.exports = { rankActions };
