/**
 * 双层汇报 v6 · CEO 收件箱 store (2026-06-15)。
 *
 * 经理常规 digest 不实时 push，而是作为「汇报邮件」投进收件人(直接父群 orchestrator)的收件箱；
 * 收件人每 N 小时批量收取。本 store = 收件箱信封层（可列出 / per-reader 已读 / 鉴权）；
 * 邮件**正文**走 mailbox letter（见 mailbox.ts），inbox 项引 letterId。
 *
 * 设计要点（蔻黛 v5 架构 review B2 + minors）：
 *  - 寻址：recipientChatId = 经理任务的直接父群(嵌套逐级不跨级)；recipientBotOpenId = 该父群 orchestrator
 *    (顶层=根 CEO 克劳德；嵌套=父 manager bot)。读权限按 recipientBotOpenId 对齐 parent orchestrator 鉴权。
 *  - 已读：readBy per-reader (recipientBotOpenId → readAt)，多 reader 各自已读不互相覆盖、不丢报。
 *  - 溯源：parentTaskId/rootTaskId/depth + sourceObservationIds + requestCommandId 便于排查/履约闭环。
 *  - 幂等：同 idempotencyKey 不重复落（与 mailbox letter 的 key 对齐，重跑不产多封）。
 *
 * 持久化 ~/.botmux/data/ceo-inbox.json，原子写 + file-lock（仿 subtask-store，跨进程安全）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { withFileLock } from '../utils/file-lock.js';

export type ReportKind = 'scheduled' | 'manual' | 'requested' | 'urgent';

export interface InboxEntry {
  id: string;
  // —— 投递寻址（嵌套逐级）——
  recipientChatId: string;
  recipientBotOpenId: string;
  // —— 溯源 ——
  fromTaskId: string;
  fromChatId: string;
  fromLabel: string;
  parentTaskId: string | null;
  rootTaskId: string | null;
  depth: number;
  // —— 内容 ——
  kind: 'digest';
  reportKind: ReportKind;
  summary: string;
  letterId: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  sourceObservationIds: string[];
  requestCommandId: string | null;
  urgency: 'normal' | 'urgent';
  urgentReason: string | null;
  idempotencyKey: string;
  createdAt: string;
  /** per-reader 已读：recipientBotOpenId → readAt ISO。 */
  readBy: Record<string, string>;
}

interface StoreFile { entries: InboxEntry[]; }

function fp(): string { return join(config.session.dataDir, 'ceo-inbox.json'); }
function ensureDir(): void { const d = dirname(fp()); if (!existsSync(d)) mkdirSync(d, { recursive: true }); }

function read(): StoreFile {
  if (!existsSync(fp())) return { entries: [] };
  try {
    const s = JSON.parse(readFileSync(fp(), 'utf-8')) as Partial<StoreFile>;
    return { entries: s.entries ?? [] };
  } catch (err) {
    // corrupt 绝不当空库覆盖（仿 subtask-store）：备份留证 + 抛，让上层 skip 本轮。
    const backup = `${fp()}.corrupt-${Date.now()}`;
    try { writeFileSync(backup, readFileSync(fp(), 'utf-8'), 'utf-8'); } catch { /* best effort */ }
    logger.error(`[ceo-inbox] parse failed: ${err}; backed up to ${backup}`);
    throw new Error(`ceo-inbox corrupt (backed up to ${backup})`);
  }
}

