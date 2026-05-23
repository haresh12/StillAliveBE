'use strict';
// ════════════════════════════════════════════════════════════════
// PLAN AGENT — "Your 4-Week Personal Plan" generator.
//
// Powers the AHA moment between Personalize/Reveal and Paywall:
//   user speaks 30s → app sends transcript → BE returns structured
//   plan (5 sections) → FE renders beautifully → review prompt.
//
// Endpoint: POST /api/plan/generate
//   Body: { deviceId, voice_text?, language?, profile?, active_coaches[] }
//   Returns: { ok, plan: { fingerprint, voice_quotes, risks[], weeks[],
//                          tonight_one_thing, projected_30d, projected_90d } }
//
// Inputs the LLM gets:
//   1. Voice transcript (optional — if user spoke)
//   2. Profile (chronotype derived from rhythm + name)
//   3. Active coaches (which ones the user picked)
//   4. Locale (so the plan is generated natively in user's language)
//
// Why this endpoint exists separate from personalize:
//   • Different call signature (needs voice_text)
//   • Heavier LLM call (gpt-5.4 REASONING_PRO vs personalize's pure math)
//   • Cached separately — user gets ONE plan per install
// ════════════════════════════════════════════════════════════════

const express = require('express');
const router  = express.Router();
const admin   = require('firebase-admin');
const OpenAI  = require('openai');
const { AI }  = require('./lib/ai/models');
const {
  resolveLanguage,
  appendLanguageInstruction,
} = require('./lib/i18n-prompt');
const {
  deriveChronotype,
  deriveCaffeineCutoff,
  deriveWorkoutWindow,
  computeWaterTarget,
  computeCalories,
} = require('./lib/personalize-derive');

// Lazy OpenAI client — instantiated only when /generate is invoked.
// Lets module require succeed in test/CI environments without OPENAI_API_KEY.
let _openai = null;
function getOpenAI() {
  if (_openai) return _openai;
  if (!process.env.OPENAI_API_KEY) return null;
  _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}
const db = () => admin.firestore();
const userDoc = (id) => db().collection('wellness_users').doc(id);
const planDoc = (id) => userDoc(id).collection('plan').doc('v1');

// ─── Helpers ────────────────────────────────────────────────────
function shortQuote(text, max = 40) {
  if (!text || typeof text !== 'string') return '';
  const t = text.trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + '…';
}

// Extract "themes" from voice transcript using lightweight keyword bag.
// Cheap, deterministic — runs BEFORE the LLM call so we can tell the LLM
// "user mentioned stress" without burning tokens on classification.
function extractVoiceThemes(transcript = '') {
  const t = (transcript || '').toLowerCase();
  const themes = [];
  const checks = [
    { theme: 'sleep_short',  patterns: [/(\b|^)(tired|exhausted|drained|wiped|sleepy)\b/, /\b\d+\s*(hr|hours?)\b/, /barely.*sleep/, /can'?t sleep/, /didn'?t sleep/, /no sleep/] },
    { theme: 'stress_high',  patterns: [/\b(stress|anxious|anxiety|overwhelm|nervous|tense|panic|worried|burn(t|ed) out)\b/, /\b(deadline|pressure|crazy week)\b/] },
    { theme: 'fitness_off',  patterns: [/skipped (the )?gym/, /missed (a )?workout/, /didn'?t work out/, /haven'?t been to/, /no exercise/] },
    { theme: 'nutrition_off',patterns: [/junk food/, /ate (a lot|like crap|bad)/, /pizza|takeout|fast food/, /skipped meals?/, /no breakfast/] },
    { theme: 'mood_low',     patterns: [/\b(down|sad|low|depressed|blah|unmotivated|stuck)\b/] },
    { theme: 'hydration_off',patterns: [/no water/, /dehydrated/, /forget to drink/, /barely drink/] },
    { theme: 'work_pressure',patterns: [/\b(work|job|boss|presentation|client|deadline|project|meeting)\b/] },
  ];
  for (const c of checks) {
    if (c.patterns.some((re) => re.test(t))) themes.push(c.theme);
  }
  return themes;
}

