import { describe, expect, it } from 'vitest';
import { decideTeamActions } from '../src/services/taskteam-engine.js';
import type { TeamDecision, TeamEvent } from '../src/services/taskteam-engine.js';
import type {
  TaskTeamCollabRule,
  TaskTeamInstance,
  TaskTeamRole,
  TaskTeamRoleInstance,
  TaskTeamType,
} from '../src/services/taskteam-schema.js';

// —— 固定动作集省略字段的最小角色 ——
function role(roleId: string, name: string, opts: Partial<TaskTeamRole> = {}): TaskTeamRole {
  return {
    roleId: roleId as TaskTeamRole['roleId'],
    name,
    responsibility: name,
    activation: { trigger: opts.activation?.trigger ?? 'team-started' },
    visibility: opts.visibility ?? 'full',
    actions: opts.actions ?? ['submit', 'review-pass', 'review-reject', 'rework', 'report', 'finish'],
    io: { from: [], to: [] },
    isObserver: opts.isObserver,
  };
}

function ri(roleInstanceId: string, slotId: string, roleId: string): TaskTeamRoleInstance {
  return {
    roleInstanceId: roleInstanceId as TaskTeamRoleInstance['roleInstanceId'],
    slotId: slotId as TaskTeamRoleInstance['slotId'],
    roleId: roleId as TaskTeamRoleInstance['roleId'],
    binding: {
      bindingId: `tt_binding_${roleInstanceId}` as never,
      botOpenId: `ou_${roleInstanceId}`,
      larkAppId: 'cli_test',
    },
  };
}

// 两层 review 固件（开发者 → 架构师 → 审查员；单审 quorum=1）
function twoLayerFixture() {
  const roles = [
    role('tt_role_developer', '开发者', { activation: { trigger: 'team-started' } }),
    role('tt_role_architect', '架构师', { activation: { trigger: 'developer-submit' }, visibility: 'review-only' }),
    role('tt_role_detail', '审查员', { activation: { trigger: 'architecture-pass' }, visibility: 'review-only' }),
    role('tt_role_observer', '盯梢', { activation: { trigger: 'observer-tick' }, isObserver: true }),
  ];
  const rules: TaskTeamCollabRule[] = [
    { ruleId: 'tt_rule_0', when: { event: 'submit', status: 'running' }, whoSlot: 'tt_slot_arch', do: 'request-review' },
    { ruleId: 'tt_rule_1', when: { event: 'review-pass', status: 'reviewing', fromSlotId: 'tt_slot_arch' }, whoSlot: 'tt_slot_detail', do: 'request-review' },
    { ruleId: 'tt_rule_2', when: { event: 'review-pass', status: 'reviewing', fromSlotId: 'tt_slot_detail' }, whoSlot: 'tt_slot_dev', do: 'report' },
    { ruleId: 'tt_rule_3', when: { event: 'review-reject', status: 'reviewing' }, whoSlot: 'tt_slot_dev', do: 'nudge' },
    { ruleId: 'tt_rule_4', when: { event: 'stall', status: 'running' }, whoSlot: 'tt_slot_obs', do: 'escalate' },
  ];
  const type: TaskTeamType = {
    typeId: 'tt_type_two_layer',
    name: '两层 review',
    roleSlots: [
      { slotId: 'tt_slot_dev', roleId: 'tt_role_developer' },
      { slotId: 'tt_slot_arch', roleId: 'tt_role_architect' },
      { slotId: 'tt_slot_detail', roleId: 'tt_role_detail' },
      { slotId: 'tt_slot_obs', roleId: 'tt_role_observer' },
    ],
    rules: rules.map(r => r.ruleId),
    policy: { reviewRounds: 2, reviewQuorum: 1, maxRework: 2, escalateAfterStallMs: 1000, reviewOrder: ['tt_slot_arch', 'tt_slot_detail'] },
  };
  const instance: TaskTeamInstance = {
    teamId: 'tt_team_x',
    typeId: type.typeId,
    companyId: 'tt_company_x',
    chatId: 'oc_x',
    goal: 'g',
    acceptance: 'a',
    roleInstances: [
      ri('tt_ri_dev', 'tt_slot_dev', 'tt_role_developer'),
      ri('tt_ri_arch', 'tt_slot_arch', 'tt_role_architect'),
      ri('tt_ri_detail', 'tt_slot_detail', 'tt_role_detail'),
      ri('tt_ri_obs', 'tt_slot_obs', 'tt_role_observer'),
    ],
    status: 'forming',
    progress: '',
    reviewState: { round: 0, reworkCount: 0, votes: [] },
    version: 1,
    createdAt: 't',
    updatedAt: 't',
  };
  return { roles, rules, type, instance };
}

