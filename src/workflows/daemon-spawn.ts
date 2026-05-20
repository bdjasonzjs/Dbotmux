/**
 * Daemon-backed `WorkerSpawnFn` implementation.
 *
 * Forks `worker.js` for a single workflow step, sends the prompt via
 * the `init` IPC, and resolves with the agent's final transcript when
 * the worker emits `final_output` and quiesces.
 *
 * Why not reuse `forkWorker` from `core/worker-pool.ts`: that path is
 * tightly coupled to chat / card / streaming state (DaemonSession,
 * dashboardEventBus, sessionStore writes).  Workflow steps don't have
 * a real chat to bind to — we mint a synthetic chatId / rootMessageId
 * and ignore the worker's chat-side side effects (streaming card POST,
 * screenshot uploads).  The bot's real `larkAppId / larkAppSecret`
 * still flow through so the CLI adapter's environment matches a real
 * spawn.
 *
 * The `WorkerProcessFactory` indirection keeps the module unit-testable:
 * tests inject a scripted process that emits canned IPC frames, real
 * code injects `forkWorkerJs` (defined below).
 */

import { fork, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  DaemonRunOneShotInput,
  DaemonRunOneShotResult,
  DaemonSpawnDeps,
} from './spawn-bot.js';
import { logger } from '../utils/logger.js';

// ─── IPC payloads (subset of WorkerToDaemon we care about) ────────────────

type WorkerEvent =
  | { type: 'ready'; port: number; token: string }
  | {
      type: 'final_output';
      content: string;
      lastUuid: string;
      turnId: string;
      kind?: 'bridge' | 'local-turn' | 'local-turn-headless';
      userText?: string;
    }
  | {
      type: 'screen_update';
      content: string;
      status: 'working' | 'idle' | 'analyzing';
    }
  | { type: 'prompt_ready' }
  | { type: 'claude_exit'; code: number | null; signal: string | null }
  | { type: 'error'; message: string };

// ─── Worker process abstraction (factory + handle) ────────────────────────

export interface WorkerHandle {
  send(msg: unknown): void;
  on(event: 'message', cb: (msg: WorkerEvent) => void): void;
  on(event: 'exit', cb: (code: number | null) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals): void;
  readonly pid?: number;
  readonly stdout?: NodeJS.ReadableStream | null;
  readonly stderr?: NodeJS.ReadableStream | null;
}

export interface WorkerProcessFactory {
  spawn(opts: WorkerSpawnOptions): WorkerHandle;
}

export type WorkerSpawnOptions = {
  workerPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
};

/** Default factory: real `node:child_process.fork` against `worker.js`. */
export const forkWorkerJsFactory: WorkerProcessFactory = {
  spawn(opts) {
    const child: ChildProcess = fork(opts.workerPath, [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      cwd: opts.cwd,
      env: opts.env,
    });
    return {
      send: (m) => child.send(m as never),
      on: (event: string, cb: (...args: unknown[]) => void) => {
        child.on(event as never, cb);
      },
      kill: (sig) => {
        if (!child.killed) child.kill(sig);
      },
      get pid() {
        return child.pid;
      },
      get stdout() {
        return child.stdout;
      },
      get stderr() {
        return child.stderr;
      },
    } as WorkerHandle;
  },
};

// ─── Deps for the factory ────────────────────────────────────────────────

export type WorkflowDaemonSpawnDeps = {
  /** Real workers need access to bot credentials per step. */
  resolveLarkCredentials(botName: string): {
    larkAppId: string;
    larkAppSecret: string;
  };
  /** Override worker.js path (tests).  Default: `<dist>/worker.js`. */
  workerPath?: string;
  /** Override process factory (tests). */
  factory?: WorkerProcessFactory;
  /**
   * Override how long we wait for the worker's first final_output after
   * init.  Defaults to 5 minutes — long enough for typical agent steps
   * with tool use.  Workflow `node.timeoutMs` overrides on a per-step
   * basis.
   */
  defaultTimeoutMs?: number;
  /**
   * After we receive `final_output` we wait `quiesceMs` before resolving,
   * in case the worker emits additional turns (multi-step agent loops).
   * Tests can shrink this.  Default 800 ms.
   */
  quiesceMs?: number;
};

