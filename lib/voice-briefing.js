'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// voice-briefing.js — the "call briefing" the voice coach speaks from.
//
// This is the MOAT: before the coach says a word it knows who the user is and
// how they're actually doing. We read the user's profile (onboarding) + each
// ACTIVE domain's recent logs, all clamped to the registration anchor (P1 law:
// never count days before the user existed), and reduce to (a) a structured
// summary and (b) a compact natural-language briefing injected into the agent's
// system prompt (and prompt-cached, so it's fast + cheap on every turn).
//
// Cross-agent by nature → this lives OUTSIDE any single agent's sandbox; it is
// only ever consumed by the voice-call coach (cross-agent surface). It reads
// each agent's own bc collection the same way wellness-combined.bc.agent does.
// ═══════════════════════════════════════════════════════════════════════════
const { resolveAnchor } = require('./user-anchor');
const { computeAnalysisWindow } = require('./range-helpers');
const { userDoc, onboardingDoc } = require('./collections');
const { getLearnings, getRecentCallContext } = require('./voice-calls');
const { healthSignalsText } = require('./hk-signals');

const pad = (n) => String(n).padStart(2, '0');
const dateStr = (d, off = 0) => {
  const t = new Date(d.getTime() + off * 60000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

const AGENT_DOC = (id, a) => userDoc(id).collection('agents').doc(a);

// The six coachable domains. When the user picks one as the call topic, we pull that domain's
// REAL analysis (same endpoints the Analysis tab uses) so the coach walks in knowing their numbers.
const DOMAIN_SET = new Set(['fitness', 'nutrition', 'mind', 'sleep', 'water', 'fasting']);
const SELF = `http://127.0.0.1:${process.env.PORT || 5001}`;

async function fetchJson(url, ms = 1500) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return r.ok ? await r.json() : null;
  } catch { return null; } finally { clearTimeout(to); }
}

// Distill a domain's /analysis JSON into a compact, real-numbers briefing block. Shape varies per
// agent, so we extract the standard outputs + headline + reads generically, then attach trimmed raw
// stats so the LLM can cite exact figures.
function deepDiveText(domain, a) {
  if (!a || typeof a !== 'object') return '';
  const L = [`\n=== DEEP-DIVE on ${domain.toUpperCase()} (they chose to talk about this — REAL data, last 30d) ===`];
  const scores = [
    a.score_today != null && `today ${a.score_today}`,
    a.score_7d_smoothed != null && `7-day ${a.score_7d_smoothed}`,
    a.score_lifetime != null && `lifetime ${a.score_lifetime}`,
  ].filter(Boolean).join(' · ');
  if (scores) L.push(`Score: ${scores}.`);
  if (a.days_logged != null || a.missed_days != null) {
    L.push(`Logged ${a.days_logged ?? '?'} day(s)${a.effective_days != null ? ` of ${a.effective_days}` : ''}${a.missed_days != null ? `, missed ${a.missed_days}` : ''}.`);
  }
  const hero = a.hero_insight || a.headline || (a.stats && a.stats.headline);
  if (hero) L.push(`Headline: ${typeof hero === 'string' ? hero : JSON.stringify(hero)}`.slice(0, 240));
  const reads = a.ai_reads || a.insights || a.reads || a.aha_moments;
  if (Array.isArray(reads) && reads.length) {
    L.push('Reads:');
    reads.slice(0, 4).forEach(r => L.push(`  • ${(typeof r === 'string' ? r : (r.text || r.title || r.body || JSON.stringify(r))).toString().slice(0, 160)}`));
  }
  if (a.stats && typeof a.stats === 'object') L.push(`Numbers: ${JSON.stringify(a.stats).slice(0, 1200)}`);
  return L.join('\n');
}

// Distill the user's active plans + today's progress into a briefing block.
// Shape = GET /api/bc-plans/today: { has_plan, plans[], today_tasks[{plan_title,title,domain,done}], progress }.
function plansText(resp) {
  if (!resp || !resp.has_plan) return '';
  const tasks = Array.isArray(resp.today_tasks) ? resp.today_tasks : [];
  const prog = resp.progress || {};
  const titles = Array.isArray(resp.plans) ? resp.plans.map(p => p.title).filter(Boolean) : [];
  const L = [`ACTIVE PLANS (their commitments — reference progress, nudge on what's undone TODAY):`];
  if (titles.length) L.push(`  Plans: ${titles.join('; ')}.`);
  L.push(`  Today: ${prog.today_done || 0}/${prog.today_total || 0} tasks done${prog.streak ? `, ${prog.streak}-day streak` : ''}${prog.week_pct != null ? `, week ${prog.week_pct}%` : ''}.`);
  const undone = tasks.filter(t => !t.done).map(t => `${t.title}${t.plan_title ? ` (${t.plan_title})` : ''}`).slice(0, 6);
  if (undone.length) L.push(`  STILL TO DO today: ${undone.join('; ')}.`);
  return L.join('\n');
}

