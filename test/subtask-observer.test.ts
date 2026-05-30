/**
 * Unit tests for subtask-observer (Phase 2 观测脚本)。
 * Run: pnpm vitest run test/subtask-observer.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;
vi.mock('../src/config.js', () => ({ config: { get session() { return { dataDir: tempDir }; } } }));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), isDebug: () => false },
}));

import {
  createSubTask, transitionStatus, getSubTask, listCommands, listObservations,
  commitObservationTransaction, getCommand, updateCommand, __resetForTesting,
  type SubTaskBot, type HelpDelivery,
} from '../src/services/subtask-store.js';
import {
  runObserverTick, planCommit, MIN_OBSERVE_INTERVAL_MS,
  type ObserverExecutors, type JudgeResult,
} from '../src/services/subtask-observer.js';

const BOTS: SubTaskBot[] = [{ openId: 'ou_claude', name: '克劳德', role: 'main' }];

async function mkObserving(chat = 'oc_sub', key = 'k1') {
  const t = await createSubTask({
    chatId: chat, parentChatId: 'oc_parent', parentMessageId: 'om_src',
    goal: '修 bug', acceptance: null, bots: BOTS, requester: 'ou_jason', createdBy: 'ou_claude', idempotencyKey: key,
  });
  await transitionStatus(t.taskId, 'observing');
  return getSubTask(t.taskId)!;
}

/** mock executors：fetchSince 返 {messages(老→新连续), complete}，judge 返固定 signal。 */
function mkExec(over: {
  messages?: Array<{ id: string; rendered: string }>;
  complete?: boolean;
  judged?: JudgeResult | null;
}): ObserverExecutors & { fetchSince: ReturnType<typeof vi.fn>; judge: ReturnType<typeof vi.fn> } {
  return {
    fetchSince: vi.fn(async () => ({
      messages: over.messages ?? [{ id: 'm1', rendered: '新1' }, { id: 'm2', rendered: '新2' }],
      complete: over.complete ?? true,
    })),
    judge: vi.fn(async () => ('judged' in over ? over.judged : ({ signal: 'normal', summary: '推进中' } as JudgeResult))),
  } as any;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'sto-test-'));
  __resetForTesting();
});

// ─── planCommit 纯决策 ──────────────────────────────────────────────────────
describe('planCommit', () => {
  const noDone = () => [];
  it('observing + need_help → 报 help + reported_help', () => {
    const p = planCommit('observing', 'need_help', 'm2', noDone);
    expect(p.report?.commandType).toBe('report_help');
    expect(p.statusTo).toBe('reported_help');
  });
  it('observing + done → 报 done + reported_done', () => {
    expect(planCommit('observing', 'done', 'm2', noDone).statusTo).toBe('reported_done');
  });
  it('observing + normal → 不报不转', () => {
    expect(planCommit('observing', 'normal', 'm2', noDone)).toEqual({});
  });
  it('reported_help + done → 报 done + reported_done', () => {
    expect(planCommit('reported_help', 'done', 'm2', noDone).statusTo).toBe('reported_done');
  });
  it('reported_help + need_help (默认/acked) → 不重复刷 help', () => {
    expect(planCommit('reported_help', 'need_help', 'm2', noDone)).toEqual({});
  });

  // ── P1: reported_help+need_help 是否补发，绑 help 命令投递生命周期 (6 态) ──
  const help = (hd: HelpDelivery, stale: string[] = []) =>
    planCommit('reported_help', 'need_help', 'm2', noDone, () => hd, () => stale);
  it('reported_help+need_help · acked → 静默 (主bot在处理)', () => {
    expect(help('acked')).toEqual({});
  });
  it('reported_help+need_help · pending → 不补发 (求助还没投出, 在路上)', () => {
    expect(help('pending')).toEqual({});
  });
  it('reported_help+need_help · sent_unacked_fresh → 不补发 (等回应, 别 respam)', () => {
    expect(help('sent_unacked_fresh')).toEqual({});
  });
  it('reported_help+need_help · sent_unacked_expired → 补发 + supersede 旧 help', () => {
    const p = help('sent_unacked_expired', ['cmd_old_help']);
    expect(p.report?.commandType).toBe('report_help');
    expect(p.statusTo).toBeUndefined();        // 仍 reported_help, 不转状态
    expect(p.supersedeCommandIds).toEqual(['cmd_old_help']);
  });
  it('reported_help+need_help · failed → 补发 + supersede 旧 help', () => {
    const p = help('failed', ['cmd_old_help']);
    expect(p.report?.commandType).toBe('report_help');
    expect(p.supersedeCommandIds).toEqual(['cmd_old_help']);
  });
  it('reported_help+need_help · none (状态命令不一致) → 兜底补发', () => {
    const p = help('none');
    expect(p.report?.commandType).toBe('report_help');
    expect(p.supersedeCommandIds).toBeUndefined(); // 无旧 help 可 supersede
  });
  it('reported_done + 仍 done → 不动', () => {
    expect(planCommit('reported_done', 'done', 'm3', () => ['cmd_old'])).toEqual({});
  });
  it('reported_done + need_help → 回 reported_help + supersede 旧 done', () => {
    const p = planCommit('reported_done', 'need_help', 'm3', () => ['cmd_old']);
    expect(p.statusTo).toBe('reported_help');
    expect(p.report?.commandType).toBe('report_help');
    expect(p.supersedeCommandIds).toEqual(['cmd_old']);
  });
  it('reported_done + normal → 回 observing + supersede 旧 done', () => {
    const p = planCommit('reported_done', 'normal', 'm3', () => ['cmd_old']);
    expect(p.statusTo).toBe('observing');
    expect(p.supersedeCommandIds).toEqual(['cmd_old']);
  });
});

