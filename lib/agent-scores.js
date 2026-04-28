'use strict';
// ════════════════════════════════════════════════════════════════════
// lib/agent-scores.js — THE single source of truth for per-agent scores.
//
// Rules:
//   1. Every agent has one score (0–100), computed here.
//   2. Scores earn slowly: Day 1 perfect = ~25, Day 7 = ~55, Day 30 = ~90.
//      This makes progress feel real. Use maturityFactor() on every agent.
//   3. Same function is called at log time (cached) + at analysis time (shown).
//      Never two different calculations for the same agent.
//   4. Returned shape: { score, label, components: { ... }, days_logged }
//
// Usage:
//   const { computeAgentScore } = require('./lib/agent-scores');
//   const result = computeAgentScore('sleep', rawData);
//   // cache result.score on the agent doc, read it everywhere
// ════════════════════════════════════════════════════════════════════

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const round = (n, p = 0) => { const k = 10 ** p; return Math.round(n * k) / k; };
const avg   = (arr) => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;

// Scores grow slowly — you earn high numbers through sustained effort.
// Day 1–3   → max ~25   (baseline only)
// Day 4–6   → max ~45   (early signal)
// Day 7–13  → max ~65   (patterns forming)
// Day 14–29 → max ~82   (habits solidifying)
// Day 30–59 → max ~93   (confirmed lifestyle)
// Day 60+   → max 100   (established)
function maturityFactor(daysLogged) {
  if (!daysLogged || daysLogged < 1) return 0.22;
  if (daysLogged < 4)  return 0.25;
  if (daysLogged < 7)  return 0.45;
  if (daysLogged < 14) return 0.65;
  if (daysLogged < 30) return 0.82;
  if (daysLogged < 60) return 0.93;
  return 1.00;
}

function labelFor(score, tiers) {
  // tiers: [[threshold, label], ...] descending
  for (const [t, l] of tiers) {
    if (score >= t) return l;
  }
  return tiers[tiers.length - 1][1];
}

