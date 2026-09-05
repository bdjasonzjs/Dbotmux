/**
 * Card-driven model switch — click handling (design card-model-switch-s1 rev16,
 * v1 subset). Reached from card-handler for the nine `model_*` / `effort_pick`
 * actions AFTER the generic sensitive-action gate (canOperate) has passed.
 *
 * Flow: 「⚙ 模型」 (model_menu_open) → ephemeral menu card listing the models
 * this session can switch to (model-catalog: static + live) → model_pick /
 * effort_pick / model_custom_save → requestModelSwitchRestart (strict) →
 * receipt on the coordinator's terminal status for THAT attempt.
 */
import { randomBytes } from 'node:crypto';
import type { DaemonSession } from '../../core/types.js';
import type { CliId } from '../../adapters/cli/types.js';
import { getBot } from '../../bot-registry.js';
import { t, localeForBot, type Locale } from '../../i18n/index.js';
import { logger } from '../../utils/logger.js';
import * as sessionStore from '../../services/session-store.js';
import { isProvenInternalChat } from '../../core/external-chat.js';
import { isSharedAdoptSession } from '../../core/shared-adopt.js';
import { isRemoteBackendSession } from '../../core/persistent-backend.js';
import { selectionKeyForBot } from '../../setup/cli-selection.js';
import { staticModelChoices, detectModels, mergeModelChoices } from '../../services/model-catalog.js';
import { reasoningEffortsForCliModel } from '../../services/codex-reasoning-effort.js';
import {
  cliSupportsModelSwitch, modelSwitchCapability, describeModelTarget,
  recheckModelSwitch, forceRollbackModelSwitch,
} from '../../core/model-switch.js';
import {
  requestModelSwitchRestart, requestSessionRestart, deliverEphemeralOrReply,
  activeSessionRestartAttemptId, type ModelSwitchRefusal,
} from '../../core/worker-pool.js';
import { buildModelMenuCard, buildModelCustomCard, buildModelPickConfirmCard, getCliDisplayName, type ModelMenuCardData } from './card-builder.js';

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

export interface ModelSwitchCardContext {
  ds: DaemonSession;
  operatorOpenId: string | undefined;
  rootId: string;
  larkAppId: string;
  value: Record<string, any>;
  /** Lark card action payload (form_value for form_submit). */
  action: Record<string, any> | undefined;
  sessionReply: (rootId: string, content: string, msgType?: string) => Promise<unknown>;
  /** Test seam: override catalog lookup. */
  catalog?: (key: string, opts: { env?: Record<string, string>; force?: boolean }) => Promise<{ models: string[]; source: 'static' | 'live' | 'none' }>;
}

type Toast = { toast: { type: 'success' | 'info' | 'warning' | 'error'; content: string } };
const toast = (type: Toast['toast']['type'], content: string): Toast => ({ toast: { type, content } });

function sessionCliId(ds: DaemonSession): CliId {
  return (ds.session.cliId ?? getBot(ds.larkAppId).config.cliId) as CliId;
}
function cliName(ds: DaemonSession): string {
  return getCliDisplayName(sessionCliId(ds));
}
function botEnv(ds: DaemonSession): Record<string, string> | undefined {
  try { return getBot(ds.larkAppId).config.env ?? undefined; } catch { return undefined; }
}

/** The session is mid-turn: switching would interrupt it → ask first. */
export function sessionLooksBusy(ds: Pick<DaemonSession, 'lastScreenStatus' | 'pendingInputCount'>): boolean {
  return ds.lastScreenStatus === 'working' || ds.lastScreenStatus === 'analyzing' || (ds.pendingInputCount ?? 0) > 0;
}

async function defaultCatalog(
  ds: DaemonSession,
  key: string,
  opts: { env?: Record<string, string>; force?: boolean },
): Promise<{ models: string[]; source: 'static' | 'live' | 'none' }> {
  const stat = staticModelChoices(key);
  let live: readonly string[] | null = null;
  try {
    live = await detectModels(key, { env: opts.env, ...(opts.force ? { now: () => Number.MAX_SAFE_INTEGER } : {}) });
  } catch { live = null; }
  const merged = mergeModelChoices(stat, live);
  if (merged.models.length === 0) return { models: [], source: 'none' };
  return { models: merged.models, source: merged.source };
}

