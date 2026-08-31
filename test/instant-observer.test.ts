/**
 * instant-observer 单测 + 真实 schedule-store 集成测试。
 *
 * 覆盖 review T6R 阻塞项：
 *   P1-1 自激：open_id / app_id 双域自我判定（app_id-only 回声不触发）
 *   P1-2 撤销：off/remove/切 app 撤销 pending + 执行前 fail-closed 预检
 *   P1-3 生命周期：repeat=1 → markRun 后真实 schedule-store 真删（不留 disabled 残留）
 *   P2-1 原子防抖：chat+app 稳定 id + store 锁内 create-or-merge，断言只一条 pending
 *
 * Run: pnpm vitest run test/instant-observer.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatPolicy } from '../src/services/chat-policy-store.js';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  // dataDir 放 tempDir/data：schedule-store 的 per-bot 路径是 dirname(dataDir)/bots/<app>，
  // 这样 bots 目录也落在 tempDir 里，不污染真实 /tmp。
  config: { get session() { return { dataDir: join(tempDir, 'data') }; } },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

async function fresh() {
  vi.resetModules();
  const mods = {
    instant: await import('../src/services/instant-observer.js'),
    policyStore: await import('../src/services/chat-policy-store.js'),
    scheduleStore: await import('../src/services/schedule-store.js'),
    scheduler: await import('../src/core/scheduler.js'),
  };
  // 生产里 daemon 启动即把 store 绑到自己的 bot；markRun 等默认走 bound scope。
  mods.scheduleStore.setScheduleScope(OBSERVER_APP);
  return mods;
}

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'instant-observer-')); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

const OBSERVER_APP = 'cli_observer0001';
const OBSERVER_OPEN_ID = 'ou_observer_self';

function instantPolicy(chatId: string, over: Record<string, unknown> = {}): ChatPolicy {
  return {
    chatId,
    driveOn: false,
    reportTargetChatId: null,
    scoutMode: 'watch',
    instantObserver: { enabled: true, larkAppId: OBSERVER_APP, ...over },
    updatedAt: new Date().toISOString(),
  } as ChatPolicy;
}

/** 决策层专用：scheduleOnce 打桩，只记请求。 */
function stubDeps(policies: Map<string, ChatPolicy>, opts: { now?: () => number; outcome?: 'created' | 'merged' } = {}) {
  const requests: any[] = [];
  const deps = {
    getPolicy: (chatId: string) => policies.get(chatId) ?? null,
    scheduleOnce: (req: any) => { requests.push(req); return opts.outcome ?? ('created' as const); },
    now: opts.now ?? (() => Date.now()),
    defaultWorkingDir: () => '/work',
  };
  return { deps, requests };
}

// ─── 决策核心（依赖注入） ───────────────────────────────────────────────────

