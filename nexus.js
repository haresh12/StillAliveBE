// ============================================================
// NEXUS — Pulse Background Orchestrator
//
// NOT a user-facing agent. Runs silently on cron every 6h.
// Responsibilities:
//   1. Analyze ALL agents' conversations per user
//   2. Create background action items user cannot dismiss
//   3. Detect disengaged users → schedule proactive nudges
//   4. Accountability: flag overdue tasks → trigger agent follow-ups
//   5. Cross-agent pattern detection → surface compound insights
// ============================================================

const { OpenAI } = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const AGENT_IDS   = ['luna', 'drift', 'bond', 'flux', 'vita', 'north'];
const AGENT_NAMES = { luna: 'LUNA', drift: 'DRIFT', bond: 'BOND', flux: 'FLUX', vita: 'VITA', north: 'NORTH' };
const AGENT_DOMAINS = {
  luna:  'mental health, anxiety, stress',
  drift: 'sleep, rest, recovery',
  bond:  'relationships, communication',
  flux:  'money, career, finances',
  vita:  'physical health, energy, body',
  north: 'purpose, direction, goals',
};

let db;
const setDb = (firestoreDb) => { db = firestoreDb; };

// ── Refs ──────────────────────────────────────────────────────────────────────

const userRef      = (uid)       => db.collection('wellness_users').doc(uid);
const agentRef     = (uid, aid)  => userRef(uid).collection('wellness_agents').doc(aid);
const messagesRef  = (uid, aid)  => agentRef(uid, aid).collection('wellness_messages');
const actionsRef   = (uid)       => userRef(uid).collection('wellness_actions');
const scheduledRef = (uid)       => userRef(uid).collection('wellness_scheduled');

// ── Helpers ───────────────────────────────────────────────────────────────────

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

function hoursSince(isoDate) {
  if (!isoDate) return Infinity;
  return (Date.now() - new Date(isoDate).getTime()) / 3600000;
}

// ── Per-user NEXUS analysis ───────────────────────────────────────────────────

