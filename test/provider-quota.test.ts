/**
 * Unit tests for src/services/provider-quota.ts.
 *
 * Run:  pnpm vitest run test/provider-quota.test.ts
 *
 * Transport, credential-file reader and clock are injected so no test touches
 * the network or real credential files. The bounded default transport is
 * exercised against a local HTTP server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  PROVIDER_QUOTA_CREDENTIAL_PROBE_MS,
  PROVIDER_QUOTA_FAILURE_BACKOFF_MS,
  PROVIDER_QUOTA_MAX_RETRY_AFTER_MS,
  PROVIDER_QUOTA_STALE_GRACE_MS,
  PROVIDER_QUOTA_TTL_MS,
  __defaultProviderQuotaTransportForTests,
  __resetProviderQuotaForTests,
  __setProviderQuotaClockForTests,
  __setProviderQuotaFileReaderForTests,
  __setProviderQuotaTransportForTests,
  describeProviderQuotaSource,
  parseClaudeRateLimitHeaders,
  parseProviderQuota,
  peekProviderQuota,
  refreshProviderQuota,
  safeErrorLabel,
  type ProviderQuotaTransportResponse,
} from '../src/services/provider-quota.js';
import { logger } from '../src/utils/logger.js';

const DEEPSEEK_BODY = JSON.stringify({
  is_available: true,
  balance_infos: [
    { currency: 'CNY', total_balance: '472.34', granted_balance: '0.00', topped_up_balance: '472.34' },
    { currency: 'USD', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' },
  ],
});

const CODEX_BODY = JSON.stringify({
  plan_type: 'pro',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 8, limit_window_seconds: 604800, reset_after_seconds: 496016, reset_at: 1788803049 },
    secondary_window: null,
  },
});

/** Real header shape observed 2026-09-02 on a max_tokens=1 Messages call. */
const CLAUDE_HEADERS: Record<string, string> = {
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.4',
  'anthropic-ratelimit-unified-5h-reset': '1788322800',
  'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-7d-utilization': '0.632',
  'anthropic-ratelimit-unified-7d-reset': '1788537600',
  'request-id': 'req_test',
};
const CLAUDE_BODY = '{"id":"msg_test","type":"message","content":[{"type":"text","text":"Hello"}],"stop_reason":"max_tokens"}';
const CLAUDE_QUOTA = { kind: 'window', window: 'weekly', remainingPercent: 36.8, resetsAt: 1788537600_000 };

const DEEPSEEK_QUOTA = { kind: 'balance', currency: 'CNY', amount: 472.34 };
const CODEX_QUOTA = { kind: 'window', window: 'weekly', remainingPercent: 92, resetsAt: 1788803049_000 };

const DS_CFG = { cliId: 'pi', env: { DEEPSEEK_API_KEY: 'sk-test' }, model: 'deepseek/deepseek-v4-flash' };
const CLAUDE_CFG = { cliId: 'claude-code', env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' } };
const CODEX_CFG = { cliId: 'codex', env: { CODEX_HOME: '/virtual/codex' } };
const CODEX_AUTH = (accessToken: string, accountId = 'acc-1') => JSON.stringify({
  auth_mode: 'chatgpt', tokens: { access_token: accessToken, account_id: accountId },
});

function ok(body: string, headers: Record<string, string> = {}): ProviderQuotaTransportResponse {
  return { status: 200, headers, body };
}

interface Call { url: string; method: string; headers: Record<string, string>; body?: string }

function installTransport(
  respond: (call: Call) => ProviderQuotaTransportResponse | Promise<ProviderQuotaTransportResponse>,
): Call[] {
  const calls: Call[] = [];
  __setProviderQuotaTransportForTests(async request => {
    const call: Call = { url: request.url, method: request.method, headers: request.headers, ...(request.body !== undefined ? { body: request.body } : {}) };
    calls.push(call);
    return respond(call);
  });
  return calls;
}

/** Virtual credential files: `files` is mutable so tests can rotate them.
 *  `mtime` is carried only to document that the implementation must ignore it. */
function installFiles(files: Record<string, { body: string; mtime: number }>): { reads: string[] } {
  const reads: string[] = [];
  __setProviderQuotaFileReaderForTests(async path => {
    reads.push(path);
    const f = files[path];
    if (!f) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return f.body;
  });
  return { reads };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r));
}

let now = 1_000_000_000;
beforeEach(() => {
  __resetProviderQuotaForTests();
  now = 1_000_000_000;
  __setProviderQuotaClockForTests(() => now);
});
afterEach(() => {
  __resetProviderQuotaForTests();
  vi.restoreAllMocks();
});

