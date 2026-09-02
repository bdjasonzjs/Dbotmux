/**
 * Provider quota / balance for the streaming-card usage line.
 *
 * Three account-level facts, one per credential kind:
 *   - DeepSeek (pay-as-you-go API key)       → account balance (¥ / $)
 *   - Claude Code (claude.ai OAuth login)    → 7-day window remaining %
 *   - Codex (ChatGPT login)                  → 7-day window remaining %
 *
 * Invariants (each one is guarded by a test in test/provider-quota.test.ts):
 *   - The card render path is synchronous and hot. {@link peekProviderQuota}
 *     does memory reads only — no file I/O, no network — and, when the cached
 *     value is stale, kicks off ONE background refresh per bot.
 *   - A cached value belongs to a *source identity* (provider + credential
 *     fingerprint). A different identity — provider switch, key rotation,
 *     account change — atomically replaces the entry: the old quota, backoff
 *     and in-flight request are never reused, and null is served until the new
 *     source answers. A late completion of an old in-flight request is dropped.
 *   - Upstream calls are rare (default 10 min success TTL, 5 min failure
 *     backoff, `Retry-After` honored on 429) and de-duplicated per bot.
 *   - Failure degrades to "not shown": a stale value is reused for a bounded
 *     grace period, then dropped. Out-of-range or malformed upstream numbers
 *     are rejected, never clamped or estimated.
 *   - Credentials live only in request headers built inside this module. Logs
 *     carry status codes, error names and allow-listed error codes — never a
 *     raw error message, URL, header or fingerprint.
 */
