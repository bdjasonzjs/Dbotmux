import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fakeHome: string;
let dataDir: string;
let registryDir: string;
// session-marker 解析会读 SESSION_DATA_DIR 去进程树找 marker；测试里隔离到空的 fakeHome，
// 否则会捞到真实运行环境的 marker，破坏 env/flag 这几条用例的 hermetic 性。
const ORIG_SESSION_DATA_DIR = process.env.SESSION_DATA_DIR;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => fakeHome };
});

const exitCode = { value: 0 as number };
const origExit = process.exit;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'cli-orch-home-'));
  dataDir = join(fakeHome, '.botmux', 'data');
  registryDir = join(dataDir, 'dashboard-daemons');
  mkdirSync(registryDir, { recursive: true });
  process.env.SESSION_DATA_DIR = dataDir; // 空 → 无 marker → 隔离进程树 marker 解析
  exitCode.value = 0;
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode.value = code ?? 0;
    throw new Error('__EXIT__');
  }) as any);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_SUBTASK_DAEMON_APP_ID;
  delete process.env.LARK_APP_ID;
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_SUBTASK_DAEMON_APP_ID;
  delete process.env.LARK_APP_ID;
  if (ORIG_SESSION_DATA_DIR === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = ORIG_SESSION_DATA_DIR;
  (process as any).exit = origExit;
});

function writeDaemon(appId: string, botName: string, port: number): void {
  writeFileSync(
    join(registryDir, `${appId}.json`),
    JSON.stringify({
      larkAppId: appId,
      botName,
      ipcPort: port,
      lastHeartbeat: Date.now(),
    }),
    'utf-8',
  );
}

function writeSession(appId: string, session: Record<string, unknown>): void {
  writeFileSync(
    join(dataDir, `sessions-${appId}.json`),
    JSON.stringify([session]),
    'utf-8',
  );
}

async function runCmd(verb: string, argv: string[]): Promise<void> {
  vi.resetModules();
  const { cmdSubtaskOrch } = await import('../src/cli/subtask-orch.js');
  try {
    await cmdSubtaskOrch(verb, argv);
  } catch (err: any) {
    if (err.message !== '__EXIT__') throw err;
  }
}

describe('cli subtask-orch', () => {
  it('selects the daemon that owns --session-id and preserves bot ref roles', async () => {
    writeDaemon('app_claude', '克劳德', 9101);
    writeDaemon('app_codex', '蔻黛克斯', 9102);
    writeSession('app_codex', {
      sessionId: 'sid_codex',
      chatId: 'oc_codex_root',
      rootMessageId: 'om_root',
      larkAppId: 'app_codex',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ ok: true, taskId: 'st_1', chatId: 'oc_child' }), { status: 200 }),
    );

    await runCmd('start', [
      '--session-id', 'sid_codex',
      '--goal', 'x',
      '--bots', 'k:main,c:collab,t:observer,蔻黛克斯（初号机）:collab',
    ]);

    expect(exitCode.value).toBe(0);
    expect(fetchSpy.mock.calls[0][0]).toBe('http://127.0.0.1:9102/api/subtask-orch-create');
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.bots).toEqual(['k:main', 'c:collab', 't:observer', '蔻黛克斯（初号机）:collab']);
  });

  it('passes --dry-run to subtask-start and renders the pre-create preview', async () => {
    writeDaemon('app_codex', '蔻黛克斯', 9102);
    writeSession('app_codex', {
      sessionId: 'sid_codex',
      chatId: 'oc_codex_root',
      rootMessageId: 'om_root',
      larkAppId: 'app_codex',
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({
        ok: true,
        dryRun: true,
        preview: {
          name: '子任务·dry',
          taskType: 'bug',
          worktree: '/repo',
          seats: [
            { role: 'main', cloneName: '蔻黛克斯', engine: 'codex', larkAppId: 'app_codex' },
            { role: 'collab', cloneName: '蔻黛克斯初号机', engine: 'codex', larkAppId: 'app_codex_1' },
          ],
        },
      }), { status: 200 }),
    );
    const logSpy = vi.spyOn(console, 'log');

    await runCmd('start', ['--session-id', 'sid_codex', '--goal', 'dry', '--task-type', 'bug', '--dry-run']);

    expect(exitCode.value).toBe(0);
    const body = JSON.parse((vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.dryRun).toBe(true);
    const out = String(logSpy.mock.calls[0][0]);
    expect(out).toContain('botmux subtask-start --dry-run 预览');
    expect(out).toContain('main = 蔻黛克斯(codex) 执行 [app_codex]');
    expect(out).toContain('collab = 蔻黛克斯初号机(codex) review [app_codex_1]');
    expect(out).toContain('不建群、不写 SubTask/ChatContext/Topology');
  });

  it('adds explicit stale-env diagnostics when daemon rejects an env session', async () => {
    writeDaemon('app_codex', '蔻黛克斯', 9102);
    writeSession('app_codex', {
      sessionId: 'sid_stale',
      chatId: 'oc_old',
      rootMessageId: 'om_old',
      larkAppId: 'app_codex',
    });
    process.env.BOTMUX_SESSION_ID = 'sid_stale';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ ok: false, error: 'request_review must come from the subtask chat' }), { status: 403 }),
    );
    const logSpy = vi.spyOn(console, 'log');

    await runCmd('request-review', ['--task-id', 'st_1', '--summary', '/tmp/review.md']);

    expect(exitCode.value).toBe(1);
    const out = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(out.diagnostic).toContain('session came from BOTMUX_SESSION_ID');
    expect(out.diagnostic).toContain('session=sid_stale chat=oc_old app=app_codex daemon=蔻黛克斯');
  });

  it('fails fast when the session owner app has no fresh daemon', async () => {
    writeDaemon('app_claude', '克劳德', 9101);
    writeSession('app_codex', {
      sessionId: 'sid_codex',
      chatId: 'oc_codex_root',
      rootMessageId: 'om_root',
      larkAppId: 'app_codex',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const logSpy = vi.spyOn(console, 'log');

    await runCmd('start', ['--session-id', 'sid_codex', '--goal', 'x']);

    expect(exitCode.value).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    const out = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(out.ok).toBe(false);
    expect(out.error).toContain('no fresh daemon for that app');
    expect(out.diagnostic).toContain('app=app_codex');
    expect(out.diagnostic).toContain('克劳德/app_claude');
  });
});
