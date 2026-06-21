// 任务小组 · 管理面服务层（v3.1 §5）——配置 CRUD + template/instance 导入导出。
// daemon IPC 薄壳打到这里；CLI 命令族（cli/taskteam-cli.ts）打到 IPC。纯编排 batch1 store + 批5 templates。

import {
  readTaskTeamConfig,
  replaceTaskTeamConfig,
  upsertTaskTeamOrgStructure,
  upsertTaskTeamRole,
  upsertTaskTeamRule,
  upsertTaskTeamType,
} from './taskteam-config-store.js';
import { readTaskTeams, replaceTaskTeams } from './taskteam-store.js';
import {
  exportInstanceSnapshot,
  exportTemplateBundle,
  importTemplateBundle,
  validateInstanceSnapshot,
} from './taskteam-templates.js';
import type {
  TaskTeamCollabRule,
  TaskTeamOrgStructureShape,
  TaskTeamRole,
  TaskTeamType,
} from './taskteam-schema.js';
import type { TaskTeamInstanceSnapshot, TaskTeamTemplateBundle } from './taskteam-templates.js';

// P2：调用方 payload 形状错误 → 400（IPC route 按 name 映射），区别于服务端 500。
export class TaskTeamBadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskTeamBadRequestError';
  }
}

function requireObject(body: unknown, key: string): Record<string, unknown> {
  const v = (body as Record<string, unknown> | null | undefined)?.[key];
  if (v == null || typeof v !== 'object' || Array.isArray(v)) {
    throw new TaskTeamBadRequestError(`missing or invalid '${key}' object in request body`);
  }
  return v as Record<string, unknown>;
}
function requireId(obj: Record<string, unknown>, field: string, key: string): void {
  if (typeof obj[field] !== 'string' || !obj[field]) {
    throw new TaskTeamBadRequestError(`'${key}.${field}' is required`);
  }
}

// —— 配置读取 / CRUD ——
export function listTaskTeamConfig(): ReturnType<typeof readTaskTeamConfig> {
  return readTaskTeamConfig();
}
export async function adminUpsertRole(body: { role?: TaskTeamRole }): Promise<{ ok: true; roleId: string }> {
  const role = requireObject(body, 'role');
  requireId(role, 'roleId', 'role');
  const r = await upsertTaskTeamRole(role as unknown as TaskTeamRole);
  return { ok: true, roleId: r.roleId };
}
export async function adminUpsertRule(body: { rule?: TaskTeamCollabRule }): Promise<{ ok: true; ruleId: string }> {
  const rule = requireObject(body, 'rule');
  requireId(rule, 'ruleId', 'rule');
  const r = await upsertTaskTeamRule(rule as unknown as TaskTeamCollabRule);
  return { ok: true, ruleId: r.ruleId };
}
export async function adminUpsertType(body: { teamType?: TaskTeamType }): Promise<{ ok: true; typeId: string }> {
  const teamType = requireObject(body, 'teamType');
  requireId(teamType, 'typeId', 'teamType');
  // 防坏配置落库（批7 P2 防御纵深）：roleSlots 每项必须有非空 slotId + roleId
  const slots = (teamType as { roleSlots?: unknown }).roleSlots;
  if (slots !== undefined) {
    if (!Array.isArray(slots)) throw new TaskTeamBadRequestError(`'teamType.roleSlots' must be an array`);
    for (const s of slots) {
      const slot = s as { slotId?: unknown; roleId?: unknown };
      if (!slot || typeof slot !== 'object' || typeof slot.slotId !== 'string' || !slot.slotId || typeof slot.roleId !== 'string' || !slot.roleId) {
        throw new TaskTeamBadRequestError(`each 'teamType.roleSlots' entry requires non-empty slotId + roleId`);
      }
    }
  }
  const t = await upsertTaskTeamType(teamType as unknown as TaskTeamType);
  return { ok: true, typeId: t.typeId };
}
export async function adminUpsertOrg(body: { org?: TaskTeamOrgStructureShape }): Promise<{ ok: true; companyName: string }> {
  const org = requireObject(body, 'org');
  requireId(org, 'companyName', 'org');
  const o = await upsertTaskTeamOrgStructure(org as unknown as TaskTeamOrgStructureShape);
  return { ok: true, companyName: o.companyName };
}

// —— TemplateBundle 导出 / 导入（§5.1，H3）——
export function adminExportTemplate(): TaskTeamTemplateBundle {
  return exportTemplateBundle(readTaskTeamConfig());
}
export async function adminImportTemplate(body: { bundle?: TaskTeamTemplateBundle }): Promise<{ ok: true; roles: number; teamTypes: number; rebindRequired: true }> {
  requireObject(body, 'bundle'); // 进一步 kind/version/身份校验在 importTemplateBundle 内（抛 TaskTeamTemplateError→400）
  const merged = importTemplateBundle(body!.bundle as TaskTeamTemplateBundle, readTaskTeamConfig());
  await replaceTaskTeamConfig(merged);
  // 提醒调用方：导入只合入可分享 shape，运行态 bot 须重选 creator app + 重绑（§5.1）
  return { ok: true, roles: merged.roles.length, teamTypes: merged.teamTypes.length, rebindRequired: true };
}

// —— InstanceSnapshot 备份 / 恢复（§5.1，同环境）——
export function adminExportSnapshot(): TaskTeamInstanceSnapshot {
  return exportInstanceSnapshot(readTaskTeamConfig(), readTaskTeams().teams);
}
export async function adminRestoreSnapshot(body: { snapshot?: TaskTeamInstanceSnapshot }): Promise<{ ok: true; teams: number }> {
  requireObject(body, 'snapshot');
  validateInstanceSnapshot(body!.snapshot as TaskTeamInstanceSnapshot); // kind/version/形态校验，抛 TaskTeamTemplateError→400
  await replaceTaskTeamConfig(body!.snapshot!.config);
  await replaceTaskTeams(body!.snapshot!.teams);
  return { ok: true, teams: body!.snapshot!.teams.length };
}
