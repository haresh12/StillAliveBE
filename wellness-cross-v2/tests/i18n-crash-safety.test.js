/**
 * i18n-crash-safety.test.js — asserts the i18n layer NEVER throws.
 *
 * Worst-case scenarios this locks down:
 *   - appendLanguageInstruction called with null/undefined/non-string prompt
 *   - appendLanguageInstruction called with garbage language values
 *   - resolveLanguage called with undefined req, null req, mangled headers
 *   - resolveUserLanguage called with broken db, sync-throwing collection,
 *     missing aliveChecks doc, null profile, nested-property crash bait
 *   - normalizeLanguage called with arrays, objects, numbers, NaN
 *
 * Failure here = a cron loop, an HTTP handler, or an LLM call could throw
 * up the stack on a non-EN user. That's a production crash. Keep green.
 */

'use strict';

const {
  resolveLanguage,
  resolveUserLanguage,
  appendLanguageInstruction,
  normalizeLanguage,
  buildLanguageDirective,
} = require('../../lib/i18n-prompt');

let pass = 0, fail = 0;
function assert(label, cond) {
  if (cond) { console.log('  ✓ ' + label); pass++; }
  else      { console.log('  ✗ ' + label); fail++; }
}
function neverThrows(label, fn) {
  try { const v = fn(); assert(label, typeof v !== 'undefined' || true); }
  catch (e) { assert(label + ' (threw: ' + e.message + ')', false); }
}
async function neverThrowsAsync(label, fn) {
  try { await fn(); assert(label, true); }
  catch (e) { assert(label + ' (threw: ' + e.message + ')', false); }
}

console.log('appendLanguageInstruction crash-safety');
neverThrows('null prompt + de',         () => appendLanguageInstruction(null, 'de'));
neverThrows('undefined prompt + de',    () => appendLanguageInstruction(undefined, 'de'));
neverThrows('number prompt',            () => appendLanguageInstruction(42, 'de'));
neverThrows('object prompt (toString)', () => appendLanguageInstruction({a:1}, 'de'));
neverThrows('null lang',                () => appendLanguageInstruction('hi', null));
neverThrows('undefined lang',           () => appendLanguageInstruction('hi', undefined));
neverThrows('invalid lang xx',          () => appendLanguageInstruction('hi', 'xx'));
neverThrows('lang as number',           () => appendLanguageInstruction('hi', 5));
neverThrows('lang as object',           () => appendLanguageInstruction('hi', {de:true}));
neverThrows('both null',                () => appendLanguageInstruction(null, null));
assert('null prompt + de returns directive without crash',
  typeof appendLanguageInstruction(null, 'de') === 'string');
assert('null prompt + en returns empty string',
  appendLanguageInstruction(null, 'en') === '');

console.log('\nresolveLanguage crash-safety');
neverThrows('undefined req',          () => resolveLanguage(undefined));
neverThrows('null req',               () => resolveLanguage(null));
neverThrows('numeric req',            () => resolveLanguage(42));
neverThrows('string req',             () => resolveLanguage('garbage'));
neverThrows('req with null body',     () => resolveLanguage({ body: null }));
neverThrows('req with null headers',  () => resolveLanguage({ headers: null }));
neverThrows('req with body.language = number', () => resolveLanguage({ body: { language: 5 } }));
neverThrows('req with body.language = array',  () => resolveLanguage({ body: { language: ['de'] } }));
neverThrows('header value = null',    () => resolveLanguage({ headers: { 'x-user-language': null } }));
neverThrows('header value = array',   () => resolveLanguage({ headers: { 'x-user-language': ['de'] } }));
neverThrows('mangled accept-language',() => resolveLanguage({ headers: { 'accept-language': ';;;;;' } }));
assert('all-bad inputs → en', resolveLanguage(null) === 'en');

console.log('\nnormalizeLanguage crash-safety');
neverThrows('null',     () => normalizeLanguage(null));
neverThrows('array',    () => normalizeLanguage(['de']));
neverThrows('object',   () => normalizeLanguage({ de: true }));
neverThrows('NaN',      () => normalizeLanguage(NaN));
neverThrows('Infinity', () => normalizeLanguage(Infinity));
neverThrows('symbol',   () => normalizeLanguage(Symbol('x')));
assert('all garbage → en',
  ['en','en','en','en','en','en'].every((expected, i) =>
    [normalizeLanguage(null), normalizeLanguage([]), normalizeLanguage({}),
     normalizeLanguage(NaN), normalizeLanguage(undefined), normalizeLanguage('')][i] === expected));

console.log('\nbuildLanguageDirective crash-safety');
neverThrows('en',   () => buildLanguageDirective('en'));
neverThrows('null', () => buildLanguageDirective(null));
neverThrows('xx',   () => buildLanguageDirective('xx'));
neverThrows('5',    () => buildLanguageDirective(5));

(async () => {
  console.log('\nresolveUserLanguage crash-safety');
  await neverThrowsAsync('null db',         () => resolveUserLanguage(null, 'x'));
  await neverThrowsAsync('null deviceId',   () => resolveUserLanguage({ collection: () => ({}) }, null));
  await neverThrowsAsync('db.collection throws sync', () => resolveUserLanguage({
    collection: () => { throw new Error('boom'); },
  }, 'user'));
  await neverThrowsAsync('db.collection().doc throws sync', () => resolveUserLanguage({
    collection: () => ({ doc: () => { throw new Error('boom'); } }),
  }, 'user'));
  await neverThrowsAsync('get() rejects', () => resolveUserLanguage({
    collection: () => ({ doc: () => ({ get: () => Promise.reject(new Error('boom')) }) }),
  }, 'user'));
  await neverThrowsAsync('snap.exists missing', () => resolveUserLanguage({
    collection: () => ({ doc: () => ({ get: async () => ({}) }) }),
  }, 'user'));
  await neverThrowsAsync('snap.data throws', () => resolveUserLanguage({
    collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => { throw new Error('boom'); } }) }) }),
  }, 'user'));
  await neverThrowsAsync('profile is null', () => resolveUserLanguage({
    collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ profile: null }) }) }) }),
  }, 'user'));
  await neverThrowsAsync('language is Symbol', () => resolveUserLanguage({
    collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ profile: { language: Symbol('x') } }) }) }) }),
  }, 'user'));
  await neverThrowsAsync('language is array', () => resolveUserLanguage({
    collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ profile: { language: ['de'] } }) }) }) }),
  }, 'user'));

  // All of the above should return 'en' (FALLBACK), not throw
  const r1 = await resolveUserLanguage(null, 'x');
  assert('null db → en', r1 === 'en');
  const r2 = await resolveUserLanguage({
    collection: () => { throw new Error('boom'); },
  }, 'user');
  assert('throwing db → en', r2 === 'en');

  console.log(`\nresult: ${pass}/${pass + fail} passed`);
  if (fail > 0) process.exit(1);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
