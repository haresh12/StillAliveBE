'use strict';
// ════════════════════════════════════════════════════════════════════
// healthkit/scoring-adapter.js — single source mapping raw HK imports
// to the `hkSignals` shape each agent's scoring lib expects.
//
// V3 contract §4: HK is a PASSIVE DEPTH SIGNAL, never a gate. A user who
// denies HK permission sees scores identical to the baseline snapshot
// (verified by tests/no-hk-parity.test.js).
//
// Existing `lib/healthkit/blend.js` does GAP-FILL (synthesizes per-day
// quality on days without manual logs — for analytics + cross-agent reads).
// This module is the ENHANCEMENT path: it builds the per-agent `hkSignals`
// object that scoring libs consume to deepen the manual-log score (e.g.
// real overnight HRV instead of self-reported energy).
//
// Output contract:
//   buildHkSignals({ deviceId, agent, hkImports }) → hkSignals | null
//
//   sleep:   { hours_last_night, efficiency_pct, hrv_overnight_ms, resting_hr_drop_pct, sleep_stages }
//   fitness: { workouts_last_7d: [{date,duration_min}], steps_last_7d_avg, resting_hr_baseline_bpm, hrv_baseline_ms }
//   mind:    { hrv_overnight_ms, hrv_trend_7d_pct, mindful_minutes_last_7d }
//   water:   { active_kcal_today, ambient_temp_c, skin_temp_c }
//
// All numerics use 7d-smoothing where possible — single bad reading cannot
// tank a score.
// ════════════════════════════════════════════════════════════════════

const _avg = (arr) => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;
const _round = (v) => Math.round(v);
const _round1 = (v) => Math.round(v * 10) / 10;

