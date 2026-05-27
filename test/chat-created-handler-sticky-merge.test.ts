/**
 * 2026-05-27 (松松实拍 bug): "派生自: (无父群)" — root cause
 * dispatchChatCreated 被两条路径调用 (Lark event 无 parent / group-creator 有
 * parent), 如果 event 先到 ChatContext.create() 写 parent=null first-writer
 * wins, 后到的 group-creator dispatch skip → ChatContext 永远缺 parent。
 *
 * fix: dispatchChatCreated 在 isFirstDispatch=false 且本次带 parent 时, 用
 * update() 把 inheritedFrom backfill 回去 (sticky-merge), 同步 升级
 * originType + purpose + participants 占位升级。
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
// chat-topology-store 写文件; helper 加 atomic — 真实运行 OK, test 隔离 OK.
vi.mock('../src/im/lark/chat-context-card.js', () => ({
  sendContextCard: vi.fn(async () => null),
}));

async function freshImports() {
  vi.resetModules();
  return {
    handler: await import('../src/im/lark/chat-created-handler.js'),
    store: await import('../src/services/chat-context-store.js'),
  };
}

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'sticky-merge-')); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

describe('dispatchChatCreated sticky-merge (2026-05-27 松松实拍 bug)', () => {
  it('Lark event 先到 (无 parent) → group-creator 后到 (带 parent): parent 被 backfill 回 inheritedFrom', async () => {
    const { handler, store } = await freshImports();
    // Step 1: Lark event 先到, parentChatId undefined → first-writer wins, 写 parent=null
    await handler.dispatchChatCreated({
      chatId: 'oc_child',
      larkAppId: 'app_x',
      originType: 'bot_spawned',
      // parentChatId 不传 (event payload 不带)
    });
    let ctx = store.read('oc_child');
    expect(ctx?.inheritedFrom).toBeNull();
    // Step 2: group-creator 后到, 带 parentChatId. sticky-merge 应 backfill
    await handler.dispatchChatCreated({
      chatId: 'oc_child',
      larkAppId: 'app_x',
      originType: 'bot_spawned',
      parentChatId: 'oc_flumy',
      parentDigest: '父群最近 1 句摘要',
      purpose: '真正的 task purpose',
      participants: [{ openId: 'ou_real', role: 'owner' }],
    });
    ctx = store.read('oc_child');
    expect(ctx?.inheritedFrom?.parentChatId).toBe('oc_flumy');
    expect(ctx?.inheritedFrom?.parentDigest).toBe('父群最近 1 句摘要');
    // purpose + participants 也 sticky-merge 升级
    expect(ctx?.purpose).toBe('真正的 task purpose');
    expect(ctx?.participants).toHaveLength(1);
    expect(ctx?.participants[0].openId).toBe('ou_real');
  });

  it('group-creator 先到 (带 parent) → Lark event 后到 (无 parent): parent 不被覆盖', async () => {
    const { handler, store } = await freshImports();
    // Step 1: group-creator 先到带 parent
    await handler.dispatchChatCreated({
      chatId: 'oc_child2',
      larkAppId: 'app_x',
      originType: 'bot_spawned',
      parentChatId: 'oc_flumy',
      parentDigest: 'd1',
    });
    expect(store.read('oc_child2')?.inheritedFrom?.parentChatId).toBe('oc_flumy');
    // Step 2: Lark event 后到无 parent, sticky-merge 条件不命中 (existing 已有 parent), 不动
    await handler.dispatchChatCreated({
      chatId: 'oc_child2',
      larkAppId: 'app_x',
      originType: 'bot_spawned',
      // 不传 parentChatId
    });
    expect(store.read('oc_child2')?.inheritedFrom?.parentChatId).toBe('oc_flumy');
  });

  it('已有 parent + 后到带 parent (重复 dispatch): 不动 existing (不让 second writer 覆盖第一次写好的)', async () => {
    const { handler, store } = await freshImports();
    await handler.dispatchChatCreated({
      chatId: 'oc_child3',
      larkAppId: 'app_x',
      originType: 'bot_spawned',
      parentChatId: 'oc_first',
    });
    await handler.dispatchChatCreated({
      chatId: 'oc_child3',
      larkAppId: 'app_x',
      originType: 'bot_spawned',
      parentChatId: 'oc_should_not_overwrite',
    });
    expect(store.read('oc_child3')?.inheritedFrom?.parentChatId).toBe('oc_first');
  });

  it('originType 升级: existing human_created → 后到 bot_spawned (含 parent), 同时升级 originType', async () => {
    const { handler, store } = await freshImports();
    // 模拟 onMessage 先把 chat 当 human_created 写进去 (没 parent)
    await handler.dispatchChatCreated({
      chatId: 'oc_child4',
      larkAppId: 'app_x',
      originType: 'human_created',
    });
    expect(store.read('oc_child4')?.originType).toBe('human_created');
    // group-creator 后到带 parent + bot_spawned
    await handler.dispatchChatCreated({
      chatId: 'oc_child4',
      larkAppId: 'app_x',
      originType: 'bot_spawned',
      parentChatId: 'oc_flumy',
    });
    const ctx = store.read('oc_child4');
    expect(ctx?.originType).toBe('bot_spawned');
    expect(ctx?.inheritedFrom?.parentChatId).toBe('oc_flumy');
  });

  // 妹妹 review (commit 479057f) 建议 2 (2026-05-27): existing 已是 bot_spawned,
  // 后到 dispatch 是 human_created+parent → parent 应 backfill 但 originType
  // 不降级 (信息量 bot_spawned > human_created, 单向升级)
  it('originType 单向升级 (不降级): existing bot_spawned → 后到 human_created+parent, parent 补但 originType 保 bot_spawned', async () => {
    const { handler, store } = await freshImports();
    await handler.dispatchChatCreated({
      chatId: 'oc_child5',
      larkAppId: 'app_x',
      originType: 'bot_spawned',
    });
    expect(store.read('oc_child5')?.originType).toBe('bot_spawned');
    await handler.dispatchChatCreated({
      chatId: 'oc_child5',
      larkAppId: 'app_x',
      originType: 'human_created',
      parentChatId: 'oc_flumy',
    });
    const ctx = store.read('oc_child5');
    expect(ctx?.originType).toBe('bot_spawned');                       // 不降级
    expect(ctx?.inheritedFrom?.parentChatId).toBe('oc_flumy');         // parent 补上
  });

  // 妹妹 review 建议 1 (2026-05-27): 把 parent backfill 和 field enrichment
  // 拆条件 — 没传 parent 但带真 purpose 时, purpose 仍应升级 (旧代码 enrichment
  // 全绑 opts.parentChatId truthy → 此场景被错过)
  it('field enrichment 不依赖 parent: 后到 dispatch 没 parent 但带真 purpose → purpose 升级', async () => {
    const { handler, store } = await freshImports();
    await handler.dispatchChatCreated({
      chatId: 'oc_child6',
      larkAppId: 'app_x',
      originType: 'bot_spawned',
    });
    expect(store.read('oc_child6')?.purpose).toBe('（待 main-bot 自动推断）');
    await handler.dispatchChatCreated({
      chatId: 'oc_child6',
      larkAppId: 'app_x',
      originType: 'bot_spawned',
      purpose: '真实 task purpose',
      // 故意不传 parentChatId
    });
    expect(store.read('oc_child6')?.purpose).toBe('真实 task purpose');
  });

  it('field enrichment 不依赖 parent: 后到带 participants 但没 parent → participants 补', async () => {
    const { handler, store } = await freshImports();
    await handler.dispatchChatCreated({
      chatId: 'oc_child7',
      larkAppId: 'app_x',
      originType: 'bot_spawned',
    });
    expect(store.read('oc_child7')?.participants).toHaveLength(0);
    await handler.dispatchChatCreated({
      chatId: 'oc_child7',
      larkAppId: 'app_x',
      originType: 'bot_spawned',
      participants: [{ openId: 'ou_x', role: 'owner' }],
      // 故意不传 parentChatId
    });
    expect(store.read('oc_child7')?.participants).toHaveLength(1);
  });

  // 妹妹 review blocker (2026-05-27 commit 6bc448a 后): legacy / partial
  // ChatContext 可能 participants=undefined (旧数据或测试 mock), 直接 .length
  // 会 TypeError。array guard 锁住。
  it('legacy / partial existing context (participants=undefined): sticky-merge 不 crash', async () => {
    const { handler, store } = await freshImports();
    // 直接用 store.create() 手造一个「legacy」context (participants 后 stripped)
    store.create('oc_legacy', {
      purpose: '（待 main-bot 自动推断）',
      originType: 'bot_spawned',
      parentChatId: null,
      participants: [],
    });
    // 手动伪造 partial-write: 把 participants 字段从 disk 上抹掉 (模拟旧版本写过的数据)
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { config } = await import('../src/config.js');
    const fp = path.join(config.session.dataDir, 'chat-contexts', 'oc_legacy.json');
    const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    delete raw.participants;
    fs.writeFileSync(fp, JSON.stringify(raw), 'utf-8');
    // 后到 dispatch 带 parent + participants — 不应 crash, 应 sticky-merge 补 parent + participants
    await expect(handler.dispatchChatCreated({
      chatId: 'oc_legacy',
      larkAppId: 'app_x',
      originType: 'bot_spawned',
      parentChatId: 'oc_flumy',
      participants: [{ openId: 'ou_real', role: 'owner' }],
    })).resolves.not.toThrow();
    const ctx = store.read('oc_legacy');
    expect(ctx?.inheritedFrom?.parentChatId).toBe('oc_flumy');
    expect(ctx?.participants).toHaveLength(1);
  });
});
