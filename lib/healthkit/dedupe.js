/**
 * Dedupe layer — merges HealthKit samples with manual logs without
 * double-counting.
 *
 * The rule of thumb per coach (mirrors docs/HEALTHKIT_INTEGRATION.md §6):
 *
 *   Sleep:    HK wins on duration & stages.  Manual wins on quality, disruptors.
 *             ± 30 min overlap window → merge.
 *
 *   Workout:  HK wins on session start/end, HR, calories.
 *             Manual wins on exercises detail, RPE.
 *             ± 15 min start window → merge.
 *
 *   Nutrition: Manual wins (more granular). HK total only used as cross-check.
 *
 *   Water:    Sum both. Dedupe by exact-minute timestamp.
 *
 *   Mind:     No dedupe — HK State of Mind + manual mood log are different facets.
 *
 *   Fasting:  Manual wins (explicit user intent). HK used only to infer
 *             eating window if no manual fast exists.
 *
 * Inputs to functions below are pre-loaded arrays (caller does the fetch).
 * Outputs are merged records with `merged_from: ['healthkit', 'manual']` audit
 * trail so we can debug if a user complains "my score doesn't add up."
 */

const SLEEP_WINDOW_MS = 30 * 60 * 1000; // ±30 min
const WORKOUT_WINDOW_MS = 15 * 60 * 1000; // ±15 min
const WATER_WINDOW_MS = 60 * 1000; // ±1 min (same exact event)

// ─── Sleep ────────────────────────────────────────────────────────────────

function mergeSleep({ healthkitSamples, manualLogs }) {
  // healthkitSamples: [{ startDate, endDate, stage, value, ... }]
  // manualLogs:        [{ bedtime, wake_time, quality, disruptors, note, date_str }]

  // First, fold HK stage samples into per-night blocks. Apple Watch writes
  // many small stage segments — group by night using the bedtime → wake span.
  const nightlyHK = groupSleepIntoNights(healthkitSamples);

  // Now merge each HK night with a matching manual log (if any) by date.
  const out = [];
  const matchedManualIds = new Set();

  for (const hkNight of nightlyHK) {
    const match = manualLogs.find((m) => {
      if (matchedManualIds.has(m.uuid || m.id)) return false;
      const mEnd = m.wake_time_ts || Date.parse(m.date_str + 'T08:00:00Z');
      return Math.abs(mEnd - hkNight.endTs) < SLEEP_WINDOW_MS;
    });
    if (match) {
      matchedManualIds.add(match.uuid || match.id);
      out.push(_mergeSleepNight(hkNight, match));
    } else {
      out.push({ ..._hkNightToRecord(hkNight), merged_from: ['healthkit'] });
    }
  }

  // Manual logs that didn't match any HK night → keep as manual-only
  for (const m of manualLogs) {
    if (matchedManualIds.has(m.uuid || m.id)) continue;
    out.push({ ...m, merged_from: ['manual'] });
  }

  return out;
}

function groupSleepIntoNights(samples) {
  if (!samples || samples.length === 0) return [];
  // Sort by start, then collapse consecutive non-overlapping into one "night"
  // when the gap is < 60min.
  const sorted = [...samples].sort((a, b) => Date.parse(a.startDate) - Date.parse(b.startDate));
  const nights = [];
  let current = null;

  for (const s of sorted) {
    const startTs = Date.parse(s.startDate);
    const endTs = Date.parse(s.endDate);

    if (!current) {
      current = { startTs, endTs, stages: { [s.stage]: 1 }, sources: [s.source] };
      continue;
    }

    // If this sample starts within 60 min of the previous end → same night
    if (startTs - current.endTs < 60 * 60 * 1000) {
      current.endTs = Math.max(current.endTs, endTs);
      current.stages[s.stage] = (current.stages[s.stage] || 0) + (endTs - startTs);
      if (!current.sources.includes(s.source)) current.sources.push(s.source);
    } else {
      nights.push(current);
      current = { startTs, endTs, stages: { [s.stage]: endTs - startTs }, sources: [s.source] };
    }
  }
  if (current) nights.push(current);
  return nights;
}

