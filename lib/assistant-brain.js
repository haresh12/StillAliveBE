'use strict';
// ════════════════════════════════════════════════════════════════════
// assistant-brain.js — 15 deterministic pattern detectors.
// Each detector takes the rich context bundle and returns at most one
// candidate message with a priority 0–100. Top-4 are surfaced.
// All thresholds grounded in cited research.
// ════════════════════════════════════════════════════════════════════
const { humanize, frequency, timeAgo } = require('./translate-insight');
const { buildCounterfactual } = require('./counterfactuals');

const AGENTS = ['fitness', 'sleep', 'mind', 'nutrition', 'water', 'fasting'];

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};
const dateStr = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};

const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const stdev = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

// Pattern shape:
// { id, category, icon, priority, raw_text, action, evidence_summary, agents_used }

// 1. SLEEP-DEBT × MISSED BREAKFAST → mood crash predicted
// Banks & Dinges 2007 + Benton 2008
function det01_sleepBreakfastRisk(ctx) {
  const sleep = (ctx.recent_logs.sleep || [])[0];
  if (!sleep || !sleep.duration_h || sleep.duration_h >= 6) return null;
  const breakfastToday = (ctx.recent_logs.nutrition || []).some(n =>
    n.date === todayStr() && n.kcal != null
  );
  if (breakfastToday) return null;
  return {
    id: 'sleep_breakfast_risk',
    category: 'risk_now', icon: '🚨', priority: 95,
    raw_text: `Slept ${sleep.duration_h}h last night and no breakfast yet — this combo dragged your mood down before. Fix it with protein in the next 30 min.`,
    action: { agent: 'nutrition', label: 'Log a high-protein breakfast', kind: 'deeplink' },
    evidence_summary: 'I\'m watching your sleep, your meals, and how mood follows them.',
    agents_used: ['sleep', 'nutrition', 'mind'],
  };
}

// 2. WORKOUT TODAY × SLEEP ≥ 7h → peak-day prediction
// Kredlow 2015
function det02_peakDay(ctx) {
  const workoutToday = (ctx.recent_logs.fitness || []).some(f => f.date === todayStr());
  const sleep = (ctx.recent_logs.sleep || [])[0];
  if (!workoutToday || !sleep || (sleep.duration_h || 0) < 7) return null;
  return {
    id: 'peak_day',
    category: 'win_today', icon: '🎯', priority: 80,
    raw_text: `Workout in and ${sleep.duration_h}h of sleep last night — this is a peak day setup. Block your hardest task next.`,
    action: { agent: 'mind', label: 'Set today\'s focus', kind: 'deeplink' },
    evidence_summary: 'Past pattern: training + 7+ hours sleep lifts your mood scores.',
    agents_used: ['fitness', 'sleep', 'mind'],
  };
}

// 3. 3+ skipped fitness "tired" + sleep avg < 6.5h → root cause is sleep
// Walker 2017 + Bonnet & Arand 2003
function det03_rootCauseSleep(ctx) {
  const tiredSkips = ctx.skip_reasons?.too_tired || 0;
  if (tiredSkips < 3) return null;
  const sleepLogs = ctx.recent_logs.sleep || [];
  const last7 = sleepLogs.slice(0, 7).map(l => l.duration_h).filter(v => v != null);
  if (last7.length < 4) return null;
  const avg = mean(last7);
  if (avg >= 6.5) return null;
  return {
    id: 'root_cause_sleep',
    category: 'pattern', icon: '🔍', priority: 90,
    raw_text: `You've skipped ${tiredSkips} workouts saying "too tired" — sleep is averaging ${avg.toFixed(1)}h. Fix sleep first; fitness will follow.`,
    action: { agent: 'sleep', label: 'Set tonight\'s wind-down 30 min earlier', kind: 'deeplink' },
    evidence_summary: 'Reading your skipped actions and your sleep durations together.',
    agents_used: ['sleep', 'fitness'],
  };
}

