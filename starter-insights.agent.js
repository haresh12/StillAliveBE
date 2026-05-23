'use strict';
/**
 * starter-insights.agent.js — Day-1 reveal cards
 *
 * Mounted at /api/v2/starter-insights
 *
 * GET  /                Returns 3-5 ready-to-show cards built from the
 *                       user's personalize answers + 90-day HealthKit
 *                       backfill. This is the *first thing* a new user sees
 *                       after granting HK + finishing Personalize — before
 *                       they've logged anything in our app.
 * POST /refresh         Force a new LLM generation (rate-limited 1/day).
 *
 * Cache: results live at wellness_users/{deviceId}/wellness_meta/starter_insights
 * with `generated_at` + `generated_from` (rule_only | rule_plus_llm).
 *
 * Rule-only fallback runs FIRST and ALWAYS — if the LLM call fails or is
 * over-budget we still ship something useful. The LLM only *enhances* by
 * adding 1-2 narrative cards layered on top.
 */

const express = require('express');
const admin = require('firebase-admin');
const { OpenAI } = require('openai');
const router = express.Router();

const log = require('./lib/log');
const { AI } = require('./lib/ai/models');
const { appendLanguageInstruction } = require('./lib/i18n-prompt');

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// ─── Constants ────────────────────────────────────────────────────────────

const COACHES = ['sleep', 'mind', 'fitness', 'nutrition', 'water', 'fasting'];

const COACH_META = {
  sleep:     { emoji: '😴', accent: '#A78BFA' },
  mind:      { emoji: '🧠', accent: '#FB7185' },
  fitness:   { emoji: '💪', accent: '#34D399' },
  nutrition: { emoji: '🥗', accent: '#FBBF24' },
  water:     { emoji: '💧', accent: '#60A5FA' },
  fasting:   { emoji: '🔥', accent: '#F97316' },
};

// LLM gen rate-limit: 1 success/day, 3 attempts/day (in case of parse failures).
const LLM_DAILY_CAP = 3;
const REFRESH_COOLDOWN_HOURS = 24;

// ─── Helpers ──────────────────────────────────────────────────────────────

const getDeviceId = (req) => {
  const id =
    req.query.deviceId ||
    req.headers['x-device-id'] ||
    (req.body && req.body.deviceId);
  if (!id || String(id).trim().length < 4) return null;
  return String(id).trim();
};

const isoDate = (d = new Date()) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const daysAgoStr = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDate(d);
};

// ─── Aggregators (90-day rollups from HK imports) ────────────────────────

async function readPersonalize(db, deviceId) {
  try {
    const snap = await db
      .collection('wellness_users')
      .doc(deviceId)
      .collection('wellness_meta')
      .doc('personalize')
      .get();
    if (!snap.exists) return null;
    return snap.data();
  } catch {
    return null;
  }
}

async function aggregateHK(db, deviceId, coach, sinceDateStr) {
  const out = { samples: 0, byType: {} };
  try {
    const snap = await db
      .collection('wellness_users')
      .doc(deviceId)
      .collection('agents')
      .doc(coach)
      .collection('healthkit_imports')
      .limit(3000)
      .get();
    for (const doc of snap.docs) {
      const d = doc.data();
      const ds = (d.start_date || '').slice(0, 10);
      if (sinceDateStr && ds < sinceDateStr) continue;
      out.samples++;
      const t = d.hk_type || 'unknown';
      if (!out.byType[t]) out.byType[t] = { count: 0, sum: 0, values: [], dates: new Set() };
      out.byType[t].count++;
      const v = Number(d.value);
      if (Number.isFinite(v)) {
        out.byType[t].sum += v;
        out.byType[t].values.push(v);
      }
      if (ds) out.byType[t].dates.add(ds);
    }
  } catch (err) {
    log.warn(`[starter-insights] hk read failed coach=${coach}:`, err.message);
  }
  // Convert sets to counts for JSON-serializable shape
  for (const k of Object.keys(out.byType)) {
    out.byType[k].daysCount = out.byType[k].dates.size;
    delete out.byType[k].dates;
  }
  return out;
}

