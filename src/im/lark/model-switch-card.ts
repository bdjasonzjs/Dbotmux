/**
 * Card-driven model switch — click handling (design card-model-switch-s1 rev16,
 * v1 subset). Reached from card-handler for the nine `model_*` / `effort_pick`
 * actions AFTER the generic sensitive-action gate has passed; this module then
 * applies the FULL v1 gate itself so the nine actions share one identity check
 * (§6): callback operator open_id → verifiable `on_` union_id → not a team /
 * platform bot → canOperate(openId) → proven-internal chat → not adopt / remote
 * → wrapper-first capability. Every refusal is fail-closed with zero mutation.
 *
 * Flow: 「⚙ 模型」 (model_menu_open) → ephemeral menu listing the models this
 * session can switch to (model-catalog: static + live, scoped per bot env) →
 * model_pick / effort_pick / model_custom_save → (confirm card when the switch
 * interrupts a turn or starts a NEW thread) → requestModelSwitchRestart (strict)
 * → receipt on the coordinator terminal status for THAT attempt.
 */
import { randomBytes } from 'node:crypto';
import type { DaemonSession } from '../../core/types.js';
import type { CliId } from '../../adapters/cli/types.js';
import { getBot } from '../../bot-registry.js';
import { config } from '../../config.js';
import { t, localeForBot, type Locale } from '../../i18n/index.js';
import { logger } from '../../utils/logger.js';
import * as sessionStore from '../../services/session-store.js';
import { isProvenInternalChat } from '../../core/external-chat.js';
import { isSharedAdoptSession } from '../../core/shared-adopt.js';
import { isRemoteBackendSession } from '../../core/persistent-backend.js';
import { selectionKeyForBot } from '../../setup/cli-selection.js';
import { staticModelChoices, detectModels, mergeModelChoices } from '../../services/model-catalog.js';
import { reasoningEffortsForCliModel } from '../../services/codex-reasoning-effort.js';
import { isTeamBot } from '../../services/team-bots-store.js';
import { isPlatformTeamBot } from '../../services/platform-team-store.js';
import { canOperate } from './event-dispatcher.js';
import {
  sessionSupportsModelSwitch, capabilityForSession, describeModelTarget, recheckModelSwitch,
} from '../../core/model-switch.js';
import {
  requestModelSwitchRestart, requestModelSwitchForceRollback, requestSessionRestart, deliverEphemeralOrReply,
  activeSessionRestartAttemptId, type ModelSwitchRefusal,
} from '../../core/worker-pool.js';
import { buildModelMenuCard, buildModelCustomCard, buildModelPickConfirmCard, getCliDisplayName, type ModelMenuCardData, type ModelConfirmSource } from './card-builder.js';

export const MODEL_SWITCH_CARD_ACTIONS = [
  'effort_pick', 'model_custom_open', 'model_custom_save', 'model_menu_open', 'model_menu_refresh',
  'model_pick', 'model_pick_confirm', 'model_txn_force_rollback', 'model_txn_recheck',
] as const;
export type ModelSwitchCardAction = typeof MODEL_SWITCH_CARD_ACTIONS[number];

export function isModelSwitchCardAction(action: unknown): action is ModelSwitchCardAction {
  return typeof action === 'string' && (MODEL_SWITCH_CARD_ACTIONS as readonly string[]).includes(action);
}

/** Model names accepted from the custom input. Provider-prefixed ids
 *  (`deepseek/deepseek-v4-pro`) and versioned ids (`gpt-5.5`) must pass. */
export const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/;

export interface CardOperatorIdentityLike { unionId?: string; openId?: string }

/** Identity seams — production wiring lives in card-handler (which owns
 *  resolveCardOperatorUnionId); tests inject fakes. */
export interface ModelSwitchIdentityDeps {
  /** Resolve the callback operator to a verified `on_` union id (three-state,
   *  fail-closed to `{ openId }` when it cannot be verified). */
  resolveOperator: () => Promise<CardOperatorIdentityLike>;
  /** Team / platform bot roster check by union id. */
  isBotUnionId: (unionId: string) => boolean;
  /** Bot allowlist check by open id ONLY (never a union id). */
  canOperate: (larkAppId: string, chatId: string, openId: string) => boolean;
}

