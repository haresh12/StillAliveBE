/**
 * streak-engine.js
 * Per-agent streaks + cross-agent forgiving grace.
 *
 * Forgiving rule: if a user has ≥2 strong agents (above floor) today,
 * one missed agent's streak does NOT break — grace covers it.
 * Plus weekly auto-grant Streak Freeze that the user can manually deploy.
 */

const config = require('../config');
const { AGENTS } = require('../adapters/_shape');

const FLOOR = config.STREAKS.GRACE_AGENT_SCORE_FLOOR;
const STRONG_NEED = config.STREAKS.GRACE_THRESHOLD_STRONG_AGENTS;

function computeStreaks({ snapshots, prevStreaks, todayDate }) {
  const todayStrong = AGENTS.filter((a) => {
    const snap = snapshots[a];
    return (
      snap &&
      snap.setup.is_complete &&
      snap.today.has_log &&
      Number.isFinite(snap.today.score) &&
      snap.today.score >= FLOOR
    );
  }).length;

  const grace_active = todayStrong >= STRONG_NEED;
  const grace_reason = grace_active
    ? `${todayStrong} strong agents today — covering any missed log`
    : null;

  const per_agent = AGENTS.map((agent) => {
    const snap = snapshots[agent];
    const prev = (prevStreaks && prevStreaks.per_agent && prevStreaks.per_agent[agent]) || {
      current: 0,
      longest: 0,
      last_log_date: null,
      status: 'lapsed',
    };

    if (!snap || !snap.setup.is_complete) {
      return { agent, current: 0, longest: prev.longest || 0, status: 'lapsed' };
    }

    const loggedToday = !!snap.today.has_log;
    let current = prev.current || 0;
    let status = 'active';

    if (loggedToday) {
      if (prev.last_log_date && isYesterday(prev.last_log_date, todayDate)) {
        current = prev.current + 1;
      } else if (prev.last_log_date === todayDate) {
        current = prev.current; // same-day no-op
      } else {
        current = 1;
      }
    } else if (grace_active) {
      // Grace covers: streak holds
      current = prev.current;
      status = 'frozen';
    } else if (prev.last_log_date && isYesterday(prev.last_log_date, todayDate)) {
      // Skipped yesterday → today; no grace; lapse
      current = 0;
      status = 'lapsed';
    } else {
      current = prev.current; // not yet expected to log today
    }

    const longest = Math.max(prev.longest || 0, current);
    return {
      agent,
      current,
      longest,
      status,
      last_log_date: loggedToday ? todayDate : prev.last_log_date || null,
    };
  });

  // Streak freeze inventory
  const freezes = updateFreezes(prevStreaks ? prevStreaks.freezes : null, todayDate);

  return {
    per_agent,
    cross_agent_grace_active: grace_active,
    grace_reason,
    streak_freeze_available: freezes.available > 0,
    streak_freeze_count: freezes.available,
    next_freeze_grant_at: freezes.next_grant_at,
    freezes,
    updated_at: new Date().toISOString(),
  };
}

function isYesterday(prev, today) {
  const d1 = new Date(prev + 'T00:00:00Z');
  const d2 = new Date(today + 'T00:00:00Z');
  return d2.getTime() - d1.getTime() === 24 * 60 * 60 * 1000;
}

function updateFreezes(prevFreezes, todayDate) {
  const max = config.STREAKS.FREEZE_MAX_INVENTORY;
  if (!prevFreezes) {
    return {
      available: 1,
      used_this_week: 0,
      last_grant_at: todayDate,
      next_grant_at: nextMonday(todayDate),
    };
  }

  const today = new Date(todayDate + 'T00:00:00Z');
  const next = new Date(prevFreezes.next_grant_at + 'T00:00:00Z');

  let available = prevFreezes.available;
  let lastGrant = prevFreezes.last_grant_at;
  let nextGrant = prevFreezes.next_grant_at;

  if (today.getTime() >= next.getTime()) {
    available = Math.min(max, available + config.STREAKS.FREEZE_GRANT_PER_WEEK);
    lastGrant = todayDate;
    nextGrant = nextMonday(todayDate);
  }

  return {
    available,
    used_this_week: prevFreezes.used_this_week || 0,
    last_grant_at: lastGrant,
    next_grant_at: nextGrant,
  };
}

function nextMonday(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay(); // 0=Sun,1=Mon,...
  const daysUntil = (8 - day) % 7 || 7; // always next-Monday-or-later
  d.setUTCDate(d.getUTCDate() + daysUntil);
  return d.toISOString().slice(0, 10);
}

module.exports = { computeStreaks, nextMonday };
