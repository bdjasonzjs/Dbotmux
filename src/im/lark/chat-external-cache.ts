/**
 * Process-wide memo of Lark chat.get's `external` flag (是否是外部群 — a
 * cross-tenant chat), keyed by (larkAppId, chatId).
 *
 * Deliberately a dependency-free leaf module: it is read on every session-card
 * render (see core/external-chat.ts) from worker-pool / card-handler / daemon,
 * and keeping it out of client.ts means the many tests that fully mock
 * client.js don't need to know about it. client.ts writes into it whenever it
 * parses a chat.get payload. A chat's tenant never flips, so entries have no
 * TTL; the map is bounded only by the number of distinct chats seen.
 */
const chatExternalCache = new Map<string, boolean>();

const key = (larkAppId: string, chatId: string) => `${larkAppId}::${chatId}`;

/** Record the `external` flag as seen on a chat.get payload. */
export function setChatExternal(larkAppId: string, chatId: string, external: boolean): void {
  chatExternalCache.set(key(larkAppId, chatId), external);
}

/**
 * Whether the chat is external (外部群), as last seen on Lark chat.get.
 * `undefined` when this daemon has never parsed a chat.get for it — callers
 * must treat that as "unknown", not "internal".
 */
export function getCachedChatExternal(larkAppId: string, chatId: string): boolean | undefined {
  return chatExternalCache.get(key(larkAppId, chatId));
}

/** Test helper. */
export function _resetChatExternalCacheForTests(): void {
  chatExternalCache.clear();
}
