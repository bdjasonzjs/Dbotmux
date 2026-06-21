import { describe, expect, it } from 'vitest';
import { buildOrgTree } from '../src/dashboard/task-team-api.js';
import { fetchTaskTeamJson } from '../src/dashboard/web/task-team-data.js';
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
