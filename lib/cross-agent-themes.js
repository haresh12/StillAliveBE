'use strict';
// ════════════════════════════════════════════════════════════════════
// cross-agent-themes.js — extracts dominant themes from free-text
// log notes and chat messages. Runs nightly via cron.
// ════════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');
const { OpenAI } = require('openai');
const { SYSTEM_SAFETY_PREFIX } = require('./cross-agent-safety');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const db        = () => admin.firestore();
const userDoc   = (id) => db().collection('wellness_users').doc(id);
const themesDoc = (id) => userDoc(id).collection('wellness_meta').doc('themes');

const THEMES_SYSTEM = `Extract 3-8 dominant themes from a user's wellness notes/chats. Each theme is 1-2 words.
Output JSON:
{ "themes":[{"label":"work_stress","mentions":4,"sentiment":"negative","sample":"work has been crazy"}], "confidence": 0.0-1.0 }
Only include themes with ≥2 mentions or 1 strong mention. No medical diagnoses.`;

async function extractThemes({ deviceId, texts }) {
  if (!texts.length) return null;
  const sample = texts.slice(0, 30).map(t => t.slice(0, 200)).join('\n---\n');
  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 350,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `${SYSTEM_SAFETY_PREFIX}\n\n${THEMES_SYSTEM}` },
        { role: 'user',   content: `Extract themes from these wellness notes/chats:\n${sample}` },
      ],
    });
    const parsed = JSON.parse(resp.choices[0].message.content);
    const dominant = (parsed.themes || []).filter(t => t.mentions >= 2 || (parsed.confidence || 0) >= 0.7).slice(0, 6);
    await themesDoc(deviceId).set({
      dominant,
      confidence: parsed.confidence || 0.6,
      generated_at: admin.firestore.FieldValue.serverTimestamp(),
      source_count: texts.length,
    });
    return { dominant, confidence: parsed.confidence };
  } catch (e) {
    console.warn('[themes]', e.message);
    return null;
  }
}

// Collects all free-text from logs + chats across agents
async function collectUserText(deviceId) {
  const out = [];
  const AGENTS = ['fitness', 'sleep', 'mind', 'nutrition', 'water', 'fasting'];
  const AGENT_LOGS = {
    fitness:'fitness_workouts', sleep:'sleep_logs', mind:'mind_checkins',
    nutrition:'food_logs', water:'water_logs', fasting:'fasting_sessions',
  };
  for (const agent of AGENTS) {
    try {
      const logs = await userDoc(deviceId).collection('agents').doc(agent).collection(AGENT_LOGS[agent])
        .orderBy(agent === 'fasting' ? 'started_at' : 'logged_at', 'desc').limit(40).get();
      logs.docs.forEach(d => { const note = d.data().note; if (note) out.push(note); });
      const chats = await userDoc(deviceId).collection('agents').doc(agent).collection(`${agent}_chats`)
        .orderBy('created_at', 'desc').limit(30).get();
      chats.docs.forEach(d => { const data = d.data(); if (data.role === 'user' && data.content) out.push(data.content); });
    } catch {}
  }
  return out;
}

module.exports = { extractThemes, collectUserText };
