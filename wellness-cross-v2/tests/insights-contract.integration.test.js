/**
 * insights-contract.integration.test.js
 *
 * Locks the buildInsightsResponse contract against the FE-expected schema
 * for 5 user lifecycle states: day 1, 7, 14, 30, 90.
 *
 * Pure-function integration test — exercises the builder directly with
 * synthetic snapshots/pack so it can run without Firestore.
 *
 * Asserts every field is present + correctly shaped at every lifecycle stage,
 * ensuring the FE never sees an undefined branch.
 */

'use strict';

const { buildInsightsResponse } = require('../orchestrator/workflow');

let pass = 0, fail = 0;
function assert(label, cond) {
  if (cond) { console.log('  ✓ ' + label); pass++; }
  else { console.log('  ✗ ' + label); fail++; }
}

// ── Synthetic data builder ──
function buildLifecycleFixture(daysSinceSignup, opts = {}) {
  const today = '2026-05-09';
  const AGENTS = ['sleep', 'mind', 'nutrition', 'fitness', 'water', 'fasting'];

  const snapshots = {};
  const baselines = {};
  for (const a of AGENTS) {
    const last90 = [];
    const log_counts_by_date = {};
    for (let i = 89; i >= 0; i--) {
      const d = new Date(today + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - i);
      const date = d.toISOString().slice(0, 10);
      const logged = i < daysSinceSignup;
      const score = logged ? 50 + 15 * Math.sin(i / 4) + (a === 'sleep' ? 10 : 0) : null;
      last90.push({ date, score: logged ? Math.round(score) : null, has_log: logged });
      log_counts_by_date[date] = logged ? (a === 'water' ? 4 : 1) : 0;
    }
    snapshots[a] = {
      agent: a,
      setup: { is_complete: true },
      today: { date: today, has_log: false, score: null, components: {} },
      last_14d: last90.slice(-14),
      last_30d: last90.slice(-30),
      last_90d: last90,
      log_counts_by_date,
      aggregates_90d: {},
      aha_moments: [], signal_points: [], score_components: {}, score_label: 'ok',
      meta: { adapter_version: '2.3.0', fetched_at: new Date().toISOString(), read_only_verified: true },
    };
    if (a === 'sleep') {
      // recent_bedtimes for chronotype detection
      snapshots[a].recent_bedtimes = Array.from({ length: Math.min(daysSinceSignup, 30) }, (_, i) => ({
        date: `2026-04-${String(20 + (i % 10)).padStart(2, '0')}`,
        bedtime: '22:15',
      }));
    }
    baselines[a] = { mean: 60, std: 10 };
  }

  const pack = {
    pack_version: '2.3.0',
    computed_at: today,
    profile: {
      device_id: 'dev_test_' + daysSinceSignup,
      name: 'Test',
      days_active: daysSinceSignup,
      setup_count: 6,
      setup_state: { sleep: true, mind: true, nutrition: true, fitness: true, water: true, fasting: true },
      cohort_age_band: '25-34',
    },
    baselines,
    summary: { tier: 'habit', total_days_logged: Math.min(daysSinceSignup, 90) },
    today: { date: today },
  };

  const top_correlations = daysSinceSignup >= 14 ? [
    { id: 'sleep×mind:14:0', agents: ['sleep', 'mind'], pair: 'sleep×mind',
      r: 0.71, n: Math.min(daysSinceSignup, 14), lag: 0,
      plain_english: 'Better sleep → sharper mood' },
  ] : [];

  return {
    pack,
    snapshots,
    wellness: { score: 70, why_line: 'test' },
    anomalies: [],
    top_correlations,
    allCorrelations: top_correlations,
    exec: null,
    chronotype: null,        // let builder compute from snapshots.sleep.recent_bedtimes
    aha_feed: [],
    week_pattern_precomputed: null,
  };
}

// ── REQUIRED FE pack contract ──
const REQUIRED_KEYS = [
  'schema_version',
  'meta',
  'log_counts',
  'z_series',
  'edges',
  'week_pattern',
  'top_links',
  'capacity_strain_form',
  'chronotype',
  'recent_aha',
  'aha_feed',
  'best_worst_week',
  'quarterly_story',
  'did_you_know',
  'day_one_kit',  // Day-1 LAW: guaranteed substantive content
];

const REQUIRED_META = [
  'device_id',
  'calibration_days_done',
  'days_since_signup',
  'setup_count',
  'cohort_age_band',
  'range',
  'computed_at',
  'pack_version',
  'confidence_per_field',
];

