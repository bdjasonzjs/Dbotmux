/**
 * Phase B (2026-05-27): 克劳德 daemon scout-inbox 主动决策路由器.
 *
 * 缇蕾 Phase A 已把 high-prio item push 进 scout-inbox.pending; 这里克劳德
 * daemon 每 60s 扫一次, 按规则 route 每个 item 到 3 条路径之一:
 *
 * - 路径 A (ping 松松): blocker / high-prio todo → 一条批量消息丢主话题
 *   @松松 (一个 tick 至多发 1 条, batch). 不 spawn.
 * - 路径 B (自己接手): med/low priority todo + 已超过 1h 没人 dismiss → 调
 *   spawnSubTask 开分身 chat 处理. 永远不在 mainTopic spawn.
 * - 路径 C (auto-archive): 任何 >7d 仍 pending 的 → dismissed, 不做动作.
 * - wait: 不满足以上, 留着下个 tick 重判.
 *
 * 安全 gate (硬写, 跨 process 持久化在 ~/.botmux/data/scout-router-quota.json):
 * 1. 每日路径 A ping 数 ≤ MAX_PINGS_PER_DAY (默认 20)
 * 2. 每日路径 B spawn 数 ≤ MAX_SPAWNS_PER_DAY (默认 10)
 * 3. mainTopic 永远不 spawn (路径 B 一定走 spawnSubTask, spawnSubTask 内已
 *    禁 mainTopic; 这里 router 不重复 gate)
 * 4. 每个 item 走过的路径不重新 evaluate — status 改成非 pending 后从队列出
 *
 * 整段模块 pure(无 fs / network), executor 由 caller 注入, 方便 test mock.
 */
import { logger } from '../utils/logger.js';
import {
  readInbox,
  writeInbox,
  dispositionTillyHigh,
  markTillyHighRouterPinged,
  type ScoutInboxItem,
  type ScoutTillyHighItem,
} from './main-bot-digest-store.js';
import { config } from '../config.js';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export type RouteAction = 'A_ping' | 'B_spawn' | 'C_archive' | 'wait';

/** 一次 tick 的 routing 决策结果(纯函数输出, 真正 fs/lark 操作由 executor 做). */
export interface RouteDecision {
  itemId: string;
  action: RouteAction;
  reason: string;
}

export interface RouterPolicy {
  /** 路径 C 触发的 item age 阈值 (ms). 默认 7d. */
  archiveAfterMs: number;
  /** 路径 B 触发前的 grace period — 让松松/手动 react 的时间窗 (ms). 默认 1h. */
  spawnGraceMs: number;
  /** 每日路径 A 上限. */
  maxPingsPerDay: number;
  /** 每日路径 B 上限. */
  maxSpawnsPerDay: number;
}

export const DEFAULT_POLICY: RouterPolicy = {
  archiveAfterMs: 7 * 24 * 3600 * 1000,
  spawnGraceMs: 60 * 60 * 1000,
  maxPingsPerDay: 20,
  maxSpawnsPerDay: 10,
};

/** 每日配额 — 跨 process 持久化, 跟 tilly-digest 同日逻辑 (Asia/Shanghai). */
export interface DailyQuotaState {
  dateId: string;
  pingsUsed: number;
  spawnsUsed: number;
}

function getDateId(date: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(date);
}

function quotaPath(): string {
  return join(config.session.dataDir, 'scout-router-quota.json');
}

export function readQuota(): DailyQuotaState {
  const today = getDateId();
  const fp = quotaPath();
  if (!existsSync(fp)) return { dateId: today, pingsUsed: 0, spawnsUsed: 0 };
  try {
    const raw = JSON.parse(readFileSync(fp, 'utf-8')) as DailyQuotaState;
    if (raw.dateId !== today) return { dateId: today, pingsUsed: 0, spawnsUsed: 0 };
    return raw;
  } catch {
    return { dateId: today, pingsUsed: 0, spawnsUsed: 0 };
  }
}

