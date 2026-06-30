// 任务小组 · 「需求开发 + e2e 验证」type（tt_type_dev_with_e2e）——**声明式配置数据，零引擎/dispatcher/judge 逻辑**。
//
// 延续阶段三 MoA monitor 的范式（external-attribution 事件 + judge 受限数据槽 + observer 判读 → 引擎 →
// outbox → dispatch），证明「带跨机器 e2e 验证关的开发协作流」也能纯配置表达、引擎核心 decide 不改。
//
// 形态：开发 → 架构 review 过 → 详细 review 过 → 豆包M 真机 e2e 关 → 才算完成。
//   submit            → architect request-review（reviewing）        [复用 two_layer 规则]
//   review-pass(架构) → detail_reviewer request-review（reviewing）   [复用 two_layer 规则]
//   review-pass(详细) → e2e_runner notify『派 e2e』+ 跃迁 **e2e-verifying** 独立态  ← 本文件新规则
//   e2e-pass          → developer report（awaiting-acceptance）→ owner accept → done   ← 本文件新规则
//   e2e-fail          → developer nudge（running，踢回返工，机制同 review-reject）        ← 本文件新规则
//   review-reject     → developer nudge（rework）                     [复用 two_layer 规则]
//   stall(running)    → observer escalate                            [复用 two_layer 规则]
//
// 关键设计（详见 .task-context/taskteam-dev-with-e2e-type.md）：
//  · e2e 验证态 = **独立 e2e-verifying 状态**（修 reviewer P1①：避免与 reviewing 共用导致重复 detail-pass 再次派单）。
//    引擎改动最小且向后兼容：decideReviewPass 在达 quorum 推进时读命中规则的 transition（two_layer 规则不声明 transition →
//    行为逐字不变，golden 锁死）。detail-pass→e2e 规则 gate 在 reviewing、跃迁到 e2e-verifying，进态后重复 detail-pass 不再命中。
//    stall 规则只在 running 触发 → e2e-verifying 天然豁免 stall-nudge（豆包M 离线不刷屏）。
//  · e2e-pass/e2e-fail = type.events 声明的 external-attribution behavior 事件（豆包M 跨机器，群消息是唯一信号，
//    source-only、不依赖 fromSlot）；judge 受限数据槽引导判读。**不设 outputEventRegistry**（本类型 observer 仍要
//    判读正常开发流的 submit/review-pass/review-reject，收窄会把它们一起 fail-closed 掉）。
//  · 实例级 e2e 四项配置（instance.e2eConfig）由 dispatch 在 notify 渲染（rule.action.kind='e2e-kickoff' 驱动，通用）。

import {
  defaultTaskTeamSeed,
  seedDefaultTaskTeamConfig,
  upsertTaskTeamRole,
  upsertTaskTeamRule,
  upsertTaskTeamType,
} from './taskteam-config-store.js';
import type {
  TaskTeamCollabRule,
  TaskTeamE2eConfig,
  TaskTeamRole,
  TaskTeamType,
} from './taskteam-schema.js';

export const TT_TYPE_DEV_WITH_E2E: TaskTeamType['typeId'] = 'tt_type_dev_with_e2e';

// fail-fast 校验（修 reviewer P1②）：建 dev_with_e2e 小组必须连 e2e 四项一起配。clientPackage/frontendBranch/cases
// 必填（缺则建出的实例在 e2e 关只能发"请 owner 补"兜底，而子群规则不允许直接惊动 owner）；skill 可选（默认 doubao-desktop-cdp-verification）。
// 返回缺失的必填字段名（空数组=合法）。建组入口（daemon create-from-template）据此 400，堵死所有路径建出缺配置实例。
export const E2E_CONFIG_REQUIRED_FIELDS: ReadonlyArray<keyof TaskTeamE2eConfig> = ['clientPackage', 'frontendBranch', 'cases'];
export function missingE2eConfigFields(e2eConfig: unknown): string[] {
  const e = (e2eConfig ?? {}) as Record<string, unknown>;
  return E2E_CONFIG_REQUIRED_FIELDS.filter(k => !(typeof e[k] === 'string' && String(e[k]).trim()));
}

