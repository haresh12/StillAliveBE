'use strict';
// ════════════════════════════════════════════════════════════════════
// cross-viz-engine.js — produces the data shapes for the 5 cross-agent
// visualizations on the Insights tab:
//   1. Hex Radar       — today vs 28-day baseline per agent
//   2. Stacked Sparks  — 28-day shared-axis matrix
//   3. Chord Matrix    — 15 pairwise Pearson r with significance
//   4. Calendar Heatmap— 28 cells with anomaly glyphs
//   5. Connected Scatter pair — top correlated pair w/ 14-day trail
// ════════════════════════════════════════════════════════════════════

const AGENTS = ['fitness', 'sleep', 'mind', 'nutrition', 'water', 'fasting'];

const todayStr = () => new Date().toISOString().slice(0, 10);
const dateStr = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return d.toISOString().slice(0, 10);
};
const round = (n, p = 2) => { const k = 10 ** p; return Math.round(n * k) / k; };
const mean  = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const stdev = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

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
function normalize(agent, value) {
  if (value == null) return null;
  switch (agent) {
    case 'sleep':     return Math.max(0, Math.min(100, (value / 9) * 100));
    case 'mind':      return Math.max(0, Math.min(100, (value / 5) * 100));
    case 'water':     return Math.max(0, Math.min(100, (value / 2500) * 100));
    case 'nutrition': return Math.max(0, Math.min(100, (value / 130) * 100));
    case 'fitness':   return Math.max(0, Math.min(100, (value / 60) * 100));
    case 'fasting':   return Math.max(0, Math.min(100, (value / 16) * 100));
    default: return null;
  }
}

// ─── 1. HEX RADAR DATA ─────────────────────────────────────────────
function buildRadar(ctx) {
  const out = [];
  for (const agent of AGENTS) {
    const logs = ctx.recent_logs?.[agent] || [];
    const today = logs.find(l => l.date === todayStr());
    const last28 = logs.slice(0, 28);
    const todayNorm = today ? normalize(agent, primaryValue(agent, today)) : null;
    const baselineVals = last28.map(l => normalize(agent, primaryValue(agent, l))).filter(v => v != null);
    out.push({
      agent,
      today_score: todayNorm,
      baseline_score: baselineVals.length ? round(mean(baselineVals)) : null,
      sample_n: baselineVals.length,
    });
  }
  return out;
}

// ─── 2. STACKED SPARKS — 28-day matrix on shared x-axis ────────────
function buildSparkMatrix(ctx) {
  const out = {};
  for (const agent of AGENTS) {
    const logs = ctx.recent_logs?.[agent] || [];
    const map = {};
    logs.forEach(l => { if (l.date) map[l.date] = normalize(agent, primaryValue(agent, l)); });
    const series = [];
    for (let i = 27; i >= 0; i--) {
      const d = dateStr(i);
      series.push({ date: d, value: map[d] != null ? Math.round(map[d]) : null });
    }
    out[agent] = series;
  }
  return out;
}

// ─── 3. CHORD MATRIX — pairwise Pearson r ──────────────────────────
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 4) return null;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  const d = Math.sqrt(dx2 * dy2);
  return d === 0 ? null : num / d;
}
function buildChord(ctx) {
  const matrix = {};
  for (const a of AGENTS) {
    matrix[a] = {};
    for (const b of AGENTS) matrix[a][b] = null;
  }
  const dailyOf = (agent) => {
    const logs = ctx.recent_logs?.[agent] || [];
    const map = {};
    logs.forEach(l => { if (l.date) map[l.date] = primaryValue(agent, l); });
    return map;
  };
  const maps = Object.fromEntries(AGENTS.map(a => [a, dailyOf(a)]));
  const edges = [];
  for (let i = 0; i < AGENTS.length; i++) {
    for (let j = i + 1; j < AGENTS.length; j++) {
      const a = AGENTS[i], b = AGENTS[j];
      const xs = [], ys = [];
      for (const date of Object.keys(maps[a])) {
        if (maps[b][date] != null && maps[a][date] != null) {
          xs.push(maps[a][date]); ys.push(maps[b][date]);
        }
      }
      const r = pearson(xs, ys);
      if (r == null || isNaN(r)) continue;
      matrix[a][b] = round(r, 2);
      matrix[b][a] = round(r, 2);
      if (Math.abs(r) >= 0.20 && xs.length >= 3) {
        edges.push({ a, b, r: round(r, 2), n: xs.length });
      }
    }
  }
  edges.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
  return { matrix, edges: edges.slice(0, 8) };
}

// ─── 4. CALENDAR HEATMAP — 28 cells with anomaly glyphs ────────────
function buildCalendar(ctx) {
  const cells = [];
  for (let i = 27; i >= 0; i--) {
    const d = dateStr(i);
    let any = 0, n = 0;
    let dominantAgent = null, dominantVal = -1;
    const dayLogs = {};
    for (const agent of AGENTS) {
      const log = (ctx.recent_logs?.[agent] || []).find(l => l.date === d);
      if (!log) continue;
      const v = normalize(agent, primaryValue(agent, log));
      if (v == null) continue;
      dayLogs[agent] = v;
      any += v; n++;
      if (v > dominantVal) { dominantVal = v; dominantAgent = agent; }
    }
    const score = n > 0 ? Math.round(any / n) : null;
    // Find anomalies (z-score > 1.8) as glyph trigger
    const glyphs = [];
    for (const [agent, v] of Object.entries(dayLogs)) {
      const series = (ctx.recent_logs?.[agent] || []).slice(0, 28).map(l => normalize(agent, primaryValue(agent, l))).filter(x => x != null);
      if (series.length < 7) continue;
      const m = mean(series), sd = stdev(series);
      if (sd === 0) continue;
      const z = (v - m) / sd;
      if (Math.abs(z) >= 1.8) glyphs.push({ agent, direction: z > 0 ? 'high' : 'low' });
    }
    cells.push({ date: d, score, glyph_count: glyphs.length, glyphs: glyphs.slice(0, 2), dominant_agent: dominantAgent });
  }
  return cells;
}

// ─── 5. TOP CONNECTED SCATTER PAIR ─────────────────────────────────
function buildScatterPair(ctx, chord) {
  const top = chord?.edges?.[0];
  if (!top) return null;
  const a = top.a, b = top.b;
  const aLogs = ctx.recent_logs?.[a] || [];
  const bLogs = ctx.recent_logs?.[b] || [];
  const aMap = Object.fromEntries(aLogs.map(l => [l.date, primaryValue(a, l)]));
  const bMap = Object.fromEntries(bLogs.map(l => [l.date, primaryValue(b, l)]));
  const trail = [];
  for (let i = 13; i >= 0; i--) {
    const d = dateStr(i);
    if (aMap[d] != null && bMap[d] != null) {
      trail.push({ date: d, x: aMap[d], y: bMap[d] });
    }
  }
  return { a, b, r: top.r, n: top.n, trail };
}

// PUBLIC
function buildVizPayload(ctx) {
  const radar    = buildRadar(ctx);
  const spark    = buildSparkMatrix(ctx);
  const chord    = buildChord(ctx);
  const calendar = buildCalendar(ctx);
  const scatter  = buildScatterPair(ctx, chord);
  return { radar, spark, chord, calendar, scatter };
}

module.exports = { buildVizPayload, AGENTS };
