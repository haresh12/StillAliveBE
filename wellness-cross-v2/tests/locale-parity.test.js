/**
 * locale-parity.test.js — fails if any FE locale diverges from en.json.
 *
 * Catches the most common i18n regression: someone adds a new key to en.json
 * but forgets to add it to de/es/fr/pt/ru. Without this test, that ships as
 * "looks fine in EN, German users see the literal key path."
 *
 * What it asserts:
 *   1. Every locale file parses as valid JSON
 *   2. Every key in en.json exists in every other locale
 *   3. Every {{var}} in an en value exists in the corresponding target value
 *   4. No drift: no extra keys in non-en files (catches accidental forks)
 *
 * Source of truth: /Users/.../StillAlive/src/locales/{en,de,es,fr,pt,ru}.json
 *
 * Failure here = locales out of sync. Run scripts/validate-locales.js for
 * detailed per-key output, then update the missing locale.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const LOCALES_DIR = path.resolve(
  __dirname,
  '..', '..', '..',           // → SAB/
  'StillAlive', 'src', 'locales',
);
const SUPPORTED = ['de', 'es', 'fr', 'pt', 'ru'];

let pass = 0, fail = 0;
function assert(label, cond) {
  if (cond) { console.log('  ✓ ' + label); pass++; }
  else      { console.log('  ✗ ' + label); fail++; }
}

function loadJson(name) {
  const p = path.join(LOCALES_DIR, `${name}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v, key));
    else if (typeof v === 'string') out[key] = v;
    else if (Array.isArray(v)) v.forEach((x, i) => { if (typeof x === 'string') out[`${key}[${i}]`] = x; });
  }
  return out;
}

function extractVars(s) {
  const m = s.match(/\{\{[^}]+\}\}/g);
  return m ? m.sort() : [];
}

console.log('locale parity (en → de/es/fr/pt/ru)');
let en;
try { en = flatten(loadJson('en')); assert('en.json parses', true); }
catch (e) { assert('en.json parses', false); console.error(' →', e.message); process.exit(1); }
const enKeys = Object.keys(en);
assert(`en.json has ${enKeys.length} string keys (sanity ≥ 1000)`, enKeys.length >= 1000);

for (const lang of SUPPORTED) {
  let target;
  try { target = flatten(loadJson(lang)); }
  catch (e) { assert(`${lang}.json parses`, false); console.error(' →', e.message); continue; }

  // 1. No missing keys
  const missing = enKeys.filter((k) => !(k in target));
  assert(`${lang}: 0 missing keys (${missing.length})`, missing.length === 0);
  if (missing.length > 0) console.log('   first 3:', missing.slice(0, 3).join(', '));

  // 2. No extra keys (catches accidental drift)
  const tgtKeys = Object.keys(target);
  const extra = tgtKeys.filter((k) => !(k in en));
  assert(`${lang}: 0 extra keys (${extra.length})`, extra.length === 0);
  if (extra.length > 0) console.log('   first 3:', extra.slice(0, 3).join(', '));

  // 3. {{var}} parity
  let varMismatches = 0;
  for (const k of enKeys) {
    if (!(k in target)) continue;
    const e = extractVars(en[k]);
    const t = extractVars(target[k]);
    if (e.length !== t.length || e.some((v, i) => v !== t[i])) varMismatches++;
  }
  assert(`${lang}: 0 {{var}} mismatches (${varMismatches})`, varMismatches === 0);
}

console.log(`\nresult: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
