'use strict';
// ════════════════════════════════════════════════════════════════════
// timeline-engine.js — picks the most important moments across all 6
// agents and assembles them into a single chronological story.
//
// Categories:
//   • PR / personal record (fitness)
//   • Anomaly day (any agent z>2)
//   • Streak milestone (sleep streak, fasting streak, fitness streak)
//   • Hypothesis confirmed/rejected (cross-agent)
//   • Best day / Worst day (composite score)
//   • Setup milestone (first agent set up, all 6 set up)
//   • Action breakthrough (week the user crossed 80% completion)
//   • Cross-agent moment (chord edge confirmed)
// ════════════════════════════════════════════════════════════════════

const AGENTS = ['fitness', 'sleep', 'mind', 'nutrition', 'water', 'fasting'];

const todayStr = () => new Date().toISOString().slice(0, 10);
const round = (n, p = 1) => { const k = 10 ** p; return Math.round(n * k) / k; };
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
function valueLabel(agent, value) {
  if (value == null) return '—';
  switch (agent) {
    case 'sleep': return `${round(value, 1)}h`;
    case 'mind':  return `${round(value, 1)}/5`;
    case 'water': return `${Math.round(value)}ml`;
    case 'nutrition': return `${Math.round(value)}g protein`;
    case 'fitness':   return `${Math.round(value)} min`;
    case 'fasting':   return `${round(value, 1)}h`;
    default: return String(value);
  }
}

// Each event: { date, kind, agent, headline, body, magnitude, evidence }
// magnitude (0-100) drives ranking when overflow

function det01_personalBest(ctx) {
  const events = [];
  for (const agent of AGENTS) {
    const logs = ctx.recent_logs?.[agent] || [];
    if (logs.length < 5) continue;
    const valsWithDate = logs.map(l => ({ date: l.date, v: primaryValue(agent, l) })).filter(x => x.v != null);
    if (!valsWithDate.length) continue;
    const max = valsWithDate.reduce((b, x) => x.v > b.v ? x : b);
    // Only fire if max is in last 14 days AND clearly above the rest
    const others = valsWithDate.filter(x => x.date !== max.date).map(x => x.v);
    if (!others.length) continue;
    const m = mean(others), sd = stdev(others);
    if (sd === 0) continue;
    const z = (max.v - m) / sd;
    if (z < 1.5) continue;
    const dateMs = new Date(max.date).getTime();
    if (Date.now() - dateMs > 14 * 86400000) continue;
    events.push({
      date: max.date,
      kind: 'personal_best',
      agent,
      headline: `Personal best in ${capitalize(agent)}`,
      body: `${valueLabel(agent, max.v)} — your highest in this 28-day window.`,
      magnitude: Math.min(100, 50 + z * 10),
      evidence: { agents: [agent], confidence: 0.85 },
    });
  }
  return events;
}

function det02_anomalyDay(ctx) {
  const events = [];
  for (const agent of AGENTS) {
    const logs = ctx.recent_logs?.[agent] || [];
    if (logs.length < 7) continue;
    const valsWithDate = logs.map(l => ({ date: l.date, v: primaryValue(agent, l) })).filter(x => x.v != null);
    if (valsWithDate.length < 7) continue;
    const m = mean(valsWithDate.map(x => x.v));
    const sd = stdev(valsWithDate.map(x => x.v));
    if (sd === 0) continue;
    for (const { date, v } of valsWithDate.slice(0, 14)) {
      const z = (v - m) / sd;
      if (Math.abs(z) >= 2) {
        events.push({
          date,
          kind: 'anomaly',
          agent,
          headline: z > 0 ? `${capitalize(agent)} stood out` : `${capitalize(agent)} dipped`,
          body: `${valueLabel(agent, v)} vs ~${valueLabel(agent, m)} usual.`,
          magnitude: Math.min(100, 40 + Math.abs(z) * 8),
          evidence: { agents: [agent], confidence: 0.7 },
        });
      }
    }
  }
  return events;
}

function det03_streakMilestone(ctx) {
  const events = [];
  // Cross-agent streak: # of consecutive days with at least one log
  const allDates = new Set();
  for (const agent of AGENTS) {
    for (const l of (ctx.recent_logs?.[agent] || [])) {
      if (l.date) allDates.add(l.date);
    }
  }
  let streak = 0;
  let streakEnd = null;
  for (let i = 0; i < 90; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const ds = d.toISOString().slice(0, 10);
    if (allDates.has(ds)) {
      if (streak === 0) streakEnd = ds;
      streak++;
    } else if (i > 0) break;
  }
  if (streak === 7 || streak === 14 || streak === 21 || streak === 30 || streak === 60 || streak === 90) {
    events.push({
      date: streakEnd,
      kind: 'streak_milestone',
      agent: null,
      headline: `${streak}-day logging streak`,
      body: `You've shown up every day for ${streak} days. Consistency is the lever.`,
      magnitude: Math.min(100, 50 + streak),
      evidence: { agents: AGENTS, confidence: 0.95 },
    });
  }
  return events;
}

