import { describe, expect, it, afterEach } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolveClaudeHome, defaultClaudeHome, cloneHomeEnv } from '../src/core/claude-home.js';
import {
  claudeJsonlPathForSession,
  claudePidStatePath,
  resolveJsonlFromPid,
} from '../src/adapters/cli/claude-code.js';

const HOME_CLAUDE = join(homedir(), '.claude');

describe('resolveClaudeHome', () => {
  it('defaults to ~/.claude when unset/blank', () => {
    expect(defaultClaudeHome()).toBe(HOME_CLAUDE);
    expect(resolveClaudeHome()).toBe(HOME_CLAUDE);
    expect(resolveClaudeHome(undefined)).toBe(HOME_CLAUDE);
    expect(resolveClaudeHome('')).toBe(HOME_CLAUDE);
    expect(resolveClaudeHome('   ')).toBe(HOME_CLAUDE);
  });

  it('returns the configured dir when set (clone isolation)', () => {
    expect(resolveClaudeHome('/home/u/.botmux/clones/cli_x/.claude'))
      .toBe('/home/u/.botmux/clones/cli_x/.claude');
  });
});

describe('cloneHomeEnv (Round-4 B4: engine-aware spawn-env home override)', () => {
  it('claude clone → CLAUDE_CONFIG_DIR (byte-equivalent to the old injection)', () => {
    expect(cloneHomeEnv('/c/cli_x/.claude', { envVar: 'CLAUDE_CONFIG_DIR' }))
      .toEqual({ CLAUDE_CONFIG_DIR: '/c/cli_x/.claude' });
  });
  it('codex clone → CODEX_HOME', () => {
    expect(cloneHomeEnv('/c/cli_y/.codex', { envVar: 'CODEX_HOME' }))
      .toEqual({ CODEX_HOME: '/c/cli_y/.codex' });
  });
  it('coco state-only clone → XDG_CACHE_HOME (clone-scoped)', () => {
    expect(cloneHomeEnv('/c/cli_z/coco-cache', { envVar: 'XDG_CACHE_HOME' }))
      .toEqual({ XDG_CACHE_HOME: '/c/cli_z/coco-cache' });
  });
  it('non-clone bot (no clone home) → {} (inherited env, unchanged)', () => {
    expect(cloneHomeEnv(undefined, { envVar: 'CLAUDE_CONFIG_DIR' })).toEqual({});
  });
  it('engine without cloneHome capability → {} (no injection)', () => {
    expect(cloneHomeEnv('/c/cli_z/.home', undefined)).toEqual({});
  });
});

// 本体零行为变化 (zero behaviour change) regression: with NO claudeHome arg,
// every path resolver must produce the exact same ~/.claude paths as before
// the home-isolation work.
describe('claude-code path resolvers — default == ~/.claude (zero behaviour change)', () => {
  const SID = '11111111-2222-3333-4444-555555555555';

  it('claudeJsonlPathForSession default lands under ~/.claude/projects', () => {
    const p = claudeJsonlPathForSession(SID, '/tmp');
    expect(p.startsWith(join(HOME_CLAUDE, 'projects') + '/')).toBe(true);
    expect(p.endsWith(`${SID}.jsonl`)).toBe(true);
  });

  it('claudePidStatePath default === ~/.claude/sessions/<pid>.json (byte-exact)', () => {
    expect(claudePidStatePath(4242)).toBe(join(HOME_CLAUDE, 'sessions', '4242.json'));
  });
});

// Corrected 2026-06-21 (was the block-4a "unconditional clone-home routing"
// assertion — wrong direction): the current claude writes projects/ + sessions/
// under $HOME/.claude regardless of CLAUDE_CONFIG_DIR, so resolvers prefer the
// configured (clone) home only when the file is genuinely there, else fall back to
// the default. See git log / project memory for the ping-pong history.
describe('claude-code path resolvers — clone home fail-safe (present → clone, absent → default)', () => {
  const SID = '11111111-2222-3333-4444-555555555555';
  const tmps: string[] = [];
  afterEach(() => { while (tmps.length) { try { rmSync(tmps.pop()!, { recursive: true, force: true }); } catch { /* */ } } });

  it('claudePidStatePath returns the clone home when the pid-state really exists there', () => {
    const clone = mkdtempSync(join(tmpdir(), 'clonehome-'));
    tmps.push(clone);
    mkdirSync(join(clone, 'sessions'), { recursive: true });
    writeFileSync(join(clone, 'sessions', '4242.json'), '{}');
    expect(claudePidStatePath(4242, clone)).toBe(join(clone, 'sessions', '4242.json'));
  });

  it('claudePidStatePath falls back to default $HOME/.claude when absent under the clone home', () => {
    const clone = mkdtempSync(join(tmpdir(), 'clonehome-'));
    tmps.push(clone);
    expect(claudePidStatePath(4242, clone)).toBe(join(HOME_CLAUDE, 'sessions', '4242.json'));
  });

  it('claudeJsonlPathForSession falls back to default $HOME/.claude when absent under the clone home', () => {
    const clone = mkdtempSync(join(tmpdir(), 'clonehome-'));
    tmps.push(clone);
    const p = claudeJsonlPathForSession(SID, '/tmp', clone);
    expect(p.startsWith(HOME_CLAUDE)).toBe(true);
    expect(p.startsWith(clone)).toBe(false);
    expect(p.endsWith(`${SID}.jsonl`)).toBe(true);
  });
});

// The block-4a blocker: writeInput's pid-state re-resolution must read the
// clone's home, not the default ~/.claude. resolveJsonlFromPid is the shared
// resolver behind those 3 call sites.
describe('resolveJsonlFromPid honours claudeHome (writeInput pid-state isolation)', () => {
  const tmps: string[] = [];
  afterEach(() => { while (tmps.length) { try { rmSync(tmps.pop()!, { recursive: true, force: true }); } catch { /* */ } } });
  const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  // A pid number unlikely to collide with a real ~/.claude/sessions/<pid>.json.
  const FAKE_PID = 2147480000;

  it('reads pid-state from the clone home and returns its jsonl path', () => {
    const cloneHome = mkdtempSync(join(tmpdir(), 'clonehome-'));
    tmps.push(cloneHome);
    const cwd = mkdtempSync(join(tmpdir(), 'cliwcwd-'));
    tmps.push(cwd);
    mkdirSync(join(cloneHome, 'sessions'), { recursive: true });
    // No procStart → resolver falls back to cwd equality (avoids /proc dependency).
    writeFileSync(
      join(cloneHome, 'sessions', `${FAKE_PID}.json`),
      JSON.stringify({ pid: FAKE_PID, sessionId: SID, cwd }),
    );

    const resolved = resolveJsonlFromPid(FAKE_PID, cwd, cloneHome);
    expect(resolved).not.toBeNull();
    expect(resolved!.cliSessionId).toBe(SID);
    expect(resolved!.path.startsWith(join(cloneHome, 'projects') + '/')).toBe(true);

    // Same pid via the DEFAULT home must NOT resolve to the clone's transcript
    // (the pid-state lives only under the clone home).
    const viaDefault = resolveJsonlFromPid(FAKE_PID, cwd);
    if (viaDefault) expect(viaDefault.path.startsWith(cloneHome)).toBe(false);
  });
});
