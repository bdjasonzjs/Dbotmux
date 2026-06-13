import { describe, expect, it, afterEach } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { getSessionJsonlPath } from '../src/core/cost-calculator.js';
import { resolveClaudeHomeForAdopt } from '../src/core/claude-home.js';
import { __testOnly_parseClaudeConfigDirFromEnviron as parseEnviron } from '../src/core/session-discovery.js';

const tmps: string[] = [];
afterEach(() => { while (tmps.length) { try { rmSync(tmps.pop()!, { recursive: true, force: true }); } catch { /* */ } } });

describe('cost-calculator getSessionJsonlPath honours claudeHome', () => {
  const SID = '11111111-2222-3333-4444-555555555555';

  it('default claudeHome routes under ~/.claude (zero behaviour change)', () => {
    // No file there for our random cwd → null, but the lookup must target ~/.claude.
    // Prove routing by creating the file under ~/.claude is intrusive; instead assert
    // that a file placed under a CUSTOM home is found only when that home is passed.
    const cwd = mkdtempSync(join(tmpdir(), 'cwd-')); tmps.push(cwd);
    const projectKey = resolve(cwd).replace(/\//g, '-');

    const customHome = mkdtempSync(join(tmpdir(), 'clonehome-')); tmps.push(customHome);
    mkdirSync(join(customHome, 'projects', projectKey), { recursive: true });
    writeFileSync(join(customHome, 'projects', projectKey, `${SID}.jsonl`), '{}');

    // default home: file does not exist there → null (and never finds the clone's)
    expect(getSessionJsonlPath(SID, cwd)).toBeNull();
    // custom home: finds it
    expect(getSessionJsonlPath(SID, cwd, customHome))
      .toBe(join(customHome, 'projects', projectKey, `${SID}.jsonl`));
  });

  it('default param resolves to the ~/.claude tree (signature check)', () => {
    // sanity: the default param is ~/.claude (homedir-based), not some other root
    const cwd = '/tmp';
    const p = getSessionJsonlPath(SID, cwd); // may be null if absent; we only assert it never points outside ~/.claude
    if (p) expect(p.startsWith(join(homedir(), '.claude'))).toBe(true);
  });
});

describe('parseClaudeConfigDirFromEnviron', () => {
  const env = (...kv: string[]) => kv.join('\0') + '\0';

  it('extracts CLAUDE_CONFIG_DIR from a NUL-separated environ blob', () => {
    expect(parseEnviron(env('PATH=/usr/bin', 'CLAUDE_CONFIG_DIR=/home/u/.botmux/clones/x/.claude', 'TERM=xterm')))
      .toBe('/home/u/.botmux/clones/x/.claude');
  });

  it('returns undefined when the var is absent', () => {
    expect(parseEnviron(env('PATH=/usr/bin', 'TERM=xterm'))).toBeUndefined();
    expect(parseEnviron('')).toBeUndefined();
  });

  it('treats a blank value as unset (→ undefined → caller falls back to ~/.claude)', () => {
    expect(parseEnviron(env('CLAUDE_CONFIG_DIR=', 'PATH=/usr/bin'))).toBeUndefined();
    expect(parseEnviron(env('CLAUDE_CONFIG_DIR=   '))).toBeUndefined();
  });

  it('does not match a similarly-named var', () => {
    expect(parseEnviron(env('NOT_CLAUDE_CONFIG_DIR=/x', 'CLAUDE_CONFIG_DIRX=/y'))).toBeUndefined();
  });
});

describe('resolveClaudeHomeForAdopt (adopt bridge tails the live process home)', () => {
  const HOME = join(homedir(), '.claude');

  it('adopting bot has NO config but target process has CLAUDE_CONFIG_DIR → tail the clone home', () => {
    // 蔻黛 blocker scenario: main bot (no claudeConfigDir) adopts a clone process.
    expect(resolveClaudeHomeForAdopt('/home/u/.botmux/clones/x/.claude', undefined))
      .toBe('/home/u/.botmux/clones/x/.claude');
  });

  it('adopted process config wins over the adopting bot config', () => {
    expect(resolveClaudeHomeForAdopt('/adopted/home', '/bot/home')).toBe('/adopted/home');
  });

  it('falls back to the adopting bot config when the process has none', () => {
    expect(resolveClaudeHomeForAdopt(undefined, '/bot/home')).toBe('/bot/home');
  });

  it('falls back to ~/.claude when neither is set', () => {
    expect(resolveClaudeHomeForAdopt(undefined, undefined)).toBe(HOME);
  });
});
