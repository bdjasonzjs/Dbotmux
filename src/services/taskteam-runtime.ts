// 任务小组 · 驱动层（v3.1 §3.1 事件入口）——把 TeamEvent 喂给纯引擎、落状态增量、把投递命令写进 outbox。
//
// 复用边界（守红线#1）：
//  - 直接调用 group-creator.createGroupWithBots（通用导出、不 import subtask-store）建群。
//  - 复制范式写 taskteams.json / taskteam-outbox.json（批1 store），绝不 import / 改 subtask-store。
//  - 依赖注入：核心 applyTeamEvent 用注入的 deps，便于纯单测；defaultRuntimeDeps() wire 批1/批2。

import { decideTeamActions } from './taskteam-engine.js';
import type { TeamDecision, TeamEvent } from './taskteam-engine.js';
import type {
  TaskTeamAction,
  TaskTeamCollabRule,
  TaskTeamDepartmentId,
  TaskTeamCompanyId,
  TaskTeamId,
  TaskTeamInstance,
  TaskTeamReviewVote,
  TaskTeamRole,
  TaskTeamRoleInstance,
  TaskTeamType,
  TaskTeamTypeId,
} from './taskteam-schema.js';

export interface TaskTeamRuntimeConfig {
  roles: TaskTeamRole[];
  rules: TaskTeamCollabRule[];
  teamTypes: TaskTeamType[];
}

// 注入依赖（默认 wire 批1 store；测试可传内存假实现）
export interface TaskTeamRuntimeDeps {
  // P1：per-team 串行化锁——整个 read→decide→enqueue→advance 在锁内，杜绝并发丢票 / 崩溃重放孤儿。
  // 默认实现走跨进程文件锁；测试可传 keyed mutex 或 passthrough。
  withTeamLock<T>(teamId: TaskTeamId, fn: () => Promise<T>): Promise<T>;
  loadConfig(): TaskTeamRuntimeConfig;
  getTeam(teamId: TaskTeamId): TaskTeamInstance | null;
  applyState(
    teamId: TaskTeamId,
    patch: { status?: TaskTeamInstance['status']; reviewState?: TaskTeamInstance['reviewState'] },
  ): Promise<TaskTeamInstance>;
  enqueue(opts: {
    teamId: TaskTeamId;
    actionType: TaskTeamAction['actionType'];
    idempotencyKey: string;
    sourceRoleInstanceId?: TaskTeamAction['sourceRoleInstanceId'];
    targetRoleInstanceId?: TaskTeamAction['targetRoleInstanceId'];
    targetSlotId?: TaskTeamAction['targetSlotId'];
    payload?: Record<string, unknown>;
    expectedTeamVersion?: number | null;
  }): Promise<TaskTeamAction>;
}

export class TaskTeamRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskTeamRuntimeError';
  }
}

export interface ApplyTeamEventResult {
  instance: TaskTeamInstance;
  decision: TeamDecision;
  enqueued: TaskTeamAction[];
}

/**
 * 驱动核心：读实例+type+config → decideTeamActions → 原子落状态增量 → enqueue 每条投递命令。
 * 纯净边界：所有 IO 经 deps；引擎本身纯函数。idempotencyKey 由引擎确定性给定，重放安全。
 */
export async function applyTeamEvent(
  deps: TaskTeamRuntimeDeps,
  teamId: TaskTeamId,
  event: TeamEvent,
): Promise<ApplyTeamEventResult> {
  // P1：整个 read→decide→enqueue→advance 在 per-team 锁内串行化，且 enqueue 先于状态提交：
  //  · 并发事件（如两 reviewer 同时 review-pass）串行执行，后者读到前者已提交的票 → 不丢票、quorum 正常收敛；
  //  · 崩溃/失败重放：状态未提交则锁内重读"未推进状态"→ 重算出相同决策 → 幂等 enqueue 去重 → 再提交，
  //    不丢 request-review/report、也不产孤儿命令（锁内无并发改态，决策不漂移）。
  return deps.withTeamLock(teamId, async () => {
    const instance = deps.getTeam(teamId);
    if (!instance) throw new TaskTeamRuntimeError(`taskteam ${teamId} not found`);
    const cfg = deps.loadConfig();
    const type = cfg.teamTypes.find(t => t.typeId === instance.typeId);
    if (!type) throw new TaskTeamRuntimeError(`taskteam type ${instance.typeId} not found for ${teamId}`);

    const decision = decideTeamActions({ instance, type, roles: cfg.roles, rules: cfg.rules, event });

    // 半提交守卫：若决策含状态跃迁，命令绑定"提交后的 team.version"（= 当前 +1，锁内无并发改态故确定）。
    // dispatcher 在 team.version 达到该值前不投递；崩溃在 enqueue 与 advance 之间时，命令虽落库但不可投递，
    // 待重放再次 advance 到该版本才解锁——既不丢命令也不会半提交投递。无状态跃迁的命令即时可投递（null）。
    const hasStateChange = decision.nextStatus !== undefined || decision.reviewState !== undefined;
    const expectedTeamVersion = hasStateChange ? instance.version + 1 : null;

    // 1. 先幂等 enqueue 每条投递命令（idempotencyKey 引擎给定 → outbox 去重；replay 安全）
    const enqueued: TaskTeamAction[] = [];
    for (const a of decision.actions) {
      enqueued.push(
        await deps.enqueue({
          teamId,
          actionType: a.actionType,
          idempotencyKey: a.idempotencyKey,
          sourceRoleInstanceId: a.sourceRoleInstanceId,
          targetRoleInstanceId: a.targetRoleInstanceId,
          targetSlotId: a.targetSlotId,
          payload: a.payload,
          expectedTeamVersion,
        }),
      );
    }

    // 2. 再原子提交状态增量（status / reviewState，含审轮票数累计）——提交后 team.version = expectedTeamVersion，命令解锁可投
    let updated = instance;
    if (hasStateChange) {
      updated = await deps.applyState(teamId, { status: decision.nextStatus, reviewState: decision.reviewState });
    }

    return { instance: updated, decision, enqueued };
  });
}

