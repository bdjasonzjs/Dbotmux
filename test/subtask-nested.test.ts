/**
 * 嵌套子任务编排（子群建孙群）单测：authzSpawn 鉴权矩阵 / G2-G7 闸 / depth+rootChatId 落库 /
 * 幂等键 callerChatId 前缀 / childToParentSummon 唤父群 orchestrator / finish 级联守护。
 * mock 外部依赖，真 subtask-store (temp dir)，与 subtask-orchestrator.test.ts 同骨架。
 * Run: pnpm vitest run test/subtask-nested.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;
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
  return { HttpError, authzCheck: vi.fn(), resolveBotIdent: (k: string) => idents[k] };
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
vi.mock('../src/services/main-topic-config.js', () => ({ getMainTopicChatId: () => 'oc_main' }));
vi.mock('../src/services/base-relay.js', () => ({
  DEFAULT_GROUP_NOT_FOUND_RETRY_TIMEOUT_MS: 0, sendAsOwner: vi.fn(),
}));

import { createSubtask, finishSubtask } from '../src/services/subtask-orchestrator.js';
import { childToParentSummon, parentToChildSummon } from '../src/services/outbox-dispatcher-executors.js';
import {
  createSubTask, getSubTask, transitionStatus, listCommands,
  __resetForTesting, type SubTask, type SubTaskBot, type OutboxCommand,
} from '../src/services/subtask-store.js';

const CLAUDE_MAIN: SubTaskBot[] = [
  { openId: 'ou_claude', name: '克劳德', role: 'main' },
  { openId: 'ou_coco', name: '缇蕾', role: 'observer' },
];
const CODEX_MAIN: SubTaskBot[] = [
  { openId: 'ou_codex', name: '蔻黛克斯', role: 'main' },
  { openId: 'ou_coco', name: '缇蕾', role: 'observer' },
];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** 在真 store 登记一个 observing 任务（默认：父=主话题、子群 oc_b、可裂变、depth1）。 */
async function mkTask(over: Partial<Parameters<typeof createSubTask>[0]> & { key?: string } = {}): Promise<SubTask> {
  const { key, ...rest } = over;
  const t = await createSubTask({
    chatId: 'oc_b', parentChatId: 'oc_main', parentMessageId: 'om_root',
    goal: '父任务', acceptance: null, bots: CLAUDE_MAIN, requester: 'ou_jason', createdBy: 'claude',
    idempotencyKey: key ?? `k-${Math.random().toString(36).slice(2)}`,
    depth: 1, rootChatId: 'oc_main', spawnable: true,
    ...rest,
  });
  await transitionStatus(t.taskId, 'observing');
  return getSubTask(t.taskId)!;
}

/** 子群执行者 session（嵌套 spawn 的调用方）。 */
function botSession(id: string, chatId: string, larkAppId = 'app_claude', ownerOpenId: string | undefined = 'ou_jason') {
  const s = { sessionId: id, chatId, rootMessageId: `om_${chatId}`, larkAppId, ownerOpenId, title: 't', status: 'active', createdAt: 't' };
  mockSessions.set(id, s);
  return s;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'nested-test-'));
  __resetForTesting();
  mockCreateGroup.mockReset();
  idemCache.clear();
  mockSessions.clear();
  mockCreateGroup.mockResolvedValue({ ok: true, chatId: 'oc_new', creator: 'app_claude', invalidBotIds: [], invalidUserIds: [] });
});
afterEach(() => vi.unstubAllEnvs());

