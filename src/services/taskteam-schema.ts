export type TaskTeamId = `tt_team_${string}`;
export type TaskTeamRoleId = `tt_role_${string}`;
export type TaskTeamRuleId = `tt_rule_${string}`;
export type TaskTeamTypeId = `tt_type_${string}`;
export type TaskTeamSlotId = `tt_slot_${string}`;
export type TaskTeamRoleInstanceId = `tt_ri_${string}`;
export type TaskTeamBindingId = `tt_binding_${string}`;
export type TaskTeamCompanyId = `tt_company_${string}`;
export type TaskTeamDepartmentId = `tt_dept_${string}`;
export type TaskTeamActionId = `tt_action_${string}`;

export type TaskTeamVisibility = 'full' | 'review-only' | 'progress-only';
// 角色行为 / 事件 verdict（§2.3.1 固定动作集）——角色能做哪些动作、产生哪些 TeamEvent
export type TaskTeamActionType =
  | 'submit'
  | 'review-pass'
  | 'review-reject'
  | 'rework'
  | 'ask-help'
  | 'escalate'
  | 'report'
  | 'consult'
  | 'finish';

// outbox 投递命令（§3：引擎决策产出、写入 outbox 的"命令"）——与角色行为分离（P1-1）
// 角色 submit 触发的是"请架构师 review"=request-review，而非"review 已通过"=review-pass
// 阶段2 新增领域无关动作（§2.3）：notify（通知某人/某群）/ wake-role（唤醒某角色席位）/ route-to-owner（转交 owner）。
// 这三者与状态跃迁解耦——不像旧 request-review 隐式拽进 reviewing，纯投递、状态跃迁只由显式 transition 决定。
export type TaskTeamDeliveryCommand =
  | 'kickoff'
  | 'request-review'
  | 'nudge'
  | 'escalate'
  | 'report'
  | 'finish'
  | 'notify'
  | 'wake-role'
  | 'route-to-owner';

export type TaskTeamStatus =
  | 'forming'
  | 'running'
  | 'reviewing'
  | 'blocked'
  | 'awaiting-acceptance'
  | 'done'
  | 'archived';

export type TaskTeamActionStatus = 'pending' | 'claimed' | 'sent' | 'acked' | 'failed';

export interface TaskTeamModelOverride {
  model?: string;
  reasoningEffort?: string;
}

export interface TaskTeamRoleRef {
  roleId: TaskTeamRoleId;
}

export interface TaskTeamActivationRule {
  trigger: string;
  description?: string;
}

export interface TaskTeamSeatHint {
  engine?: string;
  displayName?: string;
}

export interface TaskTeamRole {
  roleId: TaskTeamRoleId;
  name: string;
  responsibility: string;
  activation: TaskTeamActivationRule;
  visibility: TaskTeamVisibility;
  actions: TaskTeamActionType[];
  io: { from: TaskTeamRoleRef[]; to: TaskTeamRoleRef[] };
  model?: TaskTeamModelOverride;
  seatHint?: TaskTeamSeatHint;
  isObserver?: boolean;
}

export interface TaskTeamRoleSlot {
  slotId: TaskTeamSlotId;
  roleId: TaskTeamRoleId;
  label?: string;
}

export interface TaskTeamTriggerCondition {
  event: string;
  status?: TaskTeamStatus;
  fromSlotId?: TaskTeamSlotId;
}

// 显式状态跃迁（阶段1 内核④）——把状态机推进从「按 command 名隐式决定」解耦成规则可显式声明、validator 可校验。
// 迁移期红线（设计 §8 约束2）：仅 default/custom event 读 transition；legacy 事件
// （team-started/review-pass/review-reject/accept）仍走引擎 special case、不读 transition。
// 一次事件命中的 transition 必须 0 或 1 个（runtime 一次只落一个 {status} patch），冲突由 validator 拦截。
export interface TaskTeamStateTransition {
  status: TaskTeamStatus; // 命中该规则后小组应跃迁到的状态
}

