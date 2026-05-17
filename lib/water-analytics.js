const { AI } = require('./ai/models');
/**
 * water-analytics.js — analytics helpers for the Water agent.
 * Mirrors the contract used by fasting-analytics.js so /analysis/v2
 * returns the same shape across all 6 agents.
 *
 * Citations exposed via WATER_CITATIONS so coach reads can attach
 * verifiable proof to every claim.
 */

'use strict';

const round = (n, d = 1) => {
  if (n == null || isNaN(n)) return 0;
  const m = Math.pow(10, d);
  return Math.round(n * m) / m;
};

// ─── PEER-REVIEWED SCIENCE LIBRARY ─────────────────────────────────
// Coach reads use these refs in the proof field. Every claim must cite.
const WATER_CITATIONS = {
  sawka_2007:    { ref: 'Sawka 2007, Med Sci Sports Exerc',  claim: '1.5–2.3% body water loss → cognitive + performance drop' },
  pross_2017:    { ref: 'Pross 2017, Ann Nutr Metab',         claim: '1% dehydration impairs attention + short-term memory' },
  ganio_2011:    { ref: 'Ganio 2011, Br J Nutr',              claim: 'Mild dehydration → measurable mood, fatigue, anxiety' },
  killer_2014:   { ref: 'Killer 2014, PLoS One',              claim: 'Coffee ≤4 cups/day is net hydrating, not dehydrating' },
  forbes_2019:   { ref: 'Forbes 2019, Eur J Clin Nutr',       claim: 'Morning under-hydration is universal across populations' },
  rosinger_2019: { ref: 'Rosinger 2019, Sleep',               claim: 'Short sleep → next-day hypohydration' },
  watson_1980:   { ref: 'Watson 1980, Am J Clin Nutr',        claim: 'Total body water from anthropometric formula' },
  iom_2004:      { ref: 'Institute of Medicine 2004',         claim: '3.7L men / 2.7L women baseline daily intake' },
  armstrong_1994:{ ref: 'Armstrong 1994, Int J Sport Nutr',   claim: 'Urine color hydration scale (1–8)' },
  cheuvront_2014:{ ref: 'Cheuvront 2014, Compr Physiol',      claim: 'Physiological basis of fluid balance' },
};

// ─── DRINK MULTIPLIERS — effective hydration per drink type ────────
// Source: Killer 2014 (caffeine), Maughan 2003 (caffeine review),
// IoM 2004 (baseline), general nutritional literature for milk/sport
const DRINK_MULTIPLIER = {
  water:        1.00,
  sparkling:    1.00,
  tea:          0.95, // caffeine penalty light
  coffee:       0.84, // Killer 2014 finding
  herbal_tea:   1.00,
  milk:         0.92,
  juice:        0.90,
  sport_drink:  1.05, // electrolyte boost
  soda:         0.88,
  alcohol:     -0.50, // diuretic penalty
};

function getMs(v) {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.toDate   === 'function') return v.toDate().getTime();
  const p = new Date(v).getTime();
  return isNaN(p) ? 0 : p;
}

