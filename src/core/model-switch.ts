/**
 * Card-driven model switch (v1) — daemon-side state machine.
 *
 * Scope (design doc `card-model-switch-s1/01-card-model-switch-design.md` rev16
 * §0 items 1–7, v1 subset):
 *   - a session-level model *pin* (`session.modelPin`) that outranks the bot
 *     config at every spawn (see resolveSessionLaunchModel precedence);
 *   - one switch *transaction* per session (`session.modelSwitchTxn`) tied to
 *     exactly one restart attempt id; the only success authority is the
 *     coordinator terminal status `succeeded` for THAT attempt;
 *   - `failed` → compare-and-set rollback of model / effort / pin;
 *   - `timed_out` → `ambiguous`: switching is frozen, nothing is rolled back
 *     automatically; the operator resolves it via recheck / force-rollback.
 *
 * Everything here is pure memory + session-store persistence. The physical
 * restart is issued by worker-pool (`requestModelSwitchRestart`).
 */
import type { CliId } from '../adapters/cli/types.js';
import type { Session } from '../types.js';
import { cliModelSupportsReasoningEffort, isCodexReasoningEffort, isConfigurableReasoningCliId } from '../services/codex-reasoning-effort.js';
import { isTtadkWrapper, ttadkAcceptsModel } from '../setup/cli-selection.js';

export type ModelSwitchCapability = 'spawn' | 'fresh-only' | 'unsupported' | 'remote';

/** Per-CLI capability (rev16 §3). `spawn` = `--model` is honoured by a plain
 *  respawn; `fresh-only` = the model only takes effect on a NEW thread
 *  (codex-app `thread/resume` ignores model/effort); `unsupported` = the CLI
 *  takes no model flag at all; `remote` = remote backend, restart is refused. */
export const MODEL_SWITCH_CAPABILITY: Readonly<Record<CliId, ModelSwitchCapability>> = {
  'claude-code': 'spawn',
  seed: 'spawn',
  relay: 'spawn',
  aiden: 'unsupported',
  coco: 'spawn',
  codex: 'spawn',
  'codex-app': 'fresh-only',
  cursor: 'spawn',
  gemini: 'spawn',
  genius: 'spawn',
  opencode: 'spawn',
  opencode2: 'unsupported',
  antigravity: 'unsupported',
  mtr: 'unsupported',
  hermes: 'unsupported',
  mira: 'unsupported',
  mir: 'unsupported',
  traex: 'spawn',
  pi: 'spawn',
  copilot: 'spawn',
  'oh-my-pi': 'spawn',
  kimi: 'spawn',
  grok: 'spawn',
  'kiro-cli': 'unsupported',
  riff: 'remote',
  reasonix: 'spawn',
  dsh: 'spawn',
  mojo: 'remote',
};

export function modelSwitchCapability(cliId: string | undefined): ModelSwitchCapability {
  if (!cliId) return 'unsupported';
  return MODEL_SWITCH_CAPABILITY[cliId as CliId] ?? 'unsupported';
}

/**
 * Session-level capability: the WRAPPER decides first. A ttadk-wrapped session
 * launches through the gateway, so the model flag is the gateway's (`ttadk -m`):
 * subcommands that take no model (coco) are `unsupported` even though the bare
 * CLI would be `spawn`; subcommands that do are `spawn` regardless of the
 * underlying CLI's own table. Only wrapper-less sessions consult the cliId table.
 */
export function capabilityForSession(cliId: string | undefined, wrapperCli: string | undefined): ModelSwitchCapability {
  if (isTtadkWrapper(wrapperCli)) return ttadkAcceptsModel(wrapperCli) ? 'spawn' : 'unsupported';
  return modelSwitchCapability(cliId);
}

function isSwitchable(cap: ModelSwitchCapability): boolean {
  return cap === 'spawn' || cap === 'fresh-only';
}

/** Whether a bare CLI can take a model switch (wrapper-less). */
export function cliSupportsModelSwitch(cliId: string | undefined): boolean {
  return isSwitchable(modelSwitchCapability(cliId));
}

/** Whether THIS session (cliId + wrapper) can take a model switch. */
export function sessionSupportsModelSwitch(cliId: string | undefined, wrapperCli: string | undefined): boolean {
  return isSwitchable(capabilityForSession(cliId, wrapperCli));
}

export interface ModelPin {
  /** Pinned model; undefined = "explicitly CLI default" (pin still outranks bot config). */
  model?: string;
  effort?: string;
  cliId: CliId;
  wrapperCli?: string;
  txnId: string;
  setBy: string;
  setAt: number;
}

export type ModelSwitchTxnState = 'in_flight' | 'ambiguous' | 'rolling_back';

