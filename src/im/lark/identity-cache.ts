/**
 * User / bot identity cache for prompt injection.
 *
 * Lark events only carry the sender's open_id (no name). To inject a
 * `<sender name="张三" ... />` tag into the CLI prompt we need a name → open_id
 * dictionary. Three population sources, ordered by cost:
 *
 *   1. mentions — free. Lark mention payloads carry (name, open_id) pairs,
 *      so every @ that flows through us teaches the cache.
 *   2. sender — free, but only learns open_id + type, not name.
 *   3. contact API — `contact.v3.user.get` for users; only used as fallback
 *      when 1+2 didn't give us a name. Requires `contact:user.base:readonly`
 *      (already in `BOTMUX_REQUIRED_SCOPES`).
 *
 * Scope: per Lark app. Open_id values are app-scoped on Lark's side, so the
 * cache file follows the same `identities-${larkAppId}.json` shape as the
 * existing `bot-openids-${larkAppId}.json`. The two files are deliberately
 * kept separate: bot-openids doubles as a "trusted botmux peer" routing
 * signal, and merging would entangle that with the display-name dictionary.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getBotClient } from '../../bot-registry.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';

export type IdentityType = 'user' | 'bot' | 'app' | 'unknown';

export interface IdentityRecord {
  openId: string;
  type: IdentityType;
  name?: string;
  email?: string;
  source: 'sender' | 'mention' | 'contact_api' | 'bot_cross_ref' | 'bot_info';
  updatedAt: number;
}

const stores = new Map<string, Map<string, IdentityRecord>>();
const inflight = new Map<string, Promise<void>>();
const scopeUnavailable = new Set<string>();
const dirty = new Set<string>();
let flushTimer: NodeJS.Timeout | null = null;

const FLUSH_DEBOUNCE_MS = 2_000;
const RESOLVE_BUDGET_MS = 800;

function cacheFile(larkAppId: string): string {
  return join(config.session.dataDir, `identities-${larkAppId}.json`);
}

function getStore(larkAppId: string): Map<string, IdentityRecord> {
  let store = stores.get(larkAppId);
  if (store) return store;
  store = new Map();
  stores.set(larkAppId, store);
  try {
    const fp = cacheFile(larkAppId);
    if (existsSync(fp)) {
      const data: IdentityRecord[] = JSON.parse(readFileSync(fp, 'utf-8'));
      let n = 0;
      for (const rec of data) {
        if (rec?.openId) {
          store.set(rec.openId, rec);
          n++;
        }
      }
      if (n > 0) logger.info(`[identity] hydrated ${n} records for ${larkAppId} from ${fp}`);
    }
  } catch (err: any) {
    logger.warn(`[identity] failed to hydrate ${larkAppId}: ${err?.message ?? err}`);
  }
  return store;
}

function schedulePersist(larkAppId: string): void {
  dirty.add(larkAppId);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushAll();
  }, FLUSH_DEBOUNCE_MS);
}

function flushAll(): void {
  const appIds = [...dirty];
  dirty.clear();
  for (const appId of appIds) {
    const store = stores.get(appId);
    if (!store) continue;
    try {
      const fp = cacheFile(appId);
      mkdirSync(dirname(fp), { recursive: true });
      const tmp = `${fp}.tmp`;
      writeFileSync(tmp, JSON.stringify([...store.values()], null, 2) + '\n');
      renameSync(tmp, fp);
    } catch (err: any) {
      logger.warn(`[identity] flush ${appId} failed: ${err?.message ?? err}`);
    }
  }
}

/** Best-effort flush on shutdown — pairs with the debounce above. */
export function flushIdentityCacheSync(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushAll();
}

/**
 * Merge a partial identity record into the cache. Existing `name` is preserved
 * unless the incoming record carries a real name (no clobbering). Existing
 * `type` is only overridden when the incoming value is more specific
 * (anything other than `unknown`).
 */
export function recordIdentity(
  larkAppId: string,
  rec: { openId: string; type?: IdentityType; name?: string; email?: string; source?: IdentityRecord['source'] },
): void {
  if (!rec.openId) return;
  const store = getStore(larkAppId);
  const existing = store.get(rec.openId);
  const incomingType = rec.type && rec.type !== 'unknown' ? rec.type : undefined;
  const merged: IdentityRecord = {
    openId: rec.openId,
    type: incomingType ?? existing?.type ?? 'unknown',
    name: rec.name ?? existing?.name,
    email: rec.email ?? existing?.email,
    source: rec.source ?? existing?.source ?? 'sender',
    updatedAt: Date.now(),
  };
  // Skip persist when nothing meaningful changed — avoids disk churn from
  // every sender event re-bumping updatedAt.
  if (existing && existing.type === merged.type && existing.name === merged.name && existing.email === merged.email) {
    return;
  }
  store.set(rec.openId, merged);
  schedulePersist(larkAppId);
}

