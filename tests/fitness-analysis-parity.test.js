/**
 * Parity check — BE /api/fitness/analysis response shape vs FE normalize layer.
 * Locks the contract so future BE scoring changes can't silently drop a key
 * the FE depends on (and the Day-0 path matches the populated path).
 *
 * We can't boot the full Express route inside a unit test, so we cross-check
 * the static set of keys by reading the route file and extracting both
 * res.json blocks' top-level keys.
 *
 * Run: node tests/fitness-analysis-parity.test.js
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
function loadBeKeys() {
  const bePath = path.join(__dirname, '../fitness.agent.js');
  const src = fs.readFileSync(bePath, 'utf8');
  const blocks = _extractObjectBlocks(src).sort((a, b) => b.length - a.length);
  return _topLevelKeys(blocks[0] || '');
}
function loadBeDayZeroKeys() {
  const bePath = path.join(__dirname, '../fitness.agent.js');
  const src = fs.readFileSync(bePath, 'utf8');
  const blocks = _extractObjectBlocks(src).sort((a, b) => b.length - a.length);
  return _topLevelKeys(blocks[1] || '');
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

const beKeys     = loadBeKeys();
const beDay0Keys = loadBeDayZeroKeys();
const feKeys     = loadNormalizeKeys();

section('Contract parity');

const expectKeys = [
  'setup_completed','range','effective_start_date','effective_days','days_since_anchor','anchor_date','is_clamped',
  'score_today','score_7d_smoothed','score_lifetime','missed_days',
  'fitness_score','score_grade','signal_points','daily_logs',
  'top_exercises','bottom_exercises','muscle_volume','skip_pattern','prs_period','strength_trend',
  'peak_hour','peak_hour_session_count','evening_session_pct','streak','volatility_pct','best_day','worst_day',
  'ai_reads','aha_moments','hero_insight','stats','vol_target','sets_target',
  // 2026-05-23 surfaces
  'form','prior','effort_mix','push_pull_legs','muscle_frequency','exercise_variety','hour_grid',
  'contribution_map','contribution_summary',
];

test('every contract key is emitted by BE /analysis (populated path)', () => {
  const missing = expectKeys.filter((k) => !beKeys.has(k));
  assert.strictEqual(missing.length, 0, 'BE populated missing: ' + missing.join(', '));
});

test('BE Day-0 response emits parallel keys (no FE crash on first-load)', () => {
  const missing = expectKeys.filter((k) => !beDay0Keys.has(k));
  assert.strictEqual(missing.length, 0, 'Day-0 missing: ' + missing.join(', '));
});

test('FE normalize layer accepts every 2026-05-23 new key', () => {
  const NEW = ['form','prior','effort_mix','push_pull_legs','muscle_frequency','exercise_variety','hour_grid','contribution_map','contribution_summary'];
  const missing = NEW.filter((k) => !feKeys.has(k));
  assert.strictEqual(missing.length, 0, 'FE normalize missing: ' + missing.join(', '));
});

console.log('\n' + p + ' passed, ' + f + ' failed');
process.exit(f === 0 ? 0 : 1);
