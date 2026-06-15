/**
 * 子任务编排系统 · 投递层。v2 at-least-once (2026-06-15，松松「正确第一」)。
 *
 * 两段式、**非阻塞**：
 *   Phase A 投递 (listPendingCommands)：写 base record 触发自动化发送 → 立即置 `sent_unconfirmed` 返回，
 *     **不再阻塞 35s 轮询**。写不进 record (token 死/base/网络) → 退避重试，耗尽且无 record 才 failed。
 *   Phase B 对账 (listUnconfirmedCommands)：异步查 record 状态，四分——
 *     · 已发送   → sent (确认送达)。
 *     · 已取消   → failed (自动化显式不发，终态)。
 *     · 仍待发送 + 超 resend deadline → **幂等重发** (写新 record、复用 cmdId，接收侧按 cmdId 去重，重复唤醒无害)。
 *     · unknown / auth_error → **绝不重发**，触发确认健康告警、保持 sent_unconfirmed 继续等。
 *
 * at-least-once：record 写成功 = 已入队 (不丢)；确认不了不误判 failed (不造假阴性)；确认不了只在「读到仍未发送
 *   且超长 deadline」才重发 (不刷屏)；ack 优先——主bot 在确认前 ack → acked 终态，对账绝不降级/重发它。
 *
 * 决策逻辑在此、可单测；真 IO (写 record / 查状态) 由 executors 注入。
 */
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import {
  listPendingCommands, listUnconfirmedCommands, claimCommandForDispatch, completeDispatch,
  supersedeCommand, getSubTask, getCommand,
  type OutboxCommand, type SubTask,
} from './subtask-store.js';

export interface DispatchExecutors {
  /** 写 record 触发自动化发送 (**非阻塞、不轮询**)。成功返 {ok:true, relayRecordId}；
   *  失败返 {ok:false, authError?, error}（别抛）。每次调用写一条新 record（首投 / 重发）。 */
  writeAndSend(cmd: OutboxCommand, task: SubTask): Promise<{ ok: boolean; relayRecordId?: string; authError?: boolean; error?: string }>;
  /** 查一次 record 状态 (**非阻塞、单次** record-get)。供 Phase B 对账。 */
  checkStatus(relayRecordId: string): Promise<'sent' | 'cancelled' | 'pending' | 'unknown' | 'auth_error'>;
}

/** 写不进 record 的投递最多重试几次。超过且仍无 record → failed。 */
export const MAX_RETRY = 5;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 600_000;
export const DISPATCH_LEASE_MS = 120_000;
/** 对账：未确认命令多久查一次状态 (复用 nextRetryAt 调度)。确认通常秒级，勤查无害。 */
export const RECONCILE_CHECK_INTERVAL_MS = 15_000;
/** 重发 deadline：record 写了但持续「已确认待发送」(自动化没发) 超过这么久 → 幂等重发。
 *  远大于自动化常态延迟 (分钟级)，避免不必要的重复发送。 */
export const RESEND_DEADLINE_MS = 5 * 60_000;
/** 重发次数上限：超了仍未发出 = 自动化疑似坏 → 停重发、保持 sent_unconfirmed + 告警 (不无限刷 record)。 */
export const MAX_RESEND = 5;

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
  if (cmd.direction === 'child_to_parent' && (task.status === 'finished' || task.status === 'stopped')) {
    return { action: 'skip', reason: `task-terminal-${task.status}` };
  }
  if (cmd.direction === 'parent_to_child' && cmd.commandType !== 'finish'
    && (task.status === 'finished' || task.status === 'stopped')) {
    return { action: 'skip', reason: `task-terminal-${task.status}` };
  }
  return { action: 'send' };
}

