/**
 * ── PULSE COMMUNITY ──────────────────────────────────────────────────────────
 * Multi-group chat. Each message belongs to a groupId.
 *
 * Collections:
 *  communityMessages/{msgId}
 *    deviceId, displayName, content, agentId, groupId, timestamp,
 *    deleted, edited, replyTo, reactions
 *
 *  communityMembers/{deviceId}
 *    deviceId, displayName, agentId, joinedAt, acceptedRulesAt,
 *    messageCount, lastSeenAt, muted
 *
 *  communityReports/{reportId}
 *    messageId, reporterId, reason, timestamp, resolved
 *
 * In-memory ephemeral state:
 *  lastMessageTime — rate limiting per device
 *  typingMap       — typing indicators per group, with 6s TTL
 *                    key: `${groupId}:${deviceId}`
 */

const express = require('express');
const router  = express.Router();
const admin   = require('firebase-admin');

let db;
const setDb = (firestoreDb) => { db = firestoreDb; };

// ── Constants ─────────────────────────────────────────────────────────────────
const PAGE_SIZE        = 30;
const MAX_MSG_LENGTH   = 500;
const RATE_LIMIT_MS    = 2000;
const MAX_DISPLAY_NAME = 30;
const TYPING_TTL       = 6000;

const VALID_GROUPS = new Set([
  'general', 'health', 'wealth', 'relationships', 'mental', 'purpose', 'habits',
]);

// ── In-memory state ───────────────────────────────────────────────────────────
const lastMessageTime = new Map(); // deviceId → timestamp (ms)
const typingMap       = new Map(); // `${groupId}:${deviceId}` → { displayName, agentId, expiresAt }

// ── Helpers ───────────────────────────────────────────────────────────────────
const msgRef = () => db.collection('communityMessages');
const memRef = () => db.collection('communityMembers');
const repRef = () => db.collection('communityReports');

const requireDevice = (req, res, next) => {
  const deviceId = req.headers['x-user-id'] || req.body?.deviceId;
  if (!deviceId) return res.status(400).json({ success: false, error: 'x-user-id header required' });
  req.deviceId = deviceId;
  next();
};

