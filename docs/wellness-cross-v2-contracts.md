# wellness-cross-v2 — API contracts

**Source of truth for every endpoint shape. The FE team builds against these.**

Date: 2026-05-07. Status: Phase 0 deliverable, awaiting sign-off.

All endpoints mounted at `/api/wellness/v2/*`. Old `/api/wellness/home/:deviceId` and `/api/wellness/insights/:deviceId` keep serving the old UI until V2 frontend is ready.

Auth pattern: same as existing — `deviceId` query param or path. No bearer tokens.

All responses include:
- `meta.schema_version` — semver string. FE may require minimum.
- `meta.computed_at` — ISO timestamp.
- `meta.stale_for_seconds` — age of cached pack.

---

## `GET /api/wellness/v2/home/:deviceId`

Returns the entire Home tab payload in one round-trip.

**Query params:**
- `deviceId` (path, required)

**Response 200:**

```ts
{
  profile: {
    device_id: string,
    name: string,
    days_active: number,                    // days since first wellness signup
    setup_count: number,                    // 0..6
    setup_state: {
      sleep: boolean, mind: boolean, nutrition: boolean,
      fitness: boolean, water: boolean, fasting: boolean
    },
    tier: 0 | 1 | 2 | 3 | 4 | 5            // freshness tier (see Firestore schema doc)
  },

  // The Wellness Score (the hero metric)
  wellness: {
    score: number,                          // 5..95, integer
    delta_vs_yesterday: number,             // signed, can be ±20+
    delta_vs_7d_avg: number,                // signed
    confidence: number,                     // 0..1
    calibration_days_done: number,          // 0..14 (caps at 14)
    calibration_days_target: 14,
    is_warm_start: boolean,
    warm_start_blend: number,               // 0..1, real-data weight
    components: [
      {
        agent: 'sleep'|'mind'|'nutrition'|'fitness'|'water'|'fasting',
        score: number,                      // 5..95 (this agent's normalized score)
        weight: number,                     // 0..1, effective_weight
        delta_vs_baseline: number,          // -45..+45 (signed)
        contribution_pts: number,           // signed pts this agent moved total
        is_top_contributor: boolean
      }
      // length: 6 (one per agent, even if not setup — those have weight=0, score=null)
    ],
    why_line: string | null,                // ≤140 chars, validator-checked
    score_status: 'thriving'|'strong'|'steady'|'building'|'starting',
    trend_direction: 'up'|'flat'|'down',
    volatility_14d: number,                 // std of last 14 daily scores
    baseline_30d: number                    // 30d rolling mean
  },

  // Per-agent normalized sparklines for Tufte small-multiples
  sparklines: [
    {
      agent: string,
      points: [
        { date: 'YYYY-MM-DD', value: number | null, has_data: boolean }
        // length: 14 (last 14 days, oldest first)
      ],
      delta_vs_baseline: number,
      direction: 'up'|'flat'|'down',
      sample_size: number                   // count of has_data=true points
    }
    // length: 6
  ],

  // Today's anomaly card (nullable — only when something flagged)
  anomaly: null | {
    agent: string,
    severity: 'low'|'med'|'high',
    headline: string,                       // ≤80 chars
    evidence: string,                       // ≤200 chars
    likely_cause_agent: string | null,
    drill_correlation_id: string | null     // tap → /correlations/:id
  },

  // Today's One Action (Fogg high-ability prompt)
  today_action: null | {
    agent: string,
    prompt: string,                         // ≤80 chars
    one_tap_log: null | {
      endpoint: string,                     // e.g., '/api/water/log'
      payload_template: object              // pre-filled body
    },
    rationale: string                       // ≤140 chars, validator-checked
  },

  // Streaks (forgiving cross-agent grace logic)
  streaks: {
    per_agent: [
      {
        agent: string,
        current: number,                    // current streak length in days
        longest: number,                    // best ever
        status: 'active'|'lapsed'|'frozen'
      }
      // length: 6
    ],
    cross_agent_grace_active: boolean,      // is grace currently saving a streak?
    grace_reason: string | null,            // e.g., "2 strong agents covering today's miss"
    streak_freeze_available: boolean,
    streak_freeze_count: number,            // unused freezes in inventory
    next_freeze_grant_at: 'YYYY-MM-DD'      // weekly grant date
  },

  // Quick-log dock surfaces
  quick_log_dock: [
    {
      agent: string,
      icon_id: string,                      // FE maps icon_id → icon component
      last_used_at: 'YYYY-MM-DDTHH:mm:ssZ' | null
    }
    // length: 6
  ],

  meta: {
    pack_version: string,
    computed_at: 'YYYY-MM-DDTHH:mm:ssZ',
    stale_for_seconds: number,
    schema_version: '2.0.0'
  }
}
```

**Response 426:** `Upgrade Required` if FE-supplied minimum schema version exceeds backend's. Body: `{ error: 'schema_too_old', minimum_required: '2.0.0', current: '1.x.x' }`.

**Response 503:** if both pack-fetch AND fallback fail. Body: `{ error: 'temporarily_unavailable', retry_after_seconds: 30 }`. FE should render last-cached pack with a stale banner.

---

## `GET /api/wellness/v2/insights/:deviceId`

Powers the global Insights tab.

**Query params:**
- `deviceId` (path)
- `range` (query, optional) — `7` | `30` | `90`. Default `30`.

**Response 200:**

