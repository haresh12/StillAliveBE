'use strict';
// ════════════════════════════════════════════════════════════════════════
// goal-plans.agent.js — Plans tab BE (v2).
//
// 7 routes, all under /api/goal-plans:
//   GET  /list            → list w/ today_items[] pre-attached per plan
//   POST /draft           → goal_text → routed coaches + questions
//   POST /draft/finalize  → answers → streaming plan+name (SSE-style)
//   GET  /plan/:id        → plan w/ completion state merged
//   POST /complete-item   → toggle item done (idempotent)
//   POST /rename          → edit title
//   POST /archive         → soft-delete (status=archived)
//
// Wires runWithFallback() + generateDayStream() into HTTP. The agent file
// itself contains NO LLM prompts and NO fallback logic — that lives in
// lib/goal-plans/ai.js, prompts.js, dayBatcher.js. This file is plumbing.
//
// Schema version: every plan persisted by v2 has schema_version: 2. Any
// pre-existing v1 plan docs are filtered out at /list time (silent skip).
// ════════════════════════════════════════════════════════════════════════

const express = require('express');
const router  = express.Router();
const admin   = require('firebase-admin');
const crypto  = require('crypto');
const log     = require('./lib/log');

const { AI }            = require('./lib/ai/models');
const { runWithFallback, LLMUnavailableError } = require('./lib/goal-plans/ai');
const { generateDayStream } = require('./lib/goal-plans/dayBatcher');
const { loadUserContext } = require('./lib/goal-plans/userContext');
const { validatePlan: semanticValidatePlan } = require('./lib/goal-plans/semanticValidator');
const { applyFreeTierClamp } = require('./lib/goal-plans/freeTierClamp');
const { shapeDayForStorage, normalizeTimeSection } = require('./lib/goal-plans/dayShape');
const {
  ROUTE_GOAL,
  COMPOSE_QUESTIONS,
  PROPOSE_NAME,
} = require('./lib/goal-plans/schemas');
const {
  buildRouteGoalPrompt,
  buildComposeQuestionsPrompt,
  buildProposeNamePrompt,
} = require('./lib/goal-plans/prompts');
const {
  PATHS, ERROR_CODES, DURATIONS, LIMITS,
  MIN_DURATION_DAYS, MAX_DURATION_DAYS, isValidDuration,
} = require('./lib/goal-plans/constants');
const { buildRemindersForPlan } = require('./lib/goal-plans/reminders');

const SCHEMA_VERSION = 3;

// ─── Helpers ────────────────────────────────────────────────────────────
function db()              { return admin.firestore(); }
function nowMs()           { return Date.now(); }
function ok(res, body)     { return res.json({ ok: true, ...body }); }
function fail(res, status, code, msg) {
  return res.status(status).json({ ok: false, error_code: code, error_message: msg || code });
}
function localDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function addDaysKey(dateKey, addDays) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + addDays);
  return localDateKey(dt);
}
function genId(prefix, dateKey) {
  return `${prefix}_${dateKey}_${crypto.randomBytes(3).toString('hex')}`;
}
function getDeviceId(req) {
  return String(req.query?.device_id || req.body?.device_id || '').trim();
}

// Telemetry hook (BE-side Mixpanel is optional — falls through silently).
const telemetry = {
  track: (eventName, props) => {
    try { log.info(`[goal-plans/mp] ${eventName}`, props); } catch {}
  },
};

// Compute the day_index of today within a plan's date range. Returns
// null if today is before start_date or after end_date.
function currentDayIndex(plan, todayKey) {
  if (!plan?.start_date || !plan?.end_date) return null;
  if (todayKey < plan.start_date) return null;
  if (todayKey > plan.end_date) return null;
  // Walk days[] for the matching date_key (cheap — ≤90 entries)
  const found = (plan.days || []).find(d => d.date_key === todayKey);
  return found ? found.day_index : null;
}

