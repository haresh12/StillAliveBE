# Goal-Plans API (v2 contract)

**Mount point:** `/api/goal-plans` (`server.js:133`)
**Scope:** Plans tab — the daily life-coaching surface.
**Status:** v2 contract locked 2026-05-27 in [`PLANS_TAB_V2_REWRITE_200H_PLAN.md`](../../PLANS_TAB_V2_REWRITE_200H_PLAN.md).

This document is the **single source of truth** the FE codes against during the BE/FE parallel window. Any change here must be reflected in [`StillAlive/src/lib/api/goalPlans.js`](../../StillAlive/src/lib/api/goalPlans.js) in the same commit.

---

## Routes

7 routes total. Routes from v1 NOT carried into v2 are listed under "Removed in v2" at the bottom.

### `GET /list`

Returns all plans for `device_id`, with today's items pre-attached per plan so the library paints in one round trip.

**Query:**
- `device_id` (string, required)

**Response 200:**
```jsonc
{
  "ok": true,
  "plans": [
    {
      "id": "plan_2026-05-27_a1b2c3",
      "title": "Drop 5kg by July",
      "area": "weight",
      "status": "active",
      "duration_days": 30,
      "current_day_index": 4,
      "today_ratio": "1/4",
      "today_items": [ /* PlanItem[], max 5 */ ],
      "today_overflow": 0
    }
  ]
}
```

---

### `POST /draft`

Voice/text goal → returns AI-suggested **questions** spanning 1–3 classified coaches. Single round-trip; both `routeGoal` (cheap classifier) and `composeQuestions` (cheap reasoning) run server-side.

**Body:**
```json
{
  "device_id": "...",
  "goal_text": "lose 5kg by mid-July",
  "duration_days": 30,
  "locale": "en"
}
```

**Response 200:**
```jsonc
{
  "ok": true,
  "draft_id": "draft_2026-05-27_xyz",
  "coaches_involved": ["fitness", "nutrition"],
  "questions": [
    { "id": "q1", "q": "What does a typical lunch look like for you?", "kind": "text",        "coach": "nutrition" },
    { "id": "q2", "q": "How many days a week can you train?",          "kind": "chip_single", "coach": "fitness",
      "choices": ["1-2", "3-4", "5+"] }
  ]
}
```

**Errors:** `400 INVALID_GOAL`, `400 UNSUPPORTED_DURATION`, `503 LLM_UNAVAILABLE`.

---

### `POST /draft/finalize`

Submits answers → **streams** AI-proposed name + the full N-day plan back as NDJSON over `Transfer-Encoding: chunked`. The FE parses each chunk and updates `plansStore` so Day 1 paints in ~4s while the rest of the path streams in over 8–12s.

**Body:**
```json
{
  "device_id": "...",
  "draft_id": "draft_...",
  "answers": [
    { "id": "q1", "value": "salad + sandwich" },
    { "id": "q2", "value": "3-4" }
  ]
}
```

**Response 200 (NDJSON, one JSON object per `\n`):**
```
{"type":"name","title":"Drop 5kg by July"}
{"type":"days","batch_index":0,"days":[{...day_1...},{...day_2...}, ... 7 days ...]}
{"type":"days","batch_index":1,"days":[ ... 7 more ... ]}
...
{"type":"done","plan_id":"plan_2026-05-27_a1b2c3"}
```

If any batch fails after retry on Gemini, the stream emits a final error frame and returns HTTP status 200 (frames already sent):

```
{"type":"error","error_code":"LLM_UNAVAILABLE","stage":"batch_2"}
```

The plan is **not persisted** if any batch fails. FE shows the retry CTA on `PlanGenerationOrb`.

---

### `GET /plan/:id`

Fetch one plan with completion state merged in for every day.

**Query:**
- `device_id` (string, required)

**Response 200:**
```jsonc
{
  "ok": true,
  "plan": {
    "id": "...", "title": "...", "duration_days": 30,
    "start_date": "2026-05-27", "end_date": "2026-06-25",
    "status": "active", "locale": "en",
    "coaches_involved": ["fitness", "nutrition"],
    "research_anchor": "Hall 2011 Lancet",
    "days": [
      {
        "day_index": 1,
        "date_key": "2026-05-27",
        "summary": "Foundation",
        "items": [
          { "id": "itm_1_a4b", "coach": "fitness", "title": "20-min brisk walk", "sub": "...", "kind": "habit", "time_anchor_local": "07:30" }
        ],
        "completed_item_ids": ["itm_1_a4b"]
      }
    ]
  }
}
```

