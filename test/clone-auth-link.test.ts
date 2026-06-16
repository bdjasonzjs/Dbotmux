import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadDeclaredScopes, cloneGrantScopes, buildAuthUrl, CLONE_CORE_SCOPES,
} from '../src/services/clone-auth-link.js';

// The real declared scope list (source of truth for the existence check).
const REAL_SCOPES = fileURLToPath(new URL('../src/setup/lark-scopes.json', import.meta.url));

const tmps: string[] = [];
afterEach(() => { while (tmps.length) { try { rmSync(tmps.pop()!, { recursive: true, force: true }); } catch { /* */ } } });
function writeScopes(tenant: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'scopes-')); tmps.push(dir);
  const fp = join(dir, 'lark-scopes.json');
  writeFileSync(fp, JSON.stringify({ scopes: { tenant } }));
  return fp;
}
const MISSING = join(tmpdir(), 'no-such-scopes-file-xyz.json');

describe('buildAuthUrl (守点3 + 6)', () => {
  it('assembles appId/q/op_from/token_type via URLSearchParams (commas + colons encoded)', () => {
    const url = buildAuthUrl('cli_x', ['im:message', 'im:chat:read']);
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe('https://open.feishu.cn/app/cli_x/auth');
    expect(u.searchParams.get('q')).toBe('im:message,im:chat:read'); // decoded round-trip
    expect(u.searchParams.get('op_from')).toBe('openapi');
    expect(u.searchParams.get('token_type')).toBe('tenant');
    expect(url).toContain('q=im%3Amessage%2Cim%3Achat%3Aread'); // raw is percent-encoded
  });
  it('only appId + q/op_from/token_type — no secret/token field (守点6)', () => {
    const url = buildAuthUrl('cli_x', ['im:message']);
    expect([...new URL(url).searchParams.keys()].sort()).toEqual(['op_from', 'q', 'token_type']);
    expect(url).not.toMatch(/secret/i);
  });
  it('throws on empty appId or empty scopes', () => {
    expect(() => buildAuthUrl('', ['im:message'])).toThrow();
    expect(() => buildAuthUrl('cli_x', [])).toThrow();
  });
});

describe('loadDeclaredScopes (守点1 fail-closed + override/fallback + dedup/sort)', () => {
  it('override wins over package', () => {
    const override = writeScopes(['b', 'a']);
    const pkg = writeScopes(['z']);
    expect(loadDeclaredScopes({ overridePath: override, packagePath: pkg })).toEqual(['a', 'b']);
  });
  it('falls back to package when override missing', () => {
    const pkg = writeScopes(['m', 'm', 'k']); // dedup + sort
    expect(loadDeclaredScopes({ overridePath: MISSING, packagePath: pkg })).toEqual(['k', 'm']);
  });
  it('both missing/unparseable → throws (no empty q)', () => {
    expect(() => loadDeclaredScopes({ overridePath: MISSING, packagePath: MISSING })).toThrow(/no usable scopes/);
    const bad = mkdtempSync(join(tmpdir(), 'bad-')); tmps.push(bad);
    const badFp = join(bad, 'lark-scopes.json'); writeFileSync(badFp, '{ broken');
    expect(() => loadDeclaredScopes({ overridePath: MISSING, packagePath: badFp })).toThrow();
  });
  it('empty tenant array → throws (fail closed)', () => {
    expect(() => loadDeclaredScopes({ overridePath: MISSING, packagePath: writeScopes([]) })).toThrow();
  });
});

describe('cloneGrantScopes (守点2 core/full named, existence, dedup/sort)', () => {
  it('every CLONE_CORE_SCOPES entry exists in the real lark-scopes.json', () => {
    const declared = new Set(loadDeclaredScopes({ overridePath: MISSING, packagePath: REAL_SCOPES }));
    for (const s of CLONE_CORE_SCOPES) expect(declared.has(s), `missing scope: ${s}`).toBe(true);
  });
  it("'core' → CLONE_CORE_SCOPES (deduped + sorted), subset of declared", () => {
    const core = cloneGrantScopes('core', { overridePath: MISSING, packagePath: REAL_SCOPES });
    expect(core).toEqual([...new Set(CLONE_CORE_SCOPES)].sort());
    expect(core.length).toBeLessThan(loadDeclaredScopes({ overridePath: MISSING, packagePath: REAL_SCOPES }).length);
  });
  it("'core' fails closed when an override drops ANY core scope (no partial grant)", () => {
    // override declares all core scopes EXCEPT the first → must throw + name it, not emit a partial q
    const dropped = CLONE_CORE_SCOPES[0];
    const partial = writeScopes(CLONE_CORE_SCOPES.slice(1));
    expect(() => cloneGrantScopes('core', { overridePath: partial, packagePath: REAL_SCOPES }))
      .toThrow(new RegExp(`missing.*${dropped.replace(/[.:]/g, '\\$&')}`));
  });

  it("'full' → all declared scopes", () => {
    const full = cloneGrantScopes('full', { overridePath: MISSING, packagePath: REAL_SCOPES });
    expect(full).toEqual(loadDeclaredScopes({ overridePath: MISSING, packagePath: REAL_SCOPES }));
    expect(full.length).toBeGreaterThan(CLONE_CORE_SCOPES.length);
  });
  it("default profile is 'core'", () => {
    expect(cloneGrantScopes(undefined, { overridePath: MISSING, packagePath: REAL_SCOPES }))
      .toEqual(cloneGrantScopes('core', { overridePath: MISSING, packagePath: REAL_SCOPES }));
  });
});
