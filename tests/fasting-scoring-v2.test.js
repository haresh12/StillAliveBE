/**
 * Fasting scoring v2 — contract tests for the 2026-05-23 new helpers.
 *
 * Mirrors tests/fitness-scoring-v2.test.js. Covers:
 *   • computeFastingForm    — Banister-equivalent rest-day decay
 *   • derivePriorPeriod     — equal-length prior window delta
 *   • deriveDepthMix        — metabolic-tier % mix
 *   • deriveWindowStability — eating-window drift detector
 *   • deriveProtocolVariety — habituation flagger
 *   • deriveStartHourGrid   — TZ-corrected 7×24 grid
 *   • deriveContributionMap — GitHub-style 365 cells
 *   • deriveHabituation     — week-over-week stagnation
 *   • deriveCleanness       — broken / hunger / social / mood / energy %
 *   • deriveHungerWaveHour  — the AHA enabler (cross-agent moat input)
 *
 * Run: node tests/fasting-scoring-v2.test.js
 */

'use strict';

const assert = require('assert');
const {
  computeFastingForm,
  derivePriorPeriod,
  deriveDepthMix,
  deriveWindowStability,
  deriveProtocolVariety,
  deriveStartHourGrid,
  deriveContributionMap,
  deriveHabituation,
  deriveCleanness,
  deriveHungerWaveHour,
} = require('../lib/fasting-scoring');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function section(title) { console.log(`\n${title}`); }

// helpers
function isoOffsetDays(baseIso, deltaDays) {
  const [y, m, d] = baseIso.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d) + deltaDays * 86_400_000;
  const dt = new Date(ms);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// ────────────────────────────────────────────────────────────────
section('computeFastingForm');

test('empty input returns neutral defaults (ratio=1 → consistent band)', () => {
  const f = computeFastingForm({ sessions: [], priorSessions: [], startDateStr: '2026-05-01', todayDateStr: '2026-05-23' });
  assert.strictEqual(f.ctl_hours, 0);
  assert.strictEqual(f.atl_hours, 0);
  // ctl=0 → ratio defaults to 1 → falls in band 'consistent' (ratio < 1.05). This is a deliberate "no data, no judgement" default.
  assert.strictEqual(f.band, 'consistent');
});

test('reverse date order returns safe defaults (defensive)', () => {
  const f = computeFastingForm({ sessions: [], startDateStr: '2026-05-25', todayDateStr: '2026-05-20' });
  assert.strictEqual(f.band, 'consistent');
  assert.strictEqual(f.readiness, 50);
});

test('rest-day decay: long fasts then 14 rest days → ratio drops below 1', () => {
  const sessions = [
    { date: '2026-05-01', actual_hours: 18 },
    { date: '2026-05-02', actual_hours: 18 },
    { date: '2026-05-03', actual_hours: 18 },
  ];
  const f = computeFastingForm({ sessions, startDateStr: '2026-05-01', todayDateStr: '2026-05-23' });
  // After 20 rest days, ATL should have decayed much faster than CTL
  assert.ok(f.ratio < 1, `expected ratio < 1 after rest decay, got ${f.ratio}`);
});

test('aggressive cluster: 7 consecutive 20h fasts → ratio rises (atl > ctl)', () => {
  const sessions = [];
  for (let i = 0; i < 7; i++) sessions.push({ date: isoOffsetDays('2026-05-17', i), actual_hours: 20 });
  const f = computeFastingForm({ sessions, startDateStr: '2026-04-01', todayDateStr: '2026-05-23' });
  assert.ok(f.ratio > 1, `expected ratio > 1 during aggressive cluster, got ${f.ratio}`);
});

test('readiness clamped [0, 100]', () => {
  // Extreme positive load
  const sessions = [];
  for (let i = 0; i < 14; i++) sessions.push({ date: isoOffsetDays('2026-05-10', i), actual_hours: 36 });
  const f = computeFastingForm({ sessions, startDateStr: '2026-05-10', todayDateStr: '2026-05-23' });
  assert.ok(f.readiness >= 0 && f.readiness <= 100);
});

test('output shape contains all 7 contract keys', () => {
  const f = computeFastingForm({ sessions: [], startDateStr: '2026-05-01', todayDateStr: '2026-05-23' });
  for (const k of ['ctl_hours', 'atl_hours', 'tsb', 'ratio', 'readiness', 'band', 'explain']) {
    assert.ok(k in f, `missing key: ${k}`);
  }
});

