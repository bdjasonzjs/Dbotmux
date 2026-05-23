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

vi.mock('../src/im/lark/client.js', () => ({
  sendMessage: sendMessageSpy,
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
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
