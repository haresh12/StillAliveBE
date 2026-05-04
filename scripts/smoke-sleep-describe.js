'use strict';
// ────────────────────────────────────────────────────────────────────
// Smoke test: sleep-describe lib — preflight + validator deterministic
// checks on 30 representative utterances. Does NOT call the LLM
// (gpt-4o-mini parsing is mocked inline). Verifies:
//   1. preflight() returns sensible flags for natural speech
//   2. validateExtraction clamps fields + recomputes missing
//   3. DISRUPTOR_CANON filtering rejects fabricated values
// Run: node scripts/smoke-sleep-describe.js
// ────────────────────────────────────────────────────────────────────

const sd = require('../lib/sleep-describe');

const SAMPLES = [
  'I slept from midnight to 8am, sleep was good, took 20 minutes to fall asleep, nothing disturbed me',
  'Pretty rough, kid was up a lot, maybe 5 hours total',
  'Slept great. Probably 7 and a half hours.',
  'Went to bed at 11, woke up at 7, average night',
  'Had coffee too late, took forever to fall asleep',
  'Bed at half past 10, up at 6:30, felt restless',
  'Stressed, couldn\'t sleep, up three times',
  'Slept like a baby through the entire night',
  'Garbage night, partner snoring, hot room',
  'Woke up twice for the bathroom, otherwise fine',
  '11pm to 7am, quality 4 out of 5',
  'Decent, fell asleep fast',
  'Around 11 to around 7, alcohol last night',
  'Couldn\'t sleep for ages, anxious about work',
  'Phone in bed, slept poor, woke up tired',
  'Cold room, broken sleep, baby crying',
  'Solid 8 hours, no disruptions',
  'Brutal night, only got 4 hours',
  'Slept from 1am to 9am, alcohol last night',
  'Decent. 6 hours-ish.',
  'Fine',
  'Bed midnight wake 8',
  'Late workout, took 45 min to sleep',
  'Heavy meal before bed, woke up uncomfortable',
  'Noisy neighbors, light bleeding in window',
  'Up at 5 like usual, in bed by 10',
  'Tossed and turned for 2 hours',
  'Don\'t remember when I went to bed',
  '8 hours, perfect',
  'Stressed AF, screens until 1am, brutal',
];

let passed = 0, failed = 0;
const fails = [];

// ─── 1. Preflight smoke ──
console.log('\n=== PREFLIGHT (30 utterances) ===');
SAMPLES.forEach((s, i) => {
  const pre = sd.preflight(s);
  const ok =
    typeof pre.word_count === 'number' &&
    typeof pre.has_time_phrase === 'boolean' &&
    Array.isArray(pre.quality_hits) &&
    Array.isArray(pre.disruptor_hints) &&
    typeof pre.long_enough === 'boolean';
  if (ok) passed++; else { failed++; fails.push(`#${i+1} preflight: ${s}`); }
  console.log(`#${String(i+1).padStart(2,'0')} words=${pre.word_count} time=${pre.has_time_phrase?'Y':'N'} quality=[${pre.quality_hits.join(',')}] disruptors=[${pre.disruptor_hints.join(',')}] | ${s.slice(0,60)}`);
});

// ─── 2. Validator clamping ──
console.log('\n=== VALIDATOR (clamp + missing recompute) ===');
const dirty = {
  extracted: {
    bedtime:        { value: '25:99',          confidence: 0.9 }, // invalid time → null
    wake_time:      { value: '08:00',          confidence: 0.95 },
    sleep_quality:  { value: 7,                confidence: 0.9 }, // out of range → 5
    sleep_latency:  { value: 999,              confidence: 0.9 }, // out of range → 180
    night_wakings:  { value: -3,               confidence: 0.9 }, // out of range → 0
    morning_energy: { value: 'four',           confidence: 0.9 }, // NaN → null
    disruptors:     { value: ['Caffeine late', 'fake disruptor', 'Alcohol'], confidence: 0.9 },
  },
  summary: 'x'.repeat(200),
};
const cleaned = sd.validateExtraction(dirty);
const checks = [
  ['bedtime null on invalid', cleaned.extracted.bedtime.value === null],
  ['wake_time 08:00',         cleaned.extracted.wake_time.value === '08:00'],
  ['sleep_quality clamped 5', cleaned.extracted.sleep_quality.value === 5],
  ['sleep_latency clamped 180', cleaned.extracted.sleep_latency.value === 180],
  ['night_wakings clamped 0', cleaned.extracted.night_wakings.value === 0],
  ['morning_energy null on NaN', cleaned.extracted.morning_energy.value === null],
  ['fake disruptor stripped',  !cleaned.extracted.disruptors.value.includes('fake disruptor')],
  ['canonical disruptors kept', cleaned.extracted.disruptors.value.includes('Caffeine late') && cleaned.extracted.disruptors.value.includes('Alcohol')],
  ['summary truncated ≤140',  cleaned.summary.length <= 140],
  ['missing[] includes bedtime', cleaned.missing.includes('bedtime')],
  ['missing[] includes morning_energy', cleaned.missing.includes('morning_energy')],
];
checks.forEach(([label, ok]) => {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else    { failed++; fails.push(label); console.log(`  ✗ ${label}`); }
});

// ─── 3. Empty / null handling ──
console.log('\n=== EMPTY HANDLING ===');
const empty = sd.validateExtraction({});
const emptyOk =
  empty.extracted.bedtime.value === null &&
  empty.extracted.disruptors.value.length === 0 &&
  empty.missing.length === 7;
if (emptyOk) { passed++; console.log('  ✓ empty input → all null + 7 missing'); }
else         { failed++; fails.push('empty handling'); console.log('  ✗ empty handling'); }

// ─── 4. Disruptor canon coverage ──
console.log('\n=== DISRUPTOR CANON ===');
console.log(`  Total: ${sd.DISRUPTOR_CANON.length} (expected 13)`);
if (sd.DISRUPTOR_CANON.length === 13) { passed++; console.log('  ✓ canon size'); }
else { failed++; fails.push('canon size'); }

// ─── Summary ──
console.log(`\n${'═'.repeat(50)}`);
console.log(`✓ Passed: ${passed}  |  ✗ Failed: ${failed}`);
if (fails.length) {
  console.log('\nFAILURES:');
  fails.forEach(f => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('All smoke checks passed.');
process.exit(0);
