/**
 * Card-driven model switch v2 — the picker is a STATE of the main streaming
 * card, patched in place (owner decision 2026-09-05). Driven through the REAL
 * `handleModelSwitchCardAction`; daemon seams (restart primitives, card patch,
 * worker input, store, registry) are faked at the module boundary. Every
 * refusal asserts ZERO mutation (session record AND panel) and ZERO restart.
 *
 * Run:  pnpm vitest run test/model-switch-card.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const getBotMock = vi.fn();
vi.mock('../src/bot-registry.js', async (io) => ({ ...(await io() as object), getBot: (...a: unknown[]) => getBotMock(...a) }));
const updateSessionMock = vi.fn();
vi.mock('../src/services/session-store.js', async (io) => ({ ...(await io() as object), updateSession: (...a: unknown[]) => updateSessionMock(...a) }));
const switchMock = vi.fn();
const forceRollbackMock = vi.fn();
const restartMock = vi.fn();
const patchMock = vi.fn();
const inputMock = vi.fn(() => true);
const sessionInputMock = vi.fn(() => true);
let activeAttempt: string | undefined;
vi.mock('../src/core/worker-pool.js', async (io) => ({
  ...(await io() as object),
  requestModelSwitchRestart: (...a: unknown[]) => switchMock(...a),
  requestModelSwitchForceRollback: (...a: unknown[]) => forceRollbackMock(...a),
  requestSessionRestart: (...a: unknown[]) => restartMock(...a),
  activeSessionRestartAttemptId: () => activeAttempt,
  isSessionTransferring: () => false,
  // The real builder needs the registry/terminal; render a faithful stand-in
  // that exposes the panel so tests can assert the card state.
  buildStreamingCardJson: (ds: any) => JSON.stringify({ panel: ds.modelPanel ?? null, displayMode: ds.displayMode ?? 'hidden' }),
  scheduleCardPatch: (...a: unknown[]) => patchMock(...a),
  sendWorkerInput: (...a: unknown[]) => inputMock(...a),
  sendWorkerSessionInput: (...a: unknown[]) => sessionInputMock(...a),
}));

import { handleModelSwitchCardAction, collapseModelPanel, MODEL_SWITCH_CARD_ACTIONS, __testOnly_resetPendingConfirms, type ModelSwitchCardContext } from '../src/im/lark/model-switch-card.js';
import { setChatExternal, _resetChatExternalCacheForTests } from '../src/im/lark/chat-external-cache.js';

const CANDIDATES = ['gpt-5.5', 'gpt-5.6-sol'];
function ctx(over: Partial<ModelSwitchCardContext> & { session?: Record<string, unknown>; ds?: Record<string, unknown>; value?: Record<string, any> } = {}): ModelSwitchCardContext {
  const ds: any = {
    session: { sessionId: 's1', cliId: 'codex', backendType: 'pty', ...(over.session ?? {}) },
    larkAppId: 'app', chatId: 'oc_1', chatType: 'group', worker: { killed: false, send: vi.fn() }, workerGeneration: 1,
    lastScreenStatus: 'idle',
    ...(over.ds ?? {}),
  };
  return {
    ds, operatorOpenId: 'ou_human', rootId: 'om_root', larkAppId: 'app',
    value: { action: 'model_menu_open', ...(over.value ?? {}) },
    action: undefined,
    sessionReply: vi.fn(async () => 'om_x'),
    identity: { resolveOperator: async () => ({ unionId: 'on_human', openId: 'ou_human' }), isBotUnionId: () => false, canOperate: () => true, isOwnerOperator: (_app: string, op: { unionId: string }) => op.unionId === 'on_human' || op.unionId === 'on_real_human', ...(over.identity ?? {}) },
    catalog: over.catalog ?? (async () => ({ models: CANDIDATES, source: 'live' })),
    ...('operatorOpenId' in over ? { operatorOpenId: over.operatorOpenId } : {}),
  };
}
/** Same session object across hops (the picker state lives on ds). */
function sameDs(c: ModelSwitchCardContext, value: Record<string, any>, over: Partial<ModelSwitchCardContext> = {}): ModelSwitchCardContext {
  return { ...c, ...over, value };
}
const snapshot = (c: ModelSwitchCardContext) => JSON.stringify({ s: c.ds.session, p: c.ds.modelPanel ?? null });
const expectZeroMutation = (c: ModelSwitchCardContext, before: string) => {
  expect(snapshot(c)).toBe(before);
  expect(updateSessionMock).not.toHaveBeenCalled();
  expect(switchMock).not.toHaveBeenCalled();
  expect(forceRollbackMock).not.toHaveBeenCalled();
  expect(restartMock).not.toHaveBeenCalled();
};
const panelOf = (r: any) => (r && 'panel' in r ? r.panel : undefined);
const findConfirmValue = (r: any) => {
  // the confirm button carries menu_id = offerId; reconstruct the value the real card would carry
  const p = panelOf(r); return { action: 'model_pick_confirm', ...(p.target.model !== undefined ? { model: p.target.model } : {}), ...(p.target.effort !== undefined ? { effort: p.target.effort } : {}), root_id: 'om_root', session_id: 's1', cli_id: 'codex', menu_id: p.offerId };
};

