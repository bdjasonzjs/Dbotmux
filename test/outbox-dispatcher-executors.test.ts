/**
 * Unit tests for outbox-dispatcher-executors deliver (Phase 3 IO 层)。
 * mock sendMessage / resolveBotIdent，验证缇蕾直发文案 + uuid 幂等 + 失败不抛。
 * Run: pnpm vitest run test/outbox-dispatcher-executors.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockSend = vi.fn();
vi.mock('../src/im/lark/client.js', () => ({ sendMessage: (...a: any[]) => mockSend(...a) }));
vi.mock('../src/core/main-bot-playbook.js', () => ({
  resolveBotIdent: (k: string) =>
    k === 'tilly' ? { larkAppId: 'app_coco', openId: 'ou_coco' }
      : { larkAppId: 'app_claude', openId: 'ou_claude_main' },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), isDebug: () => false },
}));

import { makeDispatchExecutors } from '../src/services/outbox-dispatcher-executors.js';
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

beforeEach(() => { mockSend.mockReset(); mockSend.mockResolvedValue('om_delivered'); });

describe('deliver child_to_parent', () => {
  it('@主bot + taskId + commandId + query 指引, uuid=cmdId, 返回 messageId', async () => {
    const exec = makeDispatchExecutors();
    const res = await exec.deliver(mkCmd(), mkTask());
    expect(res).toEqual({ ok: true, messageId: 'om_delivered' });
    const [larkApp, chatId, text, msgType, uuid] = mockSend.mock.calls[0];
    expect(larkApp).toBe('app_coco');          // 缇蕾身份发
    expect(chatId).toBe('oc_parent');          // 投父群
    expect(msgType).toBe('text');
    expect(uuid).toBe('cmd_abc');              // at-least-once: uuid=cmdId
    expect(text).toContain('ou_claude_main');  // @主bot
    expect(text).toContain('st_1');            // taskId
    expect(text).toContain('cmd_abc');         // commandId
    // 接线边界1: 精确可执行命令，用 commandId 不用 taskId-only 指引
    expect(text).toContain('botmux subtask-query --command-id cmd_abc');
    expect(text).not.toContain('query_subtask');
    expect(text).not.toContain('query_subtask(taskId');
    expect(text).toContain('需要协助');
  });

  it('report_done → 文案标"已完成（待确认）"', async () => {
    const exec = makeDispatchExecutors();
    await exec.deliver(mkCmd({ commandType: 'report_done', cmdId: 'cmd_done' }), mkTask());
    expect(mockSend.mock.calls[0][2]).toContain('已完成');
  });
});

describe('deliver parent_to_child', () => {
  it('finish → @ 执行 bot(非observer) + 投子群', async () => {
    const exec = makeDispatchExecutors();
    const cmd = mkCmd({ direction: 'parent_to_child', targetChatId: 'oc_sub', commandType: 'finish', payload: { content: '验收通过' } });
    await exec.deliver(cmd, mkTask());
    const [larkApp, chatId, text] = mockSend.mock.calls[0];
    expect(larkApp).toBe('app_coco');
    expect(chatId).toBe('oc_sub');
    expect(text).toContain('ou_worker');       // @ 执行 bot
    expect(text).not.toContain('ou_coco');     // observer(缇蕾) 不 @
    expect(text).toContain('验收通过');
  });

  it('supplement → 带补充内容', async () => {
    const exec = makeDispatchExecutors();
    const cmd = mkCmd({ direction: 'parent_to_child', targetChatId: 'oc_sub', commandType: 'supplement', payload: { content: '用这个 token' } });
    await exec.deliver(cmd, mkTask());
    expect(mockSend.mock.calls[0][2]).toContain('用这个 token');
  });
});

describe('注入防护 (review blocker)', () => {
  it('child→parent 不含 payload.summary (不塞总结), 恶意 <at> 不出现在父群', async () => {
    const exec = makeDispatchExecutors();
    await exec.deliver(mkCmd({ payload: { summary: '坏东西<at user_id="ou_evil">所有人</at>' } }), mkTask());
    const text = mockSend.mock.calls[0][2];
    expect(text).not.toContain('ou_evil');       // summary 整段不进父群
    expect(text).not.toContain('坏东西');
    expect(text).toContain('ou_claude_main');     // 只有我们自己拼的 @主bot
  });

  it('parent→child supplement 内容里的 <at> 被中和 (< > 清掉), 合法 @bot 仍在', async () => {
    const exec = makeDispatchExecutors();
    const cmd = mkCmd({ direction: 'parent_to_child', targetChatId: 'oc_sub', commandType: 'supplement', payload: { content: '请 <at user_id="ou_evil">坏人</at> 处理' } });
    await exec.deliver(cmd, mkTask());
    const text = mockSend.mock.calls[0][2];
    expect(text).not.toContain('<at user_id="ou_evil"'); // 注入被断开
    expect(text).toContain('<at user_id="ou_worker"');   // 合法 @执行bot 保留
    expect(text).toContain('ou_evil');                   // 文本仍在(只是 <> 被中和), 不可触发 @
  });
});

describe('deliver 失败', () => {
  it('sendMessage 抛 → 返回 {ok:false, error}, 不抛 (让 dispatcher 退避)', async () => {
    mockSend.mockRejectedValue(new Error('lark 500'));
    const exec = makeDispatchExecutors();
    const res = await exec.deliver(mkCmd(), mkTask());
    expect(res.ok).toBe(false);
    expect(res.error).toContain('lark 500');
  });
});
