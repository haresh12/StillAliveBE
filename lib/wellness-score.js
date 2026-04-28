'use strict';
// ════════════════════════════════════════════════════════════════════
// wellness-score.js — research-backed score formula.
//   score = clamp(base × maturity × completion − penalties, 0, 100)
//
// Designed so Day 1 single-agent ≈ 8, Day 7 ≈ 22, Day 30 ≈ 60,
// Day 90 ≈ 84. You earn the high numbers.
//
// Citations:
//   Schönbrodt & Perugini 2013 — n≥30 for stable correlations
//   Walker 2017, Banks & Dinges 2007 — sleep weight 25%
//   Schuch 2016, WHO 2020 — fitness weight 25%
//   Pressman & Cohen 2005 — mind weight 15%
//   Morton 2018, ISSN 2017 — nutrition weight 15%
//   Adan 2012 — water weight 10%
//   Mattson 2019 — fasting weight 10% (optional protocol)
//   Phillips 2017 — consistency penalty
//   Skinner 1957 + Nunes & Drèze 2006 — slow earned reward
// ════════════════════════════════════════════════════════════════════

const AGENTS = ['fitness', 'sleep', 'mind', 'nutrition', 'water', 'fasting'];
const WEIGHTS = { fitness: 0.25, sleep: 0.25, mind: 0.15, nutrition: 0.15, water: 0.10, fasting: 0.10 };

const round = (n, p = 0) => { const k = 10 ** p; return Math.round(n * k) / k; };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function maturityFactor(daysWithLog) {
  if (daysWithLog <= 0) return 0;
  if (daysWithLog < 7)  return 0.20;
  if (daysWithLog < 14) return 0.45;
  if (daysWithLog < 30) return 0.70;
  if (daysWithLog < 60) return 0.90;
  return 1.00;
}

function completionFactor(setupCount) {
  return [0, 0.55, 0.70, 0.82, 0.90, 0.96, 1.00][Math.min(6, setupCount)] || 0;
}

// Compute base = weighted average of agent subscores (current logic, simplified)
function computeBase(matrix) {
  let total = 0, weightSum = 0;
  const subscores = {};
  for (const agent of AGENTS) {
    const series = matrix[agent] || {};
    const cutoff = Date.now() - 7 * 86400000;
    const recent = Object.entries(series)
      .filter(([d]) => new Date(d).getTime() >= cutoff)
      .map(([, v]) => v);
    if (recent.length === 0) { subscores[agent] = null; continue; }
    const avg = recent.reduce((s, x) => s + x, 0) / recent.length;
    subscores[agent] = round(avg);
    total += avg * WEIGHTS[agent];
    weightSum += WEIGHTS[agent];
  }
  const base = weightSum > 0 ? total / weightSum : 0;
  return { base: round(base), subscores };
}

function computePenalties(matrix, ctx) {
  const penalties = [];
  const today = Date.now();
  // Days since user joined — no penalties for pre-join gaps
  const joinedAt = ctx.joined_at ? new Date(ctx.joined_at).getTime() : 0;
  const daysSinceJoin = joinedAt ? Math.floor((today - joinedAt) / 86400000) : 999;

  // 1. Data-rot: any set-up agent silent ≥7 days (only after Day 14)
  if (daysSinceJoin >= 14) {
    for (const agent of AGENTS) {
      if (ctx.setup_state?.[agent] !== 'setup') continue;
      const series = matrix[agent] || {};
      const dates = Object.keys(series).filter(d => !joinedAt || new Date(d).getTime() >= joinedAt);
      if (!dates.length) continue;
      const lastTs = Math.max(...dates.map(d => new Date(d).getTime()));
      const daysSince = Math.floor((today - lastTs) / 86400000);
      if (daysSince >= 7) {
        const value = daysSince >= 21 ? -10 : daysSince >= 14 ? -7 : -5;
        penalties.push({ kind: 'silent', agent, value,
          reason: `${capitalize(agent)} not logged in ${daysSince} days — log today to remove this` });
        break;
      }
    }
  }

  // 2. Low action completion — only fires after Day 14 with ≥8 actions
  if (daysSinceJoin >= 14) {
    let acted = 0, total = 0;
    for (const agent of AGENTS) {
      for (const a of (ctx.recent_actions?.[agent] || [])) {
        if (!a.status) continue;
        total += 1;
        if (a.status === 'completed') acted += 1;
      }
    }
    if (total >= 8 && (acted / total) < 0.20) {
      penalties.push({ kind: 'low_completion', value: -5,
        reason: `Complete suggested actions to remove this (${Math.round((acted/total)*100)}% completion)` });
    }
  }

  // 3. Logging gap — only counts days since join, only after Day 7
  if (daysSinceJoin >= 7) {
    const allDates = new Set();
    for (const agent of AGENTS) {
      Object.keys(matrix[agent] || {})
        .filter(d => !joinedAt || new Date(d).getTime() >= joinedAt)
        .forEach(d => allDates.add(d));
    }
    let gap = 0;
    for (let i = 0; i < 14; i++) {
      const d = new Date(today - i * 86400000).toISOString().slice(0, 10);
      const dMs = new Date(d).getTime();
      if (joinedAt && dMs < joinedAt) break; // don't count pre-join
      if (allDates.has(d)) break;
      gap++;
    }
    if (gap >= 5) {
      const value = gap >= 7 ? -7 : -3;
      penalties.push({ kind: 'gap', value,
        reason: `${gap}-day logging gap — come back to remove this` });
    }
  }

  // Cap total penalty at -15
  let totalPenalty = penalties.reduce((s, p) => s + p.value, 0);
  if (totalPenalty < -15) totalPenalty = -15;
  return { penalties, totalPenalty };
}

