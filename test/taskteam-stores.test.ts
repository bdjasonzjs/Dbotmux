import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
      actionType: 'request-review',
      sourceRoleInstanceId: 'tt_ri_arch',
      targetSlotId: 'tt_slot_detail_reviewer_main',
      idempotencyKey: 'demo:request-review:1',
      payload: { summary: 'please review' },
    });
    const second = await outboxStore.enqueueTaskTeamAction({
      teamId: 'tt_team_demo',
      actionType: 'request-review',
      idempotencyKey: 'demo:request-review:1',
    });

    expect(second.actionId).toBe(first.actionId);
    expect(outboxStore.listPendingTaskTeamActions().length).toBe(1);

    const claimed = await outboxStore.claimTaskTeamAction(first.actionId, 60_000);
    expect(claimed?.status).toBe('claimed');
    expect(outboxStore.listPendingTaskTeamActions().length).toBe(0);

    const sent = await outboxStore.completeTaskTeamAction(first.actionId, {
      status: 'sent',
      deliveredMessageId: 'om_demo',
      dispatchAttemptId: claimed!.dispatchAttemptId,
    });
    expect(sent?.status).toBe('sent');
    expect(sent?.leaseExpiresAt).toBeNull();
    expect(sent?.deliveredMessageId).toBe('om_demo');
  });

  it('enforces retry-release, CAS fencing and complete-side state machine (A2 / P1-2 / P1)', async () => {
    const { outboxStore } = await freshStores();
    const {
      enqueueTaskTeamAction: enqueue,
      claimTaskTeamAction: claim,
      completeTaskTeamAction: complete,
      releaseTaskTeamActionForRetry: release,
      listPendingTaskTeamActions: listPending,
      TaskTeamActionTerminalError,
      TaskTeamActionTransitionError,
    } = outboxStore;

    // —— claimed → release(retry)：仅同一 dispatch attempt 放行；退避 listPending/claim 都守 ——
    const a = await enqueue({ teamId: 'tt_team_demo', actionType: 'request-review', idempotencyKey: 'k:retry' });
    const claimed = await claim(a.actionId, 60_000);
    expect(claimed?.status).toBe('claimed');
    const attemptId = claimed!.dispatchAttemptId;

    // 迟到回调 / 错误 attempt → 不放行（保持 claimed、retryCount 不变）
    const stale = await release(a.actionId, { dispatchAttemptId: 'tt_dispatch_bogus', backoffMs: 10_000 });
    expect(stale?.status).toBe('claimed');
    expect(stale?.retryCount).toBe(0);

    // 无凭证 release（claimed 下）→ 拒绝（与 complete CAS 对称，否则清掉当前 holder lease）
    const noCred = await release(a.actionId, { backoffMs: 10_000 });
    expect(noCred?.status).toBe('claimed');
    expect(noCred?.retryCount).toBe(0);

    // 正确 attempt → 退避重投
    const released = await release(a.actionId, { dispatchAttemptId: attemptId, lastError: 'lark send failed', backoffMs: 10_000 });
    expect(released?.status).toBe('pending');
    expect(released?.retryCount).toBe(1);
    expect(released?.lastError).toBe('lark send failed');
    expect(released?.leaseExpiresAt).toBeNull();
    const baseMs = new Date(released!.nextAttemptAt!).getTime();
    expect(listPending(new Date(baseMs - 1_000)).length).toBe(0);
    expect(await claim(a.actionId, 60_000)).toBeNull(); // P2-1：claim 也守退避窗
    expect(listPending(new Date(baseMs + 1_000)).length).toBe(1);

    // —— complete CAS fencing：非当前持有 attempt（含迟到旧 attempt）不可写入 ——
    const d = await enqueue({ teamId: 'tt_team_demo', actionType: 'kickoff', idempotencyKey: 'k:cas' });
    const dClaim = await claim(d.actionId, 60_000);
    const holder = dClaim!.dispatchAttemptId;
    // 错误 / 迟到 attempt → 拒写(null)，状态仍 claimed
    expect(await complete(d.actionId, { status: 'sent', deliveredMessageId: 'om_late', dispatchAttemptId: 'tt_dispatch_stale' })).toBeNull();
    // 无 attempt 凭证 → 拒写
    expect(await complete(d.actionId, { status: 'sent' })).toBeNull();
    expect(outboxStore.readTaskTeamOutbox().actions.find(x => x.actionId === d.actionId)?.status).toBe('claimed');
    // 当前持有者 → 放行
    expect((await complete(d.actionId, { status: 'sent', dispatchAttemptId: holder }))?.status).toBe('sent');

    // —— complete 状态机：sent 不降级 failed；sent→acked 合法；acked 终态；pending 不可直接 complete ——
    const b = await enqueue({ teamId: 'tt_team_demo', actionType: 'report', idempotencyKey: 'k:sent' });
    const bClaim = await claim(b.actionId, 60_000);
    const bSent = await complete(b.actionId, { status: 'sent', deliveredMessageId: 'om_b', dispatchAttemptId: bClaim!.dispatchAttemptId });
    expect(bSent?.status).toBe('sent');
    expect((await release(b.actionId, { backoffMs: 5_000 }))?.status).toBe('sent'); // 不复活已发送
    await expect(complete(b.actionId, { status: 'failed' })).rejects.toThrow(TaskTeamActionTransitionError); // sent→failed 禁止
    expect((await complete(b.actionId, { status: 'acked' }))?.status).toBe('acked'); // sent→acked 合法
    await expect(complete(b.actionId, { status: 'failed' })).rejects.toThrow(TaskTeamActionTerminalError); // acked 终态跨状态拒
    expect((await complete(b.actionId, { status: 'acked' }))?.status).toBe('acked'); // 同状态幂等
    expect((await release(b.actionId, { backoffMs: 1_000 }))?.status).toBe('acked'); // acked 不可 release

    // pending 未 claim 直接 complete → 非法跃迁
    const p = await enqueue({ teamId: 'tt_team_demo', actionType: 'nudge', idempotencyKey: 'k:pending' });
    await expect(complete(p.actionId, { status: 'sent' })).rejects.toThrow(TaskTeamActionTransitionError);

    // —— failed 终态：不复活、不可改写、不再额外加 retryCount ——
    const c = await enqueue({ teamId: 'tt_team_demo', actionType: 'nudge', idempotencyKey: 'k:failed' });
    const cClaim = await claim(c.actionId, 60_000);
    const cFailed = await complete(c.actionId, { status: 'failed', lastError: 'gave up', dispatchAttemptId: cClaim!.dispatchAttemptId });
    expect(cFailed?.status).toBe('failed');
    expect(cFailed?.retryCount).toBe(0);
    expect((await release(c.actionId, { backoffMs: 1_000 }))?.status).toBe('failed');
    await expect(complete(c.actionId, { status: 'sent' })).rejects.toThrow(TaskTeamActionTerminalError);
    // 退避到点的 a + 从未 claim 的 p 仍 pending；终态 b(acked)/c(failed)、已发送 d(sent) 都不在
    expect(listPending(new Date(baseMs + 999_999)).length).toBe(2);
  });

  it('backs up corrupt stores instead of treating them as empty (P2-2)', async () => {
    const { configStore, teamStore, outboxStore } = await freshStores();
    const corruptBackupExists = (base: string) =>
      readdirSync(tempDir).some(f => f.startsWith(`${base}.corrupt-`));

    writeFileSync(join(tempDir, 'taskteam-config.json'), '{not-json', 'utf-8');
    expect(() => configStore.readTaskTeamConfig()).toThrow(configStore.TaskTeamConfigStoreCorruptError);
    expect(readFileSync(join(tempDir, 'taskteam-config.json'), 'utf-8')).toBe('{not-json');
    expect(corruptBackupExists('taskteam-config.json')).toBe(true);

    writeFileSync(join(tempDir, 'taskteams.json'), '{bad', 'utf-8');
    expect(() => teamStore.readTaskTeams()).toThrow(teamStore.TaskTeamStoreCorruptError);
    expect(corruptBackupExists('taskteams.json')).toBe(true);

    writeFileSync(join(tempDir, 'taskteam-outbox.json'), 'not-json]', 'utf-8');
    expect(() => outboxStore.readTaskTeamOutbox()).toThrow(outboxStore.TaskTeamOutboxStoreCorruptError);
    expect(corruptBackupExists('taskteam-outbox.json')).toBe(true);
  });
});
