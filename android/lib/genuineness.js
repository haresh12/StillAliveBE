'use strict';

// ═══════════════════════════════════════════════════════════════
// genuineness.js — "Up to X" earn scorer.
//
// Translates a log payload into an actual credit amount in [floor, ceiling]
// based on signal richness, freshness, and consistency. Higher genuineness
// → user earns closer to the ceiling.
//
// Used by /api/android/coins/earn-log (the per-coach log earn route).
//
// Inputs: { deviceId, coach, payload, recentSignals }
//   payload         — coach-specific log data (whatever the coach POSTed)
//   recentSignals   — { lastLogAtMs, todayLogCount, weeklyConsistency }
//
// Returns { amount, ceiling, floor, score, reasons[] }
// ═══════════════════════════════════════════════════════════════

const PER_COACH_CEILING = Object.freeze({
  sleep:     100,
  nutrition: 100,
  fitness:   100,
  mind:      50,
  fasting:   50,
  water:     30,
  plan:      50,  // plan-item check (every tick earns up to 50)
});
const PER_COACH_FLOOR = Object.freeze({
  sleep:     20,
  nutrition: 20,
  fitness:   20,
  mind:      10,
  fasting:   10,
  water:     5,
  plan:      15,  // floor 15 → max 50 per plan check, well-balanced
});

function ceilingFor(coach) { return PER_COACH_CEILING[coach] ?? 25; }
function floorFor(coach)   { return PER_COACH_FLOOR[coach]   ?? 5;  }

/**
 * Score a log on [0, 1] genuineness. Higher = more genuine.
 * Heuristics — kept simple, no LLM, fast to compute server-side:
 *
 *   +0.25 baseline (the log happened at all)
 *   +0.30 if payload has rich content (voice transcript >40 chars,
 *         photo URL present, ≥3 fields filled)
 *   +0.15 if user has logged ≥4 days in last 7 (sustained habit)
 *   +0.15 if not the 2nd+ log of the same coach today (no spam)
 *   +0.10 if logged within a "natural" window (last log was >3h ago,
 *         meaning this isn't burst-logging for coins)
 *   +0.05 small bonus for voice/camera over manual (richer signal)
 *
 * Capped at 1.0. Then amount = floor + (ceiling - floor) * score.
 */
function scoreGenuineness({ coach, payload = {}, recentSignals = {} }) {
  const reasons = [];
  let score = 0.25;
  reasons.push('baseline_log');

  // Rich content
  const transcriptLen = String(payload.transcript || payload.description || '').trim().length;
  const hasPhoto = Boolean(payload.photo_url || payload.image_url || payload.photoUri);
  const filledFieldCount = Object.values(payload).filter(
    (v) => v !== null && v !== undefined && v !== '' && (typeof v !== 'object' || Object.keys(v || {}).length > 0)
  ).length;

  if (transcriptLen >= 40 || hasPhoto || filledFieldCount >= 3) {
    score += 0.30;
    reasons.push(transcriptLen >= 40 ? 'rich_transcript' : hasPhoto ? 'has_photo' : 'multi_field');
  }

  // Sustained habit
  const weeklyDays = Number(recentSignals.weeklyConsistencyDays ?? 0);
  if (weeklyDays >= 4) {
    score += 0.15;
    reasons.push('sustained_habit');
  }

  // No spam (first log of this coach today)
  const todayLogCount = Number(recentSignals.todayLogCount ?? 0);
  if (todayLogCount === 0) {
    score += 0.15;
    reasons.push('first_today');
  }

  // Natural cadence (last log >3h ago)
  const lastLogAtMs = Number(recentSignals.lastLogAtMs ?? 0);
  if (lastLogAtMs > 0) {
    const sinceMs = Date.now() - lastLogAtMs;
    if (sinceMs > 3 * 60 * 60 * 1000) {
      score += 0.10;
      reasons.push('natural_cadence');
    }
  } else {
    // No prior log → also counts as natural
    score += 0.10;
    reasons.push('first_ever');
  }

  // Source bonus
  const source = String(payload.source || payload.input_method || '').toLowerCase();
  if (source === 'voice' || source === 'camera') {
    score += 0.05;
    reasons.push(`source_${source}`);
  }

  score = Math.max(0, Math.min(1, score));

  const ceiling = ceilingFor(coach);
  const floor   = floorFor(coach);
  const amount  = Math.round(floor + (ceiling - floor) * score);

  return { amount, ceiling, floor, score, reasons };
}

module.exports = {
  scoreGenuineness,
  ceilingFor,
  floorFor,
  PER_COACH_CEILING,
  PER_COACH_FLOOR,
};