// ─── Prompt builder ─────────────────────────────────────────────
function buildSystemPrompt(language) {
  const base = `You are the Wellness OS coach team. You generate a 4-week personalized plan.

OUTPUT RULES — ABSOLUTE:
1. Return STRICT JSON only. No prose outside JSON.
2. JSON shape:
{
  "fingerprint_line": "<one line ~12-18 words: their chronotype + key behavioral note>",
  "voice_insight": "<one line ~14-20 words referring to themes from their voice transcript, NEVER quote raw text>",
  "quick_wins": [
    { "emoji": "<single emoji>", "horizon": "30d", "text": "<short-term felt win, ~8-12 words. Things the user notices within weeks: sharper mornings, steadier afternoons, fewer crashes.>" },
    { "emoji": "<emoji>",        "horizon": "30d", "text": "<second short-term win, distinct sensory shift>" },
    { "emoji": "<emoji>",        "horizon": "90d", "text": "<long-term body change, ~8-12 words. Recovery, lower RHR, deeper sleep, stronger workouts.>" },
    { "emoji": "<emoji>",        "horizon": "90d", "text": "<second long-term win, distinct deep change>" }
  ],
  "risks": [
    { "title": "<3-6 word risk name>", "severity": "high|medium|low", "explain": "<one line ~16-22 words>" },
    { "title": "...", "severity": "...", "explain": "..." },
    { "title": "...", "severity": "...", "explain": "..." }
  ],
  "risk_remedy": "<one line ~12-18 words — concrete move the coach team makes to neutralize the TOP risk. Mention which coach.>",
  "weeks": [
    { "n": 1, "focus": "<2-4 word focus>", "action": "<one line ~10-16 words>", "score_delta": <integer 3-10> },
    { "n": 2, "focus": "...", "action": "...", "score_delta": <int> },
    { "n": 3, "focus": "...", "action": "...", "score_delta": <int> },
    { "n": 4, "focus": "...", "action": "...", "score_delta": <int> }
  ],
  "tonight_one_thing": "<one specific action they can do TONIGHT, 14-22 words. Include a time when possible.>",
  "tonight_why": "<one line ~14-20 words — the biological/behavioral REASON the tonight action works. Cite a mechanism, not a study ID.>",
  "tonight_supporting": [
    { "emoji": "<emoji>", "text": "<~10-14 words — a stackable supporting move for tonight that complements the main action>" },
    { "emoji": "<emoji>", "text": "..." },
    { "emoji": "<emoji>", "text": "..." }
  ],
  "personalised_by": [
    "<short tag, 2-4 words — e.g. '25-34 age group', '100kg · moderate', 'Bed at 11 PM', '7h sleep target', 'Build muscle goal'>",
    "<tag>",
    "<tag>"
  ]
}
3. AHA-LEVEL PERSONALIZATION IS NON-NEGOTIABLE. Every single one of these fields MUST cite at least one specific user fact by name or by number (NOT by general category):
     • fingerprint_line — combine chronotype + age group + gender + one body or activity fact
     • voice_insight — reference voice themes if present, else a coach-answer (stress trigger, fitness goal, sleep target, fasting protocol)
     • each risk.explain — cite an exact threshold (their bedtime in HH:MM, their weight in kg, their caffeine cutoff time, their sleep target hours, a triggered category they listed)
     • each week.action — cite the time, day, or quantity the user actually picked (bed_time, training_days count, sleep target_hours, nutrition goal, fasting protocol)
     • each quick_win — reference one derived target (caffeine cutoff, workout window, water target ml) or a coach-answer (fitness goal, sleep target)
     • tonight_one_thing — anchor a time relative to the user's actual bedtime; mention sleep target if known
     • tonight_why — cite a mechanism that references the user's bedtime, chronotype, or a trigger they named
     • tonight_supporting — each move ties to caffeine cutoff / hydration target / wake time / a disruptor they flagged
   The user must read each line and think "how did the app know THAT?" Generic wellness platitudes ("get more sleep", "stay hydrated", "manage stress") are FORBIDDEN.
4. NEVER include medical claims, diagnoses, or treatment language. Frame as "support" and "plan".
5. Be warm but punchy. Short lines. No fluff. No exclamation marks. Use 2nd person ("your", not "the user").
6. Brand terms stay English: Wellness Score, Hydration Score, Coach, Tracker. Everything else in the target language.
7. "personalised_by" — 2-4 short chip-style tags naming the user facts that drove this plan the most. These render verbatim on the FE so the user sees WHICH onboarding answers mattered. Examples: "25-34", "Female · 68kg", "Night owl · bed 23:30", "Build muscle · 4 days/wk", "16:8 fasting".`;
  return appendLanguageInstruction(base, language);
}

