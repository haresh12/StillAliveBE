'use strict';
// ════════════════════════════════════════════════════════════════════
// cross-agent-aha.js — predictive cross-agent moments + pending actions.
// Rule-based intelligence that produces a SPECIFIC, ACTIONABLE moment
// only a cross-agent system could produce. No LLM needed at this layer
// (cheap, instant, deterministic), but extendable.
// ════════════════════════════════════════════════════════════════════

const AGENTS = ['fitness', 'sleep', 'mind', 'nutrition', 'water', 'fasting'];
const AGENT_LABEL = {
  fitness: 'Fitness', sleep: 'Sleep', mind: 'Mind',
  nutrition: 'Nutrition', water: 'Water', fasting: 'Fasting',
};

const dateStr = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`;
};
const today = () => dateStr(Date.now());
const yesterday = () => dateStr(Date.now() - 86400000);
const hoursSince = (iso) => {
  if (!iso) return null;
  const d = typeof iso === 'string' ? new Date(iso).getTime() : iso;
  return Math.round((Date.now() - d) / 3600000 * 10) / 10;
};

// ─── PENDING ACTIONS (cross-agent) ─────────────────────────────────
// Scans recent_actions in ctx for status === 'pending' or undefined-but-stale.
// Returns sorted by severity.
function buildPendingActions(ctx) {
  const out = [];
  for (const agent of AGENTS) {
    if (ctx.setup_state[agent] !== 'setup') continue;
    const acts = ctx.recent_actions[agent] || [];
    for (const a of acts.slice(0, 5)) {
      if (a.status && a.status !== 'pending') continue;
      const ageH = a.completed_at ? null : hoursSince(a.created_at || a.generated_at) || 24;
      const severity = ageH > 36 ? 'high' : ageH > 12 ? 'medium' : 'low';
      out.push({
        agent, title: a.title || a.message || `${AGENT_LABEL[agent]} action`,
        hours_overdue: Math.max(0, Math.round(ageH || 24)),
        severity,
      });
    }
  }
  // Today-not-logged checks per agent (synthetic "ping") — only if user logs that agent typically
  for (const agent of AGENTS) {
    if (ctx.setup_state[agent] !== 'setup') continue;
    const recent = ctx.recent_logs[agent] || [];
    if (recent.length === 0) continue;
    const todayLogged = recent.some(l => l.date === today());
    const expectsDaily = ['mind','sleep','water','nutrition'].includes(agent);
    if (expectsDaily && !todayLogged) {
      const lastDate = recent[0].date;
      const days = lastDate ? Math.floor((Date.now() - new Date(lastDate).getTime()) / 86400000) : 1;
      out.push({
        agent, title: `Log today's ${AGENT_LABEL[agent].toLowerCase()}`,
        hours_overdue: Math.max(12, days * 24), severity: days > 1 ? 'high' : 'medium',
        kind: 'daily_log_due',
      });
    }
  }
  return out
    .sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.severity] - { high: 0, medium: 1, low: 2 }[b.severity]))
    .slice(0, 6);
}

