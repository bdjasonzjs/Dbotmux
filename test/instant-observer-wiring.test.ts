/**
 * instant-observer × event-dispatcher 接线测试（review P1-1 / P2-2）。
 *
 * 验证 processMessageEvent 到 instant service 的真实参数接线：
 *   - 群消息在 ensureBotOpenId 之后调用 noteInstantObserverMessage，
 *     发送者身份分 senderOpenId / senderAppId 两个域传入（不混装）；
 *   - app_id-only 的 bot 消息把 app_id 传进 senderAppId 域；
 *   - P2P 消息不挂钩；
 *   - note 抛异常不阻塞消息路由（bookkeeping 后续逻辑照常执行）。
 *
 * Harness 复用 event-dispatcher-auto-unarchive.test.ts 的隔离方式。
 * Run: pnpm vitest run test/instant-observer-wiring.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── instant-observer（被观察对象）─────────────────────────────────────────
const mockNote = vi.fn();
vi.mock('../src/services/instant-observer.js', () => ({
  noteInstantObserverMessage: (...args: any[]) => mockNote(...args),
  // scheduler 等模块可能转依赖这些导出，给足 stub
  isInstantObserverTask: () => false,
  instantTaskStillWanted: () => true,
  instantTaskId: (c: string, a: string) => `inst_${c}_${a}`,
  instantTaskName: (c: string) => `instant-observer:${c}`,
  INSTANT_TASK_NAME_PREFIX: 'instant-observer:',
  INSTANT_TASK_ID_PREFIX: 'inst_',
  MIN_DEBOUNCE_SECONDS: 60,
  MAX_DEBOUNCE_SECONDS: 120,
  DEFAULT_DEBOUNCE_SECONDS: 90,
  clampDebounceSeconds: (v: number) => v ?? 90,
  cancelPendingInstantTasks: () => 0,
  scheduleInstantOnceTask: async () => 'created',
  noteInstantObserverMessageWith: async () => 'no-policy',
  defaultInstantPrompt: () => '',
}));

// ─── 观察路由是否继续：chat-context-store 的 unarchive ─────────────────────
const mockIsArchived = vi.fn<(chatId: string) => boolean>(() => true);
const mockUnarchive = vi.fn();
vi.mock('../src/services/chat-context-store.js', () => ({
  isArchived: (...args: any[]) => mockIsArchived(...(args as [string])),
  unarchive: (...args: any[]) => mockUnarchive(...args),
  read: vi.fn(() => null),
  create: vi.fn(),
  archive: vi.fn(),
  update: vi.fn(),
  upsert: vi.fn(),
  listChatIds: vi.fn(() => []),
  remove: vi.fn(() => false),
}));

// ─── 支撑模块 stub（与 auto-unarchive harness 同款）────────────────────────
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => '[]'),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockGetBot = vi.fn();
vi.mock('../src/bot-registry.js', () => ({
  getBot: (...args: any[]) => mockGetBot(...args),
  getAllBots: () => [],
  isChatOncallBoundForAnyBot: () => false,
}));

vi.mock('../src/im/lark/client.js', () => ({
  getChatInfo: vi.fn(async () => ({ userCount: 1, botCount: 1 })),
  getChatMode: vi.fn(async () => 'topic'),
  listChatBotMembers: vi.fn(async () => []),
  replyMessage: vi.fn(async () => 'msg-id'),
}));

vi.mock('../src/services/observed-bots-store.js', () => ({
  recordObservedBots: vi.fn(),
  listObservedBots: vi.fn(() => []),
}));

vi.mock('../src/services/chat-topology-store.js', () => ({
  bumpMessage: vi.fn(),
  readTopology: vi.fn(() => ({ nodes: [], edges: [] })),
}));

vi.mock('../src/services/main-bot-digest-store.js', () => ({
  markStale: vi.fn(),
  readDigest: vi.fn(() => ({ generatedAt: '', chats: [], crossChatThreads: [], pendingForJason: [], escalations: [] })),
  readInbox: vi.fn(() => ({ pending: [], processed: [] })),
  writeDigest: vi.fn(),
  markFresh: vi.fn(),
  enqueueEscalation: vi.fn(),
}));

vi.mock('../src/services/seen-message-store.js', () => ({
  claimMessageOnce: vi.fn(() => true),
  _resetCacheForTest: vi.fn(),
}));

let capturedHandlers: Record<string, Function> = {};
vi.mock('@larksuiteoapi/node-sdk', () => {
  class MockEventDispatcher {
    register(handlers: Record<string, Function>) { capturedHandlers = handlers; return this; }
  }
  class MockWSClient { start() {} }
  return { EventDispatcher: MockEventDispatcher, WSClient: MockWSClient, LoggerLevel: { info: 2 } };
});

// ─── Imports must come AFTER vi.mock ───────────────────────────────────────
import { startLarkEventDispatcher } from '../src/im/lark/event-dispatcher.js';

const MY_APP_ID = 'app-bot-a';
const MY_OPEN_ID = 'ou_bot_a_open_id';
const TARGET_CHAT = 'oc_instant_target';

function setupBot() {
  mockGetBot.mockReturnValue({
    config: { larkAppId: MY_APP_ID, larkAppSecret: 'secret', cliId: 'claude-code' },
    botOpenId: MY_OPEN_ID,
    resolvedAllowedUsers: [],
  });
}

function makeEvent(opts: {
  senderType: 'user' | 'app' | 'bot';
  senderOpenId?: string;
  senderAppId?: string;
  chatType?: 'group' | 'p2p';
}) {
  const sender_id: Record<string, string> = {};
  if (opts.senderOpenId) sender_id.open_id = opts.senderOpenId;
  if (opts.senderAppId) sender_id.app_id = opts.senderAppId;
  return {
    message: {
      message_id: 'msg-001',
      root_id: '',
      thread_id: undefined,
      chat_id: TARGET_CHAT,
      chat_type: opts.chatType ?? 'group',
      content: JSON.stringify({ text: 'hello' }),
      mentions: [],
    },
    sender: { sender_type: opts.senderType, sender_id },
  };
}

async function dispatch(event: ReturnType<typeof makeEvent>) {
  const handler = capturedHandlers['im.message.receive_v1'];
  if (!handler) throw new Error('im.message.receive_v1 handler not captured');
  await handler(event);
}

describe('instant-observer event-dispatcher 接线', () => {
  beforeEach(() => {
    capturedHandlers = {};
    mockNote.mockReset();
    mockIsArchived.mockClear();
    mockIsArchived.mockReturnValue(true);
    mockUnarchive.mockClear();
    setupBot();
    startLarkEventDispatcher(MY_APP_ID, 'secret', {
      handleCardAction: async () => undefined,
      handleNewTopic: async () => {},
      handleThreadReply: async () => {},
      isSessionOwner: () => false,
      onChatModeConverted: () => {},
    });
  });

  it('群内人类消息 → note 被调用，senderOpenId/senderAppId 分域、botOpenId 已解析（ensureBotOpenId 之后）', async () => {
    await dispatch(makeEvent({ senderType: 'user', senderOpenId: 'ou_human' }));
    await vi.waitFor(() => expect(mockNote).toHaveBeenCalledTimes(1));
    expect(mockNote).toHaveBeenCalledWith({
      larkAppId: MY_APP_ID,
      chatId: TARGET_CHAT,
      senderOpenId: 'ou_human',
      senderAppId: undefined,
      botOpenId: MY_OPEN_ID, // 已解析，不是 undefined —— 挂钩点在 ensureBotOpenId 之后
    });
  });

  it('app_id-only 的 bot 消息 → app_id 进 senderAppId 域，绝不混进 senderOpenId（P1-1）', async () => {
    await dispatch(makeEvent({ senderType: 'app', senderAppId: MY_APP_ID }));
    await vi.waitFor(() => expect(mockNote).toHaveBeenCalledTimes(1));
    const arg = mockNote.mock.calls[0][0];
    expect(arg.senderOpenId).toBeUndefined();
    expect(arg.senderAppId).toBe(MY_APP_ID);
  });

  it('open_id + app_id 都有的 bot 消息 → 两域各归各位', async () => {
    await dispatch(makeEvent({ senderType: 'bot', senderOpenId: 'ou_peer_bot', senderAppId: 'cli_peer' }));
    await vi.waitFor(() => expect(mockNote).toHaveBeenCalledTimes(1));
    const arg = mockNote.mock.calls[0][0];
    expect(arg.senderOpenId).toBe('ou_peer_bot');
    expect(arg.senderAppId).toBe('cli_peer');
  });

  it('P2P 消息不挂钩', async () => {
    await dispatch(makeEvent({ senderType: 'user', senderOpenId: 'ou_human', chatType: 'p2p' }));
    // p2p 无 bookkeeping 段；等路由完成后确认 note 从未被调用
    await new Promise(r => setTimeout(r, 20));
    expect(mockNote).not.toHaveBeenCalled();
  });

  it('note 同步抛异常 → 被挂钩点 try/catch 吞掉，不打断路由管线', async () => {
    mockNote.mockImplementation(() => { throw new Error('boom'); });
    // 本条消息处理正常收尾（异常没有从 handler 冒出来）
    await expect(dispatch(makeEvent({ senderType: 'user', senderOpenId: 'ou_human' }))).resolves.toBeUndefined();
    await vi.waitFor(() => expect(mockNote).toHaveBeenCalledTimes(1));
    // 管线仍然存活：后续消息照常走完 bookkeeping（unarchive 可观察）
    mockNote.mockImplementation(() => {});
    mockUnarchive.mockClear();
    await dispatch(makeEvent({ senderType: 'user', senderOpenId: 'ou_human2' }));
    await vi.waitFor(() => expect(mockUnarchive).toHaveBeenCalledWith(TARGET_CHAT));
  });
});
