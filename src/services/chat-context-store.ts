/**
 * Per-chat context store — records "what is this chat for" for the main-bot
 * mode. New chats (especially bot-spawned ones) get a ChatContext written by
 * the onChatCreated hook; bot sessions spawning in that chat then read this
 * context and inject it into the system prompt so they don't start as a
 * blank slate.
 *
 * Layout: ${config.session.dataDir}/chat-contexts/<chatId>.json — one file
 * per chat, **global** (not per-bot app id), shared across all daemons.
 * Writes are atomic (tmp file + rename) and per-file (no shared in-memory
 * cache), so cross-daemon writes don't conflict — the file is the source
 * of truth.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/** Provenance of a chat — decides whether it enters the main-bot topology
 *  tree. Only `bot_spawned` chats get parent-child edges; `p2p` and
 *  `human_created` are surfaced in a sidebar instead. */
export type OriginType = 'p2p' | 'human_created' | 'bot_spawned';

/** When to dispatch the context card after chat creation. */
export type InjectionPolicy = 'eager' | 'on_first_mention' | 'manual';

export interface ChatContextParticipant {
  openId: string;
  role: string;
}

export interface ChatContextInherited {
  parentChatId: string;
  /** Summary of the last 24h of relevant discussion in the parent chat. */
  parentDigest: string;
}

/** Lifecycle status — archived chats are hidden from the collaboration
 *  board and skip escalation rule evaluation (R1-R5 / R6). */
export type ChatStatus = 'active' | 'archived';

export interface ChatContext {
  chatId: string;
  /** One-line summary of what this chat is for. */
  purpose: string;
  /** Provenance — determines whether the chat enters the topology tree. */
  originType: OriginType;
  /** Related task / PRD / wiki links. */
  relatedRefs: string[];
  /** Key participants (humans + bots). */
  participants: ChatContextParticipant[];
  /** Where this chat was spawned from (null for non-bot_spawned or
   *  bot-spawned-from-p2p, where the topology tree shouldn't draw an edge). */
  inheritedFrom: ChatContextInherited | null;
  /** References to active todo items in the main todo doc. */
  activeTodoRefs: string[];
  /** Rules / red-lines specific to this chat. */
  rules: string[];
  /** When to dispatch the context card. */
  injectionPolicy: InjectionPolicy;
  /** Lifecycle status. Default 'active' for back-compat with v0.1 files. */
  status?: ChatStatus;
  /** ISO timestamp when archived (null/undefined when status='active'). */
  archivedAt?: string | null;
  /** ISO timestamp of last write (for cache invalidation). */
  updatedAt: string;
}

const CHAT_CONTEXTS_DIR = 'chat-contexts';

/**
 * Lark `chat_id` is `oc_` followed by 32 lowercase hex chars in production
 * (`oc_3dabc5b37bca8301b12783ef684fc4a5`) but we accept any
 * `[A-Za-z0-9_-]{1,128}` to stay tolerant of:
 *   - test fixtures using shorter ids (`oc_new`)
 *   - p2p chats whose dataset is opaque
 *   - any future Lark id-format change as long as it remains
 *     filesystem-safe
 * What we *must* reject: anything that could escape the chat-contexts
 * dir (`/`, `\\`, `..`, `%2F`-decoded slashes, NUL bytes) — those would
 * let an attacker who reaches the archive endpoint write outside the
 * intended directory after the request decoder has un-escaped the path.
 */
const CHAT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Throws if `chatId` could escape the chat-contexts directory. Use at
 *  the public store boundary (every external entry point that turns a
 *  chatId into a filesystem path). */
function assertSafeChatId(chatId: string): void {
  if (typeof chatId !== 'string' || !CHAT_ID_RE.test(chatId)) {
    throw new Error(`[chat-context-store] refusing unsafe chatId: ${JSON.stringify(chatId).slice(0, 80)}`);
  }
}

function dirPath(): string {
  return join(config.session.dataDir, CHAT_CONTEXTS_DIR);
}

function filePath(chatId: string): string {
  assertSafeChatId(chatId);
  return join(dirPath(), chatId + '.json');
}

