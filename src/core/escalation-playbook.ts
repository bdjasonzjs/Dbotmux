/**
 * Escalation playbook — P3 L3 克劳德 consume escalation, v0.1.
 *
 * Each rule (R1-R5) has a dedicated handler that runs **in-process** when
 * the scout tick enqueues a matching item. Real implementations would
 * fork a 克劳德 worker via worker-pool — v0.1 keeps everything in-process
 * because (a) the actions are small (mostly sendMessage) and (b) avoids
 * the codex/claude-code spawn dependency until P5 LLM upgrade.
 *
 * The handler signature is unified: `(item, larkAppId) => Promise<string>`
 * returning a one-line resolution summary that gets stored in the
 * ScoutInbox processed list.
 *
 * Failure semantics: each handler may throw — dispatchPendingEscalations
 * catches per-item, marks resolved with `"error: ..."` resolution, and
 * moves on. We never block other items on one handler failure.
 */
import {
  readInbox, markInProgress, markResolved,
  type ScoutInboxItem, type EscalationRuleId,
} from '../services/main-bot-digest-store.js';
import { sendMessage } from '../im/lark/client.js';
import { logger } from '../utils/logger.js';

const HANDLER_SESSION_ID = `escalation-playbook-${process.pid}`;

type PlaybookHandler = (item: ScoutInboxItem, larkAppId: string) => Promise<string>;

/** Dispatch every pending item once. Calls per-rule handlers, swallows
 *  per-item exceptions, marks each as resolved (with success or error
 *  resolution). Returns the count of items processed (regardless of
 *  per-item outcome). */
export async function dispatchPendingEscalations(larkAppId: string): Promise<number> {
  const inbox = readInbox();
  let processed = 0;

  for (const item of inbox.pending) {
    if (item.status !== 'pending') continue;
    const claimed = markInProgress(item.id);
    if (!claimed) continue;  // race lost — another dispatcher claimed it

    const handler = PLAYBOOK[item.escalation.ruleId];
    let resolution: string;
    try {
      resolution = handler
        ? await handler(claimed, larkAppId)
        : `[${item.escalation.ruleId}] no playbook handler — item logged only`;
    } catch (err) {
      logger.error(`[escalation-playbook] R${item.escalation.ruleId} handler threw: ${err}`);
      resolution = `error: ${String(err).slice(0, 200)}`;
    }
    markResolved(claimed.id, HANDLER_SESSION_ID, resolution);
    processed++;
  }

  return processed;
}

// ─── Per-rule handlers ────────────────────────────────────────────────────

const handleR1: PlaybookHandler = async (item, larkAppId) => {
  // R1 = 你未回 ping > 30 min. Action: send a polite ping to the chat
  // (better than a private DM that may bury under other notifications
  // until the dashboard pendingForJason surfaces it).
  const sinceMinutes = (item.escalation.payload as any)?.sinceMinutes ?? '??';
  await sendMessage(
    larkAppId,
    item.escalation.chatId,
    `🔔 main-bot 提醒：你有未回的 ping 在这个群里已经 ${sinceMinutes} 分钟了`,
    'text',
  );
  return `R1 reminder sent to ${item.escalation.chatId} (${sinceMinutes}m)`;
};

const handleR2: PlaybookHandler = async (item, larkAppId) => {
  // R2 = same theme in ≥ 2 chats no convergence. Action: post a
  // cross-reference note to the anchor chat suggesting consolidation.
  const payload = item.escalation.payload as { theme?: string; chatIds?: string[] };
  const otherChats = (payload.chatIds ?? []).filter(c => c !== item.escalation.chatId);
  await sendMessage(
    larkAppId,
    item.escalation.chatId,
    `🔔 main-bot 观察：议题 "${payload.theme}" 在其他群也讨论中（${otherChats.length} 个），24h 未收敛 — 要不要合群 / 同步信息？`,
    'text',
  );
  return `R2 cross-ref posted to ${item.escalation.chatId} (theme=${payload.theme})`;
};

const handleR3: PlaybookHandler = async (item, larkAppId) => {
  // R3 = new bot_spawned chat with no activity > 1h. Action: post a
  // gentle "still here, ready to help" prompt to nudge the conversation
  // forward (so the chat doesn't die after the context card).
  const ageMinutes = (item.escalation.payload as any)?.ageMinutes ?? '??';
  await sendMessage(
    larkAppId,
    item.escalation.chatId,
    `🔔 main-bot 观察：这群建好 ${ageMinutes} 分钟还没动静 — 需要我做什么吗？`,
    'text',
  );
  return `R3 nudge sent to ${item.escalation.chatId} (age=${ageMinutes}m)`;
};

const handleR4: PlaybookHandler = async (item, larkAppId) => {
  // R4 = bot 互 ping > 20 轮. Per design philosophy, we LEAN toward
  // keep-going — only soft notify, don't break the conversation. v0.1
  // doesn't fire R4 (stubbed in rules engine) so this is a placeholder.
  await sendMessage(
    larkAppId,
    item.escalation.chatId,
    `🔔 main-bot 软提示：bot 之间讨论已超过 20 轮 — 不打断，仅记录，可以考虑收敛但不强制`,
    'text',
  );
  return `R4 soft notice posted to ${item.escalation.chatId}`;
};

const handleR5: PlaybookHandler = async (item, larkAppId) => {
  // R5 = stuck keyword in summary. Action: post a "blocker detected"
  // probe so whoever's stuck knows main-bot noticed.
  const keyword = (item.escalation.payload as any)?.keyword ?? '??';
  await sendMessage(
    larkAppId,
    item.escalation.chatId,
    `🔔 main-bot 观察：群里出现 "${keyword}" 信号 — 有 blocker 吗？需要帮忙看看？`,
    'text',
  );
  return `R5 blocker probe sent to ${item.escalation.chatId} (kw=${keyword})`;
};

const PLAYBOOK: Record<EscalationRuleId, PlaybookHandler> = {
  R1: handleR1,
  R2: handleR2,
  R3: handleR3,
  R4: handleR4,
  R5: handleR5,
};