import { readFile, stat } from 'node:fs/promises';
import { createHmac, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
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

export type ProviderQuotaProvider = 'deepseek' | 'claude-oauth' | 'codex-chatgpt';

export interface ProviderQuotaTransportResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface ProviderQuotaTransportLimits {
  /** Socket inactivity timeout. */
  timeoutMs: number;
  /** Hard wall-clock deadline for the whole request. */
  deadlineMs: number;
  /** Response body cap; exceeding it aborts the request. */
  maxBodyBytes: number;
}

export type ProviderQuotaTransport = (
  url: string,
  headers: Record<string, string>,
  limits: ProviderQuotaTransportLimits,
) => Promise<ProviderQuotaTransportResponse>;

/** Async reader for file-backed credentials (injectable so tests can prove the
 *  hot path never touches it). */
export type ProviderQuotaFileReader = (path: string) => Promise<string>;

/** A successful value is served without refetching for this long. */
export const PROVIDER_QUOTA_TTL_MS = 10 * 60_000;
/** After a failure, wait this long before retrying (unless Retry-After is larger). */
export const PROVIDER_QUOTA_FAILURE_BACKOFF_MS = 5 * 60_000;
/** Longest Retry-After we honor before clamping (defensive against bogus headers). */
export const PROVIDER_QUOTA_MAX_RETRY_AFTER_MS = 6 * 60 * 60_000;
/** A stale value keeps rendering for this long past its fetch time, then hides. */
export const PROVIDER_QUOTA_STALE_GRACE_MS = 60 * 60_000;
/** File-backed credentials are re-checked (mtime) at most this often while a
 *  value is cached, so a rotated login stops showing the old account's quota
 *  well before the next scheduled refresh. */
export const PROVIDER_QUOTA_CREDENTIAL_PROBE_MS = 30_000;
export const PROVIDER_QUOTA_REQUEST_TIMEOUT_MS = 8_000;
export const PROVIDER_QUOTA_REQUEST_DEADLINE_MS = 15_000;
export const PROVIDER_QUOTA_MAX_BODY_BYTES = 64 * 1024;

const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';
const CLAUDE_OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const WEEK_SECONDS = 7 * 24 * 3600;

/** Per-process random salt: fingerprints are only ever compared within this
 *  process, so they carry no meaning outside it and cannot be replayed. */
const FINGERPRINT_SALT = randomBytes(32);

/** What the synchronous path can know from the in-memory bot config alone.
 *  `configIdentity` distinguishes provider + inline credential + credential
 *  file location without any I/O; the file *contents* are fingerprinted later
 *  by the async loader. */
interface SourceSpec {
  provider: ProviderQuotaProvider;
  url: string;
  configIdentity: string;
  credential:
    | { kind: 'inline'; headers: Record<string, string> }
    | { kind: 'file'; path: string };
}

/** A fully resolved request: headers plus the identity of the credential
 *  that produced them. Never log or serialize this object. */
interface ResolvedSource {
  provider: ProviderQuotaProvider;
  url: string;
  headers: Record<string, string>;
  /** provider + salted fingerprint of the credential material. */
  identity: string;
  /** mtime of the credential file (file-backed only), for rotation probes. */
  fileMtimeMs?: number;
}

interface CacheEntry {
  configIdentity: string;
  /** Identity of the credential the cached quota belongs to (set once the
   *  async loader has resolved it). */
  sourceIdentity: string | null;
  fileMtimeMs: number | null;
  quota: ProviderQuota | null;
  /** When `quota` was fetched successfully (ms). 0 = never. */
  fetchedAt: number;
  /** Earliest time the next upstream call may be attempted (ms). */
  nextAttemptAt: number;
  inflight: Promise<void> | null;
  /** Last time a file-backed credential was probed for rotation (ms). */
  lastProbeAt: number;
  probing: Promise<void> | null;
}

const cache = new Map<string, CacheEntry>();
let transport: ProviderQuotaTransport = defaultTransport;
let readCredentialFile: ProviderQuotaFileReader = path => readFile(path, 'utf8');
let statCredentialFile: (path: string) => Promise<number | null> = async path => {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
};
let clock: () => number = () => Date.now();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Non-blocking read for the card renderer. Memory only: returns the cached
 *  quota (or null when nothing usable is known for the *current* source) and
 *  schedules background work when due. Never throws. */
export function peekProviderQuota(
  larkAppId: string,
  config: ProviderQuotaBotConfig | undefined,
): ProviderQuota | null {
  try {
    const spec = resolveSourceSpec(config);
    if (!spec) {
      cache.delete(larkAppId);
      return null;
    }
    const now = clock();
    const entry = entryFor(larkAppId, spec);
    const fresh = entry.quota !== null && now - entry.fetchedAt < PROVIDER_QUOTA_TTL_MS;
    if (!fresh && !entry.inflight && now >= entry.nextAttemptAt) {
      startRefresh(larkAppId, entry, spec);
    } else if (
      spec.credential.kind === 'file'
      && entry.quota !== null
      && !entry.inflight
      && !entry.probing
      && now - entry.lastProbeAt >= PROVIDER_QUOTA_CREDENTIAL_PROBE_MS
    ) {
      startCredentialProbe(larkAppId, entry, spec);
    }
    if (entry.quota !== null && now - entry.fetchedAt <= PROVIDER_QUOTA_STALE_GRACE_MS) {
      return entry.quota;
    }
    return null;
  } catch {
    return null;
  }
}

/** Await-able refresh (tests and exact-value callers at turn boundaries).
 *  Resolves to the current cached quota for the current source; never throws. */
export async function refreshProviderQuota(
  larkAppId: string,
  config: ProviderQuotaBotConfig | undefined,
): Promise<ProviderQuota | null> {
  const spec = resolveSourceSpec(config);
  if (!spec) {
    cache.delete(larkAppId);
    return null;
  }
  const entry = entryFor(larkAppId, spec);
  if (!entry.inflight && clock() >= entry.nextAttemptAt) startRefresh(larkAppId, entry, spec);
  if (entry.inflight) await entry.inflight;
  const current = cache.get(larkAppId);
  return current && current.configIdentity === spec.configIdentity ? current.quota : null;
}

/** Which upstream (if any) a bot's config maps to. Memory-only; carries no
 *  secret. A file-backed provider is reported even if the file turns out to
 *  be unusable (that is decided by the async loader). */
export function describeProviderQuotaSource(
  config: ProviderQuotaBotConfig | undefined,
): ProviderQuotaProvider | null {
  return resolveSourceSpec(config)?.provider ?? null;
}

// ---------------------------------------------------------------------------
// Cache entry lifecycle
// ---------------------------------------------------------------------------

function newEntry(configIdentity: string): CacheEntry {
  return {
    configIdentity,
    sourceIdentity: null,
    fileMtimeMs: null,
    quota: null,
    fetchedAt: 0,
    nextAttemptAt: 0,
    inflight: null,
    lastProbeAt: 0,
    probing: null,
  };
}

/** Return the live entry for this bot, atomically replacing it when the
 *  in-memory config identity changed (provider switch, inline key rotation,
 *  credential file relocation). The old entry object is simply orphaned: any
 *  refresh still running against it writes into an object no longer in the map. */
function entryFor(larkAppId: string, spec: SourceSpec): CacheEntry {
  const existing = cache.get(larkAppId);
  if (existing && existing.configIdentity === spec.configIdentity) return existing;
  const entry = newEntry(spec.configIdentity);
  cache.set(larkAppId, entry);
  return entry;
}

/** Replace `entry` with a fresh one for the same config (used when the async
 *  loader discovers the credential *contents* changed). Returns the new entry. */
function supersede(larkAppId: string, entry: CacheEntry): CacheEntry {
  if (cache.get(larkAppId) !== entry) return cache.get(larkAppId) ?? entry;
  const next = newEntry(entry.configIdentity);
  cache.set(larkAppId, next);
  return next;
}

function isLive(larkAppId: string, entry: CacheEntry): boolean {
  return cache.get(larkAppId) === entry;
}

function startRefresh(larkAppId: string, entry: CacheEntry, spec: SourceSpec): void {
  const done: Promise<void> = refreshEntry(larkAppId, entry, spec)
    .catch(() => undefined)
    .finally(() => {
      // The refresh may have superseded `entry` mid-flight (credential
      // rotation) and carried its in-flight marker to the successor.
      if (entry.inflight === done) entry.inflight = null;
      const current = cache.get(larkAppId);
      if (current && current !== entry && current.inflight === done) current.inflight = null;
    });
  entry.inflight = done;
}

function startCredentialProbe(larkAppId: string, entry: CacheEntry, spec: SourceSpec): void {
  entry.lastProbeAt = clock();
  entry.probing = probeCredentialFile(larkAppId, entry, spec)
    .catch(() => undefined)
    .finally(() => { entry.probing = null; });
}

/** Cheap rotation signal for file-backed credentials: if the file's mtime
 *  moved since the cached value was fetched, drop the cached quota now and
 *  refresh; the fingerprint check in the loader decides whether the account
 *  actually changed. */
async function probeCredentialFile(larkAppId: string, entry: CacheEntry, spec: SourceSpec): Promise<void> {
  if (spec.credential.kind !== 'file') return;
  const mtime = await statCredentialFile(spec.credential.path);
  if (!isLive(larkAppId, entry)) return;
  if (entry.fileMtimeMs !== null && mtime !== entry.fileMtimeMs) {
    const next = supersede(larkAppId, entry);
    startRefresh(larkAppId, next, spec);
  }
}

// ---------------------------------------------------------------------------
// Source resolution — sync part is memory-only; the async part reads files.
// ---------------------------------------------------------------------------

function fingerprint(...parts: string[]): string {
  const h = createHmac('sha256', FINGERPRINT_SALT);
  for (const p of parts) h.update(p).update('\0');
  return h.digest('base64url').slice(0, 22);
}

function isDeepSeekModel(model: string | undefined): boolean {
  return /^deepseek(?:[/-]|$)/i.test((model ?? '').trim());
}

function resolveSourceSpec(config: ProviderQuotaBotConfig | undefined): SourceSpec | null {
  if (!config) return null;
  const env = config.env ?? {};
  // DeepSeek is chosen by the bot's *model* identity; the key alone does not
  // decide (a Codex/Claude bot may carry a DeepSeek key for tool calls).
  const deepseekKey = env.DEEPSEEK_API_KEY?.trim();
  if (deepseekKey && isDeepSeekModel(config.model)) {
    return {
      provider: 'deepseek',
      url: DEEPSEEK_BALANCE_URL,
      configIdentity: `deepseek:${fingerprint(deepseekKey)}`,
      credential: { kind: 'inline', headers: { Authorization: `Bearer ${deepseekKey}` } },
    };
  }
  if (config.cliId === 'claude-code') {
    // A third-party Anthropic-compatible relay (GLM etc.) has no claude.ai
    // subscription window; the OAuth usage endpoint would be meaningless.
    if (env.ANTHROPIC_BASE_URL?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim()) return null;
    const token = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
    if (token) {
      return {
        provider: 'claude-oauth',
        url: CLAUDE_OAUTH_USAGE_URL,
        configIdentity: `claude-oauth:${fingerprint(token)}`,
        credential: { kind: 'inline', headers: claudeHeaders(token) },
      };
    }
    const configDir = env.CLAUDE_CONFIG_DIR?.trim()
      || process.env.CLAUDE_CONFIG_DIR?.trim()
      || join(homedir(), '.claude');
    const path = join(configDir, '.credentials.json');
    return {
      provider: 'claude-oauth',
      url: CLAUDE_OAUTH_USAGE_URL,
      configIdentity: `claude-oauth:file:${path}`,
      credential: { kind: 'file', path },
    };
  }
  if (config.cliId === 'codex' || config.cliId === 'codex-app') {
    const codexHome = env.CODEX_HOME?.trim()
      || process.env.CODEX_HOME?.trim()
      || join(homedir(), '.codex');
    const path = join(codexHome, 'auth.json');
    return {
      provider: 'codex-chatgpt',
      url: CODEX_USAGE_URL,
      configIdentity: `codex-chatgpt:file:${path}`,
      credential: { kind: 'file', path },
    };
  }
  return null;
}

function claudeHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'anthropic-beta': 'oauth-2025-04-20',
    Accept: 'application/json',
  };
}

