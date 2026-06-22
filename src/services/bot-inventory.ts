/**
 * Read-only bot inventory helpers.
 *
 * Lets the clone/orchestration layer answer "how many bots of CLI X are
 * registered?" so it can decide whether a new clone is needed. Strictly
 * read-only — never writes bots.json (clone writes go through
 * setup/bots-store.ts).
 */
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { botProcessName } from '../setup/bot-config-editor.js';
import { readBotsJsonOrEmpty } from '../setup/bots-store.js';
import { pm2Bin, pm2Env } from '../core/pm2-ecosystem.js';

export interface BotInventoryEntry {
  larkAppId: string;
  /** Defaults to 'claude-code' when the bots.json entry omits cliId, matching bot-registry parsing. */
  cliId: string;
  name?: string;
  displayName?: string;
  /** Position in bots.json (== BOTMUX_BOT_INDEX / PM2 app index). */
  index: number;
  /** Set when this bot is a clone (isolated home). Lets callers tell a clone
   *  from the 本体 (which has none). Mirrors the bot-clone marker. */
  claudeConfigDir?: string;
}

export type BotRuntimeStatus = 'online' | 'stopped' | 'unknown';
export type BotInventorySource = 'configured' | 'clone-dir';

export interface AuthoritativeBotInventoryEntry {
  larkAppId: string;
  /** Human display name. For clones this is also the registered clone name when known. */
  name: string;
  cloneName: string;
  cliId: string;
  engine: string;
  source: BotInventorySource;
  isClone: boolean;
  index: number | null;
  botOpenId: string | null;
  pm2Name: string | null;
  pm2Status: BotRuntimeStatus;
  statusNote?: string;
  cloneDir?: string;
}

export interface ListAuthoritativeBotsOptions {
  botsJsonPath?: string;
  configDir?: string;
  dataDir?: string;
  clonesDir?: string;
  pm2Name?: string;
  pkgRoot?: string;
  pm2Home?: string;
  pm2Statuses?: Record<string, BotRuntimeStatus>;
  readPm2Statuses?: () => Record<string, BotRuntimeStatus>;
  pm2StatusAvailable?: boolean;
}

interface Pm2StatusSnapshot {
  ok: boolean;
  statuses: Record<string, BotRuntimeStatus>;
}

/**
 * Default bots.json location, honouring the project-wide config priority used
 * by bot-registry.loadBotConfigs (src/bot-registry.ts): `BOTS_CONFIG` env var
 * first, then `~/.botmux/bots.json`. Keeping the same precedence ensures the
 * inventory counts the *same* registry the daemon actually loaded — otherwise
 * a BOTS_CONFIG deployment / test would have countBotsByCli() read a different
 * file than the running bots.
 */
export function defaultBotsJsonPath(): string {
  const fromEnv = process.env.BOTS_CONFIG;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv);
  return resolve(homedir(), '.botmux', 'bots.json');
}

/** All registered bots as lightweight inventory entries, in bots.json order. */
export function listBots(botsJsonPath: string = defaultBotsJsonPath()): BotInventoryEntry[] {
  const bots = readBotsJsonOrEmpty(botsJsonPath);
  if (!Array.isArray(bots)) return [];
  return bots.map((b: any, index: number): BotInventoryEntry => ({
    larkAppId: typeof b?.larkAppId === 'string' ? b.larkAppId : '',
    cliId: typeof b?.cliId === 'string' && b.cliId.trim() ? b.cliId : 'claude-code',
    name: typeof b?.name === 'string' && b.name.trim() ? b.name : undefined,
    displayName: typeof b?.displayName === 'string' && b.displayName.trim() ? b.displayName : undefined,
    index,
    claudeConfigDir: typeof b?.claudeConfigDir === 'string' && b.claudeConfigDir.trim() ? b.claudeConfigDir : undefined,
  }));
}

/** Registered bots whose cliId matches (e.g. all `claude-code` bots). */
export function listBotsByCli(cliId: string, botsJsonPath: string = defaultBotsJsonPath()): BotInventoryEntry[] {
  return listBots(botsJsonPath).filter(b => b.cliId === cliId);
}

