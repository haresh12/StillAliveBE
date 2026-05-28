/**
 * goal-plans/dayBatcher.js — parallel batch streaming contract tests.
 *
 * Locks in the 2026-05-27 v2 anti-tiling law (L2):
 *   • 7-day plan = 1 batch, 7 distinct days
 *   • 30-day plan = 5 batches (7+7+7+7+2), 30 distinct days
 *   • 60-day plan = 12 batches of 5, 60 distinct days (was 90 → trimmed 2026-05-28)
 *   • Batches yield in strict day-index order (snake/path paints cleanly)
 *   • ANY batch fail after retries → throw (no partial plans persisted)
 *
 * Run: node tests/goal-plans-batcher.test.js
 */

'use strict';

const assert = require('assert');
const { generateAllDays, generateDayStream, BATCH_SIZE, __addDaysKey } = require('../lib/goal-plans/dayBatcher');
const { __setTestOverrides } = require('../lib/goal-plans/ai');

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { console.log(`  ✓ ${name}`); passed++; })
    .catch(e  => { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; });
}
function section(t) { console.log(`\n${t}`); }

// ─── Build a fake OpenAI response producing a batch of N days ──────────
function fakeBatchResponse(startIdx, count) {
  const days = [];
  for (let i = 0; i < count; i++) {
    days.push({
      day_index: startIdx + i,
      summary:   `Day ${startIdx + i} label`,
      rest_day:  false,
      items: [
        {
          title: `Item A on day ${startIdx + i}`,
          when_label: 'Morning',
          impact: 'Burns ~400 kcal and primes metabolism for the day.',
          coach: 'fitness',   kind: 'do', time_section: 'morning',
        },
        {
          title: `Item B on day ${startIdx + i}`,
          when_label: 'Lunch',
          impact: 'Hits 30g protein; blunts hunger via PYY/GLP-1.',
          coach: 'nutrition', kind: 'hit', time_section: 'evening',
        },
        {
          title: `Item C on day ${startIdx + i}`,
          when_label: 'Bedtime',
          impact: 'Sets melatonin window; cuts sleep latency ~20 min.',
          coach: 'sleep',     kind: 'time', time_section: 'night',
        },
      ],
    });
  }
  return { days };
}

function openAIClient(batchResponses /* array, one per batch */) {
  let i = 0;
  return {
    chat: { completions: { create: async () => {
      const r = batchResponses[i++];
      if (r instanceof Error) throw r;
      return { choices: [{ message: { content: JSON.stringify(r) } }] };
    } } },
  };
}

const baseOpts = {
  duration_days:    7,
  start_date:       '2026-05-27',
  goal_text:        'lose 5kg',
  coaches_involved: ['fitness', 'nutrition'],
  answers:          [{ id: 'q1', value: '3-4' }],
  locale:           'en',
};

