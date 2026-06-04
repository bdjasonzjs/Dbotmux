/**
 * 优化 #1(角色分工+时序门控) / #2(norms 固化) / #3(停滞自动唤醒) 单测。
 * 覆盖：role-aware parentToChildSummon、planStallNudge 决策、nudge/escalate 原子 helper、
 * commitObservationTransaction 的 hasExecutorActivity 重置语义。
 * Run: pnpm vitest run test/subtask-workflow-opt-123.test.ts
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
vi.mock('../src/services/base-relay.js', () => ({
  DEFAULT_GROUP_NOT_FOUND_RETRY_TIMEOUT_MS: 10_000,
  sendAsOwner: vi.fn(),
}));

import { parentToChildSummon, childToParentSummon } from '../src/services/outbox-dispatcher-executors.js';
import { planStallNudge, STALL_AFTER_MS, MAX_NUDGES } from '../src/services/subtask-observer.js';
import {
  createSubTask, getSubTask, transitionStatus, updateSubTask, listCommands, commitObservationTransaction,
  enqueueNudgeAndUpdateStats, escalateStalledTask, __resetForTesting,
  type SubTask, type SubTaskBot, type OutboxCommand,
} from '../src/services/subtask-store.js';

const BOTS_FULL: SubTaskBot[] = [
  { openId: 'ou_claude', name: '克劳德', role: 'main' },
  { openId: 'ou_codex', name: '蔻黛克斯', role: 'collab' },
  { openId: 'ou_coco', name: '缇蕾', role: 'observer' },
];

function mkTaskLit(over?: Partial<SubTask>): SubTask {
  return {
    taskId: 'st_1', chatId: 'oc_sub', parentChatId: 'oc_parent', parentMessageId: 'om_src',
    goal: '修个 bug', acceptance: '单测过', bots: BOTS_FULL,
    requester: 'ou_jason', createdBy: 'ou_claude', idempotencyKey: 'k', status: 'observing',
    version: 1, createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z',
    readCursor: null, committedCursor: null, deadline: null, staleAfter: null,
    compactSummary: null, lastError: null, ...over,
  };
}
function mkCmd(over?: Partial<OutboxCommand>): OutboxCommand {
  return {
    cmdId: 'cmd_x', taskId: 'st_1', direction: 'parent_to_child', targetChatId: 'oc_sub',
    commandType: 'kickoff', payload: {}, idempotencyKey: 'ik', expectedTaskVersion: 1,
    deliveryStatus: 'pending', deliveredMessageId: null, retryCount: 0, nextRetryAt: null,
    sentAt: null, ackedAt: null, supersededBy: null, lastError: null, createdAt: 't',
    dispatchingUntil: null, dispatchAttemptId: null, ...over,
  };
}

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'opt123-')); __resetForTesting(); });

// ─────────────────────────────────────────────────────────────────────────────
describe('#1 role-aware parentToChildSummon', () => {
  const task = mkTaskLit();

  it('kickoff 只唤执行者(main)，含主推进者措辞 + request-review 提示 + 协作 norms 单行', () => {
    const t = parentToChildSummon(mkCmd({ commandType: 'kickoff' }), task);
    expect(t).toContain('【克劳德】');
    expect(t).not.toContain('蔻黛克斯');         // reviewer 不在 kickoff 名单
    expect(t).toContain('主推进者');
    expect(t).toContain('subtask-request-review');
    expect(t).toContain('worktree');             // 协作 norms 单行
  });

  it('request_review 只唤 reviewer(collab)，含只 review 不抢执行措辞', () => {
    const t = parentToChildSummon(mkCmd({ commandType: 'request_review', payload: { summary: '/tmp/plan.md' } }), task);
    expect(t).toContain('【蔻黛克斯】');
    expect(t).not.toContain('【克劳德】');
    expect(t).toContain('/tmp/plan.md');
    expect(t).toContain('不产主交付物');
  });

  it('nudge 只唤执行者(main)，正文就一句「任务搞定没有？」', () => {
    const t = parentToChildSummon(mkCmd({ commandType: 'nudge' }), task);
    expect(t).toContain('【克劳德】');
    expect(t).not.toContain('蔻黛克斯');
    expect(t).toContain('任务搞定没有？');
  });

  it('supplement 缺省 targetRole → legacy=all (唤 main+collab)', () => {
    const t = parentToChildSummon(mkCmd({ commandType: 'supplement', payload: { content: '用这个 token' } }), task);
    expect(t).toContain('【克劳德/蔻黛克斯】');
  });

  it('supplement targetRole=main → 只唤执行者', () => {
    const t = parentToChildSummon(mkCmd({ commandType: 'supplement', payload: { content: 'x', targetRole: 'main' } }), task);
    expect(t).toContain('【克劳德】');
    expect(t).not.toContain('蔻黛克斯');
  });

  it('main 空 → kickoff 回退非 observer，绝不发空名单【】', () => {
    const noMain = mkTaskLit({ bots: [
      { openId: 'ou_codex', name: '蔻黛克斯', role: 'collab' },
      { openId: 'ou_coco', name: '缇蕾', role: 'observer' },
    ] });
    const t = parentToChildSummon(mkCmd({ commandType: 'kickoff' }), noMain);
    expect(t).not.toContain('【】');
    expect(t).toContain('蔻黛克斯');   // 回退到非 observer
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('下发指令统一附加「交还主群文档必须写为飞书文档」(2026-06-04 邹劲松)', () => {
  const task = mkTaskLit();
  const RULE = '交还主群审查的文档，都必须写为飞书文档';

  it.each(['kickoff', 'request_review', 'nudge', 'finish', 'supplement'] as const)(
    '%s 下发指令末尾含飞书文档规则', (commandType) => {
      const t = parentToChildSummon(mkCmd({ commandType, payload: { summary: 's', content: 'c' } }), task);
      expect(t).toContain(RULE);
      expect(t.includes('\n')).toBe(false); // 仍保持单行 (base 记录标题)
    });

  it('child→parent 上报不加该规则 (它是上报、不是下发指令)', () => {
    const t = childToParentSummon(mkCmd({ direction: 'child_to_parent', commandType: 'report_help' }), task);
    expect(t).not.toContain(RULE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('#3 planStallNudge 决策', () => {
  const old = '2026-06-01T00:00:00.000Z';
  const now = new Date(new Date(old).getTime() + STALL_AFTER_MS + 60_000); // 超阈

  it('observing + 距实质活动超阈 + 未 nudge → nudge', () => {
    const t = mkTaskLit({ status: 'observing', lastExecutorActivityAt: old });
    expect(planStallNudge(t, now)).toEqual({ kind: 'nudge' });
  });

  it('reported_help (在等父群) → none', () => {
    const t = mkTaskLit({ status: 'reported_help', lastExecutorActivityAt: old });
    expect(planStallNudge(t, now)).toEqual({ kind: 'none' });
  });

  it('近期有活动 (未超阈) → none', () => {
    const t = mkTaskLit({ status: 'observing', lastExecutorActivityAt: new Date(now.getTime() - 60_000).toISOString() });
    expect(planStallNudge(t, now)).toEqual({ kind: 'none' });
  });

  it('nudgeCount≥MAX + 距上次 nudge 超阈 → escalate', () => {
    const t = mkTaskLit({ status: 'observing', lastExecutorActivityAt: old, nudgeCount: MAX_NUDGES, lastNudgeAt: old });
    expect(planStallNudge(t, now)).toEqual({ kind: 'escalate' });
  });

  it('已 nudge 但仍在 cooldown 内 → none', () => {
    const t = mkTaskLit({ status: 'observing', lastExecutorActivityAt: old, nudgeCount: 1, lastNudgeAt: new Date(now.getTime() - 60_000).toISOString() });
    expect(planStallNudge(t, now)).toEqual({ kind: 'none' });
  });

  it('blocker2：老任务 + fresh supplement(非 nudge 发起命令) + 无消息 → none (给执行者完整窗口)', () => {
    const t = mkTaskLit({ status: 'observing', createdAt: old, lastExecutorActivityAt: null });
    const freshSupplementAt = new Date(now.getTime() - 60_000).toISOString(); // 1 分钟前刚下发
    expect(planStallNudge(t, now, freshSupplementAt)).toEqual({ kind: 'none' });
    // 对照：没有 fresh 命令时 (老 createdAt) → 会 nudge
    expect(planStallNudge(t, now, null)).toEqual({ kind: 'nudge' });
  });

  it('round2：旧窗口 nudgeCount=MAX + fresh supplement 开新 episode → 窗口内 none、窗口后先 nudge 不 escalate', () => {
    const t0 = new Date('2026-06-01T00:00:00.000Z').getTime();
    const tNow = new Date(t0 + 100 * 60_000); // 100min 后
    const base = {
      status: 'observing' as const,
      createdAt: new Date(t0).toISOString(),
      lastExecutorActivityAt: new Date(t0).toISOString(),
      nudgeCount: MAX_NUDGES,
      lastNudgeAt: new Date(t0 + 10 * 60_000).toISOString(),
    };
    // fresh supplement 在 now-5min (新 episode、仍在 10min 窗口内) → none
    const supWithin = new Date(t0 + 95 * 60_000).toISOString();
    expect(planStallNudge(mkTaskLit(base), tNow, supWithin)).toEqual({ kind: 'none' });
    // fresh supplement 在 now-20min (新 episode、窗口已过) → 先 nudge（effCount 重置为 0 < MAX），不立即 escalate
    const supExpired = new Date(t0 + 80 * 60_000).toISOString();
    expect(planStallNudge(mkTaskLit(base), tNow, supExpired)).toEqual({ kind: 'nudge' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('#3 nudge / escalate 原子 helper (真 store)', () => {
  async function mkObserving(key = 'k1') {
    const t = await createSubTask({
      chatId: 'oc_sub', parentChatId: 'oc_parent', parentMessageId: 'om_src',
      goal: 'g', acceptance: null, bots: BOTS_FULL, requester: 'ou_jason', createdBy: 'claude', idempotencyKey: key,
    });
    await transitionStatus(t.taskId, 'observing');
    return getSubTask(t.taskId)!;
  }

  it('enqueueNudgeAndUpdateStats：count++ + 一条 nudge 命令(parent_to_child, targetRole=main)', async () => {
    const t = await mkObserving();
    const r = await enqueueNudgeAndUpdateStats({ taskId: t.taskId, targetChatId: t.chatId, idempotencyKey: `n-${t.taskId}-0`, expectedVersion: t.version });
    expect(r).not.toBeNull();
    const after = getSubTask(t.taskId)!;
    expect(after.nudgeCount).toBe(1);
    expect(after.lastNudgeAt).toBeTruthy();
    const nudges = listCommands(t.taskId).filter(c => c.commandType === 'nudge');
    expect(nudges.length).toBe(1);
    expect(nudges[0].direction).toBe('parent_to_child');
    expect(nudges[0].payload.targetRole).toBe('main');
  });

  it('同 idempotencyKey 第二次调用 → 幂等：不重复入队、不再 bump 计数', async () => {
    const t = await mkObserving();
    await enqueueNudgeAndUpdateStats({ taskId: t.taskId, targetChatId: t.chatId, idempotencyKey: 'same-key' });
    await enqueueNudgeAndUpdateStats({ taskId: t.taskId, targetChatId: t.chatId, idempotencyKey: 'same-key' });
    expect(listCommands(t.taskId).filter(c => c.commandType === 'nudge').length).toBe(1);
    expect(getSubTask(t.taskId)!.nudgeCount).toBe(1);
  });

  it('非 observing (reported_help) → 不发 nudge (返 null)', async () => {
    const t = await mkObserving();
    await transitionStatus(t.taskId, 'reported_help');
    const fresh = getSubTask(t.taskId)!;
    const r = await enqueueNudgeAndUpdateStats({ taskId: t.taskId, targetChatId: t.chatId, idempotencyKey: 'k-rh', expectedVersion: fresh.version });
    expect(r).toBeNull();
    expect(listCommands(t.taskId).filter(c => c.commandType === 'nudge').length).toBe(0);
  });

  it('round2：新 episode (episodeAnchorAt 新于 lastNudgeAt) → nudgeCount 重置为 1，不从旧 MAX 累加', async () => {
    const t = await mkObserving();
    await updateSubTask(t.taskId, { nudgeCount: MAX_NUDGES, lastNudgeAt: '2026-06-01T00:00:00.000Z' });
    const fresh = getSubTask(t.taskId)!;
    const r = await enqueueNudgeAndUpdateStats({
      taskId: t.taskId, targetChatId: t.chatId, idempotencyKey: 'ep-new',
      episodeAnchorAt: '2030-01-01T00:00:00.000Z', // 远新于 lastNudgeAt → 新 episode
      expectedVersion: fresh.version,
    });
    expect(r).not.toBeNull();
    expect(getSubTask(t.taskId)!.nudgeCount).toBe(1); // 重置为 1，而非 MAX+1
  });

  it('escalateStalledTask：observing→reported_help + 一条 report_help；重复调用幂等不重复', async () => {
    const t = await mkObserving();
    const r1 = await escalateStalledTask({ taskId: t.taskId, idempotencyKey: `esc-${t.taskId}`, summary: '疑似执行者断开', expectedVersion: t.version });
    expect(r1).not.toBeNull();
    expect(getSubTask(t.taskId)!.status).toBe('reported_help');
    const helps = () => listCommands(t.taskId).filter(c => c.commandType === 'report_help');
    expect(helps().length).toBe(1);
    // 重复调用 (同 key) → 不再入队第二条
    await escalateStalledTask({ taskId: t.taskId, idempotencyKey: `esc-${t.taskId}`, summary: '疑似执行者断开' });
    expect(helps().length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('#3 commitObservationTransaction.hasExecutorActivity 重置语义', () => {
  async function mkObservingWithNudge() {
    const t = await createSubTask({
      chatId: 'oc_sub', parentChatId: 'oc_parent', parentMessageId: 'om_src',
      goal: 'g', acceptance: null, bots: BOTS_FULL, requester: 'ou_jason', createdBy: 'claude', idempotencyKey: 'kk',
    });
    await transitionStatus(t.taskId, 'observing');
    await enqueueNudgeAndUpdateStats({ taskId: t.taskId, targetChatId: 'oc_sub', idempotencyKey: 'nk' });
    return getSubTask(t.taskId)!; // nudgeCount=1
  }

  it('hasExecutorActivity=true → 更新 lastExecutorActivityAt + 清 nudge 态', async () => {
    const t = await mkObservingWithNudge();
    expect(t.nudgeCount).toBe(1);
    await commitObservationTransaction({
      taskId: t.taskId, readFromCursor: null, readToCursor: 'm1', analyzedMessageIds: ['m1'],
      summary: 's', signal: 'normal', expectedVersion: t.version, hasExecutorActivity: true,
    });
    const after = getSubTask(t.taskId)!;
    expect(after.lastExecutorActivityAt).toBeTruthy();
    expect(after.nudgeCount).toBe(0);
    expect(after.lastNudgeAt).toBeNull();
  });

  it('hasExecutorActivity=false (owner nudge 回声) → 不重置 nudge 态、不动 baseline', async () => {
    const t = await mkObservingWithNudge();
    await commitObservationTransaction({
      taskId: t.taskId, readFromCursor: null, readToCursor: 'm1', analyzedMessageIds: ['m1'],
      summary: 's', signal: 'normal', expectedVersion: t.version, hasExecutorActivity: false,
    });
    const after = getSubTask(t.taskId)!;
    expect(after.nudgeCount).toBe(1);                 // 未重置
    expect(after.lastExecutorActivityAt ?? null).toBeNull(); // baseline 未被回声更新
  });
});
