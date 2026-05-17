# 🚨 RULE #1 — NEVER DEPLOY WITHOUT ASKING 3× IN BIG CAPS

Before any `git push`, `fly deploy`, App Store / TestFlight submit, or anything that hits real users — **ASK 3 SEPARATE TIMES IN BIG CAPS** and wait for explicit "yes" each time:

1. **"ARE YOU SURE YOU WANT TO DEPLOY TO PRODUCTION?"**
2. **"THIS WILL AFFECT REAL USERS. CONFIRM AGAIN?"**
3. **"FINAL CONFIRMATION — DEPLOY NOW?"**

Any non-yes → STOP. See `/CLAUDE.md` for full rule.

---

# Wellness Score Algorithm — v2 spec

**The single most important piece of math in the V2 backend. This is what users will see at the top of Home tab every day.**

Date: 2026-05-07. Status: design-locked, awaiting Phase 3 implementation.

---

## DESIGN GOALS (in priority order)

1. **Personally meaningful** — your trajectory matters, not population norms (Oura standard).
2. **Causally transparent** — every score number ships with components + delta + plain-English why.
3. **Confidence-aware** — partial data still produces a meaningful score; missing data lowers confidence, never silently zeroes the score.
4. **Temporally smooth** — single bad/good day doesn't dominate; trend matters.
5. **Anti-gamed** — logging more does not raise the score.
6. **Warm-startable** — Day 1 has a plausible seed, blends out as real data accumulates.
7. **Reproducible** — same input → same output to 2 decimals. Auditable, testable.
8. **Bounded** — never displays 0 or 100 (always 1-99 to avoid "perfection or failure" framing).

---

## INPUTS (what the algorithm reads, per user, per day)

For each of the 6 agents `i ∈ {sleep, mind, nutrition, fitness, water, fasting}`:

