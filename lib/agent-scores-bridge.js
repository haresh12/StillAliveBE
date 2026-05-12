'use strict';
// ═══════════════════════════════════════════════════════════════
// agent-scores-bridge.js — fetches each agent's analysis score directly
// from its existing storage so Home shows the EXACT SAME number the
// agent's own Analysis tab shows. No new computation, no drift.
//
// Each agent's Analysis tab reads a `score` from data computed by that
// agent's `/analysis` route. The score is also persisted on the agent doc
// (`agentData.last_score` or under the score object). We read from there
// directly — fast, deterministic, no recomputation.
//
// Used by: GET /api/wellness/v2/agent-scores/:deviceId
//          → returns { sleep, mind, nutrition, fitness, water, fasting }
//             each as { score: 0-100|null, updated_at }
//
// Day-1 / no data: score = null. Home falls back to setup_count×2 seed
// for that coach, matching the main Wellness Score warm-start formula.
// ═══════════════════════════════════════════════════════════════

const admin = require('firebase-admin');

const db = () => admin.firestore();
const userDoc  = (id) => db().collection('wellness_users').doc(id);
const agentDoc = (id, key) => userDoc(id).collection('agents').doc(key);

// Canonical field every agent writes after refreshScore() on log save:
//   wellness_users/{id}/agents/{agent}.current_score (0-100)
//   wellness_users/{id}/agents/{agent}.score_updated_at
// Legacy shapes kept as fallbacks for backfilled / migrated docs.
const SCORE_READER = (d) => firstFinite(
  d.current_score,
  d.sleep_score && d.sleep_score.score,
  d.mind_score && d.mind_score.score,
  d.nutrition_score && d.nutrition_score.score,
  d.fitness_score && d.fitness_score.score,
  d.water_score && d.water_score.score,
  d.fasting_score && d.fasting_score.score,
  d.score && d.score.score,
  d.last_sleep_score,
  d.last_mind_score,
  d.last_nutrition_score,
  d.last_fitness_score,
  d.last_score,
  d.score,
);
const READERS = {
  sleep: SCORE_READER,
  mind: SCORE_READER,
  nutrition: SCORE_READER,
  fitness: SCORE_READER,
  water: SCORE_READER,
  fasting: SCORE_READER,
};

function firstFinite(...vals) {
  for (const v of vals) {
    if (Number.isFinite(v)) return Math.max(0, Math.min(100, Math.round(v)));
  }
  return null;
}

function toMs(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (Number.isFinite(ts.seconds)) return ts.seconds * 1000;
  if (Number.isFinite(ts._seconds)) return ts._seconds * 1000;
  if (typeof ts === 'number') return ts;
  const t = new Date(ts).getTime();
  return Number.isFinite(t) ? t : null;
}

async function readOne(deviceId, agent) {
  try {
    const snap = await agentDoc(deviceId, agent).get();
    if (!snap.exists) return { agent, score: null, updated_at: null };
    const d = snap.data() || {};
    const reader = READERS[agent];
    const score = reader ? reader(d) : null;
    const updated_at = toMs(
      d.score_updated_at || d.last_score_at || d.analysis_updated_at || d.updated_at
    );
    return { agent, score, updated_at };
  } catch (e) {
    return { agent, score: null, updated_at: null, error: String(e.message || e) };
  }
}

/**
 * Read each agent's persisted analysis score in parallel.
 * Returns { sleep, mind, nutrition, fitness, water, fasting } where each
 * value is { score: 0-100 | null, updated_at: ms | null }.
 */
async function readAllAgentScores(deviceId) {
  const agents = ['sleep', 'mind', 'nutrition', 'fitness', 'water', 'fasting'];
  const results = await Promise.all(agents.map((a) => readOne(deviceId, a)));
  const out = {};
  for (const r of results) out[r.agent] = { score: r.score, updated_at: r.updated_at };
  return out;
}

module.exports = { readAllAgentScores };
