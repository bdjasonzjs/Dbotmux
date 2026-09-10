/**
 * Typed scheduled execution for P5 round-end.
 *
 * This module intentionally does not accept an arbitrary command.  The
 * schedule gives it only an installation home; the action revalidates that
 * home's declared delegation scope before running its fixed entrypoint.
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ScheduledTask } from '../types.js';
import { logger } from '../utils/logger.js';

const OUTPUT_LIMIT = 8 * 1024;
// A real round-end may hydrate a bounded batch of cards and legitimately last
// several minutes.  The runner therefore has a process-group deadline rather
// than the old two-minute child-only kill.  It remains finite so a wedged
// transport cannot retain the shared callback lock indefinitely.
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_LOCK_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;

/** Test seams only; production uses the finite defaults above. */
export interface DelegationRoundEndRunOptions {
  timeoutMs?: number;
  killGraceMs?: number;
  lockRetryDelaysMs?: readonly number[];
}

interface DelegationAutoScope {
  enabled?: boolean;
  allowed_path?: unknown;
}

interface DelegationConfig {
  root_request_id?: unknown;
  task_id?: unknown;
  observer_app?: unknown;
  delegation_auto?: DelegationAutoScope;
}

interface ValidatedRoundEndTask {
  home: string;
  script: string;
  configPath: string;
  manualLatchPath?: string;
}

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// All three authorised node schedules share one P5_HOME and its callback lock.
// Serialize them in this daemon before they contend for that lock; a second
// daemon or an operator-owned action still receives bounded rc=75 retries.
const homeQueues = new Map<string, Promise<void>>();

function clipped(value: string): string {
  return value.length <= OUTPUT_LIMIT ? value : `${value.slice(0, OUTPUT_LIMIT)}…[truncated]`;
}

function compact(value: string): string {
  return clipped(value).replace(/\s+/g, ' ').trim();
}

/** Validate every runtime precondition before spawning the fixed entrypoint. */
export function validateDelegationRoundEndTask(task: ScheduledTask): {
  home: string;
  script: string;
  configPath: string;
  manualLatchPath?: string;
} {
  const action = task.runtimeAction;
  if (action?.kind !== 'delegation-round-end') {
    throw new Error(`scheduled task ${task.id} has no delegation round-end action`);
  }
  if (!isAbsolute(action.home)) {
    throw new Error(`scheduled task ${task.id} has non-absolute delegation home`);
  }

  const home = resolve(action.home);
  const configPath = join(home, 'cost-opt', 'p5', 'p5-config.json');
  const script = join(home, 'cost-opt', 'p5', 'p5-round-end.sh');
  if (!existsSync(configPath)) throw new Error(`delegation config missing: ${configPath}`);
  if (!existsSync(script)) throw new Error(`delegation round-end missing: ${script}`);

  let config: DelegationConfig;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8')) as DelegationConfig;
  } catch (error) {
    throw new Error(`delegation config unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const scope = config.delegation_auto;
  if (!scope || scope.enabled !== true) {
    throw new Error(`delegation_auto is not enabled for scheduled task ${task.id}`);
  }
  if (!Array.isArray(scope.allowed_path) || !scope.allowed_path.every(chat => typeof chat === 'string')) {
    throw new Error(`delegation_auto.allowed_path is invalid for scheduled task ${task.id}`);
  }
  if (!scope.allowed_path.includes(task.chatId)) {
    throw new Error(`scheduled chat ${task.chatId} is outside delegation_auto.allowed_path`);
  }
  if (typeof config.observer_app !== 'string' || !config.observer_app.trim()) {
    throw new Error('delegation observer_app is missing');
  }
  if (!task.larkAppId || task.larkAppId !== config.observer_app) {
    throw new Error(`scheduled task ${task.id} is not owned by delegation observer_app`);
  }

  const latchPath = join(home, 'health', 'delegation-auto-manual.json');
  if (!existsSync(latchPath)) return { home, script, configPath };
  let latch: { mode?: unknown; root_request_id?: unknown; task_id?: unknown };
  try {
    latch = JSON.parse(readFileSync(latchPath, 'utf8')) as typeof latch;
  } catch (error) {
    throw new Error(`delegation manual latch unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (latch.mode !== 'manual') throw new Error('delegation manual latch has invalid mode');
  if (typeof config.root_request_id === 'string' && latch.root_request_id !== config.root_request_id) {
    throw new Error('delegation manual latch root_request_id differs from config');
  }
  if (typeof config.task_id === 'string' && latch.task_id !== config.task_id) {
    throw new Error('delegation manual latch task_id differs from config');
  }
  return { home, script, configPath, manualLatchPath: latchPath };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}

function killProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== 'win32') {
    try {
      // detached=true makes the bash process a process-group leader.  Killing
      // the negative pid reaches its Python/CLI descendants as well.
      process.kill(-child.pid, signal);
      return;
    } catch (error: any) {
      if (error?.code !== 'ESRCH') logger.warn(`[delegation-round-end] process-group kill failed: ${error?.message ?? error}`);
    }
  }
  child.kill(signal);
}