/** Async: turn a spec into headers + credential identity. Returns null when
 *  the credential is missing or unusable (API-key Codex login, empty token). */
async function loadSource(spec: SourceSpec): Promise<ResolvedSource | null> {
  if (spec.credential.kind === 'inline') {
    return {
      provider: spec.provider,
      url: spec.url,
      headers: spec.credential.headers,
      identity: spec.configIdentity,
    };
  }
  const path = spec.credential.path;
  let raw: unknown;
  try {
    raw = JSON.parse(await readCredentialFile(path));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const mtime = await statCredentialFile(path);
  if (spec.provider === 'claude-oauth') {
    const oauth = (raw as { claudeAiOauth?: { accessToken?: unknown } }).claudeAiOauth;
    const token = typeof oauth?.accessToken === 'string' ? oauth.accessToken.trim() : '';
    if (!token) return null;
    return {
      provider: spec.provider,
      url: spec.url,
      headers: claudeHeaders(token),
      identity: `claude-oauth:${fingerprint(token)}`,
      ...(mtime !== null ? { fileMtimeMs: mtime } : {}),
    };
  }
  const auth = raw as {
    auth_mode?: unknown;
    tokens?: { access_token?: unknown; account_id?: unknown };
  };
  // An API-key login has no ChatGPT plan window to report.
  if (auth.auth_mode !== undefined && auth.auth_mode !== 'chatgpt') return null;
  const accessToken = typeof auth.tokens?.access_token === 'string' ? auth.tokens.access_token.trim() : '';
  const accountId = typeof auth.tokens?.account_id === 'string' ? auth.tokens.account_id.trim() : '';
  if (!accessToken || !accountId) return null;
  return {
    provider: spec.provider,
    url: spec.url,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'ChatGPT-Account-Id': accountId,
      Accept: 'application/json',
    },
    identity: `codex-chatgpt:${fingerprint(accountId, accessToken)}`,
    ...(mtime !== null ? { fileMtimeMs: mtime } : {}),
  };
}

