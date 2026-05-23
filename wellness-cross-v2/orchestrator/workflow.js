/**
 * workflow.js
 * The full Plan-Execute-Validate workflow.
 *
 * Inputs: deviceId.
 * Outputs: { home_pack, insights_pack, telemetry }, persisted to Firestore.
 *
 * Steps:
 *   1. Read all 6 agent snapshots (adapters)
 *   2. Pre-aggregate → context_pack
 *   3. Compute wellness_score (deterministic)
 *   4. Compute correlations (deterministic, ~all 135 candidates)
 *   5. Detect anomalies (deterministic) + cross-attribution
 *   6. Plan (Gemini Flash or deterministic)
 *   7. Execute (Gemini Pro or deterministic fallback)
 *   8. Validate every numeric claim (deterministic + Haiku 4.5)
 *   9. Compute streaks (deterministic)
 *   10. Persist + telemetry
 */

const { getAllSnapshots } = require('../adapters');
const { buildContextPack } = require('../pre-aggregator/context-pack-builder');
const { assertContextPack } = require('../pre-aggregator/pack-schema');
const { computeWellness } = require('../score/wellness-score');
const { fallbackWhyLine } = require('../score/score-explainer');
const { computeCorrelations, selectTop } = require('../correlations/correlation-engine');
const { translate } = require('../correlations/plain-english-translator');
const { detectAnomalies } = require('../anomalies/anomaly-detector');
const { attributeCause } = require('../anomalies/cross-attribution');
const { computeStreaks } = require('../streaks/streak-engine');
const { plan } = require('./planner');
const { execute } = require('./executor');
const { validateClaims } = require('./validator');
const {
  userDoc, v2HomePack, v2InsightsPack, v2ContextPack,
  v2Correlations, v2Streaks, v2AnomaliesCol, v2ScoreHistoryCol,
  Timestamp,
} = require('../persistence/_firestore');
const { buildDailyMatrix } = require('../pre-aggregator/daily-matrix');
const { buildCapacityStrainForm } = require('../score/capacity-strain-form');
const { detectChronotype } = require('../coaches/chronotype-engine');
const { evaluateTriggers, newEvents } = require('../actions/aha-trigger');
const { readAhaIds, readAhaFeed, persistNewAha } = require('../persistence/aha.repo');
const { buildQuarterlyStory } = require('./quarterly-aggregator');
const { pickDidYouKnow } = require('../did-you-know/ranker');
const { buildDayOneKit } = require('../coaches/day-one-kit');
const { buildHKInsights } = require('../did-you-know/hk-insights');
const config = require('../config');

