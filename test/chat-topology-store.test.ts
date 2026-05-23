/**
 * Unit tests for chat-topology-store.
 *
 * Run:  pnpm vitest run test/chat-topology-store.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: {
    get session() { return { dataDir: tempDir }; },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

async function freshImport() {
  vi.resetModules();
  return await import('../src/services/chat-topology-store.js');
}

describe('chat-topology-store', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'topology-test-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('readTopology returns empty topology when file missing', async () => {
    const store = await freshImport();
    const topo = store.readTopology();
    expect(topo.nodes).toEqual([]);
    expect(topo.edges).toEqual([]);
  });

  it('upsertNode adds new node + replaces existing', async () => {
    const store = await freshImport();
    const node = {
      chatId: 'oc_a',
      name: 'Chat A',
      chatType: 'group' as const,
      originType: 'bot_spawned' as const,
      parentChatId: null,
      tags: [],
      metrics: { lastMessageAt: null, messages24h: 0, hasUnansweredPing: false },
      summary: '',
    };
    store.upsertNode(node);
    expect(store.getNode('oc_a')?.name).toBe('Chat A');

    store.upsertNode({ ...node, name: 'Chat A renamed' });
    expect(store.getNode('oc_a')?.name).toBe('Chat A renamed');
    expect(store.readTopology().nodes.length).toBe(1);  // not duplicated
  });

  it('addEdge dedups by (from, to, type)', async () => {
    const store = await freshImport();
    const edge = { type: 'parent_child' as const, fromChatId: 'a', toChatId: 'b', rationale: 'r' };
    store.addEdge(edge);
    store.addEdge(edge);
    store.addEdge({ ...edge, rationale: 'r2' });  // same dedup key
    expect(store.readTopology().edges.length).toBe(1);

    store.addEdge({ ...edge, type: 'same_topic' });  // different type → new edge
    expect(store.readTopology().edges.length).toBe(2);
  });

  it('bumpMessage creates node if missing + increments metrics', async () => {
    const store = await freshImport();
    store.bumpMessage('oc_new', 'New Chat', 'bot_spawned');
    const node = store.getNode('oc_new');
    expect(node?.name).toBe('New Chat');
    expect(node?.metrics.messages24h).toBe(1);
    expect(node?.metrics.lastMessageAt).toBeTruthy();

    store.bumpMessage('oc_new');
    expect(store.getNode('oc_new')?.metrics.messages24h).toBe(2);
  });

  it('setUnansweredPing toggles on existing node', async () => {
    const store = await freshImport();
    store.bumpMessage('oc_p');
    store.setUnansweredPing('oc_p', true);
    expect(store.getNode('oc_p')?.metrics.hasUnansweredPing).toBe(true);
    store.setUnansweredPing('oc_p', false);
    expect(store.getNode('oc_p')?.metrics.hasUnansweredPing).toBe(false);
  });

  it('setUnansweredPing on missing node is no-op (no throw)', async () => {
    const store = await freshImport();
    expect(() => store.setUnansweredPing('oc_missing', true)).not.toThrow();
  });

  it('heatFromLastMessage classifies hot/warm/cold correctly', async () => {
    const store = await freshImport();
    const now = Date.now();
    expect(store.heatFromLastMessage(new Date(now - 30 * 60 * 1000).toISOString())).toBe('hot');     // 30 min
    expect(store.heatFromLastMessage(new Date(now - 5 * 60 * 60 * 1000).toISOString())).toBe('warm'); // 5 h
    expect(store.heatFromLastMessage(new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString())).toBe('cold'); // 2 d
    expect(store.heatFromLastMessage(null)).toBe('cold');
  });

  it('writes are atomic — no .tmp file leftover after write', async () => {
    const store = await freshImport();
    store.bumpMessage('oc_atomic');
    expect(existsSync(join(tempDir, 'chat-topology.json.tmp'))).toBe(false);
    expect(existsSync(join(tempDir, 'chat-topology.json'))).toBe(true);
  });
});
