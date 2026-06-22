import { describe, expect, it } from 'vitest';
import {
  allowedChips,
  assembleSaveOps,
  deriveReviewOrder,
  deriveRoleIo,
  validateCanvas,
  type CanvasTeam,
} from '../src/dashboard/web/taskteam-canvas-data.js';

function team(over: Partial<CanvasTeam> = {}): CanvasTeam {
  return {
    typeId: 'tt_type_t',
    name: '测试小组',
    policy: { reviewQuorum: 1, maxRework: 2, escalateAfterStallMs: 1000 },
    nodes: [
      { slotId: 'tt_slot_dev', roleId: 'tt_role_dev', kind: 'developer', name: '开发', responsibility: '', visibility: 'full', actions: ['submit'], activationTrigger: 'team-started', x: 0, y: 0 },
      { slotId: 'tt_slot_rev', roleId: 'tt_role_rev', kind: 'reviewer', name: '审核', responsibility: '', visibility: 'review-only', actions: ['review-pass', 'review-reject'], activationTrigger: 'submit', x: 0, y: 0 },
      { slotId: 'tt_slot_rep', roleId: 'tt_role_rep', kind: 'reporter', name: '上报', responsibility: '', visibility: 'progress-only', actions: ['report'], activationTrigger: 'team-started', x: 0, y: 0 },
    ],
    edges: [
      { id: 'e1', from: 'tt_slot_dev', to: 'tt_slot_rev', chip: 'submit-review' },
      { id: 'e2', from: 'tt_slot_rev', to: 'tt_slot_rep', chip: 'pass-report' },
      { id: 'e3', from: 'tt_slot_rev', to: 'tt_slot_dev', chip: 'reject-rework' },
    ],
    ...over,
  };
}

describe('deriveReviewOrder', () => {
  it('首轮 reviewer 来自 submit→request-review 边', () => {
    expect(deriveReviewOrder(team())).toEqual(['tt_slot_rev']);
  });
  it('多层审沿 pass-next 链追加', () => {
    const t = team({
      nodes: [
        ...team().nodes,
        { slotId: 'tt_slot_rev2', roleId: 'tt_role_rev2', kind: 'reviewer', name: '终审', responsibility: '', visibility: 'review-only', actions: ['review-pass'], activationTrigger: 'review-pass', x: 0, y: 0 },
      ],
      edges: [
        { id: 'e1', from: 'tt_slot_dev', to: 'tt_slot_rev', chip: 'submit-review' },
        { id: 'e2', from: 'tt_slot_rev', to: 'tt_slot_rev2', chip: 'pass-next' },
        { id: 'e3', from: 'tt_slot_rev2', to: 'tt_slot_rep', chip: 'pass-report' },
        { id: 'e4', from: 'tt_slot_rev', to: 'tt_slot_dev', chip: 'reject-rework' },
        { id: 'e5', from: 'tt_slot_rev2', to: 'tt_slot_dev', chip: 'reject-rework' },
      ],
    });
    expect(deriveReviewOrder(t)).toEqual(['tt_slot_rev', 'tt_slot_rev2']);
  });
});

describe('deriveRoleIo', () => {
  it('按 roleId 聚合入/出边对端角色', () => {
    const io = deriveRoleIo(team());
    expect(io.get('tt_role_rev')).toEqual({ from: ['tt_role_dev'], to: ['tt_role_rep', 'tt_role_dev'] });
    expect(io.get('tt_role_dev')).toEqual({ from: ['tt_role_rev'], to: ['tt_role_rev'] });
  });
});

describe('validateCanvas', () => {
  it('完整链路无 error', () => {
    expect(validateCanvas(team()).filter(i => i.level === 'error')).toEqual([]);
  });
  it('缺末级 →report 出边报 error', () => {
    const t = team({ edges: [
      { id: 'e1', from: 'tt_slot_dev', to: 'tt_slot_rev', chip: 'submit-review' },
      { id: 'e3', from: 'tt_slot_rev', to: 'tt_slot_dev', chip: 'reject-rework' },
    ] });
    expect(validateCanvas(t).some(i => i.level === 'error' && i.message.includes('汇报'))).toBe(true);
  });
  it('reviewQuorum 超审核席数报 error', () => {
    const t = team({ policy: { reviewQuorum: 3, maxRework: 1, escalateAfterStallMs: 0 } });
    expect(validateCanvas(t).some(i => i.level === 'error' && i.message.includes('通过票数'))).toBe(true);
  });
});

