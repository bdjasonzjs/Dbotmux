/**
 * Card-driven model switch v1 (design card-model-switch-s1 rev16, S3).
 *
 * Oracles are INDEPENDENT of the implementation's own tables (S3 acceptance
 * P2-1): expected capabilities / precedence / settle outcomes are literal
 * constants in this file, never derived from MODEL_SWITCH_CAPABILITY or the
 * state machine under test.
 *
 * Run:  pnpm vitest run test/model-switch.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const getBotMock = vi.fn();
vi.mock('../src/bot-registry.js', async (importOriginal) => ({
  ...(await importOriginal() as object),
  getBot: (...args: unknown[]) => getBotMock(...args),
}));
const updateSessionMock = vi.fn();
vi.mock('../src/services/session-store.js', async (importOriginal) => ({
  ...(await importOriginal() as object),
  updateSession: (...args: unknown[]) => updateSessionMock(...args),
}));

const probeMock = vi.fn();
const killMock = vi.fn();
vi.mock('../src/core/persistent-backend.js', async (importOriginal) => ({
  ...(await importOriginal() as object),
  probePersistentBackendTarget: (...a: unknown[]) => probeMock(...a),
  killPersistentBackendTarget: (...a: unknown[]) => killMock(...a),
}));

import { readFileSync } from 'node:fs';
import {
  MODEL_SWITCH_CAPABILITY, cliSupportsModelSwitch, sessionSupportsModelSwitch, capabilityForSession,
  prepareModelSwitch, settleModelSwitch, recheckModelSwitch, forceRollbackModelSwitch, applyRollbackInMemory,
  beginForceRollback,
} from '../src/core/model-switch.js';
import { modelSwitchAllowedForSession } from '../src/core/model-switch-surface.js';
import { setChatExternal, _resetChatExternalCacheForTests } from '../src/im/lark/chat-external-cache.js';
import { resolveSessionLaunchModel } from '../src/core/session-model.js';
import { RestartCoordinator } from '../src/core/restart-coordinator.js';
import {
  requestSessionRestart, requestModelSwitchRestart, requestModelSwitchForceRollback, ensureFreshSpawnForSwitch,
  latestEffortForRespawn, convergeSessionEffort, __testOnly_resetRestartCoordinator, __testOnly_resolveRestart,
} from '../src/core/worker-pool.js';
import { parsePiListModels } from '../src/adapters/cli/pi.js';
import { buildSessionCard, buildStreamingCard } from '../src/im/lark/card-builder.js';
import { MODEL_SWITCH_CARD_ACTIONS, MODEL_NAME_RE, sessionLooksBusy } from '../src/im/lark/model-switch-card.js';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const cardHandlerSource = readFileSync(new URL('../src/im/lark/card-handler.ts', import.meta.url), 'utf8');
const dispatcherSource = readFileSync(new URL('../src/im/lark/event-dispatcher.ts', import.meta.url), 'utf8');

beforeEach(() => { getBotMock.mockReset(); updateSessionMock.mockReset(); probeMock.mockReset(); killMock.mockReset(); _resetChatExternalCacheForTests(); __testOnly_resetRestartCoordinator(); });
afterEach(() => { __testOnly_resetRestartCoordinator(); });

import { activeSessionRestartAttemptId as __testOnly_activeAttempt } from '../src/core/worker-pool.js';

let n = 0;
function makeDs(session: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const send = vi.fn();
  const ds: any = {
    session: { sessionId: `ms-${++n}`, backendType: 'pty', cliId: 'claude-code', ...session },
    larkAppId: 'cli_app1', chatId: 'oc_x', chatType: 'group', hasHistory: true,
    worker: { killed: false, send }, ...extra,
  };
  return { ds, send };
}

// ─── 1. capability table (independent oracle: 28 literal rows, 17/1/8/2) ────
describe('MODEL_SWITCH_CAPABILITY', () => {
  const EXPECTED: Record<string, 'spawn' | 'fresh-only' | 'unsupported' | 'remote'> = {
    'claude-code': 'spawn', seed: 'spawn', relay: 'spawn', aiden: 'unsupported', coco: 'spawn',
    codex: 'spawn', 'codex-app': 'fresh-only', cursor: 'spawn', gemini: 'spawn', genius: 'spawn',
    opencode: 'spawn', opencode2: 'unsupported', antigravity: 'unsupported', mtr: 'unsupported',
    hermes: 'unsupported', mira: 'unsupported', mir: 'unsupported', traex: 'spawn', pi: 'spawn',
    copilot: 'spawn', 'oh-my-pi': 'spawn', kimi: 'spawn', grok: 'spawn', 'kiro-cli': 'unsupported',
    riff: 'remote', reasonix: 'spawn', dsh: 'spawn', mojo: 'remote',
  };
  it('has exactly the 28 expected rows with the expected values (17/1/8/2)', () => {
    expect(Object.keys(MODEL_SWITCH_CAPABILITY).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const [cli, cap] of Object.entries(EXPECTED)) {
      expect(MODEL_SWITCH_CAPABILITY[cli as keyof typeof MODEL_SWITCH_CAPABILITY], cli).toBe(cap);
    }
    const counts = Object.values(MODEL_SWITCH_CAPABILITY).reduce<Record<string, number>>((m, c) => ({ ...m, [c]: (m[c] ?? 0) + 1 }), {});
    expect(counts).toEqual({ spawn: 17, 'fresh-only': 1, unsupported: 8, remote: 2 });
  });
  it('bare predicate: spawn/fresh-only yes, unsupported/remote/undefined no', () => {
    expect(cliSupportsModelSwitch('claude-code')).toBe(true);
    expect(cliSupportsModelSwitch('codex-app')).toBe(true);
    expect(cliSupportsModelSwitch('relay')).toBe(true);
    expect(cliSupportsModelSwitch('coco')).toBe(true);
    expect(cliSupportsModelSwitch('opencode2')).toBe(false);
    expect(cliSupportsModelSwitch('riff')).toBe(false);
    expect(cliSupportsModelSwitch(undefined)).toBe(false);
  });
  it('wrapper-first: standalone coco = spawn, ttadk-coco = unsupported, ttadk-claude = spawn', () => {
    expect(capabilityForSession('coco', undefined)).toBe('spawn');
    expect(capabilityForSession('coco', 'ttadk coco')).toBe('unsupported');
    expect(capabilityForSession('claude-code', 'ttadk claude')).toBe('spawn');
    // the wrapper verdict wins even when the bare CLI would be unsupported
    expect(capabilityForSession('opencode2', 'ttadk claude')).toBe('spawn');
    expect(sessionSupportsModelSwitch('coco', 'ttadk coco')).toBe(false);
    expect(sessionSupportsModelSwitch('coco', undefined)).toBe(true);
  });
  it('prepareModelSwitch refuses a ttadk-coco session even though bare coco is switchable', () => {
    expect(prepareModelSwitch({ cliId: 'coco', wrapperCli: 'ttadk coco' } as any, { model: 'x', setBy: 'x', attemptId: 'A' })).toEqual({ ok: false, reason: 'unsupported' });
    expect(prepareModelSwitch({ cliId: 'coco' } as any, { model: 'x', setBy: 'x', attemptId: 'A' }).ok).toBe(true);
  });
});

// ─── 1b. render surface (real chain: session → cache → verdict) ───────────
describe('modelSwitchAllowedForSession', () => {
  const base = (over: Record<string, unknown> = {}) => ({
    session: { sessionId: 's', cliId: 'claude-code', backendType: 'pty' }, larkAppId: 'app', chatId: 'oc_1', chatType: 'group', ...over,
  }) as any;
  it('p2p → allowed', () => expect(modelSwitchAllowedForSession(base({ chatType: 'p2p' }))).toBe(true));
  it('persisted internal → allowed; persisted external → not', () => {
    expect(modelSwitchAllowedForSession(base({ session: { sessionId: 's', cliId: 'claude-code', externalChat: false } }))).toBe(true);
    expect(modelSwitchAllowedForSession(base({ session: { sessionId: 's', cliId: 'claude-code', externalChat: true } }))).toBe(false);
  });
  it('cached internal → allowed; cached external → not; UNKNOWN → not (fail closed)', () => {
    expect(modelSwitchAllowedForSession(base())).toBe(false); // unknown
    setChatExternal('app', 'oc_1', false);
    expect(modelSwitchAllowedForSession(base())).toBe(true);
    _resetChatExternalCacheForTests();
    setChatExternal('app', 'oc_1', true);
    expect(modelSwitchAllowedForSession(base())).toBe(false);
  });
  it('capability / adopt gates apply before the chat verdict', () => {
    expect(modelSwitchAllowedForSession(base({ chatType: 'p2p', session: { sessionId: 's', cliId: 'coco', wrapperCli: 'ttadk coco' } }))).toBe(false);
    expect(modelSwitchAllowedForSession(base({ chatType: 'p2p', session: { sessionId: 's', cliId: 'riff' } }))).toBe(false);
    expect(modelSwitchAllowedForSession(base({ chatType: 'p2p', initConfig: { adoptMode: true } }))).toBe(false);
  });
});

// ─── 2. launch precedence: override > pin > bot config > record ────────────
describe('resolveSessionLaunchModel with a pin', () => {
  it('pin outranks the live bot config', () => {
    const ds = { session: { cliId: 'claude-code' as const, model: 'sonnet', modelPin: { model: 'opus', cliId: 'claude-code' as const } } };
    expect(resolveSessionLaunchModel(ds, { cliId: 'claude-code', model: 'fable' })).toBe('opus');
  });
  it('spawnModelOverride still outranks the pin', () => {
    const ds = { session: { cliId: 'claude-code' as const, modelPin: { model: 'opus', cliId: 'claude-code' as const } }, spawnModelOverride: 'haiku' };
    expect(resolveSessionLaunchModel(ds, { cliId: 'claude-code', model: 'fable' })).toBe('haiku');
  });
  it('pin with model undefined = explicit CLI default (beats bot config)', () => {
    const ds = { session: { cliId: 'claude-code' as const, modelPin: { cliId: 'claude-code' as const } } };
    expect(resolveSessionLaunchModel(ds, { cliId: 'claude-code', model: 'fable' })).toBeUndefined();
  });
  it('pin for another CLI is ignored', () => {
    const ds = { session: { cliId: 'codex' as const, modelPin: { model: 'opus', cliId: 'claude-code' as const } } };
    expect(resolveSessionLaunchModel(ds, { cliId: 'codex', model: 'gpt-5.5' })).toBe('gpt-5.5');
  });
});

// ─── 3. state machine ─────────────────────────────────────────────────────
describe('prepareModelSwitch / settleModelSwitch', () => {
  it('binds txn to the given attemptId and snapshots the old state', () => {
    const s: any = { cliId: 'codex', model: 'gpt-5.5', reasoningEffort: 'high' };
    const r = prepareModelSwitch(s, { model: 'gpt-5.6-sol', effort: 'xhigh', setBy: 'ou_1', attemptId: 'A1', now: 5 });
    expect(r.ok).toBe(true);
    expect(s.modelPin).toMatchObject({ model: 'gpt-5.6-sol', effort: 'xhigh', cliId: 'codex', setBy: 'ou_1', setAt: 5 });
    expect(s.modelSwitchTxn).toMatchObject({ attemptId: 'A1', state: 'in_flight', seq: 1, rollback: { model: 'gpt-5.5', reasoningEffort: 'high', pin: null } });
    expect(s.reasoningEffort).toBe('xhigh');
  });
  it('refuses a second switch while one is in flight, and while ambiguous', () => {
    const s: any = { cliId: 'claude-code' };
    expect(prepareModelSwitch(s, { model: 'opus', setBy: 'x', attemptId: 'A1' }).ok).toBe(true);
    expect(prepareModelSwitch(s, { model: 'sonnet', setBy: 'x', attemptId: 'A2' })).toEqual({ ok: false, reason: 'switch_in_flight' });
    settleModelSwitch(s, 'A1', 'timed_out');
    expect(prepareModelSwitch(s, { model: 'sonnet', setBy: 'x', attemptId: 'A3' })).toEqual({ ok: false, reason: 'ambiguous_frozen' });
  });
  it('refuses unsupported CLIs and unsupported / non-configurable effort', () => {
    expect(prepareModelSwitch({ cliId: 'opencode2' } as any, { model: 'x', setBy: 'x', attemptId: 'A' })).toEqual({ ok: false, reason: 'unsupported' });
    expect(prepareModelSwitch({ cliId: 'claude-code' } as any, { model: 'opus', effort: 'high', setBy: 'x', attemptId: 'A' })).toEqual({ ok: false, reason: 'effort_not_configurable' });
    expect(prepareModelSwitch({ cliId: 'codex' } as any, { model: 'gpt-5.5', effort: 'ultra', setBy: 'x', attemptId: 'A' })).toEqual({ ok: false, reason: 'effort_not_supported' });
  });
  it('clears (never downgrades) an effort the new model cannot take', () => {
    const s: any = { cliId: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'ultra' };
    expect(prepareModelSwitch(s, { model: 'gpt-5.5', setBy: 'x', attemptId: 'A' }).ok).toBe(true);
    expect(s.reasoningEffort).toBeUndefined();
    expect(s.modelPin.effort).toBeUndefined();
  });
  it('succeeded for the SAME attempt commits: txn cleared, pin kept', () => {
    const s: any = { cliId: 'claude-code', model: 'fable' };
    prepareModelSwitch(s, { model: 'opus', setBy: 'x', attemptId: 'A1' });
    expect(settleModelSwitch(s, 'A1', 'succeeded')).toBe('committed');
    expect(s.modelSwitchTxn).toBeUndefined();
    expect(s.modelPin.model).toBe('opus');
  });
  it('a terminal status for ANOTHER attempt is ignored (no commit, no rollback)', () => {
    const s: any = { cliId: 'claude-code', model: 'fable' };
    prepareModelSwitch(s, { model: 'opus', setBy: 'x', attemptId: 'A1' });
    expect(settleModelSwitch(s, 'A0', 'succeeded')).toBe('ignored');
    expect(settleModelSwitch(s, 'A2', 'failed')).toBe('ignored');
    expect(s.modelSwitchTxn.state).toBe('in_flight');
    expect(s.modelPin.model).toBe('opus');
  });
  it('failed rolls back model / effort / pin to the snapshot', () => {
    const s: any = { cliId: 'codex', model: 'gpt-5.5', reasoningEffort: 'high', modelPin: { model: 'gpt-5.5', cliId: 'codex', txnId: 't0', setBy: 'y', setAt: 1 } };
    prepareModelSwitch(s, { model: 'gpt-5.6-sol', effort: 'ultra', setBy: 'x', attemptId: 'A1' });
    expect(settleModelSwitch(s, 'A1', 'failed')).toBe('rolled_back');
    expect(s.model).toBe('gpt-5.5');
    expect(s.reasoningEffort).toBe('high');
    expect(s.modelPin).toMatchObject({ model: 'gpt-5.5', txnId: 't0' });
    expect(s.modelSwitchTxn).toBeUndefined();
  });
  it('timed_out freezes as ambiguous WITHOUT rolling back', () => {
    const s: any = { cliId: 'claude-code', model: 'fable' };
    prepareModelSwitch(s, { model: 'opus', setBy: 'x', attemptId: 'A1' });
    expect(settleModelSwitch(s, 'A1', 'timed_out')).toBe('ambiguous');
    expect(s.modelSwitchTxn.state).toBe('ambiguous');
    expect(s.modelPin.model).toBe('opus');
  });
  it('recheck: only a verified attestation of the CURRENT generation decides; model AND effort', () => {
    const att = (model: string | null, effort: string | null = null, gen = 3, prov: 'explicit' | 'default' | 'unknown' = effort ? 'explicit' : 'default') => ({ model, effort, effortProvenance: prov, workerGeneration: gen });
    const mk = () => { const s: any = { cliId: 'claude-code', model: 'fable' }; prepareModelSwitch(s, { model: 'opus', setBy: 'x', attemptId: 'A1' }); settleModelSwitch(s, 'A1', 'timed_out'); return s; };
    let s = mk();
    expect(recheckModelSwitch(s, undefined, 3)).toBe('ambiguous');
    expect(recheckModelSwitch(s, att('opus', null, 2), 3)).toBe('ambiguous');
    expect(recheckModelSwitch(s, att('opus'), 3)).toBe('committed');
    expect(s.modelPin.model).toBe('opus');
    s = mk();
    expect(recheckModelSwitch(s, att('fable'), 3)).toBe('rolled_back');
    expect(s.modelPin).toBeUndefined();
    s = mk();
    expect(recheckModelSwitch(s, att('sonnet'), 3)).toBe('ambiguous');
    // in_flight is never rechecked (only ambiguous)
    const live: any = { cliId: 'claude-code' }; prepareModelSwitch(live, { model: 'opus', setBy: 'x', attemptId: 'A' });
    expect(recheckModelSwitch(live, att('opus'), 3)).toBe('ignored');
  });
  it('recheck: an effort-only switch is NOT proven by an unchanged model (P1-7)', () => {
    const s: any = { cliId: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'high' };
    prepareModelSwitch(s, { model: 'gpt-5.6-sol', effort: 'xhigh', setBy: 'x', attemptId: 'A1' });
    settleModelSwitch(s, 'A1', 'timed_out');
    // attestation still shows the OLD effort → this is the rollback fact, not a commit
    expect(recheckModelSwitch(s, { model: 'gpt-5.6-sol', effort: 'high', effortProvenance: 'explicit', workerGeneration: 3 }, 3)).toBe('rolled_back');
    expect(s.reasoningEffort).toBe('high');
    const s2: any = { cliId: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'high' };
    prepareModelSwitch(s2, { model: 'gpt-5.6-sol', effort: 'xhigh', setBy: 'x', attemptId: 'A1' });
    settleModelSwitch(s2, 'A1', 'timed_out');
    expect(recheckModelSwitch(s2, { model: 'gpt-5.6-sol', effort: 'xhigh', effortProvenance: 'explicit', workerGeneration: 3 }, 3)).toBe('committed');
    // a CLI-default effort with an unset target counts as "no explicit effort"
    const s3: any = { cliId: 'codex', model: 'gpt-5.5' };
    prepareModelSwitch(s3, { model: 'gpt-5.6-sol', setBy: 'x', attemptId: 'A1' });
    settleModelSwitch(s3, 'A1', 'timed_out');
    expect(recheckModelSwitch(s3, { model: 'gpt-5.6-sol', effort: 'medium', effortProvenance: 'default', workerGeneration: 3 }, 3)).toBe('committed');
    // …but an EXPLICIT stray effort does not prove the unset target
    const s4: any = { cliId: 'codex', model: 'gpt-5.5' };
    prepareModelSwitch(s4, { model: 'gpt-5.6-sol', setBy: 'x', attemptId: 'A1' });
    settleModelSwitch(s4, 'A1', 'timed_out');
    expect(recheckModelSwitch(s4, { model: 'gpt-5.6-sol', effort: 'high', effortProvenance: 'explicit', workerGeneration: 3 }, 3)).toBe('ambiguous');
  });
  it('recheck: fresh-only additionally needs a NEW thread id', () => {
    const mk = () => { const s: any = { cliId: 'codex-app', model: 'gpt-5.5', cliSessionId: 'thr-old' }; prepareModelSwitch(s, { model: 'gpt-5.6-sol', setBy: 'x', attemptId: 'A1' }); settleModelSwitch(s, 'A1', 'timed_out'); return s; };
    const att = { model: 'gpt-5.6-sol', effort: null, effortProvenance: 'default' as const, workerGeneration: 3 };
    let s = mk();
    expect(recheckModelSwitch(s, att, 3)).toBe('ambiguous');           // same thread id → not proven
    s.cliSessionId = 'thr-new';
    expect(recheckModelSwitch(s, att, 3)).toBe('committed');
    s = mk(); s.cliSessionId = undefined;
    expect(recheckModelSwitch(s, att, 3)).toBe('ambiguous');
  });
  it('beginForceRollback restores the record but KEEPS the txn as rolling_back bound to the new attempt', () => {
    const s: any = { cliId: 'claude-code', model: 'fable' };
    prepareModelSwitch(s, { model: 'opus', setBy: 'x', attemptId: 'A1' });
    expect(beginForceRollback(s, 'R1')).toBeUndefined(); // only from ambiguous
    settleModelSwitch(s, 'A1', 'timed_out');
    const txn = beginForceRollback(s, 'R1');
    expect(txn).toMatchObject({ state: 'rolling_back', attemptId: 'R1', originalAttemptId: 'A1' });
    expect(s.model).toBe('fable');
    expect(s.modelPin).toBeUndefined();
    expect(s.modelSwitchTxn).toBe(txn);
    // a late result for the ORIGINAL attempt is ignored
    expect(settleModelSwitch(s, 'A1', 'succeeded')).toBe('ignored');
    // only succeeded on the convergence attempt clears it; failure keeps it recoverable
    const s2: any = JSON.parse(JSON.stringify(s));
    expect(settleModelSwitch(s2, 'R1', 'failed')).toBe('ambiguous');
    expect(s2.modelSwitchTxn.state).toBe('ambiguous');
    expect(settleModelSwitch(s, 'R1', 'succeeded')).toBe('rolled_back');
    expect(s.modelSwitchTxn).toBeUndefined();
  });
  it('force rollback restores the snapshot from ambiguous', () => {
    const s: any = { cliId: 'claude-code', model: 'fable' };
    prepareModelSwitch(s, { model: 'opus', setBy: 'x', attemptId: 'A1' });
    settleModelSwitch(s, 'A1', 'timed_out');
    expect(forceRollbackModelSwitch(s)).toBe(true);
    expect(s.modelPin).toBeUndefined();
    expect(s.model).toBe('fable');
    expect(forceRollbackModelSwitch(s)).toBe(false);
  });
  it('applyRollbackInMemory is idempotent', () => {
    const s: any = { cliId: 'claude-code', model: 'fable' };
    const r = prepareModelSwitch(s, { model: 'opus', setBy: 'x', attemptId: 'A1' });
    if (!r.ok) throw new Error('unexpected');
    applyRollbackInMemory(s, r.txn); applyRollbackInMemory(s, r.txn);
    expect(s).toMatchObject({ model: 'fable', modelSwitchSeq: 1 });
    expect(s.modelPin).toBeUndefined();
  });
});

// ─── 4. coordinator: per-request attemptId ────────────────────────────────
describe('RestartCoordinator per-request attemptId', () => {
  it('uses the caller-provided attempt id and only that id can resolve', async () => {
    const c = new RestartCoordinator({ timeoutMs: 10_000 });
    const notify = vi.fn();
    const r = c.request('s1', { source: 'card', notify }, () => {}, { attemptId: 'MINE' });
    expect(r).toEqual({ attemptId: 'MINE', joined: false });
    expect(c.resolve('s1', 'OTHER', 'succeeded')).toBe(false);
    expect(c.resolve('s1', 'MINE', 'succeeded')).toBe(true);
    c.reset();
  });
});

// ─── 5. worker-pool integration ───────────────────────────────────────────
describe('requestModelSwitchRestart', () => {
  it('issues ONE restart bound to the txn attempt, carrying pinned model + effort', () => {
    getBotMock.mockReturnValue({ config: { cliId: 'codex', model: 'gpt-5.5' } });
    const { ds, send } = makeDs({ cliId: 'codex', model: 'gpt-5.5', reasoningEffort: 'high' });
    const r = requestModelSwitchRestart(ds, { model: 'gpt-5.6-sol', effort: 'ultra', setBy: 'ou_1' }, { source: 'card', notify: vi.fn() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const msg = send.mock.calls[0][0];
    expect(msg).toMatchObject({ type: 'restart', attemptId: r.attemptId, model: 'gpt-5.6-sol', reasoningEffort: 'ultra' });
    expect(msg.freshThread).toBeUndefined();
    expect(ds.session.modelSwitchTxn.attemptId).toBe(r.attemptId);
    expect(updateSessionMock).toHaveBeenCalled();
  });
  it('codex-app switch on the LIVE branch sends freshThread:true', () => {
    getBotMock.mockReturnValue({ config: { cliId: 'codex-app' } });
    const { ds, send } = makeDs({ cliId: 'codex-app' });
    const r = requestModelSwitchRestart(ds, { model: 'gpt-5.5', setBy: 'x' }, { source: 'card', notify: vi.fn() });
    expect(r.ok).toBe(true);
    expect(send.mock.calls[0][0].freshThread).toBe(true);
    expect(ds.session.modelSwitchTxn.freshThread).toBe(true);
  });
  it('a plain restart never sends freshThread and the no-live branch resumes; a freshThread no-live restart does not resume', () => {
    // Behavioural, via the coordinator seam: the fork options are what the
    // no-live branch passes. We intercept forkWorker through the module seam.
    getBotMock.mockReturnValue({ config: { cliId: 'codex-app' } });
    const { ds, send } = makeDs({ cliId: 'codex-app' });
    requestSessionRestart(ds, { source: 'slash', notify: vi.fn() });
    expect(send.mock.calls[0][0].freshThread).toBeUndefined();
  });
  it('strict: refuses while another restart is in flight and leaves the record untouched', () => {
    getBotMock.mockReturnValue({ config: { cliId: 'claude-code', model: 'fable' } });
    const { ds } = makeDs({ model: 'fable' });
    requestSessionRestart(ds, { source: 'slash', notify: vi.fn() });
    const r = requestModelSwitchRestart(ds, { model: 'opus', setBy: 'x' }, { source: 'card', notify: vi.fn() });
    expect(r).toEqual({ ok: false, reason: 'restart_in_flight' });
    expect(ds.session.modelPin).toBeUndefined();
    expect(ds.session.modelSwitchTxn).toBeUndefined();
  });
  it('settles from the coordinator terminal status of the SAME attempt (succeeded → committed)', async () => {
    getBotMock.mockReturnValue({ config: { cliId: 'claude-code', model: 'fable' } });
    const { ds } = makeDs({ model: 'fable' });
    const onSettled = vi.fn();
    const r = requestModelSwitchRestart(ds, { model: 'opus', setBy: 'x' }, { source: 'card', notify: vi.fn(), onSettled });
    if (!r.ok) throw new Error('refused');
    // Simulate the worker's restart_result for this attempt through the same
    // coordinator path worker-pool uses (a foreign attempt id must not settle).
    const wp = await import('../src/core/worker-pool.js');
    const other = wp.requestSessionRestart(ds, { source: 'slash', notify: vi.fn() });
    expect(other!.joined).toBe(true); // joined our attempt, no second physical restart
    expect(other!.attemptId).toBe(r.attemptId);
    // resolve via the public seam
    const { __testOnly_resolveRestart } = wp as any;
    __testOnly_resolveRestart(ds.session.sessionId, 'NOT-OURS', 'succeeded');
    await new Promise(r => setTimeout(r, 0));
    expect(onSettled).not.toHaveBeenCalled();
    __testOnly_resolveRestart(ds.session.sessionId, r.attemptId, 'succeeded');
    await new Promise(r => setTimeout(r, 0));
    expect(onSettled).toHaveBeenCalledWith('committed', expect.objectContaining({ attemptId: r.attemptId }));
    expect(ds.session.modelSwitchTxn).toBeUndefined();
    expect(ds.session.modelPin.model).toBe('opus');
  });
  it('failed → rolled back; timed_out → ambiguous', async () => {
    getBotMock.mockReturnValue({ config: { cliId: 'claude-code', model: 'fable' } });
    const wp = await import('../src/core/worker-pool.js');
    const { __testOnly_resolveRestart } = wp as any;
    for (const [status, outcome] of [['failed', 'rolled_back'], ['timed_out', 'ambiguous']] as const) {
      const { ds } = makeDs({ model: 'fable' });
      const onSettled = vi.fn();
      const r = requestModelSwitchRestart(ds, { model: 'opus', setBy: 'x' }, { source: 'card', notify: vi.fn(), onSettled });
      if (!r.ok) throw new Error('refused');
      __testOnly_resolveRestart(ds.session.sessionId, r.attemptId, status);
      await new Promise(r => setTimeout(r, 0));
      expect(onSettled).toHaveBeenCalledWith(outcome, expect.anything());
      if (outcome === 'rolled_back') expect(ds.session.modelPin).toBeUndefined();
      else expect(ds.session.modelSwitchTxn.state).toBe('ambiguous');
    }
  });
});

describe('no-live-worker switch must be a proven fresh spawn (P1-4)', () => {
  const noLive = () => makeDs({ cliId: 'codex-app', backendType: 'tmux' }, { worker: undefined });
  it('live worker → ok without probing', () => {
    expect(ensureFreshSpawnForSwitch(makeDs().ds)).toBe('ok');
    expect(probeMock).not.toHaveBeenCalled();
  });
  it('pane missing after kill → ok', () => {
    probeMock.mockReturnValue('missing');
    expect(ensureFreshSpawnForSwitch(noLive().ds)).toBe('ok');
    expect(killMock).toHaveBeenCalledTimes(1);
  });
  it('pane still alive after two kills → pane_alive; indeterminate → pane_unknown', () => {
    probeMock.mockReturnValue('exists');
    expect(ensureFreshSpawnForSwitch(noLive().ds)).toBe('pane_alive');
    expect(killMock).toHaveBeenCalledTimes(2);
    killMock.mockReset(); probeMock.mockReturnValue('unknown');
    expect(ensureFreshSpawnForSwitch(noLive().ds)).toBe('pane_unknown');
    expect(killMock).toHaveBeenCalledTimes(1);
  });
  it('REVIEWER: a state-level refusal must not destroy a persistent pane', () => {
    getBotMock.mockReturnValue({ config: { cliId: 'codex-app' } });
    probeMock.mockReturnValue('missing');
    const { ds } = noLive();
    ds.session.modelSwitchTxn = {
      txnId: 'old', state: 'ambiguous', attemptId: 'old-attempt', cliId: 'codex-app',
      target: { model: 'gpt-5.6-sol' }, rollback: {}, freshThread: true,
    };
    const before = JSON.stringify(ds.session);
    const r = requestModelSwitchRestart(ds, { model: 'gpt-5.5', setBy: 'x' }, { source: 'card', notify: vi.fn() });
    expect(r).toEqual({ ok: false, reason: 'ambiguous_frozen' });
    expect(JSON.stringify(ds.session)).toBe(before);
    expect(killMock).not.toHaveBeenCalled();
    expect(probeMock).not.toHaveBeenCalled();
    expect(updateSessionMock).not.toHaveBeenCalled();
    expect(__testOnly_activeAttempt(ds)).toBeUndefined();
  });
  it('every non-destructive refusal comes BEFORE kill/probe on a no-live persistent backend (P1-2 r3)', () => {
    getBotMock.mockReturnValue({ config: { cliId: 'codex' } });
    probeMock.mockReturnValue('missing');
    const cases: Array<[string, Record<string, unknown>, { model?: string; effort?: string }, string]> = [
      ['ambiguous txn', { cliId: 'codex', backendType: 'tmux', modelSwitchTxn: { txnId: 't', seq: 1, state: 'ambiguous', attemptId: 'a', target: {}, rollback: {}, startedAt: 1, setBy: 'x' } }, { model: 'gpt-5.5' }, 'ambiguous_frozen'],
      ['in_flight txn (stale)', { cliId: 'codex', backendType: 'tmux', modelSwitchTxn: { txnId: 't', seq: 1, state: 'in_flight', attemptId: 'a', target: {}, rollback: {}, startedAt: 1, setBy: 'x' } }, { model: 'gpt-5.5' }, 'switch_in_flight'],
      ['rolling_back txn', { cliId: 'codex', backendType: 'tmux', modelSwitchTxn: { txnId: 't', seq: 1, state: 'rolling_back', attemptId: 'a', target: {}, rollback: {}, startedAt: 1, setBy: 'x' } }, { model: 'gpt-5.5' }, 'switch_in_flight'],
      ['effort outside model domain', { cliId: 'codex', backendType: 'tmux' }, { model: 'gpt-5.5', effort: 'ultra' }, 'effort_not_supported'],
      ['effort on a non-configurable CLI', { cliId: 'claude-code', backendType: 'tmux' }, { model: 'opus', effort: 'high' }, 'effort_not_configurable'],
      ['unsupported (ttadk-coco)', { cliId: 'coco', wrapperCli: 'ttadk coco', backendType: 'tmux' }, { model: 'x' }, 'unsupported'],
    ];
    for (const [name, session, target, reason] of cases) {
      killMock.mockClear(); probeMock.mockClear(); updateSessionMock.mockClear();
      const { ds } = makeDs(session, { worker: undefined });
      const before = JSON.stringify(ds.session);
      const r = requestModelSwitchRestart(ds, { ...target, setBy: 'x' }, { source: 'card', notify: vi.fn() });
      expect(r, name).toEqual({ ok: false, reason });
      expect(JSON.stringify(ds.session), name).toBe(before);
      expect(killMock, name).not.toHaveBeenCalled();
      expect(probeMock, name).not.toHaveBeenCalled();
      expect(updateSessionMock, name).not.toHaveBeenCalled();
      expect(__testOnly_activeAttempt(ds), name).toBeUndefined();
    }
    // …and a VALID request on the same no-live backend does reach the teardown
    const { ds } = makeDs({ cliId: 'codex', backendType: 'tmux' }, { worker: undefined });
    probeMock.mockReturnValue('exists');
    expect(requestModelSwitchRestart(ds, { model: 'gpt-5.5', setBy: 'x' }, { source: 'card', notify: vi.fn() })).toEqual({ ok: false, reason: 'pane_alive' });
    expect(killMock).toHaveBeenCalled();
  });
  it('validateModelSwitch is pure (no mutation) and agrees with prepareModelSwitch', async () => {
    const { validateModelSwitch } = await import('../src/core/model-switch.js');
    const s: any = { cliId: 'codex', model: 'gpt-5.5', reasoningEffort: 'ultra' };
    const before = JSON.stringify(s);
    expect(validateModelSwitch(s, { model: 'gpt-5.6-sol' })).toEqual({ ok: true, model: 'gpt-5.6-sol', effort: 'ultra', capability: 'spawn' });
    expect(validateModelSwitch(s, { model: 'gpt-5.5' })).toEqual({ ok: true, model: 'gpt-5.5', capability: 'spawn' }); // ultra cleared
    expect(validateModelSwitch(s, { model: 'gpt-5.5', effort: 'ultra' })).toEqual({ ok: false, reason: 'effort_not_supported' });
    expect(JSON.stringify(s)).toBe(before);
  });
  it('requestModelSwitchRestart refuses (zero mutation, zero fork) when the pane is alive / unknown', () => {
    getBotMock.mockReturnValue({ config: { cliId: 'codex-app' } });
    for (const [probe, reason] of [['exists', 'pane_alive'], ['unknown', 'pane_unknown']] as const) {
      probeMock.mockReturnValue(probe);
      const { ds } = noLive();
      const r = requestModelSwitchRestart(ds, { model: 'gpt-5.5', setBy: 'x' }, { source: 'card', notify: vi.fn() });
      expect(r).toEqual({ ok: false, reason });
      expect(ds.session.modelPin).toBeUndefined();
      expect(ds.session.modelSwitchTxn).toBeUndefined();
      expect(updateSessionMock).not.toHaveBeenCalled();
      expect(__testOnly_activeAttempt(ds)).toBeUndefined();
    }
  });
});

describe('requestModelSwitchForceRollback (P1-7)', () => {
  const ambiguous = () => {
    getBotMock.mockReturnValue({ config: { cliId: 'codex', model: 'gpt-5.5' } });
    const { ds, send } = makeDs({ cliId: 'codex', model: 'gpt-5.5', reasoningEffort: 'high' });
    const r = requestModelSwitchRestart(ds, { model: 'gpt-5.6-sol', effort: 'xhigh', setBy: 'x' }, { source: 'card', notify: vi.fn() });
    if (!r.ok) throw new Error('refused');
    __testOnly_resolveRestart(ds.session.sessionId, r.attemptId, 'timed_out');
    return { ds, send, r };
  };
  it('refuses when nothing is ambiguous / a restart is in flight, leaving the record untouched', async () => {
    const { ds } = makeDs();
    expect(requestModelSwitchForceRollback(ds, { source: 'card', notify: vi.fn() })).toEqual({ ok: false, reason: 'no_txn' });
    const a = ambiguous();
    await new Promise(r => setTimeout(r, 0));
    expect(a.ds.session.modelSwitchTxn.state).toBe('ambiguous');
    requestSessionRestart(a.ds, { source: 'slash', notify: vi.fn() }); // someone else's restart
    const snapshot = JSON.stringify(a.ds.session);
    expect(requestModelSwitchForceRollback(a.ds, { source: 'card', notify: vi.fn() })).toEqual({ ok: false, reason: 'restart_in_flight' });
    expect(JSON.stringify(a.ds.session)).toBe(snapshot);
  });
  it('accepted: record restored, restart IPC carries the OLD model/effort, txn stays until succeeded', async () => {
    const a = ambiguous();
    await new Promise(r => setTimeout(r, 0));
    const onSettled = vi.fn();
    const res = requestModelSwitchForceRollback(a.ds, { source: 'card', notify: vi.fn(), onSettled });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const msg = a.send.mock.calls.at(-1)![0];
    expect(msg).toMatchObject({ type: 'restart', attemptId: res.attemptId, model: 'gpt-5.5', reasoningEffort: 'high' });
    expect(a.ds.session.modelPin).toBeUndefined();
    expect(a.ds.session.modelSwitchTxn).toMatchObject({ state: 'rolling_back', attemptId: res.attemptId });
    // a LATE result for the original attempt changes nothing
    __testOnly_resolveRestart(a.ds.session.sessionId, a.r.attemptId, 'succeeded');
    await new Promise(r => setTimeout(r, 0));
    expect(a.ds.session.modelSwitchTxn.state).toBe('rolling_back');
    expect(onSettled).not.toHaveBeenCalled();
    __testOnly_resolveRestart(a.ds.session.sessionId, res.attemptId, 'succeeded');
    await new Promise(r => setTimeout(r, 0));
    expect(onSettled).toHaveBeenCalledWith('rolled_back', expect.anything());
    expect(a.ds.session.modelSwitchTxn).toBeUndefined();
  });
  it('convergence failed / timed out → txn back to ambiguous (still recoverable), record stays restored', async () => {
    for (const status of ['failed', 'timed_out'] as const) {
      const a = ambiguous();
      await new Promise(r => setTimeout(r, 0));
      const onSettled = vi.fn();
      const res = requestModelSwitchForceRollback(a.ds, { source: 'card', notify: vi.fn(), onSettled });
      if (!res.ok) throw new Error('refused');
      __testOnly_resolveRestart(a.ds.session.sessionId, res.attemptId, status);
      await new Promise(r => setTimeout(r, 0));
      expect(onSettled).toHaveBeenCalledWith('ambiguous', expect.anything());
      expect(a.ds.session.modelSwitchTxn.state).toBe('ambiguous');
      expect(a.ds.session.model).toBe('gpt-5.5');
      expect(a.ds.session.reasoningEffort).toBe('high');
    }
  });
});

describe('effort convergence (single persistent point)', () => {
  it('convergeSessionEffort clears an incompatible effort and persists', () => {
    const { ds } = makeDs({ cliId: 'codex', reasoningEffort: 'ultra' });
    expect(convergeSessionEffort(ds, 'gpt-5.5')).toBeUndefined();
    expect(ds.session.reasoningEffort).toBeUndefined();
    expect(updateSessionMock).toHaveBeenCalledTimes(1);
    expect(convergeSessionEffort({ session: { cliId: 'codex', reasoningEffort: 'high' } } as any, 'gpt-5.5')).toBe('high');
  });
  it('latestEffortForRespawn three-state: string / null / undefined', () => {
    getBotMock.mockReturnValue({ config: { cliId: 'codex', model: 'gpt-5.5' } });
    expect(latestEffortForRespawn(makeDs({ cliId: 'codex', reasoningEffort: 'high' }).ds)).toBe('high');
    expect(latestEffortForRespawn(makeDs({ cliId: 'codex' }).ds)).toBeNull();
    getBotMock.mockImplementation(() => { throw new Error('gone'); });
    expect(latestEffortForRespawn(makeDs({ cliId: 'codex', reasoningEffort: 'high' }).ds)).toBeUndefined();
  });
});

// ─── 6. worker side (source-pinned, same technique as restart-live-worker-model) ─
describe('worker.ts restart / message handlers', () => {
  it('merges reasoningEffort three-state in BOTH channels', () => {
    const re = /if \(msg\.reasoningEffort !== undefined && lastInitConfig\) \{\s*lastInitConfig\.reasoningEffort = \(msg\.reasoningEffort === null \? undefined : msg\.reasoningEffort\)/g;
    expect(workerSource.match(re)?.length).toBe(2);
  });
  it('freshThread respawn drops resume + cliSessionId and does not use rpcThreadId', () => {
    expect(workerSource).toMatch(/opts\.freshThread\s*\?\s*\{ \.\.\.lastInitConfig, resume: false, prompt: '', cliSessionId: undefined \}/);
    expect(workerSource).toMatch(/freshThread: msg\.freshThread === true/);
  });
});

// ─── 7. card layer ────────────────────────────────────────────────────────
describe('card layer', () => {
  const EXPECTED_ACTIONS = ['effort_pick', 'model_custom_open', 'model_custom_save', 'model_menu_open', 'model_menu_refresh', 'model_pick', 'model_pick_confirm', 'model_txn_force_rollback', 'model_txn_recheck'];
  it('exactly the ten actions (nine + model_menu_close), all in the sensitive gate, all routed', () => {
    expect([...MODEL_SWITCH_CARD_ACTIONS].sort()).toEqual([...EXPECTED_ACTIONS, 'model_menu_close'].sort());
    const gate = cardHandlerSource.match(/const isSensitive = value\?\.action && \[([^\]]*)\]/)![1];
    expect(gate).toContain('...MODEL_SWITCH_CARD_ACTIONS');
    expect(cardHandlerSource).toMatch(/if \(isModelSwitchCardAction\(actionType\)\)/);
  });
  it('dedupe key discriminates model / effort / menu_id', () => {
    expect(dispatcherSource).toMatch(/model: value\?\.model,\s*effort: value\?\.effort,\s*menuId: value\?\.menu_id,/);
  });
  it('session card never renders a model button (v2: the picker lives on the streaming card only)', () => {
    expect(buildSessionCard('s', 'r', 'http://t', 'T', 'claude-code', true, false, 'zh', false, undefined, false, true)).not.toContain('model_menu_open');
  });
  it('streaming card: 「选择模型」 ONLY when proven; absent by default / externally / adopt / unsupported', () => {
    const has = (json: string) => json.includes('"action":"model_menu_open"');
    const build = (cli: any, adopt = false, external = false, allowed = false) => buildStreamingCard('s', 'r', 'http://t', 'T', '', 'idle', cli, 'hidden', 'n', undefined, adopt, false, 'zh', undefined, undefined, false, undefined, undefined, undefined, external, allowed);
    expect(has(build('claude-code'))).toBe(false);
    expect(has(build('claude-code', false, false, true))).toBe(true);
    expect(has(build('pi', false, false, true))).toBe(true);
    expect(has(build('opencode2', false, false, true))).toBe(false);
    expect(has(build('claude-code', true, false, true))).toBe(false);
    expect(has(build('claude-code', false, true, true))).toBe(false);
  });
  it('every session/streaming card call site passes the proven surface verdict (no default-false leaks)', () => {
    const wp = readFileSync(new URL('../src/core/worker-pool.ts', import.meta.url), 'utf8');
    for (const [src, name] of [[wp, 'worker-pool'], [cardHandlerSource, 'card-handler']] as const) {
      const calls = (src.match(/build(?:Streaming|Session)Card\(\s*\n/g) ?? []).length;
      const verdicts = (src.match(/modelSwitchAllowedForSession\(ds/g) ?? []).length;
      expect(calls, name).toBeGreaterThan(0);
      expect(verdicts, `${name}: ${calls} card calls vs ${verdicts} verdicts`).toBe(calls);
    }
  });
  it('model name validation and busy predicate', () => {
    expect(MODEL_NAME_RE.test('deepseek/deepseek-v4-pro')).toBe(true);
    expect(MODEL_NAME_RE.test('gpt-5.5')).toBe(true);
    expect(MODEL_NAME_RE.test('opus; rm -rf /')).toBe(false);
    expect(MODEL_NAME_RE.test('')).toBe(false);
    expect(sessionLooksBusy({ lastScreenStatus: 'working' })).toBe(true);
    expect(sessionLooksBusy({ lastScreenStatus: 'idle', pendingInputCount: 2 })).toBe(true);
    expect(sessionLooksBusy({ lastScreenStatus: 'idle' })).toBe(false);
  });
});

// ─── 8. pi catalog ────────────────────────────────────────────────────────
describe('parsePiListModels', () => {
  it('parses the 0.84.4 table into provider/model ids', () => {
    const out = [
      'provider  model                         context  max-out  thinking  images',
      'deepseek  deepseek-v4-flash             200K     384K     yes       no',
      'deepseek  deepseek-v4-flash-vision-exp  1M       384K     yes       yes',
      'deepseek  deepseek-v4-pro               1M       384K     yes       no',
      '',
    ].join('\n');
    expect(parsePiListModels(out)).toEqual(['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-flash-vision-exp', 'deepseek/deepseek-v4-pro']);
  });
  it('returns [] for the no-key message', () => {
    expect(parsePiListModels('No models available. Configure a provider API key first.\n')).toEqual([]);
  });
});
