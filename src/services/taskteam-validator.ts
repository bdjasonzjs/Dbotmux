// 任务小组 · 配置 validator（阶段1 内核①）——import / upsert / create type 落库前的闭环校验，
// 杜绝「配着看着对、运行永远零事件 / 静默 no-op」。
//
// 校验维度（设计 §5 阶段1①、§8 约束2 + 生产侧覆盖）：
//  - 闭环引用：roleSlot.roleId / type.rules / rule.whoSlot / rule.when.fromSlotId / policy.reviewOrder 互相引用闭合。
//  - 命令 / 状态合法：rule.do ∈ 投递命令集；transition.status ∈ 合法状态集。
//  - 事件 registry（②配套）：rule.when.event 必须在该 type 的「可产出事件集」内——typo / 声明了却无 producer
//    （配着对、运行永远零事件）→ 报警。
//  - 显式 transition 红线（约束2）：legacy 事件（team-started/review-pass/review-reject/accept）声明 transition
//    无意义（引擎走 special case 不读）→ 报警；同一事件可同时命中的多条规则若声明互斥 transition（distinct
//    status > 1）→ 报错（runtime 一次只落一个 {status} patch，冲突无处表达）。
//
// 严重度策略：闭环引用 / 生产侧覆盖 / legacy-transition 取 **warning**（增量 upsert 期角色/规则可后补，不硬阻断）；
// transition 互斥 / 非法 do / 非法状态取 **error**（语义上恒错，阻断落库）。写路径（config-store）只在有 error 时抛。

import type {
  TaskTeamCollabRule,
  TaskTeamConfigFile,
  TaskTeamDeliveryCommand,
  TaskTeamStatus,
  TaskTeamType,
} from './taskteam-schema.js';
import {
  attributionForEvent,
  detectableEventsForType,
  isProducibleForType,
  knownEventsForType,
  timerEventsForType,
} from './taskteam-event-registry.js';

export interface TaskTeamConfigIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  typeId?: string;
  ruleId?: string;
}

export interface TaskTeamConfigValidation {
  ok: boolean; // 无 error（warning 不影响 ok）
  errors: TaskTeamConfigIssue[];
  warnings: TaskTeamConfigIssue[];
  issues: TaskTeamConfigIssue[]; // errors + warnings（声明顺序）
}

export class TaskTeamConfigValidationError extends Error {
  constructor(public errors: TaskTeamConfigIssue[]) {
    super(`taskteam config invalid: ${errors.map(e => e.message).join('; ')}`);
    this.name = 'TaskTeamConfigValidationError';
  }
}

const VALID_DELIVERY_COMMANDS: ReadonlySet<string> = new Set<TaskTeamDeliveryCommand>([
  'kickoff', 'request-review', 'nudge', 'escalate', 'report', 'finish',
  // 阶段2 领域无关动作（§2.3）
  'notify', 'wake-role', 'route-to-owner',
]);
const VALID_STATUSES: ReadonlySet<string> = new Set<TaskTeamStatus>([
  'forming', 'running', 'reviewing', 'blocked', 'awaiting-acceptance', 'done', 'archived',
]);
// 引擎 special-case、不读显式 transition 的 legacy 事件（约束2）——在这些事件上声明 transition 无效。
const TRANSITION_BLIND_LEGACY_EVENTS: ReadonlySet<string> = new Set<string>([
  'team-started', 'review-pass', 'review-reject', 'accept',
]);

/** 校验整份 config 的闭环 + 事件 registry + 显式 transition 红线。纯函数、无 IO，可单测。 */
export function validateTaskTeamConfig(config: TaskTeamConfigFile): TaskTeamConfigValidation {
  const issues: TaskTeamConfigIssue[] = [];
  const roleIds = new Set(config.roles.map(r => r.roleId));
  const ruleById = new Map(config.rules.map(r => [r.ruleId, r]));

  for (const type of config.teamTypes) {
    validateType(type, config, roleIds, ruleById, issues);
  }

  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');
  return { ok: errors.length === 0, errors, warnings, issues };
}