```ts
{
  profile: { /* same as Home */ },

  range: 7 | 30 | 90,

  // Today sub-tab
  today: {
    one_big_thing: null | {
      title: string,                        // ≤60 chars
      body: string,                         // ≤200 chars
      severity: 'low'|'med'|'high',
      drill_correlation_id: string | null
    },
    score_story: {
      this_period_score: number,            // mean wellness over period
      prev_period_score: number,
      delta: number,
      per_agent_delta: [
        { agent: string, delta_pts: number, weight: number }
      ]
    },
    wins: [{ agent: string, headline: string, evidence: string }],   // 0..3
    watch: [{ agent: string, headline: string, evidence: string }],  // 0..3
    heatmap: [
      // 7-day heatmap when range=7, 30 cells when range=30, etc.
      {
        date: 'YYYY-MM-DD',
        cells: [
          { agent: string, value: number | null }    // length 6
        ]
      }
    ]
  },

  // Correlations sub-tab
  correlations: {
    top_3: [
      {
        id: string,                         // UUID, used in drill endpoint
        pair: string,                       // e.g., 'sleep×mind'
        agents: [string, string],
        r: number,                          // -1..1
        p: number,                          // 0..1
        n: number,                          // sample size
        window_days: 7|30|90,
        lag: -1|0|1,                        // -1 = lag, 0 = same day, 1 = next-day
        direction: 'positive'|'negative',
        plain_english: string,              // ≤80 chars, validator-checked
        evidence: {
          high_days_avg: number,            // mean of agent-A on top quartile of agent-B days
          low_days_avg: number,
          example_dates: string[]           // 5 illustrative dates, oldest-newest
        },
        confidence_label: 'strong'|'moderate'|'weak'
      }
    ],
    has_enough_data: boolean,
    days_until_unlock: number               // shown when has_enough_data=false
  },

  // Timeline sub-tab
  timeline: {
    period: 7|30|90,
    per_agent_trend: [
      {
        agent: string,
        points: [{ date: 'YYYY-MM-DD', value: number | null }]
      }
    ],
    aha_timeline: [
      {
        date: 'YYYY-MM-DD',
        agent: string,
        kind: 'spike'|'dip'|'milestone'|'pattern',
        headline: string,
        body: string,
        score_impact_pts: number
      }
    ]
  },

  // Reports sub-tab
  reports: {
    weekly: {
      available: boolean,
      generated_at: 'YYYY-MM-DD' | null,
      id: string | null
    },
    monthly: {
      available: boolean,
      generated_at: 'YYYY-MM-DD' | null,
      id: string | null
    }
  },

  meta: { /* same shape */ }
}
```

---

## `GET /api/wellness/v2/correlations/:deviceId/:correlationId`

Returns the full evidence sheet for one correlation. Used when user taps "see evidence" on a Top-3 card.

**Response 200:**

```ts
{
  id: string,
  pair: string,
  agents: [string, string],
  r: number,
  p: number,
  n: number,
  window_days: number,
  lag: number,
  scatter_data: [
    { date: string, x: number, y: number }    // x = agent_A score, y = agent_B score
  ],
  high_days: [{ date, x, y }],                 // top quartile by x
  low_days: [{ date, x, y }],                  // bottom quartile by x
  confidence_band: {
    lower_r: number,                           // bootstrap 95% CI lower bound
    upper_r: number
  },
  plain_english: string,
  caveat: string                               // e.g., "Correlation, not causation. Sample n=14, more data tightens this."
}
```

**Response 404:** correlation_id not found / expired.

---

## `POST /api/wellness/v2/recompute/:deviceId`

Force a fresh recompute of the user's entire pack.

**Body:**
```ts
{
  reason: 'user_pull_to_refresh' | 'agent_just_logged' | 'admin_force' | 'schema_migration'
}
```

**Rate limit:** 1 request per 60 seconds per device.

**Response 200:** updated `home_pack` (same shape as `GET /home`).

**Response 429:** `{ error: 'rate_limited', retry_after_seconds: number }`.

---

## `GET /api/wellness/v2/reports/:deviceId/:reportId`

Fetch a previously-generated weekly or monthly report.

**Response 200:**

```ts
{
  id: string,
  kind: 'weekly' | 'monthly',
  period: { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' },
  generated_at: 'YYYY-MM-DDTHH:mm:ssZ',
  
  hero: {
    period_score: number,
    delta_vs_prev_period: number,
    headline: string                          // ≤80 chars
  },

  sections: [
    {
      kind: 'summary'|'wins'|'watch'|'correlation'|'pattern'|'recommendation',
      title: string,
      body_md: string,                        // markdown, supports inline { chart_id } refs
      charts: [
        { id: string, kind: 'sparkline'|'heatmap'|'bar', data: object }
      ]
    }
  ],

  meta: { schema_version: '2.0.0' }
}
```

---

## Validator gates (Phase 9 ship-gate)

- All responses validate against zod schema.
- `wellness.why_line` numerics all attributable to `wellness.components`.
- `correlations.top_3[].plain_english` numerics all attributable to `r`/`n`/`evidence`.
- `meta.schema_version` present on every response.
- `meta.computed_at` within last 24h on cron-served responses.

---

## What this contract DOES NOT include

- WebSocket / SSE — not in V2 scope. Polling is fine for the use case.
- User-customizable score weights — deferred. Defaults ship.
- Per-correlation user-tagging ("not interesting") — deferred.
- Multi-user comparison ("people like you") — deferred.

These can layer on top without breaking the schema (additive only).

---

**Sign-off:** when product agrees these shapes power the Home and Insights designs they want, we lock and start Phase 1.