// ─── Date helpers ────────────────────────────────────────────────────
function _isoToLocalDate(iso, utcOffsetMin = 0) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const local = new Date(ms + utcOffsetMin * 60_000);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-${String(local.getUTCDate()).padStart(2, '0')}`;
}

function _bucketByDate(samples, utcOffsetMin = 0) {
  const out = {};
  for (const s of (samples || [])) {
    const d = _isoToLocalDate(s.start_date || s.startDate, utcOffsetMin);
    if (!d) continue;
    if (!out[d]) out[d] = [];
    out[d].push(s);
  }
  return out;
}

// ─── Sleep ──────────────────────────────────────────────────────────
function buildSleepHkSignals({ hkImports = [], todayDate, utcOffsetMin = 0 } = {}) {
  if (!hkImports.length) return null;
  const byDate = _bucketByDate(hkImports, utcOffsetMin);

  // Last night's sleep summary (typically the day BEFORE today since user
  // wakes up "today" but sleep was scored against yesterday).
  const yesterday = (() => {
    if (!todayDate) return null;
    const [y, m, d] = todayDate.split('-').map(Number);
    const ms = Date.UTC(y, m - 1, d) - 86_400_000;
    const dt = new Date(ms);
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
  })();

  const nightSamples = (byDate[yesterday] || []).filter((s) => s.hk_type === 'HKCategoryTypeIdentifierSleepAnalysis');
  if (!nightSamples.length) return null;

  // Aggregate stages into (asleep_ms, awake_ms, deep_ms, rem_ms)
  let asleepMs = 0, awakeMs = 0, deepMs = 0, remMs = 0, lightMs = 0;
  for (const s of nightSamples) {
    const dur = Date.parse(s.end_date || s.endDate) - Date.parse(s.start_date || s.startDate);
    if (!Number.isFinite(dur) || dur <= 0) continue;
    const stage = (s.stage || '').toLowerCase();
    if (stage.includes('awake')) awakeMs += dur;
    else if (stage.includes('deep')) { deepMs += dur; asleepMs += dur; }
    else if (stage.includes('rem'))  { remMs  += dur; asleepMs += dur; }
    else if (stage.includes('core') || stage.includes('light')) { lightMs += dur; asleepMs += dur; }
    else if (stage.includes('asleep')) asleepMs += dur;
  }

  if (asleepMs <= 0) return null;
  const totalInBedMs = asleepMs + awakeMs;
  const efficiency = totalInBedMs > 0 ? (asleepMs / totalInBedMs) * 100 : null;

  // HRV / HR data lookup (if present in same night's samples)
  const hrvSamples = nightSamples.filter((s) => s.hk_type === 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN');
  const hrvAvg = hrvSamples.length ? _avg(hrvSamples.map((s) => Number(s.value) || 0)) : null;

  return {
    hours_last_night: _round1(asleepMs / 3_600_000),
    efficiency_pct: Number.isFinite(efficiency) ? _round(efficiency) : null,
    hrv_overnight_ms: Number.isFinite(hrvAvg) ? _round1(hrvAvg) : null,
    resting_hr_drop_pct: null,   // requires day-vs-night HR — caller may add
    sleep_stages: {
      deep_min: _round(deepMs / 60_000),
      rem_min:  _round(remMs  / 60_000),
      light_min: _round(lightMs / 60_000),
      awake_min: _round(awakeMs / 60_000),
    },
  };
}

// ─── Fitness ─────────────────────────────────────────────────────────
function buildFitnessHkSignals({ hkImports = [], todayDate, utcOffsetMin = 0 } = {}) {
  if (!hkImports.length) return null;
  const byDate = _bucketByDate(hkImports, utcOffsetMin);

  // Last 7d window
  const last7 = [];
  if (todayDate) {
    const [y, m, d] = todayDate.split('-').map(Number);
    const todayMs = Date.UTC(y, m - 1, d);
    for (let i = 6; i >= 0; i--) {
      const ms = todayMs - i * 86_400_000;
      const dt = new Date(ms);
      last7.push(`${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`);
    }
  }

  const workouts_last_7d = [];
  let stepsAll = [], rhrAll = [], hrvAll = [];

  for (const date of last7) {
    const samples = byDate[date] || [];
    const workouts = samples.filter((s) => s.hk_type === 'HKWorkoutTypeIdentifier');
    for (const w of workouts) {
      workouts_last_7d.push({
        date,
        duration_min: Math.round((Number(w.duration) || 0) / 60),
        energy_kcal: Math.round(Number(w.total_energy_burned) || 0),
        workout_type: w.workout_activity_type || null,
      });
    }
    const stepsToday = samples
      .filter((s) => s.hk_type === 'HKQuantityTypeIdentifierStepCount')
      .reduce((sum, s) => sum + (Number(s.value) || 0), 0);
    if (stepsToday > 0) stepsAll.push(stepsToday);

    const rhrToday = samples
      .filter((s) => s.hk_type === 'HKQuantityTypeIdentifierRestingHeartRate')
      .map((s) => Number(s.value) || 0)
      .filter(Number.isFinite);
    if (rhrToday.length) rhrAll.push(_avg(rhrToday));

    const hrvToday = samples
      .filter((s) => s.hk_type === 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN')
      .map((s) => Number(s.value) || 0)
      .filter(Number.isFinite);
    if (hrvToday.length) hrvAll.push(_avg(hrvToday));
  }

  if (workouts_last_7d.length === 0 && stepsAll.length === 0 && rhrAll.length === 0) return null;

  return {
    workouts_last_7d,
    steps_last_7d_avg: stepsAll.length ? _round(_avg(stepsAll)) : null,
    resting_hr_baseline_bpm: rhrAll.length ? _round(_avg(rhrAll)) : null,
    hrv_baseline_ms: hrvAll.length ? _round1(_avg(hrvAll)) : null,
  };
}

// ─── Mind ────────────────────────────────────────────────────────────
function buildMindHkSignals({ hkImports = [], todayDate, utcOffsetMin = 0 } = {}) {
  if (!hkImports.length) return null;
  const byDate = _bucketByDate(hkImports, utcOffsetMin);

  // 7d HRV trend (mind uses HRV as anxiety proxy)
  const last7 = [];
  if (todayDate) {
    const [y, m, d] = todayDate.split('-').map(Number);
    const todayMs = Date.UTC(y, m - 1, d);
    for (let i = 6; i >= 0; i--) {
      const ms = todayMs - i * 86_400_000;
      const dt = new Date(ms);
      last7.push(`${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`);
    }
  }

  const hrvDaily = last7.map((date) => {
    const samples = (byDate[date] || []).filter((s) => s.hk_type === 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN');
    return samples.length ? _avg(samples.map((s) => Number(s.value) || 0)) : null;
  });
  const hrvValid = hrvDaily.filter(Number.isFinite);
  if (!hrvValid.length) {
    // Also check for mindful minutes
    const mindfulSamples = Object.values(byDate).flat().filter((s) => s.hk_type === 'HKCategoryTypeIdentifierMindfulSession');
    if (!mindfulSamples.length) return null;
    const totalMin = mindfulSamples.reduce((sum, s) => {
      const dur = Date.parse(s.end_date || s.endDate) - Date.parse(s.start_date || s.startDate);
      return sum + (Number.isFinite(dur) && dur > 0 ? dur / 60_000 : 0);
    }, 0);
    return { hrv_overnight_ms: null, hrv_trend_7d_pct: null, mindful_minutes_last_7d: _round(totalMin) };
  }

  const hrvLast3 = hrvValid.slice(-3);
  const hrvFirst3 = hrvValid.slice(0, 3);
  const trendPct = hrvFirst3.length ? Math.round(((_avg(hrvLast3) - _avg(hrvFirst3)) / _avg(hrvFirst3)) * 100) : null;

  return {
    hrv_overnight_ms: _round1(_avg(hrvLast3)),
    hrv_trend_7d_pct: Number.isFinite(trendPct) ? trendPct : null,
    mindful_minutes_last_7d: null,
  };
}

// ─── Water ───────────────────────────────────────────────────────────
function buildWaterHkSignals({ hkImports = [], todayDate, utcOffsetMin = 0 } = {}) {
  if (!hkImports.length) return null;
  const byDate = _bucketByDate(hkImports, utcOffsetMin);

  const samplesToday = byDate[todayDate] || [];

  const active_kcal_today = samplesToday
    .filter((s) => s.hk_type === 'HKQuantityTypeIdentifierActiveEnergyBurned')
    .reduce((sum, s) => sum + (Number(s.value) || 0), 0);

  // Apple Watch only ships skin/ambient temp on certain models — accept if present.
  const skinTempSamples = samplesToday
    .filter((s) => s.hk_type === 'HKQuantityTypeIdentifierAppleSleepingWristTemperature' || s.hk_type === 'HKQuantityTypeIdentifierBasalBodyTemperature')
    .map((s) => Number(s.value) || 0)
    .filter(Number.isFinite);
  const skin_temp_c = skinTempSamples.length ? _round1(_avg(skinTempSamples)) : null;

  if (active_kcal_today === 0 && skin_temp_c == null) return null;

  return {
    active_kcal_today: Math.round(active_kcal_today),
    ambient_temp_c: null,  // not typically in HK
    skin_temp_c,
  };
}

// ─── Dispatcher ──────────────────────────────────────────────────────
function buildHkSignals({ agent, hkImports, todayDate, utcOffsetMin = 0 } = {}) {
  if (!hkImports || !hkImports.length) return null;
  switch (agent) {
    case 'sleep':   return buildSleepHkSignals({ hkImports, todayDate, utcOffsetMin });
    case 'fitness': return buildFitnessHkSignals({ hkImports, todayDate, utcOffsetMin });
    case 'mind':    return buildMindHkSignals({ hkImports, todayDate, utcOffsetMin });
    case 'water':   return buildWaterHkSignals({ hkImports, todayDate, utcOffsetMin });
    default:        return null;
  }
}

module.exports = {
  buildHkSignals,
  buildSleepHkSignals,
  buildFitnessHkSignals,
  buildMindHkSignals,
  buildWaterHkSignals,
};
