/**
 * wellness-cross-v2/index.js
 *
 * Module entry. Mounted by server.js as:
 *   app.use('/api/wellness/v2', require('./wellness-cross-v2'));
 */

const express = require('express');
const router = express.Router();

const config = require('./config');

router.use((req, res, next) => {
  res.set('X-Wellness-Cross-V2-Version', config.MODULE_VERSION);
  next();
});

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    module: 'wellness-cross-v2',
    version: config.MODULE_VERSION,
    schema_versions: {
      pack: config.PACK_SCHEMA_VERSION,
      home: config.HOME_SCHEMA_VERSION,
      insights: config.INSIGHTS_SCHEMA_VERSION,
      score: config.SCORE_SCHEMA_VERSION,
      correlations: config.CORRELATIONS_SCHEMA_VERSION,
    },
    has_gemini_key: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
    has_openai_key: !!process.env.OPENAI_API_KEY,
  });
});

router.use(require('./api/home.routes'));
router.use(require('./api/insights.routes'));
router.use(require('./api/recompute.routes'));
router.use(require('./api/agent-scores.routes'));
router.use(require('./api/anchor.routes'));

module.exports = router;
