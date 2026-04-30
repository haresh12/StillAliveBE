'use strict';
// ════════════════════════════════════════════════════════════════════
// score-impact.js — for every state in the user's data, compute the
// concrete score-point cost or win, with a one-tap recovery action.
//
// Research:
//   - Kahneman & Tversky 1979 — loss aversion (concrete numeric costs)
//   - Locke & Latham 2002 — specific + difficult-but-attainable goals
//   - JMIR 2022 — loss frames must include recovery affordance
//   - Schuch 2016 — celebrate wins to reinforce loops
// ════════════════════════════════════════════════════════════════════

const AGENTS = ['fitness', 'sleep', 'mind', 'nutrition', 'water', 'fasting'];

const todayStr = () => new Date().toISOString().slice(0, 10);

// ─── COST LINES ─────────────────────────────────────────────────────
function buildCostLines(ctx, harvest) {
  const out = [];

  // 1. Each unset agent costs 6-9 points (matches our completion-factor curve)
  for (const agent of AGENTS) {
    if (ctx.setup_state?.[agent] !== 'setup') {
      out.push({
        kind: 'unset_agent',
        agent,
        severity: 'medium',
        cost: 7,
        title: `${capitalize(agent)} not set up`,
        body: `Adding it lifts your ceiling about 6–9 points and unlocks cross-agent patterns.`,
        action: { agent, label: `Set up ${capitalize(agent)}`, kind: 'setup' },
      });
    }
  }

  // 2. Silent agents (logging gap) — escalating cost (matches penalty curve)
  for (const c of (harvest?.contributors || [])) {
    if (!c.setup) continue;
    const lastDate = c.last_log_date || (c.spark?.length ? null : null);
    // Use last entry from the spark cadence as proxy
    const daysSinceLastLog = inferDaysSinceLog(ctx.recent_logs?.[c.agent] || []);
    if (daysSinceLastLog >= 7) {
      const cost = daysSinceLastLog >= 21 ? 10 : daysSinceLastLog >= 14 ? 7 : 5;
      out.push({
        kind: 'silent_agent',
        agent: c.agent,
        severity: cost >= 7 ? 'high' : 'medium',
        cost,
        title: `${capitalize(c.agent)} hasn't been logged in ${daysSinceLastLog} days`,
        body: `One log resets it. The pattern engine needs ${c.agent} to read your full picture.`,
        action: { agent: c.agent, label: `Log ${c.agent} now`, kind: 'log' },
      });
    }
  }

  // 3. Low action completion — costs 5
  if (harvest?.overall_completion != null && harvest.overall_completion < 0.30) {
    out.push({
      kind: 'low_completion',
      severity: 'medium',
      cost: 5,
      title: `Action completion is at ${Math.round(harvest.overall_completion * 100)}%`,
      body: `Each completed action confirms what's working. Try one short action this week.`,
      action: { agent: harvest.contributors?.[0]?.agent || 'mind', label: 'See suggested actions', kind: 'deeplink' },
    });
  }

  // 4. Dominant skip reason — costs 3
  if (harvest?.top_skip_reason && harvest.top_skip_reason.count >= 3) {
    out.push({
      kind: 'skip_pattern',
      severity: 'low',
      cost: 3,
      title: `"${harvest.top_skip_reason.reason}" skipped ${harvest.top_skip_reason.count} times`,
      body: `If timing's the issue, change when reminders fire. If it's energy, fix sleep first.`,
      action: { agent: 'mind', label: 'Adjust reminder timing', kind: 'deeplink' },
    });
  }

  return out.sort((a, b) => b.cost - a.cost).slice(0, 6);
}

