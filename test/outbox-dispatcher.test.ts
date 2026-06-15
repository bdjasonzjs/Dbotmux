/**
 * Unit tests for outbox-dispatcher (Phase 3 投递层)。
 * 用真 store (temp dir) + mock deliver，覆盖 claim/lease、CAS 回写、退避重试、planDispatch。
 * Run: pnpm vitest run test/outbox-dispatcher.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;
vi.mock('../src/config.js', () => ({ config: { get session() { return { dataDir: tempDir }; } } }));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), isDebug: () => false },
}));

import {
  createSubTask, transitionStatus, getSubTask, enqueueCommand, getCommand,
  listPendingCommands, claimCommandForDispatch, completeDispatch,
  __resetForTesting, type SubTaskBot,
} from '../src/services/subtask-store.js';
import * as store from '../src/services/subtask-store.js';
import {
  runDispatcherTick, planDispatch, planBackoff, MAX_RETRY, DISPATCH_LEASE_MS,
  RESEND_DEADLINE_MS,
  type DispatchExecutors,
} from '../src/services/outbox-dispatcher.js';
import { ackCommand } from '../src/services/subtask-store.js';

const BOTS: SubTaskBot[] = [{ openId: 'ou_claude', name: '克劳德', role: 'main' }];

async function mkTaskWithCommand(over?: {
  status?: Parameters<typeof transitionStatus>[1];
  direction?: 'child_to_parent' | 'parent_to_child';
  commandType?: 'report_help' | 'report_done' | 'finish' | 'supplement';
}) {
  const t = await createSubTask({
    chatId: 'oc_sub', parentChatId: 'oc_parent', parentMessageId: 'om_src',
    goal: '修 bug', acceptance: null, bots: BOTS, requester: 'ou_jason', createdBy: 'ou_claude', idempotencyKey: 'k1',
  });
  await transitionStatus(t.taskId, over?.status ?? 'observing');
  const dir = over?.direction ?? 'child_to_parent';
  const cmd = await enqueueCommand({
    taskId: t.taskId, direction: dir,
    targetChatId: dir === 'child_to_parent' ? 'oc_parent' : 'oc_sub',
    commandType: over?.commandType ?? 'report_help',
    payload: { summary: '卡住了' }, idempotencyKey: 'cmdk1',
  });
  return { taskId: t.taskId, cmdId: cmd.cmdId };
}

type ExecMock = DispatchExecutors & { writeAndSend: ReturnType<typeof vi.fn>; checkStatus: ReturnType<typeof vi.fn> };
function mkExec(over?: { write?: DispatchExecutors['writeAndSend']; check?: DispatchExecutors['checkStatus'] }): ExecMock {
  return {
    writeAndSend: vi.fn(over?.write ?? (async () => ({ ok: true, relayRecordId: 'rec_1' }))),
    checkStatus: vi.fn(over?.check ?? (async () => 'sent' as const)),
  } as any;
}
/** 推进到命令的 nextRetryAt 之后 (让对账/重试这一轮可见)。 */
function afterNextRetry(cmdId: string): Date {
  return new Date(new Date(getCommand(cmdId)!.nextRetryAt!).getTime() + 1);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'disp-test-'));
  __resetForTesting();
});

// ─── planDispatch 纯决策 ─────────────────────────────────────────────────────
describe('planDispatch', () => {
  it('task 没了 (orphan) → skip', () => {
    expect(planDispatch({ deliveryStatus: 'pending', supersededBy: null } as any, null).action).toBe('skip');
  });
  it('已 superseded → skip', () => {
    expect(planDispatch({ deliveryStatus: 'pending', supersededBy: 'x' } as any, { status: 'observing' } as any).action).toBe('skip');
  });
  it('非 pending → skip', () => {
    expect(planDispatch({ deliveryStatus: 'sent', supersededBy: null } as any, { status: 'observing' } as any).action).toBe('skip');
  });
  it('parent→child supplement + task 已终态 → skip (补充无意义)', () => {
    const cmd = { deliveryStatus: 'pending', supersededBy: null, direction: 'parent_to_child', commandType: 'supplement' } as any;
    expect(planDispatch(cmd, { status: 'finished' } as any).action).toBe('skip');
    expect(planDispatch(cmd, { status: 'stopped' } as any).action).toBe('skip');
  });
  it('child→parent report_help + task 已终态 → skip (陈旧求助不再刷父群)', () => {
    const cmd = { deliveryStatus: 'pending', supersededBy: null, direction: 'child_to_parent', commandType: 'report_help' } as any;
    expect(planDispatch(cmd, { status: 'finished' } as any).action).toBe('skip');
    expect(planDispatch(cmd, { status: 'stopped' } as any).action).toBe('skip');
  });
  it('E2E 修复: parent→child finish + task 已 finished → send (finish 豁免终态 skip, 必须通知子群)', () => {
    const cmd = { deliveryStatus: 'pending', supersededBy: null, direction: 'parent_to_child', commandType: 'finish' } as any;
    expect(planDispatch(cmd, { status: 'finished' } as any).action).toBe('send');
    expect(planDispatch(cmd, { status: 'stopped' } as any).action).toBe('send');
  });
  it('正常 pending child→parent → send', () => {
    const cmd = { deliveryStatus: 'pending', supersededBy: null, direction: 'child_to_parent' } as any;
    expect(planDispatch(cmd, { status: 'reported_help' } as any).action).toBe('send');
  });
});

