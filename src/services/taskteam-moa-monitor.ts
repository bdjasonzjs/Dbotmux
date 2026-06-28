// 任务小组 · MoA 外部群监控 type（阶段三）——**纯声明式配置数据，零引擎/dispatcher/judge 代码**。
//
// 阶段三的全部意义：用阶段一+二建好的原语，**纯配置**搭出一个 MoA 监控小组类型，证明重构达成原需求
// （稳定性组「MoA 监控配好却产不出提醒」根因被解掉）。本文件只有数据 + 一个返回数据的 helper，
// 没有任何业务逻辑——所有行为都来自既有引擎/dispatcher/observer：
//   · 触发：observer 盯 instance.targetExternalChatId（阶段一/二既有）。
//   · 判读：judge 受限数据槽（eventDescriptions/decisionHints/outputEventRegistry）渲染 prompt（阶段二）。
//   · 事件：new-bug 声明 attribution='external' → 外部群非绑定 sender 的消息也能产出业务事件（阶段二 High）。
//   · 动作：rule do='notify' 投递分析成员（阶段二领域无关动作），不进 reviewing（与显式 transition 解耦）。
//   · 投递：既有 outbox + dispatcher 可靠投递 + 幂等去重（阶段一）。
//
// ⚠️ 不声明任何 review 角色 / review 规则 / fromSlotId 依赖（external 事件无可靠 fromSlot，validator 会拦）。

import type {
  TaskTeamCollabRule,
  TaskTeamRole,
  TaskTeamType,
} from './taskteam-schema.js';

export const TT_TYPE_MOA_MONITOR: TaskTeamType['typeId'] = 'tt_type_moa_monitor';

// 角色：analyst（分析/分流执行席）+ observer（低成本盯外部群的判读席）。无任何 review 角色。
export const MOA_MONITOR_ROLES: TaskTeamRole[] = [
  {
    roleId: 'tt_role_moa_analyst',
    name: '分析成员',
    responsibility: '收到外部群新 bug 通知后判定 / 分流处理',
    activation: { trigger: 'team-started' },
    visibility: 'full',
    actions: ['report', 'consult', 'escalate'],
    io: { from: [], to: [] },
    seatHint: { engine: 'claude' },
  },
  {
    roleId: 'tt_role_moa_observer',
    name: '盯群',
    responsibility: '低成本盯外部群、判读新 bug 报告（不参与处理）',
    activation: { trigger: 'observer-tick' },
    visibility: 'progress-only',
    actions: ['report'],
    io: { from: [], to: [] },
    seatHint: { engine: 'coco' },
    isObserver: true,
  },
];

// 规则：new-bug → notify 分析成员。**不依赖 fromSlotId**（external 事件无可靠 fromSlot）；不声明 transition（不进 reviewing）。
export const MOA_MONITOR_RULES: TaskTeamCollabRule[] = [
  {
    ruleId: 'tt_rule_moa_new_bug_notify',
    when: { event: 'new-bug', status: 'running' },
    whoSlot: 'tt_slot_moa_analyst',
    do: 'notify',
  },
];

export const MOA_MONITOR_TYPE: TaskTeamType = {
  typeId: TT_TYPE_MOA_MONITOR,
  name: 'MoA 外部群监控',
  roleSlots: [
    { slotId: 'tt_slot_moa_analyst', roleId: 'tt_role_moa_analyst', label: 'analyst' },
    { slotId: 'tt_slot_moa_observer', roleId: 'tt_role_moa_observer', label: 'observer' },
  ],
  rules: ['tt_rule_moa_new_bug_notify'],
  // 无 review：reviewRounds/quorum/maxRework 取最小，escalateAfterStallMs=0（本 type 不靠停滞升级）。
  policy: { reviewRounds: 0, reviewQuorum: 1, maxRework: 0, escalateAfterStallMs: 0, reviewOrder: [] },
  // new-bug：外部参与者可触发的领域无关事件（attribution=external，允许 source-only、无 role 归因）。
  events: [{ type: 'new-bug', producer: 'behavior', attribution: 'external' }],
  // judge 受限数据槽：模板作者只填描述/提示/输出白名单；安全骨架（UNTRUSTED/工具禁用/schema/source 别名）不可配置。
  judge: {
    eventDescriptions: { 'new-bug': '外部用户 / 群成员新报告的线上问题或缺陷（此前没出现过的）' },
    decisionHints: [
      '只在有人明确报告一个新的线上问题 / 缺陷时判 new-bug',
      '闲聊、感谢、对已知问题的追问都不算 new-bug',
      '一条消息最多对应一个 new-bug',
    ],
    outputEventRegistry: ['new-bug'],
  },
};

/** 返回 MoA 监控的声明式配置包（深拷贝，独立对象）——照配即用，导入到 config store 即成一个监控小组类型。 */
export function moaMonitorConfigBundle(): {
  roles: TaskTeamRole[];
  rules: TaskTeamCollabRule[];
  teamTypes: TaskTeamType[];
} {
  return {
    roles: MOA_MONITOR_ROLES.map(r => structuredClone(r)),
    rules: MOA_MONITOR_RULES.map(r => structuredClone(r)),
    teamTypes: [structuredClone(MOA_MONITOR_TYPE)],
  };
}