// ─── GET /list ──────────────────────────────────────────────────────────
router.get('/list', async (req, res) => {
  const deviceId = getDeviceId(req);
  if (!deviceId) return fail(res, 400, ERROR_CODES.MISSING_DEVICE_ID);

  try {
    const snap = await db().collection(PATHS.plansCol(deviceId))
      .limit(50)
      .get();

    const allDocs = snap.docs.map(d => d.data());
    // Silent v1 filter: only return v2 plans. v1 docs are orphaned by design.
    const v2Plans = allDocs.filter(p => p && p.schema_version === SCHEMA_VERSION);

    const todayKey = localDateKey();

    // Build the response — for each plan, attach today's items + ratio.
    // Loads log docs in parallel.
    const plans = await Promise.all(v2Plans.map(async (plan) => {
      const dayIndex = currentDayIndex(plan, todayKey);
      const day = (plan.days || []).find(d => d.day_index === dayIndex) || null;
      const allItems = day?.items || [];

      let completedIds = [];
      if (day) {
        try {
          const logSnap = await db().doc(PATHS.logDoc(deviceId, plan.id, day.date_key)).get();
          if (logSnap.exists) completedIds = logSnap.data()?.completed_item_ids || [];
        } catch (e) {
          log.warn(`[goal-plans/list] log read fail for ${plan.id}:`, e?.message);
        }
      }

      const todayItems = allItems
        .slice(0, LIMITS.MAX_TODAY_ITEMS_ON_CARD)
        .map(it => ({ ...it, completed: completedIds.includes(it.id) }));
      const todayOverflow = Math.max(0, allItems.length - LIMITS.MAX_TODAY_ITEMS_ON_CARD);
      const completedCount = allItems.filter(it => completedIds.includes(it.id)).length;

      return {
        id: plan.id,
        title: plan.title,
        area: areaForCoaches(plan.coaches_involved),
        status: plan.status,
        duration_days: plan.duration_days,
        current_day_index: dayIndex,
        today_ratio: day ? `${completedCount}/${allItems.length}` : null,
        today_items: todayItems,
        today_overflow: todayOverflow,
        // FULL set of completed item IDs for today. today_items is sliced to
        // the first 5 for card display, so the FE can't reconstruct the
        // overflow items' completion state from today_items.completed alone.
        // The FE uses this list to reconcile its optimistic store with BE
        // truth on every tab focus — without it, an overflow item's checkmark
        // disappears every time the user navigates back to the library.
        today_date_key: day?.date_key || null,
        completed_item_ids: completedIds,
      };
    }));

    // Sort: active first, then archived, both by created date desc.
    plans.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
      return 0;
    });

    return ok(res, { plans });
  } catch (e) {
    log.error('[goal-plans/list] fail:', e?.message);
    return fail(res, 500, ERROR_CODES.INTERNAL, e?.message);
  }
});

// Heuristic: derive a single AREA from the coaches involved. Matches
// the per-area gradient palette §16.4. Order = priority.
function areaForCoaches(coaches) {
  const list = Array.isArray(coaches) ? coaches : [];
  if (list.includes('fasting'))   return 'fasting';
  if (list.includes('sleep'))     return 'sleep';
  if (list.includes('mind'))      return 'calm';
  if (list.includes('nutrition')) return 'weight';
  if (list.includes('fitness'))   return 'energy';
  return 'habits';
}