describe('allowedChips（P1-1 chip 源/目标 kind 约束）', () => {
  it('提交→请审仅 开发→审核', () => {
    expect(allowedChips('developer', 'reviewer')).toContain('submit-review');
    expect(allowedChips('reviewer', 'reviewer')).not.toContain('submit-review');
  });
  it('下一审仅 审核→审核', () => {
    expect(allowedChips('reviewer', 'reviewer')).toContain('pass-next');
  });
  it('开发→开发无合法关系', () => {
    expect(allowedChips('developer', 'developer')).toEqual([]);
  });
});

describe('validateCanvas（P1-1 非法拓扑硬校验）', () => {
  it('reviewer→reviewer 标成提交→请审报 error', () => {
    const t = team({
      nodes: [
        { slotId: 'tt_slot_dev', roleId: 'tt_role_dev', kind: 'developer', name: '开发', responsibility: '', visibility: 'full', actions: ['submit'], activationTrigger: 'team-started', x: 0, y: 0 },
        { slotId: 'tt_slot_r1', roleId: 'tt_role_r1', kind: 'reviewer', name: '审1', responsibility: '', visibility: 'review-only', actions: ['review-pass'], activationTrigger: 'submit', x: 0, y: 0 },
        { slotId: 'tt_slot_r2', roleId: 'tt_role_r2', kind: 'reviewer', name: '审2', responsibility: '', visibility: 'review-only', actions: ['review-pass'], activationTrigger: 'submit', x: 0, y: 0 },
      ],
      edges: [{ id: 'e1', from: 'tt_slot_r1', to: 'tt_slot_r2', chip: 'submit-review' }],
    });
    expect(validateCanvas(t).some(i => i.level === 'error' && i.message.includes('不匹配'))).toBe(true);
  });
  it('两条提交→请审报 error（首审不唯一）', () => {
    const t = team({
      nodes: [
        { slotId: 'tt_slot_dev', roleId: 'tt_role_dev', kind: 'developer', name: '开发', responsibility: '', visibility: 'full', actions: ['submit'], activationTrigger: 'team-started', x: 0, y: 0 },
        { slotId: 'tt_slot_r1', roleId: 'tt_role_r1', kind: 'reviewer', name: '审1', responsibility: '', visibility: 'review-only', actions: ['review-pass'], activationTrigger: 'submit', x: 0, y: 0 },
        { slotId: 'tt_slot_r2', roleId: 'tt_role_r2', kind: 'reviewer', name: '审2', responsibility: '', visibility: 'review-only', actions: ['review-pass'], activationTrigger: 'submit', x: 0, y: 0 },
        { slotId: 'tt_slot_rep', roleId: 'tt_role_rep', kind: 'reporter', name: '上报', responsibility: '', visibility: 'progress-only', actions: ['report'], activationTrigger: 'team-started', x: 0, y: 0 },
      ],
      edges: [
        { id: 'e1', from: 'tt_slot_dev', to: 'tt_slot_r1', chip: 'submit-review' },
        { id: 'e2', from: 'tt_slot_dev', to: 'tt_slot_r2', chip: 'submit-review' },
        { id: 'e3', from: 'tt_slot_r1', to: 'tt_slot_rep', chip: 'pass-report' },
      ],
    });
    expect(validateCanvas(t).some(i => i.level === 'error' && i.message.includes('首审入口'))).toBe(true);
  });
  it('审核链分叉报 error', () => {
    const t = team({
      nodes: [
        { slotId: 'tt_slot_dev', roleId: 'tt_role_dev', kind: 'developer', name: '开发', responsibility: '', visibility: 'full', actions: ['submit'], activationTrigger: 'team-started', x: 0, y: 0 },
        { slotId: 'tt_slot_r1', roleId: 'tt_role_r1', kind: 'reviewer', name: '审1', responsibility: '', visibility: 'review-only', actions: ['review-pass'], activationTrigger: 'submit', x: 0, y: 0 },
        { slotId: 'tt_slot_r2', roleId: 'tt_role_r2', kind: 'reviewer', name: '审2', responsibility: '', visibility: 'review-only', actions: ['review-pass'], activationTrigger: 'submit', x: 0, y: 0 },
        { slotId: 'tt_slot_r3', roleId: 'tt_role_r3', kind: 'reviewer', name: '审3', responsibility: '', visibility: 'review-only', actions: ['review-pass'], activationTrigger: 'submit', x: 0, y: 0 },
      ],
      edges: [
        { id: 'e1', from: 'tt_slot_dev', to: 'tt_slot_r1', chip: 'submit-review' },
        { id: 'e2', from: 'tt_slot_r1', to: 'tt_slot_r2', chip: 'pass-next' },
        { id: 'e3', from: 'tt_slot_r1', to: 'tt_slot_r3', chip: 'pass-next' },
      ],
    });
    expect(validateCanvas(t).some(i => i.level === 'error' && i.message.includes('分叉'))).toBe(true);
  });
  it('reviewer 不在审核链上报 error', () => {
    const t = team({
      nodes: [
        ...team().nodes,
        { slotId: 'tt_slot_orphan', roleId: 'tt_role_orphan', kind: 'reviewer', name: '游离审', responsibility: '', visibility: 'review-only', actions: ['review-pass'], activationTrigger: 'submit', x: 0, y: 0 },
      ],
    });
    expect(validateCanvas(t).some(i => i.level === 'error' && i.message.includes('不在审核链'))).toBe(true);
  });
  it('typeId 非法前缀报 error', () => {
    expect(validateCanvas(team({ typeId: 'code_review' })).some(i => i.level === 'error' && i.message.includes('tt_type'))).toBe(true);
  });
  it('合法样例无 error', () => {
    expect(validateCanvas(team()).filter(i => i.level === 'error')).toEqual([]);
  });
});

