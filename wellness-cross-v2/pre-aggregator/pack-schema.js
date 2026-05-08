/**
 * pack-schema.js
 * Lightweight runtime validation for the context pack.
 * Throws on first shape violation.
 */

const REQUIRED_KEYS = [
  'pack_version',
  'computed_at',
  'stable_prefix_hash',
  'profile',
  'agents',
  'baselines',
  'matrix_dates',
  'stable_30d',
  'last_7d_floating',
  'today',
  'summary',
];

function assertContextPack(pack) {
  if (!pack || typeof pack !== 'object') throw new Error('pack must be object');
  for (const k of REQUIRED_KEYS) {
    if (!(k in pack)) throw new Error(`pack missing key: ${k}`);
  }
  if (!Array.isArray(pack.matrix_dates) || pack.matrix_dates.length === 0) {
    throw new Error('pack.matrix_dates must be non-empty array');
  }
  if (!pack.profile.setup_state) throw new Error('pack.profile.setup_state required');
  if (!pack.summary.tier && pack.summary.tier !== 0) throw new Error('pack.summary.tier required');
}

module.exports = { assertContextPack };