beforeEach(() => {
  getBotMock.mockReset(); getBotMock.mockReturnValue({ config: { cliId: 'codex' } });
  updateSessionMock.mockReset(); switchMock.mockReset(); forceRollbackMock.mockReset(); restartMock.mockReset(); patchMock.mockReset(); inputMock.mockClear(); sessionInputMock.mockClear();
  activeAttempt = undefined;
  _resetChatExternalCacheForTests(); setChatExternal('app', 'oc_1', false);
  __testOnly_resetPendingConfirms();
});

// ─── identity gate ─────────────────────────────────────────────────────────
describe('shared identity gate (P1-2) + owner-only (2026-09-05)', () => {
  const REFUSALS: Array<[string, Partial<ModelSwitchCardContext> & { session?: any; ds?: any }]> = [
    ['missing operator open_id', { operatorOpenId: undefined }],
    ['operator open_id not ou_', { operatorOpenId: 'on_abc' }],
    ['union id absent', { identity: { resolveOperator: async () => ({ openId: 'ou_human' }), isBotUnionId: () => false, canOperate: () => true } }],
    ['union id malformed', { identity: { resolveOperator: async () => ({ unionId: 'ou_notunion' }), isBotUnionId: () => false, canOperate: () => true } }],
    ['resolve throws', { identity: { resolveOperator: async () => { throw new Error('api'); }, isBotUnionId: () => false, canOperate: () => true } }],
    ['team / platform bot', { identity: { resolveOperator: async () => ({ unionId: 'on_bot' }), isBotUnionId: (u: string) => u === 'on_bot', canOperate: () => true } }],
    ['canOperate false', { identity: { resolveOperator: async () => ({ unionId: 'on_human' }), isBotUnionId: () => false, canOperate: () => false } }],
    ['verified human but NOT a bot owner (owner-only, 2026-09-05)', { identity: { resolveOperator: async () => ({ unionId: 'on_other_human' }), isBotUnionId: () => false, canOperate: () => true } }],
    ['owner check throws (fail-closed)', { identity: { resolveOperator: async () => ({ unionId: 'on_human' }), isBotUnionId: () => false, canOperate: () => true, isOwnerOperator: () => { throw new Error('registry'); } } }],
    ['adopt session', { ds: { initConfig: { adoptMode: true } } }],
    ['remote backend', { session: { backendType: 'riff', cliId: 'riff' } }],
    ['unsupported (ttadk-coco wrapper-first)', { session: { cliId: 'coco', wrapperCli: 'ttadk coco' } }],
  ];
  for (const [name, over] of REFUSALS) {
    for (const action of MODEL_SWITCH_CARD_ACTIONS) {
      it(`${action}: ${name} → refused, zero mutation, no panel`, async () => {
        const c = ctx({ ...over, value: { action, model: 'gpt-5.5', effort: 'high' } });
        const before = snapshot(c);
        const r: any = await handleModelSwitchCardAction(c);
        expect(r?.toast?.type).toBe('warning');
        expectZeroMutation(c, before);
        expect(c.ds.modelPanel).toBeUndefined();
        expect(patchMock).not.toHaveBeenCalled();
      });
    }
  }
  it('external / unknown chat → refused even for a verified human', async () => {
    _resetChatExternalCacheForTests();
    let c = ctx(); let before = snapshot(c);
    expect((await handleModelSwitchCardAction(c) as any)?.toast?.type).toBe('warning'); expectZeroMutation(c, before);
    setChatExternal('app', 'oc_1', true);
    c = ctx(); before = snapshot(c);
    expect((await handleModelSwitchCardAction(c) as any)?.toast?.type).toBe('warning'); expectZeroMutation(c, before);
  });
});

