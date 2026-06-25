import { describe, expect, it } from 'vitest';
import {
  buildRoleInstancesFromTemplate,
  buildTaskTeamAvailableBots,
  resolveTaskTeamBotRef,
  summarizeTaskTeamTypes,
} from '../src/services/taskteam-template-create.js';
import type { TaskTeamConfigFile, TaskTeamType } from '../src/services/taskteam-schema.js';

const type: TaskTeamType = {
  typeId: 'tt_type_review',
  name: 'Review',
  roleSlots: [
    { slotId: 'tt_slot_dev', roleId: 'tt_role_dev', label: 'dev' },
    { slotId: 'tt_slot_reviewer', roleId: 'tt_role_reviewer', label: 'reviewer' },
    { slotId: 'tt_slot_observer', roleId: 'tt_role_observer', label: 'observer' },
  ],
  rules: [],
  policy: { reviewRounds: 1, reviewQuorum: 1, maxRework: 1, escalateAfterStallMs: 1000, reviewOrder: [] },
};

const bots = buildTaskTeamAvailableBots(
  [
    { larkAppId: 'cli_c', cliId: 'claude-code', name: 'claude-main', index: 0 },
    { larkAppId: 'cli_k', cliId: 'codex', name: 'codex-main', index: 1 },
    { larkAppId: 'cli_t', cliId: 'coco', name: 'tilly-main', index: 2 },
  ],
  [
    { larkAppId: 'cli_c', botOpenId: 'ou_c', botName: '克劳德' },
    { larkAppId: 'cli_k', botOpenId: 'ou_k', botName: '蔻黛克斯' },
    { larkAppId: 'cli_t', botOpenId: 'ou_t', botName: '缇蕾' },
  ],
);

describe('taskteam template create helpers', () => {
  it('resolves appId, display names, and c/k/t CLI aliases server-side', () => {
    expect(resolveTaskTeamBotRef('cli_k', bots)).toMatchObject({ larkAppId: 'cli_k', botOpenId: 'ou_k' });
    expect(resolveTaskTeamBotRef('蔻黛克斯', bots)).toMatchObject({ larkAppId: 'cli_k', botOpenId: 'ou_k' });
    expect(resolveTaskTeamBotRef('k', bots)).toMatchObject({ larkAppId: 'cli_k', botOpenId: 'ou_k' });
    expect(resolveTaskTeamBotRef('t', bots)).toMatchObject({ larkAppId: 'cli_t', botOpenId: 'ou_t' });
  });

  it('does not silently choose the first bot when c/k/t aliases match multiple clones', () => {
    const multiCodex = buildTaskTeamAvailableBots(
      [
        { larkAppId: 'cli_k1', cliId: 'codex', name: 'codex-main', index: 0 },
        { larkAppId: 'cli_k2', cliId: 'codex', name: 'codex-reviewer', index: 1 },
      ],
      [
        { larkAppId: 'cli_k1', botOpenId: 'ou_k1', botName: '蔻黛克斯' },
        { larkAppId: 'cli_k2', botOpenId: 'ou_k2', botName: '蔻黛克斯（二号机）' },
      ],
    );

    expect(multiCodex.flatMap(b => b.refs)).not.toContain('k');
    expect(resolveTaskTeamBotRef('k', multiCodex)).toEqual({
      error: 'bot_ambiguous',
      candidates: ['蔻黛克斯:cli_k1', '蔻黛克斯（二号机）:cli_k2'],
    });
    expect(resolveTaskTeamBotRef('cli_k2', multiCodex)).toMatchObject({ larkAppId: 'cli_k2', botOpenId: 'ou_k2' });
  });

  it('builds roleInstances from slotId or label and rejects duplicate bot assignment', () => {
    const ok = buildRoleInstancesFromTemplate({
      type,
      availableBots: bots,
      selectedBotBySlot: { dev: 'c', reviewer: 'k', observer: 't' },
    });
    expect(ok.problems).toEqual([]);
    expect(ok.selectedAppBySlot).toEqual({ tt_slot_dev: 'cli_c', tt_slot_reviewer: 'cli_k', tt_slot_observer: 'cli_t' });
    expect(ok.roleInstances.map(r => [r.slotId, r.binding?.botOpenId])).toEqual([
      ['tt_slot_dev', 'ou_c'],
      ['tt_slot_reviewer', 'ou_k'],
      ['tt_slot_observer', 'ou_t'],
    ]);

    const dup = buildRoleInstancesFromTemplate({
      type,
      availableBots: bots,
      selectedBotBySlot: { dev: 'k', reviewer: 'k', observer: 't' },
    });
    expect(dup.problems).toContainEqual({ slotId: 'tt_slot_reviewer', reason: 'duplicate_bot_assignment', ref: 'k', candidates: ['tt_slot_dev'] });
  });

  it('summarizes types with slot role detail and bot refs for taskteam-types', () => {
    const cfg: TaskTeamConfigFile = {
      version: 1,
      roles: [
        { roleId: 'tt_role_dev', name: '开发者', responsibility: '实现', activation: { trigger: 'start' }, visibility: 'full', actions: ['submit'], io: { from: [], to: [] } },
        { roleId: 'tt_role_observer', name: '观察者', responsibility: '盯群', activation: { trigger: 'tick' }, visibility: 'progress-only', actions: ['report'], io: { from: [], to: [] }, isObserver: true },
      ],
      rules: [],
      teamTypes: [type],
      orgStructures: [],
      orgRuntimeBindings: [],
      updatedAt: '2026-06-26T00:00:00.000Z',
    };
    const summary = summarizeTaskTeamTypes(cfg, bots);
    expect(summary.teamTypes[0]?.slots[0]).toMatchObject({ slotId: 'tt_slot_dev', label: 'dev', roleName: '开发者' });
    expect(summary.teamTypes[0]?.slots[2]).toMatchObject({ slotId: 'tt_slot_observer', observer: true });
    expect(summary.bots.find(b => b.larkAppId === 'cli_k')?.refs).toEqual(expect.arrayContaining(['k', 'codex', '蔻黛克斯']));
  });
});
