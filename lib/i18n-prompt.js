'use strict';
// ════════════════════════════════════════════════════════════════
// i18n-prompt.js — single source of truth for LLM language steering.
//
// Used by every agent (nutrition/fitness/mind/sleep/water/fasting),
// the cross-agent engine, and the chat-stream module.
//
// Two helpers:
//   resolveLanguage(req)              → 'en' | 'de' | 'es' | 'fr' | 'pt' | 'ru'
//   appendLanguageInstruction(s, lng) → s + trailing language directive
//
// Cache strategy: instruction is APPENDED, not prepended. The shared
// English prefix stays bytewise identical across users so OpenAI's
// prompt-cache hits remain >70% (per Home 100h plan budget).
//
// Glossary policy: brand terms (Pulse, Coach, Wellness Score, Hydration
// Score, Did You Know, Same Day Last Week) MUST stay English regardless
// of user language. The directive enforces this.
// ════════════════════════════════════════════════════════════════

const SUPPORTED = new Set(['en', 'de', 'es', 'fr', 'pt', 'ru']);
const FALLBACK = 'en';

const LANG_NAMES = {
  en: 'English',
  de: 'German',
  es: 'Spanish (neutral Latin American)',
  fr: 'French (France)',
  pt: 'Brazilian Portuguese',
  ru: 'Russian',
};

const VOICE_NOTES = {
  en: '',
  de: 'Use informal "du" form. Never "Sie".',
  fr: 'Use informal "tu" form. Never "vous".',
  ru: 'Use informal "ты" form. Never "Вы".',
  es: 'Neutral Latin American Spanish. Use "tú", never "vos" or "usted".',
  pt: 'Brazilian Portuguese. Use "você".',
};

const BRAND_GLOSSARY = [
  'Pulse', 'Coach', 'Tracker', 'Insights', 'Actions',
  'Wellness Score', 'Hydration Score', 'Hydration Curve',
  'Fasting Score', 'Did You Know', 'Same Day Last Week',
  'Aha', 'Track Record',
];

// ─── parse Accept-Language header to one of our supported codes ─────
function parseAcceptLanguage(headerValue) {
  if (!headerValue || typeof headerValue !== 'string') return null;
  // e.g. "de-DE,de;q=0.9,en;q=0.8"
  const langs = headerValue.split(',').map(s => s.trim().split(';')[0].toLowerCase());
  for (const tag of langs) {
    const base = tag.split('-')[0];
    if (SUPPORTED.has(base)) return base;
  }
  return null;
}

// ─── resolve language with priority chain ───────────────────────────
//   1. req.body.language       (explicit, set by FE apiClient)
//   2. X-User-Language header  (custom, set by FE apiClient)
//   3. Accept-Language header  (browser default)
//   4. (caller may chain user.profile.language from Firestore)
//   5. 'en'
function resolveLanguage(req) {
  if (!req) return FALLBACK;
  const fromBody = req.body?.language;
  if (typeof fromBody === 'string' && SUPPORTED.has(fromBody.toLowerCase())) {
    return fromBody.toLowerCase();
  }
  const fromHeaderCustom = req.headers?.['x-user-language'];
  if (typeof fromHeaderCustom === 'string' && SUPPORTED.has(fromHeaderCustom.toLowerCase())) {
    return fromHeaderCustom.toLowerCase();
  }
  const fromAccept = parseAcceptLanguage(req.headers?.['accept-language']);
  if (fromAccept) return fromAccept;
  return FALLBACK;
}

// ─── core directive builder ─────────────────────────────────────────
function buildLanguageDirective(lang) {
  if (lang === 'en' || !SUPPORTED.has(lang)) return '';
  const langName = LANG_NAMES[lang];
  const voice = VOICE_NOTES[lang] || '';
  return [
    '',
    '=== LANGUAGE ===',
    `Respond ONLY in ${langName}. Every sentence the user reads MUST be in ${langName}.`,
    voice,
    `These brand/UI terms STAY ENGLISH (do not translate, do not transliterate): ${BRAND_GLOSSARY.join(', ')}.`,
    `JSON object KEYS stay English. JSON string VALUES are in ${langName}.`,
    `Variable values inside {{...}} braces stay as given.`,
    `Numbers, units (kcal, g, ml, kg, hr, min), and emojis are unchanged.`,
    `If the user types in English, you still answer in ${langName}.`,
    '=== END LANGUAGE ===',
  ].filter(Boolean).join('\n');
}

// ─── public: append directive to an existing system prompt ──────────
// Null-safe: if systemPrompt is null/undefined, coerces to empty string so
// the LLM call doesn't blow up with a non-string content. Bad lang → no-op.
function appendLanguageInstruction(systemPrompt, lang) {
  const safePrompt = (systemPrompt == null) ? '' : String(systemPrompt);
  const code = String(lang || FALLBACK).toLowerCase();
  if (code === 'en' || !SUPPORTED.has(code)) return safePrompt;
  return `${safePrompt}${buildLanguageDirective(code)}`;
}

// ─── public: language code → readable name (for logging) ────────────
function languageName(lang) {
  return LANG_NAMES[lang] || LANG_NAMES[FALLBACK];
}

// ─── public: validate + normalize ───────────────────────────────────
function normalizeLanguage(lang) {
  const code = String(lang || FALLBACK).toLowerCase();
  return SUPPORTED.has(code) ? code : FALLBACK;
}

// ─── public: resolve language from Firestore for cron / background work ─────
//
// Use case: proactive nudge crons don't have a `req` object, so they can't
// use resolveLanguage(req). They DO have a deviceId. This helper reads the
// stored language from the user's aliveChecks profile (FE writes it via
// SettingsScreen → POST /api/alive-check/profile).
//
// Cached for 60s in-memory to avoid hammering Firestore from cron loops.
//
// @param {object} db   - admin.firestore() instance (caller-injected — keeps
//                        this module side-effect-free + testable)
// @param {string} deviceId
// @returns {Promise<string>} 'en' | 'de' | 'es' | 'fr' | 'pt' | 'ru'
const _langCache = new Map();
const _LANG_TTL_MS = 60_000;
async function resolveUserLanguage(db, deviceId) {
  // Defense-in-depth: every layer can fail (db null, db.collection throws
  // synchronously on bad input, Firestore unavailable, malformed profile).
  // ANY failure → return FALLBACK. This is called from cron loops where
  // a throw would kill the whole batch.
  try {
    if (!db || !deviceId) return FALLBACK;
    const now = Date.now();
    const cached = _langCache.get(deviceId);
    if (cached && now - cached.t < _LANG_TTL_MS) return cached.lang;
    const snap = await db.collection('aliveChecks').doc(deviceId).get();
    const lang = normalizeLanguage(snap && snap.exists && snap.data && snap.data()?.profile?.language);
    _langCache.set(deviceId, { lang, t: now });
    return lang;
  } catch {
    return FALLBACK;
  }
}

module.exports = {
  SUPPORTED_LANGUAGES: Array.from(SUPPORTED),
  FALLBACK_LANGUAGE: FALLBACK,
  resolveLanguage,
  resolveUserLanguage,
  appendLanguageInstruction,
  buildLanguageDirective,
  languageName,
  normalizeLanguage,
};