// ─── WIN LINES ──────────────────────────────────────────────────────
function buildWinLines(ctx, harvest) {
  const out = [];

  // 1. All 6 agents set up
  if (harvest?.counts?.setup_count === 6) {
    out.push({
      kind: 'all_setup',
      severity: 'high',
      title: 'All 6 agents online',
      body: 'You\'re running the full system. Every cross-agent pattern is now reachable.',
    });
  }

  // 2. Streak (cross-agent log streak)
  const streak = computeStreak(ctx);
  if (streak >= 7) {
    const tier = streak >= 90 ? 'top 1%' : streak >= 60 ? 'top 5%' : streak >= 30 ? 'top 10%' : streak >= 14 ? 'top 20%' : 'great';
    out.push({
      kind: 'streak',
      severity: streak >= 30 ? 'high' : 'medium',
      title: `${streak}-day logging streak`,
      body: streak >= 30 ? `Identity-level habit. ${tier} of users at your stage.` : `Consistency is the lever. ${tier} of users at your stage.`,
    });
  }

  // 3. High completion rate
  if (harvest?.overall_completion != null && harvest.overall_completion >= 0.75) {
    out.push({
      kind: 'high_completion',
      severity: 'medium',
      title: `${Math.round(harvest.overall_completion * 100)}% action completion`,
      body: `You finish what you start. The compounding effect of this is real.`,
    });
  }

  // 4. Strong agent (any contributor at 85+)
  const strongest = (harvest?.contributors || [])
    .filter(c => c.setup && c.score != null && c.score >= 85)
    .sort((a, b) => (b.score || 0) - (a.score || 0))[0];
  if (strongest) {
    out.push({
      kind: 'strong_agent',
      agent: strongest.agent,
      severity: 'medium',
      title: `${capitalize(strongest.agent)} is firing — ${strongest.score}/100`,
      body: `This is the agent doing the heavy lifting on your overall score.`,
    });
  }

  // 5. Confirmed pattern
  for (const h of (ctx.hypotheses || [])) {
    if (h.status === 'confirmed') {
      out.push({
        kind: 'pattern_confirmed',
        severity: 'high',
        title: `Pattern confirmed: ${capitalize(h.a)} → ${capitalize(h.b)}`,
        body: `After ${h.last_n} days of tracking, the link held up. This is real, not noise.`,
      });
      break;
    }
  }

  return out.slice(0, 4);
}

// ─── HELPERS ────────────────────────────────────────────────────────
function inferDaysSinceLog(logs) {
  if (!logs?.length) return 999;
  const dates = logs.map(l => l.date).filter(Boolean).sort().reverse();
  if (!dates.length) return 999;
  const last = new Date(dates[0]);
  return Math.floor((Date.now() - last.getTime()) / 86400000);
}

function computeStreak(ctx) {
  const allDates = new Set();
  for (const a of AGENTS) {
    for (const l of (ctx.recent_logs?.[a] || [])) {
      if (l.date) allDates.add(l.date);
    }
  }
  let streak = 0;
  for (let i = 0; i < 200; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const ds = d.toISOString().slice(0, 10);
    if (allDates.has(ds)) streak++;
    else if (i > 0) break;
  }
  return streak;
}

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

// PUBLIC
function buildScoreImpact(ctx, harvest) {
  const costs = buildCostLines(ctx, harvest);
  const wins  = buildWinLines(ctx, harvest);
  const totalCost = costs.reduce((s, c) => s + c.cost, 0);
  // top_action: the single highest-gain recovery action
  const topAction = costs.length > 0 ? costs[0].action : null;
  const topActionGain = costs.length > 0 ? costs[0].cost : 0;
  return {
    costs, wins,
    total_cost: totalCost,
    top_action: topAction,
    top_action_gain: topActionGain,
    summary: costs.length === 0 && wins.length > 0
      ? 'Nothing flagged — keep doing what you\'re doing.'
      : costs.length === 0
      ? 'Just starting out. Log a few things to unlock more signal.'
      : `${costs.length} thing${costs.length === 1 ? '' : 's'} costing you about ${totalCost} points. Each is recoverable.`,
  };
}

module.exports = { buildScoreImpact, buildCostLines, buildWinLines };