function validateType(
  type: TaskTeamType,
  config: TaskTeamConfigFile,
  roleIds: ReadonlySet<string>,
  ruleById: ReadonlyMap<string, TaskTeamCollabRule>,
  issues: TaskTeamConfigIssue[],
): void {
  const add = (severity: TaskTeamConfigIssue['severity'], code: string, message: string, ruleId?: string) =>
    issues.push({ severity, code, message: `[type ${type.typeId}] ${message}`, typeId: type.typeId, ruleId });

  const slotIds = new Set(type.roleSlots.map(s => s.slotId));
  const roleOfSlot = (slotId: string | undefined): string | undefined =>
    slotId === undefined ? undefined : type.roleSlots.find(s => s.slotId === slotId)?.roleId;

  // 1. roleSlot.roleId 闭合
  for (const slot of type.roleSlots) {
    if (!roleIds.has(slot.roleId)) {
      add('warning', 'slot-role-missing', `roleSlot ${slot.slotId} 引用的角色 ${slot.roleId} 不在 config.roles`);
    }
  }

  // 2. policy.reviewOrder 闭合
  for (const s of type.policy.reviewOrder) {
    if (!slotIds.has(s)) add('warning', 'review-order-slot-missing', `policy.reviewOrder 引用的席位 ${s} 不在本 type.roleSlots`);
  }

  const known = knownEventsForType(type);
  const declaredEventTypes = new Set((type.events ?? []).map(d => d.type));
  const timerEvents = timerEventsForType(type); // clock 产出（stall + 自定义 timer）——judge 不可产
  const referencedRules: TaskTeamCollabRule[] = [];

  // 2b. judge 受限数据槽 outputEventRegistry 校验（阶段2 §2.2，reviewer Medium：fail-closed 配套提示）：
  //   - 每个 registry 条目都该 ∈ 该 type 的「可判读集」（detectableEventsForType）；不在 = typo → warning。
  //   - 收窄后交集为空（detect 已 fail-closed 成空允许集、judge 啥都产不出）→ warning，别让 typo 静默成「永远零事件」。
  const registry = type.judge?.outputEventRegistry;
  if (registry && registry.length) {
    const detectable = detectableEventsForType(type);
    const intersect = registry.filter(e => detectable.has(e));
    for (const e of registry) {
      if (!detectable.has(e)) {
        add('warning', 'judge-output-registry-unknown', `judge.outputEventRegistry 的 "${e}" 不在本 type 可判读事件集（typo / 未声明 behavior）——收窄白名单会忽略它`);
      }
    }
    if (intersect.length === 0) {
      add('warning', 'judge-output-registry-empty', `judge.outputEventRegistry 与可判读集交集为空——fail-closed 后 judge 永远产不出事件（疑似全 typo）`);
    }
  }

  // 3. type.rules 闭合 + 逐条规则校验
  for (const ruleId of type.rules) {
    const rule = ruleById.get(ruleId);
    if (!rule) {
      add('warning', 'rule-missing', `type.rules 引用的规则 ${ruleId} 不在 config.rules`, ruleId);
      continue;
    }
    referencedRules.push(rule);

    // 3a. whoSlot / fromSlotId 闭合
    if (!slotIds.has(rule.whoSlot)) add('warning', 'rule-whoslot-missing', `规则 ${ruleId} 的 whoSlot ${rule.whoSlot} 不在本 type.roleSlots`, ruleId);
    if (rule.when.fromSlotId !== undefined && !slotIds.has(rule.when.fromSlotId)) {
      add('warning', 'rule-fromslot-missing', `规则 ${ruleId} 的 when.fromSlotId ${rule.when.fromSlotId} 不在本 type.roleSlots`, ruleId);
    }
    // 3a-2. external/none 事件无可靠 fromSlot（阶段2 §2.2 High）——依赖 when.fromSlotId 的 rule 引用它=永远不命中
    //   （引擎按 role 匹配 fromSlot，external 事件无 fromSlotId）→ error，杜绝静默零事件。
    if (rule.when.fromSlotId !== undefined) {
      const evAttr = attributionForEvent(type, rule.when.event);
      if (evAttr !== 'role') {
        add('error', 'external-event-fromslot', `规则 ${ruleId} 依赖 when.fromSlotId 但事件 "${rule.when.event}" attribution=${evAttr}（external/none 无可靠 fromSlot，引擎永不命中）`, ruleId);
      }
    }

    // 3b. do 合法
    if (!VALID_DELIVERY_COMMANDS.has(rule.do)) add('error', 'rule-bad-command', `规则 ${ruleId} 的 do "${rule.do}" 不是合法投递命令`, ruleId);

    // 3c. when.event 校验（修 reviewer P1-b：区分 typo 与「声明了却没接线 producer」）：
    //   - 不在事件 registry（内置 ∪ type.events）= typo → **error**（硬约束「typo 在 validator 报错而非静默丢」，阻断落库）。
    //   - 已知但无已接线 producer（如自定义 timer/lifecycle，阶段1 未接 clock/引擎）= 配着对、运行永远零事件 → **warning**。
    if (!known.has(rule.when.event)) {
      add('error', 'event-unknown', `规则 ${ruleId} 的 when.event "${rule.when.event}" 不在事件 registry（typo；内置集与 type.events 均未声明）`, ruleId);
    } else if (!isProducibleForType(type, rule.when.event)) {
      add('warning', 'event-no-producer', `规则 ${ruleId} 的 when.event "${rule.when.event}" 已声明但无已接线 producer（阶段1 只接 behavior 生产路径；自定义 timer/lifecycle 暂不产出）——配着对、运行永远零事件`, ruleId);
    }

    // 3d. 显式 transition 校验
    if (rule.transition) {
      if (!VALID_STATUSES.has(rule.transition.status)) {
        add('error', 'transition-bad-status', `规则 ${ruleId} 的 transition.status "${rule.transition.status}" 不是合法状态`, ruleId);
      }
      if (TRANSITION_BLIND_LEGACY_EVENTS.has(rule.when.event)) {
        add('warning', 'transition-on-legacy', `规则 ${ruleId} 在 legacy 事件 "${rule.when.event}" 上声明 transition——引擎 special case 不读，无效（迁移留阶段4）`, ruleId);
      }
      // 3d-2. 停滞/计时触发器防重复刷（reviewer Medium）：timer 事件（stall 等）由 clock 反复到点产出，
      //   若其规则 transition 回到一个**仍能命中本规则**的状态（transition.status === when.status，或 when.status
      //   未指定=任意状态都命中），停滞窗内会被反复触发刷状态/刷升级 → 报错，要求把 transition 指到一个不再命中的终态。
      if (timerEvents.has(rule.when.event)) {
        const staysMatchable = rule.when.status === undefined || rule.transition.status === rule.when.status;
        if (staysMatchable) {
          add('error', 'timer-transition-self-loop', `规则 ${ruleId}（计时事件 "${rule.when.event}"）的 transition 回到仍可命中本规则的状态（${rule.transition.status}）——clock 反复到点会重复触发，必须指到不再命中的状态`, ruleId);
        }
      }
    }

    // 3e. 迁移红线（修 reviewer 三问#2）：自定义事件 + do=request-review + 无显式 transition →
    //     会被 default 分支旧隐式拽进 reviewing 两层 review 状态机。非开发型任务多半不想要，提醒显式声明 transition。
    if (!rule.transition && rule.do === 'request-review' && declaredEventTypes.has(rule.when.event)) {
      add('warning', 'custom-request-review-no-transition', `规则 ${ruleId}（自定义事件 "${rule.when.event}"）do=request-review 且未声明 transition——会被隐式拽进 reviewing；非两层 review 场景请显式声明 transition`, ruleId);
    }
  }

  // 4. 显式 transition 互斥（约束2）：同一事件可同时命中的多条规则若声明互斥 transition → 报错。
  checkTransitionConflicts(referencedRules, roleOfSlot, add);
}

