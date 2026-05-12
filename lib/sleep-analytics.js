'use strict';
// ════════════════════════════════════════════════════════════════════
// sleep-analytics.js — production analytics engine for the Sleep agent.
//
// Powers /api/sleep/track-context, /analysis/v2, /actions/v2.
//
//   1. STATS         — avg quality/hours/efficiency/latency/wakings,
//                      streak, debt, wake-time variance, longest_streak.
//   2. SIGNAL        — daily {date, hours, quality, efficiency} for chart.
//   3. AHA ENGINE    — 9 sleep-only cards (1 deferred until device data).
//   4. AI READS      — 1 hero + 3 reads via OpenAI, Firestore-cached by hash.
//   5. CROSS-AGENT   — pulls last 30 mind logs for sleep × mood Pearson.
//
// Rules:
//   - Plain English everywhere. Banned: REM debt, sleep efficiency %,
//     Pearson, r=, melatonin, cortisol, polyvagal, researcher names.
//   - Severity = accent at varying opacity. ZERO red/amber/orange.
//   - max_completion_tokens only. Never max_tokens or temperature.
//   - One round-trip per tab.
// ════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
const { computeSleepScore } = require('./agent-scores');

const db        = () => admin.firestore();
const userDoc   = (id) => db().collection('wellness_users').doc(id);
const sleepDoc  = (id) => userDoc(id).collection('agents').doc('sleep');

// ─── Date helpers ───────────────────────────────────────────────────
const dateStr = (d = new Date()) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
const millis = (ts) => {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts._seconds) return ts._seconds * 1000;
  return new Date(ts).getTime() || 0;
};
const dowOf = (ds) => new Date(ds + 'T12:00:00').getDay();
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ─── Sleep math ─────────────────────────────────────────────────────
const timeToMins = (t = '00:00') => {
  const [h, m] = String(t).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};
// Minutes-from-midnight, treating bedtimes after 6pm as evening (so 23:00 = 1380, 01:00 = 1500)
const bedtimeMins = (t) => {
  const m = timeToMins(t);
  // If bedtime is between midnight and 4am, shift forward by 24h so it sorts as "after 11pm"
  return m < 240 ? m + 1440 : m;
};

// ─── Stats primitives ───────────────────────────────────────────────
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const variance = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
};
const stdev = (a) => Math.sqrt(variance(a));

