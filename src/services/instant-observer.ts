/**
 * instant-observer —— 群内新消息 → 即时唤醒 observer（替换过渡期外部轮询器）。
 *
 * 机制（设计要点）：
 *   observer bot 自己的 daemon 本来就收得到所在群的 im.message.receive_v1。
 *   在消息接收路径（event-dispatcher processMessageEvent 的群级 bookkeeping 段、
 *   ensureBotOpenId 之后）对配置了 instant-observer 的群：
 *     收到「非 observer 自己」的新消息
 *       → 防抖合并（60~120s 窗口，默认 90s，leading-edge coalescing）
 *       → 复用**现有一次性 schedule 触发路径**（scheduler.addTask 一条 once 任务，
 *         silent + top-level + 有限 repeat=1，到点由本 daemon 的 scheduler tick
 *         注入 observer 会话跑一轮幂等对账）。不新造并行触发机制。
 *
 * 防抖合并（review P2-1：原子 create-or-merge）：
 *   任务 id 由 chat+app 派生（instantTaskId，稳定确定），schedule-store 的
 *   createTask 在**文件锁内**按 id 判定：已存在同 id → IdempotencyConflictError
 *   → 判 merged。并发 writer / 多进程交叠也只会留下一条 pending。
 *
 * 生命周期（review P1-3 + r2 P1 ABA 防护）：
 *   任务带 repeat={times:1}，markRun 完成后 schedule-store **真删**该行，
 *   不留 disabled 残留；下一条消息自然开启新窗口。fired 但 markRun 未到的行
 *   在 IN_FLIGHT_GRACE_MS 内视为 in-flight → merge（不删不建）；超时才判
 *   崩溃残留、删除重建。scheduler 的 markRun 带 expectedCreatedAt CAS，
 *   僵尸回调绝不会误记/误删同 id 的新行。
 *
 * 撤销与 fail-closed（review P1-2）：
 *   - `botmux watch set --instant off` / `watch remove` / 切 --instant-app 时，
 *     CLI 调 cancelPendingInstantTasks 撤销旧 app+chat 的 pending 任务；
 *   - scheduler tick 在真正执行前用 instantTaskStillWanted 复核当前策略
 *     （策略缺失/关闭/换 app → 任务作废删除，fail-closed）。
 *
 * 自激防护（review P1-1）：
 *   发送者身份分 open_id / app_id 两个域，任一被权威证明为本 bot
 *   （open_id === botOpenId 或 app_id === larkAppId）都拒绝触发。
 *
 * 隔离性：
 *   - 按群隔离：任务 id/name 都含 chatId；策略按 chatId 存（chat-policy）。
 *   - 按 bot 隔离：策略里 instantObserver.larkAppId 指明 observer bot；
 *     只有该 bot 的 daemon 响应。
 *   - 与 15 分钟 cron 并存：任务 id/name 不同，互不识别、互不删改；两边触发
 *     同一套幂等对账，重复推进由对账流程幂等性消化。
 *
 * import 关系（防环）：本模块静态依赖 chat-policy-store / schedule-store；
 * scheduler 静态依赖本模块（预检），所以本模块对 scheduler 只做**动态** import。
 *
 * 测试：test/instant-observer.test.ts（含真实 schedule-store 集成）、
 *       test/instant-observer-wiring.test.ts（event-dispatcher 接线）。
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { getPolicy, type ChatPolicy } from './chat-policy-store.js';
import * as scheduleStore from './schedule-store.js';
import { logger } from '../utils/logger.js';
import type { ScheduledTask } from '../types.js';

export const INSTANT_TASK_NAME_PREFIX = 'instant-observer:';
export const INSTANT_TASK_ID_PREFIX = 'inst_';

export const DEFAULT_DEBOUNCE_SECONDS = 90;
export const MIN_DEBOUNCE_SECONDS = 60;
export const MAX_DEBOUNCE_SECONDS = 120;

export function instantTaskName(chatId: string): string {
  return `${INSTANT_TASK_NAME_PREFIX}${chatId}`;
}

/** chat+app 派生的稳定任务 id —— 同群同 bot 永远同 id，靠 store 锁内的
 *  按-id 幂等判定实现原子 create-or-merge（防抖并发安全的根）。 */
