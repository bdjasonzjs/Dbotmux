import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { withFileLock } from '../utils/file-lock.js';
import type {
  TaskTeamActionType,
  TaskTeamCollabRule,
  TaskTeamConfigFile,
  TaskTeamOrgRuntimeBinding,
  TaskTeamOrgStructureShape,
  TaskTeamRole,
  TaskTeamRuleId,
  TaskTeamType,
} from './taskteam-schema.js';
import { assertValidTaskTeamConfig, type TaskTeamConfigIssue } from './taskteam-validator.js';

// 写路径 validator 守卫（阶段1①）：落库前闭环校验，有 error 抛 TaskTeamConfigValidationError、warning 记日志、不静默。
function guardConfig(store: TaskTeamConfigFile, where: string): void {
  const warnings: TaskTeamConfigIssue[] = assertValidTaskTeamConfig(store); // 有 error 直接抛（mutate 内抛 → 不落库）
  if (warnings.length) {
    logger.warn(`[taskteam-config-store] ${where}: ${warnings.length} 条配置告警: ${warnings.map(w => w.message).join('; ')}`);
  }
}

const STORE_FILE = 'taskteam-config.json';

export class TaskTeamConfigStoreCorruptError extends Error {
  constructor(public backupPath: string | null, cause: unknown) {
    super(`taskteam-config-store corrupt (backed up to ${backupPath ?? 'N/A'}); cause: ${cause}`);
    this.name = 'TaskTeamConfigStoreCorruptError';
  }
}

function fp(): string {
  return join(config.session.dataDir, STORE_FILE);
}

