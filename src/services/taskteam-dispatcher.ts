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
import type { TaskTeamAction } from './taskteam-schema.js';

export interface TaskTeamSendResult {
  ok: boolean;
  messageId?: string | null;
  error?: string;
  retriable?: boolean; // 默认 true；权限/格式类不可重试错误置 false 直接落 failed
}

export interface TaskTeamDispatchExecutors {
  send(action: TaskTeamAction): Promise<TaskTeamSendResult>;
}

export interface TaskTeamDispatchStats {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  skipped: number;
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
  const stats: TaskTeamDispatchStats = { claimed: 0, sent: 0, retried: 0, failed: 0, skipped: 0 };
  const pending = listPendingTaskTeamActions(now);
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
    // ack 边界 = 飞书发送成功（拿到 message_id）（P2-1）；CAS 凭 attemptId 防迟到覆盖
    await completeTaskTeamAction(claimed.actionId, {
      status: 'sent',
      deliveredMessageId: res.messageId ?? null,
      dispatchAttemptId: attemptId,
    });
    stats.sent += 1;
    return;
  }

  if (res.retriable !== false && claimed.retryCount < config.maxRetry) {
    const backoffMs = config.baseBackoffMs * 2 ** claimed.retryCount; // 指数退避
    await releaseTaskTeamActionForRetry(claimed.actionId, {
      dispatchAttemptId: attemptId,
      lastError: res.error ?? 'send failed',
      backoffMs,
    });
    stats.retried += 1;
  } else {
    await completeTaskTeamAction(claimed.actionId, {
      status: 'failed',
      lastError: res.error ?? 'send failed',
      dispatchAttemptId: attemptId,
    });
    stats.failed += 1;
  }
}
