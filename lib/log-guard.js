'use strict';
// ════════════════════════════════════════════════════════════════
// log-guard.js — single validator every agent POST /log route uses.
//
// Rules (Registration Anchor Law, 2026-05-13):
//   • Reject `date < anchorDateStr` → 400 PRE_ANCHOR
//   • Reject `date > todayDateStr`  → 400 FUTURE_DATE
//   • Reject malformed date string  → 400 INVALID_DATE
//   • Anchor missing (unresolved)   → pass-through (legacy users)
//
// Pure validator — throws a tagged Error with `.status` and `.code`
// so route handlers can `try/catch` and forward.
// ════════════════════════════════════════════════════════════════

const { dateStr } = require('./range-helpers');

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class LogGuardError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'LogGuardError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Validate a log date against the user's anchor.
 *
 * @param {string} candidateDate   YYYY-MM-DD candidate; if falsy, defaults to today
 * @param {object} anchor          { anchorDateStr, utcOffsetMinutes, isResolved }
 * @param {number} [nowMs]         override for tests
 * @returns {string}               the validated date string (echoed back)
 * @throws {LogGuardError}
 */
function assertLoggableDate(candidateDate, anchor, nowMs = Date.now()) {
  const offset = Number.isFinite(anchor?.utcOffsetMinutes) ? anchor.utcOffsetMinutes : 0;
  const todayStr = dateStr(new Date(nowMs), offset);
  const date = candidateDate || todayStr;

  if (!ISO_DATE_RE.test(date)) {
    throw new LogGuardError('INVALID_DATE', `date must be YYYY-MM-DD (got "${date}")`);
  }

  if (date > todayStr) {
    throw new LogGuardError('FUTURE_DATE', `cannot log for future date ${date} (today is ${todayStr})`);
  }

  if (anchor?.isResolved && anchor.anchorDateStr && date < anchor.anchorDateStr) {
    throw new LogGuardError(
      'PRE_ANCHOR',
      `cannot log before registration date ${anchor.anchorDateStr} (attempted ${date})`,
    );
  }

  return date;
}

/**
 * Express helper: turns a LogGuardError into a 400 JSON response.
 * Re-throws anything else.
 */
function sendLogGuardError(res, err) {
  if (err && err.name === 'LogGuardError') {
    return res.status(err.status || 400).json({
      success: false,
      error: err.message,
      code: err.code,
    });
  }
  throw err;
}

module.exports = {
  LogGuardError,
  assertLoggableDate,
  sendLogGuardError,
};
