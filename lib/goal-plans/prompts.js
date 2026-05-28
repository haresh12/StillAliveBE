'use strict';
// ════════════════════════════════════════════════════════════════════════
// prompts.js — LLM prompt builders for Plans v2.
//
// Four builders, one per AI step. Each returns { systemPrompt, userPrompt }
// strings consumed by runWithFallback() in ai.js.
//
//   buildRouteGoalPrompt(opts)        → step 1, classify goal into coaches
//   buildComposeQuestionsPrompt(opts) → step 2, build cross-domain Qs
//   buildProposeNamePrompt(opts)      → step 3, propose plan title (P4)
//   buildComposePlanBatchPrompt(opts) → step 4, generate one 7-day batch (P3)
// ════════════════════════════════════════════════════════════════════════

const TAXONOMY = require('./taxonomy');

// ─── COACH_VOICE — the single source of truth for tone ─────────────────
// Prepended to every plan-generation prompt. The user pays this app to
// feel like a world-class coach, not a wellness blog. Every word must
// earn its place; numbers and mechanisms win over prose.
const COACH_VOICE = `VOICE & TONE (applies to every field you produce):
You are the world's best wellness coach — the kind who barely speaks, but when he does, drops a stat or mechanism nobody can ignore. Insight, not explanation.

Hard rules for every string field:
1. LEAD with a number, mechanism, or concrete action. "Hit 110g protein" not "Try to eat more protein". "Wake at 7:00 sharp — sets melatonin 14h later" not "Wake up consistently to help your body clock."
2. CUT every filler word. No "you'll find that", "it's important to", "remember that", "try to", "make sure you", "consistency is key", "you got this", "stay strong", "you can do it".
3. Short sentences. If you can say it in 8 words, don't use 20.
4. Specific over generic. "20-min Zone-2 walk after lunch (heart rate <130)" not "go for a walk".
5. Cite the BODY impact, not the abstract benefit. "Spikes BDNF for 4h" not "good for your brain."
6. No emoji. No exclamation marks. No motivational posters.
7. Treat the user like a smart adult who wants insight, not encouragement.`;

const COACH_SCOPE = {
  fitness:   'workouts, strength training, cardio, mobility, step count, steps after meals',
  nutrition: 'food intake, calories, protein, fiber, sugar, hydration through food, meal timing',
  mind:      'stress, anxiety, mood, journaling, focus, gratitude, breath work',
  sleep:     'sleep duration, wind-down routines, bedtime, wake time, screens before bed',
  water:     'plain water intake, hydration tracking, drink-with-meal cues',
  fasting:   'intermittent fasting windows, eating-window timing, refeed quality',
};

const LOCALES = ['en', 'es', 'fr', 'de', 'pt', 'ru'];

function _safeLocale(locale) {
  const l = String(locale || 'en').toLowerCase().slice(0, 2);
  return LOCALES.includes(l) ? l : 'en';
}

function _taxonomyAsClassifierHint() {
  // Compress to id + domains so the LLM can match without re-deriving
  // semantics. We name the domains array as "coaches" inline since the
  // LLM doesn't know our internal "domains" word.
  return TAXONOMY.map(t => `  - ${t.id}  (coaches: ${(t.domains || []).join(', ')})`).join('\n');
}