/** Count of registered bots for a given CLI — used to judge "enough clones?". */
export function countBotsByCli(cliId: string, botsJsonPath: string = defaultBotsJsonPath()): number {
  return listBotsByCli(cliId, botsJsonPath).length;
}

function defaultConfigDir(): string {
  return resolve(homedir(), '.botmux');
}

function defaultDataDir(configDir: string): string {
  return process.env.SESSION_DATA_DIR?.trim() || join(configDir, 'data');
}

function cliIdToEngine(cliId: string): string {
  if (cliId === 'claude-code') return 'claude';
  if (cliId === 'codex') return 'codex';
  if (cliId === 'coco') return 'coco';
  return cliId;
}

function readJsonArray(path: string): any[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readCeoSpawnCloneHints(dataDir: string): Map<string, { cloneName?: string; cliId?: string }> {
  const hints = new Map<string, { cloneName?: string; cliId?: string }>();
  const path = join(dataDir, 'ceo-spawn-state.json');
  if (!existsSync(path)) return hints;
  let items: any[] = [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    items = Array.isArray(parsed?.states) ? parsed.states : Array.isArray(parsed) ? parsed : [];
  } catch {
    return hints;
  }
  for (const state of items) {
    for (const seat of Array.isArray(state?.pendingClones) ? state.pendingClones : []) {
      if (typeof seat?.appId !== 'string' || !seat.appId) continue;
      hints.set(seat.appId, {
        cloneName: typeof seat.displayName === 'string' && seat.displayName.trim()
          ? seat.displayName
          : typeof seat.cloneName === 'string' && seat.cloneName.trim() ? seat.cloneName : undefined,
        cliId: typeof seat.cliId === 'string' && seat.cliId.trim() ? seat.cliId : undefined,
      });
    }
  }
  return hints;
}

function inferCliIdFromCloneDir(cloneDir: string): string | undefined {
  if (existsSync(join(cloneDir, '.codex'))) return 'codex';
  if (existsSync(join(cloneDir, '.claude'))) return 'claude-code';
  if (existsSync(join(cloneDir, '.coco'))) return 'coco';
  return undefined;
}

function listCloneAppIds(clonesDir: string): string[] {
  try {
    return readdirSync(clonesDir, { withFileTypes: true })
      .filter(ent => ent.isDirectory())
      .map(ent => ent.name)
      .sort();
  } catch {
    return [];
  }
}

export function readPm2BotStatusSnapshot(opts: {
  pkgRoot?: string;
  pm2Home?: string;
} = {}): Pm2StatusSnapshot {
  const configDir = defaultConfigDir();
  const pkgRoot = opts.pkgRoot ?? resolve(process.cwd());
  const pm2Home = opts.pm2Home ?? join(configDir, 'pm2');
  let raw: string;
  try {
    raw = execSync(`${pm2Bin(pkgRoot)} jlist`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: pm2Env(pm2Home),
    }).toString();
  } catch {
    return { ok: false, statuses: {} };
  }
  try {
    const list = JSON.parse(raw) as Array<{ name?: string; pm2_env?: { status?: string } }>;
    const out: Record<string, BotRuntimeStatus> = {};
    for (const proc of Array.isArray(list) ? list : []) {
      if (!proc.name || !proc.name.startsWith('botmux-') || proc.name === 'botmux-dashboard') continue;
      const status = proc.pm2_env?.status;
      out[proc.name] = status === 'online' ? 'online' : status ? 'stopped' : 'unknown';
    }
    return { ok: true, statuses: out };
  } catch {
    return { ok: false, statuses: {} };
  }
}

export function readPm2BotStatuses(opts: {
  pkgRoot?: string;
  pm2Home?: string;
} = {}): Record<string, BotRuntimeStatus> {
  return readPm2BotStatusSnapshot(opts).statuses;
}

