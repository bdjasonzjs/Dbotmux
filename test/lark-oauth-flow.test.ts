/**
 * Regression tests for src/dashboard/lark-oauth-flow.ts:
 *
 *   1. sanitizeNext() — the open-redirect guard surfaces 4 callsites in
 *      dashboard.ts (/login, /auth/lark/start, /auth/lark/callback,
 *      /api/auth/device/poll). The function must collapse anything that
 *      could bounce a logged-in user outside the dashboard.
 *
 *   2. signState() / verifyState() — HMAC round-trip + tamper / wrong-key
 *      / expired rejection. State is what survives the round-trip through
 *      Lark, so the verify side is the only thing standing between us and
 *      an attacker forging a `next=` payload.
 *
 * Run:  pnpm vitest run test/lark-oauth-flow.test.ts
 */
import { describe, it, expect } from 'vitest';
import { sanitizeNext, signState, verifyState } from '../src/dashboard/lark-oauth-flow.js';

describe('sanitizeNext', () => {
  it('returns "/" for null / undefined / empty input', () => {
    expect(sanitizeNext(null)).toBe('/');
    expect(sanitizeNext(undefined)).toBe('/');
    expect(sanitizeNext('')).toBe('/');
  });

  it('passes through normal relative paths unchanged', () => {
    expect(sanitizeNext('/')).toBe('/');
    expect(sanitizeNext('/topology')).toBe('/topology');
    expect(sanitizeNext('/api/foo/bar')).toBe('/api/foo/bar');
    expect(sanitizeNext('/api?x=1&y=2')).toBe('/api?x=1&y=2');
    expect(sanitizeNext('/path-with-dash_and_underscore')).toBe('/path-with-dash_and_underscore');
  });

  it('rejects protocol-relative "//evil.example/path" (the original P1 finding)', () => {
    expect(sanitizeNext('//evil.example/path')).toBe('/');
    expect(sanitizeNext('//evil')).toBe('/');
    expect(sanitizeNext('//')).toBe('/');
  });

  it('rejects scheme URLs and javascript:', () => {
    expect(sanitizeNext('http://evil')).toBe('/');
    expect(sanitizeNext('https://evil/path')).toBe('/');
    expect(sanitizeNext('javascript:alert(1)')).toBe('/');
    // embedded scheme after slash
    expect(sanitizeNext('/javascript:alert(1)')).toBe('/');
    expect(sanitizeNext('/http://evil')).toBe('/');
  });

  it('rejects inputs that do not start with "/"', () => {
    expect(sanitizeNext('topology')).toBe('/');
    expect(sanitizeNext('foo/bar')).toBe('/');
    expect(sanitizeNext(' /topology')).toBe('/'); // leading space → control-char branch
  });

  it('rejects CR / LF and other control chars (Location header injection)', () => {
    expect(sanitizeNext('/path\r\nLocation: bad')).toBe('/');
    expect(sanitizeNext('/path\nLocation: bad')).toBe('/');
    expect(sanitizeNext('/path\rfoo')).toBe('/');
    expect(sanitizeNext('/path\x00null')).toBe('/');
    expect(sanitizeNext('/path\x1ffoo')).toBe('/');
    expect(sanitizeNext('/path\tfoo')).toBe('/');  // tab is also rejected
  });

  it('rejects backslashes (Windows-style traversal)', () => {
    expect(sanitizeNext('/path\\evil')).toBe('/');
    expect(sanitizeNext('/\\evil')).toBe('/');
  });
});

describe('signState / verifyState', () => {
  const SECRET = 'unit-test-secret-DO-NOT-USE-IN-PROD';

  it('round-trips a path through HMAC-signed state', () => {
    const state = signState('/topology', SECRET);
    expect(typeof state).toBe('string');
    expect(state.length).toBeGreaterThan(0);
    expect(verifyState(state, SECRET)).toBe('/topology');
  });

  it('rejects when verifying with the wrong secret', () => {
    const state = signState('/topology', SECRET);
    expect(verifyState(state, 'different-secret')).toBeNull();
  });

  it('rejects a tampered state', () => {
    const state = signState('/topology', SECRET);
    const tampered = state.slice(0, -4) + 'XXXX';
    expect(verifyState(tampered, SECRET)).toBeNull();
  });

  it('rejects a malformed (non-base64url / wrong-parts) state', () => {
    expect(verifyState('not-real-state', SECRET)).toBeNull();
    expect(verifyState('', SECRET)).toBeNull();
    // base64url of a payload with the wrong part count
    const bad = Buffer.from('only|two|parts', 'utf-8').toString('base64url');
    expect(verifyState(bad, SECRET)).toBeNull();
  });

  it('different invocations produce different state (nonce + ts vary)', () => {
    const a = signState('/topology', SECRET);
    const b = signState('/topology', SECRET);
    // Two consecutive calls in the same ms with the same secret could
    // collide only if the random 8 bytes also collide — astronomical.
    expect(a).not.toBe(b);
  });
});
