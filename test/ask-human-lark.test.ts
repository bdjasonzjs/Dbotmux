import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AskHumanTransportReceipts, askHumanLarkMessage, createAskHumanLarkTransport, type AskHumanLarkApi } from '../src/core/ask-human-lark.js';
import { AskHumanReplyNotSent } from '../src/core/ask-human-reply.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'human-lark-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const raw = (text: string) => ({ message_id: 'om_test', chat_id: 'oc_test', create_time: '1700000000000', deleted: false, msg_type: 'text', sender: { id: 'ou_human', id_type: 'open_id', sender_type: 'user' }, body: { content: JSON.stringify({ text }) } });
function setup() {
  let users: string[] = [];
  const api: AskHumanLarkApi = {
    create: vi.fn(async () => ({ code: 0, data: { chat_id: 'oc_room' } })),
    invite: vi.fn(async () => { users = ['ou_human']; return { code: 0, data: {} }; }),
    get: vi.fn(async path => ({ code: 0, data: path.endsWith('/members') ? { items: users.map(member_id => ({ member_id })), has_more: false } : { name: '汇报·报名开放时间', chat_type: 'private', chat_mode: 'group', external: false } })),
    sendText: vi.fn(async () => 'om_sent'), detail: vi.fn(async () => ({ items: [raw('正文')] })),
    bots: vi.fn(async () => [{ openId: 'ou_bot_member' }]),
  };
  const assertWrite = vi.fn();
  const receipts = new AskHumanTransportReceipts(root);
  const ports = createAskHumanLarkTransport({ appId: 'cli_app', botSenderId: 'cli_app', botMemberOpenId: 'ou_bot_member', api, receipts, assertWrite });
  return { api, assertWrite, ports, receipts };
}

