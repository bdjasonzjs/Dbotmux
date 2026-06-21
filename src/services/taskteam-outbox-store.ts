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
  TaskTeamDeliveryCommand,
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

// P1-2：终态（acked/failed）不可被改写成其它状态
export class TaskTeamActionTerminalError extends Error {
  constructor(public actionId: TaskTeamActionId, public from: TaskTeamActionStatus, public to: TaskTeamActionStatus) {
    super(`TaskTeam action ${actionId} is terminal (${from}); refusing transition to ${to}`);
    this.name = 'TaskTeamActionTerminalError';
  }
}

const TERMINAL_STATUSES: ReadonlySet<TaskTeamActionStatus> = new Set(['acked', 'failed']);

// P1（complete 侧状态机）：合法的 complete 跃迁。claimed→sent|failed、sent→acked；
// 禁止 sent→failed（已发送不降级）与 pending→任何终态（必须先 claim）。同状态幂等单独放行。
const ALLOWED_COMPLETE_TRANSITIONS: Readonly<Record<string, ReadonlyArray<TaskTeamActionStatus>>> = {
  claimed: ['sent', 'failed'],
  sent: ['acked'],
};

export class TaskTeamActionTransitionError extends Error {
  constructor(public actionId: TaskTeamActionId, public from: TaskTeamActionStatus, public to: TaskTeamActionStatus) {
    super(`TaskTeam action ${actionId} illegal complete transition ${from} → ${to}`);
    this.name = 'TaskTeamActionTransitionError';
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
  actionType: TaskTeamDeliveryCommand;
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
    // P2-1：退避窗未到的 pending 不可被直接 claim（不只靠 listPending 过滤）
    if (cur.status === 'pending' && cur.nextAttemptAt && new Date(cur.nextAttemptAt).getTime() > now.getTime()) {
      return { result: null, dirty: false };
    }
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
  patch: {
    status: Exclude<TaskTeamActionStatus, 'pending' | 'claimed'>;
    deliveredMessageId?: string | null;
    lastError?: string | null;
    dispatchAttemptId?: string | null; // P1：CAS——complete 必须由当前持有者（同一 attempt）发起
  },
): Promise<TaskTeamAction | null> {
  return mutate(store => {
    const idx = store.actions.findIndex(a => a.actionId === actionId);
    if (idx < 0) throw new TaskTeamActionNotFoundError(actionId);
    const cur = store.actions[idx];
    // 同状态幂等放行（迟到重复 complete 不抖动 version）
    if (patch.status === cur.status) return { result: cur, dirty: false };
    // 终态守卫——acked/failed 不可被改写
    if (TERMINAL_STATUSES.has(cur.status)) {
      throw new TaskTeamActionTerminalError(actionId, cur.status, patch.status);
    }
    // CAS fencing——claimed 的完成必须由当前持有 attempt 发起；迟到/无凭证旧 attempt 拒写（返回 null）
    if (cur.status === 'claimed' && (!patch.dispatchAttemptId || cur.dispatchAttemptId !== patch.dispatchAttemptId)) {
      return { result: null, dirty: false };
    }
    // 状态机守卫——只允许 claimed→sent|failed、sent→acked；禁 sent→failed / pending→终态
    if (!(ALLOWED_COMPLETE_TRANSITIONS[cur.status] ?? []).includes(patch.status)) {
      throw new TaskTeamActionTransitionError(actionId, cur.status, patch.status);
    }
    const next: TaskTeamAction = {
      ...cur,
      status: patch.status,
      deliveredMessageId: patch.deliveredMessageId ?? cur.deliveredMessageId,
      lastError: patch.lastError ?? null,
      // 终态不再动 retryCount——重试计数归 releaseTaskTeamActionForRetry 所有
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
 * A2 retry 出路（留给批3 dispatcher）：投递失败但仍在飞行中（claimed）时，把 action 放回 pending，
 * retryCount+1，按 backoffMs 设退避到点；listPending/claim 在到点前都不取。
 * P1-2 状态机守卫：
 *  - 仅 `claimed` 可 release——`sent/acked/failed/pending` 一律不动（绝不复活终态、不重投已发送）。
 *  - 若传入 `dispatchAttemptId`，必须与当前持有者一致才放行——挡迟到回调 / 已被他人重领的旧 attempt。
 * 达 maxRetries 时由 dispatcher 改调 completeTaskTeamAction(status:'failed') 落终态——本层只给能力、不内置策略。
 */
export async function releaseTaskTeamActionForRetry(
  actionId: TaskTeamActionId,
  opts: { dispatchAttemptId?: string | null; lastError?: string | null; backoffMs?: number } = {},
): Promise<TaskTeamAction | null> {
  return mutate(store => {
    const idx = store.actions.findIndex(a => a.actionId === actionId);
    if (idx < 0) return { result: null, dirty: false };
    const cur = store.actions[idx];
    // 仅在飞行中（claimed）才可退避重投；终态 / pending 保持不变
    if (cur.status !== 'claimed') return { result: cur, dirty: false };
    // 迟到回调 / 已被他人重领：attempt 不匹配则忽略
    if (opts.dispatchAttemptId && cur.dispatchAttemptId !== opts.dispatchAttemptId) {
      return { result: cur, dirty: false };
    }
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
