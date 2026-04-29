'use strict';
// ════════════════════════════════════════════════════════════════════
// cross-agent-safety.js — clinical guardrails for every LLM output.
// 1. SYSTEM_SAFETY_PREFIX prepends every prompt.
// 2. scanInput() routes crisis text to deterministic crisis response.
// 3. scanOutput() blocks any medical-advice patterns from being shown.
// ════════════════════════════════════════════════════════════════════

const SYSTEM_SAFETY_PREFIX = `You are a wellness coach inside the StillAlive app, NOT a doctor or therapist. Hard rules:
- Never diagnose conditions. Never prescribe medication or supplements.
- Never claim certainty about medical risks ("you have X", "this means Y disease"). Use language like "may", "tends to", "research suggests".
- If the user mentions self-harm, suicidal thoughts, eating-disorder behaviors, or severe distress, refuse to coach and direct them to professional help. Output exactly: {"safety":"crisis","message":"Please talk to someone trained — text or call 988 (US) or visit findahelpline.com for your country."}
- For any concerning physical symptom (chest pain, fainting, persistent severe pain), recommend seeing a clinician — do not coach around it.
- Cite at least one specific user data point when making a personal claim. If you have no relevant data, say so.
- Maximum 60 words per response unless explicitly asked for longer.
- No emojis unless the user data warrants celebration. No "great job" / "amazing".`;

// ─── INPUT SCANNER ─────────────────────────────────────────────────
const CRISIS_PATTERNS = [
  /\b(kill\s+myself|suicid|end\s+my\s+life|don'?t\s+want\s+to\s+live|wanna\s+die|ending\s+it|hurt\s+myself|self\s*-?\s*harm)\b/i,
  /\b(starve\s+myself|purg(e|ing)|throw(ing)?\s+up\s+on\s+purpose|binge\s+and\s+purge)\b/i,
  /\b(can'?t\s+breathe|chest\s+pain.*now|fainted|passed\s+out)\b/i,
];

const CRISIS_RESPONSE = {
  safety: 'crisis',
  text: 'I want to make sure you get the right kind of help — I\'m not the right tool for this. Please reach out: 988 (US Suicide & Crisis Lifeline) or findahelpline.com for your country. You don\'t have to do this alone.',
  resources: [
    { label: '988 — call or text', url: 'tel:988', region: 'US' },
    { label: 'findahelpline.com',  url: 'https://findahelpline.com', region: 'global' },
    { label: 'Samaritans (UK)',    url: 'tel:116123', region: 'UK' },
  ],
};

function scanInput(userText) {
  if (!userText) return { safe: true };
  for (const pat of CRISIS_PATTERNS) {
    if (pat.test(userText)) return { safe: false, kind: 'crisis', response: CRISIS_RESPONSE };
  }
  return { safe: true };
}

// Also scan structured logs (notes fields) for crisis content
function scanContextForCrisis(ctx) {
  const sources = [];
  for (const agent of Object.keys(ctx.recent_logs || {})) {
    for (const log of ctx.recent_logs[agent]) {
      if (log.note) sources.push(log.note);
    }
    for (const chat of ctx.recent_chats?.[agent] || []) {
      if (chat.role === 'user' && chat.text) sources.push(chat.text);
    }
  }
  for (const text of sources) {
    const r = scanInput(text);
    if (!r.safe) return r;
  }
  return { safe: true };
}

// ─── OUTPUT SCANNER ────────────────────────────────────────────────
// Blocks unsafe medical claims that slip past the system prompt
const FORBIDDEN_OUTPUT = [
  /\byou\s+have\s+(depression|anxiety|adhd|bipolar|insomnia|diabetes|hypertension|cancer)\b/i,
  /\b(diagnose[ds]?|diagnosis)\b/i,
  /\b(should\s+take|recommend\s+taking)\s+(medication|drugs?|pills?|supplement|adderall|xanax|prozac|melatonin|ssri)/i,
  /\bI\s+am\s+a\s+doctor\b/i,
  /\bclinically\s+(diagnosed|proven|certified)\b/i,
];

function scanOutput(text) {
  if (!text) return { safe: true, text: '' };
  for (const pat of FORBIDDEN_OUTPUT) {
    if (pat.test(text)) {
      return {
        safe: false,
        text: 'I want to make sure I stay in my lane. For anything that might be a medical concern, please check with a clinician. Want me to focus on a specific habit instead?',
        blocked_pattern: pat.source,
      };
    }
  }
  return { safe: true, text };
}

module.exports = {
  SYSTEM_SAFETY_PREFIX,
  scanInput,
  scanContextForCrisis,
  scanOutput,
  CRISIS_RESPONSE,
};