function _hkNightToRecord(night) {
  const durationMs = night.endTs - night.startTs;
  const totalAwakeMs = night.stages.awake || 0;
  const totalSleepMs = durationMs - totalAwakeMs;
  const rem = night.stages.asleepREM || 0;
  const deep = night.stages.asleepDeep || 0;

  return {
    source: 'healthkit',
    startDate: new Date(night.startTs).toISOString(),
    endDate: new Date(night.endTs).toISOString(),
    total_sleep_hours: totalSleepMs / 3_600_000,
    sleep_efficiency: durationMs > 0 ? (totalSleepMs / durationMs) * 100 : 0,
    rem_pct: totalSleepMs > 0 ? (rem / totalSleepMs) * 100 : 0,
    deep_pct: totalSleepMs > 0 ? (deep / totalSleepMs) * 100 : 0,
    hk_sources: night.sources,
  };
}

function _mergeSleepNight(hkNight, manual) {
  const hk = _hkNightToRecord(hkNight);
  return {
    // HK wins (objective)
    startDate: hk.startDate,
    endDate: hk.endDate,
    total_sleep_hours: hk.total_sleep_hours,
    sleep_efficiency: hk.sleep_efficiency,
    rem_pct: hk.rem_pct,
    deep_pct: hk.deep_pct,
    // Manual wins (subjective)
    sleep_quality: manual.sleep_quality,
    disruptors: manual.disruptors || [],
    note: manual.note || null,
    morning_energy: manual.morning_energy,
    // Audit
    source: 'merged',
    merged_from: ['healthkit', 'manual'],
    hk_sources: hk.hk_sources,
    manual_id: manual.uuid || manual.id,
  };
}

// ─── Workouts ─────────────────────────────────────────────────────────────

function mergeWorkouts({ healthkitWorkouts, manualWorkouts }) {
  const out = [];
  const matched = new Set();

  for (const hk of healthkitWorkouts || []) {
    const hkStart = Date.parse(hk.startDate);
    const match = (manualWorkouts || []).find((m) => {
      if (matched.has(m.uuid || m.id)) return false;
      const mStart = m.logged_at_ts || Date.parse(m.logged_at);
      return Math.abs(mStart - hkStart) < WORKOUT_WINDOW_MS;
    });

    if (match) {
      matched.add(match.uuid || match.id);
      out.push({
        // HK wins
        start_date: hk.startDate,
        end_date: hk.endDate,
        duration_sec: hk.duration,
        total_energy_kcal: hk.totalEnergyBurned,
        workout_type: hk.workoutType,
        // Manual wins
        exercises: match.exercises || [],
        sets_total: match.total_sets || 0,
        volume_kg: match.total_volume_kg || 0,
        rpe_avg: match.rpe_avg || null,
        // Audit
        source: 'merged',
        merged_from: ['healthkit', 'manual'],
        manual_id: match.uuid || match.id,
      });
    } else {
      out.push({
        start_date: hk.startDate,
        end_date: hk.endDate,
        duration_sec: hk.duration,
        total_energy_kcal: hk.totalEnergyBurned,
        workout_type: hk.workoutType,
        source: 'healthkit',
        merged_from: ['healthkit'],
      });
    }
  }

  for (const m of manualWorkouts || []) {
    if (matched.has(m.uuid || m.id)) continue;
    out.push({ ...m, source: 'manual', merged_from: ['manual'] });
  }

  return out;
}

// ─── Water ────────────────────────────────────────────────────────────────

function mergeWater({ healthkitWater, manualWater }) {
  const out = [];
  const matched = new Set();

  for (const hk of healthkitWater || []) {
    const hkTs = Date.parse(hk.startDate);
    const match = (manualWater || []).find((m) => {
      if (matched.has(m.uuid || m.id)) return false;
      const mTs = Date.parse(m.logged_at);
      return Math.abs(mTs - hkTs) < WATER_WINDOW_MS && Math.abs((m.ml || 0) - (hk.value || 0)) < 50;
    });

    if (match) {
      matched.add(match.uuid || match.id);
      // Same event — keep manual (has beverage_type)
      out.push({ ...match, source: 'merged', merged_from: ['healthkit', 'manual'] });
    } else {
      out.push({
        ml: hk.value,
        logged_at: hk.startDate,
        beverage_type: 'water',
        source: 'healthkit',
        merged_from: ['healthkit'],
      });
    }
  }

  for (const m of manualWater || []) {
    if (matched.has(m.uuid || m.id)) continue;
    out.push({ ...m, source: 'manual', merged_from: ['manual'] });
  }

  return out;
}

module.exports = {
  mergeSleep,
  mergeWorkouts,
  mergeWater,
};