// ─── in-card state machine ─────────────────────────────────────────────────
describe('in-card picker: open / refresh / close / mutual exclusion', () => {
  it('model_menu_open returns the SAME card re-rendered in list state (no new card, no DM)', async () => {
    const c = ctx();
    const r: any = await handleModelSwitchCardAction(c);
    expect(panelOf(r)).toMatchObject({ kind: 'list', models: CANDIDATES, source: 'live', freshThread: false, restartInFlight: false });
    expect(panelOf(r).currentEffort).toBeUndefined();
    expect(Array.isArray(panelOf(r).efforts)).toBe(true); // codex default effort domain even before a pin
    expect(c.sessionReply).not.toHaveBeenCalled();  // nothing posted
    expect(c.ds.modelPanel?.kind).toBe('list');
  });
  it('list shows the effort row for codex when a current model is known, marks current', async () => {
    const c = ctx({ session: { modelPin: { model: 'gpt-5.6-sol', cliId: 'codex', txnId: 't', setBy: 'x', setAt: 1 }, reasoningEffort: 'high' } });
    const r: any = await handleModelSwitchCardAction(c);
    expect(panelOf(r)).toMatchObject({ currentModel: 'gpt-5.6-sol', currentEffort: 'high' });
    expect(panelOf(r).efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  });
  it('opening the picker collapses 「显示输出」 (mutual exclusion) and tells the worker', async () => {
    const c = ctx({ ds: { displayMode: 'screenshot' } });
    await handleModelSwitchCardAction(c);
    expect(c.ds.displayMode).toBe('hidden');
    expect(sessionInputMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'set_display_mode', mode: 'hidden' }));
  });
  it('refresh forces the catalog probe with per-bot scope; open does not', async () => {
    const calls: any[] = [];
    const catalog = async (key: string, opts: any) => { calls.push([key, opts]); return { models: CANDIDATES, source: 'live' as const }; };
    await handleModelSwitchCardAction(ctx({ catalog, value: { action: 'model_menu_refresh' } }));
    await handleModelSwitchCardAction(ctx({ catalog, value: { action: 'model_menu_open' } }));
    expect(calls[0][0]).toBe('codex');
    expect(calls[0][1]).toMatchObject({ force: true, scope: 'app' });
    expect(calls[1][1]).toMatchObject({ force: false, scope: 'app' });
  });
  it('model_menu_close collapses the panel and re-renders the plain card', async () => {
    const c = ctx();
    await handleModelSwitchCardAction(c);
    const r: any = await handleModelSwitchCardAction(sameDs(c, { action: 'model_menu_close' }));
    expect(panelOf(r)).toBeNull();
    expect(c.ds.modelPanel).toBeUndefined();
  });
  it('a restart in flight renders the list with buttons disabled and refuses picks', async () => {
    activeAttempt = 'other';
    const c = ctx();
    const r: any = await handleModelSwitchCardAction(c);
    expect(panelOf(r).restartInFlight).toBe(true);
    const before = snapshot(c);
    expect((await handleModelSwitchCardAction(sameDs(c, { action: 'model_pick', model: 'gpt-5.5' })) as any)?.toast?.type).toBe('warning');
    expect(snapshot(c)).toBe(before);
  });
  it('custom entry is not offered in v2 (info toast, no mutation)', async () => {
    const c = ctx({ value: { action: 'model_custom_open' } });
    const before = snapshot(c);
    expect((await handleModelSwitchCardAction(c) as any)?.toast?.type).toBe('info');
    expect(snapshot(c)).toBe(before);
  });
});

