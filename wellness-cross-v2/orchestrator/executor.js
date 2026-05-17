/**
 * executor.js
 * Step 3: Gemini 2.5 Pro fills the planner's slots into structured JSON
 * (why_line, anomaly card, today_action, insights one_big_thing, etc.).
 */

const { callLLM } = require('../llm/llm-provider');
const { EXECUTOR_SYSTEM, EXECUTOR_SCHEMA } = require('./prompts');

function buildExecutorInput({ pack, wellness, anomalies, top_correlations, plan_slots, healthkit }) {
  return JSON.stringify({
    profile: pack.profile,
    summary: pack.summary,
    today: pack.today,
    last_7d_floating: pack.last_7d_floating,
    baselines: pack.baselines,
    aha_moments: Object.fromEntries(
      Object.entries(pack.agents).map(([a, ad]) => [a, ad.aha_moments || []]),
    ),
    aggregates_90d: Object.fromEntries(
      Object.entries(pack.agents).map(([a, ad]) => [a, ad.aggregates_90d]),
    ),
    wellness: {
      score: wellness.score,
      delta_vs_yesterday: wellness.delta_vs_yesterday,
      delta_vs_7d_avg: wellness.delta_vs_7d_avg,
      is_warm_start: wellness.is_warm_start,
      score_status: wellness.score_status,
      trend_direction: wellness.trend_direction,
      volatility_14d: wellness.volatility_14d,
      baseline_30d: wellness.baseline_30d,
      components: wellness.components,
    },
    anomalies: (anomalies || []).slice(0, 3).map((a) => ({
      agent: a.agent,
      severity: a.severity,
      direction: a.direction,
      headline: a.headline,
      evidence: a.evidence,
      today_score: a.today_score,
      baseline_mean: a.baseline_mean,
    })),
    correlations: (top_correlations || []).map((c) => ({
      id: c.id, pair: c.pair, agents: c.agents, r: c.r, n: c.n, lag: c.lag,
      direction: c.direction, plain_english: c.plain_english, evidence: c.evidence,
    })),
    // Apple Health auto-imported signals per coach. Only keys with data
    // appear, so the executor never invents numbers. Omitted entirely when
    // the user hasn't granted HK.
    healthkit: healthkit && Object.keys(healthkit).length ? healthkit : undefined,
    plan_slots,
  });
}

async function loadHealthKitRollup(deviceId) {
  if (!deviceId) return {};
  try {
    const admin = require('firebase-admin');
    const { buildHKContext } = require('../../lib/healthkit/context-builder');
    const coaches = ['sleep', 'mind', 'fitness', 'nutrition', 'water', 'fasting'];
    const blocks = await Promise.all(
      coaches.map((c) =>
        buildHKContext({ db: admin.firestore(), deviceId, coach: c, days: 7 }).catch(() => ''),
      ),
    );
    const out = {};
    coaches.forEach((c, i) => {
      const b = blocks[i] && blocks[i].trim();
      if (b) out[c] = b.replace(/^\[HK\]\s*/, '');
    });
    return out;
  } catch {
    return {};
  }
}

async function execute({ pack, wellness, anomalies, top_correlations, plan_slots, language, deviceId }) {
  // Cold-start path — deterministic content (no LLM, faster, free).
  if (pack.summary.tier <= 1 || wellness.is_warm_start) {
    return {
      content: deterministicColdStartOutput(pack, wellness),
      source: 'deterministic_cold_start',
    };
  }

  // Best-effort HealthKit rollup — empty object when HK isn't granted.
  const resolvedDeviceId = deviceId || (pack && pack.profile && pack.profile.deviceId);
  const healthkit = await loadHealthKitRollup(resolvedDeviceId);

  const userPrompt = buildExecutorInput({ pack, wellness, anomalies, top_correlations, plan_slots, healthkit });
  try {
    const { content, usage } = await callLLM({
      role: 'executor',
      systemPrompt: EXECUTOR_SYSTEM,
      userPrompt,
      responseSchema: EXECUTOR_SCHEMA,
      language,
    });
    return { content, source: 'llm', usage };
  } catch (err) {
    log.error('[executor] LLM failed, deterministic fallback:', err && err.message);
    return { content: deterministicFallback(pack, wellness, anomalies, top_correlations), source: 'fallback' };
  }
}

function deterministicColdStartOutput(pack, wellness) {
  const setupAgents = Object.keys(pack.profile.setup_state).filter((a) => pack.profile.setup_state[a]);
  const firstAgent = setupAgents[0];
  const setupCount = (pack.profile && pack.profile.setup_count) || 0;
  return {
    why_line: setupCount > 0
      ? `${setupCount} of 6 agents active. Log today to lock in your score.`
      : null,
    home_anomaly: null,
    home_today_action: firstAgent
      ? {
          agent: firstAgent,
          prompt: `Log your ${firstAgent} now`,
          rationale: 'One log unlocks your real wellness signal.',
        }
      : null,
    insights_today: {
      one_big_thing: {
        title: 'Your patterns will show here',
        body: 'Each log sharpens your wellness signal and unlocks new patterns across your agents.',
        severity: 'low',
        drill_correlation_id: null,
      },
      wins: [],
      watch: [],
    },
    insights_correlations_translations: {},
  };
}

function deterministicFallback(pack, wellness, anomalies, top_correlations) {
  const top = wellness.components.filter((c) => c.is_top_contributor);
  const lead = top[0];
  let why = null;
  if (lead) {
    const dir = lead.delta_vs_baseline >= 0 ? 'above' : 'below';
    const dy = wellness.delta_vs_yesterday;
    const dyTxt = dy === 0 ? 'flat today' : (dy > 0 ? `up ${dy} today` : `down ${Math.abs(dy)} today`);
    why = `${dyTxt} — your ${lead.agent} is ${Math.abs(Math.round(lead.delta_vs_baseline))}pts ${dir} your usual.`;
  }
  return {
    why_line: why,
    home_anomaly: anomalies && anomalies.length
      ? {
          agent: anomalies[0].agent,
          severity: anomalies[0].severity,
          headline: anomalies[0].headline,
          evidence: anomalies[0].evidence,
          likely_cause_agent: null,
          drill_correlation_id: null,
        }
      : null,
    home_today_action: null,
    insights_today: {
      one_big_thing: lead
        ? {
            title: `Your ${lead.agent} is the biggest mover today`,
            body: `Score ${lead.score}, ${Math.abs(Math.round(lead.delta_vs_baseline))}pts ${lead.delta_vs_baseline >= 0 ? 'above' : 'below'} your usual.`,
            severity: 'low',
            drill_correlation_id: null,
          }
        : null,
      wins: top
        .filter((c) => c.delta_vs_baseline > 0)
        .slice(0, 2)
        .map((c) => ({
          agent: c.agent,
          headline: `${c.agent} pulling you up`,
          evidence: `+${Math.round(c.delta_vs_baseline)}pts vs baseline`,
        })),
      watch: top
        .filter((c) => c.delta_vs_baseline < 0)
        .slice(0, 2)
        .map((c) => ({
          agent: c.agent,
          headline: `${c.agent} drifting`,
          evidence: `${Math.round(c.delta_vs_baseline)}pts vs baseline`,
        })),
    },
    insights_correlations_translations: Object.fromEntries(
      (top_correlations || []).map((c) => [c.id, c.plain_english || `${c.pair} link (n=${c.n}, r=${c.r})`]),
    ),
  };
}

module.exports = { execute };
