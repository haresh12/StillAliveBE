'use strict';
// ════════════════════════════════════════════════════════════════════
// nutrition-same-day.js — "Typical Monday breakfast" suggestion builder.
//
// No nutrition app (Cal AI, MFP, MacroFactor, Cronometer, FoodNoms,
// Lifesum) surfaces same-day-last-week routine memory for meals — clear
// moat. Routine recurrence research (PMC9002488 food habits): weekday
// eating is significantly more routine than weekends.
//
// Strategy: look at the user's logs over the last 28 days; for the
// current weekday + the most-recent un-logged meal type (breakfast at
// 8am, lunch at 12pm, dinner at 7pm), find the most-frequent food
// pattern. Tier by "confidence" (high/mid/low/stale) the same way
// FitnessSameDayCard does.
//
// Pure helper — caller (nutrition.agent.js /today route) supplies the
// raw log list. Returns null if no usable pattern.
// ════════════════════════════════════════════════════════════════════

const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];

const HOUR_TO_MEAL = (h) => {
  if (h == null) return 'snack';
  if (h >= 5 && h < 11) return 'breakfast';
  if (h >= 11 && h < 15) return 'lunch';
  if (h >= 15 && h < 18) return 'snack';
  if (h >= 18 && h < 22) return 'dinner';
  return 'snack';
};

function _dowOf(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return -1;
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

function _daysAgo(dateStr, todayDateStr) {
  const a = new Date(dateStr + 'T12:00:00');
  const b = new Date(todayDateStr + 'T12:00:00');
  return Math.round((b - a) / 86_400_000);
}

/**
 * Build a same-day-last-week-style meal suggestion.
 *
 * @param {Object} opts
 * @param {Array} opts.logs            — last 28 days of food_logs docs
 * @param {string} opts.todayDateStr   — YYYY-MM-DD
 * @param {number} opts.nowHour        — local hour 0-23
 * @param {Array<string>} opts.alreadyLoggedToday — meal_types user already logged today
 * @returns {Object|null} suggestion shape (see FE NutritionSameDayCard for props)
 */
function buildSameDayMealSuggestion({logs, todayDateStr, nowHour, alreadyLoggedToday = []} = {}) {
  if (!Array.isArray(logs) || logs.length === 0 || !todayDateStr) return null;

  const todayDow = _dowOf(todayDateStr);
  if (todayDow < 0) return null;
  const todayLoggedSet = new Set((alreadyLoggedToday || []).map((m) => String(m).toLowerCase()));

  // Candidate meal type ranking: prefer the meal of the current hour
  // that the user hasn't logged yet today. Fall back to next-most-
  // relevant meal types in order.
  const primary = HOUR_TO_MEAL(nowHour);
  const order = [primary, ...MEAL_TYPES.filter((m) => m !== primary)];
  let chosenMeal = null;
  for (const m of order) {
    if (!todayLoggedSet.has(m)) { chosenMeal = m; break; }
  }
  if (!chosenMeal) return null;

  // Bucket prior logs by (dow + meal_type), score frequency.
  // We index by `weekdaySameAsTodayAndMealMatch` for the "TYPICAL MONDAY"
  // confidence; secondary index is any-day same-meal for fallback copy.
  const sameDow = [];
  const sameMealAllDays = [];
  for (const l of logs) {
    if (!l?.date || !l.meal_type) continue;
    if (l.date > todayDateStr) continue;             // future-safe
    if (l.date === todayDateStr) continue;           // ignore today
    const mt = String(l.meal_type).toLowerCase();
    if (mt !== chosenMeal) continue;
    sameMealAllDays.push(l);
    if (_dowOf(l.date) === todayDow) sameDow.push(l);
  }

  if (sameDow.length === 0 && sameMealAllDays.length === 0) return null;

  // Pick the canonical "what this user typically logs for this meal"
  // by selecting the **most recent date** that has the largest number of
  // items, scoped to sameDow if available.
  const pool = sameDow.length >= 1 ? sameDow : sameMealAllDays;
  const byDate = {};
  for (const l of pool) {
    if (!byDate[l.date]) byDate[l.date] = [];
    byDate[l.date].push(l);
  }
  // Score each date by (items × recency_bonus). Newest wins ties.
  const scoredDates = Object.entries(byDate).map(([date, items]) => {
    const recencyBonus = 1 / (1 + _daysAgo(date, todayDateStr) / 7);
    return {date, items, score: items.length * recencyBonus};
  }).sort((a, b) => b.score - a.score);
  const pick = scoredDates[0];
  if (!pick) return null;

  // Confidence tier
  let confidence;
  let label;
  const dowName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][todayDow];
  const sameDowDates = Object.keys(byDate).filter(d => _dowOf(d) === todayDow);
  const sameDowCount = sameDowDates.length;
  const recentSameDowCount = sameDowDates.filter(d => _daysAgo(d, todayDateStr) <= 28).length;
  const daysAgo = _daysAgo(pick.date, todayDateStr);

  if (recentSameDowCount >= 3) {
    confidence = 'high';
    label = `TYPICAL ${dowName.toUpperCase()} ${chosenMeal.toUpperCase()}`;
  } else if (recentSameDowCount === 2) {
    confidence = 'mid';
    label = `LAST 2 ${dowName.toUpperCase()}S`;
  } else if (recentSameDowCount === 1) {
    confidence = 'low';
    label = `LAST ${dowName.toUpperCase()}`;
  } else if (daysAgo <= 14) {
    confidence = 'low';
    label = `LAST ${chosenMeal.toUpperCase()}`;
  } else {
    confidence = 'stale';
    label = `${Math.round(daysAgo / 7)} WEEKS AGO`;
  }

  const items = pick.items.map((l) => ({
    name: l.food_name || l.name || 'item',
    qty:  l.quantity,
    unit: l.unit,
    kcal: Number.isFinite(l.calories) ? l.calories
        : Number.isFinite(l.kcal) ? l.kcal
        : null,
    protein_g: Number.isFinite(l.protein) ? l.protein
              : Number.isFinite(l.protein_g) ? l.protein_g
              : null,
    carb_g: Number.isFinite(l.carbs) ? l.carbs : Number.isFinite(l.carb_g) ? l.carb_g : null,
    fat_g:  Number.isFinite(l.fat) ? l.fat : null,
  }));
  const totalKcal = items.reduce((s, it) => s + (it.kcal || 0), 0);
  const totalProtein = items.reduce((s, it) => s + (it.protein_g || 0), 0);

  return {
    meal_type: chosenMeal,
    meal_label: `${dowName} ${chosenMeal.charAt(0).toUpperCase() + chosenMeal.slice(1)}`,
    items,
    total_kcal: Math.round(totalKcal),
    total_protein_g: Math.round(totalProtein),
    frequency: {
      label,
      confidence,
      same_dow_count: sameDowCount,
      same_pattern_count: recentSameDowCount,
      days_ago: daysAgo,
    },
    source_date: pick.date,
  };
}

module.exports = {
  buildSameDayMealSuggestion,
  HOUR_TO_MEAL,
  MEAL_TYPES,
};