async function renderMenu(ctx: ModelSwitchCardContext, loc: Locale, force = false): Promise<string> {
  const { ds } = ctx;
  const cliId = sessionCliId(ds);
  const key = selectionKeyForBot(cliId, ds.session.wrapperCli ?? getBot(ds.larkAppId).config.wrapperCli);
  const catalog = ctx.catalog ?? ((k, o) => defaultCatalog(ds, k, o));
  const { models, source } = await catalog(key, { env: botEnv(ds), force });
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
    menuId: randomBytes(4).toString('hex'),
    verifiedModel: verifiedCurrent ? verifiedCurrent.model : undefined,
    verifiedEffort: verifiedCurrent ? verifiedCurrent.effort : undefined,
    ...(pin ? { pin: { ...(pin.model !== undefined ? { model: pin.model } : {}), ...(pin.effort ? { effort: pin.effort } : {}) } } : {}),
    models,
    source,
    efforts: reasoningEffortsForCliModel(cliId, effortModel),
    currentEffort: ds.session.reasoningEffort,
    freshThreadNote: modelSwitchCapability(cliId) === 'fresh-only',
    ...(txn ? { txn: { state: txn.state, target: describeModelTarget(txn.target) } } : {}),
  };
  return buildModelMenuCard(data, loc);
}

async function deliverCard(ctx: ModelSwitchCardContext, cardJson: string): Promise<void> {
  await deliverEphemeralOrReply(ctx.ds, ctx.operatorOpenId, cardJson, 'interactive', () => ctx.sessionReply(ctx.rootId, cardJson, 'interactive'));
}

function refusalToast(reason: ModelSwitchRefusal | 'external' | 'same' | 'no_txn', loc: Locale): Toast {
  return toast('warning', t(`card.model.refuse.${reason}`, undefined, loc));
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
        await say(t('card.model.switch_failed', { cliName: name, target: tl, previous }, loc));
        // The record is restored; converge the PROCESS too. The worker's launch
        // snapshot still holds the failed target — this restart IPC carries the
        // restored model/effort (and is merged into any in-flight respawn, which
        // still takes the field update before its merge guard).
        requestSessionRestart(ds, { source: 'card', notify: () => {} }, { strict: true });
      }
      else if (outcome === 'ambiguous') await say(t('card.model.switch_ambiguous', { cliName: name, target: tl }, loc));
    },
  });
  if (!res.ok) return refusalToast(res.reason, loc);
  logger.info(`[model-switch] ${ds.session.sessionId} → ${targetLabel} attempt=${res.attemptId} by=${ctx.operatorOpenId ?? '?'}`);
  const dropped = ds.session.reasoningEffort === undefined && txnHadEffortBefore(res.txn) && target.effort === undefined;
  void say(t('card.model.switch_started', { cliName: name, target: targetLabel }, loc)
    + (dropped ? `\n${t('card.model.effort_dropped', { effort: res.txn.rollback.reasoningEffort ?? '', model: target.model ?? 'CLI default' }, loc)}` : ''));
  return toast('info', t('card.model.switch_started', { cliName: name, target: targetLabel }, loc));
}
function txnHadEffortBefore(txn: { rollback: { reasoningEffort?: string } }): boolean {
  return txn.rollback.reasoningEffort !== undefined;
}

