/**
 * Shared PM2 + ecosystem helpers.
 *
 * Extracted verbatim from `cli.ts` so the bot-clone service (and any future
 * consumer) can regenerate the PM2 ecosystem and start a single new app
 * without duplicating the shell/spawn plumbing. Path constants are injected
 * (never hard-coded here) so callers stay the single source of truth for
 * `~/.botmux` layout.
 *
 * Behaviour is byte-for-byte identical to the previous cli.ts-local
 * implementation; cli.ts now keeps thin wrappers that delegate here with its
 * own PKG_ROOT / PM2_HOME, so every existing call site is unchanged.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { botProcessName } from '../setup/bot-config-editor.js';

const require = createRequire(import.meta.url);

/** `~/.botmux` layout needed to render an ecosystem config. */
export interface EcosystemPaths {
  configDir: string;
  dataDir: string;
  logDir: string;
  heapshotDir: string;
  pkgRoot: string;
  /** PM2 process-name prefix (e.g. `botmux` → `botmux-0`). */
  pm2Name: string;
}

/**
 * Resolve the pm2 CLI script path. Uses require.resolve so it always lands
 * on the pm2 bundled with this package, never on a PATH-resolved pm2 that
 * may belong to an unrelated installation (e.g. IDE remote extensions).
 */
export function pm2Bin(pkgRoot: string): string {
  try {
    return require.resolve('pm2/bin/pm2');
  } catch { /* fall through */ }
  // Fallbacks for unusual installation layouts
  const direct = join(pkgRoot, 'node_modules', 'pm2', 'bin', 'pm2');
  if (existsSync(direct)) return direct;
  const symlink = join(pkgRoot, 'node_modules', '.bin', 'pm2');
  if (existsSync(symlink)) return symlink;
  return 'pm2';
}

/** Env for pm2 invocations with an isolated PM2_HOME. */
export function pm2Env(pm2Home: string): NodeJS.ProcessEnv {
  return { ...process.env, PM2_HOME: pm2Home };
}

export function listPm2GodDaemonPids(pm2Home: string): number[] {
  if (process.platform !== 'linux') return [];
  const marker = `God Daemon (${pm2Home})`;
  const pids: number[] = [];
  try {
    for (const ent of readdirSync('/proc')) {
      if (!/^\d+$/.test(ent)) continue;
      const pid = parseInt(ent, 10);
      if (!pid) continue;
      try {
        const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\u0000/g, ' ').trim();
        if (cmd.includes('PM2 v') && cmd.includes(marker)) pids.push(pid);
      } catch { /* ignore unreadable proc entries */ }
    }
  } catch { /* ignore proc scan failure */ }
  return pids.sort((a, b) => a - b);
}

export function killDuplicatePm2GodDaemons(pm2Home: string): boolean {
  const pids = listPm2GodDaemonPids(pm2Home);
  if (pids.length <= 1) return false;

  const pidFile = join(pm2Home, 'pm2.pid');
  let keepPid = 0;
  if (existsSync(pidFile)) {
    try {
      const parsed = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
      if (pids.includes(parsed)) keepPid = parsed;
    } catch { /* ignore malformed pid file */ }
  }
  if (!keepPid) keepPid = pids[pids.length - 1];

  const dupes = pids.filter(pid => pid !== keepPid);
  if (dupes.length === 0) return false;

  for (const pid of dupes) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch { /* ignore */ }
  }

  try {
    writeFileSync(pidFile, `${keepPid}\n`, 'utf-8');
  } catch { /* ignore */ }

  console.warn(`⚠️  检测到同一 PM2_HOME (${pm2Home}) 下存在多个 PM2 God Daemon，已清理重复实例；保留 pid ${keepPid}，移除: ${dupes.join(', ')}`);
  return true;
}

export function runPm2(
  args: string[],
  opts: { pkgRoot: string; pm2Home: string; inherit?: boolean },
): void {
  execSync(`${pm2Bin(opts.pkgRoot)} ${args.join(' ')}`, {
    stdio: opts.inherit === false ? 'pipe' : 'inherit',
    env: pm2Env(opts.pm2Home),
  });
}

/**
 * Read live PM2 app pids as `{ appName: pid }` via `pm2 jlist`. Used to verify
 * that starting a single new app didn't restart any existing daemon (pids must
 * stay unchanged), so it must **fail closed**: a jlist command/parse failure
 * THROWS (callers must abort rather than treat an empty snapshot as "no apps").
 * A genuinely empty process list returns `{}`. Online-only (shells out); tests
 * inject a mock instead.
 */
