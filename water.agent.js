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
const router  = express.Router();
const admin   = require('firebase-admin');
const { OpenAI } = require('openai');
const cron    = require('node-cron');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const db     = () => admin.firestore();

// ─── Context cache (5-min TTL, invalidated on write) ─────────
const _ctxCache = new Map();
const CTX_TTL   = 5 * 60 * 1000;

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

function computeCurrentStreak(byDate, goalMl) {
  let streak = 0;
  const d = new Date();
  while (true) {
    const key = dateStr(d);
    if ((byDate[key]?.effective_ml || 0) >= goalMl) {
      streak++;
      d.setDate(d.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

function computeLongestStreak(byDate, goalMl) {
  const dates = Object.keys(byDate).sort();
  if (!dates.length) return 0;

  let longest = 0;
  let current = 0;
  let prevDate = null;

  for (const ds of dates) {
    if ((byDate[ds]?.effective_ml || 0) < goalMl) {
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

function computeHydrationScore(byDate, goalMl) {
  const recentKeys = buildDateRangeKeys(7);

  const goalAdherence = Math.round(avg(recentKeys.map(key =>
    clamp(((byDate[key]?.effective_ml || 0) / Math.max(goalMl, 1)) * 100, 0, 100)
  )));

  const consistency = Math.round(
    (recentKeys.filter(key => (byDate[key]?.effective_ml || 0) >= goalMl * 0.8).length / recentKeys.length) * 100
  );

  const frontLoad = Math.round(
    (recentKeys.filter(key => (byDate[key]?.parts?.morning || 0) >= Math.max(300, goalMl * 0.22)).length / recentKeys.length) * 100
  );

  const timing = Math.round(
    (recentKeys.filter(key => (byDate[key]?.late_ml || 0) <= 250).length / recentKeys.length) * 100
  );

  const beverageQuality = Math.round(avg(recentKeys.map(key => {
    const day = byDate[key] || emptyDay();
    if (!day.effective_ml) return 60;
    return clamp((day.water_friendly_ml / day.effective_ml) * 100, 0, 100);
  })));

  const score = Math.min(100, Math.round(
    goalAdherence   * 0.35 +
    consistency     * 0.25 +
    frontLoad       * 0.15 +
    timing          * 0.15 +
    beverageQuality * 0.10
  ));

  const label = score >= 85
    ? 'Excellent'
    : score >= 70
    ? 'Strong'
    : score >= 55
    ? 'Good'
    : score >= 35
    ? 'Building'
    : 'Starting';

  return {
    score,
    label,
    components: {
      goal_adherence: goalAdherence,
      consistency,
      front_load: frontLoad,
      timing,
      beverage_quality: beverageQuality,
    },
  };
}

function determineStage(daysLogged) {
  if (!daysLogged) return 0;
  if (daysLogged < 4) return 1;
  if (daysLogged < 10) return 2;
  return 3;
}

function buildDayPartBreakdown(byDate, rangeKeys, goalMl) {
  const totals = DAY_PARTS.reduce((acc, key) => ({ ...acc, [key]: 0 }), {});

  for (const key of rangeKeys) {
    const day = byDate[key];
    if (!day) continue;
    for (const part of DAY_PARTS) totals[part] += day.parts[part] || 0;
  }

  const divisor = Math.max(1, rangeKeys.length);

  return [
    { key: 'morning',   label: 'Morning',   ml: Math.round(totals.morning / divisor),   pct: Math.round(clamp((totals.morning / divisor)   / Math.max(goalMl, 1) * 100, 0, 100)) },
    { key: 'midday',    label: 'Midday',    ml: Math.round(totals.midday / divisor),    pct: Math.round(clamp((totals.midday / divisor)    / Math.max(goalMl, 1) * 100, 0, 100)) },
    { key: 'afternoon', label: 'Afternoon', ml: Math.round(totals.afternoon / divisor), pct: Math.round(clamp((totals.afternoon / divisor) / Math.max(goalMl, 1) * 100, 0, 100)) },
    { key: 'evening',   label: 'Evening',   ml: Math.round(totals.evening / divisor),   pct: Math.round(clamp((totals.evening / divisor)   / Math.max(goalMl, 1) * 100, 0, 100)) },
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

function buildObservations({ goalMl, avg7d, streak, longestStreak, recentKeys, byDate, hydrationScore }) {
  const observations = [];
  const goalRatio    = avg7d / Math.max(goalMl, 1);
  const lateDays     = recentKeys.filter(key => (byDate[key]?.late_ml || 0) > 250).length;
  const frontLoadDays = recentKeys.filter(key => (byDate[key]?.parts?.morning || 0) >= Math.max(300, goalMl * 0.22)).length;
  const zeroDays     = recentKeys.filter(key => (byDate[key]?.effective_ml || 0) < 150).length;

  if (goalRatio >= 0.9) {
    observations.push({
      title: 'You are close to automatic',
      body: `Your 7-day average is ${Math.round(goalRatio * 100)}% of goal. The biggest opportunity now is preserving timing quality, not just drinking more.`,
    });
  } else if (goalRatio >= 0.7) {
    observations.push({
      title: 'Consistency is the lever',
      body: `You are averaging ${Math.round(goalRatio * 100)}% of goal. A single repeatable anchor habit would close most of the gap.`,
    });
  } else {
    observations.push({
      title: 'You are under-drinking on the calendar, not just the clock',
      body: `Your 7-day average is only ${Math.round(goalRatio * 100)}% of goal, so the fix is more daily starts and fewer zero-intake days.`,
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

async function buildCrossAgentInsights(deviceId, byDate, goalMl, rangeKeys, streak) {
  const insights = [];
  const rangeSet = new Set(rangeKeys);

  // Sleep correlation
  try {
    const sleepSnap = await userDoc(deviceId)
      .collection('agents').doc('sleep')
      .collection('sleep_logs')
      .orderBy('date', 'desc')
      .limit(21)
      .get();

    const sleepDays = sleepSnap.docs.map(d => d.data()).filter(d => rangeSet.has(d.date));
    const pairs     = sleepDays.filter(d => byDate[d.date]);

    if (pairs.length >= 5) {
      const good = pairs.filter(d => (d.quality_score || 0) >= 70);
      const low  = pairs.filter(d => (d.quality_score || 0) < 70);

      if (good.length >= 2 && low.length >= 2) {
        const avgGood = Math.round(avg(good.map(d => byDate[d.date]?.effective_ml || 0)));
        const avgLow  = Math.round(avg(low.map(d => byDate[d.date]?.effective_ml || 0)));

        if (Math.abs(avgGood - avgLow) >= 250) {
          const better = avgGood > avgLow ? 'better' : 'worse';
          insights.push({
            type: 'sleep',
            emoji: '🌙',
            title: 'SLEEP CORRELATION',
            body: `On higher-quality sleep days, your average water intake is ${avgGood} ml versus ${avgLow} ml on lower-sleep days. Hydration appears ${better} when your recovery is better.`,
            stat: `${Math.round(avgGood / Math.max(goalMl, 1) * 100)}% of goal on good-sleep days`,
          });
        }
      }
    }
  } catch { /* non-fatal */ }

  // Mind correlation
  try {
    const mindSnap = await userDoc(deviceId)
      .collection('agents').doc('mind')
      .collection('mind_checkins')
      .orderBy('logged_at', 'desc')
      .limit(30)
      .get();

    const checkins = mindSnap.docs.map(d => d.data()).filter(d => rangeSet.has(d.date_str));
    const anxious  = checkins.filter(d => (d.anxiety || 0) >= 4 && byDate[d.date_str]);

    if (anxious.length >= 3) {
      const avgWater = Math.round(avg(anxious.map(d => byDate[d.date_str]?.effective_ml || 0)));
      insights.push({
        type: 'mind',
        emoji: '🧠',
        title: 'MOOD LINK',
        body: `On high-anxiety check-in days, your average intake is ${avgWater} ml. Thirst and agitation often stack together, so earlier hydration matters more than catch-up later.`,
        stat: `${Math.round(avgWater / Math.max(goalMl, 1) * 100)}% of goal on high-anxiety days`,
      });
    }
  } catch { /* non-fatal */ }

  // Hunger / thirst confusion
  const lowWaterDays = rangeKeys.filter(key => (byDate[key]?.effective_ml || 0) < goalMl * 0.7).length;
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

async function generateAnalysisInsight(setup, stats, hydrationScore, crossAgentInsights) {
  const fallback = fallbackAnalysisInsight(stats, hydrationScore);

  try {
    const prompt = [
      'You are a top-tier hydration strategist inside a premium wellness app.',
      'Return valid JSON only with keys: insight, formula.',
      'insight: 2-3 sentences, sharp, specific, numbers-driven, no fluff.',
      'formula: one line, memorable, practical, not cheesy.',
      'Do not use markdown.',
      '',
      `Goal: ${stats.goal_ml} ml`,
      `7-day average: ${stats.avg_7d} ml`,
      `Best day: ${stats.best_day} ml`,
      `Days logged in range: ${stats.days_logged}`,
      `Goal days: ${stats.goal_days}`,
      `Current streak: ${stats.streak}`,
      `Longest streak: ${stats.longest_streak}`,
      `Front-load days (last 7): ${stats.frontload_days}`,
      `Late-cutoff misses (last 7): ${stats.late_cutoff_days}`,
      `Hydration score: ${hydrationScore.score} (${hydrationScore.label})`,
      `Score components: ${JSON.stringify(hydrationScore.components)}`,
      `Setup: weight ${setup.weight_kg || '?'}kg, activity ${setup.activity_level || 'moderate'}, climate ${setup.climate || 'mild'}`,
      `Cross-agent: ${crossAgentInsights.map(c => `${c.title}: ${c.stat || c.body}`).join(' | ') || 'none'}`,
    ].join('\n');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      temperature: 0.45,
      max_tokens: 220,
      messages: [{ role: 'system', content: prompt }],
    });

    const raw = completion.choices[0]?.message?.content?.trim() || '';
    const json = JSON.parse(raw);

    return {
      insight: typeof json.insight === 'string' && json.insight.trim() ? json.insight.trim() : fallback.insight,
      formula: typeof json.formula === 'string' && json.formula.trim() ? json.formula.trim() : fallback.formula,
    };
  } catch (err) {
    console.error('[water] generateAnalysisInsight:', err.message);
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

function generateDailyActions({ setup, byDate, beverageTotals, goalMl, todayKey, crossAgentInsights = [] }) {
  const actions = [];
  const today   = byDate[todayKey] || emptyDay();
  const recentKeys = buildDateRangeKeys(7);
  const avg7    = Math.round(avg(recentKeys.map(key => byDate[key]?.effective_ml || 0)));
  const streak  = computeCurrentStreak(byDate, goalMl);
  const wake    = setup.wake_time_min ?? 420;
  const bed     = setup.bed_time_min ?? 1380;
  const now     = new Date();
  const nowMin  = now.getHours() * 60 + now.getMinutes();
  const daySpan = Math.max(480, bed - wake);
  const expectedPct = clamp((nowMin - wake) / daySpan, 0, 1);
  const actualPct   = (today.effective_ml || 0) / Math.max(goalMl, 1);
  const coffeeTea   = (beverageTotals.coffee || 0) + (beverageTotals.tea || 0);
  const sodaAlcohol = (beverageTotals.soda || 0) + (beverageTotals.alcohol || 0);
  const lateDays    = recentKeys.filter(key => (byDate[key]?.late_ml || 0) > 250).length;
  const frontLoadDays = recentKeys.filter(key => (byDate[key]?.parts?.morning || 0) >= Math.max(300, goalMl * 0.22)).length;
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

  if (['active', 'athlete'].includes(setup.activity_level) || avg7 < goalMl * 0.75) {
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

  const all = uniqueActions([...actions, ...defaults])
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 3);

  return all;
}

const CBLUE   = '#38BDF8';
const CTEAL   = '#22D3EE';
const CPURPLE = '#C084FC';
const CGREEN  = '#34D399';
const CORANGE = '#F59E0B';
const CWARN   = '#F59E0B';

async function ensureTodayActions(deviceId, { force = false } = {}) {
  const today = dateStr();

  const [waterSnap, activeSnap, recentLogsSnap] = await Promise.all([
    waterDoc(deviceId).get(),
    actionsCol(deviceId).where('status', '==', 'active').get(),
    logsCol(deviceId).orderBy('logged_at', 'desc').limit(300).get(),
  ]);

  const waterData     = waterSnap.data() || {};
  const setup         = waterData.setup || {};
  const activeActions = activeSnap.docs.map(mapDoc);

  if (!force && activeActions.some(a => a.date_str === today)) {
    return;
  }

  const goalMl = setup.daily_goal_ml || calcDailyGoal(setup);
  const logs   = recentLogsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const { byDate, beverageTotals } = aggregateLogs(setup, logs);
  const crossAgentInsights = await buildCrossAgentInsights(deviceId, byDate, goalMl, buildDateRangeKeys(14), computeCurrentStreak(byDate, goalMl));
  const newActions         = generateDailyActions({ setup, byDate, beverageTotals, goalMl, todayKey: today, crossAgentInsights });
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
    const [wRef, logsSnap, activeSnap] = await Promise.all([
      waterDoc(deviceId).get(),
      logsCol(deviceId).orderBy('logged_at', 'desc').limit(150).get(),
      actionsCol(deviceId).where('status', '==', 'active').get(),
    ]);

    if (!wRef.exists) return 'No setup data found.';

    const setup         = wRef.data()?.setup || {};
    const goal          = setup.daily_goal_ml || calcDailyGoal(setup);
    const logs          = logsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const { byDate, beverageTotals } = aggregateLogs(setup, logs);
    const todayKey      = dateStr();
    const today         = byDate[todayKey] || emptyDay();
    const recentKeys    = buildDateRangeKeys(7);
    const avg7          = Math.round(avg(recentKeys.map(key => byDate[key]?.effective_ml || 0)));
    const streak        = computeCurrentStreak(byDate, goal);
    const beverageMix   = buildBeverageMix(beverageTotals).slice(0, 3).map(item => `${item.label} ${item.pct}%`).join(', ') || 'mostly water';
    const activeActions = sortByTimestampField(activeSnap.docs.map(mapDoc), 'generated_at', 'asc')
      .slice(0, 3)
      .map(a => `- ${a.text}`)
      .join('\n') || '- none';

    let sleepNote = '';
    try {
      const sleepSnap = await userDoc(deviceId).collection('agents').doc('sleep')
        .collection('sleep_logs').orderBy('date', 'desc').limit(3).get();
      if (!sleepSnap.empty) {
        const scores = sleepSnap.docs.map(d => d.data()?.quality_score || 0).filter(Boolean);
        if (scores.length) sleepNote = `Recent sleep quality scores: ${scores.join(', ')} / 100.`;
      }
    } catch { /* non-fatal */ }

    return [
      `Setup: ${setup.weight_kg || '?'}kg, activity ${setup.activity_level || 'moderate'}, climate ${setup.climate || 'mild'}, wake ${minsToLabel(setup.wake_time_min ?? 420)}, bed ${minsToLabel(setup.bed_time_min ?? 1380)}.`,
      `Goal: ${goal} ml/day.`,
      `Today: ${today.effective_ml} ml (${Math.round(today.effective_ml / Math.max(goal, 1) * 100)}% of goal), ${today.log_count} logs, morning ${today.parts.morning || 0} ml, late ${today.late_ml || 0} ml.`,
      `7-day average: ${avg7} ml/day.`,
      `Current streak: ${streak} days.`,
      `Recent beverage mix: ${beverageMix}.`,
      sleepNote,
      'Current coach actions:',
      activeActions,
    ].filter(Boolean).join('\n');
  } catch (e) {
    console.error('[water] buildWaterContext:', e);
    return 'Context unavailable.';
  }
}

// ─── POST /setup ──────────────────────────────────────────────
router.post('/setup', async (req, res) => {
  try {
    const { deviceId, ...setupFields } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const goal  = calcDailyGoal(setupFields);
    const setup = { ...setupFields, daily_goal_ml: goal };

    await waterDoc(deviceId).set({
      setup,
      setup_completed: true,
      setup_completed_at: admin.firestore.FieldValue.serverTimestamp(),
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

    res.json({ ok: true, daily_goal_ml: goal });
  } catch (e) {
    console.error('[water] POST /setup:', e);
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

    res.json({ setup_completed: true, setup: snap.data().setup });
  } catch (e) {
    console.error('[water] GET /setup-status:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /log ────────────────────────────────────────────────
router.post('/log', async (req, res) => {
  try {
    const { deviceId, ml, beverage_type = 'water', date } = req.body;
    if (!deviceId || !ml) return res.status(400).json({ error: 'deviceId + ml required' });

    const multiplier  = BEV_MULT[beverage_type] || 1;
    const effectiveMl = Math.round(ml * multiplier);
    const logDate     = date || dateStr();

    const ref = await logsCol(deviceId).add({
      ml,
      effective_ml: effectiveMl,
      beverage_type,
      date: logDate,
      logged_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    invalidateCtx(deviceId);
    res.json({ ok: true, id: ref.id, effective_ml: effectiveMl });
  } catch (e) {
    console.error('[water] POST /log:', e);
    res.status(500).json({ error: e.message });
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

    const setup  = wSnap.exists ? (wSnap.data()?.setup || {}) : {};
    const goalMl = setup.daily_goal_ml || calcDailyGoal(setup);

    const logs = logsSnap.docs
      .map(mapDoc)
      .map(log => ({ ...log, logged_at: toIso(log.logged_at) }))
      .sort((a, b) => new Date(b.logged_at) - new Date(a.logged_at));

    const loggedMl = logs.reduce((sum, log) =>
      sum + (log.effective_ml || Math.round((log.ml || 0) * (BEV_MULT[log.beverage_type] || 1))), 0);

    const allLogs = allLogsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const { byDate } = aggregateLogs(setup, allLogs);
    const streak = computeCurrentStreak(byDate, goalMl);

    res.json({
      logs,
      entry_count: logs.length,
      logged_ml: loggedMl,
      remaining_ml: Math.max(0, goalMl - loggedMl),
      goal_ml: goalMl,
      streak,
    });
  } catch (e) {
    console.error('[water] GET /today:', e);
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
    console.error('[water] DELETE /log:', e);
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

    const setup  = wSnap.exists ? (wSnap.data()?.setup || {}) : {};
    const goalMl = setup.daily_goal_ml || calcDailyGoal(setup);
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
    });
  } catch (e) {
    console.error('[water] GET /logs:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /analysis ────────────────────────────────────────────
router.get('/analysis', async (req, res) => {
  try {
    const { deviceId, range = '30' } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const rangeDays = range === 'all' ? 365 : Math.min(parseInt(range, 10) || 30, 365);
    const fetchLimit = Math.min(rangeDays * 14, 2000);

    const [wSnap, logsSnap] = await Promise.all([
      waterDoc(deviceId).get(),
      logsCol(deviceId).orderBy('logged_at', 'desc').limit(fetchLimit).get(),
    ]);

    if (!wSnap.exists) return res.json({ stage: 0, stats: null });

    const waterData = wSnap.data() || {};
    const setup     = waterData.setup || {};
    const goalMl    = setup.daily_goal_ml || calcDailyGoal(setup);
    const logs      = logsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const { byDate, beverageTotals } = aggregateLogs(setup, logs);

    const rangeKeys     = buildDateRangeKeys(rangeDays);
    const daysLogged    = rangeKeys.filter(key => (byDate[key]?.log_count || 0) > 0).length;
    const streak        = computeCurrentStreak(byDate, goalMl);
    const longestStreak = computeLongestStreak(byDate, goalMl);
    const recent7Keys   = buildDateRangeKeys(7);
    const avg7d         = Math.round(avg(recent7Keys.map(key => byDate[key]?.effective_ml || 0)));
    const bestDay       = Math.max(0, ...rangeKeys.map(key => byDate[key]?.effective_ml || 0));
    const goalDays      = rangeKeys.filter(key => (byDate[key]?.effective_ml || 0) >= goalMl).length;
    const avgLoggedDay  = Math.round(avg(rangeKeys.filter(key => byDate[key]?.log_count > 0).map(key => byDate[key].effective_ml)));
    const frontloadDays = recent7Keys.filter(key => (byDate[key]?.parts?.morning || 0) >= Math.max(300, goalMl * 0.22)).length;
    const lateCutoffDays = recent7Keys.filter(key => (byDate[key]?.late_ml || 0) > 250).length;
    const hydrationScore = computeHydrationScore(byDate, goalMl);
    const stage          = determineStage(daysLogged);
    const dayParts       = buildDayPartBreakdown(byDate, rangeKeys, goalMl);
    const beverageMix    = buildBeverageMix(beverageTotals);
    const observations   = buildObservations({
      goalMl,
      avg7d,
      streak,
      longestStreak,
      recentKeys: recent7Keys,
      byDate,
      hydrationScore,
    });

    const heatmap = buildDateRangeKeys(28).map(key => ({
      date: key,
      ml: byDate[key]?.effective_ml || 0,
      pct: clamp((byDate[key]?.effective_ml || 0) / Math.max(goalMl, 1), 0, 1),
      logged: !!byDate[key]?.log_count,
    }));

    const chart = rangeKeys.map(key => {
      const d = new Date(`${key}T12:00:00`);
      const label = `${d.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]}`;
      return {
        date: key,
        ml: byDate[key]?.effective_ml || 0,
        label,
      };
    });

    const crossAgent = await buildCrossAgentInsights(deviceId, byDate, goalMl, rangeKeys, streak);

    let aiInsight = null;
    let personalFormula = null;

    if ((range === '30' || range === 'all') && daysLogged >= 3) {
      const cacheKey = `${range}_${daysLogged}_${avg7d}_${streak}_${lateCutoffDays}`;
      const cached = waterData.analysis_cache;

      if (cached && cached.key === cacheKey) {
        aiInsight       = cached.insight || null;
        personalFormula = cached.formula || null;
      } else {
        const generated = await generateAnalysisInsight(
          setup,
          {
            goal_ml: goalMl,
            avg_7d: avg7d,
            best_day: bestDay,
            days_logged: daysLogged,
            goal_days: goalDays,
            streak,
            longest_streak: longestStreak,
            frontload_days: frontloadDays,
            late_cutoff_days: lateCutoffDays,
          },
          hydrationScore,
          crossAgent
        );

        aiInsight       = generated.insight;
        personalFormula = generated.formula;

        await waterDoc(deviceId).set({
          analysis_cache: {
            key: cacheKey,
            insight: aiInsight,
            formula: personalFormula,
            generated_at: new Date().toISOString(),
          },
        }, { merge: true });
      }
    }

    res.json({
      stage,
      goal_ml: goalMl,
      stats: {
        days_logged: daysLogged,
        avg_7d: avg7d,
        avg_logged_day: avgLoggedDay || 0,
        best_day: bestDay,
        streak,
        longest_streak: longestStreak,
        goal_days: goalDays,
        consistency_pct: Math.round((goalDays / Math.max(rangeKeys.length, 1)) * 100),
        frontload_days: frontloadDays,
        late_cutoff_days: lateCutoffDays,
      },
      hydration_score: hydrationScore,
      day_parts: dayParts,
      beverage_mix: beverageMix,
      observations,
      ai_insight: aiInsight,
      personal_formula: personalFormula,
      heatmap,
      chart,
      cross_agent: crossAgent,
      setup,
    });
  } catch (e) {
    console.error('[water] GET /analysis:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /actions ─────────────────────────────────────────────
router.get('/actions', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    await ensureTodayActions(deviceId);

    const [activeSnap, recentSnap, waterSnap] = await Promise.all([
      actionsCol(deviceId).where('status', '==', 'active').get(),
      actionsCol(deviceId).orderBy('generated_at', 'desc').limit(20).get(),
      waterDoc(deviceId).get(),
    ]);

    const waterData = waterSnap.data() || {};
    const setup     = waterData.setup || {};
    const goalMl    = setup.daily_goal_ml || calcDailyGoal(setup);
    const wake      = setup.wake_time_min ?? 420;
    const bed       = setup.bed_time_min ?? 1380;
    const schedule  = buildSchedule(wake, bed, goalMl);

    const format = (action) => ({
      ...action,
      generated_at: toIso(action.generated_at),
      completed_at: toIso(action.completed_at),
    });

    const active = sortByTimestampField(activeSnap.docs.map(mapDoc), 'generated_at', 'asc').map(format);
    const currentGenIndex = active.length > 0
      ? Math.max(...active.map(a => a.gen_index || 0))
      : (waterData.last_action_gen_index || 0);

    const recent = recentSnap.docs.map(mapDoc).map(format);
    const completed = recent.filter(a =>
      ['done', 'skipped'].includes(a.status) && (a.gen_index || 0) === currentGenIndex
    );

    const prevGenIndex = currentGenIndex > 0
      ? Math.max(0, ...recent
          .filter(a => a.status === 'past')
          .map(a => a.gen_index || 0))
      : 0;

    const past = prevGenIndex > 0
      ? recent.filter(a => a.status === 'past' && (a.gen_index || 0) === prevGenIndex)
      : [];

    res.json({ active, completed, past, schedule, goal_ml: goalMl });
  } catch (e) {
    console.error('[water] GET /actions:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /action/:id/complete ───────────────────────────────
router.post('/action/:id/complete', async (req, res) => {
  try {
    const { deviceId } = req.body;
    const { id } = req.params;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    await actionsCol(deviceId).doc(id).update({
      status: 'done',
      completed_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true });
  } catch (e) {
    console.error('[water] complete action error:', e);
    res.status(500).json({ error: 'Failed' });
  }
});

// ─── POST /action/:id/skip ───────────────────────────────────
router.post('/action/:id/skip', async (req, res) => {
  try {
    const { deviceId } = req.body;
    const { id } = req.params;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const actionSnap = await actionsCol(deviceId).doc(id).get();
    const actionText = actionSnap.exists ? actionSnap.data().text : null;

    await actionsCol(deviceId).doc(id).update({ status: 'skipped' });

    if (actionText) {
      const snap     = await waterDoc(deviceId).get();
      const existing = snap.data()?.skip_history || [];
      const updated  = [...existing, actionText].slice(-20);
      await waterDoc(deviceId).set({ skip_history: updated }, { merge: true });
    }

    res.json({ success: true });
  } catch (e) {
    console.error('[water] skip action error:', e);
    res.status(500).json({ error: 'Failed' });
  }
});

// ─── POST /chat ───────────────────────────────────────────────
router.post('/chat', async (req, res) => {
  try {
    const { deviceId, message, proactive_context } = req.body;
    if (!deviceId || !message) return res.status(400).json({ error: 'deviceId + message required' });

    const context  = await getCachedContext(deviceId);
    const histSnap = await chatsCol(deviceId)
      .where('is_proactive', '==', false)
      .limit(14)
      .get();

    const history = histSnap.docs
      .map(mapDoc)
      .sort((a, b) => (a.created_at?.toMillis?.() || 0) - (b.created_at?.toMillis?.() || 0))
      .flatMap(m => [
        { role: 'user',      content: m.user_message || '' },
        { role: 'assistant', content: m.ai_response || '' },
      ]);

    const threadNotes = {
      goal_reached:    'The user is responding to a success/progress message. Build on momentum.',
      behind_pace:     'The user is responding because they are behind pace. Be concrete and non-judgmental.',
      low_water:       'The user is responding because intake is low. Prioritise the next 1-2 actions, not theory.',
      streak_at_risk:  'The user is responding to a streak-at-risk reminder. Make protecting momentum feel achievable.',
      streak_milestone:'The user is responding to a streak celebration. Acknowledge consistency and turn it into the next small win.',
    };

    const systemPrompt = [
      'You are the Water Coach inside a premium wellness app.',
      'You are precise, warm, and data-driven. You coach behavior change, not just hydration trivia.',
      'Use hydration science: body-weight goals, beverage multipliers, pacing across waking hours, front-loading early, tapering late, workout rehydration, and cross-agent links with sleep and mood.',
      '',
      'STYLE RULES:',
      '- Lead with the single most useful insight.',
      '- If they need a plan, give max 3 numbered steps.',
      '- If they are behind today, give exact ml and timing.',
      '- Mention cross-agent patterns only when the context supports them.',
      '- Never invent numbers not present in context.',
      '- Keep normal replies under 140 words unless the user asks for depth.',
      '',
      'USER CONTEXT:',
      context,
      proactive_context ? `\nTHREAD NOTE: ${threadNotes[proactive_context] || `The user is replying to a proactive message about ${proactive_context}.`}` : '',
    ].filter(Boolean).join('\n');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      temperature: 0.55,
      max_tokens: 280,
      messages: [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: message },
      ],
    });

    const reply = completion.choices[0]?.message?.content?.trim() || 'I could not generate a response. Try again.';

    const ref = await chatsCol(deviceId).add({
      user_message: message,
      ai_response: reply,
      is_proactive: false,
      is_read: true,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ reply, message_id: ref.id });
  } catch (e) {
    console.error('[water] POST /chat:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /chat/messages ───────────────────────────────────────
router.get('/chat/messages', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const snap = await chatsCol(deviceId)
      .orderBy('created_at', 'asc')
      .limit(120)
      .get();

    const messages = [];
    for (const doc of snap.docs) {
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

    res.json({ messages });
  } catch (e) {
    console.error('[water] GET /chat/messages:', e);
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

    const messages = snap.docs
      .map(doc => ({
        id: doc.id,
        content: doc.data().content || '',
        proactive_type: doc.data().proactive_type || 'check_in',
        created_at: toIso(doc.data().created_at),
      }))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json({ messages });
  } catch (e) {
    console.error('[water] GET /chat/unread:', e);
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
    console.error('[water] POST /chat/read:', e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// PROACTIVE CRON — every hour, capped, lower-spam decision rules
// ═══════════════════════════════════════════════════════════════
cron.schedule('0 * * * *', async () => {
  try {
    const now = new Date();
    const hour = now.getHours();
    if (hour < 8 || hour > 21) return;

    const usersSnap = await db().collection('wellness_users').get();

    for (const user of usersSnap.docs) {
      const deviceId = user.id;

      try {
        const [waterSnap, logsSnap] = await Promise.all([
          waterDoc(deviceId).get(),
          logsCol(deviceId).where('date', '==', dateStr()).get(),
        ]);

        if (!waterSnap.exists || !waterSnap.data()?.setup_completed) continue;

        const waterData  = waterSnap.data() || {};
        const setup      = waterData.setup || {};
        const goalMl     = setup.daily_goal_ml || calcDailyGoal(setup);
        const wake       = setup.wake_time_min ?? 420;
        const bed        = setup.bed_time_min ?? 1380;
        const today      = dateStr();
        const currentMin = hour * 60 + now.getMinutes();
        const awakeSpan  = Math.max(480, bed - wake);
        const expectedPct = clamp((currentMin - wake) / awakeSpan, 0, 1);
        const loggedMl = logsSnap.docs.reduce((sum, doc) => {
          const data = doc.data();
          return sum + (data.effective_ml || Math.round((data.ml || 0) * (BEV_MULT[data.beverage_type] || 1)));
        }, 0);
        const pct = loggedMl / Math.max(goalMl, 1);

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
          content = `🎉 Goal hit. You have already reached ${Math.round(goalMl / 100) / 10}L today. The move now is simple: coast, don’t flood the evening.`;
          updates.last_goal_reached_date = today;
        } else if (logsSnap.empty && hour >= 20) {
          const allLogsSnap = await logsCol(deviceId).orderBy('logged_at', 'desc').limit(300).get();
          const allLogs = allLogsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
          const { byDate } = aggregateLogs(setup, allLogs);
          const streak = computeCurrentStreak(byDate, goalMl);
          if (streak >= 3 && waterData.last_streak_reminder_date !== today) {
            proactiveType = 'streak_at_risk';
            content = `🔥 No water logged yet today and your ${streak}-day streak is still alive. One meaningful drink now protects the run.`;
            updates.last_streak_reminder_date = today;
          }
        } else if (pct < expectedPct - 0.28 && currentMin > wake + 180 && currentMin < bed - 180) {
          proactiveType = 'behind_pace';
          const gapMl = Math.max(200, Math.round((goalMl * expectedPct - loggedMl) / 50) * 50);
          content = `💧 You are behind pace by about ${gapMl} ml for this time of day. Fix the gap before dinner and the rest of tonight gets easier.`;
        } else if (pct < 0.75 && hour >= 18 && hour <= 20) {
          proactiveType = 'low_water';
          const remaining = Math.max(200, Math.round((goalMl - loggedMl) / 50) * 50);
          content = `⚠️ You are still only at ${Math.round(pct * 100)}% of goal with the day closing. Prioritise ${remaining} ml before your final 2-hour taper window.`;
        }

        if (!proactiveType || !content) continue;

        await chatsCol(deviceId).add({
          content,
          proactive_type: proactiveType,
          is_proactive: true,
          is_read: false,
          created_at: admin.firestore.FieldValue.serverTimestamp(),
        });

        updates.proactive_count_today = storedCount + 1;
        await waterDoc(deviceId).set(updates, { merge: true });
      } catch (uErr) {
        console.error(`[water] proactive failed for ${deviceId}:`, uErr.message);
      }
    }
  } catch (e) {
    console.error('[water] proactive cron:', e);
  }
});

console.log('[water] agent loaded ✓ — richer analysis, actions, chat, and proactive logic active');

module.exports = router;