export function defaultModelSwitchIdentityDeps(
  resolveOperator: () => Promise<CardOperatorIdentityLike>,
): ModelSwitchIdentityDeps {
  return {
    resolveOperator,
    isBotUnionId: (u) => isTeamBot(config.session.dataDir, u) || isPlatformTeamBot(config.session.dataDir, u),
    canOperate: (appId, chatId, openId) => canOperate(appId, chatId, openId),
  };
}

export type CatalogLookup = (key: string, opts: { env?: Record<string, string>; scope: string; force: boolean }) => Promise<{ models: string[]; source: 'static' | 'live' | 'none' }>;

export interface ModelSwitchCardContext {
  ds: DaemonSession;
  /** Raw callback operator open_id (from `data.operator.open_id` only). */
  operatorOpenId: string | undefined;
  rootId: string;
  larkAppId: string;
  value: Record<string, any>;
  /** Lark card action payload (form_value for form_submit). */
  action: Record<string, any> | undefined;
  sessionReply: (rootId: string, content: string, msgType?: string) => Promise<unknown>;
  identity: ModelSwitchIdentityDeps;
  /** Test seam: override catalog lookup. */
  catalog?: CatalogLookup;
}

type Toast = { toast: { type: 'success' | 'info' | 'warning' | 'error'; content: string } };

/**
 * Server-side pending confirmations (P1-1 r3). The confirmation hop must keep
 * the FIRST hop's entry semantics (curated vs custom) without trusting the
 * card: the first hop records what it offered, keyed by bot+session; the
 * confirmation is accepted only when it names exactly that offer, from the
 * same operator, within the TTL, and is consumed on use. The `source` field
 * in the button value is informational (dedupe / debugging), never authority.
 */
export interface PendingModelConfirm {
  model?: string;
  effort?: string;
  source: ModelConfirmSource;
  operatorOpenId: string;
  createdAt: number;
}
export const PENDING_CONFIRM_TTL_MS = 10 * 60 * 1000;
const pendingConfirms = new Map<string, PendingModelConfirm>();
const pendingKey = (larkAppId: string, sessionId: string) => `${larkAppId}::${sessionId}`;
export function __testOnly_resetPendingConfirms(): void { pendingConfirms.clear(); }
function rememberPending(ctx: ModelSwitchCardContext, p: Omit<PendingModelConfirm, 'createdAt' | 'operatorOpenId'>): void {
  pendingConfirms.set(pendingKey(ctx.larkAppId, ctx.ds.session.sessionId), { ...p, operatorOpenId: ctx.operatorOpenId ?? '', createdAt: Date.now() });
}
/** Take the pending offer if the confirmation matches it exactly; else undefined (and nothing is consumed). */
function takePending(ctx: ModelSwitchCardContext, model: string | undefined, effort: string | undefined): PendingModelConfirm | undefined {
  const key = pendingKey(ctx.larkAppId, ctx.ds.session.sessionId);
  const p = pendingConfirms.get(key);
  if (!p) return undefined;
  if (Date.now() - p.createdAt > PENDING_CONFIRM_TTL_MS) { pendingConfirms.delete(key); return undefined; }
  if (p.operatorOpenId !== (ctx.operatorOpenId ?? '')) return undefined;
  if (p.model !== model || p.effort !== effort) return undefined;
  pendingConfirms.delete(key);
  return p;
}
const toast = (type: Toast['toast']['type'], content: string): Toast => ({ toast: { type, content } });

