// 任务小组 · 观测 cron 逻辑（v3.1 §3.1 observer-tick / §7 默认廉价）——
// 复制 subtask-observer 范式：cron 唤醒后先做无 LLM 廉价 gate（cursor vs 子群新位点），无新动静直接 return（零模型调用）；
// 有动静才调注入的 detect（这层才可能费引擎，由 executor 决定绑哪个便宜 bot）判读出 TeamEvent，喂引擎驱动下一步。
// detect 是注入边界（IO/可能费模型），tick 编排与廉价 gate 纯逻辑可单测。

import { applyTeamEvent } from './taskteam-runtime.js';
import type { TaskTeamRuntimeDeps } from './taskteam-runtime.js';
import type { TeamEvent } from './taskteam-engine.js';
import type { TaskTeamId, TaskTeamInstance, TaskTeamType } from './taskteam-schema.js';
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
  /** 阶段2 计时触发器：按 instance 解析其 TaskTeamType，取 policy.escalateAfterStallMs 做停滞 gate。不设则不产 stall。 */
  resolveType?(instance: TaskTeamInstance): TaskTeamType | undefined;
}

export interface TaskTeamObserverStats {
  scanned: number;
  gatedOut: number; // 廉价 gate 命中、零模型调用
  detected: number; // 调了 detect 的次数
  events: number; // 应用的 TeamEvent 数
  stalls: number; // 阶段2：clock/gate 到点产出的 stall 事件数
  errors: number;
}

/**
 * 停滞触发器（阶段2 §2.1，复活 escalateAfterStallMs）——**由 clock/cheap gate 产出，不靠 LLM 判「长时间」**。
 * 规则：type.policy.escalateAfterStallMs 配了正数，且自**上次观测到真实新活动**（team.lastObservedActivityAt，
 * 缺省回退 updatedAt）已超过该阈值 → 产 stall 事件。
 * 来源 id（约束1）：window/episode id = `stall:<teamId>:<停滞锚时间戳>`，**绝不退回 round**。
 * reviewer Medium 修订：锚改用 **lastObservedActivityAt**（只在 cursor 推进=真实新消息时重置，普通状态写入不刷新），
 * 而非 updatedAt——故 stall rule 自带 transition 写状态刷新 updatedAt 也不会移动锚 → sourceEventId 稳定 →
 * 幂等 key 稳定 → outbox 去重，停滞窗内只升级一次；真实活动恢复后锚推进 → 新窗 → 新 sourceEventId，不撞上一窗。
 * 状态门由引擎规则（when.status）把关，本函数只负责「到点产事件」。
 */
export function maybeStallEvent(
  now: Date,
  team: TaskTeamInstance,
  type: TaskTeamType | undefined,
): TeamEvent | null {
  const ms = type?.policy?.escalateAfterStallMs;
  if (!ms || ms <= 0) return null; // 未配置停滞阈值 → 不产（向后兼容）
  const anchor = team.lastObservedActivityAt ?? team.updatedAt; // 停滞窗口锚（缺省回退 updatedAt）
  const ref = Date.parse(anchor);
  if (!Number.isFinite(ref)) return null;
  if (now.getTime() - ref < ms) return null; // 未到停滞阈值
  return { type: 'stall', sourceEventId: `stall:${team.teamId}:${ref}` };
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
  const stats: TaskTeamObserverStats = { scanned: 0, gatedOut: 0, detected: 0, events: 0, stalls: 0, errors: 0 };
  for (const team of deps.listActiveTeams()) {
    stats.scanned += 1;
    try {
      const cursor = team.cursor ?? null;
      const observedChatId = observedChatIdForTaskTeam(team);
      // 廉价 gate：无新动静 → 直接跳过，零模型调用（等价"事件触发休眠"）
      const peeked = await exec.peek(observedChatId, cursor);
      if (!peeked.hasNew) {
        stats.gatedOut += 1;
        // 阶段2 停滞触发器：无新动静时由 clock/gate 判是否到 escalateAfterStallMs 阈值，到点产 stall（非 LLM）。
        const stallEvent = maybeStallEvent(now, team, deps.resolveType?.(team));
        if (stallEvent) {
          await applyTeamEvent(deps, team.teamId, stallEvent);
          stats.events += 1;
          stats.stalls += 1;
        }
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
