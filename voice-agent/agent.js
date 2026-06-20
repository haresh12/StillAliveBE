// ═══════════════════════════════════════════════════════════════════════════
// ⚠️ DORMANT REVERT PATH (since 2026-06-20) — NOT the active call brain.
//
// The live call now runs on OpenAI Realtime (speech-to-speech, single-vendor, pure PAYG) via
// lib/voice-realtime.js + the app's realtimeClient.ts — no LiveKit worker needed. This cascaded
// worker is KEPT INTACT (not deleted) so we can switch back to best-of-breed economics once we
// have customer volume. To revert: (1) point the app's call at /token (startCall in voiceApi.ts),
// (2) `npm run voice-agent`. See StillAlive/VOICE_CALL_BUILD.md for the full revert checklist.
// ═══════════════════════════════════════════════════════════════════════════
// voice-agent/agent.js — the LiveKit worker that runs the live call pipeline.
//
//   Deepgram Flux (STTv2)  →  OpenAI gpt-5.4-mini  →  Cartesia Sonic-2 (TTS)
//
// Run it from the backend root (NOT this folder):  npm run voice-agent
// It registers with LiveKit Cloud and is auto-dispatched into every "coach-*" room
// the token endpoint creates. It reads the room metadata ({deviceId, mode, name}),
// fetches that user's context briefing over HTTP from the local backend, builds the
// system prompt, and starts the conversation.
//
// CONVERSATION-DESIGN LAW (encoded below — see persona()):
//   • The AI NEVER interrupts the user. It waits for Flux end-of-turn before speaking.
//     The user MAY barge in over the AI (allowInterruptions) and the AI yields at once.
//   • mode 'ai'   → the coach rang the user: it LEADS, focuses on gaps, may ask questions.
//   • mode 'user' → the user rang the coach: it ANSWERS, goes deep, explains WHY; no agenda.
// ═══════════════════════════════════════════════════════════════════════════
import 'dotenv/config'; // load the backend .env (LIVEKIT_*, DEEPGRAM/OPENAI/CARTESIA keys) — run from backend root
import { defineAgent, cli, WorkerOptions, voice, llm } from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as openai from '@livekit/agents-plugin-openai';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

// Node 18 doesn't expose Web Crypto as a global; @livekit/rtc-node needs it for data/transcription
// streams (otherwise every turn throws "crypto is not defined"). Safe no-op on Node ≥20.
if (!globalThis.crypto) globalThis.crypto = webcrypto;

// MUST be 127.0.0.1, NOT "localhost": Node 18 fetch resolves localhost→IPv6 (::1) but the API server
// binds IPv4 (0.0.0.0) → every worker→server fetch ("fetch failed") silently breaks briefing + saving.
const BACKEND_URL = process.env.VOICE_BACKEND_URL || `http://127.0.0.1:${process.env.PORT || 5001}`;
const LLM_MODEL = process.env.VOICE_LLM_MODEL || 'gpt-5.4-mini';
const TTS_VOICE = process.env.CARTESIA_VOICE_ID || undefined; // plugin default voice if unset
const MAX_CALL_MS = 5 * 60 * 1000; // 5-min cap (product decision, for now)
const COACH_NAME = process.env.VOICE_COACH_NAME || 'Ava'; // female coach (US/tier-1 default); keep in sync with app COACH_NAME

// Pull the context briefing the control plane built (profile + per-domain state, anchor-clamped).
// When a domain topic was chosen (focus), the briefing grafts in that domain's REAL analysis.
async function fetchBriefing(deviceId, focus) {
  try {
    const q = `deviceId=${encodeURIComponent(deviceId)}${focus ? `&focus=${encodeURIComponent(focus)}` : ''}`;
    const r = await fetch(`${BACKEND_URL}/api/voice/briefing?${q}`);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    console.warn('[voice-agent] briefing fetch failed:', e.message);
    return null;
  }
}

// ── Live tools — let the coach pull ANYTHING mid-call, not just the opening briefing. ──
const DOMAINS = ['fitness', 'nutrition', 'mind', 'sleep', 'water', 'fasting'];
const apiGet = async (path) => {
  try { const r = await fetch(`${BACKEND_URL}${path}`); return r.ok ? await r.json() : null; } catch { return null; }
};
const trim = (o, n = 1500) => { try { return o ? JSON.stringify(o).slice(0, n) : 'no data'; } catch { return 'no data'; } };

