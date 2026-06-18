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
import { HttpError, resolveBotIdent } from '../core/main-bot-playbook.js';
import { getCompanyByRootChatId, getMainTopicBotRef, getMainTopicChatId, type CompanyConfig } from './main-topic-config.js';
import { getOrCompute, type IdempotencyEntry } from './spawn-idempotency-store.js';
import { createGroupWithBots } from './group-creator.js';
import { getSession } from './session-store.js';
import { logger } from '../utils/logger.js';
import { ensureCloneScopesProvisioned } from './clone-scope-provisioning.js';
import type { Session } from '../types.js';
import {
  createSubTask, getSubTask, getByChatId, getCommand, transitionStatus, enqueueCommand, ackCommand,
  transitionAndEnqueueCommand, listObservations, listCommands, listSubTasks,
  helpReportDelivery, ACTIVE_STATUSES, isManager, shouldRealtimePush, recordManualDoneObservation, recordManualHelpObservation,
  VersionConflictError, CommandRetryMismatchError,
  type SubTask, type SubTaskBot, type SubTaskStatus, type OutboxCommand, type Observation,
  type CommandTargetRole,
} from './subtask-store.js';
import { SUBTASK_COLLAB_NORMS } from './subtask-norms.js';
import { writeLetter, readLetter } from './mailbox.js';
import { enqueueEntry, listInbox, markRead, type ReportKind, type InboxEntry } from './ceo-inbox-store.js';

/** v2 编排链路标记 —— 进 chatContext.relatedRefs，dashboard/welcome card 可见，
 *  跟旧 watcher 链路区分 (边界3)。 */
export const V2_MARKER = 'subtaskOrchestrationVersion:v2';

const BOT_META: Record<'claude' | 'codex' | 'tilly', { name: string; role: SubTaskBot['role'] }> = {
  claude: { name: '克劳德', role: 'main' },
  codex: { name: '蔻黛克斯', role: 'collab' },
  tilly: { name: '缇蕾', role: 'observer' },
};

/** Built-in alias (lower-cased) → BOT_META key. Covers short codes (c/k/t) and
 *  full names so `bots:['c']` / `['CLAUDE']` keep the legacy name+role. Any ref
 *  not here is an arbitrary bot (clone) → name from registry, role defaults to
 *  'collab'. */
const ALIAS_TO_META_KEY: Record<string, keyof typeof BOT_META> = {
  claude: 'claude', c: 'claude',
  codex: 'codex', k: 'codex',
  tilly: 'tilly', t: 'tilly',
};

/** Roles a `--bots ref:role` suffix may set. */
const VALID_ROLES = new Set<string>(['main', 'collab', 'observer']);

function isAutoCloneBotEntry(entry: string): boolean {
  const lower = entry.trim().toLowerCase();
  return lower.startsWith('auto@') || lower.startsWith('auto:');
}

/** Exported so the CEO-spawn key (ceo-spawn-store) mirrors createSubtask's
 *  idempotencyKey exactly (块7 第二轮 #5: subgroup + CEO-spawn state share one key). */
export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'task';
}

/** djb2 短哈希 (supplement idempotencyKey 用内容算稳定 key)。 */
export function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** session.larkAppId 反查到对应 bot 的 openId (report 鉴权: 发起 bot ∈ task.bots)。 */
function sessionBotOpenId(larkAppId?: string): string | null {
  if (!larkAppId) return null;
  try { return resolveBotIdent(larkAppId).openId; }
  catch { return null; }
}

/** Match a task participant from the current session. Prefer larkAppId because
 *  Lark open_id is app-scoped; older tasks without larkAppId still fall back to
 *  the historical openId check. */
function sessionTaskBot(task: SubTask, larkAppId?: string): SubTaskBot | undefined {
  if (!larkAppId) return undefined;
  const byAppId = task.bots.find(b => b.larkAppId === larkAppId);
  if (byAppId) return byAppId;
  const botOpenId = sessionBotOpenId(larkAppId);
  return botOpenId ? task.bots.find(b => b.openId === botOpenId) : undefined;
}

/** session.larkAppId 反查 bot key（createdBy 记真实创建者用）。 */
function sessionBotKey(larkAppId?: string): string | null {
  if (!larkAppId) return null;
  try { return resolveBotIdent(larkAppId).name; }
  catch { /* fallback to legacy aliases below */ }
  for (const k of ['claude', 'codex', 'tilly'] as const) {
    if (resolveBotIdent(k).larkAppId === larkAppId) return k;
  }
  return null;
}

// ─── 嵌套子任务：G 闸阈值（全部 env 可调；惰性读取便于测试与调参；**只对嵌套分支生效**，
//     主话题建子任务行为与存量 100% 一致）────────────────────────────────────────
function envPosInt(name: string, def: number, min = 1): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : def;
}
const maxSubtaskDepth = () => envPosInt('BOTMUX_MAX_SUBTASK_DEPTH', 2);              // G2
const maxActiveChildren = () => envPosInt('BOTMUX_MAX_ACTIVE_CHILDREN', 3);          // G3
const maxActivePerTree = () => envPosInt('BOTMUX_MAX_ACTIVE_PER_TREE', 4);           // G4 (保守首发 4，方案上限 8)
const maxActiveGlobal = () => envPosInt('BOTMUX_MAX_ACTIVE_GLOBAL', 15);             // G5
const spawnMinIntervalMs = () => envPosInt('BOTMUX_SPAWN_MIN_INTERVAL_MS', 60_000);  // G6
/** 防环 walk 步数上限（深度上限远小于它，越界=数据脏/成环）。 */
const PARENT_WALK_MAX = 16;

/** 老数据归一化：rootChatId 缺省时按 parentChatId 推定（G4 聚合 / 级联 DFS 共用，只读不回写）。 */
function rootOf(t: SubTask, mainTopic: string | null | undefined): string {
  if (t.rootChatId) return t.rootChatId;
  return t.parentChatId === mainTopic ? (mainTopic ?? t.parentChatId) : t.parentChatId;
}

/** 嵌套 spawn 鉴权上下文：InternalSpawnContext 超集（主话题路径字段同名同值）。 */
interface SpawnCtx {
  callerChatId: string;
  callerBotAppId: string;
  rootMessageId: string;
  ownerOpenId?: string;
  depth: number;            // 调用方所在层（0=主话题）；新任务 depth = 此值 + 1
  rootChatId: string;
  parentTask: SubTask | null;
}

