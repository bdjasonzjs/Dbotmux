/**
 * Unit tests for P2/10 escalation rules engine.
 *
 * Run:  pnpm vitest run test/escalation-rules.test.ts
 */
import { describe, it, expect } from 'vitest';
import { runEscalationRules } from '../src/core/escalation-rules.js';

function mkNode(overrides: Partial<import('../src/services/chat-topology-store.js').ChatNode> = {}) {
  return {
    chatId: 'oc_default',
    name: 'Default',
    chatType: 'group' as const,
    originType: 'human_created' as const,
    parentChatId: null,
    tags: [],
    metrics: { lastMessageAt: null, messages24h: 0, hasUnansweredPing: false },
    summary: '',
    ...overrides,
  };
}

const NOW = Date.parse('2026-05-24T00:00:00Z');

describe('escalation-rules', () => {
  describe('R1 (unanswered ping > 30 min)', () => {
    it('fires when ping is old enough', () => {
      const node = mkNode({
        chatId: 'oc_r1', name: 'CUA',
        metrics: { lastMessageAt: null, messages24h: 0, hasUnansweredPing: true },
      });
      const pings = new Map([['oc_r1', new Date(NOW - 45 * 60 * 1000).toISOString()]]);
      const out = runEscalationRules({ nodes: [node], inbox: { pending: [], processed: [] }, now: NOW, unansweredPings: pings });
      const r1 = out.find(e => e.ruleId === 'R1');
      expect(r1).toBeTruthy();
      expect(r1!.chatId).toBe('oc_r1');
      expect((r1!.payload as any).sinceMinutes).toBe(45);
    });

    it('does NOT fire when ping is within 30 min', () => {
      const node = mkNode({ chatId: 'oc_young', metrics: { lastMessageAt: null, messages24h: 0, hasUnansweredPing: true } });
      const pings = new Map([['oc_young', new Date(NOW - 5 * 60 * 1000).toISOString()]]);
      const out = runEscalationRules({ nodes: [node], inbox: { pending: [], processed: [] }, now: NOW, unansweredPings: pings });
      expect(out.find(e => e.ruleId === 'R1')).toBeUndefined();
    });

    it('does NOT fire when hasUnansweredPing=false', () => {
      const node = mkNode({ chatId: 'oc_clear', metrics: { lastMessageAt: null, messages24h: 0, hasUnansweredPing: false } });
      const pings = new Map([['oc_clear', new Date(NOW - 100 * 60 * 1000).toISOString()]]);
      const out = runEscalationRules({ nodes: [node], inbox: { pending: [], processed: [] }, now: NOW, unansweredPings: pings });
      expect(out.find(e => e.ruleId === 'R1')).toBeUndefined();
    });
  });

  describe('R2 (same theme ≥ 2 chats + 24h no convergence)', () => {
    it('fires when two chats share a tag + both recent', () => {
      const recent = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
      const nodes = [
        mkNode({ chatId: 'oc_a', tags: ['ticket-cua'], metrics: { lastMessageAt: recent, messages24h: 10, hasUnansweredPing: false } }),
        mkNode({ chatId: 'oc_b', tags: ['ticket-cua'], metrics: { lastMessageAt: recent, messages24h: 10, hasUnansweredPing: false } }),
      ];
      const out = runEscalationRules({ nodes, inbox: { pending: [], processed: [] }, now: NOW });
      const r2 = out.find(e => e.ruleId === 'R2');
      expect(r2).toBeTruthy();
      expect((r2!.payload as any).chatIds).toEqual(['oc_a', 'oc_b']);
      expect((r2!.payload as any).theme).toBe('ticket-cua');
    });

    it('does NOT fire when only one chat has the tag', () => {
      const recent = new Date(NOW - 1 * 60 * 60 * 1000).toISOString();
      const nodes = [
        mkNode({ chatId: 'oc_solo', tags: ['unique'], metrics: { lastMessageAt: recent, messages24h: 5, hasUnansweredPing: false } }),
      ];
      const out = runEscalationRules({ nodes, inbox: { pending: [], processed: [] }, now: NOW });
      expect(out.find(e => e.ruleId === 'R2')).toBeUndefined();
    });

    it('does NOT fire when one chat is cold (>24h)', () => {
      const recent = new Date(NOW - 1 * 60 * 60 * 1000).toISOString();
      const cold = new Date(NOW - 48 * 60 * 60 * 1000).toISOString();
      const nodes = [
        mkNode({ chatId: 'oc_a', tags: ['t'], metrics: { lastMessageAt: recent, messages24h: 1, hasUnansweredPing: false } }),
        mkNode({ chatId: 'oc_b', tags: ['t'], metrics: { lastMessageAt: cold, messages24h: 0, hasUnansweredPing: false } }),
      ];
      const out = runEscalationRules({ nodes, inbox: { pending: [], processed: [] }, now: NOW });
      expect(out.find(e => e.ruleId === 'R2')).toBeUndefined();
    });
  });

  describe('R3 (bot_spawned new chat > 1h no activity)', () => {
    it('fires for bot_spawned chat with old lastMessageAt + zero messages', () => {
      const oldStamp = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
      const node = mkNode({
        chatId: 'oc_r3', originType: 'bot_spawned',
        metrics: { lastMessageAt: oldStamp, messages24h: 0, hasUnansweredPing: false },
      });
      const out = runEscalationRules({ nodes: [node], inbox: { pending: [], processed: [] }, now: NOW });
      const r3 = out.find(e => e.ruleId === 'R3');
      expect(r3).toBeTruthy();
      expect((r3!.payload as any).ageMinutes).toBe(120);
    });

    it('does NOT fire for human_created chat', () => {
      const oldStamp = new Date(NOW - 5 * 60 * 60 * 1000).toISOString();
      const node = mkNode({ chatId: 'oc_h', originType: 'human_created', metrics: { lastMessageAt: oldStamp, messages24h: 0, hasUnansweredPing: false } });
      const out = runEscalationRules({ nodes: [node], inbox: { pending: [], processed: [] }, now: NOW });
      expect(out.find(e => e.ruleId === 'R3')).toBeUndefined();
    });

    it('does NOT fire when there have been messages (messages24h > 0)', () => {
      const oldStamp = new Date(NOW - 5 * 60 * 60 * 1000).toISOString();
      const node = mkNode({
        chatId: 'oc_active', originType: 'bot_spawned',
        metrics: { lastMessageAt: oldStamp, messages24h: 1, hasUnansweredPing: false },
      });
      const out = runEscalationRules({ nodes: [node], inbox: { pending: [], processed: [] }, now: NOW });
      expect(out.find(e => e.ruleId === 'R3')).toBeUndefined();
    });

    it('does NOT fire when chat is < 1h old', () => {
      const recent = new Date(NOW - 30 * 60 * 1000).toISOString();
      const node = mkNode({
        chatId: 'oc_fresh', originType: 'bot_spawned',
        metrics: { lastMessageAt: recent, messages24h: 0, hasUnansweredPing: false },
      });
      const out = runEscalationRules({ nodes: [node], inbox: { pending: [], processed: [] }, now: NOW });
      expect(out.find(e => e.ruleId === 'R3')).toBeUndefined();
    });
  });

  describe('R5 (stuck keywords in summary)', () => {
    it('fires when summary contains "卡住"', () => {
      const node = mkNode({ chatId: 'oc_stuck', summary: 'sp19 cherry-pick 卡住 conflict 解不开' });
      const out = runEscalationRules({ nodes: [node], inbox: { pending: [], processed: [] }, now: NOW });
      const r5 = out.find(e => e.ruleId === 'R5');
      expect(r5).toBeTruthy();
      expect((r5!.payload as any).keyword).toBe('卡住');
    });

    it('fires on English keyword "blocked"', () => {
      const node = mkNode({ chatId: 'oc_block', summary: 'CI is blocked by a leaky env' });
      const out = runEscalationRules({ nodes: [node], inbox: { pending: [], processed: [] }, now: NOW });
      const r5 = out.find(e => e.ruleId === 'R5');
      expect(r5).toBeTruthy();
      expect((r5!.payload as any).keyword).toBe('blocked');
    });

    it('does NOT fire when summary is clean', () => {
      const node = mkNode({ chatId: 'oc_ok', summary: 'shipping the feature today' });
      const out = runEscalationRules({ nodes: [node], inbox: { pending: [], processed: [] }, now: NOW });
      expect(out.find(e => e.ruleId === 'R5')).toBeUndefined();
    });
  });

  describe('R4 (bot互ping > 20 轮)', () => {
    it('is stubbed for v0.1 — never fires until LLM scout fills it', () => {
      const node = mkNode({ chatId: 'oc_loop' });
      const out = runEscalationRules({ nodes: [node], inbox: { pending: [], processed: [] }, now: NOW });
      expect(out.find(e => e.ruleId === 'R4')).toBeUndefined();
    });
  });

  describe('dedup with existing inbox', () => {
    it('skips R1 when an item with same (rule, chatId) is already pending', () => {
      const node = mkNode({ chatId: 'oc_dup', metrics: { lastMessageAt: null, messages24h: 0, hasUnansweredPing: true } });
      const pings = new Map([['oc_dup', new Date(NOW - 45 * 60 * 1000).toISOString()]]);
      const inbox = {
        pending: [{
          id: 'existing',
          enqueuedAt: 'x',
          status: 'pending' as const,
          resolvedBy: null,
          resolution: null,
          escalation: { ruleId: 'R1' as const, triggeredAt: 'x', chatId: 'oc_dup', context: 'old', payload: {} },
        }],
        processed: [],
      };
      const out = runEscalationRules({ nodes: [node], inbox, now: NOW, unansweredPings: pings });
      expect(out.find(e => e.ruleId === 'R1')).toBeUndefined();
    });

    it('does NOT dedup across different chats', () => {
      const nodeA = mkNode({ chatId: 'oc_a', metrics: { lastMessageAt: null, messages24h: 0, hasUnansweredPing: true } });
      const nodeB = mkNode({ chatId: 'oc_b', metrics: { lastMessageAt: null, messages24h: 0, hasUnansweredPing: true } });
      const pings = new Map([
        ['oc_a', new Date(NOW - 45 * 60 * 1000).toISOString()],
        ['oc_b', new Date(NOW - 45 * 60 * 1000).toISOString()],
      ]);
      const inbox = {
        pending: [{
          id: 'existing',
          enqueuedAt: 'x',
          status: 'pending' as const,
          resolvedBy: null,
          resolution: null,
          escalation: { ruleId: 'R1' as const, triggeredAt: 'x', chatId: 'oc_a', context: 'old', payload: {} },
        }],
        processed: [],
      };
      const out = runEscalationRules({ nodes: [nodeA, nodeB], inbox, now: NOW, unansweredPings: pings });
      const r1List = out.filter(e => e.ruleId === 'R1');
      expect(r1List.length).toBe(1);
      expect(r1List[0].chatId).toBe('oc_b');
    });
  });
});
