'use strict';
// ════════════════════════════════════════════════════════════════════
// cross-agent-engine.js — SANDBOX-EXEMPT
// The ONLY file allowed to read across all 6 agents.
// Computes WellnessScore, correlations (Pearson + Holm-Bonferroni),
// AHA moments, weekly Meta Coach summary.
// Reuses existing OPENAI_API_KEY (gpt-4o-mini for daily, gpt-4o for weekly).
// ════════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');
const { OpenAI } = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const db        = () => admin.firestore();
const userDoc   = (id) => db().collection('wellness_users').doc(id);
const agentDoc  = (id, agent) => userDoc(id).collection('agents').doc(agent);
const snapsCol  = (id) => userDoc(id).collection('wellness_snapshots');
const corrDoc   = (id) => userDoc(id).collection('wellness_meta').doc('correlations');
const ahaDoc    = (id) => userDoc(id).collection('wellness_meta').doc('aha');
const metaDoc   = (id) => userDoc(id).collection('wellness_meta').doc('coach');
const costsDoc  = (id, ym) => userDoc(id).collection('llm_costs').doc(ym);

// ─── CONSTANTS ─────────────────────────────────────────────────────
const AGENTS = ['fitness', 'sleep', 'mind', 'nutrition', 'water', 'fasting'];
const WEIGHTS = { fitness: 0.25, sleep: 0.25, mind: 0.15, nutrition: 0.15, water: 0.10, fasting: 0.10 };

// AI cost ceilings per user per month
const COST_CEILING = { aha: 31, meta: 5, breakdown: 50 };

// Correlation thresholds (Cohen 1988, Schönbrodt & Perugini 2013, Holm 1979)
const CORR_MIN_N      = 30;
const CORR_MIN_R      = 0.30;
const CORR_ALPHA      = 0.05;

// ─── HELPERS ───────────────────────────────────────────────────────
const millis = (ts) => {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts._seconds) return ts._seconds * 1000;
  return new Date(ts).getTime() || 0;
};
const dateStr = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
const daysBetween = (a, b) => Math.floor((b - a) / 86400000);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const round = (n, p = 0) => { const k = 10 ** p; return Math.round(n * k) / k; };
const mean = (arr) => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;
const stdev = (arr) => {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
};

// ─── DATA FETCH (last N days, all 6 agents in parallel) ─────────────
async function fetchAllAgentData(deviceId, days = 90) {
  const cutoff = Date.now() - days * 86400000;
  const cutoffTs = admin.firestore.Timestamp.fromMillis(cutoff);

  const [mind, sleep, water, fasting, nutrition, fitness] = await Promise.all([
    agentDoc(deviceId, 'mind').collection('mind_checkins')
      .where('logged_at', '>=', cutoffTs).orderBy('logged_at', 'desc').limit(500).get()
      .then(s => s.docs.map(d => d.data())).catch(() => []),
    agentDoc(deviceId, 'sleep').collection('sleep_logs')
      .where('logged_at', '>=', cutoffTs).orderBy('logged_at', 'desc').limit(200).get()
      .then(s => s.docs.map(d => d.data())).catch(() => []),
    agentDoc(deviceId, 'water').collection('water_logs')
      .where('logged_at', '>=', cutoffTs).orderBy('logged_at', 'desc').limit(2000).get()
      .then(s => s.docs.map(d => d.data())).catch(() => []),
    agentDoc(deviceId, 'fasting').collection('fasting_sessions')
      .where('started_at', '>=', cutoffTs).orderBy('started_at', 'desc').limit(200).get()
      .then(s => s.docs.map(d => d.data())).catch(() => []),
    agentDoc(deviceId, 'nutrition').collection('food_logs')
      .where('logged_at', '>=', cutoffTs).orderBy('logged_at', 'desc').limit(2000).get()
      .then(s => s.docs.map(d => d.data())).catch(() => []),
    agentDoc(deviceId, 'fitness').collection('fitness_workouts')
      .where('logged_at', '>=', cutoffTs).orderBy('logged_at', 'desc').limit(200).get()
      .then(s => s.docs.map(d => d.data())).catch(() => []),
  ]);

  return { mind, sleep, water, fasting, nutrition, fitness };
}

