/**
 * telemetry.js
 * In-memory ring buffer of LLM call records, flushed to Firestore daily by cron.
 *
 * Phase 10 — daily cost cap circuit breaker. When the running total today
 * exceeds config.COST.MAX_DAILY_TOTAL_USD the circuit opens; subsequent
 * calls receive `circuitOpen() === true` and should fall back to
 * deterministic copy. Resets at UTC midnight.
 */

const config = require('../config');

const MAX_BUFFER = 5000;
const buffer = [];

let _totalToday = 0;
let _todayDate = null;

function _resetIfNewDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== _todayDate) {
    _todayDate = today;
    _totalToday = 0;
  }
}

function record(entry) {
  _resetIfNewDay();
  buffer.push({ ...entry, at: new Date().toISOString() });
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
  if (Number.isFinite(entry && entry.cost_usd)) {
    _totalToday += entry.cost_usd;
  }
}

/**
 * @returns {boolean} true if today's running cost has exceeded the daily cap.
 *   Callers (planner / executor / validator / dyk-writer) MUST short-circuit
 *   to deterministic fallback when this returns true.
 */
function circuitOpen() {
  _resetIfNewDay();
  const cap = (config.COST && config.COST.MAX_DAILY_TOTAL_USD) || Infinity;
  return _totalToday >= cap;
}

function todaySpendUsd() {
  _resetIfNewDay();
  return Math.round(_totalToday * 1e6) / 1e6;
}

function drain() {
  const out = [...buffer];
  buffer.length = 0;
  return out;
}

function summarize(entries) {
  const byRole = {};
  let total_cost = 0;
  let total_calls = 0;
  for (const e of entries) {
    if (!byRole[e.role]) {
      byRole[e.role] = {
        runs: 0, tokens_in: 0, tokens_out: 0, cached_tokens: 0,
        cost_usd: 0, latency_ms_total: 0,
      };
    }
    const b = byRole[e.role];
    b.runs += 1;
    b.tokens_in += e.input_tokens || 0;
    b.tokens_out += e.output_tokens || 0;
    b.cached_tokens += e.cached_tokens || 0;
    b.cost_usd += e.cost_usd || 0;
    b.latency_ms_total += e.latency_ms || 0;
    total_cost += e.cost_usd || 0;
    total_calls += 1;
  }
  for (const k of Object.keys(byRole)) {
    const b = byRole[k];
    b.cost_usd = Math.round(b.cost_usd * 1e6) / 1e6;
    b.avg_latency_ms = b.runs > 0 ? Math.round(b.latency_ms_total / b.runs) : 0;
    b.cache_hit_rate = b.tokens_in > 0 ? Math.round((b.cached_tokens / b.tokens_in) * 100) / 100 : 0;
    delete b.latency_ms_total;
  }
  return {
    total_calls,
    total_cost_usd: Math.round(total_cost * 1e6) / 1e6,
    by_role: byRole,
  };
}

module.exports = { record, drain, summarize, circuitOpen, todaySpendUsd };
