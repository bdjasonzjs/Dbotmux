/**
 * P3 commit #4 — tilly-digest-store tests.
 *
 * Run:  pnpm vitest run test/tilly-digest-store.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
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
  return await import('../src/services/tilly-digest-store.js');
}

const item = (id: string, summary = 's', priority?: any) => ({
  summary, sourceChatId: 'oc_x', sourceChatName: 'X',
  sourceMessageId: id, priority,
});

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'tilly-dig-')); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

describe('tilly-digest-store (P3 commit #4)', () => {
  it('P3-rev1 #4: getDateId uses Asia/Shanghai (UTC+8) timezone', async () => {
    const s = await freshImport();
    // 2026-05-25 00:30 +08:00 = 2026-05-24 16:30 UTC
    // PRC date should be 2026-05-25, UTC date would be 2026-05-24
    const d = new Date('2026-05-24T16:30:00Z');
    expect(s.getDateId(d)).toBe('2026-05-25');
    // Edge: 2026-05-24 23:30 +08:00 = 2026-05-24 15:30 UTC — both same day
    const d2 = new Date('2026-05-24T15:30:00Z');
    expect(s.getDateId(d2)).toBe('2026-05-24');
    // Edge: 2026-05-25 07:59 +08:00 = 2026-05-24 23:59 UTC — UTC would be 24, but Shanghai 25
    const d3 = new Date('2026-05-24T23:59:00Z');
    expect(s.getDateId(d3)).toBe('2026-05-25');
  });

  it('getCurrentDigest defaults to empty for today', async () => {
    const s = await freshImport();
    const d = s.getCurrentDigest();
    expect(d.tickCount).toBe(0);
    expect(d.todos).toEqual([]);
    expect(d.dateId).toBe(s.getDateId());
  });

  it('mergeNewDigest accumulates across ticks', async () => {
    const s = await freshImport();
    s.mergeNewDigest({
      todos: [item('om_1', 'todo 1')],
      progress: [item('om_2', 'progress 1')],
      blockers: [],
      noteworthy: [],
      inputMessageCount: 2, analyzedAt: '', ok: true,
    });
    s.mergeNewDigest({
      todos: [item('om_3', 'todo 2')],
      progress: [],
      blockers: [item('om_4', 'blocker 1')],
      noteworthy: [item('om_5', 'note 1')],
      inputMessageCount: 3, analyzedAt: '', ok: true,
    });
    const d = s.getCurrentDigest();
    expect(d.todos).toHaveLength(2);
    expect(d.todos.map(t => t.sourceMessageId).sort()).toEqual(['om_1', 'om_3']);
    expect(d.progress).toHaveLength(1);
    expect(d.blockers).toHaveLength(1);
    expect(d.noteworthy).toHaveLength(1);
    expect(d.tickCount).toBe(2);
  });

  it('mergeNewDigest dedups same sourceMessageId across ticks', async () => {
    const s = await freshImport();
    s.mergeNewDigest({
      todos: [item('om_dup', 'v1')], progress: [], blockers: [], noteworthy: [],
      inputMessageCount: 1, analyzedAt: '', ok: true,
    });
    s.mergeNewDigest({
      todos: [item('om_dup', 'v2 same msg id')],
      progress: [], blockers: [], noteworthy: [],
      inputMessageCount: 1, analyzedAt: '', ok: true,
    });
    const d = s.getCurrentDigest();
    expect(d.todos).toHaveLength(1);
    // First-write wins (we don't overwrite summary — caller's job to choose merge policy)
    expect(d.todos[0].summary).toBe('v1');
  });

  it('totalCount sums all 4 categories', async () => {
    const s = await freshImport();
    s.mergeNewDigest({
      todos: [item('a')], progress: [item('b'), item('c')],
      blockers: [item('d')], noteworthy: [],
      inputMessageCount: 0, analyzedAt: '', ok: true,
    });
    expect(s.totalCount(s.getCurrentDigest())).toBe(4);
  });

  it('persists across freshImport (file actually written)', async () => {
    {
      const s = await freshImport();
      s.mergeNewDigest({ todos: [item('p')], progress: [], blockers: [], noteworthy: [], inputMessageCount: 1, analyzedAt: '', ok: true });
    }
    const s = await freshImport();
    expect(s.getCurrentDigest().todos).toHaveLength(1);
  });

  it('cross-day rollover: stale dateId archives + starts fresh', async () => {
    const s = await freshImport();
    // Manually write a stale-date current file
    const stale = {
      dateId: '2020-01-01',
      todos: [item('archived_todo')],
      progress: [], blockers: [], noteworthy: [],
      lastTickAt: '2020-01-01T12:00:00.000Z',
      tickCount: 5,
    };
    const fp = join(tempDir, 'tilly-digest-current.json');
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(fp, JSON.stringify(stale), 'utf-8');
    // Read today — should rollover (archive stale, return fresh)
    const today = s.getCurrentDigest();
    expect(today.dateId).toBe(s.getDateId());
    expect(today.todos).toEqual([]);
    expect(today.tickCount).toBe(0);
    // Archive should contain the stale day
    const archFp = join(tempDir, 'tilly-digest-archive.json');
    expect(existsSync(archFp)).toBe(true);
    const arch = JSON.parse(readFileSync(archFp, 'utf-8'));
    expect(arch.days[0].dateId).toBe('2020-01-01');
    expect(arch.days[0].todos).toHaveLength(1);
  });
});
