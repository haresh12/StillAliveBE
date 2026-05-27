# Scoring Contract V3 — Single Source of Truth

**Locked:** 2026-05-25
**Owner:** wellness-cross-v2 + lib/{agent}-scoring.js
**Flag:** `EXP_SCORE_V3` (RemoteConfig, default OFF until DoD met)

This document is the **only** place that defines how scores work across the 6 agents + the main Wellness Score. Any code change to scoring math must update this doc in the same commit.

---

## 1. The 6 Per-Agent Scoring Libs

Every agent has its own pure-function scoring library at `lib/{agent}-scoring.js`. Each lib:

- Exports a canonical `maturityRamp(daysSinceAnchor)` — the same curve for all 6
- Exports the scoring helpers + headline `compute*Score` function
- Is pure: no Firestore, no Express, no wall-clock
- Has a sibling test file at `tests/{agent}-scoring.test.js`

| Agent | Lib | Compute fn |
|---|---|---|
| Fitness   | `lib/fitness-scoring.js`   | `computeBlendedScore` |
| Mind      | `lib/mind-scoring.js`      | `computeBlendedMindScore` |
| Sleep     | `lib/sleep-scoring.js`     | `computeBlendedSleepScore` (V2 — 7 contributors) |
| Water     | `lib/water-scoring.js`     | `computeWaterScore` |
| Nutrition | `lib/nutrition-scoring.js` | `computeBlendedNutritionScore` |
| Fasting   | `lib/fasting-scoring.js`   | `computeBlendedFastingScore` |

`lib/agent-scores.js` is a thin dispatcher (`computeAgentScore(agent, data)`) that routes to the per-agent lib. **No scoring math lives in `agent-scores.js` itself** post-V3.

---

## 2. Unified Maturity Ramp

All 6 agents use **the same** ramp, keyed on `daysSinceAnchor` (calendar days since user signup), NOT `days_logged`. Cramming logs cannot fake-mature.

| daysSinceAnchor | multiplier |
|---|---|
| 0  | 0.40 |
| 1–3  | 0.45 |
| 4–6  | 0.55 |
| 7–13 | 0.70 |
| 14–29 | 0.85 |
| 30–59 | 0.94 |
| 60+ | 1.00 |

**Day-1 perfect single log lands at ~30–40 per agent.** This is the foundational rule. A perfect logger reaches 100 only at Day 60+.

---

## 3. The Wellness Score (the main dial)

**File:** `wellness-cross-v2/score/wellness-score.js` (function `computeWellness`).

**Inputs:** 6 agent snapshots + optional HealthKit signal pack + user profile.

**Day-0 (no logs ever):** `score = setup_count × 2` (max 12 with 6 coaches set up). Flag `is_warm_start = true`.

**Day-1 to Day-13 (any logs):** Blended:
```
score = real_weight × weighted_agent_avg + (1 - real_weight) × warm_seed
real_weight = days_logged / 14
warm_seed = warm-start library seed + setup_count × 2
```

**Day-14+:** Pure weighted average of agent `smoothed_7d` scores. Warm-start gone.

**Base weights (sum = 1.00):**
- Sleep `0.25` — most evidence-backed (Walker, Buysse, NIH meta)
- Fitness `0.20`
- Mind `0.20`
- Nutrition `0.15`
- Water `0.10`
- Fasting `0.10`

**Personalization layer (V3):** user can tilt up-to-15% toward any two agents. Persisted to `wellness_users/{deviceId}/score_weights`. Defaults to base weights when unset.

**Status bands (config.SCORE.STATUS_BANDS):**
- ≥80 → `thriving`
- 65–79 → `strong`
- 50–64 → `steady`
- 35–49 → `building`
- 0–34 → `starting`

---

## 4. HealthKit Fusion (V3)

HealthKit is a **passive depth signal**, never a gate. The contract guarantees:

> A user who DENIES HK permission sees scores identical to current-shipped behavior (±2 pts, verified by `tests/no-hk-parity.test.js`).

When HK is granted, the per-agent scorer accepts an optional `hkSignals` param:

```js
hkSignals = {
  sleep:   { hours_last_night, efficiency_pct, hrv_overnight_ms, resting_hr_bpm, sleep_stages: {...} },
  fitness: { workouts_last_7d: [...], steps_last_7d: [...], resting_hr_baseline, hrv_baseline_ms },
  mind:    { hrv_overnight_ms, hrv_trend_7d },
  water:   { active_kcal_today, ambient_temp_c, skin_temp_c },
}
```

| Agent | HK enhancement | Component touched |
|---|---|---|
| Sleep   | Real efficiency from HK overrides self-report; HRV/HR-dip → Restoration | Efficiency, Restoration |
| Fitness | HK workouts pre-fill Volume; HK resting-HR drop boosts Recovery; steps boost Consistency | Volume, Recovery, Consistency |
| Mind    | Overnight HRV → Anxiety Management when manual checkin absent | Anxiety Management |
| Water   | Active-kcal → +2–3% dynamic goal; skin/ambient temp → +heat adjustment (Sawka & Montain 2000) | Hydration Adequacy (via goal) |

**All HK contributions are 7d-smoothed** — never raw single-day values. Prevents one bad reading from tanking the score.

---

## 5. Day-1 Behavior (the foundational expectation)

For a brand-new user who has just completed onboarding + set up all 6 coaches:

| Day | Logged | Per-agent score (perfect log) | Wellness Score |
|---|---|---|---|
| 0 | None | — | 12 (warm-start, `is_warm_start = true`) |
| 1 | 1/agent | 30–40 (Building band) | ~53 (Steady, blended) |
| 7 | 7/agent | 44–55 (Steady) | ~65 (Strong, ~50% real) |
| 14 | 14/agent | 60–70 (Strong) | ~72 (Strong, 100% real) |
| 30 | 30/agent | 80–90 (Thriving) | ~85 (Thriving) |
| 60+ | 60+/agent | 95–100 (Thriving) | ~92 (Thriving) |