describe('provider-quota parsers', () => {
  it('DeepSeek: picks the CNY balance and parses the decimal string', () => {
    expect(parseProviderQuota('deepseek', JSON.parse(DEEPSEEK_BODY))).toEqual(DEEPSEEK_QUOTA);
  });

  it('DeepSeek: falls back to the first entry when no CNY balance exists', () => {
    expect(parseProviderQuota('deepseek', { balance_infos: [{ currency: 'usd', total_balance: 12 }] }))
      .toEqual({ kind: 'balance', currency: 'USD', amount: 12 });
  });

  it('DeepSeek: null on an empty or malformed body (never invents a number)', () => {
    expect(parseProviderQuota('deepseek', {})).toBeNull();
    expect(parseProviderQuota('deepseek', { balance_infos: [{ currency: 'CNY', total_balance: 'n/a' }] })).toBeNull();
    expect(parseProviderQuota('deepseek', { balance_infos: [{ currency: 'CNY', total_balance: 'Infinity' }] })).toBeNull();
    expect(parseProviderQuota('deepseek', 'oops')).toBeNull();
  });

  it('Codex: picks the 7-day window regardless of position and converts used → remaining', () => {
    expect(parseProviderQuota('codex-chatgpt', JSON.parse(CODEX_BODY))).toEqual(CODEX_QUOTA);
    const swapped = {
      rate_limit: {
        primary_window: { used_percent: 40, limit_window_seconds: 18000, reset_at: 1 },
        secondary_window: { used_percent: 25, limit_window_seconds: 604800, reset_at: 2 },
      },
    };
    expect(parseProviderQuota('codex-chatgpt', swapped))
      .toEqual({ kind: 'window', window: 'weekly', remainingPercent: 75, resetsAt: 2000 });
  });

  it('Codex: null when no 7-day window is reported', () => {
    expect(parseProviderQuota('codex-chatgpt', {
      rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 18000 }, secondary_window: null },
    })).toBeNull();
    expect(parseProviderQuota('codex-chatgpt', { rate_limit: null })).toBeNull();
  });

  it('Claude: the 7-day window comes from the unified rate-limit response headers (fraction → remaining %)', () => {
    expect(parseClaudeRateLimitHeaders(CLAUDE_HEADERS)).toEqual(CLAUDE_QUOTA);
    expect(parseClaudeRateLimitHeaders({ 'anthropic-ratelimit-unified-7d-utilization': '0' }))
      .toEqual({ kind: 'window', window: 'weekly', remainingPercent: 100 });
    expect(parseClaudeRateLimitHeaders({ 'anthropic-ratelimit-unified-7d-utilization': '1', 'anthropic-ratelimit-unified-7d-reset': '5' }))
      .toEqual({ kind: 'window', window: 'weekly', remainingPercent: 0, resetsAt: 5000 });
    expect(parseClaudeRateLimitHeaders({ 'anthropic-ratelimit-unified-7d-utilization': '0.1' }))
      .toEqual({ kind: 'window', window: 'weekly', remainingPercent: 90 });
    // Only the 5h header, or no headers at all → nothing to show.
    expect(parseClaudeRateLimitHeaders({ 'anthropic-ratelimit-unified-5h-utilization': '0.4' })).toBeNull();
    expect(parseClaudeRateLimitHeaders({})).toBeNull();
    // A body is never a Claude quota source.
    expect(parseProviderQuota('claude-oauth', { seven_day: { utilization: 10 } })).toBeNull();
  });

  it('out-of-range or non-finite used percentages are rejected, never clamped', () => {
    for (const bad of [-20, 130, 100.01, -0.01, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 'NaN', 'Infinity', '-5', '', null, true]) {
      expect(parseProviderQuota('codex-chatgpt', {
        rate_limit: { primary_window: { used_percent: bad, limit_window_seconds: 604800, reset_at: 1 } },
      }), `codex ${String(bad)}`).toBeNull();
    }
    // Claude's header is a fraction: anything outside [0, 1] is malformed.
    for (const bad of ['-0.01', '1.01', '40', 'NaN', 'Infinity', '', 'allowed']) {
      expect(parseClaudeRateLimitHeaders({ 'anthropic-ratelimit-unified-7d-utilization': bad }), `claude ${bad}`).toBeNull();
    }
    // A malformed reset timestamp drops only the timestamp, never the percentage.
    expect(parseClaudeRateLimitHeaders({ 'anthropic-ratelimit-unified-7d-utilization': '0.1', 'anthropic-ratelimit-unified-7d-reset': 'soon' }))
      .toEqual({ kind: 'window', window: 'weekly', remainingPercent: 90 });
  });
});

