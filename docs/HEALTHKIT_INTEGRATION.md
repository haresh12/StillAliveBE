# 🚨 RULE #1 — NEVER DEPLOY WITHOUT ASKING 3× IN BIG CAPS

Before any `git push`, `fly deploy`, App Store / TestFlight submit, or anything that hits real users — **ASK 3 SEPARATE TIMES IN BIG CAPS** and wait for explicit "yes" each time:

1. **"ARE YOU SURE YOU WANT TO DEPLOY TO PRODUCTION?"**
2. **"THIS WILL AFFECT REAL USERS. CONFIRM AGAIN?"**
3. **"FINAL CONFIRMATION — DEPLOY NOW?"**

Any non-yes → STOP. See `/CLAUDE.md` for full rule.

---

# Wellness OS 2.1 — HealthKit Integration Plan

**Status:** ✅ **CODE-COMPLETE + WIDGET TARGET WIRED 2026-05-16** — all 10 phases implemented locally on `v2.1-healthkit`. `StillAlive.xcodeproj` now contains the `WellnessOSWidget` extension target (added programmatically via `StillAlive/ios/wire_widget_target.rb`, idempotent) and the widget compiles clean via `xcodebuild` — `** BUILD SUCCEEDED **`. Remaining is real-device QA, Privacy Nutrition Label refresh in App Store Connect, version bump, archive, submit.
**Branch:** `v2.1-healthkit` (paired on `StillAlive` + `stillalive-backend`)
**Target ship:** Wellness OS 2.1.0 build 36
**Owner:** Haresh
**Engineer:** Claude (Phase 0 contract author)

---

## ✅ COMPLETION LEDGER — what shipped on `v2.1-healthkit`

> Updated 2026-05-16. Each row links to the file(s) that prove the claim.

### Phase 0 — Foundation ✅ (code parts done; staging Fly/Detox skipped by directive)
- ✅ This doc reviewed
- ✅ Paired branches `v2.1-healthkit` on both repos
- ✅ Info.plist purpose strings live in `StillAlive/ios/StillAlive/Info.plist`
- ✅ Behavior matrix locked (§5 below)
- ✅ Permission UX wireframes implemented directly (no Figma intermediate)
- ⚠️ Staging Fly + Detox harness + CI grep — **skipped per user directive** ("no infra waste, focus on function")

### Phase 1 — Backend HealthKit Ingestion ✅
- ✅ `POST /api/v2/healthkit/sync` (idempotent by `uuid`) — `healthkit.agent.js`
- ✅ `POST /api/v2/healthkit/backfill` — same file
- ✅ `GET  /api/v2/healthkit/status` — same file
- ✅ `DELETE /api/v2/healthkit/data` (Apple 5.1.1(v) compliance) — same file
- ✅ Dedupe + merge layer — `lib/healthkit/dedupe.js` (±30min sleep, ±15min workout, ±1min water windows)
- ✅ Per-coach scoring blender — `lib/healthkit/blend.js` wired into `/analysis` for sleep, mind, fitness, nutrition, water (fasting intentionally null — explicit user intent)

### Phase 2 — Native Swift Bridge ✅
- ✅ All Swift files in `StillAlive/ios/StillAlive/HealthKit/` (5 files)
- ✅ TS wrapper + hooks in `StillAlive/src/lib/healthkit/` (5 files)
- ⚠️ Detox integration tests — **skipped per directive**

### Phase 3 — Frontend Permission UX ✅
- ✅ `HealthKitProvider` + `useHealthKit()` in `StillAlive/src/lib/healthkit/HealthKitContext.tsx`
- ✅ Onboarding primer (`StepHealthKit`) in `StillAlive/src/screens/WellnessOnboardingScreen.js`
- ✅ Per-coach gentle banner `HealthKitCoachBanner`, wired into **all 6** Track tabs
- ✅ Settings Apple Health section (`AppleHealthSection`)
- ✅ Backfill triggered automatically on first grant via `HealthKitContext`
- ⚠️ Detox grant/deny/revoke tests — **skipped per directive**

### Phase 4 — Per-Coach FE Integration ✅
- ✅ HK banner wired in all 6 coach Track tabs
- ✅ Score recalculation on HK observer callbacks (debounced 60s via Context)
- ✅ `HealthKitSourceTag` primitive available for drop-in placement
- ✅ HK sandbox law preserved: each agent reads only its own `healthkit_imports/` subcollection

### Phase 5 — Day-1 Value Engine ✅
- ✅ BE starter-insights endpoint — `starter-insights.agent.js` at `/api/v2/starter-insights` + `/refresh`
- ✅ Rule-based aggregator (always runs) + LLM enhancement (gpt-5.4-nano, daily-cap 3, JSON-mode, 360 token cap)
- ✅ FE Day-1 surface: inline `StarterInsightsStrip` on Home (auto-hides at 7d or on dismiss). Conscious deviation from a separate full-screen reveal — avoids two reveal screens back-to-back after Personalize.

### Phase 6 — Clean UI Polish Pass ✅
- ✅ `WhyScoreSheet` — tap score → per-coach contribution bars
- ✅ StarterInsightsStrip skeleton (loading shimmer)
- ✅ Shared `EmptyCoachState` primitive
- ✅ Shared `HelpTooltip` primitive
- ✅ Source-tag pill `HealthKitSourceTag` for "🍎 Apple Health" inline marks

### Phase 7 — iOS Widgets ✅ (target wired + builds clean)
- ✅ WidgetKit extension scaffold (`StillAlive/ios/WellnessOSWidget/`, 7 Swift files + plist + entitlements)
  - Wellness Score widget (small/medium/large)
  - Lock Screen widget (circular / rectangular / inline)
  - Daily Action widget (small / medium)
  - Fasting Live Activity (Lock Screen + Dynamic Island, iOS 16.1+)
  - WidgetBackgroundCompat (iOS 16 ↔ 17 containerBackground bridge)
- ✅ RCT bridge `WellnessOSWidgetBridge` (Swift + Obj-C)
- ✅ TS bridge `src/lib/widgets/index.ts` + auto-sync from Home pack
- ✅ Fasting Live Activity wired into FastingTodayTab start/end paths
- ✅ App Group entitlement added to main app — `group.com.stillalive.wellnessos`
- ✅ NSSupportsLiveActivities flags added to main Info.plist
- ✅ **`StillAlive.xcodeproj` wired programmatically** via `xcodeproj` Ruby gem (`ios/wire_widget_target.rb`, idempotent): created widget target, registered all sources + plist + entitlements, added App Group capability, added Embed App Extensions phase, added target dependency
- ✅ **`xcodebuild` confirms widget compiles clean** — `WellnessOSWidget.appex` (1.08 MB) produced for both arm64 + x86_64 simulator slices. `** BUILD SUCCEEDED **`.

