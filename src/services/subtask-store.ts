/**
 * 子任务编排系统 · Phase 1 数据层 (2026-05-30, 蔻黛克斯 review 加固版)。
 *
 * 三块数据模型 (技术方案 v0.2)：
 *   - SubTask      : 身份 / 目标 / 状态 / 版本 / cursor (主线)
 *   - OutboxCommand: 投递信封 —— 双向命令 (child→parent 上报 / parent→child finish/supplement)
 *   - Observation  : 增量证据 + LLM 总结 (可回溯，带 readFrom/readTo/analyzed 范围)
 *
 * 可靠性底座 (Blocker/P1 已按 review 修)：
 *   - **跨进程安全**：所有写操作走 `withFileLock(fp())`，read+mutate+write 整体进锁；
 *     tmp 文件用 pid+uuid 唯一名 —— 防多 daemon/cron/dashboard 并发 last-writer-wins 丢更新。
 *   - version 乐观锁 (锁内校验，跨进程也成立)。
 *   - cursor：committedCursor 只在 commitObservationTransaction 里被设成本轮 readToCursor，
 *     Observation 记 readFrom/readTo/analyzedMessageIds —— 结构性杜绝"提交未分析的高水位"。
 *   - commitObservationTransaction：Observation + 可选上报命令 + cursor + 状态转移 一次原子写。
 *   - 状态机转移校验，含 reported_help↔reported_done 真实路径。
 *   - ID 全用 randomUUID，跨进程/重启不撞。
 *
 * 持久化：~/.botmux/data/subtasks.json。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { withFileLock } from '../utils/file-lock.js';

export type SubTaskStatus =
  | 'creating' | 'activation_failed' | 'observing'
  | 'reported_help' | 'reported_done' | 'finished'
  | 'paused' | 'error' | 'stopped';

// 投递生命周期 (v2 at-least-once, 2026-06-15)：
//   pending → (写 record 成功) → sent_unconfirmed → (异步对账确认) → sent → (主bot query) → acked
//                                              └ (已取消) → failed   └ (写不进且重试耗尽) → failed
// sent_unconfirmed = record 已 durably 写入飞书 base、自动化会发，但还没异步确认到「已发送」。
//   · 读取方语义：listPendingCommands 不投它 (已写过)；reconcile 专门处理它；helpReportDelivery 当「在途」不补发。
//   · ack 优先：主bot 可能在确认前就 query+ack → acked 是终态，completeDispatch 守卫绝不把它降级/重发。
export type DeliveryStatus = 'pending' | 'sent_unconfirmed' | 'sent' | 'acked' | 'failed';
export type Signal = 'normal' | 'need_help' | 'done';
export type OutboxDirection = 'child_to_parent' | 'parent_to_child';
export type CommandType = 'report_help' | 'report_done' | 'finish' | 'supplement' | 'kickoff'
  // 优化 #1 (时序门控)：执行者产出后显式唤 reviewer。优化 #3：停滞自动唤醒执行者。
  | 'request_review' | 'nudge'
  // 双层汇报：manager 子群定期业务汇报 (child→parent，**不带急急如律令**、不唤醒，纯 FYI)。
  | 'report_digest'
  // 双层汇报 v6：manager 业务**紧急** (child→parent，带急急如律令实时唤父群，指向收件箱 entry)。
  //   与 report_help 区别：不进 reported_help 状态机、不参与 help dedup/supersede (蔻黛 M3 类型隔离)。
  | 'report_urgent'
  // 双层汇报 v6：CEO 主动 pull (parent→child，唤经理立即产 digest 邮件)。
  | 'request_report';
/** 命令定向角色 (优化 #1/#3)。缺省 (老命令/未写) 由 dispatcher 解释为 legacy=all，保持旧行为。 */
export type CommandTargetRole = 'main' | 'collab' | 'all';

export interface SubTaskBot { openId: string; name: string; role: 'main' | 'observer' | 'collab'; }

export interface SubTask {
  taskId: string;
  chatId: string;              // 子群
  parentChatId: string;        // 父群
  parentMessageId: string;     // 发任务源消息 id (鉴权+锚点)
  goal: string;
  acceptance: string | null;
  bots: SubTaskBot[];
  requester: string;
  createdBy: string;
  idempotencyKey: string;
  status: SubTaskStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  readCursor: string | null;       // 已读到的最后消息 id
  committedCursor: string | null;  // 已"判断+落证据+上报入队"确认的最后消息 id
  deadline: string | null;
  staleAfter: number | null;
  compactSummary: string | null;
  lastError: string | null;
  // 优化 #3 (停滞自动唤醒)：均为加法、可选；老任务缺省 (undefined) = 无 nudge 行为。
  /** 最近一次自动唤醒(nudge)的时间。仅用于 nudge cooldown，**不参与** activity baseline。 */
  lastNudgeAt?: string | null;
  /** 本停滞窗口已自动唤醒次数；≥ MAX_NUDGES 后转 escalate。观测到执行者实质活动时清零。 */
  nudgeCount?: number;
  /** 最近一次观测到**执行者侧实质活动**的时间 (排除 owner/base-relay 的 nudge 回声)。
   *  停滞门控的 activity baseline 取此字段，不取所有 observation。 */
  lastExecutorActivityAt?: string | null;
  // 嵌套子任务 (子群建孙群)：均为加法、可选；老数据缺省语义见各注释，零迁移。
  /** 树深度：1 = 主话题直属（老数据缺省按 1）。上限见 BOTMUX_MAX_SUBTASK_DEPTH。 */
  depth?: number;
  /** 树根 chatId（G4 树级预算聚合键）；老数据缺省按 parentChatId 推定（见 rootOf）。 */
  rootChatId?: string;
  /** G1 可裂变开关：create 一锤定音，true 才允许本任务子群再 subtask-start（缺省 false）。 */
  spawnable?: boolean;
  // 双层汇报 (manager vs executor)：均为加法、可选；缺省语义见注释，零迁移。
  /** 子群汇报模式：'manager'=部门经理(推送门控 + 定期 digest)；'executor'=执行者(实时直报)。
   *  缺省 (老数据/未写) = executor，行为与存量字节级一致。create 一锤定音。 */
  reportingMode?: 'manager' | 'executor';
  /** 最近一次定期 digest 推送时间 (仅 manager 用)。缺省 = 从未 digest (首窗按 createdAt 起算)。 */
  lastDigestAt?: string | null;
  /** 本任务最近一次 digest 的摘要正文 (仅 manager 用)。供父任务 digest 逐级 store 级聚合读取
   *  (孙群 digest 走 owner relay 会被父 observer 的 owner-only 回声过滤跳过，故聚合靠此字段而非聊天回读)。 */
  lastDigestSummary?: string | null;
  /** lastDigestSummary **内容产生**的时间 (仅 manager 用，蔻黛克斯 review blocker)。与 lastDigestAt 解耦：
   *  lastDigestAt 是窗口游标 (空窗也推进)，本字段只在**真推非空 digest** 时随 summary 一起更新。父 rollup
   *  按本字段判"子是否本窗有新活动"，避免空窗推进 lastDigestAt 把上一周期旧摘要误当新动静重复卷进父 digest。 */
  lastDigestSummaryAt?: string | null;
}

/** 是否部门经理子群 (双层汇报)。缺省/executor → false (旧行为)。 */
export function isManager(t: SubTask): boolean {
  return t.reportingMode === 'manager';
}

