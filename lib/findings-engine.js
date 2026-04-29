'use strict';
// ════════════════════════════════════════════════════════════════════
// findings-engine.js — produces FULL findings (not summaries).
// Each finding ships:
//   - statement (plain English, contrastive — Miller 2019)
//   - day_records (the actual logged days that drove it — for drill modal)
//   - chart_points (with halo-dot encoding for the ProvingChart)
//   - counterfactual ("if X had been Y, today's Z would likely be...")
//   - experiment (one CTA, specific + difficult-but-attainable — Locke & Latham)
//   - confidence + confidence_label
// ════════════════════════════════════════════════════════════════════

const AGENTS = ['fitness', 'sleep', 'mind', 'nutrition', 'water', 'fasting'];

const round = (n, p = 1) => { const k = 10 ** p; return Math.round(n * k) / k; };
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
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
function valueLabel(agent, v) {
  if (v == null) return '—';
  switch (agent) {
    case 'sleep': return `${round(v, 1)}h`;
    case 'mind':  return `${round(v, 1)}/5`;
    case 'water': return `${Math.round(v)}ml`;
    case 'nutrition': return `${Math.round(v)}g protein`;
    case 'fitness':   return `${Math.round(v)} min`;
    case 'fasting':   return `${round(v, 1)}h`;
    default: return String(v);
  }
}
function capName(a) {
  return ({ fitness: 'Fitness', sleep: 'Sleep', mind: 'Mind', nutrition: 'Nutrition', water: 'Water', fasting: 'Fasting' })[a] || a;
}

// Confidence label — plain English, no Cohen's d jargon in the UI
function confidenceLabel(d, n) {
  const absD = Math.abs(d);
  if (absD >= 0.7 && n >= 10) return 'CONFIRMED';
  if (absD >= 0.5 && n >= 6)  return 'LIKELY';
  if (absD >= 0.4 && n >= 4)  return 'EARLY SIGNAL';
  return 'BUILDING';
}

// Build a single paired finding (a→b)
// Thresholds lowered: 3 logs each side (was 5/5) so early users get signal
function buildPairFinding(ctx, a, b) {
  const aLogs = ctx.recent_logs?.[a] || [];
  const bLogs = ctx.recent_logs?.[b] || [];
  // Need at least 3 logs in each agent to attempt a finding
  if (aLogs.length < 3 || bLogs.length < 3) return null;
  const aValsAll = aLogs.map(l => primaryValue(a, l)).filter(v => v != null);
  if (aValsAll.length < 3) return null;
  const median = [...aValsAll].sort((x, y) => x - y)[Math.floor(aValsAll.length / 2)];
  const bMap = Object.fromEntries(bLogs.map(l => [l.date, primaryValue(b, l)]));
  const lowB = [], highB = [];
  const dayRecords = [];
  for (const aLog of aLogs) {
    const av = primaryValue(a, aLog);
    const bv = bMap[aLog.date];
    if (av == null || bv == null) continue;
    const isHighA = av >= median;
    (isHighA ? highB : lowB).push(bv);
    dayRecords.push({
      date: aLog.date,
      a_value: av,
      a_label: valueLabel(a, av),
      b_value: bv,
      b_label: valueLabel(b, bv),
      side: isHighA ? 'high' : 'low',
    });
  }
  // Need at least 2 days on each side (was 3/3)
  if (lowB.length < 2 || highB.length < 2) return null;
  const ml = mean(lowB), mh = mean(highB);
  const sd = stdev([...lowB, ...highB]);
  if (sd === 0) return null;
  const d = (mh - ml) / sd;
  // Minimum effect size: 0.3 (was 0.4) to surface early patterns
  if (Math.abs(d) < 0.3) return null;

  const direction = d > 0 ? 'lifts' : 'drags down';
  const strength = Math.abs(d) >= 0.7 ? 'strongly' : Math.abs(d) >= 0.5 ? 'clearly' : 'measurably';
  const n = lowB.length + highB.length;
  const clabel = confidenceLabel(d, n);

  // chart_points: ordered by date ascending, with halo encoding
  const sortedDays = [...dayRecords].sort((x, y) => x.date.localeCompare(y.date));
  const chartPoints = sortedDays.map(r => ({
    date: r.date,
    label: r.date.slice(5),  // MM-DD
    a_value: r.a_value,
    b_value: r.b_value,
    side: r.side,
    halo: r.side === 'high' ? '#1D9E75' : '#EF4444',
  }));

  // Counterfactual: based on personal effect, predict alt outcome
  const today = new Date().toISOString().slice(0, 10);
  const todayLog = aLogs.find(l => l.date === today);
  let counterfactual = null;
  if (todayLog) {
    const todayA = primaryValue(a, todayLog);
    if (todayA < median) {
      counterfactual = {
        condition: `If today's ${capName(a).toLowerCase()} had been on the high side`,
        prediction: `your ${capName(b).toLowerCase()} would likely land near ${valueLabel(b, mh)}`,
        observed_low: valueLabel(b, ml),
        observed_high: valueLabel(b, mh),
        gap: round(mh - ml, 1),
      };
    } else {
      counterfactual = {
        condition: `Today's ${capName(a).toLowerCase()} is on the high side`,
        prediction: `your ${capName(b).toLowerCase()} should land near ${valueLabel(b, mh)}`,
        observed_low: valueLabel(b, ml),
        observed_high: valueLabel(b, mh),
        gap: round(mh - ml, 1),
      };
    }
  } else {
    counterfactual = {
      condition: `If you log a strong ${capName(a).toLowerCase()} today`,
      prediction: `your ${capName(b).toLowerCase()} should follow toward ${valueLabel(b, mh)}`,
      observed_low: valueLabel(b, ml),
      observed_high: valueLabel(b, mh),
      gap: round(mh - ml, 1),
    };
  }

  const experiment = experimentFor(a, b, mh, ml);

  // Days remaining to unlock full confidence (for locked-insight mechanic)
  const daysToConfirm = Math.max(0, 10 - n);

  return {
    id: `f_${a}_${b}`,
    a, b,
    a_label: capName(a), b_label: capName(b),
    statement: `Your ${capName(a).toLowerCase()} ${strength} ${direction} your ${capName(b).toLowerCase()}.`,
    detail: `On ${highB.length} matched days when your ${a} was on the high side, your ${b} averaged ${valueLabel(b, mh)} — vs ${valueLabel(b, ml)} on the ${lowB.length} low days.`,
    effect: { d: round(d, 2), low_mean: round(ml, 1), high_mean: round(mh, 1), median_a: round(median, 1), n },
    confidence: Math.min(0.95, 0.4 + (Math.abs(d) * 0.3) + Math.min(0.15, n / 100)),
    confidence_label: clabel,
    days_to_confirm: daysToConfirm,
    chart_points: chartPoints,
    day_records: sortedDays.reverse(),
    counterfactual,
    experiment,
  };
}