export interface DispatchStats {
  /** Phase B 确认到「已发送」(终态 sent)。 */
  sent: number;
  /** Phase A 写 record 成功 → 置 sent_unconfirmed (已入队，待确认)。 */
  written: number;
  /** Phase B 幂等重发次数 (写了但久未发出)。 */
  resent: number;
  retried: number; failed: number; skipped: number;
  /** 写不进 record (token 死 / base / 网络) → 「写入通道」健康告警信号 (鲁棒触发)。 */
  enqueueFailures: number;
  /** enqueueFailures / 确认阶段中被识别为「授权失效」的子集 → 仅给告警措辞，不作触发门禁。 */
  authErrors: number;
  /** record 已写但确认不到 (unknown/auth/重发耗尽) → 「确认环节」健康告警信号。
   *  连续 confirmFailures>0 且零 sent = 确认坏了 (如 2026-06-09 record-get 被改坏 6 天没人发现)。 */
  confirmFailures: number;
}

function emptyStats(): DispatchStats {
  return { sent: 0, written: 0, resent: 0, retried: 0, failed: 0, skipped: 0, enqueueFailures: 0, authErrors: 0, confirmFailures: 0 };
}

export async function runDispatcherTick(now: Date, exec: DispatchExecutors): Promise<DispatchStats> {
  const stats = emptyStats();
  await dispatchPending(now, exec, stats);     // Phase A：投递 pending → 写 record → sent_unconfirmed
  await reconcileUnconfirmed(now, exec, stats); // Phase B：对账 sent_unconfirmed → 确认/重发/告警
  return stats;
}

/** Phase A：投递 pending 命令——写 record 触发自动化，**立即置 sent_unconfirmed、不阻塞轮询**。 */
async function dispatchPending(now: Date, exec: DispatchExecutors, stats: DispatchStats): Promise<void> {
  for (const cmd of listPendingCommands(now)) {
    try {
      const task = getSubTask(cmd.taskId);
      const decision = planDispatch(cmd, task);
      if (decision.action === 'skip') {
        await supersedeCommand(cmd.cmdId, `dispatch-skip:${decision.reason}`);
        stats.skipped += 1;
        logger.info(`[outbox-dispatcher] skip cmd ${cmd.cmdId} (${cmd.commandType}): ${decision.reason}`);
        continue;
      }
      const attemptId = randomUUID();
      const claimed = await claimCommandForDispatch(cmd.cmdId, attemptId, DISPATCH_LEASE_MS, now);
      if (!claimed) { stats.skipped += 1; continue; }
      // TOCTOU：claim 后重读 task 复核
      const freshTask = getSubTask(cmd.taskId);
      const recheck = planDispatch(claimed, freshTask);
      if (recheck.action === 'skip') {
        await completeDispatch(cmd.cmdId, attemptId, { supersededBy: `dispatch-skip:${recheck.reason}` });
        stats.skipped += 1;
        logger.info(`[outbox-dispatcher] post-claim skip cmd ${cmd.cmdId} (${cmd.commandType}): ${recheck.reason}`);
        continue;
      }

      let res: { ok: boolean; relayRecordId?: string; authError?: boolean; error?: string };
      try {
        res = await exec.writeAndSend(claimed, freshTask!);
      } catch (err: any) {
        res = { ok: false, error: `writeAndSend threw: ${err?.message ?? err}` };
      }

      if (res.ok && res.relayRecordId) {
        // record 已写入 = 已入队 → 置 sent_unconfirmed，nextRetryAt 调度首次对账。
        const ok = await completeDispatch(cmd.cmdId, attemptId, {
          deliveryStatus: 'sent_unconfirmed', relayRecordId: res.relayRecordId,
          sentAt: now.toISOString(), retryCount: 0,
          nextRetryAt: new Date(now.getTime() + RECONCILE_CHECK_INTERVAL_MS).toISOString(), lastError: null,
        });
        if (ok) {
          stats.written += 1;
          logger.info(`[outbox-dispatcher] written cmd ${cmd.cmdId} (${cmd.commandType}) → sent_unconfirmed record=${res.relayRecordId.slice(0, 12)}`);
        } else { stats.skipped += 1; }
      } else {
        // 写不进 record = 真没投递 → 退避重试；authError 记一笔。无 record 且耗尽 → failed。
        if (res.authError) stats.authErrors += 1;
        stats.enqueueFailures += 1;
        const attempt = claimed.retryCount + 1;
        const giveUp = attempt >= MAX_RETRY;
        const patch = giveUp
          ? { deliveryStatus: 'failed' as const, retryCount: attempt, lastError: res.error ?? 'write failed' }
          : { retryCount: attempt, nextRetryAt: new Date(now.getTime() + planBackoff(attempt)).toISOString(), lastError: res.error ?? 'write failed' };
        const ok = await completeDispatch(cmd.cmdId, attemptId, patch);
        if (!ok) { stats.skipped += 1; continue; }
        if (giveUp) { stats.failed += 1; logger.warn(`[outbox-dispatcher] FAILED (no record) cmd ${cmd.cmdId} after ${attempt}: ${res.error}`); }
        else { stats.retried += 1; logger.info(`[outbox-dispatcher] retry write cmd ${cmd.cmdId} attempt ${attempt}, backoff ${planBackoff(attempt) / 1000}s`); }
      }
    } catch (err) {
      logger.warn(`[outbox-dispatcher] dispatch cmd ${cmd.cmdId} tick failed: ${err}`);
    }
  }
}

