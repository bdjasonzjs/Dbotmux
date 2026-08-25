/**
 * External-chat (外部群 / cross-tenant) surface policy for session cards.
 *
 * Kept in its own module (not session-manager) so it stays importable from
 * worker-pool / card-handler / daemon without widening those modules' mock
 * surface in tests.
 */
import type { DaemonSession } from './types.js';
import * as sessionStore from '../services/session-store.js';
import { getCachedChatExternal } from '../im/lark/chat-external-cache.js';

/** Per (appId, chatId): last time we kicked a background chat.get to learn the
 *  `external` flag for a session whose record doesn't carry it yet. Throttles
 *  the refresh so a streaming card that patches every screen update doesn't
 *  turn into a chat.get storm while the flag is still unknown. */
const externalChatRefreshAt = new Map<string, number>();
const EXTERNAL_CHAT_REFRESH_MIN_INTERVAL_MS = 60_000;

/**
 * Whether `ds` lives in an external (cross-tenant, 外部群) chat. Session cards
 * rendered there carry NO control buttons (显示输出 / 打开终端 / 获取操作链接 /
 * 关闭会话 …) — external members get a status-only card.
 *
 * Resolution order:
 *   1. p2p chats are never external.
 *   2. `session.externalChat` when already persisted.
 *   3. The chat-mode cache (populated by every message-routing chat.get);
 *      the value is written back onto the session so cards rebuilt after a
 *      daemon restart keep the same surface before any new message arrives.
 *   4. Unknown → render the normal internal surface now, and refresh the cache
 *      in the background (throttled) so the next card patch picks it up.
 *
 * Synchronous on purpose: every card builder call site is sync.
 */
export function isExternalChatSession(ds: Pick<DaemonSession, 'session' | 'larkAppId' | 'chatId' | 'chatType'>): boolean {
  if (ds.chatType === 'p2p' || ds.session.chatType === 'p2p') return false;
  if (typeof ds.session.externalChat === 'boolean') return ds.session.externalChat;
  const cached = getCachedChatExternal(ds.larkAppId, ds.chatId);
  if (cached !== undefined) {
    ds.session.externalChat = cached;
    try { sessionStore.updateSession(ds.session); } catch { /* best-effort persist */ }
    return cached;
  }
  const key = `${ds.larkAppId}::${ds.chatId}`;
  const now = Date.now();
  const last = externalChatRefreshAt.get(key) ?? 0;
  if (now - last >= EXTERNAL_CHAT_REFRESH_MIN_INTERVAL_MS) {
    externalChatRefreshAt.set(key, now);
    // Dynamic import on purpose: this runs on every card render from modules
    // whose tests fully mock client.js; a static import would make the mock's
    // missing export throw at access time. The refresh itself logs its own
    // failures, so a rejection here is safe to drop.
    void import('../im/lark/client.js')
      .then(m => m.getChatMode(ds.larkAppId, ds.chatId, { forceRefresh: true }))
      .catch(() => { /* logged inside getChatMode */ });
  }
  return false;
}
