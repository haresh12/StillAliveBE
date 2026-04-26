'use strict';

// ═══════════════════════════════════════════════════════════════
// COMMUNITY — Pulse Backend
// Public wellness rooms, community rules acceptance, messages.
// Mounted at /api/community in server.js
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const admin = require('firebase-admin');

const router = express.Router();
const db = () => admin.firestore();

const FieldValue = admin.firestore.FieldValue;

const GROUPS = [
  {
    id: 'mind',
    name: 'Mind',
    emoji: '🧠',
    color: '#9D7BFF',
    description: 'Anxiety, overthinking, mood, emotional patterns, and support.',
    prompt: 'What is one thought loop you are trying to loosen today?',
  },
  {
    id: 'sleep',
    name: 'Sleep',
    emoji: '🌙',
    color: '#D4537E',
    description: 'Bedtime routines, sleep quality, racing thoughts, and recovery.',
    prompt: 'What helped or hurt your sleep last night?',
  },
  {
    id: 'nutrition',
    name: 'Nutrition',
    emoji: '🥗',
    color: '#1D9E75',
    description: 'Meals, cravings, energy, protein, planning, and simple wins.',
    prompt: 'What meal choice are you proud of today?',
  },
  {
    id: 'fitness',
    name: 'Fitness',
    emoji: '💪',
    color: '#EF9F27',
    description: 'Training, movement, consistency, soreness, and progress.',
    prompt: 'What movement did you get in today?',
  },
  {
    id: 'water',
    name: 'Water',
    emoji: '💧',
    color: '#38BDF8',
    description: 'Hydration, reminders, energy dips, workouts, and habits.',
    prompt: 'How is your hydration going right now?',
  },
  {
    id: 'fasting',
    name: 'Fasting',
    emoji: '🔥',
    color: '#F97316',
    description: 'Fasting windows, hunger waves, breaking fasts, and routines.',
    prompt: 'What is your fasting window or biggest challenge today?',
  },
];

const RULES = [
  'Be kind. Disagree without attacking, shaming, or mocking people.',
  'No medical diagnosis, crisis counseling, or dangerous instructions.',
  'Do not share private contact info, addresses, passwords, or financial details.',
  'Keep posts on topic for the group and avoid spam or self-promotion.',
  'Progress is welcome. Comparison, harassment, and hate are not.',
];

const GROUP_BY_ID = new Map(GROUPS.map(group => [group.id, group]));
const MAX_MESSAGE_LENGTH = 900;
const PAGE_LIMIT = 50;

const communityUserDoc = deviceId => db().collection('community_users').doc(deviceId);
const groupDoc = groupId => db().collection('community_groups').doc(groupId);
const messagesCol = groupId => groupDoc(groupId).collection('messages');
const participantsCol = groupId => groupDoc(groupId).collection('participants');

const serverTimestamp = () => FieldValue.serverTimestamp();

const toIso = value => {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const cleanText = value =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH);

const cleanName = value => {
  const name = String(value || '').replace(/\s+/g, ' ').trim();
  if (!name || name.toLowerCase() === 'user') return 'Pulse member';
  return name.slice(0, 40);
};

const isValidGroup = groupId => GROUP_BY_ID.has(groupId);

const mapMessage = doc => {
  const data = doc.data() || {};
  return {
    id: doc.id,
    groupId: data.groupId,
    deviceId: data.deviceId,
    displayName: data.displayName || 'Pulse member',
    text: data.text || '',
    createdAt: toIso(data.createdAt),
    editedAt: toIso(data.editedAt),
  };
};

const getUserRules = async deviceId => {
  if (!deviceId) return { accepted: false };
  const snap = await communityUserDoc(deviceId).get();
  if (!snap.exists) return { accepted: false };
  const data = snap.data() || {};
  return {
    accepted: !!data.rulesAcceptedAt,
    acceptedAt: toIso(data.rulesAcceptedAt),
  };
};

