import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduledTask } from '../src/types.js';

const schedule = vi.hoisted(() => ({ getTask: vi.fn(), updateTask: vi.fn() }));
vi.mock('../src/services/schedule-store.js', () => schedule);

import { cmdDelegation } from '../src/cli/delegation.js';

const roots: string[] = [];
const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

function home(): string {
  const root = mkdtempSync(join(tmpdir(), 'delegation-wire-'));
  roots.push(root);
  const p5 = join(root, 'cost-opt', 'p5');
  mkdirSync(p5, { recursive: true });
  writeFileSync(join(p5, 'p5-config.json'), JSON.stringify({
    observer_app: 'cli_observer',
    delegation_auto: { enabled: true, allowed_path: ['oc_allowed'] },
  }));
  return root;
}

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'schedule1', name: 'observer', schedule: '0 * * * *',
    parsed: { kind: 'cron', expr: '0 * * * *', display: 'hourly' },
    prompt: 'ignored', workingDir: '/tmp', chatId: 'oc_allowed',
    larkAppId: 'cli_observer', enabled: true, createdAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  schedule.getTask.mockReset();
  schedule.updateTask.mockReset();
  output.mockClear();
  errors.mockClear();
  process.exitCode = undefined;
});
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('delegation wire-round-end', () => {
  it('is idempotent for the same fixed runtime action', async () => {
    const target = home();
    schedule.getTask.mockReturnValue(task({ runtimeAction: { kind: 'delegation-round-end', home: target } }));
    await cmdDelegation('wire-round-end', ['--home', target, '--schedule', 'schedule1']);
    expect(schedule.updateTask).not.toHaveBeenCalled();
    expect(JSON.parse(String(output.mock.calls[0][0]))).toMatchObject({ ok: true, changed: false, schedule_id: 'schedule1' });
  });

  it('attaches only the fixed action once to an eligible existing observer schedule', async () => {
    const target = home();
    schedule.getTask.mockReturnValue(task());
    await cmdDelegation('wire-round-end', ['--home', target, '--schedule', 'schedule1']);
    expect(schedule.updateTask).toHaveBeenCalledWith('schedule1', {
      runtimeAction: { kind: 'delegation-round-end', home: target },
    }, 'cli_observer');
  });

  it('refuses to overwrite an existing action bound to another installation', async () => {
    const target = home();
    schedule.getTask.mockReturnValue(task({ runtimeAction: { kind: 'delegation-round-end', home: '/other/p5' } }));
    await cmdDelegation('wire-round-end', ['--home', target, '--schedule', 'schedule1']);
    expect(schedule.updateTask).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(String(errors.mock.calls[0][0])).toContain('拒绝覆盖');
  });
});