// Local-TZ date key helper — never _localDateStr(use) which
// returns UTC and silently maps near-midnight logs to the wrong day in
// negative-UTC offsets (Americas). See feedback_chart_tz_clamp law.
function _localDateStr(d) {
  const dt = d instanceof Date ? d : (d ? new Date(d) : new Date());
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * Inject HK-derived Did-You-Know facts into the home_pack silently.
 * Hard rule: HK facts always replace the LOWEST-priority library facts so the
 * total card count stays at TARGET_TOTAL (6). HK facts marked personal=true
 * so the FE styles them as user data, not library content. Source label is
 * never "Apple Health" or "watch" — see hk-insights.js for the silent copy.
 */
async function mergeHKDidYouKnow(home_pack, deviceId) {
  if (!home_pack || !deviceId) return;
  try {
    const hk = await buildHKInsights({ deviceId });
    if (!hk || !hk.length) return;
    const existing = Array.isArray(home_pack.did_you_know) ? home_pack.did_you_know : [];
    // HK facts go FIRST (most relevant to "your data right now"). We drop
    // library (personal=false) facts from the tail to make room. Personal
    // facts already in the list are preserved — we never bump real user
    // patterns for HK derivations.
    const personalExisting = existing.filter((f) => f && f.personal !== false);
    const libraryExisting = existing.filter((f) => f && f.personal === false);
    const hkMarked = hk.map((f) => ({ ...f, personal: true }));
    const TOTAL = 6;
    const merged = [...hkMarked, ...personalExisting, ...libraryExisting].slice(0, TOTAL);
    home_pack.did_you_know = merged;
  } catch { /* silent — DYK is best-effort enrichment */ }
}

const SCHEMA = config.HOME_SCHEMA_VERSION;

function todayDate() {
  return _localDateStr();
}

async function loadRecentDailyHistory(deviceId, days) {
  const snap = await v2ScoreHistoryCol(deviceId)
    .orderBy('date', 'desc')
    .limit(days)
    .get()
    .catch(() => null);
  if (!snap || snap.empty) return [];
  return snap.docs
    .map((d) => d.data().wellness_score)
    .filter((v) => Number.isFinite(v))
    .reverse();
}

async function loadPrevStreaks(deviceId) {
  const snap = await userDoc(deviceId).collection('cross_v2').doc('streaks').get().catch(() => null);
  if (!snap || !snap.exists) return null;
  return snap.data();
}

/**
 * runForUserFastDay0 — instant Day-0 path. Skips all cross-agent compute
 * (correlations, anomalies, chronotype, AHA, streaks, score history) since
 * none of those produce content with zero logs. Persists the empty pack in
 * the background so the next read hits cache. Sub-100ms typical.
 */
async function runForUserFastDay0(deviceId, { pack, snapshots, today, startedAt }) {
  const wellness = computeWellness({
    snapshots,
    baselines: pack.baselines,
    profile: {
      anchor: pack.profile.cold_start_anchor || 'none',
      onboarding_answers: {},
      setup_state: pack.profile.setup_state,
      total_days_logged: 0,
    },
    recentDailyHistory: [],
  });
  wellness.why_line = fallbackWhyLine(wellness);

  const emptyStreaks = {
    per_agent: ['sleep', 'mind', 'nutrition', 'fitness', 'water', 'fasting'].map((agent) => ({
      agent, current: 0, longest: 0, status: 'lapsed',
    })),
    cross_agent_grace_active: false,
    grace_reason: null,
    streak_freeze_available: true,
    streak_freeze_count: 1,
    next_freeze_grant_at: today,
  };

  const home_pack = buildHomeResponse({
    pack, snapshots, wellness, anomalies: [], exec: null, streaks: emptyStreaks,
    top_correlations: [],
  });

  // Silent HK enrichment for DYK — Day-0 users may have just granted HK in
  // onboarding and have backfilled history. Adding their trends here makes
  // their very first Home view feel personalized instead of generic.
  await mergeHKDidYouKnow(home_pack, deviceId);

  // Persist in background so subsequent reads hit cache instantly. Don't block
  // the response — the user's first paint is what matters.
  setImmediate(() => {
    Promise.allSettled([
      v2ContextPack(deviceId).set({ ...pack, _server_at: Timestamp.now() }, { merge: true }),
      v2HomePack(deviceId).set({ ...home_pack, _server_at: Timestamp.now(), _enrichment_pending: false, _day0: true, _lang: 'en' }, { merge: true }),
    ]).catch(() => {});
  });

  return {
    home_pack,
    insights_packs: [7, 30, 90, 365].map((range) => ({ range, pack: null })),
    streaks: emptyStreaks,
    enrichment_context: null, // skip enrich on Day-0 — nothing to enrich
    telemetry: {
      total_latency_ms: Date.now() - startedAt,
      path: 'fast_day0',
      llm_calls: {},
    },
  };
}

/**
 * runForUserFast — DETERMINISTIC ONLY (no LLM). Sub-1s typical.
 * Returns a complete home_pack with deterministic why_line, deterministic actions,
 * deterministic Did You Know. The caller can fire-and-forget runForUserEnrich()
 * to upgrade copy in the background.
 *
 * Used by the read path (home.routes.js) for cold misses to keep <2s perceived load.
 */
async function runForUserFast(deviceId, opts = {}) {
  const today = opts.todayDate || todayDate();
  const startedAt = Date.now();

  // 1. Snapshots + user doc IN PARALLEL.
  // Previously: snapshots THEN userDoc.get() — wasted ~50-100ms of round-trip.
  const [snapshots, userSnap] = await Promise.all([
    getAllSnapshots(deviceId, { todayDate: today }),
    userDoc(deviceId).get(),
  ]);

  // 2. Pack
  const userData = userSnap.exists
    ? userSnap.data()
    : { deviceId, name: 'there', cold_start_anchor: 'none', onboarding_answers: {} };
  const pack = buildContextPack({ snapshots, userData, todayDate: today });
  assertContextPack(pack);

  // ── Day-0 SHORT CIRCUIT ────────────────────────────────────────────
  // If the user has zero setups AND zero logs across all 6 agents, skip
  // correlations / anomalies / chronotype / AHA / week-pattern entirely —
  // they would all return empty anyway. This is the dominant cold-start
  // case (a fresh signup hitting Home for the first time) and saves
  // 200-500ms of compute + 3-4 wasted Firestore round trips for AHA/streaks.
  const totalLogs90d = Object.values(snapshots).reduce((s, sn) => {
    if (!sn || !Array.isArray(sn.last_90d)) return s;
    return s + sn.last_90d.filter((p) => p && p.has_log).length;
  }, 0);
  const setupCount = pack.profile.setup_count || 0;
  if (totalLogs90d === 0 && setupCount === 0) {
    return runForUserFastDay0(deviceId, { pack, snapshots, today, startedAt });
  }

  // 3. Score (deterministic)
  const recentDailyHistory = await loadRecentDailyHistory(deviceId, 14);
  const profile = {
    anchor: userData.cold_start_anchor || pack.profile.cold_start_anchor || 'none',
    onboarding_answers: userData.onboarding_answers || {},
    setup_state: pack.profile.setup_state,
    total_days_logged: pack.summary.total_days_logged,
  };
  const wellness = computeWellness({ snapshots, baselines: pack.baselines, profile, recentDailyHistory });

  // 4. Correlations (deterministic)
  const { matrix } = buildDailyMatrix(snapshots);

  // Lifetime composite — mean of per-agent lifetime means, weighted by the
  // base agent weights so the headline matches per-agent Analysis cards.
  //
  // Day-1 invariant (2026-05-22): score_lifetime must NEVER drop below
  // score_today. Previously this returned tiny numbers (e.g. 1) when the
  // matrix had partial coverage + the wrong key indexing (components is an
  // array but was accessed by agent name string → fell back to weight=1
  // for every agent, then divided by N including agents with no logs).
  // User-visible bug: setup gave 12, log dropped headline to 1.
  //
  // New formula:
  //   1. Build per-agent lifetime means (anchor → today, scored days only).
  //   2. Weighted average using BASE_WEIGHTS (sleep .25, fitness .20, ...)
  //      re-normalized over only the agents with data.
  //   3. clamp >= wellness.score (today). Logging can only LIFT the headline.
  wellness.score_lifetime = (() => {
    try {
      const BASE = require('../config').SCORE.BASE_WEIGHTS;
      const agents = Object.keys(snapshots);
      let weightedSum = 0, weightTotal = 0;
      for (const agent of agents) {
        const arr = matrix
          .map((r) => (r.scores && Number.isFinite(r.scores[agent]) ? r.scores[agent] : null))
          .filter((s) => Number.isFinite(s));
        if (!arr.length) continue;
        const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
        const w = Number.isFinite(BASE[agent]) ? BASE[agent] : 1;
        weightedSum += mean * w;
        weightTotal += w;
      }
      const lifetime = weightTotal > 0 ? Math.round(weightedSum / weightTotal) : null;
      // Floor: never below today's headline (logging must not lower lifetime).
      if (lifetime == null) return Number.isFinite(wellness.score) ? wellness.score : null;
      return Number.isFinite(wellness.score) ? Math.max(lifetime, wellness.score) : lifetime;
    } catch { return Number.isFinite(wellness.score) ? wellness.score : null; }
  })();

  const allCorrelations = computeCorrelations(matrix);
  for (const c of allCorrelations) c.plain_english = translate(c);
  const top_correlations = selectTop(allCorrelations);

  // 5. Anomalies (deterministic)
  const anomalies = detectAnomalies({ snapshots, baselines: pack.baselines });
  const enrichedAnomalies = anomalies.map((a) => ({
    ...a,
    ...attributeCause(a, snapshots, top_correlations),
  }));

  // 6. Streaks (deterministic)
  const prevStreaks = await loadPrevStreaks(deviceId);
  const streaks = computeStreaks({ snapshots, prevStreaks, todayDate: today });

  // 6b. Chronotype + Cross-agent matrix — needed for AHA triggers
  const chronotype_data = detectChronotype(snapshots.sleep && snapshots.sleep.recent_bedtimes);
  const matrix90 = buildDailyMatrix(snapshots, { source: 'last_90d' }).matrix;
  const week_pattern_data = computeWeekPattern(matrix90);

  // 6c. AHA triggers — fire deterministically, persist idempotent, return feed for pack
  const ahaCtx = {
    today,
    daysSinceSignup: pack.profile.days_active || 0,
    totalLogsToday: Object.values(snapshots).reduce((s, sn) => s + (sn && sn.today && sn.today.has_log ? 1 : 0), 0),
    topCorrelations: top_correlations,
    streaks,
    chronotype: chronotype_data,
    weekPattern: week_pattern_data,
  };
  const ahaCandidates = evaluateTriggers(ahaCtx);
  const firedIds = await readAhaIds(deviceId);
  const freshAha = newEvents(ahaCandidates, firedIds);
  if (freshAha.length) await persistNewAha(deviceId, freshAha);
  const aha_feed_data = await readAhaFeed(deviceId, 12);

  // 7. Why-line — deterministic fallback (LLM upgrades it later via runForUserEnrich)
  wellness.why_line = fallbackWhyLine(wellness);

  // 8. Build response — no exec content (LLM step skipped)
  const home_pack = buildHomeResponse({
    pack, snapshots, wellness, anomalies: enrichedAnomalies, exec: null, streaks,
    top_correlations,
  });

  // Silent HK enrichment for DYK — replaces lowest-priority library facts.
  // Best-effort; never blocks the response.
  await mergeHKDidYouKnow(home_pack, deviceId);
  const insights_packs = [7, 30, 90, 365].map((range) => ({
    range,
    pack: buildInsightsResponse({
      pack, snapshots, wellness, anomalies: enrichedAnomalies,
      top_correlations, allCorrelations, exec: null, range,
      chronotype: chronotype_data,
      aha_feed: aha_feed_data,
      week_pattern_precomputed: week_pattern_data,
    }),
  }));

  // Persist fast pack so subsequent reads hit cache instantly.
  // CRITICAL: do NOT await these. The user is waiting on the response;
  // Firestore writes can add hundreds of ms (sometimes seconds on cold instance)
  // and the data is already correct in the response we're about to send.
  // setImmediate ensures the writes start after the response is flushed.
  setImmediate(() => {
    const _lang = opts.language || 'en';
    const fastPersists = [
      v2ContextPack(deviceId).set({ ...pack, _server_at: Timestamp.now() }, { merge: true }),
      v2HomePack(deviceId).set({ ...home_pack, _server_at: Timestamp.now(), _enrichment_pending: true, _lang }, { merge: true }),
      ...insights_packs.map((ip) =>
        v2InsightsPack(deviceId, ip.range).set({ ...ip.pack, _server_at: Timestamp.now(), _lang }, { merge: true }),
      ),
      v2Correlations(deviceId).set({ computed_at: Timestamp.now(), results: allCorrelations }, { merge: true }),
      v2Streaks(deviceId).set({ ...streaks, _server_at: Timestamp.now() }, { merge: true }),
      v2ScoreHistoryCol(deviceId).doc(today).set({
        date: today,
        wellness_score: wellness.score,
        components: wellness.components,
        confidence: wellness.confidence,
        is_warm_start: wellness.is_warm_start,
        warm_start_blend: wellness.warm_start_blend,
        computed_at: Timestamp.now(),
      }, { merge: true }),
    ];
    Promise.allSettled(fastPersists).catch(() => {});
  });

  return {
    home_pack,
    insights_packs,
    streaks,
    enrichment_context: {
      pack, snapshots, wellness, enrichedAnomalies, top_correlations, allCorrelations, today,
      language: opts.language || 'en',
    },
    telemetry: {
      total_latency_ms: Date.now() - startedAt,
      path: 'fast',
      llm_calls: {},
    },
  };
}

/**
 * runForUserEnrich — LLM background pass. Patches the persisted home_pack with
 * planner-driven content (why_line, polished anomaly copy, today_action prose,
 * polished Did You Know personal insights).
 *
 * Safe to fire-and-forget. Never throws. Telemetry only.
 */
async function runForUserEnrich(deviceId, ctx, opts = {}) {
  const startedAt = Date.now();
  try {
    const { pack, wellness, enrichedAnomalies, top_correlations } = ctx;
    const language = opts.language || ctx.language || 'en';

    const { slots: plan_slots, usage: plan_usage } = await plan({
      pack, wellness, anomalies: enrichedAnomalies, top_correlations, language,
    });
    const { content: execContent, usage: exec_usage } = await execute({
      pack, wellness, anomalies: enrichedAnomalies, top_correlations, plan_slots, language,
      deviceId,
    });

    const claims = collectClaims(execContent, top_correlations);
    const validation = await validateClaims({
      claims,
      source: { wellness, pack, anomalies: enrichedAnomalies, correlations: top_correlations },
      useLLMFallback: !!process.env.OPENAI_API_KEY,
    });
    applyValidationResults(execContent, validation, top_correlations);

    // Patch the persisted pack with LLM enrichments
    const patch = {
      'wellness.why_line': (execContent && execContent.why_line) || wellness.why_line || null,
      anomaly: execContent && execContent.home_anomaly ? execContent.home_anomaly : null,
      _enrichment_pending: false,
      _enriched_at: Timestamp.now(),
    };

    // Firestore "dot path" updates aren't trivial via .set merge — read-modify-write
    const cur = await v2HomePack(deviceId).get();
    if (cur.exists) {
      const data = cur.data();
      const next = {
        ...data,
        wellness: { ...(data.wellness || {}), why_line: patch['wellness.why_line'] },
        anomaly: patch.anomaly || data.anomaly,
        _enrichment_pending: false,
        _enriched_at: Timestamp.now(),
        _lang: language,
      };
      await v2HomePack(deviceId).set(next, { merge: true });
    }

    return {
      latency_ms: Date.now() - startedAt,
      validation_ok: validation.ok,
      llm_calls: { planner: plan_usage || null, executor: exec_usage || null },
    };
  } catch (err) {
    log.warn(`[v2 enrich] ${deviceId} failed:`, err && err.message);
    return { latency_ms: Date.now() - startedAt, error: err && err.message };
  }
}

/**
 * runForUser — full SYNCHRONOUS path including LLM. Used by cron for nightly batch
 * + by recompute when the caller wants the LLM-polished result inline.
 */
async function runForUser(deviceId, opts = {}) {
  const today = opts.todayDate || todayDate();
  const startedAt = Date.now();

  // 1. Snapshots
  const snapshots = await getAllSnapshots(deviceId, { todayDate: today });

  // 2. Pack — graceful fallback if user doc missing (treat as Day-0)
  const userSnap = await userDoc(deviceId).get();
  const userData = userSnap.exists
    ? userSnap.data()
    : { deviceId, name: 'there', cold_start_anchor: 'none', onboarding_answers: {} };
  const pack = buildContextPack({ snapshots, userData, todayDate: today });
  assertContextPack(pack);

  // 3. Wellness score
  const recentDailyHistory = await loadRecentDailyHistory(deviceId, 14);
  const profile = {
    anchor: userData.cold_start_anchor || pack.profile.cold_start_anchor || 'none',
    onboarding_answers: userData.onboarding_answers || {},
    setup_state: pack.profile.setup_state,
    total_days_logged: pack.summary.total_days_logged,
  };
  const wellness = computeWellness({
    snapshots,
    baselines: pack.baselines,
    profile,
    recentDailyHistory,
  });

  // 4. Correlations
  const { matrix } = buildDailyMatrix(snapshots);

  // Lifetime composite — same blend the Home headline reads.
  // Lifetime composite — see fast-path comment above. Day-1 invariant:
  // score_lifetime >= wellness.score. BASE_WEIGHTS-weighted across agents
  // with data; logging only lifts the headline, never drops it.
  wellness.score_lifetime = (() => {
    try {
      const BASE = require('../config').SCORE.BASE_WEIGHTS;
      const agents = Object.keys(snapshots);
      let weightedSum = 0, weightTotal = 0;
      for (const agent of agents) {
        const arr = matrix
          .map((r) => (r.scores && Number.isFinite(r.scores[agent]) ? r.scores[agent] : null))
          .filter((s) => Number.isFinite(s));
        if (!arr.length) continue;
        const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
        const w = Number.isFinite(BASE[agent]) ? BASE[agent] : 1;
        weightedSum += mean * w;
        weightTotal += w;
      }
      const lifetime = weightTotal > 0 ? Math.round(weightedSum / weightTotal) : null;
      if (lifetime == null) return Number.isFinite(wellness.score) ? wellness.score : null;
      return Number.isFinite(wellness.score) ? Math.max(lifetime, wellness.score) : lifetime;
    } catch { return Number.isFinite(wellness.score) ? wellness.score : null; }
  })();

  const allCorrelations = computeCorrelations(matrix);
  for (const c of allCorrelations) c.plain_english = translate(c);
  const top_correlations = selectTop(allCorrelations);

  // 5. Anomalies + attribution
  const anomalies = detectAnomalies({ snapshots, baselines: pack.baselines });
  const enrichedAnomalies = anomalies.map((a) => ({
    ...a,
    ...attributeCause(a, snapshots, top_correlations),
  }));

  // 6-7. Plan + Execute (LLM or deterministic)
  const { slots: plan_slots, source: plan_source, usage: plan_usage } = await plan({
    pack,
    wellness,
    anomalies: enrichedAnomalies,
    top_correlations,
    language: opts.language,
  });
  const { content: execContent, source: exec_source, usage: exec_usage } = await execute({
    pack,
    wellness,
    anomalies: enrichedAnomalies,
    top_correlations,
    plan_slots,
    language: opts.language,
    deviceId,
  });

  // 8. Validate numeric claims
  const claims = collectClaims(execContent, top_correlations);
  const validation = await validateClaims({
    claims,
    source: {
      wellness,
      pack,
      anomalies: enrichedAnomalies,
      correlations: top_correlations,
    },
    useLLMFallback: !!process.env.OPENAI_API_KEY,
  });
  applyValidationResults(execContent, validation, top_correlations);

  // Compose final wellness with validated why_line
  wellness.why_line = (execContent && execContent.why_line) || fallbackWhyLine(wellness);

  // 9. Streaks
  const prevStreaks = await loadPrevStreaks(deviceId);
  const streaks = computeStreaks({ snapshots, prevStreaks, todayDate: today });

  // 9b. Chronotype + matrix for cross-agent surfaces
  const chronotype_data = detectChronotype(snapshots.sleep && snapshots.sleep.recent_bedtimes);
  const matrix90 = buildDailyMatrix(snapshots, { source: 'last_90d' }).matrix;
  const week_pattern_data = computeWeekPattern(matrix90);

  // 9c. AHA triggers — fire deterministically, idempotent persist
  const ahaCtx = {
    today,
    daysSinceSignup: pack.profile.days_active || 0,
    totalLogsToday: Object.values(snapshots).reduce((s, sn) => s + (sn && sn.today && sn.today.has_log ? 1 : 0), 0),
    topCorrelations: top_correlations,
    streaks,
    chronotype: chronotype_data,
    weekPattern: week_pattern_data,
  };
  const ahaCandidates = evaluateTriggers(ahaCtx);
  const firedIds = await readAhaIds(deviceId);
  const freshAha = newEvents(ahaCandidates, firedIds);
  if (freshAha.length) await persistNewAha(deviceId, freshAha);
  const aha_feed_data = await readAhaFeed(deviceId, 12);

  // 10. Build response shapes
  const home_pack = buildHomeResponse({
    pack, snapshots, wellness, anomalies: enrichedAnomalies, exec: execContent, streaks,
    top_correlations,
  });
  const insights_packs = [7, 30, 90, 365].map((range) => ({
    range,
    pack: buildInsightsResponse({
      pack, snapshots, wellness, anomalies: enrichedAnomalies,
      top_correlations, allCorrelations, exec: execContent, range,
      chronotype: chronotype_data,
      aha_feed: aha_feed_data,
      week_pattern_precomputed: week_pattern_data,
    }),
  }));

  // 11. Persist (each write is non-fatal — read path can survive partial writes)
  const _lang = opts.language || 'en';
  const persists = [
    v2ContextPack(deviceId).set({ ...pack, _server_at: Timestamp.now() }, { merge: true }),
    v2HomePack(deviceId).set({ ...home_pack, _server_at: Timestamp.now(), _lang }, { merge: true }),
    ...insights_packs.map((ip) =>
      v2InsightsPack(deviceId, ip.range).set({ ...ip.pack, _server_at: Timestamp.now(), _lang }, { merge: true }),
    ),
    v2Correlations(deviceId).set({
      computed_at: Timestamp.now(),
      results: allCorrelations,
    }, { merge: true }),
    v2Streaks(deviceId).set({ ...streaks, _server_at: Timestamp.now() }, { merge: true }),
    v2ScoreHistoryCol(deviceId).doc(today).set({
      date: today,
      wellness_score: wellness.score,
      components: wellness.components,
      confidence: wellness.confidence,
      is_warm_start: wellness.is_warm_start,
      warm_start_blend: wellness.warm_start_blend,
      computed_at: Timestamp.now(),
    }, { merge: true }),
    ...enrichedAnomalies.map((a) =>
      v2AnomaliesCol(deviceId).doc(today).set({
        date: today,
        detected_at: Timestamp.now(),
        ...a,
      }, { merge: true }),
    ),
  ];
  await Promise.allSettled(persists).then((results) => {
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) {
      log.warn(`[v2 workflow] ${failed.length}/${persists.length} writes failed for ${deviceId}:`,
        failed.slice(0, 2).map((r) => r.reason && r.reason.message).join(' | '));
    }
  });

  const totalLatency = Date.now() - startedAt;

  return {
    home_pack,
    insights_packs,
    streaks,
    telemetry: {
      total_latency_ms: totalLatency,
      plan_source,
      exec_source,
      validation_ok: validation.ok,
      llm_calls: {
        planner: plan_usage || null,
        executor: exec_usage || null,
      },
    },
  };
}

