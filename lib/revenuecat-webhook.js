/**
 * revenuecat-webhook.js — RC events → Mixpanel.
 *
 * RC fires us when a subscription state changes (renewal, cancel, trial
 * convert/expire). Those events the app cannot reliably observe — they
 * happen server-side or while the app is closed. So we mirror them into
 * Mixpanel from here.
 *
 * Mounted at: POST /webhooks/revenuecat
 *
 * Auth: shared bearer token in `Authorization: Bearer <REVENUECAT_WEBHOOK_AUTH>`.
 *
 * RC event types we care about (their `event.type`):
 *   INITIAL_PURCHASE       → already tracked client-side, skip
 *   RENEWAL                → Subscription Renewed
 *   CANCELLATION           → Subscription Cancelled
 *   EXPIRATION             → Subscription Cancelled (reason: expired)
 *   TRIAL_STARTED          → Trial Started
 *   TRIAL_CONVERTED        → Trial Converted
 *   TRIAL_CANCELLED        → Trial Expired (reason: cancelled)
 *   PRODUCT_CHANGE         → Subscription Renewed (period_changed: true)
 *   NON_RENEWING_PURCHASE  → ignored (we only sell subs)
 *   UNCANCELLATION         → ignored (handled by next renewal)
 *   BILLING_ISSUE          → Subscription Cancelled (reason: billing)
 */
'use strict';

const express = require('express');
const router = express.Router();
const mp = require('./mixpanel');

const RC_AUTH = process.env.REVENUECAT_WEBHOOK_AUTH || '';

router.post('/', express.json({ limit: '1mb' }), async (req, res) => {
  // Auth check — fail CLOSED. If the secret isn't configured, or the header doesn't match,
  // reject (never process). Mirrors the canonical /api/webhooks/revenuecat handler.
  const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!RC_AUTH || got !== RC_AUTH) return res.status(401).json({ error: 'unauthorized' });

  const ev = req.body && req.body.event;
  if (!ev || !ev.type) return res.status(400).json({ error: 'malformed' });

  const distinctId = ev.app_user_id || ev.original_app_user_id;
  if (!distinctId) return res.status(400).json({ error: 'no_app_user_id' });

  const planId = ev.product_id || ev.entitlement_ids?.[0] || 'unknown';
  const period = ev.period_type || (planId.includes('annual') ? 'annual' : 'monthly');

  try {
    switch (ev.type) {
      case 'RENEWAL':
      case 'PRODUCT_CHANGE':
        await mp.track(mp.EVENTS.SUBSCRIPTION_RENEWED, distinctId, {
          plan: planId,
          period,
          period_changed: ev.type === 'PRODUCT_CHANGE',
        });
        break;
      case 'CANCELLATION':
        await mp.track(mp.EVENTS.SUBSCRIPTION_CANCELLED, distinctId, {
          plan: planId,
          reason: ev.cancel_reason || 'user_cancelled',
        });
        break;
      case 'EXPIRATION':
        await mp.track(mp.EVENTS.SUBSCRIPTION_CANCELLED, distinctId, {
          plan: planId,
          reason: 'expired',
        });
        await mp.peopleSet(distinctId, {
          [mp.PEOPLE.IS_PREMIUM]: false,
          [mp.PEOPLE.IS_TRIAL]: false,
        });
        break;
      case 'BILLING_ISSUE':
        await mp.track(mp.EVENTS.SUBSCRIPTION_CANCELLED, distinctId, {
          plan: planId,
          reason: 'billing_issue',
        });
        break;
      case 'TRIAL_STARTED':
        await mp.track(mp.EVENTS.TRIAL_STARTED, distinctId, {
          plan: planId,
          trial_days: typeof ev.trial_days === 'number' ? ev.trial_days : undefined,
        });
        await mp.peopleSet(distinctId, { [mp.PEOPLE.IS_TRIAL]: true });
        break;
      case 'TRIAL_CONVERTED':
        await mp.track(mp.EVENTS.TRIAL_CONVERTED, distinctId, { plan: planId });
        await mp.peopleSet(distinctId, { [mp.PEOPLE.IS_TRIAL]: false, [mp.PEOPLE.IS_PREMIUM]: true });
        break;
      case 'TRIAL_CANCELLED':
        await mp.track(mp.EVENTS.TRIAL_EXPIRED, distinctId, { plan: planId });
        await mp.peopleSet(distinctId, { [mp.PEOPLE.IS_TRIAL]: false });
        break;
      default:
        // INITIAL_PURCHASE / UNCANCELLATION / NON_RENEWING_PURCHASE — no-op
        break;
    }
    res.json({ ok: true });
  } catch (e) {
    log.warn('[rc-webhook] error:', e?.message);
    res.status(500).json({ error: 'internal' });
  }
});

module.exports = router;