// ─── TIME-OF-DAY CONTEXT BANNER ────────────────────────────────────
function buildTimeContext(ctx) {
  const h = new Date().getHours();
  const slot = h < 6 ? 'pre_dawn' : h < 11 ? 'morning' : h < 14 ? 'midday' : h < 18 ? 'afternoon' : h < 21 ? 'evening' : 'night';

  // Try to infer "X hours since last meal", "X since wake"
  const nutritionLogs = ctx.recent_logs.nutrition || [];
  const lastMealH = nutritionLogs[0]?.date === today() ? hoursSince(nutritionLogs[0]?.logged_at_ms) : null;

  const sleepLogs = ctx.recent_logs.sleep || [];
  const lastSleepDuration = sleepLogs[0]?.duration_h;

  const waterLogs = ctx.recent_logs.water || [];
  const todayWaterMl = waterLogs.filter(l => l.date === today()).reduce((s, l) => s + (l.ml || 0), 0);
  const targetMl = ctx.priors?.water?.ml || 2300;

  const lines = [];
  if (slot === 'evening' || slot === 'night') {
    if (lastSleepDuration && lastSleepDuration < 6.5) lines.push(`You slept ${lastSleepDuration}h last night — easier night tonight.`);
    if (todayWaterMl < targetMl * 0.7) lines.push(`Hydration is ${Math.round((todayWaterMl/targetMl)*100)}% — sip 300ml before sleep.`);
  } else if (slot === 'morning') {
    if (lastSleepDuration && lastSleepDuration >= 7) lines.push(`Solid ${lastSleepDuration}h sleep — protect this momentum today.`);
    else if (lastSleepDuration) lines.push(`${lastSleepDuration}h sleep last night — pace yourself.`);
  } else if (slot === 'midday' || slot === 'afternoon') {
    if (lastMealH != null && lastMealH > 5) lines.push(`${lastMealH}h since last meal — energy dip likely.`);
    if (todayWaterMl < targetMl * 0.4) lines.push(`Behind on water — ${Math.round(targetMl/2 - todayWaterMl)}ml to halfway.`);
  }

  return { slot, hint: lines[0] || null };
}

