'use strict';
// ════════════════════════════════════════════════════════════════════
// nutrition-analytics.js — production-grade analytics engine
//
// Powers the Analysis tab: pre-computed aggregations, cross-agent
// correlations (Welch's t-test + Pearson r), anomaly detection,
// AI narrative generation with prompt-caching, and a single hydrated
// payload for fast frontend loads.
//
// Design principles:
//   1. Never run an LLM call on user-facing GET — read from cache.
//   2. Every claim is statistically gated (p<0.05, n>=10, |effect|>=0.3).
//   3. Cross-agent data joins by date_str, not by ID.
//   4. Every log is preserved; aggregations are derived, never destructive.
// ════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
// NOTE: cross-agent data is intentionally NOT used here. The nutrition agent
// only sees nutrition data. Only the central Insights agent is allowed to
// pull from sibling agents (sleep / fitness / mind / water / fasting).
const _cohort = require('./nutrition-cohort');
const { computeNutritionScore } = require('./agent-scores');

const db        = () => admin.firestore();
const userDoc   = (id) => db().collection('wellness_users').doc(id);
const agentDoc  = (id, a) => userDoc(id).collection('agents').doc(a);
const nutDoc    = (id) => agentDoc(id, 'nutrition');

// ─── Date helpers ───────────────────────────────────────────────────
const dateStr = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
const daysAgo = (n) => dateStr(new Date(Date.now() - n * 86400000));
const millis  = (ts) => {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts._seconds) return ts._seconds * 1000;
  return new Date(ts).getTime() || 0;
};

// ─── Statistical primitives ─────────────────────────────────────────
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function variance(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
}
function stdev(a) { return Math.sqrt(variance(a)); }

// Welch's two-sample t-test (unequal variance) — returns { t, df, p, d (Cohen's), n1, n2 }
// Used for: high-stress days vs low-stress days, leg-day vs rest-day, etc.
function welchT(x, y) {
  if (x.length < 2 || y.length < 2) return null;
  const mx = mean(x), my = mean(y);
  const vx = variance(x), vy = variance(y);
  const sx = vx / x.length, sy = vy / y.length;
  const denom = Math.sqrt(sx + sy);
  if (denom === 0) return null;
  const t = (mx - my) / denom;
  const df = ((sx + sy) ** 2) / ((sx ** 2) / (x.length - 1) + (sy ** 2) / (y.length - 1));
  const p = pFromT(Math.abs(t), df) * 2;            // two-tailed
  const pooledSd = Math.sqrt(((x.length - 1) * vx + (y.length - 1) * vy) / (x.length + y.length - 2));
  const d = pooledSd > 0 ? (mx - my) / pooledSd : 0;
  return { t, df, p, d, n1: x.length, n2: y.length, mean_x: mx, mean_y: my };
}

// Pearson correlation r — returns { r, n, p }
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
  // Two-tailed p from r via t-distribution
  const t = r * Math.sqrt((n - 2) / Math.max(1e-9, 1 - r * r));
  const p = pFromT(Math.abs(t), n - 2) * 2;
  return { r, n, p };
}

