'use strict';

// ═══════════════════════════════════════════════════════════════
// WATER AGENT — Pulse Backend
// Mounted at /api/water in server.js
//
// 10/10 upgrade goals:
//   • richer analysis payloads
//   • persistent daily coach actions
//   • better prompting + context
//   • calmer, smarter proactive logic
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { AI } = require('./lib/ai/models');
const router  = express.Router();
const admin   = require('firebase-admin');
const { OpenAI } = require('openai');
const cron    = require('node-cron');
const crypto  = require('crypto');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const db     = () => admin.firestore();

// Gemini 2.5 Pro is the canonical vision model across the app (nutrition +
// water + future flows). Same model + same decoding lock everywhere → re-shot
// scenes return byte-identical JSON. The router exports VISION_MODEL_PRIMARY
// so we never hard-code a model string at a call site.
// Gemini 2.5 Pro is preferred for water-photo vision (deterministic, cheaper,
// stays consistent across re-shoots of the same glass). OpenAI is the fallback.
const { callGeminiVision, hashImages, VISION_MODEL_PRIMARY } = require('./lib/vision-router');
const { MODELS, openaiStrict } = require('./lib/model-router');
const { resolveLanguage, appendLanguageInstruction } = require('./lib/i18n-prompt');
const { withCron, shouldRunCron } = require('./lib/cron-helper');
const { getUserNotifContext } = require('./lib/cron-user-context');
const { resolveAnchor } = require('./lib/user-anchor');
const { assertLoggableDate, sendLogGuardError } = require('./lib/log-guard');

// Image-hash cache — same photo bytes ⇒ same response. Kills the "10 different
// answers for the same glass" bug at the root. 30-min TTL, capped 200 entries.
const _photoCache = new Map();
function _photoCacheKey(deviceId, b64) {
  return `${deviceId}:${hashImages(null, [b64])}`;
}
function _photoCacheGet(key) {
  const v = _photoCache.get(key);
  if (!v) return null;
  if (Date.now() - v.t > 30 * 60 * 1000) { _photoCache.delete(key); return null; }
  return v.data;
}
function _photoCacheSet(key, data) {
  _photoCache.set(key, { t: Date.now(), data });
  if (_photoCache.size > 200) _photoCache.delete(_photoCache.keys().next().value);
}

// ─── Context cache (5-min TTL, invalidated on write) ─────────
const _ctxCache = new Map();
const CTX_TTL   = 5 * 60 * 1000;

// ─── Calibration cache (5-min TTL, invalidated on POST /calibration) ──
// Personal calibration is read on EVERY photo log; the underlying Firestore
// query (orderBy + limit) costs ~150ms each time. Calibration only changes
// when the user explicitly corrects a log, so we can safely memoize for 5
// minutes. Wired into _calCacheBust() which runs on calibration writes.
const _calCache = new Map();
const CAL_TTL   = 5 * 60 * 1000;
function _calCacheGet(deviceId) {
  const v = _calCache.get(deviceId);
  if (!v) return null;
  if (Date.now() - v.t > CAL_TTL) { _calCache.delete(deviceId); return null; }
  return v.data;
}
function _calCacheSet(deviceId, data) {
  _calCache.set(deviceId, { t: Date.now(), data });
  if (_calCache.size > 500) _calCache.delete(_calCache.keys().next().value);
}
function _calCacheBust(deviceId) { _calCache.delete(deviceId); }

// ─── Chat rate limiter (20 req / 60s per device) ─────────────
const _rateMap = new Map();
function checkChatRate(deviceId) {
  const now   = Date.now();
  const entry = _rateMap.get(deviceId);
  if (!entry || now - entry.t > 60_000) { _rateMap.set(deviceId, { t: now, n: 1 }); return true; }
  if (entry.n >= 20) return false;
  entry.n += 1;
  return true;
}

async function getCachedContext(deviceId) {
  const cached = _ctxCache.get(deviceId);
  if (cached && Date.now() - cached.builtAt < CTX_TTL) return cached.context;
  const context = await buildWaterContext(deviceId);
  _ctxCache.set(deviceId, { context, builtAt: Date.now() });
  return context;
}

function invalidateCtx(deviceId) {
  _ctxCache.delete(deviceId);
}

// ─── Firestore paths ──────────────────────────────────────────
const userDoc    = (id) => db().collection('wellness_users').doc(id);
const waterDoc   = (id) => userDoc(id).collection('agents').doc('water');
const logsCol    = (id) => waterDoc(id).collection('water_logs');
const chatsCol   = (id) => waterDoc(id).collection('water_chats');
const actionsCol = (id) => waterDoc(id).collection('water_actions');

// ════════════════════════════════════════════════════════════════
// ACTIONS v2 — shared engine
// ════════════════════════════════════════════════════════════════
const { mountActionRoutes, gradeActions: _gradeActionsShared } = require('./lib/actions-engine');
const { computeWaterCandidates, waterGraders } = require('./lib/candidates/water');
const { assertNoCrossAgent } = require('./lib/sandbox');
const { computeWaterScore: _computeWaterScore } = require('./lib/agent-scores');
// Cross-agent reads are handled by wellness.cross.js — water.agent.js never reads sibling agents.
assertNoCrossAgent('water', computeWaterCandidates);
const _v2Hooks = mountActionRoutes(router, {
  agentName: 'water',
  agentDocRef: waterDoc,
  actionsCol, logsCol,
  computeCandidates: computeWaterCandidates,
  graders: waterGraders,
  openai, admin, db,
  // Cross-agent rule: water.agent.js MUST NOT read sibling agents directly.
  // Instead it reads from `cross_agent/today_signals`, which is written by
  // wellness.cross.js (the only place allowed to read across all 6 agents).
  crossAgentEnricher: async (deviceId) => {
    try {
      const xSnap = await userDoc(deviceId).collection('cross_agent').doc('today_signals').get();
      if (!xSnap.exists) return '';
      const x = xSnap.data() || {};
      const parts = [];
      if (x.water_target_bonus_ml > 0 && x.water_target_bonus_reason) {
        parts.push(`Cross-signal: ${x.water_target_bonus_reason} → +${x.water_target_bonus_ml}ml today.`);
      }
      return parts.join(' ');
    } catch {
      return '';
    }
  },
});
function _onWaterLog(deviceId) {
  waterDoc(deviceId).update({
    log_count_since_last_batch: admin.firestore.FieldValue.increment(1),
  }).catch(() => {});
  _v2Hooks.queueGeneration(deviceId);
  _gradeActionsShared({
    agentName: 'water', deviceId, actionsCol, logsCol,
    graders: waterGraders, admin, db,
  }).catch(() => {});
  try {
    const cross = require('./wellness.cross');
    cross.invalidateWellnessCache?.(deviceId);
    cross.recomputeTodaySignals?.(deviceId).catch(() => {});
  } catch {}
}
// ════════════════════════════════════════════════════════════════

// ─── Helpers ──────────────────────────────────────────────────
const DAY_PARTS = ['morning', 'midday', 'afternoon', 'evening', 'night'];
const STREAK_MILESTONES = [3, 7, 14, 30];
const MAX_PROACTIVES_PER_DAY = 2;