function ensureDir(): void {
  const dir = dirPath();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export interface CreateOpts {
  purpose: string;
  originType: OriginType;
  /** Source chat for `bot_spawned` chats; null when the source is p2p (we
   *  still record originType='bot_spawned' but don't draw a topology edge). */
  parentChatId: string | null;
  participants: ChatContextParticipant[];
  parentDigest?: string;
  relatedRefs?: string[];
  activeTodoRefs?: string[];
  rules?: string[];
  injectionPolicy?: InjectionPolicy;
}

/**
 * Create a ChatContext file. **Idempotent**: if a context for this chatId
 * already exists, the existing one is returned unchanged. Use `upsert()` to
 * force-overwrite or `update()` to merge.
 *
 * This idempotency matters because both the `im.chat.created` Lark event and
 * the `group-creator.ts` manual-trigger fallback may call `create()` for the
 * same chat — we want the first writer to win, not race.
 */
export function create(chatId: string, opts: CreateOpts): ChatContext {
  const existing = read(chatId);
  if (existing) {
    logger.info(`[chat-context-store] create() skipped — context already exists for chat ${chatId}`);
    return existing;
  }
  const ctx: ChatContext = {
    chatId,
    purpose: opts.purpose,
    originType: opts.originType,
    relatedRefs: opts.relatedRefs ?? [],
    participants: opts.participants,
    inheritedFrom: opts.parentChatId
      ? { parentChatId: opts.parentChatId, parentDigest: opts.parentDigest ?? '' }
      : null,
    activeTodoRefs: opts.activeTodoRefs ?? [],
    rules: opts.rules ?? [],
    injectionPolicy: opts.injectionPolicy ?? 'eager',
    status: 'active',
    archivedAt: null,
    updatedAt: new Date().toISOString(),
  };
  write(ctx);
  return ctx;
}

/** Mark a chat archived. If no ChatContext exists yet (typical for
 *  p2p/human_created chats that never went through onChatCreated), a
 *  minimal stub is created so the archive lifecycle works uniformly across
 *  all chats surfaced in the dashboard topology. */
export function archive(chatId: string): ChatContext {
  let existing = read(chatId);
  if (!existing) {
    existing = create(chatId, {
      purpose: '(archive 时自动创建的占位 context)',
      originType: 'human_created',
      parentChatId: null,
      participants: [],
      injectionPolicy: 'manual',
    });
  }
  if (existing.status === 'archived') return existing;
  return update(chatId, { status: 'archived', archivedAt: new Date().toISOString() })!;
}

/** Mark a chat active (unarchive). Returns null only if no ChatContext
 *  exists; otherwise returns the (possibly already-active) record. */
export function unarchive(chatId: string): ChatContext | null {
  const existing = read(chatId);
  if (!existing) return null;
  if (existing.status !== 'archived') return existing;
  return update(chatId, { status: 'active', archivedAt: null });
}

/** True iff the chat is archived (false for missing context or active). */
export function isArchived(chatId: string): boolean {
  const ctx = read(chatId);
  return !!ctx && ctx.status === 'archived';
}

/** Read the ChatContext for a chat, or null if it doesn't exist. */
export function read(chatId: string): ChatContext | null {
  const fp = filePath(chatId);
  if (!existsSync(fp)) return null;
  try {
    return JSON.parse(readFileSync(fp, 'utf-8')) as ChatContext;
  } catch (err) {
    logger.error(`[chat-context-store] failed to parse ${fp}: ${err}`);
    return null;
  }
}

/** Overwrite the ChatContext for a chat (force-write; bypasses idempotency). */
export function upsert(ctx: ChatContext): void {
  const next: ChatContext = { ...ctx, updatedAt: new Date().toISOString() };
  write(next);
}

/**
 * Patch an existing context with the supplied fields. Returns null if the
 * context doesn't exist (callers should `create()` first). chatId in the
 * patch is ignored.
 */
export function update(chatId: string, patch: Partial<Omit<ChatContext, 'chatId'>>): ChatContext | null {
  const existing = read(chatId);
  if (!existing) return null;
  const merged: ChatContext = {
    ...existing,
    ...patch,
    chatId: existing.chatId,
    updatedAt: new Date().toISOString(),
  };
  write(merged);
  return merged;
}

/** List all chatIds with stored contexts. */
export function listChatIds(): string[] {
  const dir = dirPath();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.slice(0, -5));
}

/** Delete the ChatContext file for a chat. Returns true iff a file was removed. */
export function remove(chatId: string): boolean {
  const fp = filePath(chatId);
  if (!existsSync(fp)) return false;
  try {
    unlinkSync(fp);
    return true;
  } catch (err) {
    logger.error(`[chat-context-store] failed to remove ${fp}: ${err}`);
    return false;
  }
}

function write(ctx: ChatContext): void {
  ensureDir();
  const fp = filePath(ctx.chatId);
  const tmpFp = fp + '.tmp';
  writeFileSync(tmpFp, JSON.stringify(ctx, null, 2), 'utf-8');
  renameSync(tmpFp, fp);
}
