
// Local-TZ date key helper — never _localDateStr(use) which
// returns UTC and silently maps near-midnight logs to the wrong day in
// negative-UTC offsets (Americas). See feedback_chart_tz_clamp law.
function _localDateStr(d) {
  const dt = d instanceof Date ? d : (d ? new Date(d) : new Date());
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
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
    const date = l.date || _localDateStr(new Date(getMs(l.logged_at)));
    if (!date) continue;
    const ml = Number(l.amount_ml || l.ml || 0);
    if (!dayMap[date]) dayMap[date] = { date, total: 0, hours: [] };
    dayMap[date].total += ml;
    const h = new Date(getMs(l.logged_at)).getHours();
    dayMap[date].hours.push({ h, ml });
  }
  const days = Object.values(dayMap).sort((a,b) => b.date.localeCompare(a.date));

  // ── DAY-1 STARTER PACK — fires for cold-start users (<3 days history) ──
  // 3 science-grounded actions across distinct archetypes so the engine's
  // "max 1 per archetype" rule lets all of them through (spotlight + 2 secondaries).
  const last3 = days.slice(0, 3);
  if (days.length < 3) {
    const morningTargetMl = Math.round(goalMl * 0.20);  // 20% of daily by mid-morning
    candidates.push({
      archetype: "win_back",
      score: 95, category: "hydration",
      proof: { metric: "morning_intake_ml", value: 0, threshold: morningTargetMl, citation: "Forbes 2019 Eur J Clin Nutr" },
      proof_text: `Front-load ${morningTargetMl}ml within 30 min of waking. 75% of adults under-hydrate by 11am — morning intake compounds the rest of the day.`,
      surprise_hook: "Morning glass is the highest-leverage move you make all day.",
      target: { ml: morningTargetMl, before_hour: 10 }, success_type: "hit_water_goal", when_to_do: "today", impact: 3,
    });
    candidates.push({
      archetype: "prevent",
      score: 88, category: "hydration",
      proof: { metric: "pre_meal_glass", value: 0, threshold: 250, citation: "Pross 2017 Ann Nutr Metab" },
      proof_text: "Drink 250ml 15 min before each meal. Pre-meal hydration cuts thirst-as-hunger confusion and improves satiety signals.",
      surprise_hook: "Most pre-noon hunger is mild thirst in disguise.",
      target: { ml: 250, kind: "pre_meal" }, success_type: "log_session", when_to_do: "today", impact: 2,
    });
    candidates.push({
      archetype: "progress",
      score: 82, category: "hydration",
      proof: { metric: "evening_cutoff_h", value: 21, threshold: 21, citation: "Rosinger 2019 Sleep" },
      proof_text: "Stop heavy intake by 9pm. Late drinking fragments sleep and ironically leaves you more dehydrated by morning.",
      surprise_hook: "Drinking past 9pm pays interest in lost sleep.",
      target: { cutoff_hour: 21 }, success_type: "front_load_water", when_to_do: "today", impact: 2,
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

  // ══════════════════════════════════════════════════════════════════
  // Phase 10 (2026-05-24) — 6 research-cited archetypes.
  // All triggers derived from the same per-day map already built above.
  // ══════════════════════════════════════════════════════════════════

  // ── DEHYDRATION_DEBT — multi-day cumulative deficit ──
  // Sawka 2007 ACSM: ≥2% body-water loss impairs cognition + perf. Across
  // 7 days, a sustained shortfall is the strongest signal of risk.
  if (days.length >= 5) {
    const last7 = days.slice(0, 7);
    const deficit = last7.reduce((s, d) => s + Math.max(0, goalMl - d.total), 0);
    if (deficit >= 1500) {
      candidates.push({
        archetype: "win_back",
        score: 92, category: "hydration",
        proof: { metric: "dehydration_debt_ml", value: Math.round(deficit), threshold: 1500, citation: "Sawka 2007 ACSM Pos Stand" },
        proof_text: `Cumulative deficit of ${Math.round(deficit)} ml over the last 7 days. At 2% body-water loss cognition + performance both drop — closing the gap is the highest-leverage move this week.`,
        surprise_hook: `${(deficit/1000).toFixed(1)}L total debt — close it today.`,
        target: { ml: goalMl }, success_type: "hit_water_goal", when_to_do: "today", impact: 3,
      });
    }
  }

  // ── MORNING_LAG — yesterday loaded evening, today AM is thin ──
  // Forbes 2019: morning under-hydration is universal; rescue with an
  // early anchor glass. Fires when yesterday went late AND today is low AM.
  if (days[0] && days[1]) {
    const today = days[0];
    const yesterday = days[1];
    const todayMorning = today.hours.filter(h => h.h < 11).reduce((s, h) => s + h.ml, 0);
    const yesterdayEvening = yesterday.hours.filter(h => h.h >= 19).reduce((s, h) => s + h.ml, 0);
    if (todayMorning < goalMl * 0.15 && yesterdayEvening > goalMl * 0.4) {
      candidates.push({
        archetype: "prevent",
        score: 80, category: "hydration",
        proof: { metric: "morning_lag_ml", value: Math.round(todayMorning), threshold: Math.round(goalMl * 0.15), citation: "Forbes 2019 Eur J Clin Nutr" },
        proof_text: `Yesterday ${Math.round(yesterdayEvening)} ml landed after 7pm; this morning is only ${Math.round(todayMorning)} ml. Re-anchor: ${Math.round(goalMl * 0.2)} ml within 30 min of your next wake.`,
        surprise_hook: `Yesterday's late spill = today's slow start. Anchor the morning.`,
        target: { ml: Math.round(goalMl * 0.2), before_hour: 11 }, success_type: "front_load_water", when_to_do: "today", impact: 2,
      });
    }
  }

  // ── EVENING_OVERLOAD_FOR_SLEEP — late-day intake too high ──
  // Rosinger 2019 Sleep: heavy late-day water fragments sleep continuity.
  // Tikkinen 2010: ≥2 nighttime voids meaningfully drop QoL.
  if (days.length >= 4) {
    const last4 = days.slice(0, 4);
    const lateOverloadDays = last4.filter(d => {
      if (d.total === 0) return false;
      const post7pm = d.hours.filter(h => h.h >= 19).reduce((s, h) => s + h.ml, 0);
      return post7pm > goalMl * 0.4;
    }).length;
    if (lateOverloadDays >= 3) {
      candidates.push({
        archetype: "prevent",
        score: 78, category: "hydration",
        proof: { metric: "evening_overload_days", value: lateOverloadDays, threshold: 3, citation: "Rosinger 2019 Sleep + Tikkinen 2010" },
        proof_text: `${lateOverloadDays} of last 4 days had >40% intake after 7pm. That ratio fragments sleep continuity — cap at 250 ml past 7pm for the next 3 nights.`,
        surprise_hook: `Heavy nightly intake taxes sleep more than it hydrates.`,
        target: { late_cap_ml: 250 }, success_type: "front_load_water", when_to_do: "this_week", impact: 2,
      });
    }
  }

  // ── BEVERAGE_DIVERSITY — single-source intake misses electrolytes ──
  // Maughan 2016 BHI: water alone underperforms a varied mix for retention
  // and electrolyte balance, especially with even modest activity.
  if (days.length >= 5) {
    // Build a tiny beverage diversity index from logs in the window.
    const types = new Set();
    for (const l of logs.slice(0, 60)) {
      types.add(l.beverage_type || l.drink_type || 'water');
    }
    const activeContext = setup?.activity_level === "high" || setup?.activity_level === "active" || setup?.activity_level === "athlete";
    if (types.size < 2 && activeContext) {
      candidates.push({
        archetype: "explore",
        score: 55, category: "hydration",
        proof: { metric: "beverage_variety", value: types.size, threshold: 2, citation: "Maughan 2016 Beverage Hydration Index" },
        proof_text: `You've logged ${types.size === 0 ? 'none' : 'only 1'} beverage type recently. At your activity level, a herbal tea or electrolyte drink alongside water improves retention by 30-50% (BHI).`,
        surprise_hook: `Plain water alone leaves retention on the table.`,
        target: { kind: "add_variety" }, success_type: "log_session", when_to_do: "this_week", impact: 1,
      });
    }
  }

  // ── STREAK_SAVE — protect an active streak with a low-friction nudge ──
  // Habit-formation literature (Lally 2010): breaking a streak in the
  // formation window resets the neural reward loop. Save it.
  // Triggers when streak ≥ 3, today's intake < 60% goal, and it's past 8pm.
  if (days[0] && setup?.current_streak >= 3) {
    const today = days[0];
    const hourNow = new Date().getHours();
    if (today.total < goalMl * 0.6 && hourNow >= 20) {
      const need = Math.round(goalMl * 0.6 - today.total);
      candidates.push({
        archetype: "recover",
        score: 88, category: "hydration",
        proof: { metric: "streak_save", value: setup.current_streak, threshold: 3, citation: "Lally 2010 Eur J Soc Psychol" },
        proof_text: `${setup.current_streak}-day streak at risk — ${need} ml in the next 30 min protects it. Habit loops break on misses, not on small days.`,
        surprise_hook: `${setup.current_streak} days — one glass keeps it alive.`,
        target: { ml: need }, success_type: "hit_water_goal", when_to_do: "today", impact: 2,
      });
    }
  }

  // ── HEAT_ADJUST — climate-adjusted ceiling for hot / humid users ──
  // Sawka & Montain 2000: hot environments raise sweat rate 0.5–2 L/h.
  // Setup-driven (no cross-agent reads); fires when climate is hot and the
  // last 3 days haven't accounted for it.
  if (days.length >= 3 && (setup?.climate === "hot" || setup?.climate === "humid" || setup?.climate === "very_hot")) {
    const last3 = days.slice(0, 3);
    const allUnder = last3.every(d => d.total < goalMl * 0.9);
    if (allUnder) {
      const bump = setup.climate === "very_hot" ? 500 : 300;
      candidates.push({
        archetype: "prevent",
        score: 72, category: "hydration",
        proof: { metric: "heat_under_target", value: 3, threshold: 3, citation: "Sawka & Montain 2000 Am J Clin Nutr" },
        proof_text: `Climate set to ${setup.climate}. Your goal is already adjusted, but the last 3 days landed under 90%. Add ${bump} ml on hot-weather days to keep pace with sweat loss.`,
        surprise_hook: `Hot climate + slipping intake = compounding deficit.`,
        target: { ml_bump: bump }, success_type: "hit_water_goal", when_to_do: "today", impact: 2,
      });
    }
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
      const d = l.date || _localDateStr(new Date(l.logged_at?.toMillis ? l.logged_at.toMillis() : Date.now()));
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
      const d = l.date || _localDateStr(new Date(l.logged_at?.toMillis ? l.logged_at.toMillis() : Date.now()));
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
