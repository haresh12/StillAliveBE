'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// hk-signals.js — P1: the Apple Health SIGNALS SSoT.
//
// Reads the raw daily rows P0 stored in wellness_bc_users/{id}/health_samples/*
// and derives the clean signals every consumer uses (analysis, scoring, coach,
// notifications): RECOVERY SCORE (the hero), sleep, steps, HRV/RHR trend,
// weight trend, workouts, water. Deterministic (no LLM). Returns null fields
// where there's no data → no-wearable parity is preserved everywhere downstream.
// ═══════════════════════════════════════════════════════════════════════════
const { userDoc } = require('./collections');

const col = (deviceId) => userDoc(deviceId).collection('health_samples');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r1 = (n) => Math.round(n * 10) / 10;

async function readDays(deviceId, key) {
  try { const s = await col(deviceId).doc(key).get(); return (s.exists && s.data().days) || {}; }
  catch { return {}; }
}
const sorted = (days) => Object.entries(days || {}).sort((a, b) => a[0].localeCompare(b[0])); // asc by date
const lastN = (days, n) => sorted(days).slice(-n);
const nums = (entries) => entries.map(([, v]) => v).filter((v) => typeof v === 'number');
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const latestVal = (days) => { const s = sorted(days); return s.length ? s[s.length - 1][1] : null; };

/**
 * The full HK signal bundle for a device. null if the user has NO Apple Health data at all.
 */
async function getHealthSignals(deviceId) {
  const [steps, active, rhr, hrv, sleep, weight, water, workout, vo2] = await Promise.all([
    readDays(deviceId, 'steps'), readDays(deviceId, 'activeEnergy'), readDays(deviceId, 'restingHeartRate'),
    readDays(deviceId, 'hrv'), readDays(deviceId, 'sleep'), readDays(deviceId, 'weight'),
    readDays(deviceId, 'water'), readDays(deviceId, 'workout'), readDays(deviceId, 'vo2Max'),
  ]);
  const has = (d) => Object.keys(d).length > 0;
  if (![steps, active, rhr, hrv, sleep, weight, water, workout].some(has)) return null;

  // ── Sleep ──
  const sEnt = sorted(sleep);
  const lastSleep = sEnt.length ? sEnt[sEnt.length - 1][1] : null;
  const lastSleepHours = lastSleep && lastSleep.asleep_min ? r1(lastSleep.asleep_min / 60) : null;
  const sleep7 = sEnt.slice(-7).map(([, v]) => (v && v.asleep_min ? v.asleep_min / 60 : null)).filter((h) => h != null);
  const sleep7avg = sleep7.length ? r1(avg(sleep7)) : null;
  const sleepDebt7 = sleep7.length ? r1(sleep7.reduce((s, h) => s + Math.max(0, 7.5 - h), 0)) : null;
  const lastEfficiency = lastSleep && lastSleep.efficiency != null ? lastSleep.efficiency : null;

  // ── HRV / RHR baselines ──
  const hrvLatest = avg(nums(lastN(hrv, 7)));
  const hrvBase = avg(nums(lastN(hrv, 30)));
  const rhrLatest = avg(nums(lastN(rhr, 7)));
  const rhrBase = avg(nums(lastN(rhr, 30)));

  // ── RECOVERY SCORE (the hero) — weighted blend of the sub-signals that exist ──
  const subs = []; const wts = [];
  if (hrvLatest != null && hrvBase) { const r = hrvLatest / hrvBase; subs.push(clamp(50 + (r - 1) * 200, 0, 100)); wts.push(0.4); }
  if (lastSleepHours != null) { subs.push(clamp(((lastSleepHours - 4) / 4) * 100, 0, 100)); wts.push(0.35); }
  if (rhrLatest != null && rhrBase) { const d = (rhrLatest - rhrBase) / rhrBase; subs.push(clamp(50 - d * 500, 0, 100)); wts.push(0.25); }
  let recovery = null, recoveryLabel = null;
  if (subs.length) {
    const wsum = wts.reduce((a, b) => a + b, 0);
    recovery = Math.round(subs.reduce((s, v, i) => s + v * wts[i], 0) / wsum);
    recoveryLabel = recovery >= 75 ? 'high' : recovery >= 50 ? 'moderate' : 'low';
  }

  // ── Activity ──
  const stepsLatest = latestVal(steps);
  const steps7 = avg(nums(lastN(steps, 7)));
  const activeLatest = latestVal(active);

  // ── Weight trend (14d) — actual 14-DAY window (not last 14 weigh-ins), so a weekly weigher gets a
  // real 2-week delta, not a 14-week one. latest weight vs the oldest within the window. ──
  const wAll = sorted(weight);
  const cutoff14 = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
  const wWin = wAll.filter(([d]) => d >= cutoff14);
  const wLatest = wAll.length ? wAll[wAll.length - 1][1] : null;
  const weightTrend14 = (wWin.length > 1 && typeof wWin[0][1] === 'number' && typeof wWin[wWin.length - 1][1] === 'number')
    ? r1(wWin[wWin.length - 1][1] - wWin[0][1]) : null;

  // ── Workouts last 7d ──
  const cutoff = Date.now() - 7 * 86_400_000;
  let wo7 = 0, lastWo = null;
  for (const [d, arr] of sorted(workout)) {
    if (Date.parse(d) < cutoff) continue;
    if (Array.isArray(arr)) { wo7 += arr.length; const a = arr[arr.length - 1]; if (a) lastWo = { ...a, date: d }; }
  }

  return {
    recovery, recovery_label: recoveryLabel,
    sleep: { last_hours: lastSleepHours, last_efficiency: lastEfficiency, avg7: sleep7avg, debt7: sleepDebt7 },
    steps: { latest: stepsLatest != null ? Math.round(stepsLatest) : null, avg7: steps7 != null ? Math.round(steps7) : null },
    active_kcal_latest: activeLatest != null ? Math.round(activeLatest) : null,
    hrv: { latest: hrvLatest != null ? Math.round(hrvLatest) : null, baseline: hrvBase != null ? Math.round(hrvBase) : null },
    rhr: { latest: rhrLatest != null ? Math.round(rhrLatest) : null, baseline: rhrBase != null ? Math.round(rhrBase) : null },
    weight: { latest: typeof wLatest === 'number' ? r1(wLatest) : null, trend14: weightTrend14 },
    water_latest_ml: latestVal(water) != null ? Math.round(latestVal(water)) : null,
    vo2max: latestVal(vo2) != null ? r1(latestVal(vo2)) : null,
    workouts7: { count: wo7, last: lastWo },
  };
}