// ─── PER-AGENT DAILY VALUE EXTRACTORS (0-100 normalized) ────────────
function dailyMind(checkins) {
  const byDate = {};
  checkins.forEach(c => {
    const d = c.date_str || dateStr(millis(c.logged_at));
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(c.mood_score || 0);
  });
  const out = {};
  Object.entries(byDate).forEach(([d, arr]) => {
    out[d] = round((mean(arr) / 5) * 100);
  });
  return out;
}
function dailySleep(logs) {
  const byDate = {};
  logs.forEach(l => {
    const d = l.date_str || dateStr(millis(l.logged_at));
    if (!byDate[d]) {
      byDate[d] = {
        quality: l.sleep_quality || 3,
        duration: l.duration_min || l.duration_minutes || 0,
        efficiency: l.sleep_efficiency || 0,
      };
    }
  });
  const out = {};
  Object.entries(byDate).forEach(([d, v]) => {
    const qPart = (v.quality / 5) * 60;
    const dHours = v.duration / 60;
    const dPart = clamp(((dHours / 8) * 40), 0, 40);
    out[d] = round(qPart + dPart);
  });
  return out;
}
function dailyWater(logs) {
  const byDate = {};
  logs.forEach(l => {
    const d = l.date_str || dateStr(millis(l.logged_at));
    byDate[d] = (byDate[d] || 0) + (l.effective_ml || l.amount_ml || 0);
  });
  const out = {};
  Object.entries(byDate).forEach(([d, ml]) => {
    out[d] = clamp(round((ml / 2500) * 100), 0, 100);
  });
  return out;
}
function dailyFasting(sessions) {
  const byDate = {};
  sessions.forEach(s => {
    const d = dateStr(millis(s.started_at));
    const planned = s.planned_hours || 16;
    const actual  = s.actual_hours || 0;
    const ratio   = planned > 0 ? actual / planned : 0;
    byDate[d] = clamp(round(ratio * 100), 0, 100);
  });
  return byDate;
}
function dailyNutrition(logs) {
  const byDate = {};
  logs.forEach(l => {
    const d = l.date_str || dateStr(millis(l.logged_at));
    if (!byDate[d]) byDate[d] = { cal: 0, protein: 0 };
    byDate[d].cal     += (l.calories || 0);
    byDate[d].protein += (l.protein || 0);
  });
  const out = {};
  Object.entries(byDate).forEach(([d, v]) => {
    const calScore = v.cal > 0 && v.cal < 4000 ? 50 : 0;
    const proteinScore = clamp((v.protein / 130) * 50, 0, 50);
    out[d] = round(calScore + proteinScore);
  });
  return out;
}
function dailyFitness(workouts) {
  const byDate = {};
  workouts.forEach(w => {
    const d = w.date_str || dateStr(millis(w.logged_at));
    const setCount = (w.exercises || []).reduce((s, e) => s + ((e.sets || []).length), 0);
    const dur = w.duration_min || 0;
    byDate[d] = clamp(round((setCount / 20) * 60 + (dur / 60) * 40), 0, 100);
  });
  return byDate;
}

// ─── WELLNESS SCORE ────────────────────────────────────────────────
function buildDailyMatrix(data) {
  return {
    fitness:   dailyFitness(data.fitness),
    sleep:     dailySleep(data.sleep),
    mind:      dailyMind(data.mind),
    nutrition: dailyNutrition(data.nutrition),
    water:     dailyWater(data.water),
    fasting:   dailyFasting(data.fasting),
  };
}

