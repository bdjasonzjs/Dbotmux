import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { withFileLock } from '../utils/file-lock.js';
import type {
  TaskTeamCompanyId,
  TaskTeamDepartmentId,
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
      goal: opts.goal,
      acceptance: opts.acceptance,
      roleInstances: opts.roleInstances,
      status: 'forming',
      progress: '',
      reviewState: { round: 0, reworkCount: 0, votes: [] },
      cursor: opts.cursor,
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
