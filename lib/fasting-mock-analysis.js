'use strict';
/**
 * fasting-mock-analysis.js
 *
 * Generates a REALISTIC `/analysis` response for any range (7 / 30 / 90 / 365)
 * without writing to Firestore. Used when caller passes `?mock=1`.
 *
 * Purpose: give product / design / QA a way to see what the Insights tab
 * looks like for a long-term faster, without seeding 300 real sessions.
 *
 * Profile of the synthetic user:
 *   - 16:8 protocol, ~85% completion rate
 *   - Started 1Y ago, weight 90kg → trending down to 78kg
 *   - Stage depth distribution skewed toward fat-burning + ketosis
 *   - Occasional broken fasts (~15%) with realistic reasons
 *   - Streaks broken every 2–4 weeks
 *
 * Pure function — no Firestore reads, no AI calls, no side effects.
 */

function _dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function _seededRand(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function _rangeDays(range) {
  const n = parseInt(range, 10);
  if (n === 7)   return 7;
  if (n === 30)  return 30;
  if (n === 90)  return 90;
  if (n === 365) return 365;
  return 30;
}

/**
 * Produce realistic synthetic sessions across a range of N days ending today.
 * Each day has an ~85% chance of a fast: 14h–18h actual hours, broken vs
 * completed by simple threshold. Streaks naturally form/break.
 */
function _genSessions(rangeDays, seed = 42) {
  const rand = _seededRand(seed);
  const today = new Date();
  const sessions = [];
  for (let i = 0; i < rangeDays; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - (rangeDays - 1 - i));
    // 85% of days have a fast
    if (rand() > 0.85) continue;
    // Hours: bimodal — 70% in 14-18h zone, 15% short broken (4-10h), 15% deeper (18-22h)
    const r = rand();
    let actualH;
    let broken;
    let reason = null;
    if (r < 0.15) {
      actualH = 4 + rand() * 6;
      broken = true;
      reason = ['hunger', 'social', 'energy', 'mood'][Math.floor(rand() * 4)];
    } else if (r < 0.85) {
      actualH = 14 + rand() * 4;
      broken = actualH < 16;
    } else {
      actualH = 18 + rand() * 4;
      broken = false;
    }
    const targetH = 16;
    const completed = !broken && actualH >= targetH;
    const startedHour = 20 + Math.floor(rand() * 3); // 8–11pm
    const startedAt = new Date(d);
    startedAt.setHours(startedHour, Math.floor(rand() * 60), 0, 0);
    const endedAt = new Date(startedAt.getTime() + actualH * 3600 * 1000);
    sessions.push({
      date: _dateKey(d),
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      actual_hours: +actualH.toFixed(2),
      target_hours: targetH,
      completed,
      broken_early: broken,
      broken_reason: reason,
      metabolic_stage_reached:
        actualH >= 24 ? 'deep_fast' :
        actualH >= 18 ? 'autophagy' :
        actualH >= 16 ? 'ketosis_entry' :
        actualH >= 12 ? 'fat_burning' :
        actualH >= 8  ? 'glycogen' :
        actualH >= 4  ? 'post_absorptive' : 'fed',
    });
  }
  return sessions;
}

/**
 * Synthetic weight journey: linear trend from start → goal across the range
 * with mild jitter. Only generated for ranges ≥ 30 days.
 */
function _genWeightJourney(rangeDays, seed = 99) {
  if (rangeDays < 14) return null;
  const rand = _seededRand(seed);
  const today = new Date();
  const startKg = 90;
  const goalKg  = 78;
  // Distance traveled is proportional to range fraction of full plan (90d goal)
  const planDays = 90;
  const targetKg = Math.max(goalKg, startKg - (startKg - goalKg) * (rangeDays / planDays));
  const entries = [];
  const stepDays = Math.max(1, Math.floor(rangeDays / 14)); // ~14 sample points
  for (let i = 0; i <= 14; i++) {
    const dayOffset = Math.floor((i / 14) * (rangeDays - 1));
    const d = new Date(today);
    d.setDate(today.getDate() - (rangeDays - 1 - dayOffset));
    const fraction = i / 14;
    const baseKg = startKg + (targetKg - startKg) * fraction;
    const jitter = (rand() - 0.5) * 0.4;
    entries.push({ date: _dateKey(d), kg: +(baseKg + jitter).toFixed(1) });
  }
  return {
    entries,
    start_kg:   startKg,
    goal_kg:    goalKg,
    current_kg: entries[entries.length - 1].kg,
    unit:       'kg',
  };
}

function _sum(arr, key) { return arr.reduce((s, x) => s + (x[key] || 0), 0); }
function _avg(arr, key) { return arr.length ? _sum(arr, key) / arr.length : 0; }