function sessionCliId(ds: DaemonSession): CliId {
  return (ds.session.cliId ?? getBot(ds.larkAppId).config.cliId) as CliId;
}
function sessionWrapper(ds: DaemonSession): string | undefined {
  return ds.session.wrapperCli ?? (() => { try { return getBot(ds.larkAppId).config.wrapperCli; } catch { return undefined; } })();
}
function cliName(ds: DaemonSession): string {
  return getCliDisplayName(sessionCliId(ds));
}
function botEnv(ds: DaemonSession): Record<string, string> | undefined {
  try { return getBot(ds.larkAppId).config.env ?? undefined; } catch { return undefined; }
}
function newMenuId(): string { return randomBytes(4).toString('hex'); }

/** The session is mid-turn: switching would interrupt it → ask first. */
export function sessionLooksBusy(ds: Pick<DaemonSession, 'lastScreenStatus' | 'pendingInputCount'>): boolean {
  return ds.lastScreenStatus === 'working' || ds.lastScreenStatus === 'analyzing' || (ds.pendingInputCount ?? 0) > 0;
}

const defaultCatalog: CatalogLookup = async (key, opts) => {
  const stat = staticModelChoices(key);
  let live: readonly string[] | null = null;
  try {
    live = await detectModels(key, { env: opts.env, scope: opts.scope, force: opts.force });
  } catch { live = null; }
  const merged = mergeModelChoices(stat, live);
  if (merged.models.length === 0) return { models: [], source: 'none' };
  return { models: merged.models, source: merged.source };
};

/** Authoritative candidate set for THIS session right now (P1-5: never trust
 *  a round-tripped card value; recompute from the selection key + bot env). */
async function currentCandidates(ctx: ModelSwitchCardContext, force = false): Promise<{ models: string[]; source: 'static' | 'live' | 'none' }> {
  const { ds } = ctx;
  const key = selectionKeyForBot(sessionCliId(ds), sessionWrapper(ds));
  const lookup = ctx.catalog ?? defaultCatalog;
  return lookup(key, { env: botEnv(ds), scope: ds.larkAppId, force });
}

async function renderMenu(ctx: ModelSwitchCardContext, loc: Locale, force = false): Promise<string> {
  const { ds } = ctx;
  const cliId = sessionCliId(ds);
  const { models, source } = await currentCandidates(ctx, force);
  const att = ds.session.launchAttestation;
  const verifiedCurrent = att && att.workerGeneration === (ds.workerGeneration ?? 0) ? att : undefined;
  const pin = ds.session.modelPin;
  const txn = ds.session.modelSwitchTxn;
  const effortModel = pin?.model ?? verifiedCurrent?.model ?? undefined;
  const data: ModelMenuCardData = {
    sessionId: ds.session.sessionId,
    rootId: ctx.rootId,
    cliId,
    cliName: cliName(ds),
    menuId: newMenuId(),
    verifiedModel: verifiedCurrent ? verifiedCurrent.model : undefined,
    verifiedEffort: verifiedCurrent ? verifiedCurrent.effort : undefined,
    ...(pin ? { pin: { ...(pin.model !== undefined ? { model: pin.model } : {}), ...(pin.effort ? { effort: pin.effort } : {}) } } : {}),
    models,
    source,
    efforts: reasoningEffortsForCliModel(cliId, effortModel),
    currentEffort: ds.session.reasoningEffort,
    freshThreadNote: capabilityForSession(cliId, sessionWrapper(ds)) === 'fresh-only',
    ...(txn ? { txn: { state: txn.state === 'in_flight' ? 'in_flight' : txn.state === 'rolling_back' ? 'in_flight' : 'ambiguous', target: describeModelTarget(txn.target) } } : {}),
  };
  return buildModelMenuCard(data, loc);
}

async function deliverCard(ctx: ModelSwitchCardContext, cardJson: string): Promise<void> {
  await deliverEphemeralOrReply(ctx.ds, ctx.operatorOpenId, cardJson, 'interactive', () => ctx.sessionReply(ctx.rootId, cardJson, 'interactive'));
}

type RefusalKey = ModelSwitchRefusal | 'external' | 'same' | 'no_txn' | 'identity' | 'not_candidate' | 'not_admin' | 'no_pending_confirm';
function refusalToast(reason: RefusalKey, loc: Locale): Toast {
  return toast('warning', t(`card.model.refuse.${reason}`, undefined, loc));
}