// ────────────────────────────────────────────────────────────────
(async () => {

section('__addDaysKey (date math)');

await test('adds 0 days', () => {
  assert.strictEqual(__addDaysKey('2026-05-27', 0), '2026-05-27');
});
await test('adds 6 days, crosses month boundary', () => {
  assert.strictEqual(__addDaysKey('2026-05-27', 6), '2026-06-02');
});
await test('adds 29 days', () => {
  assert.strictEqual(__addDaysKey('2026-05-27', 29), '2026-06-25');
});

section('generateAllDays — happy paths');

// BATCH_SIZE = 5. 7-day plan → batch 0: days 1-5, batch 1: days 6-7.
await test('7-day plan: 2 batches (5+2), 7 distinct days', async () => {
  __setTestOverrides({
    openai: openAIClient([
      fakeBatchResponse(1, 5),
      fakeBatchResponse(6, 2),
    ]),
  });
  const days = await generateAllDays({ ...baseOpts, duration_days: 7 });
  assert.strictEqual(days.length, 7);
  assert.deepStrictEqual(days.map(d => d.day_index), [1, 2, 3, 4, 5, 6, 7]);
  const titles = new Set(days.flatMap(d => d.items.map(it => it.title)));
  assert.ok(titles.size >= 7, 'item titles must vary across days');
});

await test('30-day plan: 6 batches of 5, 30 distinct days', async () => {
  __setTestOverrides({
    openai: openAIClient([
      fakeBatchResponse(1, 5),
      fakeBatchResponse(6, 5),
      fakeBatchResponse(11, 5),
      fakeBatchResponse(16, 5),
      fakeBatchResponse(21, 5),
      fakeBatchResponse(26, 5),
    ]),
  });
  const days = await generateAllDays({ ...baseOpts, duration_days: 30 });
  assert.strictEqual(days.length, 30);
  assert.strictEqual(days[0].day_index, 1);
  assert.strictEqual(days[29].day_index, 30);
});

// 2026-05-28: max premium duration trimmed 90 → 60 (cost control). Test now
// covers the 60-day path = 12 batches of 5.
await test('60-day plan: 12 batches of 5, 60 distinct days', async () => {
  const responses = [];
  for (let i = 0; i < 12; i++) responses.push(fakeBatchResponse(i * 5 + 1, 5));
  __setTestOverrides({ openai: openAIClient(responses) });
  const days = await generateAllDays({ ...baseOpts, duration_days: 60 });
  assert.strictEqual(days.length, 60);
  assert.strictEqual(days[0].day_index, 1);
  assert.strictEqual(days[59].day_index, 60);
});

await test('date_key is correctly offset from start_date', async () => {
  __setTestOverrides({
    openai: openAIClient([
      fakeBatchResponse(1, 5),
      fakeBatchResponse(6, 2),
    ]),
  });
  const days = await generateAllDays({ ...baseOpts, duration_days: 7, start_date: '2026-05-27' });
  assert.strictEqual(days[0].date_key, '2026-05-27');
  assert.strictEqual(days[6].date_key, '2026-06-02');
});

section('generateDayStream — strict order');

await test('yields batches in day_index order', async () => {
  __setTestOverrides({
    openai: openAIClient([
      fakeBatchResponse(1, 5),
      fakeBatchResponse(6, 5),
      fakeBatchResponse(11, 5),
      fakeBatchResponse(16, 5),
      fakeBatchResponse(21, 5),
      fakeBatchResponse(26, 5),
    ]),
  });
  const yielded = [];
  for await (const frame of generateDayStream({ ...baseOpts, duration_days: 30 })) {
    yielded.push(frame);
  }
  assert.strictEqual(yielded.length, 7); // 6 batches + done
  assert.strictEqual(yielded[0].type, 'batch');
  assert.deepStrictEqual(yielded.slice(0, 6).map(f => f.batch_index), [0, 1, 2, 3, 4, 5]);
  assert.strictEqual(yielded[6].type, 'done');
});

section('honest errors — L9');

await test('L1 returns wrong day count → throws (no partial plan)', async () => {
  // BATCH_SIZE=5. 7-day plan = batch 0 (5 days) + batch 1 (2 days).
  // First batch returns 3 instead of 5 → outer-loop retry (also 3) → throws.
  __setTestOverrides({
    openai: openAIClient([
      fakeBatchResponse(1, 3), // requested 5, got 3
      fakeBatchResponse(1, 3), // retry, still wrong
    ]),
    gemini: async () => { throw new Error('gemini also unavailable for test'); },
  });
  let threw = null;
  try { await generateAllDays({ ...baseOpts, duration_days: 7 }); }
  catch (e) { threw = e; }
  assert.ok(threw, 'must throw on wrong day count');
});

await test('rejects invalid duration_days', async () => {
  // 2026-05-28: duration is now free-form in [3, 90]. 45 is valid; we test
  // the actual boundary failures (too low, too high, non-integer).
  for (const bad of [0, 1, 2, 91, 100, 'abc', null, undefined, 5.5]) {
    let threw = null;
    try { await generateAllDays({ ...baseOpts, duration_days: bad }); }
    catch (e) { threw = e; }
    assert.ok(
      threw && /invalid duration_days/.test(threw.message),
      `expected throw for duration_days=${JSON.stringify(bad)}`
    );
  }
});

await test('accepts free-form duration in [3, 90]', async () => {
  // Pick a non-bucket value (10 days = 2 batches of 5) to prove arbitrary
  // counts work end-to-end, not just the legacy [7, 14, 30, 60] presets.
  __setTestOverrides({
    openai: openAIClient([fakeBatchResponse(1, 5), fakeBatchResponse(6, 5)]),
  });
  const days = await generateAllDays({ ...baseOpts, duration_days: 10 });
  assert.strictEqual(days.length, 10);
  assert.strictEqual(days[0].day_index, 1);
  assert.strictEqual(days[9].day_index, 10);
});

await test('rejects bad start_date', async () => {
  let threw = null;
  try { await generateAllDays({ ...baseOpts, start_date: 'invalid' }); }
  catch (e) { threw = e; }
  assert.ok(threw && /start_date/.test(threw.message));
});

await test('LLM transient fail (batch 1) → retries on L1 then succeeds', async () => {
  __setTestOverrides({
    openai: openAIClient([
      new Error('transient L1 fail'),       // batch 0, attempt 1
      fakeBatchResponse(1, 5),              // batch 0, attempt 2 (retry succeeds)
      fakeBatchResponse(6, 5),              // batch 1
      fakeBatchResponse(11, 5),             // batch 2
      fakeBatchResponse(16, 5),             // batch 3
      fakeBatchResponse(21, 5),             // batch 4
      fakeBatchResponse(26, 5),             // batch 5
    ]),
  });
  const days = await generateAllDays({ ...baseOpts, duration_days: 30 });
  assert.strictEqual(days.length, 30);
});

// ────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);

})();
