/**
 * Regression: scout escalation pipeline must only fire on bot_spawned chats.
 *
 * P6 product decision (松松, 2026-05-24):
 *   - 协作面板 / scout escalation = task tracker → only bot_spawned chats
 *   - 信息搜集 (digest, topology ingest) = unchanged → all chats
 *
 * Previous bug: 松松 was getting "blocked"-keyword pings from a chat he
 * pulled the bots into purely for Q&A — that chat was human_created, not
 * a real task, but R5 (stuck-keyword) fired anyway and ping-spammed him.
 *
 * Fix lives in `scout-spawner.runScoutTick`:
 *     activeNodes = topo.nodes.filter(n =>
 *         !isArchived(n.chatId) && n.originType === 'bot_spawned')
 *
 * This test exercises the filter via runScoutTick (which depends on the
 * real chat-topology-store + main-bot-digest-store + escalation engine).
 * Each test gets a fresh dataDir so writes don't leak across tests or
 * pollute the real ~/.botmux/data.
 *
 * Run:  pnpm vitest run test/scout-spawner-bot-spawned-filter.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

async function freshImports() {
  vi.resetModules();
  const scout = await import('../src/core/scout-spawner.js');
  const topo = await import('../src/services/chat-topology-store.js');
  const digest = await import('../src/services/main-bot-digest-store.js');
  return { scout, topo, digest };
}

describe('scout-spawner originType filter (P6 regression)', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scout-bot-spawned-filter-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('R5 (stuck keyword) does NOT fire on human_created chats', async () => {
    const { scout, topo, digest } = await freshImports();
    topo.upsertNode({
      chatId: 'oc_human_qna',
      name: 'Random Q&A群',
      chatType: 'group',
      originType: 'human_created',
      parentChatId: null,
      tags: [],
      metrics: { lastMessageAt: new Date().toISOString(), messages24h: 5, hasUnansweredPing: false },
      summary: 'this is blocked on something — error somewhere',  // contains "blocked" + "error"
    });
    // baseline: no inbox state
    digest.writeInbox({ pending: [], processed: [] });

    const result = await scout.runScoutTick(undefined);

    expect(result.escalationsAdded).toBe(0);
    expect(result.digest.escalations.find(e => e.chatId === 'oc_human_qna')).toBeUndefined();
  });

  it('R5 (stuck keyword) DOES fire on bot_spawned chats', async () => {
    const { scout, topo, digest } = await freshImports();
    topo.upsertNode({
      chatId: 'oc_bot_task',
      name: 'CUA Task',
      chatType: 'group',
      originType: 'bot_spawned',
      parentChatId: 'oc_parent',
      tags: [],
      metrics: { lastMessageAt: new Date().toISOString(), messages24h: 5, hasUnansweredPing: false },
      summary: 'we are blocked on the auth refactor',
    });
    digest.writeInbox({ pending: [], processed: [] });

    const result = await scout.runScoutTick(undefined);

    const r5 = result.digest.escalations.find(e => e.chatId === 'oc_bot_task' && e.ruleId === 'R5');
    expect(r5).toBeTruthy();
  });

  it('p2p chats are also skipped (they should never enter the board)', async () => {
    const { scout, topo, digest } = await freshImports();
    topo.upsertNode({
      chatId: 'oc_p2p_chat',
      name: '私聊',
      chatType: 'p2p',
      originType: 'p2p',
      parentChatId: null,
      tags: [],
      metrics: { lastMessageAt: new Date().toISOString(), messages24h: 5, hasUnansweredPing: false },
      summary: 'blocked',
    });
    digest.writeInbox({ pending: [], processed: [] });

    const result = await scout.runScoutTick(undefined);
    expect(result.escalationsAdded).toBe(0);
  });

  it('pendingForJason also filtered (Finding 1 regression): human_created with unanswered ping does NOT enter pending tray', async () => {
    // Tray surface is task-tracking, same scoping as escalation.
    // digest.chats still includes the human_created chat (info-gathering),
    // but pendingForJason must drop it.
    const { scout, topo, digest } = await freshImports();
    topo.upsertNode({
      chatId: 'oc_human_with_ping',
      name: '问答群',
      chatType: 'group',
      originType: 'human_created',
      parentChatId: null,
      tags: [],
      metrics: { lastMessageAt: new Date().toISOString(), messages24h: 1, hasUnansweredPing: true },
      summary: '',
    });
    topo.upsertNode({
      chatId: 'oc_bot_with_ping',
      name: '任务群',
      chatType: 'group',
      originType: 'bot_spawned',
      parentChatId: 'oc_parent',
      tags: [],
      metrics: { lastMessageAt: new Date().toISOString(), messages24h: 1, hasUnansweredPing: true },
      summary: '',
    });
    digest.writeInbox({ pending: [], processed: [] });

    const result = await scout.runScoutTick(undefined);
    const pendingIds = new Set(result.digest.pendingForJason.map(p => p.chatId));
    expect(pendingIds.has('oc_bot_with_ping')).toBe(true);   // task → in tray
    expect(pendingIds.has('oc_human_with_ping')).toBe(false); // info-gather → not in tray
    // But the human chat IS still in digest.chats for main-bot context
    const chatIds = new Set(result.digest.chats.map(c => c.chatId));
    expect(chatIds.has('oc_human_with_ping')).toBe(true);
  });

  it('P2 #4: scout auto-closes root-inbox when escalation condition stops firing', async () => {
    const { scout, topo, digest } = await freshImports();
    const root = await import('../src/services/root-inbox-store.js');
    // 1) Setup: an R5-triggering chat with "stuck" in summary
    topo.upsertNode({
      chatId: 'oc_bot_stuck',
      name: 'CUA Task',
      chatType: 'group',
      originType: 'bot_spawned',
      parentChatId: 'oc_parent',
      tags: [],
      metrics: { lastMessageAt: new Date().toISOString(), messages24h: 5, hasUnansweredPing: false },
      summary: 'CI build is blocked',
    });
    digest.writeInbox({ pending: [], processed: [] });
    // 2) Simulate that we already have an open R5 root-inbox item from a
    //    prior tick (manually inserted; in production it'd come from sink).
    root.upsertOpen({
      id: 'R5:oc_bot_stuck', kind: 'escalation', subChatId: 'oc_bot_stuck',
      subChatName: 'CUA Task', ruleId: 'R5', summary: 'blocked',
    });
    expect(root.lookup('R5:oc_bot_stuck')?.status).toBe('open');

    // 3) Tick 1: R5 still fires (summary still contains "blocked"). Item
    //    should stay open (its dedup id matches stillFiring set).
    await scout.runScoutTick(undefined);
    expect(root.lookup('R5:oc_bot_stuck')?.status).toBe('open');

    // 4) Now resolve the blocker: change summary to a non-stuck one.
    topo.upsertNode({
      chatId: 'oc_bot_stuck',
      name: 'CUA Task',
      chatType: 'group',
      originType: 'bot_spawned',
      parentChatId: 'oc_parent',
      tags: [],
      metrics: { lastMessageAt: new Date().toISOString(), messages24h: 6, hasUnansweredPing: false },
      summary: 'CI fixed, ready to merge',
    });
    digest.writeInbox({ pending: [], processed: [] });

    // 5) Tick 2: R5 should NOT fire → scout auto-closes the open item.
    await scout.runScoutTick(undefined);
    expect(root.lookup('R5:oc_bot_stuck')?.status).toBe('closed');
  });

  it('digest still includes ALL chats (info-gathering link is untouched)', async () => {
    // 松松's explicit instruction: 信息搜集 (digest) for main-bot context
    // continues to include every chat the bot is in, even though the
    // board only renders bot_spawned. Only escalation rules get filtered.
    const { scout, topo, digest } = await freshImports();
    topo.upsertNode({
      chatId: 'oc_human_qna',
      name: 'Q&A',
      chatType: 'group',
      originType: 'human_created',
      parentChatId: null,
      tags: [],
      metrics: { lastMessageAt: new Date().toISOString(), messages24h: 3, hasUnansweredPing: false },
      summary: 'context for main bot',
    });
    topo.upsertNode({
      chatId: 'oc_bot_task',
      name: 'Task',
      chatType: 'group',
      originType: 'bot_spawned',
      parentChatId: 'oc_parent',
      tags: [],
      metrics: { lastMessageAt: new Date().toISOString(), messages24h: 9, hasUnansweredPing: false },
      summary: 'normal task progress',
    });
    digest.writeInbox({ pending: [], processed: [] });

    const result = await scout.runScoutTick(undefined);

    // Both chats present in the digest
    const ids = new Set(result.digest.chats.map(c => c.chatId));
    expect(ids.has('oc_human_qna')).toBe(true);
    expect(ids.has('oc_bot_task')).toBe(true);
  });
});
