#!/usr/bin/env node
'use strict';
// ═══════════════════════════════════════════════════════════════
// Personalize BE/FE Derive Parity Test
//
// Loads both the backend derive layer (lib/personalize-derive.js)
// and the frontend client-side mirror (../StillAlive/src/lib/personalize/
// localDerive.js), runs both against 5 representative payloads, and
// asserts byte-identical output.
//
// If this test breaks, the offline-fallback derive on the client will
// disagree with the server. That means the reveal screen would show
// different numbers depending on connectivity — the worst possible
// user-trust regression.
//
// Run: node scripts/test-personalize-parity.js
// ═══════════════════════════════════════════════════════════════

const path = require('path');
const fs = require('fs');

const be = require('../lib/personalize-derive');

// Read FE module as a string, transform `export const X` → `exports.X = X`,
// strip `export `, and eval. Lets us load the ES-module FE mirror in node.
function loadFeMirror() {
  const feFile = path.join(__dirname, '..', '..', 'StillAlive', 'src', 'lib', 'personalize', 'localDerive.js');
  let src = fs.readFileSync(feFile, 'utf8');
  // Strip `export ` from `export const X` / `export function X`
  src = src.replace(/export (const|function|let|var) /g, '$1 ');
  // Build a module-style closure that returns the named symbols
  const exports = {};
  const wrapper = new Function('exports', src + `
    exports.localDerive = localDerive;
    exports.localWellnessScore = localWellnessScore;
    exports.localInsights = localInsights;
    exports.minToHHMM = minToHHMM;
    exports.deriveChronotype = deriveChronotype;
    exports.deriveExperienceFromProtocol = deriveExperienceFromProtocol;
    exports.deriveSplitFromLevel = deriveSplitFromLevel;
    exports.deriveClimateFromLocale = deriveClimateFromLocale;
    exports.mapTriggerToChallenge = mapTriggerToChallenge;
    exports.BASELINE_BY_LEVEL = BASELINE_BY_LEVEL;
  `);
  wrapper(exports);
  return exports;
}

const fe = loadFeMirror();

// ─── Test fixtures ─────────────────────────────────────────────
const FIXTURES = [
  {
    name: 'All 6 coaches, male 30, US, moderate activity',
    payload: {
      active_coaches: ['sleep','mind','nutrition','fitness','water','fasting'],
      shared: { wake_time_min: 420, bed_time_min: 1380, weight_kg: 70, height_cm: 175, activity_level: 'moderate', pregnancy: false },
      sleep: { target_hours: 7.5, disruptors: ['stress','screens'] },
      mind: { triggers: ['work_deadlines','poor_sleep'] },
      nutrition: { goal: 'lose_weight', dietary_style: ['high_protein'], allergies: ['none'] },
      fitness: { training_level: 'intermediate', goal: 'hypertrophy', training_days: ['mon','wed','fri'], equipment: 'full_gym' },
      water: {},
      fasting: { protocol: '16_8' },
      profile: { gender: 'male', age: 30, name: 'Test' },
      locale: { country: 'us', language: 'en' },
    },
  },
  {
    name: 'Sleep + Mind only, female 28, Germany, early chronotype',
    payload: {
      active_coaches: ['sleep','mind'],
      shared: { wake_time_min: 360, bed_time_min: 1320, weight_kg: 60, height_cm: 165, activity_level: 'light', pregnancy: false },
      sleep: { target_hours: 8, disruptors: ['anxiety','noise'] },
      mind: { triggers: ['work_deadlines','social_media','overcommit'] },
      nutrition: {}, fitness: {}, water: {}, fasting: {},
      profile: { gender: 'female', age: 28 },
      locale: { country: 'de', language: 'de' },
    },
  },
  {
    name: 'Fasting only, male 45, UAE (hot climate), beginner',
    payload: {
      active_coaches: ['fasting','water'],
      shared: { wake_time_min: 480, bed_time_min: 1410, weight_kg: 85, height_cm: 180, activity_level: 'moderate', pregnancy: false },
      sleep: {}, mind: {}, nutrition: {}, fitness: {}, water: {},
      fasting: { protocol: '12_12' },
      profile: { gender: 'male', age: 45 },
      locale: { country: 'ae', language: 'en' },
    },
  },
  {
    name: 'Fitness + Nutrition advanced, male 22, sedentary baseline (edge)',
    payload: {
      active_coaches: ['fitness','nutrition'],
      shared: { wake_time_min: 540, bed_time_min: 60, weight_kg: 95, height_cm: 190, activity_level: 'very_active', pregnancy: false },
      sleep: {}, mind: {}, water: {}, fasting: {},
      nutrition: { goal: 'gain_muscle', dietary_style: ['high_protein'], allergies: ['nuts'] },
      fitness: { training_level: 'advanced', goal: 'strength', training_days: ['mon','tue','wed','thu','fri'], equipment: 'barbell' },
      profile: { gender: 'male', age: 22 },
      locale: { country: 'no', language: 'en' },
    },
  },
  {
    name: 'Pregnant user, water + nutrition, mild climate',
    payload: {
      active_coaches: ['water','nutrition'],
      shared: { wake_time_min: 450, bed_time_min: 1350, weight_kg: 68, height_cm: 168, activity_level: 'light', pregnancy: true },
      sleep: {}, mind: {}, fitness: {}, fasting: {},
      nutrition: { goal: 'maintain', dietary_style: ['vegetarian'], allergies: ['gluten'] },
      water: {},
      profile: { gender: 'female', age: 32 },
      locale: { country: 'fr', language: 'fr' },
    },
  },
];

// ─── Deep equality ──────────────────────────────────────────────
function deepEq(a, b, path = '') {
  if (a === b) return null;
  if (typeof a !== typeof b) return `${path}: type mismatch (${typeof a} vs ${typeof b})`;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: array length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const r = deepEq(a[i], b[i], `${path}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.join('|') !== kb.join('|')) {
      return `${path}: key mismatch — BE: [${ka.join(',')}] FE: [${kb.join(',')}]`;
    }
    for (const k of ka) {
      const r = deepEq(a[k], b[k], `${path}.${k}`);
      if (r) return r;
    }
    return null;
  }
  return `${path}: value mismatch (BE: ${JSON.stringify(a)} vs FE: ${JSON.stringify(b)})`;
}

// ─── Run ────────────────────────────────────────────────────────
let pass = 0, fail = 0;
for (const fx of FIXTURES) {
  const beOut = be.derive(fx.payload);
  const feOut = fe.localDerive(fx.payload);

  const beScore = be.computeWellnessScoreBaseline(fx.payload);
  const feScore = fe.localWellnessScore(fx.payload, feOut);

  const beIns = be.generateInsights(fx.payload, beOut);
  const feIns = fe.localInsights(fx.payload, feOut);

  const errDerive = deepEq(beOut, feOut, 'derive');
  const errScore  = beScore === feScore ? null : `wellness_score: BE ${beScore} vs FE ${feScore}`;
  const errIns    = deepEq(beIns, feIns, 'insights');

  if (errDerive || errScore || errIns) {
    fail++;
    console.error(`✗ ${fx.name}`);
    if (errDerive) console.error(`  ${errDerive}`);
    if (errScore)  console.error(`  ${errScore}`);
    if (errIns)    console.error(`  ${errIns}`);
  } else {
    pass++;
    console.log(`✓ ${fx.name}  (score ${beScore})`);
  }
}

console.log(`\nResult: ${pass}/${pass + fail} parity tests passed.`);
process.exit(fail > 0 ? 1 : 0);
