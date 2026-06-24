/**
 * 给任意群挂 observer · 二期「推动」决策逻辑 + tick。
 *
 * 对每个 drive=on（带目标）的群：缇蕾盯群里进展，**卡住了就在群里发一句目标导向的催促**。
 * 这是 group-monitor「只读」之外松松显式要的「在被盯群发言」能力。
 *
 * 防刷屏四道闸（observer/scout 上踩过 respam，重犯不得）：
 *   ① 实质活动判定防自激：只有真人/他方 bot 说话才算"群动了"；**缇蕾自己的催促一律不算**
 *      （否则把自己催的当新进展自激刷屏）。靠 driveSpeakerId 过滤。
 *   ② 停滞节流：复用 stall-throttle 纯函数——卡够久才催；同一停滞窗口最多催 N 次（capped→停手，
 *      不无限催）；群里有人动了 → 开新窗口、次数归零。
 *   ③ 变化检测：催促文本归一化签名，跟上次一样 → **不重复说同样的话**。
 *   ④ 每群每日催次数上限：预算耗尽 → **只记录不发**。
 *
 * 决策逻辑在此、可单测；IO（拉消息带 senderId/时间、judge、群内发言）由 executors 注入。
 */
import { logger } from '../utils/logger.js';
import { listPolicies, getDriveConfig } from './chat-policy-store.js';
import {
  getOrInitDriveState, saveDriveState, budgetRemaining, dateKeyOf, type DriveState,
} from './drive-store.js';
import { episodeAnchorMs, planStall } from './stall-throttle.js';

/** 卡多久才考虑催（默认 30min；推动是讨论/开发群，催太勤很烦）。 */
export const DRIVE_STALL_MS = 30 * 60_000;
/** 同一停滞窗口最多催几次。 */
export const DRIVE_MAX_NUDGES = 3;
/** judge 冷却：卡住时也别每 tick 都喊 LLM，最短判断间隔（省钱）。 */
export const DRIVE_JUDGE_COOLDOWN_MS = 15 * 60_000;

export interface FetchedMsg {
  id: string;
  senderId: string;
  createTimeMs: number;
  rendered: string;
}

export interface DriveJudgeResult {
  /** 对照目标，现在该不该催。 */
  shouldNudge: boolean;
  /** 要催就给一句奔着目标的具体话（引用目标 + 当前卡点）。 */
  nudgeText: string;
}

export interface DriveExecutors {
  /** 拉群最近消息（newest first），带 senderId + 时间。 */
  fetchMessages(chatId: string, limit: number): Promise<FetchedMsg[]>;
  /** 缇蕾对照 goal 判断该不该催 + 催什么；判不出返 null（当作不催）。 */
  judge(goal: string, renderedNewMessages: string): Promise<DriveJudgeResult | null>;
  /** 缇蕾在**被盯群**里发一句催促，返是否发成功。 */
  speak(chatId: string, text: string): Promise<boolean>;
  /** 推动发言者（缇蕾）的 senderId —— 用于①防自激过滤。 */
  driveSpeakerId: string;
}

/** 催促文本归一化签名（变化检测，不重复说同样的话）。 */
export function nudgeSignature(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\s\x00-\x1F\x7F]+/g, '').replace(/[。，、,.!！?？;；:：]/g, '').toLowerCase().slice(0, 80);
}

export interface DriveTickResult { checked: number; nudged: number; stalledButQuiet: number; droppedBudget: number; suppressedRepeat: number; }

export async function runDriveTick(
  now: Date,
  exec: DriveExecutors,
  opts: { stallMs?: number; maxNudges?: number; judgeCooldownMs?: number; maxPerDay?: number } = {},
): Promise<DriveTickResult> {
  const stallMs = opts.stallMs ?? DRIVE_STALL_MS;
  const maxNudges = opts.maxNudges ?? DRIVE_MAX_NUDGES;
  const judgeCooldownMs = opts.judgeCooldownMs ?? DRIVE_JUDGE_COOLDOWN_MS;
  const res: DriveTickResult = { checked: 0, nudged: 0, stalledButQuiet: 0, droppedBudget: 0, suppressedRepeat: 0 };

  for (const p of listPolicies()) {
    const drive = getDriveConfig(p.chatId);
    if (!drive.enabled || !drive.goal) continue;
    res.checked += 1;
    try {
      await tickOne(p.chatId, drive.goal, now, exec, { stallMs, maxNudges, judgeCooldownMs, maxPerDay: opts.maxPerDay }, res);
    } catch (err) {
      logger.warn(`[drive] tick chat=${p.chatId.slice(0, 12)} failed: ${err}`);
    }
  }
  return res;
}

