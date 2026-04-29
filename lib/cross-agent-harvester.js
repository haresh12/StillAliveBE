'use strict';
// ════════════════════════════════════════════════════════════════════
// cross-agent-harvester.js — pulls the FULL signal surface from every
// one of the 6 agents into a single unified harvest object.
// Includes: logs, computed metrics, actions (status + skip), chats,
// per-agent contributor stats vs personal baselines.
//
// Citations:
//   • Garmin Training Readiness pattern — auditable composite with named
//     contributors (the5krunner Training Readiness)
//   • Oura "contributors with personal baselines" (Oura blog, New App)
//   • Choe 2014 — multi-stream attribution is the unmet QS need
//   • Cleveland & McGill 1984 — small multiples on aligned axes
// ════════════════════════════════════════════════════════════════════

const AGENTS = ['fitness', 'sleep', 'mind', 'nutrition', 'water', 'fasting'];

const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const stdev = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const round = (n, p = 1) => { const k = 10 ** p; return Math.round(n * k) / k; };

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

// Per-agent computed signals (consistency, debt, streak — what each agent's
// own Analysis tab already shows users)
function computeAgentMetrics(agent, logs) {
  if (!logs.length) return { consistency: 0, recentMean: null, baseline: null };

  const values = logs.map(l => primaryValue(agent, l)).filter(v => v != null);
  if (!values.length) return { consistency: 0, recentMean: null, baseline: null };

  // 7-day vs 14-day means (recent vs baseline)
  const recent = values.slice(0, 7);
  const baseline = values.slice(7, 21);

  // Consistency = inverse-coefficient-of-variation, scored 0-100
  const sd = stdev(values);
  const m = mean(values);
  const cv = m > 0 ? sd / m : 0;
  const consistency = Math.max(0, Math.min(100, Math.round((1 - cv) * 100)));

  return {
    consistency,
    recentMean:  recent.length    ? round(mean(recent), 1)    : null,
    baseline:    baseline.length  ? round(mean(baseline), 1)  : (recent.length ? round(mean(recent), 1) : null),
    recentMeanLabel:  recent.length ? valueLabel(agent, mean(recent)) : '—',
    baselineLabel:    baseline.length ? valueLabel(agent, mean(baseline)) : (recent.length ? valueLabel(agent, mean(recent)) : '—'),
    spark: values.slice(0, 14).reverse(),
  };
}

// Actions summary — pulls from ctx.recent_actions (already in context bundle)
function computeAgentActions(agent, actions) {
  let completed = 0, skipped = 0, pending = 0;
  const skipReasons = {};
  for (const a of (actions || [])) {
    if (a.status === 'completed') completed++;
    else if (a.status === 'skipped') {
      skipped++;
      if (a.skip_reason) skipReasons[a.skip_reason] = (skipReasons[a.skip_reason] || 0) + 1;
    } else pending++;
  }
  const total = completed + skipped + pending;
  const completionRate = total > 0 ? Math.round((completed / total) * 100) / 100 : null;
  const dominantSkip = Object.entries(skipReasons).sort((a, b) => b[1] - a[1])[0];
  return {
    completed, skipped, pending, total, completion_rate: completionRate,
    dominant_skip: dominantSkip ? { reason: dominantSkip[0], count: dominantSkip[1] } : null,
  };
}

// Chat themes — extract simple keyword frequency from recent user messages
function computeChatTopics(chats) {
  if (!chats?.length) return [];
  const text = chats.filter(c => c.role === 'user').map(c => c.text || '').join(' ').toLowerCase();
  const tokens = text.split(/\W+/).filter(t => t.length >= 4);
  const freq = {};
  for (const t of tokens) freq[t] = (freq[t] || 0) + 1;
  const STOP = new Set(['really','today','about','because','should','would','could','still','again','little','always','never','sometimes','feeling','feeling','little','this','that','have','with','your','from','them','they']);
  return Object.entries(freq)
    .filter(([k, c]) => c >= 2 && !STOP.has(k))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([word, count]) => ({ word, count }));
}

// Status word from per-agent score (mirrors Home tab convention)
function statusOf(score) {
  if (score == null) return 'NO DATA';
  if (score >= 85) return 'STRONG';
  if (score >= 70) return 'GOOD';
  if (score >= 55) return 'STEADY';
  if (score >= 40) return 'WATCH';
  return 'BEHIND';
}

