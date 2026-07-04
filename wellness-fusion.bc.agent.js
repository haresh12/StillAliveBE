'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// wellness-fusion.bc.agent.js — the Health Intelligence Fusion layer.
//
// This is part of the CROSS-AGENT layer (like wellness-combined): it is allowed to read across agents.
// It fuses the two data streams the app already stores:
//   • OUR DATA   — what the user logs (workouts, meals, water, sleep, mood) — via the shared reader
//                  exported from wellness-combined (single source of truth; no duplication).
//   • THEIR DATA — what their body measures (Apple Health / Health Connect) — via lib/hk-signals +
//                  the raw daily rows in health_samples.
//
// It produces two things every consumer can render, both parity-safe (empty for no-wearable users) and
// registration-anchor clamped:
//   1. getFusionBundle()  → { anchor, readiness, impacts[], coverage }
//        readiness  = body-level "how ready are you" read (recovery blend), NOT a 7th habit score.
//        impacts[]  = plain-language "our data × their data" cause→effect statements
//                     ("On the days you train, your sleep efficiency is 6% higher"). Never exposes r/p.
//   2. buildBriefing()    → the evening Daily Coach Briefing: what you did + what your body did +
//                           one thing to try, in the chosen coach's voice. Deterministic + localizable
//                           (key/vars/text parts, mirroring wellness-combined) with an OPTIONAL LLM
//                           coach-voice rewrite that falls back safely.
//
// LAWS honored: cross-agent reads only here; registration anchor; no composite indexes (single-field
// reads, filter in memory); no /v2 route suffix; max_completion_tokens; de-identified LLM (only numbers).
// ═══════════════════════════════════════════════════════════════════════════
const express = require('express');
const { resolveAnchor } = require('./lib/user-anchor');
const { computeAnalysisWindow, enumerateDaysFrom } = require('./lib/range-helpers');
const { userDoc } = require('./lib/collections');
const { getHealthSignals } = require('./lib/hk-signals');
const { getCoach } = require('./lib/coach-roster');
const { _shared } = require('./wellness-combined.bc.agent');

const router = express.Router();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r1 = (n) => Math.round(n * 10) / 10;
const pct = (a, b) => (b ? Math.round(((a - b) / Math.abs(b)) * 100) : 0);

// ── HK daily body-metric series (from health_samples). Each returns { 'YYYY-MM-DD': number }. ──
const HK_METRICS = {
  sleep_efficiency: { doc: 'sleep', label: 'sleep efficiency', unit: '%', better: 'high', ex: (v) => (v && v.efficiency != null ? v.efficiency : null) },
  sleep_hours:      { doc: 'sleep', label: 'sleep',            unit: 'h', better: 'high', ex: (v) => (v && v.asleep_min ? v.asleep_min / 60 : null) },
  resting_hr:       { doc: 'restingHeartRate', label: 'resting heart rate', unit: 'bpm', better: 'low',  ex: (v) => (typeof v === 'number' ? v : null) },
  hrv:              { doc: 'hrv', label: 'HRV',                unit: 'ms', better: 'high', ex: (v) => (typeof v === 'number' ? v : null) },
};

async function readDays(deviceId, docKey) {
  try { const s = await userDoc(deviceId).collection('health_samples').doc(docKey).get(); return (s.exists && s.data().days) || {}; }
  catch { return {}; }
}

// The behavior×body pairs we surface. behavior = first-party logged-day presence; metric = HK body
// metric measured that same day. We compare the metric's mean on logged days vs non-logged days.
const PAIRS = [
  { behavior: 'fitness', b_label: 'train',       metric: 'sleep_efficiency', key: 'impactFitSleepEff' },
  { behavior: 'fitness', b_label: 'train',       metric: 'resting_hr',       key: 'impactFitRhr' },
  { behavior: 'fitness', b_label: 'train',       metric: 'hrv',              key: 'impactFitHrv' },
  { behavior: 'water',   b_label: 'hit water',   metric: 'resting_hr',       key: 'impactWaterRhr' },
  { behavior: 'sleep',   b_label: 'log a wind-down', metric: 'hrv',          key: 'impactSleepHrv' },
];

function impactText(bLabel, mLabel, direction, magnitude, unit) {
  const dirWord = direction === 'up' ? 'higher' : 'lower';
  const mag = unit === '%' ? `${magnitude}%` : `${magnitude}${unit ? ' ' + unit : ''}`;
  return `On the days you ${bLabel}, your ${mLabel} is ${mag} ${dirWord}.`;
}

