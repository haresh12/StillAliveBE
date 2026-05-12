# Scoring Contract — Single Source of Truth

**Locked 2026-05-13.** This is the canonical map of every score in the app. Any code reading or writing a score MUST follow these rules.

## The Score Hierarchy

```
Per-agent daily score        →   computed in adapters/_helpers.js via scoreDailyLogs()
   ↓
Per-agent smoothed_7d        →   avg of last 7 daily scores (NEW, exposed at snapshot level)
   ↓
Per-agent smoothed_30d       →   avg of last 30 (long-term trend)
   ↓
coach_states.score_smoothed_7d →  what Home + Analysis tab BOTH read
   ↓
Wellness Score (main dial)   →   weighted avg of agent scores via wellness-score.js
```

## What Each Surface Reads

| Surface | Field | Source |
|---|---|---|
| Home Wellness Score (dial) | `pack.wellness.score` | `wellness-score.js` |
| Home coach card | `coach_states[i].score_smoothed_7d` | `state-machine.js` |
| Home coach card status word | `coach_states[i].status_band` | `state-machine.js` |
| Agent Analysis tab hero | should read `coach_states[i].score_smoothed_7d` | TODO (P6) |

## Day-1 Behavior (No Logs Yet)

| Score | Value | Why |
|---|---|---|
| Per-agent `today.score` | `null` | No logs |
| Per-agent `smoothed_7d` | `null` | No valid scores in 7d |
| Coach card display (FE fallback) | `setup_count × 2` | Same formula as Wellness Score warm-start |
| Status band (FE) | `'starting'` (1-29 band) | Score < 30 |
| Wellness Score | `setup_count × 2` | `wellness-score.js:135` warm-start |

**Critical:** coach card fallback = main Wellness Score formula. Both show the same number on Day-1 → visual harmony, user understands.

## Post Day-1 Transition

- Once `total_days_logged > 0`, `wellness-score.js` starts blending real agent scores in via `real_weight = total_days_logged / WARM_WIN`.
- By `WARM_WIN` (14 days), `real_weight = 1` and the score is fully derived from agent components.
- Coach cards read `score_smoothed_7d` (the 7-day rolling avg of daily scores).

## Status Band Mapping (Canonical)

```js
function statusBandForScore(score) {
  if (!Number.isFinite(score)) return 'idle';
  if (score >= 80) return 'thriving';
  if (score >= 65) return 'strong';
  if (score >= 50) return 'steady';
  if (score >= 30) return 'building';
  if (score >= 1)  return 'starting';
  return 'idle';
}
```

This MUST be identical in:
- `stillalive-backend/wellness-cross-v2/coaches/state-machine.js:statusBandForScore()`
- `StillAlive/src/screens/wellness/home/components/CoachGrid.js:statusBandKey()`
- `StillAlive/src/screens/wellness/home/components/WellnessScoreGauge.js:statusFor()`

If any drift, scores will show different labels on different surfaces. **Lock this with tests.**

## Adapter Snapshot Required Fields

Every adapter's snapshot MUST include:
- `today: { date, has_log, score, components }` — today's data
- `smoothed_7d: number | null` — 7-day rolling avg of valid scores (0-100)
- `smoothed_30d: number | null` — 30-day rolling avg (0-100)
- `days_scored: number` — count of valid scores in last 30d
- `trend_direction: 'up' | 'down' | 'flat'` — last 3 vs prior 11 days
- `last_14d, last_30d, last_90d` — daily score arrays
- `setup: { is_complete, completed_at, days_since_setup, config }`

Enforced by `adapters/_shape.js:emptyAgentSnapshot()`.

## Cross-Surface Consistency Test

Whenever Home renders, this invariant MUST hold:

```
For every coach C in active coaches:
  Home.coach_card[C].displayed_score === Analysis_tab[C].headline_score
  Home.coach_card[C].status_band === Analysis_tab[C].status_band
```

If violated, file a bug. Both surfaces read the same field name.

## Wellness Score Formula

```
if total_days_logged === 0:
  score = setup_count × 2  // Day-1 warm-start (0..12)
elif total_days_logged < WARM_WIN (14):
  score = real_weight × (raw + EMA) + (1 - real_weight) × warm_seed
else:
  score = weighted_avg_of_agent_scores  // fully real
```

Where `weighted_avg_of_agent_scores` uses `normalizeFromBaseline(todayScore, baseline)` per agent and effective weights from `rawWeights`.

**This formula is preserved unchanged in V2.** It already produces:
- 12 on Day-1 for 6 coaches
- Smooth transition to real data
- Confidence-weighted blending

## Migration Note

Before 2026-05-13:
- Coach cards showed `primary_metric` ("3 Sets", "3010 KCAL")
- Display was inconsistent across agents
- No-log days showed "—"

After 2026-05-13:
- Coach cards show 0-100 score + status word
- Day-1 fallback = `setup_count × 2` = same as Wellness Score
- `primary_metric` still exposed on `coach_states` for backward compat (any legacy reader works)

## What's NOT Touched (Stability)

- Per-agent scoring formulas in `lib/agent-scores.js` (Sleep/Mind clinically-cited; Fitness/Water/Fasting/Nutrition methodology-imperfect but stable)
- Daily score points in `last_30d`, `last_90d`
- `wellness-score.js` formula
- Per-agent `/api/{agent}/analysis` endpoints
- Notifications, reminders, paywall, community, settings

Change surface intentionally narrow.