// ─── HYDRATION SCORE ──────────────────────────────────────────────
// 0–100 composite computed from the last `days` days.
// Components:
//   volume        — actual intake / target
//   timing        — drinks distributed across day vs cramming
//   consistency   — variance across days
//   electrolytes  — drink-type variety bonus
function computeHydrationScore({ logs, target_ml, days = 7 }) {
  if (!logs || !logs.length) {
    return {
      score: 0,
      label: 'Begin',
      components: { volume: 0, timing: 0, consistency: 0, electrolytes: 0 },
      days_logged: 0,
      clinical_flag: false,
      clinical_note: null,
    };
  }

  // Group by date
  const byDate = {};
  for (const log of logs) {
    const d = log.date || (log.logged_at ? new Date(getMs(log.logged_at)).toISOString().slice(0,10) : null);
    if (!d) continue;
    if (!byDate[d]) byDate[d] = { ml: 0, eff_ml: 0, hours: new Set(), types: new Set() };
    const mult = DRINK_MULTIPLIER[log.drink_type] ?? 1.0;
    byDate[d].ml      += log.ml || 0;
    byDate[d].eff_ml  += (log.ml || 0) * mult;
    byDate[d].types.add(log.drink_type || 'water');
    if (log.logged_at) {
      const h = new Date(getMs(log.logged_at)).getHours();
      byDate[d].hours.add(h);
    }
  }

  const dateKeys = Object.keys(byDate).slice(-days);
  const dayCount = dateKeys.length;
  if (!dayCount) {
    return { score: 0, label: 'Begin', components: { volume: 0, timing: 0, consistency: 0, electrolytes: 0 }, days_logged: 0, clinical_flag: false, clinical_note: null };
  }

  // Volume component (35%) — avg actual / target
  let totalEff = 0, totalRaw = 0;
  for (const k of dateKeys) {
    totalEff += byDate[k].eff_ml;
    totalRaw += byDate[k].ml;
  }
  const avgEff   = totalEff / dayCount;
  const avgRaw   = totalRaw / dayCount;
  const volumeScore = Math.min(100, (avgEff / Math.max(target_ml, 1)) * 100);

  // Timing component (25%) — circadian distribution
  // Optimal: drinks spread across 6+ distinct hours
  const avgHours = dateKeys.reduce((s, k) => s + byDate[k].hours.size, 0) / dayCount;
  const timingScore = Math.min(100, (avgHours / 7) * 100);

  // Consistency component (25%) — low day-to-day variance
  const dailyEffs = dateKeys.map(k => byDate[k].eff_ml);
  const meanEff   = dailyEffs.reduce((s, v) => s + v, 0) / dayCount;
  const variance  = dailyEffs.reduce((s, v) => s + Math.pow(v - meanEff, 2), 0) / dayCount;
  const stdDev    = Math.sqrt(variance);
  const cv        = meanEff > 0 ? stdDev / meanEff : 1;
  const consistencyScore = Math.max(0, (1 - Math.min(cv, 1)) * 100);

  // Electrolytes component (15%) — drink-type variety + presence of electrolyte-positive
  const allTypes = new Set();
  dateKeys.forEach(k => byDate[k].types.forEach(t => allTypes.add(t)));
  const hasElectrolyte = allTypes.has('sport_drink') || allTypes.has('milk') || allTypes.has('coffee');
  const electrolyteScore = (allTypes.size >= 2 ? 60 : 30) + (hasElectrolyte ? 40 : 0);

  const score = Math.round(
    (volumeScore       * 0.35) +
    (timingScore       * 0.25) +
    (consistencyScore  * 0.25) +
    (Math.min(100, electrolyteScore) * 0.15)
  );

  const clinicalFlag = avgRaw < 1500 && dayCount >= 3;
  const clinicalNote = clinicalFlag
    ? 'Sustained intake below 1.5L/day — consider checking with a clinician if this is your norm.'
    : null;

  return {
    score: Math.max(0, Math.min(100, score)),
    label: score >= 85 ? 'Hydration Master'
         : score >= 70 ? 'Dialed In'
         : score >= 50 ? 'Building'
         : score >= 25 ? 'Early Stage'
         : 'Begin',
    components: {
      volume:       round(volumeScore),
      timing:       round(timingScore),
      consistency:  round(consistencyScore),
      electrolytes: round(electrolyteScore),
    },
    days_logged:   dayCount,
    avg_eff_ml:    round(avgEff),
    avg_raw_ml:    round(avgRaw),
    clinical_flag: clinicalFlag,
    clinical_note: clinicalNote,
  };
}

// ─── DAILY CIRCADIAN CURVE ────────────────────────────────────────
// Returns 24 hour points: actual hydration vs optimal (Forbes 2019).
// Optimal curve: front-loaded mornings (universal under-hydration finding).
function computeDailyCurve({ logs, target_ml, dateKey }) {
  const todaysLogs = logs.filter(l => {
    const d = l.date || (l.logged_at ? new Date(getMs(l.logged_at)).toISOString().slice(0,10) : null);
    return d === dateKey;
  });

  const cumulativeByHour = new Array(24).fill(0);
  for (const l of todaysLogs) {
    if (!l.logged_at) continue;
    const h = new Date(getMs(l.logged_at)).getHours();
    const mult = DRINK_MULTIPLIER[l.drink_type] ?? 1.0;
    cumulativeByHour[h] += (l.ml || 0) * mult;
  }
  // Cumulate forward
  for (let i = 1; i < 24; i++) cumulativeByHour[i] += cumulativeByHour[i-1];

  // Optimal curve — Forbes 2019 — front-loaded:
  // 7am=15%, 9am=30%, 12pm=50%, 3pm=70%, 6pm=85%, 9pm=100%
  const OPTIMAL_FRACTION = [
    0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.05, // 0-6
    0.15, 0.22, 0.30, 0.38, 0.45,             // 7-12
    0.50, 0.58, 0.65, 0.72, 0.78, 0.84,       // 13-18
    0.90, 0.95, 1.00, 1.00, 1.00, 1.00,       // 19-23
  ];
  const tgt = Math.max(1, target_ml);
  return Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    actual_pct:  Math.min(100, round((cumulativeByHour[h] / tgt) * 100)),
    optimal_pct: round(OPTIMAL_FRACTION[h] * 100),
    intake_ml:   round(cumulativeByHour[h]),
  }));
}

