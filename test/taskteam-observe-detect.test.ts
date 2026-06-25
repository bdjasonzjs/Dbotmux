import { describe, it, expect } from 'vitest';
import {
  makeTaskTeamObserveExecutors,
  mapBehaviorToEvent,
  isCursorGoneError,
  type TaskTeamJudgeFn,
  type TaskTeamFetchSinceFn,
  type TaskTeamDetectedBehavior,
} from '../src/services/taskteam-observe-executors.js';
import {
  runTaskTeamObserverTick,
  TaskTeamCursorInvalidError,
  type TaskTeamObserverDeps,
  type TaskTeamObserverExecutors,
} from '../src/services/taskteam-observer.js';
import type { TaskTeamInstance } from '../src/services/taskteam-schema.js';

// 真实长度 open_id（35 字符）——架构 review 点：短 id 测试盖不住截断失配。
const DEV_OID = 'ou_974b9321334628537abee157413b33b6';
const REV_OID = 'ou_a872ed452a4f6d242e8f3e34eccdaae3';

// ── fixture：开发者席 R1(bot DEV_OID) + 审查者席 R2(bot REV_OID) ─────────────
function instanceFixture(over: Partial<TaskTeamInstance> = {}): TaskTeamInstance {
  return {
    teamId: 'tt_team_demo',
    typeId: 'tt_type_demo',
    companyId: 'tt_company_demo',
    chatId: 'oc_chat_demo',
    goal: '实现 detect()',
    acceptance: '单测通过',
    roleInstances: [
      { roleInstanceId: 'tt_ri_dev', slotId: 'tt_slot_dev', roleId: 'tt_role_developer',
        binding: { bindingId: 'tt_binding_dev', botOpenId: DEV_OID, larkAppId: 'cli_dev' } },
      { roleInstanceId: 'tt_ri_rev', slotId: 'tt_slot_rev', roleId: 'tt_role_reviewer',
        binding: { bindingId: 'tt_binding_rev', botOpenId: REV_OID, larkAppId: 'cli_rev' } },
    ],
    status: 'running',
    progress: '进行中',
    reviewState: { round: 1, reworkCount: 0, votes: [] },
    cursor: 'om_cursor',
    version: 3,
    createdAt: '2026-06-21T00:00:00.000Z',
    updatedAt: '2026-06-21T00:00:00.000Z',
    ...over,
  };
}

// 默认增量：dev 发的 + rev 发的，最后一条 id=om_2（已读边界）
const twoMsgs: TaskTeamFetchSinceFn = async () => ({
  messages: [
    { id: 'om_1', text: '我提交了 MR', senderId: DEV_OID },
    { id: 'om_2', text: '我看过了，打回', senderId: REV_OID },
  ],
});

function execWith(judge: TaskTeamJudgeFn, fetchSince: TaskTeamFetchSinceFn = twoMsgs) {
  return makeTaskTeamObserveExecutors('cli_observer', { judge, fetchSince });
}

