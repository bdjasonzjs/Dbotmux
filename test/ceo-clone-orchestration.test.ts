import { describe, it, expect } from 'vitest';
import { ensureClonesAndSpawn, type EnsureSpawnDeps, type EnsureSpawnReq } from '../src/services/ceo-clone-orchestration.js';
import type { BotInventoryEntry } from '../src/services/bot-inventory.js';
import type { CeoSpawnState } from '../src/services/ceo-spawn-store.js';

const OWNER = 'ou_owner';
const baseReq = (over: Partial<EnsureSpawnReq> = {}): EnsureSpawnReq => ({
  goal: 'push X', chatId: 'oc_main', rootMessageId: 'om_root', senderOpenId: OWNER,
  seats: [{ role: 'main' }, { role: 'collab' }], requestKey: 'k1',
  ...over,
});

const main = (): BotInventoryEntry => ({ larkAppId: 'cli_main', cliId: 'claude-code', index: 0 });
const clone = (id = 'cli_clone'): BotInventoryEntry => ({ larkAppId: id, cliId: 'claude-code', index: 1, claudeConfigDir: `/c/${id}` });

function deps(over: Partial<EnsureSpawnDeps> = {}): { d: EnsureSpawnDeps; calls: any; store: Map<string, CeoSpawnState> } {
  const store = new Map<string, CeoSpawnState>();
  const calls = { spawn: 0, cloneInChat: 0, activate: 0, isInChat: 0, addBotToChat: 0, addBotToSubTask: 0, lateKickoff: 0, replies: [] as string[], lateKickoffArgs: [] as any[] };
  const d: EnsureSpawnDeps = {
    getOwnerOpenId: () => OWNER,
    listClaudeBots: () => [main()],
    botOpenIdReady: (id) => (id === 'cli_main' ? 'ou_main' : undefined),
    displayNameForApp: (id) => (id === 'cli_new' ? '克劳德（初号机）' : undefined),
    spawnSubtask: async ({ bots }) => { calls.spawn++; return { taskId: 'st_1', chatId: 'oc_sub', bots }; },
    cloneInChat: async () => { calls.cloneInChat++; return { ok: true, appId: 'cli_new' }; },
    activationApproved: () => false,
    activate: async () => { calls.activate++; return { ok: true }; },
    isInChat: async () => { calls.isInChat++; return false; },
    addBotToChat: async () => { calls.addBotToChat++; return { ok: true }; },
    addBotToSubTask: async () => { calls.addBotToSubTask++; },
    lateKickoff: async (a) => { calls.lateKickoff++; calls.lateKickoffArgs.push(a); },
    getState: (k) => store.get(k) ?? null,
    putState: (s) => { store.set(s.key, JSON.parse(JSON.stringify(s))); },
    clearState: (k) => { store.delete(k); },
    reply: async (m) => { calls.replies.push(m); },
    ...over,
  };
  return { d, calls, store };
}

