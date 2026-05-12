/**
 * i18n-prompt.test.js — locks the language-injection contract.
 *
 * Covers:
 *   - resolveLanguage priority: body.language > X-User-Language > Accept-Language > 'en'
 *   - normalizeLanguage: case-insensitive, validates against supported set
 *   - appendLanguageInstruction: English no-op; non-en appends suffix; cache-friendly
 *   - Brand glossary preserved in every non-en directive (Pulse, Coach,
 *     Hydration Score, Wellness Score, Did You Know, Same Day Last Week)
 *   - Voice notes per language (du / tu / ты / tú / você)
 *   - resolveUserLanguage(db, deviceId): reads aliveChecks/{id}.profile.language,
 *     handles missing doc / invalid value / null db / null deviceId; 60s cache
 *
 * Failure here = chat / home / insights / notifs may regress to English
 * for a non-EN user. This is the canary; keep it green.
 */

'use strict';

const {
  SUPPORTED_LANGUAGES,
  FALLBACK_LANGUAGE,
  resolveLanguage,
  resolveUserLanguage,
  appendLanguageInstruction,
  buildLanguageDirective,
  languageName,
  normalizeLanguage,
} = require('../../lib/i18n-prompt');

let pass = 0, fail = 0;
function assert(label, cond) {
  if (cond) { console.log('  ✓ ' + label); pass++; }
  else      { console.log('  ✗ ' + label); fail++; }
}

// ── exports + constants ──────────────────────────────────────────────
console.log('exports + constants');
assert('SUPPORTED_LANGUAGES has 6 entries', SUPPORTED_LANGUAGES.length === 6);
assert('SUPPORTED_LANGUAGES contains en/de/es/fr/pt/ru',
  ['en','de','es','fr','pt','ru'].every(l => SUPPORTED_LANGUAGES.includes(l)));
assert('FALLBACK_LANGUAGE = en', FALLBACK_LANGUAGE === 'en');

// ── normalizeLanguage ────────────────────────────────────────────────
console.log('\nnormalizeLanguage');
assert('lowercases input',                normalizeLanguage('DE') === 'de');
assert('passes en through',               normalizeLanguage('en') === 'en');
assert('passes valid codes through',      normalizeLanguage('ru') === 'ru');
assert('null → en',                       normalizeLanguage(null) === 'en');
assert('undefined → en',                  normalizeLanguage(undefined) === 'en');
assert('empty string → en',               normalizeLanguage('') === 'en');
assert('invalid code → en',               normalizeLanguage('xx') === 'en');
assert('number → en (safe coerce)',       normalizeLanguage(123) === 'en');

// ── resolveLanguage priority chain ───────────────────────────────────
console.log('\nresolveLanguage priority chain');
assert('body.language wins',
  resolveLanguage({ body: { language: 'de' } }) === 'de');
assert('X-User-Language header wins when no body',
  resolveLanguage({ headers: { 'x-user-language': 'fr' } }) === 'fr');
assert('Accept-Language fallback parses base lang',
  resolveLanguage({ headers: { 'accept-language': 'de-DE,de;q=0.9,en;q=0.8' } }) === 'de');
assert('Accept-Language with unsupported first falls to supported',
  resolveLanguage({ headers: { 'accept-language': 'it-IT,it;q=0.9,fr;q=0.8' } }) === 'fr');
assert('Accept-Language all unsupported → en',
  resolveLanguage({ headers: { 'accept-language': 'it,ja,ko' } }) === 'en');
assert('Empty req → en',                  resolveLanguage({}) === 'en');
assert('null req → en',                   resolveLanguage(null) === 'en');
assert('Invalid body.language → falls through, lands en',
  resolveLanguage({ body: { language: 'XX' } }) === 'en');
assert('Invalid header value → falls through to next',
  resolveLanguage({ headers: { 'x-user-language': 'XX', 'accept-language': 'es-ES' } }) === 'es');
assert('Body > header (body trumps even if header valid)',
  resolveLanguage({ body: { language: 'ru' }, headers: { 'x-user-language': 'de' } }) === 'ru');
assert('Header > Accept-Language',
  resolveLanguage({ headers: { 'x-user-language': 'pt', 'accept-language': 'de-DE' } }) === 'pt');