// ─── planBackoff 退避 ────────────────────────────────────────────────────────
describe('planBackoff', () => {
  it('指数退避 30s→60s→120s→…→cap 600s', () => {
    expect(planBackoff(1)).toBe(30_000);
    expect(planBackoff(2)).toBe(60_000);
    expect(planBackoff(3)).toBe(120_000);
    expect(planBackoff(4)).toBe(240_000);
    expect(planBackoff(5)).toBe(480_000);
    expect(planBackoff(6)).toBe(600_000); // cap
    expect(planBackoff(99)).toBe(600_000);
  });
});

// ─── claim / lease ───────────────────────────────────────────────────────────
describe('claim / lease', () => {
  it('claim 成功后 listPendingCommands 排除它 (lease 未过期)，过期后又可见', async () => {
    const { cmdId } = await mkTaskWithCommand();
    const now = new Date();
    expect(listPendingCommands(now).map(c => c.cmdId)).toContain(cmdId);
    const claimed = await claimCommandForDispatch(cmdId, 'A', DISPATCH_LEASE_MS, now);
    expect(claimed).not.toBeNull();
    // lease 未过期 → 不在待投列表
    expect(listPendingCommands(now).map(c => c.cmdId)).not.toContain(cmdId);
    // lease 过期 → 重新可见 (可被重 claim)
    const later = new Date(now.getTime() + DISPATCH_LEASE_MS + 1);
    expect(listPendingCommands(later).map(c => c.cmdId)).toContain(cmdId);
  });

  it('lease 未过期时第二个 claim 失败 (互斥)', async () => {
    const { cmdId } = await mkTaskWithCommand();
    const now = new Date();
    expect(await claimCommandForDispatch(cmdId, 'A', DISPATCH_LEASE_MS, now)).not.toBeNull();
    expect(await claimCommandForDispatch(cmdId, 'B', DISPATCH_LEASE_MS, now)).toBeNull();
  });

  it('completeDispatch CAS：lease 被别人接管 → 旧持有者回写被拒，不覆盖', async () => {
    const { cmdId } = await mkTaskWithCommand();
    const t0 = new Date();
    await claimCommandForDispatch(cmdId, 'A', DISPATCH_LEASE_MS, t0); // A 持 lease
    // lease 过期，B 重 claim
    const t1 = new Date(t0.getTime() + DISPATCH_LEASE_MS + 1);
    await claimCommandForDispatch(cmdId, 'B', DISPATCH_LEASE_MS, t1);
    // A 这才慢吞吞回来回写 → dispatchAttemptId 已是 B → 拒绝
    const stale = await completeDispatch(cmdId, 'A', { deliveryStatus: 'sent' });
    expect(stale).toBeNull();
    expect(getCommand(cmdId)!.deliveryStatus).toBe('pending'); // 没被 A 覆盖成 sent
    // B 正常回写 → 成功
    const ok = await completeDispatch(cmdId, 'B', { deliveryStatus: 'sent', deliveredMessageId: 'om_b' });
    expect(ok).not.toBeNull();
    expect(getCommand(cmdId)!.deliveryStatus).toBe('sent');
    expect(getCommand(cmdId)!.dispatchAttemptId).toBeNull(); // lease 已清
  });
});

