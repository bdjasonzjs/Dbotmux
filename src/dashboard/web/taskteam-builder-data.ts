// 任务小组 · 配置器数据层（v3.1 §7 / §8.2 配置器迁移）——表单值 → §2 schema 对象 + admin IPC envelope。
// 纯函数、无 DOM 依赖、node 可单测；全程不碰 JSON 文本（用户填表单，这里组装 schema）。

import type {
  TaskTeamActionType,
  TaskTeamCollabRule,
  TaskTeamDeliveryCommand,
  TaskTeamRole,
  TaskTeamType,
  TaskTeamVisibility,
} from '../../services/taskteam-schema.js';

export class TaskTeamBuilderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskTeamBuilderError';
  }
}

function splitList(s: string | undefined): string[] {
  return (s ?? '').split(',').map(x => x.trim()).filter(Boolean);
}

export interface RoleForm {
  roleId: string;
  name: string;
  responsibility: string;
  activationTrigger: string;
  visibility: TaskTeamVisibility;
  actions: string; // 逗号分隔 TaskTeamActionType
  fromRoleIds?: string; // 逗号分隔
  toRoleIds?: string;
  model?: string;
  reasoningEffort?: string;
  seatEngine?: string;
  isObserver?: boolean;
}

export function buildRolePayload(form: RoleForm): { role: TaskTeamRole } {
  const role: TaskTeamRole = {
    roleId: form.roleId as TaskTeamRole['roleId'],
    name: form.name,
    responsibility: form.responsibility,
    activation: { trigger: form.activationTrigger || 'team-started' },
    visibility: form.visibility,
    actions: splitList(form.actions) as TaskTeamActionType[],
    io: {
      from: splitList(form.fromRoleIds).map(roleId => ({ roleId: roleId as TaskTeamRole['roleId'] })),
      to: splitList(form.toRoleIds).map(roleId => ({ roleId: roleId as TaskTeamRole['roleId'] })),
    },
    ...(form.model || form.reasoningEffort ? { model: { model: form.model || undefined, reasoningEffort: form.reasoningEffort || undefined } } : {}),
    ...(form.seatEngine ? { seatHint: { engine: form.seatEngine } } : {}),
    ...(form.isObserver ? { isObserver: true } : {}),
  };
  return { role };
}

export interface RuleForm {
  ruleId: string;
  whenEvent: string;
  whenStatus?: string;
  whenFromSlotId?: string;
  whoSlot: string;
  do: TaskTeamDeliveryCommand;
}

export function buildRulePayload(form: RuleForm): { rule: TaskTeamCollabRule } {
  const rule: TaskTeamCollabRule = {
    ruleId: form.ruleId as TaskTeamCollabRule['ruleId'],
    when: {
      event: form.whenEvent,
      ...(form.whenStatus ? { status: form.whenStatus as TaskTeamCollabRule['when']['status'] } : {}),
      ...(form.whenFromSlotId ? { fromSlotId: form.whenFromSlotId as TaskTeamCollabRule['when']['fromSlotId'] } : {}),
    },
    whoSlot: form.whoSlot as TaskTeamCollabRule['whoSlot'],
    do: form.do,
  };
  return { rule };
}

export interface TypeForm {
  typeId: string;
  name: string;
  // "slotId:roleId[:label]" 逗号分隔 —— 拖角色生成稳定 slot
  slots: string;
  rules?: string; // ruleId 逗号分隔
  reviewRounds: number;
  reviewQuorum: number;
  maxRework: number;
  escalateAfterStallMs: number;
  reviewOrder?: string; // slotId 逗号分隔
}

export function buildTypePayload(form: TypeForm): { teamType: TaskTeamType } {
  const roleSlots = splitList(form.slots).map(entry => {
    const [slotId, roleId, label] = entry.split(':').map(s => s.trim());
    // P2：席位语法本地形态校验——必须非空 slotId + roleId，避免缺 roleId 的坏 roleSlot 落库
    if (!slotId || !roleId) {
      throw new TaskTeamBuilderError(`席位格式应为 slotId:roleId[:label]，无效项：「${entry}」`);
    }
    return {
      slotId: slotId as TaskTeamType['roleSlots'][number]['slotId'],
      roleId: roleId as TaskTeamType['roleSlots'][number]['roleId'],
      ...(label ? { label } : {}),
    };
  });
  const teamType: TaskTeamType = {
    typeId: form.typeId as TaskTeamType['typeId'],
    name: form.name,
    roleSlots,
    rules: splitList(form.rules) as TaskTeamType['rules'],
    policy: {
      reviewRounds: Number(form.reviewRounds) || 0,
      reviewQuorum: Number(form.reviewQuorum) || 1,
      maxRework: Number(form.maxRework) || 0,
      escalateAfterStallMs: Number(form.escalateAfterStallMs) || 0,
      reviewOrder: splitList(form.reviewOrder) as TaskTeamType['policy']['reviewOrder'],
    },
  };
  return { teamType };
}

export type SaveFetch = (path: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** POST envelope 到 admin IPC；区分成功 / 错误（含 400/500），不静默吞。 */
export async function postAdmin(
  path: string,
  body: Record<string, unknown>,
  fetchImpl: SaveFetch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let res: { ok: boolean; status: number; text: () => Promise<string> };
  try {
    res = await fetchImpl(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (err) {
    return { ok: false, error: `请求失败：${String(err)}` };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, error: `HTTP ${res.status}${detail ? `：${detail}` : ''}` };
  }
  return { ok: true };
}