// MAIN
function computeScore({ matrix, ctx, peakSoFar }) {
  const setupCount = Object.values(ctx.setup_state || {}).filter(s => s === 'setup').length;
  const allDates = new Set();
  for (const agent of AGENTS) Object.keys(matrix[agent] || {}).forEach(d => allDates.add(d));
  const daysWithLog = allDates.size;

  const { base, subscores } = computeBase(matrix);
  const maturity   = maturityFactor(daysWithLog);
  const completion = completionFactor(setupCount);
  const { penalties, totalPenalty } = computePenalties(matrix, ctx);

  // Pre-penalty score (the "what your habits earn") + post-penalty score
  const earned = clamp(round(base * maturity * completion), 0, 100);
  const score = clamp(round(base * maturity * completion + totalPenalty), 0, 100);

  // Peak tracking — caller passes prior peak or undefined
  const peak = Math.max(peakSoFar || 0, score);
  const slipped_from_peak = peak > score ? peak - score : 0;

  // What would move it +5?
  const what_moves_it = [];
  if (setupCount < 6) {
    const next = AGENTS.find(a => ctx.setup_state?.[a] !== 'setup');
    if (next) what_moves_it.push({
      kind: 'setup_agent', agent: next, gain_estimate: '+6 to +9',
      label: `Set up ${capitalize(next)}`,
    });
  }
  if (daysWithLog < 30) {
    const nextMilestone = daysWithLog < 7 ? 7 : daysWithLog < 14 ? 14 : 30;
    what_moves_it.push({
      kind: 'reach_milestone', day: nextMilestone, gain_estimate: '+8 to +15',
      label: `Log through Day ${nextMilestone}`,
    });
  }
  if (penalties.find(p => p.kind === 'silent')) {
    what_moves_it.push({
      kind: 'restart_silent', gain_estimate: '+5',
      label: 'Restart the silent agent',
    });
  }
  if (penalties.find(p => p.kind === 'low_completion')) {
    what_moves_it.push({
      kind: 'complete_actions', gain_estimate: '+5',
      label: 'Complete 3 suggested actions this week',
    });
  }

  return {
    score,
    earned,
    peak_score: peak,
    slipped_from_peak,
    base: round(base),
    maturity_factor: maturity,
    completion_factor: completion,
    penalties,
    total_penalty: totalPenalty,
    subscores,
    weights: WEIGHTS,
    days_with_log: daysWithLog,
    setup_count: setupCount,
    next_milestone_day: daysWithLog < 7 ? 7 : daysWithLog < 14 ? 14 : daysWithLog < 30 ? 30 : daysWithLog < 60 ? 60 : 90,
    maturity_label:
      daysWithLog === 0 ? 'Building baseline' :
      daysWithLog < 7   ? `Day ${daysWithLog} of 7 — calibrating` :
      daysWithLog < 14  ? `Day ${daysWithLog} of 14 — patterns forming` :
      daysWithLog < 30  ? `Day ${daysWithLog} of 30 — confirming` :
      daysWithLog < 60  ? `Day ${daysWithLog} — deep insights live` :
                          `${daysWithLog}+ days — full intelligence`,
    what_moves_it,
  };
}

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

module.exports = {
  computeScore,
  maturityFactor,
  completionFactor,
  computeBase,
  computePenalties,
  WEIGHTS, AGENTS,
};
