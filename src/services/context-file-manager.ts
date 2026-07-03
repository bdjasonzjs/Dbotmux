/**
 * ContextFileManager —— 半静态上下文块的物化 + 版本（设计: design-context-file-delivery.md §3.2）。
 *
 * 每个 (chatId, botAppId) 一份合并文件：`~/.botmux/context/<chatId>/<appId>.md`，
 * 内容 = 该 bot 在该群命中的全部 file 型 provider 的 render 输出（按 provider id 分节）。
 *
 * 版本 = 文件全文的 sha256 前 8 位。每次构建消息时重算：
 *   - hash 与上次写入一致 → 不写文件（零 IO），消息里只带 version；
 *   - hash 变了 → 原子写（tmp + rename，多 bot 同群并发写安全）新内容。
 * 「不再注入」语义（如任务 finished 后 subtask 块消失）= 该分节从文件中消失 →
 * hash 变化 → version 变化 → bot 下一轮被要求重读。
 *
 * 文件内容必须**确定性**（不含时间戳等易变项），否则 hash 永远变、零 IO 承诺失效。
 *
 * 任何一步失败 → 返回 null，调用方（context-providers.buildContextBlocks）整轮回落
 * inline 全量注入——绝不因文件层故障丢上下文。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';

export interface ContextSection {
  /** provider id（'chat_context' 等），作分节标题用。 */
  id: string;
  /** provider render 输出全文。 */
  text: string;
}

export interface MaterializedContext {
  /** 上下文文件绝对路径。 */
  path: string;
  /** 内容 hash 短版本（8 位 hex）。 */
  version: string;
}

/** 上下文文件根目录。BOTMUX_CONTEXT_DIR 可覆盖（测试用）；默认 ~/.botmux/context。 */
export function contextRootDir(): string {
  return process.env.BOTMUX_CONTEXT_DIR?.trim() || join(homedir(), '.botmux', 'context');
}

export function contextFilePath(chatId: string, appId: string): string {
  return join(contextRootDir(), chatId, `${appId}.md`);
}

/** 组装文件全文（确定性：仅由 sections 决定，无时间戳）。 */
function composeContent(chatId: string, appId: string, sections: ContextSection[]): string {
  const header = [
    `# botmux 会话上下文（chat=${chatId} · bot=${appId}）`,
    '',
    '> 本文件由 botmux daemon 自动生成/更新，请勿手改（会被覆盖）。',
    '> 消息里的 <context_ref version> 与本文件内容一一对应：version 变了就重读本文件。',
  ].join('\n');
  const body = sections
    .map(s => `<!-- provider: ${s.id} -->\n${s.text}`)
    .join('\n\n');
  return `${header}\n\n${body}\n`;
}

function hashVersion(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex').slice(0, 8);
}

/** (chatId/appId) → 上次写入内容的 version。进程内缓存，实现「hash 不变零 IO」；
 *  daemon 重启后缓存为空，首轮会读一次现有文件比对（仍无多余写）。 */
const lastVersionCache = new Map<string, string>();

function cacheKey(chatId: string, appId: string): string {
  return `${chatId}/${appId}`;
}

/**
 * 物化 (chatId, appId) 的上下文文件。内容没变时零 IO 直接返回既有 version；
 * 变了则原子写。失败返回 null（调用方回落 inline）。
 */
export function materializeContextFile(chatId: string, appId: string, sections: ContextSection[]): MaterializedContext | null {
  try {
    const path = contextFilePath(chatId, appId);
    const content = composeContent(chatId, appId, sections);
    const version = hashVersion(content);
    const key = cacheKey(chatId, appId);

    if (lastVersionCache.get(key) === version) {
      return { path, version }; // 内容没变：零 IO
    }

    // 缓存 miss（重启后首轮 / 内容变化）：读现有文件比对，相同则只回填缓存不写盘
    if (existsSync(path)) {
      try {
        const existing = readFileSync(path, 'utf-8');
        if (hashVersion(existing) === version) {
          lastVersionCache.set(key, version);
          return { path, version };
        }
      } catch { /* 读失败 → 直接走写路径覆盖 */ }
    }

    mkdirSync(join(contextRootDir(), chatId), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, content, 'utf-8');
    renameSync(tmp, path); // 原子替换：多 bot 同群并发写不会读到半截文件
    lastVersionCache.set(key, version);
    logger.info(`[context-file] wrote chat=${chatId.slice(0, 12)} bot=${appId} version=${version} (${content.length} chars, ${sections.length} sections)`);
    return { path, version };
  } catch (err) {
    logger.warn(`[context-file] materialize failed for chat=${chatId} bot=${appId}: ${err}`);
    return null;
  }
}

/**
 * GC：清理长期未更新的上下文文件/目录（设计 §3.2，先简单做：daemon 启动时调用，
 * 删 mtime 超过 ttlDays 的 .md，随后删空的 chat 目录）。任何异常只警告不抛。
 */
export function gcContextFiles(ttlDays = 30): void {
  const root = contextRootDir();
  try {
    if (!existsSync(root)) return;
    const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const chatDir of readdirSync(root)) {
      const dirPath = join(root, chatDir);
      try {
        if (!statSync(dirPath).isDirectory()) continue;
        for (const f of readdirSync(dirPath)) {
          const fp = join(dirPath, f);
          try {
            if (statSync(fp).mtimeMs < cutoff) { rmSync(fp); removed++; }
          } catch { /* 单文件失败跳过 */ }
        }
        if (readdirSync(dirPath).length === 0) rmSync(dirPath, { recursive: true });
      } catch { /* 单目录失败跳过 */ }
    }
    if (removed > 0) logger.info(`[context-file] gc removed ${removed} stale context file(s) (ttl=${ttlDays}d)`);
  } catch (err) {
    logger.warn(`[context-file] gc failed: ${err}`);
  }
}

/** 测试用：清空进程内 version 缓存。 */
export function __resetContextFileCacheForTesting(): void {
  lastVersionCache.clear();
}
