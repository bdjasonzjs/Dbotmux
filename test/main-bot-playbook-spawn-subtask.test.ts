/**
 * P1 commit #6 — MainBotPlaybook.spawnSubTask tests (P-S1~11).
 *
 * Run:  pnpm vitest run test/main-bot-playbook-spawn-subtask.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: { get session() { return { dataDir: tempDir }; } },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

// Mock createGroupWithBots — we don't want to hit Lark in unit tests.
const mockCreateGroup = vi.fn(async () => ({
  ok: true as const,
  chatId: 'oc_spawned_NEW',
  creator: 'cli_claude',
  invalidBotIds: [] as string[],
  invalidUserIds: [] as string[],
  ownerTransferredTo: null,
  transferError: null,
  notifyMessageId: null,
  notifyError: null,
  oncallBindings: [],
}));
vi.mock('../src/services/group-creator.js', () => ({
  createGroupWithBots: (...args: any[]) => mockCreateGroup(...args),
}));

// Mock bot-registry — return 3 fake bots
vi.mock('../src/bot-registry.js', () => ({
  getAllBots: () => [
    { config: { larkAppId: 'cli_claude', cliId: 'claude-code' }, botOpenId: 'ou_claude' },
    { config: { larkAppId: 'cli_codex',  cliId: 'codex' },       botOpenId: 'ou_codex' },
    { config: { larkAppId: 'cli_tilly',  cliId: 'coco' },        botOpenId: 'ou_tilly' },
  ],
}));

// Stub session-store — register sessions per-test
const fakeSessions = new Map<string, { sessionId: string; chatId: string; larkAppId: string; rootMessageId: string; ownerOpenId?: string }>();
vi.mock('../src/services/session-store.js', () => ({
  getSession: (sid: string) => fakeSessions.get(sid),
}));

// Stub main-topic-config
let fakeMainTopic: string | undefined;
vi.mock('../src/services/main-topic-config.js', () => ({
  getMainTopicChatId: () => fakeMainTopic,
  getMainTopicBotRef: () => 'claude',
  getCompanyByRootChatId: () => null,
  isTillyMainTopicConversationDenied: () => false,
}));

// 2026-05-29: spawnSubTask 现在新建群后会发 kickoff (subgroup-kickoff)。
// mock 掉避免单测打真 lark; kickoff 行为有独立单测 (subgroup-kickoff.test.ts)。
const mockKickoff = vi.fn(async () => 'om_kickoff_test');
vi.mock('../src/services/subgroup-kickoff.js', () => ({
  sendSubgroupKickoff: (...args: any[]) => mockKickoff(...args),
}));

async function freshImport() {
  vi.resetModules();
  // Re-import store too so per-test temp dir takes effect
  const store = await import('../src/services/spawn-idempotency-store.js');
  store.__clearInflightForTesting();
  return {
    pb: await import('../src/core/main-bot-playbook.js'),
    store,
  };
}

const MAIN_TOPIC = 'oc_flumy';
const CLAUDE_APP = 'cli_claude';

function registerMainBotSession(sessionId: string, rootMsg = 'om_root_test') {
  fakeSessions.set(sessionId, {
    sessionId,
    chatId: MAIN_TOPIC,
    larkAppId: CLAUDE_APP,
    rootMessageId: rootMsg,
    ownerOpenId: 'ou_jason',
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mb-playbook-'));
  fakeSessions.clear();
  fakeMainTopic = MAIN_TOPIC;
  vi.clearAllMocks();
  // 2026-05-29: resolveBotIdent 改读 config.session.dataDir (= tempDir 经 mock)
  // 后, 写 bots-info.json fixture 让它解析出 cli_claude/cli_codex/cli_tilly,
  // 匹配 fake session 的 cli_claude (之前硬编码读真 ~/.botmux/data 永远不匹配)。
  writeFileSync(join(tempDir, 'bots-info.json'), JSON.stringify([
    { cliId: 'claude-code', larkAppId: 'cli_claude', botName: 'claude', botOpenId: 'ou_claude' },
    { cliId: 'codex', larkAppId: 'cli_codex', botName: 'codex', botOpenId: 'ou_codex' },
    { cliId: 'coco', larkAppId: 'cli_tilly', botName: 'tilly', botOpenId: 'ou_tilly' },
  ]), 'utf-8');
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('MainBotPlaybook.spawnSubTask (P1 commit #6)', () => {
  describe('P-S1 — taskType=prd template', () => {
    it('createGroupWithBots called with chatContext.rules including PRD guidance', async () => {
      const { pb } = await freshImport();
      registerMainBotSession('s1');
      await pb.spawnSubTask({ sessionId: 's1', purpose: 'analyse PRD X', taskType: 'prd' });
      const callOpts = mockCreateGroup.mock.calls[0][0];
      expect(callOpts.chatContext.rules).toContain('先读 PRD 全文再讨论，不要凭群名臆测');
      expect(callOpts.chatContext.taskType).toBe('prd');
    });
  });

  describe('P-S2 — taskType=bug template', () => {
    it('rules contain bug-reproduce guidance', async () => {
      const { pb } = await freshImport();
      registerMainBotSession('s2');
      await pb.spawnSubTask({ sessionId: 's2', purpose: 'fix login', taskType: 'bug' });
      const callOpts = mockCreateGroup.mock.calls[0][0];
      expect(callOpts.chatContext.rules.some((r: string) => r.includes('先复现 bug'))).toBe(true);
    });
  });

  describe('P-S3 — same session+purpose second time = cache hit', () => {
    it('second spawnSubTask with same key returns isNew=false + same chatId', async () => {
      const { pb } = await freshImport();
      registerMainBotSession('s3', 'om_root_s3');
      const r1 = await pb.spawnSubTask({ sessionId: 's3', purpose: 'task A', taskType: 'misc' });
      expect(r1.isNew).toBe(true);
      const r2 = await pb.spawnSubTask({ sessionId: 's3', purpose: 'task A', taskType: 'misc' });
      expect(r2.isNew).toBe(false);
      expect(r2.chatId).toBe(r1.chatId);
      expect(mockCreateGroup).toHaveBeenCalledTimes(1);
    });
  });

  describe('P-S4 — session.chatId ≠ mainTopicChatId → throw', () => {
    it('non-mainTopic session is rejected', async () => {
      const { pb } = await freshImport();
      fakeSessions.set('s4', {
        sessionId: 's4',
        chatId: 'oc_some_other_chat',
        larkAppId: CLAUDE_APP,
        rootMessageId: 'om_x',
        ownerOpenId: 'ou_jason',
      });
      await expect(pb.spawnSubTask({ sessionId: 's4', purpose: 'x', taskType: 'misc' }))
        .rejects.toThrow(/only allowed from a company\/root main topic chat/);
    });
  });

  describe('P-S5 — session.larkAppId ≠ Claude → throw', () => {
    it('non-Claude session is rejected', async () => {
      const { pb } = await freshImport();
      fakeSessions.set('s5', {
        sessionId: 's5',
        chatId: MAIN_TOPIC,
        larkAppId: 'cli_codex',   // not Claude
        rootMessageId: 'om_x',
      });
      await expect(pb.spawnSubTask({ sessionId: 's5', purpose: 'x', taskType: 'misc' }))
        .rejects.toThrow(/only main bot can spawn subtasks/);
    });
  });

  describe('P-S5b — clone (claude-code, isClone) 不能冒充 CEO spawn (本体按 isClone 认, 非 index 0)', () => {
    it('clone session is rejected even when the clone is at bots-info index 0', async () => {
      // CLONE placed at index 0 on purpose: if CEO were identified by array
      // position, the clone would wrongly pass authz. It must be rejected.
      writeFileSync(join(tempDir, 'bots-info.json'), JSON.stringify([
        { cliId: 'claude-code', larkAppId: 'cli_clone', botName: 'claude-clone', botOpenId: 'ou_clone', isClone: true },
        { cliId: 'claude-code', larkAppId: 'cli_claude', botName: 'claude', botOpenId: 'ou_claude' },
        { cliId: 'codex', larkAppId: 'cli_codex', botName: 'codex', botOpenId: 'ou_codex' },
        { cliId: 'coco', larkAppId: 'cli_tilly', botName: 'tilly', botOpenId: 'ou_tilly' },
      ]), 'utf-8');
      const { pb } = await freshImport();
      fakeSessions.set('s_clone', {
        sessionId: 's_clone',
        chatId: MAIN_TOPIC,
        larkAppId: 'cli_clone',   // the clone tries to spawn
        rootMessageId: 'om_clone',
      });
      await expect(pb.spawnSubTask({ sessionId: 's_clone', purpose: 'x', taskType: 'misc' }))
        .rejects.toThrow(/only main bot can spawn subtasks/);
    });

    it('本体 claude session still spawns OK with the clone present at index 0', async () => {
      writeFileSync(join(tempDir, 'bots-info.json'), JSON.stringify([
        { cliId: 'claude-code', larkAppId: 'cli_clone', botName: 'claude-clone', botOpenId: 'ou_clone', isClone: true },
        { cliId: 'claude-code', larkAppId: 'cli_claude', botName: 'claude', botOpenId: 'ou_claude' },
        { cliId: 'codex', larkAppId: 'cli_codex', botName: 'codex', botOpenId: 'ou_codex' },
        { cliId: 'coco', larkAppId: 'cli_tilly', botName: 'tilly', botOpenId: 'ou_tilly' },
      ]), 'utf-8');
      const { pb } = await freshImport();
      fakeSessions.set('s_main', {
        sessionId: 's_main', chatId: MAIN_TOPIC, larkAppId: 'cli_claude', rootMessageId: 'om_main',
      });
      await expect(pb.spawnSubTask({ sessionId: 's_main', purpose: 'x', taskType: 'misc' })).resolves.toBeDefined();
    });
  });

  describe('P-S6 — default bot list = 三 bot 全拉', () => {
    it('larkAppIds passed to createGroupWithBots contains all 3 bot app ids', async () => {
      const { pb } = await freshImport();
      registerMainBotSession('s6');
      await pb.spawnSubTask({ sessionId: 's6', purpose: 'x', taskType: 'misc' });
      const callOpts = mockCreateGroup.mock.calls[0][0];
      expect(callOpts.larkAppIds.sort()).toEqual(['cli_claude', 'cli_codex', 'cli_tilly']);
    });
  });

  describe('P-S7 — relay owner joins subgroup, without transfer/notify side effects', () => {
    it('createGroupWithBots opts invite session owner but do not transfer owner or notify', async () => {
      const { pb } = await freshImport();
      registerMainBotSession('s7');
      await pb.spawnSubTask({ sessionId: 's7', purpose: 'x', taskType: 'misc' });
      const callOpts = mockCreateGroup.mock.calls[0][0];
      expect(callOpts.userOpenIds).toEqual(['ou_jason']);
      expect(callOpts.transferOwnerTo).toBeUndefined();
      expect(callOpts.notifyOwnerOpenId).toBeUndefined();
    });
  });

  describe('P-S8 — missing sessionId → throw 400', () => {
    it('empty sessionId is rejected', async () => {
      const { pb } = await freshImport();
      await expect(pb.spawnSubTask({ sessionId: '', purpose: 'x', taskType: 'misc' }))
        .rejects.toMatchObject({ status: 400, message: /missing sessionId/ });
    });
  });

  describe('P-S9 — unknown sessionId → throw 403', () => {
    it('non-existent session is rejected', async () => {
      const { pb } = await freshImport();
      await expect(pb.spawnSubTask({ sessionId: 'no_such', purpose: 'x', taskType: 'misc' }))
        .rejects.toMatchObject({ status: 403, message: /unknown session/ });
    });
  });

  describe('P-S10 — default 3-bot participants auto-derived with roles', () => {
    it('chatContext.participants contains all 3 bots with correct roles', async () => {
      const { pb } = await freshImport();
      registerMainBotSession('s10');
      await pb.spawnSubTask({ sessionId: 's10', purpose: 'x', taskType: 'misc' });
      const callOpts = mockCreateGroup.mock.calls[0][0];
      const ps = callOpts.chatContext.participants;
      expect(ps).toHaveLength(3);
      expect(ps.find((p: any) => p.openId === 'ou_claude').role).toBe('main bot');
      expect(ps.find((p: any) => p.openId === 'ou_codex').role).toBe('reviewer/sister');
      expect(ps.find((p: any) => p.openId === 'ou_tilly').role).toBe('scout');
    });
  });

  describe('P-S11 — cacheHit drives isNew (not entry.result.idempotentHit which we deleted)', () => {
    it('after first spawnSubTask, second call returns isNew=false via cacheHit semantics', async () => {
      const { pb } = await freshImport();
      registerMainBotSession('s11', 'om_root_s11');
      const r1 = await pb.spawnSubTask({ sessionId: 's11', purpose: 'identical', taskType: 'misc' });
      const r2 = await pb.spawnSubTask({ sessionId: 's11', purpose: 'identical', taskType: 'misc' });
      // r1 is winner → isNew true; r2 is cacheHit → isNew false
      expect(r1.isNew).toBe(true);
      expect(r2.isNew).toBe(false);
      // 2 callers with same key → exactly 1 createGroupWithBots call (getOrCompute lock)
      expect(mockCreateGroup).toHaveBeenCalledTimes(1);
    });
  });

  describe('P-S extra — mainTopicChatId not configured → 500', () => {
    it('throws clear error when mainTopic is unset', async () => {
      fakeMainTopic = undefined;
      const { pb } = await freshImport();
      registerMainBotSession('s_no_topic');
      await expect(pb.spawnSubTask({ sessionId: 's_no_topic', purpose: 'x', taskType: 'misc' }))
        .rejects.toMatchObject({ status: 500, message: /mainTopicChatId not configured/ });
    });
  });
});