describe('instant-observer 触发判定', () => {
  it('非 observer 自身的新消息 → scheduled，请求字段完备（稳定 id / runAt=now+90s 默认）', async () => {
    const { instant } = await fresh();
    const chat = 'oc_chat_a';
    const now = 1_000_000_000_000;
    const { deps, requests } = stubDeps(new Map([[chat, instantPolicy(chat)]]), { now: () => now });

    const d = await instant.noteInstantObserverMessageWith(
      { larkAppId: OBSERVER_APP, chatId: chat, senderOpenId: 'ou_worker', botOpenId: OBSERVER_OPEN_ID },
      deps,
    );
    expect(d).toBe('scheduled');
    expect(requests).toHaveLength(1);
    const r = requests[0];
    expect(r.id).toBe(instant.instantTaskId(chat, OBSERVER_APP));
    expect(r.name).toBe(instant.instantTaskName(chat));
    expect(r.chatId).toBe(chat);
    expect(r.larkAppId).toBe(OBSERVER_APP);
    expect(r.debounceSeconds).toBe(90);
    expect(new Date(r.runAt).getTime()).toBe(now + 90_000);
    expect(r.prompt).toContain('幂等对账'); // 默认 prompt
  });

  it('scheduleOnce=merged → 决策 merged（防抖窗口内合并）', async () => {
    const { instant } = await fresh();
    const chat = 'oc_chat_a';
    const { deps } = stubDeps(new Map([[chat, instantPolicy(chat)]]), { outcome: 'merged' });
    const d = await instant.noteInstantObserverMessageWith(
      { larkAppId: OBSERVER_APP, chatId: chat, senderOpenId: 'ou_worker', botOpenId: OBSERVER_OPEN_ID },
      deps,
    );
    expect(d).toBe('merged');
  });

  it('P1-1：自我消息双域判定 —— open_id 命中 / app_id-only 回声命中，都不触发', async () => {
    const { instant } = await fresh();
    const chat = 'oc_chat_a';
    const { deps, requests } = stubDeps(new Map([[chat, instantPolicy(chat)]]));

    // open_id 域命中
    expect(await instant.noteInstantObserverMessageWith(
      { larkAppId: OBSERVER_APP, chatId: chat, senderOpenId: OBSERVER_OPEN_ID, botOpenId: OBSERVER_OPEN_ID },
      deps,
    )).toBe('self-message');
    // app_id-only 回声（review 复现场景：Lark 只给 bot sender 的 app_id）
    expect(await instant.noteInstantObserverMessageWith(
      { larkAppId: OBSERVER_APP, chatId: chat, senderAppId: OBSERVER_APP, botOpenId: OBSERVER_OPEN_ID },
      deps,
    )).toBe('self-message');
    expect(requests).toHaveLength(0);

    // 别的 bot 的 app_id → 照常触发
    expect(await instant.noteInstantObserverMessageWith(
      { larkAppId: OBSERVER_APP, chatId: chat, senderAppId: 'cli_other_bot', botOpenId: OBSERVER_OPEN_ID },
      deps,
    )).toBe('scheduled');
    expect(requests).toHaveLength(1);
  });

  it('未配置 / 关闭 / 别的 bot 的策略 → 不触发', async () => {
    const { instant } = await fresh();
    const policies = new Map([
      ['oc_disabled', instantPolicy('oc_disabled', { enabled: false })],
      ['oc_otherapp', instantPolicy('oc_otherapp', { larkAppId: 'cli_someone_else' })],
    ]);
    const { deps, requests } = stubDeps(policies);
    const base = { larkAppId: OBSERVER_APP, senderOpenId: 'ou_worker', botOpenId: OBSERVER_OPEN_ID };

    expect(await instant.noteInstantObserverMessageWith({ ...base, chatId: 'oc_no_policy' }, deps)).toBe('no-policy');
    expect(await instant.noteInstantObserverMessageWith({ ...base, chatId: 'oc_disabled' }, deps)).toBe('disabled');
    expect(await instant.noteInstantObserverMessageWith({ ...base, chatId: 'oc_otherapp' }, deps)).toBe('other-app');
    expect(requests).toHaveLength(0);
  });

  it('防抖窗口收敛 60~120s；自定义 prompt 优先', async () => {
    const { instant } = await fresh();
    expect(instant.clampDebounceSeconds(undefined)).toBe(90);
    expect(instant.clampDebounceSeconds(30)).toBe(60);
    expect(instant.clampDebounceSeconds(999)).toBe(120);
    expect(instant.clampDebounceSeconds(75)).toBe(75);

    const chat = 'oc_chat_a';
    const now = 2_000_000_000_000;
    const { deps, requests } = stubDeps(
      new Map([[chat, instantPolicy(chat, { debounceSeconds: 120, prompt: '按 process.md 幂等对账' })]]),
      { now: () => now },
    );
    await instant.noteInstantObserverMessageWith(
      { larkAppId: OBSERVER_APP, chatId: chat, senderOpenId: 'ou_worker', botOpenId: OBSERVER_OPEN_ID },
      deps,
    );
    expect(requests[0].prompt).toBe('按 process.md 幂等对账');
    expect(new Date(requests[0].runAt).getTime()).toBe(now + 120_000);
  });
});

// ─── 真实 schedule-store + scheduler 集成 ───────────────────────────────────

function realReq(instant: any, chat: string, over: Record<string, unknown> = {}) {
  const debounce = 90;
  return {
    id: instant.instantTaskId(chat, OBSERVER_APP),
    name: instant.instantTaskName(chat),
    chatId: chat,
    larkAppId: OBSERVER_APP,
    prompt: '对账一轮',
    workingDir: '/work',
    debounceSeconds: debounce,
    runAt: new Date(Date.now() + debounce * 1000).toISOString(),
    ...over,
  };
}

