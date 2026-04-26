"use strict";
// ════════════════════════════════════════════════════════════════
// SANDBOX — fail-fast guard against cross-agent data reads.
// Every agent's candidate-engine fn must pass through assertNoCrossAgent
// at module load. If a fn references another agent's collection path
// (e.g. fitness reading sleep_sessions), we throw immediately.
// ════════════════════════════════════════════════════════════════

const ALL_AGENTS = ["mind", "sleep", "fasting", "water", "nutrition", "fitness"];

const FORBIDDEN_PATTERNS_BY_AGENT = {
  mind:      ["sleep_sessions", "water_logs", "fasting_sessions", "nutrition_logs", "fitness_workouts"],
  sleep:     ["mind_logs", "water_logs", "fasting_sessions", "nutrition_logs", "fitness_workouts"],
  fasting:   ["mind_logs", "sleep_sessions", "water_logs", "nutrition_logs", "fitness_workouts"],
  water:     ["mind_logs", "sleep_sessions", "fasting_sessions", "nutrition_logs", "fitness_workouts"],
  nutrition: ["mind_logs", "sleep_sessions", "water_logs", "fasting_sessions", "fitness_workouts"],
  fitness:   ["mind_logs", "sleep_sessions", "water_logs", "fasting_sessions", "nutrition_logs"],
};

function assertNoCrossAgent(agentName, fn) {
  if (typeof fn !== "function") return;
  const src = fn.toString();
  const others = ALL_AGENTS.filter(a => a !== agentName);
  for (const other of others) {
    // Match: doc("other"), doc('other'), .collection("other_logs")
    const docRe = new RegExp(`\\.doc\\(['"]${other}['"]\\)`);
    if (docRe.test(src)) {
      throw new Error(
        `[sandbox] ${agentName} cross-agent leak: references doc("${other}") in candidate engine`,
      );
    }
  }
  const forbidden = FORBIDDEN_PATTERNS_BY_AGENT[agentName] || [];
  for (const pat of forbidden) {
    if (src.includes(pat)) {
      throw new Error(
        `[sandbox] ${agentName} cross-agent leak: references "${pat}" in candidate engine`,
      );
    }
  }
}

module.exports = { assertNoCrossAgent, ALL_AGENTS };
