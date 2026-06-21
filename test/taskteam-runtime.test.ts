import { describe, expect, it } from 'vitest';
import { applyTeamEvent, createTaskTeam, teamEvent } from '../src/services/taskteam-runtime.js';
import type { CreateTaskTeamDeps, TaskTeamRuntimeDeps } from '../src/services/taskteam-runtime.js';
import { runTaskTeamObserverTick } from '../src/services/taskteam-observer.js';
import type { TaskTeamObserverDeps, TaskTeamObserverExecutors } from '../src/services/taskteam-observer.js';
import type {
  TaskTeamAction,
  TaskTeamCollabRule,
  TaskTeamInstance,
  TaskTeamRole,
  TaskTeamRoleInstance,
  TaskTeamType,
} from '../src/services/taskteam-schema.js';

function role(roleId: string, name: string, opts: Partial<TaskTeamRole> = {}): TaskTeamRole {
  return {
    roleId: roleId as TaskTeamRole['roleId'],
    name,
    responsibility: name,
    activation: { trigger: opts.activation?.trigger ?? 'team-started' },
    visibility: opts.visibility ?? 'full',
    actions: ['submit', 'review-pass', 'review-reject', 'report', 'finish'],
    io: { from: [], to: [] },
    isObserver: opts.isObserver,
  };
}
function ri(id: string, slotId: string, roleId: string): TaskTeamRoleInstance {
  return {
    roleInstanceId: id as TaskTeamRoleInstance['roleInstanceId'],
    slotId: slotId as TaskTeamRoleInstance['slotId'],
    roleId: roleId as TaskTeamRoleInstance['roleId'],
    binding: { bindingId: `tt_binding_${id}` as never, botOpenId: `ou_${id}`, larkAppId: `cli_${id}` },
  };
}

function fixture() {
  const roles = [
    role('tt_role_dev', '开发者'),
    role('tt_role_arch', '架构师', { visibility: 'review-only' }),
    role('tt_role_obs', '盯梢', { isObserver: true }),
  ];
  const rules: TaskTeamCollabRule[] = [
    { ruleId: 'tt_rule_0', when: { event: 'submit', status: 'running' }, whoSlot: 'tt_slot_arch', do: 'request-review' },
    { ruleId: 'tt_rule_2', when: { event: 'review-pass', status: 'reviewing', fromSlotId: 'tt_slot_arch' }, whoSlot: 'tt_slot_dev', do: 'report' },
  ];
  const type: TaskTeamType = {
    typeId: 'tt_type_x',
    name: 'x',
    roleSlots: [
      { slotId: 'tt_slot_dev', roleId: 'tt_role_dev' },
      { slotId: 'tt_slot_arch', roleId: 'tt_role_arch' },
      { slotId: 'tt_slot_obs', roleId: 'tt_role_obs' },
    ],
    rules: rules.map(r => r.ruleId),
    policy: { reviewRounds: 1, reviewQuorum: 1, maxRework: 2, escalateAfterStallMs: 1000, reviewOrder: ['tt_slot_arch'] },
  };
  const instance: TaskTeamInstance = {
    teamId: 'tt_team_x',
    typeId: type.typeId,
    companyId: 'tt_company_x',
    chatId: 'oc_x',
    goal: 'g',
    acceptance: 'a',
    roleInstances: [ri('tt_ri_dev', 'tt_slot_dev', 'tt_role_dev'), ri('tt_ri_arch', 'tt_slot_arch', 'tt_role_arch'), ri('tt_ri_obs', 'tt_slot_obs', 'tt_role_obs')],
    status: 'running',
    progress: '',
    reviewState: { round: 0, reworkCount: 0, votes: [] },
    version: 1,
    createdAt: 't',
    updatedAt: 't',
  };
  return { roles, rules, type, instance };
}

// 内存假 deps：模拟 store(单实例) + outbox(幂等去重)
function memDeps(fix: ReturnType<typeof fixture>) {
  let team = fix.instance;
  const enqueued: TaskTeamAction[] = [];
  const deps: TaskTeamRuntimeDeps = {
    loadConfig: () => ({ roles: fix.roles, rules: fix.rules, teamTypes: [fix.type] }),
    getTeam: () => team,
    applyState: async (_teamId, patch) => {
      team = { ...team, status: patch.status ?? team.status, reviewState: patch.reviewState ?? team.reviewState, version: team.version + 1 };
      return team;
    },
    enqueue: async opts => {
      const existing = enqueued.find(a => a.idempotencyKey === opts.idempotencyKey);
      if (existing) return existing;
      const action = {
        actionId: `tt_action_${enqueued.length}` as TaskTeamAction['actionId'],
        teamId: opts.teamId,
        actionType: opts.actionType,
        sourceRoleInstanceId: opts.sourceRoleInstanceId,
        targetRoleInstanceId: opts.targetRoleInstanceId,
        targetSlotId: opts.targetSlotId,
        payload: opts.payload ?? {},
        idempotencyKey: opts.idempotencyKey,
        status: 'pending',
        retryCount: 0,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        dispatchAttemptId: null,
        deliveredMessageId: null,
        lastError: null,
        createdAt: 't',
        updatedAt: 't',
      } as TaskTeamAction;
      enqueued.push(action);
      return action;
    },
  };
  return { deps, enqueued, getTeam: () => team };
}

