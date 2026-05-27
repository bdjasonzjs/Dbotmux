/**
 * Handler for the main-bot mode "a chat was just created (and our bot is in
 * it)" hook (P0).
 *
 * **Event source choice (2026-05-24)**: Lark does NOT publish a public
 * `im.chat.created` event subscription — verified via daemon stderr ("no
 * im.chat.member.bot.added_v1 handle" warning showed up, but no
 * `chat.created` ever did). Instead, we listen to
 * `im.chat.member.bot.added_v1` which fires whenever our bot is added to
 * any chat — including newly created ones. The semantics are subtly
 * better than `chat.created`: even if a user creates a chat without our
 * bot and adds us later, we still get the hook (and we're not interested
 * in chats we're not in).
 *
 * Two trigger paths feed into this:
 *   1. **Lark event stream**: `im.chat.member.bot.added_v1` arrives via
 *      WSClient → event-dispatcher routes to [[handleChatMemberBotAdded]].
 *   2. **group-creator.ts manual trigger** (P0/4): after createChat()
 *      succeeds, dashboard/cli "build group" commands call
 *      [[dispatchChatCreated]] with the chat info so we don't depend on
 *      the event also firing (and so we get parentChatId + purpose from
 *      the caller context).
 *
 * Both paths converge on [[dispatchChatCreated]], which is idempotent via
 * [[chat-context-store.create]] (first writer wins) — repeat fires are
 * safe. The welcome card is sent only when ChatContext is **first**
 * created (we re-read after create() to detect newness), so a bot
 * re-entering an existing chat doesn't spam the card again.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { create, read, update, type OriginType } from '../../services/chat-context-store.js';
import { upsertNode as topologyUpsertNode, getNode as topologyGetNode } from '../../services/chat-topology-store.js';
import { getBot, getAllBots } from '../../bot-registry.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { sendContextCard } from './chat-context-card.js';

/** Cross-app peer bot detection. event-dispatcher.ts maintains a per-app
 *  `bot-openids-<larkAppId>.json` cross-ref (learned from @mentions in
 *  messages); it maps botName → open_id as seen by larkAppId's app.
 *  We read it directly here (instead of importing from event-dispatcher)
 *  to avoid a circular import — event-dispatcher imports us. */
function isCrossAppBotOpenId(operatorOpenId: string, larkAppId: string): boolean {
  try {
    const fp = join(config.session.dataDir, `bot-openids-${larkAppId}.json`);
    if (!existsSync(fp)) return false;
    const data: Record<string, string> = JSON.parse(readFileSync(fp, 'utf-8'));
    return Object.values(data).includes(operatorOpenId);
  } catch {
    return false;
  }
}

/** Subset of Lark's `im.chat.member.bot.added_v1` event payload we use.
 *  The Lark SDK types these loosely, so we re-declare the bits we care
 *  about. See:
 *  https://open.larksuite.com/document/server-docs/group/chat-member/event/added.md */
export interface ChatMemberBotAddedEvent {
  chat_id: string;
  /** Who added the bot. Lark doesn't tag this as user/bot — we reverse-
   *  look the open_id in our registry to decide. */
  operator_id?: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  external?: boolean;
  operator_tenant_key?: string;
  name?: string;
  i18n_names?: {
    zh_cn?: string;
    en_us?: string;
    ja_jp?: string;
  };
}

/**
 * Decide originType from operator open_id by reverse-lookup against the
 * bot registry + cross-app peers:
 *
 *   1. operator matches the current daemon's own bot open_id → `bot_spawned`
 *   2. operator matches one of getAllBots() (same-app sibling) → `bot_spawned`
 *   3. operator matches `bot-openids-<larkAppId>.json` cross-ref
 *      (cross-app peer learned from prior @mentions) → `bot_spawned`
 *   4. otherwise → `human_created`
 *
 * Note: we don't try to detect 'p2p' from this event because
 * `im.chat.member.bot.added_v1` only fires for groups (Lark p2p chats are
 * implicit, no add-bot step). If we ever need p2p handling we'll wire it
 * separately.
 */
