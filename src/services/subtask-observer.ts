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
  episodeAnchorMs as _episodeAnchorMs,
  effectiveNudgeCount as _effectiveNudgeCount,
  planStall,
} from './stall-throttle.js';
import {
  listSubTasks, listObservations, listCommands, commitObservationTransaction,
  helpReportDelivery, staleHelpCommandIds, latestHelpReport,
  enqueueNudgeAndUpdateStats, escalateStalledTask, enqueueCommand,
  CursorConflictError, InvalidCursorCommitError, VersionConflictError, OBSERVER_STATUSES,
  type SubTask, type SubTaskStatus, type Signal, type HelpDelivery, type OutboxCommand,
} from './subtask-store.js';
import * as sessionStore from './session-store.js';
import { publishManagerSessionAged, publishManagerStalled } from './root-inbox-publisher.js';
import type { Session } from '../types.js';

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
   *  关键 (review Blocker 1)：必须是连续的，cursor 才能安全推到本批最后一条不漏。
   *  优化 #3：带 senderId (消息发送者 open_id/app_id)，用于判"执行者侧实质活动"——
   *  owner(base relay nudge 回声) 的 senderId === task.requester，不算 activity。 */
  messages: Array<{ id: string; rendered: string; senderId?: string }>;
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
/** 超时兜底重报阈值 (松松)：同一 blocker 已上报、无新进展时本不重复上报；但若距上次**实际投出**的
 *  求助已超过此阈值、且**仍没人响应**(未 ack 且主 bot 没补充)、blocker 仍在 → 兜底再报一次。
 *  默认 2h，可调。 */
export const STALE_REREPORT_MS = 2 * 60 * 60 * 1000;

/** 优化 #3 (停滞自动唤醒)：observing 子群距上次执行者实质活动超过此阈值且无新消息 → 自动唤醒。
 *  >> MIN_OBSERVE_INTERVAL_MS，给长思考/长工具调用留余地；可调。 */
export const STALL_AFTER_MS = 10 * 60_000;
/** 同一停滞窗口最多自动唤醒几次；超过仍无响应 → escalate 给父群 (转 reported_help)。 */
export const MAX_NUDGES = 3;

/** 停滞自动唤醒决策 (纯函数，可单测)：observing + 距 activity baseline 超阈 → nudge；
 *  已唤醒用 lastNudgeAt 做 cooldown；nudgeCount≥MAX → escalate；其余 → none。
 *  @param lastInitiatingCmdAt 最近一条**非 nudge** 发起类 parent→child 命令(kickoff/supplement/
 *    request_review) 的时间——蔻黛克斯 code-review blocker2：fresh supplement 后要给执行者完整窗口、
 *    不能因 createdAt 老就立刻 nudge。**排除 nudge 自身**(否则窗口被自己的唤醒无限推后)。 */
export type StallAction = { kind: 'none' } | { kind: 'nudge' } | { kind: 'escalate' };

/** episode anchor = max{执行者实质活动, 最近非 nudge 发起命令, 建群时间} 的毫秒数。
 *  fresh supplement/request_review/kickoff 会推高它 → 开启**新 episode**。NaN 表示全脏。
 *  2026-06-24：核心算法抽到 stall-throttle util（drive 共用），这里是 SubTask 适配壳。 */
export function episodeAnchorMs(t: SubTask, lastInitiatingCmdAt: string | null): number {
  return _episodeAnchorMs({ activityAt: t.lastExecutorActivityAt, initiatingAt: lastInitiatingCmdAt, createdAt: t.createdAt });
}
/** 当前 episode 的有效 nudge 次数：上次 nudge 早于 episode anchor (= 新 episode 已开启) → 视作 0。 */
export function effectiveNudgeCount(t: SubTask, anchorMs: number): number {
  return _effectiveNudgeCount(t.lastNudgeAt, t.nudgeCount ?? 0, anchorMs);
}

/** 经理群是「汇报制」、事件驱动：没事就静默（等子群上报 / CEO 派活），静默=正常空闲、不是「停滞」。
 *  stall 逻辑（距上次活动超时→nudge/escalate）只适用于「有限任务的执行者」；拿它戳经理 = observer
 *  监督式行为漏进汇报制经理群（会误发「任务搞定没有？」，2026-06-21 bug）。故经理豁免 stall-nudge/
 *  escalate。真「经理挂了」的存活检测应另起一套、基于「收到指令/上报却迟迟未行动」而非「超时静默」。 */
export function managerExemptFromStall(t: SubTask): boolean {
  return t.reportingMode === 'manager';
}

