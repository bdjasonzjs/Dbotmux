// tt_type_dev_with_e2e 端到端集成（开发 → review → e2e 关 → done）——延续阶段三 MoA 范式：
// 纯配置 type + 既有原语（detect / 引擎 / outbox / dispatcher），**未改引擎核心 decide**。唯一新增逻辑在
// dispatch IO 层（把实例 e2e 四项配置渲染进 @豆包M 的 notify）。
//
// 覆盖：①全链路 happy path（submit→架构pass→详细pass→派e2e→e2e-pass→待验收→accept→done）+ 四项渲染；
//       ②e2e-fail 踢回开发者返工（→running，文案带向上反馈指引）；③豆包M 离线（e2e 验证态=reviewing）stall 不刷屏；
//       ④真 detect 路径：豆包M 群消息 → judge 判 e2e-pass（external）→ 真引擎产 report（证明跨机器外部事件接线）；
//       ⑤配置经真 validator 守卫落库（无 error）+ two_layer 零回归（detail→acceptance 规则未被改道）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  TaskTeamAction,
  TaskTeamId,
  TaskTeamInstance,
  TaskTeamRoleInstance,
} from '../src/services/taskteam-schema.js';
import type { TeamEvent } from '../src/services/taskteam-engine.js';
import type { TaskTeamRuntimeDeps } from '../src/services/taskteam-runtime.js';
import type {
  TaskTeamObserverDeps,
  TaskTeamObserverExecutors,
} from '../src/services/taskteam-observer.js';
import type {
  TaskTeamFetchedMessage,
  TaskTeamJudgeFn,
} from '../src/services/taskteam-observe-executors.js';

