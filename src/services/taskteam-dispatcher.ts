// 任务小组 · 投递 cron 逻辑（v3.1 §3.1 dispatcher-tick，B3 闭环）——
// 从 taskteam-outbox claim（lease 防并发）→ 发飞书 → 写 sent（带 message_id）→ 失败退避重试 → 达上限落 failed。
// 与 subtask 的 outbox-dispatcher 完全隔离：独立 store、独立 lease、独立 cron、独立重试预算。
// 投递发送本身经注入的 executor（IO 边界），tick 编排纯逻辑可单测。

import {
  claimTaskTeamAction,
  completeTaskTeamAction,
  listPendingTaskTeamActions,
  releaseTaskTeamActionForRetry,
} from './taskteam-outbox-store.js';
import type { TaskTeamAction, TaskTeamId } from './taskteam-schema.js';

export interface TaskTeamSendResult {
  ok: boolean;
  messageId?: string | null;
  error?: string;
  retriable?: boolean; // 默认 true；权限/格式类不可重试错误置 false 直接落 failed
}

export interface TaskTeamDispatchExecutors {
  send(action: TaskTeamAction): Promise<TaskTeamSendResult>;
  // 半提交守卫（批3 P1）：返回 action 所属 team 的当前版本；null=team 不存在。
  // team.version < action.expectedTeamVersion → 状态尚未提交 → 暂不投递。
  teamVersion(teamId: TaskTeamId): number | null;
}

export interface TaskTeamDispatchStats {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  skipped: number;
  leaseLost: number; // P2：claim 后回写时 CAS 被拒（lease 已被他人重领）——不计入 sent/retried/failed
  held: number; // P1：状态未提交（半提交）→ 本 tick 暂不投递
}

export interface TaskTeamDispatchConfig {
  leaseMs: number;
  maxRetry: number;
  baseBackoffMs: number;
  concurrency: number;
}

export const DEFAULT_DISPATCH_CONFIG: TaskTeamDispatchConfig = {
  leaseMs: 60_000,
  maxRetry: 5,
  baseBackoffMs: 10_000,
  concurrency: 4,
};

export async function runTaskTeamDispatcherTick(
  now: Date,
  exec: TaskTeamDispatchExecutors,
  config: TaskTeamDispatchConfig = DEFAULT_DISPATCH_CONFIG,
): Promise<TaskTeamDispatchStats> {
  const stats: TaskTeamDispatchStats = { claimed: 0, sent: 0, retried: 0, failed: 0, skipped: 0, leaseLost: 0, held: 0 };
  // 半提交守卫：状态跃迁尚未提交（team.version < expectedTeamVersion）的命令本 tick 不投递（held）
  const pending = listPendingTaskTeamActions(now).filter(action => {
    if (action.expectedTeamVersion == null) return true;
    const version = exec.teamVersion(action.teamId);
    if (version == null || version < action.expectedTeamVersion) {
      stats.held += 1;
      return false;
    }
    return true;
  });
  if (pending.length === 0) return stats;

  // 有界并发 lane（仿 subtask outbox-dispatcher），claim 的乐观锁保证同一 action 不被两 lane 同时拿
  let cursor = 0;
  const lane = async (): Promise<void> => {
    while (cursor < pending.length) {
      const action = pending[cursor++];
      await dispatchOne(action, exec, config, stats);
    }
  };
  const lanes = Math.min(config.concurrency, pending.length);
  await Promise.all(Array.from({ length: lanes }, () => lane()));
  return stats;
}

async function dispatchOne(
  action: TaskTeamAction,
  exec: TaskTeamDispatchExecutors,
  config: TaskTeamDispatchConfig,
  stats: TaskTeamDispatchStats,
): Promise<void> {
  const claimed = await claimTaskTeamAction(action.actionId, config.leaseMs);
  if (!claimed || !claimed.dispatchAttemptId) {
    stats.skipped += 1; // 已被他人 claim / 退避未到 / 非 pending
    return;
  }
  stats.claimed += 1;
  const attemptId = claimed.dispatchAttemptId;

  let res: TaskTeamSendResult;
  try {
    res = await exec.send(claimed);
  } catch (err) {
    res = { ok: false, error: String(err), retriable: true };
  }

  if (res.ok) {
    // ack 边界 = 飞书发送成功（拿到 message_id）（P2-1）；CAS 凭 attemptId 防迟到覆盖。
    // P2：检查回写结果——null = lease 已被他人重领，本次回写被 CAS 拒，不能误报为 sent。
    const done = await completeTaskTeamAction(claimed.actionId, {
      status: 'sent',
      deliveredMessageId: res.messageId ?? null,
      dispatchAttemptId: attemptId,
    });
    if (done) stats.sent += 1;
    else stats.leaseLost += 1;
    return;
  }

  if (res.retriable !== false && claimed.retryCount < config.maxRetry) {
    const backoffMs = config.baseBackoffMs * 2 ** claimed.retryCount; // 指数退避
    const released = await releaseTaskTeamActionForRetry(claimed.actionId, {
      dispatchAttemptId: attemptId,
      lastError: res.error ?? 'send failed',
      backoffMs,
    });
    // 仅当确实由本 attempt 释放（回 pending 且 retryCount+1）才计 retried；否则 lease 已被重领
    if (released && released.status === 'pending' && released.retryCount > claimed.retryCount) stats.retried += 1;
    else stats.leaseLost += 1;
  } else {
    const done = await completeTaskTeamAction(claimed.actionId, {
      status: 'failed',
      lastError: res.error ?? 'send failed',
      dispatchAttemptId: attemptId,
    });
    if (done) stats.failed += 1;
    else stats.leaseLost += 1;
  }
}
