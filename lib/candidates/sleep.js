"use strict";
// Sleep candidate engine — uses ONLY sleep_logs data.

function getMs(v) { return v?.toMillis ? v.toMillis() : new Date(v||0).getTime(); }
function dateOnly(ms) { const d = new Date(ms); d.setHours(0,0,0,0); return d.getTime(); }

async function computeSleepCandidates(logs, setup) {
  const candidates = [];
  if (!Array.isArray(logs)) return candidates;
  const now = Date.now();
  const today = new Date(); today.setHours(0,0,0,0);

  const sorted = [...logs].sort((a,b) => getMs(b.logged_at) - getMs(a.logged_at));
  const targetHours = Number(setup?.target_hours || setup?.sleep_target_hours || 7.5);

  // ── WIN_BACK — no log 3+ days ──
  if (sorted.length === 0) {
    candidates.push({
      archetype: "win_back",
      score: 95, category: "sleep",
      proof: { metric: "days_since_log", value: 999, threshold: 3, citation: "Walker 2017" },
      proof_text: "No sleep logs yet. Tracking is the prerequisite for optimization.",
      surprise_hook: "First log unlocks the whole coach.",
      target: { kind: "log" }, success_type: "log_session", when_to_do: "today", impact: 3,
    });
  } else {
    const days = Math.floor((today - dateOnly(getMs(sorted[0].logged_at))) / 86400000);
    if (days >= 3) {
      candidates.push({
        archetype: "win_back",
        score: Math.min(95, 50 + days*8), category: "sleep",
        proof: { metric: "days_since_log", value: days, threshold: 3, citation: "Walker 2017" },
        proof_text: `${days} days since last sleep log. Pattern data needs daily input.`,
        surprise_hook: `${days} nights uncounted — your pattern data is decaying.`,
        target: { kind: "log" }, success_type: "log_session", when_to_do: "today", impact: 2,
      });
    }
  }

  // ── PREVENT — bedtime variance > 60min over last 5 ──
  // Source: Walker (Why We Sleep) — circadian rhythm needs ±30min consistency
  const last5 = sorted.slice(0, 5);
  if (last5.length >= 5) {
    const bedtimes = last5.map(l => {
      const t = (l.bedtime || "23:00").split(":").map(Number);
      return t[0]*60 + (t[1]||0); // minutes from midnight
    });
    // Normalize for cross-midnight
    const mean = bedtimes.reduce((a,b)=>a+b,0) / bedtimes.length;
    const variance = bedtimes.reduce((s,t) => s + (t-mean)**2, 0) / bedtimes.length;
    const std = Math.sqrt(variance);
    if (std > 60) {
      candidates.push({
        archetype: "prevent",
        score: Math.min(85, Math.round(std)), category: "sleep",
        proof: { metric: "bedtime_std_min", value: Math.round(std), threshold: 30, citation: "Walker 2017" },
        proof_text: `Bedtime varies ±${Math.round(std)} min across 5 nights. Circadian rhythm needs ±30min.`,
        surprise_hook: `Your bedtime swings ${Math.round(std)} minutes — circadian chaos.`,
        target: { kind: "consistent_bedtime", window_min: 30 },
        success_type: "improve_bedtime_consistency", when_to_do: "this_week", impact: 3,
      });
    }
  }

  // ── BREAKTHROUGH — efficiency improving toward target ──
  if (sorted.length >= 5) {
    const effs = sorted.slice(0, 5).map(l => Number(l.sleep_efficiency || l.efficiency || 0)).reverse();
    const slope = (effs[effs.length-1] - effs[0]) / (effs.length - 1);
    if (slope > 1) {
      candidates.push({
        archetype: "breakthrough",
        score: Math.min(80, 50 + Math.round(slope*5)), category: "sleep",
        proof: { metric: "efficiency_slope", value: Math.round(slope*10)/10, threshold: 1, citation: "Spielman CBT-I model" },
        proof_text: `Efficiency climbing ${Math.round(slope*10)/10}%/log. Push toward 85% (sleep-medicine target).`,
        surprise_hook: `Efficiency up ${Math.round(slope*10)/10}% per night — keep the momentum.`,
        target: { metric: "sleep_efficiency", target_value: 85 },
        success_type: "hit_efficiency", when_to_do: "this_week", impact: 2,
      });
    }
  }

  // ── PROGRESS — hit target hours 5+ in last 7 ──
  const last7 = sorted.slice(0, 7);
  const hitTarget = last7.filter(l => Number(l.duration_hours || l.duration || 0) >= targetHours).length;
  if (last7.length >= 5 && hitTarget >= 5) {
    candidates.push({
      archetype: "progress",
      score: 70, category: "sleep",
      proof: { metric: "nights_at_target", value: hitTarget, threshold: 5, citation: "Hirshkowitz 2015 NSF" },
      proof_text: `${hitTarget}/7 nights ≥${targetHours}h. Push to ${(targetHours+0.5).toFixed(1)}h next week.`,
      surprise_hook: `${hitTarget}/7 nights at target — try +30 min.`,
      target: { metric: "duration_hours", target_value: targetHours + 0.5 },
      success_type: "hit_efficiency", when_to_do: "this_week", impact: 2,
    });
  }

  // ── RECOVER — sleep debt > 5h ──
  // Source: Banks & Dinges 2007 — chronic restriction → cumulative impairment
  const debtLast7 = last7.reduce((s,l) => s + Math.max(0, targetHours - Number(l.duration_hours || l.duration || 0)), 0);
  if (debtLast7 >= 5) {
    candidates.push({
      archetype: "recover",
      score: Math.min(85, 50 + Math.round(debtLast7*4)), category: "sleep",
      proof: { metric: "sleep_debt_hours_7d", value: Math.round(debtLast7*10)/10, threshold: 5, citation: "Banks & Dinges 2007" },
      proof_text: `${Math.round(debtLast7*10)/10}h sleep debt last 7 nights. Cognitive deficit accumulates past 5h.`,
      surprise_hook: `You're carrying ${Math.round(debtLast7)}h of sleep debt.`,
      target: { metric: "duration_hours", target_value: targetHours + 1 },
      success_type: "log_session", when_to_do: "today", impact: 3,
    });
  }

  // ── EXPLORE — only weekday logs (no weekend data) ──
  const weekendLogs = sorted.slice(0, 14).filter(l => {
    const d = new Date(getMs(l.logged_at)).getDay();
    return d === 0 || d === 6;
  }).length;
  if (sorted.length >= 7 && weekendLogs === 0) {
    candidates.push({
      archetype: "explore",
      score: 50, category: "sleep",
      proof: { metric: "weekend_logs_14d", value: 0, threshold: 1, citation: "Wittmann 2006 social jetlag" },
      proof_text: "Zero weekend logs in 14 days. Weekend sleep reveals your true chronotype.",
      surprise_hook: "Weekends are missing — your real chronotype is hidden.",
      target: { kind: "weekend_log" }, success_type: "log_session", when_to_do: "this_week", impact: 1,
    });
  }

  // ── MICRO ──
  candidates.push({
    archetype: "micro",
    score: 30, category: "sleep",
    proof: { metric: "wake_log", value: 0, threshold: 1 },
    proof_text: "Log wake time within 30min of waking. Memory of overnight wake-ups fades fast.",
    surprise_hook: "Log within 30 min of waking — accuracy doubles.",
    target: { kind: "morning_log" }, success_type: "log_session", when_to_do: "today", impact: 1,
  });

  // ════════════════════════════════════════════════════════════════
  // SETUP-DRIVEN ARCHETYPES — fire from the user's setup answers even
  // when there are zero logs yet. These make the FIRST 3 actions deeply
  // personalized to what they just told us in setup.
  // ════════════════════════════════════════════════════════════════
  const problem = setup?.primary_problem || '';
  const disruptors = setup?.disruptors || [];
  const chronotype = setup?.chronotype || '';
  const targetBed = setup?.target_bedtime || '23:00';
  const targetWake = setup?.target_wake_time || '07:00';

  // (A) PRIMARY PROBLEM-DRIVEN — anchor the first plan to what they told us
  if (problem === 'Trouble falling asleep' || problem === 'Racing mind at bedtime') {
    candidates.push({
      archetype: "wind_down_5",
      score: 88, category: "sleep",
      proof: { metric: "primary_problem", value: 1, threshold: 1 },
      proof_text: `You flagged ${problem.toLowerCase()} as your main thing. A 5-minute slow breath before lights-out is the smallest dose that helps.`,
      surprise_hook: "5 minutes of slow breath before bed — measurable shift.",
      target: { kind: "breathing_session", target_value: 1 },
      success_type: "complete_breathing", when_to_do: "tonight", impact: 3,
    });
  }
  if (problem === 'Inconsistent sleep schedule') {
    candidates.push({
      archetype: "consistent_wake",
      score: 90, category: "sleep",
      proof: { metric: "primary_problem", value: 1, threshold: 1 },
      proof_text: `Schedule consistency is your focus. Lock ${targetWake} as your daily wake time — same on weekends.`,
      surprise_hook: `Same wake time daily — including weekends.`,
      target: { kind: "wake_time", target_value: targetWake },
      success_type: "consistent_wake", when_to_do: "this_week", impact: 3,
    });
  }
  if (problem === 'Waking up through the night') {
    candidates.push({
      archetype: "cool_room",
      score: 78, category: "sleep",
      proof: { metric: "primary_problem", value: 1, threshold: 1 },
      proof_text: "Night wakings often track with room temperature. 65-68°F is the deep-sleep sweet spot.",
      surprise_hook: "Drop your room 1-2 degrees tonight.",
      target: { kind: "thermostat", target_value: 67 },
      success_type: "complete_action", when_to_do: "tonight", impact: 2,
    });
  }
  if (problem === 'Early morning waking') {
    candidates.push({
      archetype: "evening_dim",
      score: 76, category: "sleep",
      proof: { metric: "primary_problem", value: 1, threshold: 1 },
      proof_text: "Early waking often means circadian phase advance. Dim lights 90 min before bed to push it back.",
      surprise_hook: "Dim everything 90 min before bed.",
      target: { kind: "evening_dim", target_value: 1 },
      success_type: "complete_action", when_to_do: "tonight", impact: 2,
    });
  }

  // (B) DISRUPTOR-DRIVEN — the user already named what gets in their way
  if (disruptors.includes('Caffeine too late')) {
    candidates.push({
      archetype: "caffeine_cutoff",
      score: 84, category: "sleep",
      proof: { metric: "disruptor_caffeine", value: 1, threshold: 1 },
      proof_text: "You flagged late caffeine as a disruptor. Cutting off by 2pm clears it before bedtime.",
      surprise_hook: "No coffee after 2pm this week.",
      target: { kind: "caffeine_cutoff_time", target_value: "14:00" },
      success_type: "complete_action", when_to_do: "this_week", impact: 3,
    });
  }
  if (disruptors.includes('Phone/screens in bed')) {
    candidates.push({
      archetype: "screen_off_60",
      score: 80, category: "sleep",
      proof: { metric: "disruptor_screens", value: 1, threshold: 1 },
      proof_text: "Screens in bed delay sleep onset 15-30 min. Phone away 60 min before lights-out.",
      surprise_hook: "Phone in another room 60 min before bed.",
      target: { kind: "phone_away_time", target_value: "60_min_before" },
      success_type: "complete_action", when_to_do: "tonight", impact: 2,
    });
  }
  if (disruptors.includes('Heavy meal before bed') || disruptors.includes('Late exercise')) {
    candidates.push({
      archetype: "meal_cutoff",
      score: 70, category: "sleep",
      proof: { metric: "disruptor_late_meal", value: 1, threshold: 1 },
      proof_text: "Late food or workout pushes sleep onset back 15-30 min. Try a 2h cutoff.",
      surprise_hook: "Last meal 2 hours before bed.",
      target: { kind: "meal_cutoff", target_value: "2h_before" },
      success_type: "complete_action", when_to_do: "tonight", impact: 2,
    });
  }
  if (disruptors.includes('Alcohol')) {
    candidates.push({
      archetype: "alcohol_skip",
      score: 75, category: "sleep",
      proof: { metric: "disruptor_alcohol", value: 1, threshold: 1 },
      proof_text: "Alcohol fragments sleep — even one drink. Try one alcohol-free night this week.",
      surprise_hook: "One alcohol-free night — feel the difference.",
      target: { kind: "alcohol_free_night", target_value: 1 },
      success_type: "complete_action", when_to_do: "this_week", impact: 2,
    });
  }
  if (disruptors.includes('Stress or worry') || disruptors.includes('Racing mind')) {
    candidates.push({
      archetype: "journal_brain_dump",
      score: 72, category: "sleep",
      proof: { metric: "disruptor_stress", value: 1, threshold: 1 },
      proof_text: "Stress at bedtime keeps the mind running. A 3-minute brain-dump on paper offloads it.",
      surprise_hook: "Write the loop out — your mind lets it go.",
      target: { kind: "brain_dump", target_value: 1 },
      success_type: "complete_action", when_to_do: "tonight", impact: 2,
    });
  }

  // (C) CHRONOTYPE-DRIVEN — only relevant when no logs yet (score lowered when logs exist)
  if (chronotype === 'evening' && sorted.length < 7) {
    candidates.push({
      archetype: "morning_light",
      score: 68, category: "sleep",
      proof: { metric: "chronotype_evening", value: 1, threshold: 1 },
      proof_text: "You're a night owl. 10 minutes of outdoor light in your first hour pulls your clock earlier.",
      surprise_hook: "10 min outdoor light, first hour after waking.",
      target: { kind: "morning_light", target_value: 10 },
      success_type: "complete_action", when_to_do: "tomorrow_morning", impact: 2,
    });
  }

  candidates.sort((a,b) => b.score - a.score);
  return candidates;
}

