/**
 * Unit tests for subtask-store (Phase 1 数据层, 蔻黛克斯 review 加固版)。
 * Run: pnpm vitest run test/subtask-store.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;
vi.mock('../src/config.js', () => ({ config: { get session() { return { dataDir: tempDir }; } } }));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), isDebug: () => false },
}));

import {
  createSubTask, getSubTask, getByChatId, listSubTasks, updateSubTask,
  transitionStatus, isTransitionAllowed, commitObservationTransaction,
  enqueueCommand, listCommands, listPendingCommands, ackCommand, getCommand,
  updateCommand, claimCommandForDispatch, completeDispatch, transitionAndEnqueueCommand,
  helpReportDelivery, staleHelpCommandIds,
  listObservations, pruneFinished, VersionConflictError, TaskNotFoundError, CommandRetryMismatchError, ACTIVE_STATUSES, OBSERVER_STATUSES,
  StoreCorruptError, __resetForTesting, addBotToSubTask, type SubTaskBot,
  recordWakeAck, hasWakeAck,
} from '../src/services/subtask-store.js';

const BOTS: SubTaskBot[] = [
  { openId: 'ou_claude', name: '克劳德', role: 'main' },
  { openId: 'ou_coco', name: '缇蕾', role: 'observer' },
];
function mk(key = 'k1', chat = 'oc_sub') {
  return createSubTask({
    chatId: chat, parentChatId: 'oc_parent', parentMessageId: 'om_src',
    goal: '修个 bug', acceptance: '单测过', bots: BOTS,
    requester: 'ou_jason', createdBy: 'ou_claude', idempotencyKey: key,
  });
}
/** 一路推到 observing。 */
async function mkObserving(key = 'k1', chat = 'oc_sub') {
  const t = await mk(key, chat);
  await transitionStatus(t.taskId, 'observing');
  return getSubTask(t.taskId)!;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'st-test-'));
  __resetForTesting();
});

describe('防误清库 (read corrupt hard-fail)', () => {
  it('corrupt store → 抛 StoreCorruptError, 不当空库, 备份留证, 原文件不被清空', async () => {
    await mk('k1');                                       // 先写入一条合法记录
    const fp = join(tempDir, 'subtasks.json');
    writeFileSync(fp, '{ this is broken json', 'utf-8');  // 弄坏文件
    // read() (getSubTask 触发) 必须抛 —— 绝不返回空库 (否则下次 write 覆盖 = 清库)
    expect(() => getSubTask('whatever')).toThrow(StoreCorruptError);
    // 原 corrupt 文件没被空库覆盖 (内容还在)
    expect(readFileSync(fp, 'utf-8')).toContain('broken');
    // corrupt 文件被备份成 .corrupt-<ts> 留证
    const backups = readdirSync(tempDir).filter(f => f.includes('subtasks.json.corrupt-'));
    expect(backups.length).toBeGreaterThan(0);
  });
});

describe('SubTask CRUD + 幂等', () => {
  it('create 起始 creating/v1/cursor null', async () => {
    const t = await mk();
    expect(t.status).toBe('creating');
    expect(t.version).toBe(1);
    expect(t.committedCursor).toBeNull();
  });
  it('幂等：同 key 不重复建', async () => {
    const a = await mk('same');
    const b = await mk('same', 'oc_other');
    expect(b.taskId).toBe(a.taskId);
    expect(listSubTasks()).toHaveLength(1);
  });
  it('getByChatId / listSubTasks(by status)', async () => {
    const t = await mkObserving('k', 'oc_x');
    expect(getByChatId('oc_x')?.taskId).toBe(t.taskId);
    expect(listSubTasks({ statuses: ['observing'] }).map(x => x.taskId)).toEqual([t.taskId]);
  });
});