// 新增角色：e2e 验证员（绑豆包M）。它是 notify 的目标席位；其 e2e 结果经 observer judge 以 external 事件
// （e2e-pass/e2e-fail）产出，不走角色行为路径，故 actions 取最小。activation.trigger 非 'team-started' →
// 开工时**不**被 kickoff（只在详细 review 通过、被 notify 派 e2e 时才出场）。
export const E2E_RUNNER_ROLE: TaskTeamRole = {
  roleId: 'tt_role_e2e_runner',
  name: 'e2e 验证员',
  responsibility: '在真机豆包桌面客户端跑端到端验证（跨机器外部主体，群消息是唯一信号）',
  activation: { trigger: 'detail-review-pass' },
  visibility: 'progress-only',
  actions: ['report'],
  io: { from: [{ roleId: 'tt_role_detail_reviewer' }], to: [{ roleId: 'tt_role_developer' }] },
  // 豆包M 是基于 Codex 的 bot；seatHint 仅作分配提示（实例绑定时按真实 bot 覆盖）。
  seatHint: { engine: 'codex' },
};

// 新增规则（3 条）。复用 two_layer 的 submit/architect-pass/reject/stall 规则（按 id 在 type.rules 引用，见下）。
export const DEV_WITH_E2E_RULES: TaskTeamCollabRule[] = [
  // 详细 review 通过 → 派 e2e 给 e2e 验证员（notify，带实例四项配置 + 请回执），并**跃迁到独立 e2e-verifying 态**。
  // transition 由 decideReviewPass 在达 quorum 推进时读取（review-pass 已不在 validator 的 transition-blind 列）。
  // 关键：本规则 gate 在 status=reviewing；进入 e2e-verifying 后，详细 reviewer 再发的 review-pass **不再命中本规则**
  // → 杜绝 e2e 阶段重复派单（修 reviewer P1①）。
  {
    ruleId: 'tt_rule_detail_pass_to_e2e',
    when: { event: 'review-pass', status: 'reviewing', fromSlotId: 'tt_slot_detail_reviewer_main' },
    whoSlot: 'tt_slot_e2e_runner_main',
    do: 'notify',
    transition: { status: 'e2e-verifying' },
    action: { ack: true, kind: 'e2e-kickoff' },
  },
  // e2e 通过 → 开发者 report（待验收）→ owner accept → done。
  // e2e-pass 是自定义事件 → 走 decideDefault，读显式 transition 推进到 awaiting-acceptance。external 事件无 fromSlotId。
  // gate 在 e2e-verifying：只有真进了 e2e 验证态才接受 e2e 结果（详细 review 中途的杂音不会误推进）。
  {
    ruleId: 'tt_rule_e2e_pass_to_acceptance',
    when: { event: 'e2e-pass', status: 'e2e-verifying' },
    whoSlot: 'tt_slot_developer_main',
    do: 'report',
    transition: { status: 'awaiting-acceptance' },
  },
  // e2e 失败 → 踢回开发者返工（nudge，回 running；机制同 review-reject）。文案带「修不了向上反馈」+ 失败证据见群内回报。
  {
    ruleId: 'tt_rule_e2e_fail_to_rework',
    when: { event: 'e2e-fail', status: 'e2e-verifying' },
    whoSlot: 'tt_slot_developer_main',
    do: 'nudge',
    transition: { status: 'running' },
    action: { kind: 'e2e-fail-rework' },
  },
];