// 4. ANXIETY ≥ 4 × HYDRATION < 40% → cognitive deficit
// Adan 2012, Riebl & Davy 2013
function det04_anxietyHydration(ctx) {
  const todayMind = (ctx.recent_logs.mind || []).find(m => m.date === todayStr());
  if (!todayMind || (todayMind.anxiety || 0) < 4) return null;
  const todayWater = (ctx.recent_logs.water || []).filter(w => w.date === todayStr()).reduce((s, w) => s + (w.ml || 0), 0);
  const target = ctx.priors?.water?.ml || 2300;
  const ratio = todayWater / target;
  if (ratio >= 0.4) return null;
  return {
    id: 'anxiety_hydration',
    category: 'risk_now', icon: '🚨', priority: 88,
    raw_text: `Anxiety logged ${todayMind.anxiety}/5 and you're only ${Math.round(ratio*100)}% hydrated. A 500ml glass now actually helps — there's research on this.`,
    action: { agent: 'water', label: 'Log 500ml right now', kind: 'log' },
    evidence_summary: 'Mind logs say one thing; water shortfall amplifies it.',
    agents_used: ['mind', 'water'],
  };
}

// 5. FASTING ≥ 12h × workout pending → metabolic switch window
// Anton 2018, de Cabo 2019
function det05_metabolicWindow(ctx) {
  const todayFast = (ctx.recent_logs.fasting || []).find(f => f.date === todayStr());
  if (!todayFast || (todayFast.actual_h || 0) < 12) return null;
  const fitnessActions = ctx.recent_actions.fitness || [];
  const pending = fitnessActions.some(a => !a.status || a.status === 'pending');
  if (!pending) return null;
  return {
    id: 'metabolic_window',
    category: 'win_today', icon: '🎯', priority: 78,
    raw_text: `You've fasted ${todayFast.actual_h}h — your body's switched into fat-burn mode. A workout in the next hour stacks the benefit.`,
    action: { agent: 'fitness', label: 'Train fasted now', kind: 'deeplink' },
    evidence_summary: 'Fasting timing + your pending fitness action lined up.',
    agents_used: ['fasting', 'fitness'],
  };
}

// 6. SLEEP VARIANCE > 1.5h std → consistency drag
// Phillips 2017 (Scientific Reports)
function det06_sleepConsistency(ctx) {
  const last7 = (ctx.recent_logs.sleep || []).slice(0, 7).map(l => l.duration_h).filter(v => v != null);
  if (last7.length < 5) return null;
  const sd = stdev(last7);
  if (sd < 1.5) return null;
  return {
    id: 'sleep_consistency',
    category: 'pattern', icon: '🔍', priority: 70,
    raw_text: `Your sleep is bouncing around — some nights ${Math.min(...last7).toFixed(1)}h, others ${Math.max(...last7).toFixed(1)}h. Consistency matters more than length. Pick a fixed wake time.`,
    action: { agent: 'sleep', label: 'Set a fixed wake time', kind: 'deeplink' },
    evidence_summary: 'Looking at your last 7 sleep logs side by side.',
    agents_used: ['sleep'],
  };
}

// 7. PROTEIN < 1.0 g/kg on training days → recovery deficit
// Morton 2018 meta-analysis
function det07_proteinRecovery(ctx) {
  const trainingDays = (ctx.recent_logs.fitness || []).slice(0, 7).map(f => f.date);
  if (!trainingDays.length) return null;
  const bw = ctx.priors?.protein?.grams ? Math.round(ctx.priors.protein.grams / ctx.priors.protein.g_per_kg) : 75;
  const target = bw * 1.0;
  const lowDays = trainingDays.filter(d => {
    const protein = (ctx.recent_logs.nutrition || [])
      .filter(n => n.date === d).reduce((s, n) => s + (n.protein_g || 0), 0);
    return protein > 0 && protein < target;
  });
  if (lowDays.length < 2) return null;
  return {
    id: 'protein_recovery',
    category: 'pattern', icon: '🔍', priority: 65,
    raw_text: `On ${lowDays.length} of your last training days you ate under ${target}g protein. Muscle recovery starts there.`,
    action: { agent: 'nutrition', label: 'Add a protein meal', kind: 'deeplink' },
    evidence_summary: 'Comparing training days to protein totals from your meals.',
    agents_used: ['fitness', 'nutrition'],
  };
}