describe('assembleSaveOps', () => {
  it('产出 N role + N rule + 1 type，路径正确', () => {
    const ops = assembleSaveOps(team());
    const roles = ops.filter(o => o.path === '/api/taskteam-role-upsert');
    const rules = ops.filter(o => o.path === '/api/taskteam-rule-upsert');
    const types = ops.filter(o => o.path === '/api/taskteam-type-upsert');
    expect(roles).toHaveLength(3);
    expect(rules).toHaveLength(3);
    expect(types).toHaveLength(1);
  });
  it('驳回 chip 产出 do=nudge（不是非法 rework）', () => {
    const ops = assembleSaveOps(team());
    const rejectRule = ops.find(o => o.path === '/api/taskteam-rule-upsert' && (o.payload as { rule: { do: string } }).rule.do === 'nudge');
    expect(rejectRule).toBeTruthy();
    // 任一规则都不应是非法 do=rework
    const hasRework = ops.some(o => o.path === '/api/taskteam-rule-upsert' && (o.payload as { rule: { do: string } }).rule.do === 'rework');
    expect(hasRework).toBe(false);
  });
  it('fromExisting 角色不产出 role-upsert（只建 slot）', () => {
    const t = team();
    t.nodes[2]!.fromExisting = true; // 上报来自已存角色库
    const ops = assembleSaveOps(t);
    const roleIds = ops.filter(o => o.path === '/api/taskteam-role-upsert').map(o => (o.payload as { role: { roleId: string } }).role.roleId);
    expect(roleIds).not.toContain('tt_role_rep');
    expect(roleIds).toHaveLength(2);
  });
  it('type.policy.reviewOrder 含首轮 reviewer', () => {
    const ops = assembleSaveOps(team());
    const typeOp = ops.find(o => o.path === '/api/taskteam-type-upsert')!;
    const order = (typeOp.payload as { teamType: { policy: { reviewOrder: string[] } } }).teamType.policy.reviewOrder;
    expect(order).toEqual(['tt_slot_rev']);
  });
});