function median(arr) {
  if (!arr || arr.length === 0) return null;
  const a = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// ─── Rule-based card generators (always run) ──────────────────────────────

function ruleCardsSleep(agg) {
  const cards = [];
  const stages = agg.byType['HKCategoryTypeIdentifierSleepAnalysis'];
  if (stages && stages.daysCount >= 3) {
    cards.push({
      id: 'sleep_baseline',
      coach: 'sleep',
      kind: 'baseline',
      title: `${stages.daysCount} nights already in your record`,
      body: `Apple Health filled in the past 90 days. Your Sleep coach starts with real data — not a blank slate.`,
      source: 'healthkit',
    });
  }
  return cards;
}

function ruleCardsFitness(agg) {
  const cards = [];
  const workouts = agg.byType['HKWorkoutTypeIdentifier'];
  if (workouts && workouts.count >= 1) {
    cards.push({
      id: 'fit_workouts_imported',
      coach: 'fitness',
      kind: 'baseline',
      title: `${workouts.count} workouts imported`,
      body: `Across the last 90 days. Your Fitness coach already knows your typical session rhythm.`,
      source: 'healthkit',
    });
  }
  const steps = agg.byType['HKQuantityTypeIdentifierStepCount'];
  if (steps && steps.daysCount >= 7) {
    const dailyMedian = Math.round(steps.sum / steps.daysCount);
    cards.push({
      id: 'fit_step_baseline',
      coach: 'fitness',
      kind: 'metric',
      title: `Your typical day: ${dailyMedian.toLocaleString()} steps`,
      body: dailyMedian < 5000
        ? `That's below the activity floor. Fitness will lean toward gentle bumps before big push days.`
        : dailyMedian < 8000
        ? `Solid baseline. Fitness will help you find easy ways to push past 8k.`
        : `Strong baseline. Fitness will protect that ceiling and add quality, not just quantity.`,
      source: 'healthkit',
    });
  }
  return cards;
}

function ruleCardsMind(agg) {
  const cards = [];
  const hrv = agg.byType['HKQuantityTypeIdentifierHeartRateVariabilitySDNN'];
  if (hrv && hrv.values.length >= 5) {
    const med = Math.round(median(hrv.values));
    cards.push({
      id: 'mind_hrv_baseline',
      coach: 'mind',
      kind: 'metric',
      title: `Your HRV baseline: ${med} ms`,
      body: `Mind will watch this. A drop of 15%+ for two days running = real stress load worth talking about.`,
      source: 'healthkit',
    });
  }
  return cards;
}

function ruleCardsNutrition(agg) {
  const cards = [];
  const weight = agg.byType['HKQuantityTypeIdentifierBodyMass'];
  if (weight && weight.values.length >= 2) {
    const latest = weight.values[weight.values.length - 1];
    cards.push({
      id: 'nut_weight_known',
      coach: 'nutrition',
      kind: 'baseline',
      title: `Weight on file: ${latest.toFixed(1)}`,
      body: `Pulled from Apple Health. Nutrition uses this for your calorie targets so you don't have to retype it.`,
      source: 'healthkit',
    });
  }
  return cards;
}

function ruleCardsWater(agg) {
  const cards = [];
  const water = agg.byType['HKQuantityTypeIdentifierDietaryWater'];
  if (water && water.daysCount >= 5) {
    const avgMl = Math.round(water.sum / water.daysCount);
    cards.push({
      id: 'water_baseline',
      coach: 'water',
      kind: 'metric',
      title: `Your typical intake: ${avgMl} ml/day`,
      body: avgMl < 1500
        ? `Below the comfort line. Water will start with small reminder cues, not big targets.`
        : `Solid baseline. Water will help you protect it on travel and stress days.`,
      source: 'healthkit',
    });
  }
  return cards;
}

function ruleCardsFasting() {
  // Fasting has no direct HK signal — no Day-1 card from HK alone.
  return [];
}

function buildRuleCards({ aggs }) {
  return [
    ...ruleCardsSleep(aggs.sleep),
    ...ruleCardsFitness(aggs.fitness),
    ...ruleCardsMind(aggs.mind),
    ...ruleCardsNutrition(aggs.nutrition),
    ...ruleCardsWater(aggs.water),
    ...ruleCardsFasting(aggs.fasting),
  ];
}

// ─── LLM enhancement (best-effort, 1 call) ────────────────────────────────

const LLM_SYSTEM_PROMPT = `You write 1-2 personal "welcome" insight cards for a new user of Wellness OS, an iOS app with 6 AI wellness coaches.

You will receive:
- the user's Personalize answers (goals, schedule, preferences)
- 90 days of Apple Health summary aggregates per coach

Your job: write 1-2 cards that connect a Personalize answer to a HealthKit observation in a way the user could not have written themselves. Make them feel SEEN.

Hard rules:
- 1-2 cards MAX. Pick the most striking signal.
- Each card title ≤ 60 chars, body ≤ 180 chars.
- Reference both: their stated goal AND something from their HK data.
- No vague platitudes. No "you can do this!" energy. State the connection.
- Never invent numbers. Only quote stats present in the aggregates JSON.
- Return ONLY JSON: {"cards":[{"coach":"...","title":"...","body":"..."}]}
- Coach must be one of: sleep, mind, fitness, nutrition, water, fasting.

If no clear connection exists, return {"cards": []}.`;

async function maybeEnhanceWithLLM({ db, deviceId, personalize, aggs, language = 'en' }) {
  if (!openai) return { cards: [], skipped: 'no_openai' };

  // Daily cap
  try {
    const today = isoDate();
    const usageRef = db
      .collection('wellness_users')
      .doc(deviceId)
      .collection('wellness_meta')
      .doc('starter_insights_usage');
    const usage = (await usageRef.get()).data() || {};
    if (usage.date === today && (usage.attempts || 0) >= LLM_DAILY_CAP) {
      return { cards: [], skipped: 'daily_cap' };
    }
    await usageRef.set(
      {
        date: today,
        attempts: usage.date === today ? (usage.attempts || 0) + 1 : 1,
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  } catch (err) {
    log.warn('[starter-insights] usage check failed:', err.message);
  }

  // Compact prompt payload — never send raw values arrays.
  const compactAggs = {};
  for (const coach of COACHES) {
    const types = aggs[coach]?.byType || {};
    const cleaned = {};
    for (const [t, v] of Object.entries(types)) {
      cleaned[t] = {
        count: v.count,
        days: v.daysCount,
        median: median(v.values),
        sum: Math.round(v.sum || 0),
      };
    }
    compactAggs[coach] = { samples: aggs[coach]?.samples || 0, byType: cleaned };
  }

  const compactPersonalize = personalize
    ? {
        goals: personalize.goals || [],
        primary_focus: personalize.primary_focus || null,
        schedule_shape: personalize.schedule_shape || null,
        sleep_target: personalize.sleep_target || null,
        activity_level: personalize.activity_level || null,
        diet_style: personalize.diet_style || null,
        language: personalize.language || language,
        stress_baseline: personalize.stress_baseline || null,
      }
    : null;

  const userPrompt = JSON.stringify({
    personalize: compactPersonalize,
    healthkit_aggregates: compactAggs,
    output_language: language,
  });

  try {
    const resp = await openai.chat.completions.create({
      model: AI.REASONING_FAST,
      max_completion_tokens: 360,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: appendLanguageInstruction(LLM_SYSTEM_PROMPT, language) },
        { role: 'user', content: userPrompt },
      ],
    });
    const raw = (resp.choices?.[0]?.message?.content || '').trim();
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return { cards: [], skipped: 'parse_fail' }; }
    const out = [];
    for (const c of parsed.cards || []) {
      if (!c?.coach || !COACHES.includes(c.coach)) continue;
      if (!c.title || !c.body) continue;
      if (String(c.title).length > 80 || String(c.body).length > 220) continue;
      out.push({
        id: `llm_${c.coach}_${Date.now()}`,
        coach: c.coach,
        kind: 'narrative',
        title: String(c.title).trim(),
        body: String(c.body).trim(),
        source: 'llm',
      });
    }
    return { cards: out, skipped: null };
  } catch (err) {
    log.warn('[starter-insights] LLM enhance failed:', err.message);
    return { cards: [], skipped: 'llm_error' };
  }
}