describe('pick → confirm (in-card) → switching', () => {
  it('model_pick on a current candidate enters the confirm state with a server-side offer', async () => {
    const c = ctx();
    await handleModelSwitchCardAction(c);
    const r: any = await handleModelSwitchCardAction(sameDs(c, { action: 'model_pick', model: 'gpt-5.6-sol' }));
    expect(panelOf(r)).toMatchObject({ kind: 'confirm', target: { model: 'gpt-5.6-sol' }, reason: 'plain' });
    expect(panelOf(r).offerId).toMatch(/^[0-9a-f]{16}$/);
    expect(switchMock).not.toHaveBeenCalled();
  });
  it('busy session → confirm reason busy; codex-app → reason fresh', async () => {
    const busy = ctx({ ds: { lastScreenStatus: 'working' } });
    let r: any = await handleModelSwitchCardAction(sameDs(busy, { action: 'model_pick', model: 'gpt-5.6-sol' }));
    expect(panelOf(r).reason).toBe('busy');
    getBotMock.mockReturnValue({ config: { cliId: 'codex-app' } });
    const app = ctx({ session: { cliId: 'codex-app' } });
    r = await handleModelSwitchCardAction(sameDs(app, { action: 'model_pick', model: 'gpt-5.6-sol' }));
    expect(panelOf(r).reason).toBe('fresh');
  });
  it('a value NOT in the current candidates is refused (stale / forged), zero mutation', async () => {
    const c = ctx({ value: { action: 'model_pick', model: 'gpt-9-forged' } });
    const before = snapshot(c);
    expect((await handleModelSwitchCardAction(c) as any)?.toast?.type).toBe('warning');
    expectZeroMutation(c, before);
  });
  it('confirm (replaying the real button value) starts the switch and shows switching', async () => {
    switchMock.mockReturnValue({ ok: true, attemptId: 'A1', txn: { target: { model: 'gpt-5.6-sol' }, rollback: {} } });
    const c = ctx();
    const conf: any = await handleModelSwitchCardAction(sameDs(c, { action: 'model_pick', model: 'gpt-5.6-sol' }));
    const r: any = await handleModelSwitchCardAction(sameDs(c, findConfirmValue(conf)));
    expect(panelOf(r)).toMatchObject({ kind: 'switching', target: { model: 'gpt-5.6-sol' }, attemptId: 'A1' });
    expect(switchMock).toHaveBeenCalledTimes(1);
    expect(switchMock.mock.calls[0][1]).toMatchObject({ model: 'gpt-5.6-sol', setBy: 'ou_human' });
  });
  it('cancel from confirm goes back to the list', async () => {
    const c = ctx();
    await handleModelSwitchCardAction(sameDs(c, { action: 'model_pick', model: 'gpt-5.6-sol' }));
    const r: any = await handleModelSwitchCardAction(sameDs(c, { action: 'model_menu_open' }));
    expect(panelOf(r).kind).toBe('list');
  });
  it('a confirmation without an exact matching offer is refused: no id / wrong id / tampered model / other operator / replay', async () => {
    switchMock.mockReturnValue({ ok: true, attemptId: 'A1', txn: { target: {}, rollback: {} } });
    const c = ctx();
    const conf: any = await handleModelSwitchCardAction(sameDs(c, { action: 'model_pick', model: 'gpt-5.6-sol' }));
    const good = findConfirmValue(conf);
    const bad: Array<[string, Record<string, any>, Partial<ModelSwitchCardContext>]> = [
      ['no menu_id', { ...good, menu_id: undefined }, {}],
      ['wrong menu_id', { ...good, menu_id: 'ffffffffffffffff' }, {}],
      ['tampered model', { ...good, model: 'gpt-5.5' }, {}],
      ['other operator (also a bot owner)', good, { operatorOpenId: 'ou_other', identity: { resolveOperator: async () => ({ unionId: 'on_other' }), isBotUnionId: () => false, canOperate: () => true, isOwnerOperator: () => true } }],
    ];
    for (const [name, value, over] of bad) {
      const before = snapshot(c);
      expect((await handleModelSwitchCardAction(sameDs(c, value, over)) as any)?.toast?.type, name).toBe('warning');
      expect(snapshot(c), name).toBe(before);
      expect(switchMock, name).not.toHaveBeenCalled();
    }
    expect(panelOf(await handleModelSwitchCardAction(sameDs(c, good))).kind).toBe('switching');
    // replay after consumption
    c.ds.modelPanel = undefined;
    const before = snapshot(c);
    expect((await handleModelSwitchCardAction(sameDs(c, good)) as any)?.toast?.type).toBe('warning');
    expect(snapshot(c)).toBe(before);
    expect(switchMock).toHaveBeenCalledTimes(1);
  });
  it('ABA: an older confirm cannot consume a newer offer for the same target', async () => {
    switchMock.mockReturnValue({ ok: true, attemptId: 'A1', txn: { target: {}, rollback: {} } });
    const c = ctx();
    const first: any = await handleModelSwitchCardAction(sameDs(c, { action: 'model_pick', model: 'gpt-5.6-sol' }));
    const second: any = await handleModelSwitchCardAction(sameDs(c, { action: 'model_pick', model: 'gpt-5.6-sol' }));
    expect(panelOf(first).offerId).not.toBe(panelOf(second).offerId);
    const before = snapshot(c);
    expect((await handleModelSwitchCardAction(sameDs(c, findConfirmValue(first))) as any)?.toast?.type).toBe('warning');
    expect(snapshot(c)).toBe(before);
    expect(panelOf(await handleModelSwitchCardAction(sameDs(c, findConfirmValue(second)))).kind).toBe('switching');
    expect(switchMock).toHaveBeenCalledTimes(1);
  });
  it('effort_pick within the domain enters confirm; outside is refused', async () => {
    const c = ctx({ session: { modelPin: { model: 'gpt-5.5', cliId: 'codex', txnId: 't', setBy: 'x', setAt: 1 } } });
    let before = snapshot(c);
    expect((await handleModelSwitchCardAction(sameDs(c, { action: 'effort_pick', effort: 'ultra' })) as any)?.toast?.type).toBe('warning');
    expect(snapshot(c)).toBe(before);
    const r: any = await handleModelSwitchCardAction(sameDs(c, { action: 'effort_pick', effort: 'high' }));
    expect(panelOf(r)).toMatchObject({ kind: 'confirm', target: { model: 'gpt-5.5', effort: 'high' } });
    before = snapshot(c); void before;
  });
  it('daemon refusal at confirm renders a failed line in the card (not a new card)', async () => {
    switchMock.mockReturnValue({ ok: false, reason: 'pane_alive' });
    const c = ctx();
    const conf: any = await handleModelSwitchCardAction(sameDs(c, { action: 'model_pick', model: 'gpt-5.6-sol' }));
    const r: any = await handleModelSwitchCardAction(sameDs(c, findConfirmValue(conf)));
    expect(panelOf(r).kind).toBe('failed');
    expect(panelOf(r).reason.length).toBeGreaterThan(3);
  });
});