describe('real Lark wire adapter contract (synthetic API responses, no network)', () => {
  it('preserves human whitespace, mentions, entities and line endings verbatim', () => {
    const body = '  A\r\n<at user_id="x">x</at> &amp;  代价\n';
    expect(askHumanLarkMessage(raw(body), 'cli_app').body).toBe(body);
  });
  it('maps app sender and normalizes only verified transport mention prefix', () => {
    const m = { ...raw('@_user_1 \r\n正文  保留\n'), sender: { id: 'cli_app', sender_type: 'app', id_type: 'app_id' }, mentions: [{ key: '@_user_1', id: 'ou_human', id_type: 'open_id' }] };
    expect(askHumanLarkMessage(m, 'cli_app')).toMatchObject({ senderType: 'bot', senderId: 'cli_app', body: '正文  保留' });
  });
  it.each(['user_id', undefined])('rejects unproven human identity %s', id_type => {
    expect(() => askHumanLarkMessage({ ...raw('A'), sender: { ...raw('A').sender, id_type } }, 'cli_app')).toThrow();
  });
  it('does not silently flatten an unsupported human post', () => {
    expect(() => askHumanLarkMessage({ ...raw('A'), msg_type: 'post' }, 'cli_app')).toThrow(/待处理/);
  });
  it('creates only bot-only private chat with exact UUID and reviewed name', async () => {
    const t = setup(), input = { appId: 'cli_app', name: '汇报·报名开放时间', uuid: 'create-key' };
    expect(await t.ports.createBotOnlyRoom(input)).toBe('oc_room');
    expect(await t.ports.createBotOnlyRoom(input)).toBe('oc_room');
    expect(t.api.create).toHaveBeenCalledTimes(1);
    expect(t.api.create).toHaveBeenCalledWith({ params: { uuid: 'create-key', user_id_type: 'open_id' }, data: expect.objectContaining({ name: input.name, chat_mode: 'group', chat_type: 'private', external: false }) });
    const req = vi.mocked(t.api.create).mock.calls[0][0];
    expect(req?.data).not.toHaveProperty('user_id_list'); expect(req?.data).not.toHaveProperty('bot_id_list');
  });
  it('checks scoped readiness before provider writes, even for repeated requests', async () => {
    const t = setup(); t.assertWrite.mockImplementation(() => { throw Error('disabled'); });
    await expect(t.ports.createBotOnlyRoom({ appId: 'cli_app', uuid: 'k', name: '汇报·报名开放时间' })).rejects.toThrow('disabled');
    await expect(t.ports.send({ appId: 'cli_app', uuid: 'k', chatId: 'oc_room', body: '正文', mentions: [] })).rejects.toThrow('disabled');
    expect(t.api.create).not.toHaveBeenCalled(); expect(t.api.sendText).not.toHaveBeenCalled();
  });
  it('reuses original send acceptance after adapter recreation', async () => {
    const t = setup(), input = { appId: 'cli_app', chatId: 'oc_room', uuid: 'k', body: '风险：永久丢失', mentions: ['ou_human'] };
    await t.ports.send(input);
    const t2 = setup(); expect(await t2.ports.send(input)).toEqual({ messageId: 'om_sent' });
    expect(t2.api.sendText).not.toHaveBeenCalled();
    expect(await t2.ports.lookupSend({ appId: 'cli_app', chatId: 'oc_room', uuid: 'k', attemptId: 'a' })).toEqual({ status: 'FOUND', messageId: 'om_sent' });
  });
  it('unknown provider result never becomes NOT_SENT or a blind retry', async () => {
    const t = setup(), input = { appId: 'cli_app', chatId: 'oc_room', uuid: 'k', body: '风险', mentions: [] };
    vi.mocked(t.api.sendText).mockRejectedValueOnce(Error('timeout after acceptance'));
    await expect(t.ports.send(input)).rejects.toThrow('timeout');
    await expect(t.ports.send(input)).rejects.toThrow(/未知/);
    expect(t.api.sendText).toHaveBeenCalledTimes(1);
    expect(await t.ports.lookupSend({ ...input, attemptId: 'a' })).toEqual({ status: 'UNKNOWN' });
  });
  it('persists a pre-send refusal separately and allows an explicit same-payload retry after recreation', async () => {
    const t = setup(), input = { appId: 'cli_app', chatId: 'oc_room', uuid: 'reply-key', body: '原话', mentions: ['ou_bot_member'], replyAsUser: true, userOpenId: 'ou_human' };
    t.api.sendReply = vi.fn(async () => { throw new AskHumanReplyNotSent(); });
    await expect(t.ports.send(input)).rejects.toMatchObject({ code: 'REPLY_NOT_SENT' });
    const t2 = setup();
    expect(await t2.ports.lookupSend({ ...input, attemptId: 'a' })).toMatchObject({ status: 'NOT_SENT', receiptId: expect.stringMatching(/^pre-send:/) });
    await expect(t2.ports.send({ ...input, body: 'changed' })).rejects.toThrow(/不允许/);
    t2.api.sendReply = vi.fn(async () => ({ messageId: 'om_reply', sender: { type: 'user', id: 'ou_human' } }));
    await expect(t2.ports.send(input)).resolves.toMatchObject({ messageId: 'om_reply' });
    expect(t2.api.sendReply).toHaveBeenCalledTimes(1);
    expect(await t2.ports.lookupSend({ ...input, attemptId: 'b' })).toMatchObject({ status: 'FOUND', messageId: 'om_reply' });
  });
  it('same UUID cannot replace the critical risk', async () => {
    const t = setup(), input = { appId: 'cli_app', chatId: 'oc_room', uuid: 'k', body: '永久丢失', mentions: [] };
    await t.ports.send(input);
    await expect(t.ports.send({ ...input, body: '没有风险' })).rejects.toThrow(/不允许/);
    expect(t.api.sendText).toHaveBeenCalledTimes(1);
  });
  it('foreign app cannot send or query another app receipt', async () => {
    const t = setup();
    await expect(t.ports.send({ appId: 'foreign', chatId: 'oc_room', uuid: 'k', body: '正文', mentions: [] })).rejects.toThrow(/跨 app/);
    await expect(t.ports.lookupSend({ appId: 'foreign', chatId: 'oc_room', uuid: 'k', attemptId: 'a' })).rejects.toThrow(/跨 app/);
    expect(t.api.sendText).not.toHaveBeenCalled();
  });
  it('invitation reads actual membership and is idempotent', async () => {
    const t = setup();
    await t.ports.inviteHuman({ appId: 'cli_app', roomId: 'oc_room', openId: 'ou_human' });
    await t.ports.inviteHuman({ appId: 'cli_app', roomId: 'oc_room', openId: 'ou_human' });
    expect(t.api.invite).toHaveBeenCalledTimes(1);
    expect((await t.ports.readRoom('oc_room')).memberIds).toEqual(['ou_human', 'cli_app']);
  });
  it('rejects a successful invite response without actual membership', async () => {
    const t = setup(); vi.mocked(t.api.invite).mockResolvedValue({ code: 0, data: {} });
    await expect(t.ports.inviteHuman({ appId: 'cli_app', roomId: 'oc_room', openId: 'ou_human' })).rejects.toThrow(/未确认/);
  });
  it('incomplete member pagination is not an empty isolated room', async () => {
    const t = setup(), get = t.api.get;
    t.api.get = async (path, p) => path.endsWith('/members') ? { code: 0, data: { items: [], has_more: true } } : get(path, p);
    await expect(t.ports.readRoom('oc_room')).rejects.toThrow(/分页/);
  });
  it('foreign bot or unknown bot membership fails closed', async () => {
    const t = setup(); vi.mocked(t.api.bots).mockResolvedValue([{ openId: 'foreign' }]);
    await expect(t.ports.readRoom('oc_room')).rejects.toThrow(/运行 bot/);
  });
  it('requires exact message ID from detail, not first history result', async () => {
    const t = setup();
    await expect(t.ports.readMessage('om_wrong')).rejects.toThrow(/另一条/);
    expect((await t.ports.readMessage('om_test')).body).toBe('正文');
  });
  it('persists reply sender together with the message ID and reuses it across transport recreation', async () => {
    const t = setup(), input = { appId: 'cli_app', chatId: 'oc_source', uuid: 'reply', body: '原问题\n原话', mentions: ['ou_bot_member'], replyAsUser: true, userOpenId: 'ou_human' };
    const receipt = { messageId: 'om_reply', sender: { type: 'user' as const, id: 'ou_human' } };
    t.api.sendReply = vi.fn(async () => receipt);
    expect(await t.ports.send(input)).toEqual(receipt);
    expect(t.api.sendText).not.toHaveBeenCalled();
    const next = setup();
    expect(await next.ports.send(input)).toEqual(receipt);
    expect(await next.ports.lookupSend({ ...input, attemptId: 'a' })).toEqual({ status: 'FOUND', ...receipt });
    expect(t.api.sendReply).toHaveBeenCalledTimes(1);
  });
});