async function analyzeUser(userId, userData) {
  const userName = userData.name || 'there';
  const since7d  = daysAgo(7);

  // ── 1. Gather data across all agents ──────────────────────────
  const agentData = {};
  await Promise.all(AGENT_IDS.map(async (aid) => {
    try {
      const stateSnap = await agentRef(userId, aid).get();
      const state     = stateSnap.exists ? stateSnap.data() : {};
      if (!state.setupComplete && !state.conversationCount) return;

      // Get recent messages (last 7 days, last 20 per agent)
      const msgSnap = await messagesRef(userId, aid)
        .orderBy('timestamp', 'desc').limit(20).get();

      const recentMsgs = msgSnap.docs
        .map(d => d.data())
        .filter(m => m.timestamp >= since7d)
        .reverse();

      if (recentMsgs.length === 0 && !state.setupComplete) return;

      agentData[aid] = {
        setupAnswers:      state.setupAnswers || {},
        conversationCount: state.conversationCount || 0,
        lastConversationAt: state.lastConversationAt,
        recentMessages:    recentMsgs.map(m => `[${m.role === 'user' ? userName : AGENT_NAMES[aid]}]: ${m.content}`),
      };
    } catch (e) {
      // non-blocking per agent
    }
  }));

  if (Object.keys(agentData).length === 0) return; // user has no active agents

  // ── 2. Get existing pending actions (for overdue detection) ───
  const actionsSnap = await actionsRef(userId)
    .where('status', '==', 'pending')
    .limit(30)
    .get();
  const pendingActions = actionsSnap.docs.map(d => d.data());
  const overdueActions = pendingActions.filter(a => a.dueDate && a.dueDate < new Date().toISOString());

  // ── 3. Build cross-agent context for GPT ──────────────────────
  const agentSections = Object.entries(agentData).map(([aid, data]) => {
    const domain   = AGENT_DOMAINS[aid];
    const lastChat = data.lastConversationAt ? `Last active: ${new Date(data.lastConversationAt).toLocaleDateString()}` : 'No conversations yet';
    const excerpt  = data.recentMessages.slice(-6).join('\n') || 'No recent messages';
    return `[${AGENT_NAMES[aid]} — ${domain}]\n${lastChat}\n${excerpt}`;
  }).join('\n\n---\n\n');

  const overdueSection = overdueActions.length > 0
    ? `\nOVERDUE ACTIONS:\n${overdueActions.map(a => `• [${AGENT_NAMES[a.agentId]}] ${a.title} (due ${a.dueDate?.slice(0,10)})`).join('\n')}`
    : '';

  // ── 4. NEXUS GPT-4o analysis ───────────────────────────────────
  const analysisPrompt = `You are NEXUS — the background intelligence engine of the Pulse wellness app.
You analyze a user's data across ALL life domains to create high-priority actions and interventions.

Your outputs are:
1. Background actions (0-3, automatically added, cannot be dismissed by user — make them count)
2. Agent nudges (0-2, proactive messages from specific agents to re-engage or follow up)
3. Accountability follow-ups (for any overdue tasks — send from the responsible agent)

USER: ${userName}
TODAY: ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}

CROSS-AGENT DATA (last 7 days):
${agentSections}
${overdueSection}

RULES:
- Background actions must be genuinely important and cross-domain (not just repeating what agents already said)
- Nudges should come from the MOST relevant agent, with a specific, warm opener that references real context
- Only create accountability follow-ups if tasks are >2 days overdue
- Never create more than 3 background actions — quality over quantity
- If user is broadly disengaged (no conversations in 48h+), pick their most-used agent for a re-engagement nudge

Respond with JSON only:
{
  "backgroundActions": [
    {
      "agentId": "luna|drift|bond|flux|vita|north",
      "title": "max 60 chars — specific and actionable",
      "detail": "one clear sentence why this matters now",
      "category": "mindfulness|habit|reflection|social|routine|task|financial|career|health|movement|nutrition|goal|decision|insight",
      "priority": "high|medium|low",
      "dueInDays": null or number
    }
  ],
  "agentNudges": [
    {
      "agentId": "luna|drift|bond|flux|vita|north",
      "inHours": number (when to fire — e.g. 4, 8, 12, 24),
      "type": "checkin|followup|accountability|insight|encouragement",
      "opener": "Exact message from the agent — warm, specific, max 130 chars. Must reference something real from recent conversations."
    }
  ]
}`;

  let analysis = { backgroundActions: [], agentNudges: [] };
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 800,
      temperature: 0.4,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: analysisPrompt },
        { role: 'user', content: 'Analyze and output JSON.' },
      ],
    });
    analysis = JSON.parse(completion.choices[0]?.message?.content || '{}');
  } catch (e) {
    console.error(`[NEXUS] GPT analysis error for ${userId}:`, e.message);
    return;
  }

  // ── 5. Persist background actions ─────────────────────────────
  const actionSaves = (analysis.backgroundActions || []).map(async (action) => {
    try {
      const ref     = actionsRef(userId).doc();
      const dueDate = action.dueInDays
        ? new Date(Date.now() + action.dueInDays * 86400000).toISOString()
        : null;
      await ref.set({
        id:           ref.id,
        agentId:      action.agentId,
        title:        action.title,
        detail:       action.detail || '',
        category:     action.category,
        priority:     action.priority || 'medium',
        status:       'pending',
        source:       'background',   // ← cannot be dismissed by user
        canDismiss:   false,
        createdAt:    new Date().toISOString(),
        dueDate,
        nexusRun:     new Date().toISOString(),
      });
    } catch (e) {
      console.error('[NEXUS] Action save error:', e.message);
    }
  });

  // ── 6. Schedule agent nudges ───────────────────────────────────
  const nudgeSaves = (analysis.agentNudges || []).map(async (nudge) => {
    try {
      const ref       = scheduledRef(userId).doc();
      const triggerAt = new Date(Date.now() + nudge.inHours * 3600000).toISOString();
      await ref.set({
        id:        ref.id,
        agentId:   nudge.agentId,
        triggerAt,
        type:      nudge.type,
        opener:    nudge.opener,
        status:    'pending',
        source:    'nexus',
        createdAt: new Date().toISOString(),
      });
    } catch (e) {
      console.error('[NEXUS] Nudge save error:', e.message);
    }
  });

  await Promise.all([...actionSaves, ...nudgeSaves]);

  // ── 7. Track last NEXUS run on user doc ───────────────────────
  await userRef(userId).update({ lastNexusRun: new Date().toISOString() }).catch(() => {});

  console.log(`[NEXUS] ✅ ${userName}: ${(analysis.backgroundActions || []).length} actions, ${(analysis.agentNudges || []).length} nudges`);
}

// ── Main entry point called by cron ──────────────────────────────────────────

async function runNexus(db_instance) {
  const startTime = Date.now();
  console.log(`[NEXUS] 🚀 Starting run at ${new Date().toISOString()}`);

  try {
    const usersSnap = await db_instance.collection('wellness_users').limit(500).get();
    if (usersSnap.empty) {
      console.log('[NEXUS] No users found.');
      return;
    }

    // Process users in parallel (batched to avoid rate limits)
    const BATCH_SIZE = 10;
    const users      = usersSnap.docs;
    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const batch = users.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(doc => analyzeUser(doc.id, doc.data()).catch(e => {
        console.error(`[NEXUS] Error for user ${doc.id}:`, e.message);
      })));
    }

    console.log(`[NEXUS] ✅ Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s — processed ${users.length} users`);
  } catch (e) {
    console.error('[NEXUS] Fatal error:', e.message);
  }
}

module.exports = { runNexus, setDb };