// ─── DRINK BREAKDOWN ──────────────────────────────────────────────
function computeDrinkBreakdown(logs) {
  const breakdown = {};
  for (const l of logs) {
    const t = l.drink_type || 'water';
    if (!breakdown[t]) breakdown[t] = { type: t, ml: 0, count: 0, effective_ml: 0 };
    breakdown[t].ml         += l.ml || 0;
    breakdown[t].count      += 1;
    breakdown[t].effective_ml += (l.ml || 0) * (DRINK_MULTIPLIER[t] ?? 1.0);
  }
  return Object.values(breakdown)
    .map(b => ({ ...b, ml: round(b.ml), effective_ml: round(b.effective_ml) }))
    .sort((a, b) => b.ml - a.ml);
}

// ─── DAY-OF-WEEK ──────────────────────────────────────────────────
function computeDayOfWeek(logs, target_ml) {
  const DOW = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const byDow = {};
  for (let i = 0; i < 7; i++) byDow[i] = { ml: 0, days: new Set() };

  for (const l of logs) {
    const ms = getMs(l.logged_at);
    if (!ms) continue;
    const d   = new Date(ms);
    const dow = d.getDay();
    const dKey = d.toISOString().slice(0,10);
    byDow[dow].ml += l.ml || 0;
    byDow[dow].days.add(dKey);
  }

  const scored = Object.entries(byDow)
    .filter(([, v]) => v.days.size >= 1)
    .map(([dow, v]) => ({
      dow:        DOW[Number(dow)],
      avg_ml:     round(v.ml / v.days.size),
      pct:        round((v.ml / v.days.size) / target_ml * 100),
      count:      v.days.size,
    }))
    .sort((a, b) => b.avg_ml - a.avg_ml);

  if (scored.length < 2) return { best_day: null, worst_day: null };
  return { best_day: scored[0], worst_day: scored[scored.length - 1] };
}

// ─── CIRCADIAN SUMMARY ────────────────────────────────────────────
function computeCircadian(logs, target_ml) {
  if (!logs.length) return { score: null, morning_pct: null, evening_pct: null };

  let morningMl = 0, totalMl = 0, eveningMl = 0;
  for (const l of logs) {
    const ms = getMs(l.logged_at);
    if (!ms) continue;
    const h = new Date(ms).getHours();
    const ml = l.ml || 0;
    totalMl += ml;
    if (h < 12) morningMl += ml;
    if (h >= 21) eveningMl += ml;
  }

  if (!totalMl) return { score: 0, morning_pct: 0, evening_pct: 0 };

  const morningPct  = round((morningMl / totalMl) * 100);
  const eveningPct  = round((eveningMl / totalMl) * 100);
  // Score: front-loading is ideal. >40% in morning + <15% post-9pm = high.
  const morningScore = Math.min(100, (morningPct / 40) * 60);
  const eveningPenalty = Math.max(0, (eveningPct - 15) * 2);
  const score = Math.max(0, Math.min(100, morningScore + 40 - eveningPenalty));

  return {
    score:        round(score / 100, 2),
    morning_pct:  morningPct,
    evening_pct:  eveningPct,
  };
}

