/**
 * P3 commit #2 — tilly-scout: fetch 松松 user-identity 视角的最近消息。
 *
 * 调用 `lark-cli im +messages-search --as user` 拉松松所有参与 chat 在
 * [start, end) 内的消息，过滤已扫过的 (tilly-message-store)，按 chat
 * 分组返回。
 *
 * 不在此处分析消息（commit #3 缇蕾 LLM 才做）；不在此处 push 卡片
 * (commit #4 publisher + cron 串起)。本 commit 只暴露 raw fetch + dedup
 * 数据管道。
 *
 * 设计要点：
 *   - 用 `--page-all` 让 lark-cli 自动翻页（一次 tick 15min 窗口预期
 *     最多几百条消息，远低于翻页上限）
 *   - 失败 (lark API 错 / token expire / 进程退码非 0) → 抛错给 caller
 *     决定（caller = daemon cron，会 log + skip this tick）
 *   - 过滤 sender 自身的消息（避免分析自己发的卡片噪音）— **不**过滤，
 *     由 commit #3 prompt 决定要不要看自己消息（有时候自己消息含
 *     "我要做 X" 这类 self-todo）
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { filterUnscanned } from './tilly-message-store.js';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

/** Normalized message shape consumed by缇蕾 prompt. Subset of lark API
 *  shape — strips internals we don't need. */
export interface TillyMessage {
  messageId: string;
  chatId: string;
  chatName: string;
  chatType: string;        // 'group' | 'p2p' | ...
  senderId: string;
  senderType: string;      // 'user' | 'app' | 'bot'
  msgType: string;         // 'text' | 'post' | 'interactive' | ...
  content: string;         // raw content (caller may need to extract text)
  createTime: string;
  threadId?: string;
  appLink?: string;
}

export interface FetchOpts {
  /** Window start (inclusive). */
  start: Date;
  /** Window end (exclusive). */
  end: Date;
  /** Exclude these chatIds (e.g. noise chats user doesn't want tracked). */
  excludeChatIds?: string[];
  /** Optional override of lark-cli path (for testing). */
  larkCliPath?: string;
  /** P0-1 privacy (2026-05-25): 显式 allowlist 模式 — 仅扫这些 chatId。
   *  非空时优先于 excludeChatIds + includeP2P，其他全部排除。
   *  通常通过 env BOTMUX_TILLY_ALLOWLIST_CHATS 设置。 */
  allowlistChatIds?: string[];
  /** P0-1: 是否包含 p2p (1:1 私聊)。默认 false（敏感内容不进 LLM）。
   *  env BOTMUX_TILLY_INCLUDE_P2P=1 显式打开。 */
  includeP2P?: boolean;
  /** v2.1 (2026-05-26 松松/妹妹 P0): chatId+senderId 双维 bot allowlist —
   *  默认所有 bot/app 消息 drop（断 self-reference loop）。仅显式列出的
   *  bot 在指定 chat 下能通过。每项格式：
   *  - "chatId:senderId" 严格组合
   *  - "*:senderId" 该 bot 跨所有 chat
   *  - "chatId:*" 该 chat 所有 bot
   *  env: BOTMUX_TILLY_INCLUDE_BOT_SENDERS=chat1:bot1,chat2:*,*:bot3 */
  includeBotSenders?: string[];
  /** v2.1 debug only: 全允许 bot sender（不进 daemon 默认，仅人工 debug
   *  时用）。默认 false。 */
  includeAllBotSenders?: boolean;
}

/** P0-1 (2026-05-25 妹妹 P0): 从 env 读 privacy 默认值。
 *  - BOTMUX_TILLY_ALLOWLIST_CHATS=oc_a,oc_b → 只扫这些
 *  - BOTMUX_TILLY_INCLUDE_P2P=1 → 显式打开 p2p 扫描
 *  v2.1 (2026-05-26): + BOTMUX_TILLY_INCLUDE_BOT_SENDERS 双维 bot allowlist
 *  caller (daemon cron) 不传 opts 时这些 env 生效。 */
function loadPrivacyDefaults(): {
  allowlist: string[];
  includeP2P: boolean;
  includeBotSenders: string[];
} {
  const allowlistRaw = process.env.BOTMUX_TILLY_ALLOWLIST_CHATS?.trim();
  const allowlist = allowlistRaw ? allowlistRaw.split(/[,\s]+/).filter(Boolean) : [];
  const includeP2P = process.env.BOTMUX_TILLY_INCLUDE_P2P === '1';
  const botSendersRaw = process.env.BOTMUX_TILLY_INCLUDE_BOT_SENDERS?.trim();
  const includeBotSenders = botSendersRaw ? botSendersRaw.split(/[,\s]+/).filter(Boolean) : [];
  return { allowlist, includeP2P, includeBotSenders };
}