// Cross-agent connections → the synthesized champion/drag/link lines from the combined engine
// (/api/wellness-combined coach_read). This is the MOAT: the coach reasons across domains ("your sleep
// drives your mood") from the first sentence, no mid-call tool round-trip needed. Empty for new users.
function crossText(c) {
  if (!c || c.ok === false || c.has_data === false) return '';
  const lines = Array.isArray(c.coach_read) ? c.coach_read.map(x => x && x.text).filter(Boolean) : [];
  if (!lines.length && c.hero) lines.push(c.hero);
  if (!lines.length) return '';
  return `CROSS-AGENT CONNECTIONS (how their areas affect each other — THIS is your edge; weave it in naturally, never list it):\n• ${lines.slice(0, 4).join('\n• ')}`;
}

// Recent calls → a short "what we've already discussed" block so the coach has continuity and never
// repeats itself. Relative day labels keep it human ("yesterday", "3 days ago").
function recentCallsText(recentCalls) {
  const calls = Array.isArray(recentCalls) ? recentCalls.filter(Boolean) : [];
  if (!calls.length) return '';
  const now = Date.now();
  const rel = (ms) => {
    if (!ms) return 'recently';
    const days = Math.floor((now - ms) / 86_400_000);
    return days <= 0 ? 'earlier today' : days === 1 ? 'yesterday' : `${days} days ago`;
  };
  const L = [`PAST CONVERSATIONS (you ALREADY talked about these — do NOT repeat them; build on them, and call back naturally like "last time we…"):`];
  for (const c of calls.slice(0, 3)) {
    const tk = c.takeaways && c.takeaways.length ? ` (they were going to: ${c.takeaways.slice(0, 2).join('; ')})` : '';
    L.push(`  • [${rel(c.started_at)}] "${c.title}" — ${String(c.summary || '').slice(0, 200)}${tk}`);
  }
  return L.join('\n');
}

// Same reductions as wellness-combined: a per-log 0..100 "how good was this" proxy + a
// date extractor. Labels are how the COACH refers to each domain out loud.
const AGENTS = {
  fitness:   { label: 'training',  col: 'fitness_workouts', date: (d) => d.date_str, value: (d) => clamp(num(d.total_sets || d.sets) * 5 || (num(d.total_volume_kg) ? 60 : 50), 20, 100) },
  nutrition: { label: 'nutrition', col: 'food_logs',        date: (d) => d.date_str, value: (d) => clamp(Math.round((num(d.protein || d.p) / 150) * 100) || 50, 10, 100) },
  sleep:     { label: 'sleep',     col: 'sleep_logs',       date: (d) => d.date_str, value: (d) => clamp(Math.round((num(d.sleep_quality || 3) / 5) * 100), 10, 100) },
  mind:      { label: 'mood',      col: 'mind_checkins',    date: (d) => d.date_str, value: (d) => clamp(Math.round((num(d.mood_score || 3) / (d.mood_score > 5 ? 100 : 5)) * 100), 10, 100) },
  water:     { label: 'hydration', col: 'water_logs',       date: (d) => d.date_str, value: (d) => clamp(Math.round((num(d.ml) / 2500) * 100), 5, 100) },
  fasting:   { label: 'fasting',   col: 'fasting_sessions', date: (d) => d.date || (d.started_at_ms ? dateStr(new Date(d.started_at_ms)) : null), value: (d) => clamp(Math.round((num(d.total_hours || d.actual_hours || d.hours) / 16) * 100), 5, 100) },
};

// Reduce one domain's recent logs to a per-day map within [startDate, today].
async function domainSummary(deviceId, id, startDate, todayDate, daysSinceAnchor) {
  const a = AGENTS[id];
  if (!a) return null;
  const buckets = {};
  let lastDate = null;
  try {
    const snap = await AGENT_DOC(deviceId, id).collection(a.col)
      .orderBy('logged_at', 'desc').limit(400).get().catch(() => ({ docs: [] }));
    for (const doc of snap.docs) {
      const d = doc.data();
      const ds = a.date(d);
      if (!ds) continue;
      if (!lastDate || ds > lastDate) lastDate = ds;
      if (ds < startDate || ds > todayDate) continue;
      (buckets[ds] = buckets[ds] || []).push(a.value(d));
    }
  } catch { /* no data for this domain — fine */ }

  const days = Object.keys(buckets);
  const daysLogged = days.length;
  const recent = days.sort().slice(-7).flatMap((ds) => buckets[ds]);
  const recentAvg = daysLogged ? Math.round(mean(recent)) : null;
  // Missed days = days that existed since the anchor where the user logged nothing.
  const missedDays = clamp(daysSinceAnchor - daysLogged, 0, daysSinceAnchor);
  const daysAgo = lastDate
    ? Math.round((Date.parse(todayDate) - Date.parse(lastDate)) / 86_400_000)
    : null;

  return { id, label: a.label, days_logged: daysLogged, missed_days: missedDays, recent_avg: recentAvg, last_logged: lastDate, days_since_last: daysAgo };
}

