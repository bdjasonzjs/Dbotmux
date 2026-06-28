// 阶段1 兼容回归（设计 §8 补充验收项 + task-context 兼容红线）：
//  - defaultTaskTeamSeed() 逐字钉死（canonical typeId/roleId/slotId/ruleId/顺序/policy 一律不动）。
//  - planOnboarding() 空 config 仍选 tt_type_two_layer_review 且 seats 顺序不变（deepEqual seed 钉不住 onboarding 的 types[0]）。
import { describe, expect, it } from 'vitest';
import { defaultTaskTeamSeed } from '../src/services/taskteam-config-store.js';
import { planOnboarding } from '../src/services/taskteam-onboard.js';
import type { TaskTeamConfigFile } from '../src/services/taskteam-schema.js';

const EMPTY_CONFIG: TaskTeamConfigFile = {
  version: 1, roles: [], rules: [], teamTypes: [], orgStructures: [], orgRuntimeBindings: [], updatedAt: 't',
};

describe('阶段1 兼容红线：开发团队 seed / onboarding 逐字不漂', () => {
  it('defaultTaskTeamSeed() deepEqual golden（四内核改动不得动开发团队 canonical 形态）', () => {
    expect(defaultTaskTeamSeed()).toEqual({
      roles: [
        {
          roleId: 'tt_role_developer', name: '开发者', responsibility: '按批次实现方案和单测',
          activation: { trigger: 'team-started' }, visibility: 'full',
          actions: ['submit', 'review-pass', 'review-reject', 'rework', 'ask-help', 'report', 'finish'],
          io: { from: [], to: [{ roleId: 'tt_role_architect' }] }, seatHint: { engine: 'claude' },
        },
        {
          roleId: 'tt_role_architect', name: '架构师', responsibility: '审核实现是否符合产品设计和技术方案',
          activation: { trigger: 'developer-submit' }, visibility: 'review-only',
          actions: ['review-pass', 'review-reject', 'ask-help', 'report'],
          io: { from: [{ roleId: 'tt_role_developer' }], to: [{ roleId: 'tt_role_detail_reviewer' }, { roleId: 'tt_role_developer' }] },
          seatHint: { engine: 'claude' },
        },
        {
          roleId: 'tt_role_detail_reviewer', name: '审查员', responsibility: '代码细节 review，确认无 P1 后交还验收',
          activation: { trigger: 'architecture-pass' }, visibility: 'review-only',
          actions: ['review-pass', 'review-reject', 'ask-help', 'report'],
          io: { from: [{ roleId: 'tt_role_architect' }], to: [{ roleId: 'tt_role_developer' }] },
          seatHint: { engine: 'codex' },
        },
        {
          roleId: 'tt_role_observer', name: '盯梢', responsibility: '低成本观察进展和健康度，必要时上报卡点',
          activation: { trigger: 'observer-tick' }, visibility: 'progress-only',
          actions: ['report', 'ask-help', 'escalate'],
          io: { from: [{ roleId: 'tt_role_developer' }, { roleId: 'tt_role_architect' }, { roleId: 'tt_role_detail_reviewer' }], to: [] },
          seatHint: { engine: 'coco' }, isObserver: true,
        },
      ],
      rules: [
        { ruleId: 'tt_rule_submit_to_architect', when: { event: 'submit', status: 'running' }, whoSlot: 'tt_slot_architect_main', do: 'request-review' },
        { ruleId: 'tt_rule_architect_pass_to_detail', when: { event: 'review-pass', status: 'reviewing', fromSlotId: 'tt_slot_architect_main' }, whoSlot: 'tt_slot_detail_reviewer_main', do: 'request-review' },
        { ruleId: 'tt_rule_detail_pass_to_acceptance', when: { event: 'review-pass', status: 'reviewing', fromSlotId: 'tt_slot_detail_reviewer_main' }, whoSlot: 'tt_slot_developer_main', do: 'report' },
        { ruleId: 'tt_rule_reject_to_rework', when: { event: 'review-reject', status: 'reviewing' }, whoSlot: 'tt_slot_developer_main', do: 'nudge' },
        { ruleId: 'tt_rule_observer_stall_report', when: { event: 'stall', status: 'running' }, whoSlot: 'tt_slot_observer_main', do: 'escalate' },
      ],
      teamTypes: [
        {
          typeId: 'tt_type_two_layer_review', name: '两层 review 任务小组',
          roleSlots: [
            { slotId: 'tt_slot_developer_main', roleId: 'tt_role_developer', label: 'main' },
            { slotId: 'tt_slot_architect_main', roleId: 'tt_role_architect', label: 'architecture-review' },
            { slotId: 'tt_slot_detail_reviewer_main', roleId: 'tt_role_detail_reviewer', label: 'detail-review' },
            { slotId: 'tt_slot_observer_main', roleId: 'tt_role_observer', label: 'observer' },
          ],
          rules: [
            'tt_rule_submit_to_architect', 'tt_rule_architect_pass_to_detail', 'tt_rule_detail_pass_to_acceptance',
            'tt_rule_reject_to_rework', 'tt_rule_observer_stall_report',
          ],
          policy: { reviewRounds: 2, reviewQuorum: 1, maxRework: 3, escalateAfterStallMs: 30 * 60 * 1000, reviewOrder: ['tt_slot_architect_main', 'tt_slot_detail_reviewer_main'] },
        },
      ],
      orgStructures: [
        { companyName: '一人公司', departments: [{ deptName: '默认部门', teamTypeIds: ['tt_type_two_layer_review'] }] },
      ],
      orgRuntimeBindings: [],
    });
  });

  it('seed 不引入 events / transition 字段（阶段1 新增字段都可选，不污染开发团队 canonical 形态）', () => {
    const seed = defaultTaskTeamSeed();
    expect(seed.teamTypes[0]).not.toHaveProperty('events');
    for (const r of seed.rules) expect(r).not.toHaveProperty('transition');
  });

  it('planOnboarding() 空 config 仍选 tt_type_two_layer_review，seats 顺序逐字不变', () => {
    const bots = [1, 2, 3, 4].map(i => ({ larkAppId: `cli_${i}`, botName: `b${i}`, botOpenId: `ou_${i}` }));
    const plan = planOnboarding({ config: EMPTY_CONFIG, availableBots: bots });
    expect(plan.sampleTypeId).toBe('tt_type_two_layer_review');
    expect(plan.seats.map(s => s.slotId)).toEqual([
      'tt_slot_developer_main', 'tt_slot_architect_main', 'tt_slot_detail_reviewer_main', 'tt_slot_observer_main',
    ]);
  });
});
