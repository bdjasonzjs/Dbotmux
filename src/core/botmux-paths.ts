/**
 * Canonical botmux runtime paths (config dir, data dir, pm2 home, ecosystem),
 * mirroring the constants cli.ts derives. Extracted so daemon-side services
 * (e.g. the CEO spawn orchestration) can reach the SAME pm2/ecosystem layout
 * the CLI uses — without duplicating the derivation or guessing.
 *
 * dataDir honours SESSION_DATA_DIR (same as config.ts) so it points at the
 * directory the daemon actually writes bots-info.json / sessions into.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EcosystemPaths } from './pm2-ecosystem.js';

export interface BotmuxPaths {
  configDir: string;
  dataDir: string;
  pm2Home: string;
  pkgRoot: string;
  botsJsonPath: string;
  ecosystem: EcosystemPaths;
}

/** pkgRoot = the package root (parent of dist/). From dist/core/botmux-paths.js,
 *  `../..` resolves to dist/.. = pkgRoot — same value as cli.ts PKG_ROOT. */
function resolvePkgRoot(): string {
  return fileURLToPath(new URL('../..', import.meta.url));
}

export function resolveBotmuxPaths(): BotmuxPaths {
  const configDir = join(homedir(), '.botmux');
  const dataDir = process.env.SESSION_DATA_DIR ?? join(configDir, 'data');
  const logDir = join(configDir, 'logs');
  const heapshotDir = join(configDir, 'heapshots');
  const pm2Home = join(configDir, 'pm2');
  const pkgRoot = resolvePkgRoot();
  const pm2Name = 'botmux';
  const botsJsonPath = process.env.BOTS_CONFIG?.trim()
    ? process.env.BOTS_CONFIG.trim()
    : join(configDir, 'bots.json');
  const ecosystem: EcosystemPaths = { configDir, dataDir, logDir, heapshotDir, pkgRoot, pm2Name };
  return { configDir, dataDir, pm2Home, pkgRoot, botsJsonPath, ecosystem };
}
