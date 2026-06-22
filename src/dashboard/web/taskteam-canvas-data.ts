// 流程化任务小组配置器 · 画布数据层（PRD §8.2）
// CanvasTeam 模型 ↔ TaskTeam schema 的映射 / 派生 / 校验，纯函数无 DOM、node 可单测。
// 设计依据：docs/taskteam-flow-config/DESIGN.md §6（连线 chip→CollabRule 映射）/§7（reviewOrder 派生）/§8（Role.io 派生）。
// 保存层复用 taskteam-builder-data.ts 的 build*Payload + postAdmin；全程不碰 JSON 文本。

import type { TaskTeamVisibility } from '../../services/taskteam-schema.js';
import {
  buildRolePayload,
  buildRulePayload,
  buildTypePayload,
  type RoleForm,
  type RuleForm,
  type TypeForm,
} from './taskteam-builder-data.js';

export type CanvasRoleKind = 'developer' | 'reviewer' | 'reporter' | 'observer' | 'custom';

/** 画布节点 = 一个席位（角色实例）。来自已存角色库（fromExisting）只新建 RoleSlot，不重建 Role。 */
export interface CanvasNode {
  slotId: string;
  roleId: string;
  kind: CanvasRoleKind;
  name: string;
  responsibility: string;
  visibility: TaskTeamVisibility;
  actions: string[];
  activationTrigger: string;
  model?: string;
  reasoningEffort?: string;
  seatEngine?: string;
  isObserver?: boolean;
  fromExisting?: boolean;
  x: number;
  y: number;
}

/** 连线 chip = 协作关系语义（DESIGN §6）。 */
export type CanvasEdgeChip = 'submit-review' | 'pass-next' | 'pass-report' | 'reject-rework';

export interface CanvasEdge {
  id: string;
  from: string; // slotId
  to: string; // slotId
  chip: CanvasEdgeChip;
}

export interface CanvasPolicy {
  reviewQuorum: number;
  maxRework: number;
  escalateAfterStallMs: number;
}

export interface CanvasTeam {
  typeId: string;
  name: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  policy: CanvasPolicy;
}

export interface ChipMeta {
  chip: CanvasEdgeChip;
  label: string;
  event: string;
  status: string;
  do: RuleForm['do'];
  /** 该 chip 是否把 when.fromSlotId 设为源席位（按 roleId 路由下一审）。 */
  carryFrom: boolean;
}

// DESIGN §6：连线 chip → CollabRule 字段精确映射。注意没有 do=rework；驳回返工真实=do=nudge。
// 超返工上限→升级不是可连线规则（maxRework 引擎内置兜底），故不在此表。
export const CHIP_META: Record<CanvasEdgeChip, ChipMeta> = {
  'submit-review': { chip: 'submit-review', label: '提交→请审', event: 'submit', status: 'running', do: 'request-review', carryFrom: false },
  'pass-next': { chip: 'pass-next', label: '通过→下一审', event: 'review-pass', status: 'reviewing', do: 'request-review', carryFrom: true },
  'pass-report': { chip: 'pass-report', label: '通过→汇报', event: 'review-pass', status: 'reviewing', do: 'report', carryFrom: true },
  'reject-rework': { chip: 'reject-rework', label: '驳回→返工', event: 'review-reject', status: 'reviewing', do: 'nudge', carryFrom: false },
};

export const ROLE_KIND_LABEL: Record<CanvasRoleKind, string> = {
  developer: '开发',
  reviewer: '审核',
  reporter: '上报',
  observer: '观察',
  custom: '自定义',
};

/**
 * DESIGN §6 运行语义约束：每种 chip 对源/目标 kind 的合法组合。
 * UI 按此限制可选 chip，保存前也据此硬校验，挡住非法/歧义拓扑。
 */
export function allowedChips(fromKind: CanvasRoleKind, toKind: CanvasRoleKind): CanvasEdgeChip[] {
  const out: CanvasEdgeChip[] = [];
  // 提交→请审：开发/提交源 → 审核席
  if (fromKind === 'developer' && toKind === 'reviewer') out.push('submit-review');
  // 通过→下一审：审核 → 审核
  if (fromKind === 'reviewer' && toKind === 'reviewer') out.push('pass-next');
  // 通过→汇报：末级审核 → 上报/开发（验收/汇报席）
  if (fromKind === 'reviewer' && (toKind === 'reporter' || toKind === 'developer')) out.push('pass-report');
  // 驳回→返工：审核 → 开发
  if (fromKind === 'reviewer' && toKind === 'developer') out.push('reject-rework');
  return out;
}

export const TYPE_ID_RE = /^tt_type_[a-z0-9][a-z0-9_-]*$/;