describe('taskteam detect() — 别名归因 + 已读边界 cursor', () => {
  it('judge 用别名 by:R1/R2 → 映射成带 fromRoleInstanceId/fromSlotId 的 TeamEvent（真实长 open_id 也归因正确）', async () => {
    const judge: TaskTeamJudgeFn = async () => [
      { type: 'submit', by: 'R1', reason: '提交了 MR' },
      { type: 'review-reject', by: 'R2' },
    ];
    const res = await execWith(judge).detect(instanceFixture(), 'om_cursor');
    expect(res.cursor).toBe('om_2');
    expect(res.events).toEqual([
      { type: 'submit', fromRoleInstanceId: 'tt_ri_dev', fromSlotId: 'tt_slot_dev', reason: '提交了 MR' },
      { type: 'review-reject', fromRoleInstanceId: 'tt_ri_rev', fromSlotId: 'tt_slot_rev' },
    ]);
  });

  it('渲染给 judge 的消息用短别名 [R1]/[R2] 前缀，绝不出现（截断的）真实 open_id', async () => {
    let seen: any;
    await execWith(async (ctx) => { seen = ctx; return []; }).detect(instanceFixture(), 'om_cursor');
    expect(seen.newMessages).toContain('[R1] 我提交了 MR');
    expect(seen.newMessages).toContain('[R2] 我看过了，打回');
    expect(seen.newMessages).not.toContain(DEV_OID);
    expect(seen.newMessages).not.toContain(DEV_OID.slice(0, 16)); // 截断片段也不该出现
    expect(seen.roster.map((r: any) => r.alias)).toEqual(['R1', 'R2']);
  });

  it('配置 targetExternalChatId 时 detect 从外部群读取增量，cursor 仍按实例推进', async () => {
    const seen: Array<{ chatId: string; cursor: string | null }> = [];
    const fetchSince: TaskTeamFetchSinceFn = async (chatId, cursor) => {
      seen.push({ chatId, cursor });
      return { messages: [{ id: 'om_ext_1', text: '外部群新消息', senderId: DEV_OID }] };
    };
    const res = await execWith(async () => [], fetchSince)
      .detect(instanceFixture({ targetExternalChatId: 'oc_external' }), 'om_cursor');

    expect(seen).toEqual([{ chatId: 'oc_external', cursor: 'om_cursor' }]);
    expect(res).toEqual({ events: [], cursor: 'om_ext_1' });
  });

  it('by 兼容直接给 roleInstanceId / slotId', async () => {
    const judge: TaskTeamJudgeFn = async () => [
      { type: 'submit', by: 'tt_ri_dev' },
      { type: 'report', by: 'tt_slot_rev' },
    ];
    const res = await execWith(judge).detect(instanceFixture(), 'om_cursor');
    expect(res.events).toEqual([
      { type: 'submit', fromRoleInstanceId: 'tt_ri_dev', fromSlotId: 'tt_slot_dev' },
      { type: 'report', fromRoleInstanceId: 'tt_ri_rev', fromSlotId: 'tt_slot_rev' },
    ]);
  });

  it('stall 团队级可不带归因仍保留', async () => {
    const res = await execWith(async () => [{ type: 'stall', reason: '原地打转' }]).detect(instanceFixture(), 'om_cursor');
    expect(res.events).toEqual([{ type: 'stall', reason: '原地打转' }]);
  });

  it('未知 type（生命周期/非法）丢弃，cursor 仍推进', async () => {
    const judge: TaskTeamJudgeFn = async () => [
      { type: 'team-started', by: 'R1' },
      { type: 'accept', by: 'R1' },
      { type: 'garbage', by: 'R1' },
      { type: 'submit', by: 'R1' },
    ];
    const res = await execWith(judge).detect(instanceFixture(), 'om_cursor');
    expect(res.events).toEqual([{ type: 'submit', fromRoleInstanceId: 'tt_ri_dev', fromSlotId: 'tt_slot_dev' }]);
    expect(res.cursor).toBe('om_2');
  });

  it('归因不到角色的非 stall 行为丢弃（by 越界/ext/缺失），cursor 仍推进', async () => {
    const judge: TaskTeamJudgeFn = async () => [
      { type: 'submit', by: 'R9' }, // 越界
      { type: 'submit', by: 'ext' }, // 非角色
      { type: 'submit' }, // 缺归因
    ];
    const res = await execWith(judge).detect(instanceFixture(), 'om_cursor');
    expect(res.events).toEqual([]);
    expect(res.cursor).toBe('om_2');
  });

  it('judge 判出无行为（返 []）→ events:[]、cursor 推进', async () => {
    const res = await execWith(async () => []).detect(instanceFixture(), 'om_cursor');
    expect(res).toEqual({ events: [], cursor: 'om_2' });
  });

  it('无增量 → events:[]、cursor 不变、且不调 judge', async () => {
    let judged = false;
    const judge: TaskTeamJudgeFn = async () => { judged = true; return []; };
    const res = await makeTaskTeamObserveExecutors('cli_observer', { judge, fetchSince: async () => ({ messages: [] }) })
      .detect(instanceFixture(), 'om_cursor');
    expect(res).toEqual({ events: [], cursor: 'om_cursor' });
    expect(judged).toBe(false);
  });

  // ── 失败语义（P1#1）：瞬时失败抛错（tick 持 cursor 重试），绝不静默推进 ────────
  it('judge 返 null（LLM/parse 失败）→ 抛错', async () => {
    await expect(execWith(async () => null).detect(instanceFixture(), 'om_cursor')).rejects.toThrow();
  });
  it('judge 抛错 → 抛错传播', async () => {
    await expect(execWith(async () => { throw new Error('coco 崩了'); }).detect(instanceFixture(), 'om_cursor'))
      .rejects.toThrow('coco 崩了');
  });
  it('fetchSince 瞬时 IO 失败 → 抛错且不调 judge', async () => {
    let judged = false;
    const judge: TaskTeamJudgeFn = async () => { judged = true; return []; };
    const fetchSince: TaskTeamFetchSinceFn = async () => { throw new Error('IO 失败'); };
    await expect(execWith(judge, fetchSince).detect(instanceFixture(), 'om_cursor')).rejects.toThrow('IO 失败');
    expect(judged).toBe(false);
  });
});