/** v2.1 (2026-05-26 妹妹): 判断 (chatId, senderId) 是否在 bot allowlist。
 *  rules: 三种格式
 *  - "chatId:senderId" — 严格组合
 *  - "*:senderId"      — 该 bot 跨所有 chat
 *  - "chatId:*"        — 该 chat 所有 bot
 *  注: bot/app/cli_xxx 发的消息默认被 drop；只有命中此处规则才放行。
 *  目的是断 self-reference loop（缇蕾扫到自己 + 主 bot 发的 notify 文本
 *  让 LLM 二次归类成 meta blocker → 又 push 又 notify）。bot 进展通报
 *  走 P2 RootInbox / progress-report 主链路，不靠缇蕾扫 bot 输出 LLM。 */
function isBotSenderAllowed(chatId: string, senderId: string, rules: string[]): boolean {
  for (const r of rules) {
    const [c, s] = r.split(':');
    if (!c || !s) continue;
    const chatOk = c === '*' || c === chatId;
    const senderOk = s === '*' || s === senderId;
    if (chatOk && senderOk) return true;
  }
  return false;
}

interface LarkMessagesSearchResp {
  ok: boolean;
  data?: {
    messages?: any[];
    total?: number;
    has_more?: boolean;
    page_token?: string;
  };
  error?: string;
}

