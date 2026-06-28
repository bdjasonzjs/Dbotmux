/**
 * Thin wrappers over Feishu IM v1 chat APIs for the dashboard's groups board.
 *
 * Phase B (Web Dashboard) — Task 24. These wrappers are stateless; they reuse
 * the per-bot Lark SDK client created by `bot-registry`.
 *
 * The "proxy bot" pattern in `addBotToChat`: Feishu requires the inviter to
 * already be a member of the chat, so the dashboard picks an existing-member
 * bot to do the invite. This wrapper just exposes the underlying call —
 * proxy selection happens at the route layer.
 */
import { getBotClient } from '../bot-registry.js';
import { logger } from '../utils/logger.js';

/**
 * 从飞书 232043 错误里解析出被点名的非法 user id。典型成因：bot 的 open_id 被当成「人类成员」塞进
 * user_id_list（飞书规定 bot 只能进 bot_id_list），飞书拒绝整个建群请求。
 * 错误文案形如：`...invalid user ids: [ou_xxx, ou_yyy]`。
 */
export function parseInvalidUserIds232043(err: unknown): string[] {
  const anyErr = err as any;
  const code = anyErr?.response?.data?.code ?? anyErr?.code;
  const msg: string =
    anyErr?.response?.data?.msg ?? (err instanceof Error ? err.message : String(err ?? '')) ?? '';
  // 收紧：必须是 232043（code 字段或文案里的字面量），不只凭 "invalid user ids" 文案 —— 避免误把
  // 别的 code 的错误也当成可剔除重试（蔻黛复审 non-blocking 建议）。
  const is232043 = code === 232043 || /\b232043\b/.test(msg);
  if (!is232043) return [];
  const m = /invalid user ids:\s*\[([^\]]*)\]/i.exec(msg);
  if (!m) return [];
  return m[1].split(',').map(s => s.trim()).filter(Boolean);
}

export interface ChatBrief {
  chatId: string;
  name?: string;
  description?: string;
  chatMode?: string;
  ownerId?: string;
}

/**
 * List chats the given bot is a member of, draining pagination internally.
 * Uses /open-apis/im/v1/chats.
 */
