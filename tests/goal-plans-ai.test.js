/**
 * goal-plans/ai.js — runWithFallback + repairJson contract tests.
 *
 * Locks in the 2026-05-27 v2 honesty laws:
 *   • L1 fail OR validation fail → retry once within layer
 *   • L1 retries exhausted → L2 (Gemini) takes over with same retry policy
 *   • L1 + L2 both exhausted → throws LLMUnavailableError (NEVER fake data)
 *   • JSON repair handles ```json fences and prose-around-JSON
 *
 * Run: node tests/goal-plans-ai.test.js
 */

'use strict';

const assert = require('assert');
const {
  runWithFallback,
  LLMUnavailableError,
  __setTestOverrides,
  __repairJson,
} = require('../lib/goal-plans/ai');

const SCHEMA = {
  type: 'object',
  required: ['title', 'count'],
  properties: {
    title: { type: 'string', minLength: 3, maxLength: 60 },
    count: { type: 'integer', minimum: 1, maximum: 99 },
  },
};

// ────────────────────────────────────────────────────────────────
// Helpers for fake OpenAI + Gemini clients

function fakeOpenAIClient(responses /* array of string returns OR Error throws */) {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async () => {
          const r = responses[i++];
          if (r instanceof Error) throw r;
          return { choices: [{ message: { content: typeof r === 'string' ? r : JSON.stringify(r) } }] };
        },
      },
    },
  };
}

function fakeGeminiFn(responses) {
  let i = 0;
  return async () => {
    const r = responses[i++];
    if (r instanceof Error) throw r;
    // gemini client returns { content, usage } — emulate
    return { content: r, usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 } };
  };
}

// ────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => { console.log(`  ✓ ${name}`); passed++; })
    .catch((e) => { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; });
}
function section(title) { console.log(`\n${title}`); }

const baseOpts = {
  stepName: 'testStep',
  schema: SCHEMA,
  systemPrompt: 'sys',
  userPrompt: 'usr',
  openai: { model: 'fake-openai', max_completion_tokens: 100 },
  gemini: { model: 'fake-gemini', maxCompletionTokens: 100 },
};