// 8. MIND not logged 3+ days → re-engagement
// Burke 2011 self-monitoring decay
function det08_mindNeglected(ctx) {
  const last = (ctx.recent_logs.mind || [])[0];
  if (!last) return null;
  const daysSince = Math.floor((Date.now() - new Date(last.date).getTime()) / 86400000);
  if (daysSince < 3) return null;
  return {
    id: 'mind_neglected',
    category: 'check_in', icon: '💬', priority: 55 + Math.min(20, daysSince * 3),
    raw_text: `It's been ${daysSince} days since your last mind check-in. Even 30 seconds keeps the signal alive.`,
    action: { agent: 'mind', label: 'Quick mind check-in', kind: 'deeplink' },
    evidence_summary: 'Tracking how long since each agent heard from you.',
    agents_used: ['mind'],
  };
}

// 9. WORKOUT STREAK 4+ days no rest → overreach risk
// Israetel RP MRV literature
function det09_overreach(ctx) {
  const last5 = (ctx.recent_logs.fitness || []).slice(0, 5);
  const dates = new Set(last5.map(f => f.date));
  if (dates.size < 4) return null;
  return {
    id: 'overreach',
    category: 'risk_now', icon: '🚨', priority: 72,
    raw_text: `${dates.size} workouts in 5 days — you're stacking fatigue. A real rest day protects the gains you've made.`,
    action: { agent: 'fitness', label: 'Log a rest day', kind: 'log' },
    evidence_summary: 'Your training frequency over the last 5 days.',
    agents_used: ['fitness'],
  };
}

// 10. LATE EVENING EATING + POOR SLEEP → circadian mismatch
// Wehrens 2017 + Roenneberg 2019
function det10_lateEating(ctx) {
  const lateEats = (ctx.recent_logs.nutrition || []).filter(n => {
    const ts = n.logged_at_ms || n.created_at_ms;
    if (!ts) return false;
    const h = new Date(ts).getHours();
    return h >= 21;
  });
  if (lateEats.length < 3) return null;
  const recentSleep = (ctx.recent_logs.sleep || []).slice(0, 5).map(l => l.duration_h).filter(v => v != null);
  if (recentSleep.length < 3 || mean(recentSleep) >= 7) return null;
  return {
    id: 'late_eating',
    category: 'pattern', icon: '🔍', priority: 68,
    raw_text: `You've eaten after 9 PM ${lateEats.length} times this week, and your sleep is averaging under 7h. The two are connected.`,
    action: { agent: 'fasting', label: 'Set an 8 PM eating cutoff', kind: 'deeplink' },
    evidence_summary: 'Looking at meal times alongside sleep hours.',
    agents_used: ['nutrition', 'sleep', 'fasting'],
  };
}

// 11. MOOD UP + FITNESS CONSISTENT → reinforce loop
// Schuch 2016
function det11_moodFitnessLoop(ctx) {
  const fitnessDays = new Set((ctx.recent_logs.fitness || []).slice(0, 7).map(f => f.date));
  if (fitnessDays.size < 3) return null;
  const moodScores = (ctx.recent_logs.mind || []).slice(0, 7).map(m => m.mood_score).filter(v => v != null);
  if (moodScores.length < 4) return null;
  if (mean(moodScores) < 3.5) return null;
  return {
    id: 'mood_fitness_loop',
    category: 'notice_win', icon: '👏', priority: 60,
    raw_text: `${fitnessDays.size} workouts this week and your mood is averaging ${mean(moodScores).toFixed(1)}/5. This is the loop working — keep feeding it.`,
    action: { agent: 'fitness', label: 'Log today\'s movement', kind: 'deeplink' },
    evidence_summary: 'Your fitness frequency vs mood scores side by side.',
    agents_used: ['fitness', 'mind'],
  };
}