export async function listChats(larkAppId: string): Promise<ChatBrief[]> {
  const client = getBotClient(larkAppId);
  const out: ChatBrief[] = [];
  let pageToken: string | undefined;
  do {
    const res: any = await (client as any).im.v1.chat.list({
      params: {
        page_size: 100,
        user_id_type: 'open_id',
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });
    if (res.code !== 0 && res.code !== undefined) {
      throw new Error(`Failed to list chats: ${res.msg} (code: ${res.code})`);
    }
    for (const c of res.data?.items ?? []) {
      out.push({
        chatId: c.chat_id,
        name: c.name,
        description: c.description,
        chatMode: c.chat_mode,
        ownerId: c.owner_id,
      });
    }
    pageToken = res.data?.has_more ? res.data?.page_token : undefined;
  } while (pageToken);
  return out;
}

/**
 * Check whether the given bot is a member of the given chat.
 * Uses /open-apis/im/v1/chats/:chat_id/members/is_in_chat — the bot's own
 * access token implicitly identifies the bot being checked.
 *
 * Errors (chat not found, no permission, etc.) are swallowed and treated as
 * "not in chat" so callers can use this as a simple boolean predicate.
 */
export async function isInChat(larkAppId: string, chatId: string): Promise<boolean> {
  const client = getBotClient(larkAppId);
  try {
    const res: any = await (client as any).im.v1.chatMembers.isInChat({
      path: { chat_id: chatId },
    });
    if (res.code !== 0 && res.code !== undefined) return false;
    return !!res.data?.is_in_chat;
  } catch {
    return false;
  }
}

/**
 * Create a brand-new chat with `bot_id_list` as initial bot members.  The
 * `creatorLarkAppId` bot becomes the chat's owner and an implicit member; the
 * other bots in `botIds` are added in the same call.  Used by the dashboard's
 * "Create new group" flow.
 *
 * Returns the new chatId on success.  Throws on any non-zero Lark response so
 * the route can surface a real error.  We deliberately don't soften failures
 * here (unlike `isInChat`) because the caller wants to know whether the chat
 * actually got created.
 */
export async function createChat(
  creatorLarkAppId: string,
  opts: { name?: string; botIds: string[]; userIds?: string[] },
): Promise<{ chatId: string; invalidBotIds: string[]; invalidUserIds: string[] }> {
  const client = getBotClient(creatorLarkAppId);
  // Filter out the creator from bot_id_list — Lark errors if the inviter
  // appears in their own invite list.
  const otherBots = opts.botIds.filter(id => id !== creatorLarkAppId);
  let userIds = (opts.userIds ?? []).filter(Boolean);
  let droppedUserIds: string[] = []; // 232043 重试时剔除的非法 user id，需回传给上层（见返回值）

  const buildReq = () => {
    const data: Record<string, unknown> = {};
    if (opts.name) data.name = opts.name;
    if (otherBots.length > 0) data.bot_id_list = otherBots;
    if (userIds.length > 0) data.user_id_list = userIds;
    const params: Record<string, unknown> = {};
    if (userIds.length > 0) params.user_id_type = 'open_id';
    return { data, params };
  };

  let res: any;
  try {
    const { data, params } = buildReq();
    res = await (client as any).im.v1.chat.create({ data, params });
  } catch (err) {
    // 飞书 232043：user_id_list 含非法 user id —— 最常见是某个 bot 的 open_id 被当成「人类成员」
    // 塞进来（飞书规定 bot 只能进 bot_id_list），于是整个建群请求被拒、群没建成。这会让「成员里
    // 含 bot 的群」用 subtask-start 拆子群 100% 失败。
    // 协议边界兜底：解析飞书点名的非法 id，从 user_id_list 剔除后**重试一次**（建群失败时未创建任何
    // 群，重试不会建出重复群）。与「上游为什么会把 bot id 混进 user 列表」解耦——保证含 bot 群也能建。
    const invalid = parseInvalidUserIds232043(err);
    const dropped = userIds.filter(id => invalid.includes(id));
    if (dropped.length === 0) throw err; // 非此原因 / 无可剔除项 → 原样抛出
    droppedUserIds = dropped;
    userIds = userIds.filter(id => !invalid.includes(id));
    logger.warn(
      `[groups-store] createChat 飞书 232043：user_id_list 含非法 id ${JSON.stringify(dropped)}` +
      `（疑似 bot 的 open_id 被误当人类成员），已剔除并重试一次。`,
    );
    const { data, params } = buildReq();
    res = await (client as any).im.v1.chat.create({ data, params });
  }
  if (res.code !== 0 && res.code !== undefined) {
    throw new Error(`Failed to create chat: ${res.msg ?? 'unknown'} (code: ${res.code})`);
  }
  // 把重试剔除的 id 与飞书第二次响应的 invalid_user_id_list 合并去重，继续通过 invalidUserIds 暴露 ——
  // 上层(group-creator transfer/notify、daemon userInvited)据此判断"该 id 未入群"，避免误报邀请成功
  // （蔻黛复审 B1）。
  const larkInvalidUsers: string[] = res.data?.invalid_user_id_list ?? [];
  return {
    chatId: res.data?.chat_id,
    invalidBotIds: res.data?.invalid_bot_id_list ?? [],
    invalidUserIds: Array.from(new Set([...larkInvalidUsers, ...droppedUserIds])),
  };
}

/**
 * Transfer ownership of a chat from the calling bot to a Feishu user.  Used
 * after `createChat` so the dashboard operator (who's been invited as a
 * member) ends up as the actual owner — otherwise the bot stays group owner
 * and the user can't manage the chat.
 *
 * Calls /open-apis/im/v1/chats/:chat_id with `owner_id` in the body and
 * `user_id_type=open_id`. The caller's bot must currently be the owner; this
 * is the case right after createChat since the creator bot is the implicit
 * owner.
 *
 * `newOwnerOpenId` must be in the calling bot's app scope — Lark open_ids are
 * app-scoped, see operator-selector.ts for why.
 */
export async function transferChatOwner(
  ownerLarkAppId: string,
  chatId: string,
  newOwnerOpenId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = getBotClient(ownerLarkAppId);
  try {
    const res: any = await (client as any).im.v1.chat.update({
      path: { chat_id: chatId },
      params: { user_id_type: 'open_id' },
      data: { owner_id: newOwnerOpenId },
    });
    if (res.code !== 0 && res.code !== undefined) {
      return { ok: false, error: `${res.msg ?? 'unknown'} (code: ${res.code})` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * Fetch the current owner of a chat (as an open_id). Used by group-creator to
 * verify the post-transfer state when transferChatOwner returns an error —
 * Lark sometimes ACKs a transfer slowly (e.g. 504 Gateway Timeout) even though
 * the server-side write succeeded, so a follow-up read disambiguates "really
 * failed" from "ACK lost".
 *
 * Returns undefined when the API itself errors or doesn't include owner_id;
 * callers treat undefined as "unknown" and keep the original error.
 */
export async function getChatOwner(
  larkAppId: string, chatId: string,
): Promise<string | undefined> {
  const client = getBotClient(larkAppId);
  try {
    const res: any = await (client as any).im.v1.chat.get({
      path: { chat_id: chatId },
      params: { user_id_type: 'open_id' },
    });
    if (res.code !== 0 && res.code !== undefined) return undefined;
    const owner = res.data?.owner_id;
    return typeof owner === 'string' && owner.length > 0 ? owner : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Disband (delete) a chat. The Lark API only succeeds when the calling bot is
 * the chat's current owner, OR is the creator AND the app holds
 * `im:chat:operate_as_owner`. Routes that fan-out to multiple bots can use
 * this best-effort: try each in-chat bot until one succeeds.
 */
export async function disbandChat(
  larkAppId: string, chatId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = getBotClient(larkAppId);
  try {
    const res: any = await (client as any).im.v1.chat.delete({ path: { chat_id: chatId } });
    if (res.code !== 0 && res.code !== undefined) {
      return { ok: false, error: `${res.msg ?? 'unknown'} (code: ${res.code})` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * Make the calling bot leave a chat.  Per Lark docs, self-removal succeeds
 * regardless of role (owner/manager/member). Useful when the bot can't disband
 * (not owner, no operate_as_owner scope) but still wants to detach.
 */
export async function leaveChat(
  larkAppId: string, chatId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = getBotClient(larkAppId);
  try {
    const res: any = await (client as any).im.v1.chatMembers.delete({
      path: { chat_id: chatId },
      params: { member_id_type: 'app_id' },
      data: { id_list: [larkAppId] },
    });
    if (res.code !== 0 && res.code !== undefined) {
      return { ok: false, error: `${res.msg ?? 'unknown'} (code: ${res.code})` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * Add bot apps to a chat using a "proxy" bot that's already a member.
 * Uses /open-apis/im/v1/chats/:chat_id/members with member_id_type=app_id.
 * Returns per-id result derived from the API's invalid_id_list.
 *
 * On total failure (network error, non-zero code) every id reports the same
 * error so the caller can present a uniform per-id status.
 */
export async function addBotToChat(
  proxyLarkAppId: string,
  chatId: string,
  targetLarkAppIds: string[],
): Promise<{ id: string; ok: boolean; error?: string }[]> {
  if (targetLarkAppIds.length === 0) return [];
  const client = getBotClient(proxyLarkAppId);
  const out: { id: string; ok: boolean; error?: string }[] = [];
  try {
    const res: any = await (client as any).im.v1.chatMembers.create({
      path: { chat_id: chatId },
      params: { member_id_type: 'app_id' },
      data: { id_list: targetLarkAppIds },
    });
    if (res.code !== 0 && res.code !== undefined) {
      const errMsg = `${res.msg ?? 'unknown'} (code: ${res.code})`;
      for (const id of targetLarkAppIds) out.push({ id, ok: false, error: errMsg });
      return out;
    }
    const invalid = new Set<string>(res.data?.invalid_id_list ?? []);
    for (const id of targetLarkAppIds) {
      out.push(invalid.has(id) ? { id, ok: false, error: 'invalid_id' } : { id, ok: true });
    }
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    for (const id of targetLarkAppIds) out.push({ id, ok: false, error: msg });
  }
  return out;
}