/**
 * Learn (open_id, name) pairs from a parsed message's mentions. Free path —
 * no API call. Mentions don't carry sender_type, so we leave `type` as
 * `unknown` and let a subsequent sender event (or bot cross-ref lookup) tighten
 * it.
 */
export function learnFromMentions(
  larkAppId: string,
  mentions?: Array<{ name: string; openId?: string }>,
): void {
  if (!mentions || mentions.length === 0) return;
  for (const m of mentions) {
    if (!m.openId || !m.name) continue;
    recordIdentity(larkAppId, { openId: m.openId, name: m.name, source: 'mention' });
  }
}

export function getIdentity(larkAppId: string, openId: string): IdentityRecord | undefined {
  return getStore(larkAppId).get(openId);
}

async function refreshUserIdentity(larkAppId: string, openId: string): Promise<IdentityRecord | undefined> {
  const cached = getIdentity(larkAppId, openId);
  if (cached?.type === 'bot' || cached?.type === 'app') return cached;
  if (scopeUnavailable.has(larkAppId)) return cached;

  const key = `${larkAppId}:${openId}`;
  let pending = inflight.get(key);
  if (!pending) {
    pending = fetchUserName(larkAppId, openId);
    inflight.set(key, pending);
    // Identity-guarded cleanup. A request that times out is evicted by the
    // catch below; if its underlying fetch later settles, we must NOT clobber
    // whatever inflight entry now lives there — that entry belongs to a
    // newer caller. Comparing by reference catches both this race and the
    // simple "settled normally" case.
    //
    // `.then(cleanup, cleanup)` (not `.finally`) so a future fetchUserName
    // refactor that rejects can't leave the returned cleanup promise as an
    // unhandled rejection. Current fetchUserName swallows everything to
    // logger.debug, but that's an undocumented invariant we shouldn't rely on.
    const local = pending;
    const cleanup = () => { if (inflight.get(key) === local) inflight.delete(key); };
    void local.then(cleanup, cleanup);
  }

  try {
    await withTimeout(pending, RESOLVE_BUDGET_MS);
  } catch {
    // withTimeout rejected → either the budget elapsed or the underlying
    // request errored. If the Lark SDK call hangs forever (no built-in
    // request timeout) the cleanup wired via local.then(...) above never
    // fires, and every subsequent caller would re-wait the full budget.
    // Evict here so the next caller starts a fresh attempt. Same identity
    // guard: only evict if the entry still IS our promise — otherwise we'd
    // race-clobber a newer caller's entry that arrived between our await
    // rejection and this line.
    if (inflight.get(key) === pending) inflight.delete(key);
  }
  return getIdentity(larkAppId, openId);
}

/**
 * Best-effort name resolution. Returns the cached name on hit; on miss for a
 * user open_id, calls `contact.v3.user.get` with a budget and updates the
 * cache. Bots/apps skip the API (no public contact endpoint). Failures
 * (permission denied, network, timeout) degrade silently to `undefined`.
 *
 * When the bot lacks `contact:user.base:readonly`, the first 99991672 from
 * the API trips a per-app circuit breaker so subsequent calls short-circuit
 * without burning quota.
 */
export async function resolveName(larkAppId: string, openId: string): Promise<string | undefined> {
  if (!openId) return undefined;
  const cached = getIdentity(larkAppId, openId);
  if (cached?.name) return cached.name;
  if (cached?.type === 'bot' || cached?.type === 'app') return undefined;
  return (await refreshUserIdentity(larkAppId, openId))?.name;
}

async function fetchUserName(larkAppId: string, openId: string): Promise<void> {
  try {
    const c = getBotClient(larkAppId);
    const res = await (c as any).contact.v3.user.get({
      path: { user_id: openId },
      params: { user_id_type: 'open_id' },
    });
    if (res?.code === 0) {
      const user = res.data?.user ?? {};
      const name: string | undefined = user.name;
      const email: string | undefined = user.email;
      if (name || email) {
        recordIdentity(larkAppId, { openId, name, email, type: 'user', source: 'contact_api' });
      }
      return;
    }
    // 99991672 = app身份缺权限 (contact:user.base:readonly 没开)
    if (res?.code === 99991672) {
      if (!scopeUnavailable.has(larkAppId)) {
        scopeUnavailable.add(larkAppId);
        logger.warn(
          `[identity] [${larkAppId}] contact:user.base:readonly 未开通，sender name 解析将降级到 open_id (code=99991672)`,
        );
      }
      return;
    }
    logger.debug(
      `[identity] contact.user.get(${openId.substring(0, 12)}) code=${res?.code} msg=${res?.msg ?? ''}`,
    );
  } catch (err: any) {
    logger.debug(
      `[identity] contact.user.get(${openId.substring(0, 12)}) failed: ${err?.message ?? err}`,
    );
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('identity-resolve-timeout')), ms);
    p.then(
      v => { clearTimeout(t); resolve(v); },
      e => { clearTimeout(t); reject(e); },
    );
  });
}

