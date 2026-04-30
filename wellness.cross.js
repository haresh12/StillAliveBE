'use strict';
// ════════════════════════════════════════════════════════════════════
// wellness.cross.js — Express router for /api/wellness/*
// Cross-agent intelligence layer: tiered cascade + LLM jobs.
// ════════════════════════════════════════════════════════════════════
const express = require('express');
const router  = express.Router();
const cron    = require('node-cron');
const admin   = require('firebase-admin');

const {
  buildInsightsPayload,
  persistDailySnapshot,
  fetchAllAgentData,
  buildDailyMatrix,
  AGENTS,
} = require('./lib/cross-agent-engine');
const { buildContext } = require('./lib/cross-agent-context');
const { assembleSignals } = require('./lib/cross-agent-tiers');
const { generateBriefing, generateSetupSuggestion } = require('./lib/cross-agent-llm');
const { extractThemes, collectUserText } = require('./lib/cross-agent-themes');
const { registerOrUpdate: updateHypotheses } = require('./lib/cross-agent-hypotheses');
const { computeEngagement } = require('./lib/cross-agent-engagement');
const { buildTimeContext, buildAgentTilesRich } = require('./lib/cross-agent-aha');
const { collectCandidates } = require('./lib/assistant-brain');
const { humanizeMessages } = require('./lib/assistant-llm');
const { recordPing, getLocationContext } = require('./lib/location-signals');
const { recordEvent: recordNotifEvent, getEngagementContext } = require('./lib/notif-engagement');
const { recordShown, markActionCompleted, buildFollowUp } = require('./lib/assistant-memory');
const { rerankByFeedback, recordFeedback } = require('./lib/assistant-ranker');
const { computeScore: computeRichScore } = require('./lib/wellness-score');
const { buildDeck: buildSocialDeck } = require('./lib/social-proof');
const { buildHarvest } = require('./lib/cross-agent-harvester');
const { buildScoreImpact } = require('./lib/score-impact');
const { buildFindings, buildPendingPairs } = require('./lib/findings-engine');
const { OpenAI } = require('openai');
const { fetchAgentSnapshot } = require('./lib/cross-agent-context');
const _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const {
  getOrGenerateWeeklyReport,
  getOrGenerateMonthlyReport,
  listReports,
} = require('./lib/reports-engine');
const { getOrGenerateLetter } = require('./lib/coach-letter');

// ─── In-memory cache (5-min TTL) ────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() - v.t > CACHE_TTL) { cache.delete(key); return null; }
  return v.data;
}
function cacheSet(key, data) {
  cache.set(key, { t: Date.now(), data });
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
}
function invalidateWellnessCache(deviceId) {
  if (!deviceId) return;
  for (const k of [...cache.keys()]) if (k.endsWith(`:${deviceId}`)) cache.delete(k);
}


// Convert compact-ctx logs into a per-agent {date: 0-100 score} map
// (best-effort — uses primary value scaled to 0-100 when possible)
function buildMatrixFromContext(ctx) {
  const matrix = { fitness: {}, sleep: {}, mind: {}, nutrition: {}, water: {}, fasting: {} };
  for (const agent of Object.keys(matrix)) {
    for (const log of (ctx.recent_logs?.[agent] || [])) {
      const v = scoreLog(agent, log);
      if (v != null && log.date) matrix[agent][log.date] = v;
    }
  }
  return matrix;
}
function scoreLog(agent, log) {
  switch (agent) {
    case 'sleep': {
      const q = (log.quality || 3) * 12;       // 0-60
      const h = Math.min(8, log.duration_h || 0);
      return Math.round(q + (h / 8) * 40);     // 0-100
    }
    case 'mind':      return Math.round(((log.mood_score || 3) / 5) * 100);
    case 'water':     return Math.min(100, Math.round(((log.ml || 0) / 2500) * 100));
    case 'nutrition': {
      const cal = log.kcal > 0 && log.kcal < 4000 ? 50 : 0;
      const prot = Math.min(50, ((log.protein_g || 0) / 130) * 50);
      return Math.round(cal + prot);
    }
    case 'fitness': {
      const setCount = log.sets || 0;
      const dur = log.duration_min || 0;
      return Math.min(100, Math.round((setCount / 20) * 60 + (dur / 60) * 40));
    }
    case 'fasting': {
      const ratio = (log.actual_h || 0) / (log.planned_h || 16);
      return Math.min(100, Math.round(ratio * 100));
    }
    default: return null;
  }
}

