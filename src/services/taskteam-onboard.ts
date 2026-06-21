// 任务小组 · 新手引导（v3.1 §9 / 设计 10.3 A→G）——搭出能跑的"一人公司"。
// 复用 group-creator / bot-clone / ceo-spawn（不改被复用基建）；引导编排在此新增。
// 规划（planOnboarding）纯函数、可单测：算骨架步骤 + 席位分配 + bot 缺口「已 X 还差 Y」；Observer 优先分便宜引擎。

import { defaultTaskTeamSeed } from './taskteam-config-store.js';
import type {
  TaskTeamConfigFile,
  TaskTeamInstance,
  TaskTeamRoleInstance,
  TaskTeamType,
} from './taskteam-schema.js';

export interface OnboardingBot {
  larkAppId: string;
  botName: string;
  botOpenId?: string;
}

export interface OnboardingSeat {
  slotId: string;
  roleId: string;
  label?: string;
  observer: boolean;
  assignedBot?: OnboardingBot;
}

export type OnboardingStepStatus = 'auto' | 'needs-bots' | 'manual';
export interface OnboardingStep {
  id: 'invite' | 'skeleton' | 'sample-team' | 'bot-gap' | 'assign-roles' | 'dry-run' | 'handoff';
  label: string;
  status: OnboardingStepStatus;
}

export interface OnboardingPlan {
  companyName: string;
  sampleTypeId: string;
  seats: OnboardingSeat[];
  botGap: { needed: number; available: number; short: number };
  ready: boolean; // 角色到齐（每个席位都有 bot）才开工
  steps: OnboardingStep[];
}

const CHEAP_ENGINE_RE = /coco|trae|tilly|haiku/i;

/**
 * 规划新手引导：选示例小组类型（config 有就用、否则 seed 两层 review），把席位分给可用 bot，
 * Observer 优先拿便宜引擎 bot（§7 省钱），算出 bot 缺口「已 available 还差 short」。纯函数。
 */
export function planOnboarding(opts: {
  config: TaskTeamConfigFile;
  availableBots: OnboardingBot[];
  sampleTypeId?: string;
  companyName?: string;
}): OnboardingPlan {
  const seed = defaultTaskTeamSeed();
  const types: TaskTeamType[] = opts.config.teamTypes.length ? opts.config.teamTypes : seed.teamTypes;
  const roles = opts.config.roles.length ? opts.config.roles : seed.roles;
  const type = (opts.sampleTypeId ? types.find(t => t.typeId === opts.sampleTypeId) : types[0]) ?? types[0];
  const isObserver = (roleId: string) => !!roles.find(r => r.roleId === roleId)?.isObserver;

  const seats: OnboardingSeat[] = type.roleSlots.map(slot => ({
    slotId: slot.slotId,
    roleId: slot.roleId,
    label: slot.label,
    observer: isObserver(slot.roleId),
  }));

  // 分配 bot：先给 Observer 席分便宜引擎 bot（§7 省钱），再把其余 bot 按序分给非 observer 席
  const pool = [...opts.availableBots];
  const takeCheap = (): OnboardingBot | undefined => {
    const i = pool.findIndex(b => CHEAP_ENGINE_RE.test(b.botName));
    return i >= 0 ? pool.splice(i, 1)[0] : pool.shift();
  };
  for (const seat of seats.filter(s => s.observer)) {
    if (pool.length) seat.assignedBot = takeCheap();
  }
  for (const seat of seats.filter(s => !s.observer)) {
    if (pool.length) seat.assignedBot = pool.shift();
  }

  const needed = seats.length;
  const available = Math.min(opts.availableBots.length, needed);
  const short = Math.max(0, needed - opts.availableBots.length);
  const ready = seats.every(s => !!s.assignedBot);

  const steps: OnboardingStep[] = [
    { id: 'invite', label: '头回私聊邀请（CEO=私聊 bot）', status: 'manual' },
    { id: 'skeleton', label: '自动搭骨架（管理办公室 root 群 + 体验部门）', status: 'auto' },
    { id: 'sample-team', label: '建示例小组（执行 + 把关 + 盯梢）', status: ready ? 'auto' : 'needs-bots' },
    { id: 'bot-gap', label: short > 0 ? `盘点 bot：已 ${available} 还差 ${short}（引导克隆补齐）` : '盘点 bot：已齐', status: short > 0 ? 'needs-bots' : 'auto' },
    { id: 'assign-roles', label: '指派角色（Observer 设便宜引擎）+ 检查到齐', status: ready ? 'auto' : 'needs-bots' },
    { id: 'dry-run', label: '带小目标当场跑通（交活→把关→完成）', status: ready ? 'auto' : 'needs-bots' },
    { id: 'handoff', label: '告知日后运营', status: 'manual' },
  ];

  return {
    companyName: opts.companyName ?? '一人公司',
    sampleTypeId: type.typeId,
    seats,
    botGap: { needed, available, short },
    ready,
    steps,
  };
}

// —— 引导编排（执行计划，复用批3 createTaskTeam）——

export interface OnboardingDeps {
  ensureSeed(): Promise<void>; // config 为空时种默认配置
  getConfig(): TaskTeamConfigFile;
  createSampleTeam(params: {
    typeId: string;
    companyId: string;
    goal: string;
    acceptance: string;
    roleInstances: TaskTeamRoleInstance[];
    creatorLarkAppId: string;
  }): Promise<TaskTeamInstance>;
}

export interface OnboardingResult {
  plan: OnboardingPlan;
  created: TaskTeamInstance | null; // bot 不足时不建，返回 null + 缺口让用户先克隆
  message: string;
}

export async function runOnboarding(
  deps: OnboardingDeps,
  opts: { availableBots: OnboardingBot[]; creatorLarkAppId: string; companyId?: string; goal?: string },
): Promise<OnboardingResult> {
  await deps.ensureSeed();
  const plan = planOnboarding({ config: deps.getConfig(), availableBots: opts.availableBots });

  if (!plan.ready) {
    return {
      plan,
      created: null,
      message: `bot 不足：已 ${plan.botGap.available} 还差 ${plan.botGap.short}。请先克隆补齐（ceo-spawn 扫码激活），再重跑 onboard。`,
    };
  }

  const roleInstances: TaskTeamRoleInstance[] = plan.seats.map((seat, i) => ({
    roleInstanceId: `tt_ri_onboard_${i}` as TaskTeamRoleInstance['roleInstanceId'],
    slotId: seat.slotId as TaskTeamRoleInstance['slotId'],
    roleId: seat.roleId as TaskTeamRoleInstance['roleId'],
    binding: {
      bindingId: `tt_binding_onboard_${i}` as never,
      botOpenId: seat.assignedBot!.botOpenId ?? seat.assignedBot!.larkAppId,
      larkAppId: seat.assignedBot!.larkAppId,
    },
  }));

  const created = await deps.createSampleTeam({
    typeId: plan.sampleTypeId,
    companyId: (opts.companyId ?? 'tt_company_onboard') as string,
    goal: opts.goal ?? '示例小目标：跑通一次「交活→把关→完成」',
    acceptance: '示例小组完整跑通一轮两层 review',
    roleInstances,
    creatorLarkAppId: opts.creatorLarkAppId,
  });

  return { plan, created, message: `已建示例小组 ${created.teamId}，角色到齐，可当场跑通。` };
}
