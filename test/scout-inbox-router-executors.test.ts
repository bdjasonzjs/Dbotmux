/**
 * Phase B.2 follow-up (2026-05-27): executor idempotency 防 crash window
 * 重复建群 (妹妹 review blocker B2).
 *
 * 仅 cover spawnHandler 的幂等行为: 同 item.id 两次调 → createGroupWithBots
 * 只跑一次, 第 2 次拿 cache hit 同 chatId.
 *
 * 不测 pingJason — 它跟 lark sendMessage 强耦合, integration 层覆盖。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;
const createMock = vi.fn();

vi.mock('../src/config.js', () => ({
  config: { get session() { return { dataDir: tempDir }; } },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));
vi.mock('../src/services/group-creator.js', () => ({
  createGroupWithBots: createMock,
}));
vi.mock('../src/im/lark/client.js', () => ({
  sendMessage: vi.fn().mockResolvedValue('om_test_msg'),
}));
vi.mock('../src/services/main-topic-config.js', () => ({
  getMainTopicChatId: () => 'oc_main_topic_test',
}));
vi.mock('../src/core/main-bot-playbook.js', () => ({
  resolveBotIdent: (k: string) => ({
    larkAppId: `cli_${k}_app`,
    openId: `ou_${k}_open`,
  }),
}));

async function freshImport() {
  vi.resetModules();
  createMock.mockReset();
  return await import('../src/services/scout-inbox-router-executors.js');
}

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'exec-idem-')); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

function mkItem(id: string) {
  return {
    type: 'tilly_digest_high' as const,
    id, enqueuedAt: '2026-05-27T10:00:00Z',
    category: 'todo' as const,
    payload: { summary: `s-${id}`, sourceChatId: 'oc_x', sourceChatName: 'c', sourceMessageId: 'om_x' },
    status: 'pending' as const,
    notifiedAt: null, handledBy: null, handledAt: null, resolution: null,
  };
}

describe('spawnHandler idempotency (妹妹 review B2)', () => {
  it('同 item.id 二次 spawn → createGroupWithBots 只跑 1 次, 第 2 次拿 cache hit', async () => {
    const m = await freshImport();
    createMock.mockResolvedValue({ ok: true, chatId: 'oc_spawn_1', creator: 'cli', invalidBotIds: [], invalidUserIds: [], ownerTransferredTo: null, transferError: null, notifyMessageId: null, notifyError: null, oncallBindings: [] });
    const executors = m.makeProductionExecutors({ larkAppId: 'cli_app' });

    const item = mkItem('item_A');
    const r1 = await executors.spawnHandler(item);
    const r2 = await executors.spawnHandler(item);
    expect(r1).toBe('oc_spawn_1');
    expect(r2).toBe('oc_spawn_1');                  // 同 chatId
    expect(createMock).toHaveBeenCalledTimes(1);    // 真 create 只跑 1 次
  });

  it('不同 item.id → 各自独立 spawn (2 次 create)', async () => {
    const m = await freshImport();
    createMock
      .mockResolvedValueOnce({ ok: true, chatId: 'oc_spawn_A', creator: 'cli', invalidBotIds: [], invalidUserIds: [], ownerTransferredTo: null, transferError: null, notifyMessageId: null, notifyError: null, oncallBindings: [] })
      .mockResolvedValueOnce({ ok: true, chatId: 'oc_spawn_B', creator: 'cli', invalidBotIds: [], invalidUserIds: [], ownerTransferredTo: null, transferError: null, notifyMessageId: null, notifyError: null, oncallBindings: [] });
    const executors = m.makeProductionExecutors({ larkAppId: 'cli_app' });
    const r1 = await executors.spawnHandler(mkItem('item_A'));
    const r2 = await executors.spawnHandler(mkItem('item_B'));
    expect(r1).toBe('oc_spawn_A');
    expect(r2).toBe('oc_spawn_B');
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('createGroupWithBots throw → spawnHandler 返 null, 下次重试不被 cache 锁死', async () => {
    const m = await freshImport();
    createMock
      .mockRejectedValueOnce(new Error('lark 5xx'))
      .mockResolvedValueOnce({ ok: true, chatId: 'oc_retry_ok', creator: 'cli', invalidBotIds: [], invalidUserIds: [], ownerTransferredTo: null, transferError: null, notifyMessageId: null, notifyError: null, oncallBindings: [] });
    const executors = m.makeProductionExecutors({ larkAppId: 'cli_app' });
    const item = mkItem('item_C');
    const r1 = await executors.spawnHandler(item);
    expect(r1).toBeNull();                          // 失败返 null
    const r2 = await executors.spawnHandler(item);
    expect(r2).toBe('oc_retry_ok');                 // 同 item 第 2 次重试成功
    expect(createMock).toHaveBeenCalledTimes(2);    // 第 1 次 throw 没写 cache, 第 2 次真跑
  });
});
