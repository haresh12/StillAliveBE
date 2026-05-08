/**
 * personal-insights.js
 * Generates 4-8 personal facts from a user's pack.
 *
 * Categories:
 *   1. Score trajectory      ("up 11 pts vs 30-day avg")
 *   2. Top correlation        ("sleep × mood r=0.71")
 *   3. Best streak            ("22 days of water")
 *   4. Coach mover            ("fitness +14 pts this week")
 *   5. Setup progress nudge   ("3 of 6 coaches active")
 */

const { AGENTS } = require('../adapters/_shape');

function buildPersonalInsights({ pack, snapshots, top_correlations, streaks, wellness }) {
  const out = [];

  // 1. Score trajectory
  if (Number.isFinite(wellness.score) && Number.isFinite(wellness.baseline_30d)) {
    const delta = wellness.score - wellness.baseline_30d;
    if (Math.abs(delta) >= 3) {
      const dir = delta > 0 ? 'above' : 'below';
      out.push({
        eyebrow: 'YOUR TRAJECTORY',
        body: `Your score is ${Math.abs(Math.round(delta))} pts ${dir} your 30-day average.`,
        source: 'From your last 30 days',
        kind: 'trajectory',
        evidence_field: 'wellness.delta_vs_baseline_30d',
        confidence: 'strong',
      });
    }
  }

  // 2. Top correlation
  if (Array.isArray(top_correlations) && top_correlations.length) {
    const c = top_correlations[0];
    if (Math.abs(c.r) >= 0.4 && c.n >= 14) {
      const verb = c.r >= 0 ? 'tracks closely with' : 'inversely tied to';
      out.push({
        eyebrow: 'YOUR PATTERN',
        body: `Your ${c.agents[0]} ${verb} your ${c.agents[1]} (r=${Math.round(c.r * 100) / 100}, n=${c.n}).`,
        source: 'Pattern detected in your data',
        kind: 'correlation',
        evidence_field: `correlation.${c.id || c.pair}`,
        confidence: c.confidence_label || 'moderate',
      });
    }
  }

  // 3. Longest streak
  if (streaks && Array.isArray(streaks.per_agent)) {
    const longest = streaks.per_agent.reduce((m, s) => (s.longest > (m.longest || 0) ? s : m), { longest: 0 });
    if (longest && longest.longest >= 5) {
      out.push({
        eyebrow: 'YOUR STREAK',
        body: `${longest.longest} days of ${longest.agent} — your longest streak.`,
        source: 'Personal best',
        kind: 'streak',
        evidence_field: `streaks.${longest.agent}.longest`,
        confidence: 'strong',
      });
    }
  }

  // 4. Best coach mover this week
  for (const agent of AGENTS) {
    const snap = snapshots[agent];
    if (!snap || !snap.setup.is_complete) continue;
    const last7 = snap.last_14d.slice(-7).filter((p) => Number.isFinite(p.score));
    const prior7 = snap.last_14d.slice(-14, -7).filter((p) => Number.isFinite(p.score));
    if (last7.length < 3 || prior7.length < 3) continue;
    const avgRecent = last7.reduce((a, b) => a + b.score, 0) / last7.length;
    const avgPrior = prior7.reduce((a, b) => a + b.score, 0) / prior7.length;
    const delta = Math.round(avgRecent - avgPrior);
    if (Math.abs(delta) >= 8) {
      const dir = delta > 0 ? 'up' : 'down';
      out.push({
        eyebrow: `YOUR ${agent.toUpperCase()}`,
        body: `${dir.charAt(0).toUpperCase() + dir.slice(1)} ${Math.abs(delta)} pts vs last week.`,
        source: '7-day rolling delta',
        kind: 'mover',
        evidence_field: `coach.${agent}.delta_7d`,
        confidence: 'strong',
      });
      break; // 1 mover insight per refresh
    }
  }

  // 5. Setup nudge
  const setupCount = pack.profile.setup_count || 0;
  if (setupCount > 0 && setupCount < 6) {
    out.push({
      eyebrow: 'YOUR SETUP',
      body: `${setupCount} of 6 coaches active. Each new coach unlocks a cross-pattern.`,
      source: 'Activate the rest',
      kind: 'setup',
      evidence_field: 'profile.setup_count',
      confidence: 'strong',
    });
  }

  // 6. EARLY-USER (Day 0-7): setup-context tips per active coach
  const daysActive = pack.profile.days_active || 0;
  if (daysActive <= 7) {
    const setupState = pack.profile.setup_state || {};
    const earlyTips = {
      sleep:     { eyebrow: 'YOUR SLEEP', body: "Log every morning — even rough estimates. The trend matters more than precision." },
      mind:      { eyebrow: 'YOUR MIND', body: "A 30-second mood check daily — your patterns surface within a week." },
      nutrition: { eyebrow: 'YOUR NUTRITION', body: "Log your biggest meal first. Protein + calories tell most of the story." },
      fitness:   { eyebrow: 'YOUR FITNESS', body: "A walk counts. Volume is volume. Don't skip the easy wins." },
      water:     { eyebrow: 'YOUR WATER', body: "Aim for 6 glasses. The 7th is a stretch goal, not a baseline." },
      fasting:   { eyebrow: 'YOUR FASTING', body: "14h gives you 80% of the benefit. Don't chase 16h on day one." },
    };
    for (const agent of AGENTS) {
      if (setupState[agent] && earlyTips[agent]) {
        out.push({
          ...earlyTips[agent],
          source: 'Tip for your first week',
          kind: 'early_tip',
          evidence_field: null,
          confidence: 'strong',
        });
      }
    }
  }

  return out;
}

module.exports = { buildPersonalInsights };
