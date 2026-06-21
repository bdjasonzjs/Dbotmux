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

// —— 配置读取 / CRUD ——
export function listTaskTeamConfig(): ReturnType<typeof readTaskTeamConfig> {
  return readTaskTeamConfig();
}
export async function adminUpsertRole(body: { role: TaskTeamRole }): Promise<{ ok: true; roleId: string }> {
  const r = await upsertTaskTeamRole(body.role);
  return { ok: true, roleId: r.roleId };
}
export async function adminUpsertRule(body: { rule: TaskTeamCollabRule }): Promise<{ ok: true; ruleId: string }> {
  const r = await upsertTaskTeamRule(body.rule);
  return { ok: true, ruleId: r.ruleId };
}
export async function adminUpsertType(body: { teamType: TaskTeamType }): Promise<{ ok: true; typeId: string }> {
  const t = await upsertTaskTeamType(body.teamType);
  return { ok: true, typeId: t.typeId };
}
export async function adminUpsertOrg(body: { org: TaskTeamOrgStructureShape }): Promise<{ ok: true; companyName: string }> {
  const o = await upsertTaskTeamOrgStructure(body.org);
  return { ok: true, companyName: o.companyName };
}

// —— TemplateBundle 导出 / 导入（§5.1，H3）——
export function adminExportTemplate(): TaskTeamTemplateBundle {
  return exportTemplateBundle(readTaskTeamConfig());
}
export async function adminImportTemplate(body: { bundle: TaskTeamTemplateBundle }): Promise<{ ok: true; roles: number; teamTypes: number; rebindRequired: true }> {
  const merged = importTemplateBundle(body.bundle, readTaskTeamConfig());
  await replaceTaskTeamConfig(merged);
  // 提醒调用方：导入只合入可分享 shape，运行态 bot 须重选 creator app + 重绑（§5.1）
  return { ok: true, roles: merged.roles.length, teamTypes: merged.teamTypes.length, rebindRequired: true };
}

// —— InstanceSnapshot 备份 / 恢复（§5.1，同环境）——
export function adminExportSnapshot(): TaskTeamInstanceSnapshot {
  return exportInstanceSnapshot(readTaskTeamConfig(), readTaskTeams().teams);
}
export async function adminRestoreSnapshot(body: { snapshot: TaskTeamInstanceSnapshot }): Promise<{ ok: true; teams: number }> {
  validateInstanceSnapshot(body.snapshot);
  await replaceTaskTeamConfig(body.snapshot.config);
  await replaceTaskTeams(body.snapshot.teams);
  return { ok: true, teams: body.snapshot.teams.length };
}