describe('settlement patches the card in place', () => {
  async function switchAndSettle(outcome: 'committed' | 'rolled_back' | 'ambiguous', restartAccepted = true) {
    let onSettled: any;
    switchMock.mockImplementation((_ds: any, _t: any, obs: any) => { onSettled = obs.onSettled; return { ok: true, attemptId: 'A1', txn: { target: { model: 'gpt-5.6-sol' }, rollback: { model: 'gpt-5.5' } } }; });
    restartMock.mockReturnValue(restartAccepted ? { attemptId: 'R', joined: false } : undefined);
    const c = ctx();
    const conf: any = await handleModelSwitchCardAction(sameDs(c, { action: 'model_pick', model: 'gpt-5.6-sol' }));
    await handleModelSwitchCardAction(sameDs(c, findConfirmValue(conf)));
    patchMock.mockClear();
    await onSettled(outcome, { target: { model: 'gpt-5.6-sol' }, rollback: { model: 'gpt-5.5' } });
    return c;
  }
  it('committed → panel cleared, card patched, and "继续" is sent to the session automatically', async () => {
    const c = await switchAndSettle('committed');
    expect(c.ds.modelPanel).toBeUndefined();
    expect(patchMock).toHaveBeenCalledTimes(1);
    expect(inputMock).toHaveBeenCalledTimes(1);
    expect(inputMock.mock.calls[0][1]).toMatch(/继续|continue/);
  });
  it('rolled back → failed line in the card + process convergence restart; no auto-continue', async () => {
    const c = await switchAndSettle('rolled_back');
    expect(c.ds.modelPanel).toMatchObject({ kind: 'failed', target: { model: 'gpt-5.6-sol' } });
    expect(restartMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), { strict: true });
    expect(patchMock).toHaveBeenCalledTimes(1);
    expect(inputMock).not.toHaveBeenCalled();
  });
  it('rolled back with a refused convergence restart says so in the failure line', async () => {
    const c = await switchAndSettle('rolled_back', false);
    expect((c.ds.modelPanel as any).reason).toMatch(/未能自动收敛|could not be converged/);
  });
  it('ambiguous → ambiguous panel (recheck / force rollback) in the card', async () => {
    const c = await switchAndSettle('ambiguous');
    expect(c.ds.modelPanel).toMatchObject({ kind: 'ambiguous' });
    expect(patchMock).toHaveBeenCalledTimes(1);
  });
  it('a transient failed line is dismissed by 退出选择 (model_menu_close)', async () => {
    const c = await switchAndSettle('rolled_back');
    const r: any = await handleModelSwitchCardAction(sameDs(c, { action: 'model_menu_close' }));
    expect(panelOf(r)).toBeNull();
  });
});

