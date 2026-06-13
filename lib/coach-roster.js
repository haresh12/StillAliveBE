'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// coach-roster.js — the 6 selectable coaches, backend mirror of the app's
// src/bigchange/coach/roster.ts. The user picks one in onboarding (or Settings);
// we store coach_id/coach_name on their user doc. This maps coach_id →
//   { name, persona, voice }
// so the voice call + chat speak in THAT coach's personality and a matched
// OpenAI Realtime voice. Keep `persona` in sync with the app roster.
// ═══════════════════════════════════════════════════════════════════════════

// OpenAI Realtime voices chosen to fit each coach's vibe (all valid GA voices).
const ROSTER = {
  nova:  { name: 'Nova',  voice: 'marin',   persona: 'warm, supportive and patient; celebrates small wins, never judgmental, encourages gently but consistently' },
  titan: { name: 'Titan', voice: 'cedar',   persona: 'direct and no-nonsense; tough-love accountability, straight talk, pushes you and calls out excuses kindly but firmly' },
  echo:  { name: 'Echo',  voice: 'coral',   persona: 'empathetic and deeply attentive; listens, asks gentle questions, helps untangle stress, then nudges toward action' },
  spark: { name: 'Spark', voice: 'verse',   persona: 'high-energy and playful; turns goals into fun challenges, celebrates loudly, makes progress feel exciting' },
  sage:  { name: 'Sage',  voice: 'sage',    persona: 'calm, wise and strategic; data-driven, explains the why, focuses on recovery, sleep and the smart long game' },
  luna:  { name: 'Luna',  voice: 'shimmer', persona: 'warm, caring and protective; adapts to how you feel, gentle accountability, protects your energy and wellbeing' },
};

const DEFAULT = { name: 'Ava', voice: process.env.VOICE_REALTIME_VOICE || 'marin', persona: 'warm, sharp and genuinely caring; a great coach who knows you and tells it straight with heart' };

/**
 * Resolve the coach config for a user. coachId comes from the user doc; coachName lets a custom
 * stored name override the roster default. An unknown id (e.g. legacy 'ava') falls back to DEFAULT.
 */
function getCoach(coachId, coachName) {
  const base = (coachId && ROSTER[coachId]) ? ROSTER[coachId] : DEFAULT;
  return {
    name: (coachName && String(coachName).trim()) || base.name,
    voice: base.voice,
    persona: base.persona,
  };
}

module.exports = { getCoach, ROSTER };
