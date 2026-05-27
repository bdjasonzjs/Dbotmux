/**
 * Phase B (2026-05-27): scout-inbox-router 决策/执行单测.
 *
 * 覆盖 4 个 path 的决策矩阵 + quota gate + executor mock + 持久化.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: { get session() { return { dataDir: tempDir }; } },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

async function freshImports() {
  vi.resetModules();
  return {
    router: await import('../src/services/scout-inbox-router.js'),
    store: await import('../src/services/main-bot-digest-store.js'),
  };
}

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'scout-router-')); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

function mkItem(opts: {
  id: string;
  category: 'blocker' | 'todo';
  priority?: 'high' | 'med' | 'low';
  enqueuedAt: string;
  notifiedAt?: string | null;
  status?: 'pending' | 'processed' | 'dismissed';
}): any {
  return {
    type: 'tilly_digest_high',
    id: opts.id,
    enqueuedAt: opts.enqueuedAt,
    category: opts.category,
    payload: {
      summary: `s-${opts.id}`,
      sourceChatId: `oc_${opts.id}`,
      sourceChatName: `c-${opts.id}`,
      sourceMessageId: `om_${opts.id}`,
      priority: opts.priority,
    },
    status: opts.status ?? 'pending',
    notifiedAt: opts.notifiedAt ?? null,
    handledBy: null,
    handledAt: null,
    resolution: null,
  };
}

describe('decideAction — pure decision matrix', () => {
  const now = new Date('2026-05-27T10:00:00Z');
  const policy = {
    archiveAfterMs: 7 * 24 * 3600 * 1000,
    spawnGraceMs: 60 * 60 * 1000,
    maxPingsPerDay: 20,
    maxSpawnsPerDay: 10,
  };

  it('non-pending → wait', async () => {
    const { router } = await freshImports();
    const d = router.decideAction(mkItem({
      id: 'x1', category: 'blocker', enqueuedAt: now.toISOString(), status: 'processed',
    }), { now, policy });
    expect(d.action).toBe('wait');
    expect(d.reason).toContain('not pending');
  });

  it('blocker 任何年龄 → A_ping (notifiedAt 仍 null)', async () => {
    const { router } = await freshImports();
    const d = router.decideAction(mkItem({
      id: 'x2', category: 'blocker', enqueuedAt: now.toISOString(),
    }), { now, policy });
    expect(d.action).toBe('A_ping');
  });

  it('high-prio todo → A_ping', async () => {
    const { router } = await freshImports();
    const d = router.decideAction(mkItem({
      id: 'x3', category: 'todo', priority: 'high', enqueuedAt: now.toISOString(),
    }), { now, policy });
    expect(d.action).toBe('A_ping');
  });

  it('blocker 已 notified → wait (不重 ping)', async () => {
    const { router } = await freshImports();
    const d = router.decideAction(mkItem({
      id: 'x4', category: 'blocker', enqueuedAt: now.toISOString(),
      notifiedAt: '2026-05-27T09:00:00Z',
    }), { now, policy });
    expect(d.action).toBe('wait');
    expect(d.reason).toContain('awaiting');
  });

  it('med todo 在 grace 内 → wait', async () => {
    const { router } = await freshImports();
    const enq = new Date(now.getTime() - 30 * 60 * 1000).toISOString();  // 30min ago < 1h grace
    const d = router.decideAction(mkItem({
      id: 'x5', category: 'todo', priority: 'med', enqueuedAt: enq,
    }), { now, policy });
    expect(d.action).toBe('wait');
  });

  it('med todo 过 grace → B_spawn', async () => {
    const { router } = await freshImports();
    const enq = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();  // 2h ago > 1h grace
    const d = router.decideAction(mkItem({
      id: 'x6', category: 'todo', priority: 'med', enqueuedAt: enq,
    }), { now, policy });
    expect(d.action).toBe('B_spawn');
  });

  it('low todo 过 grace → B_spawn', async () => {
    const { router } = await freshImports();
    const enq = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const d = router.decideAction(mkItem({
      id: 'x7', category: 'todo', priority: 'low', enqueuedAt: enq,
    }), { now, policy });
    expect(d.action).toBe('B_spawn');
  });

  it('item >7d → C_archive (覆盖一切其他规则)', async () => {
    const { router } = await freshImports();
    const enq = new Date(now.getTime() - 8 * 24 * 3600 * 1000).toISOString();
    const d = router.decideAction(mkItem({
      id: 'x8', category: 'blocker', enqueuedAt: enq,  // blocker 也归档!
    }), { now, policy });
    expect(d.action).toBe('C_archive');
  });
});

describe('runRouterTick — end-to-end with mocked executors', () => {
  const now = new Date('2026-05-27T10:00:00Z');

  it('blocker + med todo + 老 item: 一 tick 内分别走 A / B / C', async () => {
    const { router, store } = await freshImports();
    const blocker = mkItem({ id: 'b1', category: 'blocker', enqueuedAt: now.toISOString() });
    const oldStale = mkItem({
      id: 'o1', category: 'todo', priority: 'med',
      enqueuedAt: new Date(now.getTime() - 8 * 24 * 3600 * 1000).toISOString(),
    });
    const medAged = mkItem({
      id: 'm1', category: 'todo', priority: 'med',
      enqueuedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
    });
    store.writeInbox({ pending: [blocker, oldStale, medAged], processed: [] });

    const pingMock = vi.fn().mockResolvedValue(undefined);
    const spawnMock = vi.fn().mockResolvedValue('oc_handler_111');
    const stats = await router.runRouterTick({
      now,
      executors: { pingJason: pingMock, spawnHandler: spawnMock },
    });

    expect(stats.routedA).toBe(1);
    expect(stats.routedB).toBe(1);
    expect(stats.routedC).toBe(1);
    expect(pingMock).toHaveBeenCalledTimes(1);
    expect(pingMock.mock.calls[0][0]).toHaveLength(1);    // 1 batched item
    expect(pingMock.mock.calls[0][0][0].id).toBe('b1');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][0].id).toBe('m1');

    const finalInbox = store.readInbox();
    expect(finalInbox.pending).toHaveLength(1);            // blocker 仍 pending (只 notify, 没 process)
    expect(finalInbox.pending[0].id).toBe('b1');
    expect((finalInbox.pending[0] as any).notifiedAt).not.toBeNull();
    expect(finalInbox.processed).toHaveLength(2);
    const processedIds = finalInbox.processed.map(i => i.id).sort();
    expect(processedIds).toEqual(['m1', 'o1']);
  });

  it('quota 用尽 path A: 多于 maxPingsPerDay 的 ping 留 pending', async () => {
    const { router, store } = await freshImports();
    const items = Array.from({ length: 5 }, (_, i) =>
      mkItem({ id: `b${i}`, category: 'blocker', enqueuedAt: now.toISOString() })
    );
    store.writeInbox({ pending: items, processed: [] });
    const tightPolicy = { archiveAfterMs: 7 * 86400000, spawnGraceMs: 3600000, maxPingsPerDay: 2, maxSpawnsPerDay: 10 };

    const pingMock = vi.fn().mockResolvedValue(undefined);
    const stats = await router.runRouterTick({
      now, policy: tightPolicy,
      executors: { pingJason: pingMock, spawnHandler: vi.fn() },
    });
    expect(stats.routedA).toBe(2);
    expect(stats.quotaSkipsA).toBe(3);
    // 留 pending 不重 notify
    const finalInbox = store.readInbox();
    const notified = finalInbox.pending.filter(i => (i as any).notifiedAt !== null);
    expect(notified).toHaveLength(2);
  });

  it('quota 跨 tick 持久化: 第 1 tick 用 2/2, 第 2 tick 不能再 ping', async () => {
    const { router, store } = await freshImports();
    const tightPolicy = { archiveAfterMs: 7 * 86400000, spawnGraceMs: 3600000, maxPingsPerDay: 2, maxSpawnsPerDay: 10 };
    // Tick 1: 2 blockers
    store.writeInbox({
      pending: [
        mkItem({ id: 'b1', category: 'blocker', enqueuedAt: now.toISOString() }),
        mkItem({ id: 'b2', category: 'blocker', enqueuedAt: now.toISOString() }),
      ],
      processed: [],
    });
    const ping1 = vi.fn().mockResolvedValue(undefined);
    await router.runRouterTick({
      now, policy: tightPolicy,
      executors: { pingJason: ping1, spawnHandler: vi.fn() },
    });
    expect(router.readQuota().pingsUsed).toBe(2);
    // Tick 2: 1 new blocker, 同一天, quota 还是 2/2 → 拒
    const tick2 = new Date(now.getTime() + 60_000);
    store.writeInbox({
      pending: [mkItem({ id: 'b3', category: 'blocker', enqueuedAt: tick2.toISOString() })],
      processed: [],
    });
    const ping2 = vi.fn().mockResolvedValue(undefined);
    const stats = await router.runRouterTick({
      now: tick2, policy: tightPolicy,
      executors: { pingJason: ping2, spawnHandler: vi.fn() },
    });
    expect(stats.routedA).toBe(0);
    expect(stats.quotaSkipsA).toBe(1);
    expect(ping2).not.toHaveBeenCalled();
  });

  it('quota 跨日 reset: 不同 dateId 自动归零', async () => {
    const { router } = await freshImports();
    router.writeQuota({ dateId: '2026-05-26', pingsUsed: 99, spawnsUsed: 99 });
    const today = router.readQuota();
    expect(today.pingsUsed).toBe(0);
    expect(today.spawnsUsed).toBe(0);
    expect(today.dateId).not.toBe('2026-05-26');
  });

  it('spawn 返 null (失败) → item 留 pending, 不消耗 quota', async () => {
    const { router, store } = await freshImports();
    const enq = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    store.writeInbox({
      pending: [mkItem({ id: 's1', category: 'todo', priority: 'med', enqueuedAt: enq })],
      processed: [],
    });
    const spawnMock = vi.fn().mockResolvedValue(null);
    const stats = await router.runRouterTick({
      now, executors: { pingJason: vi.fn(), spawnHandler: spawnMock },
    });
    expect(stats.routedB).toBe(0);
    expect(router.readQuota().spawnsUsed).toBe(0);
    expect(store.readInbox().pending).toHaveLength(1);
  });

  it('pingJason throws → 不 mark notifiedAt, 不消耗 quota', async () => {
    const { router, store } = await freshImports();
    store.writeInbox({
      pending: [mkItem({ id: 'b1', category: 'blocker', enqueuedAt: now.toISOString() })],
      processed: [],
    });
    const pingMock = vi.fn().mockRejectedValue(new Error('lark down'));
    const stats = await router.runRouterTick({
      now, executors: { pingJason: pingMock, spawnHandler: vi.fn() },
    });
    expect(stats.errors).toBeGreaterThanOrEqual(1);
    expect(stats.routedA).toBe(0);
    expect(router.readQuota().pingsUsed).toBe(0);
    expect((store.readInbox().pending[0] as any).notifiedAt).toBeNull();
  });
});