// ─── AHA MOMENTS ──────────────────────────────────────────────────
// Programmatic insight cards — used as fallback when AI reads unavailable.
function computeAhaMoments(logs, hydrationScore, target_ml) {
  const ahas = [];
  if (!logs.length) return ahas;

  const total_ml      = logs.reduce((s, l) => s + (l.ml || 0), 0);
  const days          = new Set(logs.map(l => l.date || (l.logged_at ? new Date(getMs(l.logged_at)).toISOString().slice(0,10) : null)).filter(Boolean));
  const avg_per_day   = total_ml / Math.max(days.size, 1);
  const breakdown     = computeDrinkBreakdown(logs);
  const coffee        = breakdown.find(b => b.type === 'coffee');

  // Coffee aha — Killer 2014
  if (coffee && coffee.count >= 5) {
    ahas.push({
      type: 'coffee_counts',
      title: `Your coffee counts — ${round(coffee.effective_ml / 1000, 1)}L of real hydration`,
      body: `Coffee at ≤4 cups/day is net hydrating (Killer 2014). Your ${coffee.count} cups added ${round(coffee.effective_ml)} ml of actual hydration.`,
      proof: WATER_CITATIONS.killer_2014.ref,
    });
  }

  // Volume milestone
  if (total_ml >= 100000) {
    ahas.push({
      type: 'volume_milestone',
      title: `${round(total_ml / 1000)}L logged — measurable territory`,
      body: `That volume sustained over weeks correlates with the cognitive + performance gains in Pross 2017 and Ganio 2011.`,
      proof: WATER_CITATIONS.pross_2017.ref,
    });
  }

  // Streak / consistency
  if (hydrationScore?.components?.consistency >= 80) {
    ahas.push({
      type: 'consistency',
      title: `Steady intake — your kidneys can predict you`,
      body: `Consistent daily intake (low day-to-day variance) is the single strongest predictor of long-term metabolic outcomes (Cheuvront 2014).`,
      proof: WATER_CITATIONS.cheuvront_2014.ref,
    });
  }

  // Below target — gentle
  if (avg_per_day < target_ml * 0.7 && days.size >= 3) {
    ahas.push({
      type: 'below_target',
      title: `${round(target_ml - avg_per_day)} ml from your daily target`,
      body: `Hitting target consistently for 7 days lifts attention and mood scores measurably (Pross 2017, Ganio 2011).`,
      proof: WATER_CITATIONS.pross_2017.ref,
    });
  }

  return ahas.slice(0, 3);
}

// ─── PERSONAL FORMULA ─────────────────────────────────────────────
// Single-line punchy verdict for the Verdict card narrative.
function computePersonalFormula({ logs, target_ml, score, dayCount }) {
  if (!logs.length || !dayCount) return null;
  const totalMl = logs.reduce((s, l) => s + (l.ml || 0), 0);
  const avg     = totalMl / dayCount;
  const pct     = round((avg / Math.max(target_ml, 1)) * 100);

  if (score >= 80) {
    return `Averaging ${round(avg)} ml/day — ${pct}% of target. Hydration is now an automatic habit, not a daily decision.`;
  }
  if (score >= 60) {
    return `${pct}% to target on average. The gap is consistency on weekend days — pick the one day you'll never skip and lock it.`;
  }
  if (score >= 40) {
    return `Logging ${pct}% of target. Add one anchor habit — glass with morning coffee — and you'll be over 70% in 7 days.`;
  }
  return `Early days. ${dayCount} day${dayCount === 1 ? '' : 's'} logged. The first week is about logging consistently, not hitting target.`;
}

