"use strict";
// Fitness candidate engine — uses ONLY fitness_workouts data.
// Extracted from fitness.agent.js so all 6 agents share the same engine pattern.

const VOLUME_LANDMARKS = {
  chest:      { MEV: 8, MAV: [12, 16], MRV: 20 },
  back:       { MEV: 10, MAV: [14, 22], MRV: 25 },
  shoulders:  { MEV: 8, MAV: [16, 22], MRV: 26 },
  quads:      { MEV: 8, MAV: [12, 18], MRV: 20 },
  hamstrings: { MEV: 6, MAV: [10, 16], MRV: 20 },
  glutes:     { MEV: 4, MAV: [12, 16], MRV: 20 },
  biceps:     { MEV: 8, MAV: [14, 20], MRV: 26 },
  triceps:    { MEV: 8, MAV: [14, 20], MRV: 26 },
  calves:     { MEV: 8, MAV: [12, 16], MRV: 20 },
  abs:        { MEV: 0, MAV: [16, 20], MRV: 25 },
};
const TARGET_MUSCLES = Object.keys(VOLUME_LANDMARKS);

function getMs(v) { return v?.toMillis ? v.toMillis() : new Date(v||0).getTime(); }
function round1(n) { return Math.round((n||0) * 10) / 10; }

async function computeFitnessCandidates(workouts, setup) {
  const candidates = [];
  if (!Array.isArray(workouts) || !workouts.length) return candidates;
  const now = Date.now();
  const today = new Date(); today.setHours(0,0,0,0);

  // Last-trained map
  const lastTrained = {};
  const muscleSets = {};
  for (const w of [...workouts].sort((a,b) => (b.date||"").localeCompare(a.date||""))) {
    for (const ex of w.exercises || []) {
      const m = ex.muscle_group;
      if (!m || m === "other" || m === "cardio") continue;
      if (!lastTrained[m]) lastTrained[m] = w.date;
      muscleSets[m] = (muscleSets[m] || 0) + (ex.sets?.length || 0);
    }
  }

  // Last-7d muscle volume
  const cutoff7 = now - 7 * 86400000;
  const muscleVol7d = {};
  for (const w of workouts) {
    if (getMs(w.logged_at) < cutoff7) continue;
    for (const ex of w.exercises || []) {
      const m = ex.muscle_group;
      if (!m || m === "other" || m === "cardio") continue;
      muscleVol7d[m] = (muscleVol7d[m] || 0) + (ex.sets?.length || 0);
    }
  }

  // Prior-7d muscle volume (for MRV consecutive check)
  const cutoff14 = now - 14 * 86400000;
  const muscleVolPrev7 = {};
  for (const w of workouts) {
    const ms = getMs(w.logged_at);
    if (ms < cutoff14 || ms >= cutoff7) continue;
    for (const ex of w.exercises || []) {
      const m = ex.muscle_group;
      if (!m || m === "other" || m === "cardio") continue;
      muscleVolPrev7[m] = (muscleVolPrev7[m] || 0) + (ex.sets?.length || 0);
    }
  }

  // ── WIN_BACK ──
  for (const m of TARGET_MUSCLES) {
    const lastDate = lastTrained[m];
    if (!lastDate) {
      candidates.push({
        archetype: "win_back", score: 95, category: "strength",
        proof: { metric: `${m}_never_trained`, value: 0, threshold: 1, citation: "Israetel RP 2019" },
        proof_text: `${m} has never been logged.`,
        surprise_hook: `${m.charAt(0).toUpperCase()+m.slice(1)} is your biggest gap — zero sets ever.`,
        target: { muscle: m, sets: 4 }, success_type: "train_muscle", when_to_do: "next_session", impact: 3,
      });
      continue;
    }
    const days = Math.floor((today - new Date(lastDate + "T12:00:00")) / 86400000);
    if (days >= 7) {
      candidates.push({
        archetype: "win_back", score: Math.min(95, days * 8), category: "strength",
        proof: { metric: `days_since_${m}`, value: days, threshold: 10, citation: "Mujika & Padilla 2010" },
        proof_text: `${m} not trained in ${days} days. Detraining begins at 10 days (Mujika 2010).`,
        surprise_hook: `Your ${m} hasn't moved in ${days} days — strength decay starts day 10.`,
        target: { muscle: m, sets: 4 }, success_type: "train_muscle", when_to_do: "next_session",
        impact: days >= 14 ? 3 : 2,
      });
    }
  }

  // ── PREVENT — above MRV ──
  for (const m of TARGET_MUSCLES) {
    const lm = VOLUME_LANDMARKS[m];
    if (!lm) continue;
    const cur = muscleVol7d[m] || 0;
    if (cur > lm.MRV) {
      const prev = muscleVolPrev7[m] || 0;
      const consecutive = prev > lm.MRV;
      const score = Math.min(95, (cur - lm.MRV) * 10 + (consecutive ? 30 : 0));
      candidates.push({
        archetype: "prevent", score, category: "recovery",
        proof: { metric: `${m}_weekly_sets`, value: cur, delta: cur - lm.MRV, threshold: lm.MRV, citation: "Israetel RP 2019" },
        proof_text: `${m} at ${cur} sets/wk vs MRV ${lm.MRV}. ${consecutive ? "2nd consecutive week — deload now." : "Pull back this week."}`,
        surprise_hook: `${m} is ${cur - lm.MRV} sets above max recoverable.`,
        target: { muscle: m, sets: lm.MAV[1] }, success_type: "reduce_volume", when_to_do: "this_week", impact: 3,
      });
    }
  }

  // ── BREAKTHROUGH — top-lift slope < 1%/wk ──
  const exSeries = {};
  for (const w of workouts) {
    if (!w.date) continue;
    const dayMs = new Date(w.date + "T12:00:00").getTime();
    for (const ex of w.exercises || []) {
      if (!ex.name) continue;
      const k = ex.name.toLowerCase();
      const maxW = Math.max(0, ...(ex.sets || []).map(s => s.weight_kg || 0));
      if (maxW <= 0) continue;
      if (!exSeries[k]) exSeries[k] = { name: ex.name, points: [] };
      exSeries[k].points.push({ t: dayMs, kg: maxW });
    }
  }
  const seriesList = Object.values(exSeries).filter(e => e.points.length >= 3);
  seriesList.sort((a,b) => b.points.length - a.points.length);
  for (const s of seriesList.slice(0, 3)) {
    const pts = s.points.sort((a,b) => a.t - b.t);
    const t0 = pts[0].t;
    const xs = pts.map(p => (p.t - t0) / (7 * 86400000));
    const ys = pts.map(p => p.kg);
    const n = pts.length;
    const meanX = xs.reduce((a,b)=>a+b, 0) / n;
    const meanY = ys.reduce((a,b)=>a+b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i]-meanX)*(ys[i]-meanY); den += (xs[i]-meanX)**2; }
    const slope = den > 0 ? num / den : 0;
    const baseKg = ys[0];
    const pctPerWk = baseKg > 0 ? (slope / baseKg) * 100 : 0;
    if (pctPerWk < 1.0 && pctPerWk > -2) {
      const lastKg = ys[ys.length - 1];
      const nextTarget = Math.round((lastKg + 2.5) * 2) / 2;
      candidates.push({
        archetype: "breakthrough", score: Math.min(85, Math.round((1.0 - Math.max(0, pctPerWk)) * 80)), category: "strength",
        proof: { metric: `${s.name}_slope_pct_per_wk`, value: round1(pctPerWk), threshold: 1.0, citation: "Helms 2019 MASS" },
        proof_text: `${s.name} progressing ${round1(pctPerWk)}%/wk vs elite 1.0%/wk (Helms 2019).`,
        surprise_hook: `${s.name} stuck at ${lastKg}kg — push to ${nextTarget}kg.`,
        target: { exercise: s.name, weight_kg: nextTarget }, success_type: "hit_weight", when_to_do: "next_session", impact: 3,
      });
    }
  }

  // ── PROGRESS — muscle in MAV climbing ──
  for (const m of TARGET_MUSCLES) {
    const lm = VOLUME_LANDMARKS[m];
    if (!lm) continue;
    const cur = muscleVol7d[m] || 0;
    const prev = muscleVolPrev7[m] || 0;
    if (cur >= lm.MAV[0] && cur <= lm.MAV[1] && prev > 0 && cur > prev) {
      const target = Math.min(lm.MRV - 1, cur + 2);
      candidates.push({
        archetype: "progress", score: 60 + Math.min(20, cur - prev), category: "strength",
        proof: { metric: `${m}_weekly_sets`, value: cur, delta: cur - prev, threshold: lm.MAV[1], citation: "Schoenfeld 2010 JSCR" },
        proof_text: `${m} climbed ${prev}→${cur} sets/wk. Push toward MAV ceiling (${lm.MAV[1]}).`,
        surprise_hook: `${m} jumped ${cur - prev} sets — ride momentum.`,
        target: { muscle: m, sets: target }, success_type: "add_sets", when_to_do: "this_week", impact: 2,
      });
    }
  }

  // ── RECOVER — 3+ hard days ──
  const recentSorted = [...workouts].sort((a,b) => (b.date||"").localeCompare(a.date||"")).slice(0, 5);
  let hardStreak = 0;
  for (const w of recentSorted) {
    if ((w.total_sets || 0) >= 18) hardStreak++;
    else break;
  }
  if (hardStreak >= 3) {
    candidates.push({
      archetype: "recover", score: 60 + hardStreak * 10, category: "recovery",
      proof: { metric: "consecutive_hard_days", value: hardStreak, threshold: 3, citation: "Zatsiorsky CWX" },
      proof_text: `${hardStreak} hard sessions in a row. Schedule a deload day to supercompensate.`,
      surprise_hook: `${hardStreak} hard days back-to-back — your CNS needs a deload.`,
      target: { sets: 0 }, success_type: "log_session", when_to_do: "rest_day", impact: 2,
    });
  }

  // ── EXPLORE — many muscles below 5 sets ──
  const underTrained = TARGET_MUSCLES.filter(m => (muscleVol7d[m] || 0) < 5).length;
  if (underTrained >= 4) {
    candidates.push({
      archetype: "explore", score: 50 + underTrained * 5, category: "strength",
      proof: { metric: "muscles_below_5_sets", value: underTrained, threshold: 4, citation: "Schoenfeld 2017 meta" },
      proof_text: `${underTrained} muscle groups under 5 sets/wk. Broaden split.`,
      surprise_hook: `${underTrained} muscles barely touched.`,
      target: { sets: 4 }, success_type: "train_muscle", when_to_do: "this_week", impact: 2,
    });
  }

  // ── MICRO ──
  candidates.push({
    archetype: "micro", score: 40, category: "technique",
    proof: { metric: "log_warmup_sets", value: 0, threshold: 1, citation: "Strong/Hevy norms" },
    proof_text: "Log warm-up sets — better PR projections + recovery estimates.",
    surprise_hook: "Most lifters skip warm-up logs.",
    target: { sets: 1 }, success_type: "log_session", when_to_do: "next_session", impact: 1,
  });

  candidates.sort((a,b) => b.score - a.score);
  return candidates;
}

