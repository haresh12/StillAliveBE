"use strict";
// Fasting candidate engine — uses ONLY fasting_sessions data.

function getMs(v) { return v?.toMillis ? v.toMillis() : new Date(v||0).getTime(); }
function dateOnly(ms) { const d = new Date(ms); d.setHours(0,0,0,0); return d.getTime(); }

async function computeFastingCandidates(sessions, setup) {
  const candidates = [];
  if (!Array.isArray(sessions)) return candidates;

  const today = new Date(); today.setHours(0,0,0,0);
  const targetHours = Number(setup?.target_hours || setup?.window_hours || 16);

  // Sort newest first; only consider completed
  const completed = sessions
    .filter(s => s.completed_at || s.actual_hours)
    .sort((a,b) => getMs(b.started_at || b.completed_at) - getMs(a.started_at || a.completed_at));

  // ── WIN_BACK ──
  if (completed.length === 0) {
    candidates.push({
      archetype: "win_back",
      score: 95, category: "fasting",
      proof: { metric: "completed_fasts", value: 0, threshold: 1, citation: "Patterson 2017 review" },
      proof_text: "No completed fasts logged. Start with one 14-hour window.",
      surprise_hook: "Your first 14h fast is the entry ticket.",
      target: { hours: 14 }, success_type: "complete_fast", when_to_do: "today", impact: 3,
    });
  } else {
    const days = Math.floor((today - dateOnly(getMs(completed[0].completed_at || completed[0].started_at))) / 86400000);
    if (days >= 3) {
      candidates.push({
        archetype: "win_back",
        score: Math.min(95, 50 + days*8), category: "fasting",
        proof: { metric: "days_since_fast", value: days, threshold: 3, citation: "Patterson 2017" },
        proof_text: `${days} days since last completed fast. Metabolic flexibility decays.`,
        surprise_hook: `${days} days off — your fat-burning switch needs reactivating.`,
        target: { hours: targetHours }, success_type: "complete_fast", when_to_do: "today", impact: 2,
      });
    }
  }

  // ── PREVENT — 2+ broken-early in row ──
  const last3 = completed.slice(0, 3);
  const brokenInRow = last3.filter(s => s.broken_early || (Number(s.actual_hours||0) < targetHours - 2)).length;
  if (last3.length >= 2 && brokenInRow >= 2) {
    candidates.push({
      archetype: "prevent",
      score: 85, category: "fasting",
      proof: { metric: "broken_fasts_streak", value: brokenInRow, threshold: 2, citation: "Compliance literature" },
      proof_text: `${brokenInRow} fasts broken early. Drop target to ${Math.max(12, targetHours-2)}h to rebuild compliance.`,
      surprise_hook: `${brokenInRow} broken fasts in a row — drop the target.`,
      target: { hours: Math.max(12, targetHours-2) },
      success_type: "complete_fast", when_to_do: "today", impact: 3,
    });
  }

  // ── BREAKTHROUGH — close to next stage ──
  if (completed[0]) {
    const lastHrs = Number(completed[0].actual_hours || 0);
    const stageGap = lastHrs >= 14 && lastHrs < 16 ? 16 - lastHrs :
                     lastHrs >= 12 && lastHrs < 14 ? 14 - lastHrs : 0;
    if (stageGap > 0 && stageGap <= 2) {
      const nextStage = lastHrs >= 14 ? 16 : 14;
      const stageName = nextStage === 16 ? "ketosis entry" : "fat-burning";
      candidates.push({
        archetype: "breakthrough",
        score: 75, category: "fasting",
        proof: { metric: "next_stage_gap_hours", value: Math.round(stageGap*10)/10, threshold: 2, citation: "Anton 2018 metabolic switch" },
        proof_text: `${Math.round(stageGap*10)/10}h short of ${stageName}. Next fast: push to ${nextStage}h.`,
        surprise_hook: `Just ${Math.round(stageGap)}h from ${stageName}.`,
        target: { hours: nextStage }, success_type: "extend_window", when_to_do: "next_session", impact: 2,
      });
    }
  }

  // ── PROGRESS — 7-day completion streak ──
  if (completed.length >= 7) {
    const allHit = completed.slice(0,7).every(s => Number(s.actual_hours||0) >= targetHours);
    if (allHit) {
      candidates.push({
        archetype: "progress",
        score: 70, category: "fasting",
        proof: { metric: "completion_streak_days", value: 7, threshold: 7, citation: "Patterson 2017" },
        proof_text: `7-day completion streak at ${targetHours}h. Try ${targetHours+1}h once this week.`,
        surprise_hook: `7 days at target — extend the window.`,
        target: { hours: targetHours + 1 }, success_type: "extend_window", when_to_do: "this_week", impact: 2,
      });
    }
  }

  // ── RECOVER — 5+ consecutive 16h+ days ──
  const heavy = completed.filter(s => Number(s.actual_hours||0) >= 16).length;
  if (heavy >= 5 && completed.length >= 5 &&
      completed.slice(0,5).every(s => Number(s.actual_hours||0) >= 16)) {
    candidates.push({
      archetype: "recover",
      score: 75, category: "fasting",
      proof: { metric: "consecutive_16h_fasts", value: 5, threshold: 5, citation: "Tinsley 2017 hormesis" },
      proof_text: "5+ consecutive 16h+ fasts. Schedule a 12h refeed day to avoid metabolic adaptation.",
      surprise_hook: "5 hard fasts back-to-back — schedule a 12h refeed.",
      target: { hours: 12 }, success_type: "complete_fast", when_to_do: "rest_day", impact: 2,
    });
  }

  // ── EXPLORE — same protocol every day ──
  const distinctTargets = new Set(completed.slice(0,7).map(s => Math.round(Number(s.target_hours || targetHours))));
  if (completed.length >= 5 && distinctTargets.size === 1) {
    candidates.push({
      archetype: "explore",
      score: 50, category: "fasting",
      proof: { metric: "protocol_variety_7d", value: 1, threshold: 2, citation: "Tinsley 2017" },
      proof_text: `Only ${[...distinctTargets][0]}h protocol used. Try one OMAD or 18h variant for adaptation.`,
      surprise_hook: `Same ${[...distinctTargets][0]}h every fast — variety boosts metabolic adaptation.`,
      target: { hours: 18 }, success_type: "extend_window", when_to_do: "this_week", impact: 1,
    });
  }

  // ── MICRO ──
  candidates.push({
    archetype: "micro",
    score: 30, category: "fasting",
    proof: { metric: "log_break_meal", value: 0, threshold: 1, citation: "Tracking adherence literature" },
    proof_text: "Log what you break with — meal composition predicts next-fast hunger.",
    surprise_hook: "What you break with predicts your next fast.",
    target: { kind: "log_break_meal" }, success_type: "log_session", when_to_do: "next_session", impact: 1,
  });

  candidates.sort((a,b) => b.score - a.score);
  return candidates;
}

const fastingGraders = {
  complete_fast: async (deviceId, action, recentLogs) => {
    const target = action.success_criterion?.target?.hours || 14;
    const hits = recentLogs.filter(s => Number(s.actual_hours||0) >= target).length;
    return { met: hits >= 1, value: hits };
  },
  extend_window: async (deviceId, action, recentLogs) => {
    const target = action.success_criterion?.target?.hours || 16;
    const hits = recentLogs.filter(s => Number(s.actual_hours||0) >= target).length;
    return { met: hits >= 1, value: hits };
  },
  log_session: async (deviceId, action, recentLogs) => ({ met: recentLogs.length >= 1, value: recentLogs.length }),
};

module.exports = { computeFastingCandidates, fastingGraders };