router.get('/groups', async (req, res) => {
  try {
    const { deviceId } = req.query;

    const snaps = await Promise.all(GROUPS.map(group => groupDoc(group.id).get()));
    const groups = snaps.map((snap, index) => {
      const fallback = GROUPS[index];
      const data = snap.exists ? snap.data() : fallback;
      return {
        id: fallback.id,
        name: data.name || fallback.name,
        emoji: data.emoji || fallback.emoji,
        color: data.color || fallback.color,
        description: data.description || fallback.description,
        prompt: data.prompt || fallback.prompt,
        memberCount: Number(data.memberCount || 0),
        messageCount: Number(data.messageCount || 0),
        lastMessageText: data.lastMessageText || '',
        lastMessageAt: toIso(data.lastMessageAt),
      };
    });

    res.json({
      success: true,
      groups,
      rules: RULES,
      rulesStatus: await getUserRules(deviceId),
    });
  } catch (err) {
    console.error('[community] /groups error:', err);
    res.status(500).json({ error: 'Could not load community groups' });
  }
});

router.get('/rules-status', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    res.json({ success: true, rulesStatus: await getUserRules(deviceId), rules: RULES });
  } catch (err) {
    console.error('[community] /rules-status error:', err);
    res.status(500).json({ error: 'Could not load rules status' });
  }
});

router.post('/rules/accept', async (req, res) => {
  try {
    const { deviceId, displayName } = req.body || {};
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    await communityUserDoc(deviceId).set({
      deviceId,
      displayName: cleanName(displayName),
      rulesAcceptedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true });

    res.json({ success: true, rulesStatus: { accepted: true } });
  } catch (err) {
    console.error('[community] /rules/accept error:', err);
    res.status(500).json({ error: 'Could not accept rules' });
  }
});

router.get('/groups/:groupId/messages', async (req, res) => {
  try {
    const { groupId } = req.params;
    const limit = Math.min(Number(req.query.limit || PAGE_LIMIT), PAGE_LIMIT);

    if (!isValidGroup(groupId)) return res.status(404).json({ error: 'Unknown group' });

    let query = messagesCol(groupId).orderBy('createdAt', 'desc').limit(limit);
    if (req.query.before) {
      const beforeSnap = await messagesCol(groupId).doc(String(req.query.before)).get();
      if (beforeSnap.exists) query = query.startAfter(beforeSnap);
    }

    const snap = await query.get();
    const messages = snap.docs.map(mapMessage).reverse();
    res.json({ success: true, messages });
  } catch (err) {
    console.error('[community] /messages error:', err);
    res.status(500).json({ error: 'Could not load messages' });
  }
});

router.post('/groups/:groupId/messages', async (req, res) => {
  try {
    const { groupId } = req.params;
    const { deviceId, displayName, text } = req.body || {};
    const cleanedText = cleanText(text);

    if (!isValidGroup(groupId)) return res.status(404).json({ error: 'Unknown group' });
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    if (!cleanedText) return res.status(400).json({ error: 'Message is empty' });

    const rules = await getUserRules(deviceId);
    if (!rules.accepted) {
      return res.status(403).json({ error: 'Community rules must be accepted first' });
    }

    const now = serverTimestamp();
    const name = cleanName(displayName);
    const messageRef = messagesCol(groupId).doc();
    const groupRef = groupDoc(groupId);
    const participantRef = participantsCol(groupId).doc(deviceId);
    const participantSnap = await participantRef.get();

    const message = {
      groupId,
      deviceId,
      displayName: name,
      text: cleanedText,
      createdAt: now,
      editedAt: null,
    };

    const batch = db().batch();
    batch.set(messageRef, message);
    batch.set(communityUserDoc(deviceId), {
      deviceId,
      displayName: name,
      lastActiveAt: now,
      updatedAt: now,
    }, { merge: true });
    batch.set(participantRef, {
      deviceId,
      displayName: name,
      joinedAt: now,
      lastActiveAt: now,
    }, { merge: true });
    const groupUpdate = {
      ...GROUP_BY_ID.get(groupId),
      isOpen: true,
      messageCount: FieldValue.increment(1),
      lastMessageText: cleanedText,
      lastMessageAt: now,
      updatedAt: now,
    };
    if (!participantSnap.exists) groupUpdate.memberCount = FieldValue.increment(1);
    batch.set(groupRef, groupUpdate, { merge: true });
    await batch.commit();

    const created = await messageRef.get();
    res.json({ success: true, message: mapMessage(created) });
  } catch (err) {
    console.error('[community] /send message error:', err);
    res.status(500).json({ error: 'Could not send message' });
  }
});

module.exports = router;