function collectClaims(exec, correlations) {
  const claims = [];
  if (!exec) return claims;
  if (exec.why_line) claims.push({ id: 'why_line', text: exec.why_line });
  if (exec.home_anomaly) {
    if (exec.home_anomaly.headline) claims.push({ id: 'anomaly_head', text: exec.home_anomaly.headline });
    if (exec.home_anomaly.evidence) claims.push({ id: 'anomaly_evi', text: exec.home_anomaly.evidence });
  }
  if (exec.home_today_action && exec.home_today_action.rationale) {
    claims.push({ id: 'action_rat', text: exec.home_today_action.rationale });
  }
  if (exec.insights_today && exec.insights_today.one_big_thing) {
    claims.push({ id: 'obt_title', text: exec.insights_today.one_big_thing.title });
    claims.push({ id: 'obt_body', text: exec.insights_today.one_big_thing.body });
  }
  for (const w of (exec.insights_today && exec.insights_today.wins) || []) {
    if (w.evidence) claims.push({ id: `win_${w.agent}`, text: w.evidence });
  }
  for (const w of (exec.insights_today && exec.insights_today.watch) || []) {
    if (w.evidence) claims.push({ id: `watch_${w.agent}`, text: w.evidence });
  }
  for (const id of Object.keys(exec.insights_correlations_translations || {})) {
    claims.push({ id: `corr_${id}`, text: exec.insights_correlations_translations[id] });
  }
  return claims;
}

