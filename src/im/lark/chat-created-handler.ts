/**
 * Handler for `im.chat.created` Lark events — wires the main-bot mode's
 * onChatCreated hook (P0).
 *
 * Two trigger paths feed into this:
 *   1. **Lark event stream**: `im.chat.created` arrives via WSClient →
 *      event-dispatcher routes here.
 *   2. **group-creator.ts manual trigger** (P0/4): after createChat()
 *      succeeds, dashboard/cli "build group" commands call
 *      `handleChatCreated()` with a synthetic event so we don't depend on
 *      Lark actually firing the event (it doesn't always, for non-client-
 *      created groups).
 *
 * **P0/2 scope** (this commit): originType inference + ChatContext write.
 * Card rendering + sendMessage land in P0/3 [[commit 3]];
 * group-creator fallback wiring lands in P0/4 [[commit 4]].
 */
import { create, type OriginType } from '../../services/chat-context-store.js';
import { getBot, getAllBots } from '../../bot-registry.js';
import { logger } from '../../utils/logger.js';
import { sendContextCard } from './chat-context-card.js';

/** Subset of Lark's im.chat.created event payload we use. The Lark SDK
 *  types these loosely, so we re-declare the bits we care about. */
export interface ChatCreatedEvent {
  chat_id: string;
  /** Who triggered the creation. */
  operator?: {
    open_id?: string;
    /** Lark reports 'user' for human creators and may report 'app' or 'bot'
     *  for bot creators (the docs aren't fully consistent here, so we
     *  accept both — see [[event-dispatcher.ts]] which has the same comment
     *  about sender_type=app vs bot). */
    operator_type?: 'user' | 'app' | 'bot';
  };
  /** 'group' / 'topic' / 'p2p' — see Lark IM docs. */
  chat_mode?: 'group' | 'topic' | 'p2p';
}

/**
 * Decide originType from operator + chat_mode. Decision tree:
 *
 *   1. chat_mode='p2p' → 'p2p' (regardless of operator — Lark's p2p is
 *      always inherently two-party, not "bot-spawned")
 *   2. operator_type='app' or 'bot' → 'bot_spawned'
 *   3. operator.open_id matches one of our registered bots' open_ids →
 *      'bot_spawned' (covers cases where Lark reports operator_type='user'
 *      but the actual operator is a bot identity in disguise)
 *   4. otherwise → 'human_created'
 */
export function inferOriginType(event: ChatCreatedEvent, larkAppId: string): OriginType {
  if (event.chat_mode === 'p2p') return 'p2p';

  const opType = event.operator?.operator_type;
  if (opType === 'app' || opType === 'bot') return 'bot_spawned';

  const opOpenId = event.operator?.open_id;
  if (opOpenId) {
    // Same-app bot check (the daemon for larkAppId may be the operator).
    try {
      const selfBot = getBot(larkAppId);
      if (selfBot.botOpenId && selfBot.botOpenId === opOpenId) return 'bot_spawned';
    } catch {
      // larkAppId not registered in this daemon — fall through
    }

    // Cross-app sibling bot check (other botmux-registered bots).
    for (const bot of getAllBots()) {
      if (bot.botOpenId === opOpenId) return 'bot_spawned';
    }
  }

  return 'human_created';
}

export interface HandleChatCreatedOpts {
  /** Set by manual trigger (P0/4) when the caller knows which chat issued
   *  the build-group command. Lark event-driven path leaves this undefined
   *  — there's no reverse-lookup from event payload alone. */
  parentChatId?: string | null;
  /** Caller-provided purpose summary. Default placeholder is replaced by
   *  L2 缇蕾 scout when she next runs. */
  purpose?: string;
}

export interface DispatchChatCreatedOpts {
  chatId: string;
  larkAppId: string;
  originType: OriginType;
  parentChatId?: string | null;
  purpose?: string;
  participants?: { openId: string; role: string }[];
}

/**
 * Shared "a chat was just created" dispatch — writes ChatContext + sends
 * welcome card. Bypasses originType inference (caller passes it directly),
 * so this works from both daemon and dashboard processes (dashboard doesn't
 * have bot-registry state, can't run inferOriginType).
 *
 * Used by:
 *   - [[handleChatCreated]] (Lark event path, after running inferOriginType)
 *   - [[group-creator.createGroupWithBots]] (P0/4 manual trigger, originType
 *     is always 'bot_spawned' since group-creator itself is the creator)
 *
 * Idempotent + best-effort card delivery (sendContextCard returns null on
 * failure rather than throwing).
 */
export async function dispatchChatCreated(opts: DispatchChatCreatedOpts): Promise<void> {
  if (!opts.chatId) {
    logger.warn('[chat-created-handler] dispatch called with empty chatId, skipping');
    return;
  }
  create(opts.chatId, {
    purpose: opts.purpose ?? '（待 main-bot 自动推断）',
    originType: opts.originType,
    parentChatId: opts.parentChatId ?? null,
    participants: opts.participants ?? [],
  });
  logger.info(
    `[chat-created-handler] dispatchChatCreated wrote ChatContext for chat ${opts.chatId} ` +
    `(origin=${opts.originType}, parent=${opts.parentChatId ?? 'null'})`
  );
  await sendContextCard(opts.larkAppId, opts.chatId);
}

/**
 * Handle `im.chat.created` — Lark event-driven path. Runs originType
 * inference (needs bot-registry, so daemon-process-only), then delegates
 * to [[dispatchChatCreated]] for the actual work.
 *
 * - Writes the context **regardless of originType** (even p2p and
 *   human_created chats get a minimal record), so the dashboard's "无拓扑
 *   群" sidebar [[topology Q5 decision]] has the data.
 * - Idempotent via [[chat-context-store.create]] — repeat calls (dup events
 *   + manual trigger racing) are safe; the first writer wins.
 */
export async function handleChatCreated(
  event: ChatCreatedEvent,
  larkAppId: string,
  opts: HandleChatCreatedOpts = {},
): Promise<void> {
  if (!event.chat_id) {
    logger.warn('[chat-created-handler] event missing chat_id, skipping');
    return;
  }
  const originType = inferOriginType(event, larkAppId);
  await dispatchChatCreated({
    chatId: event.chat_id,
    larkAppId,
    originType,
    parentChatId: opts.parentChatId,
    purpose: opts.purpose,
  });
}
