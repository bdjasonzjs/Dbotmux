/** Explicit, inert-until-called Lark adapter. Uses the existing bot SDK/client;
 * never a user token, shim override, history search, worker or scheduler.
 * The daemon must install purpose guards BEFORE granting write readiness.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Client } from '@larksuiteoapi/node-sdk';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { askHumanHash, AskHumanPreflightError } from './ask-human-preflight.js';
import { askHumanContentText, askHumanTextWire, type AskHumanWireContent } from './ask-human-message.js';
import type { AskHumanReadMessage } from './ask-human-ledger.js';
import type { AskHumanExecutorPorts } from './ask-human-executor.js';

type Transport = Pick<AskHumanExecutorPorts, 'createBotOnlyRoom' | 'readRoom' | 'inviteHuman' | 'send' | 'readMessage' | 'lookupSend'>;
const nonempty = z.string().min(1);
const receiptSchema = z.object({ key: nonempty, fingerprint: nonempty, result: nonempty.optional() }).strict();
function fail(code: string, message: string): never { throw new AskHumanPreflightError(code, message); }

/** Small provider receipt index, NOT a second queue. The ledger still owns all
 * state/attempts. An in-flight provider call is never retried by this index.
 * Crash after provider acceptance and before persistence remains UNKNOWN.
 */
export class AskHumanTransportReceipts {
  constructor(private readonly root: string) { mkdirSync(root, { recursive: true, mode: 0o700 }); }
  private path(key: string): string { return join(this.root, `${askHumanHash(key)}.json`); }
  private read(key: string): z.infer<typeof receiptSchema> | undefined {
    try {
      const r = receiptSchema.parse(JSON.parse(readFileSync(this.path(key), 'utf8')));
      if (r.key !== key) return fail('STORE_UNREADABLE', '传输回执身份不符');
      return r;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  }
  lookup(key: string): string | undefined { return this.read(key)?.result; }
  async once(key: string, payload: unknown, effect: () => Promise<string>): Promise<string> {
    const fingerprint = askHumanHash(JSON.stringify(payload));
    const existing = withFileLockSync(this.path(key), () => {
      const old = this.read(key);
      if (old) {
        if (old.fingerprint !== fingerprint) return fail('TRANSPORT_CONFLICT', '原 UUID 不允许换正文、群或身份');
        if (!old.result) return fail('TRANSPORT_UNCERTAIN', '原传输结果未知，禁止重发或重建');
        return old.result;
      }
      atomicWriteFileSync(this.path(key), JSON.stringify({ key, fingerprint }), { durable: true, mode: 0o600, followTargetSymlink: false });
      return undefined;
    });
    if (existing) return existing;
    const result = await effect();
    nonempty.parse(result);
    withFileLockSync(this.path(key), () => {
      const r = this.read(key);
      if (!r || r.fingerprint !== fingerprint || r.result) return fail('TRANSPORT_CONFLICT', '传输回执已变化');
      atomicWriteFileSync(this.path(key), JSON.stringify({ ...r, result }), { durable: true, mode: 0o600, followTargetSymlink: false });
    });
    return result;
  }
}

/** SDK boundary, separate from the pure adapter for wire-level tests. */
export interface AskHumanLarkApi {
  create: Client['im']['v1']['chat']['create'];
  invite: Client['im']['v1']['chatMembers']['create'];
  get(path: string, params?: Record<string, string>): Promise<unknown>;
  sendText(appId: string, chatId: string, text: string, uuid: string): Promise<string>;
  detail(appId: string, messageId: string): Promise<unknown>;
  bots(appId: string, chatId: string): Promise<{ openId: string }[]>;
}

const responseSchema = z.object({ code: z.literal(0), data: z.record(z.unknown()) }).passthrough();
function dataOf(input: unknown): Record<string, unknown> { return responseSchema.parse(input).data; }
const idSchema = z.object({ key: nonempty, id: z.object({ open_id: nonempty }).passthrough() }).passthrough();
const messageSchema = z.object({
  message_id: nonempty, chat_id: nonempty, create_time: z.string().regex(/^\d+$/),
  deleted: z.boolean(), msg_type: z.enum(['text', 'post']),
  sender: z.object({ id: nonempty, sender_type: z.enum(['user', 'app']), id_type: z.string().optional() }).passthrough(),
  body: z.object({ content: z.string() }).passthrough(), mentions: z.array(z.unknown()).optional(),
}).passthrough();

export function askHumanLarkMessage(input: unknown, appId: string): AskHumanReadMessage {
  const m = messageSchema.parse(input);
  const mentions = (m.mentions ?? []).map(raw => {
    // Detail responses use id:string,id_type:open_id; WS events use id.open_id.
    const flat = z.object({ key: nonempty, id: nonempty, id_type: z.literal('open_id') }).passthrough().safeParse(raw);
    if (flat.success) return { key: flat.data.key, openId: flat.data.id };
    const nested = idSchema.parse(raw); return { key: nested.key, openId: nested.id.open_id };
  });
  if (m.sender.sender_type === 'user' && m.sender.id_type !== 'open_id') return fail('IDENTITY_UNPROVEN', '回读真人身份必须是本 app 的 open_id');
  const wire: AskHumanWireContent = { type: m.msg_type, content: m.body.content, mentions };
  // Human plain text is preserved byte-for-byte after JSON decoding. Do NOT
  // trim it, strip mentions, normalize CRLF, or infer a decision here.
  const body = m.sender.sender_type === 'user'
    ? m.msg_type === 'text' ? z.object({ text: z.string() }).strict().parse(JSON.parse(m.body.content)).text
      : fail('UNSUPPORTED_HUMAN_CONTENT', '首版富文本真人回复须保留待处理故障，不静默丢节点')
    : askHumanContentText(wire, mentions.map(v => v.openId));
  const createdAt = Number(m.create_time);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) return fail('INVALID_MESSAGE', '消息时间无效');
  return { messageId: m.message_id, chatId: m.chat_id, appId, senderId: m.sender.id,
    senderType: m.sender.sender_type === 'app' ? 'bot' : 'user', createdAt, deleted: m.deleted, body, wire };
}

