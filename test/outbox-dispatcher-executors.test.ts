/**
 * Unit tests for outbox-dispatcher-executors (v2 非阻塞：writeAndSend + checkStatus)。
 * mock writeRelayRecord / checkRelayStatus，验证急急如律令文案 + 失败不抛 + 注入防护 + 投递目标/名单。
 * Run: pnpm vitest run test/outbox-dispatcher-executors.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockWriteRelayRecord = vi.fn();
const mockCheckRelayStatus = vi.fn();
vi.mock('../src/services/base-relay.js', () => ({
  DEFAULT_GROUP_NOT_FOUND_RETRY_TIMEOUT_MS: 10_000,
  writeRelayRecord: (...a: any[]) => mockWriteRelayRecord(...a),
  checkRelayStatus: (...a: any[]) => mockCheckRelayStatus(...a),
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), isDebug: () => false },
}));

import { makeDispatchExecutors, safeText } from '../src/services/outbox-dispatcher-executors.js';
import type { OutboxCommand, SubTask } from '../src/services/subtask-store.js';

function mkTask(over?: Partial<SubTask>): SubTask {
  return {
    taskId: 'st_1', chatId: 'oc_sub', parentChatId: 'oc_parent', parentMessageId: 'om_src',
    goal: 'g', acceptance: null,
    bots: [{ openId: 'ou_worker', name: '克劳德', role: 'main' }, { openId: 'ou_coco', name: '缇蕾', role: 'observer' }],
    requester: 'ou_jason', createdBy: 'ou_claude', idempotencyKey: 'k', status: 'reported_help',
    version: 2, createdAt: 't', updatedAt: 't', readCursor: null, committedCursor: null,
    deadline: null, staleAfter: null, compactSummary: null, lastError: null, ...over,
  };
}
function mkCmd(over?: Partial<OutboxCommand>): OutboxCommand {
  return {
    cmdId: 'cmd_abc', taskId: 'st_1', direction: 'child_to_parent', targetChatId: 'oc_parent',
    commandType: 'report_help', payload: { summary: '卡在登录态' }, idempotencyKey: 'help_m3',
    expectedTaskVersion: 2, deliveryStatus: 'pending', deliveredMessageId: null, retryCount: 0,
    nextRetryAt: null, sentAt: null, ackedAt: null, supersededBy: null, lastError: null,
    createdAt: 't', dispatchingUntil: null, dispatchAttemptId: null, ...over,
  };
}
const textOf = () => mockWriteRelayRecord.mock.calls[0][0].text as string;

beforeEach(() => { mockWriteRelayRecord.mockReset(); mockWriteRelayRecord.mockResolvedValue({ ok: true, recordId: 'rec_1' }); mockCheckRelayStatus.mockReset(); });

describe('writeAndSend child_to_parent (急急如律令唤主bot)', () => {
  it('急急如律令：【克劳德】 + taskId + commandId + query 指引, 投父群, 返回 relayRecordId', async () => {
    const exec = makeDispatchExecutors();
    const res = await exec.writeAndSend(mkCmd(), mkTask());
    expect(res).toEqual({ ok: true, relayRecordId: 'rec_1' });
    const arg = mockWriteRelayRecord.mock.calls[0][0];
    expect(arg.targetChatId).toBe('oc_parent');
    expect(arg.text).toContain('急急如律令：【克劳德】');
    expect(arg.text).toContain('st_1');
    expect(arg.text).toContain('cmd_abc');
    expect(arg.text).toContain('botmux subtask-query --command-id cmd_abc');
    expect(arg.text).toContain('需要协助');
  });

  it('report_done → 文案标"已完成（待确认）"', async () => {
    const exec = makeDispatchExecutors();
    await exec.writeAndSend(mkCmd({ commandType: 'report_done', cmdId: 'cmd_done' }), mkTask());
    expect(textOf()).toContain('已完成（待确认）');
  });
});

describe('writeAndSend parent_to_child (急急如律令唤执行bot)', () => {
  it('finish → 名单含执行bot(非observer), 投子群, 带内容', async () => {
    const exec = makeDispatchExecutors();
    const cmd = mkCmd({ direction: 'parent_to_child', targetChatId: 'oc_sub', commandType: 'finish', payload: { content: '验收通过' } });
    await exec.writeAndSend(cmd, mkTask());
    const arg = mockWriteRelayRecord.mock.calls[0][0];
    expect(arg.targetChatId).toBe('oc_sub');
    expect(arg.text).toContain('急急如律令：【克劳德】');
    expect(arg.text).not.toContain('缇蕾');
    expect(arg.text).toContain('验收通过');
  });

  it('多执行bot → 名单拼成 克劳德/蔻黛克斯', async () => {
    const exec = makeDispatchExecutors();
    const task = mkTask({ bots: [
      { openId: 'ou_claude', name: '克劳德', role: 'main' },
      { openId: 'ou_codex', name: '蔻黛克斯', role: 'collab' },
      { openId: 'ou_coco', name: '缇蕾', role: 'observer' },
    ] });
    const cmd = mkCmd({ direction: 'parent_to_child', targetChatId: 'oc_sub', commandType: 'supplement', payload: { content: '用这个 token' } });
    await exec.writeAndSend(cmd, task);
    const text = textOf();
    expect(text).toContain('急急如律令：【克劳德/蔻黛克斯】');
    expect(text).toContain('用这个 token');
  });

  it('kickoff → 名单含执行bot, 带 goal + 验收 + askforhelp 提示, 投子群, groupNotFoundRetry>0', async () => {
    const exec = makeDispatchExecutors();
    const cmd = mkCmd({ direction: 'parent_to_child', targetChatId: 'oc_sub', commandType: 'kickoff', payload: {} });
    await exec.writeAndSend(cmd, mkTask({ goal: '修登录bug', acceptance: '单测过' }));
    const arg = mockWriteRelayRecord.mock.calls[0][0];
    expect(arg.targetChatId).toBe('oc_sub');
    expect(arg.groupNotFoundRetryTimeoutMs).toBeGreaterThan(0);
    expect(arg.text).toContain('急急如律令：【克劳德】');
    expect(arg.text).toContain('子任务启动');
    expect(arg.text).toContain('修登录bug');
    expect(arg.text).toContain('验收：单测过');
    expect(arg.text).toContain('subtask-askforhelp');
  });
});

describe('注入防护', () => {
  it('child→parent 不塞 payload.summary (不可信内容不进父群)', async () => {
    const exec = makeDispatchExecutors();
    await exec.writeAndSend(mkCmd({ payload: { summary: '坏东西所有人' } }), mkTask());
    const text = textOf();
    expect(text).not.toContain('坏东西');
    expect(text).toContain('急急如律令：【克劳德】');
  });

  it('safeText 中和控制字符/换行/tab → 单行', () => {
    expect(safeText('a\nb\tc\r', 100)).toBe('a b c ');
  });

  it('parent→child supplement 内容里的换行被清成单行 (summon 标题必须单行)', async () => {
    const exec = makeDispatchExecutors();
    const cmd = mkCmd({ direction: 'parent_to_child', targetChatId: 'oc_sub', commandType: 'supplement', payload: { content: '第一行\n第二行' } });
    await exec.writeAndSend(cmd, mkTask());
    const text = textOf();
    expect(mockWriteRelayRecord.mock.calls[0][0].groupNotFoundRetryTimeoutMs).toBe(0);
    expect(text).not.toContain('\n');
    expect(text).toContain('第一行 第二行');
  });
});

describe('writeAndSend 失败 (不抛, 让 dispatcher 退避)', () => {
  it('writeRelayRecord ok:false → {ok:false, error}', async () => {
    mockWriteRelayRecord.mockResolvedValue({ ok: false, error: 'upsert failed code=3' });
    const exec = makeDispatchExecutors();
    const res = await exec.writeAndSend(mkCmd(), mkTask());
    expect(res.ok).toBe(false);
    expect(res.error).toContain('upsert failed');
  });

  it('authError 透传 (token 失效)', async () => {
    mockWriteRelayRecord.mockResolvedValue({ ok: false, authError: true, error: 'user token auth error' });
    const exec = makeDispatchExecutors();
    const res = await exec.writeAndSend(mkCmd(), mkTask());
    expect(res.ok).toBe(false);
    expect(res.authError).toBe(true);
  });

  it('base relay 未配置 → ok:false 透传', async () => {
    mockWriteRelayRecord.mockResolvedValue({ ok: false, error: 'base relay not configured' });
    const exec = makeDispatchExecutors();
    const res = await exec.writeAndSend(mkCmd(), mkTask());
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not configured');
  });
});

describe('checkStatus (对账委托 checkRelayStatus)', () => {
  it('透传 record 状态', async () => {
    mockCheckRelayStatus.mockResolvedValue('sent');
    const exec = makeDispatchExecutors();
    expect(await exec.checkStatus('rec_x')).toBe('sent');
    expect(mockCheckRelayStatus).toHaveBeenCalledWith('rec_x');
  });

  it('pending / cancelled / unknown / auth_error 均透传', async () => {
    const exec = makeDispatchExecutors();
    for (const s of ['pending', 'cancelled', 'unknown', 'auth_error'] as const) {
      mockCheckRelayStatus.mockResolvedValueOnce(s);
      expect(await exec.checkStatus('rec_y')).toBe(s);
    }
  });
});