const handle = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    console.error('[wellness.cross]', req.path, e.message);
    res.status(500).json({ error: e.message || 'internal error' });
  }
};

const userDoc   = (id) => admin.firestore().collection('wellness_users').doc(id);

// ─── /home/:deviceId — briefing + tiered signals + score data ───────
router.get('/home/:deviceId', handle(async (req, res) => {
  const { deviceId } = req.params;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  const force = req.query.force === '1';
  const key = `home:${deviceId}`;
  if (!force) { const c = cacheGet(key); if (c) return res.json({ ...c, _cached: true }); }

  const ctx = await buildContext(deviceId, { days: 14 });
  const { tier } = assembleSignals(ctx);

  // RICH SCORE — 90-day matrix, same formula as /insights → identical numbers on both screens
  let rich_score = null, delta = null;
  try {
    const agentData90 = await fetchAllAgentData(deviceId, 90);
    const matrix = buildDailyMatrix(agentData90);
    const peakRef = userDoc(deviceId).collection('wellness_meta').doc('peak_score');
    const peakSnap = await peakRef.get().catch(() => null);
    const peakSoFar = peakSnap?.exists ? (peakSnap.data().peak || 0) : 0;
    rich_score = computeRichScore({ matrix, ctx, peakSoFar });
    if ((rich_score.score || 0) > peakSoFar) {
      peakRef.set({
        peak: rich_score.score,
        peak_at: admin.firestore.FieldValue.serverTimestamp(),
        updated: Date.now(),
      }, { merge: true }).catch(() => {});
    }
    // Delta: today vs yesterday using the same rich formula on the same 90-day matrix
    if (rich_score?.score != null) {
      const todayStr = new Date().toISOString().slice(0, 10);
      const matrixYest = {};
      for (const agent of Object.keys(matrix)) {
        matrixYest[agent] = Object.fromEntries(
          Object.entries(matrix[agent] || {}).filter(([d]) => d < todayStr)
        );
      }
      const yScore = computeRichScore({ matrix: matrixYest, ctx, peakSoFar: 0 });
      const d = rich_score.score - (yScore?.score ?? rich_score.score);
      if (d !== 0) delta = Math.round(d);
    }
  } catch (e) {
    console.warn('[rich_score]', e.message);
  }

  const social_proof = buildSocialDeck(deviceId, rich_score);

  const [locationCtx, notifCtx] = await Promise.all([
    getLocationContext(deviceId).catch(() => ({ has_location: false })),
    getEngagementContext(deviceId).catch(() => ({ has_engagement: false })),
  ]);
  ctx.signal_context = { location: locationCtx, notif: notifCtx };

  let candidates = collectCandidates(ctx);
  try {
    const followUp = await buildFollowUp(ctx, deviceId);
    if (followUp) candidates.push(followUp);
  } catch {}
  candidates = await rerankByFeedback(deviceId, candidates).catch(() => candidates);
  const top = candidates.slice(0, 4);

  const assistant_messages = top.length
    ? await humanizeMessages(deviceId, top).catch(() => top.map(c => ({ ...c, text: c.raw_text })))
    : [];

  try { await Promise.all(assistant_messages.map(m => recordShown(deviceId, m))); } catch {}

  const time_context = buildTimeContext(ctx);
  const tiles_rich   = buildAgentTilesRich(ctx);

  // Coach letter — only computed when user has enough data (>= 3 logs); cached weekly
  let day3_letter = null;
  if ((ctx.total_logs || 0) >= 3) {
    try {
      const harvest = buildHarvest(ctx);
      const scoreImpact = buildScoreImpact(ctx, harvest);
      day3_letter = await getOrGenerateLetter(deviceId, ctx, harvest, scoreImpact);
    } catch (e) {
      console.warn('[home] coach letter failed:', e.message);
    }
  }

  // Fetch top action for each set-up agent
  let top_actions = [];
  try {
    const db = admin.firestore();
    const agentActionCols = {
      mind:      ['mind_actions'],
      sleep:     ['sleep_actions'],
      fitness:   ['fitness_actions'],
      nutrition: ['nutrition_actions'],
      water:     ['water_actions'],
      fasting:   ['fasting_actions'],
    };
    const setupAgents = Object.entries(ctx.setup_state || {})
      .filter(([, v]) => v)
      .map(([k]) => k);

    const actionFetches = setupAgents.map(async (agent) => {
      try {
        const col = agentActionCols[agent]?.[0];
        if (!col) return null;
        const snap = await db
          .collection('wellness_users').doc(deviceId)
          .collection('agents').doc(agent)
          .collection(col)
          .where('status', '==', 'active')
          .orderBy('generated_at', 'desc')
          .limit(1)
          .get()
          .catch(() => null);
        if (!snap || snap.empty) return null;
        const d = snap.docs[0];
        return { agent, id: d.id, text: d.data().text, when_to_do: d.data().when_to_do || 'Today' };
      } catch { return null; }
    });

    const results = await Promise.all(actionFetches);
    top_actions = results.filter(Boolean).slice(0, 4);
  } catch (e) {
    console.warn('[home] top_actions fetch failed:', e.message);
  }

  // Fetch cached per-agent scores — the single source of truth for tile scores
  const SCORE_AGENTS = ['sleep', 'mind', 'fitness', 'nutrition', 'water', 'fasting'];
  const agentDocSnaps = await Promise.all(
    SCORE_AGENTS.map(a =>
      userDoc(deviceId).collection('agents').doc(a).get().catch(() => null)
    )
  );
  const agent_scores = {};
  agentDocSnaps.forEach((snap, i) => {
    if (snap?.exists) {
      const d = snap.data();
      if (d.current_score != null) {
        agent_scores[SCORE_AGENTS[i]] = {
          score:      d.current_score,
          label:      d.score_label      || null,
          components: d.score_components || null,
        };
      }
    }
  });

  const payload = {
    tier,
    profile:           ctx.profile,
    setup_state:       ctx.setup_state,
    setup_count:       ctx.setup_count,
    days_with_any_log: ctx.days_with_any_log,
    total_logs:        ctx.total_logs,
    assistant_messages,
    time_context,
    signal_context: ctx.signal_context,
    tiles_rich,
    rich_score,
    social_proof,
    hypotheses:  (ctx.hypotheses || []).slice(0, 3),
    score:       rich_score?.score     ?? null,
    delta,
    subscores:   rich_score?.subscores ?? null,
    agent_scores,
    day3_letter,
    top_actions,
    generated_at: Date.now(),
  };
  cacheSet(key, payload);
  res.json(payload);
}));

