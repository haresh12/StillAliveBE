"use strict";
// ════════════════════════════════════════════════════════════════
// ACTIONS ENGINE — shared module powering Actions across all 6 agents
// ────────────────────────────────────────────────────────────────
// Each agent provides:
//   • agentName              — 'fitness' | 'mind' | 'sleep' | ...
//   • agentDocRef(deviceId)  — Firestore doc ref (e.g. .../agents/{agentName})
//   • actionsCol(deviceId)   — Firestore collection ref for actions
//   • logsCol(deviceId)      — Firestore collection of the agent's primary log
//                              (workouts | sleep_sessions | fasting_sessions | etc)
//   • computeCandidates(logs, setup, ctx) — agent-specific scoring of candidates
//   • graders                — { success_type → async (deviceId, action, recentLogs) → {met, partial, value} }
//   • openai                 — OpenAI client
//   • admin                  — firebase-admin (for FieldValue.serverTimestamp etc)
//
// Engine provides:
//   • applyFilters(candidates, recentlyHandled)
//   • selectSlots(filtered) → {spotlight, secondaries, micro}
//   • generateActionBatch(deps) — writes new active batch
//   • gradeActions(deps) — runs graders against active actions
//   • buildResponseShape(allActions, agentData) — v2 GET shape
//   • mountActionRoutes(router, deps) — wires /actions, /actions/history,
//     /action/:id/{complete|skip|snooze|feedback}
//
// Universal contract:
//   ARCHETYPES   = 7 universal types
//   SLOT_CONFIG  = 1 spotlight + 2 secondaries + 1 micro (max 4 cards/batch)
//   BATCH_SIZE   = 3 logs since last batch triggers regeneration
//   MAX_SNOOZES  = 2
//   EXPIRES      = 7 days (3 for spotlight, 14 for micro)
//   PROACTIVE_HARD_CAP_PER_AGENT_PER_3H = 1 generation
// ════════════════════════════════════════════════════════════════

const ARCHETYPES = [
  "spotlight", "win_back", "prevent", "breakthrough",
  "recover", "progress", "explore", "micro",
];

const SLOT_CONFIG = {
  spotlight: 1,
  secondary: 2,
  micro: 1,
};

const DEFAULTS = {
  BATCH_SIZE: 3,
  MAX_SNOOZES: 2,
  EXPIRES_SPOTLIGHT_DAYS: 3,
  EXPIRES_SECONDARY_DAYS: 7,
  EXPIRES_MICRO_DAYS: 14,
  RECENCY_GUARD_DAYS: 21,
  GENERATION_COOLDOWN_MS: 3 * 3600 * 1000, // 3h between batches
  STALE_GENERATION_MS: 90 * 1000,
};

// In-memory generation lock per (agent, deviceId) — prevents duplicate generation
const _generationLocks = new Map();

// ════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════
function getMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  const p = new Date(value).getTime();
  return Number.isNaN(p) ? 0 : p;
}
function toIso(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  const p = new Date(value);
  return Number.isNaN(p.getTime()) ? null : p.toISOString();
}
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function mapDoc(doc) { return { id: doc.id, ...doc.data() }; }

// ════════════════════════════════════════════════════════════════
// FILTER + SLOT SELECTION (pure functions)
// ════════════════════════════════════════════════════════════════

/**
 * Filter candidates by recency + diversity + caller-provided guard.
 * @param {Candidate[]} candidates - sorted by score desc
 * @param {Action[]} recentlyHandled - last 30d of completed/skipped/graded
 * @param {function} agentRecoveryGuard - (candidate) => boolean (true=keep)
 */
function applyFilters(candidates, recentlyHandled = [], agentRecoveryGuard = null) {
  const recencyCutoffMs = Date.now() - DEFAULTS.RECENCY_GUARD_DAYS * 86400000;
  const recentMetrics = new Set(
    recentlyHandled
      .filter(a => a.generated_at && getMillis(a.generated_at) > recencyCutoffMs)
      .map(a => a.proof?.metric)
      .filter(Boolean),
  );
  return candidates.filter(c => {
    if (recentMetrics.has(c.proof?.metric)) return false;
    if (agentRecoveryGuard && !agentRecoveryGuard(c)) return false;
    return true;
  });
}

