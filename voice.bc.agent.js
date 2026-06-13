'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// voice.bc.agent.js — the voice-CALL coach's control plane (big-change).
//
// ACTIVE PATH (chosen 2026-06-20): OpenAI Realtime, speech-to-speech, ONE vendor,
// pure pay-as-you-go. The app opens a direct WebRTC call to OpenAI using an
// ephemeral key we mint here:
//   POST /api/voice/realtime-session → cached briefing + persona → OpenAI ephemeral
//                                      key → { clientSecret, model, voice, webrtcUrl, greeting }.
//   POST /api/voice/tool             → run a coach tool (get_analysis/today/plans/cross)
//                                      server-side; the app just relays name+args.
//
// DORMANT REVERT PATH (kept, not deleted): the cascaded LiveKit + Deepgram + Cartesia
// worker (voice-agent/agent.js) and POST /api/voice/token below. Re-enable when we
// have customer volume and want best-of-breed per-minute economics. To revert: point
// the app's startCall back at /token and run `npm run voice-agent`. See VOICE_CALL_BUILD.md.
//
// SHARED (used by BOTH paths): /briefing, /call-summary, /calls, /can-call + lib/voice-briefing
// + lib/voice-calls. The recap/MOM/history pipeline is identical regardless of brain.
//
// `mode` drives the whole personality:
//   'user' = the user tapped "Call coach" → coach answers, goes deep, doesn't push.
//   'ai'   = the coach rang the user (M2) → coach leads, focuses on gaps, may ask.
//
// Cross-agent surface (a call spans every domain) → lives outside agent sandboxes.
// ═══════════════════════════════════════════════════════════════════════════
const express = require('express');
// Optional dep: if livekit-server-sdk isn't installed yet, the backend MUST still boot
// (it serves the live app). /token degrades to 503 until `npm install livekit-server-sdk`.
let AccessToken = null, RoomServiceClient = null;
try {
  ({ AccessToken, RoomServiceClient } = require('livekit-server-sdk'));
} catch {
  console.warn('[voice] livekit-server-sdk not installed — /api/voice/token disabled. Run: npm install livekit-server-sdk');
}
const { buildBriefing } = require('./lib/voice-briefing');
const { saveCall, listCalls, getCall, dailyStatus } = require('./lib/voice-calls');
// ACTIVE brain: OpenAI Realtime session minter + server-side tool runner.
const { mintSession, runTool } = require('./lib/voice-realtime');
const { getCoach } = require('./lib/coach-roster');
const { userDoc } = require('./lib/collections');
const { evaluateProactiveCall } = require('./lib/voice-outreach');

// Resolve the user's chosen coach name (for the call UI header). Cheap, best-effort.
async function coachNameFor(deviceId) {
  try {
    const snap = await userDoc(deviceId).get();
    const u = (snap && snap.exists ? snap.data() : {}) || {};
    return getCoach(u.coach_id, u.coach_name).name;
  } catch { return getCoach(null, null).name; }
}

const router = express.Router();

const LIVEKIT_URL = process.env.LIVEKIT_URL || '';
const API_KEY = process.env.LIVEKIT_API_KEY || '';
const API_SECRET = process.env.LIVEKIT_API_SECRET || '';
// RoomServiceClient wants an https(s) URL; LIVEKIT_URL is wss://… → swap scheme.
const HTTP_URL = LIVEKIT_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');

const roomSvc = () =>
  (RoomServiceClient && LIVEKIT_URL && API_KEY && API_SECRET) ? new RoomServiceClient(HTTP_URL, API_KEY, API_SECRET) : null;

const VALID_MODES = new Set(['user', 'ai']);

