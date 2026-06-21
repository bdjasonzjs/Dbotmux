import { describe, expect, it } from 'vitest';
import { buildTaskTeamRequest } from '../src/cli/taskteam-cli.js';

// P1 回归：CLI 把裸对象按 verb 包进正确 IPC envelope，与 admin/daemon body 合约一致。
describe('buildTaskTeamRequest (CLI→IPC contract, P1)', () => {
  it('role-upsert wraps bare role under {role}', () => {
    expect(buildTaskTeamRequest('role-upsert', ['--json', '{"roleId":"tt_role_x","name":"X"}'])).toEqual({
      path: '/api/taskteam-role-upsert',
      body: { role: { roleId: 'tt_role_x', name: 'X' } },
    });
  });

  it('rule / type / org wrap under rule / teamType / org', () => {
    expect(buildTaskTeamRequest('rule-upsert', ['--json', '{"ruleId":"r"}'])).toMatchObject({ body: { rule: { ruleId: 'r' } } });
    expect(buildTaskTeamRequest('type-upsert', ['--json', '{"typeId":"t"}'])).toMatchObject({ body: { teamType: { typeId: 't' } } });
    expect(buildTaskTeamRequest('org-upsert', ['--json', '{"companyName":"c"}'])).toMatchObject({ body: { org: { companyName: 'c' } } });
  });

  it('template-import wraps under {bundle}; snapshot-restore under {snapshot}', () => {
    expect(buildTaskTeamRequest('template-import', ['--json', '{"kind":"taskteam-template-bundle"}'])).toMatchObject({
      path: '/api/taskteam-template-import',
      body: { bundle: { kind: 'taskteam-template-bundle' } },
    });
    expect(buildTaskTeamRequest('snapshot-restore', ['--json', '{"kind":"taskteam-instance-snapshot"}'])).toMatchObject({
      path: '/api/taskteam-snapshot-restore',
      body: { snapshot: { kind: 'taskteam-instance-snapshot' } },
    });
  });

  it('event wraps json under {event} and keeps --team-id at top level', () => {
    expect(buildTaskTeamRequest('event', ['--team-id', 'tt_team_x', '--json', '{"type":"submit"}'])).toEqual({
      path: '/api/taskteam-event',
      body: { teamId: 'tt_team_x', event: { type: 'submit' } },
    });
  });

  it('create is bare (params at top level)', () => {
    expect(buildTaskTeamRequest('create', ['--json', '{"goal":"g","companyId":"c"}'])).toEqual({
      path: '/api/taskteam-create',
      body: { goal: 'g', companyId: 'c' },
    });
  });

  it('config-list / exports → empty body; unknown verb → error', () => {
    expect(buildTaskTeamRequest('config-list', [])).toEqual({ path: '/api/taskteam-config-list', body: {} });
    expect(buildTaskTeamRequest('template-export', [])).toEqual({ path: '/api/taskteam-template-export', body: {} });
    expect(buildTaskTeamRequest('nope', [])).toHaveProperty('error');
  });
});