function applyValidationResults(exec, validation, correlations) {
  if (!exec || validation.ok) return;
  const failed = new Set(validation.results.filter((r) => !r.ok).map((r) => r.claim_id));
  if (failed.has('why_line')) exec.why_line = null;
  if (exec.home_anomaly && (failed.has('anomaly_head') || failed.has('anomaly_evi'))) {
    exec.home_anomaly = null;
  }
  if (exec.home_today_action && failed.has('action_rat')) {
    exec.home_today_action.rationale = '';
  }
  if (exec.insights_today && exec.insights_today.one_big_thing) {
    if (failed.has('obt_title') || failed.has('obt_body')) exec.insights_today.one_big_thing = null;
  }
  if (exec.insights_today && exec.insights_today.wins) {
    exec.insights_today.wins = exec.insights_today.wins.filter((w) => !failed.has(`win_${w.agent}`));
  }
  if (exec.insights_today && exec.insights_today.watch) {
    exec.insights_today.watch = exec.insights_today.watch.filter((w) => !failed.has(`watch_${w.agent}`));
  }
  if (exec.insights_correlations_translations) {
    for (const id of Object.keys(exec.insights_correlations_translations)) {
      if (failed.has(`corr_${id}`)) {
        const corr = correlations.find((c) => c.id === id);
        exec.insights_correlations_translations[id] = corr ? corr.plain_english : null;
      }
    }
  }
}

