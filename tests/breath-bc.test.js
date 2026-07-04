/**
 * breath.bc.agent — contract test (the 7th agent).
 *
 * Locks the load-bearing behaviour of the Breath agent WITHOUT booting Firebase or
 * hitting the network. Mirrors the repo's lightweight style: in-memory stand-ins for
 * Firestore (./collections) + anchor (./user-anchor) + Apple Health (./hk-domain),
 * mocked in the require cache before the router loads.
 *
 * Asserts:
 *   1. /analysis EXCLUDES pre-registration sessions (P1 anchor law).
 *   2. The honest score is computed (0-100) and its parts are present.
 *   3. The GRACE streak survives a single missed day (never-miss-twice), while the
 *      strict streak breaks on it.
 *   4. feel_shift (before→after self-report) is surfaced as proof-of-effect.
 *   5. /log rejects a future date via the log-guard.
 *
 * Run: node tests/breath-bc.test.js
 */
'use strict';

const assert = require('assert');
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-breath';

// ── deterministic clock: pin "today" so streak/window math is stable ──
const DAY = 86400000;
const now = Date.UTC(2026, 6, 4, 18, 0, 0); // 2026-07-04T18:00Z
const _RealDateNow = Date.now;
Date.now = () => now;
const key = (ms) => new Date(ms).toISOString().slice(0, 10);
const today = key(now);

// Anchor = 20 days ago, so a session 30 days ago is PRE-anchor and must be dropped.
const anchorMs = now - 20 * DAY;
const anchorDateStr = key(anchorMs);

// ── build the session fixture ─────────────────────────────────────────────────
// Days back from today with a session: 0,1,2, (3 MISSED), 4,5  → grace bridges day 3.
// Plus one PRE-anchor session at 30 days back that must NOT count.
function sess(daysBack, extra = {}) {
  const ms = now - daysBack * DAY;
  return {
    id: `s${daysBack}`,
    data: () => ({
      moment: 'stress', protocol: 'cyclic_sigh', seconds: 300, cycles: 10, completed: true,
      feel_before: 2, feel_after: 4, hour: 8, time_of_day: 'morning',
      date_str: key(ms), logged_at: { toMillis: () => ms }, ...extra,
    }),
  };
}
const DOCS = [sess(0), sess(1), sess(2), sess(4), sess(5), sess(30, { id: 's30' })];

// ── mock Firestore layer (./collections) ──────────────────────────────────────
function mock(relPath, exports) {
  const p = require.resolve(relPath);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
const sessionsSnap = { docs: DOCS };
const breathDocData = { exists: true, data: () => ({ session_count: DOCS.length, last_moment: 'stress' }) };
mock('../lib/collections', {
  userDoc: () => ({
    collection: () => ({
      doc: () => ({
        get: async () => breathDocData,
        set: async () => ({}),
        collection: () => ({
          orderBy: () => ({ limit: () => ({ get: async () => sessionsSnap }) }),
          doc: () => ({ set: async () => ({}), delete: async () => ({}) }),
          add: async () => ({ id: 'new' }),
        }),
      }),
    }),
  }),
});
mock('../lib/user-anchor', {
  resolveAnchor: async () => ({ anchorMs, anchorDateStr, utcOffsetMinutes: 0, isResolved: true }),
});
mock('../lib/hk-domain', { domainHealthView: async () => null, domainHealth: async () => null });
// Keep the LLM out of the test path (days_practiced >= 3 would otherwise call it).
mock('../lib/i18n-prompt', { resolveLanguage: () => 'en', appendLanguageInstruction: (s) => s });

// firebase-admin stub (Timestamp/serverTimestamp only — no real SDK).
const adminPath = require.resolve('firebase-admin');
require.cache[adminPath] = {
  id: adminPath, filename: adminPath, loaded: true,
  exports: { firestore: Object.assign(() => ({}), { FieldValue: { serverTimestamp: () => 0, increment: () => 0 }, Timestamp: { now: () => ({ toMillis: () => now }) } }) },
};
// openai stub so the AI read path never actually calls out.
const openaiPath = require.resolve('openai');
require.cache[openaiPath] = { id: openaiPath, filename: openaiPath, loaded: true, exports: { OpenAI: function () { this.chat = { completions: { create: async () => { throw new Error('no-net'); } } }; } } };

const router = require('../breath.bc.agent');

// ── tiny express-handler harness ──────────────────────────────────────────────
function handlerFor(method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function fakeRes() {
  return {
    _status: 200, _json: null, statusCode: 200,
    status(c) { this._status = c; this.statusCode = c; return this; },
    json(o) { this._json = o; return this; },
    set() { return this; },
  };
}
async function call(method, path, { query = {}, body = {} } = {}) {
  const res = fakeRes();
  await handlerFor(method, path)({ query, body, headers: {} }, res);
  return res;
}

(async () => {
  // 1-4) /analysis
  const a = await call('get', '/analysis', { query: { deviceId: 'dev', range: '30' } });
  assert.strictEqual(a._status, 200, '/analysis 200');
  const j = a._json;

  assert.strictEqual(j.total_sessions, 5, `pre-anchor session dropped → 5 counted, got ${j.total_sessions}`);
  assert.strictEqual(j.days_practiced, 5, `5 distinct practiced days in window, got ${j.days_practiced}`);
  assert.ok(typeof j.breath_score === 'number' && j.breath_score >= 0 && j.breath_score <= 100, 'breath_score is 0-100');
  assert.ok(j.score_parts && typeof j.score_parts.consistency === 'number', 'score_parts present');
  assert.ok(j.anchor_date === anchorDateStr, 'anchor_date echoed');
  assert.ok(j.effective_start_date && j.effective_days >= 1, 'registration-anchored window present');

  // grace streak bridges the single missed day (0,1,2,[miss],4,5 → grace ≥ 6); strict breaks at the gap (=3).
  assert.strictEqual(j.strict_streak, 3, `strict streak stops at gap, got ${j.strict_streak}`);
  assert.ok(j.current_streak >= 6, `grace streak bridges one miss (≥6), got ${j.current_streak}`);

  // feel_shift proof-of-effect: every session went 2→4 (+2), 100% improved.
  assert.ok(j.feel_shift && j.feel_shift.improved_pct === 100 && j.feel_shift.avg_delta === 2, 'feel_shift computed');

  // 5) /log rejects a future date (log-guard).
  const bad = await call('post', '/log', { body: { deviceId: 'dev', date_str: key(now + 3 * DAY), moment: 'sos' } });
  assert.strictEqual(bad._status, 400, `future-dated log rejected, got ${bad._status}`);
  assert.ok(bad._json && bad._json.code === 'FUTURE_DATE', 'log-guard FUTURE_DATE code');

  Date.now = _RealDateNow;
  console.log('✅ breath-bc: all assertions passed (anchor clamp, honest score, grace streak, feel-shift, log-guard)');
})().catch((e) => { Date.now = _RealDateNow; console.error('❌ breath-bc test failed:', e.message); process.exit(1); });