export function createAskHumanLarkTransport(options: {
  appId: string; botSenderId: string; botMemberOpenId: string; receipts: AskHumanTransportReceipts; api: AskHumanLarkApi;
  /** Daemon-owned scope check, on EVERY write. Not from CLI JSON. Includes
   * activation authority, source binding, intent target and purpose guards.
   */
  assertWrite(input: { operation: 'create' | 'invite' | 'send'; appId: string; target: string; uuid?: string }): void;
}): Transport {
  const { appId, botSenderId, api, receipts } = options;
  const sameApp = (given: string) => { if (given !== appId) fail('RUNTIME_APP_MISMATCH', '禁止跨 app 传输'); };
  const key = (kind: string, target: string, uuid: string) => JSON.stringify([appId, kind, target, uuid]);
  async function readRoom(roomId: string) {
    const data = dataOf(await api.get(`/open-apis/im/v1/chats/${encodeURIComponent(roomId)}`, { user_id_type: 'open_id' }));
    const detail = z.object({ name: nonempty, chat_type: z.literal('private'), chat_mode: z.literal('group'), external: z.literal(false) }).passthrough().parse(data);
    const users: string[] = [], seen = new Set<string>(); let pageToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const p = dataOf(await api.get(`/open-apis/im/v1/chats/${encodeURIComponent(roomId)}/members`, {
        member_id_type: 'open_id', page_size: '100', ...(pageToken ? { page_token: pageToken } : {}),
      }));
      const list = z.object({ items: z.array(z.object({ member_id: nonempty }).passthrough()), has_more: z.boolean(), page_token: z.string().optional() }).passthrough().parse(p);
      users.push(...list.items.map(m => m.member_id));
      if (!list.has_more) {
        const bots = await api.bots(appId, roomId);
        if (bots.length !== 1 || bots[0].openId !== options.botMemberOpenId) return fail('ROOM_NOT_ISOLATED', '运行 bot 成员不能证实或含其它 bot');
        // Membership uses observer-scoped open_id; message detail uses the
        // app sender ID. Mapping is supplied only by the verified daemon bot.
        return { roomId, appId, name: detail.name, private: true, memberIds: [...users, botSenderId] };
      }
      if (!list.page_token || seen.has(list.page_token)) return fail('MEMBERSHIP_INCOMPLETE', '成员分页不完整');
      seen.add(list.page_token); pageToken = list.page_token;
    }
    return fail('MEMBERSHIP_INCOMPLETE', '成员分页超过上限，不能当作只有 bot');
  }
  return {
    readRoom,
    async createBotOnlyRoom(input) {
      sameApp(input.appId);
      options.assertWrite({ operation: 'create', appId, target: input.name, uuid: input.uuid });
      return receipts.once(key('create', '', input.uuid), input, async () => {
        options.assertWrite({ operation: 'create', appId, target: input.name, uuid: input.uuid });
        const result = dataOf(await api.create({ params: { uuid: input.uuid, user_id_type: 'open_id' }, data: {
          name: input.name, description: '人类会话：专用转发群，不启动工作会话。',
          chat_mode: 'group', chat_type: 'private', external: false, group_message_type: 'chat',
          edit_permission: 'only_owner', membership_approval: 'approval_required',
        } }));
        return nonempty.parse(result.chat_id);
      });
    },
    async inviteHuman(input) {
      sameApp(input.appId);
      options.assertWrite({ operation: 'invite', appId, target: input.roomId });
      let room = await readRoom(input.roomId);
      if (room.memberIds.some(id => id !== botSenderId && id !== input.openId)) return fail('ROOM_NOT_ISOLATED', '邀请前群中出现其它人');
      if (!room.memberIds.includes(input.openId)) {
        options.assertWrite({ operation: 'invite', appId, target: input.roomId });
        dataOf(await api.invite({ path: { chat_id: input.roomId }, params: { member_id_type: 'open_id' }, data: { id_list: [input.openId] } }));
      }
      room = await readRoom(input.roomId);
      if (room.memberIds.length !== 2 || !room.memberIds.includes(input.openId)) return fail('INVITE_UNCONFIRMED', '回读未确认决策人已在独立群');
    },
    async send(input) {
      sameApp(input.appId);
      options.assertWrite({ operation: 'send', appId, target: input.chatId, uuid: input.uuid });
      const wire = askHumanTextWire(input.body, input.mentions);
      const messageId = await receipts.once(key('send', input.chatId, input.uuid), input, () => {
        options.assertWrite({ operation: 'send', appId, target: input.chatId, uuid: input.uuid });
        return api.sendText(appId, input.chatId, JSON.parse(wire.content).text, input.uuid);
      });
      return { messageId };
    },
    async readMessage(messageId) {
      const detail = z.object({ items: z.array(z.unknown()).length(1) }).passthrough().parse(await api.detail(appId, messageId));
      const message = askHumanLarkMessage(detail.items[0], appId);
      if (message.messageId !== messageId) return fail('READBACK_MISMATCH', '回读返回了另一条消息');
      return message;
    },
    async lookupSend(input) {
      sameApp(input.appId);
      const messageId = receipts.lookup(key('send', input.chatId, input.uuid));
      // No documented provider GET-by-UUID is assumed. Only our original
      // provider acceptance receipt can establish FOUND; absence is UNKNOWN.
      return messageId ? { status: 'FOUND', messageId } : { status: 'UNKNOWN' };
    },
  };
}