describe('addBotToSubTask (块7 #5: late clone joins existing subtask)', () => {
  it('appends a new bot + bumps version; idempotent by larkAppId', async () => {
    const t = await mk('kadd');
    const v0 = getSubTask(t.taskId)!.version;
    const clone: SubTaskBot = { openId: 'ou_new', name: '克劳德（初号机）', role: 'collab', larkAppId: 'cli_new' };
    const after = await addBotToSubTask(t.taskId, clone);
    expect(after!.bots.map(b => b.larkAppId)).toContain('cli_new');
    expect(after!.version).toBe(v0 + 1);
    // idempotent: adding the same larkAppId again is a no-op (no dup, no version bump)
    const again = await addBotToSubTask(t.taskId, clone);
    expect(again!.bots.filter(b => b.larkAppId === 'cli_new')).toHaveLength(1);
    expect(again!.version).toBe(v0 + 1);
  });
  it('unknown taskId → null', async () => {
    expect(await addBotToSubTask('st_nope', { openId: 'o', name: 'n', role: 'collab', larkAppId: 'a' })).toBeNull();
  });
});

describe('乐观锁 version', () => {
  it('version 自增', async () => {
    const t = await mk();
    expect((await updateSubTask(t.taskId, { goal: 'x' }))?.version).toBe(2);
  });
  it('expectedVersion 不符 → VersionConflictError', async () => {
    const t = await mk();
    await expect(updateSubTask(t.taskId, { goal: 'x' }, 99)).rejects.toThrow(VersionConflictError);
  });
});

describe('状态机（含 review Blocker 2 路径）', () => {
  it('合法转移表', () => {
    expect(isTransitionAllowed('creating', 'observing')).toBe(true);
    expect(isTransitionAllowed('reported_help', 'reported_done')).toBe(true); // 子群自己解决
    expect(isTransitionAllowed('reported_done', 'reported_help')).toBe(true); // done 后冒新 blocker
    expect(isTransitionAllowed('reported_done', 'finished')).toBe(true);
    expect(isTransitionAllowed('finished', 'observing')).toBe(false);
  });
  it('非法转移 → null 不写', async () => {
    const t = await mkObserving();
    await transitionStatus(t.taskId, 'reported_done');
    await transitionStatus(t.taskId, 'finished');
    const v = getSubTask(t.taskId)!.version;
    expect(await transitionStatus(t.taskId, 'observing')).toBeNull();
    expect(getSubTask(t.taskId)!.version).toBe(v);
  });
  it('ACTIVE_STATUSES 不含终态', () => {
    expect(ACTIVE_STATUSES).toContain('reported_done');
    expect(ACTIVE_STATUSES).not.toContain('paused');
    expect(ACTIVE_STATUSES).not.toContain('finished');
    expect(OBSERVER_STATUSES).toContain('paused');
  });
});

