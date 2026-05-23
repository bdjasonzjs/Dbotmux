/**
 * Scout spawner — P2/8 L2 entry point.
 *
 * Responsible for spawning the 缇蕾 (Codex) bot in scout mode: she reads
 * the entire main-bot data layer (ChatTopology + recent sessions), writes
 * a fresh MainBotDigest, and enqueues any new escalation items to the
 * ScoutInbox.
 *
 * In v0.1 we **synchronously** call into the in-process escalation engine
 * rather than spawning a real Codex CLI worker for every tick. This keeps
 * the L1→L2→L3 pipeline runnable end-to-end without depending on a
 * usable codex binary in the daemon process (codex isn't always wired,
 * and a real spawn would dominate token cost during dogfooding).
 *
 * When ready to escalate to a real LLM-powered scout, swap
 * `runScoutInProcess()` for a `forkWorker({ cliId: 'codex', sessionType:
 * 'scout-tick', promptFile, onComplete: parseScoutOutput })` call here.
 * The escalation rules + digest writing stay the same; only the summary
 * generation step moves to LLM.
 */
import { readTopology, type ChatNode, heatFromLastMessage } from '../services/chat-topology-store.js';
import {
  readDigest, writeDigest, markFresh, enqueueEscalation, readInbox,
  type MainBotDigest, type MainBotDigestChat, type Escalation,
} from '../services/main-bot-digest-store.js';
import { runEscalationRules, type RulesInput } from './escalation-rules.js';
import { dispatchPendingEscalations } from './escalation-playbook.js';
import { inferSameTopicEdges } from './same-topic-inference.js';
import { logger } from '../utils/logger.js';

/** State held in-process per-bot daemon so we can detect "first time we
 *  see an unanswered ping" vs "still pending" between scout ticks. */
const PER_DAEMON_STATE = {
  /** chatId → ISO timestamp of the bot-message that triggered ping detection.
   *  Real implementation would scan recent messages; v0.1 stub keeps it empty
   *  and relies on chat-topology hasUnansweredPing flag set by future hooks. */
  unansweredPings: new Map<string, string>(),
};

/** Run a single scout tick — read topology + sessions, run rule engine,
 *  write digest + enqueue escalations, then immediately dispatch any
 *  pending escalation items through the L3 playbook handlers. Safe to
 *  call from cron or on-demand. */
export async function runScoutTick(larkAppId?: string): Promise<{ digest: MainBotDigest; escalationsAdded: number; escalationsDispatched: number }> {
  const topo = readTopology();
  const inbox = readInbox();
  const now = Date.now();

  // 1. Summarise each chat into a one-line digest entry.
  const chats: MainBotDigestChat[] = topo.nodes.map(node => ({
    chatId: node.chatId,
    name: node.name,
    heat: heatFromLastMessage(node.metrics.lastMessageAt),
    oneLineStatus: node.summary || summariseFromMetrics(node),
    needsAttention: node.metrics.hasUnansweredPing,
  }));

  // 2. Run escalation rules. Each new escalation is enqueued to inbox.
  const rulesInput: RulesInput = {
    nodes: topo.nodes,
    inbox,
    now,
    unansweredPings: PER_DAEMON_STATE.unansweredPings,
  };
  const newEscalations = runEscalationRules(rulesInput);
  for (const esc of newEscalations) {
    enqueueEscalation(esc);
  }

  // 3. Compose + write fresh digest.
  const prevDigest = readDigest();
  const digest: MainBotDigest = {
    generatedAt: new Date().toISOString(),
    chats,
    crossChatThreads: prevDigest.crossChatThreads, // P5 cross-topic edges feed this; preserve until then
    pendingForJason: derivePendingForJason(topo.nodes),
    escalations: newEscalations,
  };
  writeDigest(digest);
  markFresh();

  // P5: refresh cross-topic same_topic edges (idempotent — addEdge dedups).
  let edgesAdded = 0;
  try {
    edgesAdded = inferSameTopicEdges();
  } catch (err) {
    logger.warn(`[scout-spawner] inferSameTopicEdges failed: ${err}`);
  }

  // P3: immediately dispatch any pending escalations through the L3
  // playbook (v0.1: in-process; LLM-spawn upgrade can replace this).
  let escalationsDispatched = 0;
  if (larkAppId) {
    try {
      escalationsDispatched = await dispatchPendingEscalations(larkAppId);
    } catch (err) {
      logger.error(`[scout-spawner] dispatch failed: ${err}`);
    }
  }

  logger.info(`[scout-spawner] tick complete: ${chats.length} chats, ${newEscalations.length} new escalations, ${escalationsDispatched} dispatched, ${edgesAdded} same_topic edges added`);
  return { digest, escalationsAdded: newEscalations.length, escalationsDispatched };
}

/** Build a fallback one-line summary when no LLM-generated summary exists
 *  yet. Rules-based — replaces with LLM output when 缇蕾 actually runs. */
function summariseFromMetrics(node: ChatNode): string {
  const heat = heatFromLastMessage(node.metrics.lastMessageAt);
  const m = node.metrics.messages24h;
  const tagPart = node.tags.length > 0 ? ` · ${node.tags.join('/')}` : '';
  if (heat === 'cold') return `(cold) 24h+ 无活动${tagPart}`;
  if (heat === 'warm') return `(warm) 24h ${m} 条消息${tagPart}`;
  return `(hot) 近 1h 活跃 · 24h ${m} 条${tagPart}`;
}

/** Lift the topology's `hasUnansweredPing` flags into PendingForJason
 *  records. We don't have access to message-level data here (that lives
 *  in the per-daemon session-store), so we surface chatId + a placeholder
 *  request; L3 克劳德 will fill in detail when handling. */
function derivePendingForJason(nodes: ChatNode[]) {
  return nodes
    .filter(n => n.metrics.hasUnansweredPing)
    .map(n => ({
      chatId: n.chatId,
      messageId: '',
      sender: '',
      request: `chat=${n.name} 有未回 ping (see chat 直接看)`,
      sinceMinutes: 0,
    }));
}