/** Phase B：对账 sent_unconfirmed 命令——查状态，四分处理。ack 优先：acked 终态绝不降级/重发。 */
async function reconcileUnconfirmed(now: Date, exec: DispatchExecutors, stats: DispatchStats): Promise<void> {
  for (const cmd of listUnconfirmedCommands(now)) {
    try {
      const attemptId = randomUUID();
      const claimed = await claimCommandForDispatch(cmd.cmdId, attemptId, DISPATCH_LEASE_MS, now);
      if (!claimed) { continue; } // 别的进程在对账 / 已被 ack 等

      // ack 优先 (蔻黛 P1.3)：claim 后重读——若已被主bot ack (或不再 sent_unconfirmed)，绝不降级/重发，仅清 lease。
      const fresh = getCommand(cmd.cmdId);
      if (!fresh || fresh.deliveryStatus !== 'sent_unconfirmed') {
        await completeDispatch(cmd.cmdId, attemptId, {}); // 清 lease，不动状态 (acked-guard 也兜底)
        continue;
      }
      if (!fresh.relayRecordId) {
        // 异常：sent_unconfirmed 却无 record → 回 pending 重投。
        await completeDispatch(cmd.cmdId, attemptId, { deliveryStatus: 'pending', nextRetryAt: now.toISOString() });
        continue;
      }

      let status: 'sent' | 'cancelled' | 'pending' | 'unknown' | 'auth_error';
      try {
        status = await exec.checkStatus(fresh.relayRecordId);
      } catch (err: any) {
        logger.warn(`[outbox-dispatcher] checkStatus threw cmd ${cmd.cmdId}: ${err?.message ?? err}`);
        status = 'unknown';
      }
      const reCheckAt = new Date(now.getTime() + RECONCILE_CHECK_INTERVAL_MS).toISOString();

      if (status === 'sent') {
        await completeDispatch(cmd.cmdId, attemptId, {
          deliveryStatus: 'sent', deliveredMessageId: fresh.relayRecordId,
          sentAt: fresh.sentAt ?? now.toISOString(), nextRetryAt: null, lastError: null,
        });
        stats.sent += 1;
        logger.info(`[outbox-dispatcher] confirmed sent cmd ${cmd.cmdId} (${cmd.commandType})`);
      } else if (status === 'cancelled') {
        await completeDispatch(cmd.cmdId, attemptId, { deliveryStatus: 'failed', nextRetryAt: null, lastError: 'relay record cancelled (not sent)' });
        stats.failed += 1;
        logger.warn(`[outbox-dispatcher] CANCELLED cmd ${cmd.cmdId} (${cmd.commandType}) → terminal`);
      } else if (status === 'pending') {
        // 仍「已确认待发送」：自动化还没发。超 deadline 且没超重发上限 → 幂等重发；否则继续等。
        const ageMs = fresh.sentAt ? now.getTime() - new Date(fresh.sentAt).getTime() : 0;
        const resendCount = fresh.retryCount; // 复用 retryCount 当重发计数
        // 蔻黛 P1：ack 可能落在 checkStatus 期间（之前的重读之后）→ **重发前再读一次**，
        // 若已 ack/superseded/状态或 record 变化 → 放弃重发、仅清 lease，避免 ack 后再写新 record。
        // 残留窗口（ack 正落在下面 writeAndSend 的外部 IO 中）只会多一次幂等无害唤醒，符合 at-least-once。
        const before = getCommand(cmd.cmdId);
        const resendable = before != null && before.deliveryStatus === 'sent_unconfirmed'
          && before.supersededBy == null && before.relayRecordId === fresh.relayRecordId;
        if (!resendable) {
          // 蔻黛 P2 cleanup：重读发现已 acked/superseded → 不重发、且**只清 lease**，
          // 绝不给终态命令写调度字段 (nextRetryAt)，与「仅清 lease」语义一致。
          await completeDispatch(cmd.cmdId, attemptId, {});
        } else if (ageMs > RESEND_DEADLINE_MS && resendCount < MAX_RESEND) {
          const task = getSubTask(fresh.taskId);
          let rs: { ok: boolean; relayRecordId?: string; authError?: boolean; error?: string };
          try { rs = task ? await exec.writeAndSend(fresh, task) : { ok: false, error: 'task gone' }; }
          catch (err: any) { rs = { ok: false, error: `resend threw: ${err?.message ?? err}` }; }
          if (rs.ok && rs.relayRecordId) {
            // 蔻黛 P1（写后再读）：ack 可能恰落在上面 writeAndSend 的 IO 中 → 写完后**再读一次**，
            // 只有仍是 sent_unconfirmed 才回写重发元数据；若期间已 acked/superseded → **绝不污染终态**，
            // 仅清 lease。那条已写出的 record 至多产生一次幂等无害唤醒（无丢失、无状态错乱）。
            const after = getCommand(cmd.cmdId);
            if (after && after.deliveryStatus === 'sent_unconfirmed' && after.supersededBy == null) {
              await completeDispatch(cmd.cmdId, attemptId, {
                relayRecordId: rs.relayRecordId, sentAt: now.toISOString(),
                retryCount: resendCount + 1, nextRetryAt: reCheckAt, lastError: null,
              });
              stats.resent += 1;
              logger.warn(`[outbox-dispatcher] RESEND cmd ${cmd.cmdId} (${cmd.commandType}) #${resendCount + 1} (record stuck >${RESEND_DEADLINE_MS / 60000}min)`);
            } else {
              await completeDispatch(cmd.cmdId, attemptId, {}); // 仅清 lease，不动终态
              logger.warn(`[outbox-dispatcher] resend cmd ${cmd.cmdId}写后发现已 ${after?.deliveryStatus ?? 'gone'} → 不污染终态 (残留 record 仅一次幂等唤醒)`);
            }
          } else {
            // 重发也写不进 → 保持 sent_unconfirmed、继续等 (老 record 仍在)。
            if (rs.authError) stats.authErrors += 1;
            await completeDispatch(cmd.cmdId, attemptId, { nextRetryAt: reCheckAt, lastError: rs.error ?? 'resend write failed' });
          }
        } else {
          // resendable 但「还没到 deadline」或「重发耗尽」→ 继续等。重发耗尽且仍 sent_unconfirmed = 确认问题 → 告警。
          if (resendCount >= MAX_RESEND) stats.confirmFailures += 1;
          await completeDispatch(cmd.cmdId, attemptId, { nextRetryAt: reCheckAt });
        }
      } else {
        // unknown / auth_error：读不到状态，**绝不重发**。confirmFailures → 确认健康告警；继续等。
        stats.confirmFailures += 1;
        if (status === 'auth_error') stats.authErrors += 1;
        await completeDispatch(cmd.cmdId, attemptId, { nextRetryAt: reCheckAt, lastError: `confirm read ${status}` });
        logger.warn(`[outbox-dispatcher] confirm ${status} cmd ${cmd.cmdId} (${cmd.commandType}) → keep waiting, no resend`);
      }
    } catch (err) {
      logger.warn(`[outbox-dispatcher] reconcile cmd ${cmd.cmdId} tick failed: ${err}`);
    }
  }
}