describe('applyTeamEvent (driver)', () => {
  it('drives engine → applies state → enqueues outbox commands', async () => {
    const fix = fixture();
    const { deps, enqueued, getTeam } = memDeps(fix);

    const r = await applyTeamEvent(deps, 'tt_team_x', teamEvent('submit', { fromRoleInstanceId: 'tt_ri_dev', fromSlotId: 'tt_slot_dev' }));
    expect(r.instance.status).toBe('reviewing');
    expect(getTeam().status).toBe('reviewing'); // 状态已落"库"
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ actionType: 'request-review', targetRoleInstanceId: 'tt_ri_arch' });
  });

  it('is idempotent on replay (same event → outbox dedup by idempotencyKey)', async () => {
    const fix = fixture();
    const { deps, enqueued } = memDeps(fix);
    const ev = teamEvent('submit', { fromRoleInstanceId: 'tt_ri_dev', fromSlotId: 'tt_slot_dev' });
    await applyTeamEvent(deps, 'tt_team_x', ev);
    await applyTeamEvent(deps, 'tt_team_x', ev); // replay
    expect(enqueued).toHaveLength(1); // 去重，不重投
  });

  it('throws when team or type missing', async () => {
    const fix = fixture();
    const { deps } = memDeps(fix);
    await expect(applyTeamEvent({ ...deps, getTeam: () => null }, 'tt_team_x', teamEvent('submit'))).rejects.toThrow(/not found/);
  });
});

describe('createTaskTeam', () => {
  it('creates group → persists instance → drives team-started (kickoff + running)', async () => {
    const fix = fixture();
    let team: TaskTeamInstance | null = null;
    const enqueued: TaskTeamAction[] = [];
    const base = memDeps(fix);
    const deps: CreateTaskTeamDeps = {
      ...base.deps,
      getTeam: () => team,
      applyState: async (_t, patch) => {
        team = { ...(team as TaskTeamInstance), status: patch.status ?? team!.status, reviewState: patch.reviewState ?? team!.reviewState };
        return team;
      },
      enqueue: async opts => {
        const a = { actionId: `a${enqueued.length}`, ...opts, payload: opts.payload ?? {} } as unknown as TaskTeamAction;
        enqueued.push(a);
        return a;
      },
      createGroup: async opts => {
        expect(opts.larkAppIds).toContain('cli_creator'); // creator + 角色 bot 去重
        return { chatId: 'oc_new' };
      },
      persistTeam: async opts => {
        team = { ...fix.instance, status: 'forming', chatId: opts.chatId, roleInstances: opts.roleInstances };
        return team;
      },
    };
    const created = await createTaskTeam(deps, {
      typeId: 'tt_type_x',
      companyId: 'tt_company_x',
      goal: 'g',
      acceptance: 'a',
      roleInstances: fix.instance.roleInstances,
      creatorLarkAppId: 'cli_creator',
    });
    expect(created.status).toBe('running'); // team-started 驱动后
    expect(enqueued.some(a => a.actionType === 'kickoff' && a.targetRoleInstanceId === 'tt_ri_dev')).toBe(true);
  });
});

describe('runTaskTeamObserverTick', () => {
  function observerDeps(fix: ReturnType<typeof fixture>, teams: TaskTeamInstance[]) {
    const base = memDeps(fix);
    let cursorById: Record<string, string> = {};
    const applied: string[] = [];
    const deps: TaskTeamObserverDeps = {
      ...base.deps,
      getTeam: id => teams.find(t => t.teamId === id) ?? null,
      applyState: async () => teams[0],
      enqueue: base.deps.enqueue,
      listActiveTeams: () => teams,
      advanceCursor: async (teamId, cursor) => {
        cursorById[teamId] = cursor;
      },
    };
    return { deps, cursorById: () => cursorById, applied };
  }

  it('cheap gate: no new activity → zero detect call, no cursor advance', async () => {
    const fix = fixture();
    const team = { ...fix.instance, cursor: 'om_last' };
    const { deps, cursorById } = observerDeps(fix, [team]);
    let detectCalls = 0;
    const exec: TaskTeamObserverExecutors = {
      peek: async () => ({ hasNew: false, cursor: 'om_last' }),
      detect: async () => { detectCalls += 1; return []; },
    };
    const stats = await runTaskTeamObserverTick(new Date(), deps, exec);
    expect(stats.gatedOut).toBe(1);
    expect(detectCalls).toBe(0);
    expect(cursorById()['tt_team_x']).toBeUndefined();
  });

  it('new activity → detect events applied + cursor advanced', async () => {
    const fix = fixture();
    const team = { ...fix.instance, cursor: 'om_old' };
    const { deps, cursorById } = observerDeps(fix, [team]);
    const exec: TaskTeamObserverExecutors = {
      peek: async () => ({ hasNew: true, cursor: 'om_new' }),
      detect: async () => [teamEvent('stall')],
    };
    const stats = await runTaskTeamObserverTick(new Date(), deps, exec);
    expect(stats.detected).toBe(1);
    expect(stats.events).toBe(1);
    expect(cursorById()['tt_team_x']).toBe('om_new');
  });
});
