import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Guard for the "topology empty after restart" bug (2026-06-16).
 *
 * Root cause: config.session.dataDir used to default to `../data` relative to
 * the compiled module (i.e. <install-dir>/data), which only exists in a dev
 * checkout. The PM2-launched dashboard runs without SESSION_DATA_DIR, so it
 * resolved that stale path and readTopology() returned an empty graph even
 * though ~/.botmux/data had the real 180+ node topology.
 *
 * Fix: default to ~/.botmux/data (the production data dir, matching
 * resolveDataDir()'s documented default). This test pins that default so it
 * can't silently regress back to an install-dir-relative path.
 */
describe('config.session.dataDir default', () => {
  const saved = process.env.SESSION_DATA_DIR;
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => {
    if (saved === undefined) delete process.env.SESSION_DATA_DIR;
    else process.env.SESSION_DATA_DIR = saved;
  });

  it('defaults to ~/.botmux/data when SESSION_DATA_DIR is unset', async () => {
    delete process.env.SESSION_DATA_DIR;
    const { config } = await import('../src/config.ts');
    expect(config.session.dataDir).toBe(join(homedir(), '.botmux', 'data'));
    // must NOT be an install-dir-relative path (the old broken default)
    expect(config.session.dataDir).not.toMatch(/node_modules[/\\]botmux[/\\]data$/);
  });

  it('honors SESSION_DATA_DIR override when set', async () => {
    process.env.SESSION_DATA_DIR = '/tmp/botmux-test-datadir';
    const { config } = await import('../src/config.ts');
    expect(config.session.dataDir).toBe('/tmp/botmux-test-datadir');
  });
});