// ═══ ACTIVE: OpenAI Realtime (speech-to-speech, single-vendor, pure PAYG) ═══════════════════════
// POST /api/voice/realtime-session  { deviceId, mode?, name?, topic?, focus? }
// Mints a short-lived OpenAI ephemeral key (with the cached briefing + persona + tools baked into
// the session) the app uses to open a DIRECT WebRTC call to OpenAI. The standby key never leaves here.
router.post('/realtime-session', async (req, res) => {
  try {
    const deviceId = String(req.body.deviceId || req.body.device_id || '').trim();
    const mode = VALID_MODES.has(req.body.mode) ? req.body.mode : 'user';
    const name = (req.body.name || '').toString().slice(0, 60);
    const topic = (req.body.topic || '').toString().slice(0, 80);
    const focus = (req.body.focus || '').toString().slice(0, 24);
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    console.log(`🟢 [voice] /realtime-session HIT (OpenAI Realtime path) device=${deviceId} mode=${mode} topic=${topic || '-'}`);

    // MONTHLY-minute gate (user-initiated only; proactive 'ai' calls aren't capped). The monthly budget
    // (free 5 min, premium 50 min) IS the limit; we also keep a generous daily call-count backstop.
    let remainingSec; // remaining monthly seconds → becomes this call's max length
    if (mode === 'user') {
      const status = await dailyStatus(deviceId).catch(() => ({ allowed: true }));
      if (!status.allowed) {
        const monthly = status.monthly_allowed === false;
        return res.status(429).json({
          error: monthly ? 'monthly_limit' : 'daily_limit',
          message: monthly
            ? 'You’ve used your voice minutes for this month — they reset next month.'
            : 'You’ve already had your coach call today. Come back tomorrow.',
          monthly_used_sec: status.monthly_used_sec,
          monthly_limit_sec: status.monthly_limit_sec,
          monthly_remaining_sec: status.monthly_remaining_sec,
          is_premium: status.is_premium,
          last_call_at: status.last_call_at,
        });
      }
      remainingSec = status.monthly_remaining_sec;
    }

    const session = await mintSession(deviceId, { mode, name, topic, focus, maxCallSec: remainingSec });
    res.json({ ...session, mode });
  } catch (e) {
    console.error('[voice] /realtime-session error:', e.message);
    res.status(503).json({ error: 'realtime_unavailable', message: e.message });
  }
});

// GET /api/voice/coach?deviceId  — current coach + proactive opt-in (for Settings).
router.get('/coach', async (req, res) => {
  const deviceId = req.query.deviceId || req.query.device_id;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  try {
    const snap = await userDoc(String(deviceId)).get();
    const u = (snap && snap.exists ? snap.data() : {}) || {};
    const coach = getCoach(u.coach_id, u.coach_name);
    res.json({ coach_id: u.coach_id || 'ava', coach_name: coach.name, proactive_opt_in: u.voice_proactive_opt_in === true });
  } catch {
    res.json({ coach_id: 'ava', coach_name: 'Ava', proactive_opt_in: false });
  }
});

// POST /api/voice/coach  { deviceId, coach_id?, coach_name?, proactive_opt_in? }  — change coach / opt-in.
router.post('/coach', async (req, res) => {
  const deviceId = String(req.body.deviceId || '').trim();
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  try {
    const patch = {};
    if (req.body.coach_id) patch.coach_id = String(req.body.coach_id).slice(0, 24);
    if (req.body.coach_name) patch.coach_name = String(req.body.coach_name).slice(0, 40);
    if (typeof req.body.proactive_opt_in === 'boolean') patch.voice_proactive_opt_in = req.body.proactive_opt_in;
    if (Object.keys(patch).length) await userDoc(deviceId).set(patch, { merge: true });
    res.json({ ok: true, ...patch });
  } catch (e) {
    console.error('[voice] /coach save error:', e.message);
    res.status(500).json({ error: 'save_failed' });
  }
});