// ─── SLEEP ────────────────────────────────────────────────────────────────────
// World-class algorithm. Five independently-weighted gates.
//
// WEIGHT BASIS (peer-reviewed):
//   Duration  30% — Van Dongen 2003 (Sleep 26:2): 4h/night = 2-night total deprivation.
//                   NIH meta-analysis: <7h → 14% higher all-cause mortality (PMC2864873).
//   Efficiency 20% — CBT-I gold standard. Spielman 1987: 85% threshold is the clinical line.
//                    <65% = clinical insomnia concern (AASM).
//   Restoration 20% — PSQI Component 1 (subjective quality) + morning energy. Buysse 1989.
//   Continuity 15% — Latency + sleep debt. PSQI C2 + Borbely two-process model.
//   Consistency 15% — Bedtime variance. Apple Sleep Score model + circadian literature.
//
// HARD RULES:
//   avg_duration < 6h  → score CANNOT exceed 55 (Van Dongen catastrophic range)
//   avg_duration < 6.5h→ score CANNOT exceed 72
//   avg_efficiency <65%→ clinical_flag = true
//
// PREVIOUS BUG: efficiency weighted 35% with no duration floor.
//   Result: 4h/94% efficiency → score 73 ("Good"). Clinically incorrect.
//   Fix: duration gate now primary; hard caps enforce clinical reality.
//
// Data needed:
//   avg_efficiency, avg_duration, consistency_score, target_hours, sleep_debt, days_logged
//   avg_quality (1-5), avg_energy (1-5), avg_latency (minutes)  — all optional
function computeSleepScore({
  avg_efficiency,
  avg_duration,
  avg_quality,
  avg_energy,
  avg_latency,
  consistency_score,
  sleep_debt,
  target_hours,
  days_logged,
}) {
  if (!avg_efficiency && !avg_duration) return null;
  const d   = days_logged || 1;
  const tgt = Math.max(target_hours || 7.5, 7.0); // never let target drop below 7h (AASM min)

  // ── GATE 1: Duration (30 pts) ─────────────────────────────────
  // The most clinically important variable. Must be a primary gate.
  const dur = avg_duration || 0;
  let durScore;
  if (dur >= tgt)       { durScore = 30; }
  else if (dur >= 7.0)  { durScore = 22 + 8  * (dur - 7.0)  / (tgt - 7.0); }
  else if (dur >= 6.0)  { durScore = 8  + 14 * (dur - 6.0); }
  else if (dur >= 4.0)  { durScore = 2  + 6  * (dur - 4.0)  / 2; }
  else                  { durScore = Math.max(0, dur / 4 * 2); }
  durScore = clamp(durScore, 0, 30);

  // Hard score ceiling based on duration (clinical reality)
  const durationCap = dur < 4.0 ? 30 : dur < 6.0 ? 55 : dur < 6.5 ? 72 : 100;

  // ── GATE 2: Efficiency (20 pts) ───────────────────────────────
  // CBT-I threshold: 85% is the clinical line. Below 65% = clinical concern.
  const eff = avg_efficiency || 0;
  let effScore;
  if (eff >= 90)      { effScore = 20; }
  else if (eff >= 85) { effScore = 15 + 5  * (eff - 85) / 5; }
  else if (eff >= 75) { effScore = 8  + 7  * (eff - 75) / 10; }
  else if (eff >= 65) { effScore = 3  + 5  * (eff - 65) / 10; }
  else                { effScore = clamp(3 * eff / 65, 0, 3); }
  effScore = clamp(effScore, 0, 20);

  // ── GATE 3: Restoration Quality (20 pts) ─────────────────────
  // PSQI Component 1 (Buysse 1989): subjective quality is independently predictive.
  // Morning energy captures SWS-like physical restoration.
  const q = avg_quality  || 3; // 1-5 scale
  const e = avg_energy   || 3; // 1-5 scale
  const qualScore   = clamp((q - 1) / 4 * 10, 0, 10); // 1→0pts, 5→10pts
  const energyScore = clamp((e - 1) / 4 * 10, 0, 10);
  const restorationScore = qualScore + energyScore;

  // ── GATE 4: Continuity (15 pts) ───────────────────────────────
  // Sleep latency + rolling debt. PSQI C2 + Borbely sleep pressure model.
  const lat  = avg_latency != null ? avg_latency : 15; // default optimal
  let latScore;
  if (lat <= 5)       { latScore = 6; } // very fast = may signal sleep deprivation
  else if (lat <= 20) { latScore = 8; } // optimal: 10-20 min
  else if (lat <= 30) { latScore = 6; }
  else if (lat <= 45) { latScore = 4; }
  else                { latScore = clamp(8 - lat / 12, 0, 2); }

  const debt = Math.max(0, sleep_debt || 0);
  const debtScore = clamp(7 - debt * 1.75, 0, 7); // 0h=7pts, 2h=3.5pts, 4h+=0pts
  const continuityScore = latScore + debtScore;

  // ── GATE 5: Consistency (15 pts) ──────────────────────────────
  // Bedtime variance vs. 14-day rolling average. Apple Sleep Score model.
  const cons = consistency_score != null ? consistency_score : 50;
  const consistScore = clamp(cons * 0.15, 0, 15);

  // ── COMPOSITE ────────────────────────────────────────────────
  let rawScore = durScore + effScore + restorationScore + continuityScore + consistScore;

  // Apply clinical duration ceiling — cannot bypass with good efficiency
  rawScore = Math.min(rawScore, durationCap);

  const score        = clamp(round(rawScore * maturityFactor(d)), 0, 100);
  const clinicalFlag = dur < 6 || eff < 65;

  return {
    score,
    label: labelFor(score, [[85,'Excellent'],[70,'Good'],[50,'Fair'],[0,'Needs work']]),
    components: {
      duration:     round(durScore),
      efficiency:   round(effScore),
      restoration:  round(restorationScore),
      continuity:   round(continuityScore),
      consistency:  round(consistScore),
    },
    days_logged: d,
    clinical_flag: clinicalFlag,
    clinical_note: clinicalFlag
      ? (dur < 6 ? 'Duration below 6h — score capped regardless of efficiency' : 'Efficiency below 65% — CBT-I clinical concern')
      : null,
  };
}

