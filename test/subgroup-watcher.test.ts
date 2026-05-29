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

// kickoff mock executor (默认 no-op); 大部分 judge 测试要先把 kickoffSent 标 true
function execs(judge: any, escalate = (async () => {}) as any, kickoff = (async () => {}) as any) {
  return { sendKickoff: kickoff, judgeProgress: judge, escalateToClaude: escalate };
}

const REG = { taskType: 'bug' as const };   // registerWatch 必填 taskType

describe('subgroup-watch-store', () => {
  it('register → listActive → 1 watching', async () => {
    const { store } = await fresh();
    store.registerWatch({ chatId: 'oc_a', purpose: 'p', urgency: 'normal', ...REG });
    expect(store.listActiveWatches()).toHaveLength(1);
    expect(store.getWatch('oc_a')?.status).toBe('watching');
    expect(store.getWatch('oc_a')?.kickoffSent).toBe(false);
  });

  it('register 同 chatId 不重复', async () => {
    const { store } = await fresh();
    store.registerWatch({ chatId: 'oc_a', purpose: 'p', urgency: 'normal', ...REG });
    store.registerWatch({ chatId: 'oc_a', purpose: 'p2', urgency: 'urgent', ...REG });
    expect(store.listActiveWatches()).toHaveLength(1);
    expect(store.getWatch('oc_a')?.purpose).toBe('p');   // 保留首注册
  });

  it('stopWatch → 不再 active', async () => {
    const { store } = await fresh();
    store.registerWatch({ chatId: 'oc_a', purpose: 'p', urgency: 'normal', ...REG });
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

// 主体感知"在跟子群" (2026-05-29 松松)
describe('subgroup-watch-store aware list / close / prune', () => {
  const now = new Date('2026-05-29T10:00:00Z');

  it('listAwareWatches: watching + escalated_stuck + escalated_decision 都算在跟; done/closed 不算', async () => {
    const { store } = await fresh();
    store.registerWatch({ chatId: 'oc_w', purpose: 'watching', urgency: 'normal', ...REG });
    store.registerWatch({ chatId: 'oc_s', purpose: 'stuck', urgency: 'urgent', ...REG });
    store.registerWatch({ chatId: 'oc_d', purpose: 'decision', urgency: 'normal', ...REG });
    store.registerWatch({ chatId: 'oc_done', purpose: 'done', urgency: 'low', ...REG });
    store.stopWatch('oc_s', 'escalated_stuck', 'x');
    store.stopWatch('oc_d', 'escalated_decision', 'x');
    store.stopWatch('oc_done', 'escalated_done', 'x');
    const aware = store.listAwareWatches().map((w: any) => w.chatId).sort();
    expect(aware).toEqual(['oc_d', 'oc_s', 'oc_w']);   // done 不在
  });

  it('closeWatch → 移出在跟列表 + status=closed + 审计 by', async () => {
    const { store } = await fresh();
    store.registerWatch({ chatId: 'oc_a', purpose: 'p', urgency: 'normal', ...REG });
    store.stopWatch('oc_a', 'escalated_stuck', 'x');
    expect(store.listAwareWatches()).toHaveLength(1);   // stuck 还在跟
    store.closeWatch('oc_a', 'jason', '搞定了');
    expect(store.listAwareWatches()).toHaveLength(0);   // close 后移出
    expect(store.getWatch('oc_a')?.status).toBe('closed');
    expect(store.getWatch('oc_a')?.escalationReason).toContain('closed by jason');
  });

  it('pruneStale: escalated_done 超 24h 被清; 24h 内保留', async () => {
    const { store } = await fresh();
    store.registerWatch({ chatId: 'oc_old', purpose: 'old', urgency: 'normal', ...REG });
    store.registerWatch({ chatId: 'oc_fresh', purpose: 'fresh', urgency: 'normal', ...REG });
    store.stopWatch('oc_old', 'escalated_done', 'x');
    store.updateWatch('oc_old', { escalatedAt: '2026-05-27T00:00:00Z', lastCheckedAt: '2026-05-27T00:00:00Z' });  // 2天前
    store.stopWatch('oc_fresh', 'escalated_done', 'x');
    store.updateWatch('oc_fresh', { escalatedAt: now.toISOString(), lastCheckedAt: now.toISOString() });
    const removed = store.pruneStale(now);
    expect(removed).toBe(1);
    expect(store.getWatch('oc_old')).toBeNull();        // 老 done 清掉
    expect(store.getWatch('oc_fresh')).not.toBeNull();  // 新 done 保留
  });

  it('pruneStale: 任何状态超 7d 没动 → 清 (死群兜底)', async () => {
    const { store } = await fresh();
    store.registerWatch({ chatId: 'oc_dead', purpose: 'dead', urgency: 'normal', ...REG });
    store.updateWatch('oc_dead', { lastCheckedAt: '2026-05-20T00:00:00Z' });  // 9天前, 仍 watching
    expect(store.pruneStale(now)).toBe(1);
    expect(store.getWatch('oc_dead')).toBeNull();
  });

  it('buildActiveSubtasksBlock: 空 → 提示无在跟', async () => {
    const { store } = await fresh();
    expect(store.buildActiveSubtasksBlock({ now })).toContain('当前没有分身在跟');
  });

  it('buildActiveSubtasksBlock: stuck/decision 排在 watching 前 + 含 chatId + 计数', async () => {
    const { store } = await fresh();
    store.registerWatch({ chatId: 'oc_w', purpose: '进行中任务', urgency: 'normal', ...REG });
    store.updateWatch('oc_w', { lastCheckedAt: now.toISOString() });
    store.registerWatch({ chatId: 'oc_s', purpose: '卡住任务', urgency: 'urgent', ...REG });
    store.stopWatch('oc_s', 'escalated_stuck', 'x');
    store.updateWatch('oc_s', { lastCheckedAt: now.toISOString() });
    const block = store.buildActiveSubtasksBlock({ now });
    expect(block).toContain('共 2 个在跟');
    expect(block).toContain('oc_s');
    expect(block).toContain('oc_w');
    expect(block).toContain('卡住任务');
    // stuck 排在 watching 前
    expect(block.indexOf('卡住任务')).toBeLessThan(block.indexOf('进行中任务'));
  });

  it('buildActiveSubtasksBlock: 超 cap 显示 +N', async () => {
    const { store } = await fresh();
    for (let i = 0; i < 12; i++) store.registerWatch({ chatId: `oc_${i}`, purpose: `t${i}`, urgency: 'normal', ...REG });
    const block = store.buildActiveSubtasksBlock({ now, cap: 10 });
    expect(block).toContain('共 12 个在跟');
    expect(block).toContain('另 2 个');
  });
});

describe('runWatchTick', () => {
  // judge 测试前把 kickoff 标已发, 否则首 tick 只发 kickoff 不 judge
  function regJudgeReady(store: any, chatId = 'oc_a', urgency = 'normal') {
    store.registerWatch({ chatId, purpose: 'p', urgency, ...REG });
    store.updateWatch(chatId, { kickoffSent: true });
  }

  it('kickoff 未发 → 首 tick 发 kickoff, 不 judge, 标 kickoffSent', async () => {
    const { store, watcher } = await fresh();
    store.registerWatch({ chatId: 'oc_a', purpose: 'p', urgency: 'normal', ...REG });
    const kickoff = vi.fn(async () => {});
    const judge = vi.fn(mkJudge('in_progress', true));
    const stats = await watcher.runWatchTick({ now, executors: execs(judge, undefined, kickoff) });
    expect(stats.kickoffsSent).toBe(1);
    expect(kickoff).toHaveBeenCalledTimes(1);
    expect(judge).not.toHaveBeenCalled();             // 本轮不 judge
    expect(store.getWatch('oc_a')?.kickoffSent).toBe(true);
    expect(store.getWatch('oc_a')?.status).toBe('watching');
  });

  it('未到间隔 → skip', async () => {
    const { store, watcher } = await fresh();
    regJudgeReady(store);
    store.updateWatch('oc_a', { lastCheckedAt: now.toISOString() });
    const judge = vi.fn(mkJudge('in_progress', true));
    const stats = await watcher.runWatchTick({ now: new Date(now.getTime() + 60_000), executors: execs(judge) });
    expect(stats.skippedNotDue).toBe(1);
    expect(judge).not.toHaveBeenCalled();
  });

  it('kickoff 已发 + due → judge in_progress → 继续盯', async () => {
    const { store, watcher } = await fresh();
    regJudgeReady(store);
    const esc = vi.fn();
    const stats = await watcher.runWatchTick({ now, executors: execs(mkJudge('in_progress', true), esc) });
    expect(stats.inProgress).toBe(1);
    expect(esc).not.toHaveBeenCalled();
    expect(store.getWatch('oc_a')?.lastSeenMessageId).toBe('om_last');
  });

  it('judge done → 升级"完成" + stopWatch', async () => {
    const { store, watcher } = await fresh();
    regJudgeReady(store);
    const esc = vi.fn();
    const stats = await watcher.runWatchTick({ now, executors: execs(mkJudge('done', true, '验收通过'), esc) });
    expect(stats.escalatedDone).toBe(1);
    expect(esc).toHaveBeenCalledTimes(1);
    expect(store.getWatch('oc_a')?.status).toBe('escalated_done');
    expect(store.listActiveWatches()).toHaveLength(0);
  });

  it('judge need_owner → 升级"需决策" + stopWatch', async () => {
    const { store, watcher } = await fresh();
    regJudgeReady(store);
    const stats = await watcher.runWatchTick({ now, executors: execs(mkJudge('need_owner', true, '要松松拍'), vi.fn()) });
    expect(stats.escalatedDecision).toBe(1);
    expect(store.getWatch('oc_a')?.status).toBe('escalated_decision');
  });

  it('judge stuck → 立刻升级"卡死"', async () => {
    const { store, watcher } = await fresh();
    regJudgeReady(store);
    const stats = await watcher.runWatchTick({ now, executors: execs(mkJudge('stuck', false, '分身明说卡住'), vi.fn()) });
    expect(stats.escalatedStuck).toBe(1);
    expect(store.getWatch('oc_a')?.status).toBe('escalated_stuck');
  });

  it('连续无进展到阈值 (normal=3) → 升级卡死', async () => {
    const { store, watcher } = await fresh();
    regJudgeReady(store);
    store.updateWatch('oc_a', { noProgressCount: 2, lastCheckedAt: '2026-05-29T00:00:00Z' });
    const esc = vi.fn();
    const stats = await watcher.runWatchTick({ now, executors: execs(mkJudge('in_progress', false), esc) });
    expect(stats.escalatedStuck).toBe(1);
    expect(esc.mock.calls[0][1].state).toBe('stuck');
  });

  it('有新消息 → noProgress 计数重置', async () => {
    const { store, watcher } = await fresh();
    regJudgeReady(store);
    store.updateWatch('oc_a', { noProgressCount: 2, lastCheckedAt: '2026-05-29T00:00:00Z' });
    await watcher.runWatchTick({ now, executors: execs(mkJudge('in_progress', true)) });
    expect(store.getWatch('oc_a')?.noProgressCount).toBe(0);
  });

  it('judge throw → 记 error, 更新 lastCheckedAt 不卡死循环', async () => {
    const { store, watcher } = await fresh();
    regJudgeReady(store);
    const judge = vi.fn().mockRejectedValue(new Error('coco down'));
    const stats = await watcher.runWatchTick({ now, executors: execs(judge) });
    expect(stats.errors).toBe(1);
    expect(store.getWatch('oc_a')?.lastCheckedAt).toBeTruthy();
    expect(store.getWatch('oc_a')?.status).toBe('watching');
  });

  it('urgent 阈值 2: 连续 2 次无进展就卡死 (比 normal 早)', async () => {
    const { store, watcher } = await fresh();
    regJudgeReady(store, 'oc_u', 'urgent');
    store.updateWatch('oc_u', { noProgressCount: 1, lastCheckedAt: '2026-05-29T00:00:00Z' });
    const stats = await watcher.runWatchTick({ now, executors: execs(mkJudge('in_progress', false)) });
    expect(stats.escalatedStuck).toBe(1);
  });
});
