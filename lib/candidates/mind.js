"use strict";
// Mind candidate engine — uses ONLY mind_checkins data.
// Archetypes used: win_back, prevent, breakthrough, progress, recover, explore, micro

function dateOnly(ms) {
  const d = new Date(ms); d.setHours(0,0,0,0); return d.getTime();
}

async function computeMindCandidates(checkins, setup, ctx) {
  const candidates = [];
  if (!Array.isArray(checkins)) return candidates;

  const now = Date.now();
  const today = new Date(); today.setHours(0,0,0,0);

  // Sort newest first
  const sorted = [...checkins].sort((a,b) => {
    const at = a.logged_at?.toMillis ? a.logged_at.toMillis() : new Date(a.logged_at || 0).getTime();
    const bt = b.logged_at?.toMillis ? b.logged_at.toMillis() : new Date(b.logged_at || 0).getTime();
    return bt - at;
  });

  // ── (A) WIN_BACK — no check-in 3+ days ──
  // Source: Habit-loop literature (Lally 2010): habits decay rapidly past 72h
  if (sorted.length === 0) {
    candidates.push({
      archetype: "win_back",
      score: 95,
      category: "mindset",
      proof: { metric: "days_since_checkin", value: 999, threshold: 3, citation: "Lally et al. 2010" },
      proof_text: "No check-ins logged. Habit formation requires daily reflection.",
      surprise_hook: "You've never checked in — start the streak today.",
      target: { kind: "checkin" },
      success_type: "log_checkin",
      when_to_do: "today",
      impact: 3,
    });
  } else {
    const lastMs = sorted[0].logged_at?.toMillis
      ? sorted[0].logged_at.toMillis()
      : new Date(sorted[0].logged_at || 0).getTime();
    const days = Math.floor((today - dateOnly(lastMs)) / 86400000);
    if (days >= 3) {
      candidates.push({
        archetype: "win_back",
        score: Math.min(95, 50 + days * 8),
        category: "mindset",
        proof: { metric: "days_since_checkin", value: days, threshold: 3, citation: "Lally et al. 2010" },
        proof_text: `${days} days since last check-in. Habit decay accelerates past 72h.`,
        surprise_hook: `Your reflection streak broke ${days} days ago.`,
        target: { kind: "checkin" },
        success_type: "log_checkin",
        when_to_do: "today",
        impact: days >= 7 ? 3 : 2,
      });
    }
  }

  // ── (B) PREVENT — 3+ check-ins with anxiety > 3.5/5 ──
  // Source: GAD-7 elevated-trait threshold
  const recent3 = sorted.slice(0, 3);
  if (recent3.length === 3) {
    const anxs = recent3.map(c => Number(c.anxiety || c.anxiety_score || 0));
    const avgAnx = anxs.reduce((a,b)=>a+b,0) / anxs.length;
    if (avgAnx >= 3.5) {
      candidates.push({
        archetype: "prevent",
        score: Math.min(90, Math.round(avgAnx * 20)),
        category: "mindset",
        proof: { metric: "avg_anxiety_3_logs", value: Math.round(avgAnx*10)/10, threshold: 3.5, citation: "GAD-7 elevated" },
        proof_text: `Avg anxiety ${Math.round(avgAnx*10)/10}/5 over last 3 logs (elevated trait threshold).`,
        surprise_hook: `Your anxiety has been ≥${Math.round(avgAnx*10)/10}/5 for 3 logs straight.`,
        target: { metric: "anxiety", target_value: 2.5 },
        success_type: "reduce_anxiety",
        when_to_do: "today",
        impact: 3,
      });
    }
  }

  // ── (C) BREAKTHROUGH — mood improving > 0.5/log slope ──
  // Source: positive-affect upward spiral (Fredrickson 2001)
  const moods = sorted.slice(0, 5).map(c => Number(c.mood_score || c.mood || 0)).reverse();
  if (moods.length >= 3) {
    const slope = (moods[moods.length-1] - moods[0]) / (moods.length - 1);
    if (slope >= 0.5) {
      candidates.push({
        archetype: "breakthrough",
        score: Math.min(80, 50 + Math.round(slope * 30)),
        category: "mindset",
        proof: { metric: "mood_slope_per_log", value: Math.round(slope*100)/100, threshold: 0.5, citation: "Fredrickson 2001" },
        proof_text: `Mood climbing ${Math.round(slope*100)/100} pts/log. Positive-affect upward spiral active.`,
        surprise_hook: `Your mood is climbing — log today to lock the spiral in.`,
        target: { metric: "mood_score", target_value: moods[moods.length-1] + 0.3 },
        success_type: "mood_streak",
        when_to_do: "today",
        impact: 2,
      });
    }
  }

  // ── (D) PROGRESS — 7-day check-in streak ──
  if (sorted.length >= 7) {
    const last7 = sorted.slice(0, 7);
    const allWithin = last7.every((c, i) => {
      if (i === 0) return true;
      const a = c.logged_at?.toMillis ? c.logged_at.toMillis() : new Date(c.logged_at).getTime();
      const b = last7[i-1].logged_at?.toMillis ? last7[i-1].logged_at.toMillis() : new Date(last7[i-1].logged_at).getTime();
      return Math.abs(b - a) < 36 * 3600 * 1000;
    });
    if (allWithin) {
      candidates.push({
        archetype: "progress",
        score: 75,
        category: "mindset",
        proof: { metric: "checkin_streak", value: 7, threshold: 7, citation: "Lally 2010 habit-formation" },
        proof_text: "7-day streak achieved. Try a deeper reflection: list one trigger pattern.",
        surprise_hook: "You've hit 7 days — the habit is forming.",
        target: { kind: "deep_reflection" },
        success_type: "log_checkin",
        when_to_do: "today",
        impact: 2,
      });
    }
  }

  // ── (E) RECOVER — anxiety > 4 today + low engagement (no notes) ──
  if (sorted[0]) {
    const todayAnx = Number(sorted[0].anxiety || 0);
    const hasNote = sorted[0].note && sorted[0].note.length > 10;
    if (todayAnx >= 4 && !hasNote) {
      candidates.push({
        archetype: "recover",
        score: 70,
        category: "mindset",
        proof: { metric: "high_anxiety_no_context", value: todayAnx, threshold: 4, citation: "CBT exposure literature" },
        proof_text: `High anxiety (${todayAnx}/5) without note. Naming the trigger reduces intensity ~30%.`,
        surprise_hook: "High anxiety without a name — give it one.",
        target: { kind: "checkin_with_note" },
        success_type: "log_checkin",
        when_to_do: "today",
        impact: 2,
      });
    }
  }

  // ── (F) EXPLORE — only one emotion logged across last 5 ──
  const emotions = sorted.slice(0, 5).map(c => c.emotion).filter(Boolean);
  const uniqEmotions = new Set(emotions);
  if (emotions.length >= 4 && uniqEmotions.size <= 1) {
    candidates.push({
      archetype: "explore",
      score: 55,
      category: "mindset",
      proof: { metric: "emotion_variety_5_logs", value: uniqEmotions.size, threshold: 2, citation: "Emotional granularity (Barrett)" },
      proof_text: `Only "${[...uniqEmotions][0]}" logged 5x. Granular labeling reduces emotional reactivity.`,
      surprise_hook: `5 logs, 1 emotion — your emotional vocabulary is thin.`,
      target: { kind: "checkin_with_new_emotion" },
      success_type: "log_checkin",
      when_to_do: "today",
      impact: 2,
    });
  }

  // ── (G) MICRO ──
  candidates.push({
    archetype: "micro",
    score: 30,
    category: "mindset",
    proof: { metric: "morning_anchor", value: 0, threshold: 1, citation: "Tiny Habits (Fogg)" },
    proof_text: "Anchor a 30-second check-in to your morning coffee. Habit stacking ≈ 3× adoption.",
    surprise_hook: "30 seconds with your coffee — that's the whole habit.",
    target: { kind: "morning_checkin" },
    success_type: "log_checkin",
    when_to_do: "today",
    impact: 1,
  });

  candidates.sort((a,b) => b.score - a.score);
  return candidates;
}

const mindGraders = {
  log_checkin: async (deviceId, action, recentLogs) => {
    return { met: recentLogs.length >= 1, value: recentLogs.length };
  },
  reduce_anxiety: async (deviceId, action, recentLogs) => {
    if (recentLogs.length < 3) return { met: false, value: 0 };
    const anxs = recentLogs.slice(0, 3).map(c => Number(c.anxiety || 0));
    const avg = anxs.reduce((a,b)=>a+b,0) / anxs.length;
    return { met: avg <= (action.success_criterion?.target?.target_value ?? 2.5), value: Math.round(avg*10)/10 };
  },
  mood_streak: async (deviceId, action, recentLogs) => {
    if (recentLogs.length === 0) return { met: false, value: 0 };
    const target = action.success_criterion?.target?.target_value ?? 3;
    const last = Number(recentLogs[0].mood_score || recentLogs[0].mood || 0);
    return { met: last >= target, partial: last > 0, value: last };
  },
};

module.exports = { computeMindCandidates, mindGraders };
