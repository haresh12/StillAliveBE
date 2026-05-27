"use strict";
// Fasting candidate engine — uses fasting_sessions data + cross_agent/today_signals
// for the 6-agent moat archetypes (SLEEP_LINK / HYDRATION_LINK / MOOD_LINK).
// today_signals is the ONE allowed cross-agent read per the sandbox law —
// individual agent collections (sleep/water/mind) are NEVER read directly here.

const admin = require('firebase-admin');
const _fastingScoring = require('../fasting-scoring');

function getMs(v) { return v?.toMillis ? v.toMillis() : new Date(v||0).getTime(); }
function dateOnly(ms) { const d = new Date(ms); d.setHours(0,0,0,0); return d.getTime(); }

// Best-effort cross-signal fetch. Returns {} on any failure (archetypes that
// depend on cross signals will silently skip — no error, no behavior change).
async function _fetchCrossSignals(deviceId) {
  if (!deviceId) return {};
  try {
    const snap = await admin.firestore()
      .collection('wellness_users').doc(deviceId)
      .collection('cross_agent').doc('today_signals').get();
    return snap.exists ? (snap.data() || {}) : {};
  } catch { return {}; }
}

async function computeFastingCandidates(sessions, setup, ctx = {}) {
  const candidates = [];
  if (!Array.isArray(sessions)) return candidates;

  const xs = await _fetchCrossSignals(ctx.deviceId);

  const today = new Date(); today.setHours(0,0,0,0);
  const targetHours = Number(setup?.target_hours || setup?.window_hours || 16);

  // Sort newest first; only consider completed
  const completed = sessions
    .filter(s => s.completed_at || s.actual_hours)
    .sort((a,b) => getMs(b.started_at || b.completed_at) - getMs(a.started_at || a.completed_at));

  // ── WIN_BACK ──
  if (completed.length === 0) {
    candidates.push({
      archetype: "win_back",
      score: 95, category: "fasting",
      proof: { metric: "completed_fasts", value: 0, threshold: 1, citation: "Patterson 2017 review" },
      proof_text: "No completed fasts logged. Start with one 14-hour window.",
      surprise_hook: "Your first 14h fast is the entry ticket.",
      target: { hours: 14 }, success_type: "complete_fast", when_to_do: "today", impact: 3,
    });
  } else {
    const days = Math.floor((today - dateOnly(getMs(completed[0].completed_at || completed[0].started_at))) / 86400000);
    if (days >= 3) {
      candidates.push({
        archetype: "win_back",
        score: Math.min(95, 50 + days*8), category: "fasting",
        proof: { metric: "days_since_fast", value: days, threshold: 3, citation: "Patterson 2017" },
        proof_text: `${days} days since last completed fast. Metabolic flexibility decays.`,
        surprise_hook: `${days} days off — your fat-burning switch needs reactivating.`,
        target: { hours: targetHours }, success_type: "complete_fast", when_to_do: "today", impact: 2,
      });
    }
  }

  // ── PREVENT — 2+ broken-early in row ──
  const last3 = completed.slice(0, 3);
  const brokenInRow = last3.filter(s => s.broken_early || (Number(s.actual_hours||0) < targetHours - 2)).length;
  if (last3.length >= 2 && brokenInRow >= 2) {
    candidates.push({
      archetype: "prevent",
      score: 85, category: "fasting",
      proof: { metric: "broken_fasts_streak", value: brokenInRow, threshold: 2, citation: "Compliance literature" },
      proof_text: `${brokenInRow} fasts broken early. Drop target to ${Math.max(12, targetHours-2)}h to rebuild compliance.`,
      surprise_hook: `${brokenInRow} broken fasts in a row — drop the target.`,
      target: { hours: Math.max(12, targetHours-2) },
      success_type: "complete_fast", when_to_do: "today", impact: 3,
    });
  }

  // ── BREAKTHROUGH — close to next stage ──
  if (completed[0]) {
    const lastHrs = Number(completed[0].actual_hours || 0);
    const stageGap = lastHrs >= 14 && lastHrs < 16 ? 16 - lastHrs :
                     lastHrs >= 12 && lastHrs < 14 ? 14 - lastHrs : 0;
    if (stageGap > 0 && stageGap <= 2) {
      const nextStage = lastHrs >= 14 ? 16 : 14;
      const stageName = nextStage === 16 ? "ketosis entry" : "fat-burning";
      candidates.push({
        archetype: "breakthrough",
        score: 75, category: "fasting",
        proof: { metric: "next_stage_gap_hours", value: Math.round(stageGap*10)/10, threshold: 2, citation: "Anton 2018 metabolic switch" },
        proof_text: `${Math.round(stageGap*10)/10}h short of ${stageName}. Next fast: push to ${nextStage}h.`,
        surprise_hook: `Just ${Math.round(stageGap)}h from ${stageName}.`,
        target: { hours: nextStage }, success_type: "extend_window", when_to_do: "next_session", impact: 2,
      });
    }
  }

  // ── PROGRESS — 7-day completion streak ──
  if (completed.length >= 7) {
    const allHit = completed.slice(0,7).every(s => Number(s.actual_hours||0) >= targetHours);
    if (allHit) {
      candidates.push({
        archetype: "progress",
        score: 70, category: "fasting",
        proof: { metric: "completion_streak_days", value: 7, threshold: 7, citation: "Patterson 2017" },
        proof_text: `7-day completion streak at ${targetHours}h. Try ${targetHours+1}h once this week.`,
        surprise_hook: `7 days at target — extend the window.`,
        target: { hours: targetHours + 1 }, success_type: "extend_window", when_to_do: "this_week", impact: 2,
      });
    }
  }

  // ── RECOVER — 5+ consecutive 16h+ days ──
  const heavy = completed.filter(s => Number(s.actual_hours||0) >= 16).length;
  if (heavy >= 5 && completed.length >= 5 &&
      completed.slice(0,5).every(s => Number(s.actual_hours||0) >= 16)) {
    candidates.push({
      archetype: "recover",
      score: 75, category: "fasting",
      proof: { metric: "consecutive_16h_fasts", value: 5, threshold: 5, citation: "Tinsley 2017 hormesis" },
      proof_text: "5+ consecutive 16h+ fasts. Schedule a 12h refeed day to avoid metabolic adaptation.",
      surprise_hook: "5 hard fasts back-to-back — schedule a 12h refeed.",
      target: { hours: 12 }, success_type: "complete_fast", when_to_do: "rest_day", impact: 2,
    });
  }

  // ── EXPLORE — same protocol every day ──
  const distinctTargets = new Set(completed.slice(0,7).map(s => Math.round(Number(s.target_hours || targetHours))));
  if (completed.length >= 5 && distinctTargets.size === 1) {
    candidates.push({
      archetype: "explore",
      score: 50, category: "fasting",
      proof: { metric: "protocol_variety_7d", value: 1, threshold: 2, citation: "Tinsley 2017" },
      proof_text: `Only ${[...distinctTargets][0]}h protocol used. Try one OMAD or 18h variant for adaptation.`,
      surprise_hook: `Same ${[...distinctTargets][0]}h every fast — variety boosts metabolic adaptation.`,
      target: { hours: 18 }, success_type: "extend_window", when_to_do: "this_week", impact: 1,
    });
  }

  // ── MICRO ──
  candidates.push({
    archetype: "micro",
    score: 30, category: "fasting",
    proof: { metric: "log_break_meal", value: 0, threshold: 1, citation: "Tracking adherence literature" },
    proof_text: "Log what you break with — meal composition predicts next-fast hunger.",
    surprise_hook: "What you break with predicts your next fast.",
    target: { kind: "log_break_meal" }, success_type: "log_session", when_to_do: "next_session", impact: 1,
  });

  // ════════════════════════════════════════════════════════════════
  // V3 ARCHETYPES (2026-05-23) — the 6-agent moat. These are what no
  // standalone fasting app can do, because they require sleep/water/mind
  // signals routed through cross_agent/today_signals.
  // ════════════════════════════════════════════════════════════════

  // ── PROTOCOL_DELOAD — Banister band overreaching ──
  // Cite: Anton 2018 hormetic stress framing
  try {
    const startDate = ctx.setup?.created_at_local
      || (completed.length
          ? new Date(getMs(completed[completed.length - 1].started_at)).toISOString().slice(0, 10)
          : null);
    const today = new Date().toISOString().slice(0, 10);
    if (startDate) {
      const form = _fastingScoring.computeFastingForm({
        sessions, priorSessions: [], startDateStr: startDate, todayDateStr: today,
      });
      if (form.band === 'overreaching' || form.band === 'aggressive') {
        candidates.push({
          archetype: "deload",
          score: 88, category: "fasting",
          proof: { metric: "fasting_form_band", value: form.band, ratio: form.ratio, citation: "Anton 2018 hormetic stress" },
          proof_text: `Your form is ${form.band} (ratio ${form.ratio}). Drop to 14h today — push tomorrow.`,
          surprise_hook: `Form is ${form.band} — back off one day.`,
          target: { hours: Math.max(12, targetHours - 4) }, success_type: "complete_fast", when_to_do: "today", impact: 3,
        });
      }
    }
  } catch { /* soft-fail */ }

  // ── WINDOW_STABILIZE — drift_flag tripped ──
  // Cite: de Cabo & Mattson 2019 circadian alignment
  try {
    const win = _fastingScoring.deriveWindowStability(completed, 28, ctx.setup?.utcOffsetMinutes || 0);
    if (win?.drift_flag) {
      candidates.push({
        archetype: "rebalance",
        score: 72, category: "fasting",
        proof: { metric: "window_std_hours", value: win.std_start_hours, threshold: 1.5, citation: "de Cabo & Mattson 2019 circadian alignment" },
        proof_text: `Your eating window drifted by ${(win.std_start_hours).toFixed(1)}h. Pick one consistent stop time for 5 days.`,
        surprise_hook: `Window drift ${(win.std_start_hours).toFixed(1)}h — set one stop time.`,
        target: { kind: "fix_window" }, success_type: "complete_fast", when_to_do: "this_week", impact: 2,
      });
    }
  } catch { /* soft-fail */ }

  // ── BREAK_PATTERN_FIX — recurring hunger breaks ──
  // Cite: self-derived pattern + pre-emptive water+walk
  try {
    const recent5 = sessions.slice(0, 5);
    const hungerBreaks = recent5.filter(s => s.broken_early && s.broken_reason === 'hunger');
    if (hungerBreaks.length >= 3) {
      const wave = _fastingScoring.deriveHungerWaveHour(completed.concat(hungerBreaks));
      candidates.push({
        archetype: "prevent",
        score: 80, category: "fasting",
        proof: { metric: "hunger_break_count_5", value: hungerBreaks.length, wave_hour: wave?.wave_hour, threshold: 3, citation: "self-derived hunger wave" },
        proof_text: wave?.wave_hour
          ? `${hungerBreaks.length} of last 5 fasts broke at hunger (wave ~${wave.wave_hour}h). Try cup of water + 5min walk at hour ${Math.max(0, Math.floor(wave.wave_hour) - 1)}.`
          : `${hungerBreaks.length} of last 5 fasts broke at hunger. Pre-empt with water + walk.`,
        surprise_hook: `${hungerBreaks.length} hunger breaks — try water + walk at the wave.`,
        target: { kind: "log_water_at_wave" }, success_type: "complete_fast", when_to_do: "today", impact: 2,
      });
    }
  } catch { /* soft-fail */ }

  // ── HABITUATION_BREAK — 3+ weeks stalled at same avg ──
  // Cite: BodyFast habituation framing (varied protocol breaks adaptation)
  try {
    const _weeks = [];
    for (let w = 11; w >= 0; w--) {
      const wEndMs = Date.now() - w * 7 * 86_400_000;
      const wStartMs = wEndMs - 7 * 86_400_000;
      const inWeek = completed.filter(s => {
        const sm = getMs(s.started_at);
        return sm >= wStartMs && sm < wEndMs && Number(s.actual_hours || 0) > 0;
      });
      const avg = inWeek.length ? inWeek.reduce((a, s) => a + Number(s.actual_hours || 0), 0) / inWeek.length : null;
      _weeks.push(avg);
    }
    const hab = _fastingScoring.deriveHabituation({
      avgFastHoursByWeek: _weeks.filter(v => v != null),
      weeks: 12,
    });
    if (hab.stalled) {
      candidates.push({
        archetype: "explore",
        score: 60, category: "fasting",
        proof: { metric: "weeks_stalled", value: hab.weeks_stalled, threshold: 3, citation: "BodyFast habituation framing" },
        proof_text: `${hab.weeks_stalled} weeks at the same average. Try one ${targetHours + 2}h fast this week to break adaptation.`,
        surprise_hook: `${hab.weeks_stalled} weeks plateau — vary once.`,
        target: { hours: targetHours + 2 }, success_type: "extend_window", when_to_do: "this_week", impact: 2,
      });
    }
  } catch { /* soft-fail */ }

  // ── SLEEP_LINK — broken fasts after short-sleep nights ──
  // Cite: Patterson 2017; St-Onge 2016 sleep deprivation → ghrelin rise
  // *** THIS IS THE 6-AGENT MOAT — no standalone fasting app can do this ***
  try {
    const recentBroken = sessions.filter(s => {
      const sm = getMs(s.started_at);
      return s.broken_early && sm > Date.now() - 7 * 86_400_000;
    });
    if (recentBroken.length >= 2
        && typeof xs.sleep_hours_last_night === 'number'
        && xs.sleep_hours_last_night < 6) {
      candidates.push({
        archetype: "recover",
        score: 90, category: "fasting",
        proof: { metric: "broken_with_low_sleep", value: recentBroken.length, sleep_hours: xs.sleep_hours_last_night, citation: "St-Onge 2016 sleep deprivation → ghrelin" },
        proof_text: `${recentBroken.length} broken fasts this week, all on nights of <6h sleep. Fix sleep before extending fasts.`,
        surprise_hook: `Bad sleep → broken fasts. Sleep first today.`,
        target: { hours: Math.max(12, targetHours - 2) }, success_type: "complete_fast", when_to_do: "today", impact: 3,
      });
    }
  } catch { /* soft-fail */ }

  // ── HYDRATION_LINK — hunger breaks correlate with low water ──
  // Cite: StatPearls electrolyte risk + dehydration mimics hunger
  try {
    const recentHunger = sessions.filter(s => {
      const sm = getMs(s.started_at);
      return s.broken_early && s.broken_reason === 'hunger' && sm > Date.now() - 7 * 86_400_000;
    });
    if (recentHunger.length >= 2
        && typeof xs.water_pct_of_goal_today === 'number'
        && xs.water_pct_of_goal_today < 50) {
      candidates.push({
        archetype: "prevent",
        score: 82, category: "fasting",
        proof: { metric: "hunger_breaks_with_dehydration", value: recentHunger.length, water_pct: xs.water_pct_of_goal_today, citation: "StatPearls electrolyte risk" },
        proof_text: `${recentHunger.length} hunger breaks this week. You're at ${xs.water_pct_of_goal_today}% of water goal today — hit 8 cups by noon.`,
        surprise_hook: `Hunger breaks + low water — fix hydration first.`,
        target: { kind: "hit_water_goal" }, success_type: "log_session", when_to_do: "today", impact: 2,
      });
    }
  } catch { /* soft-fail */ }

  // ── REFEED_QUALITY — long fast + poor protein refeed ──
  // Cite: StatPearls refeeding syndrome
  try {
    const recentLong = completed.find(s => Number(s.actual_hours || 0) >= 24);
    if (recentLong
        && typeof xs.nutrition_protein_g_today === 'number'
        && xs.nutrition_protein_g_today < 40) {
      candidates.push({
        archetype: "progress",
        score: 78, category: "fasting",
        proof: { metric: "refeed_protein_g", value: xs.nutrition_protein_g_today, threshold: 40, citation: "StatPearls refeeding syndrome" },
        proof_text: `Last fast was ${Number(recentLong.actual_hours).toFixed(0)}h. You ate ${xs.nutrition_protein_g_today}g protein after. Aim 40g+ next break to preserve muscle.`,
        surprise_hook: `${Number(recentLong.actual_hours).toFixed(0)}h fast deserves a real refeed.`,
        target: { kind: "log_protein_meal" }, success_type: "log_session", when_to_do: "next_session", impact: 2,
      });
    }
  } catch { /* soft-fail */ }

  candidates.sort((a,b) => b.score - a.score);
  return candidates;
}

const fastingGraders = {
  complete_fast: async (deviceId, action, recentLogs) => {
    const target = action.success_criterion?.target?.hours || 14;
    const hits = recentLogs.filter(s => Number(s.actual_hours||0) >= target).length;
    return { met: hits >= 1, value: hits };
  },
  extend_window: async (deviceId, action, recentLogs) => {
    const target = action.success_criterion?.target?.hours || 16;
    const hits = recentLogs.filter(s => Number(s.actual_hours||0) >= target).length;
    return { met: hits >= 1, value: hits };
  },
  log_session: async (deviceId, action, recentLogs) => ({ met: recentLogs.length >= 1, value: recentLogs.length }),
};

module.exports = { computeFastingCandidates, fastingGraders };
