import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('dequeue-time turn metadata contract', () => {
  const daemonSource = readFileSync(join(process.cwd(), 'src/daemon.ts'), 'utf8');
  const workerSource = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

  it('does not switch caller metadata merely because a message arrived', () => {
    const start = daemonSource.indexOf('// Arrival updates activity only.');
    const end = daemonSource.indexOf('// If waiting for repo selection', start);
    const arrivalBlock = daemonSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(arrivalBlock).not.toContain('lastCallerOpenId');
  });

  it('does not switch title/last input before the worker starts the input', () => {
    const start = daemonSource.indexOf('// Send message to worker via IPC');
    const end = daemonSource.indexOf('// Worker not running', start);
    const liveWorkerBlock = daemonSource.slice(start, end);

    expect(liveWorkerBlock).not.toContain('beginNewTurn(ds, parsed.content)');
    expect(liveWorkerBlock).not.toContain('rememberLastCliInput(ds, promptContent, msgContent)');
    expect(liveWorkerBlock).toContain("type: 'message'");
    expect(liveWorkerBlock).toContain('metadata:');
  });

  it('emits plural callers from the actual worker batch-start path', () => {
    const start = workerSource.indexOf("type: 'input_started'");
    const end = workerSource.indexOf('originalContent:', start) + 200;
    const inputStartedBlock = workerSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(inputStartedBlock).toContain('callers: batch?.callers');
    expect(inputStartedBlock).toContain('pendingCount: pendingMessages.length');
  });
});