test('explain text always non-empty for known bands', () => {
  const sessions = [{ date: '2026-05-01', actual_hours: 18 }];
  const f = computeFastingForm({ sessions, startDateStr: '2026-05-01', todayDateStr: '2026-05-23' });
  assert.ok(typeof f.explain === 'string' && f.explain.length > 0);
});

// ────────────────────────────────────────────────────────────────
section('derivePriorPeriod');

test('returns null when no prior sessions', () => {
  assert.strictEqual(derivePriorPeriod({ priorSessions: [] }), null);
  assert.strictEqual(derivePriorPeriod({ priorSessions: null }), null);
});

test('computes deltas correctly when both periods have data', () => {
  const prior = [
    { date: '2026-04-01', actual_hours: 10, completed: true },
    { date: '2026-04-02', actual_hours: 10, completed: true },
    { date: '2026-04-03', actual_hours: 10, completed: true, broken_early: false },
  ];
  const out = derivePriorPeriod({
    priorSessions: prior,
    currentTotalHours: 60,
    currentDaysLogged: 3,
    currentDepthCount: 3,
    currentBrokenCount: 0,
  });
  assert.strictEqual(out.total_hours, 30);
  assert.strictEqual(out.days_logged, 3);
  assert.strictEqual(out.depth_hits, 0);   // none ≥ 16h
  assert.strictEqual(out.broken_count, 0);
  assert.strictEqual(out.delta_hours_pct, 100);   // 30 → 60 = +100%
  assert.strictEqual(out.delta_depth_abs, 3);     // 0 → 3
});

test('handles divide-by-zero gracefully (prior=0)', () => {
  const prior = [{ date: '2026-04-01', actual_hours: 0 }];
  const out = derivePriorPeriod({
    priorSessions: prior, currentTotalHours: 16, currentDaysLogged: 1, currentDepthCount: 1, currentBrokenCount: 0,
  });
  assert.strictEqual(out.delta_hours_pct, null);
});

// ────────────────────────────────────────────────────────────────
section('deriveDepthMix');

test('empty sessions → all zeros, working_n=0', () => {
  const d = deriveDepthMix([]);
  assert.strictEqual(d.total_n, 0);
  assert.strictEqual(d.working_n, 0);
  assert.strictEqual(d.fat_pct, 0);
});

test('classifies stages correctly into 5 buckets', () => {
  const sessions = [
    { actual_hours: 2 },    // fed
    { actual_hours: 8 },    // glycogen
    { actual_hours: 14 },   // fat
    { actual_hours: 17 },   // ketone
    { actual_hours: 30 },   // deep
  ];
  const d = deriveDepthMix(sessions);
  assert.strictEqual(d.total_n, 5);
  assert.strictEqual(d.working_n, 3);  // fat + ketone + deep
  assert.strictEqual(d.fed_pct, 20);
  assert.strictEqual(d.glycogen_pct, 20);
  assert.strictEqual(d.fat_pct, 20);
  assert.strictEqual(d.ketone_pct, 20);
  assert.strictEqual(d.deep_pct, 20);
});

test('skips sessions without actual_hours', () => {
  const d = deriveDepthMix([{ actual_hours: null }, { actual_hours: 16 }]);
  assert.strictEqual(d.total_n, 1);
});

// ────────────────────────────────────────────────────────────────
section('deriveWindowStability');

test('< 3 samples → null medians, drift_flag false', () => {
  const w = deriveWindowStability([
    { started_at: 1700000000000, ended_at: 1700050000000 },
    { started_at: 1700100000000, ended_at: 1700150000000 },
  ], 7, 0);
  assert.strictEqual(w.median_start_hour, null);
  assert.strictEqual(w.drift_flag, false);
});

test('tight window: identical times → std ~0, drift_flag false', () => {
  // 3 sessions all start at hour 21 UTC, end at hour 13 UTC next day
  const sessions = [];
  for (let i = 0; i < 5; i++) {
    const startMs = Date.UTC(2026, 4, 1 + i, 21, 0, 0);
    const endMs   = Date.UTC(2026, 4, 2 + i, 13, 0, 0);
    sessions.push({ started_at: startMs, ended_at: endMs });
  }
  const w = deriveWindowStability(sessions, 30, 0);
  assert.strictEqual(w.drift_flag, false);
  assert.ok(w.std_start_hours < 0.1);
});

