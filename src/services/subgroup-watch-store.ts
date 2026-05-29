/**
 * 子群任务流程 P2 (2026-05-29): 缇蕾盯群的 watch 注册表.
 *
 * claude 建子群 + 发 kickoff 后, 注册一个 watch。缇蕾的 watch cron 周期扫这个
 * 表, 对到期的 watch 去读群消息 + LLM 判 4 态, 卡死/完成/需决策时升级 claude
 * 主体。
 *
 * 持久化: ~/.botmux/data/subgroup-watches.json (跨 daemon 重启存活)。
 *
 * 频率/阈值按 urgency 分档 (松松 2026-05-29 授权我定):
 *   urgent: 扫 15min, 连续 2 次无进展判卡死
 *   normal: 扫 1h,   连续 3 次无进展判卡死
 *   low:    扫 4h,   连续 4 次无进展判卡死
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { SubgroupUrgency } from './subgroup-kickoff.js';

export type WatchStatus =
  | 'watching'           // 正常盯着
  | 'escalated_done'     // 已升级"完成" (24h 后 prune)
  | 'escalated_stuck'    // 已升级"卡死" (仍算在跟, 等处理)
  | 'escalated_decision' // 已升级"需松松决策" (仍算在跟, 等拍板)
  | 'closed'             // 真正关闭 (主体/松松 确认彻底完事) — 移出在跟列表
  | 'stopped';           // 人工停止

export interface SubgroupWatch {
  chatId: string;
  purpose: string;
  acceptance?: string;
  urgency: SubgroupUrgency;
  /** 2026-05-29: kickoff 资料存在 watch 里, 因为 kickoff 要由 coco daemon
   *  (缇蕾本地) 发 — claude daemon 借不到缇蕾 bot client。 */
  taskType: 'prd' | 'bug' | 'misc';
  refs?: string[];
  /** kickoff 是否已发 (缇蕾 @ claude+妹妹分身唤起)。watch cron 首次见到
   *  kickoffSent=false 的 watch 时补发, 然后才开始 judge。 */
  kickoffSent: boolean;
  createdAt: string;
  /** 上次缇蕾扫这个群的时间; null = 还没扫过 */
  lastCheckedAt: string | null;
  /** 连续判"无实质进展"的次数; 到阈值升级卡死 */
  noProgressCount: number;
  /** 上次扫到的最后一条群消息 id, 用来判断有没有新消息(粗判进展) */
  lastSeenMessageId: string | null;
  status: WatchStatus;
  escalatedAt: string | null;
  escalationReason: string | null;
}

export const POLL_INTERVAL_MS: Record<SubgroupUrgency, number> = {
  urgent: 15 * 60 * 1000,
  normal: 60 * 60 * 1000,
  low: 4 * 60 * 60 * 1000,
};

export const NO_PROGRESS_THRESHOLD: Record<SubgroupUrgency, number> = {
  urgent: 2,
  normal: 3,
  low: 4,
};

interface StoreFile {
  watches: SubgroupWatch[];
}

