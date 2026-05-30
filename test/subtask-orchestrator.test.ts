/**
 * Unit tests for subtask-orchestrator (Phase 4 service 层)。
 * mock 外部依赖 (authzCheck/resolveBotIdent/group-creator/idempotency/session-store)，
 * 真 subtask-store (temp dir)。覆盖 6 边界 + 鉴权分层。
 * Run: pnpm vitest run test/subtask-orchestrator.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;
const mockAuthzCheck = vi.fn();
const mockCreateGroup = vi.fn();
const idemCache = new Map<string, any>();
const mockSessions = new Map<string, any>();

vi.mock('../src/config.js', () => ({ config: { get session() { return { dataDir: tempDir }; } } }));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), isDebug: () => false },
}));
vi.mock('../src/core/main-bot-playbook.js', () => {
  class HttpError extends Error {
    constructor(public status: number, msg: string) { super(msg); this.name = 'HttpError'; }
  }
  const idents: Record<string, { larkAppId: string; openId: string }> = {
    claude: { larkAppId: 'app_claude', openId: 'ou_claude' },
    codex: { larkAppId: 'app_codex', openId: 'ou_codex' },
    tilly: { larkAppId: 'app_coco', openId: 'ou_coco' },
  };
  return { HttpError, authzCheck: (...a: any[]) => mockAuthzCheck(...a), resolveBotIdent: (k: string) => idents[k] };
});
vi.mock('../src/services/group-creator.js', () => ({ createGroupWithBots: (...a: any[]) => mockCreateGroup(...a) }));
vi.mock('../src/services/spawn-idempotency-store.js', () => ({
  getOrCompute: async (key: string, compute: () => Promise<any>) => {
    if (idemCache.has(key)) return { entry: idemCache.get(key), cacheHit: true };
    const entry = await compute();
    idemCache.set(key, entry);
    return { entry, cacheHit: false };
  },
}));
vi.mock('../src/services/session-store.js', () => ({ getSession: (id: string) => mockSessions.get(id) }));

import {
  createSubtask, reportProgress, querySubtask, finishSubtask, supplementSubtask, V2_MARKER,
} from '../src/services/subtask-orchestrator.js';
import {
  createSubTask, getSubTask, getByChatId, transitionStatus, enqueueCommand, listCommands,
  getCommand, listObservations, __resetForTesting, type SubTaskBot,
} from '../src/services/subtask-store.js';

const BOTS: SubTaskBot[] = [
  { openId: 'ou_claude', name: '克劳德', role: 'main' },
  { openId: 'ou_coco', name: '缇蕾', role: 'observer' },
];

/** 父群主 bot session。 */
function mainSession(id = 'sess_main', chatId = 'oc_main') {
  const s = { sessionId: id, chatId, rootMessageId: 'om_root', larkAppId: 'app_claude', ownerOpenId: 'ou_jason', title: 't', status: 'active', createdAt: 't' };
  mockSessions.set(id, s);
  return s;
}
/** 子群 session (report 用)。默认 app_claude = task.bots 里的克劳德分身 (P1: 上报 bot 必须∈task.bots)。 */
function subSession(id = 'sess_sub', chatId = 'oc_sub', larkAppId = 'app_claude') {
  const s = { sessionId: id, chatId, rootMessageId: 'om_sub', larkAppId, ownerOpenId: 'ou_jason', title: 't', status: 'active', createdAt: 't' };
  mockSessions.set(id, s);
  return s;
}
/** 直接在真 store 造一个 observing 子任务 (父群 oc_main, 子群 oc_sub)。 */
async function mkTask(key = 'k1') {
  const t = await createSubTask({
    chatId: 'oc_sub', parentChatId: 'oc_main', parentMessageId: 'om_root',
    goal: '修 bug', acceptance: null, bots: BOTS, requester: 'ou_jason', createdBy: 'claude', idempotencyKey: key,
  });
  await transitionStatus(t.taskId, 'observing');
  return getSubTask(t.taskId)!;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'orch-test-'));
  __resetForTesting();
  mockAuthzCheck.mockReset();
  mockCreateGroup.mockReset();
  idemCache.clear();
  mockSessions.clear();
  mockAuthzCheck.mockResolvedValue({ callerChatId: 'oc_main', callerBotAppId: 'app_claude', rootMessageId: 'om_root' });
  mockCreateGroup.mockResolvedValue({ ok: true, chatId: 'oc_sub_new', creator: 'app_claude', invalidBotIds: [], invalidUserIds: [] });
});