// ─── POST /draft ────────────────────────────────────────────────────────
router.post('/draft', async (req, res) => {
  const deviceId = getDeviceId(req);
  if (!deviceId) return fail(res, 400, ERROR_CODES.MISSING_DEVICE_ID);

  // goal_text is the v2 key; transcript was v1. Accept either while
  // legacy FE bundles are still in flight; remove `|| req.body?.transcript`
  // once the new bundle is verified live on every dev device.
  const goalText = String(req.body?.goal_text || req.body?.transcript || '').trim();
  // Free-form duration: accept any integer in [MIN, MAX]. The clamp below
  // enforces per-tier ceilings (free → 14, premium → 60). If the FE doesn't
  // send a value, leave it undefined so the clamp's tier-appropriate default
  // wins (14 for free, 30 for premium).
  const rawDurReq = Number(req.body?.duration_days);
  const requestedDays = isValidDuration(rawDurReq) ? rawDurReq : null;
  const locale = String(req.body?.locale || 'en').toLowerCase().slice(0, 2);

  if (goalText.length < 3) return fail(res, 400, ERROR_CODES.INVALID_GOAL, 'goal_text too short');

  try {
    // Load user context up-front. Sandbox-safe (top-level user doc + cold-start anchor).
    // Used in step 2 to skip redundant questions and tailor phrasing.
    const userContext = await loadUserContext(deviceId, locale);

    // Free-tier policy: free users cap at 30 days even if their goal_text
    // asks for "60 days" / "12 weeks". Premium can go up to 90.
    // The user-doc isPremium lives at subscription.isPremium (server.js:2022).
    let isPremium = false;
    try {
      const userSnap = await db().doc(PATHS.userDoc(deviceId)).get();
      isPremium = Boolean(userSnap?.data()?.subscription?.isPremium);
    } catch (e) {
      log.warn('[goal-plans/draft] isPremium read fail (defaulting to free):', e?.message);
    }

    // Free users get a max of 3 plans total (any status). Premium is bounded
    // by LIMITS.MAX_ACTIVE_PLANS_PER_USER (10). Count BEFORE we burn an LLM
    // call — surface TOO_MANY_PLANS so the FE can offer a rewarded-ad unlock.
    //
    // Android free users can earn EXTRA slots beyond the cap by watching a
    // rewarded ad (one slot per ad). The slot counter lives on the user doc
    // at `androidBonusPlanSlots` and is consumed on every successful plan create.
    const FREE_PLAN_CAP = 3;
    let bonusSlotsAvailable = 0;
    try {
      const userSnap = await db().doc(PATHS.userDoc(deviceId)).get();
      bonusSlotsAvailable = Number(userSnap?.data()?.androidBonusPlanSlots || 0);
    } catch {/* default 0 — no bonus */}

    let plansToConsumeSlot = false;
    try {
      const existing = await db()
        .collection(PATHS.plansCol(deviceId))
        .limit(LIMITS.MAX_ACTIVE_PLANS_PER_USER + 1)
        .get();
      const planCount = existing.docs
        .map(d => d.data())
        .filter(p => p && p.schema_version === SCHEMA_VERSION)
        .length;
      const baseCap = isPremium ? LIMITS.MAX_ACTIVE_PLANS_PER_USER : FREE_PLAN_CAP;
      const effectiveCap = baseCap + bonusSlotsAvailable;

      if (planCount >= effectiveCap) {
        return fail(res, 409, ERROR_CODES.TOO_MANY_PLANS, isPremium
          ? `cap_${LIMITS.MAX_ACTIVE_PLANS_PER_USER}`
          : `free_cap_${FREE_PLAN_CAP}`);
      }

      // If user is over the base cap but within effective (= using a bonus
      // slot), consume one slot NOW (early). The slot is "1 LLM-call attempt
      // at creating a plan" — if user bails on finalize, slot is still spent.
      // Fair: they watched the ad, they got the LLM call.
      if (planCount >= baseCap) {
        await db().doc(PATHS.userDoc(deviceId)).set({
          androidBonusPlanSlots: Math.max(0, bonusSlotsAvailable - 1),
        }, { merge: true });
        log.info(`[goal-plans/draft] consumed 1 bonus plan slot for ${deviceId} (remaining: ${bonusSlotsAvailable - 1})`);
      }
    } catch (e) {
      log.warn('[goal-plans/draft] plan count check fail (allowing draft):', e?.message);
    }

    const clamp = applyFreeTierClamp({ requestedDays, goalText, isPremium });
    const durationDays = clamp.durationDays;

    // Step 1: route the goal into coaches — REASONING_PRO for accuracy
    const routePrompts = buildRouteGoalPrompt({ goalText, locale });
    const routed = await runWithFallback({
      stepName: 'routeGoal',
      schema: ROUTE_GOAL,
      systemPrompt: routePrompts.systemPrompt,
      userPrompt:   routePrompts.userPrompt,
      // Structured classification — gpt-4.1 (non-reasoning) lands in <2s.
      // gpt-5.4 was burning 10-20s on hidden reasoning.
      openai: { model: AI.STRUCTURED_HEAVY, timeoutMs: 15_000 },
      gemini: { model: AI.VISION_PRIMARY,   timeoutMs: 15_000 },
      telemetry,
      language: locale,
    });

    // Step 2: compose questions — REASONING_PRO for sharper, deeper Qs
    const qPrompts = buildComposeQuestionsPrompt({
      goalText,
      coachesInvolved: routed.coaches,
      locale,
      durationDays,
      userContext,
    });
    const composed = await runWithFallback({
      stepName: 'composeQuestions',
      schema: COMPOSE_QUESTIONS,
      systemPrompt: qPrompts.systemPrompt,
      userPrompt:   qPrompts.userPrompt,
      // 2026-05-28: upgraded from STRUCTURED_HEAVY (gpt-4.1) → REASONING_PRO
      // (gpt-5.4). User feedback: previous questions were generic across goals
      // ("any injuries?" on every plan). The new prompt has anti-generic rules
      // + goal-specific exemplars; reasoning-class models follow that structure
      // much better. Trade-off: +5-15s latency for materially sharper Qs. The
      // L2 fallback stays on STRUCTURED_HEAVY so a slow gpt-5.4 still ships.
      openai: { model: AI.REASONING_PRO,    timeoutMs: 45_000 },
      gemini: { model: AI.VISION_PRIMARY,   timeoutMs: 30_000 },
      telemetry,
      language: locale,
    });

    // Persist draft (TTL via future cron — not v2 scope)
    const draftId = genId('draft', localDateKey());
    const draftDoc = {
      id: draftId,
      device_id: deviceId,
      goal_text: goalText,
      duration_days: durationDays,
      coaches_involved: routed.coaches,
      questions: composed.questions,
      locale,
      // Snapshot so /draft/finalize can pass the same context into framework
      // + day-batch prompts without a re-read. Stale-by-ms-of-draft is fine —
      // a finalize call lands seconds-to-minutes later.
      user_context: userContext,
      // Free-tier clamp metadata. If wasClamped is true, the FE will show
      // an upgrade nudge on the ready screen.
      was_clamped: clamp.wasClamped,
      requested_duration_days: clamp.requestedDurationDays,
      is_premium: isPremium,
      created_at_ms: nowMs(),
    };
    await db().doc(PATHS.draftDoc(deviceId, draftId)).set(draftDoc);

    return ok(res, {
      draft_id: draftId,
      coaches_involved: routed.coaches,
      questions: composed.questions,
      // Surface the clamp so the FE can show "we made this 30 days because
      // you're on the free tier — upgrade for 60/90." UX nudge, never a block.
      duration_days: durationDays,
      was_clamped: clamp.wasClamped,
      requested_duration_days: clamp.requestedDurationDays,
    });
  } catch (e) {
    if (e instanceof LLMUnavailableError) {
      log.error('[goal-plans/draft] LLM unavailable:', e.message);
      return fail(res, 503, ERROR_CODES.LLM_UNAVAILABLE);
    }
    log.error('[goal-plans/draft] fail:', e?.message);
    return fail(res, 500, ERROR_CODES.INTERNAL, e?.message);
  }
});

