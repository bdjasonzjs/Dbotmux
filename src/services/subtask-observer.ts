/**
 * 子任务编排系统 · Phase 2 观测脚本 (2026-05-30)。
 *
 * 脚本化观测 (不起 live bot)：定时 tick，对每个活跃子任务 ——
 *   从 committedCursor 之后读增量 → coco 判进展(带 goal+历史上下文) →
 *   commitObservationTransaction **原子提交** (落 Observation + 可选上报命令 + 推 cursor + 状态转移)。
 *
 * reported_done recheck：done 后若子群又有新活动且不再 done → 回退 observing/reported_help，
 * 并 supersede 旧 done 命令，防 LLM 误判 done 后僵死。
 * reported_help 不重复刷 help：等主 bot supplement 期间只记观测、不再发 help 命令。
 *
 * 决策逻辑在此、可单测；IO (拉消息 / coco) 由 executors 注入。CursorConflict 时 skip
 * (下轮重试)，绝不绕过 store 的可靠性校验。
 */
import { logger } from '../utils/logger.js';
import {
  listSubTasks, listObservations, listCommands, commitObservationTransaction,
  helpReportDelivery, staleHelpCommandIds,
  CursorConflictError, InvalidCursorCommitError, VersionConflictError, ACTIVE_STATUSES,
  type SubTask, type SubTaskStatus, type Signal, type HelpDelivery,
} from './subtask-store.js';

export interface JudgeContext {
  goal: string;
  acceptance: string | null;
  compactSummary: string | null;
  recentObservations: string[];   // 历次总结 (外部记忆)
  newMessages: string;            // 本轮增量 (老→新)
}
export interface JudgeResult { signal: Signal; summary: string; evidenceLinks?: string[]; }

export interface FetchResult {
  /** 从 afterMessageId 之后**紧接着、连续、老→新**的增量 (最多 limit 条)。
   *  关键 (review Blocker 1)：必须是连续的，cursor 才能安全推到本批最后一条不漏。 */
  messages: Array<{ id: string; rendered: string }>;
  /** 是否已读到群尾。false = 还有更多 (忙群积压)，本轮只推进到本批末尾，下轮接着读。 */
  complete: boolean;
}
export interface ObserverExecutors {
  /** 拉子群 committedCursor 之后的连续增量 (老→新, 最多 limit)。afterMessageId=null 从头。
   *  IO 失败/timeout 必须**抛错** (observer 会 skip 不推进 cursor)，不能静默返空。 */
  fetchSince(chatId: string, afterMessageId: string | null, limit: number): Promise<FetchResult>;
  /** coco 按 goal+历史判进展。判不出(LLM 失败/parse 失败/timeout) 返 null →
   *  observer skip 本 tick、**不推进 cursor** (review Blocker 3)，下轮重读这批。 */
  judge(ctx: JudgeContext): Promise<JudgeResult | null>;
}

/** 节流：同子任务最短观测间隔 (避免忙群一直跑 coco)。 */
export const MIN_OBSERVE_INTERVAL_MS = 90_000;
const FETCH_LIMIT = 40;
/** 求助投出后多久没被主 bot ack 就当"石沉大海"，允许补发 (P1)。 */
export const HELP_ACK_TIMEOUT_MS = 10 * 60_000;

export async function runObserverTick(now: Date, exec: ObserverExecutors): Promise<{ checked: number; committed: number; errors: number }> {
  const stats = { checked: 0, committed: 0, errors: 0 };
  for (const t of listSubTasks({ statuses: ACTIVE_STATUSES })) {
    try {
      const did = await tickOne(t, now, exec);
      stats.checked += 1;
      if (did) stats.committed += 1;
    } catch (err) {
      stats.errors += 1;
      logger.warn(`[subtask-observer] tick ${t.taskId} failed: ${err}`);
    }
  }
  return stats;
}