/** 双层汇报推送门控：某条 child→parent 上报是否应**实时**推父群 (急急如律令)。
 *  - executor (缺省)：恒 true —— 行为与存量字节级一致。
 *  - manager：恒 false —— **任何** report_help/report_done 都不实时惊动父群。
 *    经理子群对 CEO 的实时唤醒**唯一合法路径** = 显式 urgent (managerReport(urgency=urgent) → report_urgent)，
 *    该路径不经本函数 (走 ceo-inbox + 独立 report_urgent 命令)。其余 (done/need_help/停滞 escalate) 一律
 *    折叠进 4h digest，不实时推。
 *    ⚠️ 契约纠正 (经理群上报泄漏修复)：need_help **不等于** urgent —— 旧实现把 auto/manual_help 与
 *    stall_escalate 当"真紧急"实时推，违反「仅 digest/request/urgent」静默契约，此处改为恒 false。
 *  kind 覆盖全部 child→parent 上报入口 (planCommit 自动判 / reportProgress 手动 / stall escalate)。 */
export type PushKind = 'auto_done' | 'auto_help' | 'manual_done' | 'manual_help' | 'stall_escalate';
export function shouldRealtimePush(t: SubTask, _kind: PushKind): boolean {
  return !isManager(t);                             // executor 全推 (旧行为)；manager 全不推 (走 digest/urgent)
}

/** Outbox 投递信封：双向命令统一建模。 */
export interface OutboxCommand {
  cmdId: string;
  taskId: string;
  direction: OutboxDirection;
  targetChatId: string;            // 投到哪个群 (parent 或 child)
  commandType: CommandType;
  payload: { summary?: string; content?: string; sourceMessageIds?: string[];
    /** 优化 #1/#3：命令定向角色。缺省 → dispatcher 解释为 legacy=all (旧行为)。 */
    targetRole?: CommandTargetRole;
    /** 双层汇报 v6：report_urgent 关联的收件箱 entry id (discriminator，蔻黛 M3)。 */
    inboxEntryId?: string;
    /** 双层汇报 v6：request_report 的 requestId (履约闭环，蔻黛 M5)。 */
    requestId?: string };
  idempotencyKey: string;          // 防重发
  expectedTaskVersion: number | null;
  deliveryStatus: DeliveryStatus;
  deliveredMessageId: string | null;  // 投递成功后的消息 id (= 主bot 查询 ID 锚点)
  // 幂等关键 (2026-06-10 修重复刷屏)：首次 deliver 写入 base 记录后落库的 recordId。重试时复用它
  // 只重轮询、不再 upsert 新记录，避免自动化把同一条消息重复发出去。
  relayRecordId: string | null;
  retryCount: number;
  nextRetryAt: string | null;
  sentAt: string | null;
  ackedAt: string | null;          // 主 bot query_subtask 后回写
  supersededBy: string | null;
  lastError: string | null;
  createdAt: string;
  // review 硬约束1: command-level lease，防多 daemon/重入重复投递。
  dispatchingUntil: string | null;   // 投递租约到期时间 (claim 时设)
  dispatchAttemptId: string | null;  // 当前 lease 持有者 (CAS 回写校验)
}

export interface Observation {
  obsId: string;
  taskId: string;
  at: string;
  readFromCursor: string | null;   // 本轮从哪读
  readToCursor: string | null;     // 本轮读到哪 (= 提交后的 committedCursor)
  analyzedMessageIds: string[];    // 本轮分析了哪些消息 (可追溯)
  evidenceLinks: string[];
  summary: string;
  signal: Signal;
  /** 优化 #3：本轮增量是否含**执行者侧实质活动** (排除 owner/base-relay 的 nudge 回声)。
   *  持久化此标记，停滞门控的 activity baseline 只认 true 的观测；缺省 (老数据) 视为 undefined。 */
  hasExecutorActivity?: boolean;
  /** 双层汇报：manager 手动 done 落游标中性 observation 时的幂等键 (= reportProgress 的 idempotencyKey/
   *  sourceMessageIds 派生)。同 task 同 key 已存在则不重复落 (重试安全)。缺省=非手动幂等场景。 */
  manualDedupeKey?: string;
}

interface StoreFile {
  subtasks: SubTask[];
  commands: OutboxCommand[];
  observations: Observation[];
}

// ─── 状态机 ──────────────────────────────────────────────────────────────────
const ALLOWED_TRANSITIONS: Record<SubTaskStatus, SubTaskStatus[]> = {
  creating: ['observing', 'activation_failed', 'stopped'],
  activation_failed: ['observing', 'stopped'],
  // Phase 4: 主 bot finish_subtask 有权威性，可从任意活跃态直接 finished（不必等 observer 判 done）
  observing: ['reported_help', 'reported_done', 'finished', 'paused', 'error', 'stopped'],
  // review Blocker 2: help 期间子群自己解决 → 直接 done；done 后冒新 blocker → 直接 help
  reported_help: ['reported_done', 'observing', 'finished', 'paused', 'error', 'stopped'],
  reported_done: ['reported_help', 'observing', 'finished', 'paused', 'error', 'stopped'],
  paused: ['observing', 'finished', 'stopped'],
  error: ['observing', 'stopped'],
  finished: [],
  stopped: [],
};

export const ACTIVE_STATUSES: SubTaskStatus[] = ['observing', 'reported_help', 'reported_done'];