// ─── runObserverTick 集成 ───────────────────────────────────────────────────
describe('runObserverTick', () => {
  it('observing + need_help → reported_help + help 命令 + cursor 推进', async () => {
    const t = await mkObserving();
    const exec = mkExec({ judged: { signal: 'need_help', summary: '卡住了' } });
    const stats = await runObserverTick(new Date(), exec);
    expect(stats.committed).toBe(1);
    const after = getSubTask(t.taskId)!;
    expect(after.status).toBe('reported_help');
    expect(after.committedCursor).toBe('m2'); // = readToCursor (newest)
    const cmds = listCommands(t.taskId);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].commandType).toBe('report_help');
    expect(cmds[0].direction).toBe('child_to_parent');
    expect(listObservations(t.taskId)).toHaveLength(1);
  });

  it('observing + normal → 留 observing, 记观测, 推 cursor, 不发命令', async () => {
    const t = await mkObserving();
    await runObserverTick(new Date(), mkExec({ judged: { signal: 'normal', summary: 'ok' } }));
    expect(getSubTask(t.taskId)!.status).toBe('observing');
    expect(getSubTask(t.taskId)!.committedCursor).toBe('m2');
    expect(listCommands(t.taskId)).toHaveLength(0);
  });

  it('没新消息 → skip, 不跑 judge', async () => {
    const t = await mkObserving();
    const exec = mkExec({ messages: [] });
    await runObserverTick(new Date(), exec);
    expect(exec.judge).not.toHaveBeenCalled();
    expect(getSubTask(t.taskId)!.committedCursor).toBeNull();
  });

  it('节流：距上次观测不够久 → skip', async () => {
    const t = await mkObserving();
    // 先记一笔观测 (设 lastObs.at = now)
    await commitObservationTransaction({ taskId: t.taskId, readFromCursor: null, readToCursor: 'm0', analyzedMessageIds: ['m0'], summary: 'x', signal: 'normal' });
    const exec = mkExec({ judged: { signal: 'need_help', summary: 'y' } });
    await runObserverTick(new Date(Date.now() + MIN_OBSERVE_INTERVAL_MS - 1000), exec); // 还没到间隔
    expect(exec.fetchSince).not.toHaveBeenCalled();
    expect(getSubTask(t.taskId)!.status).toBe('observing');
  });

  it('reported_help + need_help → 不重复发 help 命令', async () => {
    const t = await mkObserving();
    // 先进 reported_help
    await commitObservationTransaction({ taskId: t.taskId, readFromCursor: null, readToCursor: 'm1', analyzedMessageIds: ['m1'], summary: '需协助', signal: 'need_help', report: { commandType: 'report_help', idempotencyKey: 'h1' }, statusTo: 'reported_help' });
    expect(listCommands(t.taskId)).toHaveLength(1);
    // 下轮还是 need_help → 不再发命令 (用 later now 跳过节流)
    const exec = mkExec({ messages: [{ id: 'm3', rendered: '还卡着' }], judged: { signal: 'need_help', summary: '还卡着' } });
    await runObserverTick(new Date(Date.now() + 2 * MIN_OBSERVE_INTERVAL_MS), exec);
    expect(getSubTask(t.taskId)!.status).toBe('reported_help');
    expect(listCommands(t.taskId)).toHaveLength(1); // 没多发
    expect(getSubTask(t.taskId)!.committedCursor).toBe('m3'); // cursor 仍推进
  });

  it('P1：reported_help 旧 help 命令 failed + 再 need_help → 补发新 help + supersede 旧 (不静默吞)', async () => {
    const t = await mkObserving();
    // 进 reported_help，产生一条 report_help 命令
    const r = await commitObservationTransaction({ taskId: t.taskId, readFromCursor: null, readToCursor: 'm1', analyzedMessageIds: ['m1'], summary: '需协助', signal: 'need_help', report: { commandType: 'report_help', idempotencyKey: 'h1' }, statusTo: 'reported_help' });
    const oldHelp = r!.command!.cmdId;
    // 模拟该求助投递彻底失败 (dispatcher 标 failed)
    await updateCommand(oldHelp, { deliveryStatus: 'failed' });
    // 下轮仍 need_help → 应补发新 help (failed 不能静默)，并 supersede 旧的
    const exec = mkExec({ messages: [{ id: 'm3', rendered: '还卡着' }], judged: { signal: 'need_help', summary: '还卡着' } });
    await runObserverTick(new Date(Date.now() + 2 * MIN_OBSERVE_INTERVAL_MS), exec);
    expect(getSubTask(t.taskId)!.status).toBe('reported_help');
    const helps = listCommands(t.taskId).filter(c => c.commandType === 'report_help');
    expect(helps).toHaveLength(2);                          // 补发了一条新的
    expect(getCommand(oldHelp)!.supersededBy).not.toBeNull(); // 旧的被 supersede
    const fresh = helps.find(c => c.cmdId !== oldHelp)!;
    expect(fresh.supersededBy).toBeNull();                  // 新的生效
  });

  it('reported_done recheck：有新活动且 need_help → 回 reported_help + supersede 旧 done', async () => {
    const t = await mkObserving();
    const done = await commitObservationTransaction({ taskId: t.taskId, readFromCursor: null, readToCursor: 'm1', analyzedMessageIds: ['m1'], summary: '完成', signal: 'done', report: { commandType: 'report_done', idempotencyKey: 'd1' }, statusTo: 'reported_done' });
    const doneCmd = done!.command!.cmdId;
    const exec = mkExec({ messages: [{ id: 'm2', rendered: '又出问题' }], judged: { signal: 'need_help', summary: '又出问题' } });
    await runObserverTick(new Date(Date.now() + 2 * MIN_OBSERVE_INTERVAL_MS), exec);
    expect(getSubTask(t.taskId)!.status).toBe('reported_help');
    expect(getCommand(doneCmd)!.supersededBy).not.toBeNull(); // 旧 done 被 supersede
  });

  it('conflict（judge 期间 cursor/版本被推进）→ skip 不抛', async () => {
    const t = await mkObserving();
    const exec: ObserverExecutors = {
      fetchSince: vi.fn(async () => ({ messages: [{ id: 'm2', rendered: 'x' }], complete: true })),
      judge: vi.fn(async () => {
        // 模拟并发：另一路把 cursor/版本推进
        await commitObservationTransaction({ taskId: t.taskId, readFromCursor: null, readToCursor: 'm9', analyzedMessageIds: ['m9'], summary: 'race', signal: 'normal' });
        return { signal: 'need_help', summary: 'y' };
      }),
    };
    const stats = await runObserverTick(new Date(), exec);
    expect(stats.errors).toBe(0); // conflict 被 catch → skip，不抛
    expect(getSubTask(t.taskId)!.committedCursor).toBe('m9'); // 并发那次的
    expect(getSubTask(t.taskId)!.status).toBe('observing'); // 本 tick 的 need_help 没硬写进去
  });

  // ── review 第三轮 3 个 blocker 的 regression ──
  it('Blocker1：100 条新消息 limit 40，cursor 只推到本批末尾，不跳过未读的', async () => {
    const t = await mkObserving();
    // fetchSince 只返前 40 条(老→新连续), complete=false (还有 60 条积压)
    const first40 = Array.from({ length: 40 }, (_, i) => ({ id: `m${i + 1}`, rendered: `c${i + 1}` }));
    const exec = mkExec({ messages: first40, complete: false, judged: { signal: 'normal', summary: 'ok' } });
    await runObserverTick(new Date(), exec);
    // cursor 推到第 40 条 (本批末尾)，绝不是"最新的 m100"
    expect(getSubTask(t.taskId)!.committedCursor).toBe('m40');
    expect(listObservations(t.taskId)[0].analyzedMessageIds).toHaveLength(40);
  });

  it('Blocker2：judge 期间主 bot finish → 本 tick VersionConflict → skip，不给 finished 追加', async () => {
    const t = await mkObserving();
    const exec: ObserverExecutors = {
      fetchSince: vi.fn(async () => ({ messages: [{ id: 'm2', rendered: 'x' }], complete: true })),
      judge: vi.fn(async () => {
        // judge 期间主 bot 把任务 finish（状态/版本变，cursor 没动）
        await transitionStatus(t.taskId, 'reported_done');
        await transitionStatus(t.taskId, 'finished');
        return { signal: 'normal', summary: 'ok' }; // 旧计划 plan={}（observing+normal）
      }),
    };
    const stats = await runObserverTick(new Date(), exec);
    expect(stats.errors).toBe(0);
    expect(getSubTask(t.taskId)!.status).toBe('finished');
    expect(listObservations(t.taskId)).toHaveLength(0); // 没给 finished task 追加 observation
    expect(getSubTask(t.taskId)!.committedCursor).toBeNull(); // cursor 没被推进
  });

  it('Blocker3：judge 返 null（LLM/parse 失败）→ skip，cursor 不推进，下轮重读', async () => {
    const t = await mkObserving();
    const exec = mkExec({ judged: null });
    await runObserverTick(new Date(), exec);
    expect(getSubTask(t.taskId)!.committedCursor).toBeNull(); // 没推进
    expect(listObservations(t.taskId)).toHaveLength(0); // 没记观测
  });
});