export function instantTaskId(chatId: string, larkAppId: string): string {
  const h = createHash('sha1').update(`${chatId}|${larkAppId}`).digest('hex').slice(0, 12);
  return `${INSTANT_TASK_ID_PREFIX}${h}`;
}

/** 内部任务鉴别用的结构子集（tick / 撤销处拿到的都是完整 ScheduledTask）。 */
export interface InstantTaskShape {
  id?: string;
  name?: string;
  chatId?: string;
  larkAppId?: string;
  parsed?: { kind?: string };
  silent?: boolean;
  repeat?: { times?: number | null } | null;
}

/**
 * 精确鉴别「本模块创建的内部任务」（review T6R r2 P2）：
 * id 必须等于**由该行自己的 chatId+larkAppId 重新派生**的稳定 id（自校验，
 * 前缀撞名撞不出来），且完整内部 shape 匹配（once + silent + repeat.times=1 +
 * 约定 name）。用户手建的同名 cron/once（随机 id 或形状不符）一律不算内部任务
 * —— 不会被 stale 预检删除，也不会被 --instant off 撤销。
 */
export function isInstantObserverTask(task: InstantTaskShape): boolean {
  if (!task.id || !task.chatId || !task.larkAppId) return false;
  return task.id === instantTaskId(task.chatId, task.larkAppId)
    && task.name === instantTaskName(task.chatId)
    && task.parsed?.kind === 'once'
    && task.silent === true
    && task.repeat?.times === 1;
}

/**
 * fail-closed 执行预检（scheduler tick 在真正执行前调用）：
 * 复核当前群策略——策略缺失 / enabled=false / observer 换了 app / 读取异常，
 * 一律判「不再想要」→ 调用方删除任务、跳过执行。
 * 非 instant 任务恒 true（不干涉普通 schedule）。
 */
export function instantTaskStillWanted(task: InstantTaskShape): boolean {
  if (!isInstantObserverTask(task)) return true;
  if (!task.chatId || !task.larkAppId) return false;
  try {
    const io = getPolicy(task.chatId)?.instantObserver;
    return !!io && io.enabled === true && io.larkAppId === task.larkAppId;
  } catch {
    return false; // 策略读取失败 → fail-closed，不执行
  }
}

/** 防抖窗口收敛到 [60, 120]s；未配置/非法值 → 默认 90s。 */
export function clampDebounceSeconds(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_DEBOUNCE_SECONDS;
  return Math.min(MAX_DEBOUNCE_SECONDS, Math.max(MIN_DEBOUNCE_SECONDS, Math.round(value)));
}

export type InstantDecision =
  | 'no-policy'      // 该群没配 instant-observer
  | 'disabled'       // 配了但 enabled=false
  | 'other-app'      // 配的 observer 不是本 daemon 的 bot（别的 bot 的事）
  | 'self-message'   // observer 自己的消息（open_id 或 app_id 命中），不触发
  | 'merged'         // 防抖窗口内已有 pending 一次性任务 → 合并
  | 'scheduled';     // 新建了一条一次性唤醒任务

export interface InstantNoteInput {
  /** 本 daemon 的 bot appId。 */
  larkAppId: string;
  chatId: string;
  /** 发送者 open_id 域（严格 open_id，不混装 app_id）。 */
  senderOpenId?: string;
  /** 发送者 app_id 域（bot sender 只给 app_id 时走这里）。 */
  senderAppId?: string;
  /** 本 bot 的 open_id，自我消息判定用。 */
  botOpenId?: string;
}

export interface InstantScheduleRequest {
  id: string;
  name: string;
  chatId: string;
  larkAppId: string;
  prompt: string;
  workingDir: string;
  debounceSeconds: number;
  runAt: string;
}

