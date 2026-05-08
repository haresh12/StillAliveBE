/**
 * Nutrition adapter.
 * Reads from wellness_users/{id}/agents/nutrition/food_logs.
 * Per-log fields: calories, protein, carbs, fat, meal_type, food_name, date_str.
 */

const { buildAdapter, daysBetween, dateOf, agentScores } = require('./_helpers');

function sumOf(arr, key) {
  return arr.map((x) => Number(x[key])).filter(Number.isFinite).reduce((a, b) => a + b, 0);
}

module.exports = buildAdapter({
  agent: 'nutrition',

  async readSetup(deviceId, { agentData }) {
    const completedAt = agentData.setup_completed_at || agentData.created_at || null;
    const today = new Date().toISOString().slice(0, 10);
    const completedDate = dateOf(completedAt);
    return {
      is_complete: !!agentData.setup_complete,
      completed_at: completedAt ? new Date(completedAt._seconds ? completedAt._seconds * 1000 : completedAt).toISOString() : null,
      days_since_setup: completedDate ? Math.max(0, daysBetween(completedDate, today)) : 0,
      config: {
        calorie_target: Number(agentData.calorie_target || agentData.daily_calorie_target || 2200),
        protein_target_g: Number(agentData.protein_target_g || agentData.protein_target || 130),
      },
    };
  },

  scoreDailyLogs(logs, agentData) {
    const cal_target = Number(agentData.calorie_target || agentData.daily_calorie_target || 2200);
    const protein_target = Number(agentData.protein_target_g || agentData.protein_target || 130);

    const calories = sumOf(logs, 'calories');
    const protein = sumOf(logs, 'protein');

    const calorie_adherence = cal_target > 0
      ? 1 - Math.min(1, Math.abs(calories - cal_target) / cal_target)
      : 0;
    const protein_adherence = protein_target > 0
      ? Math.min(1, protein / protein_target)
      : 0;

    const out = agentScores.computeNutritionScore({
      calorie_adherence,
      protein_adherence,
      streak: 0,
      macro_balance: 0.7,
      days_logged: logs.length,
    });
    return out && Number.isFinite(out.score) ? out.score : null;
  },

  componentsForToday(logs) {
    return {
      calories: sumOf(logs, 'calories'),
      protein: sumOf(logs, 'protein'),
      carbs: sumOf(logs, 'carbs'),
      fat: sumOf(logs, 'fat'),
      meals: logs.length,
    };
  },
});
