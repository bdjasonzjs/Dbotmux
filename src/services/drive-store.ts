/**
 * 给任意群挂 observer · 二期「推动」：per-群 DriveState + 日预算。
 *
 * 推动 = 对配了「目标」的群，缇蕾盯进展、卡住了就在群里发一句**目标导向的催促**。
 * 这里存每个推动群的节流状态（防刷屏核心）：
 *   - lastSubstantiveActivityAt：上次**实质活动**时间（群里真人/他方 bot 说话；缇蕾自己的催促
 *     不算——防自激）。距它超阈值才算"卡住"。
 *   - episodeAnchorAt / nudgeCount：当前停滞窗口锚点 + 已催次数；群里有人动了（实质活动推进）→
 *     开新窗口、nudgeCount 归零（不催命：同窗口最多催 N 次）。
 *   - lastNudgeSignature：上次催促的内容签名（同目标同卡点不重复催）。
 *   - dateKey / sentToday：每群每天催促硬上限（兜底）。
 *
 * 持久化：~/.botmux/data/drive-states.json。测试：test/drive.test.ts。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const STORE_FILE = 'drive-states.json';

/** 每群每天最多主动催几次（兜底闸门）。 */
export const DEFAULT_MAX_NUDGES_PER_DAY = 6;

export interface DriveState {
  chatId: string;
  /** 上次实质活动（真人/他方 bot）时间，ISO；null=还没观测到。 */
  lastSubstantiveActivityAt: string | null;
  /** 当前停滞窗口锚点（= 开始催时的 activity 时间）。 */
  episodeAnchorAt: string | null;
  /** 本窗口已催次数。 */
  nudgeCount: number;
  /** 上次催促时间，ISO；null=没催过。 */
  lastDriveNudgeAt: string | null;
  /** 上次催促内容签名（去重，不重复说同样的话）。 */
  lastNudgeSignature: string | null;
  /** 预算自然日 key（Asia/Shanghai）。 */
  dateKey: string;
  sentToday: number;
}

interface StoreFile { states: DriveState[]; }

function filePath(): string { return join(config.session.dataDir, STORE_FILE); }
function ensureDir(): void {
  const d = dirname(filePath());
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}
function read(): StoreFile {
  const fp = filePath();
  if (!existsSync(fp)) return { states: [] };
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8')) as Partial<StoreFile>;
    return { states: parsed.states ?? [] };
  } catch (err) {
    logger.warn(`[drive-store] parse failed: ${err}; treating as empty`);
    return { states: [] };
  }
}
function write(store: StoreFile): void {
  ensureDir();
  const fp = filePath();
  const tmp = fp + '.tmp';
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  renameSync(tmp, fp);
}

export function dateKeyOf(now: Date): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

function blank(chatId: string, now: Date): DriveState {
  return {
    chatId,
    lastSubstantiveActivityAt: null,
    episodeAnchorAt: null,
    nudgeCount: 0,
    lastDriveNudgeAt: null,
    lastNudgeSignature: null,
    dateKey: dateKeyOf(now),
    sentToday: 0,
  };
}

export function getDriveState(chatId: string): DriveState | null {
  return read().states.find(s => s.chatId === chatId) ?? null;
}

/** 取或建（不落盘，建在内存里给 tick 用；变更后由 saveDriveState 落盘）。 */
export function getOrInitDriveState(chatId: string, now: Date): DriveState {
  return getDriveState(chatId) ?? blank(chatId, now);
}

export function saveDriveState(state: DriveState): void {
  const store = read();
  const idx = store.states.findIndex(s => s.chatId === state.chatId);
  if (idx >= 0) store.states[idx] = state;
  else store.states.push(state);
  write(store);
}

/** 移除一个群的推动状态（关推动时清理）。 */
export function removeDriveState(chatId: string): boolean {
  const store = read();
  const before = store.states.length;
  store.states = store.states.filter(s => s.chatId !== chatId);
  const removed = before !== store.states.length;
  if (removed) write(store);
  return removed;
}

/** 当日剩余催促预算（按 Asia/Shanghai 日重置）。 */
export function budgetRemaining(state: DriveState, now: Date, maxPerDay = DEFAULT_MAX_NUDGES_PER_DAY): number {
  if (state.dateKey !== dateKeyOf(now)) return maxPerDay;
  return Math.max(0, maxPerDay - state.sentToday);
}

export function __clearForTesting(): void {
  write({ states: [] });
}