export interface InstantObserverDeps {
  getPolicy(chatId: string): ChatPolicy | null;
  /** 原子 create-or-merge：created=新窗口开启；merged=窗口内合并。 */
  scheduleOnce(req: InstantScheduleRequest): Promise<'created' | 'merged'> | 'created' | 'merged';
  now(): number;
  defaultWorkingDir(): string;
}

export function defaultInstantPrompt(chatId: string): string {
  return (
    `【instant-observer】群 ${chatId} 有新消息（已防抖合并）。`
    + '按本群 observer 既定流程做一轮幂等对账并路由下一步；'
    + '与定时轮是同一套流程，若无新增可推进事项则静默收束，不要重复推进。'
  );
}

/**
 * 核心判定 + 触发（依赖注入，单测直测这个）。返回 decision，调用方只做日志。
 */
export async function noteInstantObserverMessageWith(
  input: InstantNoteInput,
  deps: InstantObserverDeps,
): Promise<InstantDecision> {
  const policy = deps.getPolicy(input.chatId);
  const io = policy?.instantObserver;
  if (!io) return 'no-policy';
  if (!io.enabled) return 'disabled';
  if (io.larkAppId !== input.larkAppId) return 'other-app';
  // 自激防护：open_id / app_id 两域分开比对，任一命中本 bot 即自我消息。
  const selfByOpenId = !!input.senderOpenId && !!input.botOpenId && input.senderOpenId === input.botOpenId;
  const selfByAppId = !!input.senderAppId && input.senderAppId === input.larkAppId;
  if (selfByOpenId || selfByAppId) return 'self-message';

  const debounce = clampDebounceSeconds(io.debounceSeconds);
  const outcome = await deps.scheduleOnce({
    id: instantTaskId(input.chatId, input.larkAppId),
    name: instantTaskName(input.chatId),
    chatId: input.chatId,
    larkAppId: input.larkAppId,
    prompt: (io.prompt ?? '').trim() || defaultInstantPrompt(input.chatId),
    workingDir: deps.defaultWorkingDir(),
    debounceSeconds: debounce,
    runAt: new Date(deps.now() + debounce * 1000).toISOString(),
  });
  return outcome === 'created' ? 'scheduled' : 'merged';
}

/**
 * fired 行多久没等到 markRun 才算「崩溃残留」。正常链路里 executeCallback
 * 秒级到分钟级就 resolve、markRun 随即真删该行；远超这个尺度仍躺着的行才
 * 允许 reconcile（删除重建）。在此之前一律视为 in-flight → merge，
 * 绝不在旧回调可能仍按 id 回写时复用稳定 id（review T6R r2 P1，ABA）。
 */
export const IN_FLIGHT_GRACE_MS = 10 * 60_000;

/**
 * 生产 scheduleOnce：复用 scheduler.addTask（一次性 schedule 触发路径）。
 * 原子性依据：createTask 在 store 文件锁内按稳定 id 判定——
 *   同 id 已存在且输入不同 → IdempotencyConflictError → merged；
 *   不存在 → 创建。并发场景只可能留下一条 pending。
 *
 * 同 id 行的生命周期判定（ABA 防护，双保险）：
 *   - enabled 且未 fired → 真 pending → merge；
 *   - 已 fired（lastRunAt 有值）且在 IN_FLIGHT_GRACE_MS 内 → **in-flight**，
 *     执行刚开始、本轮对账天然覆盖新消息 → merge，不删不建；
 *   - 超出 grace 的 fired/disabled 行 → 崩溃残留 → 删除重建。重建后即使
 *     僵尸回调迟到 markRun，scheduler 传的 expectedCreatedAt 与新行不符，
 *     schedule-store 会整体跳过回写（generation CAS），新行不受影响。
 */