describe('scheduleInstantOnceTask × 真实 schedule-store（P1-3 / P2-1）', () => {
  it('created → store 恰有一条 pending：once + silent + top-level + repeat={times:1}', async () => {
    const { instant, scheduleStore } = await fresh();
    const chat = 'oc_chat_a';
    expect(await instant.scheduleInstantOnceTask(realReq(instant, chat))).toBe('created');

    const tasks = scheduleStore.listTasks(OBSERVER_APP);
    expect(tasks).toHaveLength(1);
    const t = tasks[0];
    expect(t.id).toBe(instant.instantTaskId(chat, OBSERVER_APP));
    expect(t.parsed.kind).toBe('once');
    expect(t.silent).toBe(true);
    expect(t.executionPosition).toBe('top-level');
    expect(t.repeat).toEqual({ times: 1, completed: 0 });
    expect(t.enabled).toBe(true);
    expect(t.nextRunAt).toBe(t.parsed.runAt);
  });

  it('防抖合并：窗口内再次调度 → merged，store 仍只一条 pending（P2-1）', async () => {
    const { instant, scheduleStore } = await fresh();
    const chat = 'oc_chat_a';
    expect(await instant.scheduleInstantOnceTask(realReq(instant, chat))).toBe('created');
    expect(await instant.scheduleInstantOnceTask(realReq(instant, chat))).toBe('merged');
    expect(await instant.scheduleInstantOnceTask(realReq(instant, chat))).toBe('merged');
    expect(scheduleStore.listTasks(OBSERVER_APP)).toHaveLength(1);
  });

  it('P2-1 原子底座：同稳定 id 并发第二写在 store 锁内判 IdempotencyConflictError，只留一条', async () => {
    const { instant, scheduler, scheduleStore } = await fresh();
    const chat = 'oc_chat_a';
    const mk = (runAt: string) => scheduler.addTask({
      id: instant.instantTaskId(chat, OBSERVER_APP),
      name: instant.instantTaskName(chat),
      schedule: 'instant+90s',
      prompt: '对账一轮',
      workingDir: '/work',
      chatId: chat,
      chatType: 'topic_group',
      scope: 'chat',
      executionPosition: 'top-level',
      larkAppId: OBSERVER_APP,
      parsed: { kind: 'once', runAt, display: 'x' },
      repeat: { times: 1, completed: 0 },
      silent: true,
    });
    mk(new Date(Date.now() + 90_000).toISOString());
    // 并发 writer 语义：绕过快路径直接 addTask（不同 runAt → 不同 canonical input）
    expect(() => mk(new Date(Date.now() + 95_000).toISOString()))
      .toThrowError(scheduleStore.IdempotencyConflictError);
    expect(scheduleStore.listTasks(OBSERVER_APP)).toHaveLength(1);
  });

  it('P1-3：markRun 完成后任务被真实 store 真删（非 disabled 残留），下一条消息开新窗口', async () => {
    const { instant, scheduleStore } = await fresh();
    const chat = 'oc_chat_a';
    await instant.scheduleInstantOnceTask(realReq(instant, chat));
    const id = instant.instantTaskId(chat, OBSERVER_APP);

    scheduleStore.markRun(id, true);
    // 真删：不是 enabled=false 的残行，而是整行消失
    expect(scheduleStore.listTasks(OBSERVER_APP)).toHaveLength(0);
    expect(scheduleStore.getTask(id, OBSERVER_APP)).toBeUndefined();

    // 新窗口正常开启
    expect(await instant.scheduleInstantOnceTask(realReq(instant, chat))).toBe('created');
    expect(scheduleStore.listTasks(OBSERVER_APP)).toHaveLength(1);
  });

  it('残留自愈：fired 超过 in-flight grace 的残行（崩溃）→ 清掉重建；grace 内 → merge 不动', async () => {
    const { instant, scheduleStore } = await fresh();
    const chat = 'oc_chat_a';
    await instant.scheduleInstantOnceTask(realReq(instant, chat));
    const id = instant.instantTaskId(chat, OBSERVER_APP);

    // fired 但还在 grace 内 → in-flight，merge、行原封不动（ABA 防护第一道）
    scheduleStore.updateTask(id, { lastRunAt: new Date().toISOString() }, OBSERVER_APP);
    expect(await instant.scheduleInstantOnceTask(realReq(instant, chat))).toBe('merged');
    expect(scheduleStore.getTask(id, OBSERVER_APP)!.lastRunAt).toBeDefined(); // 没被删建

    // fired 超过 grace（模拟进程崩溃、markRun 永远不来）→ 残留，删除重建
    scheduleStore.updateTask(id, {
      lastRunAt: new Date(Date.now() - instant.IN_FLIGHT_GRACE_MS - 60_000).toISOString(),
      enabled: false,
    }, OBSERVER_APP);
    expect(await instant.scheduleInstantOnceTask(realReq(instant, chat))).toBe('created');
    const tasks = scheduleStore.listTasks(OBSERVER_APP);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].enabled).toBe(true);
    expect(tasks[0].lastRunAt).toBeUndefined();
  });

  it('多群互不干扰：两个群各自成任务，id/name 按群隔离', async () => {
    const { instant, scheduleStore } = await fresh();
    expect(await instant.scheduleInstantOnceTask(realReq(instant, 'oc_chat_a'))).toBe('created');
    expect(await instant.scheduleInstantOnceTask(realReq(instant, 'oc_chat_b'))).toBe('created');
    expect(await instant.scheduleInstantOnceTask(realReq(instant, 'oc_chat_a'))).toBe('merged');
    const tasks = scheduleStore.listTasks(OBSERVER_APP);
    expect(tasks).toHaveLength(2);
    expect(new Set(tasks.map(t => t.id)).size).toBe(2);
  });

  it('与 15 分钟 cron 并存：cron 不算 pending、不被撤销、预检不拦', async () => {
    const { instant, scheduler, scheduleStore } = await fresh();
    const chat = 'oc_chat_a';
    const cron = scheduler.addTask({
      name: 'observer事件轮-15min',
      schedule: '*/15 * * * *',
      prompt: '幂等对账',
      workingDir: '/work',
      chatId: chat,
      chatType: 'topic_group',
      scope: 'chat',
      executionPosition: 'top-level',
      larkAppId: OBSERVER_APP,
      silent: true,
    });
    // cron 在场不影响 instant 触发
    expect(await instant.scheduleInstantOnceTask(realReq(instant, chat))).toBe('created');
    expect(scheduleStore.listTasks(OBSERVER_APP)).toHaveLength(2);
    // 撤销只删 instant，不动 cron
    expect(instant.cancelPendingInstantTasks(chat, OBSERVER_APP)).toBe(1);
    const left = scheduleStore.listTasks(OBSERVER_APP);
    expect(left).toHaveLength(1);
    expect(left[0].id).toBe(cron.id);
    // 预检对 cron（非 instant 任务）恒放行
    expect(instant.instantTaskStillWanted(cron)).toBe(true);
  });
});