describe('commitObservationTransaction 原子提交 + cursor 约束', () => {
  it('落 Observation + 上报命令 + cursor(=readToCursor) 一次原子', async () => {
    const t = await mkObserving();
    const v = getSubTask(t.taskId)!.version;
    const res = await commitObservationTransaction({
      taskId: t.taskId, readFromCursor: null, readToCursor: 'm2', analyzedMessageIds: ['m1', 'm2'],
      summary: '卡住了', signal: 'need_help',
      report: { commandType: 'report_help', idempotencyKey: 'rep1' }, statusTo: 'reported_help',
    });
    expect(res!.command?.commandType).toBe('report_help');
    expect(res!.command?.direction).toBe('child_to_parent');
    expect(res!.command?.targetChatId).toBe('oc_parent');
    const after = getSubTask(t.taskId)!;
    expect(after.committedCursor).toBe('m2');   // = readToCursor (结构性约束)
    expect(after.status).toBe('reported_help');
    expect(after.version).toBe(v + 1);
    expect(listObservations(t.taskId)[0].analyzedMessageIds).toEqual(['m1', 'm2']);
    expect(listObservations(t.taskId)[0].readToCursor).toBe('m2');
  });
  it('非法状态转移 → 整事务 abort 不写', async () => {
    const t = await mkObserving();
    await transitionStatus(t.taskId, 'reported_done');
    await transitionStatus(t.taskId, 'finished');
    const before = getSubTask(t.taskId)!;
    const res = await commitObservationTransaction({
      taskId: t.taskId, readFromCursor: null, readToCursor: 'mX', analyzedMessageIds: ['mX'],
      summary: 'x', signal: 'normal', statusTo: 'observing',
    });
    expect(res).toBeNull();
    expect(listObservations(t.taskId)).toHaveLength(0);
    expect(getSubTask(t.taskId)!.version).toBe(before.version);
  });
  it('review 缺口2：reported_help → reported_done 同一 commit 落 done observation + done 命令', async () => {
    const t = await mkObserving();
    await commitObservationTransaction({
      taskId: t.taskId, readFromCursor: null, readToCursor: 'm1', analyzedMessageIds: ['m1'],
      summary: '需协助', signal: 'need_help', report: { commandType: 'report_help', idempotencyKey: 'h1' }, statusTo: 'reported_help',
    });
    // 等补充期间子群自己解决 → 直接 done
    const res = await commitObservationTransaction({
      taskId: t.taskId, readFromCursor: 'm1', readToCursor: 'm3', analyzedMessageIds: ['m2', 'm3'],
      summary: '自己搞定了', signal: 'done', report: { commandType: 'report_done', idempotencyKey: 'd1' }, statusTo: 'reported_done',
    });
    expect(res!.command?.commandType).toBe('report_done');
    expect(getSubTask(t.taskId)!.status).toBe('reported_done');
    expect(listCommands(t.taskId).map(c => c.commandType).sort()).toEqual(['report_done', 'report_help']);
  });
  it('review 缺口3：reported_done → reported_help 并 supersede 旧 done 命令', async () => {
    const t = await mkObserving();
    const done = await commitObservationTransaction({
      taskId: t.taskId, readFromCursor: null, readToCursor: 'm1', analyzedMessageIds: ['m1'],
      summary: '完成', signal: 'done', report: { commandType: 'report_done', idempotencyKey: 'd1' }, statusTo: 'reported_done',
    });
    const doneCmd = done!.command!.cmdId;
    // recheck 发现新 blocker → 回 help，supersede 旧 done
    await commitObservationTransaction({
      taskId: t.taskId, readFromCursor: 'm1', readToCursor: 'm2', analyzedMessageIds: ['m2'],
      summary: '又出问题', signal: 'need_help', report: { commandType: 'report_help', idempotencyKey: 'h2' },
      statusTo: 'reported_help', supersedeCommandIds: [doneCmd],
    });
    expect(getSubTask(t.taskId)!.status).toBe('reported_help');
    expect(getCommand(doneCmd)!.supersededBy).not.toBeNull();
  });
});

describe('Outbox 命令', () => {
  it('enqueueCommand parent→child + listPendingCommands', async () => {
    const t = await mkObserving();
    const c = await enqueueCommand({
      taskId: t.taskId, direction: 'parent_to_child', targetChatId: 'oc_sub',
      commandType: 'finish', payload: { content: '结束' }, idempotencyKey: 'fin1',
    });
    expect(c.direction).toBe('parent_to_child');
    expect(listPendingCommands().map(x => x.cmdId)).toContain(c.cmdId);
  });
  it('review 缺口4：enqueueCommand 对不存在 taskId → TaskNotFoundError', async () => {
    await expect(enqueueCommand({
      taskId: 'st_nope', direction: 'parent_to_child', targetChatId: 'oc_x',
      commandType: 'finish', payload: {}, idempotencyKey: 'k',
    })).rejects.toThrow(TaskNotFoundError);
  });
  it('ackCommand → acked 移出 pending', async () => {
    const t = await mkObserving();
    const c = await enqueueCommand({ taskId: t.taskId, direction: 'parent_to_child', targetChatId: 'oc_sub', commandType: 'supplement', payload: { content: 'x' }, idempotencyKey: 'sup1' });
    await ackCommand(c.cmdId);
    expect(getCommand(c.cmdId)!.deliveryStatus).toBe('acked');
    expect(listPendingCommands()).toHaveLength(0);
  });
  it('superseded 命令不在 pending', async () => {
    const t = await mkObserving();
    const c = await enqueueCommand({ taskId: t.taskId, direction: 'child_to_parent', targetChatId: 'oc_parent', commandType: 'report_done', payload: {}, idempotencyKey: 'rd1' });
    await commitObservationTransaction({
      taskId: t.taskId, readFromCursor: null, readToCursor: 'm9', analyzedMessageIds: ['m9'],
      summary: 'x', signal: 'normal', supersedeCommandIds: [c.cmdId],
    });
    expect(listPendingCommands().map(x => x.cmdId)).not.toContain(c.cmdId);
  });
});

