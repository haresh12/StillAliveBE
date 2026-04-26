"use strict";
// Water candidate engine — uses ONLY water_logs data.

function getMs(v) { return v?.toMillis ? v.toMillis() : new Date(v||0).getTime(); }
function dateOnly(ms) { const d = new Date(ms); d.setHours(0,0,0,0); return d.getTime(); }

async function computeWaterCandidates(logs, setup) {
  const candidates = [];
  if (!Array.isArray(logs)) return candidates;
  const today = new Date(); today.setHours(0,0,0,0);

  // Aggregate per-day totals (most recent 14 days)
  const goalMl = Number(setup?.goal_ml || setup?.daily_goal || 2500);
  const dayMap = {};
  for (const l of logs) {
    const date = l.date || new Date(getMs(l.logged_at)).toISOString().slice(0, 10);
    if (!date) continue;
    const ml = Number(l.amount_ml || l.ml || 0);
    if (!dayMap[date]) dayMap[date] = { date, total: 0, hours: [] };
    dayMap[date].total += ml;
    const h = new Date(getMs(l.logged_at)).getHours();
    dayMap[date].hours.push({ h, ml });
  }
  const days = Object.values(dayMap).sort((a,b) => b.date.localeCompare(a.date));

  // ── WIN_BACK — < 50% goal for 3 days ──
  const last3 = days.slice(0, 3);
  if (days.length === 0) {
    candidates.push({
      archetype: "win_back",
      score: 95, category: "hydration",
      proof: { metric: "logs", value: 0, threshold: 1, citation: "EFSA 2010 hydration guidelines" },
      proof_text: "No water logged. Start by logging your morning glass.",
      surprise_hook: "First glass of the day is the easiest one to log.",
      target: { ml: 500 }, success_type: "hit_water_goal", when_to_do: "today", impact: 3,
    });
  } else {
    const lowDays = last3.filter(d => d.total < goalMl * 0.5).length;
    if (lowDays >= 3) {
      candidates.push({
        archetype: "win_back",
        score: 90, category: "hydration",
        proof: { metric: "low_days_3d", value: lowDays, threshold: 3, citation: "Popkin 2010 mild dehydration" },
        proof_text: `${lowDays}/3 days under 50% of ${goalMl}ml goal. Mild dehydration impairs cognition ~2%.`,
        surprise_hook: `3 days under half goal — cognition slips at 2% loss.`,
        target: { ml: goalMl }, success_type: "hit_water_goal", when_to_do: "today", impact: 3,
      });
    }
  }

  // ── PREVENT — peak intake all evening (>50% after 6pm last 5 days) ──
  // Source: nocturnal hydration disrupts sleep continuity (Wilks 2014)
  const eveningHeavyDays = days.slice(0, 5).filter(d => {
    if (d.total === 0) return false;
    const evening = d.hours.filter(h => h.h >= 18).reduce((s,h)=>s+h.ml, 0);
    return evening / d.total > 0.5;
  }).length;
  if (eveningHeavyDays >= 3) {
    candidates.push({
      archetype: "prevent",
      score: 75, category: "hydration",
      proof: { metric: "evening_heavy_days", value: eveningHeavyDays, threshold: 3, citation: "Wilks 2014" },
      proof_text: `${eveningHeavyDays}/5 days >50% intake after 6pm. Disrupts sleep onset — front-load instead.`,
      surprise_hook: `Most water after 6pm — sleep gets the bill.`,
      target: { pct_before_noon: 50 }, success_type: "front_load_water", when_to_do: "this_week", impact: 2,
    });
  }

  // ── BREAKTHROUGH — hit 100% goal 3+ days, ready to push ──
  const fullDays = days.slice(0, 7).filter(d => d.total >= goalMl).length;
  if (fullDays >= 3) {
    const newGoal = goalMl + 200;
    candidates.push({
      archetype: "breakthrough",
      score: 70, category: "hydration",
      proof: { metric: "full_days_7d", value: fullDays, threshold: 3, citation: "Sawka 2007 ACSM" },
      proof_text: `${fullDays}/7 days at full goal. Bump target to ${newGoal}ml — you have the habit.`,
      surprise_hook: `${fullDays} full days — bump the goal +200ml.`,
      target: { ml: newGoal }, success_type: "hit_water_goal", when_to_do: "this_week", impact: 2,
    });
  }

  // ── PROGRESS — hitting 90%+ consistently ──
  const goodDays = days.slice(0, 7).filter(d => d.total >= goalMl * 0.9).length;
  if (goodDays >= 5 && fullDays < 3) {
    candidates.push({
      archetype: "progress",
      score: 60, category: "hydration",
      proof: { metric: "good_days_7d", value: goodDays, threshold: 5, citation: "EFSA 2010" },
      proof_text: `${goodDays}/7 days at 90%+. One small push gets you to 100%.`,
      surprise_hook: `So close — one extra glass = full goal.`,
      target: { ml: goalMl }, success_type: "hit_water_goal", when_to_do: "today", impact: 2,
    });
  }

  // ── RECOVER — yesterday low, today empty ──
  const yesterday = days[1];
  if (yesterday && yesterday.total < goalMl * 0.6 && (!days[0] || days[0].total === 0)) {
    candidates.push({
      archetype: "recover",
      score: 65, category: "hydration",
      proof: { metric: "rebound_needed", value: Math.round(yesterday.total), threshold: goalMl, citation: "Popkin 2010" },
      proof_text: `Yesterday ${Math.round(yesterday.total)}ml of ${goalMl}. Rebound today before deficit compounds.`,
      surprise_hook: `Yesterday short — today rebounds the deficit.`,
      target: { ml: goalMl }, success_type: "hit_water_goal", when_to_do: "today", impact: 2,
    });
  }

  // ── EXPLORE — try electrolyte add (athletic context only) ──
  // Only if user setup mentions exercise / heavy sweat
  const heavyContext = setup?.activity_level === "high" || setup?.exercise_intensity === "high";
  if (heavyContext && days.slice(0,5).every(d => d.total >= goalMl * 0.8)) {
    candidates.push({
      archetype: "explore",
      score: 50, category: "hydration",
      proof: { metric: "electrolyte_add", value: 0, threshold: 1, citation: "Sawka 2007 ACSM athletic" },
      proof_text: "5 days strong on plain water + high activity. Try sodium/potassium on long sweat days.",
      surprise_hook: "Plain water alone misses sodium — try electrolytes on sweat days.",
      target: { kind: "electrolyte_session" }, success_type: "log_session", when_to_do: "this_week", impact: 1,
    });
  }

  // ── MICRO ──
  candidates.push({
    archetype: "micro",
    score: 30, category: "hydration",
    proof: { metric: "morning_glass", value: 0, threshold: 1, citation: "Tiny Habits (Fogg)" },
    proof_text: "Drink + log a glass within 1 hour of waking. Anchors the habit to existing routine.",
    surprise_hook: "First glass within an hour of waking.",
    target: { kind: "morning_log" }, success_type: "log_session", when_to_do: "today", impact: 1,
  });

  candidates.sort((a,b) => b.score - a.score);
  return candidates;
}