/**
 * 嵌套建群鉴权（替代 v2 链路对 authzCheck 的复用；v1 playbook 仍走 authzCheck，主话题 only 不动）。
 * 主话题分支与原 authzCheck 语义逐字等价；嵌套分支以 subtask-store + sessionStore 为权威（D1），
 * 闸序：G7 总开关 → 登记任务群 → ACTIVE → G1 spawnable → 执行者(main) bot。
 */
async function authzSpawn(sessionId: string): Promise<SpawnCtx> {
  if (!sessionId) throw new HttpError(400, 'missing sessionId');
  const legacyMainTopic = getMainTopicChatId();
  const session = getSession(sessionId);
  if (!session) throw new HttpError(403, `unknown session: ${sessionId}`);
  const rootCompany = getCompanyByRootChatId(session.chatId);
  const mainTopic = rootCompany?.rootChatId ?? legacyMainTopic;
  if (!mainTopic) throw new HttpError(500, 'mainTopicChatId/company root not configured — run `botmux create-company --ceo <bot>` or `botmux config set-main-topic <chatId>`');

  if (session.chatId === mainTopic) {
    // —— 主话题分支：与 authzCheck (main-bot-playbook.ts) 行为 100% 一致 ——
    const mainBotApp = rootCompany?.ceoLarkAppId ?? resolveBotIdent(getMainTopicBotRef(mainTopic)).larkAppId;
    if (session.larkAppId !== mainBotApp) {
      throw new HttpError(403, `only main bot can spawn subtasks (session.larkAppId=${session.larkAppId}, expected=${mainBotApp})`);
    }
    return {
      callerChatId: session.chatId, callerBotAppId: session.larkAppId,
      rootMessageId: session.rootMessageId, ownerOpenId: session.ownerOpenId,
      depth: 0, rootChatId: mainTopic, parentTask: null,
    };
  }

  // —— 嵌套分支：子群建孙群 ——
  if (process.env.BOTMUX_NESTED_SUBTASK === '0') {
    throw new HttpError(403, 'nested subtask globally disabled (BOTMUX_NESTED_SUBTASK=0)');
  }
  if (!session.larkAppId) {
    throw new HttpError(403, `session has no larkAppId; cannot identify caller bot`);
  }
  const task = getByChatId(session.chatId);
  if (!task) {
    throw new HttpError(403, `spawn only allowed from main topic or a registered task chat (session.chatId=${session.chatId})`);
  }
  if (!ACTIVE_STATUSES.includes(task.status)) {
    throw new HttpError(403, `task ${task.taskId} is not active (status=${task.status}); cannot spawn from it`);
  }
  if (task.spawnable !== true) {
    throw new HttpError(403, `task ${task.taskId} is not spawnable (create 时未授权 --spawnable)`);
  }
  const callerBot = sessionTaskBot(task, session.larkAppId);
  if (callerBot?.role !== 'main') {
    throw new HttpError(403, `only this chat's registered executor (main bot) can spawn (caller larkAppId=${session.larkAppId})`);
  }
  // owner 链 + 跨 app scope 防护 (蔻黛克斯 review blocker)：open_id 是 app-scoped，而 createSubtask
  // 固定以配置的 main-bot app 建群 (group-creator 合同: userOpenIds 必须 creator scope)。非 main-bot 执行者
  // 会话里的 ownerOpenId 是它自己 app 视角的 id，直接用会让 owner 邀请失败 → base relay 投不进新群。
  // 所以只有 main-bot 会话的 ownerOpenId 可直接用；其余回退父任务 requester —— 整条建树链的 requester
  // 都由 main-bot 链路写入，恒为 main-bot scope。'owner' 是历史占位符，视为无效。
  const taskCompany = getCompanyByRootChatId(task.rootChatId ?? rootOf(task, getMainTopicChatId()));
  const mainBotApp = taskCompany?.ceoLarkAppId ?? resolveBotIdent(getMainTopicBotRef(taskCompany?.rootChatId)).larkAppId;
  const inheritedRequester = task.requester && task.requester !== 'owner' ? task.requester : undefined;
  const ownerOpenId = (session.larkAppId === mainBotApp ? session.ownerOpenId : undefined) ?? inheritedRequester;
  return {
    callerChatId: session.chatId, callerBotAppId: session.larkAppId,
    rootMessageId: session.rootMessageId,
    ownerOpenId,
    depth: task.depth ?? 1, rootChatId: rootOf(task, mainTopic), parentTask: task,
  };
}

/** 防环 walk：create 前沿 parentChatId 上溯，成环/超步数拒绝（防脏数据放大成无限树）。 */
function assertNoCycle(startChatId: string, mainTopic: string): void {
  const visited = new Set<string>([startChatId]);
  let cur = getByChatId(startChatId);
  let steps = 0;
  while (cur && cur.parentChatId !== mainTopic) {
    if (visited.has(cur.parentChatId) || ++steps > PARENT_WALK_MAX) {
      throw new HttpError(422, `subtask parent chain corrupt (cycle or >${PARENT_WALK_MAX} hops) at ${cur.taskId}`);
    }
    visited.add(cur.parentChatId);
    cur = getByChatId(cur.parentChatId);
  }
}

/** 父群 orchestrator bot 解析：父群是任务群 → 它登记的 main bot；父=主话题 → 配置的 main bot。 */
function resolveCompanyCeoOpenId(company: CompanyConfig | null): string {
  if (company?.ceoOpenId) return company.ceoOpenId;
  if (company?.ceoLarkAppId) return resolveBotIdent(company.ceoLarkAppId).openId;
  return resolveBotIdent(getMainTopicBotRef(company?.rootChatId)).openId;
}

function parentOrchestratorOpenId(task: SubTask): string {
  const parentTask = getByChatId(task.parentChatId);
  const company = getCompanyByRootChatId(task.rootChatId ?? task.parentChatId);
  return parentTask?.bots.find(b => b.role === 'main')?.openId
    ?? resolveCompanyCeoOpenId(company);
}

