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
      proof: { metric: "days_since_checkin", value: 999, threshold: 3 },
      proof_text: "No check-ins yet. A short daily reflection is the foundation.",
      surprise_hook: "You haven't checked in yet — start the streak today.",
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
        proof: { metric: "days_since_checkin", value: days, threshold: 3 },
        proof_text: `It's been ${days} days since your last check-in. The pattern fades quickly when you skip.`,
        surprise_hook: `Your check-in streak ended ${days} days ago.`,
        target: { kind: "checkin" },
        success_type: "log_checkin",
        when_to_do: "today",
        impact: days >= 7 ? 3 : 2,
      });
    }
  }

  // ── (B) PREVENT — 3+ check-ins with anxiety > 3.5/5 ──
  const recent3 = sorted.slice(0, 3);
  if (recent3.length === 3) {
    const anxs = recent3.map(c => Number(c.anxiety || c.anxiety_score || 0));
    const avgAnx = anxs.reduce((a,b)=>a+b,0) / anxs.length;
    if (avgAnx >= 3.5) {
      candidates.push({
        archetype: "prevent",
        score: Math.min(90, Math.round(avgAnx * 20)),
        category: "mindset",
        proof: { metric: "avg_anxiety_3_logs", value: Math.round(avgAnx*10)/10, threshold: 3.5 },
        proof_text: `Your anxiety has been around ${Math.round(avgAnx*10)/10}/5 for the last 3 check-ins.`,
        surprise_hook: `Anxiety around ${Math.round(avgAnx*10)/10}/5 for 3 check-ins in a row.`,
        target: { metric: "anxiety", target_value: 2.5 },
        success_type: "reduce_anxiety",
        when_to_do: "today",
        impact: 3,
      });
    }
  }

  // ── (C) BREAKTHROUGH — mood improving > 0.5/log slope ──
  const moods = sorted.slice(0, 5).map(c => Number(c.mood_score || c.mood || 0)).reverse();
  if (moods.length >= 3) {
    const slope = (moods[moods.length-1] - moods[0]) / (moods.length - 1);
    if (slope >= 0.5) {
      candidates.push({
        archetype: "breakthrough",
        score: Math.min(80, 50 + Math.round(slope * 30)),
        category: "mindset",
        proof: { metric: "mood_slope_per_log", value: Math.round(slope*100)/100, threshold: 0.5 },
        proof_text: `Your mood has been climbing across the last few check-ins.`,
        surprise_hook: `Mood climbing — log today to keep it going.`,
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
        proof: { metric: "checkin_streak", value: 7, threshold: 7 },
        proof_text: "7-day streak. Try a deeper note today: name one pattern you keep noticing.",
        surprise_hook: "7 days in a row — the habit is forming.",
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
        proof: { metric: "high_anxiety_no_context", value: todayAnx, threshold: 4 },
        proof_text: `Anxiety at ${todayAnx}/5 with no note. Putting words to it lowers the intensity.`,
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
      proof: { metric: "emotion_variety_5_logs", value: uniqEmotions.size, threshold: 2 },
      proof_text: `You've logged "${[...uniqEmotions][0]}" the last 5 times. Trying a more specific word can help.`,
      surprise_hook: `5 check-ins, 1 feeling word — try one new label today.`,
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
    proof: { metric: "morning_anchor", value: 0, threshold: 1 },
    proof_text: "Pair a 30-second check-in with your morning coffee. Tiny pairing, real habit.",
    surprise_hook: "30 seconds with your coffee — that's the whole habit.",
    target: { kind: "morning_checkin" },
    success_type: "log_checkin",
    when_to_do: "today",
    impact: 1,
  });

  // ── (H) BREATHING_60s — high anxiety today ──
  if (sorted[0]) {
    const todayAnx = Number(sorted[0].anxiety || 0);
    if (todayAnx >= 3) {
      candidates.push({
        archetype: "breathing_60s",
        score: 78,
        category: "intervention",
        proof: { metric: "anxiety_today", value: todayAnx, threshold: 3 },
        proof_text: `Anxiety at ${todayAnx}/5 today. A short paced breath calms the body.`,
        surprise_hook: "60 seconds of slow breathing takes the edge off.",
        target: { kind: "breathing_session", target_value: 1 },
        success_type: "complete_breathing",
        when_to_do: "today",
        impact: 2,
      });
    }
  }

  // ── (I) REFRAME_THOUGHT — note has heavy/absolutist language ──
  if (sorted[0]?.note && sorted[0].note.length > 20) {
    const text = sorted[0].note.toLowerCase();
    const distortions = /\b(always|never|everyone|nobody|nothing|everything|completely|totally|ruined|disaster)\b/;
    if (distortions.test(text)) {
      candidates.push({
        archetype: "reframe_thought",
        score: 82,
        category: "intervention",
        proof: { metric: "distortion_marker", value: 1, threshold: 1 },
        proof_text: "Your note used a lot of \"always\" or \"never\" — words like that make a thought heavier.",
        surprise_hook: "Reframe one thought — naming it differently makes it lighter.",
        target: { kind: "reframe_one", target_value: 1 },
        success_type: "complete_reframe",
        when_to_do: "today",
        impact: 3,
      });
    }
  }

  // ── (J) NAME_EMOTION — vocabulary expander ──
  const allEmotions = sorted.slice(0, 10).flatMap(c => c.emotions || []);
  const uniqEmoCount = new Set(allEmotions).size;
  if (allEmotions.length >= 5 && uniqEmoCount <= 3) {
    candidates.push({
      archetype: "name_emotion",
      score: 72,
      category: "skill",
      proof: { metric: "unique_emotions_10", value: uniqEmoCount, threshold: 4 },
      proof_text: `Only ${uniqEmoCount} different feeling words across your last 10 check-ins. Getting more specific helps.`,
      surprise_hook: "Same 3 feeling words for 10 logs — try one new one today.",
      target: { kind: "checkin_with_new_emotion", target_value: 3 },
      success_type: "expand_vocabulary",
      when_to_do: "this_week",
      impact: 2,
    });
  }

  // ── (K) WALK_5MIN — when mood ≤ 2 today ──
  if (sorted[0]) {
    const todayMood = Number(sorted[0].mood_score || sorted[0].mood || 2);
    if (todayMood <= 2) {
      candidates.push({
        archetype: "walk_5min",
        score: 76,
        category: "intervention",
        proof: { metric: "mood_today", value: todayMood, threshold: 2 },
        proof_text: `Mood at ${todayMood}/4. A short walk shifts it more reliably than thinking your way out.`,
        surprise_hook: "5-minute walk — the smallest move that lifts mood.",
        target: { kind: "walk", target_value: 1 },
        success_type: "complete_walk",
        when_to_do: "today",
        impact: 2,
      });
    }
  }

  // ── (L) TEXT_SOMEONE — loneliness or social trigger present ──
  const recentTriggers = sorted.slice(0, 5).flatMap(c => c.triggers || []);
  if (recentTriggers.includes("Loneliness") || recentTriggers.includes("Social situation")) {
    candidates.push({
      archetype: "text_someone",
      score: 68,
      category: "skill",
      proof: { metric: "isolation_trigger_5_logs", value: 1, threshold: 1 },
      proof_text: "Loneliness has shown up in your recent check-ins. One short message changes the day.",
      surprise_hook: "One text. Three sentences. That's the whole thing.",
      target: { kind: "send_message", target_value: 1 },
      success_type: "complete_text",
      when_to_do: "today",
      impact: 2,
    });
  }

  // ── (M) INTENTION_SET — no intentions in last 14 days ──
  if (ctx?.last_intention_age_days == null || ctx.last_intention_age_days >= 14) {
    candidates.push({
      archetype: "intention_set",
      score: 50,
      category: "skill",
      proof: { metric: "days_since_intention", value: ctx?.last_intention_age_days || 999, threshold: 14 },
      proof_text: "Setting a clear \"when X happens, I'll do Y\" makes follow-through much more likely.",
      surprise_hook: "One sentence — that's the whole intention.",
      target: { kind: "set_intention", target_value: 1 },
      success_type: "complete_intention",
      when_to_do: "this_week",
      impact: 1,
    });
  }

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
  // Outcome graders for new mind-native archetypes — completion-tracked client-side
  complete_breathing: async (deviceId, action /*, recentLogs */) => {
    const target = action.target_count || 1;
    const hits = action.hit_rate || 0;
    return { met: hits >= target, value: hits };
  },
  complete_reframe: async (deviceId, action) => {
    const target = action.target_count || 1;
    const hits = action.hit_rate || 0;
    return { met: hits >= target, value: hits };
  },
  expand_vocabulary: async (deviceId, action, recentLogs) => {
    // Granularity grader — count unique emotions across recentLogs vs action.start_uniq
    const start = action.success_criterion?.start_unique_emotions || 0;
    const target = action.target_count || 3;
    const all = new Set();
    for (const c of recentLogs) for (const e of (c.emotions || [])) all.add(e);
    const grew = all.size - start;
    return { met: grew >= target, value: grew };
  },
  complete_walk: async (deviceId, action) => {
    const target = action.target_count || 1;
    const hits = action.hit_rate || 0;
    return { met: hits >= target, value: hits };
  },
  complete_text: async (deviceId, action) => {
    const target = action.target_count || 1;
    const hits = action.hit_rate || 0;
    return { met: hits >= target, value: hits };
  },
  complete_intention: async (deviceId, action) => {
    const target = action.target_count || 1;
    const hits = action.hit_rate || 0;
    return { met: hits >= target, value: hits };
  },
};

module.exports = { computeMindCandidates, mindGraders };