// ─── POST /draft/finalize ───────────────────────────────────────────────
// Buffered (NOT streaming) JSON response. 12–15s p95 wall time for a
// 30-day plan; the FE shows PlanGenerationOrb with cycling messages.
// No SSE — keeps client code simple and aligns with the rest of the app.
router.post('/draft/finalize', async (req, res) => {
  const deviceId = getDeviceId(req);
  if (!deviceId) return fail(res, 400, ERROR_CODES.MISSING_DEVICE_ID);

  const draftId = String(req.body?.draft_id || '').trim();
  const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
  if (!draftId) return fail(res, 400, ERROR_CODES.DRAFT_NOT_FOUND);

  // Load the draft
  let draft;
  try {
    const snap = await db().doc(PATHS.draftDoc(deviceId, draftId)).get();
    if (!snap.exists) return fail(res, 404, ERROR_CODES.DRAFT_NOT_FOUND);
    draft = snap.data();
  } catch (e) {
    log.error('[goal-plans/finalize] draft read fail:', e?.message);
    return fail(res, 500, ERROR_CODES.INTERNAL, e?.message);
  }

  const startDateKey = localDateKey();

  try {
    // Step 1: framework FIRST (sequentially) so day-batch prompts see anchors + phases.
    // It's a single ~2-3s call; we accept the small latency cost in exchange
    // for batches that don't repeat anchors and that respect phase progression.
    const namePrompts = buildProposeNamePrompt({
      goalText: draft.goal_text,
      coachesInvolved: draft.coaches_involved,
      durationDays: draft.duration_days,
      locale: draft.locale,
      answers,
      // Read snapshot persisted at /draft (skip re-read; stale-by-seconds is fine).
      userContext: draft.user_context,
    });
    let frameworkResult;
    try {
      frameworkResult = await runWithFallback({
        stepName: 'proposePlanFramework',
        schema: PROPOSE_NAME,
        systemPrompt: namePrompts.systemPrompt,
        userPrompt:   namePrompts.userPrompt,
        // Framework output (title + why + 4-5 anchors + rhythm + 3-4 phases).
        // No token cap — schema bounds the output; timeout catches hangs.
        openai: {
          model: AI.STRUCTURED_HEAVY,
          timeoutMs: 45_000,
        },
        gemini: {
          model: AI.VISION_PRIMARY,
          timeoutMs: 45_000,
        },
        telemetry,
        language: draft.locale,
      });
    } catch (e) {
      log.warn('[goal-plans/finalize] framework fail, fallback to minimal:', e?.message);
      frameworkResult = { title: deriveFallbackTitle(draft.goal_text) };
    }

    const title           = frameworkResult?.title;
    const researchAnchor  = (frameworkResult?.research_anchor || '').trim();
    const headlineMetric  = frameworkResult?.headline_metric || null;
    // Anchors: normalize time_section + stamp ID for stable per-day inlining.
    const dailyAnchors    = (Array.isArray(frameworkResult?.daily_anchors) ? frameworkResult.daily_anchors : [])
      .map((a, i) => ({
        ...a,
        id: `anchor_${i}_${crypto.randomBytes(2).toString('hex')}`,
        time_section: normalizeTimeSection(a),
      }));

    // Step 2: day batches receive the anchors so they avoid duplicating them.
    const anchorsSummary = dailyAnchors.length
      ? dailyAnchors.map(a => `  • [${a.coach || '—'}] ${a.title}`).join('\n')
      : '';
    const generateOpts = {
      duration_days: draft.duration_days,
      start_date: startDateKey,
      goal_text: draft.goal_text,
      coaches_involved: draft.coaches_involved,
      answers,
      locale: draft.locale,
      telemetry,
      daily_anchors_summary: anchorsSummary,
      user_context: draft.user_context,
    };

    const allDays = [];
    for await (const frame of generateDayStream(generateOpts)) {
      if (frame.type === 'batch') allDays.push(...frame.days);
    }

    // Semantic validation pass (non-blocking probe). Logs warnings to
    // telemetry so we can spot quality drift (high repetition, dietary
    // violations, motivational filler) without rejecting plans.
    try {
      const sem = semanticValidatePlan(
        { days: allDays, duration_days: draft.duration_days },
        { answers }
      );
      if (sem.warnings && sem.warnings.length) {
        log.warn('[goal-plans/finalize] semantic warnings:', sem.warnings.join(' | '));
        if (telemetry && typeof telemetry.event === 'function') {
          telemetry.event('goal_plan_semantic_warnings', {
            count: sem.warnings.length,
            warnings: sem.warnings,
            duration_days: draft.duration_days,
          });
        }
      }
    } catch (e) {
      log.warn('[goal-plans/finalize] semantic validator threw:', e?.message);
    }

    // v3 day shaping:
    //   1. Inline anchors into each day's items (tagged from_anchor)
    //   2. Stamp theme (Foundation / Build / Peak) by day_index ratio
    //   3. Stamp deterministic item IDs (BE responsibility) so /complete-item
    //      lookups remain stable. Spread first so a stray `id` from the LLM
    //      cannot overwrite our deterministic ID.
    const stampedDays = allDays.map((day) => {
      const shaped = shapeDayForStorage({
        llmDay: day,
        anchors: dailyAnchors,
        durationDays: draft.duration_days,
      });
      return {
        ...shaped,
        items: shaped.items.map((it, i) => ({
          ...it,
          id: it.from_anchor
            ? it.id              // already deterministic (a_<idx>_d<day>)
            : `itm_${day.day_index}_${crypto.randomBytes(2).toString('hex')}_${i}`,
        })),
      };
    });

    const planId  = genId('plan', startDateKey);
    const endDate = addDaysKey(startDateKey, draft.duration_days - 1);
    const planForReminders = { days: stampedDays };
    const reminders = buildRemindersForPlan(planForReminders, answers);

    // dailyAnchors already carry IDs + normalized time_section from the framework step.
    const stampedAnchors = dailyAnchors;

    // Build the Q&A trail — what we asked + what the user answered.
    // This becomes the "what did I tell the AI?" record on the plan.
    const draftQuestions = Array.isArray(draft.questions) ? draft.questions : [];
    const answersById = {};
    (Array.isArray(answers) ? answers : []).forEach(a => {
      if (a && a.id != null) answersById[a.id] = a.value;
    });
    const questionsAnswered = draftQuestions.map(q => {
      const row = {
        id:    q.id,
        q:     q.q,
        kind:  q.kind,
        coach: q.coach,
        value: answersById[q.id] !== undefined ? answersById[q.id] : '',
      };
      // Only include `choices` when present — Firestore rejects `undefined`.
      if (Array.isArray(q.choices) && q.choices.length > 0) row.choices = q.choices;
      return row;
    });

    const plan = {
      id:               planId,
      device_id:        deviceId,
      schema_version:   SCHEMA_VERSION,
      title,
      goal_text:        draft.goal_text,
      coaches_involved: draft.coaches_involved,
      duration_days:    draft.duration_days,
      start_date:       startDateKey,
      end_date:         endDate,
      status:           'active',
      locale:           draft.locale,
      generated_by:     'openai+gemini',
      generated_at_ms:  nowMs(),
      research_anchor:  researchAnchor || null,
      // Headline metric drives the big number in the day-screen header.
      // Goal-extracted by the framework step — never static.
      headline_metric:    headlineMetric,
      // Anchors persist on the plan (for FE reference / regen) — they are
      // ALSO inlined into each day's items by shapeDayForStorage above.
      daily_anchors:      stampedAnchors,
      // Q&A trail — every question we asked + the user's answer.
      questions_answered: questionsAnswered,
      reminders,
      days:             stampedDays,
      // Free-tier clamp markers travel with the plan (FE banner on first open).
      was_clamped:          Boolean(draft.was_clamped),
      requested_duration_days: draft.requested_duration_days || draft.duration_days,
    };

    await db().doc(PATHS.planDoc(deviceId, planId)).set(plan);
    db().doc(PATHS.draftDoc(deviceId, draftId)).delete().catch(() => {});

    return ok(res, { plan, proposed_title: title });
  } catch (e) {
    if (e instanceof LLMUnavailableError) {
      log.error('[goal-plans/finalize] LLM unavailable:', e.message);
      return fail(res, 503, ERROR_CODES.LLM_UNAVAILABLE);
    }
    log.error('[goal-plans/finalize] generation fail:', e?.message);
    return fail(res, 500, ERROR_CODES.INTERNAL, e?.message);
  }
});

