/**
 * Unit tests for chat-created-handler: inferOriginType + handleChatCreated.
 *
 * Run:  pnpm vitest run test/chat-created-handler.test.ts
 *
 * Strategy: mock bot-registry to control "which open_ids count as our bots",
 * and mock chat-context-store.create to assert the right ChatContext gets
 * written without touching disk.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockBotState = (botOpenId: string | undefined) => ({
  botOpenId,
  larkAppId: 'app_test',
});

// Hoisted via vi.mock so the chat-context-store import in the SUT picks up
// our spy.
const createSpy = vi.fn();
vi.mock('../src/services/chat-context-store.js', () => ({
  create: createSpy,
  read: vi.fn(),  // for the transitive chat-context-card import
}));

// Mock the card sender so handleChatCreated doesn't try to touch Lark or
// re-import chat-context-store (we just verify it gets called).
const sendContextCardSpy = vi.fn().mockResolvedValue(null);
vi.mock('../src/im/lark/chat-context-card.js', () => ({
  sendContextCard: sendContextCardSpy,
}));

// Mock bot-registry.
const getBotMock = vi.fn();
const getAllBotsMock = vi.fn();
vi.mock('../src/bot-registry.js', () => ({
  getBot: (...args: any[]) => getBotMock(...args),
  getAllBots: (...args: any[]) => getAllBotsMock(...args),
}));

// Silence logger.
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

async function freshImport() {
  vi.resetModules();
  // Re-register hoisted mocks per fresh module (resetModules() doesn't unhook them).
  return await import('../src/im/lark/chat-created-handler.js');
}

beforeEach(() => {
  createSpy.mockReset();
  getBotMock.mockReset();
  getAllBotsMock.mockReset();
  sendContextCardSpy.mockReset();
  sendContextCardSpy.mockResolvedValue(null);
  // Default: no bots registered → human_created
  getBotMock.mockImplementation(() => mockBotState(undefined));
  getAllBotsMock.mockReturnValue([]);
});

describe('inferOriginType', () => {
  it('returns p2p for chat_mode=p2p regardless of operator', async () => {
    const { inferOriginType } = await freshImport();
    expect(inferOriginType({ chat_id: 'oc_p', chat_mode: 'p2p' }, 'app_test')).toBe('p2p');
    expect(inferOriginType({ chat_id: 'oc_p', chat_mode: 'p2p', operator: { operator_type: 'app' } }, 'app_test')).toBe('p2p');
  });

  it('returns bot_spawned when operator_type=app', async () => {
    const { inferOriginType } = await freshImport();
    expect(inferOriginType({ chat_id: 'oc_b', chat_mode: 'group', operator: { operator_type: 'app' } }, 'app_test')).toBe('bot_spawned');
  });

  it('returns bot_spawned when operator_type=bot', async () => {
    const { inferOriginType } = await freshImport();
    expect(inferOriginType({ chat_id: 'oc_b', chat_mode: 'group', operator: { operator_type: 'bot' } }, 'app_test')).toBe('bot_spawned');
  });

  it('returns human_created when operator_type=user and open_id not registered', async () => {
    const { inferOriginType } = await freshImport();
    expect(inferOriginType({ chat_id: 'oc_h', chat_mode: 'group', operator: { operator_type: 'user', open_id: 'ou_human' } }, 'app_test')).toBe('human_created');
  });

  it('returns bot_spawned when operator matches same-app bot (even if type=user)', async () => {
    getBotMock.mockReturnValue(mockBotState('ou_my_bot'));
    const { inferOriginType } = await freshImport();
    expect(inferOriginType({ chat_id: 'oc', chat_mode: 'group', operator: { operator_type: 'user', open_id: 'ou_my_bot' } }, 'app_test')).toBe('bot_spawned');
  });

  it('returns bot_spawned when operator matches a sibling bot (cross-app)', async () => {
    getAllBotsMock.mockReturnValue([{ botOpenId: 'ou_sibling' }, { botOpenId: 'ou_other' }]);
    const { inferOriginType } = await freshImport();
    expect(inferOriginType({ chat_id: 'oc', chat_mode: 'group', operator: { operator_type: 'user', open_id: 'ou_sibling' } }, 'app_test')).toBe('bot_spawned');
  });

  it('returns human_created when no operator info', async () => {
    const { inferOriginType } = await freshImport();
    expect(inferOriginType({ chat_id: 'oc_x', chat_mode: 'group' }, 'app_test')).toBe('human_created');
  });

  it('survives getBot throwing (larkAppId not registered)', async () => {
    getBotMock.mockImplementation(() => { throw new Error('not registered'); });
    const { inferOriginType } = await freshImport();
    expect(inferOriginType({ chat_id: 'oc', chat_mode: 'group', operator: { operator_type: 'user', open_id: 'ou_x' } }, 'app_test')).toBe('human_created');
  });
});

describe('handleChatCreated', () => {
  it('writes ChatContext via store.create with inferred originType', async () => {
    const { handleChatCreated } = await freshImport();
    await handleChatCreated(
      { chat_id: 'oc_new', chat_mode: 'group', operator: { operator_type: 'app' } },
      'app_test',
    );
    expect(createSpy).toHaveBeenCalledTimes(1);
    const [chatId, opts] = createSpy.mock.calls[0];
    expect(chatId).toBe('oc_new');
    expect(opts.originType).toBe('bot_spawned');
    expect(opts.parentChatId).toBeNull();  // P0/2: always null from event path
    expect(opts.purpose).toBe('（待 main-bot 自动推断）');  // default placeholder
    expect(opts.participants).toEqual([]);
  });

  it('respects opts.parentChatId from manual trigger', async () => {
    const { handleChatCreated } = await freshImport();
    await handleChatCreated(
      { chat_id: 'oc_new', chat_mode: 'group', operator: { operator_type: 'app' } },
      'app_test',
      { parentChatId: 'oc_parent', purpose: 'discuss X' },
    );
    const [, opts] = createSpy.mock.calls[0];
    expect(opts.parentChatId).toBe('oc_parent');
    expect(opts.purpose).toBe('discuss X');
  });

  it('skips and warns when event has no chat_id', async () => {
    const { handleChatCreated } = await freshImport();
    await handleChatCreated({ chat_id: '' } as any, 'app_test');
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('writes ChatContext for human_created chats too (sidebar data)', async () => {
    const { handleChatCreated } = await freshImport();
    await handleChatCreated(
      { chat_id: 'oc_human', chat_mode: 'group', operator: { operator_type: 'user', open_id: 'ou_real_human' } },
      'app_test',
    );
    const [, opts] = createSpy.mock.calls[0];
    expect(opts.originType).toBe('human_created');
  });

  it('writes ChatContext for p2p chats too', async () => {
    const { handleChatCreated } = await freshImport();
    await handleChatCreated({ chat_id: 'oc_p2p', chat_mode: 'p2p' }, 'app_test');
    const [, opts] = createSpy.mock.calls[0];
    expect(opts.originType).toBe('p2p');
  });

  it('dispatches the welcome card via sendContextCard (P0/3)', async () => {
    const { handleChatCreated } = await freshImport();
    await handleChatCreated(
      { chat_id: 'oc_card_test', chat_mode: 'group', operator: { operator_type: 'app' } },
      'app_test',
    );
    expect(sendContextCardSpy).toHaveBeenCalledTimes(1);
    expect(sendContextCardSpy).toHaveBeenCalledWith('app_test', 'oc_card_test');
  });

  it('completes even when sendContextCard returns null (card delivery failed)', async () => {
    sendContextCardSpy.mockResolvedValue(null);  // simulates skip / send failure
    const { handleChatCreated } = await freshImport();
    await handleChatCreated(
      { chat_id: 'oc_no_card', chat_mode: 'group', operator: { operator_type: 'app' } },
      'app_test',
    );
    // ChatContext still written even if card couldn't go out — this is the
    // best-effort contract.
    expect(createSpy).toHaveBeenCalledTimes(1);
  });
});