// ---------------------------------------------------------------------------
// Refresh + parsing
// ---------------------------------------------------------------------------

async function refreshEntry(larkAppId: string, entry: CacheEntry, spec: SourceSpec): Promise<void> {
  const tag = `[provider-quota ${larkAppId.slice(-6)} ${spec.provider}]`;
  const source = await loadSource(spec);
  if (!isLive(larkAppId, entry)) return;
  if (!source) {
    // Unusable credential: nothing to show, back off; if the file changed
    // underneath a cached value, that value belongs to a gone credential.
    if (entry.sourceIdentity !== null) supersede(larkAppId, entry).nextAttemptAt = clock() + PROVIDER_QUOTA_FAILURE_BACKOFF_MS;
    else entry.nextAttemptAt = clock() + PROVIDER_QUOTA_FAILURE_BACKOFF_MS;
    return;
  }
  // Credential contents changed (rotation / account switch): the cached
  // quota, backoff and this entry's history belong to the old identity. Swap
  // to a fresh entry and continue the fetch against it.
  let live = entry;
  if (entry.sourceIdentity !== null && entry.sourceIdentity !== source.identity) {
    live = supersede(larkAppId, entry);
    live.inflight = entry.inflight;
  }
  live.sourceIdentity = source.identity;
  live.fileMtimeMs = source.fileMtimeMs ?? null;

  let res: ProviderQuotaTransportResponse;
  try {
    res = await transport(source.url, source.headers, {
      timeoutMs: PROVIDER_QUOTA_REQUEST_TIMEOUT_MS,
      deadlineMs: PROVIDER_QUOTA_REQUEST_DEADLINE_MS,
      maxBodyBytes: PROVIDER_QUOTA_MAX_BODY_BYTES,
    });
  } catch (error) {
    if (!isLive(larkAppId, live)) return;
    live.nextAttemptAt = clock() + PROVIDER_QUOTA_FAILURE_BACKOFF_MS;
    logger.warn(`${tag} fetch failed: ${safeErrorLabel(error)}`);
    return;
  }
  if (!isLive(larkAppId, live)) return;
  if (res.status !== 200) {
    const retryAfterMs = parseRetryAfterMs(res.headers['retry-after']);
    live.nextAttemptAt = clock() + Math.max(PROVIDER_QUOTA_FAILURE_BACKOFF_MS, retryAfterMs ?? 0);
    logger.warn(
      `${tag} HTTP ${Number.isInteger(res.status) ? res.status : 0}`
      + (retryAfterMs ? `, retry after ${Math.round(retryAfterMs / 1000)}s` : ''),
    );
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    live.nextAttemptAt = clock() + PROVIDER_QUOTA_FAILURE_BACKOFF_MS;
    logger.warn(`${tag} non-JSON response`);
    return;
  }
  const quota = parseProviderQuota(spec.provider, parsed);
  if (!quota) {
    live.nextAttemptAt = clock() + PROVIDER_QUOTA_FAILURE_BACKOFF_MS;
    logger.warn(`${tag} response had no usable quota field`);
    return;
  }
  const now = clock();
  live.quota = quota;
  live.fetchedAt = now;
  live.nextAttemptAt = now + PROVIDER_QUOTA_TTL_MS;
  // The loader just stat'ed the credential file; start the rotation-probe
  // cadence from here rather than probing again on the very next peek.
  live.lastProbeAt = now;
}