describe('review 缺口1：并发 writer 不丢更新（withFileLock）', () => {
  it('两路并发 enqueue 不同命令 → 都落地（锁串行化，不 last-writer-wins）', async () => {
    const t = await mkObserving();
    await Promise.all([
      enqueueCommand({ taskId: t.taskId, direction: 'child_to_parent', targetChatId: 'oc_parent', commandType: 'report_help', payload: {}, idempotencyKey: 'a' }),
      enqueueCommand({ taskId: t.taskId, direction: 'child_to_parent', targetChatId: 'oc_parent', commandType: 'report_done', payload: {}, idempotencyKey: 'b' }),
      enqueueCommand({ taskId: t.taskId, direction: 'parent_to_child', targetChatId: 'oc_sub', commandType: 'finish', payload: {}, idempotencyKey: 'c' }),
    ]);
    expect(listCommands(t.taskId)).toHaveLength(3); // 一条都没被覆盖丢
  });
  it('并发 update 同一任务 → version 单调递增不丢（锁内 RMW）', async () => {
    const t = await mk();
    await Promise.all([
      updateSubTask(t.taskId, { goal: 'g1' }),
      updateSubTask(t.taskId, { compactSummary: 's1' }),
      updateSubTask(t.taskId, { lastError: 'e1' }),
    ]);
    // 3 次写都进了 → version 1+3=4，且三个字段都在（没互相覆盖丢）
    const after = getSubTask(t.taskId)!;
    expect(after.version).toBe(4);
    expect(after.goal).toBe('g1');
    expect(after.compactSummary).toBe('s1');
    expect(after.lastError).toBe('e1');
  });
});

describe('cursor 硬校验（review 第二轮 blocker）', () => {
  it('readFromCursor 跟当前 committedCursor 对不上 → CursorConflictError', async () => {
    const t = await mkObserving();
    await commitObservationTransaction({
      taskId: t.taskId, readFromCursor: null, readToCursor: 'm2', analyzedMessageIds: ['m1', 'm2'],
      summary: 'x', signal: 'normal',
    }); // committed→m2
    // 再用陈旧 readFrom（null/m1）提交 → 拒（防两 observer 抢 / 倒退）
    await expect(commitObservationTransaction({
      taskId: t.taskId, readFromCursor: null, readToCursor: 'm3', analyzedMessageIds: ['m3'],
      summary: 'y', signal: 'normal',
    })).rejects.toThrow(/CursorConflict|cursor conflict/i);
  });
  it('readToCursor 不在 analyzedMessageIds → InvalidCursorCommitError', async () => {
    const t = await mkObserving();
    await expect(commitObservationTransaction({
      taskId: t.taskId, readFromCursor: null, readToCursor: 'm100', analyzedMessageIds: ['m2'],
      summary: 'x', signal: 'normal',
    })).rejects.toThrow(/InvalidCursorCommit|invalid cursor/i);
  });
  it('analyzed 空却推进 cursor → InvalidCursorCommitError', async () => {
    const t = await mkObserving();
    await expect(commitObservationTransaction({
      taskId: t.taskId, readFromCursor: null, readToCursor: 'm5', analyzedMessageIds: [],
      summary: 'x', signal: 'normal',
    })).rejects.toThrow(/invalid cursor/i);
  });
  it('不推进（readTo===readFrom）时 analyzed 可空，不报错', async () => {
    const t = await mkObserving();
    const res = await commitObservationTransaction({
      taskId: t.taskId, readFromCursor: null, readToCursor: null, analyzedMessageIds: [],
      summary: '没新消息但记一笔', signal: 'normal',
    });
    expect(res).not.toBeNull();
    expect(getSubTask(t.taskId)!.committedCursor).toBeNull();
  });
});

