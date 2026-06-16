/**
 * Unit tests for base-relay retry classification.
 * Run: pnpm vitest run test/base-relay.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest';

import {
  isGroupFieldNotFoundError, isUserAuthError,
  resolvePollTimeoutMs, maxSafePollTimeoutMs,
  DEFAULT_POLL_TIMEOUT_MS, RELAY_WORST_CASE_OVERHEAD_MS,
} from '../src/services/base-relay.js';
import { DISPATCH_LEASE_MS } from '../src/services/outbox-dispatcher.js';

describe('isGroupFieldNotFoundError', () => {
  it('recognizes lark-cli base group field not_found JSON from stderr', () => {
    const stderr = `{
  "ok": false,
  "identity": "user",
  "error": {
    "type": "api_error",
    "code": 800030410,
    "message": "not_found",
    "hint": "Provide a valid group id in the cell"
  }
}`;
    expect(isGroupFieldNotFoundError({ stdout: '', stderr })).toBe(true);
  });

  it('does not classify unrelated base errors as group readiness', () => {
    const stderr = `{"ok":false,"error":{"type":"api_error","code":1254001,"message":"permission denied"}}`;
    expect(isGroupFieldNotFoundError({ stdout: '', stderr })).toBe(false);
  });

  it('falls back to raw text matching when JSON has leading logs', () => {
    const stderr = `[lark-cli] warning
{"error":{"code":800030410,"message":"not_found"}}`;
    expect(isGroupFieldNotFoundError({ stdout: '', stderr })).toBe(true);
  });
});

describe('isUserAuthError', () => {
  it('recognizes need_user_authorization signal (raw)', () => {
    const stderr = `{"ok":false,"error":{"type":"authorization","subtype":"need_user_authorization","message":"user not authorized"}}`;
    expect(isUserAuthError({ stdout: '', stderr })).toBe(true);
  });

  it('recognizes token_missing signal', () => {
    expect(isUserAuthError({ stdout: '', stderr: 'error: token_missing' })).toBe(true);
  });

  it('recognizes authorization type with token-ish subtype', () => {
    const stderr = `{"error":{"type":"authorization","subtype":"invalid_credential"}}`;
    expect(isUserAuthError({ stdout: '', stderr })).toBe(true);
  });

  it('does NOT classify missing_scope as token death (config issue, not credential loss)', () => {
    const stderr = `{"error":{"type":"authorization","subtype":"missing_scope","message":"missing required scope(s): docx:document:create"}}`;
    expect(isUserAuthError({ stdout: '', stderr })).toBe(false);
  });

  it('does NOT classify group-not-found / generic errors as auth error', () => {
    expect(isUserAuthError({ stdout: '', stderr: `{"error":{"code":800030410,"message":"not_found"}}` })).toBe(false);
    expect(isUserAuthError({ stdout: '', stderr: `upsert failed code=1` })).toBe(false);
  });
});

// 2026-06-14 (蔻黛克斯 review P1-5)：poll 超时调大 + clamp，worst-case 必须 < dispatch lease
describe('resolvePollTimeoutMs / 不变量', () => {
  const ENV = 'SUBTASK_RELAY_POLL_TIMEOUT_MS';
  afterEach(() => { delete process.env[ENV]; });

  it('默认 75s，且生产 lease 下 worst-case < lease', () => {
    delete process.env[ENV];
    const poll = resolvePollTimeoutMs(DISPATCH_LEASE_MS);
    expect(poll).toBe(DEFAULT_POLL_TIMEOUT_MS);
    expect(poll).toBe(75_000);
    // 🔒 不变量：overhead + poll < lease
    expect(RELAY_WORST_CASE_OVERHEAD_MS + poll).toBeLessThan(DISPATCH_LEASE_MS);
  });

  it('env 可覆盖（合法值且在安全区内时生效）', () => {
    process.env[ENV] = '60000';
    expect(resolvePollTimeoutMs(DISPATCH_LEASE_MS)).toBe(60_000);
  });

  it('env 误配过大 → clamp 到 maxSafe，绝不打破 worst-case < lease', () => {
    process.env[ENV] = '999999999';
    const poll = resolvePollTimeoutMs(DISPATCH_LEASE_MS);
    expect(poll).toBe(maxSafePollTimeoutMs(DISPATCH_LEASE_MS));
    expect(RELAY_WORST_CASE_OVERHEAD_MS + poll).toBeLessThan(DISPATCH_LEASE_MS);
  });

  it('env 非法/非正 → 回落默认', () => {
    process.env[ENV] = 'abc';
    expect(resolvePollTimeoutMs(DISPATCH_LEASE_MS)).toBe(DEFAULT_POLL_TIMEOUT_MS);
    process.env[ENV] = '-5';
    expect(resolvePollTimeoutMs(DISPATCH_LEASE_MS)).toBe(DEFAULT_POLL_TIMEOUT_MS);
  });
});
