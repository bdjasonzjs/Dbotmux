/**
 * Escalation 5 rules (R1-R5) — P2/10 main-bot mode rules engine.
 *
 * Pure function: takes a snapshot (nodes + inbox + now) and returns the
 * list of **new** escalations to enqueue. Already-enqueued items (matching
 * by `(ruleId, chatId)`) are skipped to avoid spamming the L3 handler.
 *
 * Each rule encodes the **objective signal** only — interpretation /
 * action lives in the L3 handler's playbook (see chat-created-handler
 * docs for the inverse decision tree). Per the [[dont-interrupt-bot-
 * discussion]] design philosophy, R4 leans toward "keep going" and the
 * threshold is intentionally generous (20 rounds).
 */
import type { ChatNode } from '../services/chat-topology-store.js';
import type { Escalation, ScoutInbox } from '../services/main-bot-digest-store.js';

export interface RulesInput {
  nodes: ChatNode[];
  inbox: ScoutInbox;
  /** Current time in milliseconds since epoch (injected for testability). */
  now: number;
  /** chatId → ISO timestamp of the earliest unanswered ping (kept across
   *  ticks so R1 can compute "> 30 min" correctly). */
  unansweredPings?: Map<string, string>;
}

const STUCK_KEYWORDS = ['error', 'blocked', 'stuck', '卡住', '解不开', '不会做'];

const THIRTY_MIN_MS = 30 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const TWENTY_FOUR_H_MS = 24 * 60 * 60 * 1000;
const BOT_ROUND_THRESHOLD = 20;

/** Run all 5 rules. Returns the list of new escalations (caller persists). */
export function runEscalationRules(input: RulesInput): Escalation[] {
  const out: Escalation[] = [];

  // Dedup helper: skip when an inbox item for (ruleId, chatId) is already pending.
  const isAlreadyPending = (ruleId: Escalation['ruleId'], chatId: string): boolean => {
    return input.inbox.pending.some(
      it => it.escalation.ruleId === ruleId && it.escalation.chatId === chatId,
    );
  };

  for (const node of input.nodes) {
    // R1: unanswered ping > 30 min
    const r1 = checkR1(node, input.now, input.unansweredPings);
    if (r1 && !isAlreadyPending('R1', node.chatId)) out.push(r1);

    // R3: new bot_spawned chat > 1h no activity
    const r3 = checkR3(node, input.now);
    if (r3 && !isAlreadyPending('R3', node.chatId)) out.push(r3);

    // R5: stuck keywords in node summary
    const r5 = checkR5(node);
    if (r5 && !isAlreadyPending('R5', node.chatId)) out.push(r5);
  }

  // R2: cross-chat same-topic with no convergence (24h)
  const r2 = checkR2(input.nodes, input.now);
  for (const esc of r2) {
    if (!isAlreadyPending('R2', esc.chatId)) out.push(esc);
  }

  // R4: bot-to-bot ping > 20 rounds. We don't have direct round-count
  // data in the topology layer (would need session-store), so this is a
  // stub — implementation lands when scout becomes LLM-driven and can
  // count rounds from message stream. Stubbed out to keep the rule
  // engine surface area complete.
  const r4 = checkR4Stub(input.nodes);
  for (const esc of r4) {
    if (!isAlreadyPending('R4', esc.chatId)) out.push(esc);
  }

  return out;
}

/** R1: a chat has an unanswered @松松 ping older than 30 minutes. */
function checkR1(node: ChatNode, now: number, unansweredPings?: Map<string, string>): Escalation | null {
  if (!node.metrics.hasUnansweredPing) return null;
  const since = unansweredPings?.get(node.chatId);
  if (!since) return null;
  const sinceMs = new Date(since).getTime();
  if (now - sinceMs < THIRTY_MIN_MS) return null;
  return {
    ruleId: 'R1',
    triggeredAt: new Date(now).toISOString(),
    chatId: node.chatId,
    context: `[R1] 松松未回 ping in 群 "${node.name}" 累计 ${Math.floor((now - sinceMs) / 60000)} 分钟`,
    payload: {
      chatId: node.chatId,
      sinceMinutes: Math.floor((now - sinceMs) / 60000),
    },
  };
}

/** R2: same theme/tag appears in >= 2 chats with no convergence for 24h. */
function checkR2(nodes: ChatNode[], now: number): Escalation[] {
  const byTag = new Map<string, ChatNode[]>();
  for (const node of nodes) {
    for (const tag of node.tags) {
      const list = byTag.get(tag) ?? [];
      list.push(node);
      byTag.set(tag, list);
    }
  }
  const out: Escalation[] = [];
  for (const [tag, chats] of byTag.entries()) {
    if (chats.length < 2) continue;
    // No convergence proxy: all chats are still "hot" or "warm" after 24h.
    const allRecent = chats.every(c => {
      const last = c.metrics.lastMessageAt ? new Date(c.metrics.lastMessageAt).getTime() : 0;
      return now - last < TWENTY_FOUR_H_MS;
    });
    if (!allRecent) continue;
    out.push({
      ruleId: 'R2',
      triggeredAt: new Date(now).toISOString(),
      chatId: chats[0].chatId, // anchor on the first chat
      context: `[R2] 同议题 "${tag}" 在 ${chats.length} 个群讨论 24h 无收敛`,
      payload: {
        theme: tag,
        chatIds: chats.map(c => c.chatId),
      },
    });
  }
  return out;
}

/** R3: bot_spawned chat created > 1h ago and still has zero activity. */
function checkR3(node: ChatNode, now: number): Escalation | null {
  if (node.originType !== 'bot_spawned') return null;
  if (node.metrics.messages24h > 0) return null;
  // We use lastMessageAt as a proxy for "created" since we don't track creation
  // time separately. If never seen, this rule doesn't fire (no anchor).
  // The card-context welcome message sent on bot_spawned creation sets
  // lastMessageAt, so this measures "card was sent, but no real activity since".
  if (!node.metrics.lastMessageAt) return null;
  const ageMs = now - new Date(node.metrics.lastMessageAt).getTime();
  if (ageMs < ONE_HOUR_MS) return null;
  return {
    ruleId: 'R3',
    triggeredAt: new Date(now).toISOString(),
    chatId: node.chatId,
    context: `[R3] bot_spawned 新群 "${node.name}" ${Math.floor(ageMs / 60000)} 分钟无人发言`,
    payload: { chatId: node.chatId, ageMinutes: Math.floor(ageMs / 60000) },
  };
}

/** R4: bot互ping > 20 轮无定论. Stub for v0.1 — needs message-stream
 *  access to count rounds. Returns [] until P2/9 缇蕾 LLM scout fills it. */
function checkR4Stub(_nodes: ChatNode[]): Escalation[] {
  return [];
}

/** R5: stuck keywords in summary or recent flag. */
function checkR5(node: ChatNode): Escalation | null {
  const text = (node.summary ?? '').toLowerCase();
  const hit = STUCK_KEYWORDS.find(kw => text.includes(kw.toLowerCase()));
  if (!hit) return null;
  return {
    ruleId: 'R5',
    triggeredAt: new Date().toISOString(),
    chatId: node.chatId,
    context: `[R5] 群 "${node.name}" summary 含 stuck 关键词 "${hit}"`,
    payload: { chatId: node.chatId, keyword: hit, summary: node.summary },
  };
}