// ─── 1. buildRouteGoalPrompt ────────────────────────────────────────────
// Classify a user-spoken/typed goal into 1–3 coaches. The classifier
// looks at semantic intent — "lose 5kg" wants nutrition + fitness even if
// the user opened the Plans tab from the fitness card.
//
// Schema target: schemas.ROUTE_GOAL
//   { coaches: string[1..3], detected_goal_key?: string, why: string }
//
// @param opts.goalText  raw user input (voice transcript or typed)
// @param opts.locale    2-letter ISO (defaults 'en')
function buildRouteGoalPrompt({ goalText, locale }) {
  const loc = _safeLocale(locale);
  const text = String(goalText || '').slice(0, 600).trim();
  if (text.length < 3) throw new Error('buildRouteGoalPrompt: goalText too short');

  const coachList = Object.entries(COACH_SCOPE)
    .map(([k, v]) => `  - ${k}: ${v}`)
    .join('\n');

  const systemPrompt = `You are a routing classifier for a wellness coaching app.

Given a user's goal in their own words (any language), classify which of the 6 coaches the goal actually touches. Be honest: choose the coaches whose scope is genuinely involved, not just the obvious one.

The 6 coaches and their scope:
${coachList}

Rules:
1. Return 1 to 3 coaches, ordered by importance.
2. "Lose weight" → nutrition is primary; fitness is usually secondary. Both belong.
3. "Sleep better" → sleep is primary; mind (wind-down) often belongs; nutrition (caffeine timing) may belong.
4. "Less anxious" → mind is primary; sleep often belongs; fitness (mobility) may belong if the user mentions tension.
5. "Drink more water" → water is primary; usually only water unless the user mentions a deeper goal.
6. "Start fasting" → fasting is primary; nutrition belongs (refeed quality).
7. If the goal is unclear or empty, return just ["habits"-like coach] with why="goal_unclear".

Available taxonomy of common goals (for reference, NOT to constrain the answer):
${_taxonomyAsClassifierHint()}

Respond in JSON. Locale: ${loc}.`;

  const userPrompt = `User goal: "${text}"`;

  return { systemPrompt, userPrompt };
}