describe('updateSubTask 不能改 status（review P1）', () => {
  it('patch 里塞 status 被剥掉，status 不变', async () => {
    const t = await mkObserving();
    // @ts-expect-error 故意用 any 绕类型测运行期防御
    await updateSubTask(t.taskId, { status: 'finished', compactSummary: 's' } as any);
    expect(getSubTask(t.taskId)!.status).toBe('observing'); // 没被改成 finished
    expect(getSubTask(t.taskId)!.compactSummary).toBe('s'); // 其它字段照常改
  });
});

describe('enqueueCommand idempotency task-scoped（review P2）', () => {
  it('同 key 不同 task → 两条都落（不跨任务误 dedup）', async () => {
    const a = await mkObserving('ka', 'oc_a');
    const b = await mkObserving('kb', 'oc_b');
    const c1 = await enqueueCommand({ taskId: a.taskId, direction: 'parent_to_child', targetChatId: 'oc_a', commandType: 'finish', payload: {}, idempotencyKey: 'samekey' });
    const c2 = await enqueueCommand({ taskId: b.taskId, direction: 'parent_to_child', targetChatId: 'oc_b', commandType: 'finish', payload: {}, idempotencyKey: 'samekey' });
    expect(c1.cmdId).not.toBe(c2.cmdId);
    expect(listCommands(a.taskId)).toHaveLength(1);
    expect(listCommands(b.taskId)).toHaveLength(1);
  });
  it('同 key 同 task → dedup 返既有', async () => {
    const a = await mkObserving();
    const c1 = await enqueueCommand({ taskId: a.taskId, direction: 'parent_to_child', targetChatId: 'oc_sub', commandType: 'finish', payload: {}, idempotencyKey: 'k' });
    const c2 = await enqueueCommand({ taskId: a.taskId, direction: 'parent_to_child', targetChatId: 'oc_sub', commandType: 'finish', payload: {}, idempotencyKey: 'k' });
    expect(c2.cmdId).toBe(c1.cmdId);
  });
});

describe('dataDir 不存在时自动建（review P1）', () => {
  it('不调 __resetForTesting、dataDir 不存在 → createSubTask 成功', async () => {
    tempDir = join(mkdtempSync(join(tmpdir(), 'st-nd-')), 'deep', 'not', 'exist'); // 此刻不存在
    const t = await createSubTask({
      chatId: 'oc_sub', parentChatId: 'oc_parent', parentMessageId: 'om_src',
      goal: 'g', bots: BOTS, requester: 'ou_jason', createdBy: 'ou_claude', idempotencyKey: 'k1',
    });
    expect(t.taskId).toBeTruthy();
    expect(getSubTask(t.taskId)?.taskId).toBe(t.taskId);
  });
});

describe('pruneFinished', () => {
  it('finished 超 TTL 连带清', async () => {
    const t = await mkObserving();
    await enqueueCommand({ taskId: t.taskId, direction: 'parent_to_child', targetChatId: 'oc_sub', commandType: 'finish', payload: {}, idempotencyKey: 'f' });
    await transitionStatus(t.taskId, 'reported_done');
    await transitionStatus(t.taskId, 'finished');
    expect(await pruneFinished(new Date(Date.now() + 60000))).toBe(0);
    expect(await pruneFinished(new Date(Date.now() + 8 * 24 * 3600_000))).toBe(1);
    expect(listCommands(t.taskId)).toHaveLength(0);
  });
});

