'use strict';
const { AI } = require('./ai/models');
const { appendLanguageInstruction } = require('./i18n-prompt');
// ════════════════════════════════════════════════════════════════════
// mind-analytics.js — production analytics engine for the Mind agent.
//
// Powers /api/mind/analysis/v2 — pre-computes everything the Insights
// tab needs in one round-trip. Five pillars:
//
//   1. STATS         — avg mood/anxiety, days_logged, streak, calm_streak,
//                      volatility (sd), best_day, worst_day, granularity.
//   2. SIGNAL        — daily {date, mood, anxiety} series for dual-line chart.
//   3. AHA ENGINE    — 7 mind-only insight cards: hour-heat, granularity-growth,
//                      recovery-time, trigger×dow, sleep-causal, calm-drought,
//                      reframe-trail. Each card is statistically gated.
//   4. AI READS      — 1 hero_insight headline + up to 3 ai_reads via OpenAI,
//                      cached by content-hash in Firestore. Never blocks GET.
//   5. CROSS-AGENT   — pulls last 30 sleep nights to compute sleep×anxiety
//                      Pearson r (1hr-less-sleep → next-day anxiety, Walker 2017).
//
// Design rules:
//   - Never run an LLM call inline on a user-facing GET — always read cache,
//     refresh in background, fall back to deterministic templates.
//   - Every aha card is gated on n>=N_MIN, p<=0.05 OR effect>=THRESHOLD.
//   - Brand-law: zero red/amber/orange. Severity = accent at varying opacity.
//   - max_completion_tokens only. NEVER max_tokens or temperature.
// ════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
const { computeMindScore } = require('./agent-scores');

const db        = () => admin.firestore();
const userDoc   = (id) => db().collection('wellness_users').doc(id);
const agentDoc  = (id, a) => userDoc(id).collection('agents').doc(a);
const mindDoc   = (id) => agentDoc(id, 'mind');

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
const dowOf = (ds) => new Date(ds + 'T12:00:00').getDay(); // 0=Sun..6=Sat
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ─── Statistical primitives ─────────────────────────────────────────
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const variance = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
};
const stdev = (a) => Math.sqrt(variance(a));

