'use strict';
// ════════════════════════════════════════════════════════════════════
// anomaly-detector.js — flags days that are statistical outliers
// (>2σ from personal baseline) per agent. These pin the heatmap.
// Citation: NN/g 2021 anomaly-pinned heatmap UX research.
// ════════════════════════════════════════════════════════════════════

const AGENTS = ['fitness', 'sleep', 'mind', 'nutrition', 'water', 'fasting'];

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
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const stdev = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

function detectAnomalies(ctx) {
  const out = [];
  for (const agent of AGENTS) {
    const logs = ctx.recent_logs[agent] || [];
    if (logs.length < 7) continue;
    const vals = logs.map(l => primaryValue(agent, l)).filter(v => v != null);
    if (vals.length < 7) continue;
    const m = mean(vals); const sd = stdev(vals);
    if (sd === 0) continue;
    for (const log of logs) {
      const v = primaryValue(agent, log);
      if (v == null) continue;
      const z = (v - m) / sd;
      if (Math.abs(z) >= 2.0) {
        out.push({
          agent, date: log.date,
          direction: z > 0 ? 'high' : 'low',
          z_score: Math.round(z * 100) / 100,
          value: v,
          baseline: Math.round(m * 10) / 10,
        });
      }
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12);
}

module.exports = { detectAnomalies };
