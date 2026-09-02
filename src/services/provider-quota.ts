/**
 * Provider quota / balance for the streaming-card usage line.
 *
 * Three account-level facts, one per credential kind:
 *   - DeepSeek (pay-as-you-go API key)       → account balance (¥ / $)
 *   - Claude Code (claude.ai OAuth login)    → 7-day window remaining %
 *   - Codex (ChatGPT login)                  → 7-day window remaining %
 *
 * Design rules:
 *   - The card render path is synchronous and hot. {@link peekProviderQuota}
 *     never blocks: it returns the last good value from the in-memory cache and,
 *     when that value is stale, kicks off ONE background refresh per bot.
 *   - Upstream calls are rare (default 10 min success TTL, 5 min failure
 *     backoff, `Retry-After` honored on 429) and de-duplicated per bot.
 *   - Failure degrades to "not shown": a stale value is reused for a bounded
 *     grace period, then dropped. Nothing is ever estimated or invented.
 *   - Credentials are read from the bot config / local credential files at call
 *     time (rotation-safe) and never logged; error logs carry status codes only.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { ProxyAgent } from 'proxy-agent';
import { logger } from '../utils/logger.js';

/** Account-level quota fact rendered on the usage line. */
export type ProviderQuota =
  | {
    kind: 'balance';
    /** ISO-4217 code as reported upstream (e.g. `CNY`, `USD`). */
    currency: string;
    amount: number;
  }
  | {
    kind: 'window';
    /** Which rolling window the percentage describes. */
    window: 'weekly';
    /** Remaining share of the window, 0–100 (upstream reports used %). */
    remainingPercent: number;
    /** Epoch ms when the window resets, if upstream reports it. */
    resetsAt?: number;
  };

/** The subset of a bot config the resolver needs. Kept structural so this
 *  module does not import bot-registry (which imports the card stack). */
export interface ProviderQuotaBotConfig {
  cliId?: string;
  env?: Record<string, string>;
  model?: string;
}

/** Resolved upstream request for one bot. `headers` holds the credential —
 *  never log or serialize this object. */
interface QuotaSource {
  provider: 'deepseek' | 'claude-oauth' | 'codex-chatgpt';
  url: string;
  headers: Record<string, string>;
}

export interface ProviderQuotaTransportResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
}

export type ProviderQuotaTransport = (
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
) => Promise<ProviderQuotaTransportResponse>;

interface CacheEntry {
  quota: ProviderQuota | null;
  /** When `quota` was fetched successfully (ms). 0 = never. */
  fetchedAt: number;
  /** Earliest time the next upstream call may be attempted (ms). */
  nextAttemptAt: number;
  inflight: Promise<void> | null;
}

/** A successful value is served without refetching for this long. */
export const PROVIDER_QUOTA_TTL_MS = 10 * 60_000;
/** After a failure, wait this long before retrying (unless Retry-After is larger). */
export const PROVIDER_QUOTA_FAILURE_BACKOFF_MS = 5 * 60_000;
/** Longest Retry-After we honor before clamping (defensive against bogus headers). */
export const PROVIDER_QUOTA_MAX_RETRY_AFTER_MS = 6 * 60 * 60_000;
/** A stale value keeps rendering for this long past its fetch time, then hides. */
export const PROVIDER_QUOTA_STALE_GRACE_MS = 60 * 60_000;
export const PROVIDER_QUOTA_REQUEST_TIMEOUT_MS = 8_000;

const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';
const CLAUDE_OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const WEEK_SECONDS = 7 * 24 * 3600;

const cache = new Map<string, CacheEntry>();
let transport: ProviderQuotaTransport = defaultTransport;
let clock: () => number = () => Date.now();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Non-blocking read for the card renderer. Returns the cached quota (or null
 *  when nothing usable is known) and schedules a background refresh when due.
 *  Never throws. */
