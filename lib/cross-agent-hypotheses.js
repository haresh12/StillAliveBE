'use strict';
// ════════════════════════════════════════════════════════════════════
// cross-agent-hypotheses.js — pre-registers candidate patterns at day 7
// and tracks rolling effect-size as data accrues.
// ════════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');
const userDoc   = (id) => admin.firestore().collection('wellness_users').doc(id);
const hypoDoc   = (id) => userDoc(id).collection('wellness_meta').doc('hypotheses');

const AGENTS = ['fitness', 'sleep', 'mind', 'nutrition', 'water', 'fasting'];
const mean  = (arr) => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;
const stdev = (arr) => {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
};
const round = (n, p = 2) => { const k = 10 ** p; return Math.round(n * k) / k; };

function primaryValue(agent, log) {
  switch (agent) {
    case 'sleep': return log.duration_h != null ? log.duration_h : log.quality;
    case 'mind':  return log.mood_score;
    case 'water': return log.ml;
    case 'nutrition': return log.protein_g;
    case 'fitness':   return log.duration_min;
    case 'fasting':   return log.actual_h;
    default: return null;
  }
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 4) return null;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? null : num / denom;
}

// Pick the strongest 3-5 candidate pairs at day 7 and pre-register them
function discoverCandidates(ctx) {
  const candidates = [];
  for (const a of AGENTS) {
    const logsA = ctx.recent_logs[a] || [];
    if (logsA.length < 4) continue;
    const aBy = Object.fromEntries(logsA.map(l => [l.date, primaryValue(a, l)]));
    for (const b of AGENTS) {
      if (a >= b) continue;
      const logsB = ctx.recent_logs[b] || [];
      if (logsB.length < 4) continue;
      const bBy = Object.fromEntries(logsB.map(l => [l.date, primaryValue(b, l)]));
      const xs = [], ys = [];
      for (const d of Object.keys(aBy)) {
        if (aBy[d] != null && bBy[d] != null) {
          xs.push(aBy[d]); ys.push(bBy[d]);
        }
      }
      const r = pearson(xs, ys);
      if (r == null || isNaN(r)) continue;
      candidates.push({ a, b, r: round(r, 3), n: xs.length, direction: r > 0 ? '+' : '-' });
    }
  }
  candidates.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
  return candidates.slice(0, 5);
}

async function registerOrUpdate(deviceId, ctx) {
  const snap = await hypoDoc(deviceId).get();
  const existing = snap.exists ? (snap.data().active || []) : [];
  const today = new Date().toISOString().slice(0, 10);

  // First-time register at day 7+
  if (!existing.length && ctx.days_with_any_log >= 7) {
    const candidates = discoverCandidates(ctx);
    if (!candidates.length) return [];
    const fresh = candidates.map((c, i) => ({
      id: `h_${Date.now()}_${i}`,
      a: c.a, b: c.b, direction: c.direction,
      registered_at: today,
      n_at_register: c.n,
      last_n: c.n,
      last_r: c.r,
      rolling_r: [c.r],
      status: 'tracking',
      confirms_at_n: 30,
    }));
    await hypoDoc(deviceId).set({ active: fresh, updated_at: admin.firestore.FieldValue.serverTimestamp() });
    return fresh;
  }

  // Update existing
  if (!existing.length) return [];
  const updated = existing.map(h => {
    const logsA = ctx.recent_logs[h.a] || [];
    const logsB = ctx.recent_logs[h.b] || [];
    const aBy = Object.fromEntries(logsA.map(l => [l.date, primaryValue(h.a, l)]));
    const bBy = Object.fromEntries(logsB.map(l => [l.date, primaryValue(h.b, l)]));
    const xs = [], ys = [];
    for (const d of Object.keys(aBy)) {
      if (aBy[d] != null && bBy[d] != null) { xs.push(aBy[d]); ys.push(bBy[d]); }
    }
    const r = pearson(xs, ys);
    if (r == null || isNaN(r)) return h;
    const rolling = [...(h.rolling_r || []), round(r, 3)].slice(-30);
    let status = h.status;
    if (xs.length >= 30) {
      // Check if it held up
      if (Math.abs(r) >= 0.3) status = 'confirmed';
      else if (Math.abs(r) < 0.15) status = 'rejected';
      else status = 'inconclusive';
    }
    return { ...h, last_n: xs.length, last_r: round(r, 3), rolling_r: rolling, status };
  });
  await hypoDoc(deviceId).set({ active: updated, updated_at: admin.firestore.FieldValue.serverTimestamp() });
  return updated;
}

module.exports = { registerOrUpdate, discoverCandidates };