function buildTools(deviceId) {
  if (!deviceId) return undefined;
  const enc = encodeURIComponent(deviceId);
  return {
    get_analysis: llm.tool({
      description: "Pull the user's REAL analysis for a domain (scores, trends, stats) when they ask how they're doing in that area or you want exact numbers.",
      parameters: { type: 'object', properties: { domain: { type: 'string', enum: DOMAINS }, range: { type: 'string', description: '7, 30, 90, or 365 (days)' } }, required: ['domain'] },
      execute: async ({ domain, range }) => trim(await apiGet(`/api/${domain}/analysis?deviceId=${enc}&range=${range || '30'}`)),
    }),
    get_today: llm.tool({
      description: "Get today's status for a domain — what the user has logged today and what's still open.",
      parameters: { type: 'object', properties: { domain: { type: 'string', enum: DOMAINS } }, required: ['domain'] },
      execute: async ({ domain }) => trim(await apiGet(`/api/${domain}/today?deviceId=${enc}`)),
    }),
    get_plans: llm.tool({
      description: "Get the user's active plans with today's progress and what's still undone.",
      parameters: { type: 'object', properties: {} },
      execute: async () => trim(await apiGet(`/api/goal-plans/list?deviceId=${enc}`)),
    }),
    get_cross_insights: llm.tool({
      description: "Get cross-domain insights — how the user's habits affect each other (correlations, momentum, what's helping/hurting).",
      parameters: { type: 'object', properties: {} },
      execute: async () => trim(await apiGet(`/api/wellness-combined?deviceId=${enc}&range=30`)),
    }),
  };
}

// The system prompt. The briefing is the moat; the rules are the soul.
function persona({ briefingText, mode, name, topic }) {
  const who = name ? ` Their name is ${name} — use it naturally, not in every line.` : '';
  const lead = mode === 'ai'
    ? `YOU called THEM, like a friend who happens to be a great coach. Open with a genuine human greeting first ("Hey${name ? ' ' + name : ''}, how are you doing today?"), let it breathe, THEN naturally say why you called — one specific reason from their data (a habit they've slipped on, a plan check-in, how a goal's tracking). Warm and human, never clinical. You MAY ask short questions — one at a time, never rapid-fire.`
    : topic
      ? `THEY called YOU and chose to talk about ${topic}. Greet them warmly by name FIRST ("Hey${name ? ' ' + name : ''}, how are you doing today?"), then ease into ${topic} using what you know about them. After your opener, follow their lead.`
      : `THEY called YOU. Greet them warmly by name FIRST ("Hey${name ? ' ' + name : ''}, how are you doing today?"), then a brief friendly invite ("What's on your mind?"). After that, follow THEIR lead — answer what they ask and go deeper (explain WHY). Don't run your own agenda of questions.`;

  return [
    `You are ${COACH_NAME}, a warm, sharp, genuinely helpful personal health coach on a LIVE PHONE CALL. You are not a chatbot — you talk like a real person who happens to be a great coach and knows this person.${who} If they ask your name, you're ${COACH_NAME}.`,
    ``,
    `=== WHO YOU'RE TALKING TO (your private briefing — never read it aloud verbatim) ===`,
    briefingText || 'No briefing available — ask how they are and what they want to work on.',
    topic ? `\n=== CALL FOCUS ===\nThe user chose to talk about: ${topic}. Keep the conversation centered there unless they steer elsewhere.` : '',
    ``,
    `=== HOW TO TALK ===`,
    `• You have their full picture above — goals, targets, what they've logged and MISSED, active plans + what's undone today, their deep-dive numbers, and what past calls taught you. Use it like a coach who's been with them all along: bring up the gaps, their plan progress, and their goals proactively. Never say "I don't have your data" — you do.`,
    `• You have a team of tools that fetch ANYTHING from their data instantly: get_analysis(domain), get_today(domain), get_plans, get_cross_insights. Use them liberally and confidently.`,
    `• When you go look something up, SAY a short natural filler out loud first so it feels like you're working for them — "let me pull that up real quick…", "one sec, checking your sleep this week…", "let me look at where your training's at…" — THEN call the tool and answer with the exact real numbers. Never guess, never say "I don't have that"; you can always go get it.`,
    `• Talk like a caring human, not a clinician — warmth and connection first, then substance. Use their name now and then, react to what they say ("oh nice", "ah, that's rough"), keep it real.`,
    `• Spoken conversation: short, natural sentences. No lists, no markdown, no emoji — this is audio.`,
    `• Be specific using the briefing ("your protein's been light three of the last five days") — that specificity is why they trust you. Never invent numbers or history you don't have.`,
    `• Always have something substantive to say: tie it to their goals, and when they ask something, explain the WHY, not just the what.`,
    `• Notice what they need, struggle with, and respond to — read between the lines and surface helpful suggestions they didn't ask for. (We remember these learnings for next time, so the more you pick up, the smarter you get.)`,
    `• ${lead}`,
    `• NEVER talk over them. If they start speaking, stop immediately and listen.`,
    `• If they mention self-harm or crisis, gently encourage contacting 988 (or local emergency services) and stay supportive — do not coach through it.`,
    `• Keep the call focused and make it count; when it's winding down, give one clear takeaway + next step and wrap up warmly.`,
  ].filter(Boolean).join('\n');
}