export function pm2ListAppPids(opts: { pkgRoot: string; pm2Home: string }): Record<string, number> {
  let raw: string;
  try {
    raw = execSync(`${pm2Bin(opts.pkgRoot)} jlist`, { stdio: ['ignore', 'pipe', 'pipe'], env: pm2Env(opts.pm2Home) }).toString();
  } catch (err: any) {
    throw new Error(`pm2 jlist failed: ${err?.message ?? err}`);
  }
  let list: Array<{ name?: string; pid?: number; pm2_env?: { status?: string } }>;
  try {
    list = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`pm2 jlist parse failed: ${err?.message ?? err}`);
  }
  const out: Record<string, number> = {};
  for (const e of list) {
    // Only count online procs with a real pid; a stopped/errored app has pid 0.
    if (e.name && typeof e.pid === 'number' && e.pid > 0) out[e.name] = e.pid;
  }
  return out;
}

/**
 * Pure ecosystem builder: bots array → `{ apps }` config object.
 *
 * Exported separately from the file-writing variant so tests can assert the
 * generated config (including multi-bot layouts) without touching disk. The
 * caller is responsible for loading bots.json and enforcing unique process
 * names before calling this.
 */
export function buildEcosystemConfig(bots: any[], paths: EcosystemPaths): { apps: any[] } {
  const daemonScript = join(paths.pkgRoot, 'dist', 'index-daemon.js');

  const baseApp = {
    script: daemonScript,
    cwd: paths.configDir,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 3000,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    node_args: [
      '--max-old-space-size=8192',
      // Do not enable --heapsnapshot-near-heap-limit here. On large V8
      // heaps the snapshot generator is synchronous, can add many GiB of
      // RSS, and blocks the daemon before our memdiag timer can run.
      `--diagnostic-dir=${paths.heapshotDir}`,
    ],
  };

  const apps: any[] = bots.map((_bot: any, i: number) => ({
    ...baseApp,
    name: botProcessName(_bot, i, paths.pm2Name),
    error_file: join(paths.logDir, `daemon-${i}-error.log`),
    out_file: join(paths.logDir, `daemon-${i}-out.log`),
    env: {
      SESSION_DATA_DIR: paths.dataDir,
      BOTMUX_BOT_INDEX: String(i),
      // Native-memory diagnostics. Default off; operator can flip it on
      // ad-hoc (e.g. `BOTMUX_MEMORY_DIAG_INTERVAL_MS=5000`) when chasing an
      // RSS regression — turned off in master so logs stay quiet.
      BOTMUX_MEMORY_DIAG_INTERVAL_MS: process.env.BOTMUX_MEMORY_DIAG_INTERVAL_MS ?? '0',
    },
  }));

  apps.push({
    name: 'botmux-dashboard',
    script: join(paths.pkgRoot, 'dist', 'dashboard.js'),
    cwd: paths.pkgRoot,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 3000,
    error_file: join(paths.logDir, 'dashboard-error.log'),
    out_file: join(paths.logDir, 'dashboard-out.log'),
    merge_logs: true,
    env: {
      BOTMUX_DASHBOARD_HOST: process.env.BOTMUX_DASHBOARD_HOST ?? '0.0.0.0',
      BOTMUX_DASHBOARD_PORT: process.env.BOTMUX_DASHBOARD_PORT ?? '7891',
    },
  });

  return { apps };
}

/**
 * Render the ecosystem config and write it to
 * `<configDir>/ecosystem.config.json`, returning the file path. The caller
 * must have already loaded bots and enforced unique process names.
 */
export function writeEcosystemConfig(bots: any[], paths: EcosystemPaths): string {
  const cfg = buildEcosystemConfig(bots, paths);
  const tmpFile = join(paths.configDir, 'ecosystem.config.json');
  writeFileSync(tmpFile, JSON.stringify(cfg, null, 2));
  return tmpFile;
}

/**
 * Regenerate the full ecosystem from the given bots array (whole-file rewrite,
 * keeping PM2 app index aligned with bots.json order — no incremental splice).
 *
 * NOTE: defined for the upcoming bot-clone flow; not wired into any code path
 * yet. Calling it only writes the config file; it never starts/stops PM2.
 */
export function regenerateEcosystem(bots: any[], paths: EcosystemPaths): string {
  return writeEcosystemConfig(bots, paths);
}

/**
 * Start a single PM2 app from an ecosystem file without touching any other
 * running daemon (`pm2 start <ecosystem> --only <appName>`).
 *
 * NOTE: defined for the upcoming bot-clone flow; not wired into any code path
 * yet. No caller in this change invokes it, so this block triggers zero PM2
 * start/stop.
 */
export function pm2StartOnly(
  appName: string,
  ecosystemPath: string,
  opts: { pkgRoot: string; pm2Home: string; inherit?: boolean },
): void {
  runPm2(['start', ecosystemPath, '--only', appName], opts);
}
