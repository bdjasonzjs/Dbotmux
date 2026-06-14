/**
 * 块7 第三轮 #1 — 一键开通 scope auth 链接.
 *
 * registerApp 无法带 scope（源码级证实），所以克隆的 scope 通过飞书「应用授权」
 * 链接开通：clone 建好拿到 appId → 拼 auth URL（q = 要开通的 scope）→ 把链接+二维码
 * 发进子群 @owner → owner 点开 → 全选 → 确认 → scope 开通，免手动粘 JSON。
 *
 * 本模块只做纯逻辑（scope 取值 + URL 拼装），不发消息、不碰 clone 写盘；投递由
 * 调用方做、且失败不回滚 clone（蔻黛 守点4）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AUTH_HOST = 'https://open.feishu.cn';

export interface ScopeSourceOpts {
  /** Optional override (default ~/.botmux/lark-scopes.json). */
  overridePath?: string;
  /** Packaged fallback (default dist/setup/lark-scopes.json beside the build). */
  packagePath?: string;
}

function defaultOverridePath(): string {
  return join(homedir(), '.botmux', 'lark-scopes.json');
}
/** Packaged scopes file: dist/setup/lark-scopes.json, beside this dist/services module. */
function defaultPackagePath(): string {
  return fileURLToPath(new URL('../setup/lark-scopes.json', import.meta.url));
}

function readTenantScopes(path: string): string[] | null {
  if (!existsSync(path)) return null;
  try {
    const obj = JSON.parse(readFileSync(path, 'utf-8'));
    const t = obj?.scopes?.tenant;
    return Array.isArray(t) ? t.filter((s: unknown): s is string => typeof s === 'string' && !!s.trim()) : null;
  } catch { return null; }
}

/**
 * Declared tenant scopes for a botmux bot, from lark-scopes.json. Override
 * (~/.botmux) wins; else packaged fallback; <b>fail closed</b> — if neither is
 * readable/parseable, throw (never silently yield [] → an empty `q=` link that
 * grants nothing, 蔻黛 守点1). Output is deduped + stably sorted.
 */
export function loadDeclaredScopes(opts: ScopeSourceOpts = {}): string[] {
  const override = opts.overridePath ?? defaultOverridePath();
  const pkg = opts.packagePath ?? defaultPackagePath();
  const scopes = readTenantScopes(override) ?? readTenantScopes(pkg);
  if (!scopes || scopes.length === 0) {
    throw new Error(`clone-auth-link: no usable scopes (override=${override}, package=${pkg}) — refusing to build an empty auth link`);
  }
  return [...new Set(scopes)].sort();
}

export type CloneScopeProfile = 'core' | 'full';

/**
 * 'core' (B+, default): the named least-privilege set a clone needs to work as a
 * botmux worker/reviewer in a subgroup — send/receive messages, be pulled into a
 * chat + read members, post cards/images, read message context + member names.
 * Reviewable permission面; every entry must exist in lark-scopes.json (asserted
 * in tests). 'full' (owner's explicit choice) grants full 本体-equivalence.
 *
 * NOTE (蔻黛 守点): `im:message` is a broad message scope that may overlap with
 * some of the granular `im:message.*` scopes here — they're kept for compatibility
 * across Feishu permission granularities, NOT because each is independently
 * required. Output is deduped + stably sorted, so overlap is harmless.
 */
export const CLONE_CORE_SCOPES: readonly string[] = [
  'im:message',                                    // send + receive messages
  'im:message:send_as_bot',                        // send as the bot
  'im:message:readonly',                           // read message context
  'im:message.group_msg',                          // group messages
  'im:message.group_at_msg:readonly',              // read @-messages
  'im:message.group_at_msg.include_bot:readonly',  // being @-ed (incl. bot)
  'im:chat:read',                                  // read chat info
  'im:chat.members:read',                          // read members
  'im:chat.members:bot_access',                    // bot membership access (被拉群)
  'im:resource',                                   // images / files (QR, screenshots)
  'cardkit:card:read',                             // interactive status cards
  'cardkit:card:write',
  'contact:user.base:readonly',                    // resolve member names
];

/**
 * Scopes to grant a clone, by profile (蔻黛 review: A/full must be owner's
 * EXPLICIT choice, not a silent default). 'core' REQUIRES every CLONE_CORE_SCOPES
 * entry to be present in the declared scopes — any missing → fail closed (no
 * partial grant); 'full' = all declared. Deduped + stably sorted. Default 'core';
 * final default awaits 松松.
 */
export function cloneGrantScopes(profile: CloneScopeProfile = 'core', opts: ScopeSourceOpts = {}): string[] {
  const declared = loadDeclaredScopes(opts);
  if (profile === 'full') return declared;
  // 'core' is a fixed named contract: EVERY CLONE_CORE_SCOPES entry must exist in
  // the effective declared scopes. If an override (~/.botmux) drops any of them,
  // FAIL CLOSED (list missing + refuse) rather than silently emit a partial core
  // grant link (蔻黛 review blocker).
  const declaredSet = new Set(declared);
  const missing = CLONE_CORE_SCOPES.filter(s => !declaredSet.has(s));
  if (missing.length > 0) {
    throw new Error(`clone-auth-link: core scopes missing from declared scopes: ${missing.join(', ')} — refusing to build a partial core auth link`);
  }
  return [...new Set(CLONE_CORE_SCOPES)].sort();
}

/**
 * Build the one-click scope-grant URL. Uses URLSearchParams so the encoder
 * handles the comma-joined `q` + scope names (蔻黛 守点3). No secret/token in the
 * URL — only appId + scopes (守点6).
 */
export function buildAuthUrl(appId: string, scopes: string[]): string {
  if (!appId) throw new Error('clone-auth-link: missing appId');
  if (!scopes.length) throw new Error('clone-auth-link: refusing to build an auth link with no scopes');
  const u = new URL(`/app/${encodeURIComponent(appId)}/auth`, AUTH_HOST);
  u.searchParams.set('q', scopes.join(','));
  u.searchParams.set('op_from', 'openapi');
  u.searchParams.set('token_type', 'tenant');
  return u.toString();
}
