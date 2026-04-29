'use strict';
// ════════════════════════════════════════════════════════════════════
// cross-agent-tiers.js — the 5-tier intelligence cascade.
// Replaces the binary "stage<4 → nothing" gate. Every tier is active
// when its data is present.
//   Tier 1: Population priors        (n=1 OK)
//   Tier 2: Personal descriptive     (n≥2)
//   Tier 3: Pre-registered patterns  (n≥7)
//   Tier 4: Effect-size inference    (n≥14)
//   Tier 5: Statistical confirmation (n≥30)
// Independent: behavioral inference (skip patterns) — works at any n.
// ════════════════════════════════════════════════════════════════════
const { deviationHint } = require('./population-priors');

const AGENTS = ['fitness', 'sleep', 'mind', 'nutrition', 'water', 'fasting'];

const mean = (arr) => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;
const stdev = (arr) => {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
};
const round = (n, p = 2) => { const k = 10 ** p; return Math.round(n * k) / k; };

function determineTier(daysWithLog, totalLogs) {
  if (daysWithLog === 0) return 0;
  if (daysWithLog < 2 || totalLogs < 2) return 1;
  if (daysWithLog < 7) return 2;
  if (daysWithLog < 14) return 3;
  if (daysWithLog < 30) return 4;
  return 5;
}

// ─── TIER 1: PRIOR-BASED OBSERVATIONS ──────────────────────────────
function tier1Signals(ctx) {
  const out = [];
  for (const agent of AGENTS) {
    const logs = ctx.recent_logs[agent] || [];
    if (!logs.length) continue;
    const log = logs[0];
    const hint = deviationHint(agent, mapBack(agent, log), ctx.priors);
    if (hint && hint.message) {
      out.push({
        kind: 'prior_deviation',
        agent,
        magnitude: hint.magnitude,
        message: hint.message,
        cite: hint.cite || null,
        evidence: { log_ids: [log.id || log.date], confidence: 0.55 },
      });
    }
  }
  return out;
}
// Map compact log back to fields prior-deviation expects
function mapBack(agent, log) {
  switch (agent) {
    case 'sleep': return { duration_min: (log.duration_h || 0) * 60, sleep_quality: log.quality };
    case 'water': return { amount_ml: log.ml };
    case 'mind':  return { mood_score: log.mood_score };
    default: return log;
  }
}

// ─── TIER 2: PERSONAL DESCRIPTIVE ──────────────────────────────────
function tier2Signals(ctx) {
  const out = [];
  // Per-agent rolling means + delta
  for (const agent of AGENTS) {
    const logs = ctx.recent_logs[agent] || [];
    if (logs.length < 2) continue;
    const values = logs.map(l => primaryValue(agent, l)).filter(v => v != null);
    if (values.length < 2) continue;
    const recent = values.slice(0, Math.ceil(values.length / 2));
    const older  = values.slice(Math.ceil(values.length / 2));
    const mr = mean(recent), mo = mean(older);
    const delta = mr - mo;
    if (Math.abs(delta) > stdev(values) * 0.5) {
      out.push({
        kind: 'personal_trend',
        agent,
        direction: delta > 0 ? 'up' : 'down',
        delta_value: round(delta),
        n: values.length,
        message: `Your ${agent} has trended ${delta > 0 ? 'up' : 'down'} (avg shifted ${round(Math.abs(delta))} points)`,
        evidence: { agents_used: [agent], confidence: 0.5 + Math.min(0.3, values.length / 30) },
      });
    }
  }
  // Cross-agent co-occurrence
  for (const a of AGENTS) {
    for (const b of AGENTS) {
      if (a >= b) continue;
      const co = coOccurrence(ctx.recent_logs[a], ctx.recent_logs[b], a, b);
      if (co && co.n >= 2) out.push(co);
    }
  }
  return out;
}
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
function coOccurrence(logsA, logsB, a, b) {
  if (!logsA || !logsB) return null;
  const setA = new Set(logsA.map(l => l.date));
  const setB = new Set(logsB.map(l => l.date));
  const both = [...setA].filter(d => setB.has(d));
  if (both.length < 2) return null;
  // Compare avg primary values for both-logged-days vs only-A-logged days
  const inBoth_a = logsA.filter(l => setB.has(l.date)).map(l => primaryValue(a, l)).filter(v => v != null);
  const inBoth_b = logsB.filter(l => setA.has(l.date)).map(l => primaryValue(b, l)).filter(v => v != null);
  const aOnly = logsA.filter(l => !setB.has(l.date)).map(l => primaryValue(a, l)).filter(v => v != null);
  if (inBoth_a.length < 2 || aOnly.length === 0) return null;
  const lift = mean(inBoth_a) - mean(aOnly);
  if (Math.abs(lift) < stdev([...inBoth_a, ...aOnly]) * 0.3) return null;
  return {
    kind: 'co_occurrence',
    a, b, lift: round(lift), n: both.length,
    message: `On days you logged both ${a} and ${b}, your ${a} averaged ${lift > 0 ? 'higher' : 'lower'} (${both.length} days)`,
    evidence: { agents_used: [a, b], confidence: 0.45 + Math.min(0.25, both.length / 14) },
  };
}

