'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// notifications.bc.agent.js — thin control plane for the big-change notification library.
//
// The notification INTELLIGENCE lives on the device (src/bigchange/notify — quiet hours, caps, fatigue,
// scheduling, the moment brain). The backend only does the two things that genuinely need a server:
//   POST /copy   — compose coach-voice copy for a batch of moments (Tier-1; FE falls back to its
//                  templates if this returns nothing). See lib/notif-copy.js.
//   POST /event  — engagement telemetry (delivered / tap / dismiss) for the learning loop. Best-effort.
//
// Cross-agent surface (a notification spans every domain) → lives outside the per-agent sandboxes.
// ═══════════════════════════════════════════════════════════════════════════
const express = require('express');
const { composeCopy } = require('./lib/notif-copy');

const router = express.Router();

// POST /api/notifications/copy  { deviceId, lang?, moments:[{id,kind,agent?,vars}] }
// → { items:[{id,title,body}] }  (empty items = FE uses its template copy)
router.post('/copy', async (req, res) => {
  try {
    const deviceId = String(req.body.deviceId || req.body.device_id || '').trim();
    const lang = (req.body.lang || '').toString().slice(0, 8);
    const moments = Array.isArray(req.body.moments) ? req.body.moments.slice(0, 12) : [];
    if (!deviceId || !moments.length) return res.json({ items: [] });
    const items = await composeCopy(deviceId, moments, lang).catch(() => null);
    res.json({ items: items || [] });
  } catch (e) {
    console.error('[notifications] /copy error:', e.message);
    res.json({ items: [] }); // never block a send — FE has templates
  }
});

// POST /api/notifications/event  { deviceId, type:'delivered'|'tap'|'dismiss', kind, channel, agent? }
// Best-effort telemetry for the learning loop (best-hour, A/B copy, fatigue tuning). Stored per user.
router.post('/event', async (req, res) => {
  try {
    const deviceId = String(req.body.deviceId || '').trim();
    const type = String(req.body.type || '').slice(0, 16);
    if (!deviceId || !type) return res.json({ ok: false });
    const admin = require('firebase-admin');
    const { userDoc } = require('./lib/collections');
    await userDoc(deviceId).collection('notif_events').add({
      type,
      kind: String(req.body.kind || '').slice(0, 40),
      channel: String(req.body.channel || '').slice(0, 24),
      agent: String(req.body.agent || '').slice(0, 16),
      at: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
    res.json({ ok: true });
  } catch {
    res.json({ ok: false });
  }
});

module.exports = router;