export function createWorkflowDaemonSpawn(
  deps: WorkflowDaemonSpawnDeps,
): DaemonSpawnDeps {
  const factory = deps.factory ?? forkWorkerJsFactory;
  const workerPath = deps.workerPath ?? defaultWorkerPath();
  const defaultTimeoutMs = deps.defaultTimeoutMs ?? 5 * 60 * 1000;
  const quiesceMs = deps.quiesceMs ?? 800;

  return {
    runOneShot: (input) =>
      runOneShotImpl(input, {
        factory,
        workerPath,
        defaultTimeoutMs,
        quiesceMs,
        resolveLarkCredentials: deps.resolveLarkCredentials,
      }),
  };
}

// ─── Default worker.js path ──────────────────────────────────────────────

function defaultWorkerPath(): string {
  // This module typically runs from `dist/workflows/daemon-spawn.js`;
  // worker.js lives next to dist root, i.e. `<dist>/worker.js`.
  // When running from source via ts-node etc., fall back to `src/worker.ts`
  // (the factory is meant for production; tests should override).
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, '..', 'worker.js');
  if (existsSync(candidate)) return candidate;
  return join(here, '..', '..', 'src', 'worker.ts');
}

// ─── runOneShot core ─────────────────────────────────────────────────────

type RunOneShotInternalDeps = {
  factory: WorkerProcessFactory;
  workerPath: string;
  defaultTimeoutMs: number;
  quiesceMs: number;
  resolveLarkCredentials: WorkflowDaemonSpawnDeps['resolveLarkCredentials'];
};

