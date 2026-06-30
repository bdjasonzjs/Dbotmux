import { describe, expect, it } from 'vitest';
import {
  validateTaskTeamConfig,
  assertValidTaskTeamConfig,
  TaskTeamConfigValidationError,
} from '../src/services/taskteam-validator.js';
import { defaultTaskTeamSeed } from '../src/services/taskteam-config-store.js';
import type {
  TaskTeamCollabRule,
  TaskTeamConfigFile,
  TaskTeamRole,
  TaskTeamType,
} from '../src/services/taskteam-schema.js';

function role(roleId: string): TaskTeamRole {
  return {
    roleId: roleId as TaskTeamRole['roleId'],
    name: roleId,
    responsibility: roleId,
    activation: { trigger: 'team-started' },
    visibility: 'full',
    actions: ['submit'],
    io: { from: [], to: [] },
  };
}

// 最小可校验配置：dev 席 + observer 席 + 一条 submit→report 规则（合法、闭合）。
function baseConfig(over: { rules?: TaskTeamCollabRule[]; type?: Partial<TaskTeamType>; roles?: TaskTeamRole[] } = {}): TaskTeamConfigFile {
  const rules: TaskTeamCollabRule[] = over.rules ?? [
    { ruleId: 'tt_rule_x', when: { event: 'submit', status: 'running' }, whoSlot: 'tt_slot_obs', do: 'report' },
  ];
  const type: TaskTeamType = {
    typeId: 'tt_type_x',
    name: 'X',
    roleSlots: [
      { slotId: 'tt_slot_dev', roleId: 'tt_role_dev' },
      { slotId: 'tt_slot_obs', roleId: 'tt_role_obs' },
    ],
    rules: rules.map(r => r.ruleId),
    policy: { reviewRounds: 1, reviewQuorum: 1, maxRework: 1, escalateAfterStallMs: 0, reviewOrder: [] },
    ...over.type,
  };
  return {
    version: 1,
    roles: over.roles ?? [role('tt_role_dev'), role('tt_role_obs')],
    rules,
    teamTypes: [type],
    orgStructures: [],
    orgRuntimeBindings: [],
    updatedAt: 't',
  };
}