function buildHomeResponse({ pack, snapshots, wellness, anomalies, exec, streaks, top_correlations }) {
  const { smoothPoints } = require('../coaches/sparkline-smoother');
  const { buildCoachStates } = require('../coaches/state-machine');
  const { rankActions } = require('../actions/source-router');
  const { buildDidYouKnow } = require('../did-you-know');

  const sparklines = Object.values(snapshots).map((snap) => {
    const rawPoints = snap.last_14d.map((p) => ({
      date: p.date,
      value: Number.isFinite(p.score) ? p.score : null,
      has_data: !!p.has_log,
    }));
    const points = smoothPoints(rawPoints);
    const sample_size = points.filter((p) => p.has_data).length;
    const recent = points.filter((p) => p.has_data).slice(-7);
    const earlier = points.filter((p) => p.has_data).slice(-14, -7);
    const avgRecent = recent.length ? recent.reduce((s, p) => s + p.value, 0) / recent.length : null;
    const avgEarlier = earlier.length ? earlier.reduce((s, p) => s + p.value, 0) / earlier.length : null;
    let direction = 'flat';
    let delta_vs_baseline = 0;
    if (Number.isFinite(avgRecent) && Number.isFinite(avgEarlier)) {
      delta_vs_baseline = Math.round((avgRecent - avgEarlier) * 10) / 10;
      direction = delta_vs_baseline > 2 ? 'up' : (delta_vs_baseline < -2 ? 'down' : 'flat');
    }
    return {
      agent: snap.agent,
      points,
      delta_vs_baseline,
      direction,
      sample_size,
    };
  });

  // V2 enrichment: explicit per-coach state machine output for FE rendering.
  const coachStates = buildCoachStates(snapshots);
  // Wire streaks into states
  if (streaks && Array.isArray(streaks.per_agent)) {
    for (const cs of coachStates) {
      const st = streaks.per_agent.find((s) => s.agent === cs.agent);
      if (st) cs.streak_days = st.current || 0;
    }
  }

  return {
    profile: {
      device_id: pack.profile.device_id,
      name: pack.profile.name,
      days_active: pack.profile.days_active,
      setup_count: pack.profile.setup_count,
      setup_state: pack.profile.setup_state,
      tier: pack.summary.tier,
      // Registration Anchor (2026-05-13): exposed for Home headline copy
      // and depth-ribbon gating. Sourced from pack.profile if the adapter
      // stamped it; otherwise null and FE falls back to /anchor route.
      anchor_date: pack.profile.anchor_date || null,
      days_since_anchor: pack.profile.days_since_anchor || null,
    },
    // Wellness object — also enforce the score_lifetime >= score invariant
    // here as a last line of defense for any caller that bypasses the
    // home-pack.repo write path. Logging can only LIFT the headline.
    wellness: (() => {
      const w = { ...wellness, why_line: (exec && exec.why_line) || wellness.why_line || null };
      if (Number.isFinite(w.score) && (!Number.isFinite(w.score_lifetime) || w.score_lifetime < w.score)) {
        w.score_lifetime = w.score;
      }
      return w;
    })(),
    sparklines,
    coach_states: coachStates,
    anomaly: exec && exec.home_anomaly ? exec.home_anomaly : (anomalies && anomalies[0] ? {
      agent: anomalies[0].agent,
      severity: anomalies[0].severity,
      headline: anomalies[0].headline,
      evidence: anomalies[0].evidence,
      likely_cause_agent: anomalies[0].likely_cause_agent || null,
      drill_correlation_id: anomalies[0].drill_correlation_id || null,
    } : null),
    ...(() => {
      const ranked = rankActions({
        snapshots, anomalies, correlations: top_correlations,
        streaks, sparklines,
      });
      const top = ranked[0];
      // Normalize today_action: legacy FE expects agent/prompt/rationale,
      // newer expects coach/title/sub. Send both for compatibility.
      const today_action = top
        ? {
            agent: top.coach,           // legacy
            coach: top.coach,
            prompt: top.title,
            title: top.title,
            rationale: top.sub,
            sub: top.sub,
            source: top.source,
            priority: top.priority,
            expected_score_delta: top.expected_score_delta,
            drill_correlation_id: top.drill_correlation_id,
            one_tap_log: null,
          }
        : (exec && exec.home_today_action) || null;
      return { today_action, actions: ranked };
    })(),
    streaks: {
      per_agent: streaks.per_agent,
      cross_agent_grace_active: streaks.cross_agent_grace_active,
      grace_reason: streaks.grace_reason,
      streak_freeze_available: streaks.streak_freeze_available,
      streak_freeze_count: streaks.streak_freeze_count,
      next_freeze_grant_at: streaks.next_freeze_grant_at,
    },
    quick_log_dock: ['sleep', 'mind', 'nutrition', 'fitness', 'water', 'fasting'].map((agent) => ({
      agent,
      icon_id: agent,
      last_used_at: snapshots[agent] && snapshots[agent].score_updated_at,
    })),
    did_you_know: buildDidYouKnow({ pack, snapshots, top_correlations, streaks, wellness }),
    meta: {
      pack_version: pack.pack_version,
      computed_at: pack.computed_at,
      stale_for_seconds: 0,
      schema_version: SCHEMA,
    },
  };
}