// 领域无关动作的补充投递语义（阶段2 §2.3）——全可选，向后兼容。
// 现有开发团队规则不带 action，行为逐字不变；新动作（notify/wake-role/route-to-owner）按需补字段。
// 这些字段只影响「投递怎么发」（IO 渲染/路由层 dispatch-executors 读），不参与引擎决策与幂等键，故不破坏重放安全。
export interface TaskTeamActionSpec {
  /** 目标类型：slot=沿用 whoSlot 寻址席位（缺省）/ user=指定 open_id / chat=指定群 / owner=转交 owner。 */
  targetType?: 'slot' | 'user' | 'chat' | 'owner';
  /** targetType=chat 时投递到的群（覆盖小组自身 chatId）。 */
  targetChatId?: string;
  /** targetType=user/owner 时 @ / 路由到的 open_id。 */
  targetOpenId?: string;
  /** 是否要求接收方回执（ack）。渲染层提示「请回执」，可被上层用作 SLA 计时锚。 */
  ack?: boolean;
  /** 投递可见性口径（沿用角色可见性枚举）。 */
  visibility?: TaskTeamVisibility;
  /** 是否唤醒 root（CEO / 根群）——route-to-owner / 升级场景用。 */
  wakeRoot?: boolean;
  /** 升级策略：none=不升级 / notify-owner=不达再通知 owner / sla=按 SLA 升级。 */
  escalation?: 'none' | 'notify-owner' | 'sla';
}

export interface TaskTeamCollabRule {
  ruleId: TaskTeamRuleId;
  when: TaskTeamTriggerCondition; // when.event 是触发的角色行为 / 生命周期事件
  whoSlot: TaskTeamSlotId; // 投递目标席位
  do: TaskTeamDeliveryCommand; // 引擎命中规则时产出的投递命令（非角色行为）
  /** 可选显式状态跃迁（阶段1④）。仅 default/custom event 生效；未声明则 default 分支沿用旧隐式（request-review→reviewing）。 */
  transition?: TaskTeamStateTransition;
  /** 可选领域无关动作补充语义（阶段2 §2.3）。仅 dispatch 渲染/路由层读，不进引擎决策/幂等键。 */
  action?: TaskTeamActionSpec;
}

export interface TaskTeamCollabPolicy {
  reviewRounds: number;
  reviewQuorum: number;
  maxRework: number;
  escalateAfterStallMs: number;
  reviewOrder: TaskTeamSlotId[];
}

// 事件声明（阶段1 内核②）——见 taskteam-event-registry.ts。在此前置声明以避免循环 import。
export interface TaskTeamEventDecl {
  type: string;
  producer: 'lifecycle' | 'behavior' | 'timer';
}

// judge 受限数据槽（阶段2 §2.2）——把判读 prompt 的「可判读事件描述 + 决策提示 + 输出事件白名单」下沉为
// per-type **受限数据槽**。模板作者只能填这三个槽，**动不了安全骨架**：system scaffold + UNTRUSTED_DATA 包裹 +
// 工具禁用 + JSON schema 校验 + source 只取系统别名（M{k}）全部在代码里写死、不可配置（防注入面）。
export interface TaskTeamJudgeSlots {
  /** per-event 人话描述（覆盖/补充内置 BUILTIN_EVENT_DESC，渲染进 prompt 的受限数据槽）。key=事件 type。 */
  eventDescriptions?: Record<string, string>;
  /** 决策提示（判读引导，逐条渲染进 prompt 的受限数据槽；非完整 prompt，安全骨架不可动）。 */
  decisionHints?: string[];
  /** 输出事件白名单：judge 只能产出这些 type。缺省 = 该 type 的可判读事件集（detectableEventsForType）；
   *  设了则取「outputEventRegistry ∩ 可判读集」——只能收窄、不能越权扩展到未声明事件（防注入）。 */
  outputEventRegistry?: string[];
}

export interface TaskTeamType {
  typeId: TaskTeamTypeId;
  name: string;
  roleSlots: TaskTeamRoleSlot[];
  rules: TaskTeamRuleId[];
  policy: TaskTeamCollabPolicy;
  /** 可选事件 registry 声明（阶段1②）：本 type 额外可产出/可判读的领域无关自定义事件。不设则只用内置事件集。 */
  events?: TaskTeamEventDecl[];
  /** 可选 judge 受限数据槽（阶段2 §2.2）：配置化判读的受限面，不开放完整 prompt。不设则只用内置描述/可判读集。 */
  judge?: TaskTeamJudgeSlots;
}

