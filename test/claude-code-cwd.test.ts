/**
 * Tests for symlink-aware cwd handling in the Claude Code adapter.
 *
 * Real bug: when botmux's `workingDir` is a symlink (e.g. /home/x →
 * /data00/home/x), Claude Code itself realpath's its cwd via getcwd(3)
 * before computing the project hash, so its on-disk JSONL lands under
 * `~/.claude/projects/-data00-home-x/`. botmux historically used the raw
 * symlink path, so its bridge watcher tailed `~/.claude/projects/-home-x/`,
 * which doesn't exist — and submit-confirm + the no-`botmux send` fallback
 * both silently broke.
 *
 * Run:  pnpm vitest run test/claude-code-cwd.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { claudeJsonlPathForSession } from '../src/adapters/cli/claude-code.js';

const SID = '01234567-89ab-cdef-0123-456789abcdef';

let tmpRoot: string;
let realDir: string;
let symDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'bmx-cwd-'));
  realDir = join(tmpRoot, 'real-target');
  symDir = join(tmpRoot, 'sym-link');
  mkdirSync(realDir);
  symlinkSync(realDir, symDir);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function expectedProjectFor(cwd: string): string {
  const projectHash = cwd.replace(/[^A-Za-z0-9-]/g, '-');
  return join(homedir(), '.claude', 'projects', projectHash, `${SID}.jsonl`);
}

describe('claudeJsonlPathForSession: symlink-aware cwd resolution', () => {
  it('returns the realpath-derived path when cwd is a symlink', () => {
    const got = claudeJsonlPathForSession(SID, symDir);
    // Claude Code itself runs under realpath(symDir) === realDir; the JSONL
    // lives in the project dir derived from realDir, NOT symDir.
    expect(got).toBe(expectedProjectFor(realDir));
    // Sanity: the would-be naive path (treating symDir literally) is different,
    // proving the test actually exercised symlink resolution.
    expect(got).not.toBe(expectedProjectFor(symDir));
  });

  it('is idempotent when cwd is already a real path', () => {
    const got = claudeJsonlPathForSession(SID, realDir);
    expect(got).toBe(expectedProjectFor(realDir));
  });

  it('falls back to the raw cwd when realpath fails (path does not exist)', () => {
    // realpathSync throws on a non-existent path. The helper catches and
    // returns the raw cwd so an upstream existsSync check can still surface
    // a meaningful "no such directory" error rather than masking it as a
    // path-resolution failure here.
    const ghost = join(tmpRoot, 'never-existed');
    const got = claudeJsonlPathForSession(SID, ghost);
    expect(got).toBe(expectedProjectFor(ghost));
  });
});

/**
 * Regression (2026-06-21): clones launched with CLAUDE_CONFIG_DIR=<clone>/.claude
 * still get their transcripts written to $HOME/.claude/projects by claude (it does
 * NOT relocate projects/ to CLAUDE_CONFIG_DIR). The worker threaded the clone's
 * configured home into the resolver, so it pointed at an always-empty dir →
 * confirmSubmit/bridge never found the turn → every inbound message false-warned
 * "没能确认提交 / 卡输入框". Fix: resolve fail-safe — prefer the configured home if
 * the file is really there, else fall back to the default $HOME/.claude.
 */
describe('claudeJsonlPathForSession: clone-home fail-safe → default $HOME/.claude', () => {
  it('falls back to default $HOME/.claude when the file is absent under the configured (clone) home', () => {
    const cloneHome = join(tmpRoot, 'clone-config', '.claude');
    mkdirSync(cloneHome, { recursive: true });
    // No transcript under the clone home → must return the default-home path
    // (where the current claude actually writes), NOT the clone-home path.
    const got = claudeJsonlPathForSession(SID, realDir, cloneHome);
    expect(got).toBe(expectedProjectFor(realDir));
    expect(got.startsWith(cloneHome)).toBe(false);
  });

  it('prefers the configured (clone) home when the transcript really exists there', () => {
    const cloneHome = join(tmpRoot, 'clone-config2', '.claude');
    const projectHash = realDir.replace(/[^A-Za-z0-9-]/g, '-');
    const cloneProjectDir = join(cloneHome, 'projects', projectHash);
    mkdirSync(cloneProjectDir, { recursive: true });
    const cloneJsonl = join(cloneProjectDir, `${SID}.jsonl`);
    writeFileSync(cloneJsonl, '');
    // A future/other claude that DOES honor CLAUDE_CONFIG_DIR → use that file.
    const got = claudeJsonlPathForSession(SID, realDir, cloneHome);
    expect(got).toBe(cloneJsonl);
  });
});