// ─── authzSpawn 嵌套分支 + 落库 ──────────────────────────────────────────────
describe('嵌套 spawn：authzSpawn + depth/rootChatId 落库', () => {
  it('spawnable 子群 + 执行者(main) bot → 建孙任务：depth+1 / rootChatId 继承 / 幂等键带 callerChatId 前缀', async () => {
    vi.stubEnv('BOTMUX_SPAWN_MIN_INTERVAL_MS', '1');
    await mkTask();
    await sleep(10);
    botSession('sess_b', 'oc_b');
    mockCreateGroup.mockResolvedValueOnce({ ok: true, chatId: 'oc_c', creator: 'app_claude', invalidBotIds: [], invalidUserIds: [] });
    const res = await createSubtask({ sessionId: 'sess_b', goal: '孙任务' });
    const t = getSubTask(res.taskId)!;
    expect(t.parentChatId).toBe('oc_b');
    expect(t.depth).toBe(2);
    expect(t.rootChatId).toBe('oc_main');
    expect(t.spawnable).toBe(false);                       // 未带 --spawnable → 孙群不可再裂
    expect(t.idempotencyKey.startsWith('oc_b-om_oc_b-')).toBe(true);
    expect(listCommands(t.taskId).some(c => c.commandType === 'kickoff')).toBe(true);
  });

  it('owner 链回退：session 无 ownerOpenId → userOpenIds 用父任务 requester', async () => {
    vi.stubEnv('BOTMUX_SPAWN_MIN_INTERVAL_MS', '1');
    await mkTask();
    await sleep(10);
    botSession('sess_b', 'oc_b', 'app_claude', undefined);
    await createSubtask({ sessionId: 'sess_b', goal: '孙任务' });
    expect(mockCreateGroup.mock.calls[0][0].userOpenIds).toEqual(['ou_jason']);
  });

  it('跨 app scope 防护 (review blocker)：非 Claude 执行者建孙群 → 不用它会话的 ownerOpenId，回退父任务 requester', async () => {
    vi.stubEnv('BOTMUX_SPAWN_MIN_INTERVAL_MS', '1');
    await mkTask({ bots: CODEX_MAIN, requester: 'ou_jason_claude_scope' });
    await sleep(10);
    // codex 会话的 ownerOpenId 是 codex app 视角 id，进 Claude app 建群会邀请失败
    botSession('sess_b', 'oc_b', 'app_codex', 'ou_jason_codex_scope');
    const res = await createSubtask({ sessionId: 'sess_b', goal: '孙任务' });
    expect(mockCreateGroup.mock.calls[0][0].userOpenIds).toEqual(['ou_jason_claude_scope']);
    expect(getSubTask(res.taskId)!.requester).toBe('ou_jason_claude_scope');   // 链上 requester 恒为 Claude scope
  });

  it('跨 app scope 防护：父任务 requester 是历史占位符 owner 且非 Claude 调用 → userOpenIds 留空不传脏 id', async () => {
    vi.stubEnv('BOTMUX_SPAWN_MIN_INTERVAL_MS', '1');
    await mkTask({ bots: CODEX_MAIN, requester: 'owner' });
    await sleep(10);
    botSession('sess_b', 'oc_b', 'app_codex', 'ou_jason_codex_scope');
    await createSubtask({ sessionId: 'sess_b', goal: '孙任务' });
    expect(mockCreateGroup.mock.calls[0][0].userOpenIds).toBeUndefined();
  });

  it('G1: spawnable=false → 403', async () => {
    await mkTask({ spawnable: false });
    botSession('sess_b', 'oc_b');
    await expect(createSubtask({ sessionId: 'sess_b', goal: 'x' })).rejects.toMatchObject({ status: 403 });
  });

  it('任务非 ACTIVE (paused) → 403', async () => {
    const p = await mkTask();
    await transitionStatus(p.taskId, 'paused');
    botSession('sess_b', 'oc_b');
    await expect(createSubtask({ sessionId: 'sess_b', goal: 'x' })).rejects.toMatchObject({ status: 403 });
  });

  it('非本群执行者 bot (codex) → 403', async () => {
    await mkTask();
    botSession('sess_b', 'oc_b', 'app_codex');
    await expect(createSubtask({ sessionId: 'sess_b', goal: 'x' })).rejects.toMatchObject({ status: 403 });
  });

  it('depth 触顶 + --spawnable → 400（授权无意义，create 一锤定音直接拒）', async () => {
    vi.stubEnv('BOTMUX_SPAWN_MIN_INTERVAL_MS', '1');
    await mkTask();                      // depth=1 父，新任务 depth=2 = 默认上限
    await sleep(10);
    botSession('sess_b', 'oc_b');
    await expect(createSubtask({ sessionId: 'sess_b', goal: 'x', spawnable: true }))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining('spawnable 无意义') });
    // 不带 spawnable 仍可正常创建（只拒授权、不拒建群）
    const r = await createSubtask({ sessionId: 'sess_b', goal: 'x' });
    expect(getSubTask(r.taskId)!.spawnable).toBe(false);
  });

  it('G7: BOTMUX_NESTED_SUBTASK=0 → 403（一键回现状）', async () => {
    vi.stubEnv('BOTMUX_NESTED_SUBTASK', '0');
    await mkTask();
    botSession('sess_b', 'oc_b');
    await expect(createSubtask({ sessionId: 'sess_b', goal: 'x' })).rejects.toMatchObject({ status: 403 });
  });
});