/**
 * buildInsightsResponse — schema 2.3.0, FE-canonical shape.
 *
 * Pulls from already-computed deterministic outputs:
 *   - `snapshots.{agent}.last_90d` → daily scores, windowed to `range`
 *   - `pack.baselines.{agent}` → personal mean/std for z-scoring
 *   - `snapshots.{agent}.log_counts_by_date` → raw log counts for COACH LOGS tile
 *   - `top_correlations` → top_links + edges
 *   - `anomalies` → recent_aha (Phase 5 will replace with proper trigger system)
 *
 * Phase 3 (DONE): capacity_strain_form built via cross-agent recovery boost
 *   (sleep_z and nutrition_z modulate effective strain).
 *
 * Stubs (filled in later phases — pack always returns the field, FE has graceful fallback):
 *   - chronotype            (P4)
 *   - aha_feed (full)       (P5)
 *   - best_worst_week       (P6)
 *   - quarterly_story       (P6)
 *   - did_you_know          (P7)
 */
function buildInsightsResponse({
  pack, snapshots, wellness, anomalies, top_correlations, allCorrelations, exec, range,
  // Phase 4-5 — optional pre-computed cross-agent surfaces
  chronotype: chronotypeData,
  aha_feed: ahaFeedData,
  week_pattern_precomputed: weekPatternPrecomputed,
}) {
  const AGENTS = ['sleep', 'mind', 'nutrition', 'fitness', 'water', 'fasting'];

  // Use the longer 90d matrix when available so range=90 has full history
  const { matrix } = buildDailyMatrix(snapshots, { source: 'last_90d' });
  const window = matrix.slice(-Math.min(range, matrix.length));

  // ── log_counts (sum of raw logs over window) ──
  const log_counts = computeLogCounts(snapshots, window);

  // ── z_series (one row per day, six z-scores) ──
  const z_series = computeZSeries(window, pack.baselines);

  // ── week_pattern (day-of-week heatmap from window scores) ──
  // Prefer precomputed (full 90d) when caller provides it; falls back to windowed compute
  const week_pattern = weekPatternPrecomputed || computeWeekPattern(window);

  // ── edges + top_links from existing correlation engine ──
  const edges = (top_correlations || []).map((c) => ({
    a: c.agents[0],
    b: c.agents[1],
    r: round3(c.r),
    n: c.n,
  }));

  const top_links = (top_correlations || []).map((c) => {
    const a = c.agents[0], b = c.agents[1];
    return {
      id: c.id,
      a, b,
      r: round3(c.r),
      n: c.n,
      lag: c.lag || 0,
      headline: (exec && exec.insights_correlations_translations && exec.insights_correlations_translations[c.id]) || c.plain_english || `${cap(a)} × ${cap(b)}`,
      sparkline_a: lastZ(window, a, 14, pack.baselines).map(zToScore),
      sparkline_b: lastZ(window, b, 14, pack.baselines).map(zToScore),
    };
  });

  // ── recent_aha — Phase 5: prefer the curated AHA feed; fall back to anomaly ──
  const aha_feed_resolved = Array.isArray(ahaFeedData) ? ahaFeedData : [];
  const recent_aha = aha_feed_resolved.length > 0
    ? aha_feed_resolved[0]
    : (anomalies && anomalies.length > 0)
      ? {
          ts: anomalies[0].date || pack.today.date,
          kind: anomalies[0].direction === 'spike' ? 'spike' : 'dip',
          headline: anomalies[0].headline,
          body: anomalies[0].evidence,
        }
      : null;

  // Day-1 hardening — confidence ribbon per field so FE renders
  // "more logs → deeper" hints instead of locking. NEVER returns null pack.
  const confidence_per_field = {
    log_counts:        log_counts && (log_counts.sleep + log_counts.mind + log_counts.nutrition +
                       log_counts.fitness + log_counts.water + log_counts.fasting) > 0 ? 'confident' : 'early',
    z_series:          z_series.length >= 14 ? 'confident' : z_series.length >= 7 ? 'moderate' : 'early',
    edges:             edges.length > 0 ? 'confident' : 'early',
    week_pattern:      week_pattern && week_pattern.composite ? 'confident' : 'early',
    top_links:         top_links.length > 0 ? 'confident' : 'early',
    capacity_strain_form: null, // computed below
    chronotype:        chronotypeData ? 'confident' : 'early',
    aha_feed:          aha_feed_resolved.length > 0 ? 'confident' : 'early',
    quarterly_story:   null, // computed below
    did_you_know:      'confident', // always rotates a fallback so always present
  };

  return {
    schema_version: config.INSIGHTS_SCHEMA_VERSION,
    meta: {
      device_id: pack.profile.device_id,
      calibration_days_done: Math.min(14, pack.summary.total_days_logged || 0),
      // Prefer the anchor-derived count when available; falls back to
      // days_active for legacy/no-anchor users. Both are derived from
      // wellness_users.created_at so they agree at runtime.
      days_since_signup: pack.profile.days_since_anchor || pack.profile.days_active || 0,
      anchor_date: pack.profile.anchor_date || null,
      setup_count: pack.profile.setup_count || 0,
      setup_state: pack.profile.setup_state || {},
      cohort_age_band: pack.profile.cohort_age_band || '25-34',
      range,
      computed_at: pack.computed_at,
      stale_for_seconds: 0,
      pack_version: pack.pack_version,
      // Day-1 confidence — FE shows soft "more logs → deeper" ribbon for 'early'
      confidence_per_field,
    },

    log_counts,
    z_series,
    edges,
    week_pattern,
    top_links,

    // Phase 3 — Capacity / Strain / Form, cross-agent boosted
    capacity_strain_form: (function () {
      const csf = buildCapacityStrainForm({
        fitnessLast90: snapshots.fitness && snapshots.fitness.last_90d,
        zSeries: computeZSeries(matrix, pack.baselines),  // full 90d z, not windowed
        dates: matrix.map((r) => r.date),
      });
      confidence_per_field.capacity_strain_form = csf ? 'confident' : 'early';
      return csf;
    })(),

    // Phase 4 — Chronotype from circular mean of last-30 sleep onset times
    // Prefer pre-computed (caller may have already resolved) to avoid double work
    chronotype: chronotypeData !== undefined ? chronotypeData : detectChronotype(snapshots.sleep && snapshots.sleep.recent_bedtimes),

    // Phase 5 — AHA event feed (idempotent, persisted) + recent_aha (top of feed)
    recent_aha,
    aha_feed: aha_feed_resolved,

    // Phase 6 — Quarterly story (fires at day 90+ with ≥75% density)
    quarterly_story: (function () {
      const qs = buildQuarterlyStory({
        snapshots,
        daysSinceSignup: pack.profile.days_active || 0,
        logCountsTotal: Object.values(log_counts).reduce((s, n) => s + (n || 0), 0),
      });
      confidence_per_field.quarterly_story = qs && qs.unlocked ? 'confident' : 'early';
      return qs;
    })(),

    best_worst_week: buildBestWorstWeek(matrix),

    // Phase 7 — Did You Know, ranked by user's top cross-agent correlation
    did_you_know: pickDidYouKnow({
      topCorrelations: top_correlations,
      dateKey: pack.today && pack.today.date,
    }),

    // Day-1 LAW — guaranteed substantive content for users < 14 days
    // (welcome, roadmap, goals_preview, educational_correlations).
    // Always present; FE renders only when shown=true.
    day_one_kit: buildDayOneKit({
      daysSinceSignup: pack.profile.days_active || 0,
      setupState: pack.profile.setup_state || {},
      snapshots,
    }),
  };
}