// ─── TIER 3: PRE-REGISTERED HYPOTHESES (live status only here) ─────
function tier3Signals(ctx) {
  return (ctx.hypotheses || [])
    .filter(h => h.status === 'tracking')
    .slice(0, 3)
    .map(h => ({
      kind: 'hypothesis',
      a: h.a, b: h.b, direction: h.direction,
      n: h.last_n, r: h.last_r, status: h.status, registered_at: h.registered_at,
      message: `Watching: ${h.a} → ${h.b} (${h.direction}). r≈${h.last_r ?? '—'} at n=${h.last_n ?? '—'}.`,
      evidence: { agents_used: [h.a, h.b], confidence: Math.min(0.7, 0.4 + (h.last_n || 0) / 30) },
    }));
}

// ─── TIER 4: EFFECT SIZES (Cohen's d for paired comparisons) ───────
function tier4Signals(ctx) {
  const out = [];
  // For each pair, split A days into low/high, compare B average
  for (const a of AGENTS) {
    const logsA = ctx.recent_logs[a] || [];
    if (logsA.length < 14) continue;
    const valsA = logsA.map(l => primaryValue(a, l)).filter(v => v != null);
    if (valsA.length < 14) continue;
    const median = [...valsA].sort((x, y) => x - y)[Math.floor(valsA.length / 2)];
    for (const b of AGENTS) {
      if (a === b) continue;
      const logsB = ctx.recent_logs[b] || [];
      if (logsB.length < 7) continue;
      const byDateB = Object.fromEntries(logsB.map(l => [l.date, primaryValue(b, l)]));
      const lowB  = [], highB = [];
      for (const lA of logsA) {
        const v = primaryValue(a, lA);
        if (v == null || byDateB[lA.date] == null) continue;
        (v < median ? lowB : highB).push(byDateB[lA.date]);
      }
      if (lowB.length < 3 || highB.length < 3) continue;
      const ml = mean(lowB), mh = mean(highB);
      const sd = stdev([...lowB, ...highB]);
      if (sd === 0) continue;
      const d = (mh - ml) / sd;
      if (Math.abs(d) >= 0.4) {
        out.push({
          kind: 'effect_size',
          a, b, d: round(d),
          message: `When ${a} is high, ${b} averages ${round(mh - ml)} points ${d > 0 ? 'higher' : 'lower'} (Cohen's d=${round(d)})`,
          n: lowB.length + highB.length,
          evidence: { agents_used: [a, b], confidence: Math.min(0.85, 0.5 + Math.abs(d) / 2) },
        });
      }
    }
  }
  return out.slice(0, 4);
}

// ─── INDEPENDENT: BEHAVIORAL SIGNALS ───────────────────────────────
function behavioralSignals(ctx) {
  const out = [];
  const skips = ctx.skip_reasons || {};
  const totalSkips = Object.values(skips).reduce((s, v) => s + v, 0);
  if (totalSkips >= 3) {
    const dominant = Object.entries(skips).sort((a, b) => b[1] - a[1])[0];
    out.push({
      kind: 'behavioral_skip_pattern',
      reason: dominant[0],
      count: dominant[1],
      message: `Skipped actions: "${dominant[0]}" cited ${dominant[1]} times`,
      evidence: { confidence: 0.7 },
    });
  }
  // Setup-state opportunities
  const unsetCount = Object.values(ctx.setup_state || {}).filter(s => s === 'unset').length;
  if (unsetCount > 0 && ctx.setup_count >= 2) {
    out.push({
      kind: 'setup_opportunity',
      unset_count: unsetCount,
      message: `${unsetCount} agents not set up yet`,
      evidence: { confidence: 0.6 },
    });
  }
  return out;
}

// ─── PUBLIC: assemble all signals appropriate for the user's tier ──
function assembleSignals(ctx) {
  const tier = determineTier(ctx.days_with_any_log, ctx.total_logs);
  const signals = [];
  if (tier >= 1) signals.push(...tier1Signals(ctx));
  if (tier >= 2) signals.push(...tier2Signals(ctx));
  if (tier >= 3) signals.push(...tier3Signals(ctx));
  if (tier >= 4) signals.push(...tier4Signals(ctx));
  signals.push(...behavioralSignals(ctx));
  return { tier, signals };
}

module.exports = {
  determineTier, assembleSignals,
  tier1Signals, tier2Signals, tier3Signals, tier4Signals,
  behavioralSignals,
};