/**
 * Select 1 spotlight + 2 secondaries + 1 micro from filtered candidates.
 * Diversity rule: max 1 per archetype across spotlight+secondaries.
 */
function selectSlots(filtered) {
  const seenArch = new Set();
  const slots = [];
  let micro = null;
  for (const c of filtered) {
    if (c.archetype === "micro") { if (!micro) micro = c; continue; }
    if (seenArch.has(c.archetype)) continue;
    if (slots.length >= SLOT_CONFIG.spotlight + SLOT_CONFIG.secondary) continue;
    seenArch.add(c.archetype);
    slots.push(c);
  }
  if (!micro) {
    micro = filtered.find(c => c.archetype === "micro") || null;
  }
  return {
    spotlight: slots[0] || null,
    secondaries: slots.slice(1, 1 + SLOT_CONFIG.secondary),
    micro,
  };
}

// ════════════════════════════════════════════════════════════════
// AI PROMPT BUILDER + GENERATION
// ════════════════════════════════════════════════════════════════

function buildPrompt(deps, slots, recentlyHandled, setup) {
  const { agentName, setupSummary } = deps;
  const candidateSummary = slots.map((c, i) => {
    const role = i === 0 ? "SPOTLIGHT" :
                 c.archetype === "micro" ? "MICRO" : `SECONDARY_${i}`;
    return `[${role}] archetype=${c.archetype}, score=${c.score}, category=${c.category}\n` +
           `  proof_metric=${c.proof.metric}=${c.proof.value} (threshold=${c.proof.threshold}, citation=${c.proof.citation})\n` +
           `  pre_baked_proof=${c.proof_text}\n` +
           `  pre_baked_hook=${c.surprise_hook}\n` +
           `  target=${JSON.stringify(c.target)}, success_type=${c.success_type}, when=${c.when_to_do}`;
  }).join("\n\n");

  const recentlyHandledStr = (recentlyHandled || [])
    .filter(a => ["completed","skipped"].includes(a.status) || a.outcome_grade)
    .slice(0, 8)
    .map(a => `${a.outcome_grade || a.status}: ${a.title}`)
    .join(" | ");

  const setupStr = setupSummary ? setupSummary(setup) : JSON.stringify(setup || {}).slice(0, 300);

  return [
    `You are an elite ${agentName} coach. Write copy for action cards based on PRE-COMPUTED candidates.`,
    "DO NOT invent metrics. DO NOT change targets. DO NOT contradict the proof.",
    "Your job: write punchy human copy that hits the AHA moment using the exact data given.",
    "",
    "Output strict JSON:",
    `{ "actions": [`,
    `   { "title": "<≤32 chars verb-first>",`,
    `     "surprise_hook": "<≤80 chars — one surprising stat>",`,
    `     "text": "<≤96 chars — what to do, when, where>",`,
    `     "proof_body": "<≤140 chars — cite exact numbers + research source>",`,
    `     "success_criterion_text": "<≤80 chars — how user knows it's done>",`,
    `     "follow_up": "<≤60 chars — when coach checks in>",`,
    `     "expires_in_days": 3|7|14`,
    `   }, ...`,
    `  ],`,
    `  "weekly_focus": "<≤60 chars — one-line theme tying actions together>"`,
    `}`,
    "",
    "Rules:",
    "• ONE action per slot, in the SAME order as the slots provided below.",
    "• Every proof_body must cite the exact metric value + threshold + citation given.",
    "• Every surprise_hook must be a non-obvious data point.",
    "• No motivational fluff. No generic advice.",
    `• You are STRICTLY the ${agentName} coach. Do NOT discuss other domains (sleep/water/mood/fasting/fitness) unless this IS that domain.`,
    `• Avoid repeating phrasing from recently handled: ${recentlyHandledStr || "none"}`,
    "",
    "USER SETUP:",
    setupStr,
    "",
    "CANDIDATES:",
    candidateSummary,
  ].join("\n");
}

/**
 * Generate a fresh action batch using agent-specific candidates + AI for copy.
 * Writes v2 actions to Firestore. Archives previous active.
 */