const requireMember = async (req, res, next) => {
  try {
    const snap = await memRef().doc(req.deviceId).get();
    if (!snap.exists || !snap.data().acceptedRulesAt) {
      return res.status(403).json({ success: false, error: 'Must accept community rules first', code: 'RULES_NOT_ACCEPTED' });
    }
    req.member = snap.data();
    next();
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
};

const validGroup = (groupId) => VALID_GROUPS.has(groupId) ? groupId : 'general';

const formatMsg = (doc) => {
  const d = doc.data();
  return {
    id:          doc.id,
    deviceId:    d.deviceId,
    displayName: d.displayName || 'Member',
    agentId:     d.agentId    || 'north',
    groupId:     d.groupId    || 'general',
    content:     d.deleted ? '[removed]' : d.content,
    deleted:     d.deleted   || false,
    edited:      d.edited    || false,
    replyTo:     d.replyTo   || null,
    reactions:   d.reactions || {},
    timestamp:   d.timestamp?.toMillis?.() || Date.now(),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/community/status
router.get('/status', requireDevice, async (req, res) => {
  try {
    const [memberSnap, mySnap] = await Promise.all([
      memRef().count().get(),
      memRef().doc(req.deviceId).get(),
    ]);
    const me = mySnap.exists ? mySnap.data() : null;
    res.json({
      success:      true,
      totalMembers: memberSnap.data().count,
      joined:       !!me?.acceptedRulesAt,
      displayName:  me?.displayName || null,
      agentId:      me?.agentId     || null,
      messageCount: me?.messageCount || 0,
      muted:        me?.muted        || false,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/community/join
router.post('/join', requireDevice, async (req, res) => {
  try {
    const { displayName, agentId } = req.body;
    if (!displayName?.trim()) return res.status(400).json({ success: false, error: 'displayName required' });

    const name     = displayName.trim().slice(0, MAX_DISPLAY_NAME);
    const existing = await memRef().doc(req.deviceId).get();

    if (existing.exists && existing.data().acceptedRulesAt) {
      await memRef().doc(req.deviceId).update({
        lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
        agentId:    agentId || existing.data().agentId || 'north',
      });
      return res.json({ success: true, alreadyJoined: true });
    }

    await memRef().doc(req.deviceId).set({
      deviceId:        req.deviceId,
      displayName:     name,
      agentId:         agentId || 'north',
      joinedAt:        admin.firestore.FieldValue.serverTimestamp(),
      acceptedRulesAt: admin.firestore.FieldValue.serverTimestamp(),
      messageCount:    0,
      lastSeenAt:      admin.firestore.FieldValue.serverTimestamp(),
      muted:           false,
    }, { merge: true });

    res.json({ success: true, alreadyJoined: false });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/community/messages?groupId=health
//   &after=<ts>   — poll newer
//   &before=<ts>  — paginate older
router.get('/messages', requireDevice, requireMember, async (req, res) => {
  try {
    const groupId = validGroup(req.query.groupId);
    const before  = req.query.before ? parseInt(req.query.before) : null;
    const after   = req.query.after  ? parseInt(req.query.after)  : null;

    // ── Polling ───────────────────────────────────────────────────────────────
    if (after) {
      const snap = await msgRef()
        .where('groupId', '==', groupId)
        .orderBy('timestamp', 'asc')
        .startAfter(admin.firestore.Timestamp.fromMillis(after))
        .limit(PAGE_SIZE)
        .get();
      return res.json({ success: true, messages: snap.docs.map(formatMsg), hasMore: false, nextCursor: null });
    }

    // ── Initial / paginate ────────────────────────────────────────────────────
    let q = msgRef()
      .where('groupId', '==', groupId)
      .orderBy('timestamp', 'desc')
      .limit(PAGE_SIZE);
    if (before) q = q.startAfter(admin.firestore.Timestamp.fromMillis(before));

    const snap     = await q.get();
    const messages = snap.docs.reverse().map(formatMsg);
    const nextCursor = snap.docs.length > 0
      ? snap.docs[snap.docs.length - 1].data().timestamp?.toMillis?.() || null
      : null;

    res.json({ success: true, messages, hasMore: snap.docs.length === PAGE_SIZE, nextCursor });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/community/messages  — body: { content, groupId, replyTo? }
router.post('/messages', requireDevice, requireMember, async (req, res) => {
  try {
    if (req.member.muted) {
      return res.status(403).json({ success: false, error: 'You are muted', code: 'MUTED' });
    }

    const { content, replyTo } = req.body;
    const groupId = validGroup(req.body.groupId);
    if (!content?.trim()) return res.status(400).json({ success: false, error: 'content required' });

    const text = content.trim().slice(0, MAX_MSG_LENGTH);
    const now  = Date.now();
    const last = lastMessageTime.get(req.deviceId) || 0;

    if (now - last < RATE_LIMIT_MS) {
      const wait = Math.ceil((RATE_LIMIT_MS - (now - last)) / 1000);
      return res.status(429).json({ success: false, error: `Wait ${wait}s`, code: 'RATE_LIMITED' });
    }
    lastMessageTime.set(req.deviceId, now);

    let replyData = null;
    if (replyTo) {
      const replySnap = await msgRef().doc(replyTo).get();
      if (replySnap.exists && !replySnap.data().deleted) {
        const rd = replySnap.data();
        replyData = { id: replySnap.id, displayName: rd.displayName, content: rd.content.slice(0, 80) };
      }
    }

    const batch     = db.batch();
    const msgDocRef = msgRef().doc();
    const msgData   = {
      deviceId:    req.deviceId,
      displayName: req.member.displayName,
      agentId:     req.member.agentId || 'north',
      groupId,
      content:     text,
      deleted:     false,
      edited:      false,
      replyTo:     replyData,
      reactions:   {},
      timestamp:   admin.firestore.FieldValue.serverTimestamp(),
    };

    batch.set(msgDocRef, msgData);
    batch.update(memRef().doc(req.deviceId), {
      messageCount: admin.firestore.FieldValue.increment(1),
      lastSeenAt:   admin.firestore.FieldValue.serverTimestamp(),
    });
    await batch.commit();

    // Clear typing for this user in this group
    typingMap.delete(`${groupId}:${req.deviceId}`);

    res.json({
      success: true,
      message: { id: msgDocRef.id, ...msgData, timestamp: now, replyTo: replyData },
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// PATCH /api/community/messages/:msgId/react
router.patch('/messages/:msgId/react', requireDevice, requireMember, async (req, res) => {
  try {
    const { emoji } = req.body;
    const ALLOWED   = ['❤️', '🔥', '💪', '🙌', '😂', '💡'];
    if (!ALLOWED.includes(emoji)) return res.status(400).json({ success: false, error: 'Emoji not allowed' });

    const docRef  = msgRef().doc(req.params.msgId);
    const docSnap = await docRef.get();
    if (!docSnap.exists || docSnap.data().deleted) {
      return res.status(404).json({ success: false, error: 'Message not found' });
    }

    const reactions      = docSnap.data().reactions || {};
    const key            = `reactions.${emoji}`;
    const currentList    = reactions[emoji] || [];
    const alreadyReacted = currentList.includes(req.deviceId);

    await docRef.update({
      [key]: alreadyReacted
        ? admin.firestore.FieldValue.arrayRemove(req.deviceId)
        : admin.firestore.FieldValue.arrayUnion(req.deviceId),
    });

    res.json({ success: true, toggled: alreadyReacted ? 'removed' : 'added' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/community/messages/:msgId
router.delete('/messages/:msgId', requireDevice, requireMember, async (req, res) => {
  try {
    const docRef  = msgRef().doc(req.params.msgId);
    const docSnap = await docRef.get();
    if (!docSnap.exists) return res.status(404).json({ success: false, error: 'Message not found' });
    if (docSnap.data().deviceId !== req.deviceId) {
      return res.status(403).json({ success: false, error: 'Not your message' });
    }
    await docRef.update({ deleted: true, content: '[removed]' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/community/messages/:msgId/report
router.post('/messages/:msgId/report', requireDevice, requireMember, async (req, res) => {
  try {
    const existing = await repRef()
      .where('messageId', '==', req.params.msgId)
      .where('reporterId', '==', req.deviceId)
      .limit(1).get();

    if (!existing.empty) return res.json({ success: true, alreadyReported: true });

    await repRef().add({
      messageId:  req.params.msgId,
      reporterId: req.deviceId,
      reason:     req.body.reason || 'No reason given',
      timestamp:  admin.firestore.FieldValue.serverTimestamp(),
      resolved:   false,
    });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/community/typing  — body: { groupId }
router.post('/typing', requireDevice, requireMember, async (req, res) => {
  const groupId = validGroup(req.body?.groupId);
  typingMap.set(`${groupId}:${req.deviceId}`, {
    displayName: req.member.displayName,
    agentId:     req.member.agentId || 'north',
    expiresAt:   Date.now() + TYPING_TTL,
  });
  res.json({ success: true });
});

// GET /api/community/typing?groupId=health
router.get('/typing', requireDevice, requireMember, async (req, res) => {
  const groupId = validGroup(req.query.groupId);
  const prefix  = `${groupId}:`;
  const now     = Date.now();
  const active  = [];

  for (const [key, info] of typingMap.entries()) {
    if (!key.startsWith(prefix)) continue;
    if (info.expiresAt < now) {
      typingMap.delete(key);
    } else {
      const deviceId = key.slice(prefix.length);
      if (deviceId !== req.deviceId) {
        active.push({ deviceId, displayName: info.displayName, agentId: info.agentId });
      }
    }
  }
  res.json({ success: true, typing: active });
});

// PATCH /api/community/me
router.patch('/me', requireDevice, requireMember, async (req, res) => {
  try {
    const { displayName, agentId } = req.body;
    const update = { lastSeenAt: admin.firestore.FieldValue.serverTimestamp() };
    if (displayName?.trim()) update.displayName = displayName.trim().slice(0, MAX_DISPLAY_NAME);
    if (agentId)             update.agentId     = agentId;
    await memRef().doc(req.deviceId).update(update);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/community/seen
router.post('/seen', requireDevice, requireMember, async (req, res) => {
  try {
    await memRef().doc(req.deviceId).update({ lastSeenAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Admin ──────────────────────────────────────────────────────────────────────
const adminAuth = (req, res, next) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.headers['x-admin-secret'] !== secret) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
};

router.delete('/admin/messages/:msgId', adminAuth, async (req, res) => {
  try {
    await msgRef().doc(req.params.msgId).update({ deleted: true, content: '[removed by moderator]' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.patch('/admin/members/:deviceId/mute', adminAuth, async (req, res) => {
  try {
    await memRef().doc(req.params.deviceId).update({ muted: !!req.body.muted });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = { router, setDb };