function toISO8601(d: Date): string {
  // lark-cli accepts ISO 8601 with timezone, e.g. 2026-03-24T00:00:00+08:00
  // We send UTC explicitly to avoid local-tz confusion.
  return d.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

function normalizeMessage(raw: any): TillyMessage | null {
  if (!raw || typeof raw !== 'object' || !raw.message_id) return null;
  return {
    messageId: raw.message_id,
    chatId: raw.chat_id ?? '',
    chatName: raw.chat_name ?? '',
    chatType: raw.chat_type ?? '',
    senderId: raw.sender?.id ?? '',
    senderType: raw.sender?.sender_type ?? '',
    msgType: raw.msg_type ?? '',
    content: typeof raw.content === 'string' ? raw.content : JSON.stringify(raw.content ?? ''),
    createTime: raw.create_time ?? '',
    threadId: raw.thread_id || undefined,
    appLink: raw.message_app_link || undefined,
  };
}

/**
 * Fetch new (unscanned) messages in [start, end) using lark-cli user
 * identity. Returns the dedup-filtered list, NOT yet marked as scanned
 * (caller marks after processing).
 *
 * Throws if lark-cli exit code is non-zero or stdout is unparseable
 * — caller (daemon cron) catches + skips this tick.
 */
export async function fetchRecentMessages(opts: FetchOpts): Promise<TillyMessage[]> {
  const cli = opts.larkCliPath ?? 'lark-cli';
  const args = [
    'im', '+messages-search',
    '--as', 'user',
    '--start', toISO8601(opts.start),
    '--end', toISO8601(opts.end),
    '--page-all',
    '--page-size', '50',
    '--format', 'json',
  ];
  let stdout: string;
  try {
    // P3-rev1 #6: 60s timeout so a stuck lark-cli can't pile up tick
    // overlaps (cron is 15min; 60s gives lots of room for normal calls
    // including pagination, but kills truly hung subprocess).
    const r = await execFileAsync(cli, args, { maxBuffer: 50 * 1024 * 1024, timeout: 60_000 });
    stdout = r.stdout;
  } catch (err: any) {
    throw new Error(`[tilly-scout] lark-cli exec failed: ${err?.message ?? err}`);
  }
  // lark-cli prints a [WARN] proxy line to stderr; stdout should be pure JSON.
  // But --page-all might emit multiple JSON blobs concatenated; handle both.
  const messages: TillyMessage[] = [];
  // Try single JSON first
  try {
    const resp = JSON.parse(stdout) as LarkMessagesSearchResp;
    if (resp.data?.messages) {
      for (const m of resp.data.messages) {
        const n = normalizeMessage(m);
        if (n) messages.push(n);
      }
    }
  } catch {
    // Multi-blob fallback: split by trailing }\n{ and parse each
    const blobs = stdout.split(/\}\s*\n\s*\{/).map((blob, i, arr) => {
      if (arr.length === 1) return blob;
      if (i === 0) return blob + '}';
      if (i === arr.length - 1) return '{' + blob;
      return '{' + blob + '}';
    });
    for (const blob of blobs) {
      try {
        const resp = JSON.parse(blob) as LarkMessagesSearchResp;
        for (const m of resp.data?.messages ?? []) {
          const n = normalizeMessage(m);
          if (n) messages.push(n);
        }
      } catch (err) {
        logger.warn(`[tilly-scout] failed to parse one JSON blob: ${err}`);
      }
    }
  }

  // P0-1 (2026-05-25): privacy filter — 默认排除 p2p，可 env override。
  // 顺序：
  //   1. allowlist (非空时只保留这些 chatId) — 显式 opt-in，最强语义
  //   2. p2p 过滤（仅当 allowlist 命中 OR includeP2P=true 时跳过）
  //   3. excludeChatIds 排除
  // 2026-05-25 妹妹 non-blocker 1: allowlist 命中的 p2p 不再被 p2p gate
  // 丢掉 — 用户显式 allow 这条 chat = 知情同意，包含 p2p 也 ok。
  const envDefaults = loadPrivacyDefaults();
  const allowlist = opts.allowlistChatIds ?? envDefaults.allowlist;
  const allowlistSet = new Set(allowlist);
  const includeP2P = opts.includeP2P ?? envDefaults.includeP2P;
  const includeBotSenders = opts.includeBotSenders ?? envDefaults.includeBotSenders;
  const includeAllBotSenders = opts.includeAllBotSenders === true;
  const excludeSet = new Set(opts.excludeChatIds ?? []);
  let inScope = messages;
  let droppedAllowlist = 0;
  let droppedP2P = 0;
  let droppedExclude = 0;
  let droppedBot = 0;
  if (allowlistSet.size > 0) {
    inScope = inScope.filter(m => {
      if (allowlistSet.has(m.chatId)) return true;
      droppedAllowlist++;
      return false;
    });
  }
  if (!includeP2P) {
    inScope = inScope.filter(m => {
      // 允许 allowlist 命中的 p2p 通过（显式同意）
      if (m.chatType !== 'p2p' || allowlistSet.has(m.chatId)) return true;
      droppedP2P++;
      return false;
    });
  }
  // v2.1 (2026-05-26 松松/妹妹 P0): bot-sender 双维 allowlist 过滤。
  // 默认所有 sender_type='app'/'bot' 或 senderId 以 'cli_' 开头的消息
  // drop（断 self-reference loop：缇蕾扫到自己/主 bot 发的 notify 文本
  // 让 LLM 二次归类成 meta blocker → 又 push 又 notify）。
  // 仅当 isBotSenderAllowed(chatId, senderId, rules) 命中才放行。
  if (!includeAllBotSenders) {
    inScope = inScope.filter(m => {
      const isBot = m.senderType === 'app' || m.senderType === 'bot' || m.senderId.startsWith('cli_');
      if (!isBot) return true;
      if (isBotSenderAllowed(m.chatId, m.senderId, includeBotSenders)) return true;
      droppedBot++;
      return false;
    });
  }
  if (excludeSet.size > 0) {
    inScope = inScope.filter(m => {
      if (!excludeSet.has(m.chatId)) return true;
      droppedExclude++;
      return false;
    });
  }
  if (droppedAllowlist + droppedP2P + droppedExclude + droppedBot > 0) {
    logger.info(`[tilly-scout] privacy filter dropped: allowlist=${droppedAllowlist} p2p=${droppedP2P} bot=${droppedBot} exclude=${droppedExclude} (mode: allowlist=${allowlistSet.size > 0 ? allowlist.join(',') : 'none'}, includeP2P=${includeP2P}, includeBotSenders=${includeBotSenders.length}规则${includeAllBotSenders ? ' [ALL OVERRIDE]' : ''})`);
  }

  // Dedup by tilly-message-store
  const unscannedIds = new Set(filterUnscanned(inScope.map(m => m.messageId)));
  const fresh = inScope.filter(m => unscannedIds.has(m.messageId));

  logger.info(`[tilly-scout] fetched ${messages.length} raw / ${inScope.length} in-scope / ${fresh.length} fresh (start=${toISO8601(opts.start)}, end=${toISO8601(opts.end)})`);
  return fresh;
}

/** Group messages by chatId for per-chat LLM context. */
export function groupByChat(messages: TillyMessage[]): Map<string, TillyMessage[]> {
  const out = new Map<string, TillyMessage[]>();
  for (const m of messages) {
    if (!out.has(m.chatId)) out.set(m.chatId, []);
    out.get(m.chatId)!.push(m);
  }
  // Sort each chat's messages by createTime asc (chronological)
  for (const [_, list] of out) {
    list.sort((a, b) => a.createTime.localeCompare(b.createTime));
  }
  return out;
}
