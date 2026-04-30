'use strict';
// ════════════════════════════════════════════════════════════════════
// translate-insight.js — turn every backend stat term into plain English.
// Pure function. No LLM. Used everywhere user-facing text is built.
// Enforces 8th-grade reading level (Spiegelhalter 2017, IOM 2004).
// ════════════════════════════════════════════════════════════════════

// Severity ladder for correlation strength (Cohen 1988 mapped to plain words)
function strengthOfR(absR) {
  if (absR >= 0.5) return 'strong';
  if (absR >= 0.3) return 'clear';
  if (absR >= 0.2) return 'early';
  return 'weak';
}

// Days-progress to a confirmation milestone (n=30 default)
function progressLabel(n, target = 30) {
  if (!n || n <= 0) return 'just started';
  const ratio = n / target;
  if (ratio >= 1) return 'fully confirmed';
  if (ratio >= 0.66) return 'almost confirmed';
  if (ratio >= 0.33) return 'about a third of the way';
  return 'early signal';
}

// Cohen's d → plain
function effectSizeLabel(d) {
  const a = Math.abs(d);
  if (a >= 0.8) return 'big effect';
  if (a >= 0.5) return 'noticeable effect';
  if (a >= 0.3) return 'small but real effect';
  return 'subtle';
}

// Days, hours, minutes, ml, percentages — keep simple
function timeAgo(hoursSince) {
  if (hoursSince == null) return null;
  if (hoursSince < 1) return 'just now';
  if (hoursSince < 24) return `${Math.round(hoursSince)} hours ago`;
  const d = Math.round(hoursSince / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

function frequency(n, outOf) {
  if (!n) return 'never';
  if (outOf && outOf > 0) return `${n} of the last ${outOf} times`;
  return `${n} ${n === 1 ? 'time' : 'times'}`;
}

// MAIN: convert any signal into a small object of human strings
function humanize(signal) {
  if (!signal || typeof signal !== 'object') return { text: '' };

  // Correlation
  if (signal.r != null && signal.n != null) {
    const strength = strengthOfR(Math.abs(signal.r));
    const progress = progressLabel(signal.n);
    const direction = signal.r >= 0 ? 'lifts' : 'drags down';
    const aLabel = AGENT_VERBS[signal.a]?.subj || signal.a;
    const bLabel = AGENT_VERBS[signal.b]?.obj  || signal.b;
    return {
      text: `Your ${aLabel} ${direction} your ${bLabel}`,
      meta: `${strength} link, ${progress}`,
      progress_pct: Math.min(100, Math.round((signal.n / 30) * 100)),
    };
  }

  // Effect size (Cohen's d)
  if (signal.d != null) {
    const label = effectSizeLabel(signal.d);
    return { text: label, _kind: 'effect_size' };
  }

  // Co-occurrence count
  if (signal.co_occurrence != null) {
    return {
      text: `I've spotted this ${frequency(signal.co_occurrence)} now`,
      _kind: 'co_occurrence',
    };
  }

  // Hours since
  if (signal.hours_since != null) {
    return { text: timeAgo(signal.hours_since), _kind: 'time_ago' };
  }

  // Hydration / percentage
  if (signal.percentage != null) {
    return { text: `${signal.percentage}% ${signal.of || ''}`.trim() };
  }

  // Sleep duration
  if (signal.duration_h != null) {
    return { text: `${signal.duration_h.toFixed ? signal.duration_h.toFixed(1) : signal.duration_h}h` };
  }

  // Streak
  if (signal.streak_days != null) {
    return { text: `${signal.streak_days}-day streak` };
  }

  // Skip count
  if (signal.skipped_count != null) {
    return { text: frequency(signal.skipped_count) + ' skipped' };
  }

  return { text: signal.text || '' };
}

// Plain agent-name verb forms used in correlation sentences
const AGENT_VERBS = {
  sleep:     { subj: 'sleep',     obj: 'mood',      action: 'rest' },
  mind:      { subj: 'mood',      obj: 'energy',    action: 'check in' },
  fitness:   { subj: 'training',  obj: 'sleep',     action: 'movement' },
  nutrition: { subj: 'eating',    obj: 'energy',    action: 'meal' },
  water:     { subj: 'hydration', obj: 'mood',      action: 'water' },
  fasting:   { subj: 'fasting',   obj: 'energy',    action: 'fast' },
};

// JARGON OUTPUT SCANNER — used by assistant-llm to enforce plain language
const JARGON_PATTERNS = [
  /\br\s*=\s*[\d.]+/gi,
  /\bn\s*=\s*\d+/gi,
  /\bp\s*[<>=]\s*[\d.]+/gi,
  /\bp[-_ ]?value\b/gi,
  /\bcohen'?s?\s*d/gi,
  /\beffect[-\s]?size\b/gi,
  /\bcorrelat(ion|ed|es)\b/gi,
  /\bregress(ion|ed)\b/gi,
  /\bstatistical(ly)?\b/gi,
  /\bsignifican(t|ce)\b/gi,
  /\bbonferroni\b/gi,
  /\bpearson\b/gi,
  /\bstandard\s*deviation\b/gi,
  /\bconfidence\s*interval\b/gi,
  /\bnull\s*hypothesis\b/gi,
];

function containsJargon(text) {
  if (!text) return false;
  for (const p of JARGON_PATTERNS) if (p.test(text)) return true;
  return false;
}

function stripJargon(text) {
  if (!text) return '';
  let out = text;
  out = out.replace(/\br\s*=\s*[\d.]+/gi, 'a clear pattern');
  out = out.replace(/\bn\s*=\s*\d+/gi, '');
  out = out.replace(/\bp\s*[<>=]\s*[\d.]+/gi, '');
  out = out.replace(/\bp[-_ ]?value\b/gi, '');
  out = out.replace(/\bcohen'?s?\s*d\s*=?\s*[\d.]*/gi, 'a strong effect');
  out = out.replace(/\bcorrelat(ion|ed|es)\b/gi, 'pattern');
  out = out.replace(/\bstatistical(ly)?\s+significan(t|ce)\b/gi, 'real');
  out = out.replace(/\bsignifican(t|ce)\b/gi, 'real');
  out = out.replace(/\bbonferroni\b/gi, '');
  out = out.replace(/\bpearson\b/gi, '');
  out = out.replace(/\(\s*\)/g, '');
  out = out.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:])/g, '$1').trim();
  return out;
}

module.exports = {
  humanize,
  strengthOfR,
  progressLabel,
  effectSizeLabel,
  timeAgo,
  frequency,
  containsJargon,
  stripJargon,
  AGENT_VERBS,
};
