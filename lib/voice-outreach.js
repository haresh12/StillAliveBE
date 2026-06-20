'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// voice-outreach.js — the "should the coach reach out?" brain (criteria, not spam).
//
// The coach proactively calls ONLY when it sees a real pattern worth a human nudge:
//   1) New user signed up a few days ago but never logged anything.
//   2) Was logging regularly, then went quiet (slipping).
//   3) Did exactly one check-in, then stopped (about to churn).
// Gates (in order): opt-in → PREMIUM (free users are NEVER called out — inbound only) → local-hours →
// cooldown (≤1–2×/week). This module only DECIDES; the delivery layer (notification / future CallKit)
// handles HOW + respects quiet hours. Free users can still CALL the coach (inbound, 5-min cap).
// ═══════════════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');
const { buildBriefing } = require('./voice-briefing');
const { getRecentCallContext } = require('./voice-calls');
const { userDoc } = require('./collections');

// Min days between proactive touches (any call in this window → skip) — keeps it to ~1–2×/week, never spammy.
const COOLDOWN_DAYS = Number(process.env.VOICE_PROACTIVE_COOLDOWN_DAYS || 5);
const DAY = 86_400_000;

// Outbound proactive calls are PREMIUM-only. Subscription syncs to the account-level wellness_users doc
// (same deviceId) — the SAME source mintSession reads for the call-length cap, so the two never disagree.
async function isPremium(deviceId) {
  try {
    const snap = await admin.firestore().collection('wellness_users').doc(deviceId).get();
    const sub = snap.exists ? (snap.data().subscription || {}) : {};
    return !!(sub.isPremium || sub.isTrial);
  } catch { return false; }
}

/**
 * Decide whether to proactively call a user.
 * @returns {{ shouldCall, severity?, reason, signal? }}
 */
async function evaluateProactiveCall(deviceId) {
  // Explicit opt-in is REQUIRED — the coach never reaches out unless the user turned it on (Settings).
  const uSnap = await userDoc(deviceId).get().catch(() => null);
  const u = (uSnap && uSnap.exists ? uSnap.data() : {}) || {};
  if (u.voice_proactive_opt_in !== true) return { shouldCall: false, reason: 'opted_out' };

  // PREMIUM-only: free users are never called out by the coach (they can still call in). This is the
  // hard source of truth — even if a free client flips the opt-in, the server refuses the outbound call.
  if (!(await isPremium(deviceId))) return { shouldCall: false, reason: 'free_user' };

  // Local-time window (defense-in-depth, independent of the delivery layer): a real coach never rings at
  // 3am. Only reach out 9:00–20:00 in the USER's timezone. Prefer current_tz_offset (kept fresh on app
  // open → travel-aware), falling back to the frozen registration_tz_offset. Minutes east of UTC.
  const tzOffMin = Number.isFinite(u.current_tz_offset)
    ? u.current_tz_offset
    : Number.isFinite(u.registration_tz_offset) ? u.registration_tz_offset : 0;
  const localHour = new Date(Date.now() + tzOffMin * 60000).getUTCHours();
  if (localHour < 9 || localHour >= 20) return { shouldCall: false, reason: 'off_hours' };

  const b = await buildBriefing(deviceId).catch(() => null);
  if (!b) return { shouldCall: false, reason: 'no_data' };

  const domains = Array.isArray(b.domains) ? b.domains : [];
  const daysSinceAnchor = (b.anchor && b.anchor.days_since_anchor) || 0;
  const totalLogged = domains.reduce((s, d) => s + (d.days_logged || 0), 0);
  const lastSeen = domains.map(d => d.days_since_last).filter(v => v != null && v >= 0);
  const daysSinceActivity = lastSeen.length ? Math.min(...lastSeen) : daysSinceAnchor;

  // Cooldown: if ANY call happened recently, don't reach out (they're already engaged).
  const recent = await getRecentCallContext(deviceId, 5).catch(() => []);
  const now = Date.now();
  if (recent.some(c => c.started_at && now - c.started_at < COOLDOWN_DAYS * DAY)) {
    return { shouldCall: false, reason: 'cooldown' };
  }

  // 1) New, never activated (signed up 2–6 days ago, zero logs).
  if (daysSinceAnchor >= 2 && daysSinceAnchor <= 6 && totalLogged === 0) {
    return { shouldCall: true, severity: 'high', signal: 'never_activated',
      reason: `Signed up ${daysSinceAnchor} days ago but hasn't logged anything — a warm check-in could activate them.` };
  }
  // 2) Was active, now slipping (logged ≥2 days, silent ≥2 days).
  if (totalLogged >= 2 && daysSinceActivity >= 2) {
    return { shouldCall: true, severity: daysSinceActivity >= 4 ? 'high' : 'med', signal: 'slipping',
      reason: `Was logging regularly, now quiet for ${daysSinceActivity} days.` };
  }
  // 3) One-and-done (exactly one check-in, then stopped ≥2 days).
  if (totalLogged === 1 && daysSinceActivity >= 2) {
    return { shouldCall: true, severity: 'med', signal: 'one_and_done',
      reason: `Did one check-in then stopped (${daysSinceActivity} days ago) — re-engage before they churn.` };
  }
  return { shouldCall: false, reason: 'on_track' };
}

module.exports = { evaluateProactiveCall };