**No user EVER sees 80% on Day 1.** Maturity ramp prevents it.

---

## 6. `smoothed_7d` / `smoothed_30d` / `score_lifetime`

Every adapter MUST expose:

- `smoothed_7d` — mean of last 7 logged days, recency-weighted with missed-day decay
- `smoothed_30d` — mean of last 30 logged days
- `score_lifetime` — mean of ALL logged days since anchor (per registration-anchor law)

**Missed-day decay gradient (V3):** if user has ≥3 consecutive unlogged days, `smoothed_7d` decays by 5 pts/day toward `DAY1_SEED = 25` (but never below the user's warm-start library seed). Prevents phantom-good scores from a single old log.

---

## 7. Score Explainer Contract

Every scoring function returns:

```js
{
  score: 53,                          // 0-100 final
  raw_score: 77,                      // before maturity ramp
  maturity_mult: 0.45,                // applied multiplier
  band: 'steady',                     // status band
  components: {                       // per-gate breakdown 0-100
    duration: 70, efficiency: 65, restoration: 55, ...
  },
  hk_used: false,                     // true when HK enhanced
  hk_components: { ... } | null,      // per-component HK contribution (debug)
  days_logged: 14,
  days_since_anchor: 14,
  clinical_flag: null,                // or { type, note }
  citations: { duration: 'Walker 2017', ... },
}
```

The Wellness Score V3 explainer pack adds:

```js
{
  score: 53,
  is_warm_start: true,
  band: 'steady',
  contributions: [
    { agent: 'sleep', score: 34, weight: 0.25, contribution: 8.5, reason: 'first log — building baseline' },
    ...
  ],
  warm_start_blend_pct: 93,           // 13/14 from warm-start seed
  transition_explainer: "Your score is forming. By Day 14, it'll be 100% from your real logs.",
  hk_status: 'granted' | 'denied' | 'partial',
  hk_enhanced_agents: ['fitness', 'sleep'],
}
```

---

## 8. Migration Strategy

1. **Phase 0:** Baseline snapshot (`scripts/snapshot-current-scores.js --dry-run`) captures every active user's scores under current shipped logic.
2. **Phase 1–10:** Behind `EXP_SCORE_V3` flag (default OFF), shadow-compute new scores per request, log delta to Mixpanel.
3. **Rollout:** 10% → 50% → 100% over 7 days, gated on:
   - No user score moves >15 pts without an explanatory toast
   - `tests/agent-scores-parity.test.js` green
   - `tests/no-hk-parity.test.js` green
4. **Rollback:** Flip `EXP_SCORE_V3 = false`. Old scoring returns instantly.
5. **Migration toast:** Shown ONCE to users whose Wellness Score moved >5 pts: "Your scoring system was upgraded — here's why."

---

## 9. Tests (CI gates)

| File | Asserts |
|---|---|
| `tests/agent-scores-parity.test.js` | 5 personas × 6 agents = 30 golden fixtures match expected scores ±2 |
| `tests/no-hk-parity.test.js` | HK-denied scores match baseline snapshot |
| `tests/day-one-integration.test.js` | All 6 agents land 30–40 on Day 1 perfect log; Wellness = 12 → ~53 |
| `tests/cross-agent-comparability.test.js` | Sleep 70 / Fitness 70 / Mind 70 all map to 'strong' band |
| `tests/{agent}-scoring*.test.js` | Per-agent unit tests (existing 2250+ LOC preserved) |

**All tests must run green via `node tests/<file>.js` from `stillalive-backend/`** (no test runner — plain Node assert).

---

## 10. What's locked, what's free

**LOCKED (changes require new contract version):**
- Maturity ramp curve
- Status band thresholds
- Wellness Score base weights
- HK = passive enhancement only, never a gate
- Day-1 seed (`DAY1_SEED = 25`)
- Sum of agent weights = 1.00

**FREE to tune (no contract bump):**
- Per-component weights within an agent (e.g., Sleep's 7 contributors)
- Missed-day decay rate (currently 5 pts/day)
- HK smoothing window (currently 7d)
- User personalization cap (currently ±15%)

---

## 11. Definition of Done (15 gates)

1. ✅ All 6 agents use unified `maturityRamp` curve (no `maturityFactor` legacy)
2. ✅ `lib/nutrition-scoring.js` exists with full lib
3. ✅ No double-ramp in fasting (lib only)
4. ✅ Water adapter receives `daysSinceAnchor`
5. ✅ Sleep V2 ships with 7 contributors; V1 keys preserved for backward compat
6. ✅ HK fusion live for Fitness/Sleep/Mind/Water with `hkSignals` optional param
7. ✅ HK-denied scores match baseline snapshot (`no-hk-parity.test.js` green)
8. ✅ Missed-day decay live; phantom-good scores impossible
9. ✅ Wellness Score V3 explainer pack returned by `/home/v2`
10. ✅ Per-agent score weights persisted to `wellness_users/{deviceId}/score_weights`
11. ✅ Per-agent + main-dial explainer sheets shipped FE
12. ✅ Warm-start ribbon + transition explainer FE
13. ✅ Day-1 integration tests + cross-agent comparability tests green
14. ✅ 6 locales × ~80 new strings parse, no missing keys
15. ✅ EXP_SCORE_V3 flag wired; migration toast Mixpanel event firing; rollback drill verified

---

**END OF CONTRACT.** Any drift from this doc is a P0 bug.