/** kebab 化作 id 片段；非法字符折成连字符。 */
export function idSafe(input: string, fallback: string): string {
  const cleaned = (input || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
  return cleaned || fallback;
}

export function nextId(base: string, used: Set<string>): string {
  if (!used.has(base)) { used.add(base); return base; }
  let i = 2;
  while (used.has(`${base}-${i}`)) i++;
  const id = `${base}-${i}`;
  used.add(id);
  return id;
}

/**
 * DESIGN §8：按 roleId 聚合入/出边的对端角色，派生 io.from / io.to（去重）。
 * 注意：派生结果只对**新建/自定义**角色落库（assembleSaveOps 不 upsert fromExisting 角色），
 * 已存角色拖入=只绑 RoleSlot 不重建 Role，其 io 保持库里原值不被画布改写（松松方向③：已存角色只绑不改）。
 */
export function deriveRoleIo(team: CanvasTeam): Map<string, { from: string[]; to: string[] }> {
  const slotRole = new Map(team.nodes.map(n => [n.slotId, n.roleId]));
  const acc = new Map<string, { from: Set<string>; to: Set<string> }>();
  for (const n of team.nodes) {
    if (!acc.has(n.roleId)) acc.set(n.roleId, { from: new Set(), to: new Set() });
  }
  for (const e of team.edges) {
    const fromRole = slotRole.get(e.from);
    const toRole = slotRole.get(e.to);
    if (!fromRole || !toRole) continue;
    acc.get(toRole)?.from.add(fromRole);
    acc.get(fromRole)?.to.add(toRole);
  }
  const out = new Map<string, { from: string[]; to: string[] }>();
  for (const [roleId, v] of acc) out.set(roleId, { from: [...v.from], to: [...v.to] });
  return out;
}

/**
 * DESIGN §7：reviewOrder 派生。必含首轮 reviewer——
 * reviewOrder[0] = submit→request-review 边的 target；其后沿 review-pass→request-review 逐个追加。
 */
export function deriveReviewOrder(team: CanvasTeam): string[] {
  const order: string[] = [];
  const submitEdge = team.edges.find(e => e.chip === 'submit-review');
  if (!submitEdge) return order;
  let current = submitEdge.to;
  const guard = new Set<string>();
  while (current && !guard.has(current)) {
    order.push(current);
    guard.add(current);
    const next = team.edges.find(e => e.chip === 'pass-next' && e.from === current);
    current = next ? next.to : '';
  }
  return order;
}

export interface ValidationIssue {
  level: 'error' | 'warn';
  message: string;
}

/** DESIGN §6/§7：保存前一致性校验。有 error 则禁用「打包成小组类型」。 */
export function validateCanvas(team: CanvasTeam): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!team.name.trim()) issues.push({ level: 'error', message: '请填写小组类型名称。' });
  if (!team.typeId.trim()) issues.push({ level: 'error', message: '请填写小组类型 ID。' });
  else if (!TYPE_ID_RE.test(team.typeId)) issues.push({ level: 'error', message: '类型 ID 必须形如 tt_type_xxx（小写字母数字、下划线、连字符）。' });
  if (team.nodes.length === 0) issues.push({ level: 'error', message: '画布上至少要有一个角色席位。' });

  const kindOf = new Map(team.nodes.map(n => [n.slotId, n.kind] as const));
  const nameOf = (slot: string) => team.nodes.find(n => n.slotId === slot)?.name ?? slot;

  // P1-1：每条连线的 chip 必须对源/目标 kind 合法（挡 reviewer→reviewer 标成提交→请审 等）
  for (const e of team.edges) {
    const fk = kindOf.get(e.from);
    const tk = kindOf.get(e.to);
    if (!fk || !tk) { issues.push({ level: 'error', message: '存在悬空连线（端点席位已删除）。' }); continue; }
    if (!allowedChips(fk, tk).includes(e.chip)) {
      issues.push({ level: 'error', message: `连线「${nameOf(e.from)}→${nameOf(e.to)}」的关系「${CHIP_META[e.chip].label}」与角色类型不匹配。` });
    }
  }

  const reviewers = team.nodes.filter(n => n.kind === 'reviewer');
  const submitEdges = team.edges.filter(e => e.chip === 'submit-review');

  if (reviewers.length > 0) {
    // P1-1：唯一首审入口
    if (submitEdges.length === 0) {
      issues.push({ level: 'error', message: '有审核席但缺「提交→请审」连线，首轮审核无法触发。' });
    } else if (submitEdges.length > 1) {
      issues.push({ level: 'error', message: `只能有一条「提交→请审」首审入口，当前有 ${submitEdges.length} 条，运行时会同时投递多条首审。` });
    }

    // P1-1：「通过」出口唯一——**按 roleId cohort 计**，不是按席位。
    // 引擎按 roleId 路由 when.fromSlotId（engine.ts:95），同 role 的多个票席（quorum cohort）
    // 在引擎眼里是同一来源；若每个同 role 票席都画一条 pass-report/pass-next，review-pass 时
    // 会同时命中多条 report/下一审规则。所以一个审核角色（cohort）整体只能有 1 条「通过」出口。
    const slotRoleId = new Map(team.nodes.map(n => [n.slotId, n.roleId] as const));
    const reviewerRoleIds = new Set(reviewers.map(r => r.roleId));
    const roleName = (roleId: string) => reviewers.find(r => r.roleId === roleId)?.name || roleId;
    for (const roleId of reviewerRoleIds) {
      const passOut = team.edges.filter(e => (e.chip === 'pass-next' || e.chip === 'pass-report') && slotRoleId.get(e.from) === roleId);
      if (passOut.length > 1) {
        issues.push({ level: 'error', message: `审核角色「${roleName(roleId)}」有多个「通过」出口（含同角色多票席各自连线），引擎按角色路由会同时触发多条规则——一个审核角色整体只能连 1 条 通过→下一审 或 通过→汇报。` });
      } else if (passOut.length === 0) {
        issues.push({ level: 'error', message: `审核角色「${roleName(roleId)}」缺「通过」出口（该角色应有 1 条 通过→下一审 或 通过→汇报）。` });
      }
    }

    // P1-1：审核链无环——从首审席沿 pass-next 走，命中已访问节点即成环。
    const passNextOf = new Map<string, string>();
    for (const e of team.edges) {
      if (e.chip === 'pass-next') passNextOf.set(e.from, e.to);
    }
    {
      const visited = new Set<string>();
      let cur: string | undefined = submitEdges[0]?.to;
      let cyclic = false;
      while (cur) {
        if (visited.has(cur)) { cyclic = true; break; }
        visited.add(cur);
        cur = passNextOf.get(cur);
      }
      if (cyclic) issues.push({ level: 'error', message: '审核链成环（沿「通过→下一审」回到了已经过的审核席），流程无法收敛。' });
    }

    const reviewOrder = deriveReviewOrder(team);
    const chainSet = new Set(reviewOrder);

    // 末级审核席必须有 →report 出边到验收
    if (reviewOrder.length > 0) {
      const lastReviewer = reviewOrder[reviewOrder.length - 1]!;
      const hasReport = team.edges.some(e => e.chip === 'pass-report' && e.from === lastReviewer);
      if (!hasReport) {
        issues.push({ level: 'error', message: '末级审核席缺「通过→汇报」出边，流程跑到末层会卡死。' });
      }
    }

    // P1-1：所有 reviewer 要么在主链上，要么作为同 roleId 的 quorum cohort 支持链上某审
    const chainRoles = new Set(reviewOrder.map(s => team.nodes.find(n => n.slotId === s)?.roleId));
    for (const r of reviewers) {
      if (chainSet.has(r.slotId)) continue;
      if (chainRoles.has(r.roleId)) continue; // 同角色多席=quorum cohort
      issues.push({ level: 'error', message: `审核席「${r.name || r.slotId}」不在审核链上（既非主链节点，也不是链上某审的同角色票席）。` });
    }

    // 每个审核角色（cohort）应有 驳回→返工 回开发（按 roleId 计，同角色票席共用一条即可）
    for (const roleId of reviewerRoleIds) {
      const hasReject = team.edges.some(e => e.chip === 'reject-rework' && slotRoleId.get(e.from) === roleId);
      if (!hasReject) {
        issues.push({ level: 'warn', message: `审核角色「${roleName(roleId)}」缺「驳回→返工」出边，驳回时无去向。` });
      }
    }
  }

  // reviewQuorum ≤ 同角色席位数（按 reviewer 角色聚合的最大 cohort）
  const reviewerRoleCount = new Map<string, number>();
  for (const r of reviewers) reviewerRoleCount.set(r.roleId, (reviewerRoleCount.get(r.roleId) ?? 0) + 1);
  const maxCohort = Math.max(1, ...[...reviewerRoleCount.values()]);
  if (team.policy.reviewQuorum > maxCohort) {
    issues.push({ level: 'error', message: `通过票数(${team.policy.reviewQuorum}) 超过同角色审核席数(${maxCohort})，永远无法达成。` });
  }

  // 孤儿节点（无任何连线，且非观察席）告警
  const linked = new Set<string>();
  for (const e of team.edges) { linked.add(e.from); linked.add(e.to); }
  for (const n of team.nodes) {
    if (!linked.has(n.slotId) && !n.isObserver && n.kind !== 'observer') {
      issues.push({ level: 'warn', message: `席位「${n.name || n.slotId}」没有任何连线。` });
    }
  }
  return issues;
}