// ─── MIND ─────────────────────────────────────────────────────────────────────
// World-class algorithm. Five independently-weighted components.
//
// WEIGHT BASIS (peer-reviewed):
//   Affect State   30% — EMA person-centered baseline (Shiffman 2008, PMC6230530).
//                         Compares against user's OWN 14-day rolling mean, not population norms.
//                         New users (<7 entries): absolute 1-5 scale. Experienced: person-centered.
//   Anxiety Mgmt   25% — GAD-7 aligned thresholds (Spitzer 2006, PMC4927366).
//                         anxAvg 1-1.5/5=minimal, 3/5=GAD-threshold, 4+/5=clinical concern.
//   Trajectory     15% — Week-over-week improvement (most apps miss this entirely).
//                         Rewards genuine progress, not just having a good baseline.
//   Consistency    20% — Check-in frequency + streak (Lally habit formation research).
//                         Logging IS the intervention; consistency predicts outcomes.
//   Sleep Impact   10% — Palmer 2023 meta-analysis (PubMed 38127505): sleep deprivation
//                         causes mood impairment SMD -0.85 (6h/night). Cross-agent signal.
//
// PREVIOUS BUGS:
//   1. Stability rewarded LOW mood std-dev — penalised healthy emotional range.
//   2. Frequency weighted 20% — over-rewarded logging over actual mental health.
//   3. No trajectory: improving from 2→4 mood scored same as stable at 4.
//   4. No cross-agent signal: sleep deprivation invisible to mind score.
//   5. Absolute scale only — user with chronic low mood always penalized vs. their own progress.
//
// Data needed:
//   mood_scores[] (most-recent-first, 1-5), anxiety_scores[] (most-recent-first, 1-5),
//   checkin_dates[], days_logged, streak
//   recent_sleep_hours (optional, float) — avg of last 3 nights from sleep agent
function computeMindScore({
  mood_scores    = [],
  anxiety_scores = [],
  checkin_dates  = [],
  days_logged,
  streak         = 0,
  recent_sleep_hours = null,  // cross-agent: avg last 3 nights (null = no data)
}) {
  const d = days_logged || checkin_dates.length || 1;
  const n = mood_scores.length;
  if (n === 0) return null;

  // ── COMPONENT 1: Affect State (30 pts) ────────────────────────
  // Person-centered EMA: compare against own baseline when ≥7 entries.
  // Source: Shiffman 2008 (PMC6230530) — person-mean centering eliminates
  // between-person variance and focuses on meaningful within-person change.
  const recentMoods = mood_scores.slice(0, Math.min(7, n));
  const moodAvg     = avg(recentMoods);

  let moodScore;
  if (n >= 7) {
    const olderMoods  = mood_scores.slice(7, Math.min(14, n));
    const baseline    = olderMoods.length >= 2 ? avg(olderMoods) : moodAvg;
    const deviation   = moodAvg - baseline; // positive = improving vs. own history
    const absBase     = (moodAvg / 5) * 24; // absolute component (0-24)
    const relBonus    = clamp(deviation * 4, -8, 6); // trajectory bonus (+6 max / -8 max)
    moodScore         = clamp(absBase + relBonus + 4, 0, 30); // +4 baseline floor
  } else {
    moodScore = clamp((moodAvg / 5) * 30, 0, 30);
  }

  // ── COMPONENT 2: Anxiety Management (25 pts) ─────────────────
  // GAD-7 aligned: 1/5 = minimal, 3/5 = clinical threshold, 4+/5 = severe.
  // Source: Spitzer 2006 (PMC4927366), sensitivity 89%/specificity 82% at GAD-7≥10.
  const recentAnx = anxiety_scores.slice(0, Math.min(7, n));
  const anxAvg    = recentAnx.length ? avg(recentAnx) : 2;

  let anxScore;
  if (anxAvg <= 1.5)      { anxScore = 25; } // minimal
  else if (anxAvg <= 2.0) { anxScore = 21; } // low
  else if (anxAvg <= 2.5) { anxScore = 17; } // below-average
  else if (anxAvg <= 3.0) { anxScore = 13; } // moderate (GAD threshold equivalent)
  else if (anxAvg <= 3.5) { anxScore = 8;  } // elevated — clinical attention recommended
  else if (anxAvg <= 4.0) { anxScore = 4;  } // high — clinical concern
  else                    { anxScore = 0;  } // severe (clinical_flag triggered)

  // ── COMPONENT 3: Trajectory / Trend (15 pts) ─────────────────
  // Week-over-week: recent half vs. older half of logs.
  // Rewards genuine improvement — the metric most apps completely ignore.
  let trajectoryScore = 8; // default: stable (no data to determine direction)
  if (n >= 6) {
    const half         = Math.floor(n / 2);
    const recentHalf   = mood_scores.slice(0, half);
    const olderHalf    = mood_scores.slice(half);
    const moodDelta    = avg(recentHalf) - avg(olderHalf);

    const recentAnxH   = anxiety_scores.slice(0, half);
    const olderAnxH    = anxiety_scores.slice(half);
    const anxDelta     = olderAnxH.length ? avg(olderAnxH) - avg(recentAnxH) : 0; // improving = anxiety dropping

    const netDelta = moodDelta * 0.6 + anxDelta * 0.4;

    if      (netDelta >= 0.5)  { trajectoryScore = 15; } // strong improvement
    else if (netDelta >= 0.2)  { trajectoryScore = 12; } // mild improvement
    else if (netDelta >= -0.2) { trajectoryScore = 8;  } // stable
    else if (netDelta >= -0.5) { trajectoryScore = 4;  } // declining
    else                       { trajectoryScore = 0;  } // significant decline
  }

  // ── COMPONENT 4: Behavioral Consistency (20 pts) ─────────────
  // Logging frequency + streak. Lally et al. (2010): habit loop requires
  // consistent cue-routine-reward cycling; missing days breaks neural patterns.
  const freqScore   = clamp((checkin_dates.length / 14) * 12, 0, 12);
  const streakScore = clamp((streak || 0) * 0.57, 0, 8); // streak 14 = 8pts
  const behaviorScore = freqScore + streakScore;

  // ── COMPONENT 5: Sleep Cross-Impact (10 pts) ──────────────────
  // Palmer 2023 meta-analysis (PubMed 38127505): sleep deprivation causes
  // mood impairment SMD -0.27 to -1.14. Van Dongen 2003: 6h/night = SMD -0.85.
  let sleepImpact;
  if (recent_sleep_hours == null) {
    sleepImpact = 8;  // no data: conservative neutral (don't penalize unknowns)
  } else if (recent_sleep_hours >= 7.0) {
    sleepImpact = 10;
  } else if (recent_sleep_hours >= 6.5) {
    sleepImpact = 8;
  } else if (recent_sleep_hours >= 6.0) {
    sleepImpact = 5;  // moderate sleep deprivation
  } else {
    sleepImpact = 2;  // severe (<6h) — Van Dongen range
  }

  // ── COMPOSITE ────────────────────────────────────────────────
  const raw   = clamp(moodScore + anxScore + trajectoryScore + behaviorScore + sleepImpact, 0, 100);
  const score = clamp(round(raw * maturityFactor(d)), 0, 100);

  const clinicalFlag = anxAvg > 4.0; // severe anxiety → show support resources

  return {
    score,
    label: labelFor(score, [[85,'Thriving'],[70,'Good'],[50,'Steady'],[0,'Building']]),
    components: {
      mood_state:   round(moodScore),
      anxiety_mgmt: round(anxScore),
      trajectory:   round(trajectoryScore),
      consistency:  round(behaviorScore),
      sleep_impact: round(sleepImpact),
    },
    days_logged: d,
    clinical_flag: clinicalFlag,
    clinical_note: clinicalFlag ? 'Anxiety consistently elevated — evidence-based support may help' : null,
  };
}

