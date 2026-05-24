/**
 * P1 commit #3 — spawn idempotency store.
 *
 * 用途：MainBotPlaybook.spawnSubTask 唯一入口 (`getOrCompute(key, compute)`)
 * 保证同一 `idempotencyKey` 在 24h 内只产生一次 createChat 调用：
 *   - in-process 并发：per-key Promise lock（map<key, Promise>）
 *   - 跨进程：atomic tmp+rename file cache
 *
 * 设计决定（spec v0.4.1 §2 + 妹妹 review 历史）：
 *   - CLI **不直接** import 这个文件 — 必经 daemon IPC route。CLI 多进程
 *     并发场景下两个 CLI 各自的内存 lock 挡不住 race；把所有 idempotency
 *     调用串到单一 daemon 进程的 inflight Map 才能真去重。架构契约测试
 *     CL-5 在 commit #7 验证此约束。
 *   - group-creator 不知道 idempotency（spec v0.4 妹妹 #2）— 调用约定是
 *     `getOrCompute(key, () => createGroupWithBots(...))`，幂等主责在
 *     此文件 + Playbook，不在 group-creator。
 *
 * 测试：test/spawn-idempotency-store.test.ts (C-IS-1~6)
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;  // 24h
const STORE_FILE = 'group-spawn-idempotency.json';

export interface IdempotencyEntry {
  key: string;
  chatId: string;
  /** ISO timestamp of the original successful compute. */
  createdAt: string;
}

interface StoreFile {
  entries: IdempotencyEntry[];
}

export interface GetOrComputeResult {
  entry: IdempotencyEntry;
  /** true = lookup hit cache (file or in-flight); false = this caller is
   *  the winner that actually ran `compute()` */
  cacheHit: boolean;
}

/** Per-key in-process Promise lock. Concurrent `getOrCompute(k, ...)`
 *  callers with the same key all await the same Promise; only the
 *  winner runs `compute()`, others get cacheHit=true. */
const inflight = new Map<string, Promise<IdempotencyEntry>>();

function filePath(): string {
  return join(config.session.dataDir, STORE_FILE);
}

function ensureDir(): void {
  const dir = dirname(filePath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readStore(): StoreFile {
  const fp = filePath();
  if (!existsSync(fp)) return { entries: [] };
  try {
    return JSON.parse(readFileSync(fp, 'utf-8')) as StoreFile;
  } catch (err) {
    logger.warn(`[spawn-idempotency-store] failed to parse ${fp}: ${err}`);
    return { entries: [] };
  }
}

function writeStore(store: StoreFile): void {
  ensureDir();
  const fp = filePath();
  const tmp = fp + '.tmp';
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  renameSync(tmp, fp);
}

function lookupFromFile(key: string): IdempotencyEntry | null {
  const store = readStore();
  return store.entries.find(e => e.key === key) ?? null;
}

function isFresh(entry: IdempotencyEntry, now = Date.now()): boolean {
  return now - new Date(entry.createdAt).getTime() < IDEMPOTENCY_TTL_MS;
}

function persist(entry: IdempotencyEntry): void {
  const store = readStore();
  // Replace by key (last write wins for the same key — should never happen
  // because getOrCompute always awaits inflight first; defensive).
  const next = store.entries.filter(e => e.key !== entry.key);
  next.push(entry);
  writeStore({ entries: next });
}

/**
 * Look up `key` in cache; if hit and fresh, return without invoking
 * `compute()`. Otherwise run `compute()`, persist, and return.
 *
 * Per-key in-process Promise lock guarantees that two concurrent callers
 * with the same key both wait on the same `compute()` (only one runs).
 *
 * `compute()` must:
 *   - return an IdempotencyEntry (caller fills key + chatId + createdAt)
 *   - throw on failure (we clear the inflight slot and propagate; next
 *     call with same key retries)
 */
export async function getOrCompute(
  key: string,
  compute: () => Promise<IdempotencyEntry>,
): Promise<GetOrComputeResult> {
  // 1. File cache hit (< TTL) — cheap path.
  const cached = lookupFromFile(key);
  if (cached && isFresh(cached)) return { entry: cached, cacheHit: true };

  // 2. In-flight (same daemon, same key, concurrent caller).
  const pending = inflight.get(key);
  if (pending) return { entry: await pending, cacheHit: true };

  // 3. Winner — actually run compute.
  const promise = compute().then(entry => {
    persist(entry);
    return entry;
  }).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return { entry: await promise, cacheHit: false };
}

/** Sweep expired entries from the file cache. Returns count removed.
 *  Safe to call from cron / on every getOrCompute / on demand. */
export function gc(now = Date.now()): number {
  const store = readStore();
  const before = store.entries.length;
  const kept = store.entries.filter(e => isFresh(e, now));
  if (kept.length !== before) writeStore({ entries: kept });
  return before - kept.length;
}

/** Internal test helper — clear in-memory inflight Map between tests. */
export function __clearInflightForTesting(): void {
  inflight.clear();
}
