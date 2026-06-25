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
import { getCompanyByRootChatId, getMainTopicChatId } from './main-topic-config.js';
import * as rootInbox from './root-inbox-store.js';
import { sendOrUpdateCard } from './root-inbox-card-renderer.js';
import { logger } from './../utils/logger.js';
import { getByChatId, type SubTask } from './subtask-store.js';

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

export interface PublishManagerAlertOpts {
  task: SubTask;
  summary: string;
  larkAppId: string;
}

/** Publish a progress report to RootInbox + mainTopic. */
export async function publishProgress(opts: PublishOpts): Promise<PublishResult> {
  return publishGeneric('progress', opts);
}

/** Publish a request-decision card to RootInbox + mainTopic. */
export async function publishRequestDecision(opts: PublishOpts): Promise<PublishResult> {
  return publishGeneric('request_decision', opts);
}

export async function publishManagerStalled(opts: PublishManagerAlertOpts): Promise<PublishResult> {
  return publishManagerAlert('manager_stalled', opts);
}

export async function publishManagerSessionAged(opts: PublishManagerAlertOpts): Promise<PublishResult> {
  return publishManagerAlert('manager_session_aged', opts);
}

async function publishManagerAlert(
  kind: 'manager_stalled' | 'manager_session_aged',
  opts: PublishManagerAlertOpts,
): Promise<PublishResult> {
  const id = rootInbox.buildId({ kind, taskId: opts.task.taskId });
  const existing = rootInbox.lookupOpenByBaseId(id);
  if (existing) {
    const dest = resolveRootDestination(opts.task, opts.larkAppId);
    if (shouldRetryExistingManagerAlert(existing, dest)) {
      const messageId = await sendOrUpdateCard(dest.larkAppId, dest.chatId, existing);
      return {
        mainTopicConfigured: true,
        itemId: existing.id,
        inserted: false,
        rootCardMessageId: messageId,
      };
    }
    return {
      mainTopicConfigured: !!dest,
      itemId: existing.id,
      inserted: false,
      rootCardMessageId: existing.rootCardMessageId,
    };
  }
  const { item, inserted } = rootInbox.upsertOpen({
    id,
    kind,
    subChatId: opts.task.chatId,
    subChatName: opts.task.goal || opts.task.chatId,
    summary: opts.summary,
    allowReopen: true,
  });

  const dest = resolveRootDestination(opts.task, opts.larkAppId);
  if (!dest) {
    logger.debug('[root-inbox-publisher] mainTopic not configured — manager alert written but card not sent');
    return { mainTopicConfigured: false, itemId: item.id, inserted, rootCardMessageId: item.rootCardMessageId };
  }
  const messageId = await sendOrUpdateCard(dest.larkAppId, dest.chatId, item);
  return { mainTopicConfigured: true, itemId: item.id, inserted, rootCardMessageId: messageId };
}

function resolveRootDestination(task: Pick<SubTask, 'rootChatId' | 'parentChatId'>, fallbackLarkAppId: string): { chatId: string; larkAppId: string } | null {
  const company = getCompanyByRootChatId(task.rootChatId ?? task.parentChatId);
  const mainTopic = company?.rootChatId ?? getMainTopicChatId();
  if (!mainTopic) return null;
  return { chatId: mainTopic, larkAppId: company?.ceoLarkAppId ?? fallbackLarkAppId };
}

function shouldRetryExistingManagerAlert(
  item: rootInbox.RootInboxItem,
  dest: { chatId: string; larkAppId: string } | null,
): dest is { chatId: string; larkAppId: string } {
  return dest != null && item.rootCardMessageId == null;
}

async function publishGeneric(
  kind: 'progress' | 'request_decision',
  opts: PublishOpts,
): Promise<PublishResult> {
  const id = rootInbox.buildId({ kind, subChatId: opts.subChatId, slug: opts.slug });
  const subChatName = opts.subChatName ?? opts.subChatId;
  // Progress / request_decision uses explicit slug for dedup — caller
  // changes slug to start a new card, so allowReopen stays false (no
  // generation suffix needed).
  const { item, inserted } = rootInbox.upsertOpen({
    id,
    kind,
    subChatId: opts.subChatId,
    subChatName,
    summary: opts.summary,
  });

  const task = getByChatId(opts.subChatId);
  const company = getCompanyByRootChatId(task?.rootChatId ?? task?.parentChatId);
  const mainTopic = company?.rootChatId ?? getMainTopicChatId();
  if (!mainTopic) {
    logger.debug('[root-inbox-publisher] mainTopic not configured — RootInbox written but card not sent');
    return { mainTopicConfigured: false, itemId: item.id, inserted, rootCardMessageId: item.rootCardMessageId };
  }

  const senderAppId = company?.ceoLarkAppId ?? opts.larkAppId;
  const messageId = await sendOrUpdateCard(senderAppId, mainTopic, item);
  return { mainTopicConfigured: true, itemId: item.id, inserted, rootCardMessageId: messageId };
}