function deriveFallbackTitle(goalText) {
  // Last-resort title when proposeName fails. Truncate user's own goal.
  const t = String(goalText || 'My plan').trim();
  return t.length <= 60 ? t : (t.slice(0, 57) + '…');
}

// ─── GET /plan/:id ──────────────────────────────────────────────────────
router.get('/plan/:id', async (req, res) => {
  const deviceId = getDeviceId(req);
  if (!deviceId) return fail(res, 400, ERROR_CODES.MISSING_DEVICE_ID);

  const planId = String(req.params.id || '').trim();
  if (!planId) return fail(res, 404, ERROR_CODES.PLAN_NOT_FOUND);

  try {
    const snap = await db().doc(PATHS.planDoc(deviceId, planId)).get();
    if (!snap.exists) return fail(res, 404, ERROR_CODES.PLAN_NOT_FOUND);
    const plan = snap.data();
    if (plan.schema_version !== SCHEMA_VERSION) return fail(res, 404, ERROR_CODES.PLAN_NOT_FOUND);

    // Read all logs for this plan in one shot. Limit follows plan duration
    // (one log per day, plus a small slack for early-completion edge cases),
    // not a flat 120 — keeps Firestore reads tight on 7-day plans and gives
    // 90-day plans enough headroom without ever scanning the wider collection.
    const logLimit = Math.max(14, (plan.duration_days || 30) + 5);
    const logsSnap = await db().collection(PATHS.logsCol(deviceId))
      .where('plan_id', '==', planId)
      .limit(logLimit)
      .get();
    // Note: requires no composite index since we filter by ONE key.
    const logsByDate = {};
    logsSnap.docs.forEach(d => {
      const data = d.data();
      if (data?.date_key) logsByDate[data.date_key] = data.completed_item_ids || [];
    });

    const days = (plan.days || []).map(d => ({
      ...d,
      completed_item_ids: logsByDate[d.date_key] || [],
    }));

    return ok(res, { plan: { ...plan, days } });
  } catch (e) {
    log.error('[goal-plans/plan] fail:', e?.message);
    return fail(res, 500, ERROR_CODES.INTERNAL, e?.message);
  }
});

