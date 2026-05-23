/**
 * Unit tests for the P0/4 main-bot mode hook in group-creator.ts.
 * Verifies that createGroupWithBots() calls dispatchChatCreated() with the
 * right args after createChat() succeeds.
 *
 * Run:  pnpm vitest run test/group-creator-main-bot.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const createChatMock = vi.fn();
const transferChatOwnerMock = vi.fn();
const getChatOwnerMock = vi.fn();
vi.mock('../src/services/groups-store.js', () => ({
  createChat: createChatMock,
  transferChatOwner: transferChatOwnerMock,
  getChatOwner: getChatOwnerMock,
}));

const sendMessageMock = vi.fn();
vi.mock('../src/im/lark/client.js', () => ({
  sendMessage: sendMessageMock,
}));

const bindOncallMock = vi.fn();
vi.mock('../src/services/oncall-store.js', () => ({
  bindOncall: bindOncallMock,
}));

const dispatchChatCreatedMock = vi.fn();
vi.mock('../src/im/lark/chat-created-handler.js', () => ({
  dispatchChatCreated: dispatchChatCreatedMock,
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

async function freshImport() {
  vi.resetModules();
  return await import('../src/services/group-creator.js');
}

beforeEach(() => {
  createChatMock.mockReset();
  transferChatOwnerMock.mockReset();
  getChatOwnerMock.mockReset();
  sendMessageMock.mockReset();
  bindOncallMock.mockReset();
  dispatchChatCreatedMock.mockReset();
  dispatchChatCreatedMock.mockResolvedValue(undefined);

  // Default: createChat succeeds, no transfer, no notify, no bind.
  createChatMock.mockResolvedValue({
    chatId: 'oc_new_chat',
    invalidBotIds: [],
    invalidUserIds: [],
  });
});

describe('createGroupWithBots — P0/4 main-bot dispatch', () => {
  it('calls dispatchChatCreated after createChat succeeds (defaults)', async () => {
    const { createGroupWithBots } = await freshImport();
    await createGroupWithBots({
      creatorLarkAppId: 'app_creator',
      larkAppIds: [],
    });

    expect(dispatchChatCreatedMock).toHaveBeenCalledTimes(1);
    const call = dispatchChatCreatedMock.mock.calls[0][0];
    expect(call.chatId).toBe('oc_new_chat');
    expect(call.larkAppId).toBe('app_creator');
    expect(call.originType).toBe('bot_spawned');
    expect(call.parentChatId).toBeNull();  // default when sourceChatId omitted
    expect(call.purpose).toBeUndefined();  // let dispatch apply placeholder
  });

  it('passes sourceChatId as parentChatId when provided', async () => {
    const { createGroupWithBots } = await freshImport();
    await createGroupWithBots({
      creatorLarkAppId: 'app_creator',
      larkAppIds: [],
      sourceChatId: 'oc_parent',
      purpose: 'discuss X 议题',
    });

    const call = dispatchChatCreatedMock.mock.calls[0][0];
    expect(call.parentChatId).toBe('oc_parent');
    expect(call.purpose).toBe('discuss X 议题');
  });

  it('group creation still returns success even if dispatchChatCreated throws', async () => {
    dispatchChatCreatedMock.mockRejectedValue(new Error('disk full'));
    const { createGroupWithBots } = await freshImport();
    const result = await createGroupWithBots({
      creatorLarkAppId: 'app_creator',
      larkAppIds: [],
    });

    expect(result.ok).toBe(true);
    expect(result.chatId).toBe('oc_new_chat');
  });

  it('does not call dispatchChatCreated when createChat throws (chat never created)', async () => {
    createChatMock.mockRejectedValue(new Error('lark 403'));
    const { createGroupWithBots } = await freshImport();
    await expect(createGroupWithBots({
      creatorLarkAppId: 'app_creator',
      larkAppIds: [],
    })).rejects.toThrow('lark 403');
    expect(dispatchChatCreatedMock).not.toHaveBeenCalled();
  });

  it('runs after createChat / transfer / notify but does not block on them', async () => {
    // Verify ordering: dispatchChatCreated happens after createChat result is known.
    const callOrder: string[] = [];
    createChatMock.mockImplementation(async () => {
      callOrder.push('createChat');
      return { chatId: 'oc_x', invalidBotIds: [], invalidUserIds: [] };
    });
    dispatchChatCreatedMock.mockImplementation(async () => {
      callOrder.push('dispatchChatCreated');
    });
    const { createGroupWithBots } = await freshImport();
    await createGroupWithBots({ creatorLarkAppId: 'app_a', larkAppIds: [] });
    expect(callOrder).toEqual(['createChat', 'dispatchChatCreated']);
  });
});