async function generateActionBatch(deps) {
  const {
    agentName, deviceId, agentDocRef, actionsCol, logsCol,
    computeCandidates, openai, admin, db,
    setupSummary, recoveryGuard,
    config = {},
    generationKind = "pattern",
  } = deps;

  const cfg = { ...DEFAULTS, ...config };
  const lockKey = `${agentName}:${deviceId}`;

  // Cooldown + in-flight guard
  const existing = _generationLocks.get(lockKey);
  if (existing && Date.now() - existing.startedAt < cfg.STALE_GENERATION_MS) return [];

  _generationLocks.set(lockKey, { startedAt: Date.now() });
  try {
    const fSnap = await agentDocRef(deviceId).get();
    if (!fSnap.exists) return [];
    const setup = fSnap.data().setup || fSnap.data();

    // Cooldown: only AUTO/cron triggers respect the 3h gate.
    // 'setup' and 'user_logged' are explicit user actions — they always regenerate.
    // 'pattern' = legacy alias for cron-style auto regen.
    const lastBatchMs = getMillis(fSnap.data().last_action_batch_generated);
    const isAutoTrigger = generationKind === 'cron' || generationKind === 'pattern_auto';
    if (lastBatchMs && Date.now() - lastBatchMs < cfg.GENERATION_COOLDOWN_MS && isAutoTrigger) {
      return [];
    }

    // Pull recent logs
    const wSnap = await logsCol(deviceId)
      .orderBy("logged_at", "desc")
      .limit(150)
      .get();
    const logs = wSnap.docs.map(mapDoc);

    // Pull recent actions for recency + outcome surface
    const recentSnap = await actionsCol(deviceId)
      .orderBy("generated_at", "desc")
      .limit(40)
      .get();
    const recentActions = recentSnap.docs.map(mapDoc);

    // Compute candidates (agent-specific)
    const ctx = { setup, recentActions };
    const candidates = await computeCandidates(logs, setup, ctx);
    const filtered = applyFilters(candidates, recentActions, recoveryGuard);
    const slotted = selectSlots(filtered);

    const slots = [slotted.spotlight, ...slotted.secondaries, slotted.micro].filter(Boolean);
    const batchKey = `${new Date().toISOString().slice(0, 10)}_${Date.now()}`;

    if (slots.length === 0) {
      const noopBatch = db().batch();
      const oldActiveSnap = await actionsCol(deviceId)
        .where("status", "==", "active")
        .limit(20)
        .get();
      for (const d of oldActiveSnap.docs) noopBatch.update(d.ref, { status: "archived" });
      noopBatch.update(agentDocRef(deviceId), {
        last_action_batch_key: batchKey,
        last_action_batch_generated: admin.firestore.FieldValue.serverTimestamp(),
        pending_action_generation: false,
        no_actions_reason: "All systems green — keep current cadence.",
      });
      await noopBatch.commit();
      return [];
    }

    // ── AI for copy ──
    const prompt = buildPrompt({ agentName, setupSummary }, slots, recentActions, setup);
    let aiActions = [];
    let weeklyFocus = "";
    try {
      const aiRes = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        max_tokens: 900,
        temperature: 0.4,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: prompt }],
      });
      const parsed = JSON.parse(aiRes.choices[0].message.content);
      aiActions = Array.isArray(parsed.actions) ? parsed.actions : [];
      weeklyFocus = parsed.weekly_focus || "";
    } catch (e) {
      console.error(`[${agentName}] action copy AI:`, e);
      // Fallback: use pre-baked text
      aiActions = slots.map(c => ({
        title: (c.surprise_hook || `${c.archetype} action`).slice(0, 32),
        surprise_hook: c.surprise_hook,
        text: c.proof_text || "",
        proof_body: c.proof_text,
        success_criterion_text: "Met when criterion satisfied",
        follow_up: "Coach checks back in 7 days",
        expires_in_days: 7,
      }));
    }

    // ── Persist ──
    const writeBatch = db().batch();
    const oldActiveSnap = await actionsCol(deviceId)
      .where("status", "==", "active")
      .limit(20)
      .get();
    for (const d of oldActiveSnap.docs) writeBatch.update(d.ref, { status: "archived" });

    // Mark previous outcome card as surfaced so it's not shown twice
    const ungrasped = recentActions.find(a => a.outcome_grade && !a.outcome_surfaced);
    if (ungrasped) {
      writeBatch.update(actionsCol(deviceId).doc(ungrasped.id), { outcome_surfaced: true });
    }

    for (let i = 0; i < slots.length; i++) {
      const c = slots[i];
      const ai = aiActions[i] || {};
      const role = i === 0 ? "spotlight" : c.archetype === "micro" ? "micro" : "secondary";
      const expiresInDays =
        ai.expires_in_days ||
        (role === "micro" ? cfg.EXPIRES_MICRO_DAYS :
         role === "spotlight" ? cfg.EXPIRES_SPOTLIGHT_DAYS : cfg.EXPIRES_SECONDARY_DAYS);
      const expiresMs = Date.now() + expiresInDays * 86400000;
      const ref = actionsCol(deviceId).doc();
      writeBatch.set(ref, {
        // legacy back-compat
        title: (ai.title || c.surprise_hook || "").slice(0, 32),
        text: (ai.text || "").slice(0, 96),
        why: (ai.proof_body || c.proof_text || "").slice(0, 140),
        trigger_reason: c.proof?.metric || "",
        when_to_do: c.when_to_do || "anytime",
        category: c.category || "general",
        priority: i === 0 ? "today" : "next",
        impact: c.impact || 2,
        status: "active",
        batch_key: batchKey,
        batch_kind: generationKind,
        generated_at: admin.firestore.FieldValue.serverTimestamp(),

        // v2
        agent: agentName,
        role,
        archetype: c.archetype,
        score: c.score,
        surprise_hook: ai.surprise_hook || c.surprise_hook,
        proof_body: ai.proof_body || c.proof_text,
        proof: c.proof,
        success_criterion: { type: c.success_type, target: c.target },
        success_criterion_text: ai.success_criterion_text || "",
        follow_up: ai.follow_up || "",
        expires_at: admin.firestore.Timestamp.fromMillis(expiresMs),
        snooze_count: 0,
        outcome_grade: null,
        outcome_value: null,
        outcome_surfaced: false,
      });
    }

    writeBatch.update(agentDocRef(deviceId), {
      last_action_batch_key: batchKey,
      last_action_batch_generated: admin.firestore.FieldValue.serverTimestamp(),
      last_weekly_focus: weeklyFocus,
      pending_action_generation: false,
      no_actions_reason: null,
      log_count_since_last_batch: 0,
    });

    await writeBatch.commit();
    return slots;
  } catch (e) {
    console.error(`[${agentName}] generateActionBatch:`, e);
    throw e;
  } finally {
    _generationLocks.delete(lockKey);
  }
}

