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
    proof: { metric: "wake_log", value: 0, threshold: 1, citation: "Spielman 1987" },
    proof_text: "Log wake time within 30min of waking. Memory of overnight wake-ups fades fast.",
    surprise_hook: "Log within 30 min of waking — accuracy doubles.",
    target: { kind: "morning_log" }, success_type: "log_session", when_to_do: "today", impact: 1,
  });

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
};

module.exports = { computeSleepCandidates, sleepGraders };
