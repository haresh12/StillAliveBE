/**
 * cron/nightly-batch.js
 * Nightly 3am UTC: refresh every active user's home_pack + insights_packs.
 * Throttled, parallel-bounded, failure-isolated.
 */

const { runForUser } = require('../orchestrator/workflow');
const { db, meta, metaCosts, Timestamp } = require('../persistence/_firestore');
const { drain, summarize } = require('../llm/telemetry');
const config = require('../config');

const PARALLELISM = 5;

async function listActiveUsers() {
  const snap = await db().collection('wellness_users').limit(2000).get();
  return snap.docs
    .map((d) => ({ id: d.id, data: d.data() }))
    .filter((u) => {
      // active = has any agent set up
      const flags = ['mind', 'sleep', 'nutrition', 'fitness', 'water', 'fasting'];
      return flags.some((a) => u.data[`${a}_setup_complete`]);
    });
}

async function nightlyBatch({ todayDate } = {}) {
  const today = todayDate || new Date().toISOString().slice(0, 10);
  console.log(`[v2 cron] nightly batch starting for ${today}`);
  const users = await listActiveUsers();
  console.log(`[v2 cron] ${users.length} active users`);

  let success = 0;
  let failed = 0;

  for (let i = 0; i < users.length; i += PARALLELISM) {
    const slice = users.slice(i, i + PARALLELISM);
    await Promise.all(
      slice.map(async (u) => {
        try {
          await runForUser(u.id, { todayDate: today });
          success++;
        } catch (err) {
          failed++;
          console.error(`[v2 cron] user=${u.id} failed:`, err && err.message);
        }
      }),
    );
  }

  // Flush telemetry
  const entries = drain();
  const summary = summarize(entries);
  await metaCosts(today).set({
    date: today,
    total_users_processed: users.length,
    success,
    failed,
    ...summary,
    _server_at: Timestamp.now(),
  }, { merge: true });

  console.log(`[v2 cron] done: ${success} ok / ${failed} failed · cost $${summary.total_cost_usd}`);

  if (summary.total_cost_usd > config.COST.MAX_DAILY_TOTAL_USD) {
    console.error(`[v2 cron] COST GUARD TRIPPED: $${summary.total_cost_usd} > $${config.COST.MAX_DAILY_TOTAL_USD}`);
  }

  return { success, failed, summary };
}

module.exports = { nightlyBatch };
