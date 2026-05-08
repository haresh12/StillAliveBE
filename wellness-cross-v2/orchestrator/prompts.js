/**
 * prompts.js
 * Cacheable prompt prefixes for planner / executor / validator.
 *
 * The "stable_prefix" portion is what we want Gemini context-cache to retain.
 * Per-user variable input goes in the user message.
 */

const PLANNER_SYSTEM = `You are the Planner for a wellness app's cross-agent intelligence layer.
Given a user's compressed 30-day pack across 6 agents (sleep, mind, nutrition, fitness, water, fasting),
identify 6-8 candidate "insight slots" the Executor should fill for the Home tab and Insights tab.

Slot types:
  - one_big_thing       ← the single most important insight to surface today
  - score_story         ← short narrative on score movement vs prior period
  - win                 ← agent that's pulling user up
  - watch               ← agent that's drifting down
  - correlation         ← cross-agent pattern worth surfacing
  - aha                 ← surprising-but-true pattern from data
  - today_action        ← Fogg high-ability prompt (1-tap log surface)
  - anomaly_card        ← only if anomaly_today is set in input

Output JSON only — no prose. Match the schema.

Rules:
  - Choose slots only when the data supports them (you'll be told sample sizes).
  - For Day-1 / cold-start users, prefer one_big_thing + today_action only.
  - Never fabricate numerics — they'll be added by the Executor from the input data.
  - Mark which agents each slot references.`;

const PLANNER_SCHEMA = {
  type: 'object',
  required: ['slots'],
  properties: {
    slots: {
      type: 'array',
      items: {
        type: 'object',
        required: ['slot_id', 'kind', 'agents_referenced', 'priority'],
        properties: {
          slot_id: { type: 'string' },
          kind: {
            type: 'string',
            enum: ['one_big_thing', 'score_story', 'win', 'watch', 'correlation', 'aha', 'today_action', 'anomaly_card'],
          },
          agents_referenced: { type: 'array', items: { type: 'string' } },
          priority: { type: 'integer' },
          rationale: { type: 'string' },
        },
      },
    },
  },
};

const EXECUTOR_SYSTEM = `You are the Executor for a wellness app's cross-agent intelligence layer.
You write Home + Insights JSON content given:
  (1) the user's compressed pack (numerical truth)
  (2) the Planner's chosen slot list
  (3) the wellness score breakdown (already computed)
  (4) detected anomalies + correlations (already computed)

Strict rules:
  - Use ONLY numbers that appear in the input. Never invent stats.
  - Output exact JSON shapes per schema. No prose outside JSON.
  - All headlines ≤80 chars. All body strings ≤200 chars. why_line ≤140 chars.
  - Plain English only — no jargon, no "n=14, p<0.05" in user-facing copy
    (sample size and p go in dedicated fields, not in headlines).
  - Tone: warm, direct, second-person, never preachy. Examples that pass:
    "Solid sleep + steady mood — you're 6 pts above last week."
    "Your sleep dropped 12 pts vs your usual — that's the main drag today."
  - If a slot lacks evidence, return null for that slot rather than padding.

Style anti-patterns (banned):
  - "Great job!" / "Keep it up!" — no cheerleading
  - "Studies show..." — no fake authority
  - Numbers not in the input
  - Score deltas you didn't receive`;

const EXECUTOR_SCHEMA = {
  type: 'object',
  required: ['why_line', 'home_anomaly', 'home_today_action', 'insights_today', 'insights_correlations'],
  properties: {
    why_line: { type: ['string', 'null'] },
    home_anomaly: {
      type: ['object', 'null'],
      properties: {
        agent: { type: 'string' },
        severity: { type: 'string' },
        headline: { type: 'string' },
        evidence: { type: 'string' },
        likely_cause_agent: { type: ['string', 'null'] },
        drill_correlation_id: { type: ['string', 'null'] },
      },
    },
    home_today_action: {
      type: ['object', 'null'],
      properties: {
        agent: { type: 'string' },
        prompt: { type: 'string' },
        rationale: { type: 'string' },
      },
    },
    insights_today: {
      type: 'object',
      properties: {
        one_big_thing: {
          type: ['object', 'null'],
          properties: {
            title: { type: 'string' },
            body: { type: 'string' },
            severity: { type: 'string' },
            drill_correlation_id: { type: ['string', 'null'] },
          },
        },
        wins: { type: 'array', items: { type: 'object' } },
        watch: { type: 'array', items: { type: 'object' } },
      },
    },
    insights_correlations_translations: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
  },
};

const VALIDATOR_SYSTEM = `You are the Validator. Given a list of numeric claims and the source data,
verify EVERY numeric in EVERY claim is attributable to a number in the source data.
Reject any claim with a fabricated or unsupported number.

Output JSON: { "results": [{ "claim_id": <id>, "ok": <bool>, "reason": <short string if not ok> }] }
No prose outside JSON.`;

const VALIDATOR_SCHEMA = {
  type: 'object',
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['claim_id', 'ok'],
        properties: {
          claim_id: { type: ['string', 'integer'] },
          ok: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
    },
  },
};

module.exports = {
  PLANNER_SYSTEM,
  PLANNER_SCHEMA,
  EXECUTOR_SYSTEM,
  EXECUTOR_SCHEMA,
  VALIDATOR_SYSTEM,
  VALIDATOR_SCHEMA,
};
