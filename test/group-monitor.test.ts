/**
 * group-monitor 一期改造单测：底座 monitors 注册表 + tick 决策逻辑。
 * 命中后改写 watch-inbox incident（旧 addReport/wakeClaude/poll-fallback 已退场）。
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
  __resetForTesting,
} from '../src/services/group-monitor-store.js';
import { runMonitorTick, MIN_JUDGE_INTERVAL_MS, normalizeSlug, type MonitorExecutors } from '../src/services/group-monitor.js';
import { setPolicy, __clearForTesting as clearPolicies } from '../src/services/chat-policy-store.js';
import { listOpen, __clearForTesting as clearInbox } from '../src/services/watch-inbox-store.js';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'gm-test-'));
  __resetForTesting();
  clearPolicies();
  clearInbox();
});

// ─── store（registry，report 部分已在 call-site 退场，不再测） ─────────────────

describe('group-monitor-store registry', () => {
  it('register / list / get / update / remove', () => {
    registerMonitor({ chatId: 'oc_a', goal: '盯 CI 挂没挂' });
    expect(listMonitors()).toHaveLength(1);
    expect(getMonitor('oc_a')?.goal).toBe('盯 CI 挂没挂');

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
});

describe('normalizeSlug', () => {
  it('去标点空白小写、同卡点换说法落同 slug', () => {
    expect(normalizeSlug('构建挂了！')).toBe(normalizeSlug('构建挂了'));
    expect(normalizeSlug('  Build  Broken . ')).toBe('buildbroken');
  });
});

// ─── 决策逻辑 runMonitorTick（命中→incident） ────────────────────────────────

function mockExec(over: Partial<MonitorExecutors> = {}): MonitorExecutors & {
  fetchMessages: ReturnType<typeof vi.fn>; judge: ReturnType<typeof vi.fn>;
} {
  return {
    fetchMessages: vi.fn(async () => [{ id: 'm2', rendered: '新消息2' }, { id: 'm1', rendered: '旧消息1' }]),
    judge: vi.fn(async () => ({ report: false, summary: '', evidence: '' })),
    ...over,
  } as any;
}

describe('runMonitorTick', () => {
  it('命中 + 配了汇报目标 → 写 watch-inbox incident(digest_item) + 推进高水位', async () => {
    registerMonitor({ chatId: 'oc_a', goal: 'g' });
    setPolicy('oc_a', { reportTargetChatId: 'oc_target' });
    const exec = mockExec({ judge: vi.fn(async () => ({ report: true, summary: '出事了', evidence: 'm2' })) });
    const now = new Date('2026-05-30T10:00:00Z');
    await runMonitorTick(now, exec);

    expect(exec.judge).toHaveBeenCalledOnce();
    const open = listOpen();
    expect(open).toHaveLength(1);
    expect(open[0].watchedChatId).toBe('oc_a');
    expect(open[0].targetChatId).toBe('oc_target');
    expect(open[0].summary).toBe('出事了');
    expect(open[0].kind).toBe('digest_item');
    expect(open[0].sourceMessageIds).toContain('m2');
    // 高水位 + 节流时间推进
    expect(getMonitor('oc_a')?.lastSeenMessageId).toBe('m2');
    expect(getMonitor('oc_a')?.lastJudgedAt).toBe(now.toISOString());
  });

  it('命中但 report=off（没配汇报目标）→ 只盯不报、不建 incident，但仍推进高水位', async () => {
    registerMonitor({ chatId: 'oc_a', goal: 'g' });
    const exec = mockExec({ judge: vi.fn(async () => ({ report: true, summary: 'x', evidence: 'e' })) });
    await runMonitorTick(new Date(), exec);
    expect(listOpen()).toHaveLength(0);
    expect(getMonitor('oc_a')?.lastSeenMessageId).toBe('m2');
  });

  it('同一卡点(同 slug)再命中 → upsert 同一 incident 不新建', async () => {
    registerMonitor({ chatId: 'oc_a', goal: 'g' });
    setPolicy('oc_a', { reportTargetChatId: 'oc_target' });
    const exec1 = mockExec({ judge: vi.fn(async () => ({ report: true, summary: '构建挂了', evidence: 'e' })) });
    await runMonitorTick(new Date('2026-05-30T10:00:00Z'), exec1);
    // 第二轮：新消息 + 同一卡点（归一化后同 slug：标点抖动不算新事）
    const exec2 = mockExec({
      fetchMessages: vi.fn(async () => [{ id: 'm3', rendered: '又一条' }, { id: 'm2', rendered: '新消息2' }]),
      judge: vi.fn(async () => ({ report: true, summary: '构建挂了！', evidence: 'e2' })),
    });
    await runMonitorTick(new Date('2026-05-30T10:30:00Z'), exec2);
    const open = listOpen();
    expect(open).toHaveLength(1); // 同 fingerprint → 没新建
    expect(open[0].status).toBe('updated');
    expect(open[0].sourceMessageIds).toContain('m3'); // 新证据并入
  });

  it('negative 判断 → 不建 incident, 但仍推进高水位', async () => {
    registerMonitor({ chatId: 'oc_a', goal: 'g' });
    setPolicy('oc_a', { reportTargetChatId: 'oc_target' });
    const exec = mockExec();
    await runMonitorTick(new Date(), exec);
    expect(exec.judge).toHaveBeenCalledOnce();
    expect(listOpen()).toHaveLength(0);
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
    updateMonitor('oc_a', { lastSeenMessageId: 'm2' });
    const exec = mockExec();
    await runMonitorTick(new Date(), exec);
    expect(exec.fetchMessages).toHaveBeenCalledOnce();
    expect(exec.judge).not.toHaveBeenCalled();
  });

  it('高水位: 只把"上次见过之后"的新消息喂给 judge', async () => {
    registerMonitor({ chatId: 'oc_a', goal: 'g' });
    updateMonitor('oc_a', { lastSeenMessageId: 'm1' });
    const exec = mockExec({ judge: vi.fn(async () => ({ report: false, summary: '', evidence: '' })) });
    await runMonitorTick(new Date(), exec);
    expect(exec.judge).toHaveBeenCalledOnce();
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