// Pearson correlation r — returns { r, n, p } (two-tailed)
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
  // Two-tailed p from r via t-distribution (df = n-2)
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
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;
  let f = 1, c = 1, d = 0;
  for (let m = 0; m <= 200; m++) {
    let numer;
    if (m === 0) numer = 1;
    else if (m % 2 === 0) {
      const k = m / 2;
      numer = (k * (b - k) * x) / ((a + 2 * k - 1) * (a + 2 * k));
    } else {
      const k = (m - 1) / 2;
      numer = -((a + k) * (a + b + k) * x) / ((a + 2 * k) * (a + 2 * k + 1));
    }
    d = 1 + numer * d; if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + numer / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const delta = d * c;
    f *= delta;
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

// ─── Quadrant mapping (Yale Mood Meter — Pleasantness × Energy) ─────
// mood 1=low, 4=great    → pleasantness axis
// anxiety 1=calm, 5=intense → energy axis (high anxiety = high arousal)
function quadrantFor(moodScore, anxietyLevel) {
  const pleasant = (moodScore || 2) >= 3;          // good or great
  const highEnergy = (anxietyLevel || 1) >= 3;     // noticeable or worse
  if (pleasant && highEnergy)   return 'yellow'; // happy, excited, energized
  if (pleasant && !highEnergy)  return 'green';  // calm, content, relaxed
  if (!pleasant && highEnergy)  return 'red';    // anxious, angry, stressed
  return 'blue';                                  // sad, drained, numb (low energy)
}
const QUADRANT_LABEL = {
  yellow: 'Pleasant · Activated',
  green:  'Pleasant · Calm',
  red:    'Unpleasant · Activated',
  blue:   'Unpleasant · Calm',
};

// ─── Period filter ──────────────────────────────────────────────────
function filterPeriod(checkins, days) {
  if (!days) return checkins;
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  const cutoffStr = dateStr(cutoff);
  return checkins.filter(c => (c.date_str || dateStr(c.logged_at instanceof Date ? c.logged_at : new Date(c.logged_at))) >= cutoffStr);
}

// ─── Streak math (with Neff-style 1-day grace) ──────────────────────
function computeStreak(checkins) {
  if (!checkins.length) return { streak: 0, grace_used: false };
  const dates = [...new Set(checkins.map(c => c.date_str).filter(Boolean))].sort().reverse();
  let streak = 0;
  let graceUsed = false;
  for (let i = 0; i < dates.length; i++) {
    const expected = dateStr(new Date(Date.now() - i * 86400000));
    if (dates[i] === expected) { streak++; continue; }
    // 1-day grace if missed exactly one day, then resume
    if (!graceUsed && i > 0 && dates[i - 1] === dateStr(new Date(Date.now() - (i - 1) * 86400000))) {
      const next = dateStr(new Date(Date.now() - (i + 1) * 86400000));
      if (dates[i] === next) { graceUsed = true; streak++; continue; }
    }
    break;
  }
  return { streak, grace_used: graceUsed };
}

// ─── Calm streak — consecutive days where any logged emotion was Calm/Content/Relaxed ──
function computeCalmStreak(checkins) {
  const calmEmotions = new Set(['Calm', 'Content', 'Relaxed', 'Grateful']);
  const byDate = {};
  for (const c of checkins) {
    if (!c.date_str) continue;
    if (!byDate[c.date_str]) byDate[c.date_str] = [];
    (c.emotions || []).forEach(e => byDate[c.date_str].push(e));
  }
  const dates = Object.keys(byDate).sort().reverse();
  let s = 0;
  for (let i = 0; i < dates.length; i++) {
    const expected = dateStr(new Date(Date.now() - i * 86400000));
    if (dates[i] !== expected) break;
    if ((byDate[dates[i]] || []).some(e => calmEmotions.has(e))) s++;
    else break;
  }
  return s;
}

// ─── Period stats (used for both period view and all-time score) ────
function computeStats(checkins) {
  if (!checkins.length) return {
    total_checkins: 0, days_with_logs: 0, avg_mood: 0, avg_anxiety: 0,
    streak: 0, longest_streak: 0,
  };
  const moods = checkins.map(c => Number(c.mood_score || c.mood || 2));
  const anxs  = checkins.map(c => Number(c.anxiety_level || c.anxiety || 1));
  const dates = [...new Set(checkins.map(c => c.date_str).filter(Boolean))];
  const stk   = computeStreak(checkins);
  return {
    total_checkins:  checkins.length,
    days_with_logs:  dates.length,
    avg_mood:        Math.round(mean(moods) * 10) / 10,
    avg_anxiety:     Math.round(mean(anxs) * 10) / 10,
    mood_sd:         Math.round(stdev(moods) * 100) / 100,
    anxiety_sd:      Math.round(stdev(anxs) * 100) / 100,
    streak:          stk.streak,
    grace_used:      stk.grace_used,
    longest_streak:  stk.streak, // populated by all-time call
    pct_calm_days:   Math.round((computeCalmStreak(checkins) / Math.max(1, dates.length)) * 100),
  };
}

// ─── Signal points: per-day {date, mood, anxiety} — the chart fuel ──
function buildSignalPoints(checkins) {
  if (!checkins.length) return [];
  const byDate = {};
  for (const c of checkins) {
    const ds = c.date_str || dateStr(c.logged_at instanceof Date ? c.logged_at : new Date(c.logged_at));
    if (!byDate[ds]) byDate[ds] = { mood: [], anxiety: [] };
    byDate[ds].mood.push(Number(c.mood_score || c.mood || 2));
    byDate[ds].anxiety.push(Number(c.anxiety_level || c.anxiety || 1));
  }
  return Object.entries(byDate).sort(([a], [b]) => a.localeCompare(b)).map(([ds, v]) => ({
    date:    ds,
    label:   new Date(ds + 'T12:00:00').toLocaleDateString('en', { month: 'short', day: 'numeric' }),
    mood:    Math.round(mean(v.mood) * 10) / 10,
    anxiety: Math.round(mean(v.anxiety) * 10) / 10,
  }));
}

// ─── Daily logs map for calendar (quadrant-colored) ─────────────────
function buildDailyLogs(checkins) {
  const out = {};
  for (const c of checkins) {
    const ds = c.date_str;
    if (!ds) continue;
    const mood = Number(c.mood_score || c.mood || 2);
    const anx  = Number(c.anxiety_level || c.anxiety || 1);
    if (!out[ds] || (out[ds].count || 0) < 1) {
      out[ds] = { has_log: true, mood, anxiety: anx, quadrant: quadrantFor(mood, anx), has_note: !!(c.note && c.note.length > 4), count: 1 };
    } else {
      out[ds].count = (out[ds].count || 1) + 1;
      out[ds].mood = Math.round(((out[ds].mood + mood) / 2) * 10) / 10;
      out[ds].anxiety = Math.round(((out[ds].anxiety + anx) / 2) * 10) / 10;
      out[ds].quadrant = quadrantFor(out[ds].mood, out[ds].anxiety);
      if (c.note && c.note.length > 4) out[ds].has_note = true;
    }
  }
  return out;
}

// ─── AHA #1: hour heat-map ───────────────────────────────────────────
// {0..23: {avg_anxiety, count}}. Surface peak hour if anxiety_at_peak >=
// avg_anxiety + 0.5 AND count_at_peak >= 3.
function computeHourHeat(checkins) {
  const buckets = Array(24).fill(null).map(() => ({ anxs: [], moods: [] }));
  for (const c of checkins) {
    const h = (c.hour != null ? c.hour : new Date(millis(c.logged_at)).getHours());
    if (h < 0 || h > 23) continue;
    buckets[h].anxs.push(Number(c.anxiety_level || c.anxiety || 1));
    buckets[h].moods.push(Number(c.mood_score || c.mood || 2));
  }
  const result = {};
  for (let h = 0; h < 24; h++) {
    if (buckets[h].anxs.length) {
      result[h] = {
        avg_anxiety: Math.round(mean(buckets[h].anxs) * 10) / 10,
        avg_mood:    Math.round(mean(buckets[h].moods) * 10) / 10,
        count:       buckets[h].anxs.length,
      };
    }
  }
  return result;
}
function peakHour(hourHeat, baselineAnxiety) {
  let peak = null;
  for (const [h, v] of Object.entries(hourHeat)) {
    if (v.count < 3) continue;
    if (v.avg_anxiety < baselineAnxiety + 0.5) continue;
    if (!peak || v.avg_anxiety > peak.avg_anxiety) peak = { hour: Number(h), ...v };
  }
  return peak;
}

// ─── AHA #2: granularity (Barrett — emotion vocabulary) ─────────────
// Compare unique-emotion count in last 30d vs prior 30d (windowed).
function computeGranularity(allCheckins) {
  const now = Date.now();
  const cutoff30 = now - 30 * 86400000;
  const cutoff60 = now - 60 * 86400000;
  const recent  = new Set();
  const prior   = new Set();
  for (const c of allCheckins) {
    const t = millis(c.logged_at);
    if (t > cutoff30) (c.emotions || []).forEach(e => recent.add(e));
    else if (t > cutoff60) (c.emotions || []).forEach(e => prior.add(e));
  }
  return { now: recent.size, prior: prior.size, delta: recent.size - prior.size };
}

// ─── AHA #3: recovery time — avg days from low-mood (1) → mood ≥ 3 ──
function computeRecoveryDays(checkins) {
  if (!checkins.length) return null;
  const byDate = {};
  for (const c of checkins) {
    if (!c.date_str) continue;
    if (!byDate[c.date_str]) byDate[c.date_str] = [];
    byDate[c.date_str].push(Number(c.mood_score || c.mood || 2));
  }
  const days = Object.keys(byDate).sort();
  if (days.length < 5) return null;
  const recoveries = [];
  for (let i = 0; i < days.length; i++) {
    if (Math.min(...byDate[days[i]]) <= 1) {
      // walk forward looking for first day with mean mood ≥ 3
      for (let j = i + 1; j < days.length; j++) {
        const m = mean(byDate[days[j]]);
        if (m >= 3) {
          const d1 = new Date(days[i] + 'T12:00:00');
          const d2 = new Date(days[j] + 'T12:00:00');
          recoveries.push(Math.round((d2 - d1) / 86400000));
          break;
        }
      }
    }
  }
  if (recoveries.length < 2) return null;
  return Math.round(mean(recoveries) * 10) / 10;
}

// ─── AHA #4: trigger × day-of-week pattern ──────────────────────────
function computeTriggerByDow(checkins) {
  const matrix = {}; // {trigger: {dow: count}}
  for (const c of checkins) {
    if (!c.date_str) continue;
    const dow = dowOf(c.date_str);
    for (const t of (c.triggers || [])) {
      if (!matrix[t]) matrix[t] = Array(7).fill(0);
      matrix[t][dow]++;
    }
  }
  // Find top trigger and its peak day
  let topTrigger = null, topCount = 0, topDow = -1;
  for (const [trig, byDow] of Object.entries(matrix)) {
    const total = byDow.reduce((s, x) => s + x, 0);
    if (total > topCount) {
      topCount = total;
      topTrigger = trig;
      topDow = byDow.indexOf(Math.max(...byDow));
    }
  }
  if (!topTrigger || topCount < 3) return null;
  const dowShare = topCount > 0 ? Math.round((matrix[topTrigger][topDow] / topCount) * 100) : 0;
  return { trigger: topTrigger, dow: topDow, dow_label: DOW_SHORT[topDow], total: topCount, dow_share_pct: dowShare, matrix };
}

// ─── AHA #5: sleep × next-day anxiety (cross-agent) ─────────────────
async function computeSleepCorrelation(deviceId, mindCheckins) {
  try {
    const sleepRef = userDoc(deviceId).collection('agents').doc('sleep').collection('sleep_logs');
    const snap = await sleepRef.orderBy('logged_at', 'desc').limit(60).get();
    if (snap.empty) return null;
    const sleepByDate = {};
    snap.docs.forEach(d => {
      const data = d.data();
      const ds = data.date_str || dateStr(millis(data.logged_at));
      const hrs = Number(data.total_sleep_hours || data.hours || 0);
      if (hrs > 0) sleepByDate[ds] = hrs;
    });
    // For each sleep night, find next-day anxiety
    const sleepArr = [], nextAnxArr = [];
    const mindByDate = {};
    for (const c of mindCheckins) {
      if (!c.date_str) continue;
      if (!mindByDate[c.date_str]) mindByDate[c.date_str] = [];
      mindByDate[c.date_str].push(Number(c.anxiety_level || c.anxiety || 1));
    }
    for (const [ds, hrs] of Object.entries(sleepByDate)) {
      const next = dateStr(new Date(new Date(ds + 'T12:00:00').getTime() + 86400000));
      if (mindByDate[next]) {
        sleepArr.push(hrs);
        nextAnxArr.push(mean(mindByDate[next]));
      }
    }
    if (sleepArr.length < 5) return null;
    const corr = pearson(sleepArr, nextAnxArr);
    if (!corr) return null;
    // Compute simple slope: anxiety per hour of sleep delta
    const mx = mean(sleepArr), my = mean(nextAnxArr);
    let num = 0, den = 0;
    for (let i = 0; i < sleepArr.length; i++) {
      num += (sleepArr[i] - mx) * (nextAnxArr[i] - my);
      den += (sleepArr[i] - mx) ** 2;
    }
    const slope = den ? num / den : 0; // anxiety_change_per_hour_of_sleep
    return {
      r:           Math.round(corr.r * 100) / 100,
      n:           corr.n,
      p:           Math.round(corr.p * 1000) / 1000,
      slope:       Math.round(slope * 100) / 100,
      direction:   slope < 0 ? 'less_sleep_more_anxiety' : 'more_sleep_more_anxiety',
      anxiety_per_lost_hour: Math.round(Math.abs(slope) * 10) / 10,
    };
  } catch (err) {
    log.warn('[mind-analytics] sleep corr failed:', err.message);
    return null;
  }
}

// ─── AHA #6: positive-affect drought ────────────────────────────────
function computeCalmDrought(checkins) {
  const positives = new Set(['Calm', 'Content', 'Relaxed', 'Grateful', 'Happy', 'Joyful', 'Hopeful']);
  let lastCalm = null;
  const sorted = [...checkins].sort((a, b) => millis(b.logged_at) - millis(a.logged_at));
  for (const c of sorted) {
    if ((c.emotions || []).some(e => positives.has(e))) {
      lastCalm = c.date_str || dateStr(millis(c.logged_at));
      break;
    }
  }
  if (!lastCalm) return null;
  const days = Math.round((Date.now() - new Date(lastCalm + 'T12:00:00').getTime()) / 86400000);
  return { last_date: lastCalm, days_since: days };
}

// ─── AHA #7: best/worst day + volatility ────────────────────────────
function bestDay(signal) {
  if (!signal.length) return null;
  const best = signal.reduce((a, b) => (b.mood - b.anxiety / 2) > (a.mood - a.anxiety / 2) ? b : a);
  return { date: best.date, label: best.label, mood: best.mood, anxiety: best.anxiety };
}
function worstDay(signal) {
  if (!signal.length) return null;
  const worst = signal.reduce((a, b) => (b.anxiety - b.mood / 2) > (a.anxiety - a.mood / 2) ? b : a);
  return { date: worst.date, label: worst.label, mood: worst.mood, anxiety: worst.anxiety };
}
function volatilityPct(signal) {
  if (signal.length < 2) return 0;
  const moods = signal.map(s => s.mood);
  const sd = stdev(moods);
  return Math.round((sd / 4) * 100); // 4 = max mood scale
}

// ─── Top emotions / triggers ────────────────────────────────────────
// Enriched: for each emotion, return {emotion, count, avg_mood, avg_anxiety, share_pct}.
function topEmotions(checkins, n = 6) {
  const bucket = {};
  for (const c of checkins) {
    const m = Number(c.mood_score || c.mood || 2);
    const a = Number(c.anxiety_level || c.anxiety || 1);
    for (const e of (c.emotions || [])) {
      if (!bucket[e]) bucket[e] = { moods: [], anxs: [] };
      bucket[e].moods.push(m);
      bucket[e].anxs.push(a);
    }
  }
  const totalLogs = checkins.length || 1;
  return Object.entries(bucket)
    .map(([emotion, v]) => ({
      emotion,
      count:       v.moods.length,
      avg_mood:    Math.round(mean(v.moods) * 10) / 10,
      avg_anxiety: Math.round(mean(v.anxs) * 10) / 10,
      share_pct:   Math.round((v.moods.length / totalLogs) * 100),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}
// Enriched: for each trigger, return {trigger, count, avg_mood, avg_anxiety,
// peak_dow, peak_dow_label, share_pct}. Single O(n × t) pass — t ≤ 11 triggers.
function topTriggers(checkins, n = 6) {
  // Bucket: trigger → { moods: [], anxs: [], dowCounts: number[7] }
  const bucket = {};
  for (const c of checkins) {
    const m = Number(c.mood_score || c.mood || 2);
    const a = Number(c.anxiety_level || c.anxiety || 1);
    const dow = c.date_str ? new Date(c.date_str + 'T12:00:00').getDay() : null;
    for (const t of (c.triggers || [])) {
      if (!bucket[t]) bucket[t] = { moods: [], anxs: [], dowCounts: [0,0,0,0,0,0,0] };
      bucket[t].moods.push(m);
      bucket[t].anxs.push(a);
      if (dow != null) bucket[t].dowCounts[dow]++;
    }
  }
  const totalLogs = checkins.length || 1;
  return Object.entries(bucket)
    .map(([trigger, v]) => {
      const peakDow = v.dowCounts.indexOf(Math.max(...v.dowCounts));
      return {
        trigger,
        count:        v.moods.length,
        avg_mood:     Math.round(mean(v.moods) * 10) / 10,
        avg_anxiety:  Math.round(mean(v.anxs) * 10) / 10,
        peak_dow:     peakDow,
        peak_dow_label: DOW_SHORT[peakDow],
        share_pct:    Math.round((v.moods.length / totalLogs) * 100),
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

// ════════════════════════════════════════════════════════════════════
// AHA ENGINE — assembles up to 5 ranked aha_moments from the 7 candidates
// ════════════════════════════════════════════════════════════════════
function buildAhaMoments({ stats, hourHeat, granularity, recovery, triggerDow, sleepCorr, calmDrought, bestD, worstD, signal }) {
  const ahas = [];
  const baseAnx = stats.avg_anxiety || 1;

  // 1. Hardest time of day
  const peak = peakHour(hourHeat, baseAnx);
  if (peak) {
    const hLabel = (peak.hour % 12 || 12) + (peak.hour < 12 ? 'am' : 'pm');
    ahas.push({
      key:  'hour_heat',
      label:'HARDEST TIME',
      kpi:  hLabel,
      body: `You feel most anxious around ${hLabel}. It shows up clearly across your check-ins.`,
      score: 95,
    });
  }

  // 2. Feelings you named (vocabulary growth or drop)
  if (granularity.now >= 5 && granularity.delta > 0) {
    ahas.push({
      key:  'granularity_growth',
      label:'FEELINGS YOU NAMED',
      kpi:  `${granularity.now} different ones`,
      body: `Last month you used ${granularity.prior} different feeling words. This month: ${granularity.now}. Naming what you feel makes it easier to handle.`,
      score: 88,
    });
  } else if (granularity.now >= 3 && granularity.delta < 0) {
    ahas.push({
      key:  'granularity_drop',
      label:'FEELINGS YOU NAMED',
      kpi:  `${granularity.now} different ones`,
      body: `Down from ${granularity.prior} last month. Try one new feeling word this week.`,
      score: 65,
    });
  }

  // 3. Back-to-good time
  if (recovery && recovery <= 3) {
    ahas.push({
      key:  'recovery_time',
      label:'BACK TO GOOD',
      kpi:  `About ${recovery} day${recovery === 1 ? '' : 's'}`,
      body: `After a low day, it usually takes you about ${recovery} day${recovery === 1 ? '' : 's'} to feel okay again. That's a healthy bounce-back.`,
      score: 80,
    });
  } else if (recovery && recovery > 4) {
    ahas.push({
      key:  'recovery_slow',
      label:'BACK TO GOOD',
      kpi:  `About ${recovery} days`,
      body: `It's taking around ${recovery} days to feel okay after a low. One small daily action can cut that in half.`,
      score: 78,
    });
  }

  // 4. What repeats (trigger × day-of-week)
  if (triggerDow && triggerDow.dow_share_pct >= 35) {
    ahas.push({
      key:  'trigger_dow',
      label:'WHAT REPEATS',
      kpi:  `${triggerDow.trigger} · ${triggerDow.dow_label}s`,
      body: `Most of your "${triggerDow.trigger}" stress lands on ${triggerDow.dow_label}s. Same pattern, week after week.`,
      score: 82,
    });
  }

  // 5. Sleep & mood link
  if (sleepCorr && sleepCorr.p < 0.1 && Math.abs(sleepCorr.r) >= 0.25 && sleepCorr.direction === 'less_sleep_more_anxiety') {
    ahas.push({
      key:  'sleep_causal',
      label:'SLEEP & MOOD',
      kpi:  `Clear link`,
      body: `When you sleep less than usual, you feel more anxious the next day. The pattern shows up clearly in your data.`,
      score: 92,
    });
  }

  // 6. Feeling good gap
  if (calmDrought && calmDrought.days_since >= 7) {
    ahas.push({
      key:  'calm_drought',
      label:'FEELING GOOD',
      kpi:  `${calmDrought.days_since} days`,
      body: `You haven't logged a calm or content feeling in ${calmDrought.days_since} days. One small thing today might help.`,
      score: 70,
    });
  }

  // 7. Good vs hard days range
  if (bestD && worstD && Math.abs((bestD.mood - bestD.anxiety / 2) - (worstD.mood - worstD.anxiety / 2)) >= 2) {
    const vol = Math.round(volatilityPct(signal));
    ahas.push({
      key:  'volatility',
      label:'GOOD VS HARD DAYS',
      kpi:  `${bestD.label} → ${worstD.label}`,
      body: vol >= 30
        ? `Big swings between your best and hardest days. Steady small habits help more than big pushes.`
        : `Some up and down between your best and hardest days. That's normal.`,
      score: 60,
    });
  }

  return ahas.sort((a, b) => b.score - a.score).slice(0, 5);
}

// ════════════════════════════════════════════════════════════════════
// AI READS — LLM-driven, prompt-cached, Firestore-cached by content hash
// ════════════════════════════════════════════════════════════════════

const MIND_HERO_SYSTEM = `You are a warm, plain-spoken mind coach. Write the ONE-sentence opening insight on a personal mental-wellness app's Insights tab. ONE sentence that makes the user feel "this is exactly what's going on with me."

PLAIN ENGLISH — NON-NEGOTIABLE:
- Reflect a real number from the data — don't guess.
- Use everyday words. Never: "Pearson", "correlation", "r=", "n=", "p<", "baseline", "elevated trait", "affect-labeling", "granularity", "polyvagal", "behavioral activation", "GAD", "PHQ", "depression", "anxiety disorder", or any researcher names.
- If data is thin (<7 logs): "Still learning your rhythm — keep checking in."
- Calm, kind tone. No alarm. No exclamation marks.
- Output JSON only: {"headline": "..."} — single sentence, max 110 chars.

GOOD EXAMPLES:
- {"headline": "Your hardest time is 3pm — anxiety climbs then eases by 5."}
- {"headline": "Sleeping less than 6 hours predicts a tougher next day for you."}
- {"headline": "You named more different feelings this month than last — that's progress."}
- {"headline": "After a low day, you usually feel okay again in about 2 days."}`;

const MIND_AI_READS_SYSTEM = `You are a warm, plain-spoken mind coach writing the "What I'm seeing" section. The user has logged mood, anxiety, emotions, triggers, and notes. Produce exactly THREE distinct reads that feel like a friend who knows their patterns.

EACH READ HAS:
- kind: "champion" (something working) | "drag" (a pattern slowing them) | "pattern" (a neutral observation worth knowing)
- title: 6-10 words, specific, plain English
- body: 14-22 words, references at least one concrete number from data
- action: 6-10 words, ONE small step they can take this week (skip if none obvious)

PLAIN ENGLISH RULES — NON-NEGOTIABLE:
- Never use jargon. NO: "correlation", "r=", "n=", "p<", "baseline", "elevated trait", "affect-labeling", "emotional granularity", "polyvagal", "behavioral activation", "GAD", "PHQ", "Barrett", "Walker", "Jacobson", "Lieberman", "Cohen", "Gollwitzer".
- Never diagnose. Never use "depression", "anxiety disorder", "PTSD".
- Talk like a friend, not a textbook. "When you sleep less, you feel worse the next day" — not "sleep duration correlates inversely with next-day anxiety".
- Output JSON only: {"reads": [{kind, title, body, action}, ...]}.

GOOD EXAMPLES:
{"kind":"champion","title":"Your feelings are getting clearer","body":"Last month you used 6 different feeling words. This month, 13. The more specific you can be, the easier they are to handle.","action":"Try one new feeling word this week."}
{"kind":"drag","title":"Sundays keep being your hardest day","body":"4 out of the last 5 Sundays you felt high anxiety. Same pattern. A small Sunday-morning ritual could break it.","action":"Plan a Sunday-morning anchor."}
{"kind":"pattern","title":"Sleeping 7 hours sets up a better day","body":"When you sleep at least 7 hours, your next day is usually a good one. It shows up clearly.","action":"Pin a 7-hour bedtime alarm."}`;

const MIND_REFRAME_SYSTEM = `You are a warm, brief coach helping a user soften a heavy thought. Output JSON only: {"reframe": "..."} — 1-2 sentences, ≤180 chars, written in the user's voice (first person), never preachy.

RULES:
- Acknowledge the feeling. Don't deny it. Then offer a more balanced way to see it.
- Plain English only. No therapy jargon, no "cognitive distortion", no "catastrophizing", no "CBT".
- Never use "should", "just", "everyone".
- If thought contains harm/crisis content, output {"reframe":"This needs more than a reframe — please reach out to someone you trust or text 988 (US) / Samaritans (UK)."}

GOOD:
input: "I always mess up at work."
{"reframe":"I had a hard moment at work — but 'always' isn't true. I can name two things I handled well this week."}

input: "Nobody likes me."
{"reframe":"It's painful when I feel disconnected. There are one or two specific people I'd like more from — not 'nobody'."}`;

// MIND_DESCRIBE_SYSTEM — parses free voice/text describing how the user
// feels into the same structured payload the manual check-in form produces.
// Output JSON only, strict schema, picks ONLY from canonical lists.
//
// PARSING DOCTRINE (2026-05-23): voice transcripts are messy. Numbers come
// as words ("eight"), people ramble, the mood word might never appear
// directly ("I'm fine" might mean low if surrounded by "tired, drained,
// can't focus"). INFER the mood from the FULL emotional weight of the
// sentence, not just keywords. ALWAYS extract the user's verbatim story
// into the note — that's the most valuable signal long-term.
const MIND_DESCRIBE_SYSTEM = `You parse a short voice or text check-in into a structured mind log. Output JSON ONLY in this schema:

{
  "mood": "low" | "okay" | "good" | "great",
  "anxiety": 1..5,
  "emotions": [string, ...],
  "triggers": [string, ...],
  "note": string
}

CORE RULES:
- Always fill EVERY field. mood + anxiety must always be derived even when not stated explicitly. emotions+triggers can be [] only if truly nothing applies. note MUST always have content (the user's words) unless input is total garbage.
- INFER from context — don't require keywords. "I haven't gotten out of bed, body feels like lead, kept crying" → mood=low, anxiety=2, emotions=[Sad, Drained, Hopeless], even though none of those words appear.
- mood MUST be one of: "low", "okay", "good", "great". Maps:
    great = euphoric, amazing, on fire, best day, incredible, in love, crushing it
    good  = fine, alright, content, calm-but-positive, satisfied, productive
    okay  = neutral, mid, bored, "meh", just-existing
    low   = sad, terrible, awful, depressed, drained, hopeless, exhausted-and-heavy
  When tone is conflicted ("good but anxious") → pick the dominant frame.

- anxiety 1..5 where 1=Calm, 2=Mild, 3=Noticeable, 4=High, 5=Intense.
  Number scale on /10: 0-2→1, 3-4→2, 5-6→3, 7-8→4, 9-10→5.
  Words as numbers: "zero/one/two..." → use the number. "eight out of ten" → 4.
  Phrasal cues if no number: "calm/grounded/relaxed" → 1; "a little tense" → 2;
  "tense/nervous/jittery" → 3; "really anxious/spiraling/racing thoughts" → 4;
  "panic/overwhelmed/can't breathe/hyperventilating" → 5.
  When NOT mentioned at all, derive from mood: low→3, okay→2, good→2, great→1.

- emotions MUST come ONLY from this list (pick the 1-5 most relevant — prefer
  more emotions when the user named several distinct feelings):
  ["Anxious","Overwhelmed","Sad","Angry","Lonely","Numb","Stressed","Drained",
   "Foggy","Hopeless","Restless","Bored","Worried","Calm","Hopeful","Content",
   "Grateful","Focused","Energized","Happy","Relaxed","Motivated","Excited",
   "Proud","Inspired","Joyful"]
  Map synonyms: pissed/furious/mad → Angry. burnt-out/exhausted → Drained.
  can't focus/scattered → Foggy. ruminating/spiraling → Anxious. heavy/down → Sad.
  ALWAYS pick at least one emotion when ANY feeling word appears, even loosely.

- triggers MUST come ONLY from this list (pick 0-3, most relevant):
  ["Work","Relationships","Money","Family","Health","Sleep","Loneliness",
   "Body image","Social situation","Can't name it"]
  Map: deadline/boss/project/meeting → Work. partner/spouse/breakup/fight → Relationships.
  bills/rent/broke/finances → Money. mom/dad/sister/parents/family → Family.
  sick/doctor/pain/injury → Health. no sleep/insomnia/woke up → Sleep.
  alone/isolated/nobody → Loneliness. weight/mirror → Body image.
  party/crowd/event/networking → Social situation.
  If user explicitly says "nothing specific" or can't pinpoint → ["Can't name it"].

- note = the user's verbatim story, lightly cleaned (proper case + punctuation,
  trim filler "um/uh/like/you know", convert spoken numbers to digits, but
  PRESERVE meaning and voice). Cap at 280 chars. Keep specifics (deadline,
  partner's name, "3pm meeting", the actual reason). Never preach, never
  add advice, never rewrite into third person.

- Never invent feelings or triggers the user didn't imply.
- Never include any clinical labels (no GAD, no depression, no PTSD, etc.).
- Never include any other top-level keys.

═══ WORKED EXAMPLES — STUDY THESE BEFORE PARSING ═══

INPUT: "I'm anxious about a deadline tomorrow. Eight out of ten. Can't stop running through everything that could go wrong."
OUTPUT: {"mood":"low","anxiety":4,"emotions":["Anxious","Worried","Stressed"],"triggers":["Work"],"note":"Anxious about a deadline tomorrow — 8/10. Can't stop running through everything that could go wrong."}

INPUT: "Pretty low today. Slept badly, my body feels heavy, and I keep thinking about that argument with my partner last night."
OUTPUT: {"mood":"low","anxiety":3,"emotions":["Sad","Drained","Worried"],"triggers":["Relationships","Sleep"],"note":"Pretty low today. Slept badly, body feels heavy, and I keep thinking about the argument with my partner last night."}

INPUT: "Actually really good. Got through my list, called my mom, went for a walk. Calm and grateful right now."
OUTPUT: {"mood":"great","anxiety":1,"emotions":["Calm","Grateful","Content","Proud"],"triggers":[],"note":"Got through my list, called mom, went for a walk. Calm and grateful right now."}

INPUT: "Just feel numb. Not sad, not happy. Bored mostly. Three out of ten anxiety, nothing specific I can name."
OUTPUT: {"mood":"okay","anxiety":2,"emotions":["Numb","Bored"],"triggers":["Can't name it"],"note":"Just feel numb. Not sad, not happy. Bored mostly. 3/10 anxiety, nothing specific."}

INPUT: "Stressed about money. Bills came in and the math doesn't add up this month. Tense, foggy, can't focus."
OUTPUT: {"mood":"low","anxiety":4,"emotions":["Stressed","Worried","Foggy","Drained"],"triggers":["Money"],"note":"Stressed about money. Bills came in and the math doesn't add up. Tense, foggy, can't focus."}

INPUT: "Honestly I'm fine. Productive morning, hit my reading goal, good cup of coffee, ready for whatever."
OUTPUT: {"mood":"good","anxiety":1,"emotions":["Content","Focused","Motivated","Calm"],"triggers":[],"note":"Productive morning. Hit my reading goal, good coffee, ready for whatever."}

INPUT: "I think I'm panicking. Heart racing, hands sweating, the meeting in twenty minutes feels like the end of the world."
OUTPUT: {"mood":"low","anxiety":5,"emotions":["Overwhelmed","Anxious","Stressed"],"triggers":["Work"],"note":"Panicking. Heart racing, hands sweating. Meeting in 20 min feels like the end of the world."}

INPUT: "Mom called again. Made me feel like a kid being told off. Frustrated and small. Maybe a six out of ten."
OUTPUT: {"mood":"low","anxiety":3,"emotions":["Angry","Sad","Drained"],"triggers":["Family"],"note":"Mom called again. Felt like a kid being told off. Frustrated and small. 6/10."}

INPUT: "Lonely. Haven't seen anyone in days and the apartment feels too quiet."
OUTPUT: {"mood":"low","anxiety":2,"emotions":["Lonely","Sad"],"triggers":["Loneliness"],"note":"Lonely. Haven't seen anyone in days and the apartment feels too quiet."}

INPUT: "Excited! Got the offer. Anxious about the move but mostly excited."
OUTPUT: {"mood":"great","anxiety":3,"emotions":["Excited","Hopeful","Anxious","Proud"],"triggers":["Work"],"note":"Got the offer! Anxious about the move but mostly excited."}`;

const MIND_COACH_SYSTEM = `You are the user's mind coach — warm, brief, specific, never clinical. The user is opening the chat inside an app where you can see their last 7 days of mood, anxiety, feelings, triggers, and notes.

RULES:
- Reflect first, then respond. One short reflection sentence before any advice.
- When you cite their data, use plain numbers and plain words. Never "correlation", "r=", "baseline", "circadian", "cortisol", "elevated trait".
- Never diagnose. Never use disorder names ("depression", "GAD", "PTSD", etc.).
- 2-4 short sentences max. No bullet points. No emoji.
- If message contains crisis keywords (suicide, end it, kill myself, self-harm) → respond ONLY with: "I hear how heavy this is. You don't have to carry it alone — please reach out to 988 (US) or Samaritans (UK 116 123) right now. I'll be here when you're ready to talk."
- Never use "should" or "just".

EXAMPLES:
user: "Why is my anxiety always worst at 3pm?"
you: "Your data backs it up — 3pm has been your hardest time the last two weeks. A short walk and a glass of water right before can take the edge off. Want to try it for a few days?"

user: "I can't shake this work thing."
you: "Work has been your top stressor 9 of the last 14 check-ins — that's a lot to carry. What part of it is loudest right now: the volume, a person, or the fear of dropping a ball?"`;

const MIND_ACTIONS_SYSTEM = `You are the user's mind coach writing a 3-checkin plan. Output 1-3 specific actions, each with:
- title (6-9 words, action verb first, plain English)
- why (12-18 words, references one specific data point in plain words)
- how (10-16 words, one small step doable in under 5 min)
- when (cadence: "twice today", "every evening for 5 days", etc.)
- proof (10-14 words: how the user knows it's working, in plain words)

PLAIN ENGLISH RULES — NON-NEGOTIABLE:
- No clinical labels. No researcher names. No "correlation", "r=", "baseline", "polyvagal", "behavioral activation", "affect-labeling", "emotional granularity".
- Each action must be doable today.
- Calm tone. No alarm words.
- Output JSON only: {"actions":[{title, why, how, when, proof, archetype, target_count}]}.
- archetype is one of: breathing_60s, reframe_thought, name_emotion, walk_5min, text_someone, intention_set, log_checkin, calm_reset, granularity_growth, reframe_practice, trigger_awareness
- target_count is the # of times to complete this action over the plan window (1-7).

ARCHETYPE GUIDANCE (2026-05-23) — pick based on PRIORITY_SIGNALS in prompt:
- "calm_reset" — when readiness band is stressed/overwhelmed OR anxiety EMA climbing 2+ weeks. Cite the readiness number. Action: 2-3 light days, grounding + sleep, no heavy decisions.
- "granularity_growth" — when emotion vocabulary is stagnant (<6 unique words / 30d). Cite the count. Action: one new feeling word per check-in this week (Kashdan-inspired but NO jargon).
- "reframe_practice" — when a negative note was logged + no reframe attempt in 14 days. Cite the note timing. Action: open the reframe tool on the next anxious thought.
- "trigger_awareness" — when same trigger appears in ≥40% of last-30d checkins. Cite the trigger name. Action: name the pattern in writing once this week.

EXAMPLE OUTPUT:
{"actions":[
{"title":"A 60-second breath before 3pm","why":"3pm has been your hardest time — anxiety around 3.8/5.","how":"Tap the breathing card. Breathe in 4, hold 4, out 4, hold 4.","when":"Every day, before 3pm","proof":"Your 3pm check-ins should feel calmer over 5 days.","archetype":"breathing_60s","target_count":5},
{"title":"Name the feeling before writing","why":"You've used the same 3 feeling words a lot — getting more specific helps.","how":"Open the feeling picker. Pick the closest match before journaling.","when":"Every check-in for 5 days","proof":"Different-feelings count grows by 2 or more.","archetype":"name_emotion","target_count":5}
]}`;

// Hash for cache key — content-stable so same data → same cache hit
function contentHash(obj) {
  const s = JSON.stringify(obj);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

async function getOrGenAiHeroInsight(deviceId, openai, statsPayload, language = 'en') {
  const hash = contentHash({
    n: statsPayload.total_checkins,
    days: statsPayload.days_with_logs,
    m: statsPayload.avg_mood,
    a: statsPayload.avg_anxiety,
    streak: statsPayload.streak,
    lang: language,
  });
  const cacheRef = mindDoc(deviceId).collection('cache').doc('hero_insight_v2');
  try {
    const snap = await cacheRef.get();
    if (snap.exists && snap.data().hash === hash) return snap.data().insight;
  } catch { /* non-fatal */ }
  if (statsPayload.total_checkins < 1) return null;

  const { withHKEnrichment, HK_PROMPT_RULE } = require('./healthkit/analytics-helper');
  try {
    const userMsg = await withHKEnrichment({ deviceId, coach: 'mind', payload: statsPayload, admin });
    const completion = await openai.chat.completions.create({
      model: AI.REASONING_FAST,
      response_format: { type: 'json_object' },
      max_completion_tokens: 220,
      messages: [
        { role: 'system', content: appendLanguageInstruction(`${MIND_HERO_SYSTEM}\n\n${HK_PROMPT_RULE}`, language) },
        { role: 'user',   content: userMsg },
      ],
    });
    const parsed = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
    const insight = parsed?.headline || null;
    if (insight) {
      cacheRef.set({ hash, insight, generated_at: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
    }
    return insight;
  } catch (err) {
    log.warn('[mind-analytics] hero insight LLM failed:', err.message);
    return null;
  }
}

async function getOrGenAiReads(deviceId, openai, readsPayload, language = 'en') {
  const hash = contentHash({
    n: readsPayload.total_checkins,
    days: readsPayload.days_with_logs,
    triggers: readsPayload.top_triggers?.slice(0, 3),
    emotions: readsPayload.top_emotions?.slice(0, 3),
    peak: readsPayload.peak_hour,
    sleep: readsPayload.sleep_correlation?.r,
    g: readsPayload.granularity_now,
    lang: language,
  });
  const cacheRef = mindDoc(deviceId).collection('cache').doc('ai_reads_v2');
  try {
    const snap = await cacheRef.get();
    if (snap.exists && snap.data().hash === hash) return snap.data().reads;
  } catch { /* non-fatal */ }
  if (readsPayload.total_checkins < 3) return [];

  const { withHKEnrichment, HK_PROMPT_RULE } = require('./healthkit/analytics-helper');
  try {
    const userMsg = await withHKEnrichment({ deviceId, coach: 'mind', payload: readsPayload, admin });
    const completion = await openai.chat.completions.create({
      model: AI.REASONING_FAST,
      response_format: { type: 'json_object' },
      max_completion_tokens: 700,
      messages: [
        { role: 'system', content: appendLanguageInstruction(`${MIND_AI_READS_SYSTEM}\n\n${HK_PROMPT_RULE}`, language) },
        { role: 'user',   content: userMsg },
      ],
    });
    const parsed = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
    const reads = Array.isArray(parsed?.reads) ? parsed.reads.slice(0, 3) : [];
    if (reads.length) {
      cacheRef.set({ hash, reads, generated_at: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
    }
    return reads;
  } catch (err) {
    log.warn('[mind-analytics] ai_reads LLM failed:', err.message);
    return [];
  }
}

// ════════════════════════════════════════════════════════════════════
// PUBLIC ENTRY — loadAnalysisV2(deviceId, periodDays, { openai })
// Returns the full /analysis/v2 payload. Never throws.
// ════════════════════════════════════════════════════════════════════
async function loadAnalysisV2(deviceId, periodDays, { openai, language = 'en' } = {}) {
  if (!deviceId) return null;

  const checkinsCol = mindDoc(deviceId).collection('mind_checkins');
  const [mindSnap, allSnap] = await Promise.all([
    mindDoc(deviceId).get(),
    checkinsCol.orderBy('logged_at', 'asc').get(),
  ]);

  const allCheckins = allSnap.docs.map(d => ({
    id: d.id,
    ...d.data(),
    logged_at: d.data().logged_at?.toDate?.() || new Date(),
  }));

  if (allCheckins.length === 0) {
    return {
      stage: 0,
      total_checkins: 0,
      stats: { total_checkins: 0, days_with_logs: 0 },
      signal_points: [],
      daily_logs: {},
      ai_reads: [],
      aha_moments: [],
      hero_insight: null,
      hour_heat: {},
      top_triggers: [],
      top_emotions: [],
      granularity_now: 0,
      granularity_30d_ago: 0,
      sleep_correlation: null,
      best_day: null,
      worst_day: null,
      mind_score: null,
      period_days: periodDays || null,
    };
  }

  const periodCheckins = filterPeriod(allCheckins, periodDays);

  // All-time stats (for streak + score)
  const allStats = computeStats(allCheckins);
  // Period stats (for chart + averages)
  const periodStats = periodCheckins.length > 0
    ? { ...computeStats(periodCheckins), longest_streak: allStats.streak }
    : { ...computeStats([]), longest_streak: allStats.streak };

  const signal       = buildSignalPoints(periodCheckins);
  // daily_logs powers the Last-28-Days calendar — it MUST always cover at least
  // the last 28 days even when the user picked 1W on the period chip. Otherwise
  // the calendar would only paint 7 cells. Use max(periodDays, 30) as window.
  const dailyLogsWindow = Math.max(periodDays || 30, 30);
  const dailyLogsSource = filterPeriod(allCheckins, dailyLogsWindow);
  const dailyLogs    = buildDailyLogs(dailyLogsSource.length ? dailyLogsSource : allCheckins);
  const hourHeat     = computeHourHeat(periodCheckins.length ? periodCheckins : allCheckins);
  const granularity  = computeGranularity(allCheckins);
  const recovery     = computeRecoveryDays(allCheckins);
  const triggerDow   = computeTriggerByDow(allCheckins);
  const sleepCorr    = await computeSleepCorrelation(deviceId, allCheckins);
  const calmDrought  = computeCalmDrought(allCheckins);
  const bestD        = bestDay(signal);
  const worstD       = worstDay(signal);
  const volatility   = volatilityPct(signal);
  const triggers     = topTriggers(periodCheckins.length ? periodCheckins : allCheckins);
  const emotions     = topEmotions(periodCheckins.length ? periodCheckins : allCheckins);
  const peak         = peakHour(hourHeat, periodStats.avg_anxiety || 1);

  const ahas = buildAhaMoments({
    stats: periodStats, hourHeat, granularity, recovery, triggerDow,
    sleepCorr, calmDrought, bestD, worstD, signal,
  });

  // Mind score (cross-agent aware via existing computeMindScore)
  const moodScores    = [...allCheckins].reverse().map(c => Number(c.mood_score || c.mood || 2));
  const anxietyScores = [...allCheckins].reverse().map(c => Number(c.anxiety_level || c.anxiety || 1));
  const checkinDates  = [...new Set(allCheckins.map(c => c.date_str).filter(Boolean))];
  let recentSleepHours = null;
  try {
    const sleepRef = userDoc(deviceId).collection('agents').doc('sleep').collection('sleep_logs');
    const snap = await sleepRef.orderBy('logged_at', 'desc').limit(3).get();
    const logs = snap.docs.map(d => d.data());
    if (logs.length) recentSleepHours = mean(logs.map(l => Number(l.total_sleep_hours || 0)).filter(Boolean));
  } catch { /* non-fatal */ }

  const mindScore = computeMindScore({
    mood_scores:        moodScores,
    anxiety_scores:     anxietyScores,
    checkin_dates:      checkinDates,
    days_logged:        checkinDates.length,
    streak:             allStats.streak,
    recent_sleep_hours: recentSleepHours,
  });

  // AI reads + hero insight (cached). Never blocks if OpenAI unavailable.
  const heroPayload = {
    total_checkins:  periodStats.total_checkins,
    days_with_logs:  periodStats.days_with_logs,
    avg_mood:        periodStats.avg_mood,
    avg_anxiety:     periodStats.avg_anxiety,
    streak:          allStats.streak,
    peak_hour:       peak,
    granularity_now: granularity.now,
    sleep_corr:      sleepCorr,
    top_trigger:     triggers[0] || null,
  };
  const readsPayload = {
    ...heroPayload,
    top_triggers:        triggers,
    top_emotions:        emotions,
    granularity_30d_ago: granularity.prior,
    recovery_days:       recovery,
    trigger_dow:         triggerDow,
    sleep_correlation:   sleepCorr,
    calm_drought:        calmDrought,
    best_day:            bestD,
    worst_day:           worstD,
  };

  let heroInsight = null, aiReads = [];
  if (openai && periodStats.total_checkins >= 1) {
    [heroInsight, aiReads] = await Promise.all([
      getOrGenAiHeroInsight(deviceId, openai, heroPayload, language),
      getOrGenAiReads(deviceId, openai, readsPayload, language),
    ]);
  }

  // Score grade
  const grade = (() => {
    if (!mindScore) return null;
    const s = mindScore.score;
    if (s >= 85) return { letter: 'A', band: 'Steady' };
    if (s >= 75) return { letter: 'B', band: 'Healthy' };
    if (s >= 60) return { letter: 'C', band: 'Active' };
    if (s >= 45) return { letter: 'D', band: 'Choppy' };
    return { letter: 'E', band: 'Building' };
  })();

  return {
    stage:               allCheckins.length >= 30 ? 3 : allCheckins.length >= 7 ? 2 : 1,
    period_days:         periodDays || null,
    stats:               periodStats,
    all_time_total:      allCheckins.length,
    mind_score:          mindScore,
    score_grade:         grade,
    hero_insight:        heroInsight ? { headline: heroInsight } : null,
    signal_points:       signal,
    daily_logs:          dailyLogs,
    hour_heat:           hourHeat,
    peak_hour:           peak,
    granularity_now:     granularity.now,
    granularity_30d_ago: granularity.prior,
    granularity_delta:   granularity.delta,
    recovery_days_avg:   recovery,
    trigger_dow_pattern: triggerDow,
    sleep_correlation:   sleepCorr,
    calm_drought:        calmDrought,
    top_triggers:        triggers,
    top_emotions:        emotions,
    best_day:            bestD,
    worst_day:           worstD,
    volatility_pct:      volatility,
    ai_reads:            aiReads,
    aha_moments:         ahas,
    setup:               mindSnap.exists ? mindSnap.data() : {},
  };
}

// ════════════════════════════════════════════════════════════════════
// TRACK CONTEXT — single payload for the Track tab on mount.
// One round-trip replaces 3 fetches. Includes today's logs + smart
// defaults + a contextual nudge.
// ════════════════════════════════════════════════════════════════════

const QUAD_OPACITY_DEFAULT = { yellow: 3, green: 1, red: 4, blue: 2 };

// Per-quadrant top emotion + anxiety (last 30d). Single O(n) pass.
function getDefaultsForUser(allCheckins) {
  const buckets = { yellow: [], green: [], red: [], blue: [] };
  const triggerCounts = {};
  const cutoff = Date.now() - 30 * 86400000;

  for (const c of allCheckins) {
    const t = millis(c.logged_at);
    if (t < cutoff) continue;
    const m = Number(c.mood_score || c.mood || 2);
    const a = Number(c.anxiety_level || c.anxiety || 1);
    const q = quadrantFor(m, a);
    buckets[q].push({ anx: a, emotions: c.emotions || [] });
    for (const tr of (c.triggers || [])) triggerCounts[tr] = (triggerCounts[tr] || 0) + 1;
  }

  const defaults = {
    default_anxiety_per_quadrant: { ...QUAD_OPACITY_DEFAULT },
    top_emotion_per_quadrant: { yellow: null, green: null, red: null, blue: null },
  };
  for (const q of ['yellow', 'green', 'red', 'blue']) {
    const arr = buckets[q];
    if (!arr.length) continue;
    defaults.default_anxiety_per_quadrant[q] = Math.round(mean(arr.map(x => x.anx)));
    const emoCounts = {};
    for (const x of arr) for (const e of x.emotions) emoCounts[e] = (emoCounts[e] || 0) + 1;
    const top = Object.entries(emoCounts).sort(([, a], [, b]) => b - a)[0];
    if (top) defaults.top_emotion_per_quadrant[q] = top[0];
  }
  const topTrig = Object.entries(triggerCounts).sort(([, a], [, b]) => b - a)[0];
  defaults.top_trigger = topTrig ? topTrig[0] : null;
  return defaults;
}

// Today's narrative — describes how mood moved across the day, plain English.
function buildTodaySummary(todayLogs) {
  if (!todayLogs.length) return null;
  if (todayLogs.length === 1) return null; // need ≥2 to compare
  const sorted = [...todayLogs].sort((a, b) => (a.hour ?? 0) - (b.hour ?? 0));
  const first = sorted[0], last = sorted[sorted.length - 1];
  const moodDelta = (last.mood_score || 2) - (first.mood_score || 2);
  const anxDelta  = (last.anxiety_level || 1) - (first.anxiety_level || 1);
  if (moodDelta >= 1) return 'Your mood lifted across the day.';
  if (moodDelta <= -1) return 'Your mood dipped through the day.';
  if (anxDelta <= -1) return 'You eased up as the day went on.';
  if (anxDelta >= 1) return 'Things felt heavier through the day.';
  return 'Pretty steady so far today.';
}

// Pick the most relevant nudge for "right now" — or null.
function getContextNudge(allCheckins, hourHeat, calmDrought) {
  const nowHour = new Date().getHours();
  const nowDow  = new Date().getDay();

  // 1. Hardest hour right now
  const peak = peakHour(hourHeat, mean(allCheckins.map(c => Number(c.anxiety_level || 1))) || 2);
  if (peak && Math.abs(nowHour - peak.hour) <= 1) {
    const fmt = h => (h % 12 || 12) + (h < 12 ? 'am' : 'pm');
    return { type: 'hardest_hour', message: `It's around ${fmt(nowHour)} — usually your hardest time. A quick check-in helps.` };
  }

  // 2. Calm drought
  if (calmDrought && calmDrought.days_since >= 7) {
    return { type: 'calm_drought', message: `You haven't logged a calm or content feeling in ${calmDrought.days_since} days. Take 30 seconds.` };
  }

  // 3. Repeat trigger — 3 of last 5 logs share a trigger
  const last5 = allCheckins.slice(0, 5);
  const counts = {};
  for (const c of last5) for (const t of (c.triggers || [])) counts[t] = (counts[t] || 0) + 1;
  const heaviest = Object.entries(counts).sort(([, a], [, b]) => b - a)[0];
  if (heaviest && heaviest[1] >= 3) {
    return { type: 'repeat_trigger', message: `${heaviest[0]} has come up ${heaviest[1]} of your last 5 check-ins. Want to talk about it?` };
  }

  return null;
}

// Streak with one-day grace (mirrors computeStreak — same logic).
function streakWithGrace(checkins) {
  return computeStreak(checkins);
}

// 28-day calendar dots {date_str: quadrant}, newest 28 days only.
function buildCalendarDots(checkins) {
  const dots = {};
  const cutoff = Date.now() - 60 * 86400000; // pull a wider window for fuzziness
  for (const c of checkins) {
    if (millis(c.logged_at) < cutoff) continue;
    if (!c.date_str) continue;
    const m = Number(c.mood_score || c.mood || 2);
    const a = Number(c.anxiety_level || c.anxiety || 1);
    const q = quadrantFor(m, a);
    // newest log of the day wins
    if (!dots[c.date_str]) dots[c.date_str] = q;
  }
  return dots;
}

async function loadTrackContext(deviceId) {
  if (!deviceId) return null;
  const checkinsCol = mindDoc(deviceId).collection('mind_checkins');
  const snap = await checkinsCol.orderBy('logged_at', 'desc').limit(150).get();

  const allCheckins = snap.docs.map(d => ({
    id: d.id,
    ...d.data(),
    logged_at: d.data().logged_at?.toDate?.() || new Date(),
  }));

  const today = dateStr();
  const todayLogs = allCheckins
    .filter(c => c.date_str === today)
    .map(c => ({
      id:           c.id,
      logged_at:    c.logged_at instanceof Date ? c.logged_at.toISOString() : c.logged_at,
      hour:         c.hour,
      mood:         c.mood,
      mood_score:   c.mood_score || 2,
      anxiety:      c.anxiety_level || c.anxiety || 1,
      anxiety_level:c.anxiety_level || c.anxiety || 1,
      quadrant:     quadrantFor(c.mood_score || 2, c.anxiety_level || c.anxiety || 1),
      emotions:     c.emotions || [],
      triggers:     c.triggers || [],
      has_note:     !!(c.note && c.note.length > 4),
    }));

  const hourHeat = computeHourHeat(allCheckins);
  const calm     = computeCalmDrought(allCheckins);
  const stk      = streakWithGrace(allCheckins);
  const defaults = getDefaultsForUser(allCheckins);
  const nudge    = getContextNudge(allCheckins, hourHeat, calm);
  const dots     = buildCalendarDots(allCheckins);
  const summary  = buildTodaySummary(todayLogs);

  return {
    today_logs:     todayLogs,
    today_summary:  summary,
    smart_defaults: defaults,
    context_nudge:  nudge,
    streak:         stk.streak,
    grace_used:     stk.grace_used,
    calendar_dots:  dots,
    total_checkins: allCheckins.length,
  };
}

module.exports = {
  // public
  loadAnalysisV2,
  loadTrackContext,
  getDefaultsForUser,
  getContextNudge,
  buildTodaySummary,
  buildCalendarDots,
  // analytics
  computeStats,
  buildSignalPoints,
  buildDailyLogs,
  computeHourHeat,
  peakHour,
  computeGranularity,
  computeRecoveryDays,
  computeTriggerByDow,
  computeSleepCorrelation,
  computeCalmDrought,
  bestDay,
  worstDay,
  volatilityPct,
  topEmotions,
  topTriggers,
  buildAhaMoments,
  quadrantFor,
  QUADRANT_LABEL,
  // ai
  getOrGenAiHeroInsight,
  getOrGenAiReads,
  MIND_HERO_SYSTEM,
  MIND_AI_READS_SYSTEM,
  MIND_REFRAME_SYSTEM,
  MIND_COACH_SYSTEM,
  MIND_ACTIONS_SYSTEM,
  MIND_DESCRIBE_SYSTEM,
  // primitives
  pearson,
  mean,
  stdev,
};
