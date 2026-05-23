'use strict';
// ════════════════════════════════════════════════════════════════
// cron-user-context.js — single source of truth for per-user gates
// that every proactive cron MUST honour before sending a message.
//
// Three things every proactive cron needs but historically skipped:
//   1. User's actual local time         (utc_offset_minutes from profile)
//   2. User's language for proactive copy (de/es/fr/pt/ru/en)
//   3. User's notif + DND preferences   (notif_enabled, quiet_hours)
//
// Returning a single resolved context object lets callers do:
//
//   const ctx = await getUserNotifContext(db, deviceId);
//   if (!ctx.allowsProactive) continue;
//   const hour = ctx.localHour;
//   const msg = LOCALIZED_COPY[ctx.language].morning_prompt;
//
// One Firestore read per user (per cron tick) — cached for 60s.
//
// Profile fields read (all optional, all fall back safely):
//   aliveChecks/{deviceId}.profile.language       → 'en'..'ru'
//   aliveChecks/{deviceId}.profile.utc_offset_minutes  → -720..840
//   aliveChecks/{deviceId}.profile.notif_enabled  → bool, default true
//   aliveChecks/{deviceId}.profile.dnd_start      → 'HH:MM', default '22:00'
//   aliveChecks/{deviceId}.profile.dnd_end        → 'HH:MM', default '07:00'
//   aliveChecks/{deviceId}.profile.do_not_disturb → bool, hard-off when true
// ════════════════════════════════════════════════════════════════

const { normalizeLanguage, FALLBACK_LANGUAGE } = require('./i18n-prompt');

// Local-TZ date key helper — never _localDateStr(use) which
// returns UTC and silently maps near-midnight logs to the wrong day in
// negative-UTC offsets (Americas). See feedback_chart_tz_clamp law.
function _localDateStr(d) {
  const dt = d instanceof Date ? d : (d ? new Date(d) : new Date());
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

const CACHE_TTL_MS = 60_000;
const _ctxCache = new Map();

// ─── small helpers ─────────────────────────────────────────────
function parseHHMM(s, fallback) {
  if (typeof s !== 'string') return fallback;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return fallback;
  if (h < 0 || h > 23 || min < 0 || min > 59) return fallback;
  return { hour: h, minute: min, totalMin: h * 60 + min };
}

function getUserLocalDate(utcOffsetMinutes) {
  const serverNow = new Date();
  if (typeof utcOffsetMinutes !== 'number' || !Number.isFinite(utcOffsetMinutes)) {
    return serverNow;
  }
  // Clamp to plausible offsets (Tonga = +13h, Samoa = -11h, with a small buffer).
  const clamped = Math.max(-14 * 60, Math.min(14 * 60, utcOffsetMinutes));
  return new Date(serverNow.getTime() + clamped * 60 * 1000);
}

function getUserLocalDateStr(localDate) {
  const y = localDate.getUTCFullYear();
  const m = String(localDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(localDate.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ─── DND check ─────────────────────────────────────────────────
// quiet window may wrap midnight (e.g. 22:00→07:00).
function isInDND(localTotalMin, dndStart, dndEnd) {
  if (!dndStart || !dndEnd) return false;
  const a = dndStart.totalMin;
  const b = dndEnd.totalMin;
  if (a === b) return false;            // disabled (start == end)
  if (a < b) return localTotalMin >= a && localTotalMin < b;
  // Wrap-around (22:00..07:00): in DND if >= a OR < b
  return localTotalMin >= a || localTotalMin < b;
}

// ─── main resolver ─────────────────────────────────────────────
async function getUserNotifContext(db, deviceId) {
  if (!db || !deviceId) {
    return _fallbackContext();
  }
  try {
    const now = Date.now();
    const cached = _ctxCache.get(deviceId);
    if (cached && now - cached.t < CACHE_TTL_MS) return cached.ctx;

    const snap = await db.collection('aliveChecks').doc(deviceId).get();
    const profile = (snap && snap.exists && snap.data()?.profile) || {};

    const language = normalizeLanguage(profile.language);
    const utcOffsetMinutes = Number.isFinite(profile.utc_offset_minutes)
      ? profile.utc_offset_minutes
      : null;

    // Notif enabled default: true (opt-out, not opt-in — matches FE policy default)
    const notifEnabled = profile.notif_enabled !== false;
    const hardDND = profile.do_not_disturb === true;

    const dndStart = parseHHMM(profile.dnd_start, parseHHMM('22:00'));
    const dndEnd   = parseHHMM(profile.dnd_end,   parseHHMM('07:00'));

    const localNow = getUserLocalDate(utcOffsetMinutes);
    const localHour = localNow.getUTCHours();
    const localMinute = localNow.getUTCMinutes();
    const localTotalMin = localHour * 60 + localMinute;
    const localDateStr = getUserLocalDateStr(localNow);
    const inDND = hardDND || isInDND(localTotalMin, dndStart, dndEnd);

    const ctx = {
      deviceId,
      language,
      utcOffsetMinutes,
      hasUserTimezone: utcOffsetMinutes !== null,
      localNow,
      localHour,
      localMinute,
      localTotalMin,
      localDateStr,
      notifEnabled,
      hardDND,
      inDND,
      // Convenience: most crons just want one boolean.
      allowsProactive: notifEnabled && !inDND,
    };
    _ctxCache.set(deviceId, { ctx, t: now });
    return ctx;
  } catch (e) {
    // Never throw from a cron loop — return a permissive fallback so existing
    // behaviour (UTC-based) keeps working if Firestore hiccups.
    return _fallbackContext(deviceId);
  }
}

function _fallbackContext(deviceId = null) {
  const serverNow = new Date();
  const localHour = serverNow.getUTCHours();
  const localMinute = serverNow.getUTCMinutes();
  return {
    deviceId,
    language: FALLBACK_LANGUAGE,
    utcOffsetMinutes: null,
    hasUserTimezone: false,
    localNow: serverNow,
    localHour,
    localMinute,
    localTotalMin: localHour * 60 + localMinute,
    localDateStr: _localDateStr(serverNow),
    notifEnabled: true,
    hardDND: false,
    inDND: false,
    allowsProactive: true,
  };
}

// ─── Cache invalidation hook (for tests / settings updates) ────
function invalidateUserNotifContext(deviceId) {
  if (!deviceId) {
    _ctxCache.clear();
  } else {
    _ctxCache.delete(deviceId);
  }
}

module.exports = {
  getUserNotifContext,
  invalidateUserNotifContext,
  // Re-exports for callers that want to compute their own:
  parseHHMM,
  isInDND,
  getUserLocalDate,
  getUserLocalDateStr,
};
