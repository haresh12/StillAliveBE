"use strict";
// ================================================================
// FITNESS PROACTIVE — the coach reaches out FIRST (the moat).
//
// Runs on chat-open (GET /api/fitness/proactive/check) so a relevant nudge appears immediately,
// not on an hourly cron delay. The PATTERN is detected deterministically from real data; the
// COPY is written by the LLM, personalized with the user's semantic memory — so it's warm,
// specific and human, NEVER generic "AI slop" or shaming (the old coach's failure mode).
//
// Writes ONE message/day to fitness_chats {is_proactive:true,is_read:false} WITH blocks (so a
// "[Log it]" chip works), capped by the same `proactive_today` flag the cron uses (never doubles).
// bc-namespaced. Patterns (priority): recent PR → day-aware template → overtraining → missed day
// → streak milestone. Returns the message or null.
// ================================================================
const admin = require("firebase-admin");
const { OpenAI } = require("openai");
const { retrieveMemories } = require("./fitness-memory");
const { userDoc, onboardingDoc } = require("./collections");
const { resolveAnchor } = require("./user-anchor");
const { getCoach, personaDirective } = require("./coach-roster"); // proactive texts speak in the CHOSEN coach voice
const { getCrossReachout } = require("../wellness-cross-v2/reachout.bc"); // the ONLY cross-agent read (sandbox law)
const { getHealthSignals } = require("./hk-signals"); // Apple Health (null if no wearable → HK moments skipped)

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const fitnessDoc = (id) => userDoc(id).collection("agents").doc("fitness");
const chatsCol = (id) => fitnessDoc(id).collection("fitness_chats");

// Resolve the user's chosen coach so an UNPROMPTED text lands in the same persona as the chat + voice call.
// One tiny read, only on the (max 1/day) proactive path; defaults gracefully if the user never picked one.
async function coachFor(deviceId) {
  try {
    const s = await userDoc(deviceId).get();
    const u = (s && s.exists ? s.data() : {}) || {};
    return getCoach(u.coach_id, u.coach_name);
  } catch { return getCoach(null, null); }
}
const templatesCol = (id) => fitnessDoc(id).collection("fitness_templates");
const workoutsCol = (id) => fitnessDoc(id).collection("fitness_workouts");
const ts = () => admin.firestore.FieldValue.serverTimestamp();
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const dateStr = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };

function trainingDates(workouts) {
  const set = new Set();
  workouts.forEach((w) => { if (w.date) set.add(w.date); });
  return [...set].sort().reverse();
}
function consecutiveDays(dates, today) {
  if (!dates.length) return 0;
  let cursor = dates.includes(today) ? today : dateStr(addDays(new Date(today), -1));
  if (!dates.includes(cursor)) return 0;
  const dset = new Set(dates);
  let count = 0;
  while (dset.has(cursor)) { count += 1; cursor = dateStr(addDays(new Date(cursor), -1)); }
  return count;
}

// ── Coach voice: MODES, not a template ─────────────────────────────────────────
// A real coach doesn't say "nice work" every time — sometimes they inform, teach, hype a win, check
// in, or push. Each post-log message picks ONE intent from context (+ avoids the last few used), and
// that intent sets a DIFFERENT register for the LLM. This is what makes it feel like a person.
const COACH_INTENTS = {
  progress:      "PROGRESS — they beat a previous session (named in the data). Make the improvement concrete and real; they are measurably stronger. Not generic praise.",
  milestone:     "MILESTONE — they just crossed a session milestone (named in the data). Zoom out, acknowledge how far they've come, make it feel earned.",
  streak:        "STREAK — they're on a multi-day streak (count in the data). Reinforce the HABIT and consistency — showing up repeatedly is the real win — not just this one session.",
  welcome_back:  "WELCOME BACK — they were away a few days and just returned. NO guilt, no 'where were you'. Warm, glad they're back, momentum beats the gap.",
  cardio_health: "CARDIO / HEALTH — today was cardio. Talk about what it does for their heart, energy and endurance — the quiet long-game wins, in plain words.",
  teach:         "TEACH — drop ONE genuinely useful, true, slightly surprising fitness insight tied to what they did today (recovery, sleep, rest days, protein, form) — like a sharp friend, never a textbook.",
  motivate:      "MOTIVATE — pure motivation, no stats needed. Acknowledge the discipline of showing up TODAY specifically; make them want to come back. Avoid clichés.",
  observation:   "OBSERVATION — make a sharp, specific observation about their training from the data (a pattern/habit/tendency) — the kind of thing only a coach paying attention would notice.",
  checkin:       "CHECK-IN — be human and curious, a light check-in. It's fine to ask how it felt or note one thing, like a real person texting back.",
  impact:        "IMPACT — say in plain words what today's work physically did for their body, grounded in ONE real number.",
};

