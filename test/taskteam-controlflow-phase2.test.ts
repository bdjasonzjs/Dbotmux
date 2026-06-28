// 阶段二回归（判读/动作去耦 + 计时触发器 + seed 具名 type）：
//  块1 judge 受限数据槽配置化（eventDescriptions / decisionHints / outputEventRegistry，安全骨架不可配置）
//  块2 领域无关动作 notify / wake-role / route-to-owner（补字段 + dispatch 渲染/路由 + 不隐式跃迁）
//  块3 计时/停滞触发器（复活 escalateAfterStallMs，clock 产 stall、window id 不撞幂等）
//  块4 现有开发团队 seed 抽成具名 type 常量（canonical 不动 + 深拷贝独立）
import { describe, expect, it } from 'vitest';
import {
  makeTaskTeamObserveExecutors,
  type TaskTeamJudgeFn,
  type TaskTeamJudgeContext,
  type TaskTeamFetchSinceFn,
} from '../src/services/taskteam-observe-executors.js';
import {
  runTaskTeamObserverTick,
  maybeStallEvent,
  type TaskTeamObserverDeps,
  type TaskTeamObserverExecutors,
} from '../src/services/taskteam-observer.js';
import { decideTeamActions } from '../src/services/taskteam-engine.js';
import {
  renderTaskTeamCommand,
  targetChatIdFor,
  deliverySpecOf,
} from '../src/services/taskteam-dispatch-executors.js';
import { validateTaskTeamConfig } from '../src/services/taskteam-validator.js';
import {
  defaultTaskTeamSeed,
  TWO_LAYER_REVIEW_TEAM_TYPE,
  TT_TYPE_TWO_LAYER_REVIEW,
} from '../src/services/taskteam-config-store.js';
import type {
  TaskTeamAction,
  TaskTeamCollabRule,
  TaskTeamConfigFile,
  TaskTeamInstance,
  TaskTeamRole,
  TaskTeamRoleInstance,
  TaskTeamType,
} from '../src/services/taskteam-schema.js';