const waterGraders = {
  hit_water_goal: async (deviceId, action, recentLogs) => {
    if (!recentLogs.length) return { met: false, value: 0 };
    // Aggregate by day — kept if any day ≥ target
    const target = action.success_criterion?.target?.ml || 2500;
    const byDay = {};
    for (const l of recentLogs) {
      const d = l.date || new Date((l.logged_at?.toMillis ? l.logged_at.toMillis() : Date.now())).toISOString().slice(0,10);
      byDay[d] = (byDay[d] || 0) + Number(l.amount_ml || l.ml || 0);
    }
    const max = Math.max(...Object.values(byDay));
    return { met: max >= target, partial: max > 0, value: Math.round(max) };
  },
  front_load_water: async (deviceId, action, recentLogs) => {
    if (!recentLogs.length) return { met: false, value: 0 };
    const target = action.success_criterion?.target?.pct_before_noon || 50;
    const byDay = {};
    for (const l of recentLogs) {
      const d = l.date || new Date((l.logged_at?.toMillis ? l.logged_at.toMillis() : Date.now())).toISOString().slice(0,10);
      const h = new Date(l.logged_at?.toMillis ? l.logged_at.toMillis() : Date.now()).getHours();
      if (!byDay[d]) byDay[d] = { early: 0, total: 0 };
      const ml = Number(l.amount_ml || l.ml || 0);
      byDay[d].total += ml;
      if (h < 12) byDay[d].early += ml;
    }
    const pcts = Object.values(byDay).map(d => d.total ? (d.early/d.total)*100 : 0);
    const best = Math.max(...pcts);
    return { met: best >= target, value: Math.round(best) };
  },
  log_session: async (deviceId, action, recentLogs) => ({ met: recentLogs.length >= 1, value: recentLogs.length }),
};

module.exports = { computeWaterCandidates, waterGraders };