describe('provider-quota source resolution (memory-only)', () => {
  it('DeepSeek needs both the key and a deepseek model — the key alone does not decide', () => {
    expect(describeProviderQuotaSource(DS_CFG)).toBe('deepseek');
    expect(describeProviderQuotaSource({ cliId: 'pi', env: { DEEPSEEK_API_KEY: 'sk-x' }, model: 'DeepSeek-chat' })).toBe('deepseek');
    expect(describeProviderQuotaSource({ cliId: 'pi', env: {}, model: 'deepseek/deepseek-v4-flash' })).toBeNull();
    expect(describeProviderQuotaSource({ cliId: 'pi', env: { DEEPSEEK_API_KEY: 'sk-x' }, model: 'openai/gpt-5' })).toBeNull();
    // A Codex / Claude bot carrying a DeepSeek key for tool calls keeps its own provider.
    expect(describeProviderQuotaSource({ cliId: 'codex', env: { DEEPSEEK_API_KEY: 'sk-x' } })).toBe('codex-chatgpt');
    expect(describeProviderQuotaSource({ cliId: 'claude-code', env: { DEEPSEEK_API_KEY: 'sk-x', CLAUDE_CODE_OAUTH_TOKEN: 't' } })).toBe('claude-oauth');
  });

  it('claude-code with CLAUDE_CODE_OAUTH_TOKEN → claude-oauth; third-party relay → none', () => {
    expect(describeProviderQuotaSource(CLAUDE_CFG)).toBe('claude-oauth');
    expect(describeProviderQuotaSource({
      cliId: 'claude-code',
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok', ANTHROPIC_BASE_URL: 'https://relay.example' },
    })).toBeNull();
  });

  it('file-backed providers are described without any file read', () => {
    const files = installFiles({});
    expect(describeProviderQuotaSource({ cliId: 'claude-code', env: { CLAUDE_CONFIG_DIR: '/virtual/claude' } })).toBe('claude-oauth');
    expect(describeProviderQuotaSource(CODEX_CFG)).toBe('codex-chatgpt');
    expect(describeProviderQuotaSource({ cliId: 'codex-app', env: { CODEX_HOME: '/virtual/codex' } })).toBe('codex-chatgpt');
    expect(files.reads).toEqual([]);
  });

  it('other CLIs have no quota source', () => {
    expect(describeProviderQuotaSource({ cliId: 'gemini', env: {} })).toBeNull();
    expect(describeProviderQuotaSource(undefined)).toBeNull();
  });

  it('async loader rejects unusable credential files (missing, API-key login, empty token)', async () => {
    const files = installFiles({
      '/virtual/codex/auth.json': { body: JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk' }), mtime: 1 },
      '/virtual/claude/.credentials.json': { body: JSON.stringify({ claudeAiOauth: { accessToken: '' } }), mtime: 1 },
    });
    const calls = installTransport(() => ok(CODEX_BODY));
    expect(await refreshProviderQuota('a', CODEX_CFG)).toBeNull();
    expect(await refreshProviderQuota('b', { cliId: 'claude-code', env: { CLAUDE_CONFIG_DIR: '/virtual/claude' } })).toBeNull();
    expect(await refreshProviderQuota('c', { cliId: 'codex', env: { CODEX_HOME: '/virtual/missing' } })).toBeNull();
    expect(calls).toHaveLength(0);
    expect(files.reads.length).toBe(3);
  });
});

describe('provider-quota cache / refresh policy', () => {
  it('peek never blocks: first call returns null and triggers one background fetch', async () => {
    const calls = installTransport(() => ok(DEEPSEEK_BODY));
    expect(peekProviderQuota('app-a', DS_CFG)).toBeNull();
    expect(peekProviderQuota('app-a', DS_CFG)).toBeNull(); // in-flight → no second call
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.deepseek.com/user/balance');
    expect(calls[0]!.headers.Authorization).toBe('Bearer sk-test');
    expect(peekProviderQuota('app-a', DS_CFG)).toEqual(DEEPSEEK_QUOTA);
  });

  it('serves the cached value for the TTL, then refreshes once', async () => {
    const calls = installTransport(() => ok(DEEPSEEK_BODY));
    await refreshProviderQuota('app-a', DS_CFG);
    expect(calls).toHaveLength(1);
    now += PROVIDER_QUOTA_TTL_MS - 1;
    peekProviderQuota('app-a', DS_CFG);
    await flush();
    expect(calls).toHaveLength(1);
    now += 2;
    peekProviderQuota('app-a', DS_CFG);
    peekProviderQuota('app-a', DS_CFG);
    await flush();
    expect(calls).toHaveLength(2);
  });

  it('keeps the last good value through failures for the grace period, then hides it', async () => {
    let fail = false;
    const calls = installTransport(() => (fail ? { status: 500, headers: {}, body: 'boom' } : ok(DEEPSEEK_BODY)));
    await refreshProviderQuota('app-a', DS_CFG);
    fail = true;
    now += PROVIDER_QUOTA_TTL_MS + 1;
    expect(peekProviderQuota('app-a', DS_CFG)).toEqual(DEEPSEEK_QUOTA);
    await flush();
    expect(calls).toHaveLength(2);
    now += PROVIDER_QUOTA_FAILURE_BACKOFF_MS - 1;
    expect(peekProviderQuota('app-a', DS_CFG)).not.toBeNull();
    await flush();
    expect(calls).toHaveLength(2);
    now = 1_000_000_000 + PROVIDER_QUOTA_STALE_GRACE_MS + 1;
    expect(peekProviderQuota('app-a', DS_CFG)).toBeNull();
  });

  it('honors Retry-After on 429 (clamped) instead of the default backoff', async () => {
    const calls = installTransport(() => ({
      status: 429,
      headers: { 'retry-after': '3565' },
      body: '{"error":{"type":"rate_limit_error"}}',
    }));
    expect(await refreshProviderQuota('app-c', CLAUDE_CFG)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
    now += 3565_000 - 1;
    peekProviderQuota('app-c', CLAUDE_CFG);
    await flush();
    expect(calls).toHaveLength(1);
    now += 2;
    peekProviderQuota('app-c', CLAUDE_CFG);
    await flush();
    expect(calls).toHaveLength(2);
  });

  it('clamps an absurd Retry-After to the maximum', async () => {
    installTransport(() => ({ status: 429, headers: { 'retry-after': String(30 * 24 * 3600) }, body: '' }));
    await refreshProviderQuota('app-c', CLAUDE_CFG);
    const calls = installTransport(() => ok(CLAUDE_BODY, CLAUDE_HEADERS));
    now += PROVIDER_QUOTA_MAX_RETRY_AFTER_MS + 1;
    peekProviderQuota('app-c', CLAUDE_CFG);
    await flush();
    expect(calls).toHaveLength(1);
    expect(peekProviderQuota('app-c', CLAUDE_CFG)).toMatchObject({ kind: 'window', remainingPercent: 36.8 });
  });

  it('Claude: a 429 that still carries the unified headers is a value (0% left), not a failure', async () => {
    const calls = installTransport(() => ({
      status: 429,
      headers: { ...CLAUDE_HEADERS, 'anthropic-ratelimit-unified-7d-utilization': '1', 'retry-after': '600' },
      body: '{"error":{"type":"rate_limit_error"}}',
    }));
    expect(await refreshProviderQuota('app-c', CLAUDE_CFG)).toMatchObject({ kind: 'window', remainingPercent: 0 });
    now += PROVIDER_QUOTA_TTL_MS - 1;
    peekProviderQuota('app-c', CLAUDE_CFG);
    await flush();
    expect(calls).toHaveLength(1); // normal TTL, not Retry-After driven
  });

  it('Claude: a 200 without the unified headers is "no usable quota" → hidden + backoff', async () => {
    const calls = installTransport(() => ok(CLAUDE_BODY, { 'request-id': 'req_x' }));
    expect(await refreshProviderQuota('app-c', CLAUDE_CFG)).toBeNull();
    now += PROVIDER_QUOTA_FAILURE_BACKOFF_MS - 1;
    peekProviderQuota('app-c', CLAUDE_CFG);
    await flush();
    expect(calls).toHaveLength(1);
  });

  it('transport exceptions and non-JSON bodies degrade to null with backoff', async () => {
    let mode: 'throw' | 'garbage' = 'throw';
    const calls = installTransport(() => {
      if (mode === 'throw') throw new Error('ECONNRESET');
      return ok('<html>');
    });
    expect(await refreshProviderQuota('app-a', DS_CFG)).toBeNull();
    mode = 'garbage';
    now += PROVIDER_QUOTA_FAILURE_BACKOFF_MS + 1;
    expect(await refreshProviderQuota('app-a', DS_CFG)).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('an out-of-range upstream percentage is a failure (hidden + backoff), not a clamped value', async () => {
    let used = '1.4';
    const calls = installTransport(() => ok(CLAUDE_BODY, { ...CLAUDE_HEADERS, 'anthropic-ratelimit-unified-7d-utilization': used }));
    expect(await refreshProviderQuota('app-c', CLAUDE_CFG)).toBeNull();
    used = '-0.03';
    now += PROVIDER_QUOTA_FAILURE_BACKOFF_MS - 1;
    peekProviderQuota('app-c', CLAUDE_CFG);
    await flush();
    expect(calls).toHaveLength(1); // still backing off
    now += 2;
    expect(await refreshProviderQuota('app-c', CLAUDE_CFG)).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('caches per bot and sends the codex account headers', async () => {
    installFiles({ '/virtual/codex/auth.json': { body: CODEX_AUTH('at-1'), mtime: 1 } });
    const calls = installTransport(call => (call.url.includes('deepseek') ? ok(DEEPSEEK_BODY) : ok(CODEX_BODY)));
    await Promise.all([refreshProviderQuota('app-a', DS_CFG), refreshProviderQuota('app-b', CODEX_CFG)]);
    expect(calls).toHaveLength(2);
    const codexCall = calls.find(c => c.url.includes('chatgpt.com'))!;
    expect(codexCall.headers.Authorization).toBe('Bearer at-1');
    expect(codexCall.headers['ChatGPT-Account-Id']).toBe('acc-1');
    expect(peekProviderQuota('app-a', DS_CFG)).toMatchObject({ kind: 'balance' });
    expect(peekProviderQuota('app-b', CODEX_CFG)).toMatchObject({ kind: 'window', remainingPercent: 92 });
  });
});

describe('provider-quota source identity (no cross-account leakage)', () => {
  it('provider A → B on the same bot: old quota is dropped, null until B answers, B is fetched', async () => {
    const calls = installTransport(call => (call.url.includes('deepseek') ? ok(DEEPSEEK_BODY) : ok(CLAUDE_BODY, CLAUDE_HEADERS)));
    await refreshProviderQuota('same-app', DS_CFG);
    expect(peekProviderQuota('same-app', DS_CFG)).toEqual(DEEPSEEK_QUOTA);
    // Config switches to Claude (well inside the DeepSeek TTL / grace).
    expect(peekProviderQuota('same-app', CLAUDE_CFG)).toBeNull();
    await flush();
    expect(calls.map(c => c.url)).toEqual(['https://api.deepseek.com/user/balance', 'https://api.anthropic.com/v1/messages']);
    expect(peekProviderQuota('same-app', CLAUDE_CFG)).toMatchObject({ kind: 'window', remainingPercent: 36.8 });
    // And back: the DeepSeek entry was discarded, so it is fetched again rather than replayed.
    expect(peekProviderQuota('same-app', DS_CFG)).toBeNull();
    await flush();
    expect(calls).toHaveLength(3);
  });

  it('same provider, inline key rotation: the old key\'s value and backoff are not reused', async () => {
    let fail = false;
    const calls = installTransport(() => (fail ? { status: 401, headers: {}, body: '' } : ok(DEEPSEEK_BODY)));
    await refreshProviderQuota('app-a', DS_CFG);
    // Put the old key into failure backoff, then rotate.
    fail = true;
    now += PROVIDER_QUOTA_TTL_MS + 1;
    await refreshProviderQuota('app-a', DS_CFG);
    expect(calls).toHaveLength(2);
    fail = false;
    const rotated = { ...DS_CFG, env: { DEEPSEEK_API_KEY: 'sk-rotated' } };
    expect(peekProviderQuota('app-a', rotated)).toBeNull(); // no stale value from the old key
    await flush();
    expect(calls).toHaveLength(3); // old backoff did not suppress the new key's fetch
    expect(calls[2]!.headers.Authorization).toBe('Bearer sk-rotated');
    expect(peekProviderQuota('app-a', rotated)).toEqual(DEEPSEEK_QUOTA);
  });

  const ACC2_BODY = JSON.stringify({ rate_limit: { primary_window: { used_percent: 50, limit_window_seconds: 604800, reset_at: 9 } } });
  const byAccount = (call: Call) => ok(call.headers['ChatGPT-Account-Id'] === 'acc-1' ? CODEX_BODY : ACC2_BODY);

  it('same provider, file-backed account rotation: the content-fingerprint probe drops the old account\'s value', async () => {
    const files: Record<string, { body: string; mtime: number }> = {
      '/virtual/codex/auth.json': { body: CODEX_AUTH('at-1', 'acc-1'), mtime: 1 },
    };
    const io = installFiles(files);
    const calls = installTransport(byAccount);
    await refreshProviderQuota('app-b', CODEX_CFG);
    const readsAfterFetch = io.reads.length;
    expect(peekProviderQuota('app-b', CODEX_CFG)).toMatchObject({ remainingPercent: 92 });
    await flush();
    expect(io.reads.length).toBe(readsAfterFetch); // no probe right after a fetch
    // Rotate the login on disk — metadata deliberately unchanged (same "mtime").
    files['/virtual/codex/auth.json'] = { body: CODEX_AUTH('at-2', 'acc-2'), mtime: 1 };
    now += PROVIDER_QUOTA_CREDENTIAL_PROBE_MS + 1;
    expect(peekProviderQuota('app-b', CODEX_CFG)).toMatchObject({ remainingPercent: 92 }); // probe kicked off, async
    await flush();
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers['ChatGPT-Account-Id']).toBe('acc-2');
    expect(peekProviderQuota('app-b', CODEX_CFG)).toMatchObject({ remainingPercent: 50 });
  });

  it('cross-rotation during a refresh: the cached value stays bound to the content that was read, and the next probe replaces it', async () => {
    // The file is replaced *while* the first refresh is in flight (after the
    // loader read the old content, before the response landed). Identity is a
    // fingerprint of exactly the bytes read, so the 92% is bound to acc-1 —
    // never to "the current file" — and the 30s probe re-reads and evicts it.
    const files: Record<string, { body: string; mtime: number }> = {
      '/virtual/codex/auth.json': { body: CODEX_AUTH('at-1', 'acc-1'), mtime: 1 },
    };
    const io = installFiles(files);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const calls = installTransport(async call => {
      if (call.headers['ChatGPT-Account-Id'] === 'acc-1') await gate;
      return byAccount(call);
    });
    peekProviderQuota('app-b', CODEX_CFG);
    await flush();
    expect(io.reads).toHaveLength(1);
    expect(calls).toHaveLength(1);
    // Atomic replacement lands now, with a newer mtime the implementation must not consult.
    files['/virtual/codex/auth.json'] = { body: CODEX_AUTH('at-2', 'acc-2'), mtime: 2 };
    release();
    await flush();
    expect(peekProviderQuota('app-b', CODEX_CFG)).toMatchObject({ remainingPercent: 92 }); // acc-1's value, bound to acc-1
    now += PROVIDER_QUOTA_CREDENTIAL_PROBE_MS + 1;
    peekProviderQuota('app-b', CODEX_CFG);
    await flush();
    await flush();
    expect(io.reads).toHaveLength(3); // loader + probe + loader for the new identity
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers['ChatGPT-Account-Id']).toBe('acc-2');
    expect(peekProviderQuota('app-b', CODEX_CFG)).toMatchObject({ remainingPercent: 50 });
  });

  it('file-backed rotation caught at refresh time (no probe): old value is not carried over', async () => {
    const files: Record<string, { body: string; mtime: number }> = {
      '/virtual/codex/auth.json': { body: CODEX_AUTH('at-1', 'acc-1'), mtime: 1 },
    };
    installFiles(files);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const calls = installTransport(async call => {
      if (call.headers['ChatGPT-Account-Id'] === 'acc-2') await gate;
      return byAccount(call);
    });
    await refreshProviderQuota('app-b', CODEX_CFG);
    files['/virtual/codex/auth.json'] = { body: CODEX_AUTH('at-2', 'acc-2'), mtime: 1 };
    now += PROVIDER_QUOTA_TTL_MS + 1;
    peekProviderQuota('app-b', CODEX_CFG); // schedules refresh
    await flush();
    expect(calls).toHaveLength(2);
    // The loader has seen the new identity; while acc-2's request is pending the
    // old account's 92% must already be gone.
    expect(peekProviderQuota('app-b', CODEX_CFG)).toBeNull();
    release();
    await flush();
    expect(peekProviderQuota('app-b', CODEX_CFG)).toMatchObject({ remainingPercent: 50 });
  });

  it('credential file becomes unusable while a value is cached: probe hides the value and backs off', async () => {
    const files: Record<string, { body: string; mtime: number }> = {
      '/virtual/codex/auth.json': { body: CODEX_AUTH('at-1', 'acc-1'), mtime: 1 },
    };
    installFiles(files);
    const calls = installTransport(byAccount);
    await refreshProviderQuota('app-b', CODEX_CFG);
    files['/virtual/codex/auth.json'] = { body: JSON.stringify({ auth_mode: 'apikey' }), mtime: 1 };
    now += PROVIDER_QUOTA_CREDENTIAL_PROBE_MS + 1;
    peekProviderQuota('app-b', CODEX_CFG);
    await flush();
    await flush();
    expect(peekProviderQuota('app-b', CODEX_CFG)).toBeNull();
    expect(calls).toHaveLength(1);
    now += PROVIDER_QUOTA_FAILURE_BACKOFF_MS - 1;
    peekProviderQuota('app-b', CODEX_CFG);
    await flush();
    expect(calls).toHaveLength(1); // still backing off, no request with a dead credential
  });

  it('a late completion of an old in-flight request never surfaces after the source changed', async () => {
    let releaseOld!: () => void;
    const oldGate = new Promise<void>(r => { releaseOld = r; });
    const calls = installTransport(async call => {
      if (call.headers.Authorization === 'Bearer sk-test') { await oldGate; return ok(DEEPSEEK_BODY); }
      return ok(CLAUDE_BODY, CLAUDE_HEADERS);
    });
    expect(peekProviderQuota('same-app', DS_CFG)).toBeNull(); // old request in flight
    await flush();
    expect(calls).toHaveLength(1); // DeepSeek request is on the wire, blocked on oldGate
    expect(peekProviderQuota('same-app', CLAUDE_CFG)).toBeNull(); // switch while old is pending
    await flush();
    expect(calls).toHaveLength(2);
    expect(peekProviderQuota('same-app', CLAUDE_CFG)).toMatchObject({ kind: 'window' });
    releaseOld();
    await flush();
    expect(peekProviderQuota('same-app', CLAUDE_CFG)).toMatchObject({ kind: 'window', remainingPercent: 36.8 });
    // Switching back to DeepSeek does not replay the late result either.
    expect(peekProviderQuota('same-app', DS_CFG)).toBeNull();
    await flush();
    expect(calls).toHaveLength(3);
  });
});

describe('provider-quota hot path does no file I/O', () => {
  it('peek reads no credential file in cache-fresh, backoff and in-flight states; first peek is immediate null', async () => {
    const io = installFiles({ '/virtual/codex/auth.json': { body: CODEX_AUTH('at-1'), mtime: 1 } });
    let release!: () => void;
    let gate = new Promise<void>(r => { release = r; });
    let fail = false;
    installTransport(async () => { await gate; return fail ? { status: 500, headers: {}, body: '' } : ok(CODEX_BODY); });

    // In-flight: first peek returns null synchronously; the ONE background read
    // belongs to the refresh, not to the peeks.
    expect(peekProviderQuota('app-b', CODEX_CFG)).toBeNull();
    await flush();
    const readsAfterRefreshStart = io.reads.length;
    expect(readsAfterRefreshStart).toBe(1);
    for (let i = 0; i < 20; i++) expect(peekProviderQuota('app-b', CODEX_CFG)).toBeNull();
    expect(io.reads.length).toBe(readsAfterRefreshStart);
    release();
    await flush();

    // Cache fresh: many peeks, zero reads.
    const reads = io.reads.length;
    for (let i = 0; i < 50; i++) expect(peekProviderQuota('app-b', CODEX_CFG)).toMatchObject({ remainingPercent: 92 });
    await flush();
    expect(io.reads.length).toBe(reads);

    // Backoff: force a failure, then peeks inside the backoff window read nothing.
    fail = true;
    gate = Promise.resolve();
    now += PROVIDER_QUOTA_TTL_MS + 1;
    peekProviderQuota('app-b', CODEX_CFG);
    await flush();
    const readsAfterFailure = io.reads.length;
    now += 1000;
    for (let i = 0; i < 50; i++) peekProviderQuota('app-b', CODEX_CFG);
    await flush();
    // The peeks themselves read nothing; at most ONE throttled background
    // rotation probe may run (the stale value is still on display, so a
    // rotated credential must still be detectable during backoff).
    expect(io.reads.length - readsAfterFailure).toBeLessThanOrEqual(1);
    const readsAfterProbe = io.reads.length;
    for (let i = 0; i < 50; i++) peekProviderQuota('app-b', CODEX_CFG);
    await flush();
    expect(io.reads.length).toBe(readsAfterProbe);
  });

  it('the credential rotation probe is one background content read, throttled, and only while a value is cached', async () => {
    const io = installFiles({ '/virtual/codex/auth.json': { body: CODEX_AUTH('at-1'), mtime: 1 } });
    const calls = installTransport(() => ok(CODEX_BODY));
    await refreshProviderQuota('app-b', CODEX_CFG);
    const reads = io.reads.length;
    now += PROVIDER_QUOTA_CREDENTIAL_PROBE_MS + 1;
    for (let i = 0; i < 10; i++) peekProviderQuota('app-b', CODEX_CFG); // all synchronous, none blocks
    await flush();
    expect(io.reads.length).toBe(reads + 1);
    expect(calls).toHaveLength(1); // unchanged identity → no refresh
    now += PROVIDER_QUOTA_CREDENTIAL_PROBE_MS - 1;
    peekProviderQuota('app-b', CODEX_CFG);
    await flush();
    expect(io.reads.length).toBe(reads + 1); // throttled
  });
});

describe('provider-quota logging never leaks error text', () => {
  it('a transport exception whose message carries a sentinel is logged by class/code only', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const err = Object.assign(new Error('transport failed with dummy-secret-marker https://user:pw@proxy'), { code: 'ECONNRESET' });
    installTransport(() => { throw err; });
    await refreshProviderQuota('app-a', DS_CFG);
    const all = [...warn.mock.calls, ...error.mock.calls, ...info.mock.calls].flat().map(String).join('\n');
    expect(all).not.toContain('dummy-secret-marker');
    expect(all).not.toContain('user:pw');
    expect(all).not.toContain('sk-test');
    expect(all).toContain('fetch failed: Error/ECONNRESET');
  });

  it('a well-formed but unknown error name/code (secret shaped like a constant) is never logged', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const err = Object.assign(new Error('x'), { name: 'DUMMYSECRETMARKER', code: 'TOKENABC123' });
    installTransport(() => { throw err; });
    await refreshProviderQuota('app-a', DS_CFG);
    const all = [...warn.mock.calls, ...error.mock.calls, ...info.mock.calls].flat().map(String).join('\n');
    expect(all).not.toContain('DUMMYSECRETMARKER');
    expect(all).not.toContain('TOKENABC123');
    expect(all).toContain('fetch failed: Error/UNKNOWN');
  });

  it('HTTP failures log only the status and a numeric Retry-After', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    installTransport(() => ({ status: 429, headers: { 'retry-after': '120', 'x-secret': 'dummy-secret-marker' }, body: '{"token":"dummy-secret-marker"}' }));
    await refreshProviderQuota('app-c', CLAUDE_CFG);
    const all = warn.mock.calls.flat().map(String).join('\n');
    expect(all).not.toContain('dummy-secret-marker');
    expect(all).toContain('HTTP 429, retry after 120s');
  });

  it('safeErrorLabel is a fixed value allow-list: unknown names → Error, unknown codes → UNKNOWN', () => {
    expect(safeErrorLabel(new Error('secret'))).toBe('Error/UNKNOWN');
    expect(safeErrorLabel(Object.assign(new TypeError('secret'), { code: 'ERR_INVALID_URL' }))).toBe('TypeError/ERR_INVALID_URL');
    expect(safeErrorLabel(Object.assign(new Error('secret'), { code: 'ECONNRESET' }))).toBe('Error/ECONNRESET');
    for (const code of ['sk-live-secret', 'TOKENABC123', 'ERR_SECRET_VALUE', 'E_' + 'A'.repeat(30), '', 42, null]) {
      expect(safeErrorLabel(Object.assign(new Error('secret'), { code })), String(code)).toBe('Error/UNKNOWN');
    }
    for (const name of ['DUMMYSECRETMARKER', 'Bad name with secret', 'SyntaxErrorX', 'Error ', '']) {
      expect(safeErrorLabel(Object.assign(new Error('secret'), { name })), name).toBe('Error/UNKNOWN');
    }
    expect(safeErrorLabel(Object.assign(new Error('secret'), { name: 'ProviderQuotaTransportError', code: 'ERR_DEADLINE' })))
      .toBe('ProviderQuotaTransportError/ERR_DEADLINE');
    expect(safeErrorLabel('secret string')).toBe('UnknownError');
    expect(safeErrorLabel({ name: 'DUMMYSECRETMARKER', code: 'TOKENABC123' })).toBe('UnknownError');
  });
});

describe('provider-quota bounded default transport', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>(r => server!.close(() => r()));
    server = undefined;
  });

  async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
    server = createServer(handler);
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('returns status, lower-cased headers and body for a normal response', async () => {
    const base = await listen((req, res) => {
      res.setHeader('Retry-After', '7');
      res.statusCode = 429;
      res.end(JSON.stringify({ seen: req.headers.authorization }));
    });
    const res = await __defaultProviderQuotaTransportForTests({ url: `${base}/x`, method: 'GET', headers: { Authorization: 'Bearer t' } }, { timeoutMs: 2000, deadlineMs: 4000, maxBodyBytes: 65536 });
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('7');
    expect(JSON.parse(res.body)).toEqual({ seen: 'Bearer t' });
  });

  it('sends a POST body with content-length and returns the response headers', async () => {
    let seen: { method?: string; body?: string; len?: string } = {};
    const base = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        seen = { method: req.method, body: Buffer.concat(chunks).toString(), len: String(req.headers['content-length']) };
        res.setHeader('anthropic-ratelimit-unified-7d-utilization', '0.1');
        res.statusCode = 200;
        res.end('{}');
      });
    });
    const res = await __defaultProviderQuotaTransportForTests(
      { url: `${base}/v1/messages`, method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"max_tokens":1}' },
      { timeoutMs: 2000, deadlineMs: 4000, maxBodyBytes: 65536 },
    );
    expect(seen).toEqual({ method: 'POST', body: '{"max_tokens":1}', len: '16' });
    expect(res.headers['anthropic-ratelimit-unified-7d-utilization']).toBe('0.1');
  });

  it('aborts a response larger than the body cap', async () => {
    const base = await listen((_req, res) => {
      res.statusCode = 200;
      res.write(Buffer.alloc(40_000, 0x61));
      res.write(Buffer.alloc(40_000, 0x62));
      res.end();
    });
    await expect(__defaultProviderQuotaTransportForTests({ url: `${base}/big`, method: 'GET', headers: {} }, { timeoutMs: 2000, deadlineMs: 4000, maxBodyBytes: 65536 }))
      .rejects.toMatchObject({ code: 'ERR_BODY_TOO_LARGE' });
  });

  it('enforces a hard deadline on a slow trickling response', async () => {
    const base = await listen((_req, res) => {
      res.statusCode = 200;
      const timer = setInterval(() => { res.write('x'); }, 50); // keeps the socket busy → inactivity timeout never fires
      res.on('close', () => clearInterval(timer));
    });
    const started = Date.now();
    await expect(__defaultProviderQuotaTransportForTests({ url: `${base}/slow`, method: 'GET', headers: {} }, { timeoutMs: 5000, deadlineMs: 300, maxBodyBytes: 65536 }))
      .rejects.toMatchObject({ code: 'ERR_DEADLINE' });
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
