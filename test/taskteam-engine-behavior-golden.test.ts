// 阶段四 behavior-golden（最高优先级回归锁）——动任何 special case 之前，先把**当前引擎对 dev-team 的完整决策输出**
// 用 inline snapshot 固化。dev-team 配置直接取自 defaultTaskTeamSeed()（锁的是真实出厂行为，不是手搓固件）。
// 之后每改一步重跑：snapshot 必须逐字一致，一漂即红。
//
// 另含「generality 证明」：用一个**非 dev** 的具名 type（quorum=2 / maxRework=1）跑同样 4 个 lifecycle 事件，
// 证明引擎对 team-started/review-pass/review-reject/accept 的处理是**按 type.policy 参数化的通用解释**、
// 不含 dev-team 专属硬编码——换 type 填不同 policy，同一段引擎代码产出该 type 应有的行为。
import { describe, expect, it } from 'vitest';
import { decideTeamActions } from '../src/services/taskteam-engine.js';
import type { TeamDecision, TeamEvent } from '../src/services/taskteam-engine.js';
import { defaultTaskTeamSeed } from '../src/services/taskteam-config-store.js';
import type {
  TaskTeamCollabRule,
  TaskTeamInstance,
  TaskTeamRole,
  TaskTeamRoleInstance,
  TaskTeamType,
} from '../src/services/taskteam-schema.js';

const seed = defaultTaskTeamSeed();
const DEV_ROLES = seed.roles;
const DEV_RULES = seed.rules;
const DEV_TYPE = seed.teamTypes[0];

function devRi(id: string, slotId: string, roleId: string): TaskTeamRoleInstance {
  return { roleInstanceId: id as never, slotId: slotId as never, roleId: roleId as never };
}
function devInstance(over: Partial<TaskTeamInstance> = {}): TaskTeamInstance {
  return {
    teamId: 'tt_team_dev',
    typeId: DEV_TYPE.typeId,
    companyId: 'tt_company_dev',
    chatId: 'oc_dev',
    goal: 'g',
    acceptance: 'a',
    roleInstances: [
      devRi('tt_ri_dev', 'tt_slot_developer_main', 'tt_role_developer'),
      devRi('tt_ri_arch', 'tt_slot_architect_main', 'tt_role_architect'),
      devRi('tt_ri_detail', 'tt_slot_detail_reviewer_main', 'tt_role_detail_reviewer'),
      devRi('tt_ri_obs', 'tt_slot_observer_main', 'tt_role_observer'),
    ],
    status: 'forming',
    progress: '',
    reviewState: { round: 0, reworkCount: 0, votes: [] },
    version: 1,
    createdAt: 't',
    updatedAt: 't',
    ...over,
  };
}
function ev(type: string, opts: Partial<TeamEvent> = {}): TeamEvent {
  return { type, ...opts };
}
function decideDev(inst: TaskTeamInstance, event: TeamEvent): TeamDecision {
  return decideTeamActions({ instance: inst, type: DEV_TYPE, roles: DEV_ROLES, rules: DEV_RULES, event });
}
// 驱动层最小模拟：把决策的状态跃迁落回 instance（与既有 engine.test.ts 一致）
function apply(inst: TaskTeamInstance, d: TeamDecision): TaskTeamInstance {
  return { ...inst, status: d.nextStatus ?? inst.status, reviewState: d.reviewState ?? inst.reviewState };
}

