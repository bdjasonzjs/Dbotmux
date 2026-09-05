/**
 * Card-driven model switch — click handler end-to-end through the REAL
 * handler (`handleModelSwitchCardAction`) with the daemon seams faked at the
 * module boundary (worker-pool restart primitives, session store, bot
 * registry). Each refusal asserts ZERO mutation and ZERO restart.
 *
 * Run:  pnpm vitest run test/model-switch-card.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const getBotMock = vi.fn();
vi.mock('../src/bot-registry.js', async (importOriginal) => ({ ...(await importOriginal() as object), getBot: (...a: unknown[]) => getBotMock(...a) }));
const updateSessionMock = vi.fn();
vi.mock('../src/services/session-store.js', async (importOriginal) => ({ ...(await importOriginal() as object), updateSession: (...a: unknown[]) => updateSessionMock(...a) }));
const switchMock = vi.fn();
const forceRollbackMock = vi.fn();
const restartMock = vi.fn();
const deliverMock = vi.fn(async (_ds: any, _op: any, content: string, msgType: string) => { delivered.push({ content, msgType }); });
const delivered: Array<{ content: string; msgType: string }> = [];
vi.mock('../src/core/worker-pool.js', async (importOriginal) => ({
  ...(await importOriginal() as object),
  requestModelSwitchRestart: (...a: unknown[]) => switchMock(...a),
  requestModelSwitchForceRollback: (...a: unknown[]) => forceRollbackMock(...a),
  requestSessionRestart: (...a: unknown[]) => restartMock(...a),
  deliverEphemeralOrReply: (...a: any[]) => deliverMock(a[0], a[1], a[2], a[3]),
  activeSessionRestartAttemptId: () => undefined,
}));

import { handleModelSwitchCardAction, MODEL_SWITCH_CARD_ACTIONS, __testOnly_resetPendingConfirms, PENDING_CONFIRM_TTL_MS, type ModelSwitchCardContext } from '../src/im/lark/model-switch-card.js';
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
    ds,
    operatorOpenId: 'ou_human',
    rootId: 'om_root',
    larkAppId: 'app',
    value: { action: 'model_menu_open', ...(over.value ?? {}) },
    action: undefined,
    sessionReply: vi.fn(async () => 'om_x'),
    identity: {
      resolveOperator: async () => ({ unionId: 'on_human', openId: 'ou_human' }),
      isBotUnionId: () => false,
      canOperate: () => true,
      ...(over.identity ?? {}),
    },
    catalog: over.catalog ?? (async () => ({ models: CANDIDATES, source: 'live' })),
    ...(over.action !== undefined ? { action: over.action } : {}),
    ...('operatorOpenId' in over ? { operatorOpenId: over.operatorOpenId } : {}),
  };
}
const snapshot = (c: ModelSwitchCardContext) => JSON.stringify(c.ds.session);
const expectZeroMutation = (c: ModelSwitchCardContext, before: string) => {
  expect(JSON.stringify(c.ds.session)).toBe(before);
  expect(updateSessionMock).not.toHaveBeenCalled();
  expect(switchMock).not.toHaveBeenCalled();
  expect(forceRollbackMock).not.toHaveBeenCalled();
  expect(restartMock).not.toHaveBeenCalled();
};

beforeEach(() => {
  getBotMock.mockReset(); getBotMock.mockReturnValue({ config: { cliId: 'codex' } });
  updateSessionMock.mockReset(); switchMock.mockReset(); forceRollbackMock.mockReset(); restartMock.mockReset();
  deliverMock.mockClear(); delivered.length = 0;
  _resetChatExternalCacheForTests(); setChatExternal('app', 'oc_1', false);
  __testOnly_resetPendingConfirms(); vi.useRealTimers();
});

// ─── identity gate: every refusal class, every action, zero mutation ───────
describe('shared identity gate (P1-2)', () => {
  const REFUSALS: Array<[string, Partial<ModelSwitchCardContext> & { session?: any; ds?: any }, string]> = [
    ['missing operator open_id', { operatorOpenId: undefined }, 'refuse.identity'],
    ['operator open_id not ou_', { operatorOpenId: 'on_abc' }, 'refuse.identity'],
    ['union id absent (fail-closed resolve)', { identity: { resolveOperator: async () => ({ openId: 'ou_human' }), isBotUnionId: () => false, canOperate: () => true } }, 'refuse.identity'],
    ['union id malformed', { identity: { resolveOperator: async () => ({ unionId: 'ou_notunion' }), isBotUnionId: () => false, canOperate: () => true } }, 'refuse.identity'],
    ['resolve throws', { identity: { resolveOperator: async () => { throw new Error('api'); }, isBotUnionId: () => false, canOperate: () => true } }, 'refuse.identity'],
    ['team / platform bot', { identity: { resolveOperator: async () => ({ unionId: 'on_bot' }), isBotUnionId: (u: string) => u === 'on_bot', canOperate: () => true } }, 'refuse.identity'],
    ['canOperate false', { identity: { resolveOperator: async () => ({ unionId: 'on_human' }), isBotUnionId: () => false, canOperate: () => false } }, 'refuse.not_admin'],
    ['adopt session', { ds: { initConfig: { adoptMode: true } } }, 'refuse.adopt'],
    ['remote backend', { session: { backendType: 'riff', cliId: 'riff' } }, 'refuse.remote'],
    ['unsupported (ttadk-coco wrapper-first)', { session: { cliId: 'coco', wrapperCli: 'ttadk coco' } }, 'refuse.unsupported'],
  ];
  for (const [name, over, key] of REFUSALS) {
    for (const action of MODEL_SWITCH_CARD_ACTIONS) {
      it(`${action}: ${name} → refused, zero mutation`, async () => {
        const c = ctx({ ...over, value: { action, model: 'gpt-5.5', effort: 'high' } });
        const before = snapshot(c);
        const r = await handleModelSwitchCardAction(c);
        expect(r?.toast.type).toBe('warning');
        expect(r?.toast.content).toBeTruthy();
        expectZeroMutation(c, before);
        expect(deliverMock).not.toHaveBeenCalled();
        void key;
      });
    }
  }
  it('canOperate is called with the OPEN id, never the union id', async () => {
    const canOperate = vi.fn(() => true);
    const c = ctx({ identity: { resolveOperator: async () => ({ unionId: 'on_human', openId: 'ou_human' }), isBotUnionId: () => false, canOperate } });
    await handleModelSwitchCardAction(c);
    expect(canOperate).toHaveBeenCalledWith('app', 'oc_1', 'ou_human');
  });
  it('external / unknown chat → refused even for a verified human', async () => {
    _resetChatExternalCacheForTests(); // unknown
    let c = ctx(); let before = snapshot(c);
    expect((await handleModelSwitchCardAction(c))?.toast.type).toBe('warning'); expectZeroMutation(c, before);
    setChatExternal('app', 'oc_1', true);
    c = ctx(); before = snapshot(c);
    expect((await handleModelSwitchCardAction(c))?.toast.type).toBe('warning'); expectZeroMutation(c, before);
  });
});

// ─── menu / candidates ─────────────────────────────────────────────────────
describe('menu and candidate authority (P1-5 / P1-6)', () => {
  it('menu_open delivers an ephemeral card built from the CURRENT catalog with a per-render menu id', async () => {
    const c = ctx();
    expect(await handleModelSwitchCardAction(c)).toBeUndefined();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].msgType).toBe('interactive');
    const card = JSON.parse(delivered[0].content);
    const s = JSON.stringify(card);
    expect(s).toContain('"action":"model_pick","model":"gpt-5.6-sol"');
    expect(s).toMatch(/"menu_id":"[0-9a-f]{8}"/);
  });
  it('menu_refresh asks the catalog with force=true and a per-bot scope; menu_open does not force', async () => {
    const calls: any[] = [];
    const catalog = async (key: string, opts: any) => { calls.push([key, opts]); return { models: CANDIDATES, source: 'live' as const }; };
    await handleModelSwitchCardAction(ctx({ catalog, value: { action: 'model_menu_refresh' } }));
    await handleModelSwitchCardAction(ctx({ catalog, value: { action: 'model_menu_open' } }));
    expect(calls[0][0]).toBe('codex');
    expect(calls[0][1]).toMatchObject({ force: true, scope: 'app' });
    expect(calls[1][1]).toMatchObject({ force: false, scope: 'app' });
  });
  it('model_pick with a value NOT in the current candidates is refused (stale / forged card), zero mutation', async () => {
    const c = ctx({ value: { action: 'model_pick', model: 'gpt-9-forged' } });
    const before = snapshot(c);
    const r = await handleModelSwitchCardAction(c);
    expect(r?.toast.type).toBe('warning');
    expectZeroMutation(c, before);
  });
  it('model_pick_confirm re-validates against the catalog too (the confirm card value is not authority)', async () => {
    const c = ctx({ value: { action: 'model_pick_confirm', source: 'curated', model: 'gpt-9-forged' } });
    // no server-side offer for a forged value → refused before any catalog work
    const before = snapshot(c);
    expect((await handleModelSwitchCardAction(c))?.toast.type).toBe('warning');
    expectZeroMutation(c, before);
  });
  it('model_pick on a current candidate starts the switch with that target', async () => {
    switchMock.mockReturnValue({ ok: true, attemptId: 'A1', txn: { target: { model: 'gpt-5.6-sol' }, rollback: {} } });
    const c = ctx({ value: { action: 'model_pick', model: 'gpt-5.6-sol' } });
    const r = await handleModelSwitchCardAction(c);
    expect(r?.toast.type).toBe('info');
    expect(switchMock).toHaveBeenCalledTimes(1);
    expect(switchMock.mock.calls[0][1]).toMatchObject({ model: 'gpt-5.6-sol', setBy: 'ou_human' });
  });
  it('custom-save keeps the free-form entry (any legal name), rejects illegal names', async () => {
    switchMock.mockReturnValue({ ok: true, attemptId: 'A1', txn: { target: { model: 'deepseek/deepseek-v4-pro' }, rollback: {} } });
    let c = ctx({ value: { action: 'model_custom_save' }, action: { form_value: { model: 'deepseek/deepseek-v4-pro' } } });
    expect((await handleModelSwitchCardAction(c))?.toast.type).toBe('info');
    expect(switchMock.mock.calls[0][1]).toMatchObject({ model: 'deepseek/deepseek-v4-pro' });
    switchMock.mockReset();
    c = ctx({ value: { action: 'model_custom_save' }, action: { form_value: { model: 'x; rm -rf /' } } });
    const before = snapshot(c);
    expect((await handleModelSwitchCardAction(c))?.toast.type).toBe('error');
    expectZeroMutation(c, before);
  });
  it('effort_pick outside the model effort domain is refused; inside it starts the switch', async () => {
    let c = ctx({ session: { modelPin: { model: 'gpt-5.5', cliId: 'codex', txnId: 't', setBy: 'x', setAt: 1 } }, value: { action: 'effort_pick', effort: 'ultra' } });
    const before = snapshot(c);
    expect((await handleModelSwitchCardAction(c))?.toast.type).toBe('warning');
    expectZeroMutation(c, before);
    switchMock.mockReturnValue({ ok: true, attemptId: 'A1', txn: { target: { model: 'gpt-5.5', effort: 'high' }, rollback: {} } });
    c = ctx({ session: { modelPin: { model: 'gpt-5.5', cliId: 'codex', txnId: 't', setBy: 'x', setAt: 1 } }, value: { action: 'effort_pick', effort: 'high' } });
    expect((await handleModelSwitchCardAction(c))?.toast.type).toBe('info');
    expect(switchMock.mock.calls[0][1]).toMatchObject({ model: 'gpt-5.5', effort: 'high' });
  });
});

// ─── codex-app: unconditional confirmation (P1-4) ──────────────────────────
describe('fresh-only (codex-app) always confirms first', () => {
  const app = (value: Record<string, any>, extra: any = {}) => {
    getBotMock.mockReturnValue({ config: { cliId: 'codex-app' } });
    return ctx({ session: { cliId: 'codex-app' }, value, ...extra });
  };
  void app;
  it('idle codex-app model_pick → confirm card, ZERO mutation, no switch', async () => {
    const c = app({ action: 'model_pick', model: 'gpt-5.6-sol' });
    const before = snapshot(c);
    expect(await handleModelSwitchCardAction(c)).toBeUndefined();
    expectZeroMutation(c, before);
    expect(delivered).toHaveLength(1);
    const card = JSON.parse(delivered[0].content);
    const s = JSON.stringify(card);
    expect(s).toContain('"action":"model_pick_confirm"');
    expect(s).toContain('"model":"gpt-5.6-sol"');
    expect(s).toMatch(/新线程|new thread/);
  });
  it('idle codex-app effort_pick and custom-save also confirm first', async () => {
    for (const [value, action] of [[{ action: 'effort_pick', effort: 'high' }, undefined], [{ action: 'model_custom_save' }, { form_value: { model: 'gpt-5.5' } }]] as const) {
      delivered.length = 0;
      const c = app(value as any, action ? { action } : {});
      const before = snapshot(c);
      expect(await handleModelSwitchCardAction(c)).toBeUndefined();
      expectZeroMutation(c, before);
      expect(JSON.stringify(JSON.parse(delivered[0].content))).toContain('"action":"model_pick_confirm"');
    }
  });
  it('REVIEWER: custom-save confirmation preserves free-form authority', async () => {
    switchMock.mockReturnValue({ ok: true, attemptId: 'A1', txn: { target: { model: 'deepseek/deepseek-v4-pro' }, rollback: {} } });
    const first = app(
      { action: 'model_custom_save' },
      { action: { form_value: { model: 'deepseek/deepseek-v4-pro' } } },
    );
    expect(await handleModelSwitchCardAction(first)).toBeUndefined();
    expect(switchMock).not.toHaveBeenCalled();
    const confirm = JSON.parse(delivered[0].content);
    expect(JSON.stringify(confirm)).toContain('deepseek/deepseek-v4-pro');

    const second = app({ action: 'model_pick_confirm', model: 'deepseek/deepseek-v4-pro' });
    expect((await handleModelSwitchCardAction(second))?.toast.type).toBe('info');
    expect(switchMock).toHaveBeenCalledTimes(1);
    expect(switchMock.mock.calls[0][1]).toMatchObject({ model: 'deepseek/deepseek-v4-pro' });
  });
  it('custom-save → confirm → switch, replaying the REAL confirm-card button value (codex-app fresh-only)', async () => {
    switchMock.mockReturnValue({ ok: true, attemptId: 'A1', txn: { target: { model: 'deepseek/deepseek-v4-pro' }, rollback: {} } });
    const first = app({ action: 'model_custom_save' }, { action: { form_value: { model: 'deepseek/deepseek-v4-pro' } } });
    expect(await handleModelSwitchCardAction(first)).toBeUndefined();
    const btn = JSON.parse(delivered[0].content).elements.find((e: any) => e.tag === 'action').actions[0];
    expect(btn.value).toMatchObject({ action: 'model_pick_confirm', source: 'custom', model: 'deepseek/deepseek-v4-pro' });
    const second = app(btn.value);
    expect((await handleModelSwitchCardAction(second))?.toast.type).toBe('info');
    expect(switchMock).toHaveBeenCalledTimes(1);
    expect(switchMock.mock.calls[0][1]).toMatchObject({ model: 'deepseek/deepseek-v4-pro' });
  });
  it('custom-save → confirm → switch on a BUSY plain CLI, replaying the real button value', async () => {
    switchMock.mockReturnValue({ ok: true, attemptId: 'A1', txn: { target: { model: 'my-private-model' }, rollback: {} } });
    const first = ctx({ value: { action: 'model_custom_save' }, action: { form_value: { model: 'my-private-model' } }, ds: { lastScreenStatus: 'working' } });
    expect(await handleModelSwitchCardAction(first)).toBeUndefined();
    expect(switchMock).not.toHaveBeenCalled();
    const btn = JSON.parse(delivered[0].content).elements.find((e: any) => e.tag === 'action').actions[0];
    expect(btn.value).toMatchObject({ action: 'model_pick_confirm', source: 'custom', model: 'my-private-model' });
    const second = ctx({ value: btn.value, ds: { lastScreenStatus: 'working' } });
    expect((await handleModelSwitchCardAction(second))?.toast.type).toBe('info');
    expect(switchMock.mock.calls[0][1]).toMatchObject({ model: 'my-private-model' });
  });
  it('curated pick → confirm carries source=curated and is re-validated against the live catalog', async () => {
    switchMock.mockReturnValue({ ok: true, attemptId: 'A1', txn: { target: { model: 'gpt-5.6-sol' }, rollback: {} } });
    const first = app({ action: 'model_pick', model: 'gpt-5.6-sol' });
    expect(await handleModelSwitchCardAction(first)).toBeUndefined();
    const btn = JSON.parse(delivered[0].content).elements.find((e: any) => e.tag === 'action').actions[0];
    expect(btn.value).toMatchObject({ source: 'curated', model: 'gpt-5.6-sol' });
    // catalog changed between the two hops → stale curated confirm is refused
    const stale = app(btn.value, { catalog: async () => ({ models: ['gpt-5.5'], source: 'live' as const }) });
    const before = snapshot(stale);
    expect((await handleModelSwitchCardAction(stale))?.toast.type).toBe('warning');
    expectZeroMutation(stale, before);
    // the offer was consumed by the refused hop → a fresh pick is needed
    delivered.length = 0;
    expect(await handleModelSwitchCardAction(app({ action: 'model_pick', model: 'gpt-5.6-sol' }))).toBeUndefined();
    const btn2 = JSON.parse(delivered[0].content).elements.find((e: any) => e.tag === 'action').actions[0];
    expect((await handleModelSwitchCardAction(app(btn2.value)))?.toast.type).toBe('info');
  });
  it('a confirmation without a matching server-side offer is refused (forged / stale / replayed), zero mutation', async () => {
    const offer = async (model = 'deepseek/deepseek-v4-pro') => {
      delivered.length = 0;
      await handleModelSwitchCardAction(app({ action: 'model_custom_save' }, { action: { form_value: { model } } }));
      return JSON.parse(delivered[0].content).elements.find((e: any) => e.tag === 'action').actions[0].value;
    };
    const cases: Array<[string, () => Promise<Record<string, any>>, Partial<ModelSwitchCardContext>]> = [
      ['no offer at all', async () => ({ action: 'model_pick_confirm', source: 'custom', model: 'deepseek/deepseek-v4-pro' }), {}],
      ['card source says custom but the offer was for another model', async () => ({ ...(await offer('other/model')), model: 'deepseek/deepseek-v4-pro' }), {}],
      ['offer exists but effort tampered', async () => ({ ...(await offer()), effort: 'high' }), {}],
      ['offer made by a different operator', async () => offer(), { operatorOpenId: 'ou_other', identity: { resolveOperator: async () => ({ unionId: 'on_other' }), isBotUnionId: () => false, canOperate: () => true } }],
      ['offer replayed twice (consumed on first use)', async () => { const v = await offer(); switchMock.mockReturnValue({ ok: true, attemptId: 'A', txn: { target: {}, rollback: {} } }); await handleModelSwitchCardAction(app(v)); switchMock.mockReset(); return v; }, {}],
    ];
    for (const [name, mk, extra] of cases) {
      __testOnly_resetPendingConfirms();
      const value = await mk();
      const c = app(value, extra);
      const before = snapshot(c);
      const r = await handleModelSwitchCardAction(c);
      expect(r?.toast.type, name).toBe('warning');
      expectZeroMutation(c, before);
    }
  });
  it('an expired offer is refused', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    delivered.length = 0;
    await handleModelSwitchCardAction(app({ action: 'model_custom_save' }, { action: { form_value: { model: 'deepseek/deepseek-v4-pro' } } }));
    const v = JSON.parse(delivered[0].content).elements.find((e: any) => e.tag === 'action').actions[0].value;
    vi.setSystemTime(1_000_000 + PENDING_CONFIRM_TTL_MS + 1);
    const c = app(v);
    const before = snapshot(c);
    expect((await handleModelSwitchCardAction(c))?.toast.type).toBe('warning');
    expectZeroMutation(c, before);
  });
  it('a custom offer confirmed with an illegal name (tampered) is rejected; effort re-validated', async () => {
    delivered.length = 0;
    await handleModelSwitchCardAction(app({ action: 'model_custom_save' }, { action: { form_value: { model: 'ok-model' } } }));
    let c = app({ action: 'model_pick_confirm', source: 'custom', model: 'x; rm -rf /' });
    let before = snapshot(c);
    expect((await handleModelSwitchCardAction(c))?.toast.type).toBe('warning'); // no matching offer for that name
    expectZeroMutation(c, before);
    // curated offer whose model dropped out of the catalog between hops → refused
    __testOnly_resetPendingConfirms(); delivered.length = 0;
    await handleModelSwitchCardAction(app({ action: 'model_pick', model: 'gpt-5.6-sol' }));
    const v = JSON.parse(delivered[0].content).elements.find((e: any) => e.tag === 'action').actions[0].value;
    c = app(v, { catalog: async () => ({ models: ['gpt-5.5'], source: 'live' as const }) });
    before = snapshot(c);
    expect((await handleModelSwitchCardAction(c))?.toast.type).toBe('warning');
    expectZeroMutation(c, before);
  });
  it('the identity gate still guards the custom confirmation hop', async () => {
    await handleModelSwitchCardAction(app({ action: 'model_custom_save' }, { action: { form_value: { model: 'deepseek/deepseek-v4-pro' } } }));
    const c = app({ action: 'model_pick_confirm', source: 'custom', model: 'deepseek/deepseek-v4-pro' }, { identity: { resolveOperator: async () => ({ unionId: 'on_bot' }), isBotUnionId: (u: string) => u === 'on_bot', canOperate: () => true } });
    const before = snapshot(c);
    expect((await handleModelSwitchCardAction(c))?.toast.type).toBe('warning');
    expectZeroMutation(c, before);
  });
  it('codex-app model_pick_confirm on a current candidate starts the switch (after the offer)', async () => {
    switchMock.mockReturnValue({ ok: true, attemptId: 'A1', txn: { target: { model: 'gpt-5.6-sol' }, rollback: {} } });
    expect(await handleModelSwitchCardAction(app({ action: 'model_pick', model: 'gpt-5.6-sol' }))).toBeUndefined();
    const c = app({ action: 'model_pick_confirm', source: 'curated', model: 'gpt-5.6-sol' });
    expect((await handleModelSwitchCardAction(c))?.toast.type).toBe('info');
    expect(switchMock).toHaveBeenCalledTimes(1);
  });
  it('plain CLI: idle pick switches directly; busy pick confirms first', async () => {
    switchMock.mockReturnValue({ ok: true, attemptId: 'A1', txn: { target: { model: 'gpt-5.6-sol' }, rollback: {} } });
    expect((await handleModelSwitchCardAction(ctx({ value: { action: 'model_pick', model: 'gpt-5.6-sol' } })))?.toast.type).toBe('info');
    switchMock.mockReset(); delivered.length = 0;
    const busy = ctx({ value: { action: 'model_pick', model: 'gpt-5.6-sol' }, ds: { lastScreenStatus: 'working' } });
    expect(await handleModelSwitchCardAction(busy)).toBeUndefined();
    expect(switchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(JSON.parse(delivered[0].content))).toContain('"action":"model_pick_confirm"');
  });
});

// ─── refusals from the daemon primitive are surfaced verbatim ─────────────
describe('daemon refusals surface as warnings', () => {
  for (const reason of ['restart_in_flight', 'switch_in_flight', 'ambiguous_frozen', 'pane_alive', 'pane_unknown', 'transferring'] as const) {
    it(reason, async () => {
      switchMock.mockReturnValue({ ok: false, reason });
      const r = await handleModelSwitchCardAction(ctx({ value: { action: 'model_pick', model: 'gpt-5.5' } }));
      expect(r?.toast.type).toBe('warning');
      expect(r?.toast.content.length).toBeGreaterThan(3);
    });
  }
  it('failed switch → rollback receipt; a refused convergence restart is reported, not swallowed', async () => {
    let onSettled: any;
    switchMock.mockImplementation((_ds: any, _t: any, obs: any) => { onSettled = obs.onSettled; return { ok: true, attemptId: 'A1', txn: { target: { model: 'gpt-5.6-sol' }, rollback: { model: 'gpt-5.5' } } }; });
    restartMock.mockReturnValue(undefined); // refused
    await handleModelSwitchCardAction(ctx({ value: { action: 'model_pick', model: 'gpt-5.6-sol' } }));
    delivered.length = 0;
    await onSettled('rolled_back', { target: { model: 'gpt-5.6-sol' }, rollback: { model: 'gpt-5.5' } });
    expect(restartMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), { strict: true });
    expect(delivered[0].content).toMatch(/回滚|rolled back/);
    expect(delivered[0].content).toMatch(/未能自动收敛|could not be converged/);
  });
});

// ─── ambiguous exits (P1-7) ────────────────────────────────────────────────
describe('ambiguous exits', () => {
  const amb = (extra: Record<string, unknown> = {}) => ({
    txnId: 'ms-1-A1', seq: 1, attemptId: 'A1', state: 'ambiguous', target: { model: 'gpt-5.6-sol', effort: 'xhigh' },
    rollback: { model: 'gpt-5.6-sol', reasoningEffort: 'high', pin: null }, startedAt: 1, setBy: 'x', ...extra,
  });
  it('recheck: same model but OLD effort attested → rolled back (not committed)', async () => {
    const c = ctx({ session: {
      modelSwitchTxn: amb(), reasoningEffort: 'xhigh',
      modelPin: { model: 'gpt-5.6-sol', effort: 'xhigh', cliId: 'codex', txnId: 'ms-1-A1', setBy: 'x', setAt: 1 },
      launchAttestation: { model: 'gpt-5.6-sol', effort: 'high', effortProvenance: 'explicit', workerGeneration: 1 },
    }, value: { action: 'model_txn_recheck' } });
    const r = await handleModelSwitchCardAction(c);
    expect(r?.toast.type).toBe('info');
    expect(c.ds.session.modelSwitchTxn).toBeUndefined();
    expect(c.ds.session.reasoningEffort).toBe('high');
    expect(updateSessionMock).toHaveBeenCalled();
  });
  it('recheck: attestation from an older generation → still ambiguous, nothing persisted', async () => {
    const c = ctx({ session: { modelSwitchTxn: amb(), launchAttestation: { model: 'gpt-5.6-sol', effort: 'xhigh', effortProvenance: 'explicit', workerGeneration: 0 } }, value: { action: 'model_txn_recheck' } });
    expect((await handleModelSwitchCardAction(c))?.toast.type).toBe('warning');
    expect(c.ds.session.modelSwitchTxn.state).toBe('ambiguous');
    expect(updateSessionMock).not.toHaveBeenCalled();
  });
  it('force rollback: click toast is "started", not success; daemon refusal keeps everything', async () => {
    forceRollbackMock.mockReturnValue({ ok: true, attemptId: 'R1', txn: amb({ state: 'rolling_back' }) });
    let c = ctx({ session: { modelSwitchTxn: amb() }, value: { action: 'model_txn_force_rollback' } });
    let r = await handleModelSwitchCardAction(c);
    expect(r?.toast.type).toBe('info');
    expect(r?.toast.content).toMatch(/收敛|converge/);
    forceRollbackMock.mockReturnValue({ ok: false, reason: 'restart_in_flight' });
    c = ctx({ session: { modelSwitchTxn: amb() }, value: { action: 'model_txn_force_rollback' } });
    const before = snapshot(c);
    r = await handleModelSwitchCardAction(c);
    expect(r?.toast.type).toBe('warning');
    expect(JSON.stringify(c.ds.session)).toBe(before);
  });
  it('recheck / force-rollback without an ambiguous txn are refused', async () => {
    for (const action of ['model_txn_recheck', 'model_txn_force_rollback']) {
      const c = ctx({ value: { action } });
      const before = snapshot(c);
      expect((await handleModelSwitchCardAction(c))?.toast.type).toBe('warning');
      expectZeroMutation(c, before);
    }
  });
});