function checkContract(label, pack) {
  console.log(label);
  for (const k of REQUIRED_KEYS) {
    assert(`pack.${k} present`, pack && k in pack);
  }
  for (const k of REQUIRED_META) {
    assert(`pack.meta.${k} present`, pack && pack.meta && k in pack.meta);
  }
  assert("schema_version === '2.3.0'", pack.schema_version === '2.3.0');
  assert('log_counts has 6 agents', pack.log_counts &&
    ['sleep','mind','nutrition','fitness','water','fasting'].every((a) => Number.isFinite(pack.log_counts[a])));
  assert('z_series is array', Array.isArray(pack.z_series));
  assert('edges is array', Array.isArray(pack.edges));
  assert('top_links is array', Array.isArray(pack.top_links));
  assert('aha_feed is array', Array.isArray(pack.aha_feed));
  assert('quarterly_story has unlocked + items', pack.quarterly_story &&
    typeof pack.quarterly_story.unlocked === 'boolean' &&
    Array.isArray(pack.quarterly_story.items));
  assert('confidence_per_field has 10 keys', pack.meta.confidence_per_field &&
    Object.keys(pack.meta.confidence_per_field).length === 10);
}

// ── Lifecycle fixtures ──
const stages = [
  { day: 1, range: 7 },
  { day: 7, range: 7 },
  { day: 14, range: 30 },
  { day: 30, range: 30 },
  { day: 90, range: 90 },
  { day: 90, range: 365 },
];

for (const { day, range } of stages) {
  const fix = buildLifecycleFixture(day);
  const pack = buildInsightsResponse({ ...fix, range });
  checkContract(`Day ${day}, range=${range}`, pack);
  // additional lifecycle-specific assertions
  if (day === 1) {
    assert('day 1 → log_counts.water == 4 (one log day)', pack.log_counts.water === 4);
    assert('day 1 → no edges (early)', pack.edges.length === 0);
    assert('day 1 → confidence early for edges',
      pack.meta.confidence_per_field.edges === 'early');
  }
  if (day >= 14) {
    assert(`day ${day} → at least one edge (sleep×mind)`, pack.edges.length >= 1);
    assert(`day ${day} → top_links non-empty`, pack.top_links.length >= 1);
    assert(`day ${day} → top_links[0].sparkline_a length 14`,
      Array.isArray(pack.top_links[0].sparkline_a) && pack.top_links[0].sparkline_a.length === 14);
  }
  if (day === 90) {
    assert('day 90 → quarterly unlocked', pack.quarterly_story.unlocked === true);
  }
}

// ── Day-1 hardening: every field non-null OR documented null fallback ──
console.log('\nday-1 hardening (cold start)');
const cold = buildInsightsResponse({ ...buildLifecycleFixture(0), range: 7 });
assert('cold start returns object (no throw)', cold && typeof cold === 'object');
assert('cold start did_you_know is non-null (fallback rotation)',
  cold.did_you_know && typeof cold.did_you_know.headline === 'string');
assert('cold start chronotype is null (graceful)', cold.chronotype === null || (cold.chronotype && cold.chronotype.label));
assert('cold start capacity_strain_form is null (graceful)',
  cold.capacity_strain_form === null || (cold.capacity_strain_form && Number.isFinite(cold.capacity_strain_form.capacity)));

// ── Day-1 LAW: substantive content guaranteed ──
console.log('\nday-1 LAW (substantive content guarantee)');
assert('day_one_kit.shown=true at day 0', cold.day_one_kit.shown === true);
assert('day_one_kit.welcome.headline non-empty', cold.day_one_kit.welcome && cold.day_one_kit.welcome.headline.length > 0);
assert('day_one_kit.roadmap has 7 stages', Array.isArray(cold.day_one_kit.roadmap) && cold.day_one_kit.roadmap.length === 7);
assert('day_one_kit.goals_preview non-empty (6 agents setup)', cold.day_one_kit.goals_preview.length === 6);
assert('day_one_kit.educational_correlations non-empty (cross-agent previews)', cold.day_one_kit.educational_correlations.length >= 1);

const day14Pack = buildInsightsResponse({ ...buildLifecycleFixture(14), range: 30 });
assert('day_one_kit.shown=false at day 14 (kit hides)', day14Pack.day_one_kit.shown === false);

// ── Range correctness ──
console.log('\nrange correctness');
const day90 = buildLifecycleFixture(90);
const w7 = buildInsightsResponse({ ...day90, range: 7 });
const w90 = buildInsightsResponse({ ...day90, range: 90 });
assert('range=7 → z_series length 7', w7.z_series.length === 7);
assert('range=90 → z_series length 90', w90.z_series.length === 90);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
