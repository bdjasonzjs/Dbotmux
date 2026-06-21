import { describe, expect, it } from 'vitest';
import { buildOrgTree } from '../src/dashboard/task-team-api.js';
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
