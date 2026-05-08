/**
 * ranker.js — pick the "did you know" fact that best matches the user's
 * strongest measured cross-agent effect.
 *
 * Strategy:
 *   1. Take user's top_correlations (already cross-agent-ranked)
 *   2. Map each fact's eyebrow tag (SLEEP, MIND, NUTRITION...) to relevance
 *   3. Score each fact by overlap with the agents in the user's top correlation
 *   4. Return the highest-scored fact reshaped to FE pack:
 *        { headline, citation }
 *   5. Cold-start (no correlations): rotate through generic facts (existing
 *      shuffleByDay) so the user always sees something, never an empty card.
 *
 * NOTE: pure deterministic. LLM personalization (Phase 7b) can wrap this
 * later — the FE pack guarantee is a non-empty `did_you_know` field.
 */

'use strict';

const { LIBRARY, getLibraryFacts } = require('./library');

// Map an agent name to the eyebrow keyword(s) we'll search for in fact tags.
const AGENT_TO_KEYWORDS = {
  sleep:     ['SLEEP', 'RECOVERY'],
  mind:      ['MIND', 'COGNITION'],
  nutrition: ['NUTRITION'],
  fitness:   ['FITNESS', 'RECOVERY'],
  water:     ['WATER'],
  fasting:   ['FASTING'],
};

function factScoreForAgents(fact, agents) {
  if (!fact || !fact.eyebrow) return 0;
  const eyebrow = String(fact.eyebrow).toUpperCase();
  // Prefer multi-agent eyebrows (e.g. "SLEEP × MOOD") for cross-agent vibes
  let score = 0;
  for (const a of agents) {
    const kws = AGENT_TO_KEYWORDS[a] || [];
    for (const kw of kws) {
      if (eyebrow.includes(kw)) score += 1;
    }
  }
  // Bonus when eyebrow contains '×' (true cross-agent fact like "SLEEP × MOOD")
  if (eyebrow.includes('×')) score += 0.5;
  return score;
}

/**
 * Pick the best-fit fact for the user's current cross-agent state.
 *
 * @param {Object} args
 * @param {Array}  args.topCorrelations  - already-ranked cross-agent edges
 * @param {string} [args.dateKey]         - 'YYYY-MM-DD' for stable daily rotation
 * @returns {{ headline: string, citation: string } | null}
 */
function pickDidYouKnow({ topCorrelations, dateKey }) {
  if (!Array.isArray(LIBRARY) || LIBRARY.length === 0) return null;

  // 1. Try to find a fact that matches the user's strongest cross-agent pair
  if (Array.isArray(topCorrelations) && topCorrelations.length > 0) {
    const top = topCorrelations[0];
    const agents = (top && Array.isArray(top.agents) && top.agents.length === 2) ? top.agents : null;
    if (agents) {
      const ranked = LIBRARY
        .map((f) => ({ f, s: factScoreForAgents(f, agents) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s);
      if (ranked.length > 0) {
        return shapeForPack(ranked[0].f);
      }
    }
  }

  // 2. Fallback — rotate through library by day so it stays fresh
  const fact = pickRotatingFact(dateKey);
  return shapeForPack(fact);
}

function shapeForPack(fact) {
  if (!fact) return null;
  return {
    headline: fact.body,
    citation: fact.source,
  };
}

function pickRotatingFact(dateKey) {
  // Stable selection per day (hash dateKey → index). Falls back to first lib entry.
  if (!dateKey || typeof dateKey !== 'string') {
    return LIBRARY[0];
  }
  let h = 0;
  for (let i = 0; i < dateKey.length; i++) {
    h = ((h << 5) - h + dateKey.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(h) % LIBRARY.length;
  return LIBRARY[idx];
}

module.exports = { pickDidYouKnow, factScoreForAgents, _internal: { LIBRARY, getLibraryFacts } };
