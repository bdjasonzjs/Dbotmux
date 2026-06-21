import { describe, expect, it } from 'vitest';
import { buildOrgTree } from '../src/dashboard/task-team-api.js';
import { fetchTaskTeamJson } from '../src/dashboard/web/task-team-data.js';
import { buildRolePayload, buildRulePayload, buildTypePayload, postAdmin } from '../src/dashboard/web/taskteam-builder-data.js';
import type { TaskTeamConfigFile, TaskTeamInstance } from '../src/services/taskteam-schema.js';

describe('buildOrgTree (§8.2 org tree)', () => {
  it('nests teams under departments by typeId membership', () => {
    const config = {
      version: 1,
      roles: [],
      rules: [],
      teamTypes: [],
      orgStructures: [
        {
          companyName: 'Co',
          departments: [
            { deptName: 'D1', teamTypeIds: ['tt_type_a'] },
            { deptName: 'D2', teamTypeIds: ['tt_type_b'] },
          ],
        },
      ],
      orgRuntimeBindings: [],
      updatedAt: 't',
    } as unknown as TaskTeamConfigFile;
    const teams = [
      { teamId: 'tt_team_1', typeId: 'tt_type_a', status: 'running', progress: 'p1', chatId: 'oc1' },
      { teamId: 'tt_team_2', typeId: 'tt_type_b', status: 'done', progress: '', chatId: 'oc2' },
      { teamId: 'tt_team_3', typeId: 'tt_type_a', status: 'reviewing', progress: '', chatId: 'oc3' },
    ] as unknown as TaskTeamInstance[];

    const tree = buildOrgTree(config, teams);
    expect(tree[0].companyName).toBe('Co');
    expect(tree[0].departments[0].teams.map(t => t.teamId)).toEqual(['tt_team_1', 'tt_team_3']);
    expect(tree[0].departments[1].teams.map(t => t.teamId)).toEqual(['tt_team_2']);
    expect(tree[0].departments[0].teams[0]).toMatchObject({ status: 'running', progress: 'p1', chatId: 'oc1' });
  });

  it('does not mask fetch failures as empty (P2): non-2xx / throw / bad-json → error result', async () => {
    // 真实数据
    const ok = await fetchTaskTeamJson<{ x: number }>('/p', async () => ({ ok: true, status: 200, json: async () => ({ x: 1 }) }));
    expect(ok).toEqual({ ok: true, data: { x: 1 } });
    // 非 2xx（如 API 500 / 鉴权 401）→ 错误态，不伪装空
    const e500 = await fetchTaskTeamJson('/p', async () => ({ ok: false, status: 500, json: async () => ({}) }));
    expect(e500).toEqual({ ok: false, error: 'HTTP 500' });
    // 网络 throw → 错误态
    const thrown = await fetchTaskTeamJson('/p', async () => { throw new Error('network down'); });
    expect(thrown.ok).toBe(false);
    expect((thrown as { error: string }).error).toContain('network down');
    // JSON 解析失败 → 错误态
    const badJson = await fetchTaskTeamJson('/p', async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }));
    expect(badJson.ok).toBe(false);
    expect((badJson as { error: string }).error).toContain('bad json');
  });

  it('returns empty departments when no teams match', () => {
    const config = {
      version: 1, roles: [], rules: [], teamTypes: [],
      orgStructures: [{ companyName: 'Solo', departments: [{ deptName: 'D', teamTypeIds: ['tt_type_x'] }] }],
      orgRuntimeBindings: [], updatedAt: 't',
    } as unknown as TaskTeamConfigFile;
    const tree = buildOrgTree(config, []);
    expect(tree[0].departments[0].teams).toEqual([]);
  });
});

describe('taskteam-builder-data (§7 form→schema, no JSON)', () => {
  it('buildRolePayload assembles role + envelope; splits actions/io; optional model/seat/observer', () => {
    const { role } = buildRolePayload({
      roleId: 'tt_role_x', name: 'X', responsibility: 'r', activationTrigger: 'submit', visibility: 'review-only',
      actions: 'submit, review-pass', fromRoleIds: 'tt_role_a', toRoleIds: 'tt_role_b', model: 'haiku', seatEngine: 'coco', isObserver: true,
    });
    expect(role).toMatchObject({
      roleId: 'tt_role_x', visibility: 'review-only', actions: ['submit', 'review-pass'],
      io: { from: [{ roleId: 'tt_role_a' }], to: [{ roleId: 'tt_role_b' }] }, model: { model: 'haiku' }, seatHint: { engine: 'coco' }, isObserver: true,
    });
  });

  it('buildRolePayload defaults trigger and omits empty optionals', () => {
    const { role } = buildRolePayload({ roleId: 'r', name: 'n', responsibility: '', activationTrigger: '', visibility: 'full', actions: '' });
    expect(role.activation.trigger).toBe('team-started');
    expect(role).not.toHaveProperty('model');
    expect(role).not.toHaveProperty('seatHint');
    expect(role).not.toHaveProperty('isObserver');
  });

  it('buildRulePayload keeps optional when fields only when set', () => {
    const { rule } = buildRulePayload({ ruleId: 'tt_rule_0', whenEvent: 'submit', whenStatus: 'running', whenFromSlotId: '', whoSlot: 'tt_slot_arch', do: 'request-review' });
    expect(rule).toMatchObject({ ruleId: 'tt_rule_0', when: { event: 'submit', status: 'running' }, whoSlot: 'tt_slot_arch', do: 'request-review' });
    expect(rule.when).not.toHaveProperty('fromSlotId');
  });

  it('buildTypePayload parses slotId:roleId[:label] and policy', () => {
    const { teamType } = buildTypePayload({
      typeId: 'tt_type_x', name: 'X', slots: 'tt_slot_dev:tt_role_dev, tt_slot_arch:tt_role_arch:主审',
      rules: 'tt_rule_0', reviewRounds: 2, reviewQuorum: 1, maxRework: 3, escalateAfterStallMs: 1000, reviewOrder: 'tt_slot_arch',
    });
    expect(teamType.roleSlots).toEqual([
      { slotId: 'tt_slot_dev', roleId: 'tt_role_dev' },
      { slotId: 'tt_slot_arch', roleId: 'tt_role_arch', label: '主审' },
    ]);
    expect(teamType.policy).toMatchObject({ reviewRounds: 2, reviewQuorum: 1, maxRework: 3, reviewOrder: ['tt_slot_arch'] });
  });

  it('postAdmin: ok / non-2xx with detail / throw — surfaces errors, not silent', async () => {
    const ok = await postAdmin('/p', { role: {} }, async () => ({ ok: true, status: 200, text: async () => '' }));
    expect(ok).toEqual({ ok: true });
    const e400 = await postAdmin('/p', {}, async () => ({ ok: false, status: 400, text: async () => 'missing role' }));
    expect(e400).toEqual({ ok: false, error: 'HTTP 400：missing role' });
    const thrown = await postAdmin('/p', {}, async () => { throw new Error('down'); });
    expect(thrown.ok).toBe(false);
  });
});
