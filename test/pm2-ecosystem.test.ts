import { describe, expect, it } from 'vitest';
import { buildEcosystemConfig, type EcosystemPaths } from '../src/core/pm2-ecosystem.js';

const PATHS: EcosystemPaths = {
  configDir: '/cfg',
  dataDir: '/cfg/data',
  logDir: '/cfg/logs',
  heapshotDir: '/cfg/heap',
  pkgRoot: '/pkg',
  pm2Name: 'botmux',
};

// Mirrors the env-fallback logic inside buildEcosystemConfig so the assertion
// is robust to whatever the test runner's environment happens to set.
function expectedAppEnv(index: number) {
  return {
    SESSION_DATA_DIR: '/cfg/data',
    BOTMUX_BOT_INDEX: String(index),
    BOTMUX_MEMORY_DIAG_INTERVAL_MS: process.env.BOTMUX_MEMORY_DIAG_INTERVAL_MS ?? '0',
  };
}

function expectedDaemonApp(index: number, name: string) {
  return {
    script: '/pkg/dist/index-daemon.js',
    cwd: '/cfg',
    autorestart: true,
    max_restarts: 10,
    restart_delay: 3000,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    node_args: ['--max-old-space-size=8192', '--diagnostic-dir=/cfg/heap'],
    name,
    error_file: `/cfg/logs/daemon-${index}-error.log`,
    out_file: `/cfg/logs/daemon-${index}-out.log`,
    env: expectedAppEnv(index),
  };
}

const expectedDashboardApp = {
  name: 'botmux-dashboard',
  script: '/pkg/dist/dashboard.js',
  cwd: '/pkg',
  autorestart: true,
  max_restarts: 10,
  restart_delay: 3000,
  error_file: '/cfg/logs/dashboard-error.log',
  out_file: '/cfg/logs/dashboard-out.log',
  merge_logs: true,
  env: {
    // Bug A (topology-empty-after-restart): dashboard must pin SESSION_DATA_DIR
    // to dataDir so it reads the daemon's data dir, not the empty install-dir/data.
    SESSION_DATA_DIR: '/cfg/data',
    BOTMUX_DASHBOARD_HOST: process.env.BOTMUX_DASHBOARD_HOST ?? '0.0.0.0',
    BOTMUX_DASHBOARD_PORT: process.env.BOTMUX_DASHBOARD_PORT ?? '7891',
  },
};

describe('buildEcosystemConfig', () => {
  it('multi-bot: named bot → botmux-<name>, unnamed → botmux-<index>, plus dashboard', () => {
    const bots = [
      { larkAppId: 'app_a', name: 'main' },
      { larkAppId: 'app_b' }, // unnamed → falls back to index
      { larkAppId: 'app_c', name: '克隆2' }, // non-ASCII name kept by botProcessName
    ];
    const cfg = buildEcosystemConfig(bots, PATHS);

    expect(cfg.apps).toHaveLength(4); // 3 daemons + dashboard
    expect(cfg.apps[0]).toEqual(expectedDaemonApp(0, 'botmux-main'));
    expect(cfg.apps[1]).toEqual(expectedDaemonApp(1, 'botmux-1'));
    // botProcessName normalizes the name (non-ASCII letters are preserved by \p{L}).
    expect(cfg.apps[2].name).toBe('botmux-克隆2');
    expect(cfg.apps[2].env.BOTMUX_BOT_INDEX).toBe('2');
    expect(cfg.apps[3]).toEqual(expectedDashboardApp);
  });

  it('single-bot still emits exactly one daemon + dashboard', () => {
    const cfg = buildEcosystemConfig([{ larkAppId: 'solo', name: 'solo' }], PATHS);
    expect(cfg.apps).toHaveLength(2);
    expect(cfg.apps[0]).toEqual(expectedDaemonApp(0, 'botmux-solo'));
    expect(cfg.apps[1]).toEqual(expectedDashboardApp);
  });

  it('empty bots → only the dashboard app', () => {
    const cfg = buildEcosystemConfig([], PATHS);
    expect(cfg.apps).toEqual([expectedDashboardApp]);
  });
});
