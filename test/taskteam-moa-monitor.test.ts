// 阶段三 · MoA 监控纯配置端到端集成（证明重构达成原需求「MoA 监控配好却产不出提醒」根因被解掉）。
//
// 全程**只用既有原语**（detect / 引擎 / outbox / dispatcher / observer），MoA 仅是声明式 type 配置数据
// （src/services/taskteam-moa-monitor.ts）。本测试唯一的 fake 是 IO 边界注入缝：judge(LLM)、fetchSince(读群)、
// peek(读群)、send(发群)——都是既有可注入接口，**没有 fake/改任何引擎/dispatcher/judge 逻辑**。
//
// 真实链路：fake 外部群消息 → 真 detect（attribution=external，source-only 产事件）→ 真 engine（new-bug→notify）
//   → 真 outbox enqueue（幂等去重）→ 真 dispatcher tick（投递记录）。
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
import type {
  TaskTeamObserverDeps,
  TaskTeamObserverExecutors,
} from '../src/services/taskteam-observer.js';
import type {
  TaskTeamFetchSinceFn,
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
    store: await import('../src/services/taskteam-store.js'),
    outbox: await import('../src/services/taskteam-outbox-store.js'),
    dispatcher: await import('../src/services/taskteam-dispatcher.js'),
    observer: await import('../src/services/taskteam-observer.js'),
    observe: await import('../src/services/taskteam-observe-executors.js'),
    dispatchExec: await import('../src/services/taskteam-dispatch-executors.js'),
    validator: await import('../src/services/taskteam-validator.js'),
    moa: await import('../src/services/taskteam-moa-monitor.js'),
  };
}

function ri(id: string, slotId: string, roleId: string, openId: string): TaskTeamRoleInstance {
  return {
    roleInstanceId: id as TaskTeamRoleInstance['roleInstanceId'],
    slotId: slotId as TaskTeamRoleInstance['slotId'],
    roleId: roleId as TaskTeamRoleInstance['roleId'],
    binding: { bindingId: `tt_binding_${id}` as never, botOpenId: openId, larkAppId: `cli_${id}` },
  };
}

// 用既有原语把一个 MoA 监控小组搭起来并跑到 running（纯配置 + 既有 store/runtime，无专门代码）。
async function setupMoaTeam(mods: Awaited<ReturnType<typeof load>>) {
  const { configStore, store, moa, validator } = mods;
  // 1) 纯配置落库：replaceTaskTeamConfig 会跑 validator 守卫——配置非法即抛（顺带证明 MoA 配置合法）。
  const bundle = moa.moaMonitorConfigBundle();
  await configStore.replaceTaskTeamConfig({
    version: 1,
    roles: bundle.roles,
    rules: bundle.rules,
    teamTypes: bundle.teamTypes,
    orgStructures: [],
    orgRuntimeBindings: [],
    updatedAt: new Date().toISOString(),
  });
  // 显式再断言一次校验通过（无 error）
  const v = validator.validateTaskTeamConfig(configStore.readTaskTeamConfig());
  expect(v.errors).toEqual([]);

  // 2) 落一个监控实例：盯外部群 oc_external，绑定 analyst + observer 两个席位。
  const team = await store.createTaskTeam({
    typeId: moa.TT_TYPE_MOA_MONITOR,
    companyId: 'tt_company_moa' as TaskTeamInstance['companyId'],
    chatId: 'oc_team',
    targetExternalChatId: 'oc_external',
    goal: '盯外部群新 bug 并通知分析成员',
    acceptance: '外部新 bug 都通知到分析成员，连发不丢、噪声不误报',
    roleInstances: [
      ri('tt_ri_analyst', 'tt_slot_moa_analyst', 'tt_role_moa_analyst', 'ou_analyst'),
      ri('tt_ri_observer', 'tt_slot_moa_observer', 'tt_role_moa_observer', 'ou_observer'),
    ],
  });
  await store.updateTaskTeamStatus(team.teamId, 'running'); // 监控小组常驻 running
  return team.teamId;
}