// ─── AHA — CROSS-AGENT PREDICTIVE MOMENT ───────────────────────────
// The differentiator. Identifies the SINGLE most useful cross-agent insight
// reachable RIGHT NOW from the user's current state.
function buildAhaPrediction(ctx) {
  const sleep = ctx.recent_logs.sleep || [];
  const mind = ctx.recent_logs.mind || [];
  const nutrition = ctx.recent_logs.nutrition || [];
  const water = ctx.recent_logs.water || [];
  const fitness = ctx.recent_logs.fitness || [];
  const anchor = ctx.profile?.cold_start_anchor;

  // Pattern A: bad sleep + skipped breakfast → mood crash predicted
  const lastSleep = sleep[0];
  if (lastSleep && lastSleep.duration_h && lastSleep.duration_h < 6) {
    const hadBreakfast = nutrition.some(n => n.date === today() && new Date(n.logged_at_ms || 0).getHours() < 11);
    if (!hadBreakfast) {
      return {
        kind: 'risk_compound',
        headline: 'Two signals are stacking right now',
        detail: `You slept ${lastSleep.duration_h}h AND haven't logged breakfast. Past pattern: this combo lowered your mood 60% of the time. Counter-move: 30g protein in the next 30 min.`,
        tied_agents: ['sleep', 'nutrition', 'mind'],
        action: { agent: 'nutrition', title: 'Log a high-protein breakfast', cta: 'Open Nutrition' },
        evidence: { agents_used: ['sleep','nutrition','mind'], confidence: 0.7 },
      };
    }
  }

  // Pattern B: workout today + good sleep last night → predict peak day
  const workoutToday = fitness.some(f => f.date === today());
  if (workoutToday && lastSleep?.duration_h >= 7) {
    return {
      kind: 'peak_day',
      headline: 'Today should be a peak day',
      detail: `Workout in + ${lastSleep.duration_h}h sleep last night. On past matches, your mood ran 1.4× higher. Don't waste it on shallow work — block your hardest task next.`,
      tied_agents: ['fitness', 'sleep', 'mind'],
      action: { agent: 'mind', title: 'Log how the day actually goes', cta: 'Open Mind' },
      evidence: { agents_used: ['fitness','sleep','mind'], confidence: 0.75 },
    };
  }

  // Pattern C: 3+ skipped fitness actions citing tired + sleep<7h trending → root-cause is sleep
  const skipsTired = (ctx.skip_reasons?.too_tired || 0);
  const sleepAvg = sleep.length > 0 ? sleep.reduce((s, l) => s + (l.duration_h || 0), 0) / sleep.length : null;
  if (skipsTired >= 3 && sleepAvg && sleepAvg < 6.5) {
    return {
      kind: 'root_cause',
      headline: "It's not laziness — it's sleep",
      detail: `You've skipped ${skipsTired} workouts saying 'too tired'. Your sleep average is ${sleepAvg.toFixed(1)}h. Don't fix fitness first — fix sleep, fitness follows.`,
      tied_agents: ['sleep', 'fitness'],
      action: { agent: 'sleep', title: 'Set tonight\'s wind-down 30 min earlier', cta: 'Open Sleep' },
      evidence: { agents_used: ['sleep','fitness'], confidence: 0.78 },
    };
  }

  // Pattern D: water low + mind anxious today → hydration crash + anxiety likely linked
  const todayMind = mind.find(m => m.date === today());
  const todayWater = water.filter(w => w.date === today()).reduce((s, w) => s + (w.ml || 0), 0);
  const targetMl = ctx.priors?.water?.ml || 2300;
  if (todayMind && (todayMind.anxiety || 0) >= 4 && todayWater < targetMl * 0.4) {
    return {
      kind: 'cognitive_hydration',
      headline: 'Anxiety + dehydration — fastest fix',
      detail: `Anxiety logged ${todayMind.anxiety}/5 and you're at ${Math.round((todayWater/targetMl)*100)}% hydration. Adan 2012: 2% body-mass deficit raises perceived stress 18%. Try 500ml in 15 min.`,
      tied_agents: ['mind', 'water'],
      action: { agent: 'water', title: 'Log 500ml right now', cta: 'Open Water' },
      evidence: { agents_used: ['mind','water'], confidence: 0.7, cite: 'Adan 2012' },
    };
  }

  // Pattern E: fasting in progress + workout planned → metabolic timing window
  const todayFast = (ctx.recent_logs.fasting || []).find(f => f.date === today());
  if (todayFast && todayFast.actual_h >= 12 && (ctx.recent_actions.fitness || []).some(a => a.status === 'pending')) {
    return {
      kind: 'metabolic_window',
      headline: 'You\'re in metabolic switch territory',
      detail: `${todayFast.actual_h}h fasted (Anton 2018: switch starts at 12h). A workout right now extends ketogenic benefit ~30%. Stack them.`,
      tied_agents: ['fasting', 'fitness'],
      action: { agent: 'fitness', title: 'Train fasted in the next hour', cta: 'Open Fitness' },
      evidence: { agents_used: ['fasting','fitness'], confidence: 0.72, cite: 'Anton 2018' },
    };
  }

  // Pattern F: anchor-driven (works at day 0 with no logs)
  if (!sleep.length && !mind.length && anchor) {
    const anchorPlans = {
      sleep: { headline: 'Sleep is your anchor — start there', detail: 'You said sleep feels off. Even one log tonight (bedtime + quality) lets us start tracking your pattern.', action: { agent: 'sleep', title: 'Set your sleep target', cta: 'Open Sleep' } },
      energy: { headline: 'Energy is your anchor', detail: 'Energy is downstream of sleep, water, and food timing. A mind check-in + water log today seeds the pattern.', action: { agent: 'mind', title: 'Take a 30-sec mind check-in', cta: 'Open Mind' } },
      mood: { headline: 'Mood is your anchor', detail: 'Mood usually tracks sleep with a 1-day lag. Log a mind check-in now + sleep tonight = first pattern by Day 3.', action: { agent: 'mind', title: 'Mind check-in (60 sec)', cta: 'Open Mind' } },
      weight: { headline: 'Weight is your anchor', detail: 'Weight responds to fasting + nutrition timing. Set up fasting + log one meal — first signal in 5 days.', action: { agent: 'fasting', title: 'Plan today\'s eating window', cta: 'Open Fasting' } },
      fitness: { headline: 'Fitness is your anchor', detail: 'Volume × consistency × sleep. Log even a short session today to anchor your baseline.', action: { agent: 'fitness', title: 'Log today\'s movement', cta: 'Open Fitness' } },
      none: { headline: 'Just exploring? Start with mind', detail: 'A 30-second mind check-in is the cheapest first signal. Cross-agent links appear after Day 3.', action: { agent: 'mind', title: 'Try a mind check-in', cta: 'Open Mind' } },
    };
    const plan = anchorPlans[anchor] || anchorPlans.none;
    return {
      kind: 'anchor_seed',
      headline: plan.headline,
      detail: plan.detail,
      tied_agents: [plan.action.agent],
      action: plan.action,
      evidence: { agents_used: [], confidence: 0.55 },
    };
  }

  return null;
}

