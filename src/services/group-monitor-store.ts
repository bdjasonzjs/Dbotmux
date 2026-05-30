/**
 * 群实时监控 (2026-05-30 松松): 指定群 + 监控目标, 缇蕾只读判断、命中就 @ 唤醒克劳德。
 *
 * 跟 subgroup-watch 互补:
 *   - subgroup-watch: 面向 spawnSubTask 编排建的群, 判通用进展 (in_progress/done/stuck)。
 *   - group-monitor (本文件): 面向任意指定群 + 自定义监控目标, 缇蕾 read-only 判断,
 *     命中"该上报的情况"就写一条 report + @ 唤醒克劳德主会话去读。
 *
 * 持久化: ~/.botmux/data/group-monitors.json (跨 daemon 重启存活)。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export interface GroupMonitor {
  chatId: string;
  /** 监控目标 (自然语言), 喂给 coco 判断"有没有该上报的事件"。 */
  goal: string;
  enabled: boolean;
  createdAt: string;
  /** 高水位: 上次判断见过的最新消息 id, 只判它之后的新消息 (按 id 高水位防漏/防重判)。 */
  lastSeenMessageId: string | null;
  /** 节流: 上次真正跑 coco 判断的时间 (ISO), null=没跑过。 */
  lastJudgedAt: string | null;
}

export interface MonitorReport {
  id: string;
  /** 来源监控群。 */
  chatId: string;
  goal: string;
  /** 一句话: 发生了什么、为什么该上报。 */
  summary: string;
  /** 证据 (相关消息摘录), 给主会话核实用。 */
  evidence: string;
  createdAt: string;
  /** seen 标记: 主会话读取/消费后写时间; null=未消费。防止重复处理。 */
  consumedAt: string | null;
  /** 唤醒克劳德戳过几次 (poll-fallback 补戳用)。 */
  pokeCount: number;
  lastPokedAt: string | null;
}

interface StoreFile {
  monitors: GroupMonitor[];
  reports: MonitorReport[];
}

function fp(): string { return join(config.session.dataDir, 'group-monitors.json'); }
function ensureDir(): void {
  const d = dirname(fp());
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function read(): StoreFile {
  if (!existsSync(fp())) return { monitors: [], reports: [] };
  try {
    const s = JSON.parse(readFileSync(fp(), 'utf-8')) as Partial<StoreFile>;
    return { monitors: s.monitors ?? [], reports: s.reports ?? [] };
  } catch (err) {
    logger.error(`[group-monitor-store] parse failed: ${err}; treating as empty`);
    return { monitors: [], reports: [] };
  }
}

function write(s: StoreFile): void {
  ensureDir();
  const tmp = fp() + '.tmp';
  writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf-8');
  renameSync(tmp, fp());
}

// ─── 监控注册表 ────────────────────────────────────────────────────────────

/** 注册/更新一个群监控 (同 chatId 已存在则更新 goal + 重新 enable)。 */
export function registerMonitor(opts: { chatId: string; goal: string }): GroupMonitor {
  const s = read();
  const existing = s.monitors.find(m => m.chatId === opts.chatId);
  if (existing) {
    existing.goal = opts.goal;
    existing.enabled = true;
    write(s);
    logger.info(`[group-monitor-store] updated monitor chat=${opts.chatId.slice(0, 12)}`);
    return existing;
  }
  const m: GroupMonitor = {
    chatId: opts.chatId,
    goal: opts.goal,
    enabled: true,
    createdAt: new Date().toISOString(),
    lastSeenMessageId: null,
    lastJudgedAt: null,
  };
  s.monitors.push(m);
  write(s);
  logger.info(`[group-monitor-store] registered monitor chat=${opts.chatId.slice(0, 12)} goal="${opts.goal.slice(0, 40)}"`);
  return m;
}

export function listMonitors(opts?: { enabledOnly?: boolean }): GroupMonitor[] {
  const all = read().monitors;
  return opts?.enabledOnly ? all.filter(m => m.enabled) : all;
}

export function getMonitor(chatId: string): GroupMonitor | null {
  return read().monitors.find(m => m.chatId === chatId) ?? null;
}

export function updateMonitor(chatId: string, patch: Partial<Omit<GroupMonitor, 'chatId'>>): GroupMonitor | null {
  const s = read();
  const idx = s.monitors.findIndex(m => m.chatId === chatId);
  if (idx < 0) return null;
  s.monitors[idx] = { ...s.monitors[idx], ...patch };
  write(s);
  return s.monitors[idx];
}

/** 移除一个监控 (连带它的报告)。返是否移除了。 */
export function removeMonitor(chatId: string): boolean {
  const s = read();
  const before = s.monitors.length;
  s.monitors = s.monitors.filter(m => m.chatId !== chatId);
  s.reports = s.reports.filter(r => r.chatId !== chatId);
  const removed = before !== s.monitors.length;
  if (removed) { write(s); logger.info(`[group-monitor-store] removed monitor chat=${chatId.slice(0, 12)}`); }
  return removed;
}

// ─── 报告 store (共享 JSON, 缇蕾写 / 主会话读) ──────────────────────────────

/** 缇蕾判定该上报时写一条 report。返新建的 report。 */
export function addReport(opts: { chatId: string; goal: string; summary: string; evidence: string }): MonitorReport {
  const s = read();
  const r: MonitorReport = {
    id: `mr_${Date.now()}_${(s.reports.length + 1)}`,
    chatId: opts.chatId,
    goal: opts.goal,
    summary: opts.summary,
    evidence: opts.evidence,
    createdAt: new Date().toISOString(),
    consumedAt: null,
    pokeCount: 0,
    lastPokedAt: null,
  };
  s.reports.push(r);
  write(s);
  logger.info(`[group-monitor-store] report added ${r.id} chat=${opts.chatId.slice(0, 12)}`);
  return r;
}

/** 未消费的报告 (主会话该处理的)。 */
export function listPendingReports(): MonitorReport[] {
  return read().reports.filter(r => r.consumedAt == null);
}

/** 主会话读完一条报告后标记已消费 (防重复处理)。 */
export function markReportConsumed(id: string, by = 'claude'): MonitorReport | null {
  const s = read();
  const idx = s.reports.findIndex(r => r.id === id);
  if (idx < 0) return null;
  s.reports[idx].consumedAt = new Date().toISOString();
  write(s);
  logger.info(`[group-monitor-store] report ${id} consumed by ${by}`);
  return s.reports[idx];
}

/** 戳过一次 (唤醒克劳德), 记录次数/时间, poll-fallback 补戳判断用。 */
export function bumpReportPoke(id: string): MonitorReport | null {
  const s = read();
  const idx = s.reports.findIndex(r => r.id === id);
  if (idx < 0) return null;
  s.reports[idx].pokeCount += 1;
  s.reports[idx].lastPokedAt = new Date().toISOString();
  write(s);
  return s.reports[idx];
}

/** 清理: 已消费超 24h 的报告丢掉, 防文件无限涨。返清理数。 */
export function pruneReports(now: Date = new Date()): number {
  const TTL_MS = 24 * 60 * 60 * 1000;
  const s = read();
  const before = s.reports.length;
  s.reports = s.reports.filter(r => {
    if (r.consumedAt == null) return true;
    return now.getTime() - new Date(r.consumedAt).getTime() <= TTL_MS;
  });
  const removed = before - s.reports.length;
  if (removed > 0) { write(s); logger.info(`[group-monitor-store] pruned ${removed} consumed report(s)`); }
  return removed;
}

/** 测试用。 */
export function __resetForTesting(): void {
  write({ monitors: [], reports: [] });
}
