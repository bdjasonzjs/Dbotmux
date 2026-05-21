/**
 * 群内授权持久化：全局 allowedUsers（含 email 形式条目）+ per-chat chatGrants。
 * 写路径走 config-store 的跨进程锁；撤销在单个 RMW 内同删 chat+global（原子）。
 */
import { getBot, getOwnerOpenId } from '../bot-registry.js';
import { rmwBotEntry } from './config-store.js';
import { logger } from '../utils/logger.js';

type Fail = { ok: false; reason: string };

/** 把目标 open_id 映射回 allowedUsers 里的 raw 条目（可能是 email，也可能就是 open_id）。 */
function rawEntryForOpenId(larkAppId: string, openId: string): string | undefined {
  const bot = getBot(larkAppId);
  for (const [raw, resolved] of bot.rawAllowedUserResolution.entries()) {
    if (resolved === openId) return raw;
  }
  // 无解析映射时：raw 里若直接是该 open_id，返回它自身。
  return bot.config.allowedUsers?.includes(openId) ? openId : undefined;
}

/** 移除目标后运行时 open_id 集合（R2#3：按 resolved 判，不看 raw 长度）。 */
function resolvedAfterRemoval(larkAppId: string, openId: string): string[] {
  return getBot(larkAppId).resolvedAllowedUsers.filter(u => u !== openId);
}

export async function addGlobalGrant(
  larkAppId: string, openId: string,
): Promise<{ ok: true; created: boolean } | Fail> {
  let bot; try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  const r = await rmwBotEntry<{ created: boolean }>(larkAppId, (entry) => {
    const cur: string[] = Array.isArray(entry.allowedUsers) ? entry.allowedUsers : [];
    const created = !cur.includes(openId);
    if (created) cur.push(openId);
    entry.allowedUsers = cur;
    return { write: created, result: { created } };
  });
  if (!r.ok) return r;
  if (r.result.created) {
    bot.config.allowedUsers = [...(bot.config.allowedUsers ?? []), openId];
    if (!bot.resolvedAllowedUsers.includes(openId)) bot.resolvedAllowedUsers.push(openId);
    bot.rawAllowedUserResolution.set(openId, openId);
    logger.info(`[grant:${larkAppId}] +global ${openId}`);
  }
  return { ok: true, created: r.result.created };
}

export async function addChatGrant(
  larkAppId: string, chatId: string, openId: string,
): Promise<{ ok: true; created: boolean } | Fail> {
  let bot; try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  const r = await rmwBotEntry<{ created: boolean }>(larkAppId, (entry) => {
    const map = (entry.chatGrants && typeof entry.chatGrants === 'object') ? entry.chatGrants : {};
    const cur: string[] = Array.isArray(map[chatId]) ? map[chatId] : [];
    const created = !cur.includes(openId);
    if (created) cur.push(openId);
    map[chatId] = cur;
    entry.chatGrants = map;
    return { write: created, result: { created } };
  });
  if (!r.ok) return r;
  if (r.result.created) {
    const map = (bot.config.chatGrants ??= {});
    map[chatId] = [...(map[chatId] ?? []), openId];
    logger.info(`[grant:${larkAppId}] +chat ${chatId} ${openId}`);
  }
  return { ok: true, created: r.result.created };
}

/**
 * 原子彻底撤销：同一 RMW 内删 chatGrants[chatId] 与全局 allowedUsers（email 反查）。
 * 三重防开放守卫：
 *   #2  禁止撤销当前 owner 本人（否则 owner 身份会漂移到别人）。
 *   R2#3 移除后运行时 resolvedAllowedUsers 不能变空（catch 未解析 email 导致 resolved 空）。
 *   R3#3 在 RMW 锁内按最新磁盘 entry 再判一次（catch 并发写把 allowlist 删空）。
 */
export async function revokeGrant(
  larkAppId: string, chatId: string, openId: string,
): Promise<{ ok: true; removed: { chat: boolean; global: boolean } } | Fail> {
  let bot; try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  // #2：owner 本人不可撤。
  if (openId === getOwnerOpenId(larkAppId)) return { ok: false, reason: 'would_open_bot' };

  const rawEntry = rawEntryForOpenId(larkAppId, openId); // email / open_id / undefined
  // R2#3：进程内 resolved 视角的早判（含未解析 email 兜底），失败给即时反馈。
  if (rawEntry && resolvedAfterRemoval(larkAppId, openId).length === 0) {
    return { ok: false, reason: 'would_open_bot' };
  }

  type Res = { chat: boolean; global: boolean };
  const r = await rmwBotEntry<Res | { guard: 'would_open_bot' }>(larkAppId, (entry) => {
    const rawList: string[] = Array.isArray(entry.allowedUsers) ? entry.allowedUsers : [];
    const willRemoveGlobal = !!rawEntry && rawList.includes(rawEntry);
    // R3#3：在锁内、对最新磁盘快照判定——移除全局会清空 allowlist 则拒绝（防并发删空）。
    if (willRemoveGlobal && rawList.filter(u => u !== rawEntry).length === 0) {
      return { write: false, result: { guard: 'would_open_bot' as const } };
    }
    let chat = false, global = false;
    const map = (entry.chatGrants && typeof entry.chatGrants === 'object') ? entry.chatGrants : {};
    if (Array.isArray(map[chatId]) && map[chatId].includes(openId)) {
      map[chatId] = map[chatId].filter((u: string) => u !== openId);
      if (map[chatId].length === 0) delete map[chatId];
      chat = true;
    }
    entry.chatGrants = map;
    if (willRemoveGlobal) {
      entry.allowedUsers = rawList.filter((u: string) => u !== rawEntry);
      global = true;
    }
    return { write: chat || global, result: { chat, global } };
  });
  if (!r.ok) return r;
  if ('guard' in r.result) return { ok: false, reason: r.result.guard };

  // 同步内存
  if (r.result.chat && bot.config.chatGrants?.[chatId]) {
    bot.config.chatGrants[chatId] = bot.config.chatGrants[chatId].filter(u => u !== openId);
    if (bot.config.chatGrants[chatId].length === 0) delete bot.config.chatGrants[chatId];
  }
  if (r.result.global) {
    if (rawEntry) {
      bot.config.allowedUsers = (bot.config.allowedUsers ?? []).filter(u => u !== rawEntry);
      bot.rawAllowedUserResolution.delete(rawEntry);
    }
    bot.resolvedAllowedUsers = bot.resolvedAllowedUsers.filter(u => u !== openId);
  }
  logger.info(`[grant:${larkAppId}] revoke chat=${chatId} ${openId} removed=${JSON.stringify(r.result)}`);
  return { ok: true, removed: r.result };
}