// ─── 2. buildComposeQuestionsPrompt ─────────────────────────────────────
// Given goal + routed coaches, build 3–5 questions that SPAN all the
// coaches. One question per surface (anti-chatbot canon). Chips when
// multiple-choice fits cleanly; text only when free-form is required.
//
// Schema target: schemas.COMPOSE_QUESTIONS
//   { questions: [{ id, q, kind, coach, choices? }] }
function buildComposeQuestionsPrompt({ goalText, coachesInvolved, locale, durationDays, userContext }) {
  const loc = _safeLocale(locale);
  const text = String(goalText || '').slice(0, 600).trim();
  const coaches = Array.isArray(coachesInvolved) && coachesInvolved.length
    ? coachesInvolved.slice(0, 3)
    : ['fitness'];

  // Free-form: accept any integer in [3, 90]. Default to 14 (free-tier
  // default) when the caller passed something out of range or non-integer.
  const duration = (Number.isInteger(durationDays) && durationDays >= 3 && durationDays <= 90)
    ? durationDays
    : 14;

  const coachScope = coaches
    .map(c => `  - ${c}: ${COACH_SCOPE[c] || ''}`)
    .join('\n');

  // Question count scales with plan ambition. A 7-day plan needs less
  // calibration; a 90-day plan needs deeper context to avoid generic days.
  const targetCount = duration <= 7 ? '6 to 8' : duration <= 30 ? '8 to 12' : '10 to 14';

  // Inject user context so the LLM can SKIP questions we already know
  // the answer to (e.g. don't ask "how active are you?" if fitness is set up).
  let contextBlock = '';
  try {
    const { renderContextBlock } = require('./userContext');
    contextBlock = renderContextBlock(userContext);
  } catch {/* helper missing — degrade silently */}

  // Goal-specific guidance — the LLM tends to ask the SAME generic set
  // ("any injuries?", "how committed?") regardless of goal. We give it
  // concrete examples per goal family so it can pattern-match better.
  const goalSpecificGuide = `
GOAL-SPECIFIC SHARP QUESTIONS (use these as inspiration; do not copy verbatim — adapt to this user's actual goal text):
  • Weight loss / body recomp: "How much weight have you lost-and-regained before — and what brought it back?" · "Which meal of the day usually breaks the plan: breakfast, lunch, dinner, or late-night?" · "Do you drink alcohol, and if yes, how many nights per week?"
  • Strength / muscle gain: "What's your current bench-press / squat-equivalent in kg or lb (rough estimate is fine)?" · "Do you train solo or with a partner?" · "Can you eat 4 meals on a workout day, or do you need to fit it into 2-3?"
  • Cardio / endurance: "Furthest you've run / cycled in one go in the last 6 months?" · "Outdoor or treadmill?" · "Any joint that gives you trouble after long efforts?"
  • Sleep: "What's the most reliable thing that wrecks your sleep this month — phone, partner, baby, work stress, alcohol, late food?" · "On a good night, what wake time feels natural without an alarm?" · "Do you wake up once mid-night, multiple times, or sleep straight through?"
  • Stress / anxiety / mind: "When does the worst of it hit — morning before work, mid-afternoon, evening unwinding, or 3am wake-ups?" · "What have you already tried that gave you ANY relief, even briefly?" · "Is there a specific upcoming event driving this, or is it chronic?"
  • Hydration: "Do you carry a bottle, or rely on what's at hand?" · "Which drink replaces water most: coffee, tea, soda, alcohol?" · "Hot climate or AC most of the day?"
  • Fasting: "What's your eating window today — first bite to last bite?" · "Do you train fasted or fed?" · "What's the hardest part historically: hunger, brain fog, social meals, or willpower in the evening?"
  • Habit building: "What time of day is most under your control — early morning, lunch, evening?" · "What anchors are reliable in your day — first coffee, post-school-drop-off, lunch, end-of-work?"`;

  const systemPrompt = `You compose follow-up questions that turn a vague wellness goal into a precise, personalized plan. You're not a survey bot — you're a sharp coach finding the 8-12 specific facts that change what the plan recommends. Every question must earn its place: if knowing the answer wouldn't change the plan, don't ask it.

${contextBlock}Context for THIS plan:
- The user's stated goal (verbatim): "${text}"
- Coaches involved: ${coaches.join(', ')}
- Plan duration: ${duration} days
- Locale: ${loc}

Coach scopes (each question must be tagged with one coach below):
${coachScope}
${goalSpecificGuide}

# Hard rules

A. NEVER re-ask anything in USER CONTEXT above. If "Equipment: bands, dumbbells" is listed, do NOT ask "what equipment do you have?". If "training_level: intermediate" is listed, do NOT ask "are you a beginner?". If "disruptors: [stress, late food]" is listed, do NOT ask "what disrupts your sleep?" — instead ask the next layer ("which of those — stress or late food — feels harder to fix this month?"). If we already know weight/height, do NOT ask for them again.

B. NEVER ask these GENERIC questions (they appear on every goal and tell us nothing):
   ✗ "How motivated / committed are you?"
   ✗ "Do you have any injuries?" — unless the goal explicitly involves intense fitness AND no injury_notes is listed
   ✗ "How active are you?" — unless no fitness context exists
   ✗ "What's your goal?" — they already told us
   ✗ "Are you ready to start?" — useless
   ✗ "Any medical conditions?" — too broad; ask about a SPECIFIC one only if the goal demands it
   ✗ Any "yes/no" question that doesn't change the plan based on the answer

C. EVERY question must reference the user's specific goal OR a constraint that changes the plan. Test: if you swap the goal text and the question still makes sense unchanged, the question is too generic — rewrite it.

D. Coach coverage: return ${targetCount} questions. If coaches.length ≥ 2, EVERY listed coach gets at least one question and ideally two. A "lose 5kg" goal MUST ask both nutrition and fitness questions — never only fitness.

E. LAST question is ALWAYS the preferred-time slot. kind=chip_single, id="preferred_time", coach=most-relevant from involved list, choices (in locale): "Early morning (6-8a)" / "Morning (8-11a)" / "Midday (11a-2p)" / "Afternoon (2-5p)" / "Evening (5-8p)" / "Late evening (8-11p)". SKIP this if the USER CONTEXT lists a preferred reminder time AND a chronotype — we already know.

F. Question kinds:
   - \`chip_single\` for 2-5 mutually exclusive options. Preferred when natural.
   - \`chip_multi\` when the user could legitimately pick several.
   - \`text\` only when chips can't capture cleanly (open-ended like "what specifically broke down last time?").
   - \`duration\` for time-on-task questions.

G. Phrasing: warm, second-person ("you"), short, specific. NO emoji. NO "and"-chains (one ask per question). Locale-native (${loc}); follow [[feedback_i18n_voice]] tone (intimate du/tu/ты for ru/de/fr, glossary terms stay English).

H. \`id\` is a short snake_case slug, unique within the set.

I. Sequence: open with the SHARPEST calibration question (the one whose answer most reshapes the plan), then progressively narrower constraints, end with preferred_time.

# Sanity self-check before responding
- Are 2+ questions essentially the same? Cut to one.
- Could a stranger swap the user's goal text in and produce the same questions? If yes, you failed — rewrite.
- Does any question duplicate info in USER CONTEXT? Cut it.

Respond in JSON.`;

  const userPrompt = `Build the question set now.`;

  return { systemPrompt, userPrompt };
}