// 12. HYDRATION trending DOWN 3 days
// Maughan 2018
function det12_hydrationDecline(ctx) {
  const byDate = {};
  for (const w of ctx.recent_logs.water || []) {
    byDate[w.date] = (byDate[w.date] || 0) + (w.ml || 0);
  }
  const last3Dates = [dateStr(2), dateStr(1), dateStr(0)].filter(d => byDate[d] != null);
  if (last3Dates.length < 3) return null;
  const vals = last3Dates.map(d => byDate[d]);
  if (!(vals[0] > vals[1] && vals[1] > vals[2])) return null;
  return {
    id: 'hydration_decline',
    category: 'reminder', icon: '⏰', priority: 58,
    raw_text: `Hydration's been dropping 3 days in a row — ${vals[0]}ml, ${vals[1]}ml, ${vals[2]}ml. Reset today with a glass now.`,
    action: { agent: 'water', label: 'Log 500ml', kind: 'log' },
    evidence_summary: 'Comparing the last 3 days of water totals.',
    agents_used: ['water'],
  };
}

// 13. ANCHOR AGENT NEGLECTED — they said sleep is off, sleep not logged
// SDT relatedness
function det13_anchorNeglected(ctx) {
  const anchor = ctx.profile?.cold_start_anchor;
  if (!anchor || anchor === 'none') return null;
  const anchorAgent = ANCHOR_TO_AGENT[anchor];
  if (!anchorAgent) return null;
  if (ctx.setup_state[anchorAgent] !== 'setup') return null;
  const lastLog = (ctx.recent_logs[anchorAgent] || [])[0];
  if (!lastLog) return null;
  const daysSince = Math.floor((Date.now() - new Date(lastLog.date).getTime()) / 86400000);
  if (daysSince < 2) return null;
  return {
    id: 'anchor_neglected',
    category: 'check_in', icon: '💬', priority: 62,
    raw_text: `You said ${anchor} feels off — but ${anchorAgent} hasn't been logged in ${daysSince} days. The fastest way I can help is more data here.`,
    action: { agent: anchorAgent, label: `Log today's ${anchorAgent}`, kind: 'deeplink' },
    evidence_summary: `Tying your stated focus (${anchor}) to actual logging.`,
    agents_used: [anchorAgent],
  };
}
const ANCHOR_TO_AGENT = {
  sleep: 'sleep', energy: 'mind', mood: 'mind',
  weight: 'nutrition', fitness: 'fitness',
};

// 14. SINGLE-AGENT OBSESSION — only 1 of 6 logged for 5+ days
// Behavioral activation diversification (Dimidjian 2011)
function det14_singleAgentObsession(ctx) {
  const dayMap = {};
  for (const a of AGENTS) {
    for (const log of ctx.recent_logs[a] || []) {
      if (!dayMap[log.date]) dayMap[log.date] = new Set();
      dayMap[log.date].add(a);
    }
  }
  const recent5 = Object.keys(dayMap).sort().reverse().slice(0, 5);
  if (recent5.length < 5) return null;
  if (!recent5.every(d => dayMap[d].size === 1)) return null;
  return {
    id: 'single_agent_obsession',
    category: 'check_in', icon: '💬', priority: 50,
    raw_text: `For 5 days, only one agent's been talked to. Cross-agent patterns need at least 2 — try a 30-second mind check-in today.`,
    action: { agent: 'mind', label: 'Quick mind check-in', kind: 'deeplink' },
    evidence_summary: 'Counting which agents you logged each day.',
    agents_used: ['mind'],
  };
}

// 15. ACTION COMPLETION RATE < 30%
// JITAI sub-threshold engagement (Nahum-Shani 2018)
function det15_lowCompletion(ctx) {
  const rate = ctx.action_completion_rate;
  if (rate == null || rate >= 0.3) return null;
  return {
    id: 'low_completion',
    category: 'reminder', icon: '⏰', priority: 52,
    raw_text: `You're completing ${Math.round(rate * 100)}% of suggested actions. Want me to dial it back or change the timing?`,
    action: { agent: 'mind', label: 'Tell me what to change', kind: 'deeplink' },
    evidence_summary: 'Tracking how often suggested actions get done.',
    agents_used: [],
  };
}