describe('ambiguous exits (in-card)', () => {
  const amb = (extra: Record<string, unknown> = {}) => ({
    txnId: 'ms-1-A1', seq: 1, attemptId: 'A1', state: 'ambiguous', target: { model: 'gpt-5.6-sol', effort: 'xhigh' },
    rollback: { model: 'gpt-5.6-sol', reasoningEffort: 'high', pin: null }, startedAt: 1, setBy: 'x', ...extra,
  });
  it('any picker action while ambiguous renders the ambiguous panel first', async () => {
    const c = ctx({ session: { modelSwitchTxn: amb() } });
    const r: any = await handleModelSwitchCardAction(sameDs(c, { action: 'model_menu_open' }));
    expect(panelOf(r).kind).toBe('ambiguous');
  });
  it('recheck: same model but OLD effort attested → rolled back → failed line', async () => {
    const c = ctx({ session: {
      modelSwitchTxn: amb(), reasoningEffort: 'xhigh',
      modelPin: { model: 'gpt-5.6-sol', effort: 'xhigh', cliId: 'codex', txnId: 'ms-1-A1', setBy: 'x', setAt: 1 },
      launchAttestation: { model: 'gpt-5.6-sol', effort: 'high', effortProvenance: 'explicit', workerGeneration: 1 },
    }, value: { action: 'model_txn_recheck' } });
    const r: any = await handleModelSwitchCardAction(c);
    expect(panelOf(r).kind).toBe('failed');
    expect(c.ds.session.modelSwitchTxn).toBeUndefined();
    expect(c.ds.session.reasoningEffort).toBe('high');
  });
  it('recheck: attestation from an older generation → still ambiguous (toast), nothing persisted', async () => {
    const c = ctx({ session: { modelSwitchTxn: amb(), launchAttestation: { model: 'gpt-5.6-sol', effort: 'xhigh', effortProvenance: 'explicit', workerGeneration: 0 } }, value: { action: 'model_txn_recheck' } });
    expect((await handleModelSwitchCardAction(c) as any)?.toast?.type).toBe('warning');
    expect(c.ds.session.modelSwitchTxn.state).toBe('ambiguous');
    expect(updateSessionMock).not.toHaveBeenCalled();
  });
  it('force rollback: card shows switching(rolling back); daemon refusal keeps everything', async () => {
    forceRollbackMock.mockReturnValue({ ok: true, attemptId: 'R1', txn: amb({ state: 'rolling_back' }) });
    let c = ctx({ session: { modelSwitchTxn: amb() }, value: { action: 'model_txn_force_rollback' } });
    let r: any = await handleModelSwitchCardAction(c);
    expect(panelOf(r)).toMatchObject({ kind: 'switching', attemptId: 'R1', target: { model: 'gpt-5.6-sol', effort: 'high' } });
    forceRollbackMock.mockReturnValue({ ok: false, reason: 'restart_in_flight' });
    c = ctx({ session: { modelSwitchTxn: amb() }, value: { action: 'model_txn_force_rollback' } });
    const before = snapshot(c);
    r = await handleModelSwitchCardAction(c);
    expect(r?.toast?.type).toBe('warning');
    expect(snapshot(c)).toBe(before);
  });
});