// ─── runDispatcherTick 集成 (v2 两段式) ─────────────────────────────────────
describe('runDispatcherTick — Phase A 投递 (写 record → sent_unconfirmed，不阻塞)', () => {
  it('写入成功 → sent_unconfirmed（不直接 sent，本 tick 不对账自己）', async () => {
    const { cmdId } = await mkTaskWithCommand();
    const now = new Date();
    const exec = mkExec({ write: async () => ({ ok: true, relayRecordId: 'rec_a' }) });
    const stats = await runDispatcherTick(now, exec);
    expect(stats.written).toBe(1);
    expect(stats.sent).toBe(0);
    const c = getCommand(cmdId)!;
    expect(c.deliveryStatus).toBe('sent_unconfirmed');
    expect(c.relayRecordId).toBe('rec_a');
    expect(c.sentAt).not.toBeNull();
    expect(c.dispatchAttemptId).toBeNull();
    expect(exec.checkStatus).not.toHaveBeenCalled(); // 刚写、nextRetryAt 未到，本 tick 不对账
    expect(exec.writeAndSend).toHaveBeenCalledTimes(1);
  });

  it('写不进 record (无 relayRecordId) → enqueueFailures + 退避重试，仍 pending', async () => {
    const { cmdId } = await mkTaskWithCommand();
    const now = new Date();
    const exec = mkExec({ write: async () => ({ ok: false, error: 'upsert failed' }) });
    const stats = await runDispatcherTick(now, exec);
    expect(stats.enqueueFailures).toBe(1);
    expect(stats.retried).toBe(1);
    expect(stats.written).toBe(0);
    const c = getCommand(cmdId)!;
    expect(c.deliveryStatus).toBe('pending');
    expect(c.retryCount).toBe(1);
    expect(new Date(c.nextRetryAt!).getTime()).toBe(now.getTime() + planBackoff(1));
  });

  it('authError 写不进 → authErrors + enqueueFailures', async () => {
    await mkTaskWithCommand();
    const exec = mkExec({ write: async () => ({ ok: false, authError: true, error: 'user token auth' }) });
    const stats = await runDispatcherTick(new Date(), exec);
    expect(stats.authErrors).toBe(1);
    expect(stats.enqueueFailures).toBe(1);
  });

  it('写不进 record 连续失败到 MAX_RETRY → failed (真没投递)', async () => {
    const { cmdId } = await mkTaskWithCommand();
    const exec = mkExec({ write: async () => ({ ok: false, error: 'down' }) });
    let t = Date.now();
    for (let i = 0; i < MAX_RETRY + 2; i++) {
      await runDispatcherTick(new Date(t), exec);
      const c = getCommand(cmdId)!;
      if (c.deliveryStatus === 'failed') break;
      t = new Date(c.nextRetryAt!).getTime();
    }
    const c = getCommand(cmdId)!;
    expect(c.deliveryStatus).toBe('failed');
    expect(c.retryCount).toBe(MAX_RETRY);
  });

  it('未到 nextRetryAt → 本轮不写 (writeAndSend 不被调用)', async () => {
    const { cmdId } = await mkTaskWithCommand();
    const now = new Date();
    const failExec = mkExec({ write: async () => ({ ok: false, error: 'x' }) });
    await runDispatcherTick(now, failExec); // → retry, nextRetryAt=now+30s
    const c = getCommand(cmdId)!;
    const exec2 = mkExec();
    await runDispatcherTick(new Date(now.getTime() + 1000), exec2); // 还没到 nextRetryAt
    expect(exec2.writeAndSend).not.toHaveBeenCalled();
    expect(getCommand(cmdId)!.retryCount).toBe(c.retryCount);
  });
});

