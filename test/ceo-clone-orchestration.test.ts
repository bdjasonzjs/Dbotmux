import { describe, it, expect } from 'vitest';
import { ensureClonesAndSpawn, type EnsureSpawnDeps, type EnsureSpawnReq } from '../src/services/ceo-clone-orchestration.js';
import type { CeoSpawnState } from '../src/services/ceo-spawn-store.js';

const OWNER = 'ou_owner';
const baseReq = (over: Partial<EnsureSpawnReq> = {}): EnsureSpawnReq => ({
  goal: 'push X', chatId: 'oc_main', rootMessageId: 'om_root', senderOpenId: OWNER,
  seats: [{ auto: true, role: 'main' }, { auto: true, role: 'collab' }], requestKey: 'k1',
  ...over,
});

function deps(over: Partial<EnsureSpawnDeps> = {}): { d: EnsureSpawnDeps; calls: any; store: Map<string, CeoSpawnState> } {
  const store = new Map<string, CeoSpawnState>();
  const calls = { spawn: 0, cloneInChat: 0, activate: 0, registerActivatedBot: 0, ensureCloneScopesProvisioned: 0, ensureCloneOncall: 0, verifyCloneIntegrity: 0, isInChat: 0, addBotToChat: 0, addBotToSubTask: 0, lateKickoff: 0, preheat: 0, replies: [] as string[], order: [] as string[], lateKickoffArgs: [] as any[], preheatArgs: [] as any[], cloneArgs: [] as any[], scopeGateArgs: [] as any[], oncallArgs: [] as any[], integrityArgs: [] as any[] };
  const d: EnsureSpawnDeps = {
    getOwnerOpenId: () => OWNER,
    // default auto target = the claude 本体 (cli_main); pool has only the 本体 ready.
    resolveAutoTarget: () => ({ cliId: 'claude-code', bentiAppId: 'cli_main' }),
    usableAppsByCli: (cliId) => (cliId === 'claude-code' ? ['cli_main'] : []),
    cloneTier: () => 'full',
    botOpenIdReady: (id) => (id === 'cli_main' ? 'ou_main' : undefined),
    displayNameForApp: (id) => (id === 'cli_new' ? '克劳德（初号机）' : undefined),
    spawnSubtask: async ({ bots }) => { calls.spawn++; return { taskId: 'st_1', chatId: 'oc_sub', bots }; },
    cloneInChat: async (a) => { calls.cloneInChat++; calls.cloneArgs.push(a); return { ok: true, appId: 'cli_new' }; },
    activationApproved: () => false,
    activate: async () => { calls.activate++; calls.order.push('activate'); return { ok: true }; },
    registerActivatedBot: async () => { calls.registerActivatedBot++; calls.order.push('register'); return { ok: true }; },
    ensureCloneScopesProvisioned: async (a) => { calls.ensureCloneScopesProvisioned++; calls.order.push('scopeGate'); calls.scopeGateArgs.push(a); },
    isInChat: async () => { calls.isInChat++; calls.order.push('isInChat'); return false; },
    addBotToChat: async () => { calls.addBotToChat++; return { ok: true }; },
    ensureCloneOncall: async (chatId, appId) => { calls.ensureCloneOncall++; calls.order.push('oncall'); calls.oncallArgs.push({ chatId, appId }); return { ok: true }; },
    addBotToSubTask: async () => { calls.addBotToSubTask++; },
    lateKickoff: async (a) => { calls.lateKickoff++; calls.lateKickoffArgs.push(a); },
    preheatConfirmOnline: async (t) => { calls.preheat++; calls.preheatArgs.push(t); return { ok: true, wakeId: 'wake_test', attempts: 1 }; },
    verifyCloneIntegrity: async (t) => { calls.verifyCloneIntegrity++; calls.integrityArgs.push(t); return { ok: true, checks: [] }; },
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
      usableAppsByCli: (cliId) => (cliId === 'claude-code' ? ['cli_main', 'cli_clone'] : []),
      botOpenIdReady: (id) => (id === 'cli_main' || id === 'cli_clone' ? `ou_${id}` : undefined),
    });
    const out = await ensureClonesAndSpawn(baseReq(), d);
    expect(out.status).toBe('spawned');
    if (out.status !== 'spawned') return;
    expect(calls.spawn).toBe(1);
    expect(calls.cloneInChat).toBe(0);
    expect(out.bots).toEqual(['cli_main:main', 'cli_clone:collab']);
  });

  it('块8 B1: a seat with cloneName is FORCE-cloned (skips ready pool) and cloneInChat receives the name', async () => {
    // cli_main is READY for claude-code, yet the named seat must NOT reuse it.
    const { d, calls } = deps({
      usableAppsByCli: (cliId) => (cliId === 'claude-code' ? ['cli_main'] : []),
      botOpenIdReady: (id) => (id === 'cli_main' ? 'ou_main' : undefined),
    });
    const out = await ensureClonesAndSpawn(
      baseReq({ seats: [{ auto: true, role: 'collab', cloneName: '评审甲' }] }), d,
    );
    expect(out.status).toBe('awaiting_activation'); // a clone was needed (not filled from pool)
    expect(calls.spawn).toBe(1);
    expect(calls.cloneInChat).toBe(1);              // forced clone despite a ready bot
    expect(calls.cloneArgs[0].cloneName).toBe('评审甲');
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

  it('integrity gate passes before subtask registration; no second preheat after addBotToSubTask', async () => {
    let approved = false, activated = false;
    const { d, calls } = deps({
      activationApproved: () => approved,
      activate: async () => { calls.activate++; activated = true; return { ok: true }; },
      botOpenIdReady: (id) => (id === 'cli_main' ? 'ou_main' : (id === 'cli_new' && activated ? 'ou_new' : undefined)),
    });
    await ensureClonesAndSpawn(baseReq(), d);
    approved = true;
    const out = await ensureClonesAndSpawn(baseReq(), d);
    expect(out.status).toBe('spawned');
    expect(calls.verifyCloneIntegrity).toBe(1);
    expect(calls.ensureCloneOncall).toBe(1);
    expect(calls.preheat).toBe(0);
    expect(calls.addBotToSubTask).toBe(1);
    expect(calls.lateKickoff).toBe(1);
    expect(calls.replies.some((m: string) => m.includes('未确认上线'))).toBe(false);
  });

  it('second preheat failure is impossible in orchestration: preheat dependency is not called after gate ok', async () => {
    let approved = false, activated = false;
    const { d, calls } = deps({
      activationApproved: () => approved,
      activate: async () => { calls.activate++; activated = true; return { ok: true }; },
      botOpenIdReady: (id) => (id === 'cli_main' ? 'ou_main' : (id === 'cli_new' && activated ? 'ou_new' : undefined)),
      preheatConfirmOnline: async () => { calls.preheat++; return { ok: false, wakeId: 'w_x', attempts: 3 }; },
    });
    await ensureClonesAndSpawn(baseReq(), d);
    approved = true;
    const out = await ensureClonesAndSpawn(baseReq(), d);
    expect(out.status).toBe('spawned');
    expect(calls.preheat).toBe(0);
    expect(calls.addBotToSubTask).toBe(1);
    expect(calls.lateKickoff).toBe(1);
  });

  it('clone integrity gate failure blocks before subtask registration and kickoff', async () => {
    let approved = false, activated = false;
    const { d, calls } = deps({
      activationApproved: () => approved,
      activate: async () => { calls.activate++; activated = true; return { ok: true }; },
      botOpenIdReady: (id) => (id === 'cli_main' ? 'ou_main' : (id === 'cli_new' && activated ? 'ou_new' : undefined)),
      verifyCloneIntegrity: async (t) => {
        calls.verifyCloneIntegrity++;
        calls.integrityArgs.push(t);
        return { ok: false, checks: [{ item: 'direct_mention', status: 'blocked', detail: 'no ack' }] as any };
      },
    });
    await ensureClonesAndSpawn(baseReq(), d);
    approved = true;
    const out = await ensureClonesAndSpawn(baseReq(), d);
    expect(out.status).toBe('awaiting_clone_join');
    expect(calls.verifyCloneIntegrity).toBe(1);
    expect(calls.ensureCloneOncall).toBe(1);
    expect(calls.integrityArgs[0]).toMatchObject({ taskId: 'st_1', subgroupChatId: 'oc_sub', appId: 'cli_new', bentiAppId: 'cli_main' });
    expect(calls.addBotToSubTask).toBe(0);
    expect(calls.lateKickoff).toBe(0);
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
    expect(calls.ensureCloneOncall).toBe(0);
    expect(calls.addBotToSubTask).toBe(0); // 守点4: no store change before chat add succeeds
    expect(calls.lateKickoff).toBe(0);
  });

  it('oncall bind failure after chat join is retryable even when re-entry sees clone already in chat', async () => {
    let activated = false;
    let inChat = false;
    let oncallAttempts = 0;
    const { d, calls } = deps({
      activationApproved: () => true,
      activate: async () => { calls.activate++; activated = true; return { ok: true }; },
      botOpenIdReady: (id) => (id === 'cli_main' ? 'ou_main' : (id === 'cli_new' && activated ? 'ou_new' : undefined)),
      isInChat: async () => { calls.isInChat++; return inChat; },
      addBotToChat: async () => { calls.addBotToChat++; inChat = true; return { ok: true }; },
      ensureCloneOncall: async (chatId, appId) => {
        calls.ensureCloneOncall++;
        calls.oncallArgs.push({ chatId, appId });
        oncallAttempts++;
        return oncallAttempts === 1 ? { ok: false, error: 'lock_busy' } : { ok: true };
      },
    });

    const first = await ensureClonesAndSpawn(baseReq(), d);
    expect(first.status).toBe('awaiting_clone_join');
    expect(calls.addBotToChat).toBe(1);
    expect(calls.ensureCloneOncall).toBe(1);
    expect(calls.verifyCloneIntegrity).toBe(0);

    const second = await ensureClonesAndSpawn(baseReq(), d);
    expect(second.status).toBe('spawned');
    expect(calls.addBotToChat).toBe(1); // already in chat, so no duplicate invite
    expect(calls.ensureCloneOncall).toBe(2); // but bind is retried
    expect(calls.verifyCloneIntegrity).toBe(1);
    expect(calls.addBotToSubTask).toBe(1);
  });

  it('Phase B scope gate fails before addBotToChat → awaiting_clone_join, no chat add/store/kickoff', async () => {
    let activated = false;
    const { d, calls } = deps({
      activationApproved: () => true,
      activate: async () => { calls.activate++; activated = true; return { ok: true }; },
      botOpenIdReady: (id) => (id === 'cli_main' ? 'ou_main' : (id === 'cli_new' && activated ? 'ou_new' : undefined)),
      ensureCloneScopesProvisioned: async (a) => {
        calls.ensureCloneScopesProvisioned++;
        calls.order.push('scopeGate');
        calls.scopeGateArgs.push(a);
        throw new Error('clone cli_new missing required scopes: im:message.group_msg');
      },
    });
    const out = await ensureClonesAndSpawn(baseReq(), d);
    expect(out.status).toBe('awaiting_clone_join');
    expect(calls.scopeGateArgs[0]).toMatchObject({
      chatId: 'oc_sub',
      appId: 'cli_new',
      displayName: '克劳德（初号机）',
      role: 'collab',
    });
    expect(calls.addBotToChat).toBe(0);
    expect(calls.addBotToSubTask).toBe(0);
    expect(calls.lateKickoff).toBe(0);
    expect(calls.isInChat).toBe(0);
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

  // blocker2: orchestration fills seats in the pool's order; the 本体-first
  // guarantee is the service's usableAppsByCli sort (本体 before clones), so the
  // injected pool here is already 本体-first and auto:main lands on the 本体.
  it('pool is 本体-first (cli_main before clone) → auto:main = 本体, clone → collab', async () => {
    const { d } = deps({
      usableAppsByCli: (cliId) => (cliId === 'claude-code' ? ['cli_main', 'cli_c0'] : []),
      botOpenIdReady: (id) => (id === 'cli_main' || id === 'cli_c0' ? `ou_${id}` : undefined),
    });
    const out = await ensureClonesAndSpawn(baseReq(), d);
    expect(out.status).toBe('spawned');
    if (out.status !== 'spawned') return;
    expect(out.bots).toEqual(['cli_main:main', 'cli_c0:collab']); // 本体 main, then clone
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

  // round-3 追加 (hot-register): registerActivatedBot runs after activate, before membership/oncall gates.
  it('round-3: registerActivatedBot runs AFTER activate and BEFORE membership/oncall gates', async () => {
    let activated = false;
    const { d, calls } = deps({
      activationApproved: () => true,
      activate: async () => { calls.activate++; calls.order.push('activate'); activated = true; return { ok: true }; },
      botOpenIdReady: (id) => (id === 'cli_main' ? 'ou_main' : (id === 'cli_new' && activated ? 'ou_new' : undefined)),
    });
    const out = await ensureClonesAndSpawn(baseReq(), d);
    expect(out.status).toBe('spawned');
    expect(calls.order).toEqual(['activate', 'register', 'scopeGate', 'isInChat', 'oncall']);
  });

  it('round-3: registerActivatedBot failure → awaiting_clone_join (retryable), never reaches isInChat', async () => {
    let activated = false;
    const { d, calls } = deps({
      activationApproved: () => true,
      activate: async () => { calls.activate++; activated = true; return { ok: true }; },
      botOpenIdReady: (id) => (id === 'cli_main' ? 'ou_main' : (id === 'cli_new' && activated ? 'ou_new' : undefined)),
      registerActivatedBot: async () => { calls.registerActivatedBot++; return { ok: false, error: 'not_a_clone' }; },
    });
    const out = await ensureClonesAndSpawn(baseReq(), d);
    expect(out.status).toBe('awaiting_clone_join');
    expect(calls.isInChat).toBe(0);
    expect(calls.addBotToChat).toBe(0);
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

describe('ensureClonesAndSpawn (Round-4: bot-agnostic engine grouping)', () => {
  // Per-engine pools fill independently: a codex auto seat draws from the codex
  // pool, a claude auto seat from the claude pool — never cross.
  it('mixed engines: each auto seat fills from ITS engine pool', async () => {
    const { d, calls } = deps({
      seats: undefined as any, // set via req below
      resolveAutoTarget: (t) => t === 'codex'
        ? { cliId: 'codex', bentiAppId: 'cli_kbenti' }
        : { cliId: 'claude-code', bentiAppId: 'cli_main' },
      usableAppsByCli: (cliId) => cliId === 'codex' ? ['cli_kbenti'] : cliId === 'claude-code' ? ['cli_main'] : [],
      botOpenIdReady: (id) => (id === 'cli_main' || id === 'cli_kbenti' ? `ou_${id}` : undefined),
    });
    const out = await ensureClonesAndSpawn(baseReq({
      seats: [{ auto: true, role: 'main' }, { auto: true, autoTarget: 'codex', role: 'collab' }],
    }), d);
    expect(out.status).toBe('spawned');
    if (out.status !== 'spawned') return;
    expect(out.bots).toEqual(['cli_main:main', 'cli_kbenti:collab']);
    expect(calls.cloneInChat).toBe(0);
  });

  // codex pool exhausted → clone a codex; cloneInChat gets the codex 本体 as source.
  it('codex auto seat, pool empty → clones codex 本体 (source = codex 本体, not CEO)', async () => {
    const { d, calls } = deps({
      resolveAutoTarget: () => ({ cliId: 'codex', bentiAppId: 'cli_kbenti' }),
      usableAppsByCli: () => [], // no ready codex → must clone
    });
    const out = await ensureClonesAndSpawn(baseReq({
      seats: [{ auto: true, autoTarget: 'codex', role: 'collab' }],
    }), d);
    expect(out.status).toBe('awaiting_activation');
    expect(calls.cloneInChat).toBe(1);
    expect(calls.cloneArgs[0]).toMatchObject({ sourceCliId: 'codex', sourceBentiAppId: 'cli_kbenti' });
  });

  // No cloneHome at all (tier undefined) needing a clone → refuse BEFORE building.
  it('auto@<engine> needs clone but engine has no cloneHome → refused, no subgroup/clone/store', async () => {
    const { d, calls, store } = deps({
      resolveAutoTarget: () => ({ cliId: 'gemini', bentiAppId: 'cli_gembenti' }),
      usableAppsByCli: () => [], // no ready → would need a clone
      cloneTier: (cliId) => cliId === 'gemini' ? undefined : 'full',
    });
    const out = await ensureClonesAndSpawn(baseReq({
      seats: [{ auto: true, autoTarget: 'gemini', role: 'collab' }],
    }), d);
    expect(out.status).toBe('refused');
    expect(calls.spawn).toBe(0);
    expect(calls.cloneInChat).toBe(0);
    expect(store.get('k1')).toBeUndefined();
  });

  // 蔻黛 coco guardrail 2: DEFAULT auto (no explicit target) must NEVER select a
  // state-only engine — refuse at plan time, even if a ready one exists.
  it('default auto resolving to a state-only engine → refused, no subgroup', async () => {
    const { d, calls } = deps({
      // default target (autoTarget undefined) resolves to a state-only engine.
      resolveAutoTarget: () => ({ cliId: 'coco', bentiAppId: 'cli_cocobenti' }),
      usableAppsByCli: (cliId) => cliId === 'coco' ? ['cli_cocobenti'] : [], // even ready
      cloneTier: (cliId) => cliId === 'coco' ? 'state-only' : 'full',
      botOpenIdReady: (id) => (id === 'cli_cocobenti' ? 'ou_coco' : undefined),
    });
    const out = await ensureClonesAndSpawn(baseReq({ seats: [{ auto: true, role: 'collab' }] }), d);
    expect(out.status).toBe('refused');
    expect(calls.spawn).toBe(0);
  });

  // EXPLICIT auto@coco → state-only IS allowed (owner opt-in) → clones coco 本体.
  it('explicit auto@coco (state-only) → allowed, clones coco 本体', async () => {
    const { d, calls } = deps({
      resolveAutoTarget: () => ({ cliId: 'coco', bentiAppId: 'cli_cocobenti' }),
      usableAppsByCli: () => [], // no ready coco → clone
      cloneTier: (cliId) => cliId === 'coco' ? 'state-only' : 'full',
    });
    const out = await ensureClonesAndSpawn(baseReq({
      seats: [{ auto: true, autoTarget: 'coco', role: 'collab' }],
    }), d);
    expect(out.status).toBe('awaiting_activation');
    expect(calls.cloneInChat).toBe(1);
    expect(calls.cloneArgs[0]).toMatchObject({ sourceCliId: 'coco', sourceBentiAppId: 'cli_cocobenti' });
    // state-only tier surfaced in the build notice
    expect(calls.replies.some(m => /state-only/.test(m))).toBe(true);
  });

  // Explicit ref to a ready state-only bot (coco:collab) → fills seat, no clone.
  it('explicit ref coco:collab (ready) → fills seat, no clone', async () => {
    const { d, calls } = deps({ cloneTier: (cliId) => cliId === 'coco' ? 'state-only' : 'full' });
    const out = await ensureClonesAndSpawn(baseReq({ seats: [{ ref: 'coco', role: 'collab' }] }), d);
    expect(out.status).toBe('spawned');
    if (out.status !== 'spawned') return;
    expect(out.bots).toEqual(['coco:collab']);
    expect(calls.cloneInChat).toBe(0);
  });

  // Unresolvable autoTarget → refuse before building anything.
  it('unknown autoTarget → refused, no subgroup', async () => {
    const { d, calls } = deps({
      resolveAutoTarget: () => ({ error: '未知的 bot/引擎 "nope"' }),
    });
    const out = await ensureClonesAndSpawn(baseReq({
      seats: [{ auto: true, autoTarget: 'nope', role: 'main' }],
    }), d);
    expect(out.status).toBe('refused');
    expect(calls.spawn).toBe(0);
  });

  // Blocker3: a pending clone persisted before Round-4 (no cliId/bentiAppId) must
  // migrate to the default target, not call cloneInChat with undefined source.
  it('old pending state (no cliId/bentiAppId) → migrates to default target, then clones', async () => {
    const { d, calls, store } = deps({ activationApproved: () => false });
    store.set('k1', {
      key: 'k1', taskId: 'st_old', subgroupChatId: 'oc_old',
      pendingClones: [{ seatIndex: 0, role: 'collab', phase: 'pending' } as any], updatedAt: '',
    });
    const out = await ensureClonesAndSpawn(baseReq(), d);
    expect(out.status).toBe('awaiting_activation');
    expect(calls.cloneInChat).toBe(1);
    expect(calls.cloneArgs[0]).toMatchObject({ sourceCliId: 'claude-code', sourceBentiAppId: 'cli_main' });
    expect(store.get('k1')?.pendingClones[0].cliId).toBe('claude-code');
  });

  // Blocker3: if even the default target can't resolve → clear state + visible error (never clone undefined).
  it('old pending state + unresolvable default → clears state, error, no clone', async () => {
    const { d, calls, store } = deps({ resolveAutoTarget: () => ({ error: '没有可用本体' }) });
    store.set('k1', {
      key: 'k1', taskId: 'st_old', subgroupChatId: 'oc_old',
      pendingClones: [{ seatIndex: 0, role: 'collab', phase: 'pending' } as any], updatedAt: '',
    });
    const out = await ensureClonesAndSpawn(baseReq(), d);
    expect(out.status).toBe('error');
    expect(calls.cloneInChat).toBe(0);
    expect(store.get('k1')).toBeUndefined();
  });

  // Explicit ref seats pass through untouched (no resolution, no clone).
  it('explicit ref seat → passthrough, no resolveAutoTarget/clone', async () => {
    let resolveCalls = 0;
    const { d, calls } = deps({
      resolveAutoTarget: () => { resolveCalls++; return { cliId: 'claude-code', bentiAppId: 'cli_main' }; },
      usableAppsByCli: () => [],
    });
    const out = await ensureClonesAndSpawn(baseReq({
      seats: [{ ref: 'codex', role: 'main' }, { ref: '缇蕾', role: 'observer' }],
    }), d);
    expect(out.status).toBe('spawned');
    if (out.status !== 'spawned') return;
    expect(out.bots).toEqual(['codex:main', '缇蕾:observer']);
    expect(resolveCalls).toBe(0);
    expect(calls.cloneInChat).toBe(0);
  });
});
