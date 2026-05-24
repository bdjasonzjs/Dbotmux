/**
 * Regression: auto-unarchive must only trigger on *human* messages.
 *
 * P2 finding from review: the previous implementation called
 * `ctxIsArchived(chatId)` → `ctxUnarchive(chatId)` for every group message,
 * regardless of sender_type. That meant any bot heartbeat, card refresh,
 * or foreign-bot session message would silently revive an archived chat
 * and the archive button would "not stick".
 *
 * Fix: gate the unarchive call to `sender?.sender_type === 'user'`.
 *
 * This test isolates the event-dispatcher hook by mocking
 * `chat-context-store` so we can observe whether `unarchive()` was called.
 * Most other dependencies are stubbed to keep the dispatch path runnable
 * without hitting real Lark / filesystem / bot registry.
 *
 * Run:  pnpm vitest run test/event-dispatcher-auto-unarchive.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock chat-context-store (the subject under observation) ───────────────
const mockIsArchived = vi.fn<(chatId: string) => boolean>(() => true);
const mockUnarchive = vi.fn();
vi.mock('../src/services/chat-context-store.js', () => ({
  isArchived: (...args: any[]) => mockIsArchived(...(args as [string])),
  unarchive: (...args: any[]) => mockUnarchive(...args),
  // Other exports may be imported transitively; stub them too.
  read: vi.fn(() => null),
  create: vi.fn(),
  archive: vi.fn(),
  update: vi.fn(),
  upsert: vi.fn(),
  listChatIds: vi.fn(() => []),
  remove: vi.fn(() => false),
}));

// ─── Mock supporting modules so dispatch runs without side effects ─────────
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

// Bypass topology bump + digest mark — they're best-effort and unrelated.
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

// Capture handlers from EventDispatcher.register()
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
const TARGET_CHAT = 'oc_target_archived';

function setupBot() {
  mockGetBot.mockReturnValue({
    config: { larkAppId: MY_APP_ID, larkAppSecret: 'secret', cliId: 'claude-code' },
    botOpenId: MY_OPEN_ID,
    resolvedAllowedUsers: [],
  });
}

function makeEvent(opts: { senderType: 'user' | 'app' | 'bot'; senderOpenId: string; chatType?: 'group' | 'p2p' }) {
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
    sender: {
      sender_type: opts.senderType,
      sender_id: { open_id: opts.senderOpenId },
    },
  };
}

async function dispatch(event: ReturnType<typeof makeEvent>) {
  const handler = capturedHandlers['im.message.receive_v1'];
  if (!handler) throw new Error('im.message.receive_v1 handler not captured');
  await handler(event);
}

describe('auto-unarchive sender_type gate (P5 regression)', () => {
  beforeEach(() => {
    capturedHandlers = {};
    mockIsArchived.mockClear();
    mockIsArchived.mockReturnValue(true);
    mockUnarchive.mockClear();
    setupBot();
    startLarkEventDispatcher({
      handleCardAction: async () => undefined,
      handleNewTopic: async () => {},
      handleThreadReply: async () => {},
      isSessionOwner: () => false,
      onChatModeConverted: () => {},
    });
  });

  it('does NOT unarchive when sender_type is "app" (bot/card message)', async () => {
    await dispatch(makeEvent({ senderType: 'app', senderOpenId: 'ou_some_bot' }));
    expect(mockUnarchive).not.toHaveBeenCalled();
  });

  it('does NOT unarchive when sender_type is "bot" (Lark cross-bot card quirk)', async () => {
    await dispatch(makeEvent({ senderType: 'bot', senderOpenId: 'ou_some_bot' }));
    expect(mockUnarchive).not.toHaveBeenCalled();
  });

  it('DOES unarchive when sender_type is "user" (human message)', async () => {
    await dispatch(makeEvent({ senderType: 'user', senderOpenId: 'ou_human_jason' }));
    expect(mockUnarchive).toHaveBeenCalledWith(TARGET_CHAT);
  });

  it('does not call unarchive when the chat is already active (isArchived → false)', async () => {
    mockIsArchived.mockReturnValue(false);
    await dispatch(makeEvent({ senderType: 'user', senderOpenId: 'ou_human_jason' }));
    expect(mockUnarchive).not.toHaveBeenCalled();
  });

  it('does not unarchive p2p chats (only group chats enter topology)', async () => {
    await dispatch(makeEvent({ senderType: 'user', senderOpenId: 'ou_human_jason', chatType: 'p2p' }));
    expect(mockUnarchive).not.toHaveBeenCalled();
  });
});
