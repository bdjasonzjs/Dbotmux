/**
 * 子任务编排系统 · Phase 3 投递层 (2026-05-30)。
 *
 * outbox dispatcher：把 store 里 pending 的 OutboxCommand 真正投递出去 ——
 *   child_to_parent (子群求助/完成上报 → 父群)、parent_to_child (主 bot finish/supplement → 子群)。
 *
 * 可靠性 (蔻黛克斯 review 核心)：上报**不假设送达**。
 *   - 投递成功 → deliveryStatus=sent + deliveredMessageId(主bot query 锚点) + sentAt。
 *   - 投递失败 → retryCount++ + 指数退避 nextRetryAt；超 MAX_RETRY → failed (可见、不静默丢)。
 *   - at-least-once：sent 回写前崩溃会重投，故 IO 层 (executor) 必须拿 cmd 稳定 id 当
 *     lark 发送幂等键，防重复刷群。
 *
 * 决策逻辑在此、可单测；真 IO (发消息) 由 executors 注入。
 */
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import {
  listPendingCommands, claimCommandForDispatch, completeDispatch, supersedeCommand, getSubTask,
  type OutboxCommand, type SubTask,
} from './subtask-store.js';

export interface DispatchExecutors {
  /** 把一条 outbox 命令投到 cmd.targetChatId。成功返 {ok:true, messageId}；
   *  失败返 {ok:false, error}（**别抛**，让 dispatcher 走重试退避）。
   *  IO 层须用 cmd 的稳定 id (cmdId/idempotencyKey) 作 lark 发送幂等键，
   *  防 sent 回写前崩溃导致重复投递刷群。 */
  deliver(cmd: OutboxCommand, task: SubTask): Promise<{ ok: boolean; messageId?: string; error?: string; relayRecordId?: string }>;
}

/** 投递失败最多重试几次 (含首发后)。超过 → failed。 */
export const MAX_RETRY = 5;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 600_000;
/** 单条投递 lease 时长，须 ≥ 一次 deliver IO 的最坏耗时，过期后别的进程可重 claim。
 *  kickoff 可能在 base relay 内等待新群 group-id 字段 ready，再轮询「已发送」，因此要大于 60s。 */
export const DISPATCH_LEASE_MS = 120_000;

/** 第 attempt 次重试 (1-based) 的退避间隔：30s,60s,120s,240s,480s → cap 10min。 */
export function planBackoff(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS);
}

export type DispatchAction = { action: 'send' } | { action: 'skip'; reason: string };

/** 纯决策：这条 pending 命令现在该投、还是作废跳过 (task 没了 / 已终态等)。可单测。 */
export function planDispatch(cmd: OutboxCommand, task: SubTask | null): DispatchAction {
  if (!task) return { action: 'skip', reason: 'orphan-task-gone' };
  if (cmd.supersededBy != null) return { action: 'skip', reason: 'superseded' }; // 双保险
  if (cmd.deliveryStatus !== 'pending') return { action: 'skip', reason: `status-${cmd.deliveryStatus}` };
  // E2E 抓到的 bug: finish 命令必须**豁免**终态 skip —— 它的语义就是"通知子群任务已 finished"，
  // task 进 finished 后才会产生 finish 命令，若被终态守卫 skip 掉，子群永远收不到结束通知。
  // 只 skip 非 finish 的 parent→child (= supplement)：finished/stopped 后再补充输入没意义 (保留 TOCTOU 防线)。
  if (cmd.direction === 'child_to_parent' && (task.status === 'finished' || task.status === 'stopped')) {
    return { action: 'skip', reason: `task-terminal-${task.status}` };
  }
  if (cmd.direction === 'parent_to_child' && cmd.commandType !== 'finish'
    && (task.status === 'finished' || task.status === 'stopped')) {
    return { action: 'skip', reason: `task-terminal-${task.status}` };
  }
  return { action: 'send' };
}

export interface DispatchStats { sent: number; retried: number; failed: number; skipped: number; }

