/**
 * 一期地基 · watch-inbox-store 单测。
 * Run: pnpm vitest run test/watch-inbox-store.test.ts
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
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

async function freshImport() {
  vi.resetModules();
  return await import('../src/services/watch-inbox-store.js');
}

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'watch-inbox-')); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

const base = {
  watchedChatId: 'oc_watched',
  slug: 'build-broken',
  targetChatId: 'oc_target',
  kind: 'alert' as const,
  summary: '构建挂了',
  evidence: 'msg1',
  sourceMessageIds: ['m1'],
};

describe('watch-inbox-store', () => {
  it('buildFingerprint = watchedChatId:slug', async () => {
    const s = await freshImport();
    expect(s.buildFingerprint('oc_w', 'slug')).toBe('oc_w:slug');
  });

  it('新建 → inserted=true / status=open / fresh delivery', async () => {
    const s = await freshImport();
    const { incident, inserted } = s.upsertIncident(base);
    expect(inserted).toBe(true);
    expect(incident.incidentId).toBe('oc_watched:build-broken');
    expect(incident.status).toBe('open');
    expect(incident.delivery).toEqual({ messageId: null, deliveryStatus: 'pending', lastDeliveredAt: null, pokeCount: 0 });
  });

  it('同 fingerprint 再判中 → inserted=false / status=updated / 证据合并去重', async () => {
    const s = await freshImport();
    s.upsertIncident(base);
    const { incident, inserted } = s.upsertIncident({ ...base, summary: '还挂着', sourceMessageIds: ['m1', 'm2'] });
    expect(inserted).toBe(false);
    expect(incident.status).toBe('updated');
    expect(incident.summary).toBe('还挂着');
    expect(incident.sourceMessageIds.sort()).toEqual(['m1', 'm2']);
  });

  it('P2-1：换目标群 → inserted=true + delivery 重置（旧 messageId 不跨群复用）', async () => {
    const s = await freshImport();
    s.upsertIncident(base);
    // 模拟已投递到旧目标群
    s.updateDelivery('oc_watched:build-broken', { messageId: 'om_oldgroup', deliveryStatus: 'sent', lastDeliveredAt: 'now' });
    // 同一被盯群同一卡点，但汇报目标改成新群
    const { incident, inserted } = s.upsertIncident({ ...base, targetChatId: 'oc_newtarget' });
    expect(incident.targetChatId).toBe('oc_newtarget');
    expect(inserted).toBe(true); // 需要发新消息到新群
    expect(incident.delivery.messageId).toBe(null);     // 旧群的 messageId 被丢弃
    expect(incident.delivery.deliveryStatus).toBe('pending');
  });

  it('目标群不变的 update 不动已有 delivery', async () => {
    const s = await freshImport();
    s.upsertIncident(base);
    s.updateDelivery('oc_watched:build-broken', { messageId: 'om_x', deliveryStatus: 'sent' });
    const { incident } = s.upsertIncident({ ...base, summary: '更新' });
    expect(incident.delivery.messageId).toBe('om_x'); // 同群，沿用
    expect(incident.delivery.deliveryStatus).toBe('sent');
  });

  it('显式 close → status=closed；再 close no-op', async () => {
    const s = await freshImport();
    s.upsertIncident(base);
    const closed = s.closeIncident('oc_watched:build-broken', '松松')!;
    expect(closed.status).toBe('closed');
    expect(closed.closedBy).toBe('松松');
    const again = s.closeIncident('oc_watched:build-broken')!;
    expect(again.status).toBe('closed'); // 幂等
    expect(again.closedBy).toBe('松松');  // 不被覆盖
  });

  it('close 后复发 → 开新一代 #2 / inserted=true / fresh delivery', async () => {
    const s = await freshImport();
    s.upsertIncident(base);
    s.closeIncident('oc_watched:build-broken');
    const { incident, inserted } = s.upsertIncident(base);
    expect(inserted).toBe(true);
    expect(incident.incidentId).toBe('oc_watched:build-broken#2');
    expect(incident.status).toBe('open');
    expect(incident.delivery.messageId).toBe(null);
  });

  it('listOpenByTarget 只返该目标群的 open，排除 closed', async () => {
    const s = await freshImport();
    s.upsertIncident({ ...base, slug: 'a' });                          // → oc_target
    s.upsertIncident({ ...base, slug: 'b' });                          // → oc_target
    s.upsertIncident({ ...base, slug: 'c', targetChatId: 'oc_other' }); // → oc_other
    s.closeIncident('oc_watched:b');
    const openForTarget = s.listOpenByTarget('oc_target');
    expect(openForTarget.map(i => i.incidentId).sort()).toEqual(['oc_watched:a']);
  });
});
