'use strict';
// ════════════════════════════════════════════════════════════════════════
// goal-plans/dayShape.js — v3 day-shaping helpers (theme + anchor inlining).
//
// These run at /draft/finalize after the LLM returns batches but before we
// persist the plan. They take the LLM's flat days and turn them into the
// shape the v3 FE expects:
//   • day.theme derived by formula from day_index / duration
//   • daily_anchors inlined into every day's items[], tagged with
//     from_anchor: true and the anchor's own time_section
// ════════════════════════════════════════════════════════════════════════

const { TIME_SECTIONS } = require('./schemas');

const THEME_KEYS = {
  FOUNDATION: 'foundation',
  BUILD:      'build',
  PEAK:       'peak',
};

/**
 * Derive a per-day theme from day_index + total duration.
 *   Foundation = first 1/3 of the plan
 *   Build      = middle 1/3
 *   Peak       = last 1/3
 *
 * For a 7-day plan: 1-2 Foundation, 3-5 Build, 6-7 Peak.
 * For a 30-day plan: 1-10 Foundation, 11-20 Build, 21-30 Peak.
 * For a 90-day plan: 1-30 Foundation, 31-60 Build, 61-90 Peak.
 *
 * Returns a SHORT key the FE maps to a localized label
 * (plans.day.theme.foundation / .build / .peak).
 */
function themeForDay(dayIndex, durationDays) {
  const d = Math.max(1, Number(dayIndex) || 1);
  const total = Math.max(1, Number(durationDays) || 30);
  const ratio = d / total;
  if (ratio <= 1 / 3) return THEME_KEYS.FOUNDATION;
  if (ratio <= 2 / 3) return THEME_KEYS.BUILD;
  return THEME_KEYS.PEAK;
}

/**
 * Default time_section for an anchor based on its when_label / time text.
 * Used when the LLM omits the time_section field (defensive fallback).
 */
function inferTimeSection(item) {
  const txt = `${item?.when_label || ''} ${item?.time_anchor_local || ''}`.toLowerCase();
  if (/\b(night|bedtime|wind[- ]?down|before bed|11pm|10pm|9pm)\b/.test(txt)) return 'night';
  if (/\b(morning|breakfast|wake|early|6am|7am|8am|9am|10am|am)\b/.test(txt)) return 'morning';
  if (/\b(evening|afternoon|lunch|dinner|post[- ]?work|pm)\b/.test(txt))      return 'evening';
  return 'morning';
}

/**
 * Normalize an item's time_section to a valid enum value. Falls back to
 * inference when the LLM returns garbage or omits the field.
 */
function normalizeTimeSection(item) {
  const t = String(item?.time_section || '').toLowerCase().trim();
  if (TIME_SECTIONS.includes(t)) return t;
  return inferTimeSection(item);
}

/**
 * Inline daily anchors into a day's items[].
 *
 *   • Anchors carry `from_anchor: true` so the FE can styles them differently
 *     (subtler card border, ★ glyph, etc.) and so the BE can strip them
 *     before re-generating.
 *   • Anchor IDs are deterministic (`a_<idx>`) so completing the same anchor
 *     on different days writes to predictably-named per-day log slots.
 *   • Each item gets time_section normalized.
 */
function buildDayItems({ llmItems, anchors, dayIndex }) {
  const out = [];
  // 1. Anchors first — they appear in every day, tagged from_anchor.
  if (Array.isArray(anchors)) {
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      if (!a || !a.title) continue;
      out.push({
        ...a,
        // Deterministic ID per anchor per day. Allows per-day complete logging.
        id: `a_${i}_d${dayIndex}`,
        from_anchor: true,
        time_section: normalizeTimeSection(a),
      });
    }
  }
  // 2. LLM-generated day-specific items.
  if (Array.isArray(llmItems)) {
    for (const it of llmItems) {
      if (!it || !it.title) continue;
      out.push({
        ...it,
        from_anchor: false,
        time_section: normalizeTimeSection(it),
      });
    }
  }
  return out;
}

/**
 * Shape a full day for storage:
 *   • Stamps theme.
 *   • Inlines anchors into items[] with correct time_section.
 *   • Preserves day_index, summary, rest_day, date_key.
 *   • Drops spotlight (v3 removes it).
 */
function shapeDayForStorage({ llmDay, anchors, durationDays }) {
  if (!llmDay) return null;
  return {
    day_index: llmDay.day_index,
    date_key:  llmDay.date_key,
    summary:   llmDay.summary || '',
    theme:     themeForDay(llmDay.day_index, durationDays),
    rest_day:  Boolean(llmDay.rest_day),
    items:     buildDayItems({
      llmItems:  llmDay.items,
      anchors,
      dayIndex:  llmDay.day_index,
    }),
  };
}

module.exports = {
  themeForDay,
  inferTimeSection,
  normalizeTimeSection,
  buildDayItems,
  shapeDayForStorage,
  THEME_KEYS,
};
