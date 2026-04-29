'use strict';
// ════════════════════════════════════════════════════════════════════
// cross-agent-context.js — builds a rich behavioral bundle for any
// LLM call. Reads every available signal: logs, actions, chats,
// setup state, engagement patterns, themes, hypotheses.
// ════════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');
const { buildPriorBundle } = require('./population-priors');

const db        = () => admin.firestore();
const userDoc   = (id) => db().collection('wellness_users').doc(id);
const agentDoc  = (id, a) => userDoc(id).collection('agents').doc(a);

const millis = (ts) => {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts._seconds) return ts._seconds * 1000;
  return new Date(ts).getTime() || 0;
};
const dateStr = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
const safe = async (p, fb) => { try { return await p; } catch { return fb; } };

const AGENTS = ['fitness', 'sleep', 'mind', 'nutrition', 'water', 'fasting'];

// Per-agent log collection name + key field name
const AGENT_LOGS = {
  fitness:   { col: 'fitness_workouts',  ts: 'logged_at' },
  sleep:     { col: 'sleep_logs',        ts: 'logged_at' },
  mind:      { col: 'mind_checkins',     ts: 'logged_at' },
  nutrition: { col: 'food_logs',         ts: 'logged_at' },
  water:     { col: 'water_logs',        ts: 'logged_at' },
  fasting:   { col: 'fasting_sessions',  ts: 'started_at' },
};

async function fetchAgentSnapshot(deviceId, agent, days = 14) {
  const conf = AGENT_LOGS[agent];
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - days * 86400000);
  const logsSnap = await safe(
    agentDoc(deviceId, agent).collection(conf.col)
      .where(conf.ts, '>=', cutoff).orderBy(conf.ts, 'desc').limit(60).get(),
    { docs: [] }
  );
  const actionsSnap = await safe(
    agentDoc(deviceId, agent).collection(`${agent}_actions`)
      .orderBy('generated_at', 'desc').limit(15).get(),
    { docs: [] }
  );
  const chatsSnap = await safe(
    agentDoc(deviceId, agent).collection(`${agent}_chats`)
      .orderBy('created_at', 'desc').limit(20).get(),
    { docs: [] }
  );
  const setupSnap = await safe(agentDoc(deviceId, agent).get(), null);

  const logs    = logsSnap.docs ? logsSnap.docs.map(d => ({ id: d.id, ...d.data() })) : [];
  const actions = actionsSnap.docs ? actionsSnap.docs.map(d => ({ id: d.id, ...d.data() })) : [];
  const chats   = chatsSnap.docs ? chatsSnap.docs.map(d => ({ id: d.id, ...d.data() })) : [];
  const setup   = setupSnap?.exists ? setupSnap.data() : null;

  return { logs, actions, chats, setup, has_setup: !!setup };
}

// Compact a log to the fields the LLM actually needs
function compactLog(agent, log) {
  const base = { date: log.date_str || dateStr(millis(log.logged_at || log.started_at)) };
  switch (agent) {
    case 'sleep':
      return { ...base, quality: log.sleep_quality, duration_h: log.duration_min ? Math.round(log.duration_min / 60 * 10) / 10 : null, note: log.note?.slice(0, 80) };
    case 'mind':
      return { ...base, mood: log.mood, mood_score: log.mood_score, anxiety: log.anxiety, emotions: log.emotions, note: log.note?.slice(0, 80) };
    case 'water':
      return { ...base, ml: log.amount_ml || log.effective_ml };
    case 'nutrition':
      return { ...base, kcal: log.calories, protein_g: log.protein, meal: log.meal_type };
    case 'fitness':
      return { ...base, duration_min: log.duration_min, sets: (log.exercises || []).reduce((s, e) => s + (e.sets || []).length, 0), note: log.note?.slice(0, 80) };
    case 'fasting':
      return { ...base, planned_h: log.planned_hours, actual_h: log.actual_hours, completed: log.completed, broken_reason: log.broken_reason };
    default: return base;
  }
}
function compactAction(a) {
  return { title: a.title, status: a.status, agent: a.agent, skip_reason: a.skip_reason, completed_at: a.completed_at ? dateStr(millis(a.completed_at)) : null };
}
function compactChat(c) {
  return { role: c.role || (c.from_user ? 'user' : 'assistant'), text: (c.content || c.text || '').slice(0, 200), at: dateStr(millis(c.created_at)) };
}

