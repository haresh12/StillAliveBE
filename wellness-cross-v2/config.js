/**
 * wellness-cross-v2/config.js
 *
 * Central config: model IDs, weights, thresholds, TTLs.
 * Single source of truth — no magic numbers anywhere else in the module.
 */

module.exports = {
  // ---- Module identity ----
  MODULE_VERSION: '2.3.0',
  PACK_SCHEMA_VERSION: '2.3.0',
  HOME_SCHEMA_VERSION: '2.3.0',
  INSIGHTS_SCHEMA_VERSION: '2.3.0',     // FE-canonical: log_counts, z_series, edges, week_pattern, top_links, etc.
  SCORE_SCHEMA_VERSION: '2.0.0',         // unchanged — internal score math
  CORRELATIONS_SCHEMA_VERSION: '2.0.0',  // unchanged — internal correlations format

  // ---- Wellness Score algorithm constants ----
  SCORE: {
    // Base weights — sum to 1.0
    BASE_WEIGHTS: {
      sleep: 0.25,
      fitness: 0.20,
      mind: 0.20,
      nutrition: 0.15,
      water: 0.10,
      fasting: 0.10,
    },

    // Personal-baseline EMA
    BASELINE_HALF_LIFE_DAYS: 7,
    BASELINE_WINDOW_DAYS: 14,
    MIN_HISTORY_FOR_BASELINE: 3,
    EWM_STD_FLOOR: 5.0,

    // Display blending
    DAILY_TODAY_WEIGHT: 0.7,
    DAILY_SHORT_EMA_WEIGHT: 0.3,
    SHORT_EMA_HALF_LIFE_DAYS: 3,

    // Bounds
    SCORE_FLOOR: 5,
    SCORE_CEIL: 95,
    BASELINE_NEUTRAL: 50,

    // Skipped-day decay
    SKIP_DECAY_HALF_LIFE_DAYS: 5,

    // Warm-start blend
    WARM_START_WINDOW_DAYS: 14,

    // Confidence weights
    CONFIDENCE_WEIGHTS: {
      setup: 0.30,
      data: 0.50,
      consistency: 0.20,
    },
    CONFIDENCE_DATA_TARGET_DAYS: 30,

    // Threshold for total raw weight before falling through to warm-start
    MIN_TOTAL_RAW_WEIGHT: 0.05,

    // Status bands
    STATUS_BANDS: [
      { min: 80, status: 'thriving' },
      { min: 65, status: 'strong' },
      { min: 50, status: 'steady' },
      { min: 35, status: 'building' },
      { min: 0,  status: 'starting' },
    ],
  },

  // ---- Correlation engine ----
  CORRELATIONS: {
    AGENTS: ['sleep', 'mind', 'nutrition', 'fitness', 'water', 'fasting'],
    WINDOWS_DAYS: [7, 30, 90],
    LAGS: [-1, 0, 1],     // -1 = yesterday A vs today B, 0 = same-day, 1 = today A vs tomorrow B
    MIN_N: 14,
    MIN_ABS_R: 0.3,
    BH_FDR_ALPHA: 0.05,   // Benjamini-Hochberg false-discovery rate threshold
    BOOTSTRAP_ITERATIONS: 1000,
    TOP_K: 3,
  },

  // ---- Anomaly detector ----
  ANOMALIES: {
    SEVERITY_THRESHOLDS: {
      low: 2.0,    // 2σ-2.5σ
      med: 2.5,    // 2.5σ-3σ
      high: 3.0,   // >3σ
    },
    MIN_HISTORY_FOR_DETECTION: 7,
    RETENTION_DAYS: 90,
  },

  // ---- Streak engine ----
  STREAKS: {
    GRACE_THRESHOLD_STRONG_AGENTS: 2,    // need ≥2 agents above baseline to grant grace
    GRACE_AGENT_SCORE_FLOOR: 60,          // what counts as "strong" for grace purposes
    FREEZE_GRANT_PER_WEEK: 1,
    FREEZE_MAX_INVENTORY: 4,
  },

  // ---- LLM models ----
  LLM: {
    PLANNER: {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      temperature: undefined,             // never set — newer models reject
      max_completion_tokens: 800,
      timeout_ms: 8000,
    },
    EXECUTOR: {
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      temperature: undefined,
      max_completion_tokens: 4000,
      timeout_ms: 15000,
    },
    VALIDATOR: {
      // OpenAI for provider diversity vs Gemini executor (independent verification).
      // gpt-5.4-nano matches the project's fast-tier model in lib/model-router.js.
      provider: 'openai',
      model: 'gpt-5.4-nano',
      temperature: undefined,
      max_completion_tokens: 400,
      timeout_ms: 8000,
    },
  },

  // ---- Caching ----
  CACHE: {
    GEMINI_CONTEXT_CACHE_TTL_HOURS: 1,
    PACK_TTL_HOURS: 24,
    HOME_PACK_STALE_THRESHOLD_HOURS: 4,
    INSIGHTS_PACK_STALE_THRESHOLD_HOURS: 12,
  },

  // ---- Cost guardrails ----
  COST: {
    MAX_PER_USER_PER_DAY_USD: 0.05,       // alert if exceeded
    MAX_DAILY_TOTAL_USD: 100,             // hard cap on cron — pause if hit
  },

  // ---- Rate limits ----
  RATE_LIMITS: {
    HOME_GET_PER_MIN: 10,
    INSIGHTS_GET_PER_MIN: 10,
    RECOMPUTE_PER_MIN: 1,
  },

  // ---- Tier thresholds ----
  TIERS: [
    { tier: 0, min_days_logged: 0,  min_setup: 0 },
    { tier: 1, min_days_logged: 1,  min_setup: 1 },
    { tier: 2, min_days_logged: 4,  min_setup: 1 },
    { tier: 3, min_days_logged: 14, min_setup: 2 },
    { tier: 4, min_days_logged: 30, min_setup: 2 },
    { tier: 5, min_days_logged: 90, min_setup: 2 },
  ],

  // ---- Cron schedules (UTC) ----
  CRON: {
    NIGHTLY_BATCH: '0 3 * * *',           // 3am UTC
    CORRELATION_REFRESH: '0 4 * * *',     // 4am UTC
    WEEKLY_REPORT: '0 5 * * 1',           // 5am Monday UTC
    MONTHLY_REPORT: '0 6 1 * *',          // 6am 1st of month UTC
  },
};