/**
 * best/worst week — last 90d composite scores grouped into 7-day buckets.
 * Output: { best: { score, label }, worst: { score, label } | null } or null.
 */
function buildBestWorstWeek(matrix90) {
  if (!Array.isArray(matrix90) || matrix90.length < 14) return null;
  const AGENTS = ['sleep', 'mind', 'nutrition', 'fitness', 'water', 'fasting'];
  const weeks = [];
  for (let start = 0; start + 7 <= matrix90.length; start += 7) {
    const slice = matrix90.slice(start, start + 7);
    const scores = [];
    for (const row of slice) {
      const real = AGENTS.map((a) => row.scores[a]).filter(Number.isFinite);
      if (real.length) scores.push(real.reduce((s, v) => s + v, 0) / real.length);
    }
    if (scores.length === 0) continue;
    const avg = scores.reduce((s, v) => s + v, 0) / scores.length;
    weeks.push({ index: weeks.length + 1, score: Math.round(avg) });
  }
  if (weeks.length === 0) return null;
  const sorted = [...weeks].sort((x, y) => y.score - x.score);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  const label = (w) => w.index === weeks.length ? 'This week' : `Week ${w.index}`;
  return {
    best:  { score: best.score,  label: label(best) },
    worst: weeks.length >= 2 ? { score: worst.score, label: label(worst) } : null,
  };
}

// ── helpers ──────────────────────────────────────────────

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
function round3(v) { return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v; }

/**
 * Sum log counts per agent over the given date window.
 */
function computeLogCounts(snapshots, window) {
  const out = { sleep: 0, mind: 0, nutrition: 0, fitness: 0, water: 0, fasting: 0 };
  if (!window || !window.length) return out;
  const dates = window.map((r) => r.date);
  for (const a of Object.keys(out)) {
    const map = snapshots[a] && snapshots[a].log_counts_by_date;
    if (!map) continue;
    let sum = 0;
    for (const d of dates) {
      const v = map[d];
      if (Number.isFinite(v)) sum += v;
    }
    out[a] = sum;
  }
  return out;
}

/**
 * Z-score each agent's daily score against personal baseline mean/std.
 * Returns [{ d, sleep, mind, nutrition, fitness, water, fasting }].
 * Cold-start (no baseline) → z = 0 for that day.
 */
function computeZSeries(window, baselines) {
  const STD_FLOOR = config.SCORE.EWM_STD_FLOOR || 5.0;
  const AGENTS = ['sleep', 'mind', 'nutrition', 'fitness', 'water', 'fasting'];
  return window.map((row, i) => {
    const o = { d: i };
    for (const a of AGENTS) {
      const score = row.scores[a];
      const bl = baselines && baselines[a];
      if (!Number.isFinite(score) || !bl || !Number.isFinite(bl.mean) || !Number.isFinite(bl.std)) {
        o[a] = 0;
        continue;
      }
      const std = Math.max(bl.std, STD_FLOOR);
      const z = (score - bl.mean) / std;
      o[a] = Math.round(Math.max(-2.5, Math.min(2.5, z)) * 100) / 100;
    }
    return o;
  });
}

/**
 * Last n z-values for an agent (used by sparklines on top_links).
 */
function lastZ(window, agent, n, baselines) {
  const STD_FLOOR = config.SCORE.EWM_STD_FLOOR || 5.0;
  const slice = window.slice(-n);
  return slice.map((row) => {
    const score = row.scores[agent];
    const bl = baselines && baselines[agent];
    if (!Number.isFinite(score) || !bl || !Number.isFinite(bl.mean) || !Number.isFinite(bl.std)) {
      return 0;
    }
    const std = Math.max(bl.std, STD_FLOOR);
    const z = (score - bl.mean) / std;
    return Math.max(-2.5, Math.min(2.5, z));
  });
}

