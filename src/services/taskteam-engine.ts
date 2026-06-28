// 任务小组 · 配置引擎（v3.1 §3）——纯决策函数：事件 × 规则 → 投递命令（写 outbox 的 TeamAction）。
//
// 设计要点（供 review 核对）：
//  1. 纯函数：无 IO / 无 Date / 无随机；idempotencyKey 全确定性，配合 outbox 幂等去重可安全重放。
//  2. 引擎不内联任何具体角色名 / 流程：新增角色 / 席位 / 规则 = 改 config 数据，本函数一行不动（§12.1）。
//  3. 规则在「角色」粒度匹配 / 扇出，投递与投票在「席位实例」粒度寻址（roleInstanceId）：
//     - rule.when.fromSlotId 按其 roleId 匹配——同角色多席位（count>1 reviewer）都满足同一条规则。
//     - rule.whoSlot 扇出到该 slot 所属 role 的全部 roleInstance——count>1 reviewer 全部被请求，再按 quorum 收敛。
//  4. 审查收敛：review-pass 累计票，达 policy.reviewQuorum（按投票者所属角色 cohort）才推进；review-reject 即返工。
//  5. 返回 TeamDecision { actions, nextStatus?, reviewState? }——比方案 §3 的 TeamAction[] 多带状态跃迁，
//     因为纯引擎必须以确定性方式表达"审轮/状态机推进"，由驱动层（批3）落库应用；core 仍是事件×规则→命令。

import type {
  TaskTeamDeliveryCommand,
  TaskTeamInstance,
  TaskTeamReviewVote,
  TaskTeamRole,
  TaskTeamRoleInstanceId,
  TaskTeamCollabRule,
  TaskTeamSlotId,
  TaskTeamStatus,
  TaskTeamType,
} from './taskteam-schema.js';

// 触发引擎的事件：角色行为（→ TeamEvent）+ 生命周期事件
export type TaskTeamEventType =
  | 'team-started'
  | 'submit'
  | 'review-pass'
  | 'review-reject'
  | 'rework'
  | 'ask-help'
  | 'report'
  | 'consult'
  | 'escalate'
  | 'accept' // owner 验收 → finish
  | 'stall';

export interface TeamEvent {
  // 内置事件保留 union 字面量（类型安全 + 自动补全，不裸字符串化）；type.events 声明的领域无关自定义事件
  // 经 `string & {}` 兜底放行（设计 §8②：生产侧能产出新类型，但内置仍受 union 保护）。
  type: TaskTeamEventType | (string & {});
  fromRoleInstanceId?: TaskTeamRoleInstanceId;
  fromSlotId?: TaskTeamSlotId;
  reason?: string;
  payload?: Record<string, unknown>;
  /**
   * per-event 稳定来源 id（阶段1 内核③ / 约束1，治丢事件）。消息事件取触发它的那条消息 id；
   * timer/stall 等无消息事件取 window/episode id（绝不退回 round）。进默认幂等 key，使「一批消息里多个同类
   * behavior」不再因共享 round/cursor 撞 key 被去重吞掉。缺省（显式入口/测试无来源）时 emit 回退 r{round}。
   */
  sourceEventId?: string;
  /**
   * 归因策略标记（阶段2 §2.2 High）——由 mapBehaviorToEvent 按事件 attributionPolicy 显式填上，**让下游一眼识别**
   * 此事件有没有 role actor，而非靠「fromRoleInstanceId 恰好 undefined」去猜：
   *  - 'role'：有 fromRoleInstanceId/fromSlotId（开发协作事件，行为不变）。
   *  - 'external'：外部参与者触发，**有 sourceEventId、无 fromRoleInstanceId/fromSlotId**（MoA 外部群 new-bug）。
   *  - 'none'：无 actor（clock stall 等）。缺省（显式入口/旧路径）按 'role' 语义处理（不破坏现状）。
   */
  attribution?: 'role' | 'external' | 'none';
}

