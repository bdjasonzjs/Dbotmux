/**
 * Card model switch — PRODUCTION identity composition (S3 round-2 P2-2):
 * `defaultModelSwitchIdentityDeps` + the real `resolveCardOperatorUnionId` +
 * the real team / platform bot rosters on disk, driven through the real
 * `handleModelSwitchCardAction`. Only the daemon restart primitives, the bot
 * registry, the session store and the bot allowlist are stubbed.
 *
 * Run:  pnpm vitest run test/model-switch-identity.integration.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'botmux-ms-identity-'));
process.env.SESSION_DATA_DIR = dataDir;

vi.mock('@larksuiteoapi/node-sdk', () => { class FakeClient { constructor(public opts: Record<string, unknown>) {} } return { Client: FakeClient }; });
vi.mock('../src/utils/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
// The bot's owners (bots.json allowedUsers): one on_ entry and one app-scoped ou_ entry (resolved at start).
vi.mock('../src/bot-registry.js', async (importOriginal) => ({ ...(await importOriginal() as object), getBot: () => ({ config: { cliId: 'codex', allowedUsers: ['on_human', 'ou_owner_by_open_id'] }, resolvedAllowedUsers: ['ou_owner_by_open_id'] }) }));
const updateSessionMock = vi.fn();
vi.mock('../src/services/session-store.js', async (importOriginal) => ({ ...(await importOriginal() as object), updateSession: (...a: unknown[]) => updateSessionMock(...a) }));
const switchMock = vi.fn();
const delivered: string[] = [];
vi.mock('../src/core/worker-pool.js', async (importOriginal) => ({
  ...(await importOriginal() as object),
  requestModelSwitchRestart: (...a: unknown[]) => switchMock(...a),
  requestModelSwitchForceRollback: vi.fn(),
  requestSessionRestart: vi.fn(),
  activeSessionRestartAttemptId: () => undefined,
  isSessionTransferring: () => false,
  buildStreamingCardJson: (ds: any) => { delivered.push(JSON.stringify(ds.modelPanel ?? null)); return JSON.stringify({ panel: ds.modelPanel ?? null }); },
  scheduleCardPatch: vi.fn(),
  sendWorkerInput: vi.fn(() => true),
  sendWorkerSessionInput: vi.fn(() => true),
}));
vi.mock('../src/im/lark/event-dispatcher.js', async (importOriginal) => ({ ...(await importOriginal() as object), canOperate: () => true }));

import { handleModelSwitchCardAction, defaultModelSwitchIdentityDeps } from '../src/im/lark/model-switch-card.js';
import { resolveCardOperatorUnionId } from '../src/im/lark/card-handler.js';
import { recordTeamBot } from '../src/services/team-bots-store.js';
import { applyPlatformTeamSync } from '../src/services/platform-team-store.js';
import { setChatExternal } from '../src/im/lark/chat-external-cache.js';

recordTeamBot(dataDir, { unionId: 'on_teambot', name: 'team bot' });
applyPlatformTeamSync(dataDir, { rev: 'r1', teams: [{ teamId: 't1', teamName: 'T', groupChatIds: [], bots: [{ appId: 'cli_p', unionId: 'on_platbot' }], memberUnionIds: [] }] });
setChatExternal('app', 'oc_1', false);

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
beforeEach(() => { switchMock.mockReset(); updateSessionMock.mockReset(); delivered.length = 0; });

function run(operator: { open_id?: string; union_id?: string }, resolveUserUnionId = vi.fn(async () => ({ unionId: 'on_human' }))) {
  const data: any = { operator, action: { value: { action: 'model_pick', model: 'gpt-5.5' } } };
  const ds: any = { session: { sessionId: 's', cliId: 'codex', backendType: 'pty' }, larkAppId: 'app', chatId: 'oc_1', chatType: 'group', worker: { killed: false, send: vi.fn() }, lastScreenStatus: 'idle' };
  const before = JSON.stringify(ds.session);
  const ctx = {
    ds, operatorOpenId: operator.open_id, rootId: 'r', larkAppId: 'app',
    value: data.action.value, action: undefined, sessionReply: vi.fn(async () => 'om'),
    identity: defaultModelSwitchIdentityDeps(() => resolveCardOperatorUnionId(data, 'app', { resolveUserUnionId })),
    catalog: async () => ({ models: ['gpt-5.5', 'gpt-5.6-sol'], source: 'live' as const }),
  };
  return { ctx, ds, before, resolveUserUnionId };
}

describe('production identity composition', () => {
  it('a TEAM-roster bot union id is refused (zero mutation, zero switch)', async () => {
    const { ctx, ds, before } = run({ open_id: 'ou_x', union_id: 'on_teambot' });
    expect((await handleModelSwitchCardAction(ctx))?.toast.type).toBe('warning');
    expect(JSON.stringify(ds.session)).toBe(before);
    expect(switchMock).not.toHaveBeenCalled();
  });
  it('a PLATFORM-roster bot union id is refused (zero mutation, zero switch)', async () => {
    const { ctx, ds, before } = run({ open_id: 'ou_x', union_id: 'on_platbot' });
    expect((await handleModelSwitchCardAction(ctx))?.toast.type).toBe('warning');
    expect(JSON.stringify(ds.session)).toBe(before);
    expect(switchMock).not.toHaveBeenCalled();
  });
  it('a MALFORMED verified union id never falls back to the contact API and is refused', async () => {
    const { ctx, ds, before, resolveUserUnionId } = run({ open_id: 'ou_x', union_id: 'ou_not_a_union' });
    expect((await handleModelSwitchCardAction(ctx))?.toast.type).toBe('warning');
    expect(resolveUserUnionId).not.toHaveBeenCalled();
    expect(JSON.stringify(ds.session)).toBe(before);
    expect(switchMock).not.toHaveBeenCalled();
  });
  it('an absent union id resolves through the contact API; a human on_ id passes the gate', async () => {
    switchMock.mockReturnValue({ ok: true, attemptId: 'A', txn: { target: { model: 'gpt-5.5' }, rollback: {} } });
    const { ctx, resolveUserUnionId } = run({ open_id: 'ou_x' });
    expect((await handleModelSwitchCardAction(ctx) as any)?.panel?.kind).toBe('confirm');
    expect(resolveUserUnionId).toHaveBeenCalledWith('app', 'ou_x');
    expect(switchMock).not.toHaveBeenCalled(); // v2: confirm is a card state; the restart starts on model_pick_confirm
  });
  it('contact API returning a non-on_ id, or throwing, is refused', async () => {
    for (const r of [vi.fn(async () => ({ unionId: 'ou_bad' })), vi.fn(async () => { throw new Error('api'); })]) {
      const { ctx, ds, before } = run({ open_id: 'ou_x' }, r as any);
      expect((await handleModelSwitchCardAction(ctx))?.toast.type).toBe('warning');
      expect(JSON.stringify(ds.session)).toBe(before);
      expect(switchMock).not.toHaveBeenCalled();
    }
  });
  it('a verified human who is NOT a bot owner is refused with zero mutation (owner-only)', async () => {
    const { ctx, ds, before } = run({ open_id: 'ou_x', union_id: 'on_some_colleague' });
    expect((await handleModelSwitchCardAction(ctx))?.toast.type).toBe('warning');
    expect(JSON.stringify(ds.session)).toBe(before);
    expect(ds.modelPanel).toBeUndefined();
    expect(switchMock).not.toHaveBeenCalled();
  });
  it('an owner listed by app-scoped open_id passes (verified union id present but not listed)', async () => {
    const { ctx } = run({ open_id: 'ou_owner_by_open_id', union_id: 'on_whatever_real' });
    expect((await handleModelSwitchCardAction(ctx) as any)?.panel?.kind).toBe('confirm');
  });
  it('a stranger whose open_id is NOT resolved for this bot is refused even with a verified union id', async () => {
    const { ctx, ds, before } = run({ open_id: 'ou_stranger', union_id: 'on_stranger' });
    expect((await handleModelSwitchCardAction(ctx))?.toast.type).toBe('warning');
    expect(JSON.stringify(ds.session)).toBe(before);
    expect(switchMock).not.toHaveBeenCalled();
  });
});