// GET /api/voice/proactive-check?deviceId  — the "should the coach reach out?" decision (criteria,
// not spam). The delivery layer (notification engine / future CallKit) calls this, then — if true —
// sends a push that opens the app into an AI-initiated call. Respects quiet hours + opt-in at delivery.
router.get('/proactive-check', async (req, res) => {
  const deviceId = req.query.deviceId || req.query.device_id;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  try {
    res.json(await evaluateProactiveCall(String(deviceId)));
  } catch (e) {
    console.error('[voice] /proactive-check error:', e.message);
    res.json({ shouldCall: false, reason: 'error' });
  }
});

// POST /api/voice/tool  { deviceId, name, arguments }
// The app relays the model's function-call here; we run it against our own API and return the result.
router.post('/tool', async (req, res) => {
  try {
    const deviceId = String(req.body.deviceId || '').trim();
    const name = String(req.body.name || '').trim();
    const args = (req.body.arguments && typeof req.body.arguments === 'object') ? req.body.arguments : {};
    if (!deviceId || !name) return res.status(400).json({ error: 'deviceId and name required' });
    const output = await runTool(deviceId, name, args);
    res.json({ output });
  } catch (e) {
    console.error('[voice] /tool error:', e.message);
    res.json({ output: 'no data' });
  }
});

// ═══ DORMANT REVERT PATH: cascaded LiveKit + Deepgram + Cartesia ════════════════════════════════
// Kept intact (not deleted) so we can switch back at scale. The app no longer calls /token; it lives
// here for a quick revert (re-point startCall → /token + run `npm run voice-agent`).
// POST /api/voice/token  { deviceId, mode?, name? }
router.post('/token', async (req, res) => {
  try {
    console.warn('🔴 [voice] /token HIT — LEGACY LiveKit/Deepgram/Cartesia path. The app JS is STALE (still calling /token); reload it to use OpenAI Realtime.');
    const deviceId = String(req.body.deviceId || req.body.device_id || '').trim();
    const mode = VALID_MODES.has(req.body.mode) ? req.body.mode : 'user';
    const name = (req.body.name || '').toString().slice(0, 60);
    const topic = (req.body.topic || '').toString().slice(0, 80);
    const focus = (req.body.focus || '').toString().slice(0, 24);
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    if (!AccessToken) {
      return res.status(503).json({ error: 'voice deps not installed (run: npm install livekit-server-sdk)' });
    }
    if (!API_KEY || !API_SECRET || !LIVEKIT_URL) {
      return res.status(503).json({ error: 'voice not configured (LIVEKIT_* env missing)' });
    }

    // Once-a-day gate (user-initiated only; the coach's own proactive 'ai' calls aren't capped).
    if (mode === 'user') {
      const status = await dailyStatus(deviceId).catch(() => ({ allowed: true }));
      if (!status.allowed) {
        return res.status(429).json({ error: 'daily_limit', message: 'You’ve already had your coach call today. Come back tomorrow.', last_call_at: status.last_call_at });
      }
    }

    // One room per call. The agent worker reads this metadata to know who it's talking to.
    // premium (account-level, synced to wellness_users) drives the call-length cap in the worker.
    let premium = false;
    try {
      const admin = require('firebase-admin');
      const ss = await admin.firestore().collection('wellness_users').doc(deviceId).get();
      const sub = ss.exists ? (ss.data().subscription || {}) : {};
      premium = !!(sub.isPremium || sub.isTrial);
    } catch { /* default free */ }
    const roomName = `coach-${deviceId}-${Date.now().toString(36)}`;
    const metadata = JSON.stringify({ deviceId, mode, name, topic, focus, premium });

    // Pre-create the room WITH metadata (so the auto-dispatched agent has context the
    // instant it joins). emptyTimeout/maxParticipants keep abandoned calls cheap.
    const svc = roomSvc();
    if (svc) {
      await svc.createRoom({ name: roomName, metadata, emptyTimeout: 30, maxParticipants: 2 })
        .catch((e) => console.warn('[voice] createRoom failed (continuing):', e.message));
    }

    // Mint the user's join token. Identity is stable per device; metadata duplicated on the
    // participant so the agent can read it from either the room or the participant.
    const at = new AccessToken(API_KEY, API_SECRET, {
      identity: `user-${deviceId}`,
      name: name || 'You',
      metadata,
      ttl: '20m',
    });
    at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true });
    const token = await at.toJwt();

    res.json({ url: LIVEKIT_URL, token, room: roomName, mode });
  } catch (e) {
    console.error('[voice] /token error:', e);
    res.status(500).json({ error: 'token_failed' });
  }
});

