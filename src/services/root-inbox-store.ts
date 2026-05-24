/**
 * P2 commit #1 — RootInbox 数据模型 + store (types only, no body yet).
 *
 * RootInbox = 子群进展 / escalation / 求助 → 主话题卡片汇总通道（去重
 * 更新关闭）。escalation-playbook 写入此 store；commit #3 接 sink；
 * commit #4 接 close 语义。
 *
 * 设计（design v0.3 §2 P2）:
 *   - 持久化文件：~/.botmux/data/root-inbox.json
 *   - dedup key: `${ruleId}:${chatId}` for escalation
 *                `progress:${chatId}:${slug}` for progress reports
 *                `request_decision:${chatId}:${slug}` for asks
 *   - 同 key 同 status 'open' → update existing item (lastUpdatedAt + updateCount++)
 *   - 关闭语义: open → closed (不能再 update)，由 commit #4 触发
 *   - rootCardMessageId 记 Lark 主话题渲染出的卡片 messageId；
 *     update 时调 Lark `updateMessage(rootCardMessageId, ...)` 改原卡
 *     (不是 reply，spec v0.3 §2 + 妹妹 review v0.3 #2 决定)
 *
 * 测试：test/root-inbox-store.test.ts
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const STORE_FILE = 'root-inbox.json';

/** Escalation rule id — must match `EscalationRuleId` in main-bot-digest-store. */
export type EscalationRuleId = 'R1' | 'R2' | 'R3' | 'R4' | 'R5';

export type RootInboxKind = 'escalation' | 'progress' | 'request_decision';
export type RootInboxStatus = 'open' | 'updated' | 'closed';

export interface RootInboxItem {
  /** Deterministic dedup key. Composition depends on kind:
   *  - kind=escalation:        `${ruleId}:${subChatId}`
   *  - kind=progress:          `progress:${subChatId}:${slug}`
   *  - kind=request_decision:  `request_decision:${subChatId}:${slug}` */
  id: string;
  kind: RootInboxKind;
  subChatId: string;
  /** Human label for the sub-chat (rendered in the card; cached so
   *  the card stays stable even if chat name changes). */
  subChatName: string;
  /** For kind=escalation only. */
  ruleId?: EscalationRuleId;
  /** Current lifecycle status:
   *  - open: first seen, awaiting attention
   *  - updated: same key fired again before close (updateCount++)
   *  - closed: archived / scout confirmed resolved / manual close.
   *    A closed item is **never** re-opened (a new firing with same id
   *    creates a new item — caller's responsibility to vary the slug). */
  status: RootInboxStatus;
  firstSeenAt: string;
  lastUpdatedAt: string;
  /** Number of times this item was touched (insert counts as 1). */
  updateCount: number;
  /** One-line current state shown on the card. */
  summary: string;
  /** Lark messageId of the rendered card in mainTopicChatId; set by
   *  the playbook AFTER first send. Subsequent updates use Lark
   *  `updateMessage` to edit the SAME card (no reply, no new message). */
  rootCardMessageId: string | null;
}

interface StoreFile {
  items: RootInboxItem[];
}

function filePath(): string {
  return join(config.session.dataDir, STORE_FILE);
}

function ensureDir(): void {
  const dir = dirname(filePath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function read(): StoreFile {
  const fp = filePath();
  if (!existsSync(fp)) return { items: [] };
  try {
    return JSON.parse(readFileSync(fp, 'utf-8')) as StoreFile;
  } catch (err) {
    logger.warn(`[root-inbox-store] failed to parse ${fp}: ${err}`);
    return { items: [] };
  }
}

function write(store: StoreFile): void {
  ensureDir();
  const fp = filePath();
  const tmp = fp + '.tmp';
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  renameSync(tmp, fp);
}

/** All items, newest first by lastUpdatedAt. */
export function listAll(): RootInboxItem[] {
  return [...read().items].sort((a, b) =>
    new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime(),
  );
}

/** Open items only (= status !== 'closed'). */
export function listOpen(): RootInboxItem[] {
  return listAll().filter(it => it.status !== 'closed');
}

/** Lookup by deterministic id. Returns the (latest) item with this id, or null. */
export function lookup(id: string): RootInboxItem | null {
  return read().items.find(it => it.id === id) ?? null;
}

/** Build a dedup id from kind + relevant fields. Helper for callers. */
export function buildId(opts:
  | { kind: 'escalation'; ruleId: EscalationRuleId; subChatId: string }
  | { kind: 'progress' | 'request_decision'; subChatId: string; slug: string },
): string {
  if (opts.kind === 'escalation') return `${opts.ruleId}:${opts.subChatId}`;
  return `${opts.kind}:${opts.subChatId}:${opts.slug}`;
}

/**
 * Insert a new open item, or update an existing open item with the same id.
 * Returns the (possibly updated) item + whether it was newly inserted.
 *
 * Update semantics:
 *   - if existing.status === 'closed': **do nothing**, return existing
 *     (closed items are terminal — caller must use a different slug to
 *      get a fresh card; intentional to avoid resurrecting old issues)
 *   - else: bump lastUpdatedAt + updateCount, replace summary; keep
 *     firstSeenAt + rootCardMessageId; flip status open → updated
 */
export function upsertOpen(opts: {
  id: string;
  kind: RootInboxKind;
  subChatId: string;
  subChatName: string;
  ruleId?: EscalationRuleId;
  summary: string;
}): { item: RootInboxItem; inserted: boolean } {
  const store = read();
  const idx = store.items.findIndex(it => it.id === opts.id);
  const now = new Date().toISOString();
  if (idx >= 0) {
    const existing = store.items[idx];
    if (existing.status === 'closed') return { item: existing, inserted: false };
    const updated: RootInboxItem = {
      ...existing,
      status: 'updated',
      lastUpdatedAt: now,
      updateCount: existing.updateCount + 1,
      summary: opts.summary,
      // Keep the same card target so update edits the original.
      subChatName: opts.subChatName,
    };
    store.items[idx] = updated;
    write(store);
    return { item: updated, inserted: false };
  }
  const item: RootInboxItem = {
    id: opts.id,
    kind: opts.kind,
    subChatId: opts.subChatId,
    subChatName: opts.subChatName,
    ruleId: opts.ruleId,
    status: 'open',
    firstSeenAt: now,
    lastUpdatedAt: now,
    updateCount: 1,
    summary: opts.summary,
    rootCardMessageId: null,
  };
  store.items.push(item);
  write(store);
  return { item, inserted: true };
}

/** Set rootCardMessageId after first card send (commit #3 hook will use this). */
export function setRootCardMessageId(id: string, messageId: string | null): RootInboxItem | null {
  const store = read();
  const idx = store.items.findIndex(it => it.id === id);
  if (idx < 0) return null;
  store.items[idx] = { ...store.items[idx], rootCardMessageId: messageId };
  write(store);
  return store.items[idx];
}

/** Close an item. Returns the closed item, or null if id not found.
 *  No-op if already closed (returns the closed item unchanged). */
export function close(id: string): RootInboxItem | null {
  const store = read();
  const idx = store.items.findIndex(it => it.id === id);
  if (idx < 0) return null;
  if (store.items[idx].status === 'closed') return store.items[idx];
  const now = new Date().toISOString();
  store.items[idx] = {
    ...store.items[idx],
    status: 'closed',
    lastUpdatedAt: now,
  };
  write(store);
  return store.items[idx];
}

/** Test helper. */
export function __clearForTesting(): void {
  write({ items: [] });
}