export function peekProviderQuota(
  larkAppId: string,
  config: ProviderQuotaBotConfig | undefined,
): ProviderQuota | null {
  try {
    const source = resolveQuotaSource(config);
    if (!source) return null;
    const now = clock();
    const entry = cache.get(larkAppId) ?? {
      quota: null, fetchedAt: 0, nextAttemptAt: 0, inflight: null,
    };
    cache.set(larkAppId, entry);
    const fresh = entry.quota !== null && now - entry.fetchedAt < PROVIDER_QUOTA_TTL_MS;
    if (!fresh && !entry.inflight && now >= entry.nextAttemptAt) {
      entry.inflight = refreshEntry(larkAppId, entry, source)
        .catch(() => undefined)
        .finally(() => { entry.inflight = null; });
    }
    if (entry.quota !== null && now - entry.fetchedAt <= PROVIDER_QUOTA_STALE_GRACE_MS) {
      return entry.quota;
    }
    return null;
  } catch {
    return null;
  }
}

/** Await-able refresh (used by tests and by callers that want an exact value
 *  at a turn boundary). Resolves to the current cached quota; never throws. */
export async function refreshProviderQuota(
  larkAppId: string,
  config: ProviderQuotaBotConfig | undefined,
): Promise<ProviderQuota | null> {
  const source = resolveQuotaSource(config);
  if (!source) return null;
  const entry = cache.get(larkAppId) ?? {
    quota: null, fetchedAt: 0, nextAttemptAt: 0, inflight: null,
  };
  cache.set(larkAppId, entry);
  if (entry.inflight) {
    await entry.inflight;
  } else if (clock() >= entry.nextAttemptAt) {
    entry.inflight = refreshEntry(larkAppId, entry, source)
      .catch(() => undefined)
      .finally(() => { entry.inflight = null; });
    await entry.inflight;
  }
  return entry.quota;
}

/** Which upstream (if any) a bot's credentials map to. Exposed for tests and
 *  diagnostics; the returned value carries no secret. */
export function describeProviderQuotaSource(
  config: ProviderQuotaBotConfig | undefined,
): QuotaSource['provider'] | null {
  return resolveQuotaSource(config)?.provider ?? null;
}

// ---------------------------------------------------------------------------
// Source resolution (credential lookup — values never leave this module)
// ---------------------------------------------------------------------------

function resolveQuotaSource(config: ProviderQuotaBotConfig | undefined): QuotaSource | null {
  if (!config) return null;
  const env = config.env ?? {};
  const deepseekKey = env.DEEPSEEK_API_KEY?.trim();
  if (deepseekKey) {
    return {
      provider: 'deepseek',
      url: DEEPSEEK_BALANCE_URL,
      headers: { Authorization: `Bearer ${deepseekKey}` },
    };
  }
  if (config.cliId === 'claude-code') {
    // A third-party Anthropic-compatible relay (GLM etc.) has no claude.ai
    // subscription window; the OAuth usage endpoint would be meaningless.
    if (env.ANTHROPIC_BASE_URL?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim()) return null;
    const token = env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || readClaudeCredentialsToken(env);
    if (!token) return null;
    return {
      provider: 'claude-oauth',
      url: CLAUDE_OAUTH_USAGE_URL,
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
      },
    };
  }
  if (config.cliId === 'codex' || config.cliId === 'codex-app') {
    const auth = readCodexChatGptAuth(env);
    if (!auth) return null;
    return {
      provider: 'codex-chatgpt',
      url: CODEX_USAGE_URL,
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        'ChatGPT-Account-Id': auth.accountId,
        Accept: 'application/json',
      },
    };
  }
  return null;
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readClaudeCredentialsToken(env: Record<string, string>): string | undefined {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim()
    || process.env.CLAUDE_CONFIG_DIR?.trim()
    || join(homedir(), '.claude');
  const raw = readJsonFile(join(configDir, '.credentials.json'));
  if (!raw || typeof raw !== 'object') return undefined;
  const oauth = (raw as { claudeAiOauth?: { accessToken?: unknown } }).claudeAiOauth;
  const token = typeof oauth?.accessToken === 'string' ? oauth.accessToken.trim() : '';
  return token || undefined;
}