export interface ModelSwitchTxn {
  txnId: string;
  seq: number;
  /** Restart attempt this transaction is bound to (sole success authority). */
  attemptId: string;
  state: ModelSwitchTxnState;
  target: { model?: string; effort?: string };
  /** Snapshot taken BEFORE the switch was applied, restored on failure.
   *  `cliSessionId` is only a witness for fresh-only rechecks (a NEW thread id
   *  must have been committed); it is never restored. */
  rollback: { model?: string; reasoningEffort?: string; pin?: ModelPin | null; cliSessionId?: string };
  freshThread?: boolean;
  startedAt: number;
  /** Last terminal status seen for this attempt (diagnostics only). */
  lastStatus?: 'failed' | 'timed_out';
  /** Attempt of the original switch (kept when a force-rollback re-binds attemptId). */
  originalAttemptId?: string;
  setBy: string;
}

export type ModelSwitchSession = Pick<Session, 'cliId' | 'model' | 'reasoningEffort' | 'modelPin' | 'modelSwitchTxn' | 'modelSwitchSeq' | 'wrapperCli' | 'cliSessionId'>;

export type PrepareRefusal =
  | 'unsupported'
  | 'switch_in_flight'
  | 'ambiguous_frozen'
  | 'effort_not_supported'
  | 'effort_not_configurable';

export type PrepareResult =
  | { ok: true; txn: ModelSwitchTxn; pin: ModelPin }
  | { ok: false; reason: PrepareRefusal };

export interface PrepareInput {
  model?: string;
  effort?: string;
  setBy: string;
  attemptId: string;
  now?: number;
  txnId?: string;
}

export type ValidateResult =
  | { ok: true; model?: string; effort?: string; capability: ModelSwitchCapability }
  | { ok: false; reason: PrepareRefusal };

/**
 * PURE validation of a switch request against the session's current state —
 * capability, transaction state, effort domain. No side effects at all, so a
 * caller can reject BEFORE any destructive step (persistent-pane teardown).
 * `prepareModelSwitch` is exactly validate + apply.
 */
export function validateModelSwitch(
  session: Pick<ModelSwitchSession, 'cliId' | 'wrapperCli' | 'reasoningEffort' | 'modelSwitchTxn'>,
  input: Pick<PrepareInput, 'model' | 'effort'>,
): ValidateResult {
  const cliId = session.cliId;
  const capability = capabilityForSession(cliId, session.wrapperCli);
  if (!isSwitchable(capability)) return { ok: false, reason: 'unsupported' };
  const existing = session.modelSwitchTxn;
  if (existing?.state === 'ambiguous') return { ok: false, reason: 'ambiguous_frozen' };
  if (existing?.state === 'in_flight' || existing?.state === 'rolling_back') return { ok: false, reason: 'switch_in_flight' };
  const model = input.model?.trim() || undefined;
  let effort = input.effort?.trim() || undefined;
  if (effort !== undefined) {
    if (!isConfigurableReasoningCliId(cliId)) return { ok: false, reason: 'effort_not_configurable' };
    if (!isCodexReasoningEffort(effort) || !cliModelSupportsReasoningEffort(cliId, model, effort)) {
      return { ok: false, reason: 'effort_not_supported' };
    }
  } else if (session.reasoningEffort && !cliModelSupportsReasoningEffort(cliId, model, session.reasoningEffort)) {
    // Effort is cleared (not silently downgraded) when the new model cannot take it.
    effort = undefined;
  } else {
    effort = session.reasoningEffort;
  }
  return { ok: true, ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), capability };
}

/**
 * Apply a switch to the session record (memory only — caller persists).
 * The transaction is bound to `attemptId`; the caller must issue the restart
 * with the same id or roll back immediately.
 */
export function prepareModelSwitch(session: ModelSwitchSession, input: PrepareInput): PrepareResult {
  const v = validateModelSwitch(session, input);
  if (!v.ok) return v;
  const cliId = session.cliId;
  const { model, effort, capability } = v;
  const now = input.now ?? Date.now();
  const seq = (session.modelSwitchSeq ?? 0) + 1;
  const txnId = input.txnId ?? `ms-${seq}-${input.attemptId}`;
  const pin: ModelPin = {
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    cliId: cliId as CliId,
    ...(session.wrapperCli ? { wrapperCli: session.wrapperCli } : {}),
    txnId,
    setBy: input.setBy,
    setAt: now,
  };
  const txn: ModelSwitchTxn = {
    txnId,
    seq,
    attemptId: input.attemptId,
    state: 'in_flight',
    target: { ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) },
    rollback: {
      ...(session.model !== undefined ? { model: session.model } : {}),
      ...(session.reasoningEffort !== undefined ? { reasoningEffort: session.reasoningEffort } : {}),
      pin: session.modelPin ? { ...session.modelPin } : null,
      ...(session.cliSessionId !== undefined ? { cliSessionId: session.cliSessionId } : {}),
    },
    freshThread: capability === 'fresh-only',
    originalAttemptId: input.attemptId,
    startedAt: now,
    setBy: input.setBy,
  };
  session.modelSwitchSeq = seq;
  session.modelPin = pin;
  session.modelSwitchTxn = txn;
  session.reasoningEffort = effort as Session['reasoningEffort'];
  return { ok: true, txn, pin };
}

export type SettleOutcome = 'committed' | 'rolled_back' | 'ambiguous' | 'ignored';