// ─── FITNESS ──────────────────────────────────────────────────────────────────
// Data needed:
//   consistency (0-100), volume (0-100), progression (0-100), intensity (0-100),
//   days_logged
function computeFitnessScore({ consistency, volume, progression, intensity, days_logged }) {
  const d = days_logged || 1;
  if (consistency == null && volume == null) return null;

  const raw = clamp(
    (consistency  || 0) * 0.35 +
    (volume       || 0) * 0.25 +
    (progression  || 0) * 0.25 +
    (intensity    || 0) * 0.15,
    0, 100
  );

  const score = clamp(round(raw * maturityFactor(d)), 0, 100);

  return {
    score,
    label: labelFor(score, [[85,'Elite'],[70,'Strong'],[50,'Building'],[25,'Starting'],[0,'Begin']]),
    components: {
      consistency:  round(consistency  || 0),
      volume:       round(volume       || 0),
      progression:  round(progression  || 0),
      intensity:    round(intensity    || 0),
    },
    days_logged: d,
  };
}

// ─── NUTRITION ────────────────────────────────────────────────────────────────
// Data needed:
//   calorie_adherence (0-100), protein_adherence (0-100), streak, macro_balance (0-100),
//   days_logged
function computeNutritionScore({ calorie_adherence, protein_adherence, streak, macro_balance, days_logged }) {
  const d = days_logged || 1;
  if (calorie_adherence == null && protein_adherence == null) return null;

  const streakScore = clamp(((streak || 0) / 14) * 100, 0, 100);

  const raw = clamp(
    (calorie_adherence || 0) * 0.35 +
    (protein_adherence || 0) * 0.35 +
    streakScore              * 0.20 +
    (macro_balance     || 0) * 0.10,
    0, 100
  );

  const score = clamp(round(raw * maturityFactor(d)), 0, 100);

  return {
    score,
    label: labelFor(score, [[85,'Excellent'],[70,'Strong'],[55,'Good'],[35,'Building'],[0,'Starting']]),
    components: {
      calorie_adherence: round(calorie_adherence || 0),
      protein_adherence: round(protein_adherence || 0),
      consistency:       clamp(round(((streak || 0) / 14) * 100), 0, 100),
      macro_balance:     round(macro_balance || 0),
    },
    days_logged: d,
  };
}