export async function scheduleInstantOnceTask(req: InstantScheduleRequest): Promise<'created' | 'merged'> {
  const scheduler = await import('../core/scheduler.js'); // 动态：防 scheduler↔本模块静态环
  const existing = scheduleStore.getTask(req.id, req.larkAppId);
  if (existing) {
    if (existing.enabled && !existing.lastRunAt) return 'merged'; // 真 pending → 窗口内合并
    const lastRunMs = existing.lastRunAt ? new Date(existing.lastRunAt).getTime() : null;
    if (lastRunMs !== null && Date.now() - lastRunMs < IN_FLIGHT_GRACE_MS) {
      return 'merged'; // in-flight：执行已开始、markRun 未到 —— 本轮对账覆盖新消息
    }
    scheduleStore.removeTask(req.id, req.larkAppId); // 崩溃残留 → 清掉重建（CAS 防僵尸回写）
  }
  try {
    scheduler.addTask({
      id: req.id,
      name: req.name,
      schedule: `instant+${req.debounceSeconds}s`, // 展示/持久化用；触发以 parsed.runAt 为准
      prompt: req.prompt,
      workingDir: req.workingDir,
      chatId: req.chatId,
      chatType: 'topic_group',
      scope: 'chat',
      executionPosition: 'top-level',
      larkAppId: req.larkAppId,
      parsed: { kind: 'once', runAt: req.runAt, display: `instant-observer +${req.debounceSeconds}s` },
      // P1-3：有限 repeat=1 → markRun 完成后 schedule-store 真删，不留 disabled 残留。
      repeat: { times: 1, completed: 0 },
      silent: true,
    });
    return 'created';
  } catch (err) {
    // 并发 writer 在锁内先建成同 id 任务 → 本次视为窗口内合并。
    if (err instanceof scheduleStore.IdempotencyConflictError) return 'merged';
    throw err;
  }
}

/**
 * 撤销某群某 observer app 的 pending 即时唤醒任务（--instant off / watch remove /
 * 切 --instant-app 时由 CLI 调用）。返回删掉的条数。
 * 只删通过 isInstantObserverTask 完整 shape 鉴别的内部任务（review T6R r2 P2）
 * ——同名/同前缀的用户 cron、once 一概不碰。
 * 读写失败（如沙盒内跨 bot store EPERM）只告警——scheduler 执行前的
 * fail-closed 预检仍会把作废任务拦下并删除。
 */
export function cancelPendingInstantTasks(chatId: string, larkAppId: string): number {
  let removed = 0;
  let tasks: ScheduledTask[];
  try {
    tasks = scheduleStore.listTasks(larkAppId);
  } catch (err) {
    logger.warn(`[instant-observer] cancel: cannot read store of ${larkAppId}: ${err}`);
    return 0;
  }
  for (const t of tasks) {
    if (t.chatId !== chatId || t.larkAppId !== larkAppId) continue;
    if (!isInstantObserverTask(t)) continue; // 严格 shape：不误伤用户任务
    try {
      if (scheduleStore.removeTask(t.id, larkAppId)) removed++;
    } catch (err) {
      logger.warn(`[instant-observer] cancel: remove ${t.id} failed: ${err}`);
    }
  }
  return removed;
}

/**
 * 消息接收路径入口（event-dispatcher 调用）。
 * fire-and-forget：任何异常只打日志，绝不影响消息路由。
 */
export function noteInstantObserverMessage(input: InstantNoteInput): void {
  void (async () => {
    const decision = await noteInstantObserverMessageWith(input, {
      getPolicy,
      scheduleOnce: scheduleInstantOnceTask,
      now: () => Date.now(),
      defaultWorkingDir: () => homedir(),
    });
    if (decision === 'scheduled' || decision === 'merged') {
      logger.info(
        `[instant-observer] ${decision} chat=${input.chatId.slice(0, 12)} `
        + `app=${input.larkAppId} sender=${(input.senderOpenId ?? input.senderAppId)?.slice(0, 12) ?? '-'}`,
      );
    }
  })().catch(err => {
    logger.warn(`[instant-observer] note failed chat=${input.chatId.slice(0, 12)}: ${err}`);
  });
}
