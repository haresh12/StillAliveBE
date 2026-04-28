'use strict';
// ════════════════════════════════════════════════════════════════════
// assistant-memory.js — every shipped assistant message logged with
// outcome grading. The follow-up detector reads recent memory to
// produce continuity messages: "yesterday I said X — what happened?"
// ════════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');

const userDoc  = (id) => admin.firestore().collection('wellness_users').doc(id);
const memCol   = (id) => userDoc(id).collection('wellness_assistant_memory');

// Persist a message we showed the user
async function recordShown(deviceId, msg) {
  if (!deviceId || !msg?.id) return;
  const today = new Date().toISOString().slice(0, 10);
  const docId = `${today}_${msg.id}`;
  await memCol(deviceId).doc(docId).set({
    msg_id: msg.id,
    category: msg.category,
    date: today,
    text: msg.text || msg.raw_text,
    action: msg.action || null,
    action_completed_at: null,
    outcome_score: null,
    shown_at: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

// Mark action completed (called when user actually taps the CTA)
async function markActionCompleted(deviceId, msgId) {
  const today = new Date().toISOString().slice(0, 10);
  const docId = `${today}_${msgId}`;
  await memCol(deviceId).doc(docId).set({
    action_completed_at: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

// Read recent memory (last 7 days)
async function getRecentMemory(deviceId) {
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 7 * 86400000);
  try {
    const snap = await memCol(deviceId)
      .where('shown_at', '>=', cutoff)
      .orderBy('shown_at', 'desc').limit(20).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch { return []; }
}

// FOLLOW-UP detector — reads memory; emits at most one message
// referencing a prior recommendation and what happened since.
async function buildFollowUp(ctx, deviceId) {
  const memory = await getRecentMemory(deviceId);
  if (!memory.length) return null;
  const today = new Date().toISOString().slice(0, 10);

  // Find the most recent ACTION-bearing message that's not from today
  const target = memory.find(m => m.action && m.date !== today);
  if (!target) return null;

  // Check if the action was completed (user tapped CTA later)
  const completed = !!target.action_completed_at;

  // See if the relevant agent has improved
  const agent = target.action?.agent;
  const today_log = agent ? (ctx.recent_logs[agent] || []).find(l => l.date === today) : null;
  const yesterday_log = agent ? (ctx.recent_logs[agent] || []).find(l => l.date === target.date) : null;

  let text;
  if (completed && today_log) {
    text = `Yesterday I asked you to ${(target.action.label || '').toLowerCase()}. You did. ${capitalize(agent)} is showing today — keep the streak.`;
  } else if (completed && !today_log) {
    text = `Yesterday I asked about ${target.action.label?.toLowerCase()}. You followed through, but no ${agent} log today yet — close the loop.`;
  } else if (!completed) {
    const daysAgo = Math.max(1, Math.floor((Date.now() - new Date(target.date).getTime()) / 86400000));
    text = `${daysAgo} ${daysAgo === 1 ? 'day' : 'days'} back I flagged something on ${agent}. No follow-through yet — small move now still counts.`;
  } else {
    return null;
  }

  return {
    id: `followup_${target.msg_id}`,
    category: completed ? 'notice_win' : 'check_in',
    icon: completed ? '✨' : '💬',
    priority: 75,
    raw_text: text,
    action: target.action,
    evidence_summary: 'Carrying the thread forward from earlier this week.',
    agents_used: agent ? [agent] : [],
  };
}

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

module.exports = { recordShown, markActionCompleted, getRecentMemory, buildFollowUp };
