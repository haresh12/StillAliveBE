'use strict';
// ════════════════════════════════════════════════════════════════════
// population-priors.js — research-backed baselines per agent
// Used by Tier 1 (Day 1) LLM to reason BEFORE personal data is rich.
//
// Sources cited inline. All values represent typical adult ranges; the
// LLM uses these as priors and softens claims accordingly.
// ════════════════════════════════════════════════════════════════════

// ─── SLEEP ─────────────────────────────────────────────────────────
// CDC + Walker (Why We Sleep, 2017) + Hirshkowitz NSF 2015
const SLEEP_PRIORS = {
  '18-24':   { hours: 8.0, range: '7-9',  rationale: 'Peak adolescent-to-young-adult sleep need' },
  '25-34':   { hours: 7.5, range: '7-9',  rationale: 'Adult baseline, NSF 2015' },
  '35-44':   { hours: 7.5, range: '7-9',  rationale: 'Adult baseline, NSF 2015' },
  '45-54':   { hours: 7.2, range: '7-9',  rationale: 'Slight decrease with age' },
  '55-64':   { hours: 7.0, range: '7-8',  rationale: 'Older adult baseline' },
  '65+':     { hours: 7.0, range: '7-8',  rationale: 'Older adult baseline' },
};
const SLEEP_FACTS = {
  debt_threshold_h: 1.0,    // hours below recommended that already shows cognitive impact (Banks & Dinges 2007)
  reaction_time_loss_per_h: 0.10,  // ~10% per hour of debt
  mood_loss_per_h: 0.15,
};

// ─── WATER ─────────────────────────────────────────────────────────
// IOM 2004 + EFSA 2010, total water from beverages only
const WATER_PRIORS = {
  Male:     { ml: 2500, rationale: 'IOM 2004 adequate intake (beverages only)' },
  Female:   { ml: 2000, rationale: 'IOM 2004 adequate intake (beverages only)' },
  default:  { ml: 2300, rationale: 'Cross-gender adult baseline' },
};
const WATER_FACTS = {
  cognition_loss_at: '2% body mass deficit',  // Adan 2012, Riebl & Davy 2013
  morning_anchor_ml: 500,
};

// ─── NUTRITION ─────────────────────────────────────────────────────
// Morton 2018 meta-analysis + ISSN 2017
const PROTEIN_PRIORS = {
  Male:    { g_per_kg: 1.6, rationale: 'Active adult, Morton 2018 ceiling for hypertrophy' },
  Female:  { g_per_kg: 1.5, rationale: 'Active adult, Morton 2018' },
  default: { g_per_kg: 1.5, rationale: 'Active adult baseline' },
};
const PROTEIN_FACTS = {
  body_weight_assumption_kg: { Male: 78, Female: 65, default: 72 },
};

// ─── FITNESS ───────────────────────────────────────────────────────
// WHO 2020 physical activity guidelines + Israetel RP MEV/MAV
const FITNESS_PRIORS = {
  default: {
    min_per_week: 150, rationale: 'WHO 2020: ≥150min moderate or 75min vigorous',
    strength_sessions_per_week: 2,
    rest_days_per_week: 2,
  },
};

// ─── MIND ──────────────────────────────────────────────────────────
// PHQ-9 / GAD-7 reference + Pressman & Cohen 2005 (positive affect)
const MIND_PRIORS = {
  // Mood scale 1-5
  baseline_mood: 3.4,    // Pressman & Cohen 2005 — typical positive affect
  baseline_anxiety: 2.0,
  rationale: 'Average daily affect from large adult samples',
};

// ─── FASTING ───────────────────────────────────────────────────────
// Mattson 2019 + de Cabo 2019
const FASTING_PRIORS = {
  '16-8':  { window_h: 16, rationale: 'Most-studied IF protocol, Mattson 2019' },
  '14-10': { window_h: 14, rationale: 'Gentler entry-level protocol' },
  metabolic_switch_h: 12,  // Anton 2018
};

// ─── HELPERS ───────────────────────────────────────────────────────
function sleepPrior(age) {
  return SLEEP_PRIORS[age] || SLEEP_PRIORS['25-34'];
}
function waterPrior(gender) {
  return WATER_PRIORS[gender] || WATER_PRIORS.default;
}
function proteinPriorG(gender) {
  const pp = PROTEIN_PRIORS[gender] || PROTEIN_PRIORS.default;
  const bw = PROTEIN_FACTS.body_weight_assumption_kg[gender] || PROTEIN_FACTS.body_weight_assumption_kg.default;
  return { grams: Math.round(pp.g_per_kg * bw), g_per_kg: pp.g_per_kg, rationale: pp.rationale };
}

function buildPriorBundle({ ageGroup, gender }) {
  return {
    sleep:     sleepPrior(ageGroup),
    sleep_facts: SLEEP_FACTS,
    water:     waterPrior(gender),
    water_facts: WATER_FACTS,
    protein:   proteinPriorG(gender),
    fitness:   FITNESS_PRIORS.default,
    mind:      MIND_PRIORS,
    fasting:   { protocols: FASTING_PRIORS, switch_h: FASTING_PRIORS.metabolic_switch_h },
  };
}

// Single-log "deviation from prior" hint — used to seed Tier 1 insights
function deviationHint(agent, log, priors) {
  if (agent === 'sleep' && log.duration_min) {
    const target = priors.sleep.hours;
    const actual = log.duration_min / 60;
    const debt = target - actual;
    if (debt >= priors.sleep_facts.debt_threshold_h) {
      return {
        magnitude: 'meaningful',
        delta_h: Math.round(debt * 10) / 10,
        message: `${actual.toFixed(1)}h vs ${target}h target — ${debt.toFixed(1)}h debt`,
        cite: 'Banks & Dinges 2007',
      };
    }
    return { magnitude: 'on_target', message: `${actual.toFixed(1)}h is within range` };
  }
  if (agent === 'water' && log.amount_ml) {
    const target = priors.water.ml;
    const actual = log.amount_ml;
    const ratio = actual / target;
    if (ratio < 0.6) {
      return { magnitude: 'low', message: `${actual}ml is ${Math.round((1 - ratio) * 100)}% below your daily target` };
    }
    return { magnitude: 'on_track' };
  }
  if (agent === 'mind' && log.mood_score) {
    const target = priors.mind.baseline_mood;
    if (log.mood_score < target - 0.8) {
      return { magnitude: 'below', message: `Mood ${log.mood_score}/5 vs typical ${target}/5` };
    }
    if (log.mood_score > target + 0.8) {
      return { magnitude: 'above' };
    }
    return { magnitude: 'typical' };
  }
  return { magnitude: 'unknown' };
}

module.exports = {
  SLEEP_PRIORS, WATER_PRIORS, PROTEIN_PRIORS, FITNESS_PRIORS, MIND_PRIORS, FASTING_PRIORS,
  SLEEP_FACTS, WATER_FACTS, PROTEIN_FACTS,
  sleepPrior, waterPrior, proteinPriorG,
  buildPriorBundle, deviationHint,
};