/** 父群主 bot 鉴权：session 合法 + 是该 task 父群的 orchestrator bot（父=主话题→克劳德）+
 *  只能从该 task 的父群操作。嵌套后逐级各自成立。 */
function authzParentBot(sessionId: string, taskId: string): { session: Session; task: SubTask } {
  const session = getSession(sessionId);
  if (!session) throw new HttpError(403, `unknown session: ${sessionId}`);
  const task = getSubTask(taskId);
  if (!task) throw new HttpError(404, `subtask not found: ${taskId}`);
  const botOpenId = sessionBotOpenId(session.larkAppId);
  if (!botOpenId || botOpenId !== parentOrchestratorOpenId(task)) {
    throw new HttpError(403, 'only the parent-chat orchestrator bot can operate this subtask');
  }
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
  /** Bot refs: legacy aliases (claude/codex/tilly/c/k/t) OR any registered
   *  bot's botName / larkAppId (clones). Default = the original 3 bots. */
  bots?: string[];
  taskType?: 'prd' | 'bug' | 'misc';
  name?: string;
  relatedRefs?: string[];
  parentDigest?: string;
  /** G1: 新任务是否允许其子群再 spawn（create 一锤定音，默认 false）。 */
  spawnable?: boolean;
  /** 双层汇报：true=部门经理(manager，门控+定期 digest)；缺省/false=执行者(executor，实时直报)。 */
  manager?: boolean;
  /** Explicit opt-out for executor groups that intentionally do not want an observer bot. */
  noObserver?: boolean;
}