const fitnessGraders = {
  train_muscle: async (deviceId, action, recentLogs) => {
    const m = action.success_criterion?.target?.muscle;
    const required = action.success_criterion?.target?.sets || 1;
    let total = 0;
    for (const w of recentLogs) {
      total += (w.exercises || [])
        .filter(e => e.muscle_group === m)
        .reduce((s, e) => s + (e.sets?.length || 0), 0);
    }
    return { met: total >= required, partial: total > 0, value: total };
  },
  hit_weight: async (deviceId, action, recentLogs) => {
    const ex = action.success_criterion?.target?.exercise;
    const target = action.success_criterion?.target?.weight_kg || 0;
    let max = 0;
    for (const w of recentLogs) {
      for (const e of w.exercises || []) {
        if ((e.name || "").toLowerCase() === (ex || "").toLowerCase()) {
          const w2 = Math.max(0, ...(e.sets || []).map(s => s.weight_kg || 0));
          if (w2 > max) max = w2;
        }
      }
    }
    return { met: max >= target, partial: max > 0, value: max };
  },
  add_sets: async (deviceId, action, recentLogs) => {
    const m = action.success_criterion?.target?.muscle;
    const required = action.success_criterion?.target?.sets || 1;
    let total = 0;
    for (const w of recentLogs) {
      total += (w.exercises || [])
        .filter(e => e.muscle_group === m)
        .reduce((s, e) => s + (e.sets?.length || 0), 0);
    }
    return { met: total >= required, partial: total > 0, value: total };
  },
  reduce_volume: async (deviceId, action, recentLogs) => {
    const m = action.success_criterion?.target?.muscle;
    const cap = action.success_criterion?.target?.sets || 999;
    let total = 0;
    for (const w of recentLogs) {
      total += (w.exercises || [])
        .filter(e => e.muscle_group === m)
        .reduce((s, e) => s + (e.sets?.length || 0), 0);
    }
    return { met: total <= cap, value: total };
  },
  log_session: async (deviceId, action, recentLogs) => ({ met: recentLogs.length >= 1, value: recentLogs.length }),
};

module.exports = { computeFitnessCandidates, fitnessGraders, VOLUME_LANDMARKS };