// 角色行为 / 生命周期事件的便捷构造（事件入口用）
export function teamEvent(
  type: TeamEvent['type'],
  opts: {
    fromRoleInstanceId?: TeamEvent['fromRoleInstanceId'];
    fromSlotId?: TeamEvent['fromSlotId'];
    reason?: string;
    payload?: Record<string, unknown>;
    sourceEventId?: string; // 约束1：消息 id / window-episode id；缺省时 emit 回退 r{round}
  } = {},
): TeamEvent {
  return { type, ...opts };
}

// —— 建群 + 落实例 + 启动（直接调 group-creator，复制范式落 store）——

export interface CreateTaskTeamDeps extends TaskTeamRuntimeDeps {
  createGroup(opts: {
    name?: string;
    creatorLarkAppId: string;
    larkAppIds: string[];
    userOpenIds?: string[];
    sourceChatId?: string | null;
    purpose?: string;
  }): Promise<{ chatId: string }>;
  persistTeam(opts: {
    typeId: TaskTeamTypeId;
    companyId: TaskTeamCompanyId;
    deptId?: TaskTeamDepartmentId;
    chatId: string;
    targetExternalChatId?: string;
    goal: string;
    acceptance: string;
    roleInstances: TaskTeamRoleInstance[];
  }): Promise<TaskTeamInstance>;
}

export interface CreateTaskTeamParams {
  typeId: TaskTeamTypeId;
  companyId: TaskTeamCompanyId;
  deptId?: TaskTeamDepartmentId;
  goal: string;
  acceptance: string;
  roleInstances: TaskTeamRoleInstance[];
  groupName?: string;
  creatorLarkAppId: string;
  sourceChatId?: string | null;
  /** 可选：observer 监控的外部群；不设则默认监控任务小组自己的群。运行态绑定，不进模板。 */
  targetExternalChatId?: string;
  /** 建群时把这些真人 open_id 拉进群（dashboard「用模板建真群」用——把当前用户拉进去）。可选、向后兼容。 */
  userOpenIds?: string[];
}

/**
 * 建一个任务小组实例：建群 → 落 forming 实例 → 驱动 team-started（kickoff + running）。
 * 建群只用 createGroupWithBots（不 import subtask-store）；kickoff 走引擎产命令、入 outbox，由 dispatcher 投递。
 */
export async function createTaskTeam(
  deps: CreateTaskTeamDeps,
  params: CreateTaskTeamParams,
): Promise<TaskTeamInstance> {
  const botAppIds = uniqueLarkAppIds(params.roleInstances, params.creatorLarkAppId);
  const { chatId } = await deps.createGroup({
    name: params.groupName,
    creatorLarkAppId: params.creatorLarkAppId,
    larkAppIds: botAppIds,
    userOpenIds: params.userOpenIds,
    sourceChatId: params.sourceChatId ?? null,
    purpose: params.goal,
  });

  const team = await deps.persistTeam({
    typeId: params.typeId,
    companyId: params.companyId,
    deptId: params.deptId,
    chatId,
    targetExternalChatId: params.targetExternalChatId,
    goal: params.goal,
    acceptance: params.acceptance,
    roleInstances: params.roleInstances,
  });

  await applyTeamEvent(deps, team.teamId, teamEvent('team-started'));
  return deps.getTeam(team.teamId) ?? team;
}

function uniqueLarkAppIds(roleInstances: TaskTeamRoleInstance[], creatorLarkAppId: string): string[] {
  const set = new Set<string>([creatorLarkAppId]);
  for (const ri of roleInstances) {
    if (ri.binding?.larkAppId) set.add(ri.binding.larkAppId);
  }
  return [...set];
}

// 便捷：记录一票（语义糖，引擎已能算票；保留给外部直接落票场景）
export type { TaskTeamReviewVote };
