/**
 * contextDelivery 灰度开关 store（设计: design-context-file-delivery.md §3.4）。
 *
 * 半静态上下文块的运载方式：
 *   - 'inline'（默认，现状）：块全文随每条消息下发。
 *   - 'file'  ：块写入本地上下文文件，消息里只带 <context_ref path+version> stub。
 *
 * 解析顺序：per-chat 覆盖 > 全局默认 > 'inline'。回滚 = 配置翻回 inline，不动代码。
 *
 * Layout（照 chat-mode-store 的模式）：
 *   ${config.session.dataDir}/context-delivery/<chatId>.json   —— per-chat 覆盖
 *   ${config.session.dataDir}/context-delivery/__global__.json —— 全局默认
 * 一文件一项、原子写（tmp + rename）、无共享内存缓存，跨 daemon 写不冲突——文件即真相。
 * 缺文件 / 解析失败 → 'inline'（绝不因配置层故障把群误切进 file 模式）。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export type ContextDeliveryMode = 'inline' | 'file';

/** 全局默认项在目录里的保留文件名（oc_ 开头的真实 chatId 不会撞上）。 */
const GLOBAL_KEY = '__global__';

interface ContextDeliveryRecord {
  /** chatId 或 GLOBAL_KEY。 */
  key: string;
  mode: ContextDeliveryMode;
  since: string; // ISO 设置时刻
}

function dir(): string {
  return join(config.session.dataDir, 'context-delivery');
}
function filePath(key: string): string {
  return join(dir(), `${key}.json`);
}

function readMode(key: string): ContextDeliveryMode | null {
  try {
    const p = filePath(key);
    if (!existsSync(p)) return null;
    const rec = JSON.parse(readFileSync(p, 'utf-8')) as ContextDeliveryRecord;
    return rec.mode === 'file' ? 'file' : rec.mode === 'inline' ? 'inline' : null;
  } catch (err) {
    logger.warn(`[context-delivery] read ${key} failed, treating as unset: ${err}`);
    return null;
  }
}

/** 解析某群生效的 delivery 模式：per-chat 覆盖 > 全局默认 > 'inline'。 */
export function getContextDelivery(chatId: string | undefined): ContextDeliveryMode {
  if (chatId) {
    const perChat = readMode(chatId);
    if (perChat) return perChat;
  }
  return readMode(GLOBAL_KEY) ?? 'inline';
}

/** 查询含来源（CLI 展示用）。 */
export function getContextDeliveryWithSource(chatId: string | undefined): { mode: ContextDeliveryMode; source: 'chat' | 'global' | 'default' } {
  if (chatId) {
    const perChat = readMode(chatId);
    if (perChat) return { mode: perChat, source: 'chat' };
  }
  const global = readMode(GLOBAL_KEY);
  if (global) return { mode: global, source: 'global' };
  return { mode: 'inline', source: 'default' };
}

function writeRecord(key: string, mode: ContextDeliveryMode): ContextDeliveryRecord {
  const rec: ContextDeliveryRecord = { key, mode, since: new Date().toISOString() };
  mkdirSync(dir(), { recursive: true });
  const p = filePath(key);
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf-8');
  renameSync(tmp, p);
  logger.info(`[context-delivery] set ${key === GLOBAL_KEY ? 'global' : `chat=${key.slice(0, 12)}`} mode=${mode}`);
  return rec;
}

/** 设置 per-chat 覆盖（原子写）。 */
export function setContextDelivery(chatId: string, mode: ContextDeliveryMode): void {
  writeRecord(chatId, mode);
}

/** 设置全局默认（原子写）。 */
export function setGlobalContextDelivery(mode: ContextDeliveryMode): void {
  writeRecord(GLOBAL_KEY, mode);
}

/** 清除 per-chat 覆盖（回到全局默认）。返回是否真的删了。 */
export function clearContextDelivery(chatId: string): boolean {
  const p = filePath(chatId);
  if (!existsSync(p)) return false;
  rmSync(p);
  logger.info(`[context-delivery] cleared chat=${chatId.slice(0, 12)} override`);
  return true;
}
