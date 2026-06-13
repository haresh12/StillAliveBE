'use strict';
// ═══════════════════════════════════════════════════════════════
// collections.js — single source of truth for collection names.
//
// DATA_NAMESPACE lets the "big-change" branch run against a PARALLEL set of
// collections (wellness_bc_*) so the live wellness_* data is never touched while
// we rebuild. To promote to live later, flip DATA_NAMESPACE to '' (or run a
// migration). NEVER hardcode a collection name elsewhere — go through ns()/helpers.
//
// Honors the data laws: wellness_* prefix, no `users` collection, device-ID keyed.
// ═══════════════════════════════════════════════════════════════

const admin = require('firebase-admin');

const db = () => admin.firestore();

// 'bc' on the big-change branch. Override via env (e.g. DATA_NAMESPACE='' for live).
const DATA_NAMESPACE =
  process.env.DATA_NAMESPACE !== undefined ? process.env.DATA_NAMESPACE : 'bc';

// ns('users') -> 'wellness_bc_users'  (live: 'wellness_users')
const ns = base =>
  DATA_NAMESPACE ? `wellness_${DATA_NAMESPACE}_${base}` : `wellness_${base}`;

const userDoc = deviceId => db().collection(ns('users')).doc(String(deviceId));
const onboardingDoc = deviceId =>
  db().collection(ns('onboarding')).doc(String(deviceId));

module.exports = { DATA_NAMESPACE, ns, db, userDoc, onboardingDoc };