// GET /api/voice/briefing?deviceId  — preview the context the coach will have.
router.get('/briefing', async (req, res) => {
  const deviceId = req.query.deviceId || req.query.device_id;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  try {
    const focus = (req.query.focus || '').toString().trim() || null;
    const b = await buildBriefing(String(deviceId), { focus });
    res.json(b);
  } catch (e) {
    console.error('[voice] /briefing error:', e);
    res.status(500).json({ error: 'briefing_failed' });
  }
});

// POST /api/voice/call-summary  { deviceId, mode, startedAtMs, endedAtMs, transcript[], name }
// Called by the voice worker when a call ends. Generates the MOM + persists the call.
router.post('/call-summary', async (req, res) => {
  try {
    const deviceId = String(req.body.deviceId || '').trim();
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    const saved = await saveCall(deviceId, {
      mode: req.body.mode,
      startedAtMs: Number(req.body.startedAtMs) || Date.now(),
      endedAtMs: Number(req.body.endedAtMs) || Date.now(),
      transcript: req.body.transcript,
      name: req.body.name,
      usage: req.body.usage || null, // [testing] Realtime token totals → exact cost
      model: req.body.model || null,
    });
    res.json({ ok: true, id: saved.id, title: saved.title });
  } catch (e) {
    console.error('[voice] /call-summary error:', e);
    res.status(500).json({ error: 'summary_failed' });
  }
});

// GET /api/voice/calls?deviceId  — history list (MOM, no transcript).
router.get('/calls', async (req, res) => {
  const deviceId = req.query.deviceId || req.query.device_id;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  try {
    const [calls, status, coach_name] = await Promise.all([
      listCalls(String(deviceId), Number(req.query.limit) || 30),
      dailyStatus(String(deviceId)),
      coachNameFor(String(deviceId)),
    ]);
    res.json({
      calls,
      can_call: status.allowed,
      used_today: status.used_today,
      last_call_at: status.last_call_at,
      coach_name,
      max_call_sec: status.monthly_remaining_sec, // this call's max length = remaining monthly seconds
      monthly_used_sec: status.monthly_used_sec, // seconds used this month
      monthly_limit_sec: status.monthly_limit_sec, // monthly budget (free 300 / premium 3000)
      monthly_remaining_sec: status.monthly_remaining_sec, // seconds left this month → drives the UI
      is_premium: status.is_premium,
    });
  } catch (e) {
    console.error('[voice] /calls error:', e);
    res.status(500).json({ error: 'calls_failed' });
  }
});

// GET /api/voice/calls/:id?deviceId  — one call with full transcript.
router.get('/calls/:id', async (req, res) => {
  const deviceId = req.query.deviceId || req.query.device_id;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  try {
    const call = await getCall(String(deviceId), req.params.id);
    if (!call) return res.status(404).json({ error: 'not_found' });
    res.json(call);
  } catch (e) {
    console.error('[voice] /calls/:id error:', e);
    res.status(500).json({ error: 'call_failed' });
  }
});

// GET /api/voice/can-call?deviceId  — daily-limit status for the UI.
router.get('/can-call', async (req, res) => {
  const deviceId = req.query.deviceId || req.query.device_id;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  try {
    res.json(await dailyStatus(String(deviceId)));
  } catch (e) {
    res.json({ allowed: true, used_today: false, last_call_at: null });
  }
});

module.exports = router;
