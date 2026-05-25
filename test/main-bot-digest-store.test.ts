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

  it('writeDigest implicitly invalidates stale (digest mtime > staleAt)', async () => {
    const store = await freshImport();
    store.markStale();
    // sleep 5ms so digest write mtime is strictly newer than stale marker
    await new Promise(r => setTimeout(r, 5));
    store.writeDigest({
      generatedAt: 'x', chats: [], crossChatThreads: [], pendingForJason: [], escalations: [],
    });
    // stale-marker mtime comparison: after writing digest its mtime is newer,
    // so isStale() returns false even without explicit markFresh. markFresh
    // still works to remove the sidecar file entirely (covered above).
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

/* ───────────────────── Phase A v2 (2026-05-25 妹妹 review #P1) ────────────────────
 * Direct regression coverage for the new Phase A store APIs (discriminated
 * union + normalize + tilly_digest_high lifecycle). 妹妹 review commit 1
 * called out: 5 行为需要专门的 test，不然下面 commit 2/3 接 publisher/daemon
 * 出问题排错成本高。 */
describe('Phase A v2: ScoutInbox union + tilly_digest_high', () => {
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'digest-test-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  const mkPayload = (msgId: string, summary = 's') => ({
    summary, sourceChatId: 'oc_x', sourceChatName: 'X',
    sourceMessageId: msgId, sourceAppLink: 'lark://msg/' + msgId, priority: 'high' as const,
  });

  it('normalizeInbox: 老 schema (无 type) read 时补成 type=escalation', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'scout-inbox.json'), JSON.stringify({
      pending: [{ id: 'legacy_1', enqueuedAt: 'x', status: 'pending', resolvedBy: null, resolution: null,
        escalation: { ruleId: 'R1', triggeredAt: 'x', chatId: 'oc_old', context: 'c', payload: {} } }],
      processed: [],
    }), 'utf-8');
    const store = await freshImport();
    const inbox = store.readInbox();
    expect(inbox.pending).toHaveLength(1);
    expect(inbox.pending[0].type).toBe('escalation');
    expect(inbox.pending[0].id).toBe('legacy_1');
  });

  it('normalizeInbox: 未知 type drop (P2 fix — 防脏数据被静默改造成 escalation)', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'scout-inbox.json'), JSON.stringify({
      pending: [
        { id: 'good_esc', type: 'escalation', enqueuedAt: 'x', status: 'pending', resolvedBy: null, resolution: null,
          escalation: { ruleId: 'R1', triggeredAt: 'x', chatId: 'oc', context: 'c', payload: {} } },
        { id: 'bad', type: 'future_unknown_kind', payload: { x: 1 } },
      ],
      processed: [],
    }), 'utf-8');
    const store = await freshImport();
    const inbox = store.readInbox();
    expect(inbox.pending).toHaveLength(1);
    expect(inbox.pending[0].id).toBe('good_esc');
  });

  it('enqueueTillyDigestHigh: 首次插入 inserted=true; status=pending; notifiedAt=null', async () => {
    const store = await freshImport();
    const r = store.enqueueTillyDigestHigh({ category: 'todo', payload: mkPayload('om_1') });
    expect(r.inserted).toBe(true);
    expect(r.item.type).toBe('tilly_digest_high');
    expect(r.item.status).toBe('pending');
    expect(r.item.notifiedAt).toBeNull();
    expect(r.item.category).toBe('todo');
  });

  it('enqueueTillyDigestHigh: dedup 只看 sourceMessageId — 同 msgId 不同 category 也不入', async () => {
    const store = await freshImport();
    const r1 = store.enqueueTillyDigestHigh({ category: 'todo', payload: mkPayload('om_dup') });
    const r2 = store.enqueueTillyDigestHigh({ category: 'blocker', payload: mkPayload('om_dup', 'same msg as blocker') });
    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(false);
    expect(r2.item.id).toBe(r1.item.id);
    expect(store.readInbox().pending).toHaveLength(1);
  });

  it('enqueueTillyDigestHigh: dedup 跨 dismissed (sink 永久不重新入)', async () => {
    const store = await freshImport();
    const r1 = store.enqueueTillyDigestHigh({ category: 'todo', payload: mkPayload('om_sink') });
    store.dispositionTillyHigh(r1.item.id, { status: 'dismissed', handledBy: 'songsong' });
    const r2 = store.enqueueTillyDigestHigh({ category: 'todo', payload: mkPayload('om_sink', 'try again') });
    expect(r2.inserted).toBe(false);
    expect(r2.item.id).toBe(r1.item.id);
    expect(r2.item.status).toBe('dismissed');
  });

  it('markTillyHighNotified: 标 notifiedAt; listUnnotifiedTillyHigh 防 throttle 后续补发', async () => {
    const store = await freshImport();
    const { item } = store.enqueueTillyDigestHigh({ category: 'todo', payload: mkPayload('om_n1') });
    expect(item.notifiedAt).toBeNull();
    const updated = store.markTillyHighNotified(item.id);
    expect(updated?.notifiedAt).toMatch(/^2\d{3}-/);
    store.enqueueTillyDigestHigh({ category: 'blocker', payload: mkPayload('om_n2') });
    const unnotified = store.listUnnotifiedTillyHigh();
    expect(unnotified.map(i => i.payload.sourceMessageId)).toEqual(['om_n2']);
  });

  it('markTillyHighNotified: escalation item 不会被误打 (类型守卫)', async () => {
    const store = await freshImport();
    const esc = store.enqueueEscalation({ ruleId: 'R1', triggeredAt: 'x', chatId: 'oc', context: 'c', payload: {} });
    expect(store.markTillyHighNotified(esc.id)).toBeNull();
  });

  it('dispositionTillyHigh: pending → processed 保留 handledBy/handledAt/resolution 审计', async () => {
    const store = await freshImport();
    const { item } = store.enqueueTillyDigestHigh({ category: 'todo', payload: mkPayload('om_d1') });
    const r = store.dispositionTillyHigh(item.id, { status: 'processed', handledBy: 'claude_handler_xyz', resolution: '已 ping 松松' });
    expect(r?.status).toBe('processed');
    expect(r?.handledBy).toBe('claude_handler_xyz');
    expect(r?.handledAt).toMatch(/^2\d{3}-/);
    expect(r?.resolution).toBe('已 ping 松松');
    const inbox = store.readInbox();
    expect(inbox.pending).toHaveLength(0);
    expect(inbox.processed).toHaveLength(1);
  });

  it('dispositionTillyHigh: 不存在 id 返 null', async () => {
    const store = await freshImport();
    expect(store.dispositionTillyHigh('nope', { status: 'dismissed', handledBy: 'x' })).toBeNull();
  });

  it('dispositionTillyHigh: escalation item 不会被误打 (类型守卫)', async () => {
    const store = await freshImport();
    const esc = store.enqueueEscalation({ ruleId: 'R1', triggeredAt: 'x', chatId: 'oc', context: 'c', payload: {} });
    expect(store.dispositionTillyHigh(esc.id, { status: 'dismissed', handledBy: 'x' })).toBeNull();
  });

  it('markInProgress 不碰 tilly_digest_high (类型守卫)', async () => {
    const store = await freshImport();
    const { item } = store.enqueueTillyDigestHigh({ category: 'todo', payload: mkPayload('om_m1') });
    expect(store.markInProgress(item.id)).toBeNull();
    expect(store.readInbox().pending[0].status).toBe('pending');
  });

  it('markResolved 不碰 tilly_digest_high (类型守卫)', async () => {
    const store = await freshImport();
    const { item } = store.enqueueTillyDigestHigh({ category: 'todo', payload: mkPayload('om_r1') });
    expect(store.markResolved(item.id, 'x', 'y')).toBeNull();
    expect(store.readInbox().pending).toHaveLength(1);
    expect(store.readInbox().processed).toHaveLength(0);
  });
});