// ════════════════════════════════════════════════════════════════
// OUTCOME GRADING (pluggable graders)
// ════════════════════════════════════════════════════════════════

/**
 * For each non-graded active/completed action, run the matching grader and
 * write outcome_grade if criterion is met or expired.
 *
 * @param {object} deps
 * @param {object} deps.graders - { [success_type]: async (deviceId, action, recentLogs) => {met, partial, value} }
 */
async function gradeActions(deps) {
  const { agentName, deviceId, actionsCol, logsCol, graders, admin, db } = deps;
  try {
    const snap = await actionsCol(deviceId)
      .where("status", "in", ["active", "completed"])
      .limit(20)
      .get();
    if (snap.empty) return;

    const wSnap = await logsCol(deviceId)
      .orderBy("logged_at", "desc")
      .limit(40)
      .get();
    const recentLogs = wSnap.docs.map(mapDoc);

    const batch = db().batch();
    let touched = 0;
    const now = Date.now();

    for (const doc of snap.docs) {
      const a = { id: doc.id, ...doc.data() };
      if (a.outcome_grade) continue;
      const sc = a.success_criterion;
      if (!sc) continue;
      const grader = graders[sc.type];
      const generatedMs = getMillis(a.generated_at);
      const expiresMs = getMillis(a.expires_at) || generatedMs + 7 * 86400000;
      const expired = now >= expiresMs;

      let met = false, partial = false, value = 0;
      if (grader) {
        try {
          const result = await grader(deviceId, a, recentLogs.filter(l => getMillis(l.logged_at) > generatedMs));
          met = !!result?.met;
          partial = !met && !!result?.partial;
          value = result?.value ?? 0;
        } catch (e) {
          console.error(`[${agentName}] grader ${sc.type}:`, e);
        }
      }

      if (met) {
        batch.update(doc.ref, {
          outcome_grade: "kept",
          outcome_value: value,
          graded_at: admin.firestore.FieldValue.serverTimestamp(),
        });
        touched++;
      } else if (expired && partial) {
        batch.update(doc.ref, {
          outcome_grade: "partial",
          outcome_value: value,
          graded_at: admin.firestore.FieldValue.serverTimestamp(),
        });
        touched++;
      } else if (expired) {
        batch.update(doc.ref, {
          outcome_grade: "abandoned",
          outcome_value: 0,
          graded_at: admin.firestore.FieldValue.serverTimestamp(),
        });
        touched++;
      }
    }
    if (touched > 0) await batch.commit();
  } catch (e) {
    console.error(`[${agentName}] gradeActions:`, e);
  }
}

