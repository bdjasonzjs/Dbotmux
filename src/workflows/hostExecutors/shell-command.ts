import { spawn } from 'node:child_process';
import { z } from 'zod';

import type { SideEffectingExecutor } from './types.js';

const MAX_CAPTURE_BYTES = 64 * 1024;

export type ShellCommandInput = {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
};

export type ShellCommandOutput = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

const ShellCommandInputSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().max(60 * 60 * 1000).optional(),
});

export function parseShellCommandInput(input: unknown): ShellCommandInput {
  return ShellCommandInputSchema.parse(input);
}

function appendBounded(current: string, chunk: Buffer): string {
  const next = current + chunk.toString('utf8');
  if (Buffer.byteLength(next, 'utf8') <= MAX_CAPTURE_BYTES) return next;
  return next.slice(-MAX_CAPTURE_BYTES);
}

export const shellCommandExecutor: SideEffectingExecutor<ShellCommandInput, ShellCommandOutput> = {
  provider: 'shell-command',
  idempotencyTtlMs: 24 * 60 * 60 * 1000,

  canonicalInput(input) {
    return {
      command: input.command,
      args: input.args ?? [],
      cwd: input.cwd,
      timeoutMs: input.timeoutMs ?? 120_000,
    };
  },

  invoke(input) {
    return new Promise((resolve, reject) => {
      const child = spawn(input.command, input.args ?? [], {
        cwd: input.cwd || undefined,
        shell: false,
        env: process.env,
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        child.kill('SIGTERM');
        reject(new Error(`shell-command timed out after ${input.timeoutMs ?? 120_000}ms`));
      }, input.timeoutMs ?? 120_000);
      child.stdout.on('data', (chunk: Buffer) => { stdout = appendBounded(stdout, chunk); });
      child.stderr.on('data', (chunk: Buffer) => { stderr = appendBounded(stderr, chunk); });
      child.on('error', (err) => {
        settled = true;
        clearTimeout(timeout);
        reject(err);
      });
      child.on('close', (exitCode, signal) => {
        settled = true;
        clearTimeout(timeout);
        const output = { exitCode, signal, stdout, stderr };
        if (exitCode && exitCode !== 0) {
          reject(new Error(`shell-command exited ${exitCode}: ${stderr || stdout || 'no output'}`));
          return;
        }
        resolve({ output, externalRefs: { exitCode, signal } });
      });
    });
  },
};
