import { describe, expect, it } from 'vitest';
import {
  exportInstanceSnapshot,
  exportTemplateBundle,
  importTemplateBundle,
  TaskTeamTemplateError,
  validateInstanceSnapshot,
} from '../src/services/taskteam-templates.js';
import {
  assertCreatorAppScope,
  TaskTeamScopeError,
  validateCreatorAppScope,
} from '../src/services/taskteam-scope.js';
import type { TaskTeamConfigFile, TaskTeamRole, TaskTeamType } from '../src/services/taskteam-schema.js';

function role(roleId: string): TaskTeamRole {
  return {
    roleId: roleId as TaskTeamRole['roleId'],
    name: roleId,
    responsibility: 'x',
    activation: { trigger: 'team-started' },
    visibility: 'full',
    actions: ['submit'],
    io: { from: [], to: [] },
  };
}
function teamType(typeId: string): TaskTeamType {
  return {
    typeId: typeId as TaskTeamType['typeId'],
    name: typeId,
    roleSlots: [{ slotId: 'tt_slot_dev', roleId: 'tt_role_dev' }],
    rules: [],
    policy: { reviewRounds: 1, reviewQuorum: 1, maxRework: 1, escalateAfterStallMs: 1000, reviewOrder: [] },
  };
}
function config(): TaskTeamConfigFile {
  return {
    version: 3,
    roles: [role('tt_role_dev')],
    rules: [{ ruleId: 'tt_rule_0', when: { event: 'submit' }, whoSlot: 'tt_slot_dev', do: 'request-review' }],
    teamTypes: [teamType('tt_type_x')],
    orgStructures: [{ companyName: '一人公司', departments: [{ deptName: '默认', teamTypeIds: ['tt_type_x'] }] }],
    orgRuntimeBindings: [{ companyId: 'tt_company_1', companyName: '一人公司', rootChatId: 'oc_root', ceoBotOpenId: 'ou_ceo', deptBindings: [] }],
    updatedAt: 't',
  };
}

describe('template bundle (H3 shareable vs runtime)', () => {
  it('exports only shareable design state, never runtime identity', () => {
    const bundle = exportTemplateBundle(config());
    expect(bundle.kind).toBe('taskteam-template-bundle');
    expect(bundle.roles.map(r => r.roleId)).toEqual(['tt_role_dev']);
    expect(bundle.orgStructures[0].companyName).toBe('一人公司');
    // 不含运行态绑定（orgRuntimeBindings / app-scoped 身份）
    expect((bundle as Record<string, unknown>).orgRuntimeBindings).toBeUndefined();
    expect(JSON.stringify(bundle)).not.toContain('ou_ceo');
    expect(JSON.stringify(bundle)).not.toContain('oc_root');
  });

  it('rejects exporting a config whose shareable shape smuggled app-scoped identity', () => {
    const c = config();
    // 模拟脏数据：org shape 混入 chatId（H3 禁止）
    (c.orgStructures[0] as Record<string, unknown>).chatId = 'oc_leak';
    expect(() => exportTemplateBundle(c)).toThrow(TaskTeamTemplateError);
  });

  it('imports a bundle by upsert without touching runtime bindings', () => {
    const base = config();
    const incoming = exportTemplateBundle({ ...config(), roles: [role('tt_role_dev'), role('tt_role_new')] });
    const merged = importTemplateBundle(incoming, base);
    expect(merged.roles.map(r => r.roleId).sort()).toEqual(['tt_role_dev', 'tt_role_new']);
    // 运行态绑定保持本地不变（导入后须由调用方重绑）
    expect(merged.orgRuntimeBindings).toEqual(base.orgRuntimeBindings);
  });

  it('rejects wrong kind / version / identity-carrying bundle on import', () => {
    const base = config();
    expect(() => importTemplateBundle({ kind: 'nope' } as never, base)).toThrow(TaskTeamTemplateError);
    const bad = { ...exportTemplateBundle(config()) } as Record<string, unknown>;
    (bad.roles as Record<string, unknown>[])[0].larkAppId = 'cli_leak';
    expect(() => importTemplateBundle(bad as never, base)).toThrow(/app-scoped runtime identity/);
  });

  it('snapshots instances with runtime bindings (same-env backup) and validates', () => {
    const snap = exportInstanceSnapshot(config(), []);
    expect(snap.kind).toBe('taskteam-instance-snapshot');
    expect(snap.config.orgRuntimeBindings.length).toBe(1); // 快照保留运行态
    expect(() => validateInstanceSnapshot(snap)).not.toThrow();
    expect(() => validateInstanceSnapshot({ kind: 'x' } as never)).toThrow(TaskTeamTemplateError);
  });
});

describe('open_id scope (H2)', () => {
  const resolver = (visibleSet: Set<string>) => ({
    isVisibleInApp: async (openId: string) => visibleSet.has(openId),
  });

  it('passes when all open_ids visible in creator app', async () => {
    const r = await validateCreatorAppScope('cli_creator', ['ou_a', 'ou_b', undefined, 'ou_a'], resolver(new Set(['ou_a', 'ou_b'])));
    expect(r.ok).toBe(true);
    expect(r.checked.sort()).toEqual(['ou_a', 'ou_b']); // 去重 + 跳过空
    expect(r.crossApp).toEqual([]);
  });

  it('flags cross-app open_ids and assert throws', async () => {
    const r = await validateCreatorAppScope('cli_creator', ['ou_a', 'ou_x'], resolver(new Set(['ou_a'])));
    expect(r.ok).toBe(false);
    expect(r.crossApp).toEqual(['ou_x']);
    await expect(assertCreatorAppScope('cli_creator', ['ou_a', 'ou_x'], resolver(new Set(['ou_a'])))).rejects.toThrow(TaskTeamScopeError);
  });
});