/**
 * Build the full briefing for a device.
 * @returns {{ profile, domains, anchor, text }}
 *   text = the natural-language briefing block to inject into the system prompt.
 */
async function buildBriefing(deviceId, opts = {}) {
  const anchor = await resolveAnchor(deviceId);
  const win = computeAnalysisWindow(30, anchor.anchorMs, Date.now(), anchor.utcOffsetMinutes);

  const [uSnap, oSnap] = await Promise.all([
    userDoc(deviceId).get().catch(() => null),
    onboardingDoc(deviceId).get().catch(() => null),
  ]);
  const u = (uSnap && uSnap.exists ? uSnap.data() : {}) || {};
  const o = (oSnap && oSnap.exists ? oSnap.data() : {}) || {};

  const profile = {
    name: u.name || o.name || null,
    sex: o.sex || null,
    age_range: o.age_range || null,
    focus_domains: Array.isArray(u.focus_domains) && u.focus_domains.length ? u.focus_domains
      : (Array.isArray(o.focus_domains) ? o.focus_domains : []),
    goals: u.goals || [],
    fitness_goal: o.fitness_goal || null,
    nutrition_goal: o.nutrition_goal || null,
    mind_focus: o.mind_focus || null,
    goal_labels: Array.isArray(o.goal_labels) ? o.goal_labels : (Array.isArray(u.goals) ? u.goals : []),
    target_weight_kg: u.target_weight_kg || o.target_weight_kg || null,
    targets: u.targets || o.targets || null,
    sleep_schedule: u.sleep_schedule || (o.sleep_bedtime || o.sleep_wake ? { bedtime: o.sleep_bedtime || null, wake: o.sleep_wake || null } : null),
    registration_date: u.registration_date || anchor.anchorDateStr || null,
  };

  const active = profile.focus_domains.length ? profile.focus_domains : ['fitness', 'nutrition', 'sleep', 'water', 'mind', 'fasting'];
  // allSettled (not all): one slow/failing endpoint must NEVER block or break the whole briefing — the
  // coach still picks up promptly with whatever resolved. (Latency + robustness.)
  const settled = await Promise.allSettled([
    Promise.all(active.map((id) => domainSummary(deviceId, id, win.effectiveStartDate, win.todayDate, win.daysSinceAnchor))).then(r => r.filter(Boolean)),
    getLearnings(deviceId),
    fetchJson(`${SELF}/api/bc-plans/today?deviceId=${encodeURIComponent(deviceId)}`),
    getRecentCallContext(deviceId, 3),
    // Cross-agent connections — so the coach KNOWS the moat ("your sleep drives your mood") the moment it
    // picks up, instead of having to make a mid-call tool round-trip to discover it.
    fetchJson(`${SELF}/api/wellness-combined?deviceId=${encodeURIComponent(deviceId)}&range=30`),
  ]);
  const val = (i, d) => (settled[i].status === 'fulfilled' && settled[i].value != null ? settled[i].value : d);
  const domains = val(0, []);
  const learnings = val(1, []);
  const plansResp = val(2, null);
  const recentCalls = val(3, []);
  const crossResp = val(4, null);

  let text = composeBriefingText(profile, domains, win, learnings);

  // Cross-agent connections (the synthesized champion/drag/link lines from the combined engine) — the
  // single most valuable grounding, woven in up front so the coach reasons across domains, not in silos.
  const ct = crossText(crossResp);
  if (ct) text += '\n' + ct;

  // Past conversations → continuity. The coach knows what it already covered, so it builds on it
  // instead of repeating, and can call back ("last time we talked about…") naturally.
  const rc = recentCallsText(recentCalls);
  if (rc) text += '\n' + rc;

  // Their active plans + today's progress — so the coach knows their commitments and what's still undone.
  const pt = plansText(plansResp);
  if (pt) text += '\n' + pt;

  // Their OWN uploaded workout plan (parsed from the photo they snapped in onboarding) — the coach
  // references their actual program instead of guessing.
  try {
    const fsnap = await AGENT_DOC(deviceId, 'fitness').get();
    const up = (fsnap.exists && fsnap.data().uploaded_plan) || {};
    if (up.parsed) {
      text += `\nTHEIR OWN WORKOUT PLAN (they uploaded this — build on it, reference their exact days/exercises, don't invent a different one):\n${String(up.parsed).slice(0, 1200)}`;
    }
  } catch { /* no uploaded plan — fine */ }

  // Apple Health signals (recovery, sleep, steps, HRV, RHR, weight, workouts) — the coach speaks
  // from their REAL body data. Empty for users with no wearable (parity preserved).
  try {
    const hk = await healthSignalsText(deviceId);
    if (hk) text += '\n' + hk;
  } catch { /* no HK — fine */ }

  // Focused call → graft in that domain's REAL analysis so the coach knows their actual numbers.
  let focus = null;
  if (opts.focus && DOMAIN_SET.has(opts.focus)) {
    const a = await fetchJson(`${SELF}/api/${opts.focus}/analysis?deviceId=${encodeURIComponent(deviceId)}&range=30`);
    const dd = deepDiveText(opts.focus, a);
    if (dd) { text += '\n' + dd; focus = opts.focus; }
  }

  return { profile, domains, learnings, focus, anchor: { days_since_anchor: win.daysSinceAnchor, effective_days: win.effectiveDays, registration_date: profile.registration_date }, text };
}

