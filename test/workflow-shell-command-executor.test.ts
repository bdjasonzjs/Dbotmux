import { describe, expect, it } from 'vitest';

import {
  createDefaultHostExecutorRegistry,
  parseShellCommandInput,
} from '../src/workflows/hostExecutors/index.js';

describe('shell-command hostExecutor', () => {
  it('is registered and executes argv-based commands', async () => {
    const registered = createDefaultHostExecutorRegistry().get('shell-command');
    expect(registered).toBeTruthy();

    const input = parseShellCommandInput({
      command: process.execPath,
      args: ['-e', 'console.log("workflow-script-ok")'],
      timeoutMs: 10_000,
    });
    const result = await registered!.executor.invoke(input, 'unit-test-idempotency');

    expect(result.output.exitCode).toBe(0);
    expect(result.output.stdout).toContain('workflow-script-ok');
    expect(result.externalRefs.exitCode).toBe(0);
  });

  it('rejects empty commands before execution', () => {
    expect(() => parseShellCommandInput({ command: '' })).toThrow();
  });
});
