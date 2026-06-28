/**
 * 解析「当前 CLI 进程真正属于哪个 botmux 会话」——顺进程树找 worker 写的 marker 文件，
 * 而不是读易残留旧值的 `env BOTMUX_SESSION_ID`。
 *
 * 根因（被本模块根治）：daemon / 会话重启后，shell 里的 BOTMUX_SESSION_ID 会残留旧值、
 * 指向别的群；subtask-create / subtask-orch / progress-report / bot-clone 等薄壳过去只信这个
 * env 来定「汇报回哪个群」，于是子任务进展静默发到错误群。marker 是按**实际进程祖先**解析的，
 * 不随 env 残留而错，是 restart-stable 的真值。
 *
 * 与 cli.ts:findAncestorSessionId / resolveDataDir 同源逻辑（cli.ts 的私有副本服务交互式 TUI，
 * 本模块服务 CLI 薄壳）。两份实现语义必须一致。
 * TODO(drift-guard, 后续收口任务)：把 cli.ts 的私有 findAncestorSessionId/resolveDataDir 也改为
 * 复用本模块，消除两份 ppid-walk + resolveDataDir 副本，避免语义漂移。本次为缩小基建改动面（宁慢
 * 勿错）暂不动 cli.ts TUI 路径。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.botmux');
const DEFAULT_DATA_DIR = join(CONFIG_DIR, 'data');

/** 与 cli.ts:resolveDataDir 同源：SESSION_DATA_DIR > .data-dir 面包屑 > 默认 ~/.botmux/data。 */
export function resolveDataDir(): string {
  if (process.env.SESSION_DATA_DIR) return process.env.SESSION_DATA_DIR;
  const breadcrumb = join(CONFIG_DIR, '.data-dir');
  if (existsSync(breadcrumb)) {
    try {
      const dir = readFileSync(breadcrumb, 'utf-8').trim();
      if (dir && existsSync(dir)) {
        if (existsSync(join(dir, 'sessions.json'))) return dir;
        try {
          const files = readdirSync(dir);
          if (files.some(f => f.startsWith('sessions-') && f.endsWith('.json'))) return dir;
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
  return DEFAULT_DATA_DIR;
}

/**
 * 顺进程树（ppid 向上最多 8 层）找 botmux worker 写的 CLI-pid marker，返回其中的真 sessionId。
 *  - 命中非空 marker → 返回该 sessionId（进程实际所属会话，restart-stable）。
 *  - 命中空 / legacy marker → 返回 ''（调用方据此回退 env）。
 *  - 整条祖先链都没 marker → 返回 null。
 */
export function findAncestorSessionId(): string | null {
  const markersDir = join(resolveDataDir(), '.botmux-cli-pids');
  if (!existsSync(markersDir)) return null;

  let pid = process.ppid;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    const markerPath = join(markersDir, String(pid));
    if (existsSync(markerPath)) {
      try { return readFileSync(markerPath, 'utf-8').trim(); } catch { return ''; }
    }
    try {
      const out = execSync(`ps -o ppid= -p ${pid}`, { encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      pid = parseInt(out, 10);
      if (isNaN(pid)) break;
    } catch { break; }
  }
  return null;
}

export type SessionIdSource = 'flag' | 'marker' | 'env' | 'none';

/**
 * 确定 CLI 命令该用的 sessionId（= 子任务汇报父群的依据），根治 stale-env 错群。同时回报来源。
 *
 * 优先级：显式 `--session-id` flag > 进程树 marker（真值） > `env BOTMUX_SESSION_ID`（legacy 兜底）。
 * marker 与 env 不一致时**以 marker 为准**，并打 stderr 告警——把过去「静默指错群」变成可见。
 *
 * @param flagSid 命令行 `--session-id` 解析到的值（没有则 undefined）。
 * @param markerResolver 进程树 marker 解析器（默认 {@link findAncestorSessionId}；测试可注入）。
 */
export function resolveSessionIdWithSource(
  flagSid?: string,
  markerResolver: () => string | null = findAncestorSessionId,
): { sessionId: string | null; source: SessionIdSource } {
  if (flagSid) return { sessionId: flagSid, source: 'flag' };
  const markerSid = markerResolver();
  const envSid = process.env.BOTMUX_SESSION_ID || undefined;
  if (markerSid) {
    if (envSid && envSid !== markerSid) {
      console.error(
        `[botmux] ⚠ BOTMUX_SESSION_ID(${envSid.slice(0, 8)}…) 与进程树实际会话(${markerSid.slice(0, 8)}…) 不一致——` +
        `以进程树为准（env 残留旧值，已知 daemon/会话重启坑）。`,
      );
    }
    return { sessionId: markerSid, source: 'marker' };
  }
  return { sessionId: envSid ?? null, source: envSid ? 'env' : 'none' };
}

/** {@link resolveSessionIdWithSource} 的薄包装：只要 sessionId。 */
export function resolveSessionId(flagSid?: string): string | null {
  return resolveSessionIdWithSource(flagSid).sessionId;
}
