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
  | 'escalated_done'     // 已升级"完成"
  | 'escalated_stuck'    // 已升级"卡死"
  | 'escalated_decision' // 已升级"需松松决策"
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

/** 测试用。 */
export function __resetForTesting(): void {
  write({ watches: [] });
}