// ─── r2 P1：稳定 id ABA 生命周期竞态（精确交错） ────────────────────────────

describe('r2 P1：ABA 交错 —— 旧回调在途/迟到时稳定 id 不被误用', () => {
  const sleepMs = (ms: number) => new Promise(r => setTimeout(r, ms));

  it('in-flight 交错：A fired → 新消息 merge（不删不建）→ A markRun 正常收尾 → 新窗口照开', async () => {
    const { instant, scheduleStore } = await fresh();
    const chat = 'oc_chat_a';
    const id = instant.instantTaskId(chat, OBSERVER_APP);

    await instant.scheduleInstantOnceTask(realReq(instant, chat));
    const a = scheduleStore.getTask(id, OBSERVER_APP)!;
    // scheduler tick 触发序：先写 lastRunAt，再异步跑 callback
    scheduleStore.updateTask(id, { lastRunAt: new Date().toISOString() }, OBSERVER_APP);

    // callback 在途时新消息到达 → in-flight merge，A 原样保留（不做删建）
    expect(await instant.scheduleInstantOnceTask(realReq(instant, chat))).toBe('merged');
    expect(scheduleStore.getTask(id, OBSERVER_APP)!.createdAt).toBe(a.createdAt);

    // 旧 callback resolve → markRun（带 A 的 generation）→ 命中 A 自己，真删
    scheduleStore.markRun(id, true, undefined, undefined, { expectedCreatedAt: a.createdAt });
    expect(scheduleStore.getTask(id, OBSERVER_APP)).toBeUndefined();

    // 下一条消息正常开新窗口
    expect(await instant.scheduleInstantOnceTask(realReq(instant, chat))).toBe('created');
  });

  it('review 复现修复：A 残留 → B 重建（同 id）→ 迟到的 A.markRun 被 CAS 跳过，B 仍存在且最终可触发', async () => {
    const { instant, scheduleStore } = await fresh();
    const chat = 'oc_chat_a';
    const id = instant.instantTaskId(chat, OBSERVER_APP);

    await instant.scheduleInstantOnceTask(realReq(instant, chat));
    const a = scheduleStore.getTask(id, OBSERVER_APP)!;
    // A fired 且超过 grace（僵尸回调场景）
    scheduleStore.updateTask(id, {
      lastRunAt: new Date(Date.now() - instant.IN_FLIGHT_GRACE_MS - 60_000).toISOString(),
    }, OBSERVER_APP);
    await sleepMs(5); // 保证 B 的 createdAt 与 A 不同 ms

    // 新消息 → reconcile：删 A 建 B（同稳定 id、新 generation）
    expect(await instant.scheduleInstantOnceTask(realReq(instant, chat))).toBe('created');
    const b = scheduleStore.getTask(id, OBSERVER_APP)!;
    expect(b.createdAt).not.toBe(a.createdAt);

    // 僵尸回调迟到，按 id 回写但带的是 A 的 generation → 整体跳过，B 不受影响
    scheduleStore.markRun(id, true, undefined, undefined, { expectedCreatedAt: a.createdAt });
    const bAfter = scheduleStore.getTask(id, OBSERVER_APP)!;
    expect(bAfter).toBeDefined();                    // ← review 复现里这里曾是 []
    expect(bAfter.createdAt).toBe(b.createdAt);
    expect(bAfter.enabled).toBe(true);
    expect(bAfter.lastRunAt).toBeUndefined();
    expect(bAfter.repeat).toEqual({ times: 1, completed: 0 }); // repeat 计数未被误进
    expect(new Date(bAfter.nextRunAt!).getTime()).toBeGreaterThan(Date.now()); // 最终可触发

    // B 自己的生命周期照常走完：fire → markRun(带 B generation) → 真删
    scheduleStore.updateTask(id, { lastRunAt: new Date().toISOString() }, OBSERVER_APP);
    scheduleStore.markRun(id, true, undefined, undefined, { expectedCreatedAt: b.createdAt });
    expect(scheduleStore.getTask(id, OBSERVER_APP)).toBeUndefined();
  });

  it('cancel/off 后快速 re-enable：旧回调迟到 markRun 不影响新窗口任务', async () => {
    const { instant, policyStore, scheduleStore } = await fresh();
    const chat = 'oc_chat_a';
    const id = instant.instantTaskId(chat, OBSERVER_APP);
    policyStore.setPolicy(chat, { instantObserver: { enabled: true, larkAppId: OBSERVER_APP } });

    await instant.scheduleInstantOnceTask(realReq(instant, chat));
    const a = scheduleStore.getTask(id, OBSERVER_APP)!;
    // A 已 fired、callback 在途
    scheduleStore.updateTask(id, { lastRunAt: new Date().toISOString() }, OBSERVER_APP);

    // --instant off：撤销把 in-flight 的 A 也删掉（off 语义优先）
    policyStore.setPolicy(chat, { instantObserver: null });
    expect(instant.cancelPendingInstantTasks(chat, OBSERVER_APP)).toBe(1);
    await sleepMs(5);

    // 快速 re-enable + 新消息 → B（同 id、新 generation）
    policyStore.setPolicy(chat, { instantObserver: { enabled: true, larkAppId: OBSERVER_APP } });
    expect(await instant.scheduleInstantOnceTask(realReq(instant, chat))).toBe('created');
    const b = scheduleStore.getTask(id, OBSERVER_APP)!;
    expect(b.createdAt).not.toBe(a.createdAt);

    // 旧回调迟到 → CAS 跳过，B 完好、预检放行（最终可触发）
    scheduleStore.markRun(id, false, 'zombie error', undefined, { expectedCreatedAt: a.createdAt });
    const bAfter = scheduleStore.getTask(id, OBSERVER_APP)!;
    expect(bAfter).toBeDefined();
    expect(bAfter.createdAt).toBe(b.createdAt);
    expect(bAfter.lastStatus).toBeUndefined(); // 僵尸错误没被记到新行上
    expect(instant.instantTaskStillWanted(bAfter)).toBe(true);
  });
});