| Field | Type | Source | Purpose |
|---|---|---|---|
| `agent_score_today_i` | 0..100 \| null | adapter (each agent's existing `current_score`) | The agent's own daily wellness score |
| `has_log_today_i` | bool | adapter | Did the user log today? |
| `setup_complete_i` | bool | wellness_users doc | Has user finished agent setup? |
| `days_since_setup_i` | int | wellness_users doc | Maturity floor |
| `score_history_i[]` | [{date, score, has_log}] last 30d | adapter | For baseline + EMA |
| `agent_components_i` | object | adapter | Per-agent sub-scores (e.g. sleep.efficiency=72, sleep.duration=88) |

Plus user-level inputs:
- `total_days_logged_anywhere` (int)
- `onboarding_anchor` ('energy' | 'sleep' | 'mood' | 'weight' | 'fitness' | 'none')
- `onboarding_answers` (object — captured during onboarding)
- `setup_count` (int 0..6)

---

## ALGORITHM (12 steps, deterministic)

### Step 1 — Per-agent personal baseline (exponentially weighted)

For each agent with `score_history_i` containing ≥3 days of data:

```
half_life_days = 7
α = ln(2) / half_life_days ≈ 0.0990

For each historical day t in [today-14, today-1] where has_log_t:
  weight_t = exp(-α × (today - t))

ewm_mean_i = Σ(score_t × weight_t) / Σ(weight_t)

ewm_var_i = Σ(weight_t × (score_t - ewm_mean_i)²) / Σ(weight_t)
ewm_std_i = sqrt(ewm_var_i)
ewm_std_i = max(ewm_std_i, 5.0)   // floor to avoid extreme z-scores on stable users
```

**Why exponential weighting (half-life 7d):** A score from 7 days ago carries half the weight of yesterday's. Banister-style adaptation model from sports science ([Banister 1975](https://support.strava.com/hc/en-us/articles/216918477-Fitness-Freshness)) — recent days dominate but trend is preserved. Half-life of 7 chosen because:
- Shorter (3d) = too noisy, single bad day flips baseline.
- Longer (14d) = too sluggish, doesn't track week-over-week shifts.
- 7d empirically matches Oura's documented 14-day weighted average tilted toward recent ([Oura blog](https://ouraring.com/blog/readiness-score/)).

**Why std floor at 5:** Without it, a perfectly consistent user (std ≈ 0) would have z-scores of ±∞ for any deviation. Floor of 5 means a 5pt deviation = z=1, which feels right.

**Edge case:** If `score_history_i` has <3 days of data, skip Step 1 for this agent — it'll be in warm-start path (Step 9).

### Step 2 — Z-score with sigmoid clamp

```
For each agent with valid baseline:
  z_i = (agent_score_today_i - ewm_mean_i) / ewm_std_i
  
  // tanh maps z=±2 → ±0.96, z=±3 → ±0.995
  // Result: extreme outliers don't blow up the score
  
  normalized_i = 50 + 25 × tanh(z_i)
  normalized_i = clip(normalized_i, 5, 95)
```

**Why this shape:**
- `z=0` (today equals your baseline) → `normalized = 50`. Baseline is the middle.
- `z=+1` (one std above baseline) → `normalized ≈ 69`. A "good day."
- `z=+2` → `normalized ≈ 74`. "Great day."
- `z=-1` → `normalized ≈ 31`. "Off day."
- `z=-3` (catastrophic) → `normalized ≈ 5` (floored).

**Why tanh, not linear:** Linear blows up on outliers (z=4 → 100, z=-4 → 0). Tanh saturates gracefully. A truly catastrophic day still gets ~5, not 0 — keeps user engaged ("I've been worse").

**Why clip 5..95:** Never display 0 or 100. 100 implies perfection (set up for letdown tomorrow). 0 implies failure (user disengages). Apple, Oura, Whoop all hide the actual extreme bounds.

### Step 3 — No baseline yet (cold-start agent)

If `score_history_i` has <3 logged days but `agent_score_today_i` exists:
```
normalized_i = clip(agent_score_today_i, 5, 95)
```
Use the agent's own score directly. No personal baseline → no z-score normalization. The confidence weighting (Step 5) accounts for the lower reliability.

### Step 4 — No data today

If `agent_score_today_i` is null (user didn't log today):
```
// Use yesterday's normalized score, decayed toward 50
prev_normalized_i = last available normalized score from history
days_since_log = days since last log
decay_factor = exp(-days_since_log / 5)   // 5-day half-life decay toward neutral
normalized_i = 50 + (prev_normalized_i - 50) × decay_factor
```
This means a user who skipped today doesn't get penalized — they retain yesterday's signal but it slowly decays toward neutral if they keep skipping.

### Step 5 — Per-agent confidence

```
setup_active_i = setup_complete_i ? 1 : 0

log_consistency_i = days_logged_in_14d_i / 14   // 0..1

age_factor_i = clip(days_since_setup_i / 14, 0, 1)
// Day-1 setup → 0.07, Day-7 → 0.50, Day-14+ → 1.0

agent_confidence_i = setup_active_i × log_consistency_i × age_factor_i
// ∈ [0, 1]
```

**Anti-gaming property:** `log_consistency` is days-with-log over 14, capped at 1. A user logging mood 5x today gets `log_consistency` = 1/14 = 0.07 (same as logging once). Frequency above 1/day is ignored.

### Step 6 — Effective weights (partial-credit re-normalization)

```
base_weights = {
  sleep:     0.25,   // largest — biggest evidence base, most reliable signal
  fitness:   0.20,
  mind:      0.20,
  nutrition: 0.15,
  water:     0.10,
  fasting:   0.10
}

raw_weight_i = base_weights[i] × agent_confidence_i

total_raw = Σ(raw_weight_i)

if total_raw < 0.05:
  // No agents have sufficient confidence — fall through to warm-start
  return warm_start_path(...)

For each i:
  effective_weight_i = raw_weight_i / total_raw
```

**Property: partial credit.** A user with only Sleep + Mind set up and logged for 7 days gets `effective_weights = {sleep: 0.56, mind: 0.44}` and the other 4 agents drop out. The score is still meaningful, just with lower overall confidence (Step 10).

**Why these base weights:**
- Sleep 25%: largest evidence base in wellness research; affects every other domain ([Whoop](https://www.whoop.com/us/en/thelocker/how-does-whoop-recovery-work-101/), [Oura](https://support.ouraring.com/hc/en-us/articles/360057791533-Readiness-Contributors)).
- Fitness + Mind 20% each: behavioral signals with strong daily variation.
- Nutrition 15%: high noise (single-day fluctuation common), self-reported.
- Water + Fasting 10% each: lighter weight — more discretionary, less load-bearing.
- Sums to 1.00.

User can override via FE later (deferred to FE phase). Defaults ship.

### Step 7 — Daily wellness score (raw)

```
wellness_today_raw = Σ(normalized_i × effective_weight_i)
                     over agents where agent_confidence_i > 0
```

This is today's wellness number, before temporal smoothing.

### Step 8 — Temporal smoothing (display score)

```
short_ema = EMA(wellness_today_raw, half_life=3)
// Maintained as a stateful value, persisted in Firestore /score_history/

display_today = 0.7 × wellness_today_raw + 0.3 × short_ema
```

**Why 70/30 today/EMA blend:**
- Pure raw (`α=1.0`) = noisy. A single bad sleep flips score 15+ pts.
- Pure EMA (`α=0`) = lagged. User's behavior change today doesn't show up until tomorrow.
- 70/30 = today dominates but week-trend protects against single-day noise.
- Half-life 3d means 3 days ago has ~50% the weight of today. A quick local-trend signal.

### Step 9 — Warm-start blend (Day 1 → Day 14)

```
real_data_weight = clip(total_days_logged_anywhere / 14, 0, 1)
// Day 0  → 0.0   → all warm-start
// Day 7  → 0.5   → blend
// Day 14 → 1.0   → all real

warm_seed = warm_start_lookup(onboarding_anchor, onboarding_answers, setup_count)
// Library lookup, see Step 11 below

displayed_score = real_data_weight × display_today + (1 - real_data_weight) × warm_seed

displayed_score = round(clip(displayed_score, 5, 95))
```

**Behavior:**
- **Day 0** (no logs): `displayed_score = warm_seed` (e.g., 64 from onboarding answers).
- **Day 7** (5 logs in): `displayed_score = 0.36 × real + 0.64 × seed` — real data starting to show.
- **Day 14+**: `displayed_score = real`. Warm-start fully phased out.

This is the single biggest UX advantage over Whoop (28-day silent baseline) and Oura (no warm-start, just "calibrating" forever).

### Step 10 — Overall confidence

```
setup_factor = setup_count / 6
data_factor = clip(total_days_logged_anywhere / 30, 0, 1)
consistency_factor = mean(log_consistency_i) over active agents

confidence = 0.30 × setup_factor + 0.50 × data_factor + 0.20 × consistency_factor

// confidence ∈ [0, 1]
// Day 0:        confidence = 0.30 × (setup_count/6)        ≈ 0.05–0.30
// Day 7  (5d):  confidence ≈ 0.45
// Day 30 (25d): confidence ≈ 0.85
// Day 90 (80d): confidence ≈ 0.97
```

FE renders this as a calibration ring — thin = low confidence, thick = high. When `confidence < 0.7`, FE may show "calibrating N/14" copy.

### Step 11 — Warm-start library (compile-time table)

A hand-tuned 5 × 6 × 3 lookup table (5 anchors × 6 agents × 3 baseline tiers):

```
warm_start_seeds = {
  anchor: 'energy' | 'sleep' | 'mood' | 'weight' | 'fitness' | 'none',
  agent: 'sleep' | 'mind' | 'nutrition' | 'fitness' | 'water' | 'fasting',
  tier:  'low' | 'mid' | 'high'   // derived from onboarding question, e.g. "I sleep 4-5h" = low
}
→ agent_seed_score: number   // 35..75 range
```

**Example entries:**
```
('energy', 'sleep', 'low')   → 35   // user reports poor sleep
('energy', 'sleep', 'mid')   → 55
('energy', 'sleep', 'high')  → 70
('mood',   'mind',  'low')   → 30   // user reports anxiety
('weight', 'fasting', 'mid') → 60   // user wants to fast, neutral starting point
('none',   *,        *)      → 50   // no anchor → neutral
```

`warm_start_lookup(...)` aggregates across the 6 agents (only those with `setup_complete=true`) using the same `base_weights`. Returns a 0..100 score.

**Tuning method:** Hand-set during Phase 3 by reading 100 onboarding answer combinations and assigning plausible scores. Validated post-launch by checking warm-start vs real Day-14 score correlation (target r > 0.4).

### Step 12 — Components, deltas, why-line

```
For each active agent:
  delta_vs_baseline_i = normalized_i - 50
  contribution_to_total_i = effective_weight_i × delta_vs_baseline_i
  // Signed: positive = pulled score up vs baseline

  components_array.push({
    agent: i,
    score: round(normalized_i),
    weight: effective_weight_i,
    delta_vs_baseline: round(delta_vs_baseline_i, 1),
    contribution_pts: round(contribution_to_total_i, 1),
    is_top_contributor: false   // set in next step
  })

// Sort by |contribution_pts|, mark top 3
sorted = components_array.sort by abs(contribution_pts) desc
sorted[0..2].is_top_contributor = true
```

**Why-line generation** (LLM call, validator-checked):

Prompt input:
```
{
  display_score: 64,
  delta_vs_yesterday: -3,
  top_contributors: [
    { agent: 'sleep', delta: -10, weight: 0.30 },
    { agent: 'mind',  delta: +4,  weight: 0.22 },
    { agent: 'water', delta: -2,  weight: 0.12 }
  ]
}
```

Prompt template (cacheable prefix in `orchestrator/prompts.js`):
```
You write the 1-line "why" for a wellness score.
Input: today's display_score, delta_vs_yesterday, and top 3 contributors with delta_vs_baseline.
Output: ONE sentence ≤140 chars, plain English, mentions ONE primary driver.
Never invent numbers. Only use numbers from the input.
Examples:
  Input: score 64, delta -3, top: sleep -10
  Output: "Down 3 today — your sleep is 10pts below your usual, that's the main drag."
  Input: score 78, delta +5, top: mind +12
  Output: "Up 5 — your mood is 12pts above baseline, lifting everything."
```

Validator (OpenAI gpt-5.4-nano, parallel CoVe — provider diversity vs Gemini executor; see `orchestrator/validator.js`):
- Extract every numeric in output.
- Check every numeric appears in input components or is the score itself.
- If any unattributable numeric → reject + ask for rewrite (max 1 retry, then drop why_line).

---

## OUTPUT (the response shape)

```ts
wellness: {
  score: 64,                          // displayed_score
  delta_vs_yesterday: -3,
  delta_vs_7d_avg: +1,
  confidence: 0.45,
  calibration_days_done: 7,
  calibration_days_target: 14,
  components: [
    { agent: 'sleep', score: 40, weight: 0.30,
      delta_vs_baseline: -10.0, contribution_pts: -3.0,
      is_top_contributor: true },
    { agent: 'mind', score: 54, weight: 0.22,
      delta_vs_baseline: +4.0, contribution_pts: +0.9,
      is_top_contributor: true },
    { agent: 'water', score: 48, weight: 0.12,
      delta_vs_baseline: -2.0, contribution_pts: -0.2,
      is_top_contributor: true },
    // ... 3 more agents (or zero if not setup) ...
  ],
  why_line: "Down 3 today — your sleep is 10pts below your usual, that's the main drag.",
  score_status: 'building',           // thriving|strong|steady|building|starting
  trend_direction: 'down',            // up|flat|down
  volatility_14d: 8.4,                // std of last 14 daily scores
  baseline_30d: 67,                   // rolling 30d mean
  
  // Day-1 specific
  is_warm_start: true | false,
  warm_start_blend: 0.36              // weight given to real data (1=full real, 0=full seed)
}
```

The status mapping (informs FE styling):
- 80-95: 'thriving'
- 65-79: 'strong'
- 50-64: 'steady'
- 35-49: 'building'
- 5-34:  'starting'

---

## REPRODUCIBILITY GUARANTEES

Same input → same output to 2 decimals. To enforce:
1. All math uses fixed-precision floats.
2. EMA state persisted (no re-derivation each call).
3. Warm-start library is a checked-in table, version-tagged.
4. `score_schema_version` shipped in response so FE knows when math changed.

Test fixtures (in `tests/score.test.js`): 50 hand-built day×agent matrices with expected outputs, including:
- Cold-start (Day 0, 6 setups, no logs)
- Cold-start partial (Day 0, 2 setups, no logs)
- Day 7 (5 logs across 3 agents)
- Power user (Day 90, 6 agents, full daily logging)
- Outlier day (today's sleep 4σ below baseline)
- Skipped 5 days (decay path)
- Re-engaged after gap

Snapshot tests; any algorithm tweak requires bumping `score_schema_version`.

---

## ANTI-PATTERNS THIS DESIGN AVOIDS

| Anti-pattern | Failure mode | Our defense |
|---|---|---|
| Population-norm comparison | Penalizes naturally-low-baseline users | Personal-baseline z-score |
| Linear normalization | Outliers blow score to 0 or 100 | Tanh sigmoid + clip 5..95 |
| Hidden score (Whoop 28d) | Empty Day 1 | Warm-start library + blend |
| Opaque score | "Why did it drop?" | Top-3 contributors + why_line |
| All-or-nothing partial data | 4/6 agents → ??? | Confidence-weighted re-norm |
| Log-frequency gaming | "Log 10x to game it" | log_consistency capped at 1.0 |
| Single-day dominance | Bad night → score plummets | EMA blend (70/30) |
| Stale-baseline drag | Old data weights too heavy | EMA half-life 7d |
| Score=0 demotivation | User disengages | Floor at 5 |
| Score=100 framing | Sets user up for letdown | Cap at 95 |
| Hallucinated why-line | LLM makes up numerics | Chain-of-Verification validator |
| Math drift in production | Hard to debug | Reproducibility tests + schema versioning |

---

## CITATIONS

- **Personal baseline normalization** — [Oura Readiness blog](https://ouraring.com/blog/readiness-score/), [Oura support](https://support.ouraring.com/hc/en-us/articles/360057791533-Readiness-Contributors).
- **EMA / half-life weighting** — Banister 1975 model adopted by Strava ([Strava Fitness & Freshness](https://support.strava.com/hc/en-us/articles/216918477-Fitness-Freshness), [Science4Performance](https://science4performance.com/2019/11/04/modelling-strava-fitness-and-freshness/)).
- **Confidence-weighted fusion** — Adaptive Probabilistic Fusion Network ([Frontiers Physics 2025](https://www.frontiersin.org/journals/physics/articles/10.3389/fphy.2025.1588715/full)).
- **PH-LLM aggregated daily summaries** beat raw streams — [Nature Medicine 2025](https://www.nature.com/articles/s41591-025-03888-0).
- **Tanh saturation for outlier handling** — standard signal-processing technique; informally used in Welltory's score smoothing ([Welltory science](https://welltory.com/science/)).
- **Score transparency mandate** — de Gruyter Brill 2025 critique of opaque wearable scores ([critique](https://www.degruyterbrill.com/document/doi/10.1515/teb-2025-0001/html?lang=en)) + Whoop user complaints ([Whoop community](https://www.community.whoop.com/t/nonsensical-recovery-score-make-it-make-sense/9660)).
- **Chain-of-Verification for numeric why-line** — Dhuliawala et al. ([arXiv 2309.11495](https://arxiv.org/abs/2309.11495)).
- **No 0 / no 100 bounded scoring** — Apple Watch rings UX design (rings can hit 100% but underlying calorie target is hidden), informed by [Heather Grace post on ring shame](https://www.heather-grace.com/blog/how-my-apple-watch-impacted-my-mental-health-and-how-i-fixed-it) — bounded design avoids both ceiling and floor effects.
- **Anti-gaming via log-frequency cap** — derived from NN/g vanity-metrics analysis ([NN/g](https://www.nngroup.com/articles/vanity-metrics/)).

---

**End of algorithm spec.** Implementation lives in `wellness-cross-v2/score/`. Every step above maps to a single function in that folder. Tests cover all 50 fixture cases.