const dateStr = (d = new Date()) => {
  const y  = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${dd}`;
};

const mapDoc = (doc) => ({ id: doc.id, ...doc.data() });

const getMillis = (value) => {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
};

const toIso = (value) => {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

const avg = (nums = []) => nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : 0;

const round = (n, dp = 0) => {
  const factor = Math.pow(10, dp);
  return Math.round((n || 0) * factor) / factor;
};

const sortByTimestampField = (items, field, direction = 'desc') =>
  [...items].sort((a, b) => {
    const delta = getMillis(a[field]) - getMillis(b[field]);
    return direction === 'asc' ? delta : -delta;
  });

const minsToLabel = (mins) => {
  const h24  = Math.floor(mins / 60) % 24;
  const min  = mins % 60;
  const ampm = h24 >= 12 ? 'pm' : 'am';
  const h12  = h24 % 12 || 12;
  return `${h12}:${String(min).padStart(2, '0')} ${ampm}`;
};

const getDayPart = (hour = 12) => {
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 15) return 'midday';
  if (hour >= 15 && hour < 19) return 'afternoon';
  if (hour >= 19 && hour < 24) return 'evening';
  return 'night';
};

const emptyDay = () => ({
  total_ml: 0,
  effective_ml: 0,
  log_count: 0,
  late_ml: 0,
  water_friendly_ml: 0,
  beverages: {},
  parts: DAY_PARTS.reduce((acc, key) => ({ ...acc, [key]: 0 }), {}),
});

// ─── IOM goal calculator ──────────────────────────────────────
function calcDailyGoal(setup) {
  const weight   = parseFloat(setup.weight_kg) || 70;
  const activity = setup.activity_level || 'moderate';
  const climate  = setup.climate || 'temperate';

  let base = weight * 33;

  const activityBonus = {
    sedentary: 0,
    light: 150,
    moderate: 350,
    active: 600,
    athlete: 900,
  };

  const climateBonus = {
    cool: 0,
    temperate: 0,
    mild: 0,
    hot: 300,
    humid: 400,
    very_hot: 500,
  };

  const pregnancyBonus = {
    no: 0,
    pregnant: 300,
    breastfeeding: 700,
  };

  base += activityBonus[activity] ?? 350;
  base += climateBonus[climate] ?? 0;
  base += pregnancyBonus[setup.pregnancy] ?? 0;

  return Math.round(base / 50) * 50;
}

function sanitizeGoalMl(raw, fallback = null) {
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) return fallback;
  return clamp(Math.round(parsed / 50) * 50, 1500, 6000);
}

function normalizeDateKey(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (typeof value.toDate === 'function') return dateStr(value.toDate());
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : dateStr(parsed);
}

function getGoalState(setup = {}) {
  const recommendedGoalMl = sanitizeGoalMl(setup.recommended_goal_ml, calcDailyGoal(setup));
  const manualGoalMl      = sanitizeGoalMl(setup.manual_goal_ml, null);
  const storedGoalMl      = sanitizeGoalMl(setup.daily_goal_ml, null);
  const goalMl            = manualGoalMl || storedGoalMl || recommendedGoalMl;
  const goalSource        = manualGoalMl ? 'manual' : 'recommended';

  return {
    goalMl,
    recommendedGoalMl,
    manualGoalMl,
    goalSource,
  };
}

function getGoalHistory(setup = {}, anchorDate = null) {
  const goalState = getGoalState(setup);
  const baseDate = normalizeDateKey(anchorDate, dateStr());
  const rawHistory = Array.isArray(setup.goal_history) && setup.goal_history.length
    ? setup.goal_history
    : [{
      effective_from: baseDate,
      goal_ml: goalState.goalMl,
      source: goalState.goalSource,
    }];

  const normalized = rawHistory
    .map(entry => {
      const effectiveFrom = normalizeDateKey(entry.effective_from, null);
      const goalMl = sanitizeGoalMl(entry.goal_ml, null);
      if (!effectiveFrom || !goalMl) return null;
      return {
        effective_from: effectiveFrom,
        goal_ml: goalMl,
        source: entry.source === 'manual' ? 'manual' : 'recommended',
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.effective_from.localeCompare(b.effective_from));

  if (!normalized.length) {
    return [{
      effective_from: baseDate,
      goal_ml: goalState.goalMl,
      source: goalState.goalSource,
    }];
  }

  const deduped = [];
  normalized.forEach(entry => {
    const last = deduped[deduped.length - 1];
    if (last && last.effective_from === entry.effective_from) {
      deduped[deduped.length - 1] = entry;
      return;
    }
    deduped.push(entry);
  });

  return deduped;
}

function resolveGoalForDate(goalHistory = [], ds, fallbackGoalMl = 2500) {
  if (!ds) return fallbackGoalMl;
  let active = sanitizeGoalMl(fallbackGoalMl, 2500);
  for (const entry of goalHistory) {
    if (entry.effective_from <= ds) active = entry.goal_ml;
    else break;
  }
  return active;
}

function buildGoalMap(rangeKeys = [], goalHistory = [], fallbackGoalMl = 2500) {
  return rangeKeys.reduce((acc, key) => {
    acc[key] = resolveGoalForDate(goalHistory, key, fallbackGoalMl);
    return acc;
  }, {});
}

function buildGoalHistorySummary(goalHistory = [], rangeKeys = [], fallbackGoalMl = 2500) {
  if (!goalHistory.length) return { changes: [], latest_change: null, avg_goal_ml: fallbackGoalMl };

  const rangeStart = rangeKeys[0] || goalHistory[0].effective_from;
  const rangeEnd = rangeKeys[rangeKeys.length - 1] || goalHistory[goalHistory.length - 1].effective_from;
  const changes = [];

  goalHistory.forEach((entry, index) => {
    const previous = goalHistory[index - 1] || null;
    if (entry.effective_from < rangeStart || entry.effective_from > rangeEnd) return;
    if (!previous) return;
    changes.push({
      effective_from: entry.effective_from,
      from_goal_ml: previous.goal_ml,
      to_goal_ml: entry.goal_ml,
      source: entry.source,
    });
  });

  const goalMap = buildGoalMap(rangeKeys, goalHistory, fallbackGoalMl);
  const avgGoalMl = rangeKeys.length
    ? Math.round(avg(rangeKeys.map(key => goalMap[key] || fallbackGoalMl)))
    : fallbackGoalMl;

  return {
    changes,
    latest_change: changes[changes.length - 1] || null,
    avg_goal_ml: avgGoalMl,
  };
}

function upsertGoalHistoryEntry(goalHistory = [], entry) {
  const normalizedEntry = {
    effective_from: normalizeDateKey(entry.effective_from, dateStr()),
    goal_ml: sanitizeGoalMl(entry.goal_ml, 2500),
    source: entry.source === 'manual' ? 'manual' : 'recommended',
  };

  const next = goalHistory
    .filter(item => item.effective_from !== normalizedEntry.effective_from)
    .concat(normalizedEntry)
    .sort((a, b) => a.effective_from.localeCompare(b.effective_from));

  return next.filter((item, index) => {
    const previous = next[index - 1];
    if (!previous) return true;
    return !(previous.goal_ml === item.goal_ml && previous.source === item.source);
  });
}

// ─── Action card colors ───────────────────────────────────────
const CBLUE   = '#38BDF8';
const CTEAL   = '#22D3EE';
const CPURPLE = '#C084FC';
const CGREEN  = '#34D399';
const CORANGE = '#F59E0B';
const CWARN   = '#F59E0B';

// ─── Hydration multipliers ────────────────────────────────────
const BEV_MULT = {
  water:   1.0,
  herbal:  1.0,
  milk:    0.9,
  juice:   0.85,
  coffee:  0.8,
  tea:     0.8,
  soda:    0.7,
  alcohol: 0.4,
};

const BEV_META = {
  water:   { label: 'Water',   quality: 'good'  },
  herbal:  { label: 'Herbal',  quality: 'good'  },
  milk:    { label: 'Milk',    quality: 'good'  },
  juice:   { label: 'Juice',   quality: 'mixed' },
  coffee:  { label: 'Coffee',  quality: 'mixed' },
  tea:     { label: 'Tea',     quality: 'mixed' },
  soda:    { label: 'Soda',    quality: 'low'   },
  alcohol: { label: 'Alcohol', quality: 'low'   },
};

// ─── Smart schedule builder ───────────────────────────────────
function buildSchedule(wakeMin, bedMin, goalMl) {
  const awake    = Math.max(480, bedMin - wakeMin);
  const interval = Math.floor(awake / 8);
  const blocks   = [];

  for (let i = 0; i < 8; i++) {
    const startMin = wakeMin + i * interval;
    const ml       = i === 0 ? 500 : Math.round(goalMl / 8);

    blocks.push({
      startMin,
      label: minsToLabel(startMin),
      ml,
      note: i === 0
        ? 'Morning cortisol window — front-load before caffeine.'
        : i === 7
        ? 'Last intake — taper 2h before bed.'
        : '',
    });
  }

  return blocks;
}

// ─── Log aggregation ──────────────────────────────────────────
function aggregateLogs(setup, logs = []) {
  const byDate         = {};
  const beverageTotals = {};
  const cutoffLateMin  = (setup.bed_time_min ?? 1320) - 120;

  for (const log of logs) {
    const loggedAtDate = typeof log.logged_at?.toDate === 'function'
      ? log.logged_at.toDate()
      : log.logged_at
      ? new Date(log.logged_at)
      : new Date(`${log.date || dateStr()}T12:00:00`);

    const key          = log.date || dateStr(loggedAtDate);
    const beverageType = log.beverage_type || 'water';
    const multiplier   = BEV_MULT[beverageType] || 1;
    const ml           = parseFloat(log.ml) || 0;
    const effectiveMl  = log.effective_ml || Math.round(ml * multiplier);
    const mins         = loggedAtDate.getHours() * 60 + loggedAtDate.getMinutes();
    const part         = getDayPart(loggedAtDate.getHours());

    if (!byDate[key]) byDate[key] = emptyDay();

    byDate[key].total_ml          += ml;
    byDate[key].effective_ml      += effectiveMl;
    byDate[key].log_count         += 1;
    byDate[key].parts[part]       += effectiveMl;
    byDate[key].beverages[beverageType] = (byDate[key].beverages[beverageType] || 0) + effectiveMl;
    beverageTotals[beverageType]   = (beverageTotals[beverageType] || 0) + effectiveMl;

    if (['water', 'herbal', 'milk'].includes(beverageType)) {
      byDate[key].water_friendly_ml += effectiveMl;
    } else if (beverageType === 'juice') {
      byDate[key].water_friendly_ml += Math.round(effectiveMl * 0.5);
    }

    if (mins >= cutoffLateMin && mins <= 23 * 60 + 59) {
      byDate[key].late_ml += effectiveMl;
    }
  }

  return { byDate, beverageTotals };
}

function buildDateRangeKeys(rangeDays) {
  const keys = [];
  for (let i = rangeDays - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    keys.push(dateStr(d));
  }
  return keys;
}

function computeStreakFromOffset(byDate, goalForDate, daysBack = 0) {
  let streak = 0;
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  while (true) {
    const key = dateStr(d);
    if ((byDate[key]?.effective_ml || 0) >= Math.max(goalForDate(key), 1)) {
      streak++;
      d.setDate(d.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

function computeCurrentStreak(byDate, goalForDate) {
  return computeStreakFromOffset(byDate, goalForDate, 0);
}

function computeLongestStreak(byDate, goalForDate) {
  const dates = Object.keys(byDate).sort();
  if (!dates.length) return 0;

  let longest = 0;
  let current = 0;
  let prevDate = null;

  for (const ds of dates) {
    if ((byDate[ds]?.effective_ml || 0) < Math.max(goalForDate(ds), 1)) {
      current = 0;
      prevDate = null;
      continue;
    }

    const curDate = new Date(`${ds}T12:00:00`);
    if (prevDate) {
      const diffDays = Math.round((curDate.getTime() - prevDate.getTime()) / 86400000);
      current = diffDays === 1 ? current + 1 : 1;
    } else {
      current = 1;
    }
    longest = Math.max(longest, current);
    prevDate = curDate;
  }

  return longest;
}

function computeHydrationScore(byDate, goalByDate) {
  const recentKeys = buildDateRangeKeys(7);

  // Gate 1: Hydration Adequacy (35%) — EFSA 2010, Gandy 2015
  const hydrationAdequacy = Math.round(avg(recentKeys.map(key =>
    clamp(((byDate[key]?.effective_ml || 0) / Math.max(goalByDate[key] || 2500, 1)) * 100, 0, 100)
  )));

  // Gate 2: Consistency (25%) — Lally 2010, Popkin 2010
  const consistency = Math.round(
    (recentKeys.filter(key => (byDate[key]?.effective_ml || 0) >= (goalByDate[key] || 2500) * 0.8).length / recentKeys.length) * 100
  );

  // Gate 3: Chronobiology (25%) — Sawka 2007 ACSM + Shirreffs 2000
  // 60% weight on morning front-load (highest-leverage window)
  // 40% weight on late-day taper (ADH rhythm protection)
  const frontLoadPct = Math.round(
    (recentKeys.filter(key => (byDate[key]?.parts?.morning || 0) >= Math.max(300, (goalByDate[key] || 2500) * 0.22)).length / recentKeys.length) * 100
  );
  const lateTaperPct = Math.round(
    (recentKeys.filter(key => (byDate[key]?.late_ml || 0) <= 250).length / recentKeys.length) * 100
  );
  const chronobiology = Math.round(frontLoadPct * 0.60 + lateTaperPct * 0.40);

  // Gate 4: Beverage Quality (15%) — Maughan 2016 BHI
  const beverageQuality = Math.round(avg(recentKeys.map(key => {
    const day = byDate[key] || emptyDay();
    if (!day.effective_ml) return 60;
    return clamp((day.water_friendly_ml / day.effective_ml) * 100, 0, 100);
  })));

  const avg7dMl = Math.round(avg(recentKeys.map(key => byDate[key]?.effective_ml || 0)));
  const daysLogged = Object.keys(byDate).filter(k => (byDate[k]?.log_count || 0) > 0).length;

  return _computeWaterScore({
    hydration_adequacy: hydrationAdequacy,
    consistency,
    chronobiology,
    beverage_quality: beverageQuality,
    avg_7d_ml: avg7dMl,
    days_logged: daysLogged,
  }) || {
    score: 0, label: 'Starting',
    components: { hydration_adequacy: hydrationAdequacy, consistency, chronobiology, beverage_quality: beverageQuality },
  };
}

function determineStage(daysLogged) {
  if (!daysLogged) return 0;
  if (daysLogged < 4) return 1;
  if (daysLogged < 10) return 2;
  return 3;
}

function buildDayPartBreakdown(byDate, rangeKeys, goalByDate) {
  const totals = DAY_PARTS.reduce((acc, key) => ({ ...acc, [key]: 0 }), {});

  for (const key of rangeKeys) {
    const day = byDate[key];
    if (!day) continue;
    for (const part of DAY_PARTS) totals[part] += day.parts[part] || 0;
  }

  const divisor = Math.max(1, rangeKeys.length);
  const avgGoalMl = Math.max(1, Math.round(avg(rangeKeys.map(key => goalByDate[key] || 2500))));

  return [
    { key: 'morning',   label: 'Morning',   ml: Math.round(totals.morning / divisor),   pct: Math.round(clamp((totals.morning / divisor)   / avgGoalMl * 100, 0, 100)) },
    { key: 'midday',    label: 'Midday',    ml: Math.round(totals.midday / divisor),    pct: Math.round(clamp((totals.midday / divisor)    / avgGoalMl * 100, 0, 100)) },
    { key: 'afternoon', label: 'Afternoon', ml: Math.round(totals.afternoon / divisor), pct: Math.round(clamp((totals.afternoon / divisor) / avgGoalMl * 100, 0, 100)) },
    { key: 'evening',   label: 'Evening',   ml: Math.round(totals.evening / divisor),   pct: Math.round(clamp((totals.evening / divisor)   / avgGoalMl * 100, 0, 100)) },
  ];
}

function buildBeverageMix(beverageTotals) {
  const total = Object.values(beverageTotals).reduce((s, n) => s + n, 0);
  if (!total) return [];

  return Object.entries(beverageTotals)
    .map(([key, ml]) => ({
      key,
      label: BEV_META[key]?.label || key,
      ml: Math.round(ml),
      pct: Math.round((ml / total) * 100),
      quality: BEV_META[key]?.quality || 'mixed',
    }))
    .sort((a, b) => b.ml - a.ml)
    .slice(0, 6);
}

function buildObservations({ goalMl, avg7d, streak, longestStreak, recentKeys, byDate, goalByDate, hydrationScore, goalHistorySummary }) {
  const observations = [];
  const avgRecentGoal = Math.max(1, Math.round(avg(recentKeys.map(key => goalByDate[key] || goalMl))));
  const goalRatio    = avg7d / Math.max(avgRecentGoal, 1);
  const lateDays     = recentKeys.filter(key => (byDate[key]?.late_ml || 0) > 250).length;
  const frontLoadDays = recentKeys.filter(key => (byDate[key]?.parts?.morning || 0) >= Math.max(300, (goalByDate[key] || goalMl) * 0.22)).length;
  const zeroDays     = recentKeys.filter(key => (byDate[key]?.effective_ml || 0) < 150).length;

  if (goalHistorySummary?.latest_change) {
    observations.push({
      title: 'Your target changed and the analysis knows it',
      body: `Your goal shifted from ${goalHistorySummary.latest_change.from_goal_ml} ml to ${goalHistorySummary.latest_change.to_goal_ml} ml on ${goalHistorySummary.latest_change.effective_from}. Earlier days keep the old target, and newer days are scored against the new one.`,
    });
  }

  if (goalRatio >= 0.9) {
    observations.push({
      title: 'You are close to automatic',
      body: `Your 7-day average is ${Math.round(goalRatio * 100)}% of the target active on those days. The biggest opportunity now is preserving timing quality, not just drinking more.`,
    });
  } else if (goalRatio >= 0.7) {
    observations.push({
      title: 'Consistency is the lever',
      body: `You are averaging ${Math.round(goalRatio * 100)}% of the target active on those days. A single repeatable anchor habit would close most of the gap.`,
    });
  } else {
    observations.push({
      title: 'You are under-drinking on the calendar, not just the clock',
      body: `Your 7-day average is only ${Math.round(goalRatio * 100)}% of the target active on those days, so the fix is more daily starts and fewer zero-intake days.`,
    });
  }

  if (frontLoadDays <= 2) {
    observations.push({
      title: 'Morning hydration is too light',
      body: 'You are not front-loading enough water early in the day. That usually leads to aggressive catch-up later.',
    });
  }

  if (lateDays >= 3) {
    observations.push({
      title: 'Late drinking is still leaking into the evening',
      body: `${lateDays} of the last 7 days had meaningful late intake. Tapering earlier will make hydration easier on sleep.`,
    });
  }

  if (zeroDays >= 2) {
    observations.push({
      title: 'Missed days are crushing your score',
      body: `${zeroDays} of the last 7 days were almost empty. Your score improves faster by removing misses than by over-optimising good days.`,
    });
  }

  if (streak >= 3 || longestStreak >= 5) {
    observations.push({
      title: 'You already have proof you can sustain this',
      body: `Your current streak is ${streak} and your best run is ${longestStreak}. The job is to protect the pattern, not reinvent it.`,
    });
  }

  return observations.slice(0, hydrationScore.score >= 70 ? 4 : 3);
}

function buildPatternInsights({ byDate, rangeKeys, goalByDate, goalMl }) {
  const insights = [];
  const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  // Best day of week
  const dayTotals = [0, 0, 0, 0, 0, 0, 0];
  const dayCounts = [0, 0, 0, 0, 0, 0, 0];
  for (const key of rangeKeys) {
    if (!(byDate[key]?.log_count > 0)) continue;
    const dow = new Date(`${key}T12:00:00`).getDay();
    dayTotals[dow] += byDate[key].effective_ml || 0;
    dayCounts[dow]++;
  }
  const dayAvgs = dayTotals.map((t, i) => (dayCounts[i] >= 2 ? Math.round(t / dayCounts[i]) : 0));
  const maxAvg = Math.max(...dayAvgs);
  const bestDow = dayAvgs.indexOf(maxAvg);
  if (maxAvg > 0 && dayCounts[bestDow] >= 2) {
    const bestGoal = Math.round(avg(rangeKeys.filter(k => new Date(`${k}T12:00:00`).getDay() === bestDow).map(k => goalByDate[k] || goalMl)));
    const pct = Math.round((maxAvg / Math.max(bestGoal, 1)) * 100);
    insights.push({
      type: 'best_day',
      title: `${DAY_NAMES[bestDow]}s are your strongest`,
      body: `You average ${maxAvg} ml on ${DAY_NAMES[bestDow]}s (${pct}% of goal) — highest of any weekday. What's different on those days?`,
    });
  }

  // Goal hit rate trend: recent 7 vs previous 7
  const recent7 = buildDateRangeKeys(7);
  const all14   = buildDateRangeKeys(14);
  const prev7   = all14.slice(0, 7);
  const recentHits = recent7.filter(k => (byDate[k]?.effective_ml || 0) >= (goalByDate[k] || goalMl)).length;
  const prevHits   = prev7.filter(k => (byDate[k]?.effective_ml || 0) >= (goalByDate[k] || goalMl)).length;
  if (recentHits > prevHits + 1) {
    insights.push({
      type: 'trend_up',
      title: 'Goal hit rate is climbing',
      body: `${recentHits}/7 days this week vs ${prevHits}/7 last week. You are building real momentum — protect the streak.`,
    });
  } else if (recentHits < prevHits - 1 && prevHits > 0) {
    insights.push({
      type: 'trend_down',
      title: 'Goal hit rate slipped this week',
      body: `${recentHits}/7 days this week vs ${prevHits}/7 last week. A brief focus reset gets you back on track.`,
    });
  }

  // Morning consistency
  const morningDays = recent7.filter(k => (byDate[k]?.parts?.morning || 0) >= Math.max(300, (goalByDate[k] || goalMl) * 0.22)).length;
  if (morningDays >= 5) {
    insights.push({
      type: 'morning_strong',
      title: 'Consistent morning front-loader',
      body: `${morningDays}/7 mornings with strong early hydration. You are building the highest-leverage chronobiology habit — Sawka 2007.`,
    });
  } else if (morningDays <= 2) {
    insights.push({
      type: 'morning_opportunity',
      title: 'Morning front-load opportunity',
      body: `Only ${morningDays}/7 mornings with early hydration. 400 ml within 45 min of waking is the single highest-leverage window for the day.`,
    });
  }

  return insights.slice(0, 3);
}

async function buildCrossAgentInsights(deviceId, byDate, goalMl, goalByDate, rangeKeys, streak) {
  const insights = [];

  // Cross-agent rule: water never reads sibling-agent collections directly.
  // wellness.cross.js writes pre-computed correlations into cross_agent/today_signals.
  try {
    const xSnap = await userDoc(deviceId).collection('cross_agent').doc('today_signals').get();
    const x = xSnap.exists ? (xSnap.data() || {}) : {};

    // Sleep correlation — wellness.cross writes water_sleep_correlation: { good_avg_ml, low_avg_ml, good_avg_goal_ml, sample_size }
    const sc = x.water_sleep_correlation;
    if (sc && sc.sample_size >= 5 && Math.abs((sc.good_avg_ml || 0) - (sc.low_avg_ml || 0)) >= 250) {
      const better = sc.good_avg_ml > sc.low_avg_ml ? 'better' : 'worse';
      insights.push({
        type: 'sleep',
        emoji: '🌙',
        title: 'SLEEP CORRELATION',
        body: `On higher-quality sleep days, your average water intake is ${sc.good_avg_ml} ml versus ${sc.low_avg_ml} ml on lower-sleep days. Hydration appears ${better} when your recovery is better.`,
        stat: `${Math.round(sc.good_avg_ml / Math.max(sc.good_avg_goal_ml || goalMl, 1) * 100)}% of goal on good-sleep days`,
      });
    }

    // Mind correlation — wellness.cross writes water_mind_correlation: { anxious_avg_ml, anxious_avg_goal_ml, sample_size }
    const mc = x.water_mind_correlation;
    if (mc && mc.sample_size >= 3) {
      insights.push({
        type: 'mind',
        emoji: '🧠',
        title: 'MOOD LINK',
        body: `On high-anxiety check-in days, your average intake is ${mc.anxious_avg_ml} ml. Thirst and agitation often stack together, so earlier hydration matters more than catch-up later.`,
        stat: `${Math.round(mc.anxious_avg_ml / Math.max(mc.anxious_avg_goal_ml || goalMl, 1) * 100)}% of goal on high-anxiety days`,
      });
    }
  } catch { /* non-fatal — degrade gracefully when signals missing */ }

  // Hunger / thirst confusion
  const lowWaterDays = rangeKeys.filter(key => (byDate[key]?.effective_ml || 0) < (goalByDate[key] || goalMl) * 0.7).length;
  if (lowWaterDays >= 4) {
    insights.push({
      type: 'hunger',
      emoji: '🍽️',
      title: 'HUNGER VS THIRST',
      body: `You had ${lowWaterDays} under-hydrated days in this window. A pre-meal 250 ml habit is the simplest way to stop thirst being misread as hunger.`,
      stat: null,
    });
  }

  if (streak >= 3) {
    insights.push({
      type: 'streak',
      emoji: '🔥',
      title: 'HYDRATION STREAK',
      body: `You have hit goal ${streak} days in a row. That is enough momentum to start protecting timing quality, not just total volume.`,
      stat: `${streak}-day streak`,
    });
  }

  return insights.slice(0, 4);
}

function fallbackAnalysisInsight(stats, hydrationScore) {
  if ((stats.avg_7d || 0) < stats.goal_ml * 0.75) {
    return {
      insight: `Your hydration score is ${hydrationScore.score}, and the clearest pattern is under-drinking across the week rather than one bad day. The fastest improvement is anchoring one repeatable early-day drink and removing zero-intake days.`,
      formula: 'Protect the morning, hit 80% by late afternoon, taper before bed.',
    };
  }

  if ((stats.late_cutoff_days || 0) >= 3) {
    return {
      insight: `You are getting closer to goal, but too much of it is landing late. That usually means you are chasing volume in the evening instead of pacing it through the day.`,
      formula: 'Front-load the first 500 ml, spread the middle, stop forcing catch-up at night.',
    };
  }

  return {
    insight: `Your hydration score is ${hydrationScore.score}, which means the foundation is there. The next level is cleaner timing: earlier intake, steadier pacing, and fewer reactive catch-up drinks.`,
    formula: 'Drink earlier than feels necessary, not later than feels urgent.',
  };
}

