/**
 * 子任务编排系统 · Phase 4 service 层 (2026-05-30)。
 *
 * 5 个能力 (create/report/query/finish/supplement) 的 service —— 被 daemon IPC route 调用，
 * CLI (`botmux subtask-*`) 是薄 IPC 客户端。**不是 MCP server**（Dbotmux 无 MCP），复用现有
 * `botmux 子命令 → daemon IPC → service` 模式（蔻黛克斯边界1）。
 *
 * 加法并存（蔻黛克斯/邹劲松拍板）：新 subtask-store 是新 observer/dispatcher **唯一 source of truth**；
 *   建群复用 createGroupWithBots，但 v2 链路**不** registerWatch（避免旧 watcher + 新 observer 双管，边界3）。
 *
 * 6 边界：
 *   ① CLI+IPC 不搭 MCP   ② 双登记: createGroupWithBots 建群 + createSubTask 登记 (新 store 为准)
 *   ③ chatContext 带 v2 marker + 不 registerWatch   ④ crash window: 建群+登记串**同一 idempotencyKey**
 *   ⑤ report_progress 走 enqueueCommand、不碰 cursor/observation   ⑥ query: commandId 原子 ack + snapshot, 重复幂等
 * 鉴权分层：create=mainTopic+主bot；query/finish/supplement=主bot 且 task.parentChatId===session.chatId；
 *   report_progress=session.chatId===task.chatId（只能从该子群上报）。
 */
import { randomUUID } from 'node:crypto';
import { authzCheck, HttpError, resolveBotIdent } from '../core/main-bot-playbook.js';
import { getOrCompute, type IdempotencyEntry } from './spawn-idempotency-store.js';
import { createGroupWithBots } from './group-creator.js';
import { getSession } from './session-store.js';
import { logger } from '../utils/logger.js';
import type { Session } from '../types.js';
import {
  createSubTask, getSubTask, getCommand, transitionStatus, enqueueCommand, ackCommand,
  transitionAndEnqueueCommand, listObservations, listCommands,
  helpReportDelivery,
  VersionConflictError, CommandRetryMismatchError,
  type SubTask, type SubTaskBot, type SubTaskStatus, type OutboxCommand, type Observation,
} from './subtask-store.js';

/** v2 编排链路标记 —— 进 chatContext.relatedRefs，dashboard/welcome card 可见，
 *  跟旧 watcher 链路区分 (边界3)。 */
export const V2_MARKER = 'subtaskOrchestrationVersion:v2';

const BOT_META: Record<'claude' | 'codex' | 'tilly', { name: string; role: SubTaskBot['role'] }> = {
  claude: { name: '克劳德', role: 'main' },
  codex: { name: '蔻黛克斯', role: 'collab' },
  tilly: { name: '缇蕾', role: 'observer' },
};

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'task';
}

/** djb2 短哈希 (supplement idempotencyKey 用内容算稳定 key)。 */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** session.larkAppId 反查到对应 bot 的 openId (report 鉴权: 发起 bot ∈ task.bots)。 */
function sessionBotOpenId(larkAppId?: string): string | null {
  if (!larkAppId) return null;
  for (const k of ['claude', 'codex', 'tilly'] as const) {
    if (resolveBotIdent(k).larkAppId === larkAppId) return resolveBotIdent(k).openId;
  }
  return null;
}

/** 父群主 bot 鉴权：session 合法 + 是主 bot(claude) + 只能操作自己父群的 task。 */
function authzParentBot(sessionId: string, taskId: string): { session: Session; task: SubTask } {
  const session = getSession(sessionId);
  if (!session) throw new HttpError(403, `unknown session: ${sessionId}`);
  const task = getSubTask(taskId);
  if (!task) throw new HttpError(404, `subtask not found: ${taskId}`);
  const claudeApp = resolveBotIdent('claude').larkAppId;
  if (session.larkAppId !== claudeApp) throw new HttpError(403, 'only main bot can operate subtask');
  if (task.parentChatId !== session.chatId) {
    throw new HttpError(403, `subtask parent chat mismatch (task.parentChatId=${task.parentChatId}, session.chatId=${session.chatId})`);
  }
  return { session, task };
}

