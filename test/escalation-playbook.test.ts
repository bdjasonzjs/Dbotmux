/**
 * Unit tests for P3 L3 escalation playbook handlers + dispatcher.
 *
 * Run:  pnpm vitest run test/escalation-playbook.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;
const sendMessageSpy = vi.fn();

vi.mock('../src/config.js', () => ({
  config: { get session() { return { dataDir: tempDir }; } },
}));

const updateMessageSpy = vi.fn();
vi.mock('../src/im/lark/client.js', () => ({
  sendMessage: sendMessageSpy,
  updateMessage: updateMessageSpy,
}));

// P2 commit #2 added a RootInbox sink to dispatch. By default tests assume
// mainTopic is NOT configured — sink no-ops, existing assertions still hold.
// Tests that want to verify the sink set fakeMainTopicChatId before import.
let fakeMainTopicChatId: string | undefined;
vi.mock('../src/services/main-topic-config.js', () => ({
  getMainTopicChatId: () => fakeMainTopicChatId,
  isTillyMainTopicConversationDenied: () => false,
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

async function freshImports() {
  vi.resetModules();
  const store = await import('../src/services/main-bot-digest-store.js');
  const playbook = await import('../src/core/escalation-playbook.js');
  return { store, playbook };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'playbook-test-'));
  sendMessageSpy.mockReset();
  sendMessageSpy.mockResolvedValue('msg_x');
  updateMessageSpy.mockReset();
  fakeMainTopicChatId = undefined;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('dispatchPendingEscalations', () => {
  it('returns 0 when inbox empty', async () => {
    const { playbook } = await freshImports();
    expect(await playbook.dispatchPendingEscalations('app_a')).toBe(0);
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it('dispatches an R1 item + marks resolved + sends a reminder', async () => {
    const { store, playbook } = await freshImports();
    const item = store.enqueueEscalation({
      ruleId: 'R1', triggeredAt: 'x', chatId: 'oc_r1',
      context: 'r1 ctx',
      payload: { sinceMinutes: 45 },
    });
    const n = await playbook.dispatchPendingEscalations('app_a');
    expect(n).toBe(1);
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    const [app, chat, text] = sendMessageSpy.mock.calls[0];
    expect(app).toBe('app_a');
    expect(chat).toBe('oc_r1');
    expect(text).toContain('45');
    // item moved to processed
    const inbox = store.readInbox();
    expect(inbox.pending.length).toBe(0);
    expect(inbox.processed.length).toBe(1);
    expect(inbox.processed[0].status).toBe('resolved');
    expect(inbox.processed[0].resolution).toContain('R1');
  });

  it('dispatches all 5 rules with different message templates', async () => {
    const { store, playbook } = await freshImports();
    store.enqueueEscalation({ ruleId: 'R1', triggeredAt: 'x', chatId: 'c1', context: 'c', payload: { sinceMinutes: 31 } });
    store.enqueueEscalation({ ruleId: 'R2', triggeredAt: 'x', chatId: 'c2', context: 'c', payload: { theme: 't', chatIds: ['c2', 'c3'] } });
    store.enqueueEscalation({ ruleId: 'R3', triggeredAt: 'x', chatId: 'c4', context: 'c', payload: { ageMinutes: 90 } });
    store.enqueueEscalation({ ruleId: 'R4', triggeredAt: 'x', chatId: 'c5', context: 'c', payload: {} });
    store.enqueueEscalation({ ruleId: 'R5', triggeredAt: 'x', chatId: 'c6', context: 'c', payload: { keyword: 'blocked' } });
    const n = await playbook.dispatchPendingEscalations('app_a');
    expect(n).toBe(5);
    expect(sendMessageSpy).toHaveBeenCalledTimes(5);
    // Each sendMessage receives different content
    const contents = sendMessageSpy.mock.calls.map(c => c[2]);
    expect(contents.find(c => c.includes('31'))).toBeTruthy();   // R1
    expect(contents.find(c => c.includes('合群'))).toBeTruthy();  // R2
    expect(contents.find(c => c.includes('90'))).toBeTruthy();   // R3
    expect(contents.find(c => c.includes('不打断'))).toBeTruthy(); // R4
    expect(contents.find(c => c.includes('blocked'))).toBeTruthy(); // R5
  });

  it('marks item as resolved with error when handler throws', async () => {
    const { store, playbook } = await freshImports();
    sendMessageSpy.mockRejectedValue(new Error('Lark 503'));
    store.enqueueEscalation({ ruleId: 'R1', triggeredAt: 'x', chatId: 'c', context: 'c', payload: { sinceMinutes: 60 } });
    const n = await playbook.dispatchPendingEscalations('app_a');
    expect(n).toBe(1);
    const inbox = store.readInbox();
    expect(inbox.processed[0].resolution).toContain('error');
  });

  it('continues processing other items when one throws', async () => {
    const { store, playbook } = await freshImports();
    sendMessageSpy
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('msg_2')
      .mockResolvedValueOnce('msg_3');
    store.enqueueEscalation({ ruleId: 'R1', triggeredAt: 'x', chatId: 'fail', context: 'c', payload: { sinceMinutes: 30 } });
    store.enqueueEscalation({ ruleId: 'R2', triggeredAt: 'x', chatId: 'ok1', context: 'c', payload: { theme: 't', chatIds: ['ok1', 'ok2'] } });
    store.enqueueEscalation({ ruleId: 'R3', triggeredAt: 'x', chatId: 'ok2', context: 'c', payload: { ageMinutes: 70 } });
    const n = await playbook.dispatchPendingEscalations('app_a');
    expect(n).toBe(3);
    const inbox = store.readInbox();
    expect(inbox.processed.length).toBe(3);
    expect(inbox.processed.find(p => p.escalation.chatId === 'fail')?.resolution).toContain('error');
    expect(inbox.processed.find(p => p.escalation.chatId === 'ok1')?.resolution).toContain('R2');
    expect(inbox.processed.find(p => p.escalation.chatId === 'ok2')?.resolution).toContain('R3');
  });

  it('skips items not in pending status', async () => {
    const { store, playbook } = await freshImports();
    const item = store.enqueueEscalation({ ruleId: 'R1', triggeredAt: 'x', chatId: 'c', context: 'c', payload: { sinceMinutes: 35 } });
    // Manually set status to in_progress (simulating concurrent dispatcher)
    store.markInProgress(item.id);
    const n = await playbook.dispatchPendingEscalations('app_a');
    expect(n).toBe(0);  // skip non-pending
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });
});

// ─── P2 commit #2: RootInbox sink ───────────────────────────────────────

describe('RootInbox sink (P2 commit #2)', () => {
  it('mainTopic 未配 → 不调 mainTopic sendMessage / 不写 RootInbox', async () => {
    fakeMainTopicChatId = undefined;
    const { store, playbook } = await freshImports();
    const root = await import('../src/services/root-inbox-store.js');
    store.enqueueEscalation({ ruleId: 'R5', triggeredAt: 'x', chatId: 'oc_sub', context: 'c', payload: { keyword: 'blocked' } });
    await playbook.dispatchPendingEscalations('app_a');
    // 1 sendMessage to sub-chat (handleR5 内部) — but 0 to mainTopic (because none configured)
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(root.listAll()).toHaveLength(0);
  });

  it('mainTopic 配了 + 首次 R5 → sendMessage 到 mainTopic + RootInbox 有新 item + rootCardMessageId 存了', async () => {
    fakeMainTopicChatId = 'oc_flumy';
    sendMessageSpy.mockResolvedValueOnce('msg_subchat');   // R5 handler 内部发到子群
    sendMessageSpy.mockResolvedValueOnce('msg_root_card'); // RootInbox sink 首发到 mainTopic
    const { store, playbook } = await freshImports();
    const root = await import('../src/services/root-inbox-store.js');
    store.enqueueEscalation({ ruleId: 'R5', triggeredAt: 'x', chatId: 'oc_sub_1', context: 'stuck on issue 1', payload: { keyword: 'blocked' } });
    await playbook.dispatchPendingEscalations('app_a');
    expect(sendMessageSpy).toHaveBeenCalledTimes(2);
    // Second sendMessage call targets mainTopic with msgType=interactive
    const mainSend = sendMessageSpy.mock.calls[1];
    expect(mainSend[1]).toBe('oc_flumy');     // chatId
    expect(mainSend[3]).toBe('interactive');  // msgType
    // RootInbox has 1 open item with rootCardMessageId stored
    const items = root.listAll();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('R5:oc_sub_1');
    expect(items[0].rootCardMessageId).toBe('msg_root_card');
    expect(items[0].status).toBe('open');
  });

  it('mainTopic 配了 + 第二次同 ruleId+chatId → updateMessage 编辑原卡 + RootInbox updateCount=2', async () => {
    fakeMainTopicChatId = 'oc_flumy';
    sendMessageSpy
      .mockResolvedValueOnce('msg_subchat_1')
      .mockResolvedValueOnce('msg_root_v1')
      .mockResolvedValueOnce('msg_subchat_2');  // R5 handler 第二次内部发到子群
    updateMessageSpy.mockResolvedValue(undefined);
    const { store, playbook } = await freshImports();
    const root = await import('../src/services/root-inbox-store.js');
    // First fire
    store.enqueueEscalation({ ruleId: 'R5', triggeredAt: 'x', chatId: 'oc_sub_2', context: 'first', payload: { keyword: 'stuck' } });
    await playbook.dispatchPendingEscalations('app_a');
    // Second fire same chat (simulating R5 re-triggering)
    store.enqueueEscalation({ ruleId: 'R5', triggeredAt: 'y', chatId: 'oc_sub_2', context: 'still stuck second time', payload: { keyword: 'stuck' } });
    await playbook.dispatchPendingEscalations('app_a');
    // Sends: sub-chat#1 + root#1 + sub-chat#2  (root#2 used updateMessage, not sendMessage)
    expect(sendMessageSpy).toHaveBeenCalledTimes(3);
    expect(updateMessageSpy).toHaveBeenCalledTimes(1);
    expect(updateMessageSpy.mock.calls[0][1]).toBe('msg_root_v1');  // edits ORIGINAL card
    // RootInbox updateCount = 2
    const items = root.listAll();
    expect(items).toHaveLength(1);
    expect(items[0].updateCount).toBe(2);
    expect(items[0].status).toBe('updated');
  });

  it('updateMessage 失败 → fallback 发 fresh card + 更新 rootCardMessageId', async () => {
    fakeMainTopicChatId = 'oc_flumy';
    sendMessageSpy
      .mockResolvedValueOnce('msg_subchat_a')
      .mockResolvedValueOnce('msg_root_v1')
      .mockResolvedValueOnce('msg_subchat_b')
      .mockResolvedValueOnce('msg_root_v2_fallback');
    updateMessageSpy.mockRejectedValueOnce(new Error('message withdrawn'));
    const { store, playbook } = await freshImports();
    const root = await import('../src/services/root-inbox-store.js');
    store.enqueueEscalation({ ruleId: 'R5', triggeredAt: 'x', chatId: 'oc_sub_3', context: 'a', payload: { keyword: 'x' } });
    await playbook.dispatchPendingEscalations('app_a');
    store.enqueueEscalation({ ruleId: 'R5', triggeredAt: 'y', chatId: 'oc_sub_3', context: 'b', payload: { keyword: 'x' } });
    await playbook.dispatchPendingEscalations('app_a');
    // sub#1 + root#1 + sub#2 + root_fallback = 4
    expect(sendMessageSpy).toHaveBeenCalledTimes(4);
    // updateMessage was tried, fell through
    expect(updateMessageSpy).toHaveBeenCalledTimes(1);
    // rootCardMessageId updated to fallback message
    expect(root.lookup('R5:oc_sub_3')?.rootCardMessageId).toBe('msg_root_v2_fallback');
  });
});