describe('runDispatcherTick — Phase B 对账 (异步确认/重发/告警)', () => {
  async function writeThenReconcile(cmdId: string, exec: ExecMock, t0 = new Date()) {
    await runDispatcherTick(t0, exec);                       // tick1 → sent_unconfirmed
    expect(getCommand(cmdId)!.deliveryStatus).toBe('sent_unconfirmed');
    return runDispatcherTick(afterNextRetry(cmdId), exec);   // tick2 → 对账
  }

  it('对账读到「已发送」→ sent', async () => {
    const { cmdId } = await mkTaskWithCommand();
    const exec = mkExec({ write: async () => ({ ok: true, relayRecordId: 'rec_b' }), check: async () => 'sent' });
    const stats = await writeThenReconcile(cmdId, exec);
    expect(stats.sent).toBe(1);
    expect(exec.checkStatus).toHaveBeenCalledWith('rec_b');
    const c = getCommand(cmdId)!;
    expect(c.deliveryStatus).toBe('sent');
    expect(c.nextRetryAt).toBeNull();
  });

  it('对账读到「已取消」→ 终态 failed', async () => {
    const { cmdId } = await mkTaskWithCommand();
    const exec = mkExec({ check: async () => 'cancelled' });
    const stats = await writeThenReconcile(cmdId, exec);
    expect(stats.failed).toBe(1);
    expect(getCommand(cmdId)!.deliveryStatus).toBe('failed');
  });

  it('对账 unknown → confirmFailures，绝不重发，保持 sent_unconfirmed', async () => {
    const { cmdId } = await mkTaskWithCommand();
    const exec = mkExec({ check: async () => 'unknown' });
    const stats = await writeThenReconcile(cmdId, exec);
    expect(stats.confirmFailures).toBe(1);
    expect(stats.resent).toBe(0);
    expect(exec.writeAndSend).toHaveBeenCalledTimes(1); // 只首投那一次，没重发
    expect(getCommand(cmdId)!.deliveryStatus).toBe('sent_unconfirmed');
  });

  it('对账 auth_error → confirmFailures + authErrors，绝不重发，继续等', async () => {
    const { cmdId } = await mkTaskWithCommand();
    const exec = mkExec({ check: async () => 'auth_error' });
    const stats = await writeThenReconcile(cmdId, exec);
    expect(stats.confirmFailures).toBe(1);
    expect(stats.authErrors).toBe(1);
    expect(exec.writeAndSend).toHaveBeenCalledTimes(1);
    expect(getCommand(cmdId)!.deliveryStatus).toBe('sent_unconfirmed');
  });

  it('对账 still-pending 未超 deadline → 继续等，不重发', async () => {
    const { cmdId } = await mkTaskWithCommand();
    const exec = mkExec({ check: async () => 'pending' });
    const stats = await writeThenReconcile(cmdId, exec); // 对账发生在 ~now+15s，远未到 5min deadline
    expect(stats.resent).toBe(0);
    expect(exec.writeAndSend).toHaveBeenCalledTimes(1);
    expect(getCommand(cmdId)!.deliveryStatus).toBe('sent_unconfirmed');
  });

  it('对账 still-pending 超 deadline → 幂等重发 (写新 record、复用 cmdId)，仍 sent_unconfirmed', async () => {
    const { cmdId } = await mkTaskWithCommand();
    let n = 0;
    const exec = mkExec({
      write: async () => ({ ok: true, relayRecordId: `rec_${n++}` }),
      check: async () => 'pending',
    });
    const t0 = new Date();
    await runDispatcherTick(t0, exec); // 首投 → sent_unconfirmed (rec_0, sentAt=t0)
    const tLate = new Date(t0.getTime() + RESEND_DEADLINE_MS + 1000); // 超 deadline 且过 nextRetryAt
    const stats = await runDispatcherTick(tLate, exec);
    expect(stats.resent).toBe(1);
    expect(exec.writeAndSend).toHaveBeenCalledTimes(2); // 首投 + 重发
    const c = getCommand(cmdId)!;
    expect(c.deliveryStatus).toBe('sent_unconfirmed');
    expect(c.relayRecordId).toBe('rec_1'); // 换成新 record
    expect(c.retryCount).toBe(1);          // 重发计数 +1
  });

  it('ack 优先：sent_unconfirmed 被主bot ack 后，对账不处理它 (不降级、不重发、不查状态)', async () => {
    const { cmdId } = await mkTaskWithCommand();
    const exec = mkExec({ check: async () => 'sent' });
    await runDispatcherTick(new Date(), exec); // → sent_unconfirmed
    await ackCommand(cmdId);                   // 主bot 在确认前就 ack
    expect(getCommand(cmdId)!.deliveryStatus).toBe('acked');
    const stats = await runDispatcherTick(afterNextRetry(cmdId), exec);
    expect(stats.sent).toBe(0);
    expect(exec.checkStatus).not.toHaveBeenCalled(); // acked 不在 listUnconfirmedCommands
    expect(getCommand(cmdId)!.deliveryStatus).toBe('acked'); // 终态保持
  });

  it('P1: ack 落在 checkStatus 期间 (重发前) → 重发前重读拦下、不重发，命令保持 acked', async () => {
    const { cmdId } = await mkTaskWithCommand();
    const exec = mkExec({
      write: async () => ({ ok: true, relayRecordId: 'rec_p1a' }),
      check: async () => { await ackCommand(cmdId); return 'pending'; }, // ack 落在 checkStatus IO 中
    });
    const t0 = new Date();
    await runDispatcherTick(t0, exec); // → sent_unconfirmed
    const nraBefore = getCommand(cmdId)!.nextRetryAt; // 首投设的对账时间
    const tLate = new Date(t0.getTime() + RESEND_DEADLINE_MS + 1000); // 超 deadline，本会触发重发
    const stats = await runDispatcherTick(tLate, exec);
    expect(stats.resent).toBe(0);                       // 重发前重读发现 acked → 不重发
    expect(exec.writeAndSend).toHaveBeenCalledTimes(1); // 仅首投
    expect(getCommand(cmdId)!.deliveryStatus).toBe('acked');
    expect(getCommand(cmdId)!.nextRetryAt).toBe(nraBefore); // 蔻黛 P2 cleanup：仅清 lease，不给 acked 写 nextRetryAt
    expect(getCommand(cmdId)!.dispatchAttemptId).toBeNull(); // lease 已清
  });

  it('P1: ack 落在 resend writeAndSend IO 中 → record 写出但写后重读拦下，不污染终态/元数据', async () => {
    const { cmdId } = await mkTaskWithCommand();
    let writeCalls = 0;
    const exec = mkExec({
      write: async () => {
        writeCalls += 1;
        if (writeCalls === 2) await ackCommand(cmdId); // 第二次(重发)写入 IO 中 ack
        return { ok: true, relayRecordId: `rec_p1b_${writeCalls}` };
      },
      check: async () => 'pending',
    });
    const t0 = new Date();
    await runDispatcherTick(t0, exec); // 首投 → sent_unconfirmed (rec_p1b_1)
    const recBefore = getCommand(cmdId)!.relayRecordId;
    const tLate = new Date(t0.getTime() + RESEND_DEADLINE_MS + 1000);
    const stats = await runDispatcherTick(tLate, exec); // 重发 write#2 中途 ack → 写后重读拦下
    expect(stats.resent).toBe(0);                        // 写后守卫拦下，没计 resent
    expect(getCommand(cmdId)!.deliveryStatus).toBe('acked'); // 终态保持
    expect(getCommand(cmdId)!.relayRecordId).toBe(recBefore); // 元数据没被重发覆盖
  });
});