/**
 * The fused intelligence bundle for a device over `requestedDays`. Null-safe: readiness/impacts are
 * empty when there's no Apple Health data → no-wearable parity.
 */
async function getFusionBundle(deviceId, requestedDays = 30) {
  const anchor = await resolveAnchor(deviceId).catch(() => null);
  const anchorMs = (anchor && anchor.anchorMs) || 0;
  const tz = (anchor && anchor.utcOffsetMinutes) || 0;
  const win = computeAnalysisWindow(requestedDays, anchorMs, Date.now(), tz);
  const windowDates = enumerateDaysFrom(win.effectiveStartDate, win.todayDate);
  const inWin = new Set(windowDates);

  // ── Readiness (body-level) from the HK signal bundle ──
  const sig = await getHealthSignals(deviceId).catch(() => null);
  let readiness = null;
  if (sig && sig.recovery != null) {
    const drivers = [];
    if (sig.sleep && sig.sleep.last_hours != null) drivers.push({ key: 'sleep', label: 'sleep', value: sig.sleep.last_hours, unit: 'h' });
    if (sig.hrv && sig.hrv.latest != null) drivers.push({ key: 'hrv', label: 'HRV', value: sig.hrv.latest, unit: 'ms' });
    if (sig.rhr && sig.rhr.latest != null) drivers.push({ key: 'rhr', label: 'resting HR', value: sig.rhr.latest, unit: 'bpm' });
    readiness = { score: sig.recovery, band: sig.recovery_label, drivers };
  }

  // ── First-party logged series (shared reader — the ONE cross-agent read path) ──
  const firstParty = {};
  if (_shared && _shared.AGENTS && _shared.seriesFor) {
    for (const a of _shared.AGENTS) {
      try { firstParty[a.id] = await _shared.seriesFor(deviceId, a, win.effectiveStartDate, {}); }
      catch { firstParty[a.id] = {}; }
    }
  }
  const loggedDaysTotal = new Set(Object.values(firstParty).flatMap((s) => Object.keys(s || {})).filter((d) => inWin.has(d))).size;

  // ── HK body-metric series ──
  const hkDayMaps = {};
  const neededDocs = [...new Set(Object.values(HK_METRICS).map((m) => m.doc))];
  await Promise.all(neededDocs.map(async (d) => { hkDayMaps[d] = await readDays(deviceId, d); }));
  const hkSeries = {};
  for (const [name, m] of Object.entries(HK_METRICS)) {
    const days = hkDayMaps[m.doc] || {};
    const out = {};
    for (const d of windowDates) { const raw = days[d]; const v = raw == null ? null : m.ex(raw); if (typeof v === 'number' && isFinite(v)) out[d] = v; }
    hkSeries[name] = out;
  }
  const hasHk = Object.values(hkSeries).some((s) => Object.keys(s).length >= 3);

  // ── Impacts: our data × their data ──
  const impacts = [];
  for (const p of PAIRS) {
    const beh = firstParty[p.behavior] || {};
    const metric = hkSeries[p.metric] || {};
    const m = HK_METRICS[p.metric];
    const loggedVals = [], restVals = [];
    for (const d of windowDates) {
      const mv = metric[d];
      if (mv == null) continue;
      if (beh[d] && beh[d].logged) loggedVals.push(mv); else restVals.push(mv);
    }
    if (loggedVals.length < 3 || restVals.length < 3) continue; // need signal on both sides
    const lMean = mean(loggedVals), rMean = mean(restVals);
    if (lMean == null || rMean == null || rMean === 0) continue;
    const deltaPct = pct(lMean, rMean);
    if (Math.abs(deltaPct) < 4) continue; // ignore noise
    const direction = lMean > rMean ? 'up' : 'down';
    // "good" iff the change moves the metric the healthy way for that metric.
    const good = m.better === 'high' ? direction === 'up' : direction === 'down';
    const magnitude = m.unit === '%' || m.unit === 'bpm' || m.unit === 'ms'
      ? Math.abs(Math.round(lMean - rMean))
      : Math.abs(deltaPct);
    const displayUnit = m.unit === '%' ? '%' : (m.unit === 'h' ? '%' : m.unit);
    const magOut = displayUnit === '%' ? Math.abs(deltaPct) : magnitude;
    impacts.push({
      id: `${p.behavior}_${p.metric}`,
      cause_domain: p.behavior,
      effect_metric: p.metric,
      effect_label: m.label,
      direction,
      good,
      magnitude: magOut,
      unit: displayUnit,
      sample_days: loggedVals.length,
      strength: Math.min(1, (Math.abs(deltaPct) / 20) * (Math.min(loggedVals.length, 14) / 14)),
      key: p.key,
      vars: { behavior: p.b_label, metric: m.label, magnitude: magOut, unit: displayUnit, direction },
      text: impactText(p.b_label, m.label, direction, magOut, displayUnit),
    });
  }
  // Rank strongest, actionable, "good news first"; cap the surfaced set (log nothing dropped silently — small set).
  impacts.sort((a, b) => (b.strength + (b.good ? 0.1 : 0)) - (a.strength + (a.good ? 0.1 : 0)));
  const surfaced = impacts.slice(0, 5);

  const confidence = !hasHk ? 'none' : loggedDaysTotal < 3 ? 'low' : surfaced.length >= 2 ? 'high' : 'med';

  return {
    anchor: {
      effective_start_date: win.effectiveStartDate,
      effective_days: win.effectiveDays,
      days_since_anchor: (anchor && anchor.daysSinceAnchor) != null ? anchor.daysSinceAnchor : win.effectiveDays,
      anchor_date: (anchor && anchor.anchorDateStr) || null,
      is_clamped: win.isClamped,
      today_date: win.todayDate,
    },
    readiness,
    impacts: surfaced,
    coverage: { has_hk: hasHk, hk_days: Math.max(0, ...Object.values(hkSeries).map((s) => Object.keys(s).length), 0), logged_days: loggedDaysTotal, confidence },
  };
}

