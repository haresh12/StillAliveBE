/**
 * goal-plans/prompts.js — prompt builder contract tests.
 *
 * Locks in the 2026-05-27 v2 cross-domain law (L4):
 *   • A "lose 5kg" goal MUST surface nutrition questions (not just fitness).
 *   • Every coach in coachesInvolved appears in the questions instruction set.
 *   • All builders are locale-aware and reject too-short inputs.
 *
 * Run: node tests/goal-plans-prompts.test.js
 */

'use strict';

const assert = require('assert');
const {
  buildRouteGoalPrompt,
  buildComposeQuestionsPrompt,
  buildProposeNamePrompt,
  buildComposePlanBatchPrompt,
} = require('../lib/goal-plans/prompts');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function section(title) { console.log(`\n${title}`); }

// ─── routeGoal ──────────────────────────────────────────────────────────
section('buildRouteGoalPrompt');

test('returns { systemPrompt, userPrompt } strings', () => {
  const p = buildRouteGoalPrompt({ goalText: 'lose 5kg by July', locale: 'en' });
  assert.strictEqual(typeof p.systemPrompt, 'string');
  assert.strictEqual(typeof p.userPrompt, 'string');
  assert.ok(p.systemPrompt.length > 100);
});

test('includes the 6 coach scopes in the system prompt', () => {
  const p = buildRouteGoalPrompt({ goalText: 'lose 5kg', locale: 'en' });
  for (const c of ['fitness', 'nutrition', 'mind', 'sleep', 'water', 'fasting']) {
    assert.ok(p.systemPrompt.includes(c), `missing coach "${c}"`);
  }
});

test('includes the 24-goal taxonomy reference', () => {
  const p = buildRouteGoalPrompt({ goalText: 'lose 5kg', locale: 'en' });
  assert.ok(p.systemPrompt.includes('lose_weight_moderate'));
  assert.ok(p.systemPrompt.includes('caffeine_taper'));
});

test('throws on too-short goalText', () => {
  assert.throws(() => buildRouteGoalPrompt({ goalText: 'a', locale: 'en' }), /too short/);
});

test('falls back to "en" locale on unknown', () => {
  const p = buildRouteGoalPrompt({ goalText: 'lose weight', locale: 'xx' });
  assert.ok(p.systemPrompt.includes('Locale: en'));
});

test('respects supported locale (de)', () => {
  const p = buildRouteGoalPrompt({ goalText: 'mehr Wasser trinken', locale: 'de' });
  assert.ok(p.systemPrompt.includes('Locale: de'));
});

test('truncates very long goalText', () => {
  const long = 'x'.repeat(2000);
  const p = buildRouteGoalPrompt({ goalText: long, locale: 'en' });
  assert.ok(p.userPrompt.length < 700, 'userPrompt should clamp the long goal');
});

// ─── composeQuestions ───────────────────────────────────────────────────
section('buildComposeQuestionsPrompt');

test('returns prompts with cross-domain instruction (L4)', () => {
  const p = buildComposeQuestionsPrompt({
    goalText: 'lose 5kg by July',
    coachesInvolved: ['fitness', 'nutrition'],
    locale: 'en',
    durationDays: 30,
  });
  assert.ok(p.systemPrompt.includes('Cross-domain coverage matters'));
  assert.ok(p.systemPrompt.includes('Coaches involved: fitness, nutrition'));
});

test('coach-aware: lists ONLY the involved coaches in scope block', () => {
  const p = buildComposeQuestionsPrompt({
    goalText: 'sleep better',
    coachesInvolved: ['sleep', 'mind'],
    locale: 'en',
    durationDays: 7,
  });
  assert.ok(p.systemPrompt.includes('  - sleep:'));
  assert.ok(p.systemPrompt.includes('  - mind:'));
  // Other coaches NOT in the scope block
  const fitnessBlockHit = /  - fitness:/.test(p.systemPrompt);
  assert.ok(!fitnessBlockHit, 'fitness should not appear in scope block for sleep+mind goal');
});

test('clamps coachesInvolved to 3 coaches max', () => {
  const p = buildComposeQuestionsPrompt({
    goalText: 'be healthy',
    coachesInvolved: ['fitness', 'nutrition', 'sleep', 'mind', 'water'],
    locale: 'en',
    durationDays: 30,
  });
  // 3 included; 4th and 5th excluded
  assert.ok(p.systemPrompt.includes('Coaches involved: fitness, nutrition, sleep'));
  assert.ok(!p.systemPrompt.includes('mind, water'));
});

test('defaults to fitness when coachesInvolved missing', () => {
  const p = buildComposeQuestionsPrompt({ goalText: 'be better', locale: 'en' });
  assert.ok(p.systemPrompt.includes('Coaches involved: fitness'));
});

test('clamps duration to 30 when invalid', () => {
  const p = buildComposeQuestionsPrompt({
    goalText: 'foo bar baz',
    coachesInvolved: ['mind'],
    locale: 'en',
    durationDays: 999,
  });
  assert.ok(p.systemPrompt.includes('Plan duration: 30 days'));
});

test('accepts 7-day plan', () => {
  const p = buildComposeQuestionsPrompt({
    goalText: 'one week reset',
    coachesInvolved: ['nutrition'],
    locale: 'en',
    durationDays: 7,
  });
  assert.ok(p.systemPrompt.includes('Plan duration: 7 days'));
});

// ─── proposeName ────────────────────────────────────────────────────────
section('buildProposeNamePrompt');

test('returns { systemPrompt, userPrompt } with 3-6 word constraint', () => {
  const p = buildProposeNamePrompt({
    goalText: 'lose weight',
    coachesInvolved: ['nutrition'],
    locale: 'en',
    durationDays: 30,
  });
  assert.ok(p.systemPrompt.includes('3 to 6 words'));
});

test('exemplifies good vs bad titles', () => {
  const p = buildProposeNamePrompt({ goalText: 'lose weight', locale: 'en' });
  assert.ok(p.systemPrompt.includes('Drop 5 kg by July'));
  assert.ok(p.systemPrompt.includes('Sleep like a baby'));
});

// ─── composePlanBatch ───────────────────────────────────────────────────
section('buildComposePlanBatchPrompt');

test('returns prompts with batch range + coach constraints', () => {
  const p = buildComposePlanBatchPrompt({
    goalText: 'lose 5kg',
    coachesInvolved: ['fitness', 'nutrition'],
    answers: [{ id: 'q1', value: '3-4' }],
    durationDays: 30,
    batchStartIndex: 8,
    batchEndIndex: 14,
    locale: 'en',
    continuitySummary: 'Days 1-7 already cover hydration and protein floor.',
  });
  // The batch range and day count must appear (format may evolve across prompt iterations).
  assert.ok(/days?\s+8.{0,8}14/i.test(p.systemPrompt), 'prompt must mention day range 8 to 14');
  assert.ok(/(exactly\s+7|7\s+days)/i.test(p.systemPrompt), 'prompt must specify 7 days');
  assert.ok(p.systemPrompt.includes('fitness, nutrition'));
  assert.ok(p.systemPrompt.includes('Days 1-7 already cover'));
});

test('clamps to involved coaches when more than 3', () => {
  const p = buildComposePlanBatchPrompt({
    goalText: 'be healthy',
    coachesInvolved: ['fitness', 'nutrition', 'sleep', 'mind'],
    answers: [],
    durationDays: 7,
    batchStartIndex: 1,
    batchEndIndex: 7,
    locale: 'en',
  });
  assert.ok(p.systemPrompt.includes('fitness, nutrition, sleep'));
});

// ────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
