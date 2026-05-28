/**
 * 子群任务流程 P2 (2026-05-29): 缇蕾盯群 watch loop.
 *
 * 缇蕾 daemon 周期跑 runWatchTick: 对每个到期 (距上次扫 ≥ urgency 间隔) 的
 * active watch, 读群最近消息 → LLM 判 4 态 → 更新状态 → 后 3 态升级 claude 主体。
 *
 * 4 态:
 *   - in_progress: 群在正常推进 → 不升级, 继续盯 (重置 noProgress 计数)
 *   - done:        验收标准满足 → 升级"完成", stopWatch
 *   - stuck:       连续 N 次无实质进展 / 分身明说卡住 → 升级"卡死", stopWatch
 *   - need_owner:  碰到只有松松能拍的决策 → 升级"需决策", stopWatch
 *
 * 纯编排, IO (fetch 群消息 / LLM 判 / 升级发消息) 由 executor 注入, 方便测。
 */
import { logger } from '../utils/logger.js';
import {
  listActiveWatches, updateWatch, stopWatch,
  POLL_INTERVAL_MS, NO_PROGRESS_THRESHOLD,
  type SubgroupWatch,
} from './subgroup-watch-store.js';

export type ProgressState = 'in_progress' | 'done' | 'stuck' | 'need_owner';

export interface JudgeResult {
  state: ProgressState;
  /** 一句话理由, 进升级消息给 claude 主体看 */
  reason: string;
  /** 这轮群里最后一条消息 id, 用来更新 lastSeenMessageId (粗判下轮有没有新进展) */
  lastMessageId: string | null;
  /** 群里相对 lastSeenMessageId 有没有新消息 (executor 算好传回, watcher 据此判"无进展") */
  hasNewMessages: boolean;
}

export interface WatcherExecutors {
  /** 读群 + LLM 判 4 态。watcher 传 watch (含 lastSeenMessageId), executor 拉
   *  该群消息、给 coco 判、返结果。 */
  judgeProgress(watch: SubgroupWatch): Promise<JudgeResult>;
  /** 升级 claude 主体 (发主话题 @claude)。state 已是 done/stuck/need_owner 之一。 */
  escalateToClaude(watch: SubgroupWatch, result: JudgeResult): Promise<void>;
}

export interface WatchTickResult {
  checked: number;       // 本 tick 实际扫了几个 (到期的)
  skippedNotDue: number; // 未到间隔跳过
  inProgress: number;
  escalatedDone: number;
  escalatedStuck: number;
  escalatedDecision: number;
  errors: number;
}

function isDue(watch: SubgroupWatch, now: Date): boolean {
  if (!watch.lastCheckedAt) return true;     // 没扫过, 立刻扫
  const elapsed = now.getTime() - new Date(watch.lastCheckedAt).getTime();
  return elapsed >= POLL_INTERVAL_MS[watch.urgency];
}

export async function runWatchTick(opts: {
  now?: Date;
  executors: WatcherExecutors;
}): Promise<WatchTickResult> {
  const now = opts.now ?? new Date();
  const stats: WatchTickResult = {
    checked: 0, skippedNotDue: 0, inProgress: 0,
    escalatedDone: 0, escalatedStuck: 0, escalatedDecision: 0, errors: 0,
  };
  const active = listActiveWatches();

  for (const watch of active) {
    if (!isDue(watch, now)) { stats.skippedNotDue++; continue; }
    stats.checked++;
    try {
      const result = await opts.executors.judgeProgress(watch);

      // 先按"有没有新消息"维护 noProgress 计数 (粗判, LLM state 是细判)
      const nextNoProgress = result.hasNewMessages ? 0 : watch.noProgressCount + 1;

      // LLM 直接判 done / need_owner → 立刻升级 (不看计数)
      if (result.state === 'done') {
        await opts.executors.escalateToClaude(watch, result);
        stopWatch(watch.chatId, 'escalated_done', result.reason);
        stats.escalatedDone++;
        continue;
      }
      if (result.state === 'need_owner') {
        await opts.executors.escalateToClaude(watch, result);
        stopWatch(watch.chatId, 'escalated_decision', result.reason);
        stats.escalatedDecision++;
        continue;
      }

      // LLM 判 stuck, 或"连续无进展"到阈值 → 升级卡死
      const threshold = NO_PROGRESS_THRESHOLD[watch.urgency];
      const stuckByCount = nextNoProgress >= threshold;
      if (result.state === 'stuck' || stuckByCount) {
        const reason = result.state === 'stuck'
          ? result.reason
          : `连续 ${nextNoProgress} 次扫描无实质进展 (${watch.urgency} 阈值 ${threshold}); LLM: ${result.reason}`;
        await opts.executors.escalateToClaude(watch, { ...result, state: 'stuck', reason });
        stopWatch(watch.chatId, 'escalated_stuck', reason);
        stats.escalatedStuck++;
        continue;
      }

      // in_progress: 继续盯, 更新计数 + lastSeen + lastChecked
      updateWatch(watch.chatId, {
        lastCheckedAt: now.toISOString(),
        noProgressCount: nextNoProgress,
        lastSeenMessageId: result.lastMessageId ?? watch.lastSeenMessageId,
      });
      stats.inProgress++;
    } catch (err: any) {
      logger.error(`[subgroup-watcher] judge/escalate failed for chat=${watch.chatId.slice(0, 12)}: ${err?.message ?? err}`);
      // 失败也更新 lastCheckedAt, 避免同一 tick 卡死循环 (但不动 noProgress, 下轮重判)
      updateWatch(watch.chatId, { lastCheckedAt: now.toISOString() });
      stats.errors++;
    }
  }

  return stats;
}