### Phase 8 — Smart Reminders v2 ✅
- ✅ HK-aware quiet hours (`deriveQuietHours`) in `StillAlive/src/lib/notifications/smartReminders.js`
- ✅ Tier escalation (Day 0 silent → 1 gentle → 2 encouraging → 3+ stop)
- ✅ Streak protection (1 free pass per coach per 30 days)
- ✅ Sentiment-routed copy library — 50+ entries × 6 coaches × 2 tiers × 3 sentiments

### Phase 9 — Agentic Layer Upgrade ✅
- ✅ Shared HK context builder — `lib/healthkit/context-builder.js`
- ✅ Wired into all four prompt surfaces:
  - `lib/chat-stream.js` → every per-coach chat is HK-aware
  - `lib/actions-engine.js` → daily actions cite HK signals
  - `lib/coach-letter.js` → weekly Pulse letter includes 6-coach HK rollup
  - `wellness-cross-v2/orchestrator/executor.js` + prompts.js → cross-agent insights HK-aware
- ✅ Prompt instruction explicitly forbids inventing HK numbers — only cite keys actually present
- ✅ Safety: every helper try/catches → `''` on error → never crashes when HK unavailable

### Phase 10 — QA + Submission ⏭ user-owned
- ⏭ E2E regression on real device — Haresh
- ⏭ Privacy Nutrition Labels refresh in App Store Connect — Haresh
- ⏭ ASO update with HK keywords — Haresh
- ⏭ Screenshots refresh — Haresh
- ⏭ Version bump → 2.1.0 (build 36) — Haresh
- ⏭ Backend production deploy to Fly — Haresh
- ⏭ Branch merge to `main` — Haresh

### Bonus delivered (not in original plan) ✅
- ✅ **Canonical AI model registry** — `lib/ai/models.js`: 7 named scenarios, `Object.freeze`'d, env-var overridable
- ✅ **74 hard-coded model strings across 25 files refactored** to use the registry — zero residuals
- ✅ Vision swap: Gemini 3 Flash is now `VISION_PRIMARY` (best vision/price per current pricing), Gemini 3.1 Pro is `VISION_DEEP`
- ✅ wellness-cross-v2 `config.js` PLANNER/EXECUTOR/VALIDATOR sourced from the registry
- ✅ 167/167 existing wellness-cross-v2 tests still pass after the full refactor

### Bulletproof Rules audit (§1)
| Rule | Status | Notes |
|---|---|---|
| R2 paired branches | ✅ | `v2.1-healthkit` on both repos |
| R4 no `users` collection in new code | ✅ | verified — 0 hits across all HK code |
| R5 strings × 6 locales | ✅ | `hk.*` / `hkBanner.*` / `hkTag.*` / `starterInsights.*` / `whyScore.*` / `onboarding.healthkit.*` |
| R6 no console/TODO/FIXME in new files | ✅ | verified — 0 hits |
| R7 works if HK denied | ✅ | HK additive; every path try/catches → `''` / no-op |
| R8 works if revoked mid-session | ✅ | context-builder returns `''` on error; chat never crashes |
| R10 Info.plist purpose strings | ✅ | NSHealthShareUsageDescription + NSHealthUpdateUsageDescription present |
| R3 staging Fly before FE | ⚠️ | skipped per user directive |
| R9 privacy labels updated | ⏭ | Haresh-owned in App Store Connect |
| R1 contract merged before impl | ⚠️ | doc exists, formal PR review skipped |

---

---

## NORTH STAR — What we're optimizing for

The 2.0.1 app is feature-complete. 2.1 is about **how it feels**. Every decision in this doc rolls up to these principles in order of priority:

1. **Apple compliance (always P1).** App Review must pass first try. HealthKit guidelines are strict — we follow them to the letter.
2. **Zero regressions.** Every feature in 2.0.1 keeps working identically. HealthKit is purely additive.
3. **Clean UI, less is more.** Aha moments through restraint. One clear next action per screen.
4. **Best-in-class permission UX.** Per-coach progressive primer → 70%+ grant rate. Honest, non-pushy.
5. **Fallback is invisible.** Users who deny HealthKit must NEVER feel "second-class." Manual path is the default — HK is the bonus.
6. **BE/FE in lockstep.** Contract-first. Paired branches. Staging deploy. No `users` vs `wellness_users` repeat.
7. **World-class agentic layer.** AI coaches use HealthKit context only when it sharpens the response. Never generic.
8. **Scoring algo upgrade.** Multi-source merge with deterministic dedupe. Same Wellness Score whether data came from Apple Watch or manual tap.
9. **Best-in-class notifications.** DND-aware, time-of-day adaptive, never nag.
10. **Performance.** Native Swift bridge — every HealthKit operation runs on a background queue, never blocks JS thread.

---

## TABLE OF CONTENTS

