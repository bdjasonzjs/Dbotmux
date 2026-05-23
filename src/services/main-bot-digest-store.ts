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

export interface ScoutInboxItem {
  id: string;
  enqueuedAt: string;
  escalation: Escalation;
  status: 'pending' | 'in_progress' | 'resolved' | 'dismissed';
  resolvedBy: string | null;
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

export function readInbox(): ScoutInbox {
  const fp = inboxPath();
  if (!existsSync(fp)) return emptyInbox();
  try {
    return JSON.parse(readFileSync(fp, 'utf-8')) as ScoutInbox;
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
export function enqueueEscalation(escalation: Escalation): ScoutInboxItem {
  const item: ScoutInboxItem = {
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

/** Mark a pending item as in_progress. Returns the updated item, or null
 *  if not found / not pending. */
export function markInProgress(itemId: string): ScoutInboxItem | null {
  const inbox = readInbox();
  const item = inbox.pending.find(i => i.id === itemId);
  if (!item || item.status !== 'pending') return null;
  item.status = 'in_progress';
  writeInbox(inbox);
  return item;
}

/** Mark an item as resolved + move to `processed`. */
export function markResolved(itemId: string, resolvedBy: string, resolution: string): ScoutInboxItem | null {
  const inbox = readInbox();
  const idx = inbox.pending.findIndex(i => i.id === itemId);
  if (idx < 0) return null;
  const item = inbox.pending[idx];
  item.status = 'resolved';
  item.resolvedBy = resolvedBy;
  item.resolution = resolution;
  inbox.pending.splice(idx, 1);
  inbox.processed.push(item);
  writeInbox(inbox);
  return item;
}