describe('mapBehaviorToEvent — 纯映射单元', () => {
  const inst = instanceFixture();
  it('别名 R1 → roleInstances[0]（真实长 open_id 无关，按位置解析）', () => {
    expect(mapBehaviorToEvent(inst, { type: 'submit', by: 'R1' }))
      .toEqual({ type: 'submit', fromRoleInstanceId: 'tt_ri_dev', fromSlotId: 'tt_slot_dev' });
  });
  it('未知 type → null', () => {
    expect(mapBehaviorToEvent(inst, { type: 'team-started', by: 'R1' } as TaskTeamDetectedBehavior)).toBeNull();
  });
  it('非 stall 且 by 越界 → null', () => {
    expect(mapBehaviorToEvent(inst, { type: 'report', by: 'R9' })).toBeNull();
  });
  it('stall 无归因 → 保留', () => {
    expect(mapBehaviorToEvent(inst, { type: 'stall' })).toEqual({ type: 'stall' });
  });
});

describe('isCursorGoneError — cursor 永久失效错误码识别', () => {
  it('230011（message withdrawn）→ true（getMessageDetail 抛的 (code: NNN) 串可解析）', () => {
    expect(isCursorGoneError(new Error('Failed to get message: withdrawn (code: 230011)'))).toBe(true);
  });
  it('瞬时/其它错误 → false（让 tick 持 cursor 重试）', () => {
    expect(isCursorGoneError(new Error('network ETIMEDOUT'))).toBe(false);
    expect(isCursorGoneError(new Error('Failed to get message: x (code: 99999)'))).toBe(false);
    expect(isCursorGoneError('plain string')).toBe(false);
  });
});

// ── tick 级：cursor 推进语义（P1#1 持窗重试 / P1#2 已读边界 / 失效跳最新）────────
describe('runTaskTeamObserverTick — cursor 推进语义', () => {
  function fakeDeps(team: TaskTeamInstance, advanced: Array<{ teamId: string; cursor: string }>): TaskTeamObserverDeps {
    return {
      listActiveTeams: () => [team],
      advanceCursor: async (teamId: string, cursor: string) => { advanced.push({ teamId, cursor }); },
    } as unknown as TaskTeamObserverDeps;
  }
  function fakeExec(
    peekResult: { hasNew: boolean; cursor: string | null },
    detectImpl: TaskTeamObserverExecutors['detect'],
  ): TaskTeamObserverExecutors {
    return { peek: async () => peekResult, detect: detectImpl };
  }

  it('P1#2 busy 群：cursor 推到 detect 已读边界(om_40)，而非 peek 最新(om_100)', async () => {
    const advanced: Array<{ teamId: string; cursor: string }> = [];
    const exec = fakeExec({ hasNew: true, cursor: 'om_100' }, async () => ({ events: [], cursor: 'om_40' }));
    const stats = await runTaskTeamObserverTick(new Date(0), fakeDeps(instanceFixture(), advanced), exec);
    expect(advanced).toEqual([{ teamId: 'tt_team_demo', cursor: 'om_40' }]);
    expect(stats.detected).toBe(1);
  });

  it('P1#1 瞬时失败：detect 抛错 → cursor 不推进（持窗重试）、errors=1', async () => {
    const advanced: Array<{ teamId: string; cursor: string }> = [];
    const exec = fakeExec({ hasNew: true, cursor: 'om_100' }, async () => { throw new Error('瞬时 LLM 失败'); });
    const stats = await runTaskTeamObserverTick(new Date(0), fakeDeps(instanceFixture(), advanced), exec);
    expect(advanced).toEqual([]);
    expect(stats.errors).toBe(1);
  });

  it('cursor 失效：detect 抛 TaskTeamCursorInvalidError → 跳到 peek 最新(om_100) 避免卡死', async () => {
    const advanced: Array<{ teamId: string; cursor: string }> = [];
    const exec = fakeExec({ hasNew: true, cursor: 'om_100' }, async () => { throw new TaskTeamCursorInvalidError('gone'); });
    const stats = await runTaskTeamObserverTick(new Date(0), fakeDeps(instanceFixture(), advanced), exec);
    expect(advanced).toEqual([{ teamId: 'tt_team_demo', cursor: 'om_100' }]);
    expect(stats.errors).toBe(1);
  });

  it('廉价 gate（无新动静）→ 不调 detect、不推进、gatedOut=1', async () => {
    const advanced: Array<{ teamId: string; cursor: string }> = [];
    let detectCalled = false;
    const exec = fakeExec({ hasNew: false, cursor: 'om_cursor' }, async () => { detectCalled = true; return { events: [], cursor: null }; });
    const stats = await runTaskTeamObserverTick(new Date(0), fakeDeps(instanceFixture(), advanced), exec);
    expect(detectCalled).toBe(false);
    expect(advanced).toEqual([]);
    expect(stats.gatedOut).toBe(1);
  });
});