/** 经理卡死阈值：经理任务在 paused / reported_help 滞留超此时长 → 判卡死、上浮 CEO。
 *  经理是汇报制、正常静默不算卡死（managerExemptFromStall 已豁免 stall-nudge）；但被 paused /
 *  reported_help 卡住后长期无人处理 = 真烂了（实测有老任务从 6/18 烂到 6/24 无人管）。可调。 */
export const MANAGER_STALL_MS = 2 * 60 * 60 * 1000; // 2h

export type ManagerHealthAction =
  | { kind: 'none' }
  | { kind: 'escalate_ceo'; stalledMs: number };

export const MANAGER_SESSION_AGE_MS = 12 * 60 * 60 * 1000; // 12h
export const MANAGER_SESSION_IDLE_MS = 2 * 60 * 60 * 1000; // 2h

export type ManagerSessionAgingAction =
  | { kind: 'none' }
  | { kind: 'alert'; ageMs: number; idleMs: number; recover: false };

/** 经理存活检测（纯函数，可单测）—— 与 stall-nudge 互补：
 *  stall-nudge 管「执行者超时静默」(planStallNudge)；本函数管「经理被 paused/reported_help 卡死躺尸」。
 *  这就是 managerExemptFromStall 注释承诺的「另起一套、基于卡死状态而非超时静默」的经理存活检测。
 *  判定：reportingMode==='manager' 且 status∈{paused,reported_help} 且 (now − updatedAt) > 阈值
 *    → escalate_ceo（默认只上浮告警 CEO、不自动 resume，宁稳勿乱、防误伤正在合理等待的任务）。
 *  其余（执行者 / observing 等活跃态 / 未超期 / updatedAt 脏）→ none。 */
export function planManagerHealth(t: SubTask, now: Date): ManagerHealthAction {
  if (t.reportingMode !== 'manager') return { kind: 'none' };
  if (t.status !== 'paused' && t.status !== 'reported_help') return { kind: 'none' };
  const updatedMs = t.updatedAt ? new Date(t.updatedAt).getTime() : NaN;
  if (!Number.isFinite(updatedMs)) return { kind: 'none' };
  const stalledMs = now.getTime() - updatedMs;
  if (stalledMs <= MANAGER_STALL_MS) return { kind: 'none' };
  return { kind: 'escalate_ceo', stalledMs };
}

export interface ManagerSessionSnapshot {
  status: 'active' | 'closed';
  createdAt?: string;
  lastMessageAt?: string;
}

/** Session 老化保守判定：
 *  - 只看 manager；
 *  - session 必须仍 active；
 *  - 年龄 > 12h 且最近活动 > 2h；
 *  - 必须有 pending work，避免把正常长时间待命的经理误判为老化。
 *  observer 层只能可靠拿到持久化 session.createdAt / lastMessageAt；daemon 进程活性、
 *  worker 屏幕状态、recover kill/restart 仍属后续 daemon-layer opt-in wiring。 */
export function planManagerSessionAging(
  t: SubTask,
  session: ManagerSessionSnapshot | null,
  hasPendingWork: boolean,
  now: Date,
): ManagerSessionAgingAction {
  if (t.reportingMode !== 'manager') return { kind: 'none' };
  if (!session || session.status !== 'active') return { kind: 'none' };
  if (!hasPendingWork) return { kind: 'none' };
  const createdMs = session.createdAt ? new Date(session.createdAt).getTime() : NaN;
  if (!Number.isFinite(createdMs)) return { kind: 'none' };
  const lastMs = session.lastMessageAt ? new Date(session.lastMessageAt).getTime() : createdMs;
  if (!Number.isFinite(lastMs)) return { kind: 'none' };
  const ageMs = now.getTime() - createdMs;
  const idleMs = now.getTime() - lastMs;
  if (ageMs <= MANAGER_SESSION_AGE_MS) return { kind: 'none' };
  if (idleMs <= MANAGER_SESSION_IDLE_MS) return { kind: 'none' };
  return { kind: 'alert', ageMs, idleMs, recover: false };
}

export function planStallNudge(t: SubTask, now: Date, lastInitiatingCmdAt: string | null = null): StallAction {
  if (t.status !== 'observing') return { kind: 'none' };       // 只在执行者本应继续的态唤
  const anchorMs = episodeAnchorMs(t, lastInitiatingCmdAt);
  // 核心节流走公共 util（drive 共用同一份真理）；子任务把"催够了(capped)"映射成 escalate(升级父群)。
  const d = planStall({ anchorMs, lastNudgeAt: t.lastNudgeAt, nudgeCount: t.nudgeCount ?? 0, now, stallMs: STALL_AFTER_MS, maxNudges: MAX_NUDGES });
  if (d.kind === 'capped') return { kind: 'escalate' };
  return d;
}

