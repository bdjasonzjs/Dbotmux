/**
 * 子群任务流程 P2 (2026-05-29): watch store + watcher loop 单测.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: { get session() { return { dataDir: tempDir }; } },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

async function fresh() {
  vi.resetModules();
  return {
    store: await import('../src/services/subgroup-watch-store.js'),
    watcher: await import('../src/services/subgroup-watcher.js'),
  };
}

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'subgroup-watch-')); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

const now = new Date('2026-05-29T10:00:00Z');

function mkJudge(state: string, hasNew: boolean, reason = 'r', lastId: string | null = 'om_last') {
  return async () => ({ state, reason, hasNewMessages: hasNew, lastMessageId: lastId } as any);
}

describe('subgroup-watch-store', () => {
  it('register → listActive → 1 watching', async () => {
    const { store } = await fresh();
    store.registerWatch({ chatId: 'oc_a', purpose: 'p', urgency: 'normal' });
    expect(store.listActiveWatches()).toHaveLength(1);
    expect(store.getWatch('oc_a')?.status).toBe('watching');
  });

  it('register 同 chatId 不重复', async () => {
    const { store } = await fresh();
    store.registerWatch({ chatId: 'oc_a', purpose: 'p', urgency: 'normal' });
    store.registerWatch({ chatId: 'oc_a', purpose: 'p2', urgency: 'urgent' });
    expect(store.listActiveWatches()).toHaveLength(1);
    expect(store.getWatch('oc_a')?.purpose).toBe('p');   // 保留首注册
  });

  it('stopWatch → 不再 active', async () => {
    const { store } = await fresh();
    store.registerWatch({ chatId: 'oc_a', purpose: 'p', urgency: 'normal' });
    store.stopWatch('oc_a', 'escalated_done', '完成了');
    expect(store.listActiveWatches()).toHaveLength(0);
    expect(store.getWatch('oc_a')?.status).toBe('escalated_done');
  });

  it('损坏文件 → listActive 返空不抛', async () => {
    const { store } = await fresh();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(tempDir, 'subgroup-watches.json'), '{bad', 'utf-8');
    expect(store.listActiveWatches()).toEqual([]);
  });
});

describe('runWatchTick', () => {
  it('未到间隔 → skip (lastCheckedAt 刚刚)', async () => {
    const { store, watcher } = await fresh();
    store.registerWatch({ chatId: 'oc_a', purpose: 'p', urgency: 'normal' });
    store.updateWatch('oc_a', { lastCheckedAt: now.toISOString() });   // 刚扫过
    const judge = vi.fn(mkJudge('in_progress', true));
    const stats = await watcher.runWatchTick({ now: new Date(now.getTime() + 60_000), executors: { judgeProgress: judge, escalateToClaude: vi.fn() } });
    expect(stats.skippedNotDue).toBe(1);
    expect(stats.checked).toBe(0);
    expect(judge).not.toHaveBeenCalled();
  });

  it('从没扫过 → 立刻 due → judge in_progress → 继续盯', async () => {
    const { store, watcher } = await fresh();
    store.registerWatch({ chatId: 'oc_a', purpose: 'p', urgency: 'normal' });
    const esc = vi.fn();
    const stats = await watcher.runWatchTick({ now, executors: { judgeProgress: mkJudge('in_progress', true), escalateToClaude: esc } });
    expect(stats.inProgress).toBe(1);
    expect(esc).not.toHaveBeenCalled();
    const w = store.getWatch('oc_a')!;
    expect(w.status).toBe('watching');
    expect(w.lastCheckedAt).toBeTruthy();
    expect(w.lastSeenMessageId).toBe('om_last');
  });

  it('judge done → 升级"完成" + stopWatch', async () => {
    const { store, watcher } = await fresh();
    store.registerWatch({ chatId: 'oc_a', purpose: 'p', urgency: 'normal' });
    const esc = vi.fn();
    const stats = await watcher.runWatchTick({ now, executors: { judgeProgress: mkJudge('done', true, '验收通过'), escalateToClaude: esc } });
    expect(stats.escalatedDone).toBe(1);
    expect(esc).toHaveBeenCalledTimes(1);
    expect(store.getWatch('oc_a')?.status).toBe('escalated_done');
    expect(store.listActiveWatches()).toHaveLength(0);
  });

  it('judge need_owner → 升级"需决策" + stopWatch', async () => {
    const { store, watcher } = await fresh();
    store.registerWatch({ chatId: 'oc_a', purpose: 'p', urgency: 'normal' });
    const esc = vi.fn();
    const stats = await watcher.runWatchTick({ now, executors: { judgeProgress: mkJudge('need_owner', true, '要松松拍'), escalateToClaude: esc } });
    expect(stats.escalatedDecision).toBe(1);
    expect(store.getWatch('oc_a')?.status).toBe('escalated_decision');
  });

  it('judge stuck → 立刻升级"卡死"', async () => {
    const { store, watcher } = await fresh();
    store.registerWatch({ chatId: 'oc_a', purpose: 'p', urgency: 'normal' });
    const esc = vi.fn();
    const stats = await watcher.runWatchTick({ now, executors: { judgeProgress: mkJudge('stuck', false, '分身明说卡住'), escalateToClaude: esc } });
    expect(stats.escalatedStuck).toBe(1);
    expect(store.getWatch('oc_a')?.status).toBe('escalated_stuck');
  });

  it('连续无进展到阈值 (normal=3) → 升级卡死', async () => {
    const { store, watcher } = await fresh();
    store.registerWatch({ chatId: 'oc_a', purpose: 'p', urgency: 'normal' });
    // 模拟已经连续 2 次无进展 + lastChecked 很久以前
    store.updateWatch('oc_a', { noProgressCount: 2, lastCheckedAt: '2026-05-29T00:00:00Z' });
    // 第 3 次还是无新消息 (in_progress 但 hasNew=false) → nextNoProgress=3 ≥ 阈值 → 卡死
    const esc = vi.fn();
    const stats = await watcher.runWatchTick({ now, executors: { judgeProgress: mkJudge('in_progress', false), escalateToClaude: esc } });
    expect(stats.escalatedStuck).toBe(1);
    expect(store.getWatch('oc_a')?.status).toBe('escalated_stuck');
    expect(esc.mock.calls[0][1].state).toBe('stuck');   // 升级时 state 强制 stuck
  });

  it('有新消息 → noProgress 计数重置', async () => {
    const { store, watcher } = await fresh();
    store.registerWatch({ chatId: 'oc_a', purpose: 'p', urgency: 'normal' });
    store.updateWatch('oc_a', { noProgressCount: 2, lastCheckedAt: '2026-05-29T00:00:00Z' });
    await watcher.runWatchTick({ now, executors: { judgeProgress: mkJudge('in_progress', true), escalateToClaude: vi.fn() } });
    expect(store.getWatch('oc_a')?.noProgressCount).toBe(0);   // 有新消息重置
  });

  it('judge throw → 记 error, 更新 lastCheckedAt 不卡死循环', async () => {
    const { store, watcher } = await fresh();
    store.registerWatch({ chatId: 'oc_a', purpose: 'p', urgency: 'normal' });
    const judge = vi.fn().mockRejectedValue(new Error('coco down'));
    const stats = await watcher.runWatchTick({ now, executors: { judgeProgress: judge, escalateToClaude: vi.fn() } });
    expect(stats.errors).toBe(1);
    expect(store.getWatch('oc_a')?.lastCheckedAt).toBeTruthy();
    expect(store.getWatch('oc_a')?.status).toBe('watching');   // 还在盯, 下轮重判
  });

  it('urgent 阈值 2: 连续 2 次无进展就卡死 (比 normal 早)', async () => {
    const { store, watcher } = await fresh();
    store.registerWatch({ chatId: 'oc_u', purpose: 'p', urgency: 'urgent' });
    store.updateWatch('oc_u', { noProgressCount: 1, lastCheckedAt: '2026-05-29T00:00:00Z' });
    const stats = await watcher.runWatchTick({ now, executors: { judgeProgress: mkJudge('in_progress', false), escalateToClaude: vi.fn() } });
    expect(stats.escalatedStuck).toBe(1);   // urgent 阈值 2, nextNoProgress=2 命中
  });
});