function _computeStreak(sessions) {
  if (sessions.length === 0) return 0;
  const sorted = sessions.slice().sort((a, b) => b.date.localeCompare(a.date));
  let streak = 0;
  let cursor = new Date();
  for (const s of sorted) {
    const dk = _dateKey(cursor);
    if (s.date === dk && s.completed) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else if (s.date === dk && !s.completed) {
      break;
    } else {
      break;
    }
  }
  return streak;
}

/**
 * Build the full /analysis response payload from synthetic sessions.
 */
function buildMockAnalysis(range = '30') {
  const rangeDays = _rangeDays(range);
  const sessions = _genSessions(rangeDays);
  const wj = _genWeightJourney(rangeDays);
  const today = new Date();
  const todayKey = _dateKey(today);

  // Daily logs: { date: actual_hours }
  const dailyLogs = {};
  for (const s of sessions) dailyLogs[s.date] = s.actual_hours;

  // Signal points: per day, value = actual_hours, has_data = true
  const signalPoints = [];
  for (let i = 0; i < rangeDays; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - (rangeDays - 1 - i));
    const dk = _dateKey(d);
    const v = dailyLogs[dk] || 0;
    signalPoints.push({ date: dk, value: v, has_data: v > 0 });
  }

  // Stage breakdown
  const stageCounts = { fed: 0, post_absorptive: 0, glycogen: 0, fat_burning: 0, ketosis_entry: 0, autophagy: 0, deep_fast: 0 };
  for (const s of sessions) {
    if (stageCounts[s.metabolic_stage_reached] != null) stageCounts[s.metabolic_stage_reached]++;
  }
  const stageBreakdown = Object.entries(stageCounts)
    .filter(([, c]) => c > 0)
    .map(([id, count]) => ({ id, label: id, count }))
    .sort((a, b) => b.count - a.count);

  // Depth mix percentages
  const total_n = sessions.length;
  const fed_n      = sessions.filter(s => s.actual_hours < 4).length;
  const glycogen_n = sessions.filter(s => s.actual_hours >= 4  && s.actual_hours < 12).length;
  const fat_n      = sessions.filter(s => s.actual_hours >= 12 && s.actual_hours < 16).length;
  const ketone_n   = sessions.filter(s => s.actual_hours >= 16 && s.actual_hours < 24).length;
  const deep_n     = sessions.filter(s => s.actual_hours >= 24).length;
  const working_n  = fat_n + ketone_n + deep_n;
  const pct = (n) => total_n > 0 ? +((n / total_n) * 100).toFixed(1) : 0;

  // Contribution map (1Y heatmap)
  const contribCells = [];
  for (let i = 0; i < 365; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - (364 - i));
    const dk = _dateKey(d);
    const sess = sessions.find(s => s.date === dk);
    let level = 0;
    if (sess) {
      if (sess.actual_hours >= 16) level = 3;
      else if (sess.actual_hours >= 10) level = 2;
      else level = 1;
    }
    contribCells.push({
      date: dk,
      level,
      pre_anchor: false,
      future: dk > todayKey,
    });
  }
  const loggedDays = contribCells.filter(c => c.level > 0).length;

  // Start-hour grid (7×24)
  const startHourGrid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const s of sessions) {
    const dt = new Date(s.started_at);
    const dow = (dt.getDay() + 6) % 7; // Mon=0
    const hr  = dt.getHours();
    startHourGrid[dow][hr]++;
  }

  // Score: weighted avg of completion + depth + consistency
  const completion = total_n > 0 ? sessions.filter(s => s.completed).length / total_n : 0;
  const avgH       = _avg(sessions, 'actual_hours');
  const bestH      = sessions.length ? Math.max(...sessions.map(s => s.actual_hours)) : 0;
  const totalH     = _sum(sessions, 'actual_hours');
  const score = Math.round(
    completion * 40 +
    (working_n / Math.max(1, total_n)) * 30 +
    Math.min(20, avgH) +
    Math.min(10, sessions.length * 0.5)
  );
  const grade = score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : '—';

  const streak = _computeStreak(sessions);
  const longestStreak = Math.max(streak, Math.floor(rangeDays / 6));

  // Score gates
  const scoreGates = {
    adherence:       { label: 'Adherence',       pts: Math.round(completion * 35), weight: 35 },
    metabolic_depth: { label: 'Metabolic Depth', pts: Math.min(25, Math.round((working_n / Math.max(1, total_n)) * 25)), weight: 25 },
    metabolic_qual:  { label: 'Stage Quality',   pts: Math.min(20, Math.round(avgH)), weight: 20 },
    consistency:     { label: 'Consistency',     pts: Math.min(20, Math.round(sessions.length * 0.5)), weight: 20 },
  };

  // AI reads (mock — short flavorful)
  const aiReads = total_n >= 3 ? {
    champion: { type: 'champion', title: 'Mondays are your strongest day', body: 'You hit your 16-hour target on 4 of 4 Mondays this period.' },
    drag:     { type: 'drag',     title: 'Weekends slip', body: 'Fasts on Saturday averaged 11.2h vs 16.1h weekday avg. Social meals seem to break the window.' },
    pattern:  { type: 'pattern',  title: '8pm start beats 9pm by 18 min', body: 'When you start by 8pm, you complete 92% of the time. After 9pm: 64%.' },
  } : { champion: null, drag: null, pattern: null };

  return {
    setup_completed: true,
    range,
    effective_start_date: signalPoints[0]?.date || todayKey,
    effective_days: rangeDays,
    days_since_anchor: 365,
    anchor_date: signalPoints[0]?.date || todayKey,
    is_clamped: false,
    score_today:        score,
    score_7d_smoothed:  score,
    score_lifetime:     score,
    missed_days:        Math.max(0, rangeDays - total_n),
    score,
    score_grade: grade,
    score_gates: scoreGates,
    fasting_score: { score, components: { adherence: scoreGates.adherence.pts, depth: scoreGates.metabolic_depth.pts, metabolic: scoreGates.metabolic_qual.pts, consistency: scoreGates.consistency.pts } },
    efh_per_day: Math.max(0, +(avgH - 12).toFixed(1)),
    signal_points: signalPoints,
    daily_logs: dailyLogs,
    stage_breakdown: stageBreakdown,
    ai_reads: aiReads,
    aha_moments: [],
    circadian: { score: 78, peak_start_hour: 20, eating_window_start: 12 },
    best_day: 'Mon',
    worst_day: 'Sat',
    streak,
    longest_streak: longestStreak,
    completion: +completion.toFixed(2),
    avg_hours:  +avgH.toFixed(1),
    best_fast:  +bestH.toFixed(1),
    total_fast_hours: +totalH.toFixed(0),
    target_hours: 16,
    personal_formula: total_n >= 5
      ? `You complete ${Math.round(completion * 100)}% of 16:8 fasts and average ${avgH.toFixed(1)}h. Strongest on weekday mornings.`
      : null,
    observations: [],
    ready_for_upgrade: completion >= 0.85 && avgH >= 15.5,
    upgrade_suggestion: completion >= 0.85 && avgH >= 15.5 ? '18:6' : null,
    // V4 keys
    form: {
      ctl_hours: +avgH.toFixed(1),
      atl_hours: +(avgH * 0.95).toFixed(1),
      tsb: 0,
      ratio: 1.0,
      readiness: Math.round(score * 0.9),
      band: score >= 80 ? 'consistent' : score >= 65 ? 'building' : 'undermatured',
      explain: 'Your fasting load is balanced for your protocol.',
    },
    prior: total_n >= 6 ? {
      total_hours: +(totalH * 0.85).toFixed(0),
      days_logged: Math.max(1, total_n - 3),
      depth_hits: working_n - 1,
      broken_count: sessions.filter(s => s.broken_early).length - 1,
      delta_hours_pct: 12,
      delta_depth_abs: 1,
      delta_broken_abs: -1,
    } : null,
    depth_mix: {
      fed_pct: pct(fed_n),
      glycogen_pct: pct(glycogen_n),
      fat_pct: pct(fat_n),
      ketone_pct: pct(ketone_n),
      deep_pct: pct(deep_n),
      working_n,
      total_n,
    },
    window_stability: total_n >= 3 ? {
      median_start_hour: 20.5,
      median_end_hour: 12.5,
      std_start_hours: 0.8,
      std_end_hours: 1.1,
      drift_flag: false,
      sample_n: total_n,
    } : null,
    protocol_variety: { dominant_protocol: '16:8', unique_protocols: 1, stagnant: false },
    start_hour_grid: startHourGrid,
    contribution_map: {
      cells: contribCells,
      summary: {
        logged_days: loggedDays,
        missed_days: 365 - loggedDays,
        span_days: 365,
        total_cells: 365,
      },
    },
    contribution_summary: {
      logged_days: loggedDays,
      missed_days: 365 - loggedDays,
      span_days: 365,
      total_cells: 365,
    },
    habituation: { stalled: false, weeks_stalled: 0 },
    cleanness: {
      avg_hours: +avgH.toFixed(1),
      broken_pct: total_n > 0 ? +((sessions.filter(s => s.broken_early).length / total_n) * 100).toFixed(0) : 0,
      hunger_break_pct: 30,
      social_break_pct: 25,
      mood_break_pct: 20,
      energy_break_pct: 15,
    },
    weight_journey: wj,
    stats: { count: total_n, days_logged: total_n },
    today_date: todayKey,
    cross_insights: {
      items: [
        { id: 'sleep', icon: '💤', value: '6.8h',  label: 'sleep last night', hot: false },
        { id: 'water', icon: '💧', value: '72%',   label: 'hydration today',  hot: false },
        { id: 'mood',  icon: '🧠', value: '2.1/5', label: 'anxiety today',    hot: false },
      ],
    },
  };
}

module.exports = { buildMockAnalysis };