const EXPERIMENT_TEMPLATES = {
  sleep_mind:   (mh) => ({ label: 'Hold a 10:30 PM wind-down for 7 days', detail: `Mood should land near ${valueLabel('mind', mh)} the next day. We'll grade it on day 8.` }),
  fitness_sleep:(mh) => ({ label: 'Train AM 3× this week', detail: `Sleep should run 30+ min deeper on those nights. We'll measure.` }),
  water_mind:   (mh) => ({ label: 'Hit 2L of water by 6 PM, 5 days', detail: `Mood should average near ${valueLabel('mind', mh)} on hit days.` }),
  nutrition_mind:(mh) => ({ label: 'Eat 30g protein at breakfast for 5 days', detail: `Afternoon mood should hold near ${valueLabel('mind', mh)}.` }),
  fasting_mind: (mh) => ({ label: 'Hold a 14h fast for 5 days', detail: `Energy + mood should track near ${valueLabel('mind', mh)}.` }),
  sleep_fitness:(mh) => ({ label: 'Sleep 7+ hours for 5 nights', detail: `Workout duration should rise toward ${Math.round(mh)} min.` }),
  fitness_mind: (mh) => ({ label: 'Move 30+ min daily for 5 days', detail: `Mood should land near ${valueLabel('mind', mh)} on training days.` }),
  water_fitness:(mh) => ({ label: 'Drink 500ml before every workout for 1 week', detail: `Workout performance should improve toward ${Math.round(mh)} min.` }),
  fasting_nutrition:(mh) => ({ label: 'Break your fast with 40g protein for 5 days', detail: `Daily protein should land near ${Math.round(mh)}g.` }),
};
function experimentFor(a, b, mh, ml) {
  const key = `${a}_${b}`;
  const tpl = EXPERIMENT_TEMPLATES[key];
  if (tpl) return tpl(mh);
  return { label: `Test more ${capName(a).toLowerCase()} this week`, detail: `Track how it shows up in your ${capName(b).toLowerCase()}.` };
}

// Build all pending pair candidates (for LockableInsight mechanic)
// Returns pairs that have data but haven't met the threshold yet
function buildPendingPairs(ctx) {
  const pairs = [
    ['sleep', 'mind'], ['fitness', 'sleep'], ['water', 'mind'],
    ['nutrition', 'mind'], ['fasting', 'mind'], ['sleep', 'fitness'],
    ['fitness', 'mind'], ['water', 'fitness'], ['fasting', 'nutrition'],
  ];
  const pending = [];
  for (const [a, b] of pairs) {
    const aLogs = ctx.recent_logs?.[a] || [];
    const bLogs = ctx.recent_logs?.[b] || [];
    const aSetup = ctx.setup_state?.[a] === 'setup';
    const bSetup = ctx.setup_state?.[b] === 'setup';
    if (!aSetup || !bSetup) continue;

    // Find co-logged days
    const aDates = new Set((aLogs).map(l => l.date).filter(Boolean));
    const bDates = new Set((bLogs).map(l => l.date).filter(Boolean));
    const coLogged = [...aDates].filter(d => bDates.has(d)).length;
    const needed = 10;

    if (coLogged < 3) {
      // Not enough data for any finding yet — fully locked
      pending.push({ a, b, co_logged: coLogged, needed, locked: true });
    }
    // If coLogged >= 3 but finding was null (effect too small), skip — finding engine handles those
  }
  return pending;
}

// PUBLIC: build top 5 findings ranked by |d|
function buildFindings(ctx) {
  const pairs = [
    ['sleep', 'mind'], ['fitness', 'sleep'], ['water', 'mind'],
    ['nutrition', 'mind'], ['fasting', 'mind'], ['sleep', 'fitness'],
    ['fitness', 'mind'], ['water', 'fitness'], ['fasting', 'nutrition'],
  ];
  const out = [];
  for (const [a, b] of pairs) {
    const f = buildPairFinding(ctx, a, b);
    if (f) out.push(f);
  }
  out.sort((x, y) => Math.abs(y.effect.d) - Math.abs(x.effect.d));
  return out.slice(0, 5);
}

module.exports = { buildFindings, buildPendingPairs };
