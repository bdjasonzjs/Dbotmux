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
  type ScoutEscalationItem, type EscalationRuleId,
} from '../services/main-bot-digest-store.js';
import { sendMessage } from '../im/lark/client.js';
import { getMainTopicChatId } from '../services/main-topic-config.js';
import * as rootInbox from '../services/root-inbox-store.js';
import { sendOrUpdateCard } from '../services/root-inbox-card-renderer.js';
import { logger } from '../utils/logger.js';

const HANDLER_SESSION_ID = `escalation-playbook-${process.pid}`;

type PlaybookHandler = (item: ScoutEscalationItem, larkAppId: string) => Promise<string>;

/** Dispatch every pending item once. Calls per-rule handlers, swallows
 *  per-item exceptions, marks each as resolved (with success or error
 *  resolution). Returns the count of items processed (regardless of
 *  per-item outcome). */
export async function dispatchPendingEscalations(larkAppId: string): Promise<number> {
  const inbox = readInbox();
  let processed = 0;

  // 2026-05-25 Phase A v2 妹妹 guard #1: ScoutInbox 改 discriminated union
  // 后入口层显式过滤 type==='escalation'，不靠 loop body 'continue'。这样
  // markInProgress / markResolved 只可能被 escalation item 调用，永远不会
  // 误碰 tilly_digest_high item。
  for (const item of inbox.pending) {
    if (item.type !== 'escalation') continue;
    if (item.status !== 'pending') continue;
    const claimed = markInProgress(item.id);
    if (!claimed || claimed.type !== 'escalation') continue;  // type guard + race

    let resolution: string;
    try {
      // P2 commit #2: handler runs sub-chat reminder, then RootInbox sink
      // fires (best-effort, never blocks).
      resolution = await runHandlerWithRootSink(claimed, larkAppId);
    } catch (err) {
      logger.error(`[escalation-playbook] R${claimed.escalation.ruleId} handler threw: ${err}`);
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

// ─── P2 commit #2: RootInbox sink ─────────────────────────────────────────

/** Push an escalation to the RootInbox + render/update the main-topic card.
 *
 *  On first push for a given (ruleId, subChatId): insert RootInboxItem,
 *  send a fresh interactive card to mainTopic, store messageId.
 *  On subsequent pushes (same id, still 'open'): update RootInboxItem
 *  (lastUpdatedAt + updateCount++), call Lark `updateMessage` on the
 *  stored rootCardMessageId to edit the SAME card (no reply, no new msg
 *  → won't spam mainTopic).
 *
 *  All sends are best-effort: failure to talk to Lark is logged but does
 *  not throw — escalation processing continues. */
async function pushEscalationToRootInbox(
  item: ScoutEscalationItem,
  larkAppId: string,
  oneLineSummary: string,
): Promise<void> {
  const mainTopic = getMainTopicChatId();
  if (!mainTopic) {
    logger.debug('[escalation-playbook] mainTopicChatId not configured — skipping RootInbox sink');
    return;
  }
  const ruleId = item.escalation.ruleId;
  const subChatId = item.escalation.chatId;
  const subChatName = subChatId;
  const id = rootInbox.buildId({ kind: 'escalation', ruleId, subChatId });
  // P2-rev1 #2: allowReopen=true — closed escalation can reopen with new
  // generation (new card lifecycle) on next firing. Avoids the "closed
  // R5:chat永久静默" bug妹妹 review #2.
  const { item: row } = rootInbox.upsertOpen({
    id,
    kind: 'escalation',
    subChatId,
    subChatName,
    ruleId,
    summary: oneLineSummary,
    allowReopen: true,
  });
  await sendOrUpdateCard(larkAppId, mainTopic, row);
}

/** Wrap PLAYBOOK lookup to fan out: original handler runs (sub-chat
 *  reminder) THEN root-inbox sink fires (with the handler's resolution
 *  string used as the 1-line summary). */
async function runHandlerWithRootSink(
  item: ScoutEscalationItem,
  larkAppId: string,
): Promise<string> {
  const handler = PLAYBOOK[item.escalation.ruleId];
  if (!handler) return `[${item.escalation.ruleId}] no playbook handler — item logged only`;
  const resolution = await handler(item, larkAppId);
  // Best-effort RootInbox sink (after handler succeeds — never block on it).
  await pushEscalationToRootInbox(item, larkAppId, item.escalation.context || resolution);
  return resolution;
}
