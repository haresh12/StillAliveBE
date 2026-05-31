/**
 * push.js — FCM/APNs push helper for Wellness OS backend.
 *
 * Single entry point for sending push notifications to a deviceId. Uses the
 * Firebase Admin SDK's `messaging()` API which routes APNs (iOS) and FCM
 * (Android) under one call.
 *
 * Token storage: `wellness_users/{deviceId}.fcmToken` + `.fcmPlatform`
 * (`'ios'` | `'android'`) are written by POST /api/notifications/register-token
 * (see server.js).
 *
 * Payload shape (per platform):
 *   iOS APNs — `apns.payload.aps` block (alert/sound/badge)
 *   Android FCM — `android.notification` block (channelId/priority/icon)
 *   Both — `data` block carries deep-link string. We surface this via
 *     `data.deep_link` (e.g. `wellnessos://fitness/voice`) which the FE
 *     reads in App.tsx onMessage/onNotificationOpenedApp.
 */

const admin = require('firebase-admin');

let _log;
try { _log = require('./log'); } catch { _log = { info: () => {}, warn: () => {}, error: () => {} }; }

/**
 * Send a push to one deviceId. Best-effort — never throws.
 *
 * @param {string} deviceId   — wellness_users doc id
 * @param {object} payload
 * @param {string} payload.title
 * @param {string} payload.body
 * @param {object} [payload.data]       — string-only key/values for deep-link routing
 * @param {string} [payload.deepLink]   — convenience; copied into data.deep_link
 * @param {string} [payload.channelId]  — Android channel override (default 'general')
 * @returns {Promise<{ok: boolean, messageId?: string, error?: string, platform?: string}>}
 */
async function sendPushTo(deviceId, payload = {}) {
  if (!deviceId) return { ok: false, error: 'deviceId required' };
  const title = String(payload.title || '').slice(0, 256);
  const body  = String(payload.body  || '').slice(0, 1024);
  if (!title && !body) return { ok: false, error: 'title or body required' };

  let token, platform;
  try {
    const snap = await admin.firestore().collection('wellness_users').doc(deviceId).get();
    if (!snap.exists) return { ok: false, error: 'user not found' };
    const d = snap.data() || {};
    token = d.fcmToken;
    platform = d.fcmPlatform; // 'ios' | 'android'
    if (!token) return { ok: false, error: 'no push token registered' };
  } catch (e) {
    _log.warn(`[push] firestore read failed for ${deviceId.slice(0, 8)}:`, e.message);
    return { ok: false, error: e.message };
  }

  // Stringify all data values — FCM requires string values in the data block.
  const rawData = { ...(payload.data || {}) };
  if (payload.deepLink) rawData.deep_link = payload.deepLink;
  const data = {};
  for (const [k, v] of Object.entries(rawData)) {
    if (v === undefined || v === null) continue;
    data[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }

  const channelId = payload.channelId || 'general';

  // Build a single multi-platform message. Firebase Admin will pick the right
  // delivery path based on the token format (APNs vs FCM).
  const message = {
    token,
    notification: { title, body },
    data,
    android: {
      priority: 'high',
      notification: {
        channelId,
        // Default smallIcon for FCM-delivered pushes. Notifee-displayed
        // foreground pushes (App.tsx onMessage) use ic_notification too.
        // Keep them in sync if you change one.
        defaultSound: true,
      },
    },
    apns: {
      payload: {
        aps: {
          alert: { title, body },
          sound: 'default',
          'mutable-content': 1,
        },
      },
    },
  };

  try {
    const messageId = await admin.messaging().send(message);
    _log.info(`[push] sent device=${deviceId.slice(0, 8)} platform=${platform} id=${messageId}`);
    return { ok: true, messageId, platform };
  } catch (e) {
    // Token expired / unregistered — clean up so we don't keep retrying.
    const code = e?.errorInfo?.code || e?.code || '';
    if (code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token') {
      try {
        await admin.firestore().collection('wellness_users').doc(deviceId).update({
          fcmToken: admin.firestore.FieldValue.delete(),
          fcmTokenInvalidatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch {}
      _log.warn(`[push] token invalidated device=${deviceId.slice(0, 8)} code=${code}`);
      return { ok: false, error: 'token invalid', platform };
    }
    _log.warn(`[push] send failed device=${deviceId.slice(0, 8)} code=${code} msg=${e?.message}`);
    return { ok: false, error: e?.message || 'send failed', platform };
  }
}

module.exports = { sendPushTo };
