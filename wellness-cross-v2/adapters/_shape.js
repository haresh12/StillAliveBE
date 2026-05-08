/**
 * wellness-cross-v2/adapters/_shape.js
 *
 * The canonical AgentSnapshot shape. Every agent adapter MUST return this.
 * Downstream consumers (pre-aggregator, score engine, correlations) read only this shape.
 *
 * Single source of truth for what "an agent's daily picture" looks like.
 */

/**
 * @typedef {('sleep'|'mind'|'nutrition'|'fitness'|'water'|'fasting')} AgentName
 */

/**
 * @typedef {Object} DailyPoint
 * @property {string} date           - 'YYYY-MM-DD'
 * @property {number|null} score     - 0..100, or null if no log that day
 * @property {boolean} has_log       - did the user log on this date?
 * @property {Object} [signals]      - optional per-agent extras (e.g., sleep.duration_h)
 */

/**
 * @typedef {Object} AgentSnapshot
 *
 * @property {AgentName} agent
 *
 * @property {Object} setup
 * @property {boolean} setup.is_complete
 * @property {string|null} setup.completed_at      - ISO timestamp
 * @property {number} setup.days_since_setup       - integer; 0 if not setup
 * @property {Object} setup.config                 - per-agent setup config (target_hours, daily_goal_ml, etc.)
 *
 * @property {Object} today
 * @property {string} today.date                   - 'YYYY-MM-DD' (the device's local today)
 * @property {boolean} today.has_log
 * @property {number|null} today.score             - 0..100
 * @property {Object} today.components             - the agent's own sub-scores (e.g., sleep.efficiency)
 *
 * @property {DailyPoint[]} last_14d               - ordered oldest→newest, length always 14
 * @property {DailyPoint[]} last_30d               - ordered oldest→newest, length always 30
 *
 * @property {Object} aggregates_90d
 * @property {number|null} aggregates_90d.avg_score
 * @property {number|null} aggregates_90d.std_dev
 * @property {number|null} aggregates_90d.best_day_score
 * @property {string|null} aggregates_90d.best_day_date
 * @property {number|null} aggregates_90d.worst_day_score
 * @property {string|null} aggregates_90d.worst_day_date
 * @property {number} aggregates_90d.days_with_log
 *
 * @property {Object[]} aha_moments                - from agent's existing /analysis/v2
 * @property {Object[]} signal_points              - from agent's existing /analysis/v2
 *
 * @property {Object} score_components             - latest score breakdown (from agents/{agent} doc)
 * @property {string} score_label
 * @property {string|null} score_updated_at
 *
 * @property {Object} meta
 * @property {string} meta.adapter_version         - e.g., '2.0.0'
 * @property {string} meta.fetched_at              - ISO timestamp
 * @property {boolean} meta.read_only_verified     - assertion that no writes occurred
 */

/**
 * Returns an empty AgentSnapshot for a user with no setup / no data.
 * Used by adapters as their "default" return when data is missing.
 *
 * @param {AgentName} agent
 * @param {string} todayDate - 'YYYY-MM-DD'
 * @returns {AgentSnapshot}
 */
function emptyAgentSnapshot(agent, todayDate) {
  const last14d = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(todayDate + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - (13 - i));
    return {
      date: d.toISOString().slice(0, 10),
      score: null,
      has_log: false,
    };
  });

  const last30d = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(todayDate + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - (29 - i));
    return {
      date: d.toISOString().slice(0, 10),
      score: null,
      has_log: false,
    };
  });

  const last90d = Array.from({ length: 90 }, (_, i) => {
    const d = new Date(todayDate + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - (89 - i));
    return {
      date: d.toISOString().slice(0, 10),
      score: null,
      has_log: false,
    };
  });

  const log_counts_by_date = {};
  for (const p of last90d) log_counts_by_date[p.date] = 0;

  return {
    agent,
    setup: {
      is_complete: false,
      completed_at: null,
      days_since_setup: 0,
      config: {},
    },
    today: {
      date: todayDate,
      has_log: false,
      score: null,
      components: {},
    },
    last_14d: last14d,
    last_30d: last30d,
    last_90d: last90d,
    log_counts_by_date,
    aggregates_90d: {
      avg_score: null,
      std_dev: null,
      best_day_score: null,
      best_day_date: null,
      worst_day_score: null,
      worst_day_date: null,
      days_with_log: 0,
    },
    aha_moments: [],
    signal_points: [],
    score_components: {},
    score_label: 'no_data',
    score_updated_at: null,
    meta: {
      adapter_version: '2.0.0',
      fetched_at: new Date().toISOString(),
      read_only_verified: true,
    },
  };
}

/**
 * Lightweight runtime check that an object matches the AgentSnapshot shape.
 * Throws on the first mismatch. Used in adapter unit tests.
 *
 * @param {*} snap
 * @throws if shape invalid
 */
function assertAgentSnapshot(snap) {
  const required = [
    'agent', 'setup', 'today', 'last_14d', 'last_30d',
    'aggregates_90d', 'aha_moments', 'signal_points',
    'score_components', 'score_label', 'meta',
  ];
  for (const k of required) {
    if (!(k in snap)) {
      throw new Error(`AgentSnapshot missing required field: ${k}`);
    }
  }
  const validAgents = ['sleep', 'mind', 'nutrition', 'fitness', 'water', 'fasting'];
  if (!validAgents.includes(snap.agent)) {
    throw new Error(`AgentSnapshot.agent invalid: ${snap.agent}`);
  }
  if (!Array.isArray(snap.last_14d) || snap.last_14d.length !== 14) {
    throw new Error('AgentSnapshot.last_14d must be array of length 14');
  }
  if (!Array.isArray(snap.last_30d) || snap.last_30d.length !== 30) {
    throw new Error('AgentSnapshot.last_30d must be array of length 30');
  }
  if (snap.meta.read_only_verified !== true) {
    throw new Error('AgentSnapshot.meta.read_only_verified must be true');
  }
}

module.exports = {
  emptyAgentSnapshot,
  assertAgentSnapshot,
  AGENTS: ['sleep', 'mind', 'nutrition', 'fitness', 'water', 'fasting'],
};