export async function runObserverTick(now: Date, exec: ObserverExecutors): Promise<{ checked: number; committed: number; errors: number }> {
  const stats = { checked: 0, committed: 0, errors: 0 };
  for (const t of listSubTasks({ statuses: OBSERVER_STATUSES })) {
    try {
      const managerDid = await handleManagerHealth(t, now);
      const did = await tickOne(t, now, exec);
      stats.checked += 1;
      if (managerDid || did) stats.committed += 1;
    } catch (err) {
      stats.errors += 1;
      logger.warn(`[subtask-observer] tick ${t.taskId} failed: ${err}`);
    }
  }
  return stats;
}

async function handleManagerHealth(t: SubTask, now: Date): Promise<boolean> {
  if (t.reportingMode !== 'manager') return false;
  const larkAppId = managerAlertLarkAppId(t);
  let did = false;
  const health = planManagerHealth(t, now);
  if (health.kind === 'escalate_ceo') {
    const hours = (health.stalledMs / 3600_000).toFixed(1);
    const res = await publishManagerStalled({
      task: t,
      larkAppId,
      summary: `经理任务 ${t.taskId} 卡在 ${t.status} 已 ${hours} 小时。默认仅告警，不自动 resume；请判断恢复、补充信息或关闭。`,
    });
    did = did || res.inserted;
    if (res.inserted) logger.info(`[subtask-observer] ${t.taskId} manager stalled → RootInbox(manager_stalled)`);
  }

  if (health.kind !== 'none') return did;

  const session = findActiveSessionForTask(t);
  const aging = planManagerSessionAging(t, session, hasPendingManagerWork(t), now);
  if (aging.kind === 'alert') {
    const ageHours = (aging.ageMs / 3600_000).toFixed(1);
    const idleHours = (aging.idleMs / 3600_000).toFixed(1);
    const res = await publishManagerSessionAged({
      task: t,
      larkAppId,
      summary: `经理任务 ${t.taskId} 的会话已运行 ${ageHours} 小时，近 ${idleHours} 小时无产出且仍有 pending work。默认仅告警；自动 recover 需后续 daemon 层 opt-in。`,
    });
    did = did || res.inserted;
    if (res.inserted) logger.info(`[subtask-observer] ${t.taskId} manager session aged → RootInbox(manager_session_aged)`);
  }
  return did;
}

function managerAlertLarkAppId(t: SubTask): string {
  return t.createdByLarkAppId ?? t.bots.find(b => b.role === 'main' && b.larkAppId)?.larkAppId ?? t.bots.find(b => b.larkAppId)?.larkAppId ?? '';
}

function findActiveSessionForTask(t: SubTask): Session | null {
  const sessions = sessionStore.findActiveSessionsByChatId(t.chatId);
  const managerAppIds = managerSessionAppIds(t);
  const candidates = managerAppIds.size
    ? sessions.filter(s => !!s.larkAppId && managerAppIds.has(s.larkAppId))
    : sessions;
  const sorted = candidates.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return sorted[0] ?? null;
}

function hasPendingManagerWork(t: SubTask): boolean {
  if (t.status === 'paused' || t.status === 'reported_help') return true;
  return listCommands(t.taskId).some(c =>
    c.direction === 'parent_to_child'
    && c.supersededBy == null
    && c.deliveryStatus !== 'acked'
    && c.deliveryStatus !== 'failed'
    && (c.commandType === 'kickoff' || c.commandType === 'supplement' || c.commandType === 'request_report' || c.commandType === 'request_review'));
}

function managerSessionAppIds(t: SubTask): Set<string> {
  return new Set([
    t.createdByLarkAppId,
    ...t.bots.filter(b => b.role === 'main').map(b => b.larkAppId),
  ].filter((id): id is string => !!id));
}

