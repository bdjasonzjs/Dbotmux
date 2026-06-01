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
  type DispatchExecutors,
} from '../src/services/outbox-dispatcher.js';

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

function mkDeliver(impl?: DispatchExecutors['deliver']): DispatchExecutors & { deliver: ReturnType<typeof vi.fn> } {
  return { deliver: vi.fn(impl ?? (async () => ({ ok: true, messageId: 'om_sent' }))) } as any;
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

// ─── runDispatcherTick 集成 ─────────────────────────────────────────────────
describe('runDispatcherTick', () => {
  it('投递成功 → sent + deliveredMessageId + sentAt + lease 清', async () => {
    const { cmdId } = await mkTaskWithCommand();
    const now = new Date();
    const exec = mkDeliver(async () => ({ ok: true, messageId: 'om_real' }));
    const stats = await runDispatcherTick(now, exec);
    expect(stats.sent).toBe(1);
    const c = getCommand(cmdId)!;
    expect(c.deliveryStatus).toBe('sent');
    expect(c.deliveredMessageId).toBe('om_real');
    expect(c.sentAt).not.toBeNull();
    expect(c.dispatchingUntil).toBeNull();
    expect(c.dispatchAttemptId).toBeNull();
  });

  it('投递失败 → retryCount++ + nextRetryAt(退避) 同一次写, 仍 pending', async () => {
    const { cmdId } = await mkTaskWithCommand();
    const now = new Date();
    const exec = mkDeliver(async () => ({ ok: false, error: 'lark 500' }));
    const stats = await runDispatcherTick(now, exec);
    expect(stats.retried).toBe(1);
    const c = getCommand(cmdId)!;
    expect(c.deliveryStatus).toBe('pending');
    expect(c.retryCount).toBe(1);
    expect(c.lastError).toBe('lark 500');
    expect(new Date(c.nextRetryAt!).getTime()).toBe(now.getTime() + planBackoff(1)); // 退避算对
    expect(c.dispatchingUntil).toBeNull(); // lease 清，nextRetryAt 控制下次
  });

  it('连续失败到 MAX_RETRY → failed (可见、不静默丢)', async () => {
    const { cmdId } = await mkTaskWithCommand();
    const exec = mkDeliver(async () => ({ ok: false, error: 'down' }));
    let t = Date.now();
    // 每轮把时间推过 nextRetryAt，直到 failed
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

  it('未到 nextRetryAt → 本轮不投 (deliver 不被调用)', async () => {
    const { cmdId } = await mkTaskWithCommand();
    const now = new Date();
    const failExec = mkDeliver(async () => ({ ok: false, error: 'x' }));
    await runDispatcherTick(now, failExec); // → retry, nextRetryAt = now+30s
    const c = getCommand(cmdId)!;
    const exec2 = mkDeliver();
    await runDispatcherTick(new Date(now.getTime() + 1000), exec2); // 还没到 nextRetryAt
    expect(exec2.deliver).not.toHaveBeenCalled();
    expect(getCommand(cmdId)!.retryCount).toBe(c.retryCount); // 没变
  });

  it('child→parent 上报: task 已 finished → skip + supersede (陈旧 need_help 不再投父群)', async () => {
    const { cmdId, taskId } = await mkTaskWithCommand();
    await transitionStatus(taskId, 'finished');
    const exec = mkDeliver();
    const stats = await runDispatcherTick(new Date(), exec);
    expect(stats.skipped).toBe(1);
    expect(exec.deliver).not.toHaveBeenCalled();
    expect(getCommand(cmdId)!.supersededBy).not.toBeNull();
  });

  it('parent→child supplement + task 终态 → skip + supersede (补充无意义)', async () => {
    const { cmdId, taskId } = await mkTaskWithCommand({ direction: 'parent_to_child', commandType: 'supplement' });
    await transitionStatus(taskId, 'reported_done');
    await transitionStatus(taskId, 'finished');
    const exec = mkDeliver();
    const stats = await runDispatcherTick(new Date(), exec);
    expect(stats.skipped).toBe(1);
    expect(exec.deliver).not.toHaveBeenCalled();
    expect(getCommand(cmdId)!.supersededBy).not.toBeNull();
  });

  it('E2E 修复: parent→child finish + task 已 finished → 真 deliver (子群收到结束通知)', async () => {
    const { cmdId, taskId } = await mkTaskWithCommand({ direction: 'parent_to_child', commandType: 'finish' });
    await transitionStatus(taskId, 'reported_done');
    await transitionStatus(taskId, 'finished');
    const exec = mkDeliver(async () => ({ ok: true, messageId: 'om_finish' }));
    const stats = await runDispatcherTick(new Date(), exec);
    expect(stats.sent).toBe(1);                       // finish 没被终态 skip 掉
    expect(exec.deliver).toHaveBeenCalled();
    expect(getCommand(cmdId)!.deliveryStatus).toBe('sent');
    expect(getCommand(cmdId)!.deliveredMessageId).toBe('om_finish');
  });

  it('P1-2 TOCTOU: claim 后 task 被终态化 → 复核 skip + supersede + 不 deliver (supplement)', async () => {
    const { cmdId, taskId } = await mkTaskWithCommand({ direction: 'parent_to_child', commandType: 'supplement' });
    const real = getSubTask(taskId)!;
    // 初筛读到 observing(→send)，claim 后复核读到 finished(→skip)
    const spy = vi.spyOn(store, 'getSubTask')
      .mockReturnValueOnce(real)
      .mockReturnValueOnce({ ...real, status: 'finished' });
    const exec = mkDeliver();
    const stats = await runDispatcherTick(new Date(), exec);
    expect(exec.deliver).not.toHaveBeenCalled();   // 复核拦下，没投陈旧状态
    expect(stats.skipped).toBe(1);
    expect(getCommand(cmdId)!.supersededBy).not.toBeNull();
    expect(getCommand(cmdId)!.dispatchAttemptId).toBeNull(); // lease 已释放
    spy.mockRestore();
  });
});
