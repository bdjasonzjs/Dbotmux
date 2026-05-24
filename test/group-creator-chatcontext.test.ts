/**
 * Test matrix for `CreateGroupOpts.chatContext` plumbing.
 *
 * Spec: docs/superpowers/plans/2026-05-24-p1-main-bot-subtask-spawn.md §1.5
 *
 * **Commit #4** opens C2/C3/C9/C10/C-PP-pass — verifies createGroupWithBots
 * forwards richer chatContext fields straight through to dispatchChatCreated
 * (no swallowing, no extra derivation).
 *
 * Run:  pnpm vitest run test/group-creator-chatcontext.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CreateGroupOpts } from '../src/services/group-creator.js';

// Mock the underlying Lark client to return a stable success — we don't
// want to hit real Lark in tests, only verify our service-layer plumbing.
const mockCreateChat = vi.fn(async () => ({
  chatId: 'oc_test_chat',
  invalidBotIds: [] as string[],
  invalidUserIds: [] as string[],
}));
const mockTransferChatOwner = vi.fn(async () => ({ ok: true as const }));
const mockGetChatOwner = vi.fn(async () => 'ou_someone');

vi.mock('../src/services/groups-store.js', () => ({
  createChat: (...args: any[]) => mockCreateChat(...args),
  transferChatOwner: (...args: any[]) => mockTransferChatOwner(...args),
  getChatOwner: (...args: any[]) => mockGetChatOwner(...args),
}));

const mockSendMessage = vi.fn(async () => 'om_notify');
vi.mock('../src/im/lark/client.js', () => ({
  sendMessage: (...args: any[]) => mockSendMessage(...args),
}));

const mockBindOncall = vi.fn();
vi.mock('../src/services/oncall-store.js', () => ({
  bindOncall: (...args: any[]) => mockBindOncall(...args),
}));

const mockDispatchChatCreated = vi.fn(async () => undefined);
vi.mock('../src/im/lark/chat-created-handler.js', () => ({
  dispatchChatCreated: (...args: any[]) => mockDispatchChatCreated(...args),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

// Import the SUT after all mocks are wired.
import { createGroupWithBots } from '../src/services/group-creator.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('group-creator: chatContext plumbing (P1 commit #4)', () => {
  describe('C1 — backward compat: chatContext omitted', () => {
    it('CreateGroupOpts.chatContext is optional in the type', () => {
      const opts: CreateGroupOpts = {
        creatorLarkAppId: 'cli_x',
        larkAppIds: ['cli_y'],
        name: 'legacy /group call without chatContext',
      };
      expect(opts.chatContext).toBeUndefined();
    });
    it('legacy call (no chatContext) still dispatches with purpose-only', async () => {
      await createGroupWithBots({
        creatorLarkAppId: 'cli_x',
        larkAppIds: ['cli_y'],
        name: 'legacy',
        purpose: 'do something',
      });
      expect(mockDispatchChatCreated).toHaveBeenCalledTimes(1);
      const dispatchOpts = mockDispatchChatCreated.mock.calls[0][0];
      expect(dispatchOpts.purpose).toBe('do something');
      // Rich fields all undefined (no chatContext provided)
      expect(dispatchOpts.rules).toBeUndefined();
      expect(dispatchOpts.relatedRefs).toBeUndefined();
      expect(dispatchOpts.activeTodoRefs).toBeUndefined();
      expect(dispatchOpts.participants).toBeUndefined();
      expect(dispatchOpts.parentDigest).toBeUndefined();
      expect(dispatchOpts.taskType).toBeUndefined();
    });
  });

  describe('C2 — chatContext fields plumb to dispatchChatCreated', () => {
    it('taskType / rules / relatedRefs / activeTodoRefs / taskType forwarded verbatim', async () => {
      await createGroupWithBots({
        creatorLarkAppId: 'cli_x',
        larkAppIds: ['cli_y'],
        chatContext: {
          taskType: 'prd',
          rules: ['先读 PRD 全文', '模糊点列清单'],
          relatedRefs: ['https://wiki/prd-abc'],
          activeTodoRefs: ['om_root_msg'],
        },
      });
      expect(mockDispatchChatCreated).toHaveBeenCalledTimes(1);
      const dispatchOpts = mockDispatchChatCreated.mock.calls[0][0];
      expect(dispatchOpts.taskType).toBe('prd');
      expect(dispatchOpts.rules).toEqual(['先读 PRD 全文', '模糊点列清单']);
      expect(dispatchOpts.relatedRefs).toEqual(['https://wiki/prd-abc']);
      expect(dispatchOpts.activeTodoRefs).toEqual(['om_root_msg']);
    });
  });

  describe('C3 — parentDigest + sourceChatId → both forwarded', () => {
    it('chatContext.parentDigest forwarded alongside sourceChatId (parentChatId)', async () => {
      await createGroupWithBots({
        creatorLarkAppId: 'cli_x',
        larkAppIds: ['cli_y'],
        sourceChatId: 'oc_parent',
        chatContext: { parentDigest: '24h 内父群讨论了 X / Y / Z' },
      });
      const dispatchOpts = mockDispatchChatCreated.mock.calls[0][0];
      expect(dispatchOpts.parentChatId).toBe('oc_parent');
      expect(dispatchOpts.parentDigest).toBe('24h 内父群讨论了 X / Y / Z');
    });
  });

  describe('C9 — transferOwnerTo conditional (omit → no transfer call)', () => {
    it('omitting transferOwnerTo skips the transfer call', async () => {
      await createGroupWithBots({
        creatorLarkAppId: 'cli_x',
        larkAppIds: ['cli_y'],
        // transferOwnerTo deliberately omitted
      });
      expect(mockTransferChatOwner).not.toHaveBeenCalled();
    });
    it('passing transferOwnerTo triggers the transfer call', async () => {
      await createGroupWithBots({
        creatorLarkAppId: 'cli_x',
        larkAppIds: ['cli_y'],
        userOpenIds: ['ou_user'],
        transferOwnerTo: 'ou_user',
      });
      expect(mockTransferChatOwner).toHaveBeenCalledTimes(1);
    });
  });

  describe('C10 — notifyOwnerOpenId conditional (omit → no @ notify)', () => {
    it('omitting notifyOwnerOpenId skips the @-mention notify call', async () => {
      await createGroupWithBots({
        creatorLarkAppId: 'cli_x',
        larkAppIds: ['cli_y'],
        // notifyOwnerOpenId deliberately omitted
      });
      expect(mockSendMessage).not.toHaveBeenCalled();
    });
    it('passing notifyOwnerOpenId triggers the notify call', async () => {
      await createGroupWithBots({
        creatorLarkAppId: 'cli_x',
        larkAppIds: ['cli_y'],
        userOpenIds: ['ou_user'],
        notifyOwnerOpenId: 'ou_user',
      });
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('C-PP-pass — Playbook-resolved participants pass through unchanged', () => {
    it('chatContext.participants (already resolved) forwarded verbatim — no derivation', async () => {
      const participants = [
        { openId: 'ou_claude', role: 'main bot' },
        { openId: 'ou_codex',  role: 'reviewer/sister' },
        { openId: 'ou_tilly',  role: 'scout' },
      ];
      await createGroupWithBots({
        creatorLarkAppId: 'cli_x',
        larkAppIds: ['cli_y'],
        chatContext: { participants },
      });
      const dispatchOpts = mockDispatchChatCreated.mock.calls[0][0];
      expect(dispatchOpts.participants).toEqual(participants);
      expect(dispatchOpts.participants).toHaveLength(3);
    });
  });

  // The following cases used to live here in spec v0.1-v0.3, but per spec
  // v0.4 they belong to the idempotency-store / Playbook test files
  // because group-creator no longer knows about idempotency at all:
  //   C4 / C5 / C6 / C7 / C7b / C8 → test/spawn-idempotency-store.test.ts
  //                                → test/main-bot-playbook-spawn-subtask.test.ts
});
