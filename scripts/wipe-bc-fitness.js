/**
 * wipe-bc-fitness.js — clears the big-change fitness TEST data so you can start from zero.
 *
 * Deletes ONLY these subcollections under every wellness_bc_users/{id}/agents/fitness:
 *   fitness_chats · fitness_workouts · fitness_actions · fitness_chat_archive
 * KEEPS: the user doc + the fitness `setup` (your profile). LIVE wellness_* is NEVER touched.
 *
 * Safe by default — DRY RUN unless you pass --yes:
 *   node scripts/wipe-bc-fitness.js          # shows what WOULD be deleted
 *   node scripts/wipe-bc-fitness.js --yes    # actually deletes
 *
 * Run from the stillalive-backend dir (it reuses your .env Firebase credentials).
 */
require('dotenv').config();
const admin = require('firebase-admin');

const serviceAccount = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
  universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN,
};

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const { DATA_NAMESPACE, ns } = require('../lib/collections');

// ── HARD SAFETY GUARDS ────────────────────────────────────────────────────────
const USERS = ns('users'); // expected: wellness_bc_users
if (DATA_NAMESPACE !== 'bc' || !USERS.startsWith('wellness_bc_')) {
  console.error(`REFUSING: namespace is "${DATA_NAMESPACE}" / collection "${USERS}". This script ONLY wipes wellness_bc_*. Aborting.`);
  process.exit(1);
}

const APPLY = process.argv.includes('--yes');
const SUBCOLLECTIONS = ['fitness_chats', 'fitness_workouts', 'fitness_actions', 'fitness_chat_archive'];

(async () => {
  console.log(`Target collection : ${USERS}`);
  console.log(`Subcollections    : ${SUBCOLLECTIONS.join(', ')}`);
  console.log(APPLY ? '⚠️  APPLY MODE — data WILL be permanently deleted.\n' : 'DRY RUN — counting only. Re-run with --yes to delete.\n');

  const users = await db.collection(USERS).get();
  let total = 0;
  let deleted = 0;

  for (const u of users.docs) {
    const fitness = db.collection(USERS).doc(u.id).collection('agents').doc('fitness');
    for (const sub of SUBCOLLECTIONS) {
      const colRef = fitness.collection(sub);
      // belt-and-suspenders: never touch a path that isn't under wellness_bc_
      if (!colRef.path.startsWith('wellness_bc_')) {
        console.error('SKIP unsafe path:', colRef.path);
        continue;
      }
      const snap = await colRef.get();
      if (snap.empty) continue;
      total += snap.size;
      if (APPLY) {
        await db.recursiveDelete(colRef);
        deleted += snap.size;
        console.log(`  deleted ${snap.size.toString().padStart(4)}  ${u.id}/${sub}`);
      } else {
        console.log(`  would delete ${snap.size.toString().padStart(4)}  ${u.id}/${sub}`);
      }
    }
  }

  console.log(`\n${APPLY ? 'Deleted' : 'Would delete'} ${APPLY ? deleted : total} docs across ${users.size} bc user(s).`);
  console.log('Kept: user docs + fitness setup. Untouched: live wellness_* data.');
  process.exit(0);
})().catch(e => {
  console.error('Wipe failed:', e);
  process.exit(1);
});
