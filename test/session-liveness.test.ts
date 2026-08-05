/**
 * 病二回归 (2026-08-05): 投递写进聋会话。
 *
 * 真实故障: daemon 路由只看 activeSessions 里有没有记录, 有就一律 Reply 进去,
 * 从不校验背后 worker/CLI 进程死没死 → daemon 重启恢复了会话记录但 worker/pid
 * 已死时, 消息全写进黑洞 (卡片进群没人接, 实测连投 3 次白等近 1 小时)。
 *
 * isSessionLive 是复用前的探活闸门。这里断言它的两条判据 (owner 特别要求):
 *  ① 有 worker 句柄: 以句柄为准 (killed / exited 判死), 天然挡 PID 复用。
 *  ② 无句柄: process.kill(pid,0) errno 分支 —— EPERM 判活 (进程在只是无权),
 *     ESRCH 判死, 只认"进程确实没了"。
 *
 * Run:  pnpm vitest run test/session-liveness.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';

vi.mock('../src/config.js', () => ({
  config: { get session() { return { dataDir: '/tmp/liveness-test' }; } },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

import { isSessionLive } from '../src/core/worker-pool.js';

/** 构造一个只填 isSessionLive 关心字段的最小 DaemonSession。 */
function mkSession(opts: { worker?: any; pid?: number | null }): DaemonSession {
  return {
    worker: opts.worker ?? null,
    session: { pid: opts.pid ?? null },
  } as unknown as DaemonSession;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('病二 · isSessionLive ① 有 worker 句柄 (句柄权威, 挡 PID 复用)', () => {
  it('活着的 worker (未 kill、未退出) → true', () => {
    expect(isSessionLive(mkSession({ worker: { killed: false, exitCode: null, signalCode: null } }))).toBe(true);
  });

  it('被我们 kill 过的 worker (killed=true) → false', () => {
    expect(isSessionLive(mkSession({ worker: { killed: true, exitCode: null, signalCode: null } }))).toBe(false);
  });

  it('自己崩了的 worker (exitCode 非 null) → false', () => {
    expect(isSessionLive(mkSession({ worker: { killed: false, exitCode: 1, signalCode: null } }))).toBe(false);
  });

  it('被信号杀掉的 worker (signalCode 非 null) → false', () => {
    expect(isSessionLive(mkSession({ worker: { killed: false, exitCode: null, signalCode: 'SIGKILL' } }))).toBe(false);
  });

  it('有句柄时即使 pid 被复用也不误判: 死句柄 + 一个真实存活 pid → 仍 false', () => {
    // 关键: 有句柄就以句柄为准, 根本不去查 pid → PID 复用无从误导。
    const spy = vi.spyOn(process, 'kill');
    expect(isSessionLive(mkSession({ worker: { killed: true, exitCode: null, signalCode: null }, pid: process.pid }))).toBe(false);
    expect(spy).not.toHaveBeenCalled(); // 证明有句柄时没走 pid 分支
  });
});

describe('病二 · isSessionLive ② 无 worker 句柄 (退回 pid errno 分支)', () => {
  it('无句柄 + 进程真实存在 (用本进程 pid) → true', () => {
    expect(isSessionLive(mkSession({ worker: null, pid: process.pid }))).toBe(true);
  });

  it('无句柄 + 进程不存在 (ESRCH) → false', () => {
    // 一个几乎不可能存在的 pid
    expect(isSessionLive(mkSession({ worker: null, pid: 2 ** 30 }))).toBe(false);
  });

  it('无句柄 + process.kill 抛 EPERM → 判活 (进程在、只是无权发信号)', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const e: NodeJS.ErrnoException = new Error('operation not permitted');
      e.code = 'EPERM';
      throw e;
    });
    expect(isSessionLive(mkSession({ worker: null, pid: 4242 }))).toBe(true);
  });

  it('无句柄 + 无 pid → false', () => {
    expect(isSessionLive(mkSession({ worker: null, pid: null }))).toBe(false);
  });
});
