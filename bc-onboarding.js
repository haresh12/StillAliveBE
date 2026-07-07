'use strict';
// ═══════════════════════════════════════════════════════════════
// bc-onboarding.js — big-change onboarding persistence.
//
// Mounted at /api/bc/onboarding.
//   POST /complete  → creates the user in wellness_bc_users/{deviceId} and stores
//                     the full onboarding profile in wellness_bc_onboarding/{deviceId}.
//                     Idempotent: re-running merges, createdAt is set once.
//   GET  /health    → liveness + which namespace is active.
//
// This is where the user is CREATED. Selected focus domains are the agents the user
// unlocked. Reminder times / equipment / schedules are NOT collected here — they are
// smart-defaulted and tuned in-context later (see BIG_CHANGE_MASTER_PLAN §5).
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const { userDoc, onboardingDoc, DATA_NAMESPACE } = require('./lib/collections');
const { dateStr } = require('./lib/range-helpers');
const { parsePlanImage } = require('./lib/workout-plan-parser');
const { resolveLanguage } = require('./lib/i18n-prompt'); // body.language → X-User-Language → Accept-Language → en

const FieldValue = admin.firestore.FieldValue;
const serverTimestamp = () => FieldValue.serverTimestamp();

router.post('/complete', async (req, res) => {
  try {
    const { deviceId, profile } = req.body || {};
    const id = String(deviceId || '').trim();
    if (!id) {
      return res.status(400).json({ error: 'deviceId required' });
    }
    if (!profile || typeof profile !== 'object') {
      return res.status(400).json({ error: 'profile required' });
    }

    const focus = Array.isArray(profile.focus_domains)
      ? profile.focus_domains
      : [];
    // The FE sends per-domain goals (fitness_goal/nutrition_goal/mind_focus), not a unified list —
    // so derive `goals` from them when an explicit one isn't provided, keeping the user doc's
    // goals/primary_goal meaningful (used in copy + agent setup fallbacks).
    const asArr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
    // New onboarding sends `needs` (chosen outcomes) + derived fitness/nutrition goals. Fold them all
    // in so the user-doc goals/primary_goal stay meaningful even though we ask fewer questions.
    const goals = Array.isArray(profile.goals) && profile.goals.length
      ? profile.goals
      : profile.primary_goal
        ? [profile.primary_goal]
        : [...new Set([...asArr(profile.needs), ...asArr(profile.fitness_goal), ...asArr(profile.nutrition_goal), ...asArr(profile.mind_focus)])];

    // All the doc writes below are independent (different docs) — we accumulate them into ONE Firestore
    // batch and commit a SINGLE round-trip at the end. Previously these were 8 sequential awaited .set()
    // calls (≈9 round-trips incl. the read), which is why onboarding "Save" hung ~10–15s on a warm-but-far
    // Fly↔Firestore hop (and worse on a cold machine). Only the read below stays sequential (needed for the
    // registration anchor). Batch stays well under Firestore's 500-op limit.
    const batch = admin.firestore().batch();

    // 1) Full onboarding answers.
    batch.set(onboardingDoc(id),
      {
        deviceId: id,
        ...profile,
        completedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    // 2) The user — created here. createdAt set once.
    const snap = await userDoc(id).get();
    const existing = snap.exists ? snap.data() : null;
    // 🚨 P1 REGISTRATION ANCHOR: stamp the registration day ONCE so EVERY window/score/journey/streak
    // clamps to signup. A user who registers today sees only today's data on any range (1W/1M/3M/1Y) —
    // never days before they existed; a user 5 months in sees the real trailing window. resolveAnchor
    // reads registration_date (local-TZ YYYY-MM-DD) + registration_tz_offset. NEVER overwrite an existing
    // value (idempotent). This is the exact stamp the legacy /wellness/signup does (server.js:839-859) —
    // bc onboarding was missing it, which is why a new user got a full unclamped 30-day window + penalty.
    const regTz = Number.isFinite(existing?.registration_tz_offset)
      ? existing.registration_tz_offset
      : Number.isFinite(profile.utc_offset_minutes)
        ? profile.utc_offset_minutes
        : -(new Date().getTimezoneOffset());
    const userPatch = {
      deviceId: id,
      name: profile.name || null,
      coach_id: profile.coach_id || existing?.coach_id || 'ava', // chosen coach personality
      coach_name: profile.coach_name || existing?.coach_name || 'Ava', // drives voice/chat persona + call name
      goals, // everything the user wants to change
      primary_goal: goals[0] || null, // first = primary, for copy/derivations
      focus_domains: focus, // the agents the user unlocked
      target_weight_kg: profile.target_weight_kg || null,
      targets: profile.targets || null, // computed daily kcal/protein/water
      // Previously asked-but-dropped — now persisted + queryable (sleep coach, briefing, notifications).
      sleep_schedule: { bedtime: profile.sleep_bedtime || null, wake: profile.sleep_wake || null },
      reminder_time: profile.reminder_time || existing?.reminder_time || null,
      // Accept a real boolean OR the string 'true'/'false' the FE step sends — coerce so the
      // user's onboarding notification choice actually reaches the canonical field the crons read.
      notifications_enabled: (() => {
        const v = profile.notifications_enabled;
        if (typeof v === 'boolean') return v;
        if (v === 'true') return true;
        if (v === 'false') return false;
        return existing?.notifications_enabled ?? null;
      })(),
      registration_date: existing?.registration_date || dateStr(new Date(), regTz),
      registration_tz_offset: regTz,
      // IANA zone (e.g. "America/Los_Angeles") — DST-correct local-time scheduling for daily report /
      // quiet hours / proactive timing. Offset alone drifts across DST; the zone doesn't.
      timezone: profile.timezone || existing?.timezone || null,
      // Selected UI/LLM language (en/de/es/fr/pt/ru). Canonical in-namespace source so bc agents +
      // background/cron work resolve the user's language without reaching into legacy collections.
      language: (() => {
        const l = String(profile.language || existing?.language || resolveLanguage(req) || 'en').slice(0, 2).toLowerCase();
        return ['en', 'de', 'es', 'fr', 'pt', 'ru'].includes(l) ? l : 'en';
      })(),
      onboarding_complete: true,
      updatedAt: serverTimestamp(),
    };
    if (!snap.exists) {
      userPatch.createdAt = serverTimestamp();
    }
    batch.set(userDoc(id), userPatch, { merge: true });

    // 3) Initialise the FITNESS agent doc so it ALWAYS exists before the first log. Without this,
    //    the very first /log (and action generation, readiness, etc.) call `.update()` on a doc
    //    that doesn't exist yet → Firestore NOT_FOUND. We seed a minimal setup mapped from the
    //    onboarding goal (legacy /setup defaults for everything else) so every reader of setup.*
    //    gets sane values and analysis never blocks. Idempotent (merge).
    const fitnessSetup = {
      primary_goal: profile.fitness_goal || profile.primary_goal || goals[0] || 'general',
      training_level: 'beginner',
      preferred_split: 'none',
      training_days: [],
      gym_time: '07:00',
      supplements: [],
      baseline_lifts: { bench_press: 60, squat: 80, deadlift: 100 },
      equipment: 'full_gym',
      injury_notes: 'none',
      days_per_week: 3,
    };
    batch.set(userDoc(id).collection('agents').doc('fitness'),
        { setup: fitnessSetup, setup_completed: true, created_at: serverTimestamp() },
        { merge: true },
      );

    // 4) Initialise the NUTRITION agent doc (mirrors fitness) so the first meal log / analysis never
    //    hits a missing doc. Targets come straight from onboarding (computeTargets → {calories,
    //    protein, water}). Stored at TOP LEVEL of the doc to match the shape the shared
    //    nutrition-analytics reader expects (setup.calorie_target etc.). carb/fat derived from a
    //    standard split. Idempotent (merge).
    const t = profile.targets || {};
    const cal = Number(t.calories) > 0 ? Math.round(Number(t.calories)) : 2000;
    const prot = Number(t.protein) > 0 ? Math.round(Number(t.protein)) : 140;
    const fat_target = Math.round((cal * 0.27) / 9); // ~27% of calories from fat
    const carb_target = Math.max(0, Math.round((cal - prot * 4 - fat_target * 9) / 4)); // remainder → carbs
    const water_cups = Number(t.water) > 0 ? Math.max(4, Math.round(Number(t.water) / 0.25)) : 8;
    batch.set(userDoc(id).collection('agents').doc('nutrition'),
        {
          calorie_target: cal,
          protein_target: prot,
          carb_target,
          fat_target,
          water_target_cups: water_cups,
          primary_goal: (Array.isArray(profile.nutrition_goal) ? profile.nutrition_goal[0] : profile.nutrition_goal) || goals[0] || 'healthier',
          dietary_style: 'no_restrictions',
          allergies: [],
          streak: 0,
          setup_completed: true,
          created_at: serverTimestamp(),
        },
        { merge: true },
      );

    // 5) Initialise the SLEEP agent doc (mirrors fitness/nutrition) so the first sleep log / analysis
    //    never hits a missing doc. Targets from onboarding (sleep hours/bedtime). Stored BOTH top-level
    //    AND nested setup.* because legacy sleep-analytics reads target from setup.target_hours.
    const targetSleepHours = Number(t.sleep_hours) > 0 ? Number(t.sleep_hours) : 8;
    const targetBedtime = profile.target_bedtime || profile.sleep_bedtime || '23:00';
    const targetWake = profile.target_wake || profile.sleep_wake || '07:00'; // was asked but dropped — now used
    batch.set(userDoc(id).collection('agents').doc('sleep'),
        {
          target_sleep_hours: targetSleepHours,
          target_bedtime: targetBedtime,
          target_wake: targetWake,
          setup: { target_hours: targetSleepHours, target_bedtime: targetBedtime, target_wake: targetWake }, // legacy-analytics compat
          primary_goal: (Array.isArray(profile.sleep_goal) ? profile.sleep_goal[0] : profile.sleep_goal) || goals[0] || 'sleep_better',
          streak: 0,
          setup_completed: true,
          created_at: serverTimestamp(),
        },
        { merge: true },
      );

    // 6) Initialise the FASTING agent doc so the first session / analysis never hits a missing doc.
    //    Protocol → target fast hours (e.g. 16:8 → 16). Stored under setup.* (matches the bc agent's getTarget).
    const fastingProtocol = profile.fasting_protocol || profile.protocol || '16:8';
    const protoHours = { '12:12': 12, '14:10': 14, '16:8': 16, '18:6': 18, '20:4': 20, 'omad': 23, '5:2': 16 };
    const targetFastHours = Number(protoHours[fastingProtocol]) || 16;
    batch.set(userDoc(id).collection('agents').doc('fasting'),
        {
          setup: { protocol: fastingProtocol, target_fast_hours: targetFastHours },
          target_fast_hours: targetFastHours,
          current_streak: 0,
          longest_streak: 0,
          total_sessions_completed: 0,
          active_session_id: null,
          setup_completed: true,
          created_at: serverTimestamp(),
        },
        { merge: true },
      );

    // 7) Initialise the WATER agent doc so the first log / analysis never hits a missing doc.
    //    daily_goal_ml from onboarding water target (liters → ml), clamped to a sane range.
    const waterGoalMl = Number(t.water) > 0 ? Math.min(6000, Math.max(1000, Math.round((Number(t.water) * 1000) / 50) * 50)) : 2500;
    batch.set(userDoc(id).collection('agents').doc('water'),
        {
          setup: { daily_goal_ml: waterGoalMl, recommended_goal_ml: waterGoalMl, activity_level: profile.activity_level || 'moderate', climate: profile.climate || 'temperate', weight_kg: Number(profile.weight_kg) || null },
          daily_goal_ml: waterGoalMl,
          current_streak: 0,
          longest_streak: 0,
          setup_completed: true,
          created_at: serverTimestamp(),
        },
        { merge: true },
      );

    // 8) Initialise the MIND/MOOD agent doc so the first check-in / analysis never hits a missing doc.
    batch.set(userDoc(id).collection('agents').doc('mind'),
        {
          setup: { reminder_time_min: 20 * 60 },
          checkin_count: 0,
          current_streak: 0,
          longest_streak: 0,
          setup_completed: true,
          created_at: serverTimestamp(),
        },
        { merge: true },
      );

    // 9) Initialise the BREATH agent doc (7th agent) so the first session / analysis never hits a
    // missing doc. Moment-first breathwork; defaults are neutral — the app picks a moment each time.
    batch.set(userDoc(id).collection('agents').doc('breath'),
        {
          setup: { daily_target_minutes: 5, week_day_target: 4 },
          session_count: 0,
          last_moment: null,
          setup_completed: true,
          created_at: serverTimestamp(),
        },
        { merge: true },
      );

    // ONE commit for all 9 writes — the single network hop that replaces the old sequential ones.
    await batch.commit();
    // Bust the 5-min anchor cache so the FIRST post-onboarding /analysis sees the fresh anchor.
    try { require('./lib/user-anchor').invalidateAnchor(id); } catch { /* non-fatal */ }
    // Bust the voice briefing cache too: profile/body metrics/goals are voice-critical and should be
    // reflected in the very next call, not after the short prewarm TTL expires.
    try { require('./lib/voice-realtime').invalidateBriefing(id); } catch { /* non-fatal */ }

    // Return the registration anchor so the FE can seed AsyncStorage('registrationDate') at
    // onboarding completion — the day-one-value SSoT that streaks/widgets/scoring clamp to.
    return res.json({ ok: true, deviceId: id, focus, namespace: DATA_NAMESPACE, registration_date: userPatch.registration_date, anchor_date: userPatch.registration_date });
  } catch (e) {
    if (globalThis.log && globalThis.log.error) {
      globalThis.log.error('[bc-onboarding] complete failed', e);
    } else {
      console.error('[bc-onboarding] complete failed', e);
    }
    return res.status(500).json({ error: 'internal_error' });
  }
});

// Store an uploaded workout-plan photo on the fitness agent doc so the Plans tab / coach can use it.
// Capped well under Firestore's ~1MB doc limit (the FE downscales to ~1000px first).
router.post('/workout-plan', async (req, res) => {
  try {
    const id = String((req.body && (req.body.deviceId || req.body.device_id)) || '').trim();
    const b64 = req.body && req.body.image_b64;
    if (!id || !b64) return res.status(400).json({ error: 'deviceId + image_b64 required' });
    // Turn the PHOTO into a real weekly plan (Gemini, same proven path as the chat upload). We do NOT
    // store the raw image — only the parsed text + structured days. The image was the whole problem: a
    // base64 photo can exceed Firestore's ~1MB doc limit, which is why large uploads 413'd. The parsed
    // plan is tiny, so any photo size now works. Return the days so the app shows a clean review.
    const result = await parsePlanImage(String(b64), req.body.mime || 'image/jpeg');
    if (!result || !result.text) {
      return res.json({ ok: true, parsed: null, days: [] }); // not a plan / unreadable → FE offers retry
    }
    // Map the parsed day labels → the SAME {dow, day_name, exercises} shape the in-chat upload returns,
    // so onboarding reuses the identical editable review card + confirm→templates flow (one consistent
    // flow everywhere). Weekday-named days claim their slot; split/numbered days fill the rest Mon→Sun.
    const DOW = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6 };
    const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const used = new Set();
    const planned = [];
    for (const d of result.days) {
      const dow = DOW[String(d.day || '').trim().toLowerCase()];
      if (dow != null && !used.has(dow)) { used.add(dow); planned.push({ dow, day_name: DAY_FULL[dow], label: d.day, exercises: d.exercises }); }
    }
    const leftover = result.days.filter((d) => DOW[String(d.day || '').trim().toLowerCase()] == null);
    const free = [1, 2, 3, 4, 5, 6, 0].filter((x) => !used.has(x));
    leftover.forEach((d, i) => { if (i < free.length) { const dow = free[i]; planned.push({ dow, day_name: DAY_FULL[dow], label: d.day, exercises: d.exercises }); } });
    planned.sort((a, b) => [1, 2, 3, 4, 5, 6, 0].indexOf(a.dow) - [1, 2, 3, 4, 5, 6, 0].indexOf(b.dow));

    await userDoc(id).collection('agents').doc('fitness').set(
      {
        uploaded_plan: { parsed: result.text, days: planned, uploaded_at: serverTimestamp() },
        has_uploaded_plan: true,
      },
      { merge: true },
    );
    return res.json({ ok: true, parsed: result.text, days: planned });
  } catch (e) {
    console.error('[bc-onboarding] workout-plan failed', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// Save the user's CONFIRMED / EDITED plan text (after they review the parsed version).
router.post('/workout-plan/confirm', async (req, res) => {
  try {
    const id = String((req.body && (req.body.deviceId || req.body.device_id)) || '').trim();
    const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
    if (!id) return res.status(400).json({ error: 'deviceId required' });
    await userDoc(id).collection('agents').doc('fitness').set(
      { uploaded_plan: { parsed: text }, has_uploaded_plan: !!text },
      { merge: true },
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error('[bc-onboarding] workout-plan confirm failed', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /timezone — keep the user's CURRENT timezone fresh (called on app open). This is travel-aware:
// it updates `current_tz_offset`/`current_timezone` ONLY and NEVER touches `registration_tz_offset` or
// `registration_date` (the frozen anchor the scoring law depends on). Time-of-day logic (coach reach-out
// hours, etc.) prefers current_tz_offset so calls land at the right local hour even if the user travels.
router.post('/timezone', async (req, res) => {
  const { deviceId } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  const off = req.body.utc_offset_minutes;
  if (!Number.isFinite(off) || off < -840 || off > 840) return res.status(400).json({ error: 'utc_offset_minutes out of range' });
  try {
    await userDoc(deviceId).set({
      current_tz_offset: off,
      current_timezone: typeof req.body.timezone === 'string' ? req.body.timezone.slice(0, 64) : null,
      tz_updated_at: serverTimestamp(),
    }, { merge: true });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'tz update failed' });
  }
});

router.get('/health', (req, res) =>
  res.json({ ok: true, namespace: DATA_NAMESPACE }),
);

module.exports = router;
