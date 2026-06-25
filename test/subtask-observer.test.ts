/**
 * Unit tests for subtask-observer (Phase 2 观测脚本)。
 * Run: pnpm vitest run test/subtask-observer.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  commitObservationTransaction, getCommand, updateCommand, latestHelpReport, enqueueCommand, __resetForTesting,
  type SubTaskBot, type HelpDelivery,
} from '../src/services/subtask-store.js';
import {
  runObserverTick, planCommit, hasNewHelpProgress, hasBlockedHelpProgress, shouldStaleRereport,
  managerExemptFromStall,
  MIN_OBSERVE_INTERVAL_MS, STALE_REREPORT_MS, STALL_AFTER_MS,
  type ObserverExecutors, type JudgeResult, type PrevHelpReport,
} from '../src/services/subtask-observer.js';
import * as rootInbox from '../src/services/root-inbox-store.js';
import * as sessionStore from '../src/services/session-store.js';

/** 造一个上次 help 上报快照 (PrevHelpReport)，默认 = 已投出、未响应。 */
function mkPrev(over: Partial<PrevHelpReport> = {}): PrevHelpReport {
  return {
    summary: '卡在 X', sourceMessageIds: ['m1', 'm2'],
    sentAt: new Date().toISOString(), acked: false, respondedBySupplement: false,
    lastRespondedAt: null,
    ...over,
  };
}

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
  sessionStore.init();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── planCommit 纯决策 ──────────────────────────────────────────────────────