export function listAuthoritativeBots(opts: ListAuthoritativeBotsOptions = {}): AuthoritativeBotInventoryEntry[] {
  const configDir = opts.configDir ?? defaultConfigDir();
  const dataDir = opts.dataDir ?? defaultDataDir(configDir);
  const clonesDir = opts.clonesDir ?? join(configDir, 'clones');
  const pm2Name = opts.pm2Name ?? 'botmux';
  const botsJsonPath = opts.botsJsonPath ?? defaultBotsJsonPath();
  const bots = readBotsJsonOrEmpty(botsJsonPath);
  const configured = listBots(botsJsonPath);
  const infos = new Map(readJsonArray(join(dataDir, 'bots-info.json'))
    .filter((b: any) => typeof b?.larkAppId === 'string' && b.larkAppId)
    .map((b: any) => [b.larkAppId, b]));
  const spawnHints = readCeoSpawnCloneHints(dataDir);
  const pm2Snapshot = opts.pm2Statuses
    ? { ok: opts.pm2StatusAvailable ?? true, statuses: opts.pm2Statuses }
    : opts.readPm2Statuses
      ? { ok: opts.pm2StatusAvailable ?? true, statuses: opts.readPm2Statuses() }
      : readPm2BotStatusSnapshot({ pkgRoot: opts.pkgRoot, pm2Home: opts.pm2Home });
  const pm2Statuses = pm2Snapshot.statuses;

  const entries = new Map<string, AuthoritativeBotInventoryEntry>();
  for (const bot of configured) {
    if (!bot.larkAppId) continue;
    const info = infos.get(bot.larkAppId) as any;
    const hint = spawnHints.get(bot.larkAppId);
    const raw = bots[bot.index] ?? {};
    const isClone = !!bot.claudeConfigDir;
    const cloneName = bot.displayName
      ?? (typeof info?.botName === 'string' && info.botName.trim() ? info.botName : undefined)
      ?? hint?.cloneName
      ?? bot.name
      ?? bot.larkAppId;
    const pm2ProcessName = botProcessName(raw, bot.index, pm2Name);
    entries.set(bot.larkAppId, {
      larkAppId: bot.larkAppId,
      name: cloneName,
      cloneName,
      cliId: bot.cliId,
      engine: cliIdToEngine(bot.cliId),
      source: 'configured',
      isClone,
      index: bot.index,
      botOpenId: typeof info?.botOpenId === 'string' && info.botOpenId ? info.botOpenId : null,
      pm2Name: pm2ProcessName,
      pm2Status: pm2Snapshot.ok ? pm2Statuses[pm2ProcessName] ?? 'stopped' : 'unknown',
      statusNote: pm2Snapshot.ok ? undefined : 'pm2_status_unavailable',
      cloneDir: bot.claudeConfigDir ? resolve(bot.claudeConfigDir, '..') : undefined,
    });
  }

  for (const appId of listCloneAppIds(clonesDir)) {
    if (entries.has(appId)) continue;
    const cloneDir = join(clonesDir, appId);
    const info = infos.get(appId) as any;
    const hint = spawnHints.get(appId);
    const cliId = hint?.cliId
      ?? (typeof info?.cliId === 'string' && info.cliId.trim() ? info.cliId : undefined)
      ?? inferCliIdFromCloneDir(cloneDir)
      ?? 'claude-code';
    const cloneName = hint?.cloneName
      ?? (typeof info?.botName === 'string' && info.botName.trim() ? info.botName : undefined)
      ?? appId;
    entries.set(appId, {
      larkAppId: appId,
      name: cloneName,
      cloneName,
      cliId,
      engine: cliIdToEngine(cliId),
      source: 'clone-dir',
      isClone: true,
      index: null,
      botOpenId: typeof info?.botOpenId === 'string' && info.botOpenId ? info.botOpenId : null,
      pm2Name: null,
      pm2Status: 'unknown',
      statusNote: 'clone_not_registered_in_bots_json',
      cloneDir,
    });
  }

  return [...entries.values()].sort((a, b) => {
    if (a.index !== null && b.index !== null) return a.index - b.index;
    if (a.index !== null) return -1;
    if (b.index !== null) return 1;
    return a.larkAppId.localeCompare(b.larkAppId);
  });
}
