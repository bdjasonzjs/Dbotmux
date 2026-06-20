/**
 * Make a freshly-cloned bot live by starting ONLY its new PM2 app — a hot-add
 * that never restarts the existing botmux-0/1/2/dashboard daemons (so live
 * user sessions are untouched). 方案 块4「daemon 生效」.
 *
 * Safety contract:
 *  - Regenerate the whole ecosystem (index aligned with bots.json), then
 *    `pm2 start <ecosystem> --only <newApp>` — touches the new app only.
 *  - Verify every PRE-EXISTING daemon's pid is unchanged after the start; if
 *    any changed, we accidentally restarted something → treat as failure +
 *    roll back.
 *  - Rollback is clean: stop/delete the new app, remove its bots.json entry,
 *    and delete its clone home dir — no half-registered zombie entry.
 *
 * NOTE: actually invoking pm2 is a DEPLOY action (gated on 松松's approval).
 * The pm2 operations are injected (`deps`) so this is unit-tested with a mock
 * runner; the real run is only triggered by an explicit, approved deploy.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  writeEcosystemConfig, pm2StartOnly, pm2ListAppPids, runPm2, type EcosystemPaths,
} from '../core/pm2-ecosystem.js';
import { botProcessName } from '../setup/bot-config-editor.js';
import { readBotsJsonOrEmpty, writeBotsJsonAtomic } from '../setup/bots-store.js';

export interface ActivateBotPaths {
  ecosystem: EcosystemPaths;
  pm2Home: string;
  botsJsonPath: string;
}

export interface ActivateBotDeps {
  /** Start only the new app (default: real pm2StartOnly). */
  startOnly?: (appName: string, ecosystemPath: string) => void;
  /** Read live `{appName: pid}` (default: real pm2 jlist). */
  readDaemonPids?: () => Record<string, number>;
  /** Stop/remove an app for rollback (default: real `pm2 delete`). */
  stopApp?: (appName: string) => void;
}

export type ActivateBotResult =
  | { ok: true; appName: string; botIndex: number }
  | { ok: false; error: 'not_in_bots_json' | 'not_a_clone' | 'pid_read_failed' | 'start_failed' | 'existing_daemon_restarted'; message: string };

export interface RestartCloneBotDeps {
  /** Restart only the clone PM2 app (default: real `pm2 restart <appName>`). */
  restartApp?: (appName: string) => void;
  /** Read live `{appName: pid}` (default: real pm2 jlist). */
  readDaemonPids?: () => Record<string, number>;
}

export type RestartCloneBotResult =
  | { ok: true; appName: string; botIndex: number; oldPid?: number; newPid?: number }
  | { ok: false; error: 'not_in_bots_json' | 'not_a_clone' | 'pid_read_failed' | 'restart_failed' | 'existing_daemon_restarted' | 'target_not_restarted'; message: string };

function resolveCloneApp(appId: string, paths: ActivateBotPaths): { ok: true; appName: string; botIndex: number } | Extract<RestartCloneBotResult, { ok: false }> {
  const bots = readBotsJsonOrEmpty(paths.botsJsonPath);
  const idx = bots.findIndex((b: any) => b?.larkAppId === appId);
  if (idx < 0) {
    return { ok: false, error: 'not_in_bots_json', message: `appId ${appId} not found in bots.json (clone first)` };
  }
  if (!bots[idx]?.claudeConfigDir) {
    return { ok: false, error: 'not_a_clone', message: `bot ${appId} is not a clone (no claudeConfigDir); refusing to touch a non-clone daemon` };
  }
  return { ok: true, appName: botProcessName(bots[idx], idx, paths.ecosystem.pm2Name), botIndex: idx };
}

export async function restartCloneBot(
  appId: string,
  paths: ActivateBotPaths,
  deps: RestartCloneBotDeps = {},
): Promise<RestartCloneBotResult> {
  const resolved = resolveCloneApp(appId, paths);
  if (!resolved.ok) return resolved;
  const pm2Opts = { pkgRoot: paths.ecosystem.pkgRoot, pm2Home: paths.pm2Home };
  const restartApp = deps.restartApp ?? ((name) => runPm2(['restart', name], { ...pm2Opts, inherit: false }));
  const readPids = deps.readDaemonPids ?? (() => pm2ListAppPids(pm2Opts));

  let pidsBefore: Record<string, number>;
  try {
    pidsBefore = readPids();
  } catch (err: any) {
    return { ok: false, error: 'pid_read_failed', message: `cannot read pm2 pids before restart (aborting): ${err?.message ?? err}` };
  }

  try {
    restartApp(resolved.appName);
  } catch (err: any) {
    return { ok: false, error: 'restart_failed', message: `pm2 restart ${resolved.appName} failed: ${err?.message ?? err}` };
  }

  let pidsAfter: Record<string, number>;
  try {
    pidsAfter = readPids();
  } catch (err: any) {
    return { ok: false, error: 'pid_read_failed', message: `cannot verify pids after restart (failing closed): ${err?.message ?? err}` };
  }

  const restarted = Object.keys(pidsBefore).filter(
    name => name !== resolved.appName && pidsAfter[name] !== pidsBefore[name],
  );
  if (restarted.length > 0) {
    return { ok: false, error: 'existing_daemon_restarted', message: `existing daemon(s) restarted (forbidden): ${restarted.join(', ')}` };
  }
  const oldPid = pidsBefore[resolved.appName];
  const newPid = pidsAfter[resolved.appName];
  if (oldPid !== undefined && newPid === oldPid) {
    return { ok: false, error: 'target_not_restarted', message: `clone daemon ${resolved.appName} pid did not change` };
  }

  return { ok: true, appName: resolved.appName, botIndex: resolved.botIndex, oldPid, newPid };
}

