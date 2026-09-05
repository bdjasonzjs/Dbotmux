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
  requestModelSwitchRestart, requestModelSwitchForceRollback, requestSessionRestart,
  activeSessionRestartAttemptId, buildStreamingCardJson, scheduleCardPatch, sendWorkerInput, sendWorkerSessionInput, isSessionTransferring,
  type ModelSwitchRefusal,
} from '../../core/worker-pool.js';
import { getCliDisplayName } from './card-builder.js';
import type { ModelConfirmSource } from '../../core/model-switch-offers.js';
import { createOffer, markOfferDelivered, consumeOffer } from '../../core/model-switch-offers.js';
import type { ModelPanelState } from '../../core/model-switch-panel.js';

export const MODEL_SWITCH_CARD_ACTIONS = [
  'effort_pick', 'model_custom_open', 'model_custom_save', 'model_menu_open', 'model_menu_refresh', 'model_menu_close',
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
const toast = (type: Toast['toast']['type'], content: string): Toast => ({ toast: { type, content } });
/** A raw card object: the dispatcher wraps it as an in-place patch of the clicked card. */
type CardResult = Record<string, unknown>;

// Server-side pending confirmations live in core/model-switch-offers.ts:
// unique offerId (= the confirm button's menu_id), creating→delivered→consumed
// lifecycle, one-shot consumption, bounded store, per-session cleanup.
export { PENDING_CONFIRM_TTL_MS, __testOnly_resetOffers as __testOnly_resetPendingConfirms } from '../../core/model-switch-offers.js';

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

/** The session is mid-turn: switching would interrupt it → say so in the confirm. */
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

/** Authoritative candidate set for THIS session right now (never trust a
 *  round-tripped card value; recompute from the selection key + bot env). */
async function currentCandidates(ctx: ModelSwitchCardContext, force = false): Promise<{ models: string[]; source: 'static' | 'live' | 'none' }> {
  const { ds } = ctx;
  const key = selectionKeyForBot(sessionCliId(ds), sessionWrapper(ds));
  const lookup = ctx.catalog ?? defaultCatalog;
  return lookup(key, { env: botEnv(ds), scope: ds.larkAppId, force });
}

/** The card, re-rendered from the session (the panel lives on `ds.modelPanel`). */
function renderCard(ds: DaemonSession): CardResult {
  return JSON.parse(buildStreamingCardJson(ds)) as CardResult;
}
/** Patch the live streaming card outside a callback (async settle paths). */
function patchCard(ds: DaemonSession): void {
  try { scheduleCardPatch(ds, buildStreamingCardJson(ds)); } catch (err) { logger.warn(`[model-switch] card patch failed: ${err}`); }
}

function currentModelOf(ds: DaemonSession): string | null | undefined {
  const att = ds.session.launchAttestation;
  const verified = att && att.workerGeneration === (ds.workerGeneration ?? 0) ? att.model : undefined;
  return ds.session.modelPin?.model ?? verified;
}

/** Enter the list state. Mutually exclusive with 「显示输出」: collapse it. */
async function openList(ctx: ModelSwitchCardContext, force: boolean, note?: string): Promise<CardResult> {
  const { ds } = ctx;
  const cliId = sessionCliId(ds);
  if ((ds.displayMode ?? 'hidden') !== 'hidden') {
    ds.displayMode = 'hidden';
    if (ds.worker || isSessionTransferring(ds)) sendWorkerSessionInput(ds, { type: 'set_display_mode', mode: 'hidden' } as any);
  }
  const { models, source } = await currentCandidates(ctx, force);
  const current = currentModelOf(ds);
  ds.modelPanel = {
    kind: 'list',
    menuId: newMenuId(),
    models,
    source,
    efforts: reasoningEffortsForCliModel(cliId, current ?? undefined),
    currentModel: current,
    currentEffort: ds.session.reasoningEffort,
    freshThread: capabilityForSession(cliId, sessionWrapper(ds)) === 'fresh-only',
    restartInFlight: activeSessionRestartAttemptId(ds) !== undefined,
    ...(note ? { note } : {}),
  };
  return renderCard(ds);
}

type RefusalKey = ModelSwitchRefusal | 'external' | 'same' | 'no_txn' | 'identity' | 'not_candidate' | 'not_admin' | 'no_pending_confirm';
function refusalText(reason: RefusalKey, loc: Locale): string {
  return t(`card.model.refuse.${reason}`, undefined, loc);
}
function refusalToast(reason: RefusalKey, loc: Locale): Toast {
  return toast('warning', refusalText(reason, loc));
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

/** Enter the confirm state for `target` (an offer is created and, since the
 *  patch IS the delivery, marked delivered right away). */
function enterConfirm(ctx: ModelSwitchCardContext, target: { model?: string; effort?: string }, reason: 'busy' | 'fresh' | 'plain', source: ModelConfirmSource): CardResult {
  const { ds } = ctx;
  const offer = createOffer({ larkAppId: ctx.larkAppId, sessionId: ds.session.sessionId, ...target, source, operatorOpenId: ctx.operatorOpenId ?? '' });
  markOfferDelivered(offer.offerId);
  ds.modelPanel = { kind: 'confirm', menuId: newMenuId(), offerId: offer.offerId, target, reason };
  return renderCard(ds);
}

/** Start the switch; the card shows "switching" until the coordinator settles it. */
function startSwitch(ctx: ModelSwitchCardContext, loc: Locale, target: { model?: string; effort?: string }): CardResult | Toast {
  const { ds } = ctx;
  const name = cliName(ds);
  const res = requestModelSwitchRestart(ds, { ...target, setBy: ctx.operatorOpenId ?? 'card' }, {
    source: 'card',
    notify: () => { /* the card is the receipt */ },
    onSettled: async (outcome, txn) => {
      const menuId = newMenuId();
      if (outcome === 'committed') {
        ds.modelPanel = undefined;
        patchCard(ds);
        // Owner requirement: the task resumes by itself after a confirmed switch.
        autoContinue(ds, loc);
      } else if (outcome === 'rolled_back') {
        const conv = requestSessionRestart(ds, { source: 'card', notify: () => {} }, { strict: true });
        ds.modelPanel = { kind: 'failed', menuId, target: txn.target, reason: t('card.model.reason_restart_failed', { cliName: name }, loc) + (conv ? '' : ` ${t('card.model.convergence_refused', undefined, loc)}`) };
        patchCard(ds);
      } else if (outcome === 'ambiguous') {
        ds.modelPanel = { kind: 'ambiguous', menuId, target: txn.target };
        patchCard(ds);
      }
    },
  });
  if (!res.ok) {
    ds.modelPanel = { kind: 'failed', menuId: newMenuId(), target, reason: refusalText(res.reason, loc) };
    return renderCard(ds);
  }
  logger.info(`[model-switch] ${ds.session.sessionId} → ${describeModelTarget(target)} attempt=${res.attemptId} by=${ctx.operatorOpenId ?? '?'}`);
  ds.modelPanel = { kind: 'switching', menuId: newMenuId(), target, attemptId: res.attemptId };
  return renderCard(ds);
}

/** After a committed switch, send "继续" so the interrupted task resumes. */
function autoContinue(ds: DaemonSession, loc: Locale): void {
  try {
    const text = t('card.model.auto_continue_text', undefined, loc);
    const accepted = ds.worker && !ds.worker.killed ? sendWorkerInput(ds, text) : false;
    logger.info(`[model-switch] ${ds.session.sessionId} auto-continue ${accepted ? 'sent' : 'NOT sent (no live worker)'}`);
  } catch (err) {
    logger.warn(`[model-switch] ${ds.session.sessionId} auto-continue failed: ${err}`);
  }
}

export async function handleModelSwitchCardAction(ctx: ModelSwitchCardContext): Promise<Toast | CardResult | undefined> {
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
  if (ds.session.modelSwitchTxn?.state === 'ambiguous' && ds.modelPanel?.kind !== 'ambiguous'
      && actionType !== 'model_txn_recheck' && actionType !== 'model_txn_force_rollback' && actionType !== 'model_menu_close') {
    ds.modelPanel = { kind: 'ambiguous', menuId: newMenuId(), target: ds.session.modelSwitchTxn.target };
    return renderCard(ds);
  }

  switch (actionType) {
    case 'model_menu_open':
      return openList(ctx, false);
    case 'model_menu_refresh':
      return openList(ctx, true);
    case 'model_menu_close': {
      // Collapse the picker (also dismisses a transient failure line).
      ds.modelPanel = undefined;
      return renderCard(ds);
    }
    case 'model_custom_open':
    case 'model_custom_save':
      // v2 main-card picker is list-only (owner spec); free-form entry is not offered.
      return toast('info', t('card.model.custom_not_in_v2', undefined, loc));
    case 'model_pick': {
      const model = typeof value.model === 'string' ? value.model.trim() || undefined : undefined;
      if (model === undefined) return refusalToast('not_candidate', loc);
      const { models } = await currentCandidates(ctx);
      if (!models.includes(model)) return refusalToast('not_candidate', loc);
      if (activeSessionRestartAttemptId(ds)) return refusalToast('restart_in_flight', loc);
      if (model === currentModelOf(ds) && !ds.session.modelSwitchTxn) return refusalToast('same', loc);
      return enterConfirm(ctx, { model }, freshOnly ? 'fresh' : sessionLooksBusy(ds) ? 'busy' : 'plain', 'curated');
    }
    case 'effort_pick': {
      const effort = typeof value.effort === 'string' ? value.effort.trim() : '';
      const model = currentModelOf(ds) ?? undefined;
      if (!effort || !reasoningEffortsForCliModel(cliId, model).includes(effort as any)) return refusalToast('effort_not_supported', loc);
      if (activeSessionRestartAttemptId(ds)) return refusalToast('restart_in_flight', loc);
      if (effort === ds.session.reasoningEffort && !ds.session.modelSwitchTxn) return refusalToast('same', loc);
      const target = { ...(model !== undefined ? { model } : {}), effort };
      const src: ModelConfirmSource = model === undefined ? 'custom' : (await currentCandidates(ctx)).models.includes(model) ? 'curated' : 'custom';
      return enterConfirm(ctx, target, freshOnly ? 'fresh' : sessionLooksBusy(ds) ? 'busy' : 'plain', src);
    }
    case 'model_pick_confirm': {
      const model = typeof value.model === 'string' ? value.model.trim() || undefined : undefined;
      const effort = typeof value.effort === 'string' && value.effort ? value.effort : undefined;
      // Entry semantics come from the SERVER-SIDE offer this session made (the
      // confirm button's menu_id is the offer id) — never from the card value.
      const pending = consumeOffer({
        offerId: typeof value.menu_id === 'string' ? value.menu_id : undefined,
        larkAppId: ctx.larkAppId, sessionId: ds.session.sessionId,
        operatorOpenId: ctx.operatorOpenId ?? '', model, effort,
      });
      if (!pending) return refusalToast('no_pending_confirm', loc);
      if (pending.source === 'custom') {
        if (model !== undefined && !MODEL_NAME_RE.test(model)) return toast('error', t('card.model.invalid_model', undefined, loc));
      } else {
        if (model === undefined) return refusalToast('not_candidate', loc);
        const { models } = await currentCandidates(ctx);
        if (!models.includes(model)) return refusalToast('not_candidate', loc);
      }
      if (effort !== undefined && !reasoningEffortsForCliModel(cliId, model).includes(effort as any)) return refusalToast('effort_not_supported', loc);
      return startSwitch(ctx, loc, { ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) });
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
      if (outcome === 'committed') { ds.modelPanel = undefined; return renderCard(ds); }
      if (outcome === 'rolled_back') { ds.modelPanel = { kind: 'failed', menuId: newMenuId(), target: cur.target, reason: t('card.model.recheck_rolled_back', { cliName: cliName(ds) }, loc) }; return renderCard(ds); }
      return toast('warning', t('card.model.recheck_ambiguous', undefined, loc));
    }
    case 'model_txn_force_rollback': {
      const cur = ds.session.modelSwitchTxn;
      if (!cur || cur.state !== 'ambiguous') return refusalToast('no_txn', loc);
      const previous = { model: cur.rollback.pin?.model ?? cur.rollback.model, effort: cur.rollback.reasoningEffort };
      const res = requestModelSwitchForceRollback(ds, {
        source: 'card',
        notify: () => {},
        onSettled: async (outcome) => {
          if (outcome === 'rolled_back') ds.modelPanel = undefined;
          else ds.modelPanel = { kind: 'ambiguous', menuId: newMenuId(), target: cur.target };
          patchCard(ds);
        },
      });
      if (!res.ok) return refusalToast(res.reason, loc);
      ds.modelPanel = { kind: 'switching', menuId: newMenuId(), target: previous, attemptId: res.attemptId };
      return renderCard(ds);
    }
    default:
      return undefined;
  }
}
