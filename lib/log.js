'use strict';
/**
 * log.js — backend logger.
 *
 * Single choke-point for all stdout/stderr. Behaviour controlled by env:
 *   LOG_SILENT=1            → drop everything
 *   LOG_LEVEL=error|warn|info|debug   (default: info)
 *
 * Cloud Run captures stdout/stderr → Cloud Logging, so the underlying
 * console.* calls remain. The benefit of this wrapper is one env-flag kill
 * switch and a single place to swap in pino/winston later without touching
 * every call site.
 */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

const envLevelRaw = (process.env.LOG_LEVEL || 'info').toLowerCase();
const isSilent = ['1', 'true', 'yes'].includes(String(process.env.LOG_SILENT || '').toLowerCase());
const level = isSilent ? LEVELS.silent : (LEVELS[envLevelRaw] != null ? LEVELS[envLevelRaw] : LEVELS.info);

module.exports = {
  error: (...args) => { if (level >= LEVELS.error) console.error(...args); },
  warn:  (...args) => { if (level >= LEVELS.warn)  console.warn(...args); },
  info:  (...args) => { if (level >= LEVELS.info)  console.log(...args); },
  debug: (...args) => { if (level >= LEVELS.debug) console.log(...args); },
  level,
};