// 驱动层最小模拟：把 decision 的状态跃迁落回 instance
function apply(instance: TaskTeamInstance, d: TeamDecision): TaskTeamInstance {
  return {
    ...instance,
    status: d.nextStatus ?? instance.status,
    reviewState: d.reviewState ?? instance.reviewState,
  };
}

function decide(fix: ReturnType<typeof twoLayerFixture>, instance: TaskTeamInstance, event: TeamEvent) {
  return decideTeamActions({ instance, type: fix.type, roles: fix.roles, rules: fix.rules, event });
}

describe('decideTeamActions', () => {
  it('runs the happy path: start → submit → architect → detail → awaiting-acceptance → accept', () => {
    const fix = twoLayerFixture();
    let inst = fix.instance;

    // team-started → running + kickoff 开发者
    let d = decide(fix, inst, { type: 'team-started' });
    expect(d.nextStatus).toBe('running');
    expect(d.actions).toEqual([
      expect.objectContaining({ actionType: 'kickoff', targetRoleInstanceId: 'tt_ri_dev' }),
    ]);
    inst = apply(inst, d);

    // submit → request-review 架构师，进入 reviewing
    d = decide(fix, inst, { type: 'submit', fromRoleInstanceId: 'tt_ri_dev', fromSlotId: 'tt_slot_dev' });
    expect(d.nextStatus).toBe('reviewing');
    expect(d.actions).toEqual([
      expect.objectContaining({ actionType: 'request-review', targetRoleInstanceId: 'tt_ri_arch' }),
    ]);
    expect(d.reviewState?.round).toBe(1);
    inst = apply(inst, d);

    // 架构师 pass（quorum 1）→ request-review 审查员
    d = decide(fix, inst, { type: 'review-pass', fromRoleInstanceId: 'tt_ri_arch', fromSlotId: 'tt_slot_arch' });
    expect(d.actions).toEqual([
      expect.objectContaining({ actionType: 'request-review', targetRoleInstanceId: 'tt_ri_detail' }),
    ]);
    expect(d.nextStatus).toBe('reviewing');
    expect(d.reviewState?.votes).toEqual([]); // 推进后清票
    inst = apply(inst, d);

    // 审查员 pass → report 开发者（待验收）
    d = decide(fix, inst, { type: 'review-pass', fromRoleInstanceId: 'tt_ri_detail', fromSlotId: 'tt_slot_detail' });
    expect(d.actions).toEqual([
      expect.objectContaining({ actionType: 'report', targetRoleInstanceId: 'tt_ri_dev' }),
    ]);
    expect(d.nextStatus).toBe('awaiting-acceptance');
    inst = apply(inst, d);

    // owner accept → done
    d = decide(fix, inst, { type: 'accept' });
    expect(d.nextStatus).toBe('done');
  });

  it('review-reject nudges developer back to running and bumps reworkCount', () => {
    const fix = twoLayerFixture();
    const inst: TaskTeamInstance = { ...fix.instance, status: 'reviewing', reviewState: { round: 1, reworkCount: 0, votes: [] } };

    const d = decide(fix, inst, { type: 'review-reject', fromRoleInstanceId: 'tt_ri_arch', fromSlotId: 'tt_slot_arch', reason: 'no' });
    expect(d.nextStatus).toBe('running');
    expect(d.reviewState?.reworkCount).toBe(1);
    expect(d.actions).toEqual([
      expect.objectContaining({ actionType: 'nudge', targetRoleInstanceId: 'tt_ri_dev' }),
    ]);
  });

  it('escalates to observer and blocks once maxRework is exceeded', () => {
    const fix = twoLayerFixture(); // maxRework=2
    const inst: TaskTeamInstance = { ...fix.instance, status: 'reviewing', reviewState: { round: 3, reworkCount: 2, votes: [] } };

    const d = decide(fix, inst, { type: 'review-reject', fromRoleInstanceId: 'tt_ri_arch', fromSlotId: 'tt_slot_arch' });
    expect(d.nextStatus).toBe('blocked');
    expect(d.reviewState?.reworkCount).toBe(3);
    expect(d.actions).toEqual([
      expect.objectContaining({ actionType: 'escalate', targetRoleInstanceId: 'tt_ri_obs' }),
    ]);
  });

  it('stall escalates to observer without changing status', () => {
    const fix = twoLayerFixture();
    const inst: TaskTeamInstance = { ...fix.instance, status: 'running' };
    const d = decide(fix, inst, { type: 'stall' });
    expect(d.actions).toEqual([
      expect.objectContaining({ actionType: 'escalate', targetRoleInstanceId: 'tt_ri_obs' }),
    ]);
    expect(d.nextStatus).toBeUndefined();
  });

  it('is config-driven: adding a new review role + rule inserts a stage with zero engine change', () => {
    // 在两层之间插入「安全审查」角色 + 一条规则（纯改 config），引擎不变
    const fix = twoLayerFixture();
    const roles = [...fix.roles, role('tt_role_security', '安全审查', { visibility: 'review-only' })];
    const rules: TaskTeamCollabRule[] = [
      ...fix.rules.filter(r => r.ruleId !== 'tt_rule_1'),
      // 架构 pass → 先过安全审查
      { ruleId: 'tt_rule_sec_a', when: { event: 'review-pass', status: 'reviewing', fromSlotId: 'tt_slot_arch' }, whoSlot: 'tt_slot_sec', do: 'request-review' },
      // 安全 pass → 再过审查员
      { ruleId: 'tt_rule_sec_b', when: { event: 'review-pass', status: 'reviewing', fromSlotId: 'tt_slot_sec' }, whoSlot: 'tt_slot_detail', do: 'request-review' },
    ];
    const type: TaskTeamType = {
      ...fix.type,
      roleSlots: [...fix.type.roleSlots, { slotId: 'tt_slot_sec', roleId: 'tt_role_security' }],
    };
    const instance: TaskTeamInstance = {
      ...fix.instance,
      status: 'reviewing',
      reviewState: { round: 1, reworkCount: 0, votes: [] },
      roleInstances: [...fix.instance.roleInstances, ri('tt_ri_sec', 'tt_slot_sec', 'tt_role_security')],
    };

    const d = decideTeamActions({ instance, type, roles, rules, event: { type: 'review-pass', fromRoleInstanceId: 'tt_ri_arch', fromSlotId: 'tt_slot_arch' } });
    expect(d.actions).toEqual([
      expect.objectContaining({ actionType: 'request-review', targetRoleInstanceId: 'tt_ri_sec' }),
    ]);
    expect(d.nextStatus).toBe('reviewing');
  });

  it('honors quorum across count>1 reviewers of the same role (B2)', () => {
    // 两个审查员同 role、quorum=2：架构 pass 扇出请求给两人；一人 pass 不推进，两人 pass 才推进
    const roles = [
      role('tt_role_developer', '开发者'),
      role('tt_role_architect', '架构师', { visibility: 'review-only' }),
      role('tt_role_detail', '审查员', { visibility: 'review-only' }),
    ];
    const rules: TaskTeamCollabRule[] = [
      { ruleId: 'tt_rule_a', when: { event: 'review-pass', status: 'reviewing', fromSlotId: 'tt_slot_arch' }, whoSlot: 'tt_slot_d1', do: 'request-review' },
      { ruleId: 'tt_rule_b', when: { event: 'review-pass', status: 'reviewing', fromSlotId: 'tt_slot_d1' }, whoSlot: 'tt_slot_dev', do: 'report' },
    ];
    const type: TaskTeamType = {
      typeId: 'tt_type_quorum',
      name: 'quorum',
      roleSlots: [
        { slotId: 'tt_slot_dev', roleId: 'tt_role_developer' },
        { slotId: 'tt_slot_arch', roleId: 'tt_role_architect' },
        { slotId: 'tt_slot_d1', roleId: 'tt_role_detail' },
        { slotId: 'tt_slot_d2', roleId: 'tt_role_detail' },
      ],
      rules: rules.map(r => r.ruleId),
      policy: { reviewRounds: 1, reviewQuorum: 2, maxRework: 2, escalateAfterStallMs: 1000, reviewOrder: ['tt_slot_d1', 'tt_slot_d2'] },
    };
    let instance: TaskTeamInstance = {
      teamId: 'tt_team_q',
      typeId: type.typeId,
      companyId: 'tt_company_q',
      chatId: 'oc_q',
      goal: 'g',
      acceptance: 'a',
      roleInstances: [
        ri('tt_ri_dev', 'tt_slot_dev', 'tt_role_developer'),
        ri('tt_ri_arch', 'tt_slot_arch', 'tt_role_architect'),
        ri('tt_ri_d1', 'tt_slot_d1', 'tt_role_detail'),
        ri('tt_ri_d2', 'tt_slot_d2', 'tt_role_detail'),
      ],
      status: 'reviewing',
      progress: '',
      reviewState: { round: 1, reworkCount: 0, votes: [] },
      version: 1,
      createdAt: 't',
      updatedAt: 't',
    };

    // 架构 pass → 扇出请求给两个审查员
    let d = decideTeamActions({ instance, type, roles, rules, event: { type: 'review-pass', fromRoleInstanceId: 'tt_ri_arch', fromSlotId: 'tt_slot_arch' } });
    expect(d.actions.map(a => a.targetRoleInstanceId).sort()).toEqual(['tt_ri_d1', 'tt_ri_d2']);
    expect(d.actions.every(a => a.actionType === 'request-review')).toBe(true);
    instance = apply(instance, d);

    // 审查员1 pass → 未达 quorum(2)，仅记票、不推进
    d = decideTeamActions({ instance, type, roles, rules, event: { type: 'review-pass', fromRoleInstanceId: 'tt_ri_d1', fromSlotId: 'tt_slot_d1' } });
    expect(d.actions).toEqual([]);
    expect(d.reviewState?.votes.map(v => v.byInstanceId)).toEqual(['tt_ri_d1']);
    instance = apply(instance, d);

    // 审查员2 pass → 达 quorum(2)，推进 report
    d = decideTeamActions({ instance, type, roles, rules, event: { type: 'review-pass', fromRoleInstanceId: 'tt_ri_d2', fromSlotId: 'tt_slot_d2' } });
    expect(d.actions).toEqual([
      expect.objectContaining({ actionType: 'report', targetRoleInstanceId: 'tt_ri_dev' }),
    ]);
    expect(d.nextStatus).toBe('awaiting-acceptance');
  });

  it('is a pure deterministic function (same input → same output, no mutation)', () => {
    const fix = twoLayerFixture();
    const event: TeamEvent = { type: 'submit', fromRoleInstanceId: 'tt_ri_dev', fromSlotId: 'tt_slot_dev' };
    const inst: TaskTeamInstance = { ...fix.instance, status: 'running' };
    const snapshot = JSON.stringify(inst);
    const d1 = decide(fix, inst, event);
    const d2 = decide(fix, inst, event);
    expect(d1).toEqual(d2);
    expect(JSON.stringify(inst)).toBe(snapshot); // 入参未被修改
  });
});