async function runOneShotImpl(
  input: DaemonRunOneShotInput,
  deps: RunOneShotInternalDeps,
): Promise<DaemonRunOneShotResult> {
  logOneShotMemory(input, 'enter');
  const creds = deps.resolveLarkCredentials(input.botName);
  logOneShotMemory(input, 'after-resolve-credentials');
  const startedAt = Date.now();
  const synthetic = syntheticIds(input);
  logOneShotMemory(input, 'after-synthetic-ids');
  const cwd = expandWorkflowWorkingDir(input.workingDir) ?? process.cwd();
  appendAttemptLog(input, 'system', `starting workflow worker cwd=${cwd}`);

  logOneShotMemory(input, 'before-worker-spawn');
  const worker = deps.factory.spawn({
    workerPath: deps.workerPath,
    cwd,
    env: {
      ...process.env,
      // Marker so the CLI session / skill detect a workflow-issued worker.
      BOTMUX_WORKFLOW: '1',
      BOTMUX_WORKFLOW_RUN_ID: input.runId,
      BOTMUX_WORKFLOW_NODE_ID: input.nodeId,
    },
  });
  logOneShotMemory(input, `after-worker-spawn pid=${worker.pid ?? 'unknown'}`);
  appendAttemptLog(input, 'system', `worker spawned pid=${worker.pid ?? 'unknown'}`);
  drainWorkerDiagnostics(worker, input);
  logOneShotMemory(input, 'after-drain-diagnostics');

  let webPort: number | undefined;
  const collectedOutputs: Array<{ content: string; turnId: string }> = [];
  let quiesceTimer: NodeJS.Timeout | undefined;
  const cliId = input.botSnapshot?.cliId ?? 'claude-code';

  const init = {
    type: 'init' as const,
    sessionId: synthetic.sessionId,
    chatId: synthetic.chatId,
    rootMessageId: synthetic.rootMessageId,
    workingDir: cwd,
    cliId,
    backendType: 'pty' as const,
    prompt: input.prompt,
    resume: false,
    larkAppId: creds.larkAppId,
    larkAppSecret: creds.larkAppSecret,
    botName: input.botName,
    locale: 'zh' as const,
  };
  logOneShotMemory(input, 'after-init-object');

  return new Promise<DaemonRunOneShotResult>((resolve, reject) => {
    let settled = false;
    const timeoutMs = input.timeoutMs ?? deps.defaultTimeoutMs;
    const hardDeadline = setTimeout(() => {
      fail(new Error(`workflow worker timeout after ${timeoutMs} ms`));
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(hardDeadline);
      if (quiesceTimer) clearTimeout(quiesceTimer);
      try {
        worker.send({ type: 'close' });
      } catch {
        /* worker may already be gone */
      }
      // Give close a moment to land before SIGTERM.
      setTimeout(() => worker.kill('SIGTERM'), 250);
    };

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const finish = (): void => {
      if (settled) return;
      cleanup();
      const last = collectedOutputs[collectedOutputs.length - 1];
      if (!last) {
        fail(new Error('workflow worker quiesced without final_output'));
        return;
      }
      settled = true;
      resolve({
        finalTranscript: last.content,
        session: {
          sessionId: synthetic.sessionId,
          larkAppId: creds.larkAppId,
          botName: input.botName,
          cliId,
          workingDir: cwd,
          webPort,
          logPath: input.attemptLogPath,
          startedAt,
          endedAt: Date.now(),
        },
      });
    };

    const armQuiesce = (): void => {
      if (quiesceTimer) clearTimeout(quiesceTimer);
      quiesceTimer = setTimeout(finish, deps.quiesceMs);
    };

    worker.on('message', (event) => {
      switch (event.type) {
        case 'ready':
          if (settled) break;
          webPort = event.port;
          appendAttemptLog(input, 'system', `worker ready port=${event.port}`);
          logOneShotMemory(input, 'worker-ready-before-init-send');
          try {
            worker.send(init);
            logOneShotMemory(input, 'worker-ready-after-init-send');
          } catch (err) {
            fail(err instanceof Error ? err : new Error(String(err)));
          }
          // Note: init may already have been sent by tests' scripted
          // factory before 'ready' lands.  Re-sending is a no-op
          // because `lastInitConfig` short-circuits.
          break;
        case 'final_output':
          if (settled) break;
          appendAttemptLog(input, `final_output:${event.turnId}`, event.content);
          collectedOutputs.push({
            content: event.content,
            turnId: event.turnId,
          });
          armQuiesce();
          break;
        case 'screen_update':
          if (event.status === 'idle' && collectedOutputs.length > 0) {
            armQuiesce();
          }
          break;
        case 'prompt_ready':
          if (collectedOutputs.length > 0) armQuiesce();
          break;
        case 'error':
          appendAttemptLog(input, 'error', event.message);
          fail(new Error(`worker error: ${event.message}`));
          break;
        case 'claude_exit':
          appendAttemptLog(
            input,
            'system',
            `CLI exited code=${event.code ?? 'null'} signal=${event.signal ?? 'null'}`,
          );
          if (collectedOutputs.length > 0) {
            finish();
          } else {
            fail(
              new Error(
                `CLI exited (code=${event.code ?? 'null'}, signal=${event.signal ?? 'null'}) before producing final_output`,
              ),
            );
          }
          break;
      }
    });

    worker.on('error', (err) => {
      appendAttemptLog(input, 'error', err.message);
      fail(err);
    });

    worker.on('exit', (code) => {
      appendAttemptLog(input, 'system', `worker process exit code=${code ?? 'null'}`);
      // If we already resolved, the cleanup() already killed the worker;
      // ignore the exit.  If we're still waiting for output, treat as fail.
      if (!settled && collectedOutputs.length === 0) {
        fail(
          new Error(
            `worker exited (code=${code ?? 'null'}) before producing final_output`,
          ),
        );
      }
    });

    // Some workers send 'init' eagerly without waiting for 'ready' — for
    // tests we send right away.  Real worker.js requires us to wait for
    // 'ready' (it allocates a port first), but it also short-circuits a
    // double `init`, so a redundant send is harmless.
    try {
      logOneShotMemory(input, 'before-eager-init-send');
      worker.send(init);
      logOneShotMemory(input, 'after-eager-init-send');
    } catch {
      /* worker may not be ready yet — wait for 'ready' to retry */
      logOneShotMemory(input, 'eager-init-send-failed');
    }
  });
}

function logOneShotMemory(input: DaemonRunOneShotInput, phase: string): void {
  const usage = process.memoryUsage();
  const external = usage.external ?? 0;
  const nativeOther = Math.max(0, usage.rss - usage.heapTotal - external);
  logger.info(
    `[workflow:${input.runId}:${input.nodeId}:spawn-mem] ` +
    `phase=${phase} ` +
    `rss=${formatMiB(usage.rss)} ` +
    `heapUsed=${formatMiB(usage.heapUsed)} ` +
    `heapTotal=${formatMiB(usage.heapTotal)} ` +
    `external=${formatMiB(external)} ` +
    `arrayBuffers=${formatMiB(usage.arrayBuffers ?? 0)} ` +
    `nativeOther~=${formatMiB(nativeOther)} ` +
    `promptBytes=${Buffer.byteLength(input.prompt, 'utf-8')} ` +
    `cwd=${expandWorkflowWorkingDir(input.workingDir) ?? process.cwd()}`,
  );
}

export function expandWorkflowWorkingDir(workingDir: string | undefined): string | undefined {
  if (!workingDir) return undefined;
  if (workingDir === '~') return homedir();
  if (workingDir.startsWith('~/')) return join(homedir(), workingDir.slice(2));
  return workingDir;
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MiB`;
}

function drainWorkerDiagnostics(worker: WorkerHandle, input: DaemonRunOneShotInput): void {
  const { runId, nodeId } = input;
  const prefix = `[workflow:${runId}:${nodeId}:worker]`;
  worker.stdout?.on?.('data', (data: Buffer | string) => {
    for (const line of String(data).split('\n')) {
      const trimmed = line.trim();
      if (trimmed) logger.info(`${prefix}:out ${truncateLogLine(trimmed)}`);
    }
    appendAttemptLog(input, 'stdout', String(data));
  });
  worker.stderr?.on?.('data', (data: Buffer | string) => {
    for (const line of String(data).split('\n')) {
      const trimmed = line.trim();
      if (trimmed) logger.info(`${prefix}:err ${truncateLogLine(trimmed)}`);
    }
    appendAttemptLog(input, 'stderr', String(data));
  });
}

function appendAttemptLog(
  input: Pick<DaemonRunOneShotInput, 'attemptLogPath'>,
  channel: string,
  chunk: string,
): void {
  if (!input.attemptLogPath) return;
  const ts = new Date().toISOString();
  const text = chunk.endsWith('\n') ? chunk : `${chunk}\n`;
  const lines = text.replace(/\r/g, '').split('\n');
  let out = '';
  for (const line of lines) {
    if (line === '') continue;
    out += `[${ts}] ${channel} ${line}\n`;
  }
  if (!out) return;
  try {
    appendFileSync(input.attemptLogPath, out, 'utf-8');
  } catch (err) {
    logger.warn(
      `failed to append workflow attempt log ${input.attemptLogPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function truncateLogLine(line: string): string {
  return line.length > 2000 ? `${line.slice(0, 2000)}…[truncated]` : line;
}

function syntheticIds(input: DaemonRunOneShotInput): {
  sessionId: string;
  chatId: string;
  rootMessageId: string;
} {
  return {
    sessionId: `wf-${input.runId}-${input.activityId}-${input.attemptId}`,
    chatId: `wf-chat-${input.runId}`,
    rootMessageId: `wf-root-${input.activityId}`,
  };
}