export async function runDispatcherTick(now: Date, exec: DispatchExecutors): Promise<DispatchStats> {
  const stats: DispatchStats = { sent: 0, retried: 0, failed: 0, skipped: 0 };
  for (const cmd of listPendingCommands(now)) {
    try {
      const task = getSubTask(cmd.taskId);
      const decision = planDispatch(cmd, task);
      if (decision.action === 'skip') {
        // 不再需要投递 → supersede 掉，避免反复扫到同一条
        await supersedeCommand(cmd.cmdId, `dispatch-skip:${decision.reason}`);
        stats.skipped += 1;
        logger.info(`[outbox-dispatcher] skip cmd ${cmd.cmdId} (${cmd.commandType}): ${decision.reason}`);
        continue;
      }

      // 硬约束1: 先原子 claim lease 再 IO。多进程只有一个 claim 成功 → 不重复投。
      const attemptId = randomUUID();
      const claimed = await claimCommandForDispatch(cmd.cmdId, attemptId, DISPATCH_LEASE_MS, now);
      if (!claimed) { stats.skipped += 1; continue; } // 别的进程在投 / 已不可投

      // review P1-2 (TOCTOU): claim 和 deliver 之间 task 可能被 Phase4/别进程终态化。
      // claim 后重读 task 再复核一次，避免 parent→child 按旧状态发出去。
      const freshTask = getSubTask(cmd.taskId);
      const recheck = planDispatch(claimed, freshTask);
      if (recheck.action === 'skip') {
        // CAS 作废 (清 lease + supersede)，本次 attempt 持锁所以一定写得进
        await completeDispatch(cmd.cmdId, attemptId, { supersededBy: `dispatch-skip:${recheck.reason}` });
        stats.skipped += 1;
        logger.info(`[outbox-dispatcher] post-claim skip cmd ${cmd.cmdId} (${cmd.commandType}): ${recheck.reason}`);
        continue;
      }

      let res: { ok: boolean; messageId?: string; error?: string; relayRecordId?: string };
      try {
        res = await exec.deliver(claimed, freshTask!);
      } catch (err: any) {
        // executor 本不该抛，但防御：当失败处理走退避
        res = { ok: false, error: `deliver threw: ${err?.message ?? err}` };
      }

      // 幂等 (2026-06-10 修重复刷屏)：executor 首发写入的 base recordId 必须落库 (成功/失败都落)，
      // 重试时复用它只重轮询、不再 upsert 新记录，避免自动化重复发同一条消息。
      const relayRecordId = res.relayRecordId ?? claimed.relayRecordId ?? null;

      if (res.ok) {
        // CAS 回写 (lease 没被抢走才写)，一并清 lease
        const ok = await completeDispatch(cmd.cmdId, attemptId, {
          deliveryStatus: 'sent', deliveredMessageId: res.messageId ?? null, relayRecordId,
          sentAt: now.toISOString(), nextRetryAt: null, lastError: null,
        });
        if (ok) {
          stats.sent += 1;
          logger.info(`[outbox-dispatcher] sent cmd ${cmd.cmdId} (${cmd.commandType}) → ${cmd.targetChatId.slice(0, 12)} msg=${res.messageId?.slice(0, 12) ?? '?'}`);
        } else {
          stats.skipped += 1; // lease 已被接管，本次结果作废 (新投递会接手)
        }
      } else {
        const attempt = claimed.retryCount + 1;
        // 退避: retryCount + nextRetryAt + 清 lease 全在同一次 completeDispatch (锁内) 写完
        const patch = attempt >= MAX_RETRY
          ? { deliveryStatus: 'failed' as const, retryCount: attempt, lastError: res.error ?? 'deliver failed', relayRecordId }
          : { retryCount: attempt, nextRetryAt: new Date(now.getTime() + planBackoff(attempt)).toISOString(), lastError: res.error ?? 'deliver failed', relayRecordId };
        const ok = await completeDispatch(cmd.cmdId, attemptId, patch);
        if (!ok) { stats.skipped += 1; continue; } // lease 丢了，别覆盖
        if (attempt >= MAX_RETRY) {
          stats.failed += 1;
          logger.warn(`[outbox-dispatcher] FAILED cmd ${cmd.cmdId} (${cmd.commandType}) after ${attempt} attempts: ${res.error}`);
        } else {
          stats.retried += 1;
          logger.info(`[outbox-dispatcher] retry cmd ${cmd.cmdId} (${cmd.commandType}) attempt ${attempt}, backoff ${planBackoff(attempt) / 1000}s`);
        }
      }
    } catch (err) {
      // store 写冲突等 → 本轮放过这条，下轮重来 (pending 不变)
      logger.warn(`[outbox-dispatcher] cmd ${cmd.cmdId} tick failed: ${err}`);
    }
  }
  return stats;
}