// ─── r2 P2：宽泛前缀不误伤用户任务 ─────────────────────────────────────────

describe('r2 P2：内部任务严格 shape 鉴别，不误伤同名用户任务', () => {
  it('同 chat/app 同名（instant-observer:<chat>）的用户 cron：不被撤销、预检不拦、不算内部任务', async () => {
    const { instant, scheduler, scheduleStore } = await fresh();
    const chat = 'oc_chat_a';
    // 用户手建的同名 cron（随机 id、非 once/repeat 形状）
    const userCron = scheduler.addTask({
      name: instant.instantTaskName(chat), // 撞约定 name
      schedule: '*/15 * * * *',
      prompt: '用户自己的轮询',
      workingDir: '/work',
      chatId: chat,
      chatType: 'topic_group',
      scope: 'chat',
      executionPosition: 'top-level',
      larkAppId: OBSERVER_APP,
      silent: true,
    });
    expect(instant.isInstantObserverTask(userCron)).toBe(false);
    // 该群根本没配 instant 策略 → 若被误判内部任务会被 stale 掉；严格 shape 下不拦
    expect(scheduler.shouldDropStaleInstantTask(userCron)).toBe(false);
    // off 撤销也不碰它
    expect(instant.cancelPendingInstantTasks(chat, OBSERVER_APP)).toBe(0);
    expect(scheduleStore.listTasks(OBSERVER_APP)).toHaveLength(1);
  });

  it('同名 once + silent 但随机 id 的用户任务：同样不算内部、不被撤销', async () => {
    const { instant, scheduler, scheduleStore } = await fresh();
    const chat = 'oc_chat_a';
    const userOnce = scheduler.addTask({
      name: instant.instantTaskName(chat),
      schedule: '30m',
      prompt: '用户自己的一次性提醒',
      workingDir: '/work',
      chatId: chat,
      chatType: 'topic_group',
      scope: 'chat',
      executionPosition: 'top-level',
      larkAppId: OBSERVER_APP,
      parsed: { kind: 'once', runAt: new Date(Date.now() + 30 * 60_000).toISOString(), display: '30m' },
      silent: true,
    });
    expect(instant.isInstantObserverTask(userOnce)).toBe(false); // id 非派生稳定 id、无 repeat=1
    expect(instant.cancelPendingInstantTasks(chat, OBSERVER_APP)).toBe(0);
    expect(scheduleStore.listTasks(OBSERVER_APP)).toHaveLength(1);
    // 真内部任务与之并存时，撤销只删内部那条
    await instant.scheduleInstantOnceTask(realReq(instant, chat));
    expect(scheduleStore.listTasks(OBSERVER_APP)).toHaveLength(2);
    expect(instant.cancelPendingInstantTasks(chat, OBSERVER_APP)).toBe(1);
    const left = scheduleStore.listTasks(OBSERVER_APP);
    expect(left).toHaveLength(1);
    expect(left[0].id).toBe(userOnce.id);
  });
});

