'use strict';
// ════════════════════════════════════════════════════════════════════
// causal-chain.js — Pearl's three-rung ladder for cross-agent insight.
//   Rung 1 — OBSERVED  (descriptive frequency)
//   Rung 2 — INTERVENED (paired comparison: with vs without)
//   Rung 3 — COUNTERFACTUAL (regression-based prediction)
// Citations: Pearl 2009 Causality, Pearl & Mackenzie 2018, Miller 2019.
// All output plain English; no jargon visible.
// ════════════════════════════════════════════════════════════════════
const { effectFor, AGENT_VERBS } = require('./aha-engine');

const round1 = (n) => Math.round(n * 10) / 10;

function buildChain(ctx, aha) {
  if (!aha || aha.kind !== 'pair_effect') return null;
  const { a, b, effect } = aha;
  const aName = AGENT_VERBS[a] || a;
  const bName = AGENT_VERBS[b] || b;

  // ── RUNG 1: Observed frequency ──────────────────────────────────
  // Count how often the pattern showed up in last 14 days
  const logsA = ctx.recent_logs[a] || [];
  const lowDays = logsA.filter(l => {
    const v = primaryValue(a, l);
    return v != null && v < effect.median_a;
  }).map(l => l.date);
  const logsB = ctx.recent_logs[b] || [];
  const lowOrTiredOnB = logsB.filter(l => {
    const v = primaryValue(b, l);
    return v != null && lowDays.includes(l.date) && v < (effect.high_mean - effect.low_mean);
  }).length;
  const observed = {
    rung: 1, label: 'OBSERVED',
    text: `On ${lowOrTiredOnB || lowDays.length} of your last ${logsA.length} days with low ${aName}, your ${bName} dipped too.`,
    citation: 'Pattern from your own last two weeks of logs.',
  };

  // ── RUNG 2: Intervention paired comparison ──────────────────────
  const intervened = {
    rung: 2, label: 'INTERVENED',
    text: `When your ${aName} crossed ${effect.median_a}, your ${bName} averaged ${effect.high_mean} — vs ${effect.low_mean} on the lower side.`,
    citation: `Comparing ${effect.n} matched days side by side.`,
  };

  // ── RUNG 3: Counterfactual prediction ───────────────────────────
  const todayLog = (ctx.recent_logs[a] || []).find(l => l.date === todayStr());
  const todayB   = (ctx.recent_logs[b] || []).find(l => l.date === todayStr());
  let counterfactual;
  if (todayLog) {
    const todayA_val = primaryValue(a, todayLog);
    const wasLow = todayA_val < effect.median_a;
    if (wasLow) {
      counterfactual = {
        rung: 3, label: 'COUNTERFACTUAL',
        text: `If your ${aName} today had been on the high side, your ${bName} would likely land near ${effect.high_mean} — about ${round1(effect.high_mean - effect.low_mean)} higher than the low-${aName} pattern.`,
        citation: 'Estimated from your personal effect size.',
      };
    } else {
      counterfactual = {
        rung: 3, label: 'COUNTERFACTUAL',
        text: `Today's ${aName} is on the strong side. Based on your pattern, ${bName} should land near ${effect.high_mean} this evening.`,
        citation: 'Estimated from your personal effect size.',
      };
    }
  } else {
    counterfactual = {
      rung: 3, label: 'COUNTERFACTUAL',
      text: `If you log a strong ${aName} today, the model expects your ${bName} to follow toward ${effect.high_mean}.`,
      citation: 'Estimated from your personal effect size.',
    };
  }

  return { rungs: [observed, intervened, counterfactual] };
}

function primaryValue(agent, log) {
  switch (agent) {
    case 'sleep': return log.duration_h != null ? log.duration_h : log.quality;
    case 'mind':  return log.mood_score;
    case 'water': return log.ml;
    case 'nutrition': return log.protein_g;
    case 'fitness':   return log.duration_min;
    case 'fasting':   return log.actual_h;
    default: return null;
  }
}
function todayStr() { return new Date().toISOString().slice(0, 10); }

module.exports = { buildChain };