/** Restore the pre-switch snapshot (memory only). Idempotent. */
export function applyRollbackInMemory(session: ModelSwitchSession, txn: ModelSwitchTxn): void {
  session.model = txn.rollback.model;
  session.reasoningEffort = txn.rollback.reasoningEffort as Session['reasoningEffort'];
  session.modelPin = txn.rollback.pin ?? undefined;
  session.modelSwitchTxn = undefined;
}

/**
 * Settle the transaction against a coordinator terminal status for `attemptId`.
 * Only the bound attempt may settle; anything else is ignored (rev16 §3.5.1).
 * `succeeded` → commit (txn cleared, pin kept); `failed` → rollback;
 * `timed_out` → ambiguous (frozen, no rollback).
 */
export function settleModelSwitch(
  session: ModelSwitchSession,
  attemptId: string,
  status: 'succeeded' | 'failed' | 'timed_out',
): SettleOutcome {
  const txn = session.modelSwitchTxn;
  if (!txn || txn.attemptId !== attemptId) return 'ignored';
  if (txn.state === 'rolling_back') {
    // Physical convergence of a force-rollback: the record was already
    // restored when the restart was accepted; only the transaction's fate is
    // decided here. Anything but `succeeded` keeps it recoverable (ambiguous).
    if (status === 'succeeded') { session.modelSwitchTxn = undefined; return 'rolled_back'; }
    txn.state = 'ambiguous';
    txn.lastStatus = status;
    return 'ambiguous';
  }
  if (status === 'succeeded') {
    session.modelSwitchTxn = undefined;
    return 'committed';
  }
  if (status === 'failed') {
    applyRollbackInMemory(session, txn);
    return 'rolled_back';
  }
  txn.state = 'ambiguous';
  txn.lastStatus = 'timed_out';
  return 'ambiguous';
}

/**
 * Begin a force-rollback from `ambiguous`: restore the record (model / effort /
 * pin) but KEEP the transaction, re-bound to the convergence restart attempt,
 * until that attempt reports `succeeded` (see settleModelSwitch). Memory only.
 */
export function beginForceRollback(session: ModelSwitchSession, attemptId: string): ModelSwitchTxn | undefined {
  const txn = session.modelSwitchTxn;
  if (!txn || txn.state !== 'ambiguous') return undefined;
  session.model = txn.rollback.model;
  session.reasoningEffort = txn.rollback.reasoningEffort as Session['reasoningEffort'];
  session.modelPin = txn.rollback.pin ?? undefined;
  txn.state = 'rolling_back';
  txn.attemptId = attemptId;
  return txn;
}

/** Force-rollback from `ambiguous` (or a stale in_flight after a daemon restart). */
export function forceRollbackModelSwitch(session: ModelSwitchSession): boolean {
  const txn = session.modelSwitchTxn;
  if (!txn) return false;
  applyRollbackInMemory(session, txn);
  return true;
}

export interface RecheckAttestation {
  model: string | null;
  effort: string | null;
  effortProvenance: 'explicit' | 'default' | 'unknown';
  workerGeneration: number;
}

/** The attested (model, effort) equals a target/rollback (model, effort)?
 *  Effort: an explicit target must be attested verbatim; an unset target is
 *  satisfied only by "no explicit effort" (null, or a CLI default). */
function attestationMatches(
  att: RecheckAttestation,
  want: { model?: string; effort?: string },
): boolean {
  if (att.model !== (want.model ?? null)) return false;
  if (want.effort !== undefined) return att.effort === want.effort && att.effortProvenance === 'explicit';
  return att.effort === null || att.effortProvenance !== 'explicit';
}

/**
 * Recheck an ambiguous transaction against the verified launch attestation of
 * the CURRENT worker generation. Only a verified fact may decide: model AND
 * effort must both match (an effort-only switch is not proven by an unchanged
 * model), and a fresh-only switch additionally needs a NEW thread id to have
 * been committed. Otherwise the transaction stays ambiguous.
 */
export function recheckModelSwitch(
  session: ModelSwitchSession,
  attestation: RecheckAttestation | undefined,
  currentGeneration: number | undefined,
): SettleOutcome {
  const txn = session.modelSwitchTxn;
  if (!txn || txn.state !== 'ambiguous') return 'ignored';
  if (!attestation || currentGeneration === undefined || attestation.workerGeneration !== currentGeneration) return 'ambiguous';
  if (attestationMatches(attestation, txn.target)) {
    if (txn.freshThread) {
      const before = txn.rollback.cliSessionId;
      const now = session.cliSessionId;
      if (!now || now === before) return 'ambiguous';
    }
    session.modelSwitchTxn = undefined;
    return 'committed';
  }
  if (attestationMatches(attestation, { model: txn.rollback.model, effort: txn.rollback.reasoningEffort })) {
    applyRollbackInMemory(session, txn);
    return 'rolled_back';
  }
  return 'ambiguous';
}

/** Human-readable label for a pin/target (model + effort). */
export function describeModelTarget(t: { model?: string; effort?: string } | undefined): string {
  if (!t) return 'CLI 默认';
  const m = t.model ?? 'CLI 默认';
  return t.effort ? `${m} · ${t.effort}` : m;
}
