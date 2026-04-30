'use strict';
// ════════════════════════════════════════════════════════════════════
// reports-engine.js — weekly + monthly performance reports (gpt-4o)
//
// Firestore paths:
//   wellness_users/{deviceId}/wellness_reports/{reportId}
//     weekly  → reportId: weekly_YYYY-WNN
//     monthly → reportId: monthly_YYYY-MM
//
// Caching: if a report already exists for the current ISO week (weekly)
// or current YYYY-MM (monthly) it is returned immediately without an
// LLM call.
//
// Cost tracking: wellness_users/{deviceId}/llm_costs/{YYYY-MM}
//   field: reports  (FieldValue.increment)
// ════════════════════════════════════════════════════════════════════
const admin  = require('firebase-admin');
const { OpenAI } = require('openai');
const { SYSTEM_SAFETY_PREFIX } = require('./cross-agent-safety');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Firestore helpers ───────────────────────────────────────────────
const userDoc    = (id)       => admin.firestore().collection('wellness_users').doc(id);
const reportDoc  = (id, rid)  => userDoc(id).collection('wellness_reports').doc(rid);
const costsDoc   = (id, ym)   => userDoc(id).collection('llm_costs').doc(ym);

// ─── Date helpers ────────────────────────────────────────────────────

/** Returns ISO week string: YYYY-WNN */
function isoWeekId(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const w = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `weekly_${date.getUTCFullYear()}-W${String(w).padStart(2, '0')}`;
}

/** Returns current YYYY-MM */
function monthId() {
  return `monthly_${new Date().toISOString().slice(0, 7)}`;
}

/** YYYY-MM for cost tracking */
function ym() {
  return new Date().toISOString().slice(0, 7);
}