describe('runDispatcherTick — planDispatch skip / 终态', () => {
  it('child→parent 上报: task 已 finished → skip + supersede', async () => {
    const { cmdId, taskId } = await mkTaskWithCommand();
    await transitionStatus(taskId, 'finished');
    const exec = mkExec();
    const stats = await runDispatcherTick(new Date(), exec);
    expect(stats.skipped).toBe(1);
    expect(exec.writeAndSend).not.toHaveBeenCalled();
    expect(getCommand(cmdId)!.supersededBy).not.toBeNull();
  });

  it('E2E: parent→child finish + task 已 finished → 真写 (子群收到结束通知 → sent_unconfirmed)', async () => {
    const { cmdId, taskId } = await mkTaskWithCommand({ direction: 'parent_to_child', commandType: 'finish' });
    await transitionStatus(taskId, 'reported_done');
    await transitionStatus(taskId, 'finished');
    const exec = mkExec({ write: async () => ({ ok: true, relayRecordId: 'rec_fin' }) });
    const stats = await runDispatcherTick(new Date(), exec);
    expect(stats.written).toBe(1);
    expect(exec.writeAndSend).toHaveBeenCalled();
    expect(getCommand(cmdId)!.deliveryStatus).toBe('sent_unconfirmed');
  });

  it('P1-2 TOCTOU: claim 后 task 被终态化 → 复核 skip + supersede + 不写', async () => {
    const { cmdId, taskId } = await mkTaskWithCommand({ direction: 'parent_to_child', commandType: 'supplement' });
    const real = getSubTask(taskId)!;
    const spy = vi.spyOn(store, 'getSubTask')
      .mockReturnValueOnce(real)
      .mockReturnValueOnce({ ...real, status: 'finished' });
    const exec = mkExec();
    const stats = await runDispatcherTick(new Date(), exec);
    expect(exec.writeAndSend).not.toHaveBeenCalled();
    expect(stats.skipped).toBe(1);
    expect(getCommand(cmdId)!.supersededBy).not.toBeNull();
    expect(getCommand(cmdId)!.dispatchAttemptId).toBeNull();
    spy.mockRestore();
  });
});