// 引擎决策的单条投递命令（enqueueTaskTeamAction 的输入形态；不含 actionId/status/时间戳——那些是 store 侧副作用）
export interface TeamActionDecision {
  actionType: TaskTeamDeliveryCommand;
  targetSlotId: TaskTeamSlotId;
  targetRoleInstanceId: TaskTeamRoleInstanceId;
  sourceRoleInstanceId?: TaskTeamRoleInstanceId;
  payload?: Record<string, unknown>;
  idempotencyKey: string;
}

export interface TeamDecision {
  actions: TeamActionDecision[];
  nextStatus?: TaskTeamStatus;
  reviewState?: TaskTeamInstance['reviewState'];
}

export interface DecideTeamActionsInput {
  instance: TaskTeamInstance;
  type: TaskTeamType;
  roles: TaskTeamRole[];
  rules: TaskTeamCollabRule[];
  event: TeamEvent;
}

export function decideTeamActions(input: DecideTeamActionsInput): TeamDecision {
  const { instance, type, roles, rules, event } = input;
  const policy = type.policy;
  const round = instance.reviewState.round;
  const reworkCount = instance.reviewState.reworkCount;

  const roleOfSlot = (slotId?: TaskTeamSlotId): string | undefined =>
    slotId === undefined ? undefined : type.roleSlots.find(s => s.slotId === slotId)?.roleId;
  const roleById = (roleId: string): TaskTeamRole | undefined => roles.find(r => r.roleId === roleId);

  // whoSlot 扇出到该 slot 所属 role 的全部 roleInstance（count>1 全请求）；找不到则回退按 slotId 精确匹配
  const instancesForSlot = (slotId: TaskTeamSlotId) => {
    const roleId = roleOfSlot(slotId);
    const byRole = instance.roleInstances.filter(ri => ri.roleId === roleId);
    return byRole.length ? byRole : instance.roleInstances.filter(ri => ri.slotId === slotId);
  };

  // 规则作用域（P1）：只认本 type.rules 声明的规则——防跨 team type 同形规则污染当前 team 决策
  const typeRuleIds = new Set<string>(type.rules);
  const scopedRules = rules.filter(rule => typeRuleIds.has(rule.ruleId));
  // 规则匹配：event.type 相等 + status 命中（若指定）+ fromSlot 按 role 命中（若指定）
  const matched = scopedRules.filter(rule => {
    if (rule.when.event !== event.type) return false;
    if (rule.when.status !== undefined && rule.when.status !== instance.status) return false;
    if (rule.when.fromSlotId !== undefined && roleOfSlot(rule.when.fromSlotId) !== roleOfSlot(event.fromSlotId)) return false;
    return true;
  });

  const emit = (rulesToFire: TaskTeamCollabRule[], keyRound: number): TeamActionDecision[] => {
    // per-event 来源段（约束1）：优先 event.sourceEventId（消息 id / window-episode id），缺省回退
    // r{keyRound}（显式入口/测试无来源；round 确定性 → 重放仍幂等）。key 含 event.type+source+ruleId+target。
    const seg = event.sourceEventId ?? `r${keyRound}`;
    // 修 reviewer High（防注入）：__delivery 是**配置侧专属**控制字段，**绝不能从事件 payload 进**——
    // 外部消息派生事件若挟带 payload.__delivery（伪造 targetChatId 等）会篡改投递路由。先从 event.payload
    // **剥掉** __delivery，只允许 rule.action（配置）写入。无 rule.action 的命令 payload 不含 __delivery。
    const basePayload = stripDeliverySpec(event.payload);
    const acts: TeamActionDecision[] = [];
    for (const rule of rulesToFire) {
      // 阶段2：领域无关动作的补充投递语义（rule.action）随命令带进 payload.__delivery（仅 IO 渲染/路由层读，
      // 不参与决策与幂等键）。无 action 的规则 payload 用剥净后的 base——开发团队行为逐字不变。
      const payload = rule.action
        ? { ...(basePayload ?? {}), __delivery: rule.action }
        : basePayload;
      for (const ri of instancesForSlot(rule.whoSlot)) {
        acts.push({
          actionType: rule.do,
          targetSlotId: rule.whoSlot,
          targetRoleInstanceId: ri.roleInstanceId,
          sourceRoleInstanceId: event.fromRoleInstanceId,
          payload,
          idempotencyKey: `${instance.teamId}:${event.type}:${seg}:${rule.ruleId}:${ri.roleInstanceId}`,
        });
      }
    }
    return acts;
  };

  // 进入新一轮 review 的统一状态：status=reviewing、round+1、清票
  const enterReview = (): TaskTeamInstance['reviewState'] => ({ round: round + 1, reworkCount, votes: [] });

  switch (event.type) {
    case 'team-started': {
      // 启动：kickoff 给"出场时机=team-started"的非 observer 角色（通常是开发者/执行者）
      const entrySlots = type.roleSlots.filter(s => {
        const role = roleById(s.roleId);
        return role && !role.isObserver && role.activation.trigger === 'team-started';
      });
      const acts: TeamActionDecision[] = [];
      for (const s of entrySlots) {
        for (const ri of instancesForSlot(s.slotId)) {
          acts.push({
            actionType: 'kickoff',
            targetSlotId: s.slotId,
            targetRoleInstanceId: ri.roleInstanceId,
            sourceRoleInstanceId: event.fromRoleInstanceId,
            payload: event.payload,
            idempotencyKey: `${instance.teamId}:start:kickoff:${ri.roleInstanceId}`,
          });
        }
      }
      return { actions: acts, nextStatus: 'running', reviewState: { round: 0, reworkCount, votes: [] } };
    }

    case 'accept': {
      // owner 验收 → 完成；仅「待验收」态有效（P2 状态门禁），其它状态视为无效事件不动
      if (instance.status !== 'awaiting-acceptance') return { actions: [] };
      return { actions: emit(matched, round), nextStatus: 'done' };
    }

    case 'review-reject': {
      // 任一审查者驳回即返工；超过 maxRework 预算则 escalate + blocked
      const nextRework = reworkCount + 1;
      if (nextRework > policy.maxRework) {
        const escalateRules = matched.filter(r => r.do === 'escalate');
        const acts = escalateRules.length ? emit(escalateRules, round) : escalateToObservers(instance, type, roles, event, round);
        return { actions: acts, nextStatus: 'blocked', reviewState: { round, reworkCount: nextRework, votes: [] } };
      }
      // 通知开发者返工（命中的 reject 规则，通常 do:'nudge'）
      return { actions: emit(matched, round), nextStatus: 'running', reviewState: { round, reworkCount: nextRework, votes: [] } };
    }

    case 'review-pass': {
      // 累计票，按投票者所属角色 cohort 评 quorum；达标才推进（fire 命中的 review-pass 规则）
      const voterRole = roleOfSlot(event.fromSlotId);
      const cohort = new Set(
        instance.roleInstances.filter(ri => ri.roleId === voterRole).map(ri => ri.roleInstanceId),
      );
      const votes: TaskTeamReviewVote[] = [
        ...instance.reviewState.votes.filter(v => v.byInstanceId !== event.fromRoleInstanceId),
        ...(event.fromRoleInstanceId
          ? [{ byInstanceId: event.fromRoleInstanceId, verdict: 'pass' as const, reason: event.reason }]
          : []),
      ];
      // quorum 按当前 stage 的 cohort 规模封顶：单审席 cohort=1 时需 1（policy 写 2 也不会永远卡）；
      // 多审席时取 min(policy.reviewQuorum, cohort)，即"够 quorum 票即可、但不超过在场人数"。
      const quorum = Math.max(1, Math.min(policy.reviewQuorum || 1, cohort.size || 1));
      const passInCohort = votes.filter(v => v.verdict === 'pass' && cohort.has(v.byInstanceId)).length;

      if (passInCohort < quorum) {
        // 票数未达 quorum：仅记录票，不推进
        return { actions: [], reviewState: { round, reworkCount, votes } };
      }
      // 达标推进：命中的 review-pass 规则路由到下一步（request-review 下一审 / report 待验收）
      const acts = emit(matched, round);
      // M1 守卫：quorum 达成但无路由规则 → 不静默推进/吞票，保留票与状态以暴露 config 缺规则
      if (acts.length === 0) {
        return { actions: [], reviewState: { round, reworkCount, votes } };
      }
      const startsNextReview = acts.some(a => a.actionType === 'request-review');
      const reportsAcceptance = acts.some(a => a.actionType === 'report');
      const nextStatus: TaskTeamStatus | undefined = startsNextReview
        ? 'reviewing'
        : reportsAcceptance
          ? 'awaiting-acceptance'
          : undefined;
      return { actions: acts, nextStatus, reviewState: enterReview() };
    }

    default: {
      // 通用：submit / report / ask-help / consult / stall / escalate / 自定义事件 … → 命中规则即投递。
      const acts = emit(matched, round);
      // 显式 transition（阶段1④ / 约束2）：仅 default/custom event 读规则声明的 transition。
      // 一次事件命中的 transition 必须 0 或 1 个（互斥/多 transition 由 validator 拦截）；
      // 运行时兜底——若未过 validator 仍配了多个，去重后唯一才采纳，冲突则保守不跃迁（不静默乱跳）。
      const declaredStatuses = [...new Set(matched.filter(r => r.transition).map(r => r.transition!.status))];
      if (declaredStatuses.length === 1) {
        return { actions: acts, nextStatus: declaredStatuses[0] };
      }
      if (declaredStatuses.length > 1) {
        // 冲突配置（validator 应已拦截）：保守只投递、不做任何状态跃迁。
        return { actions: acts };
      }
      // 迁移期 fallback（约束2）：未声明显式 transition 的规则保留旧隐式（request-review→reviewing），
      // 保开发团队 seed（submit→reviewing）行为逐字不漂。
      if (acts.some(a => a.actionType === 'request-review')) {
        return { actions: acts, nextStatus: 'reviewing', reviewState: enterReview() };
      }
      return { actions: acts };
    }
  }
}

