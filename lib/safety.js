'use strict';
// ════════════════════════════════════════════════════════════════════
// safety.js — crisis-keyword routing for the Mind agent.
// Used by chat + checkin handlers. Never silent — always escalates with
// region-aware hotline + resource links.
// ════════════════════════════════════════════════════════════════════

// Keyword set is intentionally conservative — we'd rather show resources
// once too often than miss a real distress signal. Multi-word matches are
// preferred so casual usage ("kill the deal") isn't tripped.
const CRISIS_PATTERNS = [
  /\b(kill\s+myself|end\s+(my\s+)?life|take\s+my\s+(own\s+)?life)\b/i,
  /\b(suicid(e|al|ality)|self[- ]?harm)\b/i,
  /\b(cut(ting)?\s+(myself|my\s+)?(arms?|legs?|wrists?))\b/i,
  /\b(don'?t\s+want\s+to\s+(live|exist|wake\s+up))\b/i,
  /\b(better\s+off\s+(without\s+me|dead))\b/i,
  /\b(no\s+(reason|point)\s+to\s+(live|go\s+on))\b/i,
  /\b(plan\s+to\s+(end|hurt))\b/i,
  /\b(overdose|hang\s+myself)\b/i,
];

// Region-specific hotlines. Keyed by ISO-3166 country code.
const HOTLINES = {
  US: { hotline: '988', label: '988 Suicide & Crisis Lifeline', url: 'https://988lifeline.org' },
  CA: { hotline: '988', label: '988 (Canada)', url: 'https://988.ca' },
  GB: { hotline: '116 123', label: 'Samaritans UK', url: 'https://www.samaritans.org' },
  IE: { hotline: '116 123', label: 'Samaritans Ireland', url: 'https://www.samaritans.org' },
  IN: { hotline: '9152987821', label: 'iCall India', url: 'https://icallhelpline.org' },
  AU: { hotline: '13 11 14', label: 'Lifeline AU', url: 'https://www.lifeline.org.au' },
  NZ: { hotline: '1737', label: 'Need to Talk?', url: 'https://1737.org.nz' },
  DEFAULT: { hotline: '988 (US) / 116 123 (UK)', label: 'Crisis support', url: 'https://findahelpline.com' },
};

// Returns null if no crisis content. Returns a structured response otherwise.
function detectCrisis(text) {
  if (!text || typeof text !== 'string') return null;
  for (const pattern of CRISIS_PATTERNS) {
    if (pattern.test(text)) {
      return {
        matched:  pattern.source,
        severity: 'critical',
      };
    }
  }
  return null;
}

function hotlineFor(region) {
  if (!region) return HOTLINES.DEFAULT;
  return HOTLINES[String(region).toUpperCase()] || HOTLINES.DEFAULT;
}

// Build a kind, non-clinical reply text for a crisis match.
// This is the ONE response — never fall through to GPT-4o on a critical match.
function crisisReply(region) {
  const h = hotlineFor(region);
  return [
    `I hear how heavy this is right now, and I'm glad you reached out — you don't have to carry it alone.`,
    `Please contact ${h.label} (${h.hotline}) — they can help right now, in this moment.`,
    `I'll be here when you're ready to talk more.`,
  ].join(' ');
}

// Same data shape returned for both chat + reframe paths so callers can
// hand it straight to the response without branching.
function crisisEnvelope(region) {
  const h = hotlineFor(region);
  return {
    is_crisis: true,
    reply:     crisisReply(region),
    hotline:   h.hotline,
    label:     h.label,
    url:       h.url,
  };
}

module.exports = {
  detectCrisis,
  hotlineFor,
  crisisReply,
  crisisEnvelope,
  CRISIS_PATTERNS,
  HOTLINES,
};
