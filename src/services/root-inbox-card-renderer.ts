/**
 * P2-rev1 #3 — RootInbox card renderer + send/update/close helpers.
 *
 * Shared by escalation-playbook sink, publisher (progress / request_decision),
 * and the three close paths (chat archive / scout auto-close / dashboard
 * manual close). Single source of truth for:
 *   - card JSON layout
 *   - send-first / update-on-subsequent / fallback-fresh-send pattern
 *   - close-with-card-graying
 *
 * Why one file: spec §2 mandates close 三路径 都 update Lark 卡，三 sink
 * 都用同一 send-or-update fallback chain — DRY avoids future drift.
 */
import { sendMessage, updateMessage } from '../im/lark/client.js';
import { getCompanyByRootChatId, getMainTopicChatId, getMainTopicBotRef } from './main-topic-config.js';
import * as rootInbox from './root-inbox-store.js';
import { logger } from '../utils/logger.js';

const KIND_EMOJI: Record<rootInbox.RootInboxKind, string> = {
  escalation: '🔔',
  progress: '✅',
  request_decision: '❓',
  tilly_digest: '🐶',
  tilly_alert: '🚨',
};

const KIND_LABEL: Record<rootInbox.RootInboxKind, string> = {
  escalation: '子群进展',
  progress: '子群阶段进展',
  request_decision: '需要松松决策',
  tilly_digest: '缇蕾每日扫读',
  tilly_alert: '缇蕾健康检查',
};

/** Render a RootInbox item as a Lark v2 interactive-card JSON string.
 *
 *  P3-rev1 #5 (妹妹): kind='tilly_digest' uses its own multi-section
 *  layout (no fake "查看子群" link, no generic ruleId badge). Caller
 *  passes the rendered markdown explicitly via `opts.customMarkdown` —
 *  store's `summary` field stays as a short label ("今日 N items"),
 *  not bloated with full card markdown.
 *
 *  For other kinds, `opts.customMarkdown` is ignored and the generic
 *  escalation layout (with subChat link, status emoji, rule badge, etc.)
 *  is rendered. */
export interface RenderOpts {
  /** For kind='tilly_digest' only: override the markdown body. Required
   *  for tilly_digest (otherwise an empty content body is emitted). */
  customMarkdown?: string;
}

export function renderRootInboxCard(
  item: rootInbox.RootInboxItem,
  opts: RenderOpts = {},
): string {
  if (item.kind === 'tilly_digest') {
    const md = opts.customMarkdown ?? `_(no content — caller forgot customMarkdown)_`;
    return JSON.stringify({
      schema: '2.0',
      config: { update_multi: true },
      body: {
        direction: 'vertical',
        elements: [{ tag: 'markdown', content: md }],
      },
    });
  }
  // P0-2 (2026-05-25): 缇蕾连续 fail alert — 红色显眼卡，跟 digest 卡区分
  // 开关：tilly tick 连续失败 >=3 触发；成功一次自动 close。
  if (item.kind === 'tilly_alert') {
    const closedBadge = item.status === 'closed' ? '（已恢复）' : '';
    const md = [
      `**${item.status === 'closed' ? '✅' : '🚨'} 缇蕾扫读连续失败${closedBadge}**`,
      ``,
      `${item.summary}`,
      ``,
      `首次失败 ${item.firstSeenAt.slice(11, 19)} UTC · 最新 ${item.lastUpdatedAt.slice(11, 19)} UTC · 累计 ${item.updateCount} 次`,
      ``,
      `_自动健康检查：定时任务恢复正常后此卡自动关闭_`,
    ].join('\n');
    return JSON.stringify({
      schema: '2.0',
      config: { update_multi: true },
      body: {
        direction: 'vertical',
        elements: [{ tag: 'markdown', content: md }],
      },
    });
  }
  let statusEmoji: string;
  if (item.status === 'closed') statusEmoji = '✅';
  else if (item.status === 'updated') statusEmoji = '🔁';
  else statusEmoji = KIND_EMOJI[item.kind] ?? '🔔';

  const ruleBadge = item.ruleId ? `[${item.ruleId}]` : `[${item.kind}]`;
  const subLink = `[查看子群](https://applink.feishu.cn/client/chat/open?openChatId=${item.subChatId})`;
  const updateBadge = item.updateCount > 1 ? `更新 ${item.updateCount} 次 · ` : '';
  const closedBadge = item.status === 'closed' ? '（已关闭）' : '';
  const content = [
    `**${statusEmoji} ${ruleBadge} ${KIND_LABEL[item.kind] ?? '通知'}${closedBadge}**`,
    `\n${item.summary}\n`,
    `${updateBadge}首发 ${item.firstSeenAt.slice(11, 19)} UTC · 最新 ${item.lastUpdatedAt.slice(11, 19)} UTC · ${subLink}`,
  ].join('\n');
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
    body: {
      direction: 'vertical',
      elements: [{ tag: 'markdown', content }],
    },
  });
}

