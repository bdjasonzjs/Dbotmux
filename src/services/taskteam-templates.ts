// 任务小组 · 分享边界（v3.1 §5.1，H3）——TemplateBundle(可分享) vs InstanceSnapshot(同环境备份)。
//
// TemplateBundle：只含可分享设计态（角色库 / 规则 / 小组类型 / 组织结构 shape），
//   绝不含 app-scoped 运行态身份（chatId/botOpenId/larkAppId/companyId 等）。这是设计第八节"可复制分享"的出口。
// InstanceSnapshot：含运行态绑定 + 运行实例，仅用于本机/同 app 备份恢复，不作为分享模板。
// 纯函数（无 IO），便于单测；落盘由 store 层负责。

import type {
  TaskTeamCollabRule,
  TaskTeamConfigFile,
  TaskTeamInstance,
  TaskTeamOrgStructureShape,
  TaskTeamRole,
  TaskTeamType,
} from './taskteam-schema.js';

export const TEMPLATE_BUNDLE_KIND = 'taskteam-template-bundle';
export const INSTANCE_SNAPSHOT_KIND = 'taskteam-instance-snapshot';

// 可分享模板包（§5.1）——只含设计态、无任何 app-scoped 运行态身份
export interface TaskTeamTemplateBundle {
  kind: typeof TEMPLATE_BUNDLE_KIND;
  version: 1;
  roles: TaskTeamRole[];
  rules: TaskTeamCollabRule[];
  teamTypes: TaskTeamType[];
  orgStructures: TaskTeamOrgStructureShape[];
}

// 同环境快照（§5.1）——含运行态绑定 + 实例，仅本机/同 app 备份
export interface TaskTeamInstanceSnapshot {
  kind: typeof INSTANCE_SNAPSHOT_KIND;
  version: 1;
  config: TaskTeamConfigFile;
  teams: TaskTeamInstance[];
}

export class TaskTeamTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskTeamTemplateError';
  }
}

// app-scoped 运行态身份字段——绝不能出现在可分享模板里（H3 防泄漏）
const FORBIDDEN_SHAREABLE_KEYS = ['chatId', 'botOpenId', 'larkAppId', 'companyId', 'deptId', 'rootChatId', 'ceoBotOpenId', 'managerChatId', 'managerBotOpenId', 'binding'];

function assertNoRuntimeIdentity(node: unknown, path: string): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => assertNoRuntimeIdentity(v, `${path}[${i}]`));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (FORBIDDEN_SHAREABLE_KEYS.includes(k) && v != null) {
        throw new TaskTeamTemplateError(`template bundle must not carry app-scoped runtime identity: ${path}.${k}`);
      }
      assertNoRuntimeIdentity(v, `${path}.${k}`);
    }
  }
}

/** 导出 TemplateBundle：从 config 取设计态，剥离运行态绑定（orgRuntimeBindings 不进包），并断言无 app-scoped 身份。 */
export function exportTemplateBundle(config: TaskTeamConfigFile): TaskTeamTemplateBundle {
  const bundle: TaskTeamTemplateBundle = {
    kind: TEMPLATE_BUNDLE_KIND,
    version: 1,
    roles: config.roles,
    rules: config.rules,
    teamTypes: config.teamTypes,
    orgStructures: config.orgStructures, // batch1 A1 后已为 identity-free shape
  };
  assertNoRuntimeIdentity({ roles: bundle.roles, rules: bundle.rules, teamTypes: bundle.teamTypes, orgStructures: bundle.orgStructures }, 'bundle');
  return bundle;
}

/**
 * 导入 TemplateBundle 合入当前 config：按 id upsert 设计态（roles/rules/teamTypes/orgStructures）。
 * **绝不带入运行态绑定**——orgRuntimeBindings 保持当前 config 的本地值。导入后调用方须**强制重选 creator app +
 * 重新解析绑定 bot**（§5.1），本函数只合入可分享 shape，不自动绑定任何 bot。
 * 入包先校验 kind/version + 无 app-scoped 身份（防别处 open_id 被带进来）。
 */
export function importTemplateBundle(bundle: TaskTeamTemplateBundle, currentConfig: TaskTeamConfigFile): TaskTeamConfigFile {
  if (bundle?.kind !== TEMPLATE_BUNDLE_KIND) throw new TaskTeamTemplateError(`not a template bundle (kind=${(bundle as { kind?: string })?.kind})`);
  if (bundle.version !== 1) throw new TaskTeamTemplateError(`unsupported template bundle version ${bundle.version}`);
  assertNoRuntimeIdentity({ roles: bundle.roles, rules: bundle.rules, teamTypes: bundle.teamTypes, orgStructures: bundle.orgStructures }, 'bundle');

  const upsert = <T>(list: T[], incoming: T[], key: (x: T) => string): T[] => {
    const merged = [...list];
    for (const item of incoming) {
      const idx = merged.findIndex(x => key(x) === key(item));
      if (idx >= 0) merged[idx] = item;
      else merged.push(item);
    }
    return merged;
  };

  return {
    ...currentConfig,
    roles: upsert(currentConfig.roles, bundle.roles ?? [], r => r.roleId),
    rules: upsert(currentConfig.rules, bundle.rules ?? [], r => r.ruleId),
    teamTypes: upsert(currentConfig.teamTypes, bundle.teamTypes ?? [], t => t.typeId),
    orgStructures: upsert(currentConfig.orgStructures, bundle.orgStructures ?? [], o => o.companyName),
    // orgRuntimeBindings 不动——运行态身份必须导入后由调用方重绑（§5.1 / H3）
    updatedAt: currentConfig.updatedAt,
  };
}

/** 导出 InstanceSnapshot（同环境备份，含运行态绑定 + 实例）。 */
export function exportInstanceSnapshot(config: TaskTeamConfigFile, teams: TaskTeamInstance[]): TaskTeamInstanceSnapshot {
  return { kind: INSTANCE_SNAPSHOT_KIND, version: 1, config, teams };
}

/** 校验 InstanceSnapshot 形态（恢复前）。恢复落盘由 store 层负责，本函数只做形态校验。 */
export function validateInstanceSnapshot(snapshot: TaskTeamInstanceSnapshot): void {
  if (snapshot?.kind !== INSTANCE_SNAPSHOT_KIND) throw new TaskTeamTemplateError(`not an instance snapshot (kind=${(snapshot as { kind?: string })?.kind})`);
  if (snapshot.version !== 1) throw new TaskTeamTemplateError(`unsupported snapshot version ${snapshot.version}`);
  if (!snapshot.config || !Array.isArray(snapshot.teams)) throw new TaskTeamTemplateError('snapshot missing config/teams');
}
