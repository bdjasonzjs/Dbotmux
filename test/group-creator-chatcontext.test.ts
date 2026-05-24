/**
 * Test matrix for `CreateGroupOpts.chatContext` plumbing.
 *
 * Spec: docs/superpowers/plans/2026-05-24-p1-main-bot-subtask-spawn.md §1.5
 *
 * **Commit #1 (this commit)** — types-only, body not yet implemented.
 * Most cases are `it.todo` placeholders that real product commits
 * (#4 `createGroupWithBots` body, #5 `dispatchChatCreated` body) open up.
 * Only C1 (existing-behavior regression) runs for real now.
 *
 * Run:  pnpm vitest run test/group-creator-chatcontext.test.ts
 */
import { describe, it, expect } from 'vitest';
import type { CreateGroupOpts } from '../src/services/group-creator.js';

describe('group-creator: chatContext plumbing', () => {
  describe('C1 — backward compat: chatContext omitted', () => {
    it('CreateGroupOpts.chatContext is optional in the type', () => {
      // Type-level assertion: omitting chatContext compiles.
      const opts: CreateGroupOpts = {
        creatorLarkAppId: 'cli_x',
        larkAppIds: ['cli_y'],
        name: 'legacy /group call without chatContext',
      };
      expect(opts.chatContext).toBeUndefined();
    });
  });

  describe('C2 — chatContext fields plumb to dispatchChatCreated', () => {
    it.todo('createGroupWithBots forwards chatContext.taskType/rules/relatedRefs to dispatchChatCreated (spy)');
  });

  describe('C3 — parentDigest + sourceChatId → ChatContext.inheritedFrom.parentDigest', () => {
    it.todo('chatContext.parentDigest with sourceChatId writes both into ChatContext.inheritedFrom');
  });

  describe('C9 — transferOwnerTo conditional', () => {
    it.todo('omitting transferOwnerTo skips the transfer call (no Lark transferChatOwner)');
  });

  describe('C10 — notifyOwnerOpenId conditional', () => {
    it.todo('omitting notifyOwnerOpenId skips the @-mention notify call (no sendMessage to owner)');
  });

  describe('C-PP-pass — Playbook-resolved participants pass through unchanged', () => {
    it.todo('chatContext.participants array (already resolved by caller) is forwarded to dispatchChatCreated verbatim — group-creator does no derivation');
  });

  // The following cases used to live here in spec v0.1-v0.3, but per spec
  // v0.4 they belong to the idempotency-store / Playbook test files
  // because group-creator no longer knows about idempotency at all:
  //   C4 / C5 / C6 / C7 / C7b / C8 → test/spawn-idempotency-store.test.ts
  //                                → test/main-bot-playbook-spawn-subtask.test.ts
});