// 可分享 shape：进 TemplateBundle，绝不含运行态 / app-scoped 身份（§2.5 / 细节 review H3）
export interface TaskTeamOrgStructureShape {
  companyName: string;
  departments: { deptName: string; teamTypeIds: TaskTeamTypeId[] }[];
}

// 本地实例态：运行态身份单列于此（不进分享包，进 InstanceSnapshot）（§2.5 / H3）
export interface TaskTeamOrgRuntimeBinding {
  companyId: TaskTeamCompanyId; // 运行态铸造的公司身份
  companyName: string; // 绑定 → 对应 OrgStructureShape（按名称解析）
  rootChatId: string;
  ceoBotOpenId: string;
  deptBindings: { deptId: TaskTeamDepartmentId; deptName: string; managerChatId?: string; managerBotOpenId?: string }[];
}

export interface TaskTeamRoleBinding {
  bindingId: TaskTeamBindingId;
  botOpenId: string;
  larkAppId: string;
  modelOverride?: TaskTeamModelOverride;
}

export interface TaskTeamRoleInstance {
  roleInstanceId: TaskTeamRoleInstanceId;
  slotId: TaskTeamSlotId;
  roleId: TaskTeamRoleId;
  binding?: TaskTeamRoleBinding;
}

export interface TaskTeamReviewVote {
  byInstanceId: TaskTeamRoleInstanceId;
  verdict: 'pass' | 'reject';
  reason?: string;
}

export interface TaskTeamInstance {
  teamId: TaskTeamId;
  typeId: TaskTeamTypeId;
  companyId: TaskTeamCompanyId;
  deptId?: TaskTeamDepartmentId;
  chatId: string;
  /** 可选：observer 实际监控的外部群。不设则沿用小组自己的 chatId。运行态绑定，不进 TemplateBundle。 */
  targetExternalChatId?: string;
  goal: string;
  acceptance: string;
  roleInstances: TaskTeamRoleInstance[];
  status: TaskTeamStatus;
  progress: string;
  reviewState: {
    round: number;
    reworkCount: number;
    pendingInstanceId?: TaskTeamRoleInstanceId;
    votes: TaskTeamReviewVote[];
  };
  cursor?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskTeamAction {
  actionId: TaskTeamActionId;
  teamId: TaskTeamId;
  actionType: TaskTeamDeliveryCommand; // outbox 承载投递命令（P1-1）
  sourceRoleInstanceId?: TaskTeamRoleInstanceId;
  targetRoleInstanceId?: TaskTeamRoleInstanceId;
  targetSlotId?: TaskTeamSlotId;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  status: TaskTeamActionStatus;
  retryCount: number;
  leaseExpiresAt: string | null;
  nextAttemptAt: string | null; // 退避到点前 dispatcher 不取（A2：批3 retry 出路）
  // 半提交守卫（批3 P1）：本命令对应的状态跃迁提交后 team.version 才会达到此值；
  // dispatcher 在 team.version >= expectedTeamVersion 前不投递 → 杜绝"命令已可投递但状态未推进"。
  // null = 无需门控（决策无状态跃迁，命令即时可投递）。
  expectedTeamVersion: number | null;
  dispatchAttemptId: string | null;
  deliveredMessageId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskTeamConfigFile {
  version: number;
  roles: TaskTeamRole[];
  rules: TaskTeamCollabRule[];
  teamTypes: TaskTeamType[];
  orgStructures: TaskTeamOrgStructureShape[];
  orgRuntimeBindings: TaskTeamOrgRuntimeBinding[];
  updatedAt: string;
}

export interface TaskTeamInstanceFile {
  version: number;
  teams: TaskTeamInstance[];
  updatedAt: string;
}

export interface TaskTeamOutboxFile {
  version: number;
  actions: TaskTeamAction[];
  updatedAt: string;
}