export async function createSubtask(req: CreateSubtaskReq): Promise<{ taskId: string; chatId: string; isNew: boolean }> {
  if (!req.goal?.trim()) throw new HttpError(400, 'missing goal');
  const ctx = await authzSpawn(req.sessionId);              // 主话题=原 authzCheck 语义；子群=嵌套闸
  const session = getSession(req.sessionId);                // for ownerOpenId

  // ─── G2-G6：fork-bomb 闸（**只对嵌套分支**——主话题建子任务行为与存量逐字一致；
  //     计数=锁外读快照，极端并发瞬时超限 1 可接受，确定性硬闸是 G1/G2/G7）。
  //     触发 422/429 + 明确文案，执行者按 routing 转 askforhelp 不自旋。
  const newDepth = ctx.depth + 1;
  // 输入校验（非 fork-bomb 闸，主话题分支也适用）：depth 触顶的新任务授 spawnable 无意义——
  // 它再 spawn 必被 G2 拦，注入段还会出现「还能开 0 层」的误导文案。create 一锤定音，直接拒。
  if (req.spawnable === true && newDepth >= maxSubtaskDepth()) {
    throw new HttpError(400, `spawnable 无意义：新任务 depth=${newDepth} 已达上限 ${maxSubtaskDepth()}，其子群不可能再 spawn（去掉 --spawnable 重试）`);
  }
  // 双层汇报 Block4：创建 manager 的**授权边界**（防预算绕过）。manager 不占/不受 fork-bomb 预算，
  // 若任何 spawnable executor 都能给孙群加 --manager，预算闸就被 worker 自助软绕开。规则：manager 只能由
  // **主话题（depth 0，主 bot）** 或 **本身是 manager 的父任务** 创建；executor 子群创建 manager → 403。
  if (req.manager === true) {
    const allowed = ctx.parentTask === null || isManager(ctx.parentTask);
    if (!allowed) {
      throw new HttpError(403, 'executor 子群不能创建 manager 子群（防预算绕过）；manager 由主话题或上级 manager 创建');
    }
  }
  if (ctx.parentTask) {
    if (newDepth > maxSubtaskDepth()) {
      throw new HttpError(422, `subtask depth limit exceeded (depth=${newDepth} > max=${maxSubtaskDepth()}); 把这一步并入当前任务或上报父群拆解`);
    }
    assertNoCycle(ctx.callerChatId, getMainTopicChatId()!);
    // 双层汇报 Block4：预算闸（G3/G4/G5/G6）只统计 **executor** 子任务——manager 是组织协调层，
    // 不计入预算、也不受预算限制。① 新建 manager → 整块跳过；② 新建 executor → 用 activeExecutors 当分母。
    if (req.manager !== true) {
      const active = listSubTasks({ statuses: ACTIVE_STATUSES });
      const activeExecutors = active.filter(t => !isManager(t));   // manager 不占预算
      const mainTopicForRoot = getMainTopicChatId();
      const siblings = activeExecutors.filter(t => t.parentChatId === ctx.callerChatId);
      if (siblings.length >= maxActiveChildren()) {
        throw new HttpError(429, `active children limit reached for this chat (${siblings.length}/${maxActiveChildren()}); 先收尾再派新的`);
      }
      const treePeers = activeExecutors.filter(t => rootOf(t, mainTopicForRoot) === ctx.rootChatId);
      if (treePeers.length >= maxActivePerTree()) {
        throw new HttpError(429, `active subtask budget for this tree reached (${treePeers.length}/${maxActivePerTree()}, root=${ctx.rootChatId.slice(0, 12)})`);
      }
      if (activeExecutors.length >= maxActiveGlobal()) {
        throw new HttpError(429, `global active subtask limit reached (${activeExecutors.length}/${maxActiveGlobal()})`);
      }
      const newestInTree = treePeers.map(t => t.createdAt).sort().at(-1);
      if (newestInTree && Date.now() - Date.parse(newestInTree) < spawnMinIntervalMs()) {
        throw new HttpError(429, `spawning too fast in this tree (min interval ${spawnMinIntervalMs()}ms); 稍后重试`);
      }
    }
  }

  const botKeys = req.bots ?? ['claude', 'codex', 'tilly'];
  // N-bot: each ref is a built-in alias (claude/codex/tilly/c/k/t) OR any
  // registered bot's name/appId (clones). Legacy aliases keep their exact
  // BOT_META name/role (byte-equivalent); arbitrary refs derive name from the
  // registry and default to 'collab' (explicit roles land in the CLI parser).
  const resolveBotEntry = (entry: string) => {
    // Each entry is `ref` or `ref:role` (role ∈ main|collab|observer). The role
    // suffix is an explicit override; without it we fall back to the alias's
    // legacy role, else 'collab'.
    if (isAutoCloneBotEntry(entry)) {
      throw new HttpError(400, `subtask-start --bots does not support auto-clone syntax "${entry}"; use an existing clone appId/name in --bots (for example cli_xxx:collab), or use ceo-spawn --seats for auto-clone`);
    }
    const ci = entry.indexOf(':');
    const ref = ci >= 0 ? entry.slice(0, ci) : entry;
    const explicitRole = ci >= 0 ? entry.slice(ci + 1).trim().toLowerCase() : '';
    if (explicitRole && !VALID_ROLES.has(explicitRole)) {
      throw new HttpError(400, `invalid role "${explicitRole}" for bot "${ref}" (allowed: main|collab|observer)`);
    }
    let ident: ReturnType<typeof resolveBotIdent>;
    try {
      ident = resolveBotIdent(ref);
    } catch {
      throw new HttpError(400, `unknown bot ref: ${ref} (use claude|codex|tilly|c|k|t or a registered bot name/appId)`);
    }
    // Canonicalize built-in aliases (incl. short codes + case) to a BOT_META key
    // for the default name/role — `c`/`CLAUDE` keep the legacy 本体 main, not collab.
    const metaKey = ALIAS_TO_META_KEY[ref.toLowerCase()];
    const meta = metaKey ? BOT_META[metaKey] : undefined;
    const role = (explicitRole || meta?.role || 'collab') as SubTaskBot['role'];
    return { key: ref, ident, name: meta?.name ?? ident.name, role };
  };
  const resolved = botKeys.map(resolveBotEntry);
  const isExecutorGroup = req.manager !== true && resolved.some(r => r.role === 'main');
  const tillyApp = resolveBotIdent('tilly').larkAppId;
  if (isExecutorGroup && req.noObserver !== true && !resolved.some(r => r.ident.larkAppId === tillyApp)) {
    resolved.push(resolveBotEntry('tilly:observer'));
  }
  const company = getCompanyByRootChatId(ctx.rootChatId);
  const creatorApp = company?.ceoLarkAppId ?? resolveBotIdent(getMainTopicBotRef(ctx.rootChatId)).larkAppId;
  const larkAppIds = resolved.map(r => r.ident.larkAppId);
  const subtaskBots: SubTaskBot[] = resolved.map(r => ({ openId: r.ident.openId, name: r.name, role: r.role, larkAppId: r.ident.larkAppId }));

  await ensureCloneScopesProvisioned({
    creatorLarkAppId: creatorApp,
    chatId: ctx.callerChatId,
    bots: resolved.map(r => ({ larkAppId: r.ident.larkAppId, name: r.name, role: r.role })),
  });

  // 边界4: 建群 + 登记串同一 idempotencyKey。crash window 安全靠两步同 key。
  // review Blocker: slug(goal) 对中文全压成 'task' → 同 root 下不同中文 goal 会碰撞 dedup。
  // 必须带 full goal 的稳定 hash，让"同 root 不同 goal"不 dedup、"同 root 同 goal 重试"才 dedup。
  // 嵌套：前缀 callerChatId —— chat-scope session 的 rootMessageId 只是起始消息 id，跨树有撞键面；
  // 加前缀后跨树同 goal 永不互踩、同群重试仍 dedup。
  const idempotencyKey = `${ctx.callerChatId}-${ctx.rootMessageId}-${slug(req.goal)}-${djb2(req.goal)}`;

  const { entry, cacheHit } = await getOrCompute(idempotencyKey, async (): Promise<IdempotencyEntry> => {
    const result = await createGroupWithBots({
      creatorLarkAppId: creatorApp,
      larkAppIds,
      // base relay 以 owner 身份写「接收群组」字段；owner 不在目标群时，
      // Base 会把该 oc_id 判为 800030410/not_found，kickoff/supplement 永远投不出。
      // 嵌套分支 session.ownerOpenId 可能缺 → 回退父任务 requester（authzSpawn 已并入 ctx.ownerOpenId）。
      userOpenIds: ctx.ownerOpenId ? [ctx.ownerOpenId] : undefined,
      name: req.name ?? `子任务·${req.goal.slice(0, 20)}`,
      sourceChatId: ctx.callerChatId,
      purpose: req.goal,
      chatContext: {
        taskType: req.taskType,
        relatedRefs: [V2_MARKER, ...(req.relatedRefs ?? [])], // 边界3: v2 marker
        participants: resolved.map(r => ({ openId: r.ident.openId, role: r.role })),
        parentDigest: req.parentDigest,
        rules: [...SUBTASK_COLLAB_NORMS], // 优化 #2: 固化协作 norms 进群规则 (欢迎卡 + <rules> 注入)
      },
    });
    return { key: idempotencyKey, chatId: result.chatId, createdAt: new Date().toISOString() };
  });

  // 边界2+4: 登记进 subtask-store (新 observer/dispatcher source of truth)。createSubTask 幂等同 key →
  // "建群成功但登记失败" 重试时复用 chatId + 补登记，不重复建群。
  const task = await createSubTask({
    chatId: entry.chatId, parentChatId: ctx.callerChatId, parentMessageId: ctx.rootMessageId,
    goal: req.goal, acceptance: req.acceptance ?? null, bots: subtaskBots,
    requester: ctx.ownerOpenId ?? 'owner',
    createdBy: sessionBotKey(session?.larkAppId) ?? 'claude',   // 记真实创建 bot（嵌套后不再恒为 claude）
    idempotencyKey,
    depth: newDepth, rootChatId: ctx.rootChatId, spawnable: req.spawnable === true,
    reportingMode: req.manager === true ? 'manager' : 'executor',
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

export async function reportProgress(req: ReportProgressReq): Promise<{ cmdId?: string; taskId: string; suppressed?: boolean; enteredDigest?: boolean; obsId?: string; deduped?: boolean }> {
  const session = getSession(req.sessionId);
  if (!session) throw new HttpError(403, `unknown session: ${req.sessionId}`);
  const task = getSubTask(req.taskId);
  if (!task) throw new HttpError(404, `subtask not found: ${req.taskId}`);
  // 鉴权: 只能从该任务的子群上报 + 发起 bot ∈ task.bots (review P1)
  if (session.chatId !== task.chatId) {
    throw new HttpError(403, `report_progress must come from the subtask chat (session.chatId=${session.chatId}, task.chatId=${task.chatId})`);
  }
  const callerBot = sessionTaskBot(task, session.larkAppId);
  if (!callerBot) {
    throw new HttpError(403, `reporting bot (larkAppId=${session.larkAppId}) is not a participant of this subtask`);
  }
  if (!req.summary?.trim()) throw new HttpError(400, 'missing summary');
  if (task.status === 'finished' || task.status === 'stopped') {
    throw new HttpError(409, `subtask already ${task.status}; ${req.type} report suppressed`);
  }
  // 双层汇报推送门控：manager 子群的手动 done 是 routine，不实时推父群——落一条游标中性 observation
  // (signal=done, statusTo=reported_done, 幂等) 保住显式 summary，由定期 digest 上报。
  if (req.type === 'done' && isManager(task) && !shouldRealtimePush(task, 'manual_done')) {
    const dedupeKey = req.idempotencyKey
      ?? (req.sourceMessageIds?.length ? `manualdone-${req.sourceMessageIds.join(',')}` : `manualdone-${task.taskId}-${djb2(req.summary)}`);
    const res = await recordManualDoneObservation({
      taskId: task.taskId, summary: req.summary, manualDedupeKey: dedupeKey, sourceMessageIds: req.sourceMessageIds,
    });
    if (!res) throw new HttpError(404, `subtask not found: ${req.taskId}`);
    logger.info(`[subtask-orch] report_progress ${task.taskId} manager manual_done → digest (obs=${res.observation.obsId} deduped=${res.deduped})`);
    return { taskId: task.taskId, suppressed: true, enteredDigest: true, obsId: res.observation.obsId, deduped: res.deduped };
  }
  // 经理群上报泄漏修复：manager 子群的手动 need_help / askforhelp **也是 routine**（need_help ≠ urgent）——
  // 与 manual_done 对称折叠：落 signal='need_help' 游标中性 observation 保住 summary，由定期 digest 携带「⚠️ 受阻」，
  // **不入队 report_help、不实时唤 CEO**。manager 唯一实时路径 = subtask-manager-report --urgency urgent（report_urgent）。
  // （原 assertManagerRealtimeJustified('need_help') 已移除：need_help 不再实时，该 reason 门控对它失去意义；
  //   summary 非空已在上方强校验。urgent 路径的 reason 门控在 managerReport 内保留。）
  if (req.type === 'need_help' && isManager(task) && !shouldRealtimePush(task, 'manual_help')) {
    const dedupeKey = req.idempotencyKey
      ?? (req.sourceMessageIds?.length ? `manualhelp-${req.sourceMessageIds.join(',')}` : `manualhelp-${task.taskId}-${djb2(req.summary)}`);
    const res = await recordManualHelpObservation({
      taskId: task.taskId, summary: req.summary, manualDedupeKey: dedupeKey, sourceMessageIds: req.sourceMessageIds,
    });
    if (!res) throw new HttpError(404, `subtask not found: ${req.taskId}`);
    logger.info(`[subtask-orch] report_progress ${task.taskId} manager manual_help → digest (obs=${res.observation.obsId} deduped=${res.deduped})`);
    return { taskId: task.taskId, suppressed: true, enteredDigest: true, obsId: res.observation.obsId, deduped: res.deduped };
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
export async function askForHelp(req: AskForHelpReq): Promise<{ cmdId?: string; taskId: string; suppressed?: boolean; enteredDigest?: boolean; obsId?: string; deduped?: boolean }> {
  // type=need_help → 走 reportProgress：executor 子群 enqueue report_help 实时推 (返 cmdId)；
  // 经理群上报泄漏修复后，manager 子群折叠进 digest (返 suppressed/enteredDigest，不实时唤 CEO)。
  return reportProgress({ sessionId: req.sessionId, taskId: req.taskId, type: 'need_help', summary: req.summary, sourceMessageIds: req.sourceMessageIds, idempotencyKey: req.idempotencyKey });
}

// ─── request_review (优化 #1 时序门控) ──────────────────────────────────────────
export interface RequestReviewReq {
  sessionId: string;
  taskId: string;
  summary: string;          // 必须含可打开的飞书链接或本机绝对路径 (N2)
  sourceMessageIds?: string[];
  idempotencyKey?: string;
}

/** N2：summary 必须含可打开的飞书/http 链接，或本机绝对路径 (以 / 开头的路径 token)。 */
function hasOpenableRef(s: string): boolean {
  return /https?:\/\//i.test(s) || /(^|\s)\/[^\s]+/.test(s);
}

/**
 * 优化 #1：执行者产出第一份可 review 物后，**显式**唤起 reviewer。kickoff 只唤执行者、reviewer
 * 此前不被唤起 → 物理上杜绝 reviewer 抢活。鉴权复用子群形状 (非 authzParentBot，蔻黛克斯 #1-major4)：
 * 必须从该子群、由本任务 **main(执行者)** 调用。幂等不按 summary hash (蔻黛克斯 #1-blocker2)。
 */
export async function requestReview(req: RequestReviewReq): Promise<{ cmdId: string; taskId: string }> {
  const session = getSession(req.sessionId);
  if (!session) throw new HttpError(403, `unknown session: ${req.sessionId}`);
  const task = getSubTask(req.taskId);
  if (!task) throw new HttpError(404, `subtask not found: ${req.taskId}`);
  // 鉴权：只能从该子群调
  if (session.chatId !== task.chatId) {
    throw new HttpError(403, `request_review must come from the subtask chat (session.chatId=${session.chatId}, task.chatId=${task.chatId})`);
  }
  // 发起方必须是本任务的 main(执行者)
  const me = sessionTaskBot(task, session.larkAppId);
  if (!me) throw new HttpError(403, `requesting bot (larkAppId=${session.larkAppId}) is not a participant of this subtask`);
  if (me.role !== 'main') throw new HttpError(403, `only the executor(main) bot can request review (caller role=${me.role})`);
  // 必须有 reviewer 可唤 (蔻黛克斯 #1-blocker3：空集合不发空名单)
  if (!task.bots.some(b => b.role === 'collab')) {
    throw new HttpError(409, 'no reviewer (collab) in this subtask — nothing to wake');
  }
  if (!req.summary?.trim()) throw new HttpError(400, 'missing summary');
  if (!hasOpenableRef(req.summary)) {
    throw new HttpError(400, 'request_review summary 必须含可打开的飞书链接或本机绝对路径 (N2)，别只发聊天摘要');
  }
  if (task.status === 'finished' || task.status === 'stopped') {
    throw new HttpError(409, `subtask already ${task.status}; request_review suppressed`);
  }
  // 幂等：显式 key > sourceMessageIds > randomUUID。**不按 summary hash** (同一路径多轮复用会误 dedup)。
  const idempotencyKey = req.idempotencyKey
    ?? (req.sourceMessageIds?.length ? `review-${req.sourceMessageIds.join(',')}` : `review-${randomUUID()}`);
  const cmd = await enqueueCommand({
    taskId: task.taskId, direction: 'parent_to_child', targetChatId: task.chatId,
    commandType: 'request_review', payload: { summary: req.summary, sourceMessageIds: req.sourceMessageIds, targetRole: 'collab' },
    idempotencyKey, expectedTaskVersion: task.version,
  });
  logger.info(`[subtask-orch] request_review ${task.taskId} cmd=${cmd.cmdId}`);
  return { cmdId: cmd.cmdId, taskId: task.taskId };
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
  // 鉴权: 父群 orchestrator bot 且只能从该 task 的父群查（嵌套后逐级各自成立，同 authzParentBot 闸）
  const botOpenId = sessionBotOpenId(session.larkAppId);
  if (!botOpenId || botOpenId !== parentOrchestratorOpenId(task)) {
    throw new HttpError(403, 'only the parent-chat orchestrator bot can query this subtask');
  }
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
export interface FinishSubtaskReq {
  sessionId: string; taskId: string; expectedVersion?: number; note?: string; force?: boolean;
  /** 级联收尾：存在 ACTIVE 子任务时默认 409；显式 --cascade 才 DFS 自底向上逐个 finish。 */
  cascade?: boolean;
}

/** 收集 chatId 的全部 ACTIVE 后代任务，深度优先、返回序=自底向上（叶子在前）。 */
function collectActiveDescendantsBottomUp(rootChatId: string): SubTask[] {
  const active = listSubTasks({ statuses: ACTIVE_STATUSES });
  const byParent = new Map<string, SubTask[]>();
  for (const t of active) {
    const arr = byParent.get(t.parentChatId) ?? [];
    arr.push(t);
    byParent.set(t.parentChatId, arr);
  }
  const out: SubTask[] = [];
  const seen = new Set<string>();
  const walk = (chatId: string): void => {
    for (const child of byParent.get(chatId) ?? []) {
      if (seen.has(child.taskId)) continue;   // 防脏数据成环
      seen.add(child.taskId);
      walk(child.chatId);                      // 先孙后子 = 自底向上
      out.push(child);
    }
  };
  walk(rootChatId);
  return out;
}

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
  // 级联守护（嵌套）：本任务还有 ACTIVE 子任务 → 默认 409 列清单；显式 --cascade 才自底向上逐个收尾。
  const activeDescendants = collectActiveDescendantsBottomUp(task.chatId);
  if (activeDescendants.length && !req.cascade) {
    const listing = activeDescendants.map(t => `${t.taskId}(${t.goal.slice(0, 20)})`).join(', ');
    throw new HttpError(409, `task has ${activeDescendants.length} active descendant subtask(s): ${listing} — finish them first, or pass --cascade`);
  }
  if (req.cascade && activeDescendants.length) {
    // 复用 finish-<taskId> 幂等键 + 原子事务：单个失败即中断报错，重放安全（已收尾的下轮幂等跳过）。
    for (const child of activeDescendants) {
      try {
        const r = await transitionAndEnqueueCommand({
          taskId: child.taskId, expectedVersion: undefined, resolveTo: () => 'finished',
          command: {
            direction: 'parent_to_child', targetChatId: child.chatId,
            commandType: 'finish', payload: { content: `级联收尾：祖先任务 ${task.taskId} finish --cascade` },
            idempotencyKey: `finish-${child.taskId}`,
          },
        });
        if (!r) throw new HttpError(409, `cascade finish failed for ${child.taskId} (illegal transition from ${child.status})`);
        logger.info(`[subtask-orch] cascade finish ${child.taskId} (ancestor=${task.taskId})`);
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(409, `cascade finish aborted at ${child.taskId}: ${err instanceof Error ? err.message : err}; 已收尾部分幂等、可安全重试`);
      }
    }
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
export interface SupplementSubtaskReq {
  sessionId: string; taskId: string; content: string; expectedVersion?: number; force?: boolean;
  /** 优化 #1：补充输入定向。缺省 'main' (普通补充给执行者)；'reviewer'/'all' 用于"请 reviewer review"等。 */
  targetRole?: CommandTargetRole | 'reviewer';
}

export async function supplementSubtask(req: SupplementSubtaskReq): Promise<{ taskId: string; cmdId: string; status: string }> {
  const { task } = authzParentBot(req.sessionId, req.taskId);
  if (!req.content?.trim()) throw new HttpError(400, 'missing content');
  // review P1: expectedVersion 默认必传守 stale；人工强制走显式 force
  if (!req.force && req.expectedVersion == null) {
    throw new HttpError(400, 'supplement_subtask requires expectedVersion (or force=true to override)');
  }
  // 优化 #1：新建 supplement **显式**写 targetRole (默认 main)，dispatcher 缺省才当 legacy=all。
  //   'reviewer' 是用户友好别名 → 内部 'collab'。
  const rawRole = req.targetRole ?? 'main';
  const targetRole: CommandTargetRole = rawRole === 'reviewer' ? 'collab' : rawRole;
  if (!['main', 'collab', 'all'].includes(targetRole)) {
    throw new HttpError(400, `invalid target-role: ${req.targetRole} (use main|reviewer|all)`);
  }
  // review Blocker1: (reported_help→observing 条件转移) + supplement 命令入队**一把原子事务**。
  // idempotencyKey 用内容 hash (同内容 dedup，不含 version 防转移后重试漏)；带 role 防同内容不同定向误 dedup。
  let result: Awaited<ReturnType<typeof transitionAndEnqueueCommand>>;
  try {
    result = await transitionAndEnqueueCommand({
      taskId: req.taskId, expectedVersion: req.force ? undefined : req.expectedVersion,
      resolveTo: cur => (cur === 'reported_help' ? 'observing' : null), // help 被回应 → observing；其它状态不动
      command: {
        direction: 'parent_to_child', targetChatId: task.chatId,
        commandType: 'supplement', payload: { content: req.content, targetRole },
        idempotencyKey: `supp-${req.taskId}-${targetRole}-${djb2(req.content)}`,
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

// ─── 双层汇报 v6：经理汇报邮件 (manager-report) + CEO 主动 pull (request-report) ──────

/** 双层汇报 B1 机制门控（蔻黛架构 review）：manager 任何**实时**上报必须携带非空理由/摘要，否则拒。
 *  统一在此断言，杜绝"无理由实时打扰 CEO"。executor 不过此闸。kind 仅用于报错文案。 */
export function assertManagerRealtimeJustified(kind: string, reason: string | undefined | null): void {
  if (!reason || !reason.trim()) {
    throw new HttpError(400, `manager 实时上报(${kind})必须给理由/摘要（机制门控：要打扰 CEO 就得写清为什么）；常规进展请用 normal 进收件箱`);
  }
}

/** 解析一封汇报邮件的寻址 + 溯源（嵌套逐级：收件人=直接父群 orchestrator）。 */
function inboxAddressing(task: SubTask): {
  recipientChatId: string; recipientBotOpenId: string; fromLabel: string;
  parentTaskId: string | null; rootTaskId: string | null; depth: number;
} {
  const parentTask = getByChatId(task.parentChatId);
  return {
    recipientChatId: task.parentChatId,
    recipientBotOpenId: parentOrchestratorOpenId(task),
    fromLabel: task.bots.find(b => b.role === 'main')?.name ?? task.goal.slice(0, 24),
    parentTaskId: parentTask?.taskId ?? null,
    rootTaskId: task.rootChatId ? (getByChatId(task.rootChatId)?.taskId ?? null) : null,
    depth: task.depth ?? 1,
  };
}

export interface ManagerReportCoreOpts {
  summary: string; body?: string | null;
  reportKind: ReportKind; urgency: 'normal' | 'urgent'; reason?: string | null;
  requestCommandId?: string | null; sourceObservationIds?: string[];
  windowStart?: string | null; windowEnd?: string | null;
  idempotencyKey: string;
}

/** 核心：把一封经理汇报落收件箱（正文→mailbox letter；urgent→额外 report_urgent 实时唤父群）。
 *  无 session —— CLI 包装(managerReport)做鉴权后调；digest tick 内部也直接调（reportKind=scheduled）。 */
export async function managerReportCore(task: SubTask, opts: ManagerReportCoreOpts): Promise<{ entryId: string; letterId: string | null; urgentCmdId: string | null; inserted: boolean }> {
  let letterId: string | null = null;
  if (opts.body && opts.body.trim()) {
    // letter 幂等键与 inbox 对齐（蔻黛 minor4），重跑不产多封正文。
    const letter = writeLetter(opts.body, { idempotencyKey: `mrletter-${opts.idempotencyKey}`, taskId: task.taskId, commandType: 'report_digest' });
    letterId = letter.letterId;
  }
  const addr = inboxAddressing(task);
  const { entry, inserted } = await enqueueEntry({
    ...addr,
    fromTaskId: task.taskId, fromChatId: task.chatId,
    reportKind: opts.reportKind, summary: opts.summary, letterId,
    windowStart: opts.windowStart ?? null, windowEnd: opts.windowEnd ?? null,
    sourceObservationIds: opts.sourceObservationIds ?? [],
    requestCommandId: opts.requestCommandId ?? null,
    urgency: opts.urgency, urgentReason: opts.urgency === 'urgent' ? (opts.reason ?? null) : null,
    idempotencyKey: opts.idempotencyKey,
  });
  let urgentCmdId: string | null = null;
  if (opts.urgency === 'urgent' && inserted) {
    // 蔻黛 M3：report_urgent 独立类型，带 inboxEntryId discriminator，实时唤父群但不进 help 生命周期。
    const cmd = await enqueueCommand({
      taskId: task.taskId, direction: 'child_to_parent', targetChatId: task.parentChatId,
      commandType: 'report_urgent', payload: { summary: opts.summary, inboxEntryId: entry.id },
      idempotencyKey: `urgent-${opts.idempotencyKey}`, expectedTaskVersion: task.version,
    });
    urgentCmdId = cmd.cmdId;
  }
  logger.info(`[subtask-orch] manager-report ${task.taskId} kind=${opts.reportKind} urgency=${opts.urgency} entry=${entry.id} letter=${letterId ?? '-'}${urgentCmdId ? ` urgent=${urgentCmdId}` : ''}`);
  return { entryId: entry.id, letterId, urgentCmdId, inserted };
}

export interface ManagerReportReq {
  sessionId: string; taskId: string; summary: string; body?: string;
  urgency?: 'normal' | 'urgent'; reason?: string;
  reportKind?: ReportKind;
  /** CEO request-report 履约关联：CLI --request-id（蔻黛 B2，写回 entry.requestCommandId）。 */
  requestId?: string; requestCommandId?: string;
  sourceMessageIds?: string[]; idempotencyKey?: string;
}

const URGENCY_VALUES = ['normal', 'urgent'] as const;
const REPORT_KIND_VALUES = ['scheduled', 'manual', 'requested', 'urgent'] as const;

/** CLI/IPC：经理子群的 main bot 写一封汇报邮件进收件箱。normal 不唤醒；urgent 必须带 reason（机制门控）。 */
export async function managerReport(req: ManagerReportReq): Promise<{ taskId: string; entryId: string; letterId: string | null; urgentCmdId: string | null }> {
  const session = getSession(req.sessionId);
  if (!session) throw new HttpError(403, `unknown session: ${req.sessionId}`);
  const task = getSubTask(req.taskId);
  if (!task) throw new HttpError(404, `subtask not found: ${req.taskId}`);
  if (!isManager(task)) throw new HttpError(400, `manager-report 仅 manager 子群适用（task ${req.taskId} 是 executor）`);
  if (session.chatId !== task.chatId) throw new HttpError(403, `manager-report must come from the manager subtask chat`);
  const me = sessionTaskBot(task, session.larkAppId);
  if (!me || me.role !== 'main') throw new HttpError(403, `only the manager's executor(main) bot can manager-report`);
  if (!req.summary?.trim()) throw new HttpError(400, 'missing summary');
  // 蔻黛 M1：运行时枚举校验（TS 类型挡不住 IPC/CLI 输入）。非法 urgency 会绕过 reason 门控、写脏 store。
  const urgency = req.urgency ?? 'normal';
  if (!URGENCY_VALUES.includes(urgency as any)) throw new HttpError(400, `invalid urgency: ${req.urgency} (use normal|urgent)`);
  const reportKind = req.reportKind ?? 'manual';
  if (!REPORT_KIND_VALUES.includes(reportKind as any)) throw new HttpError(400, `invalid report-kind: ${req.reportKind} (use scheduled|manual|requested|urgent)`);
  if (urgency === 'urgent') assertManagerRealtimeJustified('manager-report urgent', req.reason);
  if (task.status === 'finished' || task.status === 'stopped') throw new HttpError(409, `subtask already ${task.status}`);
  const idempotencyKey = req.idempotencyKey
    ?? (req.sourceMessageIds?.length ? `mr-${req.taskId}-${req.sourceMessageIds.join(',')}` : `mr-${req.taskId}-${randomUUID()}`);
  const r = await managerReportCore(task, {
    summary: req.summary, body: req.body, reportKind,
    urgency, reason: req.reason,
    // 蔻黛 B2：CLI --request-id → requestId，写回 entry.requestCommandId（履约闭环）。
    requestCommandId: req.requestId ?? req.requestCommandId,
    sourceObservationIds: req.sourceMessageIds, idempotencyKey,
  });
  return { taskId: req.taskId, entryId: r.entryId, letterId: r.letterId, urgentCmdId: r.urgentCmdId };
}

export interface RequestReportReq { sessionId: string; taskId: string; note?: string; }

/** CLI/IPC：CEO(父群 orchestrator) 主动命令某经理立即产 digest 邮件。区别于被动 subtask-query。 */
export async function requestReport(req: RequestReportReq): Promise<{ taskId: string; cmdId: string; requestId: string }> {
  const { task } = authzParentBot(req.sessionId, req.taskId);
  if (!isManager(task)) throw new HttpError(400, `request-report 仅对 manager 子群有意义（task ${req.taskId} 是 executor）`);
  if (task.status === 'finished' || task.status === 'stopped') throw new HttpError(409, `subtask already ${task.status}`);
  const requestId = randomUUID();
  const cmd = await enqueueCommand({
    taskId: task.taskId, direction: 'parent_to_child', targetChatId: task.chatId,
    commandType: 'request_report', payload: { content: req.note, requestId, targetRole: 'main' },
    idempotencyKey: `reqreport-${requestId}`, expectedTaskVersion: task.version,
  });
  logger.info(`[subtask-orch] request-report ${task.taskId} cmd=${cmd.cmdId} requestId=${requestId}`);
  return { taskId: req.taskId, cmdId: cmd.cmdId, requestId };
}

// ─── 双层汇报 v6：CEO 收件箱 list / read（收件人=自己的群、reader=自己，鉴权天然逐级隔离）──────

export interface ListInboxReq { sessionId: string; unreadOnly?: boolean; since?: string; limit?: number; withBody?: boolean; }

/** 列调用者(收件人)自己群的收件箱。reader=调用 bot；只能看投给"自己群+自己"的邮件（蔻黛 B2 鉴权）。 */
export async function listManagerInbox(req: ListInboxReq): Promise<{ entries: Array<InboxEntry & { body?: string | null }> }> {
  const session = getSession(req.sessionId);
  if (!session) throw new HttpError(403, `unknown session: ${req.sessionId}`);
  const botOpenId = sessionBotOpenId(session.larkAppId);
  if (!botOpenId) throw new HttpError(403, `cannot identify caller bot (larkAppId=${session.larkAppId})`);
  const entries = listInbox(session.chatId, botOpenId, { unreadOnly: req.unreadOnly, since: req.since, limit: req.limit });
  if (!req.withBody) return { entries };
  // 可选展开正文（从 mailbox letter 取）—— 便于 CEO 一次读全。
  return { entries: entries.map(e => ({ ...e, body: e.letterId ? (readLetter(e.letterId)?.payload ?? null) : null })) };
}

export interface ListManagersReq { sessionId: string; }

/** 列调用者（CEO 主群）下当前活跃的**部门经理子群**——供"派活前先判归口"：
 *  知道现在有哪些常驻经理、各管什么域，从而判断"交对口经理 own"还是"CEO 直建"。
 *  只列 parentChatId == 调用者群 且 reportingMode=manager 且 ACTIVE 的子群。 */
export async function listManagers(req: ListManagersReq): Promise<{ managers: Array<{ taskId: string; chatId: string; status: SubTaskStatus; goal: string }> }> {
  const session = getSession(req.sessionId);
  if (!session) throw new HttpError(403, `unknown session: ${req.sessionId}`);
  const managers = listSubTasks({ statuses: ACTIVE_STATUSES })
    .filter(t => isManager(t) && t.parentChatId === session.chatId)
    .map(t => ({
      taskId: t.taskId,
      chatId: t.chatId,
      status: t.status,
      goal: (t.goal || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    }));
  return { managers };
}

export interface MarkInboxReadReq { sessionId: string; ids: string[]; }

/** 标自己收件箱里若干邮件已读（per-reader）。 */
export async function markInboxRead(req: MarkInboxReadReq): Promise<{ marked: number }> {
  const session = getSession(req.sessionId);
  if (!session) throw new HttpError(403, `unknown session: ${req.sessionId}`);
  const botOpenId = sessionBotOpenId(session.larkAppId);
  if (!botOpenId) throw new HttpError(403, `cannot identify caller bot`);
  // 蔻黛 B1：按 (自己群, 自己) 双匹配才标已读，杜绝凭 id 跨箱写 readBy。
  const marked = await markRead(session.chatId, botOpenId, req.ids ?? []);
  return { marked };
}