// ─── POST /complete-item ────────────────────────────────────────────────
router.post('/complete-item', async (req, res) => {
  const deviceId = getDeviceId(req);
  if (!deviceId) return fail(res, 400, ERROR_CODES.MISSING_DEVICE_ID);

  const planId    = String(req.body?.plan_id || '').trim();
  const dateKey   = String(req.body?.date_key || '').trim();
  const itemId    = String(req.body?.item_id || '').trim();
  const completed = !!req.body?.completed;

  if (!planId || !itemId)              return fail(res, 400, ERROR_CODES.PLAN_NOT_FOUND);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return fail(res, 400, ERROR_CODES.INVALID_DATE);
  // BE runs in UTC; the user's wall clock may be ahead of UTC by up to ~14h.
  // Reject only days that are >1 day past BE's UTC today — that still blocks
  // "obvious future" submissions while letting any real timezone complete today.
  {
    const beToday = localDateKey();
    const [by, bm, bd] = beToday.split('-').map(Number);
    const beTomorrow = localDateKey(new Date(by, bm - 1, bd + 1));
    if (dateKey > beTomorrow) return fail(res, 400, ERROR_CODES.INVALID_DATE, 'cannot complete a future day');
  }

  try {
    const logRef = db().doc(PATHS.logDoc(deviceId, planId, dateKey));
    const snap   = await logRef.get();
    const prevIds = snap.exists ? (snap.data()?.completed_item_ids || []) : [];
    const set = new Set(prevIds);
    if (completed) set.add(itemId); else set.delete(itemId);
    const nextIds = Array.from(set);

    await logRef.set({
      plan_id: planId,
      date_key: dateKey,
      completed_item_ids: nextIds,
      updated_at_ms: nowMs(),
    }, { merge: true });

    return ok(res, { date_key: dateKey, completed_item_ids: nextIds });
  } catch (e) {
    log.error('[goal-plans/complete-item] fail:', e?.message);
    return fail(res, 500, ERROR_CODES.INTERNAL, e?.message);
  }
});

