/**
 * 给任意群挂 observer · 一期地基：watch-inbox（汇报落地通道）。
 *
 * 为什么新建而不蹭 RootInbox（设计 v3.1 §五，蔻黛克斯 P1-1）：
 *   RootInbox 的 item 只有 subChatId/rootCardMessageId，publisher 用
 *   getMainTopicChatId() 写死发**主话题**，没有任意 targetChatId 概念。盯任意群
 *   汇报到任意目标群，必须有 targetChatId + per-target 投递状态，故另起 watch-inbox
 *   （由 group-monitor 的 reports store 升级而来，旧 addReport/wakeClaude 退场）。
 *
 * incident 模型（治"回应后闭嘴"）：
 *   - fingerprint = `${watchedChatId}:${slug}`，同 fingerprint 反复判中 → upsert
 *     更新同一条、不新发；
 *   - **闭嘴只能显式 close**（人/CLI 标记处理），绝不拿被盯群任意一句话当"已回应"；
 *   - 已 close 的 fingerprint 复发 → 开新一代（`#N` 后缀），不被永久埋。
 *
 * 蔻黛克斯实现 P2-1（换目标群别复用旧 messageId）：
 *   incident 的 targetChatId 变了（同一被盯群改了汇报目标）→ 旧 delivery.messageId
 *   属于**另一个群**的卡片，不能拿去 update/close。upsert 检测到 targetChatId 变化时
 *   **重置 delivery**（messageId=null, status=pending），下次投递发到新目标群的新消息。
 *
 * 持久化：~/.botmux/data/watch-inbox.json。测试：test/watch-inbox-store.test.ts
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const STORE_FILE = 'watch-inbox.json';

export type WatchIncidentKind = 'alert' | 'digest_item';
export type WatchIncidentStatus = 'open' | 'updated' | 'closed';
export type WatchDeliveryStatus = 'pending' | 'sent' | 'failed';

/** per-target 投递状态（绑这条 incident 唯一的 targetChatId）。 */
export interface WatchDelivery {
  /** 发到目标群那条消息的 id（update/close 用同一个，绝不更新错群）。 */
  messageId: string | null;
  deliveryStatus: WatchDeliveryStatus;
  lastDeliveredAt: string | null;
  /** at-least-once 补投计数（替代旧 group-monitor 无脑 wakeClaude 的 poll-fallback）。 */
  pokeCount: number;
}

export interface WatchIncident {
  /** = fingerprint = `${watchedChatId}:${slug}`（复发后带 `#N` 代后缀）。 */
  incidentId: string;
  watchedChatId: string;
  /** 汇报到哪个群（来自 chat-policy 的 report 开关）。 */
  targetChatId: string;
  kind: WatchIncidentKind;
  status: WatchIncidentStatus;
  summary: string;
  evidence: string;
  sourceMessageIds: string[];
  delivery: WatchDelivery;
  createdAt: string;
  lastUpdatedAt: string;
  closedAt: string | null;
  closedBy: string | null;
}

interface StoreFile {
  incidents: WatchIncident[];
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
  if (!existsSync(fp)) return { incidents: [] };
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8')) as Partial<StoreFile>;
    return { incidents: parsed.incidents ?? [] };
  } catch (err) {
    logger.warn(`[watch-inbox-store] parse failed: ${err}; treating as empty`);
    return { incidents: [] };
  }
}
function write(store: StoreFile): void {
  ensureDir();
  const fp = filePath();
  const tmp = fp + '.tmp';
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  renameSync(tmp, fp);
}

function freshDelivery(): WatchDelivery {
  return { messageId: null, deliveryStatus: 'pending', lastDeliveredAt: null, pokeCount: 0 };
}

/** fingerprint = 被盯群 + 归一化卡点 slug。targetChatId **不入** fingerprint：
 *  同一被盯群的同一卡点，改了汇报目标仍是同一 incident（由 upsert 处理目标迁移）。 */
export function buildFingerprint(watchedChatId: string, slug: string): string {
  return `${watchedChatId}:${slug}`;
}

// ─── 读 ─────────────────────────────────────────────────────────────────────

export function listAll(): WatchIncident[] {
  return [...read().incidents].sort((a, b) =>
    new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime());
}

export function listOpen(): WatchIncident[] {
  return listAll().filter(it => it.status !== 'closed');
}

/** 某目标群名下所有 open incident（per-target 聚合 digest 用）。 */
export function listOpenByTarget(targetChatId: string): WatchIncident[] {
  return listOpen().filter(it => it.targetChatId === targetChatId);
}

export function getIncident(incidentId: string): WatchIncident | null {
  return read().incidents.find(it => it.incidentId === incidentId) ?? null;
}

/** 当前 open（含复发代）的 incident，按 baseId（fingerprint）查。 */
export function lookupOpenByFingerprint(fingerprint: string): WatchIncident | null {
  const open = read().incidents.filter(
    it => (it.incidentId === fingerprint || it.incidentId.startsWith(fingerprint + '#')) && it.status !== 'closed');
  if (open.length === 0) return null;
  open.sort((a, b) => new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime());
  return open[0];
}

