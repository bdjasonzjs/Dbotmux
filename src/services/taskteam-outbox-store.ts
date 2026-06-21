import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { withFileLock } from '../utils/file-lock.js';
import type {
  TaskTeamAction,
  TaskTeamActionId,
  TaskTeamActionStatus,
  TaskTeamActionType,
  TaskTeamId,
  TaskTeamOutboxFile,
  TaskTeamRoleInstanceId,
  TaskTeamSlotId,
} from './taskteam-schema.js';

const STORE_FILE = 'taskteam-outbox.json';

export class TaskTeamOutboxStoreCorruptError extends Error {
  constructor(public backupPath: string | null, cause: unknown) {
    super(`taskteam-outbox-store corrupt (backed up to ${backupPath ?? 'N/A'}); cause: ${cause}`);
    this.name = 'TaskTeamOutboxStoreCorruptError';
  }
}

export class TaskTeamActionNotFoundError extends Error {
  constructor(public actionId: TaskTeamActionId) {
    super(`TaskTeam action ${actionId} not found`);
    this.name = 'TaskTeamActionNotFoundError';
  }
}

function fp(): string {
  return join(config.session.dataDir, STORE_FILE);
}

function ensureDir(): void {
  const dir = dirname(fp());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function emptyStore(): TaskTeamOutboxFile {
  return { version: 1, actions: [], updatedAt: new Date().toISOString() };
}

function normalize(raw: Partial<TaskTeamOutboxFile>): TaskTeamOutboxFile {
  return {
    version: raw.version ?? 1,
    actions: raw.actions ?? [],
    updatedAt: raw.updatedAt ?? new Date().toISOString(),
  };
}

export function readTaskTeamOutbox(): TaskTeamOutboxFile {
  if (!existsSync(fp())) return emptyStore();
  const raw = readFileSync(fp(), 'utf-8');
  try {
    return normalize(JSON.parse(raw) as Partial<TaskTeamOutboxFile>);
  } catch (err) {
    let backup: string | null = `${fp()}.corrupt-${Date.now()}`;
    try { writeFileSync(backup, raw, 'utf-8'); } catch { backup = null; }
    logger.error(`[taskteam-outbox-store] parse failed: ${err}; backed up to ${backup ?? 'N/A'}`);
    throw new TaskTeamOutboxStoreCorruptError(backup, err);
  }
}

function writeTaskTeamOutbox(next: TaskTeamOutboxFile): void {
  ensureDir();
  const tmp = `${fp()}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...next, updatedAt: new Date().toISOString() }, null, 2), 'utf-8');
  renameSync(tmp, fp());
}

async function mutate<T>(fn: (store: TaskTeamOutboxFile) => { result: T; dirty: boolean }): Promise<T> {
  ensureDir();
  return withFileLock(fp(), async () => {
    const store = readTaskTeamOutbox();
    const { result, dirty } = fn(store);
    if (dirty) {
      store.version += 1;
      writeTaskTeamOutbox(store);
    }
    return result;
  });
}

function genId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export async function enqueueTaskTeamAction(opts: {
  teamId: TaskTeamId;
  actionType: TaskTeamActionType;
  idempotencyKey: string;
  sourceRoleInstanceId?: TaskTeamRoleInstanceId;
  targetRoleInstanceId?: TaskTeamRoleInstanceId;
  targetSlotId?: TaskTeamSlotId;
  payload?: Record<string, unknown>;
}): Promise<TaskTeamAction> {
  return mutate(store => {
    const existing = store.actions.find(a => a.idempotencyKey === opts.idempotencyKey);
    if (existing) return { result: existing, dirty: false };
    const now = new Date().toISOString();
    const action: TaskTeamAction = {
      actionId: genId('tt_action') as TaskTeamActionId,
      teamId: opts.teamId,
      actionType: opts.actionType,
      sourceRoleInstanceId: opts.sourceRoleInstanceId,
      targetRoleInstanceId: opts.targetRoleInstanceId,
      targetSlotId: opts.targetSlotId,
      payload: opts.payload ?? {},
      idempotencyKey: opts.idempotencyKey,
      status: 'pending',
      retryCount: 0,
      leaseExpiresAt: null,
      nextAttemptAt: null,
      dispatchAttemptId: null,
      deliveredMessageId: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    store.actions.push(action);
    return { result: action, dirty: true };
  });
}

export function listPendingTaskTeamActions(now: Date = new Date()): TaskTeamAction[] {
  const nowMs = now.getTime();
  return readTaskTeamOutbox().actions.filter(a => {
    if (a.status === 'pending') {
      // A2：退避窗口未到则暂不投递（dispatcher 退避重试用）
      return !a.nextAttemptAt || new Date(a.nextAttemptAt).getTime() <= nowMs;
    }
    // mid-flight 但 lease 过期 → 可回收重投（不受退避窗影响）
    if (a.status !== 'claimed' || !a.leaseExpiresAt) return false;
    return new Date(a.leaseExpiresAt).getTime() <= nowMs;
  });
}

export async function claimTaskTeamAction(actionId: TaskTeamActionId, leaseMs: number): Promise<TaskTeamAction | null> {
  return mutate(store => {
    const idx = store.actions.findIndex(a => a.actionId === actionId);
    if (idx < 0) return { result: null, dirty: false };
    const cur = store.actions[idx];
    if (!['pending', 'claimed'].includes(cur.status)) return { result: null, dirty: false };
    const now = new Date();
    if (cur.status === 'claimed' && cur.leaseExpiresAt && new Date(cur.leaseExpiresAt).getTime() > now.getTime()) {
      return { result: null, dirty: false };
    }
    const next: TaskTeamAction = {
      ...cur,
      status: 'claimed',
      leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
      dispatchAttemptId: genId('tt_dispatch'),
      updatedAt: now.toISOString(),
    };
    store.actions[idx] = next;
    return { result: next, dirty: true };
  });
}

export async function completeTaskTeamAction(
  actionId: TaskTeamActionId,
  patch: { status: Exclude<TaskTeamActionStatus, 'pending' | 'claimed'>; deliveredMessageId?: string | null; lastError?: string | null },
): Promise<TaskTeamAction> {
  return mutate(store => {
    const idx = store.actions.findIndex(a => a.actionId === actionId);
    if (idx < 0) throw new TaskTeamActionNotFoundError(actionId);
    const cur = store.actions[idx];
    const next: TaskTeamAction = {
      ...cur,
      status: patch.status,
      deliveredMessageId: patch.deliveredMessageId ?? cur.deliveredMessageId,
      lastError: patch.lastError ?? null,
      // 终态（sent/acked/failed）不再动 retryCount——重试计数归 releaseTaskTeamActionForRetry 所有
      leaseExpiresAt: null,
      nextAttemptAt: null,
      dispatchAttemptId: null,
      updatedAt: new Date().toISOString(),
    };
    store.actions[idx] = next;
    return { result: next, dirty: true };
  });
}

/**
 * A2 retry 出路（留给批3 dispatcher）：投递失败但仍可重试时，把 action 放回 pending，
 * retryCount+1，按 backoffMs 设退避到点；listPending 在到点前不取。达 maxRetries 由 dispatcher
 * 改调 completeTaskTeamAction(status:'failed') 落终态——本层只提供能力、不内置策略。
 */
export async function releaseTaskTeamActionForRetry(
  actionId: TaskTeamActionId,
  opts: { lastError?: string | null; backoffMs?: number } = {},
): Promise<TaskTeamAction | null> {
  return mutate(store => {
    const idx = store.actions.findIndex(a => a.actionId === actionId);
    if (idx < 0) return { result: null, dirty: false };
    const cur = store.actions[idx];
    if (cur.status === 'acked') return { result: cur, dirty: false }; // 已终结成功，绝不回退重投
    const now = Date.now();
    const next: TaskTeamAction = {
      ...cur,
      status: 'pending',
      retryCount: cur.retryCount + 1,
      lastError: opts.lastError ?? cur.lastError,
      leaseExpiresAt: null,
      nextAttemptAt: opts.backoffMs && opts.backoffMs > 0 ? new Date(now + opts.backoffMs).toISOString() : null,
      dispatchAttemptId: null,
      updatedAt: new Date(now).toISOString(),
    };
    store.actions[idx] = next;
    return { result: next, dirty: true };
  });
}