// ─── /insights/:deviceId — cross-agent harvest + score + trends
router.get('/insights/:deviceId', handle(async (req, res) => {
  const { deviceId } = req.params;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  const force = req.query.force === '1';
  const key = `insights:${deviceId}`;
  if (!force) { const c = cacheGet(key); if (c) return res.json({ ...c, _cached: true }); }

  const ctx = await buildContext(deviceId, { days: 30 });
  const { tier } = assembleSignals(ctx);

  // Rich score — computed FIRST so subscores can feed harvest
  let rich_score = null;
  try {
    const data = await fetchAllAgentData(deviceId, 90);
    const matrix = buildDailyMatrix(data);
    const peakRef = userDoc(deviceId).collection('wellness_meta').doc('peak_score');
    const peakSnap = await peakRef.get().catch(() => null);
    const peakSoFar = peakSnap?.exists ? (peakSnap.data().peak || 0) : 0;
    rich_score = computeRichScore({ matrix, ctx, peakSoFar });
    if ((rich_score?.score || 0) > peakSoFar) {
      peakRef.set({
        peak: rich_score.score,
        peak_at: admin.firestore.FieldValue.serverTimestamp(),
        updated: Date.now(),
      }, { merge: true }).catch(() => {});
    }
  } catch (e) { console.warn('[insights rich_score]', e.message); }

  // Attach subscores to ctx so harvest can read per-agent scores
  ctx.subscores = rich_score?.subscores ?? null;

  const harvest     = buildHarvest(ctx);
  const score_impact = buildScoreImpact(ctx, harvest);
  const findings    = buildFindings(ctx);
  const pending_pairs = buildPendingPairs(ctx);

  // Trend data from the existing engine (charts only for trend lines + maturity)
  let charts = null;
  try { charts = await buildInsightsPayload(deviceId); } catch {}

  const payload = {
    tier,
    profile:      ctx.profile,
    harvest,
    score_impact,
    findings,
    pending_pairs,
    rich_score,
    score:        rich_score?.score ?? null,
    subscores:    rich_score?.subscores ?? null,
    trend7d:      charts?.trend7d ?? [],
    trend30d:     charts?.trend30d ?? [],
    maturity:     charts?.maturity ?? { stage: Math.max(0, tier - 1), days: ctx.days_with_any_log },
    generated_at: Date.now(),
  };
  cacheSet(key, payload);
  res.json(payload);
}));

