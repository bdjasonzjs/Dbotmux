/**
 * Group creation service — execution layer shared by dashboard and CLI.
 *
 * Decision layers (dashboard handler / CLI subcommand) are responsible for
 * choosing `creatorLarkAppId`, resolving bot refs, deriving user_open_ids, etc.
 * This service only orchestrates the Lark API sequence:
 *
 *   1. createChat (bots + invited users)
 *   2. transferChatOwner (best-effort, skipped if invitee was rejected)
 *   3. send @-mention notify (best-effort, skipped if invitee was rejected)
 *
 * Partial failures (transfer/notify) are returned as `*Error` fields without
 * throwing — the chat already exists at that point and retrying would create
 * duplicate groups. Only createChat throwing surfaces as an exception.
 *
 * Lark open_id is app-scoped: `userOpenIds`, `transferOwnerTo`, and
 * `notifyOwnerOpenId` MUST be in `creatorLarkAppId`'s app scope. Enforcing
 * this is the decision layer's job — the service trusts its inputs.
 */
import { createChat, transferChatOwner, getChatOwner } from './groups-store.js';
import { sendMessage } from '../im/lark/client.js';
import { bindOncall } from './oncall-store.js';
import { dispatchChatCreated } from '../im/lark/chat-created-handler.js';
import { logger } from '../utils/logger.js';

export interface CreateGroupOpts {
  creatorLarkAppId: string;
  /** Bots expected to join the new chat. Creator is filtered out internally
   *  (Lark rejects self-invite). May be empty (creator-only chat). */
  larkAppIds: string[];
  name?: string;
  userOpenIds?: string[];
  transferOwnerTo?: string;
  notifyOwnerOpenId?: string;
  /** Optional working directory to bind the newly created chat to oncall for
   *  every invited bot. The path is validated by callers; this service only
   *  persists the binding after chat.create succeeds. */
  bindWorkingDir?: string;
  /** P0/4 main-bot mode: source chat the build-group command originated from.
   *  Becomes the new chat's `parentChatId` for the topology tree. Pass null
   *  if triggered from a p2p chat or system context (no parent edge drawn). */
  sourceChatId?: string | null;
  /** P0/4 main-bot mode: one-line purpose statement. Defaults to a placeholder
   *  that the L2 缇蕾 scout replaces on its next tick. */
  purpose?: string;
  /**
   * P1 main-bot mode (spec v0.4.1 §1.1) — richer ChatContext fields,
   * passed straight through to `dispatchChatCreated()` so the FIRST
   * welcome card is complete (no "send empty card, then update" anti-
   * pattern). Optional: callers that don't care (legacy `/group`,
   * dashboard `build-group`) can omit and get current purpose-only
   * behavior.
   *
   * Note: `participants` here is what caller already resolved
   * (MainBotPlaybook is responsible for推导 bot ref → openId+role).
   * group-creator does NOT auto-推导 — it只透传给 dispatchChatCreated.
   *
   * `idempotencyKey` is deliberately absent (v0.4 妹妹 #2): idempotency
   * 主责完全在 MainBotPlaybook + spawn-idempotency-store, group-creator
   * 不知道幂等概念。
   *
   * Wiring (commit #4): pass these into `dispatchChatCreated` opts.
   * Commit #1 (this commit) is types-only — no body change yet.
   */
  chatContext?: {
    taskType?: 'prd' | 'bug' | 'misc';
    relatedRefs?: string[];
    activeTodoRefs?: string[];
    rules?: string[];
    participants?: Array<{ openId: string; role: string }>;
    parentDigest?: string;
  };
}

export interface CreateGroupResult {
  ok: true;
  chatId: string;
  creator: string;
  invalidBotIds: string[];
  invalidUserIds: string[];
  ownerTransferredTo: string | null;
  transferError: string | null;
  notifyMessageId: string | null;
  notifyError: string | null;
  oncallBindings: { larkAppId: string; ok: boolean; created?: boolean; error?: string }[];
}

