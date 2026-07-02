"use strict";
// ════════════════════════════════════════════════════════════════
// time-context.js — a compact, always-fresh "what time is it for THIS user" block that gets
// APPENDED to every coach chat system prompt (see chat-stream.js), so replies can be time-aware:
// a 1 PM "how's my day?" can nudge lunch; an 11:30 PM one reflects instead of assigning tasks.
//
// The offset arrives from the device on each request (utc_offset_minutes), so it's travel-accurate
// and needs no DB read. Appended at the very end of the prompt → the cached English prefix stays
// intact; only this short, time-varying tail is re-processed.
// ════════════════════════════════════════════════════════════════

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Part-of-day bucket from a local 0–23 hour. */
function timeOfDay(h) {
  if (h >= 5 && h < 11) return "morning";
  if (h >= 11 && h < 14) return "midday";
  if (h >= 14 && h < 17) return "afternoon";
  if (h >= 17 && h < 21) return "evening";
  return "late night";
}

function clock12(h, m) {
  const ap = h < 12 ? "AM" : "PM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${String(m).padStart(2, "0")} ${ap}`;
}

/**
 * A compact time block to APPEND to a system prompt. Returns "" if the offset is missing/invalid
 * (so the coach simply stays time-agnostic rather than guessing a wrong time).
 */
function timeContextBlock(utcOffsetMinutes) {
  const off = Number(utcOffsetMinutes);
  if (!Number.isFinite(off) || off < -840 || off > 840) return "";
  // Shift "now" by the user's offset, then read UTC fields → the user's real local wall-clock,
  // independent of the server's own timezone (Fly runs UTC).
  const local = new Date(Date.now() + off * 60000);
  const h = local.getUTCHours();
  const m = local.getUTCMinutes();
  const day = DAYS[local.getUTCDay()];
  const tod = timeOfDay(h);
  return [
    "",
    `CURRENT LOCAL TIME: ${day} ${clock12(h, m)} — ${tod}.`,
    "TIME-AWARENESS: Weave the time of day in only when it's genuinely relevant (roughly a third of " +
      "replies — never force it, never state the clock robotically). Ground \"how's my day / how am I " +
      "doing\" answers in what they've ACTUALLY logged today. Cues by part of day: morning → nudge a " +
      "strong start or first log; midday → if no meal is logged, gently ask if they've had lunch and " +
      "offer to log it; afternoon → check progress, suggest the next small win; evening → wind-down, " +
      "reflect on what went well; late night → reflect gently, don't assign new tasks or push hard. " +
      "Keep it natural and human.",
  ].join("\n");
}

module.exports = { timeContextBlock, timeOfDay };