test('drift > 1.5h trips flag', () => {
  // Mixed start hours: 18, 21, 23
  const sessions = [
    { started_at: Date.UTC(2026, 4, 1, 18, 0, 0), ended_at: Date.UTC(2026, 4, 2, 10, 0, 0) },
    { started_at: Date.UTC(2026, 4, 2, 21, 0, 0), ended_at: Date.UTC(2026, 4, 3, 13, 0, 0) },
    { started_at: Date.UTC(2026, 4, 3, 23, 0, 0), ended_at: Date.UTC(2026, 4, 4, 15, 0, 0) },
  ];
  const w = deriveWindowStability(sessions, 30, 0);
  assert.strictEqual(w.drift_flag, true);
  assert.ok(w.std_start_hours > 1.5);
});

// ────────────────────────────────────────────────────────────────
section('deriveProtocolVariety');

test('empty input', () => {
  const v = deriveProtocolVariety([], 30);
  assert.strictEqual(v.unique_protocols, 0);
  assert.strictEqual(v.dominant_protocol, null);
  assert.strictEqual(v.stagnant, false);
});

test('single dominant protocol over ≥28d → stagnant', () => {
  const sessions = [];
  for (let i = 0; i < 20; i++) sessions.push({ protocol: '16:8', completed: true });
  const v = deriveProtocolVariety(sessions, 30);
  assert.strictEqual(v.dominant_protocol, '16:8');
  assert.strictEqual(v.dominant_pct, 100);
  assert.strictEqual(v.stagnant, true);
});

test('mixed protocols over 30d → not stagnant', () => {
  const sessions = [
    ...Array(5).fill({ protocol: '16:8', completed: true }),
    ...Array(5).fill({ protocol: '18:6', completed: true }),
  ];
  const v = deriveProtocolVariety(sessions, 30);
  assert.strictEqual(v.unique_protocols, 2);
  assert.strictEqual(v.stagnant, false);
});

test('dominant protocol over <28d → never stagnant', () => {
  const sessions = Array(10).fill({ protocol: '16:8', completed: true });
  const v = deriveProtocolVariety(sessions, 14);
  assert.strictEqual(v.stagnant, false);
});

// ────────────────────────────────────────────────────────────────
section('deriveStartHourGrid');

test('empty input → 7×24 zero grid', () => {
  const g = deriveStartHourGrid([], 0);
  assert.strictEqual(g.length, 7);
  assert.strictEqual(g[0].length, 24);
  assert.strictEqual(g.flat().reduce((a, b) => a + b, 0), 0);
});

test('TZ correction applied via utcOffsetMinutes', () => {
  // Session at UTC midnight on a Monday → with -300min offset (EST),
  // local time is Sunday 7pm.
  const mondayMidnightUtc = Date.UTC(2026, 4, 4, 0, 0, 0);  // 2026-05-04 = Monday UTC
  const g = deriveStartHourGrid([{ started_at: mondayMidnightUtc }], -300);
  // Sunday (DOW 0), hour 19
  assert.strictEqual(g[0][19], 1);
  assert.strictEqual(g[1][0], 0);  // NOT logged at Monday midnight UTC
});

test('handles toMillis-style timestamps', () => {
  const ts = { toMillis: () => Date.UTC(2026, 4, 4, 14, 0, 0) };
  const g = deriveStartHourGrid([{ started_at: ts }], 0);
  assert.strictEqual(g[1][14], 1);  // Monday hour 14
});

// ────────────────────────────────────────────────────────────────
section('deriveContributionMap');

test('null today → empty cells + zero summary', () => {
  const c = deriveContributionMap({ dayQualityByDate: {}, anchorDate: '2026-01-01', todayDate: null });
  assert.strictEqual(c.cells.length, 0);
  assert.strictEqual(c.summary.total_cells, 0);
});

test('exactly 365 cells starting at anchor', () => {
  const c = deriveContributionMap({ dayQualityByDate: {}, anchorDate: '2026-01-01', todayDate: '2026-05-23' });
  assert.strictEqual(c.cells.length, 365);
  assert.strictEqual(c.cells[0].date, '2026-01-01');
});

test('today cell not flagged as future', () => {
  const c = deriveContributionMap({ dayQualityByDate: {}, anchorDate: '2026-05-23', todayDate: '2026-05-23' });
  assert.strictEqual(c.cells[0].future, false);
});

test('cells after today are future-flagged', () => {
  const c = deriveContributionMap({ dayQualityByDate: {}, anchorDate: '2026-05-20', todayDate: '2026-05-22' });
  // 2026-05-23 onwards = future
  const futureCells = c.cells.filter(cell => cell.future);
  assert.ok(futureCells.length > 0);
  assert.strictEqual(futureCells[0].date, '2026-05-23');
});