// ─── Cost tracking ───────────────────────────────────────────────────
async function bumpReportCost(deviceId) {
  await costsDoc(deviceId, ym()).set({
    reports: admin.firestore.FieldValue.increment(1),
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

// ─── Compact prompt context (mirrors coach-letter.js pattern) ────────
function buildPromptInput(ctx, harvest, findings, scoreImpact) {
  return {
    name: ctx.profile?.name || null,
    setup_count: harvest?.counts?.setup_count || 0,
    total_logs: harvest?.counts?.logs || 0,
    overall_completion: harvest?.overall_completion,
    contributors: (harvest?.contributors || [])
      .filter(c => c.setup)
      .map(c => ({
        agent:          c.agent,
        score:          c.score,
        recent_value:   c.recent_value_label,
        baseline_value: c.baseline_label,
        delta:          c.delta_vs_baseline,
        status:         c.status,
      })),
    wins:  (scoreImpact?.wins  || []).slice(0, 4).map(w => ({ kind: w.kind,  title: w.title })),
    costs: (scoreImpact?.costs || []).slice(0, 4).map(c => ({ kind: c.kind, title: c.title, cost: c.cost })),
    top_findings: (findings || []).slice(0, 3).map(f => ({
      label: f.label, summary: f.summary, direction: f.direction,
    })),
    hypotheses: (ctx.hypotheses || [])
      .filter(h => h.status === 'confirmed' || h.status === 'tracking')
      .slice(0, 2)
      .map(h => ({ a: h.a, b: h.b, status: h.status, n: h.last_n })),
  };
}

// ─── Weekly report ───────────────────────────────────────────────────

const WEEKLY_SYSTEM = `You are Pulse — a data-grounded wellness coach.
Generate a weekly performance report for the user. Use ONLY the data provided.
Voice: Direct, warm, honest. Never generic ("great job", "amazing"). Cite 3+ specific numbers.
Structure (JSON output):
{
  "headline": "one bold sentence, max 12 words, like a newspaper headline",
  "narrative": "3 paragraphs max 250 words. Para 1: this week's story. Para 2: what worked. Para 3: honest friction point + one experiment.",
  "next_focus": "one concrete action sentence for next week, max 20 words",
  "win_label": "max 8 words, what went best",
  "friction_label": "max 8 words, biggest drag"
}`;

/**
 * Returns a weekly report for `deviceId`, generating via GPT if no cached
 * report exists for the current ISO week.
 *
 * @param {string} deviceId
 * @param {object} ctx       — output of buildContext()
 * @param {object} harvest   — output of buildHarvest()
 * @param {object} findings  — output of buildFindings()
 * @param {object} scoreImpact — output of buildScoreImpact()
 * @param {object} score     — charts score payload (may be null)
 * @returns {object}  report payload, or { eligible: false, reason, days_remaining }
 */
async function getOrGenerateWeeklyReport(deviceId, ctx, harvest, findings, scoreImpact, score) {
  // ── Eligibility ──────────────────────────────────────────────────
  const maturityDays = score?.maturity?.days ?? ctx.days_with_any_log ?? 0;
  const setupCount   = harvest?.counts?.setup_count || 0;

  if (maturityDays < 7 || setupCount < 2) {
    const daysRemaining = Math.max(0, 7 - maturityDays);
    return {
      eligible:      false,
      reason:        maturityDays < 7
        ? `Need at least 7 days of data (${maturityDays} so far)`
        : 'Need at least 2 agents set up to generate a report',
      days_remaining: daysRemaining,
    };
  }

  // ── Cache check ──────────────────────────────────────────────────
  const reportId = isoWeekId();
  const snap = await reportDoc(deviceId, reportId).get();
  if (snap.exists) {
    return { ...snap.data().payload, _cached: true, report_id: reportId };
  }

  // ── Generate via GPT ─────────────────────────────────────────────
  const promptInput = buildPromptInput(ctx, harvest, findings, scoreImpact);

  let parsed;
  try {
    const resp = await openai.chat.completions.create({
      model:           'gpt-4o',
      temperature:     0.55,
      max_tokens:      600,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `${SYSTEM_SAFETY_PREFIX}\n\n${WEEKLY_SYSTEM}` },
        { role: 'user',   content: `Generate this week's report. User context (JSON):\n${JSON.stringify(promptInput)}` },
      ],
    });
    parsed = JSON.parse(resp.choices[0].message.content);
    await bumpReportCost(deviceId);
  } catch (e) {
    console.warn('[reports-engine][weekly]', e.message);
    return null;
  }

  // ── Enrich with score data ───────────────────────────────────────
  const trend7 = score?.trend7d || [];
  const scoreStart = trend7.length > 0 ? Math.round(trend7[0].score)               : null;
  const scoreEnd   = trend7.length > 0 ? Math.round(trend7[trend7.length - 1].score) : null;
  const scoreDelta = (scoreStart != null && scoreEnd != null) ? scoreEnd - scoreStart : null;
  const agentScores = {};
  (harvest?.contributors || []).filter(c => c.setup && c.score != null)
    .forEach(c => { agentScores[c.agent] = Math.round(c.score); });

  const enriched = { ...parsed, score_start: scoreStart, score_end: scoreEnd, score_delta: scoreDelta, agent_scores: agentScores };

  // ── Persist ──────────────────────────────────────────────────────
  const now = admin.firestore.FieldValue.serverTimestamp();
  await reportDoc(deviceId, reportId).set({
    report_id:    reportId,
    type:         'weekly',
    payload:      enriched,
    generated_at: now,
    period:       reportId.replace('weekly_', ''),
  });

  return { ...enriched, report_id: reportId };
}

// ─── Monthly report ──────────────────────────────────────────────────

const MONTHLY_SYSTEM = `You are Pulse. Generate a monthly deep-dive report.
JSON output:
{
  "headline": "bold summary sentence",
  "growth_narrative": "4 paragraphs max 400 words. Month story arc, what solidified, what needs attention, honest assessment of unset agents if any",
  "top_pattern": "one cross-agent pattern sentence if findings exist, else null",
  "next_month_focus": "one concrete focus for next month",
  "milestone": "one achievement worth celebrating, factual, max 15 words, or null"
}`;

/**
 * Returns a monthly report for `deviceId`, generating via GPT if no cached
 * report exists for the current YYYY-MM.
 *
 * @param {string} deviceId
 * @param {object} ctx
 * @param {object} harvest
 * @param {object} findings
 * @param {object} scoreImpact
 * @param {object} score
 * @param {Array}  trend30d   — 30-day score series from charts payload
 * @returns {object}  report payload, or { eligible: false, reason, days_remaining }
 */
async function getOrGenerateMonthlyReport(deviceId, ctx, harvest, findings, scoreImpact, score, trend30d) {
  // ── Eligibility ──────────────────────────────────────────────────
  const maturityDays = score?.maturity?.days ?? ctx.days_with_any_log ?? 0;
  const setupCount   = harvest?.counts?.setup_count || 0;

  if (maturityDays < 30 || setupCount < 2) {
    const daysRemaining = Math.max(0, 30 - maturityDays);
    return {
      eligible:      false,
      reason:        maturityDays < 30
        ? `Need at least 30 days of data (${maturityDays} so far)`
        : 'Need at least 2 agents set up to generate a report',
      days_remaining: daysRemaining,
    };
  }

  // ── Cache check ──────────────────────────────────────────────────
  const reportId = monthId();
  const snap = await reportDoc(deviceId, reportId).get();
  if (snap.exists) {
    return { ...snap.data().payload, _cached: true, report_id: reportId };
  }

  // ── Generate via GPT ─────────────────────────────────────────────
  const promptInput = {
    ...buildPromptInput(ctx, harvest, findings, scoreImpact),
    trend30d: (trend30d || []).slice(-30).map(p => ({ date: p.date, score: p.score })),
  };

  let parsed;
  try {
    const resp = await openai.chat.completions.create({
      model:           'gpt-4o',
      temperature:     0.55,
      max_tokens:      900,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `${SYSTEM_SAFETY_PREFIX}\n\n${MONTHLY_SYSTEM}` },
        { role: 'user',   content: `Generate this month's report. User context (JSON):\n${JSON.stringify(promptInput)}` },
      ],
    });
    parsed = JSON.parse(resp.choices[0].message.content);
    await bumpReportCost(deviceId);
  } catch (e) {
    console.warn('[reports-engine][monthly]', e.message);
    return null;
  }

  // ── Enrich with score data ───────────────────────────────────────
  const trend30 = score?.trend30d || [];
  const scoreStart = trend30.length > 0 ? Math.round(trend30[0].score)                : null;
  const scoreEnd   = trend30.length > 0 ? Math.round(trend30[trend30.length - 1].score) : null;
  const scoreDelta = (scoreStart != null && scoreEnd != null) ? scoreEnd - scoreStart : null;
  const agentScores = {};
  (harvest?.contributors || []).filter(c => c.setup && c.score != null)
    .forEach(c => { agentScores[c.agent] = Math.round(c.score); });

  const enriched = { ...parsed, score_start: scoreStart, score_end: scoreEnd, score_delta: scoreDelta, agent_scores: agentScores };

  // ── Persist ──────────────────────────────────────────────────────
  const now = admin.firestore.FieldValue.serverTimestamp();
  await reportDoc(deviceId, reportId).set({
    report_id:    reportId,
    type:         'monthly',
    payload:      enriched,
    generated_at: now,
    period:       reportId.replace('monthly_', ''),
  });

  return { ...enriched, report_id: reportId };
}

// ─── List reports ────────────────────────────────────────────────────

/**
 * Returns past reports for `deviceId`, newest first, max 12.
 *
 * @param {string} deviceId
 * @returns {Array<object>}
 */
async function listReports(deviceId) {
  const snap = await userDoc(deviceId)
    .collection('wellness_reports')
    .orderBy('generated_at', 'desc')
    .limit(12)
    .get()
    .catch(() => ({ docs: [] }));

  return snap.docs.map(d => {
    const data = d.data();
    return {
      report_id:    d.id,
      type:         data.type,
      period:       data.period,
      generated_at: data.generated_at,
      // Include the payload fields inline for convenience
      ...(data.payload || {}),
    };
  });
}

module.exports = {
  getOrGenerateWeeklyReport,
  getOrGenerateMonthlyReport,
  listReports,
};