// Turn the structured summary into the plain-language briefing the coach reads.
// Honest about a brand-new user (no fake history) — the anchor age is stated so
// the LLM never overclaims ("you've slipped for weeks" on a day-2 user).
function composeBriefingText(profile, domains, win, learnings = []) {
  const L = [];
  const who = [profile.name && `Name: ${profile.name}`, profile.sex && profile.sex, profile.age_range && `age ${profile.age_range}`].filter(Boolean).join(', ');
  if (who) L.push(`USER — ${who}.`);

  // What past calls taught us about this person — this is what makes the coach feel like it remembers.
  if (Array.isArray(learnings) && learnings.length) {
    L.push(`WHAT YOU'VE LEARNED ABOUT THEM (from past calls — use it, don't recite it):`);
    for (const l of learnings) L.push(`  • ${l}`);
  }

  const goalBits = [
    profile.fitness_goal && `fitness goal: ${arr(profile.fitness_goal)}`,
    profile.nutrition_goal && `nutrition goal: ${arr(profile.nutrition_goal)}`,
    profile.mind_focus && `mind focus: ${arr(profile.mind_focus)}`,
    profile.target_weight_kg && `target weight: ${profile.target_weight_kg}kg`,
  ].filter(Boolean);
  if (goalBits.length) L.push(`GOALS — ${goalBits.join('; ')}.`);
  if (Array.isArray(profile.goal_labels) && profile.goal_labels.length) L.push(`AREAS THEY WANT TO IMPROVE — ${profile.goal_labels.join(', ')}.`);
  if (profile.sleep_schedule && (profile.sleep_schedule.bedtime || profile.sleep_schedule.wake)) L.push(`SLEEP SCHEDULE — target bed ${profile.sleep_schedule.bedtime || '?'}, wake ${profile.sleep_schedule.wake || '?'}.`);
  if (profile.targets) {
    const t = profile.targets;
    const tb = [t.calories && `${t.calories} kcal`, t.protein && `${t.protein}g protein`, t.water && `${t.water}L water`].filter(Boolean).join(', ');
    if (tb) L.push(`DAILY TARGETS — ${tb}.`);
  }

  // How long they've been with us — controls how much "history" the coach may reference.
  const age = win.daysSinceAnchor;
  L.push(`TENURE — registered ${profile.registration_date || 'recently'}; this is day ${age} since signup. Do NOT reference any period longer than ${age} day(s) or invent past behavior.`);

  if (!domains.length) {
    L.push('ACTIVITY — no domains active yet.');
  } else {
    L.push('CURRENT STATE (since signup):');
    for (const d of domains) {
      if (!d.days_logged) {
        L.push(`  • ${cap(d.label)}: nothing logged yet — a great place to start them.`);
        continue;
      }
      const recency = d.days_since_last === 0 ? 'last logged today'
        : d.days_since_last === 1 ? 'last logged yesterday'
        : `last logged ${d.days_since_last} days ago`;
      const trend = d.recent_avg == null ? '' : `, recent quality ~${d.recent_avg}/100`;
      const miss = d.missed_days > 0 ? `, missed ${d.missed_days} of ${age} day(s)` : '';
      L.push(`  • ${cap(d.label)}: ${d.days_logged} day(s) logged${trend}${miss}, ${recency}.`);
    }
  }
  return L.join('\n');
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const arr = (v) => (Array.isArray(v) ? v.join(', ') : String(v)).replace(/_/g, ' ');

module.exports = { buildBriefing };