export interface SaveOp {
  path: string;
  payload: Record<string, unknown>;
  label: string;
}

/**
 * 组装保存操作：N 个 role-upsert（仅非 fromExisting）+ N 个 rule-upsert + 1 个 type-upsert。
 * 复用 build*Payload；Role.io 由画布边派生（DESIGN §8）。
 */
export function assembleSaveOps(team: CanvasTeam): SaveOp[] {
  const ops: SaveOp[] = [];
  const io = deriveRoleIo(team);

  // 1) roles —— 已存角色不重建，只用其 roleId
  const emittedRoles = new Set<string>();
  for (const n of team.nodes) {
    if (n.fromExisting) continue;
    if (emittedRoles.has(n.roleId)) continue;
    emittedRoles.add(n.roleId);
    const rio = io.get(n.roleId) ?? { from: [], to: [] };
    const form: RoleForm = {
      roleId: n.roleId,
      name: n.name,
      responsibility: n.responsibility,
      activationTrigger: n.activationTrigger || 'team-started',
      visibility: n.visibility,
      actions: n.actions.join(','),
      fromRoleIds: rio.from.join(','),
      toRoleIds: rio.to.join(','),
      model: n.model,
      reasoningEffort: n.reasoningEffort,
      seatEngine: n.seatEngine,
      isObserver: n.isObserver,
    };
    ops.push({ path: '/api/taskteam-role-upsert', payload: buildRolePayload(form) as unknown as Record<string, unknown>, label: `角色 ${n.name || n.roleId}` });
  }

  // 2) rules —— 每条连线一条规则（reject→escalate 不产出，超限升级是 maxRework 内置兜底）
  const ruleIds: string[] = [];
  const usedRule = new Set<string>();
  for (const e of team.edges) {
    const meta = CHIP_META[e.chip];
    const fromNode = team.nodes.find(n => n.slotId === e.from);
    const ruleId = nextId(`tt_rule_${idSafe(e.chip, 'edge')}_${idSafe(e.to, 't')}`, usedRule);
    ruleIds.push(ruleId);
    const form: RuleForm = {
      ruleId,
      whenEvent: meta.event,
      whenStatus: meta.status,
      whenFromSlotId: meta.carryFrom && fromNode ? e.from : undefined,
      whoSlot: e.to,
      do: meta.do,
    };
    ops.push({ path: '/api/taskteam-rule-upsert', payload: buildRulePayload(form) as unknown as Record<string, unknown>, label: `规则 ${meta.label}` });
  }

  // 3) type —— roleSlots + rules + policy（reviewOrder/reviewRounds 派生）
  const reviewOrder = deriveReviewOrder(team);
  const slots = team.nodes.map(n => `${n.slotId}:${n.roleId}${n.name ? `:${n.name}` : ''}`).join(',');
  const typeForm: TypeForm = {
    typeId: team.typeId,
    name: team.name,
    slots,
    rules: ruleIds.join(','),
    reviewRounds: reviewOrder.length,
    reviewQuorum: team.policy.reviewQuorum,
    maxRework: team.policy.maxRework,
    escalateAfterStallMs: team.policy.escalateAfterStallMs,
    reviewOrder: reviewOrder.join(','),
  };
  ops.push({ path: '/api/taskteam-type-upsert', payload: buildTypePayload(typeForm) as unknown as Record<string, unknown>, label: `类型 ${team.name}` });
  return ops;
}