/**
 * The shared identity gate (§6, six steps). Returns a refusal key or null.
 * Order matters: cheapest / most fundamental first; nothing is mutated here.
 */
export async function modelSwitchIdentityGate(ctx: ModelSwitchCardContext): Promise<RefusalKey | null> {
  const { ds } = ctx;
  const openId = ctx.operatorOpenId?.trim();
  if (!openId || !openId.startsWith('ou_')) return 'identity';
  let identity: CardOperatorIdentityLike;
  try { identity = await ctx.identity.resolveOperator(); } catch { return 'identity'; }
  const unionId = identity.unionId?.trim();
  if (!unionId || !unionId.startsWith('on_')) return 'identity';
  if (ctx.identity.isBotUnionId(unionId)) return 'identity';
  if (!ctx.identity.canOperate(ctx.larkAppId, ds.chatId, openId)) return 'not_admin';
  if (!isProvenInternalChat(ds)) return 'external';
  if (isSharedAdoptSession(ds)) return 'adopt';
  if (isRemoteBackendSession(ds)) return 'remote';
  if (!sessionSupportsModelSwitch(sessionCliId(ds), sessionWrapper(ds))) return 'unsupported';
  return null;
}

/** Start the switch and wire the receipts. Returns a toast for the click. */
async function startSwitch(
  ctx: ModelSwitchCardContext,
  loc: Locale,
  target: { model?: string; effort?: string },
): Promise<Toast> {
  const { ds } = ctx;
  const name = cliName(ds);
  const previous = describeModelTarget({
    model: ds.session.modelPin?.model ?? ds.session.launchAttestation?.model ?? ds.session.model,
    effort: ds.session.reasoningEffort,
  });
  const targetLabel = describeModelTarget(target);
  const say = (content: string) => deliverEphemeralOrReply(ds, ctx.operatorOpenId, content, 'text', () => ctx.sessionReply(ctx.rootId, content));
  const res = requestModelSwitchRestart(ds, { ...target, setBy: ctx.operatorOpenId ?? 'card' }, {
    source: 'card',
    notify: () => { /* receipts are emitted from onSettled; the generic restart toasts stay quiet */ },
    onSettled: async (outcome, txn) => {
      const tl = describeModelTarget(txn.target);
      if (outcome === 'committed') await say(t('card.model.switch_succeeded', { cliName: name, target: tl }, loc));
      else if (outcome === 'rolled_back') {
        // The record is restored; converge the PROCESS too. The worker's launch
        // snapshot still holds the failed target — this restart IPC carries the
        // restored model/effort. A refusal is surfaced, never swallowed.
        const conv = requestSessionRestart(ds, { source: 'card', notify: () => {} }, { strict: true });
        await say(t('card.model.switch_failed', { cliName: name, target: tl, previous }, loc)
          + (conv ? '' : `\n${t('card.model.convergence_refused', undefined, loc)}`));
      }
      else if (outcome === 'ambiguous') await say(t('card.model.switch_ambiguous', { cliName: name, target: tl }, loc));
    },
  });
  if (!res.ok) return refusalToast(res.reason, loc);
  logger.info(`[model-switch] ${ds.session.sessionId} → ${targetLabel} attempt=${res.attemptId} by=${ctx.operatorOpenId ?? '?'}`);
  const dropped = res.txn.rollback.reasoningEffort !== undefined && ds.session.reasoningEffort === undefined && target.effort === undefined;
  void say(t('card.model.switch_started', { cliName: name, target: targetLabel }, loc)
    + (dropped ? `\n${t('card.model.effort_dropped', { effort: res.txn.rollback.reasoningEffort ?? '', model: target.model ?? 'CLI default' }, loc)}` : ''));
  return toast('info', t('card.model.switch_started', { cliName: name, target: targetLabel }, loc));
}

