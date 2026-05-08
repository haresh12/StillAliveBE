/**
 * score-explainer.js
 * Builds the structured input for the LLM why-line + a deterministic fallback.
 * The LLM call itself lives in orchestrator/executor.js; this module just shapes input/output.
 */

function explainerInput(wellness) {
  const top = wellness.components.filter((c) => c.is_top_contributor);
  return {
    score: wellness.score,
    delta_vs_yesterday: wellness.delta_vs_yesterday,
    delta_vs_7d_avg: wellness.delta_vs_7d_avg,
    is_warm_start: wellness.is_warm_start,
    top_contributors: top.map((c) => ({
      agent: c.agent,
      score: c.score,
      delta_vs_baseline: c.delta_vs_baseline,
      contribution_pts: c.contribution_pts,
      weight: Math.round(c.weight * 100) / 100,
    })),
  };
}

/**
 * Deterministic fallback if the LLM why-line is rejected by the validator.
 */
function fallbackWhyLine(wellness) {
  if (wellness.is_warm_start) {
    return null; // No verbose "calibrating" text — UI shows confidence band visually.
  }
  const top = wellness.components.filter((c) => c.is_top_contributor);
  if (top.length === 0) return null;

  const lead = top.reduce((best, c) =>
    Math.abs(c.contribution_pts) > Math.abs(best.contribution_pts) ? c : best,
  );
  const dir = lead.delta_vs_baseline >= 0 ? 'above' : 'below';
  const mag = Math.abs(Math.round(lead.delta_vs_baseline));
  const dy = wellness.delta_vs_yesterday;
  const dyTxt = dy === 0 ? 'flat today' : (dy > 0 ? `up ${dy} today` : `down ${Math.abs(dy)} today`);
  return `${dyTxt} — your ${lead.agent} is ${mag}pts ${dir} your usual.`;
}

module.exports = { explainerInput, fallbackWhyLine };