function fp(): string { return join(config.session.dataDir, 'subgroup-watches.json'); }
function ensureDir(): void {
  const d = dirname(fp());
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function read(): StoreFile {
  if (!existsSync(fp())) return { watches: [] };
  try {
    return JSON.parse(readFileSync(fp(), 'utf-8')) as StoreFile;
  } catch (err) {
    logger.error(`[subgroup-watch-store] parse failed: ${err}; treating as empty`);
    return { watches: [] };
  }
}

function write(s: StoreFile): void {
  ensureDir();
  const tmp = fp() + '.tmp';
  writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf-8');
  renameSync(tmp, fp());
}

/** 注册一个新 watch (建群 + kickoff 后调)。同 chatId 已存在则不重复注册 (返既有)。 */
export function registerWatch(opts: {
  chatId: string;
  purpose: string;
  acceptance?: string;
  urgency: SubgroupUrgency;
  taskType: 'prd' | 'bug' | 'misc';
  refs?: string[];
}): SubgroupWatch {
  const s = read();
  const existing = s.watches.find(w => w.chatId === opts.chatId);
  if (existing) return existing;
  const w: SubgroupWatch = {
    chatId: opts.chatId,
    purpose: opts.purpose,
    acceptance: opts.acceptance,
    urgency: opts.urgency,
    taskType: opts.taskType,
    refs: opts.refs,
    kickoffSent: false,
    createdAt: new Date().toISOString(),
    lastCheckedAt: null,
    noProgressCount: 0,
    lastSeenMessageId: null,
    status: 'watching',
    escalatedAt: null,
    escalationReason: null,
  };
  s.watches.push(w);
  write(s);
  logger.info(`[subgroup-watch-store] registered watch chat=${opts.chatId.slice(0, 12)} urgency=${opts.urgency}`);
  return w;
}

/** 当前还在盯 (status=watching) 的 watch。 */
export function listActiveWatches(): SubgroupWatch[] {
  return read().watches.filter(w => w.status === 'watching');
}

export function getWatch(chatId: string): SubgroupWatch | null {
  return read().watches.find(w => w.chatId === chatId) ?? null;
}

/** patch 一个 watch (in-place by chatId). 返 null 如果不存在。 */
export function updateWatch(chatId: string, patch: Partial<Omit<SubgroupWatch, 'chatId'>>): SubgroupWatch | null {
  const s = read();
  const idx = s.watches.findIndex(w => w.chatId === chatId);
  if (idx < 0) return null;
  s.watches[idx] = { ...s.watches[idx], ...patch };
  write(s);
  return s.watches[idx];
}

/** 人工/完成后停止盯 (status 不为 watching 即不再被 cron 扫)。 */
export function stopWatch(chatId: string, status: Exclude<WatchStatus, 'watching'>, reason: string): SubgroupWatch | null {
  return updateWatch(chatId, { status, escalatedAt: new Date().toISOString(), escalationReason: reason });
}

// ─── 主体感知"在跟任务" (2026-05-29 松松) ─────────────────────────────

/** 主体应该"惦记着"的在跟任务: 正在跟 (watching) + 已升级但没真关闭
 *  (stuck / 需决策)。**关键**: escalated_stuck / escalated_decision 也算在跟
 *  —— 升级 ≠ 解决, 这些恰是主体最该看的。escalated_done / closed / stopped
 *  不在内 (完成的不算"在跟")。 */
export function listAwareWatches(): SubgroupWatch[] {
  const aware: WatchStatus[] = ['watching', 'escalated_stuck', 'escalated_decision'];
  return read().watches.filter(w => aware.includes(w.status));
}

/** 真正关闭一个子群任务 (主体确认完事 / 松松说关掉) → 移出在跟列表, 缇蕾也
 *  不再盯。by = 'claude' | 'jason' | 其他标识, 进 escalationReason 审计。 */
export function closeWatch(chatId: string, by: string, note?: string): SubgroupWatch | null {
  return updateWatch(chatId, {
    status: 'closed',
    escalatedAt: new Date().toISOString(),
    escalationReason: `closed by ${by}${note ? ': ' + note : ''}`,
  });
}

/** 自动清理 (cron 调): escalated_done 超 24h prune; 任何 watch 超 7d 没动
 *  (lastCheckedAt / createdAt) 也 prune, 防列表堆垃圾 / 死群常驻。
 *  返清理掉的数量。 */
export function pruneStale(now: Date = new Date()): number {
  const DONE_TTL_MS = 24 * 60 * 60 * 1000;
  const DEAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const s = read();
  const before = s.watches.length;
  s.watches = s.watches.filter(w => {
    const lastTouch = new Date(w.lastCheckedAt ?? w.escalatedAt ?? w.createdAt).getTime();
    const age = now.getTime() - lastTouch;
    // done 超 24h → 丢
    if (w.status === 'escalated_done' && age > DONE_TTL_MS) return false;
    // 任何状态超 7d 没动 → 丢 (死群兜底)
    if (age > DEAD_TTL_MS) return false;
    return true;
  });
  const removed = before - s.watches.length;
  if (removed > 0) {
    write(s);
    logger.info(`[subgroup-watch-store] pruned ${removed} stale watch(es)`);
  }
  return removed;
}

const STATUS_ICON: Record<WatchStatus, string> = {
  watching: '🟢',
  escalated_stuck: '🚧',
  escalated_decision: '🙋',
  escalated_done: '✅',
  closed: '☑️',
  stopped: '⏹',
};

const URGENCY_ICON: Record<SubgroupUrgency, string> = { urgent: '🔴', normal: '🟡', low: '⚪' };

/** 渲染主体上下文里的「当前在跟任务」块。按 卡住/待决策 优先, cap N。
 *  age 用 lastCheckedAt (多久没进展) 给主体一个新鲜度感。 */
export function buildActiveSubtasksBlock(opts?: { now?: Date; cap?: number }): string {
  const now = opts?.now ?? new Date();
  const cap = opts?.cap ?? 10;
  const aware = listAwareWatches();
  if (aware.length === 0) {
    return '<active_subtasks>\n(当前没有分身在跟的子群任务)\n</active_subtasks>';
  }
  // 排序: stuck/decision (等处理的) 优先, 再按 urgency, 再按最久没动
  const rank = (w: SubgroupWatch) =>
    (w.status === 'escalated_stuck' || w.status === 'escalated_decision' ? 0 : 1) * 100
    + ({ urgent: 0, normal: 1, low: 2 }[w.urgency]);
  const sorted = aware.slice().sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    const aT = new Date(a.lastCheckedAt ?? a.createdAt).getTime();
    const bT = new Date(b.lastCheckedAt ?? b.createdAt).getTime();
    return aT - bT;   // 久没动的在前
  });
  const shown = sorted.slice(0, cap);
  const lines = shown.map(w => {
    const since = w.lastCheckedAt ? Math.round((now.getTime() - new Date(w.lastCheckedAt).getTime()) / 60000) : null;
    const ageStr = since == null ? '还没扫过' : since < 60 ? `${since}min前看过` : `${Math.round(since / 60)}h前看过`;
    const purpose = (w.purpose ?? '').replace(/[\x00-\x1F\x7F<>]/g, ' ').slice(0, 60);
    return `${STATUS_ICON[w.status]} ${URGENCY_ICON[w.urgency]} ${purpose} — ${ageStr} [${w.chatId}]`;
  });
  const more = sorted.length > cap ? `\n... 另 ${sorted.length - cap} 个` : '';
  const hint = '\n(🚧=卡住等处理 🙋=等松松拍板 🟢=进行中; 某个确认彻底完事了用 `botmux subtask-close --chat-id <id>` 关掉)';
  return `<active_subtasks> (共 ${aware.length} 个在跟)\n${lines.join('\n')}${more}${hint}\n</active_subtasks>`;
}

/** 测试用。 */
export function __resetForTesting(): void {
  write({ watches: [] });
}
