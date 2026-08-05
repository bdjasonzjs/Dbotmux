/**
 * P3 commit #1 — tilly-message-store: messageId dedup persistence.
 *
 * 缇蕾 scout 每 15min 跑一次扫消息，需要避免重复处理同一条 messageId（同
 * 一消息既不会重复抽 todo 也不重复 push 卡）。
 *
 * 持久化文件：`~/.botmux/data/tilly-scanned-messages.json`
 * 结构：`{ scannedIds: string[]; updatedAt: string }`
 *
 * Retention: 保留最近 7 天的 messageId 集合。Lark messageId 含 timestamp，
 * 不需要单独的时间戳跟踪 — 老的自然滚出窗口（按 ingest 顺序 FIFO）。
 *
 * 为防止 set 无限增长（理论上 24h × 60min ÷ 15min = 96 ticks × N msg），
 * 用 FIFO 队列 + max cap 5 万。超过 cap → 删最老的（lark messageId 是时间
 * 有序的，head = 最老）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const STORE_FILE = 'tilly-scanned-messages.json';
const MAX_CAP = 50_000;

interface StoreFile {
  scannedIds: string[];   // FIFO order (head = oldest)
  updatedAt: string;
  /** 2026-05-29 (松松实拍漏消息根因修复): 上次成功 tick 拉到的窗口 end
   *  (ISO)。下个 tick 用 [lastFetchEnd - overlap, now] 当窗口, 而不是
   *  [now - 15min, now] —— 后者在 tick 节奏不稳 (实际 ~30min/次) 时窗口
   *  不连续, 中间漏掉一半消息。高水位 + overlap 保证不漏 + filterUnscanned
   *  兜重叠去重。 */
  lastFetchEnd?: string;
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
  if (!existsSync(fp)) return { scannedIds: [], updatedAt: new Date().toISOString() };
  try {
    return JSON.parse(readFileSync(fp, 'utf-8')) as StoreFile;
  } catch (err) {
    logger.warn(`[tilly-message-store] failed to parse ${fp}: ${err}`);
    return { scannedIds: [], updatedAt: new Date().toISOString() };
  }
}

function write(store: StoreFile): void {
  ensureDir();
  const fp = filePath();
  const tmp = fp + '.tmp';
  writeFileSync(tmp, JSON.stringify(store), 'utf-8');
  renameSync(tmp, fp);
}

/** Has this messageId been scanned in a prior tick? */
export function isScanned(messageId: string): boolean {
  // O(N) walk — acceptable for 50k cap. If perf matters later, swap to
  // an in-process Set built lazily.
  return read().scannedIds.includes(messageId);
}

/** Mark messageIds as scanned. Idempotent (dedup before push), FIFO-evicts
 *  oldest entries past MAX_CAP. */
export function markScanned(messageIds: string[]): void {
  if (messageIds.length === 0) return;
  const store = read();
  const have = new Set(store.scannedIds);
  for (const id of messageIds) {
    if (!have.has(id)) {
      store.scannedIds.push(id);
      have.add(id);
    }
  }
  // FIFO evict oldest if over cap
  if (store.scannedIds.length > MAX_CAP) {
    store.scannedIds.splice(0, store.scannedIds.length - MAX_CAP);
  }
  store.updatedAt = new Date().toISOString();
  write(store);
}

/** Filter input messageIds to those NOT yet scanned. */
export function filterUnscanned(messageIds: string[]): string[] {
  const store = read();
  const have = new Set(store.scannedIds);
  return messageIds.filter(id => !have.has(id));
}

/** 2026-05-29: 上次成功 tick 的 fetch 窗口 end (高水位)。null = 还没成功
 *  跑过 (首次 tick 回退到 now-interval)。 */
export function getLastFetchEnd(): Date | null {
  const raw = read().lastFetchEnd;
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

/** 成功 tick 后推进高水位。只在 fetch+analyze 都成功 (或确认无新消息) 后调,
 *  失败不推进 → 下个 tick 重拉同窗口, 消息不丢。 */
export function setLastFetchEnd(end: Date): void {
  const store = read();
  store.lastFetchEnd = end.toISOString();
  store.updatedAt = new Date().toISOString();
  write(store);
}

/** 2026-08-05 (病一根治): 本轮扫描窗口。`clamped=true` 表示 rawStart 早于
 *  硬上界地板、被钳到 now-maxWindowMs（高水位冻结或长时间停摆的信号）。 */
export interface TillyWindow {
  start: Date;
  end: Date;
  clamped: boolean;
}

/** 病一根治·纯函数（冻结螺旋的回归就构造在这里，可单测）：
 *  计算扫描窗口 [start, end]。start = max(高水位-overlap 或首轮 now-interval,
 *  now-maxWindowMs)。硬上界保证：**无论高水位是否冻结，窗口宽度永远 ≤
 *  maxWindowMs**，lark-cli --page-all 翻页量有界、fetch 不会无限变慢陷入
 *  60s 超时的死亡螺旋。 */
export function computeTillyWindow(
  lastEnd: Date | null,
  end: Date,
  opts: { maxWindowMs: number; overlapMs: number; intervalMs: number },
): TillyWindow {
  const rawStart = lastEnd
    ? lastEnd.getTime() - opts.overlapMs
    : end.getTime() - opts.intervalMs;
  const floor = end.getTime() - opts.maxWindowMs;
  const clamped = rawStart < floor;
  return { start: new Date(Math.max(rawStart, floor)), end, clamped };
}

/** 病一根治·纯函数（可单测）：cap-hit 时高水位应推进到的值 =
 *  max(原高水位, now-maxWindowMs)。
 *   - 正常量（原高水位 ≥ 地板）：取原值 → 维持"下轮重拉同窗口补扫剩余"语义，
 *     窗口内未扫消息靠 filterUnscanned 去重后继续分析、不丢。
 *   - 已冻结（原高水位 < 地板）：跳到地板 now-maxWindowMs → 解冻。超地板的最老
 *     未扫消息本就已被 computeTillyWindow 钳出窗口，这里推进不额外丢东西。
 *  **绝不返回比地板更早的值** → 高水位再也不会冻结在远古。 */
export function nextWatermarkOnCapHit(
  lastEnd: Date | null,
  end: Date,
  maxWindowMs: number,
): Date {
  const floor = end.getTime() - maxWindowMs;
  const prev = lastEnd ? lastEnd.getTime() : floor;
  return new Date(Math.max(prev, floor));
}

/** Stats: count, oldest/newest entry (lark messageId is sortable). */
export function stats(): { count: number; oldest: string | null; newest: string | null; updatedAt: string } {
  const store = read();
  return {
    count: store.scannedIds.length,
    oldest: store.scannedIds[0] ?? null,
    newest: store.scannedIds[store.scannedIds.length - 1] ?? null,
    updatedAt: store.updatedAt,
  };
}

/** Test helper. */
export function __clearForTesting(): void {
  write({ scannedIds: [], updatedAt: new Date().toISOString() });
}
