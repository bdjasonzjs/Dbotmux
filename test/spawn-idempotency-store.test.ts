/**
 * P1 commit #3 — spawn idempotency store tests (C-IS-1~6).
 *
 * Run:  pnpm vitest run test/spawn-idempotency-store.test.ts
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
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

async function freshImport() {
  vi.resetModules();
  return await import('../src/services/spawn-idempotency-store.js');
}

function mkEntry(key: string, chatId: string, ageMs = 0): {
  key: string; chatId: string; createdAt: string;
} {
  return { key, chatId, createdAt: new Date(Date.now() - ageMs).toISOString() };
}

describe('spawn-idempotency-store (P1 commit #3)', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'spawn-idem-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('C-IS-1 — first call runs compute', () => {
    it('returns cacheHit=false on first key', async () => {
      const store = await freshImport();
      let computeCalls = 0;
      const result = await store.getOrCompute('k1', async () => {
        computeCalls++;
        return mkEntry('k1', 'oc_first');
      });
      expect(computeCalls).toBe(1);
      expect(result.cacheHit).toBe(false);
      expect(result.entry.chatId).toBe('oc_first');
    });
  });

  describe('C-IS-2 — second call within TTL returns cache', () => {
    it('does NOT re-invoke compute and returns same chatId', async () => {
      const store = await freshImport();
      let computeCalls = 0;
      await store.getOrCompute('k1', async () => {
        computeCalls++;
        return mkEntry('k1', 'oc_orig');
      });
      const r2 = await store.getOrCompute('k1', async () => {
        computeCalls++;
        return mkEntry('k1', 'oc_should_not_run');
      });
      expect(computeCalls).toBe(1);   // 2nd compute never ran
      expect(r2.cacheHit).toBe(true);
      expect(r2.entry.chatId).toBe('oc_orig');
    });
  });

  describe('C-IS-3 — second call after TTL re-runs compute', () => {
    it('expired cache → cacheHit=false, fresh compute', async () => {
      const store = await freshImport();
      // Inject an expired entry directly (older than 24h + 1ms)
      const expired = mkEntry('k1', 'oc_expired', 24 * 60 * 60 * 1000 + 1000);
      // Write file directly to avoid in-memory inflight
      const { writeFileSync, mkdirSync } = await import('node:fs');
      mkdirSync(tempDir, { recursive: true });
      writeFileSync(join(tempDir, 'group-spawn-idempotency.json'),
        JSON.stringify({ entries: [expired] }), 'utf-8');
      let computeCalls = 0;
      const r = await store.getOrCompute('k1', async () => {
        computeCalls++;
        return mkEntry('k1', 'oc_new');
      });
      expect(computeCalls).toBe(1);
      expect(r.cacheHit).toBe(false);
      expect(r.entry.chatId).toBe('oc_new');
    });
  });

  describe('C-IS-4 — concurrent same-key callers share one compute', () => {
    it('Promise.all of 5 concurrent callers → compute runs exactly 1 time', async () => {
      const store = await freshImport();
      let computeCalls = 0;
      const compute = async () => {
        computeCalls++;
        // Simulate async work — concurrent callers must enter inflight before this resolves
        await new Promise(r => setTimeout(r, 20));
        return mkEntry('k1', 'oc_only_once');
      };
      const results = await Promise.all(
        Array.from({ length: 5 }, () => store.getOrCompute('k1', compute)),
      );
      expect(computeCalls).toBe(1);
      // All 5 results share same chatId; exactly 1 has cacheHit=false (the winner)
      expect(results.every(r => r.entry.chatId === 'oc_only_once')).toBe(true);
      const winners = results.filter(r => !r.cacheHit);
      expect(winners.length).toBe(1);
    });
  });

  describe('C-IS-5 — compute() throw clears inflight; next call retries', () => {
    it('throwing compute clears inflight + next call gets fresh attempt', async () => {
      const store = await freshImport();
      let attempt = 0;
      await expect(
        store.getOrCompute('k1', async () => {
          attempt++;
          throw new Error('lark API timeout');
        }),
      ).rejects.toThrow(/lark API timeout/);

      // Next call must NOT see stale promise and must NOT hit the file cache
      // (compute never reached persist when it threw).
      const r = await store.getOrCompute('k1', async () => {
        attempt++;
        return mkEntry('k1', 'oc_recovered');
      });
      expect(attempt).toBe(2);
      expect(r.cacheHit).toBe(false);
      expect(r.entry.chatId).toBe('oc_recovered');
    });
  });

  describe('C-IS-6 — atomic file persist + gc TTL sweep', () => {
    it('persists to file (atomic — no .tmp leftover) and gc removes expired', async () => {
      const store = await freshImport();
      await store.getOrCompute('k1', async () => mkEntry('k1', 'oc_keep'));
      const fp = join(tempDir, 'group-spawn-idempotency.json');
      expect(existsSync(fp)).toBe(true);
      expect(existsSync(fp + '.tmp')).toBe(false);

      // Inject expired entry to test gc
      const { writeFileSync, readFileSync } = await import('node:fs');
      const current = JSON.parse(readFileSync(fp, 'utf-8'));
      const expired = mkEntry('k_old', 'oc_old', 25 * 60 * 60 * 1000);
      current.entries.push(expired);
      writeFileSync(fp, JSON.stringify(current), 'utf-8');

      const removed = store.gc();
      expect(removed).toBe(1);
      const after = JSON.parse(readFileSync(fp, 'utf-8'));
      expect(after.entries.map((e: any) => e.key)).toEqual(['k1']);
    });
  });
});