let tempDir: string;
vi.mock('../src/config.js', () => ({
  config: { get session() { return { dataDir: tempDir }; } },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

async function load() {
  vi.resetModules();
  return {
    configStore: await import('../src/services/taskteam-config-store.js'),
    devE2e: await import('../src/services/taskteam-dev-with-e2e.js'),
    store: await import('../src/services/taskteam-store.js'),
    outbox: await import('../src/services/taskteam-outbox-store.js'),
    dispatcher: await import('../src/services/taskteam-dispatcher.js'),
    dispatchExec: await import('../src/services/taskteam-dispatch-executors.js'),
    observer: await import('../src/services/taskteam-observer.js'),
    observe: await import('../src/services/taskteam-observe-executors.js'),
    runtime: await import('../src/services/taskteam-runtime.js'),
    validator: await import('../src/services/taskteam-validator.js'),
  };
}

type Mods = Awaited<ReturnType<typeof load>>;
const DOUBAO_OPENID = 'ou_doubao_m';

function ri(id: string, slotId: string, roleId: string, openId: string): TaskTeamRoleInstance {
  return {
    roleInstanceId: id as TaskTeamRoleInstance['roleInstanceId'],
    slotId: slotId as TaskTeamRoleInstance['slotId'],
    roleId: roleId as TaskTeamRoleInstance['roleId'],
    binding: { bindingId: `tt_binding_${id}` as never, botOpenId: openId, larkAppId: `cli_${id}` },
  };
}

// 花名册顺序 = R1..R5（detect 的 R{n} 别名按位置解析）：dev/arch/detail/e2e_runner/observer。
const ROLE_INSTANCES: TaskTeamRoleInstance[] = [
  ri('tt_ri_dev', 'tt_slot_developer_main', 'tt_role_developer', 'ou_dev'),
  ri('tt_ri_arch', 'tt_slot_architect_main', 'tt_role_architect', 'ou_arch'),
  ri('tt_ri_detail', 'tt_slot_detail_reviewer_main', 'tt_role_detail_reviewer', 'ou_detail'),
  ri('tt_ri_e2e', 'tt_slot_e2e_runner_main', 'tt_role_e2e_runner', DOUBAO_OPENID),
  ri('tt_ri_obs', 'tt_slot_observer_main', 'tt_role_observer', 'ou_obs'),
];

const E2E_CONFIG = {
  clientPackage: 'Doubao-native-feat-x build#123',
  frontendBranch: 'computer-use/pip',
  cases: '点「电脑使用」→ 发 prompt「打开计算器」→ 期望 GUI 真机点开计算器',
  skill: 'doubao-desktop-cdp-verification',
};

// 用纯配置（devWithE2eConfigBundle）+ 既有 store 搭一个 dev_with_e2e 小组，跑到 forming 后由 team-started 推进。
async function setupTeam(mods: Mods, opts: { withE2eConfig?: boolean } = {}): Promise<TaskTeamId> {
  const { configStore, devE2e, store, validator } = mods;
  const bundle = devE2e.devWithE2eConfigBundle();
  await configStore.replaceTaskTeamConfig({
    version: 1,
    roles: bundle.roles,
    rules: bundle.rules,
    teamTypes: bundle.teamTypes,
    orgStructures: [],
    orgRuntimeBindings: [],
    updatedAt: new Date().toISOString(),
  });
  // 配置经真 validator 守卫落库；显式再断言无 error（顺带证明本类型配置合法）。
  expect(validator.validateTaskTeamConfig(configStore.readTaskTeamConfig()).errors).toEqual([]);

  const team = await store.createTaskTeam({
    typeId: devE2e.TT_TYPE_DEV_WITH_E2E,
    companyId: 'tt_company_dev_e2e' as TaskTeamInstance['companyId'],
    chatId: 'oc_team',
    goal: '给 CUA 加 X 功能并真机 e2e 验证',
    acceptance: '功能实现 + 两层 review 过 + 真机 e2e 通过',
    ...(opts.withE2eConfig ? { e2eConfig: E2E_CONFIG } : {}),
    roleInstances: ROLE_INSTANCES,
  });
  return team.teamId;
}

function runtimeDeps(mods: Mods): TaskTeamRuntimeDeps {
  const { configStore, store, outbox } = mods;
  return {
    withTeamLock: (_id, fn) => fn(),
    loadConfig: () => {
      const c = configStore.readTaskTeamConfig();
      return { roles: c.roles, rules: c.rules, teamTypes: c.teamTypes };
    },
    getTeam: id => store.getTaskTeam(id),
    applyState: (id, patch) => store.applyTeamDecisionState(id, patch),
    enqueue: opts => outbox.enqueueTaskTeamAction(opts),
  };
}

// 角色行为事件（role 归因，带 source 保证幂等键各异）。
function roleEvent(type: string, fromRi: string, fromSlot: string, source: string): TeamEvent {
  return {
    type,
    fromRoleInstanceId: fromRi as never,
    fromSlotId: fromSlot as never,
    attribution: 'role',
    sourceEventId: source,
  };
}
// 外部事件（豆包M 跨机器，source-only，无 fromSlot）。
function externalEvent(type: string, source: string): TeamEvent {
  return { type, attribution: 'external', sourceEventId: source };
}

function findAction(actions: TaskTeamAction[], pred: (a: TaskTeamAction) => boolean): TaskTeamAction {
  const a = actions.find(pred);
  if (!a) throw new Error(`expected action not found among ${actions.map(x => x.actionType).join(',')}`);
  return a;
}

// observer 真 detect 注入（peek=fake，detect=真 observe-executors，注入 fake judge/fetchSince）。
function realObserverDeps(mods: Mods): TaskTeamObserverDeps {
  const { configStore, store, outbox } = mods;
  return {
    withTeamLock: (_id, fn) => fn(),
    loadConfig: () => {
      const c = configStore.readTaskTeamConfig();
      return { roles: c.roles, rules: c.rules, teamTypes: c.teamTypes };
    },
    getTeam: id => store.getTaskTeam(id),
    applyState: (id, patch) => store.applyTeamDecisionState(id, patch),
    enqueue: opts => outbox.enqueueTaskTeamAction(opts),
    listActiveTeams: () => store.listActiveTaskTeams(),
    advanceCursor: async (id, cursor) => {
      await store.applyTeamDecisionState(id, { cursor, lastObservedActivityAt: new Date().toISOString() });
    },
    resolveType: inst => configStore.readTaskTeamConfig().teamTypes.find(t => t.typeId === inst.typeId),
  };
}
function observeExec(mods: Mods, batch: TaskTeamFetchedMessage[], judge: TaskTeamJudgeFn, deps: TaskTeamObserverDeps): TaskTeamObserverExecutors {
  const real = mods.observe.makeTaskTeamObserveExecutors('cli_obs', {
    judge,
    fetchSince: async () => ({ messages: batch }),
    resolveType: deps.resolveType,
  });
  return { peek: async () => ({ hasNew: true, cursor: 'om_latest' }), detect: real.detect };
}

describe('tt_type_dev_with_e2e 端到端', () => {
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'tt-deve2e-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('① 全链路：开发→架构pass→详细pass→派e2e(进 e2e-verifying)→e2e-pass→待验收→accept→done，且 notify 带 e2e 四项', async () => {
    const mods = await load();
    const teamId = await setupTeam(mods, { withE2eConfig: true });
    const deps = runtimeDeps(mods);
    const apply = (e: TeamEvent) => mods.runtime.applyTeamEvent(deps, teamId, e);

    // team-started → developer kickoff + running
    await apply({ type: 'team-started' });
    expect(mods.store.getTaskTeam(teamId)!.status).toBe('running');

    // submit → 请架构 review（reviewing）
    await apply(roleEvent('submit', 'tt_ri_dev', 'tt_slot_developer_main', 'm1'));
    expect(mods.store.getTaskTeam(teamId)!.status).toBe('reviewing');

    // 架构 pass → 请详细 review（仍 reviewing）
    await apply(roleEvent('review-pass', 'tt_ri_arch', 'tt_slot_architect_main', 'm2'));
    expect(mods.store.getTaskTeam(teamId)!.status).toBe('reviewing');

    // 详细 pass → 派 e2e 给 e2e_runner（notify），**跃迁到独立 e2e-verifying 态**
    await apply(roleEvent('review-pass', 'tt_ri_detail', 'tt_slot_detail_reviewer_main', 'm3'));
    expect(mods.store.getTaskTeam(teamId)!.status).toBe('e2e-verifying');
    const afterDetail = mods.outbox.readTaskTeamOutbox().actions;
    const notify = findAction(afterDetail, a => a.actionType === 'notify');
    expect(notify.targetSlotId).toBe('tt_slot_e2e_runner_main');
    expect(notify.targetRoleInstanceId).toBe('tt_ri_e2e');
    // 没有任何 request-review 把它推进/也没 report → 仍是 e2e 验证态
    expect(afterDetail.some(a => a.actionType === 'report')).toBe(false);

    // 渲染 notify：@豆包M + e2e 四项配置全部在内
    const team = mods.store.getTaskTeam(teamId)!;
    const rendered = mods.dispatchExec.renderTaskTeamCommand(notify, team);
    expect(rendered).toContain(`<at user_id="${DOUBAO_OPENID}"></at>`);
    expect(rendered).toContain(E2E_CONFIG.clientPackage);
    expect(rendered).toContain(E2E_CONFIG.frontendBranch);
    expect(rendered).toContain(E2E_CONFIG.cases);
    expect(rendered).toContain(E2E_CONFIG.skill);

    // e2e-pass（external）→ 开发者 report + 待验收
    await apply(externalEvent('e2e-pass', 'm4'));
    expect(mods.store.getTaskTeam(teamId)!.status).toBe('awaiting-acceptance');
    const report = findAction(mods.outbox.readTaskTeamOutbox().actions, a => a.actionType === 'report');
    expect(report.targetSlotId).toBe('tt_slot_developer_main');

    // owner accept → done
    await apply({ type: 'accept', sourceEventId: 'm5' });
    expect(mods.store.getTaskTeam(teamId)!.status).toBe('done');
  });

  it('② e2e-fail → 踢回开发者返工（running），nudge 文案带「向上反馈」指引', async () => {
    const mods = await load();
    const teamId = await setupTeam(mods, { withE2eConfig: true });
    const deps = runtimeDeps(mods);
    const apply = (e: TeamEvent) => mods.runtime.applyTeamEvent(deps, teamId, e);

    await apply({ type: 'team-started' });
    await apply(roleEvent('submit', 'tt_ri_dev', 'tt_slot_developer_main', 'm1'));
    await apply(roleEvent('review-pass', 'tt_ri_arch', 'tt_slot_architect_main', 'm2'));
    await apply(roleEvent('review-pass', 'tt_ri_detail', 'tt_slot_detail_reviewer_main', 'm3'));
    expect(mods.store.getTaskTeam(teamId)!.status).toBe('e2e-verifying');

    // e2e-fail → nudge 开发者，回 running（机制同 review-reject）
    await apply(externalEvent('e2e-fail', 'm4'));
    expect(mods.store.getTaskTeam(teamId)!.status).toBe('running');
    const nudge = findAction(mods.outbox.readTaskTeamOutbox().actions, a => a.actionType === 'nudge');
    expect(nudge.targetSlotId).toBe('tt_slot_developer_main');
    const rendered = mods.dispatchExec.renderTaskTeamCommand(nudge, mods.store.getTaskTeam(teamId)!);
    expect(rendered).toContain('向上反馈');
    expect(rendered).toContain('askforhelp');
  });

  it('③ 豆包M 离线：e2e 验证态（e2e-verifying）下 stall 不产任何投递（不刷屏）', async () => {
    const mods = await load();
    const teamId = await setupTeam(mods);
    const deps = runtimeDeps(mods);
    const apply = (e: TeamEvent) => mods.runtime.applyTeamEvent(deps, teamId, e);

    await apply({ type: 'team-started' });
    await apply(roleEvent('submit', 'tt_ri_dev', 'tt_slot_developer_main', 'm1'));
    await apply(roleEvent('review-pass', 'tt_ri_arch', 'tt_slot_architect_main', 'm2'));
    await apply(roleEvent('review-pass', 'tt_ri_detail', 'tt_slot_detail_reviewer_main', 'm3'));
    expect(mods.store.getTaskTeam(teamId)!.status).toBe('e2e-verifying');

    const before = mods.outbox.readTaskTeamOutbox().actions.length;
    // stall 规则 when.status='running'；e2e 验证态是 e2e-verifying → 命不中、零新投递（豆包M 慢/离线不被催）。
    await apply({ type: 'stall', attribution: 'none', sourceEventId: 'win-1' });
    const after = mods.outbox.readTaskTeamOutbox().actions.length;
    expect(after).toBe(before);
    expect(mods.store.getTaskTeam(teamId)!.status).toBe('e2e-verifying'); // 状态不变
  });

  it('⑥ 修 P1①：e2e 验证态下详细 reviewer 再发 review-pass，不再产新的 e2e-kickoff notify（不重复派单）', async () => {
    const mods = await load();
    const teamId = await setupTeam(mods, { withE2eConfig: true });
    const deps = runtimeDeps(mods);
    const apply = (e: TeamEvent) => mods.runtime.applyTeamEvent(deps, teamId, e);

    await apply({ type: 'team-started' });
    await apply(roleEvent('submit', 'tt_ri_dev', 'tt_slot_developer_main', 'm1'));
    await apply(roleEvent('review-pass', 'tt_ri_arch', 'tt_slot_architect_main', 'm2'));
    await apply(roleEvent('review-pass', 'tt_ri_detail', 'tt_slot_detail_reviewer_main', 'm3'));
    expect(mods.store.getTaskTeam(teamId)!.status).toBe('e2e-verifying');
    const notifyCount = (acts: TaskTeamAction[]) => acts.filter(a => a.actionType === 'notify' && a.targetSlotId === 'tt_slot_e2e_runner_main').length;
    expect(notifyCount(mods.outbox.readTaskTeamOutbox().actions)).toBe(1);

    // 详细 reviewer 在 e2e 验证态再发一条「补充：还是通过」的新消息（不同 source m4）→ detail-pass 规则 gate 在 reviewing，
    // 当前是 e2e-verifying → 不命中 → 不再派单。
    const d = await apply(roleEvent('review-pass', 'tt_ri_detail', 'tt_slot_detail_reviewer_main', 'm4'));
    expect(d.decision.actions).toEqual([]); // 引擎对这条 review-pass 不产任何命令
    expect(notifyCount(mods.outbox.readTaskTeamOutbox().actions)).toBe(1); // 仍只有 1 条 e2e 派单
    expect(mods.store.getTaskTeam(teamId)!.status).toBe('e2e-verifying'); // 状态不变
  });

  it('⑦ e2e 验证态下混入一条 review-pass（judge 误判）不会错误推进；只有 e2e-pass 才推进到待验收', async () => {
    const mods = await load();
    const teamId = await setupTeam(mods, { withE2eConfig: true });
    const deps = runtimeDeps(mods);
    const apply = (e: TeamEvent) => mods.runtime.applyTeamEvent(deps, teamId, e);

    await apply({ type: 'team-started' });
    await apply(roleEvent('submit', 'tt_ri_dev', 'tt_slot_developer_main', 'm1'));
    await apply(roleEvent('review-pass', 'tt_ri_arch', 'tt_slot_architect_main', 'm2'));
    await apply(roleEvent('review-pass', 'tt_ri_detail', 'tt_slot_detail_reviewer_main', 'm3'));
    expect(mods.store.getTaskTeam(teamId)!.status).toBe('e2e-verifying');

    // 误把 e2e_runner 的「通过」判成 review-pass（external 归因、无 fromSlot）→ 无任何 review-pass 规则 gate 在 e2e-verifying → 不推进。
    const stray = await apply({ type: 'review-pass', attribution: 'external', sourceEventId: 'm-stray' });
    expect(stray.decision.actions).toEqual([]);
    expect(mods.store.getTaskTeam(teamId)!.status).toBe('e2e-verifying'); // 不误推进

    // 正确的 e2e-pass 才推进到待验收
    await apply(externalEvent('e2e-pass', 'm4'));
    expect(mods.store.getTaskTeam(teamId)!.status).toBe('awaiting-acceptance');
  });

  it('④ 真 detect 路径：豆包M 群消息 → judge 判 e2e-pass(external) → 真引擎产 report；噪声不误报', async () => {
    const mods = await load();
    const teamId = await setupTeam(mods, { withE2eConfig: true });
    // 先把团队推进到 e2e 验证态（reviewing）
    const rdeps = runtimeDeps(mods);
    const apply = (e: TeamEvent) => mods.runtime.applyTeamEvent(rdeps, teamId, e);
    await apply({ type: 'team-started' });
    await apply(roleEvent('submit', 'tt_ri_dev', 'tt_slot_developer_main', 'm1'));
    await apply(roleEvent('review-pass', 'tt_ri_arch', 'tt_slot_architect_main', 'm2'));
    await apply(roleEvent('review-pass', 'tt_ri_detail', 'tt_slot_detail_reviewer_main', 'm3'));
    const beforeReports = mods.outbox.readTaskTeamOutbox().actions.filter(a => a.actionType === 'report').length;

    // 真 detect：豆包M 在群里回报 e2e 通过；judge 判 e2e-pass（external attribution，source-only）。
    const odeps = realObserverDeps(mods);
    const batch: TaskTeamFetchedMessage[] = [
      { id: 'om_e2e_ok', text: 'e2e 全部通过，计算器正常打开', senderId: DOUBAO_OPENID },
    ];
    const judge: TaskTeamJudgeFn = async () => [{ type: 'e2e-pass', source: 'M1' }];
    const obsStats = await mods.observer.runTaskTeamObserverTick(new Date(), odeps, observeExec(mods, batch, judge, odeps));
    expect(obsStats.events).toBe(1);
    expect(mods.store.getTaskTeam(teamId)!.status).toBe('awaiting-acceptance');
    const afterReports = mods.outbox.readTaskTeamOutbox().actions.filter(a => a.actionType === 'report').length;
    expect(afterReports).toBe(beforeReports + 1);
  });

  it('④b 真 detect 路径：纯噪声 → 零事件、状态不变（不误判 e2e）', async () => {
    const mods = await load();
    const teamId = await setupTeam(mods);
    const rdeps = runtimeDeps(mods);
    const apply = (e: TeamEvent) => mods.runtime.applyTeamEvent(rdeps, teamId, e);
    await apply({ type: 'team-started' });
    await apply(roleEvent('submit', 'tt_ri_dev', 'tt_slot_developer_main', 'm1'));
    await apply(roleEvent('review-pass', 'tt_ri_arch', 'tt_slot_architect_main', 'm2'));
    await apply(roleEvent('review-pass', 'tt_ri_detail', 'tt_slot_detail_reviewer_main', 'm3'));

    const odeps = realObserverDeps(mods);
    const batch: TaskTeamFetchedMessage[] = [{ id: 'om_chat', text: '我先去吃个饭', senderId: DOUBAO_OPENID }];
    const judge: TaskTeamJudgeFn = async () => []; // judge 判无行为
    const obsStats = await mods.observer.runTaskTeamObserverTick(new Date(), odeps, observeExec(mods, batch, judge, odeps));
    expect(obsStats.events).toBe(0);
    expect(mods.store.getTaskTeam(teamId)!.status).toBe('e2e-verifying'); // 仍在 e2e 验证态
  });

  it('⑧ 修 P1②：missingE2eConfigFields fail-fast——缺必填项返回缺名，齐全返回空', async () => {
    const mods = await load();
    const { missingE2eConfigFields } = mods.devE2e;
    expect(missingE2eConfigFields(undefined)).toEqual(['clientPackage', 'frontendBranch', 'cases']);
    expect(missingE2eConfigFields({})).toEqual(['clientPackage', 'frontendBranch', 'cases']);
    expect(missingE2eConfigFields({ clientPackage: 'pkg', frontendBranch: '  ', cases: 'c' })).toEqual(['frontendBranch']); // 空白算缺
    expect(missingE2eConfigFields({ clientPackage: 'pkg', frontendBranch: 'br', cases: 'c' })).toEqual([]); // skill 可选
    expect(missingE2eConfigFields(E2E_CONFIG)).toEqual([]);
  });

  it('⑤ two_layer 零回归：bundle 里 two_layer 仍在，detail→acceptance 规则未被改道（仍 do=report）', async () => {
    const mods = await load();
    const bundle = mods.devE2e.devWithE2eConfigBundle();
    const twoLayer = bundle.teamTypes.find(t => t.typeId === 'tt_type_two_layer_review');
    expect(twoLayer).toBeDefined();
    // two_layer 仍引用 detail→acceptance（report），未被 e2e 改道
    expect(twoLayer!.rules).toContain('tt_rule_detail_pass_to_acceptance');
    expect(twoLayer!.rules).not.toContain('tt_rule_detail_pass_to_e2e');
    const detailAcc = bundle.rules.find(r => r.ruleId === 'tt_rule_detail_pass_to_acceptance');
    expect(detailAcc!.do).toBe('report');
    expect(detailAcc!.whoSlot).toBe('tt_slot_developer_main');
    // dev_with_e2e 的 detail→e2e 改道独立存在（do=notify 给 e2e_runner）
    const detailE2e = bundle.rules.find(r => r.ruleId === 'tt_rule_detail_pass_to_e2e');
    expect(detailE2e!.do).toBe('notify');
    expect(detailE2e!.whoSlot).toBe('tt_slot_e2e_runner_main');
  });
});