// ─── Card decoration (accent + emoji, post-merge) ────────────────────────

function decorateCards(cards) {
  return cards.map((c) => ({
    ...c,
    accent: COACH_META[c.coach]?.accent || '#FFFFFF',
    emoji: COACH_META[c.coach]?.emoji || '✨',
  }));
}

// ─── Builder (used by both GET and POST /refresh) ─────────────────────────

async function buildStarterInsights({ db, deviceId, language, allowLLM }) {
  const sinceDate = daysAgoStr(90);
  const personalize = await readPersonalize(db, deviceId);

  // Pull HK aggregates for all 6 coaches in parallel.
  const aggArr = await Promise.all(COACHES.map((c) => aggregateHK(db, deviceId, c, sinceDate)));
  const aggs = {};
  COACHES.forEach((c, i) => { aggs[c] = aggArr[i]; });

  const ruleCards = buildRuleCards({ aggs });

  let llmCards = [];
  let llmSkipped = 'disabled';
  if (allowLLM) {
    const { cards, skipped } = await maybeEnhanceWithLLM({ db, deviceId, personalize, aggs, language });
    llmCards = cards;
    llmSkipped = skipped || null;
  }

  // Merge — LLM cards lead (more personal), then rule cards. Cap at 5 total.
  const merged = decorateCards([...llmCards, ...ruleCards]).slice(0, 5);

  return {
    cards: merged,
    generated_at: new Date().toISOString(),
    generated_from: llmCards.length ? 'rule_plus_llm' : 'rule_only',
    llm_skipped: llmSkipped,
    debug: {
      hk_total_samples: Object.values(aggs).reduce((s, a) => s + (a.samples || 0), 0),
      had_personalize: !!personalize,
    },
  };
}