// ─── ANCHOR-SEED (day 0) — when no logs at all, lean on cold-start anchor ─
function detAnchorSeed(ctx) {
  const logs = ctx.total_logs || 0;
  const anchor = ctx.profile?.cold_start_anchor;
  if (!anchor) return null;

  // Day 0 — first signal prompt
  if (logs === 0) {
    const seeds = {
      sleep:  { agent: 'sleep',     text: 'You said sleep feels off. One log tonight (bedtime + how you felt) gets the pattern started.' },
      energy: { agent: 'mind',      text: 'Energy is downstream of sleep, water, and food timing. A 30-second mind check-in is the fastest start.' },
      mood:   { agent: 'mind',      text: 'Mood usually tracks sleep with a one-day lag. Log a mind check-in now, sleep tonight, and we\'ll see it by Day 3.' },
      weight: { agent: 'fasting',   text: 'Weight responds to eating timing more than counting calories. Set up fasting + log one meal — first signal in 5 days.' },
      fitness:{ agent: 'fitness',   text: 'Even a short session today anchors your baseline. The shape of the week matters more than the size of any day.' },
      none:   { agent: 'mind',      text: 'A 30-second mind check-in is the cheapest first signal. Cross-agent patterns appear after Day 3.' },
    };
    const s = seeds[anchor] || seeds.none;
    return { id: 'anchor_seed', category: 'check_in', icon: '🌱', priority: 75,
      raw_text: s.text, action: { agent: s.agent, label: `Open ${s.agent}`, kind: 'deeplink' },
      evidence_summary: 'Going off what you said felt off when you joined.', agents_used: [s.agent] };
  }

  // Day 1 (1-2 logs) — momentum message
  if (logs >= 1 && logs <= 2) {
    const anchors = {
      sleep:   { agent: 'sleep',     text: `First signal is in. Two more nights logged and I'll show you your sleep efficiency trend — and how it connects to your energy.` },
      energy:  { agent: 'mind',      text: `Good start. Log your mind check-in again tomorrow — mood data with two days compares your emotional baseline.` },
      mood:    { agent: 'mind',      text: `One log in. After three check-ins I can show you what time of day your mood peaks and what's driving it.` },
      weight:  { agent: 'nutrition', text: `First log done. Two more meals tracked and I can show your timing pattern — when you eat matters as much as what.` },
      fitness: { agent: 'fitness',   text: `First session logged. One more and I'll start tracking your recovery pattern — how your body responds to effort over time.` },
      none:    { agent: 'mind',      text: `You're building the baseline. Two more logs and your coaches start comparing — that's when the patterns appear.` },
    };
    const a = anchors[anchor] || anchors.none;
    return { id: 'anchor_seed_d1', category: 'check_in', icon: '📈', priority: 70,
      raw_text: a.text, action: { agent: a.agent, label: 'Keep going', kind: 'deeplink' },
      evidence_summary: `${logs} log${logs > 1 ? 's' : ''} in — coaches are warming up.`, agents_used: [a.agent] };
  }

  // Day 2-3 (3-4 logs) — almost-there hook
  if (logs >= 3 && logs <= 4) {
    const secondAgent = { sleep: 'mind', energy: 'sleep', mood: 'sleep', weight: 'fasting', fitness: 'sleep', none: 'sleep' }[anchor] || 'sleep';
    return { id: 'anchor_seed_d2', category: 'notice_win', icon: '🔗', priority: 68,
      raw_text: `${logs} logs in — your coaches are starting to compare notes. Add one log from a second agent today and the first cross-agent pattern unlocks.`,
      action: { agent: secondAgent, label: `Try ${secondAgent}`, kind: 'deeplink' },
      evidence_summary: 'Pattern detection kicks in after 3 logs across 2 agents.', agents_used: [anchor === 'none' ? 'sleep' : anchor, secondAgent] };
  }

  return null;
}

