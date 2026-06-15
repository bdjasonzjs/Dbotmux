/**
 * Unit tests for base-relay retry classification.
 * Run: pnpm vitest run test/base-relay.test.ts
 */
import { describe, it, expect } from 'vitest';

import { isGroupFieldNotFoundError, isUserAuthError } from '../src/services/base-relay.js';

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
