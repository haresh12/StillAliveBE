'use strict';
/**
 * api/anchor.routes.js — registration-anchor exposure.
 *
 * GET /api/wellness/v2/anchor/:deviceId
 *   → { anchor_date, days_since_anchor, utc_offset_minutes, is_resolved }
 *
 * Used by:
 *   - <AnchorClampedCalendar> on every Track tab
 *   - <AnalysisRangeBar> on every Analysis tab
 *   - WellnessHomeTabV2 headline ("{N} days · {streak} streak")
 *
 * Cheap, idempotent — call as often as needed. Response is cached
 * server-side (5min) by lib/user-anchor.js.
 */

const express = require('express');
const router = express.Router();
const { requireDeviceId } = require('./_middleware');
const { resolveAnchor } = require('../../lib/user-anchor');
const { daysSinceAnchor } = require('../../lib/range-helpers');

router.get('/anchor/:deviceId', requireDeviceId, async (req, res) => {
  try {
    const anchor = await resolveAnchor(req.deviceId);
    res.json({
      anchor_date: anchor.anchorDateStr,
      days_since_anchor: anchor.isResolved
        ? daysSinceAnchor(Date.now(), anchor.anchorMs, anchor.utcOffsetMinutes)
        : 0,
      utc_offset_minutes: anchor.utcOffsetMinutes,
      is_resolved: anchor.isResolved,
      source: anchor.source,
    });
  } catch (err) {
    log.error('[anchor] route error:', err && err.message);
    res.status(500).json({ error: 'anchor_failed' });
  }
});

module.exports = router;