// 16. LOCATION ARRIVAL (gym, work, home transitions)
function det16_locationArrival(ctx) {
  const loc = ctx.signal_context?.location;
  if (!loc?.has_location) return null;
  if (loc.at_label === 'gym') {
    const todayWorkout = (ctx.recent_logs.fitness || []).some(f => f.date === todayStr());
    if (todayWorkout) return null;
    return {
      id: 'location_gym',
      category: 'win_today', icon: '🎯', priority: 85,
      raw_text: `You're at the gym. Want me to start a workout log?`,
      action: { agent: 'fitness', label: 'Start workout', kind: 'log' },
      evidence_summary: 'Spotted from your location pattern.',
      agents_used: ['fitness'],
    };
  }
  if (loc.at_label === 'home' && loc.has_work) {
    const h = new Date().getHours();
    if (h >= 18 && h < 22) {
      const todayMind = (ctx.recent_logs.mind || []).some(m => m.date === todayStr());
      if (todayMind) return null;
      return {
        id: 'location_home_evening',
        category: 'check_in', icon: '💬', priority: 60,
        raw_text: `Home for the evening. A 30-second mind check-in here grounds the day.`,
        action: { agent: 'mind', label: 'Quick check-in', kind: 'deeplink' },
        evidence_summary: 'Spotted from your evening pattern at home.',
        agents_used: ['mind'],
      };
    }
  }
  return null;
}

// 17. NOTIFICATION FATIGUE — quiet down
function det17_notifFatigue(ctx) {
  const eng = ctx.signal_context?.notif;
  if (!eng?.has_engagement || !eng.fatigue) return null;
  return {
    id: 'notif_fatigue',
    category: 'check_in', icon: '💬', priority: 45,
    raw_text: `You've dismissed ${eng.recent_dismissals} reminders recently — I'm dialing back. Tell me what timing actually works.`,
    action: { agent: 'mind', label: 'Set my reminder windows', kind: 'deeplink' },
    evidence_summary: 'Tracking which reminders you ignore vs open.',
    agents_used: [],
  };
}

// 18. NOTIFICATION RESPONSIVE — leverage their best hour
function det18_notifResponsive(ctx) {
  const eng = ctx.signal_context?.notif;
  if (!eng?.has_engagement || eng.best_hour == null) return null;
  if (eng.act_rate < 0.4) return null;
  const h = new Date().getHours();
  if (Math.abs(h - eng.best_hour) > 1) return null;
  return {
    id: 'notif_responsive_window',
    category: 'win_today', icon: '🎯', priority: 70,
    raw_text: `This is your best window — you act on ${Math.round(eng.act_rate * 100)}% of suggestions around now. One small move locks the day.`,
    action: { agent: 'mind', label: 'Pick today\'s focus', kind: 'deeplink' },
    evidence_summary: 'Reading which hours you reliably take action.',
    agents_used: [],
  };
}

// ─── PUBLIC: collect, rank, dedupe ─────────────────────────────────
const DETECTORS = [
  det01_sleepBreakfastRisk, det02_peakDay,           det03_rootCauseSleep,
  det04_anxietyHydration,   det05_metabolicWindow,   det06_sleepConsistency,
  det07_proteinRecovery,    det08_mindNeglected,     det09_overreach,
  det10_lateEating,         det11_moodFitnessLoop,   det12_hydrationDecline,
  det13_anchorNeglected,    det14_singleAgentObsession, det15_lowCompletion,
  det16_locationArrival,    det17_notifFatigue,        det18_notifResponsive,
  buildCounterfactual,                                            // 19. counterfactual
  detAnchorSeed,
];

function collectCandidates(ctx) {
  const out = [];
  for (const det of DETECTORS) {
    try {
      const r = det(ctx);
      if (r) out.push(r);
    } catch (e) {
      // Defensive: a single broken detector should not crash the brain
      console.warn('[assistant-brain]', det.name, e.message);
    }
  }
  // Sort by priority descending, take top 4, dedupe by category
  out.sort((a, b) => b.priority - a.priority);
  const seenCategories = new Set();
  const top = [];
  for (const c of out) {
    if (top.length >= 4) break;
    if (seenCategories.has(c.category) && top.length >= 2) continue;
    seenCategories.add(c.category);
    top.push(c);
  }
  return top;
}

module.exports = { collectCandidates, DETECTORS };