// ─── POST /rename ───────────────────────────────────────────────────────
router.post('/rename', async (req, res) => {
  const deviceId = getDeviceId(req);
  if (!deviceId) return fail(res, 400, ERROR_CODES.MISSING_DEVICE_ID);

  const planId = String(req.body?.plan_id || '').trim();
  const title  = String(req.body?.title || '').trim();

  if (!planId) return fail(res, 404, ERROR_CODES.PLAN_NOT_FOUND);
  if (title.length < 3 || title.length > 60) {
    return fail(res, 400, ERROR_CODES.INVALID_TITLE, 'title must be 3–60 chars');
  }

  try {
    const ref = db().doc(PATHS.planDoc(deviceId, planId));
    const snap = await ref.get();
    if (!snap.exists) return fail(res, 404, ERROR_CODES.PLAN_NOT_FOUND);
    await ref.update({ title });
    return ok(res, { title });
  } catch (e) {
    log.error('[goal-plans/rename] fail:', e?.message);
    return fail(res, 500, ERROR_CODES.INTERNAL, e?.message);
  }
});

// ─── POST /archive ──────────────────────────────────────────────────────
router.post('/archive', async (req, res) => {
  const deviceId = getDeviceId(req);
  if (!deviceId) return fail(res, 400, ERROR_CODES.MISSING_DEVICE_ID);

  const planId = String(req.body?.plan_id || '').trim();
  if (!planId) return fail(res, 404, ERROR_CODES.PLAN_NOT_FOUND);

  try {
    const ref = db().doc(PATHS.planDoc(deviceId, planId));
    const snap = await ref.get();
    if (!snap.exists) return fail(res, 404, ERROR_CODES.PLAN_NOT_FOUND);
    await ref.update({ status: 'archived', archived_at_ms: nowMs() });
    return ok(res, {});
  } catch (e) {
    log.error('[goal-plans/archive] fail:', e?.message);
    return fail(res, 500, ERROR_CODES.INTERNAL, e?.message);
  }
});

