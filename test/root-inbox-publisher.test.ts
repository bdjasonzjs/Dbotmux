/**
 * P2 commit #5 — RootInbox publisher tests (progress + request_decision).
 *
 * Run:  pnpm vitest run test/root-inbox-publisher.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;
const sendMessageSpy = vi.fn();
const updateMessageSpy = vi.fn();

vi.mock('../src/config.js', () => ({
  config: { get session() { return { dataDir: tempDir }; } },
}));
vi.mock('../src/im/lark/client.js', () => ({
  sendMessage: sendMessageSpy,
  updateMessage: updateMessageSpy,
}));
let fakeMainTopic: string | undefined;
let fakeCompany: { rootChatId: string; ceoLarkAppId: string } | null;
const fakeTaskByChat = new Map<string, { rootChatId?: string; parentChatId?: string }>();
vi.mock('../src/services/main-topic-config.js', () => ({
  getMainTopicChatId: () => fakeMainTopic,
  getCompanyByRootChatId: (rootChatId?: string) => fakeCompany && rootChatId === fakeCompany.rootChatId ? fakeCompany : null,
  isTillyMainTopicConversationDenied: () => false,
}));
vi.mock('../src/services/subtask-store.js', () => ({
  getByChatId: (chatId: string) => fakeTaskByChat.get(chatId),
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

async function freshImports() {
  vi.resetModules();
  return {
    pub: await import('../src/services/root-inbox-publisher.js'),
    root: await import('../src/services/root-inbox-store.js'),
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'pub-test-'));
  sendMessageSpy.mockReset();
  updateMessageSpy.mockReset();
  sendMessageSpy.mockResolvedValue('msg_id');
  fakeMainTopic = undefined;
  fakeCompany = null;
  fakeTaskByChat.clear();
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('root-inbox-publisher (P2 commit #5)', () => {
  describe('publishProgress', () => {
    it('mainTopic 未配 → 写 RootInbox + 不发卡 + mainTopicConfigured=false', async () => {
      const { pub, root } = await freshImports();
      const r = await pub.publishProgress({
        subChatId: 'oc_sub', slug: 'm1', summary: 'milestone 1 done', larkAppId: 'app_x',
      });
      expect(r.mainTopicConfigured).toBe(false);
      expect(r.inserted).toBe(true);
      expect(r.itemId).toBe('progress:oc_sub:m1');
      expect(sendMessageSpy).not.toHaveBeenCalled();
      expect(root.lookup('progress:oc_sub:m1')?.summary).toBe('milestone 1 done');
    });

    it('mainTopic 配了 + 首发 → sendMessage 调到 mainTopic + 回写 rootCardMessageId', async () => {
      fakeMainTopic = 'oc_flumy';
      sendMessageSpy.mockResolvedValueOnce('msg_card_1');
      const { pub, root } = await freshImports();
      const r = await pub.publishProgress({
        subChatId: 'oc_sub_a', slug: 'm1', summary: 'milestone 1', larkAppId: 'app_x',
      });
      expect(r.mainTopicConfigured).toBe(true);
      expect(r.inserted).toBe(true);
      expect(r.rootCardMessageId).toBe('msg_card_1');
      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
      const [appId, chatId, _content, msgType] = sendMessageSpy.mock.calls[0];
      expect(appId).toBe('app_x');
      expect(chatId).toBe('oc_flumy');
      expect(msgType).toBe('interactive');
      expect(root.lookup('progress:oc_sub_a:m1')?.rootCardMessageId).toBe('msg_card_1');
    });

    it('Company subtask 上报 → 发到对应 company root，并用 CEO app 发送', async () => {
      fakeMainTopic = 'oc_legacy';
      fakeCompany = { rootChatId: 'oc_company_root', ceoLarkAppId: 'app_codex' };
      fakeTaskByChat.set('oc_company_sub', { rootChatId: 'oc_company_root' });
      sendMessageSpy.mockResolvedValueOnce('msg_company_card');
      const { pub, root } = await freshImports();
      const r = await pub.publishProgress({
        subChatId: 'oc_company_sub', slug: 'm1', summary: 'company milestone', larkAppId: 'app_worker',
      });
      expect(r.mainTopicConfigured).toBe(true);
      expect(r.rootCardMessageId).toBe('msg_company_card');
      const [appId, chatId, _content, msgType] = sendMessageSpy.mock.calls[0];
      expect(appId).toBe('app_codex');
      expect(chatId).toBe('oc_company_root');
      expect(msgType).toBe('interactive');
      expect(root.lookup('progress:oc_company_sub:m1')?.rootCardMessageId).toBe('msg_company_card');
    });

    it('mainTopic 配了 + 同 slug 第二次 → updateMessage 编辑原卡', async () => {
      fakeMainTopic = 'oc_flumy';
      sendMessageSpy.mockResolvedValueOnce('msg_card_2');
      updateMessageSpy.mockResolvedValue(undefined);
      const { pub, root } = await freshImports();
      await pub.publishProgress({ subChatId: 'oc_sub_b', slug: 'm1', summary: 'v1', larkAppId: 'app_x' });
      const r2 = await pub.publishProgress({ subChatId: 'oc_sub_b', slug: 'm1', summary: 'v2', larkAppId: 'app_x' });
      expect(r2.inserted).toBe(false);
      expect(updateMessageSpy).toHaveBeenCalledTimes(1);
      expect(updateMessageSpy.mock.calls[0][1]).toBe('msg_card_2');   // edits ORIGINAL
      expect(root.lookup('progress:oc_sub_b:m1')?.updateCount).toBe(2);
      expect(root.lookup('progress:oc_sub_b:m1')?.summary).toBe('v2');
    });

    it('updateMessage 失败 → fallback 发 fresh card + 更新 rootCardMessageId', async () => {
      fakeMainTopic = 'oc_flumy';
      sendMessageSpy
        .mockResolvedValueOnce('msg_card_3')
        .mockResolvedValueOnce('msg_card_3_fallback');
      updateMessageSpy.mockRejectedValueOnce(new Error('msg withdrawn'));
      const { pub, root } = await freshImports();
      await pub.publishProgress({ subChatId: 'oc_sub_c', slug: 'm1', summary: 'v1', larkAppId: 'app_x' });
      await pub.publishProgress({ subChatId: 'oc_sub_c', slug: 'm1', summary: 'v2', larkAppId: 'app_x' });
      expect(sendMessageSpy).toHaveBeenCalledTimes(2);   // initial + fallback
      expect(updateMessageSpy).toHaveBeenCalledTimes(1);
      expect(root.lookup('progress:oc_sub_c:m1')?.rootCardMessageId).toBe('msg_card_3_fallback');
    });
  });

  describe('publishRequestDecision', () => {
    it('writes kind=request_decision with the right dedup id', async () => {
      const { pub, root } = await freshImports();
      const r = await pub.publishRequestDecision({
        subChatId: 'oc_sub_d', slug: 'auth-design-q1', summary: '该选 A 还是 B', larkAppId: 'app_x',
      });
      expect(r.itemId).toBe('request_decision:oc_sub_d:auth-design-q1');
      expect(root.lookup(r.itemId)?.kind).toBe('request_decision');
    });
  });
});
