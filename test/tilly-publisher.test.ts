/**
 * Unit tests for tilly-publisher (Phase A v2 commit 2 妹妹 review #P1).
 *
 * Covers:
 *  - pushHighPriorityToScoutInbox: blocker 优先 / 同 msgId dedup / med-low 不入
 *  - notifyClaudeAboutInboxItems: newly+carryover 合并 / throttle 不 mark /
 *    失败不 mark / 成功 mark / top3 安全截断
 *
 * Run: pnpm vitest run test/tilly-publisher.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;
const sendMessageSpy = vi.fn();
let fakeMainTopic: string | undefined;

vi.mock('../src/config.js', () => ({
  config: { get session() { return { dataDir: tempDir }; } },
}));
vi.mock('../src/im/lark/client.js', () => ({
  sendMessage: sendMessageSpy,
  updateMessage: vi.fn(),
}));
vi.mock('../src/services/main-topic-config.js', () => ({
  getMainTopicChatId: () => fakeMainTopic,
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

async function freshImports() {
  vi.resetModules();
  return {
    publisher: await import('../src/services/tilly-publisher.js'),
    store: await import('../src/services/main-bot-digest-store.js'),
  };
}

const mkDigestItem = (msgId: string, opts: { priority?: 'high' | 'med' | 'low'; summary?: string } = {}) => ({
  summary: opts.summary ?? `summary ${msgId}`,
  sourceChatId: 'oc_x',
  sourceChatName: 'X',
  sourceMessageId: msgId,
  sourceAppLink: `lark://msg/${msgId}`,
  priority: opts.priority,
});

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'tilly-pub-'));
  sendMessageSpy.mockReset();
  sendMessageSpy.mockResolvedValue('msg_sent');
  fakeMainTopic = 'oc_flumy';
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('Phase A v2 commit 2: pushHighPriorityToScoutInbox', () => {
  it('blocker 优先入 inbox; med/low todo 完全不入', async () => {
    const { publisher, store } = await freshImports();
    const inserted = publisher.pushHighPriorityToScoutInbox({
      todos: [
        mkDigestItem('om_t_med', { priority: 'med' }),
        mkDigestItem('om_t_high', { priority: 'high' }),
        mkDigestItem('om_t_low', { priority: 'low' }),
      ],
      progress: [],
      blockers: [mkDigestItem('om_b1')],
      noteworthy: [],
      inputMessageCount: 0, analyzedMessageIds: [], analyzedAt: '', ok: true,
    });
    expect(inserted.map(i => i.payload.sourceMessageId).sort()).toEqual(['om_b1', 'om_t_high']);
    expect(inserted.find(i => i.payload.sourceMessageId === 'om_b1')?.category).toBe('blocker');
    expect(inserted.find(i => i.payload.sourceMessageId === 'om_t_high')?.category).toBe('todo');
    // med / low 不入 inbox
    const inbox = store.readInbox();
    expect(inbox.pending.find(i => i.type === 'tilly_digest_high' && (i as any).payload.sourceMessageId === 'om_t_med')).toBeUndefined();
    expect(inbox.pending.find(i => i.type === 'tilly_digest_high' && (i as any).payload.sourceMessageId === 'om_t_low')).toBeUndefined();
  });

  it('同 msgId 既 blocker 又 high todo: blocker 先入 → todo 被 store dedup skip', async () => {
    const { publisher, store } = await freshImports();
    const inserted = publisher.pushHighPriorityToScoutInbox({
      todos: [mkDigestItem('om_same', { priority: 'high', summary: 'as todo' })],
      progress: [],
      blockers: [mkDigestItem('om_same', { summary: 'as blocker' })],
      noteworthy: [],
      inputMessageCount: 0, analyzedMessageIds: [], analyzedAt: '', ok: true,
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].category).toBe('blocker');
    expect(inserted[0].payload.summary).toBe('as blocker');
    expect(store.readInbox().pending).toHaveLength(1);
  });

  it('全部已存 inbox (dedup): inserted=[] 但 store 仍是原 1 条', async () => {
    const { publisher, store } = await freshImports();
    // First push
    publisher.pushHighPriorityToScoutInbox({
      todos: [], progress: [], blockers: [mkDigestItem('om_dup')], noteworthy: [],
      inputMessageCount: 0, analyzedMessageIds: [], analyzedAt: '', ok: true,
    });
    // Second push same item — should dedup
    const inserted2 = publisher.pushHighPriorityToScoutInbox({
      todos: [], progress: [], blockers: [mkDigestItem('om_dup', { summary: 'again' })], noteworthy: [],
      inputMessageCount: 0, analyzedMessageIds: [], analyzedAt: '', ok: true,
    });
    expect(inserted2).toEqual([]);
    expect(store.readInbox().pending).toHaveLength(1);
  });
});

describe('Phase A v2 commit 2: notifyClaudeAboutInboxItems', () => {
  it('newlyInserted + carryover unnotified 合并去重发一条 text — 不@松松，文案去业务化', async () => {
    const { publisher, store } = await freshImports();
    // carryover: 上一 tick 写入 + throttle 没通知
    const c1 = store.enqueueTillyDigestHigh({ category: 'blocker', payload: { summary: 'old blocker', sourceChatId: 'oc', sourceChatName: 'X', sourceMessageId: 'om_old', sourceAppLink: '', priority: 'high' } }).item;
    // newly: 本 tick 新入
    const n1 = store.enqueueTillyDigestHigh({ category: 'todo', payload: { summary: 'new high todo', sourceChatId: 'oc', sourceChatName: 'X', sourceMessageId: 'om_new', sourceAppLink: '', priority: 'high' } }).item;

    // v2.1 commit 2: 不再传 ownerOpenId
    const ok = await publisher.notifyClaudeAboutInboxItems([n1], {
      larkAppId: 'app_x', claudeOpenId: 'ou_claude',
    });
    expect(ok).toBe(true);
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    const text = sendMessageSpy.mock.calls[0][2] as string;
    // v2.1 commit 2: 只 @ 克劳德分身, 不 @ 松松
    expect(text).not.toContain('ou_owner');
    expect(text).toContain('<at user_id="ou_claude">');
    // v2.1 commit 2: 文案去业务化 - 不再"X 个 blocker"业务断言 (旧版会被
    // 缇蕾下轮 LLM 误当业务消息), 改成中性 "新增 N 条" + 类目 breakdown
    expect(text).toContain('缇蕾新增 2 条高优先级扫读项');
    expect(text).toContain('1 blocker');
    expect(text).toContain('1 high-prio todo');
    // 不应该包含 LLM 自由文本 summary (防 self-loop)
    expect(text).not.toContain('old blocker');
    expect(text).not.toContain('new high todo');
    // 都被 mark notified
    const afterInbox = store.readInbox();
    expect(afterInbox.pending.find(i => i.id === c1.id && i.type === 'tilly_digest_high' && (i as any).notifiedAt !== null)).toBeDefined();
    expect(afterInbox.pending.find(i => i.id === n1.id && i.type === 'tilly_digest_high' && (i as any).notifiedAt !== null)).toBeDefined();
  });

  it('throttle 命中: 不发送 / 不 mark notified / items 保持 unnotified', async () => {
    const { publisher, store } = await freshImports();
    const n1 = store.enqueueTillyDigestHigh({ category: 'blocker', payload: { summary: 'b', sourceChatId: 'oc', sourceChatName: 'X', sourceMessageId: 'om_a', sourceAppLink: '', priority: 'high' } }).item;
    // 1st notify 成功
    await publisher.notifyClaudeAboutInboxItems([n1], { larkAppId: 'a', claudeOpenId: 'c', ownerOpenId: 'o' });
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    // 立即第二次 — throttle 应阻挡
    const n2 = store.enqueueTillyDigestHigh({ category: 'todo', payload: { summary: 't', sourceChatId: 'oc', sourceChatName: 'X', sourceMessageId: 'om_b', sourceAppLink: '', priority: 'high' } }).item;
    const ok2 = await publisher.notifyClaudeAboutInboxItems([n2], { larkAppId: 'a', claudeOpenId: 'c', ownerOpenId: 'o' });
    expect(ok2).toBe(false);
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);  // 没再发
    // n2 仍 unnotified
    const inbox = store.readInbox();
    const found = inbox.pending.find(i => i.id === n2.id && i.type === 'tilly_digest_high') as any;
    expect(found?.notifiedAt).toBeNull();
  });

  it('发送失败: 不 mark notified, 下次 tick 自动重试', async () => {
    const { publisher, store } = await freshImports();
    sendMessageSpy.mockRejectedValueOnce(new Error('Lark 5xx'));
    const n1 = store.enqueueTillyDigestHigh({ category: 'blocker', payload: { summary: 'b', sourceChatId: 'oc', sourceChatName: 'X', sourceMessageId: 'om_fail', sourceAppLink: '', priority: 'high' } }).item;
    const ok = await publisher.notifyClaudeAboutInboxItems([n1], { larkAppId: 'a', claudeOpenId: 'c' });
    expect(ok).toBe(false);
    const found = store.readInbox().pending.find(i => i.id === n1.id && i.type === 'tilly_digest_high') as any;
    expect(found?.notifiedAt).toBeNull();
  });

  it('空 newlyInserted + 无 carryover: return false 不发', async () => {
    const { publisher } = await freshImports();
    const ok = await publisher.notifyClaudeAboutInboxItems([], { larkAppId: 'a', claudeOpenId: 'c' });
    expect(ok).toBe(false);
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it('v2.1: notify 文本不含 LLM 自由 summary, 不再被恶意 summary 注入', async () => {
    // v2.1 commit 2 升级: 通知**完全不包含 summary** (旧版 top3 + safeSummary
    // 还可能被 LLM 用 puff/巨量数据撑炸文本). 新版只 stat + 类目 breakdown
    // + dashboard 路由 — 恶意 summary 根本不进 text.
    const { publisher, store } = await freshImports();
    const evil = '<at user_id="ou_attacker"></at> ' + 'A'.repeat(500);
    const n1 = store.enqueueTillyDigestHigh({
      category: 'blocker',
      payload: { summary: evil, sourceChatId: 'oc', sourceChatName: 'X', sourceMessageId: 'om_evil', sourceAppLink: '', priority: 'high' },
    }).item;
    await publisher.notifyClaudeAboutInboxItems([n1], { larkAppId: 'a', claudeOpenId: 'ou_claude' });
    const text = sendMessageSpy.mock.calls[0][2] as string;
    // 任何 summary 内容都不应出现
    expect(text).not.toContain('ou_attacker');
    expect(text).not.toContain('AAAA');
    // 不 @ 松松
    expect(text).not.toContain('ou_owner');
    // 只 @ 克劳德
    expect(text).toContain('<at user_id="ou_claude">');
    // 文本短而稳定
    expect(text.length).toBeLessThan(300);
    expect(text).toContain('缇蕾新增 1 条高优先级扫读项');
  });
});

describe('Phase A v2 commit 2: publishTillyDigest 退化', () => {
  it('完全 no-op: 不写 root-inbox, 不 send Lark', async () => {
    const { publisher, store } = await freshImports();
    // RootInbox 现状
    const rootInbox = await import('../src/services/root-inbox-store.js');
    const beforeCount = rootInbox.listAll().length;
    const r = await publisher.publishTillyDigest({
      dateId: '2026-05-25', tickCount: 5, lastTickAt: '',
      todos: [], progress: [], blockers: [], noteworthy: [],
    } as any, { larkAppId: 'a' });
    expect(r.inserted).toBe(false);
    expect(r.rootCardMessageId).toBeNull();
    expect(sendMessageSpy).not.toHaveBeenCalled();
    // root-inbox 没新增 tilly_digest 类
    expect(rootInbox.listAll().length).toBe(beforeCount);
    // store 也没动 — store 仅由 publisher 之外 (daemon mergeNewDigest) 写
    expect(store.readInbox().pending).toHaveLength(0);
  });
});