describe('ensureClonesAndSpawn (subgroup-first #5)', () => {
  it('non-owner → refused, no subgroup built', async () => {
    const { d, calls } = deps();
    const out = await ensureClonesAndSpawn(baseReq({ senderOpenId: 'ou_x' }), d);
    expect(out.status).toBe('refused');
    expect(calls.spawn).toBe(0);
  });

  it('enough ready seats → builds subgroup with all seats, no clone, spawned', async () => {
    const { d, calls } = deps({
      listClaudeBots: () => [main(), clone()],
      botOpenIdReady: (id) => (id === 'cli_main' || id === 'cli_clone' ? `ou_${id}` : undefined),
    });
    const out = await ensureClonesAndSpawn(baseReq(), d);
    expect(out.status).toBe('spawned');
    if (out.status !== 'spawned') return;
    expect(calls.spawn).toBe(1);
    expect(calls.cloneInChat).toBe(0);
    expect(out.bots).toEqual(['cli_main:main', 'cli_clone:collab']);
  });

  it('subgroup built FIRST, then QR clone; activation gate → awaiting_activation (spawn happened, clone scanned once)', async () => {
    const { d, calls } = deps({ activationApproved: () => false });
    const out = await ensureClonesAndSpawn(baseReq(), d);
    expect(out.status).toBe('awaiting_activation');
    expect(calls.spawn).toBe(1);          // subgroup built first
    expect(calls.cloneInChat).toBe(1);    // QR into subgroup
    expect(calls.activate).toBe(0);       // deploy gate not crossed
  });

  it('QR delivery to subgroup failed → distinct error; subgroup already built, clone seat stays pending', async () => {
    const { d, calls, store } = deps({ cloneInChat: async () => { calls.cloneInChat++; return { ok: false, error: 'qr_delivery_failed' }; } });
    const out = await ensureClonesAndSpawn(baseReq(), d);
    expect(out.status).toBe('error');
    if (out.status !== 'error') return;
    expect(out.message).toMatch(/二维码/);
    expect(store.get('k1')?.pendingClones[0].phase).toBe('pending'); // retryable
    expect(calls.activate).toBe(0);
  });

  it('re-entry does NOT re-clone or rebuild: 2nd call (approved) continues the same pending clone', async () => {
    let approved = false, activated = false;
    const { d, calls } = deps({
      activationApproved: () => approved,
      activate: async () => { calls.activate++; activated = true; return { ok: true }; },
      botOpenIdReady: (id) => (id === 'cli_main' ? 'ou_main' : (id === 'cli_new' && activated ? 'ou_new' : undefined)),
    });
    const first = await ensureClonesAndSpawn(baseReq(), d);
    expect(first.status).toBe('awaiting_activation');
    approved = true;
    const second = await ensureClonesAndSpawn(baseReq(), d);
    expect(second.status).toBe('spawned');
    expect(calls.spawn).toBe(1);        // subgroup built once
    expect(calls.cloneInChat).toBe(1);  // cloned once (re-entry skipped re-clone)
    expect(calls.activate).toBe(1);
    expect(calls.addBotToChat).toBe(1);
    expect(calls.addBotToSubTask).toBe(1);
    expect(calls.lateKickoff).toBe(1);
    expect(calls.lateKickoffArgs[0]).toMatchObject({ taskId: 'st_1', summonName: '克劳德（初号机）', appId: 'cli_new' });
  });

  it('addBotToChat fails → awaiting_clone_join, store NOT mutated (no addBotToSubTask/lateKickoff)', async () => {
    let activated = false;
    const { d, calls } = deps({
      activationApproved: () => true,
      activate: async () => { calls.activate++; activated = true; return { ok: true }; },
      botOpenIdReady: (id) => (id === 'cli_main' ? 'ou_main' : (id === 'cli_new' && activated ? 'ou_new' : undefined)),
      addBotToChat: async () => { calls.addBotToChat++; return { ok: false, error: 'invite_failed' }; },
    });
    const out = await ensureClonesAndSpawn(baseReq(), d);
    expect(out.status).toBe('awaiting_clone_join');
    expect(calls.addBotToChat).toBe(1);
    expect(calls.addBotToSubTask).toBe(0); // 守点4: no store change before chat add succeeds
    expect(calls.lateKickoff).toBe(0);
  });

  // blocker1: after addBotToChat success, store/kickoff failure must re-enter at
  // 'in_chat' (NOT re-add to chat) and complete — no permanent awaiting_clone_join.
  it('re-entry after lateKickoff failure: completes without re-adding to chat', async () => {
    let activated = false, kickoffCalls = 0;
    const { d, calls } = deps({
      activationApproved: () => true,
      activate: async () => { calls.activate++; activated = true; return { ok: true }; },
      botOpenIdReady: (id) => (id === 'cli_main' ? 'ou_main' : (id === 'cli_new' && activated ? 'ou_new' : undefined)),
      lateKickoff: async (a) => { calls.lateKickoff++; kickoffCalls++; if (kickoffCalls === 1) throw new Error('relay down'); calls.lateKickoffArgs.push(a); },
    });
    await expect(ensureClonesAndSpawn(baseReq(), d)).rejects.toThrow('relay down');
    const out = await ensureClonesAndSpawn(baseReq(), d);
    expect(out.status).toBe('spawned');
    expect(calls.addBotToChat).toBe(1); // NOT re-added on re-entry (phase was in_chat)
    expect(calls.isInChat).toBe(1);     // membership check only in the activated phase, once
    expect(calls.lateKickoff).toBe(2);  // retried after the first failure
  });

  // blocker1: a clone already in the chat (re-entry) → skip add, don't stick.
  it('clone already in chat → skips addBotToChat, still completes', async () => {
    let activated = false;
    const { d, calls } = deps({
      activationApproved: () => true,
      activate: async () => { calls.activate++; activated = true; return { ok: true }; },
      botOpenIdReady: (id) => (id === 'cli_main' ? 'ou_main' : (id === 'cli_new' && activated ? 'ou_new' : undefined)),
      isInChat: async () => { calls.isInChat++; return true; }, // already a member
    });
    const out = await ensureClonesAndSpawn(baseReq(), d);
    expect(out.status).toBe('spawned');
    expect(calls.addBotToChat).toBe(0); // skipped — never risks already-in-chat failure
    expect(calls.addBotToSubTask).toBe(1);
    expect(calls.lateKickoff).toBe(1);
  });

  // blocker2: 本体(non-clone) must take auto:main even if a clone is earlier in bots.json.
  it('clone at bots.json index 0, 本体 ready → auto:main = 本体, clone → collab', async () => {
    const { d } = deps({
      listClaudeBots: () => [clone('cli_c0'), main()], // clone listed FIRST
      botOpenIdReady: (id) => (id === 'cli_main' || id === 'cli_c0' ? `ou_${id}` : undefined),
    });
    const out = await ensureClonesAndSpawn(baseReq(), d);
    expect(out.status).toBe('spawned');
    if (out.status !== 'spawned') return;
    expect(out.bots).toEqual(['cli_main:main', 'cli_c0:collab']); // 本体 main, not the index-0 clone
  });

  // hardening: a clone with no displayName must NOT trigger a kickoff (would wake main).
  it('clone with no displayName → lateKickoff skipped (never wakes main), still spawned', async () => {
    let activated = false;
    const { d, calls } = deps({
      activationApproved: () => true,
      activate: async () => { calls.activate++; activated = true; return { ok: true }; },
      botOpenIdReady: (id) => (id === 'cli_main' ? 'ou_main' : (id === 'cli_new' && activated ? 'ou_new' : undefined)),
      displayNameForApp: () => undefined,
    });
    const out = await ensureClonesAndSpawn(baseReq(), d);
    expect(out.status).toBe('spawned');
    expect(calls.lateKickoff).toBe(0);    // fail closed
    expect(calls.addBotToSubTask).toBe(1); // clone still joined the subtask
  });

  it('activation failure → error + rollback reply, no chat add', async () => {
    const { d, calls } = deps({
      activationApproved: () => true,
      activate: async () => { calls.activate++; return { ok: false, error: 'pm2 boom' }; },
    });
    const out = await ensureClonesAndSpawn(baseReq(), d);
    expect(out.status).toBe('error');
    expect(calls.addBotToChat).toBe(0);
    expect(calls.replies.some(m => /激活失败/.test(m))).toBe(true);
  });
});
