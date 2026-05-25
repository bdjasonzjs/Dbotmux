/**
 * MainBotDigest + ScoutInbox stores — L2 缇蕾 scout outputs.
 *
 * Layout (both global, in `${config.session.dataDir}/`):
 *   - `main-bot-digest.json` — overwritten each scout tick.
 *   - `scout-inbox.json` — append pending items, mutate status in-place.
 *
 * Atomic writes via tmp + rename (same pattern as session-store / chat-
 * context-store). Stale detection (digest "fresh" / "stale") uses a
 * sidecar marker file so onMessage hooks can flag staleness cheaply
 * without writing the whole digest.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

export type Heat = 'hot' | 'warm' | 'cold';
export type EscalationRuleId = 'R1' | 'R2' | 'R3' | 'R4' | 'R5';

export interface MainBotDigestChat {
  chatId: string;
  name: string;
  heat: Heat;
  oneLineStatus: string;
  needsAttention: boolean;
}

export interface CrossChatThread {
  theme: string;
  chatIds: string[];
  summary: string;
}

export interface PendingForJason {
  chatId: string;
  messageId: string;
  sender: string;
  request: string;
  sinceMinutes: number;
}

export interface Escalation {
  ruleId: EscalationRuleId;
  triggeredAt: string;
  chatId: string;
  context: string;
  payload: unknown;
}

export interface MainBotDigest {
  generatedAt: string;
  chats: MainBotDigestChat[];
  crossChatThreads: CrossChatThread[];
  pendingForJason: PendingForJason[];
  escalations: Escalation[];
}

/** 2026-05-25 Phase A v2 (松松/妹妹 review): ScoutInboxItem 改为
 *  discriminated union 兼容旧 escalation + 新 tilly_digest_high。
 *  无 `type` 字段的老数据由 normalizeInbox() 在 read 时补成 'escalation'。 */
export type ScoutInboxItem = ScoutEscalationItem | ScoutTillyHighItem;

export interface ScoutEscalationItem {
  type: 'escalation';
  id: string;
  enqueuedAt: string;
  escalation: Escalation;
  status: 'pending' | 'in_progress' | 'resolved' | 'dismissed';
  resolvedBy: string | null;
  resolution: string | null;
}

/** Phase A: 缇蕾本次 tick 发现的 high-prio 新增（high todo 或 blocker），
 *  push 到 inbox 等克劳德处理 (Phase B watcher) 或松松手动 dismiss。
 *  payload 是 TillyDigestItem 完整副本（含 sourceAppLink 等已 enrich 字段）。 */
export interface ScoutTillyHighItem {
  type: 'tilly_digest_high';
  id: string;
  enqueuedAt: string;
  /** category 是哪一类（todo / blocker），决定后续 playbook */
  category: 'todo' | 'blocker';
  /** 整条 TillyDigestItem (含 summary/sourceChatId/sourceMessageId/applink/priority) */
  payload: {
    summary: string;
    sourceChatId: string;
    sourceChatName: string;
    sourceMessageId: string;
    sourceAppLink?: string;
    priority?: 'high' | 'med' | 'low';
  };
  status: 'pending' | 'processed' | 'dismissed';
  /** 通知发送时间戳；null = 还没发（throttle 或失败），后续 tick 可补发 */
  notifiedAt: string | null;
  /** 处理者标识（克劳德 handler session / 松松 manual dismiss / etc） */
  handledBy: string | null;
  /** 处理时间 */
  handledAt: string | null;
  /** 处理说明 (审计用，可为空) */
  resolution: string | null;
}

export interface ScoutInbox {
  pending: ScoutInboxItem[];
  processed: ScoutInboxItem[];
}

// ─── File paths ───────────────────────────────────────────────────────────

const DIGEST_FILE = 'main-bot-digest.json';
const INBOX_FILE = 'scout-inbox.json';
const DIGEST_STALE_MARKER = 'main-bot-digest.stale';

function digestPath(): string { return join(config.session.dataDir, DIGEST_FILE); }
function inboxPath(): string { return join(config.session.dataDir, INBOX_FILE); }
function stalePath(): string { return join(config.session.dataDir, DIGEST_STALE_MARKER); }