**Errors:** `404 PLAN_NOT_FOUND`.

---

### `POST /complete-item`

Toggle one item's checkbox for a given date. Idempotent.

**Body:**
```json
{
  "device_id": "...",
  "plan_id": "plan_...",
  "date_key": "2026-05-27",
  "item_id": "itm_1_a4b",
  "completed": true
}
```

**Response 200:**
```jsonc
{
  "ok": true,
  "date_key": "2026-05-27",
  "completed_item_ids": ["itm_1_a4b", "itm_1_xyz"]
}
```

**Constraints:**
- `date_key` must be ≤ today (cannot complete future items).
- Past-day toggling is allowed (corrections).

**Errors:** `400 INVALID_DATE`, `404 PLAN_NOT_FOUND`.

---

### `POST /rename`

User edits the plan title.

**Body:** `{ "device_id": "...", "plan_id": "...", "title": "..." }`
**Response 200:** `{ "ok": true, "title": "..." }`
**Errors:** `400 INVALID_TITLE` (length 3–60), `404 PLAN_NOT_FOUND`.

---

### `POST /archive`

Soft-delete (status=archived). Plan stays in `/list` under archived but hidden from active library.

**Body:** `{ "device_id": "...", "plan_id": "..." }`
**Response 200:** `{ "ok": true }`
**Errors:** `404 PLAN_NOT_FOUND`.

---

## Error contract

| HTTP | error_code           | When                                              |
|------|----------------------|---------------------------------------------------|
| 400  | `INVALID_GOAL`       | `goal_text` empty or <3 chars                     |
| 400  | `UNSUPPORTED_DURATION` | duration not in `{7, 30, 90}`                   |
| 400  | `INVALID_TITLE`      | rename title <3 or >60 chars                      |
| 400  | `INVALID_DATE`       | date_key in future                                |
| 404  | `PLAN_NOT_FOUND`     | plan doc missing                                  |
| 422  | `PLAN_SCHEMA_DRIFT`  | AI returned shape that fails validator twice      |
| 429  | `RATE_LIMIT`         | OpenAI 429 escalated                              |
| 503  | `LLM_UNAVAILABLE`    | both OpenAI and Gemini failed                     |

---

## Firestore shape

- `wellness_users/{deviceId}/goal_plans/{planId}` — the plan doc, immutable after generation.
- `wellness_users/{deviceId}/goal_plan_logs/{planId}__{dateKey}` — completion log, mutable. Double-underscore separator (planId can contain underscores; slashes never).
- `wellness_users/{deviceId}/goal_plan_drafts/{draftId}` — short-lived draft created by `/draft`, consumed by `/draft/finalize`. TTL 24h (cleaned by future cron, not v2 scope).

No Firestore composite indexes (per [`feedback_no_firestore_indexes`](../../../.claude/projects/-Users-hareshlakhwani-Desktop-SAB/memory/feedback_no_firestore_indexes.md)). All multi-key queries fetched within a user-scoped collection (≤ `LIMITS.MAX_ACTIVE_PLANS_PER_USER`) and filtered/sorted in memory.

---

## Removed in v2 (DO NOT bring back)

These v1 routes are gone. Calls to them must 404. Listed here so FE refactors know what's missing on purpose:

- `GET /today`                — superseded by `/list` pre-attaching `today_items[]`
- `POST /generate`            — curated path; folded into `/draft/finalize`
- `POST /regenerate-item`     — not needed if generation is reliable
- `POST /insight`             — anti-chatbot canon (no per-plan Q&A)
- `POST /recover-missed-day`  — not in mental model
- `POST /pause`               — moved into UI as a status transition via `/archive` (true pause/resume deferred to v3)
- `POST /suggest-followup`    — cosmetic; defer to v3

---

## Streaming consumer (FE side)

The single tricky bit. React Native's built-in `fetch` doesn't support response-body streaming on iOS. The FE consumes `/draft/finalize` via [`react-native-sse`](https://github.com/binaryminds/react-native-sse) (~5KB, mature). The BE response uses `text/event-stream` MIME type in practice (despite the NDJSON-style frames) so the SSE client handles framing automatically. Each `event.data` is parsed as a single NDJSON object and dispatched into `plansStore`.

Fallback if SSE misbehaves: long-poll with `XMLHttpRequest.onprogress` and parse partial responses.

---

**Last updated:** 2026-05-27 (P0 contract lock).
