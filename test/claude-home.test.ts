import { describe, expect, it, afterEach } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolveClaudeHome, defaultClaudeHome } from '../src/core/claude-home.js';
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

describe('claude-code path resolvers — custom claudeHome routes under it (clone)', () => {
  const SID = '11111111-2222-3333-4444-555555555555';
  const CLONE = '/home/u/.botmux/clones/cli_x/.claude';

  it('claudeJsonlPathForSession routes under the clone home', () => {
    const p = claudeJsonlPathForSession(SID, '/tmp', CLONE);
    expect(p.startsWith(join(CLONE, 'projects') + '/')).toBe(true);
    expect(p.endsWith(`${SID}.jsonl`)).toBe(true);
    // and must NOT leak into the default home
    expect(p.startsWith(HOME_CLAUDE)).toBe(false);
  });

  it('claudePidStatePath routes under the clone home', () => {
    expect(claudePidStatePath(4242, CLONE)).toBe(join(CLONE, 'sessions', '4242.json'));
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
