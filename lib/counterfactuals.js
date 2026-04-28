'use strict';
// ════════════════════════════════════════════════════════════════════
// counterfactuals.js — "what if" cross-agent predictions, no LLM.
// Generates causal-language messages from the personal effect-size table.
// Only fires when n ≥ 10 and personal Cohen's d ≥ 0.4.
// All copy templated; no jargon ever reaches user.
// ════════════════════════════════════════════════════════════════════

const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const stdev = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};

const MIN_N = 10;
const MIN_D = 0.4;

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

// Compute personal mean-difference + d for low-A vs high-A days, comparing B
function personalEffect(ctx, a, b) {
  const logsA = ctx.recent_logs[a] || [];
  const logsB = ctx.recent_logs[b] || [];
  if (logsA.length < MIN_N || logsB.length < MIN_N) return null;

  const valsA = logsA.map(l => primaryValue(a, l)).filter(v => v != null);
  if (valsA.length < MIN_N) return null;
  const median = [...valsA].sort((x, y) => x - y)[Math.floor(valsA.length / 2)];

  const byDateB = Object.fromEntries(logsB.map(l => [l.date, primaryValue(b, l)]));
  const lowB = [], highB = [];
  for (const lA of logsA) {
    const v = primaryValue(a, lA);
    if (v == null) continue;
    const bVal = byDateB[lA.date];
    if (bVal == null) continue;
    if (v < median) lowB.push(bVal); else highB.push(bVal);
  }
  if (lowB.length < 3 || highB.length < 3) return null;

  const ml = mean(lowB), mh = mean(highB);
  const sd = stdev([...lowB, ...highB]);
  if (sd === 0) return null;
  const d = (mh - ml) / sd;
  if (Math.abs(d) < MIN_D) return null;

  return {
    a, b, d: Math.round(d * 100) / 100,
    low_avg_b: Math.round(ml * 10) / 10,
    high_avg_b: Math.round(mh * 10) / 10,
    median_a: Math.round(median * 10) / 10,
    n: lowB.length + highB.length,
  };
}

// Plain-English templates
function counterfactualOf(effect, todayLog) {
  const { a, b, low_avg_b, high_avg_b, median_a } = effect;
  if (!todayLog || primaryValue(a, todayLog) == null) return null;
  const todayA = primaryValue(a, todayLog);
  const wasLow = todayA < median_a;

  // Only show if today's value is on the "leak" side — no point teasing wins
  if (!wasLow) return null;

  const tpl = TEMPLATES[`${a}_${b}`];
  if (!tpl) return null;
  return tpl({ todayA, low_avg_b, high_avg_b });
}

const TEMPLATES = {
  sleep_mind: ({ todayA, low_avg_b, high_avg_b }) => ({
    text: `You slept ${todayA}h last night. On nights you sleep around your usual best, your mood logs ${high_avg_b}/5 — vs the ${low_avg_b}/5 we tend to see after short nights.`,
    action_label: 'Plan tonight\'s sleep',
    agent: 'sleep',
  }),
  sleep_fitness: ({ todayA, low_avg_b, high_avg_b }) => ({
    text: `${todayA}h sleep last night. Your training time on rested days runs ${Math.round(high_avg_b)} min — about ${Math.round(high_avg_b - low_avg_b)} min more than after short nights.`,
    action_label: 'Adjust today\'s session',
    agent: 'fitness',
  }),
  water_mind: ({ todayA, low_avg_b, high_avg_b }) => ({
    text: `Hydration's at ${Math.round(todayA)}ml so far. On well-hydrated days, your mood averages ${high_avg_b}/5 — vs ${low_avg_b}/5 on low-water days.`,
    action_label: 'Log 500ml',
    agent: 'water',
  }),
  fitness_sleep: ({ todayA, low_avg_b, high_avg_b }) => ({
    text: `Light training day (${Math.round(todayA)} min). After heavier sessions you sleep about ${Math.round(high_avg_b - low_avg_b) * 60} more minutes.`,
    action_label: 'Add a short session',
    agent: 'fitness',
  }),
  nutrition_mind: ({ todayA, low_avg_b, high_avg_b }) => ({
    text: `Protein at ${Math.round(todayA)}g today. On well-fueled days, your mood lands at ${high_avg_b}/5 — about ${(high_avg_b - low_avg_b).toFixed(1)} higher than under-fueled days.`,
    action_label: 'Add a protein meal',
    agent: 'nutrition',
  }),
};

// Public: emit at most one counterfactual message
function buildCounterfactual(ctx) {
  const today = todayStr();
  // Try the strongest pair first (sleep→mind is usually #1)
  const pairs = [
    ['sleep', 'mind'], ['water', 'mind'], ['nutrition', 'mind'],
    ['sleep', 'fitness'], ['fitness', 'sleep'],
  ];
  for (const [a, b] of pairs) {
    const eff = personalEffect(ctx, a, b);
    if (!eff) continue;
    const todayLog = (ctx.recent_logs[a] || []).find(l => l.date === today);
    if (!todayLog) continue;
    const cf = counterfactualOf(eff, todayLog);
    if (!cf) continue;
    return {
      id: `cf_${a}_${b}`,
      category: 'pattern', icon: '🔍', priority: 78,
      raw_text: cf.text,
      action: { agent: cf.agent, label: cf.action_label, kind: 'deeplink' },
      evidence_summary: `Comparing your low-${a} days to your high-${a} days for how it shows up in ${b}.`,
      agents_used: [a, b],
    };
  }
  return null;
}

module.exports = { buildCounterfactual, personalEffect };