function normaliseMessageText(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s%]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildMessageKey(text = '') {
  return normaliseMessageText(text)
    .replace(/\b\d+\b/g, '#')
    .trim();
}

function dedupeProactiveList(messages = []) {
  const seen = new Set();
  const latestFirst = [...messages].sort((a, b) => getMillis(b.created_at) - getMillis(a.created_at));

  const kept = latestFirst.filter(message => {
    const key = `${message.date_str || dateStr(new Date(message.created_at || Date.now()))}|${message.proactive_type || 'check_in'}|${message.content_key || buildMessageKey(message.content || '')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return kept.sort((a, b) => getMillis(b.created_at) - getMillis(a.created_at));
}

function shouldSkipProactiveMessage({ recentMessages = [], proactiveType, content, today }) {
  const contentKey = buildMessageKey(content);
  const nowMs = Date.now();

  for (const message of recentMessages) {
    const sentAt = getMillis(message.created_at);
    const hoursSince = sentAt ? (nowMs - sentAt) / 3600000 : 999;
    const sameDay = (message.date_str || dateStr(new Date(sentAt || nowMs))) === today;
    const sameType = (message.proactive_type || '') === proactiveType;
    const sameContent = (message.content_key || buildMessageKey(message.content || '')) === contentKey;

    if (!sameDay && hoursSince > 48) continue;
    if (sameType && sameDay) return true;
    if (sameContent && hoursSince < 36) return true;
    if (message.is_read === false && hoursSince < 4) return true;
  }

  return false;
}

async function generateAnalysisInsight(setup, stats, hydrationScore, crossAgentInsights, dayParts, beverageMix) {
  const fallback = fallbackAnalysisInsight(stats, hydrationScore);

  const dayPartSummary = (dayParts || []).map(p => `${p.label} ${p.ml}ml (${p.pct}%)`).join(', ') || 'no data';
  const beverageSummary = (beverageMix || []).slice(0, 4).map(b => `${b.label} ${b.pct}%`).join(', ') || 'mostly water';

  try {
    const prompt = [
      'You are a precision hydration analyst inside a premium wellness app.',
      'Return valid JSON only — no markdown, no code fences, no explanation outside the JSON.',
      'Keys: insight (string), formula (string).',
      'insight: exactly 2 sentences. Declarative, numbers-driven. Reference at least 2 specific metrics. Banned starters: "Your", "You", "The data", "Looking at", "Based on", "With". Good openers: state a raw number, a ratio, a streak, a gap, or a pattern change — e.g. "Front-loading hit X/7 days..." or "Consistency at X% masks..." or "The X ml/day average hides...". Banned words: "may", "might", "could", "seems", "appears", "perhaps", "generally", "usually".',
      'formula: one punchy action-line, specific to THIS user\'s pattern — not generic advice. Max 15 words.',
      '',
      `Goal: ${stats.goal_ml} ml/day`,
      `Range avg target: ${stats.avg_goal_ml || stats.goal_ml} ml`,
      `7-day average: ${stats.avg_7d} ml (${Math.round(((stats.avg_7d||0)/Math.max(stats.goal_ml,1))*100)}% of goal)`,
      `Best day: ${stats.best_day} ml`,
      `Days logged: ${stats.days_logged} | Goal days: ${stats.goal_days}`,
      `Current streak: ${stats.streak} | Longest: ${stats.longest_streak}`,
      `Front-load days (last 7): ${stats.frontload_days}/7`,
      `Late-cutoff misses (last 7): ${stats.late_cutoff_days}/7`,
      `Goal changes: ${stats.goal_changes || 'none'}`,
      `Hydration score: ${hydrationScore.score} (${hydrationScore.label})`,
      `Score → hydration adequacy ${hydrationScore.components?.hydration_adequacy}%, consistency ${hydrationScore.components?.consistency}%, chronobiology ${hydrationScore.components?.chronobiology}%, beverage quality ${hydrationScore.components?.beverage_quality}%`,
      `Day-part intake: ${dayPartSummary}`,
      `Beverage mix: ${beverageSummary}`,
      `Setup: ${setup.weight_kg || '?'}kg, ${setup.activity_level || 'moderate'} activity, ${setup.climate || 'mild'} climate`,
      `Cross-agent: ${crossAgentInsights.map(c => `${c.title}: ${c.stat || c.body.slice(0, 80)}`).join(' | ') || 'none'}`,
    ].join('\n');

    const completion = await openai.chat.completions.create({
      model: AI.CHAT_STREAM,
      max_completion_tokens: 220,
      messages: [{ role: 'system', content: prompt }],
    });

    const rawContent = completion.choices[0]?.message?.content?.trim() || '';
    const raw = rawContent.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const json = JSON.parse(raw);

    return {
      insight: typeof json.insight === 'string' && json.insight.trim() ? json.insight.trim() : fallback.insight,
      formula: typeof json.formula === 'string' && json.formula.trim() ? json.formula.trim() : fallback.formula,
    };
  } catch (err) {
    log.error('[water] generateAnalysisInsight:', err.message);
    return fallback;
  }
}

function makeAction({ text, why, when_to_do, tag, emoji, color, priority = 50 }) {
  return { text, why, when_to_do, tag, emoji, color, priority };
}

function uniqueActions(actions) {
  const seen = new Set();
  return actions.filter(action => {
    const key = action.text.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function applyActionNovelty(actions = [], { skipHistory = [], recentActionTexts = [] } = {}) {
  const skipSet = new Set(skipHistory.map(text => String(text).toLowerCase()));
  const recentSet = new Set(recentActionTexts.map(text => String(text).toLowerCase()));

  return actions.map(action => {
    const textKey = action.text.toLowerCase();
    let priority = action.priority || 50;

    if (skipSet.has(textKey)) priority -= 14;
    if (recentSet.has(textKey)) priority -= 8;
    if (['NOW', 'NEXT 90 MIN'].includes(action.when_to_do)) priority += 4;

    return { ...action, priority };
  });
}

function generateDailyActions({
  setup,
  byDate,
  beverageTotals,
  goalMl,
  goalByDate = {},
  todayKey,
  crossAgentInsights = [],
  skipHistory = [],
  recentActionTexts = [],
}) {
  const actions = [];
  const today   = byDate[todayKey] || emptyDay();
  const recentKeys = buildDateRangeKeys(7);
  const goalForDate = (ds) => goalByDate[ds] || goalMl;
  const avg7    = Math.round(avg(recentKeys.map(key => byDate[key]?.effective_ml || 0)));
  const avgRecentGoal = Math.round(avg(recentKeys.map(key => goalForDate(key))));
  const streak  = computeCurrentStreak(byDate, goalForDate);
  const wake    = setup.wake_time_min ?? 420;
  const bed     = setup.bed_time_min ?? 1380;
  const now     = new Date();
  const nowMin  = now.getHours() * 60 + now.getMinutes();
  const daySpan = Math.max(480, bed - wake);
  const expectedPct = clamp((nowMin - wake) / daySpan, 0, 1);
  const actualPct   = (today.effective_ml || 0) / Math.max(goalMl, 1);
  // Use 7-day beverage totals (not lifetime) to avoid stale triggers
  const recent7BevTotals = recentKeys.reduce((acc, key) => {
    const day = byDate[key];
    if (!day) return acc;
    Object.entries(day.beverages || {}).forEach(([bev, ml]) => {
      acc[bev] = (acc[bev] || 0) + ml;
    });
    return acc;
  }, {});
  const coffeeTea   = (recent7BevTotals.coffee || 0) + (recent7BevTotals.tea || 0);
  const sodaAlcohol = (recent7BevTotals.soda || 0) + (recent7BevTotals.alcohol || 0);
  const lateDays    = recentKeys.filter(key => (byDate[key]?.late_ml || 0) > 250).length;
  const frontLoadDays = recentKeys.filter(key => (byDate[key]?.parts?.morning || 0) >= Math.max(300, goalForDate(key) * 0.22)).length;
  const sleepInsight = crossAgentInsights.find(i => i.type === 'sleep');

  if (today.effective_ml === 0 && now.getHours() >= 11) {
    actions.push(makeAction({
      text: 'Drink 500 ml in the next 20 minutes',
      why: 'You have not logged any meaningful hydration yet today. Starting now is better than trying to rescue the day at night.',
      when_to_do: 'NOW',
      tag: 'CATCH-UP',
      emoji: '💧',
      color: CTEAL,
      priority: 95,
    }));
  }

  if (actualPct < expectedPct - 0.22 && nowMin > wake + 120 && nowMin < bed - 180) {
    const remaining = Math.max(200, Math.round((goalMl * expectedPct - today.effective_ml) / 50) * 50);
    actions.push(makeAction({
      text: `Close your pace gap with ${remaining} ml before the next 90 minutes`,
      why: `You are behind pace for the current time of day. Catching up earlier is easier on energy and sleep than back-loading water tonight.`,
      when_to_do: 'NEXT 90 MIN',
      tag: 'PACE',
      emoji: '⏱️',
      color: CBLUE,
      priority: 90,
    }));
  }

  if (frontLoadDays <= 2) {
    actions.push(makeAction({
      text: 'Anchor 500 ml within 30 minutes of waking',
      why: 'Your recent pattern shows weak morning hydration. One front-loaded drink makes the rest of the day easier and reduces evening catch-up.',
      when_to_do: 'MORNING',
      tag: 'MORNING',
      emoji: '🌅',
      color: CWARN,
      priority: 88,
    }));
  }

  if (coffeeTea >= goalMl * 0.2) {
    actions.push(makeAction({
      text: 'Pair every coffee or tea with 300 ml water',
      why: 'A noticeable share of your intake is caffeinated. Pairing it with water keeps the habit simple without asking you to remove drinks you enjoy.',
      when_to_do: 'WITH CAFFEINE',
      tag: 'CAFFEINE',
      emoji: '☕',
      color: CPURPLE,
      priority: 82,
    }));
  }

  if (lateDays >= 3) {
    actions.push(makeAction({
      text: 'Set a hard taper 2 hours before bed',
      why: 'Too much of your water is landing late. Earlier pacing will protect sleep and reduce reactive nighttime drinking.',
      when_to_do: 'EVENING',
      tag: 'TIMING',
      emoji: '🌙',
      color: CPURPLE,
      priority: 84,
    }));
  }

  if (['active', 'athlete'].includes(setup.activity_level) || avg7 < avgRecentGoal * 0.75) {
    actions.push(makeAction({
      text: 'Use meal anchors: 250 ml before breakfast, lunch, and dinner',
      why: 'When total intake is lagging, meal anchors are the cleanest way to raise baseline hydration without relying on memory.',
      when_to_do: 'MEALS',
      tag: 'ANCHOR',
      emoji: '🍽️',
      color: CGREEN,
      priority: 80,
    }));
  }

  if (sodaAlcohol > 0) {
    actions.push(makeAction({
      text: 'Match each soda or alcohol drink with water',
      why: 'Some recent intake is coming from low-hydration beverages. A simple 1:1 water rule protects the day without asking for perfection.',
      when_to_do: 'AS NEEDED',
      tag: 'BALANCE',
      emoji: '⚖️',
      color: CORANGE,
      priority: 76,
    }));
  }

  if (sleepInsight) {
    actions.push(makeAction({
      text: 'Front-load water earlier on days you want better sleep',
      why: 'Your data is showing a water-to-sleep link. The target is not more late-night water, but better daytime coverage.',
      when_to_do: 'DAYTIME',
      tag: 'SLEEP LINK',
      emoji: '🌙',
      color: CBLUE,
      priority: 78,
    }));
  }

  if (streak < 3) {
    actions.push(makeAction({
      text: 'Keep one bottle in sight all day',
      why: 'Your streak is still fragile. Visual cues beat motivation when you are trying to make hydration more automatic.',
      when_to_do: 'ALL DAY',
      tag: 'CUE',
      emoji: '🫙',
      color: CTEAL,
      priority: 72,
    }));
  }

  const defaults = [
    makeAction({
      text: 'Finish 80% of goal before dinner',
      why: 'This single rule keeps you from forcing hydration too late and makes the last part of the day easy.',
      when_to_do: 'DAY PLAN',
      tag: 'RULE',
      emoji: '📈',
      color: CBLUE,
      priority: 60,
    }),
    makeAction({
      text: 'Use the first drink as a momentum trigger',
      why: 'The first meaningful drink matters more than a perfect schedule. Once the day starts well, adherence rises fast.',
      when_to_do: 'START',
      tag: 'MOMENTUM',
      emoji: '⚡',
      color: CWARN,
      priority: 58,
    }),
  ];

  const ranked = applyActionNovelty(uniqueActions([...actions, ...defaults]), {
    skipHistory,
    recentActionTexts,
  }).sort((a, b) => b.priority - a.priority);

  const preferred = ranked.filter(action => action.priority >= 54).slice(0, 3);
  const all = (preferred.length >= 2 ? preferred : ranked).slice(0, 3);

  return all;
}

async function ensureTodayActions(deviceId, { force = false } = {}) {
  const today = dateStr();

  const [waterSnap, activeSnap, recentLogsSnap, recentActionsSnap] = await Promise.all([
    waterDoc(deviceId).get(),
    actionsCol(deviceId).where('status', '==', 'active').get(),
    logsCol(deviceId).orderBy('logged_at', 'desc').limit(300).get(),
    actionsCol(deviceId).orderBy('generated_at', 'desc').limit(12).get(),
  ]);

  const waterData     = waterSnap.data() || {};
  const setup         = waterData.setup || {};
  const activeActions = activeSnap.docs.map(mapDoc);
  const goalHistory   = getGoalHistory(setup, waterData.setup_completed_at);
  const goalForDate   = (ds) => resolveGoalForDate(goalHistory, ds, getGoalState(setup).goalMl);

  // Primary guard: already generated today (even if all actions are done/skipped)
  if (!force && waterData.last_action_gen_date === today) {
    return;
  }

  const goalMl = goalForDate(today);
  const logs   = recentLogsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const { byDate, beverageTotals } = aggregateLogs(setup, logs);
  const recentKeys = buildDateRangeKeys(14);
  const goalByDate = buildGoalMap(recentKeys, goalHistory, goalMl);
  const recentActionTexts = recentActionsSnap.docs
    .map(doc => doc.data()?.text)
    .filter(Boolean)
    .slice(0, 6);
  const crossAgentInsights = await buildCrossAgentInsights(
    deviceId,
    byDate,
    goalMl,
    goalByDate,
    recentKeys,
    computeCurrentStreak(byDate, goalForDate)
  );
  const newActions         = generateDailyActions({
    setup,
    byDate,
    beverageTotals,
    goalMl,
    goalByDate,
    todayKey: today,
    crossAgentInsights,
    skipHistory: waterData.skip_history || [],
    recentActionTexts,
  });
  const nextGenIndex       = (waterData.last_action_gen_index || 0) + 1;

  const batch = db().batch();

  activeSnap.docs.forEach(doc => {
    batch.update(doc.ref, { status: 'past' });
  });

  newActions.forEach(action => {
    const ref = actionsCol(deviceId).doc();
    batch.set(ref, {
      ...action,
      source: 'coach',
      status: 'active',
      date_str: today,
      gen_index: nextGenIndex,
      generated_at: admin.firestore.FieldValue.serverTimestamp(),
      completed_at: null,
    });
  });

  batch.set(waterDoc(deviceId), {
    last_action_gen_date: today,
    last_action_gen_index: nextGenIndex,
  }, { merge: true });

  await batch.commit();
}

// ─── Context builder ─────────────────────────────────────────
async function buildWaterContext(deviceId) {
  try {
    const [wRef, logsSnap, activeSnap, recentChatSnap] = await Promise.all([
      waterDoc(deviceId).get(),
      logsCol(deviceId).orderBy('logged_at', 'desc').limit(150).get(),
      actionsCol(deviceId).where('status', '==', 'active').get(),
      chatsCol(deviceId).orderBy('created_at', 'desc').limit(6).get(),
    ]);

    if (!wRef.exists) return 'No setup data found.';

    const waterData     = wRef.data() || {};
    const setup         = waterData.setup || {};
    const goalHistory   = getGoalHistory(setup, waterData.setup_completed_at);
    const goalForDate   = (ds) => resolveGoalForDate(goalHistory, ds, getGoalState(setup).goalMl);
    const goalToday     = goalForDate(dateStr());
    const goalSource    = getGoalState(setup).goalSource;
    const logs          = logsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const { byDate, beverageTotals } = aggregateLogs(setup, logs);
    const todayKey      = dateStr();
    const today         = byDate[todayKey] || emptyDay();
    const recentKeys    = buildDateRangeKeys(7);
    const avg7          = Math.round(avg(recentKeys.map(key => byDate[key]?.effective_ml || 0)));
    const streak        = computeCurrentStreak(byDate, goalForDate);
    const goalSummary   = buildGoalHistorySummary(goalHistory, buildDateRangeKeys(30), goalToday);
    const beverageMix   = buildBeverageMix(beverageTotals).slice(0, 3).map(item => `${item.label} ${item.pct}%`).join(', ') || 'mostly water';
    const activeActions = sortByTimestampField(activeSnap.docs.map(mapDoc), 'generated_at', 'asc')
      .slice(0, 3)
      .map(a => `- ${a.text} [${a.when_to_do || 'anytime'}]`)
      .join('\n') || '- none';

    // Current schedule window
    const wake   = setup.wake_time_min ?? 420;
    const bed    = setup.bed_time_min  ?? 1380;
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    const schedule = buildSchedule(wake, bed, goalToday);
    const awakeSpan = Math.max(480, bed - wake);
    const expectedPct = clamp((nowMin - wake) / awakeSpan, 0, 1);
    const paceGapMl = Math.round(today.effective_ml - goalToday * expectedPct);
    const nextBlock = schedule.find(b => b.startMin > nowMin);
    const scheduleNote = nextBlock
      ? `Next schedule block: ${nextBlock.label} (${nextBlock.ml} ml target). Pace gap: ${paceGapMl >= 0 ? '+' : ''}${paceGapMl} ml.`
      : `In the final taper window. Pace gap: ${paceGapMl >= 0 ? '+' : ''}${paceGapMl} ml.`;

    // Recent proactive messages sent to user (last 2)
    const recentProactives = recentChatSnap.docs
      .map(d => d.data())
      .filter(m => m.is_proactive && m.content)
      .slice(0, 2)
      .map(m => `[${m.proactive_type || 'check_in'} at ${toIso(m.created_at)?.slice(11,16) || '?'}]: ${m.content.slice(0, 100)}`)
      .join('\n');

    // Cross-agent rule: water never reads sleep_logs directly. Pull a pre-computed
    // recent-sleep summary from cross_agent/today_signals (written by wellness.cross.js).
    let sleepNote = '';
    try {
      const xSnap = await userDoc(deviceId).collection('cross_agent').doc('today_signals').get();
      const recent = xSnap.exists ? (xSnap.data() || {}).recent_sleep_summary : null;
      if (recent && recent.entries && recent.entries.length) {
        sleepNote = `Recent sleep quality (last ${recent.entries.length} nights): ${recent.entries.map(e => `${e.quality_score}/100 on ${e.date}`).join(', ')}.`;
      }
    } catch { /* non-fatal */ }

    const nowHour   = new Date().getHours();
    const nowMinute = new Date().getMinutes();
    const timeLabel = nowHour < 6 ? 'night' : nowHour < 12 ? 'morning' : nowHour < 17 ? 'afternoon' : nowHour < 21 ? 'evening' : 'night';
    const logs150   = await logsCol(deviceId).orderBy('logged_at', 'desc').limit(1).get();
    const lastLogDoc = logs150.docs[0];
    const lastLogMins = lastLogDoc
      ? Math.round((Date.now() - getMillis(lastLogDoc.data().logged_at)) / 60000)
      : null;
    const lastLogNote = lastLogMins === null
      ? 'No logs yet today.'
      : lastLogMins < 5 ? 'Last logged: just now.'
      : lastLogMins < 60 ? `Last logged: ${lastLogMins} min ago.`
      : `Last logged: ${Math.round(lastLogMins / 60)}h ago.`;

    return [
      `Current time: ${minsToLabel(nowHour * 60 + nowMinute)} (${timeLabel}).`,
      `Setup: ${setup.weight_kg || '?'}kg, ${setup.activity_level || 'moderate'} activity, ${setup.climate || 'mild'} climate, wake ${minsToLabel(wake)}, bed ${minsToLabel(bed)}.`,
      `Goal: ${goalToday} ml/day${goalSource === 'manual' ? ' (user-set custom target)' : ' (coach-calculated)'}.`,
      goalSummary.latest_change
        ? `Goal changed ${goalSummary.latest_change.from_goal_ml} -> ${goalSummary.latest_change.to_goal_ml} ml on ${goalSummary.latest_change.effective_from}.`
        : '',
      `Today: ${today.effective_ml} ml logged (${Math.round(today.effective_ml / Math.max(goalToday, 1) * 100)}% of goal), ${today.log_count} entries. Morning: ${today.parts.morning || 0} ml | Afternoon: ${today.parts.afternoon || 0} ml | Evening: ${today.parts.evening || 0} ml. Late intake: ${today.late_ml || 0} ml.`,
      lastLogNote,
      scheduleNote,
      `7-day average: ${avg7} ml/day. Current streak: ${streak} days.`,
      `Beverage mix: ${beverageMix}.`,
      sleepNote,
      recentProactives ? `Recent coach notifications:\n${recentProactives}` : '',
      'Active coach priorities:',
      activeActions,
    ].filter(Boolean).join('\n');
  } catch (e) {
    log.error('[water] buildWaterContext:', e);
    return 'Context unavailable.';
  }
}

// ─── POST /setup ──────────────────────────────────────────────
router.post('/setup', async (req, res) => {
  try {
    const { deviceId, utc_offset_minutes, ...setupFields } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const goal  = calcDailyGoal(setupFields);
    const setup = {
      ...setupFields,
      recommended_goal_ml: goal,
      manual_goal_ml: null,
      daily_goal_ml: goal,
      goal_source: 'recommended',
      goal_history: [{
        effective_from: dateStr(),
        goal_ml: goal,
        source: 'recommended',
      }],
    };

    await waterDoc(deviceId).set({
      setup,
      setup_completed: true,
      setup_completed_at: admin.firestore.FieldValue.serverTimestamp(),
      utc_offset_minutes: (typeof utc_offset_minutes === 'number') ? utc_offset_minutes : null,
      analysis_cache: null,
      proactive_count_date: '',
      proactive_count_today: 0,
      last_action_gen_date: null,
      last_action_gen_index: 0,
      last_goal_reached_date: null,
      last_streak_reminder_date: null,
      last_streak_celebrated: null,
    }, { merge: true });

    await ensureTodayActions(deviceId, { force: true });
    invalidateCtx(deviceId);

    // Queue v2 welcome action batch (shared engine)
    try { _v2Hooks.queueGeneration(deviceId, { generationKind: 'setup' }); } catch {}

    res.json({ ok: true, daily_goal_ml: goal, recommended_goal_ml: goal, manual_goal_ml: null, goal_source: 'recommended', setup });
  } catch (e) {
    log.error('[water] POST /setup:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /setup-status ────────────────────────────────────────
router.get('/setup-status', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const snap = await waterDoc(deviceId).get();
    if (!snap.exists || !snap.data()?.setup_completed) {
      return res.json({ setup_completed: false });
    }

    const setup = snap.data().setup || {};
    const goalState = getGoalState(setup);
    res.json({
      setup_completed: true,
      setup: {
        ...setup,
        daily_goal_ml: goalState.goalMl,
        recommended_goal_ml: goalState.recommendedGoalMl,
        manual_goal_ml: goalState.manualGoalMl,
        goal_source: goalState.goalSource,
      },
    });
  } catch (e) {
    log.error('[water] GET /setup-status:', e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /chat-prompts  — returns 6 prompts personalised from setup + logs
// ═══════════════════════════════════════════════════════════════
router.get('/chat-prompts', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const snap  = await waterDoc(deviceId).get();
    const data  = snap.exists ? snap.data() : {};
    const setup = data.setup || {};
    const activity = setup.activity_level || 'moderate';
    const climate  = setup.climate        || 'mild';
    const weight   = setup.weight_kg      || 70;
    const goalMl   = setup.daily_goal_ml  || setup.recommended_goal_ml || 2500;
    const goalL    = (goalMl / 1000).toFixed(1);

    const hour = new Date().getHours();
    const isMorning = hour >= 5 && hour < 12;
    const isAfternoon = hour >= 12 && hour < 17;

    const pool = [];

    if (activity === 'athlete' || activity === 'active') {
      pool.push({ emoji: '🏃', text: "How much extra water do I need on workout days?" });
      pool.push({ emoji: '⚡', text: "Best electrolyte strategy for my training level?" });
    } else if (activity === 'sedentary') {
      pool.push({ emoji: '💧', text: `I sit most of the day — how do I hit my ${goalL}L goal?` });
      pool.push({ emoji: '⏰', text: "Set me a hydration schedule for a desk job." });
    } else {
      pool.push({ emoji: '💧', text: `What's the best way to hit ${goalL}L today?` });
      pool.push({ emoji: '⏰', text: "Help me build a hydration habit for the day." });
    }

    if (climate === 'hot' || climate === 'tropical') {
      pool.push({ emoji: '🌡️', text: "Hot weather — how much more should I drink?" });
    } else if (climate === 'cold') {
      pool.push({ emoji: '❄️', text: "Why is hydration important even in cold weather?" });
    }

    if (isMorning) {
      pool.push({ emoji: '🌅', text: "What's the best way to start the day hydrated?" });
    } else if (isAfternoon) {
      pool.push({ emoji: '☀️', text: "Afternoon slump — is dehydration causing it?" });
    }

    pool.push({ emoji: '📊', text: "What does my water intake trend look like?" });
    pool.push({ emoji: '🧠', text: "How does dehydration affect my mood and focus?" });
    pool.push({ emoji: '💡', text: "What are signs I'm not drinking enough?" });
    pool.push({ emoji: '🏋️', text: "How does hydration affect my workout performance?" });

    res.json({ prompts: pool.slice(0, 6) });
  } catch (err) {
    log.error('[water] /chat-prompts error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// ─── POST /goal ───────────────────────────────────────────────
router.post('/goal', async (req, res) => {
  try {
    const { deviceId, goal_ml: rawGoalMl, use_recommended: useRecommended = false } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const snap = await waterDoc(deviceId).get();
    if (!snap.exists || !snap.data()?.setup_completed) {
      return res.status(404).json({ error: 'Water setup not found' });
    }

    const waterData = snap.data() || {};
    const setup = waterData.setup || {};
    const recommendedGoalMl = calcDailyGoal(setup);
    const manualGoalMl = useRecommended ? null : sanitizeGoalMl(rawGoalMl, null);
    const today = dateStr();

    if (!useRecommended && !manualGoalMl) {
      return res.status(400).json({ error: 'goal_ml must be between 1500 and 6000' });
    }

    const dailyGoalMl = manualGoalMl || recommendedGoalMl;
    const goalSource = manualGoalMl ? 'manual' : 'recommended';
    const goalHistory = getGoalHistory(setup, waterData.setup_completed_at);
    const nextGoalHistory = upsertGoalHistoryEntry(goalHistory, {
      effective_from: today,
      goal_ml: dailyGoalMl,
      source: goalSource,
    });
    const nextSetup = {
      ...setup,
      recommended_goal_ml: recommendedGoalMl,
      manual_goal_ml: manualGoalMl,
      daily_goal_ml: dailyGoalMl,
      goal_source: goalSource,
      goal_history: nextGoalHistory,
    };

    await waterDoc(deviceId).set({
      setup: nextSetup,
      analysis_cache: null,
      last_goal_reached_date: null,
    }, { merge: true });

    invalidateCtx(deviceId);
    await ensureTodayActions(deviceId, { force: true });

    res.json({
      ok: true,
      daily_goal_ml: dailyGoalMl,
      recommended_goal_ml: recommendedGoalMl,
      manual_goal_ml: manualGoalMl,
      goal_source: goalSource,
      setup: nextSetup,
    });
  } catch (e) {
    log.error('[water] POST /goal:', e);
    res.status(500).json({ error: e.message });
  }
});

async function refreshWaterScore(deviceId) {
  try {
    const [logsSnap, waterSnap] = await Promise.all([
      logsCol(deviceId).orderBy('logged_at', 'desc').limit(70).get(),
      waterDoc(deviceId).get(),
    ]);
    const setup = (waterSnap.data() || {}).setup || {};
    const goalMl = setup.daily_goal_ml || 2500;

    // Group by date
    const byDate = {};
    logsSnap.docs.forEach(doc => {
      const data = doc.data();
      const ds = data.date || data.date_str;
      if (!ds) return;
      if (!byDate[ds]) byDate[ds] = { ml: 0, morningMl: 0, lateMl: 0, total: 0 };
      const effectiveMl = data.effective_ml || data.ml || 0;
      byDate[ds].ml    += effectiveMl;
      byDate[ds].total += effectiveMl;
      const h = data.hour || (data.logged_at?.toDate ? data.logged_at.toDate().getHours() : 12);
      if (h < 12) byDate[ds].morningMl += effectiveMl;
      if (h >= 20) byDate[ds].lateMl    += effectiveMl;
    });

    const dates = Object.keys(byDate).sort().slice(-7);
    if (!dates.length) return;
    const daysLogged = Object.keys(byDate).length;
    const n = dates.length;

    const hydrationAdequacy = Math.round(dates.reduce((s, d) => s + Math.min(100, (byDate[d].ml / goalMl) * 100), 0) / n);
    const consistency       = Math.round((dates.filter(d => byDate[d].ml >= goalMl * 0.8).length / n) * 100);
    const frontLoadPct      = Math.round((dates.filter(d => byDate[d].morningMl >= Math.max(300, goalMl * 0.22)).length / n) * 100);
    const lateTaperPct      = Math.round((dates.filter(d => byDate[d].lateMl <= 250).length / n) * 100);
    const chronobiology     = Math.round(frontLoadPct * 0.60 + lateTaperPct * 0.40);
    const avg7dMl           = Math.round(dates.reduce((s, d) => s + (byDate[d].ml || 0), 0) / n);

    const result = _computeWaterScore({
      hydration_adequacy: hydrationAdequacy,
      consistency,
      chronobiology,
      beverage_quality: 70, // default; full calc only in analysis
      avg_7d_ml: avg7dMl,
      days_logged: daysLogged,
    });
    if (!result) return;

    await waterDoc(deviceId).update({
      current_score:    result.score,
      score_label:      result.label,
      score_components: result.components,
      score_updated_at: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    log.error('[water] refreshScore:', err.message);
  }
}

// ─── POST /log ────────────────────────────────────────────────
router.post('/log', async (req, res) => {
  try {
    const { deviceId, ml, beverage_type = 'water', date } = req.body;
    if (!deviceId || ml == null) return res.status(400).json({ error: 'deviceId + ml required' });

    const parsedMl = parseFloat(ml);
    if (!Number.isFinite(parsedMl) || parsedMl < 1 || parsedMl > 5000) {
      return res.status(400).json({ error: 'ml must be between 1 and 5000' });
    }
    const safeBev     = Object.prototype.hasOwnProperty.call(BEV_MULT, beverage_type) ? beverage_type : 'water';
    const multiplier  = BEV_MULT[safeBev];
    const effectiveMl = Math.round(parsedMl * multiplier);
    const anchor = await resolveAnchor(deviceId);
    let logDate;
    try { logDate = assertLoggableDate(date, anchor); }
    catch (e) { return sendLogGuardError(res, e); }

    const ref = await logsCol(deviceId).add({
      ml: parsedMl,
      effective_ml: effectiveMl,
      beverage_type: safeBev,
      date: logDate,
      logged_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    invalidateCtx(deviceId);
    _onWaterLog(deviceId);  // v2 Actions hook
    refreshWaterScore(deviceId).catch(() => {});
    res.json({ ok: true, id: ref.id, effective_ml: effectiveMl });
  } catch (e) {
    log.error('[water] POST /log:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /log/from-photo ─────────────────────────────────────
// Camera-driven log: client posts a base64 JPEG, backend asks GPT-vision
// to estimate drink type / container / volume / fill / brand-label /
// confidence. Returns structured payload. Frontend renders confirmation
// sheet showing only the fields the AI is unsure about, then the user
// taps Log → frontend calls existing POST /log with the resolved values.
//
// This endpoint is analysis-only — it never writes to Firestore. The
// actual log write goes through /log so the existing optimistic UI,
// streak math, and action grading pipeline are untouched.
router.post('/log/from-photo', async (req, res) => {
  try {
    const { deviceId, shot_b64 } = req.body || {};
    if (!deviceId)  return res.status(400).json({ error: 'deviceId required' });
    if (!shot_b64)  return res.status(400).json({ error: 'shot_b64 required' });
    if (shot_b64.length > 12 * 1024 * 1024) {
      return res.status(413).json({ error: 'photo too large (max 12MB base64)' });
    }

    // Hash-based cache — identical photo bytes always return identical answer.
    // Hard guarantee against the "10 different results for same glass" bug.
    const cacheKey = _photoCacheKey(deviceId, shot_b64);
    const cached   = _photoCacheGet(cacheKey);
    if (cached) {
      return res.json({ ...cached, cached: true });
    }

    // Pull the user's saved containers + setup so the prompt can reference
    // brand-volume conventions and the user's typical drink type.
    let savedContainersHint = '';
    try {
      const cSnap = await waterDoc(deviceId).collection('containers').orderBy('use_count', 'desc').limit(8).get();
      if (!cSnap.empty) {
        const list = cSnap.docs.map(d => {
          const x = d.data();
          return `${x.name} (${x.drink_type}, ${x.ml}ml)`;
        }).join('; ');
        savedContainersHint = `User's saved containers (prefer these volumes when one matches the photo): ${list}.`;
      }
    } catch { /* non-fatal */ }

    // ─── Liquid-first prompt with worked examples + scale anchors ────────
    // Goal: same glass always returns the same number, ±10ml ceiling.
    // The model is forced through an explicit reasoning chain anchored to
    // observable scale references (user's hand, plate, surrounding objects)
    // and self-checks its own answer before emitting the final JSON.
    const systemPrompt = [
      'ROLE: You are a precise volumetric vision system for hydration logging.',
      'TASK: Estimate the volume of LIQUID currently in the container in ONE photo.',
      'Your output is what the user actually drank — the WATER, not the empty glass.',
      'Return STRICT JSON only. No prose, no markdown, no code fences.',
      '',
      '════════════════════════════════════════════════════════════════',
      'CORE PRINCIPLE: SAME PHOTO ⇒ SAME NUMBERS, ALWAYS.',
      'Do not be probabilistic. Be a measurement instrument.',
      '════════════════════════════════════════════════════════════════',
      '',
      '──── REASONING CHAIN (do all 7 steps internally before emitting JSON) ────',
      '',
      'STEP 1 — SCALE ANCHOR. Find a reference object in frame. Use the FIRST one that applies:',
      '  (a) Printed brand label with volume (Evian 500ml, Smartwater 1L, Coca-Cola 330ml, Starbucks size). This is GOLD — confidence 95+.',
      '  (b) User\'s hand wrapping or near the container. Adult male hand ≈ 19cm long / 9cm wide; adult female ≈ 17cm long / 8cm wide. Use width of fingers (1.8–2.2cm) for fine calibration.',
      '  (c) Standard objects in scene: dinner plate (26cm), credit card (8.5cm), smartphone (~15cm), keyboard key (1.8cm), coaster (10cm).',
      '  (d) NO scale reference visible → fall back to typical capacities table (Step 4).',
      '  Note which anchor you used in `reasoning`.',
      '',
      'STEP 2 — VESSEL CLARITY. Is the container transparent (you can see the liquid surface through the wall) or opaque (you cannot)?',
      '  Transparent: clear glass, clear plastic bottle, glass jar, ice tea pitcher, sparkling water bottle.',
      '  Opaque: ceramic mug, metal bottle, paper cup, sports flask, soda can (label-only visibility).',
      '  Set vessel_clarity accordingly.',
      '',
      'STEP 3 — CONTAINER GEOMETRY. Identify the shape:',
      '  - cylinder (straight walls, e.g. pint glass, tumbler)',
      '  - frustum (wider at top, e.g. drinking glass, paper cup)',
      '  - bottle-with-neck (e.g. water bottle, beer bottle)',
      '  - flared bowl on stem (wine glass)',
      '  - mug (cylindrical with handle)',
      '  - can (sealed cylinder with label)',
      '',
      'STEP 4 — CAPACITY (what a FULL vessel would hold):',
      '  PRIORITY 1: Brand label if readable → use exact printed value.',
      '  PRIORITY 2: Cross-reference scale anchor (Step 1) with shape (Step 3) to size the container in cm, then compute capacity from geometry. E.g. cylinder 8cm diameter × 10cm tall = π × 4² × 10 = 502cc ≈ 500ml.',
      '  PRIORITY 3: Typical-capacity table (use only if no scale anchor):',
      '    espresso=60 · shot=45 · small wine=180 · large wine=250 · drinking glass=250 · mug=300 · large mug=400 · soda can=330 · tumbler=400 · paper cup S/M/L=240/350/470 · pint=500 · water bottle=500 · sports bottle=700 · 1L bottle=1000 · 1.5L=1500',
      '  Set container_capacity_ml. Round to nearest 10.',
      '',
      'STEP 5 — FILL PERCENT (the actual measurement):',
      '  IF transparent vessel AND liquid surface visible:',
      '    Locate the meniscus. Measure its height from the inside bottom.',
      '    fill_percent = (liquid_height / interior_height) × 100, rounded to nearest 5.',
      '    For tapered vessels (frustum, wine glass), DO NOT linearly map height to volume — top of glass holds more liquid per cm than bottom. Use:',
      '      - Liquid in bottom half of frustum ≈ 25–35% of capacity',
      '      - Liquid at midpoint ≈ 40–50% of capacity',
      '      - Liquid in top half ≈ 65–80% of capacity',
      '      - Liquid at rim ≈ 95–100%',
      '    Confidence ≥85 — you can SEE the water; do NOT add "fill" to unsure_about.',
      '  IF opaque vessel:',
      '    Use external cues: steam visible → 70–90%; liquid at rim → 95–100%; ring marks indicating recent fill height; glass tilted but no spill → ≤80%.',
      '    No cues at all → default to 90% (most users photograph drinks shortly after pouring).',
      '    Confidence ≤80; add "fill" to unsure_about.',
      '  IF empty / dry / residue-only:',
      '    fill_percent = 0–10, reasoning = "empty / residue only".',
      '',
      'STEP 6 — DRINK TYPE. Color + container + context:',
      '  Crystal clear, no bubbles → water',
      '  Clear with rising bubbles → sparkling',
      '  Pale yellow / amber → tea or herbal_tea (mug → tea; tea bag visible → tea; in clear pot → herbal_tea)',
      '  Dark brown / black → coffee',
      '  Cloudy white → milk',
      '  Bright orange / red / purple → juice',
      '  Caramel brown + fizz → soda',
      '  Bright neon (cyan/green/red) → sport_drink',
      '  Cloudy yellow + foam head → alcohol (beer)',
      '  Deep red in wine glass → alcohol (wine)',
      '  Container hint: mug → coffee or tea; wine glass → wine; can → soda or sport; sports bottle → water or sport',
      '  Be DECISIVE. If you cannot tell coffee vs tea, pick coffee (more common) and add "drink_type" to unsure_about.',
      '',
      'STEP 7 — SELF-CHECK (DO NOT SKIP):',
      '  Before emitting, verify:',
      '  (a) Is estimated_ml within 5% of (container_capacity_ml × fill_percent / 100)? If not, recompute estimated_ml = capacity × fill / 100.',
      '  (b) Is your number plausible for this container type? A coffee mug should be 50–400ml, not 800ml. A water bottle should be 250–1500ml.',
      '  (c) If brand_label is set, does estimated_ml ≤ brand_label.ml? It cannot be more than the bottle holds.',
      '  (d) Is your reasoning self-consistent? If you wrote "transparent glass, liquid 70%" but estimated_ml is 50% of capacity, fix the inconsistency.',
      '',
      '──── WORKED EXAMPLES (study format + reasoning style) ────',
      '',
      'EXAMPLE 1 — clear glass, 70% full water:',
      '  Reasoning: cylinder ~8cm dia × 12cm tall (calibrated from hand width 8cm in frame). Capacity ≈ π·4²·12 = 600ml ≈ standard pint glass 500ml (closer match). Liquid surface at 70% height of straight cylinder ≈ 70% of capacity. 500 × 0.70 = 350ml. Clear, no bubbles → water. Confidence 88 (clear surface, hand fiducial).',
      '  → {"drink_type":"water","container_type":"glass","vessel_clarity":"transparent","container_capacity_ml":500,"fill_percent":70,"estimated_ml":350,"confidence":88,"brand_label":null,"unsure_about":[],"reasoning":"pint-sized glass, hand fiducial, water surface at 70% — straight cylinder maps linearly"}',
      '',
      'EXAMPLE 2 — Evian bottle, label readable, half empty:',
      '  Reasoning: brand label visible "Evian 500mL". Bottle, transparent. Liquid level at midline = ~50% (bottle has slight neck taper but middle 70% is straight). Crystal clear → water. Brand label dominates → confidence 96.',
      '  → {"drink_type":"water","container_type":"bottle","vessel_clarity":"transparent","container_capacity_ml":500,"fill_percent":50,"estimated_ml":250,"confidence":96,"brand_label":{"name":"Evian 500ml","ml":500},"unsure_about":[],"reasoning":"Evian 500ml label visible, liquid surface at midline = 50%"}',
      '',
      'EXAMPLE 3 — ceramic mug with steam, no liquid surface visible:',
      '  Reasoning: opaque white ceramic mug, ~9cm tall. Steam rising = recently filled. Cannot see surface. Default to 90% fill. Mug capacity ~300ml. Dark brown stain on inside rim → coffee. Confidence 70 (fill is inferred, not measured).',
      '  → {"drink_type":"coffee","container_type":"mug","vessel_clarity":"opaque","container_capacity_ml":300,"fill_percent":90,"estimated_ml":270,"confidence":70,"brand_label":null,"unsure_about":["fill"],"reasoning":"opaque mug + steam → recently filled, default 90%; coffee ring confirms type"}',
      '',
      'EXAMPLE 4 — wine glass, ¼ full:',
      '  Reasoning: flared bowl on stem = wine glass, ~250ml capacity. Frustum geometry: liquid in bottom quarter of bowl. For a flared wine glass, bottom-quarter height holds only ~10–15% of capacity. fill_percent = 12 → 250 × 0.12 = 30ml — but wait, that\'s less than a sip. Re-check: liquid extends slightly past quarter-height → bump to 18%. 250 × 0.18 ≈ 45ml. Deep red → wine. Confidence 84.',
      '  → {"drink_type":"alcohol","container_type":"wine_glass","vessel_clarity":"transparent","container_capacity_ml":250,"fill_percent":18,"estimated_ml":45,"confidence":84,"brand_label":null,"unsure_about":[],"reasoning":"wine glass quarter-height — frustum geometry yields ~18% of capacity, not 25%"}',
      '',
      '──── OUTPUT SCHEMA (all keys required) ────',
      '  drink_type           — enum: water | sparkling | herbal_tea | tea | milk | juice | coffee | sport_drink | soda | alcohol | other',
      '  container_type       — enum: glass | bottle | mug | can | sports_bottle | wine_glass | paper_cup | tumbler | other',
      '  vessel_clarity       — "transparent" | "opaque"',
      '  container_capacity_ml — integer, full-vessel volume rounded to nearest 10',
      '  fill_percent         — integer 0–100, rounded to nearest 5',
      '  estimated_ml         — integer = round_10(capacity × fill / 100)',
      '  confidence           — integer 0–100',
      '  brand_label          — null OR {"name": string, "ml": integer}',
      '  unsure_about         — subset of ["drink_type","capacity","fill"]',
      '  reasoning            — ≤24 words: anchor used, vessel clarity, key visual evidence',
      '',
      savedContainersHint,
      '',
      'Return the JSON object only.',
    ].filter(Boolean).join('\n');

    const responseSchema = {
      type: 'object',
      properties: {
        drink_type:           { type: 'string', enum: ['water','sparkling','herbal_tea','tea','milk','juice','coffee','sport_drink','soda','alcohol','other'] },
        container_type:       { type: 'string', enum: ['glass','bottle','mug','can','sports_bottle','wine_glass','paper_cup','tumbler','other'] },
        vessel_clarity:       { type: 'string', enum: ['transparent','opaque'] },
        container_capacity_ml:{ type: 'integer' },
        fill_percent:         { type: 'integer' },
        estimated_ml:         { type: 'integer' },
        confidence:           { type: 'integer' },
        brand_label:          {
          type: 'object',
          nullable: true,
          properties: { name: { type: 'string' }, ml: { type: 'integer' } },
        },
        unsure_about:         { type: 'array', items: { type: 'string', enum: ['drink_type','capacity','fill'] } },
        reasoning:            { type: 'string' },
      },
      required: ['drink_type','container_type','vessel_clarity','container_capacity_ml','fill_percent','estimated_ml','confidence','unsure_about','reasoning'],
    };

    // ─── Personal calibration — pull the user's correction history ───────
    // Each {drink_type, container_type} pair has a learned ratio (user_ml /
    // ai_ml) from past corrections. Shrinks the range over time and applies
    // a multiplier so the AI's estimate auto-corrects in this user's direction.
    // Cached in-memory for 5 minutes (busted on calibration writes) — the
    // raw Firestore query costs ~150ms which is wasted on every photo log.
    let personalCalibration = _calCacheGet(deviceId);
    if (!personalCalibration) {
      try {
        const calSnap = await waterDoc(deviceId).collection('calibration')
          .orderBy('updated_at', 'desc').limit(20).get();
        if (!calSnap.empty) {
          const map = {};
          calSnap.docs.forEach(d => {
            const x = d.data();
            if (x.drink_type && x.container_type && Number.isFinite(x.ratio) && Number.isFinite(x.sample_count)) {
              map[`${x.drink_type}|${x.container_type}`] = {
                ratio: x.ratio,
                n:     x.sample_count,
              };
            }
          });
          personalCalibration = map;
        } else {
          personalCalibration = {}; // empty map still cached → avoid re-querying
        }
        _calCacheSet(deviceId, personalCalibration);
      } catch { /* non-fatal */ }
    }

    const t0 = Date.now();
    let parsed = null;
    // usedModel is set by whichever of the two paths below produced a
    // parseable response. If both fail we return 502 before reading it.
    let usedModel = 'unknown';

    // ── Path A: GPT-4o (PRIMARY — accuracy winner per benchmarks) ──
    // Same model + canonical pipeline as nutrition `_multiShotVision`. The
    // 7-step reasoning chain in `systemPrompt` is preserved verbatim; what
    // changes is which model executes it. GPT-4o's spatial reasoning +
    // OCR fidelity edges Gemini 2.5 Pro on photo tasks per the food
    // benchmarks (the volume task is structurally similar — scale anchor +
    // geometry estimation).
    //
    // We use OpenAI's `json_schema` strict mode (shipped late 2024) which
    // guarantees the response matches `responseSchema` at the API level —
    // same shape-lock guarantee as Gemini's `responseSchema`. Together with
    // the Gemini fallback, both paths are now schema-enforced.
    try {
      const completion = await openai.chat.completions.create({
        model: MODELS.cameraPrimary,
        // OpenAI strict json_schema mode emits ONLY the JSON (no inline
        // reasoning). Schema is ~10 fields including a `reasoning` string
        // capped to 24 words by the prompt → worst case ~250 tokens. 600
        // gives 2.4× headroom; 1200 was overweight and added ~400ms.
        // Gemini fallback below stays at 1200 because Gemini DOES inline
        // reasoning before the JSON (different decoding behavior).
        max_completion_tokens: 600,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${shot_b64}`, detail: 'high' } },
              { type: 'text', text: 'Analyze this drink photo. Work through the 7-step reasoning chain internally, then emit the JSON.' },
            ],
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'water_drink_log', strict: true, schema: openaiStrict(responseSchema) },
        },
      });
      const raw = completion.choices?.[0]?.message?.content?.trim() || '';
      try {
        parsed = JSON.parse(raw);
        usedModel = MODELS.cameraPrimary;
      } catch {
        log.warn('[water] /log/from-photo OpenAI parse fail (will try Gemini):', raw.slice(0, 200));
      }
    } catch (err) {
      log.warn('[water] /log/from-photo OpenAI primary failed (will try Gemini):', err?.message);
    }

    // ── Path B: Gemini 2.5 Pro fallback (schema-enforced, deterministic) ──
    // Same systemPrompt + responseSchema. The SDK enforces the shape so
    // even if the model is uncertain, we get a valid JSON object back.
    // This is the safety net when OpenAI either threw or returned non-JSON.
    if (!parsed) {
      parsed = await callGeminiVision({
        systemPrompt,
        userText: 'Analyze this drink photo. Work through the 7-step reasoning chain internally, then emit the JSON.',
        images: [shot_b64],
        responseSchema,
        // 1200 tokens lets the model reason through scale anchor → geometry →
        // capacity → fill → self-check before emitting JSON.
        maxOutputTokens: 1200,
        model: VISION_MODEL_PRIMARY,
        label: 'water-log-fallback',
      });
      if (parsed) usedModel = VISION_MODEL_PRIMARY;
    }

    if (!parsed) {
      log.error('[water] /log/from-photo: both OpenAI primary and Gemini fallback failed');
      return res.status(502).json({ error: 'AI response unparseable, try again' });
    }
    const latency_ms = Date.now() - t0;

    // Whitelist + sanitize — never trust the model
    const ALLOWED_TYPES   = ['water','sparkling','herbal_tea','tea','milk','juice','coffee','sport_drink','soda','alcohol','other'];
    const ALLOWED_CONT    = ['glass','bottle','mug','can','sports_bottle','wine_glass','paper_cup','tumbler','other'];
    const ALLOWED_CLARITY = ['transparent','opaque'];
    const ALLOWED_UNS     = ['drink_type','capacity','fill'];

    const drink_type     = ALLOWED_TYPES.includes(parsed.drink_type) ? parsed.drink_type : 'water';
    const container_type = ALLOWED_CONT.includes(parsed.container_type) ? parsed.container_type : 'glass';
    const vessel_clarity = ALLOWED_CLARITY.includes(parsed.vessel_clarity) ? parsed.vessel_clarity : 'opaque';

    const cap_raw      = Number(parsed.container_capacity_ml);
    const fill_raw     = Number(parsed.fill_percent);
    const ml_raw       = Number(parsed.estimated_ml);

    const container_capacity_ml = Number.isFinite(cap_raw)
      ? Math.max(30, Math.min(2000, Math.round(cap_raw / 10) * 10))
      : 250;
    const fill_percent = Number.isFinite(fill_raw)
      ? Math.max(0, Math.min(100, Math.round(fill_raw)))
      : 80;

    // Trust the model's estimated_ml if it's coherent (within 15% of capacity×fill).
    // Otherwise compute it ourselves from capacity × fill — this prevents the
    // model from returning bizarre standalone numbers like "container 250ml,
    // 60% full, but estimated_ml: 480" (yes, it happens).
    const computedMl = Math.round((container_capacity_ml * fill_percent) / 100 / 10) * 10;
    let   estimated_ml = Number.isFinite(ml_raw)
      ? Math.max(0, Math.min(2000, Math.round(ml_raw / 10) * 10))
      : computedMl;
    if (Math.abs(estimated_ml - computedMl) > Math.max(20, computedMl * 0.15)) {
      estimated_ml = computedMl;
    }

    const conf_raw     = Number(parsed.confidence);
    const confidence   = Number.isFinite(conf_raw) ? Math.max(0, Math.min(100, Math.round(conf_raw))) : 60;
    const unsure_about = Array.isArray(parsed.unsure_about)
      ? parsed.unsure_about.filter(x => ALLOWED_UNS.includes(x))
      : [];
    let brand_label = null;
    if (parsed.brand_label && typeof parsed.brand_label === 'object') {
      const bn = String(parsed.brand_label.name || '').slice(0, 60);
      const bm = Number(parsed.brand_label.ml);
      if (bn && Number.isFinite(bm) && bm >= 30 && bm <= 2000) {
        brand_label = { name: bn, ml: Math.round(bm) };
      }
    }
    const reasoning = String(parsed.reasoning || '').slice(0, 140);

    // ─── Apply personal calibration (multiplier toward user's true volumes) ──
    let calibrated_ml = estimated_ml;
    let calibration_applied = null;
    if (personalCalibration && !brand_label) {
      const key  = `${drink_type}|${container_type}`;
      const cal  = personalCalibration[key];
      // Only trust calibration once we have ≥3 samples for this pair —
      // single-correction noise can pull estimates the wrong way.
      if (cal && cal.n >= 3 && cal.ratio > 0.5 && cal.ratio < 2.0) {
        calibrated_ml = Math.round((estimated_ml * cal.ratio) / 10) * 10;
        calibration_applied = { ratio: +cal.ratio.toFixed(3), samples: cal.n };
      }
    }

    // ─── Volume buckets — give the user 3 quick-pick ranges ──
    // BRAND-LABEL CASE: capacity is known exactly, but how much they drank
    // isn't. Buckets become fill-level ranges of the labeled capacity:
    //   [a sip] [half] [most/all]
    // UNBRANDED CASE: AI estimate has uncertainty; buckets cover ±2× width
    // around the calibrated estimate (less / AI's pick / more).
    const samples = calibration_applied?.samples || 0;
    const calShrink = Math.max(0.5, 1 - Math.min(samples, 10) / 20);
    const round10 = (n) => Math.round(n / 10) * 10;
    const makeBucket = (lowRaw, highRaw, isBest) => {
      const low  = Math.max(10,   round10(lowRaw));
      const high = Math.min(2000, round10(highRaw));
      return {
        ml_low:  low,
        ml_high: high,
        ml_mid:  round10((low + high) / 2),
        label:   `${low}–${high}ml`,
        is_best: !!isBest,
      };
    };

    let volume_buckets;
    if (brand_label) {
      // Capacity is exact (e.g. 473ml). Offer fill-level buckets so the user
      // can say "had a sip" / "half" / "all of it".
      const cap = brand_label.ml;
      const fillFromAi = fill_percent;
      // Three buckets covering common drinking patterns:
      //   sip:  0–25%
      //   half: 25–75%
      //   most: 75–100%
      volume_buckets = [
        makeBucket(0,        cap * 0.25, fillFromAi <= 25),
        makeBucket(cap * 0.25, cap * 0.75, fillFromAi > 25 && fillFromAi <= 75),
        makeBucket(cap * 0.75, cap,       fillFromAi > 75),
      ];
      // Ensure exactly one is_best
      if (!volume_buckets.some(b => b.is_best)) volume_buckets[2].is_best = true;
    } else {
      // 95 → ±10ml; 80 → ±20ml; 65 → ±30ml; 50 → ±40ml
      const base = Math.round((100 - Math.min(95, confidence)) * 0.7);
      const w = Math.max(10, Math.min(60, Math.round(base * calShrink / 5) * 5));
      volume_buckets = [
        makeBucket(calibrated_ml - 3 * w, calibrated_ml - w,  false),
        makeBucket(calibrated_ml - w,     calibrated_ml + w,  true),
        makeBucket(calibrated_ml + w,     calibrated_ml + 3 * w, false),
      ];
    }

    // Range bounds (kept for legacy callers + analytics)
    const range_low_ml  = volume_buckets[0].ml_low;
    const range_high_ml = volume_buckets[volume_buckets.length - 1].ml_high;

    const result = {
      drink_type,
      container_type,
      vessel_clarity,
      container_capacity_ml,
      fill_percent,
      estimated_ml: calibrated_ml,
      ai_raw_ml:    estimated_ml,        // pre-calibration; useful for analytics + correction logging
      volume_buckets,                    // NEW — primary input for the UI
      range_low_ml,                      // legacy; equals first bucket low
      range_high_ml,                     // legacy; equals last bucket high
      confidence,
      brand_label,
      unsure_about,
      reasoning,
      calibration_applied,
      model: usedModel,
      latency_ms,
    };

    // Cache the sanitized result so the same photo always returns the same answer.
    _photoCacheSet(cacheKey, result);

    return res.json({ ...result, cached: false });
  } catch (e) {
    log.error('[water] POST /log/from-photo:', e);
    res.status(500).json({ error: e.message || 'vision call failed' });
  }
});

// ─── GET /today ───────────────────────────────────────────────
router.get('/today', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const today = dateStr();

    const [wSnap, logsSnap, allLogsSnap] = await Promise.all([
      waterDoc(deviceId).get(),
      logsCol(deviceId).where('date', '==', today).get(),
      logsCol(deviceId).orderBy('logged_at', 'desc').limit(400).get(),
    ]);

    const waterData = wSnap.exists ? (wSnap.data() || {}) : {};
    const setup  = waterData.setup || {};
    const goalState = getGoalState(setup);
    const goalHistory = getGoalHistory(setup, waterData.setup_completed_at);
    const goalForDate = (ds) => resolveGoalForDate(goalHistory, ds, goalState.goalMl);
    const goalMl = goalForDate(today);

    const logs = logsSnap.docs
      .map(mapDoc)
      .map(log => ({ ...log, logged_at: toIso(log.logged_at) }))
      .sort((a, b) => new Date(b.logged_at) - new Date(a.logged_at));

    const loggedMl = logs.reduce((sum, log) =>
      sum + (log.effective_ml || Math.round((log.ml || 0) * (BEV_MULT[log.beverage_type] || 1))), 0);

    const allLogs = allLogsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const { byDate } = aggregateLogs(setup, allLogs);
    const streak = computeCurrentStreak(byDate, goalForDate);

    res.json({
      logs,
      entry_count: logs.length,
      logged_ml: loggedMl,
      remaining_ml: Math.max(0, goalMl - loggedMl),
      goal_ml: goalMl,
      recommended_goal_ml: goalState.recommendedGoalMl,
      manual_goal_ml: goalState.manualGoalMl,
      goal_source: goalState.goalSource,
      streak,
    });
  } catch (e) {
    log.error('[water] GET /today:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── DELETE /log/:id ─────────────────────────────────────────
router.delete('/log/:id', async (req, res) => {
  try {
    const { deviceId } = req.query;
    const { id } = req.params;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    await logsCol(deviceId).doc(id).delete();
    invalidateCtx(deviceId);

    res.json({ ok: true });
  } catch (e) {
    log.error('[water] DELETE /log:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Saved Containers (Phase 2 — photo-log shortcuts) ─────────
// One-shot containers a user has named after a photo identification.
// Tap the chip → log instantly at the saved volume + drink type
// (skips camera entirely). Subcollection: water_users/{id}/containers.

const containersCol = (deviceId) => waterDoc(deviceId).collection('containers');

router.get('/containers', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    const snap = await containersCol(deviceId).orderBy('use_count', 'desc').limit(20).get();
    const containers = snap.docs.map(d => {
      const x = d.data();
      return {
        id:           d.id,
        name:         x.name,
        drink_type:   x.drink_type,
        ml:           x.ml,
        emoji:        x.emoji || '💧',
        use_count:    x.use_count || 0,
        last_used_at: x.last_used_at?.toMillis ? x.last_used_at.toMillis() : null,
        created_at:   x.created_at?.toMillis  ? x.created_at.toMillis()  : null,
      };
    });
    res.json({ containers });
  } catch (e) {
    log.error('[water] GET /containers:', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/containers', async (req, res) => {
  try {
    const { deviceId, name, drink_type = 'water', ml, emoji } = req.body || {};
    if (!deviceId || !name || !ml) return res.status(400).json({ error: 'deviceId, name, ml required' });
    const ALLOWED_TYPES = ['water','sparkling','herbal_tea','tea','milk','juice','coffee','sport_drink','soda','alcohol','other'];
    const safeType = ALLOWED_TYPES.includes(drink_type) ? drink_type : 'water';
    const safeMl   = Math.max(30, Math.min(2000, Math.round(Number(ml) || 0)));
    if (!safeMl) return res.status(400).json({ error: 'invalid ml' });
    const safeName = String(name).trim().slice(0, 40);
    if (!safeName) return res.status(400).json({ error: 'name required' });

    const ref = await containersCol(deviceId).add({
      name:         safeName,
      drink_type:   safeType,
      ml:           safeMl,
      emoji:        emoji ? String(emoji).slice(0, 4) : '💧',
      use_count:    0,
      last_used_at: null,
      created_at:   admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ ok: true, id: ref.id });
  } catch (e) {
    log.error('[water] POST /containers:', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/containers/:id/use', async (req, res) => {
  // Bump use_count + last_used_at when a container is used to log.
  try {
    const { deviceId } = req.body || {};
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    await containersCol(deviceId).doc(req.params.id).update({
      use_count:    admin.firestore.FieldValue.increment(1),
      last_used_at: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ ok: true });
  } catch (e) {
    log.error('[water] POST /containers/:id/use:', e);
    res.status(500).json({ error: e.message });
  }
});

router.delete('/containers/:id', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    await containersCol(deviceId).doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) {
    log.error('[water] DELETE /containers/:id:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /calibration — log a user correction so future ranges shrink ──
// Frontend calls this after the user adjusts an AI photo-log estimate.
// We store a rolling per-{drink_type, container_type} ratio of (user_ml /
// ai_ml). Subsequent /log/from-photo calls apply the ratio + shrink the
// range proportional to sample count.
router.post('/calibration', async (req, res) => {
  try {
    const { deviceId, drink_type, container_type, ai_ml, user_ml } = req.body || {};
    if (!deviceId || !drink_type || !container_type) {
      return res.status(400).json({ error: 'deviceId, drink_type, container_type required' });
    }
    const a = Number(ai_ml), u = Number(user_ml);
    if (!Number.isFinite(a) || !Number.isFinite(u) || a < 10 || u < 10) {
      return res.status(400).json({ error: 'invalid ai_ml or user_ml' });
    }
    const newRatio = u / a;
    // Clamp to plausible range — protects against accidental adjustments
    // that would otherwise poison the calibration (e.g. user logs 10ml when
    // AI said 500ml because they tapped wrong).
    if (newRatio < 0.3 || newRatio > 3.0) return res.json({ ok: true, skipped: 'ratio_out_of_range' });

    const docId = `${drink_type}__${container_type}`;
    const ref   = waterDoc(deviceId).collection('calibration').doc(docId);
    await admin.firestore().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const existing = snap.exists ? snap.data() : null;
      // Exponential moving average — newer corrections weighted more.
      // Caps at 20 samples, so a user can't permanently bias an old container
      // by re-correcting the same one 100 times.
      const oldRatio = existing?.ratio ?? 1.0;
      const oldN     = Math.min(existing?.sample_count ?? 0, 20);
      const newN     = oldN + 1;
      const blendedRatio = (oldRatio * oldN + newRatio) / newN;
      tx.set(ref, {
        drink_type,
        container_type,
        ratio:        +blendedRatio.toFixed(3),
        sample_count: newN,
        last_ai_ml:   Math.round(a),
        last_user_ml: Math.round(u),
        updated_at:   admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    // Bust the in-memory calibration cache so the next /log/from-photo
    // call picks up the new ratio immediately (instead of waiting up to 5min).
    _calCacheBust(deviceId);
    res.json({ ok: true });
  } catch (e) {
    log.error('[water] POST /calibration:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /logs?date=YYYY-MM-DD ───────────────────────────────
router.get('/logs', async (req, res) => {
  try {
    const { deviceId, date } = req.query;
    if (!deviceId || !date) return res.status(400).json({ error: 'deviceId + date required' });

    const [wSnap, logsSnap] = await Promise.all([
      waterDoc(deviceId).get(),
      logsCol(deviceId).where('date', '==', date).get(),
    ]);

    const waterData = wSnap.exists ? (wSnap.data() || {}) : {};
    const setup  = waterData.setup || {};
    const goalState = getGoalState(setup);
    const goalHistory = getGoalHistory(setup, waterData.setup_completed_at);
    const goalMl = resolveGoalForDate(goalHistory, date, goalState.goalMl);
    const logs   = logsSnap.docs
      .map(mapDoc)
      .map(log => ({ ...log, logged_at: toIso(log.logged_at) }))
      .sort((a, b) => new Date(b.logged_at) - new Date(a.logged_at));

    const loggedMl = logs.reduce((sum, log) => sum + (log.effective_ml || log.ml || 0), 0);

    res.json({
      logs,
      entry_count: logs.length,
      logged_ml: loggedMl,
      goal_ml: goalMl,
      recommended_goal_ml: goalState.recommendedGoalMl,
      manual_goal_ml: goalState.manualGoalMl,
      goal_source: goalState.goalSource,
    });
  } catch (e) {
    log.error('[water] GET /logs:', e);
    res.status(500).json({ error: e.message });
  }
});


// ════════════════════════════════════════════════════════════════
// GET /analysis — V4 Insights tab payload
// Mirrors /api/fasting/analysis + /api/nutrition/analysis contract.
// ════════════════════════════════════════════════════════════════
const _waterAnalytics = require('./lib/water-analytics');

router.get('/analysis', async (req, res) => {
  try {
    const { deviceId, range = '30' } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    const language = resolveLanguage(req);

    const wSnap = await waterDoc(deviceId).get();
    if (!wSnap.exists || !wSnap.data()?.setup_completed) {
      return res.json({ setup_completed: false });
    }
    const data  = wSnap.data() || {};
    const target_ml = data.daily_goal_ml || data.setup?.daily_goal_ml || 2500;

    // Registration Anchor: clamp window to signup date in user's local TZ.
    const nowMs = Date.now();
    const anchor = await resolveAnchor(deviceId);
    const { computeAnalysisWindow } = require('./lib/range-helpers');
    const win = computeAnalysisWindow(range, anchor.anchorMs, nowMs, anchor.utcOffsetMinutes);
    const days = win.effectiveDays;
    const cutoff = win.cutoffMs;
    const effectiveStartDate = win.effectiveStartDate;
    const fetchLimit = Math.min(days * 25, 3000);

    const logsSnap = await logsCol(deviceId).orderBy('logged_at', 'desc').limit(fetchLimit).get();
    const { dateStr: _dsLocalLogs } = require('./lib/range-helpers');
    const _tzOffsetLogs = anchor.utcOffsetMinutes || 0;
    const allLogs  = logsSnap.docs.map(d => {
      const x = d.data();
      const ms = x.logged_at?.toMillis ? x.logged_at.toMillis() : new Date(x.logged_at || 0).getTime();
      return {
        id:          d.id,
        ml:          x.ml || 0,
        drink_type:  x.drink_type || 'water',
        logged_at:   ms ? new Date(ms).toISOString() : null,
        date:        x.date || (ms ? _dsLocalLogs(new Date(ms), _tzOffsetLogs) : null),
      };
    }).filter(l => l.logged_at && new Date(l.logged_at).getTime() >= cutoff);

    // Hydration score
    const hydrationScore = _waterAnalytics.computeHydrationScore({
      logs: allLogs, target_ml, days,
    });
    const score       = hydrationScore.score;
    const grade       = _waterAnalytics.scoreGrade(score);
    const score_gates = {
      volume:       { label: 'Volume',       pts: hydrationScore.components.volume       * 0.35, weight: 35 },
      timing:       { label: 'Timing',       pts: hydrationScore.components.timing       * 0.25, weight: 25 },
      consistency:  { label: 'Consistency',  pts: hydrationScore.components.consistency  * 0.25, weight: 25 },
      electrolytes: { label: 'Electrolytes', pts: hydrationScore.components.electrolytes * 0.15, weight: 15 },
    };
    Object.values(score_gates).forEach(g => { g.pts = Math.round(g.pts); });

    // Signal points (one per day in range) — local-TZ keys, chart_tz_clamp law
    const { dateStr: _dsTz } = require('./lib/range-helpers');
    const _tzOffset = anchor.utcOffsetMinutes || 0;
    const byDate = {};
    for (const l of allLogs) {
      if (!l.date) continue;
      if (!byDate[l.date]) byDate[l.date] = { ml: 0 };
      byDate[l.date].ml += l.ml;
    }
    const dayKeys = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      dayKeys.push(_dsTz(d, _tzOffset));
    }
    const signal_points = dayKeys.map(k => ({
      value:     Math.round(byDate[k]?.ml || 0),
      pct:       Math.min(100, Math.round((byDate[k]?.ml || 0) / target_ml * 100)),
      completed: (byDate[k]?.ml || 0) >= target_ml,
      date:      k,
    }));

    // Drink breakdown
    const drink_breakdown = _waterAnalytics.computeDrinkBreakdown(allLogs);

    // Daily curve (today) — local-TZ key, chart_tz_clamp law
    const todayKey   = _dsTz(new Date(), _tzOffset);
    const daily_curve = _waterAnalytics.computeDailyCurve({
      logs: allLogs, target_ml, dateKey: todayKey,
    });

    // 28-day daily logs heatmap — Registration Anchor Law:
    // never iterate past anchor, never use UTC date keys.
    const daily_logs = {};
    const { enumerateDaysFrom, dateStr: _dsLocal } = require('./lib/range-helpers');
    const _todayKey = _dsLocal(new Date(), anchor.utcOffsetMinutes);
    const _heatStart = (() => {
      const dt = new Date(); dt.setDate(dt.getDate() - 27);
      const candidate = _dsLocal(dt, anchor.utcOffsetMinutes);
      return anchor.anchorDateStr && candidate < anchor.anchorDateStr ? anchor.anchorDateStr : candidate;
    })();
    for (const k of enumerateDaysFrom(_heatStart, _todayKey)) {
      const v = byDate[k]?.ml || 0;
      if (v > 0) {
        daily_logs[k] = {
          ml:        Math.round(v),
          target_ml,
          completed: v >= target_ml,
          pct:       Math.round(v / target_ml * 100),
        };
      }
    }

    // Day-of-week + circadian
    const { best_day, worst_day } = _waterAnalytics.computeDayOfWeek(allLogs, target_ml);
    const circadian               = _waterAnalytics.computeCircadian(allLogs, target_ml);

    // Streak
    const streak = data.current_streak || 0;

    // Aha + AI reads (cached)
    const aha_moments = _waterAnalytics.computeAhaMoments(allLogs, hydrationScore, target_ml);

    const totalLogs = allLogs.length;
    const aiCacheKey = ['water_v2', range, totalLogs, score, streak, target_ml, language].join('|');
    let ai_reads = { champion: null, drag: null, pattern: null };
    const cached = data.ai_reads_cache_v2?.[aiCacheKey];
    if (cached) {
      ai_reads = cached;
    } else {
      ai_reads = await _waterAnalytics.generateAiReads(allLogs, target_ml, hydrationScore, openai, deviceId, language);
      if (ai_reads.champion || ai_reads.drag || ai_reads.pattern) {
        waterDoc(deviceId).set({
          ai_reads_cache_v2: { [aiCacheKey]: ai_reads, _generated_at: new Date().toISOString() },
        }, { merge: true }).catch(() => {});
      }
    }

    // Personal formula
    const personal_formula = _waterAnalytics.computePersonalFormula({
      logs: allLogs, target_ml, score, dayCount: Object.keys(byDate).length,
    });

    // Aggregates
    const total_ml  = allLogs.reduce((s, l) => s + (l.ml || 0), 0);
    const dayCount  = Object.keys(byDate).length || 1;
    const avg_ml    = Math.round(total_ml / dayCount);
    const best_ml   = Math.max(0, ...Object.values(byDate).map(v => v.ml || 0));
    const completed_days = signal_points.filter(p => p.completed).length;
    const completion = signal_points.length ? completed_days / signal_points.length : 0;

    // Observations
    const observations = [];
    if (completion >= 0.8) {
      observations.push({ title: `${Math.round(completion * 100)}% on-target days — elite`, body: 'Sustained 80%+ on-target hydration is the pattern in long-lived populations.' });
    } else if (completion < 0.4 && signal_points.length >= 7) {
      observations.push({ title: `${Math.round(completion * 100)}% on-target — room to grow`, body: 'Small wins compound. Add one anchor habit and watch this number jump in 7 days.' });
    }
    if (streak >= 7) {
      observations.push({ title: `${streak}-day streak — locked in`, body: 'Streaks past 7 days mark the shift from intentional to automatic.' });
    }
    if (drink_breakdown.find(b => b.type === 'coffee' && b.count >= 5)) {
      const c = drink_breakdown.find(b => b.type === 'coffee');
      observations.push({ title: `Coffee count: ${c.count} — and it counts`, body: `Killer 2014 confirmed coffee at this level is net hydrating. Your ${c.count} cups added ~${c.effective_ml} ml of real hydration.` });
    }

    // ── Day-1 personalized insight (cold-start users with no logs yet) ──
    // Builds an immediate, science-grounded read from setup so the Insights
    // tab is useful from minute one — not a "come back after 3 days" wall.
    let day_one_insight = null;
    if (allLogs.length === 0) {
      const setup       = data.setup || {};
      const weightKg    = setup.weight_kg || 70;
      const activity    = setup.activity_level || 'moderate';
      const climate     = setup.climate || 'mild';
      const targetL     = (target_ml / 1000).toFixed(1);
      const morningMl   = Math.round(target_ml * 0.20);
      const noonMl      = Math.round(target_ml * 0.50);
      const eveningMl   = Math.round(target_ml * 0.85);
      day_one_insight = {
        title: `Your ${targetL}L blueprint`,
        subtitle: `${weightKg}kg · ${activity} · ${climate} climate`,
        formula: `Watson 1980 baseline + Sawka 2007 activity bump + ${climate}-climate adjustment = ${target_ml}ml/day`,
        milestones: [
          { hour: 10, ml: morningMl,  label: `${morningMl}ml by 10am`, citation: 'Forbes 2019 — front-load fights universal AM under-hydration' },
          { hour: 14, ml: noonMl,     label: `${noonMl}ml by 2pm`,    citation: 'Cheuvront 2014 — even spacing beats peaks' },
          { hour: 19, ml: eveningMl,  label: `${eveningMl}ml by 7pm`,  citation: 'Rosinger 2019 — finish heavy intake before sleep window' },
        ],
        proof_lines: [
          'Pross 2017: 1% body-water loss measurably degrades cognition and mood.',
          'Killer 2014: coffee ≤4 cups counts toward hydration — the multiplier is in your beverage menu.',
          'Lally 2010: median 66 days for habit automaticity — the streak chip is built around this.',
        ],
        cta: 'Log your first glass to unlock personalized analysis',
      };
    }

    // Lifetime fetch: per-day quality = clamped(ml / target × 100) since anchor.
    const lifetimeQualityByDate = await (async () => {
      const out = {};
      if (!anchor.anchorMs) return out;
      try {
        const snap = await logsCol(deviceId)
          .orderBy('logged_at', 'desc')
          .limit(Math.min(win.daysSinceAnchor * 25, 5000))
          .get();
        const sums = {};
        for (const d of snap.docs) {
          const x = d.data();
          const ds = x.date;
          if (!ds || typeof ds !== 'string') continue;
          if (anchor.anchorDateStr && ds < anchor.anchorDateStr) continue;
          sums[ds] = (sums[ds] || 0) + Number(x.effective_ml || x.ml || 0);
        }
        for (const [ds, ml] of Object.entries(sums)) {
          if (ml > 0) {
            out[ds] = Math.max(0, Math.min(100, Math.round((ml / target_ml) * 100)));
          }
        }
      } catch { /* fall back to empty */ }
      return out;
    })();
    const { computeStandardOutputs } = require('./lib/score-lifetime');

    // HK blend: hydration logged in Apple Health (water bottles, third-party
    // trackers) fills no-log days. Manual sips still win on days they exist.
    const { blendQualityByDate } = require('./lib/healthkit/blend');
    const { merged: blendedQualityByDate } = await blendQualityByDate({
      coach: 'water',
      manualQualityByDate: lifetimeQualityByDate,
      deviceId,
      anchorDateStr: anchor.anchorDateStr,
      todayDateStr: win.todayDate,
      db: admin.firestore(),
      scoringContext: { goalMl: target_ml },
      utcOffsetMinutes: anchor.utcOffsetMinutes || 0,
    });

    const std = computeStandardOutputs({
      qualityByDate: blendedQualityByDate,
      todayDate: win.todayDate,
      anchorDate: anchor.anchorDateStr,
      daysSinceAnchor: win.daysSinceAnchor,
    });

    return res.json({
      setup_completed: true,
      range,
      effective_start_date: effectiveStartDate,
      effective_days: days,
      days_since_anchor: win.daysSinceAnchor,
      anchor_date: anchor.anchorDateStr,
      is_clamped: win.isClamped,
      score_today: std.score_today,
      score_7d_smoothed: std.score_7d_smoothed,
      score_lifetime: std.score_lifetime,
      missed_days: std.missed_days,
      score,
      score_grade: grade,
      score_gates,
      hydration_score: hydrationScore,
      signal_points,
      daily_curve,
      drink_breakdown,
      daily_logs,
      circadian,
      best_day,
      worst_day,
      ai_reads,
      aha_moments: await (async () => {
        try {
          const { buildHKAhaCards } = require('./lib/healthkit/aha-cards');
          const hkCards = await buildHKAhaCards({ coach: 'water', deviceId, db: admin.firestore() });
          return hkCards.length ? [...hkCards, ...(aha_moments || [])] : aha_moments;
        } catch { return aha_moments; }
      })(),
      observations,
      personal_formula,
      day_one_insight,
      streak,
      longest_streak:   data.longest_streak || 0,
      completion:       Math.round(completion * 100) / 100,
      avg_ml,
      best_day_ml:      Math.round(best_ml),
      total_ml:         Math.round(total_ml),
      target_ml,
    });
  } catch (e) {
    log.error('[water] /analysis:', e);
    return res.status(500).json({ error: 'Failed' });
  }
});

// ════════════════════════════════════════════════════════════════
// GET /actions — Actions tab payload
// Mirrors /api/fasting/actions contract.
// Cadence: "Coach reviews every 3 days" (water is daily-tempo).
// ════════════════════════════════════════════════════════════════
router.get('/actions', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const [actSnap, wSnap, logsSnap] = await Promise.all([
      actionsCol(deviceId).orderBy('generated_at', 'desc').limit(30).get(),
      waterDoc(deviceId).get(),
      logsCol(deviceId).orderBy('logged_at', 'desc').limit(60).get(),
    ]);

    const allActions = actSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const wData      = wSnap.exists ? wSnap.data() : {};
    const logs       = logsSnap.docs.map(d => d.data());

    // Cadence — water is daily, refresh every 3 days
    const lastBatchAt = allActions[0]?.generated_at;
    const lastBatchMs = lastBatchAt?._seconds
      ? lastBatchAt._seconds * 1000
      : (lastBatchAt ? new Date(lastBatchAt).getTime() : null);
    const daysSinceBatch = lastBatchMs ? Math.floor((Date.now() - lastBatchMs) / (24 * 3600 * 1000)) : null;
    const daysUntilNext  = lastBatchMs ? Math.max(0, 3 - daysSinceBatch) : null;
    const totalLogged    = logs.length;

    const cadence = lastBatchMs ? {
      status:           'live',
      last_review_at:   new Date(lastBatchMs).toISOString(),
      days_until_next:  daysUntilNext,
      next_review_label: new Date(lastBatchMs + 3 * 24 * 3600 * 1000).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
      total_logs:       totalLogged,
    } : {
      status:     'pending',
      total_logs: totalLogged,
    };

    // Active
    const isCancelled = (a) => a.status === 'cancelled' || a.status === 'skipped';
    const active = allActions.filter(a =>
      a.kind !== 'prescription' &&
      (!a.status || a.status === 'active' || a.status === 'pending')
    );
    const WHEN_LABEL = {
      morning: 'This morning', afternoon: 'This afternoon', evening: 'This evening',
      anytime: 'Today', now: 'Right now', today: 'Today', next: 'Today',
    };
    const actions = active.slice(0, 4).map(a => {
      const rawWhen = a.when || a.cadence_text || a.when_to_do || a.priority || 'today';
      const when    = WHEN_LABEL[String(rawWhen).toLowerCase()] || rawWhen;
      return {
        id:           a.id,
        title:        a.title || a.text || 'Action',
        why:          a.why   || a.evidence_text || a.reasoning || 'Based on your hydration data.',
        how:          a.how   || a.micro_step    || a.action_text || a.text || '',
        when,
        proof:        a.proof || a.science || '',
        status:       'active',
        hit_rate:     a.hit_count    || a.completed_count || 0,
        target_count: a.target_count || 1,
        archetype:    a.archetype    || null,
        created_at:   a.generated_at || null,
      };
    });

    // History
    const history = allActions
      .filter(a => a.status === 'completed' || isCancelled(a))
      .slice(0, 12)
      .map(a => {
        const tsCandidate = a.completed_at || a.cancelled_at || a.skipped_at;
        const ms = tsCandidate?._seconds
          ? tsCandidate._seconds * 1000
          : (tsCandidate ? new Date(tsCandidate).getTime() : null);
        return {
          id:             a.id,
          title:          a.title || a.text || 'Action',
          date_label:     ms ? new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—',
          completed_at:   ms ? new Date(ms).toISOString() : null,
          status:         isCancelled(a) ? 'cancelled' : 'completed',
          outcome:        a.outcome_grade || (isCancelled(a) ? 'cancelled' : 'kept'),
          outcome_grade:  a.outcome_grade || (isCancelled(a) ? 'abandoned' : 'kept'),
          outcome_reason: a.outcome_reason || null,
        };
      });

    // Stats
    const completed_total = allActions.filter(a => a.status === 'completed').length;
    const cancelled_total = allActions.filter(isCancelled).length;
    const decided         = completed_total + cancelled_total;
    const stats = {
      active_count:       active.length,
      completed_total,
      cancelled_total,
      skipped_total:      cancelled_total, // alias for forward-compat
      follow_through_pct: decided ? Math.round((completed_total / decided) * 100) : 0,
    };

    return res.json({ cadence, prescription: null, actions, history, stats });
  } catch (e) {
    log.error('[water] /actions:', e);
    return res.status(500).json({ error: 'Failed' });
  }
});


// ─── POST /chat ───────────────────────────────────────────────
router.post('/chat', async (req, res) => {
  try {
    const { deviceId, message, proactive_context } = req.body;
    if (!deviceId || !message) return res.status(400).json({ error: 'deviceId + message required' });
    if (!checkChatRate(deviceId)) return res.status(429).json({ error: 'Too many messages. Wait a moment.' });
    const safeMessage = String(message).trim().slice(0, 600);
    if (!safeMessage) return res.status(400).json({ error: 'message required' });

    const language = resolveLanguage(req);

    const context  = await getCachedContext(deviceId);
    const histSnap = await chatsCol(deviceId)
      .orderBy('created_at', 'desc')
      .limit(24)
      .get();

    const history = histSnap.docs
      .map(mapDoc)
      .filter(m => !m.is_proactive)
      .sort((a, b) => (a.created_at?.toMillis?.() || 0) - (b.created_at?.toMillis?.() || 0))
      .slice(-8)
      .flatMap(m => [
        { role: 'user',      content: m.user_message || '' },
        { role: 'assistant', content: m.ai_response || '' },
      ]);

    const threadNotes = {
      goal_reached:    'User responded after hitting goal. Do NOT congratulate again. Focus on what to protect now — timing quality, not volume.',
      behind_pace:     'User is behind pace responding to a pace alert. One instruction: exact ml to drink, exact timeframe. No theory, no softening.',
      low_start:       'User has not started drinking yet today. One move: give the exact amount to drink right now and why it matters. No recap.',
      low_water:       'Low water, late in the day. Give the 1-2 most achievable moves. No catch-up sermon.',
      streak_at_risk:  'Streak at risk. One concrete move to protect it. Calm and matter-of-fact.',
      streak_milestone:'User just hit a streak milestone. Acknowledge in one sentence — no more. Then redirect to the next move.',
    };

    let systemPrompt = appendLanguageInstruction([
      'You are the Water Coach inside Pulse — a precision wellness app.',
      'You coach behavior change using the user\'s actual numbers. You know IOM weight-based goals, beverage hydration multipliers, cortisol-window front-loading, taper timing, pace-gap math, sweat-rate recovery, and cross-agent links with sleep and mood.',
      '',
      'RULES:',
      '- NEVER open with praise, validation, or agreement. Banned first words: "Great", "Nice", "Good", "Amazing", "Congrats", "Well done", "Awesome", "You\'re", "Absolutely", "Sure", "Of course", "Exactly". Start with a data observation, a number, or a direct instruction.',
      '- VERIFY CLAIMS: if the user says they hit their goal but context shows < 95%, correct that in the first sentence (state actual % and ml remaining), then answer their question. Never validate a false claim.',
      '- Use the exact numbers from context: logged ml, goal ml, streak, pace gap, schedule window, time of day.',
      '- If behind pace: give the exact ml gap and the deadline (next block or taper window).',
      '- If goal is genuinely hit: tell them one thing to protect now — not to drink more.',
      '- Max 3 numbered steps when a plan is needed. No more.',
      '- Use sleep/mood data once if relevant. Never repeat it.',
      '- Banned phrases: "overall", "it\'s important to", "you may be experiencing", "stay hydrated", "make sure to", "remember to", "keep in mind", "don\'t forget".',
      '- Never invent numbers absent from context.',
      '- Under 100 words unless user explicitly asks for depth. No filler sentences.',
      '- Tone: sharp performance coach. Not a wellness blog. Not a cheerleader.',
      '',
      'USER DATA:',
      context,
      proactive_context ? `\nTHREAD: ${threadNotes[proactive_context] || `User is replying to a proactive message (type: ${proactive_context}).`}` : '',
    ].filter(Boolean).join('\n'), language);

    // Silent HK enrichment — water samples, sweat-rate cues when granted.
    try {
      const { buildHKContext, appendHKContext } = require('./lib/healthkit/context-builder');
      const hkBlock = await buildHKContext({ db: admin.firestore(), deviceId, coach: 'water', days: 7 });
      systemPrompt = appendHKContext(systemPrompt, hkBlock);
    } catch { /* best-effort */ }

    const completion = await openai.chat.completions.create({
      model: AI.CHAT_STREAM,
      max_completion_tokens: 175,
      messages: [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: safeMessage },
      ],
    });

    const reply = completion.choices[0]?.message?.content?.trim() || 'I could not generate a response. Try again.';

    const ref = await chatsCol(deviceId).add({
      user_message: safeMessage,
      ai_response: reply,
      is_proactive: false,
      is_read: true, language,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ reply, message_id: ref.id });
  } catch (e) {
    log.error('[water] POST /chat:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /chat/stream — SSE streaming
// ─────────────────────────────────────────────────────────────────
const { mountChatStream: _mountChatStreamWater } = require('./lib/chat-stream');
_mountChatStreamWater(router, {
  agentName: 'water',
  openai, admin, chatsCol,
  rateLimitCheck: checkChatRate,
  model: AI.CHAT_STREAM, maxTokens: 175,
  buildPrompt: async (deviceId /* , message */) => {
    const context = await getCachedContext(deviceId);
    const systemPrompt = `You are the Water Coach inside Pulse. Use exact numbers from context. Under 100 words. Sharp performance coach. Banned openings: praise/validation.\n\nUSER DATA:\n${context}`;
    const histSnap = await chatsCol(deviceId).orderBy('created_at', 'desc').limit(24).get();
    const history = histSnap.docs.map(d => d.data())
      .filter(m => !m.is_proactive)
      .reverse()
      .slice(-8)
      .flatMap(m => {
        // Water uses both shapes — handle both
        if (m.role && m.content) return [{ role: m.role, content: m.content }];
        return [
          { role: 'user',      content: m.user_message || '' },
          { role: 'assistant', content: m.ai_response  || '' },
        ];
      })
      .filter(m => m.content);
    return { systemPrompt, history };
  },
});

// ─── GET /chat/messages ───────────────────────────────────────
router.get('/chat/messages', async (req, res) => {
  try {
    const { deviceId, before, limit: limitParam } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const pageSize = Math.min(parseInt(limitParam, 10) || 60, 120);

    let query = chatsCol(deviceId)
      .orderBy('created_at', 'desc')
      .limit(pageSize + 1);

    if (before) {
      const cursorDoc = await chatsCol(deviceId).doc(before).get();
      if (cursorDoc.exists) query = query.startAfter(cursorDoc);
    }

    const snap = await query.get();
    const hasMore = snap.docs.length > pageSize;
    const docs = hasMore ? snap.docs.slice(0, pageSize) : snap.docs;
    // Reverse to chronological order for rendering
    docs.reverse();

    const messages = [];
    for (const doc of docs) {
      const data = doc.data();

      if (data.is_proactive) {
        messages.push({
          id: doc.id,
          role: 'assistant',
          content: data.content || '',
          is_proactive: true,
          proactive_type: data.proactive_type || 'check_in',
          is_read: data.is_read || false,
          created_at: toIso(data.created_at),
        });
        continue;
      }

      if (data.user_message) {
        messages.push({
          id: `${doc.id}_u`,
          role: 'user',
          content: data.user_message,
          is_proactive: false,
          is_read: true,
          created_at: toIso(data.created_at),
        });
      }

      if (data.ai_response) {
        messages.push({
          id: doc.id,
          role: 'assistant',
          content: data.ai_response,
          is_proactive: false,
          is_read: data.is_read || false,
          created_at: toIso(data.created_at),
        });
      }
    }

    res.json({ messages, has_more: hasMore, oldest_id: docs[0]?.id || null });
  } catch (e) {
    log.error('[water] GET /chat/messages:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /chat/unread ─────────────────────────────────────────
router.get('/chat/unread', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const snap = await chatsCol(deviceId)
      .where('is_proactive', '==', true)
      .where('is_read', '==', false)
      .limit(10)
      .get();

    const messages = dedupeProactiveList(snap.docs
      .map(doc => ({
        id: doc.id,
        content: doc.data().content || '',
        proactive_type: doc.data().proactive_type || 'check_in',
        content_key: doc.data().content_key || buildMessageKey(doc.data().content || ''),
        date_str: doc.data().date_str || null,
        is_read: doc.data().is_read || false,
        created_at: toIso(doc.data().created_at),
      }))
    );

    res.json({ messages });
  } catch (e) {
    log.error('[water] GET /chat/unread:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /chat/read ──────────────────────────────────────────
router.post('/chat/read', async (req, res) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const snap = await chatsCol(deviceId)
      .where('is_proactive', '==', true)
      .where('is_read', '==', false)
      .get();

    const batch = db().batch();
    snap.docs.forEach(doc => batch.update(doc.ref, { is_read: true }));
    await batch.commit();

    res.json({ ok: true, marked: snap.docs.length });
  } catch (e) {
    log.error('[water] POST /chat/read:', e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// PROACTIVE CRON — every hour, capped, lower-spam decision rules
// ═══════════════════════════════════════════════════════════════
// ─── Local-time helpers for cron ─────────────────────────────
function getUserLocalNow(utcOffsetMinutes) {
  const serverNow = new Date();
  if (typeof utcOffsetMinutes !== 'number' || Number.isNaN(utcOffsetMinutes)) return serverNow;
  return new Date(serverNow.getTime() + utcOffsetMinutes * 60 * 1000);
}

function dateStrLocal(localNow) {
  const y  = localNow.getUTCFullYear();
  const mo = String(localNow.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(localNow.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${dd}`;
}

const _waterCronTick = async () => {
    const usersSnap = await db().collection('wellness_users').get();

    for (const user of usersSnap.docs) {
      const deviceId = user.id;

      try {
        const waterSnap = await waterDoc(deviceId).get();
        if (!waterSnap.exists || !waterSnap.data()?.setup_completed) continue;

        // notif_enabled + DND gate (cron-user-context reads aliveChecks profile)
        const notifCtx = await getUserNotifContext(db(), deviceId);
        if (!notifCtx.allowsProactive) continue;

        const waterData  = waterSnap.data() || {};
        // Prefer profile.utc_offset_minutes (canonical) but fall back to
        // water-doc's older copy for back-compat with users who haven't
        // re-opened the app since the unified profile field rolled out.
        const offsetMin = notifCtx.utcOffsetMinutes ?? waterData.utc_offset_minutes ?? null;
        const localNow   = getUserLocalNow(offsetMin);
        const hour       = localNow.getUTCHours();
        if (hour < 8 || hour > 21) continue;

        const today      = dateStrLocal(localNow);
        const [logsSnap, recentChatSnap] = await Promise.all([
          logsCol(deviceId).where('date', '==', today).get(),
          chatsCol(deviceId).orderBy('created_at', 'desc').limit(16).get(),
        ]);

        const setup      = waterData.setup || {};
        const goalHistory = getGoalHistory(setup, waterData.setup_completed_at);
        const goalForDate = (ds) => resolveGoalForDate(goalHistory, ds, getGoalState(setup).goalMl);
        const goalMl = goalForDate(today);
        const wake       = setup.wake_time_min ?? 420;
        const bed        = setup.bed_time_min ?? 1380;
        const currentMin = hour * 60 + localNow.getUTCMinutes();
        const awakeSpan  = Math.max(480, bed - wake);
        const expectedPct = clamp((currentMin - wake) / awakeSpan, 0, 1);
        const loggedMl = logsSnap.docs.reduce((sum, doc) => {
          const data = doc.data();
          return sum + (data.effective_ml || Math.round((data.ml || 0) * (BEV_MULT[data.beverage_type] || 1)));
        }, 0);
        const pct = loggedMl / Math.max(goalMl, 1);
        const recentProactives = recentChatSnap.docs
          .map(doc => ({ id: doc.id, ...doc.data() }))
          .filter(message => message.is_proactive)
          .slice(0, 8);

        const storedCountDate = waterData.proactive_count_date || '';
        const storedCount     = storedCountDate === today ? (waterData.proactive_count_today || 0) : 0;
        if (storedCount >= MAX_PROACTIVES_PER_DAY) continue;

        let proactiveType = null;
        let content       = null;
        const updates     = {
          proactive_count_date: today,
          proactive_count_today: storedCount,
        };

        if (pct >= 1 && hour >= 12 && waterData.last_goal_reached_date !== today) {
          proactiveType = 'goal_reached';
          content = `🎉 Goal hit — ${Math.round(loggedMl / 100) / 10}L locked in today. Coast now: protect timing quality, not volume.`;
          updates.last_goal_reached_date = today;
        } else if (logsSnap.empty && hour >= 8 && hour < 11 && currentMin >= wake + 90 && waterData.last_morning_nudge_date !== today) {
          // Morning nudge: awake 90+ min, nothing logged yet
          proactiveType = 'low_start';
          content = `🌅 You have been up for over an hour and the tank is still empty. 500 ml now sets the whole day up.`;
          updates.last_morning_nudge_date = today;
        } else if (logsSnap.empty && hour >= 20) {
          const allLogsSnap = await logsCol(deviceId).orderBy('logged_at', 'desc').limit(300).get();
          const allLogs = allLogsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
          const { byDate } = aggregateLogs(setup, allLogs);
          const streak = computeStreakFromOffset(byDate, goalForDate, 1);
          if (streak >= 3 && waterData.last_streak_reminder_date !== today) {
            proactiveType = 'streak_at_risk';
            content = `🔥 No water logged yet today and your ${streak}-day streak is still alive. One meaningful drink now protects the run.`;
            updates.last_streak_reminder_date = today;
          }
        } else if (pct < expectedPct - 0.25 && currentMin > wake + 180 && currentMin < Math.min(bed - 210, wake + 10 * 60)) {
          proactiveType = 'behind_pace';
          const gapMl = Math.max(200, Math.round((goalMl * expectedPct - loggedMl) / 50) * 50);
          content = `💧 ${gapMl} ml behind pace right now. Close that before dinner and tonight stays clean.`;
        } else if (pct < 0.75 && hour >= 18 && hour <= 21) {
          proactiveType = 'low_water';
          const remaining = Math.max(200, Math.round((goalMl - loggedMl) / 50) * 50);
          content = `⚠️ ${Math.round(pct * 100)}% of goal with the day closing — ${remaining} ml left before your 2-hour taper window.`;
        } else if (pct >= 1 && hour >= 10 && hour <= 18 && !String(waterData.last_streak_celebrated || '').startsWith(today)) {
          // Streak milestone check — only when goal is met today and milestone not yet celebrated
          const allStreakSnap = await logsCol(deviceId).orderBy('logged_at', 'desc').limit(300).get();
          const allStreakLogs = allStreakSnap.docs.map(d => ({ id: d.id, ...d.data() }));
          const { byDate: streakByDate } = aggregateLogs(setup, allStreakLogs);
          const currentStreak = computeCurrentStreak(streakByDate, goalForDate);
          const milestoneKey  = `${today}_${currentStreak}`;
          if (STREAK_MILESTONES.includes(currentStreak) && waterData.last_streak_celebrated !== milestoneKey) {
            proactiveType = 'streak_milestone';
            content = `🔥 ${currentStreak}-day streak. That is not luck — it is a system working. Same moves tomorrow.`;
            updates.last_streak_celebrated = milestoneKey;
          }
        }

        if (!proactiveType || !content) continue;
        if (shouldSkipProactiveMessage({
          recentMessages: recentProactives,
          proactiveType,
          content,
          today,
        })) continue;

        await chatsCol(deviceId).add({
          content,
          proactive_type: proactiveType,
          content_key: buildMessageKey(content),
          date_str: today,
          is_proactive: true,
          is_read: false,
          created_at: admin.firestore.FieldValue.serverTimestamp(),
        });

        updates.proactive_count_today = storedCount + 1;
        await waterDoc(deviceId).set(updates, { merge: true });
      } catch (uErr) {
        log.error(`[water] proactive failed for ${deviceId}:`, uErr.message);
      }
    }
};

if (shouldRunCron()) {
  cron.schedule('0 * * * *', withCron('water:hourly-proactives', _waterCronTick, {
    ttlMs: 25 * 60_000,
  }), { timezone: 'UTC' });
}

// ─── GET /wearable-insights ─────────────────────────────────────────────
// Surfaces water samples logged via HealthKit (Apple Watch reminders,
// smart bottles, third-party hydration apps that write to Health).
// Returns { has_data: false, cards: [] } when the user has no HK water —
// the FE component auto-hides on that response, preserving silent-magic.
router.get('/wearable-insights', async (req, res) => {
  const deviceId = (req.query.deviceId || '').toString();
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  try {
    const { buildWearableInsights } = require('./lib/healthkit/wearable-insights');
    const days = Math.min(parseInt(req.query.days || '30', 10) || 30, 90);
    const payload = await buildWearableInsights({
      db: admin.firestore(), deviceId, coach: 'water', days,
    });
    res.json(payload);
  } catch (err) {
    res.json({ has_data: false, cards: [] });
  }
});

module.exports = router;