export function writeQuota(q: DailyQuotaState): void {
  const fp = quotaPath();
  const dir = dirname(fp);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = fp + '.tmp';
  writeFileSync(tmp, JSON.stringify(q, null, 2), 'utf-8');
  renameSync(tmp, fp);
}

/** Pure decision: 给一条 pending tilly_digest_high item 决定要走哪条路径.
 *  不考虑 quota (quota 由 caller 在 batch 层校验, 这里只看 item 本身的 age +
 *  priority + status). */
export function decideAction(
  item: ScoutTillyHighItem,
  opts: { now: Date; policy: RouterPolicy },
): RouteDecision {
  if (item.status !== 'pending') {
    return { itemId: item.id, action: 'wait', reason: `not pending (status=${item.status})` };
  }
  const ageMs = opts.now.getTime() - new Date(item.enqueuedAt).getTime();

  // 路径 C: 超过 archive TTL 一律归档, 不论 category/priority
  if (ageMs > opts.policy.archiveAfterMs) {
    return { itemId: item.id, action: 'C_archive', reason: `age ${Math.floor(ageMs / 3600000)}h > ${Math.floor(opts.policy.archiveAfterMs / 3600000)}h archive TTL` };
  }

  // 路径 A: blocker 永远要 ping (任何 age); high-prio todo 也 ping
  // Phase C.1 (2026-05-28): gate 从 notifiedAt 改 routerPingedAt——前者
  // 是 tilly-publisher 发卡片时间, 跟 router path A 无关; 之前撞同字段导致
  // router 静默 0 action (tilly 先 set notifiedAt → router 看「已 ping」)。
  if (!item.routerPingedAt) {
    if (item.category === 'blocker') {
      return { itemId: item.id, action: 'A_ping', reason: 'blocker 任何年龄都 ping' };
    }
    if (item.category === 'todo' && item.payload.priority === 'high') {
      return { itemId: item.id, action: 'A_ping', reason: 'high-prio todo 立刻 ping' };
    }
  }

  // 路径 B: med/low priority todo, 已过 grace, 还没人处理 → 自己接手
  if (
    item.category === 'todo' &&
    (item.payload.priority === 'med' || item.payload.priority === 'low' || !item.payload.priority) &&
    ageMs > opts.policy.spawnGraceMs
  ) {
    return { itemId: item.id, action: 'B_spawn', reason: `med/low todo age ${Math.floor(ageMs / 60000)}m > ${Math.floor(opts.policy.spawnGraceMs / 60000)}m grace` };
  }

  // 路径 A 已 notified 但还 pending — 等用户/克劳德手动 dismiss/process, 不重 ping
  return { itemId: item.id, action: 'wait', reason: 'awaiting human disposition or grace period' };
}

/** Executor 接口 — 真实 lark/spawnSubTask 调用由调用方注入, router 不直接耦合 IO. */
export interface RouterExecutors {
  /** Path A 批量 ping: tick 内所有 A_ping items 聚合成一条消息发主话题 @松松. */
  pingJason(items: ScoutTillyHighItem[]): Promise<void>;
  /** Path B: 给一条 item 调 spawnSubTask 开分身 chat. 返回 chatId / null (失败). */
  spawnHandler(item: ScoutTillyHighItem): Promise<string | null>;
}

export interface TickResult {
  routedA: number;
  routedB: number;
  routedC: number;
  waited: number;
  errors: number;
  quotaSkipsA: number;
  quotaSkipsB: number;
}

