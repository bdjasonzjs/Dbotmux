/**
 * 一期 · 汇报投递层（watch-publisher）单测：digest 聚合 + 变化检测 + 目标群预算 + 投递标记。
 * Run: pnpm vitest run test/watch-publisher.test.ts
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

async function fresh() {
  vi.resetModules();
  return {
    pub: await import('../src/services/watch-publisher.js'),
    inbox: await import('../src/services/watch-inbox-store.js'),
    digest: await import('../src/services/watch-digest-store.js'),
  };
}

const now = new Date('2026-06-24T10:00:00+08:00');
function mkIncident(inbox: any, slug: string, target = 'oc_target') {
  return inbox.upsertIncident({
    watchedChatId: 'oc_w', slug, targetChatId: target, kind: 'digest_item',
    summary: `卡点-${slug}`, evidence: 'e', sourceMessageIds: [`m-${slug}`],
  });
}

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'watch-pub-')); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

describe('buildTargetDigest', () => {
  it('签名与输入顺序无关（稳定）', async () => {
    const { pub, inbox } = await fresh();
    const a = mkIncident(inbox, 'a').incident;
    const b = mkIncident(inbox, 'b').incident;
    const s1 = pub.buildTargetDigest([a, b]).signature;
    const s2 = pub.buildTargetDigest([b, a]).signature;
    expect(s1).toBe(s2);
  });

  it('空集合 → all-clear 文本', async () => {
    const { pub } = await fresh();
    expect(pub.buildTargetDigest([]).text).toContain('都已处理');
  });
});

describe('runDigestTick', () => {
  it('有 open incident → 发 digest + 标 delivery=sent + 消耗预算', async () => {
    const { pub, inbox, digest } = await fresh();
    mkIncident(inbox, 'a');
    const send = vi.fn(async () => 'om_digest1');
    const r = await pub.runDigestTick(now, { send });
    expect(r.sent).toBe(1);
    expect(send).toHaveBeenCalledOnce();
    expect(inbox.getIncident('oc_w:a')!.delivery.deliveryStatus).toBe('sent');
    expect(inbox.getIncident('oc_w:a')!.delivery.messageId).toBe('om_digest1');
    expect(digest.budgetRemaining('oc_target', now)).toBe(digest.DEFAULT_MAX_DIGESTS_PER_DAY - 1);
  });

  it('内容没变 → 第二轮 skip 不重发', async () => {
    const { pub, inbox } = await fresh();
    mkIncident(inbox, 'a');
    const send = vi.fn(async () => 'om_1');
    await pub.runDigestTick(now, { send });
    const r2 = await pub.runDigestTick(new Date(now.getTime() + 60_000), { send });
    expect(r2.skippedUnchanged).toBe(1);
    expect(send).toHaveBeenCalledOnce(); // 只发了一次
  });

  it('close 掉一项 → 签名变 → 重发', async () => {
    const { pub, inbox } = await fresh();
    mkIncident(inbox, 'a');
    mkIncident(inbox, 'b');
    const send = vi.fn(async () => 'om_1');
    await pub.runDigestTick(now, { send });
    inbox.closeIncident('oc_w:b');
    const r2 = await pub.runDigestTick(new Date(now.getTime() + 60_000), { send });
    expect(r2.sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('预算耗尽 → 丢弃不发（留 inbox）', async () => {
    const { pub, inbox } = await fresh();
    mkIncident(inbox, 'a');
    const send = vi.fn(async () => 'om_1');
    // maxPerDay=1：第一次发掉预算
    await pub.runDigestTick(now, { send }, { maxPerDay: 1 });
    // 加新 incident 让签名变（否则会因 unchanged skip），再 tick → 预算耗尽丢弃
    mkIncident(inbox, 'b');
    const r2 = await pub.runDigestTick(new Date(now.getTime() + 60_000), { send }, { maxPerDay: 1 });
    expect(r2.droppedBudget).toBe(1);
    expect(send).toHaveBeenCalledOnce();
  });

  it('发送失败（返 null）→ 不记签名，下轮重试', async () => {
    const { pub, inbox } = await fresh();
    mkIncident(inbox, 'a');
    const failSend = vi.fn(async () => null);
    const r1 = await pub.runDigestTick(now, { send: failSend });
    expect(r1.failed).toBe(1);
    expect(inbox.getIncident('oc_w:a')!.delivery.deliveryStatus).toBe('pending'); // 没标 sent
    // 下轮换成功 send → 应重试并发出（签名没被上次失败记录）
    const okSend = vi.fn(async () => 'om_ok');
    const r2 = await pub.runDigestTick(new Date(now.getTime() + 60_000), { send: okSend });
    expect(r2.sent).toBe(1);
  });

  it('多个被盯群 → 同一目标群聚合成一条', async () => {
    const { pub, inbox } = await fresh();
    inbox.upsertIncident({ watchedChatId: 'oc_w1', slug: 'x', targetChatId: 'oc_target', kind: 'digest_item', summary: 's1', evidence: '', sourceMessageIds: ['m1'] });
    inbox.upsertIncident({ watchedChatId: 'oc_w2', slug: 'y', targetChatId: 'oc_target', kind: 'digest_item', summary: 's2', evidence: '', sourceMessageIds: ['m2'] });
    const send = vi.fn(async () => 'om_1');
    const r = await pub.runDigestTick(now, { send });
    expect(r.sent).toBe(1);
    expect(send).toHaveBeenCalledOnce(); // 一条聚合 digest，不是每群一条
    const text = send.mock.calls[0][1] as string;
    expect(text).toContain('2 项');
  });
});