// ─── WATER ────────────────────────────────────────────────────────────────────
// World-class 4-gate algorithm with clinical flags and peer-reviewed weights.
//
// WEIGHT BASIS (peer-reviewed):
//   Hydration Adequacy 35% — EFSA 2010 (EFSA J 8:1459): Women 2.0L/day, Men 2.5L/day AI.
//                              Gandy 2015 (Nutr Rev 73:97-109): goal-relative hydration is
//                              the primary predictor of cognitive performance outcomes.
//   Consistency        25% — Lally 2010 (Eur J Soc Psychol 40:998-1009): habit formation
//                              requires ~66 days of daily repetition.
//                              Popkin 2010 (Nutr Rev 68:439-458): irregular hydration causes
//                              greater impairment than sustained mild dehydration.
//   Chronobiology      25% — Sawka 2007 ACSM (Med Sci Sports 39:377-390): morning front-loading
//                              (first 4h after wake) is the highest-leverage window.
//                              Shirreffs 2000 (Eur J Appl Physiol 83:411-417): late excess disrupts
//                              ADH rhythm, worsening next-day hydration status.
//   Beverage Quality   15% — Maughan 2016 (Am J Clin Nutr 103:717-723): Beverage Hydration Index.
//                              Water/herbal 1.0×, milk 0.9×, juice 0.85×, coffee/tea 0.8×,
//                              soda 0.7×, alcohol 0.4×.
//
// CLINICAL FLAGS:
//   avg_7d_ml < 500    → dehydration_risk (WHO 2011 minimum safe intake threshold)
//   avg_7d_ml > 5000   → overhydration_risk (Rosner 2005 exercise-induced hyponatremia)
//   days_logged < 3    → score CANNOT exceed 28 (insufficient baseline)
//
// Data needed:
//   hydration_adequacy (0-100), consistency (0-100), chronobiology (0-100),
//   beverage_quality (0-100), avg_7d_ml, days_logged
function computeWaterScore({ hydration_adequacy, consistency, chronobiology, beverage_quality, avg_7d_ml, days_logged }) {
  const d = days_logged || 1;
  if (hydration_adequacy == null) return null;

  const raw = clamp(
    (hydration_adequacy || 0) * 0.35 +
    (consistency        || 0) * 0.25 +
    (chronobiology      || 0) * 0.25 +
    (beverage_quality   || 0) * 0.15,
    0, 100
  );

  // days_logged < 3 cap (insufficient baseline for reliable patterns)
  const maturity = d < 3 ? 0.28 : maturityFactor(d);
  const score = clamp(round(raw * maturity), 0, 100);

  const avg7d = avg_7d_ml || 0;
  const clinical_flag =
    avg7d > 0 && avg7d < 500  ? 'dehydration_risk' :
    avg7d > 5000               ? 'overhydration_risk' : null;

  return {
    score,
    label: labelFor(score, [[85,'Excellent'],[70,'Strong'],[55,'Good'],[35,'Building'],[0,'Starting']]),
    components: {
      hydration_adequacy: round(hydration_adequacy || 0),
      consistency:        round(consistency        || 0),
      chronobiology:      round(chronobiology      || 0),
      beverage_quality:   round(beverage_quality   || 0),
    },
    clinical_flag,
    days_logged: d,
    citations: {
      hydration_adequacy: 'EFSA 2010, Gandy 2015',
      consistency:        'Lally 2010, Popkin 2010',
      chronobiology:      'Sawka 2007 ACSM, Shirreffs 2000',
      beverage_quality:   'Maughan 2016 BHI',
    },
  };
}

