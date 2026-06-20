import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activateBot, restartCloneBot, type ActivateBotDeps, type ActivateBotPaths } from '../src/services/bot-activate.js';
import type { EcosystemPaths } from '../src/core/pm2-ecosystem.js';

const tmps: string[] = [];
afterEach(() => { while (tmps.length) { try { rmSync(tmps.pop()!, { recursive: true, force: true }); } catch { /* */ } } });

function setup() {
  const configDir = mkdtempSync(join(tmpdir(), 'activate-cfg-'));
  tmps.push(configDir);
  const ecosystem: EcosystemPaths = {
    configDir, dataDir: join(configDir, 'data'), logDir: join(configDir, 'logs'),
    heapshotDir: join(configDir, 'heap'), pkgRoot: '/pkg', pm2Name: 'botmux',
  };
  const botsJsonPath = join(configDir, 'bots.json');
  // 本体 (index 0) + a clone (index 1, ascii name → pm2 app botmux-claude-clone)
  writeFileSync(botsJsonPath, JSON.stringify([
    { larkAppId: 'cli_main', cliId: 'claude-code' },
    { larkAppId: 'cli_clone', cliId: 'claude-code', name: 'claude-clone', claudeConfigDir: join(configDir, 'clones', 'cli_clone', '.claude') },
  ]));
  // create the clone home dir so rollback has something to remove
  mkdirSync(join(configDir, 'clones', 'cli_clone', '.claude'), { recursive: true });
  const paths: ActivateBotPaths = { ecosystem, pm2Home: join(configDir, 'pm2'), botsJsonPath };
  return { configDir, paths, botsJsonPath };
}

