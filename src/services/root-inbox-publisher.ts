/**
 * P2 commit #5 — RootInbox publisher：把 progress / request_decision 项
 * 写入 RootInbox + 渲染主话题卡。
 *
 * 设计：复用与 escalation sink 相同的 send-or-update 语义（首发 send，
 * 同 id 再触发 update 同卡），但不耦合 escalation-playbook。CLI
 * `botmux progress-report` 通过 daemon IPC route 调入此 publisher。
 *
 * 与 escalation sink 的关系：
 *   - escalation-playbook.pushEscalationToRootInbox 写 kind='escalation'
 *   - publishProgress 写 kind='progress'（dedup by subChatId+slug）
 *   - publishRequestDecision 写 kind='request_decision'
 *   - 三个通道共享 RootInbox store，dedup 互不冲突（id 前缀不同）
 *
 * 卡片格式独立 — progress 用 ✅ emoji，request_decision 用 ❓。
 */
import { sendMessage, updateMessage } from '../im/lark/client.js';
import { getMainTopicChatId } from './main-topic-config.js';
import * as rootInbox from './root-inbox-store.js';
import { logger } from '../utils/logger.js';

export interface PublishOpts {
  /** Caller's session id (for audit + future authz; not stored). */
  callerSessionId?: string;
  /** Sub-chat the report is about. Required. */
  subChatId: string;
  /** Human label cached on the card. */
  subChatName?: string;
  /** Stable slug for dedup. Same slug + same subChatId = update existing
   *  card (don't spam mainTopic with duplicate progress reports). */
  slug: string;
  /** One-line current state shown on the card. */
  summary: string;
  /** larkAppId of the bot publishing — used to send/update the Lark card.
   *  Required (caller has it from authzCheck). */
  larkAppId: string;
}

export interface PublishResult {
  /** Whether mainTopic was configured (false = silent no-op, success=true still). */
  mainTopicConfigured: boolean;
  /** Root inbox item id (deterministic). */
  itemId: string;
  /** First push for this id (true) or update (false). */
  inserted: boolean;
  /** rootCardMessageId in mainTopic (null if no mainTopic configured). */
  rootCardMessageId: string | null;
}

/** Publish a progress report to RootInbox + mainTopic. */
export async function publishProgress(opts: PublishOpts): Promise<PublishResult> {
  return publishGeneric('progress', opts, '✅', '子群阶段进展');
}

/** Publish a request-decision card to RootInbox + mainTopic. */
export async function publishRequestDecision(opts: PublishOpts): Promise<PublishResult> {
  return publishGeneric('request_decision', opts, '❓', '需要松松决策');
}

async function publishGeneric(
  kind: 'progress' | 'request_decision',
  opts: PublishOpts,
  emoji: string,
  label: string,
): Promise<PublishResult> {
  const id = rootInbox.buildId({ kind, subChatId: opts.subChatId, slug: opts.slug });
  const subChatName = opts.subChatName ?? opts.subChatId;
  const { item, inserted } = rootInbox.upsertOpen({
    id,
    kind,
    subChatId: opts.subChatId,
    subChatName,
    summary: opts.summary,
  });

  const mainTopic = getMainTopicChatId();
  if (!mainTopic) {
    logger.debug('[root-inbox-publisher] mainTopic not configured — RootInbox written but card not sent');
    return { mainTopicConfigured: false, itemId: id, inserted, rootCardMessageId: item.rootCardMessageId };
  }

  const cardJson = buildCard(item, emoji, label);
  let messageId = item.rootCardMessageId;
  try {
    if (inserted || !messageId) {
      messageId = await sendMessage(opts.larkAppId, mainTopic, cardJson, 'interactive');
      if (messageId) rootInbox.setRootCardMessageId(id, messageId);
    } else {
      try {
        await updateMessage(opts.larkAppId, messageId, cardJson);
      } catch (err) {
        logger.warn(`[root-inbox-publisher] updateMessage failed (id=${id}); sending fresh card: ${err}`);
        messageId = await sendMessage(opts.larkAppId, mainTopic, cardJson, 'interactive');
        if (messageId) rootInbox.setRootCardMessageId(id, messageId);
      }
    }
  } catch (err) {
    logger.warn(`[root-inbox-publisher] Lark send failed (id=${id}): ${err}`);
  }
  return { mainTopicConfigured: true, itemId: id, inserted, rootCardMessageId: messageId };
}

function buildCard(item: rootInbox.RootInboxItem, emoji: string, label: string): string {
  const statusEmoji = item.status === 'closed' ? '✅' : item.status === 'updated' ? '🔁' : emoji;
  const subLink = `[查看子群](https://applink.feishu.cn/client/chat/open?openChatId=${item.subChatId})`;
  const updateBadge = item.updateCount > 1 ? `更新 ${item.updateCount} 次 · ` : '';
  const content = [
    `**${statusEmoji} ${label}**`,
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