/**
 * Send a fresh card OR update the existing one, depending on whether the
 * item already has a `rootCardMessageId`. On updateMessage failure
 * (e.g. card withdrawn) falls back to sending a fresh card and updates
 * `rootCardMessageId` to the new one.
 *
 * `opts.customMarkdown` is forwarded to `renderRootInboxCard` and only
 * affects kind='tilly_digest'.
 *
 * Returns the (possibly new) rootCardMessageId; null if Lark send failed
 * entirely (caller can decide to retry).
 */
export async function sendOrUpdateCard(
  larkAppId: string,
  mainTopicChatId: string,
  item: rootInbox.RootInboxItem,
  opts: RenderOpts = {},
): Promise<string | null> {
  const cardJson = renderRootInboxCard(item, opts);
  try {
    if (item.rootCardMessageId) {
      try {
        await updateMessage(larkAppId, item.rootCardMessageId, cardJson);
        return item.rootCardMessageId;
      } catch (err) {
        logger.warn(`[root-inbox-card-renderer] updateMessage failed (id=${item.id} msg=${item.rootCardMessageId}); falling back to fresh send: ${err}`);
        const msgId = await sendMessage(larkAppId, mainTopicChatId, cardJson, 'interactive');
        if (msgId) rootInbox.setRootCardMessageId(item.id, msgId);
        return msgId ?? null;
      }
    } else {
      const msgId = await sendMessage(larkAppId, mainTopicChatId, cardJson, 'interactive');
      if (msgId) rootInbox.setRootCardMessageId(item.id, msgId);
      return msgId ?? null;
    }
  } catch (err) {
    logger.warn(`[root-inbox-card-renderer] Lark send failed (id=${item.id}): ${err}`);
    return null;
  }
}

/**
 * Close the RootInbox item AND update its Lark main-topic card to show
 * the "closed" visual state (✅ emoji + "已关闭" badge).
 *
 * All three close paths (chat archive, scout auto-close, dashboard manual
 * close) call this so the main-topic card stays in sync with store state.
 *
 * Best-effort on Lark side — failure is logged, store state is still closed.
 *
 * `larkAppId` is the bot to send-as. Updating an existing card only needs
 * rootCardMessageId, so Company-only deployments do not require legacy
 * mainTopicChatId to be configured.
 */
export async function closeAndRenderClosed(id: string, larkAppId: string): Promise<void> {
  const closed = rootInbox.close(id);
  if (!closed) return;   // unknown id
  if (!closed.rootCardMessageId) return;   // never sent a card (sink failed earlier)
  try {
    const cardJson = renderRootInboxCard(closed);
    await updateMessage(larkAppId, closed.rootCardMessageId, cardJson);
  } catch (err) {
    logger.warn(`[root-inbox-card-renderer] close-card update failed for ${id}: ${err}`);
  }
}

/**
 * Bulk close + card update for all open items belonging to a sub-chat.
 * Used by chat-context-store.archive: 子群归档 = 所有挂它名下的 RootInbox
 * item 都 close + 主话题卡置灰。
 *
 * larkAppId resolved internally via bot-registry (Claude bot) so the
 * caller (chat-context-store) doesn't need to know about app ids.
 *
 * Best-effort all the way down — failures only log.
 */
export async function closeAllForSubChatWithCards(subChatId: string): Promise<number> {
  // First collect ids to close (without modifying store yet), then close
  // each via closeAndRenderClosed so card updates fire too.
  const open = rootInbox.listOpen().filter(it => it.subChatId === subChatId);
  if (open.length === 0) return 0;
  // Resolve the owning company CEO bot's app id for card update sender.
  let larkAppId: string | undefined;
  try {
    const { resolveBotIdent } = await import('../core/main-bot-playbook.js');
    const { getByChatId } = await import('./subtask-store.js');
    const task = getByChatId(subChatId);
    const company = getCompanyByRootChatId(task?.rootChatId ?? task?.parentChatId);
    larkAppId = company?.ceoLarkAppId ?? resolveBotIdent(getMainTopicBotRef(company?.rootChatId)).larkAppId;
  } catch (err) {
    logger.warn(`[root-inbox-card-renderer] closeAllForSubChatWithCards: can't resolve CEO appId, falling back to store-only close: ${err}`);
    // Fall back to store-only close
    return rootInbox.closeAllForSubChat(subChatId);
  }
  let count = 0;
  for (const item of open) {
    await closeAndRenderClosed(item.id, larkAppId);
    count++;
  }
  return count;
}
