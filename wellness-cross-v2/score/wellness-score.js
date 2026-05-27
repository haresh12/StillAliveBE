/**
 * wellness-score.js
 *
 * The full 12-step Wellness Score algorithm (see docs/wellness-cross-v2-algorithm.md).
 *
 * Pure functions. No I/O. Same input → same output.
 */

const config = require('../config');
const { AGENTS } = require('../adapters/_shape');
const { normalizeFromBaseline, applySkipDecay, clip } = require('./personal-baseline');
const { agentConfidence, overallConfidence } = require('./confidence-band');
const { computeWarmStart } = require('./warm-start');
const { computeAdjustedWeights } = require('./cross-coach-interactions');
const { applyTimeOfDay } = require('./time-of-day-weights');
const { applyRecoveryBoost } = require('./recovery-boost');
const { applyUserWeightTilt } = require('./user-weight-tilt');

const BASE = config.SCORE.BASE_WEIGHTS;
const TODAY_W = config.SCORE.DAILY_TODAY_WEIGHT;
const SHORT_W = config.SCORE.DAILY_SHORT_EMA_WEIGHT;
const SHORT_HALF = config.SCORE.SHORT_EMA_HALF_LIFE_DAYS;
const FLOOR = config.SCORE.SCORE_FLOOR;
const CEIL = config.SCORE.SCORE_CEIL;
const NEUTRAL = config.SCORE.BASELINE_NEUTRAL;
const MIN_TOTAL_W = config.SCORE.MIN_TOTAL_RAW_WEIGHT;
const WARM_WIN = config.SCORE.WARM_START_WINDOW_DAYS;

function statusFor(score) {
  for (const band of config.SCORE.STATUS_BANDS) {
    if (score >= band.min) return band.status;
  }
  return 'starting';
}

function shortEMA(history) {
  if (!history.length) return 50;
  const alpha = Math.log(2) / SHORT_HALF;
  let out = history[0];
  for (let i = 1; i < history.length; i++) {
    const w = 1 - Math.exp(-alpha);
    out = w * history[i] + (1 - w) * out;
  }
  return out;
}

function trendDirection(history) {
  if (history.length < 4) return 'flat';
  const half = Math.floor(history.length / 2);
  const first = history.slice(0, half).reduce((a, b) => a + b, 0) / half;
  const last = history.slice(-half).reduce((a, b) => a + b, 0) / half;
  const delta = last - first;
  if (delta > 2) return 'up';
  if (delta < -2) return 'down';
  return 'flat';
}

function volatility(history) {
  if (history.length < 2) return 0;
  const mean = history.reduce((a, b) => a + b, 0) / history.length;
  const variance = history.reduce((acc, v) => acc + (v - mean) ** 2, 0) / history.length;
  return Math.round(Math.sqrt(variance) * 10) / 10;
}

/**
 * Compute the Wellness Score for a single day.
 *
 * @param {Object} args
 * @param {Object<string, AgentSnapshot>} args.snapshots
 * @param {Object<string, {mean, std, sample_size}>} args.baselines
 * @param {Object} args.profile - { anchor, onboarding_answers, setup_state, total_days_logged }
 * @param {number[]} [args.recentDailyHistory=[]] - last 14 daily wellness numbers (for short EMA + trend)
 * @returns {WellnessOutput}
 */
