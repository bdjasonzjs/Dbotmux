/**
 * 「显示输出」 is owner-only (owner decision 2026-09-05 18:28): only a verified
 * `on_` union id that belongs to a bot owner may toggle; any other human, a
 * bot, an unresolvable operator, or a resolver error → warning toast and an
 * UNCHANGED session (displayMode, modelPanel) — checked on every callback,
 * before any state change.
 *
 * Run:  pnpm vitest run test/card-toggle-owner-only.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@larksuiteoapi/node-sdk', () => { class FakeClient { constructor(public o: any) {} } return { Client: FakeClient }; });
vi.mock('../src/utils/logger.js', () => ({ logger: { isDebug: () => false, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const updateMessage = vi.fn(async () => {});
const resolveUnion = vi.fn(async (_app: string, openId: string) => ({ unionId: openId === 'ou_owner' ? 'on_owner' : 'on_guest' }));
vi.mock('../src/im/lark/client.js', async (io) => ({ ...(await io() as object), updateMessage: (...a: any[]) => updateMessage(...a), resolveUserUnionId: (...a: any[]) => resolveUnion(...(a as [string, string])) }));
let ownerCfg: string[] = ['ou_owner'];
let ownerResolved: string[] = ['ou_owner'];
let registryThrows = false;
vi.mock('../src/bot-registry.js', async (io) => ({ ...(await io() as object), getBot: () => { if (registryThrows) throw new Error('bot not registered'); return { config: { cliId: 'claude-code', larkAppId: 'app', allowedUsers: ownerCfg }, resolvedAllowedUsers: ownerResolved }; }, getAllBots: () => [] }));
vi.mock('../src/services/session-store.js', async (io) => ({ ...(await io() as object), updateSession: vi.fn() }));
// canOperate says yes to everyone — the OLD rule would let ou_guest toggle.
vi.mock('../src/im/lark/event-dispatcher.js', async (io) => ({ ...(await io() as object), canOperate: () => true, canTalk: () => true }));
import { handleCardAction } from '../src/im/lark/card-handler.js';
import { setChatExternal } from '../src/im/lark/chat-external-cache.js';

function mkDs(): any {
  return {
    session: { sessionId: 'sess-owner-1', cliId: 'claude-code', backendType: 'pty', ownerOpenId: 'ou_owner', chatId: 'oc_1', larkAppId: 'app' },
    larkAppId: 'app', chatId: 'oc_1', chatType: 'group', displayMode: 'hidden', streamCardId: 'om_new', streamCardNonce: 'n1',
    worker: { killed: false, send: vi.fn() }, workerReady: true, workerGeneration: 1, lastScreenStatus: 'idle',
    modelPanel: { kind: 'list', menuId: 'm', models: ['x'], source: 'static', efforts: [], currentModel: null, freshThread: false, restartInFlight: false },
  };
}
function click(ds: any, operator: Record<string, string>) {
  const activeSessions = new Map<string, any>([[`om_root::app`, ds]]);
  return handleCardAction({ operator, open_message_id: 'om_new', action: { value: { action: 'toggle_display', root_id: 'om_root', session_id: ds.session.sessionId, cli_id: 'claude-code', card_nonce: 'n1' } } } as any,
    { activeSessions, lastRepoScan: new Map(), sessionReply: vi.fn(async () => 'om_x') } as any, 'app');
}
const snap = (ds: any) => JSON.stringify({ d: ds.displayMode, p: ds.modelPanel ?? null });

beforeEach(() => { updateMessage.mockClear(); resolveUnion.mockClear(); ownerCfg = ['ou_owner']; ownerResolved = ['ou_owner']; registryThrows = false; setChatExternal('app', 'oc_1', false); });

describe('「显示输出」 owner-only', () => {
  it('the owner (app-scoped open_id in allowedUsers) toggles: display mode flips, picker collapses', async () => {
    const ds = mkDs();
    await click(ds, { open_id: 'ou_owner', union_id: 'on_owner' });
    expect(ds.displayMode).toBe('screenshot');
    expect(ds.modelPanel).toBeUndefined();
  });
  it('an owner listed by on_ union id (dafeijing-style bots.json) toggles too', async () => {
    ownerCfg = ['on_owner']; ownerResolved = [];
    const ds = mkDs();
    await click(ds, { open_id: 'ou_owner', union_id: 'on_owner' });
    expect(ds.displayMode).toBe('screenshot');
  });
  it('a verified human who canOperate but is NOT an owner is refused; nothing changes', async () => {
    const ds = mkDs(); const before = snap(ds);
    const r = await click(ds, { open_id: 'ou_guest', union_id: 'on_guest' });
    expect(r?.toast?.type).toBe('warning');
    expect(snap(ds)).toBe(before);
    expect(updateMessage).not.toHaveBeenCalled();
  });
  it('union id absent → contact API fallback; still owner-only', async () => {
    const ds = mkDs(); const before = snap(ds);
    expect((await click(ds, { open_id: 'ou_guest' }))?.toast?.type).toBe('warning');
    expect(snap(ds)).toBe(before);
    expect(resolveUnion).toHaveBeenCalledWith('app', 'ou_guest');
    const ds2 = mkDs();
    await click(ds2, { open_id: 'ou_owner' });
    expect(ds2.displayMode).toBe('screenshot');
  });
  it('malformed / missing operator, or a malformed verified id → refused', async () => {
    for (const op of [{}, { open_id: 'ou_owner', union_id: 'ou_not_a_union' }] as any[]) {
      const ds = mkDs(); const before = snap(ds);
      expect((await click(ds, op))?.toast?.type).toBe('warning');
      expect(snap(ds)).toBe(before);
    }
  });
  it('unregistered bot or empty allowedUsers → fail closed (never "open bot ⇒ everyone")', async () => {
    registryThrows = true;
    let ds = mkDs(); let before = snap(ds);
    expect((await click(ds, { open_id: 'ou_owner', union_id: 'on_owner' }))?.toast?.type).toBe('warning');
    expect(snap(ds)).toBe(before);
    registryThrows = false; ownerCfg = []; ownerResolved = [];
    ds = mkDs(); before = snap(ds);
    expect((await click(ds, { open_id: 'ou_owner', union_id: 'on_owner' }))?.toast?.type).toBe('warning');
    expect(snap(ds)).toBe(before);
  });
  it('every click re-checks: an owner removed from bots.json is refused on the next click', async () => {
    const ds = mkDs();
    await click(ds, { open_id: 'ou_owner', union_id: 'on_owner' });
    expect(ds.displayMode).toBe('screenshot');
    ownerCfg = []; ownerResolved = [];
    const before = snap(ds);
    expect((await click(ds, { open_id: 'ou_owner', union_id: 'on_owner' }))?.toast?.type).toBe('warning');
    expect(snap(ds)).toBe(before);
  });
});
