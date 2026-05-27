/**
 * Parity check — BE /api/water/analysis response shape vs FE normalize layer.
 * Locks the contract so future BE scoring changes can't silently drop a key
 * the FE depends on.
 *
 * Mirrors tests/fitness-analysis-parity.test.js (the canon). Differences:
 *   • Water has TWO res.json blocks:
 *       (1) populated path — emits all keys
 *       (2) early-return    — emits only `{ setup_completed: false }` when
 *                             user hasn't set up the agent yet
 *     The early-return is intentional (Day-0-before-setup), not "Day-0 emit
 *     parallel keys" — Water's "Day-0 with setup, no logs yet" path falls
 *     through the populated path and emits all keys with safe defaults.
 *
 *   • A score-parity assertion (Phase 2 enhancement spot) compares
 *     Path C (refreshWaterScore → current_score) vs Path E (water-analytics
 *     headline score) for the same logs. Today these can drift (see
 *     project_water_scoring_drift_bug.md memory); Phase 2 unifies them.
 *
 * Run: node tests/water-analysis-parity.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

function _extractObjectBlocks(src) {
  // Returns every `res.json({...})` block (balanced-brace match).
  const matches = [];
  const needle = 'res.json({';
  for (let i = 0; i < src.length; i++) {
    if (src.startsWith(needle, i)) {
      const start = i + needle.length - 1;  // points at the '{'
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

function loadBeAnalysisBlocks() {
  // Find /analysis route handler then extract every res.json block within it.
  const bePath = path.join(__dirname, '../water.agent.js');
  const src = fs.readFileSync(bePath, 'utf8');
  const startIdx = src.indexOf("router.get('/analysis'");
  assert.ok(startIdx >= 0, "could not find /analysis route in water.agent.js");
  // Crude end-of-handler detector: next router.<method>(' at top-of-line.
  const tail = src.slice(startIdx + 1);
  const endRelIdx = tail.search(/\nrouter\.(get|post|patch|delete|put)\(/);
  const handlerSrc = endRelIdx > 0 ? src.slice(startIdx, startIdx + 1 + endRelIdx) : src.slice(startIdx);
  return _extractObjectBlocks(handlerSrc).sort((a, b) => b.length - a.length);
}

function loadBePopulatedKeys() {
  const blocks = loadBeAnalysisBlocks();
  return _topLevelKeys(blocks[0] || '');
}

function loadBeEarlyReturnKeys() {
  const blocks = loadBeAnalysisBlocks();
  // The non-setup early return is the smallest block.
  return _topLevelKeys(blocks[blocks.length - 1] || '');
}

function loadNormalizeKeys() {
  const np = path.join(__dirname, '../../StillAlive/src/lib/normalize.js');
  const src = fs.readFileSync(np, 'utf8');
  const match = src.match(/normalizeAnalysisPack[\s\S]*?return\s*\{([\s\S]*?)^\s*\};/m);
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

let p = 0, f = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); p++; }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); f++; }
}
function section(s) { console.log('\n' + s); }

const beKeys      = loadBePopulatedKeys();
const beEarlyKeys = loadBeEarlyReturnKeys();
const feKeys      = loadNormalizeKeys();

section('Contract parity — BASELINE (Phase 1, 2026-05-24)');
console.log(`  BE /analysis populated path: ${beKeys.size} keys`);
console.log(`  BE /analysis early-return:    ${beEarlyKeys.size} keys`);
console.log(`  FE normalizeAnalysisPack:     ${feKeys.size} keys`);

// ─── Baseline contract (today's /analysis emit, line 2568-2609 of water.agent.js)
const baselineKeys = [
  'setup_completed',
  'range', 'effective_start_date', 'effective_days', 'days_since_anchor', 'anchor_date', 'is_clamped',
  'score_today', 'score_7d_smoothed', 'score_lifetime', 'missed_days',
  'score', 'score_grade', 'score_gates',
  'hydration_score',
  'signal_points', 'daily_curve', 'drink_breakdown', 'daily_logs',
  'circadian', 'best_day', 'worst_day',
  'ai_reads', 'aha_moments', 'observations',
  'personal_formula', 'day_one_insight',
  'streak', 'longest_streak', 'completion',
  'avg_ml', 'best_day_ml', 'total_ml', 'target_ml',
  // Phase 5-8 additions (2026-05-24)
  'prior', 'journey', 'balance', 'effort_mix', 'the_numbers',
];

test('every baseline key is emitted by BE /analysis (populated path)', () => {
  const missing = baselineKeys.filter((k) => !beKeys.has(k));
  assert.strictEqual(missing.length, 0, 'BE populated missing: ' + missing.join(', '));
});

test('early-return path emits setup_completed: false for not-yet-setup users', () => {
  // The early return is a one-liner `res.json({ setup_completed: false })`,
  // which `_topLevelKeys` (newline-anchored) doesn't pick up. Detect via
  // direct grep instead — confirm the literal exists inside /analysis.
  const bePath = path.join(__dirname, '../water.agent.js');
  const src = fs.readFileSync(bePath, 'utf8');
  const startIdx = src.indexOf("router.get('/analysis'");
  const tail = src.slice(startIdx);
  const endRelIdx = tail.search(/\nrouter\.(get|post|patch|delete|put)\(/);
  const handlerSrc = endRelIdx > 0 ? tail.slice(0, endRelIdx) : tail;
  assert.ok(
    /res\.json\(\{\s*setup_completed\s*:\s*false\s*\}\)/.test(handlerSrc),
    'early-return must emit `res.json({ setup_completed: false })` for not-yet-setup users'
  );
});

test('FE normalize layer covers every baseline key (no UI crash on undefined)', () => {
  // normalize.js handles shared + water-specific keys. Check water-specific
  // + key shared keys actually appear in normalizeAnalysisPack return.
  const waterSpecific = [
    'score_gates', 'hydration_score', 'target_ml',
    'drink_breakdown', 'circadian', 'personal_formula', 'day_one_insight',
  ];
  const sharedRequired = [
    'setup_completed', 'range', 'effective_start_date', 'effective_days',
    'days_since_anchor', 'anchor_date', 'is_clamped',
    'score_today', 'score_7d_smoothed', 'score_lifetime', 'missed_days',
    'score', 'score_grade',
    'signal_points', 'daily_logs', 'ai_reads', 'aha_moments', 'observations',
    'best_day', 'worst_day',
    'streak', 'longest_streak', 'completion',
  ];
  const checkAll = [...waterSpecific, ...sharedRequired];
  const missing = checkAll.filter((k) => !feKeys.has(k));
  assert.strictEqual(missing.length, 0, 'FE normalize missing: ' + missing.join(', '));
});

section('Score path detection — drift surface (see project_water_scoring_drift_bug)');

test('water.agent.js refreshWaterScore wires beverage_quality to a real value (NOT hardcoded 70)', () => {
  const bePath = path.join(__dirname, '../water.agent.js');
  const src = fs.readFileSync(bePath, 'utf8');
  const startIdx = src.indexOf('async function refreshWaterScore');
  assert.ok(startIdx >= 0, 'refreshWaterScore function not found');
  // Find the end of the function (next top-level `async function`, `function`,
  // or `router.` at column 0).
  const tail = src.slice(startIdx + 1);
  const endRelIdx = tail.search(/\n(async function|function |router\.(get|post|patch|delete|put))/);
  const body = endRelIdx > 0 ? src.slice(startIdx, startIdx + 1 + endRelIdx) : src.slice(startIdx);
  // FAIL = hardcoded `beverage_quality: 70` survives. PASS = the literal 70 is gone.
  const isHardcoded = /beverage_quality\s*:\s*70\s*,?\s*\/\//.test(body) || /beverage_quality\s*:\s*70\s*[,}\s]/.test(body);
  if (isHardcoded) {
    throw new Error('refreshWaterScore still hardcodes `beverage_quality: 70`. Phase 2 must route through lib/water-scoring.js with real-from-logs computation.');
  }
});

test('water.adapter.js scoreDailyLogs wires chronobiology + beverage_quality from real data', () => {
  const adPath = path.join(__dirname, '../wellness-cross-v2/adapters/water.adapter.js');
  const src = fs.readFileSync(adPath, 'utf8');
  const startIdx = src.indexOf('scoreDailyLogs(');
  assert.ok(startIdx >= 0, 'scoreDailyLogs function not found in water.adapter.js');
  const tail = src.slice(startIdx + 1);
  // Find end of function — bounded by next `,\n  componentsForToday(` or end-of-object.
  const endRelIdx = tail.search(/\n {2}componentsForToday\(/);
  const body = endRelIdx > 0 ? src.slice(startIdx, startIdx + 1 + endRelIdx) : src.slice(startIdx);
  const chronoHardcoded = /chronobiology\s*:\s*0\.5\s*[,}\s]/.test(body);
  const bevHardcoded    = /beverage_quality\s*:\s*0\.7\s*[,}\s]/.test(body);
  if (chronoHardcoded || bevHardcoded) {
    const what = [chronoHardcoded && 'chronobiology', bevHardcoded && 'beverage_quality'].filter(Boolean).join(' + ');
    throw new Error(
      `water.adapter.scoreDailyLogs still hardcodes ${what}. Phase 2 must route through lib/water-scoring.js with real-from-logs computation.`
    );
  }
});

section('Chat-state contract (Polish round 2 — coach data parity)');

function loadChatStateHandler() {
  const bePath = path.join(__dirname, '../water.agent.js');
  const src = fs.readFileSync(bePath, 'utf8');
  const startIdx = src.indexOf("router.get('/chat-state'");
  assert.ok(startIdx >= 0, '/chat-state route handler not found in water.agent.js');
  const tail = src.slice(startIdx + 1);
  const endRelIdx = tail.search(/\nrouter\.(get|post|patch|delete|put)\(/);
  return endRelIdx > 0 ? src.slice(startIdx, startIdx + 1 + endRelIdx) : src.slice(startIdx);
}

test('/chat-state handler exists in water.agent.js', () => {
  const h = loadChatStateHandler();
  assert.ok(h.length > 500, '/chat-state handler is suspiciously short');
});

test('/chat-state emits last_log + streak + prompt_signals (Fitness canon)', () => {
  const h = loadChatStateHandler();
  for (const key of ['last_log', 'streak', 'prompt_signals']) {
    assert.ok(h.includes(key), `/chat-state must emit \`${key}\``);
  }
});

test('/chat-state prompt_signals include the 7 keys the FE picker reads', () => {
  const h = loadChatStateHandler();
  const required = ['band', 'chronobiology_tier', 'weekend_gap_pct', 'evening_heavy', 'debt_ml', 'streak', 'streak_at_risk'];
  const missing = required.filter((k) => !h.includes(k));
  assert.strictEqual(missing.length, 0, '/chat-state prompt_signals missing: ' + missing.join(', '));
});

test('/chat-state uses lib/water-scoring (not duplicate inline math)', () => {
  const h = loadChatStateHandler();
  assert.ok(
    h.includes('_waterScoring.') || h.includes('waterScoring.'),
    '/chat-state must route through lib/water-scoring.js — no inline duplication of gate math'
  );
});

console.log('\n' + p + ' passed, ' + f + ' failed');
process.exit(f === 0 ? 0 : 1);
