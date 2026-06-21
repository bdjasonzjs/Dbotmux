import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskTeamSendResult } from '../src/services/taskteam-dispatcher.js';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: { get session() { return { dataDir: tempDir }; } },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

async function fresh() {
  vi.resetModules();
  return {
    outbox: await import('../src/services/taskteam-outbox-store.js'),
    dispatcher: await import('../src/services/taskteam-dispatcher.js'),
  };
}

// 默认 teamVersion 极大 → 所有命令视为已提交可投递（除非测试显式控制）
function exec(send: () => Promise<TaskTeamSendResult>, teamVersion: () => number | null = () => Number.MAX_SAFE_INTEGER) {
  return { send, teamVersion };
}

describe('runTaskTeamDispatcherTick', () => {
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'tt-disp-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('claims pending → send ok → marks sent with message_id (CAS attempt)', async () => {
    const { outbox, dispatcher } = await fresh();
    await outbox.enqueueTaskTeamAction({ teamId: 'tt_team_a', actionType: 'kickoff', idempotencyKey: 'k1' });
    const stats = await dispatcher.runTaskTeamDispatcherTick(new Date(), exec(async () => ({ ok: true, messageId: 'om_1' })));
    expect(stats).toMatchObject({ claimed: 1, sent: 1, failed: 0, retried: 0, held: 0 });
    const act = outbox.readTaskTeamOutbox().actions[0];
    expect(act.status).toBe('sent');
    expect(act.deliveredMessageId).toBe('om_1');
  });

  it('retriable failure → released to pending with backoff (retryCount+1)', async () => {
    const { outbox, dispatcher } = await fresh();
    const a = await outbox.enqueueTaskTeamAction({ teamId: 'tt_team_a', actionType: 'nudge', idempotencyKey: 'k2' });
    const stats = await dispatcher.runTaskTeamDispatcherTick(new Date(), exec(async () => ({ ok: false, error: 'boom', retriable: true })), { leaseMs: 1000, maxRetry: 5, baseBackoffMs: 10_000, concurrency: 1 });
    expect(stats.retried).toBe(1);
    const act = outbox.readTaskTeamOutbox().actions.find(x => x.actionId === a.actionId)!;
    expect(act.status).toBe('pending');
    expect(act.retryCount).toBe(1);
    expect(act.nextAttemptAt).not.toBeNull();
  });

  it('non-retriable failure → failed terminal', async () => {
    const { outbox, dispatcher } = await fresh();
    await outbox.enqueueTaskTeamAction({ teamId: 'tt_team_a', actionType: 'report', idempotencyKey: 'k3' });
    const stats = await dispatcher.runTaskTeamDispatcherTick(new Date(), exec(async () => ({ ok: false, error: 'no chat', retriable: false })));
    expect(stats.failed).toBe(1);
    expect(outbox.readTaskTeamOutbox().actions[0].status).toBe('failed');
  });

  it('retry budget exhausted (maxRetry=0) → failed', async () => {
    const { outbox, dispatcher } = await fresh();
    await outbox.enqueueTaskTeamAction({ teamId: 'tt_team_a', actionType: 'nudge', idempotencyKey: 'k4' });
    const stats = await dispatcher.runTaskTeamDispatcherTick(new Date(), exec(async () => ({ ok: false, error: 'boom', retriable: true })), { leaseMs: 1000, maxRetry: 0, baseBackoffMs: 1000, concurrency: 1 });
    expect(stats.failed).toBe(1);
    expect(outbox.readTaskTeamOutbox().actions[0].status).toBe('failed');
  });

  it('empty outbox → no-op', async () => {
    const { dispatcher } = await fresh();
    const stats = await dispatcher.runTaskTeamDispatcherTick(new Date(), exec(async () => ({ ok: true })));
    expect(stats).toMatchObject({ claimed: 0, sent: 0, failed: 0, retried: 0, skipped: 0, leaseLost: 0, held: 0 });
  });

  it('CAS lost on lease steal → counted leaseLost, not sent (P2)', async () => {
    const { outbox, dispatcher } = await fresh();
    const a = await outbox.enqueueTaskTeamAction({ teamId: 'tt_team_a', actionType: 'kickoff', idempotencyKey: 'k5' });
    const send = async () => {
      await new Promise(r => setTimeout(r, 20));
      await outbox.claimTaskTeamAction(a.actionId, 60_000); // 偷锁
      return { ok: true, messageId: 'om_x' };
    };
    const stats = await dispatcher.runTaskTeamDispatcherTick(new Date(), exec(send), { leaseMs: 1, maxRetry: 5, baseBackoffMs: 1000, concurrency: 1 });
    expect(stats.leaseLost).toBe(1);
    expect(stats.sent).toBe(0);
    expect(outbox.readTaskTeamOutbox().actions[0].status).toBe('claimed');
  });

  it('half-committed action (team.version < expectedTeamVersion) is NOT dispatched (P1)', async () => {
    const { outbox, dispatcher } = await fresh();
    // 模拟"enqueue 成功但 applyState 未提交"：命令绑定 expectedTeamVersion=2，但 team 仍是 version 1
    await outbox.enqueueTaskTeamAction({ teamId: 'tt_team_a', actionType: 'request-review', idempotencyKey: 'k6', expectedTeamVersion: 2 });
    let sendCount = 0;
    const send = async () => { sendCount += 1; return { ok: true, messageId: 'om' }; };

    // team.version=1 < 2 → held，不投递
    let stats = await dispatcher.runTaskTeamDispatcherTick(new Date(), exec(send, () => 1));
    expect(stats.held).toBe(1);
    expect(stats.sent).toBe(0);
    expect(sendCount).toBe(0);
    expect(outbox.readTaskTeamOutbox().actions[0].status).toBe('pending'); // 仍 pending、未被发

    // 状态提交后 team.version=2 → 解锁可投
    stats = await dispatcher.runTaskTeamDispatcherTick(new Date(), exec(send, () => 2));
    expect(stats.held).toBe(0);
    expect(stats.sent).toBe(1);
    expect(sendCount).toBe(1);
    expect(outbox.readTaskTeamOutbox().actions[0].status).toBe('sent');
  });
});