// ─── create_subtask ──────────────────────────────────────────────────────────
export interface CreateSubtaskReq {
  sessionId: string;
  goal: string;
  acceptance?: string | null;
  bots?: Array<'claude' | 'codex' | 'tilly'>;
  taskType?: 'prd' | 'bug' | 'misc';
  name?: string;
  relatedRefs?: string[];
  parentDigest?: string;
}

export async function createSubtask(req: CreateSubtaskReq): Promise<{ taskId: string; chatId: string; isNew: boolean }> {
  if (!req.goal?.trim()) throw new HttpError(400, 'missing goal');
  const ctx = await authzCheck(req.sessionId);              // mainTopic + 主bot (复用)
  const session = getSession(req.sessionId);                // for ownerOpenId
  const botKeys = req.bots ?? ['claude', 'codex', 'tilly'];
  // review P2: service 层也校验 bot key（IPC 可绕过 CLI 直传未知 key → 否则 resolveBotIdent 走 undefined/500）
  for (const k of botKeys) {
    if (!(k in BOT_META)) throw new HttpError(400, `unknown bot key: ${k} (allowed: claude|codex|tilly)`);
  }
  const resolved = botKeys.map(k => ({ key: k, ident: resolveBotIdent(k), meta: BOT_META[k] }));
  const claudeApp = resolveBotIdent('claude').larkAppId;
  const larkAppIds = resolved.map(r => r.ident.larkAppId);
  const subtaskBots: SubTaskBot[] = resolved.map(r => ({ openId: r.ident.openId, name: r.meta.name, role: r.meta.role }));

  // 边界4: 建群 + 登记串同一 idempotencyKey。crash window 安全靠两步同 key。
  // review Blocker: slug(goal) 对中文全压成 'task' → 同 root 下不同中文 goal 会碰撞 dedup。
  // 必须带 full goal 的稳定 hash，让"同 root 不同 goal"不 dedup、"同 root 同 goal 重试"才 dedup。
  const idempotencyKey = `${ctx.rootMessageId}-${slug(req.goal)}-${djb2(req.goal)}`;

  const { entry, cacheHit } = await getOrCompute(idempotencyKey, async (): Promise<IdempotencyEntry> => {
    const result = await createGroupWithBots({
      creatorLarkAppId: claudeApp,
      larkAppIds,
      // base relay 以 owner 身份写「接收群组」字段；owner 不在目标群时，
      // Base 会把该 oc_id 判为 800030410/not_found，kickoff/supplement 永远投不出。
      userOpenIds: session?.ownerOpenId ? [session.ownerOpenId] : undefined,
      name: req.name ?? `子任务·${req.goal.slice(0, 20)}`,
      sourceChatId: ctx.callerChatId,
      purpose: req.goal,
      chatContext: {
        taskType: req.taskType,
        relatedRefs: [V2_MARKER, ...(req.relatedRefs ?? [])], // 边界3: v2 marker
        participants: resolved.map(r => ({ openId: r.ident.openId, role: r.meta.role })),
        parentDigest: req.parentDigest,
      },
    });
    return { key: idempotencyKey, chatId: result.chatId, createdAt: new Date().toISOString() };
  });

  // 边界2+4: 登记进 subtask-store (新 observer/dispatcher source of truth)。createSubTask 幂等同 key →
  // "建群成功但登记失败" 重试时复用 chatId + 补登记，不重复建群。
  const task = await createSubTask({
    chatId: entry.chatId, parentChatId: ctx.callerChatId, parentMessageId: ctx.rootMessageId,
    goal: req.goal, acceptance: req.acceptance ?? null, bots: subtaskBots,
    requester: session?.ownerOpenId ?? 'owner', createdBy: 'claude', idempotencyKey,
  });
  // 群已建好 = 激活成功 → creating 转 observing 让 observer 接管。已 observing 不重复转。
  if (task.status === 'creating') await transitionStatus(task.taskId, 'observing');

  // v3 kickoff (finding #2 修复)：建群+observing 后 enqueue 一条急急如律令 kickoff 唤子群执行 bot 开干，
  // 由 dispatcher(coco) 投递时发 base relay 唤醒 (v2 之前没 kickoff → 子群空转)。
  // idempotencyKey task-scoped，重复 create(cacheHit) / create 重试都不重复 kickoff。
  await enqueueCommand({
    taskId: task.taskId, direction: 'parent_to_child', targetChatId: task.chatId,
    commandType: 'kickoff', payload: {}, idempotencyKey: `kickoff-${task.taskId}`, expectedTaskVersion: null,
  });

  // 边界3: v2 故意**不** registerWatch —— 这个群归新 observer，不让旧 watcher 也来管。
  logger.info(`[subtask-orch] create ${task.taskId} chat=${entry.chatId.slice(0, 12)} ${cacheHit ? 'CACHE_HIT' : 'NEW'}`);
  return { taskId: task.taskId, chatId: entry.chatId, isNew: !cacheHit };
}