export default defineAgent({
  entry: async (ctx) => {
    await ctx.connect();

    // Room metadata was set by the token endpoint: { deviceId, mode, name }.
    let meta = {};
    try { meta = JSON.parse(ctx.room?.metadata || '{}'); } catch { /* none */ }
    // deviceId is CRITICAL for saving. Prefer metadata; fall back to the room name, which always
    // encodes it as `coach-<deviceId>-<base36ts>` (deviceId may contain hyphens → split on the LAST '-').
    let deviceId = meta.deviceId || null;
    if (!deviceId) {
      const rn = ctx.room?.name || '';
      if (rn.startsWith('coach-')) {
        const rest = rn.slice('coach-'.length);
        const cut = rest.lastIndexOf('-');
        deviceId = cut > 0 ? rest.slice(0, cut) : rest;
      }
    }
    const mode = meta.mode === 'ai' ? 'ai' : 'user';
    const name = meta.name || '';
    const topic = (meta.topic || '').toString().trim() || null;
    console.log(`[voice-agent] call start deviceId=${deviceId} mode=${mode} topic=${topic || '-'} room=${ctx.room?.name}`);

    const briefing = deviceId ? await fetchBriefing(deviceId) : null;
    const instructions = persona({ briefingText: briefing?.text, mode, name, topic });

    // Capture the transcript so the call becomes a saved ACTION (the "MOM" + takeaways).
    const startedAtMs = Date.now();
    const transcript = [];

    const session = new voice.AgentSession({
      // Deepgram Flux = STT + semantic turn detection (StartOfTurn/EndOfTurn). eagerEotThreshold
      // arms preemptive generation: the coach starts forming its reply as the user is finishing.
      stt: new deepgram.STTv2({ model: 'flux-general-en', eagerEotThreshold: 0.5 }),
      llm: new openai.LLM({ model: LLM_MODEL }),
      tts: new cartesia.TTS({ model: 'sonic-2', ...(TTS_VOICE ? { voice: TTS_VOICE } : {}) }),
      // VAD is bundled by AgentSession now (silero plugin deprecated) — no explicit vad needed.
      turnHandling: {
        turnDetection: 'stt',                              // Flux end-of-turn, not raw silence
        endpointing: { minDelay: 300 },                    // respond fast once the user truly stops
        // Barge-in: INSTANT + CLEAN. VAD-based so she stops the moment you speak. resumeFalseInterruption
        // is OFF on purpose — resuming a half-said sentence skips the words synthesized-but-not-spoken
        // ("missing words"). Instead she fully stops and responds to what you JUST said. 250ms threshold
        // keeps random noise from triggering spurious stops.
        interruption: { enabled: true, mode: 'vad', minWords: 0, minDuration: 250, resumeFalseInterruption: false },
        preemptiveGeneration: { enabled: true, preemptiveTts: true }, // pre-compute the reply → AHA latency
      },
    });

    // Accumulate each completed turn (user + coach) for the post-call summary.
    session.on('conversation_item_added', (ev) => {
      try {
        const item = ev?.item || ev;
        const role = item?.role;
        const text = item?.textContent;
        if ((role === 'user' || role === 'assistant') && text && text.trim()) {
          transcript.push({ role, text: text.trim() });
        }
      } catch { /* ignore malformed item */ }
    });

    await session.start({
      agent: new voice.Agent({ instructions, tools: buildTools(deviceId) }),
      room: ctx.room,
    });

    // On call end: persist the call (transcript → MOM). Guarded so it fires exactly once.
    let summarized = false;
    const finishCall = async () => {
      if (summarized) return;
      summarized = true;
      if (!deviceId) return;
      // Authoritative source = the session history; fall back to event-captured turns.
      let turns = [];
      try {
        const items = (session.history && session.history.items) || [];
        for (const it of items) {
          const role = it && it.role;
          const text = it && typeof it.textContent === 'string' ? it.textContent : '';
          if ((role === 'user' || role === 'assistant') && text && text.trim()) {
            turns.push({ role, text: text.trim() });
          }
        }
      } catch { /* fall back below */ }
      if (!turns.length) turns = transcript;
      if (!turns.length) { console.warn('[voice-agent] no transcript to save'); return; }
      try {
        const r = await fetch(`${BACKEND_URL}/api/voice/call-summary`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId, mode, name, startedAtMs, endedAtMs: Date.now(), transcript: turns }),
        });
        console.log(`[voice-agent] call-summary saved=${r.ok} turns=${turns.length}`);
      } catch (e) {
        console.warn('[voice-agent] call-summary POST failed:', e.message);
      }
    };

    // Premium-gated cap: free = 5 min, premium/trial = 45 min (the token endpoint puts `premium` in the
    // room metadata). ~45s before the cap, nudge a warm wrap-up so the hang-up never feels abrupt; at the
    // cap, disconnect so the worker frees up.
    const maxMs = meta.premium === true ? 45 * 60 * 1000 : MAX_CALL_MS;
    const warnTimer = setTimeout(() => {
      try { session.generateReply({ instructions: 'You have under a minute left on this call. Give one clear takeaway and a simple next step, then warmly say goodbye.' }); } catch { /* non-fatal */ }
    }, Math.max(30_000, maxMs - 45_000));
    const capTimer = setTimeout(() => { ctx.room?.disconnect?.(); }, maxMs);
    const clearTimers = () => { clearTimeout(warnTimer); clearTimeout(capTimer); };
    ctx.room?.on?.('disconnected', () => { clearTimers(); finishCall(); });
    session.on?.('close', () => finishCall()); // backup save trigger
    // GUARANTEED save: the shutdown callback is AWAITED before the job process exits, so the POST
    // always completes (the disconnect event alone was racing the process teardown → lost saves).
    ctx.addShutdownCallback(async () => { clearTimers(); await finishCall(); });

    // The coach ALWAYS opens with a warm human greeting (no dead silence). On a coach-initiated call
    // she also states why she called; on a user-initiated call she greets, then lets the user lead.
    await session.generateReply({
      instructions: mode === 'ai'
        ? [
            `You are proactively calling them — like a friend who happens to be a great coach and noticed something.`,
            `1) Open with a warm, genuinely human greeting using their name: "Hey ${name || 'there'}, how are you doing today?" — real, not scripted.`,
            `2) Then give the SPECIFIC reason you called, pulled from your briefing data: name the exact gap/update with real numbers, tied to why it matters for their goal.`,
            `3) End with a gentle, open question ("How's that been feeling?").`,
            `Be concrete — never "what's going on?". If nothing's notable, keep it short and warm. Two to three sentences, then let them respond.`,
          ].join(' ')
        : `Open warmly and human, using their name: "Hey ${name || 'there'}, how are you doing today?" then a brief friendly invite ("What's on your mind?"). One or two sentences, then listen and let them lead. Don't launch into an agenda.`,
    });
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
