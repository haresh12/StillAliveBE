/**
 * planner.js
 * Step 2: pick 6-8 candidate insight slots given the compressed pack.
 */

const { callLLM } = require('../llm/llm-provider');
const { PLANNER_SYSTEM, PLANNER_SCHEMA } = require('./prompts');

function buildPlannerInput({ pack, wellness, anomalies, top_correlations }) {
  return JSON.stringify({
    profile: pack.profile,
    summary: pack.summary,
    setup_state: pack.profile.setup_state,
    today: pack.today,
    last_7d_floating: pack.last_7d_floating,
    wellness_summary: {
      score: wellness.score,
      delta_vs_yesterday: wellness.delta_vs_yesterday,
      delta_vs_7d_avg: wellness.delta_vs_7d_avg,
      is_warm_start: wellness.is_warm_start,
      top_contributors: wellness.components.filter((c) => c.is_top_contributor).map((c) => ({
        agent: c.agent, score: c.score, delta: c.delta_vs_baseline, weight: c.weight,
      })),
    },
    anomaly_today: anomalies && anomalies.length ? {
      agent: anomalies[0].agent,
      severity: anomalies[0].severity,
      direction: anomalies[0].direction,
    } : null,
    available_correlations: (top_correlations || []).map((c) => ({
      id: c.id, pair: c.pair, r: c.r, n: c.n, lag: c.lag, plain_english: c.plain_english,
    })),
  });
}

async function plan({ pack, wellness, anomalies, top_correlations, language }) {
  // Skip the LLM call entirely on cold-start users — deterministic plan is better.
  if (pack.summary.tier <= 1 || wellness.is_warm_start) {
    return { slots: defaultColdStartSlots(pack), source: 'deterministic_cold_start' };
  }

  const userPrompt = buildPlannerInput({ pack, wellness, anomalies, top_correlations });
  try {
    const { content, usage } = await callLLM({
      role: 'planner',
      systemPrompt: PLANNER_SYSTEM,
      userPrompt,
      responseSchema: PLANNER_SCHEMA,
      language,
    });
    return { slots: content.slots || [], source: 'llm', usage };
  } catch (err) {
    log.error('[planner] LLM failed, falling back:', err && err.message);
    return { slots: defaultPowerSlots(pack, wellness, anomalies, top_correlations), source: 'fallback' };
  }
}

function defaultColdStartSlots(pack) {
  return [
    {
      slot_id: 'cold_obt',
      kind: 'one_big_thing',
      agents_referenced: [],
      priority: 1,
      rationale: 'cold-start onboarding',
    },
    {
      slot_id: 'cold_action',
      kind: 'today_action',
      agents_referenced: Object.keys(pack.profile.setup_state).filter((a) => pack.profile.setup_state[a]).slice(0, 1),
      priority: 2,
      rationale: 'one-tap engage',
    },
  ];
}

function defaultPowerSlots(pack, wellness, anomalies, correlations) {
  const slots = [];
  if (anomalies && anomalies.length) {
    slots.push({ slot_id: 'anomaly', kind: 'anomaly_card', agents_referenced: [anomalies[0].agent], priority: 1 });
  }
  slots.push({ slot_id: 'obt', kind: 'one_big_thing', agents_referenced: [], priority: 2 });
  slots.push({ slot_id: 'score_story', kind: 'score_story', agents_referenced: [], priority: 3 });
  if (correlations && correlations.length) {
    slots.push({ slot_id: 'corr_top', kind: 'correlation', agents_referenced: correlations[0].agents, priority: 4 });
  }
  slots.push({ slot_id: 'today_action', kind: 'today_action', agents_referenced: [], priority: 5 });
  return slots;
}

module.exports = { plan };
