/**
 * Unit tests for src/services/provider-quota.ts.
 *
 * Run:  pnpm vitest run test/provider-quota.test.ts
 *
 * The transport and clock are injected so no test touches the network or
 * real credential files; source resolution for the file-backed providers is
 * exercised through CODEX_HOME / CLAUDE_CONFIG_DIR pointing at a temp dir.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROVIDER_QUOTA_FAILURE_BACKOFF_MS,
  PROVIDER_QUOTA_MAX_RETRY_AFTER_MS,
  PROVIDER_QUOTA_STALE_GRACE_MS,
  PROVIDER_QUOTA_TTL_MS,
  __resetProviderQuotaForTests,
  __setProviderQuotaClockForTests,
  __setProviderQuotaTransportForTests,
  describeProviderQuotaSource,
  parseProviderQuota,
  peekProviderQuota,
  refreshProviderQuota,
  type ProviderQuotaTransportResponse,
} from '../src/services/provider-quota.js';

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

const CLAUDE_BODY = JSON.stringify({
  five_hour: { utilization: 37.5, resets_at: '2026-09-02T04:00:00Z' },
  seven_day: { utilization: 63.2, resets_at: '2026-09-05T12:00:00Z' },
  seven_day_opus: { utilization: 10, resets_at: '2026-09-05T12:00:00Z' },
});

function ok(body: string, headers: Record<string, string> = {}): ProviderQuotaTransportResponse {
  return { status: 200, headers, body };
}

interface Call { url: string; headers: Record<string, string> }

function installTransport(
  respond: (call: Call) => ProviderQuotaTransportResponse | Promise<ProviderQuotaTransportResponse>,
): Call[] {
  const calls: Call[] = [];
  __setProviderQuotaTransportForTests(async (url, headers) => {
    const call = { url, headers };
    calls.push(call);
    return respond(call);
  });
  return calls;
}

async function flush(): Promise<void> {
  // Let the background refresh promise chain settle.
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
}

describe('provider-quota parsers', () => {
  it('DeepSeek: picks the CNY balance and parses the decimal string', () => {
    expect(parseProviderQuota('deepseek', JSON.parse(DEEPSEEK_BODY)))
      .toEqual({ kind: 'balance', currency: 'CNY', amount: 472.34 });
  });

  it('DeepSeek: falls back to the first entry when no CNY balance exists', () => {
    expect(parseProviderQuota('deepseek', { balance_infos: [{ currency: 'usd', total_balance: 12 }] }))
      .toEqual({ kind: 'balance', currency: 'USD', amount: 12 });
  });

  it('DeepSeek: null on an empty or malformed body (never invents a number)', () => {
    expect(parseProviderQuota('deepseek', {})).toBeNull();
    expect(parseProviderQuota('deepseek', { balance_infos: [{ currency: 'CNY', total_balance: 'n/a' }] })).toBeNull();
    expect(parseProviderQuota('deepseek', 'oops')).toBeNull();
  });

  it('Codex: picks the 7-day window regardless of position and converts used → remaining', () => {
    expect(parseProviderQuota('codex-chatgpt', JSON.parse(CODEX_BODY)))
      .toEqual({ kind: 'window', window: 'weekly', remainingPercent: 92, resetsAt: 1788803049_000 });
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

  it('Claude OAuth: renders the seven_day window only, clamped to 0–100', () => {
    expect(parseProviderQuota('claude-oauth', JSON.parse(CLAUDE_BODY)))
      .toEqual({ kind: 'window', window: 'weekly', remainingPercent: 36.8, resetsAt: Date.parse('2026-09-05T12:00:00Z') });
    expect(parseProviderQuota('claude-oauth', { seven_day: { utilization: 130 } }))
      .toEqual({ kind: 'window', window: 'weekly', remainingPercent: 0 });
    expect(parseProviderQuota('claude-oauth', { five_hour: { utilization: 1 } })).toBeNull();
  });
});

describe('provider-quota source resolution', () => {
  let tmp: string;
  const savedEnv = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'provider-quota-'));
    delete process.env.CODEX_HOME;
    delete process.env.CLAUDE_CONFIG_DIR;
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (savedEnv.CODEX_HOME === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedEnv.CODEX_HOME;
    if (savedEnv.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedEnv.CLAUDE_CONFIG_DIR;
    __resetProviderQuotaForTests();
  });

  it('DEEPSEEK_API_KEY in the bot env → deepseek, regardless of cliId', () => {
    expect(describeProviderQuotaSource({ cliId: 'pi', env: { DEEPSEEK_API_KEY: 'sk-x' }, model: 'deepseek/deepseek-v4-flash' }))
      .toBe('deepseek');
    expect(describeProviderQuotaSource({ cliId: 'pi', env: {}, model: 'deepseek/deepseek-v4-flash' })).toBeNull();
  });

  it('claude-code with CLAUDE_CODE_OAUTH_TOKEN → claude-oauth; third-party relay → none', () => {
    expect(describeProviderQuotaSource({ cliId: 'claude-code', env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' } })).toBe('claude-oauth');
    expect(describeProviderQuotaSource({
      cliId: 'claude-code',
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok', ANTHROPIC_BASE_URL: 'https://relay.example' },
    })).toBeNull();
  });

  it('claude-code without an env token reads <CLAUDE_CONFIG_DIR>/.credentials.json', () => {
    const dir = join(tmp, 'claude');
    mkdirSync(dir);
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: '' } }));
    expect(describeProviderQuotaSource({ cliId: 'claude-code', env: { CLAUDE_CONFIG_DIR: dir } })).toBeNull();
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'file-tok' } }));
    expect(describeProviderQuotaSource({ cliId: 'claude-code', env: { CLAUDE_CONFIG_DIR: dir } })).toBe('claude-oauth');
  });

  it('codex reads <CODEX_HOME>/auth.json and requires a ChatGPT login with an account id', () => {
    const dir = join(tmp, 'codex');
    mkdirSync(dir);
    expect(describeProviderQuotaSource({ cliId: 'codex', env: { CODEX_HOME: dir } })).toBeNull();
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk' }));
    expect(describeProviderQuotaSource({ cliId: 'codex', env: { CODEX_HOME: dir } })).toBeNull();
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt', tokens: { access_token: 'at', account_id: 'acc' },
    }));
    expect(describeProviderQuotaSource({ cliId: 'codex', env: { CODEX_HOME: dir } })).toBe('codex-chatgpt');
    process.env.CODEX_HOME = dir;
    expect(describeProviderQuotaSource({ cliId: 'codex-app', env: {} })).toBe('codex-chatgpt');
  });

  it('other CLIs have no quota source', () => {
    expect(describeProviderQuotaSource({ cliId: 'gemini', env: {} })).toBeNull();
    expect(describeProviderQuotaSource(undefined)).toBeNull();
  });
});

describe('provider-quota cache / refresh policy', () => {
  let now: number;
  const cfg = { cliId: 'pi', env: { DEEPSEEK_API_KEY: 'sk-test' } };

  beforeEach(() => {
    __resetProviderQuotaForTests();
    now = 1_000_000_000;
    __setProviderQuotaClockForTests(() => now);
  });
  afterEach(() => { __resetProviderQuotaForTests(); });

  it('peek never blocks: first call returns null and triggers one background fetch', async () => {
    const calls = installTransport(() => ok(DEEPSEEK_BODY));
    expect(peekProviderQuota('app-a', cfg)).toBeNull();
    expect(peekProviderQuota('app-a', cfg)).toBeNull(); // in-flight → no second call
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.deepseek.com/user/balance');
    expect(calls[0]!.headers.Authorization).toBe('Bearer sk-test');
    expect(peekProviderQuota('app-a', cfg)).toEqual({ kind: 'balance', currency: 'CNY', amount: 472.34 });
  });

  it('serves the cached value for the TTL, then refreshes once', async () => {
    const calls = installTransport(() => ok(DEEPSEEK_BODY));
    await refreshProviderQuota('app-a', cfg);
    expect(calls).toHaveLength(1);
    now += PROVIDER_QUOTA_TTL_MS - 1;
    peekProviderQuota('app-a', cfg);
    await flush();
    expect(calls).toHaveLength(1);
    now += 2;
    peekProviderQuota('app-a', cfg);
    peekProviderQuota('app-a', cfg);
    await flush();
    expect(calls).toHaveLength(2);
  });

  it('keeps the last good value through failures for the grace period, then hides it', async () => {
    let fail = false;
    const calls = installTransport(() => (fail ? { status: 500, headers: {}, body: 'boom' } : ok(DEEPSEEK_BODY)));
    await refreshProviderQuota('app-a', cfg);
    fail = true;
    now += PROVIDER_QUOTA_TTL_MS + 1;
    expect(peekProviderQuota('app-a', cfg)).toEqual({ kind: 'balance', currency: 'CNY', amount: 472.34 });
    await flush();
    expect(calls).toHaveLength(2);
    // Failure backoff: no retry inside the window.
    now += PROVIDER_QUOTA_FAILURE_BACKOFF_MS - 1;
    expect(peekProviderQuota('app-a', cfg)).not.toBeNull();
    await flush();
    expect(calls).toHaveLength(2);
    // Past the stale grace → hidden rather than shown stale.
    now = 1_000_000_000 + PROVIDER_QUOTA_STALE_GRACE_MS + 1;
    expect(peekProviderQuota('app-a', cfg)).toBeNull();
  });

  it('honors Retry-After on 429 (clamped) instead of the default backoff', async () => {
    const calls = installTransport(() => ({
      status: 429,
      headers: { 'retry-after': '3565' },
      body: '{"error":{"type":"rate_limit_error"}}',
    }));
    const claudeCfg = { cliId: 'claude-code', env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' } };
    expect(await refreshProviderQuota('app-c', claudeCfg)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['anthropic-beta']).toBe('oauth-2025-04-20');
    now += 3565_000 - 1;
    peekProviderQuota('app-c', claudeCfg);
    await flush();
    expect(calls).toHaveLength(1);
    now += 2;
    peekProviderQuota('app-c', claudeCfg);
    await flush();
    expect(calls).toHaveLength(2);
  });

  it('clamps an absurd Retry-After to the maximum', async () => {
    installTransport(() => ({ status: 429, headers: { 'retry-after': String(30 * 24 * 3600) }, body: '' }));
    const claudeCfg = { cliId: 'claude-code', env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' } };
    await refreshProviderQuota('app-c', claudeCfg);
    const calls = installTransport(() => ok(CLAUDE_BODY));
    now += PROVIDER_QUOTA_MAX_RETRY_AFTER_MS + 1;
    peekProviderQuota('app-c', claudeCfg);
    await flush();
    expect(calls).toHaveLength(1);
    expect(peekProviderQuota('app-c', claudeCfg)).toMatchObject({ kind: 'window', remainingPercent: 36.8 });
  });

  it('transport exceptions and non-JSON bodies degrade to null with backoff', async () => {
    let mode: 'throw' | 'garbage' = 'throw';
    const calls = installTransport(() => {
      if (mode === 'throw') throw new Error('ECONNRESET');
      return ok('<html>');
    });
    expect(await refreshProviderQuota('app-a', cfg)).toBeNull();
    mode = 'garbage';
    now += PROVIDER_QUOTA_FAILURE_BACKOFF_MS + 1;
    expect(await refreshProviderQuota('app-a', cfg)).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('caches per bot and sends the codex account headers', async () => {
    const calls = installTransport(call => (call.url.includes('deepseek') ? ok(DEEPSEEK_BODY) : ok(CODEX_BODY)));
    const tmp = mkdtempSync(join(tmpdir(), 'provider-quota-codex-'));
    try {
      writeFileSync(join(tmp, 'auth.json'), JSON.stringify({
        auth_mode: 'chatgpt', tokens: { access_token: 'at-1', account_id: 'acc-1' },
      }));
      const codexCfg = { cliId: 'codex', env: { CODEX_HOME: tmp } };
      await Promise.all([refreshProviderQuota('app-a', cfg), refreshProviderQuota('app-b', codexCfg)]);
      expect(calls).toHaveLength(2);
      const codexCall = calls.find(c => c.url.includes('chatgpt.com'))!;
      expect(codexCall.headers.Authorization).toBe('Bearer at-1');
      expect(codexCall.headers['ChatGPT-Account-Id']).toBe('acc-1');
      expect(peekProviderQuota('app-a', cfg)).toMatchObject({ kind: 'balance' });
      expect(peekProviderQuota('app-b', codexCfg)).toMatchObject({ kind: 'window', remainingPercent: 92 });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