// ─── P1-2：off/remove/切 app 撤销 + fail-closed 预检 ────────────────────────

describe('P1-2 撤销与执行前 fail-closed 预检', () => {
  it('排队后 off：策略清空 → 预检判 stale（tick 会删掉不执行），cancel 清掉 pending', async () => {
    const { instant, policyStore, scheduleStore, scheduler } = await fresh();
    const chat = 'oc_chat_a';
    policyStore.setPolicy(chat, { instantObserver: { enabled: true, larkAppId: OBSERVER_APP } });
    await instant.scheduleInstantOnceTask(realReq(instant, chat));
    const task = scheduleStore.listTasks(OBSERVER_APP)[0];

    // 策略在场 → 预检放行
    expect(instant.instantTaskStillWanted(task)).toBe(true);
    expect(scheduler.shouldDropStaleInstantTask(task)).toBe(false);

    // off（等价 --instant off 落库动作）
    policyStore.setPolicy(chat, { instantObserver: null });
    expect(instant.instantTaskStillWanted(task)).toBe(false);
    expect(scheduler.shouldDropStaleInstantTask(task)).toBe(true); // tick 执行前会 drop

    // CLI 侧撤销：pending 清空
    expect(instant.cancelPendingInstantTasks(chat, OBSERVER_APP)).toBe(1);
    expect(scheduleStore.listTasks(OBSERVER_APP)).toHaveLength(0);
  });

  it('切 app：旧 app 的 pending 预检判 stale，不再执行', async () => {
    const { instant, policyStore, scheduleStore } = await fresh();
    const chat = 'oc_chat_a';
    policyStore.setPolicy(chat, { instantObserver: { enabled: true, larkAppId: OBSERVER_APP } });
    await instant.scheduleInstantOnceTask(realReq(instant, chat));
    const oldTask = scheduleStore.listTasks(OBSERVER_APP)[0];

    // observer 切到新 app
    policyStore.setPolicy(chat, { instantObserver: { enabled: true, larkAppId: 'cli_new_observer' } });
    expect(instant.instantTaskStillWanted(oldTask)).toBe(false); // 旧 app 任务作废
  });

  it('watch remove（策略整条删除）后预检 fail-closed', async () => {
    const { instant, policyStore, scheduleStore } = await fresh();
    const chat = 'oc_chat_a';
    policyStore.setPolicy(chat, { instantObserver: { enabled: true, larkAppId: OBSERVER_APP } });
    await instant.scheduleInstantOnceTask(realReq(instant, chat));
    const task = scheduleStore.listTasks(OBSERVER_APP)[0];

    policyStore.removePolicy(chat);
    expect(instant.instantTaskStillWanted(task)).toBe(false);
  });
});