test('level derived from quality buckets correctly', () => {
  const c = deriveContributionMap({
    dayQualityByDate: {
      '2026-05-20': 80,   // → level 3
      '2026-05-21': 60,   // → level 2
      '2026-05-22': 30,   // → level 1
      '2026-05-23': null, // → level 0
    },
    anchorDate: '2026-05-20',
    todayDate: '2026-05-23',
  });
  assert.strictEqual(c.cells[0].level, 3);
  assert.strictEqual(c.cells[1].level, 2);
  assert.strictEqual(c.cells[2].level, 1);
  assert.strictEqual(c.cells[3].level, 0);
});

// ────────────────────────────────────────────────────────────────
section('deriveHabituation');

test('< 4 weeks of data → not stalled', () => {
  const h = deriveHabituation({ avgFastHoursByWeek: [16, 16, 16] });
  assert.strictEqual(h.stalled, false);
});

test('flat across exactly 3 weeks → stalled=true', () => {
  // last=16. Walk back: 16.1(-0.6%,in)→1; 16(0%,in)→2; 16(0%,in)→3; 15(+6.7%,out)→break
  const h = deriveHabituation({ avgFastHoursByWeek: [14, 15, 16, 16, 16.1, 16] });
  assert.strictEqual(h.weeks_stalled, 3);
  assert.strictEqual(h.stalled, true);
});

test('5+ flat weeks → stalled', () => {
  const h = deriveHabituation({ avgFastHoursByWeek: [12, 13, 16, 16, 16, 16, 16] });
  assert.strictEqual(h.weeks_stalled, 4);
  assert.strictEqual(h.stalled, true);
});

test('upward trend → not stalled', () => {
  const h = deriveHabituation({ avgFastHoursByWeek: [12, 14, 16, 18, 20] });
  assert.strictEqual(h.stalled, false);
});

// ────────────────────────────────────────────────────────────────
section('deriveCleanness');

test('empty input returns zeros (not nulls)', () => {
  const c = deriveCleanness([]);
  assert.strictEqual(c.avg_hours, 0);
  assert.strictEqual(c.broken_pct, 0);
  assert.strictEqual(c.hunger_break_pct, 0);
});

test('computes avg + break percentages', () => {
  const sessions = [
    { actual_hours: 16, completed: true },
    { actual_hours: 18, completed: true },
    { actual_hours: 4, broken_early: true, broken_reason: 'hunger' },
    { actual_hours: 6, broken_early: true, broken_reason: 'social' },
  ];
  const c = deriveCleanness(sessions);
  assert.strictEqual(c.broken_pct, 50);  // 2 of 4 broken
  assert.strictEqual(c.hunger_break_pct, 50);  // 1 of 2 broken
  assert.strictEqual(c.social_break_pct, 50);
  assert.ok(c.avg_hours > 0);
});

// ────────────────────────────────────────────────────────────────
section('deriveHungerWaveHour');

test('< 3 hunger breaks → null wave_hour', () => {
  const w = deriveHungerWaveHour([
    { broken_early: true, broken_reason: 'hunger', actual_hours: 14 },
    { broken_early: true, broken_reason: 'hunger', actual_hours: 13 },
  ]);
  assert.strictEqual(w.wave_hour, null);
  assert.strictEqual(w.sample_n, 2);
});

test('≥ 3 hunger breaks → median wave hour returned', () => {
  const w = deriveHungerWaveHour([
    { broken_early: true, broken_reason: 'hunger', actual_hours: 12 },
    { broken_early: true, broken_reason: 'hunger', actual_hours: 14 },
    { broken_early: true, broken_reason: 'hunger', actual_hours: 16 },
  ]);
  assert.strictEqual(w.wave_hour, 14);
  assert.strictEqual(w.sample_n, 3);
});

test('ignores non-hunger breaks + completed sessions', () => {
  const w = deriveHungerWaveHour([
    { broken_early: true, broken_reason: 'hunger', actual_hours: 14 },
    { broken_early: true, broken_reason: 'social', actual_hours: 5 },
    { completed: true, actual_hours: 18 },
    { broken_early: true, broken_reason: 'hunger', actual_hours: 16 },
    { broken_early: true, broken_reason: 'hunger', actual_hours: 12 },
  ]);
  assert.strictEqual(w.sample_n, 3);
  assert.strictEqual(w.wave_hour, 14);
});

// ────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
