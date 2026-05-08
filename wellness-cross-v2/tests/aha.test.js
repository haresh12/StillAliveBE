/**
 * aha.test.js — AHA event-trigger system unit tests.
 *
 * Covers:
 *   - Each archetype fires correctly for matching context
 *   - No double-firing across runs (newEvents filters by id)
 *   - Cross-agent triggers (correlation, chronotype) require valid inputs
 *   - Day-1 user gets 'descriptive:first-log'
 */

'use strict';

const { evaluateTriggers, newEvents, ARCHETYPES, _internal: { TRIGGERS } } = require('../actions/aha-trigger');

let pass = 0, fail = 0;
function assert(label, cond) {
  if (cond) { console.log('  ✓ ' + label); pass++; }
  else { console.log('  ✗ ' + label); fail++; }
}

const baseCtx = {
  today: '2026-05-09',
  daysSinceSignup: 0,
  totalLogsToday: 0,
  topCorrelations: [],
  streaks: {},
  chronotype: null,
  weekPattern: null,
};

// ── unlock archetype ──
console.log('unlock');
assert('day 7 fires', !!TRIGGERS.unlock({ ...baseCtx, daysSinceSignup: 7 }));
assert('day 14 fires', !!TRIGGERS.unlock({ ...baseCtx, daysSinceSignup: 14 }));
assert('day 30 fires', !!TRIGGERS.unlock({ ...baseCtx, daysSinceSignup: 30 }));
assert('day 90 fires', !!TRIGGERS.unlock({ ...baseCtx, daysSinceSignup: 90 }));
assert('day 180 fires', !!TRIGGERS.unlock({ ...baseCtx, daysSinceSignup: 180 }));
assert('day 8 does NOT fire', TRIGGERS.unlock({ ...baseCtx, daysSinceSignup: 8 }) === null);
assert('day 0 does NOT fire', TRIGGERS.unlock({ ...baseCtx, daysSinceSignup: 0 }) === null);
assert('unlock id stable: unlock:7', TRIGGERS.unlock({ ...baseCtx, daysSinceSignup: 7 }).id === 'unlock:7');

// ── correlation archetype ──
console.log('correlation (cross-agent)');
const strongCorr = { agents: ['sleep', 'mind'], r: 0.71, n: 14, id: 'sleep×mind:14:0', plain_english: 'Sleep predicts mood', lag: 0 };
const weakCorr   = { agents: ['water', 'mind'], r: 0.42, n: 14, id: 'water×mind:14:0' };
const lowN       = { agents: ['sleep', 'mind'], r: 0.71, n: 5,  id: 'small' };
assert('strong r ≥ 0.6 + n ≥ 14 fires',
  !!TRIGGERS.correlation({ ...baseCtx, topCorrelations: [strongCorr] }));
assert('weak r < 0.6 does NOT fire',
  TRIGGERS.correlation({ ...baseCtx, topCorrelations: [weakCorr] }) === null);
assert('low n does NOT fire',
  TRIGGERS.correlation({ ...baseCtx, topCorrelations: [lowN] }) === null);
assert('correlation id stable',
  TRIGGERS.correlation({ ...baseCtx, topCorrelations: [strongCorr] }).id === 'correlation:sleep×mind');

// ── streak archetype ──
console.log('streak');
const streakHit = { current_consistent_days: 7 };
const streakMid = { current_consistent_days: 5 };
assert('7-day streak fires', !!TRIGGERS.streak({ ...baseCtx, streaks: streakHit }));
assert('5-day NOT a tier', TRIGGERS.streak({ ...baseCtx, streaks: streakMid }) === null);
assert('30-day fires', !!TRIGGERS.streak({ ...baseCtx, streaks: { current_consistent_days: 30 } }));

// ── chronotype archetype ──
console.log('chronotype');
const ct = { kind: 'evening', label: '10pm sleeper', mean_onset: '22:08', variance_min: 24 };
assert('valid chronotype fires',
  !!TRIGGERS.chronotype({ ...baseCtx, chronotype: ct }));
