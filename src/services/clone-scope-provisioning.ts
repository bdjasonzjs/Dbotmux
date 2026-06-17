/**
 * Clone scope gate for subgroup provisioning.
 *
 * A clone can be referenced by `subtask-start --bots <clone>` without going
 * through CEO-spawn's clone-creation path. Before inviting such a clone into a
 * subgroup, verify it has the core worker/reviewer scopes. Missing scopes still
 * require a human to approve in Feishu; this module only makes that need
 * explicit and fail-closed before a broken subgroup is created.
 */
import { HttpError } from '../core/main-bot-playbook.js';
import { readBotsJsonOrEmpty } from '../setup/bots-store.js';
import { listGrantedTenantScopes } from '../setup/verify-permissions.js';
import { sendMessage } from '../im/lark/client.js';
import { logger } from '../utils/logger.js';
import { buildAuthUrl, cloneGrantScopes, CLONE_CORE_SCOPES, type CloneScopeProfile } from './clone-auth-link.js';
import { defaultBotsJsonPath } from './bot-inventory.js';

export interface CloneScopeBot {
  larkAppId: string;
  name?: string;
  role?: string;
}

export type GrantedScopeCheck =
  | { ok: true; granted: string[] }
  | { ok: false; error: 'need_self_manage' | 'network' | 'unknown'; message: string };

export interface CloneScopeProvisioningDeps {
  readBotsJson?: () => any[];
  checkGrantedScopes?: (appId: string, appSecret: string) => Promise<GrantedScopeCheck>;
  postMessage?: (fromAppId: string, chatId: string, text: string) => Promise<unknown>;
}

export interface EnsureCloneScopesProvisionedReq {
  creatorLarkAppId: string;
  chatId: string;
  bots: CloneScopeBot[];
  profile?: CloneScopeProfile;
}

function isCloneEntry(entry: any): boolean {
  return typeof entry?.claudeConfigDir === 'string' && entry.claudeConfigDir.trim().length > 0;
}

async function defaultCheckGrantedScopes(appId: string, appSecret: string): Promise<GrantedScopeCheck> {
  return listGrantedTenantScopes(appId, appSecret, 'feishu');
}

function missingCoreScopes(granted: string[]): string[] {
  const grantedSet = new Set(granted);
  return CLONE_CORE_SCOPES.filter(scope => !grantedSet.has(scope));
}

function renderScopeWarning(bot: CloneScopeBot, missing: readonly string[], authUrl: string, checkError?: string): string {
  const display = bot.name?.trim() || bot.larkAppId;
  const role = bot.role ? ` / role=${bot.role}` : '';
  const missingLine = missing.length > 0 ? missing.join(', ') : '无法确认已授权 scope';
  const errorLine = checkError ? `\n自检结果：${checkError}` : '';
  return [
    `⚠️ 分身 ${display} (${bot.larkAppId}${role}) 缺少子群工作必需权限，已阻断建群。`,
    `缺失/待确认 scope：${missingLine}${errorLine}`,
    '请点开链接 → 全选 → 确认，完成授权后重试本次 subtask-start / ceo-spawn。',
    authUrl,
  ].join('\n');
}

/**
 * Verify every clone in a subgroup bot list before group creation.
 *
 * Non-clone bots are ignored. Any clone with missing or uncheckable core scopes
 * gets an auth link posted to the caller chat, then the provisioning path throws
 * 403 so the broken subgroup is not created silently.
 */
export async function ensureCloneScopesProvisioned(
  req: EnsureCloneScopesProvisionedReq,
  deps: CloneScopeProvisioningDeps = {},
): Promise<void> {
  const readBotsJson = deps.readBotsJson ?? (() => readBotsJsonOrEmpty(defaultBotsJsonPath()));
  const checkGrantedScopes = deps.checkGrantedScopes ?? defaultCheckGrantedScopes;
  const postMessage = deps.postMessage ?? ((from, chat, text) => sendMessage(from, chat, text, 'text'));
  const botsJson = readBotsJson();
  const byApp = new Map<string, any>();
  for (const entry of botsJson) {
    if (typeof entry?.larkAppId === 'string') byApp.set(entry.larkAppId, entry);
  }

  const seen = new Set<string>();
  for (const bot of req.bots) {
    if (!bot.larkAppId || seen.has(bot.larkAppId)) continue;
    seen.add(bot.larkAppId);
    const cfg = byApp.get(bot.larkAppId);
    if (!cfg || !isCloneEntry(cfg)) continue;

    const scopes = cloneGrantScopes(req.profile ?? 'core');
    const authUrl = buildAuthUrl(bot.larkAppId, scopes);
    const secret = typeof cfg.larkAppSecret === 'string' ? cfg.larkAppSecret : '';

    // Three-state gate (fail-safe): only HARD-BLOCK when we positively read a
    // non-empty granted-scope list AND a required scope is genuinely absent.
    // Every "cannot verify" state is FAIL-OPEN (advisory warn, no block):
    //   - no secret           → can't query
    //   - check.ok === false  → API error / need_self_manage / network
    //   - granted list empty  → application.v6.scope.list returns [] for clones
    //                           even when scopes ARE granted (observed in prod);
    //                           an empty list means "unverifiable", NOT "all missing".
    // This stops the gate from falsely locking a functional clone out of every
    // subgroup, while still catching a clone whose grants we CAN read and that
    // really lacks a required scope.
    if (!secret) {
      logger.warn(`[clone-scope] ${bot.larkAppId}: clone config has no larkAppSecret; cannot inspect granted scopes — allowing (fail-open)`);
      continue;
    }
    const check = await checkGrantedScopes(bot.larkAppId, secret);
    if (!check.ok) {
      logger.warn(`[clone-scope] ${bot.larkAppId}: scope self-check failed (${check.error}: ${check.message}) — cannot verify, allowing (fail-open)`);
      continue;
    }
    if (check.granted.length === 0) {
      logger.warn(`[clone-scope] ${bot.larkAppId}: scope.list returned 0 granted scopes (API does not reflect this clone's grants); cannot verify — allowing (fail-open)`);
      continue;
    }
    const missing = missingCoreScopes(check.granted);
    if (missing.length === 0) continue;

    // Positively determined: granted list was readable and a required scope is absent → block.
    const warning = renderScopeWarning(bot, missing, authUrl);
    try {
      await postMessage(req.creatorLarkAppId, req.chatId, warning);
    } catch (err: any) {
      logger.warn(`[clone-scope] failed to post auth link for ${bot.larkAppId}: ${err?.message ?? err}`);
      throw new HttpError(403, `clone ${bot.larkAppId} missing required scopes; auth link delivery failed, retry manually: ${authUrl}`);
    }
    throw new HttpError(403, `clone ${bot.larkAppId} missing required scopes: ${missing.join(', ')}`);
  }
}