// Build one "contributor row" per agent — the Garmin Training-Readiness DNA
function buildContributors(ctx) {
  const out = [];
  for (const agent of AGENTS) {
    const setup = ctx.setup_state?.[agent] === 'setup';
    if (!setup) {
      out.push({
        agent, setup: false,
        score: null, status: 'OFF',
        recent_value_label: null, baseline_label: null,
        delta_vs_baseline: null,
        consistency: 0,
        actions: { completion_rate: null, dominant_skip: null },
        chat_topics: [],
        spark: [],
      });
      continue;
    }
    const logs = ctx.recent_logs?.[agent] || [];
    const actions = ctx.recent_actions?.[agent] || [];
    const chats = ctx.recent_chats?.[agent] || [];
    const m = computeAgentMetrics(agent, logs);
    const a = computeAgentActions(agent, actions);
    const t = computeChatTopics(chats);

    // Score from existing matrix-derived subscore if available, else null
    const score = ctx.subscores?.[agent] ?? null;
    const delta = (m.recentMean != null && m.baseline != null)
      ? round(m.recentMean - m.baseline, 1)
      : null;

    out.push({
      agent, setup: true,
      score, status: statusOf(score),
      recent_value_label: m.recentMeanLabel,
      baseline_label: m.baselineLabel,
      delta_vs_baseline: delta,
      consistency: m.consistency,
      actions: a,
      chat_topics: t,
      spark: m.spark,
    });
  }
  return out;
}

// Score story — what moved this week vs previous week (uses contributor deltas)
function buildScoreStory(contributors) {
  const active = contributors.filter(c => c.setup && c.delta_vs_baseline != null);
  if (active.length < 2) return null;
  const sorted = [...active].sort((a, b) => b.delta_vs_baseline - a.delta_vs_baseline);
  const topGain = sorted.find(c => c.delta_vs_baseline > 0.2) || null;
  const topDrag = [...sorted].reverse().find(c => c.delta_vs_baseline < -0.2) || null;
  return {
    agents_improving: sorted.filter(c => c.delta_vs_baseline > 0.2).length,
    agents_declining: sorted.filter(c => c.delta_vs_baseline < -0.2).length,
    top_gain: topGain ? {
      agent: topGain.agent,
      delta: topGain.delta_vs_baseline,
      recent_label: topGain.recent_value_label,
      baseline_label: topGain.baseline_label,
    } : null,
    top_drag: topDrag ? {
      agent: topDrag.agent,
      delta: topDrag.delta_vs_baseline,
      recent_label: topDrag.recent_value_label,
      baseline_label: topDrag.baseline_label,
    } : null,
  };
}

// Personal bests — best primary-value log seen per agent in the context window
function buildPersonalBests(ctx) {
  const bests = {};
  for (const agent of AGENTS) {
    if (ctx.setup_state?.[agent] !== 'setup') continue;
    const logs = ctx.recent_logs?.[agent] || [];
    if (!logs.length) continue;
    let bestVal = null, bestDate = null;
    for (const log of logs) {
      const v = primaryValue(agent, log);
      if (v == null) continue;
      if (bestVal == null || v > bestVal) { bestVal = v; bestDate = log.date || log.date_str; }
    }
    if (bestVal != null) bests[agent] = { label: valueLabel(agent, bestVal), date: bestDate };
  }
  return Object.keys(bests).length ? bests : null;
}

// Top-level harvest object — single source of truth for the Insights tab
function buildHarvest(ctx) {
  const contributors = buildContributors(ctx);
  const total_logs = AGENTS.reduce((s, a) => s + (ctx.recent_logs?.[a]?.length || 0), 0);
  const total_actions = AGENTS.reduce((s, a) => s + (ctx.recent_actions?.[a]?.length || 0), 0);
  const total_chats = AGENTS.reduce((s, a) => s + (ctx.recent_chats?.[a]?.length || 0), 0);

  // Aggregate skip reasons across all agents
  const allSkips = {};
  for (const c of contributors) {
    if (!c.actions.dominant_skip) continue;
    const r = c.actions.dominant_skip.reason;
    allSkips[r] = (allSkips[r] || 0) + c.actions.dominant_skip.count;
  }
  const top_skip_reason = Object.entries(allSkips).sort((a, b) => b[1] - a[1])[0];

  // Aggregate completion rate across all agents
  let totalActed = 0, totalActions = 0;
  for (const c of contributors) {
    if (c.actions.total) {
      totalActions += c.actions.total;
      totalActed += c.actions.completed;
    }
  }
  const overall_completion = totalActions > 0 ? Math.round((totalActed / totalActions) * 100) / 100 : null;

  return {
    contributors,
    counts: {
      logs: total_logs,
      actions: total_actions,
      chats: total_chats,
      setup_count: contributors.filter(c => c.setup).length,
    },
    overall_completion,
    top_skip_reason: top_skip_reason ? { reason: top_skip_reason[0], count: top_skip_reason[1] } : null,
    score_story: buildScoreStory(contributors),
    personal_bests: buildPersonalBests(ctx),
  };
}

module.exports = {
  buildHarvest,
  buildContributors,
  computeAgentMetrics,
  computeAgentActions,
  computeChatTopics,
  AGENTS,
};