export async function handleModelSwitchCardAction(ctx: ModelSwitchCardContext): Promise<Toast | undefined> {
  const { ds, value } = ctx;
  const loc = localeForBot(ds.larkAppId);
  const actionType = value.action as ModelSwitchCardAction;
  const cliId = sessionCliId(ds);

  // ── Gates (fail closed) ────────────────────────────────────────────────
  if (!ctx.operatorOpenId) return refusalToast('external', loc);
  if (!isProvenInternalChat(ds)) return refusalToast('external', loc);
  if (isSharedAdoptSession(ds)) return refusalToast('adopt', loc);
  if (isRemoteBackendSession(ds)) return refusalToast('remote', loc);
  if (!cliSupportsModelSwitch(cliId)) return refusalToast('unsupported', loc);

  // A transaction left `in_flight` with no live attempt (daemon restarted
  // mid-switch) can never be settled by its attempt → freeze as ambiguous.
  const txn = ds.session.modelSwitchTxn;
  if (txn?.state === 'in_flight' && activeSessionRestartAttemptId(ds) !== txn.attemptId) {
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
        sessionId: ds.session.sessionId, rootId: ctx.rootId, cliId, cliName: cliName(ds), menuId: randomBytes(4).toString('hex'),
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
      if (model !== undefined && !MODEL_NAME_RE.test(model)) return toast('error', t('card.model.invalid_model', undefined, loc));
      const effort = typeof value.effort === 'string' && value.effort ? value.effort : undefined;
      const currentModel = ds.session.modelPin?.model ?? ds.session.launchAttestation?.model ?? undefined;
      if (actionType !== 'model_custom_save' && model === currentModel && (effort === undefined || effort === ds.session.reasoningEffort)
          && !ds.session.modelSwitchTxn) {
        return refusalToast('same', loc);
      }
      if (actionType !== 'model_pick_confirm' && sessionLooksBusy(ds)) {
        await deliverCard(ctx, buildModelPickConfirmCard({
          sessionId: ds.session.sessionId, rootId: ctx.rootId, cliId, cliName: cliName(ds), menuId: randomBytes(4).toString('hex'),
        }, { ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) }, loc));
        return undefined;
      }
      return startSwitch(ctx, loc, { ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) });
    }
    case 'effort_pick': {
      const effort = typeof value.effort === 'string' ? value.effort.trim() : '';
      if (!effort) return toast('error', t('card.model.refuse.effort_not_supported', undefined, loc));
      if (effort === ds.session.reasoningEffort && !ds.session.modelSwitchTxn) return refusalToast('same', loc);
      const model = ds.session.modelPin?.model ?? ds.session.launchAttestation?.model ?? undefined;
      if (sessionLooksBusy(ds)) {
        await deliverCard(ctx, buildModelPickConfirmCard({
          sessionId: ds.session.sessionId, rootId: ctx.rootId, cliId, cliName: cliName(ds), menuId: randomBytes(4).toString('hex'),
        }, { ...(model !== undefined ? { model } : {}), effort }, loc));
        return undefined;
      }
      return startSwitch(ctx, loc, { ...(model !== undefined ? { model } : {}), effort });
    }
    case 'model_txn_recheck': {
      const cur = ds.session.modelSwitchTxn;
      if (!cur) return refusalToast('no_txn', loc);
      const att = ds.session.launchAttestation;
      const outcome = recheckModelSwitch(ds.session, att ? { model: att.model, workerGeneration: att.workerGeneration } : undefined, ds.workerGeneration);
      if (outcome !== 'ambiguous') sessionStore.updateSession(ds.session);
      const name = cliName(ds);
      if (outcome === 'committed') return toast('success', t('card.model.recheck_committed', { cliName: name, target: describeModelTarget(cur.target) }, loc));
      if (outcome === 'rolled_back') return toast('info', t('card.model.recheck_rolled_back', { cliName: name }, loc));
      return toast('warning', t('card.model.recheck_ambiguous', undefined, loc));
    }
    case 'model_txn_force_rollback': {
      const cur = ds.session.modelSwitchTxn;
      if (!cur) return refusalToast('no_txn', loc);
      const previous = describeModelTarget({ model: cur.rollback.pin?.model ?? cur.rollback.model, effort: cur.rollback.reasoningEffort });
      forceRollbackModelSwitch(ds.session);
      sessionStore.updateSession(ds.session);
      const name = cliName(ds);
      // Bring the process back in line with the restored record (strict: if a
      // restart is already in flight the record is still restored, the next
      // spawn picks it up).
      requestSessionRestart(ds, {
        source: 'card',
        notify: status => {
          if (status === 'in_progress') return;
          const content = t(`cmd.restart.${status}`, { cliName: name }, loc);
          return deliverEphemeralOrReply(ds, ctx.operatorOpenId, content, 'text', () => ctx.sessionReply(ctx.rootId, content));
        },
      }, { strict: true });
      return toast('info', t('card.model.force_rolled_back', { previous, cliName: name }, loc));
    }
    default:
      return undefined;
  }
}