function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  const mx = mean(x.slice(0, n)), my = mean(y.slice(0, n));
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx, b = y[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  const r = num / Math.sqrt(dx * dy);
  const t = r * Math.sqrt((n - 2) / Math.max(1e-9, 1 - r * r));
  const p = pFromT(Math.abs(t), n - 2) * 2;
  return { r, n, p };
}
function pFromT(t, df) {
  if (df < 1 || !Number.isFinite(t)) return 0.5;
  const x = df / (df + t * t);
  return 0.5 * incompleteBeta(df / 2, 0.5, x);
}
function incompleteBeta(a, b, x) {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const lbeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;
  let f = 1, c = 1, d = 0;
  for (let m = 0; m <= 200; m++) {
    let numer;
    if (m === 0) numer = 1;
    else if (m % 2 === 0) { const k = m / 2; numer = (k * (b - k) * x) / ((a + 2 * k - 1) * (a + 2 * k)); }
    else { const k = (m - 1) / 2; numer = -((a + k) * (a + b + k) * x) / ((a + 2 * k) * (a + 2 * k + 1)); }
    d = 1 + numer * d; if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + numer / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const delta = d * c; f *= delta;
    if (Math.abs(delta - 1) < 1e-8) break;
  }
  return front * (f - 1);
}
function lnGamma(z) {
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
             771.32342877765313, -176.61502916214059, 12.507343278686905,
             -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

// ─── Period filter ──────────────────────────────────────────────────
function filterPeriod(logs, days) {
  if (!days) return logs;
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  const cutoffStr = dateStr(cutoff);
  return logs.filter(l => (l.date_str || dateStr(millis(l.logged_at))) >= cutoffStr);
}

// ─── Streak (with 1-day grace) ──────────────────────────────────────
function computeStreak(logs) {
  if (!logs.length) return { streak: 0, grace_used: false };
  const dates = [...new Set(logs.map(l => l.date_str).filter(Boolean))].sort().reverse();
  let streak = 0, graceUsed = false;
  for (let i = 0; i < dates.length; i++) {
    const expected = dateStr(new Date(Date.now() - i * 86400000));
    if (dates[i] === expected) { streak++; continue; }
    if (!graceUsed && i > 0) {
      const next = dateStr(new Date(Date.now() - (i + 1) * 86400000));
      if (dates[i] === next) { graceUsed = true; streak++; continue; }
    }
    break;
  }
  return { streak, grace_used: graceUsed };
}

// ─── Period stats ───────────────────────────────────────────────────
function computeStats(logs, targetHours = 8) {
  if (!logs.length) return {
    total_logs: 0, days_with_logs: 0,
    avg_hours: 0, avg_quality: 0, avg_efficiency: 0, avg_latency: 0,
    streak: 0, longest_streak: 0,
    debt_hours_7d: 0,
    wake_variance_min: 0, bed_variance_min: 0,
  };
  const hours = logs.map(l => Number(l.total_sleep_hours || l.duration_hours || 0)).filter(Boolean);
  const qual  = logs.map(l => Number(l.sleep_quality || 3));
  const eff   = logs.map(l => Number(l.sleep_efficiency || 0)).filter(Boolean);
  const lat   = logs.map(l => Number(l.sleep_latency || 0));
  const dates = [...new Set(logs.map(l => l.date_str).filter(Boolean))];
  const stk   = computeStreak(logs);

  // Wake & bed variance from time strings
  const wakes = logs.map(l => l.wake_time ? timeToMins(l.wake_time) : null).filter(x => x != null);
  const beds  = logs.map(l => l.bedtime ? bedtimeMins(l.bedtime) : null).filter(x => x != null);

  // Sleep debt — last 7 logs, sum of (target − hours), floored at 0 per night
  const last7 = logs.slice(0, 7);
  const debt  = last7.reduce((s, l) => s + Math.max(0, targetHours - Number(l.total_sleep_hours || 0)), 0);

  return {
    total_logs:        logs.length,
    days_with_logs:    dates.length,
    avg_hours:         Math.round(mean(hours) * 10) / 10,
    avg_quality:       Math.round(mean(qual) * 10) / 10,
    avg_efficiency:    Math.round(mean(eff)),
    avg_latency:       Math.round(mean(lat)),
    streak:            stk.streak,
    grace_used:        stk.grace_used,
    longest_streak:    stk.streak,
    debt_hours_7d:     Math.round(debt * 10) / 10,
    wake_variance_min: Math.round(stdev(wakes)),
    bed_variance_min:  Math.round(stdev(beds)),
  };
}

// ─── Signal: per-night chart data ───────────────────────────────────
function buildSignal(logs) {
  if (!logs.length) return [];
  const sorted = [...logs].sort((a, b) =>
    (a.date_str || '').localeCompare(b.date_str || ''));
  return sorted.map(l => ({
    date:       l.date_str,
    label:      l.date_str ? new Date(l.date_str + 'T12:00:00').toLocaleDateString('en', { month: 'short', day: 'numeric' }) : '',
    hours:      Number(l.total_sleep_hours || 0),
    quality:    Number(l.sleep_quality || 3),
    efficiency: Number(l.sleep_efficiency || 0),
  }));
}

// ─── Daily map for calendar (quality-shade per day) ─────────────────
function buildDailyLogs(logs) {
  const out = {};
  for (const l of logs) {
    const ds = l.date_str;
    if (!ds) continue;
    const q = Number(l.sleep_quality || 3);
    const h = Number(l.total_sleep_hours || 0);
    if (!out[ds]) {
      out[ds] = { has_log: true, quality: q, hours: h, count: 1 };
    } else {
      out[ds].count++;
      out[ds].quality = Math.round(((out[ds].quality + q) / 2) * 10) / 10;
      out[ds].hours = Math.round(((out[ds].hours + h) / 2) * 10) / 10;
    }
  }
  return out;
}

// ─── Top disruptors ─────────────────────────────────────────────────
function topDisruptors(logs, n = 6) {
  const bucket = {};
  for (const l of logs) {
    const q = Number(l.sleep_quality || 3);
    const h = Number(l.total_sleep_hours || 0);
    for (const d of (l.disruptors || [])) {
      if (!bucket[d]) bucket[d] = { quals: [], hours: [] };
      bucket[d].quals.push(q);
      bucket[d].hours.push(h);
    }
  }
  const total = logs.length || 1;
  return Object.entries(bucket)
    .map(([disruptor, v]) => ({
      disruptor,
      count: v.quals.length,
      avg_quality: Math.round(mean(v.quals) * 10) / 10,
      avg_hours:   Math.round(mean(v.hours) * 10) / 10,
      share_pct:   Math.round((v.quals.length / total) * 100),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

// ─── AHA #1: weekend drift ──────────────────────────────────────────
function computeWeekendDrift(logs) {
  const wkBeds = [], wendBeds = [];
  for (const l of logs) {
    if (!l.bedtime || !l.date_str) continue;
    const dow = dowOf(l.date_str);
    const m = bedtimeMins(l.bedtime);
    if (dow === 0 || dow === 6) wendBeds.push(m); else wkBeds.push(m);
  }
  if (wkBeds.length < 3 || wendBeds.length < 2) return null;
  const driftMin = Math.round(mean(wendBeds) - mean(wkBeds));
  return Math.abs(driftMin) >= 30 ? { drift_minutes: driftMin } : null;
}

// ─── AHA #2: best-night formula ─────────────────────────────────────
// Find shared features in top-decile nights vs others
function computeBestNightFormula(logs) {
  if (logs.length < 10) return null;
  const sorted = [...logs].sort((a, b) => Number(b.sleep_quality || 0) - Number(a.sleep_quality || 0));
  const top = sorted.slice(0, Math.max(3, Math.floor(sorted.length * 0.2)));
  const rest = sorted.slice(Math.max(3, Math.floor(sorted.length * 0.2)));
  if (top.length < 3 || rest.length < 3) return null;

  const features = [];
  // Hours feature
  const topHrs = mean(top.map(l => Number(l.total_sleep_hours || 0)));
  const restHrs = mean(rest.map(l => Number(l.total_sleep_hours || 0)));
  if (topHrs - restHrs >= 0.5) features.push(`${Math.round(topHrs * 10) / 10}+ hours`);

  // Bedtime feature — earlier on best nights?
  const topBeds = top.map(l => l.bedtime).filter(Boolean).map(bedtimeMins);
  const restBeds = rest.map(l => l.bedtime).filter(Boolean).map(bedtimeMins);
  if (topBeds.length >= 3 && restBeds.length >= 3) {
    const delta = mean(restBeds) - mean(topBeds);
    if (delta >= 30) features.push('earlier bedtime');
  }

  // Latency feature
  const topLat = mean(top.map(l => Number(l.sleep_latency || 0)));
  const restLat = mean(rest.map(l => Number(l.sleep_latency || 0)));
  if (restLat - topLat >= 5) features.push('falling asleep faster');

  // Disruptor absence — which disruptors appear less in top nights?
  const restDisruptors = {};
  for (const l of rest) for (const d of (l.disruptors || [])) restDisruptors[d] = (restDisruptors[d] || 0) + 1;
  const topDisruptors = {};
  for (const l of top) for (const d of (l.disruptors || [])) topDisruptors[d] = (topDisruptors[d] || 0) + 1;
  const cleanestAbsence = Object.entries(restDisruptors)
    .filter(([d]) => (topDisruptors[d] || 0) <= top.length * 0.2)
    .sort(([, a], [, b]) => b - a)[0];
  if (cleanestAbsence) features.push(`no ${cleanestAbsence[0].toLowerCase()}`);

  return features.length >= 2 ? { features: features.slice(0, 3) } : null;
}

// ─── AHA #3: latency trend (30d delta) ──────────────────────────────
function computeLatencyTrend(allLogs) {
  if (allLogs.length < 10) return null;
  const now = Date.now();
  const cutoff30 = now - 30 * 86400000;
  const cutoff60 = now - 60 * 86400000;
  const recent = [], prior = [];
  for (const l of allLogs) {
    const t = millis(l.logged_at);
    const lat = Number(l.sleep_latency || 0);
    if (t > cutoff30) recent.push(lat);
    else if (t > cutoff60) prior.push(lat);
  }
  if (recent.length < 5 || prior.length < 5) return null;
  const delta = Math.round(mean(recent) - mean(prior));
  return Math.abs(delta) >= 3 ? { delta_min: delta, recent_avg: Math.round(mean(recent)), prior_avg: Math.round(mean(prior)) } : null;
}

// ─── (sleep × mood causal moved to cross-agent engine — single agents
//     never read sibling-agent data. The Insights/Home tab surfaces it.) ──

// ─── AHA #5: caffeine × bad nights ──────────────────────────────────
function computeCaffeinePattern(logs) {
  const cafLogs = logs.filter(l => (l.disruptors || []).some(d => /caffeine|coffee/i.test(d)));
  const nonLogs = logs.filter(l => !(l.disruptors || []).some(d => /caffeine|coffee/i.test(d)));
  if (cafLogs.length < 3 || nonLogs.length < 3) return null;
  const cafQ = mean(cafLogs.map(l => Number(l.sleep_quality || 3)));
  const nonQ = mean(nonLogs.map(l => Number(l.sleep_quality || 3)));
  if (nonQ - cafQ < 0.4) return null;
  return {
    caf_nights: cafLogs.length,
    caf_avg_quality: Math.round(cafQ * 10) / 10,
    non_avg_quality: Math.round(nonQ * 10) / 10,
    quality_drop: Math.round((nonQ - cafQ) * 10) / 10,
  };
}

// ─── AHA #6: REM cycle estimate ─────────────────────────────────────
function computeRemEstimate(latestLog) {
  if (!latestLog) return null;
  const totalMin = Number(latestLog.total_sleep_hours || 0) * 60;
  if (totalMin < 90) return null;
  const cycles = Math.floor(totalMin / 90);
  return { cycles, full: cycles >= 4 };
}

// ─── AHA #7: best/worst day, volatility ─────────────────────────────
function bestNight(signal) {
  if (!signal.length) return null;
  const best = signal.reduce((a, b) => b.quality > a.quality ? b : a);
  return { date: best.date, label: best.label, quality: best.quality, hours: best.hours };
}
function worstNight(signal) {
  if (!signal.length) return null;
  const worst = signal.reduce((a, b) => b.quality < a.quality ? b : a);
  return { date: worst.date, label: worst.label, quality: worst.quality, hours: worst.hours };
}
function volatilityPct(signal) {
  if (signal.length < 2) return 0;
  const qs = signal.map(s => s.quality);
  const sd = stdev(qs);
  return Math.round((sd / 5) * 100);
}

// ─── Hour-of-bed peak ribbon (24-hour bedtime distribution) ─────────
function computeBedtimeRibbon(logs) {
  const buckets = Array(24).fill(null).map(() => ({ hours: [], qualities: [] }));
  for (const l of logs) {
    if (!l.bedtime) continue;
    const h = Number(String(l.bedtime).split(':')[0] || 0);
    if (h < 0 || h > 23) continue;
    buckets[h].hours.push(Number(l.total_sleep_hours || 0));
    buckets[h].qualities.push(Number(l.sleep_quality || 3));
  }
  const result = {};
  for (let h = 0; h < 24; h++) {
    if (buckets[h].hours.length) {
      result[h] = {
        avg_hours:   Math.round(mean(buckets[h].hours) * 10) / 10,
        avg_quality: Math.round(mean(buckets[h].qualities) * 10) / 10,
        count:       buckets[h].hours.length,
      };
    }
  }
  return result;
}

// ════════════════════════════════════════════════════════════════════
// AHA ENGINE — assembles up to 5 ranked aha_moments from candidates
// ════════════════════════════════════════════════════════════════════
function buildAhaMoments({ stats, weekendDrift, bestFormula, latencyTrend, caffeine, remEst, bestN, worstN }) {
  const ahas = [];

  // (Sleep × mood causal lives in the cross-agent engine — Insights tab surfaces it.)

  // Caffeine pattern
  if (caffeine) {
    ahas.push({
      key:  'caffeine_pattern',
      label:'CAFFEINE NIGHTS',
      kpi:  `Quality ${caffeine.quality_drop} lower`,
      body: `Nights with caffeine flagged as a disruptor average ${caffeine.caf_avg_quality}/5 quality vs ${caffeine.non_avg_quality}/5 on caffeine-free nights.`,
      score: 90,
    });
  }

  // Wake-time consistency
  if (stats.wake_variance_min > 30 && stats.days_with_logs >= 5) {
    ahas.push({
      key:  'wake_consistency',
      label:'WAKE TIME',
      kpi:  `${stats.wake_variance_min} min spread`,
      body: `Your wake time bounces around. A steady wake time is the strongest sleep lever you have.`,
      score: 85,
    });
  }

  // Sleep debt
  if (stats.debt_hours_7d >= 4) {
    ahas.push({
      key:  'sleep_debt',
      label:'SLEEP DEBT',
      kpi:  `${stats.debt_hours_7d}h banked`,
      body: `You're carrying ${stats.debt_hours_7d} hours of sleep debt from the last week. One full night usually clears half of that.`,
      score: 82,
    });
  }

  // Weekend drift
  if (weekendDrift) {
    const dir = weekendDrift.drift_minutes > 0 ? 'later' : 'earlier';
    ahas.push({
      key:  'weekend_drift',
      label:'WEEKEND DRIFT',
      kpi:  `${Math.abs(weekendDrift.drift_minutes)} min ${dir}`,
      body: `Your weekend bedtime drifts ${Math.abs(weekendDrift.drift_minutes)} minutes ${dir} than weekdays. That pulls Monday energy down.`,
      score: 78,
    });
  }

  // Best-night formula
  if (bestFormula) {
    ahas.push({
      key:  'best_formula',
      label:'YOUR BEST NIGHTS',
      kpi:  bestFormula.features.join(' + '),
      body: `Your best nights all share these — recreate the pattern when you can.`,
      score: 76,
    });
  }

  // Latency trend
  if (latencyTrend) {
    const dir = latencyTrend.delta_min > 0 ? 'longer' : 'shorter';
    ahas.push({
      key:  'latency_trend',
      label:'FALLING ASLEEP',
      kpi:  `${Math.abs(latencyTrend.delta_min)} min ${dir}`,
      body: `You're taking ${Math.abs(latencyTrend.delta_min)} minutes ${dir} to fall asleep this month than last.`,
      score: 72,
    });
  }

  // REM cycle estimate
  if (remEst && remEst.full) {
    ahas.push({
      key:  'rem_cycles',
      label:'CYCLES',
      kpi:  `${remEst.cycles} full`,
      body: `Your last night gave you about ${remEst.cycles} complete sleep cycles before waking.`,
      score: 60,
    });
  }

  // Best vs worst night swing
  if (bestN && worstN && bestN.quality - worstN.quality >= 2) {
    ahas.push({
      key:  'volatility',
      label:'GOOD VS HARD NIGHTS',
      kpi:  `${bestN.label} → ${worstN.label}`,
      body: `Your best night was ${bestN.quality}/5 (${bestN.hours}h) and your hardest was ${worstN.quality}/5. Steady habits help more than perfect nights.`,
      score: 58,
    });
  }

  return ahas.sort((a, b) => b.score - a.score).slice(0, 5);
}

// ════════════════════════════════════════════════════════════════════
// AI prompts (cached, plain English)
// ════════════════════════════════════════════════════════════════════
const SLEEP_HERO_SYSTEM = `You are a warm, plain-spoken sleep coach. Write the ONE-sentence opening insight on a sleep app's Insights tab. ONE sentence that makes the user feel "this is exactly what's going on with my sleep."

PLAIN ENGLISH RULES — NON-NEGOTIABLE:
- Use everyday words. NEVER: "REM debt", "sleep efficiency %", "Pearson", "r=", "n=", "p<", "circadian phase", "cortisol", "melatonin", "polyvagal", "homeostatic", any researcher names.
- Reflect a real number from the data — don't guess.
- Calm, kind tone. No alarm. No exclamation marks.
- If thin data (<5 logs): "Still learning your rhythm — keep logging."
- Output JSON only: {"headline":"..."} — single sentence, max 110 chars.

GOOD EXAMPLES:
- {"headline":"Your wake time bounces 47 min — your steadiest week is your best lever."}
- {"headline":"Caffeine-flagged nights drop quality by half a point. The pattern is clear."}
- {"headline":"Last week you banked 4.2 hours of sleep debt. One full night clears most of it."}
- {"headline":"You took 8 fewer minutes to fall asleep this month. Something's working."}`;

const SLEEP_AI_READS_SYSTEM = `You are a warm, plain-spoken sleep coach writing the "What I'm seeing" section. The user has logged sleep, quality, latency, wakings, energy, and disruptors. Produce exactly THREE distinct reads.

EACH READ:
- kind: "champion" (working) | "drag" (slowing them) | "pattern" (neutral observation)
- title: 6-10 words, plain English
- body: 14-22 words, references one concrete number
- action: 6-10 words, ONE small step (skip if none obvious)

PLAIN ENGLISH RULES — NON-NEGOTIABLE:
- NEVER use jargon: "REM debt", "sleep efficiency %", "Pearson", "r=", "circadian", "cortisol", "polyvagal", researcher names.
- Talk like a friend, not a textbook.
- Output JSON only: {"reads":[{kind,title,body,action}, ...]}

GOOD EXAMPLES:
{"kind":"champion","title":"Your bedtime tightened up this week","body":"Your bedtime swung 12 minutes vs 47 last week. That's the consistency win we've been after.","action":"Lock the same bedtime tonight."}
{"kind":"drag","title":"Caffeine nights drop quality 0.6 points","body":"On nights when caffeine showed up as a disruptor, quality averages 2.7 vs 3.3. Cut-off by 2pm helps.","action":"No coffee after 2pm this week."}
{"kind":"pattern","title":"You sleep an hour more on weekends","body":"Weekend nights average 8.2h vs 7.1h on weekdays. That's recovery sleep — your body is telling you something.","action":"Add 30 min to weekday bedtime."}`;

const SLEEP_COACH_SYSTEM = `You are the user's sleep coach — warm, brief, specific, never clinical. The user is opening the chat inside an app where you can see their last 7 nights of data: hours, quality, bedtime, wake time, latency, wakings, disruptors, notes.

RULES:
- Reflect first, then respond. One short reflection sentence before any advice.
- Cite their data plainly. Never "circadian", "REM debt", "sleep efficiency %", "cortisol", "melatonin".
- Never diagnose. No disorder names ("insomnia", "sleep apnea", "DSPS").
- 2-4 short sentences max. No bullets. No emoji.
- If message contains crisis keywords (suicide, end it, self-harm) → respond ONLY with: "I hear how heavy this is. You don't have to carry it alone — please reach out to 988 (US) or Samaritans (UK 116 123) right now. I'll be here when you're ready to talk."
- Never use "should" or "just".

EXAMPLES:
user: "Why am I waking up so tired?"
you: "Your last 5 nights averaged 6h 12m — that's about an hour under your usual. Mornings will feel rough until that catches up. Tonight try a 30-min earlier bedtime; we'll see if morning energy ticks up."

user: "I can't fall asleep."
you: "Your latency has been climbing — 22 minutes last night, 18 the night before. That often means a busy mind. A 5-minute slow breath before lights-out reliably cuts that for most people. Want to try?"`;

const SLEEP_ACTIONS_SYSTEM = `You are the user's sleep coach writing a 3-night plan. Output 1-3 specific actions.

EACH ACTION:
- title (6-9 words, action verb first)
- why (12-18 words, references one specific data point in plain words)
- how (10-16 words, one small step doable today)
- when (cadence: "tonight", "every evening this week", etc.)
- proof (10-14 words: how user knows it's working)
- archetype: caffeine_cutoff | evening_dim | consistent_wake | screen_off_60 | cool_room | morning_light | nap_short | alcohol_skip | meal_cutoff | wind_down_5 | journal_brain_dump | log_session
- target_count (1-7)

PLAIN ENGLISH RULES — NON-NEGOTIABLE:
- No clinical labels. No researcher names. No "circadian", "REM", "polyvagal", "homeostatic".
- Each action must be doable today.
- Output JSON only: {"actions":[{title,why,how,when,proof,archetype,target_count}]}

EXAMPLE:
{"actions":[
{"title":"No coffee after 2pm this week","why":"Your bad nights cluster on caffeine-flagged days.","how":"Set a 2pm phone alarm. Switch to water/herbal after.","when":"Every day for 5 days","proof":"Your next 5 quality logs should average 3.5+","archetype":"caffeine_cutoff","target_count":5},
{"title":"Lock a single wake time","why":"Your wake bounces 47 min — that's your biggest unsteady lever.","how":"Pick 6:45am. Same time every day, including weekends.","when":"Daily for 7 days","proof":"Your wake variance drops below 20 min","archetype":"consistent_wake","target_count":7}
]}`;

const SLEEP_FORECAST_SYSTEM = `You forecast tonight's sleep score (0-100) based on today's signals. Inputs include: today's caffeine count, alcohol, late meal, workout intensity, mood, anxiety, last 3 nights' average quality.

Output JSON only: {"score": <int>, "headline": "..." (max 80 chars, plain English)}

RULES:
- No jargon, no formulas in the headline.
- Score reflects: heavy caffeine after 2pm = -5 to -10; alcohol = -8; late meal = -5; high workout = +3; high anxiety = -8; ≥7h target last 3 nights = +5.

EXAMPLE:
{"score":68,"headline":"Tonight may be choppy — late coffee and high anxiety stack against you."}`;

// ─── Cache key + AI helpers ─────────────────────────────────────────
function contentHash(obj) {
  const s = JSON.stringify(obj);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

async function getOrGenAiHero(deviceId, openai, statsPayload) {
  const hash = contentHash({
    n: statsPayload.total_logs, d: statsPayload.days_with_logs,
    h: statsPayload.avg_hours, q: statsPayload.avg_quality,
    s: statsPayload.streak,
  });
  const cacheRef = sleepDoc(deviceId).collection('cache').doc('hero_insight_v2');
  try {
    const snap = await cacheRef.get();
    if (snap.exists && snap.data().hash === hash) return snap.data().insight;
  } catch { /* non-fatal */ }
  if (statsPayload.total_logs < 1) return null;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      max_completion_tokens: 220,
      messages: [
        { role: 'system', content: SLEEP_HERO_SYSTEM },
        { role: 'user',   content: JSON.stringify(statsPayload) },
      ],
    });
    const parsed = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
    const insight = parsed?.headline || null;
    if (insight) cacheRef.set({ hash, insight, generated_at: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
    return insight;
  } catch (err) {
    log.warn('[sleep-analytics] hero LLM failed:', err.message);
    return null;
  }
}

async function getOrGenAiReads(deviceId, openai, payload) {
  const hash = contentHash({
    n: payload.total_logs, q: payload.avg_quality, h: payload.avg_hours,
    debt: payload.debt_hours_7d, wakeVar: payload.wake_variance_min,
    drift: payload.weekend_drift,
  });
  const cacheRef = sleepDoc(deviceId).collection('cache').doc('ai_reads_v2');
  try {
    const snap = await cacheRef.get();
    if (snap.exists && snap.data().hash === hash) return snap.data().reads;
  } catch { /* non-fatal */ }
  if (payload.total_logs < 3) return [];

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      max_completion_tokens: 700,
      messages: [
        { role: 'system', content: SLEEP_AI_READS_SYSTEM },
        { role: 'user',   content: JSON.stringify(payload) },
      ],
    });
    const parsed = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
    const reads = Array.isArray(parsed?.reads) ? parsed.reads.slice(0, 3) : [];
    if (reads.length) cacheRef.set({ hash, reads, generated_at: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
    return reads;
  } catch (err) {
    log.warn('[sleep-analytics] reads LLM failed:', err.message);
    return [];
  }
}

// ════════════════════════════════════════════════════════════════════
// PUBLIC: loadAnalysisV2(deviceId, periodDays, { openai, targetHours })
// ════════════════════════════════════════════════════════════════════
async function loadAnalysisV2(deviceId, periodDays, { openai, targetHours = 8 } = {}) {
  if (!deviceId) return null;

  const logsCol = sleepDoc(deviceId).collection('sleep_logs');
  const [sleepSnap, allSnap] = await Promise.all([
    sleepDoc(deviceId).get(),
    logsCol.orderBy('logged_at', 'desc').limit(180).get(),
  ]);

  const allLogs = allSnap.docs.map(d => ({
    id: d.id,
    ...d.data(),
    logged_at: d.data().logged_at?.toDate?.() || new Date(),
  }));

  if (allLogs.length === 0) {
    return {
      stage: 0, period_days: periodDays || null,
      stats: { total_logs: 0, days_with_logs: 0 },
      signal_points: [], daily_logs: {},
      ai_reads: [], aha_moments: [], hero_insight: null,
      top_disruptors: [], best_night: null, worst_night: null,
      sleep_score: null, score_grade: null,
      setup: sleepSnap.exists ? sleepSnap.data() : {},
    };
  }

  const periodLogs = filterPeriod(allLogs, periodDays);
  const allTimeStats  = computeStats(allLogs, targetHours);
  const periodStats   = periodLogs.length ? computeStats(periodLogs, targetHours) : { ...computeStats([], targetHours), longest_streak: allTimeStats.streak };
  const signal = buildSignal(periodLogs);
  const daily  = buildDailyLogs(periodLogs.length ? periodLogs : allLogs);
  const disruptors = topDisruptors(periodLogs.length ? periodLogs : allLogs);
  const weekendDrift = computeWeekendDrift(allLogs);
  const bestFormula  = computeBestNightFormula(allLogs);
  const latencyTrend = computeLatencyTrend(allLogs);
  const caffeine     = computeCaffeinePattern(allLogs);
  const remEst       = computeRemEstimate(allLogs[0]);
  const bestN        = bestNight(signal);
  const worstN       = worstNight(signal);
  const volatility   = volatilityPct(signal);
  const bedtimeRibbon = computeBedtimeRibbon(periodLogs.length ? periodLogs : allLogs);

  const ahas = buildAhaMoments({
    stats: allTimeStats, weekendDrift, bestFormula, latencyTrend,
    caffeine, remEst, bestN, worstN,
  });

  // Score (cross-agent aware via existing computeSleepScore helper if present)
  let sleepScore = null;
  try {
    sleepScore = computeSleepScore({
      avg_quality:    allTimeStats.avg_quality,
      avg_duration:   allTimeStats.avg_hours,
      avg_efficiency: allTimeStats.avg_efficiency,
      avg_latency:    allTimeStats.avg_latency,
      days_logged:    allTimeStats.days_with_logs,
      sleep_debt:     allTimeStats.debt_hours_7d,
      target_hours:   targetHours,
    });
  } catch { /* non-fatal */ }

  const grade = (() => {
    if (!sleepScore) return null;
    const s = sleepScore.score;
    if (s >= 85) return { letter: 'A', band: 'Steady' };
    if (s >= 75) return { letter: 'B', band: 'Healthy' };
    if (s >= 60) return { letter: 'C', band: 'Active' };
    if (s >= 45) return { letter: 'D', band: 'Choppy' };
    return { letter: 'E', band: 'Building' };
  })();

  // AI hero + reads
  const heroPayload = {
    total_logs:        periodStats.total_logs,
    days_with_logs:    periodStats.days_with_logs,
    avg_hours:         periodStats.avg_hours,
    avg_quality:       periodStats.avg_quality,
    streak:            allTimeStats.streak,
    debt_hours_7d:     allTimeStats.debt_hours_7d,
    wake_variance_min: allTimeStats.wake_variance_min,
  };
  const readsPayload = {
    ...heroPayload,
    weekend_drift: weekendDrift,
    caffeine:      caffeine,
    best_formula:  bestFormula,
    latency_trend: latencyTrend,
    top_disruptors: disruptors,
  };

  let heroInsight = null, aiReads = [];
  if (openai && periodStats.total_logs >= 1) {
    [heroInsight, aiReads] = await Promise.all([
      getOrGenAiHero(deviceId, openai, heroPayload),
      getOrGenAiReads(deviceId, openai, readsPayload),
    ]);
  }

  return {
    stage:            allLogs.length >= 30 ? 3 : allLogs.length >= 7 ? 2 : 1,
    period_days:      periodDays || null,
    stats:            periodStats,
    all_time_total:   allLogs.length,
    sleep_score:      sleepScore,
    score_grade:      grade,
    hero_insight:     heroInsight ? { headline: heroInsight } : null,
    signal_points:    signal,
    daily_logs:       daily,
    bedtime_ribbon:   bedtimeRibbon,
    weekend_drift:    weekendDrift,
    best_formula:     bestFormula,
    latency_trend:    latencyTrend,
    caffeine_pattern: caffeine,
    rem_estimate:     remEst,
    top_disruptors:   disruptors,
    best_night:       bestN,
    worst_night:      worstN,
    volatility_pct:   volatility,
    ai_reads:         aiReads,
    aha_moments:      ahas,
    setup:            sleepSnap.exists ? sleepSnap.data() : {},
  };
}

// ════════════════════════════════════════════════════════════════════
// TRACK CONTEXT — single payload for the Track tab on mount
// ════════════════════════════════════════════════════════════════════

// Smart defaults — use setup answers as the floor, refine with log medians as data accrues.
function getDefaultsForUser(allLogs, setup = {}) {
  // Setup values are the base — first thing user sees on Track is THEIR target schedule.
  const setupBed   = setup.target_bedtime  || '23:00';
  const setupWake  = setup.target_wake_time || '07:00';
  const setupHours = Number(setup.target_hours || 7.5);
  const setupDisruptors = (setup.disruptors || []);

  if (!allLogs.length) {
    // New user: pure setup values pre-filled
    return {
      default_bedtime:  setupBed,
      default_wake_time: setupWake,
      default_hours:    setupHours,
      default_quality:  4,
      top_disruptor:    setupDisruptors[0] || null,
      source:           'setup',
    };
  }

  // Existing user: median of last 14 logs but blend setup as fallback when sparse.
  const last14 = allLogs.slice(0, 14);
  const beds  = last14.map(l => l.bedtime).filter(Boolean).sort();
  const wakes = last14.map(l => l.wake_time).filter(Boolean).sort();
  const hrs   = last14.map(l => Number(l.total_sleep_hours || 0)).filter(x => x > 0);
  const median = (arr) => arr.length ? arr[Math.floor(arr.length / 2)] : null;
  const lastQuality = Number(last14[0]?.sleep_quality || 4);

  // Disruptors: combine recent log frequency + setup-flagged disruptors (setup wins ties)
  const dCounts = {};
  for (const l of last14) for (const d of (l.disruptors || [])) dCounts[d] = (dCounts[d] || 0) + 1;
  for (const d of setupDisruptors) dCounts[d] = (dCounts[d] || 0) + 0.5;  // setup as tiebreaker
  const topD = Object.entries(dCounts).sort(([, a], [, b]) => b - a)[0];

  return {
    default_bedtime:   median(beds)  || setupBed,
    default_wake_time: median(wakes) || setupWake,
    default_hours:     hrs.length ? Math.round(mean(hrs) * 10) / 10 : setupHours,
    default_quality:   lastQuality,
    top_disruptor:     topD ? topD[0] : (setupDisruptors[0] || null),
    source:            last14.length >= 7 ? 'logs' : 'blended',
  };
}

function buildContextNudge(allLogs, stats, setup = {}) {
  const now = new Date();
  const hour = now.getHours();

  // New-user nudge: anchor to the primary problem they just told us about
  if (allLogs.length === 0 && setup.primary_problem) {
    const problemMsg = {
      'Trouble falling asleep':       "Your focus: trouble falling asleep. Tonight, log one thing — we'll start spotting your latency pattern.",
      'Waking up through the night':  "Your focus: night wakings. Logging the disruptor each night is how the pattern surfaces.",
      'Early morning waking':         "Your focus: early waking. Wake-time consistency is your biggest lever — let's track it.",
      'Light or unrestorative sleep': "Your focus: unrestorative sleep. Quality and morning energy will tell us more than hours alone.",
      'Inconsistent sleep schedule':  "Your focus: schedule consistency. Same wake time daily is the strongest sleep lever you have.",
      'Racing mind at bedtime':       "Your focus: racing mind at bedtime. A 5-minute wind-down breath is the smallest dose that helps.",
    }[setup.primary_problem];
    if (problemMsg) return { type: 'first_log', message: problemMsg };
  }

  // Wind-down nudge — between 9 and 11pm, anchored to user's target bedtime
  if (hour >= 21 && hour <= 23 && stats.avg_hours && stats.avg_hours < (Number(setup.target_hours) || 7)) {
    const targetBed = setup.target_bedtime || '23:00';
    return {
      type: 'wind_down',
      message: `Wind-down hour. You averaged ${stats.avg_hours}h last week — try heading up by ${targetBed}.`,
    };
  }

  // Drift nudge
  if (stats.bed_variance_min >= 60) {
    const targetBed = setup.target_bedtime || '11pm';
    return {
      type: 'drift',
      message: `Your bedtime swings ${stats.bed_variance_min} minutes. Lock ${targetBed} for a few nights.`,
    };
  }

  // Debt nudge
  if (stats.debt_hours_7d >= 4) {
    return {
      type: 'debt',
      message: `You've banked ${stats.debt_hours_7d}h of sleep debt. One full night usually clears half.`,
    };
  }

  return null;
}

function buildCalendarDots(logs) {
  const dots = {};
  const cutoff = Date.now() - 60 * 86400000;
  for (const l of logs) {
    if (millis(l.logged_at) < cutoff) continue;
    if (!l.date_str) continue;
    const q = Number(l.sleep_quality || 3);
    if (!dots[l.date_str] || q > dots[l.date_str]) dots[l.date_str] = q;
  }
  return dots;
}

async function loadTrackContext(deviceId, { targetHours = 8 } = {}) {
  if (!deviceId) return null;
  const logsCol = sleepDoc(deviceId).collection('sleep_logs');
  const [snap, setupSnap] = await Promise.all([
    logsCol.orderBy('logged_at', 'desc').limit(150).get(),
    sleepDoc(deviceId).get(),
  ]);
  const setup = setupSnap.exists ? setupSnap.data() : {};

  const allLogs = snap.docs.map(d => ({
    id: d.id,
    ...d.data(),
    logged_at: d.data().logged_at?.toDate?.() || new Date(),
  }));

  const today = dateStr();
  const lastNight = allLogs[0] ? {
    id:               allLogs[0].id,
    date_str:         allLogs[0].date_str,
    bedtime:          allLogs[0].bedtime,
    wake_time:        allLogs[0].wake_time,
    total_sleep_hours: Number(allLogs[0].total_sleep_hours || 0),
    sleep_quality:    Number(allLogs[0].sleep_quality || 3),
    morning_energy:   Number(allLogs[0].morning_energy || 3),
    sleep_efficiency: Number(allLogs[0].sleep_efficiency || 0),
    disruptors:       allLogs[0].disruptors || [],
  } : null;

  const stats    = computeStats(allLogs, targetHours);
  const defaults = getDefaultsForUser(allLogs, setup);
  const nudge    = buildContextNudge(allLogs, stats, setup);
  const dots     = buildCalendarDots(allLogs);

  return {
    last_night:     lastNight,
    has_log_today:  allLogs[0]?.date_str === today,
    smart_defaults: defaults,
    context_nudge:  nudge,
    streak:         stats.streak,
    grace_used:     stats.grace_used,
    calendar_dots:  dots,
    total_logs:     allLogs.length,
    avg_hours:      stats.avg_hours,
    debt_hours_7d:  stats.debt_hours_7d,
    // Setup snapshot for FE personalization (target schedule, primary problem, chronotype)
    setup: {
      primary_problem:     setup.primary_problem || null,
      target_bedtime:      setup.target_bedtime || null,
      target_wake_time:    setup.target_wake_time || null,
      target_hours:        Number(setup.target_hours || 7.5),
      chronotype:          setup.chronotype || null,
      disruptors:          setup.disruptors || [],
      daily_reminder_time: setup.daily_reminder_time || null,
    },
  };
}

module.exports = {
  loadAnalysisV2,
  loadTrackContext,
  computeStats,
  buildSignal,
  buildDailyLogs,
  topDisruptors,
  computeBestNightFormula,
  computeWeekendDrift,
  computeLatencyTrend,
  computeCaffeinePattern,
  computeRemEstimate,
  bestNight,
  worstNight,
  volatilityPct,
  computeBedtimeRibbon,
  getDefaultsForUser,
  buildContextNudge,
  buildAhaMoments,
  getOrGenAiHero,
  getOrGenAiReads,
  SLEEP_HERO_SYSTEM,
  SLEEP_AI_READS_SYSTEM,
  SLEEP_COACH_SYSTEM,
  SLEEP_ACTIONS_SYSTEM,
  SLEEP_FORECAST_SYSTEM,
  pearson, mean, stdev,
};