describe('validateTaskTeamConfig — 闭环 + 事件 registry + 显式 transition 红线（阶段1①）', () => {
  it('valid minimal config → ok, 无 error/warning', () => {
    const v = validateTaskTeamConfig(baseConfig());
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
  });

  it('seed 默认配置 → 校验干净（无 error / 无 warning）——golden，是其它 type 的基线', () => {
    const seed = defaultTaskTeamSeed();
    const v = validateTaskTeamConfig({ version: 1, updatedAt: 't', ...seed });
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
  });

  it('roleSlot 引用不存在的 role → warning（增量期不硬阻断），仍 ok', () => {
    const cfg = baseConfig({ roles: [role('tt_role_dev')] }); // 缺 tt_role_obs
    const v = validateTaskTeamConfig(cfg);
    expect(v.ok).toBe(true);
    expect(v.warnings.some(w => w.code === 'slot-role-missing')).toBe(true);
  });

  it('rule.do 非法投递命令 → error，ok=false', () => {
    const cfg = baseConfig({ rules: [{ ruleId: 'tt_rule_x', when: { event: 'submit' }, whoSlot: 'tt_slot_obs', do: 'bogus' as never }] });
    const v = validateTaskTeamConfig(cfg);
    expect(v.ok).toBe(false);
    expect(v.errors.some(e => e.code === 'rule-bad-command')).toBe(true);
  });

  it('when.event typo（registry 未知）→ error event-unknown，ok=false（修 P1-b：typo 报错而非静默丢）', () => {
    const cfg = baseConfig({ rules: [{ ruleId: 'tt_rule_x', when: { event: 'sbumit' }, whoSlot: 'tt_slot_obs', do: 'report' }] });
    const v = validateTaskTeamConfig(cfg);
    expect(v.ok).toBe(false);
    expect(v.errors.some(e => e.code === 'event-unknown')).toBe(true);
  });

  it('声明了但无已接线 producer 的自定义事件（custom timer，阶段1 未接 clock）→ warning event-no-producer（区分 typo 与未接线）', () => {
    const cfg = baseConfig({
      rules: [{ ruleId: 'tt_rule_x', when: { event: 'nightly-tick' }, whoSlot: 'tt_slot_obs', do: 'report' }],
      type: { events: [{ type: 'nightly-tick', producer: 'timer' }] },
    });
    const v = validateTaskTeamConfig(cfg);
    expect(v.errors.some(e => e.code === 'event-unknown')).toBe(false); // 已声明 → 不是 typo
    expect(v.warnings.some(w => w.code === 'event-no-producer')).toBe(true); // 但未接线 producer → warn
  });

  it('type.events 声明的自定义 behavior 事件被规则引用 → 可产出、不报 typo/no-producer（registry② behavior 已接 detect）', () => {
    const cfg = baseConfig({
      rules: [{ ruleId: 'tt_rule_x', when: { event: 'flag-anomaly' }, whoSlot: 'tt_slot_obs', do: 'report' }],
      type: { events: [{ type: 'flag-anomaly', producer: 'behavior' }] },
    });
    const v = validateTaskTeamConfig(cfg);
    expect(v.warnings.some(w => w.code === 'event-no-producer')).toBe(false);
    expect(v.errors.some(e => e.code === 'event-unknown')).toBe(false);
    expect(v.ok).toBe(true);
  });

  it('自定义事件 + do=request-review + 无 transition → warning（迁移红线：会被隐式拽进 reviewing）', () => {
    const cfg = baseConfig({
      rules: [{ ruleId: 'tt_rule_x', when: { event: 'please-look', status: 'running' }, whoSlot: 'tt_slot_obs', do: 'request-review' }],
      type: { events: [{ type: 'please-look', producer: 'behavior' }] },
    });
    const v = validateTaskTeamConfig(cfg);
    expect(v.warnings.some(w => w.code === 'custom-request-review-no-transition')).toBe(true);
    // 声明了 transition 就不再警
    const cfg2 = baseConfig({
      rules: [{ ruleId: 'tt_rule_x', when: { event: 'please-look', status: 'running' }, whoSlot: 'tt_slot_obs', do: 'request-review', transition: { status: 'running' } }],
      type: { events: [{ type: 'please-look', producer: 'behavior' }] },
    });
    expect(validateTaskTeamConfig(cfg2).warnings.some(w => w.code === 'custom-request-review-no-transition')).toBe(false);
  });

  it('legacy 事件上声明 transition → warning transition-on-legacy（引擎 special case 不读）', () => {
    // review-reject 仍是 transition-blind legacy（引擎 decideReviewReject 不读 transition）→ 声明 transition 无效告警。
    const cfg = baseConfig({ rules: [{ ruleId: 'tt_rule_x', when: { event: 'review-reject' }, whoSlot: 'tt_slot_obs', do: 'report', transition: { status: 'done' } }] });
    const v = validateTaskTeamConfig(cfg);
    expect(v.warnings.some(w => w.code === 'transition-on-legacy')).toBe(true);
  });

  it('review-pass 上声明 transition 不再告警（decideReviewPass 在达 quorum 推进时会读它——dev_with_e2e 进 e2e-verifying 用此）', () => {
    const cfg = baseConfig({ rules: [{ ruleId: 'tt_rule_x', when: { event: 'review-pass' }, whoSlot: 'tt_slot_obs', do: 'report', transition: { status: 'e2e-verifying' } }] });
    const v = validateTaskTeamConfig(cfg);
    expect(v.warnings.some(w => w.code === 'transition-on-legacy')).toBe(false);
    expect(v.errors.some(e => e.code === 'transition-bad-status')).toBe(false); // e2e-verifying 是合法状态
  });

  it('同事件可同时命中的两条规则声明互斥 transition → error transition-conflict（约束2：一次事件 0 或 1 个）', () => {
    const cfg = baseConfig({
      rules: [
        { ruleId: 'tt_rule_a', when: { event: 'x-evt', status: 'running' }, whoSlot: 'tt_slot_obs', do: 'report', transition: { status: 'blocked' } },
        { ruleId: 'tt_rule_b', when: { event: 'x-evt', status: 'running' }, whoSlot: 'tt_slot_dev', do: 'report', transition: { status: 'done' } },
      ],
      type: { events: [{ type: 'x-evt', producer: 'behavior' }] },
    });
    const v = validateTaskTeamConfig(cfg);
    expect(v.ok).toBe(false);
    expect(v.errors.some(e => e.code === 'transition-conflict')).toBe(true);
  });

  it('同事件两条规则声明一致 transition（同 status）→ 不冲突', () => {
    const cfg = baseConfig({
      rules: [
        { ruleId: 'tt_rule_a', when: { event: 'x-evt', status: 'running' }, whoSlot: 'tt_slot_obs', do: 'report', transition: { status: 'blocked' } },
        { ruleId: 'tt_rule_b', when: { event: 'x-evt', status: 'running' }, whoSlot: 'tt_slot_dev', do: 'report', transition: { status: 'blocked' } },
      ],
      type: { events: [{ type: 'x-evt', producer: 'behavior' }] },
    });
    const v = validateTaskTeamConfig(cfg);
    expect(v.errors.some(e => e.code === 'transition-conflict')).toBe(false);
  });

  it('互斥 status 条件的两条 transition 规则不视为冲突（不可能同时命中）', () => {
    const cfg = baseConfig({
      rules: [
        { ruleId: 'tt_rule_a', when: { event: 'x-evt', status: 'running' }, whoSlot: 'tt_slot_obs', do: 'report', transition: { status: 'blocked' } },
        { ruleId: 'tt_rule_b', when: { event: 'x-evt', status: 'reviewing' }, whoSlot: 'tt_slot_dev', do: 'report', transition: { status: 'done' } },
      ],
      type: { events: [{ type: 'x-evt', producer: 'behavior' }] },
    });
    const v = validateTaskTeamConfig(cfg);
    expect(v.errors.some(e => e.code === 'transition-conflict')).toBe(false);
  });

  it('transition.status 非法状态 → error transition-bad-status', () => {
    const cfg = baseConfig({
      rules: [{ ruleId: 'tt_rule_x', when: { event: 'x-evt', status: 'running' }, whoSlot: 'tt_slot_obs', do: 'report', transition: { status: 'nope' as never } }],
      type: { events: [{ type: 'x-evt', producer: 'behavior' }] },
    });
    const v = validateTaskTeamConfig(cfg);
    expect(v.ok).toBe(false);
    expect(v.errors.some(e => e.code === 'transition-bad-status')).toBe(true);
  });

  it('assertValidTaskTeamConfig: 有 error 抛 TaskTeamConfigValidationError；仅 warning 返回 warnings 不抛', () => {
    const bad = baseConfig({ rules: [{ ruleId: 'tt_rule_x', when: { event: 'submit' }, whoSlot: 'tt_slot_obs', do: 'bogus' as never }] });
    expect(() => assertValidTaskTeamConfig(bad)).toThrow(TaskTeamConfigValidationError);
    const warnOnly = baseConfig({ roles: [role('tt_role_dev')] }); // 缺 role → warning only
    const warnings = assertValidTaskTeamConfig(warnOnly);
    expect(warnings.some(w => w.code === 'slot-role-missing')).toBe(true);
  });
});
