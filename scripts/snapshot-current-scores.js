#!/usr/bin/env node
'use strict';
// ════════════════════════════════════════════════════════════════════════════
// snapshot-current-scores.js — P0 baseline for Scoring V3 migration.
//
// Captures the CURRENT scoring output for a set of synthetic personas
// across all 6 agents + the Wellness Score, dumps to a timestamped JSON.
// This is the truth-set the parity harness in tests/agent-scores-parity.test.js
// uses to verify that V3 changes don't drift the score for HK-denied users.
//
// USAGE:
//   node scripts/snapshot-current-scores.js              # writes snapshot
//   node scripts/snapshot-current-scores.js --diff       # diff vs latest
//   node scripts/snapshot-current-scores.js --personas=N # custom persona count
//
// SAFETY: Pure compute. No Firestore reads. No network. Idempotent.
// Output: snapshots/scores-{ISO}.json — committed to repo for diffing.
// ════════════════════════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');

const {
  computeSleepScore,
  computeMindScore,
  computeFitnessScore,
  computeNutritionScore,
  computeWaterScore,
  computeFastingScore,
} = require('../lib/agent-scores');

const SNAP_DIR = path.join(__dirname, '..', 'snapshots');
if (!fs.existsSync(SNAP_DIR)) fs.mkdirSync(SNAP_DIR, { recursive: true });

// ─── Personas: spans the matrix of (days_since_anchor × log_quality) ────
// 5 personas × 7 day-marks = 35 score expectations per agent.
const PERSONAS = [
  { id: 'P1_day0_setup_no_logs',     days: 0,  quality: 'none' },
  { id: 'P2_day1_perfect_log',       days: 1,  quality: 'perfect' },
  { id: 'P3_day7_consistent',        days: 7,  quality: 'consistent' },
  { id: 'P4_day14_solid_habits',     days: 14, quality: 'solid' },
  { id: 'P5_day30_mature',           days: 30, quality: 'consistent' },
  { id: 'P6_day60_master',           days: 60, quality: 'consistent' },
  { id: 'P7_day14_inconsistent',     days: 14, quality: 'sparse' },
];

// ─── Fixture builders — same inputs each run, deterministic ─────────────

function buildSleepInputs(persona) {
  const base = { target_hours: 7.5, days_logged: persona.days };
  if (persona.quality === 'none')     return null;
  if (persona.quality === 'perfect')  return { ...base, avg_efficiency: 92, avg_duration: 8.0, avg_quality: 5, avg_energy: 5, avg_latency: 15, consistency_score: 90, sleep_debt: 0 };
  if (persona.quality === 'consistent') return { ...base, avg_efficiency: 88, avg_duration: 7.5, avg_quality: 4, avg_energy: 4, avg_latency: 18, consistency_score: 75, sleep_debt: 0.5 };
  if (persona.quality === 'solid')    return { ...base, avg_efficiency: 86, avg_duration: 7.2, avg_quality: 4, avg_energy: 4, avg_latency: 20, consistency_score: 70, sleep_debt: 1.0 };
  if (persona.quality === 'sparse')   return { ...base, avg_efficiency: 80, avg_duration: 6.8, avg_quality: 3, avg_energy: 3, avg_latency: 25, consistency_score: 40, sleep_debt: 2.5 };
  return null;
}

function buildMindInputs(persona) {
  if (persona.quality === 'none') return null;
  const n = Math.min(persona.days, 30);
  const make = (val, count) => Array(count).fill(val);
  const base = { checkin_dates: Array(n).fill('2026-05-01'), days_logged: persona.days, streak: persona.days, recent_sleep_hours: 7.5 };
  if (persona.quality === 'perfect')    return { ...base, mood_scores: make(4, n),  anxiety_scores: make(1, n) };
  if (persona.quality === 'consistent') return { ...base, mood_scores: make(3.5, n), anxiety_scores: make(2, n) };
  if (persona.quality === 'solid')      return { ...base, mood_scores: make(3, n),   anxiety_scores: make(2.5, n) };
  if (persona.quality === 'sparse')     return { ...base, mood_scores: make(2.5, Math.max(1, Math.floor(n/3))), anxiety_scores: make(3, Math.max(1, Math.floor(n/3))), checkin_dates: Array(Math.max(1, Math.floor(n/3))).fill('2026-05-01') };
  return null;
}

function buildFitnessInputs(persona) {
  if (persona.quality === 'none') return null;
  const base = { days_logged: persona.days };
  if (persona.quality === 'perfect')    return { ...base, consistency: 100, volume: 100, intensity: 95, progression: 90, recovery: 85 };
  if (persona.quality === 'consistent') return { ...base, consistency: 85,  volume: 85,  intensity: 80, progression: 75, recovery: 75 };
  if (persona.quality === 'solid')      return { ...base, consistency: 75,  volume: 80,  intensity: 75, progression: 70, recovery: 70 };
  if (persona.quality === 'sparse')     return { ...base, consistency: 35,  volume: 50,  intensity: 60, progression: 40, recovery: 55 };
  return null;
}

function buildNutritionInputs(persona) {
  if (persona.quality === 'none') return null;
  const base = { days_logged: persona.days, streak: persona.days };
  if (persona.quality === 'perfect')    return { ...base, calorie_adherence: 95, protein_adherence: 100, macro_balance: 85 };
  if (persona.quality === 'consistent') return { ...base, calorie_adherence: 85, protein_adherence: 88,  macro_balance: 75 };
  if (persona.quality === 'solid')      return { ...base, calorie_adherence: 78, protein_adherence: 80,  macro_balance: 70 };
  if (persona.quality === 'sparse')     return { ...base, calorie_adherence: 55, protein_adherence: 60,  macro_balance: 50, streak: 2 };
  return null;
}