function ensureDir(): void {
  const dir = dirname(fp());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function emptyConfig(): TaskTeamConfigFile {
  return {
    version: 1,
    roles: [],
    rules: [],
    teamTypes: [],
    orgStructures: [],
    orgRuntimeBindings: [],
    updatedAt: new Date().toISOString(),
  };
}

function normalize(raw: Partial<TaskTeamConfigFile>): TaskTeamConfigFile {
  return {
    version: raw.version ?? 1,
    roles: raw.roles ?? [],
    rules: raw.rules ?? [],
    teamTypes: raw.teamTypes ?? [],
    orgStructures: raw.orgStructures ?? [],
    orgRuntimeBindings: raw.orgRuntimeBindings ?? [],
    updatedAt: raw.updatedAt ?? new Date().toISOString(),
  };
}

export function readTaskTeamConfig(): TaskTeamConfigFile {
  if (!existsSync(fp())) return emptyConfig();
  const raw = readFileSync(fp(), 'utf-8');
  try {
    return normalize(JSON.parse(raw) as Partial<TaskTeamConfigFile>);
  } catch (err) {
    let backup: string | null = `${fp()}.corrupt-${Date.now()}`;
    try { writeFileSync(backup, raw, 'utf-8'); } catch { backup = null; }
    logger.error(`[taskteam-config-store] parse failed: ${err}; backed up to ${backup ?? 'N/A'}`);
    throw new TaskTeamConfigStoreCorruptError(backup, err);
  }
}

function writeTaskTeamConfig(next: TaskTeamConfigFile): void {
  ensureDir();
  const tmp = `${fp()}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...next, updatedAt: new Date().toISOString() }, null, 2), 'utf-8');
  renameSync(tmp, fp());
}

export async function mutateTaskTeamConfig<T>(
  fn: (store: TaskTeamConfigFile) => { result: T; dirty: boolean },
): Promise<T> {
  ensureDir();
  return withFileLock(fp(), async () => {
    const store = readTaskTeamConfig();
    const { result, dirty } = fn(store);
    if (dirty) {
      store.version += 1;
      writeTaskTeamConfig(store);
    }
    return result;
  });
}

export async function replaceTaskTeamConfig(next: TaskTeamConfigFile): Promise<TaskTeamConfigFile> {
  return mutateTaskTeamConfig(store => {
    store.roles = next.roles;
    store.rules = next.rules;
    store.teamTypes = next.teamTypes;
    store.orgStructures = next.orgStructures;
    store.orgRuntimeBindings = next.orgRuntimeBindings;
    guardConfig(store, 'replaceTaskTeamConfig'); // import/restore 落库前闭环校验
    return { result: store, dirty: true };
  });
}

export async function upsertTaskTeamRole(role: TaskTeamRole): Promise<TaskTeamRole> {
  return mutateTaskTeamConfig(store => {
    const idx = store.roles.findIndex(r => r.roleId === role.roleId);
    if (idx >= 0) store.roles[idx] = role;
    else store.roles.push(role);
    return { result: role, dirty: true };
  });
}

export async function upsertTaskTeamRule(rule: TaskTeamCollabRule): Promise<TaskTeamCollabRule> {
  return mutateTaskTeamConfig(store => {
    const idx = store.rules.findIndex(r => r.ruleId === rule.ruleId);
    if (idx >= 0) store.rules[idx] = rule;
    else store.rules.push(rule);
    // 修 reviewer P1-a：单独改规则也走 validator 守卫——已被某 type.rules 引用的 rule 被改坏（非法 do /
    // transition 冲突 / 非法 status）会在此阻断落库，不再拖到下次 type upsert / replace 才暴露。
    // 未被任何 type 引用的增量 rule 不会触发 per-type 校验 → 增量创建顺序不受影响。
    guardConfig(store, `upsertTaskTeamRule ${rule.ruleId}`);
    return { result: rule, dirty: true };
  });
}

export async function upsertTaskTeamType(teamType: TaskTeamType): Promise<TaskTeamType> {
  return mutateTaskTeamConfig(store => {
    const idx = store.teamTypes.findIndex(t => t.typeId === teamType.typeId);
    if (idx >= 0) store.teamTypes[idx] = teamType;
    else store.teamTypes.push(teamType);
    guardConfig(store, `upsertTaskTeamType ${teamType.typeId}`); // create/upsert type 落库前闭环校验
    return { result: teamType, dirty: true };
  });
}

export async function upsertTaskTeamOrgStructure(shape: TaskTeamOrgStructureShape): Promise<TaskTeamOrgStructureShape> {
  return mutateTaskTeamConfig(store => {
    const idx = store.orgStructures.findIndex(o => o.companyName === shape.companyName);
    if (idx >= 0) store.orgStructures[idx] = shape;
    else store.orgStructures.push(shape);
    return { result: shape, dirty: true };
  });
}

export async function upsertTaskTeamOrgRuntimeBinding(binding: TaskTeamOrgRuntimeBinding): Promise<TaskTeamOrgRuntimeBinding> {
  return mutateTaskTeamConfig(store => {
    const idx = store.orgRuntimeBindings.findIndex(b => b.companyId === binding.companyId);
    if (idx >= 0) store.orgRuntimeBindings[idx] = binding;
    else store.orgRuntimeBindings.push(binding);
    return { result: binding, dirty: true };
  });
}

// 阶段2 块4：现有「两层 review 开发团队」抽成一份**具名 type 常量**。
// canonical typeId / roleSlot 顺序 / 引用的 ruleId / policy **一律不动**（golden test deepEqual 钉死，
// 被 onboarding types[0] sample + dashboard 按 roleSlots 顺序渲染 + 现有实例按 typeId 查 type 引用）。
// 要新名字只能加 display（本阶段不加，避免动 canonical 形态破坏 golden）。
export const TT_TYPE_TWO_LAYER_REVIEW: TaskTeamType['typeId'] = 'tt_type_two_layer_review';

export const TWO_LAYER_REVIEW_TEAM_TYPE: TaskTeamType = {
  typeId: TT_TYPE_TWO_LAYER_REVIEW,
  name: '两层 review 任务小组',
  roleSlots: [
    { slotId: 'tt_slot_developer_main', roleId: 'tt_role_developer', label: 'main' },
    { slotId: 'tt_slot_architect_main', roleId: 'tt_role_architect', label: 'architecture-review' },
    { slotId: 'tt_slot_detail_reviewer_main', roleId: 'tt_role_detail_reviewer', label: 'detail-review' },
    { slotId: 'tt_slot_observer_main', roleId: 'tt_role_observer', label: 'observer' },
  ],
  rules: [
    'tt_rule_submit_to_architect',
    'tt_rule_architect_pass_to_detail',
    'tt_rule_detail_pass_to_acceptance',
    'tt_rule_reject_to_rework',
    'tt_rule_observer_stall_report',
  ],
  policy: {
    reviewRounds: 2,
    reviewQuorum: 1,
    maxRework: 3,
    escalateAfterStallMs: 30 * 60 * 1000,
    reviewOrder: ['tt_slot_architect_main', 'tt_slot_detail_reviewer_main'],
  },
};

export function defaultTaskTeamSeed(): Omit<TaskTeamConfigFile, 'version' | 'updatedAt'> {
  const developer = 'tt_role_developer';
  const architect = 'tt_role_architect';
  const detailReviewer = 'tt_role_detail_reviewer';
  const observer = 'tt_role_observer';
  const actions: TaskTeamActionType[] = ['submit', 'review-pass', 'review-reject', 'rework', 'ask-help', 'report', 'finish'];
  const rules: TaskTeamRuleId[] = [
    'tt_rule_submit_to_architect',
    'tt_rule_architect_pass_to_detail',
    'tt_rule_detail_pass_to_acceptance',
    'tt_rule_reject_to_rework',
    'tt_rule_observer_stall_report',
  ];

  return {
    roles: [
      {
        roleId: developer,
        name: '开发者',
        responsibility: '按批次实现方案和单测',
        activation: { trigger: 'team-started' },
        visibility: 'full',
        actions,
        io: { from: [], to: [{ roleId: architect }] },
        seatHint: { engine: 'claude' },
      },
      {
        roleId: architect,
        name: '架构师',
        responsibility: '审核实现是否符合产品设计和技术方案',
        activation: { trigger: 'developer-submit' },
        visibility: 'review-only',
        actions: ['review-pass', 'review-reject', 'ask-help', 'report'],
        io: { from: [{ roleId: developer }], to: [{ roleId: detailReviewer }, { roleId: developer }] },
        seatHint: { engine: 'claude' },
      },
      {
        roleId: detailReviewer,
        name: '审查员',
        responsibility: '代码细节 review，确认无 P1 后交还验收',
        activation: { trigger: 'architecture-pass' },
        visibility: 'review-only',
        actions: ['review-pass', 'review-reject', 'ask-help', 'report'],
        io: { from: [{ roleId: architect }], to: [{ roleId: developer }] },
        seatHint: { engine: 'codex' },
      },
      {
        roleId: observer,
        name: '盯梢',
        responsibility: '低成本观察进展和健康度，必要时上报卡点',
        activation: { trigger: 'observer-tick' },
        visibility: 'progress-only',
        actions: ['report', 'ask-help', 'escalate'],
        io: { from: [{ roleId: developer }, { roleId: architect }, { roleId: detailReviewer }], to: [] },
        seatHint: { engine: 'coco' },
        isObserver: true,
      },
    ],
    // do = 投递命令（P1-1）：角色 submit/review-pass 是触发事件(when.event)，引擎产出 request-review/nudge/report 等命令
    rules: [
      // 开发者提交 → 给架构师席投递 review 请求（不是"review 已通过"）
      { ruleId: rules[0], when: { event: 'submit', status: 'running' }, whoSlot: 'tt_slot_architect_main', do: 'request-review' },
      // 架构师通过 → 给审查员席投递 review 请求
      { ruleId: rules[1], when: { event: 'review-pass', status: 'reviewing', fromSlotId: 'tt_slot_architect_main' }, whoSlot: 'tt_slot_detail_reviewer_main', do: 'request-review' },
      // A3：细节 review 通过 ≠ 自动完成；投递"待验收"report 给开发者席，finish 仅由 owner 验收事件触发（设计 4.4）
      { ruleId: rules[2], when: { event: 'review-pass', status: 'reviewing', fromSlotId: 'tt_slot_detail_reviewer_main' }, whoSlot: 'tt_slot_developer_main', do: 'report' },
      // 任一层驳回 → nudge 开发者席返工（rework 是开发者的角色行为，投递命令是 nudge）
      { ruleId: rules[3], when: { event: 'review-reject', status: 'reviewing' }, whoSlot: 'tt_slot_developer_main', do: 'nudge' },
      // 卡顿 → 盯梢席 escalate 上报卡点
      { ruleId: rules[4], when: { event: 'stall', status: 'running' }, whoSlot: 'tt_slot_observer_main', do: 'escalate' },
    ],
    // 块4：引用具名 type 常量（深拷贝，保持「每次调用返回独立对象」语义，避免共享可变态）。
    teamTypes: [structuredClone(TWO_LAYER_REVIEW_TEAM_TYPE)],
    orgStructures: [
      {
        companyName: '一人公司',
        departments: [{ deptName: '默认部门', teamTypeIds: ['tt_type_two_layer_review'] }],
      },
    ],
    orgRuntimeBindings: [],
  };
}

export async function seedDefaultTaskTeamConfig(): Promise<TaskTeamConfigFile> {
  return mutateTaskTeamConfig(store => {
    if (store.roles.length || store.rules.length || store.teamTypes.length || store.orgStructures.length) {
      return { result: store, dirty: false };
    }
    const seed = defaultTaskTeamSeed();
    store.roles = seed.roles;
    store.rules = seed.rules;
    store.teamTypes = seed.teamTypes;
    store.orgStructures = seed.orgStructures;
    store.orgRuntimeBindings = seed.orgRuntimeBindings;
    return { result: store, dirty: true };
  });
}