export async function createGroupWithBots(opts: CreateGroupOpts): Promise<CreateGroupResult> {
  // Filter creator out of the bot invite list. createChat does this defensively
  // too, but doing it here makes the service contract explicit and keeps
  // invalidBotIds reporting stable across underlying API changes.
  const otherBots = opts.larkAppIds.filter(id => id !== opts.creatorLarkAppId);
  const r = await createChat(opts.creatorLarkAppId, {
    name: opts.name,
    botIds: otherBots,
    userIds: opts.userOpenIds ?? [],
  });

  let ownerTransferredTo: string | null = null;
  let transferError: string | null = null;
  if (opts.transferOwnerTo) {
    // Skip transfer if Feishu rejected the invite — transferring to a
    // non-member returns "user not in chat" anyway.
    if (r.invalidUserIds.includes(opts.transferOwnerTo)) {
      transferError = 'invitee_rejected';
    } else {
      const tr = await transferChatOwner(opts.creatorLarkAppId, r.chatId, opts.transferOwnerTo);
      if (tr.ok) {
        ownerTransferredTo = opts.transferOwnerTo;
      } else {
        // Lark occasionally ACKs the owner transfer slowly (504 Gateway Timeout
        // or transient network error) even though the write actually committed
        // server-side. Verify by reading back the current owner before
        // surfacing the error — if the chat is already owned by the target,
        // the transfer really did succeed and the warning would mislead.
        const currentOwner = await getChatOwner(opts.creatorLarkAppId, r.chatId);
        if (currentOwner === opts.transferOwnerTo) {
          ownerTransferredTo = opts.transferOwnerTo;
        } else {
          transferError = tr.error;
        }
      }
    }
  }

  let notifyMessageId: string | null = null;
  let notifyError: string | null = null;
  if (opts.notifyOwnerOpenId) {
    if (r.invalidUserIds.includes(opts.notifyOwnerOpenId)) {
      notifyError = 'invitee_rejected';
    } else {
      try {
        notifyMessageId = await sendMessage(
          opts.creatorLarkAppId,
          r.chatId,
          `<at user_id="${opts.notifyOwnerOpenId}"></at>`,
          'text',
        );
      } catch (e: any) {
        notifyError = e?.message ?? String(e);
      }
    }
  }

  const oncallBindings: CreateGroupResult['oncallBindings'] = [];
  const bindWorkingDir = opts.bindWorkingDir?.trim();
  if (bindWorkingDir) {
    // Bind the new chat for every bot that actually joined it. The creator is
    // an implicit member; Lark reports rejected invitees in invalidBotIds.
    const invalidBots = new Set(r.invalidBotIds);
    const targetBotIds = Array.from(new Set([opts.creatorLarkAppId, ...opts.larkAppIds]))
      .filter(id => !invalidBots.has(id));
    for (const larkAppId of targetBotIds) {
      try {
        const br = await bindOncall(larkAppId, r.chatId, bindWorkingDir);
        if (br.ok) {
          oncallBindings.push({ larkAppId, ok: true, created: br.created });
        } else {
          oncallBindings.push({ larkAppId, ok: false, error: br.reason });
        }
      } catch (e: any) {
        oncallBindings.push({ larkAppId, ok: false, error: e?.message ?? String(e) });
      }
    }
  }

  // P0/4 main-bot mode fallback: write ChatContext + send welcome card.
  // This runs **regardless of** whether Lark fires `im.chat.created` for
  // this group — chat-context-store.create is idempotent, so if the event
  // also fires later it's a no-op. Best-effort: failures are logged but
  // never block group creation (which already succeeded at this point).
  try {
    await dispatchChatCreated({
      chatId: r.chatId,
      larkAppId: opts.creatorLarkAppId,
      originType: 'bot_spawned',  // group-creator is always invoked by a bot
      parentChatId: opts.sourceChatId ?? null,
      purpose: opts.purpose,
    });
  } catch (err) {
    logger.error(`[group-creator] main-bot dispatchChatCreated failed for chat ${r.chatId}: ${err}`);
  }

  return {
    ok: true,
    chatId: r.chatId,
    creator: opts.creatorLarkAppId,
    invalidBotIds: r.invalidBotIds,
    invalidUserIds: r.invalidUserIds,
    ownerTransferredTo,
    transferError,
    notifyMessageId,
    notifyError,
    oncallBindings,
  };
}
