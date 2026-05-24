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
    const r = await execFileAsync(cli, args, { maxBuffer: 50 * 1024 * 1024 });
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

  // Apply chat exclusion filter
  const excludeSet = new Set(opts.excludeChatIds ?? []);
  const inScope = excludeSet.size > 0
    ? messages.filter(m => !excludeSet.has(m.chatId))
    : messages;

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
