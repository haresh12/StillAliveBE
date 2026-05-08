/**
 * context-pack-builder.js
 * Compresses snapshots → ~10K-token pack ready for the orchestrator.
 *
 * Strategy:
 * - Stable 30-day prefix at the top (cacheable hash)
 * - Last-7-day floating window
 * - Today snapshot
 * - Personal baselines
 * - Profile + setup state
 *
 * Critical fields placed at start AND end (counters Lost-in-the-Middle, Liu 2023).
 */

const crypto = require('crypto');
const config = require('../config');
const { computeBaselines } = require('./baseline-computer');
const { buildDailyMatrix } = require('./daily-matrix');
const { AGENTS } = require('../adapters/_shape');

function hashStablePrefix(obj) {
  const str = JSON.stringify(obj);
  return crypto.createHash('sha1').update(str).digest('hex');
}

/**
 * @param {Object} args
 * @param {Object<string, AgentSnapshot>} args.snapshots
 * @param {Object} args.userData      - root wellness_users doc
 * @param {string} args.todayDate
 * @returns {ContextPack}
 */
function buildContextPack({ snapshots, userData, todayDate }) {
  const { matrix, dates } = buildDailyMatrix(snapshots);
  const baselines = computeBaselines(snapshots, todayDate);

  const setup_state = {};
  let setup_count = 0;
  for (const agent of AGENTS) {
    const isSet = !!(snapshots[agent] && snapshots[agent].setup.is_complete);
    setup_state[agent] = isSet;
    if (isSet) setup_count++;
  }

  const days_active = (() => {
    const created = userData.created_at;
    if (!created) return 0;
    const ms = created._seconds ? created._seconds * 1000 : new Date(created).getTime();
    return Math.max(0, Math.floor((Date.now() - ms) / (24 * 60 * 60 * 1000)));
  })();

  const total_days_logged = matrix.filter((d) =>
    AGENTS.some((a) => d.has_log[a]),
  ).length;

  const profile = {
    device_id: userData.deviceId || userData.device_id,
    name: userData.name || userData.user_name || 'there',
    days_active,
    setup_count,
    setup_state,
    cold_start_anchor: userData.cold_start_anchor || 'none',
    onboarding_answers: userData.onboarding_answers || {},
  };

  const stable_30d = matrix.slice(0, Math.max(0, matrix.length - 7)); // first 23 days
  const last_7d_floating = matrix.slice(-7);

  const todayRow = matrix[matrix.length - 1] || { date: todayDate, scores: {}, has_log: {} };

  const agents_compact = {};
  for (const agent of AGENTS) {
    const snap = snapshots[agent];
    if (!snap) continue;
    agents_compact[agent] = {
      setup: snap.setup,
      score_label: snap.score_label,
      score_components: snap.score_components,
      aggregates_90d: snap.aggregates_90d,
      today: snap.today,
      aha_moments: snap.aha_moments.slice(0, 3),
      signal_points: snap.signal_points.slice(0, 5),
    };
  }

  const stable_prefix_hash = hashStablePrefix({
    profile_setup: setup_state,
    stable_30d,
    aggregates: Object.fromEntries(
      AGENTS.map((a) => [a, snapshots[a] ? snapshots[a].aggregates_90d : null]),
    ),
  });

  const pack = {
    pack_version: config.PACK_SCHEMA_VERSION,
    computed_at: new Date().toISOString(),
    stable_prefix_hash,
    profile,
    agents: agents_compact,
    baselines,
    matrix_dates: dates,
    stable_30d,
    last_7d_floating,
    today: {
      date: todayDate,
      scores: todayRow.scores,
      has_logs: todayRow.has_log,
    },
    summary: {
      total_days_logged,
      setup_count,
      tier: tierFor(total_days_logged, setup_count),
    },
  };

  return pack;
}

function tierFor(days_logged, setup_count) {
  const tiers = [...config.TIERS].sort((a, b) => b.tier - a.tier);
  for (const t of tiers) {
    if (days_logged >= t.min_days_logged && setup_count >= t.min_setup) return t.tier;
  }
  return 0;
}

module.exports = { buildContextPack, tierFor };