// Convert z (-2.5..2.5) → score 0..100 for sparkline rendering on FE.
function zToScore(z) {
  const v = 50 + z * 20;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/**
 * Day-of-week pattern: averages each agent's score by DOW (Mon..Sun).
 * Composite = average of all 6 agents per DOW.
 * Returns { composite[7], per_agent: { sleep[7], ... }, worst, best, headline }.
 */
function computeWeekPattern(window) {
  const AGENTS = ['sleep', 'mind', 'nutrition', 'fitness', 'water', 'fasting'];
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  if (!window || window.length < 7) return null;

  // dow: 0=Mon..6=Sun (JS getUTCDay: 0=Sun..6=Sat → remap)
  const dowOf = (date) => {
    const js = new Date(date + 'T00:00:00Z').getUTCDay(); // 0=Sun
    return (js + 6) % 7; // 0=Mon
  };

  const buckets_per_agent = {};
  for (const a of AGENTS) buckets_per_agent[a] = Array.from({ length: 7 }, () => []);
  const buckets_composite = Array.from({ length: 7 }, () => []);

  for (const row of window) {
    const d = dowOf(row.date);
    const realPerAgent = [];
    for (const a of AGENTS) {
      if (Number.isFinite(row.scores[a])) {
        buckets_per_agent[a][d].push(row.scores[a]);
        realPerAgent.push(row.scores[a]);
      }
    }
    if (realPerAgent.length) {
      buckets_composite[d].push(realPerAgent.reduce((s, v) => s + v, 0) / realPerAgent.length);
    }
  }

  const meanOrNull = (arr) => arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : null;
  const composite = buckets_composite.map(meanOrNull);
  const per_agent = {};
  for (const a of AGENTS) per_agent[a] = buckets_per_agent[a].map(meanOrNull);

  const finite = composite.map((v, i) => ({ v, i })).filter((x) => Number.isFinite(x.v));
  if (!finite.length) return { composite, per_agent, worst: null, best: null, headline: null };
  finite.sort((x, y) => x.v - y.v);
  const worst = finite[0].i;
  const best = finite[finite.length - 1].i;
  const headline = `${DAYS[worst]}s tend to be your hardest day, ${DAYS[best]}s your strongest.`;

  return { composite, per_agent, worst, best, headline };
}

/**
 * Day-0 minimal pack — used as fallback when runForUser throws.
 * No agent data, no correlations — just enough shape to render the UI.
 */
function buildDay0FallbackPack(deviceId, errMsg) {
  const today = todayDate();
  const AGENTS = ['sleep', 'mind', 'nutrition', 'fitness', 'water', 'fasting'];
  const setup_state = Object.fromEntries(AGENTS.map((a) => [a, false]));

  const components = AGENTS.map((agent) => ({
    agent, score: null, weight: 0, delta_vs_baseline: 0,
    contribution_pts: 0, is_top_contributor: false,
  }));

  const sparklines = AGENTS.map((agent) => ({
    agent,
    points: Array.from({ length: 14 }, (_, i) => {
      const d = new Date(today + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - (13 - i));
      return { date: _localDateStr(d), value: null, has_data: false };
    }),
    delta_vs_baseline: 0,
    direction: 'flat',
    sample_size: 0,
  }));

  return {
    profile: {
      device_id: deviceId, name: 'there', days_active: 0, setup_count: 0,
      setup_state, tier: 0,
    },
    wellness: {
      // Fallback: 0 setup → score 0. +2 per coach is added in the real path; this
      // fallback only fires if runForUser throws and we can't compute.
      score: 0,
      delta_vs_yesterday: 0,
      delta_vs_7d_avg: 0,
      confidence: 0.0,
      calibration_days_done: 0,
      calibration_days_target: 14,
      is_warm_start: true,
      warm_start_blend: 0,
      components,
      why_line: null,
      score_status: 'starting',
      trend_direction: 'flat',
      volatility_14d: 0,
      baseline_30d: 0,
    },
    sparklines,
    anomaly: null,
    today_action: null,
    streaks: {
      per_agent: AGENTS.map((agent) => ({ agent, current: 0, longest: 0, status: 'lapsed' })),
      cross_agent_grace_active: false,
      grace_reason: null,
      streak_freeze_available: true,
      streak_freeze_count: 1,
      next_freeze_grant_at: today,
    },
    quick_log_dock: AGENTS.map((agent) => ({ agent, icon_id: agent, last_used_at: null })),
    meta: {
      pack_version: '2.0.0',
      computed_at: new Date().toISOString(),
      stale_for_seconds: 0,
      schema_version: SCHEMA,
      _fallback: true,
      _error: errMsg || null,
    },
  };
}

/**
 * Resilient wrapper — never throws. Returns at least a Day-0 pack.
 * The 500-prone runForUser is now buildable into safe runs.
 */
async function runForUserSafe(deviceId, opts = {}) {
  try {
    return await runForUser(deviceId, opts);
  } catch (err) {
    const msg = (err && err.message) || String(err);
    const stack = (err && err.stack) || '';
    log.error(`[v2 workflow] FATAL for ${deviceId}: ${msg}\n${stack.split('\n').slice(0, 4).join('\n')}`);
    return {
      home_pack: buildDay0FallbackPack(deviceId, msg),
      insights_packs: [
        { range: 7, pack: null }, { range: 30, pack: null }, { range: 90, pack: null }, { range: 365, pack: null },
      ],
      streaks: null,
      telemetry: { error: msg, fallback: true },
    };
  }
}

/**
 * runForUserFastSafe — never-throws wrapper around runForUserFast.
 * Falls back to Day-0 pack if anything explodes.
 */
async function runForUserFastSafe(deviceId, opts = {}) {
  try {
    return await runForUserFast(deviceId, opts);
  } catch (err) {
    const msg = (err && err.message) || String(err);
    log.error(`[v2 fast] FATAL for ${deviceId}: ${msg}`);
    return {
      home_pack: buildDay0FallbackPack(deviceId, msg),
      insights_packs: [{ range: 7, pack: null }, { range: 30, pack: null }, { range: 90, pack: null }, { range: 365, pack: null }],
      streaks: null,
      enrichment_context: null,
      telemetry: { error: msg, fallback: true, path: 'fast_fallback' },
    };
  }
}

module.exports = {
  runForUser,
  runForUserSafe,
  runForUserFast,
  runForUserFastSafe,
  runForUserEnrich,
  buildDay0FallbackPack,
  // exported for integration tests — pure function, no I/O
  buildInsightsResponse,
};
