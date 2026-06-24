/**
 * 给任意群挂 observer · 一期：per-目标群 digest 投递状态 + 日预算。
 *
 * 汇报走「按目标群聚合的 digest」：每个目标群一条滚动 digest。这里存每个目标群的：
 *   - lastSignature：上次发出的 digest 内容签名 → **内容没变就不重发**（治 digest 自身刷屏，
 *     蔻黛/初号机 review carry-over）；
 *   - lastMessageId / lastSentAt：上次那条 digest；
 *   - 日预算：每个目标群每天最多发几条 digest（兜底闸门，按 Asia/Shanghai 自然日重置）。
 *
 * 持久化：~/.botmux/data/watch-digests.json。测试：test/watch-publisher.test.ts。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const STORE_FILE = 'watch-digests.json';

/** 每个目标群每天最多发几条 digest（兜底）。 */
export const DEFAULT_MAX_DIGESTS_PER_DAY = 24;

export interface TargetDigestState {
  targetChatId: string;
  /** 上次发出的 digest 内容签名（open incident 集合 + 状态 + 归一化要点）。 */
  lastSignature: string;
  lastMessageId: string | null;
  lastSentAt: string | null;
  /** 当前预算自然日 key（Asia/Shanghai YYYY-MM-DD）。 */
  dateKey: string;
  /** 当日已发 digest 数。 */
  sentToday: number;
}

interface StoreFile {
  targets: TargetDigestState[];
}

function filePath(): string { return join(config.session.dataDir, STORE_FILE); }
function ensureDir(): void {
  const d = dirname(filePath());
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}
function read(): StoreFile {
  const fp = filePath();
  if (!existsSync(fp)) return { targets: [] };
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8')) as Partial<StoreFile>;
    return { targets: parsed.targets ?? [] };
  } catch (err) {
    logger.warn(`[watch-digest-store] parse failed: ${err}; treating as empty`);
    return { targets: [] };
  }
}
function write(store: StoreFile): void {
  ensureDir();
  const fp = filePath();
  const tmp = fp + '.tmp';
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  renameSync(tmp, fp);
}

/** Asia/Shanghai 自然日 key。 */
export function dateKeyOf(now: Date): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }); // YYYY-MM-DD
}

export function getDigestState(targetChatId: string): TargetDigestState | null {
  return read().targets.find(t => t.targetChatId === targetChatId) ?? null;
}

/** 所有已知目标群（用于 all-clear：之前发过、现在没 open incident 了，也要更新一次）。 */
export function listKnownTargets(): string[] {
  return read().targets.map(t => t.targetChatId);
}

/** 当日剩余预算（按 Asia/Shanghai 日重置）。无记录 = 满预算。 */
export function budgetRemaining(targetChatId: string, now: Date, maxPerDay = DEFAULT_MAX_DIGESTS_PER_DAY): number {
  const st = getDigestState(targetChatId);
  if (!st) return maxPerDay;
  if (st.dateKey !== dateKeyOf(now)) return maxPerDay; // 跨日重置
  return Math.max(0, maxPerDay - st.sentToday);
}

/** 记录一次成功发出的 digest：存签名/messageId + 消耗当日预算（跨日先重置）。 */
export function recordSent(opts: {
  targetChatId: string;
  signature: string;
  messageId: string | null;
  now: Date;
}): TargetDigestState {
  const store = read();
  const dk = dateKeyOf(opts.now);
  const idx = store.targets.findIndex(t => t.targetChatId === opts.targetChatId);
  const prev = idx >= 0 ? store.targets[idx] : null;
  const sameDay = prev && prev.dateKey === dk;
  const next: TargetDigestState = {
    targetChatId: opts.targetChatId,
    lastSignature: opts.signature,
    lastMessageId: opts.messageId,
    lastSentAt: opts.now.toISOString(),
    dateKey: dk,
    sentToday: (sameDay ? prev!.sentToday : 0) + 1,
  };
  if (idx >= 0) store.targets[idx] = next;
  else store.targets.push(next);
  write(store);
  return next;
}

/** 测试用。 */
export function __clearForTesting(): void {
  write({ targets: [] });
}