function computeWellnessScore(matrix, days = 7) {
  const cutoff = Date.now() - days * 86400000;
  const subscores = {};
  const excluded  = [];
  let included    = 0;
  let weightSum   = 0;

  for (const agent of AGENTS) {
    const series = matrix[agent] || {};
    const recent = Object.entries(series)
      .filter(([d]) => new Date(d).getTime() >= cutoff)
      .map(([, v]) => v);
    if (recent.length === 0) {
      // exclude if no data in last 14 days too
      const cutoff14 = Date.now() - 14 * 86400000;
      const r14 = Object.entries(series)
        .filter(([d]) => new Date(d).getTime() >= cutoff14)
        .map(([, v]) => v);
      if (r14.length === 0) {
        excluded.push(agent);
        subscores[agent] = null;
        continue;
      }
    }
    subscores[agent] = round(mean(recent.length ? recent : [0]));
    weightSum += WEIGHTS[agent];
    included++;
  }

  let total = 0;
  for (const agent of AGENTS) {
    if (subscores[agent] === null) continue;
    const adjustedWeight = WEIGHTS[agent] / (weightSum || 1);
    total += subscores[agent] * adjustedWeight;
  }

  return {
    score: round(total),
    subscores,
    excluded,
    weights: WEIGHTS,
  };
}

function computeDelta(matrix) {
  const todayScore = computeWellnessScore(matrix, 1).score;
  const yesterdayMatrix = {};
  for (const agent of AGENTS) {
    const series = matrix[agent] || {};
    const yesterday = dateStr(Date.now() - 86400000);
    yesterdayMatrix[agent] = series[yesterday] != null ? { [yesterday]: series[yesterday] } : {};
  }
  const yScore = computeWellnessScore(yesterdayMatrix, 2).score;
  return todayScore - yScore;
}

// ─── CORRELATION ENGINE (Pearson + Holm-Bonferroni) ─────────────────
function pearson(xs, ys) {
  const n = xs.length;
  if (n < CORR_MIN_N) return null;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  if (denom === 0) return null;
  return num / denom;
}

