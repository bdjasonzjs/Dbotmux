/**
 * Test matrix for `DispatchChatCreatedOpts` richer fields persisting into
 * ChatContext + welcome card on FIRST dispatch (no "send empty card, then
 * update" anti-pattern).
 *
 * Spec: docs/superpowers/plans/2026-05-24-p1-main-bot-subtask-spawn.md §1.5
 *
 * **Commit #1 (this commit)** — types-only. All runtime assertions are
 * `it.todo` placeholders; opened in commit #5 when dispatchChatCreated
 * body actually persists the new fields.
 *
 * Run:  pnpm vitest run test/dispatch-chat-created-rich-context.test.ts
 */
import { describe, it, expect } from 'vitest';
import type { DispatchChatCreatedOpts } from '../src/im/lark/chat-created-handler.js';

describe('dispatchChatCreated: rich context plumbing', () => {
  describe('Types — opts contract', () => {
    it('DispatchChatCreatedOpts accepts the richer fields (compile-time only)', () => {
      const opts: DispatchChatCreatedOpts = {
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
      // Compile-time success is the assertion. Runtime sanity:
      expect(opts.taskType).toBe('prd');
      expect(opts.rules?.length).toBe(1);
    });
  });

  describe('D1 — ChatContext.read() after dispatch has all rich fields', () => {
    it.todo('dispatch with rich opts persists taskType / rules / relatedRefs / activeTodoRefs / parentDigest into ChatContext');
  });

  describe('D2 — first welcome card sees rich ctx (mock sendContextCard)', () => {
    it.todo('first welcome card render receives ctx containing rules + relatedRefs + activeTodoRefs + participants — not empty defaults');
  });

  describe('D3 — second dispatch is idempotent (no rewrite/resend)', () => {
    it.todo('same chatId second dispatch hits ChatContext.create idempotency, no second card sent');
  });

  describe('D-PP — three-bot participants array persists fully', () => {
    it.todo('participants=三 bot 数组 → ChatContext.participants length=3, all three openIds present');
  });
});