function readCodexChatGptAuth(
  env: Record<string, string>,
): { accessToken: string; accountId: string } | null {
  const codexHome = env.CODEX_HOME?.trim()
    || process.env.CODEX_HOME?.trim()
    || join(homedir(), '.codex');
  const raw = readJsonFile(join(codexHome, 'auth.json'));
  if (!raw || typeof raw !== 'object') return null;
  const auth = raw as {
    auth_mode?: unknown;
    tokens?: { access_token?: unknown; account_id?: unknown };
  };
  // An API-key login has no ChatGPT plan window to report.
  if (auth.auth_mode !== undefined && auth.auth_mode !== 'chatgpt') return null;
  const accessToken = typeof auth.tokens?.access_token === 'string' ? auth.tokens.access_token.trim() : '';
  const accountId = typeof auth.tokens?.account_id === 'string' ? auth.tokens.account_id.trim() : '';
  if (!accessToken || !accountId) return null;
  return { accessToken, accountId };
}

// ---------------------------------------------------------------------------
// Refresh + parsing
// ---------------------------------------------------------------------------

async function refreshEntry(larkAppId: string, entry: CacheEntry, source: QuotaSource): Promise<void> {
  const tag = `[provider-quota ${larkAppId.slice(-6)} ${source.provider}]`;
  let res: ProviderQuotaTransportResponse;
  try {
    res = await transport(source.url, source.headers, PROVIDER_QUOTA_REQUEST_TIMEOUT_MS);
  } catch (error) {
    entry.nextAttemptAt = clock() + PROVIDER_QUOTA_FAILURE_BACKOFF_MS;
    logger.warn(`${tag} fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (res.status !== 200) {
    const retryAfterMs = parseRetryAfterMs(res.headers['retry-after']);
    entry.nextAttemptAt = clock() + Math.max(PROVIDER_QUOTA_FAILURE_BACKOFF_MS, retryAfterMs ?? 0);
    logger.warn(
      `${tag} HTTP ${res.status}`
      + (retryAfterMs ? `, retry after ${Math.round(retryAfterMs / 1000)}s` : ''),
    );
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    entry.nextAttemptAt = clock() + PROVIDER_QUOTA_FAILURE_BACKOFF_MS;
    logger.warn(`${tag} non-JSON response`);
    return;
  }
  const quota = parseProviderQuota(source.provider, parsed);
  if (!quota) {
    entry.nextAttemptAt = clock() + PROVIDER_QUOTA_FAILURE_BACKOFF_MS;
    logger.warn(`${tag} response had no usable quota field`);
    return;
  }
  const now = clock();
  entry.quota = quota;
  entry.fetchedAt = now;
  entry.nextAttemptAt = now + PROVIDER_QUOTA_TTL_MS;
}

function parseRetryAfterMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, PROVIDER_QUOTA_MAX_RETRY_AFTER_MS);
  }
  const at = Date.parse(value);
  if (Number.isFinite(at)) {
    return Math.min(Math.max(0, at - clock()), PROVIDER_QUOTA_MAX_RETRY_AFTER_MS);
  }
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** Pure parser, exported for unit tests. Returns null for any shape it does
 *  not positively recognise — never guesses. */
export function parseProviderQuota(
  provider: QuotaSource['provider'],
  body: unknown,
): ProviderQuota | null {
  if (!body || typeof body !== 'object') return null;
  switch (provider) {
    case 'deepseek': return parseDeepSeekBalance(body as Record<string, unknown>);
    case 'claude-oauth': return parseClaudeOauthUsage(body as Record<string, unknown>);
    case 'codex-chatgpt': return parseCodexUsage(body as Record<string, unknown>);
    default: return null;
  }
}

/** `GET /user/balance` → `{ balance_infos: [{ currency, total_balance, … }] }`.
 *  Prefer CNY (the account's billing currency here), else the first entry. */
function parseDeepSeekBalance(body: Record<string, unknown>): ProviderQuota | null {
  const infos = Array.isArray(body.balance_infos) ? body.balance_infos : [];
  const entries = infos
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map(x => ({
      currency: typeof x.currency === 'string' ? x.currency.trim().toUpperCase() : '',
      amount: finiteNumber(x.total_balance),
    }))
    .filter((x): x is { currency: string; amount: number } => x.currency !== '' && x.amount !== undefined);
  if (entries.length === 0) return null;
  const pick = entries.find(x => x.currency === 'CNY') ?? entries[0]!;
  return { kind: 'balance', currency: pick.currency, amount: pick.amount };
}

/** `GET /api/oauth/usage` → `{ five_hour: {utilization, resets_at}, seven_day: {…}, … }`
 *  (`utilization` is the used share in percent). Only the 7-day window is rendered. */
function parseClaudeOauthUsage(body: Record<string, unknown>): ProviderQuota | null {
  const week = body.seven_day;
  if (!week || typeof week !== 'object') return null;
  const w = week as Record<string, unknown>;
  const used = finiteNumber(w.utilization);
  if (used === undefined) return null;
  const resetsAt = typeof w.resets_at === 'string' ? Date.parse(w.resets_at)
    : typeof w.resets_at === 'number' ? w.resets_at * 1000
    : Number.NaN;
  return {
    kind: 'window',
    window: 'weekly',
    remainingPercent: clampPercent(100 - used),
    ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
  };
}

/** `GET /backend-api/wham/usage` → `{ rate_limit: { primary_window, secondary_window } }`,
 *  each window `{ used_percent, limit_window_seconds, reset_at }`. Pick the
 *  window whose length is 7 days; the plan's windows differ by tier, so no
 *  positional assumption is made. */
function parseCodexUsage(body: Record<string, unknown>): ProviderQuota | null {
  const rl = body.rate_limit;
  if (!rl || typeof rl !== 'object') return null;
  const r = rl as Record<string, unknown>;
  const windows = [r.primary_window, r.secondary_window]
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map(x => ({
      used: finiteNumber(x.used_percent),
      lengthSeconds: finiteNumber(x.limit_window_seconds),
      resetAt: finiteNumber(x.reset_at),
    }))
    .filter((x): x is { used: number; lengthSeconds: number | undefined; resetAt: number | undefined } => x.used !== undefined);
  const weekly = windows.find(x => x.lengthSeconds === WEEK_SECONDS);
  if (!weekly) return null;
  return {
    kind: 'window',
    window: 'weekly',
    remainingPercent: clampPercent(100 - weekly.used),
    ...(weekly.resetAt !== undefined ? { resetsAt: weekly.resetAt * 1000 } : {}),
  };
}

// ---------------------------------------------------------------------------
// Transport — node:https + proxy-agent. Node's global fetch ignores the
// HTTPS_PROXY env the daemon runs with, so this mirrors hd2d-assets/ensure-fonts.
// ---------------------------------------------------------------------------

let proxyAgent: ProxyAgent | undefined;

function outboundAgent(): ProxyAgent | undefined {
  const hasProxyEnv = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
    .some(key => process.env[key]?.trim());
  if (!hasProxyEnv) return undefined;
  proxyAgent ??= new ProxyAgent();
  return proxyAgent;
}

function defaultTransport(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<ProviderQuotaTransportResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const options: RequestOptions = {
      method: 'GET',
      headers: { 'User-Agent': 'botmux-provider-quota', ...headers },
      agent: outboundAgent(),
      timeout: timeoutMs,
    };
    const req = httpsRequest(target, options, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => { chunks.push(c); });
      res.on('end', () => {
        const flat: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          flat[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
        }
        resolve({ status: res.statusCode ?? 0, headers: flat, body: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error(`timeout after ${timeoutMs}ms`)); });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

export function __setProviderQuotaTransportForTests(next: ProviderQuotaTransport | null): void {
  transport = next ?? defaultTransport;
}

export function __setProviderQuotaClockForTests(next: (() => number) | null): void {
  clock = next ?? (() => Date.now());
}

export function __resetProviderQuotaForTests(): void {
  cache.clear();
  transport = defaultTransport;
  clock = () => Date.now();
}