// ─── G2-G6 fork-bomb 闸 ─────────────────────────────────────────────────────
describe('并发治理 G2-G6（只对嵌套分支）', () => {
  it('G2: depth 上限 (默认 2) → 从 depth=2 任务 spawn → 422', async () => {
    vi.stubEnv('BOTMUX_SPAWN_MIN_INTERVAL_MS', '1');
    await mkTask({ chatId: 'oc_c', parentChatId: 'oc_b', depth: 2 });
    await mkTask();   // oc_b 父链存在（防环 walk 经过）
    await sleep(10);
    botSession('sess_c', 'oc_c');
    await expect(createSubtask({ sessionId: 'sess_c', goal: 'x' })).rejects.toMatchObject({ status: 422 });
  });

  it('G3: 同父活跃子任务 ≥3 → 429', async () => {
    vi.stubEnv('BOTMUX_SPAWN_MIN_INTERVAL_MS', '1');
    vi.stubEnv('BOTMUX_MAX_ACTIVE_PER_TREE', '99');
    await mkTask();
    for (const c of ['oc_c1', 'oc_c2', 'oc_c3']) await mkTask({ chatId: c, parentChatId: 'oc_b', depth: 2, spawnable: false });
    await sleep(10);
    botSession('sess_b', 'oc_b');
    await expect(createSubtask({ sessionId: 'sess_b', goal: 'x' }))
      .rejects.toMatchObject({ status: 429, message: expect.stringContaining('children limit') });
  });

  it('G4: 树级活跃预算 → 429', async () => {
    vi.stubEnv('BOTMUX_SPAWN_MIN_INTERVAL_MS', '1');
    vi.stubEnv('BOTMUX_MAX_ACTIVE_PER_TREE', '2');
    await mkTask();
    await mkTask({ chatId: 'oc_b2', spawnable: false });   // 同树第二个活跃任务
    await sleep(10);
    botSession('sess_b', 'oc_b');
    await expect(createSubtask({ sessionId: 'sess_b', goal: 'x' }))
      .rejects.toMatchObject({ status: 429, message: expect.stringContaining('tree') });
  });

  it('G5: 全局活跃上限 → 429', async () => {
    vi.stubEnv('BOTMUX_SPAWN_MIN_INTERVAL_MS', '1');
    vi.stubEnv('BOTMUX_MAX_ACTIVE_PER_TREE', '99');
    vi.stubEnv('BOTMUX_MAX_ACTIVE_GLOBAL', '1');
    await mkTask();
    await sleep(10);
    botSession('sess_b', 'oc_b');
    await expect(createSubtask({ sessionId: 'sess_b', goal: 'x' }))
      .rejects.toMatchObject({ status: 429, message: expect.stringContaining('global') });
  });

  it('G6: 同树建群限速 (默认 60s) → 刚建完树内任务立刻 spawn → 429', async () => {
    await mkTask();   // createdAt = 刚刚 → 距今 < 60s
    botSession('sess_b', 'oc_b');
    await expect(createSubtask({ sessionId: 'sess_b', goal: 'x' }))
      .rejects.toMatchObject({ status: 429, message: expect.stringContaining('too fast') });
  });

  it('跨树幂等键不互踩：主话题与子群同 goal 同 rootMessageId → 各自建群', async () => {
    vi.stubEnv('BOTMUX_SPAWN_MIN_INTERVAL_MS', '1');
    vi.stubEnv('BOTMUX_MAX_ACTIVE_PER_TREE', '99');
    await mkTask();
    await sleep(10);
    // 两个 session rootMessageId 故意相同
    mockSessions.set('sess_main', { sessionId: 'sess_main', chatId: 'oc_main', rootMessageId: 'om_same', larkAppId: 'app_claude', ownerOpenId: 'ou_jason' });
    mockSessions.set('sess_b', { sessionId: 'sess_b', chatId: 'oc_b', rootMessageId: 'om_same', larkAppId: 'app_claude', ownerOpenId: 'ou_jason' });
    mockCreateGroup
      .mockResolvedValueOnce({ ok: true, chatId: 'oc_n1', creator: 'app_claude', invalidBotIds: [], invalidUserIds: [] })
      .mockResolvedValueOnce({ ok: true, chatId: 'oc_n2', creator: 'app_claude', invalidBotIds: [], invalidUserIds: [] });
    const a = await createSubtask({ sessionId: 'sess_main', goal: '同名任务' });
    const b = await createSubtask({ sessionId: 'sess_b', goal: '同名任务' });
    expect(a.chatId).toBe('oc_n1');
    expect(b.chatId).toBe('oc_n2');
    expect(b.isNew).toBe(true);   // 未被主话题那次 dedup
  });
});