function computeWellness({ snapshots, baselines, profile, recentDailyHistory = [] }) {
  const total_days_logged = profile.total_days_logged || 0;
  const setup_count = AGENTS.filter((a) => profile.setup_state[a]).length;

  // Step 1-4: per-agent normalized score
  const normalized = {};
  const components_raw = [];

  for (const agent of AGENTS) {
    const snap = snapshots[agent];
    if (!snap || !snap.setup.is_complete) {
      normalized[agent] = null;
      continue;
    }
    const todayScore = snap.today.has_log && Number.isFinite(snap.today.score)
      ? snap.today.score
      : null;

    const baseline = baselines[agent];
    let norm = null;
    if (Number.isFinite(todayScore)) {
      norm = normalizeFromBaseline(todayScore, baseline);
    } else {
      norm = applySkipDecay(snap.last_14d, null);
    }
    normalized[agent] = norm;
  }

  // Step 5: per-agent confidence
  const agentConf = {};
  for (const agent of AGENTS) {
    agentConf[agent] = snapshots[agent] ? agentConfidence(snapshots[agent]) : 0;
  }

  // Step 6: effective weights with partial-credit re-normalization +
  //         cross-coach interactions + time-of-day bucketing.
  //
  // V3 §3: user can tilt up-to-±15% per agent via profile.user_score_weights
  // (e.g. { sleep: +0.10, fasting: -0.05 }). Tilts applied to BASE before
  // the interaction/time-of-day adjusters run, so personalization shapes
  // the score throughout the rest of the pipeline.
  const tiltedBase = applyUserWeightTilt(BASE, profile.user_score_weights);
  const interactionAdjusted = computeAdjustedWeights(normalized, snapshots, tiltedBase);
  const nowHour = (() => {
    const h = profile.local_hour;
    return Number.isFinite(h) ? h : new Date().getHours();
  })();
  const { weights: todAdjusted, bucket: todBucket } = applyTimeOfDay(interactionAdjusted, nowHour);

  const rawWeights = {};
  let totalRaw = 0;
  for (const agent of AGENTS) {
    if (Number.isFinite(normalized[agent])) {
      rawWeights[agent] = todAdjusted[agent] * agentConf[agent];
      totalRaw += rawWeights[agent];
    } else {
      rawWeights[agent] = 0;
    }
  }

  let displayed_score;
  let is_warm_start;
  let warm_start_blend = 0;
  let warm_seed = null;

  // Day-1: score earned from setup only. +2 per coach set up. 6 coaches → 12.
  // First log kicks user into the real-engine path where score jumps to 50+ band.
  const setupBoost = setup_count * 2;

  // Warm-start path: no logs yet — score IS the setup boost (0..12).
  if (totalRaw < MIN_TOTAL_W) {
    warm_seed = setupBoost;
    displayed_score = warm_seed;
    is_warm_start = true;
    warm_start_blend = 0;
  } else {
    const effective = {};
    for (const agent of AGENTS) {
      effective[agent] = totalRaw > 0 ? rawWeights[agent] / totalRaw : 0;
    }

    // Step 7: daily raw
    let raw = 0;
    for (const agent of AGENTS) {
      if (Number.isFinite(normalized[agent]) && effective[agent] > 0) {
        raw += normalized[agent] * effective[agent];
      }
    }

    // Step 8: temporal smoothing (today × short EMA)
    const ema = recentDailyHistory.length ? shortEMA(recentDailyHistory) : raw;
    const display_today = TODAY_W * raw + SHORT_W * ema;

    // Step 9: warm-start blend (with setup boost layered on top of seed)
    const real_weight = clip(total_days_logged / WARM_WIN, 0, 1);
    if (real_weight < 1) {
      const ws = computeWarmStart({
        anchor: profile.anchor || 'none',
        onboardingAnswers: profile.onboarding_answers || {},
        setup_state: profile.setup_state,
      });
      warm_seed = ws.score + setupBoost;
      displayed_score = real_weight * display_today + (1 - real_weight) * warm_seed;
      // Day-1 = 10/10: hide warm-start UX flag once user has any logs at all.
      // Confidence band still grows naturally with data; we don't tell the user "wait".
      is_warm_start = total_days_logged === 0;
      warm_start_blend = real_weight;

      // Build components from real path even if blended
      for (const agent of AGENTS) {
        if (Number.isFinite(normalized[agent])) {
          const delta = normalized[agent] - NEUTRAL;
          components_raw.push({
            agent,
            score: normalized[agent],
            weight: effective[agent],
            delta_vs_baseline: Math.round(delta * 10) / 10,
            contribution_pts: Math.round(effective[agent] * delta * 10) / 10,
          });
        }
      }
    } else {
      displayed_score = display_today;
      is_warm_start = false;
      warm_start_blend = 1;

      for (const agent of AGENTS) {
        if (Number.isFinite(normalized[agent])) {
          const delta = normalized[agent] - NEUTRAL;
          components_raw.push({
            agent,
            score: normalized[agent],
            weight: effective[agent],
            delta_vs_baseline: Math.round(delta * 10) / 10,
            contribution_pts: Math.round(effective[agent] * delta * 10) / 10,
          });
        }
      }
    }
  }

  // Recovery boost — good day after a bad day earns +up to 5pts (real path only).
  let recoveryApplied = false;
  let recoveryBoostPts = 0;
  if (!is_warm_start) {
    const rec = applyRecoveryBoost(displayed_score, recentDailyHistory);
    displayed_score = rec.score;
    recoveryApplied = rec.applied;
    recoveryBoostPts = rec.boost;
  }

  // Warm-start scores are pure setup boost (0..12) — skip the FLOOR so users see real 0/2/4/.../12 progression.
  if (is_warm_start) {
    displayed_score = Math.round(Math.max(0, Math.min(CEIL, displayed_score)));
  } else {
    displayed_score = Math.round(clip(displayed_score, FLOOR, CEIL));
  }

  // Build the components list (always 6 entries — inactive agents have weight=0, score=null)
  const components = AGENTS.map((agent) => {
    const c = components_raw.find((r) => r.agent === agent);
    if (c) return { ...c, is_top_contributor: false };
    return {
      agent,
      score: null,
      weight: 0,
      delta_vs_baseline: 0,
      contribution_pts: 0,
      is_top_contributor: false,
    };
  });

  // Step 12: top-3 contributors
  const sorted = [...components]
    .filter((c) => c.score != null && c.weight > 0)
    .sort((a, b) => Math.abs(b.contribution_pts) - Math.abs(a.contribution_pts));
  for (let i = 0; i < Math.min(3, sorted.length); i++) {
    const idx = components.findIndex((c) => c.agent === sorted[i].agent);
    components[idx].is_top_contributor = true;
  }

  // Confidence
  const confidence = overallConfidence({
    setup_count,
    total_days_logged,
    agent_consistencies: AGENTS.map((a) => agentConf[a]),
  });

  // Trend, volatility, baseline-30d
  const fullHistory = [...recentDailyHistory, displayed_score];
  const trend_direction = trendDirection(fullHistory);
  const volatility_14d = volatility(fullHistory.slice(-14));

  // 30-day baseline = simple mean of available history (or 50)
  const baseline_30d = fullHistory.length >= 5
    ? Math.round(fullHistory.reduce((a, b) => a + b, 0) / fullHistory.length)
    : displayed_score;

  // Deltas
  const yesterday = recentDailyHistory.length > 0 ? recentDailyHistory[recentDailyHistory.length - 1] : displayed_score;
  const last7 = recentDailyHistory.slice(-7);
  const avg7 = last7.length ? last7.reduce((a, b) => a + b, 0) / last7.length : displayed_score;

  // V3 §7: Explainer pack — surfaces WHY the score is what it is.
  // FE renders this in the main-dial score-explainer sheet.
  const hkAgents = [];
  for (const agent of AGENTS) {
    const snap = snapshots[agent];
    if (snap && snap.today && snap.today.hk_used === true) hkAgents.push(agent);
  }
  const hkStatus = hkAgents.length === 0
    ? 'denied'
    : hkAgents.length === 4 ? 'granted' : 'partial';

  const warmStartBlendPct = Math.round(warm_start_blend * 100);

  // Per-contributor reason text (FE may localize via the `reason_key` field;
  // English text serves as both default and i18n fallback).
  const enrichedContributions = components.map((c) => {
    let reason = null;
    let reason_key = null;
    if (c.score == null) {
      reason = 'Coach not yet set up'; reason_key = 'wellness.contrib.not_setup';
    } else if (is_warm_start) {
      reason = 'First log — building baseline'; reason_key = 'wellness.contrib.first_log';
    } else if (c.contribution_pts > 2) {
      reason = 'Pulling score up'; reason_key = 'wellness.contrib.pulling_up';
    } else if (c.contribution_pts < -2) {
      reason = 'Pulling score down'; reason_key = 'wellness.contrib.pulling_down';
    } else {
      reason = 'On baseline'; reason_key = 'wellness.contrib.on_baseline';
    }
    return { ...c, reason, reason_key };
  });

  const transitionExplainer = is_warm_start
    ? `Your score is forming. By Day ${WARM_WIN}, it'll be 100% from your real logs.`
    : warmStartBlendPct < 100
      ? `${100 - warmStartBlendPct}% of your score is now from your real logs (Day ${total_days_logged} of ${WARM_WIN}).`
      : null;

  return {
    score: displayed_score,
    delta_vs_yesterday: displayed_score - Math.round(yesterday),
    delta_vs_7d_avg: Math.round(displayed_score - avg7),
    confidence: Math.round(confidence * 100) / 100,
    calibration_days_done: Math.min(WARM_WIN, total_days_logged),
    calibration_days_target: WARM_WIN,
    is_warm_start,
    warm_start_blend: Math.round(warm_start_blend * 100) / 100,
    components,
    why_line: null, // filled by orchestrator (LLM)
    score_status: statusFor(displayed_score),
    trend_direction,
    volatility_14d,
    baseline_30d,
    warm_seed,
    // V2 enrichments
    tod_bucket: todBucket,                // 'morning'|'midday'|'evening'|'night'
    recovery_boost_applied: recoveryApplied,
    recovery_boost_pts: recoveryBoostPts,
    schema_version: config.SCORE_SCHEMA_VERSION,
    // V3 explainer pack (SCORING_CONTRACT_V3.md §7)
    explainer: {
      band: statusFor(displayed_score),
      is_warm_start,
      warm_start_blend_pct: warmStartBlendPct,
      transition_explainer: transitionExplainer,
      contributions: enrichedContributions,
      hk_status: hkStatus,        // 'granted' | 'denied' | 'partial'
      hk_enhanced_agents: hkAgents,
      user_tilt_applied: !!(profile.user_score_weights && Object.keys(profile.user_score_weights).length > 0),
      weights_in_use: tiltedBase,
    },
  };
}

module.exports = { computeWellness, statusFor, shortEMA, trendDirection, volatility };
