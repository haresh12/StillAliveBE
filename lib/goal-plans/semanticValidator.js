'use strict';
// ════════════════════════════════════════════════════════════════════════
// goal-plans/semanticValidator.js — POST-generation quality probe.
//
// Schema validation already happens in validate.js. This file catches the
// stuff a JSON schema can't: contradictions between days, repetition across
// batches, and clear violations of the user's stated constraints.
//
// IMPORTANT: this is a *probe*, not a gate. It returns a `{ ok, warnings[] }`
// shape — callers log warnings via telemetry but never reject the plan.
// Rejecting a plan over a semantic warning would be a worse UX than
// shipping a slightly imperfect plan that the user can still complete.
// ════════════════════════════════════════════════════════════════════════

const DIETARY_VETOES = [
  // each row: [trigger answer-substrings, forbidden substrings in titles]
  { triggers: ['vegan'],          forbidden: ['chicken', 'beef', 'pork', 'fish', 'tuna', 'salmon', 'turkey', 'eggs', 'dairy', 'cheese', 'milk', 'yogurt'] },
  { triggers: ['vegetarian'],     forbidden: ['chicken', 'beef', 'pork', 'fish', 'tuna', 'salmon', 'turkey'] },
  { triggers: ['no dairy', 'lactose'], forbidden: ['dairy', 'cheese', 'milk', 'yogurt'] },
  { triggers: ['no gluten', 'gluten-free', 'celiac'], forbidden: ['bread', 'pasta', 'wheat', 'oats'] },
  { triggers: ['no caffeine'],    forbidden: ['coffee', 'espresso', 'caffeine'] },
];

function _norm(s) { return String(s || '').toLowerCase(); }

function _collectAnswers(answers) {
  if (!Array.isArray(answers)) return '';
  return answers.map((a) => `${a.id}: ${a.value}`).join(' | ').toLowerCase();
}

/**
 * Run semantic checks on the assembled plan. Returns:
 *   { ok: boolean, warnings: string[] }
 *
 * Caller logs warnings to telemetry. ok=false signals a high-severity issue
 * (wrong day count, no items at all) — caller may opt to surface to the user.
 */
function validatePlan(plan, { answers } = {}) {
  const warnings = [];
  if (!plan || !Array.isArray(plan.days)) return { ok: false, warnings: ['plan.days missing'] };

  // 1. day count matches duration
  if (plan.duration_days && plan.days.length !== plan.duration_days) {
    warnings.push(`day_count_mismatch: expected ${plan.duration_days}, got ${plan.days.length}`);
  }

  // 2. day_index sequence is monotonic and complete
  for (let i = 0; i < plan.days.length; i++) {
    const expected = i + 1;
    if (plan.days[i].day_index !== expected) {
      warnings.push(`day_index_drift at position ${i}: expected ${expected}, got ${plan.days[i].day_index}`);
      break; // one warning per plan is enough
    }
  }

  // 3. every day has at least 1 item
  const emptyDays = plan.days.filter((d) => !Array.isArray(d.items) || d.items.length === 0);
  if (emptyDays.length) {
    warnings.push(`empty_days: ${emptyDays.length} day(s) have no items`);
  }

  // 4. repetition across days (more than 35% of items share a title)
  const allTitles = plan.days.flatMap((d) => (d.items || []).map((it) => _norm(it.title)));
  if (allTitles.length > 0) {
    const counts = new Map();
    for (const t of allTitles) counts.set(t, (counts.get(t) || 0) + 1);
    const duplicates = [...counts.entries()].filter(([_, n]) => n >= 3);
    if (duplicates.length) {
      const repetitionRate = duplicates.reduce((s, [, n]) => s + n, 0) / allTitles.length;
      if (repetitionRate > 0.35) {
        warnings.push(`high_repetition: ${(repetitionRate * 100).toFixed(0)}% of items share titles (top: ${duplicates.slice(0, 3).map(([t, n]) => `"${t}"×${n}`).join(', ')})`);
      }
    }
  }

  // 5. dietary constraint violations from answers
  const answersBlob = _collectAnswers(answers);
  if (answersBlob) {
    for (const { triggers, forbidden } of DIETARY_VETOES) {
      const hit = triggers.some((t) => answersBlob.includes(t));
      if (!hit) continue;
      const violations = [];
      for (const day of plan.days) {
        for (const it of (day.items || [])) {
          const title = _norm(it.title);
          const bad = forbidden.find((f) => title.includes(f));
          if (bad) violations.push({ day: day.day_index, item: it.title, forbidden: bad });
        }
      }
      if (violations.length) {
        warnings.push(`dietary_violation (${triggers[0]}): ${violations.length} item(s) — first: "${violations[0].item}" on day ${violations[0].day} contains "${violations[0].forbidden}"`);
      }
    }
  }

  // 6. impact lines too generic (catch motivational filler)
  const fillerPhrases = ['good for', 'important for', 'helps you', 'studies show', 'great for'];
  let fillerCount = 0;
  for (const day of plan.days) {
    for (const it of (day.items || [])) {
      const impact = _norm(it.impact || it.sub);
      if (impact && fillerPhrases.some((f) => impact.includes(f))) fillerCount++;
    }
  }
  if (fillerCount > Math.max(2, Math.floor(allTitles.length * 0.10))) {
    warnings.push(`motivational_filler: ${fillerCount} impact lines use generic filler phrases`);
  }

  return {
    ok: emptyDays.length === 0 && (!plan.duration_days || plan.days.length === plan.duration_days),
    warnings,
  };
}

module.exports = { validatePlan };
