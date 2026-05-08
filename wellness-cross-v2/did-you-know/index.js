/**
 * did-you-know/index.js
 * Builds the final did_you_know array for the home pack.
 * Combines personal insights + library fallback. LLM polish is layered later (orchestrator step).
 */

const { buildPersonalInsights } = require('./personal-insights');
const { getLibraryFacts } = require('./library');

const TARGET_TOTAL = 6;
const MIN_PERSONAL = 0; // accept zero personal — library carries

function buildDidYouKnow({ pack, snapshots, top_correlations, streaks, wellness }) {
  const personal = buildPersonalInsights({
    pack, snapshots, top_correlations, streaks, wellness,
  });
  const remaining = Math.max(0, TARGET_TOTAL - personal.length);
  const library = remaining > 0 ? getLibraryFacts(remaining) : [];
  // Mark library facts as personal=false for FE styling
  const libMarked = library.map((l) => ({ ...l, personal: false }));
  const persMarked = personal.map((p) => ({ ...p, personal: true }));
  return [...persMarked, ...libMarked].slice(0, TARGET_TOTAL);
}

module.exports = { buildDidYouKnow, TARGET_TOTAL };