// ── appendLanguageInstruction ────────────────────────────────────────
console.log('\nappendLanguageInstruction');
const base = 'You are the Nutrition Coach in Pulse.';
const enOut = appendLanguageInstruction(base, 'en');
assert('English = no-op (returns input unchanged)', enOut === base);
assert('null language = no-op', appendLanguageInstruction(base, null) === base);
assert('undefined language = no-op', appendLanguageInstruction(base, undefined) === base);
assert('invalid language = no-op', appendLanguageInstruction(base, 'xx') === base);

const deOut = appendLanguageInstruction(base, 'de');
assert('German: prefix unchanged (cache-friendly)', deOut.startsWith(base));
assert('German: appends LANGUAGE block',            deOut.includes('=== LANGUAGE ==='));
assert('German: names the language',                deOut.includes('German'));
assert('German: voice note enforces du',            deOut.includes('"du"') && deOut.includes('Never "Sie"'));

const ruOut = appendLanguageInstruction(base, 'ru');
assert('Russian: voice note enforces ты',           ruOut.includes('"ты"') && ruOut.includes('Never "Вы"'));

const frOut = appendLanguageInstruction(base, 'fr');
assert('French: voice note enforces tu',            frOut.includes('"tu"') && frOut.includes('Never "vous"'));

const esOut = appendLanguageInstruction(base, 'es');
assert('Spanish: neutral LatAm tone',               esOut.includes('Latin American') || esOut.includes('"tú"'));

const ptOut = appendLanguageInstruction(base, 'pt');
assert('Portuguese: Brazilian / você',              ptOut.includes('você') || ptOut.includes('Brazilian'));

// Brand glossary preserved in every non-en directive
const BRAND = ['Pulse','Coach','Hydration Score','Wellness Score','Did You Know','Same Day Last Week','Aha'];
for (const lang of ['de','es','fr','pt','ru']) {
  const dir = buildLanguageDirective(lang);
  let allPresent = true;
  for (const term of BRAND) if (!dir.includes(term)) allPresent = false;
  assert(`${lang}: brand glossary terms preserved in directive`, allPresent);
}

// JSON-key-stay-English clause (case-insensitive — directive uses KEYS)
assert('Directive mandates JSON keys stay English',
  /JSON/i.test(buildLanguageDirective('de')) && /keys/i.test(buildLanguageDirective('de')));

// Variable preservation clause
assert('Directive mandates {{var}} preservation',
  buildLanguageDirective('de').includes('{{'));

// ── languageName ─────────────────────────────────────────────────────
console.log('\nlanguageName');
assert('en → English',     languageName('en')  === 'English');
assert('de → German',      languageName('de')  === 'German');
assert('ru → Russian',     languageName('ru')  === 'Russian');
assert('invalid → English fallback', languageName('xx') === 'English');

// ── resolveUserLanguage (mocked Firestore) ───────────────────────────
console.log('\nresolveUserLanguage (cron helper)');
function mkDb(map) {
  return {
    collection: (name) => ({
      doc: (id) => ({
        get: async () => {
          if (!(id in map)) return { exists: false, data: () => null };
          return { exists: true, data: () => map[id] };
        },
      }),
    }),
  };
}

(async () => {
  const db = mkDb({
    'german-user':  { profile: { language: 'de' } },
    'invalid-user': { profile: { language: 'XX' } },
    'empty-user':   {},
    'null-prof':    { profile: null },
  });
  assert('reads German from profile',         (await resolveUserLanguage(db, 'german-user')) === 'de');
  assert('invalid lang → en',                 (await resolveUserLanguage(db, 'invalid-user')) === 'en');
  assert('missing profile → en',              (await resolveUserLanguage(db, 'empty-user')) === 'en');
  assert('null profile → en',                 (await resolveUserLanguage(db, 'null-prof')) === 'en');
  assert('missing doc → en',                  (await resolveUserLanguage(db, 'no-such-user')) === 'en');
  assert('null db → en',                      (await resolveUserLanguage(null, 'x')) === 'en');
  assert('null deviceId → en',                (await resolveUserLanguage(db, null)) === 'en');

  // Cache hit on repeat: 2nd call must not throw even if db is later broken
  await resolveUserLanguage(db, 'german-user');
  const brokenDb = { collection: () => { throw new Error('db down'); } };
  // Within 60s of the previous successful read, cached value should still come back
  assert('cache: still returns de after db breaks (within 60s TTL)',
    (await resolveUserLanguage(brokenDb, 'german-user')) === 'de');

  // ── Final tally ────────────────────────────────────────────────────
  console.log(`\nresult: ${pass}/${pass + fail} passed`);
  if (fail > 0) process.exit(1);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