assert('null chronotype does NOT fire',
  TRIGGERS.chronotype({ ...baseCtx, chronotype: null }) === null);
assert('irregular kind does NOT fire',
  TRIGGERS.chronotype({ ...baseCtx, chronotype: { ...ct, kind: 'irregular' } }) === null);
assert('chronotype id stable: chronotype:evening',
  TRIGGERS.chronotype({ ...baseCtx, chronotype: ct }).id === 'chronotype:evening');

// ── descriptive (day-1 first log) ──
console.log('descriptive');
assert('first log on day 0 fires',
  !!TRIGGERS.descriptive({ ...baseCtx, daysSinceSignup: 0, totalLogsToday: 1 }));
// Day-1 LAW upgrade: day 0 ALWAYS fires (welcome OR first-log)
assert('day 0 with no logs ALSO fires (welcome)',
  !!TRIGGERS.descriptive({ ...baseCtx, daysSinceSignup: 0, totalLogsToday: 0 }));
assert('day 0 no logs → welcome id',
  TRIGGERS.descriptive({ ...baseCtx, daysSinceSignup: 0, totalLogsToday: 0 }).id === 'descriptive:welcome');
assert('day 0 with logs → first-log id',
  TRIGGERS.descriptive({ ...baseCtx, daysSinceSignup: 0, totalLogsToday: 1 }).id === 'descriptive:first-log');
assert('day 1 momentum nudge fires',
  !!TRIGGERS.descriptive({ ...baseCtx, daysSinceSignup: 1 }));
assert('day-3 nudge fires',
  !!TRIGGERS.descriptive({ ...baseCtx, daysSinceSignup: 3 }));
assert('day-5 nudge fires',
  !!TRIGGERS.descriptive({ ...baseCtx, daysSinceSignup: 5 }));

// ── pattern archetype ──
console.log('pattern');
const wp = { worst: 1, best: 5, headline: 'Tuesdays drag, Saturdays shine' };
assert('pattern fires after 14 days',
  !!TRIGGERS.pattern({ ...baseCtx, daysSinceSignup: 14, weekPattern: wp }));
assert('pattern does NOT fire before 14 days',
  TRIGGERS.pattern({ ...baseCtx, daysSinceSignup: 7, weekPattern: wp }) === null);
assert('pattern needs week_pattern',
  TRIGGERS.pattern({ ...baseCtx, daysSinceSignup: 14, weekPattern: null }) === null);

// ── evaluateTriggers integration ──
console.log('evaluateTriggers');
const fullCtx = {
  today: '2026-05-09',
  daysSinceSignup: 14,
  totalLogsToday: 3,
  topCorrelations: [strongCorr],
  streaks: streakHit,
  chronotype: ct,
  weekPattern: wp,
};
const evs = evaluateTriggers(fullCtx);
assert('fires multiple archetypes for rich context', evs.length >= 4);
assert('every event has stable id', evs.every((e) => typeof e.id === 'string' && e.id.length > 0));
assert('every event has kind, ts, headline', evs.every((e) => e.kind && e.ts && e.headline));

// ── newEvents idempotency ──
console.log('newEvents (idempotency)');
const allFiredIds = new Set(evs.map((e) => e.id));
assert('all-fired set produces zero new', newEvents(evs, allFiredIds).length === 0);
const partialFired = new Set([evs[0].id]);
assert('partial-fired returns the rest', newEvents(evs, partialFired).length === evs.length - 1);
assert('empty fired set returns all', newEvents(evs, new Set()).length === evs.length);

// ── ARCHETYPES manifest sanity ──
console.log('archetypes manifest');
assert('12 archetypes registered', ARCHETYPES.length === 12);
assert('every archetype has a TRIGGERS function', ARCHETYPES.every((k) => typeof TRIGGERS[k] === 'function'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
