import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ScheduledTask } from '../src/types.js';
import { runDelegationRoundEnd, validateDelegationRoundEndTask } from '../src/services/delegation-round-end-runner.js';

vi.mock('../src/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

const homes: string[] = [];

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'roundend1', name: 'P5 round-end', schedule: '0,30 * * * *',
    parsed: { kind: 'cron', expr: '0,30 * * * *', display: 'twice hourly' },
    prompt: 'must not be used', workingDir: '/tmp', chatId: 'oc_allowed',
    larkAppId: 'cli_observer', enabled: true, createdAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

function install(config: unknown, script = 'printf "round-end ok\\n"\n'): string {
  const home = mkdtempSync(join(tmpdir(), 'delegation-round-end-'));
  homes.push(home);
  const p5 = join(home, 'cost-opt', 'p5');
  mkdirSync(p5, { recursive: true });
  writeFileSync(join(p5, 'p5-config.json'), JSON.stringify(config));
  const scriptPath = join(p5, 'p5-round-end.sh');
  writeFileSync(scriptPath, `#!/usr/bin/env bash\n${script}`);
  chmodSync(scriptPath, 0o755);
  return home;
}

afterEach(() => {
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

describe('delegation round-end runner', () => {
  it('runs only the fixed entrypoint for an enabled, in-scope observer schedule', async () => {
    const home = install({ observer_app: 'cli_observer', delegation_auto: { enabled: true, allowed_path: ['oc_allowed'] } });
    await expect(runDelegationRoundEnd(task({ runtimeAction: { kind: 'delegation-round-end', home } }))).resolves.toBeUndefined();
  });

  it.each([
    ['disabled', { observer_app: 'cli_observer', delegation_auto: { enabled: false, allowed_path: ['oc_allowed'] } }, {}, 'not enabled'],
    ['wrong app', { observer_app: 'cli_other', delegation_auto: { enabled: true, allowed_path: ['oc_allowed'] } }, {}, 'not owned'],
    ['outside path', { observer_app: 'cli_observer', delegation_auto: { enabled: true, allowed_path: ['oc_other'] } }, {}, 'outside'],
  ])('fails closed when %s', (_name, config, overrides, expected) => {
    const home = install(config);
    expect(() => validateDelegationRoundEndTask(task({ ...overrides, runtimeAction: { kind: 'delegation-round-end', home } }))).toThrow(expected);
  });

  it('surfaces the fixed entrypoint rc and bounded output instead of reporting a false success', async () => {
    const home = install(
      { observer_app: 'cli_observer', delegation_auto: { enabled: true, allowed_path: ['oc_allowed'] } },
      'printf "recovery failed"\nprintf "details" >&2\nexit 7\n',
    );
    await expect(runDelegationRoundEnd(task({ runtimeAction: { kind: 'delegation-round-end', home } })))
      .rejects.toThrow(/rc=7.*recovery failed.*details/);
  });

  it('short-circuits the whole scheduled entrypoint after one-command manual disable', async () => {
    const ran = join(tmpdir(), `delegation-round-end-ran-${Date.now()}`);
    const home = install(
      { root_request_id: 'om_root', task_id: 'demo', observer_app: 'cli_observer', delegation_auto: { enabled: true, allowed_path: ['oc_allowed'] } },
      `printf ran > ${JSON.stringify(ran)}\n`,
    );
    mkdirSync(join(home, 'health'));
    writeFileSync(join(home, 'health', 'delegation-auto-manual.json'), JSON.stringify({ root_request_id: 'om_root', task_id: 'demo', mode: 'manual' }));
    await expect(runDelegationRoundEnd(task({ runtimeAction: { kind: 'delegation-round-end', home } }))).resolves.toBeUndefined();
    expect(existsSync(ran)).toBe(false);
  });

  it('serializes schedules for one installation and retries a transient P5 lock conflict with bounded backoff', async () => {
    const home = install({ observer_app: 'cli_observer', delegation_auto: { enabled: true, allowed_path: ['oc_allowed'] } });
    const active = join(home, 'active');
    const log = join(home, 'order');
    const attempts = join(home, 'attempts');
    writeFileSync(join(home, 'cost-opt', 'p5', 'p5-round-end.sh'), `#!/usr/bin/env bash
n=0; [ -f ${JSON.stringify(attempts)} ] && n=$(cat ${JSON.stringify(attempts)})
n=$((n+1)); printf '%s' "$n" > ${JSON.stringify(attempts)}
if [ "$n" -lt 3 ]; then exit 75; fi
if [ -e ${JSON.stringify(active)} ]; then exit 91; fi
touch ${JSON.stringify(active)}; printf start >> ${JSON.stringify(log)}; sleep 0.05; printf end >> ${JSON.stringify(log)}; rm -f ${JSON.stringify(active)}
`);
    chmodSync(join(home, 'cost-opt', 'p5', 'p5-round-end.sh'), 0o755);
    const scheduled = task({ runtimeAction: { kind: 'delegation-round-end', home } });
    await Promise.all([
      runDelegationRoundEnd(scheduled, { lockRetryDelaysMs: [1, 1] }),
      runDelegationRoundEnd({ ...scheduled, id: 'roundend2' }, { lockRetryDelaysMs: [1, 1] }),
    ]);
    expect(readFileSync(attempts, 'utf8')).toBe('4');
    expect(readFileSync(log, 'utf8')).toBe('startendstartend');
  });

  it.runIf(process.platform !== 'win32')('terminates the bash process group so a timed-out descendant cannot retain work', async () => {
    const marker = join(tmpdir(), `delegation-round-end-orphan-${Date.now()}`);
    const home = install(
      { observer_app: 'cli_observer', delegation_auto: { enabled: true, allowed_path: ['oc_allowed'] } },
      `(sleep 0.25; printf orphan > ${JSON.stringify(marker)}) &\nwait\n`,
    );
    await expect(runDelegationRoundEnd(
      task({ runtimeAction: { kind: 'delegation-round-end', home } }),
      { timeoutMs: 25, killGraceMs: 10 },
    )).rejects.toThrow(/timeout=true/);
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(existsSync(marker)).toBe(false);
  });
});