// ─── /briefing/:deviceId — just the briefing block (cheaper) ────────
router.get('/briefing/:deviceId', handle(async (req, res) => {
  const { deviceId } = req.params;
  const ctx = await buildContext(deviceId, { days: 7 });
  const briefing = await generateBriefing(deviceId, ctx);
  res.json(briefing);
}));

// ─── /journal/:deviceId — last 7 days of journal entries ────────────
router.get('/journal/:deviceId', handle(async (req, res) => {
  const { deviceId } = req.params;
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    days.push(d);
  }
  const snap = await admin.firestore()
    .collection('wellness_users').doc(deviceId)
    .collection('wellness_journal')
    .where(admin.firestore.FieldPath.documentId(), 'in', days)
    .get().catch(() => ({ docs: [] }));
  const journal = snap.docs.map(d => ({ date: d.id, ...(d.data().payload || {}) }));
  res.json({ entries: journal.sort((a, b) => b.date.localeCompare(a.date)) });
}));

// ─── /hypotheses/:deviceId — live pattern tracker ───────────────────
router.get('/hypotheses/:deviceId', handle(async (req, res) => {
  const { deviceId } = req.params;
  const snap = await userDoc(deviceId).collection('wellness_meta').doc('hypotheses').get();
  res.json({ hypotheses: snap.exists ? (snap.data().active || []) : [] });
}));

// ─── /themes/:deviceId — extracted themes ──────────────────────────
router.get('/themes/:deviceId', handle(async (req, res) => {
  const { deviceId } = req.params;
  const snap = await userDoc(deviceId).collection('wellness_meta').doc('themes').get();
  res.json(snap.exists ? snap.data() : { dominant: [] });
}));

// ─── /setup-suggestion/:deviceId ───────────────────────────────────
router.get('/setup-suggestion/:deviceId', handle(async (req, res) => {
  const { deviceId } = req.params;
  const ctx = await buildContext(deviceId, { days: 14 });
  const r = await generateSetupSuggestion(deviceId, ctx);
  res.json(r || { recommend: null });
}));