async function tickOne(
  chatId: string, goal: string, now: Date, exec: DriveExecutors,
  cfg: { stallMs: number; maxNudges: number; judgeCooldownMs: number; maxPerDay?: number },
  res: DriveTickResult,
): Promise<void> {
  const msgs = await exec.fetchMessages(chatId, 30);
  let state = getOrInitDriveState(chatId, now);

  // ① 实质活动判定（防自激）：只认非缇蕾的最新消息时间。
  const substantive = msgs.filter(m => m.senderId && m.senderId !== exec.driveSpeakerId);
  const newestActMs = substantive.length ? Math.max(...substantive.map(m => m.createTimeMs)) : 0;
  const prevActMs = state.lastSubstantiveActivityAt ? new Date(state.lastSubstantiveActivityAt).getTime() : 0;
  if (newestActMs > prevActMs) {
    // 群里有人动了 → 更新活动时间 + **开新停滞窗口、催次数归零**（别催命）。
    state = {
      ...state,
      lastSubstantiveActivityAt: new Date(newestActMs).toISOString(),
      episodeAnchorAt: new Date(newestActMs).toISOString(),
      nudgeCount: 0,
      lastNudgeSignature: null,
    };
    saveDriveState(state);
  }
  if (!state.lastSubstantiveActivityAt) return; // 还没观测到任何实质活动 → 没基线，先不催

  // ② 停滞节流（复用纯函数）。
  const anchorMs = episodeAnchorMs({ activityAt: state.lastSubstantiveActivityAt, initiatingAt: state.episodeAnchorAt, createdAt: state.lastSubstantiveActivityAt });
  const decision = planStall({ anchorMs, lastNudgeAt: state.lastDriveNudgeAt, nudgeCount: state.nudgeCount, now, stallMs: cfg.stallMs, maxNudges: cfg.maxNudges });
  if (decision.kind !== 'nudge') {
    if (decision.kind === 'capped') res.stalledButQuiet += 1; // 催够了，停手等群里动
    return;
  }

  // judge 冷却：卡住也别每 tick 喊 LLM。
  const lastJudgeMs = state.lastDriveNudgeAt ? new Date(state.lastDriveNudgeAt).getTime() : 0;
  if (lastJudgeMs && now.getTime() - lastJudgeMs < cfg.judgeCooldownMs) return;

  const rendered = substantive.slice().reverse().map(m => m.rendered).join('\n').trim();
  const judged = await exec.judge(goal, rendered || msgs.slice().reverse().map(m => m.rendered).join('\n'));
  if (!judged || !judged.shouldNudge || !judged.nudgeText.trim()) return; // LLM 说没必要催 → 不催

  const sig = nudgeSignature(judged.nudgeText);
  // ③ 变化检测：同样的话不重复说。
  if (state.lastNudgeSignature && state.lastNudgeSignature === sig) { res.suppressedRepeat += 1; return; }

  // ④ 日预算：耗尽 → 只记录不发。
  if (budgetRemaining(state, now, cfg.maxPerDay) <= 0) {
    logger.warn(`[drive] ${chatId.slice(0, 12)} 当日催促预算耗尽 → 只记录不发：「${judged.nudgeText.slice(0, 40)}」`);
    res.droppedBudget += 1;
    return;
  }

  const ok = await exec.speak(chatId, judged.nudgeText);
  if (!ok) return; // 发失败 → 不记，下轮重试

  const dk = dateKeyOf(now);
  const sameDay = state.dateKey === dk;
  saveDriveState({
    ...state,
    nudgeCount: state.nudgeCount + 1,
    lastDriveNudgeAt: now.toISOString(),
    lastNudgeSignature: sig,
    episodeAnchorAt: state.episodeAnchorAt ?? state.lastSubstantiveActivityAt,
    dateKey: dk,
    sentToday: (sameDay ? state.sentToday : 0) + 1,
  });
  res.nudged += 1;
  logger.info(`[drive] ${chatId.slice(0, 12)} 卡住→按目标催了一句（本窗口第 ${state.nudgeCount + 1} 次）：「${judged.nudgeText.slice(0, 40)}」`);
}