async function cachePayload(db, deviceId, payload) {
  try {
    await db
      .collection('wellness_users')
      .doc(deviceId)
      .collection('wellness_meta')
      .doc('starter_insights')
      .set(payload, { merge: true });
  } catch (err) {
    log.warn('[starter-insights] cache write failed:', err.message);
  }
}

// ─── GET /api/v2/starter-insights ─────────────────────────────────────────

router.get('/', async (req, res) => {
  const deviceId = getDeviceId(req);
  if (!deviceId) return res.status(400).json({ ok: false, error: 'deviceId required' });

  const db = admin.firestore();
  const language = String(req.query.lang || 'en').slice(0, 5);

  try {
    // Read cache first
    const cacheSnap = await db
      .collection('wellness_users')
      .doc(deviceId)
      .collection('wellness_meta')
      .doc('starter_insights')
      .get();

    const cache = cacheSnap.exists ? cacheSnap.data() : null;

    if (cache && cache.generated_at) {
      const ageH = (Date.now() - Date.parse(cache.generated_at)) / 3_600_000;
      if (ageH < REFRESH_COOLDOWN_HOURS && Array.isArray(cache.cards) && cache.cards.length > 0) {
        return res.json({ ok: true, cached: true, ...cache });
      }
    }

    // Generate fresh (with LLM enhancement when budget allows)
    const payload = await buildStarterInsights({ db, deviceId, language, allowLLM: true });
    await cachePayload(db, deviceId, payload);
    return res.json({ ok: true, cached: false, ...payload });
  } catch (err) {
    log.error('[starter-insights] GET failed:', err.message);
    return res.status(500).json({ ok: false, error: 'starter_insights_failed' });
  }
});

// ─── POST /api/v2/starter-insights/refresh ────────────────────────────────

router.post('/refresh', async (req, res) => {
  const deviceId = getDeviceId(req);
  if (!deviceId) return res.status(400).json({ ok: false, error: 'deviceId required' });

  const db = admin.firestore();
  const language = String((req.body && req.body.lang) || 'en').slice(0, 5);

  try {
    const cacheSnap = await db
      .collection('wellness_users')
      .doc(deviceId)
      .collection('wellness_meta')
      .doc('starter_insights')
      .get();
    const cache = cacheSnap.exists ? cacheSnap.data() : null;
    if (cache && cache.generated_at) {
      const ageH = (Date.now() - Date.parse(cache.generated_at)) / 3_600_000;
      if (ageH < REFRESH_COOLDOWN_HOURS) {
        return res.status(429).json({
          ok: false,
          error: 'cooldown',
          next_refresh_in_hours: Math.ceil(REFRESH_COOLDOWN_HOURS - ageH),
        });
      }
    }

    const payload = await buildStarterInsights({ db, deviceId, language, allowLLM: true });
    await cachePayload(db, deviceId, payload);
    return res.json({ ok: true, ...payload });
  } catch (err) {
    log.error('[starter-insights] refresh failed:', err.message);
    return res.status(500).json({ ok: false, error: 'refresh_failed' });
  }
});

module.exports = router;