describe('阶段四 behavior-golden · dev-team 生命周期决策逐字固化', () => {
  it('happy path：team-started → submit → review-pass(架构) → review-pass(细节) → accept', () => {
    let inst = devInstance();

    const dStart = decideDev(inst, ev('team-started'));
    expect(dStart).toMatchInlineSnapshot(`
      {
        "actions": [
          {
            "actionType": "kickoff",
            "idempotencyKey": "tt_team_dev:start:kickoff:tt_ri_dev",
            "payload": undefined,
            "sourceRoleInstanceId": undefined,
            "targetRoleInstanceId": "tt_ri_dev",
            "targetSlotId": "tt_slot_developer_main",
          },
        ],
        "nextStatus": "running",
        "reviewState": {
          "reworkCount": 0,
          "round": 0,
          "votes": [],
        },
      }
    `);
    inst = apply(inst, dStart);
    expect(inst.status).toBe('running');

    const dSubmit = decideDev(inst, ev('submit', { fromRoleInstanceId: 'tt_ri_dev', fromSlotId: 'tt_slot_developer_main' }));
    expect(dSubmit).toMatchInlineSnapshot(`
      {
        "actions": [
          {
            "actionType": "request-review",
            "idempotencyKey": "tt_team_dev:submit:r0:tt_rule_submit_to_architect:tt_ri_arch",
            "payload": undefined,
            "sourceRoleInstanceId": "tt_ri_dev",
            "targetRoleInstanceId": "tt_ri_arch",
            "targetSlotId": "tt_slot_architect_main",
          },
        ],
        "nextStatus": "reviewing",
        "reviewState": {
          "reworkCount": 0,
          "round": 1,
          "votes": [],
        },
      }
    `);
    inst = apply(inst, dSubmit);
    expect(inst.status).toBe('reviewing');

    const dPassArch = decideDev(inst, ev('review-pass', { fromRoleInstanceId: 'tt_ri_arch', fromSlotId: 'tt_slot_architect_main' }));
    expect(dPassArch).toMatchInlineSnapshot(`
      {
        "actions": [
          {
            "actionType": "request-review",
            "idempotencyKey": "tt_team_dev:review-pass:r1:tt_rule_architect_pass_to_detail:tt_ri_detail",
            "payload": undefined,
            "sourceRoleInstanceId": "tt_ri_arch",
            "targetRoleInstanceId": "tt_ri_detail",
            "targetSlotId": "tt_slot_detail_reviewer_main",
          },
        ],
        "nextStatus": "reviewing",
        "reviewState": {
          "reworkCount": 0,
          "round": 2,
          "votes": [],
        },
      }
    `);
    inst = apply(inst, dPassArch);
    expect(inst.status).toBe('reviewing');

    const dPassDetail = decideDev(inst, ev('review-pass', { fromRoleInstanceId: 'tt_ri_detail', fromSlotId: 'tt_slot_detail_reviewer_main' }));
    expect(dPassDetail).toMatchInlineSnapshot(`
      {
        "actions": [
          {
            "actionType": "report",
            "idempotencyKey": "tt_team_dev:review-pass:r2:tt_rule_detail_pass_to_acceptance:tt_ri_dev",
            "payload": undefined,
            "sourceRoleInstanceId": "tt_ri_detail",
            "targetRoleInstanceId": "tt_ri_dev",
            "targetSlotId": "tt_slot_developer_main",
          },
        ],
        "nextStatus": "awaiting-acceptance",
        "reviewState": {
          "reworkCount": 0,
          "round": 3,
          "votes": [],
        },
      }
    `);
    inst = apply(inst, dPassDetail);
    expect(inst.status).toBe('awaiting-acceptance');

    const dAccept = decideDev(inst, ev('accept'));
    expect(dAccept).toMatchInlineSnapshot(`
      {
        "actions": [],
        "nextStatus": "done",
      }
    `);
    inst = apply(inst, dAccept);
    expect(inst.status).toBe('done');
  });

  it('accept 仅在 awaiting-acceptance 有效（其它状态 no-op）', () => {
    const inst = devInstance({ status: 'reviewing', reviewState: { round: 2, reworkCount: 0, votes: [] } });
    const d = decideDev(inst, ev('accept'));
    expect(d).toMatchInlineSnapshot(`
      {
        "actions": [],
      }
    `);
  });

  it('reject 链：review-reject 累 rework 到 > maxRework(3) → escalate observer + blocked', () => {
    // reviewing 态逐次 reject；前 3 次 nudge+running，第 4 次（reworkCount 3→4 > 3）escalate+blocked。
    const snap: TeamDecision[] = [];
    for (let rework = 0; rework <= 3; rework++) {
      const inst = devInstance({ status: 'reviewing', reviewState: { round: 2, reworkCount: rework, votes: [] } });
      snap.push(decideDev(inst, ev('review-reject', { fromRoleInstanceId: 'tt_ri_arch', fromSlotId: 'tt_slot_architect_main' })));
    }
    expect(snap).toMatchInlineSnapshot(`
      [
        {
          "actions": [
            {
              "actionType": "nudge",
              "idempotencyKey": "tt_team_dev:review-reject:r2:tt_rule_reject_to_rework:tt_ri_dev",
              "payload": undefined,
              "sourceRoleInstanceId": "tt_ri_arch",
              "targetRoleInstanceId": "tt_ri_dev",
              "targetSlotId": "tt_slot_developer_main",
            },
          ],
          "nextStatus": "running",
          "reviewState": {
            "reworkCount": 1,
            "round": 2,
            "votes": [],
          },
        },
        {
          "actions": [
            {
              "actionType": "nudge",
              "idempotencyKey": "tt_team_dev:review-reject:r2:tt_rule_reject_to_rework:tt_ri_dev",
              "payload": undefined,
              "sourceRoleInstanceId": "tt_ri_arch",
              "targetRoleInstanceId": "tt_ri_dev",
              "targetSlotId": "tt_slot_developer_main",
            },
          ],
          "nextStatus": "running",
          "reviewState": {
            "reworkCount": 2,
            "round": 2,
            "votes": [],
          },
        },
        {
          "actions": [
            {
              "actionType": "nudge",
              "idempotencyKey": "tt_team_dev:review-reject:r2:tt_rule_reject_to_rework:tt_ri_dev",
              "payload": undefined,
              "sourceRoleInstanceId": "tt_ri_arch",
              "targetRoleInstanceId": "tt_ri_dev",
              "targetSlotId": "tt_slot_developer_main",
            },
          ],
          "nextStatus": "running",
          "reviewState": {
            "reworkCount": 3,
            "round": 2,
            "votes": [],
          },
        },
        {
          "actions": [
            {
              "actionType": "escalate",
              "idempotencyKey": "tt_team_dev:r2:max-rework:escalate:tt_ri_obs",
              "payload": {
                "reason": "max-rework-exceeded",
              },
              "sourceRoleInstanceId": "tt_ri_arch",
              "targetRoleInstanceId": "tt_ri_obs",
              "targetSlotId": "tt_slot_observer_main",
            },
          ],
          "nextStatus": "blocked",
          "reviewState": {
            "reworkCount": 4,
            "round": 2,
            "votes": [],
          },
        },
      ]
    `);
  });

  it('review-pass 未达 quorum 只记票不推进（这里 quorum=1 → 单票即推进，锁单审席行为）', () => {
    const inst = devInstance({ status: 'reviewing', reviewState: { round: 1, reworkCount: 0, votes: [] } });
    const d = decideDev(inst, ev('review-pass', { fromRoleInstanceId: 'tt_ri_arch', fromSlotId: 'tt_slot_architect_main' }));
    expect(d).toMatchInlineSnapshot(`
      {
        "actions": [
          {
            "actionType": "request-review",
            "idempotencyKey": "tt_team_dev:review-pass:r1:tt_rule_architect_pass_to_detail:tt_ri_detail",
            "payload": undefined,
            "sourceRoleInstanceId": "tt_ri_arch",
            "targetRoleInstanceId": "tt_ri_detail",
            "targetSlotId": "tt_slot_detail_reviewer_main",
          },
        ],
        "nextStatus": "reviewing",
        "reviewState": {
          "reworkCount": 0,
          "round": 2,
          "votes": [],
        },
      }
    `);
  });
});

