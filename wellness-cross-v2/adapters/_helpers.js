/**
 * wellness-cross-v2/adapters/_helpers.js
 *
 * Date utilities, log fetching, and a generic adapter builder.
 * Each per-agent adapter is a thin specialization of buildAdapter().
 */

const { agentDoc, agentLogsCol, userDoc } = require('../persistence/_firestore');
const { emptyAgentSnapshot } = require('./_shape');
const agentScores = require('../../lib/agent-scores');
const { resolveAnchor } = require('../../lib/user-anchor');

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

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function todayDate(tzOffsetMin = 0) {
  const now = new Date(Date.now() + tzOffsetMin * 60 * 1000);
  return _localDateStr(now);
}

function dateNDaysAgo(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return _localDateStr(d);
}

function dateRange(endDate, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push(dateNDaysAgo(endDate, i));
  }
  return out;
}

function dateOf(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value._seconds) return _localDateStr(new Date(value._seconds * 1000));
  if (value.toDate) return _localDateStr(value.toDate());
  if (value instanceof Date) return _localDateStr(value);
  return null;
}

function isoOf(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value._seconds) return new Date(value._seconds * 1000).toISOString();
  if (value.toDate) return value.toDate().toISOString();
  return null;
}

function daysBetween(a, b) {
  const da = new Date(a + 'T00:00:00Z').getTime();
  const db = new Date(b + 'T00:00:00Z').getTime();
  return Math.round((db - da) / MS_PER_DAY);
}