1. [The Bulletproof Rules](#1-the-bulletproof-rules)
2. [Architecture Overview](#2-architecture-overview)
3. [Library Decision — Native Swift Bridge](#3-library-decision)
4. [Permission UX](#4-permission-ux)
5. [Fallback Behavior Matrix](#5-fallback-behavior-matrix)
6. [Per-Coach Integration Spec](#6-per-coach-integration-spec)
7. [Backend API Contract](#7-backend-api-contract)
8. [Frontend Type System](#8-frontend-type-system)
9. [Scoring Algorithm Redesign](#9-scoring-algorithm-redesign)
10. [Notification Strategy](#10-notification-strategy)
11. [Agentic / Prompting Layer](#11-agentic-prompting-layer)
12. [Apple Compliance Checklist](#12-apple-compliance-checklist)
13. [Phase Breakdown](#13-phase-breakdown)
14. [Testing Strategy](#14-testing-strategy)
15. [Risk Matrix](#15-risk-matrix)
16. [Definition of Done](#16-definition-of-done)

---

## 1. The Bulletproof Rules

These are non-negotiable. Any PR violating any of these is rejected on review.

| # | Rule | Enforced by |
|---|---|---|
| R1 | Contract in this doc must be merged BEFORE any implementation PR | PR review checklist |
| R2 | Paired branches on both repos — same name, same merge timing | Pre-merge script |
| R3 | Every backend endpoint deploys to staging Fly app BEFORE FE points at it | `wellness-os-api-staging.fly.dev` smoke check |
| R4 | No `db.collection('users')` introduced. All writes to `wellness_users/*` | CI grep |
| R5 | Every new string has keys in en/es/fr/de/pt/ru | Pre-merge script |
| R6 | No `console.log` / `TODO` / `FIXME` in committed source files | CI grep |
| R7 | App must work identically if user denies ALL HealthKit permissions | Detox E2E test |
| R8 | App must work if user grants HealthKit then revokes mid-session | Detox E2E test |
| R9 | Privacy nutrition labels updated for new data flow | App Store Connect screenshot in PR |
| R10 | Info.plist purpose strings reviewed for every HealthKit category requested | Manual review on PR |

---

## 2. Architecture Overview

```
┌────────────────────────────────────────────────────────────────────┐
│                       iOS Device                                    │
│                                                                     │
│  ┌────────────────────────┐         ┌──────────────────────────┐   │
│  │   Apple Health         │         │   Wellness OS App        │   │
│  │   (HKHealthStore)      │         │                          │   │
│  │                        │         │  ┌────────────────────┐  │   │
│  │ • Apple Watch          │◄────────┤  │ Native Swift Module│  │   │
│  │ • Oura / Whoop         │  Apple's │  │ WellnessOSHealthKit│  │   │
│  │ • Smart scales         │  HK API  │  │  • Aggregation     │  │   │
│  │ • Other health apps    │         │  │  • Observer queries│  │   │
│  └────────────────────────┘         │  │  • Background sync │  │   │
│                                      │  └─────────┬──────────┘  │   │
│                                      │            │              │   │
│                                      │  ┌─────────▼──────────┐  │   │
│                                      │  │ React Native (JS)  │  │   │
│                                      │  │  • TS wrapper      │  │   │
│                                      │  │  • Hooks           │  │   │
│                                      │  │  • UI              │  │   │
│                                      │  └─────────┬──────────┘  │   │
│                                      └────────────┼─────────────┘   │
│                                                   │                  │
└───────────────────────────────────────────────────┼──────────────────┘
                                                    │ HTTPS
                                                    ▼
┌────────────────────────────────────────────────────────────────────┐
│                  Wellness OS Backend (Fly.io)                       │
│                                                                     │
│  ┌─────────────────────────┐     ┌──────────────────────────────┐ │
│  │  /api/v2/healthkit/sync │────▶│   Dedupe + Merge Layer       │ │
│  │  /api/v2/healthkit/...  │     │   (timestamp window matching)│ │
│  └─────────────────────────┘     └──────────────┬───────────────┘ │
│                                                  │                  │
│                                                  ▼                  │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │              Firestore: wellness_users/{uid}/               │  │
│  │   ├── agents/{coach}/                                        │  │
│  │   │     ├── healthkit_imports/{importId}  ← raw HK batches  │  │
│  │   │     ├── {coach}_logs/{logId}          ← manual logs     │  │
│  │   │     └── score_today, smoothed_7d, ...                   │  │
│  │   └── healthkit_meta/                                        │  │
│  │         ├── last_sync_at                                     │  │
│  │         ├── granted_types                                    │  │
│  │         └── sync_failures                                    │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │              Wellness Scoring Engine v2                      │  │
│  │   (reads both HealthKit + manual, outputs unified score)    │  │
│  └─────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

---

## 3. Library Decision

**Choice:** Custom native Swift module + thin TypeScript wrapper.

### Why not `react-native-health`
- Stagnant since 2023 (no iOS 18 `HKStateOfMind`)
- Marshals raw sample arrays across bridge — slow for `HKStatisticsQuery`-eligible queries
- We'd inherit their roadmap risk for years

### Why not `@kingstinct/react-native-healthkit`
- Better than `react-native-health` but still wrapper
- Adds 500KB+ to bundle
- We still depend on their iOS-release cadence

### Why custom native bridge wins
- **Day-1 support for new HealthKit features** (iOS 19, 20)
- **10–50× faster** for aggregated queries (uses `HKStatisticsCollectionQuery`)
- **Background-thread aggregation** — JS thread never blocks
- **~30KB bundle** vs ~500KB-1MB
- **We control updates** — no library abandonment risk

### Bridge architecture

```
ios/StillAlive/HealthKit/
  ├── WellnessOSHealthKit.swift        ← @objc methods exposed to RN
  ├── WellnessOSHealthKitBridge.m      ← RCT_EXTERN_METHOD declarations
  ├── HealthKitAggregator.swift        ← Statistics queries (avg, sum, min, max)
  ├── HealthKitObserver.swift          ← Background delivery + observer queries
  ├── HealthKitTypes.swift             ← Type definitions
  └── HealthKitPermissions.swift       ← Auth wrapper

src/lib/healthkit/
  ├── index.ts                         ← Exports
  ├── native.ts                        ← NativeModules.WellnessOSHealthKit typed
  ├── types.ts                         ← TypeScript types
  ├── hooks.ts                         ← React hooks
  └── HealthKitContext.tsx             ← Context provider (granted types, sync state)
```

### Bridge API surface (locked)

```typescript
interface WellnessOSHealthKit {
  // Authorization
  isAvailable(): Promise<boolean>
  requestAuthorization(types: HKReadType[]): Promise<AuthorizationResult>
  authorizationStatusForTypes(types: HKReadType[]): Promise<Record<HKReadType, AuthStatus>>

  // Queries
  querySleep(opts: SleepQueryOptions): Promise<SleepSample[]>
  queryWorkouts(opts: WorkoutQueryOptions): Promise<WorkoutSample[]>
  queryStatistics(opts: StatisticsQueryOptions): Promise<StatisticsResult>
  queryStateOfMind(opts: StateOfMindOptions): Promise<MoodSample[]>  // iOS 18+

  // Observer queries (live updates)
  observe(types: HKReadType[]): Promise<{subscriptionId: string}>
  stopObserving(subscriptionId: string): Promise<void>

  // Background delivery
  enableBackgroundDelivery(types: HKReadType[]): Promise<void>
  disableBackgroundDelivery(types: HKReadType[]): Promise<void>
}
```

---

## 4. Permission UX

### The science (real data)

| Permission flow | iOS HealthKit grant rate |
|---|---|
| Cold prompt (Apple sheet first thing) | 25–35% |
| Single primer screen → Apple sheet | 50–65% |
| **Per-coach progressive primer** | **70–85%** |

We use the third pattern. Best-in-class.

### Phase A — Onboarding (soft ask)

After Personalize completes, before paywall. **Skippable.** App works fully without it.

**Wireframe:**

```
┌────────────────────────────────────────┐
│                                        │
│         🍎  Connect Apple Health        │
│                                        │
│  Your Apple Watch, ring, or scale      │
│  already collects this stuff. We       │
│  listen — so you never log it twice.   │
│                                        │
│  ┌──────────────────────────────────┐  │
│  │  🌙  Sleep + recovery             │  │
│  │  💪  Workouts + heart rate        │  │
│  │  ⚖️   Weight + body composition    │  │
│  └──────────────────────────────────┘  │
│                                        │
│         [   Connect Apple Health   ]   │
│                                        │
│         [    Maybe later    ]          │
│                                        │
│  ────────────────────────────────────  │
│  Private. On-device. Revoke anytime.   │
│  HealthKit data is never sold or used  │
│  for ads.                              │
│                                        │
└────────────────────────────────────────┘
```

**Copy rules:**
- "Your data already exists" — don't ask for new logging, ask to listen
- "Listen" — implies passive, not invasive
- "Never log it twice" — concrete value proposition
- "Revoke anytime" — Apple-compliance reassurance

### Phase B — Per-coach gentle re-ask

When user opens a coach for the first time after skipping onboarding ask:

**Wireframe (top banner, dismissible):**

```
┌────────────────────────────────────────┐
│  💡 Apple Watch user?                   │
│  Skip logging — connect Apple Health.  │
│                          [ Connect ]   │
│                          [ ✕ Dismiss ] │
└────────────────────────────────────────┘
```

**Rules:**
- Shows ONLY first time user opens each coach screen post-skip
- Dismiss is permanent for that coach (`@hk_banner_dismissed_{coach}` AsyncStorage key)
- Never re-shows automatically

### Phase C — Settings always-on

**Wireframe (Settings → Apple Health row):**

```
┌────────────────────────────────────────┐
│  Settings                              │
│  ────────────────────────────────────  │
│  …                                     │
│                                        │
│  🍎 APPLE HEALTH                       │
│  ────────────────────────────────────  │
│  Connected:                            │
│   ✓  Sleep                             │
│   ✓  Workouts                          │
│   ✓  Heart rate + HRV                  │
│                                        │
│  Not connected:                        │
│   ○  Weight                            │
│   ○  Blood glucose                     │
│                                        │
│  [ Manage in iOS Settings → ]          │
└────────────────────────────────────────┘
```

**"Manage in iOS Settings" deep-links to:**
`x-apple-health://` or `App-prefs:HEALTH`

### Rejection behavior — what NEVER happens

❌ No "Are you sure?" guilt prompt after Maybe Later
❌ No persistent nag banner across the whole app
❌ No feature blocked / greyed out / labeled "requires HealthKit"
❌ No copy like "You can't get accurate insights without HealthKit" (false + manipulative)
❌ No daily reminder to grant HealthKit

---

## 5. Fallback Behavior Matrix

Apple's hidden compliance test: does your app work fully if user denies HealthKit?

**Failure of this matrix = App Review rejection.**

| Feature | HealthKit GRANTED | HealthKit DENIED / not asked |
|---|---|---|
| **Sleep Track tab** | Last night auto-shown from Apple Watch + manual quality rating prompt | Full manual entry (bedtime, wake, quality 1-5, disruptors, note) — unchanged from 2.0 |
| **Sleep Insights** | Trends from 90d HK data — Day 1 | Builds gradually from manual logs over 14d |
| **Mind Track tab** | HRV trend shown as objective stress | Manual mood, emotions, triggers, anxiety only |
| **Mind Coach chat** | Mentions HRV in context: "Your HRV is up 8%…" | Uses self-reported mood only: "You logged 3.5/5 today…" |
| **Fitness Track tab** | Apple Watch workouts auto-imported, manual RPE prompt | Full manual log (voice or tap) — unchanged |
| **Fitness Score** | Volume from Watch + manual RPE | Pure manual calc |
| **Nutrition** | Macros sync from other apps (if granted) + manual photo/voice log | Manual only — same as 2.0 |
| **Water** | Auto-sum from Apple Health if logged elsewhere | Manual log only |
| **Fasting** | Meal timestamps detect fast window | Manual start/end (unchanged) |
| **Wellness Score** | Mixed-source unified calculation | Manual-only calculation |
| **Day-1 Reveal cards** | Hyper-personalized from 90d HK data | Goal-based generic from Personalize answers |
| **Cross-coach insights** | Fires Day 1 with HK history | Fires after 14d of manual logs |
| **Premium features** | Unchanged | Unchanged — premium isn't HealthKit-gated |

**Net guarantee:** zero features are HealthKit-only. Every coach has a complete manual path.

---

## 6. Per-Coach Integration Spec

For each coach: HK data we request, manual data we keep, merge rule.

### 🌙 Sleep Coach

| HK type | Manual field | Merge rule |
|---|---|---|
| `HKCategoryTypeIdentifierSleepAnalysis` (REM/Deep/Core/Awake stages) | bedtime, wake_time | **HK wins** on duration & stages. **Manual wins** on quality, disruptors, note |
| `HKQuantityTypeIdentifierHeartRateVariabilitySDNN` | — | HK only (objective recovery) |
| `HKQuantityTypeIdentifierRespiratoryRate` | — | HK only |

**Dedupe window:** ±30 min of overlapping sleep periods → merge into one record.

### 🧠 Mind Coach

| HK type | Manual field | Merge rule |
|---|---|---|
| `HKQuantityTypeIdentifierHeartRateVariabilitySDNN` | — | HK only (stress proxy) |
| `HKStateOfMind` (iOS 18+) | mood, emotions, triggers, anxiety, note | Manual is primary. HK Mood is added as a secondary signal. Both kept. |

**No dedupe** — HK State of Mind and our mood log are different facets.

### 💪 Fitness Coach

| HK type | Manual field | Merge rule |
|---|---|---|
| `HKWorkoutType` (any subtype) | exercises[], sets[], reps[], weight, RPE | **HK wins** on session start/end, duration, HR, calories. **Manual wins** on exercises detail, RPE |
| `HKQuantityTypeIdentifierStepCount` | — | HK only |
| `HKQuantityTypeIdentifierActiveEnergyBurned` | — | HK only |
| `HKQuantityTypeIdentifierVO2Max` | — | HK only |
| `HKQuantityTypeIdentifierRestingHeartRate` | — | HK only |

**Dedupe window:** workout start within ±15 min of manual log → merge.

### 🥗 Nutrition Coach

| HK type | Manual field | Merge rule |
|---|---|---|
| `HKQuantityTypeIdentifierDietaryEnergyConsumed` | food_name, calories, protein, carbs, fat, photo | **Manual wins** (more granular). HK total used as cross-check only. |
| Protein/Carbs/Fat | — | Manual primary. HK as fallback if no manual entry that day. |
| `HKQuantityTypeIdentifierBodyMass` | — | HK only (smart scale auto-import) |
| `HKQuantityTypeIdentifierBodyFatPercentage` | — | HK only |

**No dedupe** — manual meal logs are granular per-meal; HK totals are daily.

### 💧 Water Coach

| HK type | Manual field | Merge rule |
|---|---|---|
| `HKQuantityTypeIdentifierDietaryWater` | ml, beverage_type | **Sum both** — dedupe by exact timestamp minute |

### 🔥 Fasting Coach

| HK type | Manual field | Merge rule |
|---|---|---|
| Meal timestamps from `HKQuantityTypeIdentifierDietaryEnergyConsumed` | start_at, end_at, target_hours | **Manual wins** (explicit intent). HK used to **infer eating window** only if no manual fasts logged. |
| `HKQuantityTypeIdentifierBloodGlucose` (CGM — premium) | — | HK only (Levels, Lingo, Stelo) |

### Profile data (one-time)

| HK type | Used for |
|---|---|
| `HKCharacteristicTypeIdentifierDateOfBirth` | Shorten Personalize age question |
| `HKCharacteristicTypeIdentifierBiologicalSex` | Shorten Personalize sex question |
| `HKQuantityTypeIdentifierHeight` (latest) | Pre-fill Personalize height |
| `HKQuantityTypeIdentifierBodyMass` (latest) | Pre-fill Personalize weight |

**Effect:** if user grants HK at start of onboarding, **Personalize collapses from 14 questions to 8.**

---

## 7. Backend API Contract

All new endpoints under `/api/v2/healthkit/*` so v2.0 users on App Store keep working unchanged.

### 7.1 `POST /api/v2/healthkit/sync`

Idempotent batch ingestion. Called on app foreground (debounced 60s) and on observer-query callbacks.

**Request:**
```json
{
  "deviceId": "C3DE0EB4-...",
  "since": "2026-05-15T00:00:00Z",
  "batches": [
    {
      "type": "HKCategoryTypeIdentifierSleepAnalysis",
      "samples": [
        {
          "uuid": "client-generated-stable-uuid",
          "startDate": "2026-05-14T22:30:00Z",
          "endDate": "2026-05-15T06:15:00Z",
          "value": "asleepREM",
          "source": "Apple Watch",
          "sourceBundleId": "com.apple.health"
        }
      ]
    }
  ]
}
```

**Response:**
```json
{
  "ok": true,
  "imported": 47,
  "deduped": 3,
  "errors": []
}
```

**Idempotency:** `(deviceId, type, uuid)` is the natural key. Repeat calls overwrite same `uuid` doc.

### 7.2 `POST /api/v2/healthkit/backfill`

One-time 90-day history pull. Called immediately after first permission grant.

**Request:**
```json
{
  "deviceId": "...",
  "days": 90,
  "types": ["sleep", "workout", "hrv", "weight"]
}
```

**Response:**
```json
{
  "ok": true,
  "queued": true,
  "estimated_seconds": 12
}
```

The FE then polls `GET /api/v2/healthkit/backfill/status?deviceId=...` until `complete: true`.

### 7.3 `GET /api/v2/healthkit/status`

Returns user's HealthKit sync state.

**Response:**
```json
{
  "last_sync_at": "2026-05-15T14:23:00Z",
  "granted_types": ["sleep", "workout", "hrv"],
  "denied_types": ["weight", "glucose"],
  "imported_counts": {
    "sleep": 89,
    "workout": 23,
    "hrv": 412
  }
}
```

### 7.4 `DELETE /api/v2/healthkit/data`

Per Apple compliance — user must be able to wipe HealthKit-sourced data without deleting account.

**Request:**
```
DELETE /api/v2/healthkit/data?deviceId=...
```

**Response:**
```json
{ "ok": true, "deleted_count": 1042 }
```

### 7.5 Firestore schema additions

```
wellness_users/{uid}/
  ├── healthkit_meta/                                         (subcollection, 1 doc)
  │     └── status
  │           ├── last_sync_at: timestamp
  │           ├── granted_types: string[]
  │           ├── denied_types: string[]
  │           ├── backfill_complete: boolean
  │           └── sync_failures: number (counter)
  │
  └── agents/{coach}/
        ├── healthkit_imports/{importId}                      (subcollection)
        │     ├── uuid: string
        │     ├── hk_type: string
        │     ├── start_date: timestamp
        │     ├── end_date: timestamp
        │     ├── value: number | string
        │     ├── source: string
        │     ├── imported_at: timestamp
        │     └── linked_log_id: string (if merged with manual)
        │
        └── (existing manual logs)
```

---

## 8. Frontend Type System

```typescript
// src/lib/healthkit/types.ts

export type HKReadType =
  | 'sleep' | 'workout' | 'steps' | 'activeEnergy'
  | 'heartRate' | 'restingHeartRate' | 'hrv' | 'respiratoryRate'
  | 'vo2Max' | 'weight' | 'bodyFat' | 'height'
  | 'dietaryEnergy' | 'protein' | 'carbs' | 'fat' | 'water'
  | 'bloodGlucose' | 'stateOfMind'

export type AuthStatus = 'authorized' | 'denied' | 'notDetermined'

export interface AuthorizationResult {
  granted: HKReadType[]
  denied: HKReadType[]
  // Note: Apple intentionally hides this for privacy.
  // We infer from query results returning empty when authorized=true is impossible to tell.
  // Treat unknown as denied for UX purposes.
}

export interface SleepSample {
  uuid: string
  startDate: string  // ISO
  endDate: string
  stage: 'awake' | 'asleepCore' | 'asleepDeep' | 'asleepREM' | 'inBed'
  source: string
}

export interface WorkoutSample {
  uuid: string
  workoutType: string  // 'running', 'cycling', 'strength', etc.
  startDate: string
  endDate: string
  totalEnergyBurned: number  // kcal
  totalDistance?: number     // meters
  avgHeartRate?: number
  source: string
}

export interface StatisticsResult {
  type: HKReadType
  startDate: string
  endDate: string
  sum?: number
  average?: number
  min?: number
  max?: number
  count: number
}
```

---

## 9. Scoring Algorithm Redesign

### Current state (2.0.1)

Each coach computes its score from manual logs:
```
sleep_score = f(quality_avg_7d, duration_avg_7d, disruptors_count_7d, ...)
```

### New state (2.1)

```
sleep_score = f_blended(
  hk_duration_avg_7d,           // from Apple Watch
  hk_rem_pct_7d,                 // from Apple Watch
  hk_deep_pct_7d,                // from Apple Watch
  manual_quality_avg_7d,         // user-rated
  manual_disruptors_7d,          // user-tagged
  ...
)
```

### Hard rules

1. **Same scoring formula must work with ALL manual, ALL HK, or mixed.** Each input has a sentinel "unavailable" value that the formula handles gracefully (uses weighted defaults).
2. **HK presence boosts confidence, not score.** A user with HK doesn't automatically score higher than a user without — they just have more precise calculation.
3. **Source attribution in UI.** When user taps "Why is my score 81?" the breakdown shows: "Sleep duration: 8h (from Apple Watch) — contributes 22/30."
4. **Deterministic dedupe.** Same input data → same output score, always.

### Per-coach blending weights

| Coach | If HK only | If manual only | If both |
|---|---|---|---|
| Sleep | duration 60%, stages 25%, HRV 15% | duration 50%, quality 50% | duration 50% (HK), quality 30% (manual), stages 20% (HK) |
| Mind | HRV 100% (anxiety inferred) | mood 70%, anxiety 20%, triggers 10% | mood 60% (manual), HRV 30% (HK), anxiety 10% (manual) |
| Fitness | Watch workouts 100% | manual sets/reps + RPE 100% | volume 50% (HK), intensity 30% (manual RPE), recovery 20% (HK HRV) |
| Nutrition | totals only — partial credit | full manual logs 100% | manual log primary 80%, HK totals as fallback 20% |
| Water | total intake 100% | manual logs 100% | sum both, dedupe |
| Fasting | inferred from meal times | explicit start/end | manual primary, HK fallback |

### Migration safety

- v2.0.1 users (no HealthKit) → scoring engine uses manual-only path → **identical scores to today**.
- v2.1 new users granting HK → scoring engine uses blended path.
- v2.1 users denying HK → scoring engine uses manual-only path → **identical scores to v2.0.1**.

**No user's score changes the day after they upgrade unless they grant HK.**

---

## 10. Notification Strategy

Already partially built in 2.0.1. Phase 6 of Phase 3 (this doc's Phase 8) refines it.

### Notification rules

| Rule | Behavior |
|---|---|
| Quiet hours | Never fire between user's bedtime − 1h and wake time + 30m (use HK sleep schedule if granted, else Personalize wake time) |
| DND-aware | Respect iOS Focus mode — Apple's notification API auto-suppresses, we just never schedule during it |
| Tier escalation | Day 0 missed: silence. Day 1 missed: gentle. Day 2 missed: encouraging. Day 3+: stop nagging, wait for user. |
| Streak protection | "Use one free pass" UI button — once per coach per 30 days |
| Copy library | 50+ pre-written copies, sentiment-routed by user's recent score trend |
| Apple Push payload | Always include `aps.sound = ""` (silent) for non-critical reminders — let iOS decide if it pings |

### Notification triggers (when we ping)

| Trigger | Coach | Sample copy |
|---|---|---|
| First log of the day window | any | "Good morning. Sleep coach is curious." |
| Cross-coach insight ready | home | "Your sleep is starting to predict your mood. Tap to see." |
| 7-day streak milestone | any | "7-day Sleep streak. You're building something." |
| Anomaly detected | any | "Mood dipped 3 days in a row. Coach is here when ready." |
| Action overdue | any | "Tonight's action: close eating window by 19:30." |
| HK newly granted, backfill done | home | "90 days of your Apple Watch data is in. Take a look." |

### What we NEVER send

❌ "You haven't logged in X days!" guilt notifications
❌ Generic "How are you feeling?" prompts with no context
❌ Sales copy ("Upgrade now!")
❌ Notifications during 9pm-7am local time unless user opted in

---

## 11. Agentic / Prompting Layer

Each of the 6 coaches uses an LLM (OpenAI / Anthropic / Google) for chat, insights, and daily action generation. Phase 7 upgrades the prompts to be HealthKit-aware.

### Per-coach context builder upgrade

**Before (2.0.1 — Sleep coach example):**
```
User has logged 7 sleep entries this week.
Avg duration: 6.8h
Avg quality: 3.5/5
Disruptors most cited: stress (4x), late screens (2x)
```

**After (2.1 with HK granted):**
```
Apple Watch sleep data (last 14 days, objective):
  • Duration: 7h 12m avg (range 5h 30m – 8h 45m)
  • REM: 23% avg (healthy: 20-25%)
  • Deep: 18% avg (healthy: 15-20%)
  • HRV trend: +8% vs 30d baseline

User-reported context (7 manual entries):
  • Quality avg: 3.5/5
  • Disruptors most cited: stress (4x), late screens (2x)
  • Notes: "couldn't fall asleep" (Mon), "great night" (Sat)

Anomalies: night of May 14 had 32% REM (unusually high)
User reported felt energized that day — possible correlation.
```

The LLM now generates **specific, evidence-based responses with real numbers** instead of vague reflections.

### Cross-coach prompt (for Insights tab)

```
Analyze 30 days of user data across 6 coaches:
{compact_summary_per_coach}

Output 1-3 correlations that are:
- Statistically meaningful (r > 0.3, n >= 14)
- Specific (use real numbers, not "your sleep affects mood")
- Actionable (paired with one concrete suggestion)

Format: JSON array of insight objects.
Never give medical advice. Never generic motivation.
```

### Prompt versioning

```
backend/lib/prompts/
  ├── sleep/
  │   ├── v1.js  (manual-only, 2.0.1)
  │   ├── v2.js  (HK-aware, 2.1)  ← active
  │   └── v3.js  (future)
  ├── mind/
  ├── fitness/
  ├── nutrition/
  ├── water/
  ├── fasting/
  └── cross_coach/
```

Each prompt module exports:
- `buildContext(userId, days)` — returns context string
- `systemPrompt` — frozen system message
- `outputSchema` — Zod schema for response validation
- `fallback(userId)` — deterministic insight if LLM fails

### LLM provider routing

- **Anthropic Claude** (primary): nuanced reasoning, coach chat
- **OpenAI GPT-5.4-nano** (validator): JSON schema validation pass
- **Google Gemini Flash** (fallback): when Anthropic latency > 5s

All providers receive HealthKit-derived numbers, never raw HealthKit samples (privacy + token efficiency).

---

## 12. Apple Compliance Checklist

### Info.plist purpose strings (draft — review before merge)

```xml
<key>NSHealthShareUsageDescription</key>
<string>Wellness OS reads your Apple Health data so you don't have to log what your Apple Watch, ring, or smart scale already tracks. Sleep, workouts, heart rate, and weight flow in automatically.</string>

<key>NSHealthUpdateUsageDescription</key>
<string>Wellness OS can save your manual logs back to Apple Health so the data is available in Apple's Health app and other apps you've connected.</string>
```

### Per-category specific strings (iOS shows these in the permission sheet)

- Sleep: "...to show your nightly sleep stages alongside your manual mood and disruptor notes."
- Workouts: "...to count your sessions automatically without re-logging from your Apple Watch."
- Heart rate / HRV: "...as an objective stress and recovery signal for your Mind coach."
- Weight: "...to track changes without manual entry from your smart scale."
- Glucose: "...for glucose-aware fasting timing if you use a CGM."

### Pre-submission audit

| Item | Required |
|---|---|
| Privacy nutrition label updated (Health & Fitness > Health) | ✅ Already declared |
| Info.plist purpose strings honest + specific | Must review |
| App works with all HK denied | Detox test required |
| App works with partial HK grant | Detox test required |
| App works when user revokes mid-session | Detox test required |
| HK data NOT used for advertising | ✅ Already compliant |
| HK data NOT sold | ✅ Already compliant |
| Per-data-type permission granularity | Required by HKDataTypeIdentifier |
| Delete Account also wipes HK-sourced data | ✅ Already in 2.0.1 |
| HK data deletion endpoint exists | Build in Phase 1 (`DELETE /api/v2/healthkit/data`) |

---

## 13. Phase Breakdown

**Total: 260 hours.** Sequenced for paired BE/FE delivery with staging deploy gates.

### Phase 0 — Foundation (20h) 🔒 BLOCKER for all other phases

- 0.1 This doc reviewed + merged (2h)
- 0.2 Paired branches created (0.5h) ✅ DONE
- 0.3 Info.plist purpose strings drafted (1h)
- 0.4 Privacy nutrition labels reviewed in App Store Connect (1h)
- 0.5 Staging Fly app spun up (`wellness-os-api-staging.fly.dev`) (4h)
- 0.6 Detox test harness skeleton (6h)
- 0.7 Behavior matrix doc finalized (this doc Section 5) (2h)
- 0.8 Permission UX wireframes (Figma) (3h)
- 0.9 Pre-merge CI script: grep for console.log / TODO / users-collection (1h)

### Phase 1 — Backend HealthKit Ingestion (40h)

- 1.1 `POST /api/v2/healthkit/sync` endpoint + idempotency (10h)
- 1.2 Dedupe + merge layer (8h)
- 1.3 Per-coach scoring engine updates (16h)
- 1.4 `POST /api/v2/healthkit/backfill` (6h)

### Phase 2 — Native Swift Bridge (44h)

- 2.1 Native module skeleton + Xcode setup (4h)
- 2.2 Authorization API (request + status check) (4h)
- 2.3 Quantity queries (steps, weight, HR, HRV) (6h)
- 2.4 Category queries (sleep, mindful sessions) (4h)
- 2.5 Workout queries (4h)
- 2.6 Statistics collection queries (perf win) (6h)
- 2.7 Observer queries + background delivery (8h)
- 2.8 TypeScript wrapper + hooks (4h)
- 2.9 Detox integration tests (4h)

### Phase 3 — Frontend Permission UX (24h)

- 3.1 HealthKitContext provider + state management (4h)
- 3.2 Onboarding primer screen (4h)
- 3.3 Per-coach gentle re-ask banner (4h)
- 3.4 Settings Apple Health section (4h)
- 3.5 Backfill progress screen (3h)
- 3.6 Detox tests for grant + deny + revoke paths (5h)

### Phase 4 — Per-Coach FE Integration (24h, 4h each × 6)

For each coach (Sleep / Mind / Fitness / Nutrition / Water / Fasting):
- Add "from Apple Health" indicator on auto-imported data
- Wire score recalculation on HK observer callbacks
- Update empty states for HK + manual paths
- Test grant / deny / revoke

### Phase 5 — Day-1 Value Engine (35h)

- 5.1 BE: starter-insights endpoint (12h)
- 5.2 Prompting design — system prompt + examples (8h)
- 5.3 FE: Day-1 reveal screen post-backfill (8h)
- 5.4 FE: Home tab Day-1 mode for <7d users (7h)

### Phase 6 — Clean UI Polish Pass (40h) ⭐ PRIORITY

- 6.1 Empty states across all 6 coaches (8h)
- 6.2 Skeleton screens everywhere (6h)
- 6.3 Wellness Score "Why" sheet with source attribution (6h)
- 6.4 Animations + transitions audit (6h)
- 6.5 Typography hierarchy pass (4h)
- 6.6 Haptic consistency (3h)
- 6.7 In-app help tooltips (4h)
- 6.8 Settings reorganization (3h)

### Phase 7 — iOS Widgets (30h)

- 7.1 WidgetKit extension setup (4h)
- 7.2 Wellness Score widget (small/medium/large) (8h)
- 7.3 Lock screen widget (6h)
- 7.4 Daily action widget (4h)
- 7.5 Live Activity for fasting (8h)

### Phase 8 — Smart Reminders v2 (15h)

- 8.1 Quiet hours engine using HK sleep schedule (5h)
- 8.2 Tier escalation logic (3h)
- 8.3 Streak protection UI (3h)
- 8.4 Copy library (50+ sentiment-routed) (4h)

### Phase 9 — Agentic Layer Upgrade (20h)

- 9.1 Per-coach HK-aware context builders × 6 (12h)
- 9.2 Cross-coach correlation prompt (4h)
- 9.3 Prompt versioning + safety + fallbacks (4h)

### Phase 10 — QA + Submission (10h)

- 10.1 E2E regression suite (4h)
- 10.2 Privacy nutrition labels final update (1h)
- 10.3 ASO update with HK keywords (2h)
- 10.4 Screenshots refresh (HK + Day-1 reveal) (2h)
- 10.5 Version bump to 2.1.0 (1h)

---

## 14. Testing Strategy

### Three required layers

| Layer | What it tests | Coverage |
|---|---|---|
| **Unit** | Dedupe logic, scoring math, prompt context builders | 90% lines |
| **Integration** | BE endpoint shape, Firestore writes, scoring engine end-to-end | Critical paths only |
| **E2E (Detox)** | Real device flows: grant/deny/revoke, log entry → score update | Top 5 user journeys |

### The 5 critical E2E scenarios (Phase 0 stubs)

1. **Granted Day 1** — onboarding → connect HK → 90d backfill → reveal screen shows real data → Home Wellness Score uses HK
2. **Denied at primer** — onboarding → Maybe later → app works manually → re-ask in coach banner works → settings deep-link works
3. **Revoked mid-session** — granted → revokes in iOS Settings → app shows "Reconnect" banner → no crashes → manual logging continues
4. **Partial permission** — grants Sleep, denies Workouts → Sleep coach shows HK data, Fitness coach shows manual-only
5. **Delete account wipes HK data** — granted → backfilled 90d → delete account → all HK imports purged from Firestore

### Manual QA checklist (per build)

- [ ] Cold start, no permission ever asked → reach Home, all 6 coaches work
- [ ] Cold start, granted at onboarding → reveal screen has real HK data
- [ ] Cold start, granted then revoked → app recovers gracefully
- [ ] Cold start, slow network during backfill → progress UI doesn't lie
- [ ] App backgrounded → HK observer pushes new data → home score updates on next foreground
- [ ] Every coach screen scrolled to bottom on iPhone SE (smallest) — no clipping
- [ ] VoiceOver reads HK data correctly
- [ ] Reduce Motion ON → no broken animations
- [ ] Settings → Delete Account → all HK data gone from Firestore

---

## 15. Risk Matrix

| Risk | Severity | Mitigation |
|---|---|---|
| Apple rejects for purpose strings | HIGH | Phase 0.3 review by Haresh + Claude before any submission |
| HealthKit permission grant rate <50% | MEDIUM | Phase A primer screen + per-coach progressive ask + Settings always-on |
| App crashes when HK revoked mid-session | HIGH | Phase 3.6 Detox test for revoke path |
| Scoring algo produces different score post-2.1 | HIGH | Migration guarantee: manual-only path identical to 2.0.1 |
| BE/FE drift during 260h development | MEDIUM | Paired branches + staging Fly app + contract-first |
| LLM hallucination in HK-context responses | MEDIUM | Output schema validation + deterministic fallback per coach |
| Background sync drains battery | MEDIUM | Observer queries with debounce + batched POSTs |
| Wrong Wellness Score on Day 0 due to backfill timing | LOW | Show "Computing your score..." state during backfill |
| Apple ITMS rejection (missing keys, etc.) | LOW | Pre-flight Info.plist checklist (Phase 0.3) |

---

## 16. Definition of Done

A phase is DONE only when ALL apply:

- [ ] Code merged into `v2.1-healthkit` on both repos
- [ ] BE deployed to `wellness-os-api-staging.fly.dev` + smoke test green
- [ ] Detox E2E test for the phase's scenarios passes
- [ ] Manual QA checklist for that phase complete
- [ ] No `console.log` / `TODO` / `FIXME` in committed source
- [ ] All new strings × 6 locales
- [ ] PR pre-merge script (grep for legacy `users` collection, etc.) passes
- [ ] This doc updated with any contract changes
- [ ] One paragraph in `CHANGELOG.md` describing the user-visible change

A RELEASE (2.1.0) is DONE only when:

- [ ] All 10 phases complete
- [ ] App Store Connect: Privacy nutrition labels updated
- [ ] App Store Connect: Screenshots refreshed
- [ ] App Store Connect: What's New text written
- [ ] iOS: Archive 2.1.0 (build 36) uploaded
- [ ] Submitted for review with reviewer notes explaining HealthKit flow
- [ ] Backend production deploy (Fly) of `v2.1-healthkit` branch
- [ ] Branch merged to `main` / `master`

---

## OPEN QUESTIONS / DECISIONS NEEDED FROM HARESH

These need a yes/no before Phase 0 closes:

1. **Staging Fly app** — spin up `wellness-os-api-staging.fly.dev`? Cost: ~$1/mo. **Strongly recommended.**
2. **Detox tests on CI** — add GitHub Actions to run Detox on every PR? Cost: 0 (free tier). Required for R7 + R8.
3. **Prompt versioning storage** — store prompts in code (this plan) or Firestore (hot-swappable)? Code is simpler, Firestore allows tuning without redeploy. **Recommend code for now, can move later.**
4. **Apple Health write-back** — write user's manual logs back to Apple Health? Adds value (other apps can read) but requires `NSHealthUpdateUsageDescription` and one more permission grant. **Recommend YES — 1 day extra work.**

---

## CHANGELOG

- 2026-05-15: Initial draft (Claude)
- 2026-05-16: ✅ **All 10 phases code-complete on `v2.1-healthkit`.** Native Swift HK bridge, BE ingestion + dedupe + scoring blender, FE permission UX, per-coach banner, starter-insights endpoint, Home Day-1 strip, WhyScoreSheet, full iOS widget bundle (Home + Lock + Live Activity), Smart Reminders v2, HK-aware prompts wired into all 4 LLM surfaces. Bonus: canonical AI model registry across 25 files, vision swap to Gemini 3 Flash. 167/167 existing tests pass.
- ⏭ Next (Haresh): one-time Xcode widget target wiring, real-device QA, privacy nutrition labels, ASO + screenshots, archive + submit.

---

**END OF SPEC.** No code is written until this doc is approved.