// ─── helpReportDelivery 6 态 direct regression (review P1-1) ──────────────────
describe('helpReportDelivery 真映射 (store helper)', () => {
  const TIMEOUT = 10 * 60_000;
  async function mkHelp(): Promise<{ taskId: string; cmdId: string }> {
    const t = await mkObserving();
    const r = await commitObservationTransaction({
      taskId: t.taskId, readFromCursor: null, readToCursor: 'm1', analyzedMessageIds: ['m1'],
      summary: '需协助', signal: 'need_help',
      report: { commandType: 'report_help', idempotencyKey: 'h1' }, statusTo: 'reported_help',
    });
    return { taskId: t.taskId, cmdId: r!.command!.cmdId };
  }
  const now = new Date('2026-05-30T12:00:00Z');

  it('无 help 命令 → none', async () => {
    const t = await mkObserving();
    expect(helpReportDelivery(t.taskId, now, TIMEOUT)).toBe('none');
  });
  it('刚入队 (pending) → pending', async () => {
    const { taskId } = await mkHelp();
    expect(helpReportDelivery(taskId, now, TIMEOUT)).toBe('pending');
  });
  it('sent + sentAt 近 → sent_unacked_fresh', async () => {
    const { taskId, cmdId } = await mkHelp();
    await updateCommand(cmdId, { deliveryStatus: 'sent', sentAt: new Date(now.getTime() - 60_000).toISOString() });
    expect(helpReportDelivery(taskId, now, TIMEOUT)).toBe('sent_unacked_fresh');
  });
  it('sent + sentAt 超时 → sent_unacked_expired', async () => {
    const { taskId, cmdId } = await mkHelp();
    await updateCommand(cmdId, { deliveryStatus: 'sent', sentAt: new Date(now.getTime() - TIMEOUT - 1).toISOString() });
    expect(helpReportDelivery(taskId, now, TIMEOUT)).toBe('sent_unacked_expired');
  });
  it('v2 P2: sent_unconfirmed 即便超 ackTimeout 也归 sent_unacked_fresh (不换 cmdId 补发, Phase B 负责确认前恢复)', async () => {
    const { taskId, cmdId } = await mkHelp();
    await updateCommand(cmdId, { deliveryStatus: 'sent_unconfirmed', sentAt: new Date(now.getTime() - TIMEOUT - 1).toISOString() });
    expect(helpReportDelivery(taskId, now, TIMEOUT)).toBe('sent_unacked_fresh');
  });
  it('脏数据: sent 但 sentAt=null → 保守当 expired (允许补发, 不静默吞)', async () => {
    const { taskId, cmdId } = await mkHelp();
    await updateCommand(cmdId, { deliveryStatus: 'sent', sentAt: null });
    expect(helpReportDelivery(taskId, now, TIMEOUT)).toBe('sent_unacked_expired');
  });
  it('failed → failed', async () => {
    const { taskId, cmdId } = await mkHelp();
    await updateCommand(cmdId, { deliveryStatus: 'failed' });
    expect(helpReportDelivery(taskId, now, TIMEOUT)).toBe('failed');
  });
  it('acked → acked', async () => {
    const { taskId, cmdId } = await mkHelp();
    await ackCommand(cmdId);
    expect(helpReportDelivery(taskId, now, TIMEOUT)).toBe('acked');
  });
  it('superseded 的旧 help 不算, 取最近生效那条', async () => {
    const { taskId, cmdId } = await mkHelp();
    await updateCommand(cmdId, { supersededBy: 'x' });            // 旧的作废
    expect(helpReportDelivery(taskId, now, TIMEOUT)).toBe('none'); // 没有生效的 help 了
    expect(staleHelpCommandIds(taskId)).toEqual([]);              // superseded 不在 stale 列表
  });
});