async function tickOne(t: SubTask, now: Date, exec: ObserverExecutors): Promise<boolean> {
  // 节流：距上次观测不够久 → 跳过
  const lastObs = listObservations(t.taskId).slice(-1)[0];
  if (lastObs && now.getTime() - new Date(lastObs.at).getTime() < MIN_OBSERVE_INTERVAL_MS) return false;

  // 读 committedCursor 之后的【连续】增量 (老→新)。fetchSince IO 失败会抛 → 上层 catch skip。
  const fetched = await exec.fetchSince(t.chatId, t.committedCursor, FETCH_LIMIT);
  if (fetched.messages.length === 0) return false;

  // review Blocker 1: 只分析这批连续增量、cursor 只推到本批最后一条。!complete 时积压留给下轮，
  // 绝不把 cursor 跳到"没读到的最新"。
  const ordered = fetched.messages; // 已是 老→新 连续
  const analyzedMessageIds = ordered.map(m => m.id);
  const readToCursor = analyzedMessageIds[analyzedMessageIds.length - 1];
  const renderedNew = ordered.map(m => m.rendered).join('\n');
  if (!fetched.complete) logger.info(`[subtask-observer] ${t.taskId} 积压未读完, 本轮推进到 ${readToCursor?.slice(0, 10)}, 下轮继续`);

  const recentObs = listObservations(t.taskId, 5).map(o => `[${o.signal}] ${o.summary}`);
  const judged = await exec.judge({
    goal: t.goal, acceptance: t.acceptance, compactSummary: t.compactSummary,
    recentObservations: recentObs, newMessages: renderedNew,
  });

  // review Blocker 3: judge 失败 (null) → skip 本 tick、**不推进 cursor**，下轮重读这批。
  // 不能当 normal 推进，否则吞掉 LLM/parse/timeout 那批里的 need_help/done。
  if (judged == null) {
    logger.info(`[subtask-observer] ${t.taskId} coco 判断失败 → skip (cursor 不推进, 下轮重读)`);
    return false;
  }

  const plan = planCommit(
    t.status, judged.signal, readToCursor,
    () => listCommands(t.taskId).filter(c => c.commandType === 'report_done' && c.supersededBy == null).map(c => c.cmdId),
    // P1: reported_help+need_help 是否补发，绑 help 命令投递生命周期 (不只看 status)
    () => helpReportDelivery(t.taskId, now, HELP_ACK_TIMEOUT_MS),
    () => staleHelpCommandIds(t.taskId),
  );

  try {
    // review Blocker 2: 带 expectedVersion=t.version。judge 期间主 bot finish/supplement 改了
    // 状态/版本 → VersionConflict → skip，绝不拿旧计划写进 finished/已变更的 task。
    const res = await commitObservationTransaction({
      taskId: t.taskId, readFromCursor: t.committedCursor, readToCursor, analyzedMessageIds,
      summary: judged.summary, signal: judged.signal, evidenceLinks: judged.evidenceLinks,
      report: plan.report, statusTo: plan.statusTo, supersedeCommandIds: plan.supersedeCommandIds,
      expectedVersion: t.version,
    });
    if (res == null) { logger.info(`[subtask-observer] ${t.taskId} commit null (非法转移?) skip`); return false; }
    logger.info(`[subtask-observer] ${t.taskId} signal=${judged.signal} → ${plan.statusTo ?? t.status}${plan.report ? ` report=${plan.report.commandType}` : ''}`);
    return true;
  } catch (err) {
    if (err instanceof CursorConflictError || err instanceof InvalidCursorCommitError || err instanceof VersionConflictError) {
      // cursor/版本 被别的进程改了 → 本轮放弃、不推进，下轮按新状态重来
      logger.info(`[subtask-observer] ${t.taskId} conflict, skip this tick: ${err.message}`);
      return false;
    }
    throw err;
  }
}

interface CommitPlan {
  report?: { commandType: 'report_help' | 'report_done'; idempotencyKey: string };
  statusTo?: SubTaskStatus;
  supersedeCommandIds?: string[];
}

/** 纯决策：当前状态 + signal → 要不要上报 / 转什么状态 / supersede 哪些旧命令。可单测。
 *  helpDelivery/staleHelpCmdIds (P1) 默认给"已 acked + 无旧命令"，等价旧行为；
 *  observer tickOne 注入真实值，让 reported_help no-respam 绑 command lifecycle。 */
export function planCommit(
  status: SubTaskStatus, signal: Signal, readToCursor: string | null,
  pendingDoneCmdIds: () => string[],
  helpDelivery: () => HelpDelivery = () => 'acked',
  staleHelpCmdIds: () => string[] = () => [],
): CommitPlan {
  const helpReport = { commandType: 'report_help' as const, idempotencyKey: `help_${readToCursor}` };
  const doneReport = { commandType: 'report_done' as const, idempotencyKey: `done_${readToCursor}` };

  if (status === 'reported_done') {
    // recheck
    if (signal === 'done') return {}; // 仍 done → 只记观测，不重复报
    // 不再 done (有新工作/blocker) → 回退 + supersede 旧 done
    const stale = pendingDoneCmdIds();
    const supersedeCommandIds = stale.length ? stale : undefined;
    if (signal === 'need_help') return { report: helpReport, statusTo: 'reported_help', supersedeCommandIds };
    return { statusTo: 'observing', supersedeCommandIds };
  }

  if (status === 'reported_help') {
    if (signal === 'done') return { report: doneReport, statusTo: 'reported_done' };
    if (signal === 'need_help') {
      // P1: 不能只因"已是 reported_help"就吞掉求助。看旧 help 命令真实投递态:
      //   acked → 主bot在处理, 静默; pending / sent_unacked_fresh → 求助在路上, 给时间不 respam;
      //   sent_unacked_expired / failed / none → 没送达/石沉大海/状态命令不一致 → 补发 + supersede 旧 help。
      const hd = helpDelivery();
      if (hd === 'acked' || hd === 'pending' || hd === 'sent_unacked_fresh') return {};
      const stale = staleHelpCmdIds();
      return { report: helpReport, supersedeCommandIds: stale.length ? stale : undefined };
    }
    // normal：等主 bot supplement 期间只记观测
    return {};
  }

  // observing
  if (signal === 'need_help') return { report: helpReport, statusTo: 'reported_help' };
  if (signal === 'done') return { report: doneReport, statusTo: 'reported_done' };
  return {}; // normal → 只记观测 + 推进 cursor
}