const sleepGraders = {
  log_session: async (deviceId, action, recentLogs) => ({ met: recentLogs.length >= 1, value: recentLogs.length }),
  improve_bedtime_consistency: async (deviceId, action, recentLogs) => {
    if (recentLogs.length < 5) return { met: false, value: 0 };
    const win = action.success_criterion?.target?.window_min || 30;
    const bedtimes = recentLogs.slice(0,5).map(l => {
      const t = (l.bedtime || "23:00").split(":").map(Number);
      return t[0]*60 + (t[1]||0);
    });
    const mean = bedtimes.reduce((a,b)=>a+b,0) / bedtimes.length;
    const std = Math.sqrt(bedtimes.reduce((s,t) => s + (t-mean)**2, 0) / bedtimes.length);
    return { met: std <= win, value: Math.round(std) };
  },
  hit_efficiency: async (deviceId, action, recentLogs) => {
    if (recentLogs.length < 3) return { met: false, value: 0 };
    const target = action.success_criterion?.target?.target_value ?? 80;
    const recent = recentLogs.slice(0,3).map(l => Number(l.sleep_efficiency || l.efficiency || 0));
    const avg = recent.reduce((a,b)=>a+b,0) / recent.length;
    return { met: avg >= target, value: Math.round(avg) };
  },
  // ─── Setup-driven action graders ───
  // Completion-tracked client-side via the action's hit_count/target_count.
  complete_breathing: async (deviceId, action) => {
    const target = action.target_count || 1;
    const hits = action.hit_count || action.completed_count || 0;
    return { met: hits >= target, value: hits };
  },
  consistent_wake: async (deviceId, action, recentLogs) => {
    if (recentLogs.length < 5) return { met: false, value: 0 };
    const target = action.success_criterion?.target?.target_value || "07:00";
    const [th, tm] = String(target).split(':').map(Number);
    const targetMin = th * 60 + (tm || 0);
    const wakes = recentLogs.slice(0, 7).map(l => {
      const t = (l.wake_time || "07:00").split(":").map(Number);
      return t[0]*60 + (t[1]||0);
    });
    const within = wakes.filter(w => Math.abs(w - targetMin) <= 30).length;
    return { met: within >= 5, value: within };
  },
  complete_action: async (deviceId, action) => {
    const target = action.target_count || 1;
    const hits = action.hit_count || action.completed_count || 0;
    return { met: hits >= target, value: hits };
  },
};

module.exports = { computeSleepCandidates, sleepGraders };
