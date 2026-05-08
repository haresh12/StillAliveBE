/**
 * anomaly-detector.js
 * Per-agent z-score detection.
 */

const config = require('../config');
const { AGENTS } = require('../adapters/_shape');

const MIN_HIST = config.ANOMALIES.MIN_HISTORY_FOR_DETECTION;
const TH = config.ANOMALIES.SEVERITY_THRESHOLDS;

function detectAnomalies({ snapshots, baselines }) {
  const out = [];
  for (const agent of AGENTS) {
    const snap = snapshots[agent];
    if (!snap || !snap.setup.is_complete) continue;
    if (!snap.today.has_log || !Number.isFinite(snap.today.score)) continue;
    const baseline = baselines[agent];
    if (!baseline || !Number.isFinite(baseline.mean) || baseline.sample_size < MIN_HIST) continue;

    const z = (snap.today.score - baseline.mean) / baseline.std;
    const absZ = Math.abs(z);
    if (absZ < TH.low) continue;

    const severity = absZ >= TH.high ? 'high' : (absZ >= TH.med ? 'med' : 'low');
    const direction = z >= 0 ? 'spike' : 'dip';
    const headline = direction === 'dip'
      ? `${capitalize(agent)} dropped ${Math.round(Math.abs(snap.today.score - baseline.mean))} pts vs your baseline`
      : `${capitalize(agent)} jumped ${Math.round(Math.abs(snap.today.score - baseline.mean))} pts above baseline`;

    out.push({
      agent,
      z_score: Math.round(z * 100) / 100,
      severity,
      direction,
      headline,
      evidence: `Today: ${snap.today.score} · Your usual: ${Math.round(baseline.mean)} (n=${baseline.sample_size})`,
      today_score: snap.today.score,
      baseline_mean: Math.round(baseline.mean * 10) / 10,
      baseline_std: Math.round(baseline.std * 10) / 10,
    });
  }

  // Sort by severity then |z|
  const sevRank = { high: 3, med: 2, low: 1 };
  out.sort((a, b) => sevRank[b.severity] - sevRank[a.severity] || Math.abs(b.z_score) - Math.abs(a.z_score));

  return out;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

module.exports = { detectAnomalies };
