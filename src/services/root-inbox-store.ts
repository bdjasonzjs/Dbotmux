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

export type RootInboxKind =
  | 'escalation' | 'progress' | 'request_decision'
  | 'manager_stalled' | 'manager_session_aged'
  | 'tilly_digest' | 'tilly_alert';
export type RootInboxStatus = 'open' | 'updated' | 'closed';

export interface RootInboxItem {
  /** Deterministic dedup key. Composition depends on kind:
   *  - kind=escalation:        `${ruleId}:${subChatId}`
   *  - kind=progress:          `progress:${subChatId}:${slug}`
   *  - kind=request_decision:  `request_decision:${subChatId}:${slug}`
   *  - kind=manager_stalled:   `manager_stalled:${taskId}`
   *  - kind=manager_session_aged: `manager_session_aged:${taskId}` */
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

/** P0-2 fix (2026-05-25 妹妹 blocker): 找 baseId 下当前 open 的那张
 *  generation card（generation 后缀 `#N`），找不到返 null。专为
 *  alert/digest 这种 singleton-with-reopen 设计的 dismiss helper —
 *  避免 `lookup(baseId)` 在 reopen 后只看到 closed 的 generation 1 失效。
 *
 *  Returns latest open item where item.id === baseId || item.id startsWith baseId+'#'. */
export function lookupOpenByBaseId(baseId: string): RootInboxItem | null {
  const items = read().items;
  const matches = items.filter(it => (it.id === baseId || it.id.startsWith(baseId + '#')) && it.status !== 'closed');
  if (matches.length === 0) return null;
  // 最新一条（按 lastUpdatedAt 倒序）
  matches.sort((a, b) => new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime());
  return matches[0];
}

/** Build a dedup id from kind + relevant fields. Helper for callers. */
export function buildId(opts:
  | { kind: 'escalation'; ruleId: EscalationRuleId; subChatId: string }
  | { kind: 'progress'; subChatId: string; slug: string }
  | { kind: 'request_decision'; subChatId: string; slug: string }
  | { kind: 'manager_stalled'; taskId: string }
  | { kind: 'manager_session_aged'; taskId: string },
): string {
  if (opts.kind === 'escalation') return `${opts.ruleId}:${opts.subChatId}`;
  if (opts.kind === 'manager_stalled' || opts.kind === 'manager_session_aged') return `${opts.kind}:${opts.taskId}`;
  return `${opts.kind}:${opts.subChatId}:${opts.slug}`;
}

/**
 * Insert a new open item, or update an existing open item with the same id.
 * Returns the (possibly updated) item + whether it was newly inserted.
 *
 * P2-rev1 #2 (妹妹 review): closed item is **NOT a terminal sink for the
 * baseId** when `allowReopen=true`. After all prior generations are closed,
 * a new fire creates a fresh item with `#<N>` generation suffix on the
 * stored id (lifecycle is independent — new card, separate close history).
 *
 *   - existing open/updated with same id → update in place
 *   - all prior generations closed + allowReopen=true →
 *     create new item with id = `${opts.id}#${N+1}` (N = max prior gen)
 *   - closed + allowReopen=false → return existing closed item (no-op,
 *     same as old behavior; used for progress/request_decision where slug
 *     change is the proper way to start a new card)
 *
 * `inserted: true` is returned in BOTH the brand-new and reopened cases —
 * caller treats them identically (send fresh card to mainTopic).
 *
 * `reopenedGeneration` is set when this is a re-open (N+1 ≥ 2).
 */
export function upsertOpen(opts: {
  id: string;
  kind: RootInboxKind;
  subChatId: string;
  subChatName: string;
  ruleId?: EscalationRuleId;
  summary: string;
  /** P2-rev1 #2: when true, a closed baseId allows a new generation
   *  (with `#N` suffix). Default false preserves legacy behavior. */
  allowReopen?: boolean;
}): { item: RootInboxItem; inserted: boolean; reopenedGeneration?: number } {
  const store = read();
  const now = new Date().toISOString();
  // Walk existing items with this base id (including any reopened
  // generations like `id#2`, `id#3`). Use baseId prefix matching.
  const baseId = opts.id;
  const sameBaseItems = store.items.filter(it => it.id === baseId || it.id.startsWith(baseId + '#'));
  const openOne = sameBaseItems.find(it => it.status !== 'closed');
  if (openOne) {
    const idx = store.items.findIndex(it => it.id === openOne.id);
    const updated: RootInboxItem = {
      ...openOne,
      status: 'updated',
      lastUpdatedAt: now,
      updateCount: openOne.updateCount + 1,
      summary: opts.summary,
      subChatName: opts.subChatName,
    };
    store.items[idx] = updated;
    write(store);
    return { item: updated, inserted: false };
  }
  // No open item with this baseId.
  if (sameBaseItems.length > 0 && !opts.allowReopen) {
    // Legacy: closed + no reopen → return last closed unchanged
    const lastClosed = sameBaseItems[sameBaseItems.length - 1];
    return { item: lastClosed, inserted: false };
  }
  // Decide id: brand-new (no prior) → use baseId; reopen → baseId#N+1
  let newId = baseId;
  let reopenedGeneration: number | undefined;
  if (sameBaseItems.length > 0) {
    // All closed, but reopen allowed. Find max generation suffix used.
    let maxGen = 1;   // baseId == generation 1
    for (const it of sameBaseItems) {
      const m = it.id.match(/#(\d+)$/);
      if (m) {
        const g = Number(m[1]);
        if (g > maxGen) maxGen = g;
      }
    }
    const nextGen = maxGen + 1;
    newId = `${baseId}#${nextGen}`;
    reopenedGeneration = nextGen;
  }
  const item: RootInboxItem = {
    id: newId,
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
  return { item, inserted: true, reopenedGeneration };
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

/** Close ALL open items for a given subChatId. Returns the count closed.
 *  Used by chat-context-store.archive() hook so归档子群自动关掉所有
 *  挂在它名下的 root-inbox 条目 (escalation / progress / request_decision)。 */
export function closeAllForSubChat(subChatId: string): number {
  const store = read();
  let count = 0;
  const now = new Date().toISOString();
  for (let i = 0; i < store.items.length; i++) {
    const it = store.items[i];
    if (it.subChatId === subChatId && it.status !== 'closed') {
      store.items[i] = { ...it, status: 'closed', lastUpdatedAt: now };
      count++;
    }
  }
  if (count > 0) write(store);
  return count;
}

/** Test helper. */
export function __clearForTesting(): void {
  write({ items: [] });
}
