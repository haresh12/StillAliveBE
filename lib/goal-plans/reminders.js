'use strict';
// ════════════════════════════════════════════════════════════════════════
// reminders.js — derive notification schedule from a finalized plan.
//
// Why this exists:
//   The user said "you're the one creating the plan — you should know
//   when to remind". This file does exactly that: given a plan whose
//   items already carry time_anchor_local (the LLM picked them), we emit
//   a tight reminder schedule the FE can hand straight to notifee via
//   the existing `plansNotifications.js` framework.
//
// Cap:
//   MAX_REMINDERS_PER_PLAN (3). Anything more = notification fatigue.
//   We pick:
//     1) one morning "kickoff" at the preferred-time chosen by the user
//        (or 08:00 default) — opens the plan with today's count.
//     2) up to N item_due reminders for items with time_anchor_local,
//        ordered by time, deduped by clock-time within the same plan.
// ════════════════════════════════════════════════════════════════════════

const { LIMITS } = require('./constants');

// Map a user "preferred time" chip answer to a clock-time for the kickoff.
// Falls back to 08:00 if absent / unrecognized.
function preferredKickoffHour(preferredTimeChoice) {
  if (!preferredTimeChoice || typeof preferredTimeChoice !== 'string') return { hh: 8, mm: 0 };
  const lower = preferredTimeChoice.toLowerCase();
  if (lower.startsWith('early'))     return { hh: 6,  mm: 30 };
  if (lower.includes('morning'))     return { hh: 8,  mm: 0  };
  if (lower.includes('midday'))      return { hh: 11, mm: 30 };
  if (lower.includes('afternoon'))   return { hh: 14, mm: 0  };
  if (lower.includes('evening'))     return { hh: 18, mm: 0  };
  if (lower.includes('late'))        return { hh: 20, mm: 30 };
  return { hh: 8, mm: 0 };
}

/**
 * Build the reminders[] for a freshly-generated plan.
 *
 * Input shape (relevant fields):
 *   plan.days[0].items[].time_anchor_local  "HH:MM" or undefined
 *   answers[] — the question answers; if one of them was the "preferred
 *               time of day" chip question, we use it to set kickoff time.
 *
 * Output shape — matches what `StillAlive/src/lib/notifs/plansNotifications.js`
 * expects (it iterates `plan.reminders`, reading kind / item_ref / hh / mm).
 */
function buildRemindersForPlan(plan, answers = []) {
  const reminders = [];

  // 1) Find the user's preferred time-of-day answer, if any.
  const timeAnswer = (answers || []).find(a => {
    const id = String(a?.id || '').toLowerCase();
    return id.includes('time') || id.includes('when') || id.includes('preferred');
  });
  const { hh: kickHH, mm: kickMM } = preferredKickoffHour(timeAnswer?.value);

  // 2) Kickoff reminder at the preferred morning slot.
  reminders.push({ kind: 'kickoff', item_ref: null, hh: kickHH, mm: kickMM });

  // 3) Item-due reminders for items that carry a clock-time anchor.
  const items = (plan?.days?.[0]?.items || []);
  const seenClockTimes = new Set([`${kickHH}:${kickMM}`]);
  const itemReminders = [];
  for (const it of items) {
    if (!it.time_anchor_local || !/^\d{1,2}:\d{2}$/.test(it.time_anchor_local)) continue;
    const [hh, mm] = it.time_anchor_local.split(':').map(Number);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) continue;
    const key = `${hh}:${mm}`;
    if (seenClockTimes.has(key)) continue;
    seenClockTimes.add(key);
    itemReminders.push({ kind: 'item_due', item_ref: it.id, hh, mm });
  }
  // Sort by time ascending and cap to MAX_REMINDERS_PER_PLAN - 1 (we
  // already used 1 slot for kickoff).
  itemReminders.sort((a, b) => (a.hh * 60 + a.mm) - (b.hh * 60 + b.mm));
  const remainingSlots = Math.max(0, LIMITS.MAX_REMINDERS_PER_PLAN - reminders.length);
  reminders.push(...itemReminders.slice(0, remainingSlots));

  return reminders;
}

module.exports = { buildRemindersForPlan, preferredKickoffHour };
