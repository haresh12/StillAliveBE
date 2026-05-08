/**
 * chronotype-engine.js
 *
 * Detect user chronotype from sleep onset (bedtime) clustering.
 *
 * Uses CIRCULAR statistics so cross-midnight times (e.g. mix of 23:30 and 00:30)
 * cluster correctly instead of averaging to 12:00 noon.
 *
 *   bedtime "HH:MM"          → minutes-since-midnight 0..1439
 *   minutes                  → angle θ = (mins / 1440) × 2π
 *   circular mean direction  = atan2(mean(sinθ), mean(cosθ))
 *   circular variance        = 1 − |Σe^iθ|/n,  scaled to minutes via × (1440/2π) ≈ ×229
 *
 * Stability gate: at least MIN_LOGS bedtimes AND variance < MAX_VARIANCE_MIN.
 *
 * Label buckets (mean_onset minutes, normalized so 'late night' wraps past 24h):
 *   < 21:00  → 'early sleeper'
 *   21–22:30 → 'early evening sleeper'
 *   22:30–23:30 → '11pm sleeper'
 *   23:30–00:30 → 'midnight sleeper'
 *   00:30–02:00 → 'late owl'
 *   ≥ 02:00  → 'night owl'
 *
 * Returns:
 *   {
 *     label: string,                  e.g. '10pm sleeper'
 *     mean_onset: 'HH:MM',
 *     variance_min: number,           circular std dev in minutes
 *     kind: string,                   stable id used by clients
 *   }
 *   or null if not enough data / too unstable.
 */

'use strict';

const MIN_LOGS = 7;
const MAX_VARIANCE_MIN = 90;

function timeToMins(hhmm) {
  if (typeof hhmm !== 'string') return null;
  const [h, m] = hhmm.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return ((h % 24) * 60 + (m % 60));
}

function minsToHHMM(mins) {
  const m = ((mins % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const min = Math.round(m - h * 60);
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function circularMean(minsArr) {
  if (!minsArr.length) return null;
  let sumSin = 0, sumCos = 0;
  for (const m of minsArr) {
    const theta = (m / 1440) * 2 * Math.PI;
    sumSin += Math.sin(theta);
    sumCos += Math.cos(theta);
  }
  let theta = Math.atan2(sumSin / minsArr.length, sumCos / minsArr.length);
  if (theta < 0) theta += 2 * Math.PI;
  const mean_min = (theta / (2 * Math.PI)) * 1440;
  // R = mean resultant length ∈ [0,1]; circular variance = 1 − R
  const R = Math.sqrt((sumSin / minsArr.length) ** 2 + (sumCos / minsArr.length) ** 2);
  // Convert to circular std dev in minutes — formula: σ = sqrt(-2 ln R) (radians), *× (1440/2π)
  const sigma_rad = Math.sqrt(Math.max(0, -2 * Math.log(Math.max(R, 1e-9))));
  const sigma_min = (sigma_rad / (2 * Math.PI)) * 1440;
  return { mean_min, variance_min: Math.round(sigma_min) };
}

function labelFor(meanMin) {
  // Normalize to a continuous "evening" axis: shift so 18:00 = 0, late times grow
  // mean in raw 0..1440 range. We bucket directly off raw minutes.
  if (meanMin >= 1080 && meanMin < 1260) return { label: '9pm sleeper',       kind: 'early_evening' };       // 18:00 ≤ x < 21:00
  if (meanMin < 1080) {
    if (meanMin >= 720) return { label: 'early sleeper', kind: 'very_early' };  // 12:00–18:00 (rare nappers)
  }
  if (meanMin >= 1260 && meanMin < 1350) return { label: '10pm sleeper',     kind: 'evening' };               // 21:00 ≤ x < 22:30
  if (meanMin >= 1350 && meanMin < 1410) return { label: '11pm sleeper',     kind: 'late_evening' };          // 22:30 ≤ x < 23:30
  if (meanMin >= 1410 || meanMin < 30)   return { label: 'midnight sleeper', kind: 'midnight' };              // 23:30 ≤ x or x < 00:30
  if (meanMin >= 30 && meanMin < 120)    return { label: 'late owl',         kind: 'late_owl' };              // 00:30 ≤ x < 02:00
  if (meanMin >= 120 && meanMin < 360)   return { label: 'night owl',        kind: 'night_owl' };             // 02:00 ≤ x < 06:00
  return { label: 'irregular sleeper', kind: 'irregular' };
}

/**
 * Detect chronotype from sleep adapter's recent_bedtimes (last 30d, oldest→newest).
 *
 * @param {Array<{date: string, bedtime?: string|null}>} recentBedtimes
 * @returns {Object|null}
 */
function detectChronotype(recentBedtimes) {
  if (!Array.isArray(recentBedtimes) || recentBedtimes.length < MIN_LOGS) return null;
  const minsArr = recentBedtimes
    .map((r) => timeToMins(r && r.bedtime))
    .filter((m) => Number.isFinite(m));
  if (minsArr.length < MIN_LOGS) return null;

  const stats = circularMean(minsArr);
  if (!stats) return null;
  if (stats.variance_min > MAX_VARIANCE_MIN) {
    return {
      label: 'irregular sleeper',
      mean_onset: minsToHHMM(stats.mean_min),
      variance_min: stats.variance_min,
      kind: 'irregular',
    };
  }

  const lab = labelFor(stats.mean_min);
  return {
    label: lab.label,
    mean_onset: minsToHHMM(stats.mean_min),
    variance_min: stats.variance_min,
    kind: lab.kind,
  };
}

module.exports = {
  detectChronotype,
  _internal: { timeToMins, minsToHHMM, circularMean, labelFor, MIN_LOGS, MAX_VARIANCE_MIN },
};
