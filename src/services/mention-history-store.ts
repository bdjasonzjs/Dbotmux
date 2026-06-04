/**
 * 「被圈时间感知」存储 (2026-06-04, 邹劲松要求)。
 *
 * 目的：每个群里的 agent 被 @（被圈）时，能感知到自己最近几次在「本群」被圈
 * 分别是什么时间（东八区）。本模块只负责持久化「时间戳」，渲染（东八区格式化 +
 * prompt block）在 session-manager 里做。
 *
 * 数据模型：按 bot（larkAppId 一个文件）+ 群（chatId 一个 key）维度，各保留最近
 * MAX_RECENT 次被圈的时间戳（epoch ms，升序）。
 *
 * 持久化：~/.botmux/data/bot-mentions/<larkAppId>.json = { [chatId]: number[] }。
 *
 * 并发：调用方是同步的 prompt builder，故用同步 read-modify-write + 原子 rename。
 * 不上文件锁——极端并发下最坏只丢一个展示用时间戳，对该功能无害（不是关键数据）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/** 每个 (bot, 群) 维度保留的最近被圈次数。2026-06-04 邹劲松确认 5 次。 */
export const MAX_RECENT_MENTIONS = 5;

type Store = Record<string, number[]>; // chatId -> 升序时间戳(ms)

function dir(): string { return join(config.session.dataDir, 'bot-mentions'); }
function fp(larkAppId: string): string { return join(dir(), `${larkAppId}.json`); }

function ensureDir(): void {
  const d = dir();
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function read(larkAppId: string): Store {
  const f = fp(larkAppId);
  if (!existsSync(f)) return {};
  try {
    const raw = readFileSync(f, 'utf-8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? (data as Store) : {};
  } catch (e) {
    logger.warn(`[mention-history] 读取 ${f} 失败，按空处理: ${(e as Error).message}`);
    return {};
  }
}

function write(larkAppId: string, store: Store): void {
  ensureDir();
  const f = fp(larkAppId);
  const tmp = `${f}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  renameSync(tmp, f);
}

/** 记录一次「本 bot 在某群被圈」的时间戳，并裁剪到最近 MAX_RECENT_MENTIONS 次。 */
export function recordMention(larkAppId: string, chatId: string, tsMs: number): void {
  if (!larkAppId || !chatId || !Number.isFinite(tsMs)) return;
  try {
    const store = read(larkAppId);
    const arr = Array.isArray(store[chatId]) ? store[chatId].filter(n => Number.isFinite(n)) : [];
    arr.push(tsMs);
    arr.sort((a, b) => a - b);
    store[chatId] = arr.slice(-MAX_RECENT_MENTIONS);
    write(larkAppId, store);
  } catch (e) {
    // 记录失败绝不能阻塞消息处理。
    logger.warn(`[mention-history] 记录被圈时间失败: ${(e as Error).message}`);
  }
}

/** 读「本 bot 在某群」最近的被圈时间戳（升序）。无记录返 []。 */
export function getRecentMentions(larkAppId: string, chatId: string): number[] {
  if (!larkAppId || !chatId) return [];
  const store = read(larkAppId);
  const arr = store[chatId];
  return Array.isArray(arr) ? arr.filter(n => Number.isFinite(n)) : [];
}
