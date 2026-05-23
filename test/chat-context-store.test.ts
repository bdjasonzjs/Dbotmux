/**
 * Unit tests for chat-context-store: create / read / update / upsert / remove
 * / listChatIds.
 *
 * Run:  pnpm vitest run test/chat-context-store.test.ts
 *
 * Strategy: point config.session.dataDir at a per-test temp dir so each test
 * is isolated and we touch a real filesystem (atomic rename semantics matter).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock the config module to swap dataDir to a fresh temp dir per test.
let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: {
    get session() { return { dataDir: tempDir }; },
  },
}));

// Silence logger noise during tests.
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

async function freshImport() {
  vi.resetModules();
  return await import('../src/services/chat-context-store.js');
}

describe('chat-context-store', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'chat-context-store-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('create()', () => {
    it('writes a new context file with defaults applied', async () => {
      const store = await freshImport();
      const ctx = store.create('oc_abc', {
        purpose: 'discuss X',
        originType: 'bot_spawned',
        parentChatId: 'oc_parent',
        participants: [{ openId: 'ou_xyz', role: 'owner' }],
      });

      expect(ctx.chatId).toBe('oc_abc');
      expect(ctx.purpose).toBe('discuss X');
      expect(ctx.originType).toBe('bot_spawned');
      expect(ctx.inheritedFrom).toEqual({ parentChatId: 'oc_parent', parentDigest: '' });
      expect(ctx.injectionPolicy).toBe('eager');
      expect(ctx.relatedRefs).toEqual([]);
      expect(ctx.activeTodoRefs).toEqual([]);
      expect(ctx.rules).toEqual([]);
      expect(ctx.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const fp = join(tempDir, 'chat-contexts', 'oc_abc.json');
      expect(existsSync(fp)).toBe(true);
      const parsed = JSON.parse(readFileSync(fp, 'utf-8'));
      expect(parsed.chatId).toBe('oc_abc');
    });

    it('sets inheritedFrom=null when parentChatId is null', async () => {
      const store = await freshImport();
      const ctx = store.create('oc_solo', {
        purpose: 'solo chat',
        originType: 'p2p',
        parentChatId: null,
        participants: [],
      });
      expect(ctx.inheritedFrom).toBeNull();
    });

    it('is idempotent: second create returns the existing context unchanged', async () => {
      const store = await freshImport();
      const first = store.create('oc_dup', {
        purpose: 'original',
        originType: 'bot_spawned',
        parentChatId: null,
        participants: [],
      });
      const second = store.create('oc_dup', {
        purpose: 'overwritten?',
        originType: 'human_created',
        parentChatId: null,
        participants: [],
      });
      expect(second.purpose).toBe('original');
      expect(second.originType).toBe('bot_spawned');
      expect(second.updatedAt).toBe(first.updatedAt);
    });

    it('respects custom relatedRefs / rules / injectionPolicy', async () => {
      const store = await freshImport();
      const ctx = store.create('oc_custom', {
        purpose: 'p',
        originType: 'bot_spawned',
        parentChatId: 'p_chat',
        participants: [{ openId: 'ou_a', role: 'owner' }],
        relatedRefs: ['https://example/prd'],
        activeTodoRefs: ['N6'],
        rules: ['不公开伴侣标签'],
        injectionPolicy: 'manual',
        parentDigest: 'prev summary',
      });
      expect(ctx.relatedRefs).toEqual(['https://example/prd']);
      expect(ctx.activeTodoRefs).toEqual(['N6']);
      expect(ctx.rules).toEqual(['不公开伴侣标签']);
      expect(ctx.injectionPolicy).toBe('manual');
      expect(ctx.inheritedFrom?.parentDigest).toBe('prev summary');
    });
  });

  describe('read()', () => {
    it('returns null when no file exists', async () => {
      const store = await freshImport();
      expect(store.read('oc_nonexistent')).toBeNull();
    });

    it('returns the stored context after create()', async () => {
      const store = await freshImport();
      store.create('oc_r', { purpose: 'r', originType: 'p2p', parentChatId: null, participants: [] });
      const got = store.read('oc_r');
      expect(got).not.toBeNull();
      expect(got?.purpose).toBe('r');
    });

    it('returns null on corrupted JSON', async () => {
      const store = await freshImport();
      const dir = join(tempDir, 'chat-contexts');
      require('node:fs').mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'oc_corrupt.json'), '{not json', 'utf-8');
      expect(store.read('oc_corrupt')).toBeNull();
    });
  });

  describe('upsert()', () => {
    it('force-overwrites an existing context (unlike create())', async () => {
      const store = await freshImport();
      store.create('oc_u', { purpose: 'v1', originType: 'bot_spawned', parentChatId: null, participants: [] });
      const overwritten = {
        chatId: 'oc_u',
        purpose: 'v2',
        originType: 'human_created' as const,
        relatedRefs: ['ref'],
        participants: [],
        inheritedFrom: null,
        activeTodoRefs: [],
        rules: [],
        injectionPolicy: 'eager' as const,
        updatedAt: '2000-01-01T00:00:00Z',
      };
      store.upsert(overwritten);
      const got = store.read('oc_u');
      expect(got?.purpose).toBe('v2');
      expect(got?.originType).toBe('human_created');
      expect(got?.relatedRefs).toEqual(['ref']);
      // upsert refreshes updatedAt
      expect(got?.updatedAt).not.toBe('2000-01-01T00:00:00Z');
    });
  });

  describe('update()', () => {
    it('merges patch into existing context', async () => {
      const store = await freshImport();
      store.create('oc_p', {
        purpose: 'original',
        originType: 'bot_spawned',
        parentChatId: 'p',
        participants: [{ openId: 'a', role: 'r' }],
      });
      const updated = store.update('oc_p', { purpose: 'new', rules: ['r1'] });
      expect(updated?.purpose).toBe('new');
      expect(updated?.rules).toEqual(['r1']);
      expect(updated?.originType).toBe('bot_spawned');  // unchanged
      expect(updated?.participants).toEqual([{ openId: 'a', role: 'r' }]);  // unchanged
    });

    it('returns null when chat has no existing context', async () => {
      const store = await freshImport();
      expect(store.update('oc_missing', { purpose: 'x' })).toBeNull();
    });

    it('never lets patch override chatId', async () => {
      const store = await freshImport();
      store.create('oc_id', { purpose: 'x', originType: 'p2p', parentChatId: null, participants: [] });
      const updated = store.update('oc_id', { chatId: 'oc_OTHER' } as any);
      expect(updated?.chatId).toBe('oc_id');
    });
  });

  describe('remove()', () => {
    it('deletes the file and returns true', async () => {
      const store = await freshImport();
      store.create('oc_rm', { purpose: 'x', originType: 'p2p', parentChatId: null, participants: [] });
      expect(store.remove('oc_rm')).toBe(true);
      expect(store.read('oc_rm')).toBeNull();
    });

    it('returns false when nothing to remove', async () => {
      const store = await freshImport();
      expect(store.remove('oc_nothing')).toBe(false);
    });
  });

  describe('listChatIds()', () => {
    it('returns [] when dir does not exist', async () => {
      const store = await freshImport();
      expect(store.listChatIds()).toEqual([]);
    });

    it('lists chatIds with stored contexts', async () => {
      const store = await freshImport();
      store.create('oc_1', { purpose: 'x', originType: 'p2p', parentChatId: null, participants: [] });
      store.create('oc_2', { purpose: 'y', originType: 'bot_spawned', parentChatId: null, participants: [] });
      const list = store.listChatIds().sort();
      expect(list).toEqual(['oc_1', 'oc_2']);
    });

    it('ignores non-json files', async () => {
      const store = await freshImport();
      store.create('oc_a', { purpose: 'x', originType: 'p2p', parentChatId: null, participants: [] });
      const dir = join(tempDir, 'chat-contexts');
      writeFileSync(join(dir, 'README.txt'), 'noise', 'utf-8');
      writeFileSync(join(dir, 'tmpfile.tmp'), 'noise', 'utf-8');
      expect(store.listChatIds()).toEqual(['oc_a']);
    });
  });

  describe('atomic write', () => {
    it('write goes through tmp + rename — no partial file left after error', async () => {
      const store = await freshImport();
      store.create('oc_atomic', { purpose: 'x', originType: 'p2p', parentChatId: null, participants: [] });
      // After a successful write, the tmp file must NOT exist (rename cleans it).
      const dir = join(tempDir, 'chat-contexts');
      const tmpFp = join(dir, 'oc_atomic.json.tmp');
      expect(existsSync(tmpFp)).toBe(false);
    });
  });
});