export function isTransitionAllowed(from: SubTaskStatus, to: SubTaskStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

// ─── IO（跨进程安全）─────────────────────────────────────────────────────────

/** store 文件存在但 parse 失败。**绝不当空库**——否则后续 write 覆盖 = 清库 (reliability-core
 *  不能这样)。corrupt 文件先备份留证，再抛本错误让上层 skip 本轮 (observer/dispatcher 有 try/catch)。 */
export class StoreCorruptError extends Error {
  constructor(public backupPath: string | null, cause: unknown) {
    super(`subtask-store corrupt (backed up to ${backupPath ?? 'N/A'}); HARD FAIL, not treating as empty. cause: ${cause}`);
    this.name = 'StoreCorruptError';
  }
}

function fp(): string { return join(config.session.dataDir, 'subtasks.json'); }
function ensureDir(): void {
  const d = dirname(fp());
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}
function read(): StoreFile {
  if (!existsSync(fp())) return { subtasks: [], commands: [], observations: [] };
  const raw = readFileSync(fp(), 'utf-8');
  try {
    const s = JSON.parse(raw) as Partial<StoreFile>;
    return { subtasks: s.subtasks ?? [], commands: s.commands ?? [], observations: s.observations ?? [] };
  } catch (err) {
    // 上线前必修 (蔻黛克斯 review)：corrupt **绝不**返回空库 (会被下一次 write 覆盖 = 清库)。
    // 先把 corrupt 文件备份成 .corrupt-<ts> 留证，再 hard fail —— 上层 skip 本轮而非静默清库。
    let backup: string | null = `${fp()}.corrupt-${Date.now()}`;
    try { writeFileSync(backup, raw, 'utf-8'); }
    catch (bkErr) { logger.error(`[subtask-store] corrupt backup failed: ${bkErr}`); backup = null; }
    logger.error(`[subtask-store] parse failed: ${err}; backed up to ${backup ?? 'N/A'}; HARD FAIL (refuse to wipe store)`);
    throw new StoreCorruptError(backup, err);
  }
}
function write(s: StoreFile): void {
  ensureDir();
  // review Blocker 1: 唯一 tmp 名 (pid+uuid)，防并发 writer 互相覆盖 tmp
  const tmp = `${fp()}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf-8');
  renameSync(tmp, fp());
}
/** 锁内 read→mutate→write。fn 返回 {result, dirty}；dirty=false 不写 (非法转移等)。
 *  fn 抛异常 → 不写 (乐观锁冲突等)。这是所有写操作的唯一入口，保证跨进程 RMW 原子。 */
async function mutate<T>(fn: (s: StoreFile) => { result: T; dirty: boolean }): Promise<T> {
  ensureDir(); // review P1: .lock 文件创建需要 dataDir 已存在 (干净环境首次写)
  return withFileLock(fp(), async () => {
    const s = read();
    const { result, dirty } = fn(s);
    if (dirty) write(s);
    return result;
  });
}

function genId(prefix: string): string { return `${prefix}_${randomUUID()}`; }

export class VersionConflictError extends Error {
  constructor(public taskId: string, public expected: number, public actual: number) {
    super(`SubTask ${taskId} version conflict: expected ${expected}, actual ${actual}`);
    this.name = 'VersionConflictError';
  }
}
export class TaskNotFoundError extends Error {
  constructor(public taskId: string) { super(`SubTask ${taskId} not found`); this.name = 'TaskNotFoundError'; }
}
/** commit 的 readFromCursor 跟当前 committedCursor 对不上 (基于陈旧快照提交 / 两 observer 抢)。 */
export class CursorConflictError extends Error {
  constructor(public taskId: string, public current: string | null, public readFrom: string | null) {
    super(`SubTask ${taskId} cursor conflict: committed=${current}, commit readFrom=${readFrom}`);
    this.name = 'CursorConflictError';
  }
}
/** commit 的 readToCursor 没法被本轮 analyzedMessageIds 解释 (提交未分析过的高水位)。 */
export class InvalidCursorCommitError extends Error {
  constructor(public taskId: string, reason: string) {
    super(`SubTask ${taskId} invalid cursor commit: ${reason}`);
    this.name = 'InvalidCursorCommitError';
  }
}
/** transitionAndEnqueueCommand 重试时同 idempotencyKey 但命令语义不同 (key 撞了不同命令)。 */
export class CommandRetryMismatchError extends Error {
  constructor(public taskId: string, public idempotencyKey: string) {
    super(`SubTask ${taskId} command retry mismatch for key ${idempotencyKey} (commandType/direction/target differ)`);
    this.name = 'CommandRetryMismatchError';
  }
}

// ─── SubTask（读同步 / 写锁内 async）──────────────────────────────────────────

export async function createSubTask(opts: {
  chatId: string; parentChatId: string; parentMessageId: string;
  goal: string; acceptance?: string | null; bots: SubTaskBot[];
  requester: string; createdBy: string; idempotencyKey: string;
  staleAfter?: number | null; deadline?: string | null;
  depth?: number; rootChatId?: string; spawnable?: boolean;
  reportingMode?: 'manager' | 'executor';
}): Promise<SubTask> {
  return mutate(s => {
    const existing = s.subtasks.find(t => t.idempotencyKey === opts.idempotencyKey);
    if (existing) {
      logger.info(`[subtask-store] createSubTask idempotent hit key=${opts.idempotencyKey} → ${existing.taskId}`);
      return { result: existing, dirty: false };
    }
    const now = new Date().toISOString();
    const t: SubTask = {
      taskId: genId('st'), chatId: opts.chatId, parentChatId: opts.parentChatId,
      parentMessageId: opts.parentMessageId, goal: opts.goal, acceptance: opts.acceptance ?? null,
      bots: opts.bots, requester: opts.requester, createdBy: opts.createdBy,
      idempotencyKey: opts.idempotencyKey, status: 'creating', version: 1, createdAt: now, updatedAt: now,
      readCursor: null, committedCursor: null, deadline: opts.deadline ?? null,
      staleAfter: opts.staleAfter ?? null, compactSummary: null, lastError: null,
      depth: opts.depth, rootChatId: opts.rootChatId, spawnable: opts.spawnable,
      reportingMode: opts.reportingMode ?? 'executor', lastDigestAt: null, lastDigestSummary: null,
      lastDigestSummaryAt: null,
    };
    s.subtasks.push(t);
    logger.info(`[subtask-store] created subtask ${t.taskId} chat=${opts.chatId.slice(0, 12)}`);
    return { result: t, dirty: true };
  });
}

export function getSubTask(taskId: string): SubTask | null {
  return read().subtasks.find(t => t.taskId === taskId) ?? null;
}
export function getByIdempotencyKey(key: string): SubTask | null {
  return read().subtasks.find(t => t.idempotencyKey === key) ?? null;
}
export function getByChatId(chatId: string): SubTask | null {
  return read().subtasks.find(t => t.chatId === chatId) ?? null;
}
export function listSubTasks(opts?: { statuses?: SubTaskStatus[] }): SubTask[] {
  const all = read().subtasks;
  return opts?.statuses ? all.filter(t => opts.statuses!.includes(t.status)) : all;
}

/** patch 一个 SubTask。**status 不能从这里改**（必须走 transitionStatus 过状态机校验，
 *  review P1）——类型已排除 status，运行期也防御性剥掉。 */
export async function updateSubTask(
  taskId: string,
  patch: Partial<Omit<SubTask, 'taskId' | 'version' | 'createdAt' | 'status'>>,
  expectedVersion?: number,
): Promise<SubTask | null> {
  // 运行期防御：调用方用 any 绕过类型也不让改 status
  const { status: _ignore, ...safePatch } = patch as Record<string, unknown>;
  return mutate(s => {
    const idx = s.subtasks.findIndex(t => t.taskId === taskId);
    if (idx < 0) return { result: null, dirty: false };
    const cur = s.subtasks[idx];
    if (expectedVersion != null && cur.version !== expectedVersion) {
      throw new VersionConflictError(taskId, expectedVersion, cur.version);
    }
    s.subtasks[idx] = { ...cur, ...safePatch, version: cur.version + 1, updatedAt: new Date().toISOString() };
    return { result: s.subtasks[idx], dirty: true };
  });
}

export async function transitionStatus(
  taskId: string, to: SubTaskStatus, opts?: { expectedVersion?: number; lastError?: string | null },
): Promise<SubTask | null> {
  return mutate(s => {
    const idx = s.subtasks.findIndex(t => t.taskId === taskId);
    if (idx < 0) return { result: null, dirty: false };
    const cur = s.subtasks[idx];
    if (!isTransitionAllowed(cur.status, to)) {
      logger.warn(`[subtask-store] illegal transition ${cur.status} → ${to} for ${taskId}; rejected`);
      return { result: null, dirty: false };
    }
    if (opts?.expectedVersion != null && cur.version !== opts.expectedVersion) {
      throw new VersionConflictError(taskId, opts.expectedVersion, cur.version);
    }
    s.subtasks[idx] = {
      ...cur, status: to, lastError: opts?.lastError ?? cur.lastError,
      version: cur.version + 1, updatedAt: new Date().toISOString(),
    };
    return { result: s.subtasks[idx], dirty: true };
  });
}

// ─── 原子提交（v0.2 核心，cursor 结构性约束）──────────────────────────────────

/**
 * 观测一轮原子提交：Observation + 可选上报命令(child→parent) + committedCursor 推进
 * (+ 可选状态转移) 一次原子写完成。要么全成、要么不提交。
 *
 * cursor 约束 (review P1)：committedCursor 直接被设成本轮 readToCursor，Observation
 * 记 readFrom/readTo/analyzedMessageIds —— 调用方无法把 cursor 推到"没分析过"的位置。
 *
 * 上报命令只用于 child→parent (report_help/report_done)；finish/supplement 走 enqueueCommand。
 */
export async function commitObservationTransaction(opts: {
  taskId: string;
  readFromCursor: string | null;
  readToCursor: string | null;       // = 提交后的 committedCursor
  analyzedMessageIds: string[];
  summary: string;
  signal: Signal;
  evidenceLinks?: string[];
  /** 命中 need_help/done 时附一条上报命令 (child→parent)。 */
  report?: { commandType: 'report_help' | 'report_done'; idempotencyKey: string };
  statusTo?: SubTaskStatus;
  /** done 误判后 recheck 回退时，把旧命令标 superseded。 */
  supersedeCommandIds?: string[];
  expectedVersion?: number;
  /** 优化 #3：本轮是否含执行者侧实质活动 (由 observer 据消息 sender 元数据算)。
   *  true → 记进 observation + 更新 lastExecutorActivityAt + 清 nudge 态 (执行者还活着)。
   *  false/缺省 → 仅推进 cursor (owner nudge 回声不当 activity，不动 nudge 态)。 */
  hasExecutorActivity?: boolean;
  /** 双层汇报：manager 手动 done 落游标中性 observation 的幂等键。提供且同 task 已有同 key 的
   *  observation → 直接返回既有 (不重复落)，重试安全。 */
  manualDedupeKey?: string;
}): Promise<{ observation: Observation; command: OutboxCommand | null } | null> {
  return mutate(s => {
    const idx = s.subtasks.findIndex(t => t.taskId === opts.taskId);
    if (idx < 0) return { result: null, dirty: false };
    const cur = s.subtasks[idx];
    // 幂等 (manager manual_done)：同 task 已有同 manualDedupeKey 的 observation → 返既有、不重复落、不转态。
    if (opts.manualDedupeKey) {
      const dup = s.observations.find(o => o.taskId === opts.taskId && o.manualDedupeKey === opts.manualDedupeKey);
      if (dup) {
        logger.info(`[subtask-store] commit tx ${opts.taskId} manualDedupe hit key=${opts.manualDedupeKey} → ${dup.obsId}`);
        return { result: { observation: dup, command: null }, dirty: false };
      }
    }
    if (opts.expectedVersion != null && cur.version !== opts.expectedVersion) {
      throw new VersionConflictError(opts.taskId, opts.expectedVersion, cur.version);
    }
    if (opts.statusTo && !isTransitionAllowed(cur.status, opts.statusTo)) {
      logger.warn(`[subtask-store] commit: illegal transition ${cur.status} → ${opts.statusTo} for ${opts.taskId}; abort`);
      return { result: null, dirty: false };
    }
    // cursor 硬校验 (review blocker)：
    // 1) readFromCursor 必须 = 当前 committedCursor（防陈旧快照提交 / 两 observer 抢）
    if (opts.readFromCursor !== cur.committedCursor) {
      throw new CursorConflictError(opts.taskId, cur.committedCursor, opts.readFromCursor);
    }
    // 2) 推进了 (readTo != readFrom) → analyzed 非空且 readToCursor 必须在 analyzed 里
    const advancing = opts.readToCursor !== opts.readFromCursor;
    if (advancing) {
      if (opts.analyzedMessageIds.length === 0) {
        throw new InvalidCursorCommitError(opts.taskId, 'analyzedMessageIds 为空却推进 cursor');
      }
      if (opts.readToCursor != null && !opts.analyzedMessageIds.includes(opts.readToCursor)) {
        throw new InvalidCursorCommitError(opts.taskId, `readToCursor=${opts.readToCursor} 不在 analyzedMessageIds`);
      }
    }
    const now = new Date().toISOString();
    const observation: Observation = {
      obsId: genId('ob'), taskId: opts.taskId, at: now,
      readFromCursor: opts.readFromCursor, readToCursor: opts.readToCursor,
      analyzedMessageIds: opts.analyzedMessageIds, evidenceLinks: opts.evidenceLinks ?? [],
      summary: opts.summary, signal: opts.signal,
      hasExecutorActivity: opts.hasExecutorActivity ?? false,
      ...(opts.manualDedupeKey ? { manualDedupeKey: opts.manualDedupeKey } : {}),
    };
    s.observations.push(observation);

    let command: OutboxCommand | null = null;
    if (opts.report) {
      command = {
        cmdId: genId('cmd'), taskId: opts.taskId, direction: 'child_to_parent',
        targetChatId: cur.parentChatId, commandType: opts.report.commandType,
        payload: { summary: opts.summary, sourceMessageIds: opts.analyzedMessageIds },
        idempotencyKey: opts.report.idempotencyKey, expectedTaskVersion: cur.version + 1,
        deliveryStatus: 'pending', deliveredMessageId: null, relayRecordId: null, retryCount: 0, nextRetryAt: null,
        sentAt: null, ackedAt: null, supersededBy: null, lastError: null, createdAt: now,
        dispatchingUntil: null, dispatchAttemptId: null,
      };
      s.commands.push(command);
    }
    if (opts.supersedeCommandIds?.length) {
      const by = command?.cmdId ?? 'recheck';
      for (const c of s.commands) {
        if (opts.supersedeCommandIds.includes(c.cmdId)) c.supersededBy = by;
      }
    }

    // 优化 #3：观测到执行者实质活动 → 更新 activity baseline + 清 nudge 态 (执行者还活着，重新 arm)。
    //   owner nudge 回声 (hasExecutorActivity=false) 只推进 cursor，不动 baseline / nudge 态。
    const activityPatch = opts.hasExecutorActivity
      ? { lastExecutorActivityAt: now, lastNudgeAt: null, nudgeCount: 0 }
      : {};
    s.subtasks[idx] = {
      ...cur, committedCursor: opts.readToCursor, readCursor: opts.readToCursor,
      status: opts.statusTo ?? cur.status, version: cur.version + 1, updatedAt: now,
      ...activityPatch,
    };
    logger.info(`[subtask-store] commit tx ${opts.taskId}: obs=${observation.obsId}${command ? ` cmd=${command.cmdId}(${command.commandType})` : ''} cursor→${opts.readToCursor?.slice(0, 10) ?? 'null'}${opts.hasExecutorActivity ? ' [exec-activity]' : ''}`);
    return { result: { observation, command }, dirty: true };
  });
}

/**
 * 双层汇报：manager 手动 done 落「游标中性 observation」（不实时推父群、交给定期 digest）。
 *
 * 与 commitObservationTransaction 区别：committedCursor 在**锁内**读取并原样回写
 * (readFrom=readTo=当前 committedCursor)，**不做** readFromCursor===committedCursor 的 TOCTOU 校验
 * ——手动上报与 observer tick 可能并发推进 cursor，这里不该因 cursor 漂移而抛冲突 (manual 动作不能报错给用户)。
 *
 * 语义：
 *  - 落一条 signal='done' 的中性 observation，保住执行者的显式 summary (含 doc 链接)，供 digest 消费。
 *  - 同时尝试 statusTo='reported_done'（停泊、不再被 stall nudge/escalate 误升级；不合法则跳过转移）。
 *  - 更新 lastExecutorActivityAt + 清 nudge 态（手动 done 是执行者实质活动，双保险防停滞误报）。
 *  - 幂等：同 task 已有同 manualDedupeKey 的 observation → 返既有、不重复落。
 */
export async function recordManualDoneObservation(opts: {
  taskId: string; summary: string; manualDedupeKey: string; sourceMessageIds?: string[];
}): Promise<{ observation: Observation; transitioned: boolean; deduped: boolean } | null> {
  return mutate<{ observation: Observation; transitioned: boolean; deduped: boolean } | null>(s => {
    const idx = s.subtasks.findIndex(t => t.taskId === opts.taskId);
    if (idx < 0) return { result: null, dirty: false };
    const cur = s.subtasks[idx];
    const dup = s.observations.find(o => o.taskId === opts.taskId && o.manualDedupeKey === opts.manualDedupeKey);
    if (dup) {
      logger.info(`[subtask-store] recordManualDone ${opts.taskId} dedupe hit key=${opts.manualDedupeKey} → ${dup.obsId}`);
      return { result: { observation: dup, transitioned: false, deduped: true }, dirty: false };
    }
    const now = new Date().toISOString();
    const observation: Observation = {
      obsId: genId('ob'), taskId: opts.taskId, at: now,
      readFromCursor: cur.committedCursor, readToCursor: cur.committedCursor,
      analyzedMessageIds: [], evidenceLinks: opts.sourceMessageIds ?? [],
      summary: opts.summary, signal: 'done', hasExecutorActivity: true,
      manualDedupeKey: opts.manualDedupeKey,
    };
    s.observations.push(observation);
    const canPark = isTransitionAllowed(cur.status, 'reported_done');
    // 蔻黛克斯 final blocker1（同病修复）：manager 手动 done 停泊到 reported_done 时，把该 task 未 superseded
    // 的 report_help 一并 supersede —— 否则进 reported_help 时发的旧 help 仍会被 dispatcher 急急如律令推父群，
    // 形成"已 done 还求助"假紧急。
    if (canPark) {
      for (const c of s.commands) {
        if (c.taskId === opts.taskId && c.commandType === 'report_help' && c.supersededBy == null) {
          c.supersededBy = observation.obsId;
        }
      }
    }
    s.subtasks[idx] = {
      ...cur,
      status: canPark ? 'reported_done' : cur.status,
      version: cur.version + 1, updatedAt: now,
      lastExecutorActivityAt: now, lastNudgeAt: null, nudgeCount: 0,
    };
    logger.info(`[subtask-store] recordManualDone ${opts.taskId}: obs=${observation.obsId}${canPark ? ' →reported_done (+supersede stale help)' : ` (stay ${cur.status})`}`);
    return { result: { observation, transitioned: canPark, deduped: false }, dirty: true };
  });
}

/** 经理群上报泄漏修复：manager 子群手动 need_help 的折叠落点 (recordManualDoneObservation 的 help 版兄弟)。
 *  写一条游标中性、signal='need_help' 的 observation 保住显式 summary (供定期 digest 按 signal 聚合呈现
 *  「⚠️ 受阻」)，**不入队任何 report_help 命令** → 绝不实时唤父群。幂等键防重试重复落。允许时停泊到
 *  reported_help (状态机一致：该 manager 子任务确实受阻，只是不实时惊动 CEO)。 */
export async function recordManualHelpObservation(opts: {
  taskId: string; summary: string; manualDedupeKey: string; sourceMessageIds?: string[];
}): Promise<{ observation: Observation; transitioned: boolean; deduped: boolean } | null> {
  return mutate<{ observation: Observation; transitioned: boolean; deduped: boolean } | null>(s => {
    const idx = s.subtasks.findIndex(t => t.taskId === opts.taskId);
    if (idx < 0) return { result: null, dirty: false };
    const cur = s.subtasks[idx];
    const dup = s.observations.find(o => o.taskId === opts.taskId && o.manualDedupeKey === opts.manualDedupeKey);
    if (dup) {
      logger.info(`[subtask-store] recordManualHelp ${opts.taskId} dedupe hit key=${opts.manualDedupeKey} → ${dup.obsId}`);
      return { result: { observation: dup, transitioned: false, deduped: true }, dirty: false };
    }
    const now = new Date().toISOString();
    const observation: Observation = {
      obsId: genId('ob'), taskId: opts.taskId, at: now,
      readFromCursor: cur.committedCursor, readToCursor: cur.committedCursor,
      analyzedMessageIds: [], evidenceLinks: opts.sourceMessageIds ?? [],
      summary: opts.summary, signal: 'need_help', hasExecutorActivity: true,
      manualDedupeKey: opts.manualDedupeKey,
    };
    s.observations.push(observation);
    const canPark = isTransitionAllowed(cur.status, 'reported_help');
    s.subtasks[idx] = {
      ...cur,
      status: canPark ? 'reported_help' : cur.status,
      version: cur.version + 1, updatedAt: now,
      lastExecutorActivityAt: now, lastNudgeAt: null, nudgeCount: 0,
    };
    logger.info(`[subtask-store] recordManualHelp ${opts.taskId}: obs=${observation.obsId}${canPark ? ' →reported_help' : ` (stay ${cur.status})`} (manager digest, no realtime)`);
    return { result: { observation, transitioned: canPark, deduped: false }, dirty: true };
  });
}

// ─── Outbox 命令 ─────────────────────────────────────────────────────────────

/** 入队一条 outbox 命令 (主bot 发 finish/supplement 给子群，或主动补一条上报)。
 *  taskId 不存在 → 抛 TaskNotFoundError (review: 拒 orphan)。同 idempotencyKey 已存在 → 返既有。 */
export async function enqueueCommand(opts: {
  taskId: string; direction: OutboxDirection; targetChatId: string;
  commandType: CommandType; payload: OutboxCommand['payload'];
  idempotencyKey: string; expectedTaskVersion?: number | null;
}): Promise<OutboxCommand> {
  return mutate(s => {
    if (!s.subtasks.some(t => t.taskId === opts.taskId)) {
      throw new TaskNotFoundError(opts.taskId);
    }
    // review P2: idempotency 按 (taskId, key) task-scoped，避免弱 key 跨任务误 dedup
    const dup = s.commands.find(c => c.taskId === opts.taskId && c.idempotencyKey === opts.idempotencyKey);
    if (dup) return { result: dup, dirty: false };
    const c: OutboxCommand = {
      cmdId: genId('cmd'), taskId: opts.taskId, direction: opts.direction, targetChatId: opts.targetChatId,
      commandType: opts.commandType, payload: opts.payload, idempotencyKey: opts.idempotencyKey,
      expectedTaskVersion: opts.expectedTaskVersion ?? null, deliveryStatus: 'pending',
      deliveredMessageId: null, relayRecordId: null, retryCount: 0, nextRetryAt: null, sentAt: null, ackedAt: null,
      supersededBy: null, lastError: null, createdAt: new Date().toISOString(),
      dispatchingUntil: null, dispatchAttemptId: null,
    };
    s.commands.push(c);
    return { result: c, dirty: true };
  });
}

/** 原子事务 (review Blocker): version check + 条件状态转移 + 命令入队 + version++ 一把 file lock。
 *  finish/supplement 用 —— 杜绝"状态变了但命令没入队"(或反之) 的中间不一致。
 *  - resolveTo(curStatus) 返回目标状态 (null=不转)；非法转移 → 返回 null（调用方映射 409）。
 *  - 命令按 (taskId, idempotencyKey) 幂等：已存在则整体幂等返回 (不重复转/不 bump)。 */
export async function transitionAndEnqueueCommand(opts: {
  taskId: string;
  resolveTo?: (cur: SubTaskStatus) => SubTaskStatus | null;
  expectedVersion?: number;
  command: {
    direction: OutboxDirection; targetChatId: string;
    commandType: CommandType; payload: OutboxCommand['payload']; idempotencyKey: string;
  };
}): Promise<{ task: SubTask; command: OutboxCommand } | null> {
  return mutate(s => {
    const idx = s.subtasks.findIndex(t => t.taskId === opts.taskId);
    if (idx < 0) throw new TaskNotFoundError(opts.taskId);
    const cur = s.subtasks[idx];
    // review Blocker: **dup 必须在 expectedVersion 之前查**。否则 supplement 超时重试带旧
    // expectedVersion，会在看到 dup 前先抛 VersionConflict，同一请求无法幂等返回既有命令。
    const dup = s.commands.find(c => c.taskId === opts.taskId && c.idempotencyKey === opts.command.idempotencyKey);
    if (dup) {
      // 一致性校验: 同 key 必须同语义命令 (防 idempotencyKey 撞了不同 commandType/方向/目标)
      if (dup.commandType !== opts.command.commandType || dup.direction !== opts.command.direction || dup.targetChatId !== opts.command.targetChatId) {
        throw new CommandRetryMismatchError(opts.taskId, opts.command.idempotencyKey);
      }
      // dup 命中 → 跳过 stale expectedVersion；按当前状态 self-heal (命令在、状态没转 → 补转移)
      const want = opts.resolveTo ? opts.resolveTo(cur.status) : null;
      if (want && want !== cur.status) {
        if (!isTransitionAllowed(cur.status, want)) {
          logger.warn(`[subtask-store] transitionAndEnqueue dup-heal: illegal ${cur.status} → ${want} for ${opts.taskId}; abort`);
          return { result: null, dirty: false };
        }
        s.subtasks[idx] = { ...cur, status: want, version: cur.version + 1, updatedAt: new Date().toISOString() };
        logger.info(`[subtask-store] transitionAndEnqueue ${opts.taskId}: dup cmd ${dup.cmdId}, 补状态 ${cur.status}→${want}`);
        return { result: { task: s.subtasks[idx], command: dup }, dirty: true };
      }
      return { result: { task: cur, command: dup }, dirty: false };
    }
    // 新命令才 check expectedVersion (review Blocker)
    if (opts.expectedVersion != null && cur.version !== opts.expectedVersion) {
      throw new VersionConflictError(opts.taskId, opts.expectedVersion, cur.version);
    }
    // 条件状态转移 (锁内按当前 status 决定)
    const to = opts.resolveTo ? opts.resolveTo(cur.status) : null;
    if (to && to !== cur.status && !isTransitionAllowed(cur.status, to)) {
      logger.warn(`[subtask-store] transitionAndEnqueue: illegal ${cur.status} → ${to} for ${opts.taskId}; abort`);
      return { result: null, dirty: false };
    }
    const now = new Date().toISOString();
    const command: OutboxCommand = {
      cmdId: genId('cmd'), taskId: opts.taskId, direction: opts.command.direction, targetChatId: opts.command.targetChatId,
      commandType: opts.command.commandType, payload: opts.command.payload, idempotencyKey: opts.command.idempotencyKey,
      expectedTaskVersion: cur.version + 1, deliveryStatus: 'pending',
      deliveredMessageId: null, relayRecordId: null, retryCount: 0, nextRetryAt: null, sentAt: null, ackedAt: null,
      supersededBy: null, lastError: null, createdAt: now, dispatchingUntil: null, dispatchAttemptId: null,
    };
    s.commands.push(command);
    s.subtasks[idx] = {
      ...cur, status: to && to !== cur.status ? to : cur.status,
      version: cur.version + 1, updatedAt: now,
    };
    logger.info(`[subtask-store] transitionAndEnqueue ${opts.taskId}: ${cur.status}${to && to !== cur.status ? `→${to}` : ''} cmd=${command.cmdId}(${opts.command.commandType})`);
    return { result: { task: s.subtasks[idx], command }, dirty: true };
  });
}

/**
 * 优化 #3 (停滞自动唤醒) · 原子 helper（蔻黛克斯 #3-blocker1）：
 * nudge 命令入队 + 计数/时间戳更新在**同一临界区**，杜绝"只更计数没发命令 / 只发命令没更计数 /
 * 两 tick 都过门发重复 nudge"。
 * - 幂等：同 idempotencyKey 已存在 → 返既有命令、**不再 bump 计数** (整体幂等)。
 * - 门控：仅当 status==='observing' 才发 (re-read 锁内复核，executor 本应在干活的态)。
 * - 返回 null = 门控不满足 (状态已变 / version 冲突由抛错处理)。
 */
export async function enqueueNudgeAndUpdateStats(opts: {
  taskId: string; targetChatId: string; idempotencyKey: string; expectedVersion?: number;
  /** 优化 #3 (蔻黛克斯 round2)：当前 episode anchor (ISO)。上次 nudge 早于它 = 新 episode → 计数重置为 1。 */
  episodeAnchorAt?: string;
}): Promise<{ task: SubTask; command: OutboxCommand } | null> {
  return mutate(s => {
    const idx = s.subtasks.findIndex(t => t.taskId === opts.taskId);
    if (idx < 0) throw new TaskNotFoundError(opts.taskId);
    const cur = s.subtasks[idx];
    // 幂等优先 (在 version check 前)：dup 命中直接返回、不动计数
    const dup = s.commands.find(c => c.taskId === opts.taskId && c.idempotencyKey === opts.idempotencyKey);
    if (dup) return { result: { task: cur, command: dup }, dirty: false };
    if (opts.expectedVersion != null && cur.version !== opts.expectedVersion) {
      throw new VersionConflictError(opts.taskId, opts.expectedVersion, cur.version);
    }
    // 门控复核：只在 observing 唤 (executor 本应继续却断开)
    if (cur.status !== 'observing') return { result: null, dirty: false };
    const now = new Date().toISOString();
    // 新 episode (上次 nudge 早于 episode anchor) → 计数从 1 重置；同 episode → 累加。
    const anchorMs = opts.episodeAnchorAt ? new Date(opts.episodeAnchorAt).getTime() : NaN;
    const lastNudgeMs = cur.lastNudgeAt ? new Date(cur.lastNudgeAt).getTime() : 0;
    const sameEpisode = Number.isFinite(anchorMs) ? lastNudgeMs >= anchorMs : true;
    const newCount = sameEpisode ? (cur.nudgeCount ?? 0) + 1 : 1;
    const command: OutboxCommand = {
      cmdId: genId('cmd'), taskId: opts.taskId, direction: 'parent_to_child', targetChatId: opts.targetChatId,
      commandType: 'nudge', payload: { targetRole: 'main' }, idempotencyKey: opts.idempotencyKey,
      expectedTaskVersion: cur.version + 1, deliveryStatus: 'pending', deliveredMessageId: null, relayRecordId: null,
      retryCount: 0, nextRetryAt: null, sentAt: null, ackedAt: null, supersededBy: null,
      lastError: null, createdAt: now, dispatchingUntil: null, dispatchAttemptId: null,
    };
    s.commands.push(command);
    s.subtasks[idx] = {
      ...cur, lastNudgeAt: now, nudgeCount: newCount,
      version: cur.version + 1, updatedAt: now,
    };
    logger.info(`[subtask-store] nudge enqueued ${opts.taskId}: episode count→${newCount} cmd=${command.cmdId}`);
    return { result: { task: s.subtasks[idx], command }, dirty: true };
  });
}

/**
 * 优化 #3 · 原子 helper（蔻黛克斯 #3-blocker2）：超过 MAX_NUDGES 仍无响应 → escalate 给父群。
 * observing → reported_help + 入队一条 child_to_parent report_help（合成 summary）一把原子。
 * **不复用 commitObservationTransaction**（停滞分支无 readToCursor/analyzedIds，避免空 observation 滥用）。
 * - 幂等：同 idempotencyKey 已存在 → 返既有、不重复转/不重复入队。
 * - 门控：仅 status==='observing' 才 escalate；转 reported_help 后停滞门控自然不再触发 (防重复)。
 */
export async function escalateStalledTask(opts: {
  taskId: string; idempotencyKey: string; summary: string; expectedVersion?: number;
}): Promise<{ task: SubTask; command: OutboxCommand | null } | null> {
  return mutate<{ task: SubTask; command: OutboxCommand | null } | null>(s => {
    const idx = s.subtasks.findIndex(t => t.taskId === opts.taskId);
    if (idx < 0) throw new TaskNotFoundError(opts.taskId);
    const cur = s.subtasks[idx];
    const dup = s.commands.find(c => c.taskId === opts.taskId && c.idempotencyKey === opts.idempotencyKey);
    if (dup) return { result: { task: cur, command: dup }, dirty: false };
    if (opts.expectedVersion != null && cur.version !== opts.expectedVersion) {
      throw new VersionConflictError(opts.taskId, opts.expectedVersion, cur.version);
    }
    if (cur.status !== 'observing') return { result: null, dirty: false };
    if (!isTransitionAllowed('observing', 'reported_help')) return { result: null, dirty: false };
    const now = new Date().toISOString();
    // 经理群上报泄漏修复：manager 停滞 escalate **不实时唤 CEO** —— 停滞 escalate 不属「仅 digest/request/urgent」
    // 3 条合法实时路径。改为落一条 signal='need_help' 的 observation (供定期 digest 携带「⚠️ 受阻」)，
    // 仍转 reported_help (停滞门控转态后自然不再触发)，但**不入队 report_help 命令**。
    if (isManager(cur)) {
      const dupObs = s.observations.find(o => o.taskId === opts.taskId && o.manualDedupeKey === opts.idempotencyKey);
      if (dupObs) return { result: { task: cur, command: null }, dirty: false }; // 幂等：同 episode 已落
      const observation: Observation = {
        obsId: genId('ob'), taskId: opts.taskId, at: now,
        readFromCursor: cur.committedCursor, readToCursor: cur.committedCursor,
        analyzedMessageIds: [], evidenceLinks: [], summary: opts.summary, signal: 'need_help',
        hasExecutorActivity: false, manualDedupeKey: opts.idempotencyKey,
      };
      s.observations.push(observation);
      s.subtasks[idx] = { ...cur, status: 'reported_help', version: cur.version + 1, updatedAt: now };
      logger.info(`[subtask-store] stall escalate ${opts.taskId} (manager): observing→reported_help obs=${observation.obsId} (digest, no realtime)`);
      return { result: { task: s.subtasks[idx], command: null }, dirty: true };
    }
    const command: OutboxCommand = {
      cmdId: genId('cmd'), taskId: opts.taskId, direction: 'child_to_parent', targetChatId: cur.parentChatId,
      commandType: 'report_help', payload: { summary: opts.summary }, idempotencyKey: opts.idempotencyKey,
      expectedTaskVersion: cur.version + 1, deliveryStatus: 'pending', deliveredMessageId: null, relayRecordId: null,
      retryCount: 0, nextRetryAt: null, sentAt: null, ackedAt: null, supersededBy: null,
      lastError: null, createdAt: now, dispatchingUntil: null, dispatchAttemptId: null,
    };
    s.commands.push(command);
    s.subtasks[idx] = {
      ...cur, status: 'reported_help', version: cur.version + 1, updatedAt: now,
    };
    logger.info(`[subtask-store] stall escalate ${opts.taskId}: observing→reported_help cmd=${command.cmdId}`);
    return { result: { task: s.subtasks[idx], command }, dirty: true };
  });
}

export function getCommand(cmdId: string): OutboxCommand | null {
  return read().commands.find(c => c.cmdId === cmdId) ?? null;
}
export function listCommands(taskId: string): OutboxCommand[] {
  return read().commands.filter(c => c.taskId === taskId);
}
/** 待投递 (pending、未 superseded、到期、且没被别的进程持有未过期 lease) 的命令。 */
export function listPendingCommands(now: Date = new Date()): OutboxCommand[] {
  return read().commands.filter(c =>
    c.deliveryStatus === 'pending' && c.supersededBy == null &&
    (c.nextRetryAt == null || new Date(c.nextRetryAt).getTime() <= now.getTime()) &&
    (c.dispatchingUntil == null || new Date(c.dispatchingUntil).getTime() <= now.getTime()),
  );
}

/** v2 异步对账：待确认命令 (record 已写、等异步确认到「已发送」)。复用 nextRetryAt 当「下次核对时间」、
 *  dispatchingUntil 当 lease。dispatcher 在投递 pending 之后再 reconcile 这批。 */
export function listUnconfirmedCommands(now: Date = new Date()): OutboxCommand[] {
  return read().commands.filter(c =>
    c.deliveryStatus === 'sent_unconfirmed' && c.supersededBy == null &&
    (c.nextRetryAt == null || new Date(c.nextRetryAt).getTime() <= now.getTime()) &&
    (c.dispatchingUntil == null || new Date(c.dispatchingUntil).getTime() <= now.getTime()),
  );
}
export async function updateCommand(cmdId: string, patch: Partial<Omit<OutboxCommand, 'cmdId' | 'taskId'>>): Promise<OutboxCommand | null> {
  return mutate(s => {
    const idx = s.commands.findIndex(c => c.cmdId === cmdId);
    if (idx < 0) return { result: null, dirty: false };
    s.commands[idx] = { ...s.commands[idx], ...patch };
    return { result: s.commands[idx], dirty: true };
  });
}

/** 投递前原子抢占 lease (review 硬约束1)：只有 pending+未superseded+(无lease或lease过期)
 *  才能 claim 成功，设 dispatchingUntil/dispatchAttemptId 并返回；否则返 null (别的进程在投/不可投)。
 *  多 daemon 并发时只有一个能 claim，杜绝重复投递。lease 过期 (deliver 卡死/进程崩) 后可被重 claim。 */
export async function claimCommandForDispatch(
  cmdId: string, attemptId: string, leaseMs: number, now: Date = new Date(),
): Promise<OutboxCommand | null> {
  return mutate(s => {
    const idx = s.commands.findIndex(c => c.cmdId === cmdId);
    if (idx < 0) return { result: null, dirty: false };
    const c = s.commands[idx];
    const leaseHeld = c.dispatchingUntil != null && new Date(c.dispatchingUntil).getTime() > now.getTime();
    // v2：pending (首投) 和 sent_unconfirmed (异步对账) 都可 claim；其余终态/superseded 不可。
    const claimable = c.deliveryStatus === 'pending' || c.deliveryStatus === 'sent_unconfirmed';
    if (!claimable || c.supersededBy != null || leaseHeld) {
      return { result: null, dirty: false };
    }
    s.commands[idx] = {
      ...c,
      dispatchingUntil: new Date(now.getTime() + leaseMs).toISOString(),
      dispatchAttemptId: attemptId,
    };
    return { result: s.commands[idx], dirty: true };
  });
}

/** 持 lease 的进程投递完成后回写结果 (review 硬约束1 + 退避锁内写)。
 *  CAS：dispatchAttemptId 必须仍是本次 attemptId (lease 没被抢走/过期重发) 才写，
 *  否则放弃 (本进程 lease 已失效被接管，避免覆盖新投递)。一并清掉 lease。
 *  retryCount/nextRetryAt/deliveryStatus 全在这一次锁内 mutation 写完，不裸 update。 */
export async function completeDispatch(
  cmdId: string, attemptId: string, patch: Partial<Omit<OutboxCommand, 'cmdId' | 'taskId'>>,
): Promise<OutboxCommand | null> {
  return mutate(s => {
    const idx = s.commands.findIndex(c => c.cmdId === cmdId);
    if (idx < 0) return { result: null, dirty: false };
    const cur = s.commands[idx];
    if (cur.dispatchAttemptId !== attemptId) {
      logger.warn(`[subtask-store] completeDispatch ${cmdId} lease lost (attempt ${attemptId} != ${cur.dispatchAttemptId}); skip write`);
      return { result: null, dirty: false };
    }
    // 单调终态守卫 (review Phase4 P1): acked 是终态。极端时序——lark 已发、主 bot 从消息体
    // commandId 抢先 ack、dispatcher 才慢一步 complete——complete 不得把 acked 降回 sent/failed/pending，
    // 只能补 deliveredMessageId/sentAt 等元数据。
    const safePatch = { ...patch };
    if (cur.deliveryStatus === 'acked' && safePatch.deliveryStatus && safePatch.deliveryStatus !== 'acked') {
      logger.info(`[subtask-store] completeDispatch ${cmdId}: already acked (terminal), drop downgrade→${safePatch.deliveryStatus}, keep metadata`);
      delete safePatch.deliveryStatus;
    }
    s.commands[idx] = { ...cur, ...safePatch, dispatchingUntil: null, dispatchAttemptId: null };
    return { result: s.commands[idx], dirty: true };
  });
}
export async function ackCommand(cmdId: string): Promise<OutboxCommand | null> {
  return updateCommand(cmdId, { deliveryStatus: 'acked', ackedAt: new Date().toISOString() });
}
export async function supersedeCommand(cmdId: string, by: string): Promise<OutboxCommand | null> {
  return updateCommand(cmdId, { supersededBy: by });
}

/** 求助命令的投递生命周期阶段 (P1: reported_help no-respam 必须绑 command lifecycle，不能只看 task status)。
 *  蔻黛克斯 review 要求的 6 态细分 —— 决定 reported_help+need_help 时是否补发求助：
 *  - none                : 状态 reported_help 但找不到 report_help 命令 (异常) → 兜底补发
 *  - pending             : 还没投出 / 等重试 → 在路上, 不补发
 *  - sent_unacked_fresh  : 已投、未 ack、未超时 → 等主 bot 回应, 不补发 (别 respam)
 *  - sent_unacked_expired: 已投、超 ackTimeoutMs 仍没 ack → 石沉大海 → 补发 + supersede 旧
 *  - failed              : 重试耗尽彻底失败 → 补发 + supersede 旧
 *  - acked               : 主 bot 已 query 确认 → 静默 (它正在处理/补充) */
export type HelpDelivery = 'none' | 'pending' | 'sent_unacked_fresh' | 'sent_unacked_expired' | 'failed' | 'acked';
export function helpReportDelivery(taskId: string, now: Date, ackTimeoutMs: number): HelpDelivery {
  const helps = read().commands
    .filter(c => c.taskId === taskId && c.commandType === 'report_help' && c.supersededBy == null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const latest = helps[helps.length - 1];
  if (!latest) return 'none';
  switch (latest.deliveryStatus) {
    case 'acked': return 'acked';
    case 'failed': return 'failed';
    case 'pending': return 'pending';
    // v2 P2 (蔻黛)：sent_unconfirmed = relay 还没确认送达 → **一律当在途 fresh、永不 expired**，
    // 绝不走 help 层换新 cmdId 补发。「确认前的投递/重发」由 dispatcher Phase B 复用同 cmdId 负责
    // (两层正交：Phase B=relay 投递层；help-respam=主bot 响应层)。只有**确认 sent 后**主bot 久未 ack，
    // 才按 ackTimeout 走 help 兜底重报。这样不会出现「旧 record 延迟发 + 新 cmdId help」两条 help。
    case 'sent_unconfirmed': return 'sent_unacked_fresh';
    case 'sent': {
      // 脏数据保守处理 (review P1-1): sent 却无有效 sentAt → 当没真送达, 偏 expired 允许补发,
      // 别因为缺时间戳就永远静默吞掉求助。
      const sentMs = latest.sentAt ? new Date(latest.sentAt).getTime() : NaN;
      if (!Number.isFinite(sentMs)) return 'sent_unacked_expired';
      return now.getTime() - sentMs > ackTimeoutMs ? 'sent_unacked_expired' : 'sent_unacked_fresh';
    }
    default: return 'pending';
  }
}
/** 该任务下所有"仍生效(未superseded)的 report_help"命令 id —— 补发新 help 时 supersede 它们。 */
export function staleHelpCommandIds(taskId: string): string[] {
  return read().commands
    .filter(c => c.taskId === taskId && c.commandType === 'report_help' && c.supersededBy == null)
    .map(c => c.cmdId);
}

/** 该任务**最近一次**上报的 report_help（含已 superseded —— 我们要的是"上次实际惊动父群的求助"，
 *  无论它后来有没有被新 help 取代）。用于 observing 路径按"新进展"去重（B 方案）+ 超时兜底重报：
 *  supplement 把状态切回 observing 后，对比本轮 need_help 的诉求/证据是否相对上次有实质新增；
 *  以及距上次上报是否已久且仍没人响应。
 *
 *  字段：
 *   - summary / sourceMessageIds：上次求助诉求 + 覆盖的证据消息（"新进展"判断）
 *   - sentAt：上次求助**实际投出**时间（超时兜底基准；未投出=null）
 *   - acked：是否已被主 bot query 回写 ack（= 有人在处理）
 *   - respondedBySupplement：该 help **之后**主 bot 是否下发过 supplement（= 主 bot 已实质介入）
 *   - lastRespondedAt：父群对该 help 的**最近一次响应时刻** = max(该 help 的 ackedAt, 该 help 之后最新一条
 *     supplement 的 createdAt)。无任何响应=null。超时兜底(shouldStaleRereport)以它为基准重新起算 2h，
 *     既给执行者按 supplement 推进的时间、又不会把"响应后仍卡死"的求助永久埋掉（蔻黛克斯 review）。
 *  没有任何 help 上报过则 null。 */
export function latestHelpReport(taskId: string): {
  summary: string; sourceMessageIds: string[];
  sentAt: string | null; acked: boolean; respondedBySupplement: boolean;
  lastRespondedAt: string | null;
} | null {
  const all = read().commands;
  const helps = all
    .filter(c => c.taskId === taskId && c.commandType === 'report_help')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const latest = helps[helps.length - 1];
  if (!latest) return null;
  // 主 bot 在该 help 之后下发过 supplement（parent→child）→ 视为已实质介入。
  const supplementsAfter = all
    .filter(c => c.taskId === taskId && c.commandType === 'supplement' &&
      c.createdAt.localeCompare(latest.createdAt) > 0)
    .map(c => c.createdAt);
  const respondedBySupplement = supplementsAfter.length > 0;
  // 最近一次响应时刻：ack 与"该 help 之后的 supplement"取较晚者。
  const respondedTimes = [...supplementsAfter];
  if (latest.ackedAt) respondedTimes.push(latest.ackedAt);
  const lastRespondedAt = respondedTimes.length
    ? respondedTimes.sort((a, b) => a.localeCompare(b))[respondedTimes.length - 1]
    : null;
  return {
    summary: latest.payload.summary ?? '', sourceMessageIds: latest.payload.sourceMessageIds ?? [],
    sentAt: latest.sentAt, acked: latest.ackedAt != null, respondedBySupplement, lastRespondedAt,
  };
}

// ─── Observation ─────────────────────────────────────────────────────────────

/** 列某 task 的 observation。
 *  - 旧签名 `listObservations(taskId, 5)`：返回最近 limit 条 (尾部)，行为不变 (向后兼容)。
 *  - 新签名 `listObservations(taskId, {since, limit})`：先按 `Observation.at >= since` 过滤 (bounded
 *    lookback，digest 用)，再取尾部 limit 条。两参均可选。 */
export function listObservations(
  taskId: string,
  limitOrOpts?: number | { since?: string; limit?: number },
): Observation[] {
  let obs = read().observations.filter(o => o.taskId === taskId);
  if (typeof limitOrOpts === 'number') {
    return obs.slice(-limitOrOpts);
  }
  if (limitOrOpts && typeof limitOrOpts === 'object') {
    const { since, limit } = limitOrOpts;
    if (since) {
      const sinceMs = new Date(since).getTime();
      if (Number.isFinite(sinceMs)) obs = obs.filter(o => new Date(o.at).getTime() >= sinceMs);
    }
    return limit != null ? obs.slice(-limit) : obs;
  }
  return obs;
}

// ─── 清理 ─────────────────────────────────────────────────────────────────────

export async function pruneFinished(now: Date = new Date(), ttlDays = 7): Promise<number> {
  const TTL = ttlDays * 24 * 60 * 60 * 1000;
  return mutate(s => {
    const before = s.subtasks.length;
    const keepIds = new Set<string>();
    s.subtasks = s.subtasks.filter(t => {
      const terminal = t.status === 'finished' || t.status === 'stopped';
      const old = now.getTime() - new Date(t.updatedAt).getTime() > TTL;
      const keep = !(terminal && old);
      if (keep) keepIds.add(t.taskId);
      return keep;
    });
    const removed = before - s.subtasks.length;
    if (removed > 0) {
      s.commands = s.commands.filter(c => keepIds.has(c.taskId));
      s.observations = s.observations.filter(o => keepIds.has(o.taskId));
      logger.info(`[subtask-store] pruned ${removed} terminal subtask(s)`);
    }
    return { result: removed, dirty: removed > 0 };
  });
}

/** 测试用 (直接写，不走锁)。 */
export function __resetForTesting(): void {
  write({ subtasks: [], commands: [], observations: [] });
}