// ─── rollup：childToParentSummon 唤父群 orchestrator ─────────────────────────
describe('childToParentSummon 唤醒对象（最小地址簿）', () => {
  const helpCmd = { cmdId: 'cmd1', commandType: 'report_help', payload: {} } as unknown as OutboxCommand;

  it('父群也是任务群 → 唤父群登记的 main bot（蔻黛克斯）', async () => {
    await mkTask({ chatId: 'oc_b', bots: CODEX_MAIN });            // 父群 oc_b 的执行者=蔻黛克斯
    const child = await mkTask({ chatId: 'oc_c', parentChatId: 'oc_b', depth: 2, spawnable: false });
    expect(childToParentSummon(helpCmd, child)).toContain('【蔻黛克斯】');
  });

  it('父=主话题（无登记）→ 回退克劳德（存量行为不变）', async () => {
    const t = await mkTask();   // parentChatId = oc_main，无任务记录
    expect(childToParentSummon(helpCmd, t)).toContain('【克劳德】');
  });
});

// ─── kickoff 文案 spawnable 提示（v1.1 §7，review P2）─────────────────────────
describe('parentToChildSummon kickoff · spawnable 提示', () => {
  const kickoffCmd = { cmdId: 'cmd_k', commandType: 'kickoff', payload: {} } as unknown as OutboxCommand;

  it('spawnable=true → kickoff 带可裂变提示', async () => {
    const t = await mkTask();
    expect(parentToChildSummon(kickoffCmd, t)).toContain('已授权可裂变');
  });

  it('spawnable 缺省/false → kickoff 文案与存量一致（不含提示）', async () => {
    const t = await mkTask({ spawnable: false });
    expect(parentToChildSummon(kickoffCmd, t)).not.toContain('已授权可裂变');
  });
});

// ─── rollup：父群 orchestrator 鉴权 + finish 级联 ────────────────────────────
describe('requireParentOrchestrator + finish 级联守护', () => {
  it('父群登记 main=蔻黛克斯 → codex session 可 finish 子任务；claude session 403', async () => {
    await mkTask({ chatId: 'oc_b', bots: CODEX_MAIN });
    const child = await mkTask({ chatId: 'oc_c', parentChatId: 'oc_b', depth: 2, spawnable: false });
    botSession('sess_claude_b', 'oc_b', 'app_claude');
    await expect(finishSubtask({ sessionId: 'sess_claude_b', taskId: child.taskId, force: true }))
      .rejects.toMatchObject({ status: 403 });
    botSession('sess_codex_b', 'oc_b', 'app_codex');
    const r = await finishSubtask({ sessionId: 'sess_codex_b', taskId: child.taskId, force: true });
    expect(r.status).toBe('finished');
  });

  it('存在 ACTIVE 后代：默认 409 列清单；--cascade 自底向上全部收尾', async () => {
    const p = await mkTask();                                                                  // oc_main → oc_b
    const c = await mkTask({ chatId: 'oc_c', parentChatId: 'oc_b', depth: 2, rootChatId: 'oc_main' });
    const d = await mkTask({ chatId: 'oc_d', parentChatId: 'oc_c', depth: 3, rootChatId: 'oc_main', spawnable: false });
    botSession('sess_main', 'oc_main', 'app_claude');
    await expect(finishSubtask({ sessionId: 'sess_main', taskId: p.taskId, force: true }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining('2 active descendant') });
    const r = await finishSubtask({ sessionId: 'sess_main', taskId: p.taskId, force: true, cascade: true });
    expect(r.status).toBe('finished');
    expect(getSubTask(c.taskId)!.status).toBe('finished');
    expect(getSubTask(d.taskId)!.status).toBe('finished');
    // 每个后代都有自己的 finish 命令（幂等键 finish-<taskId>）
    expect(listCommands(c.taskId).some(x => x.commandType === 'finish')).toBe(true);
    expect(listCommands(d.taskId).some(x => x.commandType === 'finish')).toBe(true);
  });

  it('无后代 → finish 行为与存量一致（不误拦）', async () => {
    const p = await mkTask({ spawnable: false });
    botSession('sess_main', 'oc_main', 'app_claude');
    const r = await finishSubtask({ sessionId: 'sess_main', taskId: p.taskId, force: true });
    expect(r.status).toBe('finished');
  });
});