// Cumulative t-distribution — Hill (1970) approximation, accurate to ~1e-4
function pFromT(t, df) {
  if (df < 1 || !Number.isFinite(t)) return 0.5;
  const x = df / (df + t * t);
  return 0.5 * incompleteBeta(df / 2, 0.5, x);
}
// Regularized incomplete beta — continued-fraction (Numerical Recipes adapted)
function incompleteBeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;
  // Continued fraction
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
  const p = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
             771.32342877765313, -176.61502916214059, 12.507343278686905,
             -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1;
  let x = p[0];
  for (let i = 1; i < g + 2; i++) x += p[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

// ─── Daily aggregator ───────────────────────────────────────────────
// Rolls food_logs into per-day summaries. Idempotent.
async function buildDailyAggregates(deviceId, days = 90) {
  const cutoff = daysAgo(days);
  const snap = await nutDoc(deviceId).collection('food_logs')
    .where('date_str', '>=', cutoff)
    .get();

  const byDate = {};
  for (const d of snap.docs) {
    const log = d.data();
    const date = log.date_str || dateStr(millis(log.logged_at));
    if (!byDate[date]) {
      byDate[date] = {
        date, kcal: 0, p: 0, c: 0, f: 0,
        log_count: 0, qualities: [], hourly: new Array(24).fill(0),
        items: [], meal_types: { breakfast: 0, lunch: 0, dinner: 0, snack: 0 },
        verified_count: 0,
      };
    }
    const day = byDate[date];
    day.kcal += +log.calories || 0;
    day.p    += +log.protein  || 0;
    day.c    += +log.carbs    || 0;
    day.f    += +log.fat      || 0;
    day.log_count += 1;
    if (log.food_quality_score != null) day.qualities.push(+log.food_quality_score);
    if (log.meal_type && day.meal_types[log.meal_type] != null) day.meal_types[log.meal_type] += 1;
    if (log._verified) day.verified_count += 1;
    const hr = new Date(millis(log.logged_at) || Date.now()).getHours();
    day.hourly[hr] += +log.calories || 0;
    day.items.push({
      name: log.food_name, kcal: +log.calories || 0, p: +log.protein || 0,
      c: +log.carbs || 0, f: +log.fat || 0,
      meal: log.meal_type, source: log._source || log.source,
    });
  }

  // Finalize per-day computed fields
  for (const date of Object.keys(byDate)) {
    const day = byDate[date];
    day.quality_avg = day.qualities.length
      ? Math.round(day.qualities.reduce((s, x) => s + x, 0) / day.qualities.length)
      : null;
    day.kcal = Math.round(day.kcal);
    day.p = +day.p.toFixed(1);
    day.c = +day.c.toFixed(1);
    day.f = +day.f.toFixed(1);
    delete day.qualities;
  }
  return byDate;
}

// ─── Range stats (hero KPIs) ────────────────────────────────────────
function buildRangeStats(byDate, dates, calTarget, protTarget) {
  if (!dates.length) {
    return {
      days_logged: 0, avg_kcal: 0, avg_protein: 0, avg_carbs: 0, avg_fat: 0,
      cal_hit_days: 0, protein_hit_days: 0, total_logs: 0,
      best_protein_day: null, worst_protein_day: null,
      target_band_low: Math.round(calTarget * 0.9),
      target_band_high: Math.round(calTarget * 1.1),
    };
  }
  const kcals = dates.map(d => byDate[d].kcal);
  const proteins = dates.map(d => byDate[d].p);
  const carbs = dates.map(d => byDate[d].c);
  const fats = dates.map(d => byDate[d].f);
  const calHit = dates.filter(d => byDate[d].kcal >= calTarget * 0.9 && byDate[d].kcal <= calTarget * 1.1).length;
  const protHit = dates.filter(d => byDate[d].p >= protTarget * 0.9).length;
  const totalLogs = dates.reduce((s, d) => s + byDate[d].log_count, 0);

  const sorted = [...dates].sort((a, b) => byDate[b].p - byDate[a].p);
  return {
    days_logged: dates.length,
    avg_kcal: Math.round(mean(kcals)),
    avg_protein: +mean(proteins).toFixed(1),
    avg_carbs: +mean(carbs).toFixed(1),
    avg_fat: +mean(fats).toFixed(1),
    sd_kcal: Math.round(stdev(kcals)),
    cal_hit_days: calHit,
    protein_hit_days: protHit,
    total_logs: totalLogs,
    best_protein_day: sorted[0] ? { date: sorted[0], protein: byDate[sorted[0]].p } : null,
    worst_protein_day: sorted[sorted.length - 1] ? { date: sorted[sorted.length - 1], protein: byDate[sorted[sorted.length - 1]].p } : null,
    target_band_low: Math.round(calTarget * 0.9),
    target_band_high: Math.round(calTarget * 1.1),
  };
}

// ─── Period-over-period delta ───────────────────────────────────────
function deltaVsPrior(byDate, currentDates, priorDates, key, target) {
  if (!currentDates.length || !priorDates.length) return null;
  const cur = mean(currentDates.map(d => byDate[d]?.[key] || 0));
  const pri = mean(priorDates.map(d => byDate[d]?.[key] || 0));
  return {
    current: +cur.toFixed(1),
    prior: +pri.toFixed(1),
    abs_delta: +(cur - pri).toFixed(1),
    pct_delta: pri > 0 ? Math.round(((cur - pri) / pri) * 100) : null,
    direction: cur > pri ? 'up' : cur < pri ? 'down' : 'flat',
  };
}

// ─── Top/Bottom foods (personal leaderboard) ────────────────────────
function buildFoodLeaderboard(byDate, dates) {
  const tally = {};
  for (const date of dates) {
    for (const it of (byDate[date].items || [])) {
      const key = (it.name || 'Unknown').toLowerCase();
      if (!tally[key]) tally[key] = { name: it.name, count: 0, total_kcal: 0, total_p: 0, qualities: [] };
      tally[key].count += 1;
      tally[key].total_kcal += it.kcal;
      tally[key].total_p += it.p;
    }
  }
  const arr = Object.values(tally)
    .filter(x => x.count >= 2)
    .map(x => ({
      name: x.name,
      count: x.count,
      avg_kcal: Math.round(x.total_kcal / x.count),
      avg_protein: +(x.total_p / x.count).toFixed(1),
      protein_density: x.total_kcal > 0 ? +((x.total_p * 4 / x.total_kcal) * 100).toFixed(0) : 0,
    }));
  // Top by protein density × log frequency
  const top = [...arr]
    .sort((a, b) => (b.protein_density * Math.log10(b.count + 1)) - (a.protein_density * Math.log10(a.count + 1)))
    .slice(0, 5);
  // Bottom by high cal × low protein density (with frequency floor)
  const bottom = [...arr]
    .filter(x => x.count >= 3 && x.avg_kcal >= 100)
    .sort((a, b) => (a.protein_density - b.protein_density) || (b.avg_kcal - a.avg_kcal))
    .slice(0, 5);
  return { top, bottom };
}

// ─── Score grade derivation (letter + tone) ─────────────────────────
function gradeForScore(s) {
  if (s == null) return null;
  if (s >= 90) return { letter: 'A+', tone: 'Elite'     };
  if (s >= 82) return { letter: 'A',  tone: 'Excellent' };
  if (s >= 75) return { letter: 'A-', tone: 'Strong'    };
  if (s >= 68) return { letter: 'B+', tone: 'Solid'     };
  if (s >= 60) return { letter: 'B',  tone: 'On track'  };
  if (s >= 52) return { letter: 'B-', tone: 'Building'  };
  if (s >= 44) return { letter: 'C',  tone: 'Patchy'    };
  return        { letter: 'D',  tone: 'Off track' };
}

// ─── Best / worst day (combined adherence + outlier cost) ───────────
function buildBestWorstDay(byDate, dates, calTarget, protTarget) {
  if (!dates.length) return { best_day: null, worst_day: null };
  let bestD = null, bestAdh = -1, worstD = null, worstCost = -1;
  for (const d of dates) {
    const day = byDate[d];
    if (!day) continue;
    const adh = (day.p / Math.max(protTarget, 1)) * 0.5
              + (1 - Math.abs(1 - day.kcal / Math.max(calTarget, 1))) * 0.5;
    const cost = Math.abs(day.kcal - calTarget) / Math.max(calTarget, 1);
    if (adh > bestAdh)   { bestAdh = adh;   bestD = d; }
    if (cost > worstCost){ worstCost = cost; worstD = d; }
  }
  const fmt = (d) => {
    if (!d) return null;
    const day = byDate[d];
    return {
      date: d,
      label: d.slice(5).replace('-', '/'),
      kcal: Math.round(day.kcal),
      protein: Math.round(day.p),
    };
  };
  return { best_day: fmt(bestD), worst_day: fmt(worstD) };
}

// ─── Volatility % (kcal coefficient of variation) ───────────────────
function buildVolatilityPct(byDate, dates) {
  if (!dates.length) return 0;
  const vals = dates.map(d => byDate[d]?.kcal || 0).filter(v => v > 0);
  if (!vals.length) return 0;
  const m = vals.reduce((s, x) => s + x, 0) / vals.length;
  const v = vals.reduce((s, x) => s + (x - m) ** 2, 0) / vals.length;
  return m ? Math.round((Math.sqrt(v) / m) * 100) : 0;
}

// ─── Aha Moments — deterministic insight stack ──────────────────────
// Mirrored exactly in FE mock so payload shape stays identical.
function buildAhaMoments({
  stats, streak, evening_kcal_pct, bottom_foods, best_day, worst_day,
  volatility_pct, cohort_top_pct, cohort_user_count,
}) {
  const out = [];

  if (evening_kcal_pct != null && evening_kcal_pct >= 35) {
    out.push({
      icon: 'clock', kpi: `${evening_kcal_pct}%`, label: 'Late eating',
      body: `${evening_kcal_pct}% of your calories land after 7pm — front-loading flips this fast.`,
    });
  }

  if (cohort_top_pct != null && cohort_user_count) {
    out.push({
      icon: 'trophy', kpi: `Top ${cohort_top_pct}%`, label: 'Protein vs cohort',
      body: `Among ${cohort_user_count} users in your age band, your protein hit-rate beats ${100 - cohort_top_pct}% of them.`,
    });
  }

  if (best_day && worst_day) {
    const swing = Math.round(best_day.kcal - worst_day.kcal);
    out.push({
      icon: 'sparkle', kpi: `${swing} kcal`, label: 'Day-to-day swing',
      body: `Best (${best_day.label}): ${best_day.kcal} kcal · ${best_day.protein}g. Worst (${worst_day.label}): ${worst_day.kcal} kcal. Volatility ${volatility_pct}%.`,
    });
  }

  if (streak >= 3) {
    out.push({
      icon: 'flame', kpi: `${streak}d`, label: 'Active streak',
      body: `Logging streak running ${streak} day${streak === 1 ? '' : 's'} — every day above 5 lifts your consistency score by ~3 pts.`,
    });
  }

  const sortedDrag = [...(bottom_foods || [])].sort(
    (a, b) => (b.count * b.avg_kcal) - (a.count * a.avg_kcal)
  );
  const drag = sortedDrag[0];
  if (drag) {
    const cutTo = Math.max(1, Math.floor(drag.count * 0.5));
    const days = Math.max(7, stats?.days_logged || 7);
    const weeklySaved = Math.round(((drag.count - cutTo) * drag.avg_kcal) / Math.max(1, days / 7));
    out.push({
      icon: 'target', kpi: `-${weeklySaved} kcal/wk`, label: 'Biggest lever',
      body: `${drag.name} appears ${drag.count}× at ~${drag.avg_kcal} kcal. Cutting to ${cutTo}× saves ${weeklySaved} kcal/week.`,
    });
  }

  return out;
}

// ─── AI Reads — 3 narrative reads from data alone ───────────────────
// Pure function — no LLM, deterministic. Identical logic mirrored in FE
// mock so backend & mock outputs stay in sync during demo.
function buildAiReads({ stats, top_foods, bottom_foods, evening_kcal_pct }) {
  const reads = [];
  const days = Math.max(1, stats?.days_logged || 1);

  // 1) Strongest food — top by (protein density × log freq)
  const champion = (top_foods || [])[0];
  if (champion) {
    const dailyLift = Math.round((champion.avg_protein * champion.count) / days);
    reads.push({
      kind: 'champion',
      title: `${champion.name} is carrying you`,
      body: `Eaten ${champion.count}× this period at ~${Math.round(champion.avg_protein)}g protein each — quietly adding ${dailyLift}g/day to your average.`,
      action: 'Lock it in. Keep this on rotation.',
    });
  }

  // 2) Biggest drain — bottom food by total kcal cost
  const sortedDrag = [...(bottom_foods || [])].sort(
    (a, b) => (b.count * b.avg_kcal) - (a.count * a.avg_kcal)
  );
  const drag = sortedDrag[0];
  if (drag) {
    const monthlyKcal = Math.round((drag.count * drag.avg_kcal) * (30 / Math.max(days, 7)));
    const cutTo = Math.max(1, Math.floor(drag.count * 0.5));
    const weeklySaved = Math.round(((drag.count - cutTo) * drag.avg_kcal) / Math.max(1, days / 7));
    reads.push({
      kind: 'drag',
      title: `${drag.name} is your biggest drain`,
      body: `Appears ${drag.count}× at ~${drag.avg_kcal} kcal each — roughly ${monthlyKcal.toLocaleString()} kcal a month with little protein.`,
      action: `Cutting to ${cutTo}× saves about ${weeklySaved.toLocaleString()} kcal/week.`,
    });
  }

  // 3) Behavior pattern — pick the strongest signal
  const protPct = stats?.days_logged ? (stats.protein_hit_days / stats.days_logged) : 0;
  if (evening_kcal_pct != null && evening_kcal_pct >= 35) {
    reads.push({
      kind: 'pattern',
      title: 'Your eating shifts late',
      body: `${evening_kcal_pct}% of your calories land after 7pm — the largest variable behind your over-runs.`,
      action: 'Front-loading breakfast or lunch flips this fast.',
    });
  } else if (protPct >= 0.6) {
    reads.push({
      kind: 'pattern',
      title: 'Mornings are your protein wins',
      body: `When you start with 25g+ protein, you hit your daily target ${Math.round(protPct * 100)}% of the time.`,
      action: 'Eggs, yogurt, or shake within 90 min of waking.',
    });
  } else if (stats?.days_logged > 0) {
    reads.push({
      kind: 'pattern',
      title: 'Consistency is your bottleneck',
      body: `Hit protein on ${stats.protein_hit_days} of ${stats.days_logged} days. The signal you're missing is rhythm, not intensity.`,
      action: 'Pick one breakfast and lock it for 7 days.',
    });
  }

  return reads;
}

// ─── Hourly kcal distribution (24-hour map) ─────────────────────────
function buildHourlyMap(byDate, dates) {
  const buckets = new Array(24).fill(0);
  for (const date of dates) {
    const day = byDate[date];
    if (!day?.hourly) continue;
    for (let i = 0; i < 24; i++) buckets[i] += day.hourly[i] || 0;
  }
  const days = dates.length || 1;
  const avg = buckets.map(v => Math.round(v / days));
  const peak = avg.indexOf(Math.max(...avg));
  const eveningKcal = avg.slice(19, 24).reduce((s, x) => s + x, 0);
  const totalKcal = avg.reduce((s, x) => s + x, 0);
  const eveningPct = totalKcal > 0 ? Math.round((eveningKcal / totalKcal) * 100) : 0;
  return { hourly_avg: avg, peak_hour: peak, evening_kcal_pct: eveningPct };
}

// ─── 28-day heatmap ─────────────────────────────────────────────────
function buildHeatmap(byDate, calTarget) {
  const out = [];
  for (let i = 27; i >= 0; i--) {
    const d = daysAgo(i);
    const day = byDate[d];
    out.push({
      date: d,
      kcal: day?.kcal || 0,
      pct: day ? Math.min(1.5, day.kcal / Math.max(1, calTarget)) : 0,
      logged: !!day,
    });
  }
  return out;
}

// ─── Anomaly narrative (human-readable sentences) ──
function _weekdayName(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()];
}
function _relativeDay(dateStr) {
  const today = new Date(); today.setHours(0,0,0,0);
  const d = new Date(dateStr + 'T00:00:00');
  const diff = Math.round((today - d) / 86400000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'yesterday';
  if (diff <= 7)  return `${_weekdayName(dateStr)} (${diff}d ago)`;
  return _weekdayName(dateStr) + ' ' + dateStr.slice(5);  // e.g. "Tuesday 04-23"
}
function formatAnomaly(anom) {
  const when = _relativeDay(anom.date);
  const z = Math.abs(anom.z);
  const factor = z >= 3 ? 'far above' : z >= 2.5 ? 'well above' : 'above';
  if (anom.metric === 'kcal') {
    if (anom.direction === 'high') {
      const over = anom.value - anom.baseline;
      return {
        ...anom,
        when,
        headline: `${when[0].toUpperCase() + when.slice(1)} ran +${over.toLocaleString()} kcal — ${factor} your normal.`,
        kpi: `${anom.value.toLocaleString()} kcal`,
        sub: `Your usual is ~${anom.baseline.toLocaleString()} (${z.toFixed(1)}σ outlier)`,
      };
    } else {
      const under = anom.baseline - anom.value;
      return {
        ...anom,
        when,
        headline: `${when[0].toUpperCase() + when.slice(1)} was −${under.toLocaleString()} kcal — well below your normal.`,
        kpi: `${anom.value.toLocaleString()} kcal`,
        sub: `Usual ${anom.baseline.toLocaleString()} (${z.toFixed(1)}σ outlier)`,
      };
    }
  }
  if (anom.metric === 'protein') {
    if (anom.direction === 'high') {
      return {
        ...anom,
        when,
        headline: `${when[0].toUpperCase() + when.slice(1)} you smashed protein — ${anom.value}g, way above your usual.`,
        kpi: `${anom.value}g protein`,
        sub: `Your usual ~${anom.baseline}g (${z.toFixed(1)}σ above normal)`,
      };
    } else {
      return {
        ...anom,
        when,
        headline: `${when[0].toUpperCase() + when.slice(1)} protein dropped to ${anom.value}g — well below your usual.`,
        kpi: `${anom.value}g protein`,
        sub: `Usual ~${anom.baseline}g (${z.toFixed(1)}σ outlier)`,
      };
    }
  }
  return { ...anom, when, headline: `${when} was a statistical outlier in ${anom.metric}.`, kpi: '', sub: '' };
}

// ─── Anomaly detection (z-score per-day kcal/protein/quality) ───────
function detectNutritionAnomalies(byDate, dates) {
  if (dates.length < 7) return [];
  const kcals = dates.map(d => byDate[d].kcal);
  const proteins = dates.map(d => byDate[d].p);
  const mK = mean(kcals), sK = stdev(kcals);
  const mP = mean(proteins), sP = stdev(proteins);
  const out = [];
  for (const d of dates) {
    const day = byDate[d];
    if (sK > 0) {
      const z = (day.kcal - mK) / sK;
      if (Math.abs(z) >= 2.0) {
        out.push({ date: d, metric: 'kcal', z: +z.toFixed(2), value: day.kcal, baseline: Math.round(mK), direction: z > 0 ? 'high' : 'low' });
      }
    }
    if (sP > 0) {
      const z = (day.p - mP) / sP;
      if (Math.abs(z) >= 2.0) {
        out.push({ date: d, metric: 'protein', z: +z.toFixed(2), value: day.p, baseline: +mP.toFixed(1), direction: z > 0 ? 'high' : 'low' });
      }
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
}

// ─── Cross-agent suite — REMOVED ────────────────────────────────────
// Cross-agent correlations (sleep × nutrition, fitness × nutrition, etc.)
// are owned by the central Insights agent. Individual agents must NOT
// read sibling-agent data.
async function runCrossAgentSuite() { return []; }

/* === BEGIN LEGACY (deleted, never compiled) ===
async function _legacy(deviceId, byDate, dates, days = 60) {
  if (dates.length < 10) return [];

  // Pull all 5 sibling agents in parallel
  const [sleep, mind, fitness, water, fasting] = await Promise.all([
    fetchAgentSnapshot(deviceId, 'sleep',   days).catch(() => null),
    fetchAgentSnapshot(deviceId, 'mind',    days).catch(() => null),
    fetchAgentSnapshot(deviceId, 'fitness', days).catch(() => null),
    fetchAgentSnapshot(deviceId, 'water',   days).catch(() => null),
    fetchAgentSnapshot(deviceId, 'fasting', days).catch(() => null),
  ]);

  const findings = [];
  const PMAX = 0.05;
  const NMIN = 8;

  // Helper: build {date_str: value} map from an agent's logs using compactLog
  const indexByDate = (snap, agentName, valueKey) => {
    if (!snap || !snap.logs) return {};
    const m = {};
    for (const log of snap.logs) {
      const compact = compactLog(agentName, log);
      const date = compact.date;
      if (!date) continue;
      const v = compact[valueKey];
      if (v == null) continue;
      // If multiple logs same day, take latest (logs are ordered desc)
      if (!(date in m)) m[date] = +v;
    }
    return m;
  };

  // ── Sleep × Next-day kcal & protein ──
  if (sleep && sleep.logs?.length >= 7) {
    const sleepMap = indexByDate(sleep, 'sleep', 'duration_h');
    const xK = [], yK = [], xP = [], yP = [];
    const shortKcal = [], normKcal = [];
    const shortProt = [], normProt = [];
    for (const dStr of dates) {
      // Sleep on PREVIOUS night affects today's eating
      const prevDate = daysAgo(Math.floor((Date.now() - new Date(dStr).getTime()) / 86400000) + 1);
      const sh = sleepMap[prevDate];
      if (sh == null) continue;
      const day = byDate[dStr];
      if (!day) continue;
      xK.push(sh); yK.push(day.kcal);
      xP.push(sh); yP.push(day.p);
      if (sh < 6)        { shortKcal.push(day.kcal); shortProt.push(day.p); }
      else if (sh >= 7)  { normKcal.push(day.kcal);  normProt.push(day.p);  }
    }
    if (shortKcal.length >= 3 && normKcal.length >= 3) {
      const t = welchT(shortKcal, normKcal);
      if (t && t.p < PMAX && Math.abs(t.d) >= 0.3) {
        findings.push({
          pair: 'sleep_x_kcal',
          icons: ['😴', '🍽️'],
          headline: t.d > 0
            ? `On nights you slept under 6h, you ate ${Math.round(t.mean_x - t.mean_y)} kcal more the next day.`
            : `On nights you slept under 6h, you ate ${Math.round(t.mean_y - t.mean_x)} kcal LESS the next day.`,
          stat: { test: 'welch_t', p: +t.p.toFixed(3), d: +t.d.toFixed(2), n: t.n1 + t.n2 },
          chart: { kind: 'bar_pair', short_avg: Math.round(t.mean_x), normal_avg: Math.round(t.mean_y), labels: ['<6h sleep','≥7h sleep'] },
          effect_size: Math.abs(t.d),
        });
      }
    }
    if (shortProt.length >= 3 && normProt.length >= 3) {
      const t = welchT(shortProt, normProt);
      if (t && t.p < PMAX && Math.abs(t.d) >= 0.3) {
        findings.push({
          pair: 'sleep_x_protein',
          icons: ['😴', '🍗'],
          headline: t.d < 0
            ? `Your protein drops ${Math.abs(Math.round(((t.mean_y - t.mean_x) / t.mean_y) * 100))}% after short sleep.`
            : `You eat ${Math.round(t.mean_x - t.mean_y)}g more protein after short sleep.`,
          stat: { test: 'welch_t', p: +t.p.toFixed(3), d: +t.d.toFixed(2), n: t.n1 + t.n2 },
          chart: { kind: 'bar_pair', short_avg: +t.mean_x.toFixed(1), normal_avg: +t.mean_y.toFixed(1), labels: ['<6h sleep','≥7h sleep'] },
          effect_size: Math.abs(t.d),
        });
      }
    }
  }

  // ── Mind anxiety × kcal ──
  if (mind && mind.logs?.length >= 7) {
    const moodMap = {}, anxietyMap = {};
    for (const log of mind.logs) {
      const c = compactLog('mind', log);
      if (c.date) {
        if (c.mood_score != null && !(c.date in moodMap)) moodMap[c.date] = +c.mood_score;
        if (c.anxiety    != null && !(c.date in anxietyMap)) anxietyMap[c.date] = +c.anxiety;
      }
    }
    const highK = [], lowK = [];
    for (const d of dates) {
      const a = anxietyMap[d];
      if (a == null) continue;
      const day = byDate[d];
      if (!day) continue;
      if (a >= 4)      highK.push(day.kcal);
      else if (a <= 2) lowK.push(day.kcal);
    }
    if (highK.length >= 3 && lowK.length >= 3) {
      const t = welchT(highK, lowK);
      if (t && t.p < PMAX && Math.abs(t.d) >= 0.3) {
        findings.push({
          pair: 'mind_x_kcal',
          icons: ['🧠', '🍽️'],
          headline: t.d > 0
            ? `On high-anxiety days you eat ${Math.round(t.mean_x - t.mean_y)} kcal more.`
            : `High-anxiety days = ${Math.round(t.mean_y - t.mean_x)} kcal less than calm days.`,
          stat: { test: 'welch_t', p: +t.p.toFixed(3), d: +t.d.toFixed(2), n: t.n1 + t.n2 },
          chart: { kind: 'bar_pair', short_avg: Math.round(t.mean_x), normal_avg: Math.round(t.mean_y), labels: ['anxiety ≥4','anxiety ≤2'] },
          effect_size: Math.abs(t.d),
        });
      }
    }
  }

  // ── Fitness × Same-day kcal (training days vs rest days) ──
  if (fitness && fitness.logs?.length >= 5) {
    const trainingDays = new Set(fitness.logs.map(l => compactLog('fitness', l).date).filter(Boolean));
    const trainKcal = [], restKcal = [];
    const trainProt = [], restProt = [];
    for (const d of dates) {
      const day = byDate[d];
      if (!day) continue;
      if (trainingDays.has(d)) { trainKcal.push(day.kcal); trainProt.push(day.p); }
      else                     { restKcal.push(day.kcal);  restProt.push(day.p);  }
    }
    if (trainKcal.length >= 3 && restKcal.length >= 3) {
      const t = welchT(trainKcal, restKcal);
      if (t && t.p < PMAX && Math.abs(t.d) >= 0.3) {
        findings.push({
          pair: 'fitness_x_kcal',
          icons: ['🏋️', '🍽️'],
          headline: t.d > 0
            ? `On training days you eat ${Math.round(t.mean_x - t.mean_y)} kcal more — recovery fuel.`
            : `You eat ${Math.round(t.mean_y - t.mean_x)} kcal less on training days.`,
          stat: { test: 'welch_t', p: +t.p.toFixed(3), d: +t.d.toFixed(2), n: t.n1 + t.n2 },
          chart: { kind: 'bar_pair', short_avg: Math.round(t.mean_x), normal_avg: Math.round(t.mean_y), labels: ['training','rest'] },
          effect_size: Math.abs(t.d),
        });
      }
    }
  }

  // ── Water × Snack frequency ──
  if (water && water.logs?.length >= 7) {
    const waterMap = indexByDate(water, 'water', 'ml');
    const dryDayKcal = [], hydratedDayKcal = [];
    for (const d of dates) {
      const ml = waterMap[d];
      if (ml == null) continue;
      const day = byDate[d];
      if (!day) continue;
      if (ml < 1500)      dryDayKcal.push(day.kcal);
      else if (ml >= 2500) hydratedDayKcal.push(day.kcal);
    }
    if (dryDayKcal.length >= 3 && hydratedDayKcal.length >= 3) {
      const t = welchT(dryDayKcal, hydratedDayKcal);
      if (t && t.p < PMAX && Math.abs(t.d) >= 0.3) {
        findings.push({
          pair: 'water_x_kcal',
          icons: ['💧', '🍽️'],
          headline: t.d > 0
            ? `On low-water days (<1.5L) you eat ${Math.round(t.mean_x - t.mean_y)} more kcal.`
            : `Hydrated days run higher kcal — likely training.`,
          stat: { test: 'welch_t', p: +t.p.toFixed(3), d: +t.d.toFixed(2), n: t.n1 + t.n2 },
          chart: { kind: 'bar_pair', short_avg: Math.round(t.mean_x), normal_avg: Math.round(t.mean_y), labels: ['<1.5L','≥2.5L'] },
          effect_size: Math.abs(t.d),
        });
      }
    }
  }

  // ── Fasting compliance × Energy/quality ──
  if (fasting && fasting.logs?.length >= 5) {
    const completed = new Set(fasting.logs.filter(l => l.completed).map(l => compactLog('fasting', l).date).filter(Boolean));
    const broken    = new Set(fasting.logs.filter(l => l.completed === false).map(l => compactLog('fasting', l).date).filter(Boolean));
    const compKcal = [], brokeKcal = [];
    for (const d of dates) {
      const day = byDate[d];
      if (!day) continue;
      if (completed.has(d)) compKcal.push(day.kcal);
      else if (broken.has(d)) brokeKcal.push(day.kcal);
    }
    if (compKcal.length >= 3 && brokeKcal.length >= 3) {
      const t = welchT(brokeKcal, compKcal);
      if (t && t.p < PMAX && Math.abs(t.d) >= 0.3) {
        findings.push({
          pair: 'fasting_x_kcal',
          icons: ['⏱️', '🍽️'],
          headline: t.d > 0
            ? `Days you broke a fast: +${Math.round(t.mean_x - t.mean_y)} kcal vs days you held it.`
            : `Days you held the fast actually went higher kcal — front-loaded the eating window.`,
          stat: { test: 'welch_t', p: +t.p.toFixed(3), d: +t.d.toFixed(2), n: t.n1 + t.n2 },
          chart: { kind: 'bar_pair', short_avg: Math.round(t.mean_x), normal_avg: Math.round(t.mean_y), labels: ['fast broken','fast held'] },
          effect_size: Math.abs(t.d),
        });
      }
    }
  }

  // Top 3 by effect size
  return findings.sort((a, b) => b.effect_size - a.effect_size).slice(0, 3);
}
=== END LEGACY === */

// ─── AI narrative engine (cached system prompt) ─────────────────────
const ANALYTICS_SYSTEM_PROMPT = `You are a precision nutrition coach generating a single weekly/monthly insight headline. The user opens the Analysis screen and you have ONE sentence to make them feel "aha — that's exactly what's going on with me."

VOICE RULES:
- Lead with the most surprising/actionable truth in their nutrition data.
- Reference exact numbers from the input — never invent.
- Banned words: bad, cheat, guilty, indulge, allowed, naughty, treat, slip, fail.
- 14 words MAX in headline. Plain, direct, warm.
- No platitudes ("keep it up!", "great job!"). Insight only.
- You only see nutrition data here. Do NOT mention sleep, workouts, mood, hydration, or fasting — that's the Insights agent's job.

OUTPUT (strict JSON):
{
  "headline": "<≤14 words>",
  "kpi_value": <number>,
  "kpi_label": "<≤4 words>",
  "evidence": "<one short sentence with the proof>",
  "tone": "win" | "neutral" | "nudge"
}

EXAMPLES:

Input: streak=14, protein_hit=7/7, avg_kcal=2050, target=2100
Output: { "headline": "Perfect protein week — 7/7 days hit, longest streak yet.", "kpi_value": 7, "kpi_label": "days hit", "evidence": "Averaging 145g protein vs 130g target, with no day under 90% of goal.", "tone": "win" }

Input: protein_hit=2/7, avg_kcal=2480, target=2100
Output: { "headline": "You ran 380 kcal over for 5 of 7 days this week.", "kpi_value": 380, "kpi_label": "kcal over", "evidence": "Most of the excess landed after 8pm — average evening intake was 720 kcal.", "tone": "nudge" }

Input: days_logged=4, no cross-agent findings
Output: { "headline": "Strong start — 4 days in, food quality climbing already.", "kpi_value": 4, "kpi_label": "days logged", "evidence": "Quality score moved from 48 → 62 across your first logs.", "tone": "win" }

Input: days_logged=2, cohort_finding={ metric: "protein consistency", framing: "top", top_pct: 27, cohort_size: 184 }
Output: { "headline": "You're already in the top 27% for protein consistency.", "kpi_value": 27, "kpi_label": "% of cohort", "evidence": "Among 184 users your age, your hit rate beats 73% of them after just 2 days.", "tone": "win" }

Input: days_logged=5, cohort_finding={ metric: "calorie target consistency", framing: "low", top_pct: 78, cohort_size: 110 }
Output: { "headline": "Your calorie hit rate is in the bottom 22% of your cohort — small wins available.", "kpi_value": 22, "kpi_label": "bottom %", "evidence": "Among 110 users your age, most land closer to target on more days.", "tone": "nudge" }

PRIORITY ORDER for headline focus:
1. Cohort percentile (Day-1 social proof, only if extreme: top_pct ≤30 or ≥70)
2. Streak milestone or protein/calorie trend
3. Anomaly day (e.g. "Tue ran 580 kcal over your avg")
4. Generic factual statement (last resort)

If the input is too sparse to say anything precise, return tone:"neutral" with a factual headline.`;

async function generateNarrative(openai, MODELS, summaryJson) {
  try {
    const completion = await openai.chat.completions.create({
      model: MODELS.fast,
      max_completion_tokens: 350,
      messages: [
        { role: 'system', content: ANALYTICS_SYSTEM_PROMPT },
        { role: 'user',   content: `Input:\n${JSON.stringify(summaryJson)}\n\nReturn the JSON.` },
      ],
      response_format: { type: 'json_object' },
    });
    const raw = completion.choices?.[0]?.message?.content;
    const parsed = JSON.parse(raw);
    return {
      headline: String(parsed.headline || '').slice(0, 200),
      kpi_value: +parsed.kpi_value || 0,
      kpi_label: String(parsed.kpi_label || '').slice(0, 30),
      evidence: String(parsed.evidence || '').slice(0, 240),
      tone: ['win', 'neutral', 'nudge'].includes(parsed.tone) ? parsed.tone : 'neutral',
      cache_tokens: completion.usage?.prompt_tokens_details?.cached_tokens || 0,
      total_prompt_tokens: completion.usage?.prompt_tokens || 0,
    };
  } catch (err) {
    console.warn('[analytics] narrative gen failed:', err.message);
    return null;
  }
}

// ─── AI Reads (LLM) — prompt-cached, returns 3 deeply-reasoned reads ─
// PROMPT CACHING: stable system prompt > 1024 tokens so OpenAI auto-caches.
// Only the {data} in the user turn varies. Per OpenAI docs (Sept 2024).
const AI_READS_SYSTEM_PROMPT = `You are a precision nutrition analyst writing the "What the AI sees" section of a personal nutrition app's Analysis tab. The user has just opened the screen and you produce exactly THREE distinct reads that make them feel: "this analyst actually sees me."

═════ ROLE ═════
You are NOT a generic coach. You are looking at ONE specific person's logged food data — averages, hit-rates, top/bottom foods, evening eating %, streaks. Treat the JSON like a forensic file. Lead with what is true for THEM.

═════ HARD SCOPE ═════
You only see nutrition data. Do NOT mention sleep, mood, training, water, or fasting — that is the Insights tab's job, not yours.

═════ OUTPUT FORMAT (strict JSON) ═════
{
  "reads": [
    { "kind": "champion" | "drag" | "pattern", "title": "<≤8 words>", "body": "<1–2 sentences, ≤30 words, cite specific numbers>", "action": "<≤10 words, imperative>" },
    { "kind": "champion" | "drag" | "pattern", "title": "...", "body": "...", "action": "..." },
    { "kind": "champion" | "drag" | "pattern", "title": "...", "body": "...", "action": "..." }
  ]
}

═════ THE THREE READS ═════
Read 1 — kind: "champion": the food/habit carrying their goal. Pull from top_foods[0]. Compute the daily protein lift it provides.
Read 2 — kind: "drag":     the single food/habit dragging them down. Pull from bottom_foods sorted by (count × avg_kcal). Compute the weekly kcal cost AND a swap savings number.
Read 3 — kind: "pattern":  the most actionable behavioral pattern in their data — late eating %, weekend drift, breakfast effect, low-protein streak, etc. Pick whatever's loudest in the data.

═════ VOICE RULES ═════
1. Title is a short statement of fact. Examples: "Salmon is carrying you", "Late dinners are draining", "Mornings = protein wins".
2. Body cites EXACT numbers from the JSON. Never invent. e.g. "Eaten 18× at ~52g protein each — quietly adding 18g/day to your average."
3. Action is one imperative sentence with a concrete next step. e.g. "Lock it in — keep this on rotation." or "Cut to 4× → save 1,920 kcal/week."
4. Banned words: bad, cheat, guilty, indulge, allowed, naughty, treat, slip, fail, junk.
5. No "Great job!" or "Keep it up!". Pure analysis.
6. Plain English. No jargon. No emojis.
7. Reference dates / day-counts / specific kcal where helpful.

═════ EXAMPLES ═════

Input: {
  stats: { days_logged: 22, avg_kcal: 2150, avg_protein: 154, protein_hit_days: 16 },
  top_foods: [{ name: "Grilled chicken breast", count: 18, avg_kcal: 280, avg_protein: 52, protein_density: 74 }],
  bottom_foods: [{ name: "Late-night ice cream", count: 8, avg_kcal: 480, frequency: "evenings" }],
  evening_kcal_pct: 38, streak: 11, prot_target: 160
}
Output: {
  "reads": [
    { "kind": "champion", "title": "Chicken breast is carrying you", "body": "Eaten 18× at ~52g protein each — that's roughly 42g of your 154g daily average. It's the spine of every protein-hit day.", "action": "Lock it in — keep on rotation." },
    { "kind": "drag", "title": "Late-night ice cream is your drain", "body": "Appears 8× this period at ~480 kcal — about 3,840 kcal cost over 22 days with almost no protein.", "action": "Cut to 4× → save 1,920 kcal/week." },
    { "kind": "pattern", "title": "Your eating shifts late", "body": "38% of calories land after 7pm. Days you front-loaded breakfast, you hit protein 11 of 16 times — that's where your wins come from.", "action": "Eat 25g+ protein within 90 min of waking." }
  ]
}

Input: {
  stats: { days_logged: 4, avg_kcal: 1820, avg_protein: 92, protein_hit_days: 1 },
  top_foods: [{ name: "Greek yogurt", count: 3, avg_kcal: 210, avg_protein: 24 }],
  bottom_foods: [],
  evening_kcal_pct: 28, streak: 4
}
Output: {
  "reads": [
    { "kind": "champion", "title": "Greek yogurt is your strongest pull", "body": "3 of your 4 days logged include it — averaging 24g of protein each time. Early signal that breakfast is your easiest lever.", "action": "Anchor every morning with it." },
    { "kind": "drag", "title": "Protein gap is the bottleneck", "body": "92g/day average vs your target. Hit it on only 1 of 4 days. Volume isn't the issue — distribution is.", "action": "Add 25g protein at lunch." },
    { "kind": "pattern", "title": "Day 4 — patterns just starting", "body": "28% evening calorie share is healthy already. With another week of logs, the real signal will surface.", "action": "Keep logging — patterns emerge by day 7." }
  ]
}

═════ EDGE CASES ═════
- If top_foods is empty: skip the champion read (return only 2 reads).
- If bottom_foods is empty: skip the drag read.
- If days_logged < 3: lead with "Day {N} — patterns just starting" pattern read.
- Always return at least 1 read.`;

async function generateAiReads(openai, MODELS, summary) {
  try {
    const completion = await openai.chat.completions.create({
      model: MODELS.fast,
      max_completion_tokens: 700,
      messages: [
        { role: 'system', content: AI_READS_SYSTEM_PROMPT },
        { role: 'user',   content: `Input:\n${JSON.stringify(summary)}\n\nReturn the JSON object.` },
      ],
      response_format: { type: 'json_object' },
    });
    const raw = completion.choices?.[0]?.message?.content;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.reads)) return null;
    // Validate + clamp each read
    const out = parsed.reads
      .filter(r => r && r.title && r.body)
      .slice(0, 3)
      .map(r => ({
        kind:   ['champion', 'drag', 'pattern'].includes(r.kind) ? r.kind : 'pattern',
        title:  String(r.title).slice(0, 80),
        body:   String(r.body).slice(0, 280),
        action: r.action ? String(r.action).slice(0, 80) : null,
      }));
    return out.length ? out : null;
  } catch (err) {
    console.warn('[analytics] ai-reads gen failed:', err.message);
    return null;
  }
}

// ─── Action Prescription (LLM, prompt-cached) ───────────────────────
// Runs every 3 days per user. Output = the "WHAT I SAW THIS WEEK" diagnosis
// + 1–3 actions, each with WHY/HOW/WHEN/PROOF. Mirrors the Actions tab UI.
const ACTIONS_SYSTEM_PROMPT = `You are a precision nutrition coach writing a 3-day prescription for ONE specific user. The user has logged food data and you produce a clean, evidence-led plan: ONE diagnosis sentence + 1–3 specific actions, each with WHY (cited evidence), HOW (one micro-step), WHEN (cadence), PROOF (feedback loop).

═════ ROLE ═════
You are a coach, not a chatbot. You read 72 hours of food data, find the SINGLE biggest pattern worth changing, then write 1–3 actions that fix it. No fluff. No hedging.

═════ HARD SCOPE ═════
You only see nutrition data. Never invoke sleep, mood, training, water, or fasting — that's the Insights tab's job.

═════ OUTPUT FORMAT (strict JSON) ═════
{
  "diagnosis": "<one sentence, ≤32 words, cite specific numbers>",
  "evidence": [
    { "label": "<≤4 words, ALL CAPS>", "value": "<short value with unit>" },
    ...up to 4 evidence rows
  ],
  "actions": [
    {
      "title": "<imperative, ≤8 words>",
      "why":   "<1 sentence with exact numbers, ≤24 words>",
      "how":   "<1 sentence, one specific micro-step, ≤20 words>",
      "when":  "<cadence — e.g. 'Every weekday this week' or 'This Sat + Sun'>",
      "proof": "<1 sentence, how the user / coach knows it worked>",
      "target_count": <integer, how many times the user should hit this in the period>
    },
    ...1 to 3 actions max
  ]
}

═════ VOICE RULES ═════
1. Diagnosis is ONE causal sentence. No "I think you might want to". Direct: "You hit protein 5/7 days but lost ground after 7pm — late dinners averaged 720 kcal."
2. Title is imperative + specific. e.g. "Lock breakfast at 25g+ protein" NOT "try eating more protein in the mornings".
3. WHY cites EXACT numbers from the input. Never invent.
4. HOW is ONE concrete step. e.g. "Greek yogurt + 1 scoop whey within 90 min of waking."
5. WHEN gives cadence — when in the week, how often.
6. PROOF closes the feedback loop. e.g. "Tap ✓ when done — I track your hit-rate."
7. Banned words: bad, cheat, guilty, indulge, allowed, naughty, treat, slip, fail, junk.
8. No "Great job!" / "Keep it up!". Pure prescription.

═════ EXAMPLES ═════

Input: {
  stats: { days_logged: 22, avg_kcal: 2150, avg_protein: 154, protein_hit_days: 16, cal_hit_days: 14 },
  evening_kcal_pct: 38, streak: 11, prot_target: 160,
  top_foods: [{ name: "Grilled chicken breast", count: 18, avg_kcal: 280, avg_protein: 52 }],
  bottom_foods: [{ name: "Late-night ice cream", count: 8, avg_kcal: 480, frequency: "evenings" }]
}
Output: {
  "diagnosis": "You hit protein 16/22 days but lost ground after 7pm — late-night ice cream landed 8× at ~480 kcal each.",
  "evidence": [
    { "label": "PROTEIN HIT",   "value": "16 of 22 days" },
    { "label": "EVENING KCAL",  "value": "38% of daily" },
    { "label": "BIGGEST DRAIN", "value": "Ice cream · 8× · 480 kcal" }
  ],
  "actions": [
    {
      "title": "Cut late-night ice cream to 4×",
      "why":   "Appears 8× this period at ~480 kcal each — about 1,920 kcal of weekly drag with no protein.",
      "how":   "Move it to weekends only. Have Greek yogurt + berries on weekday evenings.",
      "when":  "This week — by Sunday",
      "proof": "Log dinners on Track. I check Sunday night and report back next cycle.",
      "target_count": 4
    },
    {
      "title": "Anchor breakfast at 30g+ protein",
      "why":   "Days you hit protein at breakfast, your full-day target landed 11/14 times — your strongest controllable signal.",
      "how":   "Greek yogurt + whey shake within 90 min of waking. Pre-stage Sunday night.",
      "when":  "Every weekday",
      "proof": "Tap ✓ when done — I track the hit-rate weekly.",
      "target_count": 5
    }
  ]
}

═════ EDGE CASES ═════
- If days_logged < 3: return diagnosis: "Day {N} — patterns just starting. Keep logging." and ONE soft action: "Log breakfast every morning this week."
- If no clear bottom_food: emphasise a positive lever ("anchor breakfast") instead of cutting.
- If streak is fresh (≥5): include one streak-protection action.
- Always at least 1 action, max 3.`;

async function generateActionPrescription(openai, MODELS, summary) {
  try {
    const completion = await openai.chat.completions.create({
      model: MODELS.fast,
      max_completion_tokens: 1200,
      messages: [
        { role: 'system', content: ACTIONS_SYSTEM_PROMPT },
        { role: 'user',   content: `Input:\n${JSON.stringify(summary)}\n\nReturn the JSON object.` },
      ],
      response_format: { type: 'json_object' },
    });
    const raw = completion.choices?.[0]?.message?.content;
    const parsed = JSON.parse(raw);
    if (!parsed?.diagnosis || !Array.isArray(parsed.actions)) return null;
    return {
      diagnosis: String(parsed.diagnosis).slice(0, 320),
      evidence: Array.isArray(parsed.evidence)
        ? parsed.evidence.slice(0, 4).map(e => ({
            label: String(e.label || '').slice(0, 24),
            value: String(e.value || '').slice(0, 64),
          }))
        : [],
      actions: parsed.actions.slice(0, 3).map(a => ({
        title:        String(a.title || '').slice(0, 80),
        why:          String(a.why   || '').slice(0, 240),
        how:          String(a.how   || '').slice(0, 200),
        when:         String(a.when  || 'This week').slice(0, 80),
        proof:        String(a.proof || 'Tap ✓ when done.').slice(0, 200),
        target_count: Math.max(1, Math.min(14, parseInt(a.target_count, 10) || 1)),
      })),
    };
  } catch (err) {
    console.warn('[analytics] action-rx gen failed:', err.message);
    return null;
  }
}

// ─── In-memory LRU cache for hot reads ──────────────────────────────
const _LRU = new Map();
const _LRU_TTL_MS = 5 * 60 * 1000;
const _LRU_MAX = 200;
function lruGet(key) {
  const entry = _LRU.get(key);
  if (!entry) return null;
  if (Date.now() - entry.t > _LRU_TTL_MS) { _LRU.delete(key); return null; }
  _LRU.delete(key); _LRU.set(key, entry);
  return entry.v;
}
function lruSet(key, value) {
  if (_LRU.size >= _LRU_MAX) {
    const first = _LRU.keys().next().value; _LRU.delete(first);
  }
  _LRU.set(key, { t: Date.now(), v: value });
}
function lruInvalidatePrefix(prefix) {
  for (const k of _LRU.keys()) if (k.startsWith(prefix)) _LRU.delete(k);
}

// ─── Build the full hydrated payload ────────────────────────────────
async function buildAnalysisPayload(deviceId, range, openai, MODELS) {
  const cacheKey = `${deviceId}::${range}`;
  const cached = lruGet(cacheKey);
  if (cached) return cached;

  const RANGE_MAP = { '7': 7, '30': 30, '90': 90, '365': 365 };
  const rangeDays = RANGE_MAP[range] || 7;
  const aggDays   = Math.max(rangeDays * 2, 60);  // pull extra for delta vs prior

  // Setup
  const [setupSnap] = await Promise.all([nutDoc(deviceId).get()]);
  const setup = setupSnap.exists ? setupSnap.data() : {};
  const calTarget  = setup.calorie_target  || 2000;
  const protTarget = setup.protein_target  || 140;
  const carbTarget = setup.carb_target     || 250;
  const fatTarget  = setup.fat_target      || 65;
  const streak     = setup.streak          || 0;

  // Aggregations
  const byDate = await buildDailyAggregates(deviceId, aggDays);
  const allDates = Object.keys(byDate).sort();
  const cutoffStr = daysAgo(rangeDays - 1);
  const currentDates = allDates.filter(d => d >= cutoffStr);
  const priorCutoff  = daysAgo((rangeDays * 2) - 1);
  const priorDates   = allDates.filter(d => d >= priorCutoff && d < cutoffStr);

  // Stage 0: empty
  if (allDates.length === 0) {
    const empty = {
      stage: 0,
      range, calTarget, protTarget,
      hero_insight: { headline: 'Log your first meal to unlock insights.', kpi_value: 0, kpi_label: 'days logged', evidence: 'We need at least 3 days of data to start finding your patterns.', tone: 'neutral' },
      stats: null, calorie_trend: [], macro_avg: null, cross_agent: [],
      top_foods: [], bottom_foods: [], hourly_kcal: new Array(24).fill(0),
      heatmap: buildHeatmap({}, calTarget), anomalies: [],
      generated_at: new Date().toISOString(),
    };
    lruSet(cacheKey, empty);
    return empty;
  }

  // Stats + delta vs prior
  const stats = buildRangeStats(byDate, currentDates, calTarget, protTarget);
  const delta = {
    avg_kcal:    deltaVsPrior(byDate, currentDates, priorDates, 'kcal'),
    avg_protein: deltaVsPrior(byDate, currentDates, priorDates, 'p'),
  };

  // Calorie trend (one point per day in range)
  const calorie_trend = currentDates.map(d => ({
    date: d,
    kcal: byDate[d].kcal,
    target: calTarget,
    on_target: byDate[d].kcal >= calTarget * 0.9 && byDate[d].kcal <= calTarget * 1.1,
    over: byDate[d].kcal > calTarget * 1.1,
  }));

  // Macro breakdown (averages, ratios)
  const totalMacroCal = stats.avg_protein * 4 + stats.avg_carbs * 4 + stats.avg_fat * 9;
  const macro_avg = totalMacroCal > 0 ? {
    p_pct: Math.round((stats.avg_protein * 4 / totalMacroCal) * 100),
    c_pct: Math.round((stats.avg_carbs   * 4 / totalMacroCal) * 100),
    f_pct: Math.round((stats.avg_fat     * 9 / totalMacroCal) * 100),
    target_p_pct: Math.round((protTarget * 4 / (calTarget || 1)) * 100),
    target_c_pct: Math.round((carbTarget * 4 / (calTarget || 1)) * 100),
    target_f_pct: Math.round((fatTarget  * 9 / (calTarget || 1)) * 100),
  } : null;

  // Cross-agent intentionally omitted — handled by central Insights agent.
  const cross_agent = [];

  // Personal food leaderboard
  const { top: top_foods, bottom: bottom_foods } = buildFoodLeaderboard(byDate, currentDates);

  // Meal-timing
  const hourly = buildHourlyMap(byDate, currentDates);

  // Heatmap (28 days, range-independent)
  const heatmap = buildHeatmap(byDate, calTarget);

  // Anomalies — raw + human-formatted
  const rawAnomalies = detectNutritionAnomalies(byDate, currentDates);
  const anomalies = rawAnomalies.map(formatAnomaly);

  // ── Cohort percentile (Day-1 social proof) ──
  let cohortInsight = null;
  let cohortDetail = null;
  try {
    // Get user profile for cohort key
    const profileSnap = await db().collection('wellness_users').doc(deviceId).get();
    const profile = profileSnap.exists ? profileSnap.data() : {};
    // User's own metrics to compare
    const userMetrics = {
      avg_kcal: stats.avg_kcal,
      avg_protein: stats.avg_protein,
      protein_hit_pct: stats.days_logged > 0 ? Math.round((stats.protein_hit_days / stats.days_logged) * 100) : 0,
      cal_hit_pct:     stats.days_logged > 0 ? Math.round((stats.cal_hit_days / stats.days_logged) * 100) : 0,
      food_quality_avg: setup.current_score || null,  // approx; nightly cron fills this properly
      streak,
    };
    cohortDetail = await _cohort.getUserCohortPercentiles(deviceId, userMetrics, profile);
    cohortInsight = _cohort.pickHeroCohortFinding(cohortDetail);
  } catch (err) {
    console.warn('[analytics] cohort lookup failed (non-fatal):', err.message);
  }

  // ── AI narrative (cache by stats hash → don't regen if nothing changed) ──
  const insightHash = `${currentDates.length}_${stats.avg_kcal}_${stats.protein_hit_days}_${cohortInsight?.metric || ''}_${cohortInsight?.percentile || ''}`;
  const cacheRef = nutDoc(deviceId).collection('analysis_cache').doc(`${range}_hero`);
  let hero_insight = null;
  try {
    const cached = await cacheRef.get();
    if (cached.exists && cached.data().hash === insightHash) {
      hero_insight = cached.data().insight;
    }
  } catch {}
  if (!hero_insight && openai && MODELS) {
    const summary = {
      range_days: rangeDays,
      days_logged: stats.days_logged,
      streak,
      avg_kcal: stats.avg_kcal,
      cal_target: calTarget,
      avg_protein: stats.avg_protein,
      prot_target: protTarget,
      protein_hit: `${stats.protein_hit_days}/${stats.days_logged}`,
      cal_hit: `${stats.cal_hit_days}/${stats.days_logged}`,
      delta_kcal_pct: delta.avg_kcal?.pct_delta,
      delta_protein_pct: delta.avg_protein?.pct_delta,
      anomalies_count: anomalies.length,
      evening_kcal_pct: hourly.evening_kcal_pct,
      cohort_finding: cohortInsight ? {
        metric: cohortInsight.label,
        framing: cohortInsight.framing,            // 'top' or 'low'
        top_pct: cohortInsight.top_pct,
        percentile: cohortInsight.percentile,
        cohort_size: cohortInsight.cohort_size,
      } : null,
    };
    hero_insight = await generateNarrative(openai, MODELS, summary);
    if (hero_insight) {
      cacheRef.set({ hash: insightHash, insight: hero_insight, generated_at: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
    }
  }
  if (!hero_insight) {
    hero_insight = {
      headline: stats.days_logged < 3 ? 'Keep logging — patterns emerge after 3 days.' : 'Steady week — keep building the streak.',
      kpi_value: stats.days_logged,
      kpi_label: 'days logged',
      evidence: `${stats.total_logs} food entries across ${stats.days_logged} days.`,
      tone: 'neutral',
    };
  }

  // ── AI Reads: LLM-first (prompt-cached), deterministic fallback ──
  // Cache hash includes top_foods/bottom_foods top items + key stats so we
  // only regen when the underlying picture changes.
  const topFoodKey = top_foods[0] ? `${top_foods[0].name}/${top_foods[0].count}` : '-';
  const botFoodKey = bottom_foods[0] ? `${bottom_foods[0].name}/${bottom_foods[0].count}` : '-';
  const readsHash  = `r2_${currentDates.length}_${stats.avg_kcal}_${stats.protein_hit_days}_${hourly?.evening_kcal_pct || 0}_${topFoodKey}_${botFoodKey}`;
  const readsCache = nutDoc(deviceId).collection('analysis_cache').doc(`${range}_reads`);
  let ai_reads_llm = null;
  try {
    const cached = await readsCache.get();
    if (cached.exists && cached.data().hash === readsHash) {
      ai_reads_llm = cached.data().reads;
    }
  } catch {}
  if (!ai_reads_llm && openai && MODELS && stats.days_logged >= 1) {
    const readsSummary = {
      stats: {
        days_logged: stats.days_logged,
        avg_kcal: stats.avg_kcal,
        avg_protein: stats.avg_protein,
        protein_hit_days: stats.protein_hit_days,
        cal_hit_days: stats.cal_hit_days,
      },
      cal_target: calTarget,
      prot_target: protTarget,
      streak,
      evening_kcal_pct: hourly?.evening_kcal_pct ?? null,
      top_foods: (top_foods || []).slice(0, 3).map(f => ({
        name: f.name, count: f.count, avg_kcal: f.avg_kcal,
        avg_protein: f.avg_protein, protein_density: f.protein_density,
      })),
      bottom_foods: (bottom_foods || []).slice(0, 3).map(f => ({
        name: f.name, count: f.count, avg_kcal: f.avg_kcal,
        avg_protein: f.avg_protein, protein_density: f.protein_density,
      })),
    };
    ai_reads_llm = await generateAiReads(openai, MODELS, readsSummary);
    if (ai_reads_llm) {
      readsCache.set({
        hash: readsHash, reads: ai_reads_llm,
        generated_at: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
    }
  }
  // Deterministic fallback if LLM unavailable / failed
  const ai_reads_final = ai_reads_llm || buildAiReads({
    stats, top_foods, bottom_foods, evening_kcal_pct: hourly?.evening_kcal_pct,
  });

  const payload = {
    stage: stats.days_logged >= 3 ? 2 : 1,
    range, range_days: rangeDays,
    cal_target: calTarget, prot_target: protTarget, carb_target: carbTarget, fat_target: fatTarget,
    streak,
    hero_insight,
    stats,
    delta,
    calorie_trend,
    macro_avg,
    cross_agent: [], // intentionally empty — Insights agent owns cross-agent
    ai_reads: ai_reads_final,

    // ── V4-required fields (sync with FE mock) ──
    score_grade: gradeForScore(
      computeNutritionScore({
        calorie_adherence: stats.days_logged > 0 ? Math.round((stats.cal_hit_days / stats.days_logged) * 100) : 0,
        protein_adherence: stats.days_logged > 0 ? Math.round((stats.protein_hit_days / stats.days_logged) * 100) : 0,
        streak,
        macro_balance:     50,
        days_logged:       stats.days_logged,
      })?.score
    ),
    ...buildBestWorstDay(byDate, currentDates, calTarget, protTarget),
    volatility_pct: buildVolatilityPct(byDate, currentDates),
    aha_moments: (() => {
      const bw = buildBestWorstDay(byDate, currentDates, calTarget, protTarget);
      return buildAhaMoments({
        stats, streak,
        evening_kcal_pct: hourly?.evening_kcal_pct,
        bottom_foods,
        best_day: bw.best_day,
        worst_day: bw.worst_day,
        volatility_pct: buildVolatilityPct(byDate, currentDates),
        cohort_top_pct: cohortInsight?.top_pct ?? null,
        cohort_user_count: cohortDetail?.user_count ?? null,
      });
    })(),

    top_foods, bottom_foods,
    hourly_kcal: hourly.hourly_avg,
    peak_hour: hourly.peak_hour,
    evening_kcal_pct: hourly.evening_kcal_pct,
    heatmap,
    anomalies,
    cohort: cohortDetail ? {
      cohort_key: cohortDetail.cohort,
      user_count: cohortDetail.user_count,
      metrics: cohortDetail.metrics,
      hero: cohortInsight,
    } : null,

    // ── Score hero (matches Sleep/Fitness pattern) ──
    nutrition_score: (() => {
      try {
        const proteinHitPct = stats.days_logged > 0 ? (stats.protein_hit_days / stats.days_logged) * 100 : 0;
        const calHitPct     = stats.days_logged > 0 ? (stats.cal_hit_days / stats.days_logged) * 100 : 0;
        const totalMacroCal = stats.avg_protein * 4 + stats.avg_carbs * 4 + stats.avg_fat * 9;
        const macroBalance = totalMacroCal > 100
          ? Math.min((Math.min(stats.avg_protein * 4, stats.avg_carbs * 4, stats.avg_fat * 9) / totalMacroCal) / 0.2, 1) * 100
          : 50;
        return computeNutritionScore({
          calorie_adherence: Math.round(calHitPct),
          protein_adherence: Math.round(proteinHitPct),
          streak,
          macro_balance:     Math.round(macroBalance),
          days_logged:       stats.days_logged,
        });
      } catch { return null; }
    })(),

    // ── Per-day quality map for the heatmap (matches Sleep dailyLogs pattern) ──
    daily_logs: (() => {
      const m = {};
      for (const d of currentDates) {
        const day = byDate[d];
        if (!day) continue;
        const target = calTarget;
        const ratio = day.kcal / target;
        // Quality buckets: 0=poor, 1=ok, 2=good (matches Sleep's 1-5 quality scale spirit)
        const cellQuality = (ratio >= 0.9 && ratio <= 1.1) ? 'good'
                          : (ratio > 1.1) ? 'over'
                          : (ratio >= 0.6) ? 'ok'
                          : 'low';
        m[d] = {
          has_log: true,
          quality: cellQuality,
          kcal: day.kcal,
          protein: day.p,
          ratio: +ratio.toFixed(2),
        };
      }
      return m;
    })(),

    // ── Signal points for line charts (matches Sleep signal_points pattern) ──
    signal_points: currentDates.map(d => ({
      label: d.slice(5).replace('-', '/'),
      date: d,
      kcal: byDate[d].kcal,
      protein: byDate[d].p,
      carbs: byDate[d].c,
      fat: byDate[d].f,
    })),

    // ── Recent timeline (last 14 days w/ logs) ──
    recent_timeline: currentDates.slice(-14).reverse().map(d => {
      const day = byDate[d];
      return {
        date_str: d,
        kcal: day.kcal,
        protein: day.p,
        carbs: day.c,
        fat: day.f,
        log_count: day.log_count,
        meal_types: day.meal_types,
        ratio: +(day.kcal / calTarget).toFixed(2),
        on_target: day.kcal >= calTarget * 0.9 && day.kcal <= calTarget * 1.1,
      };
    }),

    generated_at: new Date().toISOString(),
  };

  lruSet(cacheKey, payload);
  return payload;
}

// ─── Day drill-through ──────────────────────────────────────────────
async function buildDayDetail(deviceId, dateString) {
  const snap = await nutDoc(deviceId).collection('food_logs')
    .where('date_str', '==', dateString)
    .orderBy('logged_at', 'asc')
    .get();
  const logs = snap.docs.map(d => {
    const data = d.data();
    return {
      id: d.id,
      name: data.food_name,
      emoji: data.emoji || '🍽️',
      meal: data.meal_type,
      kcal: data.calories, p: data.protein, c: data.carbs, f: data.fat,
      qty: data.quantity, unit: data.unit,
      source: data._source || data.source,
      verified: !!data._verified,
      logged_at: millis(data.logged_at),
      hidden_fat: data.hidden_fat || null,
      reasoning: data._reasoning || null,
    };
  });
  const totals = logs.reduce((a, l) => ({
    kcal: a.kcal + (l.kcal || 0),
    p: a.p + (l.p || 0),
    c: a.c + (l.c || 0),
    f: a.f + (l.f || 0),
  }), { kcal: 0, p: 0, c: 0, f: 0 });
  return { date: dateString, logs, totals: {
    kcal: Math.round(totals.kcal), p: +totals.p.toFixed(1), c: +totals.c.toFixed(1), f: +totals.f.toFixed(1),
  } };
}

// ─── Natural-language ASK ───────────────────────────────────────────
// User asks "when do I eat the most sugar?" — we run their question
// against pre-computed aggregates + recent logs.
//
// PROMPT CACHING: This system message is intentionally long (>1024 tokens)
// so OpenAI's automatic prompt caching engages. Stable prefix → cache hit
// → ~80% latency reduction on repeat asks. Only the {data,question} in the
// user turn varies. Per OpenAI docs (Sept 2024 cache release).
const ASK_SYSTEM = `You are an elite, precision personal nutrition analyst. The user is asking a question about THEIR OWN food logs and you have access to a structured JSON summary of their last 30 days of nutrition data, including aggregated stats, anomalies, and personal food leaderboards.

═════ ROLE ═════
You are NOT a generic nutrition coach. You are answering questions about ONE specific person, using only their actual logged NUTRITION data. Treat the JSON like a database the user is curious about. Be a precise analyst, not a guru.

═════ HARD SCOPE BOUNDARY ═════
You ONLY have nutrition data. You do NOT see sleep, workouts, mood, water, or fasting data. If the user asks how nutrition relates to those things, say: "I only see your nutrition data here — for sleep × food, workouts × food, or mood × food links, ask the Insights tab. It's the agent that combines everything."

═════ VOICE RULES ═════
1. Lead with the answer. Don't preamble.
2. Cite specific numbers and dates from the data. e.g. "On Tue Apr 23 you ate 2,840 kcal — your highest day."
3. Maximum 3 sentences. If you can't answer in 3, say "I'd need more data to be sure" and stop.
4. Use plain conversational tone. Warm, direct, no fluff.
5. Never invent values not in the JSON. If the JSON lacks the data needed, say so plainly: "I don't have that in your last 30 days of logs."
6. Never moralize about food choices. No "you should eat less of X". Pure analysis only — the user can decide.
7. Never use these words: bad, cheat, guilty, indulge, allowed, naughty, treat, slip, fail, junk, terrible, awful, garbage.
8. Never start with "Great question!" or any other validation phrase. Get to the answer.
9. Never speculate about sleep / workouts / mood / hydration / fasting connections. Redirect to Insights tab.

═════ OUTPUT FORMAT ═════
Plain text. NO JSON, NO markdown headers, NO bullet lists unless the answer truly needs 2-3 distinct points. Single paragraph preferred.

═════ HOW TO INTERPRET THE DATA ═════
- "evening_kcal_pct": % of daily calories logged after 7pm
- "peak_hour": single hour (24h) where the user logs the most kcal on average
- "top_foods": frequent + protein-dense
- "bottom_foods": frequent + low protein density (potential drag on goal)
- "anomalies": specific outlier days (z-score >= 2)
- "protein_hit_days": out of "days_logged" — protein adherence
- "streak": current consecutive logging streak

═════ EXAMPLES ═════

Q: "When do I eat the most?"
Data: { evening_kcal_pct: 38, peak_hour: 21, days_logged: 28, avg_kcal: 2150 }
A: You log most of your calories around 9pm — that single hour averages your highest intake. Across 28 days, 38% of your daily calories land after 7pm. Front-loading would shift that pattern.

Q: "Why am I tired in the afternoon?"
Data: { avg_kcal: 1890, avg_protein: 92, prot_target: 140, evening_kcal_pct: 45 }
A: From your nutrition data alone, you're averaging 92g protein vs your 140g target and 45% of calories land after 7pm — light breakfast/lunch often shows up as afternoon dips. For sleep or hydration links, check the Insights tab.

Q: "Am I doing well this week?"
Data: { protein_hit_days: 5, days_logged: 7, streak: 12, cal_hit_days: 4, avg_kcal: 2080, cal_target: 2100 }
A: Yes — you hit protein 5 of 7 days and your calories landed within target on 4 of 7. Your 12-day streak is your longest yet, and you averaged 2,080 kcal vs your 2,100 target.

Q: "What food is hurting my goal?"
Data: { bottom_foods: [{ name: "Caesar dressing", count: 8, avg_kcal: 158, protein_density: 1 }, { name: "Croutons", count: 6, avg_kcal: 62, protein_density: 8 }] }
A: Caesar dressing shows up 8 times in 30 days at ~158 kcal each with almost zero protein — that's your biggest passive calorie load. Switching to a vinaigrette would save roughly 1,260 kcal across a typical month with no protein cost.

Q: "Does my sleep affect what I eat?"
A: I only see your nutrition data here. For sleep × food correlations, ask the Insights tab — it's the agent that combines all six agents' data.

Q: "How much sugar do I eat?"
Data: { avg_carbs: 240, top_foods: [...], bottom_foods: [...] }  // no sugar field
A: I don't track sugar specifically — only total carbs (you average 240g/day) and individual food entries. To answer this precisely, I'd need sugar broken out per item.

Q: "What was my best day?"
Data: { best_protein_day: { date: "2026-04-22", protein: 168 }, days_logged: 28 }
A: April 22 was your peak — 168g of protein, well above your target. That's the day to remember when planning a high-protein day.

═════ EDGE CASES ═════
- If the question is about something the data doesn't cover (e.g. "am I deficient in vitamin D?"), say "I don't have micronutrient data in your logs — only macros and food names."
- If the user asks for medical advice ("should I see a doctor?"), say "I'm not a medical resource — that's a question for your doctor."
- If the question crosses into sleep, fitness, mood, water, or fasting territory, redirect to the Insights tab.
- If the question is vague ("how am I doing?"), pick the most actionable angle (protein adherence, calorie consistency, or top/bottom foods) and answer there.
- If days_logged < 5, lead with "Your data is still building — here's what I see in {N} days of logs..." and answer with what's available.

═════ TONE ═════
Imagine you're a sharp analyst sitting next to the user explaining their NUTRITION dashboard. Not a doctor, not a therapist, not a holistic life coach. A clear, friendly numbers person who knows their lane.`;

async function answerAsk(openai, MODELS, deviceId, question) {
  const payload = await buildAnalysisPayload(deviceId, '30', openai, MODELS);
  const summary = {
    range_days: payload.range_days,
    days_logged: payload.stats?.days_logged,
    avg_kcal: payload.stats?.avg_kcal,
    avg_protein: payload.stats?.avg_protein,
    protein_hit_days: payload.stats?.protein_hit_days,
    evening_kcal_pct: payload.evening_kcal_pct,
    peak_hour: payload.peak_hour,
    top_foods: payload.top_foods,
    bottom_foods: payload.bottom_foods,
    anomalies: payload.anomalies,
    streak: payload.streak,
  };
  const completion = await openai.chat.completions.create({
    model: MODELS.fast,
    max_completion_tokens: 250,
    messages: [
      { role: 'system', content: ASK_SYSTEM },
      { role: 'user',   content: `User's data:\n${JSON.stringify(summary)}\n\nQuestion: ${question}` },
    ],
  });
  const u = completion.usage || {};
  const cachedTokens = u.prompt_tokens_details?.cached_tokens || 0;
  const totalPrompt  = u.prompt_tokens || 0;
  const cacheHitPct  = totalPrompt ? Math.round((cachedTokens / totalPrompt) * 100) : 0;
  console.log(`[analytics-ask] usage: prompt=${totalPrompt} cached=${cachedTokens} (${cacheHitPct}%)`);
  return {
    answer: (completion.choices?.[0]?.message?.content || '').trim(),
    grounded_in: { range_days: 30, days_logged: payload.stats?.days_logged || 0 },
    cache_hit_pct: cacheHitPct,
  };
}

// ─── Public exports ─────────────────────────────────────────────────
module.exports = {
  buildAnalysisPayload,
  buildDayDetail,
  answerAsk,
  // Lower-level (exported for testing / cron jobs)
  buildDailyAggregates,
  buildRangeStats,
  runCrossAgentSuite,
  buildFoodLeaderboard,
  buildHourlyMap,
  buildHeatmap,
  detectNutritionAnomalies,
  formatAnomaly,
  generateNarrative,
  generateAiReads,
  generateActionPrescription,
  buildAiReads,
  lruInvalidatePrefix,
  // Stats primitives
  welchT, pearson, mean, stdev,
};