function write(s: StoreFile): void {
  ensureDir();
  const tmp = `${fp()}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf-8');
  renameSync(tmp, fp());
}

async function mutate<T>(fn: (s: StoreFile) => { result: T; dirty: boolean }): Promise<T> {
  ensureDir();
  return withFileLock(fp(), async () => {
    const s = read();
    const { result, dirty } = fn(s);
    if (dirty) write(s);
    return result;
  });
}

export interface EnqueueEntryOpts {
  recipientChatId: string;
  recipientBotOpenId: string;
  fromTaskId: string;
  fromChatId: string;
  fromLabel: string;
  parentTaskId?: string | null;
  rootTaskId?: string | null;
  depth?: number;
  reportKind: ReportKind;
  summary: string;
  letterId?: string | null;
  windowStart?: string | null;
  windowEnd?: string | null;
  sourceObservationIds?: string[];
  requestCommandId?: string | null;
  urgency?: 'normal' | 'urgent';
  urgentReason?: string | null;
  idempotencyKey: string;
}

/** 投一封汇报邮件进收件箱。幂等：同 idempotencyKey 已存在 → 返既有、不重复落。 */
export async function enqueueEntry(opts: EnqueueEntryOpts): Promise<{ entry: InboxEntry; inserted: boolean }> {
  return mutate<{ entry: InboxEntry; inserted: boolean }>(s => {
    const dup = s.entries.find(e => e.idempotencyKey === opts.idempotencyKey);
    if (dup) return { result: { entry: dup, inserted: false }, dirty: false };
    const entry: InboxEntry = {
      id: `inbox_${randomUUID()}`,
      recipientChatId: opts.recipientChatId,
      recipientBotOpenId: opts.recipientBotOpenId,
      fromTaskId: opts.fromTaskId,
      fromChatId: opts.fromChatId,
      fromLabel: opts.fromLabel,
      parentTaskId: opts.parentTaskId ?? null,
      rootTaskId: opts.rootTaskId ?? null,
      depth: opts.depth ?? 1,
      kind: 'digest',
      reportKind: opts.reportKind,
      summary: opts.summary,
      letterId: opts.letterId ?? null,
      windowStart: opts.windowStart ?? null,
      windowEnd: opts.windowEnd ?? null,
      sourceObservationIds: opts.sourceObservationIds ?? [],
      requestCommandId: opts.requestCommandId ?? null,
      urgency: opts.urgency ?? 'normal',
      urgentReason: opts.urgentReason ?? null,
      idempotencyKey: opts.idempotencyKey,
      createdAt: new Date().toISOString(),
      readBy: {},
    };
    s.entries.push(entry);
    logger.info(`[ceo-inbox] enqueued ${entry.id} from=${opts.fromTaskId.slice(0, 12)} → recipient=${opts.recipientChatId.slice(0, 12)} kind=${opts.reportKind} urgency=${entry.urgency}`);
    return { result: { entry, inserted: true }, dirty: true };
  });
}

export function getEntry(id: string): InboxEntry | null {
  return read().entries.find(e => e.id === id) ?? null;
}

/**
 * 列某收件人收件箱。**鉴权由调用方(service)保证**：readerBotOpenId 必须 = 该 recipientChatId 的
 * parent orchestrator（service 层用 authzParentBot 校验后才调本函数）。这里只按 recipient 维度过滤 +
 * 按 reader 算未读。
 *  - unreadOnly：只返回 readBy[readerBotOpenId] 未设的（该 reader 没读过的）。
 */
export function listInbox(
  recipientChatId: string,
  readerBotOpenId: string,
  opts: { unreadOnly?: boolean; since?: string; limit?: number } = {},
): InboxEntry[] {
  // 蔻黛 B1：reader 鉴权按 recipientChatId **且** recipientBotOpenId 双收窄 —— 同一父群多 bot 时，
  // 只能看投给"自己(reader)作为该群 orchestrator"的邮件，看不到投给别的 orchestrator 的。
  let entries = read().entries.filter(e => e.recipientChatId === recipientChatId && e.recipientBotOpenId === readerBotOpenId);
  if (opts.unreadOnly) entries = entries.filter(e => !e.readBy[readerBotOpenId]);
  if (opts.since) {
    const sinceMs = new Date(opts.since).getTime();
    if (Number.isFinite(sinceMs)) entries = entries.filter(e => new Date(e.createdAt).getTime() >= sinceMs);
  }
  entries = entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return opts.limit != null ? entries.slice(-opts.limit) : entries;
}

/** 标某 reader 已读（per-reader，不覆盖别的 reader）。返回实际标记的条数。
 *  蔻黛 B1：必须同时匹配 recipientChatId + recipientBotOpenId，杜绝"只凭 id 给别的收件箱写 readBy"。 */
export async function markRead(recipientChatId: string, readerBotOpenId: string, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  return mutate(s => {
    const now = new Date().toISOString();
    let n = 0;
    const idset = new Set(ids);
    for (const e of s.entries) {
      if (idset.has(e.id)
        && e.recipientChatId === recipientChatId && e.recipientBotOpenId === readerBotOpenId
        && !e.readBy[readerBotOpenId]) {
        e.readBy[readerBotOpenId] = now; n += 1;
      }
    }
    return { result: n, dirty: n > 0 };
  });
}

/** 清理：删掉早于 ttlDays 的已被对应 reader 读过的项（避免无限增长）。返回删除数。 */
export async function pruneRead(now: Date = new Date(), ttlDays = 14): Promise<number> {
  const TTL = ttlDays * 24 * 60 * 60 * 1000;
  return mutate(s => {
    const before = s.entries.length;
    s.entries = s.entries.filter(e => {
      const old = now.getTime() - new Date(e.createdAt).getTime() > TTL;
      const readByRecipient = !!e.readBy[e.recipientBotOpenId];
      return !(old && readByRecipient);
    });
    const removed = before - s.entries.length;
    if (removed > 0) logger.info(`[ceo-inbox] pruned ${removed} old read entries`);
    return { result: removed, dirty: removed > 0 };
  });
}

/** 测试用。 */
export function __resetForTesting(): void { write({ entries: [] }); }