export interface ExistingRoleOption {
  roleId: string;
  name: string;
  responsibility: string;
  visibility: TaskTeamVisibility;
  actions: string[];
  isObserver?: boolean;
  model?: string;
  reasoningEffort?: string;
  seatEngine?: string;
}

/** 读已存角色库（DESIGN §9 调色板「已存角色」栏）；接口 /api/taskteam-config-list 已存在。 */
export async function loadExistingRoles(
  fetchImpl: (path: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>,
): Promise<ExistingRoleOption[]> {
  try {
    const res = await fetchImpl('/api/taskteam-config-list');
    if (!res.ok) return [];
    const cfg = (await res.json()) as { roles?: Array<Record<string, unknown>> };
    const roles = Array.isArray(cfg.roles) ? cfg.roles : [];
    return roles.map(r => ({
      roleId: String(r.roleId ?? ''),
      name: String(r.name ?? r.roleId ?? ''),
      responsibility: String(r.responsibility ?? ''),
      visibility: (r.visibility as TaskTeamVisibility) ?? 'full',
      actions: Array.isArray(r.actions) ? (r.actions as string[]) : [],
      isObserver: Boolean(r.isObserver),
      model: (r.model as { model?: string } | undefined)?.model,
      reasoningEffort: (r.model as { reasoningEffort?: string } | undefined)?.reasoningEffort,
      seatEngine: (r.seatHint as { engine?: string } | undefined)?.engine,
    })).filter(r => r.roleId);
  } catch {
    return [];
  }
}