// ─── GET /agent-daily-grid/:deviceId — Mon-Sun week grid ──────────
// Returns 7 days (Mon→Sun current week) × 6 agents.
// Cell: { date, agent, score, logged, is_today, is_future, is_pre_join, day_label }
// score = per-day quality score (0-100, same formula direction as analysis)
// is_pre_join = true for days before the user created their account
router.get('/agent-daily-grid/:deviceId', handle(async (req, res) => {
  const { deviceId } = req.params;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  const key = `grid:${deviceId}`;
  const cached = cacheGet(key);
  if (cached) return res.json({ ...cached, _cached: true });

  const ctx = await buildContext(deviceId, { days: 8 });
  const GRID_AGENTS = ['fitness', 'sleep', 'mind', 'nutrition', 'water', 'fasting'];
  const grid = [];

  // Build Mon-Sun of the current calendar week
  const nowMs = Date.now();
  const nowDate = new Date(nowMs);
  const todayStr = nowDate.toISOString().slice(0, 10);
  // JS: 0=Sun, 1=Mon … 6=Sat. Shift so Monday = 0.
  const dowSun = nowDate.getDay(); // 0=Sun
  const dowMon = (dowSun + 6) % 7; // days since Monday (Mon=0, Tue=1, …, Sun=6)
  const weekDates = []; // Mon → Sun, each { date, label, is_today, is_future }
  const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  for (let i = 0; i < 7; i++) {
    const ms = nowMs - dowMon * 86400000 + i * 86400000;
    const d  = new Date(ms).toISOString().slice(0, 10);
    weekDates.push({ date: d, label: DAY_LABELS[i], is_today: d === todayStr, is_future: d > todayStr });
  }

  // Join date — days before this are pre-join (don't penalise, show differently)
  const joinedAt = ctx.joined_at || null; // YYYY-MM-DD or null

  // Per-day score formula — consistent with analysis direction, no maturity (historical)
  function perDayScore(agent, log) {
    if (!log) return null;
    switch (agent) {
      case 'sleep': {
        const eff = log.sleep_efficiency || 0;
        const dur = Math.min(1, (log.total_sleep_hours || 0) / (ctx.setup_state?.sleep?.target_hours || 7.5));
        const q   = ((log.sleep_quality || 3) / 5);
        return Math.round(eff * 0.40 + dur * 100 * 0.35 + q * 100 * 0.25);
      }
      case 'mind': {
        const mood = ((log.mood_score || log.mood || 3) / 5) * 100;
        const anx  = ((5 - (log.anxiety_level || log.anxiety || 2)) / 4) * 100;
        return Math.round(mood * 0.60 + anx * 0.40);
      }
      case 'water': {
        const goal = 2500;
        return Math.min(100, Math.round(((log.effective_ml || log.ml || 0) / goal) * 100));
      }
      case 'nutrition': {
        const cal  = (log.calories || log.kcal || 0);
        const calOk = cal > 800 && cal < 4000 ? 50 : 0;
        const prot  = Math.min(50, ((log.protein || log.protein_g || 0) / 130) * 50);
        return Math.round(calOk + prot);
      }
      case 'fitness': {
        const sets = (log.exercises || []).reduce((s, e) => s + (e.sets?.length || 0), 0);
        const dur  = log.duration_min || 0;
        return Math.min(100, Math.round((sets / 20) * 60 + (dur / 60) * 40));
      }
      case 'fasting': {
        const ratio = (log.actual_h || log.actual_hours || 0) / (log.target_hours || log.planned_h || 16);
        return Math.min(100, Math.round(ratio * 100));
      }
      default: return null;
    }
  }

  for (const { date, label, is_today, is_future } of weekDates) {
    const is_pre_join = joinedAt ? date < joinedAt : false;
    for (const agent of GRID_AGENTS) {
      const setup = ctx.setup_state?.[agent] === 'setup';
      const logs  = (ctx.recent_logs?.[agent] || []).filter(l => l.date === date || l.date_str === date);
      const log   = logs[0] || null;
      // Aggregate water logs for the day (multiple per day)
      let score = null;
      if (agent === 'water' && logs.length > 1) {
        const totalMl = logs.reduce((s, l) => s + (l.effective_ml || l.ml || 0), 0);
        score = Math.min(100, Math.round((totalMl / 2500) * 100));
      } else {
        score = (!is_future && !is_pre_join && log) ? perDayScore(agent, log) : null;
      }
      grid.push({ date, day_label: label, agent, score, logged: !!log && !is_future && !is_pre_join, is_today, is_future, is_pre_join, setup });
    }
  }

  // Summary: best + worst agent this week (only set-up, only logged days)
  const agentTotals = {};
  GRID_AGENTS.forEach(a => { agentTotals[a] = { sum: 0, count: 0 }; });
  grid.forEach(cell => {
    if (cell.score != null && cell.logged && !cell.is_pre_join) {
      agentTotals[cell.agent].sum   += cell.score;
      agentTotals[cell.agent].count += 1;
    }
  });
  let best = null, worst = null;
  GRID_AGENTS.forEach(a => {
    if (!ctx.setup_state?.[a]) return;
    const { sum, count } = agentTotals[a];
    if (!count) return;
    const avg = sum / count;
    if (best  === null || avg > agentTotals[best].sum  / agentTotals[best].count)  best  = a;
    if (worst === null || avg < agentTotals[worst].sum / agentTotals[worst].count) worst = a;
  });

  const payload = {
    grid,
    week_dates: weekDates,
    today:      todayStr,
    joined_at:  joinedAt,
    setup_state: ctx.setup_state,
    week_summary: { best, worst },
  };
  cacheSet(key, payload, 60 * 5); // 5-min cache on grid
  res.json(payload);
}));

// ─── GET /reports/:deviceId — list past weekly + monthly reports ────
router.get('/reports/:deviceId', handle(async (req, res) => {
  const { deviceId } = req.params;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  const reports = await listReports(deviceId);
  res.json({ reports });
}));

// ─── POST /reports/weekly/:deviceId — generate (or return cached) weekly report
router.post('/reports/weekly/:deviceId', handle(async (req, res) => {
  const { deviceId } = req.params;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

  const ctx = await buildContext(deviceId, { days: 30 });
  const harvest     = buildHarvest(ctx);
  const findings    = buildFindings(ctx);
  const scoreImpact = buildScoreImpact(ctx, harvest);

  let score = null;
  try { score = await buildInsightsPayload(deviceId); } catch {}

  const report = await getOrGenerateWeeklyReport(deviceId, ctx, harvest, findings, scoreImpact, score);
  if (!report) return res.status(500).json({ error: 'Failed to generate weekly report' });
  res.json(report);
}));

