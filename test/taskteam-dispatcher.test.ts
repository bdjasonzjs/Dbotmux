import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

describe('runTaskTeamDispatcherTick', () => {
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'tt-disp-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('claims pending → send ok → marks sent with message_id (CAS attempt)', async () => {
    const { outbox, dispatcher } = await fresh();
    await outbox.enqueueTaskTeamAction({ teamId: 'tt_team_a', actionType: 'kickoff', idempotencyKey: 'k1' });
    const exec = { send: async () => ({ ok: true, messageId: 'om_1' }) };
    const stats = await dispatcher.runTaskTeamDispatcherTick(new Date(), exec);
    expect(stats).toMatchObject({ claimed: 1, sent: 1, failed: 0, retried: 0 });
    const act = outbox.readTaskTeamOutbox().actions[0];
    expect(act.status).toBe('sent');
    expect(act.deliveredMessageId).toBe('om_1');
  });

  it('retriable failure → released to pending with backoff (retryCount+1)', async () => {
    const { outbox, dispatcher } = await fresh();
    const a = await outbox.enqueueTaskTeamAction({ teamId: 'tt_team_a', actionType: 'nudge', idempotencyKey: 'k2' });
    const exec = { send: async () => ({ ok: false, error: 'boom', retriable: true }) };
    const stats = await dispatcher.runTaskTeamDispatcherTick(new Date(), exec, { leaseMs: 1000, maxRetry: 5, baseBackoffMs: 10_000, concurrency: 1 });
    expect(stats.retried).toBe(1);
    const act = outbox.readTaskTeamOutbox().actions.find(x => x.actionId === a.actionId)!;
    expect(act.status).toBe('pending');
    expect(act.retryCount).toBe(1);
    expect(act.nextAttemptAt).not.toBeNull();
  });

  it('non-retriable failure → failed terminal', async () => {
    const { outbox, dispatcher } = await fresh();
    await outbox.enqueueTaskTeamAction({ teamId: 'tt_team_a', actionType: 'report', idempotencyKey: 'k3' });
    const exec = { send: async () => ({ ok: false, error: 'no chat', retriable: false }) };
    const stats = await dispatcher.runTaskTeamDispatcherTick(new Date(), exec);
    expect(stats.failed).toBe(1);
    expect(outbox.readTaskTeamOutbox().actions[0].status).toBe('failed');
  });

  it('retry budget exhausted (maxRetry=0) → failed', async () => {
    const { outbox, dispatcher } = await fresh();
    await outbox.enqueueTaskTeamAction({ teamId: 'tt_team_a', actionType: 'nudge', idempotencyKey: 'k4' });
    const exec = { send: async () => ({ ok: false, error: 'boom', retriable: true }) };
    const stats = await dispatcher.runTaskTeamDispatcherTick(new Date(), exec, { leaseMs: 1000, maxRetry: 0, baseBackoffMs: 1000, concurrency: 1 });
    expect(stats.failed).toBe(1);
    expect(outbox.readTaskTeamOutbox().actions[0].status).toBe('failed');
  });

  it('empty outbox → no-op', async () => {
    const { dispatcher } = await fresh();
    const exec = { send: async () => ({ ok: true }) };
    const stats = await dispatcher.runTaskTeamDispatcherTick(new Date(), exec);
    expect(stats).toMatchObject({ claimed: 0, sent: 0, failed: 0, retried: 0, skipped: 0, leaseLost: 0 });
  });

  it('CAS lost on lease steal → counted leaseLost, not sent (P2)', async () => {
    const { outbox, dispatcher } = await fresh();
    const a = await outbox.enqueueTaskTeamAction({ teamId: 'tt_team_a', actionType: 'kickoff', idempotencyKey: 'k5' });
    // send 期间本 attempt 的 lease(1ms) 过期，被另一 attempt 重领 → 本 attempt 的 complete 被 CAS 拒
    const exec = {
      send: async () => {
        await new Promise(r => setTimeout(r, 20));
        await outbox.claimTaskTeamAction(a.actionId, 60_000); // 偷锁
        return { ok: true, messageId: 'om_x' };
      },
    };
    const stats = await dispatcher.runTaskTeamDispatcherTick(new Date(), exec, { leaseMs: 1, maxRetry: 5, baseBackoffMs: 1000, concurrency: 1 });
    expect(stats.leaseLost).toBe(1);
    expect(stats.sent).toBe(0);
    expect(outbox.readTaskTeamOutbox().actions[0].status).toBe('claimed'); // 仍归偷锁者，未被误写 sent
  });
});
