/**
 * P2-rev1 #3 — root-inbox-card-renderer tests.
 *
 * Run:  pnpm vitest run test/root-inbox-card-renderer.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;
const sendMessageSpy = vi.fn();
const updateMessageSpy = vi.fn();
let fakeMainTopic: string | undefined;

vi.mock('../src/config.js', () => ({
  config: { get session() { return { dataDir: tempDir }; } },
}));
vi.mock('../src/im/lark/client.js', () => ({
  sendMessage: sendMessageSpy,
  updateMessage: updateMessageSpy,
}));
vi.mock('../src/services/main-topic-config.js', () => ({
  getMainTopicChatId: () => fakeMainTopic,
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

async function freshImports() {
  vi.resetModules();
  return {
    renderer: await import('../src/services/root-inbox-card-renderer.js'),
    root: await import('../src/services/root-inbox-store.js'),
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'renderer-test-'));
  sendMessageSpy.mockReset();
  updateMessageSpy.mockReset();
  sendMessageSpy.mockResolvedValue('msg_id');
  fakeMainTopic = undefined;
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('root-inbox-card-renderer (P2-rev1 #3)', () => {
  describe('renderRootInboxCard', () => {
    it('renders Lark v2 JSON with status emoji + rule badge + sub-chat link', async () => {
      const { renderer } = await freshImports();
      const json = renderer.renderRootInboxCard({
        id: 'R5:oc_x', kind: 'escalation', subChatId: 'oc_x', subChatName: 'sub',
        ruleId: 'R5', status: 'open', firstSeenAt: '2026-05-24T12:00:00Z',
        lastUpdatedAt: '2026-05-24T12:00:00Z', updateCount: 1, summary: 'stuck',
        rootCardMessageId: null,
      });
      const parsed = JSON.parse(json);
      expect(parsed.schema).toBe('2.0');
      expect(parsed.body.elements[0].tag).toBe('markdown');
      expect(parsed.body.elements[0].content).toContain('[R5]');
      expect(parsed.body.elements[0].content).toContain('stuck');
      expect(parsed.body.elements[0].content).toContain('查看子群');
    });
    it('closed status uses ✅ emoji and "已关闭" badge', async () => {
      const { renderer } = await freshImports();
      const json = renderer.renderRootInboxCard({
        id: 'R5:oc_x', kind: 'escalation', subChatId: 'oc_x', subChatName: 'sub',
        ruleId: 'R5', status: 'closed', firstSeenAt: '2026-05-24T12:00:00Z',
        lastUpdatedAt: '2026-05-24T12:00:00Z', updateCount: 3, summary: 'resolved',
        rootCardMessageId: 'om_orig',
      });
      const content = JSON.parse(json).body.elements[0].content;
      expect(content).toContain('（已关闭）');
      expect(content).toContain('更新 3 次');
    });
  });

  describe('P3-rev1 #5: tilly_digest layout', () => {
    it('kind=tilly_digest uses customMarkdown override, no fake subChat link', async () => {
      const { renderer } = await freshImports();
      const json = renderer.renderRootInboxCard({
        id: 'tilly_digest:2026-05-25', kind: 'tilly_digest',
        subChatId: 'tilly-scout', subChatName: '缇蕾扫读',
        status: 'open', firstSeenAt: '', lastUpdatedAt: '',
        updateCount: 1, summary: '今日 N items (short label, not full card)',
        rootCardMessageId: null,
      }, { customMarkdown: '**🐶 缇蕾今日扫读**\n📝 待办 (3)\n- todo 1\n- todo 2' });
      const parsed = JSON.parse(json);
      const content = parsed.body.elements[0].content;
      // Contains the custom markdown
      expect(content).toContain('🐶 缇蕾今日扫读');
      expect(content).toContain('📝 待办 (3)');
      expect(content).toContain('todo 1');
      // Does NOT contain fake子群 link / generic footer
      expect(content).not.toContain('openChatId=tilly-scout');
      expect(content).not.toContain('查看子群');
      // Does NOT echo store's short summary label (caller passes full md)
      expect(content).not.toContain('today N items (short label, not full card)');
    });
    it('kind=tilly_digest WITHOUT customMarkdown emits fallback (caller bug)', async () => {
      const { renderer } = await freshImports();
      const json = renderer.renderRootInboxCard({
        id: 'tilly_digest:2026-05-25', kind: 'tilly_digest',
        subChatId: 'tilly-scout', subChatName: '缇蕾扫读',
        status: 'open', firstSeenAt: '', lastUpdatedAt: '',
        updateCount: 1, summary: 'short label',
        rootCardMessageId: null,
      });
      const content = JSON.parse(json).body.elements[0].content;
      expect(content).toContain('caller forgot customMarkdown');
    });
    it('other kinds still ignore customMarkdown', async () => {
      const { renderer } = await freshImports();
      const json = renderer.renderRootInboxCard({
        id: 'R5:oc_x', kind: 'escalation', subChatId: 'oc_x', subChatName: 'X',
        ruleId: 'R5', status: 'open', firstSeenAt: '2026-05-25T00:00:00Z',
        lastUpdatedAt: '2026-05-25T00:00:00Z', updateCount: 1, summary: 'stuck',
        rootCardMessageId: null,
      }, { customMarkdown: 'IGNORED' });
      const content = JSON.parse(json).body.elements[0].content;
      expect(content).not.toContain('IGNORED');
      expect(content).toContain('[R5]');
      expect(content).toContain('查看子群');   // generic layout still has it
    });
  });

  describe('sendOrUpdateCard', () => {
    it('no existing messageId → sendMessage + setRootCardMessageId', async () => {
      const { renderer, root } = await freshImports();
      sendMessageSpy.mockResolvedValueOnce('msg_fresh');
      const { item } = root.upsertOpen({ id: 'R5:oc_a', kind: 'escalation', subChatId: 'oc_a', subChatName: 'A', ruleId: 'R5', summary: 's' });
      const result = await renderer.sendOrUpdateCard('app_x', 'oc_flumy', item);
      expect(result).toBe('msg_fresh');
      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
      expect(updateMessageSpy).not.toHaveBeenCalled();
      expect(root.lookup('R5:oc_a')?.rootCardMessageId).toBe('msg_fresh');
    });
    it('existing messageId → updateMessage edits same card', async () => {
      const { renderer, root } = await freshImports();
      sendMessageSpy.mockResolvedValueOnce('msg_orig');
      updateMessageSpy.mockResolvedValue(undefined);
      const { item: item1 } = root.upsertOpen({ id: 'R5:oc_b', kind: 'escalation', subChatId: 'oc_b', subChatName: 'B', ruleId: 'R5', summary: 'v1' });
      await renderer.sendOrUpdateCard('app_x', 'oc_flumy', item1);
      const item2 = root.lookup('R5:oc_b')!;
      const result = await renderer.sendOrUpdateCard('app_x', 'oc_flumy', item2);
      expect(result).toBe('msg_orig');
      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
      expect(updateMessageSpy).toHaveBeenCalledTimes(1);
      expect(updateMessageSpy.mock.calls[0][1]).toBe('msg_orig');
    });
    it('update fails → fallback to sendMessage and update store messageId', async () => {
      const { renderer, root } = await freshImports();
      sendMessageSpy
        .mockResolvedValueOnce('msg_orig')
        .mockResolvedValueOnce('msg_fallback');
      updateMessageSpy.mockRejectedValueOnce(new Error('withdrawn'));
      const { item } = root.upsertOpen({ id: 'R5:oc_c', kind: 'escalation', subChatId: 'oc_c', subChatName: 'C', ruleId: 'R5', summary: 'v1' });
      await renderer.sendOrUpdateCard('app_x', 'oc_flumy', item);
      const result = await renderer.sendOrUpdateCard('app_x', 'oc_flumy', root.lookup('R5:oc_c')!);
      expect(result).toBe('msg_fallback');
      expect(root.lookup('R5:oc_c')?.rootCardMessageId).toBe('msg_fallback');
    });
  });

  describe('closeAndRenderClosed', () => {
    it('store close + updateMessage with closed-state card', async () => {
      const { renderer, root } = await freshImports();
      fakeMainTopic = 'oc_flumy';
      sendMessageSpy.mockResolvedValueOnce('msg_card');
      updateMessageSpy.mockResolvedValue(undefined);
      const { item } = root.upsertOpen({ id: 'R5:oc_d', kind: 'escalation', subChatId: 'oc_d', subChatName: 'D', ruleId: 'R5', summary: 'stuck' });
      await renderer.sendOrUpdateCard('app_x', 'oc_flumy', item);
      // Now close-and-render-closed
      await renderer.closeAndRenderClosed('R5:oc_d', 'app_x');
      const closedItem = root.lookup('R5:oc_d');
      expect(closedItem?.status).toBe('closed');
      // updateMessage called with closed-state card
      expect(updateMessageSpy).toHaveBeenCalledTimes(1);
      const sentJson = updateMessageSpy.mock.calls[0][2];
      expect(JSON.parse(sentJson).body.elements[0].content).toContain('（已关闭）');
    });
    it('unknown id → no-op (no throw, no Lark call)', async () => {
      const { renderer } = await freshImports();
      fakeMainTopic = 'oc_flumy';
      await renderer.closeAndRenderClosed('R5:no_such', 'app_x');
      expect(updateMessageSpy).not.toHaveBeenCalled();
      expect(sendMessageSpy).not.toHaveBeenCalled();
    });
    it('mainTopic not configured → store-only close, no Lark call', async () => {
      const { renderer, root } = await freshImports();
      fakeMainTopic = undefined;
      root.upsertOpen({ id: 'R5:oc_e', kind: 'escalation', subChatId: 'oc_e', subChatName: 'E', ruleId: 'R5', summary: 's' });
      await renderer.closeAndRenderClosed('R5:oc_e', 'app_x');
      expect(root.lookup('R5:oc_e')?.status).toBe('closed');
      expect(updateMessageSpy).not.toHaveBeenCalled();
    });
    it('no rootCardMessageId (sink failed earlier) → store-only close', async () => {
      const { renderer, root } = await freshImports();
      fakeMainTopic = 'oc_flumy';
      root.upsertOpen({ id: 'R5:oc_f', kind: 'escalation', subChatId: 'oc_f', subChatName: 'F', ruleId: 'R5', summary: 's' });
      // Do NOT call sendOrUpdateCard so rootCardMessageId stays null
      await renderer.closeAndRenderClosed('R5:oc_f', 'app_x');
      expect(root.lookup('R5:oc_f')?.status).toBe('closed');
      expect(updateMessageSpy).not.toHaveBeenCalled();
    });
    it('updateMessage failure → log warn, store still closed', async () => {
      const { renderer, root } = await freshImports();
      fakeMainTopic = 'oc_flumy';
      sendMessageSpy.mockResolvedValueOnce('msg_g');
      updateMessageSpy.mockRejectedValueOnce(new Error('withdrawn'));
      const { item } = root.upsertOpen({ id: 'R5:oc_g', kind: 'escalation', subChatId: 'oc_g', subChatName: 'G', ruleId: 'R5', summary: 's' });
      await renderer.sendOrUpdateCard('app_x', 'oc_flumy', item);
      await renderer.closeAndRenderClosed('R5:oc_g', 'app_x');
      expect(root.lookup('R5:oc_g')?.status).toBe('closed');
    });
  });
});
