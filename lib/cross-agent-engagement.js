'use strict';
// ════════════════════════════════════════════════════════════════════
// cross-agent-engagement.js — models user engagement & abandonment risk
// from action completion patterns, log frequency, chat activity.
// ════════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');
const userDoc      = (id) => admin.firestore().collection('wellness_users').doc(id);
const engagementDoc= (id) => userDoc(id).collection('wellness_meta').doc('engagement');

const AGENTS = ['fitness', 'sleep', 'mind', 'nutrition', 'water', 'fasting'];

function millis(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts._seconds) return ts._seconds * 1000;
  return new Date(ts).getTime() || 0;
}

async function computeEngagement(deviceId, ctx) {
  const last_active_per_agent = {};
  const log_count_30d = {};
  for (const agent of AGENTS) {
    const logs = ctx.recent_logs[agent] || [];
    if (logs.length === 0) {
      last_active_per_agent[agent] = null;
      log_count_30d[agent] = 0;
      continue;
    }
    last_active_per_agent[agent] = logs[0].date;
    log_count_30d[agent] = logs.length;
  }

  // Action completion 7d / skip reasons
  const skips = {};
  let acted = 0, total = 0;
  for (const agent of AGENTS) {
    for (const a of (ctx.recent_actions[agent] || [])) {
      if (!a.status) continue;
      total += 1;
      if (a.status === 'completed') acted += 1;
      if (a.status === 'skipped' && a.skip_reason) {
        skips[a.skip_reason] = (skips[a.skip_reason] || 0) + 1;
      }
    }
  }
  const action_complete_rate_7d = total > 0 ? acted / total : null;

  // Abandonment risk per agent: days since last log + setup state
  const abandonment_risk = {};
  for (const agent of AGENTS) {
    if (ctx.setup_state[agent] !== 'setup') {
      abandonment_risk[agent] = null;
      continue;
    }
    const last = last_active_per_agent[agent];
    if (!last) { abandonment_risk[agent] = 0.85; continue; }
    const daysSince = Math.floor((Date.now() - new Date(last).getTime()) / 86400000);
    abandonment_risk[agent] = Math.min(0.95, daysSince / 14);
  }

  // Preferred log time (mode of hours when logs were created — placeholder)
  const preferred_log_time = {};

  const payload = {
    last_active_per_agent,
    log_count_30d,
    action_complete_rate_7d,
    skip_reasons: skips,
    abandonment_risk,
    preferred_log_time,
    chat_messages_30d: AGENTS.reduce((s, a) => s + (ctx.recent_chats[a]?.length || 0), 0),
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  };
  await engagementDoc(deviceId).set(payload, { merge: true });
  return payload;
}

module.exports = { computeEngagement };
