/**
 * Per-chat 模式 store（2026-06-10 邹劲松：闲聊群 vs 工作群）。
 *
 * 背景：主话题/子群会注入一大堆工作上下文（CEO 路由、子任务路由、输出纪律…），
 * 对干活很有用，但对**闲聊**是多余噪音。给每个群一个 mode：
 *   - 'work'（默认）：照旧注入全部工作块。
 *   - 'chat' ：闲聊模式，session-manager 跳过 output_discipline 等工作块，群更"裸"。
 *
 * Layout: ${config.session.dataDir}/chat-modes/<chatId>.json — 一文件一群，**global**
 * （不分 bot app id，所有 daemon 共享）。原子写（tmp + rename）、无共享内存缓存，
 * 跨 daemon 写不冲突——文件即真相。缺文件 → 默认 'work'（向后兼容，存量群行为不变）。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export type ChatMode = 'work' | 'chat';

interface ChatModeRecord {
  chatId: string;
  mode: ChatMode;
  since: string; // ISO 设置时刻
}

function dir(): string {
  return join(config.session.dataDir, 'chat-modes');
}
function filePath(chatId: string): string {
  return join(dir(), `${chatId}.json`);
}

/** 读取群模式。缺 chatId / 缺文件 / 解析失败 → 默认 'work'（绝不因读失败把工作群当闲聊群）。 */
export function getChatMode(chatId: string | undefined): ChatMode {
  if (!chatId) return 'work';
  try {
    const p = filePath(chatId);
    if (!existsSync(p)) return 'work';
    const rec = JSON.parse(readFileSync(p, 'utf-8')) as ChatModeRecord;
    return rec.mode === 'chat' ? 'chat' : 'work';
  } catch (err) {
    logger.warn(`[chat-mode] read ${chatId} failed, default work: ${err}`);
    return 'work';
  }
}

/** 设置群模式（原子写）。返回写入的记录。 */
export function setChatMode(chatId: string, mode: ChatMode): ChatModeRecord {
  const rec: ChatModeRecord = { chatId, mode, since: new Date().toISOString() };
  mkdirSync(dir(), { recursive: true });
  const p = filePath(chatId);
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf-8');
  renameSync(tmp, p);
  logger.info(`[chat-mode] set chat=${chatId.slice(0, 12)} mode=${mode}`);
  return rec;
}