// ─── transitionAndEnqueueCommand 原子事务 (review Phase4 Blocker1) ────────────
describe('transitionAndEnqueueCommand', () => {
  const cmd = (over?: any) => ({ direction: 'parent_to_child' as const, targetChatId: 'oc_sub', commandType: 'finish' as const, payload: {}, idempotencyKey: 'k', ...over });

  it('状态转移 + 命令入队一把: observing → finished + finish 命令 + version++', async () => {
    const t = await mkObserving();
    const v0 = getSubTask(t.taskId)!.version;
    const res = await transitionAndEnqueueCommand({ taskId: t.taskId, resolveTo: () => 'finished', command: cmd() });
    expect(res!.task.status).toBe('finished');
    expect(res!.task.version).toBe(v0 + 1);
    expect(res!.command.commandType).toBe('finish');
    expect(listCommands(t.taskId)).toHaveLength(1);
  });

  it('条件不转 (resolveTo 返回 null) → 状态不变但命令入队', async () => {
    const t = await mkObserving();
    const res = await transitionAndEnqueueCommand({ taskId: t.taskId, resolveTo: c => (c === 'reported_help' ? 'observing' : null), command: cmd({ commandType: 'supplement', idempotencyKey: 's' }) });
    expect(res!.task.status).toBe('observing'); // 没转
    expect(listCommands(t.taskId)[0].commandType).toBe('supplement');
  });

  it('version 不匹配 → VersionConflictError, 不写', async () => {
    const t = await mkObserving();
    await expect(transitionAndEnqueueCommand({ taskId: t.taskId, expectedVersion: t.version + 9, resolveTo: () => 'finished', command: cmd() }))
      .rejects.toBeInstanceOf(VersionConflictError);
    expect(listCommands(t.taskId)).toHaveLength(0); // 没入队
  });

  it('同 idempotencyKey 重试 → 整体幂等 (不重复转/不 bump/不重复入队)', async () => {
    const t = await mkObserving();
    const r1 = await transitionAndEnqueueCommand({ taskId: t.taskId, resolveTo: () => 'finished', command: cmd() });
    const v1 = getSubTask(t.taskId)!.version;
    const r2 = await transitionAndEnqueueCommand({ taskId: t.taskId, resolveTo: () => 'finished', command: cmd() });
    expect(r2!.command.cmdId).toBe(r1!.command.cmdId);  // 同一条
    expect(getSubTask(t.taskId)!.version).toBe(v1);     // 没再 bump
    expect(listCommands(t.taskId)).toHaveLength(1);     // 没重复入队
  });

  it('非法转移 → 返回 null, 不写', async () => {
    const t = await mkObserving();
    await transitionStatus(t.taskId, 'reported_done');
    await transitionStatus(t.taskId, 'finished'); // 终态
    const res = await transitionAndEnqueueCommand({ taskId: t.taskId, resolveTo: () => 'observing', command: cmd({ idempotencyKey: 'x' }) });
    expect(res).toBeNull();                       // finished→observing 非法
    expect(listCommands(t.taskId)).toHaveLength(0);
  });

  it('P1 自愈: dup 命令已存在但状态没转 → 补状态转移 (不重复入队)', async () => {
    const t = await mkObserving();
    // 模拟历史异常: finish 命令已入队，但 task 还停在 observing (没转 finished)
    await enqueueCommand({ taskId: t.taskId, direction: 'parent_to_child', targetChatId: 'oc_sub', commandType: 'finish', payload: {}, idempotencyKey: 'k' });
    expect(getSubTask(t.taskId)!.status).toBe('observing');
    // 重试同 key → 不重复入队，但补上 observing→finished
    const res = await transitionAndEnqueueCommand({ taskId: t.taskId, resolveTo: () => 'finished', command: cmd() });
    expect(res!.task.status).toBe('finished');     // 状态被补上
    expect(listCommands(t.taskId)).toHaveLength(1); // 命令没重复
  });

  it('Blocker: dup 先于 expectedVersion 查 → supplement 超时重试带旧 version 仍幂等, 不抛 VersionConflict', async () => {
    const t = await mkObserving();
    await transitionStatus(t.taskId, 'reported_help');
    const v = getSubTask(t.taskId)!.version;
    const supp = { direction: 'parent_to_child' as const, targetChatId: 'oc_sub', commandType: 'supplement' as const, payload: { content: 'X' }, idempotencyKey: 'supp-X' };
    const r1 = await transitionAndEnqueueCommand({ taskId: t.taskId, expectedVersion: v, resolveTo: c => (c === 'reported_help' ? 'observing' : null), command: supp });
    expect(r1!.task.status).toBe('observing');
    const v2 = getSubTask(t.taskId)!.version; // v+1
    // 重试: 同 key + 旧 expectedVersion=v (现已 v2) → dup 先命中, 不抛, 幂等返回既有
    const r2 = await transitionAndEnqueueCommand({ taskId: t.taskId, expectedVersion: v, resolveTo: c => (c === 'reported_help' ? 'observing' : null), command: supp });
    expect(r2!.command.cmdId).toBe(r1!.command.cmdId);
    expect(getSubTask(t.taskId)!.version).toBe(v2); // 没再 bump
  });

  it('同 idempotencyKey 但命令语义不同 → CommandRetryMismatchError', async () => {
    const t = await mkObserving();
    await transitionAndEnqueueCommand({ taskId: t.taskId, resolveTo: () => 'finished', command: { direction: 'parent_to_child', targetChatId: 'oc_sub', commandType: 'finish', payload: {}, idempotencyKey: 'dup-key' } });
    await expect(transitionAndEnqueueCommand({ taskId: t.taskId, command: { direction: 'parent_to_child', targetChatId: 'oc_sub', commandType: 'supplement', payload: {}, idempotencyKey: 'dup-key' } }))
      .rejects.toBeInstanceOf(CommandRetryMismatchError);
  });
});