function buildUserPrompt({ name, ageGroup, gender, chronotype, activeCoaches, voiceThemes, voiceTranscript, derivedTargets, shared, coachAnswers }) {
  const safeQuote = shortQuote(voiceTranscript, 200);
  const sh = shared || {};
  const ca = coachAnswers || {};

  const facts = [];
  if (ageGroup)            facts.push(`age group ${ageGroup}`);
  if (gender)              facts.push(`gender ${gender}`);
  if (sh.weight_kg)        facts.push(`weight ${sh.weight_kg}kg`);
  if (sh.height_cm)        facts.push(`height ${sh.height_cm}cm`);
  if (sh.activity_level)   facts.push(`activity: ${sh.activity_level}`);
  if (sh.pregnancy)        facts.push(`pregnancy: ${sh.pregnancy}`);
  if (Number.isFinite(sh.wake_time_min)) facts.push(`wakes at ${Math.floor(sh.wake_time_min/60)}:${String(sh.wake_time_min%60).padStart(2,'0')}`);
  if (Number.isFinite(sh.bed_time_min))  facts.push(`bed at ${Math.floor(sh.bed_time_min/60)}:${String(sh.bed_time_min%60).padStart(2,'0')}`);

  const coachFacts = [];
  if (ca.sleep?.target_hours)         coachFacts.push(`Sleep: targets ${ca.sleep.target_hours}h`);
  if (Array.isArray(ca.sleep?.disruptors) && ca.sleep.disruptors.length)
    coachFacts.push(`Sleep disruptors: ${ca.sleep.disruptors.join('/')}`);
  if (Array.isArray(ca.mind?.triggers) && ca.mind.triggers.length)
    coachFacts.push(`Stress triggers: ${ca.mind.triggers.join('/')}`);
  if (ca.nutrition?.goal)             coachFacts.push(`Nutrition goal: ${ca.nutrition.goal}`);
  if (ca.nutrition?.dietary_style)    coachFacts.push(`Diet: ${ca.nutrition.dietary_style}`);
  if (ca.fitness?.training_level)     coachFacts.push(`Fitness level: ${ca.fitness.training_level}`);
  if (ca.fitness?.goal)               coachFacts.push(`Fitness goal: ${ca.fitness.goal}`);
  if (Array.isArray(ca.fitness?.training_days) && ca.fitness.training_days.length)
    coachFacts.push(`Trains: ${ca.fitness.training_days.join('/')}`);
  if (ca.fasting?.protocol)           coachFacts.push(`Fasting protocol: ${ca.fasting.protocol}`);

  return [
    `=== USER CONTEXT (every plan field below MUST cite at least one of these) ===`,
    `Name: ${name || '(none)'}`,
    `Age group: ${ageGroup || '(unknown)'}`,
    `Gender: ${gender || '(unknown)'}`,
    `Chronotype: ${chronotype}`,
    `Active coaches: ${(activeCoaches || []).join(', ') || 'none yet'}`,
    `--- Derived targets ---`,
    `Caffeine cutoff: ${derivedTargets.caffeineCutoff}`,
    `Workout window: ${derivedTargets.workoutWindow}`,
    `Daily water target: ${derivedTargets.waterMl}ml`,
    `--- Body & rhythm (onboarding) ---`,
    facts.length ? facts.join('\n') : '(none provided)',
    `--- Per-coach answers (onboarding) ---`,
    coachFacts.length ? coachFacts.join('\n') : '(none provided)',
    `--- Voice ---`,
    voiceThemes.length ? `Themes detected: ${voiceThemes.join(', ')}` : 'No voice provided.',
    safeQuote ? `Snippet (context only — NEVER quote literally): "${safeQuote}"` : '',
    '',
    `=== INSTRUCTIONS ===`,
    `Generate the plan JSON now. Every fingerprint_line, voice_insight, risk explain, week action, quick_win text, tonight_one_thing, tonight_why, and tonight_supporting entry MUST quote a specific number, time, or named selection from the context above. If you can't cite a fact, you're being too generic — rewrite. "personalised_by" should list the 2-4 strongest facts that shaped this plan, as short chips the user will recognize from their own answers.`,
  ].filter(Boolean).join('\n');
}

