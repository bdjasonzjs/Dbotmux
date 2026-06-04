/**
 * Unit tests for mention-history-store —「被圈时间感知」存储 (2026-06-04 邹劲松要求)。
 * 覆盖：记录 + 升序 + 裁剪到最近 5 次 + 群/bot 维度隔离 + 空/坏文件容错。
 *
 * Run:  pnpm vitest run test/mention-history-store.test.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

async function freshStore() {
  vi.resetModules();
  const cfg = await import('../src/config.js');
  const store = await import('../src/services/mention-history-store.js');
  return { cfg, store };
}

describe('mention-history-store', () => {
  let dataDir: string;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-mention-store-'));
    prevDataDir = process.env.SESSION_DATA_DIR;
    process.env.SESSION_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
    else process.env.SESSION_DATA_DIR = prevDataDir;
  });

  it('empty by default', async () => {
    const { store } = await freshStore();
    expect(store.getRecentMentions('app_x', 'chat_a')).toEqual([]);
  });

  it('records and returns timestamps ascending', async () => {
    const { store } = await freshStore();
    store.recordMention('app_x', 'chat_a', 1000);
    store.recordMention('app_x', 'chat_a', 3000);
    store.recordMention('app_x', 'chat_a', 2000); // out of order
    expect(store.getRecentMentions('app_x', 'chat_a')).toEqual([1000, 2000, 3000]);
  });

  it('keeps only the most recent MAX_RECENT_MENTIONS', async () => {
    const { store } = await freshStore();
    const max = store.MAX_RECENT_MENTIONS;
    for (let i = 1; i <= max + 3; i++) store.recordMention('app_x', 'chat_a', i * 1000);
    const got = store.getRecentMentions('app_x', 'chat_a');
    expect(got.length).toBe(max);
    // earliest 3 dropped, newest retained
    expect(got[0]).toBe(4 * 1000);
    expect(got[got.length - 1]).toBe((max + 3) * 1000);
  });

  it('isolates by chat and by bot (larkAppId)', async () => {
    const { store } = await freshStore();
    store.recordMention('app_x', 'chat_a', 1000);
    store.recordMention('app_x', 'chat_b', 2000);
    store.recordMention('app_y', 'chat_a', 9000);
    expect(store.getRecentMentions('app_x', 'chat_a')).toEqual([1000]);
    expect(store.getRecentMentions('app_x', 'chat_b')).toEqual([2000]);
    expect(store.getRecentMentions('app_y', 'chat_a')).toEqual([9000]);
  });

  it('ignores invalid inputs without throwing', async () => {
    const { store } = await freshStore();
    expect(() => store.recordMention('', 'chat_a', 1000)).not.toThrow();
    expect(() => store.recordMention('app_x', '', 1000)).not.toThrow();
    expect(() => store.recordMention('app_x', 'chat_a', Number.NaN)).not.toThrow();
    expect(store.getRecentMentions('app_x', 'chat_a')).toEqual([]);
  });

  it('persists across a fresh module load (same dataDir)', async () => {
    const { store } = await freshStore();
    store.recordMention('app_x', 'chat_a', 5000);
    const { store: store2 } = await freshStore(); // re-import, same SESSION_DATA_DIR
    expect(store2.getRecentMentions('app_x', 'chat_a')).toEqual([5000]);
  });
});