// ─── report_progress ─────────────────────────────────────────────────────────
export interface ReportProgressReq {
  sessionId: string;
  taskId: string;
  type: 'need_help' | 'done';
  summary: string;
  sourceMessageIds?: string[];
  idempotencyKey?: string;
}

export async function reportProgress(req: ReportProgressReq): Promise<{ cmdId: string; taskId: string }> {
  const session = getSession(req.sessionId);
  if (!session) throw new HttpError(403, `unknown session: ${req.sessionId}`);
  const task = getSubTask(req.taskId);
  if (!task) throw new HttpError(404, `subtask not found: ${req.taskId}`);
  // 鉴权: 只能从该任务的子群上报 + 发起 bot ∈ task.bots (review P1)
  if (session.chatId !== task.chatId) {
    throw new HttpError(403, `report_progress must come from the subtask chat (session.chatId=${session.chatId}, task.chatId=${task.chatId})`);
  }
  const botOpenId = sessionBotOpenId(session.larkAppId);
  if (!botOpenId || !task.bots.some(b => b.openId === botOpenId)) {
    throw new HttpError(403, `reporting bot (larkAppId=${session.larkAppId}) is not a participant of this subtask`);
  }
  if (!req.summary?.trim()) throw new HttpError(400, 'missing summary');
  if (task.status === 'finished' || task.status === 'stopped') {
    throw new HttpError(409, `subtask already ${task.status}; ${req.type} report suppressed`);
  }
  // 边界5: 手动上报走 enqueueCommand，**不推 committedCursor、不建 Observation**，跟 observer 高水位分离。
  const commandType = req.type === 'done' ? 'report_done' : 'report_help';
  if (commandType === 'report_help') {
    const latestHelp = listCommands(task.taskId)
      .filter(c => c.commandType === 'report_help' && c.direction === 'child_to_parent' && c.supersededBy == null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .at(-1);
    const delivery = helpReportDelivery(task.taskId, new Date(), 10 * 60_000);
    // 只对**仍在途**的求助去重 (pending=未投 / sent_unacked_fresh=投出 10min 内还没人 ack) —— 这两种是
    // "上一条还在飞、别叠发"。bug 修复 (2026-05-31 蔻黛克斯 review): **不再**对 'acked' 去重 ——
    // ack 只表示父群看过上一轮，不代表执行者后续的主动求助无效；继续把 acked help 当去重锚点会让子群显式
    // askforhelp 永远被合并回旧 cmd、再也唤不起父群。acked 后的显式求助应作为新 help 正常 enqueue。
    if (latestHelp && (delivery === 'pending' || delivery === 'sent_unacked_fresh')) {
      logger.info(`[subtask-orch] report_progress ${task.taskId} need_help deduped via ${latestHelp.cmdId} (${delivery})`);
      return { cmdId: latestHelp.cmdId, taskId: task.taskId };
    }
  }
  // review 设计点: 无稳定来源 (sourceMessageIds/显式 key) 时用 randomUUID，避免 `manual-{type}-na`
  // 在同一 task 内把后续合法手动上报永久 dedup 成一条。
  const idempotencyKey = req.idempotencyKey
    ?? (req.sourceMessageIds?.length ? `manual-${req.type}-${req.sourceMessageIds.join(',')}` : `manual-${req.type}-${randomUUID()}`);
  const cmd = await enqueueCommand({
    taskId: task.taskId, direction: 'child_to_parent', targetChatId: task.parentChatId,
    commandType, payload: { summary: req.summary, sourceMessageIds: req.sourceMessageIds },
    idempotencyKey, expectedTaskVersion: task.version,
  });
  logger.info(`[subtask-orch] report_progress ${task.taskId} type=${req.type} cmd=${cmd.cmdId}`);
  return { cmdId: cmd.cmdId, taskId: task.taskId };
}

// ─── askforhelp ────────────────────────────────────────────────────────────────
export interface AskForHelpReq {
  sessionId: string;
  taskId: string;
  summary: string;
  sourceMessageIds?: string[];
  idempotencyKey?: string;
}

/**
 * askforhelp (v3, 见 task-context「🔴 v3 设计纠偏」)：子群执行 bot **主动求助** ——
 * 把求助信息**写进 store**(report_help command 入队)，仅此而已。激活主 bot 的链路不变，
 * 由 coco(dispatcher) 异步触发急急如律令 base relay 唤主 bot。「本质上是一种内存共享式的通信」(松松)。
 * 等价 reportProgress(type='need_help')，但语义面向执行者 (注入小尾巴里告诉子 bot「卡住用 askforhelp、别硬扛」)。
 */
export async function askForHelp(req: AskForHelpReq): Promise<{ cmdId: string; taskId: string }> {
  return reportProgress({ sessionId: req.sessionId, taskId: req.taskId, type: 'need_help', summary: req.summary, sourceMessageIds: req.sourceMessageIds, idempotencyKey: req.idempotencyKey });
}

// ─── query_subtask ────────────────────────────────────────────────────────────
export interface QuerySubtaskReq { sessionId: string; taskId?: string; commandId?: string; }
export interface QuerySubtaskResult {
  task: SubTask;
  observations: Observation[];
  commands: OutboxCommand[];
  ackedCommandId: string | null;
}

export async function querySubtask(req: QuerySubtaskReq): Promise<QuerySubtaskResult> {
  const session = getSession(req.sessionId);
  if (!session) throw new HttpError(403, `unknown session: ${req.sessionId}`);
  let task: SubTask | null = null;
  let cmd: OutboxCommand | null = null;
  if (req.commandId) {
    cmd = getCommand(req.commandId);
    if (!cmd) throw new HttpError(404, `command not found: ${req.commandId}`);
    task = getSubTask(cmd.taskId);
  } else if (req.taskId) {
    task = getSubTask(req.taskId);
  } else {
    throw new HttpError(400, 'need taskId or commandId');
  }
  if (!task) throw new HttpError(404, 'subtask not found');
  // 鉴权: 主 bot 且操作自己父群的 task
  const claudeApp = resolveBotIdent('claude').larkAppId;
  if (session.larkAppId !== claudeApp) throw new HttpError(403, 'only main bot can query subtask');
  if (task.parentChatId !== session.chatId) {
    throw new HttpError(403, `subtask parent chat mismatch (task.parentChatId=${task.parentChatId}, session.chatId=${session.chatId})`);
  }
  // 边界6 + review Blocker2: ack 语义**只对子群上报** (child→parent 的 report_help/report_done)。
  // 绝不 ack parent→child 的 finish/supplement —— 否则主 bot 拿 finish commandId 一 query 就把它标 acked,
  // dispatcher 之后不再投给子群。其它方向/类型的 commandId 仍返回 snapshot，但 ackedCommandId=null。
  let ackedCommandId: string | null = null;
  if (cmd
    && cmd.direction === 'child_to_parent'
    && (cmd.commandType === 'report_help' || cmd.commandType === 'report_done')
    && cmd.targetChatId === task.parentChatId) {
    await ackCommand(cmd.cmdId); // 重复 query 幂等：再设 acked 无害，且 completeDispatch 单调守卫防降级
    ackedCommandId = cmd.cmdId;
  }
  return {
    task: getSubTask(task.taskId)!,                 // ack 后重读
    observations: listObservations(task.taskId, 20),
    commands: listCommands(task.taskId),
    ackedCommandId,
  };
}

// ─── finish_subtask ───────────────────────────────────────────────────────────
export interface FinishSubtaskReq { sessionId: string; taskId: string; expectedVersion?: number; note?: string; force?: boolean; }

export async function finishSubtask(req: FinishSubtaskReq): Promise<{ taskId: string; status: string; cmdId: string; alreadyFinished?: boolean }> {
  const { task } = authzParentBot(req.sessionId, req.taskId);
  // 幂等: 已 finished 直接返回 (放在 expectedVersion 校验前 → 重复 finish 不报 400)
  if (task.status === 'finished') {
    const existing = listCommands(req.taskId).find(c => c.commandType === 'finish');
    if (existing) return { taskId: req.taskId, status: 'finished', cmdId: existing.cmdId, alreadyFinished: true };
    // review P1: finished 但历史无 finish 命令 → 自愈补一条，别把空 cmdId 泄给主 bot
    const cmd = await enqueueCommand({
      taskId: req.taskId, direction: 'parent_to_child', targetChatId: task.chatId,
      commandType: 'finish', payload: { content: req.note }, idempotencyKey: `finish-${req.taskId}`,
      expectedTaskVersion: task.version,
    });
    return { taskId: req.taskId, status: 'finished', cmdId: cmd.cmdId, alreadyFinished: true };
  }
  // review P1: expectedVersion 默认必传守 stale；人工强制走显式 force (才跳过 version check)
  if (!req.force && req.expectedVersion == null) {
    throw new HttpError(400, 'finish_subtask requires expectedVersion (or force=true to override)');
  }
  // review Blocker1: 状态转移 + finish 命令入队**一把原子事务**。
  let result: Awaited<ReturnType<typeof transitionAndEnqueueCommand>>;
  try {
    result = await transitionAndEnqueueCommand({
      taskId: req.taskId, expectedVersion: req.force ? undefined : req.expectedVersion, resolveTo: () => 'finished',
      command: {
        direction: 'parent_to_child', targetChatId: task.chatId,
        commandType: 'finish', payload: { content: req.note }, idempotencyKey: `finish-${req.taskId}`,
      },
    });
  } catch (err) {
    if (err instanceof VersionConflictError || err instanceof CommandRetryMismatchError) throw new HttpError(409, err.message);
    throw err;
  }
  if (!result) throw new HttpError(409, `cannot finish from status=${task.status} (illegal transition)`);
  logger.info(`[subtask-orch] finish ${req.taskId} cmd=${result.command.cmdId}`);
  return { taskId: req.taskId, status: result.task.status, cmdId: result.command.cmdId };
}

// ─── supplement_subtask ───────────────────────────────────────────────────────
export interface SupplementSubtaskReq { sessionId: string; taskId: string; content: string; expectedVersion?: number; force?: boolean; }

export async function supplementSubtask(req: SupplementSubtaskReq): Promise<{ taskId: string; cmdId: string; status: string }> {
  const { task } = authzParentBot(req.sessionId, req.taskId);
  if (!req.content?.trim()) throw new HttpError(400, 'missing content');
  // review P1: expectedVersion 默认必传守 stale；人工强制走显式 force
  if (!req.force && req.expectedVersion == null) {
    throw new HttpError(400, 'supplement_subtask requires expectedVersion (or force=true to override)');
  }
  // review Blocker1: (reported_help→observing 条件转移) + supplement 命令入队**一把原子事务**。
  // idempotencyKey 用内容 hash (同内容 dedup，不含 version 防转移后重试漏)。
  let result: Awaited<ReturnType<typeof transitionAndEnqueueCommand>>;
  try {
    result = await transitionAndEnqueueCommand({
      taskId: req.taskId, expectedVersion: req.force ? undefined : req.expectedVersion,
      resolveTo: cur => (cur === 'reported_help' ? 'observing' : null), // help 被回应 → observing；其它状态不动
      command: {
        direction: 'parent_to_child', targetChatId: task.chatId,
        commandType: 'supplement', payload: { content: req.content },
        idempotencyKey: `supp-${req.taskId}-${djb2(req.content)}`,
      },
    });
  } catch (err) {
    if (err instanceof VersionConflictError || err instanceof CommandRetryMismatchError) throw new HttpError(409, err.message);
    throw err;
  }
  if (!result) throw new HttpError(409, 'supplement illegal transition');
  logger.info(`[subtask-orch] supplement ${req.taskId} cmd=${result.command.cmdId}`);
  return { taskId: req.taskId, cmdId: result.command.cmdId, status: result.task.status };
}