// ─── POST /reports/monthly/:deviceId — generate (or return cached) monthly report
router.post('/reports/monthly/:deviceId', handle(async (req, res) => {
  const { deviceId } = req.params;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

  const ctx = await buildContext(deviceId, { days: 30 });
  const harvest     = buildHarvest(ctx);
  const findings    = buildFindings(ctx);
  const scoreImpact = buildScoreImpact(ctx, harvest);

  let score = null;
  try { score = await buildInsightsPayload(deviceId); } catch {}

  const trend30d = score?.trend30d ?? [];
  const report = await getOrGenerateMonthlyReport(deviceId, ctx, harvest, findings, scoreImpact, score, trend30d);
  if (!report) return res.status(500).json({ error: 'Failed to generate monthly report' });
  res.json(report);
}));

// ─── POST /cold-start-anchor ───────────────────────────────────────
// Body: { deviceId, value: 'sleep'|'energy'|'mood'|'weight'|'fitness'|'none' }
router.post('/cold-start-anchor', express.json(), handle(async (req, res) => {
  const { deviceId, value } = req.body || {};
  if (!deviceId || !value) return res.status(400).json({ error: 'deviceId and value required' });
  await userDoc(deviceId).collection('wellness_meta').doc('cold_start_anchor').set({
    value, set_at: admin.firestore.FieldValue.serverTimestamp(),
  });
  invalidateWellnessCache(deviceId);
  res.json({ ok: true });
}));

// ─── GET /score-history/:deviceId?range=7d|30d|90d|all ─────────────
router.get('/score-history/:deviceId', handle(async (req, res) => {
  const { deviceId } = req.params;
  const range = req.query.range || '30d';
  const days = range === '7d' ? 7 : range === '30d' ? 30 : range === '90d' ? 90 : 365;
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - days * 86400000);
  const snap = await admin.firestore()
    .collection('wellness_users').doc(deviceId)
    .collection('wellness_snapshots')
    .where('saved_at', '>=', cutoff)
    .orderBy('saved_at', 'asc').limit(400).get().catch(() => ({ docs: [] }));
  const series = snap.docs.map(d => ({
    date: d.id,
    score: d.data().score || 0,
  }));
  // Best/worst/streak/drift
  let best = null, worst = null;
  for (const p of series) {
    if (!best || p.score > best.score) best = p;
    if (!worst || p.score < worst.score) worst = p;
  }
  const drift = series.length >= 2 ? series[series.length - 1].score - series[0].score : 0;
  res.json({ range, series, best, worst, drift });
}));

// ─── GET /social-proof/:deviceId — did-you-know deck ───────────────
router.get('/social-proof/:deviceId', handle(async (req, res) => {
  const { deviceId } = req.params;
  const ctx = await buildContext(deviceId, { days: 14 });
  const matrix = buildMatrixFromContext(ctx);
  const rich = computeRichScore({ matrix, ctx });
  res.json({ deck: buildSocialDeck(deviceId, rich) });
}));

// ─── POST /location/ping — coarse location ping (200m grid) ────────
router.post('/location/ping', express.json(), handle(async (req, res) => {
  const { deviceId, lat, lon, ts } = req.body || {};
  if (!deviceId || lat == null || lon == null) return res.status(400).json({ error: 'deviceId, lat, lon required' });
  await recordPing(deviceId, { lat, lon, ts });
  invalidateWellnessCache(deviceId);
  res.json({ ok: true });
}));

// ─── POST /notif/event — delivered/opened/dismissed/acted ──────────
router.post('/notif/event', express.json(), handle(async (req, res) => {
  const { deviceId, kind, push_id, agent, ts } = req.body || {};
  if (!deviceId || !kind) return res.status(400).json({ error: 'deviceId and kind required' });
  await recordNotifEvent(deviceId, { kind, push_id, agent, ts });
  res.json({ ok: true });
}));