/** Log-safe error label: the error's class name plus an allow-listed `code`
 *  (e.g. `ECONNRESET`, `ERR_BODY_TOO_LARGE`). Never the message — a transport
 *  or proxy layer may embed URLs, userinfo or headers in it. */
export function safeErrorLabel(error: unknown): string {
  if (!(error instanceof Error)) return 'UnknownError';
  const name = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : 'Error';
  const code = (error as { code?: unknown }).code;
  const safeCode = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(code) ? code : undefined;
  return safeCode ? `${name}/${safeCode}` : name;
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

/** A percentage is only trusted inside [0, 100]; anything else is treated as
 *  malformed upstream data and rejected (never clamped). */
function percentInRange(value: unknown): number | undefined {
  const n = finiteNumber(value);
  return n !== undefined && n >= 0 && n <= 100 ? n : undefined;
}

/** Pure parser, exported for unit tests. Returns null for any shape it does
 *  not positively recognise — never guesses. */
export function parseProviderQuota(
  provider: ProviderQuotaProvider,
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
  const used = percentInRange(w.utilization);
  if (used === undefined) return null;
  const resetsAt = typeof w.resets_at === 'string' ? Date.parse(w.resets_at)
    : typeof w.resets_at === 'number' ? w.resets_at * 1000
    : Number.NaN;
  return {
    kind: 'window',
    window: 'weekly',
    remainingPercent: 100 - used,
    ...(Number.isFinite(resetsAt) && resetsAt >= 0 ? { resetsAt } : {}),
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
      used: percentInRange(x.used_percent),
      lengthSeconds: finiteNumber(x.limit_window_seconds),
      resetAt: finiteNumber(x.reset_at),
    }));
  const weekly = windows.find(x => x.lengthSeconds === WEEK_SECONDS);
  if (!weekly || weekly.used === undefined) return null;
  return {
    kind: 'window',
    window: 'weekly',
    remainingPercent: 100 - weekly.used,
    ...(weekly.resetAt !== undefined && weekly.resetAt >= 0 ? { resetsAt: weekly.resetAt * 1000 } : {}),
  };
}