describe('activateBot', () => {
  it('starts ONLY the new app, leaves existing daemon pids unchanged, succeeds', async () => {
    const { paths, botsJsonPath } = setup();
    const started: string[] = [];
    const existing = { 'botmux-0': 100, 'botmux-dashboard': 200 };
    const deps: ActivateBotDeps = {
      startOnly: (name) => { started.push(name); },
      // pids identical before & after → no existing daemon restarted
      readDaemonPids: () => ({ ...existing }),
      stopApp: () => { throw new Error('stopApp should not be called on success'); },
    };
    const res = await activateBot('cli_clone', paths, deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.appName).toBe('botmux-claude-clone'); // ascii slug → reliable pm2 name
    expect(res.botIndex).toBe(1);
    expect(started).toEqual(['botmux-claude-clone']); // only the new app
    // bots.json + clone home untouched on success
    expect(JSON.parse(readFileSync(botsJsonPath, 'utf-8'))).toHaveLength(2);
  });

  it('writes the ecosystem before starting (whole-file regen)', async () => {
    const { configDir, paths } = setup();
    let ecoExistedAtStart = false;
    const deps: ActivateBotDeps = {
      startOnly: () => { ecoExistedAtStart = existsSync(join(configDir, 'ecosystem.config.json')); },
      readDaemonPids: () => ({}),
    };
    await activateBot('cli_clone', paths, deps);
    expect(ecoExistedAtStart).toBe(true);
  });

  it('start failure → clean rollback (stop app + remove bots.json entry + rm clone home)', async () => {
    const { configDir, paths, botsJsonPath } = setup();
    const stopped: string[] = [];
    const deps: ActivateBotDeps = {
      startOnly: () => { throw new Error('pm2 start boom'); },
      readDaemonPids: () => ({ 'botmux-0': 100 }),
      stopApp: (name) => { stopped.push(name); },
    };
    const res = await activateBot('cli_clone', paths, deps);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('start_failed');
    expect(stopped).toEqual(['botmux-claude-clone']);
    // bots.json entry removed, clone home gone — no zombie
    expect(JSON.parse(readFileSync(botsJsonPath, 'utf-8'))).toHaveLength(1);
    expect(existsSync(join(configDir, 'clones', 'cli_clone'))).toBe(false);
  });

  it('existing daemon restarted (pid changed) → forbidden → rollback', async () => {
    const { paths, botsJsonPath } = setup();
    let calls = 0;
    const deps: ActivateBotDeps = {
      startOnly: () => { /* "started" */ },
      // pid of botmux-0 changes between before/after → we restarted a live daemon
      readDaemonPids: () => { calls += 1; return { 'botmux-0': calls === 1 ? 100 : 999 }; },
      stopApp: () => { /* rollback */ },
    };
    const res = await activateBot('cli_clone', paths, deps);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('existing_daemon_restarted');
    expect(JSON.parse(readFileSync(botsJsonPath, 'utf-8'))).toHaveLength(1); // rolled back
  });

  it('unknown appId (not cloned yet) → not_in_bots_json, no pm2 touched', async () => {
    const { paths } = setup();
    let touched = false;
    const res = await activateBot('cli_ghost', paths, { startOnly: () => { touched = true; }, readDaemonPids: () => ({}) });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('not_in_bots_json');
    expect(touched).toBe(false);
  });

  it('refuses a NON-clone (本体, no claudeConfigDir) → not_a_clone, no pm2 touched', async () => {
    const { paths } = setup();
    let touched = false;
    // cli_main is the 本体 (index 0, no claudeConfigDir) — must never be hot-activated.
    const res = await activateBot('cli_main', paths, {
      startOnly: () => { touched = true; },
      readDaemonPids: () => { throw new Error('should not even read pids'); },
      stopApp: () => { touched = true; },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('not_a_clone');
    expect(touched).toBe(false); // never touched pm2
  });

  it('pid read FAILS before start → fail-closed (pid_read_failed), nothing started', async () => {
    const { paths } = setup();
    let started = false;
    const res = await activateBot('cli_clone', paths, {
      startOnly: () => { started = true; },
      readDaemonPids: () => { throw new Error('pm2 jlist failed'); },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('pid_read_failed');
    expect(started).toBe(false); // aborted before starting
  });

  it('rollback regenerates ecosystem WITHOUT the clone app (no zombie)', async () => {
    const { configDir, paths } = setup();
    const res = await activateBot('cli_clone', paths, {
      startOnly: () => { throw new Error('start boom'); },
      readDaemonPids: () => ({ 'botmux-0': 100 }),
      stopApp: () => { /* */ },
    });
    expect(res.ok).toBe(false);
    // ecosystem.config.json must no longer reference the clone app
    const eco = JSON.parse(readFileSync(join(configDir, 'ecosystem.config.json'), 'utf-8'));
    const appNames = eco.apps.map((a: any) => a.name);
    expect(appNames).not.toContain('botmux-claude-clone');
    expect(appNames).toContain('botmux-0'); // 本体 still there
  });
});

describe('restartCloneBot', () => {
  it('restarts only the clone daemon and leaves other pids unchanged', async () => {
    const { paths } = setup();
    const restarted: string[] = [];
    let calls = 0;
    const res = await restartCloneBot('cli_clone', paths, {
      restartApp: (name) => { restarted.push(name); },
      readDaemonPids: () => {
        calls += 1;
        return {
          'botmux-0': 100,
          'botmux-claude-clone': calls === 1 ? 201 : 301,
        };
      },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(restarted).toEqual(['botmux-claude-clone']);
    expect(res.oldPid).toBe(201);
    expect(res.newPid).toBe(301);
  });

  it('refuses to restart a non-clone daemon', async () => {
    const { paths } = setup();
    let touched = false;
    const res = await restartCloneBot('cli_main', paths, {
      restartApp: () => { touched = true; },
      readDaemonPids: () => { touched = true; return {}; },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('not_a_clone');
    expect(touched).toBe(false);
  });

  it('fails closed if any existing daemon pid changes during clone restart', async () => {
    const { paths } = setup();
    let calls = 0;
    const res = await restartCloneBot('cli_clone', paths, {
      restartApp: () => { /* restart target */ },
      readDaemonPids: () => {
        calls += 1;
        return {
          'botmux-0': calls === 1 ? 100 : 999,
          'botmux-claude-clone': calls === 1 ? 201 : 301,
        };
      },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('existing_daemon_restarted');
  });
});