// ─── POST /delete ───────────────────────────────────────────────────────
// Hard delete: removes the plan doc AND every per-day log under
// goal_plan_logs/{planId}__*. Unlike /archive this is irreversible.
router.post('/delete', async (req, res) => {
  const deviceId = getDeviceId(req);
  if (!deviceId) return fail(res, 400, ERROR_CODES.MISSING_DEVICE_ID);

  const planId = String(req.body?.plan_id || '').trim();
  if (!planId) return fail(res, 404, ERROR_CODES.PLAN_NOT_FOUND);

  try {
    const planRef = db().doc(PATHS.planDoc(deviceId, planId));
    const planSnap = await planRef.get();
    if (!planSnap.exists) return fail(res, 404, ERROR_CODES.PLAN_NOT_FOUND);

    // 1) Drop the per-day log docs.
    //    Logs use single-key plan_id filter (no composite index needed).
    const logs = await db().collection(PATHS.logsCol(deviceId))
      .where('plan_id', '==', planId)
      .limit(200)
      .get();
    const batch = db().batch();
    logs.docs.forEach(d => batch.delete(d.ref));
    // 2) Drop the plan itself in the same batch.
    batch.delete(planRef);
    await batch.commit();

    return ok(res, { deleted_logs: logs.size });
  } catch (e) {
    log.error('[goal-plans/delete] fail:', e?.message);
    return fail(res, 500, ERROR_CODES.INTERNAL, e?.message);
  }
});

module.exports = router;