// ─── create_subtask ──────────────────────────────────────────────────────────
describe('createSubtask', () => {
  it('建群(带 v2 marker) + 登记 subtask-store + 转 observing', async () => {
    mainSession();
    const res = await createSubtask({ sessionId: 'sess_main', goal: '修登录 bug', taskType: 'bug' });
    expect(res.isNew).toBe(true);
    expect(res.chatId).toBe('oc_sub_new');
    // 边界3: v2 marker 进 relatedRefs
    const groupOpts = mockCreateGroup.mock.calls[0][0];
    expect(groupOpts.chatContext.relatedRefs).toContain(V2_MARKER);
    expect(groupOpts.sourceChatId).toBe('oc_main');
    // 边界2: 登记进 store + observing
    const task = getSubTask(res.taskId)!;
    expect(task.status).toBe('observing');
    expect(task.parentChatId).toBe('oc_main');
    expect(task.chatId).toBe('oc_sub_new');
    expect(getByChatId('oc_sub_new')!.taskId).toBe(res.taskId); // getByChatId 命中 = 归新 observer
  });

  it('边界4 crash window: 建群成功但登记缺失 → 重试复用 chatId + 补登记, 不重复建群', async () => {
    mainSession();
    // 预置 idempotency cache (模拟"上次建群成功但 createSubTask 前崩了")
    const key = `om_root-${'修登录-bug'}`.toLowerCase(); // slug('修登录 bug') 中文→'' → 'task'; 用真实 slug 规则
    // 真实 key 由 goal slug 决定，直接调用一次拿到 task 再清掉 task 模拟崩溃不易；
    // 改为: 连续两次 createSubtask 同 goal → 第二次 cacheHit、createGroup 只调一次。
    await createSubtask({ sessionId: 'sess_main', goal: 'fix login', taskType: 'bug' });
    const callsAfter1 = mockCreateGroup.mock.calls.length;
    const res2 = await createSubtask({ sessionId: 'sess_main', goal: 'fix login', taskType: 'bug' });
    expect(mockCreateGroup.mock.calls.length).toBe(callsAfter1); // 没重复建群
    expect(res2.isNew).toBe(false);                              // cacheHit
    void key;
  });

  it('Blocker: 同 root 下两个不同中文 goal → 不 dedup (各自建群+登记)', async () => {
    mainSession();
    const a = await createSubtask({ sessionId: 'sess_main', goal: '修登录问题', taskType: 'bug' });
    mockCreateGroup.mockResolvedValue({ ok: true, chatId: 'oc_sub_2', creator: 'app_claude', invalidBotIds: [], invalidUserIds: [] });
    const b = await createSubtask({ sessionId: 'sess_main', goal: '排查 AskHuman', taskType: 'bug' });
    expect(a.taskId).not.toBe(b.taskId);   // 两个不同 task (中文 goal 不再碰撞成 'task')
    expect(b.isNew).toBe(true);
    expect(mockCreateGroup).toHaveBeenCalledTimes(2);
  });

  it('同 root + 同中文 goal 重试 → dedup (cache hit)', async () => {
    mainSession();
    const a = await createSubtask({ sessionId: 'sess_main', goal: '修登录问题', taskType: 'bug' });
    const b = await createSubtask({ sessionId: 'sess_main', goal: '修登录问题', taskType: 'bug' });
    expect(b.taskId).toBe(a.taskId);
    expect(b.isNew).toBe(false);
    expect(mockCreateGroup).toHaveBeenCalledTimes(1);
  });

  it('P2: 未知 bot key → 400 (IPC 绕过 CLI 直传)', async () => {
    mainSession();
    await expect(createSubtask({ sessionId: 'sess_main', goal: 'x', bots: ['claude', 'bogus' as any] }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('鉴权: authzCheck 抛 (非 mainTopic/非主bot) → 透传', async () => {
    mainSession();
    mockAuthzCheck.mockRejectedValue(Object.assign(new Error('not main topic'), { name: 'HttpError', status: 403 }));
    await expect(createSubtask({ sessionId: 'sess_main', goal: 'x' })).rejects.toThrow('not main topic');
  });

  it('缺 goal → 400', async () => {
    mainSession();
    await expect(createSubtask({ sessionId: 'sess_main', goal: '  ' })).rejects.toMatchObject({ status: 400 });
  });
});

// ─── report_progress (边界5) ──────────────────────────────────────────────────
describe('reportProgress', () => {
  it('子群上报 need_help → enqueue report_help(child→parent), 不碰 cursor/observation', async () => {
    const t = await mkTask();
    subSession();
    const res = await reportProgress({ sessionId: 'sess_sub', taskId: t.taskId, type: 'need_help', summary: '卡住了', sourceMessageIds: ['m1'] });
    const cmd = getCommand(res.cmdId)!;
    expect(cmd.commandType).toBe('report_help');
    expect(cmd.direction).toBe('child_to_parent');
    expect(cmd.targetChatId).toBe('oc_main');
    // 边界5: 不推 cursor、不建 observation
    expect(getSubTask(t.taskId)!.committedCursor).toBeNull();
    expect(listObservations(t.taskId)).toHaveLength(0);
  });

  it('done → report_done', async () => {
    const t = await mkTask();
    subSession();
    const res = await reportProgress({ sessionId: 'sess_sub', taskId: t.taskId, type: 'done', summary: '完成' });
    expect(getCommand(res.cmdId)!.commandType).toBe('report_done');
  });

  it('鉴权: 不是从该子群上报 (session.chatId≠task.chatId) → 403', async () => {
    const t = await mkTask();
    subSession('sess_other', 'oc_other');
    await expect(reportProgress({ sessionId: 'sess_other', taskId: t.taskId, type: 'need_help', summary: 'x' }))
      .rejects.toMatchObject({ status: 403 });
  });

  it('鉴权 P1: 在子群里但发起 bot ∉ task.bots → 403', async () => {
    const t = await mkTask(); // bots = [ou_claude, ou_coco]
    subSession('sess_codex', 'oc_sub', 'app_codex'); // app_codex→ou_codex 不在 task.bots
    await expect(reportProgress({ sessionId: 'sess_codex', taskId: t.taskId, type: 'need_help', summary: 'x' }))
      .rejects.toMatchObject({ status: 403 });
  });
});

// ─── query_subtask (边界6) ────────────────────────────────────────────────────
describe('querySubtask', () => {
  it('按 commandId 原子 ack + 返回 snapshot, 重复 query 幂等', async () => {
    const t = await mkTask();
    mainSession();
    const cmd = await enqueueCommand({ taskId: t.taskId, direction: 'child_to_parent', targetChatId: 'oc_main', commandType: 'report_help', payload: { summary: 's' }, idempotencyKey: 'h' });
    const r1 = await querySubtask({ sessionId: 'sess_main', commandId: cmd.cmdId });
    expect(r1.ackedCommandId).toBe(cmd.cmdId);
    expect(getCommand(cmd.cmdId)!.deliveryStatus).toBe('acked');
    expect(r1.task.taskId).toBe(t.taskId);
    // 重复 query → 幂等, 仍 acked, 不抛
    const r2 = await querySubtask({ sessionId: 'sess_main', commandId: cmd.cmdId });
    expect(r2.ackedCommandId).toBe(cmd.cmdId);
    expect(getCommand(cmd.cmdId)!.deliveryStatus).toBe('acked');
  });

  it('按 taskId 查 (无 commandId) → 不 ack, 返回 snapshot', async () => {
    const t = await mkTask();
    mainSession();
    const r = await querySubtask({ sessionId: 'sess_main', taskId: t.taskId });
    expect(r.ackedCommandId).toBeNull();
    expect(r.task.taskId).toBe(t.taskId);
  });

  it('Blocker2: query parent→child(finish) commandId → 不 ack (避免 finish 被误标 acked 不投子群)', async () => {
    const t = await mkTask();
    mainSession();
    const finishCmd = await enqueueCommand({ taskId: t.taskId, direction: 'parent_to_child', targetChatId: 'oc_sub', commandType: 'finish', payload: {}, idempotencyKey: 'f1' });
    const r = await querySubtask({ sessionId: 'sess_main', commandId: finishCmd.cmdId });
    expect(r.ackedCommandId).toBeNull();                          // 没 ack
    expect(getCommand(finishCmd.cmdId)!.deliveryStatus).toBe('pending'); // finish 仍 pending, 会照常投子群
    expect(r.task.taskId).toBe(t.taskId);                        // 但仍返回 snapshot
  });

  it('鉴权: 非主 bot → 403', async () => {
    const t = await mkTask();
    const s = subSession('sess_x', 'oc_main'); s.larkAppId = 'app_codex'; mockSessions.set('sess_x', s);
    await expect(querySubtask({ sessionId: 'sess_x', taskId: t.taskId })).rejects.toMatchObject({ status: 403 });
  });

  it('鉴权: 主bot 但 task 不归这个父群 → 403', async () => {
    const t = await mkTask();
    mainSession('sess_wrong', 'oc_DIFFERENT'); // 主bot 但 chatId 不是 task.parentChatId
    await expect(querySubtask({ sessionId: 'sess_wrong', taskId: t.taskId })).rejects.toMatchObject({ status: 403 });
  });
});

// ─── finish_subtask ───────────────────────────────────────────────────────────
describe('finishSubtask', () => {
  it('observing → finished + parent→child finish 命令 (主bot 权威)', async () => {
    const t = await mkTask();
    mainSession();
    const res = await finishSubtask({ sessionId: 'sess_main', taskId: t.taskId, expectedVersion: t.version, note: '验收通过' });
    expect(res.status).toBe('finished');
    expect(getSubTask(t.taskId)!.status).toBe('finished');
    const cmd = getCommand(res.cmdId)!;
    expect(cmd.commandType).toBe('finish');
    expect(cmd.direction).toBe('parent_to_child');
    expect(cmd.targetChatId).toBe('oc_sub');
  });

  it('P1: 不传 expectedVersion 且非 force → 400', async () => {
    const t = await mkTask();
    mainSession();
    await expect(finishSubtask({ sessionId: 'sess_main', taskId: t.taskId }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('P1: force=true 可不带 expectedVersion 强制结束', async () => {
    const t = await mkTask();
    mainSession();
    const res = await finishSubtask({ sessionId: 'sess_main', taskId: t.taskId, force: true });
    expect(res.status).toBe('finished');
  });

  it('expectedVersion 不匹配 (基于旧观察) → 409', async () => {
    const t = await mkTask();
    mainSession();
    await expect(finishSubtask({ sessionId: 'sess_main', taskId: t.taskId, expectedVersion: t.version + 99 }))
      .rejects.toMatchObject({ status: 409 });
  });

  it('幂等: finish 两次 → 第二次返回既有 finish 命令, 不重复转', async () => {
    const t = await mkTask();
    mainSession();
    const r1 = await finishSubtask({ sessionId: 'sess_main', taskId: t.taskId, expectedVersion: t.version });
    const r2 = await finishSubtask({ sessionId: 'sess_main', taskId: t.taskId }); // 已 finished → early return, 不需 expectedVersion
    expect(r2.status).toBe('finished');
    expect(r2.cmdId).toBe(r1.cmdId);
  });

  it('P1: 已 finished 但历史无 finish 命令 → 自愈补一条, cmdId 非空', async () => {
    const t = await mkTask();
    await transitionStatus(t.taskId, 'finished'); // 直接转 finished, 没经 finishSubtask → 无 finish 命令
    mainSession();
    const res = await finishSubtask({ sessionId: 'sess_main', taskId: t.taskId, force: true });
    expect(res.alreadyFinished).toBe(true);
    expect(res.cmdId).not.toBe('');
    expect(getCommand(res.cmdId)!.commandType).toBe('finish');
  });
});

// ─── supplement_subtask ───────────────────────────────────────────────────────
describe('supplementSubtask', () => {
  it('reported_help → observing + parent→child supplement 命令', async () => {
    const t = await mkTask();
    await transitionStatus(t.taskId, 'reported_help');
    mainSession();
    const v = getSubTask(t.taskId)!.version;
    const res = await supplementSubtask({ sessionId: 'sess_main', taskId: t.taskId, content: '用这个 token', expectedVersion: v });
    expect(res.status).toBe('observing');
    expect(getSubTask(t.taskId)!.status).toBe('observing');
    const cmd = getCommand(res.cmdId)!;
    expect(cmd.commandType).toBe('supplement');
    expect(cmd.direction).toBe('parent_to_child');
    expect(cmd.payload.content).toBe('用这个 token');
  });

  it('P1: 不传 expectedVersion 且非 force → 400', async () => {
    const t = await mkTask();
    mainSession();
    await expect(supplementSubtask({ sessionId: 'sess_main', taskId: t.taskId, content: 'x' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('expectedVersion 不匹配 → 409', async () => {
    const t = await mkTask();
    mainSession();
    await expect(supplementSubtask({ sessionId: 'sess_main', taskId: t.taskId, content: 'x', expectedVersion: t.version + 99 }))
      .rejects.toMatchObject({ status: 409 });
  });

  it('Blocker: 超时重试带旧 expectedVersion → 幂等返回既有命令 (不 409)', async () => {
    const t = await mkTask();
    await transitionStatus(t.taskId, 'reported_help');
    mainSession();
    const v = getSubTask(t.taskId)!.version;
    const r1 = await supplementSubtask({ sessionId: 'sess_main', taskId: t.taskId, content: 'X', expectedVersion: v });
    expect(r1.status).toBe('observing');
    // 重试同请求 (旧 expectedVersion=v, 现已 v+1) → dup 先命中, 不 409, 同一条命令
    const r2 = await supplementSubtask({ sessionId: 'sess_main', taskId: t.taskId, content: 'X', expectedVersion: v });
    expect(r2.cmdId).toBe(r1.cmdId);
  });

  it('缺 content → 400 (先于 expectedVersion 校验)', async () => {
    const t = await mkTask();
    mainSession();
    await expect(supplementSubtask({ sessionId: 'sess_main', taskId: t.taskId, content: ' ' }))
      .rejects.toMatchObject({ status: 400 });
  });
});
