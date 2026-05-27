/**
 * Parity check — BE /api/fasting/analysis response shape vs FE normalize layer.
 *
 * Mirrors tests/fitness-analysis-parity.test.js. Two phases:
 *
 *   PHASE A (always-on, P0 lock):
 *     Asserts every contract key in the current /analysis populated response.
 *     Catches accidental key removals during refactors.
 *
 *   PHASE B (env-gated, activates in P1):
 *     When FASTING_V4=1, also asserts:
 *       - Day-0 path emits parallel V4 keys (no FE crash on first-load).
 *       - FE normalizeFastingAnalysisPack accepts every V4 key.
 *     Pre-P1, FASTING_V4 stays unset; Phase B is skipped without noise.
 *
 * Run today: node tests/fasting-analysis-parity.test.js
 * Run after P1: FASTING_V4=1 node tests/fasting-analysis-parity.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const V4_LIVE = process.env.FASTING_V4 === '1';

// ════════════════════════════════════════════════════════════════
// CONTRACT KEYS — single source of truth, used by P1 /analysis route + FE normalize.
// Anything removed here = breaks the FE. Anything added = must also be wired in FE.
// ════════════════════════════════════════════════════════════════
const PRE_V4_KEYS = [
  'setup_completed', 'range', 'effective_start_date', 'effective_days',
  'days_since_anchor', 'anchor_date', 'is_clamped',
  'score_today', 'score_7d_smoothed', 'score_lifetime', 'missed_days',
  'fasting_score', 'score_grade', 'signal_points', 'daily_logs',
  'stage_breakdown', 'ai_reads', 'aha_moments', 'circadian',
  'best_day', 'worst_day', 'observations',
  'streak', 'longest_streak', 'completion', 'avg_hours',
  'best_fast', 'total_fast_hours', 'target_hours',
];

const V4_NEW_KEYS = [
  'form', 'prior', 'depth_mix', 'window_stability', 'protocol_variety',
  'start_hour_grid', 'contribution_map', 'contribution_summary',
  'habituation', 'cleanness',
];

// ════════════════════════════════════════════════════════════════
// Scanners (mirror fitness-analysis-parity.test.js)
// ════════════════════════════════════════════════════════════════

function _extractObjectBlocks(src) {
  const matches = [];
  const needle = 'res.json({';
  for (let i = 0; i < src.length; i++) {
    if (src.startsWith(needle, i)) {
      const start = i + needle.length - 1;
      let depth = 1;
      for (let j = i + needle.length; j < src.length && depth > 0; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
        if (depth === 0) {
          matches.push(src.slice(start, j + 1));
          break;
        }
      }
    }
  }
  return matches;
}

function _topLevelKeys(block) {
  const out = new Set();
  let d = 0;
  for (let i = 0; i < block.length; i++) {
    if (block[i] === '{') d++;
    else if (block[i] === '}') d--;
    else if (d === 1 && block[i] === '\n') {
      const m = block.slice(i).match(/^\n\s*\/\/[^\n]*|^\n\s*([a-z_][a-zA-Z0-9_]*)\s*[:,]/);
      if (m && m[1]) out.add(m[1]);
    }
  }
  return out;
}

function _extractObjectBlocksFromRoute(src, routeMarker) {
  // Find the route's source slice, then return all `res.json({...})` blocks
  // INSIDE that route only — sorted by length descending (populated first).
  const startIdx = src.indexOf(routeMarker);
  if (startIdx < 0) return [];
  // End of the route = next `router.<verb>(` registration OR end of file
  const restAfter = src.slice(startIdx + routeMarker.length);
  const nextRouteRel = restAfter.search(/\nrouter\.(get|post|put|patch|delete)\(/);
  const endIdx = nextRouteRel < 0 ? src.length : startIdx + routeMarker.length + nextRouteRel;
  const slice = src.slice(startIdx, endIdx);
  return _extractObjectBlocks(slice).sort((a, b) => b.length - a.length);
}

function loadAnalysisPopulatedKeys() {
  const bePath = path.join(__dirname, '../fasting.agent.js');
  const src = fs.readFileSync(bePath, 'utf8');
  const blocks = _extractObjectBlocksFromRoute(src, "router.get('/analysis'");
  return _topLevelKeys(blocks[0] || '');
}

function loadAnalysisDay0Keys() {
  const bePath = path.join(__dirname, '../fasting.agent.js');
  const src = fs.readFileSync(bePath, 'utf8');
  // P1: Day-0 path lives in _fastingDay0Pack() helper. Find the function
  // body and extract its return object's top-level keys.
  const m = src.match(/function _fastingDay0Pack\([^)]*\)\s*\{[\s\S]*?return\s*\{([\s\S]*?)^\s*\};/m);
  if (!m) {
    // Fallback: scan the /analysis route itself for any res.json blocks
    // (in case someone inlines Day-0 back into the route)
    const blocks = _extractObjectBlocksFromRoute(src, "router.get('/analysis'");
    return _topLevelKeys(blocks[1] || '');
  }
  // Build a fake { ... } block so we can re-use _topLevelKeys
  const synthetic = '{' + m[1] + '}';
  return _topLevelKeys(synthetic);
}

function loadFeNormalizeKeys() {
  // P1 ships normalizeFastingAnalysisPack. Today it doesn't exist → empty set.
  const np = path.join(__dirname, '../../StillAlive/src/lib/normalize.js');
  if (!fs.existsSync(np)) return new Set();
  const src = fs.readFileSync(np, 'utf8');
  const match = src.match(/normalizeFastingAnalysisPack[\s\S]*?return\s*\{([\s\S]*?)^\s*\};/m);
  const body = match ? match[1] : '';
  const out = new Set();
  let d = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') d++;
    else if (body[i] === '}') d--;
    else if (d === 0 && body[i] === '\n') {
      const m = body.slice(i).match(/^\n\s*([a-z_][a-zA-Z0-9_]*)\s*:/);
      if (m && m[1]) out.add(m[1]);
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
// Run
// ════════════════════════════════════════════════════════════════

let p = 0, f = 0, s = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); p++; }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); f++; }
}
function skip(name, why) { console.log('  − ' + name + ' (' + why + ')'); s++; }
function section(t) { console.log('\n' + t); }

const populatedKeys = loadAnalysisPopulatedKeys();

section('Phase A — existing contract (pre-V4 keys)');

test('every pre-V4 key is emitted by BE /analysis (populated path)', () => {
  const missing = PRE_V4_KEYS.filter((k) => !populatedKeys.has(k));
  assert.strictEqual(missing.length, 0, 'BE populated missing: ' + missing.join(', '));
});

test('sanity: lib/fasting-scoring.js exports the helpers /analysis will need (P1 readiness)', () => {
  const scoring = require('../lib/fasting-scoring');
  for (const name of [
    'metabolicStageAtHour', 'deriveFastQuality', 'maturityRamp',
    'dropFutureSessions', 'buildDayQualityByDate', 'computeFastingForm',
    'derivePriorPeriod', 'deriveDepthMix', 'deriveWindowStability',
    'deriveProtocolVariety', 'deriveStartHourGrid', 'deriveContributionMap',
    'deriveHabituation', 'deriveCleanness', 'deriveHungerWaveHour',
  ]) {
    assert.strictEqual(typeof scoring[name], 'function', 'missing export: ' + name);
  }
});

test('METABOLIC_STAGES is exported and frozen', () => {
  const { METABOLIC_STAGES } = require('../lib/fasting-scoring');
  assert.strictEqual(METABOLIC_STAGES.length, 6);
  assert.throws(() => { METABOLIC_STAGES.push({}); });
});

section('Phase B — V4 contract (env-gated, activates in P1)');

if (V4_LIVE) {
  const day0Keys = loadAnalysisDay0Keys();
  const feKeys   = loadFeNormalizeKeys();

  test('every V4 key is emitted by BE /analysis (populated path)', () => {
    const missing = V4_NEW_KEYS.filter((k) => !populatedKeys.has(k));
    assert.strictEqual(missing.length, 0, 'BE populated missing V4: ' + missing.join(', '));
  });

  test('every contract key is emitted by BE Day-0 path (parallel emit)', () => {
    const all = [...PRE_V4_KEYS, ...V4_NEW_KEYS];
    const missing = all.filter((k) => !day0Keys.has(k));
    assert.strictEqual(missing.length, 0, 'Day-0 missing: ' + missing.join(', '));
  });

  test('FE normalizeFastingAnalysisPack accepts every V4 key', () => {
    const missing = V4_NEW_KEYS.filter((k) => !feKeys.has(k));
    assert.strictEqual(missing.length, 0, 'FE normalize missing: ' + missing.join(', '));
  });
} else {
  skip('every V4 key is emitted by BE /analysis', 'P1 not yet shipped');
  skip('every contract key is emitted by BE Day-0 path', 'P1 not yet shipped');
  skip('FE normalizeFastingAnalysisPack accepts every V4 key', 'P1 not yet shipped');
}

console.log('\n' + p + ' passed, ' + f + ' failed, ' + s + ' skipped');
process.exit(f === 0 ? 0 : 1);
