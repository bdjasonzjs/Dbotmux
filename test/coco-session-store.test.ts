/**
 * 2026-05-28: coco --resume session store (Phase C.2 缇蕾真持续记忆).
 *
 * 测: 读/写/跨日/clear/损坏 file 兜底.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
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
  return await import('../src/services/coco-session-store.js');
}

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'coco-sess-')); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

function todayId(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

describe('coco-session-store', () => {
  it('readTodaySession 无文件 → null', async () => {
    const m = await freshImport();
    expect(m.readTodaySession()).toBeNull();
  });

  it('saveTodaySession → readTodaySession 同 sessionId', async () => {
    const m = await freshImport();
    m.saveTodaySession('sess_abc123');
    const s = m.readTodaySession();
    expect(s?.sessionId).toBe('sess_abc123');
    expect(s?.dateId).toBe(todayId());
    expect(s?.createdAt).toBeTruthy();
    expect(s?.lastUsedAt).toBeTruthy();
  });

  it('save 同一 sessionId 两次 → createdAt 不变, lastUsedAt 更新', async () => {
    const m = await freshImport();
    m.saveTodaySession('sess_x');
    const s1 = m.readTodaySession()!;
    await new Promise(r => setTimeout(r, 10));    // 确保 ISO ts 不同
    m.saveTodaySession('sess_x');
    const s2 = m.readTodaySession()!;
    expect(s2.createdAt).toBe(s1.createdAt);       // preserve
    expect(s2.lastUsedAt >= s1.lastUsedAt).toBe(true);
  });

  it('save 不同 sessionId (同一天) → createdAt 更新成新的 createdAt (新 session)', async () => {
    const m = await freshImport();
    m.saveTodaySession('sess_old');
    await new Promise(r => setTimeout(r, 10));
    m.saveTodaySession('sess_new');
    const s = m.readTodaySession()!;
    expect(s.sessionId).toBe('sess_new');
    // 新 sessionId, createdAt 应是这次写的时间 (不 preserve 老的)
    expect(s.createdAt).toBe(s.lastUsedAt);
  });

  it('stored 是昨天的 dateId → readTodaySession 返 null (跨日 reset)', async () => {
    const m = await freshImport();
    const fp = join(tempDir, 'coco-tilly-session.json');
    writeFileSync(fp, JSON.stringify({
      dateId: '2020-01-01',          // 远古日期
      sessionId: 'sess_stale',
      createdAt: '2020-01-01T00:00:00Z',
      lastUsedAt: '2020-01-01T00:00:00Z',
    }), 'utf-8');
    expect(m.readTodaySession()).toBeNull();
  });

  it('损坏 JSON → readTodaySession 返 null 不抛', async () => {
    const m = await freshImport();
    writeFileSync(join(tempDir, 'coco-tilly-session.json'), '{not json', 'utf-8');
    expect(m.readTodaySession()).toBeNull();
  });

  it('clearTodaySession → 下次 read 返 null', async () => {
    const m = await freshImport();
    m.saveTodaySession('sess_a');
    expect(m.readTodaySession()?.sessionId).toBe('sess_a');
    m.clearTodaySession();
    expect(m.readTodaySession()).toBeNull();
  });

  it('clearTodaySession 无文件 → 不抛', async () => {
    const m = await freshImport();
    expect(() => m.clearTodaySession()).not.toThrow();
  });
});