// ── 共用 fixture ──────────────────────────────────────────────────────────
function role(roleId: string, over: Partial<TaskTeamRole> = {}): TaskTeamRole {
  return {
    roleId: roleId as TaskTeamRole['roleId'],
    name: roleId,
    responsibility: roleId,
    activation: { trigger: over.activation?.trigger ?? 'team-started' },
    visibility: over.visibility ?? 'full',
    actions: over.actions ?? ['submit', 'report'],
    io: { from: [], to: [] },
    isObserver: over.isObserver,
  };
}
function ri(roleInstanceId: string, slotId: string, roleId: string, botOpenId?: string): TaskTeamRoleInstance {
  return {
    roleInstanceId: roleInstanceId as TaskTeamRoleInstance['roleInstanceId'],
    slotId: slotId as TaskTeamRoleInstance['slotId'],
    roleId: roleId as TaskTeamRoleInstance['roleId'],
    binding: botOpenId
      ? { bindingId: `tt_binding_${roleInstanceId}` as never, botOpenId, larkAppId: 'cli_t' }
      : undefined,
  };
}
function instance(over: Partial<TaskTeamInstance> = {}): TaskTeamInstance {
  return {
    teamId: 'tt_team_p2',
    typeId: 'tt_type_p2',
    companyId: 'tt_company_p2',
    chatId: 'oc_self',
    goal: 'g',
    acceptance: 'a',
    roleInstances: [ri('tt_ri_dev', 'tt_slot_dev', 'tt_role_dev', 'ou_dev')],
    status: 'running',
    progress: '',
    reviewState: { round: 0, reworkCount: 0, votes: [] },
    cursor: null as unknown as string,
    version: 1,
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 块1：judge 受限数据槽配置化
// ─────────────────────────────────────────────────────────────────────────
describe('块1 · judge 受限数据槽配置化（不破防注入）', () => {
  const fetchOne: TaskTeamFetchSinceFn = async () => ({ messages: [{ id: 'om_1', text: '发现新 bug', senderId: 'ou_dev' }] });

  function typeWithJudge(judge: TaskTeamType['judge'], events: TaskTeamType['events'] = [{ type: 'new-bug', producer: 'behavior' }]): TaskTeamType {
    return {
      typeId: 'tt_type_p2',
      name: 'MoA 监控',
      roleSlots: [{ slotId: 'tt_slot_dev', roleId: 'tt_role_dev' }],
      rules: [],
      policy: { reviewRounds: 0, reviewQuorum: 1, maxRework: 0, escalateAfterStallMs: 0, reviewOrder: [] },
      events,
      judge,
    };
  }

  it('per-type 受限槽渲染进 judge ctx：eventDescriptions / decisionHints / outputEventRegistry 收窄', async () => {
    let captured: TaskTeamJudgeContext | undefined;
    const judge: TaskTeamJudgeFn = async (ctx) => { captured = ctx; return []; };
    const type = typeWithJudge({
      eventDescriptions: { 'new-bug': '监控群里冒出新缺陷' },
      decisionHints: ['只关注 P0/P1', '已知 bug 不重复报'],
      outputEventRegistry: ['new-bug'],
    });
    const exec = makeTaskTeamObserveExecutors('cli_o', { judge, fetchSince: fetchOne, resolveType: () => type });
    await exec.detect(instance(), null);
    expect(captured!.detectableEvents).toEqual(['new-bug']); // 收窄到 registry ∩ 可判读集
    expect(captured!.eventDescriptions?.['new-bug']).toBe('监控群里冒出新缺陷');
    expect(captured!.decisionHints).toEqual(['只关注 P0/P1', '已知 bug 不重复报']);
  });

  it('防注入·fail-closed：outputEventRegistry 与可判读集无交集 → 空允许集（绝不回退完整集）', async () => {
    let captured: TaskTeamJudgeContext | undefined;
    const judge: TaskTeamJudgeFn = async (ctx) => { captured = ctx; return [{ type: 'submit', by: 'R1', source: 'M1' }]; };
    // registry 全是不在可判读集里的越权/typo 事件 → 交集空 → fail-closed 成空允许集（不静默放宽成全集）
    const type = typeWithJudge({ outputEventRegistry: ['__attacker_event__'] });
    const exec = makeTaskTeamObserveExecutors('cli_o', { judge, fetchSince: fetchOne, resolveType: () => type });
    const res = await exec.detect(instance(), null);
    expect(captured!.detectableEvents).toEqual([]); // 空允许集，**不**回退 full set
    expect(res.events).toEqual([]); // 连 submit 也因空白名单被丢（fail-closed）
  });

  it('防注入：registry 收窄后，白名单外的 judge 输出被丢弃', async () => {
    // registry 只放 new-bug；judge 偏要回 submit → mapBehaviorToEvent 按收窄白名单丢弃
    const judge: TaskTeamJudgeFn = async () => [{ type: 'submit', by: 'R1', source: 'M1' }];
    const type = typeWithJudge({ outputEventRegistry: ['new-bug'] });
    const exec = makeTaskTeamObserveExecutors('cli_o', { judge, fetchSince: fetchOne, resolveType: () => type });
    const res = await exec.detect(instance(), null);
    expect(res.events).toEqual([]); // submit 不在收窄白名单 → 丢弃
  });

  it('无 judge 槽时回退内置描述 + 完整可判读集（向后兼容）', async () => {
    let captured: TaskTeamJudgeContext | undefined;
    const judge: TaskTeamJudgeFn = async (ctx) => { captured = ctx; return []; };
    const type = typeWithJudge(undefined, []);
    const exec = makeTaskTeamObserveExecutors('cli_o', { judge, fetchSince: fetchOne, resolveType: () => type });
    await exec.detect(instance(), null);
    expect(captured!.eventDescriptions).toBeUndefined();
    expect(captured!.decisionHints).toBeUndefined();
    expect(captured!.detectableEvents).toContain('submit');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 块2：领域无关动作 notify / wake-role / route-to-owner
// ─────────────────────────────────────────────────────────────────────────
describe('块2 · 领域无关动作（不隐式跃迁 + dispatch 字段）', () => {
  function customEventType(rules: TaskTeamCollabRule[]): { type: TaskTeamType; roles: TaskTeamRole[]; inst: TaskTeamInstance } {
    const type: TaskTeamType = {
      typeId: 'tt_type_p2',
      name: 'MoA',
      roleSlots: [
        { slotId: 'tt_slot_dev', roleId: 'tt_role_dev' },
        { slotId: 'tt_slot_analyst', roleId: 'tt_role_analyst' },
      ],
      rules: rules.map(r => r.ruleId),
      policy: { reviewRounds: 0, reviewQuorum: 1, maxRework: 0, escalateAfterStallMs: 0, reviewOrder: [] },
      events: [{ type: 'new-bug', producer: 'behavior' }],
    };
    const roles = [role('tt_role_dev'), role('tt_role_analyst')];
    const inst = instance({
      roleInstances: [
        ri('tt_ri_dev', 'tt_slot_dev', 'tt_role_dev', 'ou_dev'),
        ri('tt_ri_analyst', 'tt_slot_analyst', 'tt_role_analyst', 'ou_analyst'),
      ],
    });
    return { type, roles, inst };
  }

  it('notify 自定义事件 → 投递命令产出，但不隐式跃迁状态（解耦）', () => {
    const rules: TaskTeamCollabRule[] = [
      { ruleId: 'tt_rule_notify', when: { event: 'new-bug', status: 'running' }, whoSlot: 'tt_slot_analyst', do: 'notify' },
    ];
    const { type, roles, inst } = customEventType(rules);
    const d = decideTeamActions({ instance: inst, type, roles, rules, event: { type: 'new-bug', sourceEventId: 'om_1' } });
    expect(d.actions).toHaveLength(1);
    expect(d.actions[0].actionType).toBe('notify');
    expect(d.actions[0].targetRoleInstanceId).toBe('tt_ri_analyst');
    expect(d.nextStatus).toBeUndefined();   // 不进 reviewing（与 request-review 隐式跃迁解耦）
    expect(d.reviewState).toBeUndefined();
  });

  it('连发多个同类 new-bug（不同 sourceEventId）→ 幂等 key 各异，不丢事件', () => {
    const rules: TaskTeamCollabRule[] = [
      { ruleId: 'tt_rule_notify', when: { event: 'new-bug', status: 'running' }, whoSlot: 'tt_slot_analyst', do: 'notify' },
    ];
    const { type, roles, inst } = customEventType(rules);
    const k1 = decideTeamActions({ instance: inst, type, roles, rules, event: { type: 'new-bug', sourceEventId: 'om_1' } }).actions[0].idempotencyKey;
    const k2 = decideTeamActions({ instance: inst, type, roles, rules, event: { type: 'new-bug', sourceEventId: 'om_2' } }).actions[0].idempotencyKey;
    expect(k1).not.toBe(k2);
  });

  it('rule.action 字段随命令进 payload.__delivery（targetType/ack + 预留字段透传）', () => {
    const rules: TaskTeamCollabRule[] = [
      {
        ruleId: 'tt_rule_route', when: { event: 'new-bug', status: 'running' }, whoSlot: 'tt_slot_analyst', do: 'route-to-owner',
        action: { targetType: 'owner', targetOpenId: 'ou_owner', ack: true, visibility: 'progress-only', wakeRoot: true, escalation: 'notify-owner' },
      },
    ];
    const { type, roles, inst } = customEventType(rules);
    const d = decideTeamActions({ instance: inst, type, roles, rules, event: { type: 'new-bug', sourceEventId: 'om_1' } });
    const delivery = (d.actions[0].payload as Record<string, unknown>).__delivery as Record<string, unknown>;
    // targetType/targetOpenId/ack 已做实；wakeRoot/escalation 仅作字段透传（行为待阶段3/4，不产生副作用）
    expect(delivery).toMatchObject({ targetType: 'owner', targetOpenId: 'ou_owner', ack: true, wakeRoot: true, escalation: 'notify-owner' });
  });

  it('防注入 High：event.payload 自带 __delivery 但规则无 action → 引擎剥除、不进投递路由', () => {
    const rules: TaskTeamCollabRule[] = [
      { ruleId: 'tt_rule_notify', when: { event: 'new-bug', status: 'running' }, whoSlot: 'tt_slot_analyst', do: 'notify' },
    ];
    const { type, roles, inst } = customEventType(rules);
    // 外部消息派生事件挟带伪造 __delivery（targetChatId 想把通知劫持到恶意群）
    const d = decideTeamActions({
      instance: inst, type, roles, rules,
      event: { type: 'new-bug', sourceEventId: 'om_1', payload: { foo: 1, __delivery: { targetType: 'chat', targetChatId: 'oc_evil' } } },
    });
    const payload = d.actions[0].payload as Record<string, unknown> | undefined;
    expect(payload?.__delivery).toBeUndefined();      // __delivery 被剥除
    expect(payload?.foo).toBe(1);                      // 其余 payload 原样保留
    const action = { actionType: 'notify', targetRoleInstanceId: 'tt_ri_analyst', payload } as unknown as TaskTeamAction;
    expect(targetChatIdFor(action, inst)).toBe('oc_self'); // 路由未被篡改 → 回落小组自身 chatId
  });

  it('防注入 High：规则 action 优先，event.payload 伪造的 __delivery 被配置覆盖', () => {
    const rules: TaskTeamCollabRule[] = [
      {
        ruleId: 'tt_rule_notify', when: { event: 'new-bug', status: 'running' }, whoSlot: 'tt_slot_analyst', do: 'notify',
        action: { targetType: 'chat', targetChatId: 'oc_legit' },
      },
    ];
    const { type, roles, inst } = customEventType(rules);
    const d = decideTeamActions({
      instance: inst, type, roles, rules,
      event: { type: 'new-bug', sourceEventId: 'om_1', payload: { __delivery: { targetType: 'chat', targetChatId: 'oc_evil' } } },
    });
    const action = { actionType: 'notify', targetRoleInstanceId: 'tt_ri_analyst', payload: d.actions[0].payload } as unknown as TaskTeamAction;
    expect(targetChatIdFor(action, inst)).toBe('oc_legit'); // 配置侧 rule.action 胜出，伪造值不生效
  });

  it('dispatch 渲染：notify + ack + targetType=user → @ 指定 open_id + 回执提示', () => {
    const action = {
      actionType: 'notify',
      targetRoleInstanceId: 'tt_ri_analyst',
      payload: { summary: '新增 P0 缺陷', __delivery: { targetType: 'user', targetOpenId: 'ou_someone', ack: true } },
    } as unknown as TaskTeamAction;
    const msg = renderTaskTeamCommand(action, instance({ roleInstances: [ri('tt_ri_analyst', 'tt_slot_analyst', 'tt_role_analyst', 'ou_analyst')] }));
    expect(msg).toContain('<at user_id="ou_someone"></at>');
    expect(msg).toContain('通知');
    expect(msg).toContain('新增 P0 缺陷');
    expect(msg).toContain('请回执 ack');
  });

  it('dispatch 路由：targetType=chat → 投递到 targetChatId（覆盖小组自身 chatId）', () => {
    const action = {
      actionType: 'notify', targetRoleInstanceId: 'tt_ri_analyst',
      payload: { __delivery: { targetType: 'chat', targetChatId: 'oc_external' } },
    } as unknown as TaskTeamAction;
    expect(targetChatIdFor(action, instance())).toBe('oc_external');
    // 无 delivery → 回落小组自身 chatId
    const plain = { actionType: 'report', targetRoleInstanceId: 'tt_ri_dev', payload: {} } as unknown as TaskTeamAction;
    expect(targetChatIdFor(plain, instance())).toBe('oc_self');
    expect(deliverySpecOf(plain)).toBeUndefined();
  });

  it('validator 接受 notify / wake-role / route-to-owner 为合法投递命令', () => {
    const rules: TaskTeamCollabRule[] = [
      { ruleId: 'tt_rule_notify', when: { event: 'new-bug', status: 'running' }, whoSlot: 'tt_slot_analyst', do: 'notify' },
      { ruleId: 'tt_rule_wake', when: { event: 'new-bug', status: 'running' }, whoSlot: 'tt_slot_analyst', do: 'wake-role' },
      { ruleId: 'tt_rule_route', when: { event: 'new-bug', status: 'running' }, whoSlot: 'tt_slot_analyst', do: 'route-to-owner' },
    ];
    const { type, roles } = customEventType(rules);
    const cfg: TaskTeamConfigFile = {
      version: 1, roles, rules, teamTypes: [type], orgStructures: [], orgRuntimeBindings: [], updatedAt: 't',
    };
    const v = validateTaskTeamConfig(cfg);
    expect(v.errors.filter(e => e.code === 'rule-bad-command')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 块3：计时/停滞触发器（复活 escalateAfterStallMs）
// ─────────────────────────────────────────────────────────────────────────
describe('块3 · 停滞触发器（clock 产 stall，window id 不撞幂等）', () => {
  function stallType(ms: number): TaskTeamType {
    return {
      typeId: 'tt_type_p2', name: 'MoA',
      roleSlots: [{ slotId: 'tt_slot_obs', roleId: 'tt_role_obs' }],
      rules: ['tt_rule_stall'],
      policy: { reviewRounds: 0, reviewQuorum: 1, maxRework: 0, escalateAfterStallMs: ms, reviewOrder: [] },
    };
  }
  const stalledTeam = () => instance({
    roleInstances: [ri('tt_ri_obs', 'tt_slot_obs', 'tt_role_obs', 'ou_obs')],
    updatedAt: '2026-06-20T00:00:00.000Z',
  });

  it('maybeStallEvent：到点产 stall（window id = stall:teamId:停滞锚 ts，绝不退回 round；缺锚回退 updatedAt）', () => {
    const team = stalledTeam(); // 未设 lastObservedActivityAt → 锚回退 updatedAt
    const base = Date.parse(team.updatedAt);
    expect(maybeStallEvent(new Date(base + 999), team, stallType(1000))).toBeNull(); // 未到点
    const ev = maybeStallEvent(new Date(base + 2000), team, stallType(1000));
    expect(ev).toMatchObject({ type: 'stall', sourceEventId: `stall:tt_team_p2:${base}` });
  });

  it('maybeStallEvent：未配 escalateAfterStallMs（0/缺）→ 不产（向后兼容）', () => {
    const team = stalledTeam();
    expect(maybeStallEvent(new Date(Date.now()), team, stallType(0))).toBeNull();
    expect(maybeStallEvent(new Date(Date.now()), team, undefined)).toBeNull();
  });

  it('window id 在同一停滞窗内稳定 → 幂等 key 稳定（停滞窗内只升级一次）', () => {
    const team = stalledTeam();
    const base = Date.parse(team.updatedAt);
    const e1 = maybeStallEvent(new Date(base + 2000), team, stallType(1000))!;
    const e2 = maybeStallEvent(new Date(base + 9000), team, stallType(1000))!;
    expect(e1.sourceEventId).toBe(e2.sourceEventId); // 锚未动 → 同窗同源 → 引擎 emit 同 key → outbox 去重
  });

  it('reviewer Medium：锚用 lastObservedActivityAt，updatedAt 被状态写入刷新也不移动停滞窗', () => {
    const base = Date.parse('2026-06-20T00:00:00.000Z');
    // 模拟 stall rule 自带 transition 刷新了 updatedAt（晚 5h），但 lastObservedActivityAt 仍锚在 base
    const team = instance({
      roleInstances: [ri('tt_ri_obs', 'tt_slot_obs', 'tt_role_obs', 'ou_obs')],
      lastObservedActivityAt: '2026-06-20T00:00:00.000Z',
      updatedAt: '2026-06-20T05:00:00.000Z',
    });
    const ev = maybeStallEvent(new Date(base + 2000), team, stallType(1000));
    // 若错用 updatedAt(base+5h) 则 now-updatedAt<0 不会产；用锚(base) → 已过 2000>1000ms → 产，且 sourceEventId 锚在 base
    expect(ev).toMatchObject({ type: 'stall', sourceEventId: `stall:tt_team_p2:${base}` });
  });

  it('observer tick：无新动静 + 到停滞点 → clock 产 stall 并 applyTeamEvent，stats.stalls=1', async () => {
    const team = stalledTeam();
    const type = stallType(1000);
    const rules: TaskTeamCollabRule[] = [
      { ruleId: 'tt_rule_stall', when: { event: 'stall', status: 'running' }, whoSlot: 'tt_slot_obs', do: 'escalate' },
    ];
    const roles = [role('tt_role_obs', { isObserver: true, actions: ['escalate', 'report'] })];
    const enqueued = new Map<string, TaskTeamAction>();
    const deps: TaskTeamObserverDeps = {
      withTeamLock: (_id, fn) => fn(),
      loadConfig: () => ({ roles, rules, teamTypes: [type] }),
      getTeam: () => team,
      applyState: async () => team,
      enqueue: async (opts) => {
        const a = { ...opts, actionId: 'x' } as unknown as TaskTeamAction;
        if (!enqueued.has(opts.idempotencyKey)) enqueued.set(opts.idempotencyKey, a); // 模拟 outbox 幂等去重
        return a;
      },
      listActiveTeams: () => [team],
      advanceCursor: async () => {},
      resolveType: () => type,
    };
    const exec: TaskTeamObserverExecutors = {
      peek: async () => ({ hasNew: false, cursor: 'om_cursor' }),
      detect: async () => ({ events: [], cursor: null }),
    };
    const base = Date.parse(team.updatedAt);
    const s1 = await runTaskTeamObserverTick(new Date(base + 2000), deps, exec);
    expect(s1.stalls).toBe(1);
    expect(s1.gatedOut).toBe(1);
    expect([...enqueued.values()][0].actionType).toBe('escalate');
    // 再 tick（同停滞窗）→ 幂等 key 不变 → outbox 不重复入队（停滞窗内只升级一次）
    await runTaskTeamObserverTick(new Date(base + 9000), deps, exec);
    expect(enqueued.size).toBe(1);
  });

  it('observer tick：未到停滞点 → 不产 stall（gatedOut only）', async () => {
    const team = stalledTeam();
    const type = stallType(1_000_000);
    const deps = {
      listActiveTeams: () => [team],
      advanceCursor: async () => {},
      resolveType: () => type,
    } as unknown as TaskTeamObserverDeps;
    const exec: TaskTeamObserverExecutors = {
      peek: async () => ({ hasNew: false, cursor: 'om_cursor' }),
      detect: async () => ({ events: [], cursor: null }),
    };
    const base = Date.parse(team.updatedAt);
    const s = await runTaskTeamObserverTick(new Date(base + 2000), deps, exec);
    expect(s.stalls).toBe(0);
    expect(s.gatedOut).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// validator：阶段2 新增校验（outputEventRegistry typo / timer transition 自环）
// ─────────────────────────────────────────────────────────────────────────
describe('validator · 阶段2 新增校验', () => {
  function cfgWith(typeOver: Partial<TaskTeamType>, rules: TaskTeamCollabRule[]): TaskTeamConfigFile {
    const type: TaskTeamType = {
      typeId: 'tt_type_p2', name: 'MoA',
      roleSlots: [{ slotId: 'tt_slot_obs', roleId: 'tt_role_obs' }],
      rules: rules.map(r => r.ruleId),
      policy: { reviewRounds: 0, reviewQuorum: 1, maxRework: 0, escalateAfterStallMs: 1000, reviewOrder: [] },
      ...typeOver,
    };
    return { version: 1, roles: [role('tt_role_obs', { isObserver: true, actions: ['escalate'] })], rules, teamTypes: [type], orgStructures: [], orgRuntimeBindings: [], updatedAt: 't' };
  }

  it('outputEventRegistry 全 typo（与可判读集交集空）→ warning（empty + unknown），非 error', () => {
    const rules: TaskTeamCollabRule[] = [
      { ruleId: 'tt_rule_stall', when: { event: 'stall', status: 'running' }, whoSlot: 'tt_slot_obs', do: 'escalate' },
    ];
    const v = validateTaskTeamConfig(cfgWith({ judge: { outputEventRegistry: ['__typo__'] } }, rules));
    expect(v.warnings.some(w => w.code === 'judge-output-registry-unknown')).toBe(true);
    expect(v.warnings.some(w => w.code === 'judge-output-registry-empty')).toBe(true);
    expect(v.errors.filter(e => e.code.startsWith('judge-output'))).toEqual([]);
  });

  it('timer 事件（stall）规则 transition 回到仍可命中状态 → error（防 clock 反复刷）', () => {
    const rules: TaskTeamCollabRule[] = [
      { ruleId: 'tt_rule_stall', when: { event: 'stall', status: 'running' }, whoSlot: 'tt_slot_obs', do: 'escalate', transition: { status: 'running' } },
    ];
    const v = validateTaskTeamConfig(cfgWith({}, rules));
    expect(v.errors.some(e => e.code === 'timer-transition-self-loop')).toBe(true);
  });

  it('timer 事件 stall 规则 transition 指到不再命中的终态（blocked）→ 无 self-loop error', () => {
    const rules: TaskTeamCollabRule[] = [
      { ruleId: 'tt_rule_stall', when: { event: 'stall', status: 'running' }, whoSlot: 'tt_slot_obs', do: 'escalate', transition: { status: 'blocked' } },
    ];
    const v = validateTaskTeamConfig(cfgWith({}, rules));
    expect(v.errors.filter(e => e.code === 'timer-transition-self-loop')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 块4：现有开发团队 seed 抽成具名 type 常量
// ─────────────────────────────────────────────────────────────────────────
describe('块4 · 具名 type 常量（canonical 不动 + 深拷贝独立）', () => {
  it('TT_TYPE_TWO_LAYER_REVIEW canonical id 不变', () => {
    expect(TT_TYPE_TWO_LAYER_REVIEW).toBe('tt_type_two_layer_review');
    expect(TWO_LAYER_REVIEW_TEAM_TYPE.typeId).toBe('tt_type_two_layer_review');
  });

  it('具名常量 deepEqual seed.teamTypes[0]（抽常量不改 canonical 形态）', () => {
    expect(defaultTaskTeamSeed().teamTypes[0]).toEqual(TWO_LAYER_REVIEW_TEAM_TYPE);
  });

  it('seed 返回深拷贝独立对象：改一份不污染另一份 / 不污染常量', () => {
    const a = defaultTaskTeamSeed();
    const b = defaultTaskTeamSeed();
    expect(a.teamTypes[0]).not.toBe(b.teamTypes[0]); // 不同引用
    a.teamTypes[0].policy.maxRework = 999;
    expect(b.teamTypes[0].policy.maxRework).toBe(3); // 互不影响
    expect(TWO_LAYER_REVIEW_TEAM_TYPE.policy.maxRework).toBe(3); // 常量未被污染
  });

  it('具名常量 roleSlots 顺序 / 引用 ruleId / policy 逐字不动', () => {
    expect(TWO_LAYER_REVIEW_TEAM_TYPE.roleSlots.map(s => s.slotId)).toEqual([
      'tt_slot_developer_main', 'tt_slot_architect_main', 'tt_slot_detail_reviewer_main', 'tt_slot_observer_main',
    ]);
    expect(TWO_LAYER_REVIEW_TEAM_TYPE.rules).toEqual([
      'tt_rule_submit_to_architect', 'tt_rule_architect_pass_to_detail', 'tt_rule_detail_pass_to_acceptance',
      'tt_rule_reject_to_rework', 'tt_rule_observer_stall_report',
    ]);
    expect(TWO_LAYER_REVIEW_TEAM_TYPE.policy).toEqual({
      reviewRounds: 2, reviewQuorum: 1, maxRework: 3, escalateAfterStallMs: 30 * 60 * 1000,
      reviewOrder: ['tt_slot_architect_main', 'tt_slot_detail_reviewer_main'],
    });
    // 具名常量不引入 events / judge（保持开发团队 canonical 形态）
    expect(TWO_LAYER_REVIEW_TEAM_TYPE).not.toHaveProperty('events');
    expect(TWO_LAYER_REVIEW_TEAM_TYPE).not.toHaveProperty('judge');
  });
});