async function runFixedRoundEnd(
  task: ScheduledTask,
  validated: ValidatedRoundEndTask,
  options: Required<Pick<DelegationRoundEndRunOptions, 'timeoutMs' | 'killGraceMs'>>,
): Promise<ProcessResult> {
  const { home, script, configPath } = validated;
  const bundledCli = fileURLToPath(new URL('../cli.js', import.meta.url));
  return new Promise<ProcessResult>((resolveResult, reject) => {
    const child = spawn('bash', [script, task.chatId], {
      cwd: dirname(script),
      env: {
        ...process.env,
        P5_HOME: home,
        P5_CONFIG: configPath,
        P5_BOTMUX_BIN: process.env.P5_BOTMUX_BIN || bundledCli,
        PYTHONDONTWRITEBYTECODE: '1',
      },
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout = clipped(stdout + chunk); });
    child.stderr.on('data', chunk => { stderr = clipped(stderr + chunk); });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => killProcessGroup(child, 'SIGKILL'), options.killGraceMs);
    }, options.timeoutMs);
    child.once('error', error => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolveResult({ code, signal, stdout, stderr, timedOut });
    });
  });
}

function queueForHome<T>(home: string, operation: () => Promise<T>): Promise<T> {
  const previous = homeQueues.get(home) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const tail = current.then(() => undefined, () => undefined);
  homeQueues.set(home, tail);
  void tail.finally(() => {
    if (homeQueues.get(home) === tail) homeQueues.delete(home);
  });
  return current;
}

/** Execute only the fixed P5 round-end program and make its rc observable. */
export async function runDelegationRoundEnd(task: ScheduledTask, runOptions: DelegationRoundEndRunOptions = {}): Promise<void> {
  const initial = validateDelegationRoundEndTask(task);
  const options = {
    timeoutMs: runOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    killGraceMs: runOptions.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    lockRetryDelaysMs: runOptions.lockRetryDelaysMs ?? DEFAULT_LOCK_RETRY_DELAYS_MS,
  };
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('delegation round-end timeout must be positive');
  if (!Number.isFinite(options.killGraceMs) || options.killGraceMs < 0) throw new Error('delegation round-end kill grace must be non-negative');

  return queueForHome(initial.home, async () => {
    for (let attempt = 0; ; attempt += 1) {
      // The manual latch can be created while this task waits behind another
      // authorised node.  Re-read it at the actual execution boundary.
      const validated = validateDelegationRoundEndTask(task);
      if (validated.manualLatchPath) {
        logger.info(`[delegation-round-end] task=${task.id} chat=${task.chatId} skipped=manual-latch zero_p5_io=true`);
        return;
      }
      const result = await runFixedRoundEnd(task, validated, options);
      const detail = `stdout=${JSON.stringify(compact(result.stdout))} stderr=${JSON.stringify(compact(result.stderr))}`;
      if (!result.timedOut && result.code === 75 && attempt < options.lockRetryDelaysMs.length) {
        const delay = options.lockRetryDelaysMs[attempt];
        logger.warn(`[delegation-round-end] task=${task.id} chat=${task.chatId} rc=75 retry=${attempt + 1}/${options.lockRetryDelaysMs.length} delay_ms=${delay} ${detail}`);
        await sleep(delay);
        continue;
      }
      if (result.timedOut || result.code !== 0) {
        throw new Error(
          `delegation round-end task=${task.id} chat=${task.chatId} rc=${result.code ?? 'null'}`
          + `${result.signal ? ` signal=${result.signal}` : ''}${result.timedOut ? ' timeout=true' : ''} ${detail}`,
        );
      }
      logger.info(`[delegation-round-end] task=${task.id} chat=${task.chatId} rc=0 attempts=${attempt + 1} ${detail}`);
      return;
    }
  });
}
