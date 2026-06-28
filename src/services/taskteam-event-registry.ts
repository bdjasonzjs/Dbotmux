// 任务小组 · 事件 registry（阶段1 内核②）——把「事件类型」从 TS union 写死 + observer 固定白名单，
// 升级成「按 type 可声明 + 运行时 string + 校验兜底」。
//
// 设计要点（设计 §5 阶段1②、§8 约束）：
//  - 不裸字符串化：内置事件集仍是 TaskTeamEventType union 的运行时镜像（单一事实源 + 类型安全兜底），
//    生成类型/既有测试照常保护；自定义事件经 TaskTeamType.events 显式声明才进入「已知集」。
//  - 生产侧可产出新类型：detectableEventsForType() 把 type 声明的 behavior 事件并入判读白名单，
//    让 observer judge → mapBehaviorToEvent 能产出新声明的事件（"加新事件不用改引擎"在生产侧成立）。
//  - 校验兜底：validator 用 knownEventsForType()/producibleEventsForType() 查 typo + "声明了却无人产出"，
//    typo 在 validator 报错而非运行时静默丢。

import type { TaskTeamEventType } from './taskteam-engine.js';
import type { TaskTeamEventDecl, TaskTeamType } from './taskteam-schema.js';

// 事件的「产出方」：谁能在运行时真正产生该事件——validator 用它做生产侧覆盖检查。
// canonical 声明 shape 在 taskteam-schema.ts（TaskTeamType.events 引用），此处只取其 producer 字段类型。
export type TaskTeamEventProducer = TaskTeamEventDecl['producer'];
export type { TaskTeamEventDecl };

// 内置生命周期事件：由引擎显式入口 / 内部驱动产出（不经 observer judge 伪造）。
export const BUILTIN_LIFECYCLE_EVENT_TYPES: ReadonlySet<TaskTeamEventType> = new Set<TaskTeamEventType>([
  'team-started',
  'accept',
  'review-pass',
  'review-reject',
  'rework',
]);

// observer judge **可判读**产出的角色行为子集（消息派生事件）。
// ⚠️ 阶段2 修 reviewer Blocker：`stall` **不在此集**——stall 是计时/停滞事件，只能由 clock（maybeStallEvent）
// 产出，**绝不许 LLM judge 伪造**（否则块3「真由 clock 产」claim 被打脸）。stall 只登记在 TIMER 集。
export const BUILTIN_DETECTABLE_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  'submit',
  'review-pass',
  'review-reject',
  'ask-help',
  'report',
  'consult',
  'escalate',
]);

// 廉价 gate / clock 产出的无消息事件（stall 由 observer stall gate 接 type.policy.escalateAfterStallMs 产出）。
// 这些事件**不进 judge detectable 集**——judge 输出的同名事件在 detect 层被显式丢弃。
export const BUILTIN_TIMER_EVENT_TYPES: ReadonlySet<string> = new Set<string>(['stall']);

// 全部内置已知事件（TaskTeamEventType union 的运行时镜像）——validator typo 检测的兜底基线。
export const BUILTIN_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  ...BUILTIN_LIFECYCLE_EVENT_TYPES,
  ...BUILTIN_DETECTABLE_EVENT_TYPES,
  ...BUILTIN_TIMER_EVENT_TYPES,
]);

type TypeWithEvents = Pick<TaskTeamType, 'events'>;

/** 某 type 的「已知事件集」= 内置 ∪ type.events 声明。validator 据此判 when.event 是否 typo（未知 = 报错）。 */
export function knownEventsForType(type: TypeWithEvents): ReadonlySet<string> {
  const set = new Set<string>(BUILTIN_EVENT_TYPES);
  for (const d of type.events ?? []) set.add(d.type);
  return set;
}

/** 某 type 的「可判读事件集」（生产侧·judge）= 内置 detectable ∪ type.events 里 producer==='behavior' 的声明。 */
export function detectableEventsForType(type: TypeWithEvents): ReadonlySet<string> {
  const set = new Set<string>(BUILTIN_DETECTABLE_EVENT_TYPES);
  for (const d of type.events ?? []) if (d.producer === 'behavior') set.add(d.type);
  return set;
}

/** 某 type 的「无消息事件集」（clock/gate 产出，detect 用 window/episode id 作来源）= 内置 timer ∪ type.events 里 producer==='timer' 的声明。 */
export function timerEventsForType(type: TypeWithEvents): ReadonlySet<string> {
  const set = new Set<string>(BUILTIN_TIMER_EVENT_TYPES);
  for (const d of type.events ?? []) if (d.producer === 'timer') set.add(d.type);
  return set;
}

/**
 * 某事件在该 type 下「是否有**已接线**产出方」——validator 覆盖生产侧：被规则引用却无任何 trigger/judge/clock
 * 能产出 → 配着对、运行永远零事件。producible = 内置生命周期（引擎产出）∪ 可判读(内置 behavior + 声明 behavior，
 * judge 产出) ∪ 内置 timer（stall，judge/clock 产出）。
 * **注意**：阶段1 只接了 behavior 生产路径——自定义 timer/lifecycle 事件即便在 type.events 声明，也**不算 producible**
 * （clock/引擎特化未接线），validator 会把「声明了却没真实 producer」报出来（修 reviewer P1-b：声明 ≠ 已接线）。
 */
export function isProducibleForType(type: TypeWithEvents, eventType: string): boolean {
  if (BUILTIN_LIFECYCLE_EVENT_TYPES.has(eventType as TaskTeamEventType)) return true;
  if (detectableEventsForType(type).has(eventType)) return true;
  if (BUILTIN_TIMER_EVENT_TYPES.has(eventType)) return true;
  return false;
}