/**
 * A compact natural-language HK block for the coach briefing (only the meaningful parts).
 * Empty string when there's nothing useful — so non-wearable users add zero noise.
 */
async function healthSignalsText(deviceId) {
  const s = await getHealthSignals(deviceId).catch(() => null);
  if (!s) return '';
  const L = [];
  if (s.recovery != null) {
    const rec = s.recovery_label === 'low' ? 'ease off today, prioritize rest, protein and hydration'
      : s.recovery_label === 'high' ? 'they are primed — a harder session is fine'
      : 'a normal day';
    L.push(`Recovery ${s.recovery}/100 (${s.recovery_label}) — ${rec}.`);
  }
  if (s.sleep.last_hours != null) L.push(`Slept ${s.sleep.last_hours}h last night${s.sleep.last_efficiency != null ? ` (${s.sleep.last_efficiency}% efficiency)` : ''}${s.sleep.debt7 ? `, ~${s.sleep.debt7}h sleep debt this week` : ''}.`);
  if (s.steps.latest != null) L.push(`${s.steps.latest.toLocaleString()} steps recently${s.steps.avg7 != null ? ` (7-day avg ${s.steps.avg7.toLocaleString()})` : ''}.`);
  if (s.hrv.latest != null && s.hrv.baseline != null) L.push(`HRV ${s.hrv.latest}ms vs ${s.hrv.baseline}ms baseline.`);
  if (s.rhr.latest != null && s.rhr.baseline != null) L.push(`Resting HR ${s.rhr.latest} vs ${s.rhr.baseline} baseline.`);
  if (s.weight.latest != null) L.push(`Weight ${s.weight.latest}kg${s.weight.trend14 != null ? ` (${s.weight.trend14 > 0 ? '+' : ''}${s.weight.trend14}kg over ~2 weeks)` : ''}.`);
  if (s.workouts7.count) L.push(`${s.workouts7.count} workout(s) in the last 7 days${s.workouts7.last ? ` — last: ${s.workouts7.last.workout_type} ${s.workouts7.last.minutes}min` : ''}.`);
  if (!L.length) return '';
  return `APPLE HEALTH (from their watch/phone — real body data; weave it in naturally, never say "from your watch"):\n  ${L.join('\n  ')}`;
}

module.exports = { getHealthSignals, healthSignalsText };
