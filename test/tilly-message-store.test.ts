/**
 * P3 commit #1 — tilly-message-store dedup tests.
 *
 * Run:  pnpm vitest run test/tilly-message-store.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: { get session() { return { dataDir: tempDir }; } },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

async function freshImport() {
  vi.resetModules();
  return await import('../src/services/tilly-message-store.js');
}

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'tilly-msg-')); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

describe('tilly-message-store (P3 commit #1)', () => {
  it('isScanned: false on fresh store', async () => {
    const s = await freshImport();
    expect(s.isScanned('om_1')).toBe(false);
    expect(s.stats().count).toBe(0);
  });

  it('markScanned then isScanned returns true', async () => {
    const s = await freshImport();
    s.markScanned(['om_a', 'om_b']);
    expect(s.isScanned('om_a')).toBe(true);
    expect(s.isScanned('om_b')).toBe(true);
    expect(s.isScanned('om_c')).toBe(false);
  });

  it('markScanned is idempotent (same id twice → count stays)', async () => {
    const s = await freshImport();
    s.markScanned(['om_x']);
    s.markScanned(['om_x', 'om_x']);
    expect(s.stats().count).toBe(1);
  });

  it('filterUnscanned returns only new ids', async () => {
    const s = await freshImport();
    s.markScanned(['om_old1', 'om_old2']);
    expect(s.filterUnscanned(['om_old1', 'om_new1', 'om_old2', 'om_new2']))
      .toEqual(['om_new1', 'om_new2']);
  });

  it('persists across freshImport (file actually written)', async () => {
    {
      const s = await freshImport();
      s.markScanned(['om_persist']);
    }
    const s = await freshImport();
    expect(s.isScanned('om_persist')).toBe(true);
  });

  it('atomic write — no .tmp leftover', async () => {
    const s = await freshImport();
    s.markScanned(['om_atomic']);
    const fp = join(tempDir, 'tilly-scanned-messages.json');
    expect(existsSync(fp)).toBe(true);
    expect(existsSync(fp + '.tmp')).toBe(false);
  });

  it('FIFO eviction past MAX_CAP keeps newest only', async () => {
    const s = await freshImport();
    // Simulate large input - check it caps at 50000
    const big = Array.from({ length: 50_010 }, (_, i) => `om_${i}`);
    s.markScanned(big);
    const stats = s.stats();
    expect(stats.count).toBeLessThanOrEqual(50_000);
    // newest should be om_50009 (the last input)
    expect(stats.newest).toBe('om_50009');
    // oldest should be roughly om_10 (head FIFO-evicted)
    expect(s.isScanned('om_0')).toBe(false);
    expect(s.isScanned('om_50009')).toBe(true);
  });

  it('empty input is a no-op', async () => {
    const s = await freshImport();
    s.markScanned([]);
    expect(s.stats().count).toBe(0);
  });

  // 2026-05-29 高水位 fetch 窗口 (松松实拍漏消息根因修复)
  describe('lastFetchEnd 高水位', () => {
    it('fresh store → getLastFetchEnd 返 null (首次回退 now-interval)', async () => {
      const s = await freshImport();
      expect(s.getLastFetchEnd()).toBeNull();
    });

    it('set → get round-trip (毫秒精度 ISO)', async () => {
      const s = await freshImport();
      s.setLastFetchEnd(new Date('2026-05-29T02:53:08.704Z'));
      expect(s.getLastFetchEnd()!.toISOString()).toBe('2026-05-29T02:53:08.704Z');
    });

    it('setLastFetchEnd 不破坏 scannedIds', async () => {
      const s = await freshImport();
      s.markScanned(['om_a', 'om_b']);
      s.setLastFetchEnd(new Date('2026-05-29T03:00:00.000Z'));
      expect(s.isScanned('om_a')).toBe(true);
      expect(s.isScanned('om_b')).toBe(true);
      expect(s.getLastFetchEnd()!.toISOString()).toBe('2026-05-29T03:00:00.000Z');
    });

    it('markScanned 不清掉已存的 lastFetchEnd', async () => {
      const s = await freshImport();
      s.setLastFetchEnd(new Date('2026-05-29T03:00:00.000Z'));
      s.markScanned(['om_x']);
      expect(s.getLastFetchEnd()!.toISOString()).toBe('2026-05-29T03:00:00.000Z');
    });

    it('损坏的 lastFetchEnd → getLastFetchEnd 返 null 不抛', async () => {
      const s = await freshImport();
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(tempDir, 'tilly-scanned-messages.json'), JSON.stringify({ scannedIds: [], updatedAt: 'x', lastFetchEnd: 'not-a-date' }), 'utf-8');
      expect(s.getLastFetchEnd()).toBeNull();
    });
  });
});
