/**
 * Unit tests for chat-created-handler: inferOriginType + handleChatMemberBotAdded
 * + dispatchChatCreated (first-dispatch-only card behavior).
 *
 * Run:  pnpm vitest run test/chat-created-handler.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockBotState = (botOpenId: string | undefined) => ({
  botOpenId,
  larkAppId: 'app_test',
});

// chat-context-store mocks — create() is the actual write, read() is used
// for first-dispatch detection.
const createSpy = vi.fn();
const readSpy = vi.fn();
vi.mock('../src/services/chat-context-store.js', () => ({
  create: createSpy,
  read: readSpy,
}));

// chat-context-card mock — we just verify it was called (or not) with the
// right args.
const sendContextCardSpy = vi.fn().mockResolvedValue(null);
vi.mock('../src/im/lark/chat-context-card.js', () => ({
  sendContextCard: sendContextCardSpy,
}));

// bot-registry mocks.
const getBotMock = vi.fn();
const getAllBotsMock = vi.fn();
vi.mock('../src/bot-registry.js', () => ({
  getBot: (...args: any[]) => getBotMock(...args),
  getAllBots: (...args: any[]) => getAllBotsMock(...args),
}));

// Silence logger.
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

async function freshImport() {
  vi.resetModules();
  return await import('../src/im/lark/chat-created-handler.js');
}

beforeEach(() => {
  createSpy.mockReset();
  readSpy.mockReset();
  readSpy.mockReturnValue(null);  // default: no existing ChatContext → first dispatch
  getBotMock.mockReset();
  getAllBotsMock.mockReset();
  sendContextCardSpy.mockReset();
  sendContextCardSpy.mockResolvedValue(null);
  // Default: no bots registered → human_created
  getBotMock.mockImplementation(() => mockBotState(undefined));
  getAllBotsMock.mockReturnValue([]);
});

describe('inferOriginType', () => {
  it('returns human_created when operator_id missing', async () => {
    const { inferOriginType } = await freshImport();
    expect(inferOriginType({ chat_id: 'oc' }, 'app_test')).toBe('human_created');
  });

  it('returns human_created when operator open_id absent', async () => {
    const { inferOriginType } = await freshImport();
    expect(inferOriginType({ chat_id: 'oc', operator_id: {} }, 'app_test')).toBe('human_created');
  });

  it('returns bot_spawned when operator matches same-app bot', async () => {
    getBotMock.mockReturnValue(mockBotState('ou_my_bot'));
    const { inferOriginType } = await freshImport();
    expect(inferOriginType(
      { chat_id: 'oc', operator_id: { open_id: 'ou_my_bot' } },
      'app_test',
    )).toBe('bot_spawned');
  });

  it('returns bot_spawned when operator matches a sibling bot (cross-app)', async () => {
    getAllBotsMock.mockReturnValue([{ botOpenId: 'ou_sibling' }, { botOpenId: 'ou_other' }]);
    const { inferOriginType } = await freshImport();
    expect(inferOriginType(
      { chat_id: 'oc', operator_id: { open_id: 'ou_sibling' } },
      'app_test',
    )).toBe('bot_spawned');
  });

  it('returns human_created when operator open_id not in any registry', async () => {
    const { inferOriginType } = await freshImport();
    expect(inferOriginType(
      { chat_id: 'oc', operator_id: { open_id: 'ou_real_human' } },
      'app_test',
    )).toBe('human_created');
  });

  it('survives getBot throwing (larkAppId not registered)', async () => {
    getBotMock.mockImplementation(() => { throw new Error('not registered'); });
    getAllBotsMock.mockReturnValue([]);
    const { inferOriginType } = await freshImport();
    expect(inferOriginType(
      { chat_id: 'oc', operator_id: { open_id: 'ou_x' } },
      'app_test',
    )).toBe('human_created');
  });
});

describe('handleChatMemberBotAdded', () => {
  it('writes ChatContext via store.create with inferred originType (bot_spawned)', async () => {
    getBotMock.mockReturnValue(mockBotState('ou_my_bot'));
    const { handleChatMemberBotAdded } = await freshImport();
    await handleChatMemberBotAdded(
      { chat_id: 'oc_new', operator_id: { open_id: 'ou_my_bot' } },
      'app_test',
    );
    expect(createSpy).toHaveBeenCalledTimes(1);
    const [chatId, opts] = createSpy.mock.calls[0];
    expect(chatId).toBe('oc_new');
    expect(opts.originType).toBe('bot_spawned');
    expect(opts.parentChatId).toBeNull();
    expect(opts.purpose).toBe('（待 main-bot 自动推断）');
    expect(opts.participants).toEqual([]);
  });

  it('writes ChatContext with human_created when operator is a real user', async () => {
    const { handleChatMemberBotAdded } = await freshImport();
    await handleChatMemberBotAdded(
      { chat_id: 'oc_h', operator_id: { open_id: 'ou_real_human' } },
      'app_test',
    );
    const [, opts] = createSpy.mock.calls[0];
    expect(opts.originType).toBe('human_created');
  });

  it('respects opts.parentChatId from manual trigger', async () => {
    const { handleChatMemberBotAdded } = await freshImport();
    await handleChatMemberBotAdded(
      { chat_id: 'oc_new', operator_id: { open_id: 'ou_human' } },
      'app_test',
      { parentChatId: 'oc_parent', purpose: 'discuss X' },
    );
    const [, opts] = createSpy.mock.calls[0];
    expect(opts.parentChatId).toBe('oc_parent');
    expect(opts.purpose).toBe('discuss X');
  });

  it('skips and warns when event has no chat_id', async () => {
    const { handleChatMemberBotAdded } = await freshImport();
    await handleChatMemberBotAdded({ chat_id: '' } as any, 'app_test');
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('dispatches the welcome card via sendContextCard on first dispatch', async () => {
    readSpy.mockReturnValue(null);  // first dispatch
    const { handleChatMemberBotAdded } = await freshImport();
    await handleChatMemberBotAdded(
      { chat_id: 'oc_first', operator_id: { open_id: 'ou_h' } },
      'app_test',
    );
    expect(sendContextCardSpy).toHaveBeenCalledTimes(1);
    expect(sendContextCardSpy).toHaveBeenCalledWith('app_test', 'oc_first');
  });

  it('does NOT re-send card when ChatContext already exists (bot re-entering)', async () => {
    readSpy.mockReturnValue({ chatId: 'oc_existing', purpose: 'p', originType: 'bot_spawned' });
    const { handleChatMemberBotAdded } = await freshImport();
    await handleChatMemberBotAdded(
      { chat_id: 'oc_existing', operator_id: { open_id: 'ou_h' } },
      'app_test',
    );
    expect(createSpy).toHaveBeenCalledTimes(1);  // still calls create (idempotent)
    expect(sendContextCardSpy).not.toHaveBeenCalled();  // but no card spam
  });
});

describe('dispatchChatCreated', () => {
  it('sends card on first dispatch (read returns null)', async () => {
    readSpy.mockReturnValue(null);
    const { dispatchChatCreated } = await freshImport();
    await dispatchChatCreated({
      chatId: 'oc_d',
      larkAppId: 'app_a',
      originType: 'bot_spawned',
    });
    expect(sendContextCardSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT send card when ChatContext already exists', async () => {
    readSpy.mockReturnValue({ chatId: 'oc_d', purpose: 'p', originType: 'bot_spawned' });
    const { dispatchChatCreated } = await freshImport();
    await dispatchChatCreated({
      chatId: 'oc_d',
      larkAppId: 'app_a',
      originType: 'bot_spawned',
    });
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(sendContextCardSpy).not.toHaveBeenCalled();
  });

  it('writes ChatContext with bot_spawned (manual trigger from group-creator)', async () => {
    const { dispatchChatCreated } = await freshImport();
    await dispatchChatCreated({
      chatId: 'oc_g',
      larkAppId: 'app_a',
      originType: 'bot_spawned',
      parentChatId: 'oc_p',
      purpose: 'cli created',
    });
    const [, opts] = createSpy.mock.calls[0];
    expect(opts.originType).toBe('bot_spawned');
    expect(opts.parentChatId).toBe('oc_p');
    expect(opts.purpose).toBe('cli created');
  });

  it('skips dispatch when chatId is empty', async () => {
    const { dispatchChatCreated } = await freshImport();
    await dispatchChatCreated({ chatId: '', larkAppId: 'app_a', originType: 'p2p' });
    expect(createSpy).not.toHaveBeenCalled();
    expect(sendContextCardSpy).not.toHaveBeenCalled();
  });
});
