# 🚨 RULE #1 — NEVER DEPLOY WITHOUT ASKING 3× IN BIG CAPS

Before any `git push`, `fly deploy`, App Store / TestFlight submit, or anything that hits real users — **ASK 3 SEPARATE TIMES IN BIG CAPS** and wait for explicit "yes" each time:

1. **"ARE YOU SURE YOU WANT TO DEPLOY TO PRODUCTION?"**
2. **"THIS WILL AFFECT REAL USERS. CONFIRM AGAIN?"**
3. **"FINAL CONFIRMATION — DEPLOY NOW?"**

Any non-yes → STOP. See `/CLAUDE.md` for full rule.

---

# wellness-cross-v2 — Firestore schema

**Every collection and doc the V2 module reads or writes.**

Date: 2026-05-07. Status: Phase 0 deliverable.

The V2 module is **READ-ONLY** against agent collections (sleep_*, mind_*, etc.). It writes only to `wellness_users/{deviceId}/cross_v2/*` and `wellness_meta/*`.

---

## READS (existing collections, untouched)

### `wellness_users/{deviceId}` (root user doc)

Read fields:
- `name`, `email`, `created_at`
- `cold_start_anchor` ('energy'|'sleep'|'mood'|'weight'|'fitness'|'none')
- `onboarding_answers` (object — captured at signup)
- `mind_setup_complete`, `sleep_setup_complete`, `nutrition_setup_complete`, `fitness_setup_complete`, `water_setup_complete`, `fasting_setup_complete` (booleans)

### `wellness_users/{deviceId}/agents/{agent}` (per-agent setup + score doc)

Read fields:
- `setup_complete`, `setup_completed_at`
- `current_score` (0..100)
- `score_label`
- `score_components` (object, per-agent breakdown)
- `score_updated_at`
- `target_*` fields (per-agent goal — sleep target_hours, water daily_goal_ml, etc.)

### Per-agent log collections

These vary per agent. The adapter layer reads each agent's relevant collection:
- `wellness_users/{id}/sleep_logs` — date-keyed sleep logs
- `wellness_users/{id}/mind_checkins` — date-keyed mood/anxiety
- `wellness_users/{id}/nutrition_logs` — meals
- `wellness_users/{id}/fitness_sessions` — workouts
- `wellness_users/{id}/water_logs` — drinks
- `wellness_users/{id}/fasting_sessions` — fasts

Each adapter knows its agent's exact collection path. Other adapters never read sibling collections.

---

## WRITES (V2-owned collections)

### `wellness_users/{deviceId}/cross_v2/context_pack`

Single doc per user. Compressed input pack for the orchestrator.

```ts
{
  pack_version: '1.0',
  computed_at: Timestamp,
  stable_prefix_hash: string,             // SHA-1 of stable 30d portion (cache key)
  total_tokens: number,                   // size estimate for cost telemetry
  
  profile: {
    device_id, name, days_active, setup_count, setup_state, anchor
  },
  
  agents: {
    sleep: AgentSnapshot,
    mind: AgentSnapshot,
    nutrition: AgentSnapshot,
    fitness: AgentSnapshot,
    water: AgentSnapshot,
    fasting: AgentSnapshot
  },
  
  baselines: {
    [agent]: { mean: number, std: number, sample_size: number }
  },
  
  last_7d_floating: [
    // last 7 daily rows, oldest first
    { date, agent_scores: { sleep, mind, ... }, has_logs: { ... } }
  ],
  
  today: {
    date: 'YYYY-MM-DD',
    agent_scores: { ... },
    has_logs: { ... }
  }
}
```

TTL: 24h. Refreshed nightly by cron.

### `wellness_users/{deviceId}/cross_v2/home_pack`

Single doc. The full Home tab response (same shape as `GET /home`).

```ts
{
  ...HomeResponse,
  computed_at: Timestamp,
  generated_by: 'nightly_cron' | 'on_open_delta' | 'manual_recompute',
  llm_telemetry: {
    planner: { model, tokens_in, tokens_out, cache_hit, latency_ms, cost_usd },
    executor: { ... },
    validator: { ... }
  }
}
```

### `wellness_users/{deviceId}/cross_v2/insights_pack`

Single doc per range (7/30/90). Three docs total per user, keyed by `range`.

```ts
{
  ...InsightsResponse,
  range: 7 | 30 | 90,
  computed_at: Timestamp
}
```

Path: `cross_v2/insights_pack_7d`, `insights_pack_30d`, `insights_pack_90d`.

### `wellness_users/{deviceId}/cross_v2/correlations`

Single doc with all 45 correlations (15 pairs × 3 windows).

```ts
{
  computed_at: Timestamp,
  results: [
    {
      id: string,
      pair: 'sleep×mind',
      agents: ['sleep', 'mind'],
      window_days: 7|30|90,
      lag: -1|0|1,
      r: number, p: number, n: number,
      direction: 'positive'|'negative',
      plain_english: string,
      evidence: { high_days_avg, low_days_avg, example_dates },
      bh_significant: boolean,            // BH-corrected at α=0.05
      confidence_label: 'strong'|'moderate'|'weak'
    }
  ]
}
```

