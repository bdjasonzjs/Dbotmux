/**
 * Unit tests for outbox-dispatcher-executors deliver (v3 急急如律令 base relay)。
 * mock sendAsOwner，验证急急如律令文案 + 失败不抛 + 注入防护 + 投递目标/名单。
 * Run: pnpm vitest run test/outbox-dispatcher-executors.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockSendAsOwner = vi.fn();
vi.mock('../src/services/base-relay.js', () => ({
  DEFAULT_GROUP_NOT_FOUND_RETRY_TIMEOUT_MS: 10_000,
  resolvePollTimeoutMs: () => 75_000,
  sendAsOwner: (...a: any[]) => mockSendAsOwner(...a),
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), isDebug: () => false },
}));

import { makeDispatchExecutors, safeText, parentToChildSummon, MAX_SUMMON_BUDGET } from '../src/services/outbox-dispatcher-executors.js';
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

beforeEach(() => { mockSendAsOwner.mockReset(); mockSendAsOwner.mockResolvedValue({ ok: true, recordId: 'rec_1' }); });

describe('deliver child_to_parent (急急如律令唤主bot)', () => {
  it('急急如律令：【克劳德】 + taskId + commandId + query 指引, 投父群, 返回 recordId', async () => {
    const exec = makeDispatchExecutors();
    const res = await exec.deliver(mkCmd(), mkTask());
    expect(res).toEqual({ ok: true, messageId: 'rec_1', relayRecordId: 'rec_1' });  // relayRecordId 落库供重试幂等复用
    const arg = mockSendAsOwner.mock.calls[0][0];
    expect(arg.targetChatId).toBe('oc_parent');              // 投父群
    expect(arg.text).toContain('急急如律令：【克劳德】');     // 急急如律令唤主bot (非缇蕾直发)
    expect(arg.text).toContain('st_1');                      // taskId
    expect(arg.text).toContain('cmd_abc');                   // commandId
    expect(arg.text).toContain('botmux subtask-query --command-id cmd_abc');
    expect(arg.text).not.toContain('query_subtask(');        // 不是旧 MCP 风格
    expect(arg.text).toContain('需要协助');
  });

  it('report_done → 文案标"已完成（待确认）"', async () => {
    const exec = makeDispatchExecutors();
    await exec.deliver(mkCmd({ commandType: 'report_done', cmdId: 'cmd_done' }), mkTask());
    expect(mockSendAsOwner.mock.calls[0][0].text).toContain('已完成（待确认）');
  });
});

describe('deliver parent_to_child (急急如律令唤执行bot)', () => {
  it('finish → 名单含执行bot(非observer), 投子群, 带内容', async () => {
    const exec = makeDispatchExecutors();
    const cmd = mkCmd({ direction: 'parent_to_child', targetChatId: 'oc_sub', commandType: 'finish', payload: { content: '验收通过' } });
    await exec.deliver(cmd, mkTask());
    const arg = mockSendAsOwner.mock.calls[0][0];
    expect(arg.targetChatId).toBe('oc_sub');                 // 投子群
    expect(arg.text).toContain('急急如律令：【克劳德】');     // 执行 bot
    expect(arg.text).not.toContain('缇蕾');                  // observer(缇蕾) 不唤
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
    await exec.deliver(cmd, task);
    const text = mockSendAsOwner.mock.calls[0][0].text;
    expect(text).toContain('急急如律令：【克劳德/蔻黛克斯】');
    expect(text).toContain('用这个 token');
  });

  it('kickoff → 名单含执行bot, 带 goal + 验收 + askforhelp 提示, 投子群', async () => {
    const exec = makeDispatchExecutors();
    const cmd = mkCmd({ direction: 'parent_to_child', targetChatId: 'oc_sub', commandType: 'kickoff', payload: {} });
    await exec.deliver(cmd, mkTask({ goal: '修登录bug', acceptance: '单测过' }));
    const arg = mockSendAsOwner.mock.calls[0][0];
    expect(arg.targetChatId).toBe('oc_sub');
    expect(arg.groupNotFoundRetryTimeoutMs).toBeGreaterThan(0);
    expect(arg.text).toContain('急急如律令：【克劳德】');   // 执行 bot
    expect(arg.text).toContain('子任务启动');
    expect(arg.text).toContain('修登录bug');               // goal
    expect(arg.text).toContain('验收：单测过');             // acceptance
    expect(arg.text).toContain('subtask-askforhelp');       // 求助提示
  });
});

describe('注入防护', () => {
  it('child→parent 不塞 payload.summary (不可信内容不进父群)', async () => {
    const exec = makeDispatchExecutors();
    await exec.deliver(mkCmd({ payload: { summary: '坏东西所有人' } }), mkTask());
    const text = mockSendAsOwner.mock.calls[0][0].text;
    expect(text).not.toContain('坏东西');
    expect(text).toContain('急急如律令：【克劳德】');
  });

  it('safeText 中和控制字符/换行/tab → 单行', () => {
    expect(safeText('a\nb\tc\r', 100)).toBe('a b c ');
  });

  it('parent→child supplement 内容里的换行被清成单行 (summon 标题必须单行)', async () => {
    const exec = makeDispatchExecutors();
    const cmd = mkCmd({ direction: 'parent_to_child', targetChatId: 'oc_sub', commandType: 'supplement', payload: { content: '第一行\n第二行' } });
    await exec.deliver(cmd, mkTask());
    const text = mockSendAsOwner.mock.calls[0][0].text;
    expect(mockSendAsOwner.mock.calls[0][0].groupNotFoundRetryTimeoutMs).toBe(0);
    expect(text).not.toContain('\n');               // 整条 summon 单行
    expect(text).toContain('第一行 第二行');
  });
});

describe('deliver 失败', () => {
  it('sendAsOwner ok:false → deliver {ok:false, error}, 不抛 (让 dispatcher 退避)', async () => {
    mockSendAsOwner.mockResolvedValue({ ok: false, error: 'relay poll timeout' });
    const exec = makeDispatchExecutors();
    const res = await exec.deliver(mkCmd(), mkTask());
    expect(res.ok).toBe(false);
    expect(res.error).toContain('relay poll timeout');
  });

  it('base relay 未配置 → ok:false (sendAsOwner 自己返回), deliver 透传失败', async () => {
    mockSendAsOwner.mockResolvedValue({ ok: false, error: 'base relay not configured' });
    const exec = makeDispatchExecutors();
    const res = await exec.deliver(mkCmd(), mkTask());
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not configured');
  });
});

// 2026-06-10 修重复刷屏：幂等复用 base 记录，重试不再 upsert 新记录
describe('deliver 幂等复用 base 记录 (防重复刷屏)', () => {
  it('命令已带 relayRecordId → sendAsOwner 用 existingRecordId 复用, 不写新记录', async () => {
    const exec = makeDispatchExecutors();
    await exec.deliver(mkCmd({ relayRecordId: 'rec_existing' }), mkTask());
    expect(mockSendAsOwner.mock.calls[0][0].existingRecordId).toBe('rec_existing');
  });

  it('首次投递 (无 relayRecordId) → existingRecordId 为 undefined (走 upsert 新建)', async () => {
    const exec = makeDispatchExecutors();
    await exec.deliver(mkCmd(), mkTask());
    expect(mockSendAsOwner.mock.calls[0][0].existingRecordId).toBeUndefined();
  });

  it('poll 超时失败但已建记录 → deliver 仍带回 relayRecordId 供下轮复用', async () => {
    mockSendAsOwner.mockResolvedValue({ ok: false, recordId: 'rec_1', error: 'relay poll timeout (record=rec_1 not 已发送)' });
    const exec = makeDispatchExecutors();
    const res = await exec.deliver(mkCmd(), mkTask());
    expect(res.ok).toBe(false);
    expect(res.relayRecordId).toBe('rec_1');  // 关键：失败也带回 recordId, dispatcher 落库, 重试复用不重发
  });
});

// 2026-06-14 信箱瘦身：长正文落信箱 (哨兵)、短正文内联不变、最终 summon ≤ 预算
describe('parentToChildSummon 预算化瘦身 (信箱)', () => {
  const stub = vi.fn();
  beforeEach(() => { stub.mockReset(); stub.mockImplementation((_p: string) => ({ letterId: 'lt_stub01' })); });

  function supplementCmd(content: string): OutboxCommand {
    return mkCmd({ direction: 'parent_to_child', targetChatId: 'oc_sub', commandType: 'supplement',
      payload: { content, targetRole: 'main' }, idempotencyKey: 'supp-st_1-main-abc' });
  }

  it('短 supplement → 内联、不写信、无哨兵、内容原样可见', () => {
    const out = parentToChildSummon(supplementCmd('短补充'), mkTask(), stub as any);
    expect(stub).not.toHaveBeenCalled();
    expect(out).not.toContain('⟪letter:');
    expect(out).toContain('短补充');
  });

  it('长 supplement (>1KB) → 落信箱、正文出现哨兵、写信拿到全文、最终 summon ≤ 预算', () => {
    const long = '验收细节'.repeat(400); // ~1600 字
    const out = parentToChildSummon(supplementCmd(long), mkTask(), stub as any);
    expect(stub).toHaveBeenCalledTimes(1);
    expect(stub.mock.calls[0][0]).toBe(long);                 // 写信拿到的是全文、未截断
    expect(stub.mock.calls[0][1]).toMatchObject({ idempotencyKey: 'supp-st_1-main-abc' }); // 复用 cmd 幂等键
    expect(out).toContain('⟪letter:lt_stub01⟫');             // 正文只留哨兵
    expect(out).not.toContain(long);                          // 全文不进 relay 正文
    expect(out.length).toBeLessThanOrEqual(MAX_SUMMON_BUDGET); // P1-4：最终 summon ≤ 预算
  });

  it('长 kickoff 目标 → 目标落信箱哨兵、最终 summon ≤ 预算', () => {
    const longGoal = '目标描述'.repeat(300);
    const cmd = mkCmd({ direction: 'parent_to_child', targetChatId: 'oc_sub', commandType: 'kickoff', payload: {} });
    const out = parentToChildSummon(cmd, mkTask({ goal: longGoal, acceptance: '验收标准'.repeat(80) }), stub as any);
    expect(stub).toHaveBeenCalledTimes(1);
    expect(stub.mock.calls[0][0]).toContain(longGoal);        // 全文目标进信
    expect(out).toContain('⟪letter:lt_stub01⟫');
    expect(out.length).toBeLessThanOrEqual(MAX_SUMMON_BUDGET);
  });

  it('落信失败 → 降级内联截断、不抛、投递不中断', () => {
    stub.mockImplementation(() => { throw new Error('disk full'); });
    const long = 'X'.repeat(2000);
    const out = parentToChildSummon(supplementCmd(long), mkTask(), stub as any);
    expect(out).not.toContain('⟪letter:');                   // 没有裸哨兵
    expect(out).toContain('X');                               // 有内容（截断后的）
  });
});