// ── generality 证明：非 dev type，quorum=2 / maxRework=1，同一引擎按 policy 参数化产出 ──────────────
function genRole(roleId: string, opts: Partial<TaskTeamRole> = {}): TaskTeamRole {
  return {
    roleId: roleId as never,
    name: roleId,
    responsibility: roleId,
    activation: { trigger: opts.activation?.trigger ?? 'team-started' },
    visibility: opts.visibility ?? 'full',
    actions: opts.actions ?? ['submit', 'review-pass', 'review-reject', 'report'],
    io: { from: [], to: [] },
    isObserver: opts.isObserver,
  };
}
function genRi(id: string, slotId: string, roleId: string): TaskTeamRoleInstance {
  return { roleInstanceId: id as never, slotId: slotId as never, roleId: roleId as never };
}
function genFixture() {
  const roles = [
    genRole('tt_role_g_exec', { activation: { trigger: 'team-started' } }),
    genRole('tt_role_g_rev', { activation: { trigger: 'exec-submit' }, visibility: 'review-only' }),
    genRole('tt_role_g_obs', { activation: { trigger: 'observer-tick' }, isObserver: true }),
  ];
  const rules: TaskTeamCollabRule[] = [
    { ruleId: 'tt_rule_g_submit', when: { event: 'submit', status: 'running' }, whoSlot: 'tt_slot_g_rev1', do: 'request-review' },
    { ruleId: 'tt_rule_g_pass', when: { event: 'review-pass', status: 'reviewing', fromSlotId: 'tt_slot_g_rev1' }, whoSlot: 'tt_slot_g_exec', do: 'report' },
    { ruleId: 'tt_rule_g_reject', when: { event: 'review-reject', status: 'reviewing' }, whoSlot: 'tt_slot_g_exec', do: 'nudge' },
    { ruleId: 'tt_rule_g_esc', when: { event: 'review-reject', status: 'reviewing' }, whoSlot: 'tt_slot_g_obs', do: 'escalate' },
  ];
  const type: TaskTeamType = {
    typeId: 'tt_type_generic_review',
    name: 'generic quorum-2',
    roleSlots: [
      { slotId: 'tt_slot_g_exec', roleId: 'tt_role_g_exec' },
      { slotId: 'tt_slot_g_rev1', roleId: 'tt_role_g_rev' },
      { slotId: 'tt_slot_g_rev2', roleId: 'tt_role_g_rev' },
      { slotId: 'tt_slot_g_obs', roleId: 'tt_role_g_obs' },
    ],
    rules: rules.map(r => r.ruleId),
    policy: { reviewRounds: 1, reviewQuorum: 2, maxRework: 1, escalateAfterStallMs: 0, reviewOrder: ['tt_slot_g_rev1', 'tt_slot_g_rev2'] },
  };
  const instance: TaskTeamInstance = {
    teamId: 'tt_team_g', typeId: type.typeId, companyId: 'tt_company_g', chatId: 'oc_g',
    goal: 'g', acceptance: 'a',
    roleInstances: [
      genRi('tt_ri_g_exec', 'tt_slot_g_exec', 'tt_role_g_exec'),
      genRi('tt_ri_g_rev1', 'tt_slot_g_rev1', 'tt_role_g_rev'),
      genRi('tt_ri_g_rev2', 'tt_slot_g_rev2', 'tt_role_g_rev'),
      genRi('tt_ri_g_obs', 'tt_slot_g_obs', 'tt_role_g_obs'),
    ],
    status: 'forming', progress: '', reviewState: { round: 0, reworkCount: 0, votes: [] },
    version: 1, createdAt: 't', updatedAt: 't',
  };
  return { roles, rules, type, instance };
}