async function tickOne(t: SubTask, now: Date, exec: ObserverExecutors): Promise<boolean> {
  // 节流：距上次观测不够久 → 跳过
  const lastObs = listObservations(t.taskId).slice(-1)[0];
  if (lastObs && now.getTime() - new Date(lastObs.at).getTime() < MIN_OBSERVE_INTERVAL_MS) return false;

  // 读 committedCursor 之后的【连续】增量 (老→新)。fetchSince IO 失败会抛 → 上层 catch skip。
  const fetched = await exec.fetchSince(t.chatId, t.committedCursor, FETCH_LIMIT);
  // 优化 #3：无新消息 = 停滞信号。判是否本应继续却断开 → 自动唤醒 / escalate (原来直接 return false 丢弃)。
  if (fetched.messages.length === 0) return handleStall(t, now);

  // review Blocker 1: 只分析这批连续增量、cursor 只推到本批最后一条。!complete 时积压留给下轮，
  // 绝不把 cursor 跳到"没读到的最新"。
  const ordered = fetched.messages; // 已是 老→新 连续
  const analyzedMessageIds = ordered.map(m => m.id);
  const readToCursor = analyzedMessageIds[analyzedMessageIds.length - 1];
  const renderedNew = ordered.map(m => m.rendered).join('\n');
  if (!fetched.complete) logger.info(`[subtask-observer] ${t.taskId} 积压未读完, 本轮推进到 ${readToCursor?.slice(0, 10)}, 下轮继续`);

  // 优化 #3：本批是否含**执行者侧实质活动**——只有**已知 == owner(task.requester)** 的消息才算"非活动"
  // (base relay nudge 回声/owner 系统消息)。sender 未知(undefined) 保守当作执行者活动，绝不误抑真进展。
  // 仅当**整批都是已知 owner 消息**时 hasExecutorActivity=false → 纯回声。
  const hasExecutorActivity = ordered.some(m => m.senderId !== t.requester);

  // 蔻黛克斯 code-review blocker1：纯 owner 系统消息/nudge 回声 (无执行者活动) **绝不进 judge/planCommit**
  // ——否则「任务搞定没有？」可能被误判 need_help/done 触发上报或转态。只推进 cursor 防重读、中性观测、
  // 不上报、不转态、不 reset (hasExecutorActivity=false 已保证不动 baseline/nudge 态)。
  if (!hasExecutorActivity) {
    try {
      const res = await commitObservationTransaction({
        taskId: t.taskId, readFromCursor: t.committedCursor, readToCursor, analyzedMessageIds,
        summary: '(仅 owner 系统消息/nudge 回声，无执行者活动；推进 cursor 不驱动状态)', signal: 'normal',
        expectedVersion: t.version, hasExecutorActivity: false,
      });
      if (res == null) { logger.info(`[subtask-observer] ${t.taskId} echo commit null skip`); return false; }
      logger.info(`[subtask-observer] ${t.taskId} owner-only 回声 → 推进 cursor, 不 judge/不驱动状态`);
      return true;
    } catch (err) {
      if (err instanceof CursorConflictError || err instanceof InvalidCursorCommitError || err instanceof VersionConflictError) {
        logger.info(`[subtask-observer] ${t.taskId} echo conflict skip: ${(err as Error).message}`);
        return false;
      }
      throw err;
    }
  }

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
    // B 方案 + 超时兜底: observing 路径再判 need_help 时是否该上报 —— 相对上次 help 有新实质进展
    // (新证据 / 诉求变化)，**或** 距上次投出已超 2h 仍没人响应 (兜底重报)。
    //
    // paused(已求助·待人) 是更强静音态：不把"新消息/催办噪声"当新证据重报，只允许
    // ① 2h heartbeat、② blocker 归一化后确有变化。显式 askforhelp 不走 observer，仍由 orchestrator
    // 手动 enqueue report_help。
    () => {
      const prev = latestHelpReport(t.taskId);
      if (t.status === 'paused') {
        return hasBlockedHelpProgress(prev, judged.summary) || shouldStaleRereport(prev, now);
      }
      // parentResponded: 父群已对上次求助下发过 supplement → observing 路径不再因"新证据"重复上报 (见 hasNewHelpProgress)。
      return hasNewHelpProgress(prev, analyzedMessageIds, judged.summary, prev?.respondedBySupplement ?? false)
        || shouldStaleRereport(prev, now);
    },
    // 双层汇报: manager 门控 done 不实时推（剥 report_done）；executor 不传=旧行为。
    t.reportingMode ?? 'executor',
  );

  try {
    // review Blocker 2: 带 expectedVersion=t.version。judge 期间主 bot finish/supplement 改了
    // 状态/版本 → VersionConflict → skip，绝不拿旧计划写进 finished/已变更的 task。
    const res = await commitObservationTransaction({
      taskId: t.taskId, readFromCursor: t.committedCursor, readToCursor, analyzedMessageIds,
      summary: judged.summary, signal: judged.signal, evidenceLinks: judged.evidenceLinks,
      report: plan.report, statusTo: plan.statusTo, supersedeCommandIds: plan.supersedeCommandIds,
      expectedVersion: t.version, hasExecutorActivity,
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

/**
 * 优化 #3：停滞处理 (无新消息时调用)。planStallNudge 决策 → 调原子 store helper：
 * - nudge：enqueueNudgeAndUpdateStats (计数+命令同锁原子，幂等 key 防重复 nudge)。
 * - escalate：escalateStalledTask (observing→reported_help + 一条 report_help，转态后停滞门控自然不再触发)。
 * idempotencyKey 用 activity baseline 作 episode 区分 (执行者恢复→baseline 变→新窗口可再唤)；
 * nudgeCount 入 key 让同窗口每次 attempt 唯一、两 tick 并发同 attempt 自然 dedup。
 */
async function handleStall(t: SubTask, now: Date): Promise<boolean> {
  if (managerExemptFromStall(t)) return false;

  if (t.status === 'paused') return handlePausedHeartbeat(t, now);

  // blocker2 fix: 最近一条非 nudge 发起命令 (kickoff/supplement/request_review)——
  // sentAt 优先 (已投出)，否则 createdAt (pending)。排除 nudge 自身。
  const initiating = listCommands(t.taskId).filter(c =>
    c.direction === 'parent_to_child' && c.commandType !== 'nudge' && c.supersededBy == null);
  const latestInitiating = initiating.length
    ? initiating
        .map(c => ({ c, at: c.sentAt ?? c.createdAt }))
        .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
        .at(-1)!.c
    : null;

  // 交付待审豁免（治"做完没有?"刷屏）：最近一条主动命令是 request_review —— 执行者已交付、正等
  // reviewer 评审，这是「待审」而非「停滞」，**绝不催执行者**（observing 下 planStallNudge 本会每
  // STALL_AFTER_MS 催一次）。仅在评审超 STALE_REREPORT_MS(2h) 仍未闭环时，**重新 surface 评审请求给
  // reviewer**（不催执行者）。镜像 paused→handlePausedHeartbeat 的「待外部·静音 + 2h 兜底」语义。
  // 后续若父群下发 supplement / 执行者重新进入 need_help→paused，latestInitiating 不再是 request_review，
  // 豁免自然解除，停滞门控恢复。
  if (latestInitiating?.commandType === 'request_review') {
    return handleReviewHeartbeat(t, now, latestInitiating);
  }

  const lastInitiatingCmdAt = latestInitiating ? (latestInitiating.sentAt ?? latestInitiating.createdAt) : null;
  const action = planStallNudge(t, now, lastInitiatingCmdAt);
  if (action.kind === 'none') return false;
  // round2 blocker fix: 用 episode anchor (而非旧 baseline) 作 idempotency episode，
  // 让 fresh supplement/request_review 开新 episode → 新 key、不撞旧 escalation 命令；
  // effectiveCount 让新 episode 从 0 起算 nudge 次数。
  const anchorMs = episodeAnchorMs(t, lastInitiatingCmdAt);
  const episodeAnchorAt = new Date(anchorMs).toISOString();
  const effCount = effectiveNudgeCount(t, anchorMs);
  try {
    if (action.kind === 'nudge') {
      const r = await enqueueNudgeAndUpdateStats({
        taskId: t.taskId, targetChatId: t.chatId,
        idempotencyKey: `nudge-${t.taskId}-${episodeAnchorAt}-${effCount}`,
        episodeAnchorAt,
        expectedVersion: t.version,
      });
      if (r) logger.info(`[subtask-observer] ${t.taskId} 停滞→自动唤醒执行者 (episode count=${effCount + 1})`);
      return r != null;
    }
    const r = await escalateStalledTask({
      taskId: t.taskId,
      idempotencyKey: `stall-escalate-${t.taskId}-${episodeAnchorAt}`,
      summary: '子任务长时间无新消息且多次自动唤醒无响应，疑似执行者断开',
      expectedVersion: t.version,
    });
    if (r) logger.info(`[subtask-observer] ${t.taskId} 多次唤醒无响应→escalate 父群 (转 reported_help)`);
    return r != null;
  } catch (err) {
    if (err instanceof VersionConflictError) {
      logger.info(`[subtask-observer] ${t.taskId} stall action version conflict, skip this tick`);
      return false;
    }
    throw err;
  }
}

/** paused("已求助·待人") 无新消息时不走普通 stall nudge，但仍保留 2h 心跳兜底。
 *  这条路径不依赖文本 diff / 新消息数量：只有上次 help 实际投出后超过阈值才补一条 report_help。 */
async function handlePausedHeartbeat(t: SubTask, now: Date): Promise<boolean> {
  const prev = latestHelpReport(t.taskId);
  if (!shouldStaleRereport(prev, now)) return false;
  const stale = staleHelpCommandIds(t.taskId);
  const baseline = prev?.lastRespondedAt ?? prev?.sentAt ?? t.updatedAt;
  try {
    const res = await commitObservationTransaction({
      taskId: t.taskId,
      readFromCursor: t.committedCursor,
      readToCursor: t.committedCursor,
      analyzedMessageIds: [],
      summary: prev?.summary ? `2h heartbeat: ${prev.summary}` : '2h heartbeat: still blocked',
      signal: 'need_help',
      report: { commandType: 'report_help', idempotencyKey: `paused-heartbeat-${t.taskId}-${baseline}` },
      supersedeCommandIds: stale.length ? stale : undefined,
      expectedVersion: t.version,
      hasExecutorActivity: false,
    });
    if (res == null) return false;
    logger.info(`[subtask-observer] ${t.taskId} paused 超 2h 无响应→heartbeat 重报`);
    return true;
  } catch (err) {
    if (err instanceof CursorConflictError || err instanceof InvalidCursorCommitError || err instanceof VersionConflictError) {
      logger.info(`[subtask-observer] ${t.taskId} paused heartbeat conflict, skip this tick: ${(err as Error).message}`);
      return false;
    }
    throw err;
  }
}

/** 交付待审（执行者已 request_review、在等 reviewer）无新消息时的兜底：评审在 STALE_REREPORT_MS(2h)
 *  内 → 静默不催执行者（return false）；超 2h 评审仍未闭环 → 重新 surface 评审请求给 reviewer（不催
 *  执行者）。idempotencyKey 绑该条 request_review 的 cmdId → 每条评审请求只兜底重发一次（防 respam），
 *  与 handlePausedHeartbeat 的 baseline-keyed 一次性兜底语义一致。 */
async function handleReviewHeartbeat(t: SubTask, now: Date, reviewCmd: OutboxCommand): Promise<boolean> {
  const baseline = reviewCmd.sentAt ?? reviewCmd.createdAt;
  if (now.getTime() - new Date(baseline).getTime() <= STALE_REREPORT_MS) return false; // 待审中，不催执行者
  try {
    await enqueueCommand({
      taskId: t.taskId, direction: 'parent_to_child', targetChatId: t.chatId,
      commandType: 'request_review',
      payload: { ...reviewCmd.payload, targetRole: 'collab' },
      idempotencyKey: `review-revive-${t.taskId}-${reviewCmd.cmdId}`,
      expectedTaskVersion: t.version,
    });
    logger.info(`[subtask-observer] ${t.taskId} 评审超 ${STALE_REREPORT_MS}ms 未闭环→重新 surface 给 reviewer (不催执行者)`);
    return true;
  } catch (err) {
    if (err instanceof VersionConflictError) {
      logger.info(`[subtask-observer] ${t.taskId} review heartbeat version conflict, skip this tick`);
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

/** 上次实际上报的 help 摘要 (= store.latestHelpReport 的返回形状)，用于 observing 路径去重 + 超时兜底。 */
export interface PrevHelpReport {
  summary: string;
  sourceMessageIds: string[];
  sentAt: string | null;
  acked: boolean;
  respondedBySupplement: boolean;
  lastRespondedAt: string | null;
}

/** 归一化 help 诉求文本做实质性比较：去空白/标点/控制字符、小写化。
 *  让"同一 blocker 换个说法"也算无实质变化，避免 LLM 措辞抖动触发误报。 */
function normalizeAsk(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\s\x00-\x1F\x7F]+/g, '').replace(/[。，、,.!！?？;；:：]/g, '').toLowerCase();
}

/**
 * B 方案核心：observing 路径再次判 need_help 时，是否相对**上次实际上报的 help** 有「新实质进展」。
 *
 * supplement 把状态切回 observing 后，子群同一未解 blocker 会让 coco 反复判 need_help。无脑再 enqueue
 * = 反复惊动父群 (根因：planCommit observing 分支原本无条件 escalate)。这里据两条**或**门槛判新进展：
 *   ① 证据增量：本轮 analyzedMessageIds 里存在**上次 help 没覆盖过**的证据消息 (子群确有新动静)；
 *   ② 诉求变化：本轮 need_help 的 summary 归一化后与上次 help 的 summary **不同** (blocker 实质变了)。
 * 任一成立 → 有新进展、该再上报；都不成立 (新消息全是上次已覆盖的、且诉求没变) → 静默不重复上报。
 * 没有任何历史 help (prev=null) → 视为新进展 (首次上报，必须发)。
 */
export function hasNewHelpProgress(
  prev: PrevHelpReport | null,
  curAnalyzedIds: string[],
  curSummary: string,
  parentResponded = false,
): boolean {
  if (!prev) return true; // 没上报过 → 首次，必须发
  // 父群已通过 supplement/ack 介入后，observer 的逐 tick LLM 摘要不再作为重新升级依据。
  // 同一 blocker 的自由文本措辞会抖动，继续比较 askChanged 会让 scout 把旧 blocker 当新求助反复上报。
  // 后续重新升级只走显式 subtask-askforhelp 或 shouldStaleRereport 2h 兜底。
  if (parentResponded) return false;
  const askChanged = normalizeAsk(curSummary) !== normalizeAsk(prev.summary);
  const prevIds = new Set(prev.sourceMessageIds);
  const hasNewEvidence = curAnalyzedIds.some(id => !prevIds.has(id));
  if (hasNewEvidence) return true; // ① 子群有上次没覆盖过的新证据消息
  return askChanged;             // ② 诉求实质变化才算新进展，否则同一 blocker → 静默
}

/** paused(已求助·待人) 下的被动求助升级判断。
 *  与 hasNewHelpProgress 的差异：彻底忽略 analyzedMessageIds，避免催办噪声/普通聊天被当作"新证据"
 *  反复刷父群；只允许 blocker 文本归一化后真的变化。2h heartbeat 由 shouldStaleRereport 单独负责。 */
export function hasBlockedHelpProgress(prev: PrevHelpReport | null, curSummary: string): boolean {
  if (!prev) return true;
  return normalizeAsk(curSummary) !== normalizeAsk(prev.summary);
}

/**
 * 超时兜底重报 (松松)：「已上报过的别重复，除非真的隔了很久(两三小时)还没人响应再上报。」
 * 无新进展时，若**同时**满足 → 兜底重报一次：
 *   ① 距上次**实际投出**的求助 (sentAt) 已超 STALE_REREPORT_MS (默认 2h)；
 *   ② 仍**没人响应**——未被 ack 且主 bot 没在该 help 之后下发 supplement (任一=已介入则不重报)；
 *   ③ blocker 仍在 (调用方保证只在本轮 signal===need_help 时问)。
 * sentAt=null (从没投出) → 不算 stale (在路上/失败由 helpReportDelivery 那条线管，不归这里)。
 * 重报后会 enqueue 新 help，其 sentAt 投出后即刷新 2h 基准，下轮不会立刻又报。
 */
export function shouldStaleRereport(prev: PrevHelpReport | null, now: Date): boolean {
  if (!prev || !prev.sentAt) return false;           // 没上报过 / 从没真投出 → 不兜底
  const sentMs = new Date(prev.sentAt).getTime();
  if (!Number.isFinite(sentMs)) return false;        // 脏 sentAt → 保守不重报 (避免误触发)
  // bug 修复 (2026-05-31 子任务工作流，蔻黛克斯 review): 兜底基准 = max(求助投出, 父群最近一次响应)。
  // 旧逻辑 `if (acked || respondedBySupplement) return false` 是**永久**关闭兜底 —— 父群一旦 ack/supplement，
  // 哪怕那次响应没真正解决、blocker 又卡了三五个小时，也永远不再兜底重报，求助被静默埋掉。
  // 改为：父群响应过 → 从**响应时刻**重新起算 2h（给执行者按响应推进的时间，不刚回应就重报）；
  // 超 2h 同 blocker 仍判 need_help（调用方保证只在 signal===need_help 时问）→ 兜底重报一次。
  let baseMs = sentMs;
  if (prev.lastRespondedAt) {
    const r = new Date(prev.lastRespondedAt).getTime();
    if (Number.isFinite(r)) baseMs = Math.max(baseMs, r);
  }
  return now.getTime() - baseMs > STALE_REREPORT_MS;
}

/** 纯决策：当前状态 + signal → 要不要上报 / 转什么状态 / supersede 哪些旧命令。可单测。
 *  helpDelivery/staleHelpCmdIds (P1) 默认给"已 acked + 无旧命令"，等价旧行为；
 *  observer tickOne 注入真实值，让 reported_help no-respam 绑 command lifecycle。 */
export function planCommit(
  status: SubTaskStatus, signal: Signal, readToCursor: string | null,
  pendingDoneCmdIds: () => string[],
  helpDelivery: () => HelpDelivery = () => 'acked',
  staleHelpCmdIds: () => string[] = () => [],
  // B 方案: observing 路径再判 need_help 时是否有"新实质进展"(相对上次 help)。
  // 默认 true = 旧行为 (无条件上报)，observer tickOne 注入真实判断。
  observingHelpHasNewProgress: () => boolean = () => true,
  // 双层汇报: manager 门控。缺省 'executor' → 行为字节不变 (旧调用方不传)。
  reportingMode: 'manager' | 'executor' = 'executor',
): CommitPlan {
  const plan = planCommitBase(status, signal, readToCursor, pendingDoneCmdIds, helpDelivery, staleHelpCmdIds, observingHelpHasNewProgress);
  if (reportingMode === 'manager') {
    // manager 推送门控：done 是 routine，不实时推父群——剥掉 report_done（状态转移保留），完成信息由定期 digest 上报。
    if (signal === 'done' && plan.report?.commandType === 'report_done') {
      const { report: _drop, ...rest } = plan;
      // 蔻黛克斯 final blocker1：剥掉 done 上报后，若还有未 superseded 的旧 report_help（进 reported_help 时
      // 发的、可能尚未投递），它仍会被 dispatcher 急急如律令推父群 → "已 done 还求助" 假紧急。
      // 故 manager 转 done 时一并 supersede 这些旧 help（与既有 supersedeCommandIds 合并）。
      const staleHelp = staleHelpCmdIds();
      if (staleHelp.length) {
        rest.supersedeCommandIds = [...new Set([...(rest.supersedeCommandIds ?? []), ...staleHelp])];
      }
      return rest;
    }
    // 经理群上报泄漏修复：need_help 也是 routine（need_help ≠ urgent）——剥掉 report_help（状态转移保留），
    // observation 仍按 signal='need_help' 写入，由定期 digest 携带「⚠️ 受阻」。manager 唯一实时路径=report_urgent。
    if (plan.report?.commandType === 'report_help') {
      const { report: _drop, ...rest } = plan;
      return rest;
    }
  }
  return plan;
}

/** executor 基础决策（旧逻辑，字节不变）。manager 门控在 planCommit 外层做 done 的 report 剥离。 */
function planCommitBase(
  status: SubTaskStatus, signal: Signal, readToCursor: string | null,
  pendingDoneCmdIds: () => string[],
  helpDelivery: () => HelpDelivery,
  staleHelpCmdIds: () => string[],
  observingHelpHasNewProgress: () => boolean,
): CommitPlan {
  const helpReport = { commandType: 'report_help' as const, idempotencyKey: `help_${readToCursor}` };
  const doneReport = { commandType: 'report_done' as const, idempotencyKey: `done_${readToCursor}` };

  if (status === 'reported_done') {
    // recheck
    if (signal === 'done') return {}; // 仍 done → 只记观测，不重复报
    // 不再 done (有新工作/blocker) → 回退 + supersede 旧 done
    const stale = pendingDoneCmdIds();
    const supersedeCommandIds = stale.length ? stale : undefined;
    if (signal === 'need_help') return { report: helpReport, statusTo: 'paused', supersedeCommandIds };
    return { statusTo: 'observing', supersedeCommandIds };
  }

  if (status === 'paused') {
    if (signal === 'done') return { report: doneReport, statusTo: 'reported_done' };
    if (signal === 'need_help') {
      const hd = helpDelivery();
      if (hd === 'sent_unacked_expired' || hd === 'failed' || hd === 'none') {
        const stale = staleHelpCmdIds();
        return { report: helpReport, supersedeCommandIds: stale.length ? stale : undefined };
      }
      if (!observingHelpHasNewProgress()) return {};
      return { report: helpReport };
    }
    return {};
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
  if (signal === 'need_help') {
    // B 方案: supplement 把状态切回 observing 后，同一未解 blocker 会反复判 need_help。
    // 只有相对上次 help **有新实质进展** (新证据消息 / 诉求实质变化) 才再 enqueue + 转 reported_help；
    // 否则静默 (只记观测、推进 cursor)，不重复惊动父群。首次上报 prev=null → 恒 true，照常发。
    if (!observingHelpHasNewProgress()) return {};
    return { report: helpReport, statusTo: 'paused' };
  }
  if (signal === 'done') return { report: doneReport, statusTo: 'reported_done' };
  return {}; // normal → 只记观测 + 推进 cursor
}