function pickCoachIntent(ctx, recentIntents) {
  const specific = [];
  if (ctx.beat) specific.push("progress");
  if (ctx.milestone) specific.push("milestone");
  if (ctx.streakDays >= 3) specific.push("streak");
  if (ctx.gapDays >= 4) specific.push("welcome_back");
  if (ctx.isCardio) specific.push("cardio_health");
  const generic = ["teach", "motivate", "observation", "checkin", "impact"];
  // ~60% of the time lead with a context-specific moment (a PR, streak, comeback); otherwise rotate the
  // everyday modes. Either way, drop anything used in the last few messages so it never repeats its angle.
  const useSpecific = specific.length > 0 && Math.random() < 0.6;
  let pool = (useSpecific ? specific : generic).filter((i) => !recentIntents.includes(i));
  if (!pool.length) pool = useSpecific ? specific : generic.filter((i) => !recentIntents.includes(i));
  if (!pool.length) pool = generic;
  return pool[Math.floor(Math.random() * pool.length)];
}

// The smart part: the LLM writes the line, grounded in the situation + what we remember.
// opts.holistic → frame as the WHOLE-LIFE coach (training + food + sleep + mood + hydration), used for
// cross-agent reach-outs so a sleep/mood/hydration line doesn't get pulled back to "fitness" framing.
async function craftLine(deviceId, situation, fallback, opts = {}) {
  try {
    const [mem, coach] = await Promise.all([retrieveMemories(deviceId, situation, 4), coachFor(deviceId)]);
    const memBlock = mem.length ? `What you know about them:\n- ${mem.join("\n- ")}\n\n` : "";
    const opener = opts.holistic
      ? "You are their sharp, warm personal wellness coach — you see their WHOLE day (training, food, sleep, mood, hydration) — texting your client UNPROMPTED."
      : "You are a sharp, warm personal fitness coach texting your client UNPROMPTED.";
    const res = await openai.chat.completions.create({
      model: "gpt-5.4-mini",
      max_completion_tokens: 80,
      messages: [
        {
          role: "system",
          content:
            opener +
            " Write ONE short line (<=22 words). Specific and human — weave in what you know about them when it fits. NEVER generic, NEVER corporate or 'AI slop', NEVER shame a missed day. At most ONE emoji. Output ONLY the line — no quotes, no preamble." +
            personaDirective(coach),
        },
        { role: "user", content: `${memBlock}Situation: ${situation}\n\nWrite the message.` },
      ],
    });
    const line = (res.choices[0]?.message?.content || "").trim().replace(/^["']|["']$/g, "");
    return line || fallback;
  } catch (_) {
    return fallback;
  }
}

// Median local training hour from history (needs the client's tz offset to localize UTC timestamps).
function computeTypicalHour(workouts, tzOffsetMin) {
  if (tzOffsetMin == null) return null;
  const hours = [];
  workouts.forEach((w) => {
    const t = w.logged_at;
    try {
      const d = t && t.toDate ? t.toDate() : null;
      if (d) hours.push(new Date(d.getTime() - tzOffsetMin * 60000).getUTCHours());
    } catch (_) {}
  });
  if (hours.length < 3) return null;
  hours.sort((a, b) => a - b);
  return hours[Math.floor(hours.length / 2)];
}

// Whole days between two 'YYYY-MM-DD' strings (toStr - fromStr).
function daysBetweenStr(fromStr, toStr) {
  return Math.round((Date.parse(toStr) - Date.parse(fromStr)) / 86400000);
}

// The user's weekday-tagged templates ARE their weekly plan (e.g. Push=Mon, Pull=Wed, Legs=Fri). This
// measures commitment vs plan THIS week: how many planned days have already passed (Mon→today, and only
// on/after they joined — anchor-safe, never counting pre-registration days) vs how many distinct days
// they actually trained since Monday. `behind` > 0 with `daysLeft` > 0 = a real coach notices the slip.
function weeklyPlanGap(templates, dates, now, anchorStr) {
  const backToMon = (now.getUTCDay() + 6) % 7;            // days since Monday (Mon→0 … Sun→6)
  const monday = addDays(now, -backToMon);
  const mondayStr = dateStr(monday);
  const todayStr = dateStr(now);
  const startStr = anchorStr && anchorStr > mondayStr ? anchorStr : mondayStr; // clamp to registration
  const plannedWeekdays = new Set();
  let plannedByNow = 0;
  for (const t of templates) {
    const w = t.day_of_week;
    if (w == null || w < 0 || w > 6 || plannedWeekdays.has(w)) continue; // one planned session per weekday
    plannedWeekdays.add(w);
    const dStr = dateStr(addDays(monday, (w + 6) % 7));   // that weekday's date in the current week
    if (dStr >= startStr && dStr <= todayStr) plannedByNow += 1;
  }
  const doneThisWeek = dates.filter((d) => d >= startStr && d <= todayStr).length;
  return {
    weeklyTarget: plannedWeekdays.size,
    plannedByNow,
    doneThisWeek,
    daysLeft: 6 - backToMon,                               // remaining days after today until Sunday
    behind: plannedByNow - doneThisWeek,
  };
}

async function runProactiveCheck(deviceId, opts = {}) {
  try {
    const fSnap = await fitnessDoc(deviceId).get();
    if (!fSnap.exists) return null;
    const data = fSnap.data() || {};
    const now = new Date();
    const today = dateStr(now);
    if (data.proactive_today === today) return null; // one reach-out/day (shared with cron)
    // REGISTRATION ANCHOR: never reference a day before the user joined. A user who signed up Saturday
    // must NEVER hear "you missed Friday" (Friday predates their account). yesterdayStr < anchor → off.
    const anchor = await resolveAnchor(deviceId).catch(() => null);
    const anchorStr = anchor && anchor.isResolved ? anchor.anchorDateStr : null;
    const yesterdayStr = dateStr(addDays(now, -1));
    const isFirstDay = anchorStr ? today <= anchorStr : false;       // registration day itself
    const yesterdayBeforeJoin = anchorStr ? yesterdayStr < anchorStr : false;
    const dow = now.getUTCDay();
    // The client passes its LOCAL hour (0-23) so we nudge with real time-of-day awareness — never
    // a "you haven't logged" nag in the morning, only once they're past their usual training time.
    const localHour = Number.isInteger(opts.hour) ? opts.hour : null;

    const [tplSnap, woSnap] = await Promise.all([
      templatesCol(deviceId).get(),
      workoutsCol(deviceId).orderBy("logged_at", "desc").limit(20).get(),
    ]);
    const templates = tplSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const workouts = woSnap.docs.map((d) => d.data());
    const dates = trainingDates(workouts);
    // Brand-new user: nothing logged AND no plan → there's nothing to be proactive about. Stay quiet
    // so a first-time user lands on a clean screen, never an out-of-nowhere "log tonight" nudge.
    if (!dates.length && !templates.length) return null;
    const loggedToday = dates.includes(today);
    const streakDays = consecutiveDays(dates, today);

    const tplBlock = (t) => ({
      type: "templateList",
      templates: [{ id: t.id, name: t.name, day_of_week: t.day_of_week ?? null, exercise_count: (t.exercises || []).length, use_count: t.use_count || 0 }],
    });

    // ── Detect the pattern (deterministic) ──────────────────────────────────
    let pattern = null; // {type, situation, fallback, block?}

    const recentPR = workouts.find((w) => {
      const prs = w.personal_records || w.prs || [];
      return Array.isArray(prs) && prs.length && (w.date === today || w.date === dateStr(addDays(now, -1)));
    });
    if (recentPR) {
      const prs = recentPR.personal_records || recentPR.prs || [];
      const prName = typeof prs[0] === "string" ? prs[0] : prs[0]?.exercise || "a lift";
      pattern = {
        type: "pr_celebration",
        situation: `The user just hit a new personal record on ${prName}. Celebrate it specifically and warmly.`,
        fallback: `New PR on ${prName} — that's real progress. Keep stacking them 🎉`,
        block: { type: "record", title: "Personal record", value: typeof prs[0] === "string" ? prs[0] : `${prs[0]?.weight_kg ?? ""}kg`, sub: "Logged this week" },
      };
    }

    // ── Apple Health moments — real body data, only when present (null → skipped, parity preserved).
    //    Checked here (after a PR win, before the "do your workout" nudge) so a low-recovery morning
    //    eases the day instead of pushing training. All time-of-day gated; the 1-reach-out/day + fatigue
    //    guards downstream still apply. ──
    let hk = null;
    try { hk = await getHealthSignals(deviceId); } catch { hk = null; }
    if (!pattern && hk) {
      const recovery = hk.recovery;
      const stepsToday = hk.steps && hk.steps.latest != null ? hk.steps.latest : null;
      const STEP_GOAL = 8000;
      const lastWo = hk.workouts7 && hk.workouts7.last ? hk.workouts7.last : null;
      if (recovery != null && recovery <= 40 && localHour != null && localHour >= 5 && localHour <= 11) {
        pattern = {
          type: "hk_low_recovery",
          situation: `Their body is under-recovered this morning (recovery ${recovery}/100${hk.recovery_label ? `, ${hk.recovery_label}` : ""}${hk.sleep && hk.sleep.last_hours != null ? `, ${hk.sleep.last_hours}h sleep` : ""}). Suggest going gentle today — a walk, mobility, or a lighter session — and prioritising rest. Do NOT push a hard workout.`,
          fallback: `Recovery's low today — go gentle. A walk or some mobility beats grinding a hard session.`,
        };
      } else if (!loggedToday && lastWo && lastWo.date === today && localHour != null && localHour >= 11) {
        pattern = {
          type: "hk_post_workout",
          situation: `They trained today (${lastWo.workout_type || "a workout"}${lastWo.minutes ? `, ${lastWo.minutes}min` : ""}) and it auto-synced. Acknowledge the session and nudge a protein-forward meal to recover well.`,
          fallback: `Nice session today — get some protein in to recover well.`,
        };
      } else if (stepsToday != null && stepsToday >= STEP_GOAL * 0.8 && stepsToday < STEP_GOAL && localHour != null && localHour >= 16 && localHour <= 21) {
        const left = Math.round(STEP_GOAL - stepsToday);
        pattern = {
          type: "hk_step_close",
          situation: `They're close to a strong step day — about ${left.toLocaleString()} steps short of ${STEP_GOAL.toLocaleString()}. Nudge a short walk to close it. Light and encouraging.`,
          fallback: `You're ~${left.toLocaleString()} steps from ${STEP_GOAL.toLocaleString()} — a quick walk closes it.`,
        };
      }
    }

    // ── Re-engagement: they trained before, went quiet a few days, and just opened the app. The RETURN
    //    is the emotional moment — greet it warmly and guilt-free, above the routine nudges. Bounded to a
    //    3–20 day gap so a long-dormant user isn't guilt-tripped, and never on registration day. ──
    const lastLogStr = dates[0] || null;
    const daysSinceLast = lastLogStr ? daysBetweenStr(lastLogStr, today) : null;
    if (!pattern && !loggedToday && daysSinceLast != null && daysSinceLast >= 3 && daysSinceLast <= 20 && !isFirstDay) {
      pattern = {
        type: "welcome_back",
        situation: `The user trained before but has been away ${daysSinceLast} days and just opened the app. Welcome them back — ZERO guilt, no "where were you"; you're genuinely glad they're here, momentum beats the gap, tie it to their goal. Invite ONE easy session to restart.`,
        fallback: `Good to see you back — ${daysSinceLast} days out is nothing. One easy session today and you're rolling again.`,
        block: { type: "suggestions", chips: [{ id: "logtoday", label: "Log a workout" }] },
      };
    }

    // ── Cross-agent reach-out: the "coach who sees your WHOLE life" moment (poor sleep dragging mood,
    //    trained on low sleep, under-fuelled after a session, dehydration + low mood, or a great-sleep
    //    good day worth naming). Cross reads happen ONLY inside the wellness-cross module (sandbox law);
    //    here we just voice what it returns, in the chosen persona. Ranked high — a real cross-domain
    //    observation beats a routine "log your workout" nudge — but it fires rarely (needs real signals
    //    across agents), so day-to-day fitness nudges still lead. Uses the user's LOCAL date so "today"
    //    lines up with their logs; anchor-safe by construction (only reads real logs). ──
    if (!pattern) {
      const tzMin = Number.isInteger(opts.tzOffsetMin) ? opts.tzOffsetMin : null;
      const localNow = tzMin != null ? new Date(now.getTime() + tzMin * 60000) : now;
      const cross = await getCrossReachout(deviceId, {
        todayStr: dateStr(localNow),
        yesterdayStr: dateStr(addDays(localNow, -1)),
        localHour,
      }).catch(() => null);
      if (cross) {
        pattern = {
          type: cross.type,
          situation: cross.situation,
          fallback: cross.fallback,
          holistic: true, // voice it as the whole-life coach, not the fitness-only coach
        };
      }
    }

    const todayTpl = templates.find((t) => t.day_of_week === dow);
    if (!pattern && todayTpl && !loggedToday) {
      pattern = {
        type: "day_aware_template",
        situation: `It's ${DAYS[dow]} and the user has a saved workout "${todayTpl.name}" (${(todayTpl.exercises || []).length} exercises) they usually do on ${DAYS[dow]}s but haven't logged today. Warmly invite them to do it — not pushy.`,
        fallback: `It's ${DAYS[dow]} — want to knock out your usual ${todayTpl.name}?`,
        block: tplBlock(todayTpl),
      };
    }

    if (!pattern && streakDays >= 6) {
      pattern = {
        type: "overtraining",
        situation: `The user has trained ${streakDays} days in a row. Caringly suggest a rest day — frame rest as what makes them stronger, never as quitting.`,
        fallback: `That's ${streakDays} days straight — a real rest day now will make you stronger, not weaker.`,
      };
    }

    const ydow = (dow + 6) % 7;
    const yTpl = templates.find((t) => t.day_of_week === ydow);
    // Only a "missed yesterday" if yesterday was actually on/after they joined — never blame a day
    // that predates the account, and never on day one.
    if (!pattern && yTpl && !isFirstDay && !yesterdayBeforeJoin && !dates.includes(yesterdayStr)) {
      pattern = {
        type: "missed_day",
        situation: `The user usually does "${yTpl.name}" on ${DAYS[ydow]} but missed yesterday. Zero guilt — offer to fit it in today.`,
        fallback: `${DAYS[ydow]}'s ${yTpl.name} slipped — no stress. Want to fit it in today?`,
        block: tplBlock(yTpl),
      };
    }

    // Celebrate a milestone only on a day they ACTUALLY logged — otherwise the run ended yesterday and is
    // at risk (handled below), not a win to cheer right now.
    if (!pattern && loggedToday && [7, 14, 30, 60, 100].includes(streakDays)) {
      pattern = {
        type: "streak_milestone",
        situation: `The user hit a ${streakDays}-day training streak. Celebrate the consistency genuinely and personally.`,
        fallback: `${streakDays} days in a row — that consistency is exactly what builds results.`,
      };
    }

    // The simple, important one: they just haven't logged today. Only nudge once it's PAST their
    // usual training time (smart timing) — never a morning nag. Zero guilt, still-time-tonight tone.
    const typicalHour = computeTypicalHour(workouts, opts.tzOffsetMin);
    const pastUsualTime = localHour != null && localHour >= Math.max(typicalHour != null ? typicalHour + 1 : 17, 16);

    // ── Streak-at-risk save: a real streak (≥3) that breaks at midnight if they don't log. Evening-only,
    //    gentle loss-aversion — never guilt, never panic; make them WANT to protect what they've built. ──
    if (!pattern && !loggedToday && streakDays >= 3 && pastUsualTime && !isFirstDay) {
      pattern = {
        type: "streak_at_risk",
        situation: `The user has a ${streakDays}-day training streak but hasn't logged today, and it's evening (${localHour}:00 their time) — it breaks at midnight. Use gentle loss-aversion: remind them what's on the line, that even 10 minutes keeps it alive. Never guilt or panic; make them WANT to protect it.`,
        fallback: `Your ${streakDays}-day streak is still alive — 10 minutes tonight keeps it going. Don't let it slip.`,
        block: { type: "suggestions", chips: [{ id: "logtoday", label: "Save my streak" }] },
      };
    }

    // ── Weekly plan commitment: they're behind their OWN weekly plan with days still left. Midday+ (not a
    //    morning nag). This is the "coach who notices where you're slipping vs your goal" moment. ──
    const wk = weeklyPlanGap(templates, dates, now, anchorStr);
    if (!pattern && !loggedToday && wk.weeklyTarget >= 2 && wk.behind >= 1 && wk.daysLeft >= 1 &&
        wk.plannedByNow >= 1 && localHour != null && localHour >= 12) {
      pattern = {
        type: "weekly_commitment_gap",
        situation: `The user's own weekly plan has ${wk.weeklyTarget} sessions. By now they should have done ${wk.plannedByNow} but have logged ${wk.doneThisWeek} this week — ${wk.behind} behind, with ${wk.daysLeft} day(s) left. As their coach, name the gap plainly but WITHOUT guilt and offer to get one in today. Tie it to their goal. Concrete and encouraging.`,
        fallback: `You're ${wk.behind} session behind your plan this week with ${wk.daysLeft} day(s) left — want to knock one out today?`,
        block: { type: "suggestions", chips: [{ id: "logtoday", label: "Log a workout" }] },
      };
    }

    if (!pattern && !loggedToday && pastUsualTime && !isFirstDay) {
      pattern = {
        type: "no_log_today",
        situation: `It's around ${localHour}:00 their time and they haven't logged a workout today${typicalHour != null ? ` (they usually train around ${typicalHour}:00)` : ""}. As their coach, send a warm, zero-guilt nudge — there's still time tonight, even a short session counts. Encouraging, never naggy.`,
        fallback: `Still time to get one in tonight — even a short session counts 💪`,
        block: { type: "suggestions", chips: [{ id: "logtoday", label: "Log my workout" }] },
      };
    }

    if (!pattern) return null;

    // ── Craft the line (smart, personal) + compose blocks ───────────────────
    const line = await craftLine(deviceId, pattern.situation, pattern.fallback, { holistic: !!pattern.holistic });
    const blocks = [{ type: "text", text: line }];
    if (pattern.block) blocks.push(pattern.block);

    const ref = await chatsCol(deviceId).add({
      role: "assistant",
      content: line,
      blocks,
      is_proactive: true,
      proactive_type: pattern.type,
      is_read: false,
      created_at: ts(),
    });
    await fitnessDoc(deviceId).set({ proactive_today: today }, { merge: true });

    return { id: ref.id, role: "assistant", content: line, blocks, proactive_type: pattern.type };
  } catch (e) {
    (globalThis.log?.error || console.error)("[fitness-proactive] check:", e?.message || e);
    return null;
  }
}

async function proactiveCheckHandler(req, res) {
  const { deviceId, hour, tzOffset } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  const h = parseInt(hour, 10);
  const tz = parseInt(tzOffset, 10);
  const message = await runProactiveCheck(deviceId, {
    hour: Number.isFinite(h) ? h : null,
    tzOffsetMin: Number.isFinite(tz) ? tz : null,
  });
  return res.json({ message });
}

// ── Real session impact (the foundation of the post-workout message) ───────────
// Everything here is COMPUTED from stored data — never fabricated. We surface what the session
// they JUST finished actually did to their body: total volume load (mechanical tension), reps,
// the muscles trained, and progressive overload vs their last session of the same lift. The LLM
// then translates ONE of these real facts into a warm, present-tense coach line.
function bestE1rm(sets) {
  return Math.max(0, ...((sets || []).map((s) => Number(s.e1rm) || 0)));
}
function exVolume(ex) {
  return (ex.sets || []).reduce((s, x) => s + (Number(x.reps) || 0) * (Number(x.weight_kg) || 0), 0);
}
function computeSessionImpact(workouts) {
  if (!workouts.length) return null;
  // Read the WHOLE day, not just the last logged set. If the user did 20 sets earlier and now adds 1, the
  // coach must see "21 sets today" — never judge the day by the final 1-set entry alone. Every workout doc
  // from today is merged into one session view (logging can append multiple docs across the day).
  const todayStr = workouts[0].date; // the just-logged doc's day = today (workouts are desc by logged_at)
  const todaysDocs = todayStr ? workouts.filter((w) => w.date === todayStr) : [workouts[0]];
  const session = todaysDocs[0] || workouts[0];
  const exs = todaysDocs.flatMap((w) => (Array.isArray(w.exercises) ? w.exercises : []));
  if (!exs.length) return null;

  let totalReps = 0;
  let totalSets = 0;
  let isCardio = false;
  const byMuscle = {}; // muscle -> { volume, sets, reps }
  const cardioBits = [];

  for (const ex of exs) {
    const sets = Array.isArray(ex.sets) ? ex.sets : [];
    const muscle = ex.muscle_group || "other";
    let exHasCardio = false;
    for (const s of sets) {
      const reps = Number(s.reps) || 0;
      const w = Number(s.weight_kg) || 0;
      totalSets += 1;
      totalReps += reps;
      const m = (byMuscle[muscle] ||= { volume: 0, sets: 0, reps: 0 });
      m.volume += reps * w;
      m.sets += 1;
      m.reps += reps;
      if (s.distance_m || s.duration_sec) { isCardio = true; exHasCardio = true; }
    }
    if (exHasCardio) {
      const dist = sets.reduce((a, s) => a + (Number(s.distance_m) || 0), 0);
      const dur = sets.reduce((a, s) => a + (Number(s.duration_sec) || 0), 0);
      if (dist) cardioBits.push(`${dist % 1000 ? (dist / 1000).toFixed(1) : dist / 1000}km`);
      if (dur) cardioBits.push(`${Math.round(dur / 60)}min`);
    }
  }

  // Only NAMED muscles are worth citing — never say "your other muscles" (that's our catch-all
  // bucket for cardio / unmapped moves, and it reads like a bug).
  const muscles = Object.entries(byMuscle)
    .map(([muscle, v]) => ({ muscle, ...v }))
    .filter((m) => m.muscle && m.muscle !== "other")
    .sort((a, b) => b.volume - a.volume || b.sets - a.sets);
  const topMuscle = muscles[0]?.muscle || null;

  // Progressive overload on the session's heaviest-volume lift: compare today's best estimated
  // 1-rep-max to the most recent PRIOR session that contained the same exercise.
  const topEx = exs.slice().sort((a, b) => exVolume(b) - exVolume(a))[0];
  let progression = null;
  if (topEx) {
    const todayE1rm = bestE1rm(topEx.sets);
    for (let i = 1; i < workouts.length; i++) {
      if (workouts[i].date === todayStr) continue; // skip earlier-today docs — compare to a PRIOR day
      const prevEx = (workouts[i].exercises || []).find(
        (e) => (e.name || "").toLowerCase() === (topEx.name || "").toLowerCase(),
      );
      if (prevEx) {
        const prevE1rm = bestE1rm(prevEx.sets);
        if (todayE1rm > 0 && prevE1rm > 0) {
          const delta = Math.round((todayE1rm - prevE1rm) * 10) / 10;
          progression = {
            exercise: topEx.name,
            beat: delta > 0.5,
            held: Math.abs(delta) <= 0.5,
            todayE1rm: Math.round(todayE1rm),
            prevE1rm: Math.round(prevE1rm),
          };
        }
        break; // only compare to the most recent prior occurrence
      }
    }
  }

  const volume = Math.round(
    todaysDocs.reduce((a, w) => a + (Number(w.total_volume_kg) || 0), 0) || muscles.reduce((a, m) => a + m.volume, 0),
  );
  return {
    volume,
    totalReps,
    totalSets,
    muscles,
    topMuscle,
    progression,
    isCardio,
    cardio: cardioBits.join(" · "),
    durationMin: todaysDocs.reduce((a, w) => a + (Number(w.duration_min) || 0), 0) || null,
    sessionsToday: todaysDocs.length,
    exerciseNames: exs.map((e) => e.name).filter(Boolean),
  };
}

// Writes the post-workout impact line. Separate from craftLine because the brief is different:
// it must be GROUNDED in the real numbers, present/past tense (what the body DID today, never a
// vague "this will…"), cite a real figure, and vary its angle every session.
async function craftImpactLine(deviceId, situation, fallback, recentOpeners = []) {
  try {
    const [mem, coach] = await Promise.all([retrieveMemories(deviceId, situation, 3), coachFor(deviceId)]);
    const memBlock = mem.length ? `What you know about them:\n- ${mem.join("\n- ")}\n\n` : "";
    const avoidBlock = recentOpeners.length
      ? `Your last messages opened like this — do NOT open the same way or repeat their feel: ${recentOpeners.map((o) => `"${o}…"`).join(", ")}. `
      : "";
    const res = await openai.chat.completions.create({
      model: "gpt-5.4-mini",
      max_completion_tokens: 140,
      messages: [
        {
          role: "system",
          content:
            "You are their personal coach, texting them the second they finish a workout — a REAL person, not a tip generator. A real coach does NOT say 'nice work' every time; they vary — sometimes informing, teaching, hyping a win, checking in, or pushing. FOLLOW TODAY'S MODE in the situation exactly; let it set the whole tone and shape. " +
            "Write ONE text message, max ~30 words, in PLAIN everyday English — like texting a friend who knows nothing about gym science, not a textbook. Use ONLY the real numbers given — NEVER invent one (if the mode needs no number, use none). " +
            "BAN jargon and lookalikes: 'mechanical tension', 'stimulus', 'fibres/fibers', 'volume load', 'progressive overload', 'working sets', 'hypertrophy', 'adaptation', 'banked'. Use real-person words instead. " +
            "Sound human: vary your OPENING and your ENDING every time. Do NOT end with 'nice work' / 'keep it up' / 'great job' / 'well done' unless it genuinely fits this one mode. Never hollow praise with nothing behind it. " +
            avoidBlock +
            "At most one emoji, and often none. Output ONLY the message — no quotes, no preamble." +
            personaDirective(coach),
        },
        { role: "user", content: `${memBlock}${situation}\n\nWrite the message.` },
      ],
    });
    const line = (res.choices[0]?.message?.content || "").trim().replace(/^["']|["']$/g, "");
    return line || fallback;
  } catch (_) {
    return fallback;
  }
}

// ── Appreciation after a good action (logging) ─────────────────────────────────
// A real coach notices effort. Right after a log, this returns ONE short, genuine, VARIED line
// tied to something real (their streak, week, goal, how far they've come) — the warm follow-up
// that makes logging feel rewarding. Called non-blocking from the FE after a non-PR log.
async function encourageHandler(req, res) {
  const { deviceId, summary } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const now = new Date();
    const today = dateStr(now);
    const weekAgo = dateStr(addDays(now, -6));
    const [woSnap, obSnap, fSnap] = await Promise.all([
      workoutsCol(deviceId).orderBy("logged_at", "desc").limit(30).get(),
      onboardingDoc(deviceId).get().catch(() => null),
      fitnessDoc(deviceId).get().catch(() => null),
    ]);
    const workouts = woSnap.docs.map((d) => d.data());
    const dates = trainingDates(workouts);
    const weekCount = dates.filter((d) => d >= weekAgo && d <= today).length;
    const streakDays = consecutiveDays(dates, today);
    // Last few coach messages (intent + opener) — so we never repeat the angle or opening line.
    const recent = (fSnap && fSnap.exists ? fSnap.data().coach_recent : null) || [];
    const recentIntents = recent.map((r) => r.intent).filter(Boolean);
    const recentOpeners = recent.map((r) => r.opener).filter(Boolean);
    const ob = obSnap && obSnap.exists ? obSnap.data() : null;
    const goal = ob?.fitness_goal || (Array.isArray(ob?.goals) ? ob.goals[0] : null);
    const name = ob?.name ? String(ob.name).split(" ")[0] : null;
    const targetKg = ob?.target_weight_kg ? Number(ob.target_weight_kg) : null;
    const curKg = ob?.weight ? Number(ob.weight) : null;
    const goalWeight = targetKg && curKg
      ? `Goal weight: ${targetKg}kg, currently ~${curKg}kg.`
      : targetKg ? `Goal weight: ${targetKg}kg.` : null;
    const journey = dates.length >= 8 ? `${dates.length}+ sessions logged with you so far.` : null;

    // The real, computed impact of the session they JUST finished — the heart of the message.
    const impact = computeSessionImpact(workouts);

    // Weekly stimulus for the muscle they hammered most (≈10 weekly sets is the growth threshold).
    let weeklyTopMuscleSets = 0;
    if (impact?.topMuscle) {
      for (const w of workouts) {
        if (w.date >= weekAgo && w.date <= today) {
          for (const ex of w.exercises || []) {
            if ((ex.muscle_group || "other") === impact.topMuscle) {
              weeklyTopMuscleSets += (ex.sets || []).length;
            }
          }
        }
      }
    }

    // REAL facts — only things we actually computed go in. The LLM may use no number it isn't given.
    // Phrased in plain words (no jargon) so the model echoes plain words back.
    const facts = [];
    if (impact?.isCardio && impact.cardio) facts.push(`Today's cardio: ${impact.cardio}.`);
    if (impact?.volume > 0) {
      facts.push(`Total weight lifted today: about ${impact.volume.toLocaleString()} kg, over ${impact.totalSets} sets and ${impact.totalReps} reps.`);
    } else if (impact?.totalSets && !impact.isCardio) {
      facts.push(`Today: ${impact.totalSets} sets / ${impact.totalReps} reps using their own bodyweight.`);
    }
    if (impact?.muscles?.length) {
      facts.push(`Body parts they worked, hardest first: ${impact.muscles.slice(0, 3).map((m) => m.muscle).join(", ")}.`);
    }
    if (impact?.sessionsToday > 1) {
      facts.push(`This is one of ${impact.sessionsToday} separate logs today — the totals above are the FULL day's work. Acknowledge the whole day, never judge it as if the last small entry were the entire session (e.g. don't call a day "light" because the final log was 1 set).`);
    }
    if (impact?.progression?.beat) {
      facts.push(`They got STRONGER than last time on ${impact.progression.exercise} — clearly beat their previous session.`);
    } else if (impact?.progression?.held) {
      facts.push(`They matched their last ${impact.progression.exercise} session — holding their strength.`);
    }
    if (impact?.topMuscle && weeklyTopMuscleSets > 0) {
      facts.push(`This week they've done ${weeklyTopMuscleSets} sets for their ${impact.topMuscle} (about 10 a week is the sweet spot for growth).`);
    }

    // Context signals that decide which coaching MODE fits this moment.
    const totalSessions = dates.length;
    const milestone = [10, 20, 30, 50, 75, 100, 150, 200, 250, 300].includes(totalSessions);
    let gapDays = 0;
    if (dates.length >= 2) {
      gapDays = Math.round((new Date(dates[0]).getTime() - new Date(dates[1]).getTime()) / 86400000);
    }
    const intent = pickCoachIntent(
      { beat: !!impact?.progression?.beat, milestone, streakDays, gapDays, isCardio: !!impact?.isCardio },
      recentIntents,
    );
    // Add the facts a given mode needs to be specific.
    if (milestone) facts.push(`This is their ${totalSessions}th session logged with you — a milestone.`);
    if (gapDays >= 4) facts.push(`They were away ${gapDays} days and just came back today.`);

    const ctx = [
      `Sessions in the last 7 days: ${weekCount}.`,
      streakDays > 1 ? `Current streak: ${streakDays} days.` : null,
      goal ? `Their fitness goal: ${goal}.` : null,
      goalWeight,
      journey,
      name ? `Their name: ${name}.` : null,
    ].filter(Boolean).join(" ");

    const situation = [
      ctx,
      "",
      "REAL DATA FROM THE SESSION THEY JUST FINISHED (use ONLY these numbers — never invent one):",
      ...facts.map((f) => `- ${f}`),
      "",
      `TODAY'S MODE — ${COACH_INTENTS[intent]}`,
    ].filter((x) => x != null).join("\n");

    // Data-grounded fallback (used only if the LLM call fails) — plain words, still cites real numbers.
    let fallback;
    if (intent === "milestone") {
      fallback = `${totalSessions} sessions in — that's a real milestone. You've built something here.`;
    } else if (intent === "welcome_back") {
      fallback = `Back at it after a few days — that's exactly how it's done. No looking back.`;
    } else if (impact?.progression?.beat) {
      fallback = `You beat your last ${impact.progression.exercise} today — that's real progress, you're getting stronger.`;
    } else if (impact?.isCardio && impact.cardio) {
      fallback = `${impact.cardio} done — your heart and endurance just got a little better.`;
    } else if (impact?.volume > 0) {
      fallback = `You lifted about ${impact.volume.toLocaleString()}kg in total today — your ${impact.topMuscle || "muscles"} come back a little stronger.`;
    } else if (impact?.totalSets) {
      fallback = `${impact.totalSets} solid sets today — it all adds up.`;
    } else {
      fallback = `Logged — every session moves you forward.`;
    }

    const line = facts.length
      ? await craftImpactLine(deviceId, situation, fallback, recentOpeners)
      : fallback;

    // Remember this message's mode + opener so the next one doesn't repeat the angle or opening.
    const opener = String(line || "").split(/\s+/).slice(0, 6).join(" ");
    fitnessDoc(deviceId).set({ coach_recent: [{ intent, opener }, ...recent].slice(0, 3) }, { merge: true }).catch(() => {});

    return res.json({ line, intent });
  } catch (e) {
    (globalThis.log?.error || console.error)("[fitness-proactive] encourage:", e?.message || e);
    return res.json({ line: null });
  }
}

// ── Smart nudge time for the client's daily local reminder ─────────────────────
// The client schedules a LOCAL "haven't logged today" notification (the BE never pushes in prod).
// We tell it WHEN to fire (smart: ~1h after the user's typical training time, learned from history;
// falls back to their onboarding reminder time, then 7pm) and whether they've already logged today
// (so the client can skip/defer). Needs the client's tz offset to localize.
async function nudgeTimeHandler(req, res) {
  const { deviceId, tzOffset, fallbackHour } = req.query;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const tz = parseInt(tzOffset, 10);
    const tzOffsetMin = Number.isFinite(tz) ? tz : null;
    const now = new Date();
    const localToday = tzOffsetMin != null ? dateStr(new Date(now.getTime() - tzOffsetMin * 60000)) : dateStr(now);
    const woSnap = await workoutsCol(deviceId).orderBy("logged_at", "desc").limit(30).get();
    const workouts = woSnap.docs.map((d) => d.data());
    const dates = trainingDates(workouts);
    const loggedToday = dates.includes(localToday);

    const typical = computeTypicalHour(workouts, tzOffsetMin);
    const fb = parseInt(fallbackHour, 10);
    // Learned time + 1h gives them a window to log before we nudge; clamp to a civil 6am–10pm.
    const hour = typical != null
      ? Math.max(6, Math.min(22, typical + 1))
      : Number.isFinite(fb) ? Math.max(6, Math.min(22, fb)) : 19;

    return res.json({ hour, loggedToday, learned: typical != null });
  } catch (e) {
    (globalThis.log?.error || console.error)("[fitness-proactive] nudgeTime:", e?.message || e);
    return res.json({ hour: 19, loggedToday: false, learned: false });
  }
}

module.exports = { runProactiveCheck, proactiveCheckHandler, encourageHandler, nudgeTimeHandler };