// ─── 3. buildProposeNamePrompt ──────────────────────────────────────────
// Tiny prompt. Returns a 3–6 word plan title. User sees the proposal in
// an editable input and may rewrite it. Implemented in P4 for the
// full streaming finalize flow, but the builder lands here for parity.
//
// Schema target: schemas.PROPOSE_NAME  { title: string(3..60) }
function buildProposeNamePrompt({ goalText, coachesInvolved, durationDays, locale, answers, userContext }) {
  const loc = _safeLocale(locale);
  const text = String(goalText || '').slice(0, 400).trim();
  const coaches = (coachesInvolved || []).join(', ') || 'wellness';
  // Free-form: accept any integer in [3, 90]. Default to 14 (free-tier
  // default) when the caller passed something out of range or non-integer.
  const duration = (Number.isInteger(durationDays) && durationDays >= 3 && durationDays <= 90)
    ? durationDays
    : 14;
  const answersBlock = Array.isArray(answers) && answers.length
    ? answers.map(a => `  • ${a.id}: ${a.value}`).join('\n')
    : '  (no answers — infer reasonable defaults)';

  let contextBlock = '';
  try {
    const { renderContextBlock } = require('./userContext');
    contextBlock = renderContextBlock(userContext);
  } catch {/* helper missing — degrade silently */}

  const systemPrompt = `${COACH_VOICE}

You are designing the OVERALL FRAMEWORK for a ${duration}-day personal plan.

${contextBlock}Context:
- User's goal: "${text}"
- Coaches involved: ${coaches}
- Duration: ${duration} days
- Locale: ${loc}
- User's answers to clarifying questions:
${answersBlock}

Output JSON with EXACTLY these fields:
  • title             — 3-6 word plan name
  • headline_metric   — the big number on the day-screen header (object — see rules)
  • research_anchor   — optional real citation, or empty string
  • daily_anchors     — 2-5 non-negotiables done EVERY day (each tagged with time_section)

Rules for "title":
1. 3 to 6 words. Title case OR sentence case.
2. No emoji, no quotes, no filler. Speaks to the goal, not the activity.
   Bad: "30-Day Fitness Plan". Good: "Drop 5 kg by July", "Sleep like a baby", "Calm in 14 days".
3. In the user's locale (${loc}).

Rules for "headline_metric" (REQUIRED — the big number in the day-screen header):
EXTRACT from the user's goal_text + answers. This is the single number that
defines whether the plan is working. NEVER static — every plan is different.
Shape: { type, baseline, target, unit, label, direction }.
  • type      — short snake_case key. Examples: 'kg_lost', 'hours_slept', 'meditation_sessions',
                'pushups_per_set', 'kg_gained', 'calm_score', 'fasting_hours', 'workouts_done'.
  • baseline  — current value (number). If unknown, set to 0.
  • target    — goal value (number). Required.
  • unit      — display unit. 'kg', 'h', 'min', 'sessions', 'reps', etc. Keep short.
  • label     — 2-3 word display label in locale ${loc}. Examples:
                  "kg to go" (weight loss), "h per night" (sleep), "sessions" (meditation),
                  "min/day" (mind), "workouts" (fitness), "fast hours" (fasting).
  • direction — 'up' if higher = better (hours slept, sessions done, lean mass).
                'down' if lower = better (kg lost, stress score, anxiety level).

If the goal is non-numeric (e.g. "find more peace") → type='plan_pct', baseline=0,
target=100, unit='%', label='complete', direction='up'.

Rules for "research_anchor" (OPTIONAL):
A real citation if you have one (e.g. "Hall 2011, The Lancet"). Empty string if you cannot cite a real one — NEVER invent.

Rules for "daily_anchors" (REQUIRED — 2-5 items, each carries a time_section):
These are the user's daily non-negotiables — they repeat every day. They MUST be goal-specific. NEVER include items unrelated to the goal. For a yoga plan don't add "drink 3L water" unless the user's goal involves hydration. Pick anchors that are TRULY daily for THIS goal.
Each anchor:
  • title        — WHAT. ≤6 words. Goal-specific. NEVER copy generic examples.
  • when_label   — WHEN. 1-3 words. "Morning", "Throughout day", "Bedtime", etc.
  • impact       — IMPACT on body / goal. ONE punchy sentence (6-16 words) with a stat or mechanism.
  • coach        — one of ${coaches}.
  • kind         — cap / do / hit / skip / time.
  • time_section — REQUIRED. 'morning' | 'evening' | 'night'. The FE inlines this
                   anchor into each day's MORNING / EVENING / NIGHT section.
                   • morning = wake → ~noon (hydration, light, breakfast, AM workouts)
                   • evening = ~noon → ~9pm (lunch, afternoon work, dinner, PM workouts)
                   • night   = wind-down → sleep (no caffeine, screens-off, bedtime)

NO emoji. NO motivational filler. Coach voice only.`;

  const userPrompt = `Compose the plan framework now.`;
  return { systemPrompt, userPrompt };
}