export function inferOriginType(event: ChatMemberBotAddedEvent, larkAppId: string): OriginType {
  const opOpenId = event.operator_id?.open_id;
  if (!opOpenId) return 'human_created';

  // 1. Same-app bot check (the daemon for larkAppId may be the operator).
  try {
    const selfBot = getBot(larkAppId);
    if (selfBot.botOpenId && selfBot.botOpenId === opOpenId) return 'bot_spawned';
  } catch {
    // larkAppId not registered in this daemon — fall through
  }

  // 2. Same-app sibling bots (getAllBots returns this-daemon-registered bots).
  for (const bot of getAllBots()) {
    if (bot.botOpenId === opOpenId) return 'bot_spawned';
  }

  // 3. Cross-app peer bot check via bot-openids cross-ref file. Critical
  //    for the common case where 克劳德 (cli_a97 app) creates a chat and
  //    invites 蔻黛克斯 (cli_a974 app): the bot.added event arrives at
  //    蔻黛克斯's daemon, where getAllBots() only sees 蔻黛克斯 herself —
  //    but the cross-ref file knows 克劳德's open_id from prior @mentions.
  if (isCrossAppBotOpenId(opOpenId, larkAppId)) return 'bot_spawned';

  return 'human_created';
}

export interface HandleChatMemberBotAddedOpts {
  /** Set by manual trigger (P0/4) when the caller knows which chat issued
   *  the build-group command. Lark event path leaves this undefined —
   *  there's no reverse-lookup from event payload alone. */
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
  /** P1 main-bot mode (spec v0.4.1 §1.3) — richer ChatContext fields
   *  plumbed through from group-creator / Playbook so the FIRST welcome
   *  card is complete. dispatchChatCreated body writes these straight
   *  into ChatContext.create() (chat-context-store has承载位 already).
   *  Implementation is wired in commit #5, here is types-only (commit #1). */
  relatedRefs?: string[];
  activeTodoRefs?: string[];
  rules?: string[];
  parentDigest?: string;
  taskType?: 'prd' | 'bug' | 'misc';
}

