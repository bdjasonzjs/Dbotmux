/**
 * Unit tests for base-relay retry classification.
 * Run: pnpm vitest run test/base-relay.test.ts
 */
import { describe, it, expect } from 'vitest';

import { isGroupFieldNotFoundError } from '../src/services/base-relay.js';

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
