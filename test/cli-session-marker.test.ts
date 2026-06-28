/**
 * CLI session-marker：根治「subtask 汇报错群」的 sessionId 解析优先级测试。
 *
 * 优先级：--session-id flag > 进程树 marker(真值) > env BOTMUX_SESSION_ID(legacy 兜底)。
 * 核心回归点：env 残留旧值时不再被盲信——有 marker 即以 marker 为准并告警。
 *
 * Run:  pnpm vitest run test/cli-session-marker.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSessionIdWithSource, findAncestorSessionId } from '../src/cli/session-marker.js';

const ENV_KEY = 'BOTMUX_SESSION_ID';
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  vi.restoreAllMocks();
});

describe('resolveSessionIdWithSource — precedence', () => {
  it('flag wins over everything', () => {
    process.env[ENV_KEY] = 'sid_env';
    const r = resolveSessionIdWithSource('sid_flag', () => 'sid_marker');
    expect(r).toEqual({ sessionId: 'sid_flag', source: 'flag' });
  });

  it('marker wins over env when flag absent', () => {
    process.env[ENV_KEY] = 'sid_env';
    const r = resolveSessionIdWithSource(undefined, () => 'sid_marker');
    expect(r).toEqual({ sessionId: 'sid_marker', source: 'marker' });
  });

  it('mismatch marker vs env → use marker AND warn (no longer silent)', () => {
    process.env[ENV_KEY] = 'sid_stale_env';
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = resolveSessionIdWithSource(undefined, () => 'sid_true_marker');
    expect(r.sessionId).toBe('sid_true_marker');
    expect(r.source).toBe('marker');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('不一致');
  });

  it('marker == env → use marker, no warn', () => {
    process.env[ENV_KEY] = 'sid_same';
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = resolveSessionIdWithSource(undefined, () => 'sid_same');
    expect(r).toEqual({ sessionId: 'sid_same', source: 'marker' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('no marker → fall back to env (legacy compat)', () => {
    process.env[ENV_KEY] = 'sid_env';
    const r = resolveSessionIdWithSource(undefined, () => null);
    expect(r).toEqual({ sessionId: 'sid_env', source: 'env' });
  });

  it('empty/legacy marker ("") → fall back to env', () => {
    process.env[ENV_KEY] = 'sid_env';
    const r = resolveSessionIdWithSource(undefined, () => '');
    expect(r).toEqual({ sessionId: 'sid_env', source: 'env' });
  });

  it('nothing available → null / none', () => {
    const r = resolveSessionIdWithSource(undefined, () => null);
    expect(r).toEqual({ sessionId: null, source: 'none' });
  });
});

// review Blocker 2：覆盖真实 findAncestorSessionId（实际 SESSION_DATA_DIR + 真 ppid 链 + 真 marker
// 文件读取 + 默认 resolver），而不只是注入 markerResolver。
describe('findAncestorSessionId — real ppid/marker resolution', () => {
  let tmp: string;
  let savedSDD: string | undefined;
  let savedEnvSid: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sm-real-'));
    mkdirSync(join(tmp, '.botmux-cli-pids'), { recursive: true });
    savedSDD = process.env.SESSION_DATA_DIR;
    savedEnvSid = process.env.BOTMUX_SESSION_ID;
    process.env.SESSION_DATA_DIR = tmp;
    delete process.env.BOTMUX_SESSION_ID;
  });
  afterEach(() => {
    if (savedSDD === undefined) delete process.env.SESSION_DATA_DIR; else process.env.SESSION_DATA_DIR = savedSDD;
    if (savedEnvSid === undefined) delete process.env.BOTMUX_SESSION_ID; else process.env.BOTMUX_SESSION_ID = savedEnvSid;
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('沿真实 process.ppid 命中 marker 文件并读出 sessionId', () => {
    writeFileSync(join(tmp, '.botmux-cli-pids', String(process.ppid)), 'sid_real_marker');
    expect(findAncestorSessionId()).toBe('sid_real_marker');
  });

  it('默认 resolver 走真实 marker，且 marker 覆盖 stale env', () => {
    writeFileSync(join(tmp, '.botmux-cli-pids', String(process.ppid)), 'sid_true');
    process.env.BOTMUX_SESSION_ID = 'sid_stale_env';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(resolveSessionIdWithSource()).toEqual({ sessionId: 'sid_true', source: 'marker' });
  });

  it('marker 写在祖父 pid 上 → 经一次真实 `ps -o ppid=` 跳转后命中（覆盖 ps walk）', () => {
    let grandparent = '';
    try { grandparent = execSync(`ps -o ppid= -p ${process.ppid}`, { encoding: 'utf-8' }).trim(); } catch { /* skip */ }
    if (!grandparent || !/^\d+$/.test(grandparent) || Number(grandparent) <= 1) return; // 环境无祖父则跳过
    writeFileSync(join(tmp, '.botmux-cli-pids', grandparent), 'sid_grandparent');
    expect(findAncestorSessionId()).toBe('sid_grandparent');
  });

  it('祖先链都无 marker → null', () => {
    expect(findAncestorSessionId()).toBeNull();
  });
});
