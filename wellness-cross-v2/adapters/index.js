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
        const today = opts.todayDate || new Date().toISOString().slice(0, 10);
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