// Approximate two-tailed p-value for Pearson r (Fisher z transform)
function pearsonPvalue(r, n) {
  if (n < 4) return 1;
  const z = 0.5 * Math.log((1 + r) / (1 - r));
  const se = 1 / Math.sqrt(n - 3);
  const stat = Math.abs(z / se);
  // two-tailed normal approximation
  const p = 2 * (1 - normalCdf(stat));
  return clamp(p, 0, 1);
}
function normalCdf(x) {
  // Abramowitz & Stegun 26.2.17
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

function computeCorrelations(matrix) {
  const pairs = [];
  for (let i = 0; i < AGENTS.length; i++) {
    for (let j = i + 1; j < AGENTS.length; j++) {
      pairs.push([AGENTS[i], AGENTS[j]]);
    }
  }
  const lags = [0, 1, 3];
  const candidates = [];

  for (const [a, b] of pairs) {
    const sa = matrix[a] || {};
    const sb = matrix[b] || {};
    const datesA = Object.keys(sa);
    if (datesA.length < CORR_MIN_N) continue;

    for (const lag of lags) {
      const xs = [], ys = [];
      datesA.forEach(d => {
        const dt  = new Date(d);
        const lag_d = dateStr(dt.getTime() + lag * 86400000);
        if (sa[d] != null && sb[lag_d] != null) {
          xs.push(sa[d]); ys.push(sb[lag_d]);
        }
      });
      const r = pearson(xs, ys);
      if (r == null) continue;
      const p = pearsonPvalue(r, xs.length);
      candidates.push({ a, b, lag, r: round(r, 3), p, n: xs.length });
    }
  }

  // Holm-Bonferroni
  candidates.sort((x, y) => x.p - y.p);
  const m = candidates.length;
  const accepted = [];
  for (let i = 0; i < m; i++) {
    const adj = candidates[i].p * (m - i);
    candidates[i].p_adj = round(adj, 4);
    if (adj < CORR_ALPHA && Math.abs(candidates[i].r) >= CORR_MIN_R) {
      accepted.push(candidates[i]);
    } else {
      break;
    }
  }
  // Sort accepted by |r| desc
  accepted.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
  return accepted.slice(0, 10);
}

// ─── AI: AHA generation (gpt-4o-mini, cached) ───────────────────────
function correlationHash(c) {
  return `${c.a}_${c.b}_lag${c.lag}_r${Math.round(c.r * 10)}`;
}

async function bumpCost(deviceId, kind) {
  const ym = new Date().toISOString().slice(0, 7);
  await costsDoc(deviceId, ym).set({
    [kind]: admin.firestore.FieldValue.increment(1),
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}
async function checkBudget(deviceId, kind) {
  const ym = new Date().toISOString().slice(0, 7);
  const snap = await costsDoc(deviceId, ym).get();
  const used = (snap.exists ? (snap.data()[kind] || 0) : 0);
  return used < COST_CEILING[kind];
}

async function generateAhaText(correlation) {
  const { a, b, r, lag, n } = correlation;
  const direction = r > 0 ? 'higher' : 'lower';
  const magnitude = Math.abs(r) >= 0.5 ? 'strong' : 'moderate';
  const prompt = `Write ONE sentence (max 20 words) explaining this wellness correlation in plain English to a non-scientist user. Be specific and actionable.

Data: When user's ${a} score is high, their ${b} score ${lag} day(s) later is ${direction} (${magnitude} correlation, r=${r}, n=${n} days).

Use everyday words. NO jargon. NO "correlation". NO "r=". Just the insight. End with a number when possible.

Example good: "Days you sleep 7+ hours, your mood scores 1.4× higher the next day."
Output ONLY the sentence. No quotes, no preamble.`;

  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.4,
      max_tokens: 60,
      messages: [{ role: 'user', content: prompt }],
    });
    return (resp.choices[0]?.message?.content || '').trim().replace(/^["']|["']$/g, '');
  } catch (e) {
    console.warn('[cross-agent] AHA fail:', e.message);
    return `Your ${a} and ${b} are linked — focus on both together.`;
  }
}

async function getOrGenerateAha(deviceId, top) {
  if (!top) return null;
  const hash = correlationHash(top);
  const snap = await ahaDoc(deviceId).get();
  const cached = snap.exists ? snap.data() : {};
  if (cached.hash === hash && cached.text) {
    return { text: cached.text, correlation: top, cached: true };
  }
  if (!(await checkBudget(deviceId, 'aha'))) {
    return cached.text ? { text: cached.text, correlation: top, cached: true, capped: true } : null;
  }
  const text = await generateAhaText(top);
  await bumpCost(deviceId, 'aha');
  await ahaDoc(deviceId).set({
    hash, text, correlation: top, generated_at: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { text, correlation: top, cached: false };
}

// ─── AI: Weekly Meta Coach (gpt-4o, cached per ISO week) ────────────
function isoWeek(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

async function generateMetaCoach({ score, subscores, correlations, trend7d, trend30d }) {
  const prompt = `You are the user's wellness coach. Write a 3-sentence weekly summary (max 60 words total).

Current Wellness Score: ${score}/100
Subscores: ${Object.entries(subscores).filter(([_, v]) => v != null).map(([k, v]) => `${k} ${v}`).join(', ')}
Top correlations this week: ${correlations.slice(0, 2).map(c => `${c.a}↔${c.b} r=${c.r}`).join('; ') || 'none yet (need more data)'}
7-day score change: ${trend7d > 0 ? '+' : ''}${trend7d}
30-day trend: ${trend30d > 0 ? 'up' : trend30d < 0 ? 'down' : 'flat'}

Sentence 1: What's working (cite a specific number).
Sentence 2: What's the #1 lever this week (specific action, not generic).
Sentence 3: One small change to test next week.

NO jargon. NO bullet points. Just 3 sentences. Address the user directly ("you").`;

  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.5,
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });
    return (resp.choices[0]?.message?.content || '').trim();
  } catch (e) {
    console.warn('[cross-agent] meta fail:', e.message);
    return null;
  }
}

async function getOrGenerateMeta(deviceId, payload) {
  const week = isoWeek();
  const snap = await metaDoc(deviceId).get();
  const cached = snap.exists ? snap.data() : {};
  if (cached.week === week && cached.text) {
    return { text: cached.text, week, cached: true };
  }
  if (!(await checkBudget(deviceId, 'meta'))) {
    return cached.text ? { text: cached.text, week: cached.week, capped: true } : null;
  }
  const text = await generateMetaCoach(payload);
  if (!text) return null;
  await bumpCost(deviceId, 'meta');
  await metaDoc(deviceId).set({
    week, text, generated_at: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { text, week, cached: false };
}

// ─── DERIVED SIGNALS ───────────────────────────────────────────────
function computeStreak(matrix) {
  // any-agent log streak (consecutive days with at least one agent logged)
  const allDates = new Set();
  for (const agent of AGENTS) {
    Object.keys(matrix[agent] || {}).forEach(d => allDates.add(d));
  }
  let streak = 0;
  for (let i = 0; i < 90; i++) {
    const d = dateStr(Date.now() - i * 86400000);
    if (allDates.has(d)) streak++;
    else if (i > 0) break;
  }
  return streak;
}

function computeStreakDots(matrix) {
  // last 7 days, true/false logged
  const allDates = new Set();
  for (const agent of AGENTS) {
    Object.keys(matrix[agent] || {}).forEach(d => allDates.add(d));
  }
  return Array.from({ length: 7 }, (_, i) => {
    const d = dateStr(Date.now() - (6 - i) * 86400000);
    return { date: d, logged: allDates.has(d) };
  });
}

function computeTrend(matrix, days) {
  const cutoff = Date.now() - days * 86400000;
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = dateStr(Date.now() - i * 86400000);
    const dayMatrix = {};
    for (const agent of AGENTS) {
      dayMatrix[agent] = matrix[agent]?.[d] != null ? { [d]: matrix[agent][d] } : {};
    }
    const { score } = computeWellnessScore(dayMatrix, 1);
    series.push({ date: d, score });
  }
  return series;
}

function computeWeekdayHeatmap(matrix) {
  const buckets = Array.from({ length: 7 }, () => []);
  const labels  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (let i = 0; i < 60; i++) {
    const d = dateStr(Date.now() - i * 86400000);
    const dayMatrix = {};
    let hasData = false;
    for (const agent of AGENTS) {
      if (matrix[agent]?.[d] != null) { hasData = true; dayMatrix[agent] = { [d]: matrix[agent][d] }; }
      else dayMatrix[agent] = {};
    }
    if (!hasData) continue;
    const { score } = computeWellnessScore(dayMatrix, 1);
    const wd = new Date(d).getDay();
    buckets[wd].push(score);
  }
  return labels.map((label, i) => ({
    day: label,
    avg: buckets[i].length ? round(mean(buckets[i])) : null,
    n: buckets[i].length,
  }));
}

function computeRiskAlerts(matrix) {
  const alerts = [];
  const last7 = (agent) => {
    const out = [];
    for (let i = 0; i < 7; i++) {
      const d = dateStr(Date.now() - i * 86400000);
      if (matrix[agent]?.[d] != null) out.push(matrix[agent][d]);
    }
    return out;
  };
  const prev7 = (agent) => {
    const out = [];
    for (let i = 7; i < 14; i++) {
      const d = dateStr(Date.now() - i * 86400000);
      if (matrix[agent]?.[d] != null) out.push(matrix[agent][d]);
    }
    return out;
  };
  for (const agent of AGENTS) {
    const a = last7(agent), b = prev7(agent);
    if (a.length < 3 || b.length < 3) continue;
    const ma = mean(a), mb = mean(b);
    if (mb > 0 && (ma - mb) / mb < -0.15) {
      alerts.push({
        agent,
        severity: 'medium',
        message: `Your ${agent} is down ${round(((mb - ma) / mb) * 100)}% this week vs last.`,
      });
    }
  }
  return alerts.slice(0, 3);
}

function computeMilestones(matrix) {
  const milestones = [];
  const streak = computeStreak(matrix);
  if (streak >= 7) milestones.push({ icon: 'flame', title: `${streak}-day streak`, hit: true });
  for (const agent of AGENTS) {
    const dates = Object.keys(matrix[agent] || {});
    if (dates.length >= 30) milestones.push({ icon: 'trophy', title: `30 ${agent} logs`, hit: true });
  }
  return milestones.slice(0, 5);
}

function computeTodayFocus(matrix, correlations) {
  // Pick the agent with the lowest 7d subscore; suggest a concrete action
  const todayScore = computeWellnessScore(matrix, 7);
  let worstAgent = null, worstScore = 101;
  for (const agent of AGENTS) {
    const v = todayScore.subscores[agent];
    if (v != null && v < worstScore) { worstScore = v; worstAgent = agent; }
  }
  if (!worstAgent) return null;
  const focusMap = {
    sleep:     { title: 'Lock in 7+ hours tonight', cta: 'Set sleep target' },
    fitness:   { title: 'Move for 20 minutes today', cta: 'Log a workout' },
    mind:      { title: 'Take a 5-min check-in', cta: 'Open Mind' },
    nutrition: { title: 'Hit your protein target', cta: 'Log a meal' },
    water:     { title: 'Drink 500ml in the next hour', cta: 'Log water' },
    fasting:   { title: 'Plan tonight\'s eating window', cta: 'Open Fasting' },
  };
  return { agent: worstAgent, ...focusMap[worstAgent], score: worstScore };
}

// ─── DATA MATURITY (empty state stages) ─────────────────────────────
function computeDataMaturity(matrix) {
  const allDates = new Set();
  for (const agent of AGENTS) Object.keys(matrix[agent] || {}).forEach(d => allDates.add(d));
  const days = allDates.size;
  const agentsWithData = AGENTS.filter(a => Object.keys(matrix[a] || {}).length > 0);
  let stage;
  if (days === 0) stage = 0;
  else if (days < 7) stage = 1;
  else if (days < 14) stage = 2;
  else if (days < 30) stage = 3;
  else stage = 4;
  return { stage, days, agentsWithData };
}

// ─── MAIN: snapshot + Home + Insights payloads ──────────────────────
async function buildHomePayload(deviceId) {
  const data = await fetchAllAgentData(deviceId, 30);
  const matrix = buildDailyMatrix(data);
  const { score, subscores, excluded, weights } = computeWellnessScore(matrix, 7);
  const delta = computeDelta(matrix);
  const streak = computeStreak(matrix);
  const streakDots = computeStreakDots(matrix);
  const milestones = computeMilestones(matrix);
  const maturity = computeDataMaturity(matrix);

  // Correlations cached or fresh-light
  let correlations = [];
  try {
    const corr = await corrDoc(deviceId).get();
    correlations = corr.exists ? (corr.data().pairs || []) : [];
  } catch {}

  const focus = computeTodayFocus(matrix, correlations);
  const aha = (maturity.stage >= 4 && correlations[0])
    ? await getOrGenerateAha(deviceId, correlations[0])
    : null;

  // Tonight/Tomorrow plan (rule-based, fast)
  const tonight = {
    sleep_target: subscores.sleep != null && subscores.sleep < 70 ? '7h 30m' : '7h',
    am_workout:   (subscores.fitness == null || subscores.fitness < 60),
    water_first:  '500ml on wake',
  };

  // Per-agent tile data
  const tiles = AGENTS.map(agent => {
    const series = matrix[agent] || {};
    const dates = Object.keys(series).sort().slice(-7);
    return {
      agent,
      score: subscores[agent],
      delta: dates.length >= 2
        ? round(series[dates[dates.length - 1]] - series[dates[0]])
        : 0,
      sparkline: dates.map(d => series[d]),
      excluded: excluded.includes(agent),
    };
  });

  return {
    score, delta, subscores, excluded, weights,
    streak, streak_dots: streakDots,
    tiles, focus, tonight, milestones, aha,
    maturity,
    generated_at: Date.now(),
  };
}

async function buildInsightsPayload(deviceId) {
  const data = await fetchAllAgentData(deviceId, 90);
  const matrix = buildDailyMatrix(data);
  const { score, subscores, excluded, weights } = computeWellnessScore(matrix, 7);
  const maturity = computeDataMaturity(matrix);

  let correlations = [];
  if (maturity.stage >= 4) {
    correlations = computeCorrelations(matrix);
    await corrDoc(deviceId).set({
      pairs: correlations,
      computed_at: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  const trend30d = computeTrend(matrix, 30);
  const trend7d  = computeTrend(matrix, 7);
  const heatmap  = computeWeekdayHeatmap(matrix);
  const risks    = computeRiskAlerts(matrix);

  const radar = AGENTS.map(agent => ({
    agent,
    score: subscores[agent] ?? 0,
    excluded: excluded.includes(agent),
  }));

  // Habit stack: sequences of agents most logged on high-score days
  const habitStack = computeHabitStack(matrix);

  let meta = null;
  if (maturity.stage >= 3) {
    const t7  = trend7d.length >= 2 ? trend7d[trend7d.length - 1].score - trend7d[0].score : 0;
    const t30 = trend30d.length >= 2 ? trend30d[trend30d.length - 1].score - trend30d[0].score : 0;
    meta = await getOrGenerateMeta(deviceId, { score, subscores, correlations, trend7d: t7, trend30d: t30 });
  }

  return {
    score, subscores, excluded, weights,
    correlations,
    trend30d, trend7d,
    heatmap, risks, radar,
    habit_stack: habitStack,
    meta,
    maturity,
    generated_at: Date.now(),
  };
}

function computeHabitStack(matrix) {
  // For days where score >= 75, which agents were most often logged?
  const allDates = new Set();
  for (const agent of AGENTS) Object.keys(matrix[agent] || {}).forEach(d => allDates.add(d));
  const counts = {};
  let goodDays = 0;
  for (const d of allDates) {
    const dayMatrix = {};
    for (const agent of AGENTS) {
      dayMatrix[agent] = matrix[agent]?.[d] != null ? { [d]: matrix[agent][d] } : {};
    }
    const { score } = computeWellnessScore(dayMatrix, 1);
    if (score >= 75) {
      goodDays++;
      for (const agent of AGENTS) {
        if (matrix[agent]?.[d] != null) counts[agent] = (counts[agent] || 0) + 1;
      }
    }
  }
  if (goodDays === 0) return [];
  return AGENTS
    .map(a => ({ agent: a, frequency: round((counts[a] || 0) / goodDays * 100) }))
    .filter(x => x.frequency >= 60)
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, 4);
}

// ─── DAILY SNAPSHOT (called by cron) ────────────────────────────────
async function persistDailySnapshot(deviceId) {
  const today = dateStr(Date.now());
  const data = await fetchAllAgentData(deviceId, 30);
  const matrix = buildDailyMatrix(data);
  const ws = computeWellnessScore(matrix, 7);
  await snapsCol(deviceId).doc(today).set({
    date: today,
    score: ws.score,
    subscores: ws.subscores,
    excluded: ws.excluded,
    saved_at: admin.firestore.FieldValue.serverTimestamp(),
  });
  return ws;
}

module.exports = {
  AGENTS, WEIGHTS,
  buildHomePayload, buildInsightsPayload, persistDailySnapshot,
  // exposed for tests / debug
  buildDailyMatrix, computeWellnessScore, computeCorrelations,
  computeDataMaturity, computeStreak,
  fetchAllAgentData,
};