// ─── 写 ─────────────────────────────────────────────────────────────────────

export interface UpsertIncidentOpts {
  watchedChatId: string;
  slug: string;
  targetChatId: string;
  kind: WatchIncidentKind;
  summary: string;
  evidence: string;
  sourceMessageIds: string[];
}

/**
 * Upsert 一条 incident（按 fingerprint 去重）：
 *   - 同 fingerprint 有 open/updated 的 → 原地 update（status='updated'，合并证据消息）；
 *     · **P2-1**：若 targetChatId 变了 → 重置 delivery（旧 messageId 属另一个群，不可复用）；
 *   - 全部代已 close → 复发：开新一代 `${fingerprint}#N`（fresh delivery）；
 *   - 没历史 → 新建 open（fresh delivery）。
 * inserted=true 表示需要"发新消息"（全新或复发新代或目标群已迁移）。
 */
export function upsertIncident(opts: UpsertIncidentOpts): { incident: WatchIncident; inserted: boolean } {
  const store = read();
  const now = new Date().toISOString();
  const fingerprint = buildFingerprint(opts.watchedChatId, opts.slug);
  const sameBase = store.incidents.filter(
    it => it.incidentId === fingerprint || it.incidentId.startsWith(fingerprint + '#'));
  const openOne = sameBase.find(it => it.status !== 'closed');

  if (openOne) {
    const idx = store.incidents.findIndex(it => it.incidentId === openOne.incidentId);
    const targetChanged = openOne.targetChatId !== opts.targetChatId;
    const mergedSources = [...new Set([...openOne.sourceMessageIds, ...opts.sourceMessageIds])];
    const updated: WatchIncident = {
      ...openOne,
      targetChatId: opts.targetChatId,
      kind: opts.kind,
      status: 'updated',
      summary: opts.summary,
      evidence: opts.evidence,
      sourceMessageIds: mergedSources,
      // P2-1：目标群变了 → 旧 messageId 不能跨群 update/close，重置投递发新消息。
      delivery: targetChanged ? freshDelivery() : openOne.delivery,
      lastUpdatedAt: now,
    };
    store.incidents[idx] = updated;
    write(store);
    if (targetChanged) {
      logger.info(`[watch-inbox-store] ${updated.incidentId} target changed → delivery reset (new target=${opts.targetChatId.slice(0, 12)})`);
    }
    // 目标群迁移 = 需要发新消息 → inserted=true
    return { incident: updated, inserted: targetChanged };
  }

  // 无 open：全新 或 复发（全部代已 close）
  let incidentId = fingerprint;
  if (sameBase.length > 0) {
    let maxGen = 1;
    for (const it of sameBase) {
      const m = it.incidentId.match(/#(\d+)$/);
      if (m) { const g = Number(m[1]); if (g > maxGen) maxGen = g; }
    }
    incidentId = `${fingerprint}#${maxGen + 1}`;
  }
  const incident: WatchIncident = {
    incidentId,
    watchedChatId: opts.watchedChatId,
    targetChatId: opts.targetChatId,
    kind: opts.kind,
    status: 'open',
    summary: opts.summary,
    evidence: opts.evidence,
    sourceMessageIds: [...new Set(opts.sourceMessageIds)],
    delivery: freshDelivery(),
    createdAt: now,
    lastUpdatedAt: now,
    closedAt: null,
    closedBy: null,
  };
  store.incidents.push(incident);
  write(store);
  return { incident, inserted: true };
}

/** 更新某 incident 的投递状态（publisher 发完/失败后回写）。 */
export function updateDelivery(
  incidentId: string,
  patch: Partial<WatchDelivery>,
): WatchIncident | null {
  const store = read();
  const idx = store.incidents.findIndex(it => it.incidentId === incidentId);
  if (idx < 0) return null;
  store.incidents[idx] = {
    ...store.incidents[idx],
    delivery: { ...store.incidents[idx].delivery, ...patch },
  };
  write(store);
  return store.incidents[idx];
}

/** 显式 close 一条 incident（"回应后闭嘴"的唯一扳机）。已 close → no-op。 */
export function closeIncident(incidentId: string, by = 'manual'): WatchIncident | null {
  const store = read();
  const idx = store.incidents.findIndex(it => it.incidentId === incidentId);
  if (idx < 0) return null;
  if (store.incidents[idx].status === 'closed') return store.incidents[idx];
  const now = new Date().toISOString();
  store.incidents[idx] = { ...store.incidents[idx], status: 'closed', closedAt: now, closedBy: by, lastUpdatedAt: now };
  write(store);
  logger.info(`[watch-inbox-store] closed ${incidentId} by ${by}`);
  return store.incidents[idx];
}

/** 测试用。 */
export function __clearForTesting(): void {
  write({ incidents: [] });
}