/** 同一事件下、可同时命中（status/fromSlot 重叠）的多条规则若声明 distinct transition.status > 1 → 报错（一次事件 0 或 1 个 transition）。 */
function checkTransitionConflicts(
  rules: TaskTeamCollabRule[],
  roleOfSlot: (slotId: string | undefined) => string | undefined,
  add: (severity: TaskTeamConfigIssue['severity'], code: string, message: string, ruleId?: string) => void,
): void {
  const withTransition = rules.filter(r => r.transition);
  for (let i = 0; i < withTransition.length; i++) {
    for (let j = i + 1; j < withTransition.length; j++) {
      const a = withTransition[i];
      const b = withTransition[j];
      if (a.when.event !== b.when.event) continue;
      // status 重叠：任一未指定 或 相等
      const statusOverlap = a.when.status === undefined || b.when.status === undefined || a.when.status === b.when.status;
      // fromSlot 按 role 重叠：任一未指定 或 同角色
      const fromOverlap =
        a.when.fromSlotId === undefined || b.when.fromSlotId === undefined ||
        roleOfSlot(a.when.fromSlotId) === roleOfSlot(b.when.fromSlotId);
      if (statusOverlap && fromOverlap && a.transition!.status !== b.transition!.status) {
        add(
          'error',
          'transition-conflict',
          `规则 ${a.ruleId} 与 ${b.ruleId} 在事件 "${a.when.event}" 上可同时命中、却声明互斥 transition（${a.transition!.status} vs ${b.transition!.status}）——一次事件状态 transition 必须 0 或 1 个`,
          a.ruleId,
        );
      }
    }
  }
}

/** 写路径守卫：有 error 抛 TaskTeamConfigValidationError（阻断落库）；warning 交由调用方记日志。返回 warnings。 */
export function assertValidTaskTeamConfig(config: TaskTeamConfigFile): TaskTeamConfigIssue[] {
  const { errors, warnings } = validateTaskTeamConfig(config);
  if (errors.length) throw new TaskTeamConfigValidationError(errors);
  return warnings;
}
