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
    expect(buildTaskTeamRequest('raw-create', ['--json', '{"goal":"g","companyId":"c"}'])).toEqual({
      path: '/api/taskteam-create',
      body: { goal: 'g', companyId: 'c' },
    });
  });

  it('default create maps to create-from-template and folds repeated --slot flags into selectedBotBySlot', () => {
    expect(buildTaskTeamRequest('create', [
      '--type-id', 'tt_type_two_layer_review',
      '--slot', 'tt_slot_developer_main=claude',
      '--slot', 'tt_slot_observer_main=t',
      '--goal', 'g',
      '--target-external-chat-id', 'oc_ext',
    ])).toEqual({
      path: '/api/taskteam-create-from-template',
      body: {
        typeId: 'tt_type_two_layer_review',
        goal: 'g',
        targetExternalChatId: 'oc_ext',
        selectedBotBySlot: {
          tt_slot_developer_main: 'claude',
          tt_slot_observer_main: 't',
        },
      },
    });
  });

  it('taskteam-types is discoverable; type alias maps to typeId', () => {
    expect(buildTaskTeamRequest('types', [])).toEqual({ path: '/api/taskteam-types', body: {} });
    expect(buildTaskTeamRequest('create', ['--type', 'tt_type_x', '--json', '{"selectedBotBySlot":{"main":"k"}}'])).toEqual({
      path: '/api/taskteam-create-from-template',
      body: { typeId: 'tt_type_x', selectedBotBySlot: { main: 'k' } },
    });
  });

  it('returns executable errors for malformed create args instead of throwing', () => {
    expect(buildTaskTeamRequest('create', ['--slot', 'not-a-pair'])).toMatchObject({
      error: expect.stringContaining('expected <slotId-or-label>=<bot-ref>'),
    });
  });

  it('config-list / exports → empty body; unknown verb → error', () => {
    expect(buildTaskTeamRequest('config-list', [])).toEqual({ path: '/api/taskteam-config-list', body: {} });
    expect(buildTaskTeamRequest('template-export', [])).toEqual({ path: '/api/taskteam-template-export', body: {} });
    expect(buildTaskTeamRequest('nope', [])).toHaveProperty('error');
  });
});
