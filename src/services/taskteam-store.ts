import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { withFileLock } from '../utils/file-lock.js';
import type {
  TaskTeamCompanyId,
  TaskTeamDepartmentId,
  TaskTeamE2eConfig,
  TaskTeamId,
  TaskTeamInstance,
  TaskTeamInstanceFile,
  TaskTeamReviewVote,
  TaskTeamRoleInstance,
  TaskTeamStatus,
  TaskTeamTypeId,
} from './taskteam-schema.js';

const STORE_FILE = 'taskteams.json';

export class TaskTeamStoreCorruptError extends Error {
  constructor(public backupPath: string | null, cause: unknown) {
    super(`taskteam-store corrupt (backed up to ${backupPath ?? 'N/A'}); cause: ${cause}`);
    this.name = 'TaskTeamStoreCorruptError';
  }
}

export class TaskTeamNotFoundError extends Error {
  constructor(public teamId: TaskTeamId) {
    super(`TaskTeam ${teamId} not found`);
    this.name = 'TaskTeamNotFoundError';
  }
}

function fp(): string {
  return join(config.session.dataDir, STORE_FILE);
}

function ensureDir(): void {
  const dir = dirname(fp());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function emptyStore(): TaskTeamInstanceFile {
  return { version: 1, teams: [], updatedAt: new Date().toISOString() };
}

function normalize(raw: Partial<TaskTeamInstanceFile>): TaskTeamInstanceFile {
  return {
    version: raw.version ?? 1,
    teams: raw.teams ?? [],
    updatedAt: raw.updatedAt ?? new Date().toISOString(),
  };
}

export function readTaskTeams(): TaskTeamInstanceFile {
  if (!existsSync(fp())) return emptyStore();
  const raw = readFileSync(fp(), 'utf-8');
  try {
    return normalize(JSON.parse(raw) as Partial<TaskTeamInstanceFile>);
  } catch (err) {
    let backup: string | null = `${fp()}.corrupt-${Date.now()}`;
    try { writeFileSync(backup, raw, 'utf-8'); } catch { backup = null; }
    logger.error(`[taskteam-store] parse failed: ${err}; backed up to ${backup ?? 'N/A'}`);
    throw new TaskTeamStoreCorruptError(backup, err);
  }
}

function writeTaskTeams(next: TaskTeamInstanceFile): void {
  ensureDir();
  const tmp = `${fp()}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...next, updatedAt: new Date().toISOString() }, null, 2), 'utf-8');
  renameSync(tmp, fp());
}

async function mutate<T>(fn: (store: TaskTeamInstanceFile) => { result: T; dirty: boolean }): Promise<T> {
  ensureDir();
  return withFileLock(fp(), async () => {
    const store = readTaskTeams();
    const { result, dirty } = fn(store);
    if (dirty) {
      store.version += 1;
      writeTaskTeams(store);
    }
    return result;
  });
}

function genId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export async function createTaskTeam(opts: {
  typeId: TaskTeamTypeId;
  companyId: TaskTeamCompanyId;
  deptId?: TaskTeamDepartmentId;
  chatId: string;
  targetExternalChatId?: string;
  e2eConfig?: TaskTeamE2eConfig;
  goal: string;
  acceptance: string;
  roleInstances: TaskTeamRoleInstance[];
  cursor?: string;
}): Promise<TaskTeamInstance> {
  return mutate(store => {
    const now = new Date().toISOString();
    const team: TaskTeamInstance = {
      teamId: genId('tt_team') as TaskTeamId,
      typeId: opts.typeId,
      companyId: opts.companyId,
      deptId: opts.deptId,
      chatId: opts.chatId,
      ...(opts.targetExternalChatId ? { targetExternalChatId: opts.targetExternalChatId } : {}),
      ...(opts.e2eConfig ? { e2eConfig: opts.e2eConfig } : {}),
      goal: opts.goal,
      acceptance: opts.acceptance,
      roleInstances: opts.roleInstances,
      status: 'forming',
      progress: '',
      reviewState: { round: 0, reworkCount: 0, votes: [] },
      cursor: opts.cursor,
      // 阶段2 停滞窗口锚初值 = 建群时刻（无活动起点）；之后只在真实观测到新活动时重置。
      lastObservedActivityAt: now,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    store.teams.push(team);
    return { result: team, dirty: true };
  });
}

export function getTaskTeam(teamId: TaskTeamId): TaskTeamInstance | null {
  return readTaskTeams().teams.find(t => t.teamId === teamId) ?? null;
}

export async function updateTaskTeamStatus(teamId: TaskTeamId, status: TaskTeamStatus, progress?: string): Promise<TaskTeamInstance> {
  return mutate(store => {
    const idx = store.teams.findIndex(t => t.teamId === teamId);
    if (idx < 0) throw new TaskTeamNotFoundError(teamId);
    const cur = store.teams[idx];
    const next: TaskTeamInstance = {
      ...cur,
      status,
      progress: progress ?? cur.progress,
      version: cur.version + 1,
      updatedAt: new Date().toISOString(),
    };
    store.teams[idx] = next;
    return { result: next, dirty: true };
  });
}

export async function recordTaskTeamVote(teamId: TaskTeamId, vote: TaskTeamReviewVote): Promise<TaskTeamInstance> {
  return mutate(store => {
    const idx = store.teams.findIndex(t => t.teamId === teamId);
    if (idx < 0) throw new TaskTeamNotFoundError(teamId);
    const cur = store.teams[idx];
    const votes = cur.reviewState.votes.filter(v => v.byInstanceId !== vote.byInstanceId);
    votes.push(vote);
    const next: TaskTeamInstance = {
      ...cur,
      reviewState: { ...cur.reviewState, votes },
      version: cur.version + 1,
      updatedAt: new Date().toISOString(),
    };
    store.teams[idx] = next;
    return { result: next, dirty: true };
  });
}

// 批3 驱动层：把引擎 TeamDecision 的状态增量（status / reviewState）原子落库。
// 纯新增函数，不改动既有 store 行为（批1 已关，仅追加）。
export async function applyTeamDecisionState(
  teamId: TaskTeamId,
  patch: {
    status?: TaskTeamStatus;
    reviewState?: TaskTeamInstance['reviewState'];
    progress?: string;
    cursor?: string;
    // 阶段2：停滞窗口锚（reviewer Medium）。**只在观测到真实新活动时由调用方显式传入**（cursor 推进路径），
    // 普通状态写入不传 → 锚不被刷新（停滞窗内 sourceEventId 稳定）。
    lastObservedActivityAt?: string;
  },
): Promise<TaskTeamInstance> {
  return mutate(store => {
    const idx = store.teams.findIndex(t => t.teamId === teamId);
    if (idx < 0) throw new TaskTeamNotFoundError(teamId);
    const cur = store.teams[idx];
    const next: TaskTeamInstance = {
      ...cur,
      status: patch.status ?? cur.status,
      reviewState: patch.reviewState ?? cur.reviewState,
      progress: patch.progress ?? cur.progress,
      cursor: patch.cursor ?? cur.cursor,
      lastObservedActivityAt: patch.lastObservedActivityAt ?? cur.lastObservedActivityAt,
      version: cur.version + 1,
      updatedAt: new Date().toISOString(),
    };
    store.teams[idx] = next;
    return { result: next, dirty: true };
  });
}

// 批3 观测层：列出活跃（非终态）实例供 observer cron 扫描
const ACTIVE_TEAM_STATUSES: ReadonlySet<TaskTeamStatus> = new Set([
  'forming',
  'running',
  'reviewing',
  'e2e-verifying', // observer 在 e2e 验证态仍需盯群、判读豆包M 的 e2e 回报
  'blocked',
  'awaiting-acceptance',
]);

export function listActiveTaskTeams(): TaskTeamInstance[] {
  return readTaskTeams().teams.filter(t => ACTIVE_TEAM_STATUSES.has(t.status));
}

// 批5 InstanceSnapshot 恢复：整体替换实例集（同环境备份恢复用）
export async function replaceTaskTeams(teams: TaskTeamInstance[]): Promise<TaskTeamInstanceFile> {
  return mutate(store => {
    store.teams = teams;
    return { result: store, dirty: true };
  });
}