// ─── S3 r6.1: late results vs newer UI state (P1-1), cancel invalidates the offer (P1-2) ──
describe('r6.1 P1-1: UI generation / CAS', () => {
  function gatedCatalog() {
    let enterCatalog!: () => void;
    const catalogEntered = new Promise<void>(resolve => { enterCatalog = resolve; });
    let releaseCatalog!: (value: { models: string[]; source: 'live' }) => void;
    const catalogResult = new Promise<{ models: string[]; source: 'live' }>(resolve => { releaseCatalog = resolve; });
    return { catalog: async () => { enterCatalog(); return catalogResult; }, catalogEntered, releaseCatalog };
  }
  it('REVIEWER: a late catalog response must not reopen the picker after a newer output-toggle action', async () => {
    const g = gatedCatalog();
    const c = ctx({ catalog: g.catalog });
    const staleOpen = handleModelSwitchCardAction(c);
    await g.catalogEntered;
    c.ds.modelPanel = undefined;
    c.ds.displayMode = 'screenshot';
    g.releaseCatalog({ models: CANDIDATES, source: 'live' });
    await staleOpen;
    expect(c.ds.displayMode).toBe('screenshot');
    expect(c.ds.modelPanel).toBeUndefined();
  });
  it('production path: the 「显示输出」 toggle collapses via collapseModelPanel; a late open gives up even in hidden mode', async () => {
    const g = gatedCatalog();
    const c = ctx({ catalog: g.catalog });
    const staleOpen = handleModelSwitchCardAction(c);
    await g.catalogEntered;
    collapseModelPanel(c.ds);           // what card-handler's toggle branch calls
    g.releaseCatalog({ models: CANDIDATES, source: 'live' });
    const r: any = await staleOpen;
    expect(c.ds.modelPanel).toBeUndefined();
    expect(panelOf(r)).toBeNull();      // whatever it patches is the CURRENT state
  });
  it('a newer open supersedes an older one: only the latest write lands', async () => {
    const g1 = gatedCatalog();
    const c = ctx({ catalog: g1.catalog });
    const first = handleModelSwitchCardAction(c);
    await g1.catalogEntered;
    const second: any = await handleModelSwitchCardAction(sameDs(c, { action: 'model_menu_refresh' }, { catalog: async () => ({ models: ['only-new'], source: 'live' }) }));
    expect(panelOf(second).models).toEqual(['only-new']);
    g1.releaseCatalog({ models: CANDIDATES, source: 'live' });
    await first;
    expect((c.ds.modelPanel as any).models).toEqual(['only-new']);
  });
  it('a stale model_pick (candidate check outlived a toggle) does not resurrect the picker', async () => {
    const g = gatedCatalog();
    const c = ctx({ catalog: g.catalog });
    const stalePick = handleModelSwitchCardAction(sameDs(c, { action: 'model_pick', model: 'gpt-5.6-sol' }));
    await g.catalogEntered;
    collapseModelPanel(c.ds); c.ds.displayMode = 'screenshot';
    g.releaseCatalog({ models: CANDIDATES, source: 'live' });
    await stalePick;
    expect(c.ds.modelPanel).toBeUndefined();
    expect(c.ds.displayMode).toBe('screenshot');
  });
});

