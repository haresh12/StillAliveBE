'use strict';
// ════════════════════════════════════════════════════════════════
// range-helpers.js — single source of truth for date/range math
// used by every agent's /log and /analysis route + cross-agent.
//
// The Registration Anchor Law (2026-05-13):
//   • userAnchorMs = floorToLocalDay(setup.created_at) in user's TZ
//   • No log lands before anchor.
//   • All windows clamp to [max(rangeStart, anchorMs), now].
//   • Date keys are LOCAL-TZ `${y}-${m}-${d}`, never toISOString().
//
// All functions are pure (no I/O). Test with mock dates.
// ════════════════════════════════════════════════════════════════

// ─── pure date-key helpers ──────────────────────────────────────

/**
 * Apply utc_offset_minutes shift to a Date, then read UTC fields.
 * This is how we get "local-TZ" YMD without depending on the
 * server's process.env.TZ. Matches cron-user-context pattern.
 */
function shiftToUserLocal(d, utcOffsetMinutes) {
  const off = Number.isFinite(utcOffsetMinutes)
    ? Math.max(-14 * 60, Math.min(14 * 60, utcOffsetMinutes))
    : 0;
  return new Date(d.getTime() + off * 60_000);
}

/**
 * Local-TZ date key `YYYY-MM-DD`.
 *   dateStr(new Date(), -480)        → today in PST
 *   dateStr(new Date(), 0)           → today in UTC
 *   dateStr(new Date('2026-05-13T23:30:00Z'), -480) → '2026-05-13' (still 15:30 PST)
 */
function dateStr(d = new Date(), utcOffsetMinutes = 0) {
  const local = shiftToUserLocal(d, utcOffsetMinutes);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(local.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * UTC ms at the start of the user's local day for the given instant.
 *   floorToLocalDay(Date.now(), -480) → midnight PST in UTC ms.
 */
function floorToLocalDay(ms, utcOffsetMinutes = 0) {
  const off = Number.isFinite(utcOffsetMinutes)
    ? Math.max(-14 * 60, Math.min(14 * 60, utcOffsetMinutes))
    : 0;
  const shifted = ms + off * 60_000;
  const dayMs = 86_400_000;
  const flooredShifted = Math.floor(shifted / dayMs) * dayMs;
  return flooredShifted - off * 60_000;
}

/**
 * Whole days between two local-TZ midnights (inclusive of today).
 *   anchor=today                  → 1
 *   anchor=yesterday              → 2
 *   anchor=N days ago             → N+1
 */
function daysSinceAnchor(nowMs, anchorMs, utcOffsetMinutes = 0) {
  if (!Number.isFinite(anchorMs) || anchorMs <= 0) return 0;
  const todayFloor = floorToLocalDay(nowMs, utcOffsetMinutes);
  const anchorFloor = floorToLocalDay(anchorMs, utcOffsetMinutes);
  const diff = Math.floor((todayFloor - anchorFloor) / 86_400_000);
  return Math.max(0, diff) + 1;
}

// ─── range / window math ────────────────────────────────────────

/**
 * Compute the effective analysis window clamped to the user's anchor.
 *
 * Input:
 *   requestedDays    — what FE asked for (7/30/365)
 *   anchorMs         — registration anchor (0 = no anchor)
 *   nowMs            — current instant
 *   utcOffsetMinutes — user's TZ offset
 *
 * Output:
 *   effectiveDays      — clamped span in days (≥ 1)
 *   cutoffMs           — UTC ms of the window start (local midnight)
 *   effectiveStartDate — local-TZ YYYY-MM-DD of cutoffMs
 *   todayDate          — local-TZ YYYY-MM-DD of nowMs
 *   isClamped          — true if anchor shrunk the window
 *   daysSinceAnchor    — separate field for score-maturity math
 */
function computeAnalysisWindow(requestedDays, anchorMs, nowMs, utcOffsetMinutes = 0) {
  const req = Math.max(1, Math.min(365, parseInt(requestedDays, 10) || 30));
  const todayDate = dateStr(new Date(nowMs), utcOffsetMinutes);
  const todayMidnightMs = floorToLocalDay(nowMs, utcOffsetMinutes);

  // Requested window: today + (req-1) prior days, all at local midnight.
  const requestedCutoffMs = todayMidnightMs - (req - 1) * 86_400_000;

  let cutoffMs = requestedCutoffMs;
  let isClamped = false;

  if (Number.isFinite(anchorMs) && anchorMs > 0) {
    const anchorFloor = floorToLocalDay(anchorMs, utcOffsetMinutes);
    if (anchorFloor > requestedCutoffMs) {
      cutoffMs = anchorFloor;
      isClamped = true;
    }
  }

  const effectiveDays = Math.floor((todayMidnightMs - cutoffMs) / 86_400_000) + 1;
  const effectiveStartDate = dateStr(new Date(cutoffMs), utcOffsetMinutes);
  const dsa = Number.isFinite(anchorMs) && anchorMs > 0
    ? daysSinceAnchor(nowMs, anchorMs, utcOffsetMinutes)
    : 0;

  return {
    effectiveDays: Math.max(1, effectiveDays),
    cutoffMs,
    effectiveStartDate,
    todayDate,
    isClamped,
    daysSinceAnchor: dsa,
    requestedDays: req,
  };
}

/**
 * Enumerate every YYYY-MM-DD date string from start (inclusive) to today (inclusive)
 * in the user's local TZ. Used by chart bucketers + missed-day counters.
 */
function enumerateDaysFrom(startDateStr, todayDateStr) {
  if (!startDateStr || !todayDateStr) return [];
  if (startDateStr > todayDateStr) return [];
  const out = [];
  let [y, m, d] = startDateStr.split('-').map(Number);
  // Iterate using UTC arithmetic on the synthetic date — TZ-safe because we
  // never read local fields off it.
  let cur = Date.UTC(y, m - 1, d);
  const endMs = Date.UTC(...todayDateStr.split('-').map((x, i) => i === 1 ? Number(x) - 1 : Number(x)));
  while (cur <= endMs) {
    const dt = new Date(cur);
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    out.push(`${yy}-${mm}-${dd}`);
    cur += 86_400_000;
  }
  return out;
}

// ─── shared helpers (kept here for one-stop import) ─────────────

function getMillis(value) {
  if (value == null) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const p = new Date(value).getTime();
  return Number.isNaN(p) ? 0 : p;
}

module.exports = {
  dateStr,
  floorToLocalDay,
  daysSinceAnchor,
  computeAnalysisWindow,
  enumerateDaysFrom,
  getMillis,
  shiftToUserLocal,
};
