/**
 * Unit tests for groups-store wrappers (Lark im/v1 chat APIs).
 *
 * Run:  pnpm vitest run test/groups-store.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// chat.create is configurable per test via this stub so we can test both the
// happy path and error responses.
const chatCreateStub = vi.fn();
// chat.update mocks the owner-transfer call.
const chatUpdateStub = vi.fn();

// Mock bot-registry's getBotClient — that's where groups-store imports from.
vi.mock('../src/bot-registry.js', () => ({
  getBotClient: vi.fn().mockImplementation(() => ({
    im: {
      v1: {
        chat: {
          list: vi.fn().mockResolvedValue({
            code: 0,
            data: {
              items: [
                {
                  chat_id: 'c1',
                  name: 'one',
                  description: 'first chat',
                  chat_mode: 'group',
                  owner_id: 'ou_owner',
                },
              ],
              has_more: false,
            },
          }),
          create: chatCreateStub,
          update: chatUpdateStub,
        },
        chatMembers: {
          isInChat: vi.fn().mockResolvedValue({ code: 0, data: { is_in_chat: true } }),
          create: vi.fn().mockResolvedValue({
            code: 0,
            data: { invalid_id_list: ['cli_X'] },
          }),
        },
      },
    },
  })),
}));

import { listChats, isInChat, addBotToChat, createChat, transferChatOwner, parseInvalidUserIds232043 } from '../src/services/groups-store.js';

describe('groups-store wrappers', () => {
  beforeEach(() => { chatCreateStub.mockClear(); chatUpdateStub.mockClear(); });

  it('listChats returns ChatBrief array', async () => {
    const out = await listChats('appA');
    expect(out).toHaveLength(1);
    expect(out[0].chatId).toBe('c1');
    expect(out[0].name).toBe('one');
    expect(out[0].description).toBe('first chat');
    expect(out[0].chatMode).toBe('group');
    expect(out[0].ownerId).toBe('ou_owner');
  });

  it('isInChat returns boolean', async () => {
    expect(await isInChat('appA', 'c1')).toBe(true);
  });

  it('addBotToChat marks invalid_id_list as failed and rest as ok', async () => {
    const r = await addBotToChat('appA', 'c1', ['cli_Y', 'cli_X']);
    expect(r.find(x => x.id === 'cli_Y')!.ok).toBe(true);
    expect(r.find(x => x.id === 'cli_X')!.ok).toBe(false);
    expect(r.find(x => x.id === 'cli_X')!.error).toBe('invalid_id');
  });

  it('addBotToChat with empty list returns empty', async () => {
    expect(await addBotToChat('appA', 'c1', [])).toEqual([]);
  });

  it('createChat returns chatId and forwards bot list (excluding creator)', async () => {
    chatCreateStub.mockResolvedValueOnce({
      code: 0,
      data: { chat_id: 'oc_new123', invalid_bot_id_list: [] },
    });
    const r = await createChat('cli_creator', { name: 'team', botIds: ['cli_creator', 'cli_other'] });
    expect(r.chatId).toBe('oc_new123');
    expect(r.invalidBotIds).toEqual([]);
    // Verify bot_id_list passed only the non-creator ids.
    const callArgs = chatCreateStub.mock.calls[0][0];
    expect(callArgs.data.name).toBe('team');
    expect(callArgs.data.bot_id_list).toEqual(['cli_other']);
  });

  it('createChat omits bot_id_list when only creator is in the bot list', async () => {
    chatCreateStub.mockResolvedValueOnce({
      code: 0,
      data: { chat_id: 'oc_solo' },
    });
    await createChat('cli_creator', { botIds: ['cli_creator'] });
    const callArgs = chatCreateStub.mock.calls[0][0];
    expect(callArgs.data.bot_id_list).toBeUndefined();
    expect(callArgs.data.name).toBeUndefined();
  });

  it('createChat throws on non-zero Lark response', async () => {
    chatCreateStub.mockResolvedValueOnce({ code: 1234, msg: 'permission denied' });
    await expect(createChat('cli_creator', { botIds: ['cli_x'] })).rejects.toThrow(/permission denied/);
  });

  it('createChat surfaces invalid_bot_id_list', async () => {
    chatCreateStub.mockResolvedValueOnce({
      code: 0,
      data: { chat_id: 'oc_partial', invalid_bot_id_list: ['cli_bad'] },
    });
    const r = await createChat('cli_creator', { botIds: ['cli_creator', 'cli_good', 'cli_bad'] });
    expect(r.invalidBotIds).toEqual(['cli_bad']);
  });

  it('createChat passes userIds as user_id_list with user_id_type=open_id', async () => {
    chatCreateStub.mockResolvedValueOnce({
      code: 0,
      data: { chat_id: 'oc_with_user', invalid_bot_id_list: [], invalid_user_id_list: [] },
    });
    const r = await createChat('cli_creator', {
      botIds: ['cli_creator'],
      userIds: ['ou_human123'],
    });
    expect(r.chatId).toBe('oc_with_user');
    const callArgs = chatCreateStub.mock.calls[0][0];
    expect(callArgs.data.user_id_list).toEqual(['ou_human123']);
    expect(callArgs.params.user_id_type).toBe('open_id');
    // creator is the only bot in opts.botIds, so bot_id_list should be omitted.
    expect(callArgs.data.bot_id_list).toBeUndefined();
  });

  it('createChat surfaces invalid_user_id_list', async () => {
    chatCreateStub.mockResolvedValueOnce({
      code: 0,
      data: { chat_id: 'oc_partial_user', invalid_bot_id_list: [], invalid_user_id_list: ['ou_ghost'] },
    });
    const r = await createChat('cli_creator', {
      botIds: ['cli_creator'],
      userIds: ['ou_real', 'ou_ghost'],
    });
    expect(r.invalidUserIds).toEqual(['ou_ghost']);
  });

  it('transferChatOwner posts owner_id with user_id_type=open_id', async () => {
    chatUpdateStub.mockResolvedValueOnce({ code: 0 });
    const r = await transferChatOwner('cli_creator', 'oc_chat', 'ou_human');
    expect(r).toEqual({ ok: true });
    const call = chatUpdateStub.mock.calls[0][0];
    expect(call.path.chat_id).toBe('oc_chat');
    expect(call.params.user_id_type).toBe('open_id');
    expect(call.data.owner_id).toBe('ou_human');
  });

  it('transferChatOwner returns error on non-zero Lark response', async () => {
    chatUpdateStub.mockResolvedValueOnce({ code: 230002, msg: 'user not in chat' });
    const r = await transferChatOwner('cli_creator', 'oc_chat', 'ou_ghost');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/user not in chat/);
  });

  it('transferChatOwner catches thrown errors', async () => {
    chatUpdateStub.mockRejectedValueOnce(new Error('network down'));
    const r = await transferChatOwner('cli_creator', 'oc_chat', 'ou_x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/network down/);
  });

  it('createChat omits user_id_list and user_id_type when no userIds provided', async () => {
    chatCreateStub.mockResolvedValueOnce({
      code: 0,
      data: { chat_id: 'oc_no_user' },
    });
    await createChat('cli_creator', { botIds: ['cli_creator', 'cli_other'] });
    const callArgs = chatCreateStub.mock.calls[0][0];
    expect(callArgs.data.user_id_list).toBeUndefined();
    expect(callArgs.params?.user_id_type).toBeUndefined();
  });

  // ── 飞书 232043：bot 的 open_id 被误塞进 user_id_list → 剔除后重试一次（含 bot 成员的群也能建子群）──
  it('createChat 232043: drops the bot open_id from user_id_list and retries (含 bot 群可建)', async () => {
    const err: any = new Error('Request failed with status code 400');
    err.response = { data: { code: 232043, msg: 'Your request contains unavailable ids, ext=invalid user ids: [ou_bot]' } };
    chatCreateStub
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ code: 0, data: { chat_id: 'oc_retry_ok', invalid_bot_id_list: [], invalid_user_id_list: [] } });
    const r = await createChat('cli_creator', { botIds: ['cli_creator', 'cli_bot'], userIds: ['ou_human', 'ou_bot'] });
    expect(r.chatId).toBe('oc_retry_ok');
    expect(chatCreateStub).toHaveBeenCalledTimes(2);
    // 第二次（重试）请求里 ou_bot 已被剔除，只剩真人
    const retryArgs = chatCreateStub.mock.calls[1][0];
    expect(retryArgs.data.user_id_list).toEqual(['ou_human']);
    // B1（蔻黛复审）：被剔除的 ou_bot 必须回传到 invalidUserIds，上层才不会误判它已入群
    expect(r.invalidUserIds).toContain('ou_bot');
  });

  it('createChat 232043: dropped id 与飞书第二次响应的 invalid_user_id_list 合并去重回传', async () => {
    const err: any = new Error('Request failed with status code 400');
    err.response = { data: { code: 232043, msg: 'invalid user ids: [ou_bot]' } };
    chatCreateStub
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ code: 0, data: { chat_id: 'oc_ok2', invalid_bot_id_list: [], invalid_user_id_list: ['ou_ghost'] } });
    const r = await createChat('cli_creator', { botIds: ['cli_creator'], userIds: ['ou_human', 'ou_bot', 'ou_ghost'] });
    expect(new Set(r.invalidUserIds)).toEqual(new Set(['ou_bot', 'ou_ghost']));
  });

  it('createChat 232043: 若非法 id 不在 userIds（无可剔除）→ 原样抛出，不无限重试', async () => {
    const err: any = new Error('Request failed with status code 400');
    err.response = { data: { code: 232043, msg: 'invalid user ids: [ou_unrelated]' } };
    chatCreateStub.mockRejectedValueOnce(err);
    await expect(
      createChat('cli_creator', { botIds: ['cli_creator'], userIds: ['ou_human'] }),
    ).rejects.toThrow(/status code 400/);
    expect(chatCreateStub).toHaveBeenCalledTimes(1); // 没有可剔除项 → 不重试
  });

  it('createChat 非 232043 的错误原样抛出（不吞）', async () => {
    chatCreateStub.mockRejectedValueOnce(new Error('network down'));
    await expect(
      createChat('cli_creator', { botIds: ['cli_creator'], userIds: ['ou_human'] }),
    ).rejects.toThrow(/network down/);
    expect(chatCreateStub).toHaveBeenCalledTimes(1);
  });

  it('parseInvalidUserIds232043 提取被点名的非法 id（多种形态）', () => {
    const e1: any = new Error('x'); e1.response = { data: { code: 232043, msg: 'invalid user ids: [ou_a, ou_b]' } };
    expect(parseInvalidUserIds232043(e1)).toEqual(['ou_a', 'ou_b']);
    // code 在 message 文本里
    expect(parseInvalidUserIds232043(new Error('(code: 232043) invalid user ids: [ou_x]'))).toEqual(['ou_x']);
    // 非 232043 → 空
    expect(parseInvalidUserIds232043(new Error('some other error'))).toEqual([]);
    // 收紧后：仅有 "invalid user ids" 文案但无 232043（code 也不是）→ 不当可剔除项
    const eNo: any = new Error('invalid user ids: [ou_z]'); eNo.response = { data: { code: 999, msg: 'invalid user ids: [ou_z]' } };
    expect(parseInvalidUserIds232043(eNo)).toEqual([]);
  });
});
