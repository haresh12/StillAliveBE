/**
 * mixpanel.js — server-side Mixpanel emitter.
 *
 * Used by:
 *   • RevenueCat webhook (subscription lifecycle events the app cannot
 *     observe — renewals, server cancels, trial conversion)
 *   • Internal /api/analytics/event endpoint (backend cron writes)
 *   • GDPR delete on /api/account/delete
 *
 * No SDK — raw HTTPS. Mixpanel's Track API accepts a base64 JSON payload.
 *
 * Naming + privacy rules MUST mirror the app's `analyticsEvents.js`.
 * Don't add events here that aren't also in the app registry, or
 * dashboards will break.
 */
'use strict';

const https = require('https');
const crypto = require('crypto');

const MIXPANEL_TOKEN = process.env.MIXPANEL_TOKEN || '08d5bc88edea0436510d76070922c298';
const MIXPANEL_API_SECRET = process.env.MIXPANEL_API_SECRET || ''; // for /gdpr/delete

const ENABLED = process.env.NODE_ENV === 'production' || process.env.MIXPANEL_FORCE === '1';

const isOptedOutCache = new Map(); // distinctId -> boolean (cached briefly)

// ─── Track ───────────────────────────────────────────────────────────────────

/**
 * Send one event to Mixpanel.
 *
 * @param {string} eventName    — must match app's EVENTS registry
 * @param {string} distinctId   — device id of the user
 * @param {object} properties   — snake_case, no PII
 */
function track(eventName, distinctId, properties = {}) {
  if (!ENABLED) {
    return Promise.resolve(true);
  }
  if (!eventName || !distinctId) return Promise.resolve(false);

  const insertId = crypto.randomBytes(8).toString('hex');
  const payload = {
    event: eventName,
    properties: {
      token: MIXPANEL_TOKEN,
      distinct_id: distinctId,
      time: Date.now(),
      $insert_id: insertId,
      ...sanitize(properties),
      // Server-emitted events get this super-prop so they're filterable
      source: 'server',
    },
  };

  const body = Buffer.from(JSON.stringify([payload])).toString('base64');
  const data = `data=${encodeURIComponent(body)}`;

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.mixpanel.com',
      path: '/track',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data),
        'Accept': 'text/plain',
      },
      timeout: 5000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve(buf.trim() === '1'));
    });
    req.on('error', (e) => {
      log.warn('[mp] track error:', e?.message);
      resolve(false);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(data);
    req.end();
  });
}

// ─── People ──────────────────────────────────────────────────────────────────

function peopleSet(distinctId, props = {}) {
  if (!ENABLED) {
    return Promise.resolve(true);
  }
  if (!distinctId) return Promise.resolve(false);

  const payload = {
    $token: MIXPANEL_TOKEN,
    $distinct_id: distinctId,
    $set: sanitize(props),
  };
  const body = Buffer.from(JSON.stringify([payload])).toString('base64');
  const data = `data=${encodeURIComponent(body)}`;

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.mixpanel.com',
      path: '/engage',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 5000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve(buf.trim() === '1'));
    });
    req.on('error', (e) => { log.warn('[mp] engage error:', e?.message); resolve(false); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(data);
    req.end();
  });
}

// ─── GDPR delete (account deletion) ──────────────────────────────────────────

/**
 * Issue a GDPR-style delete for one distinctId.
 * Requires MIXPANEL_API_SECRET (project-level secret, not the public token).
 */
async function gdprDelete(distinctId) {
  if (!ENABLED) {
    return true;
  }
  if (!distinctId) return false;
  if (!MIXPANEL_API_SECRET) {
    log.warn('[mp] MIXPANEL_API_SECRET not set — cannot issue GDPR delete');
    return false;
  }

  const body = JSON.stringify({
    distinct_ids: [distinctId],
    compliance_type: 'GDPR',
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'mixpanel.com',
      path: '/api/app/data-deletions/v3.0/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(MIXPANEL_API_SECRET + ':').toString('base64'),
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 10000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sanitize(props) {
  const out = {};
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null) continue;
    if (k.includes('token') || k.includes('password') || k.includes('secret')) continue;
    out[k] = v;
  }
  return out;
}

module.exports = {
  track,
  peopleSet,
  gdprDelete,
  // Constants — keep in sync with src/utils/analyticsEvents.js
  EVENTS: Object.freeze({
    SUBSCRIPTION_RENEWED:    'Subscription Renewed',
    SUBSCRIPTION_CANCELLED:  'Subscription Cancelled',
    TRIAL_STARTED:           'Trial Started',
    TRIAL_CONVERTED:         'Trial Converted',
    TRIAL_EXPIRED:           'Trial Expired',
    PURCHASE_COMPLETED:      'Purchase Completed',
  }),
  PEOPLE: Object.freeze({
    PLAN_TYPE:   'Plan Type',
    IS_PREMIUM:  'Is Premium',
    IS_TRIAL:    'Is Trial',
    TRIAL_END_AT:'Trial End At',
  }),
};
