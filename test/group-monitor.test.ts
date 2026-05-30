/**
 * Unit tests for group-monitor (store + 决策逻辑 tick + poll-fallback)。
 *
 * Run: pnpm vitest run test/group-monitor.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;
vi.mock('../src/config.js', () => ({
  config: { get session() { return { dataDir: tempDir }; } },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), isDebug: () => false },
}));

import {
  registerMonitor, listMonitors, getMonitor, updateMonitor, removeMonitor,
  addReport, listPendingReports, markReportConsumed, bumpReportPoke, pruneReports,
  __resetForTesting,
} from '../src/services/group-monitor-store.js';
import { runMonitorTick, runReportPollFallback, MIN_JUDGE_INTERVAL_MS, type MonitorExecutors } from '../src/services/group-monitor.js';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'gm-test-'));
  __resetForTesting();
});

// ─── store ────────────────────────────────────────────────────────────────

describe('group-monitor-store', () => {
  it('register / list / get / update / remove', () => {
    registerMonitor({ chatId: 'oc_a', goal: '盯 CI 挂没挂' });
    expect(listMonitors()).toHaveLength(1);
    expect(getMonitor('oc_a')?.goal).toBe('盯 CI 挂没挂');

    // re-register 更新 goal + 重新 enable
    updateMonitor('oc_a', { enabled: false });
    registerMonitor({ chatId: 'oc_a', goal: '新目标' });
    expect(getMonitor('oc_a')?.goal).toBe('新目标');
    expect(getMonitor('oc_a')?.enabled).toBe(true);

    registerMonitor({ chatId: 'oc_b', goal: 'x' });
    updateMonitor('oc_b', { enabled: false });
    expect(listMonitors({ enabledOnly: true }).map(m => m.chatId)).toEqual(['oc_a']);

    expect(removeMonitor('oc_a')).toBe(true);
    expect(getMonitor('oc_a')).toBeNull();
  });

  it('report add / pending / consume / poke / prune', () => {
    const r = addReport({ chatId: 'oc_a', goal: 'g', summary: 's', evidence: 'e' });
    expect(listPendingReports()).toHaveLength(1);

    bumpReportPoke(r.id);
    expect(listPendingReports()[0].pokeCount).toBe(1); // 消费前还在 pending, 可查

    markReportConsumed(r.id);
    expect(listPendingReports()).toHaveLength(0);

    // 已消费但未超 24h → 仍在
    expect(pruneReports(new Date(Date.now() + 60_000))).toBe(0);
    // 已消费且超 24h → 清掉
    expect(pruneReports(new Date(Date.now() + 25 * 3600_000))).toBe(1);
  });

  it('removeMonitor 连带删除其报告', () => {
    registerMonitor({ chatId: 'oc_a', goal: 'g' });
    addReport({ chatId: 'oc_a', goal: 'g', summary: 's', evidence: 'e' });
    expect(listPendingReports()).toHaveLength(1);
    removeMonitor('oc_a');
    expect(listPendingReports()).toHaveLength(0);
  });
});

// ─── 决策逻辑 runMonitorTick ────────────────────────────────────────────────

function mockExec(over: Partial<MonitorExecutors> = {}): MonitorExecutors & {
  fetchMessages: ReturnType<typeof vi.fn>; judge: ReturnType<typeof vi.fn>; wakeClaude: ReturnType<typeof vi.fn>;
} {
  return {
    fetchMessages: vi.fn(async () => [{ id: 'm2', rendered: '新消息2' }, { id: 'm1', rendered: '旧消息1' }]),
    judge: vi.fn(async () => ({ report: false, summary: '', evidence: '' })),
    wakeClaude: vi.fn(async () => true),
    ...over,
  } as any;
}

describe('runMonitorTick', () => {
  it('命中 → 写报告 + 唤醒克劳德 + 推进高水位', async () => {
    registerMonitor({ chatId: 'oc_a', goal: 'g' });
    const exec = mockExec({ judge: vi.fn(async () => ({ report: true, summary: '出事了', evidence: 'm2' })) });
    const now = new Date('2026-05-30T10:00:00Z');
    await runMonitorTick(now, exec);

    expect(exec.judge).toHaveBeenCalledOnce();
    expect(exec.wakeClaude).toHaveBeenCalledOnce();
    const reps = listPendingReports();
    expect(reps).toHaveLength(1);
    expect(reps[0].summary).toBe('出事了');
    expect(reps[0].pokeCount).toBe(1);
    // 高水位推进到最新 m2
    expect(getMonitor('oc_a')?.lastSeenMessageId).toBe('m2');
    expect(getMonitor('oc_a')?.lastJudgedAt).toBe(now.toISOString());
  });

  it('negative 判断 → 不写报告不唤醒, 但仍推进高水位', async () => {
    registerMonitor({ chatId: 'oc_a', goal: 'g' });
    const exec = mockExec(); // judge 默认 report:false
    await runMonitorTick(new Date(), exec);
    expect(exec.judge).toHaveBeenCalledOnce();
    expect(exec.wakeClaude).not.toHaveBeenCalled();
    expect(listPendingReports()).toHaveLength(0);
    expect(getMonitor('oc_a')?.lastSeenMessageId).toBe('m2');
  });

  it('节流: 距上次判断不到 MIN_JUDGE_INTERVAL → 跳过, 不调 judge', async () => {
    registerMonitor({ chatId: 'oc_a', goal: 'g' });
    const now = new Date('2026-05-30T10:00:00Z');
    updateMonitor('oc_a', { lastJudgedAt: new Date(now.getTime() - (MIN_JUDGE_INTERVAL_MS - 1000)).toISOString() });
    const exec = mockExec();
    await runMonitorTick(now, exec);
    expect(exec.judge).not.toHaveBeenCalled();
    expect(exec.fetchMessages).not.toHaveBeenCalled();
  });

  it('没新消息 (newest == lastSeen) → 跳过, 不调 judge', async () => {
    registerMonitor({ chatId: 'oc_a', goal: 'g' });
    updateMonitor('oc_a', { lastSeenMessageId: 'm2' }); // 最新已经是 m2
    const exec = mockExec();
    await runMonitorTick(new Date(), exec);
    expect(exec.fetchMessages).toHaveBeenCalledOnce();
    expect(exec.judge).not.toHaveBeenCalled();
  });

  it('高水位: 只把"上次见过之后"的新消息喂给 judge', async () => {
    registerMonitor({ chatId: 'oc_a', goal: 'g' });
    updateMonitor('oc_a', { lastSeenMessageId: 'm1' }); // m1 见过, m2 是新的
    const exec = mockExec({ judge: vi.fn(async () => ({ report: false, summary: '', evidence: '' })) });
    await runMonitorTick(new Date(), exec);
    expect(exec.judge).toHaveBeenCalledOnce();
    // 只含新消息 m2, 不含已见的 m1
    const rendered = exec.judge.mock.calls[0][1] as string;
    expect(rendered).toContain('新消息2');
    expect(rendered).not.toContain('旧消息1');
  });

  it('disabled 监控不跑', async () => {
    registerMonitor({ chatId: 'oc_a', goal: 'g' });
    updateMonitor('oc_a', { enabled: false });
    const exec = mockExec();
    await runMonitorTick(new Date(), exec);
    expect(exec.fetchMessages).not.toHaveBeenCalled();
  });
});

// ─── poll-fallback ──────────────────────────────────────────────────────────

describe('runReportPollFallback', () => {
  it('未消费 + 距上次戳够久 + 未到上限 → 补戳', async () => {
    const r = addReport({ chatId: 'oc_a', goal: 'g', summary: 's', evidence: 'e' });
    bumpReportPoke(r.id); // pokeCount=1, lastPokedAt=now
    const exec = mockExec();
    // 11 分钟后
    const later = new Date(Date.now() + 11 * 60_000);
    const n = await runReportPollFallback(later, exec);
    expect(n).toBe(1);
    expect(exec.wakeClaude).toHaveBeenCalledOnce();
  });

  it('刚戳过 → 不补戳', async () => {
    const r = addReport({ chatId: 'oc_a', goal: 'g', summary: 's', evidence: 'e' });
    bumpReportPoke(r.id);
    const exec = mockExec();
    const n = await runReportPollFallback(new Date(Date.now() + 60_000), exec); // 1min
    expect(n).toBe(0);
    expect(exec.wakeClaude).not.toHaveBeenCalled();
  });

  it('已消费 → 不补戳', async () => {
    const r = addReport({ chatId: 'oc_a', goal: 'g', summary: 's', evidence: 'e' });
    markReportConsumed(r.id);
    const exec = mockExec();
    const n = await runReportPollFallback(new Date(Date.now() + 11 * 60_000), exec);
    expect(n).toBe(0);
  });

  it('达到最大补戳次数 → 不再戳', async () => {
    const r = addReport({ chatId: 'oc_a', goal: 'g', summary: 's', evidence: 'e' });
    bumpReportPoke(r.id); bumpReportPoke(r.id); bumpReportPoke(r.id); // pokeCount=3 = MAX
    const exec = mockExec();
    const n = await runReportPollFallback(new Date(Date.now() + 30 * 60_000), exec);
    expect(n).toBe(0);
  });
});