export interface ResolvedSender {
  openId: string;
  type: 'user' | 'bot';
  name?: string;
  email?: string;
  /**
   * 本条发言人相对本 bot 的身份分类（file 模式下每轮兜底：即使不读身份文件，也一眼知道
   * 跟自己说话的是不是项目主人 / bot / 外人 —— 决定能否听其写操作、用什么口吻）。
   *  - 'owner'    ：可**确证**是项目主人（open_id === 本 app 视角已知 owner）
   *  - 'bot'      ：发言人是一个 bot（只证明是机器人，不代表可信队友）
   *  - 'external' ：可**确证**的其他真人（已知 owner 且 ≠ 发言人）
   *  - undefined  ：owner 无法确证时**不猜**（绝不把未知者误标成 external / owner）
   * open_id 是 app-scoped，故 owner 判定必须同 app 视角比对（见 classifySenderRole）。
   */
  role?: 'owner' | 'bot' | 'external';
}

/**
 * 发言人身份分类（纯函数，便于全边界测试）。**per-chat 模型**（2026-07-26 邹劲松指出：角色是每个
 * 聊天各自的事、不该只有全局）：owner 判定用**本会话的 ownerOpenId**（= 这个聊天的发起人/主人）。
 *  - 该值由 daemon 从**本聊天的消息事件**里取，天然是该聊天所在 app 视角、app-scoped 一致——
 *    因此在 Claude/Codex/Coco 任一 bot 下都能正确认出 owner，**无需任何全局多 app 映射**。
 * 不变式：owner 不可知（chatOwnerOpenId 缺）→ undefined，绝不据此把真人误标 external。
 */
export function classifySenderRole(args: {
  senderType: 'user' | 'bot';
  senderOpenId: string;
  /** 本会话 ownerOpenId（发起人/主人）；缺失（无会话/未知）→ 不产出 owner/external，只 undefined。 */
  chatOwnerOpenId?: string;
}): ResolvedSender['role'] {
  if (args.senderType === 'bot') return 'bot';
  if (!args.chatOwnerOpenId) return undefined; // 本会话 owner 未知 → 不猜
  return args.senderOpenId === args.chatOwnerOpenId ? 'owner' : 'external';
}

/**
 * Resolve sender identity for prompt injection.
 *
 * Inputs are taken directly from the Lark event (`sender_id.open_id`,
 * `sender_type` ∈ {user, app, bot}). We normalize Lark's `app`/`bot` to our
 * prompt vocabulary (`bot`), record the sender event in the cache for future
 * lookups, and best-effort resolve the display name. Caller-supplied hints
 * (e.g. a known foreign-bot display name from `bot-openids-${appId}.json`)
 * win over cache.
 */
export async function resolveSender(
  larkAppId: string,
  openId: string | undefined,
  senderType: string | undefined,
  hint?: { name?: string; type?: 'user' | 'bot' },
  /** 本会话 ownerOpenId（发起人）——per-chat owner 判定，见 classifySenderRole。调用方从
   *  DaemonSession.ownerOpenId 传入（它取自本聊天事件、天然同 app 视角）。 */
  chatOwnerOpenId?: string,
): Promise<ResolvedSender | undefined> {
  if (!openId) return undefined;

  let type: 'user' | 'bot';
  if (hint?.type) {
    type = hint.type;
  } else if (senderType === 'app' || senderType === 'bot') {
    type = 'bot';
  } else {
    type = 'user';
  }

  recordIdentity(larkAppId, { openId, type, source: 'sender' });

  const cached = getIdentity(larkAppId, openId);
  let name = hint?.name ?? cached?.name;
  let email = cached?.email;
  if ((!name || !email) && type === 'user') {
    const resolved = await refreshUserIdentity(larkAppId, openId);
    name = name ?? resolved?.name;
    email = resolved?.email;
  }
  // 身份分类（per-chat）：owner = 本会话发起人（chatOwnerOpenId，取自本聊天 app 视角）。
  // 任何失败都不阻塞发消息。
  let role: ResolvedSender['role'];
  try {
    role = classifySenderRole({ senderType: type, senderOpenId: openId, chatOwnerOpenId });
  } catch { role = undefined; }
  return { openId, type, name, email, role };
}
