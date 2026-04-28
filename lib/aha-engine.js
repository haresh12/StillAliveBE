'use strict';
// ════════════════════════════════════════════════════════════════════
// aha-engine.js — picks THE single biggest pattern this week.
// Ranks by effect-size × recency × actionability × novelty.
// Citations: Cohen 1988, Miller 2019, Nahum-Shani 2018.
// ════════════════════════════════════════════════════════════════════

const AGENTS = ['fitness', 'sleep', 'mind', 'nutrition', 'water', 'fasting'];
const todayStr = () => new Date().toISOString().slice(0, 10);

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
const mean  = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const stdev = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const round = (n, p = 2) => { const k = 10 ** p; return Math.round(n * k) / k; };

// Compute personal effect (Cohen's d) for a→b paired comparison
function effectFor(ctx, a, b) {
  const logsA = ctx.recent_logs[a] || [];
  const logsB = ctx.recent_logs[b] || [];
  if (logsA.length < 7 || logsB.length < 5) return null;
  const valsA = logsA.map(l => primaryValue(a, l)).filter(v => v != null);
  if (valsA.length < 7) return null;
  const median = [...valsA].sort((x, y) => x - y)[Math.floor(valsA.length / 2)];
  const byB = Object.fromEntries(logsB.map(l => [l.date, primaryValue(b, l)]));
  const lowB = [], highB = [];
  for (const lA of logsA) {
    const v = primaryValue(a, lA); const bV = byB[lA.date];
    if (v == null || bV == null) continue;
    (v < median ? lowB : highB).push(bV);
  }
  if (lowB.length < 3 || highB.length < 3) return null;
  const ml = mean(lowB), mh = mean(highB);
  const sd = stdev([...lowB, ...highB]);
  if (sd === 0) return null;
  const d = (mh - ml) / sd;
  return {
    a, b, d: round(d, 2),
    low_mean: round(ml, 1), high_mean: round(mh, 1),
    median_a: round(median, 1),
    n: lowB.length + highB.length,
    direction: d >= 0 ? 'lifts' : 'drags down',
  };
}

// PUBLIC: pick the single biggest AHA
function pickWeeklyAha(ctx, recentlyShownIds = []) {
  const candidates = [];

  // Primary: cross-agent paired effects
  const pairs = [
    ['sleep', 'mind'], ['sleep', 'fitness'], ['water', 'mind'],
    ['nutrition', 'mind'], ['fitness', 'sleep'], ['fitness', 'mind'],
    ['fasting', 'mind'], ['water', 'fitness'],
  ];
  for (const [a, b] of pairs) {
    const eff = effectFor(ctx, a, b);
    if (!eff) continue;
    if (Math.abs(eff.d) < 0.4) continue;
    const id = `aha_${a}_${b}`;
    if (recentlyShownIds.includes(id)) continue;
    candidates.push({
      id,
      kind: 'pair_effect',
      a, b,
      effect: eff,
      // Score: |d| × recency-bonus × actionability
      score: Math.abs(eff.d) * 1.0 + (eff.n >= 14 ? 0.1 : 0) + 0.05,
    });
  }

  if (!candidates.length) return null;

  candidates.sort((x, y) => y.score - x.score);
  const top = candidates[0];

  // Build the headline (templated, no LLM yet)
  const headline = topHeadline(top);
  return {
    ...top,
    headline,
  };
}

function topHeadline(cand) {
  if (cand.kind !== 'pair_effect') return '';
  const { a, b, effect } = cand;
  const verb = effect.direction; // "lifts" or "drags down"
  const aName = AGENT_VERBS[a] || a;
  const bName = AGENT_VERBS[b] || b;
  const strength = Math.abs(effect.d) >= 0.7 ? 'strongly' : Math.abs(effect.d) >= 0.5 ? 'clearly' : 'measurably';
  return `Your ${aName} ${strength} ${verb} your ${bName}.`;
}

const AGENT_VERBS = {
  sleep: 'sleep', mind: 'mood', water: 'hydration',
  nutrition: 'eating', fitness: 'training', fasting: 'fasting',
};

module.exports = { pickWeeklyAha, effectFor, AGENT_VERBS };