export const DEV_WITH_E2E_TEAM_TYPE: TaskTeamType = {
  typeId: TT_TYPE_DEV_WITH_E2E,
  name: '需求开发 + e2e 验证任务小组',
  roleSlots: [
    { slotId: 'tt_slot_developer_main', roleId: 'tt_role_developer', label: 'main' },
    { slotId: 'tt_slot_architect_main', roleId: 'tt_role_architect', label: 'architecture-review' },
    { slotId: 'tt_slot_detail_reviewer_main', roleId: 'tt_role_detail_reviewer', label: 'detail-review' },
    { slotId: 'tt_slot_e2e_runner_main', roleId: 'tt_role_e2e_runner', label: 'e2e-runner' },
    { slotId: 'tt_slot_observer_main', roleId: 'tt_role_observer', label: 'observer' },
  ],
  rules: [
    'tt_rule_submit_to_architect', // 复用 two_layer
    'tt_rule_architect_pass_to_detail', // 复用 two_layer
    'tt_rule_detail_pass_to_e2e', // 新：详细 review 通过 → 派 e2e（改道，替代 two_layer 的 detail→acceptance）
    'tt_rule_e2e_pass_to_acceptance', // 新：e2e 通过 → 待验收
    'tt_rule_e2e_fail_to_rework', // 新：e2e 失败 → 返工
    'tt_rule_reject_to_rework', // 复用 two_layer
    'tt_rule_observer_stall_report', // 复用 two_layer
  ],
  // 复用 two_layer 的 review policy（两审席 + quorum 1 + maxRework 3 + 30min stall）。e2e_runner 不参与 review 投票，不入 reviewOrder。
  policy: {
    reviewRounds: 2,
    reviewQuorum: 1,
    maxRework: 3,
    escalateAfterStallMs: 30 * 60 * 1000,
    reviewOrder: ['tt_slot_architect_main', 'tt_slot_detail_reviewer_main'],
  },
  // e2e 结果事件：external（豆包M 跨机器，source-only）+ behavior（observer judge 可判读产出）。
  events: [
    { type: 'e2e-pass', producer: 'behavior', attribution: 'external' },
    { type: 'e2e-fail', producer: 'behavior', attribution: 'external' },
  ],
  // judge 受限数据槽：只填描述/提示，安全骨架（UNTRUSTED/工具禁用/schema/source 别名）不可配置。
  // **不设 outputEventRegistry**——本类型 observer 同一个 judge 还要判读 submit/review-pass/review-reject，收窄会一起 fail-closed。
  judge: {
    eventDescriptions: {
      'e2e-pass': 'e2e 验证员（豆包M）在真机跑完 e2e 且明确全部通过 / 验证成功',
      'e2e-fail': 'e2e 验证员（豆包M）在真机跑 e2e 报告失败 / 用例不通过 / 报错 / 现象与预期不符',
    },
    decisionHints: [
      '只在 e2e 验证员（豆包M）明确回报 e2e 结果时判 e2e-pass / e2e-fail；开发者或其他人的讨论不算',
      'e2e-pass 与 e2e-fail 互斥：一次回报只产其中一个；含失败 / 报错 / 未通过 / 与预期不符即 e2e-fail',
      '尚未开始跑 / 进行中 / 环境没起来 / 在装包等中间态都不判（不产事件）',
    ],
  },
};

/**
 * 自包含 config 包（深拷贝）——含 two_layer（提供共享角色/规则）+ dev_with_e2e 两个类型，照配即用。
 * 供 import / 集成测试 replaceTaskTeamConfig 一次落库（dev_with_e2e 复用 two_layer 的角色与规则，故必须同包提供）。
 */
export function devWithE2eConfigBundle(): {
  roles: TaskTeamRole[];
  rules: TaskTeamCollabRule[];
  teamTypes: TaskTeamType[];
} {
  const base = defaultTaskTeamSeed(); // two_layer：developer/architect/detail_reviewer/observer 角色 + submit/architect-pass/detail-pass/reject/stall 规则 + two_layer 类型
  return {
    roles: [...base.roles.map(r => structuredClone(r)), structuredClone(E2E_RUNNER_ROLE)],
    rules: [...base.rules.map(r => structuredClone(r)), ...DEV_WITH_E2E_RULES.map(r => structuredClone(r))],
    teamTypes: [...base.teamTypes.map(t => structuredClone(t)), structuredClone(DEV_WITH_E2E_TEAM_TYPE)],
  };
}

/**
 * 幂等安装 dev_with_e2e 类型到 config store（生产建组路径用，**不动** defaultTaskTeamSeed）：
 *  1) 先确保共享角色/规则在库（seedDefaultTaskTeamConfig 幂等，仅空库时种）；
 *  2) upsert e2e_runner 角色 → 3 条新规则 → 新类型（顺序保证 type 落库时其引用的角色/规则齐全，validator 守卫干净通过）。
 * 重复调用是 no-op 覆盖（按 id 去重），可在每次建组前安全调用。
 */
export async function seedDevWithE2eType(): Promise<void> {
  await seedDefaultTaskTeamConfig();
  await upsertTaskTeamRole(structuredClone(E2E_RUNNER_ROLE));
  for (const rule of DEV_WITH_E2E_RULES) {
    await upsertTaskTeamRule(structuredClone(rule));
  }
  await upsertTaskTeamType(structuredClone(DEV_WITH_E2E_TEAM_TYPE));
}