function det04_hypothesisConfirmed(ctx) {
  const out = [];
  for (const h of (ctx.hypotheses || [])) {
    if (h.status !== 'confirmed' && h.status !== 'rejected') continue;
    const date = h.confirmed_at || todayStr();
    const verb = h.status === 'confirmed' ? 'confirmed' : 'rejected';
    out.push({
      date,
      kind: `hypothesis_${h.status}`,
      agent: null,
      headline: `Pattern ${verb}: ${capitalize(h.a)} → ${capitalize(h.b)}`,
      body: `After ${h.last_n} days of tracking, the link is ${h.status === 'confirmed' ? 'real' : 'not what we thought'}.`,
      magnitude: 80,
      evidence: { agents: [h.a, h.b], confidence: 0.9 },
    });
  }
  return out;
}

function det05_bestWorstDay(ctx) {
  // Composite: average of normalized per-agent scores per day
  const dayScores = {};
  for (const agent of AGENTS) {
    for (const l of (ctx.recent_logs?.[agent] || [])) {
      const v = primaryValue(agent, l);
      if (v == null || !l.date) continue;
      const norm = (() => {
        switch (agent) {
          case 'sleep':     return Math.min(100, (v / 9) * 100);
          case 'mind':      return Math.min(100, (v / 5) * 100);
          case 'water':     return Math.min(100, (v / 2500) * 100);
          case 'nutrition': return Math.min(100, (v / 130) * 100);
          case 'fitness':   return Math.min(100, (v / 60) * 100);
          case 'fasting':   return Math.min(100, (v / 16) * 100);
          default: return null;
        }
      })();
      if (norm == null) continue;
      if (!dayScores[l.date]) dayScores[l.date] = { sum: 0, n: 0 };
      dayScores[l.date].sum += norm;
      dayScores[l.date].n += 1;
    }
  }
  const recent = Object.entries(dayScores)
    .filter(([d]) => Date.now() - new Date(d).getTime() <= 14 * 86400000)
    .map(([d, s]) => ({ date: d, score: s.sum / s.n }));
  if (recent.length < 3) return [];
  const best = recent.reduce((b, x) => x.score > b.score ? x : b);
  const worst = recent.reduce((w, x) => x.score < w.score ? x : w);
  const out = [];
  if (best.score >= 70) {
    out.push({
      date: best.date,
      kind: 'best_day',
      agent: null,
      headline: 'Your strongest day this stretch',
      body: `Composite ${Math.round(best.score)}/100. Multiple agents fired together.`,
      magnitude: Math.round(best.score),
      evidence: { agents: AGENTS, confidence: 0.85 },
    });
  }
  if (worst.score < 50) {
    out.push({
      date: worst.date,
      kind: 'worst_day',
      agent: null,
      headline: 'Your softest day',
      body: `Composite ${Math.round(worst.score)}/100. Worth a look — what happened?`,
      magnitude: Math.round(100 - worst.score),
      evidence: { agents: AGENTS, confidence: 0.8 },
    });
  }
  return out;
}

function det06_crossAgentMoment(ctx) {
  // For top hypothesis tracking, find the day that most strongly evidenced it
  const out = [];
  const tracking = (ctx.hypotheses || []).filter(h => h.status === 'tracking');
  for (const h of tracking.slice(0, 1)) {
    const aLogs = ctx.recent_logs?.[h.a] || [];
    const bLogs = ctx.recent_logs?.[h.b] || [];
    const aMap = Object.fromEntries(aLogs.map(l => [l.date, primaryValue(h.a, l)]));
    const bMap = Object.fromEntries(bLogs.map(l => [l.date, primaryValue(h.b, l)]));
    let best = null, bestScore = 0;
    for (const date of Object.keys(aMap)) {
      if (aMap[date] != null && bMap[date] != null) {
        const score = aMap[date] * (bMap[date] / 5);
        if (score > bestScore) { bestScore = score; best = { date, a: aMap[date], b: bMap[date] }; }
      }
    }
    if (best) {
      out.push({
        date: best.date,
        kind: 'cross_agent_moment',
        agent: null,
        headline: `${capitalize(h.a)} ↔ ${capitalize(h.b)} aligned`,
        body: `Strong showing on both — this is the pattern at work.`,
        magnitude: 65,
        evidence: { agents: [h.a, h.b], confidence: 0.7 },
      });
    }
  }
  return out;
}

function det07_setupMilestone(ctx) {
  const out = [];
  const setupCount = Object.values(ctx.setup_state || {}).filter(s => s === 'setup').length;
  if (setupCount === 6) {
    out.push({
      date: todayStr(),
      kind: 'all_setup',
      agent: null,
      headline: 'All 6 agents online',
      body: 'Full cross-agent intelligence is unlocked.',
      magnitude: 90,
      evidence: { agents: AGENTS, confidence: 1 },
    });
  }
  return out;
}

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

// PUBLIC
function buildTimeline(ctx) {
  const all = [];
  try { all.push(...det01_personalBest(ctx)); } catch {}
  try { all.push(...det02_anomalyDay(ctx)); } catch {}
  try { all.push(...det03_streakMilestone(ctx)); } catch {}
  try { all.push(...det04_hypothesisConfirmed(ctx)); } catch {}
  try { all.push(...det05_bestWorstDay(ctx)); } catch {}
  try { all.push(...det06_crossAgentMoment(ctx)); } catch {}
  try { all.push(...det07_setupMilestone(ctx)); } catch {}

  // Sort by date desc, then by magnitude desc within same date
  all.sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    return (b.magnitude || 0) - (a.magnitude || 0);
  });

  // Cap to 30 most-recent + most-impactful events
  return all.slice(0, 30);
}

module.exports = { buildTimeline };
