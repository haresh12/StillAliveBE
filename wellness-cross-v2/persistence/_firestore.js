/**
 * wellness-cross-v2/persistence/_firestore.js
 *
 * Firestore client + path helpers. Single source for collection paths.
 */

const admin = require('firebase-admin');

function db() {
  return admin.firestore();
}

const userDoc = (id) => db().collection('wellness_users').doc(id);
const agentDoc = (id, agent) => userDoc(id).collection('agents').doc(agent);

// Each agent stores its history under a different sub-collection name (verified against agent code).
const AGENT_LOG_COLLECTIONS = {
  sleep:     'sleep_logs',
  mind:      'mind_checkins',
  nutrition: 'food_logs',
  fitness:   'fitness_workouts',
  water:     'water_logs',
  fasting:   'fasting_sessions',
};

const agentLogsCol = (id, agent) => {
  const colName = AGENT_LOG_COLLECTIONS[agent];
  if (!colName) throw new Error(`Unknown agent: ${agent}`);
  return agentDoc(id, agent).collection(colName);
};

// V2-owned paths.
// Singleton docs live under the cross_v2 sub-collection.
// Time-series collections (score_history, anomalies, reports) live at top level
// because Firestore can't .collection() directly on a CollectionReference.
const v2Col = (id) => userDoc(id).collection('cross_v2');
const v2ContextPack = (id) => v2Col(id).doc('context_pack');
const v2HomePack = (id) => v2Col(id).doc('home_pack');
const v2InsightsPack = (id, range) => v2Col(id).doc(`insights_pack_${range}d`);
const v2Correlations = (id) => v2Col(id).doc('correlations');
const v2Streaks = (id) => v2Col(id).doc('streaks');
const v2AnomaliesCol = (id) => userDoc(id).collection('cross_v2_anomalies');
const v2ScoreHistoryCol = (id) => userDoc(id).collection('cross_v2_score_history');
const v2ReportsCol = (id) => userDoc(id).collection('cross_v2_reports');
const v2AhaCol = (id) => userDoc(id).collection('cross_v2_aha');

const meta = () => db().collection('wellness_meta');
const metaCosts = (date) => meta().doc('llm_costs').collection('daily').doc(date);
const metaSchemaVersions = () => meta().doc('schema_versions');

module.exports = {
  db,
  userDoc,
  agentDoc,
  agentLogsCol,
  v2Col,
  v2ContextPack,
  v2HomePack,
  v2InsightsPack,
  v2Correlations,
  v2Streaks,
  v2AnomaliesCol,
  v2ScoreHistoryCol,
  v2ReportsCol,
  v2AhaCol,
  meta,
  metaCosts,
  metaSchemaVersions,
  Timestamp: admin.firestore.Timestamp,
  FieldValue: admin.firestore.FieldValue,
};