/**
 * Shared "a chat was just created" dispatch — writes ChatContext + sends
 * welcome card on **first** dispatch only (bot re-entering an existing
 * chat doesn't re-spam the card). Bypasses originType inference (caller
 * passes it directly), so this works from both daemon and dashboard
 * processes (dashboard doesn't have bot-registry state, can't run
 * inferOriginType).
 *
 * Used by:
 *   - [[handleChatMemberBotAdded]] (Lark event path, after inferring originType)
 *   - [[group-creator.createGroupWithBots]] (P0/4 manual trigger; originType
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
  // Detect first-write so we only send the welcome card when ChatContext
  // is actually new. chat-context-store.create() is idempotent (first
  // writer wins), so checking read() before create() tells us whether
  // this dispatch is the first writer.
  const isFirstDispatch = read(opts.chatId) === null;

  create(opts.chatId, {
    purpose: opts.purpose ?? '（待 main-bot 自动推断）',
    originType: opts.originType,
    parentChatId: opts.parentChatId ?? null,
    participants: opts.participants ?? [],
    // P1 commit #5: persist rich ChatContext fields plumbed through
    // from group-creator (which got them from MainBotPlaybook). Optional —
    // legacy callers omit and ChatContext gets old behavior (empty arrays
    // / undefined). taskType is undefined for non-Playbook spawns
    // (legacy /group / human_created etc.) which is exactly what dashboard
    // filtering wants.
    relatedRefs: opts.relatedRefs,
    activeTodoRefs: opts.activeTodoRefs,
    rules: opts.rules,
    parentDigest: opts.parentDigest,
    taskType: opts.taskType,
  });

  // 2026-05-27 (松松实拍): "派生自: (无父群)" bug — root cause: dispatchChatCreated
  // 可能被两条路径调用 (a) group-creator manual (带 parentChatId) (b) Lark
  // im.chat.created event (parentChatId=undefined). ChatContext.create() 是
  // first-writer-wins; 如果 (b) 先到, create 写入 parent=null, (a) 后到
  // skip → ChatContext 永远丢 parent。
  //
  // ChatTopology 那段 (line 213-) 已有 sticky logic 处理同样问题。这里给
  // ChatContext 也加 sticky-merge。妹妹 review (commit 65a05b9 phase 1 后)
  // 建议把 parent backfill 和 field enrichment 拆成独立条件, 避免 「没传
  // parent 但带真 purpose」 时 enrichment 被错过。
  //
  // 通用「非空补空」: 每个字段独立判断 (existing 是空 / 占位 ∧ opts 带真值
  // → 补)。任何字段需要补, 才发一次 update。
  if (!isFirstDispatch) {
    const existing = read(opts.chatId);
    if (existing) {
      const patch: Partial<Parameters<typeof update>[1]> = {};
      // 1) parent backfill: existing inheritedFrom 空 + opts 带 parentChatId
      if (!existing.inheritedFrom?.parentChatId && opts.parentChatId) {
        patch.inheritedFrom = {
          parentChatId: opts.parentChatId,
          parentDigest: opts.parentDigest ?? '',
        };
      }
      // 2) originType 单向升级: human_created → bot_spawned (信息量更大),
      //    bot_spawned 不降级 (即使本次说 human_created)
      if (existing.originType !== 'bot_spawned' && opts.originType === 'bot_spawned') {
        patch.originType = 'bot_spawned';
      }
      // 3) purpose 占位升级: existing 是 "（待 main-bot 自动推断）" 占位 + opts 有真值
      if (
        existing.purpose === '（待 main-bot 自动推断）' &&
        opts.purpose &&
        opts.purpose !== '（待 main-bot 自动推断）'
      ) {
        patch.purpose = opts.purpose;
      }
      // 4) participants 空补: existing 空 + opts 非空
      if (existing.participants.length === 0 && opts.participants && opts.participants.length > 0) {
        patch.participants = opts.participants;
      }
      if (Object.keys(patch).length > 0) {
        update(opts.chatId, patch);
        const what = Object.keys(patch).join(',');
        logger.info(
          `[chat-created-handler] sticky-merge: chat ${opts.chatId.slice(0,12)} fields=${what}` +
          (patch.inheritedFrom ? ` parent=${opts.parentChatId!.slice(0,12)}` : ''),
        );
      }
    }
  }

  // P4-fix: also write to ChatTopology so dashboard's topology page sees
  // the new chat (otherwise topology only gets nodes via onMessage hook,
  // which defaults to originType=human_created — losing the real type).
  //
  // 2026-05-25 fix: dispatchChatCreated 可能被两条路径调用——
  //   (a) group-creator 主动派 (带 parentChatId)
  //   (b) Lark im.chat.created 事件 (payload 不带 parent)
  // 如果 (b) 后于 (a) 到达，opts.parentChatId 是 undefined → 旧代码 `?? null`
  // 会把 (a) 写好的 parent 抹成 null，导致前端拓扑图永远画不出主→子线。
  // 改成「caller 没显式传时就 preserve 已存的字段」。originType 同理：
  // bot_spawned 比 human_created 信息量大，已存为 bot_spawned 不能被
  // 后到的 human_created 覆盖。
  const existingTopoNode = topologyGetNode(opts.chatId);
  const nextParent = opts.parentChatId !== undefined
    ? opts.parentChatId
    : existingTopoNode?.parentChatId ?? null;
  const nextOrigin = (existingTopoNode?.originType === 'bot_spawned' && opts.originType !== 'bot_spawned')
    ? existingTopoNode.originType
    : opts.originType;
  topologyUpsertNode({
    chatId: opts.chatId,
    name: existingTopoNode?.name ?? opts.chatId,
    chatType: 'group',
    originType: nextOrigin,
    parentChatId: nextParent,
    tags: existingTopoNode?.tags ?? [],
    metrics: existingTopoNode?.metrics ?? { lastMessageAt: new Date().toISOString(), messages24h: 0, hasUnansweredPing: false },
    summary: existingTopoNode?.summary ?? (opts.purpose ?? ''),
  });

  if (isFirstDispatch) {
    logger.info(
      `[chat-created-handler] first dispatch for chat ${opts.chatId} ` +
      `(origin=${opts.originType}, parent=${opts.parentChatId ?? 'null'}) — sending welcome card`
    );
    await sendContextCard(opts.larkAppId, opts.chatId);
  } else {
    logger.debug(
      `[chat-created-handler] dispatch for chat ${opts.chatId} skipped card (ChatContext already exists)`
    );
  }
}

/**
 * Handle `im.chat.member.bot.added_v1` — Lark event-driven path. Runs
 * originType inference (needs bot-registry, so daemon-process-only), then
 * delegates to [[dispatchChatCreated]] for the actual work.
 *
 * - Writes the context for any chat the bot joins (the welcome card only
 *   goes out on first dispatch, so re-joins don't spam).
 * - Idempotent via [[chat-context-store.create]] — repeat events (dup
 *   bot.added fires + manual trigger racing) are safe; the first writer
 *   wins.
 */
export async function handleChatMemberBotAdded(
  event: ChatMemberBotAddedEvent,
  larkAppId: string,
  opts: HandleChatMemberBotAddedOpts = {},
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