/** Domain-filtered impacts (for the per-coach Body Signals section — reads the precomputed bundle only,
 *  so the agent surface never itself reads across agents). */
function impactsForDomain(bundle, domain) {
  if (!bundle || !Array.isArray(bundle.impacts)) return [];
  return bundle.impacts.filter((i) => i.cause_domain === domain || i.effect_metric.startsWith(domain));
}

// ═══════════════════════════════════════════════════════════════════════════
// Evening Daily Coach Briefing — "this is what you've done" + what your body did + one thing to try.
// Returned as localizable parts (key + vars + English `text`, same pattern as wellness-combined) plus an
// optional LLM `message` in the coach's voice + user's language. has_content=false → FE shows nothing.
// ═══════════════════════════════════════════════════════════════════════════
async function readCoach(deviceId) {
  try { const u = (await userDoc(deviceId).get()).data() || {}; return getCoach(u.coach_id, u.coach_name); }
  catch { return getCoach(null, null); }
}

async function buildBriefing(deviceId, lang, tz) {
  const bundle = await getFusionBundle(deviceId, 30).catch(() => null);
  const coach = await readCoach(deviceId);
  const today = (bundle && bundle.anchor && bundle.anchor.today_date) || null;

  // Once-a-day cache: the evening recap is computed ONCE per day (keyed by the user's local date) and
  // reused on every foreground/fetch — so the LLM runs at most once/day and the message stays stable.
  // Keyed by date so it naturally refreshes tomorrow. Best-effort (a read/write failure just recomputes).
  const cacheRef = today ? userDoc(deviceId).collection('fusion_briefings').doc(today) : null;
  if (cacheRef) {
    try { const c = await cacheRef.get(); if (c.exists && c.data() && c.data().message) return c.data(); }
    catch { /* fall through and recompute */ }
  }

  // ── What you did today (first-party logged + HK body) ──
  const did = [];
  const sig = await getHealthSignals(deviceId).catch(() => null);
  if (sig) {
    if (sig.workouts7 && sig.workouts7.last && sig.workouts7.last.date === today) {
      did.push({ key: 'didWorkout', vars: { minutes: sig.workouts7.last.minutes, type: sig.workouts7.last.workout_type }, text: `trained ${sig.workouts7.last.minutes} min` });
    }
    if (sig.steps && sig.steps.latest != null) did.push({ key: 'didSteps', vars: { steps: sig.steps.latest }, text: `${sig.steps.latest.toLocaleString()} steps` });
  }
  // First-party today entries (via shared reader over a 1-day window).
  if (_shared && _shared.AGENTS && _shared.seriesFor && today) {
    for (const a of _shared.AGENTS) {
      try {
        const s = await _shared.seriesFor(deviceId, a, today, {});
        if (s[today] && s[today].logged) did.push({ key: `didLog_${a.id}`, vars: { label: a.label }, text: `logged ${a.label.toLowerCase()}` });
      } catch { /* no data */ }
    }
  }

  // ── What your body is saying ──
  const body = [];
  if (bundle && bundle.readiness) {
    body.push({ key: 'bodyReadiness', vars: { score: bundle.readiness.score, band: bundle.readiness.band }, text: `Recovery is ${bundle.readiness.score}/100 (${bundle.readiness.band}).` });
  }
  const topImpact = bundle && bundle.impacts && bundle.impacts[0];
  if (topImpact) body.push({ key: topImpact.key, vars: topImpact.vars, text: topImpact.text });

  // ── One thing to try (deterministic, tied to readiness/impact) ──
  let one = null;
  if (bundle && bundle.readiness) {
    if (bundle.readiness.band === 'low') one = { key: 'tryRest', vars: {}, text: 'Ease off tomorrow — prioritize sleep, protein and water.' };
    else if (bundle.readiness.band === 'high') one = { key: 'tryPush', vars: {}, text: 'Your body is primed — a harder session tomorrow is well within reach.' };
  }
  if (!one && topImpact && topImpact.good) one = { key: 'tryRepeat', vars: topImpact.vars, text: `Keep it up — the days you ${topImpact.vars.behavior} clearly pay off.` };
  if (!one) one = { key: 'tryLog', vars: {}, text: 'Log one thing tomorrow and I’ll start connecting the dots for you.' };

  const has_content = did.length > 0 || body.length > 0;

  // Deterministic English message (fallback / preview).
  const parts = [];
  if (did.length) parts.push(`Today you ${did.map((d) => d.text).join(', ')}.`);
  if (body.length) parts.push(body.map((b) => b.text).join(' '));
  parts.push(one.text);
  let message = parts.join(' ');

  // ── OPTIONAL coach-voice rewrite (de-identified; only numbers; safe fallback) ──
  try {
    if (process.env.OPENAI_API_KEY && has_content) {
      const OpenAI = require('openai');
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const MODEL = process.env.BRIEFING_MODEL || process.env.NOTIF_COPY_MODEL || 'gpt-5.4-mini';
      const facts = { did: did.map((d) => d.text), body: body.map((b) => b.text), suggestion: one.text };
      const langLine = lang && lang !== 'en' ? `Write in this language: ${lang}.` : '';
      const r = await openai.chat.completions.create({
        model: MODEL,
        messages: [
          { role: 'system', content: `You are ${coach.name}, the user's coach. Personality: ${coach.persona}. Write ONE short evening check-in (3-4 warm sentences, second person) that reflects back what they did today, what their body signals show, and the one suggestion. Natural, specific, never clinical. Never say "Apple Health", "HealthKit" or "from your watch". No markdown, no emoji spam (at most one). ${langLine}` },
          { role: 'user', content: JSON.stringify(facts) },
        ],
        max_completion_tokens: 260,
      });
      const txt = r && r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content;
      if (txt && txt.trim()) message = txt.trim();
    }
  } catch { /* keep deterministic message */ }

  const result = {
    ok: true,
    date: today,
    has_content,
    coach: { name: coach.name },
    did, body, one_thing: one,
    message,
    anchor: (bundle && bundle.anchor) || null,
    coverage: (bundle && bundle.coverage) || null,
  };
  // Cache today's recap (only when there's something worth saying → we don't pin an empty day).
  if (cacheRef && has_content) { try { await cacheRef.set(result); } catch { /* best-effort */ } }
  return result;
}

// ── Routes (no /v2 suffix; mounted at /api/wellness-fusion) ──
router.get('/fusion', async (req, res) => {
  const deviceId = req.query.deviceId || req.query.device_id;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  const range = Number(req.query.range || 30) || 30;
  try { return res.json({ ok: true, ...(await getFusionBundle(deviceId, range)) }); }
  catch (e) { return res.status(500).json({ error: e?.message || 'fusion failed' }); }
});

router.get('/briefing', async (req, res) => {
  const deviceId = req.query.deviceId || req.query.device_id;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  const lang = (req.query.lang || 'en').toString().slice(0, 8);
  const tz = Number(req.query.tz || 0) || 0;
  try { return res.json(await buildBriefing(deviceId, lang, tz)); }
  catch (e) { return res.status(500).json({ error: e?.message || 'briefing failed', has_content: false }); }
});

module.exports = router;
module.exports._fn = { getFusionBundle, buildBriefing, impactsForDomain };
