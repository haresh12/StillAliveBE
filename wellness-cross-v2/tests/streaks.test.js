/**
 * tests/streaks.test.js
 */

const assert = require('assert');
const { computeStreaks, nextMonday } = require('../streaks/streak-engine');
const { emptyAgentSnapshot, AGENTS } = require('../adapters/_shape');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`✓ ${name}`); }
  catch (e) { fail++; console.error(`✗ ${name}\n  ${e.message}`); }
}

function mkSnap(agent, today, hasLog, score) {
  const s = emptyAgentSnapshot(agent, today);
  s.setup.is_complete = true;
  s.today.has_log = hasLog;
  s.today.score = score;
  return s;
}

t('Day 0: all empty, freeze pre-granted', () => {
  const today = '2026-05-08';
  const snapshots = {};
  for (const a of AGENTS) snapshots[a] = mkSnap(a, today, false, null);
  const out = computeStreaks({ snapshots, prevStreaks: null, todayDate: today });
  assert.strictEqual(out.streak_freeze_count, 1);
  assert.strictEqual(out.streak_freeze_available, true);
  assert.strictEqual(out.cross_agent_grace_active, false);
  for (const ag of out.per_agent) {
    assert.strictEqual(ag.current, 0);
  }
});

t('Logging today after yesterday increments streak', () => {
  const today = '2026-05-08';
  const yesterday = '2026-05-07';
  const snapshots = {};
  for (const a of AGENTS) snapshots[a] = mkSnap(a, today, true, 70);
  const prevStreaks = {
    per_agent: { sleep: { current: 5, longest: 10, last_log_date: yesterday, status: 'active' } },
    freezes: { available: 1, used_this_week: 0, last_grant_at: '2026-05-04', next_grant_at: '2026-05-11' },
  };
  const out = computeStreaks({ snapshots, prevStreaks, todayDate: today });
  const sleep = out.per_agent.find((a) => a.agent === 'sleep');
  assert.strictEqual(sleep.current, 6);
});

t('Cross-agent grace: 2 strong agents save a missed agent', () => {
  const today = '2026-05-08';
  const yesterday = '2026-05-07';
  const snapshots = {};
  // sleep + mind strong (≥60), water missed
  snapshots.sleep = mkSnap('sleep', today, true, 75);
  snapshots.mind = mkSnap('mind', today, true, 70);
  snapshots.water = mkSnap('water', today, false, null);
  for (const a of ['nutrition', 'fitness', 'fasting']) snapshots[a] = mkSnap(a, today, false, null);

  const prevStreaks = {
    per_agent: { water: { current: 4, longest: 4, last_log_date: yesterday, status: 'active' } },
    freezes: { available: 1, used_this_week: 0, last_grant_at: '2026-05-04', next_grant_at: '2026-05-11' },
  };
  const out = computeStreaks({ snapshots, prevStreaks, todayDate: today });
  assert.strictEqual(out.cross_agent_grace_active, true);
  const water = out.per_agent.find((a) => a.agent === 'water');
  assert.strictEqual(water.status, 'frozen');
  assert.strictEqual(water.current, 4); // streak preserved
});

t('Without grace, missing yesterday→today resets streak', () => {
  const today = '2026-05-08';
  const yesterday = '2026-05-07';
  const snapshots = {};
  // Only one strong agent → no grace
  snapshots.sleep = mkSnap('sleep', today, true, 75);
  snapshots.water = mkSnap('water', today, false, null);
  for (const a of ['mind', 'nutrition', 'fitness', 'fasting']) snapshots[a] = mkSnap(a, today, false, null);

  const prevStreaks = {
    per_agent: { water: { current: 4, longest: 4, last_log_date: yesterday, status: 'active' } },
    freezes: { available: 1, used_this_week: 0, last_grant_at: '2026-05-04', next_grant_at: '2026-05-11' },
  };
  const out = computeStreaks({ snapshots, prevStreaks, todayDate: today });
  assert.strictEqual(out.cross_agent_grace_active, false);
  const water = out.per_agent.find((a) => a.agent === 'water');
  assert.strictEqual(water.status, 'lapsed');
  assert.strictEqual(water.current, 0);
});

t('Anti-gaming: log_consistency caps at 1/day', () => {
  // Single-day flood doesn't let a brand-new user go from 0 → 7-day streak
  const today = '2026-05-08';
  const snapshots = {};
  for (const a of AGENTS) snapshots[a] = mkSnap(a, today, true, 90);
  const out = computeStreaks({ snapshots, prevStreaks: null, todayDate: today });
  for (const ag of out.per_agent) {
    assert.strictEqual(ag.current, 1, `${ag.agent} should be 1, got ${ag.current}`);
  }
});

t('Weekly freeze grant triggers when next_grant_at reached', () => {
  const today = '2026-05-11';
  const snapshots = {};
  for (const a of AGENTS) snapshots[a] = mkSnap(a, today, true, 70);
  const prevStreaks = {
    per_agent: {},
    freezes: { available: 0, used_this_week: 1, last_grant_at: '2026-05-04', next_grant_at: '2026-05-11' },
  };
  const out = computeStreaks({ snapshots, prevStreaks, todayDate: today });
  assert.strictEqual(out.streak_freeze_count, 1);
  assert.notStrictEqual(out.freezes.next_grant_at, '2026-05-11');
});

t('nextMonday from a Wednesday', () => {
  const out = nextMonday('2026-05-06'); // Wed
  assert.strictEqual(out, '2026-05-11');
});

t('nextMonday from a Monday returns NEXT Monday', () => {
  const out = nextMonday('2026-05-04'); // Mon
  assert.strictEqual(out, '2026-05-11');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
