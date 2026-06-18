/**
 * hk-domain domainHealthView — contract test.
 *
 * Locks the "Body Signals" payload math: today tiles framed vs the user's own
 * baseline, weekly trend + "vs prior", anchor meta, no-data parity, and — for
 * App Store compliance — that the summary handed to the insight/LLM layer carries
 * NO deviceId / identifier.
 *
 * Mirrors the repo's lightweight style: in-memory stand-ins for Firestore +
 * anchor + insight, no admin SDK boot, no network.
 *
 * Run: node tests/hk-domain-view.test.js
 */
'use strict';

const assert = require('assert');
const { dateStr } = require('../lib/range-helpers');

const tz = 0;
const now = Date.now();

// ── Fake daily store: recent 6 days clearly above the older baseline ──
const stepsDays = {};
const sleepDays = {};
const rhrDays = {};
for (let i = 0; i < 40; i++) {
  const d = dateStr(new Date(now - i * 86400000), tz);
  stepsDays[d] = i < 6 ? 11000 : 6000;
  sleepDays[d] = { asleep_min: (i < 5 ? 7.5 : 6.2) * 60, efficiency: i < 5 ? 92 : 85 };
  rhrDays[d] = 55 + (i < 5 ? 0 : 3);
}
const STORE = { steps: stepsDays, sleep: sleepDays, restingHeartRate: rhrDays };

// Mock ./collections (Firestore) + ./user-anchor + ./hk-insight in the require cache.
function mock(relPath, exports) {
  const p = require.resolve(relPath);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
mock('../lib/collections', {
  userDoc: () => ({
    collection: () => ({
      doc: (k) => ({ get: async () => ({ exists: !!(STORE[k] && Object.keys(STORE[k]).length), data: () => ({ days: STORE[k] || {} }) }) }),
    }),
  }),
});
mock('../lib/user-anchor', {
  resolveAnchor: async () => ({ anchorMs: now - 200 * 86400000, anchorDateStr: dateStr(new Date(now - 200 * 86400000), tz), utcOffsetMinutes: tz }),
});
let capturedSummary = null;
let capturedDevice = null;
mock('../lib/hk-insight', {
  attachDomainInsight: async (deviceId, domain, summary) => { capturedSummary = summary; capturedDevice = deviceId; return null; },
});

const { domainHealthView } = require('../lib/hk-domain');

(async () => {
  // ── Fitness: today tiles framed vs baseline ──
  const fit = await domainHealthView('device-XYZ-789', 'fitness', 7);
  assert.ok(fit, 'fitness view should exist');
  const steps = fit.today.find((t) => t.key === 'steps');
  assert.ok(steps, 'today should include steps');
  assert.strictEqual(steps.value, 11000, 'today steps value');
  assert.ok(steps.baseline > 6000 && steps.baseline < 11000, 'baseline sits between recent and old');
  assert.strictEqual(steps.delta_label, 'above your usual', 'steps framed above usual');
  assert.strictEqual(steps.good, true, 'more steps is good (higher-is-better)');

  const rhr = fit.today.find((t) => t.key === 'resting_hr');
  assert.strictEqual(rhr.delta_label, 'below your usual', 'rhr below usual');
  assert.strictEqual(rhr.good, true, 'lower resting HR is good (lower-is-better)');

  // ── Trend + vs-prior ──
  const stepsTrend = fit.trend.find((t) => t.key === 'steps');
  assert.ok(stepsTrend, 'steps trend present');
  assert.ok(stepsTrend.series.filter((v) => v != null).length >= 2, 'trend has ≥2 points');
  assert.ok(stepsTrend.vs_prior_label && /higher than before/.test(stepsTrend.vs_prior_label), 'steps trend higher than prior');

  // ── Anchor meta present ──
  assert.ok(fit.meta && fit.meta.effective_start_date && fit.meta.requested_days === 7, 'meta carries anchor window');

  // ── Sleep domain maps to sleep metrics ──
  const sleep = await domainHealthView('device-XYZ-789', 'sleep', 7);
  assert.ok(sleep.today.find((t) => t.key === 'sleep_hours'), 'sleep view has sleep_hours');

  // ── Parity: a domain with no underlying data → null ──
  const water = await domainHealthView('device-XYZ-789', 'water', 7);
  assert.strictEqual(water, null, 'no-data domain returns null (parity)');

  // ── COMPLIANCE: summary handed to the insight/LLM layer is de-identified ──
  const blob = JSON.stringify(capturedSummary || {});
  assert.ok(!blob.includes('device-XYZ-789'), 'summary must NOT contain the deviceId');
  assert.ok(!/deviceId|device_id/.test(blob), 'summary must NOT contain any identifier field');
  assert.strictEqual(capturedDevice, 'device-XYZ-789', 'deviceId is used only as the server-side cache key');

  console.log('✅ hk-domain-view: all assertions passed');
})().catch((e) => { console.error('❌ hk-domain-view test failed:', e.message); process.exit(1); });