// ─── completeDispatch 单调终态守卫 (review Phase4 P1) ─────────────────────────
describe('completeDispatch acked 单调性', () => {
  it('主bot 抢先 ack 后 dispatcher 慢一步 complete → 不把 acked 降回 sent, 但补元数据', async () => {
    const t = await mkObserving();
    const cmd = await enqueueCommand({ taskId: t.taskId, direction: 'child_to_parent', targetChatId: 'oc_parent', commandType: 'report_help', payload: { summary: 's' }, idempotencyKey: 'h' });
    const claimed = await claimCommandForDispatch(cmd.cmdId, 'A', 60_000, new Date());
    expect(claimed).not.toBeNull();
    // 主 bot 从消息体 commandId 抢先 ack (ackCommand 不动 lease/attemptId)
    await ackCommand(cmd.cmdId);
    expect(getCommand(cmd.cmdId)!.deliveryStatus).toBe('acked');
    // dispatcher 慢一步 complete sent → CAS 通过 (attemptId 仍 A)，但不得降级
    const after = await completeDispatch(cmd.cmdId, 'A', { deliveryStatus: 'sent', deliveredMessageId: 'om_x', sentAt: '2026-05-30T12:00:00Z' });
    expect(after!.deliveryStatus).toBe('acked');        // 没被降回 sent
    expect(after!.deliveredMessageId).toBe('om_x');     // 元数据补上
    expect(after!.sentAt).toBe('2026-05-30T12:00:00Z');
    expect(after!.dispatchAttemptId).toBeNull();        // lease 清
  });

  it('未 acked 的命令 complete sent → 正常写 sent', async () => {
    const t = await mkObserving();
    const cmd = await enqueueCommand({ taskId: t.taskId, direction: 'child_to_parent', targetChatId: 'oc_parent', commandType: 'report_help', payload: {}, idempotencyKey: 'h2' });
    await claimCommandForDispatch(cmd.cmdId, 'A', 60_000, new Date());
    const after = await completeDispatch(cmd.cmdId, 'A', { deliveryStatus: 'sent', deliveredMessageId: 'om_y' });
    expect(after!.deliveryStatus).toBe('sent');
  });
});

describe('wakeAck (round-5 冷启动唤醒回执)', () => {
  it('record → has，按 (taskId, appId, wakeId) 三元组精确匹配', async () => {
    await recordWakeAck('st_1', 'cli_a', 'w1');
    expect(hasWakeAck('st_1', 'cli_a', 'w1')).toBe(true);
    // 任一维度不同都不命中（防串轮/串分身/上一轮迟到回执误放行）
    expect(hasWakeAck('st_1', 'cli_a', 'w2')).toBe(false);
    expect(hasWakeAck('st_1', 'cli_b', 'w1')).toBe(false);
    expect(hasWakeAck('st_2', 'cli_a', 'w1')).toBe(false);
  });

  it('幂等：同三元组重复 record 不产生重复条目', async () => {
    await recordWakeAck('st_1', 'cli_a', 'w1');
    await recordWakeAck('st_1', 'cli_a', 'w1');
    expect(hasWakeAck('st_1', 'cli_a', 'w1')).toBe(true);
  });

  it('未 record → has 为 false', () => {
    expect(hasWakeAck('st_none', 'cli_x', 'wz')).toBe(false);
  });
});