// ─── POST /feedback — "useful?" tap on any insight ──────────────────
// Body: { deviceId, insight_id, kind, useful: bool, cohort_id?, action_taken?: bool }
router.post('/feedback', express.json(), handle(async (req, res) => {
  const { deviceId, insight_id, kind, useful, cohort_id, action_taken } = req.body || {};
  if (!deviceId || !insight_id) return res.status(400).json({ error: 'deviceId and insight_id required' });
  await userDoc(deviceId).collection('wellness_feedback').doc(insight_id).set({
    insight_id, kind: kind || 'unknown',
    useful: useful === true, action_taken: action_taken === true,
    cohort_id: cohort_id || null,
    submitted_at: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  // Feed the bandit ranker
  await recordFeedback(deviceId, { msg_id: insight_id, category: kind, useful: useful === true }).catch(() => {});
  res.json({ ok: true });
}));

// ─── POST /assistant/action-completed — user tapped a CTA ──────────
router.post('/assistant/action-completed', express.json(), handle(async (req, res) => {
  const { deviceId, msg_id } = req.body || {};
  if (!deviceId || !msg_id) return res.status(400).json({ error: 'deviceId and msg_id required' });
  await markActionCompleted(deviceId, msg_id);
  res.json({ ok: true });
}));

// ─── POST /recompute/:deviceId ─────────────────────────────────────
router.post('/recompute/:deviceId', handle(async (req, res) => {
  const { deviceId } = req.params;
  invalidateWellnessCache(deviceId);
  const ctx = await buildContext(deviceId, { days: 30 });
  await Promise.all([
    persistDailySnapshot(deviceId).catch(() => {}),
    updateHypotheses(deviceId, ctx).catch(() => {}),
    computeEngagement(deviceId, ctx).catch(() => {}),
  ]);
  res.json({ ok: true });
}));

// ─── POST /cache/invalidate/:deviceId ──────────────────────────────
router.post('/cache/invalidate/:deviceId', handle(async (req, res) => {
  invalidateWellnessCache(req.params.deviceId);
  res.json({ ok: true });
}));

// ─── DAILY CRON 3 AM UTC ───────────────────────────────────────────
cron.schedule('0 3 * * *', async () => {
  try {
    const usersSnap = await admin.firestore().collection('wellness_users').limit(2000).get();
    let ok = 0, fail = 0;
    for (const doc of usersSnap.docs) {
      try {
        const deviceId = doc.id;
        const ctx = await buildContext(deviceId, { days: 30 });
        await Promise.all([
          persistDailySnapshot(deviceId).catch(() => {}),
          updateHypotheses(deviceId, ctx).catch(() => {}),
          computeEngagement(deviceId, ctx).catch(() => {}),
        ]);
        // Theme extraction (only if user has any text)
        const texts = await collectUserText(deviceId);
        if (texts.length >= 4) await extractThemes({ deviceId, texts }).catch(() => {});
        ok++;
      } catch (e) { fail++; }
    }
    console.log(`[cross-cron] ok=${ok} fail=${fail}`);
  } catch (e) {
    console.error('[cross-cron] fatal:', e.message);
  }
}, { timezone: 'UTC' });

// ─── CROSS-AGENT PROACTIVE CRON — 8 AM + 2 PM UTC ──────────────────
// Detects cross-agent spikes and fires a coach message to the most
// affected agent's chat. Max 1 cross-agent proactive per user per day.
// ────────────────────────────────────────────────────────────────────
async function fireCrossAgentProactives() {
  const db = admin.firestore();
  const today = new Date().toISOString().slice(0, 10);
  try {
    const usersSnap = await db.collection('wellness_users').limit(2000).get();
    let fired = 0;
    for (const doc of usersSnap.docs) {
      const deviceId = doc.id;
      try {
        const userData = doc.data();
        // Skip if already sent a cross proactive today
        if (userData.last_cross_proactive_date === today) continue;

        // Derive which agents are set up from the per-agent flags written at setup time
        const agentSetupFlags = {
          mind:      userData.mind_setup_complete,
          sleep:     userData.sleep_setup_complete,
          fitness:   userData.fitness_setup_complete,
          nutrition: userData.nutrition_setup_complete,
          water:     userData.water_setup_complete,
          fasting:   userData.fasting_setup_complete,
        };
        const setupAgents = Object.entries(agentSetupFlags).filter(([,v]) => v).map(([k]) => k);
        if (setupAgents.length < 2) continue;

        // Fetch snapshots for all active agents in parallel
        const snapshots = {};
        await Promise.all(setupAgents.map(async (agent) => {
          const s = await fetchAgentSnapshot(deviceId, agent, 3).catch(() => null);
          if (s) snapshots[agent] = s;
        }));

        // Detect spikes
        let targetAgent = null;
        let spike = null;

        const sleepLogs  = snapshots.sleep?.logs  || [];
        const mindLogs   = snapshots.mind?.logs   || [];
        const waterLogs  = snapshots.water?.logs  || [];
        const fitnessLogs = snapshots.fitness?.logs || [];

        const avgSleepQ = sleepLogs.length  ? sleepLogs.reduce((s, l) => s + (l.quality || 3), 0) / sleepLogs.length : null;
        const avgMood   = mindLogs.length   ? mindLogs.reduce((s, l) => s + (l.mood_score || 2), 0) / mindLogs.length : null;
        const todayWater = waterLogs.length  ? waterLogs[0] : null;

        if (avgSleepQ !== null && avgSleepQ < 2.5 && avgMood !== null && avgMood < 2 && setupState.mind) {
          targetAgent = 'mind';
          spike = `sleep_mood_crash: sleep quality avg ${avgSleepQ.toFixed(1)}/5, mood avg ${avgMood.toFixed(1)}/4`;
        } else if (avgSleepQ !== null && avgSleepQ < 2.5 && fitnessLogs.length > 0 && setupState.fitness) {
          targetAgent = 'fitness';
          spike = `sleep_recovery_risk: sleep quality avg ${avgSleepQ.toFixed(1)}/5`;
        } else if (todayWater && todayWater.goal_ml && (todayWater.total_ml / todayWater.goal_ml) < 0.4 && avgMood !== null && avgMood < 2.5 && setupState.water) {
          targetAgent = 'water';
          spike = `dehydration_mood: hydration at ${Math.round((todayWater.total_ml / todayWater.goal_ml) * 100)}% of goal, mood ${avgMood.toFixed(1)}/4`;
        } else if (avgSleepQ !== null && avgSleepQ < 2.5 && setupState.sleep) {
          targetAgent = 'sleep';
          spike = `consecutive_poor_sleep: avg ${avgSleepQ.toFixed(1)}/5 over last ${sleepLogs.length} nights`;
        }

        if (!targetAgent || !spike) continue;

        // Generate message with gpt-4.1-mini
        const agentChat = {
          mind:      db.collection('wellness_users').doc(deviceId).collection('agents').doc('mind').collection('mind_chats'),
          sleep:     db.collection('wellness_users').doc(deviceId).collection('agents').doc('sleep').collection('sleep_chats'),
          fitness:   db.collection('wellness_users').doc(deviceId).collection('agents').doc('fitness').collection('fitness_chats'),
          water:     db.collection('wellness_users').doc(deviceId).collection('agents').doc('water').collection('water_chats'),
          nutrition: db.collection('wellness_users').doc(deviceId).collection('agents').doc('nutrition').collection('nutrition_chats'),
          fasting:   db.collection('wellness_users').doc(deviceId).collection('agents').doc('fasting').collection('fasting_chats'),
        };
        if (!agentChat[targetAgent]) continue;

        const userName = userData.name || '';
        const prompt = `You are a ${targetAgent} wellness coach in an app. Send ONE short proactive message (2-3 sentences max) to ${userName || 'the user'} about this cross-agent pattern you detected: ${spike}. Be direct and specific. Mention the exact data. End with one practical action they can take right now. No fluff, no emoji, no greeting.`;

        const completion = await _openai.chat.completions.create({
          model:       'gpt-4.1-mini',
          max_tokens:  120,
          temperature:  0.5,
          messages:    [{ role: 'user', content: prompt }],
        });
        const msg = completion.choices[0]?.message?.content?.trim();
        if (!msg) continue;

        await agentChat[targetAgent].add({
          role:           'assistant',
          content:        msg,
          is_proactive:   true,
          proactive_type: 'cross_agent_spike',
          spike_type:     spike,
          is_read:        false,
          created_at:     admin.firestore.FieldValue.serverTimestamp(),
        });
        await db.collection('wellness_users').doc(deviceId).update({
          last_cross_proactive_date: today,
        });
        fired++;
      } catch (e) {
        console.error(`[cross-proactive] ${deviceId}:`, e.message);
      }
    }
    console.log(`[cross-proactive] fired=${fired}`);
  } catch (e) {
    console.error('[cross-proactive] fatal:', e.message);
  }
}

cron.schedule('0 8,14 * * *', fireCrossAgentProactives, { timezone: 'UTC' });

module.exports = router;
module.exports.invalidateWellnessCache = invalidateWellnessCache;
