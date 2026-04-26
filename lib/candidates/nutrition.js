"use strict";
// Nutrition candidate engine — uses ONLY food_logs data.

function getMs(v) { return v?.toMillis ? v.toMillis() : new Date(v||0).getTime(); }
function dateOnly(ms) { const d = new Date(ms); d.setHours(0,0,0,0); return d.getTime(); }

async function computeNutritionCandidates(logs, setup) {
  const candidates = [];
  if (!Array.isArray(logs)) return candidates;

  const today = new Date(); today.setHours(0,0,0,0);
  const proteinTargetG = Number(setup?.protein_target_g || setup?.targets?.protein || 100);
  const fiberTargetG = Number(setup?.fiber_target_g || 25);

  // Aggregate by day
  const dayMap = {};
  for (const l of logs) {
    const date = l.date || new Date(getMs(l.logged_at)).toISOString().slice(0,10);
    if (!date) continue;
    if (!dayMap[date]) dayMap[date] = { date, protein: 0, fiber: 0, calories: 0, meals: [] };
    dayMap[date].protein += Number(l.protein_g || l.macros?.protein_g || 0);
    dayMap[date].fiber += Number(l.fiber_g || l.macros?.fiber_g || 0);
    dayMap[date].calories += Number(l.calories || 0);
    dayMap[date].meals.push({ name: l.name || l.food, type: l.meal_type, hour: new Date(getMs(l.logged_at)).getHours() });
  }
  const days = Object.values(dayMap).sort((a,b) => b.date.localeCompare(a.date));

  // ── WIN_BACK — no log 2+ days ──
  if (days.length === 0) {
    candidates.push({
      archetype: "win_back",
      score: 95, category: "nutrition",
      proof: { metric: "logs", value: 0, threshold: 1, citation: "Burke 2011 self-monitoring" },
      proof_text: "No food logged. Self-monitoring alone reduces over-eating ~12%.",
      surprise_hook: "Logging is the intervention — start with one meal.",
      target: { kind: "log_meal" }, success_type: "log_meal", when_to_do: "today", impact: 3,
    });
  } else {
    const lastMs = new Date(days[0].date + "T12:00:00").getTime();
    const daysSince = Math.floor((today - lastMs) / 86400000);
    if (daysSince >= 2) {
      candidates.push({
        archetype: "win_back",
        score: Math.min(95, 50 + daysSince*10), category: "nutrition",
        proof: { metric: "days_since_log", value: daysSince, threshold: 2, citation: "Burke 2011" },
        proof_text: `${daysSince} days no food log. Pattern data needs 3+ days/wk to be useful.`,
        surprise_hook: `${daysSince} days off — your nutrition pattern is invisible.`,
        target: { kind: "log_meal" }, success_type: "log_meal", when_to_do: "today", impact: 2,
      });
    }
  }

  // ── PREVENT — protein < 0.8g/kg for 3 days ──
  // Source: RDA 0.8g/kg minimum; 1.6g/kg for muscle gain (Morton 2018)
  const last3 = days.slice(0, 3);
  const proteinMissDays = last3.filter(d => d.protein < proteinTargetG * 0.8).length;
  if (last3.length >= 3 && proteinMissDays >= 3) {
    const avgProtein = Math.round(last3.reduce((s,d)=>s+d.protein,0) / last3.length);
    candidates.push({
      archetype: "prevent",
      score: 85, category: "nutrition",
      proof: { metric: "avg_protein_3d", value: avgProtein, threshold: proteinTargetG, citation: "RDA 0.8 g/kg, Morton 2018" },
      proof_text: `Avg protein ${avgProtein}g vs ${proteinTargetG}g target last 3 days. Muscle protein synthesis suffers below RDA.`,
      surprise_hook: `Avg ${avgProtein}g protein — below the muscle threshold.`,
      target: { protein_g: proteinTargetG }, success_type: "hit_protein", when_to_do: "today", impact: 3,
    });
  }

  // ── BREAKTHROUGH — hit macro targets 5/7 days ──
  const onTargetDays = days.slice(0, 7).filter(d => d.protein >= proteinTargetG * 0.95).length;
  if (onTargetDays >= 5) {
    candidates.push({
      archetype: "breakthrough",
      score: 70, category: "nutrition",
      proof: { metric: "macro_hit_days_7d", value: onTargetDays, threshold: 5, citation: "Morton 2018 muscle synthesis" },
      proof_text: `${onTargetDays}/7 days at protein target. Push fiber to ${fiberTargetG}g for gut/satiety win.`,
      surprise_hook: `${onTargetDays} days on protein — fiber is the next lever.`,
      target: { fiber_g: fiberTargetG }, success_type: "hit_protein", when_to_do: "today", impact: 2,
    });
  }

  // ── PROGRESS — fiber > 25g 3+ days ──
  const fiberDays = days.slice(0, 7).filter(d => d.fiber >= fiberTargetG).length;
  if (fiberDays >= 3) {
    candidates.push({
      archetype: "progress",
      score: 60, category: "nutrition",
      proof: { metric: "fiber_hit_days_7d", value: fiberDays, threshold: 3, citation: "FDA RDI 25g" },
      proof_text: `${fiberDays}/7 days at ${fiberTargetG}g+ fiber. Stretch toward 35g for cardiovascular benefit.`,
      surprise_hook: `${fiberDays} days on fiber — push toward 35g.`,
      target: { fiber_g: 35 }, success_type: "hit_protein", when_to_do: "this_week", impact: 2,
    });
  }

  // ── RECOVER — heavy week needs lighter day ──
  const last7Cal = days.slice(0, 7).reduce((s,d)=>s+d.calories,0);
  const avgCal = days.length ? last7Cal / Math.min(days.length, 7) : 0;
  if (avgCal > 2800 && days.length >= 5) {
    candidates.push({
      archetype: "recover",
      score: 55, category: "nutrition",
      proof: { metric: "avg_calories_7d", value: Math.round(avgCal), threshold: 2800, citation: "Trexler 2014 metabolic adaptation" },
      proof_text: `Avg ${Math.round(avgCal)} kcal/day. Plan one lighter day to reset hunger hormones.`,
      surprise_hook: `Avg ${Math.round(avgCal)} kcal — schedule a lighter day.`,
      target: { calories_max: 2200 }, success_type: "log_meal", when_to_do: "this_week", impact: 1,
    });
  }

  // ── EXPLORE — same 5 foods cycling ──
  const allFoodNames = days.slice(0, 7).flatMap(d => d.meals.map(m => (m.name||"").toLowerCase())).filter(Boolean);
  const distinctFoods = new Set(allFoodNames);
  if (allFoodNames.length >= 14 && distinctFoods.size <= 6) {
    candidates.push({
      archetype: "explore",
      score: 50, category: "nutrition",
      proof: { metric: "food_variety_7d", value: distinctFoods.size, threshold: 10, citation: "Drewnowski 2018 dietary diversity" },
      proof_text: `Only ${distinctFoods.size} distinct foods last week. Diversity → better micronutrients + microbiome.`,
      surprise_hook: `Just ${distinctFoods.size} distinct foods — nudge variety up.`,
      target: { kind: "new_food" }, success_type: "log_meal", when_to_do: "this_week", impact: 1,
    });
  }

  // ── MICRO — log breakfast (most-skipped meal) ──
  const breakfastDays = days.slice(0, 7).filter(d => d.meals.some(m => m.type === "breakfast" || m.hour < 11)).length;
  if (days.length >= 3 && breakfastDays < days.length / 2) {
    candidates.push({
      archetype: "micro",
      score: 35, category: "nutrition",
      proof: { metric: "breakfast_log_rate_7d", value: breakfastDays, threshold: 5, citation: "Pereira 2011 breakfast skippers" },
      proof_text: `Breakfast logged ${breakfastDays}/7 days. Morning protein anchors satiety the rest of the day.`,
      surprise_hook: `Breakfast missing ${days.length - breakfastDays} days — log the morning meal.`,
      target: { kind: "log_breakfast" }, success_type: "log_meal", when_to_do: "today", impact: 1,
    });
  } else {
    candidates.push({
      archetype: "micro",
      score: 30, category: "nutrition",
      proof: { metric: "log_one_meal", value: 0, threshold: 1, citation: "Burke 2011" },
      proof_text: "Log one meal today. Self-monitoring is the highest-ROI nutrition habit.",
      surprise_hook: "One meal today — that's the whole habit.",
      target: { kind: "log_meal" }, success_type: "log_meal", when_to_do: "today", impact: 1,
    });
  }

  candidates.sort((a,b) => b.score - a.score);
  return candidates;
}

const nutritionGraders = {
  log_meal: async (deviceId, action, recentLogs) => ({ met: recentLogs.length >= 1, value: recentLogs.length }),
  hit_protein: async (deviceId, action, recentLogs) => {
    const target = action.success_criterion?.target?.protein_g || 100;
    const byDay = {};
    for (const l of recentLogs) {
      const d = l.date || new Date((l.logged_at?.toMillis ? l.logged_at.toMillis() : Date.now())).toISOString().slice(0,10);
      byDay[d] = (byDay[d] || 0) + Number(l.protein_g || l.macros?.protein_g || 0);
    }
    const max = Math.max(0, ...Object.values(byDay));
    return { met: max >= target, partial: max > 0, value: Math.round(max) };
  },
};

module.exports = { computeNutritionCandidates, nutritionGraders };
