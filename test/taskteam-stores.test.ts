import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskTeamRoleInstance } from '../src/services/taskteam-schema.js';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: {
    get session() { return { dataDir: tempDir }; },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

async function freshStores() {
  vi.resetModules();
  return {
    configStore: await import('../src/services/taskteam-config-store.js'),
    teamStore: await import('../src/services/taskteam-store.js'),
    outboxStore: await import('../src/services/taskteam-outbox-store.js'),
  };
}

function sampleRoleInstances(): TaskTeamRoleInstance[] {
  return [
    {
      roleInstanceId: 'tt_ri_dev',
      slotId: 'tt_slot_developer_main',
      roleId: 'tt_role_developer',
      binding: { bindingId: 'tt_binding_dev', botOpenId: 'ou_dev', larkAppId: 'cli_dev' },
    },
    {
      roleInstanceId: 'tt_ri_arch',
      slotId: 'tt_slot_architect_main',
      roleId: 'tt_role_architect',
      binding: { bindingId: 'tt_binding_arch', botOpenId: 'ou_arch', larkAppId: 'cli_arch' },
    },
  ];
}

describe('taskteam batch 1 stores', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'taskteam-store-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('seeds config with stable slots and role definitions without touching subtasks.json', async () => {
    const { configStore } = await freshStores();

    const seeded = await configStore.seedDefaultTaskTeamConfig();

    expect(seeded.roles.map(r => r.roleId)).toContain('tt_role_developer');
    expect(seeded.teamTypes[0].roleSlots.map(s => s.slotId)).toEqual([
      'tt_slot_developer_main',
      'tt_slot_architect_main',
      'tt_slot_detail_reviewer_main',
      'tt_slot_observer_main',
    ]);
    expect(seeded.teamTypes[0].policy.reviewOrder).toEqual([
      'tt_slot_architect_main',
      'tt_slot_detail_reviewer_main',
    ]);
    // A1：可分享的 OrgStructureShape 不含运行态身份（companyId/deptId 单列在 OrgRuntimeBinding）
    expect(seeded.orgStructures[0]).not.toHaveProperty('companyId');
    expect(seeded.orgStructures[0].departments[0]).not.toHaveProperty('deptId');
    expect(seeded.orgStructures[0].companyName).toBe('一人公司');
    // A3：细节 review 通过映射到 report（待验收），不直接 finish
    const detailPassRule = seeded.rules.find(r => r.when.fromSlotId === 'tt_slot_detail_reviewer_main');
    expect(detailPassRule?.do).toBe('report');
    expect(seeded.rules.some(r => r.do === 'finish')).toBe(false);
    expect(existsSync(join(tempDir, 'taskteam-config.json'))).toBe(true);
    expect(existsSync(join(tempDir, 'subtasks.json'))).toBe(false);
  });

  it('persists task team instances keyed by roleInstance and binding', async () => {
    const { teamStore } = await freshStores();

    const team = await teamStore.createTaskTeam({
      typeId: 'tt_type_two_layer_review',
      companyId: 'tt_company_default',
      deptId: 'tt_dept_default',
      chatId: 'oc_team',
      goal: 'implement batch 1',
      acceptance: 'tests pass',
      roleInstances: sampleRoleInstances(),
    });

    expect(team.teamId.startsWith('tt_team_')).toBe(true);
    expect(team.roleInstances[0].roleInstanceId).toBe('tt_ri_dev');
    expect(team.roleInstances[0].binding?.botOpenId).toBe('ou_dev');

    const voted = await teamStore.recordTaskTeamVote(team.teamId, {
      byInstanceId: 'tt_ri_arch',
      verdict: 'pass',
      reason: 'schema matches plan',
    });
    expect(voted.reviewState.votes).toEqual([
      { byInstanceId: 'tt_ri_arch', verdict: 'pass', reason: 'schema matches plan' },
    ]);
    expect(teamStore.getTaskTeam(team.teamId)?.version).toBe(2);
  });

  it('deduplicates task team outbox actions by idempotency key and supports leases', async () => {
    const { outboxStore } = await freshStores();

    const first = await outboxStore.enqueueTaskTeamAction({
      teamId: 'tt_team_demo',
      actionType: 'review-pass',
      sourceRoleInstanceId: 'tt_ri_arch',
      targetSlotId: 'tt_slot_detail_reviewer_main',
      idempotencyKey: 'demo:review-pass:1',
      payload: { summary: 'architecture passed' },
    });
    const second = await outboxStore.enqueueTaskTeamAction({
      teamId: 'tt_team_demo',
      actionType: 'review-pass',
      idempotencyKey: 'demo:review-pass:1',
    });

    expect(second.actionId).toBe(first.actionId);
    expect(outboxStore.listPendingTaskTeamActions().length).toBe(1);

    const claimed = await outboxStore.claimTaskTeamAction(first.actionId, 60_000);
    expect(claimed?.status).toBe('claimed');
    expect(outboxStore.listPendingTaskTeamActions().length).toBe(0);

    const sent = await outboxStore.completeTaskTeamAction(first.actionId, {
      status: 'sent',
      deliveredMessageId: 'om_demo',
    });
    expect(sent.status).toBe('sent');
    expect(sent.leaseExpiresAt).toBeNull();
    expect(sent.deliveredMessageId).toBe('om_demo');
  });

  it('exposes a retry release path with backoff and keeps failed terminal (A2)', async () => {
    const { outboxStore } = await freshStores();

    const action = await outboxStore.enqueueTaskTeamAction({
      teamId: 'tt_team_demo',
      actionType: 'report',
      idempotencyKey: 'demo:retry:1',
    });
    const claimed = await outboxStore.claimTaskTeamAction(action.actionId, 60_000);
    expect(claimed?.status).toBe('claimed');

    // 失败但可重试 → 回 pending、retryCount+1、按 backoff 设退避到点
    const released = await outboxStore.releaseTaskTeamActionForRetry(action.actionId, {
      lastError: 'lark send failed',
      backoffMs: 10_000,
    });
    expect(released?.status).toBe('pending');
    expect(released?.retryCount).toBe(1);
    expect(released?.lastError).toBe('lark send failed');
    expect(released?.leaseExpiresAt).toBeNull();

    // 退避窗内不取，到点后才取
    const baseMs = new Date(released!.nextAttemptAt!).getTime();
    expect(outboxStore.listPendingTaskTeamActions(new Date(baseMs - 1_000)).length).toBe(0);
    expect(outboxStore.listPendingTaskTeamActions(new Date(baseMs + 1_000)).length).toBe(1);

    // 达上限由 dispatcher 落终态 failed —— 终态后不再出现在 pending
    const failed = await outboxStore.completeTaskTeamAction(action.actionId, {
      status: 'failed',
      lastError: 'gave up after retries',
    });
    expect(failed.status).toBe('failed');
    expect(failed.retryCount).toBe(1); // 终态不再额外加计数
    expect(outboxStore.listPendingTaskTeamActions(new Date(baseMs + 999_999)).length).toBe(0);

    // 已 acked 的 action 绝不被回退重投
    const ackAction = await outboxStore.enqueueTaskTeamAction({
      teamId: 'tt_team_demo',
      actionType: 'report',
      idempotencyKey: 'demo:retry:2',
    });
    await outboxStore.completeTaskTeamAction(ackAction.actionId, { status: 'acked' });
    const reReleased = await outboxStore.releaseTaskTeamActionForRetry(ackAction.actionId, { backoffMs: 5_000 });
    expect(reReleased?.status).toBe('acked');
  });

  it('backs up corrupt config instead of treating it as empty', async () => {
    const { configStore } = await freshStores();
    writeFileSync(join(tempDir, 'taskteam-config.json'), '{not-json', 'utf-8');

    expect(() => configStore.readTaskTeamConfig()).toThrow(configStore.TaskTeamConfigStoreCorruptError);
    const backups = readFileSync(join(tempDir, 'taskteam-config.json'), 'utf-8');
    expect(backups).toBe('{not-json');
    expect(existsSync(join(tempDir, 'taskteam-config.json'))).toBe(true);
  });
});