async function confirmFirst(ctx: ModelSwitchCardContext, loc: Locale, target: { model?: string; effort?: string }, reason: 'busy' | 'fresh', source: ModelConfirmSource): Promise<undefined> {
  const { ds } = ctx;
  rememberPending(ctx, { ...target, source });
  await deliverCard(ctx, buildModelPickConfirmCard({
    sessionId: ds.session.sessionId, rootId: ctx.rootId, cliId: sessionCliId(ds), cliName: cliName(ds), menuId: newMenuId(),
  }, target, loc, reason, source));
  return undefined;
}

export async function handleModelSwitchCardAction(ctx: ModelSwitchCardContext): Promise<Toast | undefined> {
  const { ds, value } = ctx;
  const loc = localeForBot(ds.larkAppId);
  const actionType = value.action as ModelSwitchCardAction;

  // ── Shared gate (fail closed, zero mutation) ─────────────────────────────
  const refused = await modelSwitchIdentityGate(ctx);
  if (refused) {
    logger.warn(`[model-switch] ${ds.session.sessionId} ${actionType} refused: ${refused} operator=${ctx.operatorOpenId ?? '?'}`);
    return refusalToast(refused, loc);
  }
  const cliId = sessionCliId(ds);
  const freshOnly = capabilityForSession(cliId, sessionWrapper(ds)) === 'fresh-only';

  // A transaction left `in_flight` / `rolling_back` with no live attempt (daemon
  // restarted mid-switch) can never be settled by its attempt → freeze.
  const txn = ds.session.modelSwitchTxn;
  if (txn && txn.state !== 'ambiguous' && activeSessionRestartAttemptId(ds) !== txn.attemptId) {
    txn.state = 'ambiguous';
    sessionStore.updateSession(ds.session);
  }

  switch (actionType) {
    case 'model_menu_open':
    case 'model_menu_refresh': {
      const card = await renderMenu(ctx, loc, actionType === 'model_menu_refresh');
      await deliverCard(ctx, card);
      return undefined;
    }
    case 'model_custom_open': {
      await deliverCard(ctx, buildModelCustomCard({
        sessionId: ds.session.sessionId, rootId: ctx.rootId, cliId, cliName: cliName(ds), menuId: newMenuId(),
      }, loc));
      return undefined;
    }
    case 'model_pick':
    case 'model_pick_confirm':
    case 'model_custom_save': {
      let model: string | undefined;
      if (actionType === 'model_custom_save') {
        const fv = ctx.action?.form_value ?? {};
        model = String(fv.model ?? ctx.action?.input_value ?? '').trim() || undefined;
      } else {
        model = typeof value.model === 'string' ? value.model.trim() || undefined : undefined;
      }
      const effortRaw = typeof value.effort === 'string' && value.effort ? value.effort : undefined;
      // Entry semantics: decided by the ACTION on the first hop; on the
      // confirmation hop by the SERVER-SIDE pending offer this session made
      // (never by the card value). No matching offer → refused.
      let source: ModelConfirmSource;
      if (actionType === 'model_custom_save') source = 'custom';
      else if (actionType === 'model_pick') source = 'curated';
      else {
        const pending = takePending(ctx, model, effortRaw);
        if (!pending) return refusalToast('no_pending_confirm', loc);
        source = pending.source;
      }
      if (source === 'custom') {
        // Free-form entry (first hop AND its confirmation): name grammar only.
        if (model !== undefined && !MODEL_NAME_RE.test(model)) return toast('error', t('card.model.invalid_model', undefined, loc));
      } else {
        // P1-5: a curated pick (and its confirmation) is only ever a click on a
        // CURRENT candidate. Recompute the authoritative set; the value is a hint.
        if (model === undefined) return refusalToast('not_candidate', loc);
        const { models } = await currentCandidates(ctx);
        if (!models.includes(model)) return refusalToast('not_candidate', loc);
      }
      const effort = effortRaw;
      if (effort !== undefined && !reasoningEffortsForCliModel(cliId, model).includes(effort as any)) return refusalToast('effort_not_supported', loc);
      const currentModel = ds.session.modelPin?.model ?? ds.session.launchAttestation?.model ?? undefined;
      if (actionType !== 'model_custom_save' && model === currentModel && (effort === undefined || effort === ds.session.reasoningEffort)
          && !ds.session.modelSwitchTxn) {
        return refusalToast('same', loc);
      }
      const target = { ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) };
      if (actionType !== 'model_pick_confirm') {
        // fresh-only (codex-app) ALWAYS confirms: the old thread is lost (P1-4).
        if (freshOnly) return confirmFirst(ctx, loc, target, 'fresh', source);
        if (sessionLooksBusy(ds)) return confirmFirst(ctx, loc, target, 'busy', source);
      }
      return startSwitch(ctx, loc, target);
    }
    case 'effort_pick': {
      const effort = typeof value.effort === 'string' ? value.effort.trim() : '';
      const model = ds.session.modelPin?.model ?? ds.session.launchAttestation?.model ?? undefined;
      if (!effort || !reasoningEffortsForCliModel(cliId, model).includes(effort as any)) return refusalToast('effort_not_supported', loc);
      if (effort === ds.session.reasoningEffort && !ds.session.modelSwitchTxn) return refusalToast('same', loc);
      const target = { ...(model !== undefined ? { model } : {}), effort };
      // The effort row edits the CURRENT model (pin / attested), which need not
      // be a catalog member (it may itself have been a custom entry) → 'custom'
      // keeps the second hop on the grammar check rather than membership.
      const src: ModelConfirmSource = model === undefined ? 'custom' : (await currentCandidates(ctx)).models.includes(model) ? 'curated' : 'custom';
      if (freshOnly) return confirmFirst(ctx, loc, target, 'fresh', src);
      if (sessionLooksBusy(ds)) return confirmFirst(ctx, loc, target, 'busy', src);
      return startSwitch(ctx, loc, target);
    }
    case 'model_txn_recheck': {
      const cur = ds.session.modelSwitchTxn;
      if (!cur || cur.state !== 'ambiguous') return refusalToast('no_txn', loc);
      const att = ds.session.launchAttestation;
      const outcome = recheckModelSwitch(
        ds.session,
        att ? { model: att.model, effort: att.effort, effortProvenance: att.effortProvenance, workerGeneration: att.workerGeneration } : undefined,
        ds.workerGeneration,
      );
      if (outcome !== 'ambiguous') sessionStore.updateSession(ds.session);
      const name = cliName(ds);
      if (outcome === 'committed') return toast('success', t('card.model.recheck_committed', { cliName: name, target: describeModelTarget(cur.target) }, loc));
      if (outcome === 'rolled_back') return toast('info', t('card.model.recheck_rolled_back', { cliName: name }, loc));
      return toast('warning', t('card.model.recheck_ambiguous', undefined, loc));
    }
    case 'model_txn_force_rollback': {
      const cur = ds.session.modelSwitchTxn;
      if (!cur || cur.state !== 'ambiguous') return refusalToast('no_txn', loc);
      const previous = describeModelTarget({ model: cur.rollback.pin?.model ?? cur.rollback.model, effort: cur.rollback.reasoningEffort });
      const name = cliName(ds);
      const say = (content: string) => deliverEphemeralOrReply(ds, ctx.operatorOpenId, content, 'text', () => ctx.sessionReply(ctx.rootId, content));
      const res = requestModelSwitchForceRollback(ds, {
        source: 'card',
        notify: () => {},
        onSettled: async (outcome) => {
          if (outcome === 'rolled_back') await say(t('card.model.force_rollback_done', { cliName: name, previous }, loc));
          else await say(t('card.model.force_rollback_failed', { cliName: name }, loc));
        },
      });
      if (!res.ok) return refusalToast(res.reason, loc);
      // Not a success receipt: the record is restored, the process is converging.
      return toast('info', t('card.model.force_rollback_started', { cliName: name, previous }, loc));
    }
    default:
      return undefined;
  }
}