// ─── POST /api/plan/generate ────────────────────────────────────
router.post('/generate', async (req, res) => {
  try {
    const {
      deviceId,
      voice_text,
      language: bodyLang,
      profile: bodyProfile,
      active_coaches,
      shared,
    } = req.body || {};

    if (!deviceId || typeof deviceId !== 'string') {
      return res.status(400).json({ error: 'deviceId required' });
    }

    // Resolve language (body > header > accept-language > en)
    const language = (bodyLang && typeof bodyLang === 'string') ? bodyLang : resolveLanguage(req);

    // Hydrate profile + FULL personalize (shared + every coach sub-object)
    // from Firestore so the LLM has every onboarding answer to lean on.
    let firestoreProfile = {};
    let firestoreActiveCoaches = [];
    let firestoreShared = {};
    let firestoreCoachAnswers = {};
    try {
      const u = await userDoc(deviceId).get();
      const data = u.exists ? u.data() : {};
      firestoreProfile = {
        name:     data.name     || data.profile?.name     || '',
        ageGroup: data.ageGroup || data.profile?.ageGroup || data.age_group || '',
        gender:   data.gender   || data.profile?.gender   || '',
      };
      const personalize = await userDoc(deviceId).collection('personalize').doc('v1').get();
      if (personalize.exists) {
        const p = personalize.data();
        firestoreActiveCoaches = p.active_coaches || [];
        firestoreShared = p.shared || {};
        firestoreCoachAnswers = {
          sleep:     p.sleep     || {},
          mind:      p.mind      || {},
          nutrition: p.nutrition || {},
          fitness:   p.fitness   || {},
          water:     p.water     || {},
          fasting:   p.fasting   || {},
        };
      }
    } catch (e) {
      log.warn('[plan/generate] firestore hydrate failed:', e?.message);
    }

    const profile = { ...firestoreProfile, ...(bodyProfile || {}) };
    const activeCoaches = Array.isArray(active_coaches) && active_coaches.length
      ? active_coaches
      : firestoreActiveCoaches;
    const sharedMerged = { ...firestoreShared, ...(shared || {}) };
    const coachAnswers = firestoreCoachAnswers;

    const wake = Number.isFinite(sharedMerged.wake_time_min) ? sharedMerged.wake_time_min : 420;
    const bed  = Number.isFinite(sharedMerged.bed_time_min)  ? sharedMerged.bed_time_min  : 1380;
    const chronotype = deriveChronotype(wake);
    const derivedTargets = {
      caffeineCutoff: deriveCaffeineCutoff(bed),
      workoutWindow:  deriveWorkoutWindow(wake, bed),
      waterMl: computeWaterTarget({
        weight_kg: sharedMerged.weight_kg,
        activity:  sharedMerged.activity_level,
        climate:   'mild',
      }),
    };

    const voiceThemes = extractVoiceThemes(voice_text || '');
    const systemPrompt = buildSystemPrompt(language);
    const userPrompt = buildUserPrompt({
      name:     profile.name,
      ageGroup: profile.ageGroup,
      gender:   profile.gender,
      chronotype,
      activeCoaches,
      voiceThemes,
      voiceTranscript: voice_text,
      derivedTargets,
      shared:   sharedMerged,
      coachAnswers,
    });

    let planJson = null;
    const openai = getOpenAI();
    if (openai) {
      try {
        const completion = await openai.chat.completions.create({
          model: AI.REASONING_PRO,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt },
          ],
          response_format: { type: 'json_object' },
          max_completion_tokens: 1400,
        });
        const raw = completion.choices?.[0]?.message?.content || '{}';
        planJson = JSON.parse(raw);
      } catch (e) {
        log.warn('[plan/generate] LLM failed, using deterministic fallback:', e?.message);
        planJson = null;
      }
    }

    // Deterministic fallback so we NEVER show a broken plan even if LLM
    // fails. Every line below is templated to reference REAL onboarding
    // facts — weight, age group, gender, chronotype, sleep target, mind
    // triggers, fitness level/goal, fasting protocol — so the user feels
    // seen even when the LLM is offline.
    if (!planJson || !planJson.weeks) {
      // Compact helpers for fmtTime in BE context (24h notation, locale-agnostic).
      const fmt24 = (mins) => Number.isFinite(mins) ? `${String(Math.floor(mins/60)).padStart(2,'0')}:${String(mins%60).padStart(2,'0')}` : null;
      const bedTxt  = fmt24(bed);
      const wakeTxt = fmt24(wake);

      // Best-effort plain-English nouns from onboarding selections.
      const chronoNoun = chronotype === 'early' ? 'early-bird' : chronotype === 'evening' ? 'night owl' : 'steady-rhythm';
      const sleepTarget = coachAnswers?.sleep?.target_hours;
      const fitnessLevel= coachAnswers?.fitness?.training_level;
      const fitnessGoal = coachAnswers?.fitness?.goal;
      const trainingDays= Array.isArray(coachAnswers?.fitness?.training_days) ? coachAnswers.fitness.training_days.length : null;
      const mindTriggers= Array.isArray(coachAnswers?.mind?.triggers) ? coachAnswers.mind.triggers : [];
      const nutritionGoal= coachAnswers?.nutrition?.goal;
      const fastingProto = coachAnswers?.fasting?.protocol;
      const sleepDisruptors = Array.isArray(coachAnswers?.sleep?.disruptors) ? coachAnswers.sleep.disruptors : [];

      // Pick the most-cited mind trigger to name explicitly in the risk line.
      const mainTrigger = mindTriggers[0];

      // Risks — only show ones the user's own data supports.
      const risksDyn = [];
      if (Number.isFinite(sharedMerged.bed_time_min)) {
        risksDyn.push({ title: 'Bedtime drift', severity: 'medium',
          explain: `Your ${bedTxt} target slips when work spills late — every 30 min drift costs ~15 min of deep sleep.` });
      }
      if (sharedMerged.weight_kg && (sharedMerged.activity_level === 'moderate' || sharedMerged.activity_level === 'active')) {
        risksDyn.push({ title: 'Under-hydration', severity: 'medium',
          explain: `At ${sharedMerged.weight_kg}kg with ${sharedMerged.activity_level} activity, target ${derivedTargets.waterMl}ml. Most days you're 500-800ml short.` });
      } else if (sharedMerged.weight_kg) {
        risksDyn.push({ title: 'Hydration gap', severity: 'medium',
          explain: `At ${sharedMerged.weight_kg}kg, target ${derivedTargets.waterMl}ml/day — easy to miss without prompts.` });
      }
      if (mainTrigger) {
        risksDyn.push({ title: `${mainTrigger.replace(/_/g, ' ')} spikes`, severity: 'medium',
          explain: `You named ${mainTrigger.replace(/_/g, ' ')} as a stress trigger — these silently shorten recovery by 8-12%.` });
      }
      if (risksDyn.length < 3) {
        risksDyn.push({ title: 'Caffeine timing', severity: 'low',
          explain: `Caffeine past ${derivedTargets.caffeineCutoff} fragments deep sleep — half-life is ~6h for ${profile.gender || 'most'} adults.` });
      }

      // Weeks — each focus/action references a real onboarding answer.
      const weeksDyn = [
        { n: 1, focus: 'Lock your bedtime',
          action: `Lights-out at ${bedTxt || '22:00'} ± 30 min, ${sleepTarget ? `targeting your ${sleepTarget}h` : 'targeting full'} sleep.`,
          score_delta: 8 },
        { n: 2, focus: 'Caffeine line',
          action: `Last caffeine by ${derivedTargets.caffeineCutoff}${sleepDisruptors.includes('caffeine') ? ' — you flagged this as a disruptor.' : '.'}`,
          score_delta: 6 },
        { n: 3, focus: mainTrigger ? `${mainTrigger.replace(/_/g, ' ')} reset` : 'Daily reset',
          action: mainTrigger
            ? `One 90-sec breath break each ${mainTrigger.replace(/_/g, ' ')} window — pre-empts the spike.`
            : 'One 90-sec breath break before noon.',
          score_delta: 9 },
        { n: 4, focus: fitnessGoal ? `${fitnessGoal} push` : 'Smart fitness',
          action: trainingDays
            ? `Layer recovery on ${7 - trainingDays} non-training days — preserves ${fitnessGoal || 'progress'}.`
            : `Replace one heavy day with a 20-min reset${fitnessLevel ? ` — fits ${fitnessLevel} level.` : '.'}`,
          score_delta: 7 },
      ];

      // Tonight action — anchored to the user's actual bedtime, not a hardcoded hour.
      const windDownMin = Number.isFinite(bed) ? Math.max(0, bed - 60) : (chronotype === 'evening' ? 22 * 60 + 30 : 21 * 60 + 30);
      const tonightAt   = fmt24(windDownMin);

      planJson = {
        fingerprint_line: profile.gender && profile.ageGroup
          ? `${profile.gender} · ${profile.ageGroup} · ${chronoNoun} — your body wants ${chronotype === 'early' ? 'an early start' : chronotype === 'evening' ? 'a late peak' : 'a steady day'}.`
          : `${chronoNoun.charAt(0).toUpperCase() + chronoNoun.slice(1)} rhythm — your body wants ${chronotype === 'early' ? 'an early start' : chronotype === 'evening' ? 'a late peak' : 'a steady day'}.`,
        voice_insight: voiceThemes.length
          ? `We heard signals around ${voiceThemes.slice(0, 2).join(' and ').replace(/_/g, ' ')} — Coach will lean in here first.`
          : (mainTrigger ? `We will track ${mainTrigger.replace(/_/g, ' ')} closely — you flagged it in setup.` : 'We will learn your patterns as you log.'),
        quick_wins: [
          { emoji: '🧠', horizon: '30d', text: sleepTarget
              ? `Sharper mornings — your ${sleepTarget}h target finally holds.`
              : `Sharper mornings within 2 weeks.` },
          { emoji: '⚡', horizon: '30d', text: `Steadier afternoon energy as caffeine clears by ${derivedTargets.caffeineCutoff}.` },
          { emoji: '💪', horizon: '90d', text: fitnessGoal
              ? `Real progress on ${fitnessGoal} — ${trainingDays || 3} sessions a week start compounding.`
              : 'Stronger workouts — recovery feels easier.' },
          { emoji: '❤️', horizon: '90d', text: sharedMerged.weight_kg
              ? `Lower resting heart rate at ${sharedMerged.weight_kg}kg — body finally rests.`
              : 'Lower resting heart rate — your body finally rests.' },
        ],
        risks: risksDyn.slice(0, 3),
        risk_remedy: `Sleep Coach locks a ${bedTxt || '22:00'} wind-down and pings if you drift more than 20 min.`,
        weeks: weeksDyn,
        tonight_one_thing: `At ${tonightAt || '21:30'}, dim screens and put your phone outside the bedroom${sleepTarget ? ` — protects your ${sleepTarget}h target` : ''}.`,
        tonight_why: `Your body needs ~90 min of dim light before ${bedTxt || 'bed'} to release melatonin. Bright screens delay it by up to 40 min.`,
        tonight_supporting: [
          { emoji: '☕', text: `No caffeine after ${derivedTargets.caffeineCutoff} — protects tonight's deep sleep.` },
          { emoji: '💧', text: sharedMerged.weight_kg
              ? `Hit ${derivedTargets.waterMl}ml total today (you're ${sharedMerged.weight_kg}kg) — stay hydrated without 3 AM trips.`
              : 'Last sip of water by 8 PM — keeps you hydrated without 3 AM trips.' },
          { emoji: '⏰', text: wakeTxt
              ? `Set alarm for ${wakeTxt} — anchoring your wake time matters more than bedtime.`
              : 'Anchor wake time — matters more than bedtime.' },
        ],
        // Personalisation tags pulled directly from the strongest onboarding
        // signals — these render as chips on each FE card so the user sees
        // exactly WHICH of their answers shaped the AI's output.
        personalised_by: [
          profile.ageGroup        && `Age ${profile.ageGroup}`,
          profile.gender          && `${profile.gender}`,
          sharedMerged.weight_kg  && `${sharedMerged.weight_kg}kg`,
          sharedMerged.activity_level && `${sharedMerged.activity_level} activity`,
          chronotype              && `${chronotype} rhythm`,
          bedTxt                  && `Bed ${bedTxt}`,
          sleepTarget             && `${sleepTarget}h sleep target`,
          fitnessGoal             && `Goal: ${fitnessGoal}`,
          fitnessLevel            && `${fitnessLevel} level`,
          mainTrigger             && `Trigger: ${mainTrigger.replace(/_/g, ' ')}`,
          nutritionGoal           && `Nutrition: ${nutritionGoal}`,
          fastingProto            && `Fasting: ${fastingProto}`,
        ].filter(Boolean).slice(0, 4),
      };
    }

    // Compose final response.
    // Wellness Score climb is deterministic per active-coach count so the
    // Forecast card always reads the same story arc:
    //   6 coaches → 12 today → 65 in 30 days → 92 in 90 days
    //   N coaches → N*2       → round(N*65/6)   → round(N*92/6)
    // (LLM week deltas are kept for future plan UI but no longer drive
    // the projection numbers — too much variance read as untrustworthy.)
    const N = (activeCoaches || []).length;
    const baselineScore = N * 2;
    const projected30   = Math.min(95, Math.round(N * 65 / 6));
    const projected90   = Math.min(94, Math.round(N * 92 / 6));
    const plan = {
      fingerprint_line: planJson.fingerprint_line,
      voice_insight:    planJson.voice_insight,
      derived: {
        chronotype,
        caffeine_cutoff: derivedTargets.caffeineCutoff,
        workout_window:  derivedTargets.workoutWindow,
        water_target_ml: derivedTargets.waterMl,
      },
      voice_themes_detected: voiceThemes,
      quick_wins:       Array.isArray(planJson.quick_wins) ? planJson.quick_wins.slice(0, 4) : [],
      risks:            planJson.risks || [],
      risk_remedy:      planJson.risk_remedy || '',
      weeks:            planJson.weeks || [],
      tonight_one_thing:  planJson.tonight_one_thing,
      tonight_why:        planJson.tonight_why || '',
      tonight_supporting: Array.isArray(planJson.tonight_supporting) ? planJson.tonight_supporting.slice(0, 3) : [],
      personalised_by:    Array.isArray(planJson.personalised_by) ? planJson.personalised_by.filter((x) => typeof x === 'string' && x.trim()).slice(0, 4) : [],
      projected_30d:    projected30,
      projected_90d:    projected90,
      starting_score:   baselineScore,
      generated_at:     admin.firestore.FieldValue.serverTimestamp(),
      language,
    };

    // Cache to Firestore (one plan per user — overwrites if re-generated)
    try {
      await planDoc(deviceId).set(plan, { merge: true });
    } catch (e) {
      log.warn('[plan/generate] firestore write failed:', e?.message);
    }

    return res.json({ ok: true, plan });
  } catch (e) {
    log.error('[plan/generate]', e);
    return res.status(500).json({ error: 'plan_failed', message: String(e?.message || e) });
  }
});

// ─── GET /api/plan/get/:deviceId ────────────────────────────────
// Fetch cached plan — used if FE re-enters the flow.
router.get('/get/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    const snap = await planDoc(deviceId).get();
    if (!snap.exists) return res.json({ ok: true, plan: null });
    return res.json({ ok: true, plan: snap.data() });
  } catch (e) {
    log.error('[plan/get]', e);
    return res.status(500).json({ error: 'fetch_failed' });
  }
});

module.exports = router;
