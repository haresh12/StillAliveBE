/**
 * goal-plans Plans v2 — ship-gate greps.
 *
 * 12 hard constraints that lock the v2 design laws in code, so anyone
 * future-touching the Plans feature can't accidentally regress them.
 *
 * Run: node tests/goal-plans-ship-gates.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT     = path.resolve(__dirname, '..', '..');
const BE_ROOT  = path.join(ROOT, 'stillalive-backend');
const FE_ROOT  = path.join(ROOT, 'StillAlive');

const BE_PLANS = [
  path.join(BE_ROOT, 'goal-plans.agent.js'),
  path.join(BE_ROOT, 'lib', 'goal-plans'),
];
const FE_PLANS = path.join(FE_ROOT, 'src', 'screens', 'wellness', 'plans');

function walkFiles(p, acc = []) {
  if (!fs.existsSync(p)) return acc;
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    fs.readdirSync(p).forEach(n => walkFiles(path.join(p, n), acc));
  } else if (p.endsWith('.js') || p.endsWith('.jsx')) {
    acc.push(p);
  }
  return acc;
}

function searchAll(roots, regex, predicate = () => true) {
  const hits = [];
  const files = roots.flatMap(r => walkFiles(r));
  for (const f of files) {
    const txt = fs.readFileSync(f, 'utf8');
    const lines = txt.split('\n');
    lines.forEach((line, i) => {
      if (regex.test(line) && predicate(line, f)) {
        hits.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  return hits;
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function section(t) { console.log(`\n${t}`); }

// Ignore comments + the tests dir itself
const notCommentOrTest = (line, file) =>
  !/^\s*\/\//.test(line)
  && !/^\s*\*/.test(line)
  && !file.includes(`${path.sep}tests${path.sep}`);

section('Backend ship gates');

test('BE: no `temperature:` in plans tree', () => {
  const hits = searchAll(BE_PLANS, /temperature\s*:/, notCommentOrTest);
  assert.strictEqual(hits.length, 0, `found temperature usage:\n${hits.join('\n')}`);
});

test('BE: no `max_tokens:` (must use max_completion_tokens)', () => {
  const hits = searchAll(BE_PLANS, /\bmax_tokens\s*:/, notCommentOrTest);
  assert.strictEqual(hits.length, 0, `found max_tokens usage:\n${hits.join('\n')}`);
});

test('BE: no hardcoded fallback plan helper', () => {
  const hits = searchAll(BE_PLANS, /buildFallbackPlan/, notCommentOrTest);
  assert.strictEqual(hits.length, 0, `found fallback template:\n${hits.join('\n')}`);
});

test('BE: no `.where(...).orderBy(...)` chains (no composite indexes)', () => {
  const hits = searchAll(BE_PLANS, /\.where\([^)]+\)\s*\.orderBy\(/, notCommentOrTest);
  assert.strictEqual(hits.length, 0, `composite-index pattern:\n${hits.join('\n')}`);
});

test('BE: /today route NOT mounted', () => {
  const agent = fs.readFileSync(path.join(BE_ROOT, 'goal-plans.agent.js'), 'utf8');
  assert.ok(!/router\.(get|post)\(\s*['"]\/today['"]/.test(agent), 'found /today route mount');
});

test('BE: no day-tiling helper', () => {
  const hits = searchAll(BE_PLANS, /\b(tileWeeklyToFull|tileToFull|repeatWeeklyDays)\b/, notCommentOrTest);
  assert.strictEqual(hits.length, 0, `tiling helper present:\n${hits.join('\n')}`);
});

test('BE: no `messages[]` array on plan RESPONSES (anti-chatbot canon)', () => {
  // ai.js legitimately uses `messages:` for OpenAI's chat.completions
  // request shape. Exclude only that file — any other use of messages[]
  // in the plans tree would be a chat-shaped response leaking through.
  const hits = searchAll(
    BE_PLANS,
    /messages\s*:\s*\[/,
    (line, file) => notCommentOrTest(line, file) && !file.endsWith(`${path.sep}ai.js`),
  );
  assert.strictEqual(hits.length, 0, `messages array found:\n${hits.join('\n')}`);
});

section('Frontend ship gates');

test('FE: no `Animated.spring` in plans tree (Reanimated 3 only)', () => {
  const hits = searchAll([FE_PLANS], /\bAnimated\.spring\b/, notCommentOrTest);
  assert.strictEqual(hits.length, 0, `Animated.spring usage:\n${hits.join('\n')}`);
});

test('FE: no `LayoutAnimation` in plans tree', () => {
  const hits = searchAll([FE_PLANS], /\bLayoutAnimation\b/, notCommentOrTest);
  assert.strictEqual(hits.length, 0, `LayoutAnimation usage:\n${hits.join('\n')}`);
});

test('FE: no `WellnessChatScreen` import in plans tree', () => {
  const hits = searchAll([FE_PLANS], /WellnessChatScreen/, notCommentOrTest);
  assert.strictEqual(hits.length, 0, `chat-screen import:\n${hits.join('\n')}`);
});

test('FE: no `useEntitlement` import in plans tree', () => {
  const hits = searchAll([FE_PLANS], /useEntitlement/, notCommentOrTest);
  assert.strictEqual(hits.length, 0, `entitlement gate:\n${hits.join('\n')}`);
});

test('FE: deleted screens do NOT exist as files', () => {
  const banned = [
    'PlanDetailScreen.js',
    'PlanDayAccordion.js',
    'PlanTimelineView.js',
    'PlanMilestoneStrip.js',
    'PlanItemRow.js',
    'PlanInsightLauncher.js',
    'PlanAnswerCard.js',
    'PlanEditQuestionSheet.js',
    'PlanDraftQuestionsScreen.js',
  ];
  const files = walkFiles(FE_PLANS);
  const found = banned.filter(name => files.some(f => f.endsWith(name)));
  assert.strictEqual(found.length, 0, `banned v1 files still present: ${found.join(', ')}`);
});

section('Research-backed never-copy gates');

test('FE: no XP/gold/mana/level_up gamification (Habitica trap)', () => {
  const hits = searchAll([FE_PLANS], /\b(xp|gold|mana|level_up|levelUp)\b/i, notCommentOrTest);
  assert.strictEqual(hits.length, 0, `gamification leak:\n${hits.join('\n')}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