// ════════════════════════════════════════════════════════════════
// RESPONSE SHAPE BUILDER (for GET /actions)
// ════════════════════════════════════════════════════════════════

function serializeAction(d) {
  return {
    ...d,
    generated_at: toIso(d.generated_at),
    expires_at: toIso(d.expires_at),
    completed_at: toIso(d.completed_at),
    skipped_at: toIso(d.skipped_at),
    graded_at: toIso(d.graded_at),
  };
}

async function buildResponseShape(deps) {
  const { agentName, deviceId, agentDocRef, actionsCol, logsCol, config = {} } = deps;
  const cfg = { ...DEFAULTS, ...config };
  const fSnap = await agentDocRef(deviceId).get();
  const fData = fSnap.exists ? fSnap.data() : {};
  const pending = fData.pending_action_generation || false;
  const weeklyFocus = fData.last_weekly_focus || "";
  const noActionsReason = fData.no_actions_reason || null;
  const logCount = fData.log_count_since_last_batch || 0;
  const progressToNext = logCount % cfg.BATCH_SIZE;

  const snap = await actionsCol(deviceId)
    .where("status", "in", ["active", "completed", "skipped"])
    .limit(80)
    .get();
  snap.docs.sort((a, b) => getMillis(b.data().generated_at) - getMillis(a.data().generated_at));
  const all = snap.docs.map(mapDoc);
  const batchKey = all.find(a => a.status === "active")?.batch_key || all[0]?.batch_key;
  const inBatch = batchKey ? all.filter(a => a.batch_key === batchKey) : all.slice(0, 4);

  const inBatchSerialized = inBatch.map(serializeAction);
  const active = inBatchSerialized.filter(a => a.status === "active");
  const completed = inBatchSerialized.filter(a => a.status === "completed");
  const skipped = inBatchSerialized.filter(a => a.status === "skipped");

  const spotlight = active.find(a => a.role === "spotlight") || null;
  const secondaries = active.filter(a => a.role === "secondary");
  const micro = active.find(a => a.role === "micro") || null;

  const allRecent = all.map(serializeAction);
  const ungrasped = allRecent.find(a => a.outcome_grade && !a.outcome_surfaced);
  const outcome_card = ungrasped ? {
    action_id: ungrasped.id,
    grade: ungrasped.outcome_grade,
    title: ungrasped.title,
    surprise_hook: ungrasped.surprise_hook || "",
    promised: ungrasped.success_criterion,
    delivered_value: ungrasped.outcome_value || 0,
    proof: ungrasped.proof,
    archetype: ungrasped.archetype,
    category: ungrasped.category,
  } : null;

  let sessionsUntilFirst = 0;
  if (!batchKey && !pending) {
    try {
      const cnt = (await logsCol(deviceId).count().get()).data().count;
      sessionsUntilFirst = Math.max(0, cfg.BATCH_SIZE - cnt);
    } catch {}
  }
  const sessionsUntilNext =
    active.length === 0 && completed.length > 0
      ? cfg.BATCH_SIZE - progressToNext
      : 0;

  const trackCutoff = Date.now() - 30 * 86400000;
  const recent30 = allRecent.filter(a => {
    const ms = a.generated_at ? new Date(a.generated_at).getTime() : 0;
    return ms >= trackCutoff;
  });
  const graded30 = recent30.filter(a => a.outcome_grade);
  const kept30 = recent30.filter(a => a.outcome_grade === "kept").length;

  return {
    agent: agentName,
    spotlight,
    secondaries,
    micro,
    outcome_card,
    weekly_focus: weeklyFocus,
    track_record: {
      total: graded30.length,
      kept: kept30,
      kept_rate: graded30.length ? Math.round((kept30 / graded30.length) * 100) : 0,
    },
    active,
    completed,
    skipped,
    meta: {
      batch_kind: inBatch[0]?.batch_kind || "pattern",
      generated_at: toIso(inBatch[0]?.generated_at),
      pending_generation: pending,
      progress_to_next_batch: progressToNext,
      sessions_until_first_batch: sessionsUntilFirst,
      sessions_until_next: sessionsUntilNext,
      no_actions_reason: noActionsReason,
    },
  };
}