// 既有 store/outbox/config 接到 observer+runtime 注入接口（真实现，非 fake 逻辑）。
function realDeps(mods: Awaited<ReturnType<typeof load>>): TaskTeamObserverDeps {
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

// 观测 exec：peek=fake（不打真群），detect=**真** observe-executors.detect（注入 fake judge/fetchSince）。
function observeExec(
  mods: Awaited<ReturnType<typeof load>>,
  batch: TaskTeamFetchedMessage[],
  judge: TaskTeamJudgeFn,
  deps: TaskTeamObserverDeps,
): TaskTeamObserverExecutors {
  const fetchSince: TaskTeamFetchSinceFn = async () => ({ messages: batch });
  const real = mods.observe.makeTaskTeamObserveExecutors('cli_obs', {
    judge,
    fetchSince,
    resolveType: deps.resolveType,
  });
  return { peek: async () => ({ hasNew: true, cursor: 'om_latest' }), detect: real.detect };
}

// fake 投递 executor：记录每条投递（既有 dispatcher tick 真实 claim→send→complete）。
function recordingDispatch(mods: Awaited<ReturnType<typeof load>>) {
  const deliveries: TaskTeamAction[] = [];
  const exec = {
    send: async (action: TaskTeamAction) => {
      deliveries.push(action);
      return { ok: true, messageId: `om_sent_${deliveries.length}` };
    },
    teamVersion: (id: TaskTeamId) => mods.store.getTaskTeam(id)?.version ?? null,
  };
  return { deliveries, exec };
}

describe('阶段三 · MoA 监控纯配置端到端', () => {
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'tt-moa-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('连发 N 个不同 bug → N 个 notify 全投递分析成员（不丢、幂等键各异、不进 reviewing、不依赖 role）', async () => {
    const mods = await load();
    const teamId = await setupMoaTeam(mods);
    const deps = realDeps(mods);

    // 外部群一批：3 个不同 bug（M1/M3/M5）+ 2 条噪声（M2/M4）；sender 都是**非绑定外部人**。
    const batch: TaskTeamFetchedMessage[] = [
      { id: 'om_bug_1', text: '登录页报 500 了', senderId: 'ou_user_a' },
      { id: 'om_noise_1', text: '谢谢大佬们～', senderId: 'ou_user_b' },
      { id: 'om_bug_2', text: '上传图片一直转圈传不上去', senderId: 'ou_user_c' },
      { id: 'om_noise_2', text: '今天天气不错', senderId: 'ou_user_d' },
      { id: 'om_bug_3', text: '导出报表数据错乱', senderId: 'ou_user_e' },
    ];
    // 受限槽判读：bug 消息判 new-bug（带各自 M{k} source），噪声不判（防误报）。
    const judge: TaskTeamJudgeFn = async () => [
      { type: 'new-bug', source: 'M1' },
      { type: 'new-bug', source: 'M3' },
      { type: 'new-bug', source: 'M5' },
    ];
    const exec = observeExec(mods, batch, judge, deps);

    // 真 observer tick：detect → applyTeamEvent（引擎 new-bug→notify）→ outbox enqueue
    const obsStats = await mods.observer.runTaskTeamObserverTick(new Date(), deps, exec);
    expect(obsStats.events).toBe(3); // 3 个外部 new-bug 事件真产出（不再 detected=1 events=0）

    // outbox：3 条 notify（幂等键各异）
    const actions = mods.outbox.readTaskTeamOutbox().actions;
    expect(actions).toHaveLength(3);
    expect(actions.every(a => a.actionType === 'notify')).toBe(true);
    expect(new Set(actions.map(a => a.idempotencyKey)).size).toBe(3); // 各异，不撞 key
    // 不依赖 role 归因：external 事件无 source role
    expect(actions.every(a => a.sourceRoleInstanceId === undefined)).toBe(true);
    // 投递目标都是 analyst 席
    expect(actions.every(a => a.targetSlotId === 'tt_slot_moa_analyst' && a.targetRoleInstanceId === 'tt_ri_analyst')).toBe(true);
    // 绝不进 reviewing：无 request-review 命令、状态仍 running
    expect(actions.some(a => a.actionType === 'request-review')).toBe(false);
    expect(mods.store.getTaskTeam(teamId)!.status).toBe('running');

    // 真 dispatcher tick：3 条全投递成功
    const { deliveries, exec: dispExec } = recordingDispatch(mods);
    const dispStats = await mods.dispatcher.runTaskTeamDispatcherTick(new Date(), dispExec);
    expect(dispStats.sent).toBe(3);
    expect(deliveries).toHaveLength(3);
    // 渲染内容 @ 分析成员（既有 dispatch-executors 渲染，无专门代码）
    const team = mods.store.getTaskTeam(teamId)!;
    const rendered = mods.dispatchExec.renderTaskTeamCommand(deliveries[0], team);
    expect(rendered).toContain('<at user_id="ou_analyst"></at>');
    expect(rendered).toContain('通知');
  });

  it('同一 bug 同 source 重放 → outbox 去重、不重复投递', async () => {
    const mods = await load();
    await setupMoaTeam(mods);
    const deps = realDeps(mods);
    const batch: TaskTeamFetchedMessage[] = [{ id: 'om_bug_dup', text: '支付回调 502', senderId: 'ou_user_x' }];
    const judge: TaskTeamJudgeFn = async () => [{ type: 'new-bug', source: 'M1' }];
    const exec = observeExec(mods, batch, judge, deps);

    // 第一遍：1 个 new-bug → 1 条 notify
    await mods.observer.runTaskTeamObserverTick(new Date(), deps, exec);
    const { deliveries, exec: dispExec } = recordingDispatch(mods);
    await mods.dispatcher.runTaskTeamDispatcherTick(new Date(), dispExec);
    expect(deliveries).toHaveLength(1);
    expect(mods.outbox.readTaskTeamOutbox().actions).toHaveLength(1);

    // 重放同一批（同 message id=同 sourceEventId=同幂等键）→ enqueue 去重 → outbox 不增、dispatcher 无新投递
    await mods.observer.runTaskTeamObserverTick(new Date(), deps, exec);
    expect(mods.outbox.readTaskTeamOutbox().actions).toHaveLength(1); // 去重
    await mods.dispatcher.runTaskTeamDispatcherTick(new Date(), dispExec);
    expect(deliveries).toHaveLength(1); // 那条已 sent，不重复投
  });

  it('纯噪声 → 零事件、零投递（不误报）', async () => {
    const mods = await load();
    const teamId = await setupMoaTeam(mods);
    const deps = realDeps(mods);
    const batch: TaskTeamFetchedMessage[] = [
      { id: 'om_n1', text: '哈哈哈', senderId: 'ou_user_p' },
      { id: 'om_n2', text: '周末去哪玩', senderId: 'ou_user_q' },
    ];
    const judge: TaskTeamJudgeFn = async () => []; // 受限槽判出无 new-bug
    const exec = observeExec(mods, batch, judge, deps);

    const obsStats = await mods.observer.runTaskTeamObserverTick(new Date(), deps, exec);
    expect(obsStats.events).toBe(0);
    expect(mods.outbox.readTaskTeamOutbox().actions).toHaveLength(0);

    const { deliveries, exec: dispExec } = recordingDispatch(mods);
    await mods.dispatcher.runTaskTeamDispatcherTick(new Date(), dispExec);
    expect(deliveries).toHaveLength(0);
    expect(mods.store.getTaskTeam(teamId)!.status).toBe('running'); // 噪声不改状态
  });

  it('防注入仍生效：judge 越权判 submit / 自造 source → 被丢，不产 notify', async () => {
    const mods = await load();
    await setupMoaTeam(mods);
    const deps = realDeps(mods);
    const batch: TaskTeamFetchedMessage[] = [{ id: 'om_x', text: '线上炸了', senderId: 'ou_user_z' }];
    // outputEventRegistry 收窄到 new-bug：judge 越权回 submit（白名单外）+ 一条自造 source 的 new-bug（解析不到 M{k}）
    const judge: TaskTeamJudgeFn = async () => [
      { type: 'submit', by: 'R1', source: 'M1' },          // 不在收窄白名单 → 丢
      { type: 'new-bug', source: 'om_evil_self_made' },     // 非系统别名 M{k} → 丢
    ];
    const exec = observeExec(mods, batch, judge, deps);
    const obsStats = await mods.observer.runTaskTeamObserverTick(new Date(), deps, exec);
    expect(obsStats.events).toBe(0); // 两条都被丢
    expect(mods.outbox.readTaskTeamOutbox().actions).toHaveLength(0);
  });
});
