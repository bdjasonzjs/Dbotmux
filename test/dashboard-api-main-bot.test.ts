/**
 * Smoke tests for P4 dashboard main-bot API routes.
 *
 * Tests the stores wired through to dashboard handlers — the actual HTTP
 * routing in dashboard.ts is exercised via curl in dogfood, but we cover
 * the data plane (read/write/dedup) here with mocked dataDir.
 *
 * Run:  pnpm vitest run test/dashboard-api-main-bot.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: {
    get session() { return { dataDir: tempDir }; },
    dashboard: { externalHost: 'localhost', port: 7891 },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'dashboard-api-test-')); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

async function freshImports() {
  vi.resetModules();
  return {
    topology: await import('../src/services/chat-topology-store.js'),
    context: await import('../src/services/chat-context-store.js'),
    digest: await import('../src/services/main-bot-digest-store.js'),
  };
}

describe('/api/topology (filter)', () => {
  it('filters by originType when query param provided', async () => {
    const { topology } = await freshImports();
    topology.upsertNode({
      chatId: 'oc_h', name: 'human', chatType: 'group', originType: 'human_created',
      parentChatId: null, tags: [], metrics: { lastMessageAt: null, messages24h: 0, hasUnansweredPing: false }, summary: '',
    });
    topology.upsertNode({
      chatId: 'oc_b', name: 'bot', chatType: 'group', originType: 'bot_spawned',
      parentChatId: null, tags: [], metrics: { lastMessageAt: null, messages24h: 0, hasUnansweredPing: false }, summary: '',
    });
    const all = topology.readTopology();
    expect(all.nodes.length).toBe(2);
    // simulate handler-side filtering
    const filtered = all.nodes.filter(n => n.originType === 'bot_spawned');
    expect(filtered.length).toBe(1);
    expect(filtered[0].chatId).toBe('oc_b');
  });
});

describe('/api/contexts/:chatId', () => {
  it('returns ChatContext when found, null when missing', async () => {
    const { context } = await freshImports();
    context.create('oc_x', {
      purpose: 'p', originType: 'bot_spawned', parentChatId: null, participants: [],
    });
    expect(context.read('oc_x')).toBeTruthy();
    expect(context.read('oc_unknown')).toBeNull();
  });
});

describe('/api/topology/edges (POST)', () => {
  it('dedups edges by (from, to, type)', async () => {
    const { topology } = await freshImports();
    topology.addEdge({ type: 'parent_child', fromChatId: 'a', toChatId: 'b', rationale: 'r1' });
    topology.addEdge({ type: 'parent_child', fromChatId: 'a', toChatId: 'b', rationale: 'r2' });
    expect(topology.readTopology().edges.length).toBe(1);
  });

  it('allows multiple edges with same endpoints but different types', async () => {
    const { topology } = await freshImports();
    topology.addEdge({ type: 'parent_child', fromChatId: 'a', toChatId: 'b', rationale: 'parent' });
    topology.addEdge({ type: 'same_topic', fromChatId: 'a', toChatId: 'b', rationale: 'topic' });
    expect(topology.readTopology().edges.length).toBe(2);
  });
});

describe('/api/digest + /api/scout-inbox', () => {
  it('exposes digest + stale flag', async () => {
    const { digest } = await freshImports();
    expect(digest.readDigest().chats).toEqual([]);  // empty initially
    expect(digest.isStale()).toBe(false);
    digest.markStale();
    expect(digest.isStale()).toBe(true);
  });

  it('exposes inbox pending + processed', async () => {
    const { digest } = await freshImports();
    digest.enqueueEscalation({ ruleId: 'R1', triggeredAt: 'x', chatId: 'c', context: 'c', payload: {} });
    const inbox = digest.readInbox();
    expect(inbox.pending.length).toBe(1);
    expect(inbox.processed.length).toBe(0);
  });
});