function clip(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * Read raw logs from agent's logs collection over [endDate-days+1 .. endDate].
 * Returns logs ordered oldest→newest.
 *
 * Each agent's log document is allowed any shape, but we expect either:
 *   - a `logged_at` Timestamp, or
 *   - a `date` string 'YYYY-MM-DD'
 * Plus a `score` field if the agent stores per-log score (used as fast path).
 */
// Each agent's collection orders by a different timestamp field.
const AGENT_ORDER_FIELDS = {
  sleep:     'logged_at',
  mind:      'logged_at',
  nutrition: 'logged_at',
  fitness:   'logged_at',
  water:     'logged_at',
  fasting:   'started_at',  // fasting_sessions don't have logged_at
};

function resolveDate(row) {
  return dateOf(row.logged_at)
      || dateOf(row.date)
      || row.date_str
      || dateOf(row.started_at)
      || dateOf(row.ended_at);
}

async function fetchLogs(deviceId, agent, endDate, days) {
  const startDate = dateNDaysAgo(endDate, days - 1);
  const startTs = new Date(startDate + 'T00:00:00Z').getTime();
  const orderField = AGENT_ORDER_FIELDS[agent] || 'logged_at';

  const snap = await agentLogsCol(deviceId, agent)
    .orderBy(orderField, 'desc')
    .limit(days * 4)
    .get()
    .catch(() => null);

  // snap === null  → query errored (likely missing index). Try unordered fallback.
  // snap.empty     → definitive 0 logs for this user. Don't fire a 2nd query.
  // Removing the unconditional fallback saves ~6 wasted Firestore round trips
  // on cold start for fresh users (one per agent).
  if (!snap) {
    const fallback = await agentLogsCol(deviceId, agent)
      .limit(days * 4)
      .get()
      .catch(() => null);
    if (!fallback || fallback.empty) return [];
    return fallback.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((row) => {
        const dt = resolveDate(row);
        if (!dt) return false;
        return new Date(dt + 'T00:00:00Z').getTime() >= startTs;
      });
  }
  if (snap.empty) return [];

  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((row) => {
      const dt = resolveDate(row);
      if (!dt) return false;
      return new Date(dt + 'T00:00:00Z').getTime() >= startTs;
    })
    .reverse();
}

/**
 * Group raw logs into daily buckets keyed by 'YYYY-MM-DD'.
 * If multiple logs on a day, callers decide aggregation policy.
 */
function groupLogsByDate(logs) {
  const map = new Map();
  for (const row of logs) {
    const dt = resolveDate(row);
    if (!dt) continue;
    if (!map.has(dt)) map.set(dt, []);
    map.get(dt).push(row);
  }
  return map;
}

/**
 * Build a daily-points array (length=days) for the given range,
 * given a per-day log map and a scoring function `scoreFn(logsForDay, daysSinceAnchor) -> 0..100|null`.
 *
 * V3: scoreFn now receives `daysSinceAnchor` (computed per-date against the
 * user's registration anchor) so per-agent libs can apply the slow calendar-
 * keyed maturity ramp instead of falling back to log-count maturity. Without
 * this thread-through, Home (adapter) and Analysis (agent route) could
 * disagree on the same score by 5-10 pts on Day-1 users.
 *
 * When `anchorDateStr` is null (legacy users with unresolved anchor),
 * daysSinceAnchor defaults to 0 — maturity is at its strictest, which is
 * the safe default per the contract's "score never inflates" law.
 */
function buildDailyPoints(endDate, days, logsByDate, scoreFn, anchorDateStr = null) {
  const dates = dateRange(endDate, days);
  return dates.map((date) => {
    const logsForDay = logsByDate.get(date) || [];
    const has_log = logsForDay.length > 0;
    let score = null;
    if (has_log) {
      try {
        const dsa = anchorDateStr ? Math.max(0, daysBetween(anchorDateStr, date)) : 0;
        const s = scoreFn(logsForDay, dsa);
        if (Number.isFinite(s)) score = clip(Math.round(s), 0, 100);
      } catch (e) {
        score = null;
      }
    }
    return { date, score, has_log };
  });
}

function aggregates90(daily) {
  const withScore = daily.filter((p) => Number.isFinite(p.score));
  if (withScore.length === 0) {
    return {
      avg_score: null,
      std_dev: null,
      best_day_score: null,
      best_day_date: null,
      worst_day_score: null,
      worst_day_date: null,
      days_with_log: 0,
    };
  }
  const scores = withScore.map((p) => p.score);
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((acc, s) => acc + (s - avg) ** 2, 0) / scores.length;
  const std_dev = Math.sqrt(variance);
  const best = withScore.reduce((a, b) => (b.score > a.score ? b : a));
  const worst = withScore.reduce((a, b) => (b.score < a.score ? b : a));
  return {
    avg_score: Math.round(avg * 10) / 10,
    std_dev: Math.round(std_dev * 10) / 10,
    best_day_score: best.score,
    best_day_date: best.date,
    worst_day_score: worst.score,
    worst_day_date: worst.date,
    days_with_log: withScore.length,
  };
}

/**
 * Generic adapter factory.
 *
 * @param {Object} cfg
 * @param {string} cfg.agent           - agent name
 * @param {(deviceId: string, agentSnap: object) => Promise<object>} cfg.readSetup
 *   Returns { is_complete, completed_at, days_since_setup, config }.
 * @param {(logsForDay: object[], agentSnap: object) => number|null} cfg.scoreDailyLogs
 *   Returns 0..100 daily score given that day's logs (use lib/agent-scores.computeAgentScore as needed).
 * @param {(logsForDay: object[], agentSnap: object) => object} [cfg.componentsForToday]
 *   Optional: returns today's component breakdown (per-agent flexible).
 */
function buildAdapter(cfg) {
  const { agent, readSetup, scoreDailyLogs, componentsForToday, extraFields } = cfg;

  return async function adapter(deviceId, opts = {}) {
    const today = opts.todayDate || todayDate();

    const [userSnap, agentSnap] = await Promise.all([
      userDoc(deviceId).get(),
      agentDoc(deviceId, agent).get(),
    ]);

    if (!userSnap.exists) {
      return emptyAgentSnapshot(agent, today);
    }

    const userData = userSnap.exists ? userSnap.data() : {};
    const agentData = agentSnap.exists ? agentSnap.data() : {};

    const setupFlag = userData[`${agent}_setup_complete`] || agentData.setup_complete || false;

    const setup = await readSetup(deviceId, { userData, agentData });
    setup.is_complete = setupFlag || setup.is_complete;

    const logs = await fetchLogs(deviceId, agent, today, 90);
    const logsByDate = groupLogsByDate(logs);

    // V3: resolve the user's anchor ONCE here, pass per-day `daysSinceAnchor`
    // into the scoring fn so per-agent libs can apply the slow canonical
    // maturity ramp (calendar-keyed) instead of log-count fallback.
    // See SCORING_CONTRACT_V3.md §2.
    const anchor = await resolveAnchor(deviceId).catch(() => null);
    const anchorDateStr = anchor?.isResolved ? anchor.anchorDateStr : null;

    const last_30d = buildDailyPoints(today, 30, logsByDate, (l, dsa) => scoreDailyLogs(l, agentData, dsa), anchorDateStr);
    const last_14d = last_30d.slice(-14);
    const daily90 = buildDailyPoints(today, 90, logsByDate, (l, dsa) => scoreDailyLogs(l, agentData, dsa), anchorDateStr);

    // Insights v2.3 — per-date raw log count for the 90d window. Used by
    // /api/wellness/v2/insights to compute pack.log_counts windowed to range.
    const log_counts_by_date = {};
    for (const date of dateRange(today, 90)) {
      const arr = logsByDate.get(date);
      log_counts_by_date[date] = arr ? arr.length : 0;
    }

    const todayLogs = logsByDate.get(today) || [];
    const todayDsa  = anchorDateStr ? Math.max(0, daysBetween(anchorDateStr, today)) : 0;
    const todayScore = todayLogs.length > 0 ? scoreDailyLogs(todayLogs, agentData, todayDsa) : null;
    const todayComponents = (componentsForToday && todayLogs.length > 0)
      ? componentsForToday(todayLogs, agentData)
      : {};

    // ─── Rolling smoothed scores (0-100) ───────────────────────────────
    // These are the numbers Home + Analysis surface to the user. Unlike
    // `today.score` (null on no-log days) they're stable across days because
    // they average over a window. Same values used everywhere → no two
    // sources of truth for the same coach's score.
    //
    // V3 §6: MISSED-DAY DECAY GRADIENT. The plain mean lets a single old log
    // produce phantom-good `smoothed_7d` after the user lapses for a week.
    // Rule: after 3 consecutive unlogged days at the end of the window, decay
    // toward DAY1_SEED (25) at 5 pts/day past the grace period. Never below
    // the seed (avoid black-hole "0" for returning users — bands stay honest).
    const DAY1_SEED   = 25;
    const DECAY_GRACE = 3;     // first 3 unlogged days are free
    const DECAY_PER_D = 5;     // 5 pts/day past grace
    function consecutiveUnloggedAtEnd(pts) {
      let n = 0;
      for (let i = pts.length - 1; i >= 0; i--) {
        if (Number.isFinite(pts[i].value)) break;
        n++;
      }
      return n;
    }
    function avgScored(pts) {
      const valid = pts.filter((p) => Number.isFinite(p.value));
      if (valid.length === 0) return null;
      return clip(Math.round(valid.reduce((s, p) => s + p.value, 0) / valid.length), 0, 100);
    }
    function smoothedWithDecay(pts) {
      const base = avgScored(pts);
      if (base == null) return null;
      const unlogged = consecutiveUnloggedAtEnd(pts);
      if (unlogged <= DECAY_GRACE) return base;
      const decayDays = unlogged - DECAY_GRACE;
      const decayed = base - decayDays * DECAY_PER_D;
      return clip(Math.round(Math.max(decayed, DAY1_SEED)), 0, 100);
    }
    const smoothed_7d  = smoothedWithDecay(last_30d.slice(-7));
    const smoothed_30d = smoothedWithDecay(last_30d);
    const days_scored  = last_30d.filter((p) => Number.isFinite(p.value)).length;
    const _unloggedTail = consecutiveUnloggedAtEnd(last_30d.slice(-7));
    const decay_applied = _unloggedTail > DECAY_GRACE;

    // Trend over last 14d: compare last 3 days avg vs prior 11 days avg
    function trendDirection() {
      const recent = last_14d.slice(-3).filter((p) => Number.isFinite(p.value));
      const prior  = last_14d.slice(0, 11).filter((p) => Number.isFinite(p.value));
      if (recent.length < 2 || prior.length < 3) return 'flat';
      const r = recent.reduce((s, p) => s + p.value, 0) / recent.length;
      const pr = prior.reduce((s, p) => s + p.value, 0) / prior.length;
      const d = r - pr;
      if (d >= 4)  return 'up';
      if (d <= -4) return 'down';
      return 'flat';
    }
    const trend_direction = trendDirection();

    const extra = (typeof extraFields === 'function') ? extraFields(logs, logsByDate, agentData) : {};

    return {
      agent,
      setup,
      today: {
        date: today,
        has_log: todayLogs.length > 0,
        score: Number.isFinite(todayScore) ? clip(Math.round(todayScore), 0, 100) : null,
        components: todayComponents,
      },
      // Rolling scores — UI reads these for the Home coach card AND the
      // agent's own Analysis tab. Same field, same number, everywhere.
      smoothed_7d,
      smoothed_30d,
      days_scored,
      // V3: surfaces whether the missed-day decay gradient is currently
      // dampening the smoothed score. FE can show a "you've been away —
      // log to lift the score" ribbon when true.
      decay_applied,
      trend_direction,
      last_14d,
      last_30d,
      last_90d: daily90,
      log_counts_by_date,
      aggregates_90d: aggregates90(daily90),
      aha_moments: Array.isArray(agentData.last_aha_moments) ? agentData.last_aha_moments.slice(0, 5) : [],
      signal_points: Array.isArray(agentData.last_signal_points) ? agentData.last_signal_points.slice(0, 10) : [],
      score_components: agentData.score_components || {},
      score_label: agentData.score_label || 'no_data',
      score_updated_at: isoOf(agentData.score_updated_at),
      ...extra,
      meta: {
        adapter_version: '2.3.0',
        fetched_at: new Date().toISOString(),
        read_only_verified: true,
      },
    };
  };
}

module.exports = {
  buildAdapter,
  todayDate,
  dateNDaysAgo,
  dateRange,
  daysBetween,
  dateOf,
  isoOf,
  clip,
  agentScores,
};
