/**
 * Unit tests for main-bot-digest-store (MainBotDigest + ScoutInbox + stale).
 *
 * Run:  pnpm vitest run test/main-bot-digest-store.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
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
  return await import('../src/services/main-bot-digest-store.js');
}

describe('digest IO', () => {
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'digest-test-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('readDigest returns empty when file missing', async () => {
    const store = await freshImport();
    const d = store.readDigest();
    expect(d.chats).toEqual([]);
    expect(d.escalations).toEqual([]);
  });

  it('writeDigest + readDigest round-trips', async () => {
    const store = await freshImport();
    store.writeDigest({
      generatedAt: '2026-01-01T00:00:00Z',
      chats: [{ chatId: 'oc', name: 'X', heat: 'hot', oneLineStatus: 'busy', needsAttention: false }],
      crossChatThreads: [],
      pendingForJason: [],
      escalations: [],
    });
    const d = store.readDigest();
    expect(d.chats[0].name).toBe('X');
    // writeDigest refreshes generatedAt
    expect(d.generatedAt).not.toBe('2026-01-01T00:00:00Z');
  });
});

describe('stale tracking', () => {
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'stale-test-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('isStale=false when no marker exists', async () => {
    const store = await freshImport();
    expect(store.isStale()).toBe(false);
  });

  it('markStale → isStale=true', async () => {
    const store = await freshImport();
    store.markStale();
    expect(store.isStale()).toBe(true);
  });

  it('markFresh clears the marker', async () => {
    const store = await freshImport();
    store.markStale();
    store.markFresh();
    expect(store.isStale()).toBe(false);
  });

  it('writeDigest does not auto-clear stale (caller must markFresh)', async () => {
    const store = await freshImport();
    store.markStale();
    store.writeDigest({
      generatedAt: 'x', chats: [], crossChatThreads: [], pendingForJason: [], escalations: [],
    });
    // stale marker still there until explicit markFresh
    expect(store.isStale()).toBe(true);
    store.markFresh();
    expect(store.isStale()).toBe(false);
  });
});

describe('inbox enqueue / mark', () => {
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'inbox-test-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('enqueueEscalation returns an item with uuid + pending status', async () => {
    const store = await freshImport();
    const item = store.enqueueEscalation({
      ruleId: 'R1',
      triggeredAt: '2026-01-01T00:00:00Z',
      chatId: 'oc_x',
      context: 'unanswered ping',
      payload: { sinceMinutes: 35 },
    });
    expect(item.id).toMatch(/[0-9a-f-]+/);
    expect(item.status).toBe('pending');
    expect(store.readInbox().pending.length).toBe(1);
  });

  it('markInProgress sets status', async () => {
    const store = await freshImport();
    const item = store.enqueueEscalation({
      ruleId: 'R2', triggeredAt: 'x', chatId: 'oc', context: 'c', payload: {},
    });
    const updated = store.markInProgress(item.id);
    expect(updated?.status).toBe('in_progress');
    expect(store.markInProgress(item.id)).toBeNull();  // can't re-mark
  });

  it('markResolved moves item from pending → processed', async () => {
    const store = await freshImport();
    const item = store.enqueueEscalation({
      ruleId: 'R3', triggeredAt: 'x', chatId: 'oc', context: 'c', payload: {},
    });
    const resolved = store.markResolved(item.id, 'session_abc', 'did the thing');
    expect(resolved?.status).toBe('resolved');
    expect(resolved?.resolvedBy).toBe('session_abc');
    expect(resolved?.resolution).toBe('did the thing');
    const inbox = store.readInbox();
    expect(inbox.pending.length).toBe(0);
    expect(inbox.processed.length).toBe(1);
  });

  it('markResolved returns null for unknown id', async () => {
    const store = await freshImport();
    expect(store.markResolved('nope', 'x', 'y')).toBeNull();
  });

  it('writes are atomic (no .tmp leftover)', async () => {
    const store = await freshImport();
    store.enqueueEscalation({ ruleId: 'R1', triggeredAt: 'x', chatId: 'oc', context: 'c', payload: {} });
    expect(existsSync(join(tempDir, 'scout-inbox.json.tmp'))).toBe(false);
    expect(existsSync(join(tempDir, 'scout-inbox.json'))).toBe(true);
  });
});