// ---------------------------------------------------------------------------
// Transport — node:https + proxy-agent. Node's global fetch ignores the
// HTTPS_PROXY env the daemon runs with, so this mirrors hd2d-assets/ensure-fonts.
// Bounded: socket inactivity timeout, hard deadline, response body cap.
// ---------------------------------------------------------------------------

let proxyAgent: ProxyAgent | undefined;

function outboundAgent(): ProxyAgent | undefined {
  const hasProxyEnv = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
    .some(key => process.env[key]?.trim());
  if (!hasProxyEnv) return undefined;
  proxyAgent ??= new ProxyAgent();
  return proxyAgent;
}

class TransportError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ProviderQuotaTransportError';
  }
}

function defaultTransport(
  url: string,
  headers: Record<string, string>,
  limits: ProviderQuotaTransportLimits,
): Promise<ProviderQuotaTransportResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const isHttps = target.protocol === 'https:';
    const doRequest = isHttps ? httpsRequest : httpRequest;
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    const req = doRequest(target, {
      method: 'GET',
      headers: { 'User-Agent': 'botmux-provider-quota', ...headers },
      agent: isHttps ? outboundAgent() : undefined,
      timeout: limits.timeoutMs,
    }, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      let received = 0;
      res.on('data', (c: Buffer) => {
        received += c.length;
        if (received > limits.maxBodyBytes) {
          req.destroy(new TransportError('ERR_BODY_TOO_LARGE'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        const flat: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          flat[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
        }
        finish(() => resolve({ status: res.statusCode ?? 0, headers: flat, body: Buffer.concat(chunks).toString('utf8') }));
      });
      res.on('error', error => finish(() => reject(error)));
    });
    const deadline = setTimeout(() => { req.destroy(new TransportError('ERR_DEADLINE')); }, limits.deadlineMs);
    deadline.unref?.();
    req.on('timeout', () => { req.destroy(new TransportError('ERR_SOCKET_TIMEOUT')); });
    req.on('error', error => finish(() => reject(error)));
    req.on('close', () => { clearTimeout(deadline); });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

export function __setProviderQuotaTransportForTests(next: ProviderQuotaTransport | null): void {
  transport = next ?? defaultTransport;
}

export function __setProviderQuotaFileReaderForTests(
  reader: ProviderQuotaFileReader | null,
  statter?: ((path: string) => Promise<number | null>) | null,
): void {
  readCredentialFile = reader ?? (path => readFile(path, 'utf8'));
  if (statter !== undefined) {
    statCredentialFile = statter ?? (async path => {
      try { return (await stat(path)).mtimeMs; } catch { return null; }
    });
  }
}

export function __setProviderQuotaClockForTests(next: (() => number) | null): void {
  clock = next ?? (() => Date.now());
}

/** Exposed for the transport tests (local http server). */
export const __defaultProviderQuotaTransportForTests: ProviderQuotaTransport = defaultTransport;

export function __resetProviderQuotaForTests(): void {
  cache.clear();
  transport = defaultTransport;
  readCredentialFile = path => readFile(path, 'utf8');
  statCredentialFile = async path => {
    try { return (await stat(path)).mtimeMs; } catch { return null; }
  };
  clock = () => Date.now();
}