Top-3 selection happens at request time from this doc.

### `wellness_users/{deviceId}/cross_v2/anomalies/{date}`

Per-day doc, only created when an anomaly fires.

```ts
{
  date: 'YYYY-MM-DD',
  detected_at: Timestamp,
  agent: string,
  z_score: number,
  severity: 'low'|'med'|'high',
  headline: string,
  evidence: string,
  likely_cause_agent: string | null,
  drill_correlation_id: string | null,
  was_surfaced: boolean                   // did Home actually show it?
}
```

Retention: 90 days.

### `wellness_users/{deviceId}/cross_v2/streaks`

Single doc.

```ts
{
  per_agent: {
    sleep: { current, longest, last_log_date, status: 'active'|'lapsed'|'frozen' },
    mind: { ... }, ...
  },
  cross_agent_grace_active: boolean,
  grace_history: [
    // last 30 days of grace usage (for analytics)
    { date, agents_strong: ['sleep', 'mind'], agent_missed: 'water' }
  ],
  freezes: {
    available: number,                     // current inventory
    used_this_week: number,
    last_grant_at: 'YYYY-MM-DD',
    next_grant_at: 'YYYY-MM-DD'
  },
  updated_at: Timestamp
}
```

### `wellness_users/{deviceId}/cross_v2/score_history/{date}`

One doc per day. Used for sparklines + trend computation + reports.

```ts
{
  date: 'YYYY-MM-DD',
  wellness_score: number,
  components: [{ agent, score, weight, delta_vs_baseline, contribution_pts }],
  confidence: number,
  short_ema: number,                       // for next day's smoothing
  warm_start_blend: number,
  is_warm_start: boolean,
  computed_at: Timestamp
}
```

Retention: forever (small docs, valuable history).

### `wellness_users/{deviceId}/cross_v2/reports/{reportId}`

Generated weekly + monthly reports. Same shape as `GET /reports/:reportId` response.

Retention: forever.

---

### `wellness_meta/llm_costs/{date}`

Daily aggregate cost telemetry across all users.

```ts
{
  date: 'YYYY-MM-DD',
  total_users_processed: number,
  total_cost_usd: number,
  per_step: {
    pre_aggregate: { runs, total_ms },
    planner: { runs, tokens_in, tokens_out, cost_usd, cache_hit_rate },
    executor: { ... },
    validator: { ... }
  },
  alerts: [
    { user_id, type: 'cost_spike'|'latency_spike'|'validator_reject_rate', value }
  ]
}
```

### `wellness_meta/schema_versions`

```ts
{
  pack_schema: '2.0.0',
  home_schema: '2.0.0',
  insights_schema: '2.0.0',
  score_schema: '2.0.0',
  correlations_schema: '2.0.0',
  updated_at: Timestamp
}
```

---

## Tier definitions (`profile.tier`)

Driven by `days_with_any_log` and `setup_count`:

| Tier | days_logged | setup_count | UI semantics |
|------|---|---|---|
| 0 | 0 | <1 | Cold-start, all warm-start path |
| 1 | 1-3 | ≥1 | Onboarding active, score = warm-start dominant |
| 2 | 4-13 | ≥1 | Real data starting, blend phase |
| 3 | 14-29 | ≥2 | Full real-data score, calibration ring fading |
| 4 | 30-89 | ≥2 | Mature, correlations active |
| 5 | ≥90 | ≥2 | Mastery, monthly reports + lag-1 patterns |

Tier upgrades are sticky (no downgrade once reached). Used by FE to gate features (e.g., correlation cards only render at tier ≥3).

---

## Indexes needed

Firestore composite indexes:
- `cross_v2/score_history` — `(deviceId asc, date desc)` for sparkline range query.
- `cross_v2/anomalies` — `(deviceId asc, date desc)` for "show last 30d anomalies."
- `cross_v2/reports` — `(deviceId asc, generated_at desc)` for report list pagination.

---

## Migration plan (when V2 ships)

1. V2 endpoints serve at `/api/wellness/v2/*` alongside the old ones.
2. FE V2 ships, points at `/v2/`. Old FE keeps using old endpoints.
3. After 30 days of stable V2 usage:
   - Delete the 11 `lib/cross-agent-*.js` files.
   - Delete the 4 old `wellness.cross.js` endpoints (`/home`, `/insights`, `/agent-daily-grid`, `/briefing`).
   - Optionally drop old `cross_agent/today_signals` doc (no longer read).
4. Old user docs in `agents/{agent}` (with `current_score` etc.) — keep, agents still write here, V2 still reads.

---

**Sign-off:** when product confirms these collections + retention align with their privacy + cost expectations, lock and start Phase 1.