/**
 * 防注入：从事件 payload 剥掉 `__delivery`（保留键名常量一致：dispatch-executors.deliverySpecOf 也读这个键）。
 * __delivery 只允许由 rule.action（配置侧）写入；事件 payload（可能源自外部消息）里的同名键一律剥除，
 * 杜绝外部消息伪造投递路由（targetChatId / targetOpenId 等）。
 */
function stripDeliverySpec(payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!payload || !('__delivery' in payload)) return payload;
  const { __delivery: _drop, ...rest } = payload;
  void _drop;
  return rest;
}

// maxRework 耗尽兜底：escalate 给 observer 席（isObserver 角色）；无 observer 则空 actions，仅靠 nextStatus=blocked 表达
function escalateToObservers(
  instance: TaskTeamInstance,
  type: TaskTeamType,
  roles: TaskTeamRole[],
  event: TeamEvent,
  keyRound: number,
): TeamActionDecision[] {
  const observerRoleIds = new Set(roles.filter(r => r.isObserver).map(r => r.roleId));
  const acts: TeamActionDecision[] = [];
  for (const ri of instance.roleInstances) {
    if (!observerRoleIds.has(ri.roleId)) continue;
    const slot = type.roleSlots.find(s => s.roleId === ri.roleId);
    if (!slot) continue;
    acts.push({
      actionType: 'escalate',
      targetSlotId: slot.slotId,
      targetRoleInstanceId: ri.roleInstanceId,
      sourceRoleInstanceId: event.fromRoleInstanceId,
      payload: { reason: 'max-rework-exceeded' },
      idempotencyKey: `${instance.teamId}:r${keyRound}:max-rework:escalate:${ri.roleInstanceId}`,
    });
  }
  return acts;
}