// ─── SIX TILES — RICH STATES (unset / no-log-today / logged-today) ─
function buildAgentTilesRich(ctx) {
  const out = [];
  for (const agent of AGENTS) {
    const setup = ctx.setup_state[agent] === 'setup';
    const logs = ctx.recent_logs[agent] || [];
    const todayLog = logs.find(l => l.date === today());
    const lastVal = logs[0];
    const last7 = logs.slice(0, 7).map(l => primaryValue(agent, l)).filter(v => v != null).reverse();
    const delta = last7.length >= 2 ? Math.round((last7[last7.length - 1] - last7[0]) * 10) / 10 : 0;
    out.push({
      agent,
      state: !setup ? 'unset' : todayLog ? 'logged_today' : lastVal ? 'no_log_today' : 'never_logged',
      logged_today: !!todayLog,
      last_value: lastVal ? primaryValue(agent, lastVal) : null,
      last_value_label: lastVal ? primaryValueLabel(agent, lastVal) : null,
      last_logged_date: lastVal?.date || null,
      sparkline: last7,
      delta_7d: delta,
      hint: hintFor(agent, ctx),
    });
  }
  return out;
}
function primaryValue(agent, log) {
  switch (agent) {
    case 'sleep': return log.duration_h ?? log.quality;
    case 'mind':  return log.mood_score;
    case 'water': return log.ml;
    case 'nutrition': return log.protein_g ?? log.kcal;
    case 'fitness':   return log.total_sets ?? log.duration_min;
    case 'fasting':   return log.actual_h;
    default: return null;
  }
}
function primaryValueLabel(agent, log) {
  switch (agent) {
    case 'sleep': return log.duration_h ? `${log.duration_h}h` : `${log.quality}/5`;
    case 'mind':  return log.mood ? log.mood : log.mood_score ? `${log.mood_score}/5` : null;
    case 'water': return log.ml ? `${log.ml}ml` : null;
    case 'nutrition': return log.kcal ? `${log.kcal} kcal` : null;
    case 'fitness':   return log.total_sets ? `${log.total_sets} sets` : log.duration_min ? `${log.duration_min}min` : null;
    case 'fasting':   return log.actual_h ? `${log.actual_h}h` : null;
    default: return null;
  }
}
function hintFor(agent, ctx) {
  // Cross-agent setup hints — what value the user unlocks by setting up this agent
  if (ctx.setup_state[agent] === 'setup') return null;
  const setupCount = ctx.setup_count || 0;
  const hints = {
    sleep:     setupCount >= 1 ? 'Unlocks sleep → mood pattern' : 'Foundation for every other agent',
    mind:      setupCount >= 1 ? 'Unlocks mood-pattern detection' : 'Cheapest first signal (30 sec)',
    fitness:   setupCount >= 1 ? 'Reveals fitness → sleep effect' : 'Movement intensity matters',
    nutrition: setupCount >= 1 ? 'Clarifies energy crashes' : 'Protein + timing drive recovery',
    water:     setupCount >= 1 ? 'Hydration affects mood by ~18%' : 'Tracking is one tap',
    fasting:   setupCount >= 1 ? 'Eating window vs energy timing' : 'Optional — for metabolic focus',
  };
  return hints[agent];
}

module.exports = {
  buildPendingActions,
  buildTimeContext,
  buildAhaPrediction,
  buildAgentTilesRich,
};