describe('r6.1 P1-2: leaving confirm invalidates the offer', () => {
  it('REVIEWER: cancel must invalidate the confirmation offer', async () => {
    switchMock.mockReturnValue({ ok: true, attemptId: 'A1', txn: { target: {}, rollback: {} } });
    const c = ctx();
    const conf: any = await handleModelSwitchCardAction(sameDs(c, { action: 'model_pick', model: 'gpt-5.6-sol' }));
    const staleConfirm = findConfirmValue(conf);
    await handleModelSwitchCardAction(sameDs(c, { action: 'model_menu_open' }));
    const r: any = await handleModelSwitchCardAction(sameDs(c, staleConfirm));
    expect(r?.toast?.type).toBe('warning');
    expect(switchMock).not.toHaveBeenCalled();
  });
  it('退出选择, 刷新候选 and the 「显示输出」 toggle also invalidate a pending offer', async () => {
    switchMock.mockReturnValue({ ok: true, attemptId: 'A1', txn: { target: {}, rollback: {} } });
    const leave: Array<(c: ModelSwitchCardContext) => Promise<unknown>> = [
      c => handleModelSwitchCardAction(sameDs(c, { action: 'model_menu_close' })),
      c => handleModelSwitchCardAction(sameDs(c, { action: 'model_menu_refresh' })),
      async c => { collapseModelPanel(c.ds); },
    ];
    for (const l of leave) {
      const c = ctx();
      const conf: any = await handleModelSwitchCardAction(sameDs(c, { action: 'model_pick', model: 'gpt-5.6-sol' }));
      const stale = findConfirmValue(conf);
      await l(c);
      const before = snapshot(c);
      expect((await handleModelSwitchCardAction(sameDs(c, stale)) as any)?.toast?.type).toBe('warning');
      expect(snapshot(c)).toBe(before);
      expect(switchMock).not.toHaveBeenCalled();
    }
  });
  it('a fresh pick after cancel yields a NEW offer that does confirm', async () => {
    switchMock.mockReturnValue({ ok: true, attemptId: 'A1', txn: { target: {}, rollback: {} } });
    const c = ctx();
    const first: any = await handleModelSwitchCardAction(sameDs(c, { action: 'model_pick', model: 'gpt-5.6-sol' }));
    await handleModelSwitchCardAction(sameDs(c, { action: 'model_menu_open' }));
    const second: any = await handleModelSwitchCardAction(sameDs(c, { action: 'model_pick', model: 'gpt-5.6-sol' }));
    expect(panelOf(second).offerId).not.toBe(panelOf(first).offerId);
    expect(panelOf(await handleModelSwitchCardAction(sameDs(c, findConfirmValue(second)))).kind).toBe('switching');
    expect(switchMock).toHaveBeenCalledTimes(1);
  });
});