async function buildContext(deviceId, opts = {}) {
  const days = opts.days || 14;
  const profileSnap = await safe(userDoc(deviceId).get(), null);
  const profile = profileSnap?.exists ? profileSnap.data() : {};

  const anchorSnap = await safe(userDoc(deviceId).collection('wellness_meta').doc('cold_start_anchor').get(), null);
  const cold_start_anchor = anchorSnap?.exists ? anchorSnap.data().value : null;

  const engagementSnap = await safe(userDoc(deviceId).collection('wellness_meta').doc('engagement').get(), null);
  const engagement = engagementSnap?.exists ? engagementSnap.data() : {};

  const themesSnap = await safe(userDoc(deviceId).collection('wellness_meta').doc('themes').get(), null);
  const themes = themesSnap?.exists ? themesSnap.data() : { dominant: [] };

  const hypothesesSnap = await safe(userDoc(deviceId).collection('wellness_meta').doc('hypotheses').get(), null);
  const hypotheses = hypothesesSnap?.exists ? (hypothesesSnap.data().active || []) : [];

  // Per-agent snapshots in parallel
  const agentEntries = await Promise.all(AGENTS.map(async a => {
    const snap = await fetchAgentSnapshot(deviceId, a, days);
    return [a, snap];
  }));
  const agents = Object.fromEntries(agentEntries);

  const setup_state = Object.fromEntries(AGENTS.map(a => [a, agents[a].has_setup ? 'setup' : 'unset']));
  const setup_count = Object.values(setup_state).filter(s => s === 'setup').length;

  // Compact logs for LLM
  const recent_logs = Object.fromEntries(AGENTS.map(a => [a, agents[a].logs.slice(0, 14).map(l => compactLog(a, l))]));
  const recent_actions = Object.fromEntries(AGENTS.map(a => [a, agents[a].actions.slice(0, 8).map(compactAction)]));
  const recent_chats   = Object.fromEntries(AGENTS.map(a => [a, agents[a].chats.slice(0, 8).map(compactChat).reverse()]));

  // Total log count
  const total_logs = Object.values(recent_logs).reduce((s, arr) => s + arr.length, 0);
  const days_with_any_log = (() => {
    const dates = new Set();
    for (const a of AGENTS) for (const l of recent_logs[a]) if (l.date) dates.add(l.date);
    return dates.size;
  })();

  // Skip-reason summary
  const skip_reasons = {};
  for (const a of AGENTS) {
    for (const act of agents[a].actions) {
      if (act.status === 'skipped' && act.skip_reason) {
        skip_reasons[act.skip_reason] = (skip_reasons[act.skip_reason] || 0) + 1;
      }
    }
  }

  // Action completion rate (7 days)
  let completed = 0, total = 0;
  for (const a of AGENTS) {
    for (const act of agents[a].actions) {
      if (!act.status) continue;
      total += 1;
      if (act.status === 'completed') completed += 1;
    }
  }
  const action_completion_rate = total > 0 ? Math.round((completed / total) * 100) / 100 : null;

  const priors = buildPriorBundle({
    ageGroup: profile.ageGroup || profile.age_group,
    gender:   profile.gender,
  });

  const joinedAtMs = profile.created_at ? millis(profile.created_at) : null;

  return {
    profile: {
      name: profile.name,
      age_group: profile.ageGroup || profile.age_group,
      gender: profile.gender,
      primary_coach: profile.primaryCoach || profile.primary_coach,
      cold_start_anchor,
      days_since_join: joinedAtMs ? Math.floor((Date.now() - joinedAtMs) / 86400000) : null,
    },
    joined_at: joinedAtMs ? new Date(joinedAtMs).toISOString().slice(0, 10) : null,
    setup_state,
    setup_count,
    recent_logs,
    recent_actions,
    recent_chats,
    skip_reasons,
    action_completion_rate,
    total_logs,
    days_with_any_log,
    engagement,
    themes,
    hypotheses,
    priors,
    today: dateStr(Date.now()),
    asked_at: Date.now(),
  };
}

module.exports = { buildContext, compactLog, fetchAgentSnapshot, AGENTS };