describe('阶段四 generality 证明 · 非 dev type 走同一引擎、按 policy 参数化', () => {
  const fix = genFixture();
  const decide = (inst: TaskTeamInstance, e: TeamEvent) =>
    decideTeamActions({ instance: inst, type: fix.type, roles: fix.roles, rules: fix.rules, event: e });

  it('team-started → kickoff 给 activation=team-started 的非 observer 执行席（不含 reviewer/observer）', () => {
    const d = decide(fix.instance, ev('team-started'));
    expect(d.actions.map(a => a.targetRoleInstanceId)).toEqual(['tt_ri_g_exec']); // 只 kickoff exec
    expect(d.nextStatus).toBe('running');
  });

  it('review-pass quorum=2：第一票只记票不推进；第二票（同 cohort 不同实例）才推进', () => {
    let inst: TaskTeamInstance = { ...fix.instance, status: 'reviewing', reviewState: { round: 1, reworkCount: 0, votes: [] } };
    const d1 = decide(inst, ev('review-pass', { fromRoleInstanceId: 'tt_ri_g_rev1', fromSlotId: 'tt_slot_g_rev1' }));
    expect(d1.actions).toEqual([]); // 1 < quorum 2 → 只记票
    expect(d1.nextStatus).toBeUndefined();
    expect(d1.reviewState!.votes).toHaveLength(1);
    inst = apply(inst, d1);
    const d2 = decide(inst, ev('review-pass', { fromRoleInstanceId: 'tt_ri_g_rev2', fromSlotId: 'tt_slot_g_rev2' }));
    expect(d2.actions.map(a => a.actionType)).toEqual(['report']); // 2 == quorum → 推进
    expect(d2.nextStatus).toBe('awaiting-acceptance');
  });

  it('review-reject maxRework=1：第 1 次 reject→nudge+running(rework1)；第 2 次(>1)→escalate+blocked', () => {
    const r1 = decide({ ...fix.instance, status: 'reviewing', reviewState: { round: 1, reworkCount: 0, votes: [] } },
      ev('review-reject', { fromRoleInstanceId: 'tt_ri_g_rev1', fromSlotId: 'tt_slot_g_rev1' }));
    expect(r1.nextStatus).toBe('running');
    expect(r1.reviewState!.reworkCount).toBe(1);
    expect(r1.actions.map(a => a.actionType)).toContain('nudge');

    const r2 = decide({ ...fix.instance, status: 'reviewing', reviewState: { round: 1, reworkCount: 1, votes: [] } },
      ev('review-reject', { fromRoleInstanceId: 'tt_ri_g_rev1', fromSlotId: 'tt_slot_g_rev1' }));
    expect(r2.nextStatus).toBe('blocked');
    expect(r2.reviewState!.reworkCount).toBe(2);
    // 命中 do:'escalate' 规则 → escalate（参数化的 maxRework 阈值生效）
    expect(r2.actions.map(a => a.actionType)).toContain('escalate');
  });
});