function ensureDir(): void {
  const dir = dirname(digestPath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ─── Digest IO ────────────────────────────────────────────────────────────

function emptyDigest(): MainBotDigest {
  return {
    generatedAt: new Date().toISOString(),
    chats: [],
    crossChatThreads: [],
    pendingForJason: [],
    escalations: [],
  };
}

export function readDigest(): MainBotDigest {
  const fp = digestPath();
  if (!existsSync(fp)) return emptyDigest();
  try {
    return JSON.parse(readFileSync(fp, 'utf-8')) as MainBotDigest;
  } catch (err) {
    logger.error(`[main-bot-digest-store] failed to parse ${fp}: ${err}`);
    return emptyDigest();
  }
}

export function writeDigest(digest: MainBotDigest): void {
  ensureDir();
  const fp = digestPath();
  const tmpFp = fp + '.tmp';
  const next: MainBotDigest = { ...digest, generatedAt: new Date().toISOString() };
  writeFileSync(tmpFp, JSON.stringify(next, null, 2), 'utf-8');
  renameSync(tmpFp, fp);
}

// ─── Stale tracking ──────────────────────────────────────────────────────

/** Mark digest as stale. Cheap sidecar file write — called from onMessage
 *  hook, doesn't touch the actual digest file. */
export function markStale(): void {
  ensureDir();
  try {
    writeFileSync(stalePath(), String(Date.now()), 'utf-8');
  } catch (err) {
    logger.warn(`[main-bot-digest-store] markStale failed: ${err}`);
  }
}

/** True iff the digest is stale (sidecar exists or digest is older than
 *  the sidecar). */
export function isStale(): boolean {
  if (!existsSync(stalePath())) return false;
  if (!existsSync(digestPath())) return true;  // sidecar exists, digest doesn't → stale
  try {
    const staleAt = Number(readFileSync(stalePath(), 'utf-8')) || 0;
    const digestAt = statSync(digestPath()).mtimeMs;
    return staleAt > digestAt;
  } catch {
    return true;  // any error → treat as stale (safer)
  }
}

/** Clear the stale marker. Called after writeDigest succeeds. */
export function markFresh(): void {
  try {
    if (existsSync(stalePath())) unlinkSync(stalePath());
  } catch (err) {
    logger.warn(`[main-bot-digest-store] markFresh failed: ${err}`);
  }
}

// ─── Inbox IO ─────────────────────────────────────────────────────────────

function emptyInbox(): ScoutInbox {
  return { pending: [], processed: [] };
}

/** 2026-05-25 Phase A v2 (妹妹 #1 guard): 兼容老 schema 的 normalize。
 *  老 ScoutInboxItem 没有 `type` 字段 — 补成 'escalation'（旧数据全是
 *  R1-R5 escalation, 没有别的）。新写入自然带 type=union 成员。
 *  统一通过 readInbox() 入口走，不需要破坏性迁移脚本。 */
function normalizeInbox(raw: any): ScoutInbox {
  if (!raw || typeof raw !== 'object') return emptyInbox();
  const normalize = (item: any): ScoutInboxItem | null => {
    if (!item || typeof item !== 'object') return null;
    if (item.type === 'tilly_digest_high') return item as ScoutTillyHighItem;
    // type undefined OR 'escalation' → 视为 escalation (兼容旧数据)
    return {
      type: 'escalation' as const,
      id: item.id,
      enqueuedAt: item.enqueuedAt,
      escalation: item.escalation,
      status: item.status ?? 'pending',
      resolvedBy: item.resolvedBy ?? null,
      resolution: item.resolution ?? null,
    };
  };
  return {
    pending: (raw.pending ?? []).map(normalize).filter((x: any): x is ScoutInboxItem => x !== null),
    processed: (raw.processed ?? []).map(normalize).filter((x: any): x is ScoutInboxItem => x !== null),
  };
}

export function readInbox(): ScoutInbox {
  const fp = inboxPath();
  if (!existsSync(fp)) return emptyInbox();
  try {
    return normalizeInbox(JSON.parse(readFileSync(fp, 'utf-8')));
  } catch (err) {
    logger.error(`[main-bot-digest-store] failed to parse ${fp}: ${err}`);
    return emptyInbox();
  }
}

export function writeInbox(inbox: ScoutInbox): void {
  ensureDir();
  const fp = inboxPath();
  const tmpFp = fp + '.tmp';
  writeFileSync(tmpFp, JSON.stringify(inbox, null, 2), 'utf-8');
  renameSync(tmpFp, fp);
}

/** Push a new escalation to the inbox. Returns the created item. */
export function enqueueEscalation(escalation: Escalation): ScoutEscalationItem {
  const item: ScoutEscalationItem = {
    type: 'escalation',
    id: randomUUID(),
    enqueuedAt: new Date().toISOString(),
    escalation,
    status: 'pending',
    resolvedBy: null,
    resolution: null,
  };
  const inbox = readInbox();
  inbox.pending.push(item);
  writeInbox(inbox);
  return item;
}

/** 2026-05-25 Phase A v2: push 缇蕾本次 tick 发现的 high-prio item。
 *  dedup by sourceMessageId 跨 pending + processed 全状态（妹妹 #2 ack:
 *  dismissed 也算 sink，永久不重新入）。
 *  Returns: { item, inserted: true } 新插入 | { item, inserted: false } 已存在 */
export function enqueueTillyDigestHigh(opts: {
  category: 'todo' | 'blocker';
  payload: ScoutTillyHighItem['payload'];
}): { item: ScoutTillyHighItem; inserted: boolean } {
  const inbox = readInbox();
  // Dedup: 跨 pending + processed 全部状态匹配 sourceMessageId + category
  const existing = [...inbox.pending, ...inbox.processed].find(
    it => it.type === 'tilly_digest_high'
       && (it as ScoutTillyHighItem).payload.sourceMessageId === opts.payload.sourceMessageId
       && (it as ScoutTillyHighItem).category === opts.category,
  ) as ScoutTillyHighItem | undefined;
  if (existing) return { item: existing, inserted: false };
  const item: ScoutTillyHighItem = {
    type: 'tilly_digest_high',
    id: randomUUID(),
    enqueuedAt: new Date().toISOString(),
    category: opts.category,
    payload: opts.payload,
    status: 'pending',
    notifiedAt: null,
    handledBy: null,
    handledAt: null,
    resolution: null,
  };
  inbox.pending.push(item);
  writeInbox(inbox);
  return { item, inserted: true };
}

/** 2026-05-25 Phase A v2: 标 tilly_digest_high 已通知 — 让下次 tick 跳过
 *  notify（防 throttle 误吞：通知失败/throttle 时不设 notifiedAt，下次
 *  tick 看到 unnotified 的 high-prio item 会补发）。Escalation item 不动。 */
export function markTillyHighNotified(itemId: string): ScoutTillyHighItem | null {
  const inbox = readInbox();
  const item = inbox.pending.find(i => i.id === itemId && i.type === 'tilly_digest_high') as ScoutTillyHighItem | undefined;
  if (!item) return null;
  item.notifiedAt = new Date().toISOString();
  writeInbox(inbox);
  return item;
}

/** 2026-05-25 Phase A v2: 用户/克劳德标 tilly_digest_high 处理完，
 *  从 pending 挪到 processed 保留审计。仅作用于 tilly_digest_high；
 *  escalation 用 markResolved 老路。 */
export function dispositionTillyHigh(itemId: string, opts: {
  status: 'processed' | 'dismissed';
  handledBy: string;
  resolution?: string;
}): ScoutTillyHighItem | null {
  const inbox = readInbox();
  const idx = inbox.pending.findIndex(i => i.id === itemId && i.type === 'tilly_digest_high');
  if (idx < 0) return null;
  const item = inbox.pending[idx] as ScoutTillyHighItem;
  item.status = opts.status;
  item.handledBy = opts.handledBy;
  item.handledAt = new Date().toISOString();
  item.resolution = opts.resolution ?? null;
  inbox.pending.splice(idx, 1);
  inbox.processed.push(item);
  writeInbox(inbox);
  return item;
}

/** List pending tilly_digest_high items not yet notified (for补发 in next tick). */
export function listUnnotifiedTillyHigh(): ScoutTillyHighItem[] {
  return readInbox().pending.filter(
    (i): i is ScoutTillyHighItem => i.type === 'tilly_digest_high' && i.notifiedAt === null,
  );
}

/** Mark a pending escalation item as in_progress. Returns the updated item,
 *  or null if not found / not pending / wrong type (tilly_digest_high item
 *  doesn't have 'in_progress' state — Phase A 妹妹 guard #1). */
export function markInProgress(itemId: string): ScoutEscalationItem | null {
  const inbox = readInbox();
  const item = inbox.pending.find(i => i.id === itemId);
  if (!item || item.type !== 'escalation' || item.status !== 'pending') return null;
  item.status = 'in_progress';
  writeInbox(inbox);
  return item;
}

/** Mark an escalation item as resolved + move to `processed`. */
export function markResolved(itemId: string, resolvedBy: string, resolution: string): ScoutEscalationItem | null {
  const inbox = readInbox();
  const idx = inbox.pending.findIndex(i => i.id === itemId && i.type === 'escalation');
  if (idx < 0) return null;
  const item = inbox.pending[idx] as ScoutEscalationItem;
  item.status = 'resolved';
  item.resolvedBy = resolvedBy;
  item.resolution = resolution;
  inbox.pending.splice(idx, 1);
  inbox.processed.push(item);
  writeInbox(inbox);
  return item;
}
