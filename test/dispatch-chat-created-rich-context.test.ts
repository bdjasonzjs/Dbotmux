/**
 * Test matrix for `DispatchChatCreatedOpts` richer fields persisting into
 * ChatContext + welcome card on FIRST dispatch.
 *
 * Spec: docs/superpowers/plans/2026-05-24-p1-main-bot-subtask-spawn.md §1.5
 *
 * **Commit #5** opens D1/D2/D3/D-PP — verifies dispatchChatCreated body
 * persists the rich fields into ChatContext on first write, and welcome
 * card sees them (no "send empty card, then update" anti-pattern).
 *
 * Run:  pnpm vitest run test/dispatch-chat-created-rich-context.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

const mockSendContextCard = vi.fn(async () => 'om_card_id');
vi.mock('../src/im/lark/chat-context-card.js', () => ({
  sendContextCard: (...args: any[]) => mockSendContextCard(...args),
}));

// chat-created-handler imports getBot etc. — minimal mocks
vi.mock('../src/bot-registry.js', () => ({
  getBot: () => ({ botOpenId: 'ou_bot' }),
  getAllBots: () => [],
}));

async function freshImport() {
  vi.resetModules();
  return {
    handler: await import('../src/im/lark/chat-created-handler.js'),
    store: await import('../src/services/chat-context-store.js'),
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'dispatch-rich-'));
  vi.clearAllMocks();
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('dispatchChatCreated: rich context plumbing (P1 commit #5)', () => {
  describe('Types — opts contract', () => {
    it('DispatchChatCreatedOpts accepts the richer fields (compile-time)', async () => {
      const { handler } = await freshImport();
      type Opts = Parameters<typeof handler.dispatchChatCreated>[0];
      const opts: Opts = {
        chatId: 'oc_compile_test',
        larkAppId: 'cli_x',
        originType: 'bot_spawned',
        parentChatId: 'oc_parent',
        purpose: 'analyse PRD',
        participants: [{ openId: 'ou_a', role: 'main bot' }],
        relatedRefs: ['https://wiki/p1'],
        activeTodoRefs: ['om_root_msg'],
        rules: ['先读 PRD 全文'],
        parentDigest: 'parent chat 24h digest text',
        taskType: 'prd',
      };
      expect(opts.taskType).toBe('prd');
    });
  });

  describe('D1 — ChatContext.read() after dispatch has all rich fields', () => {
    it('persists taskType / rules / relatedRefs / activeTodoRefs / parentDigest', async () => {
      const { handler, store } = await freshImport();
      await handler.dispatchChatCreated({
        chatId: 'oc_d1_chat',
        larkAppId: 'cli_x',
        originType: 'bot_spawned',
        parentChatId: 'oc_d1_parent',
        purpose: 'analyse PRD ABC',
        participants: [{ openId: 'ou_claude', role: 'main bot' }],
        relatedRefs: ['https://wiki/prd-abc', 'https://issue/123'],
        activeTodoRefs: ['om_root_d1'],
        rules: ['先读 PRD 全文', '模糊点列清单'],
        parentDigest: '父群 24h 摘要文本',
        taskType: 'prd',
      });
      const ctx = store.read('oc_d1_chat');
      expect(ctx).not.toBeNull();
      expect(ctx!.taskType).toBe('prd');
      expect(ctx!.rules).toEqual(['先读 PRD 全文', '模糊点列清单']);
      expect(ctx!.relatedRefs).toEqual(['https://wiki/prd-abc', 'https://issue/123']);
      expect(ctx!.activeTodoRefs).toEqual(['om_root_d1']);
      expect(ctx!.inheritedFrom?.parentDigest).toBe('父群 24h 摘要文本');
      expect(ctx!.inheritedFrom?.parentChatId).toBe('oc_d1_parent');
    });
  });

  describe('D2 — first welcome card sees rich ctx', () => {
    it('sendContextCard fires on first dispatch (card builder reads same ChatContext file)', async () => {
      const { handler } = await freshImport();
      await handler.dispatchChatCreated({
        chatId: 'oc_d2_chat',
        larkAppId: 'cli_x',
        originType: 'bot_spawned',
        parentChatId: null,
        purpose: 'task',
        rules: ['rule one'],
        relatedRefs: ['ref1'],
        activeTodoRefs: ['todo1'],
        taskType: 'misc',
      });
      // sendContextCard fired exactly once for this first dispatch
      expect(mockSendContextCard).toHaveBeenCalledTimes(1);
      expect(mockSendContextCard.mock.calls[0]).toEqual(['cli_x', 'oc_d2_chat']);
    });
  });

  describe('D3 — second dispatch is idempotent', () => {
    it('same chatId second dispatch does not rewrite ChatContext or resend card', async () => {
      const { handler, store } = await freshImport();
      await handler.dispatchChatCreated({
        chatId: 'oc_d3_chat',
        larkAppId: 'cli_x',
        originType: 'bot_spawned',
        purpose: 'first',
        rules: ['original rule'],
      });
      const first = store.read('oc_d3_chat');
      await handler.dispatchChatCreated({
        chatId: 'oc_d3_chat',
        larkAppId: 'cli_x',
        originType: 'bot_spawned',
        purpose: 'should not overwrite',
        rules: ['changed rule'],
      });
      const second = store.read('oc_d3_chat');
      // ChatContext.create idempotency means first writer wins
      expect(second!.purpose).toBe('first');
      expect(second!.rules).toEqual(['original rule']);
      // Welcome card sent only on first dispatch
      expect(mockSendContextCard).toHaveBeenCalledTimes(1);
    });
  });

  describe('D-PP — three-bot participants array persists fully', () => {
    it('participants=三 bot 数组 → ChatContext.participants length=3, all openIds present', async () => {
      const { handler, store } = await freshImport();
      const participants = [
        { openId: 'ou_claude', role: 'main bot' },
        { openId: 'ou_codex',  role: 'reviewer/sister' },
        { openId: 'ou_tilly',  role: 'scout' },
      ];
      await handler.dispatchChatCreated({
        chatId: 'oc_dpp_chat',
        larkAppId: 'cli_x',
        originType: 'bot_spawned',
        participants,
        taskType: 'bug',
      });
      const ctx = store.read('oc_dpp_chat');
      expect(ctx!.participants).toHaveLength(3);
      expect(ctx!.participants.map(p => p.openId).sort()).toEqual(
        ['ou_claude', 'ou_codex', 'ou_tilly']);
    });
  });
});
