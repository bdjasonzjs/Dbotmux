/**
 * P0 regression (2026-09-05 17:4x, owner report): after an IN-PLACE CLI restart
 * (card restart / model switch) the 「显示输出」 toggle did nothing. Root cause:
 * requestSessionRestart sets `ds.workerReady=false`, the worker only emits
 * `ready` on initial boot, and nothing restored the flag — so every surface
 * gated by workerHasInitialized silently no-op'd until the next fork.
 *
 * Run:  pnpm vitest run test/card-toggle-after-inplace-restart.test.ts
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
vi.mock('@larksuiteoapi/node-sdk', () => { class FakeClient { constructor(public o: any) {} } return { Client: FakeClient }; });
vi.mock('../src/utils/logger.js', () => ({ logger: { isDebug: () => false, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const updateMessage = vi.fn(async () => {});
vi.mock('../src/im/lark/client.js', async (io) => ({ ...(await io() as object), updateMessage: (...a: any[]) => updateMessage(...a), resolveUserUnionId: async () => ({ unionId: 'on_owner' }) }));
vi.mock('../src/bot-registry.js', async (io) => ({ ...(await io() as object), getBot: () => ({ config: { cliId: 'claude-code', larkAppId: 'app', allowedUsers: ['ou_owner'] }, resolvedAllowedUsers: ['ou_owner'] }), getAllBots: () => [] }));
vi.mock('../src/services/session-store.js', async (io) => ({ ...(await io() as object), updateSession: vi.fn() }));
vi.mock('../src/im/lark/event-dispatcher.js', async (io) => ({ ...(await io() as object), canOperate: () => true, canTalk: () => true }));
import { handleCardAction } from '../src/im/lark/card-handler.js';
import { workerHasInitialized, requestSessionRestart, __testOnly_resetRestartCoordinator } from '../src/core/worker-pool.js';
import { setChatExternal } from '../src/im/lark/chat-external-cache.js';

const workerPoolSource = readFileSync(new URL('../src/core/worker-pool.ts', import.meta.url), 'utf8');

function ownerLikeDs(workerReady: boolean | undefined) {
  return {
    session: { sessionId: 'e40b9a46-x', cliId: 'claude-code', backendType: 'pty', externalChat: false, chatType: 'group', title: 'T', webPort: 13275 },
    larkAppId: 'app', chatId: 'oc_g', chatType: 'group', scope: 'chat',
    worker: { killed: false, send: vi.fn() }, workerReady, workerPort: 13275, workerToken: 'tok',
    streamCardId: 'om_new', streamCardNonce: 'n1', displayMode: 'hidden', lastScreenContent: 'hello', lastScreenStatus: 'idle',
  } as any;
}
async function toggle(ds: any) {
  const activeSessions = new Map([['om_root::app', ds]]);
  return handleCardAction({ operator: { open_id: 'ou_owner' }, open_message_id: 'om_new', action: { value: { action: 'toggle_display', root_id: 'om_root', session_id: ds.session.sessionId, cli_id: 'claude-code', card_nonce: 'n1' } } } as any,
    { activeSessions, sessionReply: vi.fn(async () => 'om'), lastRepoScan: new Map() } as any, 'app');
}

describe('显示输出 after an in-place restart', () => {
  it('reproduces the report: with workerReady=false the toggle flips state but returns NO card', async () => {
    setChatExternal('app', 'oc_g', false);
    const ds = ownerLikeDs(false);
    const r = await toggle(ds);
    expect(ds.displayMode).toBe('screenshot');   // state flipped…
    expect(r).toBeUndefined();                   // …but nothing reached the card
  });
  it('with workerReady=true the same click returns the screenshot-state card', async () => {
    setChatExternal('app', 'oc_g', false);
    const ds = ownerLikeDs(true);
    const r = await toggle(ds);
    expect(JSON.stringify(r)).toMatch(/隐藏输出|Hide output/);
  });
  it('requestSessionRestart (live worker) flips workerReady to false — the gate that must be restored', () => {
    __testOnly_resetRestartCoordinator();
    const ds = ownerLikeDs(true);
    requestSessionRestart(ds, { source: 'card', notify: vi.fn() });
    expect(ds.workerReady).toBe(false);
    expect(workerHasInitialized(ds)).toBe(false);
    __testOnly_resetRestartCoordinator();
  });
  it('the daemon restores workerReady on prompt_ready AND on a succeeded restart_result from the CURRENT worker', () => {
    // Source lock: both IPC handlers live inside setupWorkerHandlers' closure.
    const promptReady = workerPoolSource.indexOf("case 'prompt_ready': {");
    const restartResult = workerPoolSource.indexOf("case 'restart_result': {");
    expect(promptReady).toBeGreaterThan(0);
    expect(restartResult).toBeGreaterThan(0);
    const promptBlock = workerPoolSource.slice(promptReady, promptReady + 1500);
    const resultBlock = workerPoolSource.slice(restartResult, restartResult + 900);
    expect(promptBlock).toMatch(/if \(ds\.worker !== worker\) break;[\s\S]*?if \(ds\.workerReady === false\) \{\s*ds\.workerReady = true;/);
    expect(resultBlock).toMatch(/if \(ds\.worker !== worker\) \{[\s\S]*?if \(msg\.status === 'succeeded' && ds\.workerReady === false\) \{\s*ds\.workerReady = true;/);
  });
});