/** 跑一轮: 读 inbox.pending → 决策 → 批 path A → 逐 item path B/C. */
export async function runRouterTick(opts: {
  now?: Date;
  policy?: RouterPolicy;
  executors: RouterExecutors;
}): Promise<TickResult> {
  const now = opts.now ?? new Date();
  const policy = opts.policy ?? DEFAULT_POLICY;
  const inbox = readInbox();
  let quota = readQuota();
  const stats: TickResult = {
    routedA: 0, routedB: 0, routedC: 0, waited: 0, errors: 0,
    quotaSkipsA: 0, quotaSkipsB: 0,
  };

  const decisions: RouteDecision[] = [];
  const itemById = new Map<string, ScoutTillyHighItem>();
  for (const it of inbox.pending) {
    if (it.type !== 'tilly_digest_high') continue;     // escalation 走老路径不归本 router
    itemById.set(it.id, it);
    decisions.push(decideAction(it, { now, policy }));
  }

  // Path A: batch ping, 1 条消息一 tick (跨 item 合并). quota gate.
  // 注意: pingsUsed 在 pingJason 成功后 +=aItems.length 一次性提交, 这里
  // 决策时要把 aItems 已收的 count 计入预算, 否则单 tick 内会偷过 quota.
  const aItems: ScoutTillyHighItem[] = [];
  for (const d of decisions.filter(d => d.action === 'A_ping')) {
    if (quota.pingsUsed + aItems.length >= policy.maxPingsPerDay) {
      stats.quotaSkipsA += 1;
      logger.warn(`[scout-router] quota 用尽: pings ${quota.pingsUsed + aItems.length}/${policy.maxPingsPerDay} 今日, item ${d.itemId} 留 pending 明天再判`);
      continue;
    }
    const it = itemById.get(d.itemId);
    if (it) aItems.push(it);
  }
  if (aItems.length > 0) {
    try {
      await opts.executors.pingJason(aItems);
      // ping 成功后, 每条 mark routerPingedAt + quota +1 (按 item 数而非按消息数, 防一次 batch 偷过 quota)
      // Phase C.1: 用 routerPingedAt 不用 notifiedAt——后者是 tilly-publisher 发
      // 卡片用的, 跟 router path A 无关。
      for (const it of aItems) {
        markTillyHighRouterPinged(it.id);
        quota = { ...quota, pingsUsed: quota.pingsUsed + 1 };
      }
      writeQuota(quota);
      stats.routedA = aItems.length;
    } catch (err: any) {
      logger.error(`[scout-router] path A pingJason failed: ${err?.message ?? err}`);
      stats.errors += 1;
    }
  }

  // Path B: 逐 item spawn, quota gate
  for (const d of decisions.filter(d => d.action === 'B_spawn')) {
    if (quota.spawnsUsed >= policy.maxSpawnsPerDay) {
      stats.quotaSkipsB += 1;
      logger.warn(`[scout-router] quota 用尽: spawns ${quota.spawnsUsed}/${policy.maxSpawnsPerDay} 今日, item ${d.itemId} 留 pending`);
      continue;
    }
    const it = itemById.get(d.itemId);
    if (!it) continue;
    try {
      const chatId = await opts.executors.spawnHandler(it);
      if (chatId) {
        dispositionTillyHigh(it.id, {
          status: 'processed',
          handledBy: `claude-auto:spawnSubTask:${chatId.slice(0, 12)}`,
          resolution: `路径 B 自动 spawn 分身 chat ${chatId} 接手 (${d.reason})`,
        });
        quota = { ...quota, spawnsUsed: quota.spawnsUsed + 1 };
        writeQuota(quota);
        stats.routedB += 1;
      } else {
        logger.warn(`[scout-router] spawnHandler returned null for ${it.id} — 留 pending`);
      }
    } catch (err: any) {
      logger.error(`[scout-router] path B spawnHandler ${it.id} failed: ${err?.message ?? err}`);
      stats.errors += 1;
    }
  }

  // Path C: archive (dispositionTillyHigh dismissed) — 不计 quota
  for (const d of decisions.filter(d => d.action === 'C_archive')) {
    const it = itemById.get(d.itemId);
    if (!it) continue;
    try {
      dispositionTillyHigh(it.id, {
        status: 'dismissed',
        handledBy: 'claude-auto:archive-ttl',
        resolution: `路径 C 自动归档: ${d.reason}`,
      });
      stats.routedC += 1;
    } catch (err: any) {
      logger.error(`[scout-router] path C archive ${it.id} failed: ${err?.message ?? err}`);
      stats.errors += 1;
    }
  }

  stats.waited = decisions.filter(d => d.action === 'wait').length;
  return stats;
}
