/**
 * CEO-spawn re-entry state (块7 第二轮 #5, 蔻黛 blocker 2).
 *
 * The CEO end-to-end spawn is a multi-step, owner-gated flow that the CEO
 * re-invokes as gates clear (owner scans QR, 松松 approves activation, clone
 * surfaces). To resume CORRECTLY — and to bind each in-flight clone to THE
 * request that started it (so concurrent under-staffed tasks never grab each
 * other's pending clone) — we persist per-request state keyed by the SAME
 * idempotencyKey createSubtask uses (`${callerChatId}-${rootMessageId}-${slug}-${djb2}`).
 *
 * Persisted to disk (atomic tmp+rename) so a daemon restart mid-flow resumes.
 * NOT a global "find any pending clone" scan — lookup is always by key.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export type ClonePhase = 'pending' | 'cloned' | 'activated' | 'registered' | 'in_chat' | 'joined';

export interface PendingCloneSeat {
  /** Index into the request's seats[] this clone fills (stable across re-entry). */
  seatIndex: number;
  role: 'main' | 'collab' | 'observer';
  /** Set once the QR clone is written to bots.json. */
  appId?: string;
  /** Computed『本体名（N号机）』— the clone's addressable name. */
  displayName?: string;
  phase: ClonePhase;
}

export interface CeoSpawnState {
  key: string;
  taskId: string;
  subgroupChatId: string;
  pendingClones: PendingCloneSeat[];
  updatedAt: string;
}

const STORE_FILE = 'ceo-spawn-state.json';

interface StoreFile { states: CeoSpawnState[]; }

function filePath(): string {
  return join(config.session.dataDir, STORE_FILE);
}

function load(): StoreFile {
  const fp = filePath();
  if (!existsSync(fp)) return { states: [] };
  try {
    const obj = JSON.parse(readFileSync(fp, 'utf-8'));
    return Array.isArray(obj?.states) ? obj : { states: [] };
  } catch (err) {
    logger.error(`[ceo-spawn-store] parse failed, starting empty: ${err}`);
    return { states: [] };
  }
}

function persist(store: StoreFile): void {
  const fp = filePath();
  mkdirSync(dirname(fp), { recursive: true });
  const tmp = `${fp}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  renameSync(tmp, fp);
}

/** Look up the in-flight state for THIS request (by idempotencyKey). */
export function getCeoSpawnState(key: string): CeoSpawnState | null {
  return load().states.find(s => s.key === key) ?? null;
}

/** Insert or replace the state for a key (atomic). */
export function putCeoSpawnState(state: CeoSpawnState): CeoSpawnState {
  const store = load();
  const idx = store.states.findIndex(s => s.key === state.key);
  const next = { ...state, updatedAt: new Date().toISOString() };
  if (idx >= 0) store.states[idx] = next;
  else store.states.push(next);
  persist(store);
  return next;
}

/** Drop the state once the request is fully spawned (all seats filled). */
export function clearCeoSpawnState(key: string): void {
  const store = load();
  const next = store.states.filter(s => s.key !== key);
  if (next.length !== store.states.length) persist({ states: next });
}

/** Idempotency key — MUST mirror createSubtask's formula so the subgroup and
 *  the CEO-spawn state share one key per request. */
export function ceoSpawnKey(callerChatId: string, rootMessageId: string, goalKeySlug: string, goalHash: string): string {
  return `${callerChatId}-${rootMessageId}-${goalKeySlug}-${goalHash}`;
}