// ─── 4. buildComposePlanBatchPrompt ─────────────────────────────────────
// One 7-day batch of the plan. dayBatcher fires this in parallel; total
// plan = ceil(duration_days / 7) batches.
//
// Schema target: schemas.COMPOSE_PLAN_BATCH
//   { days: [{ day_index, summary, items: [{ title, sub?, coach, kind, target?, unit?, time_anchor_local? }] }] }
//
// The LLM MUST:
//   • Return exactly (batchEndIndex - batchStartIndex + 1) days.
//   • Use day_index values within [batchStartIndex, batchEndIndex].
//   • Tag every item with one of `coachesInvolved`.
//   • NOT repeat items already produced in prior batches (continuity summary).
function buildComposePlanBatchPrompt({
  goalText,
  coachesInvolved,
  answers,
  durationDays,
  batchStartIndex,
  batchEndIndex,
  locale,
  continuitySummary,
  dailyAnchorsSummary,
  userContext,
}) {
  const loc = _safeLocale(locale);
  const text = String(goalText || '').slice(0, 600).trim();
  const coaches = Array.isArray(coachesInvolved) && coachesInvolved.length
    ? coachesInvolved.slice(0, 3)
    : ['fitness'];
  const days_in_batch = batchEndIndex - batchStartIndex + 1;

  const coachScope = coaches.map(c => `  - ${c}: ${COACH_SCOPE[c] || ''}`).join('\n');
  const answersBlock = Array.isArray(answers) && answers.length
    ? answers.map(a => `  • ${a.id}: ${a.value}`).join('\n')
    : '  (no answers provided — infer reasonable defaults)';

  const anchorsBlock = (dailyAnchorsSummary && String(dailyAnchorsSummary).trim())
    ? String(dailyAnchorsSummary).trim()
    : '(no daily anchors specified — assume the user has no fixed daily commons)';

  let contextBlock = '';
  try {
    const { renderContextBlock } = require('./userContext');
    contextBlock = renderContextBlock(userContext);
  } catch {/* helper missing — degrade silently */}

  const systemPrompt = `${COACH_VOICE}

You compose one batch of days for a personal coaching plan.

${contextBlock}Context:
- User's goal: "${text}"
- Coaches involved (every item MUST tag one of these): ${coaches.join(', ')}
- Plan duration: ${durationDays} days  |  This batch: days ${batchStartIndex}–${batchEndIndex} (${days_in_batch} days)
- User's answers to clarifying questions:
${answersBlock}
- Continuity (avoid repeating): ${continuitySummary || '(none)'}
- Locale: ${loc}

Coach scopes:
${coachScope}

Daily anchors (these REPEAT every day — DO NOT add them as day items):
${anchorsBlock}

Day items are the UNIQUE prescription for each day, on top of the anchors. They vary by phase: early days = foundation/simpler; mid days = build/load; final days = peak/retest.

ITEM SHAPE — every item has exactly these required fields:
  • title        — WHAT. Concrete prescription, ≤6 words, ≤60 chars.
                   GOAL-SPECIFIC. NEVER static fillers — if the goal is "yoga"
                   never write "Drink 3L water" unless yoga + hydration is
                   the user's stated combo.
                   Good: "20-min Zone-2 walk", "Bench 5×5 @ 80% 1RM",
                         "Box-breathe 4×4×4×4 for 5 min", "Sun salutations ×5"
                   Bad:  "Exercise", "Eat healthier", "Try to be active"
  • when_label   — WHEN. 1-3 words. "Pre-workout", "Lunch", "Post-class",
                   "Bedtime", "Anytime", etc.
  • impact       — IMPACT. ONE sentence, 6-16 words, ≤140 chars. Stat or mechanism.
                   Good: "Burns ~400 kcal — biggest single lever on weight."
                         "Spikes growth hormone for 4h post-set."
                         "Cuts cortisol ~23% within 20 min."
                   Bad:  "Good for your body." / "Studies show this is effective."
  • coach        — one of ${coaches}.
  • kind         — cap / do / hit / skip / time.
  • time_section — REQUIRED. 'morning' | 'evening' | 'night'. Pick by item nature:
                   • morning = wake → ~noon (light, breakfast, AM workouts, hydration starts)
                   • evening = ~noon → ~9pm (lunch, work blocks, dinner, PM workouts)
                   • night   = wind-down → sleep (no caffeine, screens-off, bedtime)
                   If user said "I train at 6am" → morning. If they said "I lift
                   after work" → evening. Match the user's life.
  Plus optional: target+unit, time_anchor_local ("HH:MM").

DAY SHAPE:
  • summary    — 1-3 word label. "Foundation", "Push Day", "Rest", "Refeed", "Retest", "Flow", "Inversions" — goal-specific.
  • rest_day   — boolean. true ONLY for explicit rest days.
  • items      — 2-5 unique items (NOT anchors — anchors are inlined FE-side, you don't list them again here). On rest_day, 2-3 light items.

HARD rules:
0. ANSWERS-WEAVING: every user answer above is a HARD CONSTRAINT, not flavor. If the user said "vegetarian" → no chicken/fish items. If they said "home gym, dumbbells only" → no barbell prescriptions. If they said "I train at 6am" → workout items time_section='morning' with time_anchor_local='06:00'. If they said "no time after 8pm" → no evening/night items beyond 20:00. EVERY day in this batch must visibly reflect at least one of the user's answers (or the user context above).

1. TIME-SECTION BALANCE: distribute items across sections sensibly.
   • Aim for 1-2 items per section across the day. Maximum 3 per section.
   • A 4-item day might be 2 morning + 1 evening + 1 night, or 1 morning + 2 evening + 1 night — depends on the user's life. NEVER stuff all items into morning.
   • If user trains in morning → workout goes morning. If evening → evening.
   • Wind-down / sleep prep / screen-off → ALWAYS night.
   • A pure rest day skews lighter (mobility morning, light walk evening, sleep prep night).

2. Return EXACTLY ${days_in_batch} days, day_index ${batchStartIndex}–${batchEndIndex}.
3. NO duplicating daily anchors as day items.
4. Coach variety per day. If coaches.length ≥ 2, most days touch 2+ coaches.
5. Match each day's items to its phase (early = foundation; later = harder/peak).
6. NEVER repeat continuity-summary items.
7. NO emoji. NO motivational filler. Coach voice only.
8. Cite physiology mechanism in impact where it strengthens the line — but never invent researcher names.
9. ALL strings in locale ${loc}.

Respond in JSON matching the COMPOSE_PLAN_BATCH schema.`;

  const userPrompt = `Compose days ${batchStartIndex}–${batchEndIndex} now.`;
  return { systemPrompt, userPrompt };
}

module.exports = {
  buildRouteGoalPrompt,
  buildComposeQuestionsPrompt,
  buildProposeNamePrompt,
  buildComposePlanBatchPrompt,
  // Re-exported for test introspection
  __COACH_SCOPE: COACH_SCOPE,
};