// ────────────────────────────────────────────────────────────────
(async function run() {
  section('repairJson (3 cases)');

  await test('strips ```json fences', () => {
    const raw = '```json\n{"a":1}\n```';
    assert.strictEqual(__repairJson(raw), '{"a":1}');
  });

  await test('strips prose before JSON', () => {
    const raw = 'Sure! Here is the JSON:\n{"a":1}';
    assert.strictEqual(__repairJson(raw), '{"a":1}');
  });

  await test('strips prose after JSON', () => {
    const raw = '{"a":1}\nLet me know if you need anything else.';
    assert.strictEqual(__repairJson(raw), '{"a":1}');
  });

  // ──────────────────────────────────────────────────────────────
  section('runWithFallback — happy paths (3 cases)');

  await test('L1 returns valid JSON → resolves', async () => {
    __setTestOverrides({ openai: fakeOpenAIClient([{ title: 'hello', count: 5 }]) });
    const out = await runWithFallback(baseOpts);
    assert.deepStrictEqual(out, { title: 'hello', count: 5 });
  });

  await test('L1 fenced JSON → repaired and resolved', async () => {
    __setTestOverrides({
      openai: fakeOpenAIClient(['```json\n{"title":"foo","count":2}\n```']),
    });
    const out = await runWithFallback(baseOpts);
    assert.strictEqual(out.title, 'foo');
    assert.strictEqual(out.count, 2);
  });

  await test('L1 strips additional unknown keys silently', async () => {
    __setTestOverrides({
      openai: fakeOpenAIClient([{ title: 'foo', count: 2, extra: 'ignored' }]),
    });
    const out = await runWithFallback(baseOpts);
    assert.strictEqual(out.title, 'foo');
    assert.strictEqual(out.extra, undefined);
  });

  // ──────────────────────────────────────────────────────────────
  section('runWithFallback — in-layer retry (3 cases)');

  await test('L1 first call throws → retries → succeeds', async () => {
    __setTestOverrides({
      openai: fakeOpenAIClient([new Error('rate limit'), { title: 'okk', count: 1 }]),
    });
    const out = await runWithFallback(baseOpts);
    assert.strictEqual(out.title, 'okk');
  });

  await test('L1 first call returns invalid schema → retries → succeeds', async () => {
    __setTestOverrides({
      openai: fakeOpenAIClient([
        { title: 'a', count: 999 }, // count out of range
        { title: 'okk', count: 5 },
      ]),
    });
    const out = await runWithFallback(baseOpts);
    assert.strictEqual(out.count, 5);
  });

  await test('L1 returns malformed string twice → escalates to L2', async () => {
    __setTestOverrides({
      openai: fakeOpenAIClient(['not even json', 'still not json']),
      gemini: fakeGeminiFn([{ title: 'gem', count: 3 }]),
    });
    const out = await runWithFallback(baseOpts);
    assert.strictEqual(out.title, 'gem');
  });

  // ──────────────────────────────────────────────────────────────
  section('runWithFallback — Layer-2 fallback (2 cases)');

  await test('L1 both attempts fail → L2 first attempt succeeds', async () => {
    __setTestOverrides({
      openai: fakeOpenAIClient([new Error('openai 500'), new Error('openai 500')]),
      gemini: fakeGeminiFn([{ title: 'gemini', count: 7 }]),
    });
    const out = await runWithFallback(baseOpts);
    assert.strictEqual(out.title, 'gemini');
  });

  await test('L1 fails, L2 first attempt schema-invalid, L2 retry succeeds', async () => {
    __setTestOverrides({
      openai: fakeOpenAIClient([new Error('openai 500'), new Error('openai 500')]),
      gemini: fakeGeminiFn([
        { title: '', count: 1 }, // title too short
        { title: 'gemini', count: 1 },
      ]),
    });
    const out = await runWithFallback(baseOpts);
    assert.strictEqual(out.title, 'gemini');
  });

  // ──────────────────────────────────────────────────────────────
  section('runWithFallback — honest 503 (2 cases)');

  await test('L1 + L2 both exhaust retries → throws LLMUnavailableError', async () => {
    __setTestOverrides({
      openai: fakeOpenAIClient([new Error('e1'), new Error('e2')]),
      gemini: fakeGeminiFn([new Error('g1'), new Error('g2')]),
    });
    let threw = null;
    try { await runWithFallback(baseOpts); }
    catch (e) { threw = e; }
    assert.ok(threw instanceof LLMUnavailableError, 'expected LLMUnavailableError');
    assert.strictEqual(threw.stepName, 'testStep');
  });

  await test('Never returns a partial / fallback plan when both layers fail', async () => {
    __setTestOverrides({
      openai: fakeOpenAIClient([new Error('a'), new Error('b')]),
      gemini: fakeGeminiFn([new Error('c'), new Error('d')]),
    });
    let out = null, err = null;
    try { out = await runWithFallback(baseOpts); }
    catch (e) { err = e; }
    assert.strictEqual(out, null, 'must NOT return a fallback');
    assert.ok(err, 'must throw');
  });

  // ──────────────────────────────────────────────────────────────
  section('telemetry');

  await test('telemetry.track fires for L1_OK on happy path', async () => {
    const events = [];
    __setTestOverrides({ openai: fakeOpenAIClient([{ title: 'xyz', count: 1 }]) });
    await runWithFallback({
      ...baseOpts,
      telemetry: { track: (ev, props) => events.push({ ev, props }) },
    });
    assert.ok(events.some(e => e.ev === 'GOAL_PLAN_LLM_L1_START'));
    assert.ok(events.some(e => e.ev === 'GOAL_PLAN_LLM_L1_OK'));
  });

  await test('telemetry.track fires BOTH_FAIL when 503', async () => {
    const events = [];
    __setTestOverrides({
      openai: fakeOpenAIClient([new Error('e1'), new Error('e2')]),
      gemini: fakeGeminiFn([new Error('g1'), new Error('g2')]),
    });
    try {
      await runWithFallback({
        ...baseOpts,
        telemetry: { track: (ev, props) => events.push({ ev, props }) },
      });
    } catch {}
    assert.ok(events.some(e => e.ev === 'GOAL_PLAN_LLM_BOTH_FAIL'));
  });

  // ──────────────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
})();