// ─── SCORE GRADE ──────────────────────────────────────────────────
function scoreGrade(score) {
  if (score >= 90) return 'A+';
  if (score >= 85) return 'A';
  if (score >= 80) return 'A−';
  if (score >= 75) return 'B+';
  if (score >= 70) return 'B';
  if (score >= 65) return 'B−';
  if (score >= 55) return 'C+';
  if (score >= 50) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

// ─── AI READS PROMPT ──────────────────────────────────────────────
const WATER_AI_READS_SYSTEM_PROMPT = `
You are the hydration intelligence analyst inside a premium health app called StillAlive.
Generate three short, punchy, science-backed insight cards for the Insights tab.
These are called "What Moved The Needle" cards.

You receive: target ml, drink logs in the window, aggregate stats, drink breakdown.
You return: strictly valid JSON with three fields: champion, drag, pattern.

CARD DEFINITIONS:
  champion — The single strongest behavioral signal in this window. What is actually working?
             Must be specific to this user's data — not generic hydration advice.
             Example: "Coffee mornings boost your 9–11 AM hydration by 380 ml."
  drag     — The single biggest thing lowering the score. What is holding back progress?
             Must name the exact issue with a number. No vague advice.
             Example: "Sundays average 1.4 L vs your 2.6 L weekday baseline — costing 14 score points."
  pattern  — A behavioral observation that reveals a non-obvious pattern in the data.
             Not good or bad — just true. Should make the user think.
             Example: "Every late-night drink (after 10 PM) is followed by under-hydration the next morning."

EACH CARD FORMAT:
  { "title": string (max 56 chars, no period), "body": string (1 sentence, max 130 chars, sharp, data-driven) }

STRICT RULES:
  • Use exact numbers from the data provided. Never invent metrics.
  • Write in second person ("Your..." not "The user...").
  • No generic hydration advice ("stay hydrated", "drink more water") — all cards specific to THIS user.
  • No emojis. No markdown. No code fences.
  • Cite real research where natural — Pross 2017, Killer 2014, Forbes 2019, Rosinger 2019 — but only when the data warrants.
  • If insufficient data (< 3 logged days), set all three cards to null.

OUTPUT FORMAT (strict — no other keys, no extra text):
{
  "champion": { "title": "...", "body": "..." } | null,
  "drag":     { "title": "...", "body": "..." } | null,
  "pattern":  { "title": "...", "body": "..." } | null
}
`.trim();

async function generateAiReads(logs, target_ml, hydrationScore, openai, deviceId) {
  const breakdown = computeDrinkBreakdown(logs);
  const days      = new Set(logs.map(l => l.date || (l.logged_at ? new Date(getMs(l.logged_at)).toISOString().slice(0,10) : null)).filter(Boolean));

  if (days.size < 3) {
    return { champion: null, drag: null, pattern: null };
  }

  const total_ml  = logs.reduce((s, l) => s + (l.ml || 0), 0);
  const avg       = total_ml / days.size;
  const breakdownLine = breakdown.slice(0, 4).map(b => `${b.type} ${b.count}× (${b.ml} ml)`).join(', ');

  const userCtx = [
    `Target: ${target_ml} ml/day.`,
    `Window: ${days.size} days. Total logs: ${logs.length}.`,
    `Avg intake: ${round(avg)} ml/day (${round(avg / target_ml * 100)}% of target).`,
    `Score: ${hydrationScore?.score ?? '—'} (${hydrationScore?.label ?? '—'}).`,
    `Drink breakdown: ${breakdownLine || 'none'}.`,
  ].join('\n');

  // HK enrichment — append the user's water-from-Apple-Health rollup to the
  // user message so the AI can cite it ("Apple Health shows 1.6L today").
  let userMsg = userCtx;
  let hkRule = '';
  try {
    const { withHKEnrichment, HK_PROMPT_RULE } = require('./healthkit/analytics-helper');
    const enriched = await withHKEnrichment({
      deviceId,
      coach: 'water',
      payload: { stats_context: userCtx },
    });
    userMsg = `${userCtx}\n\nALSO_AVAILABLE_DATA:\n${enriched}`;
    hkRule = `\n\n${HK_PROMPT_RULE}`;
  } catch { /* HK is enrichment, never required */ }

  try {
    const resp = await openai.chat.completions.create({
      model: AI.CHAT_STREAM,
      max_completion_tokens: 600,
      messages: [
        { role: 'system', content: `${WATER_AI_READS_SYSTEM_PROMPT}${hkRule}` },
        { role: 'user',   content: userMsg },
      ],
    });
    const raw = resp.choices[0].message.content.trim().replace(/```json|```/g, '');
    const parsed = JSON.parse(raw);
    return {
      champion: parsed.champion || null,
      drag:     parsed.drag     || null,
      pattern:  parsed.pattern  || null,
    };
  } catch (e) {
    log.error('[water-analytics] generateAiReads:', e.message);
    return { champion: null, drag: null, pattern: null };
  }
}

module.exports = {
  WATER_CITATIONS,
  DRINK_MULTIPLIER,
  computeHydrationScore,
  computeDailyCurve,
  computeDrinkBreakdown,
  computeDayOfWeek,
  computeCircadian,
  computeAhaMoments,
  computePersonalFormula,
  scoreGrade,
  generateAiReads,
  WATER_AI_READS_SYSTEM_PROMPT,
};
