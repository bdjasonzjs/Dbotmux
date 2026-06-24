/**
 * 停滞节流 · 纯函数公共 util（2026-06-24 二期抽出）。
 *
 * 把 subtask-observer 里那套「停滞窗口锚点 + 冷却 + 同窗口最多催 N 次」的<b>纯算法</b>抽出来，
 * 让子任务 observer 和「任意群推动(drive)」共用同一份真理。**只抽纯函数、不碰任何状态机**：
 * 入参全是原始时间戳/数字，不依赖 SubTask / DriveState 任何具体类型。
 *
 * 算法（与 subtask-observer 既有行为字节一致）：
 *   - episodeAnchorMs = max(实质活动, 最近发起动作, 建群) 的毫秒；全脏 = NaN。
 *   - 有效催次数：上次催早于 anchor（= 新窗口已开）→ 视作 0，否则用累计 nudgeCount。
 *   - planStall：anchor 脏 → none；距 max(anchor, 上次催) 未超 stallMs → none（没卡够久）；
 *     本窗口有效催次数 ≥ maxNudges → 'capped'（催够了，停手）；否则 'nudge'。
 *
 * 注：subtask-observer 把"催够了"映射成 escalate(升级父群)；任意群没有父群，drive 把 'capped'
 * 直接当"停手别催"。故这里用中性的 'capped'，调用方各自解读。
 */

export type StallDecision = { kind: 'none' } | { kind: 'nudge' } | { kind: 'capped' };

/** episode 锚点（毫秒）= max{实质活动, 最近发起动作, 建群}；都脏 → NaN。 */
export function episodeAnchorMs(times: {
  activityAt?: string | null;
  initiatingAt?: string | null;
  createdAt?: string | null;
}): number {
  const ms = [times.activityAt, times.initiatingAt, times.createdAt]
    .filter((s): s is string => !!s)
    .map(s => new Date(s).getTime())
    .filter(Number.isFinite);
  return ms.length ? Math.max(...ms) : NaN;
}

/** 当前 episode 的有效催次数：上次催早于 anchor（新 episode 已开）→ 0，否则用累计值。 */
export function effectiveNudgeCount(lastNudgeAt: string | null | undefined, nudgeCount: number, anchorMs: number): number {
  const lastNudgeMs = lastNudgeAt ? new Date(lastNudgeAt).getTime() : 0;
  const sameEpisode = Number.isFinite(lastNudgeMs) && lastNudgeMs >= anchorMs;
  return sameEpisode ? (nudgeCount ?? 0) : 0;
}

/** 纯决策：卡够久了吗 / 本窗口还能不能催。 */
export function planStall(params: {
  anchorMs: number;
  lastNudgeAt: string | null | undefined;
  nudgeCount: number;
  now: Date;
  stallMs: number;
  maxNudges: number;
}): StallDecision {
  if (!Number.isFinite(params.anchorMs)) return { kind: 'none' };
  const lastNudgeMs = params.lastNudgeAt ? new Date(params.lastNudgeAt).getTime() : 0;
  const sinceMs = Math.max(params.anchorMs, Number.isFinite(lastNudgeMs) ? lastNudgeMs : 0);
  if (params.now.getTime() - sinceMs <= params.stallMs) return { kind: 'none' };
  if (effectiveNudgeCount(params.lastNudgeAt, params.nudgeCount, params.anchorMs) >= params.maxNudges) {
    return { kind: 'capped' };
  }
  return { kind: 'nudge' };
}