/** Opt-in daemon binding; calling it constructs ports, not groups/listeners.
 * Existing sendMessage is reused with unrelated outbound hooks suppressed.
 */
export async function bindAskHumanLarkTransport(options: Omit<Parameters<typeof createAskHumanLarkTransport>[0], 'api'> & {
  outboundPermit?(request: { appId: string; chatId: string; content: string; uuid: string }): object;
}): Promise<Transport> {
  const [{ getBotClient, getBot }, client] = await Promise.all([import('../bot-registry.js'), import('../im/lark/client.js')]);
  if (getBot(options.appId).botOpenId !== options.botMemberOpenId || options.botSenderId !== options.appId) return fail('IDENTITY_UNPROVEN', 'SDK 发件 app 和当前 bot 成员身份尚未一致核实');
  const sdk = getBotClient(options.appId);
  return createAskHumanLarkTransport({ ...options, assertWrite(input) { options.assertWrite(input); client.assertLarkTransport(input.appId, `human-session:${input.operation}`); }, api: {
    create: sdk.im.v1.chat.create.bind(sdk.im.v1.chat), invite: sdk.im.v1.chatMembers.create.bind(sdk.im.v1.chatMembers),
    get: (path, params) => client.larkGet(sdk, path, params, { timeoutMs: 15000 }),
    sendText: (app, chat, body, uuid) => client.sendMessage(app, chat, body, 'text', uuid, undefined, {
      suppressHook: true, humanSessionPermit: options.outboundPermit?.({ appId: app, chatId: chat, content: body, uuid }),
    }),
    detail: (app, id) => client.getMessageDetail(app, id, { timeoutMs: 15000 }),
    bots: (app, chat) => client.listCurrentChatBotMembers(app, chat),
  } });
}