// ════════════════════════════════════════════════════════════════
// ROUTE MOUNTING — wires all 6 endpoints onto an Express router
// ════════════════════════════════════════════════════════════════

function mountActionRoutes(router, deps) {
  const {
    agentName, agentDocRef, actionsCol, logsCol,
    computeCandidates, graders, openai, admin, db,
    setupSummary, recoveryGuard, config = {},
  } = deps;
  const cfg = { ...DEFAULTS, ...config };

  // Lazy enqueue
  const _enqueueLocks = new Map();
  function queueGeneration(deviceId, opts = {}) {
    const k = `${agentName}:${deviceId}`;
    const existing = _enqueueLocks.get(k);
    if (existing && Date.now() - existing.startedAt < cfg.STALE_GENERATION_MS) return;
    _enqueueLocks.set(k, { startedAt: Date.now() });

    agentDocRef(deviceId).update({ pending_action_generation: true }).catch(() => {});

    generateActionBatch({
      ...deps,
      deviceId,
      // Default to 'user_logged' so log-event hooks bypass the cooldown.
      // Callers explicitly pass 'setup' for first-time, 'cron'/'pattern_auto' for scheduled.
      generationKind: opts.generationKind || "user_logged",
    })
      .then(() => {
        _enqueueLocks.delete(k);
      })
      .catch((err) => {
        console.error(`[${agentName}] queueGeneration error:`, err);
        _enqueueLocks.delete(k);
        agentDocRef(deviceId).update({ pending_action_generation: false }).catch(() => {});
      });
  }

  // GET /actions — v2 shape
  router.get("/actions", async (req, res) => {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: "deviceId required" });
    try {
      const body = await buildResponseShape({
        agentName, deviceId, agentDocRef, actionsCol, logsCol, config: cfg,
      });
      return res.json(body);
    } catch (e) {
      console.error(`[${agentName}] GET /actions:`, e);
      return res.status(500).json({ error: "server error" });
    }
  });

  // GET /actions/history
  router.get("/actions/history", async (req, res) => {
    const { deviceId, range = "30" } = req.query;
    if (!deviceId) return res.status(400).json({ error: "deviceId required" });
    const rangeN = parseInt(range, 10) || 30;
    try {
      const cutoffMs = Date.now() - rangeN * 86400000;
      const snap = await actionsCol(deviceId)
        .orderBy("generated_at", "desc")
        .limit(150)
        .get();
      const all = snap.docs.map(mapDoc).filter(a => getMillis(a.generated_at) >= cutoffMs);
      const items = all.map(serializeAction);
      const graded = items.filter(a => a.outcome_grade);
      const kept = graded.filter(a => a.outcome_grade === "kept").length;
      const partial = graded.filter(a => a.outcome_grade === "partial").length;
      const abandoned = graded.filter(a => a.outcome_grade === "abandoned").length;

      const catCounts = {};
      for (const a of graded.filter(g => g.outcome_grade === "kept")) {
        const c = a.category || "general";
        catCounts[c] = (catCounts[c] || 0) + 1;
      }
      const mostKeptCategory = Object.entries(catCounts).sort(([, a], [, b]) => b - a)[0]?.[0] || null;

      return res.json({
        agent: agentName,
        range_days: rangeN,
        total: items.length,
        graded: graded.length,
        kept, partial, abandoned,
        kept_rate: graded.length ? Math.round((kept / graded.length) * 100) : 0,
        most_kept_category: mostKeptCategory,
        items,
      });
    } catch (e) {
      console.error(`[${agentName}] GET /actions/history:`, e);
      return res.status(500).json({ error: "server error" });
    }
  });

  // POST /action/:id/complete
  router.post("/action/:id/complete", async (req, res) => {
    const { id } = req.params;
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: "deviceId required" });
    try {
      await actionsCol(deviceId).doc(id).update({
        status: "completed",
        completed_at: admin.firestore.FieldValue.serverTimestamp(),
      });
      gradeActions({ agentName, deviceId, actionsCol, logsCol, graders, admin, db }).catch(() => {});
      return res.json({ success: true });
    } catch (e) {
      console.error(`[${agentName}] action complete:`, e);
      return res.status(500).json({ error: "server error" });
    }
  });

  // POST /action/:id/skip
  router.post("/action/:id/skip", async (req, res) => {
    const { id } = req.params;
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: "deviceId required" });
    try {
      await actionsCol(deviceId).doc(id).update({
        status: "skipped",
        skipped_at: admin.firestore.FieldValue.serverTimestamp(),
        outcome_grade: "abandoned",
      });
      return res.json({ success: true });
    } catch (e) {
      console.error(`[${agentName}] action skip:`, e);
      return res.status(500).json({ error: "server error" });
    }
  });

  // POST /action/:id/snooze
  router.post("/action/:id/snooze", async (req, res) => {
    const { id } = req.params;
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: "deviceId required" });
    try {
      const ref = actionsCol(deviceId).doc(id);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: "not found" });
      const data = snap.data();
      const snoozes = data.snooze_count || 0;
      if (snoozes >= cfg.MAX_SNOOZES) return res.status(400).json({ error: "max snoozes reached" });
      const cur = getMillis(data.expires_at) || Date.now() + 7 * 86400000;
      const newExp = Math.max(cur, Date.now()) + 3 * 86400000;
      await ref.update({
        expires_at: admin.firestore.Timestamp.fromMillis(newExp),
        snooze_count: snoozes + 1,
        snoozed_at: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.json({ success: true, new_expires_at: new Date(newExp).toISOString() });
    } catch (e) {
      console.error(`[${agentName}] action snooze:`, e);
      return res.status(500).json({ error: "server error" });
    }
  });

  // POST /action/:id/feedback
  router.post("/action/:id/feedback", async (req, res) => {
    const { id } = req.params;
    const { deviceId, helpful, note } = req.body;
    if (!deviceId) return res.status(400).json({ error: "deviceId required" });
    try {
      await actionsCol(deviceId).doc(id).update({
        feedback_helpful: typeof helpful === "boolean" ? helpful : null,
        feedback_note: note ? String(note).slice(0, 200) : null,
        feedback_at: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.json({ success: true });
    } catch (e) {
      console.error(`[${agentName}] action feedback:`, e);
      return res.status(500).json({ error: "server error" });
    }
  });

  // Return the queueGeneration helper so the agent can call it on log events
  return { queueGeneration, gradeActions: () => gradeActions({ agentName, deviceId: null, actionsCol, logsCol, graders, admin, db }) };
}

// ════════════════════════════════════════════════════════════════
// EXPORTS
// ════════════════════════════════════════════════════════════════
module.exports = {
  ARCHETYPES,
  SLOT_CONFIG,
  DEFAULTS,
  applyFilters,
  selectSlots,
  generateActionBatch,
  gradeActions,
  buildResponseShape,
  mountActionRoutes,
  // helpers (exported for agents that need them)
  getMillis,
  toIso,
  clamp,
  mapDoc,
};
