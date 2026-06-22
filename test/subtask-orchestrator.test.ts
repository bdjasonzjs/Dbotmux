/**
 * Unit tests for subtask-orchestrator (Phase 4 service 层)。
 * mock 外部依赖 (authzCheck/resolveBotIdent/group-creator/idempotency/session-store)，
 * 真 subtask-store (temp dir)。覆盖 6 边界 + 鉴权分层。
 * Run: pnpm vitest run test/subtask-orchestrator.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;
const mockAuthzCheck = vi.fn();
const mockCreateGroup = vi.fn();
const mockEnsureCloneScopesProvisioned = vi.fn();
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
  const idents: Record<string, { larkAppId: string; openId: string; name: string }> = {
    claude: { larkAppId: 'app_claude', openId: 'ou_claude', name: '克劳德' },
    codex: { larkAppId: 'app_codex', openId: 'ou_codex', name: '蔻黛克斯' },
    tilly: { larkAppId: 'app_coco', openId: 'ou_coco', name: '缇蕾' },
    app_claude: { larkAppId: 'app_claude', openId: 'ou_claude', name: '克劳德' },
    app_codex: { larkAppId: 'app_codex', openId: 'ou_codex', name: '蔻黛克斯' },
    app_coco: { larkAppId: 'app_coco', openId: 'ou_coco', name: '缇蕾' },
    // a registered clone referenced by name/appId (N-bot)
    'claude-clone': { larkAppId: 'app_clone', openId: 'ou_clone', name: 'claude-clone' },
    'app_new': { larkAppId: 'app_new', openId: 'ou_new', name: 'NewBot' },
    'new-engine': { larkAppId: 'app_new', openId: 'ou_new', name: 'NewBot' },
  };
  // Mirror real resolveBotIdent: built-in aliases (c/k/t + full names, any case)
  // canonicalize first; unknown ref throws (→ orchestrator maps to 400).
  const ALIAS: Record<string, string> = {
    claude: 'claude', c: 'claude', codex: 'codex', k: 'codex', tilly: 'tilly', t: 'tilly',
  };
  const resolveBotIdent = (k: string) => {
    const v = idents[ALIAS[k.toLowerCase()] ?? k];
    if (!v) throw new HttpError(500, `bot ref "${k}" not found`);
    return v;
  };
  return { HttpError, authzCheck: (...a: any[]) => mockAuthzCheck(...a), resolveBotIdent };
});
vi.mock('../src/services/group-creator.js', () => ({ createGroupWithBots: (...a: any[]) => mockCreateGroup(...a) }));
vi.mock('../src/services/clone-scope-provisioning.js', () => ({
  ensureCloneScopesProvisioned: (...a: any[]) => mockEnsureCloneScopesProvisioned(...a),
}));
vi.mock('../src/services/spawn-idempotency-store.js', () => ({
  getOrCompute: async (key: string, compute: () => Promise<any>) => {
    if (idemCache.has(key)) return { entry: idemCache.get(key), cacheHit: true };
    const entry = await compute();
    idemCache.set(key, entry);
    return { entry, cacheHit: false };
  },
}));
vi.mock('../src/services/session-store.js', () => ({
  getSession: (id: string) => mockSessions.get(id),
  findActiveChatScopeSessionsByChat: (chatId: string) => Array.from(mockSessions.values()).filter((s: any) => s.chatId === chatId && s.status === 'active' && s.scope === 'chat'),
}));
// 嵌套改造后 createSubtask 走内部 authzSpawn（authzCheck 不再被 v2 调用）：主话题判定靠 main-topic-config。
vi.mock('../src/services/main-topic-config.js', () => ({
  getMainTopicChatId: () => 'oc_main',
  getMainTopicBotRef: () => 'claude',
  getCompanyByRootChatId: () => null,
}));

import {
  createSubtask, adoptSubtask, reportProgress, querySubtask, finishSubtask, supplementSubtask, requestReview, V2_MARKER,
} from '../src/services/subtask-orchestrator.js';
import {
  createSubTask, getSubTask, getByChatId, transitionStatus, enqueueCommand, listCommands,
  getCommand, listObservations, __resetForTesting, ackCommand, type SubTaskBot,
} from '../src/services/subtask-store.js';
import { create as createChatContext, read as readChatContext } from '../src/services/chat-context-store.js';
import { readTopology } from '../src/services/chat-topology-store.js';

const BOTS: SubTaskBot[] = [
  { openId: 'ou_claude', name: '克劳德', role: 'main' },
  { openId: 'ou_coco', name: '缇蕾', role: 'observer' },
];
/** 含 reviewer(collab) 的 bots —— request_review 需要有 reviewer 可唤。 */
const BOTS_WITH_REVIEWER: SubTaskBot[] = [
  { openId: 'ou_claude', name: '克劳德', role: 'main' },
  { openId: 'ou_codex', name: '蔻黛克斯', role: 'collab' },
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
  mockEnsureCloneScopesProvisioned.mockReset();
  mockEnsureCloneScopesProvisioned.mockResolvedValue(undefined);
  delete process.env.BOTS_CONFIG;
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
    expect(groupOpts.userOpenIds).toEqual(['ou_jason']);
    // 边界2: 登记进 store + observing
    const task = getSubTask(res.taskId)!;
    expect(task.status).toBe('observing');
    expect(task.parentChatId).toBe('oc_main');
    expect(task.chatId).toBe('oc_sub_new');
    expect(getByChatId('oc_sub_new')!.taskId).toBe(res.taskId); // getByChatId 命中 = 归新 observer
  });

  // 块7 第三轮 #1 owner-visibility 不变量（蔻黛 守点5）：子群必须邀请 owner，否则 CEO
  // 把 scope auth 链接发进子群时 owner 看不见。若此邀请被改掉，本测试炸。
  it('[#1 owner-visibility] subgroup invites the owner (auth link must be visible to them)', async () => {
    mainSession();
    await createSubtask({ sessionId: 'sess_main', goal: 'owner visibility lock' });
    const groupOpts = mockCreateGroup.mock.calls[0][0];
    expect(groupOpts.userOpenIds).toContain('ou_jason'); // owner invited → in the subgroup
  });

  it('N-bot: --bots 引 clone (按 name) → larkAppIds/participants/store 带 clone, role=collab, 记 larkAppId', async () => {
    mainSession();
    const res = await createSubtask({ sessionId: 'sess_main', goal: 'n-bot clone test', bots: ['claude', 'claude-clone'] });
    const groupOpts = mockCreateGroup.mock.calls[0][0];
    expect(groupOpts.larkAppIds).toEqual(['app_claude', 'app_clone', 'app_coco']);
    expect(groupOpts.chatContext.participants).toEqual([
      { openId: 'ou_claude', role: 'main' },     // alias 保留 BOT_META role
      { openId: 'ou_clone', role: 'collab' },     // 任意 ref 默认 collab
      { openId: 'ou_coco', role: 'observer' },    // executor 群自动补 observer，保证 observing 能回读
    ]);
    const task = getByChatId(res.chatId)!;
    expect(task.bots.find((b: any) => b.openId === 'ou_clone')).toMatchObject({
      name: 'claude-clone', role: 'collab', larkAppId: 'app_clone',
    });
    expect(task.bots.find((b: any) => b.openId === 'ou_coco')).toMatchObject({
      name: '缇蕾', role: 'observer', larkAppId: 'app_coco',
    });
  });

  it('dry-run: 只返回建群前席位预览，不建群、不写 store、不发 kickoff', async () => {
    mainSession();
    const botsConfigPath = join(tempDir, 'bots.json');
    process.env.BOTS_CONFIG = botsConfigPath;
    writeFileSync(botsConfigPath, JSON.stringify([
      { larkAppId: 'app_codex', cliId: 'codex', displayName: '蔻黛克斯' },
      { larkAppId: 'app_clone', cliId: 'codex', displayName: '蔻黛克斯初号机', claudeConfigDir: '/tmp/clone/.codex' },
      { larkAppId: 'app_coco', cliId: 'coco', displayName: '缇蕾' },
    ]), 'utf-8');

    const res = await createSubtask({
      sessionId: 'sess_main',
      goal: 'dry run preview',
      name: 'Dry Run Preview',
      taskType: 'bug',
      bots: ['codex:main', 'claude-clone:collab'],
      dryRun: true,
    });

    expect(res).toMatchObject({
      dryRun: true,
      preview: {
        name: 'Dry Run Preview',
        taskType: 'bug',
        worktree: null,
        writes: [],
        willCreateGroup: false,
      },
    });
    expect((res as any).preview.seats).toEqual([
      expect.objectContaining({ seat: 'main', ref: 'codex', botName: '蔻黛克斯', engine: 'codex', role: 'main', larkAppId: 'app_codex' }),
      expect.objectContaining({ seat: 'collab', ref: 'claude-clone', botName: 'claude-clone', cloneName: '蔻黛克斯初号机', engine: 'codex', role: 'collab', larkAppId: 'app_clone' }),
      expect.objectContaining({ seat: 'observer', ref: 'tilly', botName: '缇蕾', engine: 'coco', role: 'observer', larkAppId: 'app_coco' }),
    ]);
    expect(mockEnsureCloneScopesProvisioned).not.toHaveBeenCalled();
    expect(mockCreateGroup).not.toHaveBeenCalled();
    expect(getByChatId('oc_sub_new')).toBeNull();
    expect(readChatContext('oc_sub_new')).toBeNull();
    expect(readTopology().nodes).toEqual([]);
  });

  it('clone scope gate: 缺 required scope 时阻断建群, 不静默 createGroupWithBots', async () => {
    mainSession();
    mockEnsureCloneScopesProvisioned.mockRejectedValue(Object.assign(new Error('missing clone scope'), { status: 403 }));
    await expect(createSubtask({ sessionId: 'sess_main', goal: 'clone scope gate', bots: ['claude-clone:main'] }))
      .rejects.toMatchObject({ status: 403 });
    expect(mockEnsureCloneScopesProvisioned).toHaveBeenCalledWith({
      creatorLarkAppId: 'app_claude',
      chatId: 'oc_main',
      bots: [
        { larkAppId: 'app_clone', name: 'claude-clone', role: 'main' },
        { larkAppId: 'app_coco', name: '缇蕾', role: 'observer' },
      ],
    });
    expect(mockCreateGroup).not.toHaveBeenCalled();
  });

  it('alias role/name 兼容: bots 用短码 c/k/t 与大写 CLAUDE → 保留 main/collab/observer 不降级', async () => {
    mainSession();
    const res = await createSubtask({ sessionId: 'sess_main', goal: 'alias role test', bots: ['c', 'k', 't'] });
    const groupOpts = mockCreateGroup.mock.calls[0][0];
    expect(groupOpts.chatContext.participants).toEqual([
      { openId: 'ou_claude', role: 'main' },      // c → claude 本体, NOT demoted to collab
      { openId: 'ou_codex', role: 'collab' },
      { openId: 'ou_coco', role: 'observer' },
    ]);
    const task = getByChatId(res.chatId)!;
    expect(task.bots.map((b: any) => [b.name, b.role])).toEqual([
      ['克劳德', 'main'], ['蔻黛克斯', 'collab'], ['缇蕾', 'observer'],
    ]);
  });

  it('alias 大小写不敏感: bots:[CLAUDE] → claude 本体 main', async () => {
    mainSession();
    const res = await createSubtask({ sessionId: 'sess_main', goal: 'uppercase alias', bots: ['CLAUDE'] });
    const task = getByChatId(res.chatId)!;
    expect(task.bots.map((b: any) => [b.name, b.role])).toEqual([
      ['克劳德', 'main'], ['缇蕾', 'observer'],
    ]);
  });

  it('6b: --bots ref:role 显式角色覆盖默认 (claude:observer, clone:main)', async () => {
    mainSession();
    const res = await createSubtask({ sessionId: 'sess_main', goal: '6b role override', bots: ['claude:observer', 'claude-clone:main'] });
    const task = getByChatId(res.chatId)!;
    expect(task.bots.find((b: any) => b.openId === 'ou_claude')).toMatchObject({ role: 'observer', name: '克劳德' }); // 显式 observer 覆盖默认 main
    expect(task.bots.find((b: any) => b.openId === 'ou_clone')).toMatchObject({ role: 'main', larkAppId: 'app_clone' }); // clone 显式 main
  });

  it('6b: 非法 role → 400', async () => {
    mainSession();
    await expect(createSubtask({ sessionId: 'sess_main', goal: '6b bad role', bots: ['claude:boss'] }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('P1④: --bots auto-clone 语法 → 清晰 400 指引, 不建群', async () => {
    mainSession();
    await expect(createSubtask({ sessionId: 'sess_main', goal: 'auto clone unsupported', bots: ['auto@codex:collab:初号机'] }))
      .rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('subtask-start --bots does not support auto-clone syntax'),
      });
    await expect(createSubtask({ sessionId: 'sess_main', goal: 'auto clone unsupported 2', bots: ['auto:collab'] }))
      .rejects.toThrow(/ceo-spawn --seats/);
    await expect(createSubtask({ sessionId: 'sess_main', goal: 'auto clone unsupported 3', bots: ['auto@codex:collab'] }))
      .rejects.toThrow(/appId\/name/);
    expect(mockCreateGroup).not.toHaveBeenCalled();
  });

  it('6b: 无 :role 后缀 → 默认角色不变 (claude→main)', async () => {
    mainSession();
    const res = await createSubtask({ sessionId: 'sess_main', goal: '6b no role', bots: ['claude'] });
    expect(getByChatId(res.chatId)!.bots.map((b: any) => [b.name, b.role])).toEqual([
      ['克劳德', 'main'], ['缇蕾', 'observer'],
    ]);
  });

  it('P0⑥: 显式 --bots 含 main 但无 observer → executor 群自动补 tilly:observer', async () => {
    mainSession();
    const res = await createSubtask({ sessionId: 'sess_main', goal: 'force observer', bots: ['codex:main', 'claude-clone:collab'] });
    const groupOpts = mockCreateGroup.mock.calls[0][0];
    expect(groupOpts.larkAppIds).toEqual(['app_codex', 'app_clone', 'app_coco']);
    expect(groupOpts.chatContext.participants).toEqual([
      { openId: 'ou_codex', role: 'main' },
      { openId: 'ou_clone', role: 'collab' },
      { openId: 'ou_coco', role: 'observer' },
    ]);
    expect(getByChatId(res.chatId)!.bots.map((b: any) => [b.openId, b.role, b.larkAppId])).toEqual([
      ['ou_codex', 'main', 'app_codex'],
      ['ou_clone', 'collab', 'app_clone'],
      ['ou_coco', 'observer', 'app_coco'],
    ]);
  });

  it('P0⑥ P1: 非 tilly observer 不能替代 coco 回读身份，仍自动补 tilly:observer', async () => {
    mainSession();
    const res = await createSubtask({ sessionId: 'sess_main', goal: 'non tilly observer', bots: ['codex:main', 'claude:observer'] });
    const groupOpts = mockCreateGroup.mock.calls[0][0];
    expect(groupOpts.larkAppIds).toEqual(['app_codex', 'app_claude', 'app_coco']);
    expect(groupOpts.chatContext.participants).toEqual([
      { openId: 'ou_codex', role: 'main' },
      { openId: 'ou_claude', role: 'observer' },
      { openId: 'ou_coco', role: 'observer' },
    ]);
    expect(getByChatId(res.chatId)!.bots.map((b: any) => [b.openId, b.role, b.larkAppId])).toEqual([
      ['ou_codex', 'main', 'app_codex'],
      ['ou_claude', 'observer', 'app_claude'],
      ['ou_coco', 'observer', 'app_coco'],
    ]);
  });

  it('P0⑥: noObserver 显式 opt-out 时不自动补 observer', async () => {
    mainSession();
    const res = await createSubtask({ sessionId: 'sess_main', goal: 'no observer by choice', bots: ['codex:main', 'claude-clone:collab'], noObserver: true });
    const groupOpts = mockCreateGroup.mock.calls[0][0];
    expect(groupOpts.larkAppIds).toEqual(['app_codex', 'app_clone']);
    expect(groupOpts.chatContext.participants).toEqual([
      { openId: 'ou_codex', role: 'main' },
      { openId: 'ou_clone', role: 'collab' },
    ]);
    expect(getByChatId(res.chatId)!.bots.some((b: any) => b.role === 'observer')).toBe(false);
  });

  it('P0⑥: 没有 main 席位时不强加 observer', async () => {
    mainSession();
    const res = await createSubtask({ sessionId: 'sess_main', goal: 'discussion only', bots: ['claude-clone:collab'] });
    const groupOpts = mockCreateGroup.mock.calls[0][0];
    expect(groupOpts.larkAppIds).toEqual(['app_clone']);
    expect(groupOpts.chatContext.participants).toEqual([
      { openId: 'ou_clone', role: 'collab' },
    ]);
    expect(getByChatId(res.chatId)!.bots).toHaveLength(1);
  });

  it('v3 kickoff: create 后 enqueue 一条 kickoff (parent→child, 投子群, 幂等不重复)', async () => {
    mainSession();
    const res = await createSubtask({ sessionId: 'sess_main', goal: '修登录 bug', taskType: 'bug' });
    const kickoff = listCommands(res.taskId).find(c => c.commandType === 'kickoff');
    expect(kickoff).toBeTruthy();
    expect(kickoff!.direction).toBe('parent_to_child');
    expect(kickoff!.targetChatId).toBe('oc_sub_new');         // 投子群唤执行 bot
    await createSubtask({ sessionId: 'sess_main', goal: '修登录 bug', taskType: 'bug' }); // cacheHit
    expect(listCommands(res.taskId).filter(c => c.commandType === 'kickoff')).toHaveLength(1);
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

  it('任意注册 bot root session 可创建子任务；Codex root 自动成为 main', async () => {
    createChatContext('oc_unknown', {
      purpose: 'Company root: test',
      originType: 'bot_spawned',
      parentChatId: null,
    });
    mockSessions.set('sess_x', { sessionId: 'sess_x', chatId: 'oc_unknown', rootMessageId: 'om_x', larkAppId: 'app_codex', ownerOpenId: 'ou_jason' });
    const res = await createSubtask({ sessionId: 'sess_x', goal: 'x' });
    const task = getSubTask(res.taskId)!;
    expect(task.parentChatId).toBe('oc_unknown');
    expect(task.rootChatId).toBe('oc_unknown');
    expect(task.bots.find(b => b.larkAppId === 'app_codex')?.role).toBe('main');

    mockSessions.set('sess_bad', { sessionId: 'sess_bad', chatId: 'oc_other', rootMessageId: 'om_bad', larkAppId: 'app_codex', ownerOpenId: 'ou_jason' });
    await expect(createSubtask({ sessionId: 'sess_bad', goal: 'x' })).rejects.toMatchObject({ status: 403 });
  });

  it('缺 goal → 400', async () => {
    mainSession();
    await expect(createSubtask({ sessionId: 'sess_main', goal: '  ' })).rejects.toMatchObject({ status: 400 });
  });
});

// ─── adopt_subtask ───────────────────────────────────────────────────────────
describe('adoptSubtask', () => {
  it('默认 dry-run：只返回计划，不写 SubTask/ChatContext/Topology', async () => {
    subSession('sess_k_root', 'oc_main', 'app_codex');
    const res = await adoptSubtask({
      sessionId: 'sess_k_root',
      chatId: 'oc_adopt',
      goal: '承接现有基建任务',
      mode: 'manager',
      bots: ['codex', 'claude', 'tilly'],
      taskType: 'misc',
      relatedRefs: ['doc://plan'],
    });

    expect(res.dryRun).toBe(true);
    expect(res.chatId).toBe('oc_adopt');
    expect(res.plan.parentChatId).toBe('oc_main');
    expect(res.plan.rootChatId).toBe('oc_main');
    expect(res.plan.depth).toBe(1);
    expect(res.plan.reportingMode).toBe('manager');
    expect(res.plan.relatedRefs).toEqual(['doc://plan']);
    expect(res.plan.bots.find(b => b.openId === 'ou_codex')?.role).toBe('main');
    expect(res.plan.idempotencyKey).toContain('oc_main-oc_adopt-adopt-');
    expect(res.plan.writes).toEqual(['subtasks.json', 'chat-contexts/<chatId>.json', 'chat-topology.json']);
    expect(res.plan.warnings).toEqual([]);
    expect(getByChatId('oc_adopt')).toBeNull();
    expect(readChatContext('oc_adopt')).toBeNull();
    expect(readTopology().nodes.find(n => n.chatId === 'oc_adopt')).toBeUndefined();
  });

  it('--commit：同时写 SubTask、ChatContext、ChatTopology', async () => {
    subSession('sess_k_root', 'oc_main', 'app_codex');
    const res = await adoptSubtask({
      sessionId: 'sess_k_root',
      chatId: 'oc_adopt',
      goal: '承接现有基建任务',
      mode: 'executor',
      bots: ['codex', 'claude', 'tilly'],
      taskType: 'misc',
      relatedRefs: ['doc://plan'],
      commit: true,
    });

    expect(res.dryRun).toBe(false);
    expect(res.status).toBe('observing');
    const task = getByChatId('oc_adopt')!;
    expect(task.taskId).toBe(res.taskId);
    expect(task.parentChatId).toBe('oc_main');
    expect(task.rootChatId).toBe('oc_main');
    expect(task.depth).toBe(1);
    expect(task.reportingMode).toBe('executor');
    expect(task.bots.find(b => b.openId === 'ou_codex')?.role).toBe('main');

    const ctx = readChatContext('oc_adopt')!;
    expect(ctx.originType).toBe('bot_spawned');
    expect(ctx.inheritedFrom?.parentChatId).toBe('oc_main');
    expect(ctx.relatedRefs).toContain(V2_MARKER);
    expect(ctx.relatedRefs).toContain('adopted-subtask');
    expect(ctx.relatedRefs).toContain('doc://plan');
    expect(ctx.taskType).toBe('misc');

    const topo = readTopology();
    expect(topo.nodes.find(n => n.chatId === 'oc_adopt')?.parentChatId).toBe('oc_main');
    expect(topo.edges).toContainEqual(expect.objectContaining({
      type: 'parent_child',
      fromChatId: 'oc_main',
      toChatId: 'oc_adopt',
    }));
  });

  it('同 idempotencyKey 重放 --commit → 返回既有结果，并补齐 crash 后缺失的 ChatContext/Topology', async () => {
    subSession('sess_k_root', 'oc_main', 'app_codex');
    const first = await adoptSubtask({ sessionId: 'sess_k_root', chatId: 'oc_adopt', goal: 'x', relatedRefs: ['doc://retry'], commit: true });
    const ctx = readChatContext('oc_adopt');
    expect(ctx).toBeTruthy();

    // 模拟 crash repair：SubTask 已落库，但 context/topology 没来得及写完。
    tempDir = mkdtempSync(join(tmpdir(), 'orch-test-crash-repair-'));
    __resetForTesting();
    mockSessions.clear();
    subSession('sess_k_root', 'oc_main', 'app_codex');
    await createSubTask({
      chatId: 'oc_adopt', parentChatId: 'oc_main', parentMessageId: 'om_sub',
      goal: 'x', acceptance: null, bots: first.plan.bots, requester: 'ou_jason',
      createdBy: 'codex', idempotencyKey: first.plan.idempotencyKey,
      depth: 1, rootChatId: 'oc_main', reportingMode: 'executor',
    });
    expect(readChatContext('oc_adopt')).toBeNull();
    expect(readTopology().nodes.find(n => n.chatId === 'oc_adopt')).toBeUndefined();

    const replay = await adoptSubtask({ sessionId: 'sess_k_root', chatId: 'oc_adopt', goal: 'x', relatedRefs: ['doc://retry'], commit: true });
    expect(replay.dryRun).toBe(false);
    expect(replay.taskId).toBe(getByChatId('oc_adopt')!.taskId);
    expect(readChatContext('oc_adopt')!.relatedRefs).toContain('doc://retry');
    expect(readTopology().nodes.find(n => n.chatId === 'oc_adopt')?.parentChatId).toBe('oc_main');
  });

  it('同 idempotencyKey 重放不可改写 SubTask 对应的 immutable context 字段，但可追加 relatedRefs', async () => {
    subSession('sess_k_root', 'oc_main', 'app_codex');
    const first = await adoptSubtask({
      sessionId: 'sess_k_root',
      chatId: 'oc_adopt',
      goal: 'x',
      mode: 'executor',
      bots: ['codex', 'claude'],
      taskType: 'misc',
      relatedRefs: ['doc://A'],
      commit: true,
    });

    const appended = await adoptSubtask({
      sessionId: 'sess_k_root',
      chatId: 'oc_adopt',
      goal: 'x',
      mode: 'executor',
      bots: ['codex', 'claude'],
      taskType: 'misc',
      relatedRefs: ['doc://B'],
      commit: true,
    });
    expect(appended.taskId).toBe(first.taskId);
    expect(readChatContext('oc_adopt')!.relatedRefs).toEqual(expect.arrayContaining(['doc://A', 'doc://B']));

    await expect(adoptSubtask({
      sessionId: 'sess_k_root',
      chatId: 'oc_adopt',
      goal: 'x',
      mode: 'manager',
      bots: ['codex', 'claude'],
      taskType: 'misc',
      commit: true,
    })).rejects.toMatchObject({ status: 409 });
    await expect(adoptSubtask({
      sessionId: 'sess_k_root',
      chatId: 'oc_adopt',
      goal: 'x',
      mode: 'executor',
      bots: ['codex', 'tilly'],
      taskType: 'misc',
      commit: true,
    })).rejects.toMatchObject({ status: 409 });
    await expect(adoptSubtask({
      sessionId: 'sess_k_root',
      chatId: 'oc_adopt',
      goal: 'x',
      mode: 'executor',
      bots: ['codex', 'claude'],
      acceptance: 'new acceptance',
      taskType: 'misc',
      commit: true,
    })).rejects.toMatchObject({ status: 409 });
    await expect(adoptSubtask({
      sessionId: 'sess_k_root',
      chatId: 'oc_adopt',
      goal: 'x',
      mode: 'executor',
      bots: ['codex', 'claude'],
      taskType: 'bug',
      commit: true,
    })).rejects.toMatchObject({ status: 409 });
  });

  it('重复 chat 但不同 key 或不同 parent → 409', async () => {
    subSession('sess_k_root', 'oc_main', 'app_codex');
    await adoptSubtask({ sessionId: 'sess_k_root', chatId: 'oc_adopt', goal: 'x', commit: true });
    await expect(adoptSubtask({ sessionId: 'sess_k_root', chatId: 'oc_adopt', goal: 'different' }))
      .rejects.toMatchObject({ status: 409 });

    subSession('sess_other_parent', 'oc_other_parent', 'app_codex');
    await expect(adoptSubtask({ sessionId: 'sess_other_parent', chatId: 'oc_adopt', goal: 'x' }))
      .rejects.toMatchObject({ status: 409 });
  });

  it('父任务存在时只有父任务 main bot 可 adopt；--bots 必须包含调用者', async () => {
    const parent = await createSubTask({
      chatId: 'oc_parent', parentChatId: 'oc_main', parentMessageId: 'om_root',
      goal: '父任务', acceptance: null, bots: BOTS_WITH_REVIEWER, requester: 'ou_jason',
      createdBy: 'claude', idempotencyKey: 'parent', depth: 1, rootChatId: 'oc_main',
    });
    await transitionStatus(parent.taskId, 'observing');
    subSession('sess_wrong', 'oc_parent', 'app_codex');
    await expect(adoptSubtask({ sessionId: 'sess_wrong', chatId: 'oc_child', goal: 'x', bots: ['codex'] }))
      .rejects.toMatchObject({ status: 403 });

    subSession('sess_parent_main', 'oc_parent', 'app_claude');
    await expect(adoptSubtask({ sessionId: 'sess_parent_main', chatId: 'oc_child', goal: 'x', bots: ['codex'] }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('只能从 parent 群发起，且拒绝 parent chain cycle', async () => {
    const parent = await createSubTask({
      chatId: 'oc_parent', parentChatId: 'oc_main', parentMessageId: 'om_root',
      goal: '父任务', acceptance: null, bots: BOTS_WITH_REVIEWER, requester: 'ou_jason',
      createdBy: 'claude', idempotencyKey: 'parent-cycle', depth: 1, rootChatId: 'oc_main',
    });
    await transitionStatus(parent.taskId, 'observing');
    subSession('sess_wrong_chat', 'oc_other', 'app_claude');
    await expect(adoptSubtask({ sessionId: 'sess_wrong_chat', parentChatId: 'oc_parent', chatId: 'oc_child', goal: 'x' }))
      .rejects.toMatchObject({ status: 403 });

    subSession('sess_parent_main', 'oc_parent', 'app_claude');
    await expect(adoptSubtask({ sessionId: 'sess_parent_main', chatId: 'oc_main', goal: 'x' }))
      .rejects.toMatchObject({ status: 422 });
  });

  it('Codex root parent: adopted main bot 可 finish/supplement 鉴权', async () => {
    createChatContext('oc_main', {
      purpose: 'Company root: CodexCo',
      originType: 'bot_spawned',
      parentChatId: null,
      participants: [],
      relatedRefs: ['ceoLarkAppId=app_codex', 'ceoOpenId=ou_codex', 'ceoBotName=蔻黛克斯'],
    });
    subSession('sess_k_root', 'oc_main', 'app_codex');
    const adopted = await adoptSubtask({
      sessionId: 'sess_k_root',
      chatId: 'oc_adopt',
      goal: 'Codex CEO root 子群',
      bots: ['codex', 'claude', 'tilly'],
      commit: true,
    });
    const task = getSubTask(adopted.taskId!)!;

    const finish = await finishSubtask({
      sessionId: 'sess_k_root',
      taskId: task.taskId,
      expectedVersion: task.version,
      note: '验收通过',
    });
    expect(finish.status).toBe('finished');

    const adopted2 = await adoptSubtask({
      sessionId: 'sess_k_root',
      chatId: 'oc_adopt_2',
      goal: 'Codex CEO root 子群 2',
      bots: ['codex', 'claude'],
      commit: true,
    });
    await transitionStatus(adopted2.taskId!, 'reported_help');
    const helpTask = getSubTask(adopted2.taskId!)!;
    const supp = await supplementSubtask({
      sessionId: 'sess_k_root',
      taskId: helpTask.taskId,
      content: '补充信息',
      expectedVersion: helpTask.version,
    });
    expect(supp.status).toBe('observing');
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

  it('need_help 已 pending → 返回既有 report_help, 不重复入队刷父群', async () => {
    const t = await mkTask();
    subSession();
    const r1 = await reportProgress({ sessionId: 'sess_sub', taskId: t.taskId, type: 'need_help', summary: '卡住了' });
    const r2 = await reportProgress({ sessionId: 'sess_sub', taskId: t.taskId, type: 'need_help', summary: '还是卡住了' });
    expect(r2.cmdId).toBe(r1.cmdId);
    expect(listCommands(t.taskId).filter(c => c.commandType === 'report_help')).toHaveLength(1);
  });

  // bug 修复 (2026-05-31 蔻黛克斯 review): ack 只表示父群看过上一轮，不代表后续主动求助无效。
  // 已 acked 后执行者**显式**再求助应作为新 help 正常入队、重新唤父群，而不是被合并回旧 acked cmd。
  it('need_help 已 acked → 显式再求助 emit 新 help (重新唤父群, 不再永久 dedup 到旧 acked cmd)', async () => {
    const t = await mkTask();
    subSession();
    const r1 = await reportProgress({ sessionId: 'sess_sub', taskId: t.taskId, type: 'need_help', summary: '卡住了' });
    await ackCommand(r1.cmdId);
    const r2 = await reportProgress({ sessionId: 'sess_sub', taskId: t.taskId, type: 'need_help', summary: '响应了但还是不行' });
    expect(r2.cmdId).not.toBe(r1.cmdId);
    expect(listCommands(t.taskId).filter(c => c.commandType === 'report_help')).toHaveLength(2);
  });

  it('paused 已求助·待人 + 显式 askforhelp/report → 仍 emit 新 help', async () => {
    const t = await mkTask();
    await transitionStatus(t.taskId, 'paused');
    subSession();
    const old = await enqueueCommand({
      taskId: t.taskId, direction: 'child_to_parent', targetChatId: 'oc_main',
      commandType: 'report_help', payload: { summary: '卡在 X' }, idempotencyKey: 'old-help',
    });
    await ackCommand(old.cmdId);
    const r = await reportProgress({ sessionId: 'sess_sub', taskId: t.taskId, type: 'need_help', summary: '显式新求助：卡在 Y' });
    expect(r.cmdId).not.toBe(old.cmdId);
    expect(getSubTask(t.taskId)!.status).toBe('paused');
    expect(listCommands(t.taskId).filter(c => c.commandType === 'report_help')).toHaveLength(2);
  });

  it('task 已 finished → 拒绝 need_help, 不入队', async () => {
    const t = await mkTask();
    await transitionStatus(t.taskId, 'finished');
    subSession();
    await expect(reportProgress({ sessionId: 'sess_sub', taskId: t.taskId, type: 'need_help', summary: '卡住了' }))
      .rejects.toMatchObject({ status: 409 });
    expect(listCommands(t.taskId).filter(c => c.commandType === 'report_help')).toHaveLength(0);
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

  it('generic bot appId participant can report; sessionBotOpenId is not limited to claude/codex/tilly', async () => {
    const t = await createSubTask({
      taskId: 'st_newbot', chatId: 'oc_new_sub', parentChatId: 'oc_main', parentMessageId: 'om_root',
      goal: 'future bot task', acceptance: null,
      bots: [{ openId: 'ou_new', name: 'NewBot', role: 'main', larkAppId: 'app_new' }],
      requester: 'ou_jason', createdBy: 'NewBot', idempotencyKey: 'k_newbot',
    });
    await transitionStatus(t.taskId, 'observing');
    subSession('sess_newbot', 'oc_new_sub', 'app_new');
    const r = await reportProgress({ sessionId: 'sess_newbot', taskId: t.taskId, type: 'progress', slug: 'm1', summary: 'done' });
    expect(r.taskId).toBe(t.taskId);
  });

  it('app-scoped open_id mismatch: larkAppId participant can report even when stored openId differs', async () => {
    const t = await createSubTask({
      taskId: 'st_app_scope_report', chatId: 'oc_app_scope_sub', parentChatId: 'oc_main', parentMessageId: 'om_root',
      goal: 'app scope task', acceptance: null,
      bots: [{ openId: 'ou_claude_from_other_app', name: '克劳德', role: 'main', larkAppId: 'app_claude' }],
      requester: 'ou_jason', createdBy: 'claude', idempotencyKey: 'k_app_scope_report',
    });
    await transitionStatus(t.taskId, 'observing');
    subSession('sess_app_scope_report', 'oc_app_scope_sub', 'app_claude');
    const r = await reportProgress({ sessionId: 'sess_app_scope_report', taskId: t.taskId, type: 'done', summary: '完成' });
    expect(r.taskId).toBe(t.taskId);
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

  it('paused 已求助·待人 → observing + parent→child supplement 命令', async () => {
    const t = await mkTask();
    await transitionStatus(t.taskId, 'paused');
    mainSession();
    const v = getSubTask(t.taskId)!.version;
    const res = await supplementSubtask({ sessionId: 'sess_main', taskId: t.taskId, content: '外部介入：补充信息', expectedVersion: v });
    expect(res.status).toBe('observing');
    expect(getSubTask(t.taskId)!.status).toBe('observing');
    expect(getCommand(res.cmdId)!.commandType).toBe('supplement');
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

  it('优化 #1：缺省 targetRole → 命令 payload.targetRole=main', async () => {
    const t = await mkTask();
    await transitionStatus(t.taskId, 'reported_help');
    mainSession();
    const v = getSubTask(t.taskId)!.version;
    const res = await supplementSubtask({ sessionId: 'sess_main', taskId: t.taskId, content: 'x', expectedVersion: v });
    expect(getCommand(res.cmdId)!.payload.targetRole).toBe('main');
  });

  it('优化 #1：targetRole=reviewer → 内部映射 collab', async () => {
    const t = await mkTask();
    await transitionStatus(t.taskId, 'reported_help');
    mainSession();
    const v = getSubTask(t.taskId)!.version;
    const res = await supplementSubtask({ sessionId: 'sess_main', taskId: t.taskId, content: 'y', expectedVersion: v, targetRole: 'reviewer' });
    expect(getCommand(res.cmdId)!.payload.targetRole).toBe('collab');
  });
});

// ─── request_review (优化 #1 时序门控) ──────────────────────────────────────────
describe('requestReview', () => {
  /** 造一个含 reviewer 的 observing 子任务。 */
  async function mkTaskR(key = 'kr') {
    const t = await createSubTask({
      chatId: 'oc_sub', parentChatId: 'oc_main', parentMessageId: 'om_root',
      goal: '修 bug', acceptance: null, bots: BOTS_WITH_REVIEWER, requester: 'ou_jason', createdBy: 'claude', idempotencyKey: key,
    });
    await transitionStatus(t.taskId, 'observing');
    return getSubTask(t.taskId)!;
  }

  it('执行者(main) 从子群调 + summary 带绝对路径 → 入队 request_review (parent→child, targetRole=collab)', async () => {
    const t = await mkTaskR();
    subSession('sess_sub', 'oc_sub', 'app_claude'); // app_claude = ou_claude = main
    const res = await requestReview({ sessionId: 'sess_sub', taskId: t.taskId, summary: '产出在 /tmp/plan.md' });
    const cmd = getCommand(res.cmdId)!;
    expect(cmd.commandType).toBe('request_review');
    expect(cmd.direction).toBe('parent_to_child');
    expect(cmd.targetChatId).toBe('oc_sub');
    expect(cmd.payload.targetRole).toBe('collab');
  });

  it('app-scoped open_id mismatch: request_review 按 larkAppId 识别 main 执行者', async () => {
    const t = await createSubTask({
      chatId: 'oc_sub', parentChatId: 'oc_main', parentMessageId: 'om_root',
      goal: '修 bug', acceptance: null,
      bots: [
        { openId: 'ou_claude_from_other_app', name: '克劳德', role: 'main', larkAppId: 'app_claude' },
        { openId: 'ou_codex_from_other_app', name: '蔻黛克斯', role: 'collab', larkAppId: 'app_codex' },
      ],
      requester: 'ou_jason', createdBy: 'claude', idempotencyKey: 'kr_app_scope',
    });
    await transitionStatus(t.taskId, 'observing');
    subSession('sess_sub', 'oc_sub', 'app_claude');
    const res = await requestReview({ sessionId: 'sess_sub', taskId: t.taskId, summary: 'https://x/doc' });
    expect(getCommand(res.cmdId)!.commandType).toBe('request_review');
  });

  it('summary 无可打开链接/绝对路径 → 400', async () => {
    const t = await mkTaskR();
    subSession('sess_sub', 'oc_sub', 'app_claude');
    await expect(requestReview({ sessionId: 'sess_sub', taskId: t.taskId, summary: '我写完了快来看' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('非 main(reviewer 自己) 调用 → 403', async () => {
    const t = await mkTaskR();
    subSession('sess_k', 'oc_sub', 'app_codex'); // codex = collab
    await expect(requestReview({ sessionId: 'sess_k', taskId: t.taskId, summary: 'https://x/doc' }))
      .rejects.toMatchObject({ status: 403 });
  });

  it('任务无 reviewer(collab) → 409', async () => {
    const t = await mkTask(); // BOTS = main+observer，无 collab
    subSession('sess_sub', 'oc_sub', 'app_claude');
    await expect(requestReview({ sessionId: 'sess_sub', taskId: t.taskId, summary: 'https://x/doc' }))
      .rejects.toMatchObject({ status: 409 });
  });

  it('从父群(非子群)调 → 403', async () => {
    const t = await mkTaskR();
    mainSession('sess_main', 'oc_main');
    await expect(requestReview({ sessionId: 'sess_main', taskId: t.taskId, summary: 'https://x/doc' }))
      .rejects.toMatchObject({ status: 403 });
  });
});
