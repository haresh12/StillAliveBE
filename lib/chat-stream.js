"use strict";
// ════════════════════════════════════════════════════════════════
// chat-stream.js — shared SSE streaming endpoint for all agents.
//
// Each agent calls mountChatStream(router, deps) ONCE near its other
// chat routes. The agent provides:
//   - agentName
//   - openai client
//   - chatsCol(deviceId) → Firestore collection ref
//   - admin (firebase-admin)
//   - buildPrompt(deviceId, message) → Promise<{ systemPrompt, history }>
//   - rateLimitCheck(deviceId) → boolean (true = allowed)
//   - model (default gpt-4.1-mini)
//
// SSE protocol:
//   event: start    data: {message_id}
//   event: token    data: {delta:"word "}
//   event: done     data: {message_id, content}
//   event: error    data: {error, retry_after?}
//
// Compatible with iOS/Android EventSource polyfills + plain fetch readers.
// ════════════════════════════════════════════════════════════════

function sse(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  if (typeof res.flush === "function") res.flush();
}

function mountChatStream(router, deps) {
  const {
    agentName,
    openai,
    chatsCol,
    admin,
    buildPrompt,
    rateLimitCheck,
    model = "gpt-4.1-mini",
    maxTokens = 400,
    temperature = 0.55,
  } = deps;

  router.post("/chat/stream", async (req, res) => {
    const { deviceId, message, proactive_context } = req.body || {};
    if (!deviceId || !message) {
      return res.status(400).json({ error: "deviceId and message required" });
    }
    if (typeof rateLimitCheck === "function" && !rateLimitCheck(deviceId)) {
      res.setHeader("Retry-After", "60");
      return res.status(429).json({ error: "Too many messages. Wait a moment.", retry_after: 60 });
    }

    // Set up SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders && res.flushHeaders();

    const userMessageId = `user-${Date.now()}`;
    const assistantMessageId = `asst-${Date.now() + 1}`;
    let aborted = false;
    req.on("close", () => { aborted = true; });

    try {
      sse(res, "start", { message_id: assistantMessageId });

      // Build per-agent prompt
      const { systemPrompt, history = [] } = await buildPrompt(deviceId, message, { proactive_context });

      // Persist user message immediately so polling clients see it
      try {
        await chatsCol(deviceId).add({
          role: "user",
          content: message,
          is_proactive: false,
          is_read: true,
          created_at: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (e) { /* non-fatal — keep streaming */ }

      const stream = await openai.chat.completions.create({
        model,
        max_tokens: maxTokens,
        temperature,
        stream: true,
        messages: [
          { role: "system", content: systemPrompt },
          ...history,
          { role: "user", content: message },
        ],
      });

      let full = "";
      for await (const chunk of stream) {
        if (aborted) {
          try { stream.controller && stream.controller.abort && stream.controller.abort(); } catch {}
          break;
        }
        const delta = chunk?.choices?.[0]?.delta?.content || "";
        if (!delta) continue;
        full += delta;
        sse(res, "token", { delta });
      }

      // Persist assistant message
      try {
        await chatsCol(deviceId).add({
          role: "assistant",
          content: full,
          is_proactive: false,
          is_read: true,
          created_at: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (e) { /* non-fatal */ }

      sse(res, "done", { message_id: assistantMessageId, content: full });
      res.end();
    } catch (e) {
      console.error(`[${agentName}] /chat/stream error:`, e?.message);
      try {
        sse(res, "error", { error: e?.message || "stream_error" });
        res.end();
      } catch {}
    }
  });
}

module.exports = { mountChatStream };
