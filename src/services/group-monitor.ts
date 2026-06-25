/**
 * 群监控 tick —— group-monitor 作为「给任意群挂 observer」的底座（一期改造）。
 *
 * 原始（2026-05-30）：命中 → addReport + wakeClaude(@克劳德主话题)。
 * 一期改造（设计 v3.1 §五/§六）：命中 → 改写 **watch-inbox incident**（按 fingerprint
 * 去重 + 显式 close 才闭嘴 + 复发开新代），汇报目标群从统一 chat-policy 的 report 开关取；
 * 旧 addReport / wakeClaude / runReportPollFallback **退场**（杜绝双投递），实际投递与
 * at-least-once 重投由 watch-inbox 投递层（publisher，下一块）按 targetChatId 负责。
 *
 * 仍保留底座能力：monitors 注册表 + 高水位 + 节流 + 拉消息 + 缇蕾判读（read-only，
 * 绝不往被盯群发言）。report 开关 = off 的群命中也**不建 incident**（只盯不报）。
 *
 * 决策逻辑（节流/高水位/建不建 incident）在这里、可单测；IO（拉消息/coco）由
 * executors 注入。
 */
import { logger } from '../utils/logger.js';
import { listMonitors, updateMonitor, type GroupMonitor } from './group-monitor-store.js';
import { getReportTarget } from './chat-policy-store.js';
import { upsertIncident } from './watch-inbox-store.js';

export interface JudgeResult {
  /** 新消息里有没有"符合监控目标、该上报"的事件。 */
  report: boolean;
  summary: string;
  evidence: string;
  /** 可选：LLM 给的稳定事件 slug（用于 fingerprint 去重）；不给则由 summary 归一化派生。 */
  slug?: string;
}

export interface MonitorExecutors {
  /** 拉群最近消息 (newest first), 返 [{id, rendered}]。 */
  fetchMessages(chatId: string, limit: number): Promise<Array<{ id: string; rendered: string }>>;
  /** coco 按 goal 判断新消息里有没有该上报事件。判不出返 null (当作无事件)。 */
  judge(goal: string, renderedNewMessages: string): Promise<JudgeResult | null>;
}

/** 节流: 同一监控最短判断间隔 (避免忙群里一直跑 LLM)。 */
export const MIN_JUDGE_INTERVAL_MS = 120_000;
const FETCH_LIMIT = 30;

/** group-monitor 的 messageId 高水位判断：无最新消息或最新等于游标 → 无新增。 */
export function peekByMessageHighWater(newestMessageId: string | null, lastSeenMessageId: string | null): { hasNew: boolean; cursor: string | null } {
  return { hasNew: !!newestMessageId && newestMessageId !== lastSeenMessageId, cursor: newestMessageId ?? lastSeenMessageId };
}

/** 把事件要点归一化成稳定 slug（去空白/标点/控制字符、小写、截断），让"同一卡点换个
 *  说法"也落同一 fingerprint。与 subtask-observer 的 normalizeAsk 同思路。 */
export function normalizeSlug(s: string): string {
  // eslint-disable-next-line no-control-regex
  const norm = s.replace(/[\s\x00-\x1F\x7F]+/g, '').replace(/[。，、,.!！?？;；:：]/g, '').toLowerCase();
  return norm.slice(0, 60) || 'event';
}

/** 主 tick: 扫所有 enabled 监控。 */
export async function runMonitorTick(now: Date, exec: MonitorExecutors): Promise<void> {
  for (const mon of listMonitors({ enabledOnly: true })) {
    try {
      await tickOne(mon, now, exec);
    } catch (err) {
      logger.warn(`[group-monitor] tick chat=${mon.chatId.slice(0, 12)} failed: ${err}`);
    }
  }
}

async function tickOne(mon: GroupMonitor, now: Date, exec: MonitorExecutors): Promise<void> {
  // 节流: 距上次判断不到最短间隔 → 跳过
  if (mon.lastJudgedAt && now.getTime() - new Date(mon.lastJudgedAt).getTime() < MIN_JUDGE_INTERVAL_MS) return;

  const msgs = await exec.fetchMessages(mon.chatId, FETCH_LIMIT); // newest first
  if (msgs.length === 0) return;
  const newestId = msgs[0].id;
  // "有消息才读": 没新消息 (newest 跟上次一样) → 跳过, 不跑 LLM
  if (!peekByMessageHighWater(newestId, mon.lastSeenMessageId).hasNew) return;

  // 只取"上次见过之后"的新消息 (按 id 高水位)
  let newMsgs = msgs;
  if (mon.lastSeenMessageId) {
    const idx = msgs.findIndex(m => m.id === mon.lastSeenMessageId);
    if (idx > 0) newMsgs = msgs.slice(0, idx);
    else if (idx < 0) newMsgs = msgs;
  }
  const rendered = newMsgs.slice().reverse().map(m => m.rendered).join('\n').trim();

  // 先推进高水位 + 记节流时间 (即使判 negative / 判断失败也推进, 避免反复判同一批 = 省 LLM)
  updateMonitor(mon.chatId, { lastSeenMessageId: newestId, lastJudgedAt: now.toISOString() });
  if (!rendered) return;

  const judged = await exec.judge(mon.goal, rendered);
  if (!judged || !judged.report) return;

  // 一期：命中 → 写 watch-inbox incident（不再 addReport+wakeClaude）。
  // 汇报目标群从统一 chat-policy 取；report=off（无目标）→ 只盯不报、不建 incident。
  const targetChatId = getReportTarget(mon.chatId);
  if (!targetChatId) {
    logger.info(`[group-monitor] ${mon.chatId.slice(0, 12)} 命中但 report=off → 只盯不报, 不建 incident`);
    return;
  }
  const slug = (judged.slug && judged.slug.trim()) ? normalizeSlug(judged.slug) : normalizeSlug(judged.summary);
  const { incident, inserted } = upsertIncident({
    watchedChatId: mon.chatId,
    slug,
    targetChatId,
    // 一期：无锚只 digest、不实时弹 → 命中一律落 digest_item，由 per-target digest 聚合上报。
    // 有锚实时 alert 放二期。
    kind: 'digest_item',
    summary: judged.summary,
    evidence: judged.evidence,
    sourceMessageIds: newMsgs.map(m => m.id),
  });
  logger.info(`[group-monitor] ${mon.chatId.slice(0, 12)} 命中 → incident ${incident.incidentId} (${inserted ? 'new/reopen' : 'update'}) → 目标群 ${targetChatId.slice(0, 12)}`);
}