describe('planCommit', () => {
  const noDone = () => [];
  it('observing + need_help → 报 help + paused(已求助·待人)', () => {
    const p = planCommit('observing', 'need_help', 'm2', noDone);
    expect(p.report?.commandType).toBe('report_help');
    expect(p.statusTo).toBe('paused');
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
  it('reported_done + need_help → 回 paused + supersede 旧 done', () => {
    const p = planCommit('reported_done', 'need_help', 'm3', () => ['cmd_old']);
    expect(p.statusTo).toBe('paused');
    expect(p.report?.commandType).toBe('report_help');
    expect(p.supersedeCommandIds).toEqual(['cmd_old']);
  });
  it('reported_done + normal → 回 observing + supersede 旧 done', () => {
    const p = planCommit('reported_done', 'normal', 'm3', () => ['cmd_old']);
    expect(p.statusTo).toBe('observing');
    expect(p.supersedeCommandIds).toEqual(['cmd_old']);
  });

  // ── B 方案: observing 路径 need_help 按"新进展"去重 ──
  const noDelivery = () => 'acked' as HelpDelivery;
  const noStale = () => [] as string[];
  it('observing+need_help · 有新进展 (默认/首次) → 照常报 help', () => {
    const p = planCommit('observing', 'need_help', 'm5', noDone, noDelivery, noStale, () => true);
    expect(p.report?.commandType).toBe('report_help');
    expect(p.statusTo).toBe('paused');
  });
  it('observing+need_help · 无新进展 (同一未变 blocker) → 静默, 不报不转', () => {
    const p = planCommit('observing', 'need_help', 'm5', noDone, noDelivery, noStale, () => false);
    expect(p).toEqual({});
  });
  it('paused+need_help · 无心跳/无 blocker 变化 → 静默, 不报不转', () => {
    const p = planCommit('paused', 'need_help', 'm5', noDone, noDelivery, noStale, () => false);
    expect(p).toEqual({});
  });
  it('paused+need_help · 2h 心跳或 blocker 变化 → 上报但保持 paused', () => {
    const p = planCommit('paused', 'need_help', 'm5', noDone, noDelivery, noStale, () => true);
    expect(p.report?.commandType).toBe('report_help');
    expect(p.statusTo).toBeUndefined();
  });
  it('paused+need_help · 旧 help failed → 补发 + supersede 旧 help', () => {
    const p = planCommit('paused', 'need_help', 'm5', noDone, () => 'failed', () => ['cmd_old_help'], () => false);
    expect(p.report?.commandType).toBe('report_help');
    expect(p.statusTo).toBeUndefined();
    expect(p.supersedeCommandIds).toEqual(['cmd_old_help']);
  });
  it('paused+done → 报 done + reported_done', () => {
    const p = planCommit('paused', 'done', 'm5', noDone);
    expect(p.report?.commandType).toBe('report_done');
    expect(p.statusTo).toBe('reported_done');
  });
});

// ─── hasNewHelpProgress 纯判断 (B 方案) ──────────────────────────────────────
describe('hasNewHelpProgress', () => {
  it('没上报过 help (prev=null) → 视为新进展 (首次必发)', () => {
    expect(hasNewHelpProgress(null, ['m1'], '卡住了')).toBe(true);
  });
  it('本轮有上次没覆盖过的新证据消息 → 新进展', () => {
    const prev = mkPrev({ summary: '卡在 X', sourceMessageIds: ['m1', 'm2'] });
    expect(hasNewHelpProgress(prev, ['m2', 'm3'], '卡在 X')).toBe(true); // m3 是新证据
  });
  it('本轮证据全是上次已覆盖的 + 诉求归一化相同 → 无新进展 (静默)', () => {
    const prev = mkPrev({ summary: '卡在 X，需要拍板', sourceMessageIds: ['m1', 'm2'] });
    // 证据无新增 (子集) + summary 只差标点/空白 → 归一化相同
    expect(hasNewHelpProgress(prev, ['m1'], '卡在 X 需要拍板')).toBe(false);
  });
  it('证据无新增但诉求实质变化 → 新进展 (blocker 变了)', () => {
    const prev = mkPrev({ summary: '卡在 X', sourceMessageIds: ['m1', 'm2'] });
    expect(hasNewHelpProgress(prev, ['m1'], '现在卡在 Y 了')).toBe(true);
  });
  // ── parentResponded=true: 父群已 supplement 回应 → 被动 LLM 推测不再触发重复升级 ──
  it('父群已响应 + 同 blocker(诉求未变) + 仅有新证据消息 → 静默 (不因新消息重复刷屏)', () => {
    const prev = mkPrev({ summary: '卡在 X', sourceMessageIds: ['m1', 'm2'] });
    // m3 是新消息，旧逻辑会判 true 刷屏；parentResponded 下应静默
    expect(hasNewHelpProgress(prev, ['m2', 'm3'], '卡在 X', true)).toBe(false);
  });
  it('父群已响应 + summary 措辞完全不同 → 仍静默 (关闭被动 LLM 摘要重复升级)', () => {
    const prev = mkPrev({ summary: '卡在 X', sourceMessageIds: ['m1', 'm2'] });
    expect(hasNewHelpProgress(prev, ['m1'], '现在卡在完全不同的 Y 了，必须重新拍板', true)).toBe(false);
  });
  it('父群已响应 + prev=null(首次) → 仍发', () => {
    expect(hasNewHelpProgress(null, ['m1'], '卡住了', true)).toBe(true);
  });
});

describe('hasBlockedHelpProgress', () => {
  it('paused 下忽略新消息证据，只认 blocker 归一化变化', () => {
    const prev = mkPrev({ summary: '卡在 X', sourceMessageIds: ['m1'] });
    expect(hasBlockedHelpProgress(prev, '卡在 X')).toBe(false);
    expect(hasBlockedHelpProgress(prev, '现在卡在 Y 了')).toBe(true);
  });
  it('prev=null → 首次仍允许上报', () => {
    expect(hasBlockedHelpProgress(null, '卡住了')).toBe(true);
  });
});

// ─── shouldStaleRereport 超时兜底 (松松追加) ──────────────────────────────────
describe('shouldStaleRereport', () => {
  const longAgo = () => new Date(Date.now() - STALE_REREPORT_MS - 60_000).toISOString();
  it('没上报过 (prev=null) → 不兜底', () => {
    expect(shouldStaleRereport(null, new Date())).toBe(false);
  });
  it('从没真投出 (sentAt=null) → 不兜底 (归 helpReportDelivery 那条线管)', () => {
    expect(shouldStaleRereport(mkPrev({ sentAt: null }), new Date())).toBe(false);
  });
  it('超 2h + 未 ack + 没 supplement → 兜底重报', () => {
    expect(shouldStaleRereport(mkPrev({ sentAt: longAgo() }), new Date())).toBe(true);
  });
  // ── 父群响应 = 重新起算 2h，而非永久关闭兜底 (bug 修复 2026-05-31，蔻黛克斯 review) ──
  it('求助很久前投出但父群**刚**响应过 (lastRespondedAt 新) → 不重报 (给执行者推进时间)', () => {
    expect(shouldStaleRereport(
      mkPrev({ sentAt: longAgo(), acked: true, lastRespondedAt: new Date().toISOString() }),
      new Date(),
    )).toBe(false);
  });
  it('父群响应也已超 2h + 同 blocker 仍卡 → 兜底重报 (响应没解决，不能永久埋掉)', () => {
    expect(shouldStaleRereport(
      mkPrev({ sentAt: longAgo(), respondedBySupplement: true, lastRespondedAt: longAgo() }),
      new Date(),
    )).toBe(true);
  });
  it('supplement 刚响应 (lastRespondedAt 新) 即便 sentAt 很久前 → 不重报', () => {
    expect(shouldStaleRereport(
      mkPrev({ sentAt: longAgo(), respondedBySupplement: true, lastRespondedAt: new Date().toISOString() }),
      new Date(),
    )).toBe(false);
  });
  it('未超时 (刚上报) → 不重报', () => {
    expect(shouldStaleRereport(mkPrev({ sentAt: new Date().toISOString() }), new Date())).toBe(false);
  });
});

// ─── runObserverTick 集成 ───────────────────────────────────────────────────
describe('runObserverTick', () => {
  it('observing + need_help → paused + help 命令 + cursor 推进', async () => {
    const t = await mkObserving();
    const exec = mkExec({ judged: { signal: 'need_help', summary: '卡住了' } });
    const stats = await runObserverTick(new Date(), exec);
    expect(stats.committed).toBe(1);
    const after = getSubTask(t.taskId)!;
    expect(after.status).toBe('paused');
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

  it('reported_done recheck：有新活动且 need_help → 回 paused + supersede 旧 done', async () => {
    const t = await mkObserving();
    const done = await commitObservationTransaction({ taskId: t.taskId, readFromCursor: null, readToCursor: 'm1', analyzedMessageIds: ['m1'], summary: '完成', signal: 'done', report: { commandType: 'report_done', idempotencyKey: 'd1' }, statusTo: 'reported_done' });
    const doneCmd = done!.command!.cmdId;
    const exec = mkExec({ messages: [{ id: 'm2', rendered: '又出问题' }], judged: { signal: 'need_help', summary: '又出问题' } });
    await runObserverTick(new Date(Date.now() + 2 * MIN_OBSERVE_INTERVAL_MS), exec);
    expect(getSubTask(t.taskId)!.status).toBe('paused');
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

  // ── B 方案集成: supplement 重开 observing 后, 同一未变 blocker 不重复上报 ──
  it('B：help 上报 → supplement 切回 observing → 同一 blocker 无新进展 → 不重复 enqueue', async () => {
    const t = await mkObserving();
    // ① observing+need_help → paused + help#1 (覆盖证据 m1/m2)
    const exec1 = mkExec({ messages: [{ id: 'm1', rendered: '卡在 X' }, { id: 'm2', rendered: '需拍板' }], judged: { signal: 'need_help', summary: '卡在 X 需要拍板' } });
    await runObserverTick(new Date(), exec1);
    expect(getSubTask(t.taskId)!.status).toBe('paused');
    expect(listCommands(t.taskId).filter(c => c.commandType === 'report_help')).toHaveLength(1);
    // ② 主 bot supplement → paused 切回 observing (模拟 orchestrator.supplementSubtask 的转移)
    await transitionStatus(t.taskId, 'observing');
    // ③ 同一 blocker: 没有上次 help (m1/m2) 之外的新证据 + 诉求归一化相同 → 静默不重复上报
    const exec2 = mkExec({ messages: [{ id: 'm2', rendered: '需拍板' }], judged: { signal: 'need_help', summary: '卡在 X，需要拍板' } });
    await runObserverTick(new Date(Date.now() + 2 * MIN_OBSERVE_INTERVAL_MS), exec2);
    expect(getSubTask(t.taskId)!.status).toBe('observing');                                   // 没再转 reported_help
    expect(listCommands(t.taskId).filter(c => c.commandType === 'report_help')).toHaveLength(1); // 没多发 help
    expect(listObservations(t.taskId)).toHaveLength(2);                                        // 但观测照常记
  });

  it('B：supplement 切回 observing 后, 出现新进展 (新证据/诉求变化) → 才再 enqueue', async () => {
    const t = await mkObserving();
    const exec1 = mkExec({ messages: [{ id: 'm1', rendered: '卡在 X' }, { id: 'm2', rendered: '需拍板' }], judged: { signal: 'need_help', summary: '卡在 X' } });
    await runObserverTick(new Date(), exec1);
    expect(latestHelpReport(t.taskId)!.sourceMessageIds).toEqual(['m1', 'm2']);
    await transitionStatus(t.taskId, 'observing');
    // 新证据 m3 (上次 help 没覆盖过) → 有新进展 → 再上报
    const exec2 = mkExec({ messages: [{ id: 'm3', rendered: '新情况: 又冒新 blocker' }], judged: { signal: 'need_help', summary: '又冒新 blocker' } });
    await runObserverTick(new Date(Date.now() + 2 * MIN_OBSERVE_INTERVAL_MS), exec2);
    expect(getSubTask(t.taskId)!.status).toBe('paused');                                       // 再次进入已求助·待人
    expect(listCommands(t.taskId).filter(c => c.commandType === 'report_help')).toHaveLength(2); // 补发了第二条
  });

  // ── parentResponded 接线: 存在**真** supplement 命令 → respondedBySupplement=true，
  //    observing 路径不再因被动 LLM 摘要/证据变化重复上报；显式 askforhelp 和 2h 兜底走独立通道。 ──
  it('父群真 supplement 回应后 + 同 blocker + 仅新证据 m3 → 静默 (修复 supplement 后刷屏)', async () => {
    const t = await mkObserving();
    const exec1 = mkExec({ messages: [{ id: 'm1', rendered: '卡在 X' }, { id: 'm2', rendered: '需拍板' }], judged: { signal: 'need_help', summary: '卡在 X' } });
    await runObserverTick(new Date(), exec1);
    expect(listCommands(t.taskId).filter(c => c.commandType === 'report_help')).toHaveLength(1);
    // 真 supplement 命令 (parent→child)，createdAt 晚于 help#1 → latestHelpReport.respondedBySupplement=true
    const supp = await enqueueCommand({ taskId: t.taskId, direction: 'parent_to_child', targetChatId: 'oc_parent', commandType: 'supplement', payload: { content: '这样做' }, idempotencyKey: 'supp-1' });
    await updateCommand(supp.cmdId, { createdAt: new Date(Date.now() + 1_000).toISOString() });
    expect(latestHelpReport(t.taskId)!.respondedBySupplement).toBe(true);
    await transitionStatus(t.taskId, 'observing');
    // 新证据 m3 但诉求未变 → 旧逻辑会刷屏；parentResponded 下应静默
    const exec2 = mkExec({ messages: [{ id: 'm3', rendered: '我在按 supplement 推进' }], judged: { signal: 'need_help', summary: '卡在 X' } });
    await runObserverTick(new Date(Date.now() + 2 * MIN_OBSERVE_INTERVAL_MS), exec2);
    expect(getSubTask(t.taskId)!.status).toBe('observing');                                     // 没再转 reported_help
    expect(listCommands(t.taskId).filter(c => c.commandType === 'report_help')).toHaveLength(1); // 没多发 help
  });

  it('父群真 supplement 回应后 + LLM summary 变成新 blocker → 仍静默 (不走被动推测重复升级)', async () => {
    const t = await mkObserving();
    const exec1 = mkExec({ messages: [{ id: 'm1', rendered: '卡在 X' }, { id: 'm2', rendered: '需拍板' }], judged: { signal: 'need_help', summary: '卡在 X' } });
    await runObserverTick(new Date(), exec1);
    const supp = await enqueueCommand({ taskId: t.taskId, direction: 'parent_to_child', targetChatId: 'oc_parent', commandType: 'supplement', payload: { content: '这样做' }, idempotencyKey: 'supp-1' });
    await updateCommand(supp.cmdId, { createdAt: new Date(Date.now() + 1_000).toISOString() });
    expect(latestHelpReport(t.taskId)!.respondedBySupplement).toBe(true);
    await transitionStatus(t.taskId, 'observing');
    const exec2 = mkExec({ messages: [{ id: 'm3', rendered: '又冒新问题' }], judged: { signal: 'need_help', summary: '现在卡在 Y 了' } });
    await runObserverTick(new Date(Date.now() + 2 * MIN_OBSERVE_INTERVAL_MS), exec2);
    expect(getSubTask(t.taskId)!.status).toBe('observing');
    expect(listCommands(t.taskId).filter(c => c.commandType === 'report_help')).toHaveLength(1);
  });

  it('paused：父群不在期间 + 同 blocker + 催办噪声新消息 → 不刷屏', async () => {
    const t = await mkObserving();
    const base = Date.now();
    const exec1 = mkExec({ messages: [{ id: 'm1', rendered: '卡在 X' }], judged: { signal: 'need_help', summary: '卡在 X' } });
    await runObserverTick(new Date(base), exec1);
    expect(getSubTask(t.taskId)!.status).toBe('paused');
    expect(listCommands(t.taskId).filter(c => c.commandType === 'report_help')).toHaveLength(1);

    const exec2 = mkExec({ messages: [{ id: 'm2', rendered: '催办：有进展吗？' }], judged: { signal: 'need_help', summary: '卡在 X' } });
    await runObserverTick(new Date(base + 2 * MIN_OBSERVE_INTERVAL_MS), exec2);
    expect(getSubTask(t.taskId)!.status).toBe('paused');
    expect(listCommands(t.taskId).filter(c => c.commandType === 'report_help')).toHaveLength(1);
  });

  it('paused：blocker 实质变化 → 仍升级重报', async () => {
    const t = await mkObserving();
    const base = Date.now();
    await runObserverTick(new Date(base), mkExec({ messages: [{ id: 'm1', rendered: '卡在 X' }], judged: { signal: 'need_help', summary: '卡在 X' } }));
    expect(getSubTask(t.taskId)!.status).toBe('paused');

    const exec2 = mkExec({ messages: [{ id: 'm2', rendered: '改为卡在 Y' }], judged: { signal: 'need_help', summary: '现在卡在 Y 了' } });
    await runObserverTick(new Date(base + 2 * MIN_OBSERVE_INTERVAL_MS), exec2);
    expect(getSubTask(t.taskId)!.status).toBe('paused');
    expect(listCommands(t.taskId).filter(c => c.commandType === 'report_help')).toHaveLength(2);
  });

  // ── 超时兜底重报集成 (松松追加): 无新进展但隔很久没人响应 → 兜底再报一次 ──
  /** 跑 ①help → supplement 切回 observing，并把 help 标成"已投出 sentAt=base"。返 {t, base, helpCmdId}。 */
  async function setupStaleHelp() {
    const t = await mkObserving();
    const base = Date.now();
    const exec1 = mkExec({ messages: [{ id: 'm1', rendered: '卡在 X' }, { id: 'm2', rendered: '需拍板' }], judged: { signal: 'need_help', summary: '卡在 X 需要拍板' } });
    await runObserverTick(new Date(base), exec1);
    const helpCmdId = listCommands(t.taskId).filter(c => c.commandType === 'report_help')[0].cmdId;
    // 模拟 dispatcher 已投出 (sentAt=base)，但主 bot 一直没 ack
    await updateCommand(helpCmdId, { deliveryStatus: 'sent', sentAt: new Date(base).toISOString() });
    await transitionStatus(t.taskId, 'observing'); // supplement 般切回 observing
    return { t, base, helpCmdId };
  }

  it('兜底①：无新进展 + 未超时 → 静默 (不 enqueue)', async () => {
    const { t, base } = await setupStaleHelp();
    // 同一 blocker (证据子集 + 诉求相同)，距上次投出仅几分钟 (未超 2h)
    const exec2 = mkExec({ messages: [{ id: 'm2', rendered: '需拍板' }], judged: { signal: 'need_help', summary: '卡在 X，需要拍板' } });
    await runObserverTick(new Date(base + 2 * MIN_OBSERVE_INTERVAL_MS), exec2);
    expect(listCommands(t.taskId).filter(c => c.commandType === 'report_help')).toHaveLength(1); // 没多发
    expect(getSubTask(t.taskId)!.status).toBe('observing');
  });

  it('兜底②：无新进展 + 超 2h + 未 ack + blocker 在 → 兜底重报 (enqueue)', async () => {
    const { t, base } = await setupStaleHelp();
    const exec2 = mkExec({ messages: [{ id: 'm2', rendered: '需拍板' }], judged: { signal: 'need_help', summary: '卡在 X，需要拍板' } });
    // now = base + 2h + buffer → 超阈值；help 仍未 ack/未 supplement
    await runObserverTick(new Date(base + STALE_REREPORT_MS + 5 * 60_000), exec2);
    expect(listCommands(t.taskId).filter(c => c.commandType === 'report_help')).toHaveLength(2); // 兜底补发
    expect(getSubTask(t.taskId)!.status).toBe('paused');
  });

  it('paused 兜底：超 2h 无响应 → 心跳重报一次', async () => {
    const t = await mkObserving();
    const base = Date.now();
    await runObserverTick(new Date(base), mkExec({ messages: [{ id: 'm1', rendered: '卡在 X' }], judged: { signal: 'need_help', summary: '卡在 X' } }));
    const helpCmdId = listCommands(t.taskId).filter(c => c.commandType === 'report_help')[0].cmdId;
    await updateCommand(helpCmdId, { deliveryStatus: 'sent', sentAt: new Date(base).toISOString() });

    await runObserverTick(
      new Date(base + STALE_REREPORT_MS + 5 * 60_000),
      mkExec({ messages: [{ id: 'm2', rendered: '仍卡在 X' }], judged: { signal: 'need_help', summary: '卡在 X' } }),
    );
    expect(getSubTask(t.taskId)!.status).toBe('paused');
    expect(listCommands(t.taskId).filter(c => c.commandType === 'report_help')).toHaveLength(2);
  });

  it('paused 兜底：无新消息且超 2h 无响应 → 心跳重报一次', async () => {
    const t = await mkObserving();
    const base = Date.now();
    await runObserverTick(new Date(base), mkExec({ messages: [{ id: 'm1', rendered: '卡在 X' }], judged: { signal: 'need_help', summary: '卡在 X' } }));
    const helpCmdId = listCommands(t.taskId).filter(c => c.commandType === 'report_help')[0].cmdId;
    await updateCommand(helpCmdId, { deliveryStatus: 'sent', sentAt: new Date(base).toISOString() });

    const exec = mkExec({ messages: [] });
    await runObserverTick(new Date(base + STALE_REREPORT_MS + 5 * 60_000), exec);

    const after = getSubTask(t.taskId)!;
    const helps = listCommands(t.taskId).filter(c => c.commandType === 'report_help');
    expect(exec.judge).not.toHaveBeenCalled();
    expect(after.status).toBe('paused');
    expect(after.committedCursor).toBe('m1');
    expect(helps).toHaveLength(2);
    expect(helps[0].supersededBy).toBe(helps[1].cmdId);
    expect(listObservations(t.taskId).at(-1)!.analyzedMessageIds).toEqual([]);

    await runObserverTick(new Date(base + STALE_REREPORT_MS + 10 * 60_000), mkExec({ messages: [] }));
    expect(listCommands(t.taskId).filter(c => c.commandType === 'report_help')).toHaveLength(2);
  });

  // bug 修复 (2026-05-31 蔻黛克斯 review): 响应 = 重新起算 2h，而非永久关闭兜底。
  it('兜底③：响应(acked)也已超 2h 同 blocker 仍卡 → 兜底重报 (响应没解决, 不永久埋掉)', async () => {
    const { t, base, helpCmdId } = await setupStaleHelp();
    // ack 发生在很早 (base+60s)；重检在 base+2h+5min → 距 ack 也已超 2h
    await updateCommand(helpCmdId, { deliveryStatus: 'acked', ackedAt: new Date(base + 60_000).toISOString() });
    const exec2 = mkExec({ messages: [{ id: 'm2', rendered: '需拍板' }], judged: { signal: 'need_help', summary: '卡在 X，需要拍板' } });
    await runObserverTick(new Date(base + STALE_REREPORT_MS + 5 * 60_000), exec2);
    expect(listCommands(t.taskId).filter(c => c.commandType === 'report_help')).toHaveLength(2); // 兜底补发
    expect(getSubTask(t.taskId)!.status).toBe('paused');
  });

  it('兜底④：父群**刚**响应过 (ack 在重检前 5min) → 不重报 (给执行者推进时间, 不刚回应就刷屏)', async () => {
    const { t, base, helpCmdId } = await setupStaleHelp();
    const checkAt = base + STALE_REREPORT_MS + 5 * 60_000;
    // ack 发生在重检前 5min → 距响应 < 2h，应抑制
    await updateCommand(helpCmdId, { deliveryStatus: 'acked', ackedAt: new Date(checkAt - 5 * 60_000).toISOString() });
    const exec2 = mkExec({ messages: [{ id: 'm2', rendered: '需拍板' }], judged: { signal: 'need_help', summary: '卡在 X，需要拍板' } });
    await runObserverTick(new Date(checkAt), exec2);
    expect(listCommands(t.taskId).filter(c => c.commandType === 'report_help')).toHaveLength(1); // 没重报
    expect(getSubTask(t.taskId)!.status).toBe('observing');
  });

  // 优化 #3 蔻黛克斯 code-review blocker1：纯 owner 回声不进 judge/不驱动状态
  it('owner-only nudge 回声 → 推进 cursor，但 judge 不调用、不上报、不转态', async () => {
    const t = await mkObserving(); // requester = ou_jason
    const exec = {
      // senderId === task.requester(ou_jason) → owner 回声，无执行者活动
      fetchSince: vi.fn(async () => ({ messages: [{ id: 'm1', rendered: '[ou_jason] 任务搞定没有？', senderId: 'ou_jason' }], complete: true })),
      judge: vi.fn(async () => ({ signal: 'need_help', summary: '（即便误判 need_help 也不该触发）' })),
    } as any;
    await runObserverTick(new Date(), exec);
    const after = getSubTask(t.taskId)!;
    expect(after.committedCursor).toBe('m1');                 // cursor 推进 (防重读循环)
    expect(after.status).toBe('observing');                   // 未转 reported_help
    expect(listCommands(t.taskId).filter(c => c.commandType === 'report_help')).toHaveLength(0); // 不上报
    expect(exec.judge).not.toHaveBeenCalled();                // 纯回声不进 judge
  });
});

// 2026-06-21 bug：汇报制经理群收到 observer 的「任务搞定没有？」stall-nudge（observer 监督式
// 漏进汇报制）。根因：handleStall 的 stall 逻辑（超时→nudge/escalate）未豁免 reportingMode=manager。
// 经理是事件驱动、静默=正常空闲，不该被 stall-nudge。
describe('managerExemptFromStall: 经理群豁免 observer stall-nudge', () => {
  it('reportingMode=manager → 豁免（不发 stall-nudge/escalate）', () => {
    expect(managerExemptFromStall({ reportingMode: 'manager' } as any)).toBe(true);
  });
  it('reportingMode=executor → 不豁免（正常走 stall 逻辑）', () => {
    expect(managerExemptFromStall({ reportingMode: 'executor' } as any)).toBe(false);
  });
  it('reportingMode 缺省（旧任务）→ 不豁免（字节兼容旧 executor 行为）', () => {
    expect(managerExemptFromStall({} as any)).toBe(false);
  });
});

describe('manager self-heal step2+3 wiring', () => {
  async function mkManagerTask(status: 'observing' | 'paused' | 'reported_help', at: Date, key = 'mgr-k') {
    vi.useFakeTimers();
    vi.setSystemTime(at);
    const t = await createSubTask({
      chatId: `oc_mgr_${key}`,
      parentChatId: 'oc_parent',
      parentMessageId: 'om_src',
      goal: '经理部门任务',
      acceptance: null,
      bots: [{ openId: 'ou_mgr', name: '经理', role: 'main', larkAppId: 'app_mgr' }],
      requester: 'ou_jason',
      createdBy: 'ou_mgr',
      createdByLarkAppId: 'app_mgr',
      idempotencyKey: key,
      reportingMode: 'manager',
      rootChatId: 'oc_root',
    });
    await transitionStatus(t.taskId, 'observing');
    if (status !== 'observing') await transitionStatus(t.taskId, status);
    return getSubTask(t.taskId)!;
  }

  it('manager paused 卡死超 2h → 写 manager_stalled RootInbox；重复 tick 不重复上浮/更新', async () => {
    const start = new Date('2026-06-24T00:00:00Z');
    const t = await mkManagerTask('paused', start, 'mgr-stalled');
    sessionStore.init('app_mgr');
    const s = sessionStore.createSession(t.chatId, 'om_root', 'old manager session');
    sessionStore.updateSession({
      ...s,
      larkAppId: 'app_mgr',
      createdAt: start.toISOString(),
      lastMessageAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
    });
    sessionStore.init('app_observer');
    const now = new Date(start.getTime() + 3 * 60 * 60 * 1000);
    vi.setSystemTime(now);

    await runObserverTick(now, mkExec({ messages: [] }));
    const id = `manager_stalled:${t.taskId}`;
    expect(rootInbox.lookup(id)?.kind).toBe('manager_stalled');
    expect(rootInbox.lookup(id)?.updateCount).toBe(1);
    expect(rootInbox.lookup(`manager_session_aged:${t.taskId}`)).toBeNull();
    expect(listCommands(t.taskId).filter(c => c.commandType === 'report_help')).toHaveLength(0);
    expect(getSubTask(t.taskId)!.status).toBe('paused'); // 默认只告警，不自动 resume/转态

    await runObserverTick(new Date(now.getTime() + 2 * MIN_OBSERVE_INTERVAL_MS), mkExec({ messages: [] }));
    expect(rootInbox.lookup(id)?.updateCount).toBe(1);
    expect(rootInbox.listOpen().filter(it => it.id === id)).toHaveLength(1);
    expect(rootInbox.lookup(`manager_session_aged:${t.taskId}`)).toBeNull();
  });

  it('未卡死 manager / executor 不写 manager_stalled', async () => {
    const start = new Date('2026-06-24T00:00:00Z');
    await mkManagerTask('reported_help', start, 'mgr-fresh');
    const freshNow = new Date(start.getTime() + 60 * 60 * 1000);
    vi.setSystemTime(freshNow);
    await runObserverTick(freshNow, mkExec({ messages: [] }));
    expect(rootInbox.listOpen().filter(it => it.kind === 'manager_stalled')).toHaveLength(0);

    const exec = await createSubTask({
      chatId: 'oc_exec',
      parentChatId: 'oc_parent',
      parentMessageId: 'om_src',
      goal: '执行任务',
      acceptance: null,
      bots: BOTS,
      requester: 'ou_jason',
      createdBy: 'ou_claude',
      idempotencyKey: 'exec-stalled',
      reportingMode: 'executor',
    });
    await transitionStatus(exec.taskId, 'paused');
    await runObserverTick(new Date(freshNow.getTime() + 30 * 60 * 1000), mkExec({ messages: [] }));
    expect(rootInbox.listOpen().filter(it => it.kind === 'manager_stalled')).toHaveLength(0);
  });

  it('manager active session 年龄>12h + idle>2h + pending work → 写 manager_session_aged，默认不 recover', async () => {
    const start = new Date('2026-06-24T00:00:00Z');
    const t = await mkManagerTask('observing', start, 'mgr-aged');
    sessionStore.init('app_mgr');
    const s = sessionStore.createSession(t.chatId, 'om_root', 'manager session');
    sessionStore.updateSession({
      ...s,
      larkAppId: 'app_mgr',
      createdAt: start.toISOString(),
      lastMessageAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
    });
    sessionStore.init('app_observer');
    await enqueueCommand({
      taskId: t.taskId,
      direction: 'parent_to_child',
      targetChatId: t.chatId,
      commandType: 'request_report',
      payload: { requestId: 'req_1' },
      idempotencyKey: 'req-report-1',
    });

    const now = new Date(start.getTime() + 13 * 60 * 60_000);
    vi.setSystemTime(now);
    await runObserverTick(now, mkExec({ messages: [] }));
    const item = rootInbox.lookup(`manager_session_aged:${t.taskId}`);
    expect(item?.kind).toBe('manager_session_aged');
    expect(item?.summary).toContain('默认仅告警');

    await runObserverTick(new Date(now.getTime() + 2 * MIN_OBSERVE_INTERVAL_MS), mkExec({ messages: [] }));
    expect(rootInbox.lookup(`manager_session_aged:${t.taskId}`)?.updateCount).toBe(1);
  });

  it('manager aging 只认 manager main app 的 session，同 chat 其它 app session 不触发', async () => {
    const start = new Date('2026-06-24T00:00:00Z');
    const t = await mkManagerTask('observing', start, 'mgr-wrong-app');
    sessionStore.init('app_other');
    const s = sessionStore.createSession(t.chatId, 'om_root', 'unrelated session');
    sessionStore.updateSession({
      ...s,
      larkAppId: 'app_other',
      createdAt: start.toISOString(),
      lastMessageAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
    });
    sessionStore.init('app_observer');
    await enqueueCommand({
      taskId: t.taskId,
      direction: 'parent_to_child',
      targetChatId: t.chatId,
      commandType: 'request_report',
      payload: { requestId: 'req_wrong_app' },
      idempotencyKey: 'req-report-wrong-app',
    });

    const now = new Date(start.getTime() + 13 * 60 * 60_000);
    vi.setSystemTime(now);
    await runObserverTick(now, mkExec({ messages: [] }));
    expect(rootInbox.lookup(`manager_session_aged:${t.taskId}`)).toBeNull();
  });

  it('request_review targetRole=collab 不算 manager pending work，避免待审误判 session 老化', async () => {
    const start = new Date('2026-06-24T00:00:00Z');
    const t = await mkManagerTask('observing', start, 'mgr-review-collab');
    sessionStore.init('app_mgr');
    const s = sessionStore.createSession(t.chatId, 'om_root', 'manager session');
    sessionStore.updateSession({
      ...s,
      larkAppId: 'app_mgr',
      createdAt: start.toISOString(),
      lastMessageAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
    });
    sessionStore.init('app_observer');
    await enqueueCommand({
      taskId: t.taskId,
      direction: 'parent_to_child',
      targetChatId: t.chatId,
      commandType: 'request_review',
      payload: { summary: 'https://docx/review', targetRole: 'collab' },
      idempotencyKey: 'request-review-collab',
    });

    const now = new Date(start.getTime() + 13 * 60 * 60_000);
    vi.setSystemTime(now);
    await runObserverTick(now, mkExec({ messages: [] }));
    expect(rootInbox.lookup(`manager_session_aged:${t.taskId}`)).toBeNull();
  });

  it('长 session 但无 pending work → 不判老化，防误判正常待命经理', async () => {
    const start = new Date('2026-06-24T00:00:00Z');
    const t = await mkManagerTask('observing', start, 'mgr-idle-ok');
    const s = sessionStore.createSession(t.chatId, 'om_root', 'manager idle session');
    sessionStore.updateSession({
      ...s,
      larkAppId: 'app_mgr',
      createdAt: start.toISOString(),
      lastMessageAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
    });
    const now = new Date(start.getTime() + 13 * 60 * 60_000);
    vi.setSystemTime(now);
    await runObserverTick(now, mkExec({ messages: [] }));
    expect(rootInbox.lookup(`manager_session_aged:${t.taskId}`)).toBeNull();
  });
});

// 2026-06-21 bug：子群提交 request_review 后状态仍停 observing → observer 每 STALL_AFTER_MS 催一次
// 「任务搞定没有?」刷屏（实例被催 20 次）。根因：request_review 不改状态、不是 stall 豁免态。
// 修复：handleStall 里「最近一条主动命令是 request_review」→ 交付待审、不催执行者；超 2h 才重 surface 给 reviewer。
describe('交付待审豁免 stall-nudge（治 request_review 后"做完没有?"刷屏）', () => {
  async function seedReview(t: SubTask, sentAt: string) {
    const c = await enqueueCommand({
      taskId: t.taskId, direction: 'parent_to_child', targetChatId: t.chatId,
      commandType: 'request_review', payload: { summary: 'https://docx/abc', targetRole: 'collab' } as any,
      idempotencyKey: 'rr-1',
    });
    await updateCommand(c.cmdId, { sentAt });
    return c;
  }

  it('最近一条主动命令是 request_review + 无新消息 + 已超停滞阈 → 不催执行者（无 nudge）', async () => {
    const t = await mkObserving();
    const now = new Date();
    await seedReview(t, now.toISOString());
    // 距停滞阈很久仍无新消息：旧逻辑会发 nudge；交付待审应静默
    const later = new Date(now.getTime() + STALL_AFTER_MS + 5 * 60_000);
    await runObserverTick(later, mkExec({ messages: [] }));
    expect(listCommands(t.taskId).filter(c => c.commandType === 'nudge')).toHaveLength(0);
    expect(getSubTask(t.taskId)!.status).toBe('observing'); // 状态不变、不 escalate
  });

  it('控制组：最近一条主动命令是 supplement（非 request_review）+ 超停滞阈 → 照常 nudge', async () => {
    const t = await mkObserving();
    const now = new Date();
    const supp = await enqueueCommand({
      taskId: t.taskId, direction: 'parent_to_child', targetChatId: t.chatId,
      commandType: 'supplement', payload: { content: '继续' } as any, idempotencyKey: 'supp-1',
    });
    await updateCommand(supp.cmdId, { sentAt: now.toISOString() });
    const later = new Date(now.getTime() + STALL_AFTER_MS + 5 * 60_000);
    await runObserverTick(later, mkExec({ messages: [] }));
    expect(listCommands(t.taskId).filter(c => c.commandType === 'nudge')).toHaveLength(1);
  });

  it('request_review 超 2h（STALE_REREPORT_MS）仍未闭环 → 重新 surface 给 reviewer（不催执行者）', async () => {
    const t = await mkObserving();
    const now = new Date();
    await seedReview(t, new Date(now.getTime() - STALE_REREPORT_MS - 60_000).toISOString());
    await runObserverTick(now, mkExec({ messages: [] }));
    const reviews = listCommands(t.taskId).filter(c => c.commandType === 'request_review');
    expect(reviews).toHaveLength(2); // 原 request_review + 兜底重 surface
    expect(reviews.some(c => c.idempotencyKey.startsWith('review-revive-'))).toBe(true);
    expect(listCommands(t.taskId).filter(c => c.commandType === 'nudge')).toHaveLength(0); // 绝不催执行者
  });

  it('request_review 超 2h 兜底只重 surface 一次（幂等防 respam）', async () => {
    const t = await mkObserving();
    const now = new Date();
    await seedReview(t, new Date(now.getTime() - STALE_REREPORT_MS - 60_000).toISOString());
    await runObserverTick(now, mkExec({ messages: [] }));
    await runObserverTick(new Date(now.getTime() + 2 * MIN_OBSERVE_INTERVAL_MS), mkExec({ messages: [] }));
    expect(listCommands(t.taskId).filter(c => c.commandType === 'request_review')).toHaveLength(2); // 没再多发
  });
});