export async function activateBot(
  appId: string,
  paths: ActivateBotPaths,
  deps: ActivateBotDeps = {},
): Promise<ActivateBotResult> {
  const pm2Opts = { pkgRoot: paths.ecosystem.pkgRoot, pm2Home: paths.pm2Home };
  const startOnly = deps.startOnly ?? ((name, eco) => pm2StartOnly(name, eco, pm2Opts));
  const readPids = deps.readDaemonPids ?? (() => pm2ListAppPids(pm2Opts));
  const stopApp = deps.stopApp ?? ((name) => runPm2(['delete', name], { ...pm2Opts, inherit: false }));

  const bots = readBotsJsonOrEmpty(paths.botsJsonPath);
  const idx = bots.findIndex((b: any) => b?.larkAppId === appId);
  if (idx < 0) {
    return { ok: false, error: 'not_in_bots_json', message: `appId ${appId} not found in bots.json (clone first)` };
  }
  // Only a CLONE (has its own claudeConfigDir) may be hot-activated. Refuse the
  // 本体 / any non-clone — otherwise a mistaken appId would start/delete an
  // existing daemon (e.g. botmux-0) and the pid check (which excludes the
  // target app) would miss that self-restart.
  if (!bots[idx]?.claudeConfigDir) {
    return { ok: false, error: 'not_a_clone', message: `bot ${appId} is not a clone (no claudeConfigDir); refusing to hot-activate a non-clone daemon` };
  }
  const appName = botProcessName(bots[idx], idx, paths.ecosystem.pm2Name);

  const rollback = (error: 'start_failed' | 'existing_daemon_restarted', message: string): ActivateBotResult => {
    try { stopApp(appName); } catch { /* best effort */ }
    let remaining = bots.filter((b: any) => b?.larkAppId !== appId);
    try {
      remaining = readBotsJsonOrEmpty(paths.botsJsonPath).filter((b: any) => b?.larkAppId !== appId);
      writeBotsJsonAtomic(paths.botsJsonPath, remaining);
    } catch { /* best effort */ }
    // Regenerate ecosystem WITHOUT the clone so a later `pm2 start ecosystem`
    // can't resurrect the zombie clone app.
    try { writeEcosystemConfig(remaining, paths.ecosystem); } catch { /* best effort */ }
    try { rmSync(join(paths.ecosystem.configDir, 'clones', appId), { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, error, message };
  };

  // Snapshot existing daemon pids BEFORE touching pm2. Fail CLOSED: if we can't
  // read pids we can't prove we won't restart a live daemon, so abort before
  // starting anything (nothing to roll back yet).
  let pidsBefore: Record<string, number>;
  try {
    pidsBefore = readPids();
  } catch (err: any) {
    return { ok: false, error: 'pid_read_failed', message: `cannot read pm2 pids before activate (aborting, nothing started): ${err?.message ?? err}` };
  }

  // Whole-file ecosystem rewrite (index aligned, no incremental splice). Pure
  // file write — does not start/stop anything.
  const ecosystemPath = writeEcosystemConfig(bots, paths.ecosystem);

  try {
    startOnly(appName, ecosystemPath);
  } catch (err: any) {
    return rollback('start_failed', `pm2 start --only ${appName} failed: ${err?.message ?? err}`);
  }

  // Guardrail: every pre-existing app's pid must be unchanged — otherwise we
  // restarted a live daemon (interrupting its sessions), which is forbidden.
  // A pid-read failure here is also fail-closed → roll back (can't confirm safe).
  let pidsAfter: Record<string, number>;
  try {
    pidsAfter = readPids();
  } catch (err: any) {
    return rollback('existing_daemon_restarted', `cannot verify pids after start (failing closed): ${err?.message ?? err}`);
  }
  const restarted = Object.keys(pidsBefore).filter(
    name => name !== appName && pidsAfter[name] !== pidsBefore[name],
  );
  if (restarted.length > 0) {
    return rollback('existing_daemon_restarted', `existing daemon(s) restarted (forbidden): ${restarted.join(', ')}`);
  }

  return { ok: true, appName, botIndex: idx };
}