function buildWaterInputs(persona) {
  if (persona.quality === 'none') return null;
  const base = { days_logged: Math.max(persona.days, 1) };
  if (persona.quality === 'perfect')    return { ...base, hydration_adequacy: 100, consistency: 100, chronobiology: 95, beverage_quality: 100, avg_7d_ml: 2500 };
  if (persona.quality === 'consistent') return { ...base, hydration_adequacy: 88,  consistency: 90,  chronobiology: 80, beverage_quality: 90,  avg_7d_ml: 2200 };
  if (persona.quality === 'solid')      return { ...base, hydration_adequacy: 80,  consistency: 80,  chronobiology: 70, beverage_quality: 85,  avg_7d_ml: 2000 };
  if (persona.quality === 'sparse')     return { ...base, hydration_adequacy: 55,  consistency: 40,  chronobiology: 50, beverage_quality: 70,  avg_7d_ml: 1300 };
  return null;
}

function buildFastingInputs(persona) {
  if (persona.quality === 'none') return null;
  const base = { days_logged: persona.days, target_hours: 16 };
  if (persona.quality === 'perfect')    return { ...base, completion_rate: 1.0,  completion_rate_7d: 1.0,  streak: persona.days, avg_hours: 17, avg_hours_7d: 17, pct_reaching_fat_burn: 1.0, pct_reaching_ketosis: 0.9 };
  if (persona.quality === 'consistent') return { ...base, completion_rate: 0.85, completion_rate_7d: 0.85, streak: persona.days, avg_hours: 16, avg_hours_7d: 16, pct_reaching_fat_burn: 0.9, pct_reaching_ketosis: 0.7 };
  if (persona.quality === 'solid')      return { ...base, completion_rate: 0.7,  completion_rate_7d: 0.7,  streak: Math.floor(persona.days/2), avg_hours: 15, avg_hours_7d: 15, pct_reaching_fat_burn: 0.7, pct_reaching_ketosis: 0.4 };
  if (persona.quality === 'sparse')     return { ...base, completion_rate: 0.3,  completion_rate_7d: 0.3,  streak: 1,                          avg_hours: 12, avg_hours_7d: 12, pct_reaching_fat_burn: 0.3, pct_reaching_ketosis: 0   };
  return null;
}

const SCORERS = {
  sleep:     { build: buildSleepInputs,     fn: computeSleepScore },
  mind:      { build: buildMindInputs,      fn: computeMindScore },
  fitness:   { build: buildFitnessInputs,   fn: computeFitnessScore },
  nutrition: { build: buildNutritionInputs, fn: computeNutritionScore },
  water:     { build: buildWaterInputs,     fn: computeWaterScore },
  fasting:   { build: buildFastingInputs,   fn: computeFastingScore },
};

// ─── Run ─────────────────────────────────────────────────────────────
function takeSnapshot() {
  const out = {
    captured_at: new Date().toISOString(),
    contract_version: 'V2-baseline',  // bumped to V3 once Phase 10 ships
    personas: {},
  };

  for (const persona of PERSONAS) {
    out.personas[persona.id] = {
      meta: persona,
      scores: {},
    };
    for (const [agent, { build, fn }] of Object.entries(SCORERS)) {
      const inputs = build(persona);
      if (!inputs) {
        out.personas[persona.id].scores[agent] = null;
        continue;
      }
      const r = fn(inputs);
      out.personas[persona.id].scores[agent] = r ? {
        score: r.score,
        label: r.label,
        components: r.components,
        days_logged: r.days_logged,
      } : null;
    }
  }
  return out;
}

function writeSnapshot(snap) {
  const stamp = snap.captured_at.replace(/[:.]/g, '-');
  const file  = path.join(SNAP_DIR, `scores-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(snap, null, 2));
  const latest = path.join(SNAP_DIR, 'scores-latest.json');
  fs.writeFileSync(latest, JSON.stringify(snap, null, 2));
  console.log(`✓ Wrote ${file}`);
  console.log(`✓ Updated ${latest}`);
}

function diffLatest(snap) {
  const latestPath = path.join(SNAP_DIR, 'scores-latest.json');
  if (!fs.existsSync(latestPath)) {
    console.log('(no prior snapshot to diff against — run without --diff first)');
    return;
  }
  const prior = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
  let drift = 0;
  for (const pid of Object.keys(snap.personas)) {
    for (const agent of Object.keys(snap.personas[pid].scores)) {
      const a = snap.personas[pid].scores[agent]?.score ?? null;
      const b = prior.personas[pid]?.scores?.[agent]?.score ?? null;
      if (a !== b) {
        console.log(`  ${pid}.${agent}: ${b ?? 'null'} → ${a ?? 'null'} (Δ ${(a ?? 0) - (b ?? 0)})`);
        drift++;
      }
    }
  }
  if (drift === 0) console.log('✓ No drift vs latest snapshot');
  else            console.log(`⚠ ${drift} score(s) drifted vs latest snapshot`);
}

function main() {
  const args = process.argv.slice(2);
  const snap = takeSnapshot();
  if (args.includes('--diff')) {
    diffLatest(snap);
  } else {
    writeSnapshot(snap);
    console.log(`\n${PERSONAS.length} personas × 6 agents = ${PERSONAS.length * 6} score points captured.`);
  }
}

main();
