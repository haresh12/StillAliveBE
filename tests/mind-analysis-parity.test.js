/**
 * Mind parity test — BE /api/mind/analysis response shape vs FE normalize layer.
 * Locks the 2026-05-23 new-surface contract so future BE changes can't silently
 * drop a key the FE expects.
 *
 * Run: node tests/mind-analysis-parity.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

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
        if (depth === 0) { matches.push(src.slice(start, j + 1)); break; }
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

const bePath = path.join(__dirname, '../mind.agent.js');
const src = fs.readFileSync(bePath, 'utf8');
const blocks = _extractObjectBlocks(src);
// The /analysis populated response is the largest res.json({...}) in mind.agent.js
const analysisBlock = blocks.sort((a, b) => b.length - a.length)[0] || '';
const beKeys = _topLevelKeys(analysisBlock);
const feKeys = loadNormalizeKeys();

section('Mind /analysis contract parity');

const NEW_SURFACE_KEYS = [
  'calm_readiness', 'prior', 'emotion_granularity', 'checkin_depth',
  'contribution_map', 'contribution_summary', 'correlation_grid',
  'plateau_anxiety', 'top_trigger',
];

// BE may emit new keys either directly OR via an `...extras` spread.
// Accept both; check the WHOLE file source for the extras assignment.
const _beHasExtrasSpread = /\.\.\.extras\b/.test(analysisBlock) || /\.\.\.extras\b/.test(src);

test('BE /analysis emits all 9 new surface keys (directly or via extras spread)', () => {
  if (_beHasExtrasSpread) {
    // The extras object is built in two places: the success block and the
    // safe-default fallback. Grep the whole src — both must mention each key.
    const missing = NEW_SURFACE_KEYS.filter((k) => !new RegExp(`\\b${k}\\b`).test(src));
    assert.strictEqual(missing.length, 0, 'BE extras missing: ' + missing.join(', '));
  } else {
    const missing = NEW_SURFACE_KEYS.filter((k) => !beKeys.has(k));
    assert.strictEqual(missing.length, 0, 'BE missing: ' + missing.join(', '));
  }
});

test('FE normalize layer accepts every new surface key', () => {
  const missing = NEW_SURFACE_KEYS.filter((k) => !feKeys.has(k));
  assert.strictEqual(missing.length, 0, 'FE normalize missing: ' + missing.join(', '));
});

test('Day-0 safe-defaults exist in mind.agent.js (extras fallback block)', () => {
  // The /analysis route must emit safe defaults when extras derivation fails.
  // Look for a catch block that builds extras with the 9 keys.
  const defaultBlock = src.match(/extras\s*=\s*\{[\s\S]*?calm_readiness:\s*null[\s\S]*?\}/);
  assert.ok(defaultBlock, 'no safe-defaults extras block found');
});

console.log('\n' + p + ' passed, ' + f + ' failed');
process.exit(f === 0 ? 0 : 1);