// ─── 端到端（决策核心 × 真实 policy/schedule store） ────────────────────────

describe('端到端：真实 policy + 真实 store', () => {
  it('scheduled → merged → self（app_id 回声）全链路', async () => {
    const { instant, policyStore, scheduleStore } = await fresh();
    const chat = 'oc_chat_e2e';
    policyStore.setPolicy(chat, { instantObserver: { enabled: true, larkAppId: OBSERVER_APP } });
    const deps = {
      getPolicy: policyStore.getPolicy,
      scheduleOnce: instant.scheduleInstantOnceTask,
      now: () => Date.now(),
      defaultWorkingDir: () => '/work',
    };
    const base = { larkAppId: OBSERVER_APP, chatId: chat, botOpenId: OBSERVER_OPEN_ID };

    expect(await instant.noteInstantObserverMessageWith({ ...base, senderOpenId: 'ou_worker' }, deps)).toBe('scheduled');
    expect(await instant.noteInstantObserverMessageWith({ ...base, senderOpenId: 'ou_worker2' }, deps)).toBe('merged');
    expect(await instant.noteInstantObserverMessageWith({ ...base, senderAppId: OBSERVER_APP }, deps)).toBe('self-message');
    expect(scheduleStore.listTasks(OBSERVER_APP)).toHaveLength(1);
  });
});

// ─── chat-policy-store instantObserver 字段 ────────────────────────────────

describe('chat-policy-store instantObserver 字段', () => {
  it('setPolicy 落盘 + 局部 patch 不动其它字段 + null 清除', async () => {
    const { policyStore } = await fresh();
    policyStore.setPolicy('oc_x', {
      scoutMode: 'mute',
      instantObserver: { enabled: true, larkAppId: OBSERVER_APP, debounceSeconds: 100, prompt: null },
    });
    let p = policyStore.getPolicy('oc_x')!;
    expect(p.instantObserver).toEqual({ enabled: true, larkAppId: OBSERVER_APP, debounceSeconds: 100, prompt: null });
    expect(p.scoutMode).toBe('mute');

    policyStore.setPolicy('oc_x', { driveOn: true, driveGoal: 'g' });
    p = policyStore.getPolicy('oc_x')!;
    expect(p.instantObserver?.enabled).toBe(true);
    expect(p.driveOn).toBe(true);

    policyStore.setPolicy('oc_x', { instantObserver: null });
    p = policyStore.getPolicy('oc_x')!;
    expect(p.instantObserver).toBeNull();
    expect(p.scoutMode).toBe('mute');
  });
});
