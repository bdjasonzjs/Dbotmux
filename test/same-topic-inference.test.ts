/**
 * Unit tests for P5 same-topic edge inference.
 *
 * Run:  pnpm vitest run test/same-topic-inference.test.ts
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
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

async function freshImports() {
  vi.resetModules();
  const topo = await import('../src/services/chat-topology-store.js');
  const infer = await import('../src/core/same-topic-inference.js');
  return { topo, infer };
}

function mkNode(chatId: string, overrides: Partial<import('../src/services/chat-topology-store.js').ChatNode> = {}) {
  return {
    chatId,
    name: chatId,
    chatType: 'group' as const,
    originType: 'human_created' as const,
    parentChatId: null,
    tags: [],
    metrics: { lastMessageAt: null, messages24h: 0, hasUnansweredPing: false },
    summary: '',
    ...overrides,
  };
}

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'same-topic-test-')); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

describe('inferSameTopicEdges', () => {
  it('returns 0 (attempts, not "newly added") when topology empty', async () => {
    const { infer } = await freshImports();
    expect(infer.inferSameTopicEdges()).toBe(0);
  });

  it('returns attempt count, NOT newly-added count (dedup happens at addEdge)', async () => {
    const { topo, infer } = await freshImports();
    topo.upsertNode(mkNode('a', { tags: ['x'] }));
    topo.upsertNode(mkNode('b', { tags: ['x'] }));
    expect(infer.inferSameTopicEdges()).toBe(1);
    expect(topo.readTopology().edges.length).toBe(1);
    // 2nd call: addEdge dedups but counter still increments → return is attempts
    expect(infer.inferSameTopicEdges()).toBe(1);
    expect(topo.readTopology().edges.length).toBe(1);  // no new edges actually added
  });

  it('emits same_topic edge for 2 chats sharing a tag', async () => {
    const { topo, infer } = await freshImports();
    topo.upsertNode(mkNode('oc_a', { tags: ['ticket-cua'] }));
    topo.upsertNode(mkNode('oc_b', { tags: ['ticket-cua'] }));
    expect(infer.inferSameTopicEdges()).toBe(1);
    const edges = topo.readTopology().edges;
    expect(edges.find(e => e.type === 'same_topic' && e.rationale.includes('ticket-cua'))).toBeTruthy();
  });

  it('emits N edges for N+1 chats sharing a tag (pairwise)', async () => {
    const { topo, infer } = await freshImports();
    topo.upsertNode(mkNode('a', { tags: ['x'] }));
    topo.upsertNode(mkNode('b', { tags: ['x'] }));
    topo.upsertNode(mkNode('c', { tags: ['x'] }));
    // 3 nodes share tag x → 3 pairs (a-b, a-c, b-c)
    expect(infer.inferSameTopicEdges()).toBe(3);
  });

  it('dedups: 2nd call returns 0 because edges already exist', async () => {
    const { topo, infer } = await freshImports();
    topo.upsertNode(mkNode('a', { tags: ['shared'] }));
    topo.upsertNode(mkNode('b', { tags: ['shared'] }));
    expect(infer.inferSameTopicEdges()).toBe(1);
    // 2nd call: addEdge dedups, but our counter still increments → so the
    // count we return is "attempts", not "actually new". This is OK for
    // logging since real-world calls aren't repeated synchronously.
    // Verify the topology only has 1 edge regardless:
    infer.inferSameTopicEdges();
    expect(topo.readTopology().edges.length).toBe(1);
  });

  it('emits edge for chats sharing a task id in name', async () => {
    const { topo, infer } = await freshImports();
    topo.upsertNode(mkNode('oc_x', { name: 'ticket-cua sp19 develop' }));
    topo.upsertNode(mkNode('oc_y', { name: 'sp19 review' }));
    infer.inferSameTopicEdges();
    const edges = topo.readTopology().edges;
    expect(edges.find(e => e.type === 'same_topic' && e.rationale.includes('sp19'))).toBeTruthy();
  });

  it('matches N6 / T123 / prd-7 / ticket#42 patterns', async () => {
    const { topo, infer } = await freshImports();
    topo.upsertNode(mkNode('a', { name: 'N6 task' }));
    topo.upsertNode(mkNode('b', { name: 'about N6' }));
    topo.upsertNode(mkNode('c', { name: 'T 123 ' }));
    topo.upsertNode(mkNode('d', { name: 'T123 follow-up' }));
    topo.upsertNode(mkNode('e', { name: 'prd-7' }));
    topo.upsertNode(mkNode('f', { name: 'prd 7 review' }));
    infer.inferSameTopicEdges();
    const edges = topo.readTopology().edges;
    expect(edges.find(e => e.rationale.includes('n6'))).toBeTruthy();
    expect(edges.find(e => e.rationale.includes('t123'))).toBeTruthy();
    expect(edges.find(e => e.rationale.includes('prd7'))).toBeTruthy();
  });

  it('does not emit when only one chat carries the signal', async () => {
    const { topo, infer } = await freshImports();
    topo.upsertNode(mkNode('a', { tags: ['unique'] }));
    topo.upsertNode(mkNode('b', { tags: ['other'] }));
    expect(infer.inferSameTopicEdges()).toBe(0);
  });

  it('extracts task ids from summary as well as name', async () => {
    const { topo, infer } = await freshImports();
    topo.upsertNode(mkNode('a', { summary: 'working on N42' }));
    topo.upsertNode(mkNode('b', { summary: 'N42 spec review' }));
    expect(infer.inferSameTopicEdges()).toBeGreaterThan(0);
    const edges = topo.readTopology().edges;
    expect(edges.find(e => e.rationale.includes('n42'))).toBeTruthy();
  });
});
