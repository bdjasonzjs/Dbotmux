import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IpcServerHandle } from '../src/core/dashboard-ipc-server.js';

let handle: IpcServerHandle | null = null;

const registry = new Map<string, any>();
const oldDs = {
  session: {
    sessionId: 'old_session',
    chatId: 'oc_mgr',
    chatType: 'group',
    rootMessageId: 'om_root',
    title: '经理任务',
    status: 'active',
    createdAt: '2026-06-25T00:00:00.000Z',
    larkAppId: 'app_mgr',
    ownerOpenId: 'ou_owner',
    lastCallerOpenId: 'ou_owner',
    suppressImplicitAddressing: true,
    workingDir: '/repo/mgr',
    cliId: 'codex',
  },
  worker: { killed: false },
  workerPort: 1234,
  workerToken: 'tok',
  larkAppId: 'app_mgr',
  chatId: 'oc_mgr',
  chatType: 'group',
  scope: 'thread',
  spawnedAt: 1,
  cliVersion: 'v1',
  lastMessageAt: 1,
  hasHistory: true,
  workingDir: '/repo/mgr',
  ownerOpenId: 'ou_owner',
};

const forkWorker = vi.fn();
const closeSession = vi.fn(async () => ({
  ok: true,
  outcome: 'closed' as const,
  alreadyClosed: false,
  known: true,
}));
const createSession = vi.fn();
const updateSession = vi.fn();
const closeStoredSession = vi.fn();

vi.mock('../src/core/worker-pool.js', () => ({
  listActiveSessions: () => [],
  findActiveBySessionId: (sessionId: string) => sessionId === 'old_session' ? oldDs : undefined,
  closeSession,
  getActiveSessionsRegistry: () => registry,
  forkWorker,
}));

vi.mock('../src/services/session-store.js', () => ({
  listSessions: () => [],
  getSession: () => undefined,
  closeSession: closeStoredSession,
  createSession,
  updateSession,
}));

vi.mock('../src/services/schedule-store.js', () => ({ listTasks: () => [] }));
vi.mock('../src/core/scheduler.js', () => ({
  belongsToOwner: () => true,
  runNow: () => ({ ok: false, error: 'not_found' }),
  setEnabled: () => ({ ok: false, error: 'not_found' }),
}));
vi.mock('../src/services/groups-store.js', () => ({}));
vi.mock('../src/services/oncall-store.js', () => ({}));
vi.mock('../src/services/chat-first-seen-store.js', () => ({}));
vi.mock('../src/services/message-queue.js', () => ({ ensureQueue: vi.fn() }));
vi.mock('../src/im/lark/client.js', () => ({
  getChatMode: vi.fn(),
  listCurrentChatBotMembers: vi.fn(async () => []),
  resolveCurrentChatBotOpenIdsByLarkAppIds: vi.fn(async () => ({ mappings: [], unresolvedLarkAppIds: [] })),
  replyMessage: vi.fn(),
  sendMessage: vi.fn(),
}));
vi.mock('../src/bot-registry.js', () => ({
  getOwnerOpenId: () => 'ou_owner',
  getBotOpenId: () => 'ou_mgr_bot',
  getBotBrand: () => undefined,
  loadBotConfigs: vi.fn(),
  readBotSkillPolicy: () => undefined,
  getBotTuiSlashAllow: () => [],
  MAX_TURN_TIMEOUT_MS: 24 * 60 * 60 * 1000,
  getBot: () => ({
    botName: '经理 bot',
    botOpenId: 'ou_mgr_bot',
    config: { cliId: 'codex', larkAppId: 'app_mgr' },
  }),
}));

describe('POST /api/sessions/:sessionId/manager-recover', () => {
  afterEach(async () => {
    if (handle) await handle.close();
    handle = null;
    registry.clear();
    vi.clearAllMocks();
  });

  it('lifecycle-closes the old session, creates a clean session, preserves workingDir, and forks worker', async () => {
    registry.set('om_root::app_mgr', oldDs);
    createSession.mockReturnValue({
      sessionId: 'new_session',
      chatId: 'oc_mgr',
      chatType: 'group',
      rootMessageId: 'om_root',
      title: 'AutoRecover: 经理任务',
      status: 'active',
      createdAt: '2026-06-25T00:01:00.000Z',
    });
    const mod = await import('../src/core/dashboard-ipc-server.js');
    handle = await mod.startIpcServer({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/old_session/manager-recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'recover prompt', taskId: 'st_1', reason: 'manager_session_aged', recoverId: 'rid_1' }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, oldSessionId: 'old_session', newSessionId: 'new_session' });
    expect(closeSession).toHaveBeenCalledWith('old_session');
    expect(registry.has('om_root::app_mgr')).toBe(true);
    expect(createSession).toHaveBeenCalledWith('oc_mgr', 'om_root', 'AutoRecover: 经理任务', 'group');
    const cleanSession = updateSession.mock.calls[0][0];
    expect(cleanSession.workingDir).toBe('/repo/mgr');
    expect(cleanSession.suppressImplicitAddressing).toBe(true);
    expect(forkWorker).toHaveBeenCalledTimes(1);
    const forkedDs = forkWorker.mock.calls[0][0];
    expect(forkedDs.session.sessionId).toBe('new_session');
    expect(forkedDs.workingDir).toBe('/repo/mgr');
    expect(forkWorker.mock.calls[0][1]).toContain('recover prompt');
  });

  it('fails closed instead of spawning a replacement when close leaves a residual', async () => {
    registry.set('om_root::app_mgr', oldDs);
    closeSession.mockResolvedValueOnce({
      ok: true,
      outcome: 'closed_with_residual',
      residual: { reason: 'mojo_lineage_quarantined', taskId: 'remote-task-1' },
      alreadyClosed: false,
      known: true,
    } as any);
    const mod = await import('../src/core/dashboard-ipc-server.js');
    handle = await mod.startIpcServer({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/old_session/manager-recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'recover prompt' }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: 'close_residual',
      detail: { outcome: 'closed_with_residual', residual: { taskId: 'remote-task-1' } },
    });
    expect(createSession).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
    expect(forkWorker).not.toHaveBeenCalled();
  });
});
