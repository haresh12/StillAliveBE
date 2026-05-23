/**
 * wellness-cross-v2/adapters/index.js
 *
 * Public entry: getAgentSnapshot, getAllSnapshots.
 */

const { AGENTS, assertAgentSnapshot } = require('./_shape');

const ADAPTERS = {
  sleep: require('./sleep.adapter'),
  mind: require('./mind.adapter'),
  nutrition: require('./nutrition.adapter'),
  fitness: require('./fitness.adapter'),
  water: require('./water.adapter'),
  fasting: require('./fasting.adapter'),
};

async function getAgentSnapshot(agent, deviceId, opts = {}) {
  const fn = ADAPTERS[agent];
  if (!fn) throw new Error(`Unknown agent: ${agent}`);
  const snap = await fn(deviceId, opts);
  if (process.env.NODE_ENV !== 'production') {
    assertAgentSnapshot(snap);
  }
  return snap;
}

async function getAllSnapshots(deviceId, opts = {}) {
  const entries = await Promise.all(
    AGENTS.map(async (agent) => {
      try {
        const snap = await getAgentSnapshot(agent, deviceId, opts);
        return [agent, snap];
      } catch (err) {
        log.error(`[adapters] ${agent} failed:`, err && err.message);
        const { emptyAgentSnapshot } = require('./_shape');

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
        const today = opts.todayDate || _localDateStr();
        return [agent, emptyAgentSnapshot(agent, today)];
      }
    }),
  );
  return Object.fromEntries(entries);
}

module.exports = {
  getAgentSnapshot,
  getAllSnapshots,
  AGENTS,
};