// ─── FASTING ──────────────────────────────────────────────────────────────────
// World-class algorithm. Four independently-weighted gates.
//
// WEIGHT BASIS (peer-reviewed):
//   Adherence    35% — Patterson 2015 (J Acad Nutr Diet 115:1203): compliance to eating
//                       window is the #1 predictor of TRE outcomes. Protocol factor rewards
//                       ambitious protocols (16:8 scores higher than 12:12 for same adherence rate).
//   Depth        25% — Mattson 2019 (NEJM 381:2541-2551): "Metabolic switching" requires 12-14h
//                       for glycogen depletion. Ketosis threshold (0.5mM) at 16-18h.
//                       Ohsumi 2016 Nobel: autophagy upregulates at 18h+. Non-linear reward.
//   Metabolic    20% — Penetration quality: consistency of reaching fat-burning (12h) and
//                       ketosis (16h) across sessions. Not just average depth — reliability counts.
//                       Reward patterned depth, not lucky one-off extended fasts.
//   Consistency  20% — Lally 2010 (Eur J Soc Psychol 40:998-1009): habit loop requires
//                       ~66 days of consistent repetition. Streak + frequency both count.
//
// NOTE: Cross-agent signals (sleep→fasting) are DISPLAY ONLY in analysis/home tabs.
//       Individual agent scores are self-contained. No other agent's data enters this function.
//
// HARD RULES:
//   days_logged < 3        → score CANNOT exceed 28 (insufficient baseline)
//   target_hours >= 24     → clinical_flag = true (requires medical supervision)
//   completion_rate < 0.20 → score CANNOT exceed 35 (behavioral floor)
//
// PREVIOUS BUGS FIXED:
//   1. stage_pct = avgHours/20 — crude linear proxy, not clinically grounded.
//   2. streak weighted 20% — rewarded streak over depth, creating perverse incentive
//      (streak 14 at 12h scored same as streak 7 at 18h).
//   3. No protocol weighting — 12:12 completion scored same as 16:8 completion.
//   4. No clinical flag for extended fasting (24h+).
//
// Data needed:
//   completion_rate (0-1), completion_rate_7d (0-1), streak, avg_hours, avg_hours_7d,
//   target_hours, pct_reaching_fat_burn (0-1), pct_reaching_ketosis (0-1),
//   days_logged
function computeFastingScore({
  completion_rate,
  completion_rate_7d,
  streak         = 0,
  avg_hours      = 0,
  avg_hours_7d,
  target_hours   = 16,
  pct_reaching_fat_burn,
  pct_reaching_ketosis,
  days_logged,
}) {
  const d   = days_logged || 1;
  if (completion_rate == null) return null;

  const tgt = Math.max(target_hours || 16, 12); // floor at 12h — shorter not tracked
  const avgH   = avg_hours   || 0;
  const avgH7  = avg_hours_7d != null ? avg_hours_7d : avgH;
  const rate7  = clamp(completion_rate_7d != null ? completion_rate_7d : completion_rate, 0, 1);

  // ── GATE 1: Protocol-Weighted Adherence (35 pts) ─────────────
  // Primary behavioral metric — did you complete your protocol?
  // Protocol factor: harder protocols earn more per completion point.
  // Source: Patterson 2015, Sutton 2018 (Cell Metabolism 27:1212).
  const protocolFactor = tgt >= 20 ? 1.15 : tgt >= 18 ? 1.08 : tgt >= 16 ? 1.00 : tgt >= 14 ? 0.82 : 0.68;
  const durationRatio7 = clamp(avgH7 / tgt, 0, 1);
  const adherenceRaw   = (rate7 * 0.70 + durationRatio7 * 0.30) * 100;
  const adherenceScore = clamp(adherenceRaw * protocolFactor * 0.35, 0, 35);

  // ── GATE 2: Biochemical Depth (25 pts) ────────────────────────
  // Maps average fasting hours to metabolic milestone points.
  // Non-linear because crossing each threshold is a hard biochemical event.
  // Source: Mattson 2019 NEJM (metabolic switch), Ohsumi 2016 Nobel (autophagy).
  let depthScore;
  if (avgH >= 18)      { depthScore = 25; } // autophagy active (Nobel threshold)
  else if (avgH >= 16) { depthScore = 20; } // ketosis entry 0.5mM ketones
  else if (avgH >= 14) { depthScore = 14; } // ketosis approach, GH rising
  else if (avgH >= 12) { depthScore = 8;  } // metabolic switch — fat burning dominant
  else if (avgH >= 8)  { depthScore = 4;  } // glycogen depletion beginning
  else if (avgH >= 4)  { depthScore = 1;  } // post-absorptive
  else                 { depthScore = 0;  } // fed state

  // ── GATE 3: Stage Penetration Quality (20 pts) ────────────────
  // Reliability of reaching metabolic depth across sessions.
  // Even a deep average can mask inconsistency (3h + 21h avg = 12h).
  // Source: adherence consistency → metabolic adaptation (Anton 2018, Obesity 26:254).
  const fatBurnRate = clamp(pct_reaching_fat_burn != null ? pct_reaching_fat_burn : (avgH >= 12 ? rate7 : 0), 0, 1);
  const ketosisRate = clamp(pct_reaching_ketosis  != null ? pct_reaching_ketosis  : (avgH >= 16 ? rate7 * 0.8 : 0), 0, 1);
  const metabolicScore = clamp(fatBurnRate * 13 + ketosisRate * 7, 0, 20);

  // ── GATE 4: Behavioral Consistency (20 pts) ───────────────────
  // Habit formation requires repeated, consistent practice.
  // Source: Lally 2010 (Eur J Soc Psychol 40:998-1009): ~66 days for automaticity.
  // Equal weighting of streak (cue-reward loop) and frequency (baseline exposure).
  const streakScore = clamp(streak * 10 / 7, 0, 10); // 7-day streak = full 10pts
  const freqScore   = clamp((d / 14) * 10, 0, 10);   // 14 days logged = full 10pts
  const consistencyScore = streakScore + freqScore;   // 0-20

  // ── COMPOSITE + HARD CAPS ────────────────────────────────────
  // Gates: Adherence(35) + Depth(25) + Metabolic(20) + Consistency(20) = 100
  let raw = clamp(adherenceScore + depthScore + metabolicScore + consistencyScore, 0, 100);

  // Hard floor cap: too few sessions or very low completion = unreliable baseline
  if (d < 3)        raw = Math.min(raw, 28);
  if (rate7 < 0.20) raw = Math.min(raw, 35);

  const score        = clamp(round(raw * maturityFactor(d)), 0, 100);
  const clinicalFlag = tgt >= 24;

  return {
    score,
    label: labelFor(score, [[85,'Metabolic Master'],[70,'Deep Faster'],[50,'Building'],[25,'Early Stage'],[0,'Begin']]),
    components: {
      adherence:   round(adherenceScore),
      depth:       round(depthScore),
      metabolic:   round(metabolicScore),
      consistency: round(consistencyScore),
    },
    days_logged: d,
    clinical_flag: clinicalFlag,
    clinical_note: clinicalFlag
      ? 'Extended fasting (24h+) — medical supervision recommended'
      : null,
  };
}

// ─── DISPATCHER ──────────────────────────────────────────────────────────────
function computeAgentScore(agent, data) {
  switch (agent) {
    case 'sleep':     return computeSleepScore(data);
    case 'mind':      return computeMindScore(data);
    case 'fitness':   return computeFitnessScore(data);
    case 'nutrition': return computeNutritionScore(data);
    case 'water':     return computeWaterScore(data);
    case 'fasting':   return computeFastingScore(data);
    default:          return null;
  }
}

module.exports = {
  computeAgentScore,
  computeSleepScore,
  computeMindScore,
  computeFitnessScore,
  computeNutritionScore,
  computeWaterScore,
  computeFastingScore,
  maturityFactor,
};
