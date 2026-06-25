// 任务小组 · 观测 cron 逻辑（v3.1 §3.1 observer-tick / §7 默认廉价）——
// 复制 subtask-observer 范式：cron 唤醒后先做无 LLM 廉价 gate（cursor vs 子群新位点），无新动静直接 return（零模型调用）；
// 有动静才调注入的 detect（这层才可能费引擎，由 executor 决定绑哪个便宜 bot）判读出 TeamEvent，喂引擎驱动下一步。
// detect 是注入边界（IO/可能费模型），tick 编排与廉价 gate 纯逻辑可单测。

import { applyTeamEvent } from './taskteam-runtime.js';
import type { TaskTeamRuntimeDeps } from './taskteam-runtime.js';
import type { TeamEvent } from './taskteam-engine.js';
import type { TaskTeamId, TaskTeamInstance } from './taskteam-schema.js';
import { logger } from '../utils/logger.js';

/** detect 判读结果：判读出的 TeamEvent[] + 推进到的 cursor（detect 实际读到的最后一条边界）。 */
export interface TaskTeamDetectResult {
  events: TeamEvent[];
  cursor: string | null;
}

/**
 * cursor 永久失效（cursor 消息被删 / 翻到群尾仍找不到）——重试无用。
 * detect 抛此错 → tick 跳到最新位点避免永久卡死（区别于瞬时失败的"持 cursor 重试"）。
 */
export class TaskTeamCursorInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskTeamCursorInvalidError';
  }
}

export interface TaskTeamObserverExecutors {
  // 廉价 gate（无 LLM）：自 cursor 以来子群是否有新动静 + 最新位点
  peek(chatId: string, cursor: string | null): Promise<{ hasNew: boolean; cursor: string | null }>;
  // 仅在有新动静时调：判读出 TeamEvent[] + 已读边界 cursor。可能费模型，executor 决定引擎/成本。
  // 瞬时失败（IO/LLM/parse）→ 抛错（tick 持 cursor 重试）；cursor 失效 → 抛 TaskTeamCursorInvalidError。
  detect(instance: TaskTeamInstance, cursor: string | null): Promise<TaskTeamDetectResult>;
}

export interface TaskTeamObserverDeps extends TaskTeamRuntimeDeps {
  listActiveTeams(): TaskTeamInstance[];
  advanceCursor(teamId: TaskTeamId, cursor: string): Promise<void>;
}

export interface TaskTeamObserverStats {
  scanned: number;
  gatedOut: number; // 廉价 gate 命中、零模型调用
  detected: number; // 调了 detect 的次数
  events: number; // 应用的 TeamEvent 数
  errors: number;
}

export function observedChatIdForTaskTeam(team: Pick<TaskTeamInstance, 'chatId' | 'targetExternalChatId'>): string {
  const external = team.targetExternalChatId?.trim();
  return external || team.chatId;
}

export async function runTaskTeamObserverTick(
  now: Date,
  deps: TaskTeamObserverDeps,
  exec: TaskTeamObserverExecutors,
): Promise<TaskTeamObserverStats> {
  const stats: TaskTeamObserverStats = { scanned: 0, gatedOut: 0, detected: 0, events: 0, errors: 0 };
  void now; // 预留：将来按 cursor 时间窗 / 节流；当前廉价 gate 由 peek 决定
  for (const team of deps.listActiveTeams()) {
    stats.scanned += 1;
    try {
      const cursor = team.cursor ?? null;
      const observedChatId = observedChatIdForTaskTeam(team);
      // 廉价 gate：无新动静 → 直接跳过，零模型调用（等价"事件触发休眠"）
      const peeked = await exec.peek(observedChatId, cursor);
      if (!peeked.hasNew) {
        stats.gatedOut += 1;
        continue;
      }
      stats.detected += 1;

      let result;
      try {
        result = await exec.detect(team, cursor);
      } catch (err) {
        if (err instanceof TaskTeamCursorInvalidError) {
          // cursor 失效（消息被删 / 翻到群尾找不到）：重试无用 → 跳到最新位点，避免永久卡死。
          if (peeked.cursor && peeked.cursor !== cursor) {
            await deps.advanceCursor(team.teamId, peeked.cursor);
          }
          stats.errors += 1;
          logger.warn(`[taskteam-observer] tick ${team.teamId} cursor invalid, skipped to latest: ${err}`);
          continue;
        }
        // 瞬时失败（IO / LLM / parse）：不推进 cursor，下轮重读重试（不丢消息窗口）。
        throw err;
      }

      for (const ev of result.events) {
        await applyTeamEvent(deps, team.teamId, ev);
        stats.events += 1;
      }
      // 推进 cursor 到 detect **实际读到的边界**（非 peek 最新）——busy 群 >FETCH_LIMIT 时多 tick 渐进 drain，不跳窗。
      if (result.cursor && result.cursor !== cursor) {
        await deps.advanceCursor(team.teamId, result.cursor);
      }
    } catch (err) {
      stats.errors += 1;
      logger.warn(`[taskteam-observer] tick ${team.teamId} failed (cursor held for retry): ${err}`);
    }
  }
  return stats;
}
