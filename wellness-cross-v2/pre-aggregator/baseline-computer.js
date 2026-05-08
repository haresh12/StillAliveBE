/**
 * baseline-computer.js
 * Exponentially-weighted personal baselines per agent.
 * Half-life 7 days (algorithm spec §1).
 */

const config = require('../config');

const HALF_LIFE = config.SCORE.BASELINE_HALF_LIFE_DAYS;
const ALPHA = Math.log(2) / HALF_LIFE;
const STD_FLOOR = config.SCORE.EWM_STD_FLOOR;
const MIN_HISTORY = config.SCORE.MIN_HISTORY_FOR_BASELINE;

function ewmStats(daily, todayDate) {
  const todayMs = new Date(todayDate + 'T00:00:00Z').getTime();
  const useable = daily.filter((p) => p.date < todayDate && p.has_log && Number.isFinite(p.score));

  if (useable.length < MIN_HISTORY) {
    return { mean: null, std: null, sample_size: useable.length };
  }

  let sumW = 0;
  let sumWX = 0;
  for (const p of useable) {
    const ms = new Date(p.date + 'T00:00:00Z').getTime();
    const ageDays = (todayMs - ms) / (24 * 60 * 60 * 1000);
    const w = Math.exp(-ALPHA * ageDays);
    sumW += w;
    sumWX += w * p.score;
  }
  const mean = sumWX / sumW;

  let sumWVar = 0;
  for (const p of useable) {
    const ms = new Date(p.date + 'T00:00:00Z').getTime();
    const ageDays = (todayMs - ms) / (24 * 60 * 60 * 1000);
    const w = Math.exp(-ALPHA * ageDays);
    sumWVar += w * (p.score - mean) ** 2;
  }
  const variance = sumWVar / sumW;
  const std = Math.max(Math.sqrt(variance), STD_FLOOR);

  return {
    mean: Math.round(mean * 100) / 100,
    std: Math.round(std * 100) / 100,
    sample_size: useable.length,
  };
}

/**
 * @param {Object<string, AgentSnapshot>} snapshots
 * @param {string} todayDate
 * @returns {Object<string, {mean, std, sample_size}>}
 */
function computeBaselines(snapshots, todayDate) {
  const out = {};
  for (const [agent, snap] of Object.entries(snapshots)) {
    out[agent] = ewmStats(snap.last_14d, todayDate);
  }
  return out;
}

module.exports = { computeBaselines, ewmStats };
