/**
 * P1 commit #7 — CLI `botmux subtask-create` tests (CL-1~6).
 *
 * Tests cover arg parsing + IPC client behavior + the architecture
 * contract (CLI does NOT import service-layer modules).
 *
 * Run:  pnpm vitest run test/cli-subtask-create.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fakeHome: string;
let registryDir: string;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => fakeHome };
});

// Capture process.exit so tests don't actually exit
const exitCode = { value: 0 as number };
const origExit = process.exit;
beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'cli-st-home-'));
  registryDir = join(fakeHome, '.botmux', 'data', 'dashboard-daemons');
  mkdirSync(registryDir, { recursive: true });
  exitCode.value = 0;
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode.value = code ?? 0;
    throw new Error('__EXIT__');   // unwind execution but lets caller catch
  }) as any);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  delete process.env.BOTMUX_SESSION_ID;
});
afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete process.env.BOTMUX_SESSION_ID;
  (process as any).exit = origExit;
});

function writeClaudeDaemon(port: number, opts: { stale?: boolean } = {}): void {
  const heartbeat = opts.stale ? Date.now() - 120_000 : Date.now();
  writeFileSync(
    join(registryDir, 'cli_a9771799e8bb5bc3.json'),
    JSON.stringify({
      larkAppId: 'cli_a9771799e8bb5bc3',
      botName: '克劳德',
      botIndex: 0,
      ipcPort: port,
      pid: 1234,
      startedAt: Date.now() - 60_000,
      lastHeartbeat: heartbeat,
    }), 'utf-8',
  );
}

async function runCmd(argv: string[]): Promise<void> {
  // Import fresh each test so node:os mock takes effect with new fakeHome
  vi.resetModules();
  const { cmdSubtaskCreate } = await import('../src/cli/subtask-create.js');
  try {
    await cmdSubtaskCreate(argv);
  } catch (err: any) {
    if (err.message !== '__EXIT__') throw err;
  }
}

describe('cli subtask-create (P1 commit #7)', () => {
  describe('CL-1 — missing session id', () => {
    it('exit 2 when both --session-id flag and BOTMUX_SESSION_ID env are missing', async () => {
      await runCmd(['--purpose', 'x', '--task-type', 'misc']);
      expect(exitCode.value).toBe(2);
    });
  });

  describe('CL-1b — env injection path', () => {
    it('env BOTMUX_SESSION_ID supplies sessionId when flag is missing', async () => {
      process.env.BOTMUX_SESSION_ID = 'sid_from_env';
      writeClaudeDaemon(9999);  // mock daemon registered but won't respond
      // fetch will fail (no real daemon) → exit 1 (daemon connection error).
      // Important: NOT exit 2 (which would mean session id missing).
      await runCmd(['--purpose', 'x', '--task-type', 'misc']);
      expect(exitCode.value).toBe(1);
    });
  });

  describe('CL-2 — happy path POSTs IPC body', () => {
    it('reaches the daemon port + posts SpawnSubTaskRequest body', async () => {
      writeClaudeDaemon(9998);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        new Response(JSON.stringify({ ok: true, chatId: 'oc_new', isNew: true }), { status: 200 }),
      );
      await runCmd(['--session-id', 'sid_real', '--purpose', 'analyse PRD', '--task-type', 'prd']);
      expect(fetchSpy).toHaveBeenCalledOnce();
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toBe('http://127.0.0.1:9998/api/spawn-subtask');
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body.sessionId).toBe('sid_real');
      expect(body.purpose).toBe('analyse PRD');
      expect(body.taskType).toBe('prd');
      expect(exitCode.value).toBe(0);
    });
  });

  describe('CL-3 — daemon returns isNew=false (idempotency cache hit)', () => {
    it('CLI exits 0 + relays JSON', async () => {
      writeClaudeDaemon(9997);
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        new Response(JSON.stringify({ ok: true, chatId: 'oc_existing', isNew: false }), { status: 200 }),
      );
      const logSpy = vi.spyOn(console, 'log');
      await runCmd(['--session-id', 'sid', '--purpose', 'x', '--task-type', 'misc']);
      expect(exitCode.value).toBe(0);
      const out = logSpy.mock.calls.map(c => c[0]).join('');
      expect(out).toContain('"isNew":false');
    });
  });

  describe('CL-4 — daemon 403 (not main topic)', () => {
    it('CLI exits 1 when daemon returns ok=false', async () => {
      writeClaudeDaemon(9996);
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        new Response(
          JSON.stringify({ ok: false, error: 'spawnSubTask only allowed from main topic chat' }),
          { status: 403 },
        ),
      );
      await runCmd(['--session-id', 'sid_wrongchat', '--purpose', 'x', '--task-type', 'misc']);
      expect(exitCode.value).toBe(1);
    });
  });

  describe('CL-5 — architecture contract: CLI does NOT import service modules', () => {
    it('cli/subtask-create.ts source has no import of service-layer modules', () => {
      const src = readFileSync(
        join(__dirname, '..', 'src', 'cli', 'subtask-create.ts'),
        'utf-8',
      );
      // Type-only imports (with `import type`) are erased at runtime, so
      // they're allowed (no real coupling). Verify only RUNTIME imports.
      const runtimeImportLines = src
        .split('\n')
        .filter(l => /^import\b/.test(l.trim()) && !/^import\s+type\b/.test(l.trim()));
      for (const forbidden of [
        'spawn-idempotency-store',
        'group-creator',
        'main-bot-playbook',
      ]) {
        for (const line of runtimeImportLines) {
          expect(line).not.toContain(forbidden);
        }
      }
    });
  });

  describe('CL-6 — daemon registry missing → exit 1 with clear error', () => {
    it('exit 1 when no Claude daemon is registered', async () => {
      // registryDir created but empty
      await runCmd(['--session-id', 'sid', '--purpose', 'x', '--task-type', 'misc']);
      expect(exitCode.value).toBe(1);
    });

    it('exit 1 when Claude daemon heartbeat is stale (> 90s)', async () => {
      writeClaudeDaemon(9995, { stale: true });
      await runCmd(['--session-id', 'sid', '--purpose', 'x', '--task-type', 'misc']);
      expect(exitCode.value).toBe(1);
    });
  });

  describe('CL-extra — invalid --task-type', () => {
    it('exit 2 when --task-type is not prd|bug|misc', async () => {
      await runCmd(['--session-id', 'sid', '--purpose', 'x', '--task-type', 'invalid']);
      expect(exitCode.value).toBe(2);
    });
  });

  describe('CL-extra — --bots resolution', () => {
    it('--bots c,k,t resolved to claude/codex/tilly in posted body', async () => {
      writeClaudeDaemon(9994);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        new Response(JSON.stringify({ ok: true, chatId: 'oc', isNew: true }), { status: 200 }),
      );
      await runCmd([
        '--session-id', 'sid',
        '--purpose', 'x',
        '--task-type', 'misc',
        '--bots', 'c,k,t',
      ]);
      const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      expect(body.bots).toEqual(['claude', 'codex', 'tilly']);
    });
  });
});
